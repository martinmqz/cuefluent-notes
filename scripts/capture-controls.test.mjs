import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { digest } from './workflow-values.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { openWorkflowIntake, openExplicitCaptureIntake, withIntakeLock, assertIntakePrivacy, replaceIntakeJSON } from './intake-io.mjs';
import { readCaptureHead, readReaderProgress, readSelection } from './intake-store.mjs';
import { captureSelectionStatus, controlCapture, previewExplicitCapture, selectExplicitCapture, runSelectedCapture } from './test-support/capture-workflow.mjs';
const S = '10000000-0000-4000-8000-000000000001';
const A = '20000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const row = (type, payload) => JSON.stringify({ timestamp: '2026-09-24T00:00:00.000Z', type, payload }) + '\n';
const turn = (id, text) => row('event_msg', { type: 'task_started', turn_id: id }) + row('event_msg', { type: 'user_message', message: text }) + row('event_msg', { type: 'task_complete', turn_id: id });
async function fixture(t, { enabled = false, version = '0.156.1' } = {}) {
  const f = await storageFixture(t), sourcePath = path.join(f.project, 'session.jsonl');
  f.config.routes[0].collection.enabled = enabled;
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  const header = row('session_meta', { id: S, session_id: S, cwd: f.project, cli_version: version, source: 'cli', history_mode: 'legacy' });
  await fs.writeFile(sourcePath, header + turn(A, 'Meeting: decision Alpha') + turn(B, 'Task: unrelated Beta'));
  const selection = { client: 'codex', sessionId: S, cwd: f.project, unitId: A };
  const status = await captureSelectionStatus(capability, { selection, sourcePath });
  const request = { selection, sourcePath, expectedSourceIdentity: status.source.fileIdentity, expectedSelectionHash: null,
    operationId: randomUUID(), kind: 'current', unitIds: [A], readRange: { fromByte: Buffer.byteLength(header), endByte: status.source.eofByte } };
  return { ...f, capability, sourcePath, selection, request, store: await openWorkflowIntake(capability) };
}

async function claudeScopeFixture(t) {
  const f = await fixture(t), stamp = '2026-09-24T00:00:00.000Z';
  const human = (id, parentUuid) => ({ type: 'user', uuid: randomUUID(), timestamp: stamp, sessionId: S,
    version: '2.1.282', isSidechain: false, parentUuid, cwd: f.project, promptId: id, message: { role: 'user', content: 'Synthetic evidence.' } });
  const a = human(A, null), b = human(B, a.uuid), body = JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n';
  await fs.writeFile(f.sourcePath, body);
  const selection = { ...f.selection, client: 'claude', unitId: null };
  const initial = await captureSelectionStatus(f.capability, { selection, sourcePath: f.sourcePath, includeReaderAllocation: true });
  assert.equal(initial.readerAllocation.status, 'unavailable'); assert.equal(initial.readerAllocation.reason, 'no-selection');
  const request = { ...f.request, selection, kind: 'historical', expectedSourceIdentity: initial.source.fileIdentity,
    readRange: { fromByte: 0, endByte: Buffer.byteLength(body) } };
  const chosen = await selectExplicitCapture(f.capability, request);
  return { ...f, selection, request, chosen };
}

test('capture status reports headroom without writes, transcript reads, page hydration or an intake lock', async t => {
  const f = await claudeScopeFixture(t), args = { selection: f.selection, sourcePath: f.sourcePath, scopeId: f.request.operationId };
  const unused = await captureSelectionStatus(f.capability, args);
  assert.equal(unused.readerAllocation.scopes[0].bytes.reserved, 0);
  await runSelectedCapture(f.capability, { selection: f.selection, scopeId: f.request.operationId, expectedSelectionHash: f.chosen.hash, unitIds: [A] });
  let writes = 0;
  for (const method of ['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'chmod', 'chown', 'link', 'symlink']) {
    t.mock.method(fs, method, async () => { writes++; throw new Error('Status attempted a filesystem write'); });
  }
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, flags, ...rest) => {
    assert.notEqual(file, f.sourcePath, 'status never opens a transcript');
    assert.notEqual(path.basename(file), 'page.json', 'status never hydrates pages');
    const writable = typeof flags === 'string' ? flags !== 'r' : flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND);
    if (writable) { writes++; throw new Error('Status opened a file for writing'); }
    return open(file, flags, ...rest);
  });
  let report;
  try { report = await captureSelectionStatus(f.capability, args); }
  finally { t.mock.restoreAll(); }
  assert.equal(writes, 0); assert.equal(report.hash, f.chosen.hash);
  assert.equal(report.readerAllocation.status, 'available');
  const allocation = report.readerAllocation.scopes[0];
  assert(allocation.bytes.reserved > 0); assert(allocation.pages.reserved > 0);
  assert.equal(allocation.bytes.remaining + allocation.bytes.reserved, allocation.bytes.limit);
  const counter = path.join(f.collection.intakeStateDir, 'reader-pages/claude', S, f.request.operationId, 'allocation.json');
  await fs.unlink(counter);
  const damaged = await captureSelectionStatus(f.capability, args);
  assert.equal(damaged.hash, report.hash); assert.equal(damaged.readerAllocation.status, 'partial');
  assert.equal(damaged.readerAllocation.scopes[0].status, 'inconsistent');
  assert(!Object.hasOwn(damaged.readerAllocation.scopes[0], 'bytes'));
  const progress = path.join(f.collection.intakeStateDir, 'progress/claude', S, `${f.request.operationId}.json`);
  const saved = await fs.readFile(progress);
  await fs.writeFile(progress, '{"PRIVATE-unfinished":');
  const invalid = await captureSelectionStatus(f.capability, args);
  assert.equal(invalid.hash, report.hash); assert.equal(invalid.readerAllocation.status, 'partial');
  assert.deepEqual(invalid.readerAllocation.scopes[0], { scopeId: f.request.operationId,
    status: 'unavailable', error: 'INVALID_INTAKE_METADATA' });
  assert(!JSON.stringify(invalid).includes('PRIVATE-unfinished'));
  await fs.writeFile(progress, saved); await fs.mkdir(counter, { mode: 0o700 });
  const unreadable = await captureSelectionStatus(f.capability, args);
  assert.equal(unreadable.hash, report.hash); assert.equal(unreadable.readerAllocation.status, 'partial');
  assert.deepEqual(unreadable.readerAllocation.scopes[0], { scopeId: f.request.operationId,
    status: 'unavailable', error: 'FILE_NOT_REGULAR' });
});

