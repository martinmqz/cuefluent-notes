import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceProcessingStorage, processingFixture, proposedClaim } from './test-support/processing-fixture.mjs';
import { verifyWorkflowStorage, workflowProcessingBinding } from './workflow-storage.mjs';
import { prepareProcessing, readProcessingPage, inspectProcessing, saveProcessing, completeProcessing, recoverProcessing } from './processing.mjs';
import { dispositionPath } from './capture-retention.mjs';
import { pendingProcessing } from './processing-inventory.mjs';
import { pendingCollectionProcessing } from './processing-collection.mjs';
import { createProcessingWorkset, inspectProcessingWorkset } from './processing-workset.mjs';
import { selectProcessingShortcut, inspectProcessingShortcut } from './processing-shortcuts.mjs';
import { processingControlStatusView } from './processing-control-server.mjs';
import { processingStatusView } from './processing-mcp.mjs';
import { executeWorkflow } from './workflow.mjs';
import { fingerprint } from './safe-update.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';

// Real directory replacement changes physical identity on every platform. No
// test substitutes a weaker identity function or treats equal bytes as continuity.
async function replaceRoot(f, kind = 'intake') {
  const root = { intake: f.collection.intakeStateDir, raw: f.collection.rawDir, writer: f.collection.notes.writerStateDir }[kind];
  await replaceProcessingStorage(root);
  f.capability = await verifyWorkflowStorage(f.options);
}

for (const kind of ['intake', 'raw', 'writer']) test(`changed ${kind} storage keeps the old proposal reserved and visible to both inventory scopes`, async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  const claimPath = path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`);
  const original = await fs.readFile(claimPath);
  await replaceRoot(f, kind);
  for (const inspect of [
    () => inspectProcessing(f.capability, f.operationId),
    async () => (await pendingProcessing(f.capability, { selection: f.selection })).operations[0],
    async () => (await pendingCollectionProcessing(f.capability, { selection: f.selection })).operations[0],
  ]) {
    const status = await inspect();
    assert.equal(status.state, 'conflicted');
    assert.equal(status.conflict, 'PROCESSING_BINDING_CHANGED');
    assert.equal(status.operationId, f.operationId);
    assert.equal(status.claimHash, proposal.claimHash);
    assert.equal(status.proposalHash, proposal.proposalHash);
  }
  const inventory = await pendingProcessing(f.capability, { selection: f.selection });
  assert.equal(inventory.counts.unclaimedRevisions, 0);
  assert.equal(inventory.pending[0].status, 'blocked-by-claim');
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs }),
    { code: 'PROCESSING_BINDING_CHANGED', operationId: f.operationId });
  await assert.rejects(saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash,
    approvedProposalHash: proposal.proposalHash }), { code: 'PROCESSING_BINDING_CHANGED' });
  assert.deepEqual(await fs.readFile(claimPath), original);
  assert.equal(await fs.readFile(proposal.plan.files[0].contentPath, 'utf8'), await fs.readFile(proposal.contentPath, 'utf8'));
  assert.deepEqual(await fs.readdir(path.dirname(claimPath)), [`${f.operationId}.json`]);
  await assert.rejects(fs.stat(proposal.target), { code: 'ENOENT' });
});

test('a changed binding cannot hide an unfinished inspection claim from new admission', async t => {
  const f = await processingFixture(t);
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  await replaceRoot(f);
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs }),
    { code: 'PROCESSING_BINDING_CHANGED', operationId: f.operationId });
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
});

test('a different collection placement in shared writer storage is not adopted or made a local claim', async t => {
  const f = await processingFixture(t);
  await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const file = path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`);
  const foreign = JSON.parse(await fs.readFile(file, 'utf8'));
  foreign.binding.collectionId = 'another-collection';
  foreign.bindingHash = digest(canonicalJSON(foreign.binding));
  await fs.writeFile(file, canonicalJSON(foreign) + '\n');
  const before = await fs.readFile(file);
  const pending = await pendingProcessing(f.capability, { selection: f.selection });
  assert.equal(pending.operations.length, 0);
  assert.equal(pending.pending[0].status, 'pending');
  await assert.rejects(inspectProcessing(f.capability, f.operationId), { code: 'PROCESSING_BINDING_CHANGED' });
  await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: digest(before), outcome: 'cancelled' }),
    { code: 'PROCESSING_BINDING_CHANGED' });
  const next = await prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs });
  assert(next.claimHash);
  assert.deepEqual(await fs.readFile(file), before);
});

