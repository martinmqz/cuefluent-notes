import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createControlBridge, executeClaudeExpansion, serveControl, CONTROL_LIMITS } from '../src/client/control-server.mjs';

const opaque = 'a'.repeat(43);
const binding = Object.freeze({ client: 'codex', sessionId: 'thread', promptId: 'turn', cwd: process.cwd(), sourcePath: null, action: 'process' });
const metadata = { 'x-codex-turn-metadata': { session_id: 'thread', thread_id: 'thread', turn_id: 'turn' } };
function codex(executeInvocation = async () => ({ state: 'running' }), bindCommand = async () => ({ status: 'ready', binding })) {
  return createControlBridge({ client: 'codex', selection: { name: 'notes', skillPath: path.resolve('SKILL.md') }, codexAdapter: { bindCommand }, executeInvocation });
}
async function protocol(bridge) {
  const call = bridge.protocol({ version: '0.16.0-dev.0' });
  assert.deepEqual((await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } })).result.serverInfo, { name: 'cuefluent-control', version: '0.16.0-dev.0' });
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' }); return call;
}

test('Codex model tool forwards only trusted native binding and transport metadata', async () => {
  let observed, executed;
  const bridge = codex(async input => { executed = input; return { state: 'running', runId: 'run' }; }, async (meta, selected) => {
    observed = { meta, selected }; return { status: 'ready', binding };
  });
  const call = await protocol(bridge);
  const result = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cuefluent_control', arguments: { action: 'process' }, _meta: metadata } });
  assert.deepEqual(result.result.structuredContent, { state: 'running', runId: 'run' });
  assert.equal(observed.meta, metadata); assert.equal(executed, binding); assert.equal(observed.selected.name, 'notes');
});

test('session, cwd, source and metadata cannot be smuggled through model arguments', async () => {
  let executed = 0, bound = 0;
  const bridge = codex(async () => { executed++; return { state: 'running' }; }, async () => { bound++; return { status: 'ready', binding }; });
  for (const key of ['sessionId', 'promptId', 'cwd', 'sourcePath', '_meta']) await assert.rejects(bridge.call('cuefluent_control', { action: 'process', [key]: 'forged' }, { meta: metadata }), { code: 'CONTROL_ARGUMENT_INVALID' });
  assert.equal(executed, 0); assert.equal(bound, 0);
  await assert.rejects(bridge.call('cuefluent_control', { action: 'skip' }, { meta: metadata }), { code: 'NATIVE_COMMAND_MISMATCH' });
  assert.equal(executed, 0);
});

test('pending native item does not execute or imply work started', async () => {
  let executed = 0;
  const bridge = codex(async () => { executed++; }, async () => ({ status: 'pending', reason: 'NATIVE_COMMAND_ITEMS_PENDING' }));
  assert.deepEqual(await bridge.call('cuefluent_control', { action: 'process' }, { meta: metadata }), { state: 'pending', reason: 'NATIVE_COMMAND_ITEMS_PENDING' });
  assert.equal(executed, 0);
});

test('retry identity and once-only execution belong to durable root executor', async () => {
  const claims = new Map(); let starts = 0;
  const bridge = codex(async invocation => {
    const key = `${invocation.sessionId}:${invocation.promptId}`;
    if (!claims.has(key)) { starts++; claims.set(key, { state: 'running' }); }
    return claims.get(key);
  });
  assert.equal((await bridge.call('cuefluent_control', { action: 'process' }, { meta: metadata })).state, 'running');
  claims.set('thread:turn', { state: 'review', drafts: [{ target: 'note.md', summary: 'Synthetic summary', heading: 'Synthetic heading' }] });
  assert.equal((await bridge.call('cuefluent_control', { action: 'process' }, { meta: metadata })).state, 'review'); assert.equal(starts, 1);
});

test('Claude command executes only at trusted expansion and returns opaque current handle', async () => {
  let count = 0;
  const selection = { name: 'notes', source: 'plugin' };
  const envelope = { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'notes', command_source: 'plugin', command_args: 'process', prompt: '/notes process', session_id: 'session', prompt_id: 'prompt', cwd: process.cwd(), transcript_path: null };
  const executeInvocation = async invocation => { count++; assert.equal(invocation.client, 'claude'); return { handle: opaque, state: 'running' }; };
  assert.equal(await executeClaudeExpansion({ ...envelope, expansion_type: 'skill' }, selection, { executeInvocation }), null); assert.equal(count, 0);
  assert.deepEqual(await executeClaudeExpansion(envelope, selection, { executeInvocation }), { handle: opaque, state: 'running' }); assert.equal(count, 1);
  await assert.rejects(executeClaudeExpansion(envelope, selection, { executeInvocation: async () => ({ handle: 'guessable', state: 'running' }) }), { code: 'CONTROL_ARGUMENT_INVALID' });
});

