import path from 'node:path';
import { canonicalWorkflowPath } from './workflow-paths.mjs';
import os from 'node:os';
import { spawnStreamingCommand } from './command.mjs';
import { canonicalJSON, digest, fail, isNativeId, object, safeErrorCode } from './workflow-values.mjs';
import { MAX_PROCESSING_ENGINE_RESULT_BYTES } from './processing-tool-contracts.mjs';

const MAX_FRAME = 2 * 1024 * 1024;
const MAX_FEATURES = 512;
const MAX_SERVERS = 256;
const CORE_FLAGS = new Set(['unified_exec', 'guardianv2.thread_context']);
const REQUIRED_FLAGS = ['shell_tool', 'view_image', 'apps', 'plugins', 'remote_plugin', 'hooks',
  'goals', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'memories'];
const CODE = 'PROCESSING_CLIENT_UNAVAILABLE';
export async function codexProcessingProfile(env = process.env) {
  const home = await canonicalWorkflowPath(env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  return digest(canonicalJSON({ home, platform: ({ darwin: 'macos', win32: 'windows' })[process.platform] ?? process.platform }));
}
const identity = value => {
  if (!isNativeId(value)) fail('PROCESSING_CLIENT_IDENTITY_CHANGED');
  return value;
};
function bounded(value, limit = MAX_FRAME) {
  let bytes;
  try { bytes = JSON.stringify(value); } catch { fail('INVALID_PROCESSING_CLIENT_MESSAGE'); }
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > limit) fail('PROCESSING_CLIENT_MESSAGE_LIMIT');
  return bytes;
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail(CODE);
  return value;
}
function toolsContract(tools) {
  if (!Array.isArray(tools) || !tools.length || tools.length > 32) fail(CODE);
  const names = new Set();
  for (const tool of tools) {
    if (!object(tool) || tool.type !== 'function' || typeof tool.name !== 'string' ||
        !/^cuefluent_[a-z][a-z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name) ||
        typeof tool.description !== 'string' || !object(tool.inputSchema) ||
        Object.keys(tool).some(key => !['type', 'name', 'description', 'inputSchema'].includes(key))) fail(CODE);
    names.add(tool.name);
  }
  bounded(tools, 64 * 1024);
  return { names, specs: structuredClone(tools) };
}

/** A native-client transport, not processing authority. The controller owns session roles,
 * exact approvals and operation recovery. No model/provider override or config write is made.
 * Only turns started through this connection have its restrictions; direct native UI turns
 * in the same thread must not inherit collection exclusion from this transport's identity.
 */
