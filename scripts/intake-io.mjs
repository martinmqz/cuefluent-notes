import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { openGuarded, lstatOrNull, sameFileIdentity, readBoundedBytes, syncDirectory, isOwnedStage, removeOwnedStage } from './file-io.mjs';
import { canonicalWorkflowProject, canonicalWorkflowPath, overlaps, inside } from './workflow-paths.mjs';
import { PACKAGE_ROOT } from './runtime-paths.mjs';
import { canonicalJSON, digest, fail, keys, nativeId, list, unique } from './workflow-values.mjs';
import { assertWorkflowStorage, assertPrivatePaths, workflowProcessingContext } from './workflow-storage.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { ownProcessIdentity } from './process-identity.mjs';

const stores = new WeakMap(), transactions = new WeakMap();
export const MAX_INTAKE_METADATA_BYTES = 1024 * 1024;
const META_LIMIT = MAX_INTAKE_METADATA_BYTES;
function cleanupWarning(error, warning) {
  if (error instanceof Error && Object.isExtensible(error)) error.cleanupWarnings = [...(error.cleanupWarnings ?? []), warning];
  else console.error(warning);
}
const relative = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(value) || value.startsWith('/') ||
      value.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_INTAKE_PATH');
  return value;
};

/** Existing roots only. Inspection is not privacy verification or consent to collect. */
export async function inspectIntakeStore({ rawDir, intakeStateDir }) {
  const raw = await canonicalWorkflowPath(rawDir, { allowMissing: false });
  const state = await canonicalWorkflowPath(intakeStateDir, { allowMissing: false });
  if (overlaps(raw, state) || [raw, state].some(root => overlaps(PACKAGE_ROOT, root))) fail('WORKFLOW_STORAGE_OVERLAP');
  const identities = new Map(await Promise.all([raw, state].map(async root => [root, await fs.lstat(root, { bigint: true })])));
  const store = Object.freeze({ rawDir: raw, intakeStateDir: state });
  stores.set(store, { identities });
  await guardStore(store); return store;
}

/** Production write authority originates only in a current opaque capability. */
export async function openWorkflowIntake(capability, selection = null, operation = 'maintenance') {
  const collection = await assertWorkflowStorage(capability, selection, operation);
  const store = await inspectIntakeStore(collection);
  Object.assign(stores.get(store), { capability, selection: structuredClone(selection), operation });
  return store;
}

/** Build processing state from one fresh verification, keeping authority opaque. */
export async function openProcessingIntake(capability, selection, operation) {
  const context = await workflowProcessingContext(capability, selection, operation);
  const store = await inspectIntakeStore(context.collection);
  Object.assign(stores.get(store), { capability, selection: structuredClone(selection), operation });
  return { ...context, store };
}

/** One-time collection authority is confined to one explicitly selected scope. */
export async function openExplicitCaptureIntake(capability, selection, scope) {
  keys(scope, ['scopeId', 'unitIds']); nativeId(scope.scopeId);
  list(scope.unitIds, 100, { empty: false }).forEach(nativeId); unique(scope.unitIds);
  const store = await openWorkflowIntake(capability, selection, 'explicitCollect');
  stores.get(store).explicitScope = structuredClone(scope);
  return store;
}

export async function assertIntakePrivacy(transaction, { identity, projectRoot, operation = 'collect', scopeId = null }) {
  const store = await assertIntakeTransaction(transaction), meta = stores.get(store);
  if (!meta.capability) fail('STORAGE_CAPABILITY_REQUIRED');
  if (operation === 'collect') {
    const explicit = meta.operation === 'explicitCollect' && meta.explicitScope?.scopeId === scopeId &&
      (!identity.unitId || meta.explicitScope.unitIds.includes(identity.unitId));
    if ((!explicit && meta.operation !== 'collect') || !meta.selection || meta.selection.client !== identity.client || meta.selection.sessionId !== identity.sessionId ||
        await canonicalWorkflowProject(meta.selection.cwd) !== await canonicalWorkflowProject(projectRoot)) fail('WORKFLOW_NOT_AUTHORIZED');
    if (explicit) operation = 'explicitCollect';
  }
  await assertWorkflowStorage(meta.capability, meta.selection, operation);
}

async function checkPrivatePath(store, file) {
  const value = stores.get(store);
  if (value.capability) await assertPrivatePaths(value.capability, [file]);
}

