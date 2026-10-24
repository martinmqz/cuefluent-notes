import { mkdtemp, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { requireClient } from './protocol.mjs';
import { randomUUID } from 'node:crypto';

// No model chooses this program. Only disposable synthetic data is touched.
const program = `const fs=require('node:fs'),net=require('node:net');
const [outside,inside,writeOutside,port]=process.argv.slice(1);const blocked=fn=>{try{fn();return false}catch(e){return ['EPERM','EACCES','EROFS'].includes(e.code)}};
const result={read:blocked(()=>fs.readFileSync(outside)),write:blocked(()=>fs.writeFileSync(inside,'synthetic')),outsideWrite:blocked(()=>fs.writeFileSync(writeOutside,'synthetic'))};
const socket=net.createConnection({host:'127.0.0.1',port:Number(port)});socket.once('error',e=>{result.network=['EPERM','EACCES'].includes(e.code);console.log(JSON.stringify(result))});socket.once('connect',()=>{result.network=false;socket.destroy();console.log(JSON.stringify(result))});`;

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
  return operation === 'read' ? { command: ['/bin/cat', file] } : {
    command: ['/bin/sh', '-c', 'printf %s CUEFLUENT_CANARY_WRITE > "$CUEFLUENT_CANARY_FILE"'],
    env: { CUEFLUENT_CANARY_FILE: file },
  };
}

async function verifyMacosSandbox(transport, cwd, outside, directory, port, connected, permissionProfile) {
  // System tools do not need Homebrew Node's shared libraries. Keep the same
  // permission profile: a crashing probe is never evidence of denied access.
  const suffix = randomUUID(), readable = path.join(cwd, `.cuefluent-readable ${suffix}.txt`);
  const marker = 'CUEFLUENT_CANARY_READABLE'; await writeFile(readable, marker, { flag: 'wx' });
  const request = command => transport.request('command/exec', { ...command, cwd, permissionProfile, disableTimeout: true, outputBytesCap: 2048 });
  try {
    const allowed = await request(macosCanaryCommand('read', readable));
    requireClient(allowed?.exitCode === 0 && allowed.stdout === marker);
    const denied = await request(macosCanaryCommand('read', outside));
    requireClient(denied?.exitCode === 1 && denied.stdout === '');
    for (const target of [path.join(cwd, '.cuefluent-denied'), path.join(directory, 'write.txt')]) {
      const result = await request(macosCanaryCommand('write', target));
      requireClient(result?.exitCode === 1 && result.stdout === '');
      let absent = false; try { await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; } requireClient(absent);
    }
    // -q suppresses user curl configuration; no proxy may substitute a failed
    // remote connection for the exact local listener being tested.
    const network = await request({ command: ['/usr/bin/curl', '-q', '--noproxy', '*', '--connect-timeout', '2', '--max-time', '3', '-sS', `http://127.0.0.1:${port}/cuefluent-synthetic-canary`] });
    requireClient(network?.exitCode === 7 && network.stdout === '' && !connected());
  } finally { await rm(readable, { force: true }); }
}

async function verifyWindowsSandbox(transport, cwd, outside, directory, port, connected, permissionProfile) {
  const systemRoot = await realpath(process.env.SystemRoot), suffix = randomUUID();
  const readable = path.join(cwd, `.cuefluent-readable & % ${suffix}.txt`), write = path.join(cwd, `.cuefluent-denied & % ${suffix}.txt`), outsideWrite = path.join(directory, 'denied & %.txt');
  const marker = 'CUEFLUENT_CANARY_READABLE'; await writeFile(readable, marker, { flag: 'wx' });
  const request = command => transport.request('command/exec', { ...command, cwd, permissionProfile, disableTimeout: true, outputBytesCap: 2048 });
  try {
    const allowed = await request(windowsCanaryCommand(systemRoot, 'read', readable));
    requireClient(allowed?.exitCode === 0 && allowed.stdout === marker);
    const denied = await request(windowsCanaryCommand(systemRoot, 'read', outside));
    requireClient(denied?.exitCode === 1 && denied.stdout === '');
    for (const target of [write, outsideWrite]) {
      const result = await request(windowsCanaryCommand(systemRoot, 'write', target));
      requireClient(result?.exitCode === 1 && result.stdout === '');
      let absent = false; try { await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; } requireClient(absent);
    }
    // Native curl works under MXC on hosts where Node/PowerShell DLL startup is
    // unavailable. The listener is live; offline MXC must refuse its connection.
    const network = await request({ command: [path.join(systemRoot, 'System32', 'curl.exe'), '--connect-timeout', '2', '--max-time', '3', '-sS', `http://127.0.0.1:${port}/cuefluent-synthetic-canary`] });
    requireClient(network?.exitCode === 7 && network.stdout === '' && !connected());
  } finally { await rm(readable, { force: true }); }
}

export async function verifySandbox(transport, cwd, permissionProfile = 'cuefluent_processing') {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cuefluent-processing-check-')), directory = await realpath(temporary);
  const outside = path.join(directory, 'synthetic-readable.txt'); await writeFile(outside, 'SYNTHETIC CANARY', { mode: 0o600 });
  let connected = false;
  const server = net.createServer(socket => { connected = true; socket.destroy(); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (process.platform === 'win32') return await verifyWindowsSandbox(transport, cwd, outside, directory, server.address().port, () => connected, permissionProfile);
    if (process.platform === 'darwin') return await verifyMacosSandbox(transport, cwd, outside, directory, server.address().port, () => connected, permissionProfile);
    const result = await transport.request('command/exec', { command: [process.execPath, '--openssl-config=/dev/null', '-e', program, outside, path.join(cwd, '.cuefluent-canary'), path.join(directory, 'write.txt'), String(server.address().port)], cwd, permissionProfile, disableTimeout: true, outputBytesCap: 2048 });
    requireClient(result?.exitCode === 0);
    let value; try { value = JSON.parse(result.stdout); } catch { requireClient(false); }
    requireClient(!connected && value.read === true && value.write === true && value.outsideWrite === true && value.network === true);
  } finally {
    await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true });
  }
}
