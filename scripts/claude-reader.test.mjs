import test from './test-support/storage-test.mjs';
import { privateIntakeFixture } from './test-support/intake-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readClaudeSelection, claudePublicationPlan, claudeRegistrationHeader } from './claude-reader.mjs';
import { applySelectionControl, newSelectionState, stableSourceIdentity, inspectSourceBoundary } from './capture-selection.mjs';
import { inspectIntakeStore, withIntakeLock, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { controlSelection, publishCapture, commitReaderProgress, readCaptureHead, resolveStoredSelectionAnchor } from './intake-store.mjs';
import { digest } from './workflow-values.mjs';
import { planReaderCheckpoint, hydrateReaderCheckpoint } from './reader-pages.mjs';
import { serializeCapture } from './capture-contract.mjs';

const S = '10000000-0000-4000-8000-000000000001';
const A = '20000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002', C = '20000000-0000-4000-8000-000000000003';
const stamp = '2026-09-24T00:00:00.000Z';
const message = (type, content, extra = {}) => ({ type, uuid: randomUUID(), timestamp: stamp, sessionId: S,
  version: '2.1.280', isSidechain: false, parentUuid: null, message: { role: type, content }, ...extra });
const human = (promptId = A, text = 'Meeting: selected source.', extra = {}) => message('user', text, { promptId, ...extra });
const assistant = (text = 'UNOWNED RESPONSE', extra = {}) => message('assistant', [{ type: 'text', text }], extra);
async function fixture(t, entries, { future = false, prefix = '', link = true, missingLower = false, headerChanges = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-claude-reader-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const source = { client: 'claude', sessionId: S, projectRoot: root, path: path.join(root, 'session.jsonl'), fileIdentity: '' };
  const control = human(C, 'Before selection.');
  const header = { ...message('system', '', { subtype: 'init' }), cwd: root, ...headerChanges };
  let previous = header.uuid;
  const rows = [header, ...(future ? [control] : []), ...entries].map((row, i) => {
    const result = { ...row, ...(row.uuid ? { cwd: root, parentUuid: i && link ? previous : row.parentUuid } : {}) };
    if (row.uuid) previous = row.uuid; return result;
  });
  let bytes = Buffer.from(JSON.stringify(rows[0]) + '\n' + prefix), offset = bytes.length;
  const anchors = [];
  for (const row of rows.slice(1)) {
    const part = Buffer.from(JSON.stringify(row) + '\n');
    anchors.push({ id: row.uuid, startByte: offset, endByte: offset + part.length, hash: digest(part) });
    bytes = Buffer.concat([bytes, part]); offset += part.length;
  }
  await fs.writeFile(source.path, bytes); source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
  const scopeId = randomUUID(), controlAnchor = future ? anchors.shift() : null;
  const request = { id: scopeId, client: 'claude', sessionId: S, expectedRevision: 0,
    ...(future ? { operation: 'start', unitId: C } : { operation: 'capture-current', unitId: A, scope: { unitIds: [A], start: anchors[0], end: null } }) };
  const boundary = future ? { sourceIdentity: source.fileIdentity, eofByte: anchors[0].startByte, startsMidRecord: false, unitId: C, record: missingLower ? null : controlAnchor } : undefined;
  const state = applySelectionControl(newSelectionState(source), request, boundary), actualScope = future ? state.intervals[0].id : scopeId;
  const store = await privateIntakeFixture(t, source);
  // Persist the fixture state through the same selection control used by readers.
  const selection = await withIntakeLock(store, tx => controlSelection(tx, { source, request, boundary, expectedHash: null, authorize: async () => true }));
  const persistedScope = future ? selection.state.intervals[0].id : actualScope;
  return { root, source, state: selection.state, store, selectionHash: selection.hash, rows, bytes, anchors,
    args: { state: selection.state, scopeId: persistedScope, capturedAt: stamp } };
}
async function append(f, rows) {
  let last = f.rows.at(-1)?.uuid;
  const values = rows.map(row => { const value = { ...row, cwd: f.root, parentUuid: row.parentUuid ?? last }; last = row.uuid; return value; });
  await fs.appendFile(f.source.path, values.map(row => JSON.stringify(row) + '\n').join('')); f.rows.push(...values);
}
async function publish(f, result, unitId = A, cursorHash = null, published = new Map()) {
  const candidate = result.candidates.find(c => c.capture.identity.unitId === unitId);
  const plan = claudePublicationPlan(result, unitId, published);
  return withIntakeLock(f.store, tx => publishCapture(tx, { ...candidate, ...plan, selectionHash: f.selectionHash, cursorHash, authorize: async () => true }));
}

test('Claude retains human-supplied processing copies and corrections without trusting markers', async t => {
  const text = JSON.stringify({ format: 'cuefluent-evidence-page', generated: true,
    operationId: A, artifactHash: digest('draft'), text: '# Draft note' }) +
    '\nCorrection: this draft describes a proposed fix, not verified behavior.';
  const f = await fixture(t, [human(A, text), assistant('Generated status echo')]);
  const capture = (await readClaudeSelection(f.args)).candidates[0].capture;
  assert.deepEqual(capture.evidence.map(item => item.text), [text]);
  assert.equal(capture.coverage.partial, true);
  assert.deepEqual(await fs.readFile(f.source.path), f.bytes);
});

test('Claude captures proven human input, never claims a transcript finality fence', async t => {
  const f = await fixture(t, [human(), assistant(), message('system', '', { subtype: 'turn_duration', durationMs: 100 })]);
  const result = await readClaudeSelection(f.args), capture = result.candidates[0].capture;
  assert.deepEqual(capture.evidence.map(e => e.text), ['Meeting: selected source.']);
  assert.equal(capture.terminal, 'unconfirmed'); assert.equal(capture.coverage.partial, true);
  assert.equal(result.diagnostics.unownedRecords, 1);
  assert.doesNotMatch(JSON.stringify(result.checkpoint), /UNOWNED RESPONSE|Meeting:/);
  assert.doesNotMatch(serializeCapture(capture).toString(), /UNOWNED RESPONSE/);
  const saved = await publish(f, result); assert.equal(saved.cursor.offset, f.anchors[0].endByte);
  const next = await readClaudeSelection({ ...f.args, cursor: saved.cursor, checkpoint: saved.checkpoint });
  assert.equal(next.candidates.length, 0);
  const plan = claudePublicationPlan(next);
  const done = await withIntakeLock(f.store, tx => commitReaderProgress(tx, { identity: { client: 'claude', sessionId: S }, scopeId: f.args.scopeId,
    selectionHash: f.selectionHash, cursorHash: saved.cursorHash, ...plan, authorize: async () => true }));
  assert.equal(done.cursor.offset, f.bytes.length); assert.equal(done.checkpoint.records.filter(r => r.kind === 'unowned').length, 1);
});

test('incremental same-prompt evidence creates a preserving revision without rereading the prefix', async t => {
  const f = await fixture(t, [human()]);
  const first = await publish(f, await readClaudeSelection(f.args));
  const head = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A });
  await append(f, [assistant(), human(A, 'Additional supplied source.')]);
  const reads = [], second = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint, heads: new Map([[A, head]]), observeRead: r => reads.push(r) });
  assert.deepEqual(second.candidates[0].capture.evidence.map(e => e.text), ['Meeting: selected source.', 'Additional supplied source.']);
  assert.ok(reads.filter(r => r.purpose === 'range').every(r => r.offset >= first.cursor.offset));
  const saved = await publish(f, second, A, first.cursorHash);
  assert.notEqual(saved.evidenceHash, first.evidenceHash);
  assert.equal((await readCaptureHead(f.store, head.head.identity)).head.generation, 2);
  const oldFile = await intakeSnapshot(f.store, 'raw', `claude/${S}/${A}/${first.evidenceHash.slice(0, 20)}.json`);
  assert.equal(oldFile.hash, first.fileHash);
  const replay = await readClaudeSelection({ ...f.args, cursor: saved.cursor, checkpoint: saved.checkpoint, heads: new Map([[A, await readCaptureHead(f.store, head.head.identity)]]) });
  assert.equal(replay.candidates.length, 0);
});

