import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { readHandleStat } from './stat.mjs';
import {
  assertChain, assertDirectory, assertRegularFile, fileIdentity, inspectParent,
  lstatOrNull, pinDirectory, sameIdentity,
} from './paths.mjs';
import { assertPrivateAccess, establishWindowsPrivacy } from './platform.mjs';

export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** Read exactly the inspected bytes, bounded before allocation and after open. */
async function readDirect(pin, relative, { maxBytes, missing = false, pairedIdentity } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('READ_LIMIT_INVALID', 'The read limit must be a nonnegative integer.');
  const parent = await inspectParent(pin, relative);
  const before = await lstatOrNull(parent.file);
  if (!before) {
    await assertChain(parent.chain);
    if (missing) return null;
    fail('FILE_MISSING', 'The requested file does not exist.');
  }
  checkFile(parent.file, before, pin, pairedIdentity);
  if (before.size > maxBytes) fail('READ_LIMIT_EXCEEDED', 'The requested file exceeds the bounded read limit.');
  const identity = fileIdentity(before);
  const handle = await fs.open(parent.file, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await readHandleStat(handle);
    checkFile(parent.file, opened, pin, pairedIdentity);
    if (!sameIdentity(opened, identity)) fail('FILE_CHANGED', 'The file changed while it was being opened.');
    if (opened.size > maxBytes) fail('READ_LIMIT_EXCEEDED', 'The requested file exceeds the bounded read limit.');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) fail('FILE_CHANGED', 'The file was shortened during the read.');
      offset += read.bytesRead;
    }
    const after = await readHandleStat(handle);
    const current = await lstatOrNull(parent.file);
    if (!current || !sameIdentity(current, identity) || after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      fail('FILE_CHANGED', 'The file changed during the read.');
    }
    checkFile(parent.file, current, pin, pairedIdentity);
    await assertChain(parent.chain);
    await assertDirectory(pin);
    return Object.freeze({ bytes, hash: hashBytes(bytes), identity, mode: opened.mode });
  } finally { await handle.close(); }
}

// Only a verified interrupted restore may expose two names for the same private
// inode. Ordinary files and public notes retain the single-link requirement.
function checkFile(file, stat, pin, pairedIdentity) {
  if (pairedIdentity && stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 2 && sameIdentity(stat, pairedIdentity)) {
    assertPrivateAccess(file, stat);
  } else assertRegularFile(file, stat, pin);
}

