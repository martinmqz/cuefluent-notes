import { normalizeWorkflowSelection } from './workflow-selection.mjs';
import { logicalCaptureIdentity } from './capture-contract.mjs';
import { unitKey, readTombstone, dispositionPath, validateProcessingDisposition } from './capture-retention.mjs';
import { intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { readProcessingState, withProcessingState, processingSnapshot, writeProcessingJSON, processingNamePage } from './processing-state.mjs';
import { claimPath, operationPath, PROCESSING_INTERFACE_VERSION, validateProcessingSelection } from './processing-contract.mjs';
import { describeProcessingOperation, prepareProcessingInState, processingBudget, activeProcessingClaims } from './processing.mjs';
import { keys, nativeId, hash, integer, list, unique, timestamp, canonicalJSON, digest, fail } from './workflow-values.mjs';

const file = id => `processed/worksets/${nativeId(id)}.json`;
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const defaults = { maxBatches: 5, maxPacketBytes: 320 * 1024 };
function budget(value = defaults) {
  keys(value, ['maxBatches', 'maxPacketBytes']); integer(value.maxBatches); integer(value.maxPacketBytes);
  if (value.maxBatches < 1 || value.maxBatches > 20 || value.maxPacketBytes < 1 || value.maxPacketBytes > 16 * 1024 * 1024) fail('INVALID_WORKSET_BUDGET');
  return { ...value };
}
function references(inputs) {
  list(inputs, 100, { empty: false }).forEach(input => {
    keys(input, ['identity', 'headHash']); logicalCaptureIdentity(input.identity); hash(input.headHash);
  });
  unique(inputs.map(input => unitKey(input.identity))); return inputs;
}
function indexesOf(indexes, inputs) {
  list(indexes, 20, { empty: false }).forEach(index => { integer(index); if (index >= inputs.length) fail('INVALID_WORKSET_INDEX'); });
  unique(indexes); return [...indexes].sort((a, b) => a - b);
}
function operationFor(worksetId, indexes) {
  const value = digest(canonicalJSON({ domain: 'cuefluent-workset-operation-v1', worksetId, indexes }));
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
function validate(value, ctx, worksetId) {
  keys(value, ['format', 'version', 'worksetId', 'bindingHash', 'policyHash', 'selection', 'createdAt', 'inputs', 'budget', 'unscannedRemainder', 'attempts']);
  if (value.format !== 'cuefluent-processing-workset' || value.version !== 1 || value.worksetId !== worksetId || value.bindingHash !== ctx.bindingHash) fail('INVALID_PROCESSING_WORKSET');
  nativeId(worksetId); hash(value.bindingHash); hash(value.policyHash); timestamp(value.createdAt); validateProcessingSelection(value.selection);
  references(value.inputs); budget(value.budget);
  if (value.unscannedRemainder !== null && typeof value.unscannedRemainder !== 'boolean') fail('INVALID_PROCESSING_WORKSET');
  list(value.attempts, value.budget.maxBatches).forEach(attempt => {
    keys(attempt, ['operationId', 'indexes', 'packetHash', 'packetBytes']);
    nativeId(attempt.operationId); hash(attempt.packetHash); integer(attempt.packetBytes);
    if (attempt.packetBytes < 1 || attempt.packetBytes > 4 * 1024 * 1024 ||
        !equal(indexesOf(attempt.indexes, value.inputs), attempt.indexes) || attempt.operationId !== operationFor(worksetId, attempt.indexes)) fail('INVALID_PROCESSING_WORKSET');
  });
  unique(value.attempts.flatMap(attempt => attempt.indexes));
  if (value.attempts.reduce((n, attempt) => n + attempt.packetBytes, 0) > value.budget.maxPacketBytes) fail('INVALID_PROCESSING_WORKSET');
  return value;
}
async function load(ctx, worksetId, expectedHash) {
  nativeId(worksetId);
  try {
    const snapshot = await processingSnapshot(ctx, file(worksetId));
    if (!snapshot.bytes) fail('PROCESSING_WORKSET_MISSING');
    if (expectedHash !== undefined && snapshot.hash !== hash(expectedHash)) fail('PROCESSING_WORKSET_CHANGED');
    const value = validate(intakeJSON(snapshot), ctx, worksetId);
    return { value, hash: snapshot.hash };
  } catch (error) { error.worksetId = worksetId; throw error; }
}
const view = (value, worksetHash) => ({ interfaceVersion: PROCESSING_INTERFACE_VERSION, worksetId: value.worksetId, worksetHash,
  selection: { ...value.selection }, inputs: value.inputs.map(input => ({ identity: { ...input.identity }, headHash: input.headHash })),
  createdAt: value.createdAt, budget: { ...value.budget }, unscannedRemainder: value.unscannedRemainder,
  chargedBatches: value.attempts.length, chargedPacketBytes: value.attempts.reduce((n, attempt) => n + attempt.packetBytes, 0) });

/** Freeze an explicitly selected list, never a promise of a globally atomic queue. */
export async function createProcessingWorkset(capability, { selection, worksetId, inputs, runBudget, unscannedRemainder = null }) {
  selection = await normalizeWorkflowSelection(selection); nativeId(worksetId); references(inputs);
  const valueBudget = budget(runBudget);
  return withProcessingState(capability, selection, 'explicitProcess', async ctx => {
    const prior = await processingSnapshot(ctx, file(worksetId));
    if (prior.bytes) {
      const saved = await load(ctx, worksetId);
      if (!equal(saved.value.selection, selection) || !equal(saved.value.inputs, inputs) || !equal(saved.value.budget, valueBudget) || saved.value.unscannedRemainder !== unscannedRemainder) fail('PROCESSING_WORKSET_CONFLICT');
      return view(saved.value, saved.hash);
    }
    const value = validate({ format: 'cuefluent-processing-workset', version: 1, worksetId, bindingHash: ctx.bindingHash,
      policyHash: ctx.policyHash, selection, createdAt: new Date().toISOString(), inputs, budget: valueBudget, unscannedRemainder, attempts: [] }, ctx, worksetId);
    for (const input of inputs) if ((await intakeSnapshot(ctx.store, 'state', `heads/${unitKey(input.identity)}.json`)).hash !== input.headHash) fail('PROCESSING_HEAD_CHANGED');
    const saved = await writeProcessingJSON(ctx, file(worksetId), value, null);
    return view(value, saved.hash);
  });
}

export async function prepareWorksetBatch(capability, { worksetId, expectedWorksetHash, indexes, batchBudget, parallelism = 1 }, options = {}) {
  nativeId(worksetId); hash(expectedWorksetHash); let limits = processingBudget(batchBudget);
  const initial = await readProcessingState(capability, null, 'maintenance');
  const selected = await load(initial, worksetId, expectedWorksetHash);
  return withProcessingState(capability, selected.value.selection, 'explicitProcess', async ctx => {
    const saved = await load(ctx, worksetId, expectedWorksetHash), { value } = saved;
    if (value.policyHash !== ctx.policyHash) fail('WORKFLOW_POLICY_CHANGED');
    indexes = indexesOf(indexes, value.inputs);
    const operationId = operationFor(worksetId, indexes), attempt = value.attempts.find(item => item.operationId === operationId);
    // A pre-claim crash retains the already selected workload as well as its hash.
    if (attempt && batchBudget === undefined) limits = { maxInputs: indexes.length, maxPacketBytes: attempt.packetBytes };
    if (!attempt && value.attempts.some(item => item.indexes.some(index => indexes.includes(index)))) fail('WORKSET_INPUT_ALREADY_ATTEMPTED');
    if (!attempt && ((await processingSnapshot(ctx, claimPath(operationId))).bytes || (await processingSnapshot(ctx, operationPath(operationId))).bytes)) fail('PROCESSING_OPERATION_CONFLICT');
    if (!attempt && (value.attempts.length >= value.budget.maxBatches || view(value).chargedPacketBytes >= value.budget.maxPacketBytes)) fail('PROCESSING_WORKSET_BUDGET');
    const result = await prepareProcessingInState(ctx, { operationId, inputs: indexes.map(index => value.inputs[index]), budget: limits, parallelism }, {
      beforePublish: async claim => {
        if (attempt) {
          if (attempt.packetHash !== claim.packet.hash || attempt.packetBytes !== claim.packet.bytes) fail('PROCESSING_WORKSET_CHANGED');
          return;
        }
        if (view(value).chargedPacketBytes + claim.packet.bytes > value.budget.maxPacketBytes) fail('PROCESSING_WORKSET_BUDGET');
        value.attempts.push({ operationId, indexes, packetHash: claim.packet.hash, packetBytes: claim.packet.bytes });
        await writeProcessingJSON(ctx, file(worksetId), value, saved.hash);
        await options.fault?.('workset-admission');
      }
    });
    const admitted = value.attempts.find(item => item.operationId === operationId);
    if (!admitted || result.packet.hash !== admitted.packetHash || result.packet.bytes !== admitted.packetBytes) fail('PROCESSING_WORKSET_CHANGED');
    const current = await load(ctx, worksetId);
    return { ...result, workset: view(current.value, current.hash) };
  });
}

export async function inspectProcessingWorkset(capability, { worksetId }) {
  const ctx = await readProcessingState(capability, null, 'maintenance'), saved = await load(ctx, worksetId), { value } = saved;
  const operations = [];
  for (const attempt of value.attempts) {
    const { claim, ...status } = await describeProcessingOperation(ctx, attempt.operationId);
    operations.push({ ...status, indexes: attempt.indexes, admissionPending: status.state === 'missing' });
  }
  const claims = await activeProcessingClaims(ctx), items = [];
  for (let index = 0; index < value.inputs.length; index++) {
    const input = value.inputs[index], operation = operations.find(item => item.indexes.includes(index));
    const doneSnapshot = await processingSnapshot(ctx, dispositionPath(input.identity, input.headHash, ctx.bindingHash));
    const done = doneSnapshot.bytes ? validateProcessingDisposition(intakeJSON(doneSnapshot)) : null;
    if (done && (done.bindingHash !== ctx.bindingHash || done.headHash !== input.headHash || !equal(done.identity, input.identity))) fail('STALE_PROCESSING_DISPOSITION');
    const owners = claims.filter(item => item.claim.inputs.some(ref => unitKey(ref.identity) === unitKey(input.identity)));
    if (owners.length > 1) fail('PROCESSING_CLAIM_CONFLICT');
    const owner = owners[0]?.claim;
    const changed = (await intakeSnapshot(ctx.store, 'state', `heads/${unitKey(input.identity)}.json`)).hash !== input.headHash;
    const pruned = Boolean(await readTombstone(ctx.store, input.identity));
    const blocked = value.policyHash !== ctx.policyHash ? 'WORKFLOW_POLICY_CHANGED' : pruned ? 'CAPTURE_PRUNED' : changed ? 'PROCESSING_HEAD_CHANGED'
      : owner && owner.operationId !== operation?.operationId ? 'PROCESSING_INPUT_CLAIMED' : null;
    const elsewhere = done && done.operationId !== operation?.operationId;
    // Input disposition is current; operation outcomes remain historical. A
    // cancelled attempt must not hide a later exact save or a new claim owner.
    const state = elsewhere ? 'handled-elsewhere' : operation?.outcome === 'cancelled' ? blocked ? 'blocked' : 'cancelled'
      : operation?.outcome ?? (blocked ? 'blocked' : operation ? operation.admissionPending ? 'admission-pending' : operation.state : 'unattempted');
    items.push({ index, state, operationId: operation?.operationId ?? null,
      externalOperationId: elsewhere ? done.operationId : owner && owner.operationId !== operation?.operationId ? owner.operationId : null,
      externalOutcome: elsewhere ? done.outcome : null,
      conflict: elsewhere || (operation?.outcome && operation.outcome !== 'cancelled') ? null : blocked ?? operation?.conflict ?? null });
  }
  for (const operation of operations.filter(item => item.admissionPending)) {
    const members = items.filter(item => operation.indexes.includes(item.index));
    const blocker = members.find(item => item.conflict || item.state === 'handled-elsewhere');
    if (blocker) Object.assign(operation, { state: 'blocked', conflict: blocker.conflict ?? 'PROCESSING_INPUT_ALREADY_HANDLED', nextAction: { command: null, reason: 'resolve-conflict' } });
  }
  if ((await processingSnapshot(ctx, file(worksetId))).hash !== saved.hash) fail('PROCESSING_WORKSET_CHANGED');
  await ctx.guard();
  const summary = view(value, saved.hash);
  // Each group is an independent dimension; its buckets do not overlap.
  const operationCounts = { recoveryRequired: 0, terminal: 0, awaitingReview: 0, blocked: 0, admissionPending: 0, inspection: 0 };
  const outcomeCounts = { saved: 0, unchanged: 0, skipped: 0, cancelled: 0 };
  for (const operation of operations) {
    const bucket = operation.recoveryRequired ? 'recoveryRequired' : operation.outcome ? 'terminal' : operation.state === 'awaiting-review' ? 'awaitingReview'
      : ['blocked', 'conflicted'].includes(operation.state) ? 'blocked' : operation.admissionPending ? 'admissionPending' : 'inspection';
    operationCounts[bucket]++;
    if (operation.outcome) outcomeCounts[operation.outcome]++;
  }
  const inputCounts = { unattempted: 0, blocked: 0, handledElsewhere: 0, handled: 0, cancelled: 0, awaitingReview: 0, inProgress: 0 };
  for (const item of items) {
    const bucket = item.state === 'unattempted' ? 'unattempted' : item.state === 'handled-elsewhere' ? 'handledElsewhere'
      : ['saved', 'unchanged', 'skipped'].includes(item.state) ? 'handled' : item.state === 'cancelled' ? 'cancelled'
      : item.conflict || ['blocked', 'conflicted'].includes(item.state) ? 'blocked' : item.state === 'awaiting-review' ? 'awaitingReview' : 'inProgress';
    inputCounts[bucket]++;
  }
  return { ...summary, items, operations, operationCounts, outcomeCounts, inputCounts,
    remainingSelected: inputCounts.unattempted + inputCounts.blocked + inputCounts.cancelled,
    remainingPacketBytes: value.budget.maxPacketBytes - summary.chargedPacketBytes,
    budgetExhausted: summary.chargedBatches >= value.budget.maxBatches || summary.chargedPacketBytes >= value.budget.maxPacketBytes,
    sourceCompleteness: 'unknown', scope: 'frozen-selection-only' };
}

/** Recover durable selections through the supported interface after the caller
 * loses conversational context. Filtering does not change lexical page bounds. */
export async function listProcessingWorksets(capability, { selection = null, limit = 20, afterWorksetId = null } = {}) {
  integer(limit); if (limit < 1 || limit > 100) fail('INVALID_PENDING_LIMIT');
  if (afterWorksetId !== null) nativeId(afterWorksetId);
  if (selection !== null) selection = await normalizeWorkflowSelection(selection);
  const ctx = await readProcessingState(capability, null, 'maintenance');
  const page = await processingNamePage(ctx, 'processed/worksets', { limit, afterId: afterWorksetId }), worksets = [], snapshots = [];
  for (const worksetId of page.ids) {
    const snapshot = await processingSnapshot(ctx, file(worksetId));
    if (!snapshot.bytes) fail('PROCESSING_INVENTORY_CHANGED');
    let value;
    try {
      value = intakeJSON(snapshot); hash(value?.bindingHash);
      if (value.bindingHash === ctx.bindingHash) validate(value, ctx, worksetId);
    } catch (error) { error.worksetId = worksetId; throw error; }
    snapshots.push({ worksetId, hash: snapshot.hash });
    if (value.bindingHash !== ctx.bindingHash) continue;
    if (selection && !value.inputs.some(input => input.identity.client === selection.client && input.identity.sessionId === selection.sessionId && (!selection.unitId || input.identity.unitId === selection.unitId)) &&
        !equal(selection, value.selection)) continue;
    const { inputs, ...summary } = view(value, snapshot.hash);
    worksets.push({ ...summary, inputCount: inputs.length });
  }
  for (const saved of snapshots) if ((await processingSnapshot(ctx, file(saved.worksetId))).hash !== saved.hash) fail('PROCESSING_INVENTORY_CHANGED');
  await ctx.guard();
  return { interfaceVersion: PROCESSING_INTERFACE_VERSION, worksets, incomplete: page.incomplete, nextCursor: page.nextCursor,
    scope: 'returned-workset-page', inspectedWorksets: page.ids.length };
}
