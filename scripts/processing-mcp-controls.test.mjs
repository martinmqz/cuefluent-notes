import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { processingFixture } from './test-support/processing-fixture.mjs';
import { deferred, body, selectedInput, harness, prepareFromPending, draft, proposeThroughTools, proposeInChat } from './test-support/processing-mcp.mjs';
import { processingControlAction } from './processing-control-proof.mjs';
import { readSelection, controlSelection, readCaptureHead } from './intake-store.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { inspectProcessing } from './processing.mjs';
import { resolveProcessingInvocation } from './processing-native-invocation.mjs';
import { openWorkflowIntake, withIntakeLock, replaceIntakeJSON, intakePath } from './intake-io.mjs';
import { collectionIngress, registrationPath, publishIngressMetadata, collectionStatusPath } from './collection-ingress.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { processScope, READER_BLOCK_CODES, readReaderBlock } from './collection-worker.mjs';
import { COLLECTION_STOP_CODES } from './processing-control-server.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { runCollectionWorker } from './test-support/capture-workflow.mjs';
import { workflowTimeout } from './workflow-budget.mjs';

test('MCP admission returns while native processing is pending, and shutdown waits for its owned finite job', async t => {
  const f = await processingFixture(t), h = await harness(t, f), gate = deferred(); h.release = gate.resolve;
  h.script = async call => { await gate.promise; await call('processing_pending', {}); };
  const requestId = randomUUID();
  const admitted = body(await h.call('process_selected_captures', { collectionId: f.collection.id, requestId }));
  assert.equal(admitted.status, 'busy'); assert.notEqual(admitted.requestId, requestId);
  assert.equal(admitted.statusDetail, 'accepted');
  assert.equal(admitted.statusText, 'Cuefluent: Processing request accepted. Scope: all projects of this notes folder or file.');
  h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(status.status, 'busy'); assert.equal(status.chat.sessionId, admitted.chat.sessionId);
  assert.equal(status.statusDetail, 'processing');
  assert.match(status.statusText, /^Cuefluent: Processing is in progress\. Scope: all projects of this notes folder or file\. Inventory/);
  const duplicate = body(await h.call('process_selected_captures', { collectionId: f.collection.id, requestId }));
  assert.equal(duplicate.status, 'busy'); assert.deepEqual(duplicate.diagnostics, ['PROCESSING_CHAT_BUSY']);
  assert.equal(duplicate.requestId, admitted.requestId);
  assert.equal(duplicate.statusDetail, 'already-processing');
  assert.match(duplicate.statusText, /Already processing; no additional run was started/);
  // The code stays in the field; the visible text says where to see it.
  assert.doesNotMatch(duplicate.statusText, /PROCESSING_/);
  assert.match(duplicate.statusText, /For details, type \S+ status --verbose\.$/);
  h.end(); let ended = false; h.server.then(() => { ended = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, false); assert.equal(h.closes, 0);
  gate.resolve(); await h.server;
  await h.jobs[0]; // Cancelling the completed admission cannot abort its accepted run.
  assert.equal(h.opens, 1); assert.equal(h.creates, 1); assert.equal(h.dispatches, 1); assert.equal(h.closes, 1);
  assert(!JSON.stringify(h.responses).includes('PRIVATE SYNTHETIC DRAFT'));
  assert(!JSON.stringify(h.responses).includes(f.root));
});

test('status exposes unfinished evidence, incompatible source scope and conflicts without dispatching', async t => {
  const f = await processingFixture(t), config = await fs.readFile(f.options.configPath), h = await harness(t, f);
  h.script = async call => {
    await prepareFromPending(call, f);
  };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', { collectionId: f.collection.id });
  await closed;
  const before = await inspectProcessing(f.capability, f.operationId);
  const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(status.status, 'idle');
  assert.equal(status.statusDetail, 'unfinished');
  assert.match(status.statusText, /^Cuefluent: Processing stopped with unfinished work\. Scope: all projects of this notes folder or file\. Inventory/);
  assert.equal(status.nextAction, 'resume');
  assert.equal(h.dispatches, 1);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), before);
  assert.deepEqual(await fs.readFile(f.options.configPath), config);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  h.inspectOperation = async () => ({ ...before, recoveryRequired: true });
  assert.equal(body(await h.call('processing_status', { collectionId: f.collection.id })).nextAction, 'inspect');
  h.inspectOperation = async () => { throw new Error('private unreadable state'); };
  const unknown = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(unknown.statusDetail, 'unfinished'); assert.equal(unknown.nextAction, 'inspect');
  assert.deepEqual(unknown.diagnostics, ['PROCESSING_OPERATION_OUTCOME_UNKNOWN']);
  h.inspectOperation = undefined;
  const other = await processingFixture(t, { base: f }), otherHost = await harness(t, other);
  const otherStatus = body(await otherHost.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(otherStatus.statusDetail, 'unfinished');
  assert.equal(otherStatus.nextAction, 'resume');
  assert.equal(otherHost.dispatches, 0);
  // A changed input offers cancellation without refreshing the frozen claim.
  const headFile = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const head = JSON.parse(await fs.readFile(headFile, 'utf8'));
  head.generation++; head.previousHash = f.published.headHash;
  await fs.writeFile(headFile, canonicalJSON(head) + '\n');
  const conflicted = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(conflicted.statusDetail, 'blocked');
  assert.equal(conflicted.nextAction, 'cancel');
  assert.deepEqual(conflicted.diagnostics, ['PROCESSING_SELECTION_CHANGED']);
  assert.equal(h.dispatches, 1);
});

test('a completed unchanged operation is inactive without implying saved notes or an empty collection', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  await processingFixture(t, { base: f });
  h.script = async call => {
    let claim = await prepareFromPending(call, f);
    for (let page = 0; page < claim.packet.pages.length; page++) {
      const read = await call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page });
      claim = await call('processing_ack', { operationId: f.operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
    }
    await call('processing_complete', { operationId: f.operationId, expectedClaimHash: claim.claimHash });
  };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(status.statusDetail, 'selection-complete'); assert.equal(status.nextAction, 'none');
  assert.match(status.statusText, /^Cuefluent: The selected captured turns have been handled\./);
  assert.equal(status.inventory.pending, 0);
  assert.equal(h.dispatches, 1); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('a request during terminal cleanup waits and then resumes the existing native session', async t => {
  const f = await processingFixture(t), h = await harness(t, f), gate = deferred(), entered = deferred();
  h.release = gate.resolve;
  h.beforeClose = async () => { entered.resolve(); await gate.promise; };
  await h.call('process_selected_captures', { collectionId: f.collection.id });
  await entered.promise;
  let returned = false;
  const next = h.call('process_selected_captures', { collectionId: f.collection.id }).then(value => { returned = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false); assert.equal(h.dispatches, 1);
  gate.resolve();
  assert.equal(body(await next).statusDetail, 'accepted');
  await Promise.all(h.jobs);
  assert.equal(h.dispatches, 2); assert.equal(h.creates, 1);
});

test('cancellation during admission aborts the owned job without dispatch or response and leaves the chat reusable', async t => {
  const f = await processingFixture(t), gate = deferred(), entered = deferred();
  const h = await harness(t, f, { execution: { async guardExecution() {}, async afterExecution() {},
    async beforeExecution() { entered.resolve(); await gate.promise; } } });
  h.release = gate.resolve; h.nativeSkill = true;
  const closed = h.whenClosed();
  void h.call('process_selected_captures', { collectionId: f.collection.id });
  await entered.promise;
  h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  await h.send({ jsonrpc: '2.0', id: 100, method: 'ping' });
  assert(!h.responses.some(row => row.id === 1)); assert.equal(h.dispatches, 0);
  gate.resolve(); await closed;
  await assert.rejects(h.jobs[0], { code: 'PROCESSING_CONTROL_CANCELLED' });
  assert.equal(body(await h.call('processing_status', { collectionId: f.collection.id })).status, 'idle');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  await assert.rejects(fs.stat(path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest('call_1').slice(0, 24)}.json`)), { code: 'ENOENT' });
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'missing');
  const nextClosed = h.whenClosed();
  assert.equal((await h.call('process_selected_captures', { collectionId: f.collection.id })).error, undefined);
  await nextClosed; assert.equal(h.dispatches, 1); assert.equal(h.creates, 1);
});

test('completed-request replay and status reuse durable state without another native dispatch', async t => {
  const f = await processingFixture(t), h = await harness(t, f), requestId = randomUUID(), closed = h.whenClosed();
  const first = body(await h.call('process_selected_captures', { collectionId: f.collection.id, requestId }));
  await closed;
  const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(status.status, 'idle'); assert.equal(status.chat.sessionId, first.chat.sessionId);
  h.callId = 'call_1';
  const replay = body(await h.call('process_selected_captures', { collectionId: f.collection.id, requestId }));
  assert.equal(replay.status, 'busy');
  assert.equal(replay.statusDetail, 'accepted'); assert.equal(replay.chat.sessionId, first.chat.sessionId);
  assert.equal(h.creates, 1); assert.equal(h.dispatches, 1); assert.equal(h.opens, h.closes);
  h.callId = undefined;
  const newClosed = h.whenClosed();
  const next = body(await h.call('process_selected_captures', { collectionId: f.collection.id, requestId }));
  await newClosed;
  assert.notEqual(next.requestId, first.requestId);
  assert.equal(h.creates, 1); assert.equal(h.dispatches, 2);
});

test('formal native-call replay preserves its original receipt after completion and reconnect', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true;
  const args = { collectionId: f.collection.id }, closed = h.whenClosed();
  const first = await h.call('process_selected_captures', args);
  assert.equal(body(first).status, 'busy'); await closed;
  const receiptFile = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest('call_1').slice(0, 24)}.json`);
  const bytes = await fs.readFile(receiptFile);
  h.callId = 'call_1';
  assert.deepEqual((await h.call('process_selected_captures', args)).result, first.result);
  assert.equal(h.dispatches, 1); assert.deepEqual(await fs.readFile(receiptFile), bytes);
  h.end(); await h.server;
  const again = await harness(t, f); again.nativeSkill = true; again.callId = 'call_1';
  assert.deepEqual((await again.call('process_selected_captures', args)).result, first.result);
  assert.equal(again.dispatches, 0); assert.equal(again.opens, 0);
  again.callId = undefined;
  assert.equal(body(await again.call('processing_status', args)).status, 'idle');
  assert.deepEqual(await fs.readFile(receiptFile), bytes);
});

test('formal replay preserves retained wording byte for byte across a reconnect', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true;
  const args = { collectionId: f.collection.id }, closed = h.whenClosed();
  await h.call('process_selected_captures', args); await closed;
  const receiptFile = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest('call_1').slice(0, 24)}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  // Keep the complete current receipt shape, with wording the current renderer
  // would not generate: replay must return the stored result, not rerender it.
  receipt.dispatch.response.statusText = 'Cuefluent: Synthetic retained response wording.';
  const result = { content: [{ type: 'text', text: canonicalJSON(receipt.dispatch.response) }], isError: false };
  receipt.dispatch.statusText = receipt.dispatch.response.statusText;
  receipt.dispatch.resultHash = digest(canonicalJSON(result));
  const bytes = canonicalJSON(receipt) + '\n'; await fs.writeFile(receiptFile, bytes);
  h.callId = 'call_1';
  assert.deepEqual((await h.call('process_selected_captures', args)).result, result);
  assert.equal(h.dispatches, 1); assert.equal(await fs.readFile(receiptFile, 'utf8'), bytes);
  h.end(); await h.server;
  const again = await harness(t, f); again.nativeSkill = true; again.callId = 'call_1';
  assert.deepEqual((await again.call('process_selected_captures', args)).result, result);
  assert.equal(again.dispatches, 0); assert.equal(again.opens, 0);
  assert.equal(await fs.readFile(receiptFile, 'utf8'), bytes);
});

test('formal replay rejects a changed stored response without changing its receipt or dispatching', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true;
  const args = { collectionId: f.collection.id }, closed = h.whenClosed();
  assert.equal((await h.call('process_selected_captures', args)).error, undefined); await closed;
  const receiptFile = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest('call_1').slice(0, 24)}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  receipt.dispatch.response.status = 'completed';
  receipt.dispatch.response.statusDetail = 'completed';
  const bytes = canonicalJSON(receipt) + '\n'; await fs.writeFile(receiptFile, bytes);
  h.callId = 'call_1';
  assert.equal((await h.call('process_selected_captures', args)).error.data.code, 'PROCESSING_CONTROL_FAILED');
  assert.equal(h.dispatches, 1); assert.equal(await fs.readFile(receiptFile, 'utf8'), bytes);
});

test('formal native-call replay while busy returns the original admission without another dispatch', async t => {
  const f = await processingFixture(t), h = await harness(t, f), gate = deferred();
  h.nativeSkill = true; h.release = gate.resolve; h.script = () => gate.promise;
  const args = { collectionId: f.collection.id }, first = await h.call('process_selected_captures', args);
  assert.equal(body(first).status, 'busy'); h.callId = 'call_1';
  const replay = await h.call('process_selected_captures', args);
  assert.deepEqual(replay.result, first.result); assert.equal(h.dispatches, 1);
  gate.resolve();
});

test('formal processing cannot replace its verified source selection with model arguments', async t => {
  for (const nested of [false, true]) await t.test(nested ? 'code-mode handshake' : 'direct native call', async t => {
    const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true; h.codeMode = nested;
    const row = await h.call('process_selected_captures', { collectionId: f.collection.id, requestId: randomUUID(),
      selection: { ...selectedInput(f), sessionId: randomUUID() } });
    assert.equal(row.error.data.code, 'PROCESSING_CONTROL_SELECTION_MISMATCH');
    assert.equal(h.opens, 0); assert.equal(h.dispatches, 0);
  });
});

test('formal processing existing evidence remains available with collection disabled', async t => {
  for (const nested of [false, true]) await t.test(nested ? 'code mode' : 'direct', async t => {
    const f = await processingFixture(t), config = JSON.parse(await fs.readFile(f.options.configPath, 'utf8'));
    config.routes[0].collection.enabled = false;
    const bytes = JSON.stringify(config); await fs.writeFile(f.options.configPath, bytes);
    f.options.expectedConfigHash = digest(bytes);
    f.capability = await verifyWorkflowStorage(f.options);
    f.store = await openWorkflowIntake(f.capability);
    const h = await harness(t, f); h.nativeSkill = true; h.codeMode = nested;
    const closed = h.whenClosed();
    const result = await h.call('process_selected_captures', { collectionId: f.collection.id });
    assert.equal(result.error, undefined);
    assert.deepEqual(body(result).diagnostics, []);
    await closed;
    assert.equal(h.dispatches, 1);
    assert.equal(body(await h.call('processing_status', { collectionId: f.collection.id })).status, 'idle');
    await assert.rejects(fs.lstat(path.join(f.collection.intakeStateDir, 'control-dispatch')), { code: 'ENOENT' });
  });
});

