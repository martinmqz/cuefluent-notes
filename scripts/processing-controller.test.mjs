import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { processingFixture } from './test-support/processing-fixture.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { createProcessingWorkset, inspectProcessingWorkset, prepareWorksetBatch } from './processing-workset.mjs';
import { prepareProcessing, completeProcessing, inspectProcessing } from './processing.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { unitKey } from './capture-retention.mjs';
import { codexProcessingProfile } from './processing-client-codex.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
async function registryJSON(f) {
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  return JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'));
}
async function harness(t, f, client = 'codex') {
  const profileRoot = path.join(f.root, 'synthetic-profile'); await fs.mkdir(profileRoot);
  const h = { creates: 0, resumes: 0, dispatches: [], closes: 0, bridgeCloses: 0, events: [],
    script: async call => call('processing_pending', {}), resultStatus: 'completed', failCreate: false,
    env: { CLAUDE_CONFIG_DIR: profileRoot }, profileId: digest('synthetic-codex-profile') };
  const dependencies = { env: h.env, ...(client === 'codex' ? { profileId: h.profileId } : {}), hostId: digest('synthetic-controller-host'),
    async beforeExecution(event) {
      const state = await registryJSON(f);
      assert.equal(state.state, 'busy'); assert.equal(state.active.requestId, event.requestId);
      assert.equal(state.session.sessionId, event.session.sessionId);
      if (client === 'claude' && h.dispatches.length === 0) assert.equal(state.session.verification, 'reserved');
      h.events.push('before-execution'); await h.beforeExecution?.(event);
    },
    async guardExecution(event) { h.events.push('guard'); await h.guardExecution?.(event); },
    async onNativeBoundary(event) { h.events.push(event.phase); },
    async afterExecution(event) { h.events.push('after-execution'); await h.afterExecution?.(event); },
    async afterInterruptedExecution(event) {
      if (!h.afterInterruptedExecution) throw Object.assign(new Error('unverified interruption'), { code: 'PROCESSING_CLIENT_INTERRUPTED' });
      await h.afterInterruptedExecution(event);
    },
    async reconcileExecution(context) { return h.reconcileExecution ? h.reconcileExecution(context) : null; },
    async inspectOperation(operationId) { return h.inspectOperation ? h.inspectOperation(operationId) : inspectProcessing(f.capability, operationId); },
    async openCodex(options) {
      const call = (name, args) => options.onEngineTool({ tool: `cuefluent_${name}`, arguments: args });
      return {
        profileId: h.profileId,
        async create() {
          h.creates++;
          if (h.createError) throw h.createError;
          if (h.failCreate) throw Object.assign(new Error('synthetic create interrupted'), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
          const sessionId = randomUUID();
          return { client, sessionId, sourcePath: path.join(f.root, `${sessionId}.jsonl`), cwd: options.cwd,
            profileId: h.profileId, transport: 'codex-app-server', desktopVerified: false,
            toolContractHash: digest(canonicalJSON(options.tools)) };
        },
        async resume(session) {
          h.resumes++;
          assert.equal((await registryJSON(f)).state, 'busy', 'registry ownership precedes native resume');
          await h.onResume?.(); return structuredClone(session);
        },
        async startTurn(request) {
          if (h.preDispatchError) throw h.preDispatchError;
          const unitId = randomUUID();
          await request.roleGuard({ ...request.session, unitId: null, phase: 'before-input' });
          h.dispatches.push({ sessionId: request.session.sessionId, unitId, input: request.input });
          await request.roleGuard({ ...request.session, unitId, phase: 'started' });
          await h.script(call, request);
          await h.afterNativeResult?.({ unitId, request });
          return { ...request.session, unitId, status: h.resultStatus, model: 'synthetic-model' };
        },
        async close() { h.closes++; }
      };
    },
    async openBridge(options) {
      h.bridgeCall = options.call;
      return { engine: { command: 'synthetic-engine-no-process', args: [] },
        allowedTools: options.toolNames.map(name => `mcp__cuefluent_engine__${name}`),
        async close() { h.bridgeCloses++; } };
    },
    createClaude() {
      return { async run(request) {
        if (h.preDispatchError) throw h.preDispatchError;
        await request.beforeDispatch({ client, sessionId: request.sessionId, inputId: request.inputId, resume: request.resume });
        const saved = await registryJSON(f);
        assert.equal(saved.state, 'busy'); assert.equal(saved.session.sessionId, request.sessionId);
        assert.equal(saved.active.requestId, request.inputId);
        h.dispatches.push({ sessionId: request.sessionId, inputId: request.inputId, resume: request.resume, input: request.prompt });
        await h.script(h.bridgeCall, request);
        return { client, sessionId: request.sessionId, inputId: request.inputId, status: 'completed', model: 'synthetic-model' };
      } };
    }
  };
  h.dependencies = dependencies;
  h.open = async () => {
    const controller = await openProcessingController({ ...f.options, client }, dependencies);
    t.after(() => controller.close());
    return controller;
  };
  h.controller = await h.open();
  h.request = async (extra = {}) => ({ requestId: randomUUID(), selection: f.selection,
    expectedChatHash: (await h.controller.status()).chatHash, ...extra });
  return h;
}
async function inspectAll(call, f) {
  let claim = await call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page });
    claim = await call('processing_ack', { operationId: f.operationId, expectedClaimHash: read.claimHash,
      pages: [{ index: page, hash: read.hash }] });
  }
  return claim;
}
const unchanged = f => async call => {
  await call('processing_pending', {});
  const claim = await inspectAll(call, f);
  await call('processing_complete', { operationId: f.operationId, expectedClaimHash: claim.claimHash });
};
const propose = f => async call => {
  const claim = await inspectAll(call, f);
  return call('processing_propose', { operationId: f.operationId, expectedClaimHash: claim.claimHash,
    proposal: { files: [{ path: 'meetings/rollout.md', expectedHash: null,
      content: '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n' }],
    mappings: [{ identity: f.identity, paths: ['meetings/rollout.md'] }] } });
};

