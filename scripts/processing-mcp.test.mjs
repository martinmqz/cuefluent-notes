import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { processingFixture, proposedClaim, replaceProcessingStorage } from './test-support/processing-fixture.mjs';
import { deferred, body, selectedInput, harness } from './test-support/processing-mcp.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { inspectProcessingShortcut } from './processing-shortcuts.mjs';
import { processingControlAction } from './processing-control-proof.mjs';
import { runProcessingMcp, processingStatusView } from './processing-mcp.mjs';
import { readSelection, controlSelection, readCaptureHead } from './intake-store.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { inspectProcessing, readProcessingProposal, completeProcessing } from './processing.mjs';
import { createProcessingWorkset } from './processing-workset.mjs';
import { reviewProcessingProposal } from './processing-host-review.mjs';
import { resolveProcessingInvocation } from './processing-native-invocation.mjs';
import { openWorkflowIntake, withIntakeLock, replaceIntakeJSON } from './intake-io.mjs';
import { collectionIngress, registrationPath, publishIngressMetadata, collectionStatusPath } from './collection-ingress.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { processScope, READER_BLOCK_CODES, readReaderBlock } from './collection-worker.mjs';
import { COLLECTION_STOP_CODES } from './processing-control-server.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { runCollectionWorker } from './test-support/capture-workflow.mjs';

async function prepareFromPending(call, f) {
  const pending = await call('processing_pending', {});
  const request = pending.nextPreparation;
  assert(request, 'the engine must expose a bounded exact next batch');
  f.operationId = request.operationId;
  return call('processing_prepare', request);
}

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

test('legacy status receipts replay unchanged after clearer status details are introduced', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true;
  const args = { collectionId: f.collection.id }, closed = h.whenClosed();
  await h.call('process_selected_captures', args); await closed;
  const file = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest('call_1').slice(0, 24)}.json`);
  const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
  const legacy = receipt.dispatch.response;
  delete legacy.statusDetail; delete legacy.scope; delete legacy.progress;
  legacy.statusText = 'Cuefluent processing: busy.';
  const result = { content: [{ type: 'text', text: canonicalJSON(legacy) }], isError: false };
  receipt.dispatch.statusText = legacy.statusText;
  receipt.dispatch.resultHash = digest(canonicalJSON(result));
  const bytes = canonicalJSON(receipt) + '\n';
  await fs.writeFile(file, bytes);
  h.callId = 'call_1';
  assert.deepEqual((await h.call('process_selected_captures', args)).result, result);
  assert.equal(h.dispatches, 1);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('a receipt written with earlier reply wording replays byte-for-byte, never re-rendered', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true;
  const args = { collectionId: f.collection.id }, closed = h.whenClosed();
  await h.call('process_selected_captures', args); await closed;
  const file = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest('call_1').slice(0, 24)}.json`);
  const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
  // The same reply as an earlier release worded it, recorded consistently.
  const earlier = receipt.dispatch.response;
  assert.equal(earlier.statusDetail, 'accepted'); assert.equal(earlier.scope, 'collection');
  earlier.statusText = 'Cuefluent: Processing request accepted. Scope: collection.';
  const result = { content: [{ type: 'text', text: canonicalJSON(earlier) }], isError: false };
  receipt.dispatch.statusText = earlier.statusText;
  receipt.dispatch.resultHash = digest(canonicalJSON(result));
  const bytes = canonicalJSON(receipt) + '\n';
  await fs.writeFile(file, bytes);
  h.callId = 'call_1';
  assert.deepEqual((await h.call('process_selected_captures', args)).result, result);
  assert.equal(h.dispatches, 1);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
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

const draft = '# PRIVATE-SYNTHETIC-PROPOSAL\n\n## Decision\n\nKeep the rollout paused.\n';
function proposeThroughTools(f, content = draft, expectedHash = null) {
  return async call => {
    let claim = await prepareFromPending(call, f);
    for (let page = 0; page < claim.packet.pages.length; page++) {
      const read = await call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page });
      claim = await call('processing_ack', { operationId: f.operationId, expectedClaimHash: read.claimHash,
        pages: [{ index: page, hash: read.hash }] });
    }
    await call('processing_propose', { operationId: f.operationId, expectedClaimHash: claim.claimHash,
      proposal: { files: [{ path: 'meetings/rollout.md', expectedHash, content }],
        mappings: [{ identity: f.identity, paths: ['meetings/rollout.md'] }] } });
  };
}
async function proposeInChat(f, h, content = draft, expectedHash = null) {
  h.script = proposeThroughTools(f, content, expectedHash);
  const closed = h.whenClosed(), requestId = randomUUID();
  const first = body(await h.call('process_selected_captures', { collectionId: f.collection.id, requestId, selection: selectedInput(f) }));
  await closed;
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  return first;
}

test('source review requires a correlated host action and saves the exact engine proposal without exposing the draft to the source model', async t => {
  const f = await processingFixture(t), h = await harness(t, f), first = await proposeInChat(f, h);
  const forged = await h.call('processing_review', { collectionId: f.collection.id, decision: 'save' });
  assert.equal(forged.error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const nextForm = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await nextForm;
  assert(form.params.requestedSchema.properties.changes.default.includes('PRIVATE-SYNTHETIC-PROPOSAL'));
  assert(form.params.requestedSchema.properties.changes.default.includes((await inspectProcessing(f.capability, f.operationId)).proposalHash));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  h.answer(form, { action: 'accept', content: { decision: 'save' } });
  const result = body(await review);
  assert.equal(result.status, 'idle'); assert.equal(result.chat.sessionId, first.chat.sessionId);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert(!JSON.stringify(h.responses.filter(row => row.method !== 'elicitation/create')).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
  h.script = async call => { assert.deepEqual((await call('processing_pending', {})).pending, []); };
  const closed = h.whenClosed(); body(await h.call('process_selected_captures', { collectionId: f.collection.id, requestId: randomUUID(), selection: selectedInput(f) }));
  await closed; assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
});

test('editing the native preview refuses Save and preserves the exact proposal for fresh review', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const before = await inspectProcessing(f.capability, f.operationId);
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next;
  h.answer(form, { action: 'accept', content: {
    changes: form.params.requestedSchema.properties.changes.default + '\nUser edit', decision: 'save'
  } });
  const refused = body(await review);
  assert.equal(refused.status, 'awaiting-review'); assert.equal(refused.review, 'display-altered');
  assert.equal(refused.nextAction, 'review'); assert.deepEqual(refused.diagnostics, []);
  assert.match(refused.statusText, /Nothing was saved, skipped or cancelled; draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) remains pending\./);
  const after = await inspectProcessing(f.capability, f.operationId);
  assert.equal(after.state, 'awaiting-review'); assert.equal(after.outcome, null);
  assert.equal(after.claimHash, before.claimHash); assert.equal(after.proposalHash, before.proposalHash);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const retry = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
  const fresh = await retry;
  assert.equal(fresh.params.requestedSchema.properties.changes.default, form.params.requestedSchema.properties.changes.default);
  h.answer(fresh, { action: 'accept', content: { decision: 'skip' } });
  assert.equal(body(await result).status, 'idle');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'skipped');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  assert(!JSON.stringify(h.responses.filter(row => row.method !== 'elicitation/create')).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
});

