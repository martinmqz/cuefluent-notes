import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
// Win32 aliases (devices, alternate streams, trailing dots/spaces) cannot be
// treated as distinct ordinary files. Keep this independent of the host for tests.
export const windowsComponent = value => !!value && !CONTROLS.test(value) &&
  !/[<>:"|?*\\/]/.test(value) && !/[. ]$/.test(value) &&
  !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value);
export function windowsAbsolute(value) {
  const normalized = value.replaceAll('\\', '/');
  const root = /^(?:[a-z]:\/|\/\/([^/]+)\/([^/]+)(?:\/|$))/i.exec(normalized);
  if (!root || (root[1] && (!windowsComponent(root[1]) || !windowsComponent(root[2])))) return false;
  return normalized.slice(root[0].length).split('/').every(part =>
    !part || part === '.' || part === '..' || windowsComponent(part));
}
export const absolute = value => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= 4096 && !CONTROLS.test(value) &&
  (process.platform === 'win32' ? windowsAbsolute(value) : path.isAbsolute(value));
export const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export const sameFileIdentity = (left, right) => left && right && left.dev === right.dev &&
  left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;

export async function readInputJSON(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error('JSON input exceeds its limit.');
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function syncDirectory(dir) {
  // Node cannot flush directory handles on Windows. Still validate the path;
  // file fsync errors remain fatal everywhere. Rename power-loss durability is
  // consequently weaker on Windows than a filesystem with directory fsync.
  if (process.platform === 'win32') {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a real directory for synchronization.');
    return;
  }
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle.close(); }
}
export function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export async function lstatOrNull(file, options) {
  try { return await fs.lstat(file, options); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Node resolves entry-point symlinks by default, while argv retains the typed path.
// Compare canonical files on both sides, including with --preserve-symlinks-main.
export async function isMain(url) {
  if (!process.argv[1]) return false;
  try { return await fs.realpath(fileURLToPath(url)) === await fs.realpath(process.argv[1]); }
  catch { return false; }
}

/** Open an ordinary file without trusting a path that changed during open. */
export async function openGuarded(file, { flags = constants.O_RDONLY, missing = false, singleLink = false, maxBytes = Infinity } = {}) {
  const check = stat => {
    if (!stat.isFile() || (singleLink && stat.nlink !== 1n)) {
      throw new Error('Expected a regular file within the size limit' + (singleLink ? ' with a single hard link.' : '.'));
    }
    if (stat.size > maxBytes) throw Object.assign(new Error('Expected a regular file within the size limit.'), { code: 'FILE_SIZE_LIMIT_EXCEEDED' });
  };
  let handle;
  try {
    const before = await fs.lstat(file, { bigint: true });
    check(before);
    handle = await fs.open(file, flags | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    const current = await fs.lstat(file, { bigint: true });
    check(stat); check(current);
    if (!sameFileIdentity(before, stat) || !sameFileIdentity(stat, current)) throw new Error('File identity changed during guarded open.');
    return { handle, stat };
  } catch (error) {
    if (handle) await handle.close();
    if (missing && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Exact, bounded UTF-8 bytes. Never open a FIFO in blocking mode. */
export async function readBoundedBytes(file, { maxBytes = 2 * 1024 * 1024, missing = false, utf8 = true, noFollow = false } = {}) {
  const check = stat => {
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Expected a regular UTF-8 file at most ${maxBytes / (1024 * 1024)} MiB.`);
  };
  let handle, stat;
  try {
    if (noFollow) {
      const opened = await openGuarded(file, { missing, maxBytes });
      if (!opened) return null;
      ({ handle, stat } = opened);
    } else {
      check(await fs.stat(file));
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    }
  } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  try {
    stat ??= await handle.stat();
    check(stat);
    let buffer = Buffer.alloc(Number(stat.size) + 1);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > maxBytes) throw new Error(`File exceeds ${maxBytes / (1024 * 1024)} MiB.`);
      // A file may grow after stat. Grow the buffer rather than truncating it at
      // the inspected size; the extra byte always detects the actual limit.
      if (offset === buffer.length) {
        const grown = Buffer.alloc(Math.min(maxBytes + 1, Math.max(4096, buffer.length * 2)));
        buffer.copy(grown, 0, 0, offset);
        buffer = grown;
      }
    }
    const bytes = buffer.subarray(0, offset);
    if (utf8) new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return bytes;
  } finally { await handle.close(); }
}

/** Verify a helper-owned stage across the byte read, including optional parents. */
export async function isOwnedStage(file, identity, bytes, { partial = false, guard } = {}) {
  const unchanged = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    sameFileIdentity(identity, stat) && stat.ctimeNs === identity.ctimeNs && stat.mtimeNs === identity.mtimeNs;
  try {
    if (!identity) return false;
    await guard?.();
    if (!unchanged(await fs.lstat(file, { bigint: true }))) return false;
    const actual = await readBoundedBytes(file, { maxBytes: bytes.length, utf8: false, noFollow: true });
    if (!actual.equals(partial ? bytes.subarray(0, actual.length) : bytes)) return false;
    await guard?.();
    return unchanged(await fs.lstat(file, { bigint: true }));
  } catch { return false; }
}

/** Remove only the still-owned stage; false leaves unfamiliar paths untouched. */
export async function removeOwnedStage(file, identity, bytes, options) {
  if (!await isOwnedStage(file, identity, bytes, options)) return false;
  await fs.unlink(file);
  return true;
}
