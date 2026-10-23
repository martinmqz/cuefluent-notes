import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/core/settings.mjs';
import { createRun, validateRun, replaceAttempt, assertAttempt, releaseAttempt, publishDrafts, readyForReview, beginSaving,
  markNoteSaved, completeSaving, skipDisposition, RUN_LIMITS, cleanupContext, advanceCleanup, clearCleanupAcknowledgment,
  setNotePublication, setLogPublication } from '../src/core/run.mjs';

const options = { platform: 'posix' };
const ids = ['10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000005'];
const h = character => character.repeat(64);
const project = changes => createProject({ id: 'work', root: '/projects/work', destination: { kind: 'directory', path: '/notes' }, ...changes }, options);
const selected = () => [{ client: 'codex', sessionId: 'native-session', recordId: 'exchange:part-1', hash: h('a') },
  { client: 'claude', sessionId: 'second-session', recordId: 'record-2', hash: h('b') }];
const fresh = changes => createRun(project(changes), selected(), { ...options, id: ids[0] });
const active = changes => replaceAttempt(fresh(changes), ids[1], options);
const draft = changes => ({ id: ids[3], target: '/notes/design.md', expectedHash: h('c'), hash: h('d'), summary: null, heading: null, byteLength: 100,
  binding: { root: '/notes', parent: [{ path: '/', device: '1', inode: '1' }, { path: '/notes', device: '1', inode: '2' }] }, ...changes });
const error = (action, code = 'RUN_INVALID') => assert.throws(action, { code });

test('note and log publication identities can be recorded once but never replaced or cleared', () => {
  const original = { device: '1', inode: '3', metadata: h('a') }, stage = { device: '1', inode: '4' }, capture = { device: '1', inode: '5' };
  const descriptor = draft({ summary: 'Updated note' });
  const logsParent = [...descriptor.binding.parent, { path: '/notes/logs', device: '1', inode: '6' }];
  const settings = { saving: 'auto', activityLog: { enabled: true, timezone: 'UTC' } };
  const base = publishDrafts(active(settings), ids[1], [descriptor], options);
  const event = { id: ids[4], savedAt: '2026-10-22T01:00:00.000Z' };
  const note = { schema: 1, runId: base.id, draftId: descriptor.id, root: '/notes', relative: 'design.md',
    parent: descriptor.binding.parent, expectedHash: descriptor.expectedHash, hash: descriptor.hash, bytes: descriptor.byteLength,
    original, stage: null, capture: null };
  const logRun = validateRun({ ...markNoteSaved(base, ids[1], descriptor.id, { ...options, event }),
    logging: { root: '/notes', parent: logsParent, seriesId: 'synthetic', timezone: 'UTC' } }, options);
  for (const kind of ['note', 'log']) {
    const value = kind === 'note' ? note : { ...note, draftId: event.id, relative: 'logs/2026.md', parent: logsParent };
    const set = (run, next) => kind === 'note' ? setNotePublication(run, ids[1], next, { ...options, event }) : setLogPublication(run, ids[1], event.id, next, options);
    let run = set(kind === 'note' ? base : logRun, value);
    run = set(run, { ...value, stage });
    run = set(run, { ...value, stage, capture });
    for (const change of [{ stage: null }, { stage: { device: '1', inode: '9' } }, { capture: null },
      { capture: { device: '1', inode: '9' } }, { expectedHash: h('f') }]) {
      error(() => set(run, { ...value, stage, capture, ...change }), 'RUN_PUBLICATION_CHANGED');
    }
  }
});

test('create a metadata-only frozen run with independently pinned project settings and selected hashes', () => {
  const inputProject = structuredClone(project()), selection = selected();
  const run = createRun(inputProject, selection, { ...options, id: ids[0] });
  inputProject.saving = 'auto'; inputProject.destination.path = '/redirected'; selection[0].hash = h('f');
  assert.equal(run.phase, 'drafting'); assert.equal(run.attempt, null);
  assert.equal(run.settings.saving, 'review'); assert.equal(run.settings.destination.path, '/notes');
  assert.equal(run.selection[0].hash, h('a'));
  for (const value of [run, run.settings, run.settings.destination, run.selection, run.selection[0], run.drafts, run.saved, run.warnings]) assert(Object.isFrozen(value));
  assert.equal(JSON.stringify(run).includes('content'), false);
  assert.notEqual(createRun(project(), selected(), options).id, createRun(project(), selected(), options).id);
});

