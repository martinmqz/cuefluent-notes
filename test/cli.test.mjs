import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withoutFfiNotice } from './fixtures/runtime-stderr.mjs';

const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storeRoot = path.join(root, 'private'), cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd);
  const run = (args, input = '', entryPath = entry, nodeArgs = [], env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, entryPath, ...args], { cwd, env: { ...process.env, CUEFLUENT_V2_HOME: storeRoot, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr: withoutFfiNotice(stderr, child.pid) })); child.stdin.end(input);
  });
  return { root, storeRoot, cwd, notes, run };
}

test('unsupported runtimes report the detected version before importing a missing runtime module', async t => {
  const f = await fixture(t), copy = path.join(f.root, 'incomplete-package'), src = path.join(copy, 'src');
  await fs.mkdir(src, { recursive: true });
  for (const file of ['cli.mjs', 'diagnostics.mjs']) await fs.copyFile(new URL(`../src/${file}`, import.meta.url), path.join(src, file));
  const preload = path.join(f.root, 'synthetic runtime # %.mjs');
  for (const version of ['24.22.1', '26.2.0']) {
    await fs.writeFile(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });`);
    const result = await f.run(['mcp', 'codex'], '', path.join(src, 'cli.mjs'), ['--import', pathToFileURL(preload).href]);
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /NODE_VERSION_UNSUPPORTED/); assert.match(result.stderr, /26\.12\.1/);
    assert.match(result.stderr, /Next step:/); assert.match(result.stderr, /restart/);
    const details = JSON.parse(result.stderr.split('Diagnostics: ')[1]);
    assert.equal(details.nodeVersion, version); assert.equal(details.executable, process.execPath);
    assert.equal(details.stage, 'runtime-check'); assert.equal(details.client, 'codex');
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    const hook = await f.run(['hook', 'claude'], '{}', path.join(src, 'cli.mjs'), ['--import', pathToFileURL(preload).href]);
    assert.equal(hook.code, 0); assert.equal(hook.stderr, '');
    assert.match(JSON.parse(hook.stdout).systemMessage, /NODE_VERSION_UNSUPPORTED/);
  }
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('a missing runtime module produces reinstall guidance without dumping its exception path or stack', async t => {
  const f = await fixture(t), src = path.join(f.root, 'synthetic-private-path', 'src');
  await fs.mkdir(path.join(src, 'core'), { recursive: true });
  for (const file of ['cli.mjs', 'diagnostics.mjs', 'core/errors.mjs']) await fs.copyFile(new URL(`../src/${file}`, import.meta.url), path.join(src, file));
  const result = await f.run(['mcp', 'claude'], '', path.join(src, 'cli.mjs'));
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/); assert.match(result.stderr, /Reinstall/);
  assert.equal(JSON.parse(result.stderr.split('Diagnostics: ')[1]).stage, 'module-load');
  assert.doesNotMatch(result.stderr, /synthetic-private-path|node:internal/);
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('missing diagnostics and error modules still produce private-safe CLI and hook failures', async t => {
  const f = await fixture(t), src = path.join(f.root, 'synthetic-private-package', 'src');
  await fs.mkdir(src, { recursive: true });
  await fs.copyFile(new URL('../src/cli.mjs', import.meta.url), path.join(src, 'cli.mjs'));
  await fs.writeFile(path.join(src, 'runtime-entry.mjs'), "import { fail } from './core/errors.mjs'; export function main() { fail('UNREACHABLE', 'Unreachable'); }\n");
  for (const [missing, code] of [['diagnostics', 'CUEFLUENT_BOOTSTRAP_FAILED'], ['errors', 'ERR_MODULE_NOT_FOUND']]) {
    if (missing === 'errors') await fs.copyFile(new URL('../src/diagnostics.mjs', import.meta.url), path.join(src, 'diagnostics.mjs'));
    for (const command of ['mcp', 'hook']) {
      const result = await f.run([command, 'claude'], '{}', path.join(src, 'cli.mjs'));
      assert.equal(result.code, command === 'hook' ? 0 : 1);
      const message = command === 'hook' ? JSON.parse(result.stdout).systemMessage : result.stderr;
      assert.equal(command === 'hook' ? result.stderr : result.stdout, '');
      assert.ok(message.includes(code)); assert.match(message, /Reinstall/);
      assert.equal(JSON.parse(message.split('Diagnostics: ')[1]).stage, 'module-load');
      assert.doesNotMatch(message, /synthetic-private-package|node:internal|Unreachable/);
    }
  }
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('the self-contained bootstrap report tolerates synchronous and asynchronous output failures', async t => {
  const f = await fixture(t), src = path.join(f.root, 'incomplete-package', 'src'), preload = path.join(f.root, 'broken-output.mjs');
  await fs.mkdir(src, { recursive: true });
  await fs.copyFile(new URL('../src/cli.mjs', import.meta.url), path.join(src, 'cli.mjs'));
  for (const command of ['mcp', 'hook']) for (const asynchronous of [false, true]) {
    const stream = command === 'hook' ? 'stdout' : 'stderr';
    await fs.writeFile(preload, `const stream = process.${stream}; stream.write = () => {
      const error = Object.assign(new Error('synthetic-private-output'), { code: 'EPIPE' });
      ${asynchronous ? "queueMicrotask(() => stream.emit('error', error)); return false;" : 'throw error;'}
    };`);
    const result = await f.run([command, 'claude'], '{}', path.join(src, 'cli.mjs'), ['--import', pathToFileURL(preload).href]);
    assert.equal(result.code, command === 'hook' ? 0 : 1);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});

test('importing the CLI API runs no command and does not need the remaining package', async t => {
  const f = await fixture(t), copy = path.join(f.root, 'api.mjs'), runner = path.join(f.root, 'import-only.mjs');
  await fs.copyFile(entry, copy);
  await fs.writeFile(runner, `const api = await import(${JSON.stringify(pathToFileURL(copy).href)}); process.stdout.write(typeof api.main);`);
  const result = await f.run(['settings'], '', runner);
  assert.deepEqual(result, { code: 0, stdout: 'function', stderr: '' });
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('hook ACL budgets include process startup and reserve time for the reply', async t => {
  const f = await fixture(t), preload = path.join(f.root, 'hook-startup.mjs');
  const acl = new URL('../src/storage/windows-acl.mjs', import.meta.url).href;
  // A deterministic process clock represents time consumed before runtime.main.
  // Intercept only the deadline boundary so no real store/helper is opened.
  for (const [client, event, elapsed, expected] of [
    ['codex', 'SessionEnd', 2300, 200], ['codex', 'Interrupt', 2800, 0],
    ['codex', 'SessionStart', 2300, 7200], ['claude', 'SessionEnd', 2300, 7200],
  ]) {
    const replacement = `export function queryWindowsAcl() { throw new Error('Unexpected ACL query'); }
      export function withWindowsAclDeadline(fn, { timeoutMs }) { process.stdout.write(JSON.stringify({ timeoutMs }) + '\\n'); }`;
    await fs.writeFile(preload, `import { registerHooks } from 'node:module';
      Object.defineProperty(performance, 'now', { value: () => ${elapsed} });
      registerHooks({ load(url, context, nextLoad) {
        if (url === ${JSON.stringify(acl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(replacement)} };
        return nextLoad(url, context);
      } });`);
    const result = await f.run(['hook', client], JSON.stringify({ hook_event_name: event }), entry, ['--import', pathToFileURL(preload).href]);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).timeoutMs, expected);
  }
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('CLI and hook failures report a package version only after its identity is validated', async t => {
  const f = await fixture(t), version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const result = await f.run(['setup', '--config', path.join(f.root, 'missing-setup.json')]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr.split('Diagnostics: ')[1]).pluginVersion, version);
  for (const client of ['claude', 'codex']) {
    const hook = await f.run(['hook', client], '{"synthetic-private-input":');
    assert.equal(hook.code, 0); assert.equal(hook.stderr, '');
    const message = JSON.parse(hook.stdout).systemMessage;
    assert.equal(JSON.parse(message.split('Diagnostics: ')[1]).pluginVersion, version);
    assert.doesNotMatch(message, /synthetic-private-input/);
  }
  const invalid = await f.run(['not-a-command']);
  assert.equal(invalid.code, 1);
  assert.equal(Object.hasOwn(JSON.parse(invalid.stderr.split('Diagnostics: ')[1]), 'pluginVersion'), false);
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

test('valid CLI and hook commands explain an invalid store-root override without exposing its value', async t => {
  const f = await fixture(t), override = 'relative-private-value';
  for (const args of [['settings'], ['mcp', 'claude'], ['mcp', 'codex'], ['hook', 'claude'], ['hook', 'codex']]) {
    const result = await f.run(args, '{}', entry, [], { CUEFLUENT_V2_HOME: override }), hook = args[0] === 'hook';
    assert.equal(result.code, hook ? 0 : 1);
    assert.equal(hook ? result.stderr : result.stdout, '');
    const message = hook ? JSON.parse(result.stdout).systemMessage : result.stderr;
    assert.match(message, /^Cuefluent Notes \[ENTRY_STORE_ROOT_INVALID\]:/);
    assert.match(message, /Next step: Correct CUEFLUENT_V2_HOME/);
    assert.doesNotMatch(message, /relative-private-value/);
    const diagnostics = JSON.parse(message.split('Diagnostics: ')[1]);
    assert.equal(diagnostics.stage, 'command'); assert.equal(diagnostics.operation, args[0]);
  }
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.cwd, override)), { code: 'ENOENT' });
});

test('fatal MCP framing failures are reported on stderr without echoing input or corrupting protocol output', async t => {
  const f = await fixture(t);
  for (const [input, code] of [['{"synthetic-private-input": broken}\n', 'MCP_FRAME_INVALID'], ['{"synthetic-private-input":', 'MCP_FRAME_INCOMPLETE']]) {
    const result = await f.run(['mcp', 'claude'], input);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.ok(result.stderr.includes(code));
    assert.match(result.stderr, /Next step:/); assert.doesNotMatch(result.stderr, /synthetic-private-input/);
    assert.equal(JSON.parse(result.stderr.split('Diagnostics: ')[1]).stage, 'transport');
  }
  await assert.rejects(fs.access(f.storeRoot), { code: 'ENOENT' });
});

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
test('the older-Node entry fallback recognizes preserved main symlinks and leaves imports inert', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), src = path.join(f.root, 'package', 'src'), preload = path.join(f.root, 'older-entry.mjs');
  await fs.mkdir(src, { recursive: true });
  for (const file of ['cli.mjs', 'diagnostics.mjs']) await fs.copyFile(new URL(`../src/${file}`, import.meta.url), path.join(src, file));
  const alias = path.join(src, 'alias.mjs'), runner = path.join(f.root, 'import-only.mjs');
  await fs.symlink(path.join(src, 'cli.mjs'), alias);
  await fs.writeFile(preload, `import { registerHooks } from 'node:module';
    Object.defineProperty(process.versions, 'node', { value: '24.22.1' });
    registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if ([${JSON.stringify(pathToFileURL(alias).href)}, ${JSON.stringify(pathToFileURL(path.join(src, 'cli.mjs')).href)}].includes(url)) {
        return { ...result, source: String(result.source).replaceAll('import.meta.main', 'undefined') };
      }
      return result;
    } });`);
  const nodeArgs = ['--preserve-symlinks-main', '--import', pathToFileURL(preload).href];
  const result = await f.run(['settings'], '', alias, nodeArgs);
  assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /NODE_VERSION_UNSUPPORTED/);
  await fs.writeFile(runner, `const api = await import(${JSON.stringify(pathToFileURL(alias).href)}); process.stdout.write(typeof api.main);`);
  assert.deepEqual(await f.run(['settings'], '', runner, nodeArgs), { code: 0, stdout: 'function', stderr: '' });
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