test('observed Claude review responses keep the exact draft pending with truthful outcomes', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const before = await inspectProcessing(f.capability, f.operationId);
  const review = async answer => {
    const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
    const form = await next; h.answer(form, answer(form)); return result;
  };
  // Claude CLI 2.1.294 and 2.1.299 initialize string defaults through a sanitizer
  // that replaces LF/CR/U+2028/U+2029 with U+FFFD; the person cannot read the
  // original multiline preview, then submits only a navigated decision.
  const sanitized = form => form.params.requestedSchema.properties.changes.default.replace(/[\n\r\u2028\u2029]/g, '\uFFFD');
  for (const [name, answer, outcome] of [
    // Claude Desktop 2.42304.0 advertises elicitation without a host handler;
    // its SDK returns this decline without displaying any form.
    ['Desktop decline', () => ({ action: 'decline' }), 'declined'],
    // Later applies nothing, so it needs no intact display.
    ['CLI Later', form => ({ action: 'accept', content: { changes: sanitized(form), decision: 'later' } }), 'deferred'],
    ['CLI Save', form => ({ action: 'accept', content: { changes: sanitized(form), decision: 'save' } }), 'display-altered'],
    ['CLI Skip', form => ({ action: 'accept', content: { changes: sanitized(form), decision: 'skip' } }), 'display-altered'],
  ]) {
    const row = await review(answer);
    assert.equal(row.error, undefined, name);
    const reported = body(row);
    assert.equal(reported.status, 'awaiting-review', name); assert.equal(reported.review, outcome, name);
    assert.equal(reported.nextAction, 'review', name); assert.deepEqual(reported.diagnostics, [], name);
    // Neither result claims a displayed form, a changed draft, or bare readiness.
    assert(!reported.statusText.includes('Draft ready'), name);
    assert(!JSON.stringify(row).includes('PREVIEW_CHANGED'), name);
    assert.match(reported.statusText, { declined: /may not have been displayed/, deferred: /deferred with Later/ }[outcome] ?? /may not have been readable/, name);
    const current = await inspectProcessing(f.capability, f.operationId);
    assert.equal(current.state, 'awaiting-review', name); assert.equal(current.outcome, null, name);
    assert.equal(current.claimHash, before.claimHash, name); assert.equal(current.proposalHash, before.proposalHash, name);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), [], name);
  }
  // The same pending draft still saves exactly when a host round-trips its display.
  const saved = body(await review(() => ({ action: 'accept', content: { decision: 'save' } })));
  assert.equal(saved.review, 'saved');
  assert.match(saved.statusText, /^Cuefluent: Review completed: the exact reviewed proposal of draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) was saved\./);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert(!JSON.stringify(h.responses.filter(row => row.method !== 'elicitation/create')).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
  assert.equal(h.dispatches, 1);
});

test('native review safely displays controls and accepts a CRLF echo while saving the exact draft bytes', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const target = path.join(f.collection.notes.notesDir, 'meetings/rollout.md');
  const original = '# Existing policy\n\n## Decision\n\nOld\u0000\u001b[2Kpolicy.\n';
  await fs.mkdir(path.dirname(target)); await fs.writeFile(target, original);
  const content = '# Synthetic policy\r\n\r\n## Decision\r\n\r\nKeep the rollout paused.\u001b[8mHidden\u001b[0m\r\n';
  await proposeInChat(f, h, content, digest(original));
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next, preview = form.params.requestedSchema.properties.changes.default;
  assert(!preview.includes('\u0000')); assert(!preview.includes('\u001b'));
  assert(preview.includes('Old\\u0000\\u001b[2Kpolicy.'));
  assert(preview.includes('\\u001b[8mHidden\\u001b[0m'));
  h.answer(form, { action: 'accept', content: { decision: 'save', changes: preview.replaceAll('\n', '\r\n') } });
  assert.equal(body(await review).status, 'idle');
  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
});

test('an oversized decoded form reply preserves the exact proposal and permits a new review', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const before = await inspectProcessing(f.capability, f.operationId);
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next;
  h.answer(form, { action: 'accept', content: { decision: 'save', changes: 'x'.repeat(256 * 1024 + 1) } });
  assert.equal(body(await review).review, 'display-altered');
  const after = await inspectProcessing(f.capability, f.operationId);
  assert.equal(after.claimHash, before.claimHash); assert.equal(after.proposalHash, before.proposalHash);
  assert.equal(after.state, 'awaiting-review'); assert.equal(after.outcome, null);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const retry = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
  h.answer(await retry, { action: 'accept', content: { decision: 'later' } });
  assert.equal(body(await result).status, 'awaiting-review');
});

