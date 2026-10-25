import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createPrivateDirectory, pinDirectory } from '../src/storage/paths.mjs';
import { hashBytes, jsonBytes, removalContainerName } from '../src/storage/files.mjs';
import { interruptRemoval } from './fixtures/exact-removal-worker.mjs';
import { establishWindowsPrivacy } from '../src/storage/platform.mjs';
import {
  MAX_QUEUE_RECORD_BYTES, acknowledgeQueueCleanup, appendQueueRecord, cleanupQueueStep,
  encodeQueueRecord, inspectQueue, iterateQueue, readQueueRecord, recoverQueueAppend, removeEmptyQueue,
  selectQueue, validateCleanupCursor,
} from '../src/storage/queue.mjs';

const context = hashBytes(Buffer.from('synthetic frozen run selection'));
const record = (id, data = { text: id }) => encodeQueueRecord(id, Buffer.from(JSON.stringify(data)));
const keyFor = id => hashBytes(Buffer.from(id));
const partFor = (pin, relative, id) => path.join(pin.root, relative, 'parts', `${keyFor(id)}.jsonl`);
// Recovery spans child startup and repeated native ACL checks on Windows.
const recoveryTimeout = process.platform === 'win32' ? 60_000 : 15_000;
async function setup(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cuefluent-queue-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pin = await createPrivateDirectory(path.join(directory, 'private'));
  return { pin, relative: 'chat.queue', directory };
}
async function all(pin, relative) {
  const result = [];
  for await (const item of iterateQueue(pin, relative)) result.push(item);
  return result;
}
async function queueBytes(pin, relative) {
  const root = path.join(pin.root, relative), files = ['intent.json', 'state.json'];
  for (const directory of ['parts', 'links']) {
    for (const file of await fs.readdir(path.join(root, directory))) files.push(path.join(directory, file));
  }
  return Promise.all(files.sort().map(async file => [file, await fs.readFile(path.join(root, file))]));
}
const request = (selected, index = 0, cursor) => ({ selected, context, index, ...(cursor ? { cursor } : {}) });
async function remove(pin, relative, selected, index = 0) {
  const result = await cleanupQueueStep(pin, relative, request(selected, index));
  await acknowledgeQueueCleanup(pin, relative, result.cursor);
  return result;
}

async function killAt(t, pin, relative, phase, operation, item) {
  const queueModule = new URL('../src/storage/queue.mjs', import.meta.url).href;
  const pathsModule = new URL('../src/storage/paths.mjs', import.meta.url).href;
  const code = `
    import fs from 'node:fs/promises';
    import {constants} from 'node:fs';
    import path from 'node:path';
    import {pinDirectory} from ${JSON.stringify(pathsModule)};
    import * as q from ${JSON.stringify(queueModule)};
    const [root,relative,phase,operation,id,data,context] = process.argv.slice(1);
    const pin=await pinDirectory(root,{private:true});
    const item=q.encodeQueueRecord(id,Buffer.from(data,'base64'));
    let hit=false;
    async function pause() {if(hit)return;hit=true;process.send({type:'paused'});setInterval(()=>{},1000);await new Promise(()=>{});}
    const rename=fs.rename;
    fs.rename=async function(from,to){
      if(phase==='prune-before-publish'&&path.basename(to)==='intent.json') await pause();
      const result=await rename(from,to);
      if((phase==='intent'&&path.basename(to)==='intent.json')||(phase==='manifest'&&path.basename(to)==='state.json')||
         (phase==='neighbor'&&to.split(path.sep).includes('links'))) await pause();return result;};
    const open=fs.open;
    fs.open=async function(file,flags,...rest){const h=await open(file,flags,...rest);
      if(typeof flags==='number'&&(flags&constants.O_CREAT)&&
         ((phase==='part'&&file.split(path.sep).includes('parts'))||(phase==='new-link'&&file.split(path.sep).includes('links')))){
        const write=h.write.bind(h);h.write=async function(buffer,offset,length,position){
          const cut=phase==='part'?Math.min(length,item.bytes.indexOf(Buffer.from('☃'))+1||64):8;
          const result=await write(buffer,offset,Math.min(length,Math.max(1,cut)),position);await pause();return result;};}
      return h;};
    let result;
    if(operation==='append') result=await q.appendQueueRecord(pin,relative,item);
    else if(operation==='prune') result=await q.removeEmptyQueue(pin,relative,{queueId:(await q.inspectQueue(pin,relative)).queueId});
    else result=await q.cleanupQueueStep(pin,relative,{selected:item,context,index:0});
    if(phase==='completed') await pause();
    process.send({type:'unexpected-completion',result});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, pin.root, relative, phase, operation, item.id, item.dataBytes.toString('base64'), context], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr.on('data', value => { errors += value; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  });
  const ready = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Crash fixture exited ${code}: ${errors}`)));
  });
  assert.deepEqual(ready, { type: 'paused' });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
}

