import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createProject } from '../src/core/settings.mjs';
import { createRun, validateRun } from '../src/core/run.mjs';
import { initializeStore, withProject } from '../src/storage/store.mjs';
import { readJSON, writeJSON } from '../src/storage/files.mjs';
import { setChatTracking, readChat, queueRelative } from '../src/storage/chats.mjs';
import { appendQueueRecord, encodeQueueRecord, inspectQueue } from '../src/storage/queue.mjs';
import { attachAttemptChild, launchOwnedAttempt, inspectAttempt } from '../src/storage/attempts.mjs';
import { prepareProcessing, readProcessingInput } from '../src/processing/prepare.mjs';
import { withoutFfiNotice } from './fixtures/runtime-stderr.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-v2-process-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const project = createProject({ id: 'project', root: cwd, destination: { kind: 'directory', path: path.join(root, 'notes') } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const register = (sessionId, action = 'track') => setChatTracking(store, { client: 'claude', sessionId, promptId: `${action}-prompt`, action, cwd, sourcePath: null });
  const append = (sessionId, id) => withProject(store, project.id, () => appendQueueRecord(store.pin, queueRelative('claude', sessionId), encodeQueueRecord(id, Buffer.from(JSON.stringify({ text: id })))));
  const launch = stopAfterProgress => context => {
    const child = fork(fileURLToPath(new URL('./fixtures/cleanup-worker.mjs', import.meta.url)), [root, JSON.stringify({ ...context, stopAfterProgress })],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr = `${stderr}${bytes}`.slice(-2000); });
    const exited = new Promise(resolve => child.once('exit', code => resolve({ code, stderr: withoutFfiNotice(stderr, child.pid) })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    f.children.push({ child, exited });
    return attachAttemptChild(child, context);
  };
  const f = { root, store, project, register, append, launch, children: [] }; return f;
}

