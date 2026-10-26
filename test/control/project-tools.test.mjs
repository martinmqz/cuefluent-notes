import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectTools, deriveProjectId, PROJECT_TOOLS } from '../../src/control/project-tools.mjs';
import { createDirectNoteTools, DIRECT_NOTE_TOOLS } from '../../src/control/direct-notes.mjs';
import { readProjectStatus } from '../../src/control/status.mjs';
import { createControlBridge } from '../../src/client/control-server.mjs';
import { describeFailure } from '../../src/diagnostics.mjs';
import { initializeStore, openStore, readSettings } from '../../src/storage/store.mjs';
import { interruptRemoval } from '../fixtures/exact-removal-worker.mjs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAnnualLog } from '../../src/logs/index.mjs';

const skillVersion = '0.18.0', systemZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
const content = '# Planning meeting\n\n## Decisions\nKeep the release small.\n';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-project-tools-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storeRoot = path.join(root, 'private');
  const folder = async (...names) => { const target = path.join(root, ...names); await fs.mkdir(target, { recursive: true }); return target; };
  // A fresh instance per call mirrors the server reopening the store after setup.
  const tools = async () => createProjectTools({ storeRoot, store: await openStore(storeRoot), skillVersion });
  const call = async (name, args) => (await tools()).call(name, args);
  const setup = args => call('cuefluent_setup', args);
  const settings = async () => readSettings(await openStore(storeRoot));
  const notes = async () => createDirectNoteTools({ store: await openStore(storeRoot), client: 'codex', skillVersion });
  const destination = name => ({ kind: 'directory', path: path.join(root, name) });
  return { root, storeRoot, folder, tools, call, setup, settings, notes, destination };
}

test('first setup creates the store and a project with an id derived from the folder name and the new-project defaults', async t => {
  const f = await fixture(t), project = await f.folder('Team Docs!');
  const result = await f.setup({ root: project, destination: f.destination('notes') });
  assert.equal(result.state, 'configured'); assert.equal(result.created, true);
  assert.deepEqual(Object.keys(result).sort(), ['created', 'logs', 'project', 'state']);
  assert.equal(result.project.id, 'team-docs'); assert.equal(result.project.root, project);
  assert.equal(result.project.tracking, 'manual'); assert.equal(result.project.saving, 'review');
  assert.deepEqual(result.project.activityLog, { enabled: true, timezone: systemZone, path: path.join(f.root, 'notes', 'logs') });
  assert.equal(result.logs.status, 'valid');
  assert.equal((await fs.stat(path.join(f.root, 'notes', 'logs'))).isDirectory(), true);
  const stored = await f.settings();
  assert.deepEqual(stored.value.projects, [result.project]);
  assert.equal(JSON.stringify(result).includes(stored.hash), false);
});

test('a file destination defaults to logging off, and enabling logging for it is refused with no writes', async t => {
  const f = await fixture(t), project = await f.folder('single');
  const target = { kind: 'file', path: path.join(f.root, 'notes', 'one.md') };
  const result = await f.setup({ root: project, destination: target });
  assert.deepEqual(result.project.activityLog, { enabled: false });
  assert.deepEqual(result.logs, { path: null, status: 'not-applicable' });
  assert.deepEqual(await fs.readdir(path.join(f.root, 'notes')), []);
  for (const activityLog of [{ enabled: true, timezone: 'UTC' }, { enabled: true }]) {
    const refused = await fixture(t), refusedProject = await refused.folder('single');
    await assert.rejects(refused.setup({ root: refusedProject, destination: { kind: 'file', path: path.join(refused.root, 'notes', 'one.md') }, activityLog }), { code: 'SETTINGS_INVALID' });
    await assert.rejects(fs.stat(refused.storeRoot), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(refused.root, 'notes')), { code: 'ENOENT' });
  }
});

