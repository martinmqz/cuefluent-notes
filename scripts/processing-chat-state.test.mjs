import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { createProcessingChatState, MAX_PROCESSING_CHAT_BINDINGS, MAX_PROCESSING_CHAT_RUNS } from './processing-chat-state.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';

async function fixture(t, client = 'codex') {
  const f = await storageFixture(t, { fullSetup: false });
  Object.assign(f, { client, hostId: digest('synthetic-host'), profileId: digest('synthetic-profile'), sessionId: randomUUID(),
    creationId: randomUUID(), requestHash: digest('create a processing-only chat'), verification: 'verified',
    reviewOutcome: 'saved', reviewState: 'completed', recoveryRequired: false, verifySessions: 0, verifyRuns: 0, verifyReviews: 0 });
  f.descriptor = { client, sessionId: f.sessionId, cwd: f.project, profileId: f.profileId,
    transport: client === 'codex' ? 'codex-app-server' : 'claude-cli', toolContractHash: digest('synthetic-tools'), desktopVerified: false };
  if (client === 'codex') f.descriptor.sourcePath = path.join(f.root, 'synthetic-native-session.jsonl');
  const unlocked = async () => {
    await assert.rejects(fs.lstat(path.join(f.collection.intakeStateDir, '.intake-lock')), { code: 'ENOENT' });
  };
  f.factory = {
    capability: f.capability, configPath: f.options.configPath, client, hostId: f.hostId, profileId: f.profileId,
    async verifySession(input) {
      await unlocked(); f.verifySessions++;
      return { client: input.client, hostId: input.hostId, profileId: input.profileId, sessionId: input.sessionId,
        descriptor: structuredClone(f.descriptor), sessionHash: digest(canonicalJSON(f.descriptor)), verification: f.verification,
        ...(f.sessionOverride ?? {}) };
    },
    async verifyRun(input) { await unlocked(); f.verifyRuns++; return f.rejectRun ? null : structuredClone(input); },
    async verifyReview(input) {
      await unlocked(); f.verifyReviews++;
      return { ...input, state: f.reviewState, recoveryRequired: f.recoveryRequired, outcome: f.reviewOutcome, ...(f.reviewOverride ?? {}) };
    }
  };
  f.registry = await createProcessingChatState(f.factory);
  f.reserve = () => f.registry.reserve({ expectedHash: null, requestId: f.creationId, requestHash: f.requestHash });
  f.bind = state => f.registry.bind({ expectedHash: state.hash, generation: state.generation, requestId: f.creationId, sessionId: f.sessionId });
  return f;
}
const beginArgs = state => ({ expectedHash: state.hash, generation: state.generation, requestId: randomUUID(), inputHash: digest('process this selected workset') });
const nativeRun = (units = [randomUUID()]) => ({ runId: randomUUID(), inputId: randomUUID(), unitIds: units });
const finishArgs = (state, request, native = nativeRun()) => ({ expectedHash: state.hash, generation: state.generation,
  requestId: request.requestId, outcome: 'idle', nativeRun: native });
const statePath = (f, state) => path.join(f.collection.intakeStateDir, 'processing-chats', `${state.namespaceHash.slice(0, 20)}.json`);
const writeFixtureState = async (f, state, mutate) => {
  const value = structuredClone(state.registry); mutate(value);
  const bytes = canonicalJSON(value) + '\n';
  await fs.writeFile(statePath(f, state), bytes, { mode: 0o600 });
  return digest(bytes);
};

