import { spawn as nativeSpawn } from 'node:child_process';
import { executablePath } from './executable.mjs';
import { createHash } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { assertAbsolute } from '../storage/paths.mjs';
import { bindCodexCommand } from './commands.mjs';
import { openTranscript } from './source.mjs';
import { inspectNativeRow, metaValue } from '../transcript/source.mjs';

export const CODEX_NATIVE_LIMITS = Object.freeze({ responseBytes: 2 * 1024 * 1024, itemPages: 4, pageItems: 8, timeoutMs: 10000, knownSources: 32 });
const FEATURES = ['hooks', 'plugins', 'apps'];
export const CODEX_NATIVE_ARGUMENTS = Object.freeze(['app-server', ...FEATURES.flatMap(name => ['--disable', name]), '--config', 'project_doc_max_bytes=0', '--stdio']);
const READS = new Set(['thread/read', 'thread/items/list', 'thread/turns/list']);
const pending = reason => Object.freeze({ status: 'pending', reason });
const invalid = message => fail('NATIVE_CONTEXT_INVALID', message);
const same = (a, b) => a && b && a.device === b.device && a.inode === b.inode;

function own(input, key) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Native context must be an inert object.');
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) invalid('Native context cannot contain accessors.');
  return descriptor?.value;
}

function token(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) invalid('The native identity is missing or unsupported.');
  return value;
}

function absolute(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 32768) invalid('The native path is missing or unsupported.');
  return assertAbsolute(value);
}

function identity(input) {
  const device = own(input, 'device'), inode = own(input, 'inode');
  if (typeof device !== 'string' || typeof inode !== 'string' || !/^(?:0|[1-9][0-9]{0,39})$/.test(device) || !/^(?:0|[1-9][0-9]{0,39})$/.test(inode)) invalid('Previous native sources require exact physical identities.');
  return Object.freeze({ device, inode });
}

function retained(input) {
  if (input === null || input === undefined) return null;
  const id = own(input, 'identity');
  if (id === null) return null;
  return Object.freeze({ path: absolute(own(input, 'path')), identity: identity(id) });
}

function locator(meta) {
  const native = own(meta, 'x-codex-turn-metadata'), sessionId = token(own(native, 'session_id'));
  const threadId = token(own(native, 'thread_id')), turnId = token(own(native, 'turn_id'));
  if (sessionId !== threadId) fail('NATIVE_CONTEXT_UNSUPPORTED', 'This native session/thread identity shape is not verified.');
  if ((own(meta, 'threadId') !== undefined && own(meta, 'threadId') !== threadId) ||
      (own(meta, 'sessionId') !== undefined && own(meta, 'sessionId') !== sessionId)) fail('NATIVE_COMMAND_MISMATCH', 'Native transport identities disagree.');
  return Object.freeze({ sessionId, threadId, turnId, meta: Object.freeze({ 'x-codex-turn-metadata': Object.freeze({ session_id: sessionId, thread_id: threadId, turn_id: turnId }) }) });
}

/** No thread creation/loading, model requests, account requests, config reads, or
 * arbitrary RPC escape hatch. A fresh source-free app-server owns this stdio pipe.
 * Its normal config may load internally; invocation flags disable capabilities.
 */
