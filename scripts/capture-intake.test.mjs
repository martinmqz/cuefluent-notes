import test from './test-support/storage-test.mjs';
import { privateIntakeFixture, rebindIntakeFixture } from './test-support/intake-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { newSelectionState, validateSelectionState, applySelectionControl, evaluateUnitSelection, resolveSelectionAnchor, inspectSourceBoundary, stableSourceIdentity, SOURCE_HEADER_BYTES, MAX_SELECTION_BYTES } from './capture-selection.mjs';
import { inspectIntakeStore, withIntakeLock, intakeSnapshot, intakeJSON, intakePath, writeIntakeStage, assertIntakeTransaction } from './intake-io.mjs';
import { controlSelection, readSelection, publishCapture, recoverPendingPublication, verifySourceCursor, resolveStoredSelectionAnchor, readCaptureHead } from './intake-store.mjs';
import { createCapture, captureRelativePath } from './capture-contract.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { chosenStretch } from './session-jsonl.mjs';

const S = '10000000-0000-4000-8000-000000000001';
const U = Array.from({ length: 8 }, (_, i) => `20000000-0000-4000-8000-00000000000${i}`);
const stamp = '2026-01-01T00:00:00.000Z';
const hash = 'a'.repeat(64);
const anchor = (id, startByte, endByte) => ({ id, startByte, endByte, hash });
const boundary = (unitId, eofByte, record = null) => ({ sourceIdentity: hash, unitId, eofByte, startsMidRecord: false, record });
const source = () => ({ client: 'codex', sessionId: S, path: path.join(os.tmpdir(), 'synthetic.jsonl'), projectRoot: os.tmpdir(), fileIdentity: hash });
const request = (state, operation, unitId, rest = {}) => ({ id: randomUUID(), client: state.source.client, sessionId: state.source.sessionId,
  operation, expectedRevision: state.revision, ...(unitId !== undefined ? { unitId } : {}), ...rest });
const proof = (unitId = U[2], nativeOrder = null) => ({ client: 'codex', sessionId: S, sourceIdentity: hash, unitId,
  start: anchor('start', 200, 220), end: anchor('end', 280, 300), nativeOrder });
const allow = async () => true;
async function failHandleSyncOnce(file, operation) {
  const sample = await fs.open(file, 'r'), prototype = Object.getPrototypeOf(sample), original = prototype.sync;
  await sample.close(); let failed = false;
  prototype.sync = async function (...args) {
    if (!failed) { failed = true; throw Object.assign(new Error('injected sync failure'), { code: 'EIO' }); }
    return original.apply(this, args);
  };
  try { return await operation(); } finally { prototype.sync = original; }
}
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-intake-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return fs.realpath(root);
}

test('captures that fill a selection leave room to pause and resume', () => {
  let state = newSelectionState(source());
  state = applySelectionControl(state, request(state, 'start', U[1]), boundary(U[1], 100));
  state = applySelectionControl(state, request(state, 'pause', U[3]), boundary(U[3], 150));
  // Captures fill the record to just short of where captures stop.
  const captureCeiling = MAX_SELECTION_BYTES - 32 * 1024;
  const scope = () => ({ id: randomUUID(), kind: 'historical', contentHash: hash, unitIds: Array.from({ length: 8 }, () => randomUUID()), start: anchor('s', 200, 220), end: anchor('e', 280, 300) });
  while (Buffer.byteLength(canonicalJSON(state)) < captureCeiling - 200) state.explicitScopes.push(scope());
  state = validateSelectionState(state);
  const capture = request(state, 'capture-historical', undefined, { scope: { contentHash: hash, unitIds: [U[5]], start: proof().start, end: proof().end } });
  assert.throws(() => applySelectionControl(state, capture, null), { code: 'SELECTION_CAPACITY_EXCEEDED' });
  // Resuming and pausing again still fit, without a safety stop.
  state = applySelectionControl(state, request(state, 'resume', U[4]), boundary(U[4], 500));
  state = applySelectionControl(state, request(state, 'pause', U[6]), boundary(U[6], 600));
  assert.equal(state.safetyStop, null); assert.equal(state.paused, true);
});

test('future selection needs native order and exact anchors, not byte offsets or other UUIDs', () => {
  let state = newSelectionState(source());
  state = applySelectionControl(state, request(state, 'start', U[1]), boundary(U[1], 100));
  assert.equal(evaluateUnitSelection(state, proof()).selected, false);
  const low = anchor('excluded-current', 110, 150);
  state = resolveSelectionAnchor(state, state.intervals[0].id, 'lower', { sourceIdentity: hash, unitId: U[1], record: low });
  const order = { kind: 'native-links', units: [U[0], U[1], U[2]], anchors: [{ unitId: U[1], record: low }, { unitId: U[2], record: proof().start }] };
  assert.equal(evaluateUnitSelection(state, proof(U[2], order)).selected, true);
  const old = proof(U[0], { ...order, anchors: [...order.anchors, { unitId: U[0], record: proof().start }] });
  assert.equal(evaluateUnitSelection(state, old).selected, false);
  assert.throws(() => evaluateUnitSelection(state, { ...proof(), postBoundary: true }));
  const floor = state.intervals[0].lower.eofByte;
  assert.throws(() => resolveSelectionAnchor(state, state.intervals[0].id, 'lower', { sourceIdentity: hash, unitId: U[0], record: low }));
  assert.equal(state.intervals[0].lower.eofByte, floor);
});

test('pause preserves earlier work persisted late and excludes its own native turn', () => {
  let state = newSelectionState(source());
  const low = anchor('lower', 100, 110), high = anchor('upper', 400, 420);
  state = applySelectionControl(state, request(state, 'start', U[1]), boundary(U[1], 100, low));
  const lowerId = state.intervals[0].id;
  state = applySelectionControl(state, request(state, 'pause', U[3]), boundary(U[3], 150));
  const order = { kind: 'native-links', units: [U[1], U[2], U[3]], anchors: [{ unitId: U[1], record: low }, { unitId: U[2], record: proof().start }, { unitId: U[3], record: high }] };
  assert.equal(evaluateUnitSelection(state, proof(U[2], order)).selected, false);
  state = resolveSelectionAnchor(state, lowerId, 'upper', { sourceIdentity: hash, unitId: U[3], record: high });
  assert.equal(evaluateUnitSelection(state, proof(U[2], order)).selected, true);
  assert.equal(evaluateUnitSelection(state, proof(U[3])).reason, 'excluded');
  state = applySelectionControl(state, request(state, 'resume', U[4]), boundary(U[4], 500));
  assert.equal(state.intervals.length, 2);
  assert.equal(state.intervals[0].lower.eofByte, 100);
  assert.equal(evaluateUnitSelection(JSON.parse(JSON.stringify(state)), proof(U[2], order)).scopeId, lowerId);
});