async function waitFile(file) {
  for (let tries = 0; tries < 300; tries++) {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.fail('Fixture did not reach its durable boundary.');
}

test('project processing catches up empty tracked chats, isolates source failures, and never catches up untracked chats', async t => {
  const f = await fixture(t);
  for (const id of ['empty', 'missing', 'stopped']) await f.register(id);
  await f.register('stopped', 'untrack'); await f.append('missing', 'kept'); await f.append('stopped', 'paused');
  const visited = [];
  const prepared = await prepareProcessing(f.store, 'project', { kind: 'project' }, { reconcileChat: async ({ sessionId }) => {
    visited.push(sessionId);
    if (sessionId === 'empty') { await f.append('empty', 'caught'); return { status: 'caught-up' }; }
    return { status: 'pending', reason: 'SOURCE_UNAVAILABLE' };
  } });
  assert.equal(prepared.state, 'created'); assert.deepEqual(visited.sort(), ['empty', 'missing']);
  assert.deepEqual(prepared.run.selection.map(item => item.recordId).sort(), ['caught', 'kept', 'paused']);
  assert(prepared.run.warnings.some(warning => warning.includes('SOURCE_UNAVAILABLE')));
  await f.append('empty', 'arrived-later');
  assert.deepEqual((await readProcessingInput(f.store, prepared.run)).parts.map(item => item.text).sort(), ['caught', 'kept', 'paused']);
  const different = await prepareProcessing(f.store, 'project', { kind: 'chat', client: 'claude', sessionId: 'empty' }, { reconcileChat: () => assert.fail('Caught up while a run was reserved') });
  assert.equal(different.state, 'pending'); assert.equal(different.scopeMatches, false);
  assert.equal(different.run.id, prepared.run.id);
});

test('cleanup retry after durable progress preserves later appends and publishes latest result before releasing the run', async t => {
  const f = await fixture(t); await f.register('chat'); await f.append('chat', 'one'); await f.append('chat', 'two');
  const prepared = await prepareProcessing(f.store, 'project', { kind: 'chat', client: 'claude', sessionId: 'chat' }, { reconcileChat: async () => ({ status: 'caught-up' }) });
  await f.append('chat', 'later');
  await launchOwnedAttempt(f.store, 'project', { runId: prepared.run.id, launch: f.launch(true) });
  await waitFile(path.join(f.root, 'progress')); f.children[0].child.kill('SIGKILL'); await f.children[0].exited;
  const stopped = await inspectAttempt(f.store, 'project');
  assert.equal(stopped.active, false); assert.equal(stopped.run.cleanup.next, 1); assert(stopped.run.cleanup.ack);
  await launchOwnedAttempt(f.store, 'project', { runId: prepared.run.id, launch: f.launch(false) });
  assert.deepEqual(await f.children[1].exited, { code: 0, stderr: '' });
  const result = JSON.parse(await waitFile(path.join(f.root, 'outcome.json')));
  assert.equal(result.status, 'nothing-useful'); assert.equal(result.counts.handled, 2); assert.equal(result.counts.remaining, 1);
  assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', 'chat'))).records, 1);
  await withProject(f.store, 'project', async ({ directory }) => {
    assert.equal(await readJSON(f.store.pin, `${directory}/run.json`, { missing: true }), null);
    assert.deepEqual((await readJSON(f.store.pin, `${directory}/result.json`)).value, result);
  });
});

test('successful nothing-useful processing removes an untracked empty queue and retains its opt-out', async t => {
  const f = await fixture(t); await f.register('chat', 'untrack'); await f.append('chat', 'one');
  const prepared = await prepareProcessing(f.store, 'project', { kind: 'project' }, { reconcileChat: () => assert.fail('Read an untracked source') });
  const before = await readChat(f.store, 'claude', 'chat');
  await launchOwnedAttempt(f.store, 'project', { runId: prepared.run.id, launch: f.launch(false) });
  assert.deepEqual(await f.children[0].exited, { code: 0, stderr: '' });
  assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', 'chat'))).exists, false);
  assert.equal((await readChat(f.store, 'claude', 'chat')).hash, before.hash);
});

test('chat scope cannot freeze input from a different chat', () => {
  const project = createProject({ id: 'project', root: process.cwd(), destination: { kind: 'directory', path: path.join(os.tmpdir(), 'notes') } });
  const selection = [{ client: 'claude', sessionId: 'first', recordId: 'record', hash: 'a'.repeat(64) }];
  const run = createRun(project, selection, { scope: { kind: 'chat', client: 'claude', sessionId: 'first' } });
  assert.throws(() => validateRun({ ...run, scope: { ...run.scope, sessionId: 'other' } }), { code: 'RUN_INVALID' });
});

test('status only reads bounded observations and empty processing replaces the latest outcome', async t => {
  const { readProjectStatus } = await import('../src/control/status.mjs');
  const f = await fixture(t);
  assert.deepEqual(await readProjectStatus(null, 'project'), { state: 'unconfigured' });
  await f.register('tracked'); await f.register('stopped', 'untrack');
  const before = await readChat(f.store, 'claude', 'tracked');
  const status = await readProjectStatus(f.store, 'project');
  assert.equal(status.state, 'idle'); assert.equal(status.counts.tracked, 1); assert.equal(status.counts.optedOut, 1);
  assert.equal(status.latest, null); assert.equal(status.run, null);
  assert.equal((await readChat(f.store, 'claude', 'tracked')).hash, before.hash);
  assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', 'tracked'))).exists, false);
  const bounded = await readProjectStatus(f.store, 'project', { inventoryLimit: 1 });
  assert.equal(bounded.counts.chats, 1); assert.equal(bounded.counts.incomplete, true);
  const empty = await prepareProcessing(f.store, 'project', { kind: 'project' }, { reconcileChat: async () => ({ status: 'pending', reason: 'SOURCE_UNAVAILABLE' }) });
  assert.equal(empty.state, 'empty');
  const after = await readProjectStatus(f.store, 'project');
  assert.equal(after.latest.status, 'empty'); assert.equal(after.latest.counts.remaining, null);
  assert.ok(after.latest.warnings.some(item => item.includes('SOURCE_UNAVAILABLE')));
});