test('status bounds known scope reads, supports explicit scope selection and marks Codex not applicable', async t => {
  const f = await claudeScopeFixture(t);
  const state = structuredClone(f.chosen.state);
  state.explicitScopes = Array.from({ length: 33 }, () => ({ ...state.explicitScopes[0], id: randomUUID() }));
  await withIntakeLock(f.store, tx => replaceIntakeJSON(tx, `sessions/claude/${S}.json`, state, f.chosen.hash));
  const lstat = fs.lstat; let progressReads = 0;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (file.includes(`${path.sep}progress${path.sep}`) || file.endsWith('allocation.json')) progressReads++;
    return lstat(file, ...args);
  });
  const routine = await captureSelectionStatus(f.capability, { selection: f.selection });
  assert(!Object.hasOwn(routine, 'readerAllocation'));
  const needed = await captureSelectionStatus(f.capability, { selection: f.selection, includeReaderAllocation: true });
  t.mock.restoreAll();
  assert.equal(needed.readerAllocation.status, 'scope-selection-required'); assert.equal(needed.readerAllocation.scopeIds.length, 33);
  assert.equal(progressReads, 0); assert.deepEqual(needed.readerAllocation.scopes, []);
  const { executeWorkflow } = await import('./workflow.mjs');
  const selected = await executeWorkflow('capture-status', { collectionId: f.collection.id, expectedConfigHash: digest(await fs.readFile(f.options.configPath)),
    args: { selection: f.selection, scopeId: state.explicitScopes[0].id } }, { configPath: f.options.configPath });
  assert.equal(selected.readerAllocation.scopes.length, 1); assert.equal(selected.readerAllocation.scopes[0].bytes.reserved, 0);
  await assert.rejects(captureSelectionStatus(f.capability, { selection: f.selection, scopeId: randomUUID() }), /UNKNOWN_CAPTURE_SCOPE/);
  const codex = await captureSelectionStatus(f.capability, { selection: { ...f.selection, client: 'codex' }, includeReaderAllocation: true });
  assert.equal(codex.readerAllocation.status, 'not-applicable'); assert(!Object.hasOwn(codex.readerAllocation, 'scopes'));
});

test('headroom isolates malformed saved progress while retaining healthy scopes and request refusals', async t => {
  const f = await claudeScopeFixture(t), state = structuredClone(f.chosen.state);
  const badScope = f.request.operationId, goodScope = randomUUID();
  state.explicitScopes.push({ ...state.explicitScopes[0], id: goodScope });
  const selectionHash = await withIntakeLock(f.store, tx => replaceIntakeJSON(tx, `sessions/claude/${S}.json`, state, f.chosen.hash));
  const progress = path.join(f.collection.intakeStateDir, 'progress/claude', S, `${badScope}.json`);
  await fs.mkdir(path.dirname(progress), { recursive: true, mode: 0o700 });
  const valid = { sourceIdentity: state.source.fileIdentity, offset: 0, anchor: null };
  const { executeWorkflow } = await import('./workflow.mjs');
  const request = { collectionId: f.collection.id, expectedConfigHash: digest(await fs.readFile(f.options.configPath)),
    args: { selection: f.selection, includeReaderAllocation: true } };
  const invoke = args => executeWorkflow('capture-status', { ...request, args: { ...request.args, ...args } }, { configPath: f.options.configPath });
  const checkpoint = { format: 'cuefluent-reader-checkpoint', version: 1, reader: 'claude-transcript/1',
    client: 'claude', sessionId: S, scopeId: badScope, sourceIdentity: valid.sourceIdentity, offset: 0, records: [], units: [] };
  const paged = { format: checkpoint.format, version: 2, reader: checkpoint.reader, client: checkpoint.client,
    sessionId: S, scopeId: badScope, sourceIdentity: valid.sourceIdentity, offset: 0, pages: [], recordCount: 0, unitCount: 0 };
  const inline = { ...checkpoint, offset: 1,
    records: [{ id: 'record', parentId: null, unitId: A, kind: 'human', startByte: 0, endByte: 1, hash: digest('x') }],
    units: [{ id: A, recordId: 'record', occurredAt: '2026-10-09T12:00:00.000Z' }] };
  for (const value of [[], { ...valid, PRIVATE: true }, { ...valid, sourceIdentity: digest('other source') },
    { ...valid, offset: -1 }, { ...valid, anchor: { startByte: 0, endByte: 1, hash: digest('anchor') } },
    ...[false, 0, '', [], { ...checkpoint, offset: 1 }, { ...checkpoint, PRIVATE: true },
      ...[checkpoint, paged].flatMap(root => ['sessionId', 'scopeId'].map(field => ({ ...root, [field]: 'invalid' })))
    ].map(checkpoint => ({ ...valid, checkpoint })),
    ...[{ ...inline, records: [{ ...inline.records[0], unitId: 'invalid' }] },
      { ...inline, units: [{ ...inline.units[0], id: 'invalid' }] }
    ].map(checkpoint => ({ ...valid, offset: 1, checkpoint }))]) {
    const bytes = JSON.stringify(value);
    await fs.writeFile(progress, bytes, { mode: 0o600 });
    const report = await invoke();
    assert.equal(report.hash, selectionHash); assert.equal(report.readerAllocation.status, 'partial');
    assert.deepEqual(report.readerAllocation.scopes[0], { scopeId: badScope, status: 'unavailable', error: 'INVALID_READER_PROGRESS' });
    assert.equal(report.readerAllocation.scopes[1].scopeId, goodScope);
    assert.equal(report.readerAllocation.scopes[1].status, 'ok');
    assert.equal(report.readerAllocation.scopes[1].bytes.reserved, 0);
    assert(!JSON.stringify(report).includes('PRIVATE'));
    assert.equal(await fs.readFile(progress, 'utf8'), bytes);
  }
  await assert.rejects(invoke({ includeReaderAllocation: 'yes' }), { code: 'INVALID_WORKFLOW' });
  await assert.rejects(invoke({ scopeId: randomUUID() }), { code: 'UNKNOWN_CAPTURE_SCOPE' });
  await assert.rejects(invoke({ scopeId: 'invalid' }), { code: 'UNSUPPORTED_NATIVE_IDENTITY' });
  await assert.rejects(invoke({ selection: { ...f.selection, cwd: path.dirname(f.project) } }), { code: 'SOURCE_IDENTITY_MISMATCH' });
});

