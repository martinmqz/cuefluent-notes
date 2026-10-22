import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import {
  assertChain, assertDirectory, assertRegularFile, createPrivateDirectory,
  inspectParent, lstatOrNull, pinDirectory, relativePath, sameIdentity,
} from './paths.mjs';
import { hashBytes, jsonBytes, readJSON, readSnapshot, removeExact, syncDirectory, writeJSON } from './files.mjs';
import { establishWindowsPrivacy } from './platform.mjs';
import { readHandleStat } from './stat.mjs';
import {
  assertHash, assertId, decodeRecord, inputRecord, MAX_QUEUE_RECORD_BYTES,
  MAX_QUEUE_SELECTION_BYTES, MAX_QUEUE_SELECTION_RECORDS,
} from './queue-format.mjs';
export { encodeQueueRecord, MAX_QUEUE_RECORD_BYTES, MAX_QUEUE_SELECTION_BYTES, MAX_QUEUE_SELECTION_RECORDS } from './queue-format.mjs';

const METADATA_BYTES = 64 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDLE = Object.freeze({ schema: 1, op: null });
const keyFor = id => hashBytes(Buffer.from(id));
const partPath = key => `parts/${key}.jsonl`;
const nodePath = key => `links/${key}.json`;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function shape(value, required, optional = [], code = 'QUEUE_METADATA_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code, 'Queue metadata must be a plain data object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(descriptors).some(name => !allowed.has(name) || !Object.hasOwn(descriptors[name], 'value') || !descriptors[name].enumerable) ||
      required.some(name => !Object.hasOwn(descriptors, name))) {
    fail(code, 'Queue metadata contains missing, unsupported, or non-data properties.');
  }
}
function idle(value) {
  shape(value, ['schema', 'op'], ['parked']);
  if (value.schema !== 1 || value.op !== null) fail('QUEUE_INTENT_INVALID', 'Queue mutation journal is not idle.');
  if (value.parked !== undefined) validateParked(value.parked);
}
function validateRecordInfo(record) {
  shape(record, ['id', 'hash', 'key', 'bytesHash', 'length'], [], 'QUEUE_INTENT_INVALID');
  assertId(record.id); assertHash(record.hash); assertHash(record.bytesHash); assertHash(record.key); count(record.length);
  if (record.key !== keyFor(record.id) || record.length < 1 || record.length > MAX_QUEUE_RECORD_BYTES) fail('QUEUE_INTENT_INVALID', 'Mutation intent has an invalid record segment.');
}
function validateParked(value) {
  shape(value, ['schema', 'queueId', 'transactionId', 'record'], [], 'QUEUE_INTENT_INVALID');
  if (value.schema !== 1) fail('QUEUE_INTENT_INVALID', 'Unsupported parked append.');
  uuid(value.queueId); uuid(value.transactionId); validateRecordInfo(value.record);
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('QUEUE_METADATA_INVALID', 'Queue metadata has an invalid transaction identity.');
}
function key(value) { if (value !== null) assertHash(value); }
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('QUEUE_METADATA_INVALID', 'Queue metadata has an invalid count or position.');
}
function validateState(value) {
  shape(value, ['schema', 'queueId', 'generation', 'head', 'tail', 'count']);
  if (!value || value.schema !== 1) fail('QUEUE_METADATA_INVALID', 'Unsupported queue manifest.');
  uuid(value.queueId); uuid(value.generation); count(value.count); key(value.head); key(value.tail);
  if ((value.count === 0) !== (value.head === null && value.tail === null) ||
      (value.count > 0 && (value.head === null || value.tail === null)) ||
      (value.count === 1 && value.head !== value.tail) || (value.count > 1 && value.head === value.tail)) {
    fail('QUEUE_METADATA_INVALID', 'Queue head, tail, and count disagree.');
  }
  return value;
}
function validateNode(value, expectedKey, queueId) {
  shape(value, ['schema', 'queueId', 'id', 'hash', 'prev', 'next']);
  if (!value || value.schema !== 1 || value.queueId !== queueId) fail('QUEUE_METADATA_INVALID', 'Queue link belongs to another collection.');
  assertId(value.id); assertHash(value.hash); key(value.prev); key(value.next);
  if (keyFor(value.id) !== expectedKey || value.prev === expectedKey || value.next === expectedKey) {
    fail('QUEUE_METADATA_INVALID', 'Queue link identity or adjacency is invalid.');
  }
  return value;
}

