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
    const names = ['collection-hooks.test.mjs', 'collection-package.test.mjs', 'ordinary.test.mjs'];
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
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'preload.mjs')).href, path.join(root, 'test.mjs'), '--test-concurrency=4'], { encoding: 'utf8' });
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
    assert.deepEqual(calls.flatMap(call => call.args.filter(arg => arg.endsWith('.test.mjs')).map(file => path.basename(file))), names);
  });