test('a status reply says when automatic collection stopped for this exact chat', async t => {
  const f = await processingFixture(t), h = await harness(t, f), store = await openWorkflowIntake(f.capability);
  const own = code => ({ client: f.identity.client, sessionId: f.identity.sessionId, code });
  const notice = diagnostics => publishIngressMetadata(store, collectionStatusPath, { status: 'pending', saved: 0,
    pending: diagnostics.map(item => item.code), diagnostics, boundaryExcluded: [], updatedAt: new Date().toISOString() });
  await notice([own('CLAUDE_HISTORY_REQUIRES_REVIEW'), { client: 'claude', sessionId: randomUUID(), code: 'UNSUPPORTED_SESSION_OWNERSHIP' }]);
  const stopped = body(await h.call('processing_status', {}));
  assert.deepEqual(stopped.collection, { state: 'stopped', code: 'CLAUDE_HISTORY_REQUIRES_REVIEW' });
  assert(stopped.statusText.includes('\n\nAutomatic capture has stopped for this chat: its transcript has a record Cuefluent Notes does not read past, ' +
    'for example a Remote Control connection in Claude Desktop or a session moved elsewhere. Turns captured before that point are kept; later turns of this chat are not captured.'));
  assert(!/[A-Z]{3,}_[A-Z_]+/.test(stopped.statusText));
  h.nativeSkill = true; h.typedControl = 'status --verbose';
  assert(body(await h.call('processing_status', {})).statusText.includes('\n- Automatic capture: stopped for this chat (CLAUDE_HISTORY_REQUIRES_REVIEW).'));
  h.nativeSkill = false; delete h.typedControl;
  // Another chat's stop, a boundary still pending or no record says nothing.
  for (const diagnostics of [[{ client: 'claude', sessionId: randomUUID(), code: 'CLAUDE_HISTORY_REQUIRES_REVIEW' }], [own('SOURCE_BOUNDARY_PENDING')]]) {
    await notice(diagnostics);
    const quiet = body(await h.call('processing_status', {}));
    assert.equal(quiet.collection, undefined); assert(!quiet.statusText.includes('Automatic capture has stopped'));
  }
  // The help list and a review reply never carry it.
  await notice([own('UNSUPPORTED_SESSION_OWNERSHIP')]);
  h.typedHelp = true;
  assert.equal(body(await h.call('processing_status', {})).collection, undefined);
  delete h.typedHelp;
  assert.equal(body(await h.call('processing_status', {})).collection.code, 'UNSUPPORTED_SESSION_OWNERSHIP');
  // With collection off for the chat, an old record says nothing.
  const config = JSON.parse(await fs.readFile(f.options.configPath, 'utf8'));
  config.routes[0].collection.enabled = false; await fs.writeFile(f.options.configPath, JSON.stringify(config));
  assert.equal(body(await h.call('processing_status', {})).collection, undefined);
});

test('read-only status and unconfigured collection lookup dispatch no model and write no configuration', async t => {
  const f = await processingFixture(t), config = await fs.readFile(f.options.configPath), before = await fs.readdir(f.collection.intakeStateDir);
  const h = await harness(t, f);
  assert.equal(body(await h.call('processing_status', { collectionId: f.collection.id })).status, 'missing');
  const missing = await h.call('process_selected_captures', { collectionId: 'not-configured', requestId: randomUUID() });
  assert.equal(missing.error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.equal(h.creates, 0); assert.equal(h.dispatches, 0); assert.equal(h.opens, 1); assert.equal(h.closes, 1);
  assert.deepEqual(await fs.readFile(f.options.configPath), config);
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
});

test('request admission closes its controller if initial status fails before a job is registered', async t => {
  const f = await processingFixture(t); let opened = 0, closed = 0;
  const h = await harness(t, f, { async openController() {
    opened++;
    return { async status() { throw Object.assign(new Error('private detail'), { code: 'WORKFLOW_POLICY_CHANGED' }); },
      async close() { closed++; } };
  } });
  const result = await h.call('process_selected_captures', { collectionId: f.collection.id, requestId: randomUUID() });
  assert.equal(result.error.data.code, 'WORKFLOW_POLICY_CHANGED'); assert.equal(opened, 1); assert.equal(closed, 1);
  assert(!JSON.stringify(result).includes('private detail'));
});

test('verified native skill admission writes its exact parent control receipt before returning status', async t => {
  const f = await processingFixture(t), h = await harness(t, f), gate = deferred(); h.release = gate.resolve; h.nativeSkill = true;
  h.script = async () => gate.promise;
  const requestId = randomUUID(), args = { collectionId: f.collection.id, requestId };
  const row = await h.call('process_selected_captures', args);
  assert.equal(row.error, undefined);
  const response = body(row);
  assert.equal(response.status, 'busy');
  const directory = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId);
  const files = await fs.readdir(directory); assert.equal(files.length, 1);
  const receipt = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'));
  assert.equal(receipt.dispatch.callId, 'call_1'); assert.equal(receipt.dispatch.unitId, f.identity.unitId);
  assert.equal(receipt.dispatch.argsHash, digest(canonicalJSON(args))); assert.equal(receipt.dispatch.resultHash, digest(canonicalJSON(row.result)));
  assert.equal(receipt.dispatch.statusText, 'Cuefluent: Processing request accepted. Scope: all projects of this notes folder or file.');
  assert.equal(receipt.dispatch.sourcePath, f.source.path);
  gate.resolve();
});

test('ordinary invocations do not fabricate parent-control receipts', async t => {
  const f = await processingFixture(t), h = await harness(t, f), closed = h.whenClosed();
  const row = await h.call('process_selected_captures', { collectionId: f.collection.id, requestId: randomUUID() });
  assert.equal(row.error, undefined); await closed;
  await assert.rejects(fs.lstat(path.join(f.collection.intakeStateDir, 'control-dispatch')), { code: 'ENOENT' });
});

test('implicit status skips an unrelated unprepared collection without creating its storage', async t => {
  const f = await processingFixture(t), config = JSON.parse(await fs.readFile(f.options.configPath, 'utf8'));
  const other = path.join(f.root, 'unprepared');
  config.collections.push({ id: 'unprepared', rawDir: path.join(other, 'raw'), intakeStateDir: path.join(other, 'state'),
    notes: { notesDir: path.join(other, 'notes'), writerStateDir: path.join(other, 'writer') } });
  config.routes.push({ ...config.routes[0], id: 'unprepared', projectRoot: path.join(f.root, 'other-project'), collectionId: 'unprepared' });
  const bytes = JSON.stringify(config); await fs.writeFile(f.options.configPath, bytes);
  f.options.expectedConfigHash = digest(bytes); f.capability = await verifyWorkflowStorage(f.options);
  f.store = await openWorkflowIntake(f.capability);
  const h = await harness(t, f);
  assert.equal(body(await h.call('processing_status', {})).status, 'missing');
  assert.equal(h.creates, 0);
  await assert.rejects(fs.lstat(other), { code: 'ENOENT' });
});

test('policy revocation at admission still refuses native dispatch without leaving a pending job', async t => {
  const f = await processingFixture(t), h = await harness(t, f, {
    execution: { async guardExecution() {}, async afterExecution() {}, async beforeExecution() {
      f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
    } }
  });
  h.nativeSkill = true;
  const closed = h.whenClosed();
  assert.equal((await h.call('process_selected_captures', {})).error.data.code, 'WORKFLOW_POLICY_CHANGED');
  await closed;
  assert.equal(h.dispatches, 0); assert.equal(h.opens, h.closes);
});

test('collection selection churn omits exclusion proof without aborting separately authorized processing', async t => {
  const f = await processingFixture(t), h = await harness(t, f, {
    execution: { async guardExecution() {}, async afterExecution() {}, async beforeExecution() {
      await withIntakeLock(f.store, async tx => {
        const selected = await readSelection(f.store, f.identity);
        await controlSelection(tx, { source: f.source, expectedHash: selected.hash, authorize: async () => true,
          request: { id: randomUUID(), client: f.identity.client, sessionId: f.identity.sessionId,
            expectedRevision: selected.state.revision, operation: 'exclude', unitId: f.identity.unitId } });
      });
    } },
  });
  h.nativeSkill = true;
  const closed = h.whenClosed(), requestId = randomUUID();
  const result = await h.call('process_selected_captures', { collectionId: f.collection.id, requestId });
  assert.equal(result.error, undefined);
  assert(body(result).diagnostics.includes('PROCESSING_EXCLUSION_UNVERIFIED'));
  await closed;
  assert.equal((await h.jobs[0]).state, 'idle');
  assert.equal(h.dispatches, 1); assert.equal(h.opens, h.closes);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  await assert.rejects(fs.lstat(path.join(f.collection.intakeStateDir, 'control-dispatch')), { code: 'ENOENT' });
  h.end(); await h.server;
});

function assertOnlyCommandTurnsLeftOut(after, before, controls) {
  if (!controls.length) { assert.equal(after.hash, before.hash); return; }
  const kept = state => state && { ...state, exclusions: [], revision: 0, lastRequest: null };
  const expected = before.state ? kept(before.state) : kept({ ...after.state, intervals: [], explicitScopes: [], active: false, paused: false, currentGrantHash: null });
  assert.deepEqual(kept(after.state), expected);
  assert.deepEqual(after.state.exclusions.filter(unitId => !before.state?.exclusions.includes(unitId)).sort(), [...controls].sort());
}

async function nativeParent(t, f, h, { binding = 'active', headerChanges = {} } = {}) {
  const sessionId = binding === 'processing-only' ? randomUUID() : f.identity.sessionId, previous = randomUUID(), stamp = '2026-10-10T12:00:00.000Z';
  // The pending synthetic capture belongs to this same source session. Replace
  // the fixture's placeholder bytes before starting its new live interval.
  const source = { ...f.source, sessionId, ...(binding === 'processing-only' ? { path: path.join(f.project, `${sessionId}.jsonl`) } : {}) };
  await fs.writeFile(source.path, '');
  let ordinal = 0, offset = 0;
  const append = async rows => {
    const anchors = [], bytes = rows.map(row => {
      const text = JSON.stringify({ timestamp: stamp, ordinal: ordinal++, ...row }) + '\n';
      anchors.push({ id: `codex:ordinal:${ordinal - 1}`, startByte: offset, endByte: offset + Buffer.byteLength(text), hash: digest(text) });
      offset += Buffer.byteLength(text); return text;
    }).join('');
    await fs.appendFile(source.path, bytes); return anchors;
  };
  const evt = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
  const item = (unitId, value) => evt('item_completed', { thread_id: sessionId, turn_id: unitId, item: value });
  const response = (unitId, payload, kinds) => ({ type: 'response_item', payload: { ...payload,
    internal_chat_message_metadata_passthrough: { turn_id: unitId, ...(kinds ? { content_item_kinds: kinds } : {}) } } });
  const anchors = await append([{ type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: f.project,
    cli_version: '0.157.1', source: 'cli', history_mode: 'paginated', ...headerChanges } },
    ...(binding === 'ingress' ? [] : [evt('task_started', { turn_id: previous, root_turn_id: previous })])]);
  source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
  const store = await openWorkflowIntake(f.capability, { client: 'codex', sessionId, cwd: f.project, unitId: null }, 'collect');
  const previousSelection = await readSelection(store, { client: 'codex', sessionId });
  const selected = binding === 'active' ? await withIntakeLock(store, tx => controlSelection(tx, { source, expectedHash: previousSelection.hash, authorize: async () => true,
    boundary: { sourceIdentity: source.fileIdentity, eofByte: offset, startsMidRecord: false, unitId: previous, record: anchors.at(-1) },
    request: { id: randomUUID(), client: 'codex', sessionId, unitId: previous, operation: 'start', expectedRevision: previousSelection.state.revision } })) : previousSelection;
  if (binding === 'manual') {
    // Align the disposable selection with the replacement native fixture bytes.
    // Its already-published raw capture stays byte-for-byte intact.
    selected.state.explicitScopes[0].start = anchors.at(-1);
    await withIntakeLock(store, tx => replaceIntakeJSON(tx, `sessions/codex/${sessionId}.json`, selected.state, selected.hash));
  }
  if (binding === 'ingress') {
    await collectionIngress('codex', { session_id: sessionId, turn_id: previous,
      cwd: f.project, transcript_path: source.path, hook_event_name: 'UserPromptSubmit' }, {
      configPath: f.options.configPath, launch: async () => {} });
    await append([evt('task_started', { turn_id: previous, root_turn_id: previous }),
      item(previous, { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text: 'Excluded hook boundary' }] }),
      evt('task_complete', { turn_id: previous })]);
  }
  const controls = [], metadata = new Map();
  h.beforeCall = async (name, args, callNumber) => {
    const unitId = randomUUID(), command = processingControlAction(name, args ?? {});
    h.nativeIdentity = { client: 'codex', sessionId, unitId }; controls.push(unitId);
    metadata.set(callNumber, { unitId, name, args });
    await append([evt('task_started', { turn_id: unitId, root_turn_id: unitId }),
      { type: 'turn_context', payload: { turn_id: unitId, root_turn_id: unitId } },
      response(unitId, { type: 'message', id: `input_${callNumber}`, role: 'user', content: [{ type: 'input_text', text: command }] }, ['user.text']),
      item(unitId, { type: 'UserMessage', id: `user_${callNumber}`, content: binding === 'processing-only' ? [{ type: 'text', text: command }] : [
        { type: 'skill', name: 'cuefluent-notes', path: fileURLToPath(new URL('../SKILL.md', import.meta.url)) },
        { type: 'text', text: command, text_elements: [] }] }),
      response(unitId, { type: 'function_call', id: `item_${callNumber}`, call_id: `call_${callNumber}`,
        namespace: 'mcp__cuefluent_control', name, arguments: JSON.stringify(args) })]);
  };
  const finish = async rpc => {
    assert(rpc.result, JSON.stringify(rpc));
    const { unitId, name, args } = metadata.get(rpc.id), status = body(rpc).statusText;
    await append([item(unitId, { type: 'McpToolCall', id: `call_${rpc.id}`, server: 'cuefluent_control', tool: name,
      arguments: args, status: 'completed', result: rpc.result }),
    response(unitId, { type: 'function_call_output', id: `output_${rpc.id}`, call_id: `call_${rpc.id}`, output: rpc.result.content[0].text }),
    item(unitId, { type: 'AgentMessage', id: `status_${rpc.id}`, content: [{ type: 'Text', text: status }] }),
    response(unitId, { type: 'message', id: `status_${rpc.id}`, role: 'assistant', content: [{ type: 'output_text', text: status }] }),
    evt('task_complete', { turn_id: unitId, last_agent_message: status })]);
  };
  // `filler` adds assistant messages to the turn; `last` is its final answer,
  // which Codex repeats in the terminal record.
  const work = async (text, { filler = [], last } = {}) => {
    const unitId = randomUUID();
    await append([evt('task_started', { turn_id: unitId, root_turn_id: unitId }),
      item(unitId, { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text }] }),
      ...filler.map(value => item(unitId, { type: 'AgentMessage', id: randomUUID(), content: [{ type: 'Text', text: value }] })),
      evt('task_complete', { turn_id: unitId, ...(last === undefined ? {} : { last_agent_message: last }) })]);
    return unitId;
  };
  const resume = changes => append([{ type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: f.project,
    cli_version: '0.157.1', source: 'cli', history_mode: 'paginated', ...headerChanges, ...changes } }]);
  return { source, store, selected, controls, finish, work, resume, boundaryUnitId: previous };
}