async function root(pin, relative, create = false) {
  if (pin?.private !== true) fail('QUEUE_PRIVATE_ROOT_REQUIRED', 'Queues require a verified private storage root.');
  const parent = await inspectParent(pin, relative);
  const stat = await lstatOrNull(parent.file);
  if (!stat && !create) return null;
  let result;
  if (create) {
    result = await createPrivateDirectory(parent.file);
    await createPrivateDirectory(path.join(parent.file, 'parts'));
    await createPrivateDirectory(path.join(parent.file, 'links'));
  } else {
    result = await pinDirectory(parent.file, { private: true });
    await pinDirectory(path.join(parent.file, 'parts'), { private: true });
    await pinDirectory(path.join(parent.file, 'links'), { private: true });
  }
  await assertChain(parent.chain);
  await assertDirectory(pin);
  if (create) {
    await syncDirectory(result.root);
    await syncDirectory(path.dirname(result.root));
    await assertDirectory(result);
    await assertDirectory(pin);
  }
  return result;
}
async function metadata(pin, relative, missing = false) {
  return readJSON(pin, relative, { maxBytes: METADATA_BYTES, missing });
}
async function state(pin, create = false) {
  let snapshot;
  try { snapshot = await metadata(pin, 'state.json', true); }
  catch (error) {
    if (!create || error.code !== 'JSON_INVALID') throw error;
    await completeMetadata(pin, 'state.json', initialState(pin));
    snapshot = await metadata(pin, 'state.json');
  }
  if (!snapshot && create) {
    await completeMetadata(pin, 'state.json', initialState(pin));
    snapshot = await metadata(pin, 'state.json');
  }
  if (!snapshot) fail('QUEUE_UNINITIALIZED', 'Queue setup was interrupted before its manifest was published.');
  validateState(snapshot.value);
  return snapshot;
}
function initialState(pin) {
  const digest = hashBytes(Buffer.from(JSON.stringify(pin.chain.at(-1))));
  const queueId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return { schema: 1, queueId, generation: queueId, head: null, tail: null, count: 0 };
}
async function ensureJournal(pin, current) {
  try {
    const observed = await metadata(pin, 'intent.json', true);
    if (observed) {
      if (observed.value?.schema === 1 && observed.value.op === null) { idle(observed.value); return; }
      validateIntent(observed.value);
      return;
    }
  } catch (error) { if (error.code !== 'JSON_INVALID') throw error; }
  if (!equal(current.value, initialState(pin))) fail('QUEUE_INTENT_INVALID', 'An established queue has no valid mutation journal.');
  await completeMetadata(pin, 'intent.json', IDLE);
}
async function node(pin, id, queueId, missing = false) {
  const snapshot = await metadata(pin, nodePath(id), missing);
  if (snapshot) validateNode(snapshot.value, id, queueId);
  return snapshot;
}
function nodeSnapshot(key, snapshot) { return { key, value: snapshot.value, hash: snapshot.hash }; }