test('a checkpoint cannot drop prior same-prompt evidence by omitting its active baseline', async t => {
  const f = await fixture(t, [human()]), first = await publish(f, await readClaudeSelection(f.args));
  await append(f, [human(A, 'More.')]);
  const result = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint });
  assert.equal(result.candidates.length, 0); assert.equal(result.pending[0].reason, 'CAPTURE_BASELINE_REQUIRED');
  await assert.rejects(readClaudeSelection({ ...f.args, cursor: first.cursor }), { code: 'READER_CHECKPOINT_REQUIRED' });
});

test('batching, cancellation, tool parent links and next prompts never assign assistant payload to a prompt', async t => {
  const f = await fixture(t, [human(A), human(B), assistant('P1 CLEANUP', { promptId: B }),
    message('user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'TOOL PAYLOAD' }], { promptId: B }),
    message('system', '', { subtype: 'turn_duration', durationMs: 1 })], { future: true });
  const result = await readClaudeSelection(f.args);
  assert.equal(result.candidates.length, 2); assert.equal(result.diagnostics.unownedRecords, 2);
  for (const { capture } of result.candidates) {
    assert.equal(capture.terminal, 'unconfirmed'); assert.doesNotMatch(serializeCapture(capture).toString(), /P1 CLEANUP|TOOL PAYLOAD/);
  }
});

test('native ancestry is required for future boundaries; explicit selection does not guess ownership', async t => {
  const f = await fixture(t, [human(A)], { future: true, link: false });
  const result = await readClaudeSelection(f.args);
  assert.equal(result.candidates.length, 0); assert.equal(result.pending[0].reason, 'anchor-unresolved');
});

test('compaction, injected context, child content, reasoning and inline binary are excluded', async t => {
  const f = await fixture(t, [human(A, [{ type: 'text', text: 'Keep this supplied text.' },
    { type: 'image', source: { type: 'base64', data: 'PRIVATE_BINARY', media_type: 'image/png' } },
    { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }]),
    human(A, 'DERIVED COMPACTION', { isCompactSummary: true }), human(A, 'INJECTED', { isMeta: true }),
    assistant('CHILD', { isSidechain: true }), assistant('THOUGHT', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' }] } })]);
  const result = await readClaudeSelection(f.args), capture = result.candidates[0].capture;
  assert.equal(capture.evidence.length, 2); assert.equal(capture.coverage.omissions[0].reason, 'inline-attachment-not-copied');
  assert.doesNotMatch(serializeCapture(capture).toString() + JSON.stringify(result.checkpoint), /PRIVATE_BINARY|DERIVED COMPACTION|INJECTED|CHILD|SECRET/);
});

test('exact UUID duplicates do not duplicate evidence; changed mirrors block that unit', async t => {
  const one = human(), f = await fixture(t, [one]);
  const raw = JSON.stringify(f.rows[1]) + '\n'; await fs.appendFile(f.source.path, raw);
  assert.equal((await readClaudeSelection(f.args)).candidates[0].capture.evidence.length, 1);
  await fs.appendFile(f.source.path, JSON.stringify({ ...f.rows[1], message: { role: 'user', content: 'CHANGED' } }) + '\n');
  const bad = await readClaudeSelection(f.args);
  assert.equal(bad.candidates.length, 0); assert.equal(bad.blocked.code, 'CONFLICTING_CLAUDE_MIRROR');
});

test('a partial trailing record waits and fixed-source mismatches refuse capture', async t => {
  const f = await fixture(t, [human()]); await fs.appendFile(f.source.path, '{"type":');
  const result = await readClaudeSelection(f.args); assert.equal(result.candidates.length, 1); assert.equal(result.diagnostics.pendingTail, true);
  const unsupported = await fixture(t, [human()]);
  const changed = unsupported.rows.map(row => ({ ...row, sessionId: B }));
  await fs.writeFile(unsupported.source.path, changed.map(row => JSON.stringify(row) + '\n').join(''));
  await assert.rejects(readClaudeSelection(unsupported.args), { code: 'SOURCE_IDENTITY_MISMATCH' });
});

test('compatible Claude formats register and extract across client release and prerelease versions', async t => {
  for (const version of ['2.1.279', '2.1.282', '3.0.0-rc.1+fixture', '999.0.0', 'development-build']) {
    const f = await fixture(t, [human(A, 'Meeting: selected source.', { version }), assistant('UNOWNED RESPONSE', { version })],
      { headerChanges: { version } });
    const { fileIdentity: _identity, ...selected } = f.source;
    const registration = await inspectSourceBoundary(selected, { currentUnitId: A, verifyHeader: claudeRegistrationHeader(selected) });
    assert.equal(registration.status, 'registered');
    const result = await readClaudeSelection(f.args);
    assert.equal(result.blocked, null); assert.deepEqual(result.pending, []); assert.equal(result.candidates.length, 1);
    const { capture } = result.candidates[0];
    assert.equal(capture.reader.headerClientVersion, version);
    assert.deepEqual(capture.evidence.map(item => item.text), ['Meeting: selected source.']);
    assert.equal(capture.terminal, 'unconfirmed'); assert.equal(capture.coverage.partial, true);
    assert.equal(result.diagnostics.unownedRecords, 1);
  }
});

test('Claude requires bounded version metadata at registration and extraction', async t => {
  const f = await fixture(t, [human()]), { fileIdentity: _identity, ...selected } = f.source;
  for (const version of [undefined, null, 1, {}, '', ' ', 'v'.repeat(129), '\u0000', '\ud800']) {
    const rows = [{ ...f.rows[0], version }, ...f.rows.slice(1)];
    await fs.writeFile(f.source.path, rows.map(row => JSON.stringify(row) + '\n').join(''));
    await assert.rejects(inspectSourceBoundary(selected, { verifyHeader: claudeRegistrationHeader(selected) }), { code: 'INVALID_SESSION_CLIENT_VERSION' });
    await assert.rejects(readClaudeSelection(f.args), { code: 'INVALID_SESSION_CLIENT_VERSION' });
  }
});

test('header registration accepts bounded metadata prefixes and checks exact source identity', async t => {
  const f = await fixture(t, [human()]);
  await fs.writeFile(f.source.path, JSON.stringify({ type: 'custom-title', customTitle: 'Synthetic' }) + '\n' + f.bytes);
  const { fileIdentity: _identity, ...selected } = f.source;
  const inspected = await inspectSourceBoundary(selected, { currentUnitId: A, verifyHeader: claudeRegistrationHeader(f.source) });
  assert.equal(inspected.status, 'registered');
});

test('large input has a bounded tail anchor and bounded normalized evidence', async t => {
  const f = await fixture(t, [human(A, 'é'.repeat(700000))]);
  const result = await readClaudeSelection(f.args), candidate = result.candidates[0];
  assert.ok(candidate.proof.end.endByte - candidate.proof.end.startByte <= 65536);
  assert.ok(serializeCapture(candidate.capture).length < 2 * 1024 * 1024);
  assert.ok(candidate.capture.coverage.omissions.some(o => o.reason === 'text-truncated'));
  await publish(f, result);
});

test('same-head replay from a held cursor rebuilds once without duplicating retained evidence', async t => {
  const f = await fixture(t, [human(A), human(B), human(A, 'Delayed extra.')], { future: true });
  const result = await readClaudeSelection(f.args);
  const first = await publish(f, result, A);
  assert.equal(first.cursor.offset, result.from.offset);
  const head = await readCaptureHead(f.store, result.candidates[0].capture.identity);
  const replay = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint, heads: new Map([[A, head]]) });
  assert.equal(replay.candidates.some(c => c.capture.identity.unitId === A), false);
  assert.equal((await readCaptureHead(f.store, head.capture.identity)).capture.evidenceHash, first.evidenceHash);
});

test('paged carry preserves ancestry through 5000 unowned rows and later incremental prompts', async t => {
  const f = await fixture(t, [human()], { future: true });
  const first = await publish(f, await readClaudeSelection(f.args));
  await append(f, [...Array.from({ length: 5000 }, () => assistant('Never persist this payload.')), human(B, 'Next meeting decision.')]);
  const result = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint });
  assert.equal(result.blocked, null); assert.equal(result.candidates.length, 1);
  assert.equal(result.checkpoint.records.length, 5002);
  assert.doesNotMatch(JSON.stringify(result.checkpoint), /Never persist/);
  const second = await publish(f, result, B, first.cursorHash);
  const progress = intakeJSON(await intakeSnapshot(f.store, 'state', `progress/claude/${S}/${f.args.scopeId}.json`));
  assert.equal(progress.checkpoint.version, 2); assert(progress.checkpoint.pages.length >= 2 && progress.checkpoint.pages.length <= 16);
  assert(JSON.stringify(progress).length < 8192);
  assert.deepEqual(await hydrateReaderCheckpoint(f.store, progress.checkpoint), second.checkpoint);
  const nextId = randomUUID(); await append(f, [human(nextId, 'Third decision.')]);
  const reads = [], next = await readClaudeSelection({ ...f.args, cursor: second.cursor, checkpoint: second.checkpoint, observeRead: row => reads.push(row) });
  assert.equal(next.blocked, null); assert.equal(next.candidates[0].capture.identity.unitId, nextId);
  assert(reads.filter(row => row.purpose === 'range').every(row => row.offset >= second.cursor.offset));
  await publish(f, next, nextId, second.cursorHash);
  // An old UUID must still detect a conflicting mirror after page hydration.
  await append(f, [{ ...f.rows[10], message: { role: 'assistant', content: 'Changed old payload' } }]);
  const conflict = await readClaudeSelection({ ...f.args, cursor: second.cursor, checkpoint: second.checkpoint });
  assert.equal(conflict.blocked.code, 'CONFLICTING_CLAUDE_MIRROR');
});

