import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Database } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { tryAcquireExistingGate } from '../src/storage/gates.mjs';
import { buildClaudePromptContext } from '../src/client/history.mjs';
import { createProject } from '../src/core/settings.mjs';
import { advanceChat } from '../src/core/chat.mjs';
import { initializeStore, readSettings, updateSettings, gateOptions } from '../src/storage/store.mjs';
import { readChat, setChatTracking, selectChatQueue, updateChat } from '../src/storage/chats.mjs';
import { createSyncLaunchGuard, ingestNativeEvent, validateNativeEvent, ensureSyncSteward, launchDetachedSyncSteward, runSyncSteward } from '../src/sync/ingress.mjs';

const entry = fileURLToPath(new URL('./fixtures/sync-worker.mjs', import.meta.url));
async function fixture(t, tracking = 'auto') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-ingress-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const project = createProject({ id: 'project', root: cwd, destination: { kind: 'directory', path: path.join(root, 'notes') }, tracking });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const sourcePath = path.join(root, 'native.jsonl'); await fs.writeFile(sourcePath, '');
  const event = { client: 'claude', sessionId: 'synthetic', cwd, kind: 'start', source: { path: sourcePath, identity: null },
    startSource: 'startup', newSession: true, completion: null, history: null, launchMarker: null };
  return { root, cwd, store, project, sourcePath, event };
}
const prompt = event => ({ ...event, kind: 'prompt', startSource: null, newSession: false, history: null, promptId: 'one-human' });
async function inventory(root) {
  const output = [];
  async function walk(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), stat = await fs.lstat(file, { bigint: true });
      output.push([path.relative(root, file), String(stat.ino), String(stat.size), String(stat.mtimeNs)]);
      if (stat.isDirectory()) await walk(file);
    }
  }
  await walk(root); return output;
}
async function waitFor(fn, milliseconds = 10_000) {
  const end = Date.now() + milliseconds;
  for (;;) {
    try { const result = await fn(); if (result) return result; }
    catch (error) { if (error.code !== 'GATE_BUSY') throw error; }
    if (Date.now() > end) assert.fail('Synthetic retry did not reach its boundary.');
    await delay(20);
  }
}
async function marker(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

test('automatic ingress writes nothing for unconfigured, manual-untracked, historical resume and excluded processing sessions', async t => {
  const f = await fixture(t, 'manual'), before = await inventory(f.store.root), never = () => assert.fail('Ineligible event launched a worker');
  assert.deepEqual(await ingestNativeEvent(null, f.event, { schedule: never }), { status: 'unconfigured' });
  assert.deepEqual(await ingestNativeEvent(f.store, prompt(f.event), { schedule: never }), { status: 'ineligible' });
  assert.deepEqual(await inventory(f.store.root), before);
  const settings = await readSettings(f.store); await updateSettings(f.store, { schemaVersion: 1, projects: [{ ...f.project, tracking: 'auto' }] }, { expectedHash: settings.hash });
  const autoBefore = await inventory(f.store.root);
  assert.deepEqual(await ingestNativeEvent(f.store, { ...f.event, newSession: false, startSource: 'resume' }, { schedule: never }), { status: 'ineligible' });
  const processing = { ...f.event, launchMarker: '10000000-0000-4000-8000-000000000001' };
  assert.deepEqual(await ingestNativeEvent(f.store, processing, { verifyProcessingSession: async event => event.sessionId === 'synthetic', schedule: never }), { status: 'excluded', reason: 'PROCESSING_SESSION' });
  assert.deepEqual(await ingestNativeEvent(f.store, processing, { schedule: never }), { status: 'pending', reason: 'PROCESSING_IDENTITY_UNVERIFIED' });
  assert.deepEqual(await inventory(f.store.root), autoBefore); assert.equal(await readChat(f.store, 'claude', 'synthetic'), null);
  assert(before.length > 0);
});

test('automatic enrollment durably records its first prompt before scheduling; manual mode prevents further enrollment', async t => {
  const f = await fixture(t); let scheduled;
  const result = await ingestNativeEvent(f.store, prompt(f.event), { schedule: async request => {
    scheduled = request; const chat = await readChat(f.store, 'claude', 'synthetic');
    assert.equal(chat.value.tracked, true); assert.equal(chat.value.pending.id, request.requestId); assert.equal(chat.value.generation, request.generation);
  } });
  assert.deepEqual(result, { status: 'enrolled', scheduled: true, enrollmentNonce: (await readChat(f.store, 'claude', 'synthetic')).value.history.startPromptNonce }); assert.equal(scheduled.storeRoot, f.store.root);
  const settings = await readSettings(f.store); await updateSettings(f.store, { schemaVersion: 1, projects: [{ ...f.project, tracking: 'manual' }] }, { expectedHash: settings.hash });
  const completion = { promptId: 'first', kind: 'completed', finalTextHash: 'a'.repeat(64) };
  assert.deepEqual(await ingestNativeEvent(f.store, { ...f.event, kind: 'completed', newSession: false, startSource: null, completion }, { schedule: async () => {} }), { status: 'tracked', scheduled: true });
  const beforeEnd = await readChat(f.store, 'claude', 'synthetic');
  await ingestNativeEvent(f.store, { ...f.event, kind: 'end', newSession: false, startSource: null }, { schedule: async () => {} });
  assert.deepEqual((await readChat(f.store, 'claude', 'synthetic')).value.pending, beforeEnd.value.pending);
  assert.equal((await readChat(f.store, 'claude', 'synthetic')).value.history.mode, 'automatic');
  assert.deepEqual(await ingestNativeEvent(f.store, { ...f.event, sessionId: 'future' }, { schedule: async () => assert.fail('Manual future chat launched') }), { status: 'ineligible' });
});

test('automatic prompt enrollment remains durable pending when scheduling fails', async t => {
  const f = await fixture(t), event = { ...f.event, startSource: 'fork' };
  const ingress = await ingestNativeEvent(f.store, prompt(event), { schedule: async () => { throw new Error('Synthetic unavailable runner'); } });
  assert.deepEqual(ingress, { status: 'pending', reason: 'SYNC_RUNNER_UNAVAILABLE', enrollmentNonce: (await readChat(f.store, 'claude', 'synthetic')).value.history.startPromptNonce });
  const saved = await readChat(f.store, 'claude', 'synthetic'); assert.equal(saved.value.history.startPromptId, 'one-human'); assert.equal(saved.value.history.inheritedBoundary, null);
  assert.equal(saved.value.pending.reason, 'periodic'); assert.equal(saved.value.checkpoint.offset, 0);
  let inspected = 0, delays = []; const controller = new AbortController();
  const result = await runSyncSteward(f.store, { signal: controller.signal, retryDelayMs: 2, maxRetryDelayMs: 5, idleDelayMs: 7,
    observeSource: async () => 'unchanged-native-metadata',
    attempt: async () => { inspected++; return { status: 'pending', reason: 'TRANSCRIPT_BOUNDARY_PENDING', parts: 0 }; },
    wait: async ms => { delays.push(ms); if (delays.length === 4) controller.abort(); } });
  assert.equal(result.status, 'stopped'); assert.equal(inspected, 4); assert.deepEqual(delays, [2, 4, 5, 5]);
  assert.equal((await readChat(f.store, 'claude', 'synthetic')).hash, saved.hash);
});

test('ephemeral source-version cache skips only settled repeated sources and never a new durable request', async t => {
  const f = await fixture(t); await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => {} });
  let saved = await readChat(f.store, 'claude', 'synthetic');
  await updateChat(f.store, 'project', 'claude', 'synthetic', { expectedHash: saved.hash, change: chat => advanceChat(chat,
    { generation: chat.generation, checkpoint: chat.checkpoint, requestId: chat.pending.id, complete: true }) });
  let attempts = 0, sweeps = 0; const controller = new AbortController();
  await runSyncSteward(f.store, { signal: controller.signal, retryDelayMs: 2, maxRetryDelayMs: 5, idleDelayMs: 7,
    observeSource: async () => 'same-authoritative-native-version',
    attempt: async () => { attempts++; return { status: 'caught-up', parts: 0 }; },
    wait: async () => {
      if (++sweeps === 2) await ingestNativeEvent(f.store, { ...f.event, kind: 'end', startSource: null, newSession: false }, { schedule: async () => {} });
      if (sweeps === 3) controller.abort();
    } });
  assert.equal(attempts, 2); assert((await readChat(f.store, 'claude', 'synthetic')).value.pending);
});

