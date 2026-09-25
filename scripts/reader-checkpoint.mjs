import { keys, list, nativeId, hash, integer, string, timestamp, canonicalJSON, fail } from './workflow-values.mjs';

// Carry contains native metadata and exact locators, never transcript prose.
export const MAX_READER_CHECKPOINT_BYTES = 8 * 1024 * 1024;
export function validateReaderCheckpoint(value, { identity, scopeId, sourceIdentity, offset } = {}) {
  keys(value, ['format', 'version', 'reader', 'client', 'sessionId', 'scopeId', 'sourceIdentity', 'offset', 'records', 'units']);
  if (value.format !== 'cuefluent-reader-checkpoint' || value.version !== 1 || !['claude', 'codex'].includes(value.client)) fail('INVALID_READER_CHECKPOINT');
  string(value.reader, 128); nativeId(value.sessionId); nativeId(value.scopeId); hash(value.sourceIdentity); integer(value.offset);
  if (Buffer.byteLength(canonicalJSON(value)) > MAX_READER_CHECKPOINT_BYTES) fail('READER_CHECKPOINT_CAPACITY');
  if (!Array.isArray(value.records) || !Array.isArray(value.units)) fail('INVALID_READER_CHECKPOINT');
  if (value.records.length > 32768 || value.units.length > 8192) fail('READER_CHECKPOINT_CAPACITY');
  const ids = new Map(); let end = 0;
  list(value.records, 32768).forEach(record => {
    keys(record, ['id', 'parentId', 'unitId', 'kind', 'startByte', 'endByte', 'hash']);
    string(record.id, 256); if (record.parentId !== null) string(record.parentId, 256);
    if (record.unitId !== null) nativeId(record.unitId);
    if (!['human', 'human-empty', 'structural', 'unowned'].includes(record.kind)) fail('INVALID_READER_CHECKPOINT');
    integer(record.startByte); integer(record.endByte); hash(record.hash);
    if (record.startByte >= record.endByte || record.startByte < end || record.endByte > value.offset || ids.has(record.id) ||
        record.parentId === record.id || record.kind.startsWith('human') !== (record.unitId !== null)) fail('INVALID_READER_CHECKPOINT');
    end = record.endByte; ids.set(record.id, record);
  });
  const units = new Set();
  list(value.units, 8192).forEach(unit => {
    keys(unit, ['id', 'recordId', 'occurredAt']); nativeId(unit.id); string(unit.recordId, 256); timestamp(unit.occurredAt);
    if (units.has(unit.id) || !ids.get(unit.recordId)?.kind.startsWith('human') || ids.get(unit.recordId)?.unitId !== unit.id) fail('INVALID_READER_CHECKPOINT');
    units.add(unit.id);
  });
  if ((identity && (identity.client !== value.client || identity.sessionId !== value.sessionId)) ||
      (scopeId !== undefined && scopeId !== value.scopeId) || (sourceIdentity !== undefined && sourceIdentity !== value.sourceIdentity) ||
      (offset !== undefined && offset !== value.offset)) fail('READER_CHECKPOINT_IDENTITY_MISMATCH');
  return value;
}
export function assertCheckpointExtension(previous, next) {
  if (previous === null) { if (next !== null) validateReaderCheckpoint(next); return; }
  validateReaderCheckpoint(previous);
  if (next === null) fail('READER_CHECKPOINT_CONFLICT');
  validateReaderCheckpoint(next);
  for (const field of ['reader', 'client', 'sessionId', 'scopeId', 'sourceIdentity']) if (next[field] !== previous[field]) fail('READER_CHECKPOINT_CONFLICT');
  if (next.offset < previous.offset) fail('READER_CHECKPOINT_CONFLICT');
  const rows = new Map(next.records.map(row => [row.id, canonicalJSON(row)])), units = new Map(next.units.map(unit => [unit.id, canonicalJSON(unit)]));
  for (const old of previous.records) if (rows.get(old.id) !== canonicalJSON(old)) fail('READER_CHECKPOINT_CONFLICT');
  for (const old of previous.units) if (units.get(old.id) !== canonicalJSON(old)) fail('READER_CHECKPOINT_CONFLICT');
}

// Greedy append-order pages preserve sealed prefixes across later commits. A
// unit's first anchor travels with its record; no second independently growing
// index is needed. The reader uses this same planner before accepting each row.
export const READER_PAGE_BYTES = 512 * 1024;
export function checkpointPageBuilder(value) {
  const pages = [];
  const make = index => ({ format: 'cuefluent-reader-page', version: 1, reader: value.reader, client: value.client,
    sessionId: value.sessionId, scopeId: value.scopeId, sourceIdentity: value.sourceIdentity, index, records: [], units: [] });
  const append = (record, unit = null) => {
    const recordBytes = Buffer.byteLength(canonicalJSON(record)), unitBytes = unit ? Buffer.byteLength(canonicalJSON(unit)) : 0;
    let page = pages.at(-1);
    const growth = candidate => recordBytes + (candidate.value.records.length ? 1 : 0) +
      (unit ? unitBytes + (candidate.value.units.length ? 1 : 0) : 0);
    if (!page || page.bytes + growth(page) > READER_PAGE_BYTES) {
      const next = make(pages.length), bytes = Buffer.byteLength(canonicalJSON(next)) + 1;
      page = { value: next, bytes };
      if (pages.length === 16 || bytes + growth(page) > READER_PAGE_BYTES) fail('READER_CHECKPOINT_CAPACITY');
      pages.push(page);
    }
    page.bytes += growth(page); page.value.records.push(record); if (unit) page.value.units.push(unit);
  };
  const units = new Map(value.units.map(unit => [unit.recordId, unit]));
  for (const record of value.records) append(record, units.get(record.id));
  return { pages, append };
}
