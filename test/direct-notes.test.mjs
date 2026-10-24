import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject } from '../src/core/settings.mjs';
import { createRun, validateRun } from '../src/core/run.mjs';
import { initializeStore, withProject, readSettings, updateSettings } from '../src/storage/store.mjs';
import { readJSON, writeJSON, hashBytes } from '../src/storage/files.mjs';
import { readDraftArtifact } from '../src/storage/draft-artifacts.mjs';
import { ownDirectAttempt, withCurrentAttempt, inspectAttempt } from '../src/storage/attempts.mjs';
import { setChatTracking, queueRelative } from '../src/storage/chats.mjs';
import { appendQueueRecord, encodeQueueRecord, inspectQueue } from '../src/storage/queue.mjs';
import { createDirectNoteTools, DIRECT_NOTE_BYTES } from '../src/control/direct-notes.mjs';
import { createControlBridge } from '../src/client/control-server.mjs';
import { readProjectStatus } from '../src/control/status.mjs';
import { prepareProcessing } from '../src/processing/prepare.mjs';
import { runProcessingWork } from '../src/processing/worker.mjs';

const content = '# Planning meeting\n\n## Decisions\nKeep the release small.\n\n## Actions\nSam will verify the result.\n';
async function fixture(t, { saving = 'review', client = 'codex', file = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-direct-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  const project = createProject({ id: 'demo', root: cwd, destination: { kind: file ? 'file' : 'directory', path: file ? path.join(notes, 'explicit.md') : notes }, saving });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const tools = createDirectNoteTools({ store, client, skillVersion: '0.16.0' });
  const request = { projectId: project.id, requestId: randomUUID(), target: file ? 'explicit.md' : 'meetings/planning.md', content, summary: 'Planning decisions and actions.' };
  const create = input => tools.call('cuefluent_create_note', { ...request, ...input });
  const call = (action, runId = request.requestId) => tools.call(`cuefluent_${action}_note`, { projectId: project.id, runId });
  return { root, cwd, notes, project, store, tools, request, create, call };
}

test('direct review creates one preview from supplied context without enrollment, queues, or a model, then saves exactly that draft', async t => {
  const f = await fixture(t), before = await readSettings(f.store);
  const draft = await f.create();
  assert.equal(draft.state, 'review'); assert.equal(draft.drafts.length, 1);
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
  await assert.rejects(f.call('save', randomUUID()), { code: 'DIRECT_NOTE_RUN_CHANGED' });
  assert.deepEqual(await f.call('review'), original);
  const settings = await readSettings(f.store);
  await assert.rejects(updateSettings(f.store, { schemaVersion: 1, projects: [{ ...f.project, saving: 'auto' }] }, { expectedHash: settings.hash }));
  await f.call('skip'); assert.equal((await readProjectStatus(f.store, 'demo')).run, null);
  const secondRun = await f.create({ requestId: randomUUID() }); assert.equal(secondRun.state, 'review');
});

test('existing queue processing runs cannot be changed by direct save or skip', async t => {
  const f = await fixture(t);
  await setChatTracking(f.store, { client: 'codex', sessionId: 'synthetic', promptId: 'track', action: 'track', cwd: f.cwd, sourcePath: null });
  await withProject(f.store, 'demo', () => appendQueueRecord(f.store.pin, queueRelative('codex', 'synthetic'), encodeQueueRecord('input', Buffer.from('{"text":"Queued"}'))));
  const { run } = await prepareProcessing(f.store, 'demo', { kind: 'project' }, { reconcileChat: async () => ({ status: 'caught-up' }) });
  assert.equal((await f.create()).state, 'busy');
  for (const action of ['review', 'save', 'skip']) await assert.rejects(f.call(action, run.id), { code: 'DIRECT_NOTE_RUN_REQUIRED' });
  assert.deepEqual((await inspectAttempt(f.store, 'demo')).run, run);
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
  await assert.rejects(ownDirectAttempt(f.store, 'demo', f.request.requestId, owner => runProcessingWork(f.store, owner,
    { action: 'process', client: 'codex', skillVersion: '0.16.0', runClient: () => { models++; } })), { code: 'DIRECT_NOTE_CONTENT_REQUIRED' });
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
