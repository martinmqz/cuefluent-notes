import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { parse } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const LIMIT = 64 * 1024;
const DEADLINE = 15_000;
const REGISTRY = Symbol.for('cuefluent.notes.v2.windows-acl');
const deadlines = new AsyncLocalStorage();

/** One hook's whole storage budget, including every synchronous ACL round trip. */
export function withWindowsAclDeadline(fn, { timeoutMs } = {}) {
  if (typeof fn !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw Object.assign(new Error('Invalid ACL operation deadline.'), { code: 'WINDOWS_ACL_DEADLINE_INVALID' });
  return deadlines.run(Math.min(deadlines.getStore() ?? Infinity, performance.now() + timeoutMs), fn);
}

function remainingBudget() {
  const remaining = Math.min(DEADLINE, (deadlines.getStore() ?? Infinity) - performance.now());
  if (remaining <= 0) throw Object.assign(new Error('Windows ACL verification exhausted the operation deadline.'), { code: 'WINDOWS_ACL_TIMEOUT' });
  return remaining;
}

// Only this fixed operation runs in PowerShell. Paths are JSON data on stdin,
// never interpolated into a script. Every request performs a fresh Get-Acl.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = ConvertFrom-Json -InputObject $line
    $p = [string]$request.path
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($p))
    if ($request.create -eq $true) {
      $acl = Get-Acl -LiteralPath $p
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
      $acl.SetOwner($sid)
      $inherit = [Security.AccessControl.InheritanceFlags]::None
      if (Test-Path -LiteralPath $p -PathType Container) {
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
      }
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $p -AclObject $acl
    }
    $acl = Get-Acl -LiteralPath $p
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType; rights = [int64]$_.FileSystemRights }
    })
    $result = @{ owner = $owner; user = $sid.Value; protected = $acl.AreAccessRulesProtected; rules = $rules; driveType = [string]$drive.DriveType; format = $drive.DriveFormat }
    [Console]::WriteLine(($result | ConvertTo-Json -Depth 4 -Compress))
  } catch {
    [Console]::WriteLine('{"error":"ACL_QUERY_FAILED"}')
  }
}
`;

/** A single unref worker keeps the synchronous storage API without spawning a
 * process per check. It owns no SQLite connection or mutation gate. The shared
 * response bounds boot, transport and the native operation to the same deadline. */
export function queryWindowsAcl(file, create) {
  if (!isMainThread || process.platform !== 'win32' || typeof file !== 'string' ||
      !/^[A-Za-z]:[\\/]/.test(file) || /[\u0000-\u001f\u007f]/.test(file) || typeof create !== 'boolean') {
    throw new Error('Invalid Windows ACL request.');
  }
  remainingBudget(); // Refuse before creating a helper or starting an ACL mutation.
  const request = JSON.stringify({ path: file, create });
  if (Buffer.byteLength(request) > LIMIT) throw new Error('Windows ACL request exceeds its bound.');
  let worker = globalThis[REGISTRY];
  if (!worker) {
    worker = new Worker(new URL('./windows-acl.mjs', import.meta.url), { execArgv: [], workerData: 'cuefluent-acl-v1' });
    globalThis[REGISTRY] = worker;
    const clear = () => { if (globalThis[REGISTRY] === worker) delete globalThis[REGISTRY]; };
    worker.on('error', clear); worker.on('exit', clear); worker.unref();
  }
  const buffer = new SharedArrayBuffer(8 + LIMIT), state = new Int32Array(buffer, 0, 2);
  try {
    worker.postMessage({ request, buffer });
    if (Atomics.wait(state, 0, 0, remainingBudget()) === 'timed-out') throw Object.assign(new Error('Windows ACL helper exceeded its deadline.'), { code: 'WINDOWS_ACL_TIMEOUT' });
    if (Atomics.load(state, 0) !== 1) throw new Error('Windows ACL helper failed.');
    const size = Atomics.load(state, 1);
    if (size < 1 || size > LIMIT) throw new Error('Invalid Windows ACL response bound.');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 8, size)));
    if (!value || value.error) throw new Error('Windows ACL query failed.');
    return value;
  } catch (error) {
    if (globalThis[REGISTRY] === worker) delete globalThis[REGISTRY];
    void worker.terminate(); throw error;
  }
}

if (!isMainThread && workerData === 'cuefluent-acl-v1') {
  // EOF on the worker-owned stdin closes the native helper after parent death or
  // worker termination. No named pipe, helper server or persisted state exists.
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    // The helper must not pin the caller's project directory after parent exit.
    // All requests carry absolute paths; its working directory is irrelevant.
    { cwd: parse(process.execPath).root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = null, tail = Buffer.alloc(0), failed = false, stderrBytes = 0;
  const reply = (status, bytes = Buffer.alloc(0)) => {
    if (!pending) return;
    const state = new Int32Array(pending, 0, 2);
    if (bytes.length > LIMIT) status = -1;
    if (status === 1) new Uint8Array(pending, 8, bytes.length).set(bytes);
    Atomics.store(state, 1, status === 1 ? bytes.length : 0);
    Atomics.store(state, 0, status); Atomics.notify(state, 0); pending = null;
  };
  const stop = () => { failed = true; reply(-1); child.stdin.destroy(); child.kill(); };
  child.on('error', stop); child.on('exit', stop); child.stdin.on('error', stop);
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > LIMIT) stop(); });
  child.stdout.on('data', chunk => {
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > LIMIT + 2) { stop(); return; }
    const end = tail.indexOf(10);
    if (end < 0) return;
    if (!pending || end !== tail.length - 1) { stop(); return; }
    const bytes = tail.subarray(0, end > 0 && tail[end - 1] === 13 ? end - 1 : end);
    tail = Buffer.alloc(0); reply(1, bytes);
  });
  parentPort.on('message', message => {
    const valid = message && typeof message.request === 'string' && Buffer.byteLength(message.request) <= LIMIT &&
      message.buffer instanceof SharedArrayBuffer && message.buffer.byteLength === LIMIT + 8;
    if (!valid || pending) { stop(); return; }
    pending = message.buffer;
    if (failed) { reply(-1); return; }
    child.stdin.write(message.request + '\n');
  });
  parentPort.on('close', stop);
  process.on('exit', () => { child.stdin.destroy(); child.kill(); });
}
