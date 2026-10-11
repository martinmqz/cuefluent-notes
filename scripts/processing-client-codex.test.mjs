import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { openCodexProcessingClient } from './processing-client-codex.mjs';

const cwd = path.join(os.tmpdir(), 'cuefluent synthetic transport');
const sid = '11111111-1111-4111-8111-111111111111';
const tid = '22222222-2222-4222-8222-222222222222';
const tools = [{ type: 'function', name: 'cuefluent_engine', description: 'Selected engine operations',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }];
const names = ['shell_tool', 'view_image', 'apps', 'plugins', 'remote_plugin', 'hooks', 'goals',
  'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'memories', 'future_tool'];
function fixture(t, change = () => {}) {
  const calls = [], replies = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); } };
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin = new Writable({ write(bytes, _, done) {
    const message = JSON.parse(bytes.toString());
    if (!message.method) { replies.push(message); done(); return; }
    calls.push(message);
    if (!Object.hasOwn(message, 'id')) { done(); return; }
    let result;
    if (message.method === 'initialize') result = { codexHome: path.join(cwd, 'profile'), platformOs: process.platform };
    else if (message.method === 'experimentalFeature/list') result = { data: names.map(name => ({ name, enabled: !message.params.threadId, stage: 'stable' })), nextCursor: null };
    else if (message.method === 'config/read') result = { config: { mcp_servers: { 'existing.with.dots': { enabled: true, command: 'never-launch' } } } };
    else if (message.method === 'mcpServerStatus/list') result = { data: [{ name: 'existing.with.dots', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null };
    else if (['thread/start', 'thread/resume'].includes(message.method)) result = { cwd, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: sid, sessionId: sid, path: path.join(cwd, 'profile', 'sessions', 'fixture.jsonl'), ephemeral: false, forkedFromId: null, parentThreadId: null, status: { type: 'idle' } } };
    else if (message.method === 'turn/start') result = { turn: { id: tid } };
    else if (message.method === 'turn/interrupt') result = {};
    const answer = { id: message.id, result };
    const disposition = change(message, answer, { send, calls, replies });
    if (disposition !== 'withhold') queueMicrotask(() => send(answer));
    done();
  } });
  const spawnProcess = (command, args, options) => {
    assert.equal(command, 'codex'); assert.deepEqual(args, ['app-server', '--stdio']);
    assert.equal(options.shell, false); assert.equal(options.cwd, cwd); return child;
  };
  t.after(() => { child.kill(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); });
  return { child, calls, replies, send, spawnProcess,
    complete(status = 'completed') { send({ method: 'turn/completed', params: { threadId: sid, turn: { id: tid, status } } }); } };
}
const engineRequest = (f, args = {}, callId = 'native-call') => f.send({ id: 901, method: 'item/tool/call', params: {
  threadId: sid, turnId: tid, callId, namespace: null, tool: 'cuefluent_engine', arguments: args } });
const spin = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(check) { for (let n = 0; n < 100; n++) { if (check()) return; await spin(); } assert.fail('fixture did not advance'); }

test('Codex transport establishes role before input and binds exact native tools and unit identity', async t => {
  const f = fixture(t), events = [], engineCalls = [];
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async call => { engineCalls.push(call); return { inspected: true }; } }, { spawnProcess: f.spawnProcess });
  const session = await client.create();
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  const start = f.calls.find(c => c.method === 'thread/start');
  assert.deepEqual(start.params.config.mcp_servers, { 'existing.with.dots': { enabled: false } });
  assert.equal(start.params.config['features.future_tool'], false);
  const done = client.startTurn({ session, input: 'Process the selected frozen workset.', roleGuard: async binding => {
    events.push(binding.phase); assert.equal(binding.sessionId, sid);
    if (binding.phase === 'before-input') assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  } });
  await waitFor(() => events.includes('started'));
  engineRequest(f, { command: 'inspect' });
  await waitFor(() => f.replies.length === 1);
  assert.equal(engineCalls[0].unitId, tid); assert.equal(engineCalls[0].callId, 'native-call');
  assert.deepEqual(JSON.parse(f.replies[0].result.contentItems[0].text), { inspected: true });
  f.complete(); const result = await done;
  assert.equal(result.unitId, tid); assert.equal(result.status, 'completed');
  assert.equal(result.navigation.desktopVerified, false);
  assert.equal(Object.hasOwn(result, 'text'), false);
  assert.deepEqual(events, ['before-input', 'started', 'before-tool', 'after-tool']);
  assert.deepEqual(await client.resume(session), session);
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
  await client.close();
});