test('controls are retryable, refuse stale requests, and never infer changes from prose', () => {
  let state = newSelectionState(source());
  const start = request(state, 'start', U[1]);
  state = applySelectionControl(state, start, boundary(U[1], 100));
  assert.deepEqual(applySelectionControl(state, start, boundary(U[1], 200)), state);
  const repeat = applySelectionControl(state, request(state, 'start', U[2]), boundary(U[2], 200));
  assert.equal(repeat.intervals.length, 1); assert.equal(repeat.intervals[0].lower.eofByte, 100);
  assert.throws(() => applySelectionControl(repeat, start, boundary(U[1], 100)), { code: 'STALE_SELECTION' });
  assert.throws(() => applySelectionControl(state, { ...request(state, 'pause', U[2]), sessionId: U[7] }, boundary(U[2], 200)), { code: 'SELECTION_IDENTITY_MISMATCH' });
  assert.throws(() => applySelectionControl(state, { ...request(state, 'exclude', U[2]), prose: 'do not capture' }, null));
  const current = applySelectionControl(state, request(state, 'capture-current', U[2], { scope: { contentHash: hash, unitIds: [U[2]], start: proof().start, end: null } }), null);
  assert.equal(current.intervals[0].lower.eofByte, 100);
  assert.equal(evaluateUnitSelection(current, proof()).kind, 'current');
  const manual = newSelectionState(source());
  const history = applySelectionControl(manual, request(manual, 'capture-historical', undefined, { scope: { contentHash: hash, unitIds: [U[2]], start: proof().start, end: proof().end } }), null);
  assert.equal(history.active, false); assert.equal(history.intervals.length, 0);
});

test('explicit capture requests and saved scopes require their inspected content hash', () => {
  const state = newSelectionState(source());
  for (const kind of ['current', 'historical']) {
    const scope = { contentHash: hash, unitIds: [U[2]], start: proof().start, end: kind === 'current' ? null : proof().end };
    const control = request(state, `capture-${kind}`, kind === 'current' ? U[2] : undefined, { scope });
    const selected = applySelectionControl(state, control, null);
    assert.equal(selected.explicitScopes[0].contentHash, hash);
    assert.deepEqual(chosenStretch(selected.explicitScopes[0]), { from: scope.start.startByte, to: (scope.end ?? scope.start).endByte, hash });
    const before = canonicalJSON(selected);
    for (const value of [undefined, null, '', 'not-a-hash']) {
      const missing = structuredClone(control), stored = structuredClone(selected);
      if (value === undefined) { delete missing.scope.contentHash; delete stored.explicitScopes[0].contentHash; }
      else { missing.scope.contentHash = value; stored.explicitScopes[0].contentHash = value; }
      assert.throws(() => applySelectionControl(state, missing, null), { code: 'INVALID_WORKFLOW' });
      assert.throws(() => validateSelectionState(stored), { code: 'INVALID_WORKFLOW' });
      assert.throws(() => chosenStretch(stored.explicitScopes[0]), { code: 'INVALID_WORKFLOW' });
    }
    assert.equal(canonicalJSON(selected), before);
    assert.equal(state.revision, 0); assert.deepEqual(state.explicitScopes, []);
  }
  const automatic = applySelectionControl(state, request(state, 'start', U[1]), boundary(U[1], 100));
  assert.equal(chosenStretch(automatic.intervals[0]), null);
});

test('registration fixes EOF without reading a 50 MiB historical prefix', async t => {
  const root = await temp(t), file = path.join(root, 'source.jsonl');
  const selected = { client: 'codex', sessionId: S, path: file, projectRoot: root };
  let invoked = false;
  assert.equal((await inspectSourceBoundary(selected, { verifyHeader: async () => { invoked = true; } })).status, 'pending-source');
  assert.equal(invoked, false);
  const header = Buffer.from(JSON.stringify({ client: 'codex', sessionId: S, projectRoot: root }) + '\n');
  await fs.writeFile(file, header); await fs.truncate(file, 50 * 1024 * 1024);
  const sample = await fs.open(file, 'r'), prototype = Object.getPrototypeOf(sample), originalRead = prototype.read;
  await sample.close();
  const actualReads = [];
  let inspected;
  prototype.read = async function (...args) { const result = await originalRead.apply(this, args); actualReads.push({ offset: args[3], bytes: result.bytesRead }); return result; };
  try {
    inspected = await inspectSourceBoundary(selected, { currentUnitId: U[1], verifyHeader: async ({ readHeader }) => {
      await assert.rejects(readHeader(0, SOURCE_HEADER_BYTES + 1), { code: 'SOURCE_HEADER_LIMIT' });
      const bytes = await readHeader(0, header.length);
      await fs.appendFile(file, '\nnew record\n');
      return JSON.parse(bytes);
    } });
  } finally { prototype.read = originalRead; }
  assert.deepEqual(actualReads, [{ offset: 0, bytes: header.length }, { offset: 50 * 1024 * 1024 - 1, bytes: 1 }]);
  assert.ok(actualReads.reduce((sum, item) => sum + item.bytes, 0) <= 64 * 1024 + 1);
  assert.equal(inspected.boundary.eofByte, 50 * 1024 * 1024);
  assert.equal(inspected.boundary.startsMidRecord, true);
  assert.equal(inspected.boundary.unitId, U[1]);
  assert.equal(inspected.boundary.record, null);
});

