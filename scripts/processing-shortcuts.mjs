import { processingScope, pendingCollectionProcessing } from './processing-collection.mjs';
import { createProcessingWorkset, inspectProcessingWorkset } from './processing-workset.mjs';
import { inspectProcessing, completeProcessing } from './processing.mjs';
import { readProcessingState, withProcessingState, processingSnapshot, writeProcessingJSON } from './processing-state.mjs';
import { intakeJSON } from './intake-io.mjs';
import { logicalCaptureIdentity } from './capture-contract.mjs';
import { unitKey } from './capture-retention.mjs';
import { normalizeWorkflowSelection } from './workflow-selection.mjs';
import { validateProcessingSelection } from './processing-contract.mjs';
import { assertWorkflowStorage } from './workflow-storage.mjs';
import { keys, nativeId, hash, list, unique, choice, canonicalJSON, digest, fail } from './workflow-values.mjs';

const checkpointFile = ctx => `processed/shortcuts/${ctx.bindingHash}.json`;
const controlFile = (ctx, id) => `processed/shortcut-controls/${ctx.bindingHash}/${id}.json`;
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const reference = input => ({ identity: { ...input.identity }, headHash: input.headHash });
const refKey = input => `${unitKey(input.identity)}/${input.headHash}`;
const worksetIdFor = (id, index) => {
  const text = digest(canonicalJSON({ domain: 'cuefluent-shortcut-workset-v1', id, index }));
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
};
function validate(value, ctx) {
  keys(value, ['format', 'version', 'id', 'bindingHash', 'policyHash', 'selection', 'scope', 'phase',
    'inputs', 'operationIds', 'worksetIds', 'after', 'incomplete']);
  if (value.format !== 'cuefluent-processing-shortcut' || value.version !== 1 || value.bindingHash !== ctx.bindingHash) fail('INVALID_PROCESSING_SHORTCUT');
  nativeId(value.id); hash(value.bindingHash); hash(value.policyHash); validateProcessingSelection(value.selection);
  choice(value.phase, ['discovering', 'ready', 'cancelling', 'cancelled']);
  choice(value.scope?.kind, ['collection', 'repo', 'chat']);
  keys(value.scope, value.scope.kind === 'collection' ? ['kind'] : value.scope.kind === 'repo' ? ['kind', 'root'] : ['kind', 'client', 'sessionId', 'unitId']);
  if (value.scope.kind === 'repo' && (typeof value.scope.root !== 'string' || value.scope.root.length > 4096)) fail('INVALID_PROCESSING_SHORTCUT');
  if (value.scope.kind === 'chat') {
    choice(value.scope.client, ['codex', 'claude']); nativeId(value.scope.sessionId);
    if (value.scope.unitId !== null) nativeId(value.scope.unitId);
  }
  list(value.inputs, 100).forEach(input => { keys(input, ['identity', 'headHash']); logicalCaptureIdentity(input.identity); hash(input.headHash); });
  unique(value.inputs.map(input => unitKey(input.identity)));
  list(value.operationIds, 100).forEach(nativeId); unique(value.operationIds);
  list(value.worksetIds, 10).forEach((id, index) => { nativeId(id); if (id !== worksetIdFor(value.id, index)) fail('INVALID_PROCESSING_SHORTCUT'); });
  if (value.after !== null) {
    keys(value.after, ['scopeHash', 'client', 'sessionId', 'unitId']); hash(value.after.scopeHash);
    choice(value.after.client, ['codex', 'claude']); nativeId(value.after.sessionId);
    if (value.after.unitId !== null) nativeId(value.after.unitId);
  }
  if (typeof value.incomplete !== 'boolean' || (!value.incomplete && value.after !== null)) fail('INVALID_PROCESSING_SHORTCUT');
  return value;
}
async function load(ctx) {
  const saved = await processingSnapshot(ctx, checkpointFile(ctx));
  const value = saved.bytes ? validate(intakeJSON(saved), ctx) : null;
  if (saved.bytes && !saved.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('INVALID_PROCESSING_SHORTCUT');
  return { hash: saved.hash, value };
}
async function write(capability, selection, saved, value) {
  return withProcessingState(capability, selection, 'explicitProcess', async ctx => {
    if ((await load(ctx)).hash !== saved.hash) fail('PROCESSING_SHORTCUT_CHANGED');
    validate(value, ctx);
    const result = await writeProcessingJSON(ctx, checkpointFile(ctx), value, saved.hash);
    return { hash: result.hash, value };
  });
}

/** A checkpoint holds only frozen selection and continuation pointers. Claims,
 * page acknowledgements, proposals, outcomes and writes belong to the existing
 * engine; this file cannot mark an input processed or authorize a note save. */
async function project(capability, saved) {
  const value = saved.value;
  if (!value) return { interfaceVersion: 1, checkpointHash: null, requestId: null, phase: 'missing', scope: null,
    operations: [], worksets: [], nextRun: null, incomplete: false, sourceCompleteness: 'unknown' };
  const operations = [];
  for (const operationId of value.operationIds) operations.push(await inspectProcessing(capability, operationId));
  const worksets = [], items = new Map(value.inputs.map(input => [refKey(input), { input, state: 'unattempted' }]));
  for (const worksetId of value.worksetIds) {
    const workset = await inspectProcessingWorkset(capability, { worksetId });
    if (!equal(workset.selection, value.selection) || workset.inputs.some(input => !items.has(refKey(input)))) fail('PROCESSING_SELECTION_CHANGED');
    worksets.push(workset);
    for (const item of workset.items) items.set(refKey(workset.inputs[item.index]), { ...item, input: workset.inputs[item.index] });
    operations.push(...workset.operations);
  }
  const unfinished = operations.filter(item => !item.outcome || item.recoveryRequired);
  const blockers = unfinished.flatMap(item => [...(item.blockers ?? []), ...(item.conflict ? [item.conflict] : []),
    ...(item.recoveryRequired ? ['PROCESSING_RECOVERY_REQUIRED'] : [])]);
  const reviews = unfinished.filter(item => item.state === 'awaiting-review');
  const last = worksets.at(-1);
  const resumed = unfinished.find(item => value.operationIds.includes(item.operationId));
  const pending = [...items.values()].filter(item => item.state === 'unattempted');
  const counts = { selected: items.size, unattempted: pending.length,
    unavailable: [...items.values()].filter(item => item.conflict).length,
    cancelled: [...items.values()].filter(item => item.state === 'cancelled').length,
    handled: [...items.values()].filter(item => ['saved', 'skipped', 'unchanged', 'handled-elsewhere'].includes(item.state)).length,
    unfinishedOperations: unfinished.length, awaitingReview: reviews.length };
  const nextRun = value.phase !== 'ready' || blockers.length || reviews.length ? null
    : resumed ? { resumeOperationId: resumed.operationId }
      : last && (last.operations.some(item => !item.outcome) || (!last.budgetExhausted && last.inputCounts.unattempted)) ? { worksetId: last.worksetId } : null;
  return { interfaceVersion: 1, checkpointHash: saved.hash, requestId: value.id, phase: value.phase, scope: value.scope,
    policyHash: value.policyHash, selection: value.selection, operations, worksets, counts,
    blockers: [...new Set(blockers)], reviews, nextRun, incomplete: value.incomplete,
    continuationNeeded: value.phase === 'ready' && !resumed && !unfinished.length && pending.length > 0 &&
      (!last || last.budgetExhausted || last.remainingPacketBytes < 4 * 1024 * 1024),
    sourceCompleteness: 'unknown' };
}

export async function inspectProcessingShortcut(capability, { selection }) {
  selection = await normalizeWorkflowSelection(selection);
  const ctx = await readProcessingState(capability, selection, 'explicitProcess'), saved = await load(ctx);
  const result = await project(capability, saved);
  if ((await load(ctx)).hash !== saved.hash) fail('PROCESSING_SHORTCUT_CHANGED');
  await ctx.guard();
  return { ...result, policyState: !saved.value || saved.value.policyHash === ctx.policyHash ? 'current' : 'changed' };
}

/** One bounded metadata pass. A new process action may start a fresh selection;
 * resume only advances the existing checkpoint and never adds new evidence after
 * it becomes ready. Earlier unhandled operations keep their original selections. */
export async function selectProcessingShortcut(capability, { selection, requestId, scope = 'collection', mode = 'process' }, { canResumeOperation = async () => false } = {}) {
  selection = await normalizeWorkflowSelection(selection); nativeId(requestId); choice(mode, ['process', 'resume']);
  const selectedScope = await processingScope(selection, scope);
  const ctx = await readProcessingState(capability, selection, 'explicitProcess');
  let saved = await load(ctx), previous = await project(capability, saved);
  if (saved.value?.phase === 'cancelling') fail('PROCESSING_CANCELLATION_PENDING');
  const continuing = saved.value && saved.value.phase !== 'cancelled' &&
    (saved.value.phase === 'discovering' || previous.nextRun || previous.continuationNeeded || previous.reviews.length || previous.blockers.length || previous.counts.unavailable);
  if (continuing) {
    if (saved.value.policyHash !== ctx.policyHash) fail('WORKFLOW_POLICY_CHANGED');
    if (mode === 'process' && scope !== 'collection' && !equal(selectedScope, saved.value.scope)) {
      if (previous.reviews.length) return { ...previous, nextRun: null, reason: 'review' };
      fail('PROCESSING_SHORTCUT_SCOPE_CONFLICT');
    }
    for (const operation of previous.operations.filter(item => saved.value.operationIds.includes(item.operationId) && !item.outcome)) {
      if (!await canResumeOperation(operation.operationId)) return { ...previous, nextRun: null,
        blockers: ['PROCESSING_OPERATION_OWNER_UNVERIFIED'] };
    }
    await assertWorkflowStorage(capability, saved.value.selection, 'explicitProcess');
  } else {
    if (saved.value?.id === requestId) return previous; // Exact completed request replay never expands its scope.
    const inventory = await pendingCollectionProcessing(capability, { selection, scope, limit: 1 });
    if (inventory.blockers.length) return { ...previous, blockers: inventory.blockers, nextRun: null, reason: 'recovery' };
    if (inventory.operations.some(item => item.state === 'awaiting-review')) return { ...previous, nextRun: null,
      reviews: inventory.operations.filter(item => item.state === 'awaiting-review'), reason: 'review' };
    if (inventory.operations.some(item => item.scopeMatch !== 'full')) fail('PROCESSING_SHORTCUT_SCOPE_CONFLICT');
    for (const operation of inventory.operations) if (!await canResumeOperation(operation.operationId)) return {
      ...previous, nextRun: null, blockers: ['PROCESSING_OPERATION_OWNER_UNVERIFIED'], reason: 'owner-unverified' };
    const operationIds = inventory.operations.map(item => item.operationId);
    if (mode === 'resume' && !operationIds.length) return { ...previous, nextRun: null, reason: 'nothing-to-resume' };
    // Cursor continuation is for a fresh explicit process request only. Resume
    // after a finished frozen selection never discovers later arrivals.
    const after = mode === 'process' && saved.value && saved.value.phase !== 'cancelled' &&
      saved.value.policyHash === ctx.policyHash && equal(saved.value.scope, selectedScope) ? saved.value.after : null;
    saved = await write(capability, selection, saved, { format: 'cuefluent-processing-shortcut', version: 1,
      id: requestId, bindingHash: ctx.bindingHash, policyHash: ctx.policyHash, selection, scope: selectedScope,
      phase: mode === 'resume' ? 'ready' : 'discovering', inputs: [], operationIds, worksetIds: [],
      after, incomplete: after !== null });
  }
  if (saved.value.phase === 'discovering') {
    let value = structuredClone(saved.value);
    // Bound the scan even across long handled prefixes. Persist progress instead
    // of falsely reporting an empty collection or rediscovering the prefix forever.
    for (let page = 0; page < 4 && value.inputs.length < 100; page++) {
      const inventory = await pendingCollectionProcessing(capability, { selection: value.selection,
        scope: value.scope.kind, limit: 100 - value.inputs.length, after: value.after });
      if (!equal(inventory.scope, value.scope)) fail('PROCESSING_SHORTCUT_SCOPE_CONFLICT');
      if (inventory.blockers.length) return { ...await project(capability, saved), blockers: inventory.blockers, nextRun: null, reason: 'recovery' };
      if (inventory.operations.some(item => item.state === 'awaiting-review')) return { ...await project(capability, saved), nextRun: null,
        reviews: inventory.operations.filter(item => item.state === 'awaiting-review'), reason: 'review' };
      if (inventory.operations.some(item => item.scopeMatch !== 'full')) fail('PROCESSING_SHORTCUT_SCOPE_CONFLICT');
      for (const operation of inventory.operations) if (!await canResumeOperation(operation.operationId)) return {
        ...await project(capability, saved), nextRun: null, blockers: ['PROCESSING_OPERATION_OWNER_UNVERIFIED'], reason: 'owner-unverified' };
      value.operationIds = [...new Set([...value.operationIds, ...inventory.operations.map(item => item.operationId)])];
      for (const input of inventory.pending.filter(item => item.status === 'pending')) {
        if (!value.inputs.some(item => unitKey(item.identity) === unitKey(input.identity))) value.inputs.push(reference(input));
      }
      value.after = inventory.nextCursor; value.incomplete = inventory.incomplete;
      if (value.inputs.length >= 100 || !value.incomplete) { value.phase = 'ready'; break; }
    }
    if (value.inputs.length) value.phase = 'ready';
    saved = await write(capability, selection, saved, value);
  }
  let result = await project(capability, saved);
  if (saved.value.phase === 'ready' && result.continuationNeeded && !result.blockers.length && !result.reviews.length) {
    const last = result.worksets.at(-1);
    const inputs = last ? last.items.filter(item => item.state === 'unattempted').map(item => last.inputs[item.index]) : saved.value.inputs;
    if (inputs.length) {
      if (saved.value.worksetIds.length >= 10) fail('PROCESSING_SHORTCUT_CAPACITY');
      const worksetId = worksetIdFor(saved.value.id, saved.value.worksetIds.length);
      // Creating a selection does not claim inputs. A crash before the pointer
      // write retries this exact deterministic workset without replacing bytes.
      await createProcessingWorkset(capability, { selection: saved.value.selection, worksetId, inputs,
        runBudget: { maxBatches: 20, maxPacketBytes: 16 * 1024 * 1024 }, unscannedRemainder: saved.value.incomplete });
      saved = await write(capability, selection, saved, { ...saved.value, worksetIds: [...saved.value.worksetIds, worksetId] });
      result = await project(capability, saved);
    }
  }
  if ((await load(ctx)).hash !== saved.hash) fail('PROCESSING_SHORTCUT_CHANGED');
  await ctx.guard();
  return result;
}

/** The transport must separately prove that native execution has stopped before
 * cancellation. This entry point has no model/transport authority. A caller's
 * serialized "stopped" boolean would not constitute such proof. */
export async function cancelProcessingShortcut(capability, { selection, expectedCheckpointHash }, { assertStopped, canResumeOperation = async () => false } = {}) {
  selection = await normalizeWorkflowSelection(selection); hash(expectedCheckpointHash);
  if (typeof assertStopped !== 'function') fail('PROCESSING_CANCEL_UNVERIFIED');
  const ctx = await readProcessingState(capability, selection, 'explicitProcess');
  let saved = await load(ctx);
  if (!saved.value || saved.hash !== expectedCheckpointHash) fail('PROCESSING_SHORTCUT_CHANGED');
  if (saved.value.phase === 'cancelled') return project(capability, saved);
  await assertStopped();
  const before = await project(capability, saved);
  for (const operation of before.operations.filter(item => saved.value.operationIds.includes(item.operationId) && !item.outcome)) {
    if (!await canResumeOperation(operation.operationId)) fail('PROCESSING_CANCEL_UNVERIFIED');
  }
  saved = await write(capability, selection, saved, { ...saved.value, phase: 'cancelling' });
  const current = await project(capability, saved);
  for (const operation of current.operations) {
    if (operation.outcome && !operation.recoveryRequired) continue;
    if (operation.admissionPending && !operation.claimHash) continue;
    if (operation.recoveryRequired) fail('PROCESSING_RECOVERY_REQUIRED');
    if (!operation.selection || !operation.claimHash) fail('PROCESSING_CANCEL_UNVERIFIED');
    await assertStopped();
    await completeProcessing(capability, { selection: operation.selection, operationId: operation.operationId,
      expectedClaimHash: operation.claimHash, outcome: 'cancelled' });
  }
  await assertStopped();
  saved = await write(capability, selection, saved, { ...saved.value, phase: 'cancelled' });
  return project(capability, saved);
}

/** Native control idempotence is independent from capture-exclusion receipts.
 * In particular, a redelivered Cancel while collection is off must not target a
 * newer request. Only the internal native adapter supplies these call identities. */
export async function beginProcessingShortcutControl(capability, { selection, requestId, action, argsHash }) {
  selection = await normalizeWorkflowSelection(selection); nativeId(requestId); hash(argsHash);
  choice(action, ['process', 'resume', 'cancel']);
  return withProcessingState(capability, selection, 'explicitProcess', async ctx => {
    const file = controlFile(ctx, requestId), saved = await processingSnapshot(ctx, file);
    if (saved.bytes) {
      const value = intakeJSON(saved);
      keys(value, ['format', 'version', 'requestId', 'bindingHash', 'policyHash', 'selection', 'action', 'argsHash', 'targetRequestId', 'response']);
      if (value.format !== 'cuefluent-shortcut-control' || value.version !== 1 || value.requestId !== requestId ||
          value.bindingHash !== ctx.bindingHash || value.policyHash !== ctx.policyHash || !equal(value.selection, selection) ||
          value.action !== action || value.argsHash !== argsHash || !saved.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('PROCESSING_CONTROL_RECEIPT_CONFLICT');
      if (value.targetRequestId !== null) nativeId(value.targetRequestId);
      const current = await load(ctx);
      if (value.response === null && current.value && ![requestId, value.targetRequestId].includes(current.value.id)) fail('PROCESSING_SHORTCUT_CHANGED');
      return { ...value, controlHash: saved.hash };
    }
    const current = await load(ctx);
    const value = { format: 'cuefluent-shortcut-control', version: 1, requestId, bindingHash: ctx.bindingHash,
      policyHash: ctx.policyHash, selection, action, argsHash, targetRequestId: current.value?.id ?? null, response: null };
    const written = await writeProcessingJSON(ctx, file, value, null);
    return { ...value, controlHash: written.hash };
  });
}
export async function finishProcessingShortcutControl(capability, control, response, { beforePublish } = {}) {
  // response is the bounded public projection, not arbitrary model text.
  if (Buffer.byteLength(canonicalJSON(response)) > 16 * 1024) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
  return withProcessingState(capability, control.selection, 'explicitProcess', async ctx => {
    const file = controlFile(ctx, nativeId(control.requestId)), saved = await processingSnapshot(ctx, file);
    if (saved.hash !== control.controlHash) fail('PROCESSING_CONTROL_RECEIPT_CONFLICT');
    const { controlHash: _hash, ...value } = control;
    if (!equal(intakeJSON(saved), value)) fail('PROCESSING_CONTROL_RECEIPT_CONFLICT');
    if (value.response !== null) { if (!equal(value.response, response)) fail('PROCESSING_CONTROL_RECEIPT_CONFLICT'); return; }
    await writeProcessingJSON(ctx, file, { ...value, response: structuredClone(response) }, saved.hash, { beforePublish });
  });
}

// Called under the intake lock used by native reserve/begin. Cancelling writes
// use that same lock, so no native admission can race claim release.
export async function assertProcessingShortcutExecution(capability, request = {}) {
  const ctx = await readProcessingState(capability), saved = await load(ctx);
  if (saved.value?.phase === 'cancelling') fail('PROCESSING_CANCELLATION_PENDING');
  if (saved.value?.phase === 'cancelled' &&
      (saved.value.worksetIds.includes(request.worksetId) || saved.value.operationIds.includes(request.resumeOperationId))) {
    fail('PROCESSING_CANCELLATION_PENDING');
  }
}
