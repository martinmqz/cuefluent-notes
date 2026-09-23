import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hookResponse } from './hooks.mjs';
import { recordCompletion } from './capture-completion.mjs';
import { initialize, setupStatus } from './setup.mjs';

async function fixture(t, client) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-stop-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notesDir = path.join(root, 'notes');
  await fs.mkdir(notesDir);
  const configPath = path.join(root, 'config.json');
  await initialize({ client, mode: 'suggest', project: root, notesDir, scope: 'Verified decisions.',
    configPath, completionCheck: true, confirmCompatibleClients: true });
  const config = JSON.parse(await fs.readFile(configPath));
  const payload = { permission_mode: 'default', hook_event_name: 'UserPromptSubmit', session_id: 'session', cwd: root,
    [client === 'codex' ? 'turn_id' : 'prompt_id']: 'native-turn',
    prompt: 'PRIVATE_PROMPT', transcript_path: '/missing/PRIVATE_TRANSCRIPT', last_assistant_message: 'PRIVATE_ANSWER' };
  const invoke = (event, changes = {}, policy = config) => hookResponse(client,
    { ...payload, hook_event_name: event, ...changes }, policy, { configPath });
  return { root, notesDir, configPath, config, payload, invoke, client, stateDir: config.routes[0].stateDir };
}
const operation = output => JSON.parse((output.reason ?? output.hookSpecificOutput.additionalContext).split('\n\n').at(-1));
function completionInput(op, outcome) {
  const { helper, ...completion } = op.completion;
  return { ...completion, client: op.client, session_id: op.session_id,
    [op.client === 'codex' ? 'turn_id' : 'prompt_id']: op[op.client === 'codex' ? 'turn_id' : 'prompt_id'], outcome };
}