test('transport metadata is accounted without permanent byte-key carry', async t => {
  const f = await fixture(t, [human()], { future: true });
  const first = await publish(f, await readClaudeSelection(f.args));
  await fs.appendFile(f.source.path, Array.from({ length: 5000 }, () => JSON.stringify({ type: 'progress', sessionId: S }) + '\n').join(''));
  await append(f, [human(B, 'After progress')]);
  const result = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint });
  assert.equal(result.blocked, null); assert.equal(result.checkpoint.records.length, 2);
  await publish(f, result, B, first.cursorHash);
});

test('cursor and carry cannot commit across an unpublished human input or missing retained locator', async t => {
  const f = await fixture(t, [human(), assistant()]), result = await readClaudeSelection(f.args);
  const plan = claudePublicationPlan(result);
  assert.equal(plan.heldReason, 'unpublished-earlier-unit'); assert.equal(plan.scan.to.offset, plan.scan.from.offset);
  const first = await publish(f, result);
  const next = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint });
  const after = claudePublicationPlan(next); after.checkpoint.records = after.checkpoint.records.filter(row => row.kind !== 'unowned');
  await assert.rejects(withIntakeLock(f.store, tx => commitReaderProgress(tx, { identity: { client: 'claude', sessionId: S },
    scopeId: f.args.scopeId, selectionHash: f.selectionHash, cursorHash: first.cursorHash, ...after, authorize: async () => true })), { code: 'UNVERIFIED_READER_CHECKPOINT' });
  const progress = intakeJSON(await intakeSnapshot(f.store, 'state', `progress/claude/${S}/${f.args.scopeId}.json`));
  assert.equal(progress.offset, first.cursor.offset); assert.deepEqual(progress.checkpoint, planReaderCheckpoint(first.checkpoint).root);
});

