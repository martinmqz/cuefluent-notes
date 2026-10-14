import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowConfigPath, readWorkflowSnapshot } from './workflow-config.mjs';
import { verifyWorkflowStorage, assertWorkflowStorage } from './workflow-storage.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { openWorkflowIntake, withIntakeLock, intakeSnapshot } from './intake-io.mjs';
import { readSelection, selectionPath } from './intake-store.mjs';
import { processingSourceDirectory, processingSourcePath, registrationPath, readRegistration, assertRegistrationGrant } from './collection-ingress.mjs';
import { collectionGrantHash } from './collection-grant.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { recordProcessingControlDispatch, createProcessingControlResolver } from './processing-control-receipts.mjs';
import { resolveProcessingInvocation, isProcessingInvocation, isPendingProcessingInvocation } from './processing-native-invocation.mjs';
import { inspectProcessingShortcut, selectProcessingShortcut, cancelProcessingShortcut, beginProcessingShortcutControl, readProcessingShortcutControl, finishProcessingShortcutControl } from './processing-shortcuts.mjs';
import { inspectProcessing } from './processing.mjs';
import { stablePendingCollectionProcessing } from './processing-collection.mjs';
import { runProcessingControlServer, processingControlStatusView } from './processing-control-server.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { assertClaudeHostAuthentication } from './processing-claude-settings.mjs';
import { reviewProcessingProposal } from './processing-host-review.mjs';
import { canonicalJSON, digest, digestId, choice, CLIENTS, fail, safeErrorCode } from './workflow-values.mjs';
import { isMain } from './file-io.mjs';

const skillPath = fileURLToPath(new URL('../SKILL.md', import.meta.url));
const diagnostic = Object.freeze({ CREATION_NOT_DISPATCHED: 'PROCESSING_CLIENT_UNAVAILABLE', RUN_ABANDONED: 'PROCESSING_CHAT_OUTCOME_UNKNOWN', CREATION_OUTCOME_UNKNOWN: 'PROCESSING_CHAT_OUTCOME_UNKNOWN',
  DISPATCH_OUTCOME_UNKNOWN: 'PROCESSING_CHAT_OUTCOME_UNKNOWN', HOST_UNAVAILABLE: 'PROCESSING_CHAT_HOST_UNAVAILABLE',
  SESSION_UNAVAILABLE: 'PROCESSING_CHAT_SESSION_UNAVAILABLE', BINDING_CONFLICT: 'PROCESSING_CHAT_BINDING_CHANGED',
  PROCESSING_CHAT_RECONCILIATION_UNPROVEN: 'PROCESSING_CHAT_OUTCOME_UNKNOWN',
  OPERATION_OUTCOME_UNKNOWN: 'PROCESSING_OPERATION_OUTCOME_UNKNOWN', WORKSET_OUTCOME_UNKNOWN: 'WORKSET_OUTCOME_UNKNOWN',
  PROCESSING_COLLECTION_BUSY: 'PROCESSING_COLLECTION_BUSY',
  PROCESSING_RECOVERY_REQUIRED: 'PROCESSING_RECOVERY_REQUIRED',
  PROCESSING_EXCLUSION_UNVERIFIED: 'PROCESSING_EXCLUSION_UNVERIFIED' });
const unfinished = value => value.state === 'idle' && value.operationState !== undefined &&
  (value.operationState !== 'completed' || value.recoveryRequired);
const statusDetailOf = value => unfinished(value) ? 'unfinished' : ({
  missing: 'missing', creating: 'preparing', busy: 'processing', idle: 'inactive',
  'awaiting-review': 'draft-ready', blocked: 'blocked', completed: 'completed',
})[value.state];
const viewOf = value => ({ status: value.state, statusDetail: statusDetailOf(value), requestId: value.requestId,
  chat: value.chat, nextAction: value.state === 'awaiting-review' ? 'review' : value.state === 'busy' ? 'wait'
    : value.state === 'blocked' || value.recoveryRequired || (unfinished(value) && value.resumeSupported === false) ||
      ['unknown', 'missing', 'conflicted', 'blocked', 'recovery-required', 'awaiting-review'].includes(value.operationState) ? 'inspect'
      : unfinished(value) || ['failed', 'interrupted'].includes(value.nativeStatus) ? 'resume' : 'none', diagnostics: [...new Set([
      ...(value.diagnostics ?? []).map(code => diagnostic[code] ?? 'PROCESSING_CHAT_BLOCKED'),
      ...(value.policyState === 'changed' ? ['WORKFLOW_POLICY_CHANGED'] : []),
      ...(value.nativeStatus === 'failed' ? ['PROCESSING_CLIENT_FAILED'] : value.nativeStatus === 'interrupted' ? ['PROCESSING_CLIENT_INTERRUPTED'] : []),
    ])] });
