import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { boundedCommand, clientAdmission, nativeBinary, nativePackage, smokeEnvironment } from '../tools/client-smoke.mjs';

const peer = path.join(import.meta.dirname, 'fixtures/client-smoke-native.mjs');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-smoke-test-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const trace = path.join(root, 'trace.jsonl'), env = { ...smokeEnvironment(root), CUEFLUENT_SMOKE_TRACE: trace };
  return { root, trace, env };
}
const fixtureSpawn = mode => (_command, args, options) => spawn(process.execPath, [peer, mode, ...args], options);

test('smoke profiles discard credentials, client overrides, private PATH and real profile locations', () => {
  const root = path.resolve('synthetic-smoke'), env = smokeEnvironment(root, { PATH: '/synthetic/private-tools', HOME: '/synthetic/real-home', CODEX_HOME: '/synthetic/private-codex', CLAUDE_CONFIG_DIR: '/synthetic/private-claude', OPENAI_API_KEY: 'SYNTHETIC_SECRET', ANTHROPIC_API_KEY: 'SYNTHETIC_SECRET', CLAUDE_CODE_OAUTH_TOKEN: 'SYNTHETIC_SECRET', NODE_OPTIONS: '--require /synthetic/unsafe', HTTPS_PROXY: 'SYNTHETIC_SECRET' }, 'darwin');
  assert.equal(JSON.stringify(env).includes('SYNTHETIC_SECRET'), false);
  assert.equal(JSON.stringify(env).includes('/synthetic/private'), false);
  assert.equal(JSON.stringify(env).includes('/synthetic/real-home'), false);
  assert.equal(env.NODE_OPTIONS, undefined);
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'TMPDIR']) assert.equal(path.relative(root, env[key]).startsWith('..'), false);
  const windows = smokeEnvironment(String.raw`C:\Synthetic smoke\fresh`, { SystemRoot: 'C:\\Windows', PATH: 'C:\\Private tools', ANTHROPIC_API_KEY: 'SYNTHETIC_SECRET' }, 'win32');
  assert.equal(windows.SYSTEMROOT, 'C:\\Windows'); assert.equal(windows.PATH.includes('Private tools'), false);
  assert.equal(windows.HOMEDRIVE + windows.HOMEPATH, windows.USERPROFILE);
  assert.equal(windows.USERDOMAIN, ''); assert.equal(windows.USERNAME, '');
});

test('native pins select exact reviewed versions and refuse unsupported platforms', () => {
  for (const platform of ['darwin', 'win32']) for (const arch of ['x64', 'arm64']) for (const client of ['claude', 'codex']) {
    const spec = nativePackage(client, platform, arch);
    assert.equal(spec.clientVersion, client === 'claude' ? '2.1.309' : '0.163.0');
    assert.match(spec.integrity, /^[A-Za-z0-9+/]{86}==$/); assert.match(spec.url, /^https:\/\/registry\.npmjs\.org\//);
    assert.ok(spec.binaries.every(name => name.startsWith('package/')));
  }
  assert.throws(() => nativePackage('codex', 'unsupported', 'x64'), { code: 'CLIENT_PLATFORM_UNSUPPORTED' });
});

test('native command checks fail on nonzero exit, excess output and timeout', async t => {
  const { root, env } = await fixture(t);
  await assert.rejects(boundedCommand(path.join(root, 'missing-native-program'), [], { env, cwd: root }), { code: 'CLIENT_COMMAND_FAILED' });
  assert.equal((await boundedCommand(process.execPath, [], { env, cwd: root, spawn: fixtureSpawn('command') })).trim(), 'Synthetic CLI output.');
  for (const [mode, code, options] of [['fail', 'CLIENT_COMMAND_FAILED', {}], ['output', 'CLIENT_OUTPUT_LIMIT', { maxBytes: 1024 }], ['wait', 'CLIENT_COMMAND_TIMEOUT', { timeoutMs: 100 }]]) {
    await assert.rejects(boundedCommand(process.execPath, [], { env, cwd: root, spawn: fixtureSpawn(mode), ...options }), { code });
  }
});

for (const client of ['codex', 'claude']) test(`source-free ${client} admission verifies the native protocol without delivering user/model input`, async t => {
  const { root, env, trace } = await fixture(t);
  const methods = await clientAdmission(client, process.execPath, { env, version: '1.2.3-dev.4', cwd: { path: root, check: async () => {} }, spawn: fixtureSpawn(client) });
  assert.deepEqual(methods, client === 'codex' ? ['initialize', 'configRequirements/read'] : ['initialize', 'get_settings', 'mcp_status', 'get_context_usage']);
  const calls = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(value => value.user), false);
  if (process.platform === 'win32') assert.deepEqual(calls[0].windowsProfile, { homePairMatchesDisposableProfile: true, blankIdentity: true });
  assert.equal(calls.some(value => ['turn/start', 'thread/start', 'account/read', 'config/write'].includes(value.method)), false);
  // CoreFoundation may add this process-local encoding hint on macOS.
  assert.deepEqual(calls[0].environment.filter(name => !Object.hasOwn(env, name) && !(process.platform === 'darwin' && name === '__CF_USER_TEXT_ENCODING')), []);
});