test('derived ids are readable, bounded and unique, and a name collision never touches the other project', async t => {
  assert.equal(deriveProjectId('/work/_My Project--', new Set()), 'my-project');
  assert.equal(deriveProjectId('/work/Ünïcode Folder', new Set()), 'n-code-folder');
  assert.equal(deriveProjectId('/', new Set()), 'project'); assert.equal(deriveProjectId('/work/***', new Set()), 'project');
  assert.equal(deriveProjectId('/work/demo', new Set(['demo', 'demo-2'])), 'demo-3');
  const long = deriveProjectId(`/work/${'a'.repeat(300)}`, new Set());
  assert.equal(long.length, 128); assert.equal(deriveProjectId(`/work/${'a'.repeat(300)}`, new Set([long])).length, 128);
  assert.match(deriveProjectId(`/work/${'a'.repeat(300)}`, new Set([long])), /-2$/);
  const f = await fixture(t), first = await f.folder('one', 'shared'), second = await f.folder('two', 'shared'), third = await f.folder('three', 'shared');
  const a = await f.setup({ root: first, destination: f.destination('notes-a') });
  const before = (await f.settings()).value.projects[0];
  const b = await f.setup({ root: second, destination: f.destination('notes-b') });
  const c = await f.setup({ root: third, destination: f.destination('notes-c') });
  assert.deepEqual([a.project.id, b.project.id, c.project.id], ['shared', 'shared-2', 'shared-3']);
  assert.equal(b.created, true);
  assert.deepEqual((await f.settings()).value.projects[0], before);
  const listed = await (await f.notes()).call('cuefluent_projects', {});
  assert.deepEqual(listed.projects.map(item => [item.id, item.root]), [['shared', first], ['shared-2', second], ['shared-3', third]]);
});

test('an edit merges only supplied fields, selects by id or exact root, and keeps an established log timezone', async t => {
  const f = await fixture(t), project = await f.folder('demo');
  const created = await f.setup({ root: project, destination: f.destination('notes'), tracking: 'auto', saving: 'auto', activityLog: { enabled: false } });
  assert.equal(created.created, true);
  const moved = await f.setup({ id: 'demo', destination: f.destination('moved') });
  assert.equal(moved.created, false);
  assert.deepEqual({ ...moved.project, destination: undefined }, { ...created.project, destination: undefined });
  assert.deepEqual(moved.project.destination, f.destination('moved'));
  assert.equal(moved.project.tracking, 'auto'); assert.equal(moved.project.saving, 'auto'); assert.deepEqual(moved.project.activityLog, { enabled: false });
  assert.equal(moved.logs.status, 'absent');
  const unchanged = await f.settings(), byRoot = await f.setup({ root: project });
  assert.equal(byRoot.created, false); assert.deepEqual(byRoot.project, moved.project);
  assert.equal((await f.settings()).hash, unchanged.hash);
  const sameRoot = await f.setup({ id: 'demo', root: project, saving: 'review' });
  assert.equal(sameRoot.project.saving, 'review'); assert.equal(sameRoot.project.tracking, 'auto');

  const zone = ['America/Los_Angeles', 'Asia/Tokyo'].find(item => item !== systemZone);
  await fs.mkdir(path.join(f.root, 'moved', 'logs'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'moved', 'logs', '2025.md'), createAnnualLog({ year: 2025, timezone: zone, seriesId: 'existing-series', noteId: randomUUID(), createdAt: '2026-10-22T01:00:00.000Z', skillVersion }));
  const enabled = await f.setup({ id: 'demo', activityLog: { enabled: true } });
  assert.deepEqual(enabled.project.activityLog, { enabled: true, timezone: zone, path: path.join(f.root, 'moved', 'logs') });
  assert.equal(enabled.logs.seriesId, 'existing-series');
  const again = await f.setup({ id: 'demo', activityLog: { enabled: true } }), retained = await f.setup({ root: project, tracking: 'manual' });
  assert.equal(again.project.activityLog.timezone, zone); assert.deepEqual(retained.project.activityLog, enabled.project.activityLog);
  assert.equal(retained.project.tracking, 'manual'); assert.equal(retained.project.saving, 'review');
  const off = await f.setup({ id: 'demo', activityLog: { enabled: false } });
  assert.deepEqual(off.project.activityLog, { enabled: false }); assert.equal(off.logs.status, 'valid');
});

