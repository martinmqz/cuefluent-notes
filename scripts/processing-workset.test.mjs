import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, inspectedClaim, proposedClaim } from './test-support/processing-fixture.mjs';
import { createProcessingWorkset, prepareWorksetBatch, inspectProcessingWorkset, listProcessingWorksets } from './processing-workset.mjs';
import { prepareProcessing, completeProcessing, inspectProcessing, proposeProcessing } from './processing.mjs';
import { executeWorkflow, workflowErrorReport } from './workflow.mjs';
import { pendingProcessing } from './processing-inventory.mjs';

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
  // Fabricate an over-cap publication that current admission cannot create.
  // It must refuse without treating an existing intent as upgrade authority.
  const { withProcessingState, processingSnapshot, writeProcessingJSON } = await import('./processing-state.mjs');
  const { buildProcessingProposal, copyProcessingProposal, proposalHash } = await import('./processing-proposal.mjs');
  const { intakeJSON } = await import('./intake-io.mjs');
  const { digest } = await import('./workflow-values.mjs');
  const contentPath = path.join(f.root, 'excess-draft.md'), content = '# Subject\n\n## Decision\n\nKeep the decision.\n';
  await fs.writeFile(contentPath, content, { mode: 0o600 });
  const excessClaimHash = await withProcessingState(sixth.capability, sixth.selection, 'explicitProcess', async ctx => {
    const name = `claims/${sixth.operationId}.json`, snapshot = await processingSnapshot(ctx, name), claim = intakeJSON(snapshot);
    const proposal = await buildProcessingProposal(ctx, claim, { files: [{ path: 'excess.md', expectedHash: null, contentPath, expectedContentHash: digest(content) }],
      mappings: [{ identity: sixth.identity, paths: ['excess.md'] }] });
    claim.proposalIntent = { hash: proposalHash(proposal), value: proposal };
    const saved = await writeProcessingJSON(ctx, name, claim, snapshot.hash);
    await copyProcessingProposal(ctx, proposal);
    await writeProcessingJSON(ctx, `proposals/${sixth.operationId}/record.json`, proposal, null);
    return saved.hash;
  });
  const claimFile = path.join(f.collection.notes.writerStateDir, 'claims', `${sixth.operationId}.json`);
  const proposalFile = path.join(f.collection.notes.writerStateDir, 'proposals', sixth.operationId, 'record.json');
  const beforeClaim = await fs.readFile(claimFile), beforeProposal = await fs.readFile(proposalFile);
  await assert.rejects(proposeProcessing(sixth.capability, { ...sixth.args, expectedClaimHash: excessClaimHash }),
    { code: 'PROCESSING_PROPOSAL_QUEUE_FULL' });
  assert.deepEqual(await fs.readFile(claimFile), beforeClaim);
  assert.deepEqual(await fs.readFile(proposalFile), beforeProposal);
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

for (const completed of [false, true]) for (const mismatch of ['inputs', 'packet']) {
  test(`workset status rejects a reused admission ID with different ${mismatch}, completed=${completed}`, async t => {
    const f = await processingFixture(t), worksetId = randomUUID();
    const created = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
    await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: created.worksetHash, indexes: [0] },
      { fault: () => { throw new Error('crash'); } }), /crash/);
    const admitted = await inspectProcessingWorkset(f.capability, { worksetId });
    const operationId = admitted.operations[0].operationId;
    let inputs;
    if (mismatch === 'inputs') inputs = (await processingFixture(t, { base: f })).inputs;
    else {
      // Identical capture references can have a different packet after another
      // operation changes their exact disposition metadata.
      const external = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
      await completeProcessing(f.capability, { ...f.args, expectedClaimHash: external.claimHash, outcome: 'skipped' });
      inputs = f.inputs;
    }
    const wrong = await prepareProcessing(f.capability, { selection: f.selection, operationId, inputs, reconsider: mismatch === 'packet' });
    if (completed) await completeProcessing(f.capability, { selection: f.selection, operationId, expectedClaimHash: wrong.claimHash, outcome: 'skipped' });
    const file = path.join(f.collection.notes.writerStateDir, 'processed', 'worksets', worksetId + '.json');
    const before = await fs.readFile(file);
    await assert.rejects(inspectProcessingWorkset(f.capability, { worksetId }), error => {
      assert.deepEqual(workflowErrorReport(error), { error: 'PROCESSING_OPERATION_CONFLICT', operationId }); return true;
    });
    assert.deepEqual(await fs.readFile(file), before, 'the original charged admission remains intact');
    const listed = (await listProcessingWorksets(f.capability)).worksets[0];
    assert.equal(listed.worksetHash, admitted.worksetHash); assert.equal(listed.chargedBatches, 1);
    assert.equal((await inspectProcessing(f.capability, operationId)).state, completed ? 'completed' : 'unread');
    if (mismatch === 'inputs') assert.equal((await pendingProcessing(f.capability, { selection: f.selection })).counts.unclaimedRevisions, 1);
  });
}


