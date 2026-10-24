import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '../core/errors.mjs';
import { assertAttempt, replaceAttempt, validateRun } from '../core/run.mjs';
import { readJSON, writeJSON } from './files.mjs';
import { GateError, probeGate, tryAcquireExistingGate } from './gates.mjs';
import { gateOptions, withProject } from './store.mjs';

const owners = new WeakMap();
const PREFIX = 'cuefluent-attempt-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function identity(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('ATTEMPT_ID_INVALID', 'Run and attempt identities must be lowercase UUIDs.');
}

async function beforeDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Worker startup did not complete.'), { code: 'ATTEMPT_STARTUP_TIMEOUT' })), Math.max(0, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}

function timeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    fail('ATTEMPT_TIMEOUT_INVALID', 'Startup timeout must be between 1 and 60000 milliseconds.');
  }
  return value;
}

async function pending(store, context, runId) {
  const snapshot = await readJSON(store.pin, `${context.directory}/run.json`, { missing: true });
  if (!snapshot) fail('RUN_MISSING', 'There is no pending run for this project.');
  const run = validateRun(snapshot.value);
  if (run.projectId !== context.project.id || (runId !== undefined && run.id !== runId)) {
    fail('RUN_CHANGED', 'The pending run no longer matches this operation.');
  }
  return { ...snapshot, value: run };
}

/** Liveness is the OS gate, including during the unpublished startup handshake. */
export async function inspectAttempt(store, projectId) {
  return withProject(store, projectId, async context => {
    const snapshot = await pending(store, context);
    return Object.freeze({ run: snapshot.value, active: Boolean(probeGate(context.gates.workerGate, gateOptions).busy) });
  });
}