const alreadyProcessing = view => ({ ...view,
  ...(['creating', 'busy'].includes(view.status) ? { statusDetail: 'already-processing' } : {}),
  diagnostics: [...new Set(['PROCESSING_CHAT_BUSY', ...view.diagnostics])].slice(0, 8) });
// Native call identity, not a model-chosen UUID, owns dispatch idempotence. A
// redelivery of the same call replays; a new human invocation remains new work.
function nativeRequestId(source, client) {
  return digestId('cuefluent-processing-dispatch-v1', { client,
    sessionId: source.selection.sessionId, callId: source.callId }, { dispatchBits: true });
}
const derivedRequestId = (id, index) => index ? digestId('cuefluent-shortcut-turn-v1', { id, index }) : id;
const progressKey = shortcut => canonicalJSON({ counts: shortcut.counts,
  worksets: shortcut.worksets.map(item => item.worksetHash),
  operations: shortcut.operations.map(item => [item.operationId, item.claimHash, item.outcome]) });
const authorizedReviews = inventory => inventory.operations.filter(item => item.state === 'awaiting-review' &&
  !item.recoveryRequired && item.scopeMatch === 'full');
const selectionConflicts = new Set(['WORKFLOW_POLICY_CHANGED', 'PROCESSING_HEAD_CHANGED', 'CAPTURE_PRUNED',
  'PROCESSING_SELECTION_CHANGED', 'PROCESSING_INPUT_CLAIMED', 'PROCESSING_INPUT_CHANGED',
  'PROCESSING_INPUT_ALREADY_HANDLED', 'PROCESSING_SHORTCUT_CAPACITY']);

function blockedInventory(view, blockers) {
  if (blockers.length && blockers.every(code => selectionConflicts.has(code))) {
    return { ...view, status: 'blocked', statusDetail: blockers.includes('PROCESSING_SHORTCUT_CAPACITY') ? 'selection-limit' : 'blocked',
      nextAction: 'cancel', diagnostics: [...new Set(blockers.map(code => ['WORKFLOW_POLICY_CHANGED', 'PROCESSING_SHORTCUT_CAPACITY'].includes(code) ? code : 'PROCESSING_SELECTION_CHANGED'))] };
  }
  const recovery = blockers.some(code => ['PROCESSING_RECOVERY_REQUIRED', 'WRITER_RECOVERY_REQUIRED', 'INTAKE_RECOVERY_REQUIRED', 'PRUNE_RECOVERY_REQUIRED'].includes(code));
  return { ...view, status: 'blocked', statusDetail: 'blocked', nextAction: 'inspect',
    diagnostics: recovery ? ['PROCESSING_RECOVERY_REQUIRED'] : blockers.includes('PROCESSING_OPERATION_OWNER_UNVERIFIED') ? ['PROCESSING_OPERATION_OWNER_UNVERIFIED'] : ['PROCESSING_CONTROL_FAILED'] };
}

