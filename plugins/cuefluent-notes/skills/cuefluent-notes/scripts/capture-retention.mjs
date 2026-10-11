import { logicalCaptureIdentity, captureRelativePath } from './capture-contract.mjs';
import { intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { keys, list, hash, integer, timestamp, nativeId, canonicalJSON, digest, fail } from './workflow-values.mjs';

export const unitKey = identity => {
  const { client, sessionId, unitId } = logicalCaptureIdentity(identity);
  return `${client}/${sessionId}/${unitId}`;
};
export const tombstonePath = identity => `pruned/${unitKey(identity)}.json`;

export function validateTombstone(value, identity) {
  keys(value, ['format', 'version', 'identity', 'operationId', 'headHash', 'sourceIdentity', 'processingHash', 'prunedAt', 'revisions']);
  if (value.format !== 'cuefluent-pruned-unit' || value.version !== 1 || canonicalJSON(value.identity) !== canonicalJSON(identity)) fail('INVALID_PRUNE_TOMBSTONE');
  logicalCaptureIdentity(value.identity); nativeId(value.operationId);
  hash(value.headHash); hash(value.sourceIdentity); hash(value.processingHash); timestamp(value.prunedAt);
  list(value.revisions, 100, { empty: false });
  const seen = new Set();
  for (const item of value.revisions) {
    keys(item, ['path', 'evidenceHash', 'fileHash', 'bytes', 'fileIdentity', 'ranges']);
    hash(item.evidenceHash); hash(item.fileHash); hash(item.fileIdentity); integer(item.bytes);
    if (item.path !== captureRelativePath(identity, item.evidenceHash) || seen.has(item.path)) fail('INVALID_PRUNE_TOMBSTONE');
    seen.add(item.path); list(item.ranges, 4096, { empty: false });
    let end = 0;
    for (const range of item.ranges) {
      keys(range, ['startByte', 'endByte']); integer(range.startByte); integer(range.endByte);
      if (range.startByte < end || range.endByte <= range.startByte) fail('INVALID_PRUNE_TOMBSTONE');
      end = range.endByte;
    }
  }
  return value;
}

export async function readTombstone(store, identity) {
  const snapshot = await intakeSnapshot(store, 'state', tombstonePath(identity));
  const value = intakeJSON(snapshot);
  return value === null ? null : validateTombstone(value, identity);
}

export async function assertCaptureRetained(store, identity) {
  if (await readTombstone(store, identity)) fail('CAPTURE_PRUNED', 'Capture was explicitly pruned; reimport is unavailable.');
}
export async function assertNoPrune(store) {
  if (intakeJSON(await intakeSnapshot(store, 'state', 'prune-pending.json')) !== null) fail('PRUNE_RECOVERY_REQUIRED');
}

// Produced only by the processing helper after durable completion (slice 7).
// Publication receipts, absent claims, and caller booleans are not substitutes.
export function validateProcessingDisposition(value) {
  keys(value, ['format', 'version', 'bindingHash', 'identity', 'headHash', 'evidenceHash', 'fileHash', 'operationId', 'outcome', 'processedAt']);
  if (value.format !== 'cuefluent-processing-disposition' || value.version !== 2 || !['saved', 'unchanged', 'skipped'].includes(value.outcome)) fail('INVALID_PROCESSING_DISPOSITION');
  logicalCaptureIdentity(value.identity); hash(value.bindingHash); hash(value.headHash); hash(value.evidenceHash); hash(value.fileHash);
  nativeId(value.operationId); timestamp(value.processedAt);
  return value;
}
export function dispositionPath(identity, headHash, bindingHash) {
  hash(headHash); hash(bindingHash);
  // Full hash remains in the record; prefixes are only locators.
  return `processed/inputs/${bindingHash.slice(0, 20)}/${unitKey(identity)}/${headHash.slice(0, 20)}.json`;
}

export function validatePublicationReceipt(value) {
  keys(value, ['format', 'version', 'publicationId', 'identity', 'evidenceHash', 'fileHash', 'sourceIdentity', 'scopeId',
    'selectionHash', 'transitionHash', 'reuseHead', 'headHash', 'nextHead', 'nextHeadHash', 'checkpointHash', 'cursorHash', 'nextCursorHash']);
  if (value.format !== 'cuefluent-capture-receipt' || value.version !== 2 || typeof value.reuseHead !== 'boolean') fail('INVALID_PUBLICATION_RECEIPT');
  logicalCaptureIdentity(value.identity); nativeId(value.scopeId);
  for (const name of ['publicationId', 'evidenceHash', 'fileHash', 'sourceIdentity', 'selectionHash', 'transitionHash', 'nextHeadHash', 'nextCursorHash']) hash(value[name]);
  for (const name of ['headHash', 'checkpointHash', 'cursorHash']) if (value[name] !== null) hash(value[name]);
  const next = value.nextHead;
  keys(next, ['format', 'version', 'identity', 'generation', 'previousHash', 'evidenceHash', 'fileHash']);
  integer(next.generation);
  if (next.previousHash !== null) hash(next.previousHash);
  if (next.format !== 'cuefluent-capture-head' || next.version !== 1 || next.generation < 1 ||
      (next.generation === 1) !== (next.previousHash === null) || canonicalJSON(next.identity) !== canonicalJSON(value.identity) ||
      next.fileHash !== value.fileHash || next.evidenceHash !== value.evidenceHash || digest(canonicalJSON(next) + '\n') !== value.nextHeadHash) fail('INVALID_PUBLICATION_RECEIPT');
  return value;
}

export function lineagePath(identity, headHash) {
  hash(headHash); return `lineage/${unitKey(identity)}/${headHash.slice(0, 20)}.json`;
}

export async function readLineageRecord(store, identity, headHash) {
  const name = lineagePath(identity, headHash), snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: 16384 });
  const index = intakeJSON(snapshot);
  keys(index, ['format', 'version', 'identity', 'headHash', 'receiptPath', 'receiptHash']);
  if (index.format !== 'cuefluent-publication-index' || index.version !== 1 || !equalIdentity(index.identity, identity) ||
      index.headHash !== headHash || !/^receipts\/[a-f0-9]{64}\.json$/.test(index.receiptPath)) fail('INVALID_PUBLICATION_INDEX');
  hash(index.receiptHash);
  const receipt = await intakeSnapshot(store, 'state', index.receiptPath, { maxBytes: 16384 });
  const value = validatePublicationReceipt(intakeJSON(receipt));
  if (receipt.hash !== index.receiptHash || value.nextHeadHash !== headHash || !equalIdentity(value.identity, identity) ||
      index.receiptPath !== `receipts/${value.publicationId}.json`) fail('INVALID_PUBLICATION_INDEX');
  return { value, path: index.receiptPath, hash: receipt.hash, indexPath: name, indexHash: snapshot.hash };
}
const equalIdentity = (left, right) => canonicalJSON(left) === canonicalJSON(right);

export async function captureLineage(store, identity, headHash, { limit = 100 } = {}) {
  const records = [];
  let next = headHash, generation = null;
  while (next !== null) {
    if (records.length >= limit) fail('CAPTURE_LINEAGE_CAPACITY');
    const record = await readLineageRecord(store, identity, next);
    if (generation !== null && record.value.nextHead.generation !== generation) fail('INVALID_PUBLICATION_INDEX');
    generation = record.value.nextHead.generation - 1;
    records.push(record); next = record.value.nextHead.previousHash;
  }
  if (generation !== null && generation !== 0) fail('INVALID_PUBLICATION_INDEX');
  return records;
}