test('retry fences stale workers without changing run identity, selection or pinned settings', () => {
  const first = active(), retry = replaceAttempt(first, ids[2], options);
  assert.equal(retry.id, first.id); assert.deepEqual(retry.selection, first.selection); assert.deepEqual(retry.settings, first.settings);
  error(() => assertAttempt(retry, ids[1], options), 'RUN_ATTEMPT_STALE');
  error(() => publishDrafts(retry, ids[1], [draft()], options), 'RUN_ATTEMPT_STALE');
  error(() => replaceAttempt(first, ids[1], options), 'RUN_ATTEMPT_REUSED');
  assert.equal(assertAttempt(retry, ids[2], options).attempt.id, ids[2]);
});

test('an inactive failed attempt keeps frozen input available for retry and skip', () => {
  const failed = releaseAttempt(active(), ids[1], options);
  assert.equal(failed.phase, 'drafting'); assert.equal(failed.attempt, null); assert.deepEqual(failed.selection, selected());
  assert.equal(skipDisposition(failed, options).kind, 'preserve-input');
  assert.deepEqual(replaceAttempt(failed, ids[2], options).selection, selected());
  error(() => skipDisposition(active(), options), 'RUN_ACTIVE_ATTEMPT');
});

test('complete review drafts wait for explicit saving and retries reuse exact descriptors', () => {
  const published = publishDrafts(active(), ids[1], [draft()], options);
  assert.equal(published.phase, 'review'); assert.equal(published.attempt.id, ids[1]);
  error(() => markNoteSaved(published, ids[1], ids[3], options), 'RUN_PHASE_INVALID');
  const waiting = readyForReview(published, ids[1], options);
  assert.equal(waiting.attempt, null); assert.equal(skipDisposition(waiting, options).kind, 'preserve-input');
  const saving = beginSaving(replaceAttempt(waiting, ids[2], options), ids[2], options);
  assert.equal(saving.phase, 'saving'); assert.deepEqual(saving.drafts, published.drafts);
  error(() => publishDrafts(saving, ids[2], [draft({ expectedHash: h('e') })], options), 'RUN_PHASE_INVALID');
  const retried = replaceAttempt(saving, ids[4], options);
  assert.deepEqual(retried.selection, selected()); assert.equal(retried.drafts[0].expectedHash, h('c'));
});

test('auto-saving persists complete drafts before any write and retries never regenerate them', () => {
  const run = publishDrafts(active({ saving: 'auto' }), ids[1], [draft()], options);
  assert.equal(run.phase, 'saving'); assert.equal(run.saved.length, 0);
  const retried = replaceAttempt(run, ids[2], options);
  assert.deepEqual(retried.drafts, run.drafts); assert.deepEqual(retried.settings, run.settings);
  error(() => publishDrafts(retried, ids[2], [draft()], options), 'RUN_PHASE_INVALID');
  error(() => readyForReview(retried, ids[2], options), 'RUN_PHASE_INVALID');
});

test('save receipts are idempotent, attempt-fenced, and complete only after every exact draft', () => {
  let run = publishDrafts(active({ saving: 'auto' }), ids[1], [draft(), draft({ id: ids[4], target: '/notes/second.md', expectedHash: null })], options);
  error(() => completeSaving(run, ids[1], options), 'RUN_SAVE_INCOMPLETE');
  run = markNoteSaved(run, ids[1], ids[3], options);
  assert.deepEqual(markNoteSaved(run, ids[1], ids[3], options).saved, run.saved);
  assert.deepEqual(run.saved, [{ draftId: ids[3], target: '/notes/design.md', hash: h('d'), changed: true }]);
  error(() => markNoteSaved(run, ids[2], ids[4], options), 'RUN_ATTEMPT_STALE');
  error(() => markNoteSaved(run, ids[1], ids[0], options), 'RUN_DRAFT_MISSING');
  error(() => completeSaving(run, ids[1], options), 'RUN_SAVE_INCOMPLETE');
  run = markNoteSaved(run, ids[1], ids[4], options);
  const complete = completeSaving(run, ids[1], options);
  assert.equal(complete.phase, 'cleanup'); assert.equal(complete.saved.length, 2);
});

test('partial-save skip preserves all selected source and applied notes, completed cleanup does not replay input', () => {
  const published = publishDrafts(active({ saving: 'auto' }), ids[1], [draft(), draft({ id: ids[4], target: '/notes/second.md' })], options);
  const partial = markNoteSaved(published, ids[1], ids[3], options);
  const skip = skipDisposition(releaseAttempt(partial, ids[1], options), options);
  assert.equal(skip.kind, 'preserve-input'); assert.deepEqual(skip.selection, selected()); assert.deepEqual(skip.saved, partial.saved);
  const saved = markNoteSaved(partial, ids[1], ids[4], options), done = completeSaving(saved, ids[1], options);
  assert.equal(skipDisposition(releaseAttempt(done, ids[1], options), options).kind, 'finish-cleanup');
  assert.equal(skipDisposition(releaseAttempt(saved, ids[1], options), options).kind, 'finish-cleanup');
});

