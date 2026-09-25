import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fail } from './workflow-values.mjs';
import { inside } from './workflow-paths.mjs';
import { workflowTimeout } from './workflow-budget.mjs';

const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const SYSTEM = 'S-1-5-18', ADMIN = 'S-1-5-32-544', FULL = 2032127;
const probeSessions = new AsyncLocalStorage();

// No shell, no user input in program text, bounded output and runtime. Diagnostic
// codes deliberately exclude command output, which may contain private paths.
export function systemCommand(executable, args, { env = process.env, timeout = 10000 } = {}) {
  timeout = workflowTimeout(timeout);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, output = '', failed = false;
    const abort = () => { clearTimeout(timer); if (!failed) { failed = true; child.kill(); reject(Object.assign(new Error('PRIVACY_PROBE_FAILED'), { code: 'PRIVACY_PROBE_FAILED' })); } };
    const timer = setTimeout(abort, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) abort(); else output += chunk; });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) abort(); });
    child.on('error', abort);
    child.on('close', code => { clearTimeout(timer); if (!failed) { if (code !== 0) abort(); else resolve(output); } });
  });
}

export function parseUserSID(csv) {
  // whoami /user /fo csv /nh: exactly one two-field RFC4180 record.
  const match = /^"((?:[^"]|"")*)","(S-1-(?:\d+-){1,14}\d+)"\r?\n?$/.exec(csv.replace(/^\uFEFF/, ''));
  if (!match || !SID.test(match[2])) fail('PRIVACY_IDENTITY_UNAVAILABLE');
  return match[2];
}

