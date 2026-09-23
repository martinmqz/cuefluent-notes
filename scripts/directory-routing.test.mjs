import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, setupStatus } from './setup.mjs';
import { configSchema } from './capture-policy.mjs';
import { updateConfiguration } from './config-update.mjs';
import { hookResponse } from './hooks.mjs';
import { applyPlan, fingerprint, recover } from './safe-update.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-directory-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const notesDir = path.join(root, 'notes');
  await fs.mkdir(project); await fs.mkdir(notesDir);
  return { root, project, notesDir, client: 'codex', mode: 'suggest', scope: 'Synthetic project decisions.',
    configPath: path.join(root, 'private/config.json'), confirmCompatibleClients: true };
}
const load = async file => JSON.parse(await fs.readFile(file));
const payload = cwd => ({ hook_event_name: 'UserPromptSubmit', cwd, session_id: 'session', turn_id: 'turn', prompt_id: 'prompt' });
const operation = response => JSON.parse(response.hookSpecificOutput.additionalContext.split('\n\n').at(-1));

test('folder setup and both client hooks preserve a collection without choosing or reading a note', async t => {
  const f = await fixture(t);
  const existing = path.join(f.notesDir, 'existing-topic.md');
  const bytes = Buffer.from([0xff, 0xfe]); // Routing must not try to parse unrelated note contents.
  await fs.writeFile(existing, bytes);
  const before = await fs.stat(existing, { bigint: true });
  for (const client of ['codex', 'claude']) for (const mode of ['suggest', 'automatic']) {
    const configPath = path.join(f.root, 'private', `${client}-${mode}.json`);
    await initialize({ ...f, client, mode, configPath });
    const status = await setupStatus({ client, cwd: f.project, configPath });
    assert.equal(status.status, 'configured');
    assert.equal(status.mode, mode);
    assert.equal(status.notesDir, f.notesDir);
    assert.equal(Object.hasOwn(status, 'destination'), false);
    const config = await load(configPath);
    const routed = operation(await hookResponse(client, payload(f.project), config));
    assert.equal(routed.notesDir, f.notesDir);
    assert.equal(routed.stateDir, status.stateDir);
    assert.equal(routed.automaticUpdates, mode === 'automatic');
    assert.equal(Object.hasOwn(routed, 'destination'), false);
    assert.equal(await hookResponse(client, payload(f.root), config), null);
    await assert.rejects(fs.stat(status.stateDir), { code: 'ENOENT' });
  }
  assert.deepEqual(await fs.readdir(f.notesDir), ['existing-topic.md']);
  assert.deepEqual(await fs.readFile(existing), bytes);
  assert.equal((await fs.stat(existing, { bigint: true })).mtimeNs, before.mtimeNs);
});

test('an unavailable folder stops capture without inventing a file or storage', async t => {
  const f = await fixture(t);
  await initialize(f);
  const config = await load(f.configPath);
  await fs.rmdir(f.notesDir);
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'invalid');
  const response = await hookResponse('codex', payload(f.project), config);
  assert.match(response.hookSpecificOutput.additionalContext, /capture is skipped/);
  await assert.rejects(fs.stat(f.notesDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(config.routes[0].stateDir), { code: 'ENOENT' });
});

test('a route selects exactly one absolute file or folder and Manual accepts neither', async t => {
  const f = await fixture(t);
  const base = { version: 2, minimumPluginVersion: '0.5.1', enabled: true, clients: ['codex'], automaticUpdates: false, scope: f.scope };
  const stateDir = path.join(f.root, 'state');
  for (const storage of [
    {}, { notesDir: 'relative' }, { notesDir: null }, { notesDir: 42 },
    { notesDir: f.notesDir, destination: path.join(f.notesDir, 'note.md') },
    { destination: path.join(f.notesDir, 'not-markdown.txt') },
  ]) {
    for (const route of [{ defaultRoute: { ...storage, stateDir } },
      { routes: [{ projectRoot: f.project, ...storage, stateDir }] }]) {
      assert.throws(() => configSchema({ ...base, ...route }), /Invalid capture configuration/);
    }
  }
  await assert.rejects(initialize({ ...f, destination: path.join(f.notesDir, 'note.md') }), /exactly one/);
  await assert.rejects(initialize({ ...f, notesDir: undefined }), /exactly one/);
  await assert.rejects(initialize({ ...f, mode: 'manual' }), /Manual mode/);
  await assert.rejects(fs.stat(f.configPath), { code: 'ENOENT' });
});

