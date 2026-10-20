import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { collectionIngress, snapshotSourceMetadata, registrationPath, READER_SUSPENSION_VERSION } from './collection-ingress.mjs';
import { runCollectionWorker } from './test-support/capture-workflow.mjs';
import { readerBlockOf } from './collection-worker.mjs';
import { inspectIntakeStore, intakeSnapshot, intakeJSON, withIntakeLock, openWorkflowIntake } from './intake-io.mjs';
import { readSelection, readCaptureHead, controlSelection, publishCapture, inspectPendingPublication, recoverPendingPublication } from './intake-store.mjs';
import { codexRegistrationHeader, readCodexSelection, codexPublicationPlan, codexCheckpoint, CODEX_READER_VERSION } from './codex-reader.mjs';
import { inspectSourceBoundary } from './capture-selection.mjs';
import { randomUUID } from 'node:crypto';
import { withWorkflowBudget, consumeWorkflowBytes, workflowTimeout } from './workflow-budget.mjs';
import { collectionHookOutput } from './collection-hooks.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { createCapture, serializeCapture } from './capture-contract.mjs';

const S = '10000000-0000-4000-8000-000000000001';
const A = '20000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const stamp = '2026-09-24T00:00:00.000Z';
const row = (type, payload) => JSON.stringify({ timestamp: stamp, type, payload }) + '\n';
const turn = (id, text) => row('event_msg', { type: 'task_started', turn_id: id }) +
  (text ? row('event_msg', { type: 'user_message', message: text }) : '') + row('event_msg', { type: 'task_complete', turn_id: id });
async function fixture(t, { version = '0.156.1', headerChanges = {} } = {}) {
  const f = await storageFixture(t, { privateConfig: true }), source = path.join(f.project, 'session.jsonl');
  await fs.writeFile(source, row('session_meta', { id: S, session_id: S, cwd: f.project, cli_version: version, source: 'cli', history_mode: 'legacy', ...headerChanges }));
  const payload = { session_id: S, turn_id: A, cwd: f.project, transcript_path: source, hook_event_name: 'UserPromptSubmit', prompt: 'Not persisted by ingress' };
  const options = { configPath: f.options.configPath, launch: async () => {} };
  const run = extra => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id, ...extra });
  return { ...f, source, payload, options, run, store: await inspectIntakeStore(f.collection) };
}

test('shared budget covers repeated reads and native probe deadlines', async () => {
  let now = 0;
  await withWorkflowBudget({ milliseconds: 10, bytes: 8, now: () => now }, async () => {
    consumeWorkflowBytes(5); assert.throws(() => consumeWorkflowBytes(4), { code: 'WORKER_READ_BUDGET' });
    assert.equal(workflowTimeout(1000), 10); now = 10;
    assert.throws(() => workflowTimeout(), { code: 'WORKER_TIME_BUDGET' });
  });
});

test('unconfigured and excluded ingress do not touch source or create storage', async t => {
  const f = await fixture(t); await fs.rm(f.source); const before = await fs.readdir(f.collection.intakeStateDir);
  for (const config of [{ format: 'cuefluent-workflow', schemaVersion: 1, collections: [], routes: [] },
    { ...f.config, routes: f.config.routes.map(r => ({ ...r, excluded: true })) }]) {
    await fs.writeFile(f.options.configPath, JSON.stringify(config));
    const result = await collectionIngress('codex', f.payload, { ...f.options, launch: () => assert.fail('must not launch') });
    assert(['unconfigured', 'excluded'].includes(result.status));
    assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
  }
});

test('capture mode Manual records only the metadata-only session start, so typed commands can verify the chat', async t => {
  const f = await fixture(t);
  f.config.routes[0].collection = { enabled: false }; f.config.routes[0].processing = { mode: 'manual' };
  await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  const result = await collectionIngress('codex', f.payload, { ...f.options, launch: () => assert.fail('must not launch') });
  assert.equal(result.status, 'manual');
  // Nothing runs on its own, so the hook adds nothing to the chat.
  assert.equal(collectionHookOutput(result, 'UserPromptSubmit'), null);
  // A session start, not a selection: nothing is armed or captured.
  assert.equal((await readSelection(f.store, { client: 'codex', sessionId: S })).state, null);
  const files = (await fs.readdir(f.collection.intakeStateDir, { recursive: true })).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(f.collection.intakeStateDir, files[0]), 'utf8'));
  assert.equal(saved.format, 'cuefluent-processing-source');
  assert.deepEqual(Object.keys(saved.snapshot).sort(), ['eofByte', 'fileIdentity', 'path']);
  assert.deepEqual(await fs.readdir(f.collection.rawDir), []);
});

test('capture mode Manual stays silent when private storage is not available yet', async t => {
  const f = await fixture(t);
  f.config.routes[0].collection = { enabled: false }; f.config.routes[0].processing = { mode: 'manual' };
  await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  // For example before storage preparation: the hook neither fails nor creates storage.
  await fs.rm(f.collection.intakeStateDir, { recursive: true, force: true });
  const result = await collectionIngress('codex', f.payload, { ...f.options, launch: () => assert.fail('must not launch') });
  assert.deepEqual(result, { status: 'manual', context: null });
  assert.equal(collectionHookOutput(result, 'UserPromptSubmit'), null);
  await assert.rejects(fs.stat(f.collection.intakeStateDir), { code: 'ENOENT' });
});

test('processing-only and paused notices expose a fresh blocked intake without a stored diagnostic', async t => {
  for (const kind of ['processing-only', 'paused']) {
    const f = await fixture(t);
    if (kind === 'processing-only') {
      f.config.routes[0].collection.enabled = false; f.config.routes[0].processing.mode = 'prompted';
      await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
    } else {
      await collectionIngress('codex', f.payload, f.options); await fs.appendFile(f.source, turn(A, 'Boundary')); await f.run();
      const selected = await readSelection(f.store, { client: 'codex', sessionId: S });
      await withIntakeLock(f.store, tx => controlSelection(tx, { source: selected.state.source, expectedHash: selected.hash,
        request: { id: randomUUID(), client: 'codex', sessionId: S, operation: 'pause', unitId: A, expectedRevision: selected.state.revision },
        boundary: selected.state.intervals[0].lower, authorize: async () => true }));
      await fs.rm(path.join(f.collection.intakeStateDir, 'ingress/status/record.json'), { force: true });
    }
    await fs.mkdir(path.join(f.collection.intakeStateDir, '.intake-lock'));
    const result = await collectionIngress('codex', f.payload, { ...f.options, launch: () => assert.fail('must not launch') });
    assert.equal(result.status, kind); assert.equal(result.intakeBlocked, true);
    assert.match(collectionHookOutput(result, 'UserPromptSubmit').hookSpecificOutput.additionalContext, /intake busy or blocked/);
  }
});

test('frozen ingress EOF excludes its boundary turn and collects the next complete turn', async t => {
  const f = await fixture(t, { version: '0.155.0-alpha.16.4' }), before = await snapshotSourceMetadata(f.source);
  assert.equal((await collectionIngress('codex', f.payload, f.options)).status, 'queued');
  await fs.appendFile(f.source, turn(A, 'Excluded boundary') + turn(B, 'Decision: ship the synthetic fixture.'));
  const outcome = await f.run();
  assert.deepEqual(outcome.pending, []); assert.equal(outcome.saved, 1);
  const selected = await readSelection(f.store, { client: 'codex', sessionId: S });
  assert.equal(selected.state.intervals[0].lower.eofByte, before.eofByte);
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: A })).head, null);
  const head = await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B });
  assert.equal(head.capture.reader.headerClientVersion, '0.155.0-alpha.16.4');
  assert.match(head.capture.evidence[0].text, /Decision/);
  assert.equal((await f.run()).saved, 0);
});

test('delayed agent-created registration preserves its grant and original floor across repeated hooks', async t => {
  const f = await fixture(t, { headerChanges: { thread_source: 'agent_created_thread', source: 'vscode' } });
  const old = randomUUID(); await fs.appendFile(f.source, turn(old, 'Pre-grant history must stay excluded.'));
  await collectionIngress('codex', f.payload, f.options);
  const registration = await intakeSnapshot(f.store, 'state', registrationPath({ client: 'codex', sessionId: S }));
  assert.equal((await readSelection(f.store, { client: 'codex', sessionId: S })).state, null);
  await fs.appendFile(f.source, turn(A, 'Excluded boundary') + turn(B, 'Decision: retain delayed eligible work.'));
  await collectionIngress('codex', { ...f.payload, turn_id: B }, f.options);
  assert.equal((await intakeSnapshot(f.store, 'state', registrationPath({ client: 'codex', sessionId: S }))).hash, registration.hash);
  const reads = [], result = await f.run({ observeRead: item => reads.push(item) });
  assert.deepEqual(result.pending, []); assert.equal(result.saved, 1);
  const selected = await readSelection(f.store, { client: 'codex', sessionId: S }), record = intakeJSON(registration);
  assert.equal(selected.state.intervals[0].lower.eofByte, record.snapshot.eofByte);
  assert.equal(selected.state.source.fileIdentity, record.snapshot.fileIdentity);
  assert.equal(selected.state.lastRequest.id, record.id);
  assert.equal(selected.state.currentGrantHash, record.grantHash);
  assert.equal(selected.state.intervals[0].grantHash, record.grantHash);
  assert(reads.some(item => item.purpose === 'range'));
  assert(reads.filter(item => item.purpose === 'range').every(item => item.offset >= record.snapshot.eofByte));
  for (const unitId of [old, A]) assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId })).head, null);
  assert.match((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).capture.evidence[0].text, /delayed eligible work/);
  assert.equal((await f.run()).saved, 0);
});

test('agent-created SessionStart excludes the creating agent seed before collecting later human work', async t => {
  for (const history_mode of ['legacy', 'paginated']) await t.test(history_mode, async t => {
    const f = await fixture(t, { headerChanges: { thread_source: 'agent_created_thread', source: 'vscode', history_mode } });
    let ordinal = 0;
    const append = async rows => fs.appendFile(f.source, rows.map(value => JSON.stringify({ timestamp: stamp, ...value, ordinal: ordinal++ }) + '\n').join(''));
    const header = JSON.parse(await fs.readFile(f.source, 'utf8')); header.ordinal = ordinal++;
    await fs.writeFile(f.source, JSON.stringify(header) + '\n');
    const { turn_id: _turn, prompt: _prompt, ...start } = f.payload;
    await collectionIngress('codex', { ...start, hook_event_name: 'SessionStart', source: 'startup' }, f.options);
    const registration = intakeJSON(await intakeSnapshot(f.store, 'state', registrationPath({ client: 'codex', sessionId: S })));
    assert.equal(registration.event, 'SessionStart'); assert.equal(registration.unitId, null);
    assert((await f.run()).pending.includes('NATIVE_BOUNDARY_PENDING'));
    const records = (id, text) => [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: id, root_turn_id: id } },
      history_mode === 'legacy' ? { type: 'event_msg', payload: { type: 'user_message', message: text } }
        : { type: 'event_msg', payload: { type: 'item_completed', thread_id: S, turn_id: id,
          item: { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text }] } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } }
    ];
    await append(records(A, 'Agent-authored seed: proposed decision, not human evidence.'));
    const armed = await f.run(); assert.equal(armed.saved, 0); assert.deepEqual(armed.pending, []);
    assert(armed.boundaryExcluded.some(value => value.unitId === A));
    assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: A })).head, null);
    await append(records(B, 'Human correction: keep the synthetic rollout paused.'));
    assert.equal((await f.run()).saved, 1);
    const capture = (await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).capture;
    assert.deepEqual(capture.evidence.map(value => value.text), ['Human correction: keep the synthetic rollout paused.']);
    assert.equal((await readSelection(f.store, { client: 'codex', sessionId: S })).state.intervals[0].lower.eofByte, registration.snapshot.eofByte);
    assert.equal((await f.run()).saved, 0);
  });
});

