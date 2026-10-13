import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowConfigPath, readWorkflowSnapshot } from './workflow-config.mjs';
import { verifyWorkflowStorage, assertWorkflowStorage } from './workflow-storage.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { openWorkflowIntake, withIntakeLock, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { readSelection } from './intake-store.mjs';
import { processingSourceDirectory, processingSourcePath, registrationPath, validateRegistration } from './collection-ingress.mjs';
import { recordProcessingControlDispatch, createProcessingControlResolver } from './processing-control-receipts.mjs';
import { resolveProcessingInvocation, isProcessingInvocation, isPendingProcessingInvocation } from './processing-native-invocation.mjs';
import { runProcessingControlServer } from './processing-control-server.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { reviewProcessingProposal } from './processing-host-review.mjs';
import { canonicalJSON, digest, choice, CLIENTS, fail, safeErrorCode } from './workflow-values.mjs';
import { isMain } from './file-io.mjs';

const skillPath = fileURLToPath(new URL('../SKILL.md', import.meta.url));
const diagnostic = Object.freeze({ CREATION_NOT_DISPATCHED: 'PROCESSING_CLIENT_UNAVAILABLE', RUN_ABANDONED: 'PROCESSING_CHAT_OUTCOME_UNKNOWN', CREATION_OUTCOME_UNKNOWN: 'PROCESSING_CHAT_OUTCOME_UNKNOWN',
  DISPATCH_OUTCOME_UNKNOWN: 'PROCESSING_CHAT_OUTCOME_UNKNOWN', HOST_UNAVAILABLE: 'PROCESSING_CHAT_HOST_UNAVAILABLE',
  SESSION_UNAVAILABLE: 'PROCESSING_CHAT_SESSION_UNAVAILABLE', BINDING_CONFLICT: 'PROCESSING_CHAT_BINDING_CHANGED',
  PROCESSING_CHAT_RECONCILIATION_UNPROVEN: 'PROCESSING_CHAT_OUTCOME_UNKNOWN',
  OPERATION_OUTCOME_UNKNOWN: 'PROCESSING_OPERATION_OUTCOME_UNKNOWN',
  PROCESSING_RECOVERY_REQUIRED: 'PROCESSING_RECOVERY_REQUIRED',
  PROCESSING_EXCLUSION_UNVERIFIED: 'PROCESSING_EXCLUSION_UNVERIFIED' });
const viewOf = value => ({ status: value.state, requestId: value.requestId,
  chat: value.chat, nextAction: value.state === 'awaiting-review' ? 'review' : value.state === 'busy' ? 'wait'
    : value.state === 'blocked' ? 'inspect' : ['failed', 'interrupted'].includes(value.nativeStatus) ? 'resume' : 'none', diagnostics: [...new Set([
      ...(value.diagnostics ?? []).map(code => diagnostic[code] ?? 'PROCESSING_CHAT_BLOCKED'),
      ...(value.policyState === 'changed' ? ['WORKFLOW_POLICY_CHANGED'] : []),
      ...(value.nativeStatus === 'failed' ? ['PROCESSING_CLIENT_FAILED'] : value.nativeStatus === 'interrupted' ? ['PROCESSING_CLIENT_INTERRUPTED'] : []),
    ])] });
