import { fail } from '../core/errors.mjs';
import { packageVersion } from '../core/version.mjs';
import { bindClaudeCommand, parseAction } from './commands.mjs';
import { readFrames, writeFrame } from '../processing/draft-protocol.mjs';

// Leave room for both MCP structuredContent and its escaped text projection.
export const CONTROL_LIMITS = Object.freeze({ requestBytes: 64 * 1024, responseBytes: 256 * 1024, nodes: 10000, depth: 20 });
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ACTIONS = ['track', 'untrack', 'process', 'process project', 'save', 'skip', 'status'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const argumentError = () => fail('CONTROL_ARGUMENT_INVALID', 'Use only the advertised control arguments.');
function fields(input, required, optional = []) {
  if (!object(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) argumentError();
  const descriptors = Object.getOwnPropertyDescriptors(input), allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.has(key) || !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) argumentError();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function handle(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) argumentError();
  return value;
}
function metadata(value) {
  let nodes = 0, bytes = 0;
  function copy(input, depth) {
    if (++nodes > CONTROL_LIMITS.nodes || depth > CONTROL_LIMITS.depth) fail('CONTROL_RESPONSE_LIMIT', 'The control response exceeds its metadata bound.');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') {
      bytes += Buffer.byteLength(input); if (bytes > CONTROL_LIMITS.responseBytes) fail('CONTROL_RESPONSE_LIMIT', 'The control response exceeds its metadata bound.');
      return input;
    }
    if (!input || typeof input !== 'object' || (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))) fail('CONTROL_RESPONSE_INVALID', 'The control result must contain inert metadata.');
    const descriptors = Object.getOwnPropertyDescriptors(input), output = Array.isArray(input) ? [] : {};
    if (Array.isArray(input) && (input.length > CONTROL_LIMITS.nodes || Object.keys(descriptors).length !== input.length + 1)) fail('CONTROL_RESPONSE_INVALID', 'The control result must contain dense bounded lists.');
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(input) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value') || (Array.isArray(input) && !/^(?:0|[1-9][0-9]*)$/.test(key))) fail('CONTROL_RESPONSE_INVALID', 'The control result must contain inert metadata.');
      bytes += Buffer.byteLength(key);
      if (bytes > CONTROL_LIMITS.responseBytes) fail('CONTROL_RESPONSE_LIMIT', 'The control response exceeds its metadata bound.');
      Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    return Object.freeze(output);
  }
  const result = copy(value, 0);
  if (!object(result) || typeof result.state !== 'string' || !/^[a-z][a-z-]{0,63}$/.test(result.state)) fail('CONTROL_RESPONSE_INVALID', 'The control result must describe its actual state.');
  if (Buffer.byteLength(JSON.stringify(result)) > CONTROL_LIMITS.responseBytes) fail('CONTROL_RESPONSE_LIMIT', 'The control response exceeds its metadata bound.');
  return result;
}
function tool(client) {
  return client === 'codex' ? {
    name: 'cuefluent_control', description: 'Execute the exact Cuefluent Notes action selected in this native user turn. Running is not completion; use a new typed status command to inspect later progress.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS } }, required: ['action'], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  } : {
    name: 'cuefluent_invocation', description: 'Read the result of the exact current invocation handle issued by the trusted Cuefluent Notes command hook. Polling never starts or retries work.',
    inputSchema: { type: 'object', properties: { handle: { type: 'string', minLength: 43, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } }, required: ['handle'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  };
}

/** Called only by the native expansion hook, never by a model tool. The root
 * callback owns the durable current-prompt claim and executes executeControl.
 * It returns an opaque current handle for work. Read-only status and an
 * unconfigured result can return directly without creating invocation state. */
export async function executeClaudeExpansion(envelope, selection, { executeInvocation } = {}) {
  if (typeof executeInvocation !== 'function') fail('CONTROL_EXECUTOR_REQUIRED', 'A trusted current-invocation executor is required.');
  const binding = bindClaudeCommand(envelope, selection);
  if (!binding) return null;
  const result = metadata(await executeInvocation(binding));
  if (result.handle !== undefined) handle(result.handle);
  else if (binding.action !== 'status' && !['unconfigured', 'busy', 'not-executed'].includes(result.state)) handle(result.handle);
  return result;
}

/** No model-supplied path/session/prompt authority. executeInvocation must fence
 * and deduplicate the trusted current prompt durably before executeControl. The
 * bridge deliberately has no process-local receipt cache or command history. */
export function createControlBridge({ client, selection, codexAdapter, executeInvocation, readInvocation } = {}) {
  if (!['claude', 'codex'].includes(client) || (client === 'codex' && (typeof codexAdapter?.bindCommand !== 'function' || typeof executeInvocation !== 'function')) ||
      (client === 'claude' && typeof readInvocation !== 'function')) fail('CONTROL_ADAPTER_INVALID', 'A trusted native control adapter is required.');
  const definition = structuredClone(tool(client));
  const bridge = {
    tools: Object.freeze([Object.freeze(definition)]),
    async call(name, args, { meta } = {}) {
      if (name !== definition.name) fail('CONTROL_TOOL_UNKNOWN', 'The control tool is unavailable.');
      if (client === 'claude') { const input = fields(args, ['handle']); return metadata(await readInvocation(handle(input.handle))); }
      const input = fields(args, ['action']), action = parseAction(input.action);
      if (action !== input.action) argumentError();
      const resolved = await codexAdapter.bindCommand(meta, selection);
      if (resolved?.status === 'pending') return metadata({ state: 'pending', reason: resolved.reason });
      if (resolved?.status !== 'ready' || resolved.binding?.client !== 'codex' || resolved.binding.action !== action) fail('NATIVE_COMMAND_MISMATCH', 'The requested action does not match the exact native invocation.');
      return metadata(await executeInvocation(resolved.binding));
    },
    protocol({ version } = {}) {
      const serverVersion = packageVersion(version);
      let initialized = false, ready = false;
      const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
      const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
      return async message => {
        let request;
        try { request = fields(message, ['jsonrpc', 'method'], ['id', 'params']); }
        catch { return error(null, -32600, 'Invalid request.'); }
        const { id, method, params } = request;
        if (request.jsonrpc !== '2.0' || typeof method !== 'string' || (id !== undefined && !(typeof id === 'string' && id.length <= 128) && !Number.isSafeInteger(id))) return error(null, -32600, 'Invalid request.');
        if (id === undefined) { if (initialized && method === 'notifications/initialized') ready = true; return null; }
        if (method === 'ping') return result(id, {});
        if (method === 'initialize') {
          let input;
          try { input = fields(params, ['protocolVersion', 'capabilities', 'clientInfo'], ['_meta']); } catch { return error(id, -32602, 'Invalid initialization.'); }
          if (initialized || typeof input.protocolVersion !== 'string' || !object(input.capabilities) || !object(input.clientInfo)) return error(id, -32602, 'Invalid initialization.');
          initialized = true;
          return result(id, { protocolVersion: VERSIONS.includes(input.protocolVersion) ? input.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'cuefluent-control', version: serverVersion } });
        }
        if (!ready) return error(id, -32002, 'Initialize the control connection first.');
        if (method === 'tools/list') {
          try { fields(params ?? {}, [], ['_meta']); } catch { return error(id, -32602, 'The control tool list is not paginated.'); }
          return result(id, { tools: bridge.tools });
        }
        if (method !== 'tools/call') return error(id, -32601, 'Method not found.');
        let input;
        try { input = fields(params, ['name', 'arguments'], ['_meta']); } catch { return error(id, -32602, 'Invalid tool call.'); }
        try {
          const value = await bridge.call(input.name, input.arguments, { meta: input._meta });
          return result(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
        } catch (caught) {
          const code = typeof caught?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(caught.code) ? caught.code : 'CONTROL_TOOL_FAILED';
          return result(id, { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], isError: true });
        }
      };
    },
  };
  return Object.freeze(bridge);
}

/** Serial bounded MCP stdio. Host entrypoints own exit policy and resources. */
export function serveControl(bridge, { input = process.stdin, output = process.stdout, onFailure = () => {}, version } = {}) {
  if (typeof bridge?.protocol !== 'function' || typeof onFailure !== 'function') fail('CONTROL_ADAPTER_INVALID', 'A control protocol is required.');
  const protocol = bridge.protocol({ version });
  return readFrames(input, async message => { const response = await protocol(message); if (response) await writeFrame(output, response); }, onFailure,
    { maxBytes: CONTROL_LIMITS.requestBytes, queuedBytes: 2 * CONTROL_LIMITS.requestBytes });
}
