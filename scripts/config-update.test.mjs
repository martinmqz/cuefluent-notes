import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { initialize, setupStatus } from './setup.mjs';
import { updateConfiguration } from './config-update.mjs';
import { hookConfigurationSelection } from './capture-policy.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function snapshot(file) {
  const bytes = await fs.readFile(file);
  return { bytes, expectedHash: hash(bytes), config: JSON.parse(bytes) };
}
async function fixture(t, { mode = 'suggest', configName = 'config.json' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-config-update-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'alpha');
  const secondProject = path.join(root, 'beta');
  const notes = path.join(root, 'notes');
  const excluded = path.join(root, 'excluded');
  for (const directory of [project, secondProject, notes, excluded]) await fs.mkdir(directory);
  const configPath = path.join(root, 'private', configName);
  const destination = path.join(notes, 'alpha.md');
  await initialize({ client: 'codex', mode, configPath, ...(mode === 'manual' ? {} : {
    project, destination, scope: 'Synthetic project findings only.',
  }) });
  return { root, project, secondProject, notes, excluded, configPath, destination };
}
async function writeProposal(f, config, name = 'proposal.json') {
  const proposal = path.join(f.root, name);
  await fs.writeFile(proposal, `${JSON.stringify(config, null, 2)}\n`);
  return proposal;
}
test('configuration updates and hook selection recognize actual case aliases', async t => {
  const f = await fixture(t);
  const alias = path.join(path.dirname(f.configPath), 'CONFIG.json');
  const exists = await fs.stat(alias).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!exists) { t.skip('Selected volume is case-sensitive.'); return; }
  const previous = process.env.CUEFLUENT_NOTES_CONFIG;
  process.env.CUEFLUENT_NOTES_CONFIG = f.configPath;
  t.after(() => { if (previous === undefined) delete process.env.CUEFLUENT_NOTES_CONFIG; else process.env.CUEFLUENT_NOTES_CONFIG = previous; });
  assert.equal((await hookConfigurationSelection(alias)).hookConfigMatches, true);
  assert.equal((await hookConfigurationSelection(path.join(f.root, 'different.json'))).hookConfigMatches, false);
  const before = await snapshot(f.configPath);
  const next = { ...before.config, scope: 'Updated synthetic scope.' };
  const result = await updateConfiguration({ client: 'codex', cwd: f.project, configPath: alias,
    proposal: await writeProposal(f, next), expectedHash: before.expectedHash });
  assert.equal(result.configPath, f.configPath);
  assert.equal(result.hookConfigMatches, true);
  assert.deepEqual((await snapshot(f.configPath)).config, next);
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['config.json']);
});

test('reviewed updates add a project and client while preserving exclusions, routes, and suggestions', async t => {
  const f = await fixture(t);
  const initial = await snapshot(f.configPath);
  initial.config.exclude = [f.excluded];
  await fs.writeFile(f.configPath, JSON.stringify(initial.config));
  await fs.writeFile(f.destination, '# Existing knowledge\n\n## User edit\n\nKeep this synthetic finding.\n');
  const noteBytes = await fs.readFile(f.destination);
  const noteStat = await fs.stat(f.destination, { bigint: true });
  const before = await snapshot(f.configPath);
  const expanded = { ...before.config, routes: [...before.config.routes, {
    projectRoot: f.secondProject, destination: path.join(f.notes, 'beta.md'), stateDir: before.config.routes[0].stateDir,
  }] };
  await updateConfiguration({ client: 'codex', cwd: f.secondProject, configPath: f.configPath,
    proposal: await writeProposal(f, expanded), expectedHash: before.expectedHash });
  const afterProject = await snapshot(f.configPath);
  assert.deepEqual(afterProject.config, expanded);
  assert.equal((await fs.stat(f.configPath)).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);

  const bothClients = { ...afterProject.config, clients: ['codex', 'claude'] };
  await updateConfiguration({ client: 'claude', cwd: f.secondProject, configPath: f.configPath,
    proposal: await writeProposal(f, bothClients), expectedHash: afterProject.expectedHash });
  assert.deepEqual((await snapshot(f.configPath)).config, bothClients);
  for (const client of bothClients.clients) {
    for (const cwd of [f.project, f.secondProject]) {
      const status = await setupStatus({ client, cwd, configPath: f.configPath });
      assert.equal(status.status, 'configured');
      assert.equal(status.mode, 'suggest');
    }
    assert.equal((await setupStatus({ client, cwd: f.excluded, configPath: f.configPath })).status, 'inactive');
  }
  assert.deepEqual(await fs.readFile(f.destination), noteBytes);
  assert.equal((await fs.stat(f.destination, { bigint: true })).mtimeNs, noteStat.mtimeNs);
  assert.deepEqual(await fs.readdir(f.notes), ['alpha.md']);
  await assert.rejects(fs.stat(before.config.routes[0].stateDir), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['config.json']);
});