test('an id and root that name different projects are refused without changing anything', async t => {
  const f = await fixture(t), a = await f.folder('alpha-root'), b = await f.folder('beta-root'), c = await f.folder('gamma-root');
  await f.setup({ id: 'alpha', root: a, destination: f.destination('notes-a') });
  await f.setup({ id: 'beta', root: b, destination: f.destination('notes-b') });
  const before = await f.settings();
  for (const args of [{ id: 'alpha', root: b }, { id: 'alpha', root: c }, { id: 'gamma', root: a }, { id: 'beta', root: a, saving: 'auto' }]) {
    await assert.rejects(f.setup({ ...args, destination: f.destination('elsewhere') }), { code: 'SETUP_PROJECT_MISMATCH' });
  }
  assert.equal((await f.settings()).hash, before.hash);
  await assert.rejects(fs.stat(path.join(f.root, 'elsewhere')), { code: 'ENOENT' });
  const added = await f.setup({ id: 'gamma', root: c, destination: f.destination('notes-c') });
  assert.equal(added.created, true); assert.equal(added.project.id, 'gamma');
});

test('a pending run pins destination and saving mode, while other preferences stay editable', async t => {
  const f = await fixture(t), project = await f.folder('demo');
  await f.setup({ root: project, destination: f.destination('notes') });
  const direct = await f.notes();
  const draft = await direct.call('cuefluent_create_note', { projectId: 'demo', requestId: randomUUID(), target: 'plan.md', content, summary: 'Plan.' });
  assert.equal(draft.state, 'review');
  const before = await f.settings();
  for (const args of [{ destination: f.destination('other') }, { saving: 'auto' }]) await assert.rejects(f.setup({ id: 'demo', ...args }), { code: 'SETTINGS_PENDING_RUN' });
  await assert.rejects(fs.stat(path.join(f.root, 'other')), { code: 'ENOENT' });
  assert.equal((await f.settings()).hash, before.hash);
  const status = await f.call('cuefluent_status', { projectId: 'demo' });
  assert.equal(status.state, 'review'); assert.equal(status.run.id, draft.runId);
  const tracked = await f.setup({ id: 'demo', tracking: 'auto', activityLog: { enabled: false } });
  assert.equal(tracked.project.tracking, 'auto'); assert.deepEqual(tracked.project.activityLog, { enabled: false });
  assert.equal(tracked.project.saving, 'review');
  await direct.call('cuefluent_skip_note', { projectId: 'demo', runId: draft.runId, revision: draft.revision });
  const moved = await f.setup({ id: 'demo', destination: f.destination('other'), saving: 'auto' });
  assert.equal(moved.project.saving, 'auto'); assert.deepEqual(moved.project.destination, f.destination('other'));
});

test('a concurrent configuration is reported as a settings conflict with setup recovery guidance and overwrites nothing', async t => {
  const f = await fixture(t), a = await f.folder('first'), b = await f.folder('second');
  await f.setup({ root: a, destination: f.destination('notes-a') });
  const before = await f.settings();
  // This server started before another process created the store, so it still
  // sees none and proposes a first setup against the settings it inspected.
  const stale = createProjectTools({ storeRoot: f.storeRoot, store: null, skillVersion });
  const refused = await stale.call('cuefluent_setup', { root: b, destination: f.destination('notes-b') }).then(() => null, error => error);
  assert.equal(refused?.code, 'SETTINGS_CONFLICT');
  assert.equal((await f.settings()).hash, before.hash);
  await assert.rejects(fs.stat(path.join(f.root, 'notes-b')), { code: 'ENOENT' });
  const guidance = describeFailure({ code: 'SETTINGS_CONFLICT' }, { stage: 'tool', toolName: 'cuefluent_setup' });
  assert.equal(guidance.diagnostics.toolName, 'cuefluent_setup');
  assert.match(guidance.recovery, /cuefluent_projects/); assert.match(guidance.recovery, /repeat cuefluent_setup/);
  assert.doesNotMatch(guidance.recovery, /settingsHash|expectedHash|CLI/);
  const pending = describeFailure({ code: 'SETTINGS_PENDING_RUN' }, { stage: 'tool', toolName: 'cuefluent_setup' });
  assert.match(pending.recovery, /Settle the pending run before changing its destination or saving mode/);
  for (const code of ['SETUP_TOOL_ARGUMENT', 'SETUP_PROJECT_MISMATCH', 'SETTINGS_RETAINED_PROJECT', 'SETTINGS_INVALID', 'SETUP_PENDING']) {
    const described = describeFailure({ code }, { stage: 'tool', toolName: 'cuefluent_setup' });
    assert.equal(described.error, code); assert.doesNotMatch(described.recovery, /report the error code/i);
  }
  assert.equal(describeFailure({ code: 'SETUP_TOOL_ARGUMENT' }, { stage: 'tool', toolName: 'cuefluent_status' }).diagnostics.toolName, 'cuefluent_status');
});

