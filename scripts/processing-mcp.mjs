import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowConfigPath, readWorkflowSnapshot } from './workflow-config.mjs';
import { verifyWorkflowStorage, assertWorkflowStorage, workflowCollectionGrant } from './workflow-storage.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { openWorkflowIntake, withIntakeLockWaiting, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { readSelection, selectionPath } from './intake-store.mjs';
import { processingSourceDirectory, processingSourcePath, registrationPath, readRegistration, assertRegistrationGrant, collectionStatusPath } from './collection-ingress.mjs';
import { collectionGrantHash } from './collection-grant.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { recordProcessingControlDispatch, createProcessingControlResolver } from './processing-control-receipts.mjs';
import { resolveProcessingInvocation, isProcessingInvocation, isPendingProcessingInvocation } from './processing-native-invocation.mjs';
import { inspectProcessingShortcut, selectProcessingShortcut, cancelProcessingShortcut, beginProcessingShortcutControl, readProcessingShortcutControl, finishProcessingShortcutControl } from './processing-shortcuts.mjs';
import { inspectProcessing, processingProposalPaths } from './processing.mjs';
import { stablePendingCollectionProcessing } from './processing-collection.mjs';
import { runProcessingControlServer, processingControlStatusView, reviewNotePath, replayedView, COLLECTION_STOP_CODES, CAPTURE_TOOLS } from './processing-control-server.mjs';
import { captureChatTurns, controlChatCapture, excludeChatTurn, reserveChatCommand, recordChatCommandReply, typedCaptureDeadline, typedCommandDeadline } from './capture-controls.mjs';
import { readReaderBlock, READER_BLOCK_CODES } from './collection-worker.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { assertClaudeProcessingAuthentication } from './processing-claude-settings.mjs';
import { reviewProcessingProposal, readReviewPreview, applyReviewDecision } from './processing-host-review.mjs';
import { presentReviewFiles, confirmReviewPresentation, settleReviewFiles, readReviewPresentations, presentationStillShown, presentationAttemptCurrent, reviewChatLineage, reviewCode, sameReviewRevision } from './processing-review-files.mjs';
import { REVIEW_COMMANDS, SKILL_NAME, reviewControlFields } from './processing-control-proof.mjs';
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
  PROCESSING_REINSPECTION_REQUIRED: 'PROCESSING_REINSPECTION_REQUIRED',
  PROCESSING_OPERATION_CONFLICT: 'PROCESSING_OPERATION_CONFLICT',
  PROCESSING_OPERATION_OWNER_UNVERIFIED: 'PROCESSING_OPERATION_OWNER_UNVERIFIED',
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
// Before publication, these refusals mean the presented revision or its
// destination is no longer the one that can be saved; nothing was applied.
const REVIEW_REVISION_CHANGED = new Set(['PROCESSING_REVIEW_REQUIRED', 'PROCESSING_OPERATION_COMPLETE', 'PROCESSING_CLAIM_MISSING',
  'PROCESSING_CLAIM_CHANGED', 'PROCESSING_PROPOSAL_CHANGED', 'PROCESSING_OUTPUT_CHANGED', 'PROCESSING_NOTES_ROOT_CHANGED',
  'PROCESSING_HEAD_CHANGED', 'PROCESSING_INPUT_CHANGED']);
// Review outcomes that leave a presented draft pending.
const REVIEW_PENDING = new Set(['presented', 'deferred', 'declined', 'display-altered', 'unavailable']);
const reviewChanged = error => REVIEW_REVISION_CHANGED.has(error?.code) || (error?.code === 'SAFE_UPDATE_REJECTED' &&
  /changed since inspection|Reviewed processing (?:directories|manifest) changed/.test(error.safeMessage ?? ''));
// The cause a refused decision names: its destination, a revision no longer
// pending, or a changed revision.
const changedReason = error => ['PROCESSING_OUTPUT_CHANGED', 'PROCESSING_NOTES_ROOT_CHANGED', 'SAFE_UPDATE_REJECTED'].includes(error?.code) ? 'destination'
  : ['PROCESSING_REVIEW_REQUIRED', 'PROCESSING_OPERATION_COMPLETE', 'PROCESSING_CLAIM_MISSING'].includes(error?.code) ? 'not-pending' : 'changed';
const selectionConflicts = new Set(['WORKFLOW_POLICY_CHANGED', 'PROCESSING_HEAD_CHANGED', 'CAPTURE_PRUNED',
  'PROCESSING_SELECTION_CHANGED', 'PROCESSING_INPUT_CLAIMED', 'PROCESSING_INPUT_CHANGED',
  'PROCESSING_INPUT_ALREADY_HANDLED', 'PROCESSING_SHORTCUT_CAPACITY']);