test('stale proposals are preserved and only one concurrent update can win the inspected hash', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.configPath);
  const first = { ...before.config, scope: 'First synthetic scope.' };
  const second = { ...before.config, scope: 'Second synthetic scope.' };
  const firstProposal = await writeProposal(f, first, 'first.json');
  const secondProposal = await writeProposal(f, second, 'second.json');
  const args = { client: 'codex', cwd: f.project, configPath: f.configPath, expectedHash: before.expectedHash };
  const results = await Promise.allSettled([
    updateConfiguration({ ...args, proposal: firstProposal }),
    updateConfiguration({ ...args, proposal: secondProposal }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const winner = await snapshot(f.configPath);
  assert.ok([first.scope, second.scope].includes(winner.config.scope));
  const staleProposal = winner.config.scope === first.scope ? secondProposal : firstProposal;
  const proposedBytes = await fs.readFile(staleProposal);
  await assert.rejects(updateConfiguration({ ...args, proposal: staleProposal }));
  assert.deepEqual(await fs.readFile(f.configPath), winner.bytes);
  assert.deepEqual(await fs.readFile(staleProposal), proposedBytes);
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['config.json']);
  assert.deepEqual(await fs.readdir(f.notes), []);
});

test('new copies of existing routes are rejected even when updating outside their projects', async t => {
  const f = await fixture(t);
  const base = (await snapshot(f.configPath)).config;
  const original = base.routes[0];
  const second = { ...original, projectRoot: f.secondProject, destination: path.join(f.notes, 'beta.md') };
  const alias = path.join(f.root, 'alpha-alias');
  await fs.symlink(f.project, alias, 'dir');
  const note = '# Synthetic knowledge\n\n## Existing decision\n\nPreserve this finding.\n';
  await fs.writeFile(f.destination, note);
  for (const variant of ['active', 'disabled route', 'excluded project', 'disabled policy']) {
    const first = variant === 'disabled route' ? { ...original, enabled: false } : original;
    const config = { ...base, enabled: variant !== 'disabled policy',
      exclude: variant === 'excluded project' ? [f.project] : [], routes: [first, second] };
    await fs.writeFile(f.configPath, JSON.stringify(config));
    const before = await snapshot(f.configPath);
    const stat = await fs.stat(f.configPath, { bigint: true });
    for (const routes of [
      [first, second, structuredClone(first)],
      [structuredClone(first), second, first],
      [second, first, structuredClone(first), structuredClone(first)],
      [first, second, { ...first, projectRoot: alias }],
    ]) {
      const proposal = await writeProposal(f, { ...config, routes });
      const proposalBytes = await fs.readFile(proposal);
      await assert.rejects(updateConfiguration({ client: 'codex', cwd: f.root,
        configPath: f.configPath, expectedHash: before.expectedHash, proposal }), { code: 'AMBIGUOUS_ROUTE' });
      assert.deepEqual(await fs.readFile(f.configPath), before.bytes);
      assert.equal((await fs.stat(f.configPath, { bigint: true })).mtimeNs, stat.mtimeNs);
      assert.deepEqual(await fs.readFile(proposal), proposalBytes);
      assert.equal(await fs.readFile(f.destination, 'utf8'), note);
      assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['config.json']);
    }
  }
  await assert.rejects(fs.stat(original.stateDir), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.notes), ['alpha.md']);
});

