import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { readHandleStat } from './stat.mjs';
import {
  assertChain, assertDirectory, assertRegularFile, fileIdentity, inspectParent,
  lstatOrNull, sameIdentity,
} from './paths.mjs';
import { establishWindowsPrivacy } from './platform.mjs';

export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** Read exactly the inspected bytes, bounded before allocation and after open. */
export async function readSnapshot(pin, relative, { maxBytes = 2 * 1024 * 1024, missing = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('READ_LIMIT_INVALID', 'The read limit must be a nonnegative integer.');
  const parent = await inspectParent(pin, relative);
  const before = await lstatOrNull(parent.file);
  if (!before) {
    await assertChain(parent.chain);
    if (missing) return null;
    fail('FILE_MISSING', 'The requested file does not exist.');
  }
  assertRegularFile(parent.file, before, pin);
  if (before.size > maxBytes) fail('READ_LIMIT_EXCEEDED', 'The requested file exceeds the bounded read limit.');
  const identity = fileIdentity(before);
  const handle = await fs.open(parent.file, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await readHandleStat(handle);
    assertRegularFile(parent.file, opened, pin);
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
    assertRegularFile(parent.file, current, pin);
    await assertChain(parent.chain);
    await assertDirectory(pin);
    return Object.freeze({ bytes, hash: hashBytes(bytes), identity, mode: opened.mode });
  } finally { await handle.close(); }
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
  const hash = hashBytes(bytes);
  if (original?.hash === hash) return { changed: false, hash };
  const stage = path.join(path.dirname(parent.file), `.${path.basename(parent.file)}.${randomUUID()}.tmp`);
  let staged = false;
  let published = false;
  try {
    const handle = await fs.open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, pin.private ? 0o600 : 0o666);
    staged = true;
    try {
      if (pin.private) establishWindowsPrivacy(stage);
      assertRegularFile(stage, await readHandleStat(handle), pin);
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
  } finally {
    // Never remove a published destination. A failed unlink after link leaves a
    // detectable two-link file; recovery must reconcile that exact staged inode.
    if (staged && !published) {
      await assertChain(parent.chain);
      await fs.unlink(stage);
    }
  }
}

export async function writeJSON(pin, relative, value, options) {
  return writeAtomic(pin, relative, jsonBytes(value), options);
}

export async function removeExact(pin, relative, expectedHash, { maxBytes = 2 * 1024 * 1024 } = {}) {
  expected(expectedHash);
  if (expectedHash === null) fail('EXPECTED_HASH_REQUIRED', 'Removal requires an inspected existing file.');
  const parent = await inspectParent(pin, relative);
  await compare(pin, relative, expectedHash, maxBytes);
  await assertChain(parent.chain);
  await fs.unlink(parent.file);
  await syncDirectory(path.dirname(parent.file));
}
