import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { interruptRemoval } from '../fixtures/exact-removal-worker.mjs';
import { setupProject } from '../../src/control/setup.mjs';
import { createDirectNoteTools } from '../../src/control/direct-notes.mjs';
import { createProject, validateSettings } from '../../src/core/settings.mjs';
import { initializeStore, openStore, readSettings, updateSettings, withProject } from '../../src/storage/store.mjs';
import { readJSON, writeJSON } from '../../src/storage/files.mjs';
import { createAnnualLog, inspectAnnualLog } from '../../src/logs/index.mjs';
import { readActivityLog, logYear } from '../../src/logs/storage.mjs';
import { inspectMetadata } from '../../src/notes/index.mjs';

const now = '2026-10-22T01:00:00.000Z', skillVersion = '0.16.0-dev.0';
async function fixture(t, { enabled = false, destinationKind = 'directory' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-setup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const notes = path.join(root, 'notes'), storeRoot = path.join(root, 'private');
  const options = { storeRoot, expectedHash: null, skillVersion, now,
    project: { id: 'synthetic', root: cwd, destination: { kind: destinationKind, path: destinationKind === 'file' ? path.join(notes, 'one.md') : notes },
      activityLog: enabled ? { enabled: true, timezone: 'UTC' } : { enabled: false } } };
  const current = async () => readSettings(await openStore(storeRoot));
  return { root, cwd, notes, storeRoot, options, current };
}
async function annual(f, { timezone = 'America/Los_Angeles', seriesId = 'existing-series', year = 2025 } = {}) {
  await fs.mkdir(path.join(f.notes, 'logs'), { recursive: true });
  const bytes = createAnnualLog({ year, timezone, seriesId, noteId: randomUUID(), createdAt: now, skillVersion });
  const target = path.join(f.notes, 'logs', `${year}.md`); await fs.writeFile(target, bytes);
  return { target, bytes };
}
async function stopSetup(t, f, point) {
  const child = fork(fileURLToPath(new URL('../fixtures/setup-worker.mjs', import.meta.url)), [f.root, JSON.stringify(f.options), point], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  for (let tries = 0; ; tries++) {
    try { await fs.access(path.join(f.root, 'setup-boundary')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const failed = await fs.readFile(path.join(f.root, 'setup-error.json'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    assert.equal(failed, null, `Synthetic setup failed: ${failed}`);
    assert.ok(tries < 300, 'Synthetic setup did not reach its expected boundary.'); await delay(20);
  }
  child.kill('SIGKILL'); await exited;
}

test('setup rejects malformed SemVer before creating storage and retains valid build metadata and its length limit', async t => {
  const f = await fixture(t);
  for (const skillVersion of ['0.16.0-01', '0.16.0-.', '0.16.0-dev..1', '0.16.0+build..1', '01.16.0', `0.16.0-${'x'.repeat(250)}`]) {
    await assert.rejects(setupProject({ ...f.options, skillVersion }), { code: 'SETUP_ARGUMENT' });
    assert.deepEqual(await fs.readdir(f.root), ['project']);
  }
  for (const skillVersion of ['0.16.0-01a+001.build-0', `0.16.0-${'x'.repeat(249)}`]) {
    const configured = await fixture(t, { enabled: true });
    assert.equal((await setupProject({ ...configured.options, skillVersion })).status, 'configured');
    const annual = inspectMetadata(await fs.readFile(path.join(configured.notes, 'logs/2026.md')));
    assert.equal(annual.value.generation.skill_version, skillVersion);
  }
});

test('explicit logging opt-out creates no annual file and preserves independent tracking and saving defaults', async t => {
  const f = await fixture(t), result = await setupProject(f.options), current = await f.current();
  assert.equal(result.status, 'configured'); assert.equal(result.settingsHash, current.hash);
  assert.equal(result.project.tracking, 'manual'); assert.equal(result.project.saving, 'review'); assert.deepEqual(result.project.activityLog, { enabled: false });
  assert.deepEqual(result.logs, { path: path.join(f.notes, 'logs'), status: 'absent' });
  assert.deepEqual(await fs.readdir(f.notes), []);
  const store = await openStore(f.storeRoot);
  await withProject(store, 'synthetic', async context => {
    assert.deepEqual(await fs.readdir(path.join(f.storeRoot, context.directory, 'chats')), []);
    assert.deepEqual(await fs.readdir(path.join(f.storeRoot, context.directory, 'drafts')), []);
  });
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'config')), ['settings.json']);
});

test('default directory setup establishes logging and records one entry for a saved direct note', async t => {
  const f = await fixture(t);
  delete f.options.project.activityLog;
  const result = await setupProject(f.options), store = await openStore(f.storeRoot);
  assert.equal(result.project.tracking, 'manual'); assert.equal(result.project.saving, 'review');
  assert.equal(result.project.activityLog.enabled, true);
  assert.equal(result.project.activityLog.timezone, new Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(result.logs.status, 'valid');
  assert.deepEqual(await fs.readdir(f.notes), ['logs']);
  const tools = createDirectNoteTools({ store, client: 'codex', skillVersion });
  const input = { projectId: result.project.id, requestId: randomUUID(), target: 'decision.md',
    content: '# Release choice\n\n## Decision\nKeep the release small.\n', summary: 'Recorded the release choice.' };
  const draft = await tools.call('cuefluent_create_note', input);
  assert.equal(draft.state, 'review');
  const initialYear = logYear(now, result.project.activityLog.timezone);
  assert.equal((await readActivityLog(result.project.destination, { year: initialYear })).entries.length, 0);
  const reference = { projectId: result.project.id, runId: draft.runId };
  const earliestYear = logYear(new Date().toISOString(), result.project.activityLog.timezone);
  const saved = await tools.call('cuefluent_save_note', reference);
  assert.equal(saved.state, 'saved');
  const latestYear = logYear(new Date().toISOString(), result.project.activityLog.timezone);
  const entries = [];
  for (const year of new Set([earliestYear, latestYear])) {
    try { entries.push(...(await readActivityLog(result.project.destination, { year })).entries); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'created'); assert.equal(entries[0].target, input.target);
  assert.equal(entries[0].summary, input.summary);
  assert.deepEqual(await tools.call('cuefluent_save_note', reference), saved);
  await withProject(store, result.project.id, async context => {
    assert.deepEqual(await fs.readdir(path.join(f.storeRoot, context.directory, 'chats')), []);
  });
});

test('a single-file destination defaults to logging off without creating a sibling logs directory', async t => {
  const f = await fixture(t, { destinationKind: 'file' }); delete f.options.project.activityLog;
  const result = await setupProject(f.options);
  assert.deepEqual(result.project.activityLog, { enabled: false });
  assert.equal(result.logs.status, 'not-applicable');
  assert.deepEqual(await fs.readdir(f.notes), []);
});

test('logging records and shows exact reserved path only after a valid first annual note exists', async t => {
  const f = await fixture(t, { enabled: true }), result = await setupProject(f.options), project = (await f.current()).value.projects[0];
  assert.deepEqual(project.activityLog, { enabled: true, timezone: 'UTC', path: path.join(f.notes, 'logs') });
  assert.equal(result.logs.path, project.activityLog.path); assert.equal(result.logs.status, 'valid'); assert.deepEqual(result.logs.years, [2026]);
  const annual = inspectAnnualLog(await fs.readFile(path.join(f.notes, 'logs/2026.md')), { year: 2026 });
  assert.equal(annual.seriesId, result.logs.seriesId); assert.equal(annual.timezone, 'UTC'); assert.equal(annual.entryCount, 0);
});

test('valid pre-existing annuals own timezone and series; setup does not create a gratuitous current-year file', async t => {
  const f = await fixture(t, { enabled: true }), before = await annual(f), result = await setupProject(f.options);
  assert.equal(result.project.activityLog.timezone, 'America/Los_Angeles'); assert.equal(result.logs.seriesId, 'existing-series');
  assert.deepEqual(result.logs.years, [2025]); assert.deepEqual(await fs.readFile(before.target), before.bytes);
  assert.deepEqual(await fs.readdir(path.dirname(before.target)), ['2025.md']);
});

test('setup reports only a bounded unrelated sibling count while preserving an established log series', async t => {
  const f = await fixture(t, { enabled: true }), before = await annual(f);
  const siblings = ['.DS_Store', '.cuefluent-note.other.tmp'];
  for (const name of siblings) await fs.writeFile(path.join(f.notes, 'logs', name), 'Existing sibling.');
  const result = await setupProject(f.options);
  assert.equal(result.logs.status, 'valid'); assert.equal(result.logs.unrelatedEntries, 2);
  assert.equal(result.project.activityLog.timezone, 'America/Los_Angeles');
  assert.deepEqual(await fs.readFile(before.target), before.bytes);
  for (const name of siblings) assert.equal(await fs.readFile(path.join(f.notes, 'logs', name), 'utf8'), 'Existing sibling.');
  assert.equal(JSON.stringify(result.logs).includes('other.tmp'), false);
  const fOff = await fixture(t), offAnnual = await annual(fOff);
  await fs.writeFile(path.join(path.dirname(offAnnual.target), '.DS_Store'), 'Existing sibling.');
  const off = await setupProject(fOff.options);
  assert.equal(off.logs.status, 'valid'); assert.equal(off.logs.unrelatedEntries, 1); assert.equal(off.project.activityLog.enabled, false);
});

test('disabled setup reports pre-existing malformed logs once and preserves them without adoption', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.notes, 'logs'), { recursive: true });
  const target = path.join(f.notes, 'logs/2026.md'), bytes = Buffer.from('# Manual legacy activity\n'); await fs.writeFile(target, bytes);
  const result = await setupProject(f.options);
  assert.equal(result.logs.status, 'problem'); assert.equal(result.logs.warning, 'LOG_INVALID');
  assert.deepEqual(result.project.activityLog, { enabled: false }); assert.deepEqual(await fs.readFile(target), bytes);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['2026.md']);
  const current = await f.current();
  await assert.rejects(setupProject({ ...f.options, expectedHash: current.hash, project: { ...f.options.project, activityLog: { enabled: true, timezone: 'UTC' } } }), { code: 'LOG_INVALID' });
  assert.equal((await f.current()).hash, current.hash); assert.deepEqual(await fs.readFile(target), bytes);
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'config')), ['settings.json']);
  assert.equal((await setupProject({ ...f.options, expectedHash: current.hash })).project.activityLog.enabled, false);
});