test('omitted MCP arguments bind to the exact empty native invocation', async t => {
  const f = await processingFixture(t), h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
  await nativeParent(t, f, h);
  const recordCall = h.beforeCall;
  // Clients record the model's empty input object while omitting the optional
  // MCP wire member. Verification must compare the same canonical input.
  h.beforeCall = (name, args, callNumber) => recordCall(name, args ?? {}, callNumber);
  assert.equal(body(await h.call('processing_status')).status, 'missing');
  const closed = h.whenClosed();
  assert.equal(body(await h.call('process_selected_captures')).status, 'busy');
  await closed;
  assert.equal(body(await h.call('processing_review')).status, 'idle');
  assert.equal(h.dispatches, 1); assert.equal(h.forms.length, 0);
});

test('collection-off native controls process and review manual backlog without enabling collection', async t => {
  for (const thread_source of [undefined, 'agent_created_thread']) for (const binding of ['manual', 'processing-only']) for (const explicit of [true, false]) await t.test(`${thread_source ?? 'unlabelled'}, ${binding}, explicit=${explicit}`, async t => {
    const f = await processingFixture(t), h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
    const parent = await nativeParent(t, f, h, { binding, headerChanges: { thread_source } });
    f.config.routes[0].collection.enabled = false;
    if (binding === 'processing-only') f.config.routes[0].processing.mode = 'prompted';
    const config = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, config);
    f.options.expectedConfigHash = digest(config); f.capability = await verifyWorkflowStorage(f.options);
    const store = await openWorkflowIntake(f.capability), identity = { client: 'codex', sessionId: parent.source.sessionId };
    if (binding === 'processing-only') await collectionIngress('codex', { session_id: identity.sessionId, turn_id: randomUUID(),
      cwd: f.project, transcript_path: parent.source.path, hook_event_name: 'UserPromptSubmit' }, {
      configPath: f.options.configPath, launch: () => assert.fail('no collection worker') });
    const selected = await readSelection(store, identity), raw = await fs.readdir(f.collection.rawDir, { recursive: true });
    const args = explicit ? { collectionId: f.collection.id } : {};
    assert.equal(body(await h.call('processing_status', args)).status, 'missing');
    h.script = proposeThroughTools(f); const closed = h.whenClosed();
    body(await h.call('process_selected_captures', args));
    await closed;
    assert.equal(body(await h.call('processing_status', args)).status, 'awaiting-review');
    const next = h.nextForm(), review = h.call('processing_review', args);
    h.answer(await next, { action: 'accept', content: { decision: 'save' } }); body(await review);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
    assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
    // A typed command leaves only its own turn out; nothing is armed or captured.
    assertOnlyCommandTurnsLeftOut(await readSelection(store, identity), selected, binding === 'manual' ? parent.controls : []);
    assert.deepEqual(await fs.readdir(f.collection.rawDir, { recursive: true }), raw);
    assert.equal(await fs.readFile(f.options.configPath, 'utf8'), config);
    await assert.rejects(fs.stat(path.join(f.collection.intakeStateDir, 'control-dispatch')), { code: 'ENOENT' });
  });
});

test('paused native source can inspect, process and save an existing proposal with explicit or inferred collection', async t => {
  for (const thread_source of [undefined, 'agent_created_thread']) for (const explicit of [true, false]) await t.test(`${thread_source ?? 'unlabelled'}, explicit=${explicit}`, async t => {
    const f = await processingFixture(t), h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
    const parent = await nativeParent(t, f, h, { headerChanges: { thread_source } }), unitId = await parent.work('Pause collection.');
    const paused = await withIntakeLock(parent.store, async tx => controlSelection(tx, { source: parent.source,
      expectedHash: parent.selected.hash, authorize: async () => true,
      request: { id: randomUUID(), client: 'codex', sessionId: f.identity.sessionId, unitId,
        operation: 'pause', expectedRevision: parent.selected.state.revision },
      boundary: { sourceIdentity: parent.source.fileIdentity, eofByte: (await fs.stat(parent.source.path)).size,
        startsMidRecord: false, unitId, record: null } }));
    const args = explicit ? { collectionId: f.collection.id } : {};
    const config = await fs.readFile(f.options.configPath);
    assert.equal(body(await h.call('processing_status', args)).status, 'missing');
    h.script = proposeThroughTools(f); const closed = h.whenClosed();
    assert.equal((await h.call('process_selected_captures', args)).error, undefined); await closed;
    assert.equal(body(await h.call('processing_status', args)).status, 'awaiting-review');
    const next = h.nextForm(), review = h.call('processing_review', args);
    h.answer(await next, { action: 'accept', content: { decision: 'save' } });
    assert.equal((await review).error, undefined);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
    assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
    assertOnlyCommandTurnsLeftOut(await readSelection(parent.store, f.identity), paused, parent.controls);
    assert.deepEqual(await fs.readFile(f.options.configPath), config);
    await assert.rejects(fs.stat(path.join(f.collection.intakeStateDir, 'control-dispatch')), { code: 'ENOENT' });
  });
});

async function nativeIngressFixture(t, { headerChanges = {} } = {}) {
  const f = await storageFixture(t, { fullSetup: false }), sessionId = randomUUID();
  await fs.mkdir(f.collection.notes.notesDir);
  f.identity = { client: 'codex', sessionId, unitId: randomUUID() };
  f.selection = { client: 'codex', sessionId, cwd: f.project, unitId: null };
  f.source = { client: 'codex', sessionId, projectRoot: f.project, path: path.join(f.project, 'native.jsonl') };
  f.operationId = randomUUID();
  const h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
  const parent = await nativeParent(t, f, h, { binding: 'ingress', headerChanges: { source: 'vscode', thread_source: 'agent_created_thread', ...headerChanges } });
  return { f, h, parent };
}

// A Codex chat in a project with capture mode and processing mode Manual: its
// hook recorded only where the session starts.
async function manualCaptureChat(t) {
  const f = await storageFixture(t, { fullSetup: false }), sessionId = randomUUID();
  await fs.mkdir(f.collection.notes.notesDir);
  f.identity = { client: 'codex', sessionId, unitId: randomUUID() };
  f.selection = { client: 'codex', sessionId, cwd: f.project, unitId: null };
  f.source = { client: 'codex', sessionId, projectRoot: f.project, path: path.join(f.project, 'native.jsonl') };
  const h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
  const parent = await nativeParent(t, f, h, { binding: 'typed' });
  // Capture mode Manual and processing mode Manual: the hook records only where the session starts.
  f.config.routes[0].collection = { enabled: false }; f.config.routes[0].processing = { mode: 'manual' };
  const config = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, config);
  f.options.expectedConfigHash = digest(config); f.capability = await verifyWorkflowStorage(f.options);
  assert.equal((await collectionIngress('codex', { session_id: sessionId, turn_id: randomUUID(), cwd: f.project,
    transcript_path: parent.source.path, hook_event_name: 'UserPromptSubmit' }, { configPath: f.options.configPath,
    launch: () => assert.fail('no collection worker') })).status, 'manual');
  const store = await openWorkflowIntake(f.capability), identity = { client: 'codex', sessionId };
  const head = async unitId => (await readCaptureHead(store, { ...identity, unitId })).head;
  const typed = async (tool, expected) => {
    const rpc = await h.call(tool, {}), reply = body(rpc);
    assert.equal(reply.capture, expected, reply.statusText); await parent.finish(rpc); return reply;
  };
  return { f, h, parent, store, identity, head, typed, config };
}

test('typed capture bounds slow pre-action checks and failure bookkeeping by its original deadline', async t => {
  for (const delay of [11_000, 50_000]) await t.test(`status delayed ${delay} ms`, async t => {
    const { h, parent, store, identity, head } = await manualCaptureChat(t);
    const work = await parent.work('Decision: ship on Friday.');
    let elapsed = 0;
    t.mock.method(performance, 'now', () => 1_000_000 + elapsed);
    h.beforeStatus = async () => { elapsed += delay; };
    const rpc = await h.call('capture_turns', {});
    assert.equal(rpc.error?.data?.code, 'PROCESSING_CONTROL_FAILED', JSON.stringify(rpc));
    assert.equal(await head(work), null, 'an expired preflight cannot capture');
    const state = (await readSelection(store, identity)).state;
    assert.equal(state?.explicitScopes.length ?? 0, 0);
    if (delay < 50_000) {
      assert(state.exclusions.includes(parent.controls.at(-1)), 'failure bookkeeping can use the remaining command time');
    } else {
      assert.equal(state, null, 'failure bookkeeping cannot write after the command deadline');
      assert.deepEqual(rpc.error.data.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
    }
  });
});

test('typed capture preflight gets only the time left after reserving the command', async t => {
  const { h, parent, store, identity, head } = await manualCaptureChat(t);
  const work = await parent.work('Decision: ship on Friday.');
  let elapsed = 0;
  t.mock.method(performance, 'now', () => 1_000_000 + elapsed);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    const reservation = String(to).split(path.sep).includes('replies') && JSON.parse(await fs.readFile(from, 'utf8')).response === null;
    const result = await rename(from, to);
    // An OS operation that returned late leaves just 1 s for preflight.
    if (reservation) elapsed = 39_000;
    return result;
  });
  let inspected = false;
  h.beforeStatus = async () => {
    inspected = true;
    assert.equal(workflowTimeout(), 1_000);
    elapsed += 1_001;
  };
  const rpc = await h.call('capture_turns', {});
  assert(inspected);
  assert.equal(rpc.error?.data?.code, 'PROCESSING_CONTROL_FAILED', JSON.stringify(rpc));
  assert.equal(await head(work), null);
  const state = (await readSelection(store, identity)).state;
  assert.equal(state.explicitScopes.length, 0);
  assert(state.exclusions.includes(parent.controls.at(-1)));
});

test('cancelling capture during preflight stops its action but still leaves its command turn out', async t => {
  const { h, parent, store, identity, head } = await manualCaptureChat(t);
  const work = await parent.work('Decision: ship on Friday.'), entered = deferred(), release = deferred();
  h.release = release.resolve;
  h.beforeStatus = async () => { entered.resolve(); await release.promise; };
  const pending = h.call('capture_turns', {});
  await entered.promise;
  h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  release.resolve(); h.end(); await h.server;
  assert.equal(await head(work), null);
  const state = (await readSelection(store, identity)).state;
  assert.equal(state.explicitScopes.length, 0);
  assert(state.exclusions.includes(parent.controls.at(-1)));
  assert(!h.responses.some(row => row.id === 1), 'a cancelled request has no late reply');
  // The host abandoned its cancelled RPC; no response is expected for it.
  pending.catch(() => {});
});

test('typed capture in a Manual chat captures every finished turn since the last capture, never a command turn', async t => {
  const { f, h, parent, store, identity, head, typed, config } = await manualCaptureChat(t);
  const first = await parent.work('Decision: ship on Friday.'), second = await parent.work('Owner: Dana.');
  const captured = await typed('capture_turns', 'captured');
  assert.equal(captured.turns, 2); assert.equal(captured.more, false);
  assert.match(captured.statusText, /^Cuefluent: Captured 2 turns of this chat\. Type \$cuefluent-notes process/);
  assert(await head(first)); assert(await head(second));
  // Another typed command in between is left out as well.
  body(await h.call('processing_status', {}).then(async rpc => { await parent.finish(rpc); return rpc; }));
  const third = await parent.work('Correction: ship on Monday.');
  assert.equal((await typed('capture_turns', 'captured')).turns, 1);
  assert.equal((await readCaptureHead(store, { ...identity, unitId: third })).capture.evidence[0].text, 'Correction: ship on Monday.');
  assert.equal((await typed('capture_turns', 'nothing-new')).more, false);
  // Pausing or resuming applies only to Automatic capture.
  await typed('pause_capture', 'not-automatic'); await typed('resume_capture', 'not-automatic');
  for (const unitId of parent.controls) assert.equal(await head(unitId), null, unitId);
  const selection = (await readSelection(store, identity)).state;
  assert.equal(selection.active, false); assert.deepEqual(selection.intervals, []);
  assert.deepEqual([...selection.exclusions].sort(), [...parent.controls].sort());
  assert.equal(selection.explicitScopes.length, 2);
  assert.equal(await fs.readFile(f.options.configPath, 'utf8'), config);
});

test('a long chat is captured in order across typed captures, in bounded windows', async t => {
  const { h, parent, head, typed } = await manualCaptureChat(t), turns = [];
  for (let index = 0; index < 12; index++) turns.push(await parent.work(`Synthetic note ${index}.`));
  // One window holds at most 10 turns, and a run that outlasts its budget
  // keeps what it published; typing capture again continues in order.
  const first = await typed('capture_turns', 'captured');
  assert.equal(first.more, true); assert(first.turns <= 10);
  assert.match(first.statusText, /More finished turns are waiting; type \$cuefluent-notes capture again/);
  assert.equal(await head(turns[11]), null);
  let total = first.turns, reply = first;
  for (let attempt = 0; reply.more && attempt < 12; attempt++) {
    const rpc = await h.call('capture_turns', {}); reply = body(rpc); await parent.finish(rpc);
    total += reply.turns ?? 0;
  }
  assert.equal(reply.more, false); assert.equal(total, 12);
  for (const unitId of turns) assert(await head(unitId), unitId);
});

