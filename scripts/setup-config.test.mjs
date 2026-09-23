import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPackages } from './package.mjs';

test('setup reports command-only configuration overrides and hooks follow their own environment', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-config-selection-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { packages } = await buildPackages({ outDir: path.join(root, 'packages'), withHooks: true });
  const baseEnv = { ...process.env };
  delete baseEnv.CUEFLUENT_NOTES_CONFIG;
  for (const pkg of packages) {
    const setup = path.join(pkg.skillRoot, 'scripts/setup.mjs');
    const run = (args, env = baseEnv) => {
      const result = spawnSync(process.execPath, [setup, ...args], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const mismatch = result => {
      assert.equal(result.hookConfigMatches, false);
      assert.match(result.hookConfigIssue, /--config.*only.*command/);
      assert.match(result.hookConfigIssue, /host.*environment/);
    };
    for (const mode of ['manual', 'suggest', 'automatic']) {
      const configPath = path.join(root, `${pkg.client}-${mode}`, 'config.json');
      const destination = path.join(root, `${pkg.client}-${mode}.md`);
      const selected = ['--client', pkg.client, '--config', configPath];
      const created = run(['init', ...selected, '--mode', mode, ...(mode === 'manual' ? [] : [
        '--project', root, '--destination', destination, '--scope', 'Synthetic routing findings.',
      ])]);
      assert.equal(created.status, 'created');
      mismatch(created);
      assert.equal(created.hookConfigPath, path.join(os.homedir(), '.config/cuefluent-notes/config.json'));
      const statusArgs = ['status', ...selected, '--cwd', root];
      const before = run(statusArgs);
      mismatch(before);
      assert.equal(before.status, mode === 'manual' ? 'disabled' : 'configured');
      assert.equal(before.hookPackaged, true);

      const proposal = path.join(root, `${pkg.client}-${mode}-proposal.json`);
      const policy = JSON.parse(await fs.readFile(configPath));
      await fs.writeFile(proposal, JSON.stringify({ ...policy, scope: 'Updated synthetic routing findings.' }));
      const updateArgs = ['update', ...selected, '--cwd', root, '--proposal', proposal, '--expected-hash'];
      const updated = run([...updateArgs, before.configHash]);
      assert.equal(updated.status, 'updated');
      mismatch(updated);
      const unchanged = run([...updateArgs, updated.configHash]);
      assert.equal(unchanged.status, 'unchanged');
      mismatch(unchanged);

      const otherPath = path.join(root, `${pkg.client}-${mode}-other`, 'config.json');
      const otherEnv = { ...baseEnv, CUEFLUENT_NOTES_CONFIG: otherPath };
      const different = run(statusArgs, otherEnv);
      mismatch(different);
      assert.equal(different.hookConfigPath, otherPath);
      const matchedEnv = { ...baseEnv, CUEFLUENT_NOTES_CONFIG: configPath };
      for (const args of [statusArgs, ['status', '--client', pkg.client, '--cwd', root]]) {
        const matched = run(args, matchedEnv);
        assert.equal(matched.hookConfigMatches, true);
        assert.equal(matched.hookConfigPath, configPath);
        assert.equal(matched.hookConfigIssue, undefined);
        assert.equal(matched.status, before.status);
      }
      const matchedUpdate = run([...updateArgs, updated.configHash], matchedEnv);
      assert.equal(matchedUpdate.hookConfigMatches, true);
      assert.equal(matchedUpdate.hookConfigIssue, undefined);
      const invalidEnv = run(statusArgs, { ...baseEnv, CUEFLUENT_NOTES_CONFIG: 'relative.json' });
      assert.equal(invalidEnv.status, before.status);
      assert.equal(invalidEnv.hookConfigMatches, false);
      assert.equal(invalidEnv.hookConfigPath, null);
      assert.match(invalidEnv.hookConfigIssue, /absolute/);

      const bytes = await fs.readFile(configPath);
      const hooks = JSON.parse(await fs.readFile(path.join(pkg.root, 'hooks/hooks.json'))).hooks;
      const payload = { session_id: 'synthetic-session', turn_id: 'synthetic-turn', prompt_id: 'synthetic-prompt', cwd: root };
      const invoke = (event, env) => {
        const command = hooks[event][0].hooks[0].command;
        const result = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8',
          input: JSON.stringify({ ...payload, hook_event_name: event, ...(event === 'SessionStart' ? { source: 'startup' } : {}) }),
          env: { ...env, PLUGIN_ROOT: pkg.root, CLAUDE_PLUGIN_ROOT: pkg.root } });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      assert.match(invoke('SessionStart', otherEnv), /Set up Cuefluent Notes/);
      assert.equal(invoke('UserPromptSubmit', otherEnv), '');
      assert.equal(invoke('SessionStart', matchedEnv), '');
      const prompt = invoke('UserPromptSubmit', matchedEnv);
      if (mode === 'manual') assert.equal(prompt, '');
      else assert.ok(JSON.parse(prompt).hookSpecificOutput.additionalContext.includes(destination));
      assert.deepEqual(await fs.readFile(configPath), bytes);
      await assert.rejects(fs.stat(otherPath), { code: 'ENOENT' });
      await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
      if (policy.routes) await assert.rejects(fs.stat(policy.routes[0].stateDir), { code: 'ENOENT' });
    }
    const envOnlyPath = path.join(root, `${pkg.client}-environment`, 'config.json');
    const envOnly = run(['init', '--client', pkg.client, '--mode', 'manual'], {
      ...baseEnv, CUEFLUENT_NOTES_CONFIG: envOnlyPath,
    });
    assert.equal(envOnly.status, 'created');
    assert.equal(envOnly.hookConfigMatches, true);
    assert.equal(envOnly.hookConfigIssue, undefined);
  }
});