test('bounded collector progress resets retry backoff while genuine no-progress pending work backs off', async t => {
  const f = await fixture(t); await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => {} });
  const controller = new AbortController(), waits = []; let attempts = 0;
  await runSyncSteward(f.store, { signal: controller.signal, retryDelayMs: 2, maxRetryDelayMs: 8, idleDelayMs: 9,
    observeSource: async () => null,
    attempt: async () => { attempts++; return { status: 'pending', parts: attempts === 2 ? 1 : 0,
      ...([1, 5].includes(attempts) ? { progress: true } : {}) }; },
    wait: async milliseconds => { waits.push(milliseconds); if (waits.length === 6) controller.abort(); } });
  assert.deepEqual(waits, [2, 2, 2, 4, 2, 2]); assert.equal(attempts, 6);
});

test('idle Codex polling uses physical hints but periodically rechecks authority and immediately handles fresh requests or bytes', async t => {
  const f = await fixture(t), event = { ...f.event, client: 'codex' };
  await ingestNativeEvent(f.store, prompt(event), { schedule: async () => {} });
  let saved = await readChat(f.store, 'codex', 'synthetic');
  await updateChat(f.store, 'project', 'codex', 'synthetic', { expectedHash: saved.hash, change: chat => advanceChat(chat,
    { generation: chat.generation, checkpoint: chat.checkpoint, requestId: chat.pending.id, complete: true }) });
  let clock = 0, sweeps = 0, attempts = 0; const controller = new AbortController();
  await runSyncSteward(f.store, { signal: controller.signal, now: () => clock, idleRecheckMs: 100,
    attempt: async () => { attempts++; return { status: 'caught-up', parts: 0 }; },
    wait: async () => {
      sweeps++; clock += 10;
      if (sweeps === 2) clock = 100;
      if (sweeps === 3) await fs.appendFile(f.sourcePath, 'changed-native-bytes');
      if (sweeps === 4) await ingestNativeEvent(f.store, { ...event, kind: 'end', startSource: null, newSession: false }, { schedule: async () => {} });
      if (sweeps === 5) controller.abort();
    } });
  assert.equal(attempts, 4); // initial, expiry with unchanged old path, append, fresh hook
});