export function windowsTools(env = process.env) {
  const root = env.SystemRoot;
  if (!root || !/^[a-z]:\\[^\r\n\u0000]*$/i.test(root)) fail('PRIVACY_TOOLS_UNAVAILABLE');
  const system = path.win32.join(root, 'System32');
  return { whoami: path.win32.join(system, 'whoami.exe'), icacls: path.win32.join(system, 'icacls.exe'),
    powershell: path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
}

export function probeEnvironment(paths, nativeEnvironment = process.env) {
  const root = nativeEnvironment.SystemRoot;
  // Windows PowerShell initializes cmdlet dependencies lazily. Its native
  // environment is needed even when a bare Console command starts successfully.
  // Remove aliases before forcing search paths: Windows spawn keeps only the
  // first sorted key among case-insensitive duplicates in a plain env object.
  const forced = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PATH', 'PSMODULEPATH', 'CUEFLUENT_PRIVACY_PATHS']);
  const inherited = Object.fromEntries(Object.entries(nativeEnvironment).filter(([key]) => !forced.has(key.toUpperCase())));
  return { ...inherited, SystemRoot: root, windir: root, SystemDrive: path.win32.parse(root).root.slice(0, 2),
    PATH: path.win32.join(root, 'System32'), PSModulePath: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    CUEFLUENT_PRIVACY_PATHS: paths };
}

// Fixed source, paths only through environment data. RawSecurityDescriptor exposes
// every ACE, including forms GetAccessRules would otherwise normalize or omit.
export const ACL_PROBE = String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$paths=ConvertFrom-Json $env:CUEFLUENT_PRIVACY_PATHS;
$result=@(foreach($p in $paths) {
  $item=Get-Item -Force -LiteralPath $p;
  $acl=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $p;
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);
  $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($p));
  $aces=@(foreach($ace in $raw.DiscretionaryAcl) {
    @{type=[int]$ace.AceType; flags=[int]$ace.AceFlags; mask=[int]$ace.AccessMask; sid=$ace.SecurityIdentifier.Value}
  });
  @{path=$p; owner=$raw.Owner.Value; protected=$acl.AreAccessRulesProtected;
    daclPresent=($null -ne $raw.DiscretionaryAcl); aces=$aces; attributes=[int]$item.Attributes;
    driveType=[int]$drive.DriveType; driveFormat=$drive.DriveFormat}
}); ConvertTo-Json -Depth 6 -Compress -InputObject $result`;

/** Scoped native checks: Windows reuses one transport but queries fresh ACLs;
 * macOS reuses only stable stat-version ACL results, never locality decisions.
 * Nested calls share the outer scope; all resources end with that operation.
 */
export async function withStorageProbes(operation) {
  if (process.platform === 'darwin') {
    if (probeSessions.getStore()) return operation();
    const session = { active: true, aclCache: new Map() };
    try { return await probeSessions.run(session, operation); }
    finally { session.active = false; session.aclCache.clear(); }
  }
  if (process.platform !== 'win32') return operation();
  // A CLI command can enter a bounded worker inside its existing probe scope.
  // Reuse that live query transport; every query still checks current ACLs and
  // the innermost budget, and only its original owner closes the child.
  if (probeSessions.getStore()) return operation();
  const script = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); function Read-CuefluentAcl($pathData) {${ACL_PROBE.replace('$env:CUEFLUENT_PRIVACY_PATHS', '$pathData')}}; while(($line=[Console]::In.ReadLine()) -ne $null) { Read-CuefluentAcl $line }`;
  const child = spawn(windowsTools().powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: probeEnvironment('') });
  let pending = null, buffer = '', received = 0, dead = false, queue = Promise.resolve();
  const failed = () => {
    dead = true; child.kill();
    if (pending) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error('PRIVACY_PROBE_FAILED'), { code: 'PRIVACY_PROBE_FAILED' })); pending = null; }
  };
  child.on('error', failed); child.on('close', failed); child.stdin.on('error', failed);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    received += Buffer.byteLength(chunk); buffer += chunk;
    if (received > 1024 * 1024 || !pending) { failed(); return; }
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    const line = buffer.slice(0, end).trim(), remainder = buffer.slice(end + 1);
    if (remainder.trim()) { failed(); return; }
    const request = pending; pending = null; buffer = ''; clearTimeout(request.timer);
    request.resolve(line);
  });
  child.stderr.on('data', chunk => { received += chunk.length; if (received > 1024 * 1024) failed(); });
  const session = { sid: null, acl(paths) {
    const next = queue.then(() => new Promise((resolve, reject) => {
      if (dead) { reject(Object.assign(new Error('PRIVACY_PROBE_FAILED'), { code: 'PRIVACY_PROBE_FAILED' })); return; }
      const timeout = workflowTimeout(); received = 0; buffer = '';
      pending = { resolve, reject, timer: setTimeout(failed, timeout) };
      child.stdin.write(paths + '\n');
    }));
    queue = next.catch(() => {}); return next;
  } };
  try { return await probeSessions.run(session, operation); }
  finally { child.stdin.end(); failed(); }
}

export function validateWindowsACL(value, sid, { directory, root }) {
  if (!SID.test(sid) || !value || ![sid, SYSTEM, ADMIN].includes(value.owner) || value.daclPresent !== true ||
      !Array.isArray(value.aces) || value.aces.length < 1 || value.aces.length > 20 ||
      !Number.isInteger(value.attributes) || (value.attributes & 1024) || // reparse points
      Boolean(value.attributes & 16) !== directory || (root && value.protected !== true)) fail('STORAGE_NOT_PRIVATE');
  const allowed = new Set([sid, SYSTEM, ADMIN]), grants = new Set();
  for (const ace of value.aces) {
    // Standard allow only, no callbacks/object ACEs, denies, inherit-only or
    // no-propagate entries. Conservative exact full grants for these identities.
    if (!allowed.has(ace.sid) || ace.type !== 0 || ace.mask !== FULL || !Number.isInteger(ace.flags) ||
        (directory ? ![3, 19].includes(ace.flags) : ![0, 16].includes(ace.flags))) fail('STORAGE_NOT_PRIVATE');
    grants.add(ace.sid);
  }
  if (![sid, SYSTEM, ADMIN].every(item => grants.has(item))) fail('STORAGE_NOT_PRIVATE');
  if (![2, 3].includes(value.driveType) || !['NTFS', 'ReFS'].includes(value.driveFormat)) fail('STORAGE_LOCALITY_UNVERIFIED');
}