// The gate is the caller's responsibility; these fixtures serialize mutations.
test('missing reads create no queue and nonprivate roots are refused', async t => {
  const { pin, relative } = await setup(t);
  assert.deepEqual(await inspectQueue(pin, relative), { exists: false, records: 0, pending: null });
  assert.deepEqual(await selectQueue(pin, relative), []);
  assert.deepEqual(await fs.readdir(pin.root), []);
  await assert.rejects(inspectQueue(await pinDirectory(pin.root), relative), { code: 'QUEUE_PRIVATE_ROOT_REQUIRED' });
});

test('exact serialized data, order, direct retry deduplication, and conflict preservation', async t => {
  const { pin, relative } = await setup(t);
  const first = encodeQueueRecord('first', Buffer.from(' { "snow": "☃", "x":1 } '));
  assert.equal((await appendQueueRecord(pin, relative, first)).appended, true);
  await appendQueueRecord(pin, relative, record('second'));
  assert.equal((await appendQueueRecord(pin, relative, first)).appended, false);
  assert.deepEqual(await fs.readFile(partFor(pin, relative, first.id)), first.bytes);
  const selected = await all(pin, relative);
  assert.deepEqual(selected.map(x => x.id), ['first', 'second']);
  assert.deepEqual(selected[0].dataBytes, first.dataBytes);
  await assert.rejects(appendQueueRecord(pin, relative, record('first', { changed: true })), { code: 'QUEUE_ID_CONFLICT' });
  assert.equal((await inspectQueue(pin, relative)).records, 2);
});

test('selected direct lookup verifies live linkage and exact hash without enumerating', async t => {
  const { pin, relative } = await setup(t);
  const first = record('first'), second = record('second');
  await appendQueueRecord(pin, relative, first);
  await appendQueueRecord(pin, relative, second);
  t.mock.method(fs, 'opendir', async () => { throw new Error('Direct lookup must not enumerate.'); });
  const selected = await readQueueRecord(pin, relative, { id: second.id, hash: second.hash });
  assert.deepEqual(selected.dataBytes, second.dataBytes);
  await assert.rejects(readQueueRecord(pin, relative, { id: second.id, hash: '0'.repeat(64) }), { code: 'QUEUE_SELECTION_CONFLICT' });
  await remove(pin, relative, first);
  await assert.rejects(readQueueRecord(pin, relative, { id: first.id, hash: first.hash }), { code: 'QUEUE_SELECTION_MISSING' });
});