function validateIntent(value) {
  const common = ['schema', 'op', 'tx', 'queueId', 'before', 'record', 'neighbors'];
  shape(value, common, ['node', 'context', 'index', 'parked'], 'QUEUE_INTENT_INVALID');
  if (!value || value.schema !== 1 || !['append', 'remove'].includes(value.op)) fail('QUEUE_INTENT_INVALID', 'Unsupported queue mutation intent.');
  shape(value, value.op === 'append' ? common : [...common, 'node', 'context', 'index'], value.op === 'remove' ? ['parked'] : [], 'QUEUE_INTENT_INVALID');
  shape(value.before, ['value', 'hash'], [], 'QUEUE_INTENT_INVALID');
  uuid(value.tx); uuid(value.queueId);
  const before = validateState(value.before?.value);
  assertHash(value.before.hash);
  if (before.queueId !== value.queueId) fail('QUEUE_INTENT_INVALID', 'Mutation intent belongs to another queue.');
  const record = value.record;
  validateRecordInfo(record);
  if (value.parked !== undefined) {
    validateParked(value.parked);
    if (value.parked.queueId !== value.queueId || value.parked.record.key === record.key) fail('QUEUE_INTENT_INVALID', 'Cleanup intent has an inconsistent parked candidate.');
  }
  if (!Array.isArray(value.neighbors) || value.neighbors.length > 2) fail('QUEUE_INTENT_INVALID', 'Mutation intent exceeds its bounded neighbor set.');
  const neighbors = new Map();
  for (const item of value.neighbors) {
    shape(item, ['key', 'value', 'hash'], [], 'QUEUE_INTENT_INVALID');
    assertHash(item.key); assertHash(item.hash); validateNode(item.value, item.key, value.queueId);
    if (neighbors.has(item.key) || item.key === record.key) fail('QUEUE_INTENT_INVALID', 'Mutation intent repeats a queue link.');
    neighbors.set(item.key, item);
  }
  if (value.op === 'append') {
    if (before.count === Number.MAX_SAFE_INTEGER || record.key === before.head || record.key === before.tail ||
        neighbors.size !== (before.tail === null ? 0 : 1)) fail('QUEUE_INTENT_INVALID', 'Append intent is inconsistent with its manifest.');
    const tail = neighbors.get(before.tail);
    if (before.tail !== null && (!tail || tail.value.next !== null)) fail('QUEUE_INTENT_INVALID', 'Append intent has no exact tail link.');
  } else {
    shape(value.node, ['value', 'hash'], [], 'QUEUE_INTENT_INVALID');
    assertHash(value.context); count(value.index);
    assertHash(value.node?.hash);
    const removed = validateNode(value.node?.value, record.key, value.queueId);
    if (!before.count || removed.id !== record.id || removed.hash !== record.hash ||
        neighbors.size !== Number(removed.prev !== null) + Number(removed.next !== null) ||
        (removed.prev === null ? before.head !== record.key : neighbors.get(removed.prev)?.value.next !== record.key) ||
        (removed.next === null ? before.tail !== record.key : neighbors.get(removed.next)?.value.prev !== record.key)) {
      fail('QUEUE_INTENT_INVALID', 'Cleanup intent has inconsistent selected links.');
    }
  }
  return value;
}
async function intent(pin) {
  const snapshot = await metadata(pin, 'intent.json');
  if (snapshot.value?.schema === 1 && snapshot.value.op === null) { idle(snapshot.value); return null; }
  validateIntent(snapshot.value);
  return snapshot;
}
async function putIntent(pin, value) {
  const before = await metadata(pin, 'intent.json');
  idle(before.value);
  const parked = before.value.parked;
  if (parked) {
    if (value.op === 'append' ? !equal(value.record, parked.record) : !equal(value.parked, parked)) {
      fail('QUEUE_INTENT_INVALID', 'New mutation must preserve the exact parked append.');
    }
  } else if (value.parked !== undefined) fail('QUEUE_INTENT_INVALID', 'New mutation cannot invent a parked append.');
  if (before.value?.schema !== 1 || before.value.op !== null) fail('QUEUE_RECOVERY_REQUIRED', 'Another queue mutation is pending.');
  await writeJSON(pin, 'intent.json', value, { expectedHash: before.hash, maxBytes: METADATA_BYTES });
}
function after(intent) {
  const value = intent.before.value;
  const record = intent.record;
  if (intent.op === 'append') {
    const added = { schema: 1, queueId: intent.queueId, id: record.id, hash: record.hash, prev: value.tail, next: null };
    return {
      state: { ...value, generation: intent.tx, head: value.head ?? record.key, tail: record.key, count: value.count + 1 },
      links: [
        { key: record.key, expectedHash: null, value: added },
        ...intent.neighbors.map(item => ({ key: item.key, expectedHash: item.hash, value: { ...item.value, next: record.key } })),
      ],
    };
  }
  const removed = intent.node.value;
  return {
    state: { ...value, generation: intent.tx, head: removed.prev === null ? removed.next : value.head,
      tail: removed.next === null ? removed.prev : value.tail, count: value.count - 1 },
    links: intent.neighbors.map(item => ({ key: item.key, expectedHash: item.hash,
      value: item.key === removed.prev ? { ...item.value, next: removed.next } : { ...item.value, prev: removed.prev } })),
  };
}
async function applyJSON(pin, relative, expectedHash, next) {
  const current = await readSnapshot(pin, relative, { missing: true, maxBytes: METADATA_BYTES });
  const proposedHash = hashBytes(jsonBytes(next));
  if (current?.hash === proposedHash) return;
  if (expectedHash === null) {
    await completeMetadata(pin, relative, next);
    return;
  }
  if ((current?.hash ?? null) !== expectedHash) fail('QUEUE_CONFLICT', 'Queue metadata changed after the exact mutation was prepared.');
  await writeJSON(pin, relative, next, { expectedHash, maxBytes: METADATA_BYTES });
}
async function publish(pin, pending) {
  const next = after(pending.value);
  for (const step of next.links) await applyJSON(pin, nodePath(step.key), step.expectedHash, step.value);
  await applyJSON(pin, 'state.json', pending.value.before.hash, next.state);
  return next.state;
}
async function clearIntent(pin, pending) {
  const next = pending.value.parked ? { ...IDLE, parked: pending.value.parked } : IDLE;
  await writeJSON(pin, 'intent.json', next, { expectedHash: pending.hash, maxBytes: METADATA_BYTES });
}
function recordInfo(record) {
  return { id: record.id, hash: record.hash, key: keyFor(record.id), bytesHash: hashBytes(record.bytes), length: record.bytes.length };
}
function verifyRecord(snapshot, info) {
  if (!snapshot || snapshot.hash !== info.bytesHash || snapshot.bytes.length !== info.length) {
    fail('QUEUE_RECORD_CONFLICT', 'Record segment differs from the exact pending mutation.');
  }
  const value = decodeRecord(snapshot.bytes, 0);
  if (value.id !== info.id || value.hash !== info.hash) fail('QUEUE_RECORD_CONFLICT', 'Record segment identity differs from its live lookup.');
  return value;
}
async function readPart(pin, info, missing = false) {
  return readSnapshot(pin, partPath(info.key), { maxBytes: MAX_QUEUE_RECORD_BYTES, missing });
}
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) fail('QUEUE_WRITE_FAILED', 'Queue append made no progress; its source checkpoint must not advance.');
    offset += bytesWritten;
  }
}