test('offline abandonment checks the exact owner and hash before retiring an unknown creation', async t => {
  const f = await fixture(t), owner = { pid: 123, controllerId: randomUUID(), hostname: 'synthetic', boot: 'synthetic-boot', processStart: 'synthetic-start', platform: 'linux' };
  let gone = false, observed;
  const state = await createProcessingChatState({ ...f.factory, async verifyAbandon(value) { observed = value; return gone; } });
  const reserved = await state.reserve({ expectedHash: null, requestId: f.creationId, requestHash: f.requestHash, owner });
  const args = { expectedHash: reserved.hash, requestId: f.creationId, offline: true };
  await assert.rejects(state.abandon(args), { code: 'PROCESSING_CHAT_BUSY' });
  assert.deepEqual(observed, owner); assert.equal((await state.read()).hash, reserved.hash);
  gone = true;
  await assert.rejects(state.abandon({ ...args, requestId: randomUUID() }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
  const retired = await state.abandon(args);
  assert.equal(retired.registry.block.reason, 'run-abandoned');
  const archive = path.join(f.collection.intakeStateDir, 'processing-chat-abandoned', reserved.namespaceHash, `${f.creationId}.json`);
  assert.deepEqual(JSON.parse(await fs.readFile(archive, 'utf8')), reserved.registry);
  await assert.rejects(state.findRequest(f.creationId), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
  const next = await state.reserve({ expectedHash: retired.hash, requestId: randomUUID(), requestHash: digest('new explicit run'), owner });
  assert.equal(next.generation, reserved.generation + 1); assert.equal(next.registry.session, null);
  assert.equal(next.namespaceHash, reserved.namespaceHash);
});

test('chat registry reads without writes, reserves creation idempotently and reuses the exact bound chat', async t => {
  const f = await fixture(t), before = await fs.readdir(f.collection.intakeStateDir);
  assert.equal((await f.registry.read()).state, 'missing');
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
  const reserved = await f.reserve();
  assert.equal(reserved.action, 'create'); assert.equal(reserved.state, 'creating');
  assert.equal((await f.reserve()).action, 'reconcile-creation');
  await assert.rejects(f.registry.reserve({ expectedHash: reserved.hash, requestId: f.creationId, requestHash: digest('changed request') }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
  const bound = await f.bind(reserved);
  assert.equal(bound.state, 'idle'); assert.deepEqual(bound.registry.session.descriptor, f.descriptor);
  assert.equal(bound.registry.session.verification, 'verified');
  const reused = await f.registry.reserve({ expectedHash: bound.hash, requestId: randomUUID(), requestHash: digest('later request') });
  assert.equal(reused.action, 'reuse'); assert.equal(reused.hash, bound.hash);
  assert.equal(reused.registry.session.sessionId, f.sessionId);
  assert.equal(f.verifySessions, 1);
  assert.deepEqual(await fs.readdir(f.collection.rawDir), []);
  assert.deepEqual(await fs.readdir(f.collection.notes.writerStateDir), ['metadata-stages']);
});

test('unknown creation remains blocked without a fallback chat; exact native reconciliation can bind it', async t => {
  const f = await fixture(t), reserved = await f.reserve();
  const blocked = await f.registry.block({ expectedHash: reserved.hash, generation: reserved.generation, reason: 'creation-outcome-unknown' });
  const next = await f.registry.reserve({ expectedHash: blocked.hash, requestId: randomUUID(), requestHash: digest('another request') });
  assert.equal(next.action, 'reconcile-creation'); assert.equal(next.hash, blocked.hash);
  await assert.rejects(f.registry.bind({ expectedHash: blocked.hash, generation: 1, requestId: randomUUID(), sessionId: f.sessionId }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
  const bound = await f.bind(blocked);
  assert.equal(bound.registry.session.sessionId, f.sessionId); assert.equal(bound.state, 'idle');
});

test('native verification rejects wrong identity, unverified Codex candidates and oversized or mismatched descriptors', async t => {
  const f = await fixture(t), reserved = await f.reserve();
  for (const override of [{ profileId: digest('wrong') }, { hostId: digest('wrong') }, { client: 'claude' }, { sessionId: randomUUID() }]) {
    f.sessionOverride = override;
    await assert.rejects(f.bind(reserved), { code: 'PROCESSING_CHAT_NATIVE_UNVERIFIED' });
  }
  f.sessionOverride = { verification: 'reserved' };
  await assert.rejects(f.bind(reserved), { code: 'PROCESSING_CHAT_NATIVE_UNVERIFIED' });
  f.sessionOverride = { sessionHash: digest('not the descriptor') };
  await assert.rejects(f.bind(reserved), { code: 'INVALID_PROCESSING_CHAT_STATE' });
  const huge = { text: 'x'.repeat(9000) };
  f.sessionOverride = { descriptor: huge, sessionHash: digest(canonicalJSON(huge)) };
  await assert.rejects(f.bind(reserved), { code: 'INVALID_PROCESSING_CHAT_STATE' });
  assert.equal((await f.registry.read()).hash, reserved.hash);
});

test('execution has a durable busy gate, exact replay and compare-and-swap without redispatch', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), request = beginArgs(bound);
  const busy = await f.registry.begin(request);
  assert.equal(busy.action, 'dispatch'); assert.equal(busy.state, 'busy');
  assert.equal((await f.registry.begin(request)).action, 'reconcile-run');
  await assert.rejects(f.registry.begin({ ...request, inputHash: digest('changed') }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
  await assert.rejects(f.registry.begin({ ...beginArgs(bound), generation: 2 }), { code: 'PROCESSING_CHAT_GENERATION_CHANGED' });
  await assert.rejects(f.registry.begin(beginArgs(bound)), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  assert.equal((await f.registry.begin(beginArgs(busy))).action, 'inspect-existing');
  const finish = finishArgs(busy, request), done = await f.registry.finish(finish);
  assert.equal(done.state, 'idle'); assert.equal(done.registry.active, null); assert.equal(done.registry.runs.length, 1);
  assert.equal((await f.registry.finish(finish)).action, 'already-finished');
  assert.equal((await f.registry.begin(request)).action, 'already-finished');
  assert.equal(f.verifyRuns, 1);
  const nextRequest = beginArgs(done), next = await f.registry.begin(nextRequest);
  await assert.rejects(f.registry.finish(finishArgs(next, nextRequest, finish.nativeRun)), { code: 'PROCESSING_CHAT_NATIVE_CONFLICT' });
  assert.equal((await f.registry.read()).state, 'busy');
});

test('a change during native verification prevents stale dispatch without holding the intake lock', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), request = beginArgs(bound);
  const original = f.factory.verifySession;
  const racing = await createProcessingChatState({ ...f.factory, async verifySession(input) {
    const result = await original(input);
    await f.registry.block({ expectedHash: bound.hash, generation: 1, reason: 'host-unavailable' });
    return result;
  } });
  await assert.rejects(racing.begin(request), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  const current = await f.registry.read();
  assert.equal(current.state, 'blocked'); assert.equal(current.registry.active, null);
  assert.equal((await f.registry.reserve({ expectedHash: current.hash, requestId: randomUUID(), requestHash: digest('new') })).registry.session.sessionId, f.sessionId);
});

test('Claude first-dispatch reservation is not native proof; unknown outcomes retain the same UUID', async t => {
  const f = await fixture(t, 'claude'); f.verification = 'reserved';
  const bound = await f.bind(await f.reserve()), request = beginArgs(bound), busy = await f.registry.begin(request);
  assert.equal(bound.registry.session.verification, 'reserved');
  const finish = finishArgs(busy, request, nativeRun([]));
  await assert.rejects(f.registry.finish(finish), { code: 'PROCESSING_CHAT_NATIVE_UNVERIFIED' });
  const blocked = await f.registry.block({ expectedHash: busy.hash, generation: 1, reason: 'dispatch-outcome-unknown' });
  assert.equal((await f.registry.begin(request)).action, 'reconcile-run');
  assert.equal((await f.registry.begin(beginArgs(blocked))).action, 'inspect-existing');
  f.verification = 'verified';
  const done = await f.registry.finish({ ...finish, expectedHash: blocked.hash });
  assert.equal(done.registry.session.verification, 'verified'); assert.deepEqual(done.registry.runs[0].native.unitIds, []);
  assert.equal(done.registry.session.sessionId, f.sessionId);
  assert.equal((await f.registry.begin(beginArgs(done))).action, 'dispatch');
});

test('a native run failure or descriptor change cannot release the session or fabricate Codex unit IDs', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), request = beginArgs(bound), busy = await f.registry.begin(request);
  f.rejectRun = true;
  await assert.rejects(f.registry.finish(finishArgs(busy, request)), { code: 'PROCESSING_CHAT_NATIVE_UNVERIFIED' });
  f.rejectRun = false;
  await assert.rejects(f.registry.finish(finishArgs(busy, request, nativeRun([]))), { code: 'INVALID_WORKFLOW' });
  f.descriptor.cwd = path.join(f.root, 'elsewhere');
  await assert.rejects(f.registry.finish(finishArgs(busy, request)), { code: 'PROCESSING_CHAT_NATIVE_CONFLICT' });
  assert.equal((await f.registry.read()).hash, busy.hash);
});

test('caller mutation during verification cannot change the native run that is committed', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), request = beginArgs(bound), busy = await f.registry.begin(request);
  const finish = finishArgs(busy, request), original = structuredClone(finish.nativeRun);
  const registry = await createProcessingChatState({ ...f.factory, async verifyRun(input) {
    finish.nativeRun.unitIds[0] = randomUUID(); finish.nativeRun.inputId = randomUUID();
    return input;
  } });
  const complete = await registry.finish(finish);
  assert.deepEqual(complete.registry.runs[0].native, original);
});

test('awaiting review cannot begin another run until the exact authoritative operation is completed', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), operationId = randomUUID(), request = { ...beginArgs(bound), operationId };
  const busy = await f.registry.begin(request), review = await f.registry.finish({ ...finishArgs(busy, request), outcome: 'awaiting-review' });
  assert.equal(review.state, 'awaiting-review');
  assert.equal((await f.registry.begin(beginArgs(review))).action, 'review-existing');
  const ack = { expectedHash: review.hash, generation: 1, requestId: request.requestId, operationId };
  await assert.rejects(f.registry.acknowledgeReview({ ...ack, operationId: randomUUID() }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
  f.reviewState = 'awaiting-review';
  await assert.rejects(f.registry.acknowledgeReview(ack), { code: 'PROCESSING_CHAT_REVIEW_UNRESOLVED' });
  f.reviewState = 'completed'; f.recoveryRequired = true;
  await assert.rejects(f.registry.acknowledgeReview(ack), { code: 'PROCESSING_CHAT_REVIEW_UNRESOLVED' });
  f.recoveryRequired = false; f.reviewOverride = { collectionId: 'unrelated' };
  await assert.rejects(f.registry.acknowledgeReview(ack), { code: 'PROCESSING_CHAT_REVIEW_UNRESOLVED' });
  f.reviewOverride = {}; f.reviewOutcome = 'cancelled';
  const done = await f.registry.acknowledgeReview(ack);
  assert.equal(done.state, 'idle'); assert.equal(done.registry.runs[0].reviewResolved, true);
  assert.equal((await f.registry.acknowledgeReview(ack)).action, 'already-acknowledged');
  assert.equal((await f.registry.begin(beginArgs(done))).action, 'dispatch');
});

test('review publication preflight runs only after completion proof and preserves state on refusal', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), operationId = randomUUID(), request = { ...beginArgs(bound), operationId };
  const busy = await f.registry.begin(request), review = await f.registry.finish({ ...finishArgs(busy, request), outcome: 'awaiting-review' });
  const ack = { expectedHash: review.hash, generation: 1, requestId: request.requestId, operationId };
  let calls = 0;
  const hooks = { beforePublish() { calls++; throw Object.assign(new Error('synthetic preflight refusal'), { code: 'SYNTHETIC_PREFLIGHT_REFUSED' }); } };
  f.reviewState = 'awaiting-review';
  await assert.rejects(f.registry.acknowledgeReview(ack, hooks), { code: 'PROCESSING_CHAT_REVIEW_UNRESOLVED' });
  assert.equal(calls, 0);
  f.reviewState = 'completed';
  await assert.rejects(f.registry.acknowledgeReview({ ...ack, expectedHash: digest('stale') }, hooks), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  assert.equal(calls, 0);
  await assert.rejects(f.registry.acknowledgeReview(ack, hooks), { code: 'SYNTHETIC_PREFLIGHT_REFUSED' });
  assert.equal(calls, 1);
  const preserved = await f.registry.read();
  assert.equal(preserved.hash, review.hash); assert.deepEqual(preserved.registry, review.registry);
  assert.equal((await f.registry.acknowledgeReview(ack)).state, 'idle');
});

test('review handoff must refer to the operation bound by the original request', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), operationId = randomUUID();
  const request = { ...beginArgs(bound), operationId }, busy = await f.registry.begin(request);
  await assert.rejects(f.registry.finish({ ...finishArgs(busy, request), outcome: 'awaiting-review', operationId: randomUUID() }), { code: 'PROCESSING_CHAT_REQUEST_CONFLICT' });
  assert.equal((await f.registry.read()).hash, busy.hash);
});

