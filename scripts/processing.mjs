import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWorkflowStorage, workflowProcessingPolicy, assertWorkflowAuthorizations, assertPrivatePaths } from './workflow-storage.mjs';
import { readSelection, readCaptureHead } from './intake-store.mjs';
import { intakePath, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { unitKey, assertNoPrune, readLineageRecord, dispositionPath, validateProcessingDisposition, tombstonePath, assertCaptureRetained } from './capture-retention.mjs';
import { logicalCaptureIdentity } from './capture-contract.mjs';
import { withProcessingState, readProcessingState, processingSnapshot, processingJSON, writeProcessingJSON, writeProcessingBytes, removeProcessingJSON, processingNames, processingReinspectionBlocker, assertProcessingMetadataSize } from './processing-state.mjs';
import { claimPath, proposalPath, transactionPath, operationPath, associationPath, validateClaim, validateAssociation, operationContext, inspectionProgress, sameProcessingPlacement, PROCESSING_INTERFACE_VERSION } from './processing-contract.mjs';
import { normalizeWorkflowSelection as selected } from './workflow-selection.mjs';
import { renderProcessingPacket, packetManifest, validatePageIndex, PROCESSING_PAGE_BYTES, PROCESSING_PACKET_BYTES } from './processing-packet.mjs';
import { processingPageLayout, processingPagePaths, readProcessingExtent } from './processing-page.mjs';
import { buildProcessingProposal, validateProcessingProposal, copyProcessingProposal, verifyProcessingProposal, verifyExistingProposalParents, proposalHash } from './processing-proposal.mjs';
import { applyPlan, recover, finalizeRecordedWriter, verifyPlanTargets, inspectDirectories, inspectExistingDirectories } from './safe-update.mjs';
import { readWriterReceipt as writerReceipt, PROCESSING_REINSPECTION_FILE } from './writer-protocol.mjs';
import { syncDirectory, readBoundedBytes, lstatOrNull } from './file-io.mjs';
import { canonicalJSON, digest, fail, keys, list, hash, nativeId, unique, choice, timestamp, integer } from './workflow-values.mjs';

const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const explicit = 'explicitProcess';
const inputReference = input => ({ identity: input.identity, headHash: input.headHash });
const summary = (claim, claimHash) => ({ operationId: claim.operationId, claimHash,
  inputs: claim.inputs.map(({ identity, projectRoot, headHash, evidenceHash, fileHash, associationHash, dispositionHash }) =>
    ({ identity: { ...identity }, projectRoot, headHash, evidenceHash, fileHash, associationHash, dispositionHash })),
  packet: { hash: claim.packet.hash, bytes: claim.packet.bytes, pages: [...claim.packet.pages],
    captureBytes: [...claim.packet.captureBytes], pageEnds: [...claim.packet.pageEnds] },
  issued: [...claim.issued], acknowledged: [...claim.acknowledged], proposalIntentHash: claim.proposalIntent?.hash ?? null,
  operationContext: operationContext(claim), createdAt: claim.createdAt, inspection: inspectionProgress(claim) });
async function readWriterReceipt(ctx, operationId) {
  await processingSnapshot(ctx, `processed/writes/${nativeId(operationId)}/record.json`);
  return writerReceipt(ctx.collection.notes.writerStateDir, operationId);
}
async function noPendingIntake(ctx) {
  await assertNoPrune(ctx.store);
  if (intakeJSON(await intakeSnapshot(ctx.store, 'state', 'pending.json')) !== null) fail('INTAKE_RECOVERY_REQUIRED');
}
async function association(ctx, identity) {
  const snapshot = await processingSnapshot(ctx, associationPath(identity, ctx.bindingHash));
  const value = intakeJSON(snapshot);
  if (value !== null) validateAssociation(value, identity, ctx.bindingHash);
  return { ...snapshot, value };
}
async function activatedInput(ctx, reference) {
  keys(reference, ['identity', 'headHash']); logicalCaptureIdentity(reference.identity); hash(reference.headHash);
  const selection = await readSelection(ctx.store, reference.identity);
  if (!selection.state) fail('PROCESSING_SOURCE_SELECTION_MISSING');
  const source = selection.state.source;
  await assertWorkflowStorage(ctx.capability, { client: reference.identity.client, sessionId: reference.identity.sessionId, cwd: source.projectRoot }, explicit);
  const current = await readCaptureHead(ctx.store, reference.identity);
  if (current.hash !== reference.headHash || !current.capture || current.capture.projectRoot !== source.projectRoot) fail('PROCESSING_HEAD_CHANGED');
  const lineage = await readLineageRecord(ctx.store, reference.identity, current.hash);
  if (lineage.value.fileHash !== current.head.fileHash || lineage.value.evidenceHash !== current.head.evidenceHash) fail('INVALID_PROCESSING_LINEAGE');
  const associated = await association(ctx, reference.identity);
  const disposition = await processingSnapshot(ctx, dispositionPath(reference.identity, current.hash, ctx.bindingHash));
  if (disposition.bytes) {
    const done = validateProcessingDisposition(intakeJSON(disposition));
    if (done.bindingHash !== ctx.bindingHash || !equal(done.identity, reference.identity) || done.headHash !== current.hash ||
        done.fileHash !== current.head.fileHash || done.evidenceHash !== current.head.evidenceHash) fail('PROCESSING_DISPOSITION_CHANGED');
  }
  return { input: { identity: reference.identity, projectRoot: source.projectRoot, headHash: current.hash,
    evidenceHash: current.head.evidenceHash, fileHash: current.head.fileHash, associationHash: associated.hash, dispositionHash: disposition.hash },
    capture: current.capture, association: associated.value };
}
async function currentInputs(ctx, claim) {
  if (claim.policyHash !== ctx.policyHash) fail('WORKFLOW_POLICY_CHANGED');
  await noPendingIntake(ctx);
  const sources = [];
  for (const input of claim.inputs) {
    const current = await activatedInput(ctx, inputReference(input));
    if (!equal(current.input, input)) fail('PROCESSING_INPUT_CHANGED');
    sources.push({ input, capture: current.capture });
  }
  return sources;
}
async function loadClaim(ctx, operationId, expectedHash, { allowBindingConflict = false } = {}) {
  nativeId(operationId); const snapshot = await processingSnapshot(ctx, claimPath(operationId));
  if (!snapshot.bytes) fail('PROCESSING_CLAIM_MISSING');
  if (expectedHash !== undefined && expectedHash !== snapshot.hash) fail('PROCESSING_CLAIM_CHANGED');
  const claim = validateClaim(intakeJSON(snapshot));
  if (claim.operationId !== operationId || !sameProcessingPlacement(claim.binding, ctx.binding) ||
      (!allowBindingConflict && (claim.bindingHash !== ctx.bindingHash || !equal(claim.binding, ctx.binding)))) fail('PROCESSING_BINDING_CHANGED');
  if (ctx.operation !== 'maintenance' && (!equal(claim.selection, ctx.selection) || claim.policyHash !== ctx.policyHash)) fail('PROCESSING_SELECTION_CHANGED');
  return { claim, hash: snapshot.hash };
}
function checkedInspection(claim) {
  if (claim.acknowledged.length !== claim.packet.pages.length) fail('PROCESSING_INSPECTION_INCOMPLETE');
}
export async function processingCollectionBlockers(ctx) {
  const blockers = [];
  const reservation = await processingReinspectionBlocker(ctx);
  if (reservation) blockers.push(reservation);
  if ((await processingNames(ctx, 'transactions')).length) blockers.push('PROCESSING_RECOVERY_REQUIRED');
  if ((await processingSnapshot(ctx, 'journal.json')).bytes) blockers.push('WRITER_RECOVERY_REQUIRED');
  return blockers;
}
async function assertNoTransaction(ctx) {
  const blockers = await processingCollectionBlockers(ctx);
  if (blockers.length) fail(blockers[0]);
}
async function requireIncomplete(ctx, operationId) {
  if ((await processingSnapshot(ctx, operationPath(operationId))).bytes) fail('PROCESSING_OPERATION_COMPLETE');
}

export const DEFAULT_PROCESSING_BUDGET = Object.freeze({ maxInputs: 5, maxPacketBytes: 64 * 1024 });
export function processingBudget(value = DEFAULT_PROCESSING_BUDGET) {
  keys(value, ['maxInputs', 'maxPacketBytes']); integer(value.maxInputs); integer(value.maxPacketBytes);
  if (value.maxInputs < 1 || value.maxInputs > 20 || value.maxPacketBytes < 1 || value.maxPacketBytes > PROCESSING_PACKET_BYTES) fail('INVALID_PROCESSING_BUDGET');
  return { ...value };
}
function budgetError(code, details) { throw Object.assign(new Error(code), { code, details }); }
export async function activeProcessingClaims(ctx, { allowBindingConflict = false } = {}) {
  const claims = [];
  for (const name of await processingNames(ctx, 'claims')) {
    const operationId = nativeId(name.slice('claims/'.length, -5));
    try {
      const snapshot = await processingSnapshot(ctx, name);
      if (!snapshot.bytes) fail('PROCESSING_INVENTORY_CHANGED');
      const claim = validateClaim(intakeJSON(snapshot));
      if (claim.bindingHash !== ctx.bindingHash && !sameProcessingPlacement(claim.binding, ctx.binding)) continue;
      const bindingChanged = claim.bindingHash !== ctx.bindingHash || !equal(claim.binding, ctx.binding);
      if (name !== claimPath(claim.operationId) || (bindingChanged && !allowBindingConflict)) fail('PROCESSING_BINDING_CHANGED');
      let published = false;
      if (claim.proposalIntent) {
        checkedInspection(claim);
        const proposal = await processingJSON(ctx, proposalPath(claim.operationId));
        if (proposal !== null) {
          if (proposalHash(validateProcessingProposal(proposal, claim)) !== claim.proposalIntent.hash) fail('PROCESSING_PROPOSAL_CHANGED');
          published = true;
        }
      }
      claims.push({ claim, published, bindingChanged });
    } catch (error) { error.operationId = operationId; throw error; }
  }
  return claims;
}

function assertProcessingParallelism(claims, parallelism = 1) {
  const active = claims.filter(item => !item.published);
  if (active.length >= parallelism) budgetError('PROCESSING_RESUME_REQUIRED',
    { current: active.length, limit: parallelism, operationIds: active.map(item => item.claim.operationId) });
}

function assembleProcessingClaim(ctx, operationId, sources, maxPacketBytes) {
  const packet = renderProcessingPacket(sources, { maxBytes: maxPacketBytes }), descriptors = sources.map(source => source.input);
  const workload = { packetBytes: packet.bytes, renderedPageBytes: packet.pages.reduce((total, page) => total + page.bytes, 0),
    estimatedTokens: Math.ceil(packet.bytes / 4), estimator: 'UTF-8 bytes divided by four; not measured model tokens' };
  const claim = validateClaim({ format: 'cuefluent-processing-claim', version: 1, operationId, bindingHash: ctx.bindingHash, binding: ctx.binding,
    selection: ctx.selection, policyHash: ctx.policyHash, createdAt: new Date().toISOString(), inputs: descriptors, inputsHash: digest(canonicalJSON(descriptors)),
    packet: packetManifest(sources, packet), issued: [], acknowledged: [], proposalIntent: null });
  return { claim, workload };
}

/** Caller owns the existing intake/writer locks. Workset intent is published
 * through beforePublish only after all ordinary admission and byte checks. */
export async function prepareProcessingInState(ctx, { operationId, inputs, reconsider = false, budget, parallelism = 1 }, { beforePublish } = {}) {
  nativeId(operationId); list(inputs, 20, { empty: false }); unique(inputs.map(input => unitKey(input.identity)));
  if (typeof reconsider !== 'boolean') fail('INVALID_PROCESSING_REQUEST');
  const limits = processingBudget(budget); integer(parallelism);
  if (parallelism < 1 || parallelism > 5) fail('INVALID_PROCESSING_PARALLELISM');
  await noPendingIntake(ctx); await assertNoTransaction(ctx);
  if (await processingJSON(ctx, operationPath(operationId)) !== null) fail('PROCESSING_OPERATION_COMPLETE');
  const existing = await processingSnapshot(ctx, claimPath(operationId));
  if (existing.bytes) {
    const saved = await loadClaim(ctx, operationId);
    if (!equal(saved.claim.inputs.map(inputReference), inputs)) fail('PROCESSING_OPERATION_CONFLICT');
    return summary(saved.claim, saved.hash);
  }
  if (inputs.length > limits.maxInputs) budgetError('PROCESSING_BATCH_BUDGET', { inputs: inputs.length, maxInputs: limits.maxInputs });
  const claims = await activeProcessingClaims(ctx);
  for (const { claim } of claims) {
    if (claim.inputs.some(input => inputs.some(ref => unitKey(ref.identity) === unitKey(input.identity)))) fail('PROCESSING_INPUT_CLAIMED');
  }
  const queued = claims.filter(item => item.claim.proposalIntent).length;
  if (queued >= 5) budgetError('PROCESSING_PROPOSAL_QUEUE_FULL', { current: queued, limit: 5, operationIds: claims.filter(item => item.claim.proposalIntent).map(item => item.claim.operationId) });
  assertProcessingParallelism(claims, parallelism);
  const sources = [], associations = [];
  for (const reference of inputs) {
    const current = await activatedInput(ctx, reference);
    if (current.input.dispositionHash !== null && !reconsider) fail('PROCESSING_INPUT_ALREADY_HANDLED');
    sources.push({ input: current.input, capture: current.capture }); associations.push(current.association);
  }
  const { claim, workload } = assembleProcessingClaim(ctx, operationId, sources, limits.maxPacketBytes);
  await beforePublish?.(claim);
  const saved = await writeProcessingJSON(ctx, claimPath(operationId), claim, null);
  return { ...summary(claim, saved.hash), associations, workload };
}

/** Explicit selection only while native current-turn delivery is unverified. */
export async function prepareProcessing(capability, args) {
  const selection = await selected(args.selection);
  return withProcessingState(capability, selection, explicit, ctx => prepareProcessingInState(ctx, args));
}

export async function readProcessingPage(capability, { selection, operationId, expectedClaimHash, page }) {
  return withProcessingState(capability, await selected(selection), explicit, async ctx => {
    const saved = await loadClaim(ctx, operationId, expectedClaimHash), { claim } = saved;
    const layout = processingPageLayout(claim, page);
    await authorizeInputBatch(ctx, claim);
    await checkCurrentInputMetadata(ctx, claim, await processingPagePaths(ctx.metadataStore, claim, layout));
    const rendered = await readProcessingExtent(ctx.metadataStore, claim, page, layout);
    let claimHash = saved.hash;
    if (!claim.issued.includes(page)) { claim.issued.push(page); claim.issued.sort((a, b) => a - b); claimHash = (await writeProcessingJSON(ctx, claimPath(operationId), claim, saved.hash)).hash; }
    const { text, ...metrics } = rendered;
    const response = { ...metrics, evidence: JSON.parse(text), page, claimHash, operationId, completeInspection: claim.acknowledged.length === claim.packet.pages.length };
    if (Buffer.byteLength(canonicalJSON(response)) > PROCESSING_PAGE_BYTES) fail('PROCESSING_PAGE_CAPACITY');
    await ctx.guard();
    return response;
  });
}
export async function acknowledgeProcessingPages(capability, { selection, operationId, expectedClaimHash, pages }) {
  list(pages, 160, { empty: false }); unique(pages.map(page => page.index));
  return withProcessingState(capability, await selected(selection), explicit, async ctx => {
    const saved = await loadClaim(ctx, operationId, expectedClaimHash), { claim } = saved;
    for (const page of pages) {
      keys(page, ['index', 'hash']); validatePageIndex(page.index, claim.packet.pages); hash(page.hash);
      if (!claim.issued.includes(page.index) || claim.packet.pages[page.index] !== page.hash) fail('UNISSUED_PROCESSING_PAGE');
      if (!claim.acknowledged.includes(page.index)) claim.acknowledged.push(page.index);
    }
    claim.acknowledged.sort((a, b) => a - b);
    if (equal(claim, intakeJSON(await processingSnapshot(ctx, claimPath(operationId))))) return summary(claim, saved.hash);
    const result = await writeProcessingJSON(ctx, claimPath(operationId), claim, saved.hash);
    return summary(claim, result.hash);
  });
}

export async function proposeProcessing(capability, { selection, operationId, expectedClaimHash, proposal }, options = {}) {
  return withProcessingState(capability, await selected(selection), explicit, async ctx => {
    await assertNoTransaction(ctx); await requireIncomplete(ctx, operationId);
    let saved = await loadClaim(ctx, operationId, expectedClaimHash); const { claim } = saved;
    checkedInspection(claim); await currentInputs(ctx, claim);
    const active = await activeProcessingClaims(ctx, { allowBindingConflict: true });
    const queued = active.filter(item => item.claim.proposalIntent && item.claim.operationId !== operationId);
    if (!claim.proposalIntent && queued.length >= 5) budgetError('PROCESSING_PROPOSAL_QUEUE_FULL', { current: queued.length, limit: 5, operationIds: queued.map(item => item.claim.operationId) });
    let value;
    if (claim.proposalIntent) {
      value = validateProcessingProposal(claim.proposalIntent.value, claim);
      // Resume accepts the existing immutable intent only; changing it needs cancellation.
      if (proposal !== undefined) {
        const requested = await buildProcessingProposal(ctx, claim, proposal);
        if (proposalHash(requested) !== claim.proposalIntent.hash) fail('PROCESSING_PROPOSAL_CHANGED');
      }
    } else {
      if (proposal === undefined) fail('PROCESSING_PROPOSAL_REQUIRED');
      value = await buildProcessingProposal(ctx, claim, proposal);
      claim.proposalIntent = { hash: proposalHash(value), value };
      saved = { claim, hash: (await writeProcessingJSON(ctx, claimPath(operationId), claim, saved.hash)).hash };
      await options.fault?.('proposal-intent');
    }
    await copyProcessingProposal(ctx, value); await options.fault?.('proposal-content');
    const old = await processingSnapshot(ctx, proposalPath(operationId));
    if (old.bytes && !equal(intakeJSON(old), value)) fail('PROCESSING_PROPOSAL_CHANGED');
    if (!old.bytes) await writeProcessingJSON(ctx, proposalPath(operationId), value, null);
    return { ...summary(claim, saved.hash), proposalHash: claim.proposalIntent.hash, plan: value.plan, mappings: value.mappings };
  });
}

async function loadProposal(ctx, claim, expectedHash) {
  hash(expectedHash);
  if (claim.proposalIntent?.hash !== expectedHash) fail('PROCESSING_PROPOSAL_CHANGED');
  const value = validateProcessingProposal(await processingJSON(ctx, proposalPath(claim.operationId)), claim);
  if (proposalHash(value) !== expectedHash) fail('PROCESSING_PROPOSAL_CHANGED');
  return value;
}
async function authorizeSave(ctx, claim, trigger) {
  choice(trigger, ['approved', 'automatic']);
  if (claim.policyHash !== ctx.policyHash) fail('WORKFLOW_POLICY_CHANGED');
  await assertWorkflowStorage(ctx.capability, claim.selection, explicit);
  for (const input of claim.inputs) {
    const selection = { client: input.identity.client, sessionId: input.identity.sessionId, cwd: input.projectRoot };
    await assertWorkflowStorage(ctx.capability, selection, explicit);
    if (trigger === 'automatic' && (await workflowProcessingPolicy(ctx.capability, selection)).mode !== 'automatic') fail('PROCESSING_APPROVAL_REQUIRED');
  }
  if (trigger === 'automatic' && (await workflowProcessingPolicy(ctx.capability, claim.selection)).mode !== 'automatic') fail('PROCESSING_APPROVAL_REQUIRED');
}

function validateTransaction(value, ctx, operationId) {
  keys(value, ['format', 'version', 'operationId', 'bindingHash', 'claim', 'claimHash', 'proposal', 'proposalHash', 'trigger', 'writerBinding', 'plan', 'planHash']);
  if (value.format !== 'cuefluent-processing-transaction' || value.version !== 1 || value.operationId !== operationId || value.bindingHash !== ctx.bindingHash) fail('PROCESSING_TRANSACTION_CHANGED');
  validateClaim(value.claim); const proposal = validateProcessingProposal(value.proposal, value.claim);
  if (!equal(value.claim.binding, ctx.binding) || value.claim.operationId !== operationId || value.claimHash !== digest(canonicalJSON(value.claim) + '\n') ||
      proposalHash(proposal) !== value.proposalHash || value.claim.proposalIntent?.hash !== value.proposalHash ||
      !equal(value.plan, proposal.plan) || digest(canonicalJSON(value.plan)) !== value.planHash ||
      !equal(value.writerBinding, writerBinding(value.claim, proposal))) fail('PROCESSING_TRANSACTION_CHANGED');
  choice(value.trigger, ['approved', 'automatic']); checkedInspection(value.claim); return value;
}
function writerBinding(claim, proposal) {
  return { operationId: claim.operationId, proposalHash: proposalHash(proposal), inputsHash: claim.inputsHash, collectionHash: claim.bindingHash,
    root: proposal.plan.root, stateDir: proposal.plan.stateDir };
}
async function transactionSnapshot(ctx, operationId) {
  const saved = await processingSnapshot(ctx, transactionPath(operationId));
  return { ...saved, value: saved.bytes ? validateTransaction(intakeJSON(saved), ctx, operationId) : null };
}
async function authorizeInputBatch(ctx, claim, automatic = false) {
  if (claim.policyHash !== ctx.policyHash) fail('WORKFLOW_POLICY_CHANGED');
  const selections = [claim.selection, ...claim.inputs.map(input => ({ client: input.identity.client, sessionId: input.identity.sessionId, cwd: input.projectRoot }))];
  await assertWorkflowAuthorizations(ctx.capability, selections.map(selection => ({ selection, operation: explicit, automatic })));
}
async function checkCurrentInputMetadata(ctx, claim, extraPrivatePaths = []) {
  const intake = ctx.metadataStore, pending = ['pending.json', 'prune-pending.json'];
  const paths = [...extraPrivatePaths];
  for (const name of pending) paths.push(await intakePath(intake, 'state', name));
  const inputs = [];
  for (const input of claim.inputs) {
    const names = { head: `heads/${unitKey(input.identity)}.json`, association: associationPath(input.identity, ctx.bindingHash),
      disposition: dispositionPath(input.identity, input.headHash, ctx.bindingHash) };
    paths.push(await intakePath(intake, 'state', names.head), await intakePath(intake, 'state', tombstonePath(input.identity)),
      await intakePath(ctx.writer, 'state', names.association), await intakePath(ctx.writer, 'state', names.disposition));
    inputs.push({ input, names });
  }
  // One fresh private-path verification per boundary, then exact bounded
  // metadata reads through structural stores. No capability or ACL result cache.
  await assertPrivatePaths(ctx.capability, paths);
  if (intakeJSON(await intakeSnapshot(intake, 'state', pending[0])) !== null) fail('INTAKE_RECOVERY_REQUIRED');
  if (intakeJSON(await intakeSnapshot(intake, 'state', pending[1])) !== null) fail('PRUNE_RECOVERY_REQUIRED');
  for (const { input, names } of inputs) {
    await assertCaptureRetained(intake, input.identity);
    if ((await intakeSnapshot(intake, 'state', names.head)).hash !== input.headHash) fail('PROCESSING_HEAD_CHANGED');
    if ((await intakeSnapshot(ctx.writer, 'state', names.association)).hash !== input.associationHash ||
        (await intakeSnapshot(ctx.writer, 'state', names.disposition)).hash !== input.dispositionHash) fail('PROCESSING_INPUT_CHANGED');
  }
}

function validateOperation(value, ctx, operationId) {
  keys(value, ['format', 'version', 'operationId', 'bindingHash', 'claim', 'claimHash', 'outcome', 'processedAt', 'proposal', 'writerReceiptHash'], ['cancelledTransactionHash']);
  if (value.format !== 'cuefluent-processing-operation' || value.version !== 1 || value.operationId !== operationId || value.bindingHash !== ctx.bindingHash) fail('PROCESSING_OPERATION_CHANGED');
  validateClaim(value.claim); timestamp(value.processedAt); choice(value.outcome, ['saved', 'unchanged', 'skipped', 'cancelled']);
  if (Object.hasOwn(value, 'cancelledTransactionHash')) {
    if (value.outcome !== 'cancelled') fail('PROCESSING_OPERATION_CHANGED');
    hash(value.cancelledTransactionHash);
  }
  if (!equal(value.claim.binding, ctx.binding) || value.claim.operationId !== operationId || value.claimHash !== digest(canonicalJSON(value.claim) + '\n')) fail('PROCESSING_OPERATION_CHANGED');
  if (value.outcome === 'saved') {
    checkedInspection(value.claim); hash(value.writerReceiptHash);
    validateProcessingProposal(value.proposal, value.claim);
    if (proposalHash(value.proposal) !== value.claim.proposalIntent?.hash) fail('PROCESSING_PROPOSAL_CHANGED');
  } else {
    if (value.writerReceiptHash !== null || value.proposal !== null) fail('PROCESSING_OPERATION_CHANGED');
    if (value.outcome === 'unchanged') checkedInspection(value.claim);
  }
  return value;
}
function operationRecord(ctx, saved, outcome, proposal = null, receipt = null, cancelledTransactionHash = null) {
  const value = { format: 'cuefluent-processing-operation', version: 1, operationId: saved.claim.operationId, bindingHash: ctx.bindingHash,
    claim: saved.claim, claimHash: saved.hash, outcome, processedAt: receipt?.value.committedAt ?? new Date().toISOString(), proposal, writerReceiptHash: receipt?.hash ?? null,
    ...(cancelledTransactionHash === null ? {} : { cancelledTransactionHash }) };
  return validateOperation(value, ctx, value.operationId);
}
async function publishOperation(ctx, saved, outcome, proposal = null, receipt = null, cancelledTransactionHash = null, beforePublish) {
  return publishOperationRecord(ctx, operationRecord(ctx, saved, outcome, proposal, receipt, cancelledTransactionHash), beforePublish);
}
async function publishOperationRecord(ctx, value, beforePublish) {
  return { value, ...(await writeProcessingJSON(ctx, operationPath(value.operationId), value, null, { beforePublish })) };
}
async function projectRecord(ctx, name, value, previousHash) {
  const old = await processingSnapshot(ctx, name);
  if (old.bytes && equal(intakeJSON(old), value)) return;
  await writeProcessingJSON(ctx, name, value, previousHash);
}
async function cleanProposal(ctx, claim) {
  if (!claim.proposalIntent) return;
  const proposal = validateProcessingProposal(claim.proposalIntent.value, claim);
  for (const copy of proposal.copies) await removeProcessingJSON(ctx, copy.path, copy.hash);
  await removeProcessingJSON(ctx, proposalPath(claim.operationId), digest(canonicalJSON(proposal) + '\n'));
}
async function finishOperation(ctx, record, options) {
  const operation = validateOperation(record.value, ctx, record.value.operationId), { claim, operationId } = operation;
  const tx = await transactionSnapshot(ctx, operationId);
  const names = await processingNames(ctx, 'transactions');
  if (names.some(name => name !== transactionPath(operationId))) fail('PROCESSING_RECOVERY_REQUIRED');
  if (operation.outcome === 'saved') {
    const receipt = await readWriterReceipt(ctx, operationId);
    if (receipt?.hash !== operation.writerReceiptHash || !equal(receipt.value.coordination.binding, writerBinding(claim, operation.proposal)) ||
        !equal(receipt.value.outputs, operation.proposal.plan.files.map(file => ({ path: file.path, hash: file.expectedContentHash })))) fail('PROCESSING_RECEIPT_CHANGED');
    if (tx.value) {
      if (!equal(tx.value.claim, claim) || !equal(tx.value.proposal, operation.proposal)) fail('PROCESSING_TRANSACTION_CHANGED');
      await finalizeRecordedWriter(ctx.collection.notes.writerStateDir, receipt.hash,
        { writerGuard: ctx.writerGuard, coordination: { binding: tx.value.writerBinding, transactionHash: tx.hash }, authorize: ctx.guard });
    } else if ((await processingSnapshot(ctx, 'journal.json')).bytes) fail('PROCESSING_TRANSACTION_MISSING');
  } else if (operation.cancelledTransactionHash) {
    await assertUnappliedTransaction(ctx, claim, operation.claimHash, tx, operation.cancelledTransactionHash, { allowMissing: true });
  } else if (tx.value || (await processingSnapshot(ctx, 'journal.json')).bytes) fail('PROCESSING_RECOVERY_REQUIRED');
  const completionPath = `processed/completions/${operationId}.json`;
  const completed = await processingSnapshot(ctx, completionPath);
  const completion = { operationId, operationHash: record.hash, bindingHash: ctx.bindingHash };
  if (completed.bytes && !equal(intakeJSON(completed), completion)) fail('PROCESSING_OPERATION_CHANGED');
  for (const input of completed.bytes ? [] : claim.inputs) {
    if (operation.outcome !== 'cancelled') {
      const disposition = { format: 'cuefluent-processing-disposition', version: 2, bindingHash: ctx.bindingHash, identity: input.identity,
        headHash: input.headHash, evidenceHash: input.evidenceHash, fileHash: input.fileHash, operationId, outcome: operation.outcome, processedAt: operation.processedAt };
      await projectRecord(ctx, dispositionPath(input.identity, input.headHash, ctx.bindingHash), disposition, input.dispositionHash);
      await options.fault?.('disposition');
    }
    if (operation.outcome === 'saved') {
      const mapping = operation.proposal.mappings.find(item => unitKey(item.identity) === unitKey(input.identity));
      const outputs = mapping.paths.map(name => ({ path: name, hash: operation.proposal.plan.files.find(file => file.path === name).expectedContentHash }));
      const value = validateAssociation({ format: 'cuefluent-note-association', version: 1, bindingHash: ctx.bindingHash, identity: input.identity,
        headHash: input.headHash, operationId, outputs }, input.identity, ctx.bindingHash);
      await projectRecord(ctx, associationPath(input.identity, ctx.bindingHash), value, input.associationHash); await options.fault?.('association');
    }
  }
  if (!completed.bytes) await writeProcessingJSON(ctx, completionPath, completion, null);
  await options.fault?.('projections-complete');
  await cleanProposal(ctx, claim); await options.fault?.('proposal-cleanup');
  await removeProcessingJSON(ctx, claimPath(operationId), operation.claimHash); await options.fault?.('claim-release');
  if (tx.value) await removeProcessingJSON(ctx, transactionPath(operationId), tx.hash);
  await options.fault?.('transaction-cleanup');
  // Directory identities remain pinned for the duration of metadata work. Only
  // remove the now-empty operation directory after the final store access.
  if (claim.proposalIntent) {
    const dir = path.join(ctx.collection.notes.writerStateDir, 'proposals', operationId);
    await ctx.guard();
    try { await fs.rmdir(dir); await syncDirectory(path.dirname(dir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { operationId, status: operation.outcome, receiptHash: record.hash, outputs: operation.proposal?.plan.files.map(file => ({ path: file.path, hash: file.expectedContentHash })) ?? [] };
}

async function executeTransaction(ctx, tx, options) {
  const value = tx.value, claim = value.claim, stateDir = ctx.collection.notes.writerStateDir;
  const coordination = { binding: value.writerBinding, transactionHash: tx.hash };
  let receipt = await readWriterReceipt(ctx, claim.operationId);
  if (!receipt) {
    await authorizeSave(ctx, claim, value.trigger); await currentInputs(ctx, claim);
    const saved = await loadClaim(ctx, claim.operationId, value.claimHash);
    await loadProposal(ctx, saved.claim, value.proposalHash); await verifyProcessingProposal(ctx, value.proposal);
    // Intake ownership freezes cooperative head changes. Check exact mutable
    // metadata again at each writer boundary; the writer checks source bytes.
    const authorize = async (privatePaths = []) => {
      await ctx.owned();
      await assertPrivatePaths(ctx.capability, [...privatePaths, await intakePath(ctx.writer, 'state', `processed/writes/${claim.operationId}/record.json`)]);
      const recorded = await writerReceipt(stateDir, claim.operationId);
      if (recorded) {
        if (!equal(recorded.value.coordination, coordination)) fail('PROCESSING_RECEIPT_CHANGED');
        await assertWorkflowAuthorizations(ctx.capability, []); return;
      }
      await authorizeInputBatch(ctx, claim, value.trigger === 'automatic');
      await checkCurrentInputMetadata(ctx, claim); await verifyExistingProposalParents(value.proposal);
    };
    const writerOptions = { writerGuard: ctx.writerGuard, coordination, authorize };
    for (const phase of ['afterStage', 'afterReplace', 'afterVerification', 'afterReceipt', 'afterJournalRemoval']) writerOptions[phase] = () => options.fault?.(phase);
    if ((await processingSnapshot(ctx, 'journal.json')).bytes) await recover(stateDir, writerOptions);
    else await applyPlan(value.plan, writerOptions);
    receipt = await readWriterReceipt(ctx, claim.operationId);
    if (!receipt) fail('PROCESSING_RECEIPT_MISSING');
  }
  if (!equal(receipt.value.coordination, coordination)) fail('PROCESSING_RECEIPT_CHANGED');
  const record = await publishOperation(ctx, { claim, hash: value.claimHash }, 'saved', value.proposal, receipt);
  await options.fault?.('operation-receipt');
  return finishOperation(ctx, record, options);
}

/** An approved call requires the user's exact-proposal approval (or explicit
 * save request); an automatic call additionally requires Automatic on every
 * input route. A prompted route alone is never authority to save. */
export async function saveProcessing(capability, { selection, operationId, expectedClaimHash, approvedProposalHash, trigger = 'approved' }, options = {}) {
  return withProcessingState(capability, await selected(selection), explicit, async ctx => {
    await requireIncomplete(ctx, operationId);
    const saved = await loadClaim(ctx, operationId, expectedClaimHash), { claim } = saved;
    checkedInspection(claim); await authorizeSave(ctx, claim, trigger); await currentInputs(ctx, claim);
    const proposal = await loadProposal(ctx, claim, approvedProposalHash); await verifyProcessingProposal(ctx, proposal);
    await assertNoTransaction(ctx);
    await verifyExistingProposalParents(proposal); await verifyPlanTargets(proposal.plan);
    const value = { format: 'cuefluent-processing-transaction', version: 1, operationId, bindingHash: ctx.bindingHash,
      claim, claimHash: saved.hash, proposal, proposalHash: approvedProposalHash, trigger, writerBinding: writerBinding(claim, proposal), plan: proposal.plan, planHash: digest(canonicalJSON(proposal.plan)) };
    validateTransaction(value, ctx, operationId);
    const tx = { value, ...(await writeProcessingJSON(ctx, transactionPath(operationId), value, null, { beforePublish: options.beforeCommit })) };
    await options.fault?.('write-intent');
    return executeTransaction(ctx, tx, options);
  });
}

async function assertUnappliedTransaction(ctx, claim, claimHash, tx, expectedHash, { allowMissing = false } = {}) {
  if (tx.value ? tx.hash !== expectedHash || tx.value.claimHash !== claimHash || !equal(tx.value.claim, claim) : !allowMissing) fail('PROCESSING_RECOVERY_CHANGED');
  if ((await processingSnapshot(ctx, 'journal.json')).bytes || await readWriterReceipt(ctx, claim.operationId)) fail('PROCESSING_RECOVERY_REQUIRED');
}

export async function completeProcessing(capability, { selection, operationId, expectedClaimHash, expectedRecoveryHash, outcome }, options = {}) {
  choice(outcome, ['unchanged', 'skipped', 'cancelled']); hash(expectedClaimHash);
  if (expectedRecoveryHash !== undefined) { hash(expectedRecoveryHash); if (outcome !== 'cancelled') fail('INVALID_PROCESSING_REQUEST'); }
  return withProcessingState(capability, await selected(selection), outcome === 'cancelled' ? 'maintenance' : explicit, async ctx => {
    await requireIncomplete(ctx, operationId);
    const saved = await loadClaim(ctx, operationId, expectedClaimHash, { allowBindingConflict: outcome === 'cancelled' });
    if (outcome === 'cancelled') ctx = { ...ctx, binding: saved.claim.binding, bindingHash: saved.claim.bindingHash };
    if (outcome === 'cancelled' && await readWriterReceipt(ctx, operationId)) fail('PROCESSING_RECOVERY_REQUIRED');
    let cancelledTransactionHash = null;
    if (outcome === 'cancelled' && expectedRecoveryHash !== undefined) {
      const tx = await transactionSnapshot(ctx, operationId);
      if ((await processingNames(ctx, 'transactions')).some(name => name !== transactionPath(operationId))) fail('PROCESSING_RECOVERY_REQUIRED');
      await assertUnappliedTransaction(ctx, saved.claim, saved.hash, tx, expectedRecoveryHash);
      cancelledTransactionHash = tx.hash;
    } else await assertNoTransaction(ctx);
    if (outcome === 'unchanged') { checkedInspection(saved.claim); await currentInputs(ctx, saved.claim); }
    const record = await publishOperation(ctx, saved, outcome, null, null, cancelledTransactionHash, options.beforeCommit); await options.fault?.('operation-receipt');
    return finishOperation(ctx, record, options);
  });
}

/** Recovery requires an exact reviewed transaction or operation-record hash.
 * Recorded non-writing outcomes retain their original metadata namespace.
 * Saved outcomes retain writer-binding checks; without a writer receipt, the
 * transaction still requires its old consent, inputs and approved proposal. */
export async function recoverProcessing(capability, { operationId, expectedRecoveryHash }, options = {}) {
  nativeId(operationId); hash(expectedRecoveryHash);
  return withProcessingState(capability, null, 'maintenance', async ctx => {
    const record = await processingSnapshot(ctx, operationPath(operationId));
    if (record.bytes) {
      if (record.hash !== expectedRecoveryHash) fail('PROCESSING_RECOVERY_CHANGED');
      const value = intakeJSON(record);
      if (['cancelled', 'skipped', 'unchanged'].includes(value?.outcome)) {
        validateClaim(value.claim);
        if (!sameProcessingPlacement(value.claim.binding, ctx.binding)) fail('PROCESSING_BINDING_CHANGED');
        ctx = { ...ctx, binding: value.claim.binding, bindingHash: value.claim.bindingHash };
      }
      return finishOperation(ctx, { ...record, value }, options);
    }
    const tx = await transactionSnapshot(ctx, operationId);
    if (!tx.value || tx.hash !== expectedRecoveryHash) fail('PROCESSING_RECOVERY_CHANGED');
    return executeTransaction(ctx, tx, options);
  });
}

export async function describeProcessingOperation(ctx, operationId, expectedAdmission = null, collectionBlockers = null) {
  nativeId(operationId);
  try { return await describeOperation(ctx, operationId, expectedAdmission, collectionBlockers); }
  catch (error) { error.operationId = operationId; throw error; }
}
async function describeOperation(ctx, operationId, expectedAdmission, collectionBlockers) {
  const operation = await processingSnapshot(ctx, operationPath(operationId));
  const transaction = await processingSnapshot(ctx, transactionPath(operationId));
  const saved = await processingSnapshot(ctx, claimPath(operationId));
  const claim = saved.bytes ? validateClaim(intakeJSON(saved)) : null;
  // Status validates retained records in their own namespace; this is never a
  // storage capability or permission to resume mutation in that namespace.
  const recorded = claim ?? intakeJSON(operation)?.claim ?? intakeJSON(transaction)?.claim;
  if (recorded) {
    validateClaim(recorded);
    if (recorded.operationId !== operationId || !sameProcessingPlacement(recorded.binding, ctx.binding)) fail('PROCESSING_BINDING_CHANGED');
  }
  const bindingChanged = Boolean(recorded && (recorded.bindingHash !== ctx.bindingHash || !equal(recorded.binding, ctx.binding)));
  const recordedContext = recorded ? { ...ctx, binding: recorded.binding, bindingHash: recorded.bindingHash } : ctx;
  const tx = { ...transaction, value: transaction.bytes ? validateTransaction(intakeJSON(transaction), recordedContext, operationId) : null };
  const completed = operation.bytes ? validateOperation(intakeJSON(operation), recordedContext, operationId) : null;
  // A durable workset admission precedes its claim. Its exposed operation ID
  // alone cannot prove that a later ordinary operation resumed that admission.
  if (expectedAdmission) for (const candidate of [claim, completed?.claim, tx.value?.claim].filter(Boolean)) {
    if (!equal(candidate.selection, expectedAdmission.selection) || candidate.policyHash !== expectedAdmission.policyHash ||
        !equal(candidate.inputs.map(inputReference), expectedAdmission.inputs) ||
        candidate.packet.hash !== expectedAdmission.packetHash || candidate.packet.bytes !== expectedAdmission.packetBytes) fail('PROCESSING_OPERATION_CONFLICT');
  }
  const basis = claim ?? completed?.claim ?? tx.value?.claim;
  let published = false, proposalSnapshot = null;
  if (claim?.proposalIntent) {
    checkedInspection(claim);
    const proposal = await processingSnapshot(ctx, proposalPath(operationId));
    proposalSnapshot = proposal;
    if (proposal.bytes) {
      if (proposalHash(validateProcessingProposal(intakeJSON(proposal), claim)) !== claim.proposalIntent.hash) fail('PROCESSING_PROPOSAL_CHANGED');
      published = true;
    }
  }
  const inspection = basis ? inspectionProgress(basis) : null;
  let conflict = completed && !saved.hash && !tx.hash ? null : bindingChanged ? 'PROCESSING_BINDING_CHANGED' : claim && claim.policyHash !== ctx.policyHash ? 'WORKFLOW_POLICY_CHANGED' : null;
  const blockers = [];
  const currentBlockers = saved.hash || tx.hash
    ? (collectionBlockers ?? await processingCollectionBlockers(ctx)).filter(code => code !== 'PROCESSING_BINDING_CHANGED') : [];
  if (claim && !completed && !tx.hash) {
    if (!conflict) {
      try { await checkCurrentInputMetadata(ctx, claim); }
      catch (error) {
        if (['PROCESSING_HEAD_CHANGED', 'PROCESSING_INPUT_CHANGED', 'CAPTURE_PRUNED'].includes(error.code)) conflict = error.code;
        else if (['INTAKE_RECOVERY_REQUIRED', 'PRUNE_RECOVERY_REQUIRED'].includes(error.code)) blockers.push(error.code);
        else throw error;
      }
    }
    blockers.push(...currentBlockers);
  }
  const transferPending = currentBlockers.includes('PROCESSING_REINSPECTION_REQUIRED');
  if (transferPending && !blockers.includes('PROCESSING_REINSPECTION_REQUIRED')) blockers.unshift('PROCESSING_REINSPECTION_REQUIRED');
  const state = completed ? 'completed' : transferPending ? 'blocked' : bindingChanged ? 'conflicted' : tx.hash ? 'recovery-required' : conflict ? 'conflicted' : blockers.length ? 'blocked' : published ? 'awaiting-review'
    : claim?.proposalIntent ? 'draft-staging' : inspection?.state ?? 'missing';
  const recoveryRequired = Boolean(tx.hash || (completed && saved.hash));
  const changedBindingWritePending = bindingChanged && !completed &&
    (currentBlockers.includes('WRITER_RECOVERY_REQUIRED') || Boolean(await readWriterReceipt(ctx, operationId)));
  const nextAction = !saved.hash && !tx.hash ? null : transferPending ? { command: 'processing-reinspection-status' }
    : changedBindingWritePending ? { command: null, reason: 'resolve-conflict' }
    : bindingChanged && !completed ? { command: 'processing-complete', outcome: 'cancelled', reason: 'retire-conflicted-claim', ...(tx.hash ? { expectedRecoveryHash: tx.hash } : {}) }
    : bindingChanged && completed.outcome === 'saved' ? { command: null, reason: 'resolve-conflict' }
    : recoveryRequired ? { command: 'processing-recover' }
    : completed ? null
    : conflict ? { command: null, reason: 'resolve-conflict' }
    : blockers.length ? { command: null, reason: 'inspect-collection-recovery' }
    : state === 'awaiting-review' ? { command: null, reason: 'review-proposal' }
    : state === 'draft-staging' ? { command: 'processing-propose' }
    : state === 'inspected' ? { command: null, reason: 'choose-proposal-or-disposition', commands: ['processing-propose', 'processing-complete'] }
    : inspection?.nextPage !== null && inspection?.nextPage !== undefined ? { command: 'processing-page', page: inspection.nextPage } : null;
  // Metadata-only status is advisory, but never combine two versions of a claim.
  for (const [name, snapshot] of [[claimPath(operationId), saved], [operationPath(operationId), operation], [transactionPath(operationId), tx], ...(proposalSnapshot ? [[proposalPath(operationId), proposalSnapshot]] : [])]) {
    if ((await processingSnapshot(ctx, name)).hash !== snapshot.hash) fail('PROCESSING_INVENTORY_CHANGED');
  }
  return { interfaceVersion: PROCESSING_INTERFACE_VERSION, operationId, state, inspection, nextAction, conflict, blockers,
    claimHash: saved.hash, selection: basis ? { ...basis.selection } : null,
    inputs: basis ? basis.inputs.map(input => ({ identity: { ...input.identity }, headHash: input.headHash, evidenceHash: input.evidenceHash, fileHash: input.fileHash })) : [],
    createdAt: basis?.createdAt ?? null, inputCount: basis?.inputs.length ?? 0,
    proposalHash: basis?.proposalIntent?.hash ?? null, recoveryRequired,
    sourceCompleteness: 'unknown', freshness: 'metadata-only',
    recoveryHash: operation.hash ?? tx.hash, outcome: completed?.outcome ?? null,
    claim: claim ? summary(claim, saved.hash) : null, pendingTransaction: tx.hash !== null };
}
export async function inspectProcessing(capability, operationId) {
  const ctx = await readProcessingState(capability, null, 'maintenance');
  const result = await describeProcessingOperation(ctx, operationId);
  await ctx.guard(); return result;
}

async function proposalReviewFiles(ctx, proposal) {
  const files = []; let total = 0;
  for (const [index, file] of proposal.plan.files.entries()) {
    const draft = await processingSnapshot(ctx, proposal.copies[index].path);
    if (draft.hash !== file.expectedContentHash) fail('PROCESSING_PROPOSAL_CHANGED');
    const original = await readBoundedBytes(path.join(proposal.plan.root, file.path), { maxBytes: 2 * 1024 * 1024, missing: true, noFollow: true });
    if ((original === null ? null : digest(original)) !== file.expectedHash) fail('PROCESSING_OUTPUT_CHANGED');
    total += draft.bytes.length + (original?.length ?? 0);
    if (total > 4 * 1024 * 1024) fail('PROCESSING_REVIEW_LIMIT');
    const decode = bytes => bytes === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    files.push({ path: file.path, expectedHash: file.expectedHash, contentHash: file.expectedContentHash,
      original: decode(original), proposed: decode(draft.bytes) });
  }
  return files;
}

/** Exact, bounded review material for a selected immutable proposal. Delivery is
 * read-only and does not acknowledge evidence or authorize the writer. Consumers
 * must not replace these inspected hashes while waiting for a user's decision. */
export async function readProcessingProposal(capability, { selection, operationId, expectedClaimHash, expectedProposalHash }) {
  hash(expectedClaimHash); hash(expectedProposalHash);
  return withProcessingState(capability, await selected(selection), explicit, async ctx => {
    await requireIncomplete(ctx, operationId);
    const saved = await loadClaim(ctx, operationId, expectedClaimHash), { claim } = saved;
    checkedInspection(claim); const sources = await currentInputs(ctx, claim); await assertNoTransaction(ctx);
    const proposal = await loadProposal(ctx, claim, expectedProposalHash);
    await verifyProcessingProposal(ctx, proposal); await verifyExistingProposalParents(proposal);
    const files = await proposalReviewFiles(ctx, proposal);
    await verifyExistingProposalParents(proposal); await verifyPlanTargets(proposal.plan);
    if ((await processingSnapshot(ctx, claimPath(operationId))).hash !== saved.hash) fail('PROCESSING_CLAIM_CHANGED');
    await ctx.guard();
    return { interfaceVersion: PROCESSING_INTERFACE_VERSION, operationId, claimHash: saved.hash,
      proposalHash: expectedProposalHash, files, createDirectories: proposal.plan.createDirectories ?? [],
      inputs: claim.inputs.map(inputReference), inspection: inspectionProgress(claim),
      sourceCoverage: sources.map(({ input, capture }) => ({ identity: input.identity, terminal: capture.terminal,
        partial: capture.coverage.partial, omissions: structuredClone(capture.coverage.omissions) })),
      mappings: structuredClone(proposal.mappings) };
  });
}

const reinspectionPending = PROCESSING_REINSPECTION_FILE;
const reinspectionClaim = claimHash => `processed/reinspection-claims/${hash(claimHash)}.json`;
const abandonedReinspection = recordHash => `processed/abandoned-reinspections/${hash(recordHash)}.json`;
const reinspectionRecord = id => `processed/reinspections/${nativeId(id)}.json`;
const reinspectionDraft = (id, index) => `processed/reinspection-drafts/${nativeId(id)}/${index}.md`;

function reinspectionArgs(args) {
  nativeId(args.operationId); nativeId(args.replacementOperationId);
  if (args.operationId === args.replacementOperationId) fail('PROCESSING_REINSPECTION_CONFLICT');
  hash(args.expectedClaimHash); hash(args.expectedProposalHash);
}

function retainedProposalRequest(proposal, writer, operationId, contentPath = index => `proposals/${operationId}/${index}.md`) {
  return { mode: proposal.plan.mode,
    ...(proposal.plan.mode === 'derived' ? { expectedManifestHash: proposal.plan.expectedManifestHash } : {}),
    files: proposal.plan.files.map((file, index) => ({ path: file.path, expectedHash: file.expectedHash,
      contentPath: path.join(writer, contentPath(index)), expectedContentHash: file.expectedContentHash })),
    mappings: structuredClone(proposal.mappings) };
}

async function reinspectionPreview(ctx, args) {
  reinspectionArgs(args);
  await assertNoTransaction(ctx); await requireIncomplete(ctx, args.operationId);
  for (const operationId of [args.operationId, args.replacementOperationId]) {
    if (await readWriterReceipt(ctx, operationId)) fail('PROCESSING_RECOVERY_REQUIRED');
  }
  for (const name of [claimPath(args.replacementOperationId), proposalPath(args.replacementOperationId),
    operationPath(args.replacementOperationId), `processed/completions/${args.operationId}.json`,
    `processed/completions/${args.replacementOperationId}.json`, reinspectionRecord(args.operationId), reinspectionRecord(args.replacementOperationId)]) {
    if ((await processingSnapshot(ctx, name)).bytes) fail('PROCESSING_REINSPECTION_CONFLICT');
  }
  // A previous failed, unclaimed proposal copy must not become the successor's
  // draft by collision. Only exact transfer retries can adopt owned copies.
  const replacementDirectory = path.join(ctx.collection.notes.writerStateDir, 'proposals', args.replacementOperationId);
  await assertPrivatePaths(ctx.capability, [replacementDirectory]);
  if (await lstatOrNull(replacementDirectory)) fail('PROCESSING_REINSPECTION_CONFLICT');
  const archiveDirectory = path.dirname(path.join(ctx.collection.notes.writerStateDir, reinspectionDraft(args.operationId, 0)));
  await assertPrivatePaths(ctx.capability, [archiveDirectory]);
  if (await lstatOrNull(archiveDirectory)) fail('PROCESSING_REINSPECTION_CONFLICT');
  const saved = await processingSnapshot(ctx, claimPath(args.operationId));
  if (saved.hash !== args.expectedClaimHash) fail('PROCESSING_CLAIM_CHANGED');
  const claim = validateClaim(intakeJSON(saved));
  if (claim.operationId !== args.operationId || !sameProcessingPlacement(claim.binding, ctx.binding) ||
      !equal(claim.selection, ctx.selection)) fail('PROCESSING_SELECTION_CHANGED');
  checkedInspection(claim);
  const originalContext = { ...ctx, binding: claim.binding, bindingHash: claim.bindingHash };
  // Completion wraps the claim. Check the full record before reserving a
  // transfer, even when the claim itself fits the metadata bound.
  const cancellation = operationRecord(originalContext, { claim, hash: saved.hash }, 'cancelled');
  assertProcessingMetadataSize(Buffer.from(canonicalJSON(cancellation) + '\n'));
  const sources = await currentInputs(originalContext, claim);
  const proposal = await loadProposal(originalContext, claim, args.expectedProposalHash);
  await verifyProcessingProposal(ctx, proposal);
  const current = [];
  for (const input of claim.inputs) {
    const item = await activatedInput(ctx, inputReference(input));
    // The old namespace is checked by currentInputs above. An intervening
    // disposition/association in a new namespace cannot be silently superseded.
    if (claim.bindingHash !== ctx.bindingHash &&
        (item.input.associationHash !== null || item.input.dispositionHash !== null)) fail('PROCESSING_INPUT_CHANGED');
    current.push(item);
  }
  const inspect = proposal.plan.version === 2 ? inspectDirectories : inspectExistingDirectories;
  const directories = await inspect(proposal.plan.root, proposal.plan.files.map(file => file.path));
  if (directories.root !== proposal.plan.root) fail('PROCESSING_NOTES_ROOT_CHANGED');
  if (claim.bindingHash === ctx.bindingHash && equal(directories.directories, proposal.directories)) fail('PROCESSING_REINSPECTION_NOT_REQUIRED');
  const inputs = current.map(item => item.input);
  const candidateClaim = { operationId: args.replacementOperationId, inputs, inputsHash: digest(canonicalJSON(inputs)) };
  const candidate = await buildProcessingProposal(ctx, candidateClaim,
    retainedProposalRequest(proposal, ctx.collection.notes.writerStateDir, args.operationId));
  if (!equal(candidate.directories, directories.directories)) fail('PROCESSING_NOTES_ROOT_CHANGED');
  await verifyExistingProposalParents(candidate); await verifyPlanTargets(candidate.plan);
  const claims = await activeProcessingClaims(ctx, { allowBindingConflict: true });
  for (const other of claims.filter(item => item.claim.operationId !== args.operationId)) {
    if (other.claim.inputs.some(input => claim.inputs.some(old => unitKey(old.identity) === unitKey(input.identity)))) fail('PROCESSING_INPUT_CLAIMED');
  }
  assertProcessingParallelism(claims.filter(item => item.claim.operationId !== args.operationId));
  const { claim: replacement } = assembleProcessingClaim(ctx, args.replacementOperationId,
    current.map(({ input, capture }) => ({ input, capture })), PROCESSING_PACKET_BYTES);
  const preview = { format: 'cuefluent-processing-reinspection-preview', version: 1,
    operationId: args.operationId, replacementOperationId: args.replacementOperationId,
    claimHash: saved.hash, proposalHash: args.expectedProposalHash, binding: ctx.binding, bindingHash: ctx.bindingHash,
    policyHash: ctx.policyHash, inputs, candidateHash: proposalHash(candidate), directories: candidate.directories,
    createDirectories: candidate.plan.createDirectories ?? null,
    packet: replacement.packet };
  const files = await proposalReviewFiles(ctx, proposal);
  await verifyExistingProposalParents(candidate); await verifyPlanTargets(candidate.plan);
  if ((await processingSnapshot(ctx, claimPath(args.operationId))).hash !== saved.hash) fail('PROCESSING_CLAIM_CHANGED');
  await ctx.guard();
  if (!equal(reinspectionCandidate(claim, preview), candidate)) fail('PROCESSING_REINSPECTION_CHANGED');
  return { preview, claim, proposal, sources, replacement, files };
}

/** Explicitly inspect present storage; never assert continuity from matching
 * paths or inode/birthtime. This command creates no replacement or approval. */
export async function previewProcessingReinspection(capability, args) {
  return withProcessingState(capability, await selected(args.selection), explicit, async ctx => {
    const inspected = await reinspectionPreview(ctx, args), { preview, claim, proposal, files, sources } = inspected;
    return { interfaceVersion: PROCESSING_INTERFACE_VERSION, operationId: claim.operationId,
      replacementOperationId: args.replacementOperationId, previewHash: digest(canonicalJSON(preview)),
      previousBinding: claim.binding, currentBinding: ctx.binding,
      previousDirectories: proposal.directories, currentDirectories: preview.directories,
      files, inputs: claim.inputs.map(inputReference), mappings: structuredClone(proposal.mappings),
      sourceCoverage: sources.map(({ input, capture }) => ({ identity: input.identity, terminal: capture.terminal,
        partial: capture.coverage.partial, omissions: structuredClone(capture.coverage.omissions) })),
      nextAction: 'explicit-transfer-then-inspect-and-review', savesNotes: false };
  });
}

function reinspectionCandidate(claim, preview) {
  const original = claim.proposalIntent.value, candidate = structuredClone(original);
  candidate.operationId = preview.replacementOperationId;
  candidate.bindingHash = preview.bindingHash;
  candidate.inputsHash = digest(canonicalJSON(preview.inputs));
  candidate.directories = structuredClone(preview.directories);
  if (candidate.plan.version === 2) {
    candidate.plan.directories = structuredClone(preview.directories);
    candidate.plan.createDirectories = structuredClone(preview.createDirectories);
  }
  candidate.copies = original.copies.map((copy, index) => ({ path: `proposals/${preview.replacementOperationId}/${index}.md`,
    source: path.join(claim.binding.notes.writerStateDir, copy.path), hash: copy.hash }));
  candidate.plan.files.forEach((file, index) => { file.contentPath = path.join(claim.binding.notes.writerStateDir, candidate.copies[index].path); });
  return candidate;
}

async function readReinspection(ctx, snapshot) {
  const value = intakeJSON(snapshot);
  keys(value, ['format', 'version', 'preview', 'previewHash', 'claim', 'replacement']);
  keys(value.claim, ['path', 'hash']);
  if (value.version !== 2 || value.claim.path !== reinspectionClaim(value.claim.hash) ||
      value.claim.hash !== value.preview?.claimHash) fail('PROCESSING_REINSPECTION_CHANGED');
  const original = await processingSnapshot(ctx, value.claim.path);
  if (original.hash !== value.claim.hash) fail('PROCESSING_CLAIM_CHANGED');
  return { ...value, claim: intakeJSON(original) };
}
function storedReinspection(value) {
  return { ...value, claim: { path: reinspectionClaim(value.preview.claimHash), hash: value.preview.claimHash } };
}
function reinspectionRecordArgs(value) {
  const preview = value?.preview;
  const args = { selection: value?.claim?.selection, operationId: preview?.operationId,
    replacementOperationId: preview?.replacementOperationId, expectedClaimHash: preview?.claimHash,
    expectedProposalHash: preview?.proposalHash, expectedPreviewHash: value?.previewHash };
  reinspectionArgs(args); hash(args.expectedPreviewHash);
  return args;
}
async function assertReinspectionWriterIdle(ctx, operationIds) {
  if ((await processingNames(ctx, 'transactions')).length || (await processingSnapshot(ctx, 'journal.json')).bytes) fail('PROCESSING_RECOVERY_REQUIRED');
  for (const id of operationIds) if (await readWriterReceipt(ctx, id)) fail('PROCESSING_RECOVERY_REQUIRED');
}

function validateReinspection(value, ctx, args, { recorded = false } = {}) {
  keys(value, ['format', 'version', 'preview', 'previewHash', 'claim', 'replacement']);
  if (value.format !== 'cuefluent-processing-reinspection' || value.version !== 2) fail('PROCESSING_REINSPECTION_CHANGED');
  const { preview, claim, replacement } = value;
  validateClaim(claim); const proposal = claim.proposalIntent?.value; validateClaim(replacement); validateProcessingProposal(proposal, claim);
  keys(preview, ['format', 'version', 'operationId', 'replacementOperationId', 'claimHash', 'proposalHash', 'binding', 'bindingHash', 'policyHash', 'inputs', 'candidateHash', 'directories', 'createDirectories', 'packet']);
  if (preview.format !== 'cuefluent-processing-reinspection-preview' || preview.version !== 1 ||
      value.previewHash !== digest(canonicalJSON(preview)) || value.previewHash !== args.expectedPreviewHash ||
      preview.operationId !== args.operationId || preview.replacementOperationId !== args.replacementOperationId ||
      preview.claimHash !== args.expectedClaimHash || preview.proposalHash !== args.expectedProposalHash ||
      preview.claimHash !== digest(canonicalJSON(claim) + '\n') || preview.proposalHash !== proposalHash(proposal) ||
      claim.proposalIntent?.hash !== preview.proposalHash || claim.operationId !== args.operationId ||
      !sameProcessingPlacement(claim.binding, ctx.binding) || !sameProcessingPlacement(preview.binding, ctx.binding) || !equal(claim.selection, ctx.selection) ||
      (!recorded && (preview.bindingHash !== ctx.bindingHash || !equal(preview.binding, ctx.binding) || preview.policyHash !== ctx.policyHash)) ||
      replacement.operationId !== args.replacementOperationId || replacement.bindingHash !== preview.bindingHash ||
      !equal(replacement.binding, preview.binding) || replacement.policyHash !== preview.policyHash || !equal(replacement.selection, ctx.selection) ||
      !equal(replacement.packet, preview.packet) || !equal(replacement.inputs, preview.inputs) || !equal(replacement.inputs.map(inputReference), claim.inputs.map(inputReference)) ||
      replacement.proposalIntent !== null || replacement.issued.length || replacement.acknowledged.length) fail('PROCESSING_REINSPECTION_CHANGED');
  checkedInspection(claim);
  const candidate = reinspectionCandidate(claim, preview);
  validateProcessingProposal(candidate, replacement);
  if (proposalHash(candidate) !== preview.candidateHash) fail('PROCESSING_REINSPECTION_CHANGED');
  return value;
}

async function finishReinspection(ctx, record, args, options) {
  const value = validateReinspection(record.value, ctx, args, { recorded: true }), { claim, replacement, preview } = value;
  const proposal = claim.proposalIntent.value, candidate = reinspectionCandidate(claim, preview);
  if ((await processingSnapshot(ctx, abandonedReinspection(record.hash))).bytes) fail('PROCESSING_REINSPECTION_ABANDONING');
  await assertReinspectionWriterIdle(ctx, [claim.operationId, replacement.operationId]);
  if ((await processingSnapshot(ctx, operationPath(replacement.operationId))).bytes ||
      (await processingSnapshot(ctx, proposalPath(replacement.operationId))).bytes) fail('PROCESSING_REINSPECTION_CHANGED');
  const oldContext = { ...ctx, binding: claim.binding, bindingHash: claim.bindingHash };
  const cancelled = await processingSnapshot(ctx, operationPath(claim.operationId));
  const saved = await processingSnapshot(ctx, claimPath(claim.operationId));
  if (saved.hash !== null && saved.hash !== preview.claimHash) fail('PROCESSING_CLAIM_CHANGED');
  if (!cancelled.bytes && saved.hash === null) fail('PROCESSING_CLAIM_MISSING');
  const cancellationValue = operationRecord(oldContext, { claim, hash: preview.claimHash }, 'cancelled');
  // Retry admission must also precede successor publication, so a pending
  // transfer created by an earlier helper can still be abandoned on refusal.
  assertProcessingMetadataSize(Buffer.from(canonicalJSON(cancellationValue) + '\n'));
  const next = await processingSnapshot(ctx, claimPath(replacement.operationId));
  const replacementHash = digest(canonicalJSON(replacement) + '\n');
  if (next.hash !== null && next.hash !== replacementHash) fail('PROCESSING_CLAIM_CHANGED');
  // Before the successor claim commits, every original/current source, note and
  // parent expectation is still required. Afterwards cleanup is metadata only.
  if (!next.bytes) {
    validateReinspection(value, ctx, args);
    await assertWorkflowStorage(ctx.capability, ctx.selection, explicit);
    if (cancelled.bytes) fail('PROCESSING_REINSPECTION_CHANGED');
    await currentInputs(oldContext, claim); await currentInputs(ctx, replacement);
    await loadProposal(oldContext, claim, preview.proposalHash);
    await verifyProcessingProposal(ctx, proposal);
    await verifyExistingProposalParents(candidate); await verifyPlanTargets(candidate.plan);
  }
  for (const [index, file] of candidate.plan.files.entries()) {
    const target = reinspectionDraft(claim.operationId, index), existing = await processingSnapshot(ctx, target);
    if (existing.hash === file.expectedContentHash) continue;
    if (existing.hash !== null || next.bytes) fail('PROCESSING_PROPOSAL_CHANGED');
    const original = await processingSnapshot(ctx, proposal.copies[index].path);
    if (original.hash !== file.expectedContentHash) fail('PROCESSING_PROPOSAL_CHANGED');
    await writeProcessingBytes(ctx, target, original.bytes, null);
  }
  await options.fault?.('reinspection-copies');
  if (!next.bytes) await writeProcessingJSON(ctx, claimPath(replacement.operationId), replacement, null);
  await options.fault?.('reinspection-claim');
  let cancellation;
  if (cancelled.bytes) {
    cancellation = { ...cancelled, value: validateOperation(intakeJSON(cancelled), oldContext, claim.operationId) };
    if (cancellation.value.outcome !== 'cancelled' || cancellation.value.claimHash !== preview.claimHash ||
        !equal(cancellation.value.claim, claim) || cancellation.value.cancelledTransactionHash) fail('PROCESSING_REINSPECTION_CHANGED');
  } else cancellation = await publishOperationRecord(oldContext, cancellationValue);
  await options.fault?.('reinspection-cancellation');
  await finishOperation(oldContext, cancellation, options);
  await options.fault?.('reinspection-cleanup');
  const receiptName = reinspectionRecord(claim.operationId), archived = await processingSnapshot(ctx, receiptName);
  if (archived.hash !== null && archived.hash !== record.hash) fail('PROCESSING_REINSPECTION_CHANGED');
  if (!archived.bytes) await writeProcessingJSON(ctx, receiptName, storedReinspection(value), null);
  await options.fault?.('reinspection-archive');
  await removeProcessingJSON(ctx, reinspectionPending, record.hash);
  return reinspectionResult(value);
}

function reinspectionResult(value) {
  const proposal = value.claim.proposalIntent.value;
  return { interfaceVersion: PROCESSING_INTERFACE_VERSION, operationId: value.claim.operationId,
    replacementOperationId: value.replacement.operationId, previewHash: value.previewHash, status: 'transferred',
    proposal: retainedProposalRequest(proposal, value.replacement.binding.notes.writerStateDir, value.replacement.operationId,
      index => reinspectionDraft(value.claim.operationId, index)),
    nextAction: 'inspect-replacement-operation', savesNotes: false };
}

/** Only an explicit decision to adopt the inspected present paths permits this
 * transfer. It preserves draft bytes/history, never an earlier Save approval. */
export async function reinspectProcessing(capability, args, options = {}) {
  reinspectionArgs(args); hash(args.expectedPreviewHash);
  return withProcessingState(capability, await selected(args.selection), 'maintenance', async ctx => {
    const pending = await processingSnapshot(ctx, reinspectionPending);
    if (pending.bytes && intakeJSON(pending)?.preview?.operationId === args.operationId) return finishReinspection(ctx, { ...pending, value: await readReinspection(ctx, pending) }, args, options);
    const archived = await processingSnapshot(ctx, reinspectionRecord(args.operationId));
    if (archived.bytes) return reinspectionResult(validateReinspection(await readReinspection(ctx, archived), ctx, args, { recorded: true }));
    if (pending.bytes) fail('PROCESSING_REINSPECTION_REQUIRED');
    await assertWorkflowStorage(capability, ctx.selection, explicit);
    const { preview, claim, replacement } = await reinspectionPreview(ctx, args);
    if (digest(canonicalJSON(preview)) !== args.expectedPreviewHash) fail('PROCESSING_REINSPECTION_CHANGED');
    const value = validateReinspection({ format: 'cuefluent-processing-reinspection', version: 2,
      preview, previewHash: args.expectedPreviewHash, claim, replacement }, ctx, args);
    const originalName = reinspectionClaim(args.expectedClaimHash), original = await processingSnapshot(ctx, originalName);
    if (original.hash !== null && original.hash !== args.expectedClaimHash) fail('PROCESSING_CLAIM_CHANGED');
    if (!original.bytes) await writeProcessingJSON(ctx, originalName, claim, null);
    await options.fault?.('reinspection-source');
    const record = { value, ...(await writeProcessingJSON(ctx, reinspectionPending, storedReinspection(value), null)) };
    await options.fault?.('reinspection-intent');
    return finishReinspection(ctx, record, args, options);
  }, { allowReinspection: true });
}

/** Metadata-only rediscovery of the one pending transfer, or one named receipt.
 * Returning an earlier request hash never grants fresh approval or save authority. */
export async function inspectProcessingReinspection(capability, { operationId } = {}) {
  if (operationId !== undefined) nativeId(operationId);
  const ctx = await readProcessingState(capability, null, 'maintenance');
  const pending = await processingSnapshot(ctx, reinspectionPending);
  if (operationId === undefined && await processingReinspectionBlocker(ctx, pending) === 'writer-reserved-by-another-collection') {
    await ctx.guard();
    return { interfaceVersion: PROCESSING_INTERFACE_VERSION, state: 'reserved',
      blocker: 'writer-reserved-by-another-collection', nextAction: 'inspect-owning-collection', savesNotes: false };
  }
  let snapshot = pending, name = reinspectionPending;
  if (!pending.bytes || (operationId !== undefined && intakeJSON(pending)?.preview?.operationId !== operationId)) {
    if (operationId === undefined) { await ctx.guard(); return { interfaceVersion: PROCESSING_INTERFACE_VERSION, state: 'missing' }; }
    name = reinspectionRecord(operationId); snapshot = await processingSnapshot(ctx, name);
    if (!snapshot.bytes) { await ctx.guard(); return { interfaceVersion: PROCESSING_INTERFACE_VERSION, state: 'missing' }; }
  }
  const isPending = name === reinspectionPending;
  const value = await readReinspection(ctx, snapshot), preview = value.preview;
  const args = reinspectionRecordArgs(value);
  if (!sameProcessingPlacement(preview.binding, ctx.binding)) fail('PROCESSING_BINDING_CHANGED');
  validateReinspection(value, { ...ctx, selection: args.selection }, args, { recorded: true });
  const successor = await processingSnapshot(ctx, claimPath(value.replacement.operationId));
  const abandoning = isPending && (await processingSnapshot(ctx, abandonedReinspection(snapshot.hash))).bytes !== null;
  const conflict = !equal(preview.binding, ctx.binding) || preview.bindingHash !== ctx.bindingHash ? 'PROCESSING_BINDING_CHANGED'
    : preview.policyHash !== ctx.policyHash ? 'WORKFLOW_POLICY_CHANGED' : null;
  if ((await processingSnapshot(ctx, name)).hash !== snapshot.hash ||
      (await processingSnapshot(ctx, reinspectionPending)).hash !== pending.hash) fail('PROCESSING_INVENTORY_CHANGED');
  await ctx.guard();
  return { interfaceVersion: PROCESSING_INTERFACE_VERSION, state: isPending ? 'transfer-pending' : 'transferred',
    recordHash: snapshot.hash, conflict, args, savesNotes: false,
    retainedDrafts: { directory: path.dirname(path.join(ctx.collection.notes.writerStateDir, reinspectionDraft(value.claim.operationId, 0))),
      files: value.claim.proposalIntent.value.copies.length, retention: 'indefinite; no automatic cleanup' },
    otherPendingTransfer: !isPending && pending.bytes ? { operationId: intakeJSON(pending)?.preview?.operationId ?? null, recordHash: pending.hash } : null,
    canAbandon: isPending && successor.hash === null, abandoning,
    nextAction: isPending ? abandoning || (conflict && !successor.bytes) ? 'processing-reinspection-abandon' : 'processing-reinspect' : 'processing-status' };
}

/** Abandon only an uncommitted transfer, preserving its original claim and all
 * note/evidence bytes. The exact intent is archived before owned copies are
 * removed, so interruption can only resume abandonment, never commit a successor. */
export async function abandonProcessingReinspection(capability, { expectedRecordHash }, options = {}) {
  hash(expectedRecordHash);
  return withProcessingState(capability, null, 'maintenance', async ctx => {
    const pending = await processingSnapshot(ctx, reinspectionPending);
    const archiveName = abandonedReinspection(expectedRecordHash), archive = await processingSnapshot(ctx, archiveName);
    if (pending.hash !== expectedRecordHash) {
      if (archive.hash === expectedRecordHash) return { interfaceVersion: PROCESSING_INTERFACE_VERSION, status: 'abandoned', recordHash: expectedRecordHash, savesNotes: false };
      fail('PROCESSING_REINSPECTION_CHANGED');
    }
    const value = await readReinspection(ctx, pending);
    const args = reinspectionRecordArgs(value);
    validateReinspection(value, { ...ctx, selection: args.selection }, args, { recorded: true });
    if ((await processingSnapshot(ctx, claimPath(args.operationId))).hash !== args.expectedClaimHash) fail('PROCESSING_CLAIM_CHANGED');
    for (const name of [claimPath(args.replacementOperationId), proposalPath(args.replacementOperationId),
      operationPath(args.operationId), operationPath(args.replacementOperationId), reinspectionRecord(args.operationId)]) {
      if ((await processingSnapshot(ctx, name)).bytes) fail('PROCESSING_REINSPECTION_COMMITTED');
    }
    await assertReinspectionWriterIdle(ctx, [args.operationId, args.replacementOperationId]);
    if (archive.hash !== null && archive.hash !== pending.hash) fail('PROCESSING_REINSPECTION_CHANGED');
    if (!archive.bytes) await writeProcessingBytes(ctx, archiveName, pending.bytes, null);
    await options.fault?.('reinspection-abandon-intent');
    for (const [index, copy] of value.claim.proposalIntent.value.copies.entries()) {
      const name = reinspectionDraft(args.operationId, index);
      const retained = await processingSnapshot(ctx, name);
      if (retained.bytes && retained.hash !== copy.hash) fail('PROCESSING_PROPOSAL_CHANGED');
      const original = await processingSnapshot(ctx, copy.path);
      if (original.hash === null && retained.bytes) {
        await writeProcessingBytes(ctx, copy.path, retained.bytes, null);
        await options.fault?.('reinspection-abandon-restored');
      } else if (original.hash !== copy.hash) fail('PROCESSING_PROPOSAL_CHANGED');
      await removeProcessingJSON(ctx, name, copy.hash);
    }
    const directory = path.dirname(await intakePath(ctx.writer, 'state', reinspectionDraft(args.operationId, 0)));
    await ctx.guard(); await assertPrivatePaths(ctx.capability, [directory]);
    try { await fs.rmdir(directory); await syncDirectory(path.dirname(directory)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await options.fault?.('reinspection-abandon-copies');
    await removeProcessingJSON(ctx, reinspectionPending, expectedRecordHash);
    return { interfaceVersion: PROCESSING_INTERFACE_VERSION, status: 'abandoned', recordHash: expectedRecordHash, savesNotes: false };
  }, { allowReinspection: true });
}
