import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { emptySettings, validateSettings, assertSettingsChange } from '../core/settings.mjs';
import { assertLocalFilesystem, assertPrivateAccess, establishWindowsPrivacy } from './platform.mjs';
import {
  assertAbsolute, assertChain, assertDirectory, assertPrivatePlacement, assertRegularFile,
  createPrivateDirectory, inspectAncestors, lstatOrNull, pinDirectory,
} from './paths.mjs';
import { readJSON, writeJSON, reclaimAtomicStages } from './files.mjs';
import { assertGatePlacement, initializeGate, inspectExistingGate, probeGate, withShortGate } from './gates.mjs';

const LAYOUT = 'store/layout.json';
const SETTINGS = 'config/settings.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const projectKey = id => createHash('sha256').update(id).digest('hex');
export const gateOptions = Object.freeze({ guardPath: (file, { stat }) => assertPrivateAccess(file, stat), initializePath: establishWindowsPrivacy });
const sameGate = (left, right) => ['path', 'id', 'device', 'inode'].every(key => left[key] === right[key]);

function object(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function checkGate(value, expectedPath, id) {
  if (!object(value, ['path', 'id', 'device', 'inode']) || value.path !== expectedPath || value.id !== id ||
      typeof value.device !== 'string' || !/^\d+$/.test(value.device) ||
      typeof value.inode !== 'string' || !/^[1-9]\d*$/.test(value.inode)) {
    fail('STORE_LAYOUT_INVALID', 'A private gate descriptor does not match this store.');
  }
}

function validateLayout(root, value) {
  if (!object(value, ['schemaVersion', 'id', 'settingsGate', 'writerGate', 'syncGate', 'projects']) ||
      value.schemaVersion !== 1 || !UUID.test(value.id) || !value.projects ||
      typeof value.projects !== 'object' || Array.isArray(value.projects)) {
    fail('STORE_LAYOUT_INVALID', 'The private layout is invalid or uses an unsupported schema.');
  }
  checkGate(value.settingsGate, path.join(root, 'store/locks/settings.sqlite'), 'settings');
  checkGate(value.writerGate, path.join(root, 'store/locks/writer.sqlite'), 'writer');
  checkGate(value.syncGate, path.join(root, 'store/locks/sync.sqlite'), 'sync');
  for (const [id, gates] of Object.entries(value.projects)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || !object(gates, ['stateGate', 'workerGate'])) {
      fail('STORE_LAYOUT_INVALID', 'The private project layout is invalid.');
    }
    const key = projectKey(id);
    checkGate(gates.stateGate, path.join(root, `store/locks/${key}.state.sqlite`), `project:${key}`);
    checkGate(gates.workerGate, path.join(root, `store/locks/${key}.worker.sqlite`), `worker:${key}`);
  }
  return value;
}

export async function checkStorePlacement(root, settings) {
  settings = validateSettings(settings);
  assertGatePlacement(root);
  assertPrivatePlacement(root, { projectRoots: settings.projects.map(project => project.root),
    noteDestinations: settings.projects.map(project => project.destination) });
  const chain = await inspectAncestors(root, { allowMissing: true });
  for (const directory of chain) {
    if (await lstatOrNull(path.join(directory.path, '.git'))) {
      fail('PRIVATE_LOCATION_REPOSITORY', 'Private storage must be outside source repositories.');
    }
  }
  for (const project of settings.projects) {
    const projectChain = await inspectAncestors(project.root);
    if (process.platform === 'darwin' && await fs.realpath(project.root) !== project.root)
      fail('PROJECT_ROOT_NONCANONICAL', 'Use the project root with its exact filesystem spelling.');
    await assertChain(projectChain);
    if (project.destination.kind === 'directory') {
      await inspectAncestors(project.destination.path, { allowMissing: true });
    } else {
      await inspectAncestors(path.dirname(project.destination.path), { allowMissing: true });
      const leaf = await lstatOrNull(project.destination.path);
      if (leaf) assertRegularFile(project.destination.path, leaf);
    }
  }
  await assertChain(chain);
}

function prepareGate(file, id) {
  try { return initializeGate(file, id, gateOptions); }
  catch (error) {
    if (error.code !== 'GATE_EXISTS') throw error;
    // Only explicit setup may adopt a valid initialized gate after interruption.
    // Normal reads/mutations always require the persisted descriptor.
    return inspectExistingGate(file, id, gateOptions);
  }
}