test('folder setup rejects unavailable storage and overlap without creating notes or state', async t => {
  const f = await fixture(t);
  const existingFile = path.join(f.root, 'regular.md');
  await fs.writeFile(existingFile, 'Preserve this file.');
  for (const extra of [
    { notesDir: path.join(f.root, 'missing') }, { notesDir: existingFile },
    { notesDir: fileURLToPath(new URL('..', import.meta.url)) },
    { stateDir: f.notesDir }, { stateDir: path.join(f.notesDir, 'state') }, { stateDir: f.root },
    { configPath: path.join(f.notesDir, 'config.json'), stateDir: path.join(f.root, 'state') },
  ]) await assert.rejects(initialize({ ...f, ...extra }));
  assert.deepEqual(await fs.readdir(f.notesDir), []);
  assert.equal(await fs.readFile(existingFile, 'utf8'), 'Preserve this file.');
  await assert.rejects(fs.stat(path.dirname(f.configPath)), { code: 'ENOENT' });
});

test('file-to-folder migration preserves consent, notes, and the canonical collection state', async t => {
  const f = await fixture(t);
  const destination = path.join(f.notesDir, 'existing-topic.md');
  const note = '# Synthetic project\n\n## Existing decision\n\nPreserve the user edit.\n';
  await fs.writeFile(destination, note);
  await initialize({ ...f, notesDir: undefined, destination });
  const before = await setupStatus({ ...f, cwd: f.project });
  const config = await load(f.configPath);
  const alias = path.join(f.root, 'notes-alias');
  await fs.symlink(f.notesDir, alias);
  const { destination: ignored, ...route } = config.routes[0];
  const proposed = { ...config, version: 2, minimumPluginVersion: '0.5.1', routes: [{ ...route, notesDir: alias }] };
  const proposal = path.join(f.root, 'proposal.json');
  await fs.writeFile(proposal, JSON.stringify(proposed));
  await updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash });
  const after = await setupStatus({ ...f, cwd: f.project });
  assert.equal(after.notesDir, f.notesDir);
  assert.equal(after.stateDir, before.stateDir);
  assert.equal(after.mode, 'suggest');
  assert.deepEqual((await load(f.configPath)).clients, ['codex']);
  assert.equal(await fs.readFile(destination, 'utf8'), note);
  assert.deepEqual(await fs.readdir(f.notesDir), ['existing-topic.md']);
  await assert.rejects(fs.stat(after.stateDir), { code: 'ENOENT' });
  await assert.rejects(updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash }), /changed/);

  const otherConfig = path.join(f.root, 'private/alias.json');
  await initialize({ ...f, notesDir: alias, configPath: otherConfig });
  assert.equal((await setupStatus({ ...f, cwd: f.project, configPath: otherConfig })).stateDir, before.stateDir);
});

