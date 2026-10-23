import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Database } from 'node:sqlite';
import test from 'node:test';
import * as gates from '../src/storage/gates.mjs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { assertPrivateAccess, establishWindowsPrivacy } from '../src/storage/platform.mjs';

const { assertGatePlacement } = gates;
const fixture = fileURLToPath(new URL('./fixtures/gate-holder.mjs', import.meta.url));
const windows = process.platform === 'win32';
const cleanups = new WeakMap();
function onCleanup(t, fn) { cleanups.get(t).push(fn); }
function profile(options = {}) {
  if (!windows) return options;
  return { ...options,
    initializePath(file) { establishWindowsPrivacy(file); return options.initializePath?.(file); },
    guardPath(file, context) { assertPrivateAccess(file, context.stat); return options.guardPath?.(file, context); },
  };
}
const initializeGate = (file, id, options) => gates.initializeGate(file, id, profile(options));
const inspectExistingGate = (file, id, options) => gates.inspectExistingGate(file, id, profile(options));
const probeGate = (identity, options) => gates.probeGate(identity, profile(options));
const tryAcquireExistingGate = (identity, options) => gates.tryAcquireExistingGate(identity, profile(options));
const withShortGate = (identity, options, fn) => gates.withShortGate(identity, profile(options), fn);

function setup(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cuefluent-gates-')));
  establishWindowsPrivacy(directory);
  const pending = []; cleanups.set(t, pending);
  t.after(async () => {
    try { for (const close of pending.reverse()) await close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return directory;
}

function changeWindowsAcl(file, { publicRead = false, ownerRights = 'FullControl' } = {}) {
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
$p=$env:CUEFLUENT_TEST_GATE_PATH; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false);
foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,$env:CUEFLUENT_TEST_GATE_RIGHTS,'Allow')));
if($env:CUEFLUENT_TEST_GATE_PUBLIC -eq '1'){$everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone,'Read','Allow')))}
Set-Acl -LiteralPath $p -AclObject $acl`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CUEFLUENT_TEST_GATE_PATH: file, CUEFLUENT_TEST_GATE_RIGHTS: ownerRights, CUEFLUENT_TEST_GATE_PUBLIC: publicRead ? '1' : '0' } });
}

function child(identity, operation = 'hold') {
  const process = spawn(globalThis.process.execPath, [fixture, JSON.stringify(identity), operation], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  process.stderr.on('data', (chunk) => { errors += chunk; });
  const message = new Promise((resolve, reject) => {
    process.once('message', (value) => {
      if (value.type === 'error') reject(new Error(`${value.code}: ${value.message}`));
      else resolve(value);
    });
    process.once('error', reject);
    process.once('exit', (code) => { if (code !== 0) reject(new Error(`Child exited ${code}: ${errors}`)); });
  });
  return { process, message };
}

async function hold(t, identity) {
  const worker = child(identity);
  onCleanup(t, async () => {
    if (worker.process.exitCode === null && worker.process.signalCode === null) {
      const exit = once(worker.process, 'exit');
      worker.process.kill();
      await exit;
    }
  });
  assert.equal((await worker.message).type, 'ready');
  return worker.process;
}

async function externalProbe(identity) {
  const worker = child(identity, 'probe');
  const exit = once(worker.process, 'exit');
  const result = await worker.message;
  await exit;
  return result.result;
}

const gateTest = (name, fn) => test(name, { timeout: windows ? 30_000 : 10_000 }, fn);

test('macOS gates reject file and parent ACL grants without a caller-supplied guard', { skip: process.platform !== 'darwin' }, t => {
  const directory = setup(t), file = join(directory, 'acl.sqlite');
  const gate = gates.initializeGate(file, 'acl');
  execFileSync('/bin/chmod', ['+a', 'everyone allow read', file]);
  assert.throws(() => gates.probeGate(gate), { code: 'GATE_UNSAFE_PATH' });
  assert.throws(() => gates.tryAcquireExistingGate(gate), { code: 'GATE_UNSAFE_PATH' });
  execFileSync('/bin/chmod', ['+a', 'everyone allow read,file_inherit,only_inherit', directory]);
  assert.throws(() => gates.initializeGate(join(directory, 'new.sqlite'), 'new'), { code: 'GATE_UNSAFE_PATH' });
  assert.deepEqual(readdirSync(directory), ['acl.sqlite']);
});

gateTest('created-file privacy initialization runs only on the exact exclusive unpublished stage', t => {
  const directory = setup(t), file = join(directory, 'created.sqlite'); let calls = 0;
  const initializePath = stage => {
    calls++; assert.notEqual(stage, file); assert.ok(stage.endsWith('.tmp'));
    const observed = lstatSync(stage, { bigint: true }); assert.equal(observed.nlink, 1n); assert.equal(observed.size, 0n);
  };
  const gate = initializeGate(file, 'created', { initializePath }); assert.equal(calls, 1);
  assert.deepEqual(probeGate(gate, { initializePath: () => assert.fail('Acquisition initialized an existing inode') }), { available: true });
  assert.throws(() => initializeGate(file, 'created', { initializePath }), { code: 'GATE_EXISTS' }); assert.equal(calls, 1);
});

async function crashInitialization(t, path, phase) {
  const module = new URL('../src/storage/gates.mjs', import.meta.url).href;
  const code = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const [path,phase]=process.argv.slice(1);
    function pause(){process.send({type:'paused'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
    if(phase==='published'){
      const original=fs.linkSync;fs.linkSync=function(from,to){const result=original(from,to);if(to===path)pause();return result;};
    }else{
      const original=fs.openSync;fs.openSync=function(file,flags,...rest){const result=original(file,flags,...rest);
        if(typeof flags==='number'&&(flags&fs.constants.O_CREAT)&&String(file).endsWith('.tmp'))pause();return result;};
    }
    syncBuiltinESMExports();
    const {initializeGate}=await import(${JSON.stringify(module)});
    const {assertPrivateAccess,establishWindowsPrivacy}=await import(${JSON.stringify(new URL('../src/storage/platform.mjs', import.meta.url).href)});
    const options=process.platform==='win32'?{guardPath:(file,{stat})=>assertPrivateAccess(file,stat),initializePath:establishWindowsPrivacy}:{};
    initializeGate(path,'crash-test',options);
    process.send({type:'unexpected-completion'});
  `;
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code, path, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  process.stderr.on('data', bytes => { errors += bytes; });
  onCleanup(t, async () => {
    if (process.exitCode === null && process.signalCode === null) { const exit = once(process, 'exit'); process.kill(); await exit; }
  });
  const ready = await new Promise((resolve, reject) => {
    process.once('message', resolve); process.once('error', reject);
    process.once('exit', code => reject(new Error(`Initializer exited ${code}: ${errors}`)));
  });
  assert.deepEqual(ready, { type: 'paused' });
  const exit = once(process, 'exit'); process.kill('SIGKILL'); await exit;
}