test('status is unconfigured without a store and otherwise the read-only project status', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('cuefluent_status', { projectId: 'demo' }), { state: 'unconfigured' });
  await assert.rejects(fs.stat(f.storeRoot), { code: 'ENOENT' });
  await f.setup({ id: 'demo', root: await f.folder('demo'), destination: f.destination('notes') });
  const status = await f.call('cuefluent_status', { projectId: 'demo' }), store = await openStore(f.storeRoot);
  assert.deepEqual(status, await readProjectStatus(store, 'demo'));
  assert.equal(status.state, 'idle'); assert.equal(status.projectId, 'demo'); assert.equal(status.counts.chats, 0);
  assert.equal(status.settings.id, 'demo');
  await assert.rejects(f.call('cuefluent_status', { projectId: 'missing' }), { code: 'PROJECT_UNCONFIGURED' });
  for (const args of [{}, { projectId: 'bad id' }, { projectId: 'demo', extra: 1 }, { projectId: 7 }, null]) {
    await assert.rejects(f.call('cuefluent_status', args), { code: 'CONTROL_ARGUMENT_INVALID' });
  }
  await assert.rejects(f.call('cuefluent_unknown', {}), { code: 'CONTROL_TOOL_UNKNOWN' });
});

test('setup arguments are strict, and every refusal happens before any write', async t => {
  const f = await fixture(t), project = await f.folder('demo'), valid = { root: project, destination: f.destination('notes') };
  let reads = 0;
  const getter = Object.defineProperty({ destination: valid.destination }, 'root', { enumerable: true, get() { reads++; return project; } });
  const cases = [
    null, [], 'text', new (class Setup {})(), { [Symbol('hidden')]: 1 }, {}, { root: project }, { destination: valid.destination },
    { ...valid, extra: true }, getter, { ...valid, id: '-bad' }, { ...valid, id: 'has space' }, { ...valid, id: 'x'.repeat(129) }, { ...valid, id: 7 },
    { ...valid, tracking: 'sometimes' }, { ...valid, saving: 'manual' }, { ...valid, tracking: undefined },
    { ...valid, root: 'relative/project' }, { ...valid, root: `${project}/../demo` }, { ...valid, root: `${project}\n` }, { ...valid, root: `/${'a'.repeat(32768)}` }, { ...valid, root: 7 },
    { ...valid, destination: { kind: 'folder', path: f.destination('notes').path } }, { ...valid, destination: { kind: 'directory' } }, { ...valid, destination: 'notes' },
    { ...valid, destination: { kind: 'directory', path: 'notes' } }, { ...valid, destination: { ...f.destination('notes'), extra: 1 } },
    { ...valid, destination: Object.defineProperty({ kind: 'directory' }, 'path', { enumerable: true, get() { reads++; return f.destination('notes').path; } }) },
    { ...valid, activityLog: { enabled: false, timezone: 'UTC' } }, { ...valid, activityLog: { enabled: 'yes' } }, { ...valid, activityLog: { timezone: 'UTC' } },
    { ...valid, activityLog: { enabled: true, timezone: '' } }, { ...valid, activityLog: { enabled: true, timezone: 'Z'.repeat(129) } },
    { ...valid, activityLog: { enabled: true, timezone: 'UTC', path: path.join(f.root, 'notes', 'logs') } }, { ...valid, activityLog: { enabled: true, path: path.join(f.root, 'notes', 'logs') } },
    { ...valid, activityLog: true },
  ];
  for (const [index, args] of cases.entries()) await assert.rejects(f.setup(args), { code: 'SETUP_TOOL_ARGUMENT' }, `case ${index}`);
  assert.equal(reads, 0);
  assert.deepEqual(await fs.readdir(f.root), ['demo']);
  await f.setup(valid);
  const before = await f.settings();
  for (const args of [{ id: 'demo', tracking: 'x' }, { id: 'demo', activityLog: { enabled: false, timezone: 'UTC' } }, { root: 'demo' }, { id: 'demo', extra: 1 }]) {
    await assert.rejects(f.setup(args), { code: 'SETUP_TOOL_ARGUMENT' });
  }
  assert.equal((await f.settings()).hash, before.hash);
});