test('mixed folder and file routes in one collection must use the same state', async t => {
  const f = await fixture(t);
  await initialize(f);
  const before = await setupStatus({ ...f, cwd: f.project });
  const config = await load(f.configPath);
  const alias = path.join(f.root, 'notes-alias');
  await fs.symlink(f.notesDir, alias);
  const proposal = path.join(f.root, 'proposal.json');
  for (const storage of [{ notesDir: alias }, { destination: path.join(alias, 'specific-topic.md') }]) {
    await fs.writeFile(proposal, JSON.stringify({ ...config, defaultRoute: { ...storage, stateDir: path.join(f.root, 'other-state') } }));
    await assert.rejects(updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash }), /same notes collection/);
    assert.equal((await setupStatus({ ...f, cwd: f.project })).configHash, before.configHash);
  }
  await fs.writeFile(proposal, JSON.stringify({ ...config, defaultRoute: { destination: path.join(alias, 'specific-topic.md'), stateDir: before.stateDir } }));
  await updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash });
  const fallback = await setupStatus({ ...f, cwd: f.root });
  assert.equal(fallback.destination, path.join(f.notesDir, 'specific-topic.md'));
  assert.equal(Object.hasOwn(fallback, 'notesDir'), false);
  assert.equal(fallback.stateDir, before.stateDir);
  const current = await setupStatus({ ...f, cwd: f.project });
  await fs.writeFile(proposal, JSON.stringify({ ...config, defaultRoute: { notesDir: alias, stateDir: before.stateDir } }));
  await updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: current.configHash });
  const folderFallback = await setupStatus({ ...f, cwd: f.root });
  assert.equal(folderFallback.notesDir, f.notesDir);
  assert.equal(Object.hasOwn(folderFallback, 'destination'), false);
  assert.deepEqual(await fs.readdir(f.notesDir), []);
});

test('one folder route supports separate subjects and guarded updates without changing other notes', async t => {
  const f = await fixture(t);
  await initialize(f);
  const config = await load(f.configPath);
  const routed = operation(await hookResponse('codex', payload(f.project), config));
  const filenames = ['orchid-release-1.0.md', 'cache-expiry-decisions.md'];
  const bodies = ['# Orchid\n\n## Release 1.0\n\nThe fictional release passed validation.\n',
    '# Orchid\n\n## Cache expiry decision\n\nThe prototype uses a 30-minute TTL.\n'];
  const plan = { version: 1, mode: 'authored', root: routed.notesDir, stateDir: routed.stateDir, files: [] };
  for (let i = 0; i < filenames.length; i++) {
    const contentPath = path.join(f.root, `proposal-${i}.md`);
    await fs.writeFile(contentPath, bodies[i]);
    plan.files.push({ path: filenames[i], contentPath, expectedHash: null });
  }
  await applyPlan(plan);
  assert.deepEqual(await fs.readdir(f.notesDir), [...filenames].sort());
  const target = path.join(f.notesDir, filenames[0]);
  const expectedHash = await fingerprint(target);
  await fs.writeFile(plan.files[0].contentPath, bodies[0] + '\nUser-approved correction.\n');
  await applyPlan({ ...plan, files: [{ ...plan.files[0], expectedHash }] });
  assert.equal(await fs.readFile(path.join(f.notesDir, filenames[1]), 'utf8'), bodies[1]);
  assert.match(await fs.readFile(target, 'utf8'), /User-approved correction/);
  await assert.rejects(applyPlan({ ...plan, files: [{ ...plan.files[0], expectedHash }] }), /changed|match|conflict/);
});

test('ancestor and descendant collections share state even through aliases or disabled routes', async t => {
  const f = await fixture(t);
  const nested = path.join(f.notesDir, 'atlas');
  const alias = path.join(f.root, 'alias');
  await fs.mkdir(nested); await fs.symlink(f.notesDir, alias);
  await initialize(f);
  const before = await setupStatus({ ...f, cwd: f.project });
  const config = await load(f.configPath);
  const proposal = path.join(f.root, 'proposal.json');
  for (const storage of [{ notesDir: path.join(alias, 'atlas') },
    { destination: path.join(alias, 'atlas/atlas.md') }]) {
    const route = { projectRoot: f.root, ...storage, stateDir: path.join(f.root, 'other-state'), enabled: false };
    for (const routes of [[...config.routes, route], [route, ...config.routes]]) {
      await fs.writeFile(proposal, JSON.stringify({ ...config, routes }));
      await assert.rejects(updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash }), /overlapping notes folders/);
    }
    await fs.writeFile(proposal, JSON.stringify({ ...config, defaultRoute: { ...storage, stateDir: before.stateDir } }));
    const current = await setupStatus({ ...f, cwd: f.project });
    await updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: current.configHash });
    // Restore the original policy for the next candidate.
    await fs.writeFile(f.configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  assert.deepEqual(await fs.readdir(nested), []);
  await assert.rejects(fs.stat(before.stateDir), { code: 'ENOENT' });
});

