import { checkWorkflowBudget } from './workflow-budget.mjs';
import { withIntakeDirectoryLock } from './intake-lock.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectionGrantHash } from './collection-grant.mjs';
import { randomUUID } from 'node:crypto';
import { lstatOrNull, sameFileIdentity, syncDirectory } from './file-io.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { validateWorkflowPlacement, canonicalWorkflowPath, inside } from './workflow-paths.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { privacyIdentity, verifyPrivateEntries, createPrivateDirectory, hidePrivateDirectory, rejectKnownSync, withStorageProbes, forgetStorageProbes } from './storage-platform.mjs';
import { fail, canonicalJSON, hash, digest, list, keys } from './workflow-values.mjs';
import { preflightWindowsStorage } from './windows-setup-guards.mjs';

const capabilities = new WeakMap();
// Exhausted directory churn: every attempt found only directory metadata
// changes (a child created or removed) and no identity, type, mode, owner,
// link, realpath or permission failure, and every root still was the one its
// capability pinned. Every caller still sees PRIVATE_STORAGE_CHANGED; only a
// caller with its own bounded deadline may repeat its whole verification.
// Recorded here, never on the error, so no other error with that code can
// claim it.
const storageChurn = new WeakSet();
export const isPrivateStorageChurn = error => storageChurn.has(error);
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

// Review folders (processing-review-files.mjs) are private copies people open
// in an editor or Finder, which add files of their own. A full walk checks each
// folder and its own files and skips, unfollowed, anything else in it, and
// Finder's metadata file beside the folders. Opening those folders can also
// leave a regular .DS_Store in their intake-root parent; it is never input data.
export const REVIEW_OWN_FILE = /^(?:\d{1,3}-)?(?:proposed|current)\.md$|^summary\.txt$/;
export const FINDER_FILE = '.DS_Store';
const reviewForeign = (reviewRoot, file, entry) => {
  const parent = path.dirname(file), name = path.basename(file);
  if (reviewRoot === null) return false;
  if (parent === path.dirname(reviewRoot)) return name === FINDER_FILE && entry.isFile();
  return parent === reviewRoot ? name === FINDER_FILE : path.dirname(parent) === reviewRoot && !REVIEW_OWN_FILE.test(name);
};
const reviewRootOf = collection => path.join(collection.intakeStateDir, 'review');

/** Bounded metadata walk, never follows links or reads evidence. */
export async function privateStorageEntries(roots, { limit = 20000, paths = null, reviewRoot = null } = {}) {
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
      for await (const child of stream) {
        const entry = path.join(file, child.name);
        if (!reviewForeign(reviewRoot, entry, child)) await visit(entry, false);
      }
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
  // Roots a capability pinned are compared on every attempt, so a replaced root
  // fails at once even while it churns. Only such a check may report churn.
  const pinned = options.pinned ? new Map(options.pinned.map(item => [item.path, item.stat])) : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    checkWorkflowBudget();
    const entries = await privateStorageEntries(roots, options);
    for (const entry of entries) {
      if (pinned && entry.root && !(pinned.has(entry.path) && sameFileIdentity(pinned.get(entry.path), entry.stat))) fail('PRIVATE_STORAGE_CHANGED');
      const original = originals.get(entry.path) ?? entry.stat;
      if (!sameFileIdentity(original, entry.stat) || original.mode !== entry.stat.mode ||
          original.uid !== entry.stat.uid || original.gid !== entry.stat.gid) fail('PRIVATE_STORAGE_CHANGED');
      originals.set(entry.path, original);
    }
    let probeChanged = false, attributes = new Map();
    try { attributes = await verifyPrivateEntries(entries, identity, { fresh: attempt > 0 }); }
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
      return entries.filter(item => item.root).map(item => ({ ...item, attributes: attributes.get(item.path) }));
    }
    // Child creation changes directory ctime/link count without changing ACLs.
    // A retry must inspect fresh permissions; never waive version checks.
  }
  // Without pinned roots nothing proves the churned roots are the expected
  // ones, so the check fails closed as it always did.
  if (!pinned) fail('PRIVATE_STORAGE_CHANGED');
  // A caller's retry re-reads ACLs too, like the attempts above.
  forgetStorageProbes(originals.keys());
  const churn = Object.assign(new Error('PRIVATE_STORAGE_CHANGED'), { code: 'PRIVATE_STORAGE_CHANGED' });
  storageChurn.add(churn);
  throw churn;
}

/** Additional configured writer roots are checked for explicit maintenance only. */
export async function verifyPrivateDirectories(roots, options = { paths: [] }) {
  return verifyRoots(roots, await privacyIdentity(), options);
}

