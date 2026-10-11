import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { keys, list, string, canonicalJSON, fail, safeErrorCode } from './workflow-values.mjs';
import { MAX_PROCESSING_ENGINE_RESULT_BYTES, processingToolDeclarations } from './processing-tool-contracts.mjs';

export const ENGINE_FRAME_BYTES = 4 * 1024 * 1024;
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);

/** Ephemeral, loopback-only IPC for the native Claude MCP child. The parent owns
 * the selected engine capability. No token, authority or engine selection comes
 * from model arguments, and no credential is stored in native command arguments.
 */
export async function openProcessingEngineBridge(adapter) {
  keys(adapter, ['toolNames', 'call'], ['descriptions', 'declarations']);
  list(adapter.toolNames, 64, { empty: false });
  if (adapter.toolNames.some(value => !name(value)) || new Set(adapter.toolNames).size !== adapter.toolNames.length ||
      typeof adapter.call !== 'function') fail('INVALID_PROCESSING_ENGINE');
  const names = [...adapter.toolNames], token = randomBytes(32).toString('hex');
  const secret = Buffer.from(`Bearer ${token}`), allowed = new Set(names);
  let active = false, closed = false;
  const idleWaiters = [];
  const contracts = new Map((adapter.declarations ?? processingToolDeclarations()).map(tool => [tool.name, tool]));
  const tools = names.map(tool => contracts.get(tool) ?? { name: tool,
    description: adapter.descriptions?.[tool] ?? `Selected collection operation: ${tool}.`, inputSchema: { type: 'object' } });
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => {
      if (res.destroyed) return;
      const bytes = Buffer.from(canonicalJSON(value));
      if (bytes.length > ENGINE_FRAME_BYTES) { res.writeHead(413); res.end('{"error":"PROCESSING_ENGINE_OUTPUT_LIMIT"}'); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(bytes);
    };
    const auth = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (closed || req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin !== undefined ||
        req.headers.host !== `127.0.0.1:${server.address()?.port}` || auth.length !== secret.length || !timingSafeEqual(auth, secret)) {
      respond(403, { error: 'PROCESSING_ENGINE_UNAUTHORIZED' }); req.resume(); return;
    }
    if (req.method !== 'POST' || req.url !== '/call') { respond(404, { error: 'PROCESSING_ENGINE_REQUEST' }); req.resume(); return; }
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > ENGINE_FRAME_BYTES) { respond(413, { error: 'PROCESSING_ENGINE_INPUT_LIMIT' }); req.destroy(); return; }
        chunks.push(chunk);
      }
      const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      keys(request, ['method'], ['name', 'arguments']);
      if (request.method === 'tools/list') {
        keys(request, ['method']); respond(200, { tools }); return;
      }
      if (request.method !== 'tools/call') fail('PROCESSING_ENGINE_REQUEST');
      keys(request, ['method', 'name', 'arguments']);
      if (!allowed.has(request.name)) fail('PROCESSING_ENGINE_TOOL_REFUSED');
      if (active) { respond(409, { error: 'PROCESSING_ENGINE_BUSY' }); return; }
      active = true;
      try {
        const result = await adapter.call(request.name, request.arguments);
        if (Buffer.byteLength(canonicalJSON(result)) > MAX_PROCESSING_ENGINE_RESULT_BYTES) fail('PROCESSING_ENGINE_OUTPUT_LIMIT');
        respond(200, { result });
      }
      finally { active = false; for (const resolve of idleWaiters.splice(0)) resolve(); }
    } catch (error) { respond(400, { error: safeErrorCode(error, 'PROCESSING_ENGINE_REQUEST') }); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 16;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}/call`;
  return Object.freeze({
    engine: { command: process.execPath, args: [fileURLToPath(new URL('./processing-engine-server.mjs', import.meta.url))],
      env: { CUEFLUENT_ENGINE_ENDPOINT: endpoint, CUEFLUENT_ENGINE_TOKEN: token } },
    allowedTools: names.map(tool => `mcp__cuefluent_engine__${tool}`),
    async idle() { if (active) await new Promise(resolve => idleWaiters.push(resolve)); },
    async close() {
      if (closed) return;
      // A transport disappearing is not authority to cancel an in-flight write.
      if (active) fail('PROCESSING_ENGINE_BUSY');
      closed = true; server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

export function engineEndpoint(env) {
  const value = env.CUEFLUENT_ENGINE_ENDPOINT, token = env.CUEFLUENT_ENGINE_TOKEN;
  string(value, 256);
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/call' ||
      url.username || url.password || url.search || url.hash || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('INVALID_PROCESSING_ENGINE');
  return { url: url.href, token };
}