for (const client of ['codex', 'claude']) {
  test(`${client}: a missing decision gets one read-only recovery; a proposal settles it without approval`, async t => {
    const f = await fixture(t, client);
    const prompt = await f.invoke('UserPromptSubmit');
    const op = operation(prompt);
    assert.equal(op.completion.configPath, f.configPath);
    assert.equal(await f.invoke('Stop', { stop_hook_active: false }), null);
    const prior = completionInput(op, 'no-change');
    prior[client === 'codex' ? 'turn_id' : 'prompt_id'] = 'previous-turn';
    await recordCompletion(prior);
    const stop = await f.invoke('Stop', { stop_hook_active: false });
    assert.equal(stop.decision, 'block');
    assert.deepEqual(operation(stop), op);
    assert.doesNotMatch(JSON.stringify(stop), /PRIVATE_/);
    assert.match(stop.reason, /original native identity/);
    assert.doesNotMatch(stop.reason, /continue the task|Before completing eligible work/);
    assert.match(stop.reason, /never wait for an answer/);
    assert.match(stop.reason, /Read-only instructions and all-logging opt-outs forbid marker writes/);
    assert.match(stop.reason, /Do not autosave or write notes without explicit user approval/);
    assert.deepEqual(await fs.readdir(f.notesDir), []);
    // Codex may assign a new continuation ID; the guard wins before any policy read.
    assert.equal(await f.invoke('Stop', { stop_hook_active: true, turn_id: 'recovery', prompt_id: 'recovery' }, { invalid: true }), null);
    await recordCompletion(completionInput(op, 'proposed'));
    assert.equal(await f.invoke('Stop', { stop_hook_active: false }), null);
    assert.deepEqual(await fs.readdir(f.notesDir), []);
    const next = await f.invoke('Stop', { stop_hook_active: false,
      [client === 'codex' ? 'turn_id' : 'prompt_id']: 'next-user-turn' });
    assert.equal(next.decision, 'block');
  });

  test(`${client}: missing guards/identity, subagents, disabled and unselected policies never continue`, async t => {
    const f = await fixture(t, client);
    for (const stop_hook_active of [undefined, null, true, 0, 'false']) {
      assert.equal(await f.invoke('Stop', { stop_hook_active }), null);
    }
    for (const change of [{ agent_id: 'child' }, { session_id: undefined }, { cwd: 'relative' },
      { [client === 'codex' ? 'turn_id' : 'prompt_id']: undefined }]) {
      assert.equal(await f.invoke('Stop', { stop_hook_active: false, ...change }), null);
    }
    for (const change of [{ enabled: false }, { completionCheck: false }, { clients: [] },
      { exclude: [f.root] }, { routes: [] }, { routes: [{ ...f.config.routes[0], enabled: false }] }]) {
      assert.equal(await f.invoke('Stop', { stop_hook_active: false }, { ...f.config, ...change }), null);
    }
    const { completionCheck, ...old } = f.config;
    assert.equal(await f.invoke('Stop', { stop_hook_active: false }, { ...old, version: 2, minimumPluginVersion: '0.5.1' }), null);
    assert.equal(await f.invoke('Stop', { stop_hook_active: false }, null), null);
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  });

  test(`${client}: busy, corrupt and pending state or oversized policy never requests recovery`, async t => {
    const f = await fixture(t, client);
    const op = operation(await f.invoke('UserPromptSubmit'));
    await recordCompletion(completionInput(op, 'no-change'));
    const dir = path.join(f.stateDir, 'capture-completion');
    const file = path.join(dir, (await fs.readdir(dir))[0]);
    await fs.writeFile(file, '{');
    const corrupt = await f.invoke('Stop', { stop_hook_active: false });
    assert.equal(corrupt.decision, undefined);
    assert.ok(corrupt.systemMessage);
    assert.match(corrupt.systemMessage, /completion check skipped.*marker state/);
    assert.doesNotMatch(corrupt.systemMessage, /configuration/);
    await fs.unlink(file);
    for (const [name, body] of [['.lock', null], ['journal.json', '{}'], ['manifest.json', '{}']]) {
      const entry = path.join(f.stateDir, name);
      if (body === null) await fs.mkdir(entry); else await fs.writeFile(entry, body);
      const before = await fs.readdir(f.stateDir);
      const output = await f.invoke('Stop', { stop_hook_active: false });
      assert.equal(output.decision, undefined);
      assert.ok(output.systemMessage);
      assert.deepEqual(await fs.readdir(f.stateDir), before);
      await fs.rm(entry, { recursive: true });
    }
    const oversized = await f.invoke('Stop', { stop_hook_active: false }, { ...f.config, scope: '界'.repeat(2000) });
    assert.equal(oversized, null);
    assert.deepEqual(await fs.readdir(dir), []);
    assert.deepEqual(await fs.readdir(f.notesDir), []);
  });
}

test('setup opts in explicitly for either storage type and reports completion status without creating markers', async t => {
  const f = await fixture(t, 'codex');
  assert.equal((await setupStatus({ client: 'codex', cwd: f.root, configPath: f.configPath })).completionCheck, true);
  const base = { client: 'claude', mode: 'suggest', project: f.root, destination: path.join(f.notesDir, 'topic.md'),
    scope: 'decisions', configPath: path.join(f.root, 'file-policy.json'), completionCheck: true };
  await assert.rejects(initialize(base), { code: 'CLIENT_UPGRADE_REQUIRED' });
  await assert.rejects(fs.stat(base.configPath), { code: 'ENOENT' });
  await initialize({ ...base, confirmCompatibleClients: true });
  assert.equal(JSON.parse(await fs.readFile(base.configPath)).version, 3);
  await assert.rejects(initialize({ client: 'codex', mode: 'manual', completionCheck: true,
    configPath: path.join(f.root, 'manual.json') }), /Completion checks/);
  await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
});

