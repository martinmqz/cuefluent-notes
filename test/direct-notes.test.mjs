import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseDocument } from 'yaml';
import { createProject } from '../src/core/settings.mjs';
import { inspectMetadata } from '../src/notes/index.mjs';
import { createRun, validateRun, runRevision } from '../src/core/run.mjs';
import { initializeStore, withProject, readSettings, updateSettings } from '../src/storage/store.mjs';
import { readJSON, writeJSON, hashBytes } from '../src/storage/files.mjs';
import { readDraftArtifact } from '../src/storage/draft-artifacts.mjs';
import { ownDirectAttempt, withCurrentAttempt, inspectAttempt } from '../src/storage/attempts.mjs';
import { setChatTracking, queueRelative } from '../src/storage/chats.mjs';
import { appendQueueRecord, encodeQueueRecord, inspectQueue } from '../src/storage/queue.mjs';
import { createDirectNoteTools, DIRECT_NOTE_BYTES, DIRECT_READ_BYTES } from '../src/control/direct-notes.mjs';
import { createControlBridge, CONTROL_LIMITS } from '../src/client/control-server.mjs';
import { readProjectStatus } from '../src/control/status.mjs';
import { prepareProcessing } from '../src/processing/prepare.mjs';
import { runProcessingWork } from '../src/processing/worker.mjs';
import { openNoteWorkspace, WORKSPACE_LIMITS } from '../src/processing/workspace.mjs';
import { persistDraftManifest } from '../src/processing/draft.mjs';
import { pinProcessingLogging } from '../src/processing/logging.mjs';

