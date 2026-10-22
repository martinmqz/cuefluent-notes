import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { emptySettings, validateSettings, assertSettingsChange } from '../core/settings.mjs';
import { assertLocalFilesystem, assertPrivateAccess, establishWindowsPrivacy } from './platform.mjs';
import {
  assertAbsolute, assertChain, assertPrivatePlacement, assertRegularFile,
  createPrivateDirectory, inspectAncestors, lstatOrNull, pinDirectory,
} from './paths.mjs';
import { readJSON, writeJSON } from './files.mjs';
import { assertGatePlacement, initializeGate, inspectExistingGate, withShortGate } from './gates.mjs';

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
    await inspectAncestors(project.root);
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

/** Explicit fresh setup only. No notes, hooks, plugins, or model are touched. */
export async function initializeStore(root, initial = emptySettings()) {
  const settings = validateSettings(initial);
  await checkStorePlacement(root, settings); // Validate before any filesystem writes.
  const pin = await createPrivateDirectory(root);
  for (const relative of ['config', 'store', 'store/locks', 'store/projects', 'store/chats']) {
    await createPrivateDirectory(path.join(root, relative));
  }
  const settingsGate = prepareGate(path.join(root, 'store/locks/settings.sqlite'), 'settings');
  const writerGate = prepareGate(path.join(root, 'store/locks/writer.sqlite'), 'writer');
  const syncGate = prepareGate(path.join(root, 'store/locks/sync.sqlite'), 'sync');
  const store = Object.freeze({ root, pin, settingsGate, writerGate, syncGate });
  await withShortGate(settingsGate, gateOptions, async () => {
    const existing = await readJSON(pin, LAYOUT, { missing: true });
    if (existing) {
      validateLayout(root, existing.value);
      if (!sameGate(existing.value.settingsGate, settingsGate) || !sameGate(existing.value.writerGate, writerGate) || !sameGate(existing.value.syncGate, syncGate)) {
        fail('STORE_LAYOUT_CHANGED', 'Existing setup records different gate identities.');
      }
    } else {
      await writeJSON(pin, LAYOUT, { schemaVersion: 1, id: randomUUID(), settingsGate, writerGate, syncGate, projects: {} }, { expectedHash: null });
    }
    const current = await readJSON(pin, SETTINGS, { missing: true });
    if (!current) await writeJSON(pin, SETTINGS, emptySettings(), { expectedHash: null });
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

async function retainedFacts(store, settings) {
  const retainedProjectIds = [], pendingRuns = [];
  for (const project of settings.projects) {
    const directory = path.join(store.root, 'store/projects', projectKey(project.id));
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
    const gates = layout.value.projects[id];
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
    assertSettingsChange(current.value, next, await retainedFacts(store, current.value));
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
      assertSettingsChange(current.value, next, await retainedFacts(store, current.value));
      if (next.projects.some(project => !Object.hasOwn(layout.value.projects, project.id))) fail('SETTINGS_INVALID', 'Setup cannot add an unprepared project inside publication.');
    }
    return writeJSON(store.pin, SETTINGS, next, { expectedHash: current.hash });
  });
}

/** Short shared destination coordination also serializes overlapping folder/file routes. */
export async function withWriter(store, fn) {
  return withShortGate(store.writerGate, gateOptions, fn);
}