test('Claude model exposes only handle polling and cannot execute any action', async () => {
  let reads = 0;
  const bridge = createControlBridge({ client: 'claude', readInvocation: async value => { reads++; return value === opaque ? { state: 'review', drafts: [] } : { state: 'expired' }; } });
  assert.deepEqual(bridge.tools.map(item => item.name), ['cuefluent_invocation']);
  assert.equal((await bridge.call('cuefluent_invocation', { handle: opaque })).state, 'review');
  assert.equal((await bridge.call('cuefluent_invocation', { handle: 'b'.repeat(43) })).state, 'expired');
  await assert.rejects(bridge.call('cuefluent_control', { action: 'process' }), { code: 'CONTROL_TOOL_UNKNOWN' });
  await assert.rejects(bridge.call('cuefluent_invocation', { handle: opaque, action: 'skip' }), { code: 'CONTROL_ARGUMENT_INVALID' }); assert.equal(reads, 2);
});

test('Claude explicit status and unconfigured commands may return directly without a claim', async () => {
  const selection = { name: 'notes', source: 'plugin' };
  const envelope = { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'notes', command_source: 'plugin', command_args: 'status', prompt: '/notes status', session_id: 'session', prompt_id: 'prompt', cwd: process.cwd(), transcript_path: null };
  assert.deepEqual(await executeClaudeExpansion(envelope, selection, { executeInvocation: async () => ({ state: 'idle' }) }), { state: 'idle' });
  const mutation = { ...envelope, command_args: 'process', prompt: '/notes process' };
  assert.deepEqual(await executeClaudeExpansion(mutation, selection, { executeInvocation: async () => ({ state: 'unconfigured' }) }), { state: 'unconfigured' });
  await assert.rejects(executeClaudeExpansion(mutation, selection, { executeInvocation: async () => ({ state: 'running' }) }), { code: 'CONTROL_ARGUMENT_INVALID' });
  await assert.rejects(executeClaudeExpansion(envelope, selection, { executeInvocation: async () => ({ state: 'idle', handle: 'bad' }) }), { code: 'CONTROL_ARGUMENT_INVALID' });
});

test('argument and result accessors are never evaluated', async () => {
  let evaluated = 0;
  const input = Object.defineProperty({}, 'action', { enumerable: true, get() { evaluated++; return 'process'; } });
  await assert.rejects(codex().call('cuefluent_control', input), { code: 'CONTROL_ARGUMENT_INVALID' });
  const output = Object.defineProperty({ state: 'running' }, 'secret', { enumerable: true, get() { evaluated++; return 'never'; } });
  await assert.rejects(codex(async () => output).call('cuefluent_control', { action: 'process' }), { code: 'CONTROL_RESPONSE_INVALID' }); assert.equal(evaluated, 0);
});

test('unknown MCP methods cannot forward requests and diagnostics omit private exception text', async () => {
  const call = await protocol(codex(async () => { throw new Error('private conversation or credential'); }));
  assert.equal((await call({ jsonrpc: '2.0', id: 2, method: 'command/exec', params: {} })).error.code, -32601);
  const result = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cuefluent_control', arguments: { action: 'process' }, _meta: metadata } });
  assert.equal(result.result.isError, true); assert.equal(JSON.stringify(result).includes('private conversation'), false);
  assert.equal(JSON.parse(result.result.content[0].text).error, 'CONTROL_TOOL_FAILED');
  assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
  assert.match(result.result.structuredContent.message, /could not complete/);
  assert.match(result.result.structuredContent.recovery, /pending work unchanged/);
});

test('MCP command mismatches explain the direct-note alternative and expose bounded debug context', async () => {
  const call = await protocol(codex(async () => assert.fail('must not execute'), async () => ({ status: 'ready', binding: { ...binding, action: 'track' } })));
  const response = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cuefluent_control', arguments: { action: 'process' }, _meta: metadata } });
  assert.equal(response.result.isError, true);
  const result = response.result.structuredContent;
  assert.equal(result.error, 'NATIVE_COMMAND_MISMATCH'); assert.match(result.message, /current chat command/);
  assert.match(result.recovery, /direct note tools/); assert.equal(result.diagnostics.client, 'codex');
  assert.equal(result.diagnostics.pluginVersion, '0.16.0-dev.0');
  assert.equal(Object.hasOwn(result.diagnostics, 'sessionId'), false);
});

