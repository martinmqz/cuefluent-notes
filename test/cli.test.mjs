import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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

test('Claude installed expansions report unexecuted commands and malformed arguments without creating state', async t => {
  const f = await fixture(t), name = 'cuefluent-notes:cuefluent-notes';
  const expansion = command_args => ({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
    command_name: name, command_source: 'plugin', command_args, prompt: `/${name} ${command_args}`,
    session_id: 'synthetic', prompt_id: 'prompt', cwd: f.cwd, transcript_path: null });
  for (const input of ['untrack now', 'proces', '', 'save the selected meeting as a note']) {
    const result = await f.run(['hook', 'claude'], JSON.stringify(expansion(input)));
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /did not execute/); assert.match(context, /direct note tools/);
  }
  for (const input of [null, 42, {}, 'x'.repeat(129), 'untrack\nnow']) {
    const result = await f.run(['hook', 'claude'], JSON.stringify(expansion(input)));
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.match(JSON.parse(result.stdout).systemMessage, /COMMAND_INVALID/);
  }
  const unrelated = await f.run(['hook', 'claude'], JSON.stringify({ ...expansion('untrack now'), command_source: 'projectSettings' }));
  assert.deepEqual(unrelated, { code: 0, stdout: '', stderr: '' });
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
  assert.deepEqual(responses.find(item => item.id === 2).result.tools.map(item => item.name),
    ['cuefluent_invocation', 'cuefluent_projects', 'cuefluent_list_notes', 'cuefluent_read_note', 'cuefluent_create_note', 'cuefluent_update_note', 'cuefluent_review_note', 'cuefluent_save_note', 'cuefluent_skip_note']);
  assert.equal(responses.find(item => item.id === 3).result.structuredContent.state, 'expired');
  assert.equal(responses.find(item => item.id === 4).result.isError, true);
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('already running MCP servers discover first-time setup without restarting or writing before setup', async t => {
  for (const client of ['claude', 'codex']) {
    const f = await fixture(t);
    const child = spawn(process.execPath, [entry, 'mcp', client], { cwd: f.cwd,
      env: { ...process.env, CUEFLUENT_V2_HOME: f.storeRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map(), lines = createInterface({ input: child.stdout });
    let nextId = 0, stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const rejectPending = error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
    const closed = new Promise(resolve => child.once('close', code => {
      rejectPending(new Error(`Synthetic MCP closed with code ${code}`)); resolve(code);
    }));
    child.once('error', rejectPending);
    lines.on('line', line => {
      try {
        const response = JSON.parse(line), waiter = pending.get(response.id);
        if (!waiter) return;
        pending.delete(response.id); waiter.resolve(response);
      } catch (error) { rejectPending(error); }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id); reject(new Error('Synthetic MCP response timed out')); child.kill();
      }, process.platform === 'win32' ? 60000 : 20000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const call = async (name, args) => {
      const response = await request('tools/call', { name, arguments: args });
      assert.equal(response.result?.isError, false, JSON.stringify(response));
      return response.result.structuredContent;
    };
    try {
      await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      assert.equal((await call('cuefluent_projects', {})).state, 'unconfigured');
      assert.equal((await call('cuefluent_list_notes', { projectId: 'demo' })).state, 'unconfigured');
      await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
      const configPath = path.join(f.root, 'setup.json');
      await fs.writeFile(configPath, JSON.stringify({ expectedHash: null, project: { id: 'demo', root: f.cwd,
        destination: { kind: 'directory', path: f.notes }, saving: 'auto', activityLog: { enabled: false } } }));
      const setup = await f.run(['setup', '--config', configPath]); assert.equal(setup.code, 0, setup.stderr);
      const projects = await call('cuefluent_projects', {});
      assert.equal(projects.state, 'configured'); assert.equal(projects.projects[0].id, 'demo');
      const saved = await call('cuefluent_create_note', { projectId: 'demo', requestId: 'b37a7cde-a8a3-4b04-9d45-e288a67a8af2',
        target: 'after-setup.md', content: '# Synthetic note\n\n## Decision\nContent supplied after setup.\n', summary: 'Synthetic setup check.' });
      assert.equal(saved.state, 'saved');
      assert.match(await fs.readFile(path.join(f.notes, 'after-setup.md'), 'utf8'), /Content supplied after setup/);
      assert.equal((await call('cuefluent_projects', {})).state, 'configured');
    } finally {
      child.stdin.end();
      const code = await closed;
      lines.close();
      assert.equal(code, 0, stderr);
    }
  }
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

test('both CLI MCP entrypoints save supplied context and return completion without native transcript access', async t => {
  for (const client of ['claude', 'codex']) {
    const f = await fixture(t), configPath = path.join(f.root, 'setup.json');
    await fs.writeFile(configPath, JSON.stringify({ expectedHash: null, project: { id: 'demo', root: f.cwd,
      destination: { kind: 'directory', path: f.notes }, saving: 'auto' } }));
    assert.equal((await f.run(['setup', '--config', configPath])).code, 0);
    // Escaping makes this valid note request larger than the former 64 KiB frame.
    const content = '# Selected context\n\n## Details\n' + 'Use "the chosen detail".\n'.repeat(2600);
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cuefluent_create_note', arguments: {
        projectId: 'demo', requestId: 'b37a7cde-a8a3-4b04-9d45-e288a67a8af2', target: 'context.md', content, summary: 'The requested details.' } } },
    ];
    assert.ok(Buffer.byteLength(JSON.stringify(frames[2])) > 64 * 1024);
    const result = await f.run(['mcp', client], frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
    assert.equal(result.code, 0, result.stderr);
    const reply = result.stdout.trim().split('\n').map(line => JSON.parse(line)).find(item => item.id === 2);
    assert.equal(reply.result.isError, false, JSON.stringify(reply));
    assert.equal(reply.result.structuredContent.state, 'saved');
    assert.ok((await fs.readFile(path.join(f.notes, 'context.md'), 'utf8')).endsWith(content));
    assert.equal(JSON.parse((await f.run(['status', '--project', 'demo'])).stdout).counts.chats, 0);
  }
});