test('capture reads a chat from its start, so a settings change cannot skip its earlier turns', async t => {
  const { f, h, parent, head, typed } = await manualCaptureChat(t);
  const first = await parent.work('Decision: ship on Friday.'), second = await parent.work('Owner: Dana.');
  // Any settings change gives the next hook a new session-start record at the
  // current end of the transcript; capture does not start there.
  f.config.routes[0].clients = [...f.config.routes[0].clients].reverse();
  const config = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, config);
  f.options.expectedConfigHash = digest(config); f.capability = await verifyWorkflowStorage(f.options);
  assert.equal((await collectionIngress('codex', { session_id: f.identity.sessionId, turn_id: randomUUID(), cwd: f.project,
    transcript_path: parent.source.path, hook_event_name: 'UserPromptSubmit' }, { configPath: f.options.configPath,
    launch: () => assert.fail('no collection worker') })).status, 'manual');
  assert.equal((await typed('capture_turns', 'captured')).turns, 2);
  assert(await head(first)); assert(await head(second));
});

test('a turn too large for a window is left out once and never blocks later turns', async t => {
  const { parent, head, typed } = await manualCaptureChat(t);
  const before = await parent.work('Before the large turn.');
  const large = await parent.work('Paste the whole log.', { filler: Array.from({ length: 9 }, (_, index) => `${index}`.repeat(1024 * 1024)) });
  const after = await parent.work('After the large turn.');
  // The first window ends before the large turn; the next one passes it.
  const first = await typed('capture_turns', 'captured');
  assert.equal(first.turns, 1); assert.equal(first.more, true); assert(await head(before));
  const second = await typed('capture_turns', 'captured');
  assert.equal(second.turns, 1); assert.equal(second.leftOut, 1);
  assert.match(second.statusText, /Captured 1 turn of this chat\. 1 turn too large to capture was left out\./);
  assert.equal(await head(large), null); assert(await head(after));
  assert.equal((await typed('capture_turns', 'nothing-new')).leftOut, undefined);
});

test('a turn whose last record is too large to anchor is left out and reported, never counted as captured', async t => {
  const { parent, head, typed } = await manualCaptureChat(t);
  // Codex repeats a long final answer in the turn's terminal record.
  const first = await parent.work('First decision.'), report = await parent.work('Write the report.', { last: 'r'.repeat(70 * 1024) });
  const after = await parent.work('Next decision.');
  const reply = await typed('capture_turns', 'captured');
  assert.equal(reply.turns, 2); assert.equal(reply.leftOut, 1); assert.equal(reply.more, false);
  assert(await head(first)); assert(await head(after)); assert.equal(await head(report), null);
  assert.equal((await typed('capture_turns', 'nothing-new')).leftOut, undefined);
});

test('typed status in a chat with no housekeeping room keeps its turn capturable and says so', async t => {
  const { f, h, parent, store, identity, typed } = await manualCaptureChat(t);
  await typed('capture_turns', 'nothing-new');
  // A selection near its housekeeping limit: one more exclusion is not added,
  // so no safety stop can follow.
  const current = await readSelection(store, identity);
  const full = { ...current.state, exclusions: [...current.state.exclusions, ...Array.from({ length: 2048 }, () => randomUUID())] };
  await withIntakeLock(store, tx => replaceIntakeJSON(tx, `sessions/codex/${identity.sessionId}.json`, full, current.hash));
  const rpc = await h.call('processing_status', {}); await parent.finish(rpc);
  assert(body(rpc).diagnostics.includes('PROCESSING_EXCLUSION_UNVERIFIED'));
  const after = (await readSelection(store, identity)).state;
  assert.equal(after.safetyStop, null); assert.equal(after.exclusions.length, full.exclusions.length);
  assert(!after.exclusions.includes(parent.controls.at(-1)));
});

test('a typed capture stopped by a record it cannot read says why and leaves its own turn out', async t => {
  const { h, parent, store, identity } = await manualCaptureChat(t);
  await parent.work('Decision: ship on Friday.');
  // A record the reader cannot read stops the capture; enough later bytes keep
  // the command's own binding read past it.
  await fs.appendFile(parent.source.path, 'not a transcript record\n');
  await parent.work('Later turn.', { filler: ['x'.repeat(2.2 * 1024 * 1024)] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const rpc = await h.call('capture_turns', {}), reply = body(rpc); await parent.finish(rpc);
    assert.deepEqual([reply.capture, reply.reason], ['blocked', 'INVALID_SESSION_RECORD'], JSON.stringify(rpc));
    assert.match(reply.statusText, /^Cuefluent: Capture stopped at a record of this chat: its transcript has a record that is not valid, so typing \$cuefluent-notes capture cannot capture its later turns\.$/);
    assert((await readSelection(store, identity)).state.exclusions.includes(parent.controls.at(-1)));
  }
});

test('a typed capture whose reply cannot be built refuses before it captures anything', async t => {
  const { h, parent, head } = await manualCaptureChat(t);
  const decision = await parent.work('Decision: ship on Friday.');
  // The chat's processing status cannot be read, as with a Claude sign-in
  // setting that is not valid.
  h.beforeStatus = () => { throw Object.assign(new Error('synthetic'), { code: 'PROCESSING_CLIENT_AUTHENTICATION_INVALID' }); };
  const rpc = await h.call('capture_turns', {});
  assert.equal(rpc.error?.data?.code, 'PROCESSING_CLIENT_AUTHENTICATION_INVALID', JSON.stringify(rpc));
  assert.equal(await head(decision), null);
  // Typed again with a readable status, the capture takes the turn.
  delete h.beforeStatus;
  const retry = await h.call('capture_turns', {}); await parent.finish(retry);
  assert.equal(body(retry).turns, 1, body(retry).statusText);
  assert(await head(decision));
});

test('a typed capture that fails after a run kept turns reports them', async t => {
  const { f, h, parent, head } = await manualCaptureChat(t);
  const held = await parent.work('Decision: ship on Friday.');
  await lateEvidence(parent, held);
  const kept = await parent.work('Owner: Dana.');
  // The window's first run keeps the later turn and holds the first; the
  // intake lock stays busy for every later run.
  const mkdir = fs.mkdir; let runs = 0;
  t.mock.method(fs, 'mkdir', async (target, ...rest) => {
    if (String(target).endsWith('.intake-lock') && new Error().stack.includes('runChatScope') && runs++ > 0) throw Object.assign(new Error('held'), { code: 'EEXIST' });
    return mkdir.call(fs, target, ...rest);
  });
  const rpc = await h.call('capture_turns', {}), reply = body(rpc); await parent.finish(rpc);
  assert.deepEqual([reply.capture, reply.turns, reply.more], ['captured', 1, true], JSON.stringify(rpc));
  assert(await head(kept)); assert.equal(await head(held), null);
});

test('a window with a turn the reader holds for its records keeps waiting, never passed by a later window, and says so', async t => {
  const { f, h, parent, store, identity, head } = await manualCaptureChat(t);
  const first = await parent.work('Decision: ship on Friday.');
  // Evidence after that turn's terminal record, at the next native ordinal:
  // the reader holds the turn.
  await parent.resume({});
  const text = await fs.readFile(parent.source.path, 'utf8'), last = text.lastIndexOf('\n', text.length - 2) + 1;
  const { timestamp, ordinal } = JSON.parse(text.slice(last));
  await fs.truncate(parent.source.path, Buffer.byteLength(text.slice(0, last)));
  await fs.appendFile(parent.source.path, JSON.stringify({ timestamp, ordinal, type: 'event_msg', payload: { type: 'item_completed',
    thread_id: f.identity.sessionId, turn_id: first, item: { type: 'AgentMessage', id: randomUUID(), content: [{ type: 'Text', text: 'Late evidence.' }] } } }) + '\n');
  await parent.work('Owner: Dana.');
  // The window waits on the held turn, and each reply says that typing
  // `capture` again cannot pass it, never that it continues.
  for (const capture of ['captured', 'blocked']) {
    const rpc = await h.call('capture_turns', {}), reply = body(rpc); await parent.finish(rpc);
    assert.deepEqual([reply.capture, reply.reason, reply.more], [capture, 'EVIDENCE_AFTER_CODEX_TERMINAL', capture === 'captured' ? false : undefined], reply.statusText);
    assert.match(reply.statusText, /Capture stopped at a record of this chat: its transcript has a turn with records after the turn ended, so typing \$cuefluent-notes capture cannot capture its later turns\./);
    assert.doesNotMatch(reply.statusText, /again/);
  }
  assert.equal(await head(first), null);
  assert.equal((await readSelection(store, identity)).state.explicitScopes.length, 1);
});

test('a turn whose terminal record is too large to anchor is left out even behind later metadata', async t => {
  const { parent, store, identity, head, typed } = await manualCaptureChat(t);
  const big = await parent.work('Long final answer.', { last: 'x'.repeat(70 * 1024) });
  await parent.resume({});
  const later = await parent.work('Owner: Dana.');
  const reply = await typed('capture_turns', 'captured');
  assert.equal(reply.turns, 1); assert.equal(reply.leftOut, 1);
  assert(await head(later)); assert.equal(await head(big), null);
  assert((await readSelection(store, identity)).state.exclusions.includes(big));
});

test('typed capture commands in a safety-stopped Manual chat also say its capture record is full', async t => {
  const { h, parent, store, identity, typed } = await manualCaptureChat(t);
  await typed('capture_turns', 'nothing-new');
  const current = await readSelection(store, identity);
  await withIntakeLock(store, tx => replaceIntakeJSON(tx, `sessions/codex/${identity.sessionId}.json`,
    { ...current.state, safetyStop: { reason: 'capacity', unitId: randomUUID() } }, current.hash));
  for (const tool of ['capture_turns', 'pause_capture', 'resume_capture']) {
    const reply = await typed(tool, 'full');
    // Status does not bind here, so the reply does not point to it.
    assert.match(reply.statusText, /capture record is full/); assert.doesNotMatch(reply.statusText, /status/);
  }
});

test('a redelivered capture command answers with its first reply and acts once', async t => {
  // Sends the same native call again: its call ID and turn, with no new turn.
  const redeliver = async (h, parent, rpc, sessionId, unitId = parent.controls.at(-1)) => {
    const beforeCall = h.beforeCall;
    h.beforeCall = async () => { h.nativeIdentity = { client: 'codex', sessionId, unitId }; };
    h.callId = `call_${rpc.id}`;
    try { return await h.call(rpc.name, {}); } finally { h.beforeCall = beforeCall; h.callId = undefined; }
  };
  await t.test('capture in a Manual chat', async t => {
    const { f, h, parent, head } = await manualCaptureChat(t);
    const first = await parent.work('Decision: ship on Friday.'), second = await parent.work('Owner: Dana.');
    const rpc = await h.call('capture_turns', {}); rpc.name = 'capture_turns';
    assert.equal(body(rpc).capture, 'captured'); assert.equal(body(rpc).turns, 2); await parent.finish(rpc);
    const again = await redeliver(h, parent, rpc, f.identity.sessionId);
    assert.deepEqual(again.result, rpc.result, JSON.stringify(again.error ?? body(again)));
    assert(await head(first)); assert(await head(second));
  });
  await t.test('capture in a Manual chat, after a later capture', async t => {
    const { f, h, parent, head } = await manualCaptureChat(t);
    await parent.work('Decision: ship on Friday.');
    const rpc = await h.call('capture_turns', {}); rpc.name = 'capture_turns';
    assert.equal(body(rpc).turns, 1); await parent.finish(rpc);
    const unitId = parent.controls.at(-1), third = await parent.work('Owner: Dana.');
    const later = await h.call('capture_turns', {}); assert.equal(body(later).turns, 1); await parent.finish(later);
    const again = await redeliver(h, parent, rpc, f.identity.sessionId, unitId);
    assert.deepEqual(again.result, rpc.result, JSON.stringify(again.error ?? body(again)));
    assert(await head(third));
  });
  await t.test('capture whose reply cannot be kept, and its redelivery', async t => {
    const { f, h, parent, head } = await manualCaptureChat(t), first = await parent.work('Decision: ship on Friday.');
    // The call's reservation is kept; writing its reply fails.
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (String(to).split(path.sep).includes('replies') && JSON.parse(await fs.readFile(from, 'utf8')).response !== null) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return rename(from, to);
    };
    let rpc; try { rpc = await h.call('capture_turns', {}); rpc.name = 'capture_turns'; } finally { fs.rename = rename; }
    // The turn was captured, but no reply claims it without a kept reply.
    assert.equal(rpc.error?.data?.code, 'PROCESSING_CONTROL_FAILED', JSON.stringify(rpc));
    assert.match(rpc.error.message, /not certain whether anything changed/);
    assert(await head(first));
    // Its redelivery, like a duplicate delivered while the first acts, finds
    // the call reserved without a reply: it is refused and does not act.
    const later = await parent.work('Owner: Dana.');
    const again = await redeliver(h, parent, rpc, f.identity.sessionId);
    assert.equal(again.error?.data?.code, 'PROCESSING_CONTROL_FAILED', JSON.stringify(again));
    assert.equal(await head(later), null);
  });
  // Fills the selection to its housekeeping limit, so a command's turn cannot
  // be left out; the returned function makes room again.
  const crowd = async ({ store, identity }) => {
    const name = `sessions/codex/${identity.sessionId}.json`, current = await readSelection(store, identity);
    const extra = new Set(Array.from({ length: 2048 }, () => randomUUID()));
    await withIntakeLock(store, tx => replaceIntakeJSON(tx, name, { ...current.state, exclusions: [...current.state.exclusions, ...extra] }, current.hash));
    return async () => {
      const now = await readSelection(store, identity);
      await withIntakeLock(store, tx => replaceIntakeJSON(tx, name, { ...now.state, exclusions: now.state.exclusions.filter(unit => !extra.has(unit)) }, now.hash));
    };
  };
  await t.test('capture whose turn could not be left out', async t => {
    const chat = await manualCaptureChat(t), { f, h, parent } = chat;
    await chat.typed('capture_turns', 'nothing-new');
    const room = await crowd(chat);
    const rpc = await h.call('capture_turns', {}); rpc.name = 'capture_turns';
    assert(body(rpc).diagnostics.includes('PROCESSING_EXCLUSION_UNVERIFIED'), JSON.stringify(rpc)); await parent.finish(rpc);
    // With room again, the redelivery still answers as the first delivery did.
    await room();
    const again = await redeliver(h, parent, rpc, f.identity.sessionId);
    assert.deepEqual(again.result, rpc.result, JSON.stringify(again.error ?? body(again)));
  });
  await t.test('a duplicate delivery leaves its turn alone, even when it cannot read the reservation', async t => {
    const chat = await manualCaptureChat(t), { f, h, parent, store, identity } = chat;
    await chat.typed('capture_turns', 'nothing-new');
    const room = await crowd(chat), rename = fs.rename;
    // The first delivery acts, but can neither leave out its turn nor keep its reply.
    fs.rename = async (from, to) => {
      if (String(to).split(path.sep).includes('replies') && JSON.parse(await fs.readFile(from, 'utf8')).response !== null) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return rename(from, to);
    };
    let rpc; try { rpc = await h.call('capture_turns', {}); rpc.name = 'capture_turns'; } finally { fs.rename = rename; }
    assert.equal(rpc.error?.data?.code, 'PROCESSING_CONTROL_FAILED', JSON.stringify(rpc));
    // With room again, a duplicate finds the call reserved without a reply, as
    // it would while the first delivery acts: it changes nothing, nor does one
    // that fails before it can tell whether the call is reserved.
    await room();
    const unitId = parent.controls.at(-1), before = await readSelection(store, identity), open = fs.open;
    fs.open = async (file, ...args) => { if (String(file).split(path.sep).includes('replies')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return open(file, ...args); };
    let failed; try { failed = await redeliver(h, parent, rpc, f.identity.sessionId); } finally { fs.open = open; }
    assert(failed.error, JSON.stringify(failed));
    assert.equal((await readSelection(store, identity)).hash, before.hash);
    const again = await redeliver(h, parent, rpc, f.identity.sessionId);
    assert.equal(again.error?.data?.code, 'PROCESSING_CONTROL_FAILED', JSON.stringify(again));
    const after = await readSelection(store, identity);
    assert.equal(after.hash, before.hash); assert(!after.state.exclusions.includes(unitId));
  });
  await t.test('resume chat in an Automatic chat', async t => {
    const { f, h, parent } = await nativeIngressFixture(t);
    await parent.work('Captured automatically.');
    await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    const paused = await h.call('pause_capture', {}); assert.equal(body(paused).capture, 'paused'); await parent.finish(paused);
    const rpc = await h.call('resume_capture', {}); rpc.name = 'resume_capture';
    assert.equal(body(rpc).capture, 'resumed'); await parent.finish(rpc);
    const again = await redeliver(h, parent, rpc, f.identity.sessionId);
    assert.deepEqual(again.result, rpc.result, JSON.stringify(again.error ?? body(again)));
  });
  // The pause starts the chat's binding after its own call.
  await t.test('pause chat in an Automatic chat is refused once paused', async t => {
    const { f, h, parent } = await nativeIngressFixture(t);
    await parent.work('Captured automatically.');
    await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    const rpc = await h.call('pause_capture', {}); rpc.name = 'pause_capture';
    assert.equal(body(rpc).capture, 'paused'); await parent.finish(rpc);
    const store = await openWorkflowIntake(f.capability), identity = { client: 'codex', sessionId: f.identity.sessionId };
    const before = await readSelection(store, identity);
    const again = await redeliver(h, parent, rpc, f.identity.sessionId);
    assert.equal(again.error?.data?.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED', JSON.stringify(again));
    assert.equal((await readSelection(store, identity)).hash, before.hash);
  });
});

test('a failed typed command whose turn could not be left out says so in its refusal', async t => {
  const { h, parent, store, identity, typed } = await manualCaptureChat(t);
  await typed('capture_turns', 'nothing-new');
  // A selection at its housekeeping limit: the failed command's turn is not left out.
  const current = await readSelection(store, identity);
  const full = { ...current.state, exclusions: [...current.state.exclusions, ...Array.from({ length: 2048 }, () => randomUUID())] };
  await withIntakeLock(store, tx => replaceIntakeJSON(tx, `sessions/codex/${identity.sessionId}.json`, full, current.hash));
  await parent.work('Decision: ship on Friday.');
  // A file where this chat's captures are listed fails the capture.
  const heads = await intakePath(store, 'state', `heads/codex/${identity.sessionId}`, { createParents: true });
  await fs.writeFile(heads, '');
  const rpc = await h.call('capture_turns', {});
  assert.equal(rpc.error.code, -32600, JSON.stringify(rpc)); assert.equal(rpc.error.data.code, 'UNSAFE_INTAKE_PATH');
  assert.deepEqual(rpc.error.data.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
  assert(!(await readSelection(store, identity)).state.exclusions.includes(parent.controls.at(-1)));
});

test('a capture command the person did not type applies nothing', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  for (const tool of ['capture_turns', 'pause_capture', 'resume_capture']) {
    const rpc = await h.call(tool, {});
    assert.equal(rpc.error.data.code, 'PROCESSING_CONTROL_SELECTION_MISMATCH', tool);
    assert.match(rpc.error.message, /^Cuefluent: Nothing was applied: the tool call did not match the command that was typed\.$/);
  }
  assert.equal(h.dispatches, 0);
});

test('capture never takes turns Automatic capture took, after the project switches to Manual', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const automatic = await parent.work('Captured automatically.'); assert.equal((await run()).saved, 1);
  const before = await readCaptureHead(parent.store, { ...identity, unitId: automatic });
  f.config.routes[0].collection = { enabled: false }; f.config.routes[0].processing = { mode: 'manual' };
  const config = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, config);
  f.options.expectedConfigHash = digest(config); f.capability = await verifyWorkflowStorage(f.options);
  await collectionIngress('codex', { session_id: identity.sessionId, turn_id: randomUUID(), cwd: f.project,
    transcript_path: parent.source.path, hook_event_name: 'UserPromptSubmit' }, { configPath: f.options.configPath, launch: () => assert.fail('no worker') });
  const manual = await parent.work('Captured by hand.');
  const rpc = await h.call('capture_turns', {}), reply = body(rpc); await parent.finish(rpc);
  assert.equal(reply.capture, 'captured', reply.statusText); assert.equal(reply.turns, 1);
  const store = await openWorkflowIntake(f.capability);
  assert.equal((await readCaptureHead(store, { ...identity, unitId: automatic })).hash, before.hash);
  assert((await readCaptureHead(store, { ...identity, unitId: manual })).head);
});

