import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('the isolated standard-user fixture includes its complete module dependencies', async t => {
  const scripts = fileURLToPath(new URL('.', import.meta.url));
  const source = await fs.readFile(path.join(scripts, 'test-windows-standard-user.ps1'), 'utf8');
  const list = /^\s*\$files = @\(([\s\S]*?)\)\s*$/m.exec(source);
  assert(list, 'the fixture must declare its copied files');
  const files = [...list[1].matchAll(/'([^']+)'/g)].map(match => match[1].split('\\').join(path.sep));
  assert(files.length > 0);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-standard-user-modules-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of files) {
    const target = path.join(root, 'scripts', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(scripts, file), target);
  }
  // Import the actual detached entry point without a valid invocation marker:
  // this regression never creates accounts or runs native permission checks.
  const launch = (args = []) => spawnSync(process.execPath, [path.join(root, 'scripts', 'storage-standard-user.mjs'), ...args],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 10000 });
  const identity = [root, 'S-1-5-21-1-2-3-1000'];
  for (const args of [[], identity, ['--incorrect-fixture', ...identity]]) {
    const complete = launch(args);
    assert.equal(complete.status, 1, complete.stderr); assert.equal(complete.signal, null);
    assert.match(complete.stderr, /Error: Windows CI fixture only\./);
    assert.doesNotMatch(complete.stderr, /ERR_MODULE_NOT_FOUND/);
  }
  const second = spawnSync(process.execPath, [path.join(root, 'scripts', 'storage-standard-user-access.mjs')],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(second.status, 1); assert.equal(second.signal, null);
  assert.match(second.stderr, /Error: Windows CI second-user fixture only\./);
  assert.doesNotMatch(second.stderr, /ERR_MODULE_NOT_FOUND/);
  // Reproduce the native CI failure as a negative control for the detached copy.
  await fs.unlink(path.join(root, 'scripts', 'collection-grant.mjs'));
  const incomplete = launch();
  assert.equal(incomplete.status, 1); assert.match(incomplete.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.doesNotMatch(incomplete.stderr, /Error: Windows CI fixture only\./);
});