for (const held of [false, true]) test(`v1 Codex progress and published units continue under the current reader with held cursor=${held}`, async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary')); await f.run();
  const selection = await readSelection(f.store, { client: 'codex', sessionId: S }), scopeId = selection.state.intervals[0].id;
  const progress = await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${scopeId}.json`);
  const { checkpoint, ...cursor } = intakeJSON(progress);
  assert.equal(checkpoint.reader, 'codex-rollout/1');
  const C = randomUUID(), D = randomUUID(), output = 'x'.repeat(32768);
  const failingEarlier = row('event_msg', { type: 'task_started', turn_id: B }) +
    row('event_msg', { type: 'user_message', message: 'Earlier unit.' }) +
    row('event_msg', { type: 'task_complete', turn_id: B, last_agent_message: 'x'.repeat(70000) });
  await fs.appendFile(f.source, (held ? failingEarlier : '') + row('event_msg', { type: 'task_started', turn_id: C }) +
    row('event_msg', { type: 'user_message', message: 'Saved old source.' }) +
    row('response_item', { type: 'function_call', id: randomUUID(), name: 'exec_command', call_id: 'old', arguments: '{}' }) +
    row('response_item', { type: 'function_call_output', id: randomUUID(), call_id: 'old', output }) +
    row('event_msg', { type: 'task_complete', turn_id: C }));
  const extracted = await readCodexSelection({ state: selection.state, scopeId, cursor, checkpoint });
  const candidate = extracted.candidates.find(item => item.capture.identity.unitId === C);
  const old = createCapture({ ...candidate.capture, reader: { ...candidate.capture.reader, version: '1' },
    coverage: { partial: false, omissions: [] }, evidence: candidate.capture.evidence.map(item => item.kind === 'tool-result' ? { ...item, text: output } : item) });
  const plan = codexPublicationPlan(extracted, C);
  const store = await openWorkflowIntake(f.capability, { client: 'codex', sessionId: S, cwd: f.project }, 'collect');
  const saved = await withIntakeLock(store, tx => publishCapture(tx, { ...candidate, capture: old,
    selectionHash: selection.hash, cursorHash: progress.hash, scan: plan.scan,
    checkpoint: codexCheckpoint(extracted, plan.scan.to.offset), authorize: async () => true }));
  await fs.appendFile(f.source, turn(D, 'New future evidence.'));
  const run = await f.run();
  assert.equal(run.saved, 1);
  assert(!run.pending.includes('READER_CHECKPOINT_CONFLICT')); assert(!run.pending.includes('FINAL_CAPTURE_CONFLICT'));
  if (held) assert(run.pending.includes('SOURCE_ANCHOR_LIMIT'));
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: D })).capture.reader.version, CODEX_READER_VERSION);
  const retained = await readCaptureHead(f.store, old.identity);
  assert.equal(retained.hash, saved.headHash); assert.deepEqual(serializeCapture(retained.capture), serializeCapture(old));
  assert.equal((await f.run()).saved, 0);
});

test('duplicate notifications preserve registration floor and failed launch preserves work', async t => {
  const f = await fixture(t);
  await Promise.all([collectionIngress('codex', f.payload, f.options), collectionIngress('codex', f.payload, f.options)]);
  const first = await intakeSnapshot(f.store, 'state', registrationPath({ client: 'codex', sessionId: S }));
  await fs.appendFile(f.source, turn(A, 'Boundary'));
  const failed = await collectionIngress('codex', { ...f.payload, turn_id: B }, { ...f.options, launch: async () => { throw new Error('spawn'); } });
  assert.equal(failed.status, 'worker-launch-failed');
  assert.equal((await intakeSnapshot(f.store, 'state', registrationPath({ client: 'codex', sessionId: S }))).hash, first.hash);
});

test('missing source remains pending without inventing zero or reading old history', async t => {
  const f = await fixture(t); await fs.rm(f.source);
  assert.equal((await collectionIngress('codex', f.payload, f.options)).status, 'pending-source');
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', registrationPath({ client: 'codex', sessionId: S }))).snapshot, null);
  assert((await f.run()).pending.includes('SOURCE_BOUNDARY_PENDING'));
});

test('excluded-only completed prefixes advance without manufacturing captures', async t => {
  const f = await fixture(t);
  await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, null));
  const result = await f.run(); assert.equal(result.saved, 0); assert.deepEqual(result.pending, []);
  const selection = await readSelection(f.store, { client: 'codex', sessionId: S });
  const progress = intakeJSON(await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${selection.state.intervals[0].id}.json`));
  assert.equal(progress.offset, (await fs.stat(f.source)).size);
  assert.deepEqual(await fs.readdir(f.collection.rawDir), []);
});

test('privacy failure stops worker before malformed source can be interpreted', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.writeFile(f.source, 'invalid source'); await fs.chmod(f.collection.rawDir, 0o755);
  const result = await f.run(); assert.deepEqual(result.pending, ['STORAGE_NOT_PRIVATE']);
  assert.deepEqual(await fs.readdir(f.collection.rawDir), []);
});

test('ingress never opens a transcript and a 50 MiB historical prefix is not scanned', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.source, 'private historical bytes'.padEnd(50 * 1024 * 1024, 'x') + '\n');
  const boundary = (await fs.stat(f.source)).size, open = fs.open;
  fs.open = async (file, ...args) => { assert.notEqual(file, f.source, 'synchronous ingress opened source'); return open(file, ...args); };
  try { await collectionIngress('codex', f.payload, f.options); } finally { fs.open = open; }
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Allowed new decision'));
  const reads = [], result = await f.run({ observeRead: item => reads.push(item) });
  assert.deepEqual(result.pending, []); assert.equal(result.saved, 1);
  assert(reads.some(item => item.purpose === 'range'));
  assert(reads.filter(item => item.purpose === 'range').every(item => item.offset >= boundary));
  assert(reads.filter(item => item.purpose === 'range').reduce((sum, item) => sum + item.bytes, 0) < 10000);
});

test('resume, compact, clear and startup notifications never rearm a paused selection', async t => {
  const f = await fixture(t);
  await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Captured'));
  await f.run();
  const selected = await readSelection(f.store, { client: 'codex', sessionId: S });
  await withIntakeLock(f.store, async tx => controlSelection(tx, { source: selected.state.source, expectedHash: selected.hash,
    request: { id: randomUUID(), client: 'codex', sessionId: S, operation: 'pause', unitId: B, expectedRevision: selected.state.revision },
    boundary: { sourceIdentity: selected.state.source.fileIdentity, eofByte: (await fs.stat(f.source)).size, startsMidRecord: false, unitId: B, record: null } }));
  for (const source of ['resume', 'compact', 'clear', 'startup']) {
    await collectionIngress('codex', { ...f.payload, hook_event_name: 'SessionStart', source }, f.options);
    assert((await f.run()).pending.includes('COLLECTION_PAUSED'));
    assert.equal((await readSelection(f.store, { client: 'codex', sessionId: S })).state.active, false);
  }
});

test('an initially missing source freezes its first verified EOF across later notifications', async t => {
  const f = await fixture(t), header = await fs.readFile(f.source); await fs.rm(f.source);
  await collectionIngress('codex', f.payload, f.options);
  await fs.writeFile(f.source, header); await collectionIngress('codex', f.payload, f.options);
  assert((await f.run()).pending.includes('NATIVE_BOUNDARY_PENDING'));
  const floorPath = `registration-floors/codex/${S}.json`, floor = intakeJSON(await intakeSnapshot(f.store, 'state', floorPath));
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'New evidence'));
  await collectionIngress('codex', { ...f.payload, turn_id: B, hook_event_name: 'Stop', stop_hook_active: false }, f.options);
  assert.equal((await f.run()).saved, 1);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', floorPath)).snapshot.eofByte, floor.snapshot.eofByte);
});

test('a later Codex event for an already captured unit blocks advancement for review', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Captured')); await f.run();
  await fs.appendFile(f.source, row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Unexpected late output' }],
    internal_chat_message_metadata_passthrough: { turn_id: B } }));
  assert((await f.run()).pending.includes('LATE_NATIVE_EVIDENCE_REQUIRES_REVIEW'));
});

test('Claude collection preserves its human-only, unconfirmed snapshot boundary', async t => {
  const f = await fixture(t); let previous = null;
  const message = (type, content, extra = {}) => {
    const value = { type, uuid: randomUUID(), parentUuid: previous, timestamp: stamp, sessionId: S, version: '2.1.280',
      isSidechain: false, cwd: f.project, message: { role: type, content }, ...extra }; previous = value.uuid; return JSON.stringify(value) + '\n';
  };
  await fs.writeFile(f.source, message('system', '', { subtype: 'init' }));
  await collectionIngress('claude', { ...f.payload, prompt_id: A }, f.options);
  await fs.appendFile(f.source, message('user', 'Boundary', { promptId: A }) + message('user', 'Meeting decision', { promptId: B }) + message('assistant', 'Unowned assistant output'));
  const result = await f.run(); assert.deepEqual(result.pending, []); assert.equal(result.saved, 1);
  const head = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: B });
  assert.equal(head.capture.terminal, 'unconfirmed'); assert.deepEqual(head.capture.evidence.map(item => item.text), ['Meeting decision']);
  // B remains in the checkpoint but is not a baseline for the next prompt.
  // Eagerly preloading checkpoint heads would reopen this unrelated old head.
  await fs.writeFile(path.join(f.collection.intakeStateDir, 'heads', 'claude', S, `${B}.json`), '{invalid unrelated head', { mode: 0o600 });
  await fs.appendFile(f.source, message('user', 'Next decision', { promptId: randomUUID() }));
  const next = await f.run(); assert.deepEqual(next.pending, []); assert.equal(next.saved, 1);
});