async function finishFile(pin, relative, bytes, current, maxBytes) {
  const parent = await inspectParent(pin, relative);
  const handle = await fs.open(parent.file, constants.O_RDWR | constants.O_APPEND | NO_FOLLOW |
    (current ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    if (!current) establishWindowsPrivacy(parent.file);
    const observed = await readHandleStat(handle);
    assertRegularFile(parent.file, observed, pin);
    if ((current && !sameIdentity(observed, current.identity)) || observed.size !== (current?.bytes.length ?? 0)) {
      fail('QUEUE_CHANGED', 'A pending file changed while opening it.');
    }
    await assertChain(parent.chain);
    await assertDirectory(pin);
    await writeAll(handle, bytes.subarray(current?.bytes.length ?? 0));
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(path.dirname(parent.file));
  const published = await readSnapshot(pin, relative, { maxBytes });
  if (!published.bytes.equals(bytes)) fail('QUEUE_CONFLICT', 'A pending file differs from its exact publication bytes.');
}

async function completeMetadata(pin, relative, value) {
  const bytes = jsonBytes(value);
  const current = await readSnapshot(pin, relative, { missing: true, maxBytes: METADATA_BYTES });
  if (current && (current.bytes.length > bytes.length || !bytes.subarray(0, current.bytes.length).equals(current.bytes))) {
    fail('QUEUE_CONFLICT', 'Interrupted metadata does not match its authoritative mutation intent.');
  }
  await finishFile(pin, relative, bytes, current, METADATA_BYTES);
}

async function durablePart(pin, info, record, expectedTailHash) {
  const current = await readPart(pin, info, true);
  let suffix = null;
  if (current) {
    if (current.hash === info.bytesHash && current.bytes.length === info.length) verifyRecord(current, info);
    else {
      // A newline-complete malformed segment is never a repairable torn write.
      if (current.bytes.includes(10)) {
        decodeRecord(current.bytes, 0);
        fail('QUEUE_RECORD_CONFLICT', 'A complete segment does not match its pending intent.');
      }
      if (!record || expectedTailHash === undefined) fail('QUEUE_TORN_TAIL', 'A pending segment requires explicit native-source reconstruction.');
      assertHash(expectedTailHash);
      if (current.hash !== expectedTailHash) fail('QUEUE_TAIL_CHANGED', 'Pending segment differs from its inspected tail hash.');
      if (current.bytes.length >= record.bytes.length || !record.bytes.subarray(0, current.bytes.length).equals(current.bytes)) {
        fail('QUEUE_TAIL_MISMATCH', 'Reread native-source bytes do not reconstruct the retained segment.');
      }
      suffix = record.bytes.subarray(current.bytes.length);
    }
  } else {
    if (!record) fail('QUEUE_RECOVERY_REQUIRED', 'Pending append needs its exact source record before it can be published.');
    suffix = record.bytes;
  }
  const bytes = suffix ? Buffer.concat([current?.bytes ?? Buffer.alloc(0), suffix]) : current.bytes;
  await finishFile(pin, partPath(info.key), bytes, current, MAX_QUEUE_RECORD_BYTES);
  verifyRecord(await readPart(pin, info), info);
}
async function resumeAppend(pin, pending, record, expectedTailHash) {
  if (pending.value.op !== 'append') fail('QUEUE_CLEANUP_PENDING', 'Completed or interrupted cleanup must be resumed and acknowledged first.');
  if (record && !equal(recordInfo(record), pending.value.record)) fail('QUEUE_ID_CONFLICT', 'Reread append differs from its exact pending intent.');
  await durablePart(pin, pending.value.record, record, expectedTailHash);
  await publish(pin, pending);
  await clearIntent(pin, pending);
}
async function parkedCandidate(pin, queueId) {
  const journal = await metadata(pin, 'intent.json');
  if (journal.value.op !== null) return null;
  idle(journal.value);
  const parked = journal.value.parked;
  if (parked && parked.queueId !== queueId) fail('QUEUE_INTENT_INVALID', 'Parked append belongs to another queue.');
  return parked ?? null;
}
async function newAppend(pin, current, info) {
  const neighbors = [];
  if (current.value.tail) neighbors.push(nodeSnapshot(current.value.tail, await node(pin, current.value.tail, current.value.queueId)));
  const proposal = { schema: 1, op: 'append', tx: randomUUID(), queueId: current.value.queueId,
    before: { value: current.value, hash: current.hash }, record: info, neighbors };
  validateIntent(proposal);
  await putIntent(pin, proposal);
  return intent(pin);
}
async function resumeParked(pin, current, parked, record, expectedTailHash) {
  if (record && !equal(recordInfo(record), parked.record)) fail('QUEUE_ID_CONFLICT', 'Reread append differs from its exact parked candidate.');
  if (await node(pin, parked.record.key, current.value.queueId, true)) fail('QUEUE_CONFLICT', 'Parked append unexpectedly has a published link.');
  const part = await readPart(pin, parked.record, true);
  const complete = part?.hash === parked.record.bytesHash && part.bytes.length === parked.record.length;
  if (!complete && !record) fail('QUEUE_RECOVERY_REQUIRED', 'Parked append needs its exact native-source record.');
  if (!complete && part && expectedTailHash === undefined) fail('QUEUE_TORN_TAIL', 'Parked segment requires the exact inspected tail hash and native reconstruction.');
  if (part && !complete) {
    assertHash(expectedTailHash);
    if (part.hash !== expectedTailHash) fail('QUEUE_TAIL_CHANGED', 'Parked segment differs from its inspected tail.');
    if (part.bytes.length >= record.bytes.length || !record.bytes.subarray(0, part.bytes.length).equals(part.bytes)) fail('QUEUE_TAIL_MISMATCH', 'Native bytes do not reconstruct the parked segment.');
  }
  await resumeAppend(pin, await newAppend(pin, current, parked.record), record, expectedTailHash);
}

/** Park only a proven unapplied append, so missing native input cannot reserve cleanup. */
async function makeCleanupAvailable(pin, pending) {
  const value = pending.value;
  if (value.op !== 'append') return;
  const current = await state(pin);
  let unapplied = current.hash === value.before.hash;
  for (const step of after(value).links) {
    const observed = await readSnapshot(pin, nodePath(step.key), { missing: true, maxBytes: METADATA_BYTES });
    if ((observed?.hash ?? null) !== step.expectedHash) unapplied = false;
  }
  if (!unapplied) {
    // Metadata publication happens only after the exact complete segment flush.
    // This can finish without the native transcript; malformed state still fails.
    await resumeAppend(pin, pending);
    return;
  }
  const parked = { schema: 1, queueId: value.queueId, transactionId: value.tx, record: value.record };
  await writeJSON(pin, 'intent.json', { ...IDLE, parked }, { expectedHash: pending.hash, maxBytes: METADATA_BYTES });
}

/** One JSONL record per segment: direct ID lookup and fixed-size mutation work. */
export async function appendQueueRecord(pin, relative, value) {
  const record = inputRecord(value);
  const queue = await root(pin, relative, true);
  let current = await state(queue, true);
  await ensureJournal(queue, current);
  const pending = await intent(queue);
  if (pending) {
    await resumeAppend(queue, pending, pending.value.record.id === record.id ? record : undefined);
    current = await state(queue);
  }
  const info = recordInfo(record);
  const parked = await parkedCandidate(queue, current.value.queueId);
  if (parked) {
    if (parked.record.id !== record.id) fail('QUEUE_APPEND_PARKED', 'An earlier uncommitted source record must be reconstructed first.');
    await resumeParked(queue, current, parked, record);
    return { appended: false, id: record.id, hash: record.hash };
  }
  const existing = await readPart(queue, info, true);
  const link = await node(queue, info.key, current.value.queueId, true);
  if (existing || link) {
    if (!existing || !link || link.value.id !== record.id || link.value.hash !== record.hash) {
      fail('QUEUE_ID_CONFLICT', 'Live queue identity has missing or different record data.');
    }
    verifyRecord(existing, info);
    await durablePart(queue, info);
    return { appended: false, id: record.id, hash: record.hash };
  }
  await resumeAppend(queue, await newAppend(queue, current, info), record);
  return { appended: true, id: record.id, hash: record.hash };
}

/** Explicit native-source recovery; expectedTailHash authorizes only exact suffix repair. */
export async function recoverQueueAppend(pin, relative, { record: value, expectedTailHash } = {}) {
  const record = value === undefined ? undefined : inputRecord(value);
  const queue = await root(pin, relative);
  if (!queue) return { recovered: false };
  const pending = await intent(queue);
  if (!pending) {
    const current = await state(queue);
    const parked = await parkedCandidate(queue, current.value.queueId);
    if (!parked) return { recovered: false };
    await resumeParked(queue, current, parked, record, expectedTailHash);
    return { recovered: true, id: parked.record.id, hash: parked.record.hash };
  }
  await resumeAppend(queue, pending, record, expectedTailHash);
  return { recovered: true, id: pending.value.record.id, hash: pending.value.record.hash };
}

/** Bounded manifest/pending inspection, without scanning or mutating the backlog. */
export async function inspectQueue(pin, relative) {
  const queue = await root(pin, relative);
  if (!queue) return { exists: false, records: 0, pending: null };
  const current = await state(queue);
  const pending = await intent(queue);
  let mutation = null;
  const parked = !pending ? await parkedCandidate(queue, current.value.queueId) : null;
  if (parked) {
    const part = await readPart(queue, parked.record, true);
    mutation = { op: 'append', parked: true, id: parked.record.id, hash: parked.record.hash, transactionId: parked.transactionId,
      part: part ? { length: part.bytes.length, hash: part.hash,
        complete: part.hash === parked.record.bytesHash && part.bytes.length === parked.record.length } : null };
  }
  if (pending) {
    const value = pending.value;
    mutation = { op: value.op, id: value.record.id, hash: value.record.hash, transactionId: value.tx };
    if (value.op === 'append') {
      const part = await readPart(queue, value.record, true);
      mutation.part = part ? { length: part.bytes.length, hash: part.hash,
        complete: part.hash === value.record.bytesHash && part.bytes.length === value.record.length } : null;
    } else mutation.cursor = tokenFor(value);
  }
  return { exists: true, queueId: current.value.queueId, records: current.value.count,
    head: current.value.head, tail: current.value.tail, pending: mutation };
}

async function pendingAppendView(pin, pending, current) {
  const proposed = after(pending.value);
  const afterHash = hashBytes(jsonBytes(proposed.state));
  if (![pending.value.before.hash, afterHash].includes(current.hash)) fail('QUEUE_CONFLICT', 'Pending append manifest differs from both exact transaction states.');
  for (const step of proposed.links) {
    const actual = await readSnapshot(pin, nodePath(step.key), { missing: true, maxBytes: METADATA_BYTES });
    const bytes = jsonBytes(step.value);
    if (actual?.hash === hashBytes(bytes)) continue;
    if (current.hash === afterHash) fail('QUEUE_CONFLICT', 'Published append metadata is incomplete.');
    if (step.expectedHash !== null && actual?.hash === step.expectedHash) continue;
    if (step.expectedHash === null && (!actual || (actual.bytes.length < bytes.length && bytes.subarray(0, actual.bytes.length).equals(actual.bytes)))) continue;
    fail('QUEUE_CONFLICT', 'Pending append link differs from its exact old and proposed metadata.');
  }
  return { value: pending.value.before.value, hash: pending.value.before.hash };
}

/** Each yielded record uses bounded I/O. Callers holding a gate must set a limit. */
export async function* iterateQueue(pin, relative, { limit = Infinity, allowPendingAppend = false } = {}) {
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) fail('QUEUE_LIMIT_INVALID', 'Queue iteration limit must be a positive integer.');
  const queue = await root(pin, relative);
  if (!queue) return;
  if (typeof allowPendingAppend !== 'boolean') fail('QUEUE_LIMIT_INVALID', 'Pending-append selection must be explicitly enabled.');
  const pending = await intent(queue);
  if (pending && (!allowPendingAppend || pending.value.op !== 'append')) fail('QUEUE_RECOVERY_REQUIRED', 'Pending queue mutation must be recovered before selection.');
  const physical = await state(queue);
  const current = pending ? await pendingAppendView(queue, pending, physical) : physical;
  let cursor = current.value.head;
  let previous = null;
  let records = 0;
  try {
    while (cursor !== null && records < limit) {
      if (records >= current.value.count) fail('QUEUE_METADATA_INVALID', 'Queue links exceed the manifest count.');
      let link = await node(queue, cursor, current.value.queueId);
      if (pending && cursor === current.value.tail) {
        const old = pending.value.neighbors.find(item => item.key === cursor);
        const proposed = after(pending.value).links.find(item => item.key === cursor);
        if (!old || !proposed || ![old.hash, hashBytes(jsonBytes(proposed.value))].includes(link.hash)) fail('QUEUE_CONFLICT', 'The committed prefix tail changed after append preparation.');
        link = old;
      }
      if (link.value.prev !== previous) fail('QUEUE_METADATA_INVALID', 'Queue link order is inconsistent.');
      const snapshot = await readSnapshot(queue, partPath(cursor), { maxBytes: MAX_QUEUE_RECORD_BYTES });
      const record = decodeRecord(snapshot.bytes, 0);
      if (keyFor(record.id) !== cursor || record.id !== link.value.id || record.hash !== link.value.hash) {
        fail('QUEUE_RECORD_CONFLICT', 'Queue segment does not match its ordered live lookup.');
      }
      records++;
      yield record;
      previous = cursor;
      cursor = link.value.next;
    }
    if (cursor === null && (records !== current.value.count || previous !== current.value.tail)) {
      fail('QUEUE_METADATA_INVALID', 'Queue traversal disagrees with its manifest.');
    }
  } finally {
    if ((await state(queue)).hash !== physical.hash || ((await intent(queue))?.hash ?? null) !== (pending?.hash ?? null)) {
      fail('QUEUE_CHANGED', 'Queue changed while its selection was being inspected.');
    }
  }
}

export async function selectQueue(pin, relative, { limit = 100, maxBytes = MAX_QUEUE_SELECTION_BYTES, allowPendingAppend = false } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUEUE_SELECTION_RECORDS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < MAX_QUEUE_RECORD_BYTES || maxBytes > MAX_QUEUE_SELECTION_BYTES) {
    fail('QUEUE_LIMIT_INVALID', 'Queue selection requires bounded record and byte limits.');
  }
  const result = [];
  let bytes = 0;
  for await (const record of iterateQueue(pin, relative, { limit, allowPendingAppend })) {
    if (bytes + record.bytes.length > maxBytes) break;
    bytes += record.bytes.length;
    result.push(record);
  }
  return result;
}

