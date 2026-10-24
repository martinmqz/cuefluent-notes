import * as sqlite from 'node:sqlite';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { supportsNode, NODE_REQUIREMENT } from '../core/runtime.mjs';
import { assertMacosPrivateAccess } from './macos-acl.mjs';
import { normalizeFilesystemId } from './stat.mjs';

const MAX_GATE_BYTES = 64 * 1024;
const MARKER_SQL = 'CREATE TABLE gate_marker (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, stage TEXT NOT NULL)';
// Shared across duplicate module imports. Never open a second connection to an
// owned inode: closing it can drop the first connection's POSIX process locks.
const registryKey = Symbol.for('cuefluent.v2.storage.gates.owners');
const owners = globalThis[registryKey] ??= new Map();

export class GateError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'GateError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new GateError(code, message, cause === undefined ? undefined : { cause });
}

function runtime() {
  if (!supportsNode(process.versions.node) || typeof sqlite.Database !== 'function') {
    fail('GATE_UNSUPPORTED_RUNTIME', `Gates require ${NODE_REQUIREMENT} with node:sqlite Database.`);
  }
  // Worker threads share a process's POSIX locks but not its JavaScript registry.
  if (!isMainThread) fail('GATE_UNSUPPORTED_CONTEXT', 'Gate ownership must run in a main process, not a worker thread.');
}

function gatePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    fail('GATE_INVALID_PATH', 'A gate needs a normalized absolute path.');
  }
  return value;
}

function gateId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail('GATE_INVALID_ID', 'A gate ID must be 1–128 ASCII letters, digits, dots, underscores, colons, or hyphens.');
  }
  return value;
}

function privateEntry(stat, path, isParent, guardPath) {
  if (process.platform === 'win32') {
    if (typeof guardPath !== 'function') fail('GATE_UNSUPPORTED_PLATFORM', 'Windows gate paths require a private ACL verifier.');
  } else {
    if (stat.uid !== BigInt(process.geteuid())) fail('GATE_UNSAFE_PATH', `Gate ${isParent ? 'directory' : 'file'} has another owner: ${path}`);
    if ((stat.mode & 0o077n) !== 0n) fail('GATE_UNSAFE_PATH', `Gate ${isParent ? 'directory' : 'file'} is not private: ${path}`);
    const required = isParent ? 0o700n : 0o600n;
    if ((stat.mode & required) !== required) fail('GATE_UNSAFE_PATH', `Gate ${isParent ? 'directory' : 'file'} lacks required owner access: ${path}`);
    if (process.platform === 'darwin') {
      try { assertMacosPrivateAccess(path, stat); }
      catch (cause) { fail('GATE_UNSAFE_PATH', 'Gate macOS ACL privacy could not be established.', cause); }
    }
  }
  if (guardPath !== undefined) {
    if (typeof guardPath !== 'function') fail('GATE_INVALID_GUARD', 'guardPath must be a synchronous verifier.');
    // The verifier must throw on failure; it receives the path, type, and stat.
    const result = guardPath(path, { kind: isParent ? 'directory' : 'file', stat });
    if (result && typeof result.then === 'function') fail('GATE_INVALID_GUARD', 'guardPath must complete synchronously.');
    if (result === false) fail('GATE_UNSAFE_PATH', `Gate path verifier refused: ${path}`);
  }
}

function inspect(path, { guardPath, missing = false } = {}, allowedLinks = 1n) {
  gatePath(path);
  const root = parse(path).root;
  const parts = relative(root, path).split(sep);
  if (parts.length < 2) fail('GATE_UNSAFE_PATH', 'A gate requires a private parent directory.');
  let current = root;
  let stat;
  try {
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      try { stat = lstatSync(current, { bigint: true }); }
      catch (error) {
        if (missing && index === parts.length - 1 && error.code === 'ENOENT') return null;
        throw error;
      }
      if (stat.isSymbolicLink()) fail('GATE_UNSAFE_PATH', `Gate paths cannot contain symbolic links: ${current}`);
      const final = index === parts.length - 1;
      if (!final && !stat.isDirectory()) fail('GATE_UNSAFE_PATH', `Gate ancestor is not a directory: ${current}`);
      if (!final && process.platform !== 'win32' && (stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n) {
        fail('GATE_UNSAFE_PATH', `Gate ancestor permits replacement by another user: ${current}`);
      }
      if (!final && process.platform !== 'win32' && stat.uid !== 0n && stat.uid !== BigInt(process.geteuid())) {
        fail('GATE_UNSAFE_PATH', `Gate ancestor has an untrusted owner: ${current}`);
      }
      if (index === parts.length - 2) privateEntry(stat, current, true, guardPath);
      if (final) {
        if (!stat.isFile() || (stat.nlink < 1n || stat.nlink > allowedLinks)) fail('GATE_UNSAFE_PATH', `Gate must be a regular file with exactly one link: ${path}`);
        privateEntry(stat, path, false, guardPath);
        if (stat.size > BigInt(MAX_GATE_BYTES)) fail('GATE_INVALID_DATABASE', 'Gate database exceeds its bounded size.');
      }
    }
  } catch (error) {
    if (error instanceof GateError) throw error;
    fail('GATE_STORAGE_ERROR', `Cannot inspect gate path: ${current}`, error);
  }
  return Object.freeze({ path, device: String(normalizeFilesystemId(stat.dev)), inode: String(normalizeFilesystemId(stat.ino)) });
}

