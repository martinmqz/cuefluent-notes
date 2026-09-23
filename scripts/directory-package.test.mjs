import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPackages } from './package.mjs';

test('both detached clients configure folder routes and save distinct subject files with one writer state', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-directory-package-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { packages } = await buildPackages({ outDir: path.join(root, 'packages'), withHooks: true });
  for (const pkg of packages) {
    const notesDir = path.join(root, `${pkg.client}-notes`);
    await fs.mkdir(notesDir);
    const configPath = path.join(root, `${pkg.client}-private/config.json`);
    const env = { ...process.env, CUEFLUENT_NOTES_CONFIG: configPath };
    const helper = (script, args, input) => {
      const result = spawnSync(process.execPath, [path.join(pkg.skillRoot, 'scripts', script), ...args],
        { cwd: root, env, input, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const init = ['init', '--client', pkg.client, '--mode', 'suggest', '--project', root,
      '--notes-dir', notesDir, '--scope', 'Synthetic project findings.'];
    const unconfirmed = spawnSync(process.execPath, [path.join(pkg.skillRoot, 'scripts/setup.mjs'), ...init], { cwd: root, env, encoding: 'utf8' });
    assert.equal(unconfirmed.status, 2);
    assert.match(unconfirmed.stderr, /including clients absent/);
    await assert.rejects(fs.stat(path.dirname(configPath)), { code: 'ENOENT' });
    helper('setup.mjs', [...init, '--confirm-compatible-clients', 'yes']);
    const config = JSON.parse(await fs.readFile(configPath));
    assert.equal(config.version, 2);
    assert.equal(config.minimumPluginVersion, '0.5.1');
    const status = helper('setup.mjs', ['status', '--client', pkg.client, '--cwd', root]);
    assert.equal(status.notesDir, notesDir);
    assert.equal(status.mode, 'suggest');
    assert.equal(status.hookPackaged, true);
    assert.equal(status.hookConfigMatches, true);
    assert.equal(Object.hasOwn(status, 'destination'), false);
    const response = helper('hooks.mjs', [pkg.client], JSON.stringify({ hook_event_name: 'UserPromptSubmit',
      cwd: root, session_id: 'session', turn_id: 'turn', prompt_id: 'prompt' }));
    const operation = JSON.parse(response.hookSpecificOutput.additionalContext.split('\n\n').at(-1));
    assert.equal(operation.notesDir, notesDir);
    assert.equal(operation.stateDir, status.stateDir);
    assert.equal(operation.automaticUpdates, false);
    assert.deepEqual(await fs.readdir(notesDir), []);
    await assert.rejects(fs.stat(status.stateDir), { code: 'ENOENT' });

    // Simulate approved authored saves through the packaged writer, not hook autosave.
    for (const [filename, heading, body] of [
      ['orchid-release-1.0.md', 'Release 1.0', 'The fictional release passed its checks.'],
      ['cache-expiry-decisions.md', 'Cache expiry decisions', 'The prototype uses a 30-minute TTL.'],
    ]) {
      const contentPath = path.join(root, `${pkg.client}-${filename}`);
      const content = `# Orchid\n\n## ${heading}\n\n${body}\n`;
      await fs.writeFile(contentPath, content);
      const planPath = path.join(root, `${pkg.client}-plan.json`);
      await fs.writeFile(planPath, JSON.stringify({ version: 1, mode: 'authored', root: operation.notesDir,
        stateDir: operation.stateDir, files: [{ path: filename, contentPath, expectedHash: null }] }));
      assert.deepEqual(helper('safe-update.mjs', ['apply', planPath]).updated, [filename]);
      assert.equal(await fs.readFile(path.join(notesDir, filename), 'utf8'), content);
    }
    assert.deepEqual(await fs.readdir(notesDir), ['cache-expiry-decisions.md', 'orchid-release-1.0.md']);
    assert.equal(helper('safe-update.mjs', ['inspect', operation.stateDir]).recoveryPending, false);
    assert.equal(helper('setup.mjs', ['status', '--client', pkg.client, '--cwd', root]).mode, 'suggest');
  }
});