test('a different root session inside the selected range invalidates the read', async t => {
  const f = await fixture(t, [human(), assistant('foreign', { sessionId: B })]);
  await assert.rejects(readClaudeSelection(f.args), { code: 'SOURCE_IDENTITY_MISMATCH' });
});

test('empty native input advances without a fake capture and permits later evidence in the same prompt', async t => {
  const f = await fixture(t, [human(A, '')]), result = await readClaudeSelection(f.args);
  assert.equal(result.candidates.length, 0); assert.deepEqual(result.noEvidence, [A]);
  const saved = await withIntakeLock(f.store, tx => commitReaderProgress(tx, { identity: { client: 'claude', sessionId: S },
    scopeId: f.args.scopeId, selectionHash: f.selectionHash, cursorHash: null, ...claudePublicationPlan(result), authorize: async () => true }));
  assert.equal((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A })).head, null);
  await append(f, [human(A, 'Late source.', { timestamp: '2026-09-25T00:00:00.000Z' })]);
  const next = await readClaudeSelection({ ...f.args, cursor: saved.cursor, checkpoint: saved.checkpoint });
  assert.equal(next.candidates[0].capture.evidence[0].text, 'Late source.');
  assert.equal(next.candidates[0].capture.occurredAt, stamp);
  await publish(f, next, A, saved.cursorHash);
});