function descriptor(value) {
  if (!value || typeof value !== 'object') fail('GATE_INVALID_DESCRIPTOR', 'A verified gate descriptor is required.');
  gatePath(value.path);
  gateId(value.id);
  if (typeof value.device !== 'string' || typeof value.inode !== 'string' || !/^\d+$/.test(value.device) || !/^\d+$/.test(value.inode) || value.inode === '0') {
    fail('GATE_INVALID_DESCRIPTOR', 'A gate descriptor needs a nonzero inode and device identity.');
  }
  return value;
}

function verify(expected, options, allowedLinks = 1n) {
  const actual = inspect(expected.path, options, allowedLinks);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    fail('GATE_REPLACED', `Gate file identity changed: ${expected.path}`);
  }
}

function rejectSidecars(path) {
  // A valid initialized gate never writes after initialization, so a sidecar
  // cannot be a legitimate held-gate artifact. Refuse it before SQLite can
  // perform journal recovery or open a linked WAL/shared-memory file.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { lstatSync(`${path}${suffix}`); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw storageError(error, 'sidecar inspection');
    }
    fail('GATE_INVALID_DATABASE', `Unexpected gate sidecar requires investigation: ${path}${suffix}`);
  }
}

function keyOf(value) { return `${value.device}:${value.inode}`; }

function reserve(value) {
  const key = keyOf(value);
  if (owners.has(key)) {
    if (owners.get(key).id !== value.id) fail('GATE_INVALID_DATABASE', 'Gate ID conflicts with this process\'s existing owner.');
    return false;
  }
  owners.set(key, value);
  return true;
}

function connect(path) {
  // SQLite's Win32 calls need the extended namespace beyond MAX_PATH. Preserve
  // the canonical descriptor and same inode; only its private SQLite spelling
  // changes. win32-longpath retains OS locking (never use a *-none VFS).
  if (process.platform === 'win32') {
    return new sqlite.Database(`file:${encodeURIComponent(toNamespacedPath(path))}?mode=rw&vfs=win32-longpath`, { timeout: 0, allowExtension: false });
  }
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'rw');
  return new sqlite.Database(url.href, { timeout: 0, allowExtension: false });
}

function validateDatabase(db, expectedId) {
  db.exec('PRAGMA trusted_schema = OFF');
  const mode = db.prepare('PRAGMA journal_mode').get();
  if (mode.journal_mode !== 'delete') fail('GATE_INVALID_DATABASE', 'Gate must use DELETE journal mode.');
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if (schema.length !== 1 || schema[0].type !== 'table' || schema[0].name !== 'gate_marker' || schema[0].sql !== MARKER_SQL) {
    fail('GATE_INVALID_DATABASE', 'Gate schema does not match the initialized marker.');
  }
  const check = db.prepare('PRAGMA integrity_check(1)').get();
  if (check.integrity_check !== 'ok') fail('GATE_INVALID_DATABASE', 'Gate integrity check failed.');
  const marker = db.prepare('SELECT singleton, id, stage FROM gate_marker LIMIT 2').all();
  if (marker.length !== 1 || marker[0].singleton !== 1 || marker[0].id !== expectedId ||
      typeof marker[0].stage !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(marker[0].stage)) {
    fail('GATE_INVALID_DATABASE', 'Gate marker does not match its expected identity.');
  }
  return marker[0].stage;
}

function storageError(error, action) {
  return error instanceof GateError ? error : new GateError('GATE_STORAGE_ERROR', `Gate ${action} failed.`, { cause: error });
}

function closeConnection(db, identity, rollback) {
  const errors = [];
  let closed = false;
  if (rollback) {
    try { db.exec('ROLLBACK'); } catch (error) { errors.push(storageError(error, 'rollback')); }
  }
  try { db.close(); closed = true; } catch (error) { errors.push(storageError(error, 'close')); }
  // A failed close leaves the inode reserved: opening another connection would
  // be unsafe while SQLite might still own a process lock.
  if (closed) owners.delete(keyOf(identity));
  if (errors.length) throw new AggregateError(errors, 'Gate release failed.');
}