test('workset size diagnostics identify frozen indexes even for an out-of-order batch', async t => {
  const f = await processingFixture(t), inputs = [...f.inputs];
  for (let i = 1; i < 8; i++) inputs.push(...(await processingFixture(t, { base: f, text: 'x'.repeat(i * 1000) })).inputs);
  const worksetId = randomUUID();
  const workset = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs });
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash,
    indexes: [7, 3], batchBudget: { maxInputs: 2, maxPacketBytes: 1 } }), error => {
    const report = workflowErrorReport(error);
    assert.equal(report.error, 'PROCESSING_BATCH_BUDGET');
    assert.deepEqual(report.details.inputSizes.map(item => item.index), [3, 7]);
    assert(report.details.inputSizes[1].packetBytes > report.details.inputSizes[0].packetBytes);
    return true;
  });
  assert.equal((await inspectProcessingWorkset(f.capability, { worksetId })).chargedBatches, 0);
});

test('over-ceiling batches return every measured input without creating a claim', async t => {
  const f = await processingFixture(t, { text: 'x'.repeat(1500000) }), inputs = [...f.inputs];
  for (let i = 0; i < 2; i++) inputs.push(...(await processingFixture(t, { base: f, text: 'y'.repeat(1500000) })).inputs);
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, inputs, budget: { maxInputs: 3, maxPacketBytes: 4194304 } }), error => {
    const report = workflowErrorReport(error);
    assert.equal(report.error, 'PROCESSING_BATCH_BUDGET'); assert(report.details.packetBytes > 4194304);
    assert.deepEqual(report.details.inputSizes.map(item => item.index), [0, 1, 2]);
    assert(report.details.inputSizes.every(item => item.packetBytes > 1500000)); return true;
  });
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'missing');
});

