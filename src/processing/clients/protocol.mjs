import { spawn as nativeSpawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readdir, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CuefluentError, fail } from '../../core/errors.mjs';
import { pinDirectory, assertDirectory } from '../../storage/paths.mjs';
import { readPathStat } from '../../storage/stat.mjs';

export const requireClient = (condition, code = 'PROCESSING_ISOLATION_UNSUPPORTED') => { if (!condition) fail(code, 'The native processing session could not be safely established.'); };
export const boundedText = (value, bytes) => typeof value === 'string' && Buffer.byteLength(value) <= bytes && !/\u0000|\p{Cs}/u.test(value);
export const sameNames = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && [...actual].sort().every((name, index) => name === [...expected].sort()[index]);

async function executableFile(candidate) {
  try {
    await access(candidate, constants.X_OK); const canonical = await realpath(candidate);
    if ((await lstat(canonical)).isFile()) return canonical;
  } catch { /* No executable at this exact candidate. */ }
  return null;
}

async function windowsExecutable(command) {
  const absolute = path.isAbsolute(command), name = path.parse(command).name.toLowerCase();
  const directories = absolute ? [path.dirname(command)] : String(process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory));
  if (!absolute && path.basename(command) !== command) return null;
  for (const directory of directories) {
    const candidate = path.join(directory, path.extname(command).toLowerCase() === '.exe' ? path.basename(command) : `${path.basename(command)}.exe`);
    const found = await executableFile(candidate); if (found) return found;
  }
  if (!['codex', 'claude'].includes(name) || !['x64', 'arm64'].includes(process.arch)) return null;
  // npm's .cmd/.ps1/extensionless launchers are shell text, not executables.
  // Resolve only the known adjacent package's native binary; never evaluate a
  // wrapper, read client config, or discover any authentication file.
  const architecture = process.arch, triple = architecture === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
  for (const directory of directories) {
    let wrapper = false;
    for (const suffix of ['', '.cmd', '.ps1']) if (await executableFile(path.join(directory, name + suffix))) { wrapper = true; break; }
    if (!wrapper) continue;
    const packages = name === 'codex' ? [
      ['@openai/codex', '@openai/codex'], [`@openai/codex-win32-${architecture}`, '@openai/codex'],
      [`@openai/codex/node_modules/@openai/codex-win32-${architecture}`, '@openai/codex'],
    ] : [['@anthropic-ai/claude-code', '@anthropic-ai/claude-code'], [`@anthropic-ai/claude-code-win32-${architecture}`, `@anthropic-ai/claude-code-win32-${architecture}`]];
    for (const [relative, identity] of packages) {
      const root = path.join(directory, 'node_modules', ...relative.split('/')), manifest = path.join(root, 'package.json');
      try {
        const stat = await lstat(manifest); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) continue;
        const bytes = await readFile(manifest); if (bytes.length > 64 * 1024) continue;
        const metadata = JSON.parse(bytes); if (metadata.name !== identity || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.version)) continue;
        const candidates = name === 'codex' ? [`vendor/${triple}/bin/codex.exe`, `vendor/${triple}/codex/codex.exe`] : ['bin/claude.exe', 'claude.exe'];
        for (const relative of candidates) { const found = await executableFile(path.join(root, ...relative.split('/'))); if (found) return found; }
      } catch { /* Missing or unsupported public program package. */ }
    }
  }
  return null;
}

export async function executablePath(command) {
  requireClient(boundedText(command, 4096) && command.length, 'PROCESSING_ARGUMENT');
  if (process.platform === 'win32') { const found = await windowsExecutable(command); if (found) return found; fail('PROCESSING_CLIENT_MISSING', 'A supported native processing executable is unavailable.'); }
  const candidates = path.isAbsolute(command) ? [command] : String(process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    const found = await executableFile(candidate); if (found) return found;
  }
  fail('PROCESSING_CLIENT_MISSING', 'The selected native processing client is unavailable.');
}

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
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
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
    this.child.on('close', (code, signalName) => { this.closed = true; this.resolveExit({ code, signal: signalName }); if (!this.failure) this.reject('PROCESSING_CLIENT_EXITED', false); });
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
  async finish() { this.signal?.removeEventListener('abort', this.abortListener); if (!this.closed) this.child.stdin.end(); return this.exit; }
  async dispose() { this.signal?.removeEventListener('abort', this.abortListener); if (!this.closed) { this.child.stdin.destroy(); this.child.kill(); } await this.exit; }
}
