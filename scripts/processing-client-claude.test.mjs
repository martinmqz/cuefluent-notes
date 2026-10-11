import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CLAUDE_TEST_TOOLS as TOOLS, claudeHarness, initialization, completed, success } from './test-support/claude-client.mjs';
import { createClaudeProcessingClient } from './processing-client-claude.mjs';

const cwd = path.resolve('synthetic-processing');
function harness(run) {
  const h = claudeHarness(run);
  const client = createClaudeProcessingClient({ executable: 'claude', cwd,
    engine: { command: process.execPath, args: ['synthetic-engine.mjs'] }, allowedTools: TOOLS, spawn: h.spawn, timeoutMs: 1000 });
  return { ...h, client };
}
function request(sessionId = randomUUID(), changes = {}) {
  return { sessionId, inputId: randomUUID(), resume: false, prompt: 'Process the selected synthetic operation.', beforeDispatch: async () => {}, ...changes };
}
test('Claude create/resume uses one native UUID and only the selected engine, after reservation', async () => {
  const h = harness(success), id = randomUUID(), gates = [], events = [];
  const gate = async state => { assert.equal(h.calls.length, gates.length); gates.push(state); };
  const first = await h.client.run(request(id, { beforeDispatch: gate, onEvent: event => events.push(event) }));
  const second = await h.client.run(request(id, { resume: true, beforeDispatch: gate }));
  assert.equal(first.sessionId, id); assert.equal(second.sessionId, id);
  assert.equal(first.status, 'completed'); assert.equal(first.desktopVisibility, 'unverified');
  assert.equal(first.model, 'synthetic-model'); assert.equal(events.length, 2);
  assert.equal(events[1].inputId, first.inputId); assert.equal(gates[0].inputId, first.inputId);
  assert.deepEqual(gates.map(value => value.resume), [false, true]);
  for (const [index, { executable, args, options }] of h.calls.entries()) {
    assert.equal(executable, 'claude'); assert.equal(options.shell, false); assert.equal(options.cwd, cwd);
    assert.equal(args.at(-2), index ? '--resume' : '--session-id'); assert.equal(args.at(-1), id);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json'); assert.ok(args.includes('--replay-user-messages'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true });
    assert.deepEqual(Object.keys(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers), ['cuefluent_engine']);
    for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag));
    for (const flag of ['--bg', '--bare', '--continue', '--fork-session', '--dangerously-skip-permissions']) assert.ok(!args.includes(flag));
  }
});

test('failed reservation and pre-dispatch interruption create no native process', async () => {
  const h = harness(success), controller = new AbortController(); controller.abort();
  await assert.rejects(h.client.run(request(undefined, { signal: controller.signal })), { code: 'PROCESSING_CLIENT_INTERRUPTED', outcome: 'not-dispatched' });
  await assert.rejects(h.client.run(request(undefined, { beforeDispatch: async () => { throw Object.assign(new Error('reservation refused'), { code: 'INTAKE_BLOCKED' }); } })), { code: 'INTAKE_BLOCKED', outcome: 'not-dispatched' });
  assert.equal(h.calls.length, 0);
});

test('a busy native UUID cannot be concurrently dispatched by the same controller', async () => {
  let release; const h = harness(success), id = randomUUID();
  const first = h.client.run(request(id, { beforeDispatch: () => new Promise(resolve => { release = resolve; }) }));
  await assert.rejects(h.client.run(request(id)), { code: 'PROCESSING_CLIENT_BUSY', outcome: 'not-dispatched' });
  release(); await first; assert.equal(h.calls.length, 1);
});

test('unexpected native identity and incomplete native completion remain unknown', async t => {
  for (const [name, rows, code] of [
    ['wrong init ID', id => [initialization(randomUUID()), completed(id)], 'PROCESSING_CLIENT_IDENTITY_CHANGED'],
    ['wrong result ID', id => [initialization(id), completed(randomUUID())], 'PROCESSING_CLIENT_IDENTITY_CHANGED'],
    ['missing result', id => [initialization(id)], 'PROCESSING_CLIENT_OUTCOME_UNKNOWN'],
    ['missing init', id => [completed(id)], 'PROCESSING_CLIENT_PROTOCOL'],
    ['failed result', id => [initialization(id), completed(id, { is_error: true })], 'PROCESSING_CLIENT_TURN_FAILED'],
    ['denied permission', id => [initialization(id), completed(id, { permission_denials: [{ tool_name: 'Bash' }] })], 'PROCESSING_CLIENT_TURN_FAILED']
  ]) await t.test(name, async () => {
    const h = harness(({ child, args }) => { for (const row of rows(args.at(-1))) child.send(row); child.emit('close', 0, null); });
    await assert.rejects(h.client.run(request()), { code, outcome: 'unknown' });
  });
});