const content = '# Planning meeting\n\n## Decisions\nKeep the release small.\n\n## Actions\nSam will verify the result.\n';
async function fixture(t, { saving = 'review', client = 'codex', file = false, expandedMetadata = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-direct-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  const project = createProject({ id: 'demo', root: cwd, destination: { kind: file ? 'file' : 'directory', path: file ? path.join(notes, 'explicit.md') : notes }, saving, expandedMetadata });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  // Queued decisions hand off to the separate worker; this fixture records the
  // launch request and refuses it so no detached process starts.
  const launches = [];
  const handler = createDirectNoteTools({ store, client, skillVersion: '0.16.0', launchProcessing: context => {
    launches.push(context); throw Object.assign(new Error('Synthetic launch refusal.'), { code: 'SYNTHETIC_LAUNCH' });
  } });
  const tools = { tools: handler.tools, call: (name, args) => handler.call(name, args) };
  const request = { projectId: project.id, requestId: randomUUID(), target: file ? 'explicit.md' : 'meetings/planning.md', content, summary: 'Planning decisions and actions.' };
  const create = input => tools.call('cuefluent_create_note', { ...request, ...input });
  const review = (runId = request.requestId, page = {}) => tools.call('cuefluent_review_note', { projectId: project.id, runId, ...page });
  // A decision cites the revision the user reviewed; completed outcomes replay
  // with any well-formed revision because no further decision is executed.
  const decide = async (action, runId = request.requestId, revision) => tools.call(`cuefluent_${action}_note`,
    { projectId: project.id, runId, revision: revision ?? (await review(runId)).revision ?? 'f'.repeat(64) });
  const call = (action, runId, revision) => action === 'review' ? review(runId) : decide(action, runId, revision);
  return { root, cwd, notes, project, store, tools, handler, launches, request, create, review, decide, call };
}

test('direct review creates one preview from supplied context without enrollment, queues, or a model, then saves exactly that draft', async t => {
  const f = await fixture(t), before = await readSettings(f.store);
  const draft = await f.create();
  assert.equal(draft.state, 'review'); assert.equal(draft.drafts.length, 1); assert.equal(draft.draftCount, 1);
  assert.equal(draft.kind, 'direct'); assert.deepEqual(draft.choices, ['Save', 'Discard', 'Keep pending']);
  assert.match(draft.revision, /^[a-f0-9]{64}$/); assert.equal(draft.next, null);
  assert.equal(draft.drafts[0].content, content);
  assert.doesNotMatch(draft.drafts[0].content, /<!--|skill_version:|session_id:|sources:/);
  const { run } = await inspectAttempt(f.store, 'demo');
  const retained = await readDraftArtifact(f.store.pin, run.artifacts, run.drafts[0].id);
  assert.match(retained.toString(), /skill_version: 0.16.0/);
  assert.doesNotMatch(retained.toString(), /session_id:|sources:/);
  assert.deepEqual(await fs.readdir(f.notes), []);
  await assert.rejects(fs.access(path.join(f.store.root, 'processing')), { code: 'ENOENT' });
  const status = await readProjectStatus(f.store, 'demo');
  assert.equal(status.counts.chats, 0); assert.equal(status.counts.queued, 0);
  assert.equal(status.run.scope.kind, 'direct'); assert.equal(status.run.selected, 0);
  assert.deepEqual(await f.create(), draft); assert.deepEqual(await f.call('review'), draft);
  const saved = await f.call('save'); assert.equal(saved.state, 'saved'); assert.equal(saved.result.counts.saved, 1);
  assert.equal(saved.result.counts.handled, 0);
  assert.deepEqual(await fs.readFile(saved.result.paths[0]), retained);
  assert.equal(hashBytes(retained), draft.drafts[0].hash);
  const written = await fs.stat(saved.result.paths[0]);
  assert.deepEqual(await f.create(), saved); assert.deepEqual(await f.call('save'), saved);
  assert.equal((await fs.stat(saved.result.paths[0])).mtimeMs, written.mtimeMs);
  assert.equal((await readProjectStatus(f.store, 'demo')).run, null);
  assert.deepEqual(await readSettings(f.store), before);
});

test('direct document sources are hidden from previews, saved exactly, and bound to pending and completed retries', async t => {
  const f = await fixture(t), sources = [{ type: 'document', ref: 'Synthetic meeting', locator: '00:48–04:58' }];
  const preview = await f.create({ sources });
  assert.equal(preview.drafts[0].content, content);
  const { run } = await inspectAttempt(f.store, 'demo');
  const bytes = await readDraftArtifact(f.store.pin, run.artifacts, run.drafts[0].id);
  assert.deepEqual(inspectMetadata(bytes).value.sources, sources);
  assert.equal(preview.drafts[0].hash, hashBytes(bytes));
  assert.deepEqual(await f.create({ sources }), preview);
  const changed = [{ ...sources[0], locator: '05:23–07:35' }];
  await assert.rejects(f.create({ sources: changed }), { code: 'DIRECT_NOTE_REQUEST_CHANGED' });
  await assert.rejects(f.create(), { code: 'DIRECT_NOTE_REQUEST_CHANGED' });
  const saved = await f.call('save');
  assert.ok((await fs.readFile(saved.result.paths[0])).equals(bytes));
  assert.deepEqual(await f.create({ sources }), saved);
  await assert.rejects(f.create({ sources: changed }), { code: 'DIRECT_NOTE_REQUEST_CHANGED' });
});

test('direct source-only updates retain original metadata and reject conflicting descriptions before reserving a run', async t => {
  const f = await fixture(t, { saving: 'auto' }), source = { type: 'document', ref: 'Synthetic meeting', description: 'Original account' };
  const saved = await f.create({ sources: [source] }), target = saved.result.paths[0], original = await fs.readFile(target);
  const addition = { type: 'document', ref: 'Synthetic design', locator: 'Agreed scope' };
  const update = { ...f.request, requestId: randomUUID(), expectedHash: hashBytes(original), sources: [addition] };
  const outcome = await f.tools.call('cuefluent_update_note', update), revised = await fs.readFile(target);
  assert.equal(outcome.state, 'saved'); assert.equal(outcome.result.counts.saved, 1);
  assert.ok(revised.toString().endsWith(content));
  assert.deepEqual(inspectMetadata(revised).value.sources, [source, addition]);
  assert.equal(inspectMetadata(revised).value.id, inspectMetadata(original).value.id);
  await assert.rejects(f.tools.call('cuefluent_update_note', { ...update, requestId: randomUUID(), expectedHash: hashBytes(revised), sources: [{ ...source, description: 'Different account' }] }), { code: 'NOTE_SOURCE_CONFLICT' });
  assert.equal((await readProjectStatus(f.store, 'demo')).run, null); assert.ok((await fs.readFile(target)).equals(revised));
  const written = await fs.stat(target);
  const unchanged = await f.tools.call('cuefluent_update_note', { ...update, requestId: randomUUID(), expectedHash: hashBytes(revised) });
  assert.equal(unchanged.result.counts.saved, 0); assert.ok((await fs.readFile(target)).equals(revised));
  assert.equal((await fs.stat(target)).mtimeMs, written.mtimeMs);
});

test('invalid document sources and additions to plain notes never create pending work or replace note bytes', async t => {
  const f = await fixture(t), source = { type: 'document', ref: 'Synthetic source' };
  for (const sources of [null, {}, [{ type: 'session', client: 'codex', session_id: 'invented', unit_id: 'invented', revision: 'a'.repeat(64) }], [{ ...source, ref: 'x'.repeat(2049) }]]) {
    await assert.rejects(f.create({ sources }), { code: 'NOTE_METADATA_INVALID' });
    assert.equal((await readProjectStatus(f.store, 'demo')).run, null);
  }
  const target = path.join(f.notes, 'plain.md'); await fs.writeFile(target, content);
  await assert.rejects(f.tools.call('cuefluent_update_note', { ...f.request, target: 'plain.md', expectedHash: hashBytes(content), sources: [source] }), { code: 'NOTE_SOURCES_UNSUPPORTED' });
  assert.equal((await readProjectStatus(f.store, 'demo')).run, null); assert.equal(await fs.readFile(target, 'utf8'), content);
  const draft = await f.create({ sources: [] });
  assert.deepEqual(await f.create(), draft, 'an empty list has the same request identity as omitted sources');
  await f.call('skip');
});

test('approval previews omit internal aliases while preserving Markdown, Unicode, newlines and literal code examples', async t => {
  const f = await fixture(t);
  const decisionsAlias = '<!-- aliases: release choice -->\r\n';
  const actionsAlias = '<!-- aliases: next steps -->\r\n';
  const body = '# Planning café\r\n\r\n## Decisions\r\n' + decisionsAlias +
    'Keep **all details**, including [documentation](https://example.com).\r\n\r\n' +
    '```markdown\r\n<!-- aliases: a literal example -->\r\n<!-- cuefluent -->\r\n```\r\n\r\n' +
    'Inline `<!-- aliases: literal -->` stays visible.\r\n\r\n' +
    '    <!-- aliases: indented example -->\r\n\r\n' +
    '## Actions\r\n' + actionsAlias + '- Sam will verify the result.\r\n';
  const preview = await f.create({ content: body });
  assert.equal(preview.drafts[0].content, body.replace(decisionsAlias, '').replace(actionsAlias, ''));
  assert.deepEqual(await f.call('review'), preview);
  const saved = await f.call('save'), bytes = await fs.readFile(saved.result.paths[0]);
  assert.equal(hashBytes(bytes), preview.drafts[0].hash);
  assert.ok(bytes.toString().endsWith(body));
  assert.notEqual(hashBytes(preview.drafts[0].content), preview.drafts[0].hash);
});

test('auto direct saving returns a saved path and leaves every existing queued record intact', async t => {
  const f = await fixture(t, { saving: 'auto', client: 'claude' });
  await setChatTracking(f.store, { client: 'claude', sessionId: 'synthetic', promptId: 'track', action: 'track', cwd: f.cwd, sourcePath: null });
  const relative = queueRelative('claude', 'synthetic');
  await withProject(f.store, 'demo', () => appendQueueRecord(f.store.pin, relative, encodeQueueRecord('input', Buffer.from('{"text":"Unrelated queued input"}'))));
  const queue = await inspectQueue(f.store.pin, relative);
  const result = await f.create(); assert.equal(result.state, 'saved');
  assert.ok((await fs.readFile(result.result.paths[0], 'utf8')).endsWith(content));
  assert.deepEqual(await inspectQueue(f.store.pin, relative), queue);
  await assert.rejects(fs.access(path.join(f.store.root, 'processing')), { code: 'ENOENT' });
});

test('rejected content, reserved paths, existing targets and invalid arguments leave no pending run or note writes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.notes, 'existing.md'), '# Keep\n\n## Content\nOriginal.\n');
  const cases = [
    { content: 'No heading.' }, { content: `${content}<!-- cuefluent\nschema_version: 1\n-->\n` },
    { target: '../outside.md' }, { target: 'logs/2026.md' }, { target: 'existing.md' },
    { content: 'x'.repeat(DIRECT_NOTE_BYTES + 1) }, { content: '界'.repeat(DIRECT_NOTE_BYTES / 2) },
    { projectId: 'missing' }, { projectId: 'demo\n' }, { requestId: 'not-a-uuid' }, { requestId: `${f.request.requestId}\n` }, { summary: '' }, { sessionId: 'invented' },
  ];
  for (const input of cases) {
    await assert.rejects(f.create(input));
    assert.equal((await readProjectStatus(f.store, 'demo')).run, null);
  }
  assert.equal(await fs.readFile(path.join(f.notes, 'existing.md'), 'utf8'), '# Keep\n\n## Content\nOriginal.\n');
  assert.deepEqual(await fs.readdir(f.notes), ['existing.md']);
  let read = false;
  const input = Object.defineProperty({ ...f.request }, 'content', { enumerable: true, get() { read = true; return content; } });
  await assert.rejects(f.tools.call('cuefluent_create_note', input), { code: 'DIRECT_NOTE_ARGUMENT' }); assert.equal(read, false);
});