export async function openCodexProcessingClient({ executable = 'codex', cwd, tools, onEngineTool,
  onUserInput, onEvent, instructions = 'Use only the Cuefluent engine tools for the selected processing task.' }, {
  spawnProcess = spawnStreamingCommand, env = process.env, requestTimeoutMs = 15_000, turnTimeoutMs = 30 * 60_000,
} = {}) {
  absolute(cwd);
  const contract = toolsContract(tools);
  if (typeof executable !== 'string' || !executable || typeof onEngineTool !== 'function' ||
      typeof instructions !== 'string' || Buffer.byteLength(instructions) > 32 * 1024 ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      !Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1) fail(CODE);
  let child;
  try { child = spawnProcess(executable, ['app-server', '--stdio'], { cwd, env,
    shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { fail(CODE); }
  let nextId = 0, buffer = Buffer.alloc(0), broken = null, closed = false;
  let profile = null, current = null, active = null, opening = false, warningSeen = false, policyNames = null;
  const pending = new Map();
  const inFlightTools = new Set();
  const seenCalls = new Set();
  const toolError = code => ({ success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: code }) }] });
  const emit = (event) => {
    if (typeof onEvent === 'function') Promise.resolve().then(() => onEvent(event)).catch(() => breakTransport('PROCESSING_CLIENT_CALLBACK_FAILED'));
  };
  function breakTransport(code = 'PROCESSING_CLIENT_OUTCOME_UNKNOWN') {
    if (broken) return;
    broken = Object.assign(new Error(code), { code });
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(broken); }
    pending.clear();
    if (active) { clearTimeout(active.timer); active.reject(broken); active.readyReject(broken); active = null; }
    child.kill();
  }
  const send = message => {
    if (broken) throw broken;
    if (closed) fail(CODE);
    child.stdin.write(bounded(message) + '\n', error => { if (error) breakTransport(); });
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (broken || closed) { reject(broken ?? Object.assign(new Error(CODE), { code: CODE })); return; }
    const id = ++nextId;
    const timer = setTimeout(() => breakTransport(), requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); } catch (error) { breakTransport(safeErrorCode(error, CODE)); }
  });
  async function serverRequest(message) {
    const task = active;
    if (!task) { breakTransport('PROCESSING_CLIENT_POLICY_CHANGED'); return; }
    await task.ready;
    if (active !== task || broken) return;
    const p = message.params;
    if (!object(p) || p.threadId !== current?.sessionId || p.turnId !== task.unitId) {
      breakTransport('PROCESSING_CLIENT_IDENTITY_CHANGED'); return;
    }
    await task.roleGuard({ ...current, unitId: task.unitId, phase: 'before-tool' });
    if (active !== task || broken) return;
    let result;
    if (message.method === 'item/tool/call') {
      if (p.namespace != null || !contract.names.has(p.tool) || typeof p.callId !== 'string' ||
          !p.callId || p.callId.length > 512 || seenCalls.has(p.callId) || seenCalls.size >= 4096) {
        breakTransport('PROCESSING_CLIENT_POLICY_CHANGED'); return;
      }
      seenCalls.add(p.callId);
      try { bounded(p.arguments, 1024 * 1024); }
      catch { result = toolError('PROCESSING_ENGINE_INPUT_LIMIT'); }
      if (!result) {
        let output;
        try {
          output = await onEngineTool({ ...current, unitId: task.unitId, callId: p.callId,
            tool: p.tool, arguments: structuredClone(p.arguments) });
        } catch (error) {
          // Engine refusals are outcomes of a tool call, not evidence that the
          // native protocol failed. Return only a safe code, never private text.
          result = toolError(safeErrorCode(error, 'PROCESSING_ENGINE_FAILED'));
        }
        if (!result) {
          try {
            result = { success: true, contentItems: [{ type: 'inputText', text: bounded(output, MAX_PROCESSING_ENGINE_RESULT_BYTES) }] };
            // The nested JSON string can expand again in the wire envelope.
            bounded({ id: message.id, result });
          } catch {
            result = toolError('PROCESSING_ENGINE_OUTPUT_LIMIT');
          }
        }
      }
    } else if (message.method === 'item/tool/requestUserInput' && typeof onUserInput === 'function') {
      // This callback must obtain real structured user input. Model text is never approval.
      bounded(p, 64 * 1024);
      if (!Array.isArray(p.questions) || !p.questions.length || p.questions.length > 3 ||
          p.questions.some(q => !object(q) || typeof q.id !== 'string' || !q.id || q.id.length > 512) ||
          new Set(p.questions.map(q => q.id)).size !== p.questions.length) fail(CODE);
      result = await onUserInput({ ...current, unitId: task.unitId, request: structuredClone(p) });
      if (!object(result) || !object(result.answers) || Object.keys(result).some(k => k !== 'answers')) fail(CODE);
      const questionIds = new Set((p.questions ?? []).map(q => q.id));
      for (const [key, value] of Object.entries(result.answers)) {
        if (!questionIds.has(key) || !object(value) || !Array.isArray(value.answers) ||
            Object.keys(value).some(k => k !== 'answers') || value.answers.some(a => typeof a !== 'string')) fail(CODE);
      }
      bounded(result, 64 * 1024);
    } else {
      // Never approve a native filesystem, command, permission or MCP request.
      breakTransport('PROCESSING_CLIENT_POLICY_CHANGED'); return;
    }
    await task.roleGuard({ ...current, unitId: task.unitId, phase: 'after-tool' });
    if (active === task && !broken) send({ id: message.id, result });
  }
  function receive(message) {
    if (!object(message)) { breakTransport(); return; }
    if (Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id')) {
      const work = serverRequest(message).catch(error => breakTransport(safeErrorCode(error, CODE)));
      inFlightTools.add(work);
      work.finally(() => inFlightTools.delete(work));
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      const entry = pending.get(message.id);
      if (!entry) { breakTransport(); return; }
      clearTimeout(entry.timer); pending.delete(message.id);
      if (message.error) entry.reject(Object.assign(new Error(CODE), { code: CODE }));
      else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
      else { entry.reject(Object.assign(new Error(CODE), { code: CODE })); breakTransport(); }
      return;
    }
    if (message.method === 'warning') {
      // Warnings are diagnostics, not evidence of a changed capability. Active
      // turns verify policy on a warning and again at terminal.
      if (!active) warningSeen = true;
      else {
        const check = verifyPolicy(current, policyNames).catch(error => breakTransport(safeErrorCode(error, CODE)));
        inFlightTools.add(check); check.finally(() => inFlightTools.delete(check));
      }
    }
    if (message.method === 'turn/completed' && active) {
      const task = active;
      task.ready.then(async () => {
        // A native interrupted terminal does not cancel an already-running
        // engine callback. Drain it before allowing controller recovery/reuse.
        await Promise.allSettled([...inFlightTools]);
        if (active !== task || broken) return;
        const p = message.params;
        if (p?.threadId !== current?.sessionId || p?.turn?.id !== task.unitId ||
            !['completed', 'interrupted', 'failed'].includes(p.turn.status)) {
          breakTransport('PROCESSING_CLIENT_IDENTITY_CHANGED'); return;
        }
        await verifyPolicy(current, policyNames);
        clearTimeout(task.timer); active = null;
        task.resolve({ ...current, unitId: task.unitId, status: p.turn.status,
          // Output remains in the processing channel. The parent receives metadata only.
          navigation: { client: 'codex', sessionId: current.sessionId, desktopVerified: false } });
      }).catch(error => breakTransport(safeErrorCode(error, CODE)));
    }
    if (message.method === 'item/agentMessage/delta' && active) {
      const task = active;
      task.ready.then(() => {
        if (active !== task || broken) return;
        if (message.params?.threadId !== current?.sessionId || message.params?.turnId !== task.unitId) {
          breakTransport('PROCESSING_CLIENT_IDENTITY_CHANGED'); return;
        }
        // UI hosts may render processing-channel text; never return it as a parent-chat payload.
        emit({ type: 'message', sessionId: current.sessionId, unitId: task.unitId,
          text: typeof message.params.delta === 'string' ? message.params.delta : '' });
      }).catch(() => {});
    }
  }
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME) { breakTransport('PROCESSING_CLIENT_MESSAGE_LIMIT'); return; }
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      if (!line.length) continue;
      try { receive(JSON.parse(line.toString('utf8'))); } catch { breakTransport(); return; }
    }
  });
  // Drain native stderr without publishing private paths, instructions or provider errors.
  child.stderr.on('data', () => {});
  child.on('error', () => breakTransport(CODE));
  child.on('exit', () => { if (!closed) breakTransport(); });
  child.stdin.on('error', () => breakTransport());

  async function inventory(method, extra = {}, maximum = MAX_FEATURES) {
    const values = [], cursors = new Set();
    let cursor;
    do {
      const result = await request(method, { ...extra, limit: 256, ...(cursor ? { cursor } : {}) });
      if (!object(result) || !Array.isArray(result.data) || values.length + result.data.length > maximum) fail(CODE);
      values.push(...result.data);
      cursor = result.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor))) fail(CODE);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return values;
  }
  async function restrictions() {
    const features = await inventory('experimentalFeature/list');
    const names = new Set();
    const config = { 'agents.enabled': false, web_search: 'disabled', 'apps._default.enabled': false };
    for (const feature of features) {
      if (!object(feature) || typeof feature.name !== 'string' || !/^[a-z][a-z0-9_.]{0,99}$/.test(feature.name) ||
          names.has(feature.name) || typeof feature.enabled !== 'boolean') fail(CODE);
      if (REQUIRED_FLAGS.includes(feature.name) && ['removed', 'deprecated'].includes(feature.stage)) fail(CODE);
      names.add(feature.name);
      if (!['removed', 'deprecated'].includes(feature.stage)) config[`features.${feature.name}`] = false;
    }
    if (REQUIRED_FLAGS.some(name => !names.has(name))) fail(CODE);
    const read = await request('config/read', { cwd, includeLayers: false });
    if (!object(read?.config)) fail(CODE);
    const servers = read.config.mcp_servers ?? {};
    if (!object(servers) || Object.keys(servers).length > MAX_SERVERS) fail(CODE);
    // Empty tables merge with inherited configuration; disable every entry explicitly.
    config.mcp_servers = Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }]));
    return { config, names };
  }
  async function verifyPolicy(session, names) {
    const features = await inventory('experimentalFeature/list', { threadId: session.sessionId });
    if (features.length !== names.size || new Set(features.map(f => f.name)).size !== names.size || features.some(f => !names.has(f.name) ||
        (REQUIRED_FLAGS.includes(f.name) && ['removed', 'deprecated'].includes(f.stage)) ||
        (!['removed', 'deprecated'].includes(f.stage) && f.enabled !== false && !CORE_FLAGS.has(f.name)))) fail('PROCESSING_CLIENT_POLICY_CHANGED');
    const servers = await inventory('mcpServerStatus/list', { threadId: session.sessionId }, MAX_SERVERS);
    if (servers.some(s => s.runtimeStatus !== 'disabled' || !object(s.tools) || Object.keys(s.tools).length ||
        !Array.isArray(s.resources) || s.resources.length || !Array.isArray(s.resourceTemplates) || s.resourceTemplates.length)) fail('PROCESSING_CLIENT_POLICY_CHANGED');
    if (warningSeen) fail('PROCESSING_CLIENT_POLICY_CHANGED');
  }
  function checkedSession(result, expected = null) {
    const t = result?.thread;
    if (!object(t) || t.ephemeral !== false || t.forkedFromId != null || t.parentThreadId != null ||
        t.status?.type !== 'idle' || result.approvalPolicy !== 'never' ||
        result.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess !== false ||
        path.resolve(result.cwd) !== path.resolve(cwd)) fail('PROCESSING_CLIENT_POLICY_CHANGED');
    const session = { client: 'codex', sessionId: identity(t.id), sourcePath: absolute(t.path),
      cwd, profileId: profile.profileId, transport: 'codex-app-server', desktopVerified: false };
    if (t.sessionId !== session.sessionId || (expected &&
        ['sessionId', 'sourcePath', 'cwd', 'profileId'].some(k => expected[k] !== session[k]))) fail('PROCESSING_CLIENT_IDENTITY_CHANGED');
    return session;
  }
  async function load(expected) {
    if (active || opening) fail('PROCESSING_CLIENT_BUSY');
    opening = true; warningSeen = false;
    let requested = false;
    try {
      const restriction = await restrictions();
      const params = { cwd, config: restriction.config, approvalPolicy: 'never', sandbox: 'read-only',
        developerInstructions: instructions };
      requested = true;
      const result = expected
        ? await request('thread/resume', { ...params, threadId: identity(expected.sessionId), excludeTurns: true })
        : await request('thread/start', { ...params, ephemeral: false, selectedCapabilityRoots: [], dynamicTools: contract.specs });
      const session = checkedSession(result, expected);
      const toolContractHash = digest(canonicalJSON(contract.specs));
      if (expected && expected.toolContractHash !== toolContractHash) fail('PROCESSING_CLIENT_POLICY_CHANGED');
      await verifyPolicy(session, restriction.names);
      policyNames = restriction.names;
      current = { ...session, toolContractHash };
      return structuredClone(current);
    } catch (error) {
      breakTransport(safeErrorCode(error, CODE));
      throw Object.assign(new Error(broken.code), { code: broken.code, outcome: requested ? 'unknown' : 'not-dispatched' });
    } finally { opening = false; }
  }
  try {
    const result = await request('initialize', { clientInfo: { name: 'cuefluent_processing', version: '1' },
      capabilities: { experimentalApi: true } });
    profile = { profileId: digest(canonicalJSON({ home: absolute(result?.codexHome),
      platform: typeof result.platformOs === 'string' ? result.platformOs : '' })) };
    send({ method: 'initialized', params: {} });
  } catch (error) { breakTransport(safeErrorCode(error, CODE)); throw broken; }
  return {
    profileId: profile.profileId,
    create: () => load(null),
    resume: expected => load(expected),
    async startTurn({ session, input, roleGuard }) {
      if (active || opening) fail('PROCESSING_CLIENT_BUSY');
      if (!current || canonicalJSON(session) !== canonicalJSON(current) || typeof roleGuard !== 'function' ||
          typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 64 * 1024) fail(CODE);
      if (broken) throw broken;
      opening = true;
      try {
        await verifyPolicy(current, policyNames);
        await roleGuard({ ...current, unitId: null, phase: 'before-input' });
        if (broken || closed) fail(CODE);
      } catch (error) {
        // No turn/start has been sent at this point. Controller admission may
        // be released without guessing about any native execution outcome.
        throw Object.assign(new Error(safeErrorCode(error, CODE)), {
          code: safeErrorCode(error, CODE), outcome: 'not-dispatched',
        });
      } finally { opening = false; }
      let resolve, reject, readyResolve, readyReject;
      const completion = new Promise((a, b) => { resolve = a; reject = b; });
      const ready = new Promise((a, b) => { readyResolve = a; readyReject = b; });
      // Rejections can occur while turn/start is pending, before awaiting completion.
      completion.catch(() => {}); ready.catch(() => {});
      const task = { resolve, reject, ready, readyResolve, readyReject, roleGuard, unitId: null,
        timer: setTimeout(() => breakTransport(), turnTimeoutMs) };
      active = task; seenCalls.clear();
      try {
        const result = await request('turn/start', { threadId: current.sessionId,
          input: [{ type: 'text', text: input, text_elements: [] }], approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false } });
        task.unitId = identity(result?.turn?.id);
        await roleGuard({ ...current, unitId: task.unitId, phase: 'started' });
        task.readyResolve();
      } catch (error) { breakTransport(safeErrorCode(error, CODE)); }
      return completion;
    },
    async interrupt() {
      if (!active?.unitId || !current) fail('PROCESSING_CLIENT_NOT_RUNNING');
      await request('turn/interrupt', { threadId: current.sessionId, turnId: active.unitId });
    },
    async close() {
      if (closed) return;
      if (active) breakTransport();
      closed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error(CODE), { code: CODE })); }
      pending.clear(); child.stdin.end(); child.kill();
    },
    capabilities: { client: 'codex', nativeTransport: 'app-server', desktopVerified: false,
      approvals: 'controller-callback', persistentRoleExclusion: false },
  };
}
