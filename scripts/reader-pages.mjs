import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateReaderCheckpoint, MAX_READER_CHECKPOINT_BYTES, checkpointPageBuilder, READER_PAGE_BYTES } from './reader-checkpoint.mjs';
import { intakePath, intakeSnapshot, intakeSnapshotBatch, intakeJSON, assertIntakeTransaction, guardStore, replaceIntakeJSON, writeIntakePageBatch } from './intake-io.mjs';
import { lstatOrNull, sameFileIdentity, syncDirectory } from './file-io.mjs';
import { checkWorkflowBudget, workflowTimeout } from './workflow-budget.mjs';
import { keys, integer, hash, nativeId, string, choice, canonicalJSON, digest, fail } from './workflow-values.mjs';

export { READER_PAGE_BYTES };
export const READER_ALLOCATION_BYTES = 256 * 1024 * 1024;
export const READER_ALLOCATION_PAGES = 4096;
const hydratedRoots = new WeakMap();
const binding = value => ({ reader: value.reader, client: value.client, sessionId: value.sessionId,
  scopeId: value.scopeId, sourceIdentity: value.sourceIdentity });
const basePath = root => `reader-pages/${root.client}/${root.sessionId}/${root.scopeId}`;
const pagePath = (root, page) => `${basePath(root)}/${page.index.toString(16).padStart(2, '0')}-${page.hash.slice(0, 20)}/page.json`;
const inline = (root, records, units) => ({ format: 'cuefluent-reader-checkpoint', version: 1,
  ...binding(root), offset: root.offset, records, units });
function validateAllocation(quota, expected) {
  keys(quota, ['version', 'reader', 'client', 'sessionId', 'scopeId', 'sourceIdentity', 'bytes', 'pages']);
  string(quota.reader, 128); integer(quota.bytes); integer(quota.pages);
  if (quota.version !== 1 || canonicalJSON(binding(quota)) !== canonicalJSON(binding(expected))) fail('READER_PAGE_CONFLICT');
}

/** Read counters after the caller's checkpoint read, without hydrating pages or taking a lock. */
export async function readReaderAllocation(store, { client, sessionId, scopeId, sourceIdentity }, checkpointRoot = null) {
  choice(client, ['claude']); nativeId(sessionId); nativeId(scopeId); hash(sourceIdentity);
  if (checkpointRoot !== null) validateStoredCheckpoint(checkpointRoot, { identity: { client, sessionId }, scopeId, sourceIdentity });
  const referencedPages = checkpointRoot?.version === 2 ? checkpointRoot.pages : [];
  const checkpoint = { referencedPages: referencedPages.length, referencedBytes: referencedPages.reduce((sum, page) => sum + page.bytes, 0) };
  const expected = { client, sessionId, scopeId, sourceIdentity };
  const snapshot = await intakeSnapshot(store, 'state', `${basePath(expected)}/allocation.json`);
  let quota;
  try {
    quota = intakeJSON(snapshot);
    if (quota === null) {
      if (snapshot.bytes !== null || checkpoint.referencedPages) fail('READER_ALLOCATION_INCONSISTENT');
      quota = { bytes: 0, pages: 0 };
    } else {
      validateAllocation(quota, { reader: checkpointRoot?.reader ?? quota.reader, ...expected });
      if (quota.bytes > READER_ALLOCATION_BYTES || quota.pages > READER_ALLOCATION_PAGES ||
          quota.bytes < checkpoint.referencedBytes || quota.pages < checkpoint.referencedPages) fail('READER_ALLOCATION_INCONSISTENT');
    }
  } catch { fail('READER_ALLOCATION_INCONSISTENT'); }
  const measurement = (reserved, limit) => ({ reserved, limit, remaining: limit - reserved });
  const bytes = measurement(quota.bytes, READER_ALLOCATION_BYTES), pages = measurement(quota.pages, READER_ALLOCATION_PAGES);
  return { scopeId, status: [bytes, pages].some(item => item.remaining === 0) ? 'exhausted'
    : [bytes, pages].some(item => item.reserved >= Math.ceil(item.limit * 0.8)) ? 'low-headroom' : 'ok', bytes, pages, checkpoint };
}

