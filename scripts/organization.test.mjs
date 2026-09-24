import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { configSchema, captureSettings } from './capture-policy.mjs';
import { initialize, setupStatus } from './setup.mjs';
import { updateConfiguration } from './config-update.mjs';
import { fingerprint } from './safe-update.mjs';
import { completionPolicyHash, recordCompletion, completionStatus } from './capture-completion.mjs';
import { hookResponse } from './hooks.mjs';

async function fixture(t, overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-organization-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notesDir = path.join(root, 'notes');
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  for (const dir of [notesDir, project, other]) await fs.mkdir(dir);
  return { root, notesDir, project, other, cwd: project, stateDir: path.join(root, 'state'),
    client: 'codex', mode: 'suggest', scope: 'Synthetic findings.', organization: 'by-type',
    configPath: path.join(root, 'private/config.json'), proposal: path.join(root, 'proposal.json'),
    confirmCompatibleClients: true, ...overrides };
}
const load = async file => JSON.parse(await fs.readFile(file));
const payload = cwd => ({ cwd, session_id: 'session', turn_id: 'turn', prompt_id: 'turn', permission_mode: 'default' });
const schema4 = (f, organization) => ({ version: 4, minimumPluginVersion: '0.7.0', completionCheck: false,
  enabled: true, clients: ['codex', 'claude'], automaticUpdates: false, scope: f.scope,
  routes: [{ projectRoot: f.project, notesDir: f.notesDir, stateDir: f.stateDir,
    ...(organization !== undefined ? { organization } : {}) }] });

test('organization is schema-4 folder-only data and omitted organization means flat', async t => {
  const f = await fixture(t);
  for (const organization of [undefined, 'flat', 'by-type']) {
    const config = schema4(f, organization);
    configSchema(config);
    for (const client of config.clients) {
      assert.equal((await captureSettings(client, f.project, config)).organization, organization ?? 'flat');
      const { projectRoot, ...defaultRoute } = config.routes[0];
      assert.equal((await captureSettings(client, f.other, { ...config, routes: [], defaultRoute })).organization, organization ?? 'flat');
    }
  }
  const config = schema4(f, 'by-type');
  for (const organization of [null, false, {}, 'meeting', '', 'BY-TYPE']) {
    assert.throws(() => configSchema({ ...config, routes: [{ ...config.routes[0], organization }] }), /Invalid/);
  }
  for (const change of [{ completionCheck: undefined }, { completionCheck: 'false' }, { minimumPluginVersion: '0.6.0' }]) {
    assert.throws(() => configSchema({ ...config, ...change }), /Invalid/);
  }
  for (const version of [1, 2, 3]) {
    const legacy = { ...config, version, minimumPluginVersion: version === 3 ? '0.6.0' : '0.5.1' };
    if (version < 3) delete legacy.completionCheck;
    if (version === 1) delete legacy.minimumPluginVersion;
    assert.throws(() => configSchema(legacy), /Invalid/);
  }
  const { notesDir, ...fileRoute } = config.routes[0];
  fileRoute.destination = path.join(notesDir, 'selected.md');
  for (const organization of ['flat', 'by-type']) {
    assert.throws(() => configSchema({ ...config, routes: [{ ...fileRoute, organization }] }), /Invalid/);
  }
  delete fileRoute.organization;
  assert.equal(Object.hasOwn(await captureSettings('codex', f.project, { ...config, routes: [fileRoute] }), 'organization'), false);
});

test('new folder setup defaults to by-type, honors explicit layouts, and preserves consent without creating notes', async t => {
  for (const client of ['codex', 'claude']) for (const mode of ['suggest', 'automatic']) for (const organization of [undefined, 'flat', 'by-type']) for (const completionCheck of [false, true]) {
    const f = await fixture(t, { client, mode, organization, completionCheck });
    for (const confirmCompatibleClients of [undefined, false, 'yes']) {
      await assert.rejects(initialize({ ...f, confirmCompatibleClients }), { code: 'CLIENT_UPGRADE_REQUIRED' });
      await assert.rejects(fs.stat(path.dirname(f.configPath)), { code: 'ENOENT' });
    }
    await initialize(f);
    const config = await load(f.configPath);
    assert.equal(config.version, organization === 'flat' ? completionCheck ? 3 : 2 : 4);
    assert.equal(config.minimumPluginVersion, organization === 'flat' ? completionCheck ? '0.6.0' : '0.5.1' : '0.7.0');
    assert.equal(config.completionCheck, config.version === 2 ? undefined : completionCheck);
    assert.equal(config.routes[0].organization, organization === 'flat' ? undefined : 'by-type');
    const status = await setupStatus(f);
    assert.equal(status.organization, organization ?? 'by-type');
    assert.equal(status.mode, mode);
    assert.equal(status.notesDir, f.notesDir);
    assert.equal(status.stateDir, f.stateDir);
    assert.equal(status.completionCheck, completionCheck);
    assert.deepEqual(await fs.readdir(f.notesDir), []);
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
    assert.equal(await hookResponse(client, { ...payload(f.project), hook_event_name: 'Stop', stop_hook_active: false }, config), null);
    const context = (await hookResponse(client, { ...payload(f.project), hook_event_name: 'UserPromptSubmit' }, config)).hookSpecificOutput.additionalContext;
    const op = JSON.parse(context.split('\n\n').at(-1));
    assert.equal(op.organization, status.organization);
    assert.equal(op.automaticUpdates, mode === 'automatic');
  }
  const f = await fixture(t);
  for (const change of [{ mode: 'manual' }, { notesDir: undefined, destination: path.join(f.notesDir, 'topic.md') }, { organization: 'unknown' }]) {
    await assert.rejects(initialize({ ...f, ...change }), /Organization/);
  }
});