/** The trusted launch callback selects executable code; no executable path is persisted. */
export async function launchOwnedAttempt(store, projectId, { runId, launch, startupTimeoutMs = 5000 } = {}) {
  timeout(startupTimeoutMs); identity(runId);
  if (typeof launch !== 'function') fail('ATTEMPT_LAUNCH_REQUIRED', 'A trusted worker launcher is required.');
  const initial = await withProject(store, projectId, async context => {
    const snapshot = await pending(store, context, runId);
    return { run: snapshot.value, workerGate: context.gates.workerGate,
      active: Boolean(probeGate(context.gates.workerGate, gateOptions).busy) };
  });
  if (initial.active) return Object.freeze({ state: 'running', runId: initial.run.id, attemptId: initial.run.attempt?.id ?? null });
  const attemptId = randomUUID();
  let child, abandoned = false;
  const deadline = performance.now() + startupTimeoutMs;
  try {
    const launching = Promise.resolve().then(() => launch(Object.freeze({ storeRoot: store.root, projectId, runId: initial.run.id,
      attemptId, workerGate: initial.workerGate, startupTimeoutMs })));
    launching.then(value => {
      if (abandoned) Promise.resolve().then(() => value?.abort?.()).catch(() => {});
    }, () => {});
    child = await beforeDeadline(launching, deadline);
    if (!child || !child.ready || typeof child.activate !== 'function' || typeof child.abort !== 'function') {
      fail('ATTEMPT_LAUNCH_INVALID', 'The worker launcher did not return a startup handshake.');
    }
    await beforeDeadline(child.ready, deadline);
    await withProject(store, projectId, async context => {
      const current = await pending(store, context, initial.run.id);
      if ((current.value.attempt?.id ?? null) !== (initial.run.attempt?.id ?? null)) {
        fail('RUN_ATTEMPT_STALE', 'Another attempt replaced this startup.');
      }
      if (!probeGate(context.gates.workerGate, gateOptions).busy) {
        fail('ATTEMPT_OWNER_MISSING', 'The ready worker no longer holds its OS gate.');
      }
      const run = replaceAttempt(current.value, attemptId);
      await writeJSON(store.pin, `${context.directory}/run.json`, run, { expectedHash: current.hash });
    });
    // Publication can outlast the handshake budget. Do not activate a worker
    // after we already know startup has expired.
    if (performance.now() >= deadline) fail('ATTEMPT_STARTUP_TIMEOUT', 'Worker startup did not complete.');
    await beforeDeadline(child.activate(), deadline);
    return Object.freeze({ state: 'running', runId: initial.run.id, attemptId });
  } catch (error) {
    // A published but unactivated attempt stays recoverable; an activated worker
    // may continue if the caller loses the acknowledgment. Its gate is authority.
    abandoned = true;
    try { await child?.abort?.(); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

/** Parent-side IPC adapter for a trusted, separately launched child process. */
export function attachAttemptChild(child, { attemptId, startupTimeoutMs = 5000 } = {}) {
  timeout(startupTimeoutMs); identity(attemptId);
  let readyResolve, readyReject, activeResolve, activeReject;
  let activationSent = false, activated = false, readySeen = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const active = new Promise((resolve, reject) => { activeResolve = resolve; activeReject = reject; });
  // The activation promise may fail while the parent is still awaiting ready.
  ready.catch(() => {}); active.catch(() => {});
  const reject = error => { readyReject(error); activeReject(error); cleanup(); };
  const onMessage = message => {
    if (message?.attemptId !== attemptId) return;
    if (message.type === `${PREFIX}ready`) { readySeen = true; readyResolve(); }
    if (message.type === `${PREFIX}active`) {
      if (!readySeen || !activationSent) {
        reject(Object.assign(new Error('Worker activated outside the startup handshake.'), { code: 'ATTEMPT_HANDSHAKE_INVALID' })); return;
      }
      activated = true; activeResolve(); cleanup(); child.unref?.();
    }
    if (message.type === `${PREFIX}error`) reject(Object.assign(new Error('Worker startup failed.'), { code: message.code ?? 'ATTEMPT_WORKER_FAILED' }));
  };
  const onExit = () => reject(Object.assign(new Error('Worker exited during startup.'), { code: 'ATTEMPT_WORKER_EXITED' }));
  const onDisconnect = () => { if (!activated) onExit(); };
  const onError = error => reject(error);
  const timer = setTimeout(() => reject(Object.assign(new Error('Worker startup did not complete.'), { code: 'ATTEMPT_STARTUP_TIMEOUT' })), startupTimeoutMs);
  function cleanup() {
    clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit);
    child.off('disconnect', onDisconnect); child.off('error', onError);
  }
  child.on('message', onMessage); child.on('exit', onExit);
  child.on('disconnect', onDisconnect); child.on('error', onError);
  return Object.freeze({
    ready,
    activate() {
      if (!activationSent) {
        activationSent = true;
        try { child.send({ type: `${PREFIX}activate`, attemptId }, error => { if (error) reject(error); }); }
        catch (error) { reject(error); }
      }
      return active;
    },
    abort() {
      cleanup();
      if (!activationSent) child.kill();
    },
  });
}

function awaitActivation(channel, attemptId, startupTimeoutMs) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message?.type === `${PREFIX}activate` && message.attemptId === attemptId) {
        cleanup(); resolve();
      }
    };
    const onDisconnect = () => { cleanup(); reject(Object.assign(new Error('Parent disappeared before activation.'), { code: 'ATTEMPT_PARENT_LOST' })); };
    const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('Activation did not arrive.'), { code: 'ATTEMPT_STARTUP_TIMEOUT' })); }, startupTimeoutMs);
    function cleanup() { clearTimeout(timer); channel.off('message', onMessage); channel.off('disconnect', onDisconnect); }
    channel.on('message', onMessage); channel.on('disconnect', onDisconnect);
    if (!channel.connected) { onDisconnect(); return; }
    try { channel.send({ type: `${PREFIX}ready`, attemptId }, error => { if (error) onDisconnect(); }); }
    catch { onDisconnect(); }
  });
}

/** Worker-side ownership. Startup must have a parent IPC channel; activated work
 * deliberately survives that parent's exit. All asynchronous work is outside
 * project/settings gates. The worker gate is held until work and its writes end.
 */