test('registration refuses source replacement, truncation, and conflicting native identity', async t => {
  const root = await temp(t), file = path.join(root, 'source.jsonl');
  const selected = { client: 'codex', sessionId: S, path: file, projectRoot: root };
  await fs.writeFile(file, 'a'.repeat(100));
  await assert.rejects(inspectSourceBoundary(selected, { verifyHeader: async () => ({ ...selected, sessionId: U[7] }) }), { code: 'SOURCE_IDENTITY_MISMATCH' });
  await assert.rejects(inspectSourceBoundary(selected, { verifyHeader: async () => { await fs.truncate(file, 1); return selected; } }), { code: 'SOURCE_CHANGED' });
  await fs.writeFile(file, 'a'.repeat(100));
  await assert.rejects(inspectSourceBoundary(selected, { verifyHeader: async () => {
    await fs.rename(file, file + '.old'); await fs.writeFile(file, 'a'.repeat(100)); return selected;
  } }), { code: 'SOURCE_CHANGED' });
});

async function fixture(t) {
  const root = await temp(t);
  const selected = { ...source(), path: path.join(root, 'source.jsonl'), projectRoot: root };
  const store = await privateIntakeFixture(t, selected);
  await fs.writeFile(selected.path, 'x'.repeat(300));
  selected.fileIdentity = stableSourceIdentity(await fs.lstat(selected.path, { bigint: true }));
  const initial = newSelectionState(selected), unitProof = { ...proof(), sourceIdentity: selected.fileIdentity };
  unitProof.start.hash = unitProof.end.hash = digest('x'.repeat(20));
  const control = request(initial, 'capture-current', U[2], { scope: { contentHash: digest('x'.repeat(20)), unitIds: [U[2]], start: unitProof.start, end: null } });
  const selection = await withIntakeLock(store, tx => controlSelection(tx, { source: selected, request: control, expectedHash: null, authorize: allow }));
  const capture = createCapture({ format: 'cuefluent-capture', schemaVersion: 2, identity: { client: 'codex', sessionId: S, unitId: U[2] },
    projectRoot: root, source: { path: selected.path, fileIdentity: selected.fileIdentity,
      ranges: [{ startByte: 220, endByte: 280, recordIds: ['message'] }] }, reader: { name: 'synthetic', version: '1', headerClientVersion: 'fixture' },
    occurredAt: stamp, capturedAt: stamp, terminal: 'completed', coverage: { partial: false, omissions: [] },
    evidence: [{ kind: 'user', recordId: 'message', range: { startByte: 220, endByte: 280, recordIds: ['message'] }, text: 'Supplied meeting decision.' }] });
  const scan = { from: { sourceIdentity: selected.fileIdentity, offset: 200, anchor: null },
    to: { sourceIdentity: selected.fileIdentity, offset: 300, anchor: { startByte: 280, endByte: 300, hash: unitProof.end.hash } },
    accounted: [{ startByte: 200, endByte: 300, kind: 'captured', unitId: U[2] }] };
  const args = { capture, proof: unitProof, scopeId: control.id, selectionHash: selection.hash, cursorHash: null, scan, authorize: allow };
  return { root, store, args, selection, control, source: selected };
}

test('immutable publication writes exact receipt/cursor and identical retries reuse original bytes', async t => {
  const f = await fixture(t);
  const result = await withIntakeLock(f.store, tx => publishCapture(tx, f.args));
  const raw = await intakeSnapshot(f.store, 'raw', captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash));
  assert.equal(raw.hash, result.fileHash);
  const retry = structuredClone(f.args.capture); retry.capturedAt = '2026-01-02T00:00:00.000Z'; retry.reader.version = '2';
  const again = await withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, capture: createCapture(retry) }));
  assert.equal(again.status, 'already-published'); assert.equal(again.fileHash, raw.hash);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'raw', captureRelativePath(retry.identity, retry.evidenceHash))).capturedAt, stamp);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')), null);
  const changed = createCapture({ ...retry, terminal: 'interrupted', coverage: { partial: true, omissions: [] } });
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, capture: changed })), { code: 'STALE_CAPTURE_HEAD' });
  assert.equal((await intakeSnapshot(f.store, 'raw', captureRelativePath(retry.identity, retry.evidenceHash))).hash, raw.hash);
});

test('a boolean callback cannot replace storage authority and private-mode failure cannot prevent explicit exclusion', async t => {
  const f = await fixture(t), unverified = await inspectIntakeStore(f.store);
  await assert.rejects(withIntakeLock(unverified, tx => publishCapture(tx, f.args)), { code: 'STORAGE_CAPABILITY_REQUIRED' });
  assert.equal((await intakeSnapshot(unverified, 'raw', captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash))).bytes, null);
  if (process.platform !== 'win32') await fs.chmod(f.store.intakeStateDir, 0o750);
  const result = await withIntakeLock(unverified, tx => controlSelection(tx, { source: f.source,
    request: request(f.selection.state, 'exclude', U[2]), expectedHash: f.selection.hash, authorize: async () => false }));
  assert(result.state.exclusions.includes(U[2]));
});

for (const phase of ['intent', 'published', 'stage-removed', 'head', 'receipt-index-pending', 'receipt', 'cursor']) {
  test(`publication recovery completes after a ${phase} fault without rescanning history`, async t => {
    const f = await fixture(t);
    await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async at => { if (at === phase) throw new Error('simulated crash'); } })), /simulated crash/);
    const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json'));
    assert.notEqual(pending, null);
    if (phase === 'published') {
      const stat = await fs.lstat(path.join(f.store.rawDir, pending.target)); assert.equal(stat.nlink, 2);
    }
    if (['head', 'receipt-index-pending', 'receipt', 'cursor'].includes(phase)) await fs.unlink(f.source.path);
    const recovered = await withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: allow }));
    assert.equal(recovered.status, 'published'); assert.equal(recovered.cursor.offset, 300);
    assert.equal((await fs.lstat(path.join(f.store.rawDir, pending.target))).nlink, 1);
    assert.equal(await fs.stat(path.join(f.store.rawDir, pending.stage.path)).catch(error => error.code), 'ENOENT');
    assert.equal((await withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: allow }))).status, 'idle');
  });
}

test('fault before durable intent leaves no capture or progress; owned bytes are preserved', async t => {
  const f = await fixture(t);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async phase => { if (phase === 'staged') throw new Error('staged'); } })), /staged/);
  assert.equal((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash))).bytes, null);
  assert.equal((await withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: allow }))).status, 'idle');
  const stageNames = await fs.readdir(path.join(f.store.rawDir, 'codex', S, U[2]));
  assert.equal(stageNames.length, 1); assert.match(stageNames[0], /^\.stage-/);
});

