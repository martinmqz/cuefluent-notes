import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { collectionHookBootstrap, collectionHookConfiguration } from './collection-hook-definition.mjs';
import { resolveCommand } from './command.mjs';
import { nativeContextEnvelope } from './workflow-context.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cuefluent-hook-会議 & ' $()-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'skills/cuefluent-notes/scripts'); await fs.mkdir(scripts, { recursive: true });
  const environment = { ...process.env, PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root,
    CUEFLUENT_WORKFLOW_CONFIG: path.join(root, 'absent-workflow.json') };
  const run = (client, input = '{}', options = {}) => spawnSync(process.execPath, ['-e', collectionHookBootstrap(client)],
    { env: environment, encoding: 'utf8', input, timeout: 4000, ...options });
  return { root, scripts, environment, run };
}

test('outer launcher normalizes import, parse, rejected main, and child exit 2 failures', async t => {
  const f = await fixture(t), script = path.join(f.scripts, 'collection-hooks.mjs');
  for (const client of ['codex', 'claude']) {
    await fs.rm(script, { force: true }); assert.equal(f.run(client).status, 0);
    await fs.writeFile(script, 'invalid JavaScript !!'); assert.equal(f.run(client).status, 0);
    await fs.writeFile(script, "export async function main(){throw new Error('private error text')}" );
    const failed = f.run(client); assert.equal(failed.status, 0); assert.equal(failed.stdout, ''); assert(!failed.stderr.includes('private error text'));
    await fs.writeFile(script, "import {spawn} from 'node:child_process'; export function main(){return new Promise(resolve=>{const p=spawn(process.execPath,['-e',\"console.error('child failed');process.exit(2)\"],{stdio:'ignore'});p.on('exit',resolve)})}");
    const child = f.run(client); assert.equal(child.status, 0); assert.equal(child.stdout, '');
  }
});

test('cold real ingress remains below three seconds and unconfigured hooks create no state', async t => {
  const f = await fixture(t);
  for (const name of await fs.readdir(here)) if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) await fs.copyFile(path.join(here, name), path.join(f.scripts, name));
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: '10000000-0000-4000-8000-000000000001',
    turn_id: '20000000-0000-4000-8000-000000000001', prompt_id: '20000000-0000-4000-8000-000000000001', cwd: f.root,
    transcript_path: path.join(f.root, 'must-not-open.jsonl'), prompt: 'Synthetic hook input' };
  const before = await fs.readdir(f.root);
  for (const client of ['codex', 'claude']) {
    const begin = performance.now(), result = f.run(client, JSON.stringify(payload)), elapsed = performance.now() - begin;
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert(elapsed < 3000, `${client} cold ingress took ${elapsed}ms`);
    t.diagnostic(`${process.platform}/${client} Node bootstrap + cold unconfigured ingress: ${Math.ceil(elapsed)}ms; native host transport not exercised.`);
    assert.equal(f.run(client, '{malformed').status, 0);
  }
  assert.deepEqual(await fs.readdir(f.root), before);
});

test('hook shapes retain native identity and reject child or missing identities', () => {
  const base = { session_id: '10000000-0000-4000-8000-000000000001', cwd: path.resolve('fixture'), transcript_path: path.resolve('fixture/session.jsonl') };
  for (const client of ['codex', 'claude']) {
    const config = collectionHookConfiguration(client), identity = { [client === 'codex' ? 'turn_id' : 'prompt_id']: '20000000-0000-4000-8000-000000000001' };
    assert.deepEqual(Object.keys(config.hooks), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', client === 'codex' ? 'Interrupt' : 'StopFailure']);
    for (const source of ['startup', 'resume', 'compact', 'clear']) assert.equal(nativeContextEnvelope(client, { ...base, hook_event_name: 'SessionStart', source }).unitId, null);
    const input = { ...base, ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Do not persist this prose' };
    assert(!JSON.stringify(nativeContextEnvelope(client, input)).includes('prose'));
    assert.throws(() => nativeContextEnvelope(client, { ...input, agent_id: 'child' }));
    assert.throws(() => nativeContextEnvelope(client, { ...base, hook_event_name: 'UserPromptSubmit' }));
    const handler = config.hooks.UserPromptSubmit[0].hooks[0];
    assert.equal(handler.timeout, 3);
    if (client === 'claude') { assert.equal(handler.command, 'node'); assert.equal(handler.args[0], '-e'); }
    else assert.match(handler.command, /^node -e "/);
  }
});

async function windowsShells() {
  let gitBash;
  try {
    let directory = path.dirname(resolveCommand('git'));
    for (let depth = 0; depth < 3 && !gitBash; depth++, directory = path.dirname(directory)) {
      const candidate = path.join(directory, 'bin/bash.exe');
      if ((await fs.stat(candidate).catch(() => null))?.isFile()) gitBash = candidate;
    }
  } catch { /* Report an explicit skip locally, or a missing required CI shell. */ }
  let pwsh;
  try { pwsh = resolveCommand('pwsh.exe'); } catch { /* Optional local PS7. */ }
  return [['cmd.exe', ['/d', '/s', '/c'], 'cmd.exe'],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command'], 'Windows PowerShell'],
    [pwsh, ['-NoProfile', '-NonInteractive', '-Command'], 'PowerShell 7'],
    [gitBash, ['--noprofile', '--norc', '-c'], 'Git Bash']];
}

test('replacement Codex bootstrap works through the native shell matrix', async t => {
  const f = await fixture(t), script = path.join(f.scripts, 'collection-hooks.mjs');
  await fs.writeFile(script, "export async function main(){process.stdout.write(JSON.stringify({verified:process.env.PLUGIN_ROOT}))}");
  const shells = process.platform === 'win32' ? await windowsShells() : [['/bin/sh', ['-c'], 'POSIX sh']];
  const command = collectionHookConfiguration('codex').hooks.UserPromptSubmit[0].hooks[0].command;
  for (const [shell, flags, name] of shells) await t.test(name, {
    skip: !shell && process.env.CUEFLUENT_REQUIRE_SHELLS !== '1' ? `${name} is not installed` : false,
  }, async () => {
    assert(shell, `${name} is required in CI`);
    const cmd = shell === 'cmd.exe';
    const result = spawnSync(shell, [...flags, cmd ? `"${command}"` : command], {
      env: f.environment, encoding: 'utf8', input: '{}', timeout: 4000, windowsVerbatimArguments: cmd,
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).verified, f.root);
    const absent = spawnSync(shell, [...flags, cmd ? `"${command}"` : command], {
      env: { ...f.environment, PLUGIN_ROOT: path.join(f.root, 'missing') }, encoding: 'utf8', input: '{}', timeout: 4000, windowsVerbatimArguments: cmd,
    });
    assert.equal(absent.status, 0, absent.stderr); assert.equal(absent.stdout, '');
  });
});
