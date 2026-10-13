import path from 'node:path';
import { spawn as nativeSpawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { fail, keys, list, nativeId, object, safeErrorCode, string, unique } from './workflow-values.mjs';
import { validateClaudeRestrictedSettings } from './processing-claude-settings.mjs';

const SERVER = 'cuefluent_engine';
const MAX_PROMPT_BYTES = 64 * 1024, MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;
const nativeError = (code, dispatched) => Object.assign(new Error(code), {
  code, outcome: dispatched ? 'unknown' : 'not-dispatched'
});

function environment(value) {
  if (!object(value) || Object.keys(value).length > 256) fail('INVALID_PROCESSING_CLIENT');
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('INVALID_PROCESSING_CLIENT');
    try { string(entry, 32768, { empty: true }); }
    catch { fail('INVALID_PROCESSING_CLIENT'); }
  }
  return { ...value };
}

function toolNames(value) {
  list(value, 64, { empty: false }); unique(value);
  for (const name of value) if (typeof name !== 'string' || !/^mcp__cuefluent_engine__[a-z][a-z0-9_]{0,63}$/.test(name)) fail('INVALID_PROCESSING_CLIENT_TOOLS');
  return [...value].sort();
}

/** A native-client transport, not an evidence or approval authority. The trusted
 * controller supplies the sole engine server and reserves/excludes the UUID in
 * beforeDispatch. The server must bind every operation to that reservation and
 * must never expose model-callable approval or arbitrary command execution. */
export function createClaudeProcessingClient(options, { env: baseEnv = process.env } = {}) {
  keys(options, ['executable', 'cwd', 'engine', 'allowedTools'], ['env', 'settings', 'timeoutMs', 'maxOutputBytes', 'spawn']);
  const { executable, cwd, engine } = options;
  string(executable, 4096); string(cwd, 4096);
  if (!path.isAbsolute(cwd) || /\.(cmd|bat)$/i.test(executable)) fail('INVALID_PROCESSING_CLIENT');
  keys(engine, ['command', 'args'], ['env']);
  string(engine.command, 4096); list(engine.args, 64);
  for (const argument of engine.args) string(argument, 32768, { empty: true });
  const allowed = toolNames(options.allowedTools), allowedSet = new Set(allowed);
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60 * 1000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 32 * 1024 * 1024) fail('INVALID_PROCESSING_CLIENT');
  const spawn = options.spawn ?? nativeSpawn;
  if (typeof spawn !== 'function') fail('INVALID_PROCESSING_CLIENT');
  const engineEnv = engine.env === undefined ? {} : environment(engine.env);
  if (Object.keys(engineEnv).some(name => !/^CUEFLUENT_ENGINE_[A-Z0-9_]+$/.test(name))) fail('INVALID_PROCESSING_CLIENT');
  // Authentication is process environment data, never an MCP JSON command-line
  // argument. Native Claude forwards these variables to its engine child.
  // Host dependencies supply the inherited OS environment, as in the Codex
  // adapter. It may be a copy and contain Windows names such as ProgramFiles(x86).
  // Explicit replacement maps and engine overrides retain strict validation;
  // serialized requests cannot supply the host dependency environment.
  const inheritedEnv = options.env === undefined ? baseEnv : environment(options.env);
  const env = { ...inheritedEnv, ...engineEnv };
  const settings = validateClaudeRestrictedSettings(options.settings === undefined ? { disableAllHooks: true } : options.settings);
  // This explicitly requested native controller owns a separate restricted run.
  // Do not inherit the enclosing Claude session's nested-launch sentinel.
  for (const name of Object.keys(env)) {
    if (name === 'CLAUDECODE' || (process.platform === 'win32' && name.toUpperCase() === 'CLAUDECODE')) delete env[name];
  }
  const server = { command: engine.command, args: [...engine.args] };
  const mcp = JSON.stringify({ mcpServers: { [SERVER]: server } });
  if (Buffer.byteLength(mcp) > 128 * 1024) fail('INVALID_PROCESSING_CLIENT');
  const active = new Set();

  return Object.freeze({
    async run(request) {
      keys(request, ['sessionId', 'inputId', 'resume', 'prompt', 'beforeDispatch'], ['onEvent', 'signal']);
      const { sessionId, inputId, resume, prompt, beforeDispatch, onEvent, signal } = request;
      nativeId(sessionId); nativeId(inputId); string(prompt, MAX_PROMPT_BYTES);
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES || typeof resume !== 'boolean' || typeof beforeDispatch !== 'function' ||
          (onEvent !== undefined && typeof onEvent !== 'function') ||
          (signal !== undefined && !(signal instanceof AbortSignal))) fail('INVALID_PROCESSING_CLIENT');
      if (active.has(sessionId)) throw nativeError('PROCESSING_CLIENT_BUSY', false);
      if (signal?.aborted) throw nativeError('PROCESSING_CLIENT_INTERRUPTED', false);
      active.add(sessionId);
      try {
        // No process (and therefore no model turn) exists before this durable gate.
        try { await beforeDispatch({ client: 'claude', sessionId, inputId, resume }); }
        catch (error) { throw nativeError(safeErrorCode(error, 'PROCESSING_CLIENT_START_FAILED'), false); }
        if (signal?.aborted) throw nativeError('PROCESSING_CLIENT_INTERRUPTED', false);
        const args = ['--print', '--restricted', '--disable-slash-commands', '--no-chrome',
          '--setting-sources', '', '--settings', JSON.stringify(settings),
          '--tools', '', '--strict-mcp-config', '--mcp-config', mcp,
          '--allowedTools', allowed.join(','), '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
          '--input-format', 'stream-json', '--replay-user-messages', '--output-format', 'stream-json', '--verbose',
          resume ? '--resume' : '--session-id', sessionId];
        return await execute({ spawn, executable, args, cwd, env, prompt, sessionId, inputId, allowed, allowedSet,
          timeoutMs, maxOutputBytes, onEvent, signal });
      } finally { active.delete(sessionId); }
    }
  });
}