/** Authenticate a bounded set with one fresh native permission batch. The
 * structural view retains its pins; content caching never substitutes for a
 * missing, changed, linked or newly untrusted path. */
export async function intakeSnapshotBatch(store, names, { maxBytes = META_LIMIT, cache = true } = {}) {
  if (!Array.isArray(names) || names.length > 16) fail('INTAKE_METADATA_CAPACITY_EXCEEDED');
  const meta = stores.get(store);
  if (!meta) fail('UNRECOGNIZED_INTAKE_STORE');
  meta.batchStore ??= await inspectIntakeStore(store);
  const files = await Promise.all(names.map(name => intakePath(meta.batchStore, 'state', name)));
  if (meta.capability) await assertPrivatePaths(meta.capability, files);
  const results = [];
  meta.batchCache ??= new Map();
  for (let i = 0; i < names.length; i++) {
    checkWorkflowBudget();
    await guardStore(meta.batchStore, [files[i]]);
    const stat = await lstatOrNull(files[i], { bigint: true }), old = cache ? meta.batchCache.get(names[i]) : null;
    const version = value => value && [value.dev, value.ino, value.birthtimeNs, value.ctimeNs, value.mtimeNs, value.size, value.mode, value.uid, value.gid, value.nlink].map(String).join(':');
    let snapshot;
    if (old && stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= maxBytes &&
        version(stat) === version(old.identity) && await fs.realpath(files[i]) === files[i]) snapshot = old;
    else snapshot = await intakeSnapshot(meta.batchStore, 'state', names[i], { maxBytes });
    const after = await lstatOrNull(files[i], { bigint: true });
    await guardStore(meta.batchStore, [files[i]]);
    if (version(after) !== version(snapshot.identity)) fail('INTAKE_FILE_CHANGED');
    meta.batchCache.delete(names[i]);
    if (cache && snapshot.bytes) meta.batchCache.set(names[i], snapshot);
    // At most two generations of the sixteen pages; old content is disposable.
    while (meta.batchCache.size > 32) meta.batchCache.delete(meta.batchCache.keys().next().value);
    results.push(snapshot);
  }
  return results;
}

/** Caller reserves a finite durable allocation before entering this function.
 * Interrupted pages remain inert and charged, never adopted or deleted. */
export async function writeIntakePageBatch(transaction, pages) {
  const store = await assertIntakeTransaction(transaction), meta = stores.get(store);
  if (!meta.capability) fail('STORAGE_CAPABILITY_REQUIRED');
  if (!Array.isArray(pages) || pages.length > 16) fail('READER_CHECKPOINT_CAPACITY');
  const opened = [];
  const guard = async files => { await assertIntakeTransaction(transaction); await guardStore(store, files); };
  try {
    for (const page of pages) {
      if (!Buffer.isBuffer(page.bytes) || page.bytes.length > 512 * 1024) fail('READER_CHECKPOINT_CAPACITY');
      const file = await intakePath(store, 'state', page.name, { createParents: true });
      await guard([file]);
      const handle = await fs.open(file, 'wx', 0o600);
      const entry = { ...page, file, handle }; opened.push(entry);
      entry.identity = await handle.stat({ bigint: true });
    }
    await assertPrivatePaths(meta.capability, opened.map(page => page.file));
    for (const page of opened) {
      checkWorkflowBudget(); await guard([page.file]);
      const current = await fs.lstat(page.file, { bigint: true });
      if (!sameFileIdentity(page.identity, current) || current.nlink !== 1n || current.size !== 0n || current.ctimeNs !== page.identity.ctimeNs) fail('INTAKE_STAGE_CHANGED');
      await page.handle.writeFile(page.bytes); await page.handle.sync();
      page.identity = await page.handle.stat({ bigint: true });
      await syncDirectory(path.dirname(page.file));
    }
    await assertPrivatePaths(meta.capability, opened.map(page => page.file));
    return opened.map(({ handle: _handle, ...page }) => page);
  } finally {
    await Promise.all(opened.map(page => page.handle.close()));
  }
}
export async function guardStore(store, files = []) {
  const metadata = stores.get(store);
  if (!metadata) fail('UNRECOGNIZED_INTAKE_STORE');
  const roots = [store.rawDir, store.intakeStateDir], touched = new Set(roots);
  for (const file of files) {
    const root = roots.find(root => inside(root, file));
    if (!root || path.resolve(file) !== file) fail('UNSAFE_INTAKE_PATH');
    let current = path.dirname(file);
    while (inside(root, current)) {
      if (metadata.identities.has(current)) touched.add(current);
      if (current === root) break;
      current = path.dirname(current);
    }
  }
  for (const directory of touched) {
    const original = metadata.identities.get(directory);
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(original, stat) ||
        await fs.realpath(directory) !== directory) fail('INTAKE_ROOT_CHANGED');
  }
}