test('serialized proof flags cannot replace trusted callbacks, and malformed proof leaves reservation intact', async t => {
  const f = await fixture(t), reserved = await f.reserve();
  await assert.rejects(createProcessingChatState({ ...f.factory, verifySession: { verified: true } }), { code: 'PROCESSING_CHAT_VERIFIER_REQUIRED' });
  await assert.rejects(f.registry.bind({ expectedHash: reserved.hash, generation: 1, requestId: f.creationId, sessionId: f.sessionId, verified: true }), { code: 'INVALID_WORKFLOW' });
  const noProof = await createProcessingChatState({ ...f.factory, verifySession: async () => undefined });
  await assert.rejects(noProof.bind({ expectedHash: reserved.hash, generation: 1, requestId: f.creationId, sessionId: f.sessionId }), { code: 'PROCESSING_CHAT_NATIVE_UNVERIFIED' });
  assert.equal((await f.registry.read()).hash, reserved.hash);
});

test('registry caps history and bindings with actionable errors and never prunes or silently forks', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve());
  await writeFixtureState(f, bound, value => {
    value.runs = Array.from({ length: MAX_PROCESSING_CHAT_RUNS }, () => ({ request: { requestId: randomUUID(), inputHash: digest('input'), operationId: null, worksetId: null, selection: null },
      native: nativeRun(), outcome: 'idle', reviewOperationId: null, reviewResolved: false }));
  });
  const full = await f.registry.read();
  await assert.rejects(f.registry.begin(beginArgs(full)), { code: 'PROCESSING_CHAT_HISTORY_FULL' });
  assert.equal((await f.registry.read()).hash, full.hash);
  const rolled = await f.registry.rollover({ expectedHash: full.hash });
  assert.equal(rolled.registry.session.sessionId, f.sessionId); assert.equal(rolled.registry.runs.length, 0);
  assert.equal(rolled.generation, 2);
  const old = full.registry.runs[0];
  assert.deepEqual(await f.registry.findRequest(old.request.requestId), old);
  assert.equal((await f.registry.begin({ ...beginArgs(rolled), ...old.request })).action, 'already-finished');
  const nextRequest = beginArgs(rolled), next = await f.registry.begin(nextRequest);
  assert.equal(next.action, 'dispatch');
  await assert.rejects(f.registry.finish(finishArgs(next, nextRequest, old.native)), { code: 'PROCESSING_CHAT_NATIVE_CONFLICT' });
  const folder = path.dirname(statePath(f, full));
  for (let i = 0; i < MAX_PROCESSING_CHAT_BINDINGS - 1; i++) await fs.writeFile(path.join(folder, `${digest(String(i)).slice(0, 20)}.json`), '{}\n', { mode: 0o600 });
  const other = await createProcessingChatState({ ...f.factory, profileId: digest('other-profile') });
  await assert.rejects(other.reserve({ expectedHash: null, requestId: randomUUID(), requestHash: digest('creation') }), { code: 'PROCESSING_CHAT_BINDINGS_FULL' });
  assert.equal((await fs.readdir(folder)).length, MAX_PROCESSING_CHAT_BINDINGS);
});