test('failed role establishment sends no model input', async t => {
  const f = fixture(t);
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
  const session = await client.create();
  await assert.rejects(client.startTurn({ session, input: 'Process', roleGuard: async () => { throw new Error('role unavailable'); } }), {
    code: 'PROCESSING_CLIENT_UNAVAILABLE', outcome: 'not-dispatched',
  });
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  await client.close();
});

test('expected engine refusals return safe tool errors and allow another call and completed turn', async t => {
  const f = fixture(t); let calls = 0;
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => {
    if (++calls === 1) throw Object.assign(new Error('private source and secret values'), { code: 'PROCESSING_CLAIM_CHANGED' });
    return { inspected: true };
  } }, { spawnProcess: f.spawnProcess });
  const session = await client.create(), done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
  await waitFor(() => f.calls.some(c => c.method === 'turn/start')); await spin();
  engineRequest(f); await waitFor(() => f.replies.length === 1);
  assert.equal(f.replies[0].result.success, false);
  assert.deepEqual(JSON.parse(f.replies[0].result.contentItems[0].text), { error: 'PROCESSING_CLAIM_CHANGED' });
  assert.equal(JSON.stringify(f.replies).includes('private'), false); assert.equal(f.child.killed, false);
  engineRequest(f, {}, 'corrected-call'); await waitFor(() => f.replies.length === 2);
  assert.equal(f.replies[1].result.success, true);
  f.complete(); assert.equal((await done).status, 'completed');
  assert.deepEqual(await client.resume(session), session); await client.close();
});

test('oversized engine output and double-encoded envelopes refuse boundedly without killing the client', async t => {
  for (const [kind, output] of [['note', { content: 'x'.repeat(2 * 1024 * 1024) }], ['wire escaping', '"'.repeat(524275)]]) {
    await t.test(kind, async t => {
      const f = fixture(t);
      const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => output }, { spawnProcess: f.spawnProcess });
      const session = await client.create(), done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
      await waitFor(() => f.calls.some(c => c.method === 'turn/start')); await spin();
      engineRequest(f); await waitFor(() => f.replies.length === 1);
      assert.equal(f.replies[0].result.success, false);
      assert.deepEqual(JSON.parse(f.replies[0].result.contentItems[0].text), { error: 'PROCESSING_ENGINE_OUTPUT_LIMIT' });
      assert(Buffer.byteLength(JSON.stringify(f.replies[0])) < 256); assert.equal(f.child.killed, false);
      f.complete(); assert.equal((await done).status, 'completed'); await client.close();
    });
  }
});

test('role authority failure remains fatal and is never reported as an ordinary engine refusal', async t => {
  const f = fixture(t); let calls = 0;
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => { calls++; return {}; } }, { spawnProcess: f.spawnProcess });
  const session = await client.create(), done = client.startTurn({ session, input: 'Process', roleGuard: async ({ phase }) => {
    if (phase === 'before-tool') throw Object.assign(new Error('role changed'), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  } });
  await waitFor(() => f.calls.some(c => c.method === 'turn/start')); await spin();
  engineRequest(f); await assert.rejects(done, { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  assert.equal(calls, 0); assert.equal(f.replies.length, 0); assert.equal(f.child.killed, true);
});

test('interrupted terminal waits for an already-running engine callback before releasing the chat', async t => {
  const f = fixture(t); let release, called = false, settled = false;
  const hold = new Promise(resolve => { release = resolve; });
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => {
    called = true; await hold; return { inspected: true };
  } }, { spawnProcess: f.spawnProcess });
  const session = await client.create();
  const done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
  done.then(() => { settled = true; });
  await waitFor(() => f.calls.some(c => c.method === 'turn/start')); await spin();
  engineRequest(f); await waitFor(() => called);
  f.complete('interrupted'); await spin();
  assert.equal(settled, false);
  await assert.rejects(client.resume(session), { code: 'PROCESSING_CLIENT_BUSY' });
  release(); const result = await done;
  assert.equal(result.status, 'interrupted'); assert.equal(f.replies.length, 1);
  assert.deepEqual(await client.resume(session), session);
  await client.close();
});