test('only explicit successful nothing-useful publication consumes selected input without notes', () => {
  for (const saving of ['review', 'auto']) {
    const run = publishDrafts(active({ saving }), ids[1], [], options);
    assert.equal(run.phase, 'cleanup'); assert.deepEqual(run.drafts, []); assert.deepEqual(run.saved, []);
    assert.equal(skipDisposition(releaseAttempt(run, ids[1], options), options).kind, 'finish-cleanup');
    assert.deepEqual(run.selection, selected());
  }
  error(() => publishDrafts(active(), ids[1], null, options));
  assert.equal(releaseAttempt(active(), ids[1], options).phase, 'drafting');
});

test('bounded cleanup progress pins the exact record and acknowledgment until its journal is released', () => {
  const done = publishDrafts(active(), ids[1], [], options);
  const cursor = { schema: 1, queueId: ids[3], transactionId: ids[4], context: cleanupContext(done.id),
    index: 0, id: done.selection[0].recordId, hash: done.selection[0].hash };
  const next = advanceCleanup(done, ids[1], cursor, options);
  assert.equal(next.cleanup.next, 1); assert.deepEqual(next.cleanup.ack, cursor);
  error(() => advanceCleanup(next, ids[1], { ...cursor, index: 1 }, options), 'RUN_CLEANUP_INVALID');
  error(() => advanceCleanup(done, ids[1], { ...cursor, hash: h('f') }, options));
  error(() => clearCleanupAcknowledgment(next, ids[1], { ...cursor, transactionId: ids[2] }, options), 'RUN_CLEANUP_INVALID');
  const acknowledged = clearCleanupAcknowledgment(next, ids[1], cursor, options);
  assert.equal(acknowledged.cleanup.next, 1); assert.equal(acknowledged.cleanup.ack, null);
  assert.deepEqual(acknowledged.selection, done.selection);
});

test('loaded metadata refuses future schemas, unsupported fields, missing identities and corrupt selections', () => {
  error(() => validateRun({ ...fresh(), schemaVersion: 2 }, options), 'RUN_SCHEMA_UNSUPPORTED');
  error(() => validateRun({ ...fresh(), transcript: 'forbidden data' }, options));
  error(() => validateRun({ ...fresh(), projectId: 'other' }, options));
  error(() => validateRun({ ...fresh(), id: 'not-a-uuid' }, options));
  error(() => createRun(project(), [], options));
  for (const changes of [{ client: 'unknown' }, { sessionId: '../unsafe' }, { recordId: 'has space' }, { hash: 'bad' }, { content: 'conversation' }]) {
    error(() => createRun(project(), [{ ...selected()[0], ...changes }], options));
  }
  error(() => createRun(project(), [selected()[0], { ...selected()[0], hash: h('f') }], options));
  error(() => createRun(project(), new Array(RUN_LIMITS.selection + 1), options));
  error(() => validateRun({ ...fresh(), attempt: { id: ids[0] } }, options));
});

test('loaded metadata validates phase invariants and exact saved-descriptor correspondence', () => {
  const saved = publishDrafts(active({ saving: 'auto' }), ids[1], [draft()], options);
  for (const changes of [{ phase: 'finished' }, { phase: 'review' }, { phase: 'drafting' }, { phase: 'cleanup' },
    { saved: [{ draftId: ids[3], target: '/different.md', hash: h('d'), changed: true }] },
    { saved: [{ draftId: ids[3], target: '/notes/design.md', hash: h('e'), changed: true }] }]) {
    error(() => validateRun({ ...saved, ...changes }, options));
  }
  const complete = markNoteSaved(saved, ids[1], ids[3], options);
  error(() => validateRun({ ...complete, saved: [...complete.saved, ...complete.saved] }, options));
  error(() => validateRun({ ...fresh(), phase: 'saving' }, options));
});

test('draft descriptors preserve expected absence and hashes and reserve logs without reading files', () => {
  const published = publishDrafts(active(), ids[1], [draft({ expectedHash: null })], options);
  assert.equal(published.drafts[0].expectedHash, null);
  for (const changes of [{ expectedHash: undefined }, { hash: 'bad' }, { content: 'forbidden embedded draft' },
    { target: '/elsewhere/design.md' }, { target: '/notes/../design.md' }, { target: '/notes/logs/2026.md' }, { target: '/notes/design.txt' }]) {
    assert.throws(() => publishDrafts(active(), ids[1], [draft(changes)], options));
  }
  error(() => publishDrafts(active(), ids[1], [draft(), draft({ id: ids[4] })], options));
  error(() => publishDrafts(active(), ids[1], [draft(), draft({ target: '/notes/another.md' })], options));
});