test('manual edits and replaced parent directories after review remain conflicts; skip leaves them untouched', async t => {
  const f = await fixture(t);
  const draft = await f.create(), target = draft.drafts[0].target;
  await fs.mkdir(path.dirname(target)); await fs.writeFile(target, '# Manual\n\n## Keep\nUser text.\n');
  await assert.rejects(f.call('save'));
  assert.equal(await fs.readFile(target, 'utf8'), '# Manual\n\n## Keep\nUser text.\n');
  assert.equal((await f.call('review')).drafts[0].content, draft.drafts[0].content);
  assert.equal((await f.call('skip')).state, 'skipped');
  assert.equal(await fs.readFile(target, 'utf8'), '# Manual\n\n## Keep\nUser text.\n');
  const g = await fixture(t); await fs.mkdir(path.join(g.notes, 'meetings'));
  await g.create(); await fs.rename(path.join(g.notes, 'meetings'), path.join(g.notes, 'old'));
  await fs.mkdir(path.join(g.notes, 'meetings')); await assert.rejects(g.call('save'));
  assert.deepEqual(await fs.readdir(path.join(g.notes, 'meetings')), []);
});

test('one pending run blocks other requests, pins settings, and rejects changed retries and wrong review IDs', async t => {
  const f = await fixture(t); const original = await f.create();
  const second = await f.create({ requestId: randomUUID(), target: 'another.md' }); assert.equal(second.state, 'busy');
  await assert.rejects(f.create({ content: content + '\nChanged.\n' }), { code: 'DIRECT_NOTE_REQUEST_CHANGED' });
  await assert.rejects(f.call('save', randomUUID(), original.revision), { code: 'REVIEW_RUN_CHANGED' });
  assert.deepEqual(await f.call('review'), original);
  const settings = await readSettings(f.store);
  await assert.rejects(updateSettings(f.store, { schemaVersion: 1, projects: [{ ...f.project, saving: 'auto' }] }, { expectedHash: settings.hash }));
  await f.call('skip'); assert.equal((await readProjectStatus(f.store, 'demo')).run, null);
  const secondRun = await f.create({ requestId: randomUUID() }); assert.equal(secondRun.state, 'review');
});

test('a pending queued run keeps direct submissions busy; its decisions cite its revision and go to the separate worker', async t => {
  const f = await fixture(t);
  await setChatTracking(f.store, { client: 'codex', sessionId: 'synthetic', promptId: 'track', action: 'track', cwd: f.cwd, sourcePath: null });
  await withProject(f.store, 'demo', () => appendQueueRecord(f.store.pin, queueRelative('codex', 'synthetic'), encodeQueueRecord('input', Buffer.from('{"text":"Queued"}'))));
  const { run } = await prepareProcessing(f.store, 'demo', { kind: 'project' }, { reconcileChat: async () => ({ status: 'caught-up' }) });
  assert.equal((await f.create()).state, 'busy');
  const review = await f.call('review', run.id);
  assert.equal(review.state, 'interrupted'); assert.equal(review.kind, 'project'); assert.equal(review.phase, 'drafting');
  assert.deepEqual(review.drafts, []); assert.deepEqual(review.choices, ['Skip; keep input', 'Keep pending']);
  // Unfinished drafting has nothing reviewed to save; process retries it.
  await assert.rejects(f.call('save', run.id), { code: 'RUN_PHASE_INVALID' });
  await assert.rejects(f.call('skip', run.id, 'e'.repeat(64)), { code: 'REVIEW_REVISION_STALE' });
  assert.equal(f.launches.length, 0);
  await assert.rejects(f.call('skip', run.id), { code: 'SYNTHETIC_LAUNCH' });
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].action, 'skip');
  assert.equal(f.launches[0].runId, run.id); assert.equal(f.launches[0].revision, review.revision);
  assert.deepEqual((await inspectAttempt(f.store, 'demo')).run, run);
  for (const action of ['save', 'skip']) await assert.rejects(f.tools.call(`cuefluent_${action}_note`, { projectId: 'demo', runId: run.id }), { code: 'DIRECT_NOTE_ARGUMENT' });
});

test('direct OS ownership prevents concurrent save and stale publication, and releases on failure', async t => {
  const f = await fixture(t); await f.create(); let owner, release, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const held = ownDirectAttempt(f.store, 'demo', f.request.requestId, async value => {
    owner = value; ready(); await new Promise(resolve => { release = resolve; });
  });
  await started;
  try {
    assert.equal((await f.call('save')).state, 'running');
    await assert.rejects(ownDirectAttempt(f.store, 'demo', f.request.requestId, async () => {}), { code: 'ATTEMPT_ACTIVE' });
  } finally { release(); await held; }
  assert.throws(() => withCurrentAttempt(owner, () => {}), { code: 'ATTEMPT_NOT_OWNED' });
  await assert.rejects(ownDirectAttempt(f.store, 'demo', f.request.requestId, async () => { throw new Error('synthetic interruption'); }));
  assert.equal((await inspectAttempt(f.store, 'demo')).active, false);
  assert.equal((await f.call('save')).state, 'saved');
});

test('interrupted direct drafting recovers exact durable bytes and never starts a native model', async t => {
  const f = await fixture(t); const preview = await f.create();
  await withProject(f.store, 'demo', async ({ directory }) => {
    const saved = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...saved.value, phase: 'drafting', drafts: [] }), { expectedHash: saved.hash });
  });
  let models = 0;
  const result = await ownDirectAttempt(f.store, 'demo', f.request.requestId, owner => runProcessingWork(f.store, owner,
    { action: 'process', client: 'codex', skillVersion: '0.16.0', runClient: () => { models++; } }));
  assert.equal(result.state, 'review');
  assert.equal(models, 0);
  const recovered = await f.create(); assert.equal(recovered.state, 'review'); assert.deepEqual(recovered.drafts, preview.drafts);
  assert.equal((await f.call('save')).state, 'saved');
});