test('unchanged pending source retries become quiet after bounded attempts and wake on a fresh request', async t => {
  const f = await fixture(t); await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => {} });
  let clock = 0, sweeps = 0, attempts = 0; const controller = new AbortController();
  await runSyncSteward(f.store, { signal: controller.signal, now: () => clock, idleRecheckMs: 100,
    retryDelayMs: 1, maxRetryDelayMs: 4, idleDelayMs: 5,
    attempt: async () => { attempts++; return { status: 'pending', reason: 'TRANSCRIPT_BOUNDARY_PENDING', parts: 0 }; },
    wait: async () => { sweeps++; clock++;
      if (sweeps === 6) await ingestNativeEvent(f.store, { ...f.event, kind: 'completed', startSource: null, newSession: false,
        completion: { promptId: 'new-turn', kind: 'completed', finalTextHash: null } }, { schedule: async () => {} });
      if (sweeps === 7) controller.abort();
    } });
  assert.equal(attempts, 5); assert.equal(sweeps, 7);
});

test('a removed or replaced launch path retires its steward and releases the OS gate without losing work', async t => {
  const f = await fixture(t); await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => {} });
  const launchFile = path.join(f.root, 'entry.mjs'); await fs.writeFile(launchFile, 'synthetic entry');
  const before = await readChat(f.store, 'claude', 'synthetic'); let attempts = 0;
  const result = await runSyncSteward(f.store, { launchAvailable: createSyncLaunchGuard(launchFile),
    attempt: async () => { attempts++; return { status: 'pending', parts: 0 }; },
    wait: async () => fs.rm(launchFile) });
  assert.deepEqual(result, { status: 'retired', reason: 'SYNC_RUNNER_UNAVAILABLE' }); assert.equal(attempts, 1);
  assert.equal((await readChat(f.store, 'claude', 'synthetic')).hash, before.hash);
  let launched = false; await ensureSyncSteward(f.store, { launch: async () => { launched = true; } }); assert(launched);
  await fs.writeFile(launchFile, 'first'); const guard = createSyncLaunchGuard(launchFile); assert.equal(await guard(), true);
  await fs.writeFile(launchFile, 'replacement bytes'); assert.equal(await guard(), false);
});

test('repeated collector startup failures retire the current owner after retrying transient process death', async t => {
  const f = await fixture(t); await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => {} });
  let attempts = 0;
  const result = await runSyncSteward(f.store, { observeSource: async () => null,
    attempt: async () => { attempts++; return { status: 'pending', reason: 'SYNC_COLLECTOR_FAILED', parts: 0 }; }, wait: async () => {} });
  assert.deepEqual(result, { status: 'retired', reason: 'SYNC_COLLECTOR_FAILED' }); assert.equal(attempts, 3);
  assert((await readChat(f.store, 'claude', 'synthetic')).value.pending);
});