test('route reordering and duplicate removal preserve retained unavailable routes', async t => {
  const f = await fixture(t);
  const base = (await snapshot(f.configPath)).config;
  const original = base.routes[0];
  const offline = { projectRoot: path.join(f.root, 'offline-project'),
    destination: path.join(f.root, 'offline-notes', 'note.md'), stateDir: path.join(f.root, 'offline-state') };
  const config = { ...base, routes: [original, offline] };
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const before = await snapshot(f.configPath);
  const reordered = { ...config, routes: [offline, original] };
  const update = (desired, expectedHash) => writeProposal(f, desired).then(proposal => updateConfiguration({
    client: 'codex', cwd: f.root, configPath: f.configPath, expectedHash, proposal,
  }));
  assert.equal((await update(reordered, before.expectedHash)).status, 'updated');
  assert.deepEqual((await snapshot(f.configPath)).config, reordered);

  // An explicit repair may remove copies without revalidating unchanged offline routes.
  await fs.writeFile(f.configPath, JSON.stringify({ ...config, routes: [original, original, offline] }));
  const duplicated = await snapshot(f.configPath);
  assert.equal((await update(reordered, duplicated.expectedHash)).status, 'updated');
  assert.deepEqual((await snapshot(f.configPath)).config, reordered);
  assert.equal((await setupStatus({ client: 'codex', cwd: f.project, configPath: f.configPath })).status, 'configured');
  assert.deepEqual(await fs.readdir(f.notes), []);
  await assert.rejects(fs.stat(original.stateDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(offline.stateDir), { code: 'ENOENT' });
});

test('invalid complete proposals preserve the inspected policy and do not create notes or state', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.configPath);
  const malformed = path.join(f.root, 'malformed.json');
  await fs.writeFile(malformed, '{"broken":');
  const proposals = [malformed];
  for (const [index, config] of [null, { enabled: false }, { ...before.config, unknown: true }].entries()) {
    proposals.push(await writeProposal(f, config, `invalid-${index}.json`));
  }
  for (const proposal of proposals) {
    await assert.rejects(updateConfiguration({ client: 'codex', cwd: f.project, configPath: f.configPath,
      expectedHash: before.expectedHash, proposal }));
    assert.deepEqual(await fs.readFile(f.configPath), before.bytes);
  }
  assert.deepEqual(await fs.readdir(f.notes), []);
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['config.json']);
  await assert.rejects(fs.stat(before.config.routes[0].stateDir), { code: 'ENOENT' });
});

test('new route storage is validated before replacing the policy', async t => {
  const f = await fixture(t, { configName: 'policy.md' });
  const before = await snapshot(f.configPath);
  const linkedState = path.join(f.root, 'linked-state');
  await fs.mkdir(linkedState);
  const stateAlias = path.join(f.root, 'state-alias');
  await fs.symlink(linkedState, stateAlias, 'dir');
  const noteAlias = path.join(f.notes, 'linked.md');
  await fs.symlink(f.configPath, noteAlias);
  const validRoute = { ...before.config.routes[0], projectRoot: f.secondProject, destination: path.join(f.notes, 'beta.md') };
  const cases = [
    { stateDir: path.dirname(f.configPath) },
    { destination: f.configPath },
    { destination: path.join(f.root, 'absent-notes', 'beta.md') },
    { projectRoot: path.join(f.root, 'absent-project') },
    { stateDir: stateAlias },
    { destination: noteAlias },
  ];
  for (const [index, change] of cases.entries()) {
    const proposed = { ...before.config, routes: [...before.config.routes, { ...validRoute, ...change }] };
    await assert.rejects(updateConfiguration({ client: 'codex', cwd: f.secondProject, configPath: f.configPath,
      expectedHash: before.expectedHash, proposal: await writeProposal(f, proposed, `overlap-${index}.json`) }),
    `Unsafe route was accepted: ${JSON.stringify(change)}`);
    assert.deepEqual(await fs.readFile(f.configPath), before.bytes);
  }
  assert.deepEqual(await fs.readdir(f.notes), ['linked.md']);
  assert.equal(await fs.readlink(noteAlias), f.configPath);
  assert.deepEqual(await fs.readdir(linkedState), []);
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['policy.md']);
});