/** No-create open. Missing root means unconfigured; partial setup is an error. */
export async function openStore(root) {
  assertAbsolute(root);
  if (!await lstatOrNull(root)) return null;
  const pin = await pinDirectory(root, { private: true });
  assertLocalFilesystem(await fs.statfs(root), root);
  const layout = await readJSON(pin, LAYOUT);
  validateLayout(root, layout.value);
  return Object.freeze({ root, pin, settingsGate: Object.freeze(layout.value.settingsGate), writerGate: Object.freeze(layout.value.writerGate), syncGate: Object.freeze(layout.value.syncGate) });
}

export async function readSettings(store) {
  if (!store) return { value: emptySettings(), hash: null };
  const snapshot = await readJSON(store.pin, SETTINGS);
  return { value: validateSettings(snapshot.value), hash: snapshot.hash };
}

async function readLayout(store) {
  const snapshot = await readJSON(store.pin, LAYOUT);
  return { ...snapshot, value: validateLayout(store.root, snapshot.value) };
}

const incompleteStore = () => fail('STORE_INCOMPLETE', 'The existing private store is incomplete; preserve its metadata and retained work.');

/** Only an empty first-setup scaffold may finish publishing its initial metadata. */
async function assertInitializationEmpty(pin, layout, previous) {
  await assertDirectory(pin);
  if (layout && Object.keys(layout.projects).length) incompleteStore();
  const observations = previous?.observations ?? [], parents = [];
  if (previous) {
    for (const parent of previous.parents) {
      await assertDirectory(parent.pin);
      // Our layout publication changes only the store parent's entry set. Keep
      // all child observations and parent identities; enumerate them again.
      parents.push(parent.pin.root === path.join(pin.root, 'store') ? { ...parent, stat: await lstatOrNull(parent.pin.root) } : parent);
    }
  } else for (const relative of ['config', 'store']) {
    const directory = path.join(pin.root, relative), stat = await lstatOrNull(directory);
    if (stat) parents.push({ pin: await pinDirectory(directory, { private: true }), stat });
  }
  if (!previous) for (const relative of ['store/projects', 'store/chats']) {
    const directory = path.join(pin.root, relative), stat = await lstatOrNull(directory);
    if (!stat && layout) incompleteStore();
    observations.push({ directory, stat, pin: stat ? await pinDirectory(directory, { private: true }) : null });
  }
  if (!previous) for (const relative of ['config/setup.json', 'store/invocations']) {
    const directory = path.join(pin.root, relative);
    if (await lstatOrNull(directory)) incompleteStore();
    observations.push({ directory, stat: null, pin: null });
  }
  const verify = async () => {
    await assertDirectory(pin);
    for (const parent of parents) {
      const current = await lstatOrNull(parent.pin.root);
      // Parent mtime detects renamed child entries without relying on Windows
      // ctime semantics. No parent entries are changed during this read phase.
      if (!current || !['dev', 'ino', 'mtimeNs', 'ctimeNs'].every(key => current[key] === parent.stat[key])) incompleteStore();
      await assertDirectory(parent.pin);
    }
    for (const observed of observations) {
      const current = await lstatOrNull(observed.directory);
      // Timestamps also expose a swapped-and-restored directory whose path has
      // regained the original inode after an empty replacement was enumerated.
      if (observed.stat ? !current || !['dev', 'ino', 'mtimeNs', 'ctimeNs'].every(key => current[key] === observed.stat[key]) : current) incompleteStore();
      if (observed.pin) await assertDirectory(observed.pin);
    }
  };
  for (const observed of observations.filter(item => item.stat)) {
    await verify();
    const stream = await fs.opendir(observed.directory);
    try { await verify(); if (await stream.read()) incompleteStore(); await verify(); }
    finally { await stream.close(); }
  }
  await verify();
  return { verify, observations, parents };
}