test('finishing a command boundary requires an unrestricted collection pass before unchanged-source caching', async t => {
  const f = await fixture(t, 'manual');
  await setChatTracking(f.store, { client: 'claude', sessionId: 'synthetic', cwd: f.cwd, sourcePath: f.sourcePath, promptId: 'track', action: 'track' });
  let attempts = 0, sweeps = 0; const controller = new AbortController();
  await runSyncSteward(f.store, { signal: controller.signal, retryDelayMs: 2, maxRetryDelayMs: 5, idleDelayMs: 7,
    observeSource: async () => 'source-already-contains-later-data',
    attempt: async () => {
      attempts++; const saved = await readChat(f.store, 'claude', 'synthetic');
      if (saved.value.pending) await updateChat(f.store, 'project', 'claude', 'synthetic', { expectedHash: saved.hash,
        change: chat => advanceChat(chat, { generation: chat.generation, checkpoint: chat.checkpoint, requestId: chat.pending.id, complete: true }) });
      return { status: 'caught-up', parts: 0 };
    },
    wait: async () => { if (++sweeps === 3) controller.abort(); } });
  assert.equal(attempts, 2);
});

test('explicit opt-out survives auto ingress without writes and only its final existing catch-up may schedule', async t => {
  const f = await fixture(t); await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => {} });
  const invocation = { client: 'claude', sessionId: 'synthetic', cwd: f.cwd, sourcePath: f.sourcePath, promptId: 'untrack', action: 'untrack' };
  let stopped = await setChatTracking(f.store, invocation), launched = 0;
  await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => { launched++; } });
  assert.equal((await readChat(f.store, 'claude', 'synthetic')).hash, stopped.hash); assert.equal(launched, 0);
  await ingestNativeEvent(f.store, { ...f.event, kind: 'end', startSource: null, newSession: false }, { schedule: async () => { launched++; } });
  assert.equal(launched, 1);
  stopped = await updateChat(f.store, 'project', 'claude', 'synthetic', { expectedHash: stopped.hash, change: chat => advanceChat(chat,
    { generation: chat.generation, checkpoint: chat.checkpoint, requestId: chat.pending.id, complete: true }) });
  const before = await inventory(f.store.root);
  assert.deepEqual(await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => assert.fail('Opted-out chat relaunched') }), { status: 'untracked' });
  assert.deepEqual(await inventory(f.store.root), before); assert.equal((await readChat(f.store, 'claude', 'synthetic')).hash, stopped.hash);
});

test('native hook metadata rejects spoofed lifecycle fields and conversation content before writes', async t => {
  const f = await fixture(t), before = await inventory(f.store.root);
  for (const event of [{ ...f.event, transcript: 'private content' }, { ...f.event, startSource: 'resume', newSession: true },
    { ...f.event, kind: 'completed' }, { ...f.event, launchMarker: 'guess' }, { ...f.event, history: { mode: 'manual', startSource: 'startup', inheritedBoundary: null } }]) {
    await assert.rejects(ingestNativeEvent(f.store, event));
  }
  assert.equal(validateNativeEvent(f.event).source.path, f.sourcePath); assert.deepEqual(await inventory(f.store.root), before);
});

