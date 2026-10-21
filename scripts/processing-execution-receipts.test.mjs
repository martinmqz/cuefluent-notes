import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture } from './test-support/processing-fixture.mjs';
import { processingExecutionCallbacks, createProcessingExecutionResolver, recordProcessingExecution, findCompletedProcessingExecution } from './processing-execution-receipts.mjs';
import { reconcileCompletedProcessingExecution } from './processing-chat-recovery.mjs';
import { openWorkflowIntake, withIntakeLock } from './intake-io.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { controlSelection, readCaptureHead, readSelection } from './intake-store.mjs';
import { readCodexSelection } from './codex-reader.mjs';
import { verifyProcessingExecution, isProcessingExecutionProof } from './processing-execution-proof.mjs';
import { digest, canonicalJSON } from './workflow-values.mjs';

async function fixture(t) {
  const f = await processingFixture(t), sid = randomUUID(), uid = randomUUID(), iid = randomUUID();
  const file = path.join(f.selection.cwd, `${sid}.jsonl`), prompt = 'Process the selected evidence through the engine.';
  const session = { client: 'codex', sessionId: sid, sourcePath: file, cwd: f.selection.cwd,
    profileId: digest('profile'), toolContractHash: digest('contract') };
  const header = { timestamp: '2026-10-10T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: {
    id: sid, session_id: sid, cli_version: '0.157.1', source: 'cli', history_mode: 'paginated', cwd: session.cwd } };
  const prefix = JSON.stringify(header) + '\n';
  await fs.writeFile(file, prefix, { mode: 0o600 });
  const context = { client: 'codex', session, requestId: iid, inputId: iid, inputHash: digest(prompt), selection: f.selection };
  const callbacks = processingExecutionCallbacks({ capability: f.capability });
  await callbacks.beforeExecution(context);
  const rows = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: uid, root_turn_id: uid } },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'input',
      content: [{ type: 'input_text', text: prompt }],
      internal_chat_message_metadata_passthrough: { turn_id: uid, content_item_kinds: ['user.text'] } } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: sid, turn_id: uid,
      item: { type: 'UserMessage', id: 'input-native', content: [{ type: 'text', text: prompt, text_elements: [] }] } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'answer',
      content: [{ type: 'output_text', text: 'No durable change.' }], internal_chat_message_metadata_passthrough: { turn_id: uid } } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: sid, turn_id: uid,
      item: { type: 'AgentMessage', id: 'answer-native', content: [{ type: 'Text', text: 'No durable change.' }] } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: uid, last_agent_message: 'No durable change.' } },
  ];
  let offset = Buffer.byteLength(prefix);
  const anchors = [], lines = rows.map((row, index) => {
    const line = JSON.stringify({ timestamp: '2026-10-10T00:01:00.000Z', ordinal: index + 1, ...row }) + '\n';
    const anchor = { id: `codex:ordinal:${index + 1}`, startByte: offset, endByte: offset + Buffer.byteLength(line), hash: digest(Buffer.from(line)) };
    offset = anchor.endByte; anchors.push(anchor); return line;
  });
  await fs.appendFile(file, lines.join(''));
  const source = { client: 'codex', sessionId: sid, projectRoot: session.cwd, path: file,
    fileIdentity: stableSourceIdentity(await fs.lstat(file, { bigint: true })) };
  const query = { client: 'codex', sessionId: sid, unitId: uid };
  const request = { source, unitId: uid, fromByte: anchors[0].startByte, endByte: offset };
  const store = await openWorkflowIntake(f.capability, f.selection, 'explicitProcess');
  return { ...f, callbacks, context, source, query, request, store, anchors, rows, sid, uid, file };
}

test('completed restricted execution seals immutable metadata; replay is idempotent and forged proof is refused', async t => {
  const f = await fixture(t);
  const proof = await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  assert.equal(isProcessingExecutionProof(proof), true);
  const inspect = () => withIntakeLock(f.store, async tx => {
    const resolver = createProcessingExecutionResolver(tx, { source: f.source, authorize: async () => true });
    const receipt = await resolver(f.query);
    assert.equal(receipt.recordsHash, proof.recordsHash);
    assert.equal(isProcessingExecutionProof(await verifyProcessingExecution(f.request, { resolveExecution: resolver })), true);
    await assert.rejects(recordProcessingExecution(tx, receipt, structuredClone(proof)), { code: 'PROCESSING_EXECUTION_UNVERIFIED' });
    return receipt;
  });
  const first = await inspect();
  await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  assert.deepEqual(await inspect(), first);
  assert(!JSON.stringify(first).includes('No durable change.'));
  await fs.appendFile(f.file, '\n');
  await assert.rejects(f.callbacks.afterExecution({ ...f.context, result: { unitId: randomUUID() } }), { code: 'PROCESSING_EXECUTION_UNVERIFIED' });
});