export function validateStoredCheckpoint(value, expected) {
  if (value?.client === 'codex') return validateReaderCheckpoint(value, expected);
  if (value?.version !== 2) fail('INVALID_READER_CHECKPOINT');
  keys(value, ['format', 'version', 'reader', 'client', 'sessionId', 'scopeId', 'sourceIdentity', 'offset', 'pages', 'recordCount', 'unitCount']);
  if (value.format !== 'cuefluent-reader-checkpoint' || value.client !== 'claude') fail('INVALID_READER_CHECKPOINT');
  validateReaderCheckpoint(inline(value, [], []), expected);
  integer(value.recordCount); integer(value.unitCount);
  if (value.recordCount > 32768 || value.unitCount > 8192 || !Array.isArray(value.pages) || value.pages.length > 16) fail('READER_CHECKPOINT_CAPACITY');
  let index = 0, bytes = 0, records = 0, units = 0;
  for (const page of value.pages) {
    keys(page, ['index', 'hash', 'bytes', 'recordCount', 'unitCount']);
    if (page.index !== index++) fail('INVALID_READER_CHECKPOINT');
    hash(page.hash); integer(page.bytes); integer(page.recordCount); integer(page.unitCount);
    if (!page.bytes || page.bytes > READER_PAGE_BYTES || !page.recordCount && !page.unitCount) fail('INVALID_READER_CHECKPOINT');
    bytes += page.bytes; records += page.recordCount; units += page.unitCount;
  }
  if (bytes > MAX_READER_CHECKPOINT_BYTES || records !== value.recordCount || units !== value.unitCount) fail('INVALID_READER_CHECKPOINT');
  return value;
}

/** Deterministic content only: allocations and retries never enter identity. */
export function planReaderCheckpoint(value) {
  if (value === null || value.client !== 'claude') return { root: value, pages: [] };
  validateReaderCheckpoint(value);
  const pages = checkpointPageBuilder(value).pages.map(({ value: page, bytes: expectedBytes }) => {
    const bytes = Buffer.from(canonicalJSON(page) + '\n');
    if (bytes.length !== expectedBytes || bytes.length > READER_PAGE_BYTES) fail('READER_CHECKPOINT_CAPACITY');
    return { bytes, descriptor: { index: page.index, hash: digest(bytes), bytes: bytes.length, recordCount: page.records.length, unitCount: page.units.length } };
  });
  const root = { format: 'cuefluent-reader-checkpoint', version: 2, ...binding(value), offset: value.offset,
    pages: pages.map(page => page.descriptor), recordCount: value.records.length, unitCount: value.units.length };
  validateStoredCheckpoint(root); return { root, pages };
}

export async function hydrateReaderCheckpoint(store, root) {
  if (root === null) return null;
  validateStoredCheckpoint(root);
  if (root.client === 'codex') return root;
  const snapshots = await intakeSnapshotBatch(store, root.pages.map(page => pagePath(root, page)), { maxBytes: READER_PAGE_BYTES });
  for (let i = 0; i < root.pages.length; i++) {
    if (snapshots[i].hash !== root.pages[i].hash || snapshots[i].bytes?.length !== root.pages[i].bytes) fail('READER_PAGE_CONFLICT');
  }
  const key = digest(canonicalJSON(root)), cache = hydratedRoots.get(store) ?? new Map();
  hydratedRoots.set(store, cache);
  if (cache.has(key)) return structuredClone(cache.get(key));
  const records = [], units = [];
  for (let i = 0; i < root.pages.length; i++) {
    const expected = root.pages[i], snapshot = snapshots[i];
    if (snapshot.hash !== expected.hash || snapshot.bytes?.length !== expected.bytes) fail('READER_PAGE_CONFLICT');
    const page = intakeJSON(snapshot);
    keys(page, ['format', 'version', 'reader', 'client', 'sessionId', 'scopeId', 'sourceIdentity', 'index', 'records', 'units']);
    if (page.format !== 'cuefluent-reader-page' || page.version !== 1 || canonicalJSON(binding(page)) !== canonicalJSON(binding(root)) ||
        page.index !== expected.index || !Array.isArray(page.records) || !Array.isArray(page.units) ||
        page.records.length !== expected.recordCount || page.units.length !== expected.unitCount) fail('READER_PAGE_CONFLICT');
    records.push(...page.records); units.push(...page.units);
  }
  records.sort((a, b) => a.startByte - b.startByte);
  const order = new Map(records.map(row => [row.id, row.startByte]));
  units.sort((a, b) => order.get(a.recordId) - order.get(b.recordId));
  const value = inline(root, records, units);
  validateReaderCheckpoint(value);
  if (canonicalJSON(planReaderCheckpoint(value).root) !== canonicalJSON(root)) fail('READER_PAGE_CONFLICT');
  cache.set(key, structuredClone(value));
  while (cache.size > 2) cache.delete(cache.keys().next().value);
  return value;
}

