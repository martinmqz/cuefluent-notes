import { fail, CuefluentError } from '../core/errors.mjs';
import { packageVersion } from '../core/version.mjs';
import { logDiagnostic } from '../logs/index.mjs';

export const DRAFT_FRAME_BYTES = 1024 * 1024;
export const DRAFT_TOOL_NAMES = Object.freeze(['list_notes', 'read_note', 'draft_note', 'finish_drafting', 'read_activity_log']);
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A bounded newline framing reader. Pausing the transport alone does not bound
 * messages already queued in one chunk, so account for the queued bytes too. */
export function readFrames(stream, onFrame, onFailure, { maxBytes = DRAFT_FRAME_BYTES, queuedBytes = 2 * DRAFT_FRAME_BYTES } = {}) {
  let tail = Buffer.alloc(0), pending = 0, pendingFrames = 0, stopped = false, work = Promise.resolve();
  const stop = error => {
    if (stopped) return;
    stopped = true; tail = Buffer.alloc(0); onFailure(error);
  };
  stream.on('data', chunk => {
    if (stopped) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let start = 0;
    while (start < chunk.length && !stopped) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (tail.length + part.length > maxBytes) { stop(new CuefluentError('MCP_FRAME_LIMIT', 'Frame exceeds the transport limit.')); return; }
      tail = tail.length ? Buffer.concat([tail, part]) : Buffer.from(part);
      if (newline < 0) break;
      const frame = tail; tail = Buffer.alloc(0); start = newline + 1;
      pending += frame.length; pendingFrames++;
      if (pending > queuedBytes || pendingFrames > 64) { stop(new CuefluentError('MCP_FRAME_LIMIT', 'Queued requests exceed the transport limit.')); return; }
      work = work.then(async () => {
        if (stopped) return;
        try {
          let message;
          try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
          catch { fail('MCP_FRAME_INVALID', 'The transport message is not valid UTF-8 JSON.'); }
          await onFrame(message);
        }
        catch (error) { stop(error); }
        finally { pending -= frame.length; pendingFrames--; }
      });
    }
  });
  stream.on('error', stop);
  stream.on('end', () => { if (tail.length) stop(new CuefluentError('MCP_FRAME_INCOMPLETE', 'Incomplete transport frame.')); });
  return { stop, idle: () => work };
}

export async function writeFrame(stream, value) {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`);
  if (frame.length > DRAFT_FRAME_BYTES) fail('DRAFT_RESPONSE_LIMIT', 'The draft response exceeds its transport limit.');
  if (stream.destroyed || !stream.writable) fail('DRAFT_BRIDGE_CLOSED', 'The draft tool connection is closed.');
  await new Promise((resolve, reject) => stream.write(frame, error => error ? reject(error) : resolve()));
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/** Only these five draft capabilities are reachable. There is no arbitrary
 * property dispatch, filesystem operation, sampling, or tool forwarding. */
export function draftProtocol(workspace, definitions, { version } = {}) {
  const serverVersion = packageVersion(version);
  if (!Array.isArray(definitions) || definitions.length !== DRAFT_TOOL_NAMES.length ||
      new Set(definitions.map(item => item.name)).size !== DRAFT_TOOL_NAMES.length ||
      definitions.some(item => !DRAFT_TOOL_NAMES.includes(item.name) || !object(item.inputSchema)) ||
      DRAFT_TOOL_NAMES.some(name => typeof workspace[name] !== 'function')) {
    fail('DRAFT_TOOLS_INVALID', 'The workspace must expose exactly the supported draft tools.');
  }
  const tools = structuredClone(definitions);
  let initialized = false, ready = false;
  return async message => {
    const id = message?.id;
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (id !== undefined && !(typeof id === 'string' && id.length <= 128) && !Number.isSafeInteger(id))) {
      return rpcError(null, -32600, 'Invalid request.');
    }
    if (id === undefined) {
      if (initialized && message.method === 'notifications/initialized') ready = true;
      return null;
    }
    if (message.method === 'ping') return rpcResult(id, {});
    if (message.method === 'initialize') {
      if (initialized || !object(message.params) || typeof message.params.protocolVersion !== 'string' ||
          !object(message.params.capabilities) || !object(message.params.clientInfo)) return rpcError(id, -32602, 'Invalid initialization.');
      initialized = true;
      const protocolVersion = VERSIONS.includes(message.params.protocolVersion) ? message.params.protocolVersion : VERSIONS[0];
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cuefluent-drafts', version: serverVersion } });
    }
    if (!ready) return rpcError(id, -32002, 'Initialize the draft connection first.');
    if (message.method === 'tools/list') {
      if (message.params?.cursor !== undefined) return rpcError(id, -32602, 'The draft tool list is not paginated.');
      return rpcResult(id, { tools });
    }
    if (message.method !== 'tools/call') return rpcError(id, -32601, 'Method not found.');
    const params = message.params;
    if (!object(params) || !DRAFT_TOOL_NAMES.includes(params.name) || !object(params.arguments ?? {})) return rpcError(id, -32602, 'Unknown tool or invalid arguments.');
    try {
      const value = await workspace[params.name](params.arguments ?? {});
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
    } catch (error) {
      // Never expose arbitrary underlying exceptions: paths, transcript content,
      // or client stderr may occur in them. Allow only verified public log locations.
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'DRAFT_TOOL_FAILED';
      const location = logDiagnostic(error);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: code, ...(location ? { location } : {}) }) }], isError: true });
    }
  };
}
