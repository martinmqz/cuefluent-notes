import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitForReplacement } from '../fixtures/publication-boundary.mjs';
import { createProject } from '../../src/core/settings.mjs';
import { createRun, validateRun, replaceAttempt, failLogEvent, confirmLogEvent, setLogPublication } from '../../src/core/run.mjs';
import { initializeStore, withProject, withWriter } from '../../src/storage/store.mjs';
import { readJSON, writeJSON, hashBytes } from '../../src/storage/files.mjs';
import { ownAttempt, withCurrentAttempt, attachAttemptChild, launchOwnedAttempt, inspectAttempt } from '../../src/storage/attempts.mjs';
import { pinDirectory, inspectParent } from '../../src/storage/paths.mjs';
import { prepareNotePublication, publishNotePublication } from '../../src/storage/note-writer.mjs';
import { establishActivityLogSeries, logCandidate, readActivityLog } from '../../src/logs/storage.mjs';
import { pinProcessingLogging, flushRunLogs, discardRunLogPublication } from '../../src/processing/logging.mjs';

const version = { skillVersion: '2.0.0' }, savedAt = '2026-10-22T01:00:00.000Z';
async function fixture(t, { saved = true, pinned = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-log-process-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  const pin = await pinDirectory(notes), binding = await establishActivityLogSeries(pin, { ...version, year: 2026, timezone: 'America/Los_Angeles', seriesId: 'synthetic-series', noteId: randomUUID(), runId: randomUUID(), createdAt: savedAt, persistIntent: async () => {} });
  const project = createProject({ id: 'synthetic', root: cwd, saving: 'auto', destination: { kind: 'directory', path: notes }, activityLog: { enabled: true, timezone: 'UTC' } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const bytes = Buffer.from('# Synthetic topic\n\n## Choice\nKeep this saved choice.\n'), target = path.join(notes, 'topic.md'); await fs.writeFile(target, bytes);
  const draft = { id: randomUUID(), target, expectedHash: null, hash: hashBytes(bytes), summary: 'Keep the selected choice.', heading: 'Choice', byteLength: bytes.length, binding: { root: notes, parent: (await inspectParent(pin, 'topic.md')).chain } };
  const event = { draftId: draft.id, id: randomUUID(), savedAt, confirmed: false, failure: null };
  let run = createRun(project, [{ client: 'claude', sessionId: 'synthetic-chat', recordId: 'synthetic-record', hash: 'a'.repeat(64) }]);
  if (saved) run = validateRun({ ...run, phase: 'cleanup', drafts: [draft], saved: [{ draftId: draft.id, target, hash: draft.hash, changed: true }], logEvents: [event] });
  if (pinned) run = validateRun({ ...run, logging: binding });
  await withProject(store, project.id, context => writeJSON(store.pin, `${context.directory}/run.json`, run, { expectedHash: null }));
  const read = () => withProject(store, project.id, async context => (await readJSON(store.pin, `${context.directory}/run.json`)).value);
  const own = async work => {
    const channel = new EventEmitter(), attemptId = randomUUID(); channel.connected = true;
    channel.disconnect = () => { channel.connected = false; };
    channel.send = (message, callback) => {
      callback?.();
      if (message.type === 'cuefluent-attempt-ready') void withProject(store, project.id, async context => {
        const current = await readJSON(store.pin, `${context.directory}/run.json`);
        await writeJSON(store.pin, `${context.directory}/run.json`, replaceAttempt(current.value, attemptId), { expectedHash: current.hash });
      }).then(() => channel.emit('message', { type: 'cuefluent-attempt-activate', attemptId }));
    };
    return ownAttempt(store, project.id, { runId: run.id, attemptId, channel }, work);
  };
  const mutate = async (owner, transform) => withCurrentAttempt(owner, async context => writeJSON(store.pin, `${context.directory}/run.json`, transform(context.run), { expectedHash: context.hash }));
  return { root, notes, pin, project, store, run, draft, event, binding, read, own, mutate, annual: path.join(notes, 'logs', '2026.md'), target };
}

test('series is pinned before drafting from existing metadata, not changed settings timezone', async t => {
  const f = await fixture(t, { saved: false, pinned: false });
  await f.own(async owner => { assert.deepEqual(await pinProcessingLogging(f.store, owner), f.binding); });
  assert.equal((await f.read()).logging.timezone, 'America/Los_Angeles');
});

test('successful log flush preserves saved note, confirms once, and byte-exact retry is inert', async t => {
  const f = await fixture(t), note = await fs.readFile(f.target);
  await f.own(async owner => {
    const result = await flushRunLogs(f.store, owner, version);
    assert.equal(result.logEvents[0].confirmed, true); assert.equal(result.logPublication, null);
    const before = await fs.readFile(f.annual), stat = await fs.stat(f.annual);
    await flushRunLogs(f.store, owner, version);
    assert.deepEqual(await fs.readFile(f.annual), before); assert.equal((await fs.stat(f.annual)).mtimeMs, stat.mtimeMs);
  });
  assert.deepEqual(await fs.readFile(f.target), note);
  const result = await readActivityLog(f.project.destination, { year: 2026 });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].eventId, f.event.id);
  assert.equal(result.entries[0].savedAt, '2026-10-21T18:00:00-07:00');
  assert.deepEqual(await fs.readdir(path.dirname(f.annual)), ['2026.md']);
});

test('accepted padded review text and unrelated log siblings do not prevent a saved event from being confirmed', async t => {
  const f = await fixture(t), summary = '  Reviewed summary.  ', heading = ' Choice ';
  await fs.writeFile(path.join(path.dirname(f.annual), '.DS_Store'), 'Unrelated Finder bytes.');
  await f.own(async owner => {
    await f.mutate(owner, run => validateRun({ ...run, drafts: run.drafts.map(draft => ({ ...draft, summary, heading })) }));
    const result = await flushRunLogs(f.store, owner, version);
    assert.equal(result.logEvents[0].confirmed, true); assert.equal(result.logEvents[0].failure, null);
  });
  const result = await readActivityLog(f.project.destination, { year: 2026 });
  assert.equal(result.entries[0].summary, summary); assert.equal(result.entries[0].heading, heading);
  assert.equal(await fs.readFile(path.join(path.dirname(f.annual), '.DS_Store'), 'utf8'), 'Unrelated Finder bytes.');
});

test('invalid logs are best effort and known failed events stay final after manual repair', async t => {
  const f = await fixture(t), original = await fs.readFile(f.annual), note = await fs.readFile(f.target), invalid = Buffer.from('Manual replacement of annual log.\n');
  await fs.writeFile(f.annual, invalid);
  await f.own(async owner => {
    const result = await flushRunLogs(f.store, owner, version);
    assert.equal(result.phase, 'cleanup'); assert.equal(result.saved.length, 1); assert.equal(result.logEvents[0].confirmed, false);
    assert.ok(result.logEvents[0].failure); assert.match(result.warnings.join('\n'), /not confirmed/);
    assert.deepEqual(await fs.readFile(f.annual), invalid);
    await fs.writeFile(f.annual, original); await flushRunLogs(f.store, owner, version);
    assert.deepEqual(await fs.readFile(f.annual), original);
    await discardRunLogPublication(f.store, owner);
  });
  assert.deepEqual(await fs.readFile(f.target), note);
  assert.ok((await f.read()).logEvents[0].failure);
});

test('missing pinned series reports unavailable, then releases without a cross-run log backlog', async t => {
  const f = await fixture(t, { pinned: false });
  await f.own(async owner => {
    const result = await flushRunLogs(f.store, owner, version);
    assert.equal(result.logEvents[0].failure, 'LOG_SERIES_UNAVAILABLE');
    await discardRunLogPublication(f.store, owner);
    await assert.rejects(Promise.resolve().then(() => confirmLogEvent(result, owner.attemptId, f.event.id)), { code: 'RUN_LOG_EVENT_MISSING' });
  });
});

test('an exact interrupted log candidate cannot rebase over a public manual edit and its stage is discarded', async t => {
  const f = await fixture(t), original = await fs.readFile(f.annual);
  await f.own(async owner => {
    const candidate = logCandidate(f.binding, { eventId: f.event.id, projectId: f.project.id, savedAt, action: 'created', target: 'topic.md', heading: f.draft.heading, summary: f.draft.summary }, original, version);
    let note = await prepareNotePublication(f.pin, candidate.relative, candidate.bytes, { runId: f.run.id, draftId: f.event.id, expectedHash: hashBytes(original), hash: hashBytes(candidate.bytes) });
    await f.mutate(owner, run => setLogPublication(run, owner.attemptId, f.event.id, note));
    await withWriter(f.store, async () => {
      await assert.rejects(publishNotePublication(f.pin, note, candidate.bytes, { persistIntent: async next => {
        note = next;
        // This callback owns only the writer gate; persist through the already
        // current fixture transform outside it to preserve production lock order.
        throw Object.assign(new Error(), { code: 'SYNTHETIC_STOP' });
      } }), { code: 'SYNTHETIC_STOP' });
    });
    await f.mutate(owner, run => setLogPublication(run, owner.attemptId, f.event.id, note));
    const manual = Buffer.concat([original, Buffer.from('\nA human changed the annual log.\n')]); await fs.writeFile(f.annual, manual);
    const result = await flushRunLogs(f.store, owner, version);
    assert.ok(result.logEvents[0].failure); assert.equal(result.logPublication, null);
    assert.deepEqual(await fs.readFile(f.annual), manual);
    assert.deepEqual(await fs.readdir(path.dirname(f.annual)), ['2026.md']);
  });
});

test('a complete hand-edited event is acknowledged after publication but before the durable log receipt', async t => {
  const f = await fixture(t), original = await fs.readFile(f.annual);
  await f.own(async owner => {
    await withCurrentAttempt(owner, context => withWriter(f.store, async () => {
      let run = context.run, hash = context.hash;
      const persist = async next => { hash = (await writeJSON(f.store.pin, `${context.directory}/run.json`, next, { expectedHash: hash })).hash; run = next; };
      const candidate = logCandidate(f.binding, { eventId: f.event.id, projectId: f.project.id, savedAt, action: 'created', target: 'topic.md', heading: f.draft.heading, summary: f.draft.summary }, original, version);
      const note = await prepareNotePublication(f.pin, candidate.relative, candidate.bytes, { runId: f.run.id, draftId: f.event.id, expectedHash: hashBytes(original), hash: hashBytes(candidate.bytes) });
      await persist(setLogPublication(run, owner.attemptId, f.event.id, note));
      await publishNotePublication(f.pin, note, candidate.bytes, { persistIntent: next => persist(setLogPublication(run, owner.attemptId, f.event.id, next)) });
    }));
    const manual = (await fs.readFile(f.annual, 'utf8')).replace('Keep the selected choice\\.', "A person's edited summary, preserved.").replace('](../topic.md)', '](../renamed.md)');
    await fs.writeFile(f.annual, manual);
    const result = await flushRunLogs(f.store, owner, version);
    assert.equal(result.logEvents[0].confirmed, true); assert.equal(result.logEvents[0].failure, null); assert.equal(result.logPublication, null);
    assert.equal(await fs.readFile(f.annual, 'utf8'), manual);
    const entries = (await readActivityLog(f.project.destination, { year: 2026 })).entries;
    assert.equal(entries.length, 1); assert.equal(entries[0].summary, "A person's edited summary, preserved.");
    assert.equal(entries[0].target, 'renamed.md');
  });
});

test('release of pending events records explicit dispositions even when warnings already reached their cap', async t => {
  const f = await fixture(t);
  await f.own(async owner => {
    await f.mutate(owner, run => validateRun({ ...run, warnings: Array.from({ length: 128 }, (_, index) => `Previous synthetic warning ${index}.`) }));
    const result = await discardRunLogPublication(f.store, owner);
    assert.equal(result.logEvents[0].failure, 'LOG_RUN_RELEASED'); assert.equal(result.warnings.length, 128);
    assert.match(result.warnings.at(-1), /1 saved note change was not confirmed/);
    const failed = failLogEvent(result, owner.attemptId, f.event.id, 'LOG_TEST_FAILURE');
    assert.throws(() => validateRun({ ...failed, logEvents: [{ ...failed.logEvents[0], confirmed: true }] }), { code: 'RUN_INVALID' });
  });
});

test('a durably journaled stage before content write is reconstructed exactly, or explicitly abandoned without rebase', async t => {
  for (const abandon of [false, true]) {
    const f = await fixture(t), original = await fs.readFile(f.annual);
    await f.own(async owner => {
      await withCurrentAttempt(owner, context => withWriter(f.store, async () => {
        let run = context.run, hash = context.hash;
        const persist = async next => { hash = (await writeJSON(f.store.pin, `${context.directory}/run.json`, next, { expectedHash: hash })).hash; run = next; };
        const candidate = logCandidate(f.binding, { eventId: f.event.id, projectId: f.project.id, savedAt, action: 'created', target: 'topic.md', heading: f.draft.heading, summary: f.draft.summary }, original, version);
        const note = await prepareNotePublication(f.pin, candidate.relative, candidate.bytes, { runId: f.run.id, draftId: f.event.id, expectedHash: hashBytes(original), hash: hashBytes(candidate.bytes) });
        await persist(setLogPublication(run, owner.attemptId, f.event.id, note));
        await assert.rejects(publishNotePublication(f.pin, note, candidate.bytes, { persistIntent: async next => {
          await persist(setLogPublication(run, owner.attemptId, f.event.id, next)); throw Object.assign(new Error(), { code: 'SYNTHETIC_STOP' });
        } }), { code: 'SYNTHETIC_STOP' });
      }));
      assert.deepEqual(await fs.readFile(f.annual), original);
      if (abandon) {
        const manual = Buffer.concat([original, Buffer.from('\nManual log addition.\n')]); await fs.writeFile(f.annual, manual);
        const released = await discardRunLogPublication(f.store, owner);
        assert.equal(released.logPublication, null); assert.equal(released.logEvents[0].failure, 'LOG_RUN_RELEASED');
        assert.deepEqual(await fs.readFile(f.annual), manual);
      } else {
        const result = await flushRunLogs(f.store, owner, version);
        assert.equal(result.logEvents[0].confirmed, true); assert.equal(result.logEvents[0].failure, null);
        assert.equal((await readActivityLog(f.project.destination, { year: 2026 })).entries[0].eventId, f.event.id);
      }
      assert.deepEqual(await fs.readdir(path.dirname(f.annual)), ['2026.md']);
    });
  }
});

test('SIGKILL after public log replacement recovers the same frozen event without a duplicate', async t => {
  const f = await fixture(t), children = [];
  const launch = async stopAfterReplace => {
    await launchOwnedAttempt(f.store, f.project.id, { runId: f.run.id, launch: context => {
      const child = fork(fileURLToPath(new URL('./log-worker.mjs', import.meta.url)), [f.root, JSON.stringify({ ...context, stopAfterReplace })], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc', 'pipe'] });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
      const boundary = stopAfterReplace ? waitForReplacement(child, f.annual, exited) : null;
      children.push({ child, exited, boundary }); t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
      return attachAttemptChild(child, context);
    } });
    return children.at(-1);
  };
  const first = await launch(true);
  await first.boundary;
  first.child.kill('SIGKILL'); await first.exited;
  const stopped = await inspectAttempt(f.store, f.project.id);
  assert.equal(stopped.active, false); assert.ok(stopped.run.logPublication.note.stage); assert.equal(stopped.run.logEvents[0].confirmed, false);
  const exact = await fs.readFile(f.annual), second = await launch(false), exit = await second.exited;
  assert.equal(exit.code, 0, exit.stderr);
  const recovered = await f.read(); assert.equal(recovered.logPublication, null); assert.equal(recovered.logEvents[0].confirmed, true);
  assert.equal(recovered.logEvents[0].id, f.event.id); assert.equal(recovered.logEvents[0].savedAt, savedAt);
  assert.deepEqual(await fs.readFile(f.annual), exact);
  assert.equal((await readActivityLog(f.project.destination, { year: 2026 })).entries.length, 1);
});

test('temporary writer contention before drafting retries outside short gates and still pins logging', async t => {
  const f = await fixture(t, { saved: false, pinned: false });
  await f.own(async owner => {
    let entered, release;
    const locked = new Promise(resolve => { entered = resolve; });
    const held = withWriter(f.store, async () => { entered(); await new Promise(resolve => { release = resolve; }); });
    await locked;
    const pinning = pinProcessingLogging(f.store, owner);
    try {
      // More than the former one-second gate deadline, less than the bounded retry.
      await new Promise(resolve => setTimeout(resolve, 1200));
      await withProject(f.store, f.project.id, async () => {});
    } finally { release(); await held; }
    assert.deepEqual(await pinning, f.binding);
  });
  assert.equal((await f.read()).warnings.length, 0);
});