test('empty pre-existing reserved directory is usable, while single-file logging and unsafe setup make zero writes', async t => {
  const f = await fixture(t, { enabled: true }); await fs.mkdir(path.join(f.notes, 'logs'), { recursive: true });
  assert.equal((await setupProject(f.options)).logs.status, 'valid');
  const single = await fixture(t, { enabled: true, destinationKind: 'file' });
  await assert.rejects(setupProject(single.options), { code: 'SETTINGS_INVALID' });
  await assert.rejects(fs.stat(single.storeRoot), { code: 'ENOENT' }); await assert.rejects(fs.stat(single.notes), { code: 'ENOENT' });
  const unsafe = await fixture(t);
  await assert.rejects(setupProject({ ...unsafe.options, storeRoot: path.join(unsafe.cwd, 'private') }), { code: 'PRIVATE_LOCATION_OVERLAP' });
  assert.deepEqual(await fs.readdir(unsafe.cwd), []);
  const file = await fixture(t, { destinationKind: 'file' }), fileResult = await setupProject(file.options);
  assert.equal(fileResult.project.destination.kind, 'file'); assert.deepEqual(fileResult.logs, { path: null, status: 'not-applicable' });
  assert.deepEqual(await fs.readdir(file.notes), []);
});

test('stale whole-settings CAS and retained-work checks precede public directory or log creation', async t => {
  const f = await fixture(t), first = await setupProject(f.options), store = await openStore(f.storeRoot), inspected = await readSettings(store);
  await updateSettings(store, { ...inspected.value, projects: [{ ...inspected.value.projects[0], tracking: 'auto' }] }, { expectedHash: inspected.hash });
  const moved = path.join(f.root, 'new-notes');
  await assert.rejects(setupProject({ ...f.options, expectedHash: first.settingsHash, project: { ...f.options.project, destination: { kind: 'directory', path: moved }, activityLog: { enabled: true, timezone: 'UTC' } } }), { code: 'SETTINGS_CONFLICT' });
  await assert.rejects(fs.stat(moved), { code: 'ENOENT' });
  await withProject(store, 'synthetic', context => writeJSON(store.pin, `${context.directory}/chats/synthetic.json`, { synthetic: 'retained owner' }, { expectedHash: null }));
  let current = await readSettings(store);
  const otherRoot = path.join(f.root, 'other-project'); await fs.mkdir(otherRoot);
  await assert.rejects(setupProject({ ...f.options, expectedHash: current.hash, project: { ...f.options.project, root: otherRoot } }), { code: 'SETTINGS_RETAINED_PROJECT' });
  await withProject(store, 'synthetic', context => writeJSON(store.pin, `${context.directory}/run.json`, { synthetic: 'pending run' }, { expectedHash: null }));
  await assert.rejects(setupProject({ ...f.options, expectedHash: current.hash, project: { ...f.options.project, destination: { kind: 'directory', path: moved }, activityLog: { enabled: true, timezone: 'UTC' } } }), { code: 'SETTINGS_PENDING_RUN' });
  await assert.rejects(fs.stat(moved), { code: 'ENOENT' });
  const enabled = await setupProject({ ...f.options, expectedHash: current.hash, project: { ...f.options.project, activityLog: { enabled: true, timezone: 'UTC' } } });
  assert.equal(enabled.project.activityLog.enabled, true);
  await withProject(store, 'synthetic', async context => assert.deepEqual((await readJSON(store.pin, `${context.directory}/run.json`)).value, { synthetic: 'pending run' }));
});