test('conflicting collection state is rejected across routes and defaults before any write', async t => {
  const f = await fixture(t, { mode: 'automatic' });
  const before = await snapshot(f.configPath);
  const original = before.config.routes[0];
  const otherState = path.join(f.root, 'other-state');
  const alias = path.join(f.root, 'notes-alias');
  await fs.symlink(f.notes, alias, 'dir');
  const note = '# Synthetic knowledge\n\n## Existing decision\n\nKeep this content.\n';
  await fs.writeFile(f.destination, note);
  const route = { ...original, projectRoot: f.secondProject, stateDir: otherState };
  const proposals = [
    { ...before.config, routes: [original, route] },
    { ...before.config, routes: [original, { ...route, destination: path.join(f.notes, 'beta.md') }] },
    { ...before.config, routes: [original, { ...route, destination: path.join(alias, 'alpha.md') }] },
    { ...before.config, routes: [original, { ...route, enabled: false }] },
    { ...before.config, routes: [{ ...original, stateDir: otherState }, { ...route, stateDir: original.stateDir }] },
    { ...before.config, defaultRoute: { destination: f.destination, stateDir: otherState } },
    { ...before.config, defaultRoute: { destination: path.join(alias, 'fallback.md'), stateDir: otherState } },
    { ...before.config, enabled: false, routes: [original, route] },
  ];
  const metadata = await fs.stat(f.configPath, { bigint: true });
  for (const [index, config] of proposals.entries()) {
    const proposal = await writeProposal(f, config, `conflict-${index}.json`);
    const bytes = await fs.readFile(proposal);
    await assert.rejects(updateConfiguration({ client: 'codex', cwd: f.project, configPath: f.configPath,
      expectedHash: before.expectedHash, proposal }), /same.*notes.*collection.*state directory/i);
    assert.deepEqual(await fs.readFile(f.configPath), before.bytes);
    assert.deepEqual(await fs.readFile(proposal), bytes);
    assert.equal((await fs.stat(f.configPath, { bigint: true })).mtimeNs, metadata.mtimeNs);
    assert.equal(await fs.readFile(f.destination, 'utf8'), note);
    assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['config.json']);
  }
  await assert.rejects(fs.stat(original.stateDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(otherState), { code: 'ENOENT' });
});

test('existing collection state conflicts can be stopped but must be repaired before enabling', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.configPath);
  const original = before.config.routes[0];
  const conflict = { ...original, projectRoot: f.secondProject, stateDir: path.join(f.root, 'other-state') };
  const disabled = { ...before.config, enabled: false, routes: [original, conflict] };
  await fs.writeFile(f.configPath, JSON.stringify({ ...disabled, enabled: true }));
  const active = await snapshot(f.configPath);
  const stopped = await updateConfiguration({ client: 'codex', cwd: f.project, configPath: f.configPath,
    expectedHash: active.expectedHash, proposal: await writeProposal(f, disabled) });
  assert.equal(stopped.status, 'updated');
  assert.deepEqual((await snapshot(f.configPath)).config, disabled);
  const inspected = await snapshot(f.configPath);
  const args = { client: 'codex', cwd: f.project, configPath: f.configPath, expectedHash: inspected.expectedHash };
  await assert.rejects(updateConfiguration({ ...args,
    proposal: await writeProposal(f, { ...disabled, enabled: true }) }), /same.*notes.*collection.*state directory/i);
  assert.deepEqual(await fs.readFile(f.configPath), inspected.bytes);
  const repaired = { ...disabled, enabled: true, routes: [original, { ...conflict, stateDir: original.stateDir }] };
  assert.equal((await updateConfiguration({ ...args, proposal: await writeProposal(f, repaired) })).status, 'updated');
  assert.deepEqual((await snapshot(f.configPath)).config, repaired);
  assert.deepEqual(await fs.readdir(f.notes), []);
});

