import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createProject } from '../src/core/settings.mjs';
import { createRun, replaceAttempt } from '../src/core/run.mjs';
import { initializeStore, withProject } from '../src/storage/store.mjs';
import { readJSON, writeJSON } from '../src/storage/files.mjs';
import { attachAttemptChild, inspectAttempt, launchOwnedAttempt } from '../src/storage/attempts.mjs';

const worker = fileURLToPath(new URL('./fixtures/attempt-worker.mjs', import.meta.url));

async function waitFor(fn, milliseconds = 7000) {
  const deadline = Date.now() + milliseconds;
  while (true) {
    const result = await fn();
    if (result) return result;
    if (Date.now() >= deadline) assert.fail('Timed out waiting for the fixture boundary.');
    await delay(20);
  }
}

async function readIfPresent(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function childProcess(t, mode, root, options) {
  const child = fork(worker, [mode, root, JSON.stringify(options)], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = `${stderr}${bytes}`.slice(-4000); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  return { child, exited };
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-v2-attempt-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'project'));
  const project = createProject({ id: 'demo', root: path.join(root, 'project'), destination: { kind: 'directory', path: path.join(root, 'notes') } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const run = createRun(project, [{ client: 'codex', sessionId: 'synthetic', recordId: 'one', hash: 'a'.repeat(64) }]);
  await withProject(store, 'demo', async ({ directory }) => {
    await writeJSON(store.pin, `${directory}/run.json`, run, { expectedHash: null });
  });
  const children = [];
  const launch = async context => {
    const spawned = childProcess(t, 'worker', root, context); children.push(spawned);
    return attachAttemptChild(spawned.child, context);
  };
  return { root, store, run, launch, children };
}

async function finish(f) {
  await fs.writeFile(path.join(f.root, 'finish'), '');
  return waitFor(() => readIfPresent(path.join(f.root, 'outcome.json')));
}

test('worker gate permits queue appends during work and prevents a competing launch', async t => {
  const f = await fixture(t);
  const started = await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: f.launch });
  assert.equal(started.state, 'running');
  assert.equal((await inspectAttempt(f.store, 'demo')).active, true);
  await withProject(f.store, 'demo', async ({ directory }) => {
    await writeJSON(f.store.pin, `${directory}/chats/queued-during-work.json`, { exchange: 'new synthetic input' }, { expectedHash: null });
  });
  const repeated = await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: () => assert.fail('Started a competing worker') });
  assert.deepEqual(repeated, started);
  assert.deepEqual(await finish(f), { ok: true });
  assert.equal((await f.children[0].exited).code, 0);
  const state = await inspectAttempt(f.store, 'demo');
  assert.equal(state.active, false);
  assert.deepEqual(state.run.warnings, ['synthetic worker finished']);
  await withProject(f.store, 'demo', async ({ directory }) => {
    assert.equal((await readJSON(f.store.pin, `${directory}/chats/queued-during-work.json`)).value.exchange, 'new synthetic input');
  });
});

test('SIGKILL releases OS ownership and a fresh attempt retries the same pending run', async t => {
  const f = await fixture(t);
  const first = await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: f.launch });
  f.children[0].child.kill('SIGKILL'); await f.children[0].exited;
  const dead = await inspectAttempt(f.store, 'demo');
  assert.equal(dead.active, false);
  assert.equal(dead.run.attempt.id, first.attemptId);
  const second = await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: f.launch });
  assert.equal(second.runId, first.runId);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.deepEqual(await finish(f), { ok: true });
  assert.equal((await f.children[1].exited).code, 0);
});

test('late worker publication is fenced against replacement attempt metadata', async t => {
  const f = await fixture(t);
  await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: f.launch });
  const replacement = randomUUID();
  // Deliberate external state replacement proves the publication fence itself;
  // supported launch paths additionally refuse replacement of a live OS owner.
  await withProject(f.store, 'demo', async ({ directory }) => {
    const snapshot = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, replaceAttempt(snapshot.value, replacement), { expectedHash: snapshot.hash });
  });
  assert.equal((await finish(f)).code, 'RUN_ATTEMPT_STALE');
  await f.children[0].exited;
  const state = await inspectAttempt(f.store, 'demo');
  assert.equal(state.run.attempt.id, replacement);
  assert.deepEqual(state.run.warnings, []);
  assert.equal(state.active, false);
});

for (const [mode, stage] of [['before-publication', 'owned'], ['before-activation', 'published']]) {
  test(`parent death ${mode} releases the waiting child without doing work`, async t => {
    const f = await fixture(t);
    const parent = childProcess(t, mode, f.root, { runId: f.run.id });
    const boundary = new Promise(resolve => parent.child.on('message', value => { if (value.stage === stage) resolve(value); }));
    const message = await Promise.race([boundary, delay(7000, undefined, { ref: false }).then(() => assert.fail('Missing parent boundary'))]);
    t.after(() => { try { process.kill(message.workerPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
    assert.equal((await inspectAttempt(f.store, 'demo')).active, true);
    parent.child.kill('SIGKILL'); await parent.exited;
    await waitFor(async () => !(await inspectAttempt(f.store, 'demo')).active);
    const state = await inspectAttempt(f.store, 'demo');
    assert.equal(state.run.id, f.run.id);
    if (mode === 'before-publication') assert.equal(state.run.attempt, null);
    else assert.ok(state.run.attempt);
    assert.deepEqual(state.run.warnings, []);
    assert.equal(await readIfPresent(path.join(f.root, 'working.json')), null);
    // The worker releases its gate before its catch handler publishes the result.
    const outcome = await waitFor(() => readIfPresent(path.join(f.root, 'outcome.json')));
    assert.equal(outcome.code, 'ATTEMPT_PARENT_LOST');
    await fs.rm(path.join(f.root, 'outcome.json'));
    await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: f.launch });
    assert.deepEqual(await finish(f), { ok: true });
  });
}

test('activated worker continues after its launching caller exits', async t => {
  const f = await fixture(t);
  const parent = childProcess(t, 'active-parent', f.root, { runId: f.run.id });
  assert.equal((await parent.exited).code, 0);
  assert.equal((await inspectAttempt(f.store, 'demo')).active, true);
  assert.ok(await waitFor(() => readIfPresent(path.join(f.root, 'working.json'))));
  assert.deepEqual(await finish(f), { ok: true });
  await waitFor(async () => !(await inspectAttempt(f.store, 'demo')).active);
});

test('released owner capability cannot publish again', async t => {
  const f = await fixture(t);
  await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: async context => {
    const spawned = childProcess(t, 'worker', f.root, { ...context, postRelease: true });
    f.children.push(spawned);
    return attachAttemptChild(spawned.child, context);
  } });
  assert.equal((await finish(f)).code, 'ATTEMPT_NOT_OWNED');
  await f.children[0].exited;
  assert.equal((await inspectAttempt(f.store, 'demo')).active, false);
});


