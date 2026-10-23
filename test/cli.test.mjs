import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutFfiNotice } from './fixtures/runtime-stderr.mjs';

const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storeRoot = path.join(root, 'private'), cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd);
  const run = (args, input = '', entryPath = entry) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], { cwd, env: { ...process.env, CUEFLUENT_V2_HOME: storeRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr: withoutFfiNotice(stderr, child.pid) })); child.stdin.end(input);
  });
  return { root, storeRoot, cwd, notes, run };
}
test('CLI no-create reads and unconfigured native hooks leave no private store', async t => {
  const f = await fixture(t);
  const settings = await f.run(['settings']); assert.equal(settings.code, 0); assert.equal(JSON.parse(settings.stdout).settingsHash, null);
  const status = await f.run(['status', '--project', 'demo']); assert.equal(JSON.parse(status.stdout).state, 'unconfigured');
  const lifecycle = await f.run(['hook', 'claude'], JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'synthetic', cwd: f.cwd, transcript_path: null }));
  assert.deepEqual(lifecycle, { code: 0, stdout: '', stderr: '' });
  const command = await f.run(['hook', 'claude'], JSON.stringify({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
    command_name: 'cuefluent-notes:cuefluent-notes', command_source: 'plugin', command_args: 'track', prompt: '/cuefluent-notes:cuefluent-notes track',
    session_id: 'synthetic', prompt_id: 'prompt', cwd: f.cwd, transcript_path: null }));
  assert.equal(command.code, 0); assert.match(JSON.parse(command.stdout).hookSpecificOutput.additionalContext, /unconfigured/);
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('symlink-spelled CLI entry still executes read-only settings without creating state', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), alias = path.join(f.root, 'cuefluent-alias.mjs');
  await fs.symlink(entry, alias);
  const result = await f.run(['settings'], '', alias);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).state, 'unconfigured'); assert.equal(result.stderr, '');
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});
test('CLI explicit setup creates fresh manual/review settings and requires the inspected hash for later changes', async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'setup.json');
  const request = { expectedHash: null, project: { id: 'demo', root: f.cwd, destination: { kind: 'directory', path: f.notes } } };
  await fs.writeFile(configPath, JSON.stringify(request));
  const setup = await f.run(['setup', '--config', configPath]); assert.deepEqual({ code: setup.code, stderr: setup.stderr }, { code: 0, stderr: '' });
  const configured = JSON.parse(setup.stdout); assert.equal(configured.status, 'configured'); assert.equal(configured.project.tracking, 'manual'); assert.equal(configured.project.saving, 'review');
  const before = await fs.readdir(path.join(f.storeRoot, 'store'));
  const lifecycle = await f.run(['hook', 'codex'], JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'synthetic', cwd: f.cwd, transcript_path: null }));
  assert.deepEqual(lifecycle, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'store')), before);
  const status = await f.run(['status', '--project', 'demo']); assert.equal(JSON.parse(status.stdout).state, 'idle');
  const stale = await f.run(['setup', '--config', configPath]); assert.equal(stale.code, 1); assert.match(stale.stderr, /SETTINGS_CONFLICT/);
  const settings = JSON.parse((await f.run(['settings'])).stdout);
  await fs.writeFile(configPath, JSON.stringify({ ...request, expectedHash: settings.settingsHash, project: { ...request.project, saving: 'auto' } }));
  const changed = await f.run(['setup', '--config', configPath]); assert.equal(changed.code, 0); assert.equal(JSON.parse(changed.stdout).project.saving, 'auto');
});
test('CLI Claude MCP polling is read-only and accepts no caller native identities', async t => {
  const f = await fixture(t);
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cuefluent_invocation', arguments: { handle: Buffer.alloc(64, 2).toString('base64url') } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cuefluent_invocation', arguments: { handle: Buffer.alloc(64, 2).toString('base64url'), sessionId: 'synthetic' } } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n';
  const server = await f.run(['mcp', 'claude'], input); assert.equal(server.code, 0); assert.equal(server.stderr, '');
  const responses = server.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses.find(item => item.id === 1).result.serverInfo, { name: 'cuefluent-control', version: JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version });
  assert.equal(responses.find(item => item.id === 2).result.tools.length, 1);
  assert.equal(responses.find(item => item.id === 3).result.structuredContent.state, 'expired');
  assert.equal(responses.find(item => item.id === 4).result.isError, true);
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('the CLI accepts any exact public package version and refuses malformed identities before any work', async t => {
  const f = await fixture(t), copy = path.join(f.root, 'package-copy'), manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await fs.cp(fileURLToPath(new URL('../src', import.meta.url)), path.join(copy, 'src'), { recursive: true });
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(copy, 'node_modules'), 'junction');
  const attempt = async (name, version) => { await fs.writeFile(path.join(copy, 'package.json'), JSON.stringify({ ...manifest, name, version })); return f.run(['settings'], '', path.join(copy, 'src', 'cli.mjs')); };
  for (const version of ['0.16.0-dev.0', '0.16.0', '2.0.0']) {
    const result = await attempt('cuefluent-notes', version); assert.deepEqual({ code: result.code, stderr: result.stderr }, { code: 0, stderr: '' }); assert.equal(JSON.parse(result.stdout).state, 'unconfigured');
  }
  for (const [name, version] of [['cuefluent-notes', '0.16'], ['cuefluent-notes', 'v0.16.0'], ['cuefluent-notes', '0.16.0+build.1'], ['cuefluent-notes', '01.16.0'], ['other-package', '0.16.0']]) {
    const result = await attempt(name, version); assert.equal(result.code, 1); assert.match(result.stderr, /PACKAGE_INVALID/);
  }
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});