test('POSIX placement preflight refuses unsafe ancestor modes before setup writes directories', { skip: windows ? 'POSIX mode-bit primitive; Windows privacy uses native ACL checks.' : false }, t => {
  const directory = setup(t);
  const unsafe = join(directory, 'unsafe');
  mkdirSync(unsafe, { mode: 0o700 });
  chmodSync(unsafe, 0o770);
  const requested = join(unsafe, 'config', 'nested');
  assert.throws(() => assertGatePlacement(requested), { code: 'GATE_UNSAFE_PATH' });
  assert.equal(existsSync(join(unsafe, 'config')), false);
  chmodSync(unsafe, 0o700);
  assert.doesNotThrow(() => assertGatePlacement(requested));
});

gateTest('placement preflight refuses linked ancestors before creating directories', t => {
  const directory = setup(t), linked = join(directory, 'linked');
  symlinkSync(directory, linked, windows ? 'junction' : 'dir');
  assert.throws(() => assertGatePlacement(join(linked, 'future')), { code: 'GATE_UNSAFE_PATH' });
  assert.equal(existsSync(join(directory, 'future')), false);
});

gateTest('noncrash initialization failure cleans only its own unpublished stage', t => {
  const directory = setup(t);
  const path = join(directory, 'gate.sqlite');
  const original = Database.prototype.exec;
  let failed = false;
  t.mock.method(Database.prototype, 'exec', function(sql) {
    if (!failed && sql.startsWith('CREATE TABLE gate_marker')) { failed = true; throw new Error('synthetic database write failure'); }
    return original.call(this, sql);
  });
  assert.throws(() => initializeGate(path, 'retry'), { code: 'GATE_STORAGE_ERROR' });
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(probeGate(initializeGate(path, 'retry')), { available: true });
});