test('Codex controller reuses one chat across three requests and reopening; exact duplicate does not dispatch', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = unchanged(f);
  const firstRequest = await h.request(), first = await h.controller.run(firstRequest);
  assert.equal(first.state, 'idle'); assert.equal(first.operationId, f.operationId);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'unchanged');
  h.script = async call => { assert.equal((await call('processing_pending', {})).pending.length, 0); };
  const second = await h.controller.run(await h.request());
  await h.controller.close(); h.controller = await h.open();
  const third = await h.controller.run(await h.request());
  assert.equal(h.creates, 1); assert.equal(h.resumes, 2); assert.equal(h.dispatches.length, 3);
  assert.equal(first.chat.sessionId, second.chat.sessionId); assert.equal(first.chat.sessionId, third.chat.sessionId);
  const repeated = await h.controller.run(firstRequest);
  assert.equal(repeated.chatHash, third.chatHash); assert.equal(h.dispatches.length, 3);
  await assert.rejects(h.controller.run({ ...firstRequest, selection: { ...f.selection, unitId: randomUUID() } }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  assert(!JSON.stringify(third).includes('Synthetic meeting')); assert(!JSON.stringify(third).includes(f.root));
});

test('status preserves an unknown engine outcome and retries a changed native snapshot without dispatching itself', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  await h.controller.run(await h.request());
  const claim = await inspectProcessing(f.capability, f.operationId);
  h.inspectOperation = async () => { throw Object.assign(new Error('private invalid operation bytes'), { code: 'INVALID_PROCESSING_CLAIM' }); };
  const unknown = await h.controller.status();
  assert.equal(unknown.state, 'idle'); assert.equal(unknown.operationState, 'unknown');
  assert.equal(unknown.recoveryRequired, null);
  assert.deepEqual(unknown.diagnostics, ['OPERATION_OUTCOME_UNKNOWN']);
  assert(!JSON.stringify(unknown).includes('private invalid'));
  assert.equal((await h.controller.status({ inspectOperation: false })).operationState, undefined);
  assert.equal(h.dispatches.length, 1);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  h.inspectOperation = async () => {
    h.inspectOperation = undefined;
    h.script = async () => {};
    await h.controller.run({ requestId: randomUUID(), selection: f.selection,
      expectedChatHash: (await h.controller.status({ inspectOperation: false })).chatHash });
    return claim;
  };
  const fresh = await h.controller.status();
  assert.equal(fresh.operationId, null); assert.equal(fresh.operationState, undefined);
  assert.equal(h.dispatches.length, 2);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
});

test('status reports completed engine outcomes separately from native completion', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = unchanged(f);
  await h.controller.run(await h.request());
  const snapshot = await h.controller.status();
  assert.equal(snapshot.state, 'idle'); assert.equal(snapshot.operationState, 'completed');
  assert.equal(snapshot.operationOutcome, 'unchanged'); assert.equal(snapshot.recoveryRequired, false);
  assert.equal(h.dispatches.length, 1);
});

test('CLI chat status exposes engine completion with only synthetic profile and storage', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  await h.controller.close();
  h.env.CODEX_HOME = path.join(f.root, 'codex-profile'); await fs.mkdir(h.env.CODEX_HOME);
  h.profileId = await codexProcessingProfile(h.env); h.dependencies.profileId = h.profileId;
  h.controller = await h.open(); h.script = unchanged(f);
  await h.controller.run(await h.request()); await h.controller.close();
  const request = path.join(f.root, 'status-request.json');
  await fs.writeFile(request, canonicalJSON({ collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { client: 'codex' } }));
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./workflow.mjs', import.meta.url)), 'processing-chat-status', '--config', f.options.configPath, '--request', request],
    { env: { ...process.env, ...h.env } });
  const result = JSON.parse(stdout);
  assert.equal(result.state, 'idle'); assert.equal(result.operationState, 'completed');
  assert.equal(result.operationOutcome, 'unchanged'); assert.equal(result.recoveryRequired, false);
  assert.equal(h.dispatches.length, 1); assert(!stdout.includes(f.root));
});

test('controller rejects a simultaneous request before the second native dispatch', async t => {
  const f = await processingFixture(t), h = await harness(t, f), entered = deferred(), release = deferred();
  h.script = async () => { entered.resolve(); await release.promise; };
  const request = await h.request();
  const first = h.controller.run(request);
  const rejected = h.controller.run({ ...request, requestId: randomUUID() });
  const observedRejection = assert.rejects(rejected, { code: 'PROCESSING_CHAT_BUSY' });
  try { await entered.promise; await observedRejection; }
  finally { release.resolve(); }
  await first;
  assert.equal(h.creates, 1); assert.equal(h.dispatches.length, 1);
});

