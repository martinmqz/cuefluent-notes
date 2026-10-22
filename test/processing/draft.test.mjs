import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createProject } from '../../src/core/settings.mjs';
import { initializeStore, withProject } from '../../src/storage/store.mjs';
import { setChatTracking, queueRelative } from '../../src/storage/chats.mjs';
import { appendQueueRecord, encodeQueueRecord, inspectQueue } from '../../src/storage/queue.mjs';
import { launchOwnedAttempt, attachAttemptChild, inspectAttempt } from '../../src/storage/attempts.mjs';
import { prepareProcessing } from '../../src/processing/prepare.mjs';

async function waitFile(file) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.fail('Draft fixture did not reach its expected boundary.');
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-drafting-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  const project = createProject({ id: 'project', root: cwd, destination: { kind: 'directory', path: notes } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  await setChatTracking(store, { client: 'codex', sessionId: 'synthetic', promptId: 'track', action: 'track', cwd, sourcePath: null });
  await withProject(store, 'project', () => appendQueueRecord(store.pin, queueRelative('codex', 'synthetic'), encodeQueueRecord('input', Buffer.from('{"text":"Record the retry decision."}'))));
  const { run } = await prepareProcessing(store, 'project', { kind: 'project' }, { reconcileChat: async () => ({ status: 'caught-up' }) });
  const launch = async extra => {
    let handle;
    await launchOwnedAttempt(store, 'project', { runId: run.id, launch: context => {
      const child = fork(fileURLToPath(new URL('../fixtures/draft-worker.mjs', import.meta.url)), [root, JSON.stringify({ ...context, ...extra })], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      const exited = new Promise(resolve => child.once('exit', code => resolve({ code, stderr })));
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
      handle = { child, exited }; return attachAttemptChild(child, context);
    } });
    return handle;
  };
  return { root, notes, store, launch };
}

test('draft tool completion publishes a private review set without saving public notes or consuming input', async t => {
  const f = await fixture(t), child = await f.launch({});
  const outcome = await child.exited;
  if (outcome.code !== 0) assert.fail(await fs.readFile(path.join(f.root, 'error.json'), 'utf8'));
  assert.deepEqual(outcome, { code: 0, stderr: '' });
  const { run } = await inspectAttempt(f.store, 'project');
  assert.equal(run.phase, 'review'); assert.equal(run.drafts.length, 1); assert.ok(run.artifacts);
  assert.deepEqual(await fs.readdir(f.notes), []);
  assert.equal((await inspectQueue(f.store.pin, queueRelative('codex', 'synthetic'))).records, 1);
});

test('native completion without explicit finish cannot publish drafts or consume selected input', async t => {
  const f = await fixture(t), child = await f.launch({ unfinished: true }); assert.equal((await child.exited).code, 1);
  const { run } = await inspectAttempt(f.store, 'project'); assert.equal(run.phase, 'drafting'); assert.equal(run.artifacts, null);
  assert.deepEqual(await fs.readdir(f.notes), []);
  assert.equal((await inspectQueue(f.store.pin, queueRelative('codex', 'synthetic'))).records, 1);
});

test('a complete durable artifact set survives worker death and is published on retry without another model', async t => {
  const f = await fixture(t), first = await f.launch({ stopAfterReady: true });
  await waitFile(path.join(f.root, 'drafts-ready')); first.child.kill('SIGKILL'); await first.exited;
  const before = await inspectAttempt(f.store, 'project'); assert.equal(before.run.phase, 'drafting'); assert.ok(before.run.artifacts);
  const second = await f.launch({ rejectModel: true }); assert.deepEqual(await second.exited, { code: 0, stderr: '' });
  assert.equal((await inspectAttempt(f.store, 'project')).run.phase, 'review');
});