gateTest('a killed unpublished initialization never burns the final gate pathname', async t => {
  const directory = setup(t);
  const path = join(directory, 'gate.sqlite');
  await crashInitialization(t, path, 'created');
  assert.equal(existsSync(path), false);
  const artifacts = readdirSync(directory);
  assert.equal(artifacts.length, 1);
  assert.ok(artifacts[0].endsWith('.tmp'));
  const identity = initializeGate(path, 'crash-test');
  assert.deepEqual(probeGate(identity), { available: true });
  assert.ok(existsSync(join(directory, artifacts[0])));
});

gateTest('explicit setup reconciles only the exact initialized two-link publication', async t => {
  const directory = setup(t);
  const path = join(directory, 'gate.sqlite');
  await crashInitialization(t, path, 'published');
  const stat = lstatSync(path, { bigint: true });
  assert.equal(stat.nlink, 2n);
  const expected = { path, id: 'crash-test', device: String(stat.dev), inode: String(stat.ino) };
  assert.throws(() => probeGate(expected), { code: 'GATE_UNSAFE_PATH' });
  assert.throws(() => initializeGate(path, expected.id), { code: 'GATE_EXISTS' });
  assert.deepEqual(inspectExistingGate(path, expected.id), expected);
  assert.equal(lstatSync(path).nlink, 1);
  assert.deepEqual(readdirSync(directory), ['gate.sqlite']);
  assert.deepEqual(probeGate(expected), { available: true });
});

gateTest('explicit setup never unlinks an arbitrary second hard link', t => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'owned');
  const unknown = join(directory, 'unrelated.sqlite');
  linkSync(identity.path, unknown);
  assert.throws(() => inspectExistingGate(identity.path, identity.id), { code: 'GATE_UNSAFE_PATH' });
  assert.equal(existsSync(unknown), true);
  assert.equal(lstatSync(identity.path).nlink, 2);
});

gateTest('concurrent explicit setup converges on one initialized final inode', async t => {
  const directory = setup(t);
  const path = join(directory, 'gate.sqlite');
  const module = new URL('../src/storage/gates.mjs', import.meta.url).href;
  const code = `
    import {initializeGate,inspectExistingGate} from ${JSON.stringify(module)};
    import {assertPrivateAccess,establishWindowsPrivacy} from ${JSON.stringify(new URL('../src/storage/platform.mjs', import.meta.url).href)};
    const options=process.platform==='win32'?{guardPath:(file,{stat})=>assertPrivateAccess(file,stat),initializePath:establishWindowsPrivacy}:{};
    let identity;
    try {identity=initializeGate(process.argv[1],'concurrent',options);}
    catch(error){if(error.code!=='GATE_EXISTS')throw error;identity=inspectExistingGate(process.argv[1],'concurrent',options);}
    process.send(identity,()=>process.disconnect());
  `;
  const initializer = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '';
    child.stderr.on('data', value => { errors += value; });
    return new Promise((resolve, reject) => {
      let identity;
      child.once('message', value => { identity = value; });
      child.once('error', reject);
      child.once('exit', code => code === 0 && identity ? resolve(identity) : reject(new Error(`Initializer failed ${code}: ${errors}`)));
    });
  };
  const [first, second] = await Promise.all([initializer(), initializer()]);
  assert.deepEqual(first, second);
  assert.deepEqual(probeGate(first), { available: true });
  assert.deepEqual(readdirSync(directory), ['gate.sqlite']);
});

gateTest('initialized gate keeps its identity, bytes, and directory unchanged through pure probes', (t) => {
  const directory = setup(t);
  const path = join(directory, 'gate #%.sqlite');
  const identity = initializeGate(path, 'project:test-1');
  assert.equal(identity.path, path);
  assert.equal(identity.device, String(lstatSync(path, { bigint: true }).dev));
  assert.equal(identity.inode, String(lstatSync(path, { bigint: true }).ino));
  const before = readFileSync(path);
  assert.deepEqual(probeGate(identity), { available: true });
  assert.deepEqual(probeGate(identity), { available: true });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(directory), ['gate #%.sqlite']);
  assert.throws(() => initializeGate(path, identity.id), { code: 'GATE_EXISTS' });
});