test('cleanup is one exact selected record per durable cursor and preserves newer arrivals', async t => {
  const { pin, relative } = await setup(t);
  const originals = [record('first'), record('middle'), record('last')];
  for (const item of originals) await appendQueueRecord(pin, relative, item);
  const step = await cleanupQueueStep(pin, relative, request(originals[1]));
  assert.equal(step.remaining, 2);
  assert.deepEqual(validateCleanupCursor(step.cursor), step.cursor);
  assert.throws(() => validateCleanupCursor({ ...step.cursor, conversation: 'unsupported' }), { code: 'QUEUE_CURSOR_INVALID' });
  let evaluated = false;
  const accessor = { ...step.cursor };
  Object.defineProperty(accessor, 'id', { enumerable: true, get() { evaluated = true; return 'middle'; } });
  assert.throws(() => validateCleanupCursor(accessor), { code: 'QUEUE_CURSOR_INVALID' });
  assert.equal(evaluated, false);
  await assert.rejects(appendQueueRecord(pin, relative, record('newer')), { code: 'QUEUE_CLEANUP_PENDING' });
  await assert.rejects(recoverQueueAppend(pin, relative), { code: 'QUEUE_CLEANUP_PENDING' });
  // Parent writes this exact cursor and advances its run index before ACK.
  assert.deepEqual((await cleanupQueueStep(pin, relative, request(originals[1], 0, step.cursor))).cursor, step.cursor);
  await acknowledgeQueueCleanup(pin, relative, step.cursor);
  assert.deepEqual(await acknowledgeQueueCleanup(pin, relative, step.cursor), { acknowledged: false, alreadyAbsent: true });
  await appendQueueRecord(pin, relative, record('newer'));
  assert.deepEqual((await all(pin, relative)).map(x => x.id), ['first', 'last', 'newer']);
  await remove(pin, relative, originals[0], 1);
  await remove(pin, relative, originals[2], 2);
  assert.deepEqual((await all(pin, relative)).map(x => x.id), ['newer']);
});

test('cleanup rejects wrong hash, context, index, token, and new removal from a stale token', async t => {
  const { pin, relative } = await setup(t);
  const first = record('first');
  await appendQueueRecord(pin, relative, first);
  await assert.rejects(cleanupQueueStep(pin, relative, request({ ...first, hash: '0'.repeat(64) })), { code: 'QUEUE_SELECTION_CONFLICT' });
  const result = await cleanupQueueStep(pin, relative, request(first));
  for (const change of [{ context: '0'.repeat(64) }, { index: 1 }, { selected: record('other') }]) {
    await assert.rejects(cleanupQueueStep(pin, relative, { ...request(first), ...change }), { code: 'QUEUE_CURSOR_MISMATCH' });
  }
  await assert.rejects(acknowledgeQueueCleanup(pin, relative, { ...result.cursor, hash: '0'.repeat(64) }), { code: 'QUEUE_CURSOR_MISMATCH' });
  await acknowledgeQueueCleanup(pin, relative, result.cursor);
  await assert.rejects(cleanupQueueStep(pin, relative, request(first, 0, result.cursor)), { code: 'QUEUE_CURSOR_MISMATCH' });
});

test('old durable ACK retry leaves a newer append intent untouched', { timeout: recoveryTimeout }, async t => {
  const { pin, relative } = await setup(t);
  const old = record('old');
  await appendQueueRecord(pin, relative, old);
  const step = await cleanupQueueStep(pin, relative, request(old));
  await acknowledgeQueueCleanup(pin, relative, step.cursor);
  const newer = record('newer');
  await killAt(t, pin, relative, 'intent', 'append', newer);
  const before = await inspectQueue(pin, relative);
  assert.deepEqual(await acknowledgeQueueCleanup(pin, relative, step.cursor), { acknowledged: false, superseded: true });
  assert.deepEqual(await inspectQueue(pin, relative), before);
  await appendQueueRecord(pin, relative, newer);
  assert.deepEqual((await all(pin, relative)).map(item => item.id), ['newer']);
});

