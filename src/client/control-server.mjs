import { fail } from '../core/errors.mjs';
import { describeFailure } from '../diagnostics.mjs';
import { packageVersion } from '../core/version.mjs';
import { bindClaudeCommand, parseAction } from './commands.mjs';
import { readFrames, writeFrame } from '../processing/draft-protocol.mjs';

// Leave room for both MCP structuredContent and its escaped text projection.
export const CONTROL_LIMITS = Object.freeze({ requestBytes: 1024 * 1024, responseBytes: 256 * 1024, nodes: 10000, depth: 20 });
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ACTIONS = ['track', 'untrack', 'process', 'process project', 'save', 'skip', 'status'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const argumentError = () => fail('CONTROL_ARGUMENT_INVALID', 'Use only the advertised control arguments.');
export function fields(input, required, optional = [], invalid = argumentError) {
  if (!object(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.has(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) || required.some(key => !Object.hasOwn(descriptors, key))) invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
export function freezeData(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeData); Object.freeze(value); }
  return value;
}
function transportSession(client, meta, sessions) {
  // These fields come from the MCP transport, never from tool arguments. They
  // scope temporary capabilities only, and claim no transcript provenance.
  if (client !== 'codex' || !object(meta)) return null;
  const native = Object.getOwnPropertyDescriptor(meta, 'x-codex-turn-metadata')?.value;
  if (!object(native)) return null;
  const values = ['session_id', 'thread_id', 'turn_id'].map(key => Object.getOwnPropertyDescriptor(native, key)?.value);
  if (!values.every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) || values[0] !== values[1]) return null;
  const key = values[0];
  if (!sessions.has(key)) { if (sessions.size >= 128) sessions.delete(sessions.keys().next().value); sessions.set(key, Object.freeze({})); }
  return sessions.get(key);
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

/** Derive guidance only at the public boundary. Retained outcomes and their
 * warning codes stay unchanged; a historical warning is not a failed status
 * request. Only known result slots are inspected, never arbitrary nested data. */
export function presentControlResult(value, context = {}, { bounded = true } = {}) {
  // CLI/hook callers already hold validated store snapshots and had no MCP
  // envelope limit. Do not impose that transport's bound on their status output.
  const projection = input => bounded ? metadata(input) : input;
  let result = projection(value);
  const diagnosticContext = { ...context, stage: 'result' };
  const isCode = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code);
  if (result.state === 'failed') {
    result = projection({ ...result, ...describeFailure({ code: isCode(result.reason) ? result.reason : 'COMMAND_FAILED' }, diagnosticContext) });
  }
  const warnings = [];
  for (const [scope, item] of [['status', result], ['run', result.run], ['latest', result.latest], ['result', result.result]]) {
    if (!object(item) || !Array.isArray(item.warnings)) continue;
    const historical = ['saved', 'nothing-useful', 'skipped', 'empty'].includes(item.status ?? item.state);
    for (const code of new Set(item.warnings.filter(isCode))) warnings.push({ scope, code, historical });
  }
  if (!warnings.length) return result;
  const details = [];
  for (const { scope, code, historical } of warnings.slice(0, 16)) {
    const detail = { scope, ...describeFailure({ code }, diagnosticContext) };
    if (historical) {
      detail.historical = true;
      detail.message = `Warning recorded during this completed run: ${detail.message}`;
      detail.recovery = 'This run has finished. Do not retry it because of this warning. Inspect the recorded outcome and any remaining queued work before starting a new operation.';
    }
    details.push(detail);
    try {
      result = projection({ ...result, warningDetails: [...details], warningDetailsTruncated: details.length < warnings.length });
    } catch (error) {
      // The existing result has priority over optional explanatory expansion.
      // It already carries every warning, including those without extra detail.
      if (error.code !== 'CONTROL_RESPONSE_LIMIT') throw error;
      break;
    }
  }
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
 * bridge deliberately has no process-local receipt cache or command history.
 * The server never sends requests to the host; review decisions arrive as
 * ordinary tool calls citing the reviewed revision. */
export function createControlBridge({ client, selection, codexAdapter, executeInvocation, readInvocation, directNotes } = {}) {
  if (!['claude', 'codex'].includes(client) || (client === 'codex' && (typeof codexAdapter?.bindCommand !== 'function' || typeof executeInvocation !== 'function')) ||
      (client === 'claude' && typeof readInvocation !== 'function')) fail('CONTROL_ADAPTER_INVALID', 'A trusted native control adapter is required.');
  const definition = structuredClone(tool(client));
  if (directNotes && (typeof directNotes.call !== 'function' || !Array.isArray(directNotes.tools))) fail('CONTROL_ADAPTER_INVALID', 'A trusted direct note handler is required.');
  const noteTools = structuredClone(directNotes?.tools ?? []);
  const names = [definition.name, ...noteTools.map(item => item?.name)];
  if (names.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)) || new Set(names).size !== names.length) fail('CONTROL_ADAPTER_INVALID', 'Control tool names must be unique and disjoint.');
  const bridge = {
    tools: freezeData([definition, ...noteTools]),
    async call(name, args, { meta, session = null, canInspect = false } = {}) {
      if (noteTools.some(item => item.name === name)) return metadata(await directNotes.call(name, args, { session, canInspect }));
      if (name !== definition.name) fail('CONTROL_TOOL_UNKNOWN', 'The control tool is unavailable.');
      if (client === 'claude') { const input = fields(args, ['handle']); return metadata(await readInvocation(handle(input.handle))); }
      const input = fields(args, ['action']), action = parseAction(input.action);
      if (action !== input.action) argumentError();
      const resolved = await codexAdapter.bindCommand(meta, selection);
      if (resolved?.status === 'pending') return metadata({ state: 'pending', reason: resolved.reason });
      if (resolved?.status !== 'ready' || resolved.binding?.client !== 'codex' || resolved.binding.action !== action) fail('NATIVE_COMMAND_MISMATCH', 'The requested action does not match the exact native invocation.');
      return metadata(await executeInvocation(resolved.binding));
    },
    protocol(options = {}) {
      const { version } = fields(options, [], ['version'], () => fail('CONTROL_ADAPTER_INVALID', 'The control protocol accepts only its package version.'));
      const serverVersion = packageVersion(version);
      let initialized = false, ready = false, closed = false;
      const sessions = new Map(), calls = new Map(), connection = Object.freeze({});
      const begin = message => {
        if (message?.method !== 'tools/call' || !Object.hasOwn(message, 'id') ||
            !(typeof message.id === 'string' && message.id.length <= 128) && !Number.isSafeInteger(message.id)) return null;
        if (calls.has(message.id)) return { duplicate: true };
        if (calls.size >= 64) return { duplicate: true };
        const state = { id: message.id }; calls.set(message.id, state); return state;
      };
      const finish = state => { if (state && calls.get(state.id) === state) calls.delete(state.id); };
      const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
      const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
      // The server sends no requests, so a host response has nothing to settle,
      // and a cancellation notice cannot abandon a bounded tool call midway.
      // Both are consumed without failing the connection.
      const receive = message => {
        if (message?.method === 'notifications/cancelled' && message.jsonrpc === '2.0' && !Object.hasOwn(message, 'id')) return true;
        return object(message) && !Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id') &&
          (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'));
      };
      const protocol = async (message, queuedState) => {
        if (receive(message)) return null;
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
        try { input = fields(params, ['name'], ['arguments', '_meta']); } catch { return error(id, -32602, 'Invalid tool call.'); }
        const state = queuedState ?? begin(message);
        if (state?.duplicate) return error(id, -32600, 'A tool request with this identity is already pending.');
        try {
          // A host that already ended the connection gets a coded tool failure for
          // work it queued afterwards; nothing starts on its behalf.
          if (closed) fail('CONTROL_CONNECTION_CLOSED', 'The control connection closed before this request ran.');
          const native = transportSession(client, input._meta, sessions);
          const value = await bridge.call(input.name, input.arguments ?? {}, { meta: input._meta,
            session: native ?? connection, canInspect: client === 'claude' || native !== null });
          const presented = presentControlResult(value, { client, version: serverVersion, toolName: input.name });
          return result(id, { content: [{ type: 'text', text: JSON.stringify(presented) }], structuredContent: presented, isError: value.state === 'failed' });
        } catch (caught) {
          const failure = describeFailure(caught, { fallback: 'CONTROL_TOOL_FAILED', stage: 'tool', client, version: serverVersion, toolName: input.name });
          return result(id, { content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure, isError: true });
        } finally { finish(state); }
      };
      protocol.begin = begin;
      protocol.finish = finish;
      protocol.receive = receive;
      protocol.close = () => { closed = true; sessions.clear(); };
      return protocol;
    },
  };
  return Object.freeze(bridge);
}