for (const kind of ['intake', 'raw', 'writer']) for (const delivered of [false, true]) {
  test(`changed ${kind} storage permits exact cancellation of ${delivered ? 'a partially read' : 'an unread'} claim`, async t => {
    const f = await processingFixture(t), settings = await fs.readFile(f.options.configPath);
    let claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
    if (delivered) claim = await readProcessingPage(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, page: 0 });
    const original = JSON.parse(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`)));
    await replaceRoot(f, kind);
    const before = await inspectProcessing(f.capability, f.operationId);
    assert.equal(before.nextAction.command, 'processing-complete'); assert.equal(before.nextAction.outcome, 'cancelled');
    await assert.rejects(completeProcessing(f.capability, { ...f.args, outcome: 'cancelled' }), { code: 'INVALID_WORKFLOW' });
    await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: digest('wrong'), outcome: 'cancelled' }),
      { code: 'PROCESSING_CLAIM_CHANGED' });
    await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' }),
      { code: 'PROCESSING_BINDING_CHANGED' });
    await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' },
      { fault: at => { if (at === 'operation-receipt') throw new Error('interrupted'); } }), /interrupted/);
    const interrupted = await inspectProcessing(f.capability, f.operationId);
    assert.equal(interrupted.state, 'completed'); assert.equal(interrupted.recoveryRequired, true);
    await recoverProcessing(f.capability, { operationId: f.operationId, expectedRecoveryHash: interrupted.recoveryHash });
    const done = await inspectProcessing(f.capability, f.operationId);
    assert.equal(done.state, 'completed'); assert.equal(done.outcome, 'cancelled');
    assert.equal(done.conflict, null); assert.equal(done.nextAction, null);
    const binding = await workflowProcessingBinding(f.capability);
    for (const bindingHash of [original.bindingHash, binding.hash]) {
      await assert.rejects(fs.stat(path.join(f.collection.notes.writerStateDir,
        dispositionPath(f.identity, f.inputs[0].headHash, bindingHash))), { code: 'ENOENT' });
    }
    await prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs });
    assert.deepEqual(await fs.readFile(f.options.configPath), settings);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const outcome of ['skipped', 'unchanged']) for (const kind of ['intake', 'raw', 'writer']) {
  for (const phase of ['operation-receipt', 'disposition']) test(`recover ${outcome} after ${phase} and changed ${kind} storage`, async t => {
    const f = await processingFixture(t), proposal = await proposedClaim(f);
    const writer = f.collection.notes.writerStateDir, settings = await fs.readFile(f.options.configPath);
    const original = JSON.parse(await fs.readFile(path.join(writer, 'claims', `${f.operationId}.json`)));
    await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash, outcome },
      { fault: at => { if (at === phase) throw new Error('interrupted'); } }), /interrupted/);
    const recordPath = path.join(writer, 'processed', 'operations', `${f.operationId}.json`);
    const record = await fs.readFile(recordPath), recoveryHash = digest(record);
    await replaceRoot(f, kind);
    const binding = await workflowProcessingBinding(f.capability);
    const oldDisposition = path.join(writer, dispositionPath(f.identity, f.inputs[0].headHash, original.bindingHash));
    const currentDisposition = path.join(writer, dispositionPath(f.identity, f.inputs[0].headHash, binding.hash));
    const partialHash = await fingerprint(oldDisposition);
    assert.equal(partialHash !== null, phase === 'disposition');
    const status = await inspectProcessing(f.capability, f.operationId);
    assert.equal(status.conflict, 'PROCESSING_BINDING_CHANGED');
    assert.equal(status.recoveryRequired, true);
    await assert.rejects(recoverProcessing(f.capability, { operationId: f.operationId, expectedRecoveryHash: digest('wrong') }),
      { code: 'PROCESSING_RECOVERY_CHANGED' });
    const request = { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash,
      args: { operationId: f.operationId, expectedRecoveryHash: recoveryHash } };
    const recovered = await executeWorkflow('processing-recover', request, { configPath: f.options.configPath });
    assert.equal(recovered.status, outcome); assert.equal(recovered.receiptHash, recoveryHash);
    assert.deepEqual(status.nextAction, { command: 'processing-recover' });
    const disposition = JSON.parse(await fs.readFile(oldDisposition));
    assert.equal(disposition.bindingHash, original.bindingHash); assert.equal(disposition.outcome, outcome);
    if (partialHash) assert.equal(await fingerprint(oldDisposition), partialHash);
    const completionPath = path.join(writer, 'processed', 'completions', `${f.operationId}.json`);
    const completion = await fs.readFile(completionPath);
    assert.equal(JSON.parse(completion).bindingHash, original.bindingHash);
    assert.deepEqual(await executeWorkflow('processing-recover', request, { configPath: f.options.configPath }), recovered);
    assert.deepEqual(await fs.readFile(completionPath), completion);
    assert.deepEqual(await fs.readFile(recordPath), record);
    await assert.rejects(fs.stat(currentDisposition), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(writer, 'claims', `${f.operationId}.json`)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(writer, 'proposals', f.operationId)), { code: 'ENOENT' });
    const done = await inspectProcessing(f.capability, f.operationId);
    assert.equal(done.conflict, null); assert.equal(done.nextAction, null);
    await prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs });
    assert.deepEqual(await fs.readFile(f.options.configPath), settings);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

test('a recorded saved outcome still refuses recovery after storage identity changes', async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  await assert.rejects(saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash,
    approvedProposalHash: proposal.proposalHash },
    { fault: at => { if (at === 'operation-receipt') throw new Error('interrupted'); } }), /interrupted/);
  await replaceRoot(f, 'writer');
  const status = await inspectProcessing(f.capability, f.operationId);
  assert.deepEqual(status.nextAction, { command: null, reason: 'resolve-conflict' });
  const files = [`processed/operations/${f.operationId}.json`, `transactions/${f.operationId}.json`,
    `processed/writes/${f.operationId}/record.json`, `claims/${f.operationId}.json`]
    .map(name => path.join(f.collection.notes.writerStateDir, name));
  files.push(proposal.target, f.options.configPath);
  const before = await Promise.all(files.map(file => fingerprint(file)));
  await assert.rejects(recoverProcessing(f.capability, { operationId: f.operationId, expectedRecoveryHash: status.recoveryHash }),
    { code: 'PROCESSING_OPERATION_CHANGED' });
  assert.deepEqual(await Promise.all(files.map(file => fingerprint(file))), before);
});

for (const phase of ['afterStage', 'afterJournalRemoval']) test(`changed binding after ${phase} offers no cancellation or recovery command`, async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  await assert.rejects(saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash,
    approvedProposalHash: proposal.proposalHash }, { fault: at => { if (at === phase) throw new Error('interrupted'); } }), /interrupted/);
  await replaceRoot(f, 'writer');
  const files = ['journal.json', `processed/writes/${f.operationId}/record.json`,
    `claims/${f.operationId}.json`, `transactions/${f.operationId}.json`].map(name => path.join(f.collection.notes.writerStateDir, name));
  files.push(proposal.target);
  const before = await Promise.all(files.map(file => fingerprint(file)));
  assert.equal(before[0] !== null, phase === 'afterStage');
  assert.equal(before[1] !== null, phase === 'afterJournalRemoval');
  const direct = await inspectProcessing(f.capability, f.operationId);
  const cli = await executeWorkflow('processing-status', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { operationId: f.operationId } }, { configPath: f.options.configPath });
  const session = await pendingProcessing(f.capability, { selection: f.selection });
  const collection = await pendingCollectionProcessing(f.capability, { selection: f.selection });
  for (const status of [direct, cli, session.operations[0], collection.operations[0]]) {
    assert.equal(status.state, 'conflicted'); assert.equal(status.conflict, 'PROCESSING_BINDING_CHANGED');
    assert.equal(status.pendingTransaction, true); assert.equal(status.recoveryRequired, true);
    assert.deepEqual(status.nextAction, { command: null, reason: 'resolve-conflict' });
  }
  await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash,
    expectedRecoveryHash: direct.recoveryHash, outcome: 'cancelled' }), { code: 'PROCESSING_RECOVERY_REQUIRED' });
  await assert.rejects(recoverProcessing(f.capability, { operationId: f.operationId,
    expectedRecoveryHash: direct.recoveryHash }), { code: 'PROCESSING_TRANSACTION_CHANGED' });
  assert.deepEqual(await Promise.all(files.map(file => fingerprint(file))), before);
});

for (const phase of ['write-intent', 'operation-receipt']) test(`changed binding keeps ${phase} visible as conflict without an unsafe recovery hint`, async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  const fault = at => { if (at === phase) throw new Error('interrupted'); };
  if (phase === 'write-intent') await assert.rejects(saveProcessing(f.capability, { ...f.args,
    expectedClaimHash: proposal.claimHash, approvedProposalHash: proposal.proposalHash }, { fault }), /interrupted/);
  else await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash,
    outcome: 'cancelled' }, { fault }), /interrupted/);
  await replaceRoot(f, 'writer');
  const session = await pendingProcessing(f.capability, { selection: f.selection });
  const collection = await pendingCollectionProcessing(f.capability, { selection: f.selection });
  for (const status of [await inspectProcessing(f.capability, f.operationId), session.operations[0], collection.operations[0]]) {
    assert.equal(status.state, phase === 'write-intent' ? 'conflicted' : 'completed');
    assert.equal(status.conflict, 'PROCESSING_BINDING_CHANGED');
    assert.equal(status.nextAction.command, phase === 'write-intent' ? 'processing-complete' : 'processing-recover');
    assert(status.recoveryHash);
    assert.equal(status.pendingTransaction, phase === 'write-intent');
  }
  if (phase === 'write-intent') assert.equal(session.transactions[0].operationId, f.operationId);
  const current = await inspectProcessing(f.capability, f.operationId);
  if (phase === 'write-intent') await completeProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash,
    expectedRecoveryHash: current.recoveryHash, outcome: 'cancelled' });
  else await recoverProcessing(f.capability, { operationId: f.operationId, expectedRecoveryHash: current.recoveryHash });
  const done = await inspectProcessing(f.capability, f.operationId);
  assert.equal(done.state, 'completed'); assert.equal(done.conflict, null); assert.equal(done.nextAction, null);
  await assert.rejects(fs.stat(proposal.target), { code: 'ENOENT' });
});

test('binding conflict blocks collection admission and frozen status without creating a shortcut checkpoint', async t => {
  const f = await processingFixture(t), other = await processingFixture(t, { base: f });
  await proposedClaim(f);
  await replaceRoot(f);
  for (const inventory of [await pendingProcessing(f.capability, { selection: other.selection }),
    await pendingCollectionProcessing(f.capability, { selection: other.selection })]) {
    assert(inventory.blockers.includes('PROCESSING_BINDING_CHANGED'));
  }
  const workset = await createProcessingWorkset(f.capability, { selection: f.selection,
    worksetId: randomUUID(), inputs: [...f.inputs, ...other.inputs] });
  const status = await inspectProcessingWorkset(f.capability, { worksetId: workset.worksetId });
  assert(status.items.every(item => item.state === 'blocked' && item.conflict === 'PROCESSING_BINDING_CHANGED'));
  const chosen = await selectProcessingShortcut(f.capability, { selection: other.selection, requestId: randomUUID() },
    { canResumeOperation: async () => true });
  assert(chosen.blockers.includes('PROCESSING_BINDING_CHANGED'));
  assert.equal(chosen.nextRun, null); assert.equal(chosen.checkpointHash, null);
  assert.equal((await inspectProcessingShortcut(f.capability, { selection: other.selection })).phase, 'missing');
  const view = processingControlStatusView(processingStatusView({ state: 'missing', requestId: null },
    await inspectProcessingShortcut(f.capability, { selection: other.selection }),
    { inventory: await pendingCollectionProcessing(f.capability, { selection: other.selection }) }), { collectionId: f.collection.id });
  assert.deepEqual(view.diagnostics, ['PROCESSING_BINDING_CHANGED']);
  assert.equal(view.nextAction, 'inspect'); assert.equal(view.status, 'blocked');

  // A previously interrupted shortcut can already contain a frozen uncovered
  // remainder. Its status must remain readable, not only new discovery.
  const binding = await workflowProcessingBinding(f.capability);
  const directory = path.join(f.collection.notes.writerStateDir, 'processed', 'shortcuts');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, `${binding.hash}.json`), canonicalJSON({
    format: 'cuefluent-processing-shortcut', version: 1, id: randomUUID(), bindingHash: binding.hash,
    policyHash: f.options.expectedConfigHash, selection: other.selection, scope: { kind: 'collection' }, phase: 'ready',
    inputs: other.inputs, operationIds: [f.operationId], worksetIds: [], after: null, incomplete: false,
  }) + '\n', { mode: 0o600 });
  const frozen = await inspectProcessingShortcut(f.capability, { selection: other.selection });
  assert.equal(frozen.nextRun, null); assert.equal(frozen.counts.unattempted, 0);
  assert(frozen.blockers.includes('PROCESSING_BINDING_CHANGED'));
});