export const removalContainerName = name => `.cuefluent-remove.${hashBytes(Buffer.from(name))}.tmp`;
const CAPTURE = /^capture\.([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.tmp$/;
const identityHash = identity => hashBytes(Buffer.from(JSON.stringify(identity)));
const captureProvenance = (identity, pin, parent) => hashBytes(Buffer.from(JSON.stringify({
  identity, target: parent.file, root: pin.chain.at(-1), parent: parent.chain.at(-1),
})));

async function removalContainer(pin, relative) {
  const parent = await inspectParent(pin, relative);
  const directory = path.join(path.dirname(parent.file), removalContainerName(path.basename(parent.file)));
  if (!await lstatOrNull(directory)) return { parent, directory, container: null, name: null };
  const container = await pinDirectory(directory, { private: true });
  const entries = await fs.opendir(directory, { bufferSize: 1 });
  let first, extra;
  try { first = await entries.read(); if (first) extra = await entries.read(); }
  finally { await entries.close(); }
  await assertDirectory(container); await assertChain(parent.chain);
  if (extra || first && !CAPTURE.test(first.name)) fail('REMOVAL_CONFLICT', 'Unknown removal recovery artifacts have been preserved.');
  return { parent, directory, container, name: first?.name ?? null };
}

async function pendingRemoval(pin, relative, maxBytes) {
  const saved = await removalContainer(pin, relative);
  if (!saved.name) return saved;
  const match = CAPTURE.exec(saved.name);
  const canonical = await lstatOrNull(saved.parent.file);
  const capturedFile = path.join(saved.directory, saved.name);
  const captured = await lstatOrNull(capturedFile);
  const pairedIdentity = canonical && captured && sameIdentity(canonical, fileIdentity(captured)) && canonical.nlink === 2 && captured.nlink === 2 ? fileIdentity(captured) : undefined;
  const snapshot = await readDirect(saved.container, saved.name, { maxBytes, pairedIdentity });
  if (captureProvenance(snapshot.identity, pin, saved.parent) !== match[1] || snapshot.hash !== match[2]) fail('REMOVAL_CONFLICT', 'Removal recovery identity or bytes changed; every artifact has been preserved.');
  const current = await lstatOrNull(saved.parent.file);
  if ((current && (!pairedIdentity || !sameIdentity(current, snapshot.identity) || current.nlink !== 2)) || (canonical && !current)) fail('WRITE_CONFLICT', 'The canonical file conflicts with its pending exact removal.');
  await assertDirectory(saved.container); await assertChain(saved.parent.chain);
  return { ...saved, snapshot, capturedFile, pairedIdentity };
}

/** Inspect one fixed recovery locator; never enumerate the metadata backlog. */
export async function readSnapshot(pin, relative, { maxBytes = 2 * 1024 * 1024, missing = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('READ_LIMIT_INVALID', 'The read limit must be a nonnegative integer.');
  const recovered = async saved => {
    if (saved.pairedIdentity) {
      const canonical = await readDirect(pin, relative, { maxBytes, pairedIdentity: saved.pairedIdentity });
      if (canonical.hash !== saved.snapshot.hash || identityHash(canonical.identity) !== identityHash(saved.snapshot.identity)) fail('REMOVAL_CONFLICT', 'Interrupted restore identity or bytes changed.');
    }
    const confirmed = await pendingRemoval(pin, relative, maxBytes);
    if (!confirmed.snapshot || confirmed.snapshot.hash !== saved.snapshot.hash || identityHash(confirmed.snapshot.identity) !== identityHash(saved.snapshot.identity)) fail('REMOVAL_CONFLICT', 'The pending removal changed during inspection.');
    return confirmed.snapshot;
  };
  if (pin?.private === true) {
    const saved = await pendingRemoval(pin, relative, maxBytes);
    if (saved.snapshot) return recovered(saved);
  }
  const snapshot = await readDirect(pin, relative, { maxBytes, missing: true });
  if (snapshot) return snapshot;
  // Capture may have occurred after the first locator probe. One bounded retry
  // preserves logical visibility without scanning or writing the parent.
  if (pin?.private === true) {
    const saved = await pendingRemoval(pin, relative, maxBytes);
    if (saved.snapshot) return recovered(saved);
  }
  if (missing) return null;
  fail('FILE_MISSING', 'The requested file does not exist.');
}

/** Owner-only cleanup of a known target's empty pre/post-capture directory. */
export async function reclaimEmptyRemoval(pin, relative) {
  if (pin?.private !== true) fail('REMOVAL_PRIVATE_REQUIRED', 'Exact removal recovery requires private metadata.');
  const saved = await removalContainer(pin, relative);
  if (!saved.container) return false;
  if (saved.name) fail('REMOVAL_CONFLICT', 'Pending exact removal must be completed before reclaiming its directory.');
  await assertDirectory(saved.container); await assertChain(saved.parent.chain);
  await fs.rmdir(saved.directory);
  await syncDirectory(path.dirname(saved.directory));
  return true;
}

export async function isEmptyRemoval(pin, relative) {
  const saved = await removalContainer(pin, relative);
  return Boolean(saved.container && !saved.name);
}

async function restoreRemoval(pin, relative, expectedHash, maxBytes) {
  const saved = await pendingRemoval(pin, relative, maxBytes);
  if (!saved.snapshot) { if (saved.container) await reclaimEmptyRemoval(pin, relative); return; }
  if (saved.snapshot.hash !== expectedHash) fail('WRITE_CONFLICT', 'The pending exact removal differs from the inspected hash.');
  if (!saved.pairedIdentity) {
    await assertDirectory(saved.container); await assertChain(saved.parent.chain);
    try { await fs.link(saved.capturedFile, saved.parent.file); }
    catch (cause) { if (cause.code === 'EEXIST') fail('WRITE_CONFLICT', 'A replacement appeared during exact removal recovery.', cause); throw cause; }
  }
  // Also flush a link left by an interrupted owner before releasing its capture.
  await syncDirectory(path.dirname(saved.parent.file));
  // A stop after link leaves a verifiable two-name pair. Reads never repair it;
  // the same owner command can resume this exact normalization.
  const confirmed = await pendingRemoval(pin, relative, maxBytes);
  if (!confirmed.pairedIdentity || confirmed.snapshot.hash !== saved.snapshot.hash || identityHash(confirmed.snapshot.identity) !== identityHash(saved.snapshot.identity)) fail('REMOVAL_CONFLICT', 'The restored exact file changed.');
  await assertDirectory(confirmed.container); await assertChain(confirmed.parent.chain);
  await fs.unlink(confirmed.capturedFile);
  await syncDirectory(confirmed.directory);
  await reclaimEmptyRemoval(pin, relative);
}

export async function readJSON(pin, relative, options) {
  const snapshot = await readSnapshot(pin, relative, options);
  if (!snapshot) return null;
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)); }
  catch (cause) { fail('JSON_INVALID', 'The stored JSON is invalid; it has been preserved.', cause); }
  return { ...snapshot, value };
}