test('capture-run preserves progress validation errors while status reports scope-local failures', async t => {
  const f = await claudeScopeFixture(t), scopeId = f.request.operationId;
  const progress = path.join(f.collection.intakeStateDir, 'progress/claude', S, `${scopeId}.json`);
  await fs.mkdir(path.dirname(progress), { recursive: true, mode: 0o700 });
  const valid = { sourceIdentity: f.chosen.state.source.fileIdentity, offset: 0, anchor: null };
  const { executeWorkflow } = await import('./workflow.mjs');
  const request = { collectionId: f.collection.id, expectedConfigHash: digest(await fs.readFile(f.options.configPath)) };
  const invoke = (command, args) => executeWorkflow(command, { ...request, args }, { configPath: f.options.configPath });
  for (const [name, value, code] of [
    ['array', [], 'INVALID_WORKFLOW'],
    ['extra key', { ...valid, PRIVATE: true }, 'INVALID_WORKFLOW'],
    ['source mismatch', { ...valid, sourceIdentity: digest('other source') }, 'SOURCE_IDENTITY_MISMATCH']
  ]) await t.test(name, async () => {
    const bytes = JSON.stringify(value);
    await fs.writeFile(progress, bytes, { mode: 0o600 });
    const status = await invoke('capture-status', { selection: f.selection, scopeId });
    assert.equal(status.hash, f.chosen.hash);
    assert.deepEqual(status.readerAllocation.scopes[0], { scopeId, status: 'unavailable', error: 'INVALID_READER_PROGRESS' });
    await assert.rejects(invoke('capture-run', { selection: f.selection, scopeId, expectedSelectionHash: f.chosen.hash, unitIds: [A] }), { code });
    for (const metadataOnly of [false, true]) {
      await assert.rejects(readReaderProgress(f.store, { client: 'claude', sessionId: S }, scopeId, valid.sourceIdentity, { metadataOnly }), { code });
    }
    assert.equal(await fs.readFile(progress, 'utf8'), bytes);
    assert.equal((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A })).head, null);
  });
});

test('routine status skips headroom reads and requested headroom propagates privacy, budget and unexpected failures', async t => {
  const f = await claudeScopeFixture(t);
  const progress = path.join(f.collection.intakeStateDir, 'progress/claude', S, `${f.request.operationId}.json`);
  await fs.mkdir(path.dirname(progress), { recursive: true, mode: 0o700 });
  await fs.writeFile(progress, JSON.stringify({ sourceIdentity: f.chosen.state.source.fileIdentity, offset: 0, anchor: null }), { mode: 0o600 });
  const counter = path.join(f.collection.intakeStateDir, 'reader-pages/claude', S, f.request.operationId, 'allocation.json');
  await fs.mkdir(path.dirname(counter), { recursive: true, mode: 0o700 });
  await fs.writeFile(counter, '{}', { mode: 0o600 });
  const lstat = fs.lstat; let headroomReads = 0;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (file.includes(`${path.sep}progress${path.sep}`) || file.endsWith('allocation.json')) headroomReads++;
    return lstat(file, ...args);
  });
  const { executeWorkflow } = await import('./workflow.mjs');
  const request = { collectionId: f.collection.id, expectedConfigHash: digest(await fs.readFile(f.options.configPath)), args: { selection: f.selection } };
  const routine = await executeWorkflow('capture-status', request, { configPath: f.options.configPath });
  assert.equal(routine.hash, f.chosen.hash); assert.equal(headroomReads, 0);
  assert(!Object.hasOwn(routine, 'readerAllocation'));
  t.mock.restoreAll();
  await assert.rejects(executeWorkflow('capture-status', { ...request, args: { ...request.args, includeReaderAllocation: 'yes' } },
    { configPath: f.options.configPath }), { code: 'INVALID_WORKFLOW' });
  const open = fs.open;
  for (const target of [progress, counter]) for (const failure of [
    ...['STORAGE_NOT_PRIVATE', 'PRIVATE_STORAGE_CHANGED', 'FILE_LINK_COUNT_INVALID', 'WORKER_TIME_BUDGET', 'WORKER_READ_BUDGET', 'INVALID_WORKFLOW', 'SOURCE_IDENTITY_MISMATCH', 'UNSUPPORTED_NATIVE_IDENTITY', 'UNEXPECTED_FAILURE'].map(code => Object.assign(new Error('Synthetic failure'), { code })),
    new TypeError('Synthetic programming error')
  ]) {
    t.mock.method(fs, 'open', async (file, ...args) => { if (file === target) throw failure; return open(file, ...args); });
    await assert.rejects(executeWorkflow('capture-status', { ...request, args: { ...request.args, includeReaderAllocation: true } },
      { configPath: f.options.configPath }), error => error === failure);
    t.mock.restoreAll();
  }
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === counter) throw Object.assign(new Error('PRIVATE OS details'), { code: 'EIO' });
    return open(file, ...args);
  });
  const partial = await captureSelectionStatus(f.capability, { selection: f.selection, includeReaderAllocation: true });
  assert.equal(partial.readerAllocation.status, 'partial');
  assert.equal(partial.readerAllocation.scopes[0].error, 'EIO');
  assert(!JSON.stringify(partial).includes('PRIVATE OS details'));
});