test('setup cannot reinitialize missing metadata and redirect retained chats or pending drafts', async t => {
  for (const missing of [['config/settings.json'], ['store/layout.json'], ['config/settings.json', 'store/layout.json']]) {
    const f = await fixture(t); await setupProject(f.options);
    const store = await openStore(f.storeRoot), retained = await withProject(store, 'synthetic', async ({ directory, gates }) => {
      const files = [`${directory}/chats/synthetic.json`, `${directory}/run.json`, 'store/chats/synthetic.queue'];
      for (const relative of files) await writeJSON(store.pin, relative, { synthetic: `Retain ${relative}` }, { expectedHash: null });
      return { files, gates };
    });
    for (const relative of missing) await fs.unlink(path.join(store.root, relative));
    const files = [...retained.files, ...['config/settings.json', 'store/layout.json'].filter(relative => !missing.includes(relative))];
    const before = await Promise.all(files.map(relative => fs.readFile(path.join(store.root, relative))));
    const gates = [store.settingsGate, store.writerGate, store.syncGate, ...Object.values(retained.gates)];
    const identities = await Promise.all(gates.map(gate => fs.lstat(gate.path, { bigint: true })));
    const moved = path.join(f.root, 'new-notes');
    await assert.rejects(setupProject({ ...f.options, project: { ...f.options.project, saving: 'auto', destination: { kind: 'directory', path: moved } } }), { code: 'STORE_INCOMPLETE' });
    assert.deepEqual(await Promise.all(files.map(relative => fs.readFile(path.join(store.root, relative)))), before);
    assert.deepEqual((await Promise.all(gates.map(gate => fs.lstat(gate.path, { bigint: true })))).map(stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs]), identities.map(stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs]));
    for (const relative of missing) await assert.rejects(fs.stat(path.join(store.root, relative)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(moved), { code: 'ENOENT' });
  }
});