test('the tools are advertised through the real bridge and a setup call returns the configured project', async t => {
  for (const client of ['claude', 'codex']) {
    const f = await fixture(t), project = await f.folder('demo');
    const names = new Set(PROJECT_TOOLS.map(item => item.name));
    assert.deepEqual([...names].sort(), ['cuefluent_setup', 'cuefluent_status']);
    assert.equal(DIRECT_NOTE_TOOLS.some(item => names.has(item.name)), false);
    // The server recreates its handlers over the reopened store before each call.
    const handlers = async () => {
      const store = await openStore(f.storeRoot);
      return { projects: createProjectTools({ storeRoot: f.storeRoot, store, skillVersion }), notes: createDirectNoteTools({ store, client, skillVersion }) };
    };
    const first = await handlers();
    const bridge = createControlBridge({ client, codexAdapter: { bindCommand: () => assert.fail('No native reads') }, executeInvocation: () => assert.fail('No native action'), readInvocation: () => assert.fail('No native handle'),
      directNotes: { tools: [...first.notes.tools, ...first.projects.tools], async call(name, ...input) {
        const current = await handlers(); return (names.has(name) ? current.projects : current.notes).call(name, ...input);
      } } });
    let id = 1;
    const protocol = bridge.protocol({ version: skillVersion });
    await protocol({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } });
    await protocol({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const call = async (name, args) => (await protocol({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args,
      ...(client === 'codex' ? { _meta: { 'x-codex-turn-metadata': { session_id: 'native', thread_id: 'native', turn_id: `turn-${id}` } } } : {}) } })).result;
    const listed = (await protocol({ jsonrpc: '2.0', id: id++, method: 'tools/list' })).result.tools;
    const setupTool = listed.find(item => item.name === 'cuefluent_setup'), statusTool = listed.find(item => item.name === 'cuefluent_status');
    assert.equal(setupTool.annotations.readOnlyHint, false); assert.equal(statusTool.annotations.readOnlyHint, true);
    assert.deepEqual(setupTool.inputSchema.required, []); assert.equal(setupTool.inputSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(setupTool.inputSchema.properties, 'settingsHash'), false);
    assert.equal((await call('cuefluent_status', { projectId: 'demo' })).structuredContent.state, 'unconfigured');
    const result = await call('cuefluent_setup', { root: project, destination: f.destination('notes'), saving: 'auto' });
    assert.equal(result.isError, false); assert.equal(result.structuredContent.state, 'configured');
    assert.equal(result.structuredContent.created, true); assert.equal(result.structuredContent.project.id, 'demo');
    assert.equal(result.structuredContent.project.saving, 'auto'); assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const refused = await call('cuefluent_setup', { id: 'demo', root: await f.folder('other') });
    assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error, 'SETUP_PROJECT_MISMATCH');
    assert.equal(refused.structuredContent.diagnostics.toolName, 'cuefluent_setup'); assert.match(refused.structuredContent.recovery, /cuefluent_projects/);
    assert.equal(JSON.stringify(refused).includes(f.root), false);
    const invalid = await call('cuefluent_setup', { root: project, destination: f.destination('notes'), settingsHash: 'a'.repeat(64) });
    assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error, 'SETUP_TOOL_ARGUMENT');
  }
});

