import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { waitForReplacement } from '../fixtures/publication-boundary.mjs';
import { createProject } from '../../src/core/settings.mjs';
import { validateRun } from '../../src/core/run.mjs';
import { initializeStore, withProject } from '../../src/storage/store.mjs';
import { prepareDraftArtifacts, writeDraftArtifact, completeDraftArtifacts } from '../../src/storage/draft-artifacts.mjs';
import { readJSON, writeJSON } from '../../src/storage/files.mjs';
import { setChatTracking, queueRelative } from '../../src/storage/chats.mjs';
import { appendQueueRecord, encodeQueueRecord, inspectQueue } from '../../src/storage/queue.mjs';
import { attachAttemptChild, launchOwnedAttempt, inspectAttempt } from '../../src/storage/attempts.mjs';
import { prepareProcessing } from '../../src/processing/prepare.mjs';
import { openNoteWorkspace } from '../../src/processing/workspace.mjs';
import { withoutFfiNotice } from '../fixtures/runtime-stderr.mjs';

const original = '# Synthetic note\n\n## Choice\nKeep the original decision.\n';
const proposed = '# Synthetic note\n\n## Choice\nUse the revised retry design.\n';
async function fixture(t, { target = 'design.md', existing = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-save-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes');
  await fs.mkdir(cwd); await fs.mkdir(notes);
  const note = path.join(notes, target);
  if (existing) { await fs.mkdir(path.dirname(note), { recursive: true }); await fs.writeFile(note, original); }
  const project = createProject({ id: 'project', root: cwd, destination: { kind: 'directory', path: notes } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  await setChatTracking(store, { client: 'claude', sessionId: 'chat', promptId: 'track', action: 'track', cwd, sourcePath: null });
  await withProject(store, 'project', () => appendQueueRecord(store.pin, queueRelative('claude', 'chat'), encodeQueueRecord('selected', Buffer.from('{"text":"synthetic"}'))));
  const { run } = await prepareProcessing(store, 'project', { kind: 'project' }, { reconcileChat: async () => ({ status: 'caught-up' }) });
  const workspace = await openNoteWorkspace({ project, runId: run.id, skillVersion: '0.16.0-dev.0', now: '2026-10-22T09:00:00.000Z' });
  if (existing) await workspace.read_note({ target });
  await workspace.draft_note({ target, content: proposed, summary: 'Update the retry decision.', heading: 'Choice', usefulChange: true });
  await workspace.finish_drafting({ outcome: 'drafted' });
  const manifest = await workspace.manifest();
  await withProject(store, 'project', async ({ directory }) => {
    let current = await readJSON(store.pin, `${directory}/run.json`);
    const drafts = manifest.drafts.map(({ bytes, ...draft }) => ({ ...draft, byteLength: bytes.length }));
    const artifacts = await prepareDraftArtifacts(store.pin, `${directory}/drafts/${run.id}`, { runId: run.id, outcome: 'drafted', drafts }, {
      persistIntent: async pointer => {
        const value = validateRun({ ...current.value, artifacts: pointer });
        const written = await writeJSON(store.pin, `${directory}/run.json`, value, { expectedHash: current.hash });
        current = { value, hash: written.hash };
      },
    });
    for (const draft of manifest.drafts) await writeDraftArtifact(store.pin, artifacts, draft.id, draft.bytes);
    await completeDraftArtifacts(store.pin, artifacts);
    await writeJSON(store.pin, `${directory}/run.json`, validateRun({ ...current.value, phase: 'review', drafts }), { expectedHash: current.hash });
  });
  const children = [];
  const launch = async (stopAfterNote = false, extra = {}) => {
    await launchOwnedAttempt(store, 'project', { runId: run.id, launch: context => {
      const child = fork(fileURLToPath(new URL('../fixtures/save-worker.mjs', import.meta.url)), [root, JSON.stringify({ ...context, stopAfterNote, ...extra })],
        { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc', 'pipe'] });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      const exited = new Promise(resolve => child.once('exit', code => resolve({ code, stderr: withoutFfiNotice(stderr, child.pid) })));
      const boundary = stopAfterNote ? waitForReplacement(child, note, exited) : null;
      children.push({ child, exited, boundary });
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
      return attachAttemptChild(child, context);
    } });
    return children.at(-1);
  };
  return { root, notes, note, store, run, launch, manifest };
}

test('owned review save writes exact drafts, routes new folders, and completes selected cleanup', async t => {
  for (const choice of [{}, { target: 'decisions/new.md', existing: false }]) {
    const f = await fixture(t, choice), child = await f.launch();
    assert.deepEqual(await child.exited, { code: 0, stderr: '' });
    assert.deepEqual(await fs.readFile(f.note), f.manifest.drafts[0].bytes);
    assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', 'chat'))).records, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'outcome.json'), 'utf8')).status, 'saved');
  }
});

test('manual note edits, absent-target arrivals, and parent replacement preserve input and user files', async t => {
  for (const mutation of ['manual', 'arrival', 'parent']) {
    const f = await fixture(t, { existing: mutation !== 'arrival' });
    if (mutation === 'parent') { await fs.rename(f.notes, `${f.notes}-old`); await fs.mkdir(f.notes); await fs.writeFile(f.note, original); }
    else await fs.writeFile(f.note, 'User-written content.');
    const before = await fs.readFile(f.note), child = await f.launch();
    assert.equal((await child.exited).code, 1);
    assert.deepEqual(await fs.readFile(f.note), before);
    assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', 'chat'))).records, 1);
    assert.equal((await inspectAttempt(f.store, 'project')).run.saved.length, 0);
  }
});

test('retry after note replacement but before receipt recognizes the exact staged inode and finishes cleanup', async t => {
  const f = await fixture(t), first = await f.launch(true);
  await first.boundary; first.child.kill('SIGKILL'); await first.exited;
  const stopped = await inspectAttempt(f.store, 'project');
  assert.equal(stopped.active, false); assert.equal(stopped.run.saved.length, 0); assert.ok(stopped.run.publication.note.stage);
  assert.deepEqual(await fs.readFile(f.note), f.manifest.drafts[0].bytes);
  const second = await f.launch(); assert.deepEqual(await second.exited, { code: 0, stderr: '' });
  const result = JSON.parse(await fs.readFile(path.join(f.root, 'outcome.json'), 'utf8'));
  assert.equal(result.counts.saved, 1); assert.equal(result.counts.handled, 1);
  await assert.rejects(inspectAttempt(f.store, 'project'), { code: 'RUN_MISSING' });
});


test('slow public note work leaves project gates available for new queue appends', async t => {
  const f = await fixture(t), child = await f.launch(false, { holdDraft: true });
  const deadline = Date.now() + 7000;
  for (;;) {
    try { await fs.stat(path.join(f.root, 'draft-reading')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() >= deadline) assert.fail('Save did not reach the draft read.');
    await delay(10);
  }
  try {
    await withProject(f.store, 'project', () => appendQueueRecord(f.store.pin, queueRelative('claude', 'chat'), encodeQueueRecord('arriving-during-save', Buffer.from('{"text":"new input"}'))));
    assert.equal((await inspectAttempt(f.store, 'project')).active, true);
  } finally { await fs.writeFile(path.join(f.root, 'continue-draft'), ''); }
  assert.deepEqual(await child.exited, { code: 0, stderr: '' });
  assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', 'chat'))).records, 1);
});


test('a superseded attempt is fenced immediately before its public replacement', async t => {
  const f = await fixture(t), child = await f.launch(false, { supersedeBeforePublish: true });
  assert.equal((await child.exited).code, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'error.json'), 'utf8')).code, 'RUN_ATTEMPT_STALE');
  assert.equal(await fs.readFile(f.note, 'utf8'), original);
  assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', 'chat'))).records, 1);
  assert.equal((await inspectAttempt(f.store, 'project')).run.saved.length, 0);
});