test('new setup defaults do not reinterpret or migrate existing flat policies', async t => {
  for (const client of ['codex', 'claude']) for (const version of [2, 3, 4]) {
    const f = await fixture(t, { client });
    const legacy = { ...schema4(f), version, minimumPluginVersion: version === 2 ? '0.5.1' : version === 3 ? '0.6.0' : '0.7.0' };
    if (version === 2) delete legacy.completionCheck;
    await fs.mkdir(path.dirname(f.configPath));
    await fs.writeFile(f.configPath, JSON.stringify(legacy));
    const before = await fingerprint(f.configPath);
    assert.equal((await setupStatus(f)).organization, 'flat');
    const context = (await hookResponse(client, { ...payload(f.project), hook_event_name: 'UserPromptSubmit' }, legacy)).hookSpecificOutput.additionalContext;
    assert.equal(JSON.parse(context.split('\n\n').at(-1)).organization, 'flat');
    assert.match(context, /directly in notesDir; no subfolders unless explicitly selected/);
    await assert.rejects(initialize(f), /already exists/);
    assert.equal(await fingerprint(f.configPath), before);
    const proposed = { ...legacy, scope: 'Updated synthetic subject scope.' };
    await fs.writeFile(f.proposal, JSON.stringify(proposed));
    await updateConfiguration({ ...f, expectedHash: before, confirmCompatibleClients: false });
    assert.deepEqual(await load(f.configPath), proposed);
    assert.equal((await setupStatus(f)).organization, 'flat');
    assert.deepEqual(await fs.readdir(f.notesDir), []);
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  }
});

test('reviewed upgrade preserves legacy settings and notes, and subsequent schema-4 edits need no renewed compatibility assertion', async t => {
  const f = await fixture(t);
  await initialize({ ...f, organization: undefined, completionCheck: true });
  const created = await load(f.configPath);
  const old = { ...created, version: 3, minimumPluginVersion: '0.6.0',
    routes: created.routes.map(({ organization, ...route }) => route) };
  await fs.writeFile(f.configPath, JSON.stringify(old));
  assert.equal((await setupStatus(f)).organization, 'flat');
  const note = path.join(f.notesDir, 'existing.md');
  await fs.writeFile(note, '# Existing\n\n## Decision\n\nPreserve this note.\n');
  const beforeNote = await fingerprint(note);
  const proposed = { ...old, version: 4, minimumPluginVersion: '0.7.0',
    routes: [{ ...old.routes[0], organization: 'by-type' }] };
  await fs.writeFile(f.proposal, JSON.stringify(proposed));
  const expectedHash = await fingerprint(f.configPath);
  await assert.rejects(updateConfiguration({ ...f, expectedHash, confirmCompatibleClients: false }), { code: 'CLIENT_UPGRADE_REQUIRED' });
  assert.equal(await fingerprint(f.configPath), expectedHash);
  await updateConfiguration({ ...f, expectedHash });
  assert.deepEqual(await load(f.configPath), proposed);
  assert.equal((await setupStatus(f)).completionCheck, true);
  await fs.writeFile(f.proposal, JSON.stringify({ ...proposed, scope: 'Updated synthetic scope.' }));
  await updateConfiguration({ ...f, expectedHash: await fingerprint(f.configPath), confirmCompatibleClients: false });
  assert.equal(await fingerprint(note), beforeNote);
  assert.deepEqual(await fs.readdir(f.notesDir), ['existing.md']);
  await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
});