test('SIGKILL after first annual publication leaves logging disabled until exact setup retry', async t => {
  const f = await fixture(t, { enabled: true }); await stopSetup(t, f, 'annual');
  const current = await f.current(); assert.deepEqual(current.value.projects, []);
  const store = await openStore(f.storeRoot), pending = await readJSON(store.pin, 'config/setup.json');
  assert.ok(pending.value.publication.stage); const eventIdentity = pending.value.noteId;
  const result = await setupProject({ ...f.options, expectedHash: current.hash, now: '2027-01-01T01:00:00.000Z', skillVersion: '2.0.1' });
  assert.equal(result.project.activityLog.enabled, true); assert.deepEqual(result.logs.years, [2026]);
  assert.equal(inspectAnnualLog(await fs.readFile(path.join(f.notes, 'logs/2026.md')), { year: 2026 }).noteId, eventIdentity);
  assert.deepEqual(await fs.readdir(path.join(f.notes, 'logs')), ['2026.md']);
  assert.equal(await readJSON(store.pin, 'config/setup.json', { missing: true }), null);
});

test('SIGKILL after settings publication completes journal by exact equality without rewriting the annual file', async t => {
  const f = await fixture(t, { enabled: true }); await stopSetup(t, f, 'settings');
  const current = await f.current(), before = await fs.readFile(path.join(f.notes, 'logs/2026.md'));
  assert.equal(current.value.projects[0].activityLog.enabled, true);
  const result = await setupProject({ ...f.options, expectedHash: current.hash });
  assert.equal(result.recovered, true); assert.equal(result.settingsHash, current.hash);
  assert.deepEqual(await fs.readFile(path.join(f.notes, 'logs/2026.md')), before);
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'config')), ['settings.json']);
});