test('controller binds engine selection and allows only one operation for each native request', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => {
    await assert.rejects(call('configure', {}), { code: 'PROCESSING_TOOL_NOT_ALLOWED' });
    await assert.rejects(call('processing_pending', { selection: { ...f.selection, sessionId: randomUUID() } }), { code: 'INVALID_WORKFLOW' });
    await assert.rejects(call('processing_prepare', { operationId: f.operationId,
      inputs: [{ ...f.inputs[0], identity: { ...f.identity, sessionId: randomUUID() } }] }), { code: 'PROCESSING_SELECTION_CHANGED' });
    assert.equal((await call('processing_status', { operationId: randomUUID() })).state, 'missing');
    await call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
    await assert.rejects(call('processing_status', { operationId: randomUUID() }), { code: 'PROCESSING_RUN_BUDGET' });
    await assert.rejects(call('processing_save', { operationId: f.operationId }), { code: 'PROCESSING_TOOL_NOT_ALLOWED' });
    await unchanged(f)(call);
  };
  const result = await h.controller.run(await h.request());
  assert.equal(result.state, 'idle'); assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'unchanged');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('a proposal stops at review; only exact engine completion unlocks the existing chat', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = propose(f);
  const review = await h.controller.run(await h.request());
  assert.equal(review.state, 'awaiting-review'); assert.equal(review.operationId, f.operationId);
  assert.deepEqual(await h.controller.reviewContext({ expectedChatHash: review.chatHash, requestId: review.requestId }),
    { selection: { ...f.selection, unitId: f.selection.unitId ?? null }, operationId: f.operationId });
  await assert.rejects(h.controller.reviewContext({ expectedChatHash: digest('stale'), requestId: review.requestId }), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  const inspected = await inspectProcessing(f.capability, f.operationId);
  assert.equal(inspected.state, 'awaiting-review'); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const stillPending = await h.controller.run(await h.request());
  assert.equal(stillPending.state, 'awaiting-review'); assert.equal(stillPending.chatHash, review.chatHash);
  await assert.rejects(h.controller.finishReview({ expectedChatHash: review.chatHash, requestId: review.requestId,
    operationId: f.operationId }), { code: 'PROCESSING_CHAT_REVIEW_UNRESOLVED' });
  assert.equal(h.dispatches.length, 1);
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: inspected.claimHash, outcome: 'skipped' });
  assert.equal((await h.controller.finishReview({ expectedChatHash: review.chatHash, requestId: review.requestId,
    operationId: f.operationId })).state, 'idle');
  h.script = async call => call('processing_pending', {});
  const resumed = await h.controller.run(await h.request());
  assert.equal(resumed.state, 'idle'); assert.equal(resumed.chat.sessionId, review.chat.sessionId);
  assert.equal(h.creates, 1); assert.equal(h.dispatches.length, 2);
  const stored = await registryJSON(f);
  assert.equal(stored.runs[0].reviewResolved, true);
});

