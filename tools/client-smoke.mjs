// Real native CLI checks only. No registration, trust, login or model requests.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as nativeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { packageIdentity, packageVersion } from '../src/core/version.mjs';
import { executablePath } from '../src/client/executable.mjs';
import { createPrivateDirectory, assertDirectory } from '../src/storage/paths.mjs';
import { codexConfiguration } from '../src/processing/clients/codex.mjs';
import { runClaude } from '../src/processing/clients/claude.mjs';
import { JsonProcess } from '../src/processing/clients/protocol.mjs';

export const CLIENT_VERSIONS = Object.freeze({ claude: '2.1.309', codex: '0.163.0' });
// Exact official npm native archives. No npm lifecycle runs.
const INTEGRITIES = {
  'darwin-x64': {
    claude: 'K+9PSzQQYYooMpohqGInTLbNDXQvbroZZJcmrpyAKonXjzkl4jAQJHe6F6wHxFLKoALntoP6/5WIuCIetoR26w==',
    codex: 'Ioj7h+B1ME9ZU1PH1ATfvFV5DiototEpFFaSSbg3kfDifB9djhl5fcJ++g5mpcL/+uVbcnReei+RiSXEx8o+kw==',
  },
  'darwin-arm64': {
    claude: '7ZVUH/WyxWpFfkV90tJBUSnFTQo8wwRxHNOLNj+q8eYp5DNoCU8KOVC3OiNDmo832BrfQImH0XmpWjGqKPulDg==',
    codex: 'i7Dzk2a5aGmuGM9aNZgaUVTojZ/4bc5lRfosz++Y7X2BGhDkz+cySgbD+NYS1pOxfm0VEbLi9PZ3pAulI4kchw==',
  },
  'win32-x64': {
    claude: 'b4Ju2gf1VliNsF9dONk/G1xZEW3Zg+G4TgpOS5oXPHSsMIciczcF267//7RvtjEXghflc3Lwrqe+Q4iNMf2ukQ==',
    codex: 'QQGQ/q9dCJ5C5jqhgFrwycpWG3szIyFNThMiKl6hYtu6N/eM3Qd7StesgnCFAfzVED8IkE3N3oH71szzcludqw==',
  },
  'win32-arm64': {
    claude: 'NV+lqbyZCJmc3rWE+VSYW8NcPzxnL6dh8BHu+JAvXKHLhjUbEv2YPq35vTw7Tl6LDJoGujrI8esVmfeQhkqSsw==',
    codex: 'QnLn3gR2dExcdTThE/HAo5BrUq0/C8zDGQ0UZL3hNzfqt9ZklT6jGTyt8JhDyNZX4uSB4HhcJtbcOWucZGC0VQ==',
  },
};
const error = code => Object.assign(new Error(`Real client smoke failed (${code}).`), { code });
const requireSmoke = (condition, code) => { if (!condition) throw error(code); };
const digest = bytes => createHash('sha512').update(bytes).digest('base64');

export function nativePackage(client, platform = process.platform, arch = process.arch) {
  const integrity = INTEGRITIES[`${platform}-${arch}`]?.[client];
  requireSmoke(Boolean(integrity), 'CLIENT_PLATFORM_UNSUPPORTED');
  const version = CLIENT_VERSIONS[client], suffix = platform === 'win32' ? '.exe' : '';
  const name = client === 'claude' ? `@anthropic-ai/claude-code-${platform}-${arch}` : '@openai/codex';
  const packageVersion = client === 'claude' ? version : `${version}-${platform}-${arch}`;
  const base = name.slice(name.indexOf('/') + 1);
  const triple = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc'}`;
  const binaries = client === 'claude' ? [`package/claude${suffix}`, `package/bin/claude${suffix}`] : [`package/vendor/${triple}/codex/codex${suffix}`, `package/vendor/${triple}/bin/codex${suffix}`];
  return { client, name, version: packageVersion, clientVersion: version, integrity, binaries,
    url: `https://registry.npmjs.org/${name}/-/${base}-${packageVersion}.tgz`, executable: `${client}${suffix}` };
}

