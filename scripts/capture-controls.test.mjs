import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { digest } from './workflow-values.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { openWorkflowIntake, openExplicitCaptureIntake, withIntakeLock, assertIntakePrivacy } from './intake-io.mjs';
import { readCaptureHead } from './intake-store.mjs';
import { captureSelectionStatus, controlCapture, previewExplicitCapture, selectExplicitCapture, runSelectedCapture } from './capture-controls.mjs';
const S = '10000000-0000-4000-8000-000000000001';
const A = '20000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const row = (type, payload) => JSON.stringify({ timestamp: '2026-09-24T00:00:00.000Z', type, payload }) + '\n';
const turn = (id, text) => row('event_msg', { type: 'task_started', turn_id: id }) + row('event_msg', { type: 'user_message', message: text }) + row('event_msg', { type: 'task_complete', turn_id: id });
async function fixture(t, { enabled = false } = {}) {
  const f = await storageFixture(t), sourcePath = path.join(f.project, 'session.jsonl');
  f.config.routes[0].collection.enabled = enabled;
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  const header = row('session_meta', { id: S, session_id: S, cwd: f.project, cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' });
  await fs.writeFile(sourcePath, header + turn(A, 'Meeting: decision Alpha') + turn(B, 'Task: unrelated Beta'));
  const selection = { client: 'codex', sessionId: S, cwd: f.project, unitId: A };
  const status = await captureSelectionStatus(capability, { selection, sourcePath });
  const request = { selection, sourcePath, expectedSourceIdentity: status.source.fileIdentity, expectedSelectionHash: null,
    operationId: randomUUID(), kind: 'current', unitIds: [A], readRange: { fromByte: Buffer.byteLength(header), endByte: status.source.eofByte } };
  return { ...f, capability, sourcePath, selection, request, store: await openWorkflowIntake(capability) };
}

test('one-time capture with collection disabled reads the selected window and publishes only named native units', async t => {
  const f = await fixture(t), before = await fs.readdir(f.collection.intakeStateDir), reads = [];
  assert.equal((await previewExplicitCapture(f.capability, f.request, { observeRead: read => reads.push(read) })).status, 'selection-verified');
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
  assert(reads.filter(r => r.purpose === 'range').every(r => r.offset >= f.request.readRange.fromByte && r.offset + r.bytes <= f.request.readRange.endByte));
  const chosen = await selectExplicitCapture(f.capability, f.request);
  assert.equal(chosen.state.active, false);
  const args = { selection: f.selection, scopeId: f.request.operationId, expectedSelectionHash: chosen.hash, unitIds: [A] };
  const result = await runSelectedCapture(f.capability, args);
  assert.equal(result.saved, 1); assert.equal((await runSelectedCapture(f.capability, args)).saved, 0);
  assert.match((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: A })).capture.evidence[0].text, /Alpha/);
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).head, null);
  assert.equal(JSON.parse(await fs.readFile(f.options.configPath)).routes[0].collection.enabled, false);
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
    version: '2.1.280', isSidechain: false, parentUuid, cwd: f.project, promptId: id, message: { role: 'user', content: text } });
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