export function rejectKnownSync(file, env = process.env, platform = process.platform) {
  if (platform === 'win32' && !/^[a-z]:\\/i.test(file)) fail('STORAGE_LOCALITY_UNVERIFIED');
  const segments = file.replaceAll('\\', '/').split('/');
  if (segments.some(part => /^(?:OneDrive(?:[ -].*)?|Dropbox(?:[ -].*)?|Google Drive|GoogleDrive|CloudStorage|Mobile Documents)$/i.test(part))) fail('SYNCED_WORKFLOW_STORAGE');
  for (const name of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    if (env[name] && inside(env[name], file, platform)) fail('SYNCED_WORKFLOW_STORAGE');
  }
  if (platform === 'darwin' && ['Desktop', 'Documents'].some(name => inside(path.posix.join(os.homedir(), name), file, platform))) fail('SYNCED_WORKFLOW_STORAGE');
}

function macMountRecords(mounts) {
  const result = [];
  for (const line of mounts.split('\n')) {
    const match = /^.+ on (\/.*) \(([^()]+)\)$/.exec(line);
    if (!match) continue;
    const flags = match[2].split(', ');
    result.push({ path: match[1], flags });
  }
  return result;
}
export const privateMacMounts = mounts => macMountRecords(mounts)
  .filter(({ flags }) => flags.includes('local') && !flags.includes('noowners') && ['apfs', 'hfs'].includes(flags[0]))
  .map(item => item.path);
async function macLocal(devices) {
  const local = new Set();
  // Locality is never cached across privacy boundaries: mount flags can change
  // without changing a directory's inode or ctime.
  for (const mount of macMountRecords(await systemCommand('/sbin/mount', []))) {
    if (!['apfs', 'hfs'].includes(mount.flags[0]) || !mount.flags.includes('local')) continue;
    let stat;
    try { stat = await fs.stat(mount.path, { bigint: true }); } catch { continue; }
    if (!devices.has(stat.dev)) continue;
    if (mount.flags.includes('noowners')) fail('STORAGE_LOCALITY_UNVERIFIED');
    local.add(stat.dev);
  }
  if ([...devices].some(device => !local.has(device))) fail('STORAGE_LOCALITY_UNVERIFIED');
}
const aclVersion = (entry, identity) => JSON.stringify([String(identity), entry.path, Boolean(entry.root), entry.stat.isDirectory(),
  ...['dev', 'ino', 'birthtimeNs', 'ctimeNs', 'mtimeNs', 'size', 'mode', 'uid', 'gid', 'nlink'].map(key => String(entry.stat[key]))]);
async function stableACLEntry(entry, identity, version) {
  const stat = await fs.lstat(entry.path, { bigint: true });
  if (aclVersion({ ...entry, stat }, identity) !== version || stat.isSymbolicLink() ||
      await fs.realpath(entry.path) !== entry.path) fail('PRIVATE_STORAGE_CHANGED');
}

export async function privacyIdentity() {
  if (process.platform !== 'win32') return process.geteuid();
  const session = probeSessions.getStore();
  if (session?.sid) return session.sid; // Process user token, never a permission cache.
  const sid = parseUserSID(await systemCommand(windowsTools().whoami, ['/user', '/fo', 'csv', '/nh']));
  if (session) session.sid = sid;
  return sid;
}

