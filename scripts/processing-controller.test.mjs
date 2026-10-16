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
const propose = (f, inspected = null) => async call => {
  const claim = inspected ?? await inspectAll(call, f);
  return call('processing_propose', { operationId: f.operationId, expectedClaimHash: claim.claimHash,
    proposal: { files: [{ path: 'meetings/rollout.md', expectedHash: null,
      content: '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n' }],
    mappings: [{ identity: f.identity, paths: ['meetings/rollout.md'] }] } });
};

async function assertRetiredPeerBlocked(t, f, h) {
  const stored = await registryJSON(f);
  for (const client of ['codex', 'claude']) {
    const profileRoot = path.join(f.root, `peer-profile-${randomUUID()}`); await fs.mkdir(profileRoot);
    const peer = await openProcessingController({ ...f.options, client }, {
      ...h.dependencies, profileId: digest(profileRoot), env: { CLAUDE_CONFIG_DIR: profileRoot },
      async openCodex() { assert.fail('a retired peer claim must block before native startup'); },
      createClaude() { assert.fail('a retired peer claim must block before native startup'); }
    });
    t.after(() => peer.close());
    const activity = await peer.collectionActivity();
    assert.equal(activity.length, 1); assert.equal(activity[0].own, false); assert.equal(activity[0].state, 'blocked');
    await assert.rejects(peer.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null }),
      { code: 'PROCESSING_COLLECTION_BUSY' });
    assert.deepEqual(await registryJSON(f), stored);
    await peer.close();
  }
}

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