test('changed stages, revoked authorization, and discontinuous cursors never advance', async t => {
  const f = await fixture(t);
  const gap = structuredClone(f.args.scan); gap.accounted[0].startByte++;
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, scan: gap })), { code: 'NONCONTIGUOUS_INTAKE_CURSOR' });
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, authorize: async () => false })), { code: 'INTAKE_NOT_AUTHORIZED' });
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async phase => { if (phase === 'intent') throw new Error('intent'); } })), /intent/);
  const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json'));
  await assert.rejects(withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: async () => false })), { code: 'INTAKE_NOT_AUTHORIZED' });
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')), null);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async phase => { if (phase === 'intent') throw new Error('intent'); } })), /intent/);
  const replacementPending = intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json'));
  const replacement = createCapture({ ...f.args.capture, capturedAt: '2026-02-01T00:00:00.000Z' });
  await fs.writeFile(path.join(f.store.rawDir, replacementPending.stage.path), canonicalJSON(replacement) + '\n');
  await assert.rejects(withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: allow })), { code: 'INTAKE_STAGE_CHANGED' });
  assert.equal((await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${pending.scopeId}.json`)).bytes, null);
});

test('intake locks serialize controls and preserve changed owners', async t => {
  const f = await fixture(t);
  await withIntakeLock(f.store, async () => {
    await assert.rejects(withIntakeLock(f.store, async () => {}), { code: 'INTAKE_BLOCKED' });
  });
  const same = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, request: f.control, expectedHash: null, authorize: allow }));
  assert.equal(same.hash, f.selection.hash);
  const latest = await readSelection(f.store, { client: 'codex', sessionId: S }); assert.equal(latest.hash, f.selection.hash);
  const changed = await withIntakeLock(f.store, async () => {
    await fs.writeFile(path.join(f.store.intakeStateDir, '.intake-lock', 'owner.json'), '{}');
    return { status: 'completed' };
  });
  assert.equal(changed.status, 'completed'); assert.match(changed.cleanupWarnings[0], /INTAKE_LOCK_CHANGED/);
  assert.equal(await fs.readFile(path.join(f.store.intakeStateDir, '.intake-lock', 'owner.json'), 'utf8'), '{}');
});

test('unfamiliar paths, linked metadata and replaced managed parents are refused', async t => {
  const f = await fixture(t);
  await assert.rejects(intakePath(f.store, 'state', '../escape'), { code: 'UNSAFE_INTAKE_PATH' });
  const sessionFile = path.join(f.store.intakeStateDir, 'sessions', 'codex', `${S}.json`);
  await fs.link(sessionFile, path.join(f.root, 'extra-link'));
  await assert.rejects(readSelection(f.store, { client: 'codex', sessionId: S }));
  await fs.unlink(path.join(f.root, 'extra-link'));
  const parent = path.dirname(sessionFile);
  await fs.rename(parent, parent + '-old'); await fs.mkdir(parent);
  await assert.rejects(readSelection(f.store, { client: 'codex', sessionId: S }), { code: 'INTAKE_ROOT_CHANGED' });
});

test('selection capacity exhaustion and rewind fail without discarding old exclusions', () => {
  const state = newSelectionState(source());
  state.exclusions = Array.from({ length: 4097 }, () => randomUUID());
  assert.throws(() => validateSelectionState(state), { code: 'SELECTION_CAPACITY_EXCEEDED' });
  assert.equal(state.exclusions.length, 4097);
  const started = applySelectionControl(newSelectionState(source()), request(newSelectionState(source()), 'start', U[1]), boundary(U[1], 200));
  assert.throws(() => applySelectionControl(started, request(started, 'pause', U[2]), boundary(U[2], 100)), { code: 'SOURCE_CHANGED' });
});

test('cursor anchors detect in-place source changes and truncation', async t => {
  const f = await fixture(t);
  await verifySourceCursor(f.source, f.args.scan.to);
  const handle = await fs.open(f.source.path, 'r+');
  try { await handle.write(Buffer.from('changed'), 0, 7, 280); } finally { await handle.close(); }
  await assert.rejects(verifySourceCursor(f.source, f.args.scan.to), { code: 'SOURCE_ANCHOR_CONFLICT' });
  await fs.truncate(f.source.path, 100);
  await assert.rejects(verifySourceCursor(f.source, f.args.scan.to), { code: 'SOURCE_CHANGED' });
});

test('existing equal evidence retains original provenance in a new explicit scope', async t => {
  const f = await fixture(t);
  const first = await withIntakeLock(f.store, tx => publishCapture(tx, f.args));
  const nextRequest = request(f.selection.state, 'capture-current', U[2], { scope: { contentHash: f.args.proof.start.hash, unitIds: [U[2]], start: f.args.proof.start, end: null } });
  const next = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, request: nextRequest, expectedHash: f.selection.hash, authorize: allow }));
  const retry = createCapture({ ...f.args.capture, capturedAt: '2026-03-01T00:00:00.000Z', reader: { ...f.args.capture.reader, version: '2' } });
  const result = await withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, capture: retry, selectionHash: next.hash, scopeId: nextRequest.id }));
  assert.equal(result.fileHash, first.fileHash);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'raw', captureRelativePath(retry.identity, retry.evidenceHash))).capturedAt, stamp);
});

test('changed published bytes and malformed receipts remain unresolved without advancing', async t => {
  const f = await fixture(t);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async phase => { if (phase === 'stage-removed') throw new Error('stop'); } })), /stop/);
  const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json'));
  const target = path.join(f.store.rawDir, pending.target), original = await fs.readFile(target);
  await fs.writeFile(target, canonicalJSON(createCapture({ ...f.args.capture, capturedAt: '2026-04-01T00:00:00.000Z' })) + '\n');
  await assert.rejects(withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: allow })), { code: 'CAPTURE_CONFLICT' });
  assert.equal((await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${pending.scopeId}.json`)).bytes, null);
  await fs.writeFile(target, original);
  const receiptDir = path.join(f.store.intakeStateDir, 'receipts'); await fs.mkdir(receiptDir, { mode: 0o700 });
  await fs.writeFile(path.join(receiptDir, `${pending.id}.json`), '{}', { mode: 0o600 });
  await assert.rejects(withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: allow })), { code: 'INTAKE_RECEIPT_CONFLICT' });
  assert.equal((await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${pending.scopeId}.json`)).bytes, null);
});

test('a raw-file edit after receipt creation prevents cursor advancement', async t => {
  const f = await fixture(t);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async phase => {
    if (phase === 'receipt') await fs.writeFile(path.join(f.store.rawDir, captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash)), canonicalJSON(createCapture({ ...f.args.capture, capturedAt: '2026-05-01T00:00:00.000Z' })) + '\n');
  } })), { code: 'CAPTURE_HEAD_CONFLICT' });
  const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json'));
  assert.equal((await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${pending.scopeId}.json`)).bytes, null);
});