/** Only complete authenticated page directories can become reachable. Interrupted
 * random stages remain charged and inert; a fresh paid attempt can recover. */
export async function publishReaderPages(transaction, value) {
  const { root, pages } = planReaderCheckpoint(value);
  if (!pages.length) return root;
  const store = await assertIntakeTransaction(transaction);
  const snapshots = await intakeSnapshotBatch(store, pages.map(page => pagePath(root, page.descriptor)), { maxBytes: READER_PAGE_BYTES });
  const missing = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i], snapshot = snapshots[i];
    if (snapshot.bytes) {
      if (!snapshot.bytes.equals(page.bytes)) fail('READER_PAGE_CONFLICT');
    } else {
      const destination = await intakePath(store, 'state', pagePath(root, page.descriptor));
      if (await lstatOrNull(path.dirname(destination))) fail('READER_PAGE_CONFLICT');
      missing.push(page);
    }
  }
  if (!missing.length) return root;
  const quotaName = `${basePath(root)}/allocation.json`, snapshot = await intakeSnapshot(store, 'state', quotaName);
  const quota = intakeJSON(snapshot) ?? { version: 1, ...binding(root), bytes: 0, pages: 0 };
  validateAllocation(quota, root);
  quota.bytes += missing.reduce((sum, page) => sum + page.bytes.length, 0); quota.pages += missing.length;
  if (quota.bytes > READER_ALLOCATION_BYTES || quota.pages > READER_ALLOCATION_PAGES) fail('READER_CHECKPOINT_ALLOCATION_CAPACITY');
  checkWorkflowBudget();
  if (workflowTimeout() < 1000) fail('WORKER_TIME_BUDGET');
  await replaceIntakeJSON(transaction, quotaName, quota, snapshot.hash);
  const reservation = randomUUID();
  const stages = await writeIntakePageBatch(transaction, missing.map(page => ({ bytes: page.bytes,
    name: `${basePath(root)}/.stage-${reservation}-${page.descriptor.index}/page.json` })));
  const completed = await intakeSnapshotBatch(store, stages.map(stage => stage.name), { maxBytes: READER_PAGE_BYTES, cache: false });
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i], page = missing[i];
    const read = completed[i];
    if (!sameFileIdentity(stage.identity, read.identity) || !read.bytes?.equals(page.bytes)) fail('READER_PAGE_CONFLICT');
    const destination = await intakePath(store, 'state', pagePath(root, page.descriptor));
    await assertIntakeTransaction(transaction); await guardStore(store, [stage.file, destination]);
    const current = await fs.lstat(stage.file, { bigint: true });
    if (!sameFileIdentity(read.identity, current) || current.nlink !== 1n || current.size !== read.identity.size || current.mtimeNs !== read.identity.mtimeNs || current.ctimeNs !== read.identity.ctimeNs) fail('READER_PAGE_CONFLICT');
    if (await lstatOrNull(path.dirname(destination))) fail('READER_PAGE_CONFLICT');
    // Nonempty destinations cannot be replaced. As with metadata CAS, POSIX
    // can replace a race-created empty directory; no existing file is replaced.
    await fs.rename(path.dirname(stage.file), path.dirname(destination));
    await syncDirectory(path.dirname(path.dirname(destination)));
  }
  await hydrateReaderCheckpoint(store, root); return root;
}
