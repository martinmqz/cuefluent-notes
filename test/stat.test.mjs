import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { normalizeStat, readHandleStat, readPathStat } from '../src/storage/stat.mjs';
import { assertChain, createPrivateDirectory, fileIdentity, inspectAncestors, sameIdentity } from '../src/storage/paths.mjs';
import { readSnapshot } from '../src/storage/files.mjs';
import { establishWindowsPrivacy } from '../src/storage/platform.mjs';
import { appendQueueRecord, encodeQueueRecord, inspectQueue } from '../src/storage/queue.mjs';

function rawStat(overrides = {}) {
  return {
    dev: 1n, ino: 2n, size: 3n, mode: 0o100600n, uid: 4n, gid: 5n, nlink: 1n,
    atimeNs: 1_760_000_000_000_000_001n,
    mtimeNs: 1_760_000_000_000_000_002n,
    ctimeNs: 1_760_000_000_000_000_003n,
    birthtimeNs: 1_760_000_000_000_000_004n,
    isFile() { return this.mode === 0o100600n; },
    isDirectory() { return this.mode === 0o040700n; },
    isSymbolicLink() { return false; },
    isBlockDevice() { return false; },
    isCharacterDevice() { return false; },
    isFIFO() { return false; },
    isSocket() { return false; },
    ...overrides,
  };
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cuefluent-stat-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pin = await createPrivateDirectory(path.join(root, 'private'));
  return { root, pin };
}

test('device and inode IDs beyond Number precision cannot alias', () => {
  const first = normalizeStat(rawStat({ dev: 18_446_744_073_709_551_614n, ino: 9_007_199_254_740_992n }));
  const changedInode = normalizeStat(rawStat({ dev: first.dev, ino: first.ino + 1n }));
  const changedDevice = normalizeStat(rawStat({ dev: first.dev + 1n, ino: first.ino }));
  assert.equal(Number(first.ino), Number(changedInode.ino));
  assert.equal(Number(first.dev), Number(changedDevice.dev));
  const identity = fileIdentity(first);
  assert.deepEqual(identity, { device: '18446744073709551614', inode: '9007199254740992' });
  assert.equal(sameIdentity(first, identity), true);
  assert.equal(sameIdentity(changedInode, identity), false);
  assert.equal(sameIdentity(changedDevice, identity), false);
  assert.throws(() => fileIdentity({ dev: Number(first.dev), ino: Number(first.ino) }), { code: 'STAT_EXACT_REQUIRED' });
});

test('numeric metadata stays exact and type predicates bind to bigint mode', () => {
  const raw = rawStat();
  const stat = normalizeStat(raw);
  assert.equal(stat.size, 3);
  assert.equal(stat.mode, 0o100600);
  assert.equal(stat.uid, 4);
  assert.equal(stat.gid, 5);
  assert.equal(stat.nlink, 1);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isDirectory(), false);
  const detached = stat.isFile;
  assert.equal(detached(), true);
  assert.equal(Object.isFrozen(stat), true);
  assert.equal(Object.isFrozen(raw), true);
});

test('signed high-bit filesystem IDs preserve their full unsigned identity', () => {
  for (const [signed, unsigned] of [
    [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_808n],
    [-9_223_372_036_854_775_425n, 9_223_372_036_854_776_191n],
    [-1n, 18_446_744_073_709_551_615n],
  ]) {
    const stat = normalizeStat(rawStat({ dev: signed, ino: signed, mtimeNs: -1n }));
    const expected = fileIdentity(normalizeStat(rawStat({ dev: unsigned, ino: unsigned })));
    assert.equal(stat.dev, unsigned);
    assert.equal(stat.ino, unsigned);
    assert.equal(stat.mtimeNs, -1n);
    assert.equal(sameIdentity(stat, expected), true);
    const changed = normalizeStat(rawStat({ dev: unsigned, ino: unsigned ^ 1n }));
    assert.equal(sameIdentity(changed, expected), false);
  }
});

test('filesystem IDs outside signed or unsigned 64-bit range cannot wrap into another identity', () => {
  for (const field of ['dev', 'ino']) {
    for (const value of [-(1n << 63n) - 1n, 1n << 64n, (1n << 64n) + 2n, 2, '2']) {
      assert.throws(() => normalizeStat(rawStat({ [field]: value })), { code: 'STAT_EXACT_REQUIRED' });
    }
  }
});

test('ancestor inspection accepts signed overlayfs inode IDs and still detects replacement', async (t) => {
  const directory = path.resolve('synthetic', 'store');
  let inode = -9_223_372_036_854_775_425n;
  t.mock.method(fs, 'lstat', async (_file, options) => {
    assert.deepEqual(options, { bigint: true });
    return rawStat({ ino: inode, mode: 0o040700n });
  });
  const chain = await inspectAncestors(directory);
  assert.equal(chain.at(-1).path, directory);
  assert.ok(chain.length > 1);
  assert.ok(chain.every(entry => entry.inode === '9223372036854776191'));
  await assertChain(chain);
  inode = 9_223_372_036_854_776_191n;
  await assertChain(chain);
  inode += 1n;
  await assert.rejects(assertChain(chain), { code: 'PATH_CHANGED' });
});