test('one-time capture with collection disabled reads the selected window and publishes only named native units', async t => {
  const f = await fixture(t, { version: '0.146.0' }), before = await fs.readdir(f.collection.intakeStateDir), reads = [];
  assert.equal((await previewExplicitCapture(f.capability, f.request, { observeRead: read => reads.push(read) })).status, 'selection-verified');
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
  assert(reads.filter(r => r.purpose === 'range').every(r => r.offset >= f.request.readRange.fromByte && r.offset + r.bytes <= f.request.readRange.endByte));
  const chosen = await selectExplicitCapture(f.capability, f.request);
  assert.equal(chosen.state.active, false);
  const args = { selection: f.selection, scopeId: f.request.operationId, expectedSelectionHash: chosen.hash, unitIds: [A] };
  const result = await runSelectedCapture(f.capability, args);
  assert.equal(result.saved, 1); assert.equal((await runSelectedCapture(f.capability, args)).saved, 0);
  const capture = (await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: A })).capture;
  assert.match(capture.evidence[0].text, /Alpha/); assert.equal(capture.reader.headerClientVersion, '0.146.0');
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).head, null);
  assert.equal(JSON.parse(await fs.readFile(f.options.configPath)).routes[0].collection.enabled, false);
});

test('an explicit capture chosen from an earlier read refuses a window whose records changed since', async t => {
  const f = await fixture(t), text = await fs.readFile(f.sourcePath, 'utf8'), lines = text.split('\n').slice(0, -1).map(line => line + '\n');
  // The window's first record is the selected turn's first; its last ends the read.
  const bounds = { start: digest(lines[1]), end: digest(lines.at(-1)) };
  // The last record is rewritten in place, at the same offsets.
  await fs.writeFile(f.sourcePath, text.slice(0, -lines.at(-1).length) + lines.at(-1).replace('00:00:00.000Z', '00:00:01.000Z'));
  await assert.rejects(selectExplicitCapture(f.capability, { ...f.request, bounds }), { code: 'SOURCE_ANCHOR_CONFLICT' });
  assert.equal((await readSelection(f.store, { client: 'codex', sessionId: S })).state, null);
  // With the bytes the window was chosen from, it is selected.
  await fs.writeFile(f.sourcePath, text);
  const chosen = await selectExplicitCapture(f.capability, { ...f.request, bounds });
  const scope = chosen.state.explicitScopes.find(item => item.id === f.request.operationId);
  assert.deepEqual([scope.start.hash, scope.end.hash], [bounds.start, bounds.end]);
});

test('each capture control enforces its budget and preserves selection for retry', async t => {
  const f = await fixture(t, { enabled: true });
  const expiredClock = () => { let ticks = 0; return { now: () => ticks++ === 0 ? 0 : 10000 }; };
  const control = { selection: f.selection, sourcePath: f.sourcePath, expectedSourceIdentity: f.request.expectedSourceIdentity,
    expectedSelectionHash: null, operationId: randomUUID(), operation: 'start' };
  for (const [operation, request] of [[controlCapture, control], [previewExplicitCapture, f.request], [selectExplicitCapture, f.request]]) {
    const reads = [];
    await assert.rejects(operation(f.capability, request, { ...expiredClock(), observeRead: read => reads.push(read) }),
      { code: 'WORKER_TIME_BUDGET' });
    assert.deepEqual(reads, []);
    assert.equal((await captureSelectionStatus(f.capability, { selection: f.selection })).state, null);
  }
  const chosen = await selectExplicitCapture(f.capability, f.request);
  const args = { selection: f.selection, scopeId: f.request.operationId, expectedSelectionHash: chosen.hash, unitIds: [A] };
  await assert.rejects(runSelectedCapture(f.capability, args, expiredClock()), { code: 'WORKER_TIME_BUDGET' });
  assert.equal((await captureSelectionStatus(f.capability, { selection: f.selection })).hash, chosen.hash);
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: A })).head, null);
  assert.equal((await runSelectedCapture(f.capability, args)).saved, 1);
});

test('explicit scope refuses proof JSON, stale state, missing IDs, wrong source identity and scope escalation', async t => {
  const f = await fixture(t);
  for (const request of [{ ...f.request, proof: {} }, { ...f.request, expectedSelectionHash: 'f'.repeat(64) },
    { ...f.request, expectedSourceIdentity: 'f'.repeat(64) }, { ...f.request, unitIds: [randomUUID()], kind: 'historical' }]) {
    await assert.rejects(selectExplicitCapture(f.capability, request));
  }
  assert.equal((await captureSelectionStatus(f.capability, { selection: f.selection })).state, null);
  const store = await openExplicitCaptureIntake(f.capability, f.selection, { scopeId: f.request.operationId, unitIds: [A] });
  await withIntakeLock(store, async tx => {
    await assert.rejects(assertIntakePrivacy(tx, { identity: f.selection, projectRoot: f.project, scopeId: randomUUID() }), /NOT_AUTHORIZED/);
    await assert.rejects(assertIntakePrivacy(tx, { identity: { ...f.selection, unitId: B }, projectRoot: f.project, scopeId: f.request.operationId }), /NOT_AUTHORIZED/);
    await assertIntakePrivacy(tx, { identity: f.selection, projectRoot: f.project, scopeId: f.request.operationId });
  });
});