test('unpublished source failures release the pending slot without creating a capture', async t => {
  const f = await fixture(t);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async phase => {
    if (phase === 'intent') await fs.unlink(f.source.path);
  } })), error => error.code === 'SOURCE_UNAVAILABLE' && error.abandonedPublication?.status === 'abandoned');
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')), null);
  assert.equal((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash))).bytes, null);
  assert.equal((await fs.readdir(path.join(f.store.intakeStateDir, 'abandoned'))).length, 1);
});

test('oversized anchors and publish denial fail before staging or intent', async t => {
  const f = await fixture(t);
  const oversized = structuredClone(f.args.scan); oversized.to.offset = 100000; oversized.to.anchor.endByte = 100000;
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, scan: oversized })), { code: 'SOURCE_ANCHOR_LIMIT' });
  const contexts = [];
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, authorize: async context => {
    contexts.push(context); return context.phase !== 'publish';
  } })), { code: 'INTAKE_NOT_AUTHORIZED' });
  assert.equal(contexts[0].identity.unitId, U[2]); assert.equal(contexts[0].sourcePath, f.source.path);
  assert.equal(contexts[0].projectRoot, f.source.projectRoot); assert.equal(contexts[0].scopeId, f.control.id);
  assert.deepEqual(await fs.readdir(f.store.rawDir), []);
  assert.equal((await intakeSnapshot(f.store, 'state', 'pending.json')).bytes, null);
});

test('a pending session cannot block another session or make a same-turn opt-out lose', async t => {
  const f = await fixture(t);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async phase => { if (phase === 'intent') throw new Error('stop'); } })), /stop/);
  const otherSource = { ...f.source, sessionId: U[7], path: path.join(f.root, 'other.jsonl') };
  await fs.writeFile(otherSource.path, 'x'.repeat(300));
  otherSource.fileIdentity = stableSourceIdentity(await fs.lstat(otherSource.path, { bigint: true }));
  const otherState = newSelectionState(otherSource), otherRequest = request(otherState, 'start', U[1]);
  const otherStore = await rebindIntakeFixture(f.store, otherSource);
  const other = await withIntakeLock(otherStore, tx => controlSelection(tx, { source: otherSource, request: otherRequest,
    boundary: { ...boundary(U[1], 300), sourceIdentity: otherSource.fileIdentity }, expectedHash: null, authorize: allow }));
  assert.equal(other.state.active, true);
  const excluded = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source,
    request: request(f.selection.state, 'exclude', U[2]), expectedHash: f.selection.hash, authorize: async () => false }));
  assert.ok(excluded.state.exclusions.includes(U[2]));
  assert.equal((await withIntakeLock(f.store, tx => recoverPendingPublication(tx))).status, 'idle');
  assert.equal((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash))).bytes, null);
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, selectionHash: excluded.hash })), { code: 'CAPTURE_NOT_SELECTED' });
});

test('native anchors have a locked compare-and-swap persistence operation', async t => {
  const f = await fixture(t);
  const start = request(f.selection.state, 'start', U[1]);
  const state = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, request: start,
    boundary: { ...boundary(U[1], 300), sourceIdentity: f.source.fileIdentity }, expectedHash: f.selection.hash, authorize: allow }));
  const intervalId = state.state.intervals[0].id;
  const args = { identity: { client: 'codex', sessionId: S }, intervalId, side: 'lower',
    proven: { sourceIdentity: f.source.fileIdentity, unitId: U[1], record: anchor('native-boundary', 300, 320) }, expectedHash: state.hash, authorize: allow };
  const resolved = await withIntakeLock(f.store, tx => resolveStoredSelectionAnchor(tx, args));
  assert.equal(resolved.state.revision, state.state.revision);
  assert.notEqual(resolved.hash, state.hash);
  await assert.rejects(withIntakeLock(f.store, tx => resolveStoredSelectionAnchor(tx, args)), { code: 'STALE_SELECTION' });
});

test('future start can wait for a native boundary; restrictive pause still needs its selected native unit', () => {
  const initial = newSelectionState(source());
  const waiting = applySelectionControl(initial, request(initial, 'start', null), boundary(null, 0));
  assert.equal(waiting.intervals[0].lower.unitId, null);
  assert.equal(evaluateUnitSelection(waiting, proof()).reason, 'anchor-unresolved');
  assert.throws(() => applySelectionControl(waiting, request(waiting, 'pause', null), boundary(null, 0)), { code: 'NATIVE_BOUNDARY_REQUIRED' });
  const unresolved = applySelectionControl(initial, request(initial, 'start', U[1]), boundary(U[1], 100));
  assert.equal(evaluateUnitSelection(unresolved, proof()).reason, 'anchor-unresolved');
  assert.equal(evaluateUnitSelection(initial, proof()).reason, 'outside-interval');
});

test('capacity cannot make pause or exclude fail open', () => {
  let state = newSelectionState(source());
  state = applySelectionControl(state, request(state, 'start', U[1]), boundary(U[1], 100));
  state.exclusions = Array.from({ length: 4096 }, () => randomUUID());
  const paused = applySelectionControl(state, request(state, 'pause', U[2]), boundary(U[2], 200));
  assert.equal(paused.active, false); assert.equal(paused.exclusions.length, 4096);
  assert.equal(evaluateUnitSelection(paused, proof()).reason, 'excluded');
  const stopped = applySelectionControl(state, request(state, 'exclude', U[3]), null);
  assert.equal(stopped.safetyStop.reason, 'capacity');
  assert.equal(evaluateUnitSelection(stopped, proof()).reason, 'safety-stop');
  assert.throws(() => applySelectionControl(paused, request(paused, 'capture-current', U[2], { scope: { contentHash: hash, unitIds: [U[2]], start: proof().start, end: null } }), null), { code: 'EXCLUDED_CAPTURE_REQUEST' });
});

