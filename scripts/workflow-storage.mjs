import { checkWorkflowBudget } from './workflow-budget.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectionGrantHash } from './collection-grant.mjs';
import { randomUUID } from 'node:crypto';
import { lstatOrNull, sameFileIdentity, syncDirectory } from './file-io.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { validateWorkflowPlacement, canonicalWorkflowPath, inside } from './workflow-paths.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { privacyIdentity, verifyPrivateEntries, protectNewDirectory, rejectKnownSync } from './storage-platform.mjs';
import { fail, canonicalJSON, hash, digest, list, keys } from './workflow-values.mjs';

const capabilities = new WeakMap();
const rootsOf = collection => [collection.rawDir, collection.intakeStateDir, collection.notes.writerStateDir];

async function checkedSelection(configPath, expectedConfigHash, collectionId) {
  hash(expectedConfigHash);
  const snapshot = await checkedSnapshot(configPath, expectedConfigHash);
  const placement = await validateWorkflowPlacement(snapshot.config, { configPath });
  const collection = placement.collections.find(item => item.id === collectionId);
  if (!collection) fail('WORKFLOW_COLLECTION_MISSING');
  return { ...snapshot, collection, placement };
}

async function checkedSnapshot(configPath, expectedConfigHash) {
  const snapshot = await readWorkflowSnapshot(configPath);
  if (snapshot.hash !== expectedConfigHash) fail('WORKFLOW_POLICY_CHANGED');
  return snapshot;
}
async function checkCurrentPlacement(value) {
  const selected = await checkedSelection(value.configPath, value.expectedConfigHash, value.collectionId);
  if (canonicalJSON(selected.collection) !== canonicalJSON(value.collection)) fail('PRIVATE_STORAGE_CHANGED');
  return selected;
}

/** Bounded metadata walk, never follows links or reads evidence. */
export async function privateStorageEntries(roots, { limit = 20000, paths = null } = {}) {
  const entries = [], seen = new Set();
  async function visit(file, root, descend = paths === null) {
    if (seen.has(file)) return;
    if (entries.length >= limit) fail('PRIVACY_INSPECTION_CAPACITY');
    rejectKnownSync(file);
    const stat = await fs.lstat(file, { bigint: true });
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile()) ||
        (stat.isFile() && ![1n, 2n].includes(stat.nlink)) || await fs.realpath(file) !== file) fail('UNSAFE_PRIVATE_STORAGE');
    entries.push({ path: file, stat, root }); seen.add(file);
    if (stat.isDirectory() && descend) {
      const stream = await fs.opendir(file);
      for await (const child of stream) await visit(path.join(file, child.name), false);
    }
  }
  for (const root of roots) await visit(root, true);
  for (const file of paths ?? []) {
    const root = roots.find(root => inside(root, file));
    if (!root || path.resolve(file) !== file) fail('UNSAFE_PRIVATE_STORAGE');
    let current = root;
    for (const component of path.relative(root, file).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if (!await lstatOrNull(current)) break;
      await visit(current, false, false);
    }
  }
  // Scoped inspection discovers at most the one same-directory transient alias,
  // not an archive. Both names and both private paths still require validation.
  if (paths !== null) for (const entry of [...entries].filter(item => item.stat.isFile() && item.stat.nlink === 2n)) {
    let count = 0;
    const directory = await fs.opendir(path.dirname(entry.path));
    for await (const child of directory) {
      if (++count > 1000) fail('PRIVACY_INSPECTION_CAPACITY');
      const candidate = path.join(path.dirname(entry.path), child.name);
      if (sameFileIdentity(await fs.lstat(candidate, { bigint: true }), entry.stat)) await visit(candidate, false, false);
    }
  }
  const aliasesByIdentity = new Map();
  for (const entry of entries.filter(item => item.stat.isFile() && item.stat.nlink === 2n)) {
    const key = `${entry.stat.dev}/${entry.stat.ino}/${entry.stat.birthtimeNs}`;
    aliasesByIdentity.set(key, [...(aliasesByIdentity.get(key) ?? []), entry]);
  }
  for (const aliases of aliasesByIdentity.values()) {
    // Publication's temporary hard link is private only when BOTH aliases are
    // accounted for under raw storage. An external alias always fails closed.
    if (aliases.length !== 2 || aliases.some(item => !inside(roots[0], item.path)) ||
        path.dirname(aliases[0].path) !== path.dirname(aliases[1].path) ||
        !aliases.some(item => /^[a-f0-9]{20}\.json$/.test(path.basename(item.path))) ||
        !aliases.some(item => /^\.stage-[a-f0-9]{20}-[a-f0-9-]{36}\.tmp$/.test(path.basename(item.path)))) fail('UNSAFE_PRIVATE_STORAGE');
  }
  return entries;
}