test('resume identity mismatch never creates replacement or starts input', async t => {
  const f = fixture(t, (message, response) => { if (message.method === 'thread/resume') response.result.thread.id = tid; });
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
  const session = await client.create();
  await assert.rejects(client.resume(session), { code: 'PROCESSING_CLIENT_IDENTITY_CHANGED' });
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});

test('effective native feature or inherited MCP exposure stops before model input', async t => {
  for (const kind of ['feature', 'mcp', 'warning']) await t.test(kind, async t => {
    const f = fixture(t, (message, response, { send }) => {
      if (kind === 'feature' && message.method === 'experimentalFeature/list' && message.params.threadId) response.result.data[0].enabled = true;
      if (kind === 'mcp' && message.method === 'mcpServerStatus/list') response.result.data[0].runtimeStatus = 'ready';
      if (kind === 'warning' && message.method === 'thread/start') send({ method: 'warning', params: { message: 'Ignored setting' } });
    });
    const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
    await assert.rejects(client.create(), { code: 'PROCESSING_CLIENT_POLICY_CHANGED' });
    assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  });
});

test('unknown creation outcome is terminal and never retried', async t => {
  const f = fixture(t, message => message.method === 'thread/start' ? 'withhold' : undefined);
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess, requestTimeoutMs: 15 });
  await assert.rejects(client.create(), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
  await assert.rejects(client.create(), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
});

test('a sent turn with a lost response stays unknown rather than claiming it was never dispatched', async t => {
  const f = fixture(t, message => message.method === 'turn/start' ? 'withhold' : undefined);
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, {
    spawnProcess: f.spawnProcess, requestTimeoutMs: 15,
  });
  const session = await client.create();
  await assert.rejects(client.startTurn({ session, input: 'Process', roleGuard: async () => {} }), error => {
    assert.equal(error.code, 'PROCESSING_CLIENT_OUTCOME_UNKNOWN'); assert.equal(error.outcome, undefined); return true;
  });
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('a native failed terminal returns its exact identity without converting it into transport failure', async t => {
  const f = fixture(t);
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
  const session = await client.create(), done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
  await waitFor(() => f.calls.some(c => c.method === 'turn/start')); await spin();
  f.complete('failed'); const result = await done;
  assert.equal(result.status, 'failed'); assert.equal(result.unitId, tid); assert.equal(result.sessionId, sid);
  assert.equal(f.child.killed, false); await client.close();
});

test('forbidden native requests cannot approve commands or execute engine callbacks', async t => {
  for (const kind of ['native-approval', 'wrong-turn', 'unknown-tool', 'duplicate']) await t.test(kind, async t => {
    const f = fixture(t); let calls = 0;
    const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => { calls++; return {}; } }, { spawnProcess: f.spawnProcess });
    const session = await client.create();
    const done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
    await waitFor(() => f.calls.some(c => c.method === 'turn/start'));
    await spin();
    if (kind === 'duplicate') { engineRequest(f); await waitFor(() => f.replies.length); engineRequest(f); }
    else f.send({ id: 901, method: kind === 'native-approval' ? 'item/commandExecution/requestApproval' : 'item/tool/call',
      params: { threadId: sid, turnId: kind === 'wrong-turn' ? sid : tid, callId: 'call', namespace: null,
        tool: kind === 'unknown-tool' ? 'exec_command' : 'cuefluent_engine', arguments: {} } });
    await assert.rejects(done, { code: kind === 'wrong-turn' ? 'PROCESSING_CLIENT_IDENTITY_CHANGED' : 'PROCESSING_CLIENT_POLICY_CHANGED' });
    assert.equal(calls, kind === 'duplicate' ? 1 : 0);
    assert.equal(f.replies.length, kind === 'duplicate' ? 1 : 0);
  });
});

test('structured native input is delegated to the caller rather than self-approved', async t => {
  const f = fixture(t); let asked = false;
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}),
    onUserInput: async ({ request, unitId }) => {
      assert.equal(unitId, tid); assert.equal(request.questions[0].id, 'exact-proposal');
      asked = true; return { answers: { 'exact-proposal': { answers: ['Skip'] } } };
    } }, { spawnProcess: f.spawnProcess });
  const session = await client.create(), done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
  await waitFor(() => f.calls.some(c => c.method === 'turn/start')); await spin();
  f.send({ id: 902, method: 'item/tool/requestUserInput', params: { threadId: sid, turnId: tid,
    itemId: 'question', isBlocking: true, questions: [{ id: 'exact-proposal', question: 'Approve?' }] } });
  await waitFor(() => f.replies.length);
  assert.equal(asked, true); assert.deepEqual(f.replies[0].result.answers['exact-proposal'].answers, ['Skip']);
  f.complete(); await done; await client.close();
});