test('future controls seek after EOF and exclude the first proven boundary; pause remains restrictive', async t => {
  const f = await fixture(t, { enabled: true });
  const control = { selection: f.selection, sourcePath: f.sourcePath, expectedSourceIdentity: f.request.expectedSourceIdentity,
    expectedSelectionHash: null, operationId: randomUUID(), operation: 'start' };
  let state = await controlCapture(f.capability, control);
  const floor = state.state.intervals[0].lower.eofByte, C = randomUUID(), D = randomUUID();
  await fs.appendFile(f.sourcePath, turn(C, 'Excluded boundary') + turn(D, 'Included future work'));
  const reads = [];
  const run = await runSelectedCapture(f.capability, { selection: f.selection, scopeId: state.state.intervals[0].id, expectedSelectionHash: state.hash }, { observeRead: read => reads.push(read) });
  assert.equal(run.saved, 1); assert(reads.filter(r => r.purpose === 'range').every(r => r.offset >= floor));
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: C })).head, null);
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: D })).head);
  state = await controlCapture(f.capability, { ...control, selection: { ...f.selection, unitId: D }, expectedSelectionHash: run.hash, operation: 'pause', operationId: randomUUID() });
  assert.equal(state.state.active, false); assert.equal(state.state.intervals[0].upper.unitId, D);
});

test('restrictive CLI controls remain available when capture privacy is unavailable and read no source text', async t => {
  const f = await fixture(t), { executeWorkflow } = await import('./workflow.mjs');
  const brokenWriter = f.collection.notes.writerStateDir;
  // Removing a required storage root prevents obtaining a capture capability.
  await fs.rm(brokenWriter, { recursive: true });
  await fs.writeFile(f.sourcePath, 'Malformed source content must not block an opt-out.');
  const current = await captureSelectionStatus(f.capability, { selection: f.selection }).catch(() => null);
  assert.equal(current, null);
  const result = await executeWorkflow('capture-control', { collectionId: f.collection.id,
    expectedConfigHash: digest(await fs.readFile(f.options.configPath)), args: { selection: f.selection,
      sourcePath: f.sourcePath, expectedSourceIdentity: f.request.expectedSourceIdentity, expectedSelectionHash: null,
      operationId: randomUUID(), operation: 'exclude' } }, { configPath: f.options.configPath });
  assert(result.state.exclusions.includes(A)); assert.equal(result.state.active, false);
});

test('Claude explicit historical window retains human evidence and never reads a later append', async t => {
  const f = await fixture(t), stamp = '2026-09-24T00:00:00.000Z';
  const human = (id, text, parentUuid) => ({ type: 'user', uuid: randomUUID(), timestamp: stamp, sessionId: S,
    version: '2.1.282', isSidechain: false, parentUuid, cwd: f.project, promptId: id, message: { role: 'user', content: text } });
  const a = human(A, 'Meeting: keep the rollout paused.', null), b = human(B, 'Unselected human input.', a.uuid);
  const prefix = JSON.stringify(a) + '\n', body = prefix + JSON.stringify(b) + '\n';
  await fs.writeFile(f.sourcePath, body);
  const selection = { ...f.selection, client: 'claude', unitId: null };
  const status = await captureSelectionStatus(f.capability, { selection, sourcePath: f.sourcePath });
  const request = { ...f.request, selection, kind: 'historical', expectedSourceIdentity: status.source.fileIdentity,
    readRange: { fromByte: 0, endByte: Buffer.byteLength(body) } };
  const chosen = await selectExplicitCapture(f.capability, request);
  await fs.appendFile(f.sourcePath, JSON.stringify(human(A, 'A later append outside the approved range.', b.uuid)) + '\n');
  const reads = [], result = await runSelectedCapture(f.capability, { selection, scopeId: request.operationId,
    expectedSelectionHash: chosen.hash, unitIds: [A] }, { observeRead: read => reads.push(read) });
  assert.equal(result.saved, 1);
  assert(reads.filter(read => read.purpose === 'range').every(read => read.offset + read.bytes <= request.readRange.endByte));
  const capture = (await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A })).capture;
  assert.equal(capture.reader.headerClientVersion, '2.1.282');
  assert.equal(capture.terminal, 'unconfirmed'); assert.equal(capture.evidence.length, 1); assert.match(capture.evidence[0].text, /rollout paused/);
  assert.equal((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: B })).head, null);
});