async function verifyRoots(roots, identity, options = { paths: [] }) {
  const originals = new Map();
  for (let attempt = 0; attempt < 3; attempt++) {
    checkWorkflowBudget();
    const entries = await privateStorageEntries(roots, options);
    for (const entry of entries) {
      const original = originals.get(entry.path) ?? entry.stat;
      if (!sameFileIdentity(original, entry.stat) || original.mode !== entry.stat.mode ||
          original.uid !== entry.stat.uid || original.gid !== entry.stat.gid) fail('PRIVATE_STORAGE_CHANGED');
      originals.set(entry.path, original);
    }
    let probeChanged = false;
    try { await verifyPrivateEntries(entries, identity, { fresh: attempt > 0 }); }
    catch (error) { if (error.code !== 'PRIVATE_STORAGE_CHANGED') throw error; probeChanged = true; }
    let changedDirectory = false;
    for (const entry of entries) {
      const after = await fs.lstat(entry.path, { bigint: true });
      if (!sameFileIdentity(after, entry.stat) || after.isDirectory() !== entry.stat.isDirectory() ||
          after.isSymbolicLink() || after.mode !== entry.stat.mode || after.uid !== entry.stat.uid ||
          after.gid !== entry.stat.gid || await fs.realpath(entry.path) !== entry.path) fail('PRIVATE_STORAGE_CHANGED');
      if (['nlink', 'ctimeNs', 'mtimeNs', 'size'].some(key => after[key] !== entry.stat[key])) {
        if (!entry.stat.isDirectory()) fail('PRIVATE_STORAGE_CHANGED');
        changedDirectory = true;
      }
    }
    if (!changedDirectory) {
      if (probeChanged) fail('PRIVATE_STORAGE_CHANGED');
      return entries.filter(item => item.root);
    }
    // Child creation changes directory ctime/link count without changing ACLs.
    // A retry must inspect fresh permissions; never waive version checks.
  }
  fail('PRIVATE_STORAGE_CHANGED');
}

/** Additional configured writer roots are checked for explicit maintenance only. */
export async function verifyPrivateDirectories(roots, options = { paths: [] }) {
  return verifyRoots(roots, await privacyIdentity(), options);
}