test('explicit file destinations are honored and direct scopes can never consume queued input', async t => {
  const f = await fixture(t, { file: true, saving: 'auto' });
  await assert.rejects(f.create({ target: 'different.md' }));
  assert.equal((await f.create()).result.paths[0], f.project.destination.path);
  const scope = { kind: 'direct', requestHash: hashBytes('request') };
  assert.equal(createRun(f.project, [], { scope }).selection.length, 0);
  assert.throws(() => createRun(f.project, []), { code: 'RUN_INVALID' });
  assert.throws(() => createRun(f.project, [{ client: 'codex', sessionId: 's', recordId: 'r', hash: hashBytes('input') }], { scope }), { code: 'RUN_INVALID' });
  await assert.rejects(prepareProcessing(f.store, 'demo', scope, { reconcileChat: () => assert.fail('No source reads') }), { code: 'PROCESSING_SCOPE_INVALID' });
});

test('both native MCP hosts expose direct creation without binding or inspecting native conversation', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, { client, saving: 'auto' });
    const bridge = createControlBridge({ client, directNotes: f.tools, codexAdapter: { bindCommand: () => assert.fail('No native reads') },
      executeInvocation: () => assert.fail('No native action'), readInvocation: () => assert.fail('No native handle') });
    assert.ok(bridge.tools.some(item => item.name === 'cuefluent_create_note'));
    const listed = await bridge.call('cuefluent_projects', {}); assert.equal(listed.projects[0].saving, 'auto');
    const result = await bridge.call('cuefluent_create_note', f.request); assert.equal(result.state, 'saved');
    const unknown = createDirectNoteTools({ store: null, client, skillVersion: '0.16.0' });
    assert.equal((await unknown.call('cuefluent_projects', {})).state, 'unconfigured');
    assert.equal((await unknown.call('cuefluent_create_note', f.request)).state, 'unconfigured');
  }
});

test('tampering with retained draft bytes cannot become an approved write', async t => {
  const f = await fixture(t); await f.create();
  const { run } = await inspectAttempt(f.store, 'demo');
  const bytes = await readDraftArtifact(f.store.pin, run.artifacts, run.drafts[0].id);
  const folder = path.join(f.store.root, run.artifacts.relative), names = await fs.readdir(folder);
  const payload = names.find(name => name.endsWith('.draft'));
  assert.ok(payload); await fs.writeFile(path.join(folder, payload), Buffer.from(bytes.toString().replace('release small', 'release large')));
  await assert.rejects(f.call('review')); await assert.rejects(f.call('save'));
  assert.deepEqual(await fs.readdir(f.notes), []);
});