// Native call identity, not a model-chosen UUID, owns dispatch idempotence. A
// redelivery of the same call replays; a new human invocation remains new work.
function nativeRequestId(source, client) {
  const hash = digest(canonicalJSON({ domain: 'cuefluent-processing-dispatch-v1', client,
    sessionId: source.selection.sessionId, callId: source.callId }));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// Exact metadata locations only. Presence is a candidate hint, never a source
// binding; guarded reads and native verification still own all authority.
async function sourcePresence(collection, context, policyHash) {
  const { client, sessionId } = context;
  const probes = [path.join('sessions', client, ...(client === 'codex' ? [`${sessionId}.json`] : [])),
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
  const jobs = new Map(), owners = new WeakMap(), committedReviews = new WeakMap(), replayed = new WeakMap();
  const openController = dependencies.openController ?? openProcessingController;
  const resolveInvocation = dependencies.resolveInvocation ?? resolveProcessingInvocation;
  async function resolveSource(context, invocation, { signal, requireCompleted } = {}) {
    const selectedConfig = configPath ?? await workflowConfigPath();
    const snapshot = await readWorkflowSnapshot(selectedConfig);
    if (!snapshot.config) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    const requested = invocation.arguments.collectionId;
    if (snapshot.config.collections.length > 64) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    const matches = [], pendingCollections = [];
    for (const collection of snapshot.config.collections) {
      if (requested !== undefined && collection.id !== requested) continue;
      if (requested === undefined && !snapshot.config.routes.some(route => route.collectionId === collection.id && route.clients.includes(client))) continue;
      const presence = await sourcePresence(collection, context, snapshot.hash);
      if (presence === 'registration') { pendingCollections.push(collection); continue; }
      if (requested === undefined && presence === 'missing') continue;
      const options = { configPath: selectedConfig, collectionId: collection.id, expectedConfigHash: snapshot.hash };
      const capability = await verifyWorkflowStorage(options);
      let source;
      try { source = await withStorageProbes(() => resolveInvocation(capability, context, invocation, { skillPath, signal, requireCompleted })); }
      catch (error) {
        if (requested === undefined && error.code === 'PROCESSING_CONTROL_SOURCE_UNVERIFIED') continue;
        throw error;
      }
      if (!isProcessingInvocation(source) && !isPendingProcessingInvocation(source) && !dependencies.resolveInvocation) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      const resolved = Object.freeze({ ...source, collectionId: collection.id });
      owners.set(resolved, { capability, options }); matches.push(resolved);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    // Diagnose only after all real bindings miss. Pending-only metadata cannot
    // prevent a valid match or supply an invocation, even if its JSON is broken.
    const registrationPending = await withStorageProbes(async () => {
      let present = false;
      for (const collection of pendingCollections) {
        const capability = await verifyWorkflowStorage({ configPath: selectedConfig, collectionId: collection.id, expectedConfigHash: snapshot.hash });
        const store = await openWorkflowIntake(capability);
        const record = intakeJSON(await intakeSnapshot(store, 'state', registrationPath(context), { maxBytes: 16384 }));
        if (record === null) continue;
        validateRegistration(record);
        if (record.client !== context.client || record.sessionId !== context.sessionId || record.collectionId !== collection.id) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
        present = true;
      }
      return present;
    });
    fail(registrationPending ? 'PROCESSING_CONTROL_REGISTRATION_PENDING' : 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
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
  async function getStatus({ source }) {
    const { options } = selected(source), key = keyFor(options);
    const job = jobs.get(key);
    if (job) return viewOf(await job.controller.status());
    const controller = await openController({ ...options, client }, { env });
    try { return viewOf(await controller.status()); } finally { await controller.close(); }
  }
  async function requestProcessing({ source, selection, signal }) {
    signal?.throwIfAborted();
    const { options, capability } = selected(source), key = keyFor(options);
    const requestId = nativeRequestId(source, client);
    if ((source.nativeSkill || source.controlExclusionUnsupported) && selection && canonicalJSON({ ...selection, unitId: selection.unitId ?? null }) !== canonicalJSON(source.selection)) {
      fail('PROCESSING_CONTROL_SELECTION_MISMATCH');
    }
    await withStorageProbes(() => assertWorkflowStorage(capability, selection ?? source.selection, 'explicitProcess'));
    const replay = await replayControl(source);
    signal?.throwIfAborted();
    if (replay) return replay;
    const existing = jobs.get(key);
    if (existing) {
      return { ...viewOf(await existing.controller.status()), diagnostics: ['PROCESSING_CHAT_BUSY'] };
    }
    let announce, rejectAdmission, releaseDispatch, rejectDispatch;
    const admission = new Promise((resolve, reject) => { announce = resolve; rejectAdmission = reject; });
    const dispatched = new Promise((resolve, reject) => { releaseDispatch = resolve; rejectDispatch = reject; });
    admission.catch(() => {});
    dispatched.catch(() => {});
    const controller = await openController({ ...options, client }, { env,
      ...dependencies.execution,
      preferHostEnvironment: client === 'claude',
      beforeExecution: async context => {
        signal?.throwIfAborted();
        await dependencies.execution?.beforeExecution?.(context);
        signal?.throwIfAborted();
        announce(viewOf(await controller.status()));
        // The source receipt shares intake state with engine preparation. Finish
        // publishing admission before any native input can start engine work.
        await dispatched;
      },
    });
    let current;
    try { signal?.throwIfAborted(); current = await controller.status(); signal?.throwIfAborted(); }
    catch (error) { await controller.close(); throw error; }
    const cancel = () => { rejectDispatch(signal.reason); rejectAdmission(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
    const job = { controller, promise: null, requestId, releaseDispatch, rejectDispatch }; jobs.set(key, job);
    job.promise = controller.run({ requestId, selection: selection ?? source.selection, expectedChatHash: current.chatHash })
      .then(result => {
        const view = viewOf(result);
        if (result.state === 'busy' && result.requestId !== requestId) view.diagnostics = [...new Set(['PROCESSING_CHAT_BUSY', ...view.diagnostics])];
        announce(view); return view;
      })
      .catch(error => { rejectAdmission(error); return { status: 'blocked', requestId, chat: null, nextAction: 'inspect',
        diagnostics: ['PROCESSING_CHAT_OUTCOME_UNKNOWN'] }; })
      .finally(async () => {
        signal?.removeEventListener('abort', cancel);
        try { await controller.close(); } finally { if (jobs.get(key) === job) jobs.delete(key); }
      });
    // Observe cleanup rejection immediately, even when the originating MCP call
    // has already returned admission. Durable state remains the recovery source.
    job.promise.catch(() => {});
    return admission;
  }
  async function requestReview({ source, elicit, signal, commitResponse }) {
    signal?.throwIfAborted();
    const { options, capability } = selected(source), key = keyFor(options);
    const replay = await replayControl(source);
    signal?.throwIfAborted();
    if (replay) return replay;
    if (jobs.has(key)) return { ...viewOf(await jobs.get(key).controller.status()), diagnostics: ['PROCESSING_CHAT_BUSY'] };
    const controller = await openController({ ...options, client }, { env });
    let response;
    try {
      const status = await controller.status();
      if (status.state !== 'awaiting-review') response = viewOf(status);
      else {
        const context = await controller.reviewContext({ expectedChatHash: status.chatHash, requestId: status.requestId });
        const result = await reviewProcessingProposal(capability, context, { elicit, signal, commitResponse });
        // This internal marker exists only after an authoritative engine result;
        // serialized tool arguments and pending/failed saves cannot create it.
        if (result.status !== 'awaiting-review') {
          committedReviews.set(source, { status: 'completed', requestId: status.requestId, chat: status.chat,
            nextAction: 'inspect', diagnostics: ['PROCESSING_CHAT_CONFLICT'] });
          try {
            response = viewOf(await controller.finishReview({ expectedChatHash: status.chatHash,
              requestId: status.requestId, operationId: context.operationId }));
          } catch { response = committedReviews.get(source); }
        } else {
          response = viewOf(await controller.status());
        }
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
    const job = invocation.tool === 'process_selected_captures' ? jobs.get(keyFor(options)) : null;
    const owned = job?.requestId === nativeRequestId(source, client) ? job : null;
    const release = () => {
      signal?.throwIfAborted();
      // Admission is complete at this synchronous boundary. A later cancellation
      // of this MCP request cannot cancel the separate, already admitted run.
      if (owned) { commitResponse(); owned.releaseDispatch(); }
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
        release();
        return;
      }
      // Explicit processing consent is independent of automatic collection.
      // With collection disabled there is no parent capture to exclude; do not
      // make an optional exclusion receipt a prerequisite for processing.
      try { await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'collect')); }
      catch (error) {
        if (error.code !== 'WORKFLOW_NOT_AUTHORIZED') throw error;
        await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'explicitProcess'));
        release(); return;
      }
      if (source.controlExclusionUnsupported) {
        release();
        return { ...view, diagnostics: [...new Set([...view.diagnostics, 'PROCESSING_EXCLUSION_UNVERIFIED'])].slice(0, 8) };
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
      }, { authorize, beforePublish: commitResponse })));
      release();
    } catch (error) {
      if (error.code === 'STALE_SELECTION' && !signal?.aborted) {
        // Collection progress is not processing consent. Preserve the inspected
        // hash and omit exclusion proof instead of refreshing it through a race.
        try {
          await withStorageProbes(() => assertWorkflowStorage(capability, source.selection, 'explicitProcess'));
          release();
          return { ...view, diagnostics: [...new Set([...view.diagnostics, 'PROCESSING_EXCLUSION_UNVERIFIED'])].slice(0, 8) };
        } catch (freshError) { error = freshError; }
      }
      owned?.rejectDispatch(error);
      // Receipt/registry housekeeping cannot undo an engine disposition. A
      // failed receipt supplies no exclusion proof and is never retried here.
      if (invocation.tool === 'processing_review' && committedReviews.has(source)) return committedReviews.get(source);
      throw error;
    }
  }
  try {
    await runProcessingControlServer({ client, input, output, env, resolveSource, getStatus, requestProcessing, requestReview, beforeResponse });
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
