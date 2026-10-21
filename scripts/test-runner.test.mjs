import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

for (const statuses of [[1, 0], [0, 7], [2, 7], [null, 0], ['spawn-error', 0], [0, 0]])
  test(`Windows runner executes both phases and preserves failure for ${JSON.stringify(statuses)}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-test-runner-# '));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.copyFile(new URL('./test.mjs', import.meta.url), path.join(root, 'test.mjs'));
    await fs.copyFile(new URL('./test-sharding.mjs', import.meta.url), path.join(root, 'test-sharding.mjs'));
    await fs.mkdir(path.join(root, 'test-support'));
    // This process only simulates phase dispatch. Its spoofed platform must not
    // invoke Windows ACL tools or create settings as if it were a native host.
    await fs.writeFile(path.join(root, 'test-support', 'isolated-settings.mjs'), '// No settings or native storage in this orchestration-only fixture.\n');
    const names = ['collection-hooks.test.mjs', 'collection-package.test.mjs', 'windows-acl-probe.test.mjs', 'windows-discovery.test.mjs', 'ordinary.test.mjs'];
    await Promise.all(names.map(name => fs.writeFile(path.join(root, name), '')));
    // Only orchestration is simulated: no filesystem or client behavior is
    // claimed as native Windows coverage by this isolated child process.
    await fs.writeFile(path.join(root, 'preload.mjs'), `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { writeFileSync } from 'node:fs';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const statuses = ${JSON.stringify(statuses)}, calls = [];
      childProcess.spawnSync = (command, args) => {
        calls.push({ command, args });
        writeFileSync(${JSON.stringify(path.join(root, 'calls.json'))}, JSON.stringify(calls));
        const status = statuses[calls.length - 1];
        return status === 'spawn-error' ? { error: new Error('synthetic launch failure'), status: null } : { status };
      };
      syncBuiltinESMExports();
    `);
    // CI runs this file inside a shard; the runner under test sees no shard.
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'preload.mjs')).href, path.join(root, 'test.mjs'), '--test-concurrency=4'],
      { encoding: 'utf8', env: { ...process.env, CUEFLUENT_TEST_SHARD: '', CUEFLUENT_TEST_TIMINGS: '' } });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    await assert.doesNotReject(() => fs.access(path.join(root, 'calls.json')), result.stderr);
    const firstFailure = statuses.find(status => status !== 0);
    assert.equal(result.status, firstFailure === 'spawn-error' || firstFailure === null ? 1 : firstFailure ?? 0, result.stderr);
    if (firstFailure === 'spawn-error') assert.match(result.stderr, /synthetic launch failure/);
    const calls = JSON.parse(await fs.readFile(path.join(root, 'calls.json'), 'utf8'));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(0, 3), ['--test', '--test-concurrency=4', '--test-concurrency=1']);
    assert.deepEqual(calls[1].args.slice(0, 2), ['--test', '--test-concurrency=4']);
    assert.deepEqual(calls[0].args.filter(arg => arg.endsWith('.test.mjs')).map(file => path.basename(file)), names.filter(name => name !== 'ordinary.test.mjs'));
    assert.deepEqual(calls[1].args.filter(arg => arg.endsWith('.test.mjs')).map(file => path.basename(file)), ['ordinary.test.mjs']);
    assert.deepEqual(calls.flatMap(call => call.args.filter(arg => arg.endsWith('.test.mjs')).map(file => path.basename(file))).sort(), [...names].sort());
  });

// CI can split the suite across parallel jobs. Each shard is a disjoint part;
// together they run every file once, balanced by file size.
test('test shards run every file exactly once, balanced by size, and refuse invalid specs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-test-shards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(new URL('./test.mjs', import.meta.url), path.join(root, 'test.mjs'));
  await fs.copyFile(new URL('./test-sharding.mjs', import.meta.url), path.join(root, 'test-sharding.mjs'));
  await fs.mkdir(path.join(root, 'test-support'));
  await fs.writeFile(path.join(root, 'test-support', 'isolated-settings.mjs'), '// No settings in this orchestration-only fixture.\n');
  const sizes = { 'a.test.mjs': 900, 'b.test.mjs': 500, 'c.test.mjs': 400, 'd.test.mjs': 300, 'e.test.mjs': 300, 'f.test.mjs': 100 };
  await Promise.all(Object.entries(sizes).map(([name, size]) => fs.writeFile(path.join(root, name), '/'.repeat(size))));
  await fs.writeFile(path.join(root, 'preload.mjs'), `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const calls = [];
    childProcess.spawnSync = (command, args) => { calls.push(args); writeFileSync(process.env.CALLS_FILE, JSON.stringify(calls)); return { status: 0 }; };
    syncBuiltinESMExports();
  `);
  const run = spec => {
    const calls = path.join(root, `calls-${spec.replace('/', '-')}.json`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'preload.mjs')).href, path.join(root, 'test.mjs')],
      { encoding: 'utf8', env: { ...process.env, CUEFLUENT_TEST_SHARD: spec, CUEFLUENT_TEST_TIMINGS: '', CALLS_FILE: calls } });
    return { result, calls };
  };
  const shards = [];
  for (const spec of ['1/2', '2/2']) {
    const { result, calls } = run(spec);
    assert.equal(result.status, 0, result.stderr);
    shards.push(JSON.parse(await fs.readFile(calls, 'utf8')).flatMap(args => args.filter(arg => arg.endsWith('.test.mjs')).map(file => path.basename(file))));
  }
  assert.deepEqual([...shards.flat()].sort(), Object.keys(sizes));
  assert.equal(new Set(shards.flat()).size, Object.keys(sizes).length);
  const load = shard => shard.reduce((sum, name) => sum + sizes[name], 0);
  assert.deepEqual(shards.map(load), [1300, 1200]);
  // Files of equal size spread by count too, so no shard is left empty.
  await Promise.all(Object.keys(sizes).map(name => fs.writeFile(path.join(root, name), '')));
  const even = [];
  for (const spec of ['1/2', '2/2']) {
    const { result, calls } = run(spec);
    assert.equal(result.status, 0, result.stderr);
    even.push(JSON.parse(await fs.readFile(calls, 'utf8')).flatMap(args => args.filter(arg => arg.endsWith('.test.mjs'))).length);
  }
  assert.deepEqual(even, [3, 3]);
  for (const spec of ['0/2', '3/2', '1/0', '2', 'a/b', '1/2/3']) {
    const { result } = run(spec);
    assert.notEqual(result.status, 0, spec); assert.match(result.stderr, /Invalid CUEFLUENT_TEST_SHARD/);
  }
});