gateTest('explicit setup can adopt a valid orphan without repairing unknown or incomplete gates', (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'setup');
  const before = readFileSync(identity.path);
  assert.deepEqual(inspectExistingGate(identity.path, identity.id), identity);
  assert.deepEqual(readFileSync(identity.path), before);
  assert.throws(() => inspectExistingGate(identity.path, 'unknown'), { code: 'GATE_INVALID_DATABASE' });
  const owner = tryAcquireExistingGate(identity).acquired;
  assert.throws(() => inspectExistingGate(identity.path, identity.id), { code: 'GATE_BUSY' });
  owner.release();
  writeFileSync(identity.path, '');
  assert.throws(() => inspectExistingGate(identity.path, identity.id), { code: 'GATE_INVALID_DATABASE' });
  assert.equal(readFileSync(identity.path).length, 0);
  const absent = join(directory, 'absent.sqlite');
  assert.throws(() => inspectExistingGate(absent, 'absent'), { code: 'GATE_STORAGE_ERROR' });
  assert.equal(existsSync(absent), false);
});

gateTest('two processes exclude each other while an independent gate remains available', async (t) => {
  const directory = setup(t);
  const workerGate = initializeGate(join(directory, 'worker.sqlite'), 'worker');
  const projectGate = initializeGate(join(directory, 'project.sqlite'), 'project');
  const worker = await hold(t, workerGate);
  assert.deepEqual(probeGate(workerGate), { busy: true });
  assert.deepEqual(probeGate(projectGate), { available: true });
  const released = once(worker, 'message');
  const exit = once(worker, 'exit');
  worker.send('release');
  assert.equal((await released)[0].type, 'released');
  await exit;
  assert.deepEqual(probeGate(workerGate), { available: true });
});

gateTest('same-process duplicates never release the original owner lock', async (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'local');
  const owner = tryAcquireExistingGate(identity).acquired;
  onCleanup(t, () => owner.release());
  assert.deepEqual(tryAcquireExistingGate({ ...identity }), { busy: true });
  assert.deepEqual(probeGate(identity), { busy: true });
  assert.throws(() => probeGate({ ...identity, id: 'wrong-local-id' }), { code: 'GATE_INVALID_DATABASE' });
  assert.deepEqual(await externalProbe(identity), { busy: true });
  owner.release();
  owner.release();
  assert.deepEqual(await externalProbe(identity), { available: true });
});

gateTest('holder death releases ownership without deleting or repairing the gate', async (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'worker.sqlite'), 'worker');
  const worker = await hold(t, identity);
  const before = readFileSync(identity.path);
  const exit = once(worker, 'exit');
  worker.kill('SIGKILL');
  await exit;
  assert.deepEqual(probeGate(identity), { available: true });
  assert.deepEqual(readFileSync(identity.path), before);
  assert.deepEqual(readdirSync(directory), ['worker.sqlite']);
});

gateTest('missing probes and acquisition create no files or directories', (t) => {
  const directory = setup(t);
  const identity = { path: join(directory, 'missing.sqlite'), id: 'missing', device: '1', inode: '1' };
  assert.throws(() => probeGate(identity), { code: 'GATE_STORAGE_ERROR' });
  assert.throws(() => tryAcquireExistingGate(identity), { code: 'GATE_STORAGE_ERROR' });
  assert.deepEqual(readdirSync(directory), []);
  identity.path = join(directory, 'absent', 'missing.sqlite');
  assert.throws(() => probeGate(identity), { code: 'GATE_STORAGE_ERROR' });
  assert.equal(existsSync(join(directory, 'absent')), false);
});

gateTest('a gate disappearing after inspection is not recreated by SQLite', (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'disappears');
  assert.throws(() => probeGate(identity, { guardPath(path, { kind }) {
    if (kind === 'file') rmSync(path);
  } }), { code: 'GATE_STORAGE_ERROR' });
  assert.deepEqual(readdirSync(directory), []);
});

gateTest('unexpected sidecars are preserved and rejected before SQLite recovery', (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'sidecar');
  const before = readFileSync(identity.path);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const path = `${identity.path}${suffix}`;
    writeFileSync(path, 'retained diagnostic artifact');
    assert.throws(() => probeGate(identity), { code: 'GATE_INVALID_DATABASE' });
    assert.equal(readFileSync(path, 'utf8'), 'retained diagnostic artifact');
    assert.deepEqual(readFileSync(identity.path), before);
    rmSync(path);
  }
  const absent = join(directory, 'absent.sqlite');
  writeFileSync(`${absent}-journal`, 'unexplained artifact');
  assert.throws(() => initializeGate(absent, 'absent'), { code: 'GATE_INVALID_DATABASE' });
  assert.equal(existsSync(absent), false);
});