test('Claude collection keeps typed skill arguments without markup and passes markup-only input', async t => {
  const f = await fixture(t); let previous = null;
  const message = (type, content, extra = {}) => {
    const value = { type, uuid: randomUUID(), parentUuid: previous, timestamp: stamp, sessionId: S, version: '2.1.280',
      isSidechain: false, cwd: f.project, message: { role: type, content }, ...extra }; previous = value.uuid; return JSON.stringify(value) + '\n';
  };
  const command = 'cuefluent-notes:cuefluent-notes', envelope = args =>
    `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${args}</command-args>`;
  const C = randomUUID(), D = randomUUID();
  await fs.writeFile(f.source, message('system', '', { subtype: 'init' }));
  await collectionIngress('claude', { ...f.payload, prompt_id: A }, f.options);
  await fs.appendFile(f.source, message('user', 'Boundary', { promptId: A }) + message('user', envelope('review sav t7xb88 and tag it'), { promptId: B }) +
    message('user', envelope(''), { promptId: C }) + message('user', 'Next decision', { promptId: D }));
  const result = await f.run(); assert.deepEqual(result.pending, []); assert.equal(result.saved, 2);
  const typed = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: B });
  assert.deepEqual(typed.capture.evidence.map(item => item.text), ['review sav t7xb88 and tag it']); assert.equal(typed.capture.reader.version, '2');
  assert.equal((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: C })).head, null);
  assert.deepEqual((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: D })).capture.evidence.map(item => item.text), ['Next decision']);
  assert.equal((await f.run()).saved, 0);
});

test('a new session wakes older durable work after the launching parent exits', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Catch-up decision'));
  const { spawnSync } = await import('node:child_process');
  const entry = new URL('./collection-ingress.mjs', import.meta.url).href;
  const newer = { ...f.payload, session_id: '10000000-0000-4000-8000-000000000002',
    hook_event_name: 'SessionStart', source: 'startup', transcript_path: path.join(f.project, 'not-created.jsonl') };
  const code = `const m=await import(${JSON.stringify(entry)}); await m.collectionIngress('codex',${JSON.stringify(newer)},{configPath:${JSON.stringify(f.options.configPath)}});`;
  const launched = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 4000 });
  assert.equal(launched.status, 0, launched.stderr);
  const deadline = Date.now() + 15000;
  let status;
  do {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = intakeJSON(await intakeSnapshot(f.store, 'state', 'ingress/status/record.json', { maxBytes: 16384 }));
  } while (!status && Date.now() < deadline);
  assert(status, 'detached worker did not report completion');
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).capture.evidence[0].text, 'Catch-up decision');
  assert(status.pending.includes('SOURCE_BOUNDARY_PENDING'));
  assert.equal((await f.run()).saved, 0);
});

test('a blocked intake emits a notice and retains notifications without spawning', async t => {
  const f = await fixture(t);
  await withIntakeLock(f.store, async () => {
    const result = await collectionIngress('codex', f.payload, { ...f.options, launch: () => assert.fail('blocked intake must not spawn') });
    assert.equal(result.status, 'intake-blocked');
    const { collectionHookOutput } = await import('./collection-hooks.mjs');
    assert.match(collectionHookOutput(result, 'UserPromptSubmit').hookSpecificOutput.additionalContext, /intake busy or blocked/);
    assert((await intakeSnapshot(f.store, 'state', `ingress/wake/codex/${S}.json`)).bytes);
  });
});

test('replaced sources and truncated registration floors never become capture authority', async t => {
  for (const kind of ['replace', 'truncate']) {
    const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
    if (kind === 'replace') { await fs.rename(f.source, f.source + '.old'); await fs.writeFile(f.source, await fs.readFile(f.source + '.old')); }
    else await fs.truncate(f.source, 0);
    const reads = [], result = await f.run({ observeRead: event => reads.push(event) });
    assert.equal(result.saved, 0); assert(result.pending.length); assert.equal(reads.length, 0);
  }
});

test('native sessions started in a route subdirectory retain their own verified cwd', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t), cwd = path.join(f.project, 'nested'); await fs.mkdir(cwd);
    let body;
    if (client === 'codex') {
      await fs.writeFile(f.source, row('session_meta', { id: S, session_id: S, cwd, cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' }));
      body = turn(A, 'Boundary') + turn(B, 'Subdirectory decision');
    } else {
      const base = { timestamp: stamp, sessionId: S, version: '2.1.280', isSidechain: false, cwd };
      const init = randomUUID(), a = randomUUID();
      await fs.writeFile(f.source, JSON.stringify({ ...base, type: 'system', subtype: 'init', uuid: init, parentUuid: null }) + '\n');
      body = JSON.stringify({ ...base, type: 'user', uuid: a, parentUuid: init, promptId: A, message: { role: 'user', content: 'Boundary' } }) + '\n' +
        JSON.stringify({ ...base, type: 'user', uuid: randomUUID(), parentUuid: a, promptId: B, message: { role: 'user', content: 'Subdirectory decision' } }) + '\n';
    }
    await collectionIngress(client, { ...f.payload, cwd, prompt_id: A }, f.options);
    await fs.appendFile(f.source, body);
    const result = await f.run(); assert.deepEqual(result.pending, []); assert.equal(result.saved, 1);
    const head = await readCaptureHead(f.store, { client, sessionId: S, unitId: B });
    assert.equal(head.capture.projectRoot, cwd);
    const again = await f.run(); assert.equal(again.saved, 0);
    assert(again.boundaryExcluded.some(item => item.client === client && item.unitId === A));
    const { collectionHookOutput } = await import('./collection-hooks.mjs');
    const notice = collectionHookOutput({ status: 'queued', notice: again, selection: { client, sessionId: S, unitId: B } }, 'UserPromptSubmit');
    // Shown on later prompts too, so it never says the current turn is uncaptured.
    assert.match(notice.hookSpecificOutput.additionalContext, /Initial boundary prompt .* was excluded; later eligible full turns can be captured\./);
  }
});

test('wall-clock changes do not extend the default worker deadline', async () => {
  const original = Date.now;
  await withWorkflowBudget({ milliseconds: 20 }, async () => {
    Date.now = () => 0;
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.throws(() => workflowTimeout(), { code: 'WORKER_TIME_BUDGET' });
    } finally { Date.now = original; }
  });
});

async function inspectedBoundary(f, unitId = A) {
  const selected = { client: 'codex', sessionId: S, path: f.source, projectRoot: f.project };
  return inspectSourceBoundary(selected, { verifyHeader: codexRegistrationHeader(selected), currentUnitId: unitId });
}

test('an exclusion-only selection arms future collection while an explicit pause before start does not', async t => {
  for (const operation of ['exclude', 'pause']) {
    const f = await fixture(t), observed = await inspectedBoundary(f);
    await withIntakeLock(f.store, tx => controlSelection(tx, { source: observed.source, expectedHash: null,
      request: { id: randomUUID(), client: 'codex', sessionId: S, operation, unitId: A, expectedRevision: 0 }, boundary: observed.boundary }));
    const notice = await collectionIngress('codex', f.payload, f.options);
    await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'New evidence'));
    const result = await f.run(), selected = await readSelection(f.store, { client: 'codex', sessionId: S });
    assert.equal(result.saved, operation === 'exclude' ? 1 : 0);
    assert.equal(selected.state.active, operation === 'exclude');
    assert.equal(selected.state.paused, operation === 'pause');
    assert.equal(notice.status, operation === 'pause' ? 'paused' : 'queued');
  }
});

test('paused collection drains authorized backlog and excludes the pause turn and its successors', async t => {
  const f = await fixture(t), C = randomUUID(), D = randomUUID();
  await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary')); await f.run();
  await fs.appendFile(f.source, turn(B, 'Authorized backlog') + turn(C, 'Pause prompt'));
  const selected = await readSelection(f.store, { client: 'codex', sessionId: S }), observed = await inspectedBoundary(f, C);
  await withIntakeLock(f.store, tx => controlSelection(tx, { source: selected.state.source, expectedHash: selected.hash,
    request: { id: randomUUID(), client: 'codex', sessionId: S, operation: 'pause', unitId: C, expectedRevision: selected.state.revision }, boundary: observed.boundary }));
  await fs.appendFile(f.source, turn(D, 'After pause'));
  assert.equal((await collectionIngress('codex', { ...f.payload, turn_id: C }, f.options)).status, 'paused');
  const result = await f.run(); assert.equal(result.saved, 1, JSON.stringify(result)); assert(result.pending.includes('COLLECTION_PAUSED'));
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).capture);
  for (const unitId of [C, D]) assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId })).head, null);
  const reads = [];
  await fs.appendFile(f.source, turn(randomUUID(), 'More work after pause'));
  assert.equal((await f.run({ observeRead: value => reads.push(value) })).saved, 0);
  assert.deepEqual(reads, []);
  const wake = await intakeSnapshot(f.store, 'state', `ingress/wake/codex/${S}.json`);
  let launches = 0;
  assert.equal((await collectionIngress('codex', f.payload, { ...f.options, launch: () => { launches++; } })).status, 'paused');
  assert.equal(launches, 0);
  assert.equal((await intakeSnapshot(f.store, 'state', `ingress/wake/codex/${S}.json`)).hash, wake.hash);
});

test('malformed registrations and missing project directories do not abort healthy collection', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  const original = intakeJSON(await intakeSnapshot(f.store, 'state', registrationPath({ client: 'codex', sessionId: S })));
  for (const [sessionId, value] of [['00000000-0000-4000-8000-000000000001', '{bad'],
    ['00000000-0000-4000-8000-000000000002', JSON.stringify({ ...original, sessionId: '00000000-0000-4000-8000-000000000002', cwd: path.join(f.root, 'deleted-project') })]]) {
    const file = path.join(f.collection.intakeStateDir, registrationPath({ client: 'codex', sessionId }));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, value, { mode: 0o600 });
  }
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Healthy evidence'));
  const result = await f.run(); assert.equal(result.saved, 1); assert(result.pending.includes('INVALID_INTAKE_METADATA'));
});