/** Only system program locations enter PATH; no user tool/config/auth overrides. */
export function smokeEnvironment(root, inherited = process.env, platform = process.platform) {
  const home = path.join(root, 'home with spaces'), temporary = path.join(root, 'tmp');
  const env = {};
  for (const [key, value] of Object.entries(inherited)) if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS'].includes(key.toUpperCase())) env[key.toUpperCase()] = value;
  const systemRoot = env.SYSTEMROOT;
  requireSmoke(platform !== 'win32' || typeof systemRoot === 'string' && path.win32.isAbsolute(systemRoot), 'CLIENT_SYSTEM_ROOT_MISSING');
  const systemPath = platform === 'win32' ? [path.win32.join(systemRoot, 'System32'), systemRoot] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const windowsRoot = path.win32.parse(home).root;
  requireSmoke(platform !== 'win32' || /^[A-Za-z]:\\$/.test(windowsRoot), 'CLIENT_PROFILE_INVALID');
  // Node/Windows fills omitted home and identity keys from the caller. Pin the
  // home pair explicitly and use empty identity keys to prevent that fallback.
  const windowsProfile = platform === 'win32' ? { HOMEDRIVE: windowsRoot.slice(0, -1), HOMEPATH: home.slice(windowsRoot.length - 1), USERDOMAIN: '', USERNAME: '', LOGONSERVER: '' } : {};
  return { ...env, ...windowsProfile, PATH: [path.dirname(process.execPath), ...systemPath].join(path.delimiter), HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

export async function boundedCommand(command, args, { env, cwd, timeoutMs = 30_000, maxBytes = 1024 * 1024, spawn = nativeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', total = 0, failure;
    const stop = code => { failure ??= error(code); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('CLIENT_COMMAND_TIMEOUT'), timeoutMs);
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) stop('CLIENT_OUTPUT_LIMIT');
      else if (name === 'stdout') stdout += chunk.toString('utf8');
    });
    child.once('error', () => { failure ??= error('CLIENT_COMMAND_FAILED'); });
    child.once('close', code => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0) reject(error('CLIENT_COMMAND_FAILED')); else resolve(stdout); });
  });
}

/** Extract only two explicitly named regular files; no archive paths are used
 * as destinations, no links are followed and no install scripts are executed. */
