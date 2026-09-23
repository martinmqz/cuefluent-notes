import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
export const absolute = value => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= 4096 && !CONTROLS.test(value) && path.isAbsolute(value);
export const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export async function lstatOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Node resolves entry-point symlinks by default, while argv retains the typed path.
// Compare canonical files on both sides, including with --preserve-symlinks-main.
export async function isMain(url) {
  if (!process.argv[1]) return false;
  try { return await fs.realpath(fileURLToPath(url)) === await fs.realpath(process.argv[1]); }
  catch { return false; }
}

/** Exact, bounded UTF-8 bytes. Never open a FIFO in blocking mode. */
export async function readBoundedBytes(file, { maxBytes = 2 * 1024 * 1024, missing = false, utf8 = true, noFollow = false } = {}) {
  const check = stat => {
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Expected a regular UTF-8 file at most ${maxBytes / (1024 * 1024)} MiB.`);
  };
  let handle;
  try {
    check(await (noFollow ? fs.lstat(file) : fs.stat(file)));
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
  } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    check(stat);
    let buffer = Buffer.alloc(stat.size + 1);
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
