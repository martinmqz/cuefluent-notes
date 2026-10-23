import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createProject } from '../src/core/settings.mjs';
import { initializeStore, withProject } from '../src/storage/store.mjs';
import { readChat, queueRelative } from '../src/storage/chats.mjs';
import { appendQueueRecord, encodeQueueRecord, inspectQueue } from '../src/storage/queue.mjs';
import { attachAttemptChild, inspectAttempt } from '../src/storage/attempts.mjs';
import { executeControl } from '../src/control/execute.mjs';
import { withoutFfiNotice } from './fixtures/runtime-stderr.mjs';

async function waitFile(file) {
  for (let attempt = 0; attempt < 400; attempt++) {
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.fail('Synthetic worker did not reach its expected boundary.');
}
async function fixture(t, { saving = 'review' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-control-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  const project = createProject({ id: 'project', root: cwd, destination: { kind: 'directory', path: notes }, saving });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  let launches = 0, handle, prompt = 0;
  const execute = async (action, extra = {}) => {
    const result = await executeControl(store, { client: 'codex', sessionId: 'synthetic', promptId: `prompt-${++prompt}`, cwd, sourcePath: null, action }, {
      reconcileChat: async () => ({ status: 'caught-up' }),
      launchProcessing: context => {
        launches++;
        const child = fork(fileURLToPath(new URL('./fixtures/processing-worker.mjs', import.meta.url)), [root, JSON.stringify({ ...context, ...extra })],
          { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
        const exited = new Promise(resolve => child.once('exit', code => resolve({ code, stderr: withoutFfiNotice(stderr, child.pid) })));
        t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
        handle = { child, exited, attemptId: context.attemptId }; return attachAttemptChild(child, context);
      },
    });
    return { result, handle };
  };
  const append = id => withProject(store, 'project', () => appendQueueRecord(store.pin, queueRelative('codex', 'synthetic'), encodeQueueRecord(id, Buffer.from(JSON.stringify({ text: `Synthetic decision ${id}` })))));
  const queue = () => inspectQueue(store.pin, queueRelative('codex', 'synthetic'));
  const finished = async handle => {
    const outcome = await handle.exited;
    if (outcome.code !== 0) assert.fail(await fs.readFile(path.join(root, `error-${handle.attemptId}.json`), 'utf8'));
    assert.deepEqual(outcome, { code: 0, stderr: '' });
    return JSON.parse(await fs.readFile(path.join(root, `outcome-${handle.attemptId}.json`), 'utf8'));
  };
  await execute('track'); await append('first');
  return { root, notes, store, execute, append, queue, finished, get launches() { return launches; } };
}

test('full review command flow retains arrivals, reports one running run, and removes a drained untracked queue', async t => {
  const f = await fixture(t), first = await f.execute('process', { waitForRelease: true });
  assert.equal(first.result.state, 'running'); assert.equal(first.result.paths, undefined);
  await waitFile(path.join(f.root, 'model-started'));
  assert.equal((await f.execute('status')).result.state, 'running');
  assert.equal((await f.execute('process')).result.runId, first.result.runId); assert.equal(f.launches, 1);
  assert.equal((await f.execute('skip')).result.state, 'running'); assert.equal(f.launches, 1);
  await f.append('later'); await fs.writeFile(path.join(f.root, 'release-model'), 'go');
  assert.equal((await f.finished(first.handle)).state, 'review');
  assert.equal((await inspectAttempt(f.store, 'project')).run.attempt, null);
  assert.equal((await f.queue()).records, 2);
  assert.deepEqual(await fs.readdir(f.notes), []);
  const saved = await f.execute('save', { rejectModel: true });
  const result = await f.finished(saved.handle); assert.equal(result.status, 'saved'); assert.equal(result.counts.handled, 1);
  assert.equal((await f.queue()).records, 1);
  assert.equal((await f.execute('status')).result.latest.status, 'saved');
  await f.execute('untrack');
  const last = await f.execute('process', { targets: [] });
  assert.equal((await f.finished(last.handle)).status, 'nothing-useful');
  assert.equal((await f.queue()).exists, false);
  const chat = await readChat(f.store, 'codex', 'synthetic'); assert.equal(chat.value.optOut, true);
});

test('skip releases review drafts with all source data intact and no public notes', async t => {
  const f = await fixture(t); await f.finished((await f.execute('process')).handle);
  const run = (await inspectAttempt(f.store, 'project')).run;
  const skipped = await f.finished((await f.execute('skip', { rejectModel: true })).handle);
  assert.equal(skipped.status, 'skipped'); assert.equal(skipped.counts.handled, 0); assert.deepEqual(skipped.paths, []);
  assert.equal((await f.queue()).records, 1); assert.deepEqual(await fs.readdir(f.notes), []);
  await assert.rejects(fs.access(path.join(f.store.root, run.artifacts.relative)), { code: 'ENOENT' });
  await assert.rejects(inspectAttempt(f.store, 'project'), { code: 'RUN_MISSING' });
});

test('skip after a partial conflicted save keeps the saved note, the user collision and all selected input', async t => {
  const f = await fixture(t); await f.finished((await f.execute('process', { targets: ['a.md', 'z.md'] })).handle);
  await fs.writeFile(path.join(f.notes, 'z.md'), 'User file arrived after drafting.');
  const saving = await f.execute('save'); assert.equal((await saving.handle.exited).code, 1);
  const saved = await fs.readFile(path.join(f.notes, 'a.md'));
  assert.equal((await inspectAttempt(f.store, 'project')).run.saved.length, 1);
  const result = await f.finished((await f.execute('skip', { rejectModel: true })).handle);
  assert.equal(result.status, 'skipped'); assert.equal(result.counts.saved, 1); assert.deepEqual(result.paths, [path.join(f.notes, 'a.md')]);
  assert.deepEqual(await fs.readFile(path.join(f.notes, 'a.md')), saved);
  assert.equal(await fs.readFile(path.join(f.notes, 'z.md'), 'utf8'), 'User file arrived after drafting.');
  assert.equal((await f.queue()).records, 1);
});

test('skip finishes already durable saving instead of replaying its input', async t => {
  const f = await fixture(t, { saving: 'auto' }), processing = await f.execute('process', { stopAtCleanup: true });
  await waitFile(path.join(f.root, 'cleanup-ready')); processing.handle.child.kill('SIGKILL'); await processing.handle.exited;
  assert.equal((await f.queue()).records, 1);
  const result = await f.finished((await f.execute('skip', { rejectModel: true })).handle);
  assert.equal(result.status, 'saved'); assert.equal(result.counts.handled, 1); assert.equal((await f.queue()).records, 0);
});

test('failed drafting is retried in the existing run with the original frozen input', async t => {
  const f = await fixture(t, { saving: 'auto' }), failed = await f.execute('process', { rejectModel: true });
  assert.equal((await failed.handle.exited).code, 1); await f.append('later');
  const state = (await f.execute('status')).result;
  assert.equal(state.state, 'interrupted'); assert.ok(state.run.warnings.includes('SYNTHETIC_MODEL_FAILURE'));
  const retried = await f.execute('process', { targets: [] }); assert.equal(retried.result.runId, failed.result.runId);
  const result = await f.finished(retried.handle); assert.equal(result.status, 'nothing-useful'); assert.equal(result.counts.handled, 1);
  assert.equal((await f.queue()).records, 1);
});