/** Serial bounded MCP stdio. Host entrypoints own exit policy and resources. */
export function serveControl(bridge, { input = process.stdin, output = process.stdout, onFailure = () => {}, version } = {}) {
  if (typeof bridge?.protocol !== 'function' || typeof onFailure !== 'function') fail('CONTROL_ADAPTER_INVALID', 'A control protocol is required.');
  const protocol = bridge.protocol({ version });
  let work = Promise.resolve(), queuedBytes = 0, queued = 0, stopped = false;
  const stop = error => { if (stopped) return; stopped = true; protocol.close(); onFailure(error); };
  const reader = readFrames(input, message => {
    if (protocol.receive(message)) return;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (++queued > 64 || (queuedBytes += bytes) > 2 * CONTROL_LIMITS.requestBytes) fail('CONTROL_REQUEST_LIMIT', 'Too many pending control requests.');
    const state = protocol.begin(message);
    work = work.then(async () => { if (!stopped) { const response = await protocol(message, state); if (response) await writeFrame(output, response); } })
      .catch(stop).finally(() => { protocol.finish(state); queued--; queuedBytes -= bytes; });
  }, stop, { maxBytes: CONTROL_LIMITS.requestBytes, queuedBytes: 2 * CONTROL_LIMITS.requestBytes });
  input.on('end', () => protocol.close());
  return { stop: error => reader.stop(error), idle: async () => { await reader.idle(); await work; } };
}
