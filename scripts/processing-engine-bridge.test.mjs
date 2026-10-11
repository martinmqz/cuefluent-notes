import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { openProcessingEngineBridge, engineEndpoint } from './processing-engine-bridge.mjs';
import { runProcessingEngineServer } from './processing-engine-server.mjs';

const local = { CUEFLUENT_ENGINE_ENDPOINT: 'http://127.0.0.1:43123/call', CUEFLUENT_ENGINE_TOKEN: 'a'.repeat(64) };
const frame = value => JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n';
const init = { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };

async function protocol(frames, fetch) {
  const output = new PassThrough(); let result = '';
  output.on('data', chunk => { result += chunk; });
  await runProcessingEngineServer({ input: Readable.from(frames.map(frame)), output, env: local, fetch });
  return result.trim().split('\n').map(line => JSON.parse(line));
}

test('engine MCP forwards selected calls, never model-supplied authority', async () => {
  const seen = [];
  const result = await protocol([init, { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'processing_status', arguments: { operationId: 'op' }, _meta: { sessionId: 'forged' } } }], async (url, options) => {
    assert.equal(url, local.CUEFLUENT_ENGINE_ENDPOINT);
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, `Bearer ${local.CUEFLUENT_ENGINE_TOKEN}`);
    const body = JSON.parse(options.body); seen.push(body);
    return new Response(JSON.stringify(body.method === 'tools/list' ? { tools: [] } : { result: { state: 'prepared' } }));
  });
  assert.deepEqual(seen, [{ method: 'tools/list' }, { method: 'tools/call', name: 'processing_status', arguments: { operationId: 'op' } }]);
  assert.equal(result[2].result.content[0].text, '{"state":"prepared"}');
});

test('engine MCP refuses unsupported methods and invalid frames without calling the engine', async () => {
  let calls = 0;
  const output = await protocol([{ id: 0, method: 'tools/list' }, init,
    { id: 2, method: 'resources/read', params: { uri: 'file:///private' } },
    { id: 3, method: 'tools/call', params: { name: 'status', arguments: {}, configPath: '/forged' } }], async () => { calls++; });
  assert.equal(calls, 0); assert.equal(output[0].error.message, 'PROCESSING_ENGINE_PROTOCOL');
  assert.equal(output[2].error.message, 'PROCESSING_ENGINE_METHOD_UNSUPPORTED');
  assert.ok(output[3].error); assert.ok(!JSON.stringify(output).includes('/private'));
});

test('engine endpoint accepts only the ephemeral loopback bridge', () => {
  assert.equal(engineEndpoint(local).url, local.CUEFLUENT_ENGINE_ENDPOINT);
  for (const endpoint of ['https://example.com/call', 'http://localhost:1234/call', 'http://127.0.0.1:1234/call?token=x',
    'http://user@127.0.0.1:1234/call', 'http://127.0.0.1:1234/other']) {
    assert.throws(() => engineEndpoint({ ...local, CUEFLUENT_ENGINE_ENDPOINT: endpoint }));
  }
});

test('bridge authenticates before discovery or execution and rejects unavailable tools', async t => {
  const calls = [];
  const bridge = await openProcessingEngineBridge({ toolNames: ['processing_status'], call: async (name, args) => {
    calls.push({ name, args }); return { state: 'prepared' };
  } });
  t.after(() => bridge.close());
  const env = bridge.engine.env, url = env.CUEFLUENT_ENGINE_ENDPOINT;
  const request = (body, token = env.CUEFLUENT_ENGINE_TOKEN, extra = {}) => fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body) });
  assert.equal((await request({ method: 'tools/list' }, 'wrong')).status, 403);
  assert.equal((await request({ method: 'tools/list' }, env.CUEFLUENT_ENGINE_TOKEN, { origin: 'https://example.com' })).status, 403);
  const tools = await (await request({ method: 'tools/list' })).json();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['processing_status']);
  const denied = await request({ method: 'tools/call', name: 'configure', arguments: {} });
  assert.equal(denied.status, 400); assert.equal(calls.length, 0);
  const ok = await (await request({ method: 'tools/call', name: 'processing_status', arguments: { operationId: 'op' } })).json();
  assert.deepEqual(ok.result, { state: 'prepared' }); assert.deepEqual(calls, [{ name: 'processing_status', args: { operationId: 'op' } }]);
  assert.ok(!bridge.engine.args.some(arg => arg.includes(env.CUEFLUENT_ENGINE_TOKEN)));
});

test('bridge does not overlap calls or close during a mutation', async t => {
  let release, entered;
  const busy = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const bridge = await openProcessingEngineBridge({ toolNames: ['processing_ack'], call: async () => { entered(); await pending; return { acknowledged: true }; } });
  t.after(() => bridge.close());
  const env = bridge.engine.env;
  const request = () => fetch(env.CUEFLUENT_ENGINE_ENDPOINT, { method: 'POST',
    headers: { authorization: `Bearer ${env.CUEFLUENT_ENGINE_TOKEN}` },
    body: JSON.stringify({ method: 'tools/call', name: 'processing_ack', arguments: {} }) });
  const first = request(); await busy;
  assert.equal((await request()).status, 409);
  await assert.rejects(bridge.close(), { code: 'PROCESSING_ENGINE_BUSY' });
  release(); assert.equal((await first).status, 200);
});

test('oversized valid engine result becomes a recoverable tool error and later calls still succeed', async t => {
  const bridge = await openProcessingEngineBridge({ toolNames: ['note_read', 'processing_status'], call: async name =>
    name === 'note_read' ? { path: 'large.md', content: 'a'.repeat(2 * 1024 * 1024) } : { state: 'prepared' } });
  t.after(() => bridge.close());
  const output = new PassThrough(); let bytes = '';
  output.on('data', chunk => { bytes += chunk; });
  await runProcessingEngineServer({ input: Readable.from([init,
    { id: 2, method: 'tools/call', params: { name: 'note_read', arguments: { path: 'large.md' } } },
    { id: 3, method: 'tools/call', params: { name: 'processing_status', arguments: {} } }].map(frame)),
  output, env: bridge.engine.env });
  const rows = bytes.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[1].error.message, 'PROCESSING_ENGINE_OUTPUT_LIMIT');
  assert.equal(rows[2].result.content[0].text, '{"state":"prepared"}');
  assert(bytes.length < 1024); assert(!bytes.includes('large.md')); await bridge.idle();
});

test('engine result budget measures serialized bytes including Unicode and JSON escaping', async t => {
  const bridge = await openProcessingEngineBridge({ toolNames: ['note_read'], call: async (_name, args) => ({ content: args.content }) });
  t.after(() => bridge.close());
  const response = async content => fetch(bridge.engine.env.CUEFLUENT_ENGINE_ENDPOINT, { method: 'POST',
    headers: { authorization: `Bearer ${bridge.engine.env.CUEFLUENT_ENGINE_TOKEN}` },
    body: JSON.stringify({ method: 'tools/call', name: 'note_read', arguments: { content } }) });
  assert.equal((await response('a'.repeat(250 * 1024))).status, 200);
  for (const content of ['é'.repeat(140 * 1024), '\\'.repeat(140 * 1024)]) {
    const result = await response(content); assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { error: 'PROCESSING_ENGINE_OUTPUT_LIMIT' });
  }
});
