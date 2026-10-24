import { spawn as nativeSpawn } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TextDecoder } from 'node:util';
import { CuefluentError, fail } from '../../core/errors.mjs';
import { pinDirectory, assertDirectory } from '../../storage/paths.mjs';
import { readPathStat } from '../../storage/stat.mjs';

export { executablePath } from '../../client/executable.mjs';

export const requireClient = (condition, code = 'PROCESSING_ISOLATION_UNSUPPORTED') => { if (!condition) fail(code, 'The native processing session could not be safely established.'); };
export const boundedText = (value, bytes) => typeof value === 'string' && Buffer.byteLength(value) <= bytes && !/\u0000|\p{Cs}/u.test(value);
export const sameNames = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && [...actual].sort().every((name, index) => name === [...expected].sort()[index]);

export async function privateCwd(directory) {
  requireClient(typeof directory === 'string' && path.isAbsolute(directory), 'PROCESSING_ARGUMENT');
  const before = await readPathStat(directory), canonical = await realpath(directory), current = await readPathStat(canonical);
  requireClient(before.isDirectory() && !before.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino);
  const pin = await pinDirectory(canonical, { private: true });
  const home = await realpath(os.homedir()); let depth = 0;
  for (let parent = path.dirname(canonical); ; parent = path.dirname(parent)) {
    requireClient(++depth <= 128);
    // The user profile is intentionally kept for the clients' existing login.
    // Project configuration is never an input to a drafting session.
    for (const name of parent === home ? ['.git'] : ['.git', '.codex', '.claude', '.mcp.json']) {
      try { await lstat(path.join(parent, name)); requireClient(false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (path.dirname(parent) === parent) break;
  }
  requireClient((await readdir(canonical)).length === 0);
  return { path: canonical, async check() { await assertDirectory(pin); requireClient((await readdir(canonical)).length === 0); } };
}

export function descriptor(mcp) {
  requireClient(mcp && /^[a-z][a-z0-9_]{0,31}$/.test(mcp.name) && boundedText(mcp.command, 4096) && path.isAbsolute(mcp.command), 'PROCESSING_ARGUMENT');
  requireClient(Array.isArray(mcp.args) && mcp.args.length <= 32 && mcp.args.every(value => boundedText(value, 4096)), 'PROCESSING_ARGUMENT');
  requireClient(Array.isArray(mcp.tools) && mcp.tools.length > 0 && mcp.tools.length <= 16 && mcp.tools.every(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name)) && new Set(mcp.tools).size === mcp.tools.length, 'PROCESSING_ARGUMENT');
  const env = mcp.env ?? {};
  requireClient(env && typeof env === 'object' && !Array.isArray(env) && Object.keys(env).length <= 16, 'PROCESSING_ARGUMENT');
  for (const [name, value] of Object.entries(env)) requireClient(/^CUEFLUENT_[A-Z0-9_]{1,100}$/.test(name) && boundedText(value, 8192), 'PROCESSING_ARGUMENT');
  return { name: mcp.name, command: mcp.command, args: [...mcp.args], tools: [...mcp.tools], env: { ...env } };
}

/** Bounded newline transport. Neither stderr, prompts nor server errors are
 * copied into diagnostics. Deliberately has no elapsed-time termination. */
export class JsonProcess {
  constructor(command, args, { cwd, env, signal, spawn = nativeSpawn } = {}) {
    requireClient(!signal?.aborted, 'PROCESSING_ABORTED');
    this.child = spawn(command, args, { cwd, ...(env ? { env } : {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pending = new Map(); this.queue = []; this.queueBytes = 0; this.waiters = []; this.sequence = 0; this.failure = null; this.buffer = ''; this.closed = false;
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    this.child.stderr.on('data', () => {});
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    this.child.stdout.on('data', chunk => {
      if (this.failure) return;
      try { this.buffer += decoder.decode(chunk, { stream: true }); }
      catch { return this.reject('PROCESSING_PROTOCOL'); }
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) return this.reject('PROCESSING_PROTOCOL_LIMIT');
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let value; try { value = JSON.parse(line); } catch { return this.reject('PROCESSING_PROTOCOL'); }
        try { if (this.onMessage?.(value) === true) continue; } catch { return this.reject('PROCESSING_PROTOCOL'); }
        const responseId = value.type === 'control_response' ? value.response?.request_id : value.id;
        const pending = this.pending.get(responseId);
        if (pending) { this.pending.delete(responseId); pending.resolve(value); continue; }
        if (this.waiters.length) this.waiters.shift().resolve(value);
        else { this.queue.push({ value, bytes: Buffer.byteLength(line) }); this.queueBytes += Buffer.byteLength(line); if (this.queue.length > 256 || this.queueBytes > 16 * 1024 * 1024) return this.reject('PROCESSING_PROTOCOL_LIMIT'); }
      }
    });
    this.child.on('error', () => this.reject('PROCESSING_CLIENT_FAILED'));
    this.child.stdin.on('error', () => this.reject('PROCESSING_CLIENT_FAILED'));
    this.child.on('close', (code, signalName) => {
      this.closed = true;
      if (!this.failure) {
        try { this.buffer += decoder.decode(); }
        catch { this.reject('PROCESSING_PROTOCOL', false); }
        if (this.buffer.length) this.reject('PROCESSING_PROTOCOL', false);
      }
      this.resolveExit({ code, signal: signalName });
      if (!this.failure) this.reject('PROCESSING_CLIENT_EXITED', false);
    });
    this.signal = signal; this.abortListener = () => this.reject('PROCESSING_ABORTED'); signal?.addEventListener('abort', this.abortListener, { once: true });
  }
  reject(code, terminate = true) {
    if (this.failure) return;
    this.failure = new CuefluentError(code, 'The native processing session did not complete safely.');
    for (const pending of [...this.pending.values(), ...this.waiters]) pending.reject(this.failure);
    this.pending.clear(); this.waiters = [];
    if (terminate && !this.closed) this.child.kill();
  }
  send(value) { if (this.failure) throw this.failure; this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(method, params, claude = false) {
    if (this.failure) return Promise.reject(this.failure);
    const id = `cuefluent-${++this.sequence}`;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send(claude ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } } : { id, method, params });
    return result.then(response => {
      if (claude) { requireClient(response.response?.subtype === 'success'); return response.response.response; }
      requireClient(!response.error); return response.result;
    });
  }
  next() { if (this.queue.length) { const item = this.queue.shift(); this.queueBytes -= item.bytes; return Promise.resolve(item.value); } if (this.failure) return Promise.reject(this.failure); return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); }
  async finish() {
    this.signal?.removeEventListener('abort', this.abortListener);
    if (!this.closed) this.child.stdin.end();
    const exit = await this.exit;
    // Clean closure wakes unfinished readers, but never hides a protocol or
    // policy failure that occurred after the caller saw a terminal message.
    if (this.failure && this.failure.code !== 'PROCESSING_CLIENT_EXITED') throw this.failure;
    return exit;
  }
  async dispose() { this.signal?.removeEventListener('abort', this.abortListener); if (!this.closed) { this.child.stdin.destroy(); this.child.kill(); } await this.exit; }
}