test('explicit policy reauthorization pins old and new policy without changing session, active operation or approval hashes', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), operationId = randomUUID();
  const request = { ...beginArgs(bound), operationId }, busy = await f.registry.begin(request);
  f.config.routes[0].processing = { mode: 'prompted' };
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  const fresh = await createProcessingChatState({ ...f.factory, capability });
  await assert.rejects(fresh.reauthorize({ expectedHash: busy.hash, previousPolicyHash: digest('wrong old policy') }), { code: 'PROCESSING_CHAT_POLICY_CHANGED' });
  const changed = await fresh.reauthorize({ expectedHash: busy.hash, previousPolicyHash: busy.policyHash });
  assert.equal(changed.policyHash, digest(bytes)); assert.equal(changed.generation, busy.generation + 1);
  assert.deepEqual(changed.registry.active, busy.registry.active); assert.deepEqual(changed.registry.session, busy.registry.session);
  assert.equal(changed.state, 'busy'); assert.deepEqual(changed.registry.runs, busy.registry.runs);
  await assert.rejects(fresh.rollover({ expectedHash: changed.hash }), { code: 'PROCESSING_CHAT_BUSY' });
});

test('archived operation proof is bounded, namespace-bound and refuses missing or mismatched history', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), operationId = randomUUID();
  const request = { ...beginArgs(bound), operationId }, busy = await f.registry.begin(request);
  const finished = await f.registry.finish(finishArgs(busy, request));
  const rolled = await f.registry.rollover({ expectedHash: finished.hash });
  const other = await createProcessingChatState({ ...f.factory, profileId: digest('other-profile') });
  assert.equal(await other.canResumeOperation(operationId), true, 'lookup uses the owning registry namespace');
  const index = path.join(f.collection.intakeStateDir, 'processing-chat-operation-history', rolled.namespaceHash, `${operationId}.json`);
  const archive = path.join(f.collection.intakeStateDir, 'processing-chat-history', rolled.namespaceHash, `${request.requestId}.json`);
  const indexBytes = await fs.readFile(index), archiveBytes = await fs.readFile(archive);
  await fs.rm(archive);
  await assert.rejects(other.canResumeOperation(operationId), { code: 'INVALID_PROCESSING_CHAT_STATE' });
  await assert.rejects(other.hasTerminalOperationOwner(operationId), { code: 'INVALID_PROCESSING_CHAT_STATE' });
  await fs.writeFile(archive, archiveBytes, { mode: 0o600 });
  const wrong = JSON.parse(indexBytes); wrong.operationId = randomUUID();
  await fs.writeFile(index, canonicalJSON(wrong) + '\n');
  await assert.rejects(other.canResumeOperation(operationId), { code: 'INVALID_PROCESSING_CHAT_STATE' });
  await assert.rejects(other.hasTerminalOperationOwner(operationId), { code: 'INVALID_PROCESSING_CHAT_STATE' });
  wrong.operationId = operationId; wrong.bindingHash = digest('other-collection');
  await fs.writeFile(index, canonicalJSON(wrong) + '\n');
  await assert.rejects(other.canResumeOperation(operationId), { code: 'PROCESSING_CHAT_BINDING_CHANGED' });
  await assert.rejects(other.hasTerminalOperationOwner(operationId), { code: 'PROCESSING_CHAT_BINDING_CHANGED' });
  await fs.writeFile(index, indexBytes);
  const another = { ...beginArgs(rolled), operationId }, active = await f.registry.begin(another);
  assert.equal(await other.canResumeOperation(operationId), false, 'archived proof cannot override current execution');
  assert.equal(await other.hasTerminalOperationOwner(operationId), true, 'current execution does not erase archived terminal proof');
  const again = await f.registry.finish(finishArgs(active, another));
  await f.registry.rollover({ expectedHash: again.hash });
  assert.deepEqual(await fs.readFile(index), indexBytes, 'terminal retries preserve the first exact immutable proof');
  assert.equal(await other.canResumeOperation(operationId), true);
  assert.equal(await other.canResumeOperation(randomUUID()), false);
});

