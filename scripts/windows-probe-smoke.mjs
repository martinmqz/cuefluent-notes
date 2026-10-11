// CI-only native diagnostic. Inputs and output are limited to our disposable
// directory; no user profile, selected session, configuration or note is read.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ACL_PROBE, probeEnvironment, windowsTools, privacyIdentity, protectNewDirectory, validateWindowsACL } from './storage-platform.mjs';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('WINDOWS_CI_REQUIRED');

const stages = [
  ['$paths=ConvertFrom-Json', 'json'], ['$attributes=[IO.File]', 'attributes'],
  ['$acl=if(', 'acl'], ['$raw=[Security.AccessControl.RawSecurityDescriptor]', 'descriptor'],
  ['$drive=[IO.DriveInfo]', 'drive'], ['$aces=@(', 'aces'],
  ['@{path=$p;', 'result'], ['ConvertTo-Json -Depth', 'serialize'],
];
let traced = "[Console]::Error.WriteLine('probe:startup');" + ACL_PROBE;
for (const [statement, stage] of stages) {
  if (!traced.includes(statement)) throw new Error('PROBE_TRACE_CHANGED');
  traced = traced.replace(statement, `[Console]::Error.WriteLine('probe:${stage}'); ${statement}`);
}

async function run(label, script, env) {
  const start = performance.now();
  return new Promise(resolve => {
    const child = spawn(windowsTools().powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
      { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, failure = null;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 64 * 1024) { failure = 'output-limit'; child.kill(); return; }
        if (kind === 'stdout') stdout += chunk; else stderr += chunk;
      });
    }
    child.on('error', error => { failure = error.code ?? 'spawn-error'; });
    child.on('close', code => {
      clearTimeout(timer);
      const result = { label, code, timedOut, failure, milliseconds: Math.round(performance.now() - start), stdout, stderr };
      console.log(JSON.stringify(result)); resolve(result);
    });
  });
}

let root;
try {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-probe-smoke-'));
  root = await fs.realpath(root);
  const identity = await privacyIdentity(); await protectNewDirectory(root, identity);
  const env = probeEnvironment(JSON.stringify([root]));
  const startup = await run('native-startup', "[Console]::Out.WriteLine('ready')", env);
  const query = await run('native-acl', traced, env);
  let valid = false;
  try {
    const rows = JSON.parse(query.stdout);
    if (Array.isArray(rows) && rows.length === 1 && rows[0].path === root) {
      validateWindowsACL(rows[0], identity, { directory: true, root: true }); valid = true;
    }
  } catch {}
  if (startup.code !== 0 || startup.timedOut || startup.failure || startup.stdout.trim() !== 'ready' ||
      query.code !== 0 || query.timedOut || query.failure || !valid) {
    throw new Error('WINDOWS_PRIVACY_PROBE_SMOKE_FAILED');
  }
} finally { if (root) await fs.rm(root, { recursive: true, force: true }); }