function execute({ spawn, executable, args, cwd, env, prompt, sessionId, inputId, allowed, allowedSet,
  timeoutMs, maxOutputBytes, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    let child, initialized = null, result = null, terminalFailed = false, replayed = false, dispatched = false, settled = false, failure = null;
    let buffered = Buffer.alloc(0), outputBytes = 0, timer, terminationTimer;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(terminationTimer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({ client: 'claude', sessionId, inputId, status: terminalFailed ? 'failed' : 'completed', model: initialized.model,
        clientVersion: initialized.claude_code_version, tools: [...allowed],
        output: terminalFailed ? '' : result.result, desktopVisibility: 'unverified' });
    };
    const stop = code => {
      if (settled || failure) return;
      failure = nativeError(code, dispatched);
      try { child?.kill('SIGKILL'); } catch { /* Unknown outcome remains blocked. */ }
      terminationTimer = setTimeout(() => finish(failure), 1000);
    };
    const abort = () => stop('PROCESSING_CLIENT_INTERRUPTED');
    const emit = event => {
      if (!onEvent) return;
      // Keep engine mutations out of observational callbacks. An asynchronous
      // observer cannot be used as dispatch or approval authority.
      const returned = onEvent(event);
      if (returned?.then) { Promise.resolve(returned).catch(() => {}); throw nativeError('PROCESSING_CLIENT_ASYNC_OBSERVER', dispatched); }
    };
    const record = row => {
      if (!object(row) || typeof row.type !== 'string') fail('PROCESSING_CLIENT_PROTOCOL');
      if (row.session_id !== undefined && row.session_id !== sessionId) fail('PROCESSING_CLIENT_IDENTITY_CHANGED');
      if (row.type === 'system' && row.subtype === 'init') {
        if (initialized || row.session_id !== sessionId || row.permissionMode !== 'dontAsk' ||
            !Array.isArray(row.tools) || row.tools.length !== allowed.length || new Set(row.tools).size !== allowed.length ||
            row.tools.some(name => !allowedSet.has(name)) ||
            !Array.isArray(row.slash_commands) || row.slash_commands.length || !Array.isArray(row.skills) || row.skills.length ||
            !Array.isArray(row.mcp_servers) || row.mcp_servers.length !== 1 ||
            row.mcp_servers[0]?.name !== SERVER || row.mcp_servers[0]?.status !== 'connected') fail('PROCESSING_CLIENT_RESTRICTION_UNVERIFIED');
        string(row.model, 256); string(row.claude_code_version, 128);
        initialized = row;
        emit({ type: 'initialized', client: 'claude', sessionId, model: row.model, clientVersion: row.claude_code_version });
      } else if (row.type === 'user' && row.isReplay === true) {
        if (replayed || row.session_id !== sessionId || row.uuid !== inputId || row.parent_tool_use_id !== null ||
            row.message?.role !== 'user' || row.message.content !== prompt) fail('PROCESSING_CLIENT_INPUT_UNVERIFIED');
        replayed = true;
        emit({ type: 'input-acknowledged', client: 'claude', sessionId, inputId });
      } else if (row.type === 'assistant') {
        if (!initialized || result || row.session_id !== sessionId || !Array.isArray(row.message?.content) || row.message.content.length > 256) fail('PROCESSING_CLIENT_PROTOCOL');
        for (const block of row.message.content) if (block?.type === 'tool_use' && !allowedSet.has(block.name)) fail('PROCESSING_CLIENT_TOOL_REFUSED');
      } else if (row.type === 'result') {
        if (!initialized || result || row.session_id !== sessionId) fail('PROCESSING_CLIENT_PROTOCOL');
        if (!Array.isArray(row.permission_denials) || row.permission_denials.length) fail('PROCESSING_CLIENT_TURN_FAILED');
        // This native terminal binds an API failure to the exact acknowledged
        // input. An error string, unknown result shape or process exit alone does
        // not establish completion and must not release the reusable chat.
        terminalFailed = row.is_error === true && row.subtype === 'success' && row.terminal_reason === 'api_error' &&
          Number.isInteger(row.api_error_status) && row.api_error_status >= 400 && row.api_error_status <= 599 &&
          row.user_message_uuid === inputId && Array.isArray(row.user_message_uuids) &&
          row.user_message_uuids.length === 1 && row.user_message_uuids[0] === inputId;
        if (!terminalFailed && (row.is_error !== false || row.subtype !== 'success')) fail('PROCESSING_CLIENT_TURN_FAILED');
        string(row.result, MAX_FRAME_BYTES, { empty: true });
        result = row;
      }
    };
    const bytes = chunk => {
      if (failure || settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { stop('PROCESSING_CLIENT_OUTPUT_LIMIT'); return; }
      buffered = Buffer.concat([buffered, chunk]);
      try {
        let newline;
        while ((newline = buffered.indexOf(10)) >= 0) {
          if (newline > MAX_FRAME_BYTES) fail('PROCESSING_CLIENT_OUTPUT_LIMIT');
          const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
          if (line.length) record(JSON.parse(decoder.decode(line)));
        }
        if (buffered.length > MAX_FRAME_BYTES) fail('PROCESSING_CLIENT_OUTPUT_LIMIT');
      } catch (error) {
        stop(typeof error.code === 'string' && error.code.startsWith('PROCESSING_CLIENT_') ? error.code : 'PROCESSING_CLIENT_PROTOCOL');
      }
    };
    try {
      child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
      timer = setTimeout(() => stop('PROCESSING_CLIENT_TIMEOUT'), timeoutMs);
      child.on('error', () => stop('PROCESSING_CLIENT_START_FAILED'));
      child.stdout.on('data', bytes);
      child.stderr.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) stop('PROCESSING_CLIENT_OUTPUT_LIMIT');
      });
      child.stdin.on('error', () => stop('PROCESSING_CLIENT_INPUT_FAILED'));
      child.on('close', (code, nativeSignal) => {
        if (failure) { finish(failure); return; }
        if ((code !== 0 && !(terminalFailed && code === 1)) || nativeSignal || buffered.length || !initialized || !result || !replayed) {
          finish(nativeError('PROCESSING_CLIENT_OUTCOME_UNKNOWN', dispatched)); return;
        }
        finish();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      // Node emits spawn only after successful OS process creation; asynchronous
      // ENOENT/EACCES never reach it. No input is submitted before this event.
      child.once('spawn', () => {
        if (failure || settled) return;
        if (signal?.aborted) { abort(); return; }
        // Native print can await input before init. Once submission begins a
        // pipe/write/exit failure cannot prove that the client did not receive it.
        dispatched = true;
        try { child.stdin.end(`${JSON.stringify({ type: 'user', session_id: sessionId, uuid: inputId,
          parent_tool_use_id: null, message: { role: 'user', content: prompt } })}\n`); }
        catch { stop('PROCESSING_CLIENT_INPUT_FAILED'); }
      });
    } catch {
      if (child) stop('PROCESSING_CLIENT_START_FAILED');
      else finish(nativeError('PROCESSING_CLIENT_START_FAILED', false));
    }
  });
}
