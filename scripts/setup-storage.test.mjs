import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, setupStatus } from './setup.mjs';
import { buildPackages } from './package.mjs';

const script = fileURLToPath(new URL('./setup.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-setup-storage-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('status requires an explicit project instead of inferring the helper working directory', async t => {
  const root = await fixture(t);
  const configPath = path.join(root, 'private', 'config.json');
  await assert.rejects(setupStatus({ client: 'codex', configPath }), /explicit absolute project directory.*--cwd/);
  const result = spawnSync(process.execPath, [script, 'status', '--client', 'codex', '--config', configPath],
    { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /explicit absolute project directory.*--cwd/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('damaged packaged hooks do not hide the independently readable configuration status', async t => {
  const root = await fixture(t);
  const { packages } = await buildPackages({ outDir: path.join(root, 'packages'), withHooks: true });
  for (const pkg of packages) {
    const configPath = path.join(root, `private-${pkg.client}`, 'config.json');
    const setup = path.join(pkg.skillRoot, 'scripts', 'setup.mjs');
    const hooks = path.join(pkg.root, 'hooks', 'hooks.json');
    const run = () => {
      const result = spawnSync(process.execPath, [setup, 'status', '--client', pkg.client, '--cwd', root, '--config', configPath],
        { cwd: pkg.skillRoot, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    };
    assert.equal(run().hookPackaged, true);
    await fs.writeFile(hooks, '{"synthetic-private-detail":');
    const unconfigured = run();
    assert.equal(unconfigured.status, 'unconfigured');
    assert.equal(unconfigured.hookPackaged, false);
    assert.match(unconfigured.hookIssue, /Repair or reinstall/);
    assert.ok(unconfigured.hookIssue.length < 200);
    assert.ok(!unconfigured.hookIssue.includes('synthetic-private-detail'));
    await assert.rejects(fs.stat(path.dirname(configPath)), { code: 'ENOENT' });

    await initialize({ client: pkg.client, mode: 'manual', configPath });
    const before = await fs.readFile(configPath);
    await fs.unlink(hooks);
    await fs.mkdir(hooks);
    const disabled = run();
    assert.equal(disabled.status, 'disabled');
    assert.equal(disabled.hookPackaged, false);
    assert.equal(disabled.hookIssue, unconfigured.hookIssue);
    assert.deepEqual(await fs.readFile(configPath), before);
  }
});

test('status rejects stale and incomplete hook registrations in both client bundles', async t => {
  const root = await fixture(t);
  const { packages } = await buildPackages({ outDir: path.join(root, 'packages'), withHooks: true });
  const corruptions = [
    ['missing startup event', hooks => { delete hooks.SessionStart; }],
    ['empty startup event', hooks => { hooks.SessionStart = []; }],
    ['wrong startup matcher', hooks => { hooks.SessionStart[0].matcher = 'resume'; }],
    ['missing startup matcher', hooks => { delete hooks.SessionStart[0].matcher; }],
    ['empty startup handlers', hooks => { hooks.SessionStart[0].hooks = []; }],
    ['asynchronous startup handler', hooks => { hooks.SessionStart[0].hooks[0].async = true; }],
    ['missing prompt event', hooks => { delete hooks.UserPromptSubmit; }],
    ['empty prompt event', hooks => { hooks.UserPromptSubmit = []; }],
    ['empty prompt handlers', hooks => { hooks.UserPromptSubmit[0].hooks = []; }],
    ['missing command', hooks => { delete hooks.UserPromptSubmit[0].hooks[0].command; }],
    ['blank command', hooks => { hooks.UserPromptSubmit[0].hooks[0].command = '  '; }],
    ['invalid handler type', hooks => { hooks.UserPromptSubmit[0].hooks[0].type = 'invalid'; }],
    ...['SessionStart', 'UserPromptSubmit'].flatMap(event => [
      [`unrelated ${event} command`, hooks => { hooks[event][0].hooks[0].command = 'true'; }],
      [`wrong ${event} client`, (hooks, client) => {
        const handler = hooks[event][0].hooks[0];
        handler.command = handler.command.replace(/(?:codex|claude)$/, client === 'codex' ? 'claude' : 'codex');
      }],
      [`wrong ${event} script`, hooks => {
        const handler = hooks[event][0].hooks[0];
        handler.command = handler.command.replace('scripts/hooks.mjs', 'scripts/setup.mjs');
      }],
    ]),
  ];
  for (const pkg of packages) {
    const configPath = path.join(root, `private-${pkg.client}`, 'config.json');
    const setup = path.join(pkg.skillRoot, 'scripts', 'setup.mjs');
    const file = path.join(pkg.root, 'hooks', 'hooks.json');
    const original = JSON.parse(await fs.readFile(file));
    for (const [label, corrupt] of corruptions) {
      const proposed = structuredClone(original);
      corrupt(proposed.hooks, pkg.client);
      await fs.writeFile(file, JSON.stringify(proposed));
      const result = spawnSync(process.execPath, [setup, 'status', '--client', pkg.client, '--cwd', root, '--config', configPath],
        { cwd: pkg.skillRoot, encoding: 'utf8' });
      assert.equal(result.status, 0, `${pkg.client}: ${label}: ${result.stderr}`);
      const status = JSON.parse(result.stdout);
      assert.equal(status.status, 'unconfigured');
      assert.equal(status.hookPackaged, false, `${pkg.client}: ${label}`);
      assert.match(status.hookIssue, /Repair or reinstall/);
      await assert.rejects(fs.stat(path.dirname(configPath)), { code: 'ENOENT' });
    }
  }
});

test('unsupported hard-link publication fails without exposing a partial configuration', async t => {
  const root = await fixture(t);
  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']) {
    const configPath = path.join(root, code, 'config.json');
    const link = t.mock.method(fs, 'link', async () => {
      throw Object.assign(new Error('Synthetic filesystem failure containing private details.'), { code });
    });
    try {
      await assert.rejects(initialize({ client: 'codex', mode: 'manual', configPath }), error => {
        assert.match(error.message, /same-directory hard links/);
        assert.match(error.message, /filesystem support and permissions/);
        assert.ok(!error.message.includes('private details'));
        return true;
      });
      assert.equal(link.mock.callCount(), 1);
      assert.deepEqual(await fs.readdir(path.dirname(configPath)), []);
      assert.equal((await setupStatus({ client: 'codex', cwd: root, configPath })).status, 'unconfigured');
    } finally { link.mock.restore(); }
  }
});