async function nativeTools(f, { client = 'codex' } = {}) {
  const bridge = createControlBridge({ client, directNotes: f.tools, codexAdapter: { bindCommand: () => assert.fail('No native transcript reads') },
    executeInvocation: () => assert.fail('No native commands'), readInvocation: () => assert.fail('No native handle') });
  let id = 1;
  const protocol = bridge.protocol({ version: '0.16.0' });
  await protocol({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } });
  await protocol({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { protocol, call: async (name, args) => {
    const params = { name, ...(args === undefined ? {} : { arguments: args }), ...(client === 'codex' ? {
      _meta: { 'x-codex-turn-metadata': { session_id: 'native-session', thread_id: 'native-session', turn_id: `turn-${id}` } },
    } : {}) };
    const response = await protocol({ jsonrpc: '2.0', id: id++, method: 'tools/call', params });
    return response.result.isError ? JSON.parse(response.result.content[0].text) : response.result.structuredContent;
  } };
}

test('both MCP hosts execute project/list/read/update through the real response contract and save exact reviewed bytes', async t => {
  for (const client of ['claude', 'codex']) {
    const f = await fixture(t, { client }), native = await nativeTools(f, { client });
    const target = path.join(f.notes, 'existing.md'); await fs.writeFile(target, content);
    assert.equal((await native.call('cuefluent_projects')).state, 'configured');
    const listed = await native.call('cuefluent_list_notes', { projectId: 'demo' });
    assert.equal(listed.state, 'listed'); assert.equal(listed.entries[0].target, target);
    const read = await native.call('cuefluent_read_note', { projectId: 'demo', target });
    assert.equal(read.state, 'read'); assert.equal(read.next, null);
    const changed = content.replace('small', 'focused');
    const preview = await native.call('cuefluent_update_note', { ...f.request, target, expectedHash: read.hash, content: changed });
    assert.equal(preview.state, 'review'); assert.equal(preview.drafts[0].content, changed);
    assert.equal(await fs.readFile(target, 'utf8'), content);
    const reviewed = await native.call('cuefluent_review_note', { projectId: 'demo', runId: f.request.requestId });
    assert.equal(reviewed.state, 'review'); assert.equal(reviewed.revision, preview.revision);
    assert.equal((await native.call('cuefluent_save_note', { projectId: 'demo', runId: f.request.requestId })).error, 'DIRECT_NOTE_ARGUMENT');
    const saved = await native.call('cuefluent_save_note', { projectId: 'demo', runId: f.request.requestId, revision: reviewed.revision });
    assert.equal(saved.state, 'saved');
    assert.equal(hashBytes(await fs.readFile(target)), preview.drafts[0].hash);
  }
});

test('a note within the cap is read whole with its hash; an update needs only that hash, and a larger original is refused unchanged', async t => {
  const f = await fixture(t, { saving: 'auto' }), target = path.join(f.notes, 'existing.md');
  const original = content + '\n' + 'Useful context with café and 界.\n'.repeat(900); await fs.writeFile(target, original);
  assert.ok(Buffer.byteLength(original) > 8192 && Buffer.byteLength(original) < DIRECT_NOTE_BYTES);
  const read = await f.tools.call('cuefluent_read_note', { projectId: 'demo', target });
  assert.deepEqual([read.state, read.exists, read.start, read.end, read.next, read.totalBytes], ['read', true, 0, Buffer.byteLength(original), null, Buffer.byteLength(original)]);
  assert.equal(read.content, original); assert.equal(read.hash, hashBytes(original));
  // The explicit-range contract remains for callers that ask for it.
  const first = await f.tools.call('cuefluent_read_note', { projectId: 'demo', target, maxBytes: 16 });
  assert.equal(first.end, 16); assert.equal(first.next, 16); assert.equal(first.hash, read.hash);
  const second = await f.tools.call('cuefluent_read_note', { projectId: 'demo', target, start: first.next, expectedHash: first.hash });
  assert.equal(second.start, 16); assert.ok(second.end <= 16 + 8192);
  await assert.rejects(f.tools.call('cuefluent_read_note', { projectId: 'demo', target, start: 16 }), { code: 'DIRECT_NOTE_ARGUMENT' });
  // The exact hash alone authorizes the update.
  const update = { ...f.request, target, expectedHash: read.hash, content: original.replace('small', 'focused') };
  assert.equal((await f.tools.call('cuefluent_update_note', update)).state, 'saved');
  assert.equal(await fs.readFile(target, 'utf8'), update.content);
  // A larger original is read in ranges and never replaced through the direct tool.
  const large = `${content}\n${'Preserve this paragraph.\n'.repeat(4000)}`; await fs.writeFile(target, large);
  assert.ok(Buffer.byteLength(large) > DIRECT_NOTE_BYTES);
  const partial = await f.tools.call('cuefluent_read_note', { projectId: 'demo', target });
  assert.equal(partial.end, 8192); assert.equal(partial.next, 8192); assert.equal(partial.totalBytes, Buffer.byteLength(large));
  await assert.rejects(f.tools.call('cuefluent_update_note', { ...update, requestId: randomUUID(), expectedHash: partial.hash, content }), { code: 'DIRECT_NOTE_UPDATE_LIMIT' });
  assert.equal(await fs.readFile(target, 'utf8'), large);
  assert.equal((await readProjectStatus(f.store, 'demo')).run, null);
});

test('whole reads honor the exact byte cap and fall back to ranges when the escaped projection would exceed one result', async t => {
  const f = await fixture(t, { saving: 'auto' }), target = path.join(f.notes, 'bound.md');
  const prefix = '# Boundary\n\n## Content\n', line = '界'.repeat(50) + '\n';
  let body = prefix + line.repeat(Math.floor((DIRECT_NOTE_BYTES - Buffer.byteLength(prefix)) / Buffer.byteLength(line)));
  body += 'x'.repeat(DIRECT_NOTE_BYTES - Buffer.byteLength(body));
  assert.equal(Buffer.byteLength(body), DIRECT_NOTE_BYTES); await fs.writeFile(target, body);
  const exact = await f.tools.call('cuefluent_read_note', { projectId: 'demo', target });
  assert.equal(exact.next, null); assert.equal(exact.content, body); assert.equal(exact.end, DIRECT_NOTE_BYTES);
  await fs.writeFile(target, body + 'y');
  const over = await f.tools.call('cuefluent_read_note', { projectId: 'demo', target });
  assert.equal(over.end, 8192); assert.equal(over.next, 8192); assert.equal(over.totalBytes, DIRECT_NOTE_BYTES + 1);
  // Heavy JSON escaping: each control byte serializes as six bytes, so 24 KiB of them exceeds one result.
  const escaped = '# Escapes\n\n## Content\n' + '\u0001'.repeat(24 * 1024);
  assert.ok(Buffer.byteLength(escaped) < DIRECT_NOTE_BYTES && Buffer.byteLength(JSON.stringify(escaped)) > DIRECT_READ_BYTES);
  await fs.writeFile(target, escaped);
  const ranged = await f.tools.call('cuefluent_read_note', { projectId: 'demo', target });
  assert.equal(ranged.end, 8192); assert.equal(ranged.next, 8192); assert.equal(ranged.hash, hashBytes(escaped));
  let next = ranged.next, assembled = ranged.content;
  while (next !== null) { const range = await f.tools.call('cuefluent_read_note', { projectId: 'demo', target, start: next, expectedHash: ranged.hash }); assembled += range.content; next = range.next; }
  assert.equal(assembled, escaped);
  // Processor budgets are untouched by the direct whole read.
  assert.equal(WORKSPACE_LIMITS.readBytes, 8192); assert.equal(WORKSPACE_LIMITS.contextBytes, 64 * 1024);
  // The largest projection still returned whole crosses the real protocol frame: the
  // result passes the control response bound, and the frame carrying the escaped text
  // next to the structured content stays within a quarter of the request frame bound.
  const dense = '# Dense\n\n## Content\n' + '\\"'.repeat(32 * 1024 - 168); await fs.writeFile(target, dense);
  assert.ok(Buffer.byteLength(dense) <= DIRECT_NOTE_BYTES && Buffer.byteLength(JSON.stringify(dense)) > DIRECT_READ_BYTES - 1024 && Buffer.byteLength(JSON.stringify(dense)) < DIRECT_READ_BYTES - 256);
  const native = await nativeTools(f);
  const response = await native.protocol({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'cuefluent_read_note', arguments: { projectId: 'demo', target } } });
  assert.equal(response.result.isError, false); assert.equal(response.result.structuredContent.next, null);
  assert.equal(response.result.structuredContent.content, dense); assert.equal(JSON.parse(response.result.content[0].text).content, dense);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= CONTROL_LIMITS.requestBytes / 2);
});

test('a stale hash never authorizes an update, from any connection or chat', async t => {
  const f = await fixture(t, { saving: 'auto' }), target = path.join(f.notes, 'existing.md'); await fs.writeFile(target, content);
  const native = await nativeTools(f), first = await native.call('cuefluent_read_note', { projectId: 'demo', target });
  const update = { ...f.request, target, expectedHash: first.hash, content: content.replace('small', 'focused') };
  await fs.writeFile(target, content + '\nManual addition.\n');
  assert.equal((await native.call('cuefluent_read_note', { projectId: 'demo', target, start: 4, expectedHash: first.hash })).error, 'DIRECT_NOTE_CONFLICT');
  assert.equal((await native.call('cuefluent_update_note', update)).error, 'DIRECT_NOTE_CONFLICT');
  assert.equal(await fs.readFile(target, 'utf8'), content + '\nManual addition.\n');
  const current = await native.call('cuefluent_read_note', { projectId: 'demo', target });
  assert.equal((await native.call('cuefluent_update_note', { ...update, expectedHash: current.hash, content: current.content.replace('small', 'focused') })).state, 'saved');
});