test('explicit reconciliation finishes a sealed native result without another dispatch or claim change', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = propose(f);
  let completed;
  h.afterNativeResult = async ({ unitId }) => {
    const stored = await registryJSON(f);
    assert.equal(stored.active.operationId, f.operationId, 'operation ownership is durable before sealing');
    assert.deepEqual(stored.active.selection, { ...f.selection, unitId: f.selection.unitId ?? null });
    completed = { nativeRun: { runId: unitId, inputId: stored.active.requestId, unitIds: [unitId] } };
    throw Object.assign(new Error('synthetic failure after sealed native completion'), { code: 'EIO' });
  };
  const request = await h.request();
  await assert.rejects(h.controller.run(request));
  const blocked = await h.controller.status(), before = await inspectProcessing(f.capability, f.operationId);
  assert.equal(blocked.state, 'blocked');
  h.reconcileExecution = async context => {
    assert.equal(context.request.requestId, request.requestId); return completed;
  };
  await assert.rejects(h.controller.reconcile({ expectedChatHash: digest('stale'), requestId: request.requestId }), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  const done = await h.controller.reconcile({ expectedChatHash: blocked.chatHash, requestId: request.requestId });
  assert.equal(done.state, 'awaiting-review'); assert.equal(done.operationId, f.operationId);
  assert.equal(h.dispatches.length, 1); assert.equal(h.creates, 1); assert.equal(h.resumes, 0);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, before.claimHash);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('unproven reconciliation preserves the blocked hash and does not restart interrupted work', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  h.afterNativeResult = async () => { throw Object.assign(new Error('native connection lost'), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' }); };
  const request = await h.request(); await assert.rejects(h.controller.run(request));
  const blocked = await h.controller.status();
  const result = await h.controller.reconcile({ expectedChatHash: blocked.chatHash, requestId: request.requestId });
  assert.equal(result.chatHash, blocked.chatHash);
  assert(result.diagnostics.includes('PROCESSING_CHAT_RECONCILIATION_UNPROVEN'));
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'unread');
  assert.equal(h.dispatches.length, 1); assert.equal(h.creates, 1);
});

test('verified native interruption preserves the operation and resumes it only on a new request in the same chat', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  h.resultStatus = 'interrupted'; h.afterInterruptedExecution = async event => {
    assert.equal(event.result.status, 'interrupted'); assert.equal(event.requestId, event.inputId);
  };
  const request = await h.request(), first = await h.controller.run(request);
  assert.equal(first.nativeStatus, 'interrupted'); assert.equal(first.state, 'idle');
  const claimed = await inspectProcessing(f.capability, f.operationId);
  assert.equal(claimed.state, 'unread'); assert.equal(h.dispatches.length, 1);
  assert.equal((await registryJSON(f)).runs[0].native.terminal, 'interrupted');
  await h.controller.run(request); assert.equal(h.dispatches.length, 1, 'the old request never redispatches');
  h.resultStatus = 'completed'; h.script = unchanged(f);
  const next = await h.controller.run(await h.request());
  assert.equal(next.chat.sessionId, first.chat.sessionId); assert.equal(h.creates, 1); assert.equal(h.resumes, 1);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'unchanged');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('interrupted native execution preserves its claim and unknown outcome without redispatch', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  h.afterNativeResult = async () => { throw Object.assign(new Error('native connection lost'), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' }); };
  const request = await h.request();
  await assert.rejects(h.controller.run(request), error => error.code === 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' && error.processingChat.state === 'blocked');
  const claim = await inspectProcessing(f.capability, f.operationId);
  assert.equal(claim.state, 'unread');
  const repeated = await h.controller.run(request);
  assert.equal(repeated.state, 'blocked'); assert.deepEqual(repeated.diagnostics, ['DISPATCH_OUTCOME_UNKNOWN']);
  const next = await h.controller.run(await h.request());
  assert.equal(next.state, 'blocked'); assert.equal(h.dispatches.length, 1); assert.equal(h.creates, 1);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
});

test('an unknown native creation is durable and a later request cannot silently create another chat', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.failCreate = true;
  await assert.rejects(h.controller.run(await h.request()), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
  const state = await h.controller.status();
  assert.equal(state.state, 'blocked'); assert.deepEqual(state.diagnostics, ['CREATION_OUTCOME_UNKNOWN']);
  assert.equal((await h.controller.run(await h.request())).state, 'blocked');
  assert.equal(h.creates, 1); assert.equal(h.dispatches.length, 0);
});

test('configuration changes during a native request revoke engine access without discarding active state', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => {
    f.config.routes[0].excluded = true;
    await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
    await call('processing_pending', {});
  };
  await assert.rejects(h.controller.run(await h.request()), { code: 'WORKFLOW_POLICY_CHANGED' });
  const state = await registryJSON(f);
  assert.equal(state.state, 'busy'); assert(state.active.requestId); assert.equal(state.runs.length, 0);
  assert.equal(h.dispatches.length, 1); assert.equal(h.creates, 1);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('failed request validation releases the busy gate without creating or dispatching a native session', async t => {
  const f = await processingFixture(t), h = await harness(t, f), request = await h.request();
  await assert.rejects(h.controller.run({ ...request, selection: { ...f.selection, client: 'unsupported' } }), { code: 'INVALID_WORKFLOW' });
  assert.equal(h.creates, 0); assert.equal(h.dispatches.length, 0);
  assert.equal((await h.controller.status()).state, 'missing');
  assert.equal((await h.controller.run(request)).state, 'idle');
  assert.equal(h.creates, 1); assert.equal(h.dispatches.length, 1);
});

test('proven pre-dispatch failures leave the same chat reusable and require a fresh retry CAS', async t => {
  for (const client of ['codex', 'claude']) await t.test(client, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    h.preDispatchError = Object.assign(new Error('not started'), { code: 'PROCESSING_CLIENT_UNAVAILABLE', outcome: 'not-dispatched' });
    const request = await h.request();
    await assert.rejects(h.controller.run(request), error => error.processingChat.state === 'idle');
    const idle = await h.controller.status(); assert.equal(h.dispatches.length, 0);
    await assert.rejects(h.controller.run(request), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
    h.preDispatchError = null;
    const done = await h.controller.run({ ...request, expectedChatHash: idle.chatHash });
    assert.equal(done.chat.sessionId, idle.chat.sessionId); assert.equal(h.dispatches.length, 1);
  });
});

test('a failed pre-execution admission leaves no unknown native dispatch', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.beforeExecution = async () => { throw Object.assign(new Error('admission lock busy'), { code: 'INTAKE_BLOCKED' }); };
  const request = await h.request();
  await assert.rejects(h.controller.run(request), error => error.code === 'INTAKE_BLOCKED' && error.processingChat.state === 'idle');
  assert.equal(h.dispatches.length, 0);
  h.beforeExecution = null;
  const done = await h.controller.run({ ...request, expectedChatHash: (await h.controller.status()).chatHash });
  assert.equal(done.state, 'idle'); assert.equal(h.creates, 1); assert.equal(h.dispatches.length, 1);
});

test('known native terminal releases the chat when strict exclusion sealing is unavailable', async t => {
  for (const terminal of ['completed', 'failed', 'interrupted']) await t.test(terminal, async t => {
    const f = await processingFixture(t), h = await harness(t, f);
    h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
    h.resultStatus = terminal;
    h.afterExecution = h.afterInterruptedExecution = async () => { throw Object.assign(new Error('compacted native unit cannot be sealed'), { code: 'PROCESSING_EXECUTION_UNPROVEN' }); };
    const done = await h.controller.run(await h.request());
    assert.equal(done.state, 'idle'); assert.equal(done.nativeStatus, terminal);
    assert.deepEqual(done.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'unread');
    assert.equal((await registryJSON(f)).active, null); assert.equal(h.dispatches.length, 1);
  });
});

test('terminal completion with unavailable engine status preserves its claim for explicit inspection', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = propose(f);
  h.inspectOperation = async () => { throw Object.assign(new Error('intake busy after native terminal'), { code: 'INTAKE_BLOCKED' }); };
  const done = await h.controller.run(await h.request());
  assert.equal(done.state, 'blocked'); assert.equal(done.nativeStatus, 'completed');
  assert.deepEqual(done.diagnostics, ['OPERATION_OUTCOME_UNKNOWN']);
  const before = await inspectProcessing(f.capability, f.operationId);
  const reconciled = await h.controller.reconcile({ expectedChatHash: done.chatHash, requestId: done.requestId });
  assert.equal(reconciled.state, 'awaiting-review'); assert.equal(reconciled.operationId, f.operationId);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, before.claimHash);
  assert.equal(h.dispatches.length, 1); assert.equal(h.resumes, 0);
});

test('another controller cannot resume or reconcile a live owner and ownership precedes native resume', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  await h.controller.run(await h.request());
  const other = await h.open(), entered = deferred(), release = deferred();
  h.onResume = async () => { entered.resolve(); await release.promise; };
  const request = await h.request(), first = h.controller.run(request);
  try {
    await entered.promise;
    const busy = await other.status();
    const competing = await other.run({ ...request, requestId: randomUUID(), expectedChatHash: busy.chatHash });
    assert.equal(competing.state, 'busy');
    await assert.rejects(other.reconcile({ expectedChatHash: busy.chatHash, requestId: request.requestId }), { code: 'PROCESSING_CHAT_BUSY' });
    assert.equal(h.resumes, 1); assert.equal(h.dispatches.length, 1);
  } finally { release.resolve(); }
  await first; assert.equal(h.dispatches.length, 2);
});