export async function intakePath(store, area, name, { createParents = false } = {}) {
  await guardStore(store);
  if (!['raw', 'state'].includes(area)) fail('UNSAFE_INTAKE_PATH');
  const root = area === 'raw' ? store.rawDir : store.intakeStateDir;
  const parts = relative(name).split('/'), file = path.join(root, ...parts);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const pinned = stores.get(store).identities.get(current);
    let stat = await lstatOrNull(current, { bigint: true });
    if (!stat && pinned) fail('INTAKE_ROOT_CHANGED');
    if (!stat && createParents) {
      await guardStore(store, [current]);
      try { await fs.mkdir(current, { mode: 0o700 }); await syncDirectory(path.dirname(current)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await fs.lstat(current, { bigint: true });
    }
    if (!stat && !createParents) { await guardStore(store, [current]); return file; }
    if (!stat?.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) fail('UNSAFE_INTAKE_PATH');
    if (pinned && !sameFileIdentity(pinned, stat)) fail('INTAKE_ROOT_CHANGED');
    if (!pinned) stores.get(store).identities.set(current, stat);
  }
  await guardStore(store, [file]);
  return file;
}

export async function intakeSnapshot(store, area, name, { maxBytes = META_LIMIT, allowLinks = 1 } = {}) {
  checkWorkflowBudget();
  const file = await intakePath(store, area, name);
  await checkPrivatePath(store, file);
  const opened = await openGuarded(file, { missing: true, maxBytes, singleLink: allowLinks === 1 });
  if (!opened) return { bytes: null, hash: null, identity: null };
  const { handle, stat } = opened;
  try {
    if (stat.nlink !== BigInt(allowLinks)) fail('UNEXPECTED_INTAKE_LINK');
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) fail('INTAKE_FILE_CHANGED'); offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(await intakePath(store, area, name), { bigint: true });
    if (!sameFileIdentity(stat, after) || !sameFileIdentity(stat, current) || stat.size !== after.size ||
        stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs || after.nlink !== BigInt(allowLinks) ||
        current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) fail('INTAKE_FILE_CHANGED');
    return { bytes, hash: digest(bytes), identity: stat };
  } finally { await handle.close(); }
}

export function intakeJSON(snapshot) {
  if (snapshot.bytes === null) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)); }
  catch { fail('INVALID_INTAKE_METADATA'); }
}

export async function writeIntakeStage(store, area, name, bytes, guard) {
  checkWorkflowBudget();
  await guard();
  const file = await intakePath(store, area, name, { createParents: true });
  const stageGuard = async () => { await guard(); await guardStore(store, [file]); };
  await stageGuard();
  const handle = await fs.open(file, 'wx', 0o600);
  let identity;
  try {
    try {
      identity = await handle.stat({ bigint: true }); await stageGuard();
      await checkPrivatePath(store, file); await stageGuard();
      await handle.writeFile(bytes); await handle.sync();
    } finally {
      try { identity = await handle.stat({ bigint: true }); } catch { identity = undefined; }
      await handle.close();
    }
    await syncDirectory(path.dirname(file));
  } catch (error) {
    try {
      if (!identity || !await removeOwnedStage(file, identity, bytes, { partial: true, guard: stageGuard })) throw new Error();
    } catch { cleanupWarning(error, 'Intake stage cleanup was unsafe; preserve the remaining file for inspection.'); }
    throw error;
  }
  return { file, identity };
}

export async function assertIntakeTransaction(transaction) {
  const metadata = transactions.get(transaction);
  if (!metadata?.active) fail('INTAKE_LOCK_REQUIRED');
  await metadata.guard(); return metadata.store;
}