export async function ownAttempt(store, projectId, { runId, attemptId, workerGate, channel = process, startupTimeoutMs = 5000 } = {}, work) {
  timeout(startupTimeoutMs); identity(runId); identity(attemptId);
  if (typeof work !== 'function' || typeof channel?.send !== 'function') {
    fail('ATTEMPT_WORKER_INVALID', 'An owned worker needs work and a parent IPC channel.');
  }
  let gate, owner, failure, workFinished = false;
  try {
    await withProject(store, projectId, context => {
      const expected = context.gates.workerGate;
      if (workerGate && ['path', 'id', 'device', 'inode'].some(key => workerGate[key] !== expected[key])) fail('ATTEMPT_GATE_CHANGED', 'The worker gate differs from its launch binding.');
      const acquired = tryAcquireExistingGate(expected, gateOptions);
      if (acquired.busy) fail('ATTEMPT_ACTIVE', 'A worker already owns this project.');
      gate = acquired.acquired;
    });
    await awaitActivation(channel, attemptId, startupTimeoutMs);
    owner = Object.freeze({ runId, attemptId, projectId });
    owners.set(owner, { store, projectId, runId, attemptId, active: true, accepting: true, publications: new Set(), failures: new Set() });
    await withCurrentAttempt(owner, () => {});
    // IPC is only the startup handshake. Closing it lets both processes proceed
    // independently and prevents later parent loss from cancelling active work.
    await new Promise(resolve => {
      try { channel.send({ type: `${PREFIX}active`, attemptId }, () => resolve()); }
      catch { resolve(); }
    });
    if (channel.connected) channel.disconnect();
    const result = await work(owner);
    workFinished = true;
    return result;
  } catch (error) {
    failure = error;
    if (channel.connected) {
      try { channel.send({ type: `${PREFIX}error`, attemptId, code: error.code ?? 'ATTEMPT_WORKER_FAILED' }, () => {}); } catch { /* Parent may already be gone. */ }
    }
    throw error;
  } finally {
    if (owner) {
      const state = owners.get(owner);
      state.accepting = false;
      while (state.publications.size) await Promise.allSettled([...state.publications]);
      state.active = false;
    }
    const unattended = workFinished && [...(owners.get(owner)?.failures ?? [])].find(item => !item.observed);
    failure ??= unattended?.error;
    try { gate?.release(); }
    catch (error) {
      if (failure) { try { Object.defineProperty(failure, 'releaseError', { value: error, configurable: true }); } catch {} }
      else throw new GateError('GATE_RELEASE_FAILED', 'The attempt finished but its worker gate release failed.', { cause: error });
    }
    if (unattended) throw unattended.error;
  }
}

/** Direct notes run deterministic draft/save work in the calling MCP process.
 * That actual process owns the same OS worker gate for the entire operation;
 * no model, background collection, or IPC activation is involved. */
export async function ownDirectAttempt(store, projectId, runId, work) {
  identity(runId);
  if (typeof work !== 'function') fail('ATTEMPT_WORKER_INVALID', 'An owned operation needs work.');
  const attemptId = randomUUID();
  let gate, owner, failure, workFinished = false;
  try {
    await withProject(store, projectId, async context => {
      const snapshot = await pending(store, context, runId);
      if (snapshot.value.scope.kind !== 'direct') fail('DIRECT_NOTE_RUN_REQUIRED', 'This operation only accepts direct note drafts.');
      const acquired = tryAcquireExistingGate(context.gates.workerGate, gateOptions);
      if (acquired.busy) fail('ATTEMPT_ACTIVE', 'A worker already owns this project.');
      gate = acquired.acquired;
      await writeJSON(store.pin, `${context.directory}/run.json`, replaceAttempt(snapshot.value, attemptId), { expectedHash: snapshot.hash });
    });
    owner = Object.freeze({ runId, attemptId, projectId });
    owners.set(owner, { store, projectId, runId, attemptId, active: true, accepting: true, publications: new Set(), failures: new Set() });
    const result = await work(owner);
    workFinished = true;
    return result;
  } catch (error) { failure = error; throw error; }
  finally {
    if (owner) {
      const state = owners.get(owner);
      state.accepting = false;
      while (state.publications.size) await Promise.allSettled([...state.publications]);
      state.active = false;
    }
    const unattended = workFinished && [...(owners.get(owner)?.failures ?? [])].find(item => !item.observed);
    failure ??= unattended?.error;
    try { gate?.release(); }
    catch (error) {
      if (failure) { try { Object.defineProperty(failure, 'releaseError', { value: error, configurable: true }); } catch {} }
      else throw new GateError('GATE_RELEASE_FAILED', 'The direct operation finished but its worker gate release failed.', { cause: error });
    }
    if (unattended) throw unattended.error;
  }
}