test('explicit history rollover preserves request replay and resumes the same native chat for both clients', async t => {
  for (const client of ['codex', 'claude']) await t.test(client, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    const request = await h.request(), first = await h.controller.run(request);
    const rolled = await h.controller.rollover({ expectedChatHash: first.chatHash });
    assert.equal(rolled.generation, first.generation + 1); assert.equal(rolled.chat.sessionId, first.chat.sessionId);
    await h.controller.run(request); assert.equal(h.dispatches.length, 1);
    const next = await h.controller.run(await h.request());
    assert.equal(next.chat.sessionId, first.chat.sessionId); assert.equal(h.dispatches.length, 2);
    if (client === 'codex') assert.equal(h.resumes, 1);
    else assert.equal(h.dispatches[1].resume, true);
  });
});

test('policy changes during initialization close the opened native client before returning an error', async t => {
  const f = await processingFixture(t); let closed = 0;
  const before = await fs.readdir(f.collection.intakeStateDir);
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    profileId: digest('synthetic-profile'), hostId: digest('synthetic-controller-host'),
    async openCodex() {
      f.config.routes[0].excluded = true;
      await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
      return { profileId: digest('synthetic-profile'), async close() { closed++; } };
    }
  });
  await assert.rejects(controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null }), { code: 'WORKFLOW_POLICY_CHANGED' });
  await controller.close();
  assert.equal(closed, 1);
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
});

test('Claude reserves its UUID before launch and never records input UUIDs as invented prompt units', async t => {
  const f = await processingFixture(t, { client: 'claude' }), h = await harness(t, f, 'claude');
  h.script = unchanged(f);
  const firstRequest = await h.request(), first = await h.controller.run(firstRequest);
  const stored = await registryJSON(f);
  assert.equal(stored.session.verification, 'verified');
  assert.deepEqual(stored.runs[0].native.unitIds, []);
  assert.equal(stored.runs[0].native.inputId, firstRequest.requestId);
  assert.equal(h.dispatches[0].resume, false);
  h.script = async call => call('processing_pending', {});
  const second = await h.controller.run(await h.request());
  assert.equal(h.dispatches[1].resume, true); assert.equal(second.chat.sessionId, first.chat.sessionId);
  assert.equal(h.dispatches.length, 2); assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'unchanged');
  await h.controller.close(); assert.equal(h.bridgeCloses, 1);
});


test('proven creation failures remain retryable and metadata status never opens a native transport', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  assert.equal(h.creates, 0);
  h.createError = Object.assign(new Error('missing capability'), { code: 'PROCESSING_CLIENT_UNAVAILABLE', outcome: 'not-dispatched' });
  await assert.rejects(h.controller.run(await h.request()), { code: 'PROCESSING_CLIENT_UNAVAILABLE' });
  assert.equal((await registryJSON(f)).block.reason, 'creation-not-dispatched');
  await h.controller.close(); h.createError = null; h.controller = await h.open();
  assert.equal((await h.controller.run(await h.request())).state, 'idle');
  assert.equal(h.dispatches.length, 1);
});