for (const phase of ['intent', 'new-link', 'manifest', 'completed']) {
  test(`killed append at ${phase} recovers without duplicate or whole-backlog scan`, { timeout: recoveryTimeout }, async t => {
    const { pin, relative } = await setup(t);
    await appendQueueRecord(pin, relative, record('old'));
    const item = record('interrupted', { text: 'source ☃' });
    await killAt(t, pin, relative, phase, 'append', item);
    const status = await inspectQueue(pin, relative);
    if (phase !== 'completed') assert.equal(status.pending.op, 'append');
    assert.equal((await appendQueueRecord(pin, relative, item)).appended, false);
    assert.deepEqual((await all(pin, relative)).map(x => x.id), ['old', item.id]);
    assert.equal((await inspectQueue(pin, relative)).pending, null);
  });
}

test('killed torn segment requires exact native bytes and the inspected tail SHA', { timeout: recoveryTimeout }, async t => {
  const { pin, relative } = await setup(t);
  const item = record('torn', { text: 'split ☃ native bytes' });
  await killAt(t, pin, relative, 'part', 'append', item);
  const status = await inspectQueue(pin, relative);
  const before = await fs.readFile(partFor(pin, relative, item.id));
  assert.equal(status.pending.part.complete, false);
  await assert.rejects(appendQueueRecord(pin, relative, item), { code: 'QUEUE_TORN_TAIL' });
  await assert.rejects(recoverQueueAppend(pin, relative, { record: item, expectedTailHash: '0'.repeat(64) }), { code: 'QUEUE_TAIL_CHANGED' });
  await assert.rejects(recoverQueueAppend(pin, relative, { record: record('torn', { changed: true }), expectedTailHash: status.pending.part.hash }), { code: 'QUEUE_ID_CONFLICT' });
  assert.deepEqual(await fs.readFile(partFor(pin, relative, item.id)), before);
  await recoverQueueAppend(pin, relative, { record: item, expectedTailHash: status.pending.part.hash });
  assert.deepEqual(await fs.readFile(partFor(pin, relative, item.id)), item.bytes);
  assert.equal((await appendQueueRecord(pin, relative, item)).appended, false);
});

for (const phase of ['part', 'manifest']) {
  test(`committed prefix remains selectable during ${phase} append failure after native source disappears`, { timeout: recoveryTimeout }, async t => {
    const { pin, relative, directory } = await setup(t);
    const earlier = [record('already-collected:1'), record('already-collected:2')];
    for (const item of earlier) await appendQueueRecord(pin, relative, item);
    const native = path.join(directory, 'synthetic-native.json');
    await fs.writeFile(native, JSON.stringify({ text: 'new native ☃ exchange' }));
    const pending = encodeQueueRecord('not-checkpointed', await fs.readFile(native));
    await killAt(t, pin, relative, phase, 'append', pending);
    await fs.unlink(native);
    const journal = path.join(pin.root, relative, 'intent.json');
    const before = await fs.readFile(journal);
    await assert.rejects(selectQueue(pin, relative), { code: 'QUEUE_RECOVERY_REQUIRED' });
    const selected = await selectQueue(pin, relative, { allowPendingAppend: true });
    assert.deepEqual(selected.map(item => item.id), earlier.map(item => item.id));
    assert.deepEqual(selected.map(item => item.hash), earlier.map(item => item.hash));
    assert.deepEqual(await fs.readFile(journal), before);
    assert.equal((await inspectQueue(pin, relative)).pending.id, pending.id);
    const tailFile = path.join(pin.root, relative, 'links', `${keyFor(earlier[1].id)}.json`);
    const tail = JSON.parse(await fs.readFile(tailFile, 'utf8'));
    await fs.writeFile(tailFile, jsonBytes({ ...tail, hash: '0'.repeat(64) }));
    await assert.rejects(selectQueue(pin, relative, { allowPendingAppend: true }), { code: 'QUEUE_CONFLICT' });
    assert.deepEqual(await fs.readFile(journal), before);
  });
}

