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

test('all detached package variants support inspected type folders and root notes with shared state', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-types-package-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const withHooks of [false, true]) {
    const { packages } = await buildPackages({ outDir: path.join(root, withHooks ? 'hooks' : 'manual'), withHooks });
    for (const pkg of packages) {
      const work = path.join(root, `${pkg.client}-${withHooks}-Résumé notes`);
      const notesDir = path.join(work, 'notes');
      await fs.mkdir(notesDir, { recursive: true });
      const configPath = path.join(work, 'private', 'config.json');
      const env = { ...process.env, NODE_PATH: '', CUEFLUENT_NOTES_CONFIG: configPath };
      const run = (script, args, input, expected = 0) => {
        const result = spawnSync(process.execPath, [path.join(pkg.skillRoot, 'scripts', script), ...args],
          { cwd: work, env, input, encoding: 'utf8' });
        assert.equal(result.status, expected, result.stderr || result.stdout);
        return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
      };
      run('setup.mjs', ['init', '--client', pkg.client, '--mode', 'suggest', '--project', work,
        '--notes-dir', notesDir, '--organization', 'by-type', '--scope', 'Synthetic findings.', '--confirm-compatible-clients', 'yes']);
      const config = JSON.parse(await fs.readFile(configPath));
      assert.equal(config.version, 4);
      assert.equal(config.minimumPluginVersion, '0.7.0');
      assert.equal(config.completionCheck, false);
      const statusArgs = ['status', '--client', pkg.client, '--cwd', work];
      const status = run('setup.mjs', statusArgs);
      assert.equal(status.organization, 'by-type');
      assert.equal(status.mode, 'suggest');
      assert.equal(status.hookPackaged, withHooks);
      assert.equal(status.hostTrust, 'not_checked');
      assert.equal(status.notesDir, notesDir);
      if (withHooks) {
        const response = run('hooks.mjs', [pkg.client], JSON.stringify({ hook_event_name: 'UserPromptSubmit',
          cwd: work, session_id: 'synthetic', turn_id: 'turn', prompt_id: 'prompt' }));
        const op = JSON.parse(response.hookSpecificOutput.additionalContext.split('\n\n').at(-1));
        assert.equal(op.organization, 'by-type');
        assert.equal(op.stateDir, status.stateDir);
        assert.equal(op.automaticUpdates, false);
      } else await assert.rejects(fs.stat(path.join(pkg.root, 'hooks')), { code: 'ENOENT' });
      const names = ['overview.md', 'meetings/planning.md', 'tasks/windows.md', 'knowledge-base/cache.md', 'decisions/ttl.md'];
      const inspected = run('safe-update.mjs', ['inspect-directories', notesDir, ...names]);
      assert.deepEqual(inspected.createDirectories, ['meetings', 'tasks', 'knowledge-base', 'decisions']);
      assert.deepEqual(await fs.readdir(notesDir), []);
      await assert.rejects(fs.stat(status.stateDir), { code: 'ENOENT' });
      const files = [];
      for (const [index, name] of names.entries()) {
        const contentPath = path.join(work, `proposal-${index}.md`);
        await fs.writeFile(contentPath, `# Synthetic ${index}\n\n## Finding\n\nReviewed material ${index}.\n`);
        files.push({ path: name, contentPath, expectedHash: null });
      }
      const planPath = path.join(work, 'plan.json');
      const apply = async (snapshot, entries = files, expected = 0) => {
        await fs.writeFile(planPath, JSON.stringify({ version: 2, mode: 'authored', confirmCompatibleReaders: true, stateDir: status.stateDir,
          ...snapshot, files: entries }));
        return run('safe-update.mjs', ['apply', planPath], undefined, expected);
      };
      // A folder appearing after preview invalidates that proposal; never adopt it.
      await fs.mkdir(path.join(notesDir, 'meetings'));
      assert.match(await apply(inspected, files, 2), /directory changed/);
      assert.deepEqual(await fs.readdir(notesDir), ['meetings']);
      await assert.rejects(fs.stat(status.stateDir), { code: 'ENOENT' });
      // A newly inspected and separately approved proposal uses the observed parent.
      const approved = run('safe-update.mjs', ['inspect-directories', notesDir, ...names]);
      const saved = await apply(approved);
      assert.deepEqual(saved.updated, names);
      assert.deepEqual(saved.createdDirectories, ['decisions', 'knowledge-base', 'tasks']);
      for (const file of files) assert.deepEqual(await fs.readFile(path.join(notesDir, file.path)), await fs.readFile(file.contentPath));
      const current = run('safe-update.mjs', ['inspect-directories', notesDir, ...names]);
      assert.deepEqual(current.createDirectories, []);
      for (const file of files) file.expectedHash = run('safe-update.mjs', ['fingerprint', path.join(notesDir, file.path)]).files[0].hash;
      const before = await Promise.all(names.map(name => fs.stat(path.join(notesDir, name), { bigint: true })));
      assert.equal((await apply(current)).status, 'unchanged');
      for (const [index, file] of files.entries()) {
        assert.equal((await fs.stat(path.join(notesDir, file.path), { bigint: true })).mtimeNs, before[index].mtimeNs);
        assert.deepEqual(await fs.readFile(path.join(notesDir, file.path)), await fs.readFile(file.contentPath));
      }
      const meeting = files[1];
      await fs.appendFile(meeting.contentPath, '\nApproved clarification.\n');
      assert.deepEqual((await apply(current)).updated, [meeting.path]);
      const savedBytes = await fs.readFile(path.join(notesDir, meeting.path));
      assert.match(await apply(current, files, 2), /changed since inspection/);
      assert.deepEqual(await fs.readFile(path.join(notesDir, meeting.path)), savedBytes);
      assert.equal(run('safe-update.mjs', ['inspect', status.stateDir]).recoveryPending, false);
      assert.equal(run('setup.mjs', statusArgs).stateDir, status.stateDir);
      assert.equal(JSON.parse(await fs.readFile(configPath)).automaticUpdates, false);
    }
  }
});