/** Explicit fresh setup only. No notes, hooks, plugins, or model are touched. */
export async function initializeStore(root, initial = emptySettings()) {
  const settings = validateSettings(initial);
  await checkStorePlacement(root, settings); // Validate before any filesystem writes.
  const pin = await createPrivateDirectory(root);
  // Inspect existing parents before probing metadata paths. An existing layout
  // owns its gate identities, including when another required file is missing.
  for (const relative of ['config', 'store']) {
    const directory = path.join(root, relative);
    if (await lstatOrNull(directory)) await pinDirectory(directory, { private: true });
  }
  await assertChain(pin.chain);
  const existingLayout = await lstatOrNull(path.join(root, LAYOUT));
  if (!existingLayout && await lstatOrNull(path.join(root, SETTINGS))) incompleteStore();
  let store;
  if (existingLayout) {
    const layout = validateLayout(root, (await readJSON(pin, LAYOUT)).value);
    store = Object.freeze({ root, pin, settingsGate: Object.freeze(layout.settingsGate), writerGate: Object.freeze(layout.writerGate), syncGate: Object.freeze(layout.syncGate) });
  } else {
    await assertInitializationEmpty(pin);
    for (const relative of ['config', 'store', 'store/locks', 'store/projects', 'store/chats']) await createPrivateDirectory(path.join(root, relative));
    const settingsGate = prepareGate(path.join(root, 'store/locks/settings.sqlite'), 'settings');
    const writerGate = prepareGate(path.join(root, 'store/locks/writer.sqlite'), 'writer');
    const syncGate = prepareGate(path.join(root, 'store/locks/sync.sqlite'), 'sync');
    store = Object.freeze({ root, pin, settingsGate, writerGate, syncGate });
  }
  await withShortGate(store.settingsGate, gateOptions, async () => {
    const existing = await readJSON(pin, LAYOUT, { missing: true });
    const current = await readJSON(pin, SETTINGS, { missing: true });
    let initialization;
    if (existing) {
      validateLayout(root, existing.value);
      if (!sameGate(existing.value.settingsGate, store.settingsGate) || !sameGate(existing.value.writerGate, store.writerGate) || !sameGate(existing.value.syncGate, store.syncGate)) {
        fail('STORE_LAYOUT_CHANGED', 'Existing setup records different gate identities.');
      }
      // Published gates are verified without creating replacements, including
      // when a sync owner is live or setup is only resuming its first write.
      probeGate(store.writerGate, gateOptions); probeGate(store.syncGate, gateOptions);
    } else {
      if (existingLayout || current) incompleteStore();
      initialization = await assertInitializationEmpty(pin);
      await initialization.verify();
      await writeJSON(pin, LAYOUT, { schemaVersion: 1, id: randomUUID(), settingsGate: store.settingsGate, writerGate: store.writerGate, syncGate: store.syncGate, projects: {} }, { expectedHash: null });
    }
    if (!current) {
      initialization = await assertInitializationEmpty(pin, existing?.value, initialization);
      await initialization.verify();
      await writeJSON(pin, SETTINGS, emptySettings(), { expectedHash: null });
    }
    else validateSettings(current.value);
  });
  const current = await readSettings(store);
  // Repeating initialization is not authorization to replace prior settings.
  if (current.value.projects.length && JSON.stringify(current.value) !== JSON.stringify(settings)) {
    fail('SETUP_ALREADY_CONFIGURED', 'Use a hash-checked settings update to change an existing setup.');
  }
  if (JSON.stringify(current.value) !== JSON.stringify(settings)) {
    await updateSettings(store, settings, { expectedHash: current.hash });
  }
  return store;
}

async function hasDirectoryEntries(directory) {
  if (!await lstatOrNull(directory)) return false;
  await inspectAncestors(directory);
  const stream = await fs.opendir(directory);
  try { return Boolean(await stream.read()); } finally { await stream.close(); }
}

async function retainedFacts(store, settings, proposed) {
  const retainedProjectIds = [], pendingRuns = [];
  for (const project of settings.projects) {
    const directory = path.join(store.root, 'store/projects', projectKey(project.id));
    if (proposed && !proposed.projects.some(next => next.id === project.id)) {
      const layout = await readLayout(store);
      if (!Object.hasOwn(layout.value.projects, project.id)) fail('STORE_LAYOUT_INVALID', 'The retained project has no mutation gate.');
      await withShortGate(layout.value.projects[project.id].stateGate, gateOptions, () => reclaimAtomicStages(store.pin, `store/projects/${projectKey(project.id)}/chats`, { matchesTarget: name => /^[a-f0-9]{64}\.json$/.test(name), maxBytes: 64 * 1024 }));
    }
    const run = await lstatOrNull(path.join(directory, 'run.json'));
    if (run) {
      assertRegularFile(path.join(directory, 'run.json'), run, { private: true });
      pendingRuns.push(project.id);
    }
    if (run || await hasDirectoryEntries(path.join(directory, 'chats'))) retainedProjectIds.push(project.id);
  }
  return { retainedProjectIds, pendingRuns };
}