export async function replaceIntakeJSON(transaction, name, value, expectedHash) {
  checkWorkflowBudget();
  const store = await assertIntakeTransaction(transaction);
  const bytes = Buffer.from(canonicalJSON(value) + '\n');
  if (bytes.length > META_LIMIT) fail('INTAKE_METADATA_CAPACITY_EXCEEDED');
  if ((await intakeSnapshot(store, 'state', name)).hash !== expectedHash) fail('INTAKE_STATE_CONFLICT');
  const stageName = `metadata-stages/.metadata-${randomUUID()}.tmp`;
  const guard = () => assertIntakeTransaction(transaction);
  const stage = await writeIntakeStage(store, 'state', stageName, bytes, guard);
  try {
    const target = await intakePath(store, 'state', name, { createParents: true });
    if ((await intakeSnapshot(store, 'state', name)).hash !== expectedHash) fail('INTAKE_STATE_CONFLICT');
    if (!await isOwnedStage(stage.file, stage.identity, bytes, { guard })) fail('INTAKE_STAGE_CHANGED');
    await guard(); await guardStore(store, [stage.file, target]); await fs.rename(stage.file, target); await syncDirectory(path.dirname(target));
    return digest(bytes);
  } finally { await removeOwnedStage(stage.file, stage.identity, bytes, { guard }); }
}

/** No stealing, including incomplete owners. */
export async function withIntakeLock(store, operation, { probeOwner = ownProcessIdentity } = {}) {
  await guardStore(store);
  const evidence = await probeOwner(process.pid);
  const owner = { version: 1, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(),
    nonce: randomUUID(), processStart: evidence.processStart ?? null, boot: evidence.boot ?? null };
  const bytes = Buffer.from(canonicalJSON(owner) + '\n');
  if (bytes.length > 16 * 1024) fail('INVALID_INTAKE_OWNER');
  const lock = path.join(store.intakeStateDir, '.intake-lock');
  await guardStore(store);
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('INTAKE_BLOCKED'); throw error; }
  const identity = await fs.lstat(lock, { bigint: true });
  const ownerPath = path.join(lock, 'owner.json');
  const guardDirectory = async () => {
    await guardStore(store);
    const stat = await fs.lstat(lock, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(identity, stat)) fail('INTAKE_LOCK_CHANGED');
  };
  let ownerIdentity;
  try {
    const handle = await fs.open(ownerPath, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally {
      try { ownerIdentity = await handle.stat({ bigint: true }); } catch { ownerIdentity = undefined; }
      await handle.close();
    }
    await syncDirectory(lock); await syncDirectory(store.intakeStateDir);
  } catch (error) {
    try {
      await guardDirectory();
      if (ownerIdentity && !await removeOwnedStage(ownerPath, ownerIdentity, bytes, { partial: true, guard: guardDirectory })) throw new Error();
      await guardDirectory(); await fs.rmdir(lock); await syncDirectory(store.intakeStateDir);
    } catch { cleanupWarning(error, 'Incomplete intake lock cleanup was unsafe; preserve it for inspection.'); }
    throw error;
  }
  const guard = async () => {
    await guardDirectory();
    const ownerStat = await fs.lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.nlink !== 1 || !(await readBoundedBytes(ownerPath, { noFollow: true, maxBytes: 16 * 1024 })).equals(bytes)) fail('INTAKE_LOCK_CHANGED');
  };
  const transaction = Object.freeze({});
  transactions.set(transaction, { store, guard, active: true });
  let output, failure, failed = false, warning;
  try { await guard(); output = await operation(transaction); }
  catch (error) { failed = true; failure = error; }
  transactions.get(transaction).active = false;
  try {
    await guard();
    const entries = await fs.readdir(lock);
    if (entries.length !== 1 || entries[0] !== 'owner.json') fail('INTAKE_LOCK_CHANGED');
    await fs.unlink(ownerPath);
    const current = await fs.lstat(lock, { bigint: true });
    if (!sameFileIdentity(identity, current)) fail('INTAKE_LOCK_CHANGED');
    await fs.rmdir(lock); await syncDirectory(store.intakeStateDir);
  } catch (error) {
    warning = `Intake lock cleanup failed (${error.code ?? 'filesystem error'}); preserve its owner metadata and inspect before retrying.`;
  }
  if (failed) { if (warning) cleanupWarning(failure, warning); throw failure; }
  return warning ? { ...output, warnings: (output?.warnings ?? 0) + 1, cleanupWarnings: [...(output?.cleanupWarnings ?? []), warning] } : output;
}
