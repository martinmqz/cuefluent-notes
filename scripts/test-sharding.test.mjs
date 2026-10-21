import test from 'node:test';
import assert from 'node:assert/strict';
import { testWeights, testShard } from './test-sharding.mjs';

const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((letter, i) => ({ name: `${letter}.test.mjs`, bytes: 100 + i }));
const names = files.map(file => file.name);
const timings = { version: 1, platforms: { win32: Object.fromEntries(files.map((file, i) => [file.name, { ms: (8 - i) * 100, bytes: file.bytes }])),
  darwin: Object.fromEntries(files.map((file, i) => [file.name, { ms: (i + 1) * 100, bytes: file.bytes }])) } };

test('four weighted shards preserve exact discovery coverage and dispatch longest first on each platform', () => {
  const assignments = {};
  for (const platform of ['win32', 'darwin']) {
    const weights = testWeights(files, timings, platform);
    const shards = [1, 2, 3, 4].map(i => testShard(names, `${i}/4`, weights));
    assert.deepEqual(shards.flat().sort(), names);
    assert.equal(new Set(shards.flat()).size, names.length);
    assert.deepEqual(shards.map(shard => shard.reduce((total, name) => total + weights.get(name), 0)), [900, 900, 900, 900]);
    for (const shard of shards) assert.deepEqual(shard.map(name => weights.get(name)), shard.map(name => weights.get(name)).sort((a, b) => b - a));
    assert.deepEqual([1, 2, 3, 4].map(i => testShard([...names].reverse(), `${i}/4`, weights)), shards);
    assignments[platform] = shards;
  }
  assert.notDeepEqual(assignments.win32, assignments.darwin);
});

test('new files and stale samples cannot omit discovery; invalid samples deterministically fall back', () => {
  const extra = [...files, { name: 'new.test.mjs', bytes: 200 }], discovery = extra.map(file => file.name);
  const stale = structuredClone(timings); stale.platforms.win32['removed.test.mjs'] = { ms: 1, bytes: 100 };
  for (const sample of [stale, null, { version: 2 }, { version: 1, platforms: { win32: { bad: { ms: -1, bytes: 1 } } } }]) {
    const weights = testWeights(extra, sample, 'win32');
    assert.equal(weights.size, extra.length); assert(weights.get('new.test.mjs') > 0);
    const shards = [1, 2, 3, 4].map(i => testShard(discovery, `${i}/4`, weights));
    assert.deepEqual(shards.flat().sort(), [...discovery].sort());
  }
  const noSamples = testWeights(files, null, 'win32');
  assert.deepEqual([...noSamples.values()], files.map(file => file.bytes));
  assert.deepEqual(testShard(names, '', noSamples), names);
});

test('equal and zero-sized files spread deterministically; empty shards and invalid specs never rediscover', () => {
  const weights = testWeights(files.map(file => ({ ...file, bytes: 0 })), null, 'linux');
  assert.deepEqual([1, 2, 3, 4].map(i => testShard(names, `${i}/4`, weights).length), [2, 2, 2, 2]);
  assert.deepEqual(testShard(names, '9/9', weights), []);
  for (const spec of ['0/4', '5/4', '1/0', '1', 'x/4', '1/4/2', '1/9999999999999999999'])
    assert.throws(() => testShard(names, spec, weights), /Invalid CUEFLUENT_TEST_SHARD/);
});