test('missing native source never reserves prior saved cleanup; parked exact repair later uses the current baseline', { timeout: recoveryTimeout }, async t => {
  const { pin, relative } = await setup(t);
  const earlier = [record('committed:1'), record('committed:2')];
  for (const item of earlier) await appendQueueRecord(pin, relative, item);
  const uncommitted = record('torn-source', { text: 'native ☃ missing until later' });
  await killAt(t, pin, relative, 'part', 'append', uncommitted);
  const tail = await fs.readFile(partFor(pin, relative, uncommitted.id));
  const selected = await selectQueue(pin, relative, { allowPendingAppend: true });
  assert.deepEqual(selected.map(item => item.id), earlier.map(item => item.id));
  // Their durable save completed. Cleanup can finish without the absent source.
  for (let index = 0; index < selected.length; index++) await remove(pin, relative, selected[index], index);
  const parked = await inspectQueue(pin, relative);
  assert.equal(parked.records, 0);
  assert.equal(parked.pending.parked, true);
  assert.deepEqual(await fs.readFile(partFor(pin, relative, uncommitted.id)), tail);
  assert.deepEqual(await selectQueue(pin, relative), []);
  await assert.rejects(removeEmptyQueue(pin, relative, { queueId: parked.queueId }), { code: 'QUEUE_NOT_EMPTY' });
  await assert.rejects(appendQueueRecord(pin, relative, record('arrived-later')), { code: 'QUEUE_APPEND_PARKED' });
  await assert.rejects(recoverQueueAppend(pin, relative), { code: 'QUEUE_RECOVERY_REQUIRED' });
  await assert.rejects(recoverQueueAppend(pin, relative, { record: uncommitted, expectedTailHash: '0'.repeat(64) }), { code: 'QUEUE_TAIL_CHANGED' });
  assert.equal((await inspectQueue(pin, relative)).pending.parked, true);
  await recoverQueueAppend(pin, relative, { record: uncommitted, expectedTailHash: hashBytes(tail) });
  assert.deepEqual((await all(pin, relative)).map(item => item.id), [uncommitted.id]);
  await appendQueueRecord(pin, relative, record('arrived-later'));
  assert.deepEqual((await all(pin, relative)).map(item => item.id), [uncommitted.id, 'arrived-later']);
});

for (const phase of ['neighbor', 'manifest', 'completed']) {
  test(`killed cleanup at ${phase} resumes the same step until durable ACK`, { timeout: recoveryTimeout }, async t => {
    const { pin, relative } = await setup(t);
    const items = [record('first'), record('middle'), record('last')];
    for (const item of items) await appendQueueRecord(pin, relative, item);
    await killAt(t, pin, relative, phase, 'cleanup', items[1]);
    const before = await inspectQueue(pin, relative);
    assert.equal(before.pending.op, 'remove');
    const retained = await queueBytes(pin, relative);
    await assert.rejects(cleanupQueueStep(pin, relative, { ...request(items[1]), context: hashBytes(Buffer.from('different cleanup context')) }),
      { code: 'QUEUE_CURSOR_MISMATCH' });
    assert.deepEqual(await queueBytes(pin, relative), retained);
    assert.deepEqual(await inspectQueue(pin, relative), before);
    const recovered = await cleanupQueueStep(pin, relative, request(items[1]));
    assert.deepEqual(recovered.cursor, before.pending.cursor);
    await acknowledgeQueueCleanup(pin, relative, recovered.cursor);
    await appendQueueRecord(pin, relative, record('newer'));
    assert.deepEqual((await all(pin, relative)).map(x => x.id), ['first', 'last', 'newer']);
  });
}

test('malformed complete segments and changed live lookup data remain preserved', async t => {
  const { pin, relative } = await setup(t);
  const item = record('corrupt');
  await appendQueueRecord(pin, relative, item);
  const file = partFor(pin, relative, item.id);
  const bad = Buffer.from('{"broken":\n');
  await fs.writeFile(file, bad);
  await assert.rejects(all(pin, relative), { code: 'QUEUE_RECORD_INVALID' });
  await assert.rejects(cleanupQueueStep(pin, relative, request(item)), { code: 'QUEUE_RECORD_INVALID' });
  assert.deepEqual(await fs.readFile(file), bad);
  assert.equal((await inspectQueue(pin, relative)).records, 1);
});

