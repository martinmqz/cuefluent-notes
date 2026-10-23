import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { testWeights, testShard } from '../tools/test-sharding.mjs';
import { planTests } from '../tools/test.mjs';

async function fixture(t, names = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-test-shards-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'tools')); await fs.mkdir(path.join(root, 'test'));
  for (const name of ['test.mjs', 'test-sharding.mjs']) await fs.copyFile(new URL(`../tools/${name}`, import.meta.url), path.join(root, 'tools', name));
  const add = async (name, source = '') => { const file = path.join(root, ...name.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, source); };
  for (const name of names) await add(name);
  const timings = value => fs.writeFile(path.join(root, 'tools', 'ci-test-timings.json'), JSON.stringify(value));
  return { root, add, timings };
}

function execute(root, { shard, args = [] } = {}) {
  const env = { ...process.env, CUEFLUENT_RUNNER_TRACE: path.join(root, 'executed.jsonl'), CUEFLUENT_RUNNER_INHERIT: 'synthetic preserved value' };
  // This subprocess is a new test runner, not a nested Node test worker.
  delete env.NODE_TEST_CONTEXT; delete env.CUEFLUENT_TEST_SHARD;
  if (shard !== undefined) env.CUEFLUENT_TEST_SHARD = shard;
  return spawnSync(process.execPath, [path.join(root, 'tools', 'test.mjs'), ...args], { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
}
const passing = name => `import fs from 'node:fs'; fs.appendFileSync(process.env.CUEFLUENT_RUNNER_TRACE, JSON.stringify({name:${JSON.stringify(name)}, inherited:process.env.CUEFLUENT_RUNNER_INHERIT})+'\\n');`;
const trace = async root => (await fs.readFile(path.join(root, 'executed.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

// These checks exercise the original weight/file/bin tie rules directly.
test('weighted greedy placement keeps the four longest files apart and uses stable file/bin ties', () => {
  const names = ['d.test.mjs', 'b.test.mjs', 'a.test.mjs', 'c.test.mjs', 'e.test.mjs'];
  const same = new Map(names.map(name => [name, 1]));
  assert.deepEqual([1, 2, 3].map(index => testShard(names, `${index}/3`, same)), [['a.test.mjs', 'd.test.mjs'], ['b.test.mjs', 'e.test.mjs'], ['c.test.mjs']]);
  const heavy = new Map(names.map((name, index) => [name, [100, 90, 80, 70, 1][index]]));
  const bins = [1, 2, 3, 4].map(index => testShard(names, `${index}/4`, heavy));
  assert.ok(bins.every(bin => names.slice(0, 4).filter(name => bin.includes(name)).length === 1));
  assert.strictEqual(testShard(names, undefined, same), names);
});

test('native timing hints select each platform and new files use the original median-rate fallback', () => {
  const files = [{ name: 'test/a.test.mjs', bytes: 10 }, { name: 'test/new/nested.test.mjs', bytes: 20 }];
  const samples = { version: 1, platforms: { win32: { 'test/a.test.mjs': { ms: 100, bytes: 10 } }, darwin: { 'test/a.test.mjs': { ms: 20, bytes: 10 } } } };
  assert.deepEqual([...testWeights(files, samples, 'win32')], [['test/a.test.mjs', 100], ['test/new/nested.test.mjs', 200]]);
  assert.deepEqual([...testWeights(files, samples, 'darwin')], [['test/a.test.mjs', 20], ['test/new/nested.test.mjs', 40]]);
  assert.deepEqual([...testWeights(files, samples, 'linux')], [['test/a.test.mjs', 10], ['test/new/nested.test.mjs', 20]]);
  samples.platforms.win32['test/a.test.mjs'].bytes = 0;
  assert.deepEqual([...testWeights(files, samples, 'win32')], [['test/a.test.mjs', 10], ['test/new/nested.test.mjs', 20]]);
});

test('recursive discovery assigns every current file exactly once, including new nested files without measurements', async t => {
  const names = ['test/root.test.mjs', 'test/processing/clients/native.test.mjs', 'test/storage/deep/gates.test.mjs', 'test/new.test.mjs', 'test/extra.test.mjs'];
  const f = await fixture(t, names);
  await f.add('test/fixture.mjs'); await f.add('test/nested/README.md');
  await f.timings({ version: 1, platforms: { win32: { [names[0]]: { ms: 100, bytes: 1 }, 'test/removed.test.mjs': { ms: 500, bytes: 10 } }, darwin: { [names[1]]: { ms: 200, bytes: 1 } } } });
  for (const platform of ['win32', 'darwin', 'linux']) {
    const bins = await Promise.all([1, 2, 3, 4].map(index => planTests(f.root, { shard: `${index}/4`, platform })));
    assert.deepEqual(bins.flatMap(plan => plan.files).sort(), [...names].sort());
    assert.ok(bins.every(plan => plan.all.length === names.length));
  }
  await fs.unlink(path.join(f.root, 'test/root.test.mjs'));
  await f.add('test/brand-new/nested.test.mjs');
  assert.deepEqual((await planTests(f.root)).files, [...names.slice(1), 'test/brand-new/nested.test.mjs'].sort());
  await fs.writeFile(path.join(f.root, 'tools/ci-test-timings.json'), '{invalid');
  assert.equal((await planTests(f.root, { shard: '1/4' })).all.length, names.length);
});

test('invalid shards fail admission and never execute source tests', async t => {
  const f = await fixture(t, ['test/only.test.mjs']); await f.add('test/only.test.mjs', passing('only'));
  for (const shard of ['0/4', '5/4', '01/4', '1/0', '1/1025', '1/2\n', 'all']) {
    const result = execute(f.root, { shard }); assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid CUEFLUENT_TEST_SHARD/);
  }
  await assert.rejects(fs.stat(path.join(f.root, 'executed.jsonl')), { code: 'ENOENT' });
});

test('the actual runner executes all explicit recursive filenames, preserves env, and propagates early/later failures', async t => {
  for (const failed of [null, 'a', 'nested/z', 'all']) {
    const names = ['test/a.test.mjs', 'test/nested/z.test.mjs'], f = await fixture(t, names);
    for (const name of names) await f.add(name, passing(name) + (failed === 'all' || name === `test/${failed}.test.mjs` ? "process.exitCode=7;" : ''));
    const result = execute(f.root, { args: ['--test-concurrency=1'] });
    assert.equal(result.status, failed ? 1 : 0, result.stderr);
    assert.deepEqual((await trace(f.root)).map(value => value.name).sort(), names);
    assert.ok((await trace(f.root)).every(value => value.inherited === 'synthetic preserved value'));
  }
});

test('a valid empty shard does not start a rediscovering Node invocation; no source files remain an error', async t => {
  const f = await fixture(t, ['test/only.test.mjs']); await f.add('test/only.test.mjs', passing('only'));
  const empty = execute(f.root, { shard: '4/4' }); assert.equal(empty.status, 0); assert.equal(empty.stdout, '');
  await assert.rejects(fs.stat(path.join(f.root, 'executed.jsonl')), { code: 'ENOENT' });
  await fs.unlink(path.join(f.root, 'test/only.test.mjs'));
  const missing = execute(f.root, { shard: '4/4' }); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /No test files found/);
});

test('the runner forwards invalid Node options and preserves a child termination signal', async t => {
  const f = await fixture(t, ['test/only.test.mjs']); await f.add('test/only.test.mjs', passing('only'));
  assert.notEqual(execute(f.root, { args: ['--cuefluent-invalid-option'] }).status, 0);
  if (process.platform !== 'win32') {
    await f.add('test/only.test.mjs', "process.kill(process.ppid,'SIGKILL'); process.exit(0);");
    const stopped = execute(f.root); assert.equal(stopped.signal, 'SIGKILL');
  }
});
