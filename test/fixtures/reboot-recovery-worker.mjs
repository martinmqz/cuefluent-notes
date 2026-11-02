import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';

const [root, scenario, phase] = process.argv.slice(2);
assert.ok(['prepare', 'resume'].includes(phase));
const offset = phase === 'resume' ? 1n : 0n;
const observations = new WeakMap();
const realStat = await import('../../src/storage/stat.mjs');
const realPlatform = await import('../../src/storage/platform.mjs');
function renumber(stat) {
  const shifted = Object.freeze({ ...stat, dev: stat.dev + offset });
  observations.set(shifted, stat);
  return shifted;
}
// Keep the native privacy proof real. Only its already-normalized observation is
// translated back to the same physical device used by the native ACL query.
mock.module(new URL('../../src/storage/stat.mjs', import.meta.url), { exports: {
  ...realStat,
  normalizeStat: (raw, options) => renumber(realStat.normalizeStat(raw, options)),
  readPathStat: async file => renumber(await realStat.readPathStat(file)),
  readHandleStat: async handle => renumber(await realStat.readHandleStat(handle)),
} });
mock.module(new URL('../../src/storage/platform.mjs', import.meta.url), { exports: {
  ...realPlatform,
  assertPrivateAccess: (file, stat) => realPlatform.assertPrivateAccess(file, observations.get(stat) ?? stat),
  assertEmptyPrivateReservation: (file, stat) => realPlatform.assertEmptyPrivateReservation(file, observations.get(stat) ?? stat),
} });
const { createProject } = await import('../../src/core/settings.mjs');
const { initializeStore, openStore, readSettings, withProject } = await import('../../src/storage/store.mjs');
const { createPrivateDirectory, pinDirectory } = await import('../../src/storage/paths.mjs');
const { hashBytes, readSnapshot, writeAtomic, removeExact, readJSON } = await import('../../src/storage/files.mjs');
const { createDirectNoteTools } = await import('../../src/control/direct-notes.mjs');
const { setupProject } = await import('../../src/control/setup.mjs');
const { setChatTracking, readChat, selectChatQueue } = await import('../../src/storage/chats.mjs');
const { collectChat } = await import('../../src/sync/collect.mjs');
const { createHistoricalCommandClassifier } = await import('../../src/client/historical-commands.mjs');
const queue = await import('../../src/storage/queue.mjs');

const storeRoot = path.join(root, 'private'), cwd = path.join(root, 'project'), notes = path.join(root, 'notes');
const record = path.join(root, 'fixture.json');
const persist = value => fs.writeFile(record, JSON.stringify(value), { mode: 0o600 });
const retained = async () => JSON.parse(await fs.readFile(record, 'utf8'));
const content = '# Reboot recovery\n\n## Purpose\nPreserve the exact synthetic draft.\n';
const projectId = 'synthetic';
async function storeFixture() {
  await fs.mkdir(cwd); await fs.mkdir(notes);
  const project = createProject({ id: projectId, root: cwd, destination: { kind: 'directory', path: notes }, activityLog: { enabled: false } });
  return initializeStore(storeRoot, { schemaVersion: 1, projects: [project] });
}
const direct = store => createDirectNoteTools({ store, client: 'codex', skillVersion: '0.22.0' });
const absence = file => assert.rejects(fs.access(file), { code: 'ENOENT' });
const privatePin = () => pinDirectory(storeRoot, { private: true });

