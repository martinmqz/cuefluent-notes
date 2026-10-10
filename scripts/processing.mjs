import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWorkflowStorage, workflowProcessingPolicy, assertWorkflowAuthorizations, assertPrivatePaths } from './workflow-storage.mjs';
import { readSelection, readCaptureHead } from './intake-store.mjs';
import { intakePath, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { unitKey, assertNoPrune, readLineageRecord, dispositionPath, validateProcessingDisposition, tombstonePath, assertCaptureRetained } from './capture-retention.mjs';
import { logicalCaptureIdentity } from './capture-contract.mjs';
import { withProcessingState, readProcessingState, processingSnapshot, processingJSON, writeProcessingJSON, removeProcessingJSON, processingNames } from './processing-state.mjs';
import { claimPath, proposalPath, transactionPath, operationPath, associationPath, validateClaim, validateAssociation, operationContext, inspectionProgress, PROCESSING_INTERFACE_VERSION } from './processing-contract.mjs';
import { normalizeWorkflowSelection as selected } from './workflow-selection.mjs';
import { renderProcessingPacket, packetManifest, validatePageIndex, PROCESSING_PAGE_BYTES } from './processing-packet.mjs';
import { processingPageLayout, processingPagePaths, readProcessingExtent } from './processing-page.mjs';
import { buildProcessingProposal, validateProcessingProposal, copyProcessingProposal, verifyProcessingProposal, verifyExistingProposalParents, proposalHash } from './processing-proposal.mjs';
import { applyPlan, recover, finalizeRecordedWriter, verifyPlanTargets } from './safe-update.mjs';
import { readWriterReceipt as writerReceipt } from './writer-protocol.mjs';
import { syncDirectory } from './file-io.mjs';
import { canonicalJSON, digest, fail, keys, list, hash, nativeId, unique, choice, timestamp } from './workflow-values.mjs';

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
async function loadClaim(ctx, operationId, expectedHash) {
  nativeId(operationId); const snapshot = await processingSnapshot(ctx, claimPath(operationId));
  if (!snapshot.bytes) fail('PROCESSING_CLAIM_MISSING');
  if (expectedHash !== undefined && expectedHash !== snapshot.hash) fail('PROCESSING_CLAIM_CHANGED');
  const claim = validateClaim(intakeJSON(snapshot));
  if (claim.operationId !== operationId || claim.bindingHash !== ctx.bindingHash || !equal(claim.binding, ctx.binding)) fail('PROCESSING_BINDING_CHANGED');
  if (ctx.operation !== 'maintenance' && (!equal(claim.selection, ctx.selection) || claim.policyHash !== ctx.policyHash)) fail('PROCESSING_SELECTION_CHANGED');
  return { claim, hash: snapshot.hash };
}
function checkedInspection(claim) {
  if (claim.acknowledged.length !== claim.packet.pages.length) fail('PROCESSING_INSPECTION_INCOMPLETE');
}
async function assertNoTransaction(ctx) {
  if ((await processingNames(ctx, 'transactions')).length) fail('PROCESSING_RECOVERY_REQUIRED');
  if ((await processingSnapshot(ctx, 'journal.json')).bytes) fail('WRITER_RECOVERY_REQUIRED');
}
async function requireIncomplete(ctx, operationId) {
  if ((await processingSnapshot(ctx, operationPath(operationId))).bytes) fail('PROCESSING_OPERATION_COMPLETE');
}

/** Explicit selection only while native current-turn delivery is unverified. */
export async function prepareProcessing(capability, { selection, operationId, inputs, reconsider = false }) {
  selection = await selected(selection); nativeId(operationId);
  list(inputs, 20, { empty: false }); unique(inputs.map(input => unitKey(input.identity)));
  if (typeof reconsider !== 'boolean') fail('INVALID_PROCESSING_REQUEST');
  return withProcessingState(capability, selection, explicit, async ctx => {
    await noPendingIntake(ctx); await assertNoTransaction(ctx);
    const complete = await processingJSON(ctx, operationPath(operationId));
    if (complete !== null) fail('PROCESSING_OPERATION_COMPLETE');
    const existing = await processingSnapshot(ctx, claimPath(operationId));
    if (existing.bytes) {
      const saved = await loadClaim(ctx, operationId);
      if (!equal(saved.claim.inputs.map(inputReference), inputs)) fail('PROCESSING_OPERATION_CONFLICT');
      return summary(saved.claim, saved.hash);
    }
    const sources = [], associations = [];
    for (const reference of inputs) {
      const current = await activatedInput(ctx, reference);
      if (current.input.dispositionHash !== null && !reconsider) fail('PROCESSING_INPUT_ALREADY_HANDLED');
      sources.push({ input: current.input, capture: current.capture }); associations.push(current.association);
    }
    for (const name of await processingNames(ctx, 'claims')) {
      const other = validateClaim(await processingJSON(ctx, name));
      if (other.bindingHash === ctx.bindingHash && other.inputs.some(input => sources.some(source => unitKey(source.input.identity) === unitKey(input.identity)))) fail('PROCESSING_INPUT_CLAIMED');
    }
    const packet = renderProcessingPacket(sources), descriptors = sources.map(source => source.input);
    const claim = validateClaim({ format: 'cuefluent-processing-claim', version: 1, operationId, bindingHash: ctx.bindingHash, binding: ctx.binding,
      selection, policyHash: ctx.policyHash, createdAt: new Date().toISOString(), inputs: descriptors, inputsHash: digest(canonicalJSON(descriptors)),
      packet: packetManifest(sources, packet), issued: [], acknowledged: [], proposalIntent: null });
    const saved = await writeProcessingJSON(ctx, claimPath(operationId), claim, null);
    return { ...summary(claim, saved.hash), associations };
  });
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
async function publishOperation(ctx, saved, outcome, proposal = null, receipt = null, cancelledTransactionHash = null) {
  const value = { format: 'cuefluent-processing-operation', version: 1, operationId: saved.claim.operationId, bindingHash: ctx.bindingHash,
    claim: saved.claim, claimHash: saved.hash, outcome, processedAt: receipt?.value.committedAt ?? new Date().toISOString(), proposal, writerReceiptHash: receipt?.hash ?? null,
    ...(cancelledTransactionHash === null ? {} : { cancelledTransactionHash }) };
  validateOperation(value, ctx, value.operationId);
  return { value, ...(await writeProcessingJSON(ctx, operationPath(value.operationId), value, null)) };
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
    const tx = { value, ...(await writeProcessingJSON(ctx, transactionPath(operationId), value, null)) };
    await options.fault?.('write-intent');
    return executeTransaction(ctx, tx, options);
  });
}

