import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openGuarded, sameFileIdentity } from './file-io.mjs';
import { stableSourceIdentity, SOURCE_HEADER_BYTES } from './capture-selection.mjs';
import { integer, digest, fail } from './workflow-values.mjs';
import { checkWorkflowBudget, consumeWorkflowBytes, workflowReadLimit } from './workflow-budget.mjs';

export const SESSION_READ_LIMIT = 64 * 1024 * 1024;
export const SESSION_LINE_LIMIT = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
export function decodeSessionRecord(bytes) {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { fail('INVALID_SESSION_RECORD'); }
}

export async function readSessionHeader({ readHeader, size }) {
  let header = Buffer.alloc(0);
  while (header.indexOf(10) < 0 && header.length < Math.min(size, 64 * 1024)) {
    header = Buffer.concat([header, await readHeader(header.length, Math.min(1024, size - header.length, 64 * 1024 - header.length))]);
  }
  const newline = header.indexOf(10);
  if (newline < 0) fail('SESSION_HEADER_UNAVAILABLE');
  return decodeSessionRecord(header.subarray(0, newline));
}

/** Read one fixed snapshot with positional I/O. Caller supplies an authorized floor.
 * Header reads are bounded independently; no discovery or historical prefix scan.
 */
/** The bytes an explicit capture was chosen from, when its selection kept their hash. */
export const chosenStretch = scope => scope.contentHash === undefined ? null
  : { from: scope.start.startByte, to: (scope.end ?? scope.start).endByte, hash: scope.contentHash };
/** `stretch` ({from, to, hash}) names bytes chosen by their hash. They are
 * hashed through this read's own handle before any record is read, and the
 * checks after the read refuse a file written in place since it was opened, so
 * the records read come from the bytes that hashed. */
export async function readSessionRange({ source, from, endByte, startsMidRecord = false,
  verifyHeader, readHeader = readSessionHeader, maxBytes = SESSION_READ_LIMIT, maxRecords = 16384, deadline = Infinity,
  observeRead = () => {}, now = Date.now, stretch = null }) {
  integer(from); integer(maxBytes); integer(maxRecords);
  if (maxBytes < 1 || maxBytes > SESSION_READ_LIMIT || maxRecords < 1 || maxRecords > 16384 ||
      (deadline !== Infinity && !Number.isFinite(deadline))) fail('INVALID_READER_LIMIT');
  maxBytes = workflowReadLimit(maxBytes);
  const { handle, stat } = await openGuarded(source.path, { singleLink: true });
  try {
    const snapshotEnd = Number(stat.size); integer(snapshotEnd);
    if (stableSourceIdentity(stat) !== source.fileIdentity || snapshotEnd < from) fail('SOURCE_CHANGED');
    const stop = endByte === undefined ? snapshotEnd : Math.min(integer(endByte), snapshotEnd);
    if (stop < from) fail('SOURCE_CHANGED');
    let bytesRead = 0;
    const read = async (offset, length, purpose) => {
      checkWorkflowBudget();
      if (purpose === 'range') consumeWorkflowBytes(length);
      if (now() >= deadline) fail('SESSION_READ_BUDGET');
      const bytes = Buffer.alloc(length), result = await handle.read(bytes, 0, length, offset);
      if (result.bytesRead !== length) fail('SOURCE_CHANGED');
      observeRead({ offset, bytes: result.bytesRead, purpose });
      if (purpose === 'range') bytesRead += result.bytesRead;
      return bytes;
    };
    if (stretch) {
      integer(stretch.from); integer(stretch.to);
      if (stretch.to < stretch.from || stretch.to > snapshotEnd) fail('SOURCE_CHANGED');
      const hasher = createHash('sha256');
      for (let at = stretch.from; at < stretch.to;) {
        const length = Math.min(1024 * 1024, stretch.to - at);
        hasher.update(await read(at, length, 'stretch')); at += length;
      }
      if (hasher.digest('hex') !== stretch.hash) fail('SOURCE_CHANGED');
    }
    const metadata = await verifyHeader(await readHeader({ size: stop, readHeader: (offset, length) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > Math.min(stop, SOURCE_HEADER_BYTES)) fail('SESSION_HEADER_LIMIT');
      return read(offset, length, 'header');
    } }), source);
    const records = [], discarded = [];
    let offset = from, lineStart = from, pending = Buffer.alloc(0), skipping = startsMidRecord, limited = false, blocked = null;
    outer: while (offset < stop) {
      if (now() >= deadline) { limited = true; blocked = { offset: lineStart, code: 'SESSION_READ_BUDGET' }; break; }
      if (bytesRead >= maxBytes || records.length >= maxRecords) { limited = true; blocked = { offset: lineStart, code: 'SESSION_READ_LIMIT' }; break; }
      let chunk;
      try { chunk = await read(offset, Math.min(64 * 1024, stop - offset, maxBytes - bytesRead), 'range'); }
      catch (error) {
        if (error.code !== 'SESSION_READ_BUDGET') throw error;
        limited = true; blocked = { offset: lineStart, code: error.code }; break;
      }
      offset += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      let at;
      while ((at = pending.indexOf(10)) >= 0) {
        const bytes = pending.subarray(0, at + 1), next = lineStart + bytes.length;
        if (skipping) { discarded.push({ startByte: from, endByte: next }); skipping = false; }
        else {
          if (bytes.length > SESSION_LINE_LIMIT) { blocked = { offset: lineStart, code: 'SESSION_RECORD_LIMIT' }; break outer; }
          try { records.push({ value: decodeSessionRecord(bytes), startByte: lineStart, endByte: next, hash: digest(bytes),
            tailAnchor: { startByte: next - Math.min(bytes.length, 64 * 1024), endByte: next, hash: digest(bytes.subarray(-64 * 1024)) } }); }
          catch (error) { blocked = { offset: lineStart, code: error.code }; break outer; }
        }
        pending = pending.subarray(at + 1); lineStart = next;
        if (records.length >= maxRecords) { limited = lineStart < stop; if (limited) blocked = { offset: lineStart, code: 'SESSION_READ_LIMIT' }; break outer; }
      }
      // A discarded pre-boundary suffix is never buffered across chunks.
      if (skipping) { lineStart += pending.length; pending = Buffer.alloc(0); }
      if (pending.length > SESSION_LINE_LIMIT) { blocked = { offset: lineStart, code: 'SESSION_RECORD_LIMIT' }; break; }
    }
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(source.path, { bigint: true });
    if (!sameFileIdentity(stat, after) || !sameFileIdentity(stat, current) || after.size < stat.size ||
        after.nlink !== 1n || current.nlink !== 1n ||
        (after.size === stat.size && (after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs))) fail('SOURCE_CHANGED');
    return { metadata, records, discarded, from, snapshotEnd, readEnd: lineStart, bytesRead,
      pendingTail: lineStart < stop, limited, blocked, startsMidRecord: skipping };
  } finally { await handle.close(); }
}