test('a chat whose Automatic capture stopped is not told capture covers it', async t => {
  // A stop status reports, and a reader block no later pass gets past.
  for (const code of ['UNSUPPORTED_SESSION_OWNERSHIP', 'UNSUPPORTED_CLAUDE_RECORD']) await t.test(code, async t => {
    const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
    await parent.work('Captured automatically.'); await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    await publishIngressMetadata(parent.store, collectionStatusPath, { status: 'pending', saved: 0, pending: [code],
      diagnostics: [{ ...identity, code }], boundaryExcluded: [], updatedAt: new Date().toISOString() });
    const rpc = await h.call('capture_turns', {}), reply = body(rpc); await parent.finish(rpc);
    assert.equal(reply.capture, 'stopped');
    // It names the way to capture them by hand, never that typing capture cannot help.
    assert.match(reply.statusText, /^Cuefluent: Automatic capture has stopped for this chat, so its later turns are not captured\. To capture them by hand, type \$cuefluent-notes pause chat, then \$cuefluent-notes capture\./);
  });
});

// A native event for an ended Codex turn, at the next native ordinal.
async function lateEvidence(parent, unitId) {
  await parent.resume({});
  const text = await fs.readFile(parent.source.path, 'utf8'), last = text.lastIndexOf('\n', text.length - 2) + 1;
  const { timestamp, ordinal } = JSON.parse(text.slice(last));
  await fs.truncate(parent.source.path, Buffer.byteLength(text.slice(0, last)));
  await fs.appendFile(parent.source.path, JSON.stringify({ timestamp, ordinal, type: 'event_msg', payload: { type: 'item_completed',
    thread_id: parent.source.sessionId, turn_id: unitId, item: { type: 'AgentMessage', id: randomUUID(), content: [{ type: 'Text', text: 'Late evidence.' }] } } }) + '\n');
}

test('a reader block is kept per chat, so a later pass that skips the chat cannot hide it', async t => {
  // Every reader block a visit can end on has a plain reason in status.
  for (const code of READER_BLOCK_CODES) assert(COLLECTION_STOP_CODES.includes(code), code);
  const cases = {
    // Bytes that are no transcript record at all.
    INVALID_SESSION_RECORD: [/its transcript has a record that is not valid\./, async parent => fs.appendFile(parent.source.path, 'not a transcript record\n')],
    // A well-formed record of a kind the Codex reader does not read, at the next native ordinal.
    UNSUPPORTED_CODEX_RECORD: [/its transcript has a record Cuefluent Notes cannot read\./, async parent => {
      await parent.resume({});
      const text = await fs.readFile(parent.source.path, 'utf8'), last = text.lastIndexOf('\n', text.length - 2) + 1;
      const { timestamp, ordinal } = JSON.parse(text.slice(last));
      await fs.truncate(parent.source.path, Buffer.byteLength(text.slice(0, last)));
      await fs.appendFile(parent.source.path, JSON.stringify({ timestamp, ordinal, type: 'synthetic_unknown', payload: { type: 'synthetic' } }) + '\n');
    }],
    // Evidence after a finished turn's terminal record, at the next native ordinal.
    EVIDENCE_AFTER_CODEX_TERMINAL: [/its transcript has a turn with records after the turn ended\./,
      async parent => lateEvidence(parent, await parent.work('Decision: ship on Friday.'))],
    // The same for a turn Automatic capture already captured.
    LATE_NATIVE_EVIDENCE_REQUIRES_REVIEW: [/its transcript has a new record for a turn that was already captured\./,
      (parent, captured) => lateEvidence(parent, captured)],
    // A finished turn whose terminal record is too large to anchor.
    SOURCE_ANCHOR_LIMIT: [/its transcript has a turn whose last record is too large for Cuefluent Notes to track\./,
      parent => parent.work('Long final answer.', { last: 'x'.repeat(70 * 1024) })],
  };
  for (const [code, [reason, block]] of Object.entries(cases)) await t.test(code, async t => {
    const { f, h, parent } = await nativeIngressFixture(t);
    const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    const captured = await parent.work('Captured automatically.'); await run();
    await block(parent, captured);
    await parent.work('Held behind the block.', { filler: ['x'.repeat(2.2 * 1024 * 1024)] });
    assert((await run()).pending.includes(code));
    // A later pass that does not visit this chat rebuilds the notice without it.
    await publishIngressMetadata(parent.store, collectionStatusPath, { status: 'idle', saved: 0, pending: [], diagnostics: [],
      boundaryExcluded: [], updatedAt: new Date(Date.now() + 1000).toISOString() });
    const rpc = await h.call('capture_turns', {}), reply = body(rpc); await parent.finish(rpc);
    assert.equal(reply.capture, 'stopped', reply.statusText);
    // Status, which that reply points to, says so and why.
    const status = await h.call('processing_status', {}), shown = body(status); await parent.finish(status);
    assert.deepEqual(shown.collection, { state: 'stopped', code });
    assert.match(shown.statusText, reason);
  });
});

test('a paused chat is captured by hand up to a reader stop typed capture meets itself, and past one it does not', async t => {
  const cases = {
    // Bytes that are no transcript record: typed capture reads them too, and says so.
    INVALID_SESSION_RECORD: [{ capture: 'blocked' }, async parent => {
      await fs.appendFile(parent.source.path, 'not a transcript record\n');
      await parent.work('Held behind the block.', { filler: ['x'.repeat(2.2 * 1024 * 1024)] });
    }],
    // A turn too large to anchor: typed capture leaves it out and goes on.
    SOURCE_ANCHOR_LIMIT: [{ capture: 'nothing-new', leftOut: 1 }, parent => parent.work('Long final answer.', { last: 'x'.repeat(70 * 1024) })],
    // Automatic capture's own saved progress is not valid: typed capture reads
    // its own windows and never meets it.
    INVALID_INTAKE_METADATA: [{ capture: 'captured' }, async (parent, f, identity) => {
      const { id } = (await readSelection(parent.store, identity)).state.intervals.at(-1);
      await fs.writeFile(path.join(f.collection.intakeStateDir, 'progress', 'codex', identity.sessionId, `${id}.json`), '{not json');
      await parent.work('Decision: taken by hand.');
    }],
  };
  for (const [code, [expected, block]] of Object.entries(cases)) await t.test(code, async t => {
    const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
    const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    await parent.work('Captured automatically.'); await run();
    await block(parent, f, identity);
    const result = await run(); assert(result.pending.includes(code), JSON.stringify(result));
    const paused = await h.call('pause_capture', {}); assert.equal(body(paused).capture, 'paused'); await parent.finish(paused);
    assert.equal(await readReaderBlock(parent.store, identity), code);
    const rpc = await h.call('capture_turns', {}), reply = body(rpc); await parent.finish(rpc);
    assert.deepEqual({ capture: reply.capture, ...(expected.leftOut ? { leftOut: reply.leftOut } : {}) }, expected, reply.statusText);
  });
});

test('a reader stop marker that cannot be read leaves the latest pass to report the stop, and the next visit repairs it', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  await parent.work('Captured automatically.'); await run();
  await fs.appendFile(parent.source.path, 'not a transcript record\n');
  await parent.work('Held behind the block.', { filler: ['x'.repeat(2.2 * 1024 * 1024)] });
  assert((await run()).pending.includes('INVALID_SESSION_RECORD'));
  await fs.writeFile(path.join(f.collection.intakeStateDir, 'reader-blocks', 'codex', `${identity.sessionId}.json`), '{not json');
  await assert.rejects(readReaderBlock(parent.store, identity));
  const status = await h.call('processing_status', {}), shown = body(status); await parent.finish(status);
  assert.deepEqual(shown.collection, { state: 'stopped', code: 'INVALID_SESSION_RECORD' });
  const rpc = await h.call('capture_turns', {}), reply = body(rpc); await parent.finish(rpc);
  assert.equal(reply.capture, 'stopped', reply.statusText);
  // The next visit that ends on the same stop replaces the marker, so the stop
  // outlasts a later pass that skips the chat and rebuilds the notice.
  assert((await run()).pending.includes('INVALID_SESSION_RECORD'));
  assert.equal(await readReaderBlock(parent.store, identity), 'INVALID_SESSION_RECORD');
  await publishIngressMetadata(parent.store, collectionStatusPath, { status: 'idle', saved: 0, pending: [], diagnostics: [],
    boundaryExcluded: [], updatedAt: new Date(Date.now() + 1000).toISOString() });
  const later = await h.call('processing_status', {}); await parent.finish(later);
  assert.deepEqual(body(later).collection, { state: 'stopped', code: 'INVALID_SESSION_RECORD' });
});

