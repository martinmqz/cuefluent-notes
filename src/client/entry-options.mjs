import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fail } from '../core/errors.mjs';
import { pinDirectory, assertDirectory, inspectParent, assertChain, fileIdentity, sameIdentity, lstatOrNull } from '../storage/paths.mjs';
import { readHandleStat } from '../storage/stat.mjs';

const CLIENTS = new Set(['claude', 'codex']);
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const invalid = () => fail('ENTRY_ARGUMENT_INVALID', 'Use a supported command and its exact documented arguments.');
function absolute(value, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 32768 || /[\u0000-\u001f\u007f]/.test(value) || !paths.isAbsolute(value) || paths.normalize(value) !== value || value.endsWith(paths.sep) || paths.parse(value).root === value) invalid();
  if (platform === 'win32' && (!/^[A-Za-z]:\\/.test(value) || value.slice(3).split('\\').some(part => /[:*?"<>|]|[. ]$/.test(part) || RESERVED.test(part)))) invalid();
  return value;
}
function token(value, maximum = 256) {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) invalid();
  return value;
}
function client(value) { if (!CLIENTS.has(value)) invalid(); return value; }
function invocationHandle(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value) || Buffer.from(value, 'base64url').length !== 64 || Buffer.from(value, 'base64url').toString('base64url') !== value) invalid();
  return value;
}

/** Trusted OS argv only. No option supplies a model-call native context or an
 * installed package path; internal worker identities are validated positional data. */
export function parseEntryArguments(argv, { platform = process.platform } = {}) {
  if (!Array.isArray(argv) || argv.length > 8 || argv.some(value => typeof value !== 'string' || Buffer.byteLength(value) > 32768 || /[\u0000-\u001f\u007f]/.test(value))) invalid();
  const [command, ...args] = argv; let result;
  if (['hook', 'mcp'].includes(command) && args.length === 1) result = { command, client: client(args[0]) };
  else if (command === 'setup' && args.length === 2 && args[0] === '--config') result = { command, configPath: absolute(args[1], platform) };
  else if (command === 'settings' && args.length === 0) result = { command };
  else if (command === 'status' && args.length === 2 && args[0] === '--project') {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(args[1])) invalid();
    result = { command, projectId: args[1] };
  } else if (command === 'sync-steward' && args.length === 1) result = { command, storeRoot: absolute(args[0], platform) };
  else if (command === 'sync-collect' && args.length === 3) result = { command, storeRoot: absolute(args[0], platform), client: client(args[1]), sessionId: token(args[2]) };
  else if (command === 'command-worker' && args.length === 2) result = { command, storeRoot: absolute(args[0], platform), handle: invocationHandle(args[1]) };
  else invalid();
  return Object.freeze(result);
}