/** Exact direct lookup for an already selected live record; never enumerate. */
export async function readQueueRecord(pin, relative, selected) {
  shape(selected, ['id', 'hash'], [], 'QUEUE_SELECTION_INVALID');
  assertId(selected.id); assertHash(selected.hash);
  const queue = await root(pin, relative);
  if (!queue) fail('QUEUE_SELECTION_MISSING', 'Selected queue record is absent.');
  const pending = await intent(queue);
  if (pending?.value.op === 'remove') fail('QUEUE_RECOVERY_REQUIRED', 'Current cleanup must be acknowledged before reading selected input.');
  const physical = await state(queue);
  const current = pending ? await pendingAppendView(queue, pending, physical) : physical;
  const id = keyFor(selected.id);
  if (!current.value.count || pending?.value.record.key === id) fail('QUEUE_SELECTION_MISSING', 'Selected record is not in the committed queue.');
  let link = await node(queue, id, current.value.queueId, true);
  if (!link) fail('QUEUE_SELECTION_MISSING', 'Selected live lookup is absent.');
  if (pending && id === current.value.tail) link = pending.value.neighbors.find(item => item.key === id);
  if (!link || link.value.id !== selected.id || link.value.hash !== selected.hash) fail('QUEUE_SELECTION_CONFLICT', 'Selected record no longer matches its exact frozen hash.');
  if ((link.value.prev === null && current.value.head !== id) || (link.value.next === null && current.value.tail !== id)) {
    fail('QUEUE_METADATA_INVALID', 'Selected lookup is not linked to this queue.');
  }
  for (const [neighbor, direction] of [[link.value.prev, 'next'], [link.value.next, 'prev']]) {
    if (neighbor !== null && (await node(queue, neighbor, current.value.queueId)).value[direction] !== id) fail('QUEUE_METADATA_INVALID', 'Selected lookup has mismatched live neighbors.');
  }
  const snapshot = await readSnapshot(queue, partPath(id), { maxBytes: MAX_QUEUE_RECORD_BYTES });
  const record = decodeRecord(snapshot.bytes, 0);
  if (record.id !== selected.id || record.hash !== selected.hash) fail('QUEUE_SELECTION_CONFLICT', 'Selected segment no longer matches its frozen data.');
  if ((await state(queue)).hash !== physical.hash || ((await intent(queue))?.hash ?? null) !== (pending?.hash ?? null)) fail('QUEUE_CHANGED', 'Selected record changed while it was read.');
  return record;
}