test('a chat whose header turns unsupported keeps that reader block, and typed commands there stay unverified', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  await parent.work('Captured automatically.'); await run();
  // The header record changes in place to a kind the reader does not support.
  const text = await fs.readFile(parent.source.path, 'utf8'), handle = await fs.open(parent.source.path, 'r+');
  try { await handle.write(Buffer.from('session_metx'), 0, 12, Buffer.byteLength(text.slice(0, text.indexOf('session_meta')))); } finally { await handle.close(); }
  await parent.work('Held behind the block.', { filler: ['x'.repeat(2.2 * 1024 * 1024)] });
  assert((await run()).pending.includes('UNSUPPORTED_CODEX_HEADER'));
  assert.equal(await readReaderBlock(parent.store, identity), 'UNSUPPORTED_CODEX_HEADER');
  // The same header check binds typed commands, so they refuse as unverified.
  assert.equal((await h.call('capture_turns', {})).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
});

test('typed capture commands in a safety-stopped chat say its capture record is full and change nothing', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  await parent.work('Captured automatically.');
  await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const selected = await readSelection(parent.store, identity);
  await withIntakeLock(parent.store, tx => replaceIntakeJSON(tx, `sessions/codex/${identity.sessionId}.json`,
    { ...selected.state, safetyStop: { reason: 'capacity', unitId: randomUUID() } }, selected.hash));
  const stopped = await readSelection(parent.store, identity);
  for (const tool of ['capture_turns', 'pause_capture', 'resume_capture']) {
    const rpc = await h.call(tool, {}), reply = body(rpc);
    assert.equal(reply?.capture, 'full', JSON.stringify(rpc.error ?? reply));
    // Status does not bind here, so the reply does not point to it.
    assert.match(reply.statusText, /capture record is full/); assert.doesNotMatch(reply.statusText, /status/);
    await parent.finish(rpc);
  }
  assert.equal((await readSelection(parent.store, identity)).hash, stopped.hash);
});

test('pause chat applies even when processing status is unavailable or slow', async t => {
  for (const delayed of [false, true]) await t.test(delayed ? 'slow unreadable status' : 'unreadable status', async t => {
    const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
    const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    const before = await parent.work('Captured before the pause.'); await run();
    let elapsed = 0, pausedAtStatus;
    t.mock.method(performance, 'now', () => 1_000_000 + elapsed);
    h.beforeStatus = async () => {
      pausedAtStatus = (await readSelection(parent.store, identity)).state.paused;
      if (delayed) elapsed += 11_000;
      else throw Object.assign(new Error('unavailable synthetic processing registry'), { code: 'PROCESSING_CHAT_CONFLICT' });
    };
    const rpc = await h.call('pause_capture', {}), reply = body(rpc); await parent.finish(rpc);
    assert.equal(reply.capture, 'paused'); assert.equal(reply.status, 'blocked');
    assert.equal(pausedAtStatus, true, 'the opt-out precedes optional processing status');
    assert(reply.diagnostics.includes('PROCESSING_CHAT_OUTCOME_UNKNOWN'));
    assert((await readCaptureHead(parent.store, { ...identity, unitId: before })).head);
    const after = await parent.work('Kept out after the pause.'); await run();
    assert.equal((await readCaptureHead(parent.store, { ...identity, unitId: after })).head, null);
  });
});

test('pause and resume cancellation before publication preserves capture policy; publication keeps its known reply', async t => {
  for (const operation of ['pause', 'resume']) for (const duringPublication of [false, true]) await t.test(`${operation}: ${duringPublication ? 'during' : 'before'} publication`, async t => {
    const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
    await parent.work('Captured before controls.');
    await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    if (operation === 'resume') { const rpc = await h.call('pause_capture', {}); assert.equal(body(rpc).capture, 'paused'); await parent.finish(rpc); }
    const requestId = operation === 'resume' ? 2 : 1, before = (await readSelection(parent.store, identity)).state;
    const open = fs.open, rename = fs.rename, notified = deferred(); let cancelled = false;
    const cancel = async () => {
      cancelled = true; h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } });
      await new Promise(resolve => setImmediate(resolve)); notified.resolve();
    };
    if (duringPublication) t.mock.method(fs, 'rename', async (from, to) => {
      if (!cancelled && String(to).split(path.sep).includes('sessions')) await cancel();
      return rename(from, to);
    });
    else t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (!cancelled && path.basename(file).startsWith('.metadata-') && args[0] === 'wx') {
        const bytes = handle.writeFile.bind(handle);
        handle.writeFile = async value => {
          if (!cancelled && JSON.parse(value).format === 'cuefluent-selection') await cancel();
          return bytes(value);
        };
      }
      return handle;
    });
    const pending = h.call(operation === 'pause' ? 'pause_capture' : 'resume_capture', {});
    if (duringPublication) {
      const rpc = await pending; assert(cancelled); assert.equal(body(rpc).capture, operation === 'pause' ? 'paused' : 'resumed'); await parent.finish(rpc);
    } else {
      pending.catch(() => {}); await notified.promise; h.end(); await h.server;
      assert(cancelled); assert(!h.responses.some(row => row.id === requestId), 'cancelled controls have no late success reply');
    }
    const after = (await readSelection(parent.store, identity)).state;
    assert.equal(after.paused, duringPublication ? operation === 'pause' : before.paused);
    assert.equal(after.active, duringPublication ? operation === 'resume' : before.active);
    if (!duringPublication) assert.deepEqual(after.intervals, before.intervals, 'only command opt-out bookkeeping may change');
  });
});

test('typed capture, pause chat and resume chat follow Automatic capture of the chat', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const head = async unitId => (await readCaptureHead(parent.store, { ...identity, unitId })).head;
  const typed = async (tool, expected) => {
    const rpc = await h.call(tool, {}), reply = body(rpc);
    assert.equal(reply.capture, expected, reply.statusText); await parent.finish(rpc); return reply;
  };
  const before = await parent.work('Captured automatically.');
  assert.equal((await run()).saved, 1); assert(await head(before));
  await typed('capture_turns', 'automatic'); await typed('resume_capture', 'already-active');
  await typed('pause_capture', 'paused');
  assert.equal((await readSelection(parent.store, identity)).state.paused, true);
  await typed('pause_capture', 'already-paused');
  const paused = await parent.work('Kept out while paused.'); await run();
  assert.equal(await head(paused), null);
  // A paused chat counts as Manual: a typed capture takes its later turns.
  assert.equal((await typed('capture_turns', 'captured')).turns, 1); assert(await head(paused));
  await typed('resume_capture', 'resumed');
  assert.equal((await readSelection(parent.store, identity)).state.active, true);
  const resumed = await parent.work('Captured again.'); await run();
  assert(await head(resumed));
  for (const unitId of parent.controls) assert.equal(await head(unitId), null, unitId);
});

test('typed capture never takes a turn from an earlier pause that resume chat closed', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const head = async unitId => (await readCaptureHead(parent.store, { ...identity, unitId })).head;
  const typed = async (tool, expected) => {
    const rpc = await h.call(tool, {}), reply = body(rpc);
    assert.equal(reply.capture, expected, reply.statusText); await parent.finish(rpc); await run(); return reply;
  };
  await parent.work('Captured automatically.'); await run();
  await typed('pause_capture', 'paused');
  const opted = await parent.work('Private: kept out by the pause.'); await run();
  await typed('resume_capture', 'resumed');
  const resumed = await parent.work('Captured again.'); await run(); assert(await head(resumed));
  await typed('pause_capture', 'paused');
  const later = await parent.work('Decision: taken while paused again.');
  // Only the turn of the current pause is captured; the first pause's turn stays out.
  assert.equal((await typed('capture_turns', 'captured')).turns, 1);
  assert(await head(later)); assert.equal(await head(opted), null);
  await typed('capture_turns', 'nothing-new'); assert.equal(await head(opted), null);
});

test('a stop met by a typed capture while paused does not outlive resume chat', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const head = async unitId => (await readCaptureHead(parent.store, { ...identity, unitId })).head;
  const typed = async (tool, expected) => {
    const rpc = await h.call(tool, {}), reply = body(rpc);
    assert.equal(reply.capture, expected, reply.statusText); await parent.finish(rpc); await run(); return reply;
  };
  await parent.work('Captured automatically.'); await run();
  await typed('pause_capture', 'paused');
  // A paused turn with evidence after its terminal record: the typed window holds on it.
  const held = await parent.work('Decision: held.');
  await parent.resume({});
  const text = await fs.readFile(parent.source.path, 'utf8'), last = text.lastIndexOf('\n', text.length - 2) + 1;
  const { timestamp, ordinal } = JSON.parse(text.slice(last));
  await fs.truncate(parent.source.path, Buffer.byteLength(text.slice(0, last)));
  await fs.appendFile(parent.source.path, JSON.stringify({ timestamp, ordinal, type: 'event_msg', payload: { type: 'item_completed',
    thread_id: identity.sessionId, turn_id: held, item: { type: 'AgentMessage', id: randomUUID(), content: [{ type: 'Text', text: 'Late evidence.' }] } } }) + '\n');
  await typed('capture_turns', 'blocked');
  await typed('resume_capture', 'resumed');
  const resumed = await parent.work('Captured again.'); await run();
  assert(await head(resumed));
  // Automatic capture goes on, and status and capture say so.
  assert.equal(await readReaderBlock(parent.store, identity), null);
  await typed('capture_turns', 'automatic');
  const status = body(await h.call('processing_status', {}));
  assert.doesNotMatch(status.statusText, /stopped/, status.statusText);
});

test('resume chat ends a stop of the stretch before the pause at once', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const call = async (tool, expected) => { const rpc = await h.call(tool, {}); assert.equal(body(rpc).capture, expected, body(rpc).statusText); await parent.finish(rpc); };
  // A turn with evidence after its terminal record stops Automatic capture.
  const held = await parent.work('Decision: held.');
  await parent.resume({});
  const text = await fs.readFile(parent.source.path, 'utf8'), last = text.lastIndexOf('\n', text.length - 2) + 1;
  const { timestamp, ordinal } = JSON.parse(text.slice(last));
  await fs.truncate(parent.source.path, Buffer.byteLength(text.slice(0, last)));
  await fs.appendFile(parent.source.path, JSON.stringify({ timestamp, ordinal, type: 'event_msg', payload: { type: 'item_completed',
    thread_id: identity.sessionId, turn_id: held, item: { type: 'AgentMessage', id: randomUUID(), content: [{ type: 'Text', text: 'Late evidence.' }] } } }) + '\n');
  await run();
  assert.equal(await readReaderBlock(parent.store, identity), 'EVIDENCE_AFTER_CODEX_TERMINAL');
  await call('pause_capture', 'paused'); await run();
  await call('resume_capture', 'resumed');
  assert.equal(await readReaderBlock(parent.store, identity), null);
  const later = await parent.work('Captured after the resume.'); await run();
  assert((await readCaptureHead(parent.store, { ...identity, unitId: later })).head);
  assert.equal(await readReaderBlock(parent.store, identity), null);
  await call('capture_turns', 'automatic');
});

test('typed capture and resume chat do not say Automatic capture covers a chat whose capture settings changed', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  await parent.work('Captured automatically.'); await run();
  // Capture settings saved again (as Automatic, then Manual, then Automatic):
  // the chat's capture needs review, and the worker refuses it until then.
  f.config.routes[0].collection.generation = randomUUID();
  await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  assert((await run()).diagnostics.some(item => item.sessionId === identity.sessionId && item.code === 'REGISTRATION_REQUIRES_REVIEW'));
  for (const tool of ['capture_turns', 'resume_capture']) {
    const rpc = await h.call(tool, {});
    assert.equal(rpc.error?.data?.code, 'REGISTRATION_REQUIRES_REVIEW', `${tool}: ${JSON.stringify(rpc)}`);
  }
  // A pause still applies, and resume chat then grants the chat again.
  for (const [tool, expected] of [['pause_capture', 'paused'], ['resume_capture', 'resumed']]) {
    const rpc = await h.call(tool, {}); assert.equal(body(rpc).capture, expected, JSON.stringify(rpc)); await parent.finish(rpc);
  }
  const later = await parent.work('Captured again.'), after = await run();
  assert(!after.diagnostics.some(item => item.sessionId === identity.sessionId), JSON.stringify(after.diagnostics));
  assert((await readCaptureHead(parent.store, { ...identity, unitId: later })).head);
});

test('a typed command that fails in a chat Automatic capture covers says its turn was not left out', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  await parent.work('Captured automatically.'); await run();
  // The command fails before it records the receipt that keeps a command turn out.
  h.beforeStatus = () => { throw Object.assign(new Error('synthetic'), { code: 'PROCESSING_CLIENT_AUTHENTICATION_INVALID' }); };
  const rpc = await h.call('processing_status', {});
  assert.equal(rpc.error?.data?.code, 'PROCESSING_CLIENT_AUTHENTICATION_INVALID', JSON.stringify(rpc));
  assert.deepEqual(rpc.error.data.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
  // The selection a redelivery replays under is unchanged.
  assert(!(await readSelection(parent.store, identity)).state.exclusions.includes(parent.controls.at(-1)));
});

test('a block thrown by a typed capture after Automatic capture went on is not its stop', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const typed = async (tool, expected) => {
    const rpc = await h.call(tool, {}), reply = body(rpc);
    assert.equal(reply.capture, expected, reply.statusText); await parent.finish(rpc); await run();
  };
  await parent.work('Captured automatically.'); await run();
  await typed('pause_capture', 'paused');
  await parent.work('Decision: taken by hand.');
  await typed('capture_turns', 'captured');
  await typed('resume_capture', 'resumed');
  // The typed capture's saved progress is no longer valid: every visit that
  // reaches it throws, after the stretch Automatic capture extends.
  const [scope] = (await readSelection(parent.store, identity)).state.explicitScopes;
  await fs.writeFile(path.join(f.collection.intakeStateDir, 'progress', 'codex', identity.sessionId, `${scope.id}.json`), '{not json');
  const later = await parent.work('Captured after the resume.'); await run();
  assert((await readCaptureHead(parent.store, { ...identity, unitId: later })).head);
  assert.equal(await readReaderBlock(parent.store, identity), null);
  await typed('capture_turns', 'automatic');
});