function readerSession({ command, spawn, timeoutMs, responseBytes }) {
  let child, initialized, failure, closed = false, nextId = 0, bytes = Buffer.alloc(0), exited;
  const waiting = new Map();
  function stop(code) {
    const error = failure ?? new Error('The bounded native metadata reader could not complete.'); error.code ??= code; failure = error;
    for (const value of waiting.values()) { clearTimeout(value.timer); value.reject(error); }
    waiting.clear(); child?.kill(); return error;
  }
  function send(value) {
    if (!child?.stdin?.writable || closed) throw stop('NATIVE_READER_CLOSED');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  function rpc(method, params) {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop('NATIVE_READER_TIMEOUT'), timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { clearTimeout(timer); waiting.delete(id); reject(error); }
    });
  }
  function start() {
    if (closed) fail('NATIVE_READER_CLOSED', 'The native metadata reader is closed.');
    child = spawn(command, [...CODEX_NATIVE_ARGUMENTS], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    exited = new Promise(resolve => child.once('close', resolve));
    child.stderr.on('data', () => {}); // Never retain native diagnostics/content.
    child.stdin.on('error', () => stop('NATIVE_READER_FAILED'));
    child.on('error', () => stop('NATIVE_READER_FAILED'));
    child.on('exit', () => { if (!closed) stop('NATIVE_READER_EXITED'); });
    child.stdout.on('data', chunk => {
      if (bytes.length + chunk.length > responseBytes) { stop('NATIVE_RESPONSE_LIMIT'); return; }
      bytes = Buffer.concat([bytes, chunk]);
      for (;;) {
        const end = bytes.indexOf(10); if (end < 0) break;
        const line = bytes.subarray(0, end); bytes = bytes.subarray(end + 1);
        let message;
        try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { stop('NATIVE_RESPONSE_INVALID'); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { stop('NATIVE_RESPONSE_INVALID'); return; }
        if (message.method) {
          if (Object.hasOwn(message, 'id')) { stop('NATIVE_UNEXPECTED_REQUEST'); return; }
          continue; // Unsubscribed notifications grant no source authority.
        }
        const request = waiting.get(message.id);
        if (!request) { stop('NATIVE_RESPONSE_INVALID'); return; }
        waiting.delete(message.id); clearTimeout(request.timer);
        if (message.error) {
          const error = new Error('The native metadata request is unavailable.'); error.code = 'NATIVE_RPC_UNAVAILABLE';
          error.rpcCode = Number.isInteger(message.error.code) ? message.error.code : null; request.reject(error);
        } else if (!Object.hasOwn(message, 'result')) { request.reject(stop('NATIVE_RESPONSE_INVALID')); }
        else request.resolve(message.result);
      }
    });
    initialized = rpc('initialize', { clientInfo: { name: 'cuefluent_notes_source', version: '2.0.0' }, capabilities: { experimentalApi: true } })
      .then(() => send({ method: 'initialized', params: {} }))
      .catch(error => { throw stop(error.code ?? 'NATIVE_READER_FAILED'); });
    return initialized;
  }
  return {
    get failed() { return Boolean(failure); },
    async request(method, params) {
      if (!READS.has(method)) fail('NATIVE_METHOD_FORBIDDEN', 'Only bounded stored-thread reads are supported.');
      if (!initialized) await start(); else await initialized;
      return rpc(method, params);
    },
    async close() {
      if (closed) return; closed = true;
      if (!child) return;
      stop('NATIVE_READER_CLOSED'); child.stdin.end();
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000); })]);
      clearTimeout(timer); bytes = Buffer.alloc(0);
    },
  };
}

// A failed metadata process is retired before the next external request starts
// a fresh one. No request is replayed automatically and concurrent callers share
// one startup/retirement promise; late callbacks remain in their old session.
function cliReader(options) {
  let session = null, changing = null, closed = false;
  async function current() {
    if (closed) fail('NATIVE_READER_CLOSED', 'The native metadata reader is closed.');
    if (!changing && (!session || session.failed)) {
      changing = (async () => {
        await session?.close();
        let command;
        try { command = await executablePath(options.command); }
        catch { fail('NATIVE_READER_MISSING', 'A supported native metadata executable is unavailable.'); }
        if (closed) fail('NATIVE_READER_CLOSED', 'The native metadata reader is closed.');
        session = readerSession({ ...options, command });
      })();
    }
    if (changing) {
      const pending = changing;
      try { await pending; } finally { if (changing === pending) changing = null; }
    }
    return session;
  }
  return {
    async request(method, params) { return (await current()).request(method, params); },
    async close() { closed = true; try { await changing; } catch { /* Failed startup has no live reader. */ } await session?.close(); },
  };
}