test('native restrictions must exactly match the engine-only tool profile', async t => {
  for (const patch of [
    { tools: [...TOOLS, 'Bash'] }, { tools: [TOOLS[0]] }, { tools: [TOOLS[0], TOOLS[0]] },
    { mcp_servers: [{ name: 'unexpected', status: 'connected' }] },
    { mcp_servers: [{ name: 'cuefluent_engine', status: 'failed' }] },
    { permissionMode: 'bypassPermissions' }, { slash_commands: ['code'] }, { skills: ['escape'] }
  ]) await t.test(JSON.stringify(patch), async () => {
    const h = harness(({ child, args }) => { child.send(initialization(args.at(-1), patch)); child.emit('close', 0, null); });
    await assert.rejects(h.client.run(request()), { code: 'PROCESSING_CLIENT_RESTRICTION_UNVERIFIED', outcome: 'unknown' });
    assert.equal(h.children[0].killed, 'SIGKILL');
  });
});

test('an exact acknowledged native API failure is terminal without claiming successful processing', async () => {
  const h = harness(({ child, input }) => {
    child.send(initialization(input.session_id)); child.send({ ...input, isReplay: true });
    child.send(completed(input.session_id, { is_error: true, terminal_reason: 'api_error', api_error_status: 400,
      user_message_uuid: input.uuid, user_message_uuids: [input.uuid], result: 'Do not forward provider error detail.' }));
    child.emit('close', 1, null);
  });
  const result = await h.client.run(request());
  assert.equal(result.status, 'failed'); assert.equal(result.output, ''); assert.equal(h.children[0].killed, undefined);
});

test('native failure without exact terminal input binding or clean exit remains unknown', async t => {
  for (const name of ['different input', 'additional input', 'unknown terminal', 'missing replay', 'signal', 'exit two']) await t.test(name, async () => {
    const h = harness(({ child, input }) => {
      child.send(initialization(input.session_id)); if (name !== 'missing replay') child.send({ ...input, isReplay: true });
      child.send(completed(input.session_id, { is_error: true, terminal_reason: name === 'unknown terminal' ? 'unknown' : 'api_error', api_error_status: 400,
        user_message_uuid: name === 'different input' ? randomUUID() : input.uuid,
        user_message_uuids: name === 'additional input' ? [input.uuid, randomUUID()] : [input.uuid] }));
      child.emit('close', name === 'exit two' ? 2 : 1, name === 'signal' ? 'SIGTERM' : null);
    });
    await assert.rejects(h.client.run(request()), { outcome: 'unknown' });
  });
});

test('native input acknowledgement must bind the exact controller UUID and bytes', async t => {
  for (const [name, mutate, code] of [
    ['wrong UUID', input => ({ ...input, uuid: randomUUID() }), 'PROCESSING_CLIENT_INPUT_UNVERIFIED'],
    ['changed text', input => ({ ...input, message: { role: 'user', content: 'different text' } }), 'PROCESSING_CLIENT_INPUT_UNVERIFIED'],
    ['missing acknowledgement', () => null, 'PROCESSING_CLIENT_OUTCOME_UNKNOWN']
  ]) await t.test(name, async () => {
    const h = harness(({ child, args, input }) => {
      child.send(initialization(args.at(-1)));
      const replay = mutate(input); if (replay) child.send({ ...replay, isReplay: true });
      child.send(completed(args.at(-1))); child.emit('close', 0, null);
    });
    await assert.rejects(h.client.run(request()), { code, outcome: 'unknown' });
  });
});

test('attempting a forbidden native tool stops the process without a permission fallback', async () => {
  const h = harness(({ child, args }) => {
    const id = args.at(-1); child.send(initialization(id));
    child.send({ type: 'assistant', session_id: id, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'synthetic command' } }] } });
  });
  await assert.rejects(h.client.run(request()), { code: 'PROCESSING_CLIENT_TOOL_REFUSED', outcome: 'unknown' });
  assert.equal(h.children[0].killed, 'SIGKILL'); assert.equal(h.calls.length, 1);
});

