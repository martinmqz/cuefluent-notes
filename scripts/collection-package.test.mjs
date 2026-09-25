import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildPackages } from './package.mjs';
import { storageFixture } from './test-support/storage-fixture.mjs';
const stamp = '2026-09-24T00:00:00.000Z';
const row = (type, payload) => JSON.stringify({ timestamp: stamp, type, payload }) + '\n';
const turn = (id, text) => row('event_msg', { type: 'task_started', turn_id: id }) + row('event_msg', { type: 'user_message', message: text }) + row('event_msg', { type: 'task_complete', turn_id: id });
const exists = file => fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function until(check, message, diagnostics) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail(`${message}; ${JSON.stringify(await diagnostics())}`);
}

for (const client of ['codex', 'claude']) test(`${client}: shipped lifecycle command launches a private bounded worker and never Markdown processing`, async t => {
  const f = await storageFixture(t), { packages: [pkg] } = await buildPackages({ outDir: path.join(f.root, 'packages'), clients: [client], withHooks: true });
  const config = JSON.parse(await fs.readFile(path.join(pkg.root, 'hooks/hooks.json')));
  assert.deepEqual(Object.keys(config.hooks), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', client === 'codex' ? 'Interrupt' : 'StopFailure']);
  for (const items of Object.values(config.hooks)) { assert.equal(items[0].matcher, undefined); assert.equal(items[0].hooks[0].async, undefined); }
  const sessionId = randomUUID(), a = randomUUID(), b = randomUUID(), source = path.join(f.project, 'native.jsonl');
  let previous = randomUUID();
  const human = (id, text) => { const uuid = randomUUID(), parentUuid = previous; previous = uuid;
    return JSON.stringify({ type: 'user', uuid, timestamp: stamp, sessionId, version: '2.1.280', isSidechain: false,
      parentUuid, cwd: f.project, promptId: id, message: { role: 'user', content: text } }) + '\n'; };
  const header = client === 'codex' ? row('session_meta', { id: sessionId, session_id: sessionId, cwd: f.project, cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' })
    : JSON.stringify({ type: 'system', subtype: 'init', uuid: previous, parentUuid: null, timestamp: stamp, sessionId,
      version: '2.1.280', isSidechain: false, cwd: f.project }) + '\n';
  await fs.writeFile(source, header);
  const env = { ...process.env, NODE_PATH: '', PLUGIN_ROOT: pkg.root, CLAUDE_PLUGIN_ROOT: pkg.root, CUEFLUENT_WORKFLOW_CONFIG: f.options.configPath };
  const invoke = (payload, environment = env) => {
    const handler = config.hooks[payload.hook_event_name][0].hooks[0];
    const result = client === 'claude' ? spawnSync(handler.command, handler.args, { env: environment, cwd: f.root, input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000 })
      : spawnSync(handler.command, { shell: true, env: environment, cwd: f.root, input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); return result;
  };
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: sessionId, [client === 'codex' ? 'turn_id' : 'prompt_id']: a, cwd: f.project, transcript_path: source };
  const absentConfig = path.join(f.root, 'absent.json');
  const before = await fs.readdir(f.collection.intakeStateDir), writerBefore = await fs.readdir(f.collection.notes.writerStateDir);
  assert.equal(invoke(payload, { ...env, CUEFLUENT_WORKFLOW_CONFIG: absentConfig }).stdout, '');
  assert.equal(invoke({ ...payload, agent_id: 'child' }).stdout, '');
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
  assert.equal(await exists(absentConfig), false);
  const registration = invoke(payload); assert.equal(registration.stderr, '');
  assert.match(JSON.parse(registration.stdout).hookSpecificOutput.additionalContext, /no verified current-turn binding/);
  const lock = path.join(f.collection.intakeStateDir, '.intake-lock'), statusFile = path.join(f.collection.intakeStateDir, 'ingress/status/record.json');
  const diagnostics = async () => ({ locked: await exists(lock),
    status: await fs.readFile(statusFile, 'utf8').then(JSON.parse, error => ({ error: error.code })) });
  await until(async () => await exists(statusFile) && !await exists(lock), 'initial detached worker did not finish', diagnostics);
  await fs.appendFile(source, client === 'codex' ? turn(a, 'Excluded boundary') + turn(b, 'Meeting: ship the fixture.') : human(a, 'Excluded boundary') + human(b, 'Meeting: ship the fixture.'));
  const stopped = invoke({ ...payload, hook_event_name: 'Stop', stop_hook_active: false, [client === 'codex' ? 'turn_id' : 'prompt_id']: b });
  assert.equal(stopped.stdout, ''); assert.equal(stopped.stderr, '');
  const headFile = path.join(f.collection.intakeStateDir, 'heads', client, sessionId, `${b}.json`);
  await until(async () => await exists(headFile) && !await exists(lock), 'detached worker did not publish the selected successor', diagnostics);
  assert.equal(await exists(path.join(f.collection.intakeStateDir, 'heads', client, sessionId, `${a}.json`)), false);
  const head = JSON.parse(await fs.readFile(headFile));
  const capturePath = path.join(f.collection.rawDir, client, sessionId, b, `${head.evidenceHash.slice(0, 20)}.json`);
  const capture = JSON.parse(await fs.readFile(capturePath));
  assert.match(JSON.stringify(capture.evidence), /ship the fixture/);
  assert.equal(capture.terminal, client === 'claude' ? 'unconfirmed' : 'completed');
  assert.equal(await exists(f.collection.notes.notesDir), false);
  assert.deepEqual(await fs.readdir(f.collection.notes.writerStateDir), writerBefore);
});