export async function syncDirectory(directory) {
  // Windows does not expose FlushFileBuffers on a directory via Node. File data
  // is flushed before replacement; power-loss directory durability needs native
  // platform validation and is not claimed by this helper.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY | NO_FOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function expected(hash) {
  if (hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    fail('EXPECTED_HASH_REQUIRED', 'Provide the exact inspected SHA-256 hash, or null for an absent target.');
  }
}

async function compare(pin, relative, expectedHash, maxBytes) {
  const current = await readSnapshot(pin, relative, { maxBytes, missing: true });
  if ((current?.hash ?? null) !== expectedHash) {
    fail('WRITE_CONFLICT', 'The destination changed after inspection; current content has been preserved.');
  }
  return current;
}

/** Caller holds the appropriate mutation gate. Staging files never end in .md. */
export async function writeAtomic(pin, relative, bytes, { expectedHash, maxBytes = 2 * 1024 * 1024 } = {}) {
  expected(expectedHash);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('BYTES_REQUIRED', 'Atomic publication requires exact bytes.');
  bytes = Buffer.from(bytes);
  if (bytes.length > maxBytes) fail('WRITE_LIMIT_EXCEEDED', 'The proposed file exceeds its size limit.');
  const parent = await inspectParent(pin, relative);
  const original = await compare(pin, relative, expectedHash, maxBytes);
  if (pin.private) await restoreRemoval(pin, relative, expectedHash, maxBytes);
  const hash = hashBytes(bytes);
  if (original?.hash === hash) return { changed: false, hash };
  const stage = path.join(path.dirname(parent.file), `.${path.basename(parent.file)}.${randomUUID()}.tmp`);
  let staged = false;
  let published = false;
  let failure, stageIdentity;
  try {
    const handle = await fs.open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, pin.private ? 0o600 : 0o666);
    staged = true;
    try {
      if (pin.private) establishWindowsPrivacy(stage);
      const created = await readHandleStat(handle);
      assertRegularFile(stage, created, pin);
      stageIdentity = fileIdentity(created);
      await assertChain(parent.chain);
      await handle.writeFile(bytes);
      // Public note replacements retain POSIX permission bits. Node rename does
      // not carry the original inode's xattrs or custom Windows ACLs; note-writer
      // platform integration must account for those separately.
      if (!pin.private && original && process.platform !== 'win32') await handle.chmod(original.mode & 0o7777);
      await handle.sync();
    } finally { await handle.close(); }
    await assertChain(parent.chain);
    await assertDirectory(pin);
    await compare(pin, relative, expectedHash, maxBytes);
    if (expectedHash === null && !pin.private) {
      // An absent target is published without overwrite, even if another actor
      // creates the name after the last absence check.
      try { await fs.link(stage, parent.file); }
      catch (cause) {
        if (cause.code === 'EEXIST') fail('WRITE_CONFLICT', 'A new destination appeared after inspection.', cause);
        throw cause;
      }
      published = true;
      await fs.unlink(stage);
      staged = false;
    } else {
      // Every private-state publisher holds the same mutation gate. Atomic
      // rename avoids exposing a two-link metadata file if the process dies
      // between publication and removal of the staging name.
      await fs.rename(stage, parent.file);
      staged = false;
      published = true;
    }
    await syncDirectory(path.dirname(parent.file));
    await assertChain(parent.chain);
    await assertDirectory(pin);
    return { changed: true, hash };
  } catch (error) { failure = error; throw error; } finally {
    // Never remove a published destination. A failed unlink after link leaves a
    // detectable two-link file; recovery must reconcile that exact staged inode.
    if (staged && !published) {
      try {
        await assertChain(parent.chain);
        const current = await lstatOrNull(stage);
        if (current) {
          assertRegularFile(stage, current, pin);
          if (!stageIdentity || !sameIdentity(current, stageIdentity)) fail('FILE_CHANGED', 'The owned atomic stage was replaced.');
          await fs.unlink(stage);
        }
      } catch (error) {
        if (failure) { try { Object.defineProperty(failure, 'cleanupError', { value: error, configurable: true }); } catch {} }
        else throw error;
      }
    }
  }
}

