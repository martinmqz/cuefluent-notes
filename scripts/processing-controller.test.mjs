import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture } from './test-support/processing-fixture.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { completeProcessing, inspectProcessing } from './processing.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';

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