function blockedInventory(view, blockers) {
  if (blockers.includes('PROCESSING_REINSPECTION_REQUIRED')) return { ...view, status: 'blocked', statusDetail: 'blocked',
    nextAction: 'inspect', diagnostics: ['PROCESSING_REINSPECTION_REQUIRED'] };
  if (blockers.includes('PROCESSING_BINDING_CHANGED')) return { ...view, status: 'blocked', statusDetail: 'blocked',
    nextAction: 'inspect', diagnostics: ['PROCESSING_BINDING_CHANGED'] };
  if (blockers.length && blockers.every(code => selectionConflicts.has(code))) {
    return { ...view, status: 'blocked', statusDetail: blockers.includes('PROCESSING_SHORTCUT_CAPACITY') ? 'selection-limit' : 'blocked',
      nextAction: 'cancel', diagnostics: [...new Set(blockers.map(code => ['WORKFLOW_POLICY_CHANGED', 'PROCESSING_SHORTCUT_CAPACITY'].includes(code) ? code : 'PROCESSING_SELECTION_CHANGED'))] };
  }
  const recovery = blockers.some(code => ['PROCESSING_RECOVERY_REQUIRED', 'WRITER_RECOVERY_REQUIRED', 'INTAKE_RECOVERY_REQUIRED', 'PRUNE_RECOVERY_REQUIRED', 'writer-reserved-by-another-collection'].includes(code));
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
    const admissionOnly = view.status === 'blocked' && view.diagnostics.length > 0 &&
      view.diagnostics.every(code => code === 'PROCESSING_BINDING_CHANGED');
    if (!['creating', 'busy', 'blocked'].includes(view.status) || admissionOnly) {
      const blockingReview = inventory.blockers.filter(code => code !== 'PROCESSING_BINDING_CHANGED');
      if (blockingReview.length) view = blockedInventory(view, blockingReview);
      else if (reviews.length) view = { ...view, status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review', diagnostics: [] };
      else if (inventory.blockers.length) view = blockedInventory(view, inventory.blockers);
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
  } else {
    // A registered Claude session can bind before its selection is armed.
    try { await fs.lstat(path.join(collection.intakeStateDir, registrationPath(context))); return 'binding'; }
    catch (error) { if (error.code !== 'ENOENT') return 'binding'; }
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
  const commandPrefix = REVIEW_COMMANDS[client];
  // Presentations written in this request, confirmed only after its reply commits.
  const pendingPresentations = new WeakMap();
  const openController = dependencies.openController ?? openProcessingController;
  const resolveInvocation = dependencies.resolveInvocation ?? resolveProcessingInvocation;
  const confirmPresentation = dependencies.confirmPresentation ?? confirmReviewPresentation;
  const presentationCurrent = dependencies.presentationCurrent ?? presentationAttemptCurrent;
  // Nothing is set up for this chat: no configuration, no route for this client,
  // or no registration, selection or processing source for this session in any
  // routed collection. Still a refusal; only a status request may answer it with
  // the command list. A failed binding of a source that exists is never this.
  const noSource = () => Object.assign(new Error('PROCESSING_CONTROL_SOURCE_UNVERIFIED'), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED', noSource: true });
  async function resolveSource(context, invocation, { signal, requireCompleted } = {}) {
    const selectedConfig = configPath ?? await workflowConfigPath();
    const snapshot = await readWorkflowSnapshot(selectedConfig);
    if (!snapshot.config) throw noSource();
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
    if (requested === undefined && !registrationCollections.length) throw noSource();
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
  // A typed invocation of this skill whose arguments are not one exact action
  // applies nothing, whichever tool the model called: no dispatch, display,
  // decision or receipt. The reply names the nearest exact commands, computed
  // from the verified typed text by the grammar; a suggestion is not authority.
  async function currentView(source) {
    const { options } = selected(source), job = jobs.get(keyFor(options));
    const controller = job?.controller ?? await openController({ ...options, client }, { env });
    try { return viewOf(await controller.status({ selection: source.selection })); }
    finally { if (!job) await controller.close(); }
  }
  // The skill typed with nothing after it gets the command list, also with no
  // dispatch, display, decision or receipt.
  async function notACommand(source) {
    if (source.typedHelp === true) return { ...await currentView(source), help: true, commandPrefix };
    // A Codex mention typed out by hand attached no skill: it says how to type it.
    if (source.typedUnattached !== undefined) return { ...await currentView(source), command: 'skill-not-attached', suggestions: [...source.typedUnattached], commandPrefix };
    if (source.typedSuggestions === undefined) return null;
    return { ...await currentView(source), command: 'not-a-command', suggestions: [...source.typedSuggestions], commandPrefix };
  }
  // Every reply spells commands for this client, except a replayed receipt,
  // which returns its original response exactly.
  const spelled = action => async request => {
    const response = await action(request);
    return response?.commandPrefix !== undefined || replayed.has(request.source) ? response : { ...response, commandPrefix };
  };
  const exactOnly = action => spelled(async request => (await notACommand(request.source)) ?? action(request));
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
      return withIntakeLockWaiting(store, async tx => {
        const selected = await readSelection(store, { client, sessionId: source.selection.sessionId });
        if (selected.hash !== source.selectionHash) return null;
        return createProcessingControlResolver(tx, { state: selected.state, selectionHash: selected.hash, authorize })({
          client, sessionId: source.selection.sessionId, unitId: source.unitId,
          callId: source.callId, tool: source.tool, argsHash: source.argsHash });
      });
    });
    if (!receipt?.response) return null;
    if (receipt.response.collectionId !== source.collectionId) fail('PROCESSING_CONTROL_RECEIPT_CONFLICT');
    // A review reply is recorded before its presentation is confirmed. When
    // that confirmation failed, the reply the chat received was the refusal;
    // once the draft is decided or replaced, its folder is gone. Either way a
    // redelivered call is refused rather than told "presented" again. The
    // exact revision decides: another revision can share its draft code.
    const shown = receipt.response.draft?.folder !== undefined && REVIEW_PENDING.has(receipt.response.review);
    if (shown && !(receipt.presentation && await presentationStillShown(capability, reviewChatLineage(source), receipt.presentation))) {
      fail('PROCESSING_REVIEW_SUPERSEDED');
    }
    replayed.set(source, receipt);
    return replayedView(receipt.response);
  }
  async function acknowledgeFinishedReview(controller, capability, status, { persist = true } = {}) {
    if (status.state !== 'awaiting-review') return status;
    const operation = await withStorageProbes(() => inspectProcessing(capability, status.operationId));
    if (operation.state !== 'completed' || !operation.outcome || operation.recoveryRequired) return status;
    // Retired proposals have no terminal native review record to acknowledge.
    if (status.restartSupported) return controller.status();
    return persist ? controller.finishReview({ expectedChatHash: status.chatHash, requestId: status.requestId, operationId: status.operationId })
      : { ...status, state: 'idle', operationState: 'completed', recoveryRequired: false };
  }
  async function getStatus({ source, verbose, help }) {
    const { options, capability } = selected(source), key = keyFor(options);
    const replay = await replayControl(source); if (replay) return replay;
    // Claude mirrors a typed `status --verbose` or `help` in its arguments;
    // Codex carries it in the verified typed text alone.
    if (help === true || source.typedControl === 'help') return { ...await currentView(source), help: true };
    const details = verbose === true || source.typedControl === 'status --verbose' ? { verbose: true } : {};
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
        return { ...view, ...details, diagnostics: [...new Set([...view.diagnostics, 'PROCESSING_INVENTORY_INCOMPLETE'])].slice(0, 8) };
      }
      // Drafts awaiting review, one per line by code and note path; the
      // verbose reply also names each exact revision.
      const reviews = authorizedReviews(inventory).map(item => ({ item, code: reviewCode(item.proposalHash) }));
      const drafts = (await shownDrafts(capability, reviews)).map(listed => {
        const { item } = reviews.find(entry => entry.code === listed.code);
        return details.verbose ? { ...listed, operationId: item.operationId, proposalHash: item.proposalHash, claimHash: item.claimHash } : listed;
      });
      return { ...processingStatusView(native, shortcut, { inventory, sequence: job?.sequence }), ...details, ...(drafts.length ? { drafts } : {}),
        ...await collectionStop(capability, source) };
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
      if (await controller.hasRequest(requestId)) {
        current = await acknowledgeFinishedReview(controller, capability, current, { persist: false });
        await controller.close(); return viewOf(current);
      }
      const activity = await controller.collectionActivity(), competing = activity.find(item => !item.own);
      if (competing) {
        await controller.close();
        const other = viewOf({ state: competing.state, requestId: competing.requestId,
          chat: competing.sessionId ? { client: competing.client, sessionId: competing.sessionId } : null,
          diagnostics: ['PROCESSING_COLLECTION_BUSY'] });
        return ['creating', 'busy'].includes(other.status) ? alreadyProcessing(other) : other;
      }
      if (['creating', 'busy'].includes(current.state)) { await controller.close(); return alreadyProcessing(viewOf(current)); }
      // Only the controller's validated retry states may reach fresh admission.
      // Unknown outcomes stay blocked; being blocked is not evidence of a live run.
      if (current.state === 'blocked') { await controller.close(); return viewOf(current); }
      // Existing activity is a read-only result. Require launch credentials only
      // after those exits, before control admission or review acknowledgement.
      if (client === 'claude') assertClaudeProcessingAuthentication(env);
      const control = await withStorageProbes(() => beginProcessingShortcutControl(capability, args));
      controls.set(source, control); if (control.response) { await controller.close(); return control.response; }
      current = await acknowledgeFinishedReview(controller, capability, current);
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
      controller.assertIdentity();
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
  // Names of other pending drafts for a listing: metadata only, bounded. A
  // draft that changes meanwhile is simply left out of the listing.
  async function draftListing(capability, entries) {
    const listed = [];
    for (const { item, code } of entries) {
      if (listed.length >= 4) break;
      if (listed.some(entry => entry.code === code)) continue; // A shared code is listed once.
      try {
        const named = await withStorageProbes(() => processingProposalPaths(capability, item.operationId));
        if (named.proposalHash === item.proposalHash) listed.push({ code, path: reviewNotePath(named.paths[0]), fileCount: named.paths.length });
      } catch (error) { if (!reviewChanged(error)) throw error; }
    }
    return listed;
  }
  // Display only: a listing that cannot be read is left out rather than
  // failing a status or a decision, whose own reads keep every check.
  async function shownDrafts(capability, entries, signal) {
    try { return await draftListing(capability, entries); }
    catch (error) { if (signal?.aborted) throw error; return []; }
  }
  const draftView = presentation => ({ code: presentation.code, folder: presentation.folder,
    files: presentation.files.slice(0, 5).map(file => ({ ...file, path: reviewNotePath(file.path) })), fileCount: presentation.files.length });
  // Why automatic collection stopped for this chat, as the latest worker pass
  // reported it for exactly this session while collection still applies to it.
  // Display only: a missing or unreadable record shows nothing.
  // Why Automatic capture of this chat stopped: the reader block its last visit
  // ended on, kept per chat, or else a stop the latest pass reported.
  async function collectionStop(capability, source) {
    try {
      await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'collect'));
      const store = await withStorageProbes(() => openWorkflowIntake(capability));
      // A marker that cannot be read leaves the latest pass's report to say it.
      let block = null;
      try { block = await withStorageProbes(() => readReaderBlock(store, { client, sessionId: source.selection.sessionId })); } catch { /* the notice below */ }
      if (block) return { collection: { state: 'stopped', code: block } };
      const notice = intakeJSON(await intakeSnapshot(store, 'state', collectionStatusPath, { maxBytes: 16384 }));
      const found = Array.isArray(notice?.diagnostics) ? notice.diagnostics.find(item => item?.client === source.selection.client &&
        item.sessionId === source.selection.sessionId && COLLECTION_STOP_CODES.includes(item.code)) : undefined;
      return found ? { collection: { state: 'stopped', code: found.code } } : {};
    } catch { return {}; }
  }
  // Show one exact revision: write its private review folder and record that
  // this chat lineage was shown it. Codex then opens its native form for the
  // same preview; Claude (and Codex without a form) decides by typed command.
  async function showReview({ source, capability, status, proposals, coded, asked, verified, elicit, signal, commitResponse, reviewView, refuseChanged }) {
    let target;
    if (asked.draft !== undefined) {
      const matches = coded.filter(entry => entry.code === asked.draft);
      // No pending draft has that code, or a shared code names none.
      if (matches.length !== 1) return refuseChanged(asked.draft, null, matches.length ? 'changed' : 'not-pending');
      target = matches[0];
    } else if (elicit && coded.length > 1) {
      const chosen = await elicit({ choices: coded.map(({ item }, index) => ({ operationId: item.operationId,
        label: `Draft ${index + 1}: ${item.inputCount} captured ${item.inputCount === 1 ? 'turn' : 'turns'}; ${item.createdAt}` })) });
      if (chosen.action !== 'accept') return { response: { ...viewOf(status), status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review', review: 'declined' } };
      target = coded.find(entry => entry.item.operationId === chosen.content.operationId);
      if (!target) fail('PROCESSING_REVIEW_INTERRUPTED');
    } else target = coded[0];
    const context = { selection: target.item.selection, operationId: target.item.operationId };
    let preview;
    try { preview = await readReviewPreview(capability, context); }
    catch (error) { if (signal?.aborted || !reviewChanged(error)) throw error; return refuseChanged(target.code, null, changedReason(error)); }
    if (reviewCode(preview.proposalHash) !== target.code) return refuseChanged(target.code, null, 'changed');
    signal?.throwIfAborted();
    const presentation = await presentReviewFiles(capability, { selection: source.selection, preview,
      chatLineage: reviewChatLineage(source), verified, signal });
    pendingPresentations.set(source, { chatLineage: reviewChatLineage(source), attempt: presentation.attempt,
      revision: { operationId: presentation.operationId, proposalHash: presentation.proposalHash, claimHash: presentation.claimHash } });
    signal?.throwIfAborted();
    // A display the person did not type says to type the review first.
    const draft = draftView(presentation), untyped = verified ? {} : { untyped: true };
    const presented = async () => {
      const others = await shownDrafts(capability, coded.filter(entry => entry !== target), signal);
      return { response: reviewView('presented', { draft, ...untyped, ...(others.length ? { drafts: others } : {}) }) };
    };
    if (!elicit) return presented();
    let result;
    try { result = await reviewProcessingProposal(capability, context, { elicit, signal, commitResponse, preview, folder: presentation.folder }); }
    catch (error) {
      // Both limits are checked before any form is sent. The folder already
      // holds the complete proposal, so the review continues there by typed command.
      if (signal?.aborted || !['PROCESSING_REVIEW_LIMIT', 'PROCESSING_REVIEW_TOO_LARGE'].includes(error?.code)) throw error;
      return presented();
    }
    if (result.status === 'awaiting-review') return { response: reviewView(result.review, { draft, ...untyped }) };
    return { result, proposal: target.item, revision: presentation,
      draft: { code: draft.code, path: draft.files[0].path, fileCount: draft.fileCount } };
  }
  // A typed decision applies only through a verified typed action, to a
  // revision presented to this chat lineage, whose engine hashes still match.
  async function decideReview({ source, capability, proposals, coded, asked, verified, signal, commitResponse, reviewView, refuseChanged, named }) {
    if (!verified) return { response: reviewView('unverified', asked.draft === undefined ? {} : { draft: await named(asked.draft) }) };
    const { bindings, recent } = await readReviewPresentations(capability, reviewChatLineage(source));
    let binding;
    if (asked.draft !== undefined) {
      const matches = bindings.filter(item => reviewCode(item.proposalHash) === asked.draft);
      // A code shared by two presented revisions names neither; both need a fresh review.
      for (const extra of matches.slice(1)) await refuseChanged(asked.draft, extra, 'stale');
      if (matches.length > 1) return refuseChanged(asked.draft, matches[0], 'stale');
      // Even with its code, a draft counts as shown only when a typed review
      // presented it here; a natural-language or model-initiated display does
      // not. A code no pending draft has is simply not pending, for example
      // one already decided.
      if (!matches.length) {
        if (!coded.some(entry => entry.code === asked.draft)) return refuseChanged(asked.draft, null, 'not-pending');
        return { response: reviewView('not-shown', { draft: await named(asked.draft) }) };
      }
      binding = matches[0];
    } else {
      // Only the revision this chat was most recently shown by a verified
      // typed review; never "the only draft" or "the only review folder".
      // The latest attempt must itself be a delivered typed review; an attempt
      // whose reply failed, or one the model started, blocks the bare form.
      if (!recent?.verified || !recent.delivered) return { response: reviewView('unresolved', { drafts: await shownDrafts(capability, coded, signal) }) };
      binding = bindings.find(item => sameReviewRevision(item, recent));
      if (!binding) return refuseChanged(reviewCode(recent.proposalHash), null, revisionReason(proposals, recent, 'stale'));
    }
    const proposal = proposals.find(item => item.operationId === binding.operationId);
    if (!proposal || proposal.proposalHash !== binding.proposalHash || proposal.claimHash !== binding.claimHash) {
      return refuseChanged(reviewCode(binding.proposalHash), binding, revisionReason(proposals, binding, 'changed'));
    }
    // Named before the decision: a saved or skipped draft is no longer pending.
    const draft = await named(reviewCode(binding.proposalHash));
    let committed = false;
    try {
      const result = await applyReviewDecision(capability, { selection: proposal.selection, operationId: proposal.operationId }, {
        decision: asked.decision, expectedClaimHash: binding.claimHash, expectedProposalHash: binding.proposalHash, signal,
        commitResponse: () => { committed = true; commitResponse?.(); } });
      return { result, proposal, revision: binding, draft };
    } catch (error) {
      if (committed || signal?.aborted || !reviewChanged(error)) throw error;
      return refuseChanged(reviewCode(binding.proposalHash), binding, changedReason(error));
    }
  }
  // A presented revision no longer decidable: gone from the pending drafts, or
  // pending with other hashes; `same` when its hashes still match.
  function revisionReason(proposals, revision, same) {
    const proposal = proposals.find(item => item.operationId === revision.operationId);
    if (!proposal) return 'not-pending';
    return proposal.proposalHash === revision.proposalHash && proposal.claimHash === revision.claimHash ? same : 'changed';
  }
  async function requestReview({ source, draft, decision, elicit, signal, commitResponse }) {
    signal?.throwIfAborted();
    const { options, capability } = selected(source), key = keyFor(options);
    const replay = await replayControl(source);
    signal?.throwIfAborted();
    if (replay) return replay;
    const existing = await activeJob(key, source, signal);
    if (existing) return { ...existing, review: 'busy' };
    // Only a verified typed action is an approval channel. Its exact text names
    // the draft and decision (Claude also mirrors them in checked arguments);
    // model-chosen fields can only display a draft or be refused.
    const verified = source.nativeSkill === true;
    const asked = verified && typeof source.typedControl === 'string' ? reviewControlFields(source.typedControl) ?? {} : { draft, decision };
    const lineage = reviewChatLineage(source);
    const controller = await openController({ ...options, client }, { env });
    let response;
    try {
      let status = await controller.status({ selection: source.selection });
      status = await acknowledgeFinishedReview(controller, capability, status);
      const inventory = await withStorageProbes(() => stablePendingCollectionProcessing(capability, { selection: source.selection, limit: 1 }));
      const blockingReview = inventory.blockers.filter(code => code !== 'PROCESSING_BINDING_CHANGED');
      if (blockingReview.length) return blockedInventory(viewOf(status), blockingReview);
      const proposals = authorizedReviews(inventory);
      if (!proposals.length && inventory.blockers.length) return blockedInventory(viewOf(status), inventory.blockers);
      if (!proposals.length && asked.draft === undefined && asked.decision === undefined) {
        return processingStatusView(status, await withStorageProbes(() => inspectProcessingShortcut(capability, { selection: source.selection })), { inventory });
      }
      const coded = proposals.map(item => ({ item, code: reviewCode(item.proposalHash) }));
      const reviewView = (review, extra = {}) => ({ ...viewOf(status),
        ...(proposals.length ? { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' } : {}), review, commandPrefix, ...extra });
      // A draft named in a reply: its code, with its first note path while it is pending.
      const named = async code => (await shownDrafts(capability, coded.filter(entry => entry.code === code), signal))[0] ?? { code };
      // A revision that changed or is no longer pending: nothing applies, and
      // this chat's stale presentation record and review folder are removed.
      // Cleanup cannot replace the refusal; a leftover record stays harmless
      // because every decision rechecks the engine's current hashes.
      const refuseChanged = async (code, binding, reason) => {
        try {
          const stale = binding ?? (await readReviewPresentations(capability, lineage)).bindings.find(item => reviewCode(item.proposalHash) === code);
          if (stale) await settleReviewFiles(capability, { selection: source.selection, chatLineage: lineage, revision: stale, signal });
        } catch (error) { if (signal?.aborted) throw error; }
        const drafts = await shownDrafts(capability, coded.filter(entry => entry.code !== code), signal);
        return { response: reviewView('changed', { draft: await named(code), reason, ...(drafts.length ? { drafts } : {}) }) };
      };
      const request = { source, capability, status, proposals, coded, asked, verified, elicit, signal, commitResponse, reviewView, refuseChanged, named };
      const outcome = asked.decision === undefined ? await showReview(request) : await decideReview(request);
      if (outcome.response) response = outcome.response;
      else {
        const { result, proposal, revision } = outcome, decided = outcome.draft ? { draft: outcome.draft } : {};
        // The decision is committed and settles its own presentation; there is
        // nothing left to confirm, and bookkeeping must not fail this reply.
        pendingPresentations.delete(source);
        committedReviews.set(source, { status: 'completed', statusDetail: 'completed', requestId: status.requestId, chat: status.chat,
          nextAction: 'inspect', diagnostics: ['PROCESSING_CHAT_CONFLICT'], review: result.review, ...decided, commandPrefix });
        // The decision is committed; the review folder is only a copy. Removing
        // it and this chat's record is housekeeping that cannot undo the result.
        try { await settleReviewFiles(capability, { selection: source.selection, chatLineage: lineage, revision }); } catch {}
        try {
          const ownReview = !status.restartSupported && status.state === 'awaiting-review' && status.operationId === proposal.operationId;
          const next = ownReview ? await controller.finishReview({ expectedChatHash: status.chatHash,
            requestId: status.requestId, operationId: proposal.operationId })
            : status.restartSupported ? await controller.status({ selection: source.selection }) : status;
          response = processingStatusView(next, await withStorageProbes(() => inspectProcessingShortcut(capability, { selection: source.selection })));
          if (!ownReview && response.status === 'missing') response = { ...response, status: 'completed', statusDetail: 'completed' };
          response = { ...response, review: result.review, ...decided };
        } catch { response = committedReviews.get(source); }
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
  // A typed chat capture command. Whether Automatic capture covers this chat
  // is policy (its route and session list) plus the chat's own pause. Only the
  // person's typed command acts; a model's own call is refused before acting.
  // Sources of capture-command deliveries that reserved their call: only these
  // act, and only these keep the command turn's bookkeeping.
  const reserving = new WeakSet();
  // Sources whose dispatch receipt was recorded: their command turn is kept out
  // of Automatic capture.
  const receipted = new WeakSet();
  async function requestCapture({ source, tool, signal }) {
    // The command's time runs from here, so its capture and the steps around
    // it end within it.
    const started = performance.now();
    signal?.throwIfAborted();
    if (!source.nativeSkill || !source.unitId) fail('PROCESSING_CONTROL_SELECTION_MISMATCH');
    const { capability } = selected(source);
    // A redelivered call answers with the reply it already gave; the command
    // does not act again. A delivery that finds its call reserved without a
    // reply (another delivery is acting, or could not keep its reply) cannot
    // tell the outcome, so it is refused as uncertain without acting.
    const call = { unitId: source.unitId, callId: source.callId, tool, argsHash: source.argsHash };
    const reserved = await withStorageProbes(() => reserveChatCommand(capability, source.selection, call, { signal, deadline: typedCaptureDeadline(started) }));
    if (!reserved.acting) { if (reserved.reply) return reserved.reply; fail('PROCESSING_CONTROL_FAILED'); }
    reserving.add(source);
    // The reply's status is read before the command acts: a status that
    // cannot be read refuses with nothing applied, never after acting.
    const view = await currentView(source);
    const automatic = await automaticCapture(capability, source);
    const store = await withStorageProbes(() => openWorkflowIntake(capability));
    const state = (await withStorageProbes(() => readSelection(store, { client, sessionId: source.selection.sessionId }))).state;
    const paused = state?.paused === true;
    const chat = { selection: source.selection, source: source.source };
    // A chat whose capture settings changed since Automatic capture was
    // granted for it waits for review, and the worker refuses it until then:
    // neither capture nor resume chat says Automatic capture covers it. Paused,
    // it is captured by hand and resume chat grants it again under the current
    // settings; a pause, an opt-out, always applies.
    if (automatic && !paused && !state?.safetyStop && tool !== 'pause_capture' && await grantChanged(capability, source, store, state)) fail('REGISTRATION_REQUIRES_REVIEW');
    let outcome;
    // After a safety stop nothing of the chat is captured, in either capture
    // mode, and there is nothing to pause or resume.
    if (state?.safetyStop) outcome = { capture: 'full' };
    else if (tool === 'capture_turns') {
      // A chat Automatic capture covers but has stopped is not covered. A
      // paused chat is captured by hand: a record its own windows cannot read
      // past stops them and the reply says why, while a stop in Automatic
      // capture's own saved progress never reaches them.
      const stop = automatic && !paused ? (await collectionStop(capability, source)).collection?.code : undefined;
      if (automatic && !paused) outcome = { capture: stop ? 'stopped' : 'automatic' };
      else {
        let captured = null;
        // A record the reader cannot read stops every capture of the chat at
        // the same place: the reply names why rather than failing uncertain.
        try { captured = await withStorageProbes(() => captureChatTurns(capability, { ...chat, floor: source.captureFloor, commandUnitId: source.unitId }, { signal, deadline: typedCaptureDeadline(started) })); }
        catch (error) { if (!READER_BLOCK_CODES.includes(error.code) || !COLLECTION_STOP_CODES.includes(error.code)) throw error; outcome = { capture: 'blocked', reason: error.code }; }
        if (captured) {
          const left = captured.leftOut ? { leftOut: captured.leftOut } : {}, held = captured.held ? { reason: captured.held } : {};
          outcome = captured.turns ? { capture: 'captured', turns: captured.turns, more: captured.more, ...left, ...held }
            : captured.held ? { capture: 'blocked', ...held, ...left } : { capture: 'nothing-new', more: captured.more, ...left };
        }
      }
    } else if (!automatic) outcome = { capture: 'not-automatic' };
    else if (tool === 'pause_capture') {
      if (paused) outcome = { capture: 'already-paused' };
      else { await withStorageProbes(() => controlChatCapture(capability, { ...chat, unitId: source.unitId, operation: 'pause' }, { deadline: typedCaptureDeadline(started) })); outcome = { capture: 'paused' }; }
    } else if (!paused) outcome = { capture: 'already-active' };
    else { await withStorageProbes(() => controlChatCapture(capability, { ...chat, unitId: source.unitId, operation: 'resume' }, { deadline: typedCaptureDeadline(started) })); outcome = { capture: 'resumed' }; }
    signal?.throwIfAborted();
    let response = { ...view, ...outcome };
    // The command leaves out its own turn, so a later capture skips it, before
    // its reply is kept: a redelivery then replays whether that worked. In an
    // Automatic chat the worker has not armed yet, the command may precede
    // where its hook froze the session's start, so the worker's boundary does
    // not cover it: it is left out the same way. When the exclusion fails, or
    // the selection has no room for it, the turn stays capturable and the reply
    // says so in its diagnostics.
    let excluded = false;
    try { excluded = (await withStorageProbes(() => excludeChatTurn(capability, { selection: source.selection, source: source.source, unitId: source.unitId }, { signal, deadline: typedCommandDeadline(started) }))).excluded; }
    catch { /* reported below */ }
    if (!excluded) response = { ...response, diagnostics: [...new Set([...response.diagnostics ?? [], 'PROCESSING_EXCLUSION_UNVERIFIED'])].slice(0, 8) };
    // The command has acted. Without its kept reply a redelivery would act
    // again, so no reply is given unless it is kept: the outcome is reported
    // as not certain, and status shows it.
    // The command's own two bookkeeping writes share the time left before its
    // deadline, so the whole command ends within it.
    try { await withStorageProbes(() => recordChatCommandReply(capability, source.selection, call, response, { signal, deadline: typedCommandDeadline(started) })); }
    catch { signal?.throwIfAborted(); fail('PROCESSING_CONTROL_FAILED'); }
    return response;
  }
  // A typed command that failed leaves its own turn out under the same rule
  // as one that succeeded, so a later capture never takes it. Housekeeping:
  // the refusal stands whatever happens here. It answers whether the turn is
  // left out as it should be, so a refusal can say when it may not be.
  async function afterFailure({ source, invocation }) {
    if (!source?.nativeSkill || !source.unitId || !owners.has(source)) return true;
    // A capture command that did not reserve its call changes nothing, however
    // it failed: another delivery may hold the call and own the turn's
    // bookkeeping, and an exclusion here would change the selection it is using.
    if (CAPTURE_TOOLS.includes(invocation.tool) && !reserving.has(source)) return false;
    try {
      const { capability } = selected(source);
      // In a chat Automatic capture covers, a command turn is kept out by its
      // dispatch receipt, and an exclusion here would change the selection a
      // redelivery replays under. Without that receipt the turn stays
      // capturable, which the refusal reports.
      const automatic = await automaticCapture(capability, source);
      if (!(CAPTURE_TOOLS.includes(invocation.tool) || source.captureActive === false || !automatic)) return receipted.has(source);
      return (await withStorageProbes(() => excludeChatTurn(capability, { selection: source.selection, source: source.source, unitId: source.unitId }))).excluded;
    } catch { return false; }
  }
  // Whether the grant the chat's Automatic capture was given, kept with its
  // selection or else its registration, is no longer the current settings'.
  async function grantChanged(capability, source, store, state) {
    const granted = state?.currentGrantHash ?? (await withStorageProbes(() => readRegistration(store, { client, sessionId: source.selection.sessionId },
      { mismatchCode: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' }))).registration?.grantHash;
    return granted != null && granted !== await withStorageProbes(() => workflowCollectionGrant(capability, source.selection));
  }
  async function automaticCapture(capability, source) {
    try { await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'collect')); return true; }
    catch (error) { if (error.code === 'WORKFLOW_NOT_AUTHORIZED') return false; throw error; }
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
      // A chat capture command left out its own turn before its reply was
      // kept, so its reply, first or replayed, already says whether it did.
      if (CAPTURE_TOOLS.includes(invocation.tool)) { await release(); return; }
      // Any other typed command with no receipt to exclude it (in a chat
      // Automatic capture does not cover) leaves out its own turn by an
      // exclusion, so a later capture skips it.
      // An unarmed Automatic chat has no selection to add one to: its first
      // prompt is the boundary the worker excludes. It cannot undo the command:
      // when it fails, or the selection has no room for it, the turn stays
      // capturable and the reply says so in its diagnostics.
      const typed = Boolean(source.nativeSkill && source.unitId);
      const leaveOut = async () => {
        let excluded = false;
        try { excluded = (await withStorageProbes(() => excludeChatTurn(capability, { selection: source.selection, source: source.source, unitId: source.unitId }, { signal }))).excluded; }
        catch { /* reported below */ }
        if (excluded) { await release(); return undefined; }
        const replacement = { ...view, diagnostics: [...new Set([...view.diagnostics, 'PROCESSING_EXCLUSION_UNVERIFIED'])].slice(0, 8) };
        await release(processingControlStatusView(replacement, { collectionId: source.collectionId }));
        return replacement;
      };
      if (!typed || source.captureActive === false) {
        if (typed && (source.selectionHash !== null || !await automaticCapture(capability, source))) return leaveOut();
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
        return leaveOut();
      }
      // A code-mode control was bound through the handshake's first cell; this
      // retry's own native metadata names its cell and nested call.
      const codeMode = source.handshakeResultHash === undefined ? {} : { outerItemId: source.outerItemId,
        retryItemId: context.itemId, retryCallId: context.toolCallId, handshakeResultHash: source.handshakeResultHash };
      // A reply that leaves a draft presented names its exact revision.
      const presented = invocation.tool === 'processing_review' ? pendingPresentations.get(source) : undefined;
      const presentation = presented ? { presentation: { ...presented.revision } } : {};
      const store = await withStorageProbes(() => openWorkflowIntake(capability, source.selection, 'collect'));
      const authorize = async () => { signal?.throwIfAborted(); await assertWorkflowStorage(capability, source.selection, 'collect'); signal?.throwIfAborted(); return true; };
      await withStorageProbes(() => withIntakeLockWaiting(store, tx => recordProcessingControlDispatch(tx, {
        source: source.source, selectionHash: source.selectionHash,
        dispatch: { client, sessionId: source.selection.sessionId, unitId: source.unitId, callId: source.callId,
          tool: source.tool, argsHash: source.argsHash, sourceIdentity: source.source.fileIdentity, sourcePath: source.source.path,
          requestHash: digest(canonicalJSON(invocation.arguments)), skillName: SKILL_NAME, skillPath,
          statusText: view.statusText, resultHash: digest(canonicalJSON(client === 'claude' ? result.content : result)), response: view, ...presentation, ...codeMode,
          ...(client === 'claude' ? Object.fromEntries(['inputId', 'inputHash', 'companionId', 'companionHash', 'skillExpansionHash', 'skillCommand']
            .map(key => [key, source[key]])) : {}) },
      }, { authorize, beforePublish: commitAdmission }), { signal }));
      receipted.add(source);
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
  // The reply naming a presented draft is committed: only now does that
  // attempt count for decisions. Before the reply is written, an attempt
  // another request settled or showed again meanwhile turns the reply into
  // that refusal, so the chat is not told "presented" about a draft it already
  // cannot decide on. Only once the reply was written is the attempt confirmed
  // as delivered: a failed write, a killed process or a failed confirmation
  // leaves the draft undecidable here until it is shown again, never decidable
  // without having been shown.
  async function afterResponse({ source }) {
    const pending = pendingPresentations.get(source);
    if (!pending) return;
    const { capability } = selected(source);
    if (await presentationCurrent(capability, pending)) return;
    pendingPresentations.delete(source);
    fail('PROCESSING_REVIEW_SUPERSEDED');
  }
  async function afterDelivery({ source }) {
    const pending = pendingPresentations.get(source);
    if (!pending) return;
    pendingPresentations.delete(source);
    const { capability } = selected(source);
    await confirmPresentation(capability, { selection: source.selection, ...pending });
  }
  try {
    // With nothing set up for the chat, a status request still gets the command
    // list and the way to set up; nothing is read from or written to storage.
    const unboundStatus = () => ({ status: 'missing', statusDetail: 'unbound', nextAction: 'none',
      diagnostics: ['PROCESSING_CONTROL_SOURCE_UNVERIFIED'], help: true, commandPrefix });
    await runProcessingControlServer({ client, input, output, env, resolveSource, unboundStatus, getStatus: exactOnly(getStatus),
      requestProcessing: exactOnly(requestProcessing), requestResume: exactOnly(requestResume), requestCancel: exactOnly(requestCancel),
      requestReview: exactOnly(requestReview), requestCapture: exactOnly(requestCapture), beforeResponse, afterResponse, afterDelivery, afterFailure });
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