for (const client of ['codex', 'claude']) for (const checkpointed of (client === 'claude' ? [false, true] : [false])) {
  test(`${client}: pause after its native row preserves earlier eligible work${checkpointed ? ' from checkpoint anchors' : ''}`, async t => {
    const f = await fixture(t, { enabled: true }), P = randomUUID(), later = randomUUID();
    const stamp = '2026-09-24T00:00:00.000Z'; let parent = randomUUID();
    const human = (id, text) => { const uuid = randomUUID(), parentUuid = parent; parent = uuid;
      return JSON.stringify({ type: 'user', uuid, timestamp: stamp, sessionId: S, version: '2.1.280', isSidechain: false,
        parentUuid, cwd: f.project, promptId: id, message: { role: 'user', content: text } }) + '\n'; };
    const header = client === 'codex'
      ? row('session_meta', { id: S, session_id: S, cwd: f.project, cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' })
      : JSON.stringify({ type: 'system', subtype: 'init', uuid: parent, parentUuid: null, timestamp: stamp, sessionId: S, version: '2.1.280', isSidechain: false, cwd: f.project }) + '\n';
    await fs.writeFile(f.sourcePath, header);
    const selection = { ...f.selection, client, unitId: null }, initial = await captureSelectionStatus(f.capability, { selection, sourcePath: f.sourcePath });
    const control = { selection, sourcePath: f.sourcePath, expectedSourceIdentity: initial.source.fileIdentity,
      expectedSelectionHash: null, operationId: randomUUID(), operation: 'start' };
    const started = await controlCapture(f.capability, control), scopeId = started.state.intervals[0].id;
    await fs.appendFile(f.sourcePath, client === 'codex' ? turn(A, 'Boundary') + turn(B, 'Earlier eligible work') +
      row('event_msg', { type: 'task_started', turn_id: P }) + row('event_msg', { type: 'user_message', message: 'Pause now' })
      : human(A, 'Boundary') + human(B, 'Earlier eligible work') + human(P, 'Pause now'));
    let expectedSelectionHash = started.hash;
    if (checkpointed) expectedSelectionHash = (await runSelectedCapture(f.capability, { selection, scopeId, expectedSelectionHash })).hash;
    const { executeWorkflow } = await import('./workflow.mjs');
    const paused = await executeWorkflow('capture-control', { collectionId: f.collection.id, expectedConfigHash: digest(await fs.readFile(f.options.configPath)),
      args: { ...control, selection: { ...selection, unitId: P }, expectedSelectionHash, operationId: randomUUID(), operation: 'pause' } }, { configPath: f.options.configPath });
    assert.equal(paused.state.active, false); assert.equal(paused.state.intervals[0].upper.record, null);
    await fs.appendFile(f.sourcePath, client === 'codex' ? row('event_msg', { type: 'task_complete', turn_id: P }) + turn(later, 'After pause')
      : (checkpointed ? human(B, 'Late eligible human evidence') : '') + human(later, 'After pause'));
    const reads = [], result = await runSelectedCapture(f.capability, { selection, scopeId, expectedSelectionHash: paused.hash }, { observeRead: read => reads.push(read) });
    assert.equal(result.saved, checkpointed ? 0 : 1); assert.equal(result.pending, null);
    if (checkpointed) { assert.equal(result.suspended, true); assert.deepEqual(reads, []); }
    const upper = result.state.intervals[0].upper;
    assert(upper.record.startByte < upper.eofByte);
    assert(reads.filter(read => read.purpose === 'range').every(read => read.offset >= Buffer.byteLength(header)));
    const capture = (await readCaptureHead(f.store, { client, sessionId: S, unitId: B })).capture;
    assert.match(JSON.stringify(capture.evidence), /Earlier eligible work/);
    assert.doesNotMatch(JSON.stringify(capture.evidence), /Late eligible human evidence/);
    for (const unitId of [A, later, ...(checkpointed ? [] : [P])]) assert.equal((await readCaptureHead(f.store, { client, sessionId: S, unitId })).head, null);
  });
}

for (const event of ['task_complete', 'task_started']) test(`a delayed Codex ${event} cannot move a pause boundary past later turns`, async t => {
  const f = await fixture(t, { enabled: true }), P = randomUUID(), later = randomUUID();
  const header = row('session_meta', { id: S, session_id: S, cwd: f.project, cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' });
  await fs.writeFile(f.sourcePath, header);
  const selection = { ...f.selection, unitId: null }, status = await captureSelectionStatus(f.capability, { selection, sourcePath: f.sourcePath });
  const control = { selection, sourcePath: f.sourcePath, expectedSourceIdentity: status.source.fileIdentity,
    expectedSelectionHash: null, operationId: randomUUID(), operation: 'start' };
  const started = await controlCapture(f.capability, control), scopeId = started.state.intervals[0].id;
  await fs.appendFile(f.sourcePath, turn(A, 'Boundary') + turn(P, 'Completed before pause'));
  const first = await runSelectedCapture(f.capability, { selection, scopeId, expectedSelectionHash: started.hash });
  assert.equal(first.saved, 1);
  const paused = await controlCapture(f.capability, { ...control, selection: { ...selection, unitId: P },
    operationId: randomUUID(), operation: 'pause', expectedSelectionHash: first.hash });
  await fs.appendFile(f.sourcePath, turn(later, 'After pause') + row('event_msg', { type: event, turn_id: P }));
  const result = await runSelectedCapture(f.capability, { selection, scopeId, expectedSelectionHash: paused.hash });
  assert.equal(result.saved, 0); assert.equal(result.pending, 'anchor-unresolved');
  assert.equal(result.state.intervals[0].upper.record, null);
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: later })).head, null);
});

