import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialize, setupStatus } from './setup.mjs';
import { captureSettings, configSchema } from './capture-policy.mjs';
import { updateConfiguration } from './config-update.mjs';
import { hookResponse } from './hooks.mjs';
import { fingerprint } from './safe-update.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-compatibility-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notesDir = path.join(root, 'notes');
  await fs.mkdir(notesDir);
  return { root, project: root, cwd: root, notesDir, client: 'claude', mode: 'suggest',
    scope: 'Synthetic decisions.', configPath: path.join(root, 'private/config.json'),
    proposal: path.join(root, 'proposal.json') };
}
const load = async file => JSON.parse(await fs.readFile(file));
const payload = cwd => ({ hook_event_name: 'UserPromptSubmit', cwd, session_id: 'session', turn_id: 'turn', prompt_id: 'prompt' });
const startup = cwd => ({ ...payload(cwd), hook_event_name: 'SessionStart', source: 'startup' });

test('first folder publication warns about unlisted older clients before creating any configuration', async t => {
  const f = await fixture(t);
  // Only Claude is selected. Codex installations must still be checked, since
  // 0.5.0 readers validate the whole shared policy before checking membership.
  for (const confirmCompatibleClients of [undefined, false, 'yes']) {
    await assert.rejects(initialize({ ...f, confirmCompatibleClients }), error =>
      error.code === 'CLIENT_UPGRADE_REQUIRED' && /including clients absent/.test(error.message));
  }
  assert.deepEqual(await fs.readdir(f.root), ['notes']);
  await initialize({ ...f, confirmCompatibleClients: true });
  const config = await load(f.configPath);
  assert.equal(config.version, 2);
  assert.equal(config.minimumPluginVersion, '0.5.1');
  assert.deepEqual(config.clients, ['claude']);
  assert.equal(await captureSettings('codex', f.cwd, config), null);
  assert.equal((await setupStatus({ ...f, client: 'codex' })).status, 'client_not_configured');
});

test('file policies stay version 1 and upgrading to folders requires a compatibility check', async t => {
  const f = await fixture(t);
  await initialize({ ...f, notesDir: undefined, destination: path.join(f.notesDir, 'topic.md') });
  const config = await load(f.configPath);
  assert.equal(config.version, 1);
  assert.equal(Object.hasOwn(config, 'minimumPluginVersion'), false);
  const expectedHash = await fingerprint(f.configPath);
  const { destination, ...route } = config.routes[0];
  const folder = { ...config, version: 2, minimumPluginVersion: '0.5.1', routes: [{ ...route, notesDir: f.notesDir }] };
  assert.throws(() => configSchema({ ...config, routes: folder.routes }), /Invalid capture configuration/);
  for (const minimumPluginVersion of [undefined, '0.5.0', 'invalid']) {
    assert.throws(() => configSchema({ ...folder, minimumPluginVersion }), /Invalid capture configuration/);
  }
  await fs.writeFile(f.proposal, JSON.stringify(folder));
  await assert.rejects(updateConfiguration({ ...f, expectedHash }), { code: 'CLIENT_UPGRADE_REQUIRED' });
  assert.equal(await fingerprint(f.configPath), expectedHash);
  assert.deepEqual(await fs.readdir(f.notesDir), []);
  await assert.rejects(fs.stat(route.stateDir), { code: 'ENOENT' });
  await updateConfiguration({ ...f, expectedHash, confirmCompatibleClients: true });
  assert.equal((await setupStatus(f)).status, 'configured');
  // Ordinary edits of an already checked schema don't demand confirmation again.
  await fs.writeFile(f.proposal, JSON.stringify({ ...folder, automaticUpdates: true }));
  await updateConfiguration({ ...f, expectedHash: await fingerprint(f.configPath) });
  assert.equal((await setupStatus(f)).mode, 'automatic');
});

test('unlisted clients ignore unfamiliar policy schema while listed clients receive an upgrade status', async t => {
  const f = await fixture(t);
  await initialize({ ...f, confirmCompatibleClients: true });
  const config = await load(f.configPath);
  for (const future of [
    { ...config, version: 3, futureOption: true },
    { ...config, minimumPluginVersion: '0.6.0', futureOption: true },
    { ...config, version: 999, routes: [{ futureRouteType: 'future' }] },
  ]) {
    await fs.writeFile(f.configPath, JSON.stringify(future));
    const expectedHash = await fingerprint(f.configPath);
    assert.equal((await setupStatus({ ...f, client: 'codex' })).status, 'client_not_configured');
    assert.equal(await hookResponse('codex', payload(f.cwd), future), null);
    assert.match((await hookResponse('codex', startup(f.cwd), future)).systemMessage, /capture is off in this client/);
    const status = await setupStatus(f);
    assert.equal(status.status, 'requires_upgrade');
    assert.match(status.reason, /newer Cuefluent Notes/);
    assert.match((await hookResponse('claude', payload(f.cwd), future)).hookSpecificOutput.additionalContext, /newer Cuefluent Notes/);
    assert.match((await hookResponse('claude', startup(f.cwd), future)).systemMessage, /newer Cuefluent Notes/);
    await fs.writeFile(f.proposal, JSON.stringify(config));
    await assert.rejects(updateConfiguration({ ...f, expectedHash, confirmCompatibleClients: true }), { code: 'CONFIG_REQUIRES_UPGRADE' });
    assert.equal(await fingerprint(f.configPath), expectedHash);
  }
});

test('readers validate applicable storage and all project selectors; writes still validate every route', async t => {
  const f = await fixture(t);
  await initialize({ ...f, confirmCompatibleClients: true });
  const config = await load(f.configPath);
  const unrelated = path.join(f.root, 'other');
  await fs.mkdir(unrelated);
  const scoped = { ...config, defaultRoute: { futureStorage: true },
    routes: [...config.routes, { projectRoot: unrelated, futureStorage: true }] };
  assert.equal((await captureSettings('claude', f.cwd, scoped)).notesDir, f.notesDir);
  await assert.rejects(captureSettings('claude', unrelated, scoped), /Invalid capture configuration/);
  assert.throws(() => configSchema(scoped), /Invalid capture configuration/);
  for (const route of [{ futureStorage: true }, { projectRoot: 'relative' },
    { projectRoot: unrelated, enabled: 'false' }]) {
    await assert.rejects(captureSettings('claude', f.cwd, { ...config, routes: [...config.routes, route] }), /Invalid capture configuration/);
  }
  for (const defaultRoute of [null, false, 0, { ...config.routes[0], enabled: false }]) {
    await assert.rejects(captureSettings('claude', f.cwd, { ...config, routes: [], defaultRoute }), /Invalid capture configuration/);
  }
  const expectedHash = await fingerprint(f.configPath);
  await fs.writeFile(f.proposal, JSON.stringify(scoped));
  await assert.rejects(updateConfiguration({ ...f, expectedHash }), /Invalid capture configuration/);
  assert.equal(await fingerprint(f.configPath), expectedHash);
});