test('overlapping folders require compatible organization in either order, including defaults and inactive routes', async t => {
  const f = await fixture(t);
  await initialize(f);
  const original = await load(f.configPath);
  const first = original.routes[0];
  const nested = path.join(f.notesDir, 'meetings');
  await fs.mkdir(nested);
  const alias = path.join(f.root, 'alias');
  await fs.symlink(f.notesDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await fingerprint(f.configPath);
  for (const folder of [f.notesDir, alias, nested, path.join(nested, 'offline')]) {
    for (const organization of [undefined, 'flat']) for (const variant of ['normal', 'reversed', 'disabled', 'excluded', 'default']) {
      const second = { projectRoot: f.other, notesDir: folder, stateDir: f.stateDir,
        ...(organization !== undefined ? { organization } : {}), ...(variant === 'disabled' ? { enabled: false } : {}) };
      const proposed = { ...original, routes: variant === 'reversed' ? [second, first] : [first, second],
        ...(variant === 'excluded' ? { exclude: [f.other] } : {}) };
      if (variant === 'default') {
        const { projectRoot, ...defaultRoute } = second;
        proposed.routes = [first]; proposed.defaultRoute = defaultRoute;
      }
      await fs.writeFile(f.proposal, JSON.stringify(proposed));
      await assert.rejects(updateConfiguration({ ...f, expectedHash: before }), /same organization/);
      assert.equal(await fingerprint(f.configPath), before);
      await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
    }
  }
  // Matching folders and explicit files may share the same writer state.
  const compatible = { ...original, routes: [first,
    { projectRoot: f.other, notesDir: nested, stateDir: f.stateDir, organization: 'by-type' }],
    defaultRoute: { destination: path.join(nested, 'selected.md'), stateDir: f.stateDir } };
  await fs.writeFile(f.proposal, JSON.stringify(compatible));
  await updateConfiguration({ ...f, expectedHash: before });
  assert.equal((await setupStatus({ ...f, cwd: f.other })).organization, 'by-type');
  // A user can still stop an unchanged conflicting configuration.
  compatible.routes[1].organization = 'flat';
  await fs.writeFile(f.configPath, JSON.stringify(compatible));
  await fs.writeFile(f.proposal, JSON.stringify({ ...compatible, enabled: false }));
  await updateConfiguration({ ...f, expectedHash: await fingerprint(f.configPath) });
  assert.equal((await setupStatus(f)).status, 'disabled');
});

test('flat fingerprints remain stable and changing to by-type invalidates prior completion for both clients', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, { client, completionCheck: true });
    await initialize(f);
    const typed = await load(f.configPath);
    const flat = { ...typed, routes: typed.routes.map(({ organization, ...route }) => route) };
    const legacy = { ...flat, version: 3, minimumPluginVersion: '0.6.0' };
    const oldSettings = await captureSettings(client, f.project, legacy);
    const flatSettings = await captureSettings(client, f.project, flat);
    const typedSettings = await captureSettings(client, f.project, typed);
    const beforeFields = [f.notesDir, null, f.stateDir, f.scope, false, 'default'];
    const expected = createHash('sha256').update(JSON.stringify(beforeFields)).digest('hex');
    assert.equal(completionPolicyHash(oldSettings, 'default'), expected);
    assert.equal(completionPolicyHash(flatSettings, 'default'), expected);
    assert.notEqual(completionPolicyHash(typedSettings, 'default'), expected);
    await fs.writeFile(f.configPath, JSON.stringify(flat));
    const input = { client, cwd: f.project, configPath: f.configPath, session_id: 'session',
      [client === 'codex' ? 'turn_id' : 'prompt_id']: 'turn', permissionMode: 'default', policyHash: expected, outcome: 'proposed' };
    await recordCompletion(input);
    const markerDir = path.join(f.stateDir, 'capture-completion');
    const marker = path.join(markerDir, (await fs.readdir(markerDir))[0]);
    const markerHash = await fingerprint(marker);
    await fs.writeFile(f.configPath, JSON.stringify(typed));
    await assert.rejects(recordCompletion(input));
    assert.equal(await fingerprint(marker), markerHash);
    assert.equal(await completionStatus(typedSettings, client, payload(f.project)), 'unverified');
    const stop = { ...payload(f.project), hook_event_name: 'Stop', stop_hook_active: false };
    assert.equal(await hookResponse(client, stop, typed), null);
    await recordCompletion({ ...input, policyHash: completionPolicyHash(typedSettings, 'default') });
    assert.equal(await hookResponse(client, stop, typed), null);
    const next = { ...stop, turn_id: 'next', prompt_id: 'next' };
    assert.equal((await hookResponse(client, next, typed)).decision, 'block');
    assert.equal(await hookResponse(client, { ...next, stop_hook_active: true }, typed), null);
  }
});