/** Every project mutation enters settings then project; model/source reads do neither. */
export async function withProject(store, id, fn) {
  return withSelectedProject(store, () => id, fn);
}

/** Resolve first ownership while holding settings, then enter the chosen project.
 * select may inspect bounded metadata, never source transcripts or model output.
 * Returning null reports unconfigured without creating any state.
 */
export async function withSelectedProject(store, select, fn) {
  if (!store) return null;
  return withShortGate(store.settingsGate, gateOptions, async () => {
    const settings = await readSettings(store);
    const id = await select(settings.value);
    if (id === null) return null;
    const project = settings.value.projects.find(entry => entry.id === id);
    if (!project) fail('PROJECT_UNCONFIGURED', 'The project is not configured.');
    const layout = await readLayout(store);
    const gates = Object.hasOwn(layout.value.projects, id) ? layout.value.projects[id] : null;
    if (!gates) fail('STORE_LAYOUT_INVALID', 'The configured project has no registered ownership gates.');
    return withShortGate(gates.stateGate, gateOptions, async () => fn(Object.freeze({
      project, settingsHash: settings.hash, gates,
      directory: `store/projects/${projectKey(id)}`,
    })));
  });
}

/** Setup/update only: whole-document validation and exact inspected settings hash. */
export async function updateSettings(store, proposed, { expectedHash, beforePublish } = {}) {
  let next = validateSettings(proposed);
  if (beforePublish !== undefined && typeof beforePublish !== 'function') fail('SETTINGS_INVALID', 'The internal publication callback must be a function.');
  await checkStorePlacement(store.root, next);
  return withShortGate(store.settingsGate, gateOptions, async () => {
    const current = await readSettings(store);
    if (current.hash !== expectedHash) fail('SETTINGS_CONFLICT', 'Settings changed after inspection.');
    assertSettingsChange(current.value, next, await retainedFacts(store, current.value, next));
    const layout = await readLayout(store);
    let changed = false;
    for (const project of next.projects) {
      if (Object.hasOwn(layout.value.projects, project.id)) continue;
      const key = projectKey(project.id);
      for (const relative of [`store/projects/${key}`, `store/projects/${key}/chats`, `store/projects/${key}/drafts`]) {
        await createPrivateDirectory(path.join(store.root, relative));
      }
      const stateGate = prepareGate(path.join(store.root, `store/locks/${key}.state.sqlite`), `project:${key}`);
      const workerGate = prepareGate(path.join(store.root, `store/locks/${key}.worker.sqlite`), `worker:${key}`);
      Object.defineProperty(layout.value.projects, project.id, { value: { stateGate, workerGate }, enumerable: true, configurable: true, writable: true });
      changed = true;
    }
    if (changed) await writeJSON(store.pin, LAYOUT, layout.value, { expectedHash: layout.hash });
    // Trusted setup only: establish public prerequisites after the original CAS
    // and retained-work checks, before enabling their policy. No nested settings
    // acquisition is permitted inside the callback.
    if (beforePublish) {
      const adjusted = await beforePublish(Object.freeze({ current: current.value, next, hash: current.hash }));
      if (adjusted !== undefined) next = validateSettings(adjusted);
      await checkStorePlacement(store.root, next);
      assertSettingsChange(current.value, next, await retainedFacts(store, current.value, next));
      if (next.projects.some(project => !Object.hasOwn(layout.value.projects, project.id))) fail('SETTINGS_INVALID', 'Setup cannot add an unprepared project inside publication.');
    }
    return writeJSON(store.pin, SETTINGS, next, { expectedHash: current.hash });
  });
}

/** Short shared destination coordination also serializes overlapping folder/file routes. */
export async function withWriter(store, fn) {
  // Callers may already hold settings/project gates: never wait here while
  // another owned writer needs a short CAS under those gates.
  return withShortGate(store.writerGate, { ...gateOptions, timeoutMs: 0 }, fn);
}