test('new Claude windows extend exact heads; covered overlapping windows advance without widening a new revision', async t => {
  const f = await fixture(t), stamp = '2026-09-24T00:00:00.000Z'; let parent = null;
  const human = text => { const uuid = randomUUID(), parentUuid = parent; parent = uuid;
    return JSON.stringify({ type: 'user', uuid, timestamp: stamp, sessionId: S, version: '2.1.280', isSidechain: false,
      parentUuid, cwd: f.project, promptId: A, message: { role: 'user', content: text } }) + '\n'; };
  const first = human('Initial selected human evidence.'); await fs.writeFile(f.sourcePath, first);
  const selection = { ...f.selection, client: 'claude', unitId: A };
  let selectionHash = null;
  const select = async (fromByte = 0, endByte = null) => {
    const status = await captureSelectionStatus(f.capability, { selection, sourcePath: f.sourcePath });
    const request = { selection, sourcePath: f.sourcePath, expectedSourceIdentity: status.source.fileIdentity,
      expectedSelectionHash: selectionHash, operationId: randomUUID(), kind: 'current', unitIds: [A],
      readRange: { fromByte, endByte: endByte ?? status.source.eofByte } };
    const selected = await selectExplicitCapture(f.capability, request); selectionHash = selected.hash;
    return request.operationId;
  };
  const run = async scopeId => {
    const result = await runSelectedCapture(f.capability, { selection, scopeId, expectedSelectionHash: selectionHash, unitIds: [A] });
    selectionHash = result.hash; return result;
  };
  const originalScope = await select(); assert.equal((await run(originalScope)).saved, 1);
  const original = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A });
  const overlappingScope = await select(); // Leave this earlier window unconsumed.
  await fs.appendFile(f.sourcePath, human('Later evidence for the same native prompt.'));
  const expanded = await select(); assert.equal((await run(expanded)).saved, 1);
  const revised = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A });
  assert.equal(revised.head.generation, 2); assert.equal(revised.capture.evidence.length, 2);
  assert.deepEqual(revised.capture.evidence[0], original.capture.evidence[0]);
  for (const scopeId of [originalScope, overlappingScope]) {
    const replay = await run(scopeId); assert.equal(replay.saved, 0); assert.equal(replay.pending, null);
    const progress = JSON.parse(await fs.readFile(path.join(f.collection.intakeStateDir, 'progress/claude', S, `${scopeId}.json`)));
    assert.equal(progress.offset, Buffer.byteLength(first));
  }
  const priorEnd = (await fs.stat(f.sourcePath)).size;
  await fs.appendFile(f.sourcePath, human('A narrow later-only window must not import the earlier snapshot.'));
  const narrow = await select(priorEnd), blocked = await run(narrow);
  assert.equal(blocked.saved, 0); assert.equal(blocked.pending, 'CAPTURE_REVISION_SCOPE_CONFLICT');
  assert.equal((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A })).hash, revised.hash);
  // Collection remains off; this explicit operation does not enable background capture.
  assert.equal(JSON.parse(await fs.readFile(f.options.configPath)).routes[0].collection.enabled, false);
});

test('public control retries retain the original floor after source append and native anchor resolution', async t => {
  const f = await fixture(t, { enabled: true });
  const start = { selection: f.selection, sourcePath: f.sourcePath, expectedSourceIdentity: f.request.expectedSourceIdentity,
    expectedSelectionHash: null, operationId: randomUUID(), operation: 'start' };
  const first = await controlCapture(f.capability, start), C = randomUUID(), D = randomUUID();
  await fs.appendFile(f.sourcePath, turn(C, 'Boundary') + turn(D, 'Selected future'));
  assert.deepEqual(await controlCapture(f.capability, start), first);
  const resolved = await runSelectedCapture(f.capability, { selection: f.selection, scopeId: first.state.intervals[0].id, expectedSelectionHash: first.hash });
  const replay = await controlCapture(f.capability, start);
  assert.equal(replay.hash, resolved.hash); assert.equal(replay.state.revision, first.state.revision);
  assert.equal(replay.state.intervals[0].lower.eofByte, first.state.intervals[0].lower.eofByte);
  assert.equal(replay.state.intervals[0].lower.unitId, C);
  for (const changed of [{ expectedSelectionHash: replay.hash }, { expectedSourceIdentity: 'f'.repeat(64) },
    { sourcePath: path.join(f.project, 'another.jsonl') }, { selection: { ...f.selection, unitId: D } }, { operation: 'resume' }]) {
    await assert.rejects(controlCapture(f.capability, { ...start, ...changed }), { code: 'SELECTION_REQUEST_CONFLICT' });
  }
  const { executeWorkflow } = await import('./workflow.mjs');
  const configHash = digest(JSON.stringify(f.config));
  const call = args => executeWorkflow('capture-control', { collectionId: f.collection.id,
    expectedConfigHash: configHash, args }, { configPath: f.options.configPath });
  const pause = { ...start, selection: { ...f.selection, unitId: D }, operationId: randomUUID(), operation: 'pause', expectedSelectionHash: replay.hash };
  const paused = await call(pause);
  await fs.appendFile(f.sourcePath, turn(randomUUID(), 'After pause'));
  assert.deepEqual(await call(pause), paused);
  await assert.rejects(controlCapture(f.capability, start), { code: 'STALE_SELECTION' });
  const resume = { ...start, operationId: randomUUID(), operation: 'resume', expectedSelectionHash: paused.hash };
  const resumed = await controlCapture(f.capability, resume);
  await fs.appendFile(f.sourcePath, turn(randomUUID(), 'After resume'));
  assert.deepEqual(await controlCapture(f.capability, resume), resumed);
  const exclude = { ...pause, operationId: randomUUID(), operation: 'exclude', expectedSelectionHash: resumed.hash };
  const excluded = await call(exclude);
  await fs.rm(f.collection.notes.writerStateDir, { recursive: true }); // Restrictive retries need no capture privacy grant.
  assert.deepEqual(await call(exclude), excluded);
  f.config.routes[0].processing.mode = 'prompted'; await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  await assert.rejects(call(exclude), { code: 'WORKFLOW_POLICY_CHANGED' });
});