test('metadata-only status and review survive an unavailable CLI and preserve a historical host namespace', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = propose(f); const done = await h.controller.run(await h.request()); await h.controller.close();
  delete h.dependencies.hostId;
  h.dependencies.openCodex = async () => { assert.fail('metadata inspection must not spawn Codex'); };
  h.controller = await h.open();
  assert.equal((await h.controller.status()).chatHash, done.chatHash);
  const context = await h.controller.reviewContext({ expectedChatHash: done.chatHash, requestId: done.requestId });
  assert.equal(context.operationId, f.operationId);
  const retry = await h.controller.run(await h.request());
  assert.equal(retry.state, 'awaiting-review'); assert.equal(retry.chatHash, done.chatHash);
  assert.equal(h.dispatches.length, 1);
});

test('explicit offline abandonment preserves unknown claims and retires the chat for both clients', async t => {
  for (const client of ['codex', 'claude']) await t.test(client, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    h.script = async call => { await call('processing_prepare', { operationId: f.operationId, inputs: f.inputs }); throw new Error('synthetic lost terminal'); };
    const request = await h.request(); await assert.rejects(h.controller.run(request));
    const blocked = await h.controller.status(), claim = await inspectProcessing(f.capability, f.operationId);
    await assert.rejects(h.controller.abandon({ expectedChatHash: blocked.chatHash, requestId: request.requestId, offline: false }), { code: 'PROCESSING_CHAT_ABANDON_UNPROVEN' });
    await assert.rejects(h.controller.abandon({ expectedChatHash: 'f'.repeat(64), requestId: request.requestId, offline: true }), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
    const abandoned = await h.controller.abandon({ expectedChatHash: blocked.chatHash, requestId: request.requestId, offline: true });
    assert.equal(abandoned.state, 'blocked');
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
    await assert.rejects(h.controller.run({ ...request, expectedChatHash: abandoned.chatHash }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
    h.script = async call => { assert.equal((await call('processing_pending', {})).operations[0].operationId, f.operationId); };
    const next = await h.controller.run(await h.request());
    assert.notEqual(next.chat.sessionId, blocked.chat.sessionId);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
  });
});


async function completeBound(call, preparation) {
  let claim = await call('processing_prepare', preparation);
  const operationId = claim.operationId;
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await call('processing_page', { operationId, expectedClaimHash: claim.claimHash, page });
    claim = await call('processing_ack', { operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  return call('processing_complete', { operationId, expectedClaimHash: claim.claimHash });
}

test('one isolated turn processes sequential frozen batches across clients and excludes later arrivals', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a, client: 'claude' });
  const worksetId = randomUUID();
  await createProcessingWorkset(a.capability, { selection: a.selection, worksetId, inputs: [...a.inputs, ...b.inputs] });
  const later = await processingFixture(t, { base: a }), h = await harness(t, a);
  const operations = [];
  h.script = async call => {
    for (;;) {
      const pending = await call('processing_pending', { limit: 1 });
      assert.equal(pending.workset.worksetId, worksetId);
      assert(!pending.pending.some(item => item.identity.sessionId === later.identity.sessionId));
      if (!pending.nextPreparation) break;
      const done = await completeBound(call, pending.nextPreparation); operations.push(done.operationId);
      // Historical reads must not move the current operation pin backward.
      if (operations.length > 1) assert.equal((await call('processing_status', { operationId: operations[0] })).outcome, 'unchanged');
    }
  };
  const result = await h.controller.run(await h.request({ worksetId }));
  assert.equal(h.dispatches.length, 1); assert.equal(operations.length, 2);
  assert.equal(result.workset.inputCounts.handled, 2); assert.equal(result.workset.remainingSelected, 0);
  assert.equal(result.workset.chargedBatches, 2); assert.equal(result.operationOutcome, 'unchanged');
  assert.equal((await registryJSON(a)).runs.at(-1).request.worksetId, worksetId);
  assert.equal((await inspectProcessing(a.capability, later.operationId)).state, 'missing');
  const empty = await h.controller.run(await h.request({ worksetId }));
  assert.equal(empty.dispatch, 'not-started'); assert.equal(empty.reason, 'workset-complete'); assert.equal(h.dispatches.length, 1);
});

test('frozen runs cannot start another operation until the current one has a durable terminal outcome', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a });
  const worksetId = randomUUID();
  await createProcessingWorkset(a.capability, { selection: a.selection, worksetId, inputs: [...a.inputs, ...b.inputs] });
  const h = await harness(t, a); let operationId;
  h.script = async call => {
    const pending = await call('processing_pending', { limit: 1 });
    operationId = (await call('processing_prepare', pending.nextPreparation)).operationId;
    await assert.rejects(call('processing_prepare', { operationId: randomUUID(), inputs: b.inputs }), { code: 'PROCESSING_RESUME_REQUIRED' });
    const again = await call('processing_pending', {});
    assert.equal(again.operations.length, 1); assert.equal(again.nextPreparation, null);
  };
  const first = await h.controller.run(await h.request({ worksetId }));
  assert.equal(first.operationState, 'unread');
  await h.controller.close(); h.controller = await h.open();
  h.script = async call => {
    const pending = await call('processing_pending', {});
    assert.equal(pending.operations[0].operationId, operationId);
    let claim = await call('processing_status', { operationId });
    for (let page = 0; page < claim.inspection.totalPages; page++) {
      const read = await call('processing_page', { operationId, expectedClaimHash: claim.claimHash, page });
      claim = await call('processing_ack', { operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
    }
    await call('processing_complete', { operationId, expectedClaimHash: claim.claimHash });
    await completeBound(call, (await call('processing_pending')).nextPreparation);
  };
  const resumed = await h.controller.run(await h.request({ worksetId }));
  assert.equal(resumed.workset.inputCounts.handled, 2); assert.equal(h.creates, 1); assert.equal(h.resumes, 1);
});