test('only an internal proven pre-dispatch abort releases busy and an exact retry needs fresh CAS', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), request = beginArgs(bound), busy = await f.registry.begin(request);
  const args = { expectedHash: busy.hash, generation: busy.generation, requestId: request.requestId };
  await assert.rejects(f.registry.abort(args), { code: 'PROCESSING_CHAT_ABORT_UNPROVEN' });
  const trusted = await createProcessingChatState({ ...f.factory, verifyAbort: async target => target.requestId === request.requestId });
  const idle = await trusted.abort(args);
  assert.equal(idle.state, 'idle'); assert.equal(idle.registry.active, null); assert.equal(idle.registry.runs.length, 0);
  assert.deepEqual(idle.registry.session, busy.registry.session);
  await assert.rejects(trusted.begin(request), { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  assert.equal((await trusted.begin({ ...request, expectedHash: idle.hash })).action, 'dispatch');
});

test('changed policy, namespace and unsupported persisted state fail without replacing stored sessions', async t => {
  const f = await fixture(t), reserved = await f.reserve();
  const peer = await createProcessingChatState({ ...f.factory, profileId: digest('other-synthetic-profile') });
  const original = await fs.readFile(statePath(f, reserved));
  for (const mutate of [value => { value.version = 2; }, value => { value.state = 'unknown'; }, value => { value.namespace.client = 'claude'; }]) {
    await fs.writeFile(statePath(f, reserved), original);
    await writeFixtureState(f, reserved, mutate);
    await assert.rejects(f.registry.read(), error => ['INVALID_PROCESSING_CHAT_STATE', 'PROCESSING_CHAT_BINDING_CHANGED'].includes(error.code));
    await assert.rejects(peer.collectionActivity(), error => ['INVALID_PROCESSING_CHAT_STATE', 'PROCESSING_CHAT_BINDING_CHANGED'].includes(error.code));
  }
  await fs.writeFile(statePath(f, reserved), original);
  f.config.routes[0].processing = { mode: 'prompted' };
  const config = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, config);
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(config) });
  const changed = await createProcessingChatState({ ...f.factory, capability });
  assert.equal((await changed.read()).policyState, 'changed');
  await assert.rejects(changed.reserve({ expectedHash: reserved.hash, requestId: randomUUID(), requestHash: digest('new') }), { code: 'PROCESSING_CHAT_POLICY_CHANGED' });
  assert.deepEqual(await fs.readFile(statePath(f, reserved)), original);
});