function tokenFor(value) {
  return Object.freeze({ schema: 1, queueId: value.queueId, transactionId: value.tx,
    context: value.context, index: value.index, id: value.record.id, hash: value.record.hash });
}
export function validateCleanupCursor(value) {
  shape(value, ['schema', 'queueId', 'transactionId', 'context', 'index', 'id', 'hash'], [], 'QUEUE_CURSOR_INVALID');
  if (!value || value.schema !== 1) fail('QUEUE_CURSOR_INVALID', 'Unsupported queue cleanup cursor.');
  uuid(value.queueId); uuid(value.transactionId); assertHash(value.context); count(value.index); assertId(value.id); assertHash(value.hash);
  return Object.freeze({ schema: 1, queueId: value.queueId, transactionId: value.transactionId,
    context: value.context, index: value.index, id: value.id, hash: value.hash });
}
async function removeIfExact(pin, relative, expectedHash, maxBytes) {
  const current = await readSnapshot(pin, relative, { missing: true, maxBytes });
  if (!current) return;
  if (current.hash !== expectedHash) fail('QUEUE_CONFLICT', 'A selected queue segment changed before its exact removal.');
  await removeExact(pin, relative, expectedHash, { maxBytes });
}
async function finishRemoval(pin, pending) {
  if (pending.value.op !== 'remove') fail('QUEUE_RECOVERY_REQUIRED', 'Append recovery must finish before cleanup.');
  const next = await publish(pin, pending);
  await removeIfExact(pin, partPath(pending.value.record.key), pending.value.record.bytesHash, MAX_QUEUE_RECORD_BYTES);
  await removeIfExact(pin, nodePath(pending.value.record.key), pending.value.node.hash, METADATA_BYTES);
  return { removed: true, remaining: next.count, cursor: tokenFor(pending.value) };
}