test('recovery finds only the sealed current request and verifies its exact completed native range', async t => {
  const f = await fixture(t);
  const args = { capability: f.capability, session: f.context.session,
    request: { requestId: f.context.requestId, inputHash: f.context.inputHash, selection: f.selection } };
  assert.equal(await reconcileCompletedProcessingExecution(args), null, 'unsealed native output is not completion authority');
  await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  const recovered = await reconcileCompletedProcessingExecution(args);
  assert.equal(isProcessingExecutionProof(recovered.proof), true);
  assert.deepEqual(recovered.nativeRun, { runId: f.uid, inputId: f.context.inputId, unitIds: [f.uid] });
  const find = options => withIntakeLock(f.store, tx => findCompletedProcessingExecution(tx, {
    session: f.context.session, requestId: f.context.requestId, inputHash: f.context.inputHash, authorize: async () => true, ...options,
  }));
  assert.equal(await find({ requestId: randomUUID() }), null);
  await assert.rejects(find({ inputHash: digest('another request') }), { code: 'PROCESSING_EXECUTION_CONFLICT' });
  await assert.rejects(find({ authorize: async () => false }), { code: 'INTAKE_NOT_AUTHORIZED' });
  const metadata = { ordinal: f.rows.length + 1, type: 'event_msg', payload: { type: 'thread_settings_applied',
    thread_id: f.sid, thread_settings: { cwd: f.source.projectRoot, approval_policy: 'never' } } };
  await fs.appendFile(f.file, JSON.stringify(metadata) + '\n');
  assert.equal(isProcessingExecutionProof((await reconcileCompletedProcessingExecution(args)).proof), true);
  await fs.appendFile(f.file, JSON.stringify({ ordinal: f.rows.length + 2, type: 'event_msg',
    payload: { type: 'task_started', turn_id: randomUUID() } }) + '\n');
  assert.equal(await reconcileCompletedProcessingExecution(args), null, 'a later native run must not inherit completion');
});

test('exact request recovery stays bounded after more than 128 immutable session receipts', async t => {
  const f = await fixture(t); await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  const directory = path.join(f.collection.intakeStateDir, 'processing-executions', 'codex', f.sid);
  const receiptBytes = await fs.readFile(path.join(directory, `${f.uid}.json`));
  const receipt = JSON.parse(receiptBytes), historical = [];
  for (let index = 0; index < 130; index++) {
    const unitId = randomUUID(), requestId = randomUUID(), file = path.join(directory, `${unitId}.json`);
    const bytes = canonicalJSON({ ...receipt, unitId, requestId, inputId: requestId }) + '\n';
    await fs.writeFile(file, bytes, { mode: 0o600 }); historical.push({ file, bytes });
  }
  const opendir = fs.opendir;
  t.mock.method(fs, 'opendir', (file, ...args) => {
    assert.notEqual(file, directory, 'indexed recovery must not enumerate lifetime session receipts');
    return opendir(file, ...args);
  });
  const recovered = await reconcileCompletedProcessingExecution({ capability: f.capability, session: f.context.session,
    request: { requestId: f.context.requestId, inputHash: f.context.inputHash, selection: f.selection } });
  assert.equal(isProcessingExecutionProof(recovered.proof), true); assert.equal(recovered.nativeRun.runId, f.uid);
  assert.deepEqual(await fs.readFile(path.join(directory, `${f.uid}.json`)), receiptBytes);
  for (const { file, bytes } of historical) assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('proof-sealed request lookup survives an interrupted unit projection and retries immutably', async t => {
  const f = await fixture(t); await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  const requestFile = path.join(f.collection.intakeStateDir, 'processing-execution-requests', 'codex', f.sid, `${f.context.requestId}.json`);
  const unitFile = path.join(f.collection.intakeStateDir, 'processing-executions', 'codex', f.sid, `${f.uid}.json`);
  const bytes = await fs.readFile(requestFile); assert.deepEqual(await fs.readFile(unitFile), bytes);
  await fs.unlink(unitFile);
  const recovered = await reconcileCompletedProcessingExecution({ capability: f.capability, session: f.context.session,
    request: { requestId: f.context.requestId, inputHash: f.context.inputHash, selection: f.selection } });
  assert.equal(isProcessingExecutionProof(recovered.proof), true);
  await withIntakeLock(f.store, async tx => {
    assert.equal(await createProcessingExecutionResolver(tx, { source: f.source, authorize: async () => true })(f.query), null);
  });
  await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  assert.deepEqual(await fs.readFile(requestFile), bytes); assert.deepEqual(await fs.readFile(unitFile), bytes);
});

test('request lookup refuses mismatched native identity, altered metadata and conflicting unit projections', async t => {
  const f = await fixture(t); await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  const requestFile = path.join(f.collection.intakeStateDir, 'processing-execution-requests', 'codex', f.sid, `${f.context.requestId}.json`);
  const unitFile = path.join(f.collection.intakeStateDir, 'processing-executions', 'codex', f.sid, `${f.uid}.json`);
  const requestBytes = await fs.readFile(requestFile), unitBytes = await fs.readFile(unitFile);
  const find = options => withIntakeLock(f.store, tx => findCompletedProcessingExecution(tx, {
    session: f.context.session, requestId: f.context.requestId, inputHash: f.context.inputHash, authorize: async () => true, ...options,
  }));
  for (const change of [{ profileId: digest('other profile') }, { toolContractHash: digest('other tools') },
    { sourcePath: path.join(f.selection.cwd, 'other-session.jsonl') }]) {
    await assert.rejects(find({ session: { ...f.context.session, ...change } }), { code: 'PROCESSING_EXECUTION_CONFLICT' });
  }
  const changed = { ...JSON.parse(requestBytes), requestId: randomUUID() };
  await fs.writeFile(requestFile, canonicalJSON(changed) + '\n');
  await assert.rejects(find(), { code: 'PROCESSING_EXECUTION_CONFLICT' });
  await assert.rejects(f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } }), { code: 'PROCESSING_EXECUTION_CONFLICT' });
  assert.deepEqual(await fs.readFile(unitFile), unitBytes, 'conflicting request metadata must not rewrite the existing unit receipt');
  await fs.writeFile(requestFile, requestBytes);
  await fs.writeFile(unitFile, canonicalJSON({ ...JSON.parse(unitBytes), recordsHash: digest('altered native bytes') }) + '\n');
  await assert.rejects(find(), { code: 'PROCESSING_EXECUTION_CONFLICT' });
  await assert.rejects(withIntakeLock(f.store, tx => createProcessingExecutionResolver(tx,
    { source: f.source, authorize: async () => true })(f.query)), { code: 'PROCESSING_EXECUTION_CONFLICT' });
  assert.deepEqual(await fs.readFile(requestFile), requestBytes);
});