test('formal review replay preserves its exact completed result without another host form or write', async t => {
  for (const decision of ['save', 'skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
    h.nativeSkill = true; h.callId = 'review_call';
    const args = { collectionId: f.collection.id }, next = h.nextForm(), review = h.call('processing_review', args);
    h.answer(await next, { action: 'accept', content: { decision } });
    const first = await review; assert.equal(first.error, undefined);
    const operation = await inspectProcessing(f.capability, f.operationId);
    const receiptFile = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest(h.callId).slice(0, 24)}.json`);
    const receipt = await fs.readFile(receiptFile);
    assert.deepEqual((await h.call('processing_review', args)).result, first.result);
    assert.equal(h.forms.length, 1); assert.equal(h.finishReviewCalls, 1);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), operation);
    assert.deepEqual(await fs.readFile(receiptFile), receipt);
    if (decision === 'save') assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
    else assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

test('review cancellation after host approval but before durable publication preserves the proposal and inputs', async t => {
  for (const decision of ['save', 'skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
    const before = await inspectProcessing(f.capability, f.operationId), entered = deferred(), gate = deferred();
    h.release = gate.resolve;
    const open = fs.open; let staged = false;
    t.mock.method(fs, 'open', async function(file, ...args) {
      if (!staged && typeof file === 'string' && path.basename(file).startsWith('.processing-') && args[0] === 'wx') {
        staged = true; entered.resolve(); await gate.promise;
      }
      return open.call(this, file, ...args);
    });
    const next = h.nextForm(); void h.call('processing_review', { collectionId: f.collection.id });
    h.answer(await next, { action: 'accept', content: { decision } });
    await entered.promise;
    h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await new Promise(resolve => setImmediate(resolve)); gate.resolve();
    await h.send({ jsonrpc: '2.0', id: 100, method: 'ping' });
    assert(!h.responses.some(row => row.id === 2)); assert.equal(h.finishReviewCalls ?? 0, 0);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), before);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    assert.deepEqual(await fs.readdir(path.join(f.collection.notes.writerStateDir, 'processing-stages')), []);
    const retryForm = h.nextForm(), retry = h.call('processing_review', { collectionId: f.collection.id });
    h.answer(await retryForm, { action: 'accept', content: { decision } });
    assert.equal((await retry).error, undefined);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome,
      { save: 'saved', skip: 'skipped', cancel: 'cancelled' }[decision]);
  });
});

test('review cancellation during durable publication preserves the committed result and replay', async t => {
  for (const decision of ['save', 'skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
    h.nativeSkill = true; h.callId = 'review_publication';
    const target = path.join(f.collection.notes.writerStateDir,
      decision === 'save' ? 'transactions' : 'processed/operations', `${f.operationId}.json`);
    const rename = fs.rename; let cancelled = false;
    t.mock.method(fs, 'rename', async function(from, to) {
      if (!cancelled && to === target) {
        cancelled = true;
        h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
        await new Promise(resolve => setImmediate(resolve));
      }
      return rename.call(this, from, to);
    });
    const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
    h.answer(await next, { action: 'accept', content: { decision } });
    const result = await review;
    assert.equal(cancelled, true); assert.equal(body(result).status, 'idle');
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome,
      { save: 'saved', skip: 'skipped', cancel: 'cancelled' }[decision]);
    if (decision === 'save') assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
    else assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    assert.deepEqual((await h.call('processing_review', { collectionId: f.collection.id })).result, result.result);
    assert.equal(h.finishReviewCalls, 1); assert.equal(h.forms.length, 1);
  });
});

test('committed source Save stays successful when the chat registry requires later reconciliation', async t => {
  const f = await processingFixture(t), h = await harness(t, f), first = await proposeInChat(f, h);
  h.finishReviewFailure = Object.assign(new Error('private registry detail'), { code: 'PROCESSING_CHAT_CONFLICT' });
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  h.answer(await next, { action: 'accept', content: { decision: 'save' } });
  const row = await review;
  assert.equal(row.error, undefined);
  const result = body(row);
  assert.equal(result.status, 'completed'); assert.equal(result.nextAction, 'inspect');
  assert.equal(result.statusDetail, 'completed');
  assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_CONFLICT']);
  // The visible reply keeps the saved outcome and still says to look further.
  assert.match(result.statusText, /^Cuefluent: Review completed: the exact reviewed proposal of draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) was saved\./);
  assert(result.statusText.endsWith('\nSomething needs attention; for details, type $cuefluent-notes status --verbose.'), result.statusText);
  assert.equal(result.requestId, first.requestId); assert.deepEqual(result.chat, first.chat);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.equal(body(await h.call('processing_status', { collectionId: f.collection.id })).status, 'idle');
  assert.equal(h.finishReviewCalls, 1); assert.equal(h.dispatches, 1);
  assert(!JSON.stringify(row).includes('private registry detail'));
});

test('committed source Save survives revoked receipt authorization without fabricating exclusion proof', async t => {
  const f = await processingFixture(t), h = await harness(t, f), first = await proposeInChat(f, h);
  const original = await fs.readFile(f.options.configPath), changed = JSON.parse(original);
  changed.routes[0].collection.enabled = false;
  h.nativeSkill = true;
  h.beforeFinishReview = () => fs.writeFile(f.options.configPath, JSON.stringify(changed));
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  h.answer(await next, { action: 'accept', content: { decision: 'save' } });
  const row = await review;
  assert.equal(row.error, undefined);
  const result = body(row);
  assert.equal(result.status, 'completed'); assert.equal(result.nextAction, 'inspect');
  assert.equal(result.statusDetail, 'completed');
  assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_CONFLICT']);
  // The visible reply keeps the saved outcome and still says to look further.
  assert.match(result.statusText, /^Cuefluent: Review completed: the exact reviewed proposal of draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) was saved\./);
  assert(result.statusText.endsWith('\nSomething needs attention; for details, type $cuefluent-notes status --verbose.'), result.statusText);
  assert.equal(result.requestId, first.requestId); assert.deepEqual(result.chat, first.chat);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  await assert.rejects(fs.lstat(path.join(f.collection.intakeStateDir, 'control-dispatch')), { code: 'ENOENT' });
  await fs.writeFile(f.options.configPath, original);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.equal(body(await h.call('processing_status', { collectionId: f.collection.id })).status, 'idle');
  assert.equal(h.finishReviewCalls, 1); assert.equal(h.dispatches, 1);
});

test('controller close failure after source Save preserves its committed outcome', async t => {
  const f = await processingFixture(t), h = await harness(t, f), first = await proposeInChat(f, h);
  h.closeFailure = Object.assign(new Error('private cleanup detail'), { code: 'PRIVATE_CLEANUP_ERROR' });
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  h.answer(await next, { action: 'accept', content: { decision: 'save' } });
  const row = await review;
  assert.equal(row.error, undefined);
  const result = body(row);
  assert.equal(result.status, 'completed'); assert.equal(result.nextAction, 'inspect');
  assert.equal(result.statusDetail, 'completed');
  assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_CONFLICT']);
  // The visible reply keeps the saved outcome and still says to look further.
  assert.match(result.statusText, /^Cuefluent: Review completed: the exact reviewed proposal of draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) was saved\./);
  assert(result.statusText.endsWith('\nSomething needs attention; for details, type $cuefluent-notes status --verbose.'), result.statusText);
  assert.equal(result.requestId, first.requestId); assert.deepEqual(result.chat, first.chat);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.equal(h.finishReviewCalls, 1); assert.equal(h.dispatches, 1);
  assert(!JSON.stringify(row).includes('private cleanup detail'));
});

test('exact proposal preview refuses stale hashes and oversized native review never truncates or opens a form', async t => {
  const f = await processingFixture(t), content = '# Bounded review\n\n## Knowledge\n\n' + 'Synthetic content.\n'.repeat(16000);
  const proposed = await proposedClaim(f, { content });
  const args = { ...f.args, expectedClaimHash: proposed.claimHash, expectedProposalHash: proposed.proposalHash };
  await assert.rejects(readProcessingProposal(f.capability, { ...args, expectedClaimHash: digest('stale claim') }), { code: 'PROCESSING_CLAIM_CHANGED' });
  await assert.rejects(readProcessingProposal(f.capability, { ...args, expectedProposalHash: digest('stale proposal') }), { code: 'PROCESSING_PROPOSAL_CHANGED' });
  const preview = await readProcessingProposal(f.capability, args);
  assert.equal(preview.files[0].proposed, content);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, proposed.claimHash);
  let elicited = false;
  await assert.rejects(reviewProcessingProposal(f.capability, f.args, { elicit: async () => { elicited = true; return { action: 'cancel' }; } }),
    { code: 'PROCESSING_REVIEW_LIMIT' });
  assert.equal(elicited, false);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('source review preserves exact pending proposal on Later, decline and closed form, then distinguishes skip from cancel', async t => {
  for (const decision of ['skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
    const pending = await inspectProcessing(f.capability, f.operationId);
    for (const [response, review] of [[{ action: 'accept', content: { decision: 'later' } }, 'deferred'],
      [{ action: 'decline' }, 'declined'], [{ action: 'cancel' }, 'declined']]) {
      const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
      h.answer(await next, response);
      const reported = body(await result);
      assert.equal(reported.status, 'awaiting-review'); assert.equal(reported.review, review);
      assert.equal((await inspectProcessing(f.capability, f.operationId)).proposalHash, pending.proposalHash);
    }
    const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
    h.answer(await next, { action: 'accept', content: { decision } });
    const completed = body(await result);
    assert.equal(completed.status, 'idle'); assert.equal(completed.review, decision === 'skip' ? 'skipped' : 'cancelled');
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, decision === 'skip' ? 'skipped' : 'cancelled');
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []); assert.equal(h.dispatches, 1);
  });
});

test('busy source review does not open a form or duplicate the processing session', async t => {
  const f = await processingFixture(t), h = await harness(t, f), gate = deferred(); h.release = gate.resolve;
  h.script = async () => gate.promise;
  await h.call('process_selected_captures', { collectionId: f.collection.id, requestId: randomUUID() });
  const status = body(await h.call('processing_review', { collectionId: f.collection.id }));
  assert.equal(status.status, 'busy'); assert.deepEqual(status.diagnostics, ['PROCESSING_CHAT_BUSY']);
  assert.equal(h.forms.length, 0); assert.equal(h.creates, 1); assert.equal(h.dispatches, 1); gate.resolve();
});

test('a settings change while native review is open cannot authorize the stale proposal', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next, original = await fs.readFile(f.options.configPath), config = JSON.parse(original);
  config.routes[0].collection.enabled = false;
  await fs.writeFile(f.options.configPath, JSON.stringify(config));
  h.answer(form, { action: 'accept', content: { decision: 'save' } });
  const refused = await result;
  assert(refused.error); assert(!JSON.stringify(refused).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  await fs.writeFile(f.options.configPath, original);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
});

// A selection that changed only by the exclusions of typed command turns.
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
  await fs.appendFile(parent.source.path, 'not a transcript record\n');
  await parent.work('Later turn.', { filler: ['x'.repeat(2.2 * 1024 * 1024)] });
  const rpc = await h.call('capture_turns', {});
  assert.equal(rpc.error.code, -32600, JSON.stringify(rpc));
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
    assert.match(reply.statusText, /^Cuefluent: Automatic capture has stopped for this chat, so its later turns are not captured/);
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

test('a paused chat keeps a reader stop that typed capture cannot pass, and passes one it can', async t => {
  const cases = {
    // Bytes that are no transcript record: typed capture would read them too.
    INVALID_SESSION_RECORD: [{ capture: 'stopped' }, async parent => {
      await fs.appendFile(parent.source.path, 'not a transcript record\n');
      await parent.work('Held behind the block.', { filler: ['x'.repeat(2.2 * 1024 * 1024)] });
    }],
    // A turn too large to anchor: typed capture leaves it out and goes on.
    SOURCE_ANCHOR_LIMIT: [{ capture: 'nothing-new', leftOut: 1 }, parent => parent.work('Long final answer.', { last: 'x'.repeat(70 * 1024) })],
  };
  for (const [code, [expected, block]] of Object.entries(cases)) await t.test(code, async t => {
    const { f, h, parent } = await nativeIngressFixture(t), identity = { client: 'codex', sessionId: f.identity.sessionId };
    const run = () => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
    await parent.work('Captured automatically.'); await run();
    await block(parent);
    assert((await run()).pending.includes(code));
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

async function completeNextBatch(call, f) {
  let claim = await prepareFromPending(call, f);
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page });
    claim = await call('processing_ack', { operationId: f.operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  await call('processing_complete', { operationId: f.operationId, expectedClaimHash: claim.claimHash });
}

test('process drafts across the collection in bounded batches using one reusable native session', async t => {
  const f = await processingFixture(t);
  for (let i = 0; i < 5; i++) await processingFixture(t, { base: f, client: i % 2 ? 'claude' : 'codex' });
  const before = await fs.readFile(f.options.configPath), h = await harness(t, f);
  h.script = call => completeNextBatch(call, f);
  const closed = h.whenClosed(), accepted = body(await h.call('process_selected_captures', {}));
  assert.equal(accepted.scope, 'collection'); assert.equal(accepted.statusDetail, 'accepted');
  await closed;
  const status = body(await h.call('processing_status', {}));
  assert.equal(status.progress.handled, 6); assert.equal(status.progress.unattempted, 0);
  assert.equal(status.inventory.pending, 0); assert.equal(status.inventory.sourceCompleteness, 'unknown');
  assert.equal(h.dispatches, 2); assert.equal(h.creates, 1); assert.equal(h.resumes, 1);
  const again = body(await h.call('process_selected_captures', {}));
  assert.equal(again.statusDetail, 'nothing-pending'); assert.equal(h.dispatches, 2);
  assert.deepEqual(await fs.readFile(f.options.configPath), before);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('resume without unfinished work reports a no-op and starts no native session', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const result = body(await h.call('processing_resume', {}));
  assert.equal(result.statusDetail, 'nothing-to-resume'); assert.equal(h.dispatches, 0); assert.equal(h.creates, 0);
  assert.equal(body(await h.call('processing_status', {})).inventory.pending, 1);
});

test('cancel waits for the owned native turn to end before releasing its exact claim', async t => {
  const f = await processingFixture(t), h = await harness(t, f), entered = deferred(), gate = deferred();
  h.release = gate.resolve; h.onInterrupt = gate.resolve;
  h.script = async call => { await prepareFromPending(call, f); entered.resolve(); await gate.promise; };
  body(await h.call('process_selected_captures', {})); await entered.promise;
  const before = await fs.readFile(f.options.configPath);
  const cancelled = body(await h.call('processing_cancel', {}));
  assert.equal(cancelled.statusDetail, 'cancelled'); assert.equal(h.interrupts, 1);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'cancelled');
  assert.equal(body(await h.call('processing_status', {})).inventory.pending, 1);
  assert.deepEqual(await fs.readFile(f.options.configPath), before);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  // Re-delivery of Cancel cannot affect a newer frozen processing selection.
  h.script = async call => call('processing_pending', {});
  const closed = h.whenClosed(); body(await h.call('process_selected_captures', {})); await closed;
  h.callId = 'call_2';
  assert.deepEqual(body(await h.call('processing_cancel', {})), cancelled);
  assert.equal(h.interrupts, 1);
});

test('review selects one exact collection proposal before presenting its contents', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f, client: 'claude' });
  await proposedClaim(f); await proposedClaim(b);
  const h = await harness(t, f), choose = h.nextForm(), review = h.call('processing_review', {});
  const selector = await choose;
  const choices = selector.params.requestedSchema.properties.operationId.oneOf;
  assert.equal(choices.length, 2); assert(choices.some(item => item.const === b.operationId));
  // The picker names each draft by its captured turns, never in internal words.
  for (const item of choices) assert.match(item.title, /^Draft [12]: \d+ captured turns?; /);
  assert.doesNotMatch(JSON.stringify(selector.params), /collect|captures/i);
  const preview = h.nextForm(); h.answer(selector, { action: 'accept', content: { operationId: b.operationId } });
  const form = await preview;
  assert(form.params.requestedSchema.properties.changes.default.includes((await inspectProcessing(b.capability, b.operationId)).proposalHash));
  h.answer(form, { action: 'accept', content: { decision: 'skip' } }); await review;
  assert.equal((await inspectProcessing(b.capability, b.operationId)).outcome, 'skipped');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  assert.equal(h.dispatches, 0); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('cancel from another controller refuses an unverified active owner and preserves its claim', async t => {
  const f = await processingFixture(t), owner = await harness(t, f), gate = deferred(), entered = deferred();
  owner.release = gate.resolve;
  owner.script = async call => { await prepareFromPending(call, f); entered.resolve(); await gate.promise; };
  body(await owner.call('process_selected_captures', {})); await entered.promise;
  const before = await inspectProcessing(f.capability, f.operationId), outsider = await harness(t, f);
  outsider.callId = 'cancel_from_other';
  const result = await outsider.call('processing_cancel', {});
  assert.equal(result.error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, before.claimHash);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, null);
  assert.equal(outsider.dispatches, 0); gate.resolve();
});

test('status in another native host reports the existing collection run instead of a second idle processor', async t => {
  const f = await processingFixture(t), owner = await harness(t, f), gate = deferred();
  owner.release = gate.resolve; owner.script = async () => gate.promise;
  const accepted = body(await owner.call('process_selected_captures', {}));
  const other = await harness(t, f, { controllerIdentity: { hostId: digest('other-synthetic-host') } });
  other.callId = 'status_from_other';
  const status = body(await other.call('processing_status', {}));
  assert.equal(status.status, 'busy'); assert.equal(status.statusDetail, 'processing');
  assert.deepEqual(status.chat, accepted.chat); assert.equal(status.requestId, accepted.requestId);
  assert(status.diagnostics.includes('PROCESSING_COLLECTION_BUSY'));
  assert.equal(other.dispatches, 0); gate.resolve();
});


test('shortcut process and cancel preserve standalone claims and drafts without verified native ownership', async t => {
  for (const proposed of [false, true]) await t.test(proposed ? 'draft' : 'claim', async t => {
    const f = await processingFixture(t);
    const { prepareProcessing } = await import('./processing.mjs');
    const claim = proposed ? await proposedClaim(f) : await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
    const h = await harness(t, f);
    const process = body(await h.call('process_selected_captures', { collectionId: f.collection.id }));
    assert.equal(process.nextAction, proposed ? 'review' : 'inspect');
    if (!proposed) assert.deepEqual(process.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    const cancelled = await h.call('processing_cancel', { collectionId: f.collection.id });
    assert.equal(cancelled.error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
    assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
    assert.equal(h.dispatches, 0); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

test('MCP resume and cancel preserve a standalone claim in the shortcut workset', async t => {
  const f = await processingFixture(t);
  const { selectProcessingShortcut, inspectProcessingShortcut } = await import('./processing-shortcuts.mjs');
  const { prepareWorksetBatch } = await import('./processing-workset.mjs');
  const chosen = await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID() });
  const workset = chosen.worksets[0];
  const claim = await prepareWorksetBatch(f.capability, { worksetId: workset.worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  const h = await harness(t, f);
  const resumed = body(await h.call('processing_resume', { collectionId: f.collection.id }));
  assert.deepEqual(resumed.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
  assert.equal(resumed.nextAction, 'inspect');
  const cancelled = await h.call('processing_cancel', { collectionId: f.collection.id });
  assert.equal(cancelled.error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
  assert.equal((await inspectProcessing(f.capability, claim.operationId)).claimHash, claim.claimHash);
  assert.equal((await inspectProcessingShortcut(f.capability, { selection: f.selection })).checkpointHash, chosen.checkpointHash);
  assert.equal(h.dispatches, 0); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('routine intake contention does not block read-only inventory or review discovery', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const lock = path.join(f.collection.intakeStateDir, '.intake-lock'); await fs.mkdir(lock, { mode: 0o700 });
  try {
    const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
    assert.equal(status.statusDetail, 'pending'); assert.equal(status.nextAction, 'process');
    assert.deepEqual(status.diagnostics, []);
    const review = body(await h.call('processing_review', { collectionId: f.collection.id }));
    assert.equal(review.statusDetail, 'pending'); assert.equal(h.forms.length, 0);
    assert.equal((await h.call('process_selected_captures', {})).error.data.code, 'INTAKE_BLOCKED');
  } finally { await fs.rmdir(lock); }
});

test('MCP review offers a healthy replacement while another retained draft lacks its source selection', async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  const other = await processingFixture(t, { base: f });
  await proposedClaim(other, { name: 'meetings/second.md' });
  await replaceProcessingStorage(f.collection.intakeStateDir);
  f.capability = await verifyWorkflowStorage(f.options);
  f.store = await openWorkflowIntake(f.capability, f.selection, 'collect');
  const { previewProcessingReinspection, reinspectProcessing, readProcessingPage, acknowledgeProcessingPages, proposeProcessing } = await import('./processing.mjs');
  const request = { ...f.args, replacementOperationId: randomUUID(), expectedClaimHash: proposal.claimHash, expectedProposalHash: proposal.proposalHash };
  const preview = await previewProcessingReinspection(f.capability, request);
  const transfer = await reinspectProcessing(f.capability, { ...request, expectedPreviewHash: preview.previewHash });
  const args = { selection: f.selection, operationId: transfer.replacementOperationId };
  let claim = (await inspectProcessing(f.capability, args.operationId)).claim;
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await readProcessingPage(f.capability, { ...args, expectedClaimHash: claim.claimHash, page });
    claim = await acknowledgeProcessingPages(f.capability, { ...args, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  await proposeProcessing(f.capability, { ...args, expectedClaimHash: claim.claimHash, proposal: transfer.proposal });
  await fs.unlink(path.join(f.collection.intakeStateDir, 'sessions', other.identity.client, `${other.identity.sessionId}.json`));
  const h = await harness(t, f);
  const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(status.status, 'awaiting-review'); assert.equal(status.nextAction, 'review');
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next;
  assert(form.params.requestedSchema.properties.changes.default.includes('Keep the rollout paused.'));
  h.answer(form, { action: 'accept', content: { decision: 'save' } });
  body(await review);
  assert.equal((await inspectProcessing(f.capability, args.operationId)).outcome, 'saved');
  assert.equal((await inspectProcessing(f.capability, other.operationId)).state, 'conflicted');
});

test('status preserves execution with explicit incomplete inventory after bounded concurrent-change retries', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const pending = path.join(f.collection.intakeStateDir, 'pending.json');
  const head = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const open = fs.open.bind(fs); let reads = 0;
  const mock = t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === head && ++reads % 2 === 1) await fs.writeFile(pending, reads < 3 ? '{}' : 'null', { mode: 0o600 });
    return open(file, ...args);
  });
  try {
    const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
    assert(status.diagnostics.includes('PROCESSING_INVENTORY_INCOMPLETE'));
    assert.equal(status.inventory, undefined); assert.equal(h.dispatches, 0);
  } finally { mock.mock.restore(); await fs.rm(pending, { force: true }); }
});

test('completed selection status suggests process when fresh retained evidence is available', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = call => completeNextBatch(call, f);
  const closed = h.whenClosed(); await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  await processingFixture(t, { base: f, client: 'claude' });
  const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(status.nextAction, 'process'); assert.equal(status.inventory.pending, 1); assert.equal(h.dispatches, 1);
});

test('committed capture admission still dispatches if secondary control publication fails', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true;
  const rename = fs.rename.bind(fs); let injected = false;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to).includes(`${path.sep}shortcut-controls${path.sep}`)) {
      const value = JSON.parse(await fs.readFile(from));
      if (value.response && !injected) { injected = true; throw Object.assign(new Error('synthetic publication failure'), { code: 'EIO' }); }
    }
    return rename(from, to);
  });
  const closed = h.whenClosed();
  try {
    const response = await h.call('process_selected_captures', { collectionId: f.collection.id });
    assert.equal(response.error.data.code, 'PROCESSING_CONTROL_FAILED'); await closed;
    assert.equal(injected, true); assert.equal(h.dispatches, 1);
    mock.mock.restore(); h.callId = 'call_1';
    assert.equal(body(await h.call('process_selected_captures', { collectionId: f.collection.id })).statusDetail, 'accepted');
    assert.equal(h.dispatches, 1);
  } finally { mock.mock.restore(); }
});

test('cancellation at durable shortcut response publication cannot revoke committed admission', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const rename = fs.rename.bind(fs); let injected = false;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to).includes(`${path.sep}shortcut-controls${path.sep}`)) {
      const value = JSON.parse(await fs.readFile(from));
      if (value.response && !injected) {
        injected = true; h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    return rename(from, to);
  });
  const closed = h.whenClosed();
  try {
    const response = body(await h.call('process_selected_captures', { collectionId: f.collection.id }));
    await closed; assert.equal(injected, true); assert.equal(response.statusDetail, 'accepted'); assert.equal(h.dispatches, 1);
    mock.mock.restore(); h.callId = 'call_1';
    assert.deepEqual(body(await h.call('process_selected_captures', { collectionId: f.collection.id })), response);
  } finally { mock.mock.restore(); }
});


test('native history capacity is explicit before another shortcut turn can dispatch', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = call => completeNextBatch(call, f);
  const closed = h.whenClosed(); await h.call('process_selected_captures', {}); await closed;
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const file = path.join(directory, (await fs.readdir(directory))[0]);
  const value = JSON.parse(await fs.readFile(file));
  value.runs = Array.from({ length: 128 }, (_, index) => {
    const run = structuredClone(value.runs[0]);
    run.request.requestId = randomUUID(); run.request.inputHash = digest(`synthetic history ${index}`);
    run.native.runId = randomUUID(); run.native.inputId = randomUUID(); run.native.unitIds = [randomUUID()];
    return run;
  });
  await fs.writeFile(file, canonicalJSON(value) + '\n');
  await processingFixture(t, { base: f });
  const result = body(await h.call('process_selected_captures', {}));
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_HISTORY_FULL']);
  assert.equal(h.dispatches, 1);
  const status = body(await h.call('processing_status', {}));
  assert.deepEqual(status.diagnostics, ['PROCESSING_CHAT_HISTORY_FULL']); assert.equal(status.nextAction, 'inspect');
});

test('owned cancel tolerates operation-pin revision changes without targeting a different request', async t => {
  const f = await processingFixture(t), h = await harness(t, f), entered = deferred(), gate = deferred();
  h.release = gate.resolve; h.onInterrupt = gate.resolve;
  h.script = async call => { h.callEngine = call; entered.resolve(); await gate.promise; };
  await h.call('process_selected_captures', {}); await entered.promise;
  h.beforeStop = () => prepareFromPending(h.callEngine, f);
  const result = body(await h.call('processing_cancel', {}));
  assert.equal(result.statusDetail, 'cancelled'); assert.equal(h.interrupts, 1);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'cancelled');
});


test('unavailable frozen inputs offer safe cancellation instead of an endless inspect instruction', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const closed = h.whenClosed(); await h.call('process_selected_captures', {}); await closed;
  const head = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const bytes = await fs.readFile(head); await fs.unlink(head);
  const status = body(await h.call('processing_status', {}));
  assert.equal(status.nextAction, 'cancel'); assert.equal(status.progress.unavailable, 1);
  assert.equal(body(await h.call('processing_cancel', {})).statusDetail, 'cancelled');
  await fs.writeFile(head, bytes, { mode: 0o600 });
  const freshClosed = h.whenClosed();
  assert.equal(body(await h.call('process_selected_captures', {})).statusDetail, 'accepted'); await freshClosed;
  assert.equal(h.dispatches, 2);
});

test('the engine enforces the draft-selector limit even for claims prepared before the queue fills', async t => {
  const { inspectedClaim } = await import('./test-support/processing-fixture.mjs');
  const f = await processingFixture(t), fixtures = [f];
  for (let i = 1; i < 6; i++) fixtures.push(await processingFixture(t, { base: f }));
  const claims = [];
  for (let i = 0; i < 5; i++) claims.push(await inspectedClaim(fixtures[i], { parallelism: 5 }));
  for (let i = 0; i < 4; i++) await proposedClaim(fixtures[i], { claim: claims[i], name: `meetings/synthetic-${i}.md` });
  claims.push(await inspectedClaim(fixtures[5], { parallelism: 5 }));
  await proposedClaim(fixtures[4], { claim: claims[4], name: 'meetings/synthetic-4.md' });
  await assert.rejects(proposedClaim(fixtures[5], { claim: claims[5], name: 'meetings/synthetic-5.md' }), { code: 'PROCESSING_PROPOSAL_QUEUE_FULL' });
  const h = await harness(t, f), ready = h.nextForm(), result = h.call('processing_review', {}), selector = await ready;
  const choices = selector.params.requestedSchema.properties.operationId.oneOf;
  assert.equal(choices.length, 5); assert(!choices.some(item => item.const === fixtures[5].operationId));
  h.answer(selector, { action: 'cancel' });
  const dismissed = body(await result); assert.equal(dismissed.status, 'awaiting-review'); assert.equal(dismissed.review, 'declined');
  assert.equal(h.dispatches, 0); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('an unauthorized draft stays intact while an authorized draft can be reviewed', async t => {
  const f = await processingFixture(t);
  const project = path.join(f.project, 'restricted'); await fs.mkdir(project);
  const b = await processingFixture(t, { base: { ...f, project } });
  const allowed = await proposedClaim(f), denied = await proposedClaim(b);
  // The retained source registration now points outside authorized projects;
  // the immutable draft still belongs to its original inspected input.
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const sourceFile = path.join(f.collection.intakeStateDir, 'sessions', b.identity.client, `${b.identity.sessionId}.json`);
  const source = JSON.parse(await fs.readFile(sourceFile)); source.source.projectRoot = outside;
  await fs.writeFile(sourceFile, canonicalJSON(source) + '\n');
  assert.equal((await inspectProcessing(f.capability, b.operationId)).state, 'awaiting-review');
  const h = await harness(t, f), status = body(await h.call('processing_status', {}));
  assert.equal(status.nextAction, 'review'); assert.equal(status.inventory.awaitingReview, 1);
  const ready = h.nextForm(), result = h.call('processing_review', {}), preview = await ready;
  assert(preview.params.requestedSchema.properties.changes.default.includes(allowed.proposalHash));
  h.answer(preview, { action: 'accept', content: { decision: 'later' } }); body(await result);
  assert.equal((await inspectProcessing(f.capability, b.operationId)).claimHash, denied.claimHash);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, allowed.claimHash);
});

test('review acknowledges its own completed draft after another host applied the outcome', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  await proposeInChat(f, h);
  await reviewProcessingProposal(f.capability, { selection: f.selection, operationId: f.operationId }, { elicit: async () => ({ action: 'accept', content: { decision: 'skip' }, preview: 'intact' }) });
  const status = body(await h.call('processing_status', {}));
  assert.notEqual(status.status, 'awaiting-review'); assert.equal(h.finishReviewCalls ?? 0, 0, 'status remains read-only');
  const reviewed = body(await h.call('processing_review', {}));
  assert.notEqual(reviewed.status, 'awaiting-review'); assert.equal(h.finishReviewCalls, 1); assert.equal(h.forms.length, 0);
  const again = body(await h.call('processing_status', {})); assert.notEqual(again.status, 'awaiting-review');
});

test('status distinguishes selection conflicts, mixed policy conflicts and genuine recovery', async () => {
  const { processingStatusView } = await import('./processing-mcp.mjs');
  const native = { state: 'idle', requestId: null, chat: null }, shortcut = { phase: 'ready', counts: { selected: 1 }, reviews: [] };
  for (const code of ['PROCESSING_REINSPECTION_REQUIRED', 'PROCESSING_OPERATION_CONFLICT']) {
    const blocked = processingStatusView({ ...native, state: 'blocked', diagnostics: [code] }, shortcut);
    assert.equal(blocked.status, 'blocked'); assert.equal(blocked.nextAction, 'inspect');
    assert.deepEqual(blocked.diagnostics, [code]);
  }
  for (const blockers of [['PROCESSING_INPUT_CHANGED'], ['PROCESSING_INPUT_ALREADY_HANDLED'], ['WORKFLOW_POLICY_CHANGED', 'PROCESSING_HEAD_CHANGED']]) {
    const status = processingStatusView(native, { ...shortcut, blockers });
    assert.equal(status.nextAction, 'cancel'); assert(!status.diagnostics.includes('PROCESSING_RECOVERY_REQUIRED'));
  }
  const recovery = processingStatusView(native, { ...shortcut, blockers: ['PROCESSING_INPUT_CHANGED', 'WRITER_RECOVERY_REQUIRED'] });
  assert.equal(recovery.nextAction, 'inspect'); assert.deepEqual(recovery.diagnostics, ['PROCESSING_RECOVERY_REQUIRED']);
});

test('cancel drains a checkpoint transition before pinning its target and cannot cancel a later request on replay', async t => {
  const { selectProcessingShortcut } = await import('./processing-shortcuts.mjs');
  const f = await processingFixture(t);
  await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID() });
  const h = await harness(t, f), entered = deferred(), release = deferred(); h.release = release.resolve;
  h.script = call => completeNextBatch(call, f);
  const rename = fs.rename.bind(fs); let transition = false, arriving;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to).includes(`${path.sep}processed${path.sep}shortcuts${path.sep}`)) {
      const value = JSON.parse(await fs.readFile(from));
      if (value.phase === 'discovering' && !transition) { transition = true; entered.resolve(); await release.promise; }
    }
    return rename(from, to);
  });
  const closed = h.whenClosed();
  // The pre-existing selection completes, then this process request starts its
  // fresh bounded selection. Hold that publication while Cancel arrives.
  await h.call('process_selected_captures', {}); await entered.promise;
  arriving = h.call('processing_cancel', {});
  await new Promise(resolve => setTimeout(resolve, 30)); release.resolve();
  const cancelled = body(await arriving); await closed; mock.mock.restore();
  assert(transition); assert.equal(cancelled.statusDetail, 'cancelled'); assert.equal(h.dispatches, 1);
  await processingFixture(t, { base: f });
  h.script = async call => call('processing_pending', {});
  const nextClosed = h.whenClosed(); await h.call('process_selected_captures', {}); await nextClosed;
  h.callId = 'call_2'; assert.deepEqual(body(await h.call('processing_cancel', {})), cancelled);
  assert.equal(h.dispatches, 2);
});

for (const failure of ['abandoned', 'not-dispatched']) for (const tool of ['processing_resume', 'process_selected_captures']) {
  test(`MCP ${tool} restarts ${failure} execution without replacing its frozen workset`, async t => {
    const f = await processingFixture(t), h = await harness(t, f);
    h.callId = 'original-call';
    if (failure === 'not-dispatched') h.createError = Object.assign(new Error('synthetic unavailable client'), {
      code: 'PROCESSING_CLIENT_UNAVAILABLE', outcome: 'not-dispatched' });
    else h.script = async () => { throw new Error('synthetic lost terminal'); };
    const failedClosed = h.whenClosed();
    await h.call('process_selected_captures', { collectionId: f.collection.id });
    await failedClosed;
    const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
      env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
    });
    t.after(() => controller.close());
    let before = await controller.status();
    assert.equal(before.state, failure === 'abandoned' ? 'blocked' : 'idle');
    const retiredSession = before.chat?.sessionId;
    if (failure === 'abandoned') before = await controller.abandon({
      expectedChatHash: before.chatHash, requestId: before.requestId, offline: true });
    before = await controller.status();
    assert.equal(before.restartSupported, true);
    assert.equal(before.chat, null); assert.equal(before.requestId, null);
    if (failure === 'abandoned') {
      await h.call('process_selected_captures', { collectionId: f.collection.id });
      assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
      assert.equal((await controller.status()).chatHash, before.chatHash);
    }
    const frozen = (await inspectProcessingShortcut(f.capability, { selection: f.selection })).worksets[0];
    assert.equal(frozen.inputCounts.unattempted, 1);
    h.callId = 'retired-status';
    const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
    assert.equal(status.status, 'idle'); assert.equal(status.nextAction, 'resume');
    assert(!status.diagnostics.includes('PROCESSING_CHAT_OUTCOME_UNKNOWN'));
    assert(!status.diagnostics.includes('PROCESSING_CLIENT_UNAVAILABLE'));
    const dispatches = h.dispatches;
    h.createError = null; h.script = async call => call('processing_pending', {});
    h.callId = 'fresh-call';
    const retryClosed = h.whenClosed();
    const admitted = body(await h.call(tool, { collectionId: f.collection.id }));
    assert.equal(admitted.statusDetail, 'accepted');
    await retryClosed;
    const after = await controller.status();
    assert.equal(after.state, 'idle'); assert.equal(after.restartSupported, false);
    assert.equal(h.creates, 2); assert.equal(h.resumes, 0); assert.equal(h.dispatches, dispatches + 1);
    assert.notEqual(after.chat.sessionId, retiredSession);
    assert.equal(after.worksetId, frozen.worksetId);
    assert.equal(after.workset.worksetHash, frozen.worksetHash);
    assert.deepEqual(after.workset.inputs, frozen.inputs);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    // Exact native call replay must not dispatch again after successful retry.
    await h.call(tool, { collectionId: f.collection.id });
    assert.equal(h.dispatches, dispatches + 1);
  });
}

for (const phase of ['creation', 'dispatch']) test(`MCP refuses unknown ${phase} outcome without labelling it busy`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  if (phase === 'creation') h.createError = Object.assign(new Error('synthetic lost creation'), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
  else h.script = async () => { throw new Error('synthetic lost terminal'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  const creates = h.creates, dispatches = h.dispatches;
  for (const tool of ['processing_resume', 'process_selected_captures']) {
    const result = body(await h.call(tool, { collectionId: f.collection.id }));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_OUTCOME_UNKNOWN']);
    assert.equal(h.creates, creates); assert.equal(h.dispatches, dispatches);
  }
});

for (const foreign of [false, true]) test(`MCP retired unpinned workset preserves ${foreign ? 'foreign' : 'own'} reservation diagnostics`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', {}); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  assert.equal(retired.operationId, null); assert(retired.worksetId);
  const frozen = (await inspectProcessingShortcut(f.capability, { selection: f.selection })).worksets[0];
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const registry = path.join(directory, (await fs.readdir(directory))[0]), stored = await fs.readFile(registry);
  const reservation = path.join(f.collection.notes.writerStateDir, 'reinspection.json');
  const bytes = foreign ? canonicalJSON({ preview: { binding: { collectionId: 'other' } } }) + '\n' : '{}\n';
  await fs.writeFile(reservation, bytes, { mode: 0o600 });
  const code = foreign ? 'PROCESSING_RECOVERY_REQUIRED' : 'PROCESSING_REINSPECTION_REQUIRED';
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const result = body(await h.call(tool, {}));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert.deepEqual(result.diagnostics, [code]);
    assert.equal(result.chat, null); assert.equal(result.requestId, null);
    assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
    assert.deepEqual(await fs.readFile(registry), stored);
    assert.equal(await fs.readFile(reservation, 'utf8'), bytes);
  }
  await fs.unlink(reservation);
  const clear = body(await h.call('processing_status', {}));
  assert.equal(clear.status, 'idle'); assert.equal(clear.nextAction, 'resume');
  assert.deepEqual(clear.diagnostics, []);
  const after = (await inspectProcessingShortcut(f.capability, { selection: f.selection })).worksets[0];
  assert.equal(after.worksetHash, frozen.worksetHash); assert.deepEqual(after.inputs, frozen.inputs);
  assert.deepEqual(await fs.readFile(registry), stored);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

for (const beforePin of [false, true]) test(`MCP retired execution exposes the ${beforePin ? 'unpinned' : 'pinned'} claim blocker without relaunch or claim changes`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  let pinFailed = false;
  h.script = async call => {
    if (beforePin) {
      const rename = fs.rename;
      const mock = t.mock.method(fs, 'rename', async (from, to) => {
        if (path.dirname(to) === path.join(f.collection.intakeStateDir, 'processing-chats')) {
          const next = JSON.parse(await fs.readFile(from, 'utf8'));
          if (next.state === 'busy' && next.active.operationId === f.operationId) {
            pinFailed = true; mock.mock.restore();
            throw Object.assign(new Error('synthetic controller loss before operation pin'), { code: 'EIO' });
          }
        }
        return rename(from, to);
      });
    }
    await prepareFromPending(call, f); throw new Error('synthetic lost terminal after claim');
  };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  assert.equal(pinFailed, beforePin);
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const claim = await inspectProcessing(f.capability, f.operationId);
  for (const tool of ['processing_status', 'processing_review', 'processing_resume', 'process_selected_captures']) {
    const result = body(await h.call(tool, { collectionId: f.collection.id }));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert.deepEqual(result.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
    assert.equal((await controller.status()).chatHash, retired.chatHash);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  }
  assert.equal((await h.call('processing_cancel', {})).error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.equal(h.forms.length, 0); assert.equal(h.dispatches, 1);
  const peer = await harness(t, f, { controllerIdentity: { hostId: digest('synthetic-peer-host') } });
  peer.callId = 'distinct-peer-call';
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const result = body(await peer.call(tool, { collectionId: f.collection.id }));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert(result.diagnostics.includes('PROCESSING_COLLECTION_BUSY'));
    assert.equal(peer.creates, 0); assert.equal(peer.dispatches, 0);
    assert.equal((await controller.status()).chatHash, retired.chatHash);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  }
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});


for (const damage of ['missing', 'corrupt']) test(`MCP reports a blocked retired peer with ${damage} workset metadata without leaking its inspection error`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
  // A standalone workset is independent of the collection shortcut checkpoint.
  const worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  const controller = await h.openController({ ...f.options, client: 'codex' });
  t.after(() => controller.close());
  await assert.rejects(controller.run({ requestId: randomUUID(), selection: f.selection, worksetId, expectedChatHash: null }));
  const failed = await controller.status();
  await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const registry = path.join(directory, (await fs.readdir(directory))[0]), stored = await fs.readFile(registry);
  const workset = path.join(f.collection.notes.writerStateDir, 'processed', 'worksets', `${failed.worksetId}.json`);
  const original = await fs.readFile(workset);
  if (damage === 'missing') await fs.unlink(workset);
  else await fs.writeFile(workset, 'null\n');
  const peer = await harness(t, f, { controllerIdentity: { hostId: digest('synthetic-peer-host') } });
  peer.callId = 'distinct-peer-call';
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const result = body(await peer.call(tool, {}));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert.deepEqual(result.diagnostics, ['PROCESSING_COLLECTION_BUSY']);
  }
  assert.equal((await peer.call('processing_cancel', {})).error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
  assert.equal(peer.creates, 0); assert.equal(peer.dispatches, 0); assert.equal(peer.forms.length, 0);
  assert.deepEqual(await fs.readFile(registry), stored);
  if (damage === 'missing') await assert.rejects(fs.readFile(workset), { code: 'ENOENT' });
  else assert.equal(await fs.readFile(workset, 'utf8'), 'null\n');
  // Repairing only the synthetic metadata must be observed on the next call.
  await fs.writeFile(workset, original, { mode: 0o600 });
  const healthy = body(await peer.call('processing_status', {}));
  assert.notEqual(healthy.status, 'blocked'); assert.deepEqual(healthy.diagnostics, []);
  assert.deepEqual(await fs.readFile(registry), stored);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

for (const failure of ['abandoned', 'not-dispatched']) test(`MCP review and cancel of ${failure} workset have no retired identifiers or errors`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  if (failure === 'not-dispatched') h.createError = Object.assign(new Error('synthetic unavailable client'), {
    code: 'PROCESSING_CLIENT_UNAVAILABLE', outcome: 'not-dispatched' });
  else h.script = async () => { throw new Error('synthetic lost terminal'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', {}); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  if (failure === 'abandoned') await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const retired = await controller.status();
  const before = await inspectProcessingShortcut(f.capability, { selection: f.selection });
  for (const tool of ['processing_status', 'processing_review', 'processing_cancel', 'processing_status', 'processing_review']) {
    const result = body(await h.call(tool, {}));
    assert.equal(result.status, 'idle'); assert.deepEqual(result.diagnostics, []);
    assert.equal(result.chat, null); assert.equal(result.requestId, null);
    if (tool === 'processing_cancel') assert.equal(result.statusDetail, 'cancelled');
  }
  const after = await inspectProcessingShortcut(f.capability, { selection: f.selection });
  assert.equal(after.phase, 'cancelled');
  assert.deepEqual(after.worksets, before.worksets);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.equal(h.forms.length, 0); assert.equal(h.creates, 1);
  assert.equal(h.dispatches, failure === 'abandoned' ? 1 : 0);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('MCP retired peer proposal offers review while blocking new execution and preserves later conflicts', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => { await proposeThroughTools(f)(call); throw new Error('synthetic lost terminal after proposal'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', {}); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const claim = await inspectProcessing(f.capability, f.operationId);
  const peer = await harness(t, f, { controllerIdentity: { hostId: digest('synthetic-peer-host') } });
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const status = body(await peer.call(tool, {}));
    assert.equal(status.status, 'awaiting-review'); assert.equal(status.nextAction, 'review');
    assert.equal(status.chat, null); assert.equal(status.requestId, null);
  }
  const ready = peer.nextForm(), review = peer.call('processing_review', {}), form = await ready;
  assert(form.params.requestedSchema.properties.changes.default.includes(claim.proposalHash));
  peer.answer(form, { action: 'accept', content: { decision: 'later' } });
  assert.equal(body(await review).status, 'awaiting-review');
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  const file = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const headBytes = await fs.readFile(file), head = JSON.parse(headBytes);
  await fs.writeFile(file, canonicalJSON({ ...head, generation: head.generation + 1, previousHash: digest(headBytes) }) + '\n');
  const conflict = body(await peer.call('processing_status', {}));
  assert.equal(conflict.status, 'blocked'); assert.equal(conflict.nextAction, 'inspect');
  await completeProcessing(f.capability, { selection: f.selection, operationId: f.operationId, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
  const settledPeer = await peer.openController({ ...f.options, client: 'codex' });
  try { assert.deepEqual(await settledPeer.collectionActivity(), []); }
  finally { await settledPeer.close(); }
  // Disposing the claim does not refresh the frozen checkpoint's old input.
  const frozen = body(await peer.call('processing_status', {}));
  assert.equal(frozen.status, 'blocked'); assert.equal(frozen.nextAction, 'cancel');
  assert.deepEqual(frozen.diagnostics, ['PROCESSING_SELECTION_CHANGED']);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.equal(peer.creates, 0); assert.equal(peer.dispatches, 0); assert.equal(h.dispatches, 1);
  assert.equal(peer.finishReviewCalls ?? 0, 0);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

for (const completion of ['save', 'external']) test(`MCP retired proposal supports Later then ${completion} completion without native review acknowledgement`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => { await proposeThroughTools(f)(call); throw new Error('synthetic lost terminal after proposal'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', {}); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const claim = await inspectProcessing(f.capability, f.operationId);
  const status = body(await h.call('processing_status', {}));
  assert.equal(status.status, 'awaiting-review'); assert.equal(status.nextAction, 'review');
  assert.deepEqual(status.diagnostics, []); assert.equal(status.chat, null); assert.equal(status.requestId, null);
  const next = h.nextForm(), review = h.call('processing_review', {});
  const form = await next;
  assert(form.params.requestedSchema.properties.changes.default.includes(claim.proposalHash));
  h.answer(form, { action: 'accept', content: { decision: 'later' } });
  const result = body(await review);
  assert.equal(result.status, 'awaiting-review'); assert.deepEqual(result.diagnostics, []);
  assert.equal(result.chat, null); assert.equal(result.requestId, null);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal(h.dispatches, 1); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  if (completion === 'save') {
    const ready = h.nextForm(), save = h.call('processing_review', {});
    h.answer(await ready, { action: 'accept', content: { decision: 'save' } });
    const saved = body(await save);
    assert.equal(saved.status, 'idle'); assert.equal(saved.nextAction, 'none'); assert.deepEqual(saved.diagnostics, []);
    assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  } else {
    // The engine can finish after native status inspection, before the MCP
    // layer checks completion. A retired row has no terminal review to ack.
    h.inspectOperation = async operationId => {
      const operation = await inspectProcessing(f.capability, operationId);
      h.inspectOperation = null;
      await reviewProcessingProposal(f.capability, { selection: f.selection, operationId },
        { elicit: async () => ({ action: 'accept', content: { decision: 'skip' }, preview: 'intact' }) });
      return operation;
    };
    const completed = body(await h.call('processing_status', {}));
    assert.equal(completed.status, 'idle'); assert.equal(completed.nextAction, 'none');
    assert.deepEqual(completed.diagnostics, []);
    assert.equal(body(await h.call('processing_review', {})).status, 'idle');
  }
  assert.equal(h.finishReviewCalls ?? 0, 0);
  assert.equal((await controller.status()).state, 'idle');
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.equal(h.dispatches, 1);
});

for (const retainedClaim of [false, true]) test(`MCP retired binding ${retainedClaim ? 'with terminal-owned claim' : 'without claim'} reports a competing active namespace without relaunch`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  if (retainedClaim) {
    h.script = async call => prepareFromPending(call, f);
    const firstClosed = h.whenClosed();
    await h.call('process_selected_captures', {}); await firstClosed;
  }
  h.script = async call => {
    if (retainedClaim) {
      const claim = await call('processing_status', { operationId: f.operationId });
      await call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page: 0 });
    }
    throw new Error('synthetic lost terminal');
  };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  assert.equal(retired.state, 'idle');
  const claim = await inspectProcessing(f.capability, f.operationId), dispatches = h.dispatches;
  if (retainedClaim) {
    assert.equal(retired.operationId, f.operationId);
    assert.equal(await controller.canResumeOperation(f.operationId), true);
  }
  const peer = await harness(t, f, { controllerIdentity: { hostId: digest('synthetic-peer-host') } });
  const gate = deferred(); peer.release = gate.resolve; peer.script = async () => gate.promise;
  peer.callId = 'distinct-peer-call';
  const peerClosed = peer.whenClosed();
  const admitted = body(await peer.call('process_selected_captures', { collectionId: f.collection.id }));
  assert.equal(admitted.statusDetail, 'accepted');
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const result = body(await h.call(tool, { collectionId: f.collection.id }));
    assert.equal(result.status, 'busy'); assert.equal(result.nextAction, 'wait');
    assert(result.diagnostics.includes('PROCESSING_COLLECTION_BUSY'));
    assert.equal(result.chat.sessionId, admitted.chat.sessionId);
    assert.equal(h.creates, 1); assert.equal(h.dispatches, dispatches);
    assert.equal((await controller.status()).chatHash, retired.chatHash);
  }
  assert.equal(await controller.canResumeOperation(f.operationId), false);
  await assert.rejects(controller.run({ requestId: randomUUID(), selection: f.selection,
    expectedChatHash: retired.chatHash, ...(retainedClaim ? { resumeOperationId: f.operationId } : {}) }), { code: 'PROCESSING_COLLECTION_BUSY' });
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  gate.resolve(); await peerClosed;
  if (retainedClaim) {
    assert.equal(await controller.canResumeOperation(f.operationId), true);
    const status = body(await h.call('processing_status', {}));
    assert.equal(status.status, 'idle'); assert.equal(status.nextAction, 'resume');
    assert.deepEqual(status.diagnostics, []);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  }
});