/** Native authority only. `request` and knownSources are trusted host adapters,
 * never tool arguments. Known physical sources are bounded retained capabilities,
 * not a transcript-discovery index or completed-command history.
 */
export function createCodexNativeAdapter({ request, command = 'codex', spawn = nativeSpawn, knownSources = [],
  timeoutMs = CODEX_NATIVE_LIMITS.timeoutMs, responseBytes = CODEX_NATIVE_LIMITS.responseBytes,
  itemPages = CODEX_NATIVE_LIMITS.itemPages, pageItems = CODEX_NATIVE_LIMITS.pageItems } = {}) {
  for (const [value, max] of [[timeoutMs, CODEX_NATIVE_LIMITS.timeoutMs], [responseBytes, CODEX_NATIVE_LIMITS.responseBytes], [itemPages, CODEX_NATIVE_LIMITS.itemPages], [pageItems, CODEX_NATIVE_LIMITS.pageItems]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid('Native read bounds may only reduce the supported profile.');
  }
  if (typeof command !== 'string' || !command || command.length > 32768 || /[\u0000-\u001f\u007f]/.test(command) || typeof spawn !== 'function' ||
      (request !== undefined && typeof request !== 'function') || !Array.isArray(knownSources) || knownSources.length > CODEX_NATIVE_LIMITS.knownSources) invalid('Invalid trusted native reader configuration.');
  const known = knownSources.map(input => Object.freeze({ sessionId: token(own(input, 'sessionId')), ...retained(input) }));
  if (known.some(source => !source.identity)) invalid('Known historical paths require their exact retained inode.');
  const reader = request ? null : cliReader({ command, spawn, timeoutMs, responseBytes });
  let closed = false, previousActive = null;
  async function query(method, params) {
    if (closed) fail('NATIVE_READER_CLOSED', 'The native metadata adapter is closed.');
    if (!READS.has(method)) fail('NATIVE_METHOD_FORBIDDEN', 'Only stored-thread reads are supported.');
    let result;
    if (request) {
      let timer;
      try { result = await Promise.race([request(method, Object.freeze(params)), new Promise((_, reject) => {
        timer = setTimeout(() => { const error = new Error('Native metadata read timed out.'); error.code = 'NATIVE_READER_TIMEOUT'; reject(error); }, timeoutMs);
      })]); } finally { clearTimeout(timer); }
    } else result = await reader.request(method, params);
    if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result)) > responseBytes) fail('NATIVE_RESPONSE_INVALID', 'The native read response is not a supported bounded object.');
    return result;
  }
  async function thread(sessionId) {
    const response = await query('thread/read', { threadId: token(sessionId), includeTurns: false }), value = own(response, 'thread');
    if (token(own(value, 'id')) !== sessionId) fail('NATIVE_SOURCE_IDENTITY_MISMATCH', 'The native thread read returned another identity.');
    const turns = own(value, 'turns');
    if (turns !== undefined && (!Array.isArray(turns) || turns.length)) fail('NATIVE_RESPONSE_INVALID', 'A metadata read unexpectedly returned whole thread history.');
    const parent = own(value, 'parentThreadId'); if (parent !== null && parent !== undefined) token(parent);
    return Object.freeze({ sessionId, path: absolute(own(value, 'path'), true), cwd: absolute(own(value, 'cwd')), subagent: parent !== null && parent !== undefined });
  }
  async function latestTurn(threadId) {
    let response;
    try { response = await query('thread/turns/list', { threadId, sortDirection: 'desc', limit: 1, itemsView: 'notLoaded' }); }
    catch (error) { if (error.code === 'NATIVE_RPC_UNAVAILABLE') return null; throw error; }
    const data = own(response, 'data');
    if (!Array.isArray(data) || data.length > 1) fail('NATIVE_RESPONSE_INVALID', 'The native current-turn response exceeds its exact bound.');
    if (!data.length) return null;
    const current = data[0], actual = token(own(current, 'id')), items = own(current, 'items');
    if (own(current, 'itemsView') !== 'notLoaded' || !Array.isArray(items) || items.length ||
        !['inProgress', 'completed', 'interrupted', 'failed'].includes(own(current, 'status'))) fail('NATIVE_RESPONSE_INVALID', 'The native current turn must contain only unloaded turn metadata.');
    return Object.freeze({ id: actual, status: own(current, 'status') });
  }
  async function currentTurn(threadId, turnId) {
    const current = await latestTurn(threadId);
    return !current ? pending('NATIVE_COMMAND_CURRENT_PENDING') : current.id === turnId ? null : pending('NATIVE_COMMAND_NOT_CURRENT');
  }
  return Object.freeze({
    async bindCommand(meta, { name, skillPath } = {}) {
      const at = locator(meta), selected = await thread(at.threadId);
      if (selected.subagent) return pending('NATIVE_SUBAGENT_UNSUPPORTED');
      const initialCurrent = await currentTurn(at.threadId, at.turnId); if (initialCurrent) return initialCurrent;
      let cursor = null, match = null; const cursors = new Set(), ids = new Set();
      for (let page = 0; page < itemPages; page++) {
        let response;
        try { response = await query('thread/items/list', { threadId: at.threadId, turnId: at.turnId, sortDirection: 'asc', limit: pageItems, cursor }); }
        catch (error) { if (error.code === 'NATIVE_RPC_UNAVAILABLE') return pending('NATIVE_COMMAND_ITEMS_PENDING'); throw error; }
        const data = own(response, 'data');
        if (!Array.isArray(data) || data.length > pageItems) fail('NATIVE_RESPONSE_INVALID', 'The exact native turn returned an invalid item page.');
        for (const entry of data) {
          if (own(entry, 'turnId') !== at.turnId) fail('NATIVE_COMMAND_MISMATCH', 'The native item page contains another turn.');
          const item = own(entry, 'item'), id = token(own(item, 'id'));
          if (ids.has(id)) fail('NATIVE_COMMAND_MISMATCH', 'The native item pagination repeated an identity.'); ids.add(id);
          if (own(item, 'type') !== 'userMessage') continue;
          if (match) return pending('NATIVE_COMMAND_AMBIGUOUS');
          match = { type: 'event_msg', payload: { type: 'item_completed', thread_id: at.threadId, turn_id: at.turnId,
            item: { type: 'UserMessage', id, content: own(item, 'content') } } };
        }
        const next = own(response, 'nextCursor');
        if (next === null || next === undefined) {
          if (!match) return pending('NATIVE_COMMAND_ITEMS_PENDING');
          const current = await thread(at.threadId);
          if (current.path !== selected.path || current.cwd !== selected.cwd || current.subagent !== selected.subagent) return pending('NATIVE_COMMAND_SOURCE_CHANGED');
          const finalCurrent = await currentTurn(at.threadId, at.turnId); if (finalCurrent) return finalCurrent;
          return Object.freeze({ status: 'ready', binding: bindCodexCommand(at.meta, match, { name, skillPath, cwd: selected.cwd, sourcePath: selected.path }) });
        }
        if (typeof next !== 'string' || !next || next.length > 8192 || cursors.has(next)) fail('NATIVE_RESPONSE_INVALID', 'The native item cursor is unsupported or repeated.');
        cursors.add(next); cursor = next;
      }
      return pending('NATIVE_COMMAND_PAGE_LIMIT');
    },
    async resolveNativeSource(input) {
      if (own(input, 'client') !== 'codex') return null;
      const sessionId = token(own(input, 'sessionId')), before = own(input, 'before'), exclude = own(input, 'excludeIdentity');
      if (before !== null && before !== undefined && (!Number.isSafeInteger(own(before, 'ordinalExclusive')) || before.ordinalExclusive < 1 || !Number.isSafeInteger(own(before, 'byteOffset')) || before.byteOffset < 1)) invalid('Historical source boundaries require exact native byte and ordinal cuts.');
      const excluded = exclude === null || exclude === undefined ? null : identity(exclude);
      let active;
      try { active = await thread(sessionId); } catch (error) { if (error.code === 'NATIVE_RPC_UNAVAILABLE') return null; throw error; }
      if (active.subagent) return null;
      const latest = !before ? await latestTurn(sessionId) : null;
      const completion = latest && ['failed', 'interrupted'].includes(latest.status) ? Object.freeze({ promptId: latest.id, kind: latest.status, finalTextHash: null }) : null;
      if (before === null || before === undefined) previousActive = { sessionId, source: retained(own(input, 'previous')) };
      const candidates = active.path ? [{ path: active.path, identity: null }] : [];
      let retainedMatch = false;
      if (before) {
        const retainedSources = own(input, 'historySources') ?? [];
        if (!Array.isArray(retainedSources) || retainedSources.length > 32) invalid('Historical native sources exceed their bounded profile.');
        for (const entry of retainedSources) {
          if (own(entry, 'sessionId') === sessionId && own(own(entry, 'before'), 'ordinalExclusive') === before.ordinalExclusive && own(entry.before, 'byteOffset') === before.byteOffset) {
            if (retainedMatch) invalid('A historical native cutoff has ambiguous retained capabilities.');
            retainedMatch = true; candidates.length = 0;
            const hash = own(entry, 'hash'); if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) invalid('A retained native prefix needs its exact inspected hash.');
            candidates.push({ ...retained(own(entry, 'source')), prefixHash: hash });
          }
        }
      }
      if (before && !retainedMatch && previousActive?.sessionId === sessionId && previousActive.source) candidates.push(previousActive.source);
      if (before && !retainedMatch) candidates.push(...known.filter(item => item.sessionId === sessionId));
      const seen = new Set();
      for (const candidate of candidates) {
        const key = JSON.stringify([candidate.path, candidate.identity]); if (seen.has(key)) continue; seen.add(key);
        const source = await openTranscript(candidate.path, { identity: candidate.identity });
        if (!source) continue;
        let keep = false;
        try {
          if (same(source.identity, excluded) || !source.size) continue;
          const header = await inspectNativeRow(source, 0);
          if (header.pending) continue;
          if (metaValue(header, 'type') !== 'session_meta' || metaValue(header, 'payload', 'id') !== sessionId) fail('NATIVE_SOURCE_IDENTITY_MISMATCH', 'The native physical source header belongs to another thread.');
          if (before && (!Number.isSafeInteger(metaValue(header, 'ordinal')) || metaValue(header, 'ordinal') >= before.ordinalExclusive || before.byteOffset > source.size || (await source.read(before.byteOffset - 1, 1))[0] !== 10)) continue;
          if (candidate.prefixHash) {
            const digest = createHash('sha256');
            for (let offset = 0; offset < before.byteOffset;) { const bytes = await source.read(offset, Math.min(65536, before.byteOffset - offset)); if (!bytes.length) fail('HISTORY_SOURCE_CHANGED', 'Historical prefix reads must make progress.'); digest.update(bytes); offset += bytes.length; }
            if (digest.digest('hex') !== candidate.prefixHash) fail('HISTORY_SOURCE_CHANGED', 'The retained native historical prefix changed.');
          }
          await source.verify(); keep = true; return Object.freeze({ path: candidate.path, source, ...(completion ? { completion } : {}) });
        } finally { if (!keep) await source.close(); }
      }
      return null;
    },
    async close() { if (!closed) { closed = true; previousActive = null; await reader?.close(); } },
  });
}