gateTest('corruption, wrong markers, and replaced inodes are storage failures, never busy', (t) => {
  const directory = setup(t);
  const corrupt = initializeGate(join(directory, 'corrupt.sqlite'), 'corrupt');
  writeFileSync(corrupt.path, 'this is not sqlite');
  assert.throws(() => probeGate(corrupt), { code: 'GATE_STORAGE_ERROR' });
  const original = initializeGate(join(directory, 'original.sqlite'), 'original');
  assert.throws(() => probeGate({ ...original, id: 'different' }), { code: 'GATE_INVALID_DATABASE' });
  const replacement = initializeGate(join(directory, 'replacement.sqlite'), 'original');
  renameSync(original.path, join(directory, 'preserved.sqlite'));
  renameSync(replacement.path, original.path);
  assert.throws(() => probeGate(original), { code: 'GATE_REPLACED' });
  assert.equal(existsSync(join(directory, 'preserved.sqlite')), true);
});

gateTest('uninitialized, oversized, altered schema, and WAL databases fail closed', (t) => {
  const directory = setup(t);
  const empty = initializeGate(join(directory, 'empty.sqlite'), 'empty');
  writeFileSync(empty.path, '');
  assert.throws(() => probeGate(empty), { code: 'GATE_INVALID_DATABASE' });
  assert.deepEqual(readdirSync(directory), ['empty.sqlite']);
  const altered = initializeGate(join(directory, 'altered.sqlite'), 'altered');
  const db = new Database(altered.path);
  db.exec('CREATE TABLE product_data (payload TEXT)');
  db.close();
  assert.throws(() => probeGate(altered), { code: 'GATE_INVALID_DATABASE' });
  const wal = initializeGate(join(directory, 'wal.sqlite'), 'wal');
  const walDb = new Database(wal.path);
  walDb.exec('PRAGMA journal_mode = WAL');
  walDb.close();
  assert.throws(() => probeGate(wal), { code: 'GATE_INVALID_DATABASE' });
  const huge = initializeGate(join(directory, 'huge.sqlite'), 'huge');
  writeFileSync(huge.path, Buffer.alloc(65 * 1024));
  assert.throws(() => probeGate(huge), { code: 'GATE_INVALID_DATABASE' });
});

gateTest('gate hardlinks and linked parent directories are refused', (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'private');
  const alias = join(directory, 'alias.sqlite');
  linkSync(identity.path, alias);
  assert.throws(() => probeGate(identity), { code: 'GATE_UNSAFE_PATH' });
  rmSync(alias);
  const linkedDirectory = join(directory, 'linked');
  symlinkSync(directory, linkedDirectory, windows ? 'junction' : 'dir');
  assert.throws(() => probeGate({ ...identity, path: join(linkedDirectory, 'gate.sqlite') }), { code: 'GATE_UNSAFE_PATH' });
});

gateTest('file symbolic links are refused', t => {
  const directory = setup(t), identity = initializeGate(join(directory, 'gate.sqlite'), 'linked');
  const alias = join(directory, 'alias.sqlite');
  try { symlinkSync(identity.path, alias, 'file'); }
  catch (error) { if (windows && error.code === 'EPERM') { t.skip('Windows file symlink privilege is unavailable; junction and hardlink checks still execute.'); return; } throw error; }
  assert.throws(() => probeGate({ ...identity, path: alias }), { code: 'GATE_UNSAFE_PATH' });
});

test('POSIX public gate modes and insufficient owner access are refused', { skip: windows ? 'POSIX permission-bit primitive; the equivalent Windows DACL test executes separately.' : false }, t => {
  const directory = setup(t), identity = initializeGate(join(directory, 'gate.sqlite'), 'private');
  chmodSync(identity.path, 0o644);
  assert.throws(() => probeGate(identity), { code: 'GATE_UNSAFE_PATH' });
  chmodSync(identity.path, 0o600);
  chmodSync(identity.path, 0o400);
  assert.throws(() => probeGate(identity), { code: 'GATE_UNSAFE_PATH' });
  chmodSync(identity.path, 0o600);
  chmodSync(directory, 0o755);
  assert.throws(() => probeGate(identity), { code: 'GATE_UNSAFE_PATH' });
  chmodSync(directory, 0o700);
});