test('derived collection state is refused by setup and updates, and detected if it appears later', async t => {
  const f = await fixture(t);
  await initialize(f);
  const before = await setupStatus({ ...f, cwd: f.project });
  const config = await load(f.configPath);
  const source = path.join(f.root, 'source.md');
  const contentPath = path.join(f.root, 'content.md');
  await fs.writeFile(source, '# Source\n\n## Evidence\n\nSynthetic evidence.\n');
  await fs.writeFile(contentPath, '# Summary\n\n## Finding\n\nSynthetic finding.\n');
  await applyPlan({ version: 1, mode: 'derived', root: f.notesDir, stateDir: before.stateDir,
    expectedManifestHash: null, files: [{ path: 'derived.md', expectedHash: null, contentPath,
      sources: [{ path: source, expectedHash: await fingerprint(source) }],
      entries: [{ heading: 'Finding', sourcePaths: [source] }] }] });
  const manifest = path.join(before.stateDir, 'manifest.json');
  const hashes = await Promise.all([manifest, path.join(f.notesDir, 'derived.md')].map(fingerprint));
  // Source absence must not matter to metadata-only setup or hooks.
  await fs.unlink(source);
  const status = await setupStatus({ ...f, cwd: f.project });
  assert.equal(status.status, 'state_conflict');
  assert.match(status.reason, /separate notes collection/);
  for (const storage of [{ notesDir: f.notesDir }, { notesDir: undefined, destination: path.join(f.notesDir, 'authored.md') }]) {
    await assert.rejects(initialize({ ...f, ...storage, stateDir: before.stateDir, configPath: path.join(f.root, 'new/config.json') }), { code: 'DERIVED_STATE_CONFLICT' });
  }
  await assert.rejects(fs.stat(path.join(f.root, 'new')), { code: 'ENOENT' });
  const proposal = path.join(f.root, 'proposal.json');
  await fs.writeFile(proposal, JSON.stringify({ ...config, scope: 'Updated synthetic scope.' }));
  await assert.rejects(updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash }), { code: 'DERIVED_STATE_CONFLICT' });
  assert.equal(await fingerprint(f.configPath), before.configHash);
  const result = await hookResponse('codex', payload(f.project), config);
  assert.match(result.hookSpecificOutput.additionalContext, /state owns derived outputs/);
  assert.deepEqual(await Promise.all([manifest, path.join(f.notesDir, 'derived.md')].map(fingerprint)), hashes);
  // Stopping capture must remain possible without repairing the derived collection.
  await fs.writeFile(proposal, JSON.stringify({ ...config, enabled: false }));
  await updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash });
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'disabled');
});