test('staged proposals reserve queue space and refuse excess intents without changing their own state', async t => {
  const f = await processingFixture(t);
  for (let i = 0; i < 4; i++) await proposedClaim(i === 0 ? f : await processingFixture(t, { base: f }), { name: `queued-${i}.md` });
  const a = await processingFixture(t, { base: f }), b = await processingFixture(t, { base: f });
  const first = await inspectedClaim(a), second = await inspectedClaim(b, { parallelism: 2 });
  const draft = path.join(f.root, 'queue-draft.md'), content = '# Synthetic subject\n\n## Decision\n\nKeep this result.\n';
  const { digest } = await import('./workflow-values.mjs');
  await fs.writeFile(draft, content, { mode: 0o600 });
  await assert.rejects(proposeProcessing(a.capability, { ...a.args, expectedClaimHash: first.claimHash,
    proposal: { files: [{ path: 'staged.md', expectedHash: null, contentPath: draft, expectedContentHash: digest(content) }],
      mappings: [{ identity: a.identity, paths: ['staged.md'] }] } }, { fault: at => { if (at === 'proposal-intent') throw new Error('crash'); } }), /crash/);
  let status = await inspectProcessing(a.capability, a.operationId);
  assert.equal(status.state, 'draft-staging');
  await assert.rejects(proposedClaim(b, { claim: second, name: 'sixth.md' }), /PROCESSING_PROPOSAL_QUEUE_FULL/);
  // Fabricate a fifth other publication after A reserved its slot. Current
  // admission refuses this state instead of supporting an over-cap replay.
  const { withProcessingState, processingSnapshot, writeProcessingJSON } = await import('./processing-state.mjs');
  const { buildProcessingProposal, copyProcessingProposal, proposalHash } = await import('./processing-proposal.mjs');
  const { intakeJSON } = await import('./intake-io.mjs');
  const excessClaimHash = await withProcessingState(b.capability, b.selection, 'explicitProcess', async ctx => {
    const name = `claims/${b.operationId}.json`, snapshot = await processingSnapshot(ctx, name), claim = intakeJSON(snapshot);
    const proposal = await buildProcessingProposal(ctx, claim, { files: [{ path: 'other.md', expectedHash: null, contentPath: draft, expectedContentHash: digest(content) }],
      mappings: [{ identity: b.identity, paths: ['other.md'] }] });
    claim.proposalIntent = { hash: proposalHash(proposal), value: proposal };
    const saved = await writeProcessingJSON(ctx, name, claim, snapshot.hash); await copyProcessingProposal(ctx, proposal);
    await writeProcessingJSON(ctx, `proposals/${b.operationId}/record.json`, proposal, null);
    return saved.hash;
  });
  assert.equal(status.nextAction.command, 'processing-propose');
  const before = await inspectProcessing(a.capability, a.operationId);
  await assert.rejects(proposeProcessing(a.capability, { ...a.args, expectedClaimHash: status.claimHash }),
    { code: 'PROCESSING_PROPOSAL_QUEUE_FULL' });
  assert.deepEqual(await inspectProcessing(a.capability, a.operationId), before);
  await assert.rejects(fs.stat(path.join(f.collection.notes.writerStateDir, 'proposals', a.operationId, 'record.json')), { code: 'ENOENT' });
  // Once the excess operation is explicitly cancelled, the reserved fifth slot
  // resumes normally without refreshing its hash or rebuilding the proposal.
  await completeProcessing(b.capability, { ...b.args, expectedClaimHash: excessClaimHash, outcome: 'cancelled' });
  const resumed = await proposeProcessing(a.capability, { ...a.args, expectedClaimHash: status.claimHash });
  assert.equal(resumed.proposalHash, status.proposalHash);
  assert.equal((await inspectProcessing(a.capability, a.operationId)).state, 'awaiting-review');
});

test('changed settings explicitly stale worksets while preserving budgets and cancellation', async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  const args = { selection: f.selection, worksetId, inputs: f.inputs };
  const workset = await createProcessingWorkset(f.capability, args);
  const batch = await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  const { digest } = await import('./workflow-values.mjs');
  const { verifyWorkflowStorage } = await import('./workflow-storage.mjs');
  f.config.routes[0].id = 'renamed-fixture'; // An otherwise unrelated config edit.
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  f.capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  let status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.policyState, 'changed'); assert.equal(status.conflict, 'WORKFLOW_POLICY_CHANGED');
  assert.equal(status.chargedBatches, 1); assert.equal(status.worksetHash, batch.workset.worksetHash);
  assert.equal((await listProcessingWorksets(f.capability)).worksets[0].policyState, 'changed');
  await assert.rejects(createProcessingWorkset(f.capability, args), error => {
    assert.deepEqual(workflowErrorReport(error), { error: 'WORKFLOW_POLICY_CHANGED', worksetId }); return true;
  });
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: status.worksetHash, indexes: [0] }), /WORKFLOW_POLICY_CHANGED/);
  await completeProcessing(f.capability, { selection: f.selection, operationId: batch.operationId, expectedClaimHash: batch.claimHash, outcome: 'cancelled' });
  status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.chargedBatches, 1); assert.equal(status.outcomeCounts.cancelled, 1);
  assert.equal(status.remainingSelected, 1);
});


for (const inventory of ['workset', 'pending']) test(`${inventory} reports a disappearing listed claim as a retryable inventory change`, async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const directory = path.join(f.collection.notes.writerStateDir, 'claims');
  const file = path.join(directory, `${f.operationId}.json`), opendir = fs.opendir;
  t.mock.method(fs, 'opendir', async (name, ...args) => {
    const dir = await opendir(name, ...args);
    if (name !== directory) return dir;
    return { async *[Symbol.asyncIterator]() {
      for await (const entry of dir) yield entry;
      await fs.unlink(file);
    } };
  });
  await assert.rejects(inventory === 'workset' ? inspectProcessingWorkset(f.capability, { worksetId })
    : pendingProcessing(f.capability, { selection: f.selection }), { code: 'PROCESSING_INVENTORY_CHANGED' });
});