/** One selected record per call, after durable source checkpoint and completed save. */
export async function cleanupQueueStep(pin, relative, { selected, context, index, cursor } = {}) {
  assertId(selected?.id); assertHash(selected?.hash); assertHash(context); count(index);
  const supplied = cursor === undefined ? null : validateCleanupCursor(cursor);
  const queue = await root(pin, relative);
  if (!queue) fail('QUEUE_SELECTION_MISSING', 'Selected queue record is absent.');
  let current = await state(queue);
  let pending = await intent(queue);
  if (pending?.value.op === 'append') {
    await makeCleanupAvailable(queue, pending);
    current = await state(queue);
    pending = await intent(queue);
  }
  if (pending) {
    const value = pending.value;
    if (value.op !== 'remove') fail('QUEUE_RECOVERY_REQUIRED', 'Pending append must finish before cleanup.');
    if (value.record.id !== selected.id || value.record.hash !== selected.hash || value.context !== context || value.index !== index ||
        (supplied && !equal(supplied, tokenFor(value)))) {
      fail('QUEUE_CURSOR_MISMATCH', 'Cleanup request differs from the exact pending step.');
    }
    return finishRemoval(queue, pending);
  }
  if (supplied) fail('QUEUE_CURSOR_MISMATCH', 'A cleanup cursor cannot authorize a new removal.');
  const id = keyFor(selected.id);
  const link = await node(queue, id, current.value.queueId, true);
  if (!link) fail('QUEUE_SELECTION_MISSING', 'Selected queue record is absent.');
  if (link.value.id !== selected.id || link.value.hash !== selected.hash) fail('QUEUE_SELECTION_CONFLICT', 'Selected queue data differs from its frozen hash.');
  const part = await readSnapshot(queue, partPath(id), { maxBytes: MAX_QUEUE_RECORD_BYTES });
  const record = decodeRecord(part.bytes, 0);
  if (record.id !== selected.id || record.hash !== selected.hash) fail('QUEUE_SELECTION_CONFLICT', 'Selected segment differs from its frozen identity.');
  const neighbors = [];
  for (const neighbor of [link.value.prev, link.value.next]) {
    if (neighbor !== null) neighbors.push(nodeSnapshot(neighbor, await node(queue, neighbor, current.value.queueId)));
  }
  const proposal = { schema: 1, op: 'remove', tx: randomUUID(), queueId: current.value.queueId,
    before: { value: current.value, hash: current.hash }, record: recordInfo(record), node: { value: link.value, hash: link.hash },
    neighbors, context, index };
  const parked = await parkedCandidate(queue, current.value.queueId);
  if (parked) proposal.parked = parked;
  validateIntent(proposal);
  await putIntent(queue, proposal);
  return finishRemoval(queue, await intent(queue));
}