async function assertUnappliedTransaction(ctx, claim, claimHash, tx, expectedHash, { allowMissing = false } = {}) {
  if (tx.value ? tx.hash !== expectedHash || tx.value.claimHash !== claimHash || !equal(tx.value.claim, claim) : !allowMissing) fail('PROCESSING_RECOVERY_CHANGED');
  if ((await processingSnapshot(ctx, 'journal.json')).bytes || await readWriterReceipt(ctx, claim.operationId)) fail('PROCESSING_RECOVERY_REQUIRED');
}

export async function completeProcessing(capability, { selection, operationId, expectedClaimHash, expectedRecoveryHash, outcome }, options = {}) {
  choice(outcome, ['unchanged', 'skipped', 'cancelled']);
  if (expectedRecoveryHash !== undefined) { hash(expectedRecoveryHash); if (outcome !== 'cancelled') fail('INVALID_PROCESSING_REQUEST'); }
  return withProcessingState(capability, await selected(selection), outcome === 'cancelled' ? 'maintenance' : explicit, async ctx => {
    await requireIncomplete(ctx, operationId);
    const saved = await loadClaim(ctx, operationId, expectedClaimHash);
    let cancelledTransactionHash = null;
    if (outcome === 'cancelled' && expectedRecoveryHash !== undefined) {
      const tx = await transactionSnapshot(ctx, operationId);
      if ((await processingNames(ctx, 'transactions')).some(name => name !== transactionPath(operationId))) fail('PROCESSING_RECOVERY_REQUIRED');
      await assertUnappliedTransaction(ctx, saved.claim, saved.hash, tx, expectedRecoveryHash);
      cancelledTransactionHash = tx.hash;
    } else await assertNoTransaction(ctx);
    if (outcome === 'unchanged') { checkedInspection(saved.claim); await currentInputs(ctx, saved.claim); }
    const record = await publishOperation(ctx, saved, outcome, null, null, cancelledTransactionHash); await options.fault?.('operation-receipt');
    return finishOperation(ctx, record, options);
  });
}