test('later cwd changes preserve registration identity, including outside and removed working directories', async t => {
  const f = await fixture(t, [human(A), assistant(), human(A, 'Work after cd.')]);
  f.rows[2].cwd = path.join(f.root, 'packages', 'api');
  f.rows[3].cwd = path.join(f.root, 'missing-worktree');
  await fs.writeFile(f.source.path, f.rows.map(row => JSON.stringify(row) + '\n').join(''));
  const result = await readClaudeSelection(f.args);
  assert.equal(result.candidates[0].capture.evidence.length, 2); assert.equal(result.candidates[0].capture.projectRoot, f.root);
});

test('extension replay after partial cursor advancement retains each record exactly once', async t => {
  const f = await fixture(t, [human(A, 'one'), human(B, 'two'), human(A, 'three')], { future: true });
  const read = await readClaudeSelection(f.args), a = await publish(f, read, A);
  const afterA = await readClaudeSelection({ ...f.args, cursor: a.cursor, checkpoint: a.checkpoint });
  const b = await publish(f, afterA, B, a.cursorHash, new Map([[A, { evidenceHash: a.evidenceHash, fileHash: a.fileHash }]]));
  const head = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A });
  await append(f, [human(A, 'four')]);
  const next = await readClaudeSelection({ ...f.args, cursor: b.cursor, checkpoint: b.checkpoint, heads: new Map([[A, head]]) });
  assert.deepEqual(next.candidates[0].capture.evidence.map(e => e.text), ['one', 'three', 'four']);
  await publish(f, next, A, b.cursorHash);
});