function syncParent(path) {
  if (process.platform === 'win32') return;
  let fd;
  try { fd = openSync(dirname(path), constants.O_RDONLY); fsyncSync(fd); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Existing ancestor policy, before setup creates any private directories. */
export function assertGatePlacement(directory) {
  gatePath(directory);
  let current = parse(directory).root;
  for (const component of relative(current, directory).split(sep).filter(Boolean)) {
    current = join(current, component);
    let stat;
    try { stat = lstatSync(current, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw storageError(error, 'placement inspection'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('GATE_UNSAFE_PATH', 'Gate placement contains a linked or nondirectory ancestor.');
    if (process.platform !== 'win32' &&
        (((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n) ||
         (stat.uid !== 0n && stat.uid !== BigInt(process.geteuid())))) {
      fail('GATE_UNSAFE_PATH', 'Gate placement has an unsafe existing ancestor owner or writable mode.');
    }
  }
}

function stagePath(path, stage) { return join(dirname(path), `.${basename(path)}.${stage}.tmp`); }

/** Publish a validated, flushed gate; the final name never refers to a blank DB. */
export function initializeGate(path, id, options = {}) {
  runtime(); gatePath(path); gateId(id);
  if (options.initializePath !== undefined && typeof options.initializePath !== 'function') fail('GATE_INVALID_GUARD', 'Gate initialization needs a synchronous created-file initializer.');
  assertGatePlacement(dirname(path));
  if (inspect(path, { ...options, missing: true }, 2n)) fail('GATE_EXISTS', 'Gate initialization refuses an existing file.');
  rejectSidecars(path);
  const stage = randomUUID();
  const temporary = stagePath(path, stage);
  let identity;
  let published = false;
  let db;
  let problem;
  try {
    let fd;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      const stat = fstatSync(fd, { bigint: true });
      identity = Object.freeze({ path: temporary, id, device: String(normalizeFilesystemId(stat.dev)), inode: String(normalizeFilesystemId(stat.ino)) });
    } finally { if (fd !== undefined) closeSync(fd); }
    if (options.initializePath) {
      // A Windows elevated token can make a newly created inode owned by the
      // Administrators group despite its private inherited DACL. Initialize only
      // this exact exclusive stage, after checking its parent and identity.
      verify(identity, { ...options, guardPath: (file, context) => {
        if (file !== temporary || context.kind !== 'file') return options.guardPath?.(file, context);
      } });
      const result = options.initializePath(temporary);
      if (result && typeof result.then === 'function') fail('GATE_INVALID_GUARD', 'The created-file initializer must complete synchronously.');
      if (result === false) fail('GATE_UNSAFE_PATH', 'The created gate file initializer refused this stage.');
    }
    verify(identity, options);
    if (!reserve(identity)) fail('GATE_BUSY', 'Gate is already open in this process.');
    try {
      db = connect(temporary);
      verify(identity, options);
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL');
      db.exec('BEGIN IMMEDIATE');
      db.exec(MARKER_SQL);
      db.prepare('INSERT INTO gate_marker(singleton, id, stage) VALUES (1, ?, ?)').run(id, stage);
      db.exec('COMMIT');
      validateDatabase(db, id);
      verify(identity, options);
    } finally {
      if (db) closeConnection(db, identity, db.isTransaction);
      else owners.delete(keyOf(identity));
    }
    verify(identity, options);
    rejectSidecars(temporary);
    let flush;
    try {
      // Windows FlushFileBuffers requires a writable handle. SQLite is closed
      // here; this is still our identity-checked unpublished stage.
      flush = openSync(temporary, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(flush, { bigint: true });
      if (String(normalizeFilesystemId(stat.dev)) !== identity.device || String(normalizeFilesystemId(stat.ino)) !== identity.inode) fail('GATE_REPLACED', 'Staged gate identity changed before flush.');
      fsyncSync(flush);
    } finally { if (flush !== undefined) closeSync(flush); }
    verify(identity, options);
    try { linkSync(temporary, path); }
    catch (error) { if (error.code === 'EEXIST') fail('GATE_EXISTS', 'Another setup published this gate first.', error); throw error; }
    published = true;
    const result = Object.freeze({ ...identity, path });
    reconcilePublication(result, stage, options);
    syncParent(path);
    verify(result, options);
    return result;
  } catch (error) { problem = storageError(error, 'initialization'); }
  if (!published && identity && !owners.has(keyOf(identity))) {
    try { verify(identity, options); rejectSidecars(temporary); unlinkSync(temporary); syncParent(temporary); }
    catch (error) { throw new AggregateError([problem, storageError(error, 'staging cleanup')], 'Gate initialization and staged cleanup failed.'); }
  }
  throw problem;
}

/** Reconcile only the initialized gate's own exact two-link staging inode. */
function reconcilePublication(identity, stage, options) {
  verify(identity, options, 2n);
  let final = lstatSync(identity.path, { bigint: true });
  if (final.nlink === 1n) return;
  const temporary = stagePath(identity.path, stage);
  const staged = inspect(temporary, { ...options, missing: true }, 2n);
  if (!staged) {
    final = lstatSync(identity.path, { bigint: true });
    if (final.nlink === 1n) { verify(identity, options); return; }
    fail('GATE_UNSAFE_PATH', 'The published gate has an unknown additional hard link.');
  }
  if (staged.device !== identity.device || staged.inode !== identity.inode) fail('GATE_UNSAFE_PATH', 'Gate staging link refers to a different file.');
  rejectSidecars(temporary);
  verify(identity, options, 2n);
  try { unlinkSync(temporary); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A concurrent explicit setup may have completed this exact publication.
  }
  syncParent(identity.path);
  verify(identity, options);
}

/** Explicit setup retry only: adopt a valid initialized gate, never repair it. */
export function inspectExistingGate(path, id, options = {}) {
  runtime();
  gatePath(path);
  gateId(id);
  const identity = Object.freeze({ ...inspect(path, options, 2n), id });
  rejectSidecars(path);
  if (!reserve(identity)) fail('GATE_BUSY', 'Gate is already open in this process.');
  let db;
  let stage;
  try {
    db = connect(path);
    verify(identity, options, 2n);
    stage = validateDatabase(db, id);
    verify(identity, options, 2n);
    rejectSidecars(path);
  } catch (error) { throw storageError(error, 'inspection'); }
  finally {
    if (db) closeConnection(db, identity, db.isTransaction);
    else owners.delete(keyOf(identity));
  }
  try { reconcilePublication(identity, stage, options); syncParent(path); }
  catch (error) { throw storageError(error, 'publication recovery'); }
  return identity;
}

/** One no-create attempt; only SQLite's numeric BUSY primary code is contention. */
export function tryAcquireExistingGate(value, options = {}) {
  runtime();
  const identity = Object.freeze({ ...descriptor(value) });
  verify(identity, options);
  rejectSidecars(identity.path);
  if (!reserve(identity)) return { busy: true };
  let db;
  let keep = false;
  try {
    db = connect(identity.path);
    verify(identity, options);
    validateDatabase(db, identity.id);
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      if (Number.isInteger(error.errcode) && (error.errcode & 0xff) === 5) return { busy: true };
      throw error;
    }
    verify(identity, options);
    keep = true;
    let released = false;
    return { acquired: Object.freeze({
      release() {
        if (released) return;
        released = true;
        const errors = [];
        try { verify(identity, options); } catch (error) { errors.push(error); }
        try { closeConnection(db, identity, true); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Gate release failed.');
      },
    }) };
  } catch (error) { throw storageError(error, 'acquisition'); }
  finally {
    if (!keep) {
      if (db) closeConnection(db, identity, db.isTransaction);
      else owners.delete(keyOf(identity));
    }
  }
}

/** A probe never creates a gate or publishes worker/run state. */
export function probeGate(value, options = {}) {
  const result = tryAcquireExistingGate(value, options);
  if (result.busy) return result;
  result.acquired.release();
  return { available: true };
}

/** Retry confirmed contention until a bounded deadline, releasing after fn. */
export async function withShortGate(value, { timeoutMs = 1000, signal, guardPath } = {}, fn) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    fail('GATE_INVALID_TIMEOUT', 'Short-gate timeout must be between 0 and 60000 milliseconds.');
  }
  if (typeof fn !== 'function') fail('GATE_INVALID_CALLBACK', 'withShortGate requires a callback.');
  const deadline = performance.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    const result = tryAcquireExistingGate(value, { guardPath });
    if (result.acquired) {
      let failure;
      try { return await fn(); }
      catch (error) { failure = error; throw error; }
      finally {
        try { result.acquired.release(); }
        catch (error) {
          if (failure) { try { Object.defineProperty(failure, 'releaseError', { value: error, configurable: true }); } catch {} }
          else throw new GateError('GATE_RELEASE_FAILED', 'The operation finished but releasing its gate failed.', { cause: error });
        }
      }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) fail('GATE_BUSY', 'Gate remained busy until its bounded deadline.');
    await delay(Math.min(25, remaining), undefined, { signal });
  }
}