test('selection returns all matching scopes and rejects cross-kind scope ID collisions', () => {
  let state = newSelectionState(source()); const low = anchor('lower', 100, 120);
  state = applySelectionControl(state, request(state, 'start', U[1]), boundary(U[1], 100, low));
  state = applySelectionControl(state, request(state, 'capture-current', U[2], { scope: { contentHash: hash, unitIds: [U[2]], start: proof().start, end: null } }), null);
  const order = { kind: 'native-links', units: [U[1], U[2]], anchors: [{ unitId: U[1], record: low }, { unitId: U[2], record: proof().start }] };
  assert.deepEqual(evaluateUnitSelection(state, proof(U[2], order)).scopes.map(scope => scope.kind), ['current', 'future']);
  state.explicitScopes[0].id = state.intervals[0].id;
  assert.throws(() => validateSelectionState(state));
});

test('operation errors survive a concurrent lock cleanup conflict', async t => {
  const f = await fixture(t), failure = new Error('original operation failure');
  await assert.rejects(withIntakeLock(f.store, async () => {
    await fs.writeFile(path.join(f.store.intakeStateDir, '.intake-lock', 'owner.json'), '{}'); throw failure;
  }), error => error === failure && /INTAKE_LOCK_CHANGED/.test(error.cleanupWarnings[0]));
});

test('owner sync failure cleans only its incomplete lock and permits another acquisition', async t => {
  const f = await fixture(t);
  await assert.rejects(failHandleSyncOnce(f.source.path, () => withIntakeLock(f.store, async () => assert.fail('must not run'))), { code: 'EIO' });
  assert.equal(await fs.stat(path.join(f.store.intakeStateDir, '.intake-lock')).catch(error => error.code), 'ENOENT');
  assert.equal(await withIntakeLock(f.store, async () => 'available'), 'available');
});

test('a failed stage sync removes its exact owned partial output', async t => {
  const f = await fixture(t);
  await withIntakeLock(f.store, async tx => {
    await assert.rejects(failHandleSyncOnce(f.source.path, () => writeIntakeStage(f.store, 'raw', '.partial.tmp', Buffer.from('data'), () => assertIntakeTransaction(tx))), { code: 'EIO' });
    assert.equal((await intakeSnapshot(f.store, 'raw', '.partial.tmp')).bytes, null);
  });
});

test('a large accounted prefix has a compact receipt and exact terminal anchor', async t => {
  const f = await fixture(t); await fs.writeFile(f.source.path, 'x'.repeat(1000));
  const end = { id: 'terminal', startByte: 980, endByte: 1000, hash: digest('x'.repeat(20)) };
  const to = { sourceIdentity: f.source.fileIdentity, offset: 1000, anchor: { startByte: 980, endByte: 1000, hash: end.hash } };
  const accounted = Array.from({ length: 800 }, (_, i) => ({ startByte: 200 + i, endByte: 201 + i, kind: 'captured', unitId: U[2] }));
  assert.ok(Buffer.byteLength(JSON.stringify(accounted)) > 16000);
  const args = { ...f.args, proof: { ...f.args.proof, end }, scan: { from: f.args.scan.from, to, accounted } };
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...args, scan: { ...args.scan, to: { ...to, anchor: { ...to.anchor, hash } } } })), { code: 'INVALID_INTAKE_CURSOR' });
  await withIntakeLock(f.store, tx => publishCapture(tx, args));
  const receipts = await fs.readdir(path.join(f.store.intakeStateDir, 'receipts'));
  assert.equal(receipts.length, 1);
  const receipt = await intakeSnapshot(f.store, 'state', `receipts/${receipts[0]}`);
  assert.ok(receipt.bytes.length < 2048); assert.equal(intakeJSON(receipt).transition, undefined);
});

test('malformed pending metadata cannot prevent an explicit exclusion', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.store.intakeStateDir, 'pending.json'), '{', { mode: 0o600 });
  const result = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source,
    request: request(f.selection.state, 'exclude', U[2]), expectedHash: f.selection.hash, authorize: async () => false }));
  assert.ok(result.state.exclusions.includes(U[2])); assert.equal(result.pendingWarning, 'INVALID_INTAKE_METADATA');
  assert.equal(await fs.readFile(path.join(f.store.intakeStateDir, 'pending.json'), 'utf8'), '{');
});

test('source registration canonicalizes project aliases', async t => {
  const root = await temp(t), parent = path.join(root, 'parent'), project = path.join(parent, 'project'), alias = path.join(root, 'alias'), file = path.join(root, 'source.jsonl');
  await fs.mkdir(project, { recursive: true }); await fs.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir'); await fs.writeFile(file, '{}\n');
  const selected = { client: 'codex', sessionId: S, path: file, projectRoot: path.join(alias, 'project') };
  const result = await inspectSourceBoundary(selected, { currentUnitId: U[1], verifyHeader: async () => ({ ...selected, projectRoot: project }) });
  assert.equal(result.source.projectRoot, project);
});

for (const failure of ['truncate', 'hardlink', 'denied', 'missing-stage']) {
  test(`unpublished ${failure} failure retains diagnostics and frees the pending slot`, async t => {
    const f = await fixture(t); let intent = false;
    await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args,
      authorize: async () => !(failure === 'denied' && intent),
      fault: async phase => {
        if (phase !== 'intent') return;
        intent = true;
        if (failure === 'truncate') await fs.truncate(f.source.path, 1);
        if (failure === 'hardlink') await fs.link(f.source.path, path.join(f.root, 'extra-source-link'));
        if (failure === 'missing-stage') {
          const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json'));
          await fs.unlink(path.join(f.store.rawDir, pending.stage.path));
        }
      } })), error => error.abandonedPublication?.status === 'abandoned');
    assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')), null);
    assert.equal((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash))).bytes, null);
  });
}