function shortcutView(native, shortcut) {
  const view = viewOf(native);
  if (shortcut.scope) view.scope = shortcut.scope.kind;
  if (shortcut.counts) view.progress = { ...shortcut.counts, incomplete: shortcut.incomplete };
  if (['busy', 'creating', 'blocked'].includes(view.status)) return view;
  if (shortcut.reviews?.length) return { ...view, status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' };
  if (shortcut.blockers?.length) return blockedInventory(view, shortcut.blockers);
  if (shortcut.policyState === 'changed' && shortcut.phase !== 'cancelled' &&
      (shortcut.phase === 'discovering' || shortcut.counts?.unattempted || shortcut.counts?.unfinishedOperations || shortcut.counts?.unavailable)) {
    return { ...view, status: 'blocked', statusDetail: 'blocked', nextAction: 'cancel', diagnostics: ['WORKFLOW_POLICY_CHANGED'] };
  }
  if (shortcut.phase === 'cancelled') return { ...view, status: 'idle', statusDetail: 'cancelled', nextAction: 'none' };
  if (view.nextAction === 'inspect' && unfinished(native)) return view;
  if (shortcut.phase === 'discovering') return { ...view, status: native.state === 'missing' ? 'missing' : 'idle', statusDetail: 'discovery', nextAction: 'resume' };
  if (shortcut.phase === 'cancelling') return { ...view, status: 'blocked', statusDetail: 'blocked', nextAction: 'cancel', diagnostics: ['PROCESSING_CANCELLATION_PENDING'] };
  if (shortcut.reason === 'nothing-to-resume') return { ...view, status: native.state === 'missing' ? 'missing' : 'idle', statusDetail: 'nothing-to-resume', nextAction: 'none' };
  if (shortcut.counts?.unavailable && !shortcut.nextRun && !shortcut.continuationNeeded) return { ...view, status: 'blocked', statusDetail: 'blocked', nextAction: 'cancel', diagnostics: ['PROCESSING_SELECTION_CHANGED'] };
  if (shortcut.counts?.unfinishedOperations) return { ...view, status: 'idle', statusDetail: 'unfinished', nextAction: 'resume' };
  if (shortcut.nextRun || shortcut.continuationNeeded) return { ...view, status: 'idle', statusDetail: 'continuation', nextAction: 'resume' };
  if (shortcut.counts?.cancelled) return { ...view, status: 'idle', statusDetail: 'cancelled', nextAction: 'process' };
  if (shortcut.phase === 'ready') return { ...view, status: native.state === 'missing' ? 'missing' : 'idle', statusDetail: shortcut.counts.selected ? 'selection-complete' : shortcut.incomplete ? 'discovery' : 'nothing-pending', nextAction: shortcut.incomplete ? 'process' : 'none' };
  return view;
}

// One pure public projection. The transport validates its bounded schema before
// publication; inventory remains advisory and cannot grant execution authority.
export function processingStatusView(native, shortcut, { inventory, sequence = false } = {}) {
  let view = shortcutView(native, shortcut);
  if (inventory) {
    const reviews = authorizedReviews(inventory);
    view.inventory = { pending: inventory.counts.unclaimedRevisions, claimed: inventory.counts.claimedRevisions,
      blockedByClaim: inventory.counts.blockedByClaimRevisions, inspected: inventory.counts.inspectedHeads,
      handled: inventory.counts.handledRevisions, incomplete: inventory.incomplete,
      unfinishedOperations: inventory.operations.length, awaitingReview: reviews.length, sourceCompleteness: inventory.sourceCompleteness };
    if (!['creating', 'busy', 'blocked'].includes(view.status)) {
      if (inventory.blockers.length) view = blockedInventory(view, inventory.blockers);
      else if (reviews.length) view = { ...view, status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' };
      else if (inventory.operations.some(item => item.scopeMatch !== 'full')) view = { ...view, status: 'blocked', statusDetail: 'blocked', nextAction: 'inspect', diagnostics: ['PROCESSING_SELECTION_CHANGED'] };
      else if (['missing', 'idle', 'completed'].includes(view.status) && inventory.operations.length && view.nextAction === 'none') {
        view = { ...view, status: 'idle', statusDetail: 'unfinished', nextAction: 'resume' };
      } else if (['missing', 'idle'].includes(view.status) && view.nextAction === 'none' && (!shortcut.requestId || inventory.counts.unclaimedRevisions || inventory.incomplete)) {
        view = { ...view, statusDetail: inventory.incomplete ? 'inventory-incomplete' : inventory.counts.unclaimedRevisions ? 'pending' : 'nothing-pending', nextAction: inventory.counts.unclaimedRevisions || inventory.incomplete ? 'process' : 'none' };
      }
    }
  }
  if (native.remainingRuns === 0 && view.nextAction === 'resume') return { ...view, status: 'blocked', statusDetail: 'blocked', nextAction: 'inspect', diagnostics: ['PROCESSING_CHAT_HISTORY_FULL'] };
  if (sequence && !['creating', 'busy', 'blocked', 'awaiting-review'].includes(view.status)) return { ...view, status: 'busy', statusDetail: 'processing', nextAction: 'wait' };
  return view;
}

// Exact metadata locations only. Presence is a candidate hint, never a source
// binding; guarded reads and native verification still own all authority.
async function sourcePresence(collection, context, policyHash, capability = null) {
  const { client, sessionId } = context;
  const identity = { client, sessionId };
  // Explicit selection uses the same guarded metadata reads as native resolution;
  // implicit discovery alone needs cheap hints to skip unprepared collections.
  if (capability) {
    if (client !== 'codex') return 'binding'; // Claude retains its registered-source fallback.
    const store = await openWorkflowIntake(capability);
    if ((await readSelection(store, identity)).state ||
        (await intakeSnapshot(store, 'state', processingSourcePath(context, policyHash), { maxBytes: 16384 })).bytes !== null) return 'binding';
    return 'registration'; // The later exact guarded read distinguishes absence.
  }
  const probes = [client === 'codex' ? selectionPath(identity) : path.posix.dirname(selectionPath(identity)),
    client === 'codex' ? processingSourcePath(context, policyHash) : processingSourceDirectory(client)];
  for (const probe of probes) {
    try { await fs.lstat(path.join(collection.intakeStateDir, probe)); return 'binding'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (client === 'codex') {
    try { await fs.lstat(path.join(collection.intakeStateDir, registrationPath(context))); return 'registration'; }
    catch (error) { if (error.code !== 'ENOENT') return 'registration'; }
  }
  return 'missing';
}

/** Native MCP front door. Its background tasks are finite explicit requests,
 * never scheduled/automatic work. Exit waits for owned tasks; killed hosts leave
 * the controller's durable unknown outcome, not a replacement chat.
 */
export async function runProcessingMcp({ client, configPath, input, output, env = process.env } = {}, dependencies = {}) {
  choice(client, CLIENTS);
  const jobs = new Map(), owners = new WeakMap(), committedReviews = new WeakMap(), replayed = new WeakMap(), controls = new WeakMap();
  const openController = dependencies.openController ?? openProcessingController;
  const resolveInvocation = dependencies.resolveInvocation ?? resolveProcessingInvocation;
  async function resolveSource(context, invocation, { signal, requireCompleted } = {}) {
    const selectedConfig = configPath ?? await workflowConfigPath();
    const snapshot = await readWorkflowSnapshot(selectedConfig);
    if (!snapshot.config) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    const requested = invocation.arguments.collectionId;
    if (snapshot.config.collections.length > 64) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    const matches = [], registrationCollections = [];
    let failedBinding = false;
    for (const collection of snapshot.config.collections) {
      if (requested !== undefined && collection.id !== requested) continue;
      if (requested === undefined && !snapshot.config.routes.some(route => route.collectionId === collection.id && route.clients.includes(client))) continue;
      const options = { configPath: selectedConfig, collectionId: collection.id, expectedConfigHash: snapshot.hash };
      let capability = requested === undefined ? null : await verifyWorkflowStorage(options);
      const presence = await withStorageProbes(() => sourcePresence(collection, context, snapshot.hash, capability));
      if (presence === 'registration') { registrationCollections.push(collection); continue; }
      if (requested === undefined && presence === 'missing') continue;
      capability ??= await verifyWorkflowStorage(options);
      let source;
      try { source = await withStorageProbes(() => resolveInvocation(capability, context, invocation, { skillPath, signal, requireCompleted })); }
      catch (error) {
        if (requested === undefined && error.code === 'PROCESSING_CONTROL_SOURCE_UNVERIFIED') { failedBinding = true; continue; }
        throw error;
      }
      if (!isProcessingInvocation(source) && !isPendingProcessingInvocation(source) && !dependencies.resolveInvocation) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      const resolved = Object.freeze({ ...source, collectionId: collection.id });
      owners.set(resolved, { capability, options }); matches.push(resolved);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 || failedBinding) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    // Diagnose only after all real bindings miss. Pending-only metadata cannot
    // prevent a valid match or supply an invocation, even if its JSON is broken.
    const registrationUnverified = await withStorageProbes(async () => {
      let present = false;
      for (const collection of registrationCollections) {
        const capability = await verifyWorkflowStorage({ configPath: selectedConfig, collectionId: collection.id, expectedConfigHash: snapshot.hash });
        const store = await openWorkflowIntake(capability);
        const { registration: record } = await readRegistration(store, context, { mismatchCode: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' });
        if (record === null) continue;
        if (record.collectionId !== collection.id) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
        const route = await resolveWorkflowRoute(snapshot.config, record);
        // A retired collection registration cannot establish a processing-only
        // binding. Reviewing its grant cannot restore intentionally absent consent.
        if (!route.intended?.collect) continue;
        if (route.collection.id !== collection.id) fail('REGISTRATION_REQUIRES_REVIEW');
        await assertRegistrationGrant(store, record, null, await collectionGrantHash(snapshot.config, route.route.id, record), route);
        present = true;
      }
      return present;
    });
    fail(registrationUnverified ? 'PROCESSING_CONTROL_REGISTRATION_UNVERIFIED' : 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  }
  function selected(source) {
    const owner = owners.get(source);
    if (!owner) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    return owner;
  }
  const keyFor = options => digest(canonicalJSON({ ...options, client }));
  async function replayControl(source) {
    if (!source.nativeSkill || !source.unitId || source.captureActive === false) return null;
    const { capability } = selected(source);
    // A disabled collection has no new parent receipt to replay or rewrite.
    // The controller still deduplicates its request under processing authority.
    try { await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'collect')); }
    catch (error) { if (error.code === 'WORKFLOW_NOT_AUTHORIZED') return null; throw error; }
    const authorize = async () => { await assertWorkflowStorage(capability, source.selection, 'collect'); return true; };
    const receipt = await withStorageProbes(async () => {
      const store = await openWorkflowIntake(capability, source.selection, 'collect');
      return withIntakeLock(store, async tx => {
        const selected = await readSelection(store, { client, sessionId: source.selection.sessionId });
        if (selected.hash !== source.selectionHash) return null;
        return createProcessingControlResolver(tx, { state: selected.state, selectionHash: selected.hash, authorize })({
          client, sessionId: source.selection.sessionId, unitId: source.unitId,
          callId: source.callId, tool: source.tool, argsHash: source.argsHash });
      });
    });
    if (!receipt?.response) return null;
    if (receipt.response.collectionId !== source.collectionId) fail('PROCESSING_CONTROL_RECEIPT_CONFLICT');
    replayed.set(source, receipt);
    return receipt.response;
  }
  async function acknowledgeFinishedReview(controller, capability, status, { persist = true } = {}) {
    if (status.state !== 'awaiting-review') return status;
    const operation = await withStorageProbes(() => inspectProcessing(capability, status.operationId));
    if (operation.state !== 'completed' || !operation.outcome || operation.recoveryRequired) return status;
    return persist ? controller.finishReview({ expectedChatHash: status.chatHash, requestId: status.requestId, operationId: status.operationId })
      : { ...status, state: 'idle', operationState: 'completed', recoveryRequired: false };
  }
  async function getStatus({ source }) {
    const { options, capability } = selected(source), key = keyFor(options);
    const replay = await replayControl(source); if (replay) return replay;
    const job = jobs.get(key), controller = job?.controller ?? await openController({ ...options, client }, { env });
    try {
      let native = await acknowledgeFinishedReview(controller, capability, await controller.status({ selection: source.selection }), { persist: false });
      const peer = (await controller.collectionActivity()).find(item => !item.own);
      if (peer && !['creating', 'busy', 'blocked'].includes(native.state)) native = {
        state: peer.state, requestId: peer.requestId,
        chat: peer.sessionId ? { client: peer.client, sessionId: peer.sessionId } : null,
        diagnostics: ['PROCESSING_COLLECTION_BUSY'] };
      const shortcut = await withStorageProbes(() => inspectProcessingShortcut(capability, { selection: source.selection }));
      let inventory;
      try { inventory = await withStorageProbes(() => stablePendingCollectionProcessing(capability, { selection: source.selection })); }
      catch (error) {
        if (error.code !== 'PROCESSING_INVENTORY_CHANGED') throw error;
        const view = processingStatusView(native, shortcut, { sequence: job?.sequence });
        return { ...view, diagnostics: [...new Set([...view.diagnostics, 'PROCESSING_INVENTORY_INCOMPLETE'])].slice(0, 8) };
      }
      return processingStatusView(native, shortcut, { inventory, sequence: job?.sequence });
    } finally { if (!job) await controller.close(); }
  }
  async function activeJob(key, source, signal) {
    const job = jobs.get(key);
    if (!job) return null;
    const status = await job.controller.status({ selection: source.selection });
    if (['creating', 'busy'].includes(status.state) || job.sequence) return alreadyProcessing(viewOf({ ...status, state: 'busy' }));
    await job.promise; signal?.throwIfAborted(); return null;
  }
  async function requestProcessing({ source, selection, scope = 'collection', signal, mode = 'process' }) {
    signal?.throwIfAborted();
    const { options, capability } = selected(source), key = keyFor(options), requestId = nativeRequestId(source, client);
    if (selection && canonicalJSON({ ...selection, unitId: selection.unitId ?? null }) !== canonicalJSON(source.selection)) fail('PROCESSING_CONTROL_SELECTION_MISMATCH');
    await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'explicitProcess'));
    const replay = await replayControl(source); if (replay) return replay;
    const args = { selection: source.selection, requestId, action: mode, argsHash: source.argsHash };
    // Shortcut replies also survive without a capture-exclusion receipt. Exact
    // completed redelivery needs no launch credential and must not create state.
    const prior = await withStorageProbes(() => readProcessingShortcutControl(capability, args));
    if (prior?.response) { controls.set(source, prior); return prior.response; }
    if (client === 'claude') assertClaudeHostAuthentication(env);
    const control = await withStorageProbes(() => beginProcessingShortcutControl(capability, args));
    controls.set(source, control); if (control.response) return control.response;
    const existing = await activeJob(key, source, signal); if (existing) return existing;
    let announce, rejectAdmission, releaseDispatch, rejectDispatch;
    const admission = new Promise((resolve, reject) => { announce = resolve; rejectAdmission = reject; });
    const dispatched = new Promise((resolve, reject) => { releaseDispatch = resolve; rejectDispatch = reject; });
    admission.catch(() => {}); dispatched.catch(() => {});
    let job;
    const controller = await openController({ ...options, client }, { env, ...dependencies.execution,
      preferHostEnvironment: client === 'claude',
      beforeExecution: async context => {
        if (job.cancelRequested) fail('PROCESSING_CANCEL_UNVERIFIED');
        signal?.throwIfAborted(); await dependencies.execution?.beforeExecution?.(context); signal?.throwIfAborted();
        const value = processingStatusView(await controller.status({ inspectOperation: false }), job.shortcut);
        announce({ ...value, status: 'busy', statusDetail: 'accepted', nextAction: 'wait' });
        await dispatched;
      },
    });
    let current, shortcut;
    try {
      signal?.throwIfAborted(); current = await controller.status({ selection: source.selection });
      current = await acknowledgeFinishedReview(controller, capability, current);
      if (await controller.hasRequest(requestId)) { await controller.close(); return viewOf(current); }
      const activity = await controller.collectionActivity(), competing = activity.find(item => !item.own);
      if (competing) {
        await controller.close();
        const other = viewOf({ state: competing.state, requestId: competing.requestId,
          chat: competing.sessionId ? { client: competing.client, sessionId: competing.sessionId } : null,
          diagnostics: ['PROCESSING_COLLECTION_BUSY'] });
        return ['creating', 'busy'].includes(other.status) ? alreadyProcessing(other) : other;
      }
      if (['creating', 'busy', 'blocked'].includes(current.state)) { await controller.close(); return alreadyProcessing(viewOf(current)); }
      shortcut = await withStorageProbes(() => selectProcessingShortcut(capability, { selection: source.selection, requestId, scope, mode }, { canResumeOperation: id => controller.canResumeOperation(id) }));
      if (!shortcut.nextRun) { await controller.close(); return processingStatusView(current, shortcut); }
      if (current.remainingRuns === 0) { await controller.close(); return processingStatusView(current, shortcut); }
    } catch (error) { await controller.close(); throw error; }
    const cancel = () => { if (!job?.admissionCommitted) { rejectDispatch(signal.reason); rejectAdmission(signal.reason); } };
    signal?.addEventListener('abort', cancel, { once: true });
    job = { controller, promise: null, requestId, releaseDispatch, rejectDispatch, shortcut, sequence: true, cancelRequested: false }; jobs.set(key, job);
    const advance = async args => {
      if (job.cancelRequested) return;
      job.selectionPromise = withStorageProbes(() => selectProcessingShortcut(capability, args,
        { canResumeOperation: id => controller.canResumeOperation(id) }));
      try { job.shortcut = await job.selectionPromise; } finally { job.selectionPromise = null; }
    };
    job.promise = (async () => {
      const started = performance.now();
      let freshSelection = job.shortcut.requestId === requestId;
      for (let turn = 0; turn < 8 && performance.now() - started < 45 * 60 * 1000; turn++) {
        if (job.cancelRequested) break;
        const before = progressKey(job.shortcut);
        current = await controller.status({ inspectOperation: false });
        if (current.remainingRuns === 0) break;
        const result = await controller.run({ requestId: derivedRequestId(requestId, turn), selection: source.selection,
          expectedChatHash: current.chatHash, ...job.shortcut.nextRun });
        if (job.cancelRequested || ['blocked', 'awaiting-review'].includes(result.state)) break;
        if (['failed', 'interrupted'].includes(result.nativeStatus)) break;
        // Selection already returns a guarded progress projection. Reuse it
        // instead of scanning every operation once for inspect and again here.
        await advance({ selection: source.selection, requestId: derivedRequestId(requestId, turn + 1), scope, mode: 'resume' });
        if (job.cancelRequested || before === progressKey(job.shortcut) || job.shortcut.counts?.unfinishedOperations) break;
        if (!job.shortcut.nextRun && mode === 'process' && !freshSelection && !job.shortcut.reviews?.length && !job.shortcut.blockers?.length && !job.shortcut.counts?.unavailable) {
          await advance({ selection: source.selection, requestId, scope });
          freshSelection = true;
        }
        if (!job.shortcut.nextRun) break;
      }
      const terminal = await controller.status({ selection: source.selection });
      const response = processingStatusView(terminal, await withStorageProbes(() => inspectProcessingShortcut(capability, { selection: source.selection })));
      announce(response); return response;
    })().catch(error => { rejectAdmission(error); return { status: 'blocked', requestId, chat: null, nextAction: 'inspect', diagnostics: ['PROCESSING_CHAT_OUTCOME_UNKNOWN'] }; })
      .finally(async () => {
        job.sequence = false; signal?.removeEventListener('abort', cancel);
        try { await controller.close(); } finally { if (jobs.get(key) === job) jobs.delete(key); }
      });
    job.promise.catch(() => {}); return admission;
  }
  const requestResume = args => requestProcessing({ ...args, mode: 'resume' });
  async function requestCancel({ source, signal }) {
    const { capability, options } = selected(source), key = keyFor(options), requestId = nativeRequestId(source, client);
    const replay = await replayControl(source); if (replay) return replay;
    const args = { selection: source.selection, requestId, action: 'cancel', argsHash: source.argsHash };
    // Check an old exact receipt before touching a newer live job. Then freeze
    // this job's selection transitions and drain an already-started transition
    // before pinning the cancellation target.
    const prior = await withStorageProbes(() => readProcessingShortcutControl(capability, args));
    if (prior?.response) { controls.set(source, prior); return prior.response; }
    const job = jobs.get(key), controller = job?.controller ?? await openController({ ...options, client }, { env });
    try {
      if (job) {
        job.cancelRequested = true;
        await job.selectionPromise;
      }
      const control = await withStorageProbes(() => beginProcessingShortcutControl(capability, args));
      controls.set(source, control); if (control.response) return control.response;
      let current = await controller.status({ selection: source.selection });
      if (job) {
        if (current.state === 'busy') await controller.stop({ expectedChatHash: current.chatHash, requestId: current.requestId });
        await job.promise;
        current = await controller.status({ selection: source.selection });
      }
      const assertStopped = async () => {
        signal?.throwIfAborted();
        if ((await controller.collectionActivity()).some(item => ['creating', 'busy', 'blocked'].includes(item.state))) fail('PROCESSING_CANCEL_UNVERIFIED');
      };
      await assertStopped();
      let shortcut = await withStorageProbes(() => inspectProcessingShortcut(capability, { selection: source.selection }));
      if (!shortcut.checkpointHash) {
        const inventory = await withStorageProbes(() => stablePendingCollectionProcessing(capability, { selection: source.selection, limit: 1 }));
        if (inventory.operations.length || inventory.blockers.length) fail('PROCESSING_CANCEL_UNVERIFIED');
      }
      if (shortcut.requestId !== control.targetRequestId && control.targetRequestId !== null) fail('PROCESSING_SHORTCUT_CHANGED');
      if (!shortcut.checkpointHash) return { ...viewOf(current), status: 'idle', statusDetail: 'nothing-to-resume', nextAction: 'none' };
      const cancelled = await withStorageProbes(() => cancelProcessingShortcut(capability,
        { selection: source.selection, expectedCheckpointHash: shortcut.checkpointHash }, { assertStopped, canResumeOperation: id => controller.canResumeOperation(id) }));
      return processingStatusView({ ...current, state: 'idle' }, cancelled);
    } finally { if (!job) await controller.close(); }
  }
  async function requestReview({ source, elicit, signal, commitResponse }) {
    signal?.throwIfAborted();
    const { options, capability } = selected(source), key = keyFor(options);
    const replay = await replayControl(source);
    signal?.throwIfAborted();
    if (replay) return replay;
    const existing = await activeJob(key, source, signal);
    if (existing) return existing;
    const controller = await openController({ ...options, client }, { env });
    let response;
    try {
      let status = await controller.status({ selection: source.selection });
      status = await acknowledgeFinishedReview(controller, capability, status);
      const inventory = await withStorageProbes(() => stablePendingCollectionProcessing(capability, { selection: source.selection, limit: 1 }));
      if (inventory.blockers.length) return blockedInventory(viewOf(status), inventory.blockers);
      const proposals = authorizedReviews(inventory);
      let proposal = proposals[0];
      if (proposals.length > 1) {
        const chosen = await elicit({ choices: proposals.map((item, index) => ({ operationId: item.operationId,
          label: `Draft ${index + 1}: ${item.inputCount} captures; ${item.createdAt}` })) });
        if (chosen.action !== 'accept') return { ...viewOf(status), status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' };
        proposal = proposals.find(item => item.operationId === chosen.content.operationId);
        if (!proposal) fail('PROCESSING_REVIEW_INTERRUPTED');
      }
      if (!proposal) response = processingStatusView(status, await withStorageProbes(() => inspectProcessingShortcut(capability, { selection: source.selection })), { inventory });
      else {
        const context = { selection: proposal.selection, operationId: proposal.operationId };
        const result = await reviewProcessingProposal(capability, context, { elicit, signal, commitResponse });
        if (result.status !== 'awaiting-review') {
          committedReviews.set(source, { status: 'completed', statusDetail: 'completed', requestId: status.requestId, chat: status.chat,
            nextAction: 'inspect', diagnostics: ['PROCESSING_CHAT_CONFLICT'] });
          try {
            const ownReview = status.state === 'awaiting-review' && status.operationId === proposal.operationId;
            const next = ownReview ? await controller.finishReview({ expectedChatHash: status.chatHash,
              requestId: status.requestId, operationId: proposal.operationId }) : status;
            response = processingStatusView(next, await withStorageProbes(() => inspectProcessingShortcut(capability, { selection: source.selection })));
            if (!ownReview && response.status === 'missing') response = { ...response, status: 'completed', statusDetail: 'completed' };
          } catch { response = committedReviews.get(source); }
        } else response = { ...viewOf(status), status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' };
      }
    } finally {
      try { await controller.close(); }
      catch (error) {
        if (!committedReviews.has(source)) throw error;
        response = committedReviews.get(source);
      }
    }
    return response;
  }
  async function beforeResponse({ source, context, invocation, view, result, signal, commitResponse }) {
    const { capability, options } = selected(source);
    const job = ['process_selected_captures', 'processing_resume'].includes(invocation.tool) ? jobs.get(keyFor(options)) : null;
    const owned = job?.requestId === nativeRequestId(source, client) ? job : null;
    const commitAdmission = () => {
      signal?.throwIfAborted(); commitResponse();
      if (owned) owned.admissionCommitted = true;
    };
    const release = async (response = view) => {
      signal?.throwIfAborted();
      const control = controls.get(source);
      if (control && !control.response) await withStorageProbes(() => finishProcessingShortcutControl(capability, control, response, { beforePublish: commitAdmission }));
      // Admission is complete at this synchronous boundary. A later cancellation
      // of this MCP request cannot cancel the separate, already admitted run.
      if (owned) { commitAdmission(); owned.releaseDispatch(); }
    };
    try {
      signal?.throwIfAborted();
      const replay = replayed.get(source);
      if (replay) {
        if (digest(canonicalJSON(client === 'claude' ? result.content : result)) !== replay.resultHash) fail('PROCESSING_CONTROL_RECEIPT_CONFLICT');
        // Return the admitted response byte-for-byte. Current status is a
        // separate call; redelivery cannot rewrite immutable proof or dispatch.
        return;
      }
      if ((!source.nativeSkill && !source.controlExclusionUnsupported) || !source.unitId || source.captureActive === false) {
        await release();
        return;
      }
      // Explicit processing consent is independent of automatic collection.
      // With collection disabled there is no parent capture to exclude; do not
      // make an optional exclusion receipt a prerequisite for processing.
      try { await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'collect')); }
      catch (error) {
        if (error.code !== 'WORKFLOW_NOT_AUTHORIZED') throw error;
        await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'explicitProcess'));
        await release(); return;
      }
      if (source.controlExclusionUnsupported) {
        const replacement = { ...view, diagnostics: [...new Set([...view.diagnostics, 'PROCESSING_EXCLUSION_UNVERIFIED'])].slice(0, 8) };
        await release(processingControlStatusView(replacement, { collectionId: source.collectionId }));
        return replacement;
      }
      const store = await withStorageProbes(() => openWorkflowIntake(capability, source.selection, 'collect'));
      const authorize = async () => { signal?.throwIfAborted(); await assertWorkflowStorage(capability, source.selection, 'collect'); signal?.throwIfAborted(); return true; };
      await withStorageProbes(() => withIntakeLock(store, tx => recordProcessingControlDispatch(tx, {
        source: source.source, selectionHash: source.selectionHash,
        dispatch: { client, sessionId: source.selection.sessionId, unitId: source.unitId, callId: source.callId,
          tool: source.tool, argsHash: source.argsHash, sourceIdentity: source.source.fileIdentity, sourcePath: source.source.path,
          requestHash: digest(canonicalJSON(invocation.arguments)), skillName: 'cuefluent-notes', skillPath,
          statusText: view.statusText, resultHash: digest(canonicalJSON(client === 'claude' ? result.content : result)), response: view,
          ...(client === 'claude' ? Object.fromEntries(['inputId', 'inputHash', 'companionId', 'companionHash', 'skillExpansionHash', 'skillCommand']
            .map(key => [key, source[key]])) : {}) },
      }, { authorize, beforePublish: commitAdmission })));
      await release();
    } catch (error) {
      if (error.code === 'STALE_SELECTION' && !signal?.aborted) {
        // Collection progress is not processing consent. Preserve the inspected
        // hash and omit exclusion proof instead of refreshing it through a race.
        try {
          await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'explicitProcess'));
          const replacement = { ...view, diagnostics: [...new Set([...view.diagnostics, 'PROCESSING_EXCLUSION_UNVERIFIED'])].slice(0, 8) };
          await release(processingControlStatusView(replacement, { collectionId: source.collectionId }));
          return replacement;
        } catch (freshError) { error = freshError; }
      }
      if (owned?.admissionCommitted) owned.releaseDispatch();
      else owned?.rejectDispatch(error);
      // Receipt/registry housekeeping cannot undo an engine disposition. A
      // failed receipt supplies no exclusion proof and is never retried here.
      if (invocation.tool === 'processing_review' && committedReviews.has(source)) return committedReviews.get(source);
      throw error;
    }
  }
  try {
    await runProcessingControlServer({ client, input, output, env, resolveSource, getStatus, requestProcessing, requestResume, requestCancel, requestReview, beforeResponse });
  } finally {
    // No automatic dispatch retry, cancellation, claim cleanup or new source read.
    for (const job of jobs.values()) job.rejectDispatch(Object.assign(new Error('PROCESSING_CONTROL_FAILED'), { code: 'PROCESSING_CONTROL_FAILED' }));
    await Promise.allSettled([...jobs.values()].map(job => job.promise));
  }
}

if (await isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 2 || args[0] !== '--client') fail('INVALID_PROCESSING_CLIENT');
    await runProcessingMcp({ client: args[1] });
  } catch (error) {
    process.stderr.write(`Cuefluent processing: ${safeErrorCode(error, 'PROCESSING_CONTROL_FAILED')}\n`);
    process.exitCode = 1;
  }
}
