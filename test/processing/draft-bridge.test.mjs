import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { serveDraftTools } from '../../src/processing/draft-server.mjs';
import { DRAFT_TOOL_NAMES, draftProtocol, readFrames, writeFrame } from '../../src/processing/draft-protocol.mjs';

const definitions = DRAFT_TOOL_NAMES.map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
function workspace() {
  let finished = false;
  return Object.fromEntries(DRAFT_TOOL_NAMES.map(name => [name, async args => {
    if (finished) throw Object.assign(new Error('PRIVATE_EXCEPTION_CONTENT'), { code: 'WORKSPACE_FINISHED' });
    if (name === 'finish_drafting') finished = true;
    return { name, ...args };
  }]));
}
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
const ready = { jsonrpc: '2.0', method: 'notifications/initialized' };

test('draft protocol exposes exactly bounded draft tools, requires lifecycle, and sanitizes exceptions', async () => {
  const protocol = draftProtocol(workspace(), definitions);
  assert.equal((await protocol({ jsonrpc: '2.0', id: 0, method: 'tools/list' })).error.code, -32002);
  assert.equal((await protocol(initialize)).result.protocolVersion, '2025-11-25');
  await protocol(ready);
  assert.deepEqual((await protocol({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map(x => x.name), DRAFT_TOOL_NAMES);
  for (const name of ['manifest', 'constructor', '__proto__', 'write_file']) {
    assert.equal((await protocol({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name } })).error.code, -32602);
  }
  await protocol({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'finish_drafting', arguments: {} } });
  const failed = await protocol({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'draft_note', arguments: {} } });
  assert.equal(failed.result.isError, true);
  assert.match(JSON.stringify(failed), /WORKSPACE_FINISHED/);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_EXCEPTION_CONTENT/);
});

test('frame reader bounds both payload bytes and queued message count', async () => {
  for (const input of [Buffer.alloc(1025, 65), Buffer.from('\n'.repeat(65))]) {
    const stream = new PassThrough(); let failure;
    const reader = readFrames(stream, () => {}, error => { failure = error; }, { maxBytes: 1024 });
    stream.write(input); await reader.idle(); assert.ok(failure); stream.destroy();
  }
});

test('real stdio child authenticates, serves tools, and loses capability when worker server closes', async t => {
  const server = await serveDraftTools(workspace(), { definitions });
  t.after(() => server.close());
  const child = spawn(server.descriptor.command, server.descriptor.args, { env: { ...process.env, ...server.descriptor.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = once(child, 'exit');
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const replies = new Map();
  readFrames(child.stdout, message => { replies.get(message.id)?.(message); }, error => { throw error; });
  const request = message => new Promise((resolve, reject) => {
    replies.set(message.id, resolve); writeFrame(child.stdin, message).catch(reject);
  });
  assert.equal((await request(initialize)).result.serverInfo.name, 'cuefluent-drafts');
  await writeFrame(child.stdin, ready);
  const result = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_note', arguments: { target: 'knowledge-base/synthetic.md' } } });
  assert.equal(result.result.structuredContent.target, 'knowledge-base/synthetic.md');
  await server.close(); await exit;
  assert.equal(stderr, '');
});

test('unauthenticated IPC connection cannot reach a workspace tool', async t => {
  let calls = 0;
  const handlers = Object.fromEntries(DRAFT_TOOL_NAMES.map(name => [name, async () => { calls++; return {}; }]));
  const server = await serveDraftTools(handlers, { definitions }); t.after(() => server.close());
  const socket = net.createConnection(server.descriptor.args[1]);
  const closed = once(socket, 'close'); socket.on('error', () => {});
  await once(socket, 'connect'); await writeFrame(socket, { token: '0'.repeat(64) }); await closed;
  assert.equal(calls, 0);
});
