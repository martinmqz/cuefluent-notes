import { isMain } from './file-io.mjs';
import { ENGINE_FRAME_BYTES, engineEndpoint } from './processing-engine-bridge.mjs';
import { keys, object, canonicalJSON, fail, safeErrorCode } from './workflow-values.mjs';

/** Stdio MCP bridge only: no filesystem, collection selector, native session
 * discovery, model calls or arbitrary commands exist in this child process. */
export async function runProcessingEngineServer({ input = process.stdin, output = process.stdout,
  env = process.env, fetch: request = globalThis.fetch } = {}) {
  const endpoint = engineEndpoint(env);
  let initialized = false, pending = Buffer.alloc(0);
  const reply = async value => {
    const bytes = Buffer.from(canonicalJSON(value) + '\n');
    if (bytes.length > ENGINE_FRAME_BYTES) fail('PROCESSING_ENGINE_OUTPUT_LIMIT');
    if (!output.write(bytes)) await new Promise((resolve, reject) => { output.once('drain', resolve); output.once('error', reject); });
  };
  const call = async body => {
    const response = await request(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json' }, body: canonicalJSON(body), redirect: 'error', signal: AbortSignal.timeout(60000) });
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length; if (size > ENGINE_FRAME_BYTES) fail('PROCESSING_ENGINE_OUTPUT_LIMIT'); chunks.push(chunk);
    }
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!response.ok) fail(safeErrorCode({ code: result.error }, 'PROCESSING_ENGINE_REQUEST'));
    return result;
  };
  const message = async line => {
    let id = null;
    try {
      const row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      keys(row, ['jsonrpc', 'method'], ['id', 'params']);
      if (row.jsonrpc !== '2.0' || typeof row.method !== 'string') fail('PROCESSING_ENGINE_PROTOCOL');
      if (Object.hasOwn(row, 'id')) {
        if (!((typeof row.id === 'string' && row.id.length <= 128) || Number.isSafeInteger(row.id))) fail('PROCESSING_ENGINE_PROTOCOL');
        id = row.id;
      } else {
        if (['notifications/initialized', 'notifications/cancelled'].includes(row.method)) return;
        fail('PROCESSING_ENGINE_PROTOCOL');
      }
      let result;
      if (row.method === 'initialize') {
        if (initialized || !object(row.params)) fail('PROCESSING_ENGINE_PROTOCOL');
        initialized = true;
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cuefluent_engine', version: '1.0.0' } };
      } else {
        if (!initialized) fail('PROCESSING_ENGINE_PROTOCOL');
        if (row.method === 'ping') result = {};
        else if (row.method === 'tools/list') result = await call({ method: 'tools/list' });
        else if (row.method === 'tools/call') {
          keys(row.params, ['name'], ['arguments', '_meta']);
          const response = await call({ method: 'tools/call', name: row.params.name, arguments: row.params.arguments ?? {} });
          result = { content: [{ type: 'text', text: canonicalJSON(response.result) }], isError: false };
        } else fail('PROCESSING_ENGINE_METHOD_UNSUPPORTED');
      }
      await reply({ jsonrpc: '2.0', id, result });
    } catch (error) {
      await reply({ jsonrpc: '2.0', id, error: { code: -32600, message: safeErrorCode(error, 'PROCESSING_ENGINE_PROTOCOL') } });
    }
  };
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > ENGINE_FRAME_BYTES) fail('PROCESSING_ENGINE_INPUT_LIMIT');
      const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
      if (line.length) await message(line);
    }
    if (pending.length > ENGINE_FRAME_BYTES) fail('PROCESSING_ENGINE_INPUT_LIMIT');
  }
  if (pending.length) fail('PROCESSING_ENGINE_PROTOCOL');
}

if (await isMain(import.meta.url)) runProcessingEngineServer().catch(error => {
  process.stderr.write(`${safeErrorCode(error, 'PROCESSING_ENGINE_FAILED')}\n`); process.exitCode = 1;
});