/** Caller first durably publishes this cursor in its existing run bookkeeping. */
export async function acknowledgeQueueCleanup(pin, relative, value) {
  const cursor = validateCleanupCursor(value);
  const queue = await root(pin, relative);
  if (!queue) fail('QUEUE_CURSOR_MISMATCH', 'Cleanup acknowledgment refers to an absent queue.');
  const current = await state(queue);
  if (current.value.queueId !== cursor.queueId) fail('QUEUE_CURSOR_MISMATCH', 'Cleanup cursor belongs to another queue.');
  const pending = await intent(queue);
  if (!pending) return { acknowledged: false, alreadyAbsent: true };
  // The caller durably advanced its run before its first ACK. Another current
  // transaction proves this old transaction no longer owns the journal slot;
  // retrying that ACK must leave the newer transaction untouched.
  if (pending.value.tx !== cursor.transactionId) return { acknowledged: false, superseded: true };
  if (pending.value.op !== 'remove' || !equal(cursor, tokenFor(pending.value))) {
    fail('QUEUE_CURSOR_MISMATCH', 'Acknowledgment differs from the exact pending cleanup step.');
  }
  await finishRemoval(queue, pending);
  await clearIntent(queue, pending);
  return { acknowledged: true };
}

/** Explicit empty-unit pruning only, after all cleanup cursors were acknowledged. */
export async function removeEmptyQueue(pin, relative, { queueId } = {}) {
  uuid(queueId);
  const queue = await root(pin, relative);
  if (!queue) return { removed: false };
  const current = await state(queue);
  if (current.value.queueId !== queueId || current.value.count !== 0 || await intent(queue) || await parkedCandidate(queue, current.value.queueId)) {
    fail('QUEUE_NOT_EMPTY', 'Only an empty acknowledged queue can be removed.');
  }
  const allowed = new Set(['parts', 'links', 'state.json', 'intent.json']);
  const entries = await fs.opendir(queue.root, { bufferSize: 1 });
  try {
    for await (const entry of entries) {
      if (!allowed.delete(entry.name)) fail('QUEUE_UNKNOWN_ARTIFACT', 'Unknown queue artifacts must be preserved.');
    }
  } finally { if (!entries.closed) await entries.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
  if (allowed.size) fail('QUEUE_METADATA_INVALID', 'Empty queue layout is incomplete.');
  await assertDirectory(queue);
  await fs.rmdir(relativePath(queue, 'parts'));
  await fs.rmdir(relativePath(queue, 'links'));
  const idle = await metadata(queue, 'intent.json');
  await removeExact(queue, 'intent.json', idle.hash, { maxBytes: METADATA_BYTES });
  await removeExact(queue, 'state.json', current.hash, { maxBytes: METADATA_BYTES });
  await assertDirectory(queue);
  await fs.rmdir(queue.root);
  await syncDirectory(path.dirname(queue.root));
  await assertDirectory(pin);
  return { removed: true };
}