for (const kind of ['current', 'historical']) test(`${kind} selection retries do not re-read or duplicate the original scope`, async t => {
  const f = await fixture(t), request = { ...f.request, kind };
  const first = await selectExplicitCapture(f.capability, request);
  await fs.appendFile(f.sourcePath, turn(randomUUID(), 'Later input outside selection'));
  const replay = await selectExplicitCapture(f.capability, request, { observeRead: () => assert.fail('Retry reread source evidence') });
  assert.deepEqual(replay, first); assert.equal(replay.state.explicitScopes.length, 1);
  for (const changed of [{ expectedSelectionHash: first.hash }, { expectedSourceIdentity: 'f'.repeat(64) },
    { readRange: { ...request.readRange, fromByte: request.readRange.fromByte + 1 } }, { unitIds: [B], kind: 'historical' }]) {
    await assert.rejects(selectExplicitCapture(f.capability, { ...request, ...changed }), { code: 'SELECTION_REQUEST_CONFLICT' });
  }
  f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  await assert.rejects(selectExplicitCapture(f.capability, request), { code: 'WORKFLOW_POLICY_CHANGED' });
});

test('an exact restrictive retry retains unresolved publication warnings without repairing state', async t => {
  const f = await fixture(t), { executeWorkflow } = await import('./workflow.mjs');
  const pending = path.join(f.collection.intakeStateDir, 'pending.json'), bytes = '{invalid retained intent';
  await fs.writeFile(pending, bytes, { mode: 0o600 });
  const request = { collectionId: f.collection.id, expectedConfigHash: digest(JSON.stringify(f.config)), args: {
    selection: f.selection, sourcePath: f.sourcePath, expectedSourceIdentity: f.request.expectedSourceIdentity,
    expectedSelectionHash: null, operationId: randomUUID(), operation: 'exclude' } };
  const first = await executeWorkflow('capture-control', request, { configPath: f.options.configPath });
  assert.equal(first.pendingWarning, 'INVALID_INTAKE_METADATA');
  assert.deepEqual(await executeWorkflow('capture-control', request, { configPath: f.options.configPath }), first);
  assert.equal(await fs.readFile(pending, 'utf8'), bytes);
});

test('capture controls normalize trailing separators and parent aliases without changing retry identity', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'project-parent-alias');
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const selection = { ...f.selection, cwd: path.join(alias, 'project') + path.sep };
  const request = { ...f.request, selection };
  assert.equal((await previewExplicitCapture(f.capability, request)).status, 'selection-verified');
  const chosen = await selectExplicitCapture(f.capability, request);
  assert.equal(chosen.state.source.projectRoot, f.project);
  assert.equal((await selectExplicitCapture(f.capability, request)).hash, chosen.hash);
  await assert.rejects(selectExplicitCapture(f.capability, { ...request, selection: f.selection }), /REQUEST_CONFLICT/);
  const status = await captureSelectionStatus(f.capability, { selection });
  assert.equal(status.hash, chosen.hash);
  const result = await runSelectedCapture(f.capability, { selection, scopeId: request.operationId, expectedSelectionHash: chosen.hash, unitIds: [A] });
  assert.equal(result.saved, 1);
});

test('a new restrictive selection requires an existing project and leaves no state on a typo', async t => {
  const f = await fixture(t), { restrictCapture } = await import('./capture-controls.mjs');
  const selection = { ...f.selection, cwd: path.join(f.project, 'missing') };
  await assert.rejects(restrictCapture({ ...f.options, expectedConfigHash: digest(await fs.readFile(f.options.configPath)) }, { selection, sourcePath: f.sourcePath,
    expectedSourceIdentity: f.request.expectedSourceIdentity, expectedSelectionHash: null,
    operationId: randomUUID(), operation: 'pause' }), /WORKFLOW_PATH_MISSING/);
  assert.equal((await captureSelectionStatus(f.capability, { selection: f.selection })).state, null);
});

test('a project directory symlink resolves to the stored capture identity', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'project-link');
  await fs.symlink(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const selection = { ...f.selection, cwd: alias }, request = { ...f.request, selection };
  assert.equal((await previewExplicitCapture(f.capability, request)).status, 'selection-verified');
  const chosen = await selectExplicitCapture(f.capability, request);
  assert.equal(chosen.state.source.projectRoot, f.project);
  assert.equal((await runSelectedCapture(f.capability, { selection, scopeId: request.operationId, expectedSelectionHash: chosen.hash, unitIds: [A] })).saved, 1);
});

for (const type of ['progress', 'file-history-snapshot', 'summary', 'last-prompt']) {
  test(`Claude explicit window can end on excluded ${type} without capturing it`, async t => {
    const f = await fixture(t), human = { type: 'user', uuid: randomUUID(), timestamp: '2026-09-24T00:00:00.000Z',
      sessionId: S, version: '2.1.280', isSidechain: false, parentUuid: null, cwd: f.project, promptId: A,
      message: { role: 'user', content: 'Meeting: record the decision.' } };
    const body = JSON.stringify(human) + '\n' + JSON.stringify({ type, sessionId: S, content: 'EXCLUDED METADATA' }) + '\n';
    await fs.writeFile(f.sourcePath, body);
    const selection = { ...f.selection, client: 'claude', unitId: null };
    const status = await captureSelectionStatus(f.capability, { selection, sourcePath: f.sourcePath });
    const request = { ...f.request, selection, kind: 'historical', expectedSourceIdentity: status.source.fileIdentity,
      readRange: { fromByte: 0, endByte: Buffer.byteLength(body) } };
    assert.equal((await previewExplicitCapture(f.capability, request)).status, 'selection-verified');
    const chosen = await selectExplicitCapture(f.capability, request);
    assert.equal(chosen.state.explicitScopes[0].end.endByte, Buffer.byteLength(body));
    const result = await runSelectedCapture(f.capability, { selection, scopeId: request.operationId, expectedSelectionHash: chosen.hash, unitIds: [A] });
    assert.equal(result.saved, 1);
    const capture = (await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: A })).capture;
    assert.equal(capture.evidence.length, 1); assert.doesNotMatch(JSON.stringify(capture.evidence), /EXCLUDED METADATA/);
  });
}