if (scenario === 'direct' || scenario === 'direct-replaced') {
  if (phase === 'prepare') {
    const store = await storeFixture();
    const draft = await direct(store).call('cuefluent_create_note', { projectId, requestId: randomUUID(), target: 'synthetic.md', content, summary: 'Synthetic reboot recovery.' });
    assert.equal(draft.state, 'review');
    const reference = { projectId, runId: draft.runId, revision: draft.revision };
    await persist(reference);
    if (scenario === 'direct-replaced') {
      const run = await withProject(store, projectId, async context => (await readJSON(store.pin, `${context.directory}/run.json`)).value);
      const directory = path.join(storeRoot, run.artifacts.relative);
      const payload = path.join(directory, (await fs.readdir(directory)).find(name => name.endsWith('.draft')));
      const bytes = await fs.readFile(payload);
      await fs.rename(payload, path.join(root, 'retained-original.draft'));
      await fs.writeFile(payload, bytes, { mode: 0o600 });
    }
    await absence(path.join(notes, 'synthetic.md'));
  } else {
    const store = await openStore(storeRoot), tools = direct(store), reference = await retained();
    if (scenario === 'direct-replaced') {
      await assert.rejects(tools.call('cuefluent_review_note', { projectId, runId: reference.runId }), { code: 'DRAFT_ARTIFACT_CONFLICT' });
      await absence(path.join(notes, 'synthetic.md'));
    } else {
      const review = await tools.call('cuefluent_review_note', { projectId, runId: reference.runId });
      assert.equal(review.state, 'review'); assert.equal(review.revision, reference.revision);
      assert.equal(review.drafts[0].content, content);
      assert.equal((await tools.call('cuefluent_save_note', reference)).state, 'saved');
      assert.ok((await fs.readFile(path.join(notes, 'synthetic.md'), 'utf8')).includes(content));
      await withProject(store, projectId, async context => {
        assert.equal(await readJSON(store.pin, `${context.directory}/run.json`, { missing: true }), null);
        assert.deepEqual(await fs.readdir(path.join(storeRoot, context.directory, 'drafts')), []);
      });
    }
  }
} else if (scenario === 'source') {
  const sourcePath = path.join(root, 'synthetic.jsonl'), sessionId = 'synthetic-chat';
  const human = id => ({ type: 'user', sessionId, uuid: id, promptId: id, turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: id } });
  const assistant = id => ({ type: 'assistant', sessionId, uuid: id, message: { role: 'assistant', content: [{ type: 'text', text: id }], stop_reason: 'end_turn' } });
  const bytes = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
  const classifyCommand = createHistoricalCommandClassifier({ client: 'claude', name: 'notes:notes', skillPath: path.join(root, 'plugin', 'skills', 'notes', 'SKILL.md') });
  if (phase === 'prepare') {
    const store = await storeFixture();
    await fs.writeFile(sourcePath, bytes([human('before'), assistant('before-reply'), human('track')]), { mode: 0o600 });
    await setChatTracking(store, { client: 'claude', sessionId, promptId: 'track', action: 'track', cwd, sourcePath });
    assert.equal((await collectChat(store, { client: 'claude', sessionId, classifyCommand })).status, 'caught-up');
    const saved = (await readChat(store, 'claude', sessionId)).value;
    await persist({ checkpoint: saved.checkpoint, identity: saved.source.identity });
  } else {
    const store = await openStore(storeRoot), before = await retained();
    assert.deepEqual((await readChat(store, 'claude', sessionId)).value.checkpoint, before.checkpoint);
    await fs.appendFile(sourcePath, bytes([assistant('track-reply'), human('after'), assistant('after-reply'), human('pending')]));
    await collectChat(store, { client: 'claude', sessionId, classifyCommand });
    const selected = await selectChatQueue(store, projectId, 'claude', sessionId);
    assert.deepEqual(selected.map(item => item.data.exchangeId), ['before', 'track', 'after']);
    assert.deepEqual((await readChat(store, 'claude', sessionId)).value.source.identity, before.identity);
  }
} else if (scenario === 'layout' || scenario === 'settings') {
  if (phase === 'prepare') {
    const target = path.join(storeRoot, scenario === 'layout' ? 'store/layout.json' : 'config/settings.json');
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (to === target && String(from).endsWith('.tmp')) process.exit(42);
      return rename(from, to);
    };
    await initializeStore(storeRoot);
    assert.fail('Initialization did not reach the interruption boundary.');
  } else {
    const store = await initializeStore(storeRoot);
    assert.deepEqual((await readSettings(store)).value.projects, []);
    for (const directory of ['store', 'config']) assert.deepEqual((await fs.readdir(path.join(storeRoot, directory))).filter(name => name.endsWith('.tmp')), []);
  }
} else if (scenario === 'setup') {
  const options = { storeRoot, expectedHash: null, skillVersion: '0.22.0', now: '2026-11-02T00:00:00.000Z', project: { id: projectId, root: cwd,
    destination: { kind: 'directory', path: notes }, activityLog: { enabled: false } } };
  if (phase === 'prepare') {
    await fs.mkdir(cwd);
    const store = await initializeStore(storeRoot);
    options.expectedHash = (await readSettings(store)).hash;
    await persist(options);
    const mkdir = fs.mkdir;
    fs.mkdir = async (file, ...args) => { if (file === notes) throw Object.assign(new Error('Synthetic interruption.'), { code: 'EACCES' }); return mkdir(file, ...args); };
    await assert.rejects(setupProject(options), { code: 'EACCES' });
    await fs.access(path.join(storeRoot, 'config/setup.json'));
  } else {
    assert.equal((await setupProject(await retained())).status, 'configured');
    assert.equal((await readSettings(await openStore(storeRoot))).value.projects[0].id, projectId);
    await absence(path.join(storeRoot, 'config/setup.json'));
  }
} else if (scenario === 'removal') {
  const target = path.join(storeRoot, 'run.json'), bytes = Buffer.from('Synthetic retained state.\n');
  if (phase === 'prepare') {
    const pin = await createPrivateDirectory(storeRoot);
    await writeAtomic(pin, 'run.json', bytes, { expectedHash: null });
    const rename = fs.rename;
    fs.rename = async (from, to) => { const value = await rename(from, to); if (from === target) process.exit(42); return value; };
    await removeExact(pin, 'run.json', hashBytes(bytes));
    assert.fail('Exact removal did not reach the interruption boundary.');
  } else {
    const pin = await privatePin();
    assert.deepEqual((await readSnapshot(pin, 'run.json')).bytes, bytes);
    await removeExact(pin, 'run.json', hashBytes(bytes));
    assert.deepEqual(await fs.readdir(storeRoot), []);
  }
} else if (scenario === 'queue') {
  const relative = 'synthetic.queue';
  if (phase === 'prepare') {
    const pin = await createPrivateDirectory(storeRoot), item = queue.encodeQueueRecord('synthetic-record', Buffer.from('{"text":"synthetic"}'));
    await queue.appendQueueRecord(pin, relative, item);
    const result = await queue.cleanupQueueStep(pin, relative, { selected: item, context: hashBytes(Buffer.from('synthetic selection')), index: 0 });
    await queue.acknowledgeQueueCleanup(pin, relative, result.cursor);
    const { queueId } = await queue.inspectQueue(pin, relative);
    await persist({ queueId });
    const rmdir = fs.rmdir;
    fs.rmdir = async file => { const value = await rmdir(file); if (file === path.join(storeRoot, relative, 'parts')) process.exit(42); return value; };
    await queue.removeEmptyQueue(pin, relative, { queueId });
    assert.fail('Queue pruning did not reach the interruption boundary.');
  } else {
    const pin = await privatePin(), { queueId } = await retained();
    assert.equal((await queue.removeEmptyQueue(pin, relative, { queueId })).removed, true);
    await absence(path.join(storeRoot, relative));
  }
} else assert.fail('Unknown synthetic scenario.');
console.log(JSON.stringify({ scenario, phase, verified: true }));