test('persisted metadata rejects unsupported content without rewriting it', async t => {
  const { pin, relative } = await setup(t);
  await appendQueueRecord(pin, relative, record('one'));
  const manifest = path.join(pin.root, relative, 'state.json');
  const value = JSON.parse(await fs.readFile(manifest, 'utf8'));
  const bytes = jsonBytes({ ...value, conversation: 'unsupported' });
  await fs.writeFile(manifest, bytes);
  await assert.rejects(inspectQueue(pin, relative), { code: 'QUEUE_METADATA_INVALID' });
  assert.deepEqual(await fs.readFile(manifest), bytes);
});

test('empty queue pruning is explicit and requires the final cleanup ACK', async t => {
  const { pin, relative } = await setup(t);
  const item = record('only');
  await appendQueueRecord(pin, relative, item);
  const initial = await inspectQueue(pin, relative);
  const step = await cleanupQueueStep(pin, relative, request(item));
  await assert.rejects(removeEmptyQueue(pin, relative, { queueId: initial.queueId }), { code: 'QUEUE_NOT_EMPTY' });
  await acknowledgeQueueCleanup(pin, relative, step.cursor);
  assert.equal((await inspectQueue(pin, relative)).exists, true);
  const base = path.join(pin.root, relative);
  assert.deepEqual(await fs.readdir(path.join(base, 'parts')), []);
  assert.deepEqual(await fs.readdir(path.join(base, 'links')), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(base, 'intent.json'), 'utf8')), { schema: 1, op: null });
  assert.deepEqual(await removeEmptyQueue(pin, relative, { queueId: initial.queueId }), { removed: true });
  assert.deepEqual(await fs.readdir(pin.root), []);
});

async function populate(pin, relative, amount, payloadSize = 1024) {
  await appendQueueRecord(pin, relative, record('part:0', { text: 'x'.repeat(payloadSize) }));
  const base = path.join(pin.root, relative);
  const manifest = JSON.parse(await fs.readFile(path.join(base, 'state.json'), 'utf8'));
  for (let index = 0; index < amount; index++) {
    const item = record(`part:${index}`, { text: 'x'.repeat(payloadSize) });
    const link = { schema: 1, queueId: manifest.queueId, id: item.id, hash: item.hash,
      prev: index === 0 ? null : keyFor(`part:${index - 1}`), next: index === amount - 1 ? null : keyFor(`part:${index + 1}`) };
    await fs.writeFile(partFor(pin, relative, item.id), item.bytes, { mode: 0o600 });
    establishWindowsPrivacy(partFor(pin, relative, item.id));
    await fs.writeFile(path.join(base, 'links', `${keyFor(item.id)}.json`), jsonBytes(link), { mode: 0o600 });
    establishWindowsPrivacy(path.join(base, 'links', `${keyFor(item.id)}.json`));
  }
  await fs.writeFile(path.join(base, 'state.json'), jsonBytes({ ...manifest, head: keyFor('part:0'), tail: keyFor(`part:${amount - 1}`), count: amount }));
}