test('bounded startup aborts an owned but unpublished child and leaves the run retryable', async t => {
  const f = await fixture(t);
  await assert.rejects(launchOwnedAttempt(f.store, 'demo', {
    runId: f.run.id, startupTimeoutMs: 300,
    launch: async context => {
      const spawned = childProcess(t, 'worker', f.root, context); f.children.push(spawned);
      const handshake = attachAttemptChild(spawned.child, context);
      return { ...handshake, ready: handshake.ready.then(() => new Promise(() => {})) };
    },
  }), { code: 'ATTEMPT_STARTUP_TIMEOUT' });
  await f.children[0].exited;
  const state = await inspectAttempt(f.store, 'demo');
  assert.equal(state.active, false);
  assert.equal(state.run.attempt, null);
  assert.equal(await readIfPresent(path.join(f.root, 'working.json')), null);
});

test('worker ownership lasts through a publication even if work forgets to await it', async t => {
  const f = await fixture(t);
  await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: async context => {
    const spawned = childProcess(t, 'worker', f.root, { ...context, unawaited: true }); f.children.push(spawned);
    return attachAttemptChild(spawned.child, context);
  } });
  await fs.writeFile(path.join(f.root, 'finish'), '');
  await waitFor(async () => {
    try { await fs.stat(path.join(f.root, 'publishing')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  // Read the gate directly: the short publication also holds the project gate.
  const { probeGate } = await import('../src/storage/gates.mjs');
  const { gateOptions } = await import('../src/storage/store.mjs');
  const layout = await readJSON(f.store.pin, 'store/layout.json');
  assert.equal(probeGate(layout.value.projects.demo.workerGate, gateOptions).busy, true);
  assert.deepEqual(await waitFor(() => readIfPresent(path.join(f.root, 'outcome.json'))), { ok: true });
  await f.children[0].exited;
  assert.equal((await inspectAttempt(f.store, 'demo')).active, false);
});


test('an unawaited failed publication still fails the attempt and releases ownership', async t => {
  const f = await fixture(t);
  await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: async context => {
    const spawned = childProcess(t, 'worker', f.root, { ...context, unawaitedFailure: true }); f.children.push(spawned);
    return attachAttemptChild(spawned.child, context);
  } });
  assert.equal((await finish(f)).code, 'SYNTHETIC_PUBLICATION_FAILED');
  await f.children[0].exited;
  const state = await inspectAttempt(f.store, 'demo');
  assert.equal(state.active, false);
  assert.deepEqual(state.run.warnings, []);
});

test('startup publication that exhausts the budget never activates the worker', async t => {
  const f = await fixture(t);
  let now = 0, activations = 0;
  const rename = fs.rename;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(fs, 'rename', async (from, to) => {
    const value = await rename(from, to);
    if (to.endsWith(`${path.sep}run.json`)) now = 6000;
    return value;
  });
  await assert.rejects(launchOwnedAttempt(f.store, 'demo', {
    runId: f.run.id,
    launch: async context => {
      const handshake = await f.launch(context);
      return { ...handshake, activate() { activations++; return handshake.activate(); } };
    },
  }), { code: 'ATTEMPT_STARTUP_TIMEOUT' });
  await f.children[0].exited;
  assert.equal(activations, 0);
  assert.equal((await inspectAttempt(f.store, 'demo')).active, false);
  assert.equal(await readIfPresent(path.join(f.root, 'working.json')), null);
});


test('an explicitly handled publication failure does not fail completed work again', async t => {
  const f = await fixture(t);
  await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: async context => {
    const spawned = childProcess(t, 'worker', f.root, { ...context, handledFailure: true }); f.children.push(spawned);
    return attachAttemptChild(spawned.child, context);
  } });
  assert.deepEqual(await finish(f), { ok: true });
  assert.equal((await f.children[0].exited).code, 0);
});


for (const chainedUnawaited of ['then', 'finally']) test(`an unawaited rejected ${chainedUnawaited} chain still fails the attempt`, async t => {
  const f = await fixture(t);
  await launchOwnedAttempt(f.store, 'demo', { runId: f.run.id, launch: async context => {
    const spawned = childProcess(t, 'worker', f.root, { ...context, unawaitedFailure: true, chainedUnawaited }); f.children.push(spawned);
    return attachAttemptChild(spawned.child, context);
  } });
  assert.equal((await finish(f)).code, 'SYNTHETIC_PUBLICATION_FAILED');
  assert.equal((await f.children[0].exited).code, 1);
});
