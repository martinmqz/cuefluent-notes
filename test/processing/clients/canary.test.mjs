import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { windowsCanaryCommand, macosCanaryCommand, networkCanaryCommand, verifySandbox } from '../../../src/processing/clients/canary.mjs';

test('Windows native canary binds hostile-looking paths as literal environment values with delayed expansion off', () => {
  const file = String.raw`C:\Users\Synthetic & User!\Temp\note %PATH% $value 'quote' ` + "`tick`.txt";
  for (const operation of ['read', 'write']) {
    const value = windowsCanaryCommand(String.raw`C:\Windows`, operation, file);
    assert.deepEqual(value.env, { CUEFLUENT_CANARY_FILE: `"${file}"` });
    assert.equal(value.command[0], String.raw`C:\Windows\System32\cmd.exe`);
    assert.ok(value.command.includes('/v:off'));
    assert.equal(value.command.some(argument => argument.includes(file)), false);
    assert.equal(value.command.at(-1), operation === 'read' ? 'type %CUEFLUENT_CANARY_FILE%' : 'echo CUEFLUENT_CANARY_WRITE > %CUEFLUENT_CANARY_FILE%');
  }
  for (const unsafe of ['relative.txt', 'C:\\bad"quote.txt', 'C:\\line\nbreak.txt']) assert.throws(() => windowsCanaryCommand('C:\\Windows', 'write', unsafe), { code: 'PROCESSING_ISOLATION_UNSUPPORTED' });
});

test('macOS probe commands treat shell-looking file names literally', { skip: process.platform !== 'darwin' }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cuefluent-canary-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '$(touch ESCAPED) `touch ESCAPED` $HOME "quote".txt');
  for (const operation of ['write', 'read']) {
    const probe = macosCanaryCommand(operation, file);
    assert.notEqual(probe.command[0], '/bin/sh');
    const result = spawnSync(probe.command[0], probe.command.slice(1), { cwd: root, env: { ...process.env, ...probe.env }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    if (operation === 'write') await writeFile(file, 'SYNTHETIC LITERAL PATH');
    else assert.equal(result.stdout, 'SYNTHETIC LITERAL PATH');
  }
  assert.deepEqual(await readdir(root), [path.basename(file)]);
});

test('Windows and macOS network probes disable curl config and proxies before selecting the loopback listener', () => {
  for (const platform of ['darwin', 'win32']) {
    const probe = networkCanaryCommand(platform, 32123, 'C:\\Windows');
    assert.deepEqual(probe.command.slice(1, 4), ['-q', '--noproxy', '*']);
    assert.equal(probe.command.at(-1), 'http://127.0.0.1:32123/cuefluent-synthetic-canary');
  }
});

test('macOS isolation requires a running probe and every actual denial before source delivery', { skip: process.platform !== 'darwin' }, async t => {
  for (const failure of [null, 'crash', 'read', 'write', 'outsideWrite', 'hiddenWrite', 'network', 'connected']) {
    await t.test(failure ?? 'all protections verified', async t => {
      const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cuefluent-canary-test-')));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      const calls = [];
      const transport = { async request(method, params) {
        assert.equal(method, 'command/exec');
        assert.equal(params.permissionProfile, 'cuefluent_processing');
        calls.push(params.command[0]);
        if (params.command[0] === '/bin/cat') {
          if (params.command[1].includes('.cuefluent-readable')) {
            return failure === 'crash' ? { exitCode: 134, stdout: '' } : { exitCode: 0, stdout: await readFile(params.command[1], 'utf8') };
          }
          return failure === 'read' ? { exitCode: 0, stdout: 'SYNTHETIC CANARY' } : { exitCode: 1, stdout: '' };
        }
        if (params.command[0] === '/usr/bin/touch') {
          const operation = path.dirname(params.command[1]) === cwd ? 'write' : 'outsideWrite';
          if (failure === 'hiddenWrite') await writeFile(params.command[1], 'SYNTHETIC');
          return { exitCode: failure === operation ? 0 : 1, stdout: '' };
        }
        assert.equal(params.command[0], '/usr/bin/curl');
        assert.equal(params.command[1], '-q');
        assert.deepEqual(params.command.slice(2, 4), ['--noproxy', '*']);
        if (failure === 'connected') {
          const target = new URL(params.command.at(-1));
          await new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
            socket.once('error', reject); socket.once('connect', () => socket.resume()); socket.once('close', resolve);
          });
        }
        return { exitCode: failure === 'network' ? 0 : 7, stdout: '' };
      } };
      if (failure) await assert.rejects(verifySandbox(transport, cwd), { code: 'PROCESSING_ISOLATION_UNSUPPORTED' });
      else {
        await verifySandbox(transport, cwd);
        const rootCount = new Set([await realpath(os.tmpdir()), await realpath('/tmp')]).size;
        assert.deepEqual(calls, [...Array(1 + rootCount).fill('/bin/cat'), ...Array(1 + rootCount).fill('/usr/bin/touch'), '/usr/bin/curl']);
      }
      assert.equal((await readdir(cwd)).some(name => name.startsWith('.cuefluent-readable')), false);
    });
  }
});

test('macOS canary probes shared /tmp even with a distinct process TMPDIR and coalesces identical roots', { skip: process.platform !== 'darwin' }, async t => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cuefluent-canary-test-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const sharedOnly of [false, true]) {
    const probes = [];
    if (sharedOnly) t.mock.method(os, 'tmpdir', () => '/tmp');
    const transport = { async request(_method, params) {
      probes.push(params.command);
      if (params.command[0] === '/bin/cat' && params.command[1].includes('.cuefluent-readable')) return { exitCode: 0, stdout: await readFile(params.command[1], 'utf8') };
      return { exitCode: params.command[0] === '/usr/bin/curl' ? 7 : 1, stdout: '' };
    } };
    await verifySandbox(transport, cwd);
    const reads = probes.filter(argv => argv[0] === '/bin/cat' && !argv[1].includes('.cuefluent-readable'));
    assert.ok(reads.some(argv => argv[1].startsWith('/private/tmp/')));
    if (sharedOnly) assert.equal(reads.length, 1);
  }
});