/** Explicit setup only; never called by a hook. Existing permissions are not repaired. */
export function prepareWorkflowStorage(request, options = {}) {
  return withStorageProbes(() => prepareStorage(request, options));
}
async function prepareStorage({ configPath, expectedConfigHash, collectionId }, {
  visibility = hidePrivateDirectory,
  onWarning = code => console.error(`Cuefluent Notes: raw folder remains visible (${code}).`),
  platformFacts,
} = {}) {
  const selected = await checkedSelection(configPath, expectedConfigHash, collectionId);
  const pinnedSelection = async () => {
    const current = await checkedSelection(configPath, expectedConfigHash, collectionId);
    if (canonicalJSON(current.placement) !== canonicalJSON(selected.placement)) fail('PRIVATE_STORAGE_REDIRECTED');
    return current;
  };
  const recheck = await preflightWindowsStorage({ configPath, roots: rootsOf(selected.collection) }, platformFacts);
  const identity = await privacyIdentity();
  const initialRaw = await lstatOrNull(selected.collection.rawDir, { bigint: true });
  let createdRaw, uncertainRaw = false;
  async function create(file, expected, beforeCreate) {
    rejectKnownSync(file);
    const old = await lstatOrNull(file, { bigint: true });
    // Preserve the decision that required (or skipped) the intake preflight.
    // An existing raw root may not disappear, and an absent one may not appear.
    if (expected !== undefined && (expected ? !sameFileIdentity(expected, old) : old)) fail('PRIVATE_STORAGE_CHANGED');
    if (old) {
      if (!old.isDirectory() || old.isSymbolicLink() || await fs.realpath(file) !== file) fail('UNSAFE_PRIVATE_STORAGE');
      return old;
    }
    await create(path.dirname(file));
    await pinnedSelection();
    await beforeCreate?.();
    let original;
    try {
      original = await createPrivateDirectory(file, identity, stat => {
        if (file === selected.collection.rawDir && !initialRaw) createdRaw = stat;
      });
    } catch (error) {
      if (file === selected.collection.rawDir && !initialRaw && error.privateDirectoryMayExist) uncertainRaw = true;
      throw error;
    }
    const current = await fs.lstat(file, { bigint: true });
    if (!sameFileIdentity(original, current)) fail('PRIVATE_STORAGE_CHANGED');
    await verifyPrivateEntries([{ path: file, stat: current, root: true }], identity);
    await syncDirectory(path.dirname(file));
    return current;
  }
  async function finish(preparedRaw) {
    await create(selected.collection.notes.writerStateDir);
    for (const root of [selected.collection.intakeStateDir, selected.collection.notes.writerStateDir]) await create(path.join(root, 'metadata-stages'));
    // Hooks publish beneath stable nested parents to minimize intake-root churn.
    // Worker/writer child changes still require a fresh bounded privacy retry.
    for (const name of ['stages', 'status', 'scheduler', 'registrations/codex', 'registrations/claude',
      'wake/codex', 'wake/claude', 'wake-acks/codex', 'wake-acks/claude', 'drained/codex', 'drained/claude', 'suspended/codex', 'suspended/claude']) {
      await create(path.join(selected.collection.intakeStateDir, 'ingress', ...name.split('/')));
    }
    // Verify inheritance and file-level resolution without source text. Desktop
    // can retain a directory alias while exposing relocation only on a child file.
    // Remove only exact owned probes; existing roots receive no permission edits.
    for (const root of rootsOf(selected.collection)) {
      await verifyRoots([root], identity, { paths: null, reviewRoot: reviewRootOf(selected.collection) });
      const probe = path.join(root, `.privacy-probe-${randomUUID()}`);
      await fs.mkdir(probe, { mode: 0o700 });
      const stat = await fs.lstat(probe, { bigint: true });
      const probeFile = path.join(probe, 'entry'); let fileStat;
      try {
        await verifyPrivateEntries([{ path: probe, stat, root: false }], identity);
        const handle = await fs.open(probeFile, 'wx', 0o600);
        try { fileStat = await handle.stat({ bigint: true }); } finally { await handle.close(); }
        if (await fs.realpath(probeFile) !== probeFile) fail('PRIVATE_STORAGE_REDIRECTED');
        await verifyPrivateEntries([{ path: probeFile, stat: fileStat, root: false }], identity);
      }
      finally {
        const now = await fs.lstat(probe, { bigint: true });
        if (!sameFileIdentity(stat, now) || now.isSymbolicLink()) fail('PRIVATE_STORAGE_CHANGED');
        if (fileStat) {
          const current = await fs.lstat(probeFile, { bigint: true });
          if (!sameFileIdentity(fileStat, current) || !current.isFile() || current.isSymbolicLink() ||
              current.nlink !== 1n || current.size !== 0n || current.ctimeNs !== fileStat.ctimeNs ||
              current.mtimeNs !== fileStat.mtimeNs) fail('PRIVATE_STORAGE_CHANGED');
          await fs.unlink(probeFile);
        }
        await fs.rmdir(probe); await syncDirectory(root);
      }
    }
    await pinnedSelection();
    let capability = await verifyWorkflowStorage({ configPath, expectedConfigHash, collectionId });
    if (!sameFileIdentity(preparedRaw, capabilities.get(capability).roots[0].stat)) fail('PRIVATE_STORAGE_CHANGED');
    if (process.platform === 'win32') {
      const original = capabilities.get(capability);
      await visibility(original.roots[0], identity,
        pinnedSelection);
      // Visibility commands can outlive changes to any root. Recheck privacy and
      // preserve the original identities before returning a fresh capability.
      await pinnedSelection();
      capability = await verifyWorkflowStorage({ configPath, expectedConfigHash, collectionId });
      const current = capabilities.get(capability);
      if (current.identity !== original.identity) fail('PRIVATE_STORAGE_CHANGED');
      for (let i = 0; i < current.roots.length; i++)
        if (!sameFileIdentity(current.roots[i].stat, original.roots[i].stat)) fail('PRIVATE_STORAGE_CHANGED');
      if (!(current.roots[0].attributes & 2)) onWarning('STORAGE_VISIBILITY_FAILED');
    }
    return capability;
  }

  const intake = selected.collection.intakeStateDir;
  await recheck?.();
  const preparedIntake = await create(intake, await lstatOrNull(intake, { bigint: true }));
  const guardIntake = async () => {
    const [current] = await verifyRoots([intake], identity);
    if (!sameFileIdentity(preparedIntake, current.stat)) fail('PRIVATE_STORAGE_CHANGED');
  };
  let preserveLock = false;
  const result = await withIntakeDirectoryLock(intake, guardIntake, async guard => {
    let emptyVersion;
    const unchangedIntake = async () => {
      await guard();
      const current = await fs.lstat(intake, { bigint: true });
      if (!sameFileIdentity(emptyVersion, current) ||
          ['ctimeNs', 'mtimeNs', 'nlink', 'size'].some(key => emptyVersion[key] !== current[key])) fail('PRIVATE_STORAGE_CHANGED');
    };
    if (!initialRaw) {
      // The owned intake lock is the only allowed entry. Keep it through raw
      // creation and setup so collectors cannot publish against half a pair.
      emptyVersion = await fs.lstat(intake, { bigint: true });
      const directory = await fs.opendir(intake, { bufferSize: 1 });
      try {
        await unchangedIntake();
        for (let entry = await directory.read(); entry; entry = await directory.read())
          if (entry.name !== '.intake-lock') fail('PRIVATE_SETUP_CONFLICT');
        await unchangedIntake();
      } finally { await directory.close(); }
    }
    let preparedRaw;
    try {
      preparedRaw = await create(selected.collection.rawDir, initialRaw, emptyVersion ? unchangedIntake : undefined);
      if (emptyVersion) await unchangedIntake();
    } catch (error) {
      if (!initialRaw && !createdRaw) {
        // Creation may have completed without returning an identity, or another
        // object may have raced our exclusive create. Neither permits pairing an
        // unexplained raw root with this intake on the next attempt.
        try { preserveLock = uncertainRaw || !!await lstatOrNull(selected.collection.rawDir); }
        catch { preserveLock = true; }
        if (preserveLock && !error.cleanupWarnings?.length)
          error.cleanupWarnings = ['Raw-root creation could not be verified; preserve it for inspection.'];
      }
      if (createdRaw) {
        // Roll back only our still-private, unchanged, empty new root. Never
        // remove content or a replacement while rejecting a changed intake.
        try {
          const [raw] = await verifyRoots([selected.collection.rawDir], identity);
          if (!sameFileIdentity(createdRaw, raw.stat)) fail('PRIVATE_STORAGE_CHANGED');
          await fs.rmdir(raw.path);
          await syncDirectory(path.dirname(raw.path));
        } catch {
          preserveLock = true;
          error.cleanupWarnings = ['New raw-root cleanup was unsafe; preserve it for inspection.'];
        }
      }
      throw error;
    }
    return { capability: await finish(preparedRaw) };
  }, { preserveOnError: () => preserveLock });
  if (result.cleanupWarnings?.length) fail('INTAKE_BLOCKED');
  return result.capability;
}

