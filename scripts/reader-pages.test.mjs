import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { openWorkflowIntake, withIntakeLock, intakeSnapshot, intakeJSON, replaceIntakeJSON } from './intake-io.mjs';
import { planReaderCheckpoint, publishReaderPages, hydrateReaderCheckpoint, validateStoredCheckpoint, READER_ALLOCATION_PAGES } from './reader-pages.mjs';
import { checkpointPageBuilder } from './reader-checkpoint.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
const S = '10000000-0000-4000-8000-000000000001';
const carry = (count = 64) => ({ format: 'cuefluent-reader-checkpoint', version: 1, reader: 'claude-transcript/1', client: 'claude', sessionId: S,
  scopeId: randomUUID(), sourceIdentity: digest('synthetic-source'), offset: count * 100,
  records: Array.from({ length: count }, (_, i) => ({ id: randomUUID(), parentId: null, unitId: null, kind: 'unowned',
    startByte: i * 100, endByte: (i + 1) * 100, hash: digest(`row-${i}`) })), units: [] });
async function fixture(t) {
  const f = await storageFixture(t, { fullSetup: false });
  const store = await openWorkflowIntake(f.capability, { client: 'claude', sessionId: S, cwd: f.project }, 'collect');
  return { ...f, store, publish: value => withIntakeLock(store, tx => publishReaderPages(tx, value)) };
}
const base = value => `reader-pages/claude/${S}/${value.scopeId}`;
const name = (value, page) => `${base(value)}/${page.index.toString(16).padStart(2, '0')}-${page.hash.slice(0, 20)}/page.json`;

test('page hydration reuses unchanged bytes but never hides changed, missing or untrusted files', async t => {
  const f = await fixture(t), value = carry(), root = await f.publish(value);
  assert.deepEqual(await hydrateReaderCheckpoint(f.store, root), value);
  const open = fs.open; let reads = 0;
  fs.open = async (file, ...args) => { if (file.endsWith('page.json')) reads++; return open(file, ...args); };
  try { assert.deepEqual(await hydrateReaderCheckpoint(f.store, root), value); }
  finally { fs.open = open; }
  assert.equal(reads, 0, 'unchanged authenticated page bytes are cached');
  const page = path.join(f.collection.intakeStateDir, name(value, root.pages[0])), bytes = await fs.readFile(page);
  if (process.platform !== 'win32') {
    await fs.chmod(page, 0o644);
    await assert.rejects(hydrateReaderCheckpoint(f.store, root), /STORAGE_NOT_PRIVATE/);
    await fs.chmod(page, 0o600);
  }
  const altered = Buffer.from(bytes); altered[20] ^= 1; await fs.writeFile(page, altered);
  await assert.rejects(hydrateReaderCheckpoint(f.store, root), /READER_PAGE_CONFLICT/);
  await fs.writeFile(page, bytes); assert.deepEqual(await hydrateReaderCheckpoint(f.store, root), value);
  await fs.unlink(page);
  await assert.rejects(hydrateReaderCheckpoint(f.store, root), /READER_PAGE_CONFLICT/);
  // An observed empty final directory is a conflict, never overwritten/adopted.
  await assert.rejects(f.publish(value), /READER_PAGE_CONFLICT/);
});

test('interrupted paid stages do not poison a deterministic root and immutable pages are reused', async t => {
  const f = await fixture(t), value = carry(), expected = planReaderCheckpoint(value).root;
  const rename = fs.rename; let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && path.basename(from).startsWith('.stage-')) { failed = true; throw Object.assign(new Error('injected crash'), { code: 'EIO' }); }
    return rename(from, to);
  };
  try { await assert.rejects(f.publish(value), /injected crash/); }
  finally { fs.rename = rename; }
  assert(failed);
  const allocation = () => intakeSnapshot(f.store, 'state', `${base(value)}/allocation.json`);
  const charged = intakeJSON(await allocation());
  assert.equal(charged.pages, expected.pages.length);
  assert.deepEqual(await f.publish(value), expected);
  const after = await allocation(); assert.equal(intakeJSON(after).pages, charged.pages * 2);
  assert.deepEqual(await f.publish(value), expected); assert.equal((await allocation()).hash, after.hash);
  assert.deepEqual(await hydrateReaderCheckpoint(f.store, expected), value);
  assert((await fs.readdir(path.join(f.collection.intakeStateDir, base(value)))).some(file => file.startsWith('.stage-')));
  const exhausted = { ...intakeJSON(after), pages: READER_ALLOCATION_PAGES };
  await withIntakeLock(f.store, tx => replaceIntakeJSON(tx, `${base(value)}/allocation.json`, exhausted, after.hash));
  const added = carry(1).records[0]; added.startByte = value.offset; added.endByte = value.offset + 100;
  const next = { ...value, offset: value.offset + 100, records: [...value.records, added] };
  const before = await fs.readdir(path.join(f.collection.intakeStateDir, base(value)));
  await assert.rejects(f.publish(next), /READER_CHECKPOINT_ALLOCATION_CAPACITY/);
  assert.deepEqual(await fs.readdir(path.join(f.collection.intakeStateDir, base(value))), before);
});