test('completed request IDs only replay the exact saved or skipped payload', async t => {
  for (const saving of ['auto', 'review']) {
    const f = await fixture(t, { saving }); const created = await f.create();
    const completed = saving === 'auto' ? created : await f.call('skip');
    assert.match(completed.result.requestHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(await f.create(), completed);
    for (const change of [{ content: content + '\nDifferent.\n' }, { target: 'another.md' }, { target: '../outside.md' }, { target: 'logs/2026.md' }, { content: 'No topic heading' }]) {
      await assert.rejects(f.create(change), { code: 'DIRECT_NOTE_REQUEST_CHANGED' });
    }
    await assert.rejects(f.tools.call('cuefluent_update_note', { ...f.request, expectedHash: hashBytes(content) }), { code: 'DIRECT_NOTE_REQUEST_CHANGED' });
    await assert.rejects(fs.access(path.join(f.notes, 'another.md')), { code: 'ENOENT' });
  }
});

test('busy does not disclose another draft, and another chat or connection reviews a retained draft', async t => {
  const f = await fixture(t), native = await nativeTools(f);
  const created = await native.call('cuefluent_create_note', f.request); assert.equal(created.state, 'review');
  const busy = await native.call('cuefluent_create_note', { ...f.request, requestId: randomUUID() });
  assert.deepEqual(busy, { state: 'busy', projectId: 'demo' });
  const review = await native.call('cuefluent_review_note', { projectId: 'demo', runId: f.request.requestId });
  assert.equal(review.state, 'review'); assert.equal(review.revision, created.revision); assert.equal(review.drafts[0].content, content);
  const other = await nativeTools(f, { client: 'claude' });
  assert.equal((await other.call('cuefluent_review_note', { projectId: 'demo', runId: f.request.requestId })).revision, created.revision);
  assert.deepEqual(await fs.readdir(f.notes), []);
  assert.ok((await inspectAttempt(f.store, 'demo')).run);
});

test('a decision citing a stale or malformed revision changes nothing; the current revision is required after a draft set changes', async t => {
  const f = await fixture(t), created = await f.create(), native = await nativeTools(f);
  for (const revision of ['e'.repeat(64), 'E'.repeat(64), created.revision.slice(1), `${created.revision}\n`, 64]) {
    const result = await native.call('cuefluent_save_note', { projectId: 'demo', runId: f.request.requestId, revision });
    assert.equal(result.error, revision === 'e'.repeat(64) ? 'REVIEW_REVISION_STALE' : 'DIRECT_NOTE_ARGUMENT');
  }
  // The reviewed set claims a different original, so a decision citing the
  // revision the user saw is refused until the set is reviewed again.
  await withProject(f.store, 'demo', async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, drafts: stored.value.drafts.map(draft => ({ ...draft, expectedHash: 'b'.repeat(64) })) }), { expectedHash: stored.hash });
  });
  assert.equal((await native.call('cuefluent_save_note', { projectId: 'demo', runId: f.request.requestId, revision: created.revision })).error, 'REVIEW_REVISION_STALE');
  assert.equal((await native.call('cuefluent_skip_note', { projectId: 'demo', runId: f.request.requestId, revision: created.revision })).error, 'REVIEW_REVISION_STALE');
  assert.deepEqual(await fs.readdir(f.notes), []);
  const current = await f.call('review'); assert.notEqual(current.revision, created.revision);
  assert.equal(current.drafts[0].expectedHash, 'b'.repeat(64));
  const skipped = await f.call('skip', f.request.requestId, current.revision);
  assert.equal(skipped.state, 'skipped'); assert.equal((await readProjectStatus(f.store, 'demo')).run, null);
  // A completed outcome replays for any well-formed revision: no decision runs.
  assert.deepEqual(await f.call('save', f.request.requestId, created.revision), skipped);
});

test('the revision binds the reviewed set, not its progress: it survives a partial save and changes with content, original, size, target or destination', async t => {
  const f = await fixture(t), created = await f.create();
  const { run } = await inspectAttempt(f.store, 'demo'), draft = run.drafts[0];
  assert.equal(runRevision(run), created.revision);
  for (const unchanged of [
    { ...run, warnings: ['SYNTHETIC_WARNING'] }, { ...run, attempt: { id: randomUUID() } }, { ...run, phase: 'saving' },
    { ...run, phase: 'saving', saved: [{ draftId: draft.id, target: draft.target, hash: draft.hash, changed: true }] },
    { ...run, phase: 'saving', saved: [{ draftId: draft.id, target: draft.target, hash: draft.hash, changed: true }], logEvents: [], artifacts: run.artifacts },
  ]) assert.equal(runRevision(unchanged), created.revision);
  const changed = [
    { ...run, drafts: [{ ...draft, hash: 'a'.repeat(64) }] }, { ...run, drafts: [{ ...draft, expectedHash: 'b'.repeat(64) }] },
    { ...run, drafts: [{ ...draft, byteLength: draft.byteLength + 1 }] }, { ...run, drafts: [{ ...draft, target: path.join(f.notes, 'meetings', 'elsewhere.md') }] },
    { ...run, projectId: 'demo', settings: { ...run.settings, saving: 'auto' }, phase: 'saving' },
  ].map(runRevision);
  assert.equal(new Set([created.revision, ...changed]).size, changed.length + 1);
  // Progress recorded by a partial save does not disturb a retry with the same revision.
  await withProject(f.store, 'demo', async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, phase: 'saving' }), { expectedHash: stored.hash });
  });
  const interrupted = await f.call('review'); assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.revision, created.revision);
  assert.equal((await f.call('save', f.request.requestId, created.revision)).state, 'saved');
});

test('preview and save share draft descriptor checks and no-op updates preserve exact bytes and timestamps', async t => {
  const f = await fixture(t); await f.create();
  await withProject(f.store, 'demo', async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, drafts: stored.value.drafts.map(draft => ({ ...draft, byteLength: draft.byteLength + 1 })) }), { expectedHash: stored.hash });
  });
  await assert.rejects(f.call('review'), { code: 'DRAFT_CHANGED' });
  await assert.rejects(f.call('save'), { code: 'DRAFT_CHANGED' });
  const g = await fixture(t, { saving: 'auto' });
  const saved = await g.create(), target = saved.result.paths[0], before = await fs.readFile(target), stat = await fs.stat(target);
  const read = await g.tools.call('cuefluent_read_note', { projectId: 'demo', target });
  const unchanged = await g.tools.call('cuefluent_update_note', { ...g.request, requestId: randomUUID(), target, expectedHash: read.hash });
  assert.equal(unchanged.state, 'nothing-useful');
  assert.deepEqual(await fs.readFile(target), before); assert.equal((await fs.stat(target)).mtimeMs, stat.mtimeMs);
});