/** Opaque, process-local capability; serialization cannot turn it into authority. */
export function verifyWorkflowStorage(request) {
  return withStorageProbes(() => verifyStorage(request));
}
async function verifyStorage({ configPath, expectedConfigHash, collectionId }) {
  checkWorkflowBudget();
  configPath = await canonicalWorkflowPath(configPath, { directory: false, allowMissing: false });
  const selected = await checkedSelection(configPath, expectedConfigHash, collectionId);
  const identity = await privacyIdentity();
  if (process.platform === 'win32') await verifyPrivateEntries([
    { path: configPath, stat: await fs.lstat(configPath, { bigint: true }), root: false },
  ], identity);
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
  const roots = await verifyRoots(rootsOf(value.collection), value.identity, { paths: [], pinned: value.roots });
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
  const roots = await verifyRoots(rootsOf(value.collection), value.identity, { paths, pinned: value.roots });
  for (let i = 0; i < roots.length; i++) if (!sameFileIdentity(roots[i].stat, value.roots[i].stat)) fail('PRIVATE_STORAGE_CHANGED');
}

export async function auditWorkflowStorage(capability, { limit = 20000 } = {}) {
  await assertWorkflowStorage(capability);
  const value = capabilities.get(capability);
  try { await verifyRoots(rootsOf(value.collection), value.identity, { paths: null, limit, reviewRoot: reviewRootOf(value.collection) }); return { complete: true }; }
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