export async function writeJSON(pin, relative, value, options) {
  return writeAtomic(pin, relative, jsonBytes(value), options);
}

export async function removeExact(pin, relative, expectedHash, { maxBytes = 2 * 1024 * 1024 } = {}) {
  expected(expectedHash);
  if (expectedHash === null) fail('EXPECTED_HASH_REQUIRED', 'Removal requires an inspected existing file.');
  if (pin?.private !== true) fail('REMOVAL_PRIVATE_REQUIRED', 'Exact removal requires private metadata ownership.');
  const original = await compare(pin, relative, expectedHash, maxBytes);
  await restoreRemoval(pin, relative, expectedHash, maxBytes);
  const parent = await inspectParent(pin, relative);
  const directory = path.join(path.dirname(parent.file), removalContainerName(path.basename(parent.file)));
  await assertChain(parent.chain);
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (cause) { if (cause.code === 'EEXIST') fail('REMOVAL_CONFLICT', 'Another exact removal owns this recovery directory.', cause); throw cause; }
  establishWindowsPrivacy(directory);
  const container = await pinDirectory(directory, { private: true });
  const name = `capture.${captureProvenance(original.identity, pin, parent)}.${expectedHash}.${randomUUID()}.tmp`;
  const capturedFile = path.join(directory, name);
  await syncDirectory(path.dirname(directory));
  await assertDirectory(container); await assertChain(parent.chain);
  await fs.rename(parent.file, capturedFile);
  await syncDirectory(directory); await syncDirectory(path.dirname(parent.file));
  let captured;
  try {
    captured = await readDirect(container, name, { maxBytes });
    if (captured.hash !== expectedHash || identityHash(captured.identity) !== identityHash(original.identity)) fail('WRITE_CONFLICT', 'The exact inspected file was replaced before removal.');
  } catch (failure) {
    // Restore a captured replacement without clobbering any newly created name.
    // On collision/failure both copies remain visible for explicit repair.
    try {
      const stat = await lstatOrNull(capturedFile);
      assertRegularFile(capturedFile, stat, pin);
      const identity = fileIdentity(stat);
      await assertDirectory(container); await assertChain(parent.chain);
      await fs.link(capturedFile, parent.file);
      await syncDirectory(path.dirname(parent.file));
      const restored = await lstatOrNull(parent.file), retained = await lstatOrNull(capturedFile);
      if (!restored || !retained || !sameIdentity(restored, identity) || !sameIdentity(retained, identity) || restored.nlink !== 2 || retained.nlink !== 2) fail('REMOVAL_CONFLICT', 'The captured replacement changed during restoration.');
      await fs.unlink(capturedFile); await syncDirectory(directory);
      await reclaimEmptyRemoval(pin, relative);
    } catch (recoveryError) { Object.defineProperty(failure, 'recoveryError', { value: recoveryError, configurable: true }); }
    throw failure;
  }
  await assertDirectory(container); await assertChain(parent.chain);
  await fs.unlink(capturedFile);
  await syncDirectory(directory);
  await assertDirectory(container); await assertChain(parent.chain);
  await fs.rmdir(directory);
  await syncDirectory(path.dirname(directory));
}


