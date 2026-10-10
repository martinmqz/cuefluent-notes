import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, inspectedClaim, proposedClaim } from './test-support/processing-fixture.mjs';
import { createProcessingWorkset, prepareWorksetBatch, inspectProcessingWorkset, listProcessingWorksets } from './processing-workset.mjs';
import { prepareProcessing, completeProcessing, inspectProcessing, proposeProcessing } from './processing.mjs';
import { executeWorkflow, workflowErrorReport } from './workflow.mjs';

test('actual serialized batch bytes gate admission without reserving an oversized singleton', async t => {
  const f = await processingFixture(t, { text: '雪\\"\n'.repeat(16000) });
  let size;
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, inputs: f.inputs }), error => {
    assert.equal(error.code, 'PROCESSING_BATCH_BUDGET'); size = error.details.packetBytes; assert(size > 65536);
    assert.deepEqual(workflowErrorReport(error).details.inputSizes, [{ index: 0, packetBytes: size }]); return true;
  });
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'missing');
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, inputs: f.inputs, budget: { maxInputs: 1, maxPacketBytes: size - 1 } }), /PROCESSING_BATCH_BUDGET/);
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs, budget: { maxInputs: 1, maxPacketBytes: size } });
  assert.equal(claim.workload.packetBytes, size); assert(claim.workload.renderedPageBytes > size);
  assert.equal((await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs })).claimHash, claim.claimHash);
});

test('collection admission is shared by disjoint sessions and preserves excess claims for exact retries', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f });
  b.args.selection = { ...b.selection, client: 'claude' }; // Claude processor, shared Codex evidence.
  const results = await Promise.allSettled([f, b].map(item => prepareProcessing(item.capability, { ...item.args, inputs: item.inputs })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert(['INTAKE_BLOCKED', 'PROCESSING_RESUME_REQUIRED'].includes(results.find(item => item.status === 'rejected').reason.code));
  const waiting = results[0].status === 'rejected' ? f : b;
  await assert.rejects(prepareProcessing(waiting.capability, { ...waiting.args, inputs: waiting.inputs }), /PROCESSING_RESUME_REQUIRED/);
  const extra = await prepareProcessing(waiting.capability, { ...waiting.args, inputs: waiting.inputs, parallelism: 2 });
  assert.equal((await prepareProcessing(waiting.capability, { ...waiting.args, inputs: waiting.inputs })).claimHash, extra.claimHash);
  const c = await processingFixture(t, { base: f });
  await assert.rejects(prepareProcessing(c.capability, { ...c.args, inputs: c.inputs }), /PROCESSING_RESUME_REQUIRED/);
});

test('published proposals release inspection slots but their queue cannot grow beyond five', async t => {
  const f = await processingFixture(t);
  for (let i = 0; i < 4; i++) {
    const next = i === 0 ? f : await processingFixture(t, { base: f });
    await proposedClaim(next, { name: `note-${i}.md` });
  }
  const fifth = await processingFixture(t, { base: f }), sixth = await processingFixture(t, { base: f });
  const a = await inspectedClaim(fifth), b = await inspectedClaim(sixth, { parallelism: 2 });
  await proposedClaim(fifth, { claim: a, name: 'fifth.md' });
  await assert.rejects(proposedClaim(sixth, { claim: b, name: 'sixth.md' }), /PROCESSING_PROPOSAL_QUEUE_FULL/);
  const next = await processingFixture(t, { base: f });
  await assert.rejects(prepareProcessing(next.capability, { ...next.args, inputs: next.inputs }), /PROCESSING_PROPOSAL_QUEUE_FULL/);
  assert.equal((await prepareProcessing(sixth.capability, { ...sixth.args, inputs: sixth.inputs })).claimHash, b.claimHash);
  // Simulate a valid pre-limit sixth publication through the canonical staging
  // primitives. Current admission cannot create this state, but old users have it.
  const { withProcessingState, processingSnapshot, writeProcessingJSON } = await import('./processing-state.mjs');
  const { buildProcessingProposal, copyProcessingProposal, proposalHash } = await import('./processing-proposal.mjs');
  const { intakeJSON } = await import('./intake-io.mjs');
  const { digest } = await import('./workflow-values.mjs');
  const contentPath = path.join(f.root, 'legacy-draft.md'), content = '# Subject\n\n## Decision\n\nKeep the decision.\n';
  await fs.writeFile(contentPath, content, { mode: 0o600 });
  const legacy = await withProcessingState(sixth.capability, sixth.selection, 'explicitProcess', async ctx => {
    const name = `claims/${sixth.operationId}.json`, snapshot = await processingSnapshot(ctx, name), claim = intakeJSON(snapshot);
    const proposal = await buildProcessingProposal(ctx, claim, { files: [{ path: 'legacy.md', expectedHash: null, contentPath, expectedContentHash: digest(content) }],
      mappings: [{ identity: sixth.identity, paths: ['legacy.md'] }] });
    claim.proposalIntent = { hash: proposalHash(proposal), value: proposal };
    const saved = await writeProcessingJSON(ctx, name, claim, snapshot.hash);
    await copyProcessingProposal(ctx, proposal);
    await writeProcessingJSON(ctx, `proposals/${sixth.operationId}/record.json`, proposal, null);
    return saved.hash;
  });
  assert((await proposeProcessing(sixth.capability, { ...sixth.args, expectedClaimHash: legacy })).plan);
  await fs.writeFile(path.join(f.collection.notes.writerStateDir, 'proposals', sixth.operationId, 'record.json'), '{');
  await assert.rejects(prepareProcessing(next.capability, { ...next.args, inputs: next.inputs }), error => {
    assert.equal(workflowErrorReport(error).operationId, sixth.operationId); return true;
  });
});