test('pause and resume selects the second interval without linking unrelated earlier boundaries', async t => {
  const P = randomUUID(), R = randomUUID(), N = randomUUID();
  const f = await fixture(t, [human(A), human(P, 'pause'), human(R, 'resume'), human(N, 'New interval')], { future: true });
  let selected = { state: f.state, hash: f.selectionHash };
  for (const [operation, unitId, index] of [['pause', P, 1], ['resume', R, 2]]) {
    selected = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, expectedHash: selected.hash,
      request: { id: randomUUID(), client: 'claude', sessionId: S, expectedRevision: selected.state.revision, operation, unitId },
      boundary: { sourceIdentity: f.source.fileIdentity, unitId, eofByte: f.anchors[index].endByte, startsMidRecord: false, record: f.anchors[index] }, authorize: async () => true }));
  }
  const result = await readClaudeSelection({ state: selected.state, scopeId: selected.state.intervals[1].id, capturedAt: stamp });
  assert.deepEqual(result.candidates.map(c => c.capture.identity.unitId), [N]);
});

test('native compaction logical parent preserves human ancestry while excluding derived summary text', async t => {
  const a = human(A), compact = message('system', '', { subtype: 'compact_boundary', logicalParentUuid: a.uuid });
  const summary = human(A, 'DO NOT COPY SUMMARY', { isCompactSummary: true }), b = human(B, 'After compact');
  const f = await fixture(t, [a, compact, summary, b], { future: true });
  f.rows[3].parentUuid = null;
  await fs.writeFile(f.source.path, f.rows.map(row => JSON.stringify(row) + '\n').join(''));
  const result = await readClaudeSelection(f.args);
  assert.deepEqual(result.candidates.map(c => c.capture.identity.unitId), [A, B]);
  assert.doesNotMatch(JSON.stringify(result.candidates), /DO NOT COPY SUMMARY/);
});

test('client updates within a Claude session preserve incremental capture and replay', async t => {
  const f = await fixture(t, [human(A)]), initial = await readClaudeSelection(f.args);
  // An existing immutable capture uses the former header-version field name.
  const initialCapture = initial.candidates[0].capture;
  initialCapture.reader.clientVersion = initialCapture.reader.headerClientVersion;
  delete initialCapture.reader.headerClientVersion;
  const first = await publish(f, initial);
  const head = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A });
  await append(f, [assistant('UNOWNED RESPONSE', { version: '2.1.282' }), human(A, 'Additional supplied source.', { version: '999.0.0' })]);
  const result = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint, heads: new Map([[A, head]]) });
  assert.equal(result.blocked, null); assert.equal(result.candidates.length, 1);
  const { capture } = result.candidates[0];
  assert.deepEqual(capture.evidence.map(item => item.text), ['Meeting: selected source.', 'Additional supplied source.']);
  assert.equal(capture.reader.headerClientVersion, f.rows[0].version);
  assert.equal(Object.hasOwn(capture.reader, 'clientVersion'), false);
  const saved = await publish(f, result, A, first.cursorHash);
  const replay = await readClaudeSelection({ ...f.args, cursor: saved.cursor, checkpoint: saved.checkpoint,
    heads: new Map([[A, await readCaptureHead(f.store, head.head.identity)]]) });
  assert.equal(replay.blocked, null); assert.equal(replay.candidates.length, 0);
});

test('malformed later version metadata preserves the supported prefix with an explicit blocked offset', async t => {
  const f = await fixture(t, [human(A), assistant('invalid version metadata', { version: null })]);
  const result = await readClaudeSelection(f.args);
  assert.equal(result.candidates.length, 1); assert.equal(result.blocked.code, 'INVALID_SESSION_CLIENT_VERSION');
  assert.equal(result.to.offset, f.anchors[0].endByte);
});

test('unknown later record shapes still block on a different client version', async t => {
  const f = await fixture(t, [human(A), message('future-record', 'Do not copy.', { version: '999.0.0' })]);
  const result = await readClaudeSelection(f.args);
  assert.equal(result.candidates.length, 1); assert.equal(result.blocked.code, 'UNSUPPORTED_CLAUDE_RECORD');
  assert.equal(result.to.offset, f.anchors[0].endByte);
});

test('unpersisted boundary anchors cannot be passed by no-capture progress or bind to a later same-prompt record', async t => {
  const f = await fixture(t, [human(C, 'first control record'), human(C, 'second control record'), human(A)], { future: true, missingLower: true });
  const result = await readClaudeSelection({ ...f.args, maxRecords: 2 });
  assert.equal(result.anchorUpdates.length, 1); assert.equal(result.anchorUpdates[0].proven.record.id, f.anchors[0].id);
  assert.throws(() => claudePublicationPlan(result), { code: 'SELECTION_ANCHORS_PENDING' });
  const plan = claudePublicationPlan({ ...result, anchorUpdates: [] });
  await assert.rejects(withIntakeLock(f.store, tx => commitReaderProgress(tx, { identity: { client: 'claude', sessionId: S },
    scopeId: f.args.scopeId, selectionHash: f.selectionHash, cursorHash: null, ...plan, authorize: async () => true })), { code: 'SELECTION_ANCHORS_PENDING' });
  const updated = await withIntakeLock(f.store, tx => resolveStoredSelectionAnchor(tx, { identity: { client: 'claude', sessionId: S },
    ...result.anchorUpdates[0], expectedHash: f.selectionHash, authorize: async () => true }));
  const retry = await readClaudeSelection({ ...f.args, state: updated.state });
  assert.equal(retry.anchorUpdates.length, 0); assert.equal(retry.candidates[0].capture.identity.unitId, A);
});