test('paged roots enforce binding, counts and full hashes despite shortened path hashes', async t => {
  const f = await fixture(t), value = carry(), root = await f.publish(value);
  assert.throws(() => validateStoredCheckpoint({ ...root, recordCount: root.recordCount + 1 }), /INVALID_READER_CHECKPOINT/);
  await assert.rejects(hydrateReaderCheckpoint(f.store, { ...root, sourceIdentity: digest('other-source') }), /READER_PAGE_CONFLICT/);
  const collision = structuredClone(root);
  collision.pages[0].hash = collision.pages[0].hash.slice(0, 20) + '0'.repeat(44);
  await assert.rejects(hydrateReaderCheckpoint(f.store, collision), /READER_PAGE_CONFLICT/);
  const page = path.join(f.collection.intakeStateDir, name(value, root.pages[0]));
  const parsed = JSON.parse(await fs.readFile(page)); parsed.index = 15;
  const forgedBytes = Buffer.from(canonicalJSON(parsed) + '\n'), forgedRoot = structuredClone(root);
  forgedRoot.pages[0].hash = digest(forgedBytes); forgedRoot.pages[0].bytes = forgedBytes.length;
  const forgedFile = path.join(f.collection.intakeStateDir, name(value, forgedRoot.pages[0]));
  await fs.mkdir(path.dirname(forgedFile), { mode: 0o700 }); await fs.writeFile(forgedFile, forgedBytes, { mode: 0o600 });
  await assert.rejects(hydrateReaderCheckpoint(f.store, forgedRoot), /READER_PAGE_CONFLICT/);
});

test('partial page writes consume quota but a fresh paid attempt succeeds without touching the orphan', async t => {
  const f = await fixture(t), value = carry(), open = fs.open; let partial = null;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!partial && file.endsWith('page.json') && args[0] === 'wx') {
      partial = file; const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { await write(bytes.subarray(0, 20)); throw new Error('partial page'); };
    }
    return handle;
  };
  try { await assert.rejects(f.publish(value), /partial page/); }
  finally { fs.open = open; }
  assert(partial); assert.equal((await fs.readFile(partial)).length, 20);
  const root = await f.publish(value);
  assert.deepEqual(await hydrateReaderCheckpoint(f.store, root), value);
  assert.equal((await fs.readFile(partial)).length, 20);
});


test('append-order pages preserve sealed prefixes across many commits with bounded write amplification', () => {
  const all = carry(12000); let previous = [], allocated = 0;
  for (let count = 50; count <= all.records.length; count += 50) {
    const next = planReaderCheckpoint({ ...all, offset: count * 100, records: all.records.slice(0, count) }).root.pages;
    const changed = next.filter(page => !previous.some(old => old.hash === page.hash));
    assert(changed.length <= 2, 'an append rewrites only the tail and any new page');
    for (const old of previous.slice(0, -1)) assert.deepEqual(next[old.index], old);
    allocated += changed.reduce((sum, page) => sum + page.bytes, 0); previous = next;
  }
  assert(previous.length >= 5); assert(allocated < 80 * 1024 * 1024, `allocated ${allocated}`);
});

test('page-capacity refusal preserves the exact usable prefix before an overflowing record', () => {
  const value = carry(0), builder = checkpointPageBuilder(value); let accepted = 0;
  for (;;) {
    const record = { ...carry(1).records[0], id: 'r'.repeat(240) + accepted, startByte: accepted * 100, endByte: (accepted + 1) * 100 };
    try { builder.append(record); accepted++; }
    catch (error) { assert.equal(error.code, 'READER_CHECKPOINT_CAPACITY'); break; }
  }
  assert.equal(builder.pages.length, 16);
  const records = builder.pages.flatMap(page => page.value.records), prefix = { ...value, offset: accepted * 100, records };
  assert.equal(records.length, accepted); assert.equal(planReaderCheckpoint(prefix).root.pages.length, 16);
});