test('large backlog streams and selection/append/cleanup use bounded work independent of backlog', { timeout: process.platform === 'win32' ? 180_000 : 30_000 }, async t => {
  const { pin } = await setup(t);
  await populate(pin, 'small.queue', 4, 16 * 1024);
  await populate(pin, 'large.queue', 600, 16 * 1024);
  const selected = await selectQueue(pin, 'large.queue', { limit: 1024 });
  assert.ok(selected.length < 600);
  assert.ok(selected.reduce((sum, item) => sum + item.bytes.length, 0) <= 8 * 1024 * 1024);
  let total = 0;
  for await (const item of iterateQueue(pin, 'large.queue')) { assert.equal(item.id, `part:${total++}`); }
  assert.equal(total, 600);
  const original = fs.open;
  let calls = [];
  t.mock.method(fs, 'open', async function(file, ...args) { calls.push(file); return original.call(this, file, ...args); });
  async function measured(relative) {
    calls = [];
    await appendQueueRecord(pin, relative, record('newest'));
    const appendCalls = calls.length;
    const payloadReads = calls.filter(file => file.endsWith('.jsonl'));
    assert.ok(payloadReads.every(file => file.endsWith(`${keyFor('newest')}.jsonl`)));
    calls = [];
    const step = await cleanupQueueStep(pin, relative, request(record('part:1', { text: 'x'.repeat(16 * 1024) })));
    const cleanupCalls = calls.length;
    const cleanupPayloads = calls.filter(file => file.endsWith('.jsonl'));
    assert.ok(cleanupPayloads.every(file => file.endsWith(`${keyFor('part:1')}.jsonl`)));
    await acknowledgeQueueCleanup(pin, relative, step.cursor);
    return { appendCalls, cleanupCalls };
  }
  assert.deepEqual(await measured('large.queue'), await measured('small.queue'));
  assert.equal((await inspectQueue(pin, 'large.queue')).records, 600);
});

