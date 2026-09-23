import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hookResponse } from './hooks.mjs';

const hookScript = fileURLToPath(new URL('./hooks.mjs', import.meta.url));
const text = response => response?.hookSpecificOutput?.additionalContext ?? '';
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-hook-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const nested = path.join(project, 'nested');
  const notes = path.join(directory, 'notes');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(notes);
  const destination = path.join(notes, 'knowledge.md');
  const stateDir = path.join(directory, 'state');
  const config = { version: 1, enabled: true, clients: ['codex', 'claude'], automaticUpdates: true,
    scope: 'Verified feature behavior and decisions established in the current task.',
    routes: [{ projectRoot: project, destination, stateDir }] };
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'session-A', turn_id: 'turn-1', prompt_id: 'prompt-1', cwd: nested,
    prompt: 'PRIVATE_PROMPT_SENTINEL', transcript_path: '/missing/PRIVATE_TRANSCRIPT_SENTINEL', last_assistant_message: 'PRIVATE_ANSWER_SENTINEL' };
  return { directory, project, nested, notes, destination, stateDir, config, payload };
}
test('both clients inject their own native identity and selected workflow without payload content', async t => {
  const { config, payload, destination } = await fixture(t);
  for (const [client, id] of [['codex', 'turn-1'], ['claude', 'prompt-1']]) {
    const response = await hookResponse(client, payload, config);
    assert.equal(response.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(text(response).includes(destination));
    assert.ok(text(response).includes('session-A'));
    assert.ok(text(response).includes(id));
    assert.ok(!JSON.stringify(response).includes('PRIVATE_'));
    assert.ok(!('decision' in response));
  }
});
test('disabled or unselected clients and unsupported/subagent events produce no capture response', async t => {
  const { config, payload } = await fixture(t);
  assert.equal(await hookResponse('codex', payload, { ...config, enabled: false }), null);
  assert.equal(await hookResponse('codex', payload, { ...config, clients: ['claude'] }), null);
  for (const hook_event_name of ['SessionStart', 'Stop', 'SubagentStop', 'PostToolUse']) {
    assert.equal(await hookResponse('codex', { ...payload, hook_event_name }, config), null);
  }
  assert.equal(await hookResponse('claude', { ...payload, agent_id: 'subagent-A' }, config), null);
  assert.ok(await hookResponse('claude', { ...payload, agent_type: 'configured-root-agent' }, config));
});
test('missing unrelated project roots do not disable an otherwise valid route', async t => {
  const { config, payload, directory, destination, stateDir } = await fixture(t);
  const response = await hookResponse('codex', payload, { ...config,
    exclude: [path.join(directory, 'unavailable-excluded-project')],
    routes: [...config.routes, { projectRoot: path.join(directory, 'unavailable-project'), destination, stateDir }] });
  assert.ok(text(response).includes(destination));
  assert.ok(text(response).includes('turn-1'));
});
test('missing native identity does not borrow the other host identity', async t => {
  const { config, payload } = await fixture(t);
  assert.equal(await hookResponse('codex', { ...payload, turn_id: undefined }, config), null);
  assert.equal(await hookResponse('claude', { ...payload, prompt_id: undefined }, config), null);
  assert.equal(await hookResponse('codex', { ...payload, session_id: undefined }, config), null);
});
test('longest project route wins and exclusions or disabled routes suppress capture', async t => {
  const { config, payload, nested, notes, stateDir, destination } = await fixture(t);
  const preciseDestination = path.join(notes, 'precise.md');
  const routed = { ...config, routes: [...config.routes, { projectRoot: nested, destination: preciseDestination, stateDir }] };
  const response = await hookResponse('codex', payload, routed);
  assert.ok(text(response).includes(preciseDestination));
  assert.ok(!text(response).includes(destination));
  assert.equal(await hookResponse('codex', payload, { ...routed, exclude: [nested] }), null);
  routed.routes[1].enabled = false;
  assert.equal(await hookResponse('codex', payload, routed), null);
});
test('unrouted sessions are quiet and ambiguous selected routes receive setup guidance', async t => {
  const { config, payload } = await fixture(t);
  assert.equal(await hookResponse('codex', payload, { ...config, routes: [] }), null);
  assert.equal(await hookResponse('codex', { ...payload, cwd: path.dirname(config.routes[0].projectRoot) }, config), null);
  const ambiguous = await hookResponse('codex', payload, { ...config, routes: [...config.routes, { ...config.routes[0] }] });
  for (const response of [ambiguous]) {
    assert.equal(response.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(text(response), /rout|destination/i);
    assert.match(text(response), /skip|do not|no automatic/i);
    assert.ok(!('decision' in response));
  }
});
test('default route applies across unrelated eligible projects; proposal-only policy does not authorize autosave', async t => {
  const { config, payload, directory } = await fixture(t);
  const fallback = { ...config, routes: [], defaultRoute: { destination: config.routes[0].destination, stateDir: config.routes[0].stateDir }, automaticUpdates: false };
  const response = await hookResponse('codex', { ...payload, cwd: directory }, fallback);
  assert.match(text(response), /propos|preview/i);
  assert.match(text(response), /no automatic|do not (?:auto|save|write)|automaticUpdates.*false/i);
});
test('replayed and cross-session reminders remain stateless and never create notes or receipts', async t => {
  const { config, payload, directory, destination } = await fixture(t);
  await fs.writeFile(destination, '# T\n\n## Captured\n\nAlready recorded manually.\n');
  const before = await fs.stat(destination, { bigint: true });
  const listing = await fs.readdir(directory);
  const initial = await hookResponse('codex', payload, config);
  assert.deepEqual(await hookResponse('codex', payload, config), initial);
  const anotherSession = await hookResponse('codex', { ...payload, session_id: 'session-B', turn_id: 'turn-2' }, config);
  assert.ok(text(anotherSession).includes('session-B'));
  assert.deepEqual(await fs.readdir(directory), listing);
  assert.equal((await fs.stat(destination, { bigint: true })).mtimeNs, before.mtimeNs);
});
test('a new note cannot also be the parent of its state directory', async t => {
  const { config, payload, destination } = await fixture(t);
  config.routes[0].stateDir = path.join(destination, 'state');
  const response = await hookResponse('codex', payload, config);
  assert.match(text(response), /skipped|invalid/i);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});
test('CLI ignores transcript/prompt fields and keeps malformed input out of errors', async t => {
  const { config, payload, directory } = await fixture(t);
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const run = input => spawnSync(process.execPath, [hookScript, 'codex', '--config', configPath], { input, encoding: 'utf8' });
  const good = run(JSON.stringify(payload));
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(!`${good.stdout}${good.stderr}`.includes('PRIVATE_'));
  const malformed = run('{"prompt":SECRET_BAD_JSON}');
  assert.equal(malformed.status, 0);
  assert.ok(!`${malformed.stdout}${malformed.stderr}`.includes('SECRET_BAD_JSON'));
  const absent = spawnSync(process.execPath, [hookScript, 'claude', '--config', path.join(directory, 'absent.json')], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(absent.status, 0);
  assert.equal(absent.stdout, '');
  assert.equal(absent.stderr, '');
  await fs.writeFile(configPath, 'null');
  const nullConfig = run(JSON.stringify(payload));
  assert.equal(nullConfig.status, 0);
  assert.match(text(JSON.parse(nullConfig.stdout)), /skipped|invalid|could not/i);
  const invalidStartup = run(JSON.stringify({ ...payload, hook_event_name: 'SessionStart', source: 'startup' }));
  assert.equal(invalidStartup.status, 0);
  const startupWarning = JSON.parse(invalidStartup.stdout);
  assert.deepEqual(Object.keys(startupWarning), ['systemMessage']);
  assert.match(startupWarning.systemMessage, /skipped/);
});

test('unconfigured startup shows only a host notice and subsequent prompts stay silent', async t => {
  const { directory, payload, destination, stateDir } = await fixture(t);
  const configPath = path.join(directory, 'private/new-config.json');
  const before = await fs.readdir(directory);
  const startup = { ...payload, hook_event_name: 'SessionStart', source: 'startup', turn_id: undefined, prompt_id: undefined };
  for (const client of ['codex', 'claude']) {
    const output = await hookResponse(client, startup, null);
    assert.deepEqual(Object.keys(output), ['systemMessage']);
    assert.deepEqual(await hookResponse(client, { ...startup, agent_type: 'configured-root-agent' }, null), output);
    assert.match(output.systemMessage, /capture is off.*Set up Cuefluent Notes/);
    const serialized = JSON.stringify(output);
    for (const privateValue of [destination, stateDir, configPath, 'PRIVATE_']) assert.ok(!serialized.includes(privateValue));
    assert.ok(Buffer.byteLength(serialized) < 300);
    for (let turn = 1; turn <= 3; turn++) {
      assert.equal(await hookResponse(client, { ...payload, turn_id: `turn-${turn}`, prompt_id: `prompt-${turn}` }, null), null);
    }
    for (const source of ['resume', 'compact', 'clear', 'fork', undefined]) {
      assert.equal(await hookResponse(client, { ...startup, source }, null), null);
    }
    for (const invalid of [{ agent_id: 'child' }, { session_id: undefined }, { cwd: 'relative' }]) {
      assert.equal(await hookResponse(client, { ...startup, ...invalid }, null), null);
    }
    const run = input => spawnSync(process.execPath, [hookScript, client, '--config', configPath], { input: JSON.stringify(input), encoding: 'utf8' });
    const start = run(startup);
    assert.equal(start.status, 0, start.stderr);
    assert.deepEqual(JSON.parse(start.stdout), output);
    const prompt = run(payload);
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.equal(prompt.stdout, '');
  }
  assert.deepEqual(await fs.readdir(directory), before);
});

test('startup distinguishes unselected clients and preserves global disablement', async t => {
  const { config, payload } = await fixture(t);
  const startup = { ...payload, hook_event_name: 'SessionStart', source: 'startup' };
  for (const client of ['codex', 'claude']) {
    const other = client === 'codex' ? 'claude' : 'codex';
    assert.equal(await hookResponse(client, startup, config), null);
    assert.equal(await hookResponse(client, startup, { ...config, exclude: [payload.cwd] }), null);
    assert.ok((await hookResponse(client, startup, { ...config, clients: [other] })).systemMessage.includes('Set up Cuefluent Notes'));
    assert.equal(await hookResponse(client, startup, { ...config, enabled: false, clients: [other] }), null);
    const malformed = await hookResponse(client, startup, { ...config, clients: 'invalid' });
    assert.deepEqual(Object.keys(malformed), ['systemMessage']);
    assert.match(malformed.systemMessage, /skipped/);
    assert.ok(!malformed.systemMessage.includes('Set up Cuefluent Notes'));
  }
});

test('unrelated non-directory and inaccessible roots leave an active route usable', async t => {
  const { config, payload, directory, destination, stateDir } = await fixture(t);
  const blocked = path.join(directory, 'archive');
  await fs.writeFile(blocked, 'synthetic archive');
  const denied = path.join(directory, 'denied');
  await fs.mkdir(denied);
  const realpath = fs.realpath;
  t.mock.method(fs, 'realpath', async file => {
    if (file === path.join(denied, 'project')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realpath(file);
  });
  for (const unavailable of [blocked, path.join(blocked, 'project'), path.join(denied, 'project')]) {
    const response = await hookResponse('codex', payload, { ...config, exclude: [unavailable],
      routes: [...config.routes, { projectRoot: unavailable, destination, stateDir, enabled: false }] });
    assert.ok(text(response).includes(destination));
    assert.ok(text(response).includes('turn-1'));
  }
});
test('an inaccessible root that could govern this session fails closed', async t => {
  const { config, payload, project } = await fixture(t);
  const unknown = path.join(project, 'unknown-alias');
  const realpath = fs.realpath;
  t.mock.method(fs, 'realpath', async file => {
    if (file === unknown) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realpath(file);
  });
  for (const policy of [{ ...config, exclude: [unknown] }, { ...config,
    routes: [...config.routes, { ...config.routes[0], projectRoot: unknown, enabled: false }] }]) {
    assert.match(text(await hookResponse('codex', payload, policy)), /capture is skipped/);
  }
});