/** Recovery requires an exact reviewed transaction or operation-record hash.
 * A saved receipt permits metadata-only completion under maintenance authority.
 * Without it, the old consent, inputs and approved proposal must still match. */
export async function recoverProcessing(capability, { operationId, expectedRecoveryHash }, options = {}) {
  nativeId(operationId); hash(expectedRecoveryHash);
  return withProcessingState(capability, null, 'maintenance', async ctx => {
    const record = await processingSnapshot(ctx, operationPath(operationId));
    if (record.bytes) {
      if (record.hash !== expectedRecoveryHash) fail('PROCESSING_RECOVERY_CHANGED');
      return finishOperation(ctx, { ...record, value: intakeJSON(record) }, options);
    }
    const tx = await transactionSnapshot(ctx, operationId);
    if (!tx.value || tx.hash !== expectedRecoveryHash) fail('PROCESSING_RECOVERY_CHANGED');
    return executeTransaction(ctx, tx, options);
  });
}

export async function describeProcessingOperation(ctx, operationId) {
  nativeId(operationId);
  try { return await describeOperation(ctx, operationId); }
  catch (error) { error.operationId = operationId; throw error; }
}
async function describeOperation(ctx, operationId) {
  const operation = await processingSnapshot(ctx, operationPath(operationId)), tx = await transactionSnapshot(ctx, operationId);
  const saved = await processingSnapshot(ctx, claimPath(operationId));
  const completed = operation.bytes ? validateOperation(intakeJSON(operation), ctx, operationId) : null;
  const claim = saved.bytes ? validateClaim(intakeJSON(saved)) : null;
  if (claim && (claim.operationId !== operationId || claim.bindingHash !== ctx.bindingHash || !equal(claim.binding, ctx.binding))) fail('PROCESSING_BINDING_CHANGED');
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
  let conflict = claim && claim.policyHash !== ctx.policyHash ? 'WORKFLOW_POLICY_CHANGED' : null;
  const blockers = [];
  if (claim && !completed && !tx.hash) {
    if (!conflict) {
      try { await checkCurrentInputMetadata(ctx, claim); }
      catch (error) {
        if (['PROCESSING_HEAD_CHANGED', 'PROCESSING_INPUT_CHANGED', 'CAPTURE_PRUNED'].includes(error.code)) conflict = error.code;
        else if (['INTAKE_RECOVERY_REQUIRED', 'PRUNE_RECOVERY_REQUIRED'].includes(error.code)) blockers.push(error.code);
        else throw error;
      }
    }
    try { await assertNoTransaction(ctx); }
    catch (error) {
      if (['PROCESSING_RECOVERY_REQUIRED', 'WRITER_RECOVERY_REQUIRED'].includes(error.code)) blockers.push(error.code);
      else throw error;
    }
  }
  const state = completed ? 'completed' : tx.hash ? 'recovery-required' : conflict ? 'conflicted' : blockers.length ? 'blocked' : published ? 'awaiting-review'
    : claim?.proposalIntent ? 'draft-staging' : inspection?.state ?? 'missing';
  const recoveryRequired = Boolean(tx.hash || (completed && saved.hash));
  const nextAction = recoveryRequired ? { command: 'processing-recover' }
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
