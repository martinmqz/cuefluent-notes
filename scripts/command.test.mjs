import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnCommand, spawnStreamingCommand, resolveCommand } from './command.mjs';

function streaming(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnStreamingCommand(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

test('streaming native clients receive literal arguments without a shell', async () => {
  const args = ['spaces café 会議', '$HOME', '%PATH%', '& echo BAD', "apostrophe'", '`echo BAD`', '!PATH!', 'trailing\\'];
  const result = await streaming(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args]);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), args);
});

test('native commands receive arguments literally without shell interpretation', () => {
  const args = ['spaces café 会議', '$HOME', '%PATH%', '& echo BAD', "apostrophe'", '`echo BAD`', '!PATH!', 'trailing\\'];
  const result = spawnCommand(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('Windows command shims preserve literal arguments and executable paths', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-shim-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'args.cjs');
  await fs.writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  for (const directory of ["space café $HOME %PATH% & ' ` (test) !", 'node_modules/.bin']) {
    const shim = path.join(root, directory, 'test-client.cmd');
    await fs.mkdir(path.dirname(shim), { recursive: true });
    await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const args = ['spaces café 会議', '$HOME', '%PATH%', '& echo BAD', "apostrophe'", '`echo BAD`', '!PATH!', 'trailing\\', 'embedded"quote'];
    const result = spawnCommand(shim, args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    const streamed = await streaming(shim, args, { cwd: root });
    assert.equal(streamed.status, 0, streamed.stderr);
    assert.deepEqual(JSON.parse(streamed.stdout), args);
  }
});

test('Windows relative PATH lookup uses the child cwd and can pin a client across working directories', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-path-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['first', 'second']) {
    const bin = path.join(root, name, 'bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'client.cmd'), `@echo ${name}\r\n`);
  }
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await fs.writeFile(path.join(second, 'bin/only-in-child.cmd'), '@echo unexpected\r\n');
  // The uppercase PATH is the one Node forwards, irrespective of insertion order.
  const env = { ...process.env, Path: path.join(root, 'absent'), PATH: 'bin' };
  const pinned = resolveCommand('client', { env, cwd: first });
  assert.equal(pinned, path.join(first, 'bin/client.cmd'));
  assert.throws(() => resolveCommand('missing-client', { env, cwd: first }), { code: 'ENOENT' });
  assert.throws(() => resolveCommand('only-in-child', { env, cwd: first }), { code: 'ENOENT' });
  for (const [command, expected] of [['client', 'second'], [pinned, 'first']]) {
    const result = spawnCommand(command, [], { env, cwd: second, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});