test('empty follow-ups do not create provenance-only revisions and repeated images retain MIME and counts', async t => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BINARY' } };
  const f = await fixture(t, [human(A, [image])]), first = await publish(f, await readClaudeSelection(f.args));
  let head = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A });
  await append(f, [human(A, '')]);
  const empty = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint, heads: new Map([[A, head]]) });
  assert.equal(empty.candidates.length, 0);
  await append(f, [human(A, [image])]);
  const next = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint, heads: new Map([[A, head]]) });
  assert.equal(next.candidates[0].capture.coverage.omissions[0].mimeType, 'image/png');
  assert.equal(next.candidates[0].capture.coverage.omissions[0].count, 2);
  await publish(f, next, A, first.cursorHash);
});

test('Claude publication cannot accidentally advance without its checkpoint', async t => {
  const f = await fixture(t, [human()]), result = await readClaudeSelection(f.args);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...result.candidates[0], selectionHash: f.selectionHash,
    cursorHash: null, scan: claudePublicationPlan(result, A).scan, authorize: async () => true })), { code: 'READER_CHECKPOINT_REQUIRED' });
  assert.equal((await readCaptureHead(f.store, result.candidates[0].capture.identity)).head, null);
});

test('registration canonicalizes a selected project alias', async t => {
  const f = await fixture(t, [human()]), alias = path.join(f.root, 'project-alias');
  await fs.symlink(path.dirname(f.root), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const { fileIdentity: _identity, ...selected } = f.source; selected.projectRoot = path.join(alias, path.basename(f.root));
  const inspected = await inspectSourceBoundary(selected, { currentUnitId: A, verifyHeader: claudeRegistrationHeader(selected) });
  assert.equal(inspected.source.projectRoot, f.root);
});

test('a compaction record without native ancestry blocks with a specific diagnostic', async t => {
  const f = await fixture(t, [human(), message('system', '', { subtype: 'compact_boundary' })]);
  f.rows[2].parentUuid = null;
  await fs.writeFile(f.source.path, f.rows.map(row => JSON.stringify(row) + '\n').join(''));
  const result = await readClaudeSelection(f.args);
  assert.equal(result.candidates.length, 1); assert.equal(result.blocked.code, 'CLAUDE_COMPACTION_ANCESTRY_UNAVAILABLE');
  assert.equal(result.to.offset, f.anchors[0].endByte);
});

test('recovery authenticates durable pages and completes bookkeeping without the native source', async t => {
  const { recoverPendingPublication } = await import('./intake-store.mjs');
  const f = await fixture(t, [human(), assistant()]), result = await readClaudeSelection(f.args);
  const candidate = result.candidates[0], plan = claudePublicationPlan(result, A);
  assert.equal(plan.checkpoint.records.length, 1, 'uncommitted suffix stays out of the root');
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...candidate, ...plan, selectionHash: f.selectionHash, cursorHash: null,
    authorize: async () => true, fault: async phase => { if (phase === 'head') throw new Error('interrupted after commit'); } })), /interrupted after commit/);
  const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json'));
  const descriptor = pending.checkpoint.pages[0];
  const file = path.join(f.store.intakeStateDir, 'reader-pages/claude', S, f.args.scopeId, `${descriptor.index.toString(16).padStart(2, '0')}-${descriptor.hash.slice(0, 20)}`, 'page.json');
  const bytes = await fs.readFile(file); await fs.unlink(file); await fs.unlink(f.source.path);
  await assert.rejects(withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: async () => true })), /READER_PAGE_CONFLICT/);
  assert(intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')));
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const recovered = await withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: async () => true }));
  assert.equal(recovered.status, 'published'); assert.deepEqual(recovered.checkpoint, plan.checkpoint);
});