test('process exit after capturing the completed setup journal remains readable and exact setup retry finishes', async t => {
  const f = await fixture(t, { enabled: true });
  await interruptRemoval({ root: f.storeRoot, relative: 'config/setup.json', operation: 'setup', options: f.options });
  const store = await openStore(f.storeRoot), current = await f.current();
  const before = await fs.readFile(path.join(f.notes, 'logs/2026.md'));
  const journal = await readJSON(store.pin, 'config/setup.json');
  assert.equal(journal.value.logs.status, 'valid');
  await assert.rejects(fs.lstat(path.join(f.storeRoot, 'config/setup.json')), { code: 'ENOENT' });
  const result = await setupProject({ ...f.options, expectedHash: current.hash });
  assert.equal(result.recovered, true); assert.equal(result.settingsHash, current.hash);
  assert.deepEqual(await fs.readFile(path.join(f.notes, 'logs/2026.md')), before);
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'config')), ['settings.json']);
});

test('a different setup request or intervening settings cannot reset a retained exact setup journal', async t => {
  const f = await fixture(t, { enabled: true }); await stopSetup(t, f, 'annual');
  const store = await openStore(f.storeRoot), current = await f.current(), journal = await readJSON(store.pin, 'config/setup.json');
  await assert.rejects(setupProject({ ...f.options, expectedHash: current.hash, project: { ...f.options.project, tracking: 'auto' } }), { code: 'SETUP_PENDING' });
  assert.equal((await readJSON(store.pin, 'config/setup.json')).hash, journal.hash);
  const other = path.join(f.root, 'other'); await fs.mkdir(other);
  await updateSettings(store, { schemaVersion: 1, projects: [createProject({ id: 'other', root: other, destination: { kind: 'directory', path: f.notes } })] }, { expectedHash: current.hash });
  const changed = await f.current();
  await assert.rejects(setupProject({ ...f.options, expectedHash: changed.hash }), { code: 'SETUP_PENDING' });
  assert.equal((await readJSON(store.pin, 'config/setup.json')).hash, journal.hash);
});

test('complete loaded enabled settings require the recorded destination-relative logs path', () => {
  const project = createProject({ id: 'synthetic', root: '/project', destination: { kind: 'directory', path: '/notes' }, activityLog: { enabled: true, timezone: 'UTC' } }, { platform: 'posix' });
  assert.equal(project.activityLog.path, '/notes/logs');
  const missing = structuredClone(project); delete missing.activityLog.path;
  assert.throws(() => validateSettings({ schemaVersion: 1, projects: [missing] }, { platform: 'posix' }), { code: 'SETTINGS_INVALID' });
  assert.throws(() => createProject({ ...project, activityLog: { ...project.activityLog, path: '/notes/sibling-logs' } }, { platform: 'posix' }), { code: 'SETTINGS_INVALID' });
});

test('setup diagnostics identify an unrelated reserved entry without adopting or rewriting it', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.notes, 'logs'), { recursive: true });
  await fs.writeFile(path.join(f.notes, 'logs', 'README.md'), 'Manual notes.');
  const result = await setupProject(f.options);
  assert.equal(result.logs.warning, 'LOG_LAYOUT_UNRECOGNIZED');
  assert.deepEqual(result.logs.location, { entry: 'README.md' });
  assert.equal(await fs.readFile(path.join(f.notes, 'logs', 'README.md'), 'utf8'), 'Manual notes.');
});

test('setup enables logging beside preserved Finder metadata and reports it as unrelated', async t => {
  const f = await fixture(t, { enabled: true }); await fs.mkdir(path.join(f.notes, 'logs'), { recursive: true });
  await fs.writeFile(path.join(f.notes, 'logs', '.DS_Store'), 'Synthetic Finder file.');
  const result = await setupProject(f.options);
  assert.equal(result.logs.status, 'valid'); assert.equal(result.logs.unrelatedEntries, 1);
  assert.equal(await fs.readFile(path.join(f.notes, 'logs', '.DS_Store'), 'utf8'), 'Synthetic Finder file.');
});