test('multibyte note input obeys the UTF-8 byte cap rather than UTF-16 length', async t => {
  const f = await fixture(t, { saving: 'auto' });
  const prefix = '# Unicode\n\n## Content\n', line = '界'.repeat(50) + '\n';
  const body = prefix + line.repeat(Math.floor((DIRECT_NOTE_BYTES - Buffer.byteLength(prefix)) / Buffer.byteLength(line)));
  const exact = body + '界'.repeat(Math.floor((DIRECT_NOTE_BYTES - Buffer.byteLength(body)) / 3));
  const result = await f.create({ content: exact }); assert.equal(result.state, 'saved');
  assert.ok((await fs.readFile(result.result.paths[0], 'utf8')).endsWith(exact));
  // One byte over the cap is a size refusal, never an argument-shape refusal, so its guidance says not to shorten the note.
  await assert.rejects(f.create({ requestId: randomUUID(), target: 'too-large.md', content: exact + '界' }), { code: 'DIRECT_NOTE_CONTENT_LIMIT' });
  // The same holds when the character count alone would already exceed the schema bound.
  const ascii = '# Big\n\n## Content\n' + 'x'.repeat(DIRECT_NOTE_BYTES);
  await assert.rejects(f.create({ requestId: randomUUID(), target: 'too-large.md', content: ascii }), { code: 'DIRECT_NOTE_CONTENT_LIMIT' });
  await assert.rejects(f.tools.call('cuefluent_update_note', { ...f.request, requestId: randomUUID(), target: path.basename(result.result.paths[0]), expectedHash: 'f'.repeat(64), content: ascii }), { code: 'DIRECT_NOTE_CONTENT_LIMIT' });
  assert.equal((await readProjectStatus(f.store, 'demo')).run, null);
  const listed = await f.tools.call('cuefluent_projects', {});
  assert.equal(listed.state, 'configured'); assert.equal(listed.pendingSetup, null); assert.equal(listed.projects[0].id, 'demo');
});

test('a Codex call without turn metadata reads and updates a note with its hash alone', async t => {
  const f = await fixture(t, { saving: 'auto' }), native = await nativeTools(f), target = path.join(f.notes, 'existing.md');
  await fs.writeFile(target, content);
  const read = await native.protocol({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'cuefluent_read_note', arguments: { projectId: 'demo', target } } });
  assert.equal(read.result.structuredContent.state, 'read'); assert.equal(read.result.structuredContent.content, content);
  const result = await native.protocol({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'cuefluent_update_note', arguments: { ...f.request, target, expectedHash: read.result.structuredContent.hash, content: content + '\nChanged.\n' } } });
  assert.equal(result.result.isError, false); assert.equal(result.result.structuredContent.state, 'saved');
  assert.equal(await fs.readFile(target, 'utf8'), content + '\nChanged.\n');
});

test('auto-mode direct crash recovery publishes retained bytes while review-mode save first restores an unapproved preview', async t => {
  const f = await fixture(t, { saving: 'auto' });
  const run = createRun(f.project, [], { id: f.request.requestId, scope: { kind: 'direct', requestHash: hashBytes(JSON.stringify([f.request.target, content, f.request.summary])) } });
  const workspace = await openNoteWorkspace({ project: f.project, runId: run.id, skillVersion: '0.16.0' });
  await workspace.draft_note({ target: f.request.target, content, summary: f.request.summary });
  await workspace.finish_drafting({ outcome: 'drafted' }); const manifest = await workspace.manifest();
  await withProject(f.store, 'demo', ({ directory }) => writeJSON(f.store.pin, `${directory}/run.json`, run, { expectedHash: null }));
  await ownDirectAttempt(f.store, 'demo', run.id, async owner => { await pinProcessingLogging(f.store, owner); await persistDraftManifest(f.store, owner, manifest); });
  await withProject(f.store, 'demo', async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, phase: 'drafting', drafts: [] }), { expectedHash: stored.hash });
  });
  // In automatic mode the retained draft offers Save, which finishes saving it.
  const offered = await f.call('review', run.id);
  assert.equal(offered.phase, 'drafting'); assert.deepEqual(offered.choices, ['Save', 'Discard', 'Keep pending']);
  const saved = await f.call('save', run.id);
  assert.equal(saved.state, 'saved'); assert.deepEqual(await fs.readFile(saved.result.paths[0]), manifest.drafts[0].bytes);
  await assert.rejects(fs.access(path.join(f.store.root, 'processing')), { code: 'ENOENT' });
  const g = await fixture(t), original = await g.create();
  await withProject(g.store, 'demo', async ({ directory }) => {
    const stored = await readJSON(g.store.pin, `${directory}/run.json`);
    await writeJSON(g.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, phase: 'drafting', drafts: [] }), { expectedHash: stored.hash });
  });
  // The interrupted run has its own revision; citing the reviewed set's revision
  // against it is stale, and only the current one restores the preview.
  const interrupted = await g.call('review');
  assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.phase, 'drafting'); assert.notEqual(interrupted.revision, original.revision);
  // A complete retained draft offers its restoration; a reservation without one
  // can only be discarded or kept.
  assert.deepEqual(interrupted.choices, ['Restore draft', 'Discard', 'Keep pending']);
  const retainedPointer = (await inspectAttempt(g.store, 'demo')).run.artifacts;
  const pointTo = artifacts => withProject(g.store, 'demo', async ({ directory }) => {
    const stored = await readJSON(g.store.pin, `${directory}/run.json`);
    await writeJSON(g.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, artifacts }), { expectedHash: stored.hash });
  });
  await pointTo(null);
  assert.deepEqual((await g.call('review')).choices, ['Discard', 'Keep pending']);
  await pointTo(retainedPointer);
  await assert.rejects(g.call('save', g.request.requestId, original.revision), { code: 'REVIEW_REVISION_STALE' });
  const recovered = await g.call('save', g.request.requestId, interrupted.revision); assert.equal(recovered.state, 'review');
  assert.deepEqual(recovered.drafts, original.drafts); assert.equal(recovered.revision, original.revision);
  assert.deepEqual(await fs.readdir(g.notes), []);
  assert.equal((await g.call('save', g.request.requestId, original.revision)).state, 'saved');
});


test('direct drafts pin metadata formatting through approval; changed preferences apply to the next request in both clients', async t => {
  for (const client of ['codex', 'claude']) for (const expandedMetadata of [false, true]) {
    const f = await fixture(t, { client, expandedMetadata }); await f.create();
    const { run } = await inspectAttempt(f.store, 'demo');
    const retained = await readDraftArtifact(f.store.pin, run.artifacts, run.drafts[0].id);
    assert.equal(inspectMetadata(retained).raw.trim().split('\n').length > 3, expandedMetadata);
    const settings = await readSettings(f.store);
    await updateSettings(f.store, { schemaVersion: 1, projects: [{ ...f.project, expandedMetadata: !expandedMetadata }] }, { expectedHash: settings.hash });
    const saved = await f.call('save'); assert.equal(saved.state, 'saved');
    assert.deepEqual(await fs.readFile(saved.result.paths[0]), retained);
    await f.create({ requestId: randomUUID(), target: 'meetings/next.md' });
    const next = (await inspectAttempt(f.store, 'demo')).run;
    const bytes = await readDraftArtifact(f.store.pin, next.artifacts, next.drafts[0].id);
    assert.equal(inspectMetadata(bytes).raw.trim().split('\n').length > 3, !expandedMetadata);
  }
});