test('workset status reads collection blockers once for multiple operations and preserves both blockers', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f }), worksetId = randomUUID();
  const created = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: [...f.inputs, ...b.inputs] });
  const first = await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: created.worksetHash, indexes: [0] });
  await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: first.workset.worksetHash, indexes: [1], parallelism: 2 });
  const transactions = path.join(f.collection.notes.writerStateDir, 'transactions');
  const { privacyIdentity, protectNewDirectory } = await import('./storage-platform.mjs');
  await fs.mkdir(transactions, { mode: 0o700 }); await protectNewDirectory(transactions, await privacyIdentity());
  await fs.writeFile(path.join(transactions, `${randomUUID()}.json`), '{}', { mode: 0o600 });
  await fs.writeFile(path.join(f.collection.notes.writerStateDir, 'journal.json'), '{}', { mode: 0o600 });
  const opendir = fs.opendir; let scans = 0;
  t.mock.method(fs, 'opendir', async (name, ...args) => { if (name === transactions) scans++; return opendir(name, ...args); });
  const status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(scans, 1); assert.equal(status.operations.length, 2);
  assert.deepEqual(status.blockers, ['PROCESSING_RECOVERY_REQUIRED', 'WRITER_RECOVERY_REQUIRED']);
  for (const operation of status.operations) assert.deepEqual(operation.blockers, ['PROCESSING_RECOVERY_REQUIRED', 'WRITER_RECOVERY_REQUIRED']);
});

test('error diagnostics retain the full workset index range and only native IDs', () => {
  assert.deepEqual(workflowErrorReport({ code: 'PROCESSING_BATCH_BUDGET', details: { inputSizes: [{ index: 99, packetBytes: 100 }] } }).details.inputSizes,
    [{ index: 99, packetBytes: 100 }]);
  for (const value of [null, {}, 'not-an-id', 'ABCDEF00-0000-0000-0000-000000000000']) {
    assert.deepEqual(workflowErrorReport({ code: 'PROCESSING_OPERATION_CONFLICT', operationId: value, worksetId: value }), { error: 'PROCESSING_OPERATION_CONFLICT' });
  }
});