/** Explicit setup only; never called by a hook. Existing permissions are not repaired. */
export async function prepareWorkflowStorage({ configPath, expectedConfigHash, collectionId }) {
  const selected = await checkedSelection(configPath, expectedConfigHash, collectionId);
  const identity = await privacyIdentity();
  async function create(file) {
    rejectKnownSync(file);
    const old = await lstatOrNull(file);
    if (old) {
      if (!old.isDirectory() || old.isSymbolicLink() || await fs.realpath(file) !== file) fail('UNSAFE_PRIVATE_STORAGE');
      return;
    }
    await create(path.dirname(file));
    await checkedSelection(configPath, expectedConfigHash, collectionId);
    await fs.mkdir(file, { mode: 0o700 }); // EEXIST is a conflict, never adopt.
    const original = await fs.lstat(file, { bigint: true });
    await protectNewDirectory(file, identity);
    const current = await fs.lstat(file, { bigint: true });
    if (!sameFileIdentity(original, current)) fail('PRIVATE_STORAGE_CHANGED');
    await verifyPrivateEntries([{ path: file, stat: current, root: true }], identity);
    await syncDirectory(path.dirname(file));
  }
  for (const root of rootsOf(selected.collection)) await create(root);
  for (const root of [selected.collection.intakeStateDir, selected.collection.notes.writerStateDir]) await create(path.join(root, 'metadata-stages'));
  // Hooks publish beneath stable nested parents to minimize intake-root churn.
  // Worker/writer child changes still require a fresh bounded privacy retry.
  for (const name of ['stages', 'status', 'scheduler', 'registrations/codex', 'registrations/claude',
    'wake/codex', 'wake/claude', 'wake-acks/codex', 'wake-acks/claude', 'drained/codex', 'drained/claude', 'suspended/codex', 'suspended/claude']) {
    await create(path.join(selected.collection.intakeStateDir, 'ingress', ...name.split('/')));
  }
  // Verify inheritance without source text, and remove only the exact empty
  // probe owned by this setup. Existing roots receive no permission mutation.
  for (const root of rootsOf(selected.collection)) {
    await verifyRoots([root], identity, { paths: null });
    const probe = path.join(root, `.privacy-probe-${randomUUID()}`);
    await fs.mkdir(probe, { mode: 0o700 });
    const stat = await fs.lstat(probe, { bigint: true });
    try { await verifyPrivateEntries([{ path: probe, stat, root: false }], identity); }
    finally {
      const now = await fs.lstat(probe, { bigint: true });
      if (!sameFileIdentity(stat, now) || now.isSymbolicLink()) fail('PRIVATE_STORAGE_CHANGED');
      await fs.rmdir(probe); await syncDirectory(root);
    }
  }
  return verifyWorkflowStorage({ configPath, expectedConfigHash, collectionId });
}

/** Opaque, process-local capability; serialization cannot turn it into authority. */
export async function verifyWorkflowStorage({ configPath, expectedConfigHash, collectionId }) {
  checkWorkflowBudget();
  configPath = await canonicalWorkflowPath(configPath, { directory: false, allowMissing: false });
  const selected = await checkedSelection(configPath, expectedConfigHash, collectionId);
  const identity = await privacyIdentity();
  const roots = await verifyRoots(rootsOf(selected.collection), identity);
  await checkedSelection(configPath, expectedConfigHash, collectionId);
  const capability = Object.freeze({ toJSON() { fail('STORAGE_CAPABILITY_NOT_SERIALIZABLE'); } });
  capabilities.set(capability, { configPath, expectedConfigHash, collectionId, identity, roots, collection: selected.collection });
  return capability;
}

/** Recheck before reading selected sources or publishing private material. */
export async function assertWorkflowStorage(capability, selection = null, operation = 'maintenance') {
  checkWorkflowBudget();
  const value = capabilities.get(capability);
  if (!value) fail('STORAGE_CAPABILITY_REQUIRED');
  const selected = await checkedSnapshot(value.configPath, value.expectedConfigHash);
  if (await privacyIdentity() !== value.identity) fail('PRIVATE_STORAGE_CHANGED');
  const roots = await verifyRoots(rootsOf(value.collection), value.identity);
  for (let i = 0; i < roots.length; i++) if (!sameFileIdentity(roots[i].stat, value.roots[i].stat)) fail('PRIVATE_STORAGE_CHANGED');
  if (!['maintenance', 'collect', 'explicitCollect', 'process', 'explicitProcess'].includes(operation)) fail('INVALID_WORKFLOW_OPERATION');
  if (operation !== 'maintenance') {
    if (!selection) fail('WORKFLOW_SELECTION_REQUIRED');
    const resolved = await resolveWorkflowRoute(selected.config, selection);
    if (resolved.collection?.id !== value.collectionId || resolved.intended?.[operation] !== true) fail('WORKFLOW_NOT_AUTHORIZED');
  }
  await checkCurrentPlacement(value);
  return structuredClone(value.collection);
}

/** Policy only: callers must separately verify private paths at this boundary.
 * Resolve the bounded batch against one fresh snapshot, never cached authority.
 * An empty batch verifies the capability's maintenance binding only.
 */