test('an identical setup repeated after an interrupted journal removal completes that setup, keeps the adopted log timezone, and then applies new choices', async t => {
  const f = await fixture(t), project = await f.folder('journal'), notes = f.destination('notes');
  await fs.mkdir(path.join(notes.path, 'logs'), { recursive: true });
  const annual = createAnnualLog({ year: 2025, timezone: 'Asia/Tokyo', seriesId: 'tokyo-series', noteId: randomUUID(), createdAt: '2026-10-22T01:00:00.000Z', skillVersion });
  await fs.writeFile(path.join(notes.path, 'logs', '2025.md'), annual);
  // The first setup publishes its settings, adopting the series timezone, and
  // stops while removing its journal: the journal still records the request
  // with the system timezone the tool proposed.
  await interruptRemoval({ root: f.storeRoot, relative: 'config/setup.json', operation: 'setup', options: { storeRoot: f.storeRoot, expectedHash: null, skillVersion,
    project: { id: 'journal', root: project, destination: notes, activityLog: { enabled: true, timezone: systemZone } } } });
  assert.equal((await f.settings()).value.projects[0].activityLog.timezone, 'Asia/Tokyo');
  // The identical tool arguments complete it, and the established series keeps its timezone.
  const result = await f.setup({ id: 'journal', root: project, destination: notes });
  assert.equal(result.state, 'configured'); assert.equal(result.project.activityLog.timezone, 'Asia/Tokyo');
  assert.equal(result.logs.seriesId, 'tokyo-series'); assert.equal(result.project.tracking, 'manual');
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'config')), ['settings.json']);
  assert.deepEqual(await fs.readFile(path.join(notes.path, 'logs', '2025.md')), annual);
  // A different choice for the same project also completes the interrupted setup first, then applies.
  await interruptRemoval({ root: f.storeRoot, relative: 'config/setup.json', operation: 'setup', options: { storeRoot: f.storeRoot, expectedHash: (await f.settings()).hash, skillVersion,
    project: { ...(await f.settings()).value.projects[0], activityLog: { enabled: true, timezone: 'Asia/Tokyo' }, saving: 'auto' } } });
  const changed = await f.setup({ id: 'journal', tracking: 'auto' });
  assert.equal(changed.project.saving, 'auto'); assert.equal(changed.project.tracking, 'auto'); assert.equal(changed.created, false);
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'config')), ['settings.json']);
  // A journal for another project remains a refusal that changes nothing.
  const other = await f.folder('other');
  await interruptRemoval({ root: f.storeRoot, relative: 'config/setup.json', operation: 'setup', options: { storeRoot: f.storeRoot, expectedHash: (await f.settings()).hash, skillVersion,
    project: { id: 'other', root: other, destination: f.destination('other-notes'), activityLog: { enabled: false } } } });
  const before = await f.settings();
  await assert.rejects(f.setup({ id: 'journal', saving: 'review' }), { code: 'SETUP_PENDING' });
  assert.equal((await f.settings()).hash, before.hash);
  assert.equal((await f.setup({ id: 'other', root: other, destination: f.destination('other-notes'), activityLog: { enabled: false } })).project.id, 'other');
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'config')), ['settings.json']);
});