test('native admission refuses policy overrides and has an explicit startup deadline', async t => {
  const { root, env } = await fixture(t), cwd = { path: root, check: async () => {} };
  await assert.rejects(clientAdmission('codex', process.execPath, { env: { ...env, CUEFLUENT_SMOKE_POLICY: 'bad' }, version: '1.2.3-dev.4', cwd, spawn: fixtureSpawn('codex') }), { code: 'CLIENT_POLICY_ADMISSION' });
  await assert.rejects(clientAdmission('codex', process.execPath, { env, version: '1.2.3-dev.4', cwd, spawn: fixtureSpawn('wait'), timeoutMs: 100 }), { code: 'PROCESSING_ABORTED' });
});

test('admission requires a valid explicit package identity before any native launch', async () => {
  let launches = 0;
  for (const version of [undefined, '0.16.0-01', '0.16.0+build.1']) {
    await assert.rejects(clientAdmission('codex', process.execPath, { version, spawn: () => { launches++; } }), { code: 'PACKAGE_INVALID' });
  }
  assert.equal(launches, 0);
});

function archive(files) {
  const chunks = [];
  for (const [name, bytes, type = '0'] of files) {
    const header = Buffer.alloc(512); header.write(name); header.write(bytes.length.toString(8).padStart(11, '0'), 124, 11); header[156] = type.charCodeAt(0);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

test('native archive admission binds integrity, package identity and a single regular binary', () => {
  const spec = { name: 'synthetic-native', version: '1.0.0', binaries: ['package/bin/client'] }, binary = Buffer.from('SYNTHETIC_EXECUTABLE');
  const metadata = Buffer.from(JSON.stringify({ name: spec.name, version: spec.version }));
  const inspect = files => { const bytes = archive(files); return { bytes, pinned: { ...spec, integrity: createHash('sha512').update(bytes).digest('base64') } }; };
  const good = inspect([['package/package.json', metadata], ['package/bin/client', binary]]);
  assert.deepEqual(nativeBinary(good.bytes, good.pinned), binary);
  assert.throws(() => nativeBinary(Buffer.concat([good.bytes, Buffer.from('tampered')]), good.pinned), { code: 'CLIENT_ARCHIVE_INTEGRITY' });
  for (const files of [[['package/package.json', Buffer.from('{"name":"other","version":"1.0.0"}')], ['package/bin/client', binary]], [['package/package.json', metadata], ['package/bin/client', binary, '2']], [['package/package.json', metadata], ['package/bin/client', binary], ['package/bin/client', binary]]]) {
    const { bytes, pinned } = inspect(files); assert.throws(() => nativeBinary(bytes, pinned), { code: files[0][1].equals(metadata) ? 'CLIENT_ARCHIVE_INVALID' : 'CLIENT_ARCHIVE_IDENTITY' });
  }
});