/** Explicit cleanup only, under the metadata owner's mutation gate. A UUID-like
 * name is insufficient: reclaim only a private, single-link stage containing
 * exactly current target bytes or an independently reconstructed exact proposal,
 * with the authoritative target and stage inodes rechecked.
 * Unknown/torn/obsolete proposals remain visible and are never adopted. */
export async function reclaimAtomicStages(pin, directory, { matchesTarget, proposed = new Map(), maxBytes = 2 * 1024 * 1024, maxEntries = 256 } = {}) {
  if (pin?.private !== true || typeof matchesTarget !== 'function' || !(proposed instanceof Map) || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) fail('STAGE_CLEANUP_INVALID', 'Stage cleanup requires private metadata ownership and explicit target names.');
  const prefix = directory ? `${directory}/` : '';
  const parent = await inspectParent(pin, `${prefix}inventory`);
  const stream = await fs.opendir(path.dirname(parent.file));
  let examined = 0, removed = 0, incomplete = false;
  try {
    for await (const entry of stream) {
      if (++examined > maxEntries) { incomplete = true; break; }
      const match = /^\.(.+)\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.exec(entry.name);
      if (!match || !matchesTarget(match[1]) || !entry.isFile()) continue;
      const stageRelative = `${prefix}${entry.name}`, targetRelative = `${prefix}${match[1]}`;
      let stage, target;
      try {
        stage = await readSnapshot(pin, stageRelative, { maxBytes });
        target = await readSnapshot(pin, targetRelative, { maxBytes, missing: true });
      } catch (error) {
        if (['PATH_UNSAFE', 'PRIVATE_ACCESS_UNSAFE', 'READ_LIMIT_EXCEEDED', 'FILE_CHANGED', 'FILE_MISSING', 'ENOENT'].includes(error.code)) continue;
        throw error;
      }
      const proposal = proposed.get(match[1]);
      if (!target || !stage.bytes.equals(target.bytes) && (!Buffer.isBuffer(proposal) || !stage.bytes.equals(proposal))) continue;
      const currentTarget = await readSnapshot(pin, targetRelative, { maxBytes });
      if (currentTarget.hash !== target.hash || currentTarget.identity.device !== target.identity.device || currentTarget.identity.inode !== target.identity.inode) fail('FILE_CHANGED', 'Authoritative metadata changed during stage cleanup.');
      const currentStage = await readSnapshot(pin, stageRelative, { maxBytes });
      if (currentStage.hash !== stage.hash || currentStage.identity.device !== stage.identity.device || currentStage.identity.inode !== stage.identity.inode) fail('FILE_CHANGED', 'The metadata stage changed during cleanup.');
      await assertChain(parent.chain);
      const stageFile = path.join(path.dirname(parent.file), entry.name);
      const named = await lstatOrNull(stageFile);
      if (!named || !sameIdentity(named, stage.identity)) fail('FILE_CHANGED', 'The exact inspected metadata stage was replaced.');
      assertRegularFile(stageFile, named, pin);
      await fs.unlink(stageFile); removed++;
    }
  } finally { if (!stream.closed) await stream.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
  if (removed) await syncDirectory(path.dirname(parent.file));
  await assertChain(parent.chain); await assertDirectory(pin);
  return { removed, incomplete };
}