test('interleaved completed units publish behind a low-water cursor and later account for prior captures', async t => {
  const f = await fixture(t); await fs.appendFile(f.source.path, 'x'.repeat(200));
  const end = { ...anchor('end-A', 480, 500), hash: digest('x'.repeat(20)) };
  const selected = request(f.selection.state, 'capture-historical', undefined, { scope: { contentHash: digest('x'.repeat(300)), unitIds: [U[2], U[3]], start: f.args.proof.start, end } });
  const selection = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, request: selected, expectedHash: f.selection.hash, authorize: allow }));
  const makeCapture = (unitId, ranges) => createCapture({ ...f.args.capture, identity: { ...f.args.capture.identity, unitId },
    source: { ...f.args.capture.source, ranges: ranges.map((pair, i) => ({ startByte: pair[0], endByte: pair[1], recordIds: [`record-${i}`] })) },
    evidence: ranges.map((pair, i) => ({ kind: 'user', recordId: `record-${i}`, range: { startByte: pair[0], endByte: pair[1], recordIds: [`record-${i}`] }, text: `Evidence ${i}` })) });
  const captureB = makeCapture(U[3], [[260, 280], [320, 340]]);
  const proofB = { ...f.args.proof, unitId: U[3], start: { ...anchor('start-B', 240, 260), hash: digest('x'.repeat(20)) }, end: { ...anchor('end-B', 340, 360), hash: digest('x'.repeat(20)) } };
  const argsB = { ...f.args, capture: captureB, proof: proofB, scopeId: selected.id, selectionHash: selection.hash,
    scan: { from: f.args.scan.from, to: f.args.scan.from, accounted: [] } };
  const first = await withIntakeLock(f.store, tx => publishCapture(tx, argsB));
  assert.equal(first.cursor.offset, 200);
  const progress = await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${selected.id}.json`);
  const captureA = makeCapture(U[2], [[220, 240], [280, 320], [360, 480]]);
  const pieces = [[200, 220, 'structural'], [220, 240, 'captured'], [240, 260, 'structural'], [260, 280, 'published'],
    [280, 320, 'captured'], [320, 340, 'published'], [340, 360, 'structural'], [360, 480, 'captured'], [480, 500, 'structural']];
  const accounted = pieces.map(([startByte, endByte, kind]) => ({ startByte, endByte, kind,
    ...(kind === 'captured' ? { unitId: U[2] } : kind === 'published' ? { unitId: U[3], fileHash: first.fileHash, evidenceHash: first.evidenceHash } : {}) }));
  const final = await withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, capture: captureA, proof: { ...f.args.proof, end },
    scopeId: selected.id, selectionHash: selection.hash, cursorHash: progress.hash,
    scan: { from: first.cursor, to: { sourceIdentity: f.source.fileIdentity, offset: 500, anchor: { startByte: 480, endByte: 500, hash: end.hash } }, accounted } }));
  assert.equal(final.cursor.offset, 500);
  assert.equal((await withIntakeLock(f.store, tx => publishCapture(tx, argsB))).cursor.offset, 500);
  assert.equal((await intakeSnapshot(f.store, 'raw', captureRelativePath(captureB.identity, captureB.evidenceHash))).hash, first.fileHash);
});

async function snapshotFixture(t) {
  const f = await fixture(t);
  f.args.capture = createCapture({ ...f.args.capture, terminal: 'unconfirmed', coverage: { partial: true, omissions: [] } });
  const first = await withIntakeLock(f.store, tx => publishCapture(tx, f.args));
  await fs.appendFile(f.source.path, 'x'.repeat(100));
  const addedRange = { startByte: 320, endByte: 380, recordIds: ['message-2'] };
  const next = { ...f.args, expectedHeadHash: first.headHash, cursorHash: first.cursorHash,
    capture: createCapture({ ...f.args.capture, source: { ...f.args.capture.source, ranges: [...f.args.capture.source.ranges, addedRange] },
      evidence: [...f.args.capture.evidence, { kind: 'assistant', recordId: 'message-2', range: addedRange, text: 'Observed follow-up.' }] }),
    proof: { ...f.args.proof, end: { ...f.args.proof.end, id: 'end-2', startByte: 380, endByte: 400 } },
    scan: { from: first.cursor, to: { sourceIdentity: f.source.fileIdentity, offset: 400,
      anchor: { startByte: 380, endByte: 400, hash: digest('x'.repeat(20)) } },
      accounted: [{ startByte: 300, endByte: 400, kind: 'captured', unitId: U[2] }] } };
  return { ...f, first, next };
}

test('snapshot revisions preserve immutable bytes and exact old retries cannot reactivate an old head', async t => {
  const f = await snapshotFixture(t), second = await withIntakeLock(f.store, tx => publishCapture(tx, f.next));
  assert.notEqual(second.evidenceHash, f.first.evidenceHash);
  const latest = await readCaptureHead(f.store, f.args.capture.identity);
  assert.equal(latest.head.generation, 2); assert.equal(latest.head.previousHash, f.first.headHash);
  assert.equal(latest.capture.evidence.length, 2);
  const retry = await withIntakeLock(f.store, tx => publishCapture(tx, f.args));
  assert.equal(retry.status, 'already-published'); assert.equal(retry.fileHash, f.first.fileHash);
  assert.equal(retry.headHash, second.headHash); assert.equal(retry.cursor.offset, 400);
  assert.equal((await readCaptureHead(f.store, f.args.capture.identity)).hash, second.headHash);
});

test('a stale or lossy snapshot cannot replace an active revision even with a refreshed expected hash', async t => {
  const f = await snapshotFixture(t);
  const lossy = createCapture({ ...f.next.capture, evidence: f.next.capture.evidence.slice(1) });
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.next, capture: lossy })), { code: 'CAPTURE_REVISION_CONFLICT' });
  const second = await withIntakeLock(f.store, tx => publishCapture(tx, f.next));
  const stale = createCapture({ ...f.next.capture, terminal: 'completed', coverage: { partial: false, omissions: [] } });
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.next, capture: stale })), { code: 'STALE_CAPTURE_HEAD' });
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.next, capture: lossy, expectedHeadHash: second.headHash })), { code: 'CAPTURE_REVISION_CONFLICT' });
  assert.equal((await readCaptureHead(f.store, f.args.capture.identity)).hash, second.headHash);
});

for (const phase of ['intent', 'published', 'stage-removed', 'head', 'receipt', 'cursor']) {
  test(`revision recovery after ${phase} keeps the activated head and cursor consistent`, async t => {
    const f = await snapshotFixture(t);
    await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.next,
      fault: async step => { if (step === phase) throw new Error('crash'); } })), /crash/);
    const visible = await readCaptureHead(f.store, f.args.capture.identity);
    assert.equal(visible.head.generation, ['head', 'receipt', 'cursor'].includes(phase) ? 2 : 1);
    if (['head', 'receipt', 'cursor'].includes(phase)) await fs.unlink(f.source.path);
    const recovered = await withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: allow }));
    assert.equal(recovered.cursor.offset, 400);
    assert.equal((await readCaptureHead(f.store, f.args.capture.identity)).head.generation, 2);
  });
}

for (const phase of ['published', 'stage-removed']) {
  test(`revoked consent after ${phase} leaves immutable orphan bytes inactive`, async t => {
    const f = await fixture(t);
    await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args,
      fault: async step => { if (step === phase) throw new Error('crash'); } })), /crash/);
    await assert.rejects(withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: async () => false })), { code: 'INTAKE_NOT_AUTHORIZED' });
    assert.equal((await readCaptureHead(f.store, f.args.capture.identity)).head, null);
    assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')), null);
    const raw = await intakeSnapshot(f.store, 'raw', captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash));
    assert.ok(raw.bytes); assert.equal(raw.identity.nlink, 1n);
    // A later authorized retry must pass fresh source and selection checks.
    await fs.unlink(f.source.path);
    await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, f.args)), { code: 'SOURCE_UNAVAILABLE' });
    assert.equal((await readCaptureHead(f.store, f.args.capture.identity)).head, null);
  });
}

test('tampered completed receipt and missing activated head cannot be used as an idempotent retry', async t => {
  const f = await snapshotFixture(t);
  await withIntakeLock(f.store, tx => publishCapture(tx, f.next));
  const receiptDir = path.join(f.store.intakeStateDir, 'receipts');
  const receipts = await fs.readdir(receiptDir);
  const oldPath = (await Promise.all(receipts.map(async name => ({ path: path.join(receiptDir, name), value: JSON.parse(await fs.readFile(path.join(receiptDir, name), 'utf8')) })))).find(item => item.value.evidenceHash === f.first.evidenceHash);
  const bytes = await fs.readFile(oldPath.path);
  await fs.writeFile(oldPath.path, JSON.stringify({ ...oldPath.value, selectionHash: '0'.repeat(64) }));
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, f.args)), { code: 'INTAKE_RECEIPT_CONFLICT' });
  await fs.writeFile(oldPath.path, bytes);
  await fs.unlink(path.join(f.store.intakeStateDir, 'heads', 'codex', S, `${U[2]}.json`));
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, f.args)), { code: 'INTAKE_RECEIPT_CONFLICT' });
});

test('full fingerprint checks reject a valid but different capture at a shortened locator', async t => {
  const f = await fixture(t), other = createCapture({ ...f.args.capture, evidence: [{ ...f.args.capture.evidence[0], text: 'Other evidence' }] });
  const file = await intakePath(f.store, 'raw', captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash), { createParents: true });
  await fs.writeFile(file, canonicalJSON(other) + '\n', { mode: 0o600 });
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, f.args)), { code: 'CAPTURE_LOCATOR_COLLISION' });
  assert.equal((await readCaptureHead(f.store, f.args.capture.identity)).head, null);
});

async function reusedHeadFixture(t) {
  const f = await fixture(t);
  const first = await withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, scan: { from: f.args.scan.from, to: f.args.scan.from, accounted: [] } }));
  return { ...f, first, reuse: { ...f.args, expectedHeadHash: first.headHash, cursorHash: first.cursorHash } };
}

for (const phase of ['intent', 'head']) {
  test(`same-evidence progress after ${phase} rechecks source and abandons an uncommitted cursor safely`, async t => {
    const f = await reusedHeadFixture(t);
    await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.reuse, fault: async step => {
      if (step !== phase) return;
      const handle = await fs.open(f.source.path, 'r+');
      try { await handle.write('y', 281, 'utf8'); } finally { await handle.close(); }
    } })), { code: 'SOURCE_ANCHOR_CONFLICT' });
    assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'pending.json')), null);
    assert.equal((await readCaptureHead(f.store, f.args.capture.identity)).hash, f.first.headHash);
    const progress = intakeJSON(await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${f.control.id}.json`));
    assert.equal(progress.offset, 200);
    await fs.writeFile(f.source.path, 'x'.repeat(300));
    const retry = await withIntakeLock(f.store, tx => publishCapture(tx, f.reuse));
    assert.equal(retry.cursor.offset, 300); assert.equal(retry.fileHash, f.first.fileHash);
  });
}