test('nanosecond timestamps retain differences hidden by millisecond conversion', () => {
  const first = normalizeStat(rawStat());
  const second = normalizeStat(rawStat({ mtimeNs: first.mtimeNs + 1n, ctimeNs: first.ctimeNs + 1n }));
  assert.equal(Number(first.mtimeNs) / 1e6, Number(second.mtimeNs) / 1e6);
  assert.notEqual(first.mtimeNs, second.mtimeNs);
  assert.notEqual(first.ctimeNs, second.ctimeNs);
  assert.equal('mtimeMs' in first, false);
  assert.equal('ctimeMs' in first, false);
});

test('unrepresentable numeric fields and Number Stats fail closed', () => {
  for (const field of ['size', 'mode', 'uid', 'gid', 'nlink']) {
    assert.throws(() => normalizeStat(rawStat({ [field]: BigInt(Number.MAX_SAFE_INTEGER) + 1n })), { code: 'STAT_FIELD_UNSUPPORTED' });
    assert.throws(() => normalizeStat(rawStat({ [field]: -1n })), { code: 'STAT_FIELD_UNSUPPORTED' });
  }
  assert.throws(() => normalizeStat(rawStat({ dev: 1 })), { code: 'STAT_EXACT_REQUIRED' });
  assert.throws(() => normalizeStat(rawStat({ mtimeNs: undefined })), { code: 'STAT_EXACT_REQUIRED' });
});

test('each read helper requests exactly one bigint observation', async (t) => {
  const raw = rawStat({ ino: -9_223_372_036_854_775_425n });
  const calls = [];
  t.mock.method(fs, 'lstat', async (file, options) => { calls.push({ file, options }); return raw; });
  const observed = await readPathStat('/synthetic/stat-only');
  assert.deepEqual(calls, [{ file: '/synthetic/stat-only', options: { bigint: true } }]);
  assert.equal(observed.ino, 9_223_372_036_854_776_191n);
  let count = 0;
  const handle = { async stat(options) { assert.deepEqual(options, { bigint: true }); count++; return raw; } };
  assert.equal((await readHandleStat(handle)).ino, observed.ino);
  assert.equal(count, 1);
});

test('real path and open-handle observations preserve the same exact identity', async (t) => {
  const { pin } = await fixture(t);
  const file = path.join(pin.root, 'sample');
  await fs.writeFile(file, 'abc', { mode: 0o600 });
  const handle = await fs.open(file, 'r');
  try {
    const byPath = await readPathStat(file);
    const byHandle = await readHandleStat(handle);
    assert.equal(typeof byPath.ino, 'bigint');
    assert.equal(typeof byHandle.dev, 'bigint');
    assert.equal(typeof byPath.mtimeNs, 'bigint');
    assert.equal(byPath.size, 3);
    assert.deepEqual(fileIdentity(byPath), fileIdentity(byHandle));
    assert.equal(byPath.mtimeNs, byHandle.mtimeNs);
    assert.equal(byPath.isFile(), true);
    assert.equal(byHandle.isSymbolicLink(), false);
  } finally { await handle.close(); }
});

async function shiftSecondHandleTimestamp(t, file) {
  const handle = await fs.open(file, 'r');
  const prototype = Object.getPrototypeOf(handle);
  const original = prototype.stat;
  await handle.close();
  let reads = 0;
  t.mock.method(prototype, 'stat', async function(options) {
    assert.deepEqual(options, { bigint: true });
    const raw = await original.call(this, options);
    if (++reads === 2) raw.mtimeNs += 1n;
    return raw;
  });
}

test('snapshot verification detects a one-nanosecond change', async (t) => {
  const { pin } = await fixture(t);
  const file = path.join(pin.root, 'sample');
  await fs.writeFile(file, 'unchanged size', { mode: 0o600 });
  establishWindowsPrivacy(file);
  await shiftSecondHandleTimestamp(t, file);
  await assert.rejects(readSnapshot(pin, 'sample'), { code: 'FILE_CHANGED' });
});

test('queue scan verification detects a one-nanosecond change', async (t) => {
  const { pin } = await fixture(t);
  await appendQueueRecord(pin, 'sample.jsonl', encodeQueueRecord('source:1', Buffer.from('{"text":"synthetic"}')));
  await shiftSecondHandleTimestamp(t, path.join(pin.root, 'sample.jsonl', 'state.json'));
  await assert.rejects(inspectQueue(pin, 'sample.jsonl'), { code: 'FILE_CHANGED' });
});