function environment(env, key) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(env, key);
  if (descriptor && (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string')) invalid();
  return descriptor?.value;
}

// OS locations may contain redundant or trailing separators. Normalize these
// separately from strict explicit CLI/override arguments; root homes are valid.
function environmentLocation(value, platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 32768 || /[\u0000-\u001f\u007f]/.test(value) || !paths.isAbsolute(value))
    fail('ENTRY_LOCATION_INVALID', 'The operating-system private-store location is invalid.');
  const normalized = paths.normalize(value), root = paths.parse(normalized).root;
  const result = normalized === root ? root : normalized.replace(platform === 'win32' ? /\\+$/ : /\/+$/, '');
  if (platform === 'win32' && (!/^[A-Za-z]:\\/.test(result) || result.slice(3).split('\\').filter(Boolean).some(part => /[:*?"<>|]|[. ]$/.test(part) || RESERVED.test(part))))
    fail('ENTRY_LOCATION_INVALID', 'The operating-system private-store location is invalid.');
  return result;
}

/** Pure location selection. Opening/setup owns canonical ancestor verification,
 * privacy, local-filesystem and repository/note overlap checks. Nothing is read
 * from any former product location and this function never creates directories. */
export function selectStoreRoot({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) fail('ENTRY_PLATFORM_UNSUPPORTED', 'This platform has no supported private-store location.');
  const override = environment(env, 'CUEFLUENT_V2_HOME');
  if (override !== undefined) return absolute(override, platform);
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = environmentLocation(homedir, platform);
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', 'Cuefluent Notes', 'v2');
  if (platform === 'win32') {
    const local = environment(env, 'LOCALAPPDATA');
    return paths.join(local ? environmentLocation(local, platform) : paths.join(home, 'AppData', 'Local'), 'Cuefluent Notes', 'v2');
  }
  const state = environment(env, 'XDG_STATE_HOME');
  return paths.join(state && paths.isAbsolute(state) ? environmentLocation(state, platform) : paths.join(home, '.local', 'state'), 'cuefluent-notes', 'v2');
}

async function packageFile(pin, relative, { read = false, missing = false, maxBytes = 64 * 1024 } = {}) {
  const parent = await inspectParent(pin, relative), observed = await lstatOrNull(parent.file);
  if (!observed) {
    if (!missing) fail('CLIENT_PACKAGE_INVALID', 'The native package is incomplete.');
    await assertDirectory(pin); await assertChain(parent.chain); return null;
  }
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1 || observed.size > maxBytes) fail('CLIENT_PACKAGE_INVALID', 'A native package contract file is unsafe or oversized.');
  const handle = await open(parent.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await readHandleStat(handle);
    if (!sameIdentity(opened, fileIdentity(observed)) || !opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes) fail('CLIENT_PACKAGE_CHANGED', 'The native package contract changed while opening.');
    let bytes = null;
    if (read) {
      bytes = Buffer.alloc(opened.size + 1); let length = 0;
      while (length < bytes.length) {
        const count = (await handle.read(bytes, length, bytes.length - length, length)).bytesRead;
        if (!count) break; length += count;
      }
      if (length !== opened.size) fail('CLIENT_PACKAGE_CHANGED', 'The native package contract changed while reading.');
      bytes = bytes.subarray(0, length);
    }
    const final = await readHandleStat(handle), linked = await lstatOrNull(parent.file);
    if (!linked || !sameIdentity(linked, fileIdentity(opened)) || !sameIdentity(final, fileIdentity(opened)) || final.size !== opened.size || final.mtimeNs !== opened.mtimeNs || final.ctimeNs !== opened.ctimeNs || !final.isFile() || final.nlink !== 1 || linked.nlink !== 1) fail('CLIENT_PACKAGE_CHANGED', 'The native package contract changed during verification.');
    await assertDirectory(pin); await assertChain(parent.chain);
    return Object.freeze({ file: parent.file, bytes });
  } finally { await handle.close(); }
}

/** packageRoot comes from this executable module's installation, never an MCP
 * argument. Fixed paths only: no plugin discovery, user configuration or legacy
 * settings. The installed skill always takes precedence over development. */
export async function loadClientContract(packageRoot) {
  absolute(packageRoot);
  const pin = await pinDirectory(packageRoot);
  let installed;
  try { installed = await packageFile(pin, 'skills/cuefluent-notes/SKILL.md', { missing: true, maxBytes: 256 * 1024 }); }
  catch (error) { if (!['ENOENT', 'PATH_MISSING'].includes(error.code)) throw error; }
  let skillPath, layout;
  if (installed) { skillPath = installed.file; layout = 'installed'; }
  else {
    const manifest = await packageFile(pin, 'package.json', { read: true }); let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes)); } catch { fail('CLIENT_PACKAGE_INVALID', 'The development package marker is invalid.'); }
    if (parsed?.name !== 'cuefluent-notes' || parsed.private !== true || parsed.type !== 'module') fail('CLIENT_PACKAGE_INVALID', 'A root skill is available only in the explicit development package.');
    skillPath = (await packageFile(pin, 'SKILL.md', { maxBytes: 256 * 1024 })).file; layout = 'development';
  }
  return Object.freeze({ packageRoot, layout, codex: Object.freeze({ name: 'cuefluent-notes', skillPath }),
    claude: Object.freeze({ name: 'cuefluent-notes:cuefluent-notes', source: 'plugin' }) });
}
