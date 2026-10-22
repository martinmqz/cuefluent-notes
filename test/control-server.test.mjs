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
  const call = bridge.protocol();
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } })).result.serverInfo.name, 'cuefluent-control');
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

test('unknown MCP methods cannot forward requests and failures reveal only stable codes', async () => {
  const call = await protocol(codex(async () => { throw new Error('private conversation or credential'); }));
  assert.equal((await call({ jsonrpc: '2.0', id: 2, method: 'command/exec', params: {} })).error.code, -32601);
  const result = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cuefluent_control', arguments: { action: 'process' }, _meta: metadata } });
  assert.equal(result.result.isError, true); assert.equal(JSON.stringify(result).includes('private conversation'), false);
  assert.deepEqual(JSON.parse(result.result.content[0].text), { error: 'CONTROL_TOOL_FAILED' });
});

test('response profile bounds metadata and preserves truthful running/review/result states', async () => {
  for (const state of ['running', 'review', 'finished', 'idle', 'interrupted']) assert.equal((await codex(async () => ({ state })).call('cuefluent_control', { action: 'process' })).state, state);
  await assert.rejects(codex(async () => ({ state: 'running', output: 'x'.repeat(CONTROL_LIMITS.responseBytes) })).call('cuefluent_control', { action: 'process' }), { code: 'CONTROL_RESPONSE_LIMIT' });
  await assert.rejects(codex(async () => ({ complete: true })).call('cuefluent_control', { action: 'process' }), { code: 'CONTROL_RESPONSE_INVALID' });
});

test('bounded stdio framing processes initialization and rejects oversized input without calls', async () => {
  const input = new PassThrough(), output = new PassThrough(); let failure, calls = 0, text = '';
  output.on('data', chunk => { text += chunk; });
  const transport = serveControl(codex(async () => { calls++; return { state: 'running' }; }), { input, output, onFailure: error => { failure = error; } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } }) + '\n');
  await transport.idle(); assert.equal(JSON.parse(text).result.serverInfo.name, 'cuefluent-control');
  input.write('x'.repeat(CONTROL_LIMITS.requestBytes + 1)); await transport.idle(); assert.ok(failure); assert.equal(calls, 0);
  input.end(); output.end();
});