export function nativeBinary(archive, spec) {
  requireSmoke(digest(archive) === spec.integrity, 'CLIENT_ARCHIVE_INTEGRITY');
  let bytes; try { bytes = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 }); } catch { throw error('CLIENT_ARCHIVE_INVALID'); }
  let binary, metadata, entries = 0;
  for (let at = 0; at + 512 <= bytes.length;) {
    const header = bytes.subarray(at, at + 512);
    if (header.every(value => value === 0)) break;
    requireSmoke(++entries <= 4096, 'CLIENT_ARCHIVE_LIMIT');
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const prefix = text(345, 155), name = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`, raw = text(124, 12).trim();
    requireSmoke(/^[0-7]+$/.test(raw), 'CLIENT_ARCHIVE_INVALID');
    const size = Number.parseInt(raw, 8), start = at + 512;
    requireSmoke(Number.isSafeInteger(size) && size >= 0 && start + size <= bytes.length, 'CLIENT_ARCHIVE_INVALID');
    if (name === 'package/package.json' || spec.binaries.includes(name)) {
      requireSmoke(header[156] === 0 || header[156] === 48, 'CLIENT_ARCHIVE_INVALID');
      if (name === 'package/package.json') {
        requireSmoke(!metadata && size <= 64 * 1024, 'CLIENT_ARCHIVE_INVALID');
        try { metadata = JSON.parse(bytes.subarray(start, start + size)); } catch { throw error('CLIENT_ARCHIVE_INVALID'); }
      } else { requireSmoke(!binary && size > 0, 'CLIENT_ARCHIVE_INVALID'); binary = bytes.subarray(start, start + size); }
    }
    at = start + Math.ceil(size / 512) * 512;
  }
  requireSmoke(binary && metadata?.name === spec.name && metadata.version === spec.version, 'CLIENT_ARCHIVE_IDENTITY');
  return binary;
}

export async function downloadNative(spec, directory, { fetch = globalThis.fetch } = {}) {
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(180_000), redirect: 'error' });
  requireSmoke(response.ok && Number(response.headers.get('content-length') ?? 0) <= 256 * 1024 * 1024, 'CLIENT_DOWNLOAD_FAILED');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) { total += chunk.length; requireSmoke(total <= 256 * 1024 * 1024, 'CLIENT_DOWNLOAD_LIMIT'); chunks.push(chunk); }
  const binary = nativeBinary(Buffer.concat(chunks), spec), target = path.join(directory, spec.executable);
  await fs.mkdir(directory, { mode: 0o700 }); await fs.writeFile(target, binary, { flag: 'wx', mode: 0o700 });
  return executablePath(target);
}

export async function clientAdmission(client, executable, { env, cwd, version, timeoutMs = 60_000, spawn = nativeSpawn } = {}) {
  version = packageVersion(version);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  // The child receives only the disposable environment, even though production
  // adapters ordinarily preserve their user's explicitly authorized login.
  const isolatedSpawn = (command, args, options) => {
    const child = spawn(command, args, { ...options, env });
    const force = () => { const deadline = setTimeout(() => child.kill('SIGKILL'), 1000); child.once('close', () => clearTimeout(deadline)); };
    controller.signal.addEventListener('abort', force, { once: true });
    child.once('close', () => controller.signal.removeEventListener('abort', force));
    return child;
  };
  try {
    if (client === 'codex') {
      const config = await codexConfiguration(executable, cwd.path);
      const transport = new JsonProcess(executable, ['app-server', ...config], { cwd: cwd.path, env, signal: controller.signal, spawn: isolatedSpawn });
      try {
        const initialized = await transport.request('initialize', { clientInfo: { name: 'cuefluent_client_smoke', version }, capabilities: { experimentalApi: true } });
        requireSmoke(typeof initialized?.userAgent === 'string', 'CLIENT_PROTOCOL_ADMISSION');
        transport.send({ method: 'initialized', params: {} });
        requireSmoke((await transport.request('configRequirements/read', {}))?.requirements === null, 'CLIENT_POLICY_ADMISSION');
        return ['initialize', 'configRequirements/read'];
      } finally { const kill = setTimeout(() => transport.child.kill('SIGKILL'), 1000); try { await transport.dispose(); } finally { clearTimeout(kill); } }
    }
    requireSmoke(client === 'claude', 'CLIENT_UNKNOWN');
    const admitted = error('CLIENT_ADMITTED');
    try {
      await runClaude({ executable, cwd, version, model: 'opus', effort: 'high', prompt: 'Source-free CI admission; no user message will be supplied.', input: '', signal: controller.signal,
        mcp: { name: 'cuefluent_smoke', command: process.execPath, args: [path.resolve(import.meta.dirname, 'client-smoke.mjs'), '--mcp'], env: {}, tools: ['notes_read', 'draft_write'] },
        onStarted: () => { controller.abort(); throw admitted; } }, { spawn: isolatedSpawn });
    } catch (failure) { if (failure !== admitted) throw failure; return ['initialize', 'get_settings', 'mcp_status', 'get_context_usage']; }
    throw error('CLIENT_SOURCE_BOUNDARY');
  } finally { clearTimeout(timer); }
}

export async function runClientSmoke() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-client-smoke-')));
  try {
    const version = packageIdentity(JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')));
    for (const client of ['codex', 'claude']) {
      const spec = nativePackage(client), directory = path.join(root, client), env = smokeEnvironment(path.join(directory, 'profile'));
      for (const key of ['HOME', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA']) await fs.mkdir(env[key], { recursive: true, mode: 0o700 });
      const executable = await downloadNative(spec, path.join(directory, 'native'));
      const cwdPin = await createPrivateDirectory(path.join(directory, 'work'));
      const cwd = { path: cwdPin.root, check: async () => { await assertDirectory(cwdPin); requireSmoke((await fs.readdir(cwdPin.root)).length === 0, 'CLIENT_CWD_CHANGED'); } };
      const launch = { env, cwd: cwd.path };
      const actual = (await boundedCommand(executable, ['--version'], launch)).trim();
      requireSmoke(client === 'codex' ? actual === `codex-cli ${spec.clientVersion}` : actual === `${spec.clientVersion} (Claude Code)`, 'CLIENT_VERSION_MISMATCH');
      const help = await boundedCommand(executable, client === 'codex' ? ['app-server', '--help'] : ['--help'], launch);
      for (const flag of client === 'codex' ? ['--strict-config'] : ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '--input-format', '--effort']) requireSmoke(help.includes(flag), 'CLIENT_FLAGS_UNSUPPORTED');
      const protocol = await clientAdmission(client, executable, { env, cwd, version });
      await cwd.check();
      console.log(JSON.stringify({ platform: process.platform, arch: process.arch, client, version: spec.clientVersion, nativeIntegrity: `sha512-${spec.integrity}`, cliHelp: true, protocol,
        disposableProfile: true, modelCalls: false, installationFlow: false, authenticatedAcceptance: false, sandboxCanary: false }));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

function smokeMcp() {
  const tools = ['notes_read', 'draft_write'].map(name => ({ name, description: 'Source-free CI admission only; never called.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }));
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    if (Buffer.byteLength(line) > 64 * 1024) process.exit(1);
    let request; try { request = JSON.parse(line); } catch { process.exit(1); }
    if (request.id === undefined) return;
    const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cuefluent-client-smoke', version: '1.0.0' } } : request.method === 'tools/list' ? { tools } : null;
    const response = result ? { jsonrpc: '2.0', id: request.id, result } : { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'No model/tool execution is supported.' } };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

if (import.meta.main) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--mcp') smokeMcp();
  else if (process.argv.length === 2) await runClientSmoke().catch(failure => { console.error(`Real client smoke failed (${failure.code ?? 'CLIENT_SMOKE_FAILED'}).`); process.exitCode = 1; });
  else { console.error('Usage: node tools/client-smoke.mjs'); process.exitCode = 1; }
}