test('Windows public DACLs and insufficient current-user access are refused', { skip: !windows }, t => {
  const directory = setup(t), identity = initializeGate(join(directory, 'gate.sqlite'), 'private');
  changeWindowsAcl(identity.path, { publicRead: true });
  assert.throws(() => probeGate(identity), error => error.code === 'GATE_STORAGE_ERROR' && error.cause?.code === 'PRIVATE_ACCESS_UNSAFE'); establishWindowsPrivacy(identity.path);
  changeWindowsAcl(identity.path, { ownerRights: 'Read' });
  assert.throws(() => probeGate(identity), error => error.code === 'GATE_STORAGE_ERROR' && error.cause?.code === 'PRIVATE_ACCESS_UNSAFE'); changeWindowsAcl(identity.path);
  changeWindowsAcl(directory, { publicRead: true });
  assert.throws(() => probeGate(identity), error => error.code === 'GATE_STORAGE_ERROR' && error.cause?.code === 'PRIVATE_ACCESS_UNSAFE'); establishWindowsPrivacy(directory);
  assert.deepEqual(probeGate(identity), { available: true });
});

gateTest('guard verifier runs synchronously and failures preserve the gate', (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'guarded');
  const bytes = readFileSync(identity.path);
  assert.throws(() => probeGate(identity, { guardPath: () => false }), { code: 'GATE_UNSAFE_PATH' });
  assert.throws(() => probeGate(identity, { guardPath: () => Promise.resolve() }), { code: 'GATE_INVALID_GUARD' });
  assert.deepEqual(readFileSync(identity.path), bytes);
  assert.deepEqual(probeGate(identity), { available: true });
});

gateTest('short gates bound contention and abort without running the callback', async (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'bounded');
  await hold(t, identity);
  let called = false;
  await assert.rejects(withShortGate(identity, { timeoutMs: 30 }, () => { called = true; }), { code: 'GATE_BUSY' });
  await assert.rejects(withShortGate(identity, { timeoutMs: 1000, signal: AbortSignal.timeout(20) }, () => { called = true; }), { name: 'AbortError' });
  assert.equal(called, false);
});

gateTest('short gate retries a release, returns callback value, and releases after callback errors', async (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'short');
  const worker = await hold(t, identity);
  const exit = once(worker, 'exit');
  const timer = setTimeout(() => worker.send('release'), 30);
  onCleanup(t, () => clearTimeout(timer));
  assert.equal(await withShortGate(identity, { timeoutMs: 1000 }, () => 42), 42);
  await exit;
  await assert.rejects(withShortGate(identity, {}, () => { throw new Error('callback failed'); }), /callback failed/);
  assert.deepEqual(probeGate(identity), { available: true });
});

gateTest('replacement cannot evade ownership and release closes the original connection', (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'release');
  const owner = tryAcquireExistingGate(identity).acquired;
  onCleanup(t, () => owner.release());
  if (windows) {
    // The Win32 VFS denies deleting/renaming its live database handle. Exercise
    // that protection, then verify the retained descriptor detects replacement.
    assert.throws(() => renameSync(identity.path, join(directory, 'old.sqlite')), { code: 'EBUSY' });
    assert.deepEqual(probeGate(identity), { busy: true }); owner.release();
    renameSync(identity.path, join(directory, 'old.sqlite'));
    const replacement = initializeGate(identity.path, identity.id);
    assert.throws(() => probeGate(identity), { code: 'GATE_REPLACED' });
    assert.deepEqual(probeGate(replacement), { available: true });
    assert.deepEqual(probeGate({ ...identity, path: join(directory, 'old.sqlite') }), { available: true });
    return;
  }
  renameSync(identity.path, join(directory, 'old.sqlite'));
  copyFileSync(join(directory, 'old.sqlite'), identity.path);
  assert.throws(() => owner.release(), AggregateError);
  assert.deepEqual(probeGate({ ...identity, path: join(directory, 'old.sqlite') }), { available: true });
});