test('present null claim metadata remains corruption, not a disappeared-file race', async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  await fs.writeFile(path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`), 'null');
  await assert.rejects(inspectProcessingWorkset(f.capability, { worksetId }), error => {
    assert.deepEqual(workflowErrorReport(error), { error: 'INVALID_WORKFLOW', operationId: f.operationId }); return true;
  });
});


test('explicit current-policy batches keep charged history and cannot reauthorize old admissions', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f }), c = await processingFixture(t, { base: f });
  const worksetId = randomUUID(), inputs = [...f.inputs, ...b.inputs, ...c.inputs];
  const created = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs });
  const first = await prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: created.worksetHash, indexes: [0] });
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId, expectedWorksetHash: first.workset.worksetHash, indexes: [1], parallelism: 2 },
    { fault: () => { throw new Error('crash'); } }), /crash/);
  const file = path.join(f.collection.notes.writerStateDir, 'processed', 'worksets', worksetId + '.json');
  const old = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const attempt of old.attempts) assert.equal(attempt.policyHash, old.policyHash);
  const oldBytes = await fs.readFile(file);
  const before = await inspectProcessingWorkset(f.capability, { worksetId });
  const { digest } = await import('./workflow-values.mjs');
  const { verifyWorkflowStorage } = await import('./workflow-storage.mjs');
  f.config.routes[0].id = 'current-fixture';
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  f.capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  const call = args => executeWorkflow('processing-workset-prepare', { collectionId: f.collection.id, expectedConfigHash: digest(bytes),
    args: { worksetId, expectedWorksetHash: before.worksetHash, parallelism: 2, ...args } }, { configPath: f.options.configPath });
  for (const indexes of [[0], [1]]) await assert.rejects(call({ indexes, acceptPolicyChange: true }), /WORKFLOW_POLICY_CHANGED/);
  await assert.rejects(call({ indexes: [0, 2], acceptPolicyChange: true }), /WORKSET_INPUT_ALREADY_ATTEMPTED/);
  await assert.rejects(call({ indexes: [2] }), /WORKFLOW_POLICY_CHANGED/);
  await assert.rejects(call({ indexes: [2], acceptPolicyChange: 'true' }), /INVALID_PROCESSING_REQUEST/);
  assert.deepEqual(await fs.readFile(file), oldBytes);
  const next = await call({ indexes: [2], acceptPolicyChange: true });
  assert.equal(next.workset.chargedBatches, 3);
  assert.equal(next.workset.chargedPacketBytes, before.chargedPacketBytes + next.packet.bytes);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(persisted.inputs, inputs); assert.deepEqual(persisted.attempts.slice(0, 2), old.attempts);
  assert.equal(persisted.policyHash, old.policyHash); assert.equal(persisted.attempts[2].policyHash, digest(bytes));
  const retry = await call({ indexes: [2], expectedWorksetHash: next.workset.worksetHash });
  assert.equal(retry.claimHash, next.claimHash); assert.equal(retry.workset.chargedBatches, 3);
  const status = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(status.policyState, 'changed');
  assert.equal(status.operations.find(op => op.operationId === next.operationId).conflict, null);
  assert.equal(status.items[2].state, 'unread');
  assert.equal(status.items[0].conflict, 'WORKFLOW_POLICY_CHANGED');
  assert.equal(status.items[1].conflict, 'WORKFLOW_POLICY_CHANGED');
});


test('worksets without recorded admission policy refuse inspection and retries without mutation', async t => {
  for (const phase of ['admission', 'claim']) await t.test(phase, async t => {
    const f = await processingFixture(t), next = await processingFixture(t, { base: f });
    const worksetId = randomUUID(), inputs = [...f.inputs, ...next.inputs];
    const created = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs });
    const args = { worksetId, expectedWorksetHash: created.worksetHash, indexes: [0] };
    if (phase === 'admission') {
      await assert.rejects(prepareWorksetBatch(f.capability, args,
        { fault: () => { throw new Error('Interrupted admission'); } }), /Interrupted admission/);
    } else await prepareWorksetBatch(f.capability, args);
    const writer = f.collection.notes.writerStateDir;
    const file = path.join(writer, 'processed', 'worksets', worksetId + '.json');
    const original = await fs.readFile(file), stored = JSON.parse(original);
    delete stored.attempts[0].policyHash;
    const unsupported = JSON.stringify(stored);
    await fs.writeFile(file, unsupported);
    const { digest } = await import('./workflow-values.mjs');
    const snapshotClaims = async () => {
      const directory = path.join(writer, 'claims');
      const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      return Promise.all(names.sort().map(async name => [name, await fs.readFile(path.join(directory, name))]));
    };
    const claims = await snapshotClaims();
    const calls = [
      () => inspectProcessingWorkset(f.capability, { worksetId }),
      () => listProcessingWorksets(f.capability),
      () => createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs }),
      ...[[0], [1]].map(indexes => () => prepareWorksetBatch(f.capability,
        { worksetId, expectedWorksetHash: digest(unsupported), indexes, acceptPolicyChange: true, parallelism: 2 })),
    ];
    for (const call of calls) {
      await assert.rejects(call(), { code: 'INVALID_WORKFLOW' });
      assert.equal(await fs.readFile(file, 'utf8'), unsupported);
      assert.deepEqual(await snapshotClaims(), claims);
    }
    await fs.writeFile(file, original);
    const resumed = await prepareWorksetBatch(f.capability, { ...args, expectedWorksetHash: digest(original) });
    assert.equal(resumed.workset.chargedBatches, 1);
  });
});


test('accepting changed policy cannot bypass an excluded source or alter the frozen workset', async t => {
  const f = await processingFixture(t), worksetId = randomUUID();
  const created = await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  f.config.routes[0].excluded = true;
  const { digest } = await import('./workflow-values.mjs');
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const file = path.join(f.collection.notes.writerStateDir, 'processed', 'worksets', worksetId + '.json');
  const before = await fs.readFile(file);
  await assert.rejects(executeWorkflow('processing-workset-prepare', { collectionId: f.collection.id, expectedConfigHash: digest(bytes),
    args: { worksetId, expectedWorksetHash: created.worksetHash, indexes: [0], acceptPolicyChange: true } },
  { configPath: f.options.configPath }), { code: 'WORKFLOW_NOT_AUTHORIZED' });
  assert.deepEqual(await fs.readFile(file), before);
});