test('workset survives admission interruption, freezes arrivals and charges the same operation once', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f }), worksetId = randomUUID();
  let workset = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: [...f.inputs, ...b.inputs],
    runBudget: { maxBatches: 1, maxPacketBytes: 65536 }, unscannedRemainder: true });
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] },
    { fault: at => { if (at === 'workset-admission') throw new Error('crash'); } }), /crash/);
  workset = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(workset.operations[0].admissionPending, true); assert.equal(workset.chargedBatches, 1);
  const operationId = workset.operations[0].operationId;
  const batch = await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  assert.equal(batch.operationId, operationId); assert.equal(batch.workset.chargedBatches, 1);
  await completeProcessing(f.capability, { selection: f.selection, operationId, expectedClaimHash: batch.claimHash, outcome: 'cancelled' });
  await processingFixture(t, { base: f }); // Incoming capture never joins the frozen list.
  workset = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(workset.inputs.length, 2); assert.equal(workset.remainingSelected, 2); assert.equal(workset.budgetExhausted, true);
  assert.equal(workset.items[0].state, 'cancelled'); assert.equal(workset.items[1].state, 'unattempted');
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [1] }), /PROCESSING_WORKSET_BUDGET/);
  const retry = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: [...f.inputs, ...b.inputs],
    runBudget: { maxBatches: 1, maxPacketBytes: 65536 }, unscannedRemainder: true });
  assert.equal(retry.worksetHash, workset.worksetHash);
});

test('workset CLI refuses stale heads without swapping revisions or consuming run budget', async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  const call = (command, args) => executeWorkflow(command, { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash, args }, { configPath: f.options.configPath });
  const created = await call('processing-workset-create', { selection: f.selection, worksetId, inputs: f.inputs });
  const head = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  await fs.appendFile(head, ' ');
  await assert.rejects(call('processing-workset-prepare', { worksetId, expectedWorksetHash: created.worksetHash, indexes: [0] }), /PROCESSING_HEAD_CHANGED/);
  const status = await call('processing-workset-status', { worksetId });
  assert.equal(status.items[0].state, 'blocked'); assert.equal(status.chargedBatches, 0);
  assert.equal(status.inputs[0].headHash, f.published.headHash);
});

test('run byte budget is independent of the explicit per-batch budget', async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  const workset = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs,
    runBudget: { maxBatches: 2, maxPacketBytes: 1 } });
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] }), /PROCESSING_WORKSET_BUDGET/);
  const status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.chargedBatches, 0); assert.equal(status.operations.length, 0);
});

test('admitted larger workload resumes its exact cost and five-input default rejects before reservation', async t => {
  const f = await processingFixture(t, { text: 'Synthetic long evidence. '.repeat(4000) }), worksetId = randomUUID();
  const fake = Array.from({ length: 6 }, () => ({ identity: { ...f.identity, unitId: randomUUID() }, headHash: f.published.headHash }));
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, inputs: fake }), /PROCESSING_BATCH_BUDGET/);
  const workset = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0],
    batchBudget: { maxInputs: 1, maxPacketBytes: 4 * 1024 * 1024 } }, { fault: () => { throw new Error('crash'); } }), /crash/);
  const pending = await inspectProcessingWorkset(f.capability, { worksetId });
  const batch = await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: pending.worksetHash, indexes: [0] });
  assert(batch.packet.bytes > 65536); assert.equal(batch.workset.chargedBatches, 1);
});