async function interruptedPublication(f, phase = 'intent') {
  await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary')); await f.run();
  await fs.appendFile(f.source, turn(B, 'Interrupted publication'));
  const selection = await readSelection(f.store, { client: 'codex', sessionId: S }), scopeId = selection.state.intervals[0].id;
  const progress = await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${scopeId}.json`);
  const { checkpoint, ...cursor } = intakeJSON(progress);
  const result = await readCodexSelection({ state: selection.state, scopeId, checkpoint, cursor });
  const plan = codexPublicationPlan(result, B), store = await openWorkflowIntake(f.capability, { client: 'codex', sessionId: S, cwd: f.project }, 'collect');
  await assert.rejects(withIntakeLock(store, tx => publishCapture(tx, { ...result.candidates[0], selectionHash: selection.hash,
    cursorHash: progress.hash, scan: plan.scan, checkpoint: codexCheckpoint(result, plan.scan.to.offset), authorize: async () => true,
    fault: async point => { if (point === phase) throw new Error('simulated interruption'); } })), /simulated interruption/);
  return inspectPendingPublication(f.store);
}

test('pending owner is recovered before the registration batch with its own authority', async t => {
  const f = await fixture(t), pending = await interruptedPublication(f);
  assert.equal(pending.committed, false);
  // Place the actual owner beyond the old 32-entry dispatch window.
  const original = intakeJSON(await intakeSnapshot(f.store, 'state', registrationPath({ client: 'codex', sessionId: S })));
  for (let i = 1; i <= 33; i++) {
    const sessionId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const file = path.join(f.collection.intakeStateDir, registrationPath({ client: 'codex', sessionId }));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify({ ...original, sessionId }), { mode: 0o600 });
  }
  await f.run();
  assert.equal(await inspectPendingPublication(f.store), null);
  assert((await readCaptureHead(f.store, pending.identity)).capture);
});

test('unpublished foreign intent is preserved when ongoing owner authority is absent', async t => {
  for (const kind of ['missing-registration', 'revoked-owner']) {
    const f = await fixture(t), pending = await interruptedPublication(f);
    if (kind === 'missing-registration') await fs.rm(path.dirname(path.join(f.collection.intakeStateDir, registrationPath(pending.identity))), { recursive: true });
    else {
      f.config.routes[0].collection.selection = { kind: 'sessions', sessionIds: [randomUUID()] };
      await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
    }
    const result = await f.run(); assert(result.pending.includes('INTAKE_RECOVERY_REQUIRED'), JSON.stringify(result));
    assert.equal((await inspectPendingPublication(f.store)).hash, pending.hash);
    assert.equal((await readCaptureHead(f.store, pending.identity)).head, null);
  }
});

test('committed publication can finish bookkeeping without its old registration', async t => {
  const f = await fixture(t), pending = await interruptedPublication(f, 'head'); assert.equal(pending.committed, true);
  await fs.rm(path.dirname(path.join(f.collection.intakeStateDir, registrationPath(pending.identity))), { recursive: true });
  await f.run(); assert.equal(await inspectPendingPublication(f.store), null);
  assert((await readCaptureHead(f.store, pending.identity)).capture);
});

test('pending recovery compares the inspected descriptor hash under lock', async t => {
  const f = await fixture(t), pending = await interruptedPublication(f);
  const store = await openWorkflowIntake(f.capability);
  await assert.rejects(withIntakeLock(store, tx => recoverPendingPublication(tx, { expectedHash: '0'.repeat(64), authorize: async () => true })), { code: 'INTAKE_RECOVERY_CONFLICT' });
  assert.equal((await inspectPendingPublication(f.store)).hash, pending.hash);
});

test('explicit historical and automatic selections survive a deterministic worker budget stop', async t => {
  const { digest } = await import('./workflow-values.mjs');
  const f = await fixture(t), C = randomUUID(); await fs.appendFile(f.source, turn(C, 'Explicit history'));
  const observed = await inspectedBoundary(f), content = await fs.readFile(f.source, 'utf8');
  let offset = 0; const anchors = content.trimEnd().split('\n').map(text => {
    const bytes = Buffer.from(text + '\n'), startByte = offset; offset += bytes.length;
    return { id: `codex:byte:${startByte}:${digest(bytes).slice(0, 20)}`, startByte, endByte: offset, hash: digest(bytes) };
  });
  const explicitId = randomUUID(), store = await openWorkflowIntake(f.capability, { client: 'codex', sessionId: S, cwd: f.project }, 'collect');
  await withIntakeLock(store, tx => controlSelection(tx, { source: observed.source, expectedHash: null, authorize: async () => true,
    request: { id: explicitId, client: 'codex', sessionId: S, operation: 'capture-historical', expectedRevision: 0,
      scope: { unitIds: [C], start: anchors[1], end: anchors.at(-1) } } }));
  await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'New boundary') + turn(B, 'New automatic evidence'));
  // Expire the default ten-second budget after automatic publication, when the
  // historical range is read. Keep functional assertions independent of native
  // ACL latency while explicitly exercising partial progress and retry.
  let clock = 0, expired = false;
  const stopped = await f.run({ now: () => clock, observeRead: read => {
    if (read.purpose === 'range' && read.offset === anchors[1].startByte) { clock = 10000; expired = true; }
  } });
  assert.equal(expired, true); assert.deepEqual(stopped.pending, ['WORKER_TIME_BUDGET']);
  const automatic = await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B });
  assert(automatic.capture, 'the completed automatic publication must survive the budget stop');
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: C })).head, null);
  const result = await f.run({ now: () => 0 });
  assert.deepEqual(result.pending, []);
  const selection = await readSelection(f.store, { client: 'codex', sessionId: S });
  assert.equal(selection.state.active, true); assert.equal(selection.state.explicitScopes[0].id, explicitId);
  for (const [unitId, text] of [[C, 'Explicit history'], [B, 'New automatic evidence']]) {
    const { capture } = await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId });
    assert(capture.evidence.some(item => item.text === text));
  }
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: A })).head, null);
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).hash, automatic.hash);
  const idle = await f.run({ now: () => 0 }); assert.deepEqual(idle.pending, []); assert.equal(idle.saved, 0);
});

test('owner recovery accepts a canonical workspace reached through a parent alias', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias');
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.payload.cwd = path.join(alias, 'project');
  const pending = await interruptedPublication(f);
  const result = await f.run(); assert.deepEqual(result.pending, []);
  assert.equal(await inspectPendingPublication(f.store), null);
  assert((await readCaptureHead(f.store, pending.identity)).capture);
});

test('a concurrently cleared publication intent is an idle recovery, not a conflict', async t => {
  const f = await fixture(t), pending = await interruptedPublication(f);
  await f.run(); const store = await openWorkflowIntake(f.capability);
  assert.deepEqual(await withIntakeLock(store, tx => recoverPendingPublication(tx, { expectedHash: pending.hash, authorize: async () => true })), { status: 'idle' });
});

test('a safety-stopped exclusion-only selection does not read transcript bytes to rearm', async t => {
  const { replaceIntakeJSON } = await import('./intake-io.mjs');
  const f = await fixture(t), observed = await inspectedBoundary(f);
  const selected = await withIntakeLock(f.store, tx => controlSelection(tx, { source: observed.source, expectedHash: null,
    request: { id: randomUUID(), client: 'codex', sessionId: S, operation: 'exclude', unitId: A, expectedRevision: 0 } }));
  selected.state.safetyStop = { reason: 'capacity', unitId: A };
  await withIntakeLock(f.store, tx => replaceIntakeJSON(tx, `sessions/codex/${S}.json`, selected.state, selected.hash));
  await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Must not rearm'));
  const reads = [], result = await f.run({ observeRead: value => reads.push(value) });
  assert.equal(result.saved, 0); assert.deepEqual(result.pending, ['SELECTION_CAPACITY_EXCEEDED']); assert.deepEqual(reads, []);
});

test('a paused Codex scope drains only after a late pre-pause native terminal is published', async t => {
  const f = await fixture(t), C = randomUUID(); let ordinal = 0;
  const record = (type, payload) => JSON.stringify({ timestamp: stamp, ordinal: ordinal++, type, payload }) + '\n';
  const start = turn_id => record('event_msg', { type: 'task_started', turn_id });
  const end = turn_id => record('event_msg', { type: 'task_complete', turn_id });
  const user = (turn_id, text) => record('event_msg', { type: 'item_completed', thread_id: S, turn_id,
    item: { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text }] } });
  await fs.writeFile(f.source, record('session_meta', { id: S, session_id: S, cwd: f.project, cli_version: '0.156.1', source: 'cli', history_mode: 'paginated' }));
  await collectionIngress('codex', f.payload, f.options); await fs.appendFile(f.source, start(A) + user(A, 'Boundary') + end(A)); await f.run();
  await fs.appendFile(f.source, start(B) + user(B, 'Late eligible work') + start(C));
  const selected = await readSelection(f.store, { client: 'codex', sessionId: S }), observed = await inspectedBoundary(f, C);
  await withIntakeLock(f.store, tx => controlSelection(tx, { source: selected.state.source, expectedHash: selected.hash,
    request: { id: randomUUID(), client: 'codex', sessionId: S, operation: 'pause', unitId: C, expectedRevision: selected.state.revision }, boundary: observed.boundary }));
  const waiting = await f.run(); assert.equal(waiting.saved, 0); assert(waiting.pending.includes('terminal-not-persisted'), JSON.stringify(waiting));
  await fs.appendFile(f.source, end(B)); const caught = await f.run(); assert.equal(caught.saved, 1, JSON.stringify(caught));
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).capture);
  await fs.appendFile(f.source, end(C)); const reads = [];
  await f.run({ observeRead: value => reads.push(value) }); assert.deepEqual(reads, []);
});

test('an active legacy boundary retains its unfinished lifecycle across worker passes', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, row('event_msg', { type: 'task_started', turn_id: A }) + row('event_msg', { type: 'user_message', message: 'Boundary not complete' }));
  const first = await f.run(); assert(first.pending.includes('terminal-not-persisted'), JSON.stringify(first));
  await fs.appendFile(f.source, turn(B, 'Overlapping ambiguous work'));
  const next = await f.run(); assert(next.pending.includes('UNSUPPORTED_CODEX_ORDER'), JSON.stringify(next)); assert.equal(next.saved, 0);
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).head, null);
});

test('processing edits preserve registration progress; revoked grants require an explicit fresh boundary', async t => {
  const { configureWorkflow } = await import('./workflow-settings.mjs');
  const { readWorkflowSnapshot } = await import('./workflow-config.mjs');
  const { verifyWorkflowStorage } = await import('./workflow-storage.mjs');
  const { controlCapture, runSelectedCapture } = await import('./test-support/capture-workflow.mjs');
  const { readClaudeSelection } = await import('./claude-reader.mjs');
  const f = await fixture(t);
  const update = async change => {
    const before = await readWorkflowSnapshot(f.options.configPath), proposal = structuredClone(before.config); change(proposal);
    const saved = await configureWorkflow({ configPath: f.options.configPath, expectedHash: before.hash, proposal });
    return verifyWorkflowStorage({ ...f.options, collectionId: f.collection.id, expectedConfigHash: saved.configHash });
  };
  await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'First retained evidence'));
  assert.equal((await f.run()).saved, 1);
  const before = await readSelection(f.store, { client: 'codex', sessionId: S }), oldScope = before.state.intervals[0].id;
  const C = randomUUID(); await update(c => { c.routes[0].processing.mode = 'prompted'; });
  assert.equal((await collectionIngress('codex', { ...f.payload, turn_id: C }, f.options)).status, 'queued');
  await fs.appendFile(f.source, turn(C, 'Progress after processing edit'));
  assert.equal((await f.run()).saved, 1);
  const selected = await readSelection(f.store, { client: 'codex', sessionId: S });
  assert.equal(selected.state.currentGrantHash, before.state.currentGrantHash);
  await update(c => { c.routes[0].collection.enabled = false; });
  const gap = randomUUID(); await fs.appendFile(f.source, turn(gap, 'Must never collect this gap'));
  const capability = await update(c => { c.routes[0].collection.enabled = true; });
  const reads = [], blocked = await f.run({ observeRead: r => reads.push(r) });
  assert(blocked.pending.includes('REGISTRATION_REQUIRES_REVIEW')); assert.equal(reads.length, 0);
  await assert.rejects(collectionIngress('codex', f.payload, f.options), /REGISTRATION_REQUIRES_REVIEW/);
  await assert.rejects(runSelectedCapture(capability, { selection: { client: 'codex', sessionId: S, cwd: f.project },
    scopeId: oldScope, expectedSelectionHash: selected.hash }, { observeRead: r => reads.push(r) }), /COLLECTION_GRANT_REQUIRES_REVIEW/);
  const metadata = await snapshotSourceMetadata(f.source), request = { selection: { client: 'codex', sessionId: S, cwd: f.project },
    sourcePath: f.source, expectedSourceIdentity: metadata.fileIdentity, expectedSelectionHash: selected.hash, operationId: randomUUID(), operation: 'resume' };
  const rebound = await controlCapture(capability, request);
  assert.equal(rebound.state.intervals.length, 2); assert.deepEqual(rebound.state.intervals[0], selected.state.intervals[0]);
  assert.notEqual(rebound.state.currentGrantHash, selected.state.currentGrantHash);
  assert.equal(rebound.state.intervals[1].lower.eofByte, metadata.eofByte);
  assert.deepEqual(await controlCapture(capability, request), rebound);
  // Even trusted readers reject retired intervals before opening native bytes.
  for (const reader of [readCodexSelection, readClaudeSelection]) await assert.rejects(reader({ state: rebound.state,
    scopeId: oldScope, observeRead: r => reads.push(r) }), /CAPTURE_NOT_SELECTED|UNKNOWN_SELECTION_SCOPE/);
  assert.equal(reads.length, 0);
  const D = randomUUID(), E = randomUUID();
  assert.equal((await collectionIngress('codex', { ...f.payload, turn_id: D }, f.options)).status, 'queued');
  await fs.appendFile(f.source, turn(D, 'New excluded boundary') + turn(E, 'New permitted evidence'));
  const result = await f.run({ observeRead: r => reads.push(r) }); assert.deepEqual(result.pending, []); assert.equal(result.saved, 1);
  assert(reads.filter(r => r.purpose === 'range').every(r => r.offset >= metadata.eofByte));
  for (const id of [gap, D]) assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: id })).head, null);
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: E })).head);
  await update(c => { c.routes[0].collection.enabled = false; });
  const again = await update(c => { c.routes[0].collection.enabled = true; });
  await assert.rejects(controlCapture(again, request), /COLLECTION_GRANT_REQUIRES_REVIEW/);
});

test('a fresh grant cannot absorb an unpublished intent from the retired grant', async t => {
  const { configureWorkflow } = await import('./workflow-settings.mjs');
  const { readWorkflowSnapshot } = await import('./workflow-config.mjs');
  const { verifyWorkflowStorage } = await import('./workflow-storage.mjs');
  const { controlCapture } = await import('./test-support/capture-workflow.mjs');
  const f = await fixture(t), pending = await interruptedPublication(f);
  let config;
  for (const enabled of [false, true]) {
    const before = await readWorkflowSnapshot(f.options.configPath); before.config.routes[0].collection.enabled = enabled;
    config = await configureWorkflow({ configPath: f.options.configPath, expectedHash: before.hash, proposal: before.config });
  }
  const capability = await verifyWorkflowStorage({ ...f.options, collectionId: f.collection.id, expectedConfigHash: config.configHash });
  const selected = await readSelection(f.store, pending.identity), metadata = await snapshotSourceMetadata(f.source);
  const request = { selection: { client: 'codex', sessionId: S, cwd: f.project, unitId: B }, sourcePath: f.source,
    expectedSourceIdentity: metadata.fileIdentity, expectedSelectionHash: selected.hash, operationId: randomUUID(), operation: 'resume' };
  await assert.rejects(controlCapture(capability, request), /INTAKE_RECOVERY_REQUIRED/);
  assert.equal((await readSelection(f.store, pending.identity)).hash, selected.hash);
  assert.equal((await inspectPendingPublication(f.store)).hash, pending.hash);
  const reads = []; assert((await f.run({ observeRead: r => reads.push(r) })).pending.length); assert.equal(reads.length, 0);
  const paused = await controlCapture(capability, { ...request, operation: 'pause', operationId: randomUUID() });
  assert.equal(await inspectPendingPublication(f.store), null);
  const resumed = await controlCapture(capability, { ...request, expectedSelectionHash: paused.hash, operationId: randomUUID() });
  assert.equal(resumed.state.intervals.length, 2);
  assert.equal(resumed.state.intervals[0].upper.unitId, B);
  assert.equal((await readCaptureHead(f.store, pending.identity)).head, null);
});

test('an explicit fresh start can bind an initially missing registered source', async t => {
  const { controlCapture } = await import('./test-support/capture-workflow.mjs');
  const f = await fixture(t), header = await fs.readFile(f.source); await fs.rm(f.source);
  assert.equal((await collectionIngress('codex', f.payload, f.options)).status, 'pending-source');
  await fs.writeFile(f.source, header + turn(A, 'History before explicit start'));
  const metadata = await snapshotSourceMetadata(f.source), C = randomUUID(), D = randomUUID();
  const selected = await controlCapture(f.capability, { selection: { client: 'codex', sessionId: S, cwd: f.project }, sourcePath: f.source,
    expectedSourceIdentity: metadata.fileIdentity, expectedSelectionHash: null, operationId: randomUUID(), operation: 'start' });
  assert.equal(selected.state.intervals[0].lower.eofByte, metadata.eofByte);
  assert.equal((await collectionIngress('codex', { ...f.payload, turn_id: C }, f.options)).status, 'queued');
  await fs.appendFile(f.source, turn(C, 'Fresh boundary') + turn(D, 'Eligible after explicit start'));
  assert.equal((await f.run()).saved, 1);
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: A })).head, null);
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: D })).head);
  const replacement = f.source + '.replacement'; await fs.writeFile(replacement, await fs.readFile(f.source)); await fs.rename(replacement, f.source);
  await assert.rejects(collectionIngress('codex', f.payload, f.options), /SOURCE_IDENTITY_MISMATCH|REGISTRATION_REQUIRES_REVIEW/);
  const reads = []; assert((await f.run({ observeRead: r => reads.push(r) })).pending.includes('SOURCE_IDENTITY_MISMATCH')); assert.equal(reads.length, 0);
});

test('a missing-source registration with an exclusion-only state can freeze its first wake and arm', async t => {
  const { restrictCapture } = await import('./capture-controls.mjs');
  const { readWorkflowSnapshot } = await import('./workflow-config.mjs');
  const f = await fixture(t), header = await fs.readFile(f.source); await fs.rm(f.source);
  await collectionIngress('codex', f.payload, f.options);
  await fs.writeFile(f.source, header + turn(A, 'Explicitly excluded history'));
  const metadata = await snapshotSourceMetadata(f.source);
  await restrictCapture({ configPath: f.options.configPath, collectionId: f.collection.id,
    expectedConfigHash: (await readWorkflowSnapshot(f.options.configPath)).hash }, {
    selection: { client: 'codex', sessionId: S, unitId: A, cwd: f.project }, sourcePath: f.source,
    expectedSourceIdentity: metadata.fileIdentity, expectedSelectionHash: null, operationId: randomUUID(), operation: 'exclude' });
  assert.equal((await collectionIngress('codex', { ...f.payload, turn_id: B }, f.options)).status, 'queued');
  const C = randomUUID(); await fs.appendFile(f.source, turn(B, 'First proven boundary') + turn(C, 'New eligible work'));
  assert.equal((await f.run()).saved, 1);
  const selected = await readSelection(f.store, { client: 'codex', sessionId: S });
  assert.equal(selected.state.intervals[0].lower.eofByte, metadata.eofByte); assert(selected.state.exclusions.includes(A));
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: C })).head);
});

test('Claude cd within the selected route keeps its registered native source cwd and wakes collection', async t => {
  const f = await fixture(t), subdir = path.join(f.project, 'src'); await fs.mkdir(subdir);
  let previous = null;
  const message = (type, text, promptId, cwd = f.project) => {
    const record = { type, uuid: randomUUID(), parentUuid: previous, timestamp: stamp, sessionId: S, version: '2.1.280',
      isSidechain: false, cwd, message: { role: type, content: text }, ...(promptId ? { promptId } : {}) };
    previous = record.uuid; return JSON.stringify(record) + '\n';
  };
  await fs.writeFile(f.source, message('system', ''));
  await collectionIngress('claude', { ...f.payload, prompt_id: A }, f.options);
  await fs.appendFile(f.source, message('user', 'Boundary', A)); await f.run();
  const next = await collectionIngress('claude', { ...f.payload, prompt_id: B, cwd: subdir }, f.options);
  assert.equal(next.status, 'queued');
  await fs.appendFile(f.source, message('user', 'Meeting decision after cd', B, subdir));
  assert.equal((await f.run()).saved, 1);
  const selected = await readSelection(f.store, { client: 'claude', sessionId: S });
  assert.equal(selected.state.source.projectRoot, f.project);
  assert((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: B })).head);
});

test('a foreign publication preserves its exact intent while another session starts or rebinds', async t => {
  const { controlCapture } = await import('./test-support/capture-workflow.mjs');
  const { configureWorkflow } = await import('./workflow-settings.mjs');
  const { readWorkflowSnapshot } = await import('./workflow-config.mjs');
  const { verifyWorkflowStorage } = await import('./workflow-storage.mjs');
  const f = await fixture(t), pending = await interruptedPublication(f), owner = await readSelection(f.store, pending.identity);
  const sessionId = randomUUID(), sourcePath = path.join(f.project, 'second.jsonl');
  await fs.writeFile(sourcePath, row('session_meta', { id: sessionId, session_id: sessionId, cwd: f.project, cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' }));
  const metadata = await snapshotSourceMetadata(sourcePath), request = { selection: { client: 'codex', sessionId, cwd: f.project }, sourcePath,
    expectedSourceIdentity: metadata.fileIdentity, expectedSelectionHash: null, operationId: randomUUID(), operation: 'start' };
  const started = await controlCapture(f.capability, request); assert.equal(started.state.active, true);
  assert.equal((await inspectPendingPublication(f.store)).hash, pending.hash);
  let config;
  for (const enabled of [false, true]) {
    const before = await readWorkflowSnapshot(f.options.configPath); before.config.routes[0].collection.enabled = enabled;
    config = await configureWorkflow({ configPath: f.options.configPath, expectedHash: before.hash, proposal: before.config });
  }
  const capability = await verifyWorkflowStorage({ configPath: f.options.configPath, collectionId: f.collection.id, expectedConfigHash: config.configHash });
  const resumed = await controlCapture(capability, { ...request, expectedSelectionHash: started.hash, operation: 'resume', operationId: randomUUID() });
  assert.equal(resumed.state.intervals.length, 2);
  assert.equal((await inspectPendingPublication(f.store)).hash, pending.hash);
  assert.deepEqual(await readSelection(f.store, pending.identity), owner);
  const reads = [], result = await f.run({ observeRead: r => reads.push(r) });
  assert(result.pending.includes('REGISTRATION_REQUIRES_REVIEW')); assert.equal(reads.length, 0);
  assert.equal((await inspectPendingPublication(f.store)).hash, pending.hash);
});

test('adding a selected session preserves the existing tail and gives the new session a fresh floor', async t => {
  const { configureWorkflow } = await import('./workflow-settings.mjs');
  const { readWorkflowSnapshot } = await import('./workflow-config.mjs');
  const f = await fixture(t), other = randomUUID(), sourcePath = path.join(f.project, 'other.jsonl');
  const update = async change => {
    const current = await readWorkflowSnapshot(f.options.configPath); change(current.config);
    return configureWorkflow({ configPath: f.options.configPath, expectedHash: current.hash, proposal: current.config });
  };
  await update(c => { c.routes[0].clients = ['codex']; c.routes[0].collection.selection = { kind: 'sessions', sessionIds: [S] }; });
  await collectionIngress('codex', f.payload, f.options); await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'First evidence')); await f.run();
  const initial = await readSelection(f.store, { client: 'codex', sessionId: S }), C = randomUUID();
  await fs.appendFile(f.source, turn(C, 'Must retain uncollected tail through widening'));
  await fs.writeFile(sourcePath, row('session_meta', { id: other, session_id: other, cwd: f.project, cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' }) + turn(A, 'Prior history'));
  const otherPayload = { ...f.payload, session_id: other, transcript_path: sourcePath };
  assert.equal((await collectionIngress('codex', otherPayload, f.options)).status, 'manual');
  const expectedFloor = (await fs.stat(sourcePath)).size;
  await update(c => { c.routes[0].clients.push('claude'); c.routes[0].collection.selection.sessionIds.push(other); });
  assert.equal((await collectionIngress('codex', f.payload, f.options)).status, 'queued');
  assert.equal((await f.run()).saved, 1);
  assert.equal((await readSelection(f.store, { client: 'codex', sessionId: S })).state.currentGrantHash, initial.state.currentGrantHash);
  await collectionIngress('codex', { ...otherPayload, turn_id: B }, f.options);
  await fs.appendFile(sourcePath, turn(B, 'New boundary') + turn(C, 'New member evidence'));
  assert.equal((await f.run()).saved, 1);
  assert.equal((await readSelection(f.store, { client: 'codex', sessionId: other })).state.intervals[0].lower.eofByte, expectedFloor);
  assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId: other, unitId: A })).head, null);
});

test('acknowledged unchanged sources avoid native reads and still detect late appends and same-size edits', async t => {
  const { configureWorkflow } = await import('./workflow-settings.mjs');
  const { readWorkflowSnapshot } = await import('./workflow-config.mjs');
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Saved evidence'));
  assert.equal((await f.run()).saved, 1);
  const open = fs.open;
  fs.open = async (file, ...args) => { assert.notEqual(file, f.source, 'ACKed source opened'); return open(file, ...args); };
  try {
    assert.equal((await f.run()).saved, 0);
    const config = await readWorkflowSnapshot(f.options.configPath); config.config.routes[0].processing.mode = 'prompted';
    await configureWorkflow({ configPath: f.options.configPath, expectedHash: config.hash, proposal: config.config });
    assert.deepEqual((await f.run()).pending, []);
  } finally { fs.open = open; }
  const C = randomUUID(); await fs.appendFile(f.source, turn(C, 'Late appended evidence'));
  assert.equal((await f.run()).saved, 1, 'no new wake is needed for a source append');
  const content = await fs.readFile(f.source, 'utf8'), reads = [];
  await fs.writeFile(f.source, content.replace('Saved evidence', 'Edited content'));
  await f.run({ observeRead: r => reads.push(r) }); assert(reads.length > 0, 'same-size edits must miss the ACK');
});

test('a newer wake and append racing ACK publication remain visible to the next pass', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Saved evidence'));
  const ackFile = path.join(f.collection.intakeStateDir, 'ingress/wake-acks/codex', S + '.json'), C = randomUUID();
  const rename = fs.rename; let fired = false;
  fs.rename = async (from, to) => {
    if (to === ackFile && !fired) {
      fired = true; await fs.appendFile(f.source, turn(C, 'Racing append'));
      assert.equal((await collectionIngress('codex', { ...f.payload, turn_id: C }, f.options)).status, 'intake-blocked');
    }
    return rename(from, to);
  };
  try { assert.equal((await f.run()).saved, 1); } finally { fs.rename = rename; }
  assert(fired);
  const ack = JSON.parse(await fs.readFile(ackFile)), wake = await intakeSnapshot(f.store, 'state', `ingress/wake/codex/${S}.json`);
  assert.notEqual(ack.wakeHash, wake.hash); assert(Number(ack.sourceVersion.size) < (await fs.stat(f.source)).size);
  assert.equal((await f.run()).saved, 1); assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: C })).head);
  const reads = []; await f.run({ observeRead: r => reads.push(r) }); assert.deepEqual(reads, []);
});

test('an incomplete tail is retryable without a wake and malformed ACKs do not become authority', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary')); await f.run();
  const ackName = `ingress/wake-acks/codex/${S}.json`, before = await intakeSnapshot(f.store, 'state', ackName);
  const bytes = turn(B, 'Complete after a delayed final byte'); await fs.appendFile(f.source, bytes.slice(0, -1));
  assert.equal((await f.run()).saved, 0); assert.equal((await intakeSnapshot(f.store, 'state', ackName)).hash, before.hash);
  await fs.appendFile(f.source, '\n'); assert.equal((await f.run()).saved, 1);
  await fs.writeFile(path.join(f.collection.intakeStateDir, ackName), '{malformed', { mode: 0o600 });
  const reads = [], result = await f.run({ observeRead: r => reads.push(r) });
  assert.deepEqual(result.pending, []); assert(reads.length > 0);
});

test('a proven drained Codex interval does not require its former native source to remain present', async t => {
  const f = await fixture(t), C = randomUUID(); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Eligible')); await f.run();
  await fs.appendFile(f.source, turn(C, 'Pause'));
  const selected = await readSelection(f.store, { client: 'codex', sessionId: S }), observed = await inspectedBoundary(f, C);
  await withIntakeLock(f.store, tx => controlSelection(tx, { source: selected.state.source, expectedHash: selected.hash,
    request: { id: randomUUID(), client: 'codex', sessionId: S, operation: 'pause', unitId: C, expectedRevision: selected.state.revision }, boundary: observed.boundary }));
  await f.run(); await fs.rm(f.source);
  const reads = [], result = await f.run({ observeRead: r => reads.push(r) });
  assert.deepEqual(result.pending, ['COLLECTION_PAUSED']); assert.deepEqual(reads, []);
});

test('worker CLI honors a complete trigger pair and ignores half-specified hints', async t => {
  const { spawnSync } = await import('node:child_process');
  const { registrationShard } = await import('./collection-ingress.mjs');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Targeted worker evidence'));
  const args = [fileURLToPath(new URL('./collection-worker.mjs', import.meta.url)), '--config', f.options.configPath, '--collection', f.collection.id];
  const before = await fs.readdir(f.collection.intakeStateDir);
  const half = spawnSync(process.execPath, [...args, '--client', 'codex'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(half.status, 0); assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
  // Put more than one pass of malformed records ahead of the actual session.
  let count = 0;
  while (count < 33) {
    const sessionId = randomUUID(); if (registrationShard(sessionId) >= registrationShard(S)) continue;
    const file = path.join(f.collection.intakeStateDir, registrationPath({ client: 'codex', sessionId }));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, '{bad', { mode: 0o600 }); count++;
  }
  const result = spawnSync(process.execPath, [...args, '--client', 'codex', '--session', S], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).head);
});

test('an oversized private ACK remains a cache miss without blocking new evidence', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Original evidence')); await f.run();
  const ackFile = path.join(f.collection.intakeStateDir, `ingress/wake-acks/codex/${S}.json`), bytes = Buffer.alloc(16385, 120);
  await fs.writeFile(ackFile, bytes);
  const C = randomUUID(); await fs.appendFile(f.source, turn(C, 'Evidence despite malformed ACK'));
  const result = await f.run(); assert.equal(result.saved, 1); assert.deepEqual(result.pending, []);
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: C })).head);
  assert.deepEqual(await fs.readFile(ackFile), bytes, 'unusable hint is preserved');
  assert.deepEqual((await f.run()).pending, []);
});

test('an unsafe trigger is isolated while healthy background collection continues', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Healthy background evidence'));
  const trigger = { client: 'codex', sessionId: randomUUID() };
  const directory = path.dirname(path.join(f.collection.intakeStateDir, registrationPath(trigger)));
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await fs.symlink(f.project, directory, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.run({ trigger }); assert.equal(result.saved, 1);
  assert(result.pending.includes('INVALID_REGISTRATION')); assert(result.pending.includes('UNSAFE_INTAKE_PATH'));
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).head);
});

for (const code of ['EACCES', 'EPERM', 'missing']) {
  test(`a ${code} trigger consumes one isolated attempt and preserves healthy background capture`, async t => {
    const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
    await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Healthy evidence despite trigger failure'));
    const trigger = { client: 'codex', sessionId: randomUUID() }, record = path.join(f.collection.intakeStateDir, registrationPath(trigger));
    if (code !== 'missing') { await fs.mkdir(path.dirname(record), { recursive: true, mode: 0o700 }); await fs.writeFile(record, '{}', { mode: 0o600 }); }
    const lstat = fs.lstat;
    fs.lstat = async (file, ...args) => {
      if (code !== 'missing' && file === record) throw Object.assign(new Error('Synthetic registration access error'), { code });
      return lstat(file, ...args);
    };
    let result;
    try { result = await f.run({ trigger }); } finally { fs.lstat = lstat; }
    assert.equal(result.saved, 1);
    if (code !== 'missing') assert(result.pending.includes(code));
    else assert.deepEqual(result.pending, []);
    assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: B })).head);
  });
}

test('a deleted worktree does not strand its pending publication or surviving native source', async t => {
  const f = await fixture(t), relocated = path.join(f.root, 'native-session.jsonl');
  await fs.rename(f.source, relocated); f.source = relocated; f.payload.transcript_path = relocated;
  const pending = await interruptedPublication(f);
  await fs.rmdir(f.project);
  const result = await f.run();
  assert.deepEqual(result.pending, []);
  assert.equal(await inspectPendingPublication(f.store), null);
  assert((await readCaptureHead(f.store, pending.identity)).capture);
  const C = randomUUID(); await fs.appendFile(f.source, turn(C, 'Evidence after worktree removal'));
  assert.equal((await f.run()).saved, 1);
  assert((await readCaptureHead(f.store, { client: 'codex', sessionId: S, unitId: C })).capture);
});

for (const policy of ['disabled', 'removed']) test(`explicit owner restriction can release unpublished intent after its route is ${policy}`, async t => {
  const { restrictCapture } = await import('./capture-controls.mjs');
  const { digest } = await import('./workflow-values.mjs');
  const f = await fixture(t), relocated = path.join(f.root, 'native-session.jsonl');
  await fs.rename(f.source, relocated); f.source = relocated; f.payload.transcript_path = relocated;
  const pending = await interruptedPublication(f);
  await fs.rmdir(f.project);
  if (policy === 'disabled') f.config.routes[0].collection.enabled = false;
  else f.config.routes = [];
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const selected = await readSelection(f.store, pending.identity);
  const request = { selection: { client: 'codex', sessionId: S, cwd: f.project + path.sep, unitId: B },
    sourcePath: f.source, expectedSourceIdentity: selected.state.source.fileIdentity, expectedSelectionHash: selected.hash,
    operationId: randomUUID(), operation: 'pause' };
  const options = { ...f.options, collectionId: f.collection.id, expectedConfigHash: digest(bytes) };
  await assert.rejects(restrictCapture(options, { ...request, selection: { ...request.selection, cwd: path.join(f.root, 'foreign') } }), /NOT_AUTHORIZED/);
  assert.equal((await inspectPendingPublication(f.store)).hash, pending.hash);
  const result = await restrictCapture(options, request);
  assert.equal(result.state.paused, true);
  assert.equal(await inspectPendingPublication(f.store), null);
  assert.equal((await readCaptureHead(f.store, pending.identity)).head, null);
  assert.equal((await restrictCapture(options, request)).hash, result.hash, 'exact retry is idempotent');
});

test('a damaged background registration stays visible even when it is also the trigger', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Healthy evidence'));
  const broken = { client: 'codex', sessionId: randomUUID() };
  await fs.mkdir(path.dirname(path.join(f.collection.intakeStateDir, registrationPath(broken))), { recursive: true, mode: 0o700 });
  const result = await f.run({ trigger: broken });
  assert.equal(result.saved, 1); assert(result.pending.includes('INVALID_REGISTRATION'));
  assert((await f.run()).pending.includes('INVALID_REGISTRATION'));
});

test('a new session opt-out after route disable preserves another owner’s unpublished intent', async t => {
  const { restrictCapture } = await import('./capture-controls.mjs'), { digest } = await import('./workflow-values.mjs');
  const f = await fixture(t), pending = await interruptedPublication(f);
  f.config.routes[0].collection.enabled = false;
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const sessionId = randomUUID(), unitId = randomUUID(), sourcePath = path.join(f.project, 'other.jsonl');
  await fs.writeFile(sourcePath, row('session_meta', { id: sessionId, session_id: sessionId, cwd: f.project,
    cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' }) + turn(unitId, 'Opt out'));
  const source = await snapshotSourceMetadata(sourcePath);
  const result = await restrictCapture({ ...f.options, collectionId: f.collection.id, expectedConfigHash: digest(bytes) }, {
    selection: { client: 'codex', sessionId, cwd: f.project, unitId }, sourcePath, expectedSourceIdentity: source.fileIdentity,
    expectedSelectionHash: null, operationId: randomUUID(), operation: 'pause' });
  assert.equal(result.state.paused, true);
  assert.equal((await inspectPendingPublication(f.store)).hash, pending.hash);
});

test('hook routing and worker arming accept an existing project directory alias', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'project-link');
  await fs.symlink(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const payload = { ...f.payload, cwd: alias };
  await collectionIngress('codex', payload, f.options);
  await fs.appendFile(f.source, turn(A, 'Boundary') + turn(B, 'Evidence through a project alias'));
  const result = await f.run(); assert.equal(result.saved, 1); assert.deepEqual(result.pending, []);
  assert.equal((await readSelection(f.store, { client: 'codex', sessionId: S })).state.source.projectRoot, f.project);
});

for (const staleCache of [
  { version: 1 },
  { version: 2 }, // Same shape, before reader-owned revisions were introduced.
  { version: READER_SUSPENSION_VERSION, readerRulesRevision: 0 },
  { version: READER_SUSPENSION_VERSION + 1, futureCacheField: true },
]) test(`stale Claude suspension ${JSON.stringify(staleCache)} is retried inside the original pause ceiling`, async t => {
  const { controlCapture } = await import('./test-support/capture-workflow.mjs');
  const { suspendedPath, publishIngressMetadata } = await import('./collection-ingress.mjs');
  const { replaceIntakeJSON } = await import('./intake-io.mjs');
  const { CLAUDE_READER_RULES_REVISION } = await import('./claude-reader.mjs');
  const f = await fixture(t), P = randomUUID(), later = randomUUID(); let previous = null;
  const message = (type, text, promptId, version = '2.1.280') => {
    const record = { type, uuid: randomUUID(), parentUuid: previous, timestamp: stamp, sessionId: S, version,
      isSidechain: false, cwd: f.project, message: { role: type, content: text }, ...(promptId ? { promptId } : {}) };
    previous = record.uuid; return JSON.stringify(record) + '\n';
  };
  const identity = { client: 'claude', sessionId: S }, payload = { ...f.payload, prompt_id: A };
  await fs.writeFile(f.source, message('system', ''));
  await collectionIngress('claude', payload, f.options);
  await fs.appendFile(f.source, message('user', 'Boundary', A)); await f.run();
  await fs.appendFile(f.source, message('user', 'Meeting decision after client update', B, '2.1.282') + message('user', 'Pause now', P, '2.1.282'));
  const selected = await readSelection(f.store, identity);
  const paused = await controlCapture(f.capability, { selection: { ...identity, cwd: f.project, unitId: P }, sourcePath: f.source,
    expectedSourceIdentity: selected.state.source.fileIdentity, expectedSelectionHash: selected.hash,
    operationId: randomUUID(), operation: 'pause' });
  const scope = paused.state.intervals[0], ceiling = scope.upper.eofByte;
  const progress = await intakeSnapshot(f.store, 'state', `progress/claude/${S}/${scope.id}.json`);
  const suspensionName = `reader-suspensions/claude/${S}/${scope.id}.json`;
  // Persist the former worker's cache shape without altering its frozen source,
  // selection or cursor. Neither cache is capture authority.
  await withIntakeLock(f.store, tx => replaceIntakeJSON(tx, suspensionName, {
    ...staleCache, sourceIdentity: paused.state.source.fileIdentity, intervalHash: digest(canonicalJSON(scope)),
    cursorHash: progress.hash, ceilingByte: ceiling, reason: 'unresolved-boundary', diagnostic: 'UNSUPPORTED_CLAUDE_VERSION',
  }, null));
  await publishIngressMetadata(f.store, suspendedPath(identity), { ...staleCache, selectionHash: paused.hash });
  await fs.appendFile(f.source, message('user', 'Late evidence', B, '2.1.282') + message('user', 'After pause', later, '2.1.282'));
  let launches = 0;
  await collectionIngress('claude', { ...payload, prompt_id: later }, { ...f.options, launch: () => { launches++; } });
  assert.equal(launches, 1, 'an old ingress suspension must not suppress the upgraded reader');
  const reads = [], result = await f.run({ observeRead: row => reads.push(row) });
  assert.equal(result.saved, 1); assert.deepEqual(result.pending, ['COLLECTION_PAUSED']);
  assert(reads.length); assert(reads.every(row => row.offset + row.bytes <= ceiling));
  const capture = (await readCaptureHead(f.store, { ...identity, unitId: B })).capture;
  assert.deepEqual(capture.evidence.map(item => item.text), ['Meeting decision after client update']);
  for (const unitId of [A, P, later]) assert.equal((await readCaptureHead(f.store, { ...identity, unitId })).head, null);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', suspensionName)).version, READER_SUSPENSION_VERSION);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', suspendedPath(identity))).version, READER_SUSPENSION_VERSION);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', suspensionName)).readerRulesRevision, CLAUDE_READER_RULES_REVISION);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', suspendedPath(identity))).readerRulesRevision, CLAUDE_READER_RULES_REVISION);
  // A later append misses the ordinary source ACK, so this proves that the
  // refreshed reader suspension itself prevents further native reads.
  await fs.appendFile(f.source, message('user', 'Still paused', randomUUID(), '2.1.282'));
  const again = [], retry = await f.run({ observeRead: row => again.push(row) });
  assert.equal(retry.saved, 0); assert.deepEqual(again, []);
  await collectionIngress('claude', { ...payload, prompt_id: later }, { ...f.options, launch: () => assert.fail('fresh suspension must not launch') });
});

test('Claude pause freezes automatic reads and resumes only a new interval; late evidence needs explicit capture', async t => {
  const { controlCapture, selectExplicitCapture, runSelectedCapture } = await import('./test-support/capture-workflow.mjs');
  const { suspendedPath } = await import('./collection-ingress.mjs');
  const f = await fixture(t), P = randomUUID(), later = randomUUID(); let previous = null;
  const message = (type, text, promptId) => {
    const record = { type, uuid: randomUUID(), parentUuid: previous, timestamp: stamp, sessionId: S, version: '2.1.280',
      isSidechain: false, cwd: f.project, message: { role: type, content: text }, ...(promptId ? { promptId } : {}) };
    previous = record.uuid; return JSON.stringify(record) + '\n';
  };
  await fs.writeFile(f.source, message('system', ''));
  await collectionIngress('claude', { ...f.payload, prompt_id: A }, f.options);
  await fs.appendFile(f.source, message('user', 'Boundary', A)); await f.run();
  await fs.appendFile(f.source, message('user', 'Meeting decision', B) + message('user', 'Pause now', P));
  const selected = await readSelection(f.store, { client: 'claude', sessionId: S });
  const identity = { client: 'claude', sessionId: S, cwd: f.project, unitId: P };
  const paused = await controlCapture(f.capability, { selection: identity, sourcePath: f.source,
    expectedSourceIdentity: selected.state.source.fileIdentity, expectedSelectionHash: selected.hash,
    operationId: randomUUID(), operation: 'pause' });
  const ceiling = paused.state.intervals[0].upper.eofByte;
  await fs.appendFile(f.source, message('user', 'Late evidence', B) + message('user', 'After pause', later));
  const reads = [], result = await f.run({ observeRead: row => reads.push(row) });
  assert.equal(result.saved, 1); assert.deepEqual(result.pending, ['COLLECTION_PAUSED']);
  assert(reads.length); assert(reads.every(row => row.offset + row.bytes <= ceiling), 'header and range reads honor frozen EOF');
  assert.doesNotMatch(JSON.stringify((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: B })).capture.evidence), /Late evidence/);
  assert(intakeJSON(await intakeSnapshot(f.store, 'state', suspendedPath(identity))));
  await fs.appendFile(f.source, message('user', 'Still chatting', randomUUID()));
  const open = fs.open; let pageReads = 0;
  fs.open = async (file, ...args) => { if (file.endsWith('page.json')) pageReads++; return open(file, ...args); };
  const nextReads = [];
  try { await f.run({ observeRead: row => nextReads.push(row) }); } finally { fs.open = open; }
  assert.deepEqual(nextReads, []); assert.equal(pageReads, 0, 'suspension is checked before loading carry pages');
  await collectionIngress('claude', { ...f.payload, prompt_id: later }, { ...f.options, launch: () => assert.fail('suspended hook must not launch') });
  const current = await readSelection(f.store, { client: 'claude', sessionId: S }), endByte = (await fs.stat(f.source)).size;
  const explicit = await selectExplicitCapture(f.capability, { selection: { ...identity, unitId: B }, sourcePath: f.source,
    expectedSourceIdentity: current.state.source.fileIdentity, expectedSelectionHash: current.hash, operationId: randomUUID(),
    kind: 'historical', unitIds: [B], readRange: { fromByte: 0, endByte } });
  const explicitScope = explicit.state.explicitScopes.at(-1);
  const captured = await runSelectedCapture(f.capability, { selection: identity, scopeId: explicitScope.id, expectedSelectionHash: explicit.hash, unitIds: [B] });
  assert.equal(captured.saved, 1);
  assert.match(JSON.stringify((await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: B })).capture.evidence), /Late evidence/);
  await fs.appendFile(f.source, message('user', 'Still paused after explicit capture', randomUUID()));
  const afterExplicitReads = [];
  await f.run({ observeRead: row => afterExplicitReads.push(row) }); assert.deepEqual(afterExplicitReads, []);
  await collectionIngress('claude', { ...f.payload, prompt_id: later }, { ...f.options, launch: () => assert.fail('completed explicit scope must not prevent suspension') });
  const resumed = await controlCapture(f.capability, { selection: { ...identity, unitId: later }, sourcePath: f.source,
    expectedSourceIdentity: current.state.source.fileIdentity, expectedSelectionHash: captured.hash, operationId: randomUUID(), operation: 'resume' });
  const boundary = randomUUID(), last = randomUUID(), floor = resumed.state.intervals.at(-1).lower.eofByte;
  await fs.appendFile(f.source, message('user', 'Resume boundary', boundary) + message('user', 'New work', last));
  const resumeReads = [], resumedRun = await f.run({ observeRead: row => resumeReads.push(row) });
  assert.equal(resumedRun.saved, 1);
  assert(resumeReads.filter(row => row.purpose === 'range').every(row => row.offset >= floor));
});

for (const partial of [false, true]) test(`Claude pause suspends unresolved boundaries${partial ? ' with a partial tail' : ''} without reading later bytes`, async t => {
  const { controlCapture } = await import('./test-support/capture-workflow.mjs');
  const f = await fixture(t), P = randomUUID(); let previous = null;
  const message = (type, text, promptId) => {
    const value = { type, uuid: randomUUID(), parentUuid: previous, timestamp: stamp, sessionId: S, version: '2.1.280',
      isSidechain: false, cwd: f.project, message: { role: type, content: text }, ...(promptId ? { promptId } : {}) };
    previous = value.uuid; return JSON.stringify(value) + '\n';
  };
  await fs.writeFile(f.source, message('system', '')); await collectionIngress('claude', { ...f.payload, prompt_id: A }, f.options);
  await fs.appendFile(f.source, message('user', 'Boundary', A)); await f.run();
  await fs.appendFile(f.source, message('user', 'Awaiting upper anchor', B));
  const pauseRow = message('user', 'Pause', P), prefix = partial ? pauseRow.slice(0, 30) : '';
  await fs.appendFile(f.source, prefix);
  const selected = await readSelection(f.store, { client: 'claude', sessionId: S });
  const paused = await controlCapture(f.capability, { selection: { client: 'claude', sessionId: S, cwd: f.project, unitId: P }, sourcePath: f.source,
    expectedSourceIdentity: selected.state.source.fileIdentity, expectedSelectionHash: selected.hash, operationId: randomUUID(), operation: 'pause' });
  await fs.appendFile(f.source, pauseRow.slice(prefix.length));
  const reads = [], first = await f.run({ observeRead: row => reads.push(row) });
  assert.equal(first.saved, 0); assert(first.pending.includes('anchor-unresolved'));
  assert(reads.every(row => row.offset + row.bytes <= paused.state.intervals[0].upper.eofByte));
  const again = []; await f.run({ observeRead: row => again.push(row) }); assert.deepEqual(again, []);
  await collectionIngress('claude', { ...f.payload, prompt_id: P }, { ...f.options, launch: () => assert.fail('must stay suspended') });
});

test('a temporary head read failure is retried inside the frozen Claude pause window', async t => {
  const { controlCapture } = await import('./test-support/capture-workflow.mjs');
  const f = await fixture(t), P = randomUUID(); let previous = null;
  const message = (type, text, promptId) => {
    const value = { type, uuid: randomUUID(), parentUuid: previous, timestamp: stamp, sessionId: S, version: '2.1.280',
      isSidechain: false, cwd: f.project, message: { role: type, content: text }, ...(promptId ? { promptId } : {}) };
    previous = value.uuid; return JSON.stringify(value) + '\n';
  };
  await fs.writeFile(f.source, message('system', '')); await collectionIngress('claude', { ...f.payload, prompt_id: A }, f.options);
  await fs.appendFile(f.source, message('user', 'Boundary', A) + message('user', 'Initial human evidence', B));
  assert.equal((await f.run()).saved, 1);
  await fs.appendFile(f.source, message('user', 'Additional human evidence', B) + message('user', 'Pause', P));
  const selected = await readSelection(f.store, { client: 'claude', sessionId: S });
  await controlCapture(f.capability, { selection: { client: 'claude', sessionId: S, cwd: f.project, unitId: P }, sourcePath: f.source,
    expectedSourceIdentity: selected.state.source.fileIdentity, expectedSelectionHash: selected.hash, operationId: randomUUID(), operation: 'pause' });
  const open = fs.open, headFile = path.join(f.collection.intakeStateDir, 'heads/claude', S, `${B}.json`);
  fs.open = async (file, ...args) => { if (file === headFile) throw Object.assign(new Error('temporary'), { code: 'EACCES' }); return open(file, ...args); };
  try { assert((await f.run()).pending.includes('EACCES')); } finally { fs.open = open; }
  const retried = await f.run(); assert.equal(retried.saved, 1);
  const head = await readCaptureHead(f.store, { client: 'claude', sessionId: S, unitId: B });
  assert.match(JSON.stringify(head.capture.evidence), /Additional human evidence/);
});

test('workers that encounter a live lock or offline maintenance preserve the existing notice', async t => {
  const f = await fixture(t), { collectionStatusPath, publishIngressMetadata } = await import('./collection-ingress.mjs');
  await collectionIngress('codex', f.payload, f.options);
  await publishIngressMetadata(f.store, collectionStatusPath, { status: 'idle', pending: [], updatedAt: stamp });
  const before = await intakeSnapshot(f.store, 'state', collectionStatusPath);
  await withIntakeLock(f.store, async () => {
    const result = await f.run(); assert(result.pending.includes('INTAKE_BLOCKED'));
    assert.equal((await intakeSnapshot(f.store, 'state', collectionStatusPath)).hash, before.hash);
  });
  const marker = path.join(f.collection.intakeStateDir, '.intake-maintenance');
  await fs.writeFile(marker, '{}', { mode: 0o600 });
  const writes = [], open = fs.open, mkdir = fs.mkdir, rename = fs.rename, unlink = fs.unlink;
  fs.open = async (file, flags, ...args) => { if (typeof flags === 'string' && /[wax+]/.test(flags)) writes.push(file); return open(file, flags, ...args); };
  fs.mkdir = async (...args) => { writes.push(args[0]); return mkdir(...args); };
  fs.rename = async (...args) => { writes.push(args[1]); return rename(...args); };
  fs.unlink = async (...args) => { writes.push(args[0]); return unlink(...args); };
  try { const result = await f.run(); assert(result.pending.includes('INTAKE_OFFLINE_MAINTENANCE')); assert.deepEqual(writes, []); }
  finally { Object.assign(fs, { open, mkdir, rename, unlink }); }
  assert.equal((await intakeSnapshot(f.store, 'state', collectionStatusPath)).hash, before.hash);
});

test('a scope result is a reader block when any turn is held on one, not only the first', () => {
  assert.equal(readerBlockOf({ pending: 'terminal-not-persisted', holds: ['terminal-not-persisted', 'UNSUPPORTED_CLAUDE_CONTENT'] }), 'UNSUPPORTED_CLAUDE_CONTENT');
  assert.equal(readerBlockOf({ pending: 'INVALID_SESSION_RECORD', holds: ['INVALID_SESSION_RECORD'] }), 'INVALID_SESSION_RECORD');
  assert.equal(readerBlockOf({ pending: 'CLAUDE_HISTORY_REQUIRES_REVIEW' }), 'CLAUDE_HISTORY_REQUIRES_REVIEW');
  // A page reservation at its limit fails every later visit the same way.
  assert.equal(readerBlockOf({ pending: 'READER_CHECKPOINT_ALLOCATION_CAPACITY' }), 'READER_CHECKPOINT_ALLOCATION_CAPACITY');
  // So does saved reader progress that is malformed or no longer matches its root.
  for (const code of ['INVALID_READER_CHECKPOINT', 'READER_PAGE_CONFLICT']) assert.equal(readerBlockOf({ pending: code }), code);
  // A turn captured by a newer reader version is held on every pass.
  assert.equal(readerBlockOf({ pending: 'terminal-not-persisted', holds: ['terminal-not-persisted', 'UNSUPPORTED_CLAUDE_READER'] }), 'UNSUPPORTED_CLAUDE_READER');
  assert.equal(readerBlockOf({ pending: 'terminal-not-persisted', holds: ['terminal-not-persisted'] }), null);
  assert.equal(readerBlockOf({ saved: 1, pending: null, drained: true }), null);
});

test('hook notices scope session diagnostics and do not revive historical lock contention', () => {
  const other = randomUUID(), notice = { pending: ['SOURCE_IDENTITY_MISMATCH', 'INTAKE_BLOCKED'],
    diagnostics: [{ client: 'codex', sessionId: other, code: 'SOURCE_IDENTITY_MISMATCH' }] };
  const result = { status: 'queued', notice, selection: { client: 'codex', sessionId: S, unitId: A } };
  let text = collectionHookOutput(result, 'UserPromptSubmit').hookSpecificOutput.additionalContext;
  assert.doesNotMatch(text, /SOURCE_IDENTITY_MISMATCH|intake busy|offline recovery/);
  result.selection.sessionId = other;
  text = collectionHookOutput(result, 'UserPromptSubmit').hookSpecificOutput.additionalContext;
  assert.match(text, /Session diagnostic: SOURCE_IDENTITY_MISMATCH/);
});

test('a whole-pass budget stop stays visible to sessions the worker did not reach', async t => {
  const f = await fixture(t); await collectionIngress('codex', f.payload, f.options);
  const file = path.join(f.collection.intakeStateDir, registrationPath({ client: 'codex', sessionId: S }));
  const open = fs.open; let fired = false;
  fs.open = async (name, ...args) => {
    if (!fired && name === file) { fired = true; throw Object.assign(new Error('budget exhausted'), { code: 'WORKER_READ_BUDGET' }); }
    return open(name, ...args);
  };
  let result;
  try { result = await f.run({ trigger: { client: 'codex', sessionId: S } }); }
  finally { fs.open = open; }
  assert(fired); assert(result.pending.includes('WORKER_READ_BUDGET'));
  assert(!result.diagnostics.some(item => item.code === 'WORKER_READ_BUDGET'));
  const text = collectionHookOutput({ status: 'queued', notice: result,
    selection: { client: 'codex', sessionId: randomUUID(), unitId: B } }, 'UserPromptSubmit').hookSpecificOutput.additionalContext;
  assert.match(text, /Diagnostic for all captured sessions: WORKER_READ_BUDGET/);
});