test('unit-only receipts grant no recovery or collection exclusion and are never migrated', async t => {
  const f = await fixture(t); await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  const requestFile = path.join(f.collection.intakeStateDir, 'processing-execution-requests', 'codex', f.sid, `${f.context.requestId}.json`);
  const unitFile = path.join(f.collection.intakeStateDir, 'processing-executions', 'codex', f.sid, `${f.uid}.json`);
  const bytes = await fs.readFile(unitFile); await fs.unlink(requestFile);
  const directory = path.dirname(unitFile), opendir = fs.opendir;
  t.mock.method(fs, 'opendir', (file, ...args) => {
    assert.notEqual(file, directory, 'missing request authority must not trigger a unit-history scan');
    return opendir(file, ...args);
  });
  const recovered = await reconcileCompletedProcessingExecution({ capability: f.capability, session: f.context.session,
    request: { requestId: f.context.requestId, inputHash: f.context.inputHash, selection: f.selection } });
  assert.equal(recovered, null);
  await withIntakeLock(f.store, async tx => {
    const resolver = createProcessingExecutionResolver(tx, { source: f.source, authorize: async () => true });
    assert.equal(await resolver(f.query), null);
    assert.equal(await verifyProcessingExecution(f.request, { resolveExecution: resolver }), null);
  });
  await assert.rejects(f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } }), { code: 'PROCESSING_EXECUTION_CONFLICT' });
  assert.deepEqual(await fs.readFile(unitFile), bytes);
  await assert.rejects(fs.stat(requestFile), { code: 'ENOENT' });
});