test('peer execution gates resume independently of terminal operation ownership', async t => {
  const f = await fixture(t), bound = await f.bind(await f.reserve()), operationId = randomUUID();
  const request = { ...beginArgs(bound), operationId }, busy = await f.registry.begin(request);
  await f.registry.finish(finishArgs(busy, request));
  const peer = await createProcessingChatState({ ...f.factory, profileId: digest('other-synthetic-profile') });
  const reserved = await peer.reserve({ expectedHash: null, requestId: randomUUID(), requestHash: digest('peer creation') });
  const blocked = await peer.block({ expectedHash: reserved.hash, generation: reserved.generation, reason: 'creation-not-dispatched' });
  for (const [reason, allowed] of [['creation-not-dispatched', true], ['run-abandoned', true], ['creation-outcome-unknown', false], ['host-unavailable', false]]) {
    await writeFixtureState(f, blocked, value => { value.block.reason = reason; });
    assert.equal(await f.registry.canResumeOperation(operationId), allowed, reason);
    assert.equal(await f.registry.hasTerminalOperationOwner(operationId), true, reason);
    assert.equal((await f.registry.collectionActivity()).some(item => !item.own), !allowed, reason);
    assert.equal(await f.registry.canResumeOperation(randomUUID()), false, 'a harmless peer cannot fabricate ownership');
    assert.equal(await f.registry.hasTerminalOperationOwner(randomUUID()), false, 'peer state cannot fabricate terminal proof');
  }
});