/** Only a live in-process owner capability can publish. Re-read exact run state
 * inside the short project gate; callers must finish every publication there.
 */
export function withCurrentAttempt(owner, fn) {
  const state = owners.get(owner);
  if (!state?.active || !state.accepting || typeof fn !== 'function') fail('ATTEMPT_NOT_OWNED', 'A live worker capability is required.');
  const publication = withProject(state.store, state.projectId, async context => {
    if (!state.active) fail('ATTEMPT_NOT_OWNED', 'The worker has released ownership.');
    const snapshot = await pending(state.store, context, state.runId);
    assertAttempt(snapshot.value, state.attemptId);
    return fn(Object.freeze({ ...context, run: snapshot.value, hash: snapshot.hash }));
  });
  return trackPublication(state, publication);
}

function trackPublication(state, publication) {
  const observation = { observed: false, error: null };
  state.publications.add(publication);
  publication.then(() => state.publications.delete(publication), error => {
    observation.error = error; state.failures.add(observation); state.publications.delete(publication);
  });
  // Every branch has its own observation. Chaining a success-only handler or a
  // finally transfers the rejection to its child; it does not handle it.
  return Object.freeze({
    then(resolve, reject) { observation.observed = true; return trackPublication(state, publication.then(resolve, reject)); },
    catch(reject) { observation.observed = true; return trackPublication(state, publication.catch(reject)); },
    finally(callback) { observation.observed = true; return trackPublication(state, publication.finally(callback)); },
  });
}

/** Acquire in settings → project → writer order, then release short gates for
 * public filesystem work. Only this live worker owns the run; each persistence
 * callback reacquires short gates and checks its exact prior hash and attempt. */
export async function withAttemptWriter(owner, fn, { timeoutMs = 5000 } = {}) {
  timeout(timeoutMs);
  if (typeof fn !== 'function') fail('ATTEMPT_WORKER_INVALID', 'Writer work requires a callback.');
  const state = owners.get(owner);
  if (!state?.active || !state.accepting) fail('ATTEMPT_NOT_OWNED', 'A live worker capability is required.');
  const deadline = performance.now() + timeoutMs;
  let acquired, context;
  try { while (!acquired) {
    await withCurrentAttempt(owner, current => {
      const result = tryAcquireExistingGate(state.store.writerGate, gateOptions);
      if (result.acquired) { acquired = result.acquired; context = current; }
    });
    if (acquired) break;
    if (performance.now() >= deadline) fail('GATE_BUSY', 'The notes writer remained busy until its bounded deadline.');
    await delay(Math.max(0, Math.min(25, deadline - performance.now())));
  } } catch (error) {
    try { acquired?.release(); } catch (releaseError) { try { Object.defineProperty(error, 'releaseError', { value: releaseError, configurable: true }); } catch {} }
    throw error;
  }
  let run = context.run, hash = context.hash, failure;
  const assertCurrent = () => withCurrentAttempt(owner, current => {
    if (current.hash !== hash) fail('RUN_CHANGED', 'The pending run changed during the owned write.');
  });
  const persist = async next => withCurrentAttempt(owner, async current => {
    if (current.hash !== hash) fail('RUN_CHANGED', 'The pending run changed during the owned write.');
    const result = await writeJSON(state.store.pin, `${current.directory}/run.json`, next, { expectedHash: hash });
    run = next; hash = result.hash; return next;
  });
  try { return await fn(Object.freeze({ ...context, get run() { return run; }, get hash() { return hash; }, persist, assertCurrent })); }
  catch (error) { failure = error; throw error; }
  finally {
    try { acquired.release(); }
    catch (error) {
      if (failure) { try { Object.defineProperty(failure, 'releaseError', { value: error, configurable: true }); } catch {} }
      else throw error;
    }
  }
}
