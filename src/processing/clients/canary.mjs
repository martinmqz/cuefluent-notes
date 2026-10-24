import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { requireClient } from './protocol.mjs';
import { lstatOrNull } from '../../storage/paths.mjs';
import { randomUUID } from 'node:crypto';

// No model chooses these programs. Arguments are literal synthetic paths only.
const fileProgram = `const fs=require('node:fs');const [operation,file]=process.argv.slice(1);
try{if(operation==='read')process.stdout.write(fs.readFileSync(file));else fs.writeFileSync(file,'SYNTHETIC',{flag:'wx'})}
catch(e){process.exitCode=['EPERM','EACCES','EROFS'].includes(e.code)?1:2}`;
const networkProgram = `const net=require('node:net');const socket=net.createConnection({host:'127.0.0.1',port:Number(process.argv[1])});
const timer=setTimeout(()=>{socket.destroy();process.exitCode=2},3000);
socket.once('error',e=>{clearTimeout(timer);process.exitCode=['EPERM','EACCES'].includes(e.code)?7:2});
socket.once('connect',()=>{clearTimeout(timer);socket.destroy()});`;

/** Paths enter only a quoted environment expansion. Delayed expansion is off;
 * no path bytes are interpolated into cmd source or a shell command argument. */
export function windowsCanaryCommand(systemRoot, operation, file) {
  requireClient(typeof systemRoot === 'string' && path.win32.isAbsolute(systemRoot) && typeof file === 'string' && path.win32.isAbsolute(file) && !/["\r\n\0]/.test(file));
  requireClient(['read', 'write'].includes(operation));
  return { command: [path.win32.join(systemRoot, 'System32', 'cmd.exe'), '/d', '/v:off', '/s', '/c', operation === 'read' ? 'type %CUEFLUENT_CANARY_FILE%' : 'echo CUEFLUENT_CANARY_WRITE > %CUEFLUENT_CANARY_FILE%'],
    env: { CUEFLUENT_CANARY_FILE: `"${file}"` } };
}

export function macosCanaryCommand(operation, file) {
  requireClient(typeof file === 'string' && path.posix.isAbsolute(file) && !/[\r\n\0]/.test(file));
  requireClient(['read', 'write'].includes(operation));
  // touch has one defined failure status and no /bin/sh implementation choice.
  return { command: [operation === 'read' ? '/bin/cat' : '/usr/bin/touch', file] };
}

export function networkCanaryCommand(platform, port, systemRoot) {
  requireClient(['darwin', 'win32', 'linux'].includes(platform) && Number.isInteger(port) && port > 0 && port <= 65535);
  if (platform === 'linux') return { command: [process.execPath, '--openssl-config=/dev/null', '-e', networkProgram, String(port)] };
  requireClient(platform !== 'win32' || typeof systemRoot === 'string' && path.win32.isAbsolute(systemRoot));
  // Disable curl config and every proxy so only this exact live local listener
  // can determine the result. A stale user proxy is not sandbox evidence.
  return { command: [platform === 'darwin' ? '/usr/bin/curl' : path.win32.join(systemRoot, 'System32', 'curl.exe'),
    '-q', '--noproxy', '*', '--connect-timeout', '2', '--max-time', '3', '-sS', `http://127.0.0.1:${port}/cuefluent-synthetic-canary`] };
}

async function verifyCommandSandbox(transport, cwd, outside, port, connected, permissionProfile) {
  const platform = process.platform, systemRoot = platform === 'win32' ? await realpath(process.env.SystemRoot) : undefined;
  const command = platform === 'darwin' ? macosCanaryCommand : platform === 'win32' ?
    (operation, file) => windowsCanaryCommand(systemRoot, operation, file) :
    (operation, file) => ({ command: [process.execPath, '--openssl-config=/dev/null', '-e', fileProgram, operation, file] });
  const suffix = randomUUID(), readable = path.join(cwd, `.cuefluent-readable & % ${suffix}.txt`);
  const writes = [path.join(cwd, `.cuefluent-denied & % ${suffix}.txt`), ...outside.map(file => path.join(path.dirname(file), 'denied & %.txt'))];
  const marker = 'CUEFLUENT_CANARY_READABLE'; await writeFile(readable, marker, { flag: 'wx' });
  const request = value => transport.request('command/exec', { ...value, cwd, permissionProfile, disableTimeout: true, outputBytesCap: 2048 });
  try {
    const probes = [{ command: command('read', readable), exitCode: 0, stdout: marker },
      ...outside.map(file => ({ command: command('read', file), exitCode: 1, stdout: '' })),
      ...writes.map(file => ({ command: command('write', file), exitCode: 1, stdout: '' })),
      { command: networkCanaryCommand(platform, port, systemRoot), exitCode: 7, stdout: '' }];
    // Independent probes run together; drain every request before removing any
    // canary, even when a peer rejects or the client dies.
    const results = await Promise.allSettled(probes.map(probe => request(probe.command)));
    for (let index = 0; index < results.length; index++) {
      const result = results[index]; if (result.status === 'rejected') throw result.reason;
      requireClient(result.value?.exitCode === probes[index].exitCode && result.value.stdout === probes[index].stdout);
    }
    for (const file of writes) requireClient(await lstatOrNull(file) === null);
    requireClient(!connected());
  } finally { await rm(readable, { force: true }); }
}

export async function verifySandbox(transport, cwd, permissionProfile = 'cuefluent_processing') {
  const directories = [], outside = []; let connected = false;
  const server = net.createServer(socket => { connected = true; socket.destroy(); });
  try {
    const roots = [await realpath(os.tmpdir())];
    // macOS admits /private/tmp implicitly unless explicitly denied. Test it
    // even when the process normally uses a per-user TMPDIR elsewhere.
    if (process.platform === 'darwin') roots.push(await realpath('/tmp'));
    for (const root of new Set(roots)) {
      const directory = await mkdtemp(path.join(root, 'cuefluent-processing-check-')); directories.push(directory);
      const file = path.join(directory, 'synthetic-readable.txt'); outside.push(file);
      await writeFile(file, 'SYNTHETIC CANARY', { mode: 0o600 });
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await verifyCommandSandbox(transport, cwd, outside, server.address().port, () => connected, permissionProfile);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  }
}