test('unchanged drafts handle input through receipts without claiming a note write or log event', () => {
  const run = publishDrafts(active({ saving: 'auto' }), ids[1], [draft({ expectedHash: h('d') })], options);
  const unchanged = markNoteSaved(run, ids[1], ids[3], options);
  assert.equal(unchanged.saved[0].changed, false);
  assert.equal(completeSaving(unchanged, ids[1], options).phase, 'cleanup');
  error(() => markNoteSaved(run, ids[1], ids[3], { ...options, changed: true }));
  error(() => markNoteSaved(run, ids[1], ids[3], { ...options, changed: 'false' }));
  error(() => markNoteSaved(run, ids[1], ids[3], { ...options, changed: null }));
  const applied = publishDrafts(active({ saving: 'auto' }), ids[1], [draft()], options);
  assert.equal(markNoteSaved(applied, ids[1], ids[3], { ...options, changed: false }).saved[0].changed, false);
  const optedIn = active({ saving: 'auto', activityLog: { enabled: true, timezone: 'UTC' } });
  assert.equal(publishDrafts(optedIn, ids[1], [draft({ expectedHash: h('d') })], options).drafts[0].summary, null);
});

test('logging summaries are required only for opted-in runs and remain pinned to old preferences', () => {
  const optedIn = active({ activityLog: { enabled: true, timezone: 'UTC' } });
  error(() => publishDrafts(optedIn, ids[1], [draft()], options));
  for (const summary of ['', 'two\nlines', 'x'.repeat(RUN_LIMITS.summaryLength + 1)]) {
    error(() => publishDrafts(optedIn, ids[1], [draft({ summary })], options));
  }
  const run = publishDrafts(optedIn, ids[1], [draft({ summary: 'Clarify retry ownership', heading: 'Retries' })], options);
  assert.equal(run.drafts[0].summary, 'Clarify retry ownership'); assert.equal(run.settings.activityLog.timezone, 'UTC');
  assert(Object.isFrozen(run.drafts[0]));
});

test('file destinations cannot broaden authority to siblings', () => {
  const run = active({ destination: { kind: 'file', path: '/notes/one.md' } });
  assert.equal(publishDrafts(run, ids[1], [draft({ target: '/notes/one.md' })], options).drafts.length, 1);
  error(() => publishDrafts(run, ids[1], [draft({ target: '/notes/two.md' })], options));
});

test('portable draft collisions and reserved Logs variants fail before any save', () => {
  for (const [left, right] of [['Retry.md', 'retry.md'], ['caf\u00e9.md', 'cafe\u0301.md']]) {
    error(() => publishDrafts(active(), ids[1], [draft({ target: `/notes/${left}` }), draft({ id: ids[4], target: `/notes/${right}` })], options));
  }
  error(() => publishDrafts(active(), ids[1], [draft({ target: '/notes/Logs/2026.md' })], options));
  // Conservatively rejecting aliases must not broaden containment on Linux.
  error(() => publishDrafts(active(), ids[1], [draft({ target: '/NOTES/outside.md' })], options));
});

test('Windows destination containment and reserved paths use case-insensitive segment boundaries', () => {
  const win = { platform: 'win32' }, pinned = createProject({ id: 'work', root: 'C:\\Project', destination: { kind: 'directory', path: 'D:\\Notes' } }, win);
  const run = replaceAttempt(createRun(pinned, selected(), { ...win, id: ids[0] }), ids[1], win);
  const binding = { root: 'D:\\Notes', parent: [{ path: 'D:\\', device: '1', inode: '1' }, { path: 'D:\\Notes', device: '1', inode: '2' }] };
  assert.equal(publishDrafts(run, ids[1], [draft({ target: 'd:\\NOTES\\design.md', binding })], win).drafts.length, 1);
  for (const target of ['D:\\Notes-Other\\design.md', 'D:\\Notes\\LOGS\\2026.md', 'E:\\Notes\\design.md', 'D:\\Notes\\NUL.md']) {
    assert.throws(() => publishDrafts(run, ids[1], [draft({ target })], win));
  }
  error(() => publishDrafts(run, ids[1], [draft({ target: 'D:\\Notes\\design.md' }), draft({ id: ids[4], target: 'd:\\notes\\DESIGN.md' })], win));
});

test('run metadata rejects accessor fields without evaluating them', () => {
  let accessed = false;
  const run = { ...fresh(), get drafts() { accessed = true; return []; } };
  error(() => validateRun(run, options)); assert.equal(accessed, false);
  const inputProject = { ...project(), get id() { accessed = true; return 'work'; } };
  assert.throws(() => createRun(inputProject, selected(), options)); assert.equal(accessed, false);
});