test('recovery refuses changed source bytes and disabled current policy without editing claims or receipts', async t => {
  const f = await fixture(t); await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  const args = { capability: f.capability, session: f.context.session,
    request: { requestId: f.context.requestId, inputHash: f.context.inputHash, selection: f.selection } };
  const original = await fs.readFile(f.file, 'utf8');
  await fs.writeFile(f.file, original.replaceAll('No durable change.', 'A modified result.'));
  assert.equal(await reconcileCompletedProcessingExecution(args), null);
  await fs.writeFile(f.file, original);
  f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  await assert.rejects(reconcileCompletedProcessingExecution(args), { code: 'WORKFLOW_POLICY_CHANGED' });
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('known interrupted native output seals recovery metadata but grants no collection exclusion', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.file, 'utf8');
  await fs.writeFile(f.file, original.replace('"type":"task_complete"', '"type":"turn_aborted","reason":"interrupted"'));
  const context = { ...f.context, result: { unitId: f.uid, status: 'interrupted' } };
  const proof = await f.callbacks.afterInterruptedExecution(context);
  assert.equal(proof.terminal, 'interrupted');
  await withIntakeLock(f.store, async tx => {
    const resolver = createProcessingExecutionResolver(tx, { source: f.source, authorize: async () => true });
    const receipt = await resolver(f.query);
    assert.equal(receipt.terminal, 'interrupted');
    assert.equal(await verifyProcessingExecution({ ...f.request, endByte: proof.endByte }, { resolveExecution: resolver }), null);
  });
  const recovered = await reconcileCompletedProcessingExecution({ capability: f.capability, session: f.context.session,
    request: { requestId: f.context.requestId, inputHash: f.context.inputHash, selection: f.selection } });
  assert.equal(recovered.nativeRun.terminal, 'interrupted');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('sealed execution is excluded on later selected collection while immutable earlier captures remain untouched', async t => {
  const f = await fixture(t); await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  const scopeId = randomUUID(), selectedStore = await openWorkflowIntake(f.capability,
    { client: 'codex', sessionId: f.sid, cwd: f.source.projectRoot }, 'collect');
  const authorize = async () => true;
  await withIntakeLock(selectedStore, async tx => {
    const selected = await controlSelection(tx, { source: f.source, expectedHash: null, authorize,
      request: { id: scopeId, client: 'codex', sessionId: f.sid, expectedRevision: 0, operation: 'capture-historical',
        scope: { unitIds: [f.uid], start: f.anchors[0], end: f.anchors.at(-1),
          contentHash: digest((await fs.readFile(f.source.path)).subarray(f.anchors[0].startByte, f.anchors.at(-1).endByte)) } } });
    const result = await readCodexSelection({ state: selected.state, scopeId,
      loadHead: unitId => readCaptureHead(selectedStore, { client: 'codex', sessionId: f.sid, unitId }),
      resolveProcessingExecution: createProcessingExecutionResolver(tx, { source: f.source, authorize }) });
    assert.equal(result.blocked, null); assert.deepEqual(result.candidates, []);
    assert.equal(result.processingControls.length, 1); assert.equal(result.eligibility.get(f.uid), 'excluded');
    assert.equal((await readSelection(selectedStore, { client: 'codex', sessionId: f.sid })).hash, selected.hash);
  });
});

test('changed source bytes and revoked authority cannot inherit an execution exclusion', async t => {
  const f = await fixture(t); await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid } });
  await withIntakeLock(f.store, async tx => {
    const denied = createProcessingExecutionResolver(tx, { source: f.source, authorize: async () => false });
    await assert.rejects(denied(f.query), { code: 'INTAKE_NOT_AUTHORIZED' });
    const resolver = createProcessingExecutionResolver(tx, { source: f.source, authorize: async () => true });
    const bytes = await fs.readFile(f.file, 'utf8');
    await fs.writeFile(f.file, bytes.replaceAll('No durable change.', 'An actual change..'));
    assert.equal(await verifyProcessingExecution(f.request, { resolveExecution: resolver }), null);
  });
});

test('failed Codex execution remains failed through immutable receipt lookup and recovery', async t => {
  const f = await fixture(t);
  const proof = await f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid, status: 'failed' } });
  assert.equal(proof.terminal, 'failed');
  await withIntakeLock(f.store, async tx => {
    const resolver = createProcessingExecutionResolver(tx, { source: f.source, authorize: async () => true });
    assert.equal((await resolver(f.query)).terminal, 'failed');
    assert.equal(await verifyProcessingExecution(f.request, { resolveExecution: resolver }), null,
      'a failed execution must not acquire completed-output exclusion authority');
  });
  const args = { capability: f.capability, session: f.context.session,
    request: { requestId: f.context.requestId, inputHash: f.context.inputHash, selection: f.selection } };
  const recovered = await reconcileCompletedProcessingExecution(args);
  assert.equal(recovered.nativeRun.terminal, 'failed'); assert.equal(recovered.proof.terminal, 'failed');
  assert.deepEqual(recovered.nativeRun.unitIds, [f.uid]);
  // An interrupted registry finish cannot change the terminal on retry.
  await assert.rejects(f.callbacks.afterExecution({ ...f.context, result: { unitId: f.uid, status: 'completed' } }),
    { code: 'PROCESSING_EXECUTION_CONFLICT' });
  assert.equal((await reconcileCompletedProcessingExecution(args)).nativeRun.terminal, 'failed');
});