test('interleaved metadata accounting commits a bounded prefix instead of holding the whole batch', async t => {
  const f = await fixture(t, [human()]), first = await publish(f, await readClaudeSelection(f.args));
  await append(f, Array.from({ length: 1200 }, (_, i) => i % 2 ? { type: 'progress', sessionId: S } : assistant('unowned', { parentUuid: f.rows.at(-1).uuid })));
  const result = await readClaudeSelection({ ...f.args, cursor: first.cursor, checkpoint: first.checkpoint });
  const plan = claudePublicationPlan(result);
  assert.equal(result.blocked, null); assert.equal(plan.heldReason, null); assert.equal(plan.scan.accounted.length, 1024);
  assert(plan.scan.to.offset > first.cursor.offset && plan.scan.to.offset < result.to.offset);
  const progress = await withIntakeLock(f.store, tx => commitReaderProgress(tx, { identity: { client: 'claude', sessionId: S },
    scopeId: f.args.scopeId, selectionHash: f.selectionHash, cursorHash: first.cursorHash, ...plan, authorize: async () => true }));
  const next = await readClaudeSelection({ ...f.args, cursor: progress.cursor, checkpoint: progress.checkpoint });
  assert.equal(next.blocked, null); assert.equal(claudePublicationPlan(next).heldReason, null);
});

test('damaged pages abandon only an uncommitted publication intent', async t => {
  const { recoverPendingPublication } = await import('./intake-store.mjs');
  const f = await fixture(t, [human()]), result = await readClaudeSelection(f.args), plan = claudePublicationPlan(result, A);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...result.candidates[0], ...plan, selectionHash: f.selectionHash, cursorHash: null,
    authorize: async () => true, fault: async phase => { if (phase === 'intent') throw new Error('interrupted intent'); } })), /interrupted intent/);
  const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')), page = pending.checkpoint.pages[0];
  const file = path.join(f.store.intakeStateDir, 'reader-pages/claude', S, f.args.scopeId, `${page.index.toString(16).padStart(2, '0')}-${page.hash.slice(0, 20)}`, 'page.json');
  await fs.unlink(file);
  await assert.rejects(withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: async () => true })), /READER_PAGE_CONFLICT/);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')), null);
  assert.equal((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A })).head, null);
});

test('reader capacity stops before the overflowing row and commits the entire accepted prefix', async t => {
  const f = await fixture(t, [human()]); let progress = await publish(f, await readClaudeSelection(f.args));
  await append(f, Array.from({ length: 33000 }, () => assistant()));
  let blocked = null;
  for (let pass = 0; pass < 3; pass++) {
    const result = await readClaudeSelection({ ...f.args, cursor: progress.cursor, checkpoint: progress.checkpoint });
    const plan = claudePublicationPlan(result);
    assert.equal(plan.heldReason, null); assert(plan.scan.to.offset > progress.cursor.offset);
    assert(planReaderCheckpoint(plan.checkpoint).root.pages.length <= 16);
    progress = await withIntakeLock(f.store, tx => commitReaderProgress(tx, { identity: { client: 'claude', sessionId: S },
      scopeId: f.args.scopeId, selectionHash: f.selectionHash, cursorHash: progress.cursorHash, ...plan, authorize: async () => true }));
    blocked = result.blocked;
    if (blocked?.code === 'READER_CHECKPOINT_CAPACITY') break;
  }
  assert.equal(blocked.code, 'READER_CHECKPOINT_CAPACITY');
  assert(progress.checkpoint.records.length > 25000); assert.equal(progress.cursor.offset, blocked.offset);
  assert(progress.cursor.offset < (await fs.stat(f.source.path)).size);
});

test('Claude 2.1.299 API request snapshots are skipped transport metadata, never evidence', async t => {
  const apiShape = { type: 'api-request-shape', sessionId: S, shapeHash: 'a'.repeat(64), timestamp: stamp, version: '2.1.299', shape: {} };
  const apiBlob = text => ({ type: 'api-request-blob', sessionId: S, hash: digest(text), message: { role: 'user', content: text } });
  const apiRequest = { type: 'api-request', sessionId: S, id: randomUUID(), timestamp: stamp, version: '2.1.299', querySource: 'repl_main_thread',
    shapeHash: 'a'.repeat(64), params: {}, keep: 1, tail: [], cacheControl: [], requestDigest: 'b'.repeat(64) };
  const f = await fixture(t, [human(), apiShape, apiBlob('COPIED BLOB TEXT'), apiRequest, assistant()],
    { prefix: JSON.stringify(apiShape) + '\n' });
  const result = await readClaudeSelection(f.args);
  assert.equal(result.blocked, null); assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].capture.evidence.map(item => item.text), ['Meeting: selected source.']);
  assert(!JSON.stringify(result).includes('COPIED BLOB TEXT'));
  await publish(f, result);
});