test('a competing dispatch cannot cross an unfinished role guard', async t => {
  const f = fixture(t);
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
  const session = await client.create(); let release, guarding = false;
  const hold = new Promise(resolve => { release = resolve; });
  const done = client.startTurn({ session, input: 'Process', roleGuard: async ({ phase }) => {
    if (phase === 'before-input') { guarding = true; await hold; }
  } });
  await waitFor(() => guarding);
  await assert.rejects(client.startTurn({ session, input: 'Competing request', roleGuard: async () => {} }), { code: 'PROCESSING_CLIENT_BUSY' });
  await assert.rejects(client.resume(session), { code: 'PROCESSING_CLIENT_BUSY' });
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  release(); await waitFor(() => f.calls.some(c => c.method === 'turn/start')); await spin();
  f.complete(); await done; await client.close();
});

test('policy is rechecked before later dispatch and changed tool contracts cannot resume', async t => {
  let changed = false;
  const f = fixture(t, (m, r) => {
    if (changed && m.method === 'experimentalFeature/list' && m.params.threadId) r.result.data[0].enabled = true;
  });
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
  const session = await client.create(); changed = true;
  await assert.rejects(client.startTurn({ session, input: 'Process', roleGuard: async () => {} }), { code: 'PROCESSING_CLIENT_POLICY_CHANGED', outcome: 'not-dispatched' });
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  changed = false;
  await assert.rejects(client.resume({ ...session, toolContractHash: '0'.repeat(64) }), { code: 'PROCESSING_CLIENT_POLICY_CHANGED' });
});

test('oversized or malformed native frames fail boundedly without forwarding data', async t => {
  for (const bytes of ['{invalid}\n', 'x'.repeat(2 * 1024 * 1024 + 1)]) await t.test(bytes.length > 100 ? 'oversized' : 'invalid', async t => {
    const f = fixture(t);
    const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
    const session = await client.create();
    const done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
    await waitFor(() => f.calls.some(c => c.method === 'turn/start')); await spin();
    f.child.stdout.write(bytes);
    await assert.rejects(done, { code: bytes.length > 100 ? 'PROCESSING_CLIENT_MESSAGE_LIMIT' : 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
    assert.equal(f.replies.length, 0);
  });
});


test('pre-thread capability failure proves that creation was not dispatched', async t => {
  const f = fixture(t, (message, answer) => {
    if (message.method === 'experimentalFeature/list') answer.result.data = [];
  });
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
  await assert.rejects(client.create(), { code: 'PROCESSING_CLIENT_UNAVAILABLE', outcome: 'not-dispatched' });
  assert(!f.calls.some(call => call.method === 'thread/start')); await client.close();
});

test('benign active warning rechecks policy without killing the accepted turn', async t => {
  const f = fixture(t), client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
  const session = await client.create(), done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
  await waitFor(() => f.calls.some(call => call.method === 'turn/start')); await spin();
  f.send({ method: 'warning', params: { message: 'A model fallback notice' } }); await spin();
  assert.equal(f.child.killed, false); f.complete(); assert.equal((await done).status, 'completed'); await client.close();
});

test('an active warning cannot hide an actual policy change', async t => {
  let unsafe = false;
  const f = fixture(t, (message, answer) => {
    if (unsafe && message.method === 'experimentalFeature/list' && message.params.threadId) {
      answer.result.data.find(row => row.name === 'shell_tool').enabled = true;
    }
  });
  const client = await openCodexProcessingClient({ cwd, tools, onEngineTool: async () => ({}) }, { spawnProcess: f.spawnProcess });
  const session = await client.create(), done = client.startTurn({ session, input: 'Process', roleGuard: async () => {} });
  const rejected = assert.rejects(done, { code: 'PROCESSING_CLIENT_POLICY_CHANGED' });
  await waitFor(() => f.calls.some(row => row.method === 'turn/start')); await spin();
  unsafe = true; f.send({ method: 'warning', params: { message: 'Configuration changed' } });
  await rejected; assert.equal(f.child.killed, true); await client.close();
});