export async function assertWorkflowAuthorizations(capability, requests) {
  checkWorkflowBudget(); list(requests, 21);
  const value = capabilities.get(capability);
  if (!value) fail('STORAGE_CAPABILITY_REQUIRED');
  const selected = await checkedSnapshot(value.configPath, value.expectedConfigHash);
  if (await privacyIdentity() !== value.identity) fail('PRIVATE_STORAGE_CHANGED');
  for (const request of requests) {
    keys(request, ['selection', 'operation', 'automatic']);
    if (!['collect', 'explicitCollect', 'process', 'explicitProcess'].includes(request.operation) || typeof request.automatic !== 'boolean') fail('INVALID_WORKFLOW_OPERATION');
    if (!request.selection) fail('WORKFLOW_SELECTION_REQUIRED');
    const resolved = await resolveWorkflowRoute(selected.config, request.selection);
    if (resolved.collection?.id !== value.collectionId || resolved.intended?.[request.operation] !== true) fail('WORKFLOW_NOT_AUTHORIZED');
    if (request.automatic && (!['process', 'explicitProcess'].includes(request.operation) || resolved.route.processing.mode !== 'automatic')) fail('PROCESSING_APPROVAL_REQUIRED');
  }
  await checkCurrentPlacement(value);
}

/** Check every existing component touched by an operation, without walking history. */
export async function assertPrivatePaths(capability, paths) {
  checkWorkflowBudget();
  const value = capabilities.get(capability);
  if (!value) fail('STORAGE_CAPABILITY_REQUIRED');
  const roots = await verifyRoots(rootsOf(value.collection), value.identity, { paths });
  for (let i = 0; i < roots.length; i++) if (!sameFileIdentity(roots[i].stat, value.roots[i].stat)) fail('PRIVATE_STORAGE_CHANGED');
}

export async function auditWorkflowStorage(capability, { limit = 20000 } = {}) {
  await assertWorkflowStorage(capability);
  const value = capabilities.get(capability);
  try { await verifyRoots(rootsOf(value.collection), value.identity, { paths: null, limit }); return { complete: true }; }
  catch (error) { return { complete: false, reason: error.code ?? 'PRIVACY_INSPECTION_FAILED' }; }
}

export async function workflowMaintenanceContext(capability) {
  const collection = await assertWorkflowStorage(capability);
  const value = capabilities.get(capability);
  const selected = await checkedSelection(value.configPath, value.expectedConfigHash, value.collectionId);
  const placement = selected.placement;
  return { collection, configHash: value.expectedConfigHash,
    writers: [...new Set(placement.collections.map(item => item.notes.writerStateDir))].sort() };
}

/** One verified policy/storage snapshot for constructing a processing operation.
 * The identities are the capability's pinned roots, just revalidated above.
 * The returned data grants no write authority on its own. */
export async function workflowProcessingContext(capability, selection = null, operation = 'maintenance') {
  const collection = await assertWorkflowStorage(capability, selection, operation);
  const value = capabilities.get(capability), identities = {};
  for (const root of value.roots) {
    const stat = root.stat;
    identities[root.path] = digest(canonicalJSON([stat.dev, stat.ino, stat.birthtimeNs].map(String)));
  }
  const binding = { collectionId: collection.id, rawDir: collection.rawDir,
    intakeStateDir: collection.intakeStateDir, notes: collection.notes, identities };
  return { collection, configHash: value.expectedConfigHash, binding, hash: digest(canonicalJSON(binding)) };
}

/** Namespaces shared writer metadata by the exact selected collection and roots. */
export async function workflowProcessingBinding(capability) {
  const { binding, hash } = await workflowProcessingContext(capability);
  return { binding, hash };
}

export async function workflowProcessingPolicy(capability, selection) {
  await assertWorkflowStorage(capability, selection, 'explicitProcess');
  const value = capabilities.get(capability);
  const snapshot = await checkedSelection(value.configPath, value.expectedConfigHash, value.collectionId);
  return (await resolveWorkflowRoute(snapshot.config, selection)).route.processing;
}

export async function workflowCollectionGrant(capability, selection) {
  await assertWorkflowStorage(capability, selection, 'collect');
  const value = capabilities.get(capability);
  const snapshot = await checkedSelection(value.configPath, value.expectedConfigHash, value.collectionId);
  const route = await resolveWorkflowRoute(snapshot.config, selection);
  const grant = await collectionGrantHash(snapshot.config, route.route.id, selection);
  await checkedSelection(value.configPath, value.expectedConfigHash, value.collectionId);
  return grant;
}