test('frozen proposal review uses its original operation selection when invoked from a different chat', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a, client: 'claude' });
  const worksetId = randomUUID();
  await createProcessingWorkset(a.capability, { selection: a.selection, worksetId, inputs: [...a.inputs, ...b.inputs] });
  const h = await harness(t, a);
  h.script = async call => {
    const pending = await call('processing_pending');
    let claim = await call('processing_prepare', pending.nextPreparation);
    const operationId = claim.operationId;
    for (let page = 0; page < claim.packet.pages.length; page++) {
      const read = await call('processing_page', { operationId, expectedClaimHash: claim.claimHash, page });
      claim = await call('processing_ack', { operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
    }
    await call('processing_propose', { operationId, expectedClaimHash: claim.claimHash, proposal: {
      files: [{ path: 'meetings/rollout.md', expectedHash: null, content: '# Rollout\n\n## Decision\n\nKeep the rollout paused.\n' }],
      mappings: [a, b].map(f => ({ identity: f.identity, paths: ['meetings/rollout.md'] })) } });
  };
  const result = await h.controller.run(await h.request({ selection: b.selection, worksetId }));
  assert.equal(result.state, 'awaiting-review');
  const context = await h.controller.reviewContext({ expectedChatHash: result.chatHash, requestId: result.requestId });
  assert.deepEqual(context.selection, a.selection); assert.equal(context.operationId, result.operationId);
  assert.deepEqual(await fs.readdir(a.collection.notes.notesDir), []);
});

test('explicit legacy-operation resume preserves exact selection and does not admit fresh evidence', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a });
  await prepareProcessing(a.capability, { ...a.args, inputs: a.inputs });
  const h = await harness(t, a);
  h.script = async call => {
    const pending = await call('processing_pending');
    assert.equal(pending.operations[0].operationId, a.operationId); assert.deepEqual(pending.pending, []);
    await assert.rejects(call('processing_prepare', { operationId: a.operationId, inputs: a.inputs }), { code: 'PROCESSING_RESUME_REQUIRED' });
    const read = await call('processing_page', { operationId: a.operationId, expectedClaimHash: pending.operations[0].claimHash, page: 0 });
    const claim = await call('processing_ack', { operationId: a.operationId, expectedClaimHash: read.claimHash, pages: [{ index: 0, hash: read.hash }] });
    await call('processing_complete', { operationId: a.operationId, expectedClaimHash: claim.claimHash });
  };
  const result = await h.controller.run(await h.request({ selection: b.selection, resumeOperationId: a.operationId }));
  assert.equal(result.operationOutcome, 'unchanged'); assert.equal(result.operationId, a.operationId);
  assert.deepEqual((await inspectProcessing(a.capability, a.operationId)).selection, a.selection);
  assert.equal((await inspectProcessing(a.capability, b.operationId)).state, 'missing');
});

test('a different client cannot dispatch while this collection has an active native owner', async t => {
  const f = await processingFixture(t), h = await harness(t, f), gate = deferred(), started = deferred();
  h.script = async () => { started.resolve(); await gate.promise; };
  const running = h.controller.run(await h.request());
  const other = await openProcessingController({ ...f.options, client: 'claude' }, h.dependencies);
  try {
    await started.promise;
    const activity = await other.collectionActivity(); assert.equal(activity.length, 1); assert.equal(activity[0].own, false);
    await assert.rejects(other.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null }), { code: 'PROCESSING_COLLECTION_BUSY' });
    assert.equal(h.dispatches.length, 1); assert.equal(h.creates, 1);
  } finally { gate.resolve(); await running; await other.close(); }
});


test('a settled engine proposal does not let a stale peer review registry block another client', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = propose(f);
  const result = await h.controller.run(await h.request());
  const other = await openProcessingController({ ...f.options, client: 'claude' }, h.dependencies);
  try {
    assert.equal((await other.collectionActivity())[0].state, 'awaiting-review');
    const claim = await inspectProcessing(f.capability, f.operationId);
    await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
    assert.deepEqual(await other.collectionActivity(), []);
    assert.equal((await h.controller.status()).chatHash, result.chatHash);
    assert.equal((await h.controller.status()).state, 'awaiting-review');
  } finally { await other.close(); }
});