for (const phase of ['intent', 'head', 'cursor', 'receipt']) {
  test(`same-evidence recovery at ${phase} uses the cursor commit point, not the preexisting head`, async t => {
    const f = await reusedHeadFixture(t);
    await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.reuse,
      fault: async step => { if (step === phase) throw new Error('crash'); } })), /crash/);
    if (['cursor', 'receipt'].includes(phase)) await fs.unlink(f.source.path);
    const recovered = await withIntakeLock(f.store, tx => recoverPendingPublication(tx, { authorize: allow }));
    assert.equal(recovered.cursor.offset, 300); assert.equal(recovered.headHash, f.first.headHash);
    assert.equal((await withIntakeLock(f.store, tx => publishCapture(tx, f.reuse))).status, 'already-published');
  });
}


test('capture publication rechecks the unit directory immediately before linking', async t => {
  const f = await fixture(t), original = fs.open;
  const parent = path.dirname(path.join(f.store.rawDir, captureRelativePath(f.args.capture.identity, f.args.capture.evidenceHash)));
  let checking = false, reads = 0, changed = false;
  fs.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (checking && file === f.source.path && ++reads === 3) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close(); changed = true;
        await fs.rename(parent, parent + '-original'); await fs.mkdir(parent, { mode: 0o700 });
        await fs.writeFile(path.join(parent, 'foreign'), 'preserved', { mode: 0o600 });
      };
    }
    return handle;
  };
  try {
    await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, fault: async phase => { if (phase === 'intent') checking = true; } })), /INTAKE_ROOT_CHANGED/);
  } finally { fs.open = original; }
  assert(changed); assert.deepEqual(await fs.readdir(parent), ['foreign']);
  assert.equal(await fs.readFile(path.join(parent, 'foreign'), 'utf8'), 'preserved');
});