test('interruption and timeout preserve an unknown outcome rather than silently retrying', async () => {
  const controller = new AbortController();
  const h = harness(({ child, args }) => { child.send(initialization(args.at(-1))); queueMicrotask(() => controller.abort()); });
  await assert.rejects(h.client.run(request(undefined, { signal: controller.signal })), { code: 'PROCESSING_CLIENT_INTERRUPTED', outcome: 'unknown' });
  const stalled = harness(() => {});
  const client = createClaudeProcessingClient({ executable: 'claude', cwd, engine: { command: process.execPath, args: [] },
    allowedTools: TOOLS, timeoutMs: 10, spawn: stalled.spawn });
  await assert.rejects(client.run(request()), { code: 'PROCESSING_CLIENT_TIMEOUT', outcome: 'unknown' });
  assert.equal(stalled.calls.length, 1);
});

test('native output is bounded and malformed UTF-8 cannot be treated as successful completion', async t => {
  await t.test('output budget includes stderr', async () => {
    const h = harness(({ child }) => child.stderr.write(Buffer.alloc(4096, 65)));
    const client = createClaudeProcessingClient({ executable: 'claude', cwd, engine: { command: process.execPath, args: [] },
      allowedTools: TOOLS, maxOutputBytes: 1024, spawn: h.spawn });
    await assert.rejects(client.run(request()), { code: 'PROCESSING_CLIENT_OUTPUT_LIMIT', outcome: 'unknown' });
  });
  await t.test('invalid stream', async () => {
    const h = harness(({ child }) => child.stdout.write(Buffer.from([0xff, 10])));
    await assert.rejects(h.client.run(request()), { code: 'PROCESSING_CLIENT_PROTOCOL', outcome: 'unknown' });
  });
  await t.test('partial final frame', async () => {
    const h = harness(({ child }) => { child.stdout.write('{"type":'); child.emit('close', 0, null); });
    await assert.rejects(h.client.run(request()), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN', outcome: 'unknown' });
  });
});

test('client rejects arbitrary engine namespaces and shell-backed Windows launchers', () => {
  const base = { executable: 'claude', cwd, engine: { command: process.execPath, args: [] }, allowedTools: TOOLS };
  assert.throws(() => createClaudeProcessingClient({ ...base, allowedTools: ['Bash'] }), { code: 'INVALID_PROCESSING_CLIENT_TOOLS' });
  assert.throws(() => createClaudeProcessingClient({ ...base, allowedTools: ['mcp__other__inspect'] }), { code: 'INVALID_PROCESSING_CLIENT_TOOLS' });
  assert.throws(() => createClaudeProcessingClient({ ...base, executable: 'claude.cmd' }), { code: 'INVALID_PROCESSING_CLIENT' });
  assert.throws(() => createClaudeProcessingClient({ ...base, engine: { ...base.engine, env: { CLAUDE_CODE_SESSION_ID: randomUUID() } } }), { code: 'INVALID_PROCESSING_CLIENT' });
});

test('engine authorization is inherited environment data and never a command-line argument', async () => {
  const h = harness(success), token = 'synthetic-private-engine-token';
  const client = createClaudeProcessingClient({ executable: 'claude', cwd, engine: { command: process.execPath,
    args: ['synthetic-engine.mjs'], env: { CUEFLUENT_ENGINE_TOKEN: token } }, allowedTools: TOOLS, spawn: h.spawn,
    env: { PATH: 'synthetic-path' } });
  await client.run(request());
  assert.ok(!JSON.stringify(h.calls[0].args).includes(token));
  assert.equal(h.calls[0].options.env.CUEFLUENT_ENGINE_TOKEN, token);
  assert.equal(h.calls[0].options.env.PATH, 'synthetic-path');
  assert.deepEqual(Object.keys(JSON.parse(h.calls[0].args[h.calls[0].args.indexOf('--mcp-config') + 1]).mcpServers.cuefluent_engine), ['command', 'args']);
});

test('synchronous and asynchronous spawn failures prove no dispatch and submit no input', async t => {
  const base = { executable: 'missing-claude', cwd, engine: { command: process.execPath, args: [] }, allowedTools: TOOLS };
  await t.test('synchronous failure', async () => {
    const client = createClaudeProcessingClient({ ...base, spawn: () => { throw new Error('synthetic start failure'); } });
    await assert.rejects(client.run(request()), { code: 'PROCESSING_CLIENT_START_FAILED', outcome: 'not-dispatched' });
  });
  await t.test('asynchronous ENOENT before spawn', async () => {
    let writes = 0;
    const client = createClaudeProcessingClient({ ...base, spawn: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(_chunk, _encoding, done) { writes++; done(); } }); child.kill = () => false;
      queueMicrotask(() => { child.emit('error', Object.assign(new Error('synthetic missing executable'), { code: 'ENOENT' })); child.emit('close', -2, null); });
      return child;
    } });
    await assert.rejects(client.run(request()), { code: 'PROCESSING_CLIENT_START_FAILED', outcome: 'not-dispatched' });
    assert.equal(writes, 0);
  });
  await t.test('actual Node ENOENT', async () => {
    const client = createClaudeProcessingClient({ ...base, executable: path.resolve(`missing-claude-${randomUUID()}`), cwd: process.cwd() });
    await assert.rejects(client.run(request()), { code: 'PROCESSING_CLIENT_START_FAILED', outcome: 'not-dispatched' });
  });
});