test('a fault in the stretch before a pause does not hold up Automatic capture after the resume', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const typed = async (tool, expected) => {
    const rpc = await h.call(tool, {}), reply = body(rpc);
    assert.equal(reply.capture, expected, reply.statusText); await parent.finish(rpc); await run();
  };
  await parent.work('Captured automatically.'); await run();
  await typed('pause_capture', 'paused');
  await typed('resume_capture', 'resumed');
  // The earlier stretch's saved progress is no longer valid: visiting it throws
  // before the stretch Automatic capture now extends.
  const [earlier] = (await readSelection(parent.store, identity)).state.intervals;
  await fs.writeFile(path.join(f.collection.intakeStateDir, 'progress', 'codex', identity.sessionId, `${earlier.id}.json`), '{not json');
  const later = await parent.work('Captured after the resume.'); await run();
  assert((await readCaptureHead(parent.store, { ...identity, unitId: later })).head);
  assert.equal(await readReaderBlock(parent.store, identity), null);
  await typed('capture_turns', 'automatic');
});

test('typed capture takes a turn rewritten into the paused stretch after the pause record', async t => {
  // With no progress, as when a read stopped short of the pause's end, and
  // with progress past it whose own anchor still holds.
  for (const progress of ['none', 'past the pause end']) await t.test(progress, async t => {
    const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
    const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    await parent.work('Captured automatically.'); await run();
    const rpc = await h.call('pause_capture', {}); assert.equal(body(rpc).capture, 'paused'); await parent.finish(rpc); await run();
    const { upper, id } = (await readSelection(parent.store, identity)).state.intervals.at(-1);
    assert(upper.record && upper.record.endByte < upper.eofByte);
    if (progress === 'none') await fs.rm(path.join(f.collection.intakeStateDir, 'progress', 'codex', identity.sessionId, `${id}.json`));
    // The transcript is rewritten in place after the pause turn's anchored record,
    // keeping that record, the file and every byte from the pause's end on: a
    // turn that was never captured now lies inside the paused stretch.
    const text = await fs.readFile(parent.source.path), region = text.subarray(upper.record.endByte, upper.eofByte).toString();
    const ordinals = region.trimEnd().split('\n').map(line => JSON.parse(line).ordinal), inserted = randomUUID();
    const row = (ordinal, payload) => JSON.stringify({ timestamp: '2026-10-10T12:00:00.000Z', ordinal, type: 'event_msg', payload }) + '\n';
    const said = (ordinal, item) => row(ordinal, { type: 'item_completed', thread_id: identity.sessionId, turn_id: inserted, item: { id: 'x', ...item } });
    const rows = pad => row(ordinals[0], { type: 'task_started', turn_id: inserted, root_turn_id: inserted }) +
      said(ordinals[1], { type: 'UserMessage', content: [{ type: 'text', text: 'Decision: rewritten in.' }] }) +
      said(ordinals[2], { type: 'AgentMessage', content: [{ type: 'Text', text: 'Noted.' + ' '.repeat(pad) }] }) +
      row(ordinals[3], { type: 'task_complete', turn_id: inserted });
    assert.equal(ordinals.length, 4);
    const replacement = Buffer.from(rows(Buffer.byteLength(region) - Buffer.byteLength(rows(0))));
    assert.equal(replacement.length, upper.eofByte - upper.record.endByte);
    const handle = await fs.open(parent.source.path, 'r+');
    try { await handle.write(replacement, 0, replacement.length, upper.record.endByte); } finally { await handle.close(); }
    // No anchor vouches for the stretch after the pause record, so it is not
    // Automatic capture's: a typed capture takes the turn.
    const typed = await h.call('capture_turns', {}), reply = body(typed); await parent.finish(typed);
    assert.equal(reply.capture, 'captured', reply.statusText); assert.equal(reply.turns, 1);
    assert((await readCaptureHead(parent.store, { ...identity, unitId: inserted })).head);
  });
});

test('typed capture takes a turn rewritten in place inside the stretch Automatic capture covered', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  await parent.work('Decision: ship on Friday.'); const middle = await parent.work('Owner: Dana.'); await parent.work('Budget: ten.');
  assert.equal((await run()).saved, 3);
  const rpc = await h.call('pause_capture', {}); assert.equal(body(rpc).capture, 'paused'); await parent.finish(rpc); await run();
  // The middle turn is rewritten in place as a turn that was never captured.
  // Where Automatic capture began and the worker's progress both still hold.
  const inserted = randomUUID(), text = await fs.readFile(parent.source.path, 'utf8');
  assert.equal(inserted.length, middle.length);
  const handle = await fs.open(parent.source.path, 'r+');
  try { await handle.write(Buffer.from(text.replaceAll(middle, inserted)), 0, Buffer.byteLength(text), 0); } finally { await handle.close(); }
  const typed = await h.call('capture_turns', {}), reply = body(typed); await parent.finish(typed);
  assert.equal(reply.capture, 'captured', reply.statusText); assert.equal(reply.turns, 1);
  assert.match((await readCaptureHead(parent.store, { ...identity, unitId: inserted })).capture.evidence[0].text, /Owner: Dana/);
});

test('typed capture in a paused chat takes a turn Automatic capture has not read yet', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  await parent.work('Captured automatically.'); await run();
  // Writes rows into ordinal slots the parent's own counter has passed.
  const slots = async rows => {
    for (const _ of rows) await parent.resume({});
    const lines = (await fs.readFile(parent.source.path, 'utf8')).trimEnd().split('\n'), ordinals = lines.slice(-rows.length).map(line => JSON.parse(line).ordinal);
    await fs.writeFile(parent.source.path, [...lines.slice(0, -rows.length), ...rows.map((row, i) =>
      JSON.stringify({ timestamp: '2026-10-10T12:00:00.000Z', ordinal: ordinals[i], type: 'event_msg', payload: row }))].join('\n') + '\n');
  };
  // A turn still unfinished when the chat is paused holds the worker's progress
  // before it, while the reader already anchors the later pause turn.
  const late = randomUUID();
  await slots([{ type: 'task_started', turn_id: late, root_turn_id: late },
    { type: 'item_completed', thread_id: identity.sessionId, turn_id: late, item: { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text: 'Decision: finished late.' }] } }]);
  const rpc = await h.call('pause_capture', {}); assert.equal(body(rpc).capture, 'paused'); await parent.finish(rpc); await run();
  assert((await readSelection(parent.store, identity)).state.intervals.at(-1).upper.record);
  await slots([{ type: 'task_complete', turn_id: late }]);
  // Automatic capture has not read the finished turn, so a typed capture takes it.
  const typed = await h.call('capture_turns', {}), reply = body(typed); await parent.finish(typed);
  assert.equal(reply.capture, 'captured', reply.statusText); assert.equal(reply.turns, 1);
  const head = await readCaptureHead(parent.store, { ...identity, unitId: late });
  assert(head.head);
  // The worker's later pass leaves it as it is.
  await run();
  assert.equal(await readReaderBlock(parent.store, identity), null);
  assert.equal((await readCaptureHead(parent.store, { ...identity, unitId: late })).hash, head.hash);
});

test('agent-created hook registration reaches real capture, native processing and exact proposal review', async t => {
  const { f, h, parent } = await nativeIngressFixture(t), sessionId = f.identity.sessionId;
  assert.equal((await readSelection(parent.store, f.identity)).state, null);
  f.identity.unitId = await parent.work('Source decision: hold the rollout.');
  const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  const collected = await run(); assert.deepEqual(collected.pending, []); assert.equal(collected.saved, 1);
  assert(collected.boundaryExcluded.some(item => item.unitId === parent.boundaryUnitId));
  assert.equal((await readCaptureHead(parent.store, { ...f.identity, unitId: parent.boundaryUnitId })).head, null);
  const retained = await readCaptureHead(parent.store, f.identity);
  assert.equal(retained.capture.evidence[0].text, 'Source decision: hold the rollout.');
  f.inputs = [{ identity: f.identity, headHash: retained.hash }];
  h.script = proposeThroughTools(f);
  const closed = h.whenClosed(), started = await h.call('process_selected_captures', {});
  assert.equal(body(started).status, 'busy'); await parent.finish(started); await closed; await h.jobs[0];
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  const next = h.nextForm(), review = h.call('processing_review', {}), form = await next;
  const preview = form.params.requestedSchema.properties.changes.default;
  assert(preview.includes('PRIVATE-SYNTHETIC-PROPOSAL')); assert(preview.includes('Keep the rollout paused.'));
  assert(preview.includes(`codex session ${sessionId}, turn ${f.identity.unitId}`));
  assert(preview.includes('Terminal: completed'));
  assert(preview.includes(`Exact proposal: ${(await inspectProcessing(f.capability, f.operationId)).proposalHash}`));
  h.answer(form, { action: 'accept', content: { decision: 'save' } });
  const reviewed = await review; assert.equal(body(reviewed).status, 'idle'); await parent.finish(reviewed);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  const correction = await parent.work('Correction: the rollout can proceed after verification.');
  assert.equal((await run()).saved, 1);
  for (const unitId of parent.controls) assert.equal((await readCaptureHead(parent.store, { ...f.identity, unitId })).head, null);
  assert.match((await readCaptureHead(parent.store, { ...f.identity, unitId: correction })).capture.evidence[0].text, /Correction/);
  assert.equal((await readCaptureHead(parent.store, f.identity)).hash, retained.hash);
  assert.equal((await run()).saved, 0);
});