test('Stop CLI emits an exit-zero continuation only on an explicit first Stop', async t => {
  const f = await fixture(t, 'codex');
  const op = operation(await f.invoke('UserPromptSubmit'));
  await recordCompletion({ ...completionInput(op, 'no-change'), turn_id: 'previous-turn' });
  const script = fileURLToPath(new URL('./hooks.mjs', import.meta.url));
  for (const stop_hook_active of [false, true, undefined]) {
    const result = spawnSync(process.execPath, [script, 'codex', '--config', f.configPath], {
      cwd: f.root, input: JSON.stringify({ ...f.payload, hook_event_name: 'Stop', stop_hook_active }), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    if (stop_hook_active === false) assert.equal(JSON.parse(result.stdout).decision, 'block');
    else assert.equal(result.stdout, '');
  }
});

test('malformed or unreadable config never adds a Stop warning before opt-in can be established', async t => {
  const f = await fixture(t, 'codex');
  const script = fileURLToPath(new URL('./hooks.mjs', import.meta.url));
  for (const contents of ['{"version": 2,', 'null', '\ufffd']) {
    await fs.writeFile(f.configPath, contents);
    for (const hook_event_name of ['Stop', 'UserPromptSubmit']) {
      const result = spawnSync(process.execPath, [script, 'codex', '--config', f.configPath], {
        input: JSON.stringify({ ...f.payload, hook_event_name, stop_hook_active: false }), encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      if (hook_event_name === 'Stop') assert.equal(result.stdout, '');
      else assert.match(result.stdout, /could not be read safely/);
    }
  }
  await fs.unlink(f.configPath);
  await fs.mkdir(f.configPath);
  const unreadable = spawnSync(process.execPath, [script, 'codex', '--config', f.configPath], {
    input: JSON.stringify({ ...f.payload, hook_event_name: 'Stop', stop_hook_active: false }), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(unreadable.stdout, '');
});

test('unverified access and plan, unknown or changed permission modes do not force recovery', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, client);
    assert.equal(await f.invoke('Stop', { stop_hook_active: false }), null);
    const op = operation(await f.invoke('UserPromptSubmit'));
    await recordCompletion({ ...completionInput(op, 'no-change'),
      [client === 'codex' ? 'turn_id' : 'prompt_id']: 'prior-turn' });
    for (const permission_mode of ['plan', undefined, 'unknown', 'acceptEdits']) {
      assert.equal(await f.invoke('Stop', { stop_hook_active: false, permission_mode }), null);
      const prompt = operation(await f.invoke('UserPromptSubmit', { permission_mode }));
      if (permission_mode !== 'acceptEdits') assert.equal(prompt.completion, undefined);
    }
    assert.equal((await f.invoke('Stop', { stop_hook_active: false })).decision, 'block');
    assert.deepEqual(await fs.readdir(f.notesDir), []);
  }
});

test('opting into completion preserves ordinary capture at the previous context-size boundary', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, client);
    const { completionCheck, ...base } = f.config;
    const legacy = { ...base, version: 2, minimumPluginVersion: '0.5.1', scope: '界'.repeat(1500) };
    const before = await f.invoke('UserPromptSubmit', {}, legacy);
    assert.doesNotMatch(before.hookSpecificOutput.additionalContext, /capture is skipped/);
    const enabled = { ...legacy, version: 3, minimumPluginVersion: '0.6.0', completionCheck: true };
    const output = await f.invoke('UserPromptSubmit', {}, enabled);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /capture is skipped/);
    assert.ok(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 8000);
    const op = operation(output);
    assert.equal(op.scope, legacy.scope);
    await fs.writeFile(f.configPath, JSON.stringify(enabled));
    if (op.completion) {
      await recordCompletion({ ...completionInput(op, 'no-change'),
        [client === 'codex' ? 'turn_id' : 'prompt_id']: 'previous-turn' });
      const stop = await f.invoke('Stop', { stop_hook_active: false }, enabled);
      assert.equal(stop.decision, 'block');
      assert.ok(Buffer.byteLength(stop.reason) <= 8000);
    } else assert.equal(await f.invoke('Stop', { stop_hook_active: false }, enabled), null);
    // A long but valid explicit config path can exhaust the optional metadata
    // budget: preserve ordinary guidance rather than disabling capture.
    const longConfigPath = path.join(f.root, 'a'.repeat(3000));
    const fallback = await hookResponse(client, f.payload, enabled, { configPath: longConfigPath });
    assert.doesNotMatch(fallback.hookSpecificOutput.additionalContext, /capture is skipped/);
    assert.equal(operation(fallback).completion, undefined);
    assert.equal(await hookResponse(client, { ...f.payload, hook_event_name: 'Stop', stop_hook_active: false },
      enabled, { configPath: longConfigPath }), null);
  }
});