test('an error after OS spawn and input submission remains genuinely ambiguous', async () => {
  const h = harness(({ child }) => child.emit('error', Object.assign(new Error('synthetic late pipe failure'), { code: 'EPIPE' })));
  await assert.rejects(h.client.run(request()), { code: 'PROCESSING_CLIENT_START_FAILED', outcome: 'unknown' });
  assert.equal(h.calls.length, 1);
});

test('controlled Claude launch removes the inherited nested-session sentinel without altering host environment', async () => {
  const h = harness(success), env = { PATH: 'synthetic-path', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent-native-session', ANTHROPIC_API_KEY: 'synthetic-credential' };
  const client = createClaudeProcessingClient({ executable: 'claude', cwd, engine: { command: process.execPath, args: [] },
    allowedTools: TOOLS, spawn: h.spawn, env });
  await client.run(request());
  assert.equal(env.CLAUDECODE, '1'); assert.equal(Object.hasOwn(h.calls[0].options.env, 'CLAUDECODE'), false);
  assert.equal(h.calls[0].options.env.CLAUDE_CODE_SESSION_ID, env.CLAUDE_CODE_SESSION_ID);
  assert.equal(h.calls[0].options.env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
  assert.equal(h.calls[0].options.env.PATH, env.PATH);
});

test('custom Claude environments validate exact errors with a valid replacement control', () => {
  const base = { executable: 'claude', cwd, engine: { command: process.execPath, args: [] }, allowedTools: TOOLS };
  assert.doesNotThrow(() => createClaudeProcessingClient({ ...base, env: { PATH: 'synthetic-path', EMPTY: '' } }));
  for (const env of [null, [], Object.create({ inherited: 'value' }), { INVALID: 1 }, { 'INVALID-NAME': 'value' },
    { INVALID: '\0' }, { INVALID: '\ud800' }, { LARGE: 'x'.repeat(32769) },
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`KEY_${i}`, 'value']))]) {
    assert.throws(() => createClaudeProcessingClient({ ...base, env }), { code: 'INVALID_PROCESSING_CLIENT' });
    assert.throws(() => createClaudeProcessingClient({ ...base, engine: { ...base.engine, env } }), { code: 'INVALID_PROCESSING_CLIENT' });
  }
});

test('host environment copies retain OS names and sizes independently of replacement-map limits', async () => {
  const h = harness(success);
  const env = { ...Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`KEY_${i}`, 'synthetic'])),
    'ProgramFiles(x86)': 'synthetic programs', 'CommonProgramFiles(x86)': 'synthetic common programs',
    LARGE: 'x'.repeat(32769), CLAUDECODE: '1' };
  const original = { ...env };
  const client = createClaudeProcessingClient({ executable: 'claude', cwd,
    engine: { command: process.execPath, args: [] }, allowedTools: TOOLS, spawn: h.spawn }, { env });
  await client.run(request());
  const { CLAUDECODE: _sentinel, ...expected } = original;
  assert.deepEqual(h.calls[0].options.env, expected);
  assert.deepEqual(env, original);
});
