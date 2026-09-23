import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildPackages } from './package.mjs';
import { hookCommand } from './hook-definition.mjs';
import { resolveCommand } from './command.mjs';

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

test('shipped hooks run in native shells with literal plugin paths and UTF-8 input', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-shells-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const built = await buildPackages({ outDir: path.join(root, "packages café $HOME %PATH% & ' ` (test) !"), withHooks: true });
  const trap = path.join(root, 'skills/cuefluent-notes/scripts/hooks.mjs');
  await fs.mkdir(path.dirname(trap), { recursive: true });
  await fs.writeFile(trap, "console.log('UNSELECTED_WORKSPACE_SCRIPT_EXECUTED'); export function main(){return 0}");
  const shells = process.platform === 'win32'
    ? await windowsShells() : [['/bin/sh', ['-c'], 'POSIX sh']];
  for (const pkg of built.packages) for (const [shell, flags, name] of shells) await t.test(`${pkg.client}/${name}`, {
    skip: !shell && process.env.CUEFLUENT_REQUIRE_SHELLS !== '1' ? `${name} is not installed` : false,
  }, async () => {
    assert.ok(shell, `${name} is required for the CI shell matrix.`);
    const configPath = path.join(root, `${pkg.client}-absent.json`);
    const env = { ...process.env, PLUGIN_ROOT: pkg.root, CLAUDE_PLUGIN_ROOT: pkg.root, CUEFLUENT_NOTES_CONFIG: configPath };
    const cmd = shell === 'cmd.exe';
    const command = hookCommand(pkg.client);
    const invoke = (input, environment = env) => spawnSync(shell, [...flags, cmd ? `"${command}"` : command], {
      input: JSON.stringify(input), cwd: root, env: environment, encoding: 'utf8', timeout: 10000,
      windowsVerbatimArguments: cmd,
    });
    const payload = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'café-会議', cwd: root };
    const result = invoke(payload);
    assert.equal(result.status, 0, `${pkg.client}/${shell}: ${result.error ?? result.stderr}`);
    assert.match(JSON.parse(result.stdout).systemMessage, /Set up Cuefluent Notes/);
    const rootVariable = pkg.client === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
    const trailing = invoke(payload, { ...env, [rootVariable]: `${pkg.root}${path.sep}` });
    assert.equal(trailing.status, 0, trailing.stderr);
    assert.match(JSON.parse(trailing.stdout).systemMessage, /Set up Cuefluent Notes/);
    const invalidRoots = [undefined, '', '.', path.relative(root, pkg.root)];
    if (process.platform === 'win32') invalidRoots.push(root.slice(2), `${root.slice(0, 2)}relative`);
    for (const value of invalidRoots) {
      const missing = { ...env };
      if (value === undefined) delete missing[rootVariable];
      else missing[rootVariable] = value;
      const failed = invoke(payload, missing);
      assert.equal(failed.status, 1, `${pkg.client}/${shell}/${value}: ${failed.stdout} ${failed.stderr}`);
      assert.equal(failed.stdout, '');
      assert.match(failed.stderr, /hook could not start/);
      assert.ok(failed.stderr.length < 200);
      assert.match(failed.stderr, /INVALID_PLUGIN_ROOT/);
    }
    const absentModule = invoke(payload, { ...env, [rootVariable]: path.join(root, 'missing-private-package') });
    assert.equal(absentModule.status, 1);
    assert.match(absentModule.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.ok(!absentModule.stderr.includes('missing-private-package'));
    await assert.rejects(fs.stat(configPath), { code: 'ENOENT' });
    await fs.writeFile(configPath, JSON.stringify({ version: 1, enabled: true, clients: [pkg.client],
      automaticUpdates: false, scope: 'Synthetic shell verification.', defaultRoute: {
        destination: path.join(root, 'knowledge.md'), stateDir: path.join(root, 'state'),
      } }));
    const prompt = invoke({ ...payload, hook_event_name: 'UserPromptSubmit', turn_id: '会議', prompt_id: '会議' });
    assert.equal(prompt.status, 0, prompt.stderr);
    const operation = JSON.parse(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext.split('\n\n').at(-1));
    assert.equal(operation.session_id, payload.session_id);
    assert.equal(operation[pkg.client === 'codex' ? 'turn_id' : 'prompt_id'], '会議');
    await fs.unlink(configPath);
    await assert.rejects(fs.stat(path.join(root, 'knowledge.md')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, 'state')), { code: 'ENOENT' });
  });
});