test('independent detached steward retries collector death and late native persistence while idle, then exits after untrack settles', async t => {
  const f = await fixture(t), user = (id, content) => ({ type: 'user', sessionId: 'synthetic', uuid: id, promptId: id, turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content } });
  const assistant = (id, text, final = true) => ({ type: 'assistant', sessionId: 'synthetic', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: final ? 'end_turn' : null } });
  const line = row => JSON.stringify(row) + '\n';
  await fs.writeFile(f.sourcePath, line(user('one-human', 'A single synthetic prompt'))); await fs.writeFile(path.join(f.root, 'crash-next-collector'), '');
  let launched, exited;
  const launch = async ({ storeRoot }) => launchDetachedSyncSteward({ entry, storeRoot }, { spawn: (...args) => {
    launched = spawn(...args); exited = new Promise(resolve => launched.once('close', resolve)); return launched;
  } });
  t.after(async () => { if (launched?.exitCode === null) launched.kill('SIGTERM'); await exited; });
  const { enrollmentNonce, ...enrolled } = await ingestNativeEvent(f.store, prompt(f.event), { schedule: () => ensureSyncSteward(f.store, { launch }) });
  assert.deepEqual(enrolled, { status: 'enrolled', scheduled: true });
  await fs.appendFile(f.sourcePath, line({ type: 'attachment', sessionId: 'synthetic', uuid: 'enrollment-proof', parentUuid: 'one-human',
    attachment: { type: 'hook_additional_context', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', content: [buildClaudePromptContext(enrollmentNonce)] } }));
  await waitFor(() => marker(path.join(f.root, 'collector-crashed.json')));
  assert.deepEqual(await ensureSyncSteward(f.store, { launch: () => assert.fail('Started a duplicate live steward') }), { status: 'running' });
  assert.deepEqual(await selectChatQueue(f.store, 'project', 'claude', 'synthetic'), []);
  await fs.appendFile(f.sourcePath, line(assistant('final', 'Final persisted later')));
  // Queue inspection performs fresh native ACL checks. Poll fixture metadata
  // until collection commits, then assert the queue at the observed boundary.
  await waitFor(async () => (await marker(path.join(f.root, 'collector-completed.json')))?.nextPart === 1);
  assert.equal((await selectChatQueue(f.store, 'project', 'claude', 'synthetic')).length, 1);
  await fs.appendFile(f.sourcePath, line(assistant('late', 'Additional late useful text', false)));
  await waitFor(async () => (await marker(path.join(f.root, 'collector-completed.json')))?.nextPart === 2);
  const records = await selectChatQueue(f.store, 'project', 'claude', 'synthetic');
  assert.equal(records.length, 2);
  assert.equal(records[1].data.supplement, true); assert.equal(records[1].data.partIndex, 1);
  await fs.appendFile(f.sourcePath, line(user('untrack', 'Stop here')));
  await setChatTracking(f.store, { client: 'claude', sessionId: 'synthetic', sourcePath: f.sourcePath, cwd: f.cwd, promptId: 'untrack', action: 'untrack' });
  await waitFor(() => launched.exitCode !== null);
  assert.equal(await exited, 0);
  assert.deepEqual(await marker(path.join(f.root, 'steward-finished.json')), { status: 'settled' });
  const saved = await readChat(f.store, 'claude', 'synthetic'); assert.equal(saved.value.tracked, false); assert.equal(saved.value.optOut, true); assert.equal(saved.value.pending, null);
  assert.equal((await selectChatQueue(f.store, 'project', 'claude', 'synthetic')).length, 2);
});


test('first-prompt authority retries transient gate contention without writing ineligible enrollment metadata', async t => {
  for (const tracking of ['auto', 'manual']) {
    const f = await fixture(t, tracking), before = await inventory(f.store.root);
    const owned = tryAcquireExistingGate(f.store.settingsGate, gateOptions).acquired;
    assert.ok(owned); let released = false, scheduled = 0;
    const timer = setTimeout(() => { released = true; owned.release(); }, 1250);
    try {
      const result = await ingestNativeEvent(f.store, prompt(f.event), { schedule: async () => { scheduled++; } });
      assert.equal(released, true); // exceeds the ordinary one-second gate wait
      if (tracking === 'auto') {
        assert.deepEqual(result, { status: 'enrolled', scheduled: true, enrollmentNonce: (await readChat(f.store, 'claude', 'synthetic')).value.history.startPromptNonce });
        const chat = (await readChat(f.store, 'claude', 'synthetic')).value;
        assert.equal(chat.tracked, true); assert.equal(chat.history.startSource, 'prompt'); assert.ok(chat.pending);
        assert.equal(scheduled, 1);
      } else {
        assert.deepEqual(result, { status: 'ineligible' }); assert.equal(scheduled, 0);
        assert.equal(await readChat(f.store, 'claude', 'synthetic'), null);
        assert.deepEqual(await inventory(f.store.root), before);
      }
    } finally { clearTimeout(timer); if (!released) owned.release(); }
  }
});


test('durable hook metadata still schedules reconciliation when gate release fails', async t => {
  const f = await fixture(t), execute = Database.prototype.exec;
  let failed = false, scheduled = null;
  t.mock.method(Database.prototype, 'exec', function(sql, ...rest) {
    const result = execute.call(this, sql, ...rest);
    if (!failed && sql === 'ROLLBACK') { failed = true; throw new Error('Synthetic release failure after durable ingress.'); }
    return result;
  });
  const result = await ingestNativeEvent(f.store, prompt(f.event), { schedule: async request => { scheduled = request; } });
  assert.deepEqual(result, { status: 'pending', reason: 'GATE_RELEASE_FAILED', scheduled: true, enrollmentNonce: (await readChat(f.store, 'claude', 'synthetic')).value.history.startPromptNonce });
  assert.ok(scheduled);
  assert.equal((await readChat(f.store, f.event.client, f.event.sessionId)).value.pending.id, scheduled.requestId);
});