gateTest('worker thread acquisition is rejected before opening SQLite', async (t) => {
  const directory = setup(t);
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'thread');
  const module = new URL('../src/storage/gates.mjs', import.meta.url).href;
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); import(${JSON.stringify(module)}).then(({probeGate})=>{try{probeGate(workerData)}catch(error){parentPort.postMessage(error.code)}});`, { eval: true, workerData: identity });
  onCleanup(t, () => worker.terminate());
  assert.equal((await once(worker, 'message'))[0], 'GATE_UNSUPPORTED_CONTEXT');
  assert.deepEqual(probeGate(identity), { available: true });
});

test('Windows requires an explicit synchronous ACL verifier', { skip: !windows }, (t) => {
  const directory = setup(t);
  assert.throws(() => gates.initializeGate(join(directory, 'gate.sqlite'), 'windows'), { code: 'GATE_UNSUPPORTED_PLATFORM' });
  assert.deepEqual(readdirSync(directory), []);
});

test('Windows long paths keep private stages, two-process ownership and no-create recovery', { skip: !windows }, async t => {
  const directory = join(setup(t), 'x'.repeat(80), 'y'.repeat(80), 'z'.repeat(80));
  mkdirSync(directory, { recursive: true }); establishWindowsPrivacy(directory);
  const options = { guardPath: (file, { stat }) => assertPrivateAccess(file, stat), initializePath: establishWindowsPrivacy };
  const identity = initializeGate(join(directory, 'gate.sqlite'), 'windows-owner', options);
  assert.ok(identity.path.length > 260);
  const independent = initializeGate(join(directory, 'independent.sqlite'), 'windows-independent', options);
  const original = lstatSync(identity.path, { bigint: true });
  const owner = await hold(t, identity);
  assert.deepEqual(probeGate(identity, options), { busy: true });
  assert.deepEqual(await externalProbe(identity), { busy: true });
  assert.deepEqual(probeGate(independent, options), { available: true });
  const exited = once(owner, 'exit'); owner.kill(); await exited;
  assert.deepEqual(probeGate(identity, options), { available: true });
  assert.equal(lstatSync(identity.path, { bigint: true }).ino, original.ino);
  assert.equal(lstatSync(identity.path, { bigint: true }).size, original.size);
  renameSync(identity.path, `${identity.path}.saved`);
  const names = readdirSync(directory);
  assert.throws(() => tryAcquireExistingGate(identity, options), { code: 'GATE_STORAGE_ERROR' });
  assert.deepEqual(readdirSync(directory), names);
});


gateTest('short gate release failure preserves the original callback error', async t => {
  const directory = setup(t), identity = initializeGate(join(directory, 'gate.sqlite'), 'release-primary');
  let callbackFinished = false;
  const original = Object.assign(new Error('Primary callback failure'), { code: 'SYNTHETIC_PRIMARY' });
  await assert.rejects(withShortGate(identity, { guardPath() {
    if (callbackFinished) throw new Error('Synthetic release verification failure');
  } }, async () => { callbackFinished = true; throw original; }), error => error === original && error.releaseError instanceof AggregateError);
  assert.deepEqual(probeGate(identity), { available: true });
});

gateTest('short gate release failure after success has a distinct recovery code', async t => {
  const directory = setup(t), identity = initializeGate(join(directory, 'gate.sqlite'), 'release-success');
  let callbackFinished = false;
  await assert.rejects(withShortGate(identity, { guardPath() {
    if (callbackFinished) throw new Error('Synthetic release verification failure');
  } }, async () => { callbackFinished = true; return 'committed'; }), { code: 'GATE_RELEASE_FAILED' });
  assert.deepEqual(probeGate(identity), { available: true });
});


gateTest('setup recovery wraps native staging-cleanup failures in a storage code', async t => {
  const directory = setup(t), filename = join(directory, 'gate.sqlite');
  await crashInitialization(t, filename, 'published');
  const original = nativeFs.unlinkSync;
  const mocked = t.mock.method(nativeFs, 'unlinkSync', function(file, ...args) {
    if (String(file).endsWith('.tmp')) throw Object.assign(new Error('Synthetic native unlink denial'), { code: 'EPERM' });
    return original.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => inspectExistingGate(filename, 'crash-test'), { code: 'GATE_STORAGE_ERROR' }); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(lstatSync(filename).nlink, 2);
  assert.deepEqual(probeGate(inspectExistingGate(filename, 'crash-test')), { available: true });
});