test('setup resumes a first initialization interrupted before its layout or settings exist', async t => {
  const f = await fixture(t), project = await f.folder('resume');
  // The scaffold of an interrupted first initialization: private directories, no layout.
  for (const relative of ['config', 'store/locks', 'store/projects', 'store/chats']) await fs.mkdir(path.join(f.storeRoot, relative), { recursive: true, mode: 0o700 });
  await assert.rejects(openStore(f.storeRoot), { code: 'FILE_MISSING' });
  const unopened = createProjectTools({ storeRoot: f.storeRoot, store: null, skillVersion });
  assert.deepEqual(await unopened.call('cuefluent_status', { projectId: 'resume' }), { state: 'unconfigured' });
  const result = await unopened.call('cuefluent_setup', { root: project, destination: f.destination('notes') });
  assert.equal(result.state, 'configured'); assert.equal(result.created, true); assert.equal(result.project.id, 'resume');
  assert.deepEqual((await f.settings()).value.projects.map(item => item.id), ['resume']);

  // A layout published without its settings file is resumed the same way by a server that opened it.
  const g = await fixture(t), second = await g.folder('second');
  await initializeStore(g.storeRoot);
  await fs.unlink(path.join(g.storeRoot, 'config', 'settings.json'));
  const opened = createProjectTools({ storeRoot: g.storeRoot, store: await openStore(g.storeRoot), skillVersion });
  const resumed = await opened.call('cuefluent_setup', { root: second, destination: g.destination('notes') });
  assert.equal(resumed.state, 'configured'); assert.equal(resumed.project.id, 'second');
  assert.deepEqual((await g.settings()).value.projects.map(item => item.id), ['second']);
});

test('an unpublished interrupted setup is never replayed for a different proposal: the refusal stays and nothing is written', async t => {
  const f = await fixture(t), project = await f.folder('held'), base = await f.folder('base');
  await f.setup({ root: base, destination: f.destination('base-notes'), activityLog: { enabled: false } });
  const settings = await f.settings();
  // A setup of a second project stops after publishing its first annual log,
  // before its settings exist: the journal holds an unfinished intent.
  const options = { storeRoot: f.storeRoot, expectedHash: settings.hash, skillVersion, now: '2026-10-22T01:00:00.000Z',
    project: { id: 'held', root: project, destination: { kind: 'directory', path: path.join(f.root, 'notes') }, activityLog: { enabled: true, timezone: 'UTC' } } };
  const child = fork(fileURLToPath(new URL('../fixtures/setup-worker.mjs', import.meta.url)), [f.root, JSON.stringify(options), 'annual'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  for (let tries = 0; ; tries++) {
    try { await fs.access(path.join(f.root, 'setup-boundary')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(tries < 300, `Synthetic setup did not reach its boundary: ${stderr}`); await delay(20);
  }
  child.kill('SIGKILL'); await exited;
  assert.deepEqual((await f.settings()).value.projects.map(item => item.id), ['base']);
  const annual = await fs.readFile(path.join(f.root, 'notes', 'logs', '2026.md')), logsBefore = await fs.readdir(path.join(f.root, 'notes', 'logs'));
  // A different proposal for that project is refused and performs none of the
  // unfinished request's writes; the opt-out destination is not created either.
  await assert.rejects(f.setup({ id: 'held', root: project, destination: f.destination('new-notes'), activityLog: { enabled: false } }), { code: 'SETUP_PENDING' });
  await assert.rejects(fs.stat(path.join(f.root, 'new-notes')), { code: 'ENOENT' });
  assert.deepEqual((await f.settings()).value.projects.map(item => item.id), ['base']);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'notes', 'logs', '2026.md')), annual);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'notes', 'logs')), logsBefore);
  // Repeating the interrupted request itself completes it.
  const completed = await f.setup({ id: 'held', root: project, destination: { kind: 'directory', path: path.join(f.root, 'notes') }, activityLog: { enabled: true, timezone: 'UTC' } });
  assert.equal(completed.state, 'configured'); assert.equal(completed.project.activityLog.timezone, 'UTC');
  assert.deepEqual((await f.settings()).value.projects.map(item => item.id).sort(), ['base', 'held']);
  assert.deepEqual(await fs.readdir(path.join(f.storeRoot, 'config')), ['settings.json']);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'notes', 'logs', '2026.md')), annual);
});