test('a concurrent same-request retry rebuilds with the settings pinned by the winning reservation', async t => {
  for (const expandedMetadata of [false, true]) {
    const f = await fixture(t, { expandedMetadata }), actor = new AsyncLocalStorage();
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const lstat = fs.lstat, rename = fs.rename;
    let paused = false, interrupted = false;
    const statMock = t.mock.method(fs, 'lstat', async (...args) => {
      const result = await lstat(...args);
      // A has already read settings, but its prospective draft has not reserved
      // a run. No store gate is held while it inspects the note destination.
      if (actor.getStore() === 'A' && args[0] === f.notes && !paused) {
        paused = true; entered.resolve(); await resume.promise;
      }
      return result;
    });
    const renameMock = t.mock.method(fs, 'rename', async (...args) => {
      await rename(...args);
      // B publishes its run and then loses the response before owning an attempt.
      // The real reservation remains durable; A must join that exact run.
      if (actor.getStore() === 'B' && path.basename(args[1]) === 'run.json' && !interrupted) {
        interrupted = true;
        throw Object.assign(new Error('Synthetic reservation interruption.'), { code: 'SYNTHETIC_RESERVATION_INTERRUPTED' });
      }
    });
    const first = actor.run('A', () => f.create());
    const settled = first.then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([entered.promise, settled.then(() => assert.fail('A must pause before reservation.'))]);
      const settings = await readSettings(f.store);
      await updateSettings(f.store, { schemaVersion: 1, projects: [{ ...f.project, expandedMetadata: !expandedMetadata }] }, { expectedHash: settings.hash });
      await assert.rejects(actor.run('B', () => f.create()), { code: 'SYNTHETIC_RESERVATION_INTERRUPTED' });
      const pending = await inspectAttempt(f.store, 'demo');
      assert.equal(pending.run.settings.expandedMetadata, !expandedMetadata);
      assert.equal(pending.run.phase, 'drafting'); assert.equal(pending.run.drafts.length, 0);
      resume.resolve();
      assert.equal((await first).state, 'review');
      const { run } = await inspectAttempt(f.store, 'demo');
      const bytes = await readDraftArtifact(f.store.pin, run.artifacts, run.drafts[0].id);
      const metadata = inspectMetadata(bytes);
      assert.equal(metadata.status, 'supported');
      const payload = /^<!-- cuefluent\n([\s\S]*?)\n-->/.exec(metadata.raw)[1];
      assert.equal(parseDocument(payload).contents.flow === true, !run.settings.expandedMetadata);
      assert.deepEqual(await fs.readdir(f.notes), []);
      const saved = await f.call('save');
      assert.equal(saved.state, 'saved'); assert.deepEqual(await fs.readFile(saved.result.paths[0]), bytes);
    } finally {
      resume.resolve(); await settled;
      statMock.mock.restore(); renameMock.mock.restore();
    }
  }
});


test('both MCP hosts preserve metadata edge cases through update review and exact save', async t => {
  const header = 'schema_version: 1\nid: stable\ncreated: "2026-01-01T00:00:00Z"\n';
  const line = 'C:\\Work\\Folder\\ "quoted" value '.repeat(43);
  const cases = [
    { name: 'blank-list-item', expandedMetadata: false, flow: true, payload: header + 'reviewers:\n - sam\n -\n - kim' },
    { name: 'escaped-whitespace-line', expandedMetadata: true, flow: false, payload: JSON.stringify({ schema_version: 1, id: 'stable', created: '2026-01-01T00:00:00Z', summary: 'First line of a handwritten summary here\n \nThird' }) },
    { name: 'large-block-values', expandedMetadata: false, flow: false, payload: header + Array.from({ length: 45 }, (_, i) => `custom${i}: |-\n  ${line}\n  Tail`).join('\n') },
    { name: 'large-flow-values', expandedMetadata: true, flow: true, payload: JSON.stringify({ schema_version: 1, id: 'stable', created: '2026-01-01T00:00:00Z',
      entries: Array.from({ length: 100 }, () => ({ a: { b: { c: { d: { values: Array.from({ length: 16 }, () => 'x'.repeat(29)) } } } } })) }) },
  ];
  for (const client of ['claude', 'codex']) for (const item of cases) {
    const f = await fixture(t, { client, expandedMetadata: item.expandedMetadata }), native = await nativeTools(f, { client });
    const target = path.join(f.notes, `${item.name}.md`), original = Buffer.from(`<!-- cuefluent\n${item.payload}\n-->\n${content}`);
    const before = inspectMetadata(original);
    assert.equal(before.status, 'supported'); assert.ok(original.length < DIRECT_NOTE_BYTES);
    await fs.writeFile(target, original);
    const read = await native.call('cuefluent_read_note', { projectId: 'demo', target });
    assert.equal(read.state, 'read'); assert.equal(read.next, null); assert.equal(read.hash, hashBytes(original));
    const changed = content.replace('small', 'focused');
    const preview = await native.call('cuefluent_update_note', { ...f.request, target, expectedHash: read.hash, content: changed });
    assert.equal(preview.state, 'review'); assert.equal(preview.drafts[0].content, changed);
    assert.deepEqual(await fs.readFile(target), original);
    const { run } = await inspectAttempt(f.store, 'demo');
    const reviewed = await readDraftArtifact(f.store.pin, run.artifacts, run.drafts[0].id);
    const saved = await native.call('cuefluent_save_note', { projectId: 'demo', runId: f.request.requestId, revision: preview.revision });
    assert.equal(saved.state, 'saved');
    const bytes = await fs.readFile(target), after = inspectMetadata(bytes);
    assert.deepEqual(bytes, reviewed); assert.equal(hashBytes(bytes), preview.drafts[0].hash);
    assert.equal(after.status, 'supported');
    assert.deepEqual(after.value, { ...before.value, updated: after.value.updated, generation: { skill_version: '0.16.0' } });
    assert.equal(bytes.toString().slice(after.end), changed);
    const payload = /^<!-- cuefluent\n([\s\S]*?)\n-->/.exec(after.raw)[1];
    assert.equal(parseDocument(payload).contents.flow === true, item.flow);
  }
});