test('explicit offline abandonment preserves unknown claims and blocks replacement runs for both clients', async t => {
  for (const client of ['codex', 'claude']) await t.test(client, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    h.script = async call => { await call('processing_prepare', { operationId: f.operationId, inputs: f.inputs }); throw new Error('synthetic lost terminal'); };
    const request = await h.request(); await assert.rejects(h.controller.run(request));
    const blocked = await h.controller.status(), claim = await inspectProcessing(f.capability, f.operationId);
    await assert.rejects(h.controller.abandon({ expectedChatHash: blocked.chatHash, requestId: request.requestId, offline: false }), { code: 'PROCESSING_CHAT_ABANDON_UNPROVEN' });
    await assert.rejects(h.controller.abandon({ expectedChatHash: 'f'.repeat(64), requestId: request.requestId, offline: true }), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
    const abandoned = await h.controller.abandon({ expectedChatHash: blocked.chatHash, requestId: request.requestId, offline: true });
    assert.equal(abandoned.state, 'blocked');
    assert.deepEqual(abandoned.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    assert.equal(abandoned.chat, null); assert.equal(abandoned.requestId, null);
    assert.equal(abandoned.resumeSupported, false);
    assert.deepEqual(await h.controller.status(), abandoned);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
    await assert.rejects(h.controller.run({ ...request, expectedChatHash: abandoned.chatHash }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
    const worksetId = randomUUID();
    await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
    const stored = await registryJSON(f), events = [...h.events], creates = h.creates;
    for (const extra of [{}, { resumeOperationId: f.operationId }, { worksetId }]) {
      assert.deepEqual(await h.controller.run(await h.request(extra)), abandoned);
      assert.deepEqual(await registryJSON(f), stored);
      assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
    }
    assert.equal(h.dispatches.length, 1); assert.equal(h.creates, creates);
    assert.deepEqual(h.events, events);
    await assertRetiredPeerBlocked(t, f, h);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

test('processing-chat-run CLI cannot replace a retired binding with an unverified claim', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  await h.controller.close();
  h.env.CODEX_HOME = path.join(f.root, 'codex-profile'); await fs.mkdir(h.env.CODEX_HOME);
  h.profileId = await codexProcessingProfile(h.env); h.dependencies.profileId = h.profileId;
  h.controller = await h.open();
  h.script = async call => {
    await call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
    throw new Error('synthetic lost terminal');
  };
  await assert.rejects(h.controller.run(await h.request()));
  const failed = await h.controller.status();
  const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const stored = await registryJSON(f), claim = await inspectProcessing(f.capability, f.operationId);
  await h.controller.close();
  const request = path.join(f.root, 'retired-run.json');
  await fs.writeFile(request, canonicalJSON({ collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash,
    args: { client: 'codex', requestId: randomUUID(), selection: f.selection, expectedChatHash: retired.chatHash } }));
  // Never launch an installed native client if admission regresses.
  const env = Object.fromEntries(Object.entries({ ...process.env, ...h.env }).filter(([key]) => key.toUpperCase() !== 'PATH'));
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./workflow.mjs', import.meta.url)), 'processing-chat-run', '--config', f.options.configPath, '--request', request],
    { env: { ...env, PATH: '' }, timeout: 30_000 });
  assert.deepEqual(JSON.parse(stdout), retired);
  assert.deepEqual(await registryJSON(f), stored);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
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

test('shortcut ownership survives rollover and exact replay for unfinished legacy and workset operations', async t => {
  const { selectProcessingShortcut, cancelProcessingShortcut } = await import('./processing-shortcuts.mjs');
  for (const kind of ['legacy', 'workset']) await t.test(kind, async t => {
    const f = await processingFixture(t), h = await harness(t, f);
    let chosen, operationId = f.operationId;
    if (kind === 'workset') chosen = await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID() });
    h.script = async call => {
      if (kind === 'legacy') await call('processing_prepare', { operationId, inputs: f.inputs });
      else {
        const pending = await call('processing_pending', {});
        const batch = await call('processing_prepare', pending.nextPreparation);
        operationId = batch.operationId;
      }
    };
    const request = await h.request(chosen ? chosen.nextRun : {});
    const finished = await h.controller.run(request);
    assert.equal(finished.state, 'idle'); assert.equal(await h.controller.canResumeOperation(operationId), true);
    const owner = { canResumeOperation: id => h.controller.canResumeOperation(id) };
    chosen = await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID(), mode: 'resume' }, owner);
    assert(chosen.nextRun);
    const claim = await inspectProcessing(f.capability, operationId);
    const rolled = await h.controller.rollover({ expectedChatHash: finished.chatHash });
    assert.equal(await h.controller.canResumeOperation(operationId), true);
    await h.controller.run(request);
    assert.equal(h.dispatches.length, 1);
    const resumed = await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID(), mode: 'resume' }, owner);
    assert.deepEqual(resumed.nextRun, chosen.nextRun);
    assert.equal((await inspectProcessing(f.capability, operationId)).claimHash, claim.claimHash);
    assert.equal(rolled.chat.sessionId, finished.chat.sessionId);
    const cancelled = await cancelProcessingShortcut(f.capability, { selection: f.selection, expectedCheckpointHash: resumed.checkpointHash },
      { ...owner, assertStopped: async () => { assert.deepEqual(await h.controller.collectionActivity(), []); } });
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal((await inspectProcessing(f.capability, operationId)).outcome, 'cancelled');
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
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

for (const reason of ['workset-complete', 'workset-budget', 'workset-remainder-unavailable', 'operation-complete']) {
  test(`missing Claude host auth preserves the no-launch ${reason} result`, async t => {
    const f = await processingFixture(t, { client: 'claude' }), h = await harness(t, f, 'claude');
    let binding;
    if (reason === 'operation-complete') {
      const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
      await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' });
      binding = { resumeOperationId: f.operationId };
    } else {
      const inputs = [...f.inputs];
      if (reason === 'workset-budget') inputs.push(...(await processingFixture(t, { base: f, client: 'claude' })).inputs);
      const worksetId = randomUUID();
      const workset = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs,
        runBudget: { maxBatches: 1, maxPacketBytes: 65536 } });
      const claim = await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
      await completeProcessing(f.capability, { selection: f.selection, operationId: claim.operationId,
        expectedClaimHash: claim.claimHash, outcome: reason === 'workset-complete' ? 'skipped' : 'cancelled' });
      binding = { worksetId };
    }
    const request = await h.request(binding), before = await h.controller.status();
    const evidence = () => binding.worksetId
      ? inspectProcessingWorkset(f.capability, binding) : inspectProcessing(f.capability, f.operationId);
    const stored = await evidence();
    h.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    const result = await h.controller.run(request);
    assert.equal(result.dispatch, 'not-started'); assert.equal(result.reason, reason);
    assert.deepEqual(await h.controller.status(), before);
    assert.deepEqual(await evidence(), stored);
    assert.equal(h.dispatches.length, 0); assert.equal(h.bridgeCall, undefined);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const state of ['busy', 'blocked']) test(`missing Claude host auth returns existing ${state} without dispatch or mutation`, async t => {
  const f = await processingFixture(t, { client: 'claude' }), h = await harness(t, f, 'claude');
  const entered = deferred(), release = deferred();
  h.script = async () => {
    if (state === 'blocked') throw Object.assign(new Error('synthetic transport loss'), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
    entered.resolve(); await release.promise;
  };
  const active = h.controller.run(await h.request());
  try {
    if (state === 'blocked') await assert.rejects(active, { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
    else await entered.promise;
    const other = await h.open(), before = await other.status(), stored = await registryJSON(f);
    assert.equal(before.state, state);
    h.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    const result = await other.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: before.chatHash });
    assert.equal(result.state, state); assert.equal(result.chatHash, before.chatHash);
    assert.deepEqual(await other.status(), before); assert.deepEqual(await registryJSON(f), stored);
    assert.equal(h.dispatches.length, 1);
  } finally {
    release.resolve();
    if (state === 'busy') await active;
    else await active.catch(() => {});
  }
});

test('missing Claude host auth returns an unresolved review without acknowledging or dispatching', async t => {
  const f = await processingFixture(t, { client: 'claude' }), h = await harness(t, f, 'claude');
  h.script = propose(f);
  const review = await h.controller.run(await h.request());
  assert.equal(review.state, 'awaiting-review');
  const before = await h.controller.status(), stored = await registryJSON(f);
  const claim = await inspectProcessing(f.capability, f.operationId);
  h.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  const pending = await h.controller.run(await h.request());
  assert.equal(pending.state, 'awaiting-review'); assert.equal(pending.chatHash, review.chatHash);
  assert.deepEqual(await h.controller.status(), before);
  assert.deepEqual(await registryJSON(f), stored);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal(h.dispatches.length, 1);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('missing Claude host auth preserves a finished review and its expected chat hash', async t => {
  const f = await processingFixture(t, { client: 'claude' }), h = await harness(t, f, 'claude');
  h.script = propose(f);
  const review = await h.controller.run(await h.request());
  assert.equal(review.state, 'awaiting-review');
  const inspected = await inspectProcessing(f.capability, f.operationId);
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: inspected.claimHash, outcome: 'skipped' });
  const before = await h.controller.status(), stored = await registryJSON(f);
  h.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  await assert.rejects(h.controller.run(await h.request()), { code: 'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE' });
  assert.deepEqual(await h.controller.status(), before);
  assert.deepEqual(await registryJSON(f), stored);
  assert.equal(h.dispatches.length, 1);
  // Read-only review remains usable without launch credentials.
  assert.equal((await h.controller.reviewContext({ expectedChatHash: review.chatHash, requestId: review.requestId })).operationId, f.operationId);
});


test('retired controller projects fresh capacity and clears historical launch identifiers', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  for (let i = 0; i < 3; i++) await h.controller.run(await h.request());
  const settled = await h.controller.status();
  assert.equal(settled.remainingRuns, 125);
  h.script = async () => { throw new Error('synthetic lost terminal'); };
  const request = await h.request();
  await assert.rejects(h.controller.run(request));
  const failed = await h.controller.status();
  const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  assert.equal(retired.state, 'idle'); assert.equal(retired.remainingRuns, 128);
  assert.equal(retired.restartSupported, true); assert.equal(retired.nativeStatus, null);
  assert.equal(retired.chat, null); assert.equal(retired.requestId, null);
  assert.deepEqual(retired.diagnostics, []); assert.deepEqual(await h.controller.status(), retired);
  const stored = await registryJSON(f);
  assert.equal(stored.active.requestId, request.requestId);
  assert.equal(stored.session.sessionId, settled.chat.sessionId); assert.equal(stored.runs.length, 3);
  h.script = async call => call('processing_pending', {});
  const restarted = await h.controller.run(await h.request());
  assert.equal(restarted.remainingRuns, 127); assert.equal(restarted.restartSupported, false);
  assert.notEqual(restarted.chat.sessionId, settled.chat.sessionId);
  assert.equal((await registryJSON(f)).runs.length, 1);
});


for (const client of ['codex', 'claude']) test(`${client} retired unpinned discovery preserves actionable inventory errors`, async t => {
  for (const blocker of ['WORKFLOW_NOT_AUTHORIZED', 'PROCESSING_REINSPECTION_REQUIRED', 'writer-reserved-by-another-collection']) await t.test(blocker, async t => {
    const code = blocker === 'writer-reserved-by-another-collection' ? 'PROCESSING_RECOVERY_REQUIRED' : blocker;
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    if (client === 'codex') {
      await h.controller.close();
      h.env.CODEX_HOME = path.join(f.root, 'codex-profile'); await fs.mkdir(h.env.CODEX_HOME);
      h.profileId = await codexProcessingProfile(h.env); h.dependencies.profileId = h.profileId;
      h.controller = await h.open();
    }
    h.script = async () => { throw new Error('synthetic lost terminal before prepare'); };
    const request = await h.request(); await assert.rejects(h.controller.run(request));
    const failed = await h.controller.status();
    const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: request.requestId, offline: true });
    const stored = await registryJSON(f);
    assert.equal(stored.active.operationId, null); assert.equal(stored.active.worksetId, null);
    const reservation = path.join(f.collection.notes.writerStateDir, 'reinspection.json');
    const reservationBytes = blocker === 'writer-reserved-by-another-collection'
      ? canonicalJSON({ preview: { binding: { collectionId: 'other' } } }) + '\n' : '{}\n';
    if (code === 'WORKFLOW_NOT_AUTHORIZED') {
      await h.controller.close();
      f.config.routes[0].excluded = true;
      const bytes = JSON.stringify(f.config);
      await fs.writeFile(f.options.configPath, bytes);
      f.options.expectedConfigHash = digest(bytes);
      h.controller = await h.open();
    } else {
      // Even an incomplete transfer intent reserves the writer until inspected.
      await fs.writeFile(reservation, reservationBytes, { mode: 0o600 });
    }
    const settings = await fs.readFile(f.options.configPath);
    await assert.rejects(h.controller.status(), { code });
    await assert.rejects(h.controller.run({ ...request, requestId: randomUUID(), expectedChatHash: retired.chatHash }), { code });
    const statusRequest = path.join(f.root, 'status-request.json');
    await fs.writeFile(statusRequest, canonicalJSON({ collectionId: f.collection.id,
      expectedConfigHash: f.options.expectedConfigHash, args: { client } }));
    await assert.rejects(promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('./workflow.mjs', import.meta.url)), 'processing-chat-status', '--config', f.options.configPath, '--request', statusRequest],
      { env: { ...process.env, ...h.env } }), error => {
      assert.equal(error.code, 1); assert.deepEqual(JSON.parse(error.stderr), { error: code }); return true;
    });
    assert.deepEqual(await registryJSON(f), stored);
    assert.deepEqual(await fs.readFile(f.options.configPath), settings);
    if (code !== 'WORKFLOW_NOT_AUTHORIZED') assert.equal(await fs.readFile(reservation, 'utf8'), reservationBytes);
    assert.equal(h.creates, client === 'codex' ? 1 : 0); assert.equal(h.dispatches.length, 1);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

for (const client of ['codex', 'claude']) test(`${client} excluded retired peer stays visible without rejecting an authorized route's activity read`, async t => {
  const f = await processingFixture(t, { client }), h = await harness(t, f, client);
  h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
  await assert.rejects(h.controller.run(await h.request()));
  const failed = await h.controller.status();
  await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const stored = await registryJSON(f);
  assert.equal(stored.active.operationId, null); assert.equal(stored.active.worksetId, null);
  await h.controller.close();
  const project = path.join(f.root, 'authorized-peer-project'); await fs.mkdir(project);
  f.config.routes.push({ ...f.config.routes[0], id: 'authorized-peer', projectRoot: project });
  f.config.routes[0].excluded = true;
  const settings = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, settings);
  f.options.expectedConfigHash = digest(settings);
  h.controller = await h.open();
  // Own selection errors retain their precise diagnostic; peers get a blocker.
  await assert.rejects(h.controller.status(), { code: 'WORKFLOW_NOT_AUTHORIZED' });
  await assertRetiredPeerBlocked(t, { ...f, selection: { ...f.selection, cwd: project, sessionId: randomUUID() } }, h);
  assert.equal(await fs.readFile(f.options.configPath, 'utf8'), settings);
  assert.deepEqual(await registryJSON(f), stored);
  assert.equal(h.dispatches.length, 1);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

for (const client of ['codex', 'claude']) test(`${client} retired cross-session resume preserves its binding and refuses unavailable metadata`, async t => {
  const f = await processingFixture(t, { client }), h = await harness(t, f, client);
  const other = await processingFixture(t, { base: f, client });
  h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  await h.controller.run(await h.request());
  const claim = await inspectProcessing(f.capability, f.operationId);
  assert.equal((await h.controller.status({ selection: other.selection })).resumeSupported, false);
  h.script = async () => { throw new Error('synthetic lost terminal on resume'); };
  await assert.rejects(h.controller.run(await h.request({ selection: other.selection, resumeOperationId: f.operationId })));
  const failed = await h.controller.status();
  const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  assert.equal(retired.state, 'idle'); assert.deepEqual(retired.diagnostics, []);
  assert.equal(await h.controller.canResumeOperation(f.operationId), true);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  const stored = await registryJSON(f), creates = h.creates, dispatches = h.dispatches.length;
  assert.equal(stored.runs.at(-1).request.selection.sessionId, f.selection.sessionId);
  assert.equal(stored.active.selection.sessionId, other.selection.sessionId);
  assert.equal(stored.active.resumeOperationId, f.operationId);
  const status = await h.controller.status({ selection: other.selection });
  assert.equal(status.state, 'idle'); assert.equal(status.resumeSupported, true);
  assert.deepEqual(status.diagnostics, []);
  assert.deepEqual(await registryJSON(f), stored);
  assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
  h.inspectOperation = async () => { throw new Error('synthetic unreadable metadata'); };
  const unreadable = await h.controller.status();
  assert.equal(unreadable.state, 'blocked'); assert.equal(unreadable.operationState, 'unknown');
  assert.equal(unreadable.operationOutcome, null); assert.equal(unreadable.recoveryRequired, null);
  assert.deepEqual(unreadable.diagnostics, ['OPERATION_OUTCOME_UNKNOWN']);
  assert.equal(unreadable.chatHash, retired.chatHash);
  assert.deepEqual(await h.controller.run(await h.request()), unreadable);
  h.inspectOperation = async () => ({ ...claim, recoveryRequired: true });
  const recovery = await h.controller.status();
  assert.equal(recovery.state, 'blocked');
  assert.deepEqual(recovery.diagnostics, ['PROCESSING_RECOVERY_REQUIRED']);
  assert.deepEqual(await h.controller.run(await h.request({ resumeOperationId: f.operationId })), recovery);
  assert.deepEqual(await registryJSON(f), stored);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
  h.inspectOperation = null;
  h.script = async call => call('processing_status', { operationId: f.operationId });
  const resumed = await h.controller.run(await h.request({ selection: other.selection, resumeOperationId: f.operationId }));
  assert.equal(resumed.state, 'idle'); assert.equal(resumed.operationId, f.operationId);
  assert.notEqual(resumed.chat.sessionId, failed.chat.sessionId);
  assert.equal(h.dispatches.length, dispatches + 1);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal((await inspectProcessing(f.capability, other.operationId)).state, 'missing');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

for (const client of ['codex', 'claude']) for (const worksetAdvance of [false, true]) {
  test(`${client} retirement refuses a claim left before ${worksetAdvance ? 'workset advance' : 'first operation'} pin`, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    let binding = {}, unpinnedId, pinnedId = null, pinFailed = false;
    if (worksetAdvance) {
      const other = await processingFixture(t, { base: f, client }), worksetId = randomUUID();
      await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: [...f.inputs, ...other.inputs] });
      binding = { worksetId };
    }
    h.script = async call => {
      if (worksetAdvance) {
        const first = await call('processing_pending', { limit: 1 });
        pinnedId = (await completeBound(call, first.nextPreparation)).operationId;
      }
      const preparation = worksetAdvance ? (await call('processing_pending', { limit: 1 })).nextPreparation
        : { operationId: f.operationId, inputs: f.inputs };
      unpinnedId = preparation.operationId;
      const rename = fs.rename;
      const mock = t.mock.method(fs, 'rename', async (from, to) => {
        if (path.dirname(to) === path.join(f.collection.intakeStateDir, 'processing-chats')) {
          const next = JSON.parse(await fs.readFile(from, 'utf8'));
          if (next.state === 'busy' && next.active.operationId === unpinnedId) {
            pinFailed = true; mock.mock.restore();
            throw Object.assign(new Error('synthetic controller loss before operation pin'), { code: 'EIO' });
          }
        }
        return rename(from, to);
      });
      await call('processing_prepare', preparation);
    };
    await assert.rejects(h.controller.run(await h.request(binding)));
    assert.equal(pinFailed, true);
    assert.equal((await registryJSON(f)).active.operationId, pinnedId);
    const claim = await inspectProcessing(f.capability, unpinnedId);
    assert(claim.claimHash); assert.equal(claim.outcome, null);
    const failed = await h.controller.status();
    const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
    assert.equal(retired.state, 'blocked');
    assert.equal(retired.operationId, unpinnedId);
    assert.deepEqual(retired.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    const stored = await registryJSON(f), creates = h.creates;
    assert.deepEqual(await h.controller.status(), retired);
    assert.deepEqual(await h.controller.run(await h.request(binding)), retired);
    assert.deepEqual(await registryJSON(f), stored);
    assert.deepEqual(await inspectProcessing(f.capability, unpinnedId), claim);
    assert.equal(h.creates, creates); assert.equal(h.dispatches.length, 1);
    await assertRetiredPeerBlocked(t, f, h);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const client of ['codex', 'claude']) for (const terminalOwner of [false, true]) {
  test(`${client} retired proposal blocks own and peer admission with terminal owner ${terminalOwner}`, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    let inspected = null;
    if (terminalOwner) {
      h.script = async call => { inspected = await inspectAll(call, f); };
      await h.controller.run(await h.request());
    }
    h.script = async call => { await propose(f, inspected)(call); throw new Error('synthetic lost terminal after proposal'); };
    await assert.rejects(h.controller.run(await h.request(terminalOwner ? { resumeOperationId: f.operationId } : {})));
    const failed = await h.controller.status();
    const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
    assert.equal(retired.state, 'awaiting-review'); assert.equal(retired.operationId, f.operationId);
    assert.equal(retired.operationState, 'awaiting-review'); assert.equal(retired.resumeSupported, false);
    assert.deepEqual(retired.diagnostics, []); assert.equal(retired.requestId, null); assert.equal(retired.chat, null);
    const stored = await registryJSON(f), claim = await inspectProcessing(f.capability, f.operationId);
    const dispatches = h.dispatches.length, creates = h.creates;
    assert.deepEqual(await h.controller.run(await h.request()), retired);
    await assertRetiredPeerBlocked(t, f, h);
    assert.deepEqual(await registryJSON(f), stored);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
    assert.equal(h.dispatches.length, dispatches); assert.equal(h.creates, creates);
    await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' });
    assert.equal((await h.controller.status()).state, 'idle');
    h.script = async call => call('processing_pending', {});
    assert.equal((await h.controller.run(await h.request())).state, 'idle');
    assert.equal(h.dispatches.length, dispatches + 1);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

async function retiredTerminalClaim(t, client = 'codex') {
  const f = await processingFixture(t, { client }), h = await harness(t, f, client);
  h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  const done = await h.controller.run(await h.request());
  await h.controller.rollover({ expectedChatHash: done.chatHash });
  h.script = async call => { await call('processing_status', { operationId: f.operationId }); throw new Error('synthetic lost terminal'); };
  await assert.rejects(h.controller.run(await h.request({ resumeOperationId: f.operationId })));
  const failed = await h.controller.status();
  await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  return { f, h, claim: await inspectProcessing(f.capability, f.operationId) };
}

for (const client of ['codex', 'claude']) for (const foreign of [false, true]) for (const duringStartup of [false, true]) {
  test(`${client} pinned retired claim blocks ${foreign ? 'foreign' : 'own'} reservation ${duringStartup ? 'during startup' : 'before admission'}`, async t => {
    const { f, h, claim } = await retiredTerminalClaim(t, client);
    const retired = await h.controller.status(), stored = await registryJSON(f);
    const creates = h.creates, dispatches = h.dispatches.length;
    const reservation = path.join(f.collection.notes.writerStateDir, 'reinspection.json');
    const { binding } = JSON.parse(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`), 'utf8'));
    const bytes = canonicalJSON({ preview: { binding: foreign ? { ...binding, collectionId: 'other' } : binding } }) + '\n';
    const code = foreign ? 'PROCESSING_RECOVERY_REQUIRED' : 'PROCESSING_REINSPECTION_REQUIRED';
    const publish = () => fs.writeFile(reservation, bytes, { mode: 0o600 });
    await h.controller.close();
    const opener = client === 'codex' ? 'openCodex' : 'openBridge', open = h.dependencies[opener];
    let opens = 0;
    h.dependencies[opener] = async (...args) => { opens++; if (duringStartup) await publish(); return open(...args); };
    h.controller = await h.open();
    if (!duringStartup) await publish();
    const blocked = await h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: retired.chatHash });
    assert.equal(blocked.state, 'blocked'); assert.deepEqual(blocked.diagnostics, [code]);
    assert.equal(blocked.chatHash, retired.chatHash); assert.equal(blocked.operationId, f.operationId);
    assert.deepEqual(await h.controller.status(), blocked);
    const pending = await inspectProcessing(f.capability, f.operationId);
    assert.equal(pending.recoveryRequired, false); assert.equal(pending.claimHash, claim.claimHash);
    assert.deepEqual(pending.blockers, [foreign ? 'writer-reserved-by-another-collection' : code]);
    await assertRetiredPeerBlocked(t, f, h);
    assert.deepEqual(await registryJSON(f), stored); assert.equal(await fs.readFile(reservation, 'utf8'), bytes);
    assert.equal(opens, duringStartup ? 1 : 0); assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
    await fs.unlink(reservation); h.dependencies[opener] = open;
    await h.controller.close(); h.controller = await h.open();
    h.script = async call => call('processing_status', { operationId: f.operationId });
    assert.equal((await h.controller.run(await h.request())).state, 'idle');
    assert.equal(h.dispatches.length, dispatches + 1);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const client of ['codex', 'claude']) for (const history of ['workset', 'resume']) {
  test(`${client} retired plain run preserves null bindings after terminal ${history} history`, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    const worksetId = randomUUID();
    if (history === 'workset') {
      await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
      h.script = async call => completeBound(call, (await call('processing_pending', {})).nextPreparation);
      await h.controller.run(await h.request({ worksetId }));
    } else {
      h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
      await h.controller.run(await h.request());
      h.script = async call => call('processing_status', { operationId: f.operationId });
      await h.controller.run(await h.request({ resumeOperationId: f.operationId }));
      const claim = await inspectProcessing(f.capability, f.operationId);
      await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
    }
    const other = await processingFixture(t, { base: f, client });
    let pinFailed = false;
    h.script = async call => {
      const rename = fs.rename;
      const mock = t.mock.method(fs, 'rename', async (from, to) => {
        if (path.dirname(to) === path.join(f.collection.intakeStateDir, 'processing-chats')) {
          const next = JSON.parse(await fs.readFile(from, 'utf8'));
          if (next.state === 'busy' && next.active.operationId === other.operationId) {
            pinFailed = true; mock.mock.restore();
            throw Object.assign(new Error('synthetic loss before plain operation pin'), { code: 'EIO' });
          }
        }
        return rename(from, to);
      });
      await call('processing_prepare', { operationId: other.operationId, inputs: other.inputs });
    };
    await assert.rejects(h.controller.run(await h.request({ selection: other.selection })));
    assert.equal(pinFailed, true);
    const failed = await h.controller.status();
    const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
    assert.equal(retired.worksetId, null); assert.equal(retired.resumeOperationId, null);
    assert.equal(retired.state, 'blocked'); assert.equal(retired.operationId, other.operationId);
    assert.deepEqual(retired.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    const stored = await registryJSON(f), claim = await inspectProcessing(f.capability, other.operationId);
    const creates = h.creates, dispatches = h.dispatches.length;
    assert.deepEqual(await h.controller.run(await h.request({ selection: other.selection })), retired);
    assert.deepEqual(await registryJSON(f), stored);
    assert.deepEqual(await inspectProcessing(f.capability, other.operationId), claim);
    assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const client of ['codex', 'claude']) for (const blocker of ['claim', 'reservation']) {
  test(`${client} same-namespace ${blocker} appearing during startup prevents retired binding replacement`, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
    await assert.rejects(h.controller.run(await h.request()));
    const failed = await h.controller.status();
    const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
    const stored = await registryJSON(f), creates = h.creates, dispatches = h.dispatches.length;
    await h.controller.close();
    const opener = client === 'codex' ? 'openCodex' : 'openBridge', open = h.dependencies[opener];
    const reservation = path.join(f.collection.notes.writerStateDir, 'reinspection.json');
    const reservationBytes = canonicalJSON({ preview: { binding: { collectionId: 'other' } } }) + '\n';
    let opens = 0, claim;
    h.dependencies[opener] = async (...args) => {
      opens++;
      if (blocker === 'claim') claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
      else await fs.writeFile(reservation, reservationBytes, { mode: 0o600 });
      return open(...args);
    };
    h.controller = await h.open();
    h.script = async call => call('processing_pending', {});
    const request = await h.request();
    if (blocker === 'reservation') {
      await assert.rejects(h.controller.run(request), { code: 'PROCESSING_RECOVERY_REQUIRED' });
      assert.equal(await fs.readFile(reservation, 'utf8'), reservationBytes);
    } else {
      const result = await h.controller.run(request);
      assert.equal(result.state, 'blocked'); assert.equal(result.chatHash, retired.chatHash);
      assert.deepEqual(result.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
      assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
    }
    assert.equal(opens, 1); assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
    assert.deepEqual(await registryJSON(f), stored);
    // Resolve only this synthetic blocker, then retry the unchanged retired row.
    if (blocker === 'claim') await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
    else await fs.unlink(reservation);
    h.dependencies[opener] = open;
    await h.controller.close(); h.controller = await h.open();
    assert.equal((await h.controller.run(await h.request())).state, 'idle');
    assert.equal(h.dispatches.length, dispatches + 1);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

test('peer claim appearing during native startup is rechecked before reserving a replacement', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
  await assert.rejects(h.controller.run(await h.request()));
  const failed = await h.controller.status();
  await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const stored = await registryJSON(f), profileId = digest('synthetic-racing-peer');
  let opens = 0, claim;
  const peer = await openProcessingController({ ...f.options, client: 'codex' }, {
    ...h.dependencies, profileId,
    async openCodex() {
      opens++; claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
      return { profileId, async create() { assert.fail('late peer claim must block native creation'); }, async close() {} };
    }
  });
  t.after(() => peer.close());
  assert.deepEqual(await peer.collectionActivity(), []);
  await assert.rejects(peer.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null }),
    { code: 'PROCESSING_COLLECTION_BUSY' });
  assert.equal(opens, 1); assert.equal((await peer.status()).state, 'missing');
  assert.deepEqual(await registryJSON(f), stored);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
  assert.deepEqual(await peer.collectionActivity(), []);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('retired status retries one concurrent registry change and reads operation metadata once per attempt', async t => {
  const { f, h, claim } = await retiredTerminalClaim(t);
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const file = path.join(directory, (await fs.readdir(directory))[0]);
  let reads = 0;
  h.inspectOperation = async () => {
    if (++reads === 1) {
      const value = await registryJSON(f); value.generation++;
      await fs.writeFile(file, canonicalJSON(value) + '\n');
    }
    return claim;
  };
  const status = await h.controller.status();
  assert.equal(status.state, 'idle'); assert.equal(status.operationState, claim.state);
  assert.equal(reads, 2);
  assert.equal(status.chatHash, digest(await fs.readFile(file)));
  reads = 0; h.inspectOperation = async () => { reads++; return claim; };
  assert.deepEqual(await h.controller.status(), status);
  assert.equal(reads, 1); assert.equal(h.dispatches.length, 2);
});

test('retired run preserves collection-busy activity without a fallible second projection', async t => {
  const { f, h, claim } = await retiredTerminalClaim(t);
  const before = await h.controller.status(), stored = await registryJSON(f);
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const file = path.join(directory, (await fs.readdir(directory))[0]);
  const profileId = digest('competing synthetic profile');
  const peer = await openProcessingController({ ...f.options, client: 'codex' }, {
    ...h.dependencies, profileId,
    async openCodex() { return { profileId,
      async create() { throw new Error('synthetic creation outcome unknown'); }, async close() {} }; }
  });
  t.after(() => peer.close());
  await assert.rejects(peer.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null }));
  const activity = (await h.controller.collectionActivity()).filter(item => !item.own);
  assert.equal(activity.length, 1);
  let reads = 0;
  h.inspectOperation = async () => {
    if (++reads > 1) await fs.writeFile(file, 'synthetic concurrent invalid registry');
    return claim;
  };
  await assert.rejects(h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: before.chatHash }), error => {
    assert.equal(error.code, 'PROCESSING_COLLECTION_BUSY');
    assert.deepEqual(error.activity, activity);
    assert.equal(error.processingChat.state, 'blocked');
    assert.equal(error.processingChat.resumeSupported, false);
    return true;
  });
  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), stored);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal(h.dispatches.length, 2);
});

for (const invalid of ['corrupt', 'binding']) test(`retired status preserves ${invalid} archive failure without masking run refusal`, async t => {
  const { f, h, claim } = await retiredTerminalClaim(t);
  const registry = await registryJSON(f), namespaceHash = digest(canonicalJSON(registry.namespace));
  const file = path.join(f.collection.intakeStateDir, 'processing-chat-operation-history', namespaceHash, `${f.operationId}.json`);
  const before = await h.controller.status();
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (invalid === 'binding') value.bindingHash = digest('different synthetic collection');
  else value.operationId = randomUUID();
  await fs.writeFile(file, canonicalJSON(value) + '\n');
  const code = invalid === 'binding' ? 'PROCESSING_CHAT_BINDING_CHANGED' : 'INVALID_PROCESSING_CHAT_STATE';
  await assert.rejects(h.controller.status(), { code });
  await assert.rejects(h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: before.chatHash }), { code });
  // A separate earlier refusal must survive even if status projection is broken.
  await assert.rejects(h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: 'f'.repeat(64) }),
    { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  assert.deepEqual(await registryJSON(f), registry);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal(h.dispatches.length, 2);
});