test('exact unverified registration is diagnostic only for every native control', async t => {
  const { f, h, parent } = await nativeIngressFixture(t);
  const files = await fs.readdir(f.collection.intakeStateDir, { recursive: true });
  const recordPath = path.join(f.collection.intakeStateDir, registrationPath(f.identity)), bytes = await fs.readFile(recordPath);
  const config = await fs.readFile(f.options.configPath);
  const original = fs.open;
  t.mock.method(fs, 'open', async function(file, ...args) {
    assert.notEqual(file, parent.source.path, 'diagnostics must not open native evidence');
    assert(!String(file).startsWith(f.collection.rawDir + path.sep), 'diagnostics must not open captures');
    return original.call(this, file, ...args);
  });
  for (const tool of ['processing_status', 'process_selected_captures', 'processing_review']) for (const explicit of [false, true]) {
    const result = await h.call(tool, explicit ? { collectionId: f.collection.id } : {});
    assert.equal(result.error.code, -32600); assert.equal(result.error.data.code, 'PROCESSING_CONTROL_REGISTRATION_UNVERIFIED');
    assert(!JSON.stringify(result).includes(f.root));
  }
  assert.equal(h.opens, 0); assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
  assert.equal((await readSelection(parent.store, f.identity)).state, null);
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir, { recursive: true }), files);
  assert.deepEqual(await fs.readFile(recordPath), bytes); assert.deepEqual(await fs.readFile(f.options.configPath), config);
  assert.deepEqual(await fs.readdir(f.collection.rawDir), []); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('missing exact registration never borrows an unrelated registration or a collection-wide failure', async t => {
  const { f, h } = await nativeIngressFixture(t);
  const exact = path.join(f.collection.intakeStateDir, registrationPath(f.identity));
  const otherIdentity = { ...f.identity, sessionId: randomUUID() };
  const other = path.join(f.collection.intakeStateDir, registrationPath(otherIdentity));
  await fs.mkdir(path.dirname(other), { recursive: true });
  const registration = JSON.parse(await fs.readFile(exact));
  await fs.writeFile(other, JSON.stringify({ ...registration, sessionId: otherIdentity.sessionId }), { mode: 0o600 });
  await fs.rm(exact);
  const original = fs.open;
  t.mock.method(fs, 'open', async function(file, ...args) {
    assert.notEqual(file, other); assert.notEqual(file, f.source.path);
    assert.notEqual(file, path.join(f.collection.intakeStateDir, 'ingress/status/record.json'));
    return original.call(this, file, ...args);
  });
  // With no record for this session, a plain status gets the command list; an
  // explicit collection still refuses. Neither reads the other session.
  const unbound = body(await h.call('processing_status', {}));
  assert.equal(unbound.statusDetail, 'unbound'); assert.equal(unbound.help, true);
  assert.equal((await h.call('processing_status', { collectionId: f.collection.id })).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.equal((await h.call('processing_review', {})).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.equal(h.opens, 0); assert.equal(h.dispatches, 0);
});

test('refused ownership remains unverified while a stale registration grant explicitly requires review', async t => {
  for (const variant of ['ownership', 'grant']) await t.test(variant, async t => {
    const { f, h } = await nativeIngressFixture(t, { headerChanges: variant === 'ownership' ? { parent_thread_id: randomUUID() } : {} });
    if (variant === 'grant') {
      f.config.routes[0].collection.generation = randomUUID();
      await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
    }
    const worker = await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    assert(worker.pending.includes(variant === 'ownership' ? 'UNSUPPORTED_SESSION_OWNERSHIP' : 'REGISTRATION_REQUIRES_REVIEW'));
    const original = fs.open;
    t.mock.method(fs, 'open', async function(file, ...args) {
      assert.notEqual(file, f.source.path); assert.notEqual(file, path.join(f.collection.intakeStateDir, 'ingress/status/record.json'));
      return original.call(this, file, ...args);
    });
    const files = await fs.readdir(f.collection.intakeStateDir, { recursive: true });
    for (const args of [{}, { collectionId: f.collection.id }]) {
      const result = await h.call('process_selected_captures', args);
      assert.equal(result.error.data.code, variant === 'grant' ? 'REGISTRATION_REQUIRES_REVIEW' : 'PROCESSING_CONTROL_REGISTRATION_UNVERIFIED');
      assert(!JSON.stringify(result).includes(f.root));
    }
    assert.deepEqual(await fs.readdir(f.collection.intakeStateDir, { recursive: true }), files);
    assert.equal(h.opens, 0); assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
    assert.deepEqual(await fs.readdir(f.collection.rawDir), []);
  });
});

test('old registrations without current collection consent do not request grant review', async t => {
  for (const variant of ['disabled-manual', 'disabled-prompted', 'deselected', 'excluded', 'unconfigured']) await t.test(variant, async t => {
    const { f, h, parent } = await nativeIngressFixture(t), route = f.config.routes[0];
    if (variant.startsWith('disabled')) route.collection.enabled = false;
    if (variant === 'disabled-prompted') route.processing.mode = 'prompted';
    if (variant === 'deselected') route.collection.selection = { kind: 'sessions', sessionIds: [] };
    if (variant === 'excluded') route.excluded = true;
    if (variant === 'unconfigured') f.config.routes = [];
    const config = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, config);
    const file = path.join(f.collection.intakeStateDir, registrationPath(f.identity)), before = await fs.readFile(file);
    const files = await fs.readdir(f.collection.intakeStateDir, { recursive: true }), original = fs.open;
    const guardedOpen = t.mock.method(fs, 'open', async function(file, ...args) {
      assert.notEqual(file, parent.source.path, 'a retired registration grants no native read');
      assert(!String(file).startsWith(f.collection.rawDir + path.sep));
      return original.call(this, file, ...args);
    });
    for (const tool of ['processing_status', 'process_selected_captures', 'processing_review']) for (const args of [{}, { collectionId: f.collection.id }]) {
      const result = await h.call(tool, args);
      // With no route left for this client, nothing is set up for the chat: a
      // plain status gets the command list. A retired registration still refuses.
      if (variant === 'unconfigured' && tool === 'processing_status' && args.collectionId === undefined) {
        assert.equal(body(result).statusDetail, 'unbound'); assert.equal(body(result).help, true);
      } else { assert.equal(result.error.code, -32600); assert.equal(result.error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); }
    }
    assert.equal(h.opens, 0); assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
    assert.equal((await readSelection(parent.store, f.identity)).state, null);
    assert.deepEqual(await fs.readdir(f.collection.intakeStateDir, { recursive: true }), files);
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal(await fs.readFile(f.options.configPath, 'utf8'), config);
    assert.deepEqual(await fs.readdir(f.collection.rawDir), []); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    guardedOpen.mock.restore();
    if (variant === 'disabled-prompted') {
      const ingress = await collectionIngress('codex', { session_id: f.identity.sessionId, turn_id: randomUUID(),
        cwd: f.project, transcript_path: parent.source.path, hook_event_name: 'UserPromptSubmit' }, {
        configPath: f.options.configPath, launch: () => assert.fail('collection must remain off') });
      assert.equal(ingress.status, 'processing-only');
      for (const args of [{}, { collectionId: f.collection.id }]) assert.equal(body(await h.call('processing_status', args)).status, 'missing');
      assert.deepEqual(await fs.readFile(file), before);
      // Each typed status left its own turn out of later captures; nothing was armed.
      assertOnlyCommandTurnsLeftOut(await readSelection(parent.store, f.identity), { state: null }, parent.controls.slice(-2));
      assert.equal(await fs.readFile(f.options.configPath, 'utf8'), config);
      assert.deepEqual(await fs.readdir(f.collection.rawDir), []);
    }
  });
});

test('damaged or mismatched pending registration metadata cannot become a binding', async t => {
  for (const variant of ['identity', 'malformed', 'null', 'oversized', 'linked']) await t.test(variant, async t => {
    const { f, h } = await nativeIngressFixture(t), file = path.join(f.collection.intakeStateDir, registrationPath(f.identity));
    if (variant === 'identity') {
      const value = JSON.parse(await fs.readFile(file)); value.sessionId = randomUUID(); await fs.writeFile(file, JSON.stringify(value));
    } else if (variant === 'linked') await fs.link(file, path.join(f.root, 'second-link.json'));
    else await fs.writeFile(file, variant === 'malformed' ? '{' : variant === 'null' ? 'null' : ' '.repeat(16385));
    const before = await fs.readFile(file), result = await h.call('process_selected_captures', {});
    // Damaged metadata fails the binding before any action: nothing applies.
    assert.equal(result.error.data.code, variant === 'linked' ? 'UNSAFE_PRIVATE_STORAGE' : 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    assert.match(result.error.message, /^Cuefluent: Nothing was applied: /);
    assert.deepEqual(await fs.readFile(file), before); assert.equal(h.opens, 0); assert.equal(h.dispatches, 0);
  });
});

test('a pending-only candidate cannot block a verified native source in another collection', async t => {
  const f = await processingFixture(t), other = await storageFixture(t, { fullSetup: false });
  const h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation }); await nativeParent(t, f, h);
  const collection = { ...other.collection, id: 'waiting' };
  f.config.collections.unshift(collection);
  f.config.routes.unshift({ ...other.config.routes[0], id: 'waiting', collectionId: 'waiting' });
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  f.options.expectedConfigHash = digest(bytes); f.capability = await verifyWorkflowStorage(f.options);
  const source = path.join(other.project, 'registered.jsonl'); await fs.writeFile(source, 'No native reads authorized here.\n');
  await collectionIngress('codex', { session_id: f.identity.sessionId, turn_id: randomUUID(), cwd: other.project,
    transcript_path: source, hook_event_name: 'UserPromptSubmit' }, { configPath: f.options.configPath, launch: async () => {} });
  const pending = path.join(collection.intakeStateDir, registrationPath(f.identity));
  const original = fs.open;
  t.mock.method(fs, 'open', async function(file, ...args) {
    assert.notEqual(file, source); assert.notEqual(file, pending); return original.call(this, file, ...args);
  });
  assert.equal(body(await h.call('processing_status', {})).status, 'missing');
  await fs.writeFile(pending, '{'); // Broken diagnostic metadata still cannot block the valid source.
  assert.equal(body(await h.call('processing_status', {})).status, 'missing');
  const lstat = fs.lstat;
  for (const code of ['ENOTDIR', 'EACCES', 'ELOOP']) {
    const mocked = t.mock.method(fs, 'lstat', async function(file, ...args) {
      if (file === pending) throw Object.assign(new Error('Synthetic inaccessible diagnostic'), { code });
      return lstat.call(this, file, ...args);
    });
    assert.equal(body(await h.call('processing_status', {})).status, 'missing');
    assert.equal((await h.call('processing_status', { collectionId: 'waiting' })).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    mocked.mock.restore();
  }
  assert.equal(h.opens, 5); assert.equal(h.dispatches, 0);
  await assert.rejects(fs.lstat(path.join(collection.intakeStateDir, 'sessions')), { code: 'ENOENT' });
  const store = await openWorkflowIntake(f.capability), selected = await readSelection(store, f.identity);
  selected.state.safetyStop = { reason: 'capacity', unitId: f.identity.unitId };
  await withIntakeLock(store, tx => replaceIntakeJSON(tx, `sessions/codex/${f.identity.sessionId}.json`, selected.state, selected.hash));
  // A failed real binding must remain visible, even beside damaged registration-only metadata.
  assert.equal((await h.call('processing_status', {})).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.equal(h.opens, 5); assert.equal(h.dispatches, 0);
});

test('explicit collection requests use guarded intake paths before source classification', async t => {
  for (const parentName of ['sessions/codex', 'ingress/processing-sources/codex']) await t.test(parentName, async t => {
    const { f, h } = await nativeIngressFixture(t), parent = path.join(f.collection.intakeStateDir, parentName);
    await fs.mkdir(path.dirname(parent), { recursive: true, mode: 0o700 });
    await fs.writeFile(parent, 'Synthetic invalid directory', { mode: 0o600 });
    const before = await fs.readFile(parent);
    assert.equal((await h.call('processing_status', { collectionId: f.collection.id })).error.data.code, 'UNSAFE_INTAKE_PATH');
    assert.deepEqual(await fs.readFile(parent), before);
    assert.equal(h.opens, 0); assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
  });
});

test('old-policy processing-only bindings do not hide a pending Codex collection registration', async t => {
  const f = await processingFixture(t), h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
  const parent = await nativeParent(t, f, h, { binding: 'processing-only' });
  const hook = () => collectionIngress('codex', { session_id: parent.source.sessionId, turn_id: randomUUID(),
    cwd: f.project, transcript_path: parent.source.path, hook_event_name: 'UserPromptSubmit' }, {
    configPath: f.options.configPath, launch: async () => {} });
  f.config.routes[0].collection.enabled = false; f.config.routes[0].processing.mode = 'prompted';
  await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  assert.equal((await hook()).status, 'processing-only');
  f.config.routes[0].collection.enabled = true; f.config.routes[0].collection.generation = randomUUID();
  await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  assert.equal((await hook()).status, 'queued');
  for (const args of [{}, { collectionId: f.collection.id }]) {
    assert.equal((await h.call('process_selected_captures', args)).error.data.code, 'PROCESSING_CONTROL_REGISTRATION_UNVERIFIED');
  }
  assert.equal(h.opens, 0); assert.equal(h.dispatches, 0);
});

test('actual unsupported native ownership remains a path-free public refusal', async t => {
  const f = await processingFixture(t), h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
  await nativeParent(t, f, h, { headerChanges: { thread_source: 'agent_created_thread', parent_thread_id: randomUUID() } });
  for (const args of [{}, { collectionId: f.collection.id }]) {
    assert.deepEqual((await h.call('processing_review', args)).error, { code: -32600, data: { code: 'UNSUPPORTED_SESSION_OWNERSHIP' },
      message: 'Cuefluent: Nothing was applied and nothing was saved: this chat is not a session Cuefluent Notes can verify, for example a forked or agent session.' });
  }
  assert.equal(h.forms.length, 0); assert.equal(h.opens, 0); assert.equal(h.dispatches, 0);
});

test('resumed history and project mismatches remain actionable through the public MCP control', async t => {
  for (const kind of ['history', 'project']) await t.test(kind, async t => {
    const f = await processingFixture(t), h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
    const parent = await nativeParent(t, f, h, { headerChanges: { thread_source: 'agent_created_thread' } });
    const changes = kind === 'history' ? { history_mode: 'legacy' } : { cwd: path.join(f.root, 'other-project') };
    await parent.resume(changes);
    const selected = await readSelection(parent.store, f.identity);
    for (const args of [{}, { collectionId: f.collection.id }]) {
      const response = await h.call('processing_review', args);
      assert.equal(response.error.data.code, kind === 'history' ? 'UNSUPPORTED_CODEX_HISTORY' : 'SOURCE_IDENTITY_MISMATCH');
      assert(!JSON.stringify(response).includes(f.root));
    }
    assert.equal((await readSelection(parent.store, f.identity)).hash, selected.hash);
    assert.equal(h.opens, 0); assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
  });
});

test('actual source binding, engine proposal, native review and collection preserve genuine work without creating a control backlog', async t => {
  for (const mixed of [false, true]) await t.test(mixed ? 'work before and correction after controls' : 'pure controls', async t => {
    const f = await processingFixture(t), h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
    const parent = await nativeParent(t, f, h), genuine = [];
    if (mixed) genuine.push(await parent.work('Original work: SDK 605 keeps the rollout paused.'));
    h.script = proposeThroughTools(f);
    const closed = h.whenClosed();
    const processResult = await h.call('process_selected_captures', { requestId: randomUUID(), selection: selectedInput(f) });
    await parent.finish(processResult); await closed; await h.jobs[0];
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
    const next = h.nextForm(), review = h.call('processing_review', {});
    const form = await next;
    assert(form.params.requestedSchema.properties.changes.default.includes('PRIVATE-SYNTHETIC-PROPOSAL'));
    h.answer(form, { action: 'accept', content: { decision: 'save' } });
    await parent.finish(await review);
    if (mixed) genuine.push(await parent.work('Correction: SDK 606 is now verified.'));
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
    await withIntakeLock(parent.store, async tx => {
      const result = await processScope(tx, parent.store, parent.selected, parent.selected.state.intervals[0].id, async () => true);
      assert.equal(result.saved, genuine.length); assert.equal(result.pending, null);
      for (const unitId of parent.controls) assert.equal((await readCaptureHead(parent.store, { client: 'codex', sessionId: parent.source.sessionId, unitId })).head, null);
      for (const unitId of genuine) {
        const capture = (await readCaptureHead(parent.store, { client: 'codex', sessionId: parent.source.sessionId, unitId })).capture;
        assert(capture.evidence.some(item => /SDK 60[56]/.test(item.text)));
      }
      const replay = await processScope(tx, parent.store, parent.selected, parent.selected.state.intervals[0].id, async () => true);
      assert.equal(replay.saved, 0);
    });
    assert(!JSON.stringify(h.responses.filter(row => row.method !== 'elicitation/create')).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
    assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
  });
});

test('a note edit during source review keeps the exact proposal pending and preserves human content', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next, target = path.join(f.collection.notes.notesDir, 'meetings/rollout.md');
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, '# Human correction\n');
  h.answer(form, { action: 'accept', content: { decision: 'save' } });
  assert((await result).error);
  assert.equal(await fs.readFile(target, 'utf8'), '# Human correction\n');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  assert.equal(h.dispatches, 1);
});

test('cancellation during receipt publication preserves admitted dispatch and its replayable response', async t => {
  const f = await processingFixture(t), h = await harness(t, f, { resolveInvocation: resolveProcessingInvocation });
  await nativeParent(t, f, h);
  const rename = fs.rename; let cancelled = false;
  t.mock.method(fs, 'rename', async function(from, to) {
    if (!cancelled && to.includes(`${path.sep}control-dispatch${path.sep}`)) {
      cancelled = true;
      h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
      await new Promise(resolve => setImmediate(resolve));
    }
    return rename.call(this, from, to);
  });
  const closed = h.whenClosed();
  const admitted = body(await h.call('process_selected_captures', { collectionId: f.collection.id }));
  await closed;
  assert.equal(cancelled, true); assert.equal(admitted.status, 'busy'); assert.equal(h.dispatches, 1);
  assert.equal(h.creates, 1); assert.equal(h.responses.filter(row => row.id === 1).length, 1);
});


test('a formal code-mode control records an exclusion receipt naming both cells and the retry call', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true; h.codeMode = true;
  const closed = h.whenClosed();
  const value = body(await h.call('process_selected_captures', { collectionId: f.collection.id }));
  assert.deepEqual(value.diagnostics, []);
  await closed; assert.equal(h.dispatches, 1);
  // The binding's callId is the handshake's nested call; this call is the retry.
  const file = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest('exec-handshake-call_1').slice(0, 24)}.json`);
  const { dispatch } = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual([dispatch.callId, dispatch.outerItemId, dispatch.retryItemId, dispatch.retryCallId, dispatch.handshakeResultHash],
    ['exec-handshake-call_1', 'ctc_handshake_item_1', 'item_1', 'call_1', digest('synthetic handshake result')]);
  // Without collection there is nothing to exclude and no receipt.
  const off = await processingFixture(t), g = await harness(t, off); g.nativeSkill = true; g.codeMode = true; g.captureActive = false;
  assert.deepEqual(body(await g.call('processing_status', { collectionId: off.collection.id })).diagnostics, []);
  await assert.rejects(fs.lstat(path.join(off.collection.intakeStateDir, 'control-dispatch')), { code: 'ENOENT' });
});