test('response profile bounds metadata and preserves truthful running/review/result states', async () => {
  for (const state of ['running', 'review', 'finished', 'idle', 'interrupted']) assert.equal((await codex(async () => ({ state })).call('cuefluent_control', { action: 'process' })).state, state);
  await assert.rejects(codex(async () => ({ state: 'running', output: 'x'.repeat(CONTROL_LIMITS.responseBytes) })).call('cuefluent_control', { action: 'process' }), { code: 'CONTROL_RESPONSE_LIMIT' });
  await assert.rejects(codex(async () => ({ complete: true })).call('cuefluent_control', { action: 'process' }), { code: 'CONTROL_RESPONSE_INVALID' });
});

test('bounded stdio framing processes initialization and rejects oversized input without calls', async () => {
  const input = new PassThrough(), output = new PassThrough(); let failure, calls = 0, text = '';
  output.on('data', chunk => { text += chunk; });
  const transport = serveControl(codex(async () => { calls++; return { state: 'running' }; }), { input, output, version: '0.16.0', onFailure: error => { failure = error; } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } }) + '\n');
  await transport.idle(); assert.deepEqual(JSON.parse(text).result.serverInfo, { name: 'cuefluent-control', version: '0.16.0' });
  input.write('x'.repeat(CONTROL_LIMITS.requestBytes + 1)); await transport.idle(); assert.ok(failure); assert.equal(calls, 0);
  input.end(); output.end();
});

test('control protocol identity carries the exact package version and refuses malformed or missing versions', () => {
  for (const version of [undefined, '2.0', 'v0.16.0', '0.16.0+build.1', '01.16.0', '0.16.0-', 2]) {
    assert.throws(() => codex().protocol({ version }), { code: 'PACKAGE_INVALID' });
    assert.throws(() => serveControl(codex(), { input: new PassThrough(), output: new PassThrough(), version }), { code: 'PACKAGE_INVALID' });
  }
  for (const version of ['0.16.0-dev.0', '0.16.0', '2.0.0', '10.4.1-rc.2']) assert.equal(typeof codex().protocol({ version }), 'function');
});

function approvalBridge(onApproved = () => {}) {
  return createControlBridge({ client: 'claude', readInvocation: async () => ({ state: 'idle' }), directNotes: {
    tools: [{ name: 'confirm_note', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    async call(_name, _args, { approve }) {
      await approve({ title: 'Save draft?', message: 'Save the exact reviewed synthetic draft?' });
      onApproved(); return { state: 'saved' };
    },
  } });
}
async function initializeApproval(protocol, capabilities = { elicitation: { form: {} } }) {
  await protocol({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities, clientInfo: {} } });
  await protocol({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
const approvalCall = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'confirm_note' } };

test('control definitions reject collisions and freeze nested schemas without mutating supplied definitions', () => {
  for (const names of [['cuefluent_control'], ['duplicate', 'duplicate']]) {
    assert.throws(() => createControlBridge({ client: 'codex', codexAdapter: { bindCommand: async () => {} }, executeInvocation: async () => {},
      directNotes: { tools: names.map(name => ({ name })), call: async () => {} } }), { code: 'CONTROL_ADAPTER_INVALID' });
  }
  const supplied = { name: 'safe_note', inputSchema: { type: 'object', properties: { count: { type: 'integer', maximum: 5 } } } };
  const bridge = createControlBridge({ client: 'claude', readInvocation: async () => {}, directNotes: { tools: [supplied], call: async () => {} } });
  assert.throws(() => { bridge.tools[1].inputSchema.properties.count.maximum = 99; }, TypeError);
  supplied.inputSchema.properties.count.maximum = 99;
  assert.equal(bridge.tools[1].inputSchema.properties.count.maximum, 5);
});

test('elicitation needs a supported host and exact accepted form response; other outcomes cannot authorize mutation', async () => {
  let approved = 0;
  for (const answer of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { approve: false } },
    { action: 'accept', content: { approve: true, injected: true } }, { action: 'accept' }]) {
    let call;
    call = approvalBridge(() => { approved++; }).protocol({ version: '0.16.0', sendRequest: request => call({ jsonrpc: '2.0', id: request.id, result: answer }) });
    await initializeApproval(call);
    const response = await call(approvalCall);
    assert.equal(response.result.isError, true); assert.match(JSON.parse(response.result.content[0].text).error, /^DIRECT_NOTE_APPROVAL_/);
  }
  const unavailable = approvalBridge(() => { approved++; }).protocol({ version: '0.16.0', sendRequest: () => assert.fail('No unsupported elicitation') });
  await initializeApproval(unavailable, { elicitation: { url: {} } });
  assert.equal(JSON.parse((await unavailable(approvalCall)).result.content[0].text).error, 'DIRECT_NOTE_APPROVAL_UNSUPPORTED');
  assert.equal(approved, 0);
});