test('collection state comparison accepts canonical aliases and preserves unrelated unavailable routes', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.configPath);
  const original = before.config.routes[0];
  const notesAlias = path.join(f.root, 'notes-alias');
  await fs.symlink(f.notes, notesAlias, 'dir');
  const privateAlias = path.join(f.root, 'private-alias');
  await fs.symlink(path.dirname(f.configPath), privateAlias, 'dir');
  const aliasedState = path.join(privateAlias, path.relative(path.dirname(f.configPath), original.stateDir));
  const offline = { projectRoot: path.join(f.root, 'offline-project'),
    destination: path.join(f.root, 'offline-notes', 'note.md'), stateDir: path.join(f.root, 'offline-state') };
  const unrelatedNotes = path.join(f.root, 'unrelated-notes');
  await fs.mkdir(unrelatedNotes);
  const unrelated = { projectRoot: f.excluded, destination: path.join(unrelatedNotes, 'note.md'),
    stateDir: path.join(f.root, 'unrelated-state') };
  const previous = { ...before.config, routes: [original, offline] };
  await fs.writeFile(f.configPath, JSON.stringify(previous));
  const inspected = await snapshot(f.configPath);
  const config = { ...previous, defaultRoute: { destination: path.join(notesAlias, 'fallback.md'), stateDir: aliasedState },
    routes: [...previous.routes, { ...original, projectRoot: f.secondProject,
      destination: path.join(notesAlias, 'beta.md'), stateDir: aliasedState }, unrelated] };
  const result = await updateConfiguration({ client: 'codex', cwd: f.secondProject, configPath: f.configPath,
    expectedHash: inspected.expectedHash, proposal: await writeProposal(f, config) });
  assert.equal(result.status, 'updated');
  assert.deepEqual((await snapshot(f.configPath)).config, config);
  for (const cwd of [f.project, f.secondProject, f.root]) {
    assert.equal((await setupStatus({ client: 'codex', cwd, configPath: f.configPath })).stateDir, original.stateDir);
  }
  assert.deepEqual(await fs.readdir(f.notes), []);
  assert.deepEqual(await fs.readdir(unrelatedNotes), []);
  await assert.rejects(fs.stat(original.stateDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(offline.stateDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(unrelated.stateDir), { code: 'ENOENT' });
});

test('linked configuration files cannot redirect or split an update', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.configPath);
  const proposal = await writeProposal(f, { ...before.config, scope: 'Updated synthetic scope.' });
  const args = { client: 'codex', cwd: f.project, proposal, expectedHash: before.expectedHash };
  const alias = path.join(f.root, 'config-alias.json');
  await fs.symlink(f.configPath, alias);
  await assert.rejects(updateConfiguration({ ...args, configPath: alias }));
  assert.equal(await fs.readlink(alias), f.configPath);
  assert.deepEqual(await fs.readFile(f.configPath), before.bytes);

  const hardlink = path.join(f.root, 'config-hardlink.json');
  await fs.link(f.configPath, hardlink);
  await assert.rejects(updateConfiguration({ ...args, configPath: f.configPath }));
  assert.deepEqual(await fs.readFile(f.configPath), before.bytes);
  assert.deepEqual(await fs.readFile(hardlink), before.bytes);
  assert.equal((await fs.stat(f.configPath)).nlink, 2);
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['config.json']);
});

test('an explicit complete proposal can change manual use to automatic capture without writing notes', async t => {
  const f = await fixture(t, { mode: 'manual' });
  const before = await snapshot(f.configPath);
  const desired = { ...before.config, enabled: true, automaticUpdates: true, scope: 'Synthetic project findings only.',
    routes: [{ projectRoot: f.project, destination: f.destination, stateDir: path.join(f.root, 'writer-state') }] };
  await updateConfiguration({ client: 'codex', cwd: f.project, configPath: f.configPath,
    expectedHash: before.expectedHash, proposal: await writeProposal(f, desired) });
  assert.deepEqual((await snapshot(f.configPath)).config, desired);
  const status = await setupStatus({ client: 'codex', cwd: f.project, configPath: f.configPath });
  assert.equal(status.status, 'configured');
  assert.equal(status.mode, 'automatic');
  assert.deepEqual(await fs.readdir(f.notes), []);
  await assert.rejects(fs.stat(desired.routes[0].stateDir), { code: 'ENOENT' });
});