test('invalid record bounds, UTF-8, identities, and linked segment paths fail closed', async t => {
  const { pin, relative } = await setup(t);
  assert.throws(() => record('../escape'), { code: 'QUEUE_ID_INVALID' });
  assert.throws(() => encodeQueueRecord('huge', Buffer.alloc(MAX_QUEUE_RECORD_BYTES + 1)), { code: 'QUEUE_RECORD_TOO_LARGE' });
  assert.throws(() => encodeQueueRecord('utf8', Buffer.from([0x22, 0xff, 0x22])), { code: 'QUEUE_DATA_INVALID' });
  assert.deepEqual(await fs.readdir(pin.root), []);
  const item = record('safe');
  await appendQueueRecord(pin, relative, item);
  const file = partFor(pin, relative, item.id);
  await fs.rename(file, `${file}.original`);
  try { await fs.symlink(`${file}.original`, file); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable.'); return; } throw error; }
  await assert.rejects(all(pin, relative), { code: 'PATH_UNSAFE' });
  assert.deepEqual(await fs.readFile(`${file}.original`), item.bytes);
});


test('selected input survives an unrelated append during its payload read', async t => {
  const { pin, relative } = await setup(t);
  const first = record('selected'), later = record('newer');
  await appendQueueRecord(pin, relative, first);
  const open = fs.open; let inserted = false;
  t.mock.method(fs, 'open', async function(file, ...args) {
    if (!inserted && file === partFor(pin, relative, first.id)) {
      inserted = true; await appendQueueRecord(pin, relative, later);
    }
    return open.call(this, file, ...args);
  });
  assert.deepEqual((await readQueueRecord(pin, relative, { id: first.id, hash: first.hash })).dataBytes, first.dataBytes);
  assert.equal((await inspectQueue(pin, relative)).records, 2);
});

for (const boundary of ['parts', 'links', 'state.json', 'intent.json']) {
  test(`empty queue removal resumes after deleting ${boundary}`, async t => {
    const { pin, relative } = await setup(t);
    const item = record('only'); await appendQueueRecord(pin, relative, item);
    const { queueId } = await inspectQueue(pin, relative); await remove(pin, relative, item);
    const method = boundary.endsWith('.json') ? 'unlink' : 'rmdir';
    const original = fs[method]; let failed = false;
    const mocked = t.mock.method(fs, method, async function(file, ...args) {
      const result = await original.call(this, file, ...args);
      if (!failed && (file === path.join(pin.root, relative, boundary) || boundary.endsWith('.json') && path.dirname(file) === path.join(pin.root, relative, removalContainerName(boundary)))) {
        failed = true; throw Object.assign(new Error('Synthetic interruption'), { code: 'SYNTHETIC_INTERRUPTION' });
      }
      return result;
    });
    await assert.rejects(removeEmptyQueue(pin, relative, { queueId }), { code: 'SYNTHETIC_INTERRUPTION' });
    mocked.mock.restore();
    const observed = await inspectQueue(pin, relative);
    assert.equal(observed.queueId, queueId); assert.equal(observed.records, 0);
    await removeEmptyQueue(pin, relative, { queueId });
    assert.deepEqual(await fs.readdir(pin.root), []);
  });
}

for (const boundary of ['parts', 'links']) {
  test(`process exit after capturing a queue ${boundary} file preserves retry and final pruning`, { timeout: recoveryTimeout }, async t => {
    const { pin, relative } = await setup(t), item = record('captured-only');
    await appendQueueRecord(pin, relative, item);
    const { queueId } = await inspectQueue(pin, relative);
    const target = `${relative}/${boundary}/${keyFor(item.id)}.${boundary === 'parts' ? 'jsonl' : 'json'}`;
    await interruptRemoval({ root: pin.root, relative: target, operation: 'cleanup', options: { queue: relative, request: request(item) } });
    assert.equal((await inspectQueue(pin, relative)).records, 0);
    const result = await cleanupQueueStep(pin, relative, request(item));
    await acknowledgeQueueCleanup(pin, relative, result.cursor);
    await removeEmptyQueue(pin, relative, { queueId });
    assert.deepEqual(await fs.readdir(pin.root), []);
  });
}

for (const target of ['state.json', 'intent.json']) for (const boundary of ['capture', 'unlink']) {
  test(`process exit at ${target} prune ${boundary} retains read-only identity and retries without artifacts`, { timeout: recoveryTimeout }, async t => {
    const { pin, relative } = await setup(t), item = record('captured-prune');
    await appendQueueRecord(pin, relative, item);
    const { queueId } = await inspectQueue(pin, relative); await remove(pin, relative, item);
    await interruptRemoval({ root: pin.root, relative: `${relative}/${target}`, operation: 'prune', boundary, options: { queue: relative, queueId } });
    const observed = await inspectQueue(pin, relative);
    assert.equal(observed.queueId, queueId); assert.equal(observed.records, 0);
    await removeEmptyQueue(pin, relative, { queueId });
    assert.deepEqual(await fs.readdir(pin.root), []);
  });
}

test('retry flushes a complete new link before publishing its queue manifest', async t => {
  const { pin, relative } = await setup(t);
  await appendQueueRecord(pin, relative, record('earlier'));
  const later = record('later'), filename = path.join(pin.root, relative, 'links', `${keyFor(later.id)}.json`);
  const open = fs.open; let failed = false, synced = 0;
  t.mock.method(fs, 'open', async function(file, ...args) {
    const handle = await open.call(this, file, ...args);
    if (file === filename && typeof args[0] === 'number' && (args[0] & 2)) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (!failed) { failed = true; throw Object.assign(new Error('Synthetic pre-fsync interruption'), { code: 'SYNTHETIC_INTERRUPTION' }); }
        synced++; return sync();
      };
    }
    return handle;
  });
  await assert.rejects(appendQueueRecord(pin, relative, later), { code: 'SYNTHETIC_INTERRUPTION' });
  await appendQueueRecord(pin, relative, later);
  assert.ok(synced > 0); assert.equal((await inspectQueue(pin, relative)).records, 2);
});


test('killed empty-queue prune before journal rename reclaims its exact reconstructable stage', async t => {
  const { pin, relative } = await setup(t), item = record('only');
  await appendQueueRecord(pin, relative, item); const { queueId } = await inspectQueue(pin, relative);
  await remove(pin, relative, item);
  await killAt(t, pin, relative, 'prune-before-publish', 'prune', item);
  assert.ok((await fs.readdir(path.join(pin.root, relative))).some(name => name.startsWith('.intent.json.')));
  await removeEmptyQueue(pin, relative, { queueId });
  assert.deepEqual(await fs.readdir(pin.root), []);
});
