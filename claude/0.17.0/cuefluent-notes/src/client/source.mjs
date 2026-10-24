import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { assertAbsolute, assertChain, assertRegularFile, fileIdentity, inspectAncestors, lstatOrNull, sameIdentity } from '../storage/paths.mjs';
import { readHandleStat } from '../storage/stat.mjs';

export const SOURCE_READ_BYTES = 64 * 1024;
const versionMatches = (a, b) => a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Read-only bounded source. Caller supplies a native-verified, canonical path;
 * this function never discovers a chat by cwd or filename recency. A snapshot is
 * an observed prefix, not a declaration that a native exchange is complete.
 * Hashing/verification runs outside all short mutation gates.
 */
export async function openTranscript(file, { identity = null } = {}) {
  assertAbsolute(file);
  const chain = await inspectAncestors(path.dirname(file));
  const initial = await lstatOrNull(file);
  if (!initial) { await assertChain(chain); return null; }
  assertRegularFile(file, initial);
  if (process.getuid && initial.uid !== process.getuid()) fail('SOURCE_OWNER_INVALID', 'The native source is not owned by the current user.');
  const observed = fileIdentity(initial);
  if (identity && !sameIdentity(initial, identity)) fail('SOURCE_IDENTITY_CHANGED', 'The native source identity changed; verify its native lifecycle before resuming.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let closed = false;
  const size = initial.size;

  async function current() {
    if (closed) fail('SOURCE_CLOSED', 'The native source reader is closed.');
    const named = await lstatOrNull(file), opened = await readHandleStat(handle);
    if (!named || !sameIdentity(named, observed) || !sameIdentity(opened, observed) || named.size < size || opened.size < size) {
      fail('SOURCE_CHANGED', 'The native source was replaced or shortened; its queue and bookmark have been preserved.');
    }
    assertRegularFile(file, named); assertRegularFile(file, opened);
    await assertChain(chain);
    return opened;
  }

  async function read(offset, length) {
    if (closed) fail('SOURCE_CLOSED', 'The native source reader is closed.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > SOURCE_READ_BYTES || offset > size || length > size - offset) {
      fail('SOURCE_RANGE_INVALID', 'Source reads must stay within the bounded observed prefix.');
    }
    const bytes = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const result = await handle.read(bytes, count, length - count, offset + count);
      if (!result.bytesRead) fail('SOURCE_CHANGED', 'The source was shortened while reading.');
      count += result.bytesRead;
    }
    return bytes;
  }

  async function digest(start, end) {
    const hash = createHash('sha256');
    for (let offset = start; offset < end;) {
      const bytes = await read(offset, Math.min(SOURCE_READ_BYTES, end - offset));
      hash.update(bytes); offset += bytes.length;
    }
    return hash.digest('hex');
  }

  try {
    const before = await current();
    const hash = await digest(0, size);
    const after = await current();
    if (!versionMatches(before, after)) fail('SOURCE_BUSY', 'The native source changed during its initial inspection; retry from the retained bookmark.');
    let verified = after, verifiedAnchor = null;
    return Object.freeze({ size, identity: observed, hash, read,
      async verify(anchor = null) {
        const beforeCheck = await current();
        if (!versionMatches(beforeCheck, verified)) {
          // Appends are allowed, but every byte in the inspected prefix must
          // remain identical. Size growth alone never proves append-only change.
          if (await digest(0, size) !== hash) fail('SOURCE_CHANGED', 'The inspected native source prefix changed.');
        }
        if (anchor) {
          if (!Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || anchor.start < 0 ||
              anchor.end < anchor.start || anchor.end > size || !/^[a-f0-9]{64}$/.test(anchor.hash)) {
            fail('SOURCE_ANCHOR_INVALID', 'The retained native source anchor is invalid.');
          }
          // A source prefix proven unchanged also proves an already-checked
          // anchor unchanged. Retain only one small anchor, not a row history.
          if (!verifiedAnchor || verifiedAnchor.start !== anchor.start || verifiedAnchor.end !== anchor.end || verifiedAnchor.hash !== anchor.hash) {
            if (await digest(anchor.start, anchor.end) !== anchor.hash) fail('SOURCE_ANCHOR_CHANGED', 'The retained native source anchor changed.');
            verifiedAnchor = { start: anchor.start, end: anchor.end, hash: anchor.hash };
          }
        }
        const afterCheck = await current();
        if (!versionMatches(beforeCheck, afterCheck)) fail('SOURCE_BUSY', 'The native source changed during verification; retry before publishing.');
        verified = afterCheck;
        return Object.freeze({ identity: observed, size, hash });
      },
      async close() { if (!closed) { closed = true; await handle.close(); } },
    });
  } catch (error) { await handle.close(); throw error; }
}