test('elicitation cancellation, expiration and unmatched or replayed responses cannot authorize a later call', async () => {
  let approved = 0, request, sent;
  const sentPromise = new Promise(resolve => { sent = resolve; });
  const call = approvalBridge(() => { approved++; }).protocol({ version: '0.16.0', sendRequest: value => { request = value; sent(); } });
  await initializeApproval(call);
  const pending = call(approvalCall); await sentPromise;
  await call({ jsonrpc: '2.0', id: 'unrelated', result: { action: 'accept', content: { approve: true } } });
  await call({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  assert.equal(JSON.parse((await pending).result.content[0].text).error, 'DIRECT_NOTE_APPROVAL_CANCELLED');
  await call({ jsonrpc: '2.0', id: request.id, result: { action: 'accept', content: { approve: true } } });
  assert.equal(approved, 0);
  const expired = approvalBridge(() => { approved++; }).protocol({ version: '0.16.0', approvalMs: 10, sendRequest: () => {} });
  await initializeApproval(expired);
  assert.equal(JSON.parse((await expired(approvalCall)).result.content[0].text).error, 'DIRECT_NOTE_APPROVAL_TIMEOUT');
  assert.equal(approved, 0);
  assert.equal((await call({})).error.code, -32600);
});

test('stdio handles a host confirmation while serializing ordinary calls without deadlocking the frame reader', async () => {
  const input = new PassThrough(), output = new PassThrough(); let approved = 0, failure, text = '';
  const replies = [], requests = [];
  output.on('data', chunk => {
    text += chunk;
    for (;;) {
      const index = text.indexOf('\n'); if (index < 0) break;
      const message = JSON.parse(text.slice(0, index)); text = text.slice(index + 1);
      if (message.method === 'elicitation/create') {
        requests.push(message);
        input.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: { approve: true } } }) + '\n');
      } else replies.push(message);
    }
  });
  const transport = serveControl(approvalBridge(() => { approved++; }), { input, output, version: '0.16.0', onFailure: error => { failure = error; } });
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' }, approvalCall,
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ]) input.write(JSON.stringify(message) + '\n');
  await transport.idle();
  assert.equal(failure, undefined); assert.equal(approved, 1); assert.equal(requests.length, 1);
  assert.equal(replies.find(reply => reply.id === 2).result.structuredContent.state, 'saved');
  assert.deepEqual(replies.find(reply => reply.id === 3).result, {});
  input.end(); output.end();
});

test('a cancellation before the handler reaches elicitation remains bound to that active request', async () => {
  let approved = 0, asked = 0;
  const bridge = createControlBridge({ client: 'claude', readInvocation: async () => ({ state: 'idle' }), directNotes: {
    tools: [{ name: 'delayed_confirmation', inputSchema: { type: 'object', properties: {} } }],
    async call(_name, _args, { approve }) {
      await new Promise(resolve => setImmediate(resolve));
      await approve({ title: 'Save?', message: 'Save the reviewed draft?' });
      approved++; return { state: 'saved' };
    },
  } });
  let call;
  call = bridge.protocol({ version: '0.16.0', sendRequest: request => { asked++; return call({ jsonrpc: '2.0', id: request.id, result: { action: 'accept', content: { approve: true } } }); } });
  await initializeApproval(call);
  const pending = call({ ...approvalCall, params: { name: 'delayed_confirmation' } });
  call.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  assert.equal(JSON.parse((await pending).result.content[0].text).error, 'DIRECT_NOTE_APPROVAL_CANCELLED');
  assert.equal(asked, 0); assert.equal(approved, 0);
  // A later request may legitimately reuse the now-completed JSON-RPC identity.
  assert.equal((await call({ ...approvalCall, params: { name: 'delayed_confirmation' } })).result.structuredContent.state, 'saved');
  assert.equal(approved, 1);
});