/** Metadata only. entries contain pinned lstat values; never read file bodies. */
export async function verifyPrivateEntries(entries, identity, { fresh = false } = {}) {
  if (process.platform === 'win32') {
    for (let offset = 0; offset < entries.length; offset += 32) {
      const batch = entries.slice(offset, offset + 32);
      const paths = JSON.stringify(batch.map(item => item.path));
      if (paths.length > 24000) fail('PRIVACY_PROBE_CAPACITY');
      let values;
      try {
        const session = probeSessions.getStore();
        values = JSON.parse(session ? await session.acl(paths) : await systemCommand(windowsTools().powershell, ['-NoProfile', '-NonInteractive', '-Command', ACL_PROBE],
          { env: probeEnvironment(paths) }));
      } catch { fail('PRIVACY_PROBE_FAILED'); }
      if (!Array.isArray(values) || values.length !== batch.length) fail('PRIVACY_PROBE_FAILED');
      for (let i = 0; i < batch.length; i++) {
        if (values[i].path !== batch[i].path) fail('PRIVACY_PROBE_FAILED');
        validateWindowsACL(values[i], identity, { directory: batch[i].stat.isDirectory(), root: batch[i].root });
      }
    }
  } else {
    const devices = new Set();
    for (const item of entries) {
      const permissions = Number(item.stat.mode & 0o7777n);
      if (item.stat.uid !== BigInt(identity) || permissions !== (item.stat.isDirectory() ? 0o700 : 0o600)) fail('STORAGE_NOT_PRIVATE');
      if (process.platform === 'darwin') {
        devices.add(item.stat.dev);
      } else if (process.platform === 'linux') {
        // ext*, XFS, Btrfs, tmpfs. Unknown/network/FUSE filesystems fail closed.
        if (![0xef53, 0x58465342, 0x9123683e, 0x01021994].includes((await fs.statfs(item.path)).type >>> 0)) fail('STORAGE_LOCALITY_UNVERIFIED');
      } else fail('PRIVACY_PLATFORM_UNSUPPORTED');
    }
    if (process.platform === 'darwin') {
      await macLocal(devices);
      const session = probeSessions.getStore(), cache = session?.active ? session.aclCache : null;
      const pending = [], versions = new Map();
      for (const entry of entries) {
        const version = aclVersion(entry, identity); versions.set(entry.path, version);
        await stableACLEntry(entry, identity, version);
        if (fresh || cache?.get(entry.path) !== version) pending.push(entry);
      }
      for (let offset = 0; offset < pending.length; offset += 32) {
        const batch = pending.slice(offset, offset + 32);
        // Extended ACL rows and '+' mode markers are rejected. '@' alone is
        // an extended attribute, not an access grant.
        const acl = await systemCommand('/bin/ls', ['-lde', ...batch.map(item => item.path)], { env: { ...process.env, LC_ALL: 'C' } });
        const lines = acl.trimEnd().split('\n');
        if (lines.length !== batch.length || lines.some(line => !/^[d-][rwxstST-]{9}@? [^\n]*$/.test(line))) fail('STORAGE_NOT_PRIVATE');
      }
      // Cache only a complete successful probe. Hits still get fresh checks.
      for (const entry of entries) await stableACLEntry(entry, identity, versions.get(entry.path));
      if (cache) for (const entry of pending) {
        cache.delete(entry.path); cache.set(entry.path, versions.get(entry.path));
        if (cache.size > 512) cache.delete(cache.keys().next().value);
      }
    }
  }
}

/** Only the caller's newly created empty directory may be changed. */
export async function protectNewDirectory(file, identity) {
  if ((await fs.readdir(file)).length !== 0) fail('PRIVATE_SETUP_CONFLICT');
  if (process.platform === 'win32') {
    if (!SID.test(identity)) fail('PRIVACY_IDENTITY_UNAVAILABLE');
    await systemCommand(windowsTools().icacls, [file, '/inheritance:r', '/grant:r',
      `*${identity}:(OI)(CI)F`, `*${SYSTEM}:(OI)(CI)F`, `*${ADMIN}:(OI)(CI)F`]);
  } else if (process.platform === 'darwin') await systemCommand('/bin/chmod', ['-N', file]);
}