test('workset status reconciles external claims and dispositions without inventing work', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f }), worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: [...f.inputs, ...b.inputs] });
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  let status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.items[0].state, 'blocked'); assert.equal(status.items[0].externalOperationId, f.operationId);
  assert.equal(status.inputCounts.blocked, 1); assert.equal(status.inputCounts.unattempted, 1);
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' });
  status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.items[0].state, 'handled-elsewhere'); assert.equal(status.items[0].externalOutcome, 'skipped');
  assert.equal(status.inputCounts.handledElsewhere, 1); assert.equal(status.remainingSelected, 1);
  assert.equal(Object.values(status.inputCounts).reduce((n, count) => n + count, 0), 2);
});

test('worksets are rediscoverable through paginated public CLI without raw reads or writes', async t => {
  const f = await processingFixture(t), ids = [randomUUID(), randomUUID()].sort();
  for (const worksetId of ids) await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  const { captureRelativePath } = await import('./capture-contract.mjs');
  await fs.unlink(path.join(f.collection.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash)));
  await fs.unlink(f.source.path);
  const before = await fs.readdir(f.collection.notes.writerStateDir, { recursive: true });
  const listed = await executeWorkflow('processing-worksets', { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash,
    args: { selection: f.selection, limit: 1 } }, { configPath: f.options.configPath });
  assert.equal(listed.worksets[0].worksetId, ids[0]); assert.equal(listed.nextCursor, ids[0]);
  const next = await listProcessingWorksets(f.capability, { afterWorksetId: listed.nextCursor, limit: 1 });
  assert.equal(next.worksets[0].worksetId, ids[1]); assert.equal(next.incomplete, false);
  assert.equal((await inspectProcessingWorkset(f.capability, { worksetId: ids[0] })).inputCounts.unattempted, 1);
  assert.deepEqual(await fs.readdir(f.collection.notes.writerStateDir, { recursive: true }), before);
});

test('workset metadata reads require fresh private-file permissions', { skip: process.platform === 'win32' ? 'POSIX permission mutation; native Windows ACL contract covered by storage tests' : false }, async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  const head = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  await fs.chmod(head, 0o644);
  await assert.rejects(createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs }), /STORAGE_NOT_PRIVATE/);
  await fs.chmod(head, 0o600);
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  await fs.chmod(head, 0o644);
  await assert.rejects(inspectProcessingWorkset(f.capability, { worksetId }), /STORAGE_NOT_PRIVATE/);
});

test('an interrupted admission handled elsewhere is blocked rather than reported resumable', async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  const created = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: created.worksetHash, indexes: [0] },
    { fault: () => { throw new Error('crash'); } }), /crash/);
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' });
  const status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.operations[0].state, 'blocked'); assert.equal(status.remainingSelected, 0);
  assert.equal(status.items[0].externalOutcome, 'skipped'); assert.equal(status.operationCounts.inspection, 0);
});

test('workset resumes durable page progress, exact review and committed-save recovery', async t => {
  const { readProcessingPage, acknowledgeProcessingPages, saveProcessing, recoverProcessing } = await import('./processing.mjs');
  const f = await processingFixture(t), worksetId = randomUUID();
  const workset = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  const batch = await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  const args = { ...f.args, operationId: batch.operationId };
  const issued = await readProcessingPage(f.capability, { ...args, expectedClaimHash: batch.claimHash, page: 0 });
  let status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.operations[0].state, 'unread'); assert.equal(status.operations[0].inspection.issuedPages, 1);
  const claim = await acknowledgeProcessingPages(f.capability, { ...args, expectedClaimHash: issued.claimHash, pages: [{ index: 0, hash: issued.hash }] });
  assert.equal((await inspectProcessingWorkset(f.capability, { worksetId })).operations[0].state, 'inspected');
  const proposal = await proposedClaim({ ...f, args, operationId: batch.operationId }, { claim });
  assert.equal((await inspectProcessingWorkset(f.capability, { worksetId })).operationCounts.awaitingReview, 1);
  await assert.rejects(saveProcessing(f.capability, { ...args, expectedClaimHash: proposal.claimHash, approvedProposalHash: proposal.proposalHash },
    { fault: at => { if (at === 'afterReceipt') throw new Error('crash'); } }), /crash/);
  status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.operationCounts.recoveryRequired, 1); assert.equal(status.operationCounts.inspection, 0);
  await recoverProcessing(f.capability, { operationId: batch.operationId, expectedRecoveryHash: status.operations[0].recoveryHash });
  status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.outcomeCounts.saved, 1); assert.equal(status.inputCounts.handled, 1); assert.equal(status.operationCounts.terminal, 1);
});