test('bound workset CLI accepts its explicit schema and returns no-dispatch for completed evidence', async t => {
  const f = await processingFixture(t), h = await harness(t, f), worksetId = randomUUID();
  h.script = unchanged(f); await h.controller.run(await h.request());
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  const profile = path.join(f.root, 'cli-profile'); await fs.mkdir(profile, { mode: 0o700 });
  const file = path.join(f.root, 'bound-cli.json');
  await fs.writeFile(file, JSON.stringify({ collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash,
    args: { client: 'codex', requestId: randomUUID(), selection: f.selection, expectedChatHash: null, worksetId } }));
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./workflow.mjs', import.meta.url)),
    'processing-chat-run', '--config', f.options.configPath, '--request', file], { env: { ...process.env, CODEX_HOME: profile } });
  const result = JSON.parse(stdout);
  assert.equal(result.dispatch, 'not-started'); assert.equal(result.reason, 'workset-complete');
  assert.equal(result.workset.inputCounts.handledElsewhere, 1);
});


test('workset native turns stop before a fourth operation and reuse the exact remainder', async t => {
  const f = await processingFixture(t), fixtures = [f];
  for (let i = 0; i < 3; i++) fixtures.push(await processingFixture(t, { base: f }));
  const worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: fixtures.flatMap(item => item.inputs) });
  const h = await harness(t, f); let processed = 0;
  h.script = async call => {
    for (let i = 0; i < 3; i++) { await completeBound(call, (await call('processing_pending', { limit: 1 })).nextPreparation); processed++; }
    const stopped = await call('processing_pending');
    assert.equal(stopped.nextPreparation, null); assert.equal(stopped.reason, 'run-budget');
  };
  const first = await h.controller.run(await h.request({ worksetId }));
  assert.equal(first.workset.inputCounts.unattempted, 1); assert.equal(processed, 3);
  h.script = async call => { await completeBound(call, (await call('processing_pending')).nextPreparation); };
  const next = await h.controller.run(await h.request({ worksetId }));
  assert.equal(next.workset.inputCounts.handled, 4); assert.equal(h.creates, 1); assert.equal(h.resumes, 1);
});

test('elapsed run cutoff preserves unattempted evidence and leaves the native binding idle', async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  const h = await harness(t, f);
  h.script = async call => {
    const real = performance.now.bind(performance), mock = t.mock.method(performance, 'now', () => real() + 9 * 60 * 1000);
    try { const pending = await call('processing_pending'); assert.equal(pending.reason, 'run-budget'); assert.equal(pending.nextPreparation, null); }
    finally { mock.mock.restore(); }
  };
  const result = await h.controller.run(await h.request({ worksetId }));
  assert.equal(result.state, 'idle'); assert.equal(result.workset.chargedBatches, 0);
});

test('unavailable frozen inputs do not block independent work and are not described as exhausted budget', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f }), worksetId = randomUUID();
  const workset = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: [...f.inputs, ...b.inputs] });
  const claim = await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  await completeProcessing(f.capability, { selection: f.selection, operationId: claim.operationId, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
  const h = await harness(t, f);
  h.script = async call => { await completeBound(call, (await call('processing_pending')).nextPreparation); };
  const first = await h.controller.run(await h.request({ worksetId }));
  assert.equal(first.workset.inputCounts.handled, 1); assert.equal(first.workset.inputCounts.cancelled, 1);
  const next = await h.controller.run(await h.request({ worksetId }));
  assert.equal(next.reason, 'workset-remainder-unavailable'); assert.equal(h.dispatches.length, 1);
});

test('final workset metadata failure preserves the committed native outcome', async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  const h = await harness(t, f); let mock;
  h.script = async call => { await completeBound(call, (await call('processing_pending')).nextPreparation); };
  h.afterNativeResult = async () => {
    const real = fs.lstat, worksetFile = path.join(f.collection.notes.writerStateDir, 'processed', 'worksets', worksetId + '.json');
    mock = t.mock.method(fs, 'lstat', async (file, ...args) => { if (file === worksetFile) throw Object.assign(new Error('synthetic race'), { code: 'EIO' }); return real(file, ...args); });
  };
  let result;
  try { result = await h.controller.run(await h.request({ worksetId })); } finally { mock?.mock.restore(); }
  assert.equal(result.workset, null); assert(result.diagnostics.includes('WORKSET_OUTCOME_UNKNOWN'));
  assert.equal(result.nativeStatus, 'completed');
  assert.equal((await registryJSON(f)).runs.length, 1);
});


test('a missing unattempted frozen head does not block another valid input', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f }), worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: [...f.inputs, ...b.inputs] });
  await fs.unlink(path.join(f.collection.intakeStateDir, 'heads', unitKey(f.identity) + '.json'));
  const h = await harness(t, f);
  h.script = async call => {
    const pending = await call('processing_pending');
    assert.deepEqual(pending.nextPreparation.inputs, b.inputs);
    await completeBound(call, pending.nextPreparation);
  };
  const done = await h.controller.run(await h.request({ worksetId }));
  assert.equal(done.workset.inputCounts.handled, 1); assert.equal(done.workset.inputCounts.blocked, 1);
  const stopped = await h.controller.run(await h.request({ worksetId }));
  assert.equal(stopped.reason, 'workset-remainder-unavailable'); assert.equal(h.dispatches.length, 1);
});