for (const mode of ['derived', 'authored']) test(`pending ${mode} journals stop capture before a manifest exists`, async t => {
  for (const interruption of ['afterStage', 'afterReplace']) {
    const f = await fixture(t);
    await initialize(f);
    const before = await setupStatus({ ...f, cwd: f.project });
    const config = await load(f.configPath);
    const source = path.join(f.root, 'source.md');
    const contentPath = path.join(f.root, 'content.md');
    await fs.writeFile(source, '# Source\n\n## Evidence\n\nSynthetic evidence.\n');
    await fs.writeFile(contentPath, '# Summary\n\n## Finding\n\nSynthetic finding.\n');
    await assert.rejects(applyPlan({ version: 1, mode, root: f.notesDir, stateDir: before.stateDir,
      ...(mode === 'derived' ? { expectedManifestHash: null } : {}),
      files: [{ path: 'summary.md', expectedHash: null, contentPath,
        sources: [{ path: source, expectedHash: await fingerprint(source) }],
        entries: [{ heading: 'Finding', sourcePaths: [source] }] }],
    }, { [interruption]() { throw new Error('Synthetic interruption'); } }), /Synthetic interruption/);
    const journalPath = path.join(before.stateDir, 'journal.json');
    const journal = await load(journalPath);
    assert.equal(journal.mode, mode);
    assert.equal(journal.phase, interruption === 'afterStage' ? 'staging' : 'ready');
    await assert.rejects(fs.stat(path.join(before.stateDir, 'manifest.json')), { code: 'ENOENT' });
    const files = [journalPath, ...await fs.readdir(f.notesDir).then(names => names.map(name => path.join(f.notesDir, name)))];
    const hashes = await Promise.all(files.map(fingerprint));
    const errorCode = mode === 'derived' ? 'DERIVED_STATE_CONFLICT' : 'STATE_RECOVERY_REQUIRED';
    const expectedStatus = mode === 'derived' ? 'state_conflict' : 'recovery_required';
    const forbidden = new Set([source, contentPath, ...files.slice(1)]);
    const open = fs.open;
    fs.open = async (file, ...args) => {
      assert.equal(forbidden.has(String(file)), false, 'Capture routing must not read sources, proposals, stages, or notes.');
      return open(file, ...args);
    };
    try {
      assert.equal((await setupStatus({ ...f, cwd: f.project })).status, expectedStatus);
      for (const client of ['codex', 'claude']) {
        const response = await hookResponse(client, payload(f.project), { ...config, clients: [client] });
        assert.match(response.hookSpecificOutput.additionalContext, mode === 'derived' ? /state owns derived outputs/ : /interrupted update/);
      }
      for (const storage of [{ notesDir: f.notesDir }, { notesDir: undefined, destination: path.join(f.notesDir, 'authored.md') }]) {
        await assert.rejects(initialize({ ...f, ...storage, stateDir: before.stateDir, configPath: path.join(f.root, 'fresh/config.json') }), { code: errorCode });
      }
      await assert.rejects(fs.stat(path.join(f.root, 'fresh')), { code: 'ENOENT' });
      const proposal = path.join(f.root, 'proposal.json');
      await fs.writeFile(proposal, JSON.stringify({ ...config, scope: 'Updated scope.' }));
      await assert.rejects(updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash }), { code: errorCode });
      assert.equal(await fingerprint(f.configPath), before.configHash);
      await fs.writeFile(proposal, JSON.stringify({ ...config, enabled: false }));
      await updateConfiguration({ ...f, cwd: f.project, proposal, expectedHash: before.configHash });
      assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'disabled');
    } finally { fs.open = open; }
    assert.deepEqual(await Promise.all(files.map(fingerprint)), hashes);
    // The fixture is a real recoverable writer journal, not a fabricated header.
    await recover(before.stateDir);
    await assert.rejects(fs.stat(journalPath), { code: 'ENOENT' });
    if (mode === 'derived') assert.notEqual(await fingerprint(path.join(before.stateDir, 'manifest.json')), null);
  }
});

test('capture rejects unsafe or unreadable journals without following links or changing state', async t => {
  const f = await fixture(t);
  await initialize(f);
  const before = await setupStatus({ ...f, cwd: f.project });
  await fs.mkdir(before.stateDir, { recursive: true });
  const journalPath = path.join(before.stateDir, 'journal.json');
  for (const bytes of [Buffer.from('{broken'), Buffer.from([0xff]), Buffer.alloc(2 * 1024 * 1024 + 1, 32)]) {
    await fs.writeFile(journalPath, bytes);
    assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'invalid');
    assert.deepEqual(await fs.readFile(journalPath), bytes);
  }
  await fs.unlink(journalPath);
  const target = path.join(f.root, 'other.json');
  await fs.writeFile(target, JSON.stringify({ version: 1, mode: 'derived' }));
  await fs.symlink(target, journalPath);
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'invalid');
  await fs.unlink(target); // A dangling journal is still present and unsafe.
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'invalid');
  assert.equal(await fs.readlink(journalPath), target);
  assert.equal(await fingerprint(f.configPath), before.configHash);
  assert.deepEqual(await fs.readdir(f.notesDir), []);
});
