import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, proposedClaim } from './test-support/processing-fixture.mjs';
import { saveProcessing, completeProcessing, inspectProcessing, recoverProcessing, prepareProcessing } from './processing.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { fingerprint } from './safe-update.mjs';
import { digest } from './workflow-values.mjs';
import { executeWorkflow } from './workflow.mjs';

const save = (f, p, options) => saveProcessing(f.capability, { ...f.args, expectedClaimHash: p.claimHash, approvedProposalHash: p.proposalHash }, options);
const cancel = (f, p, expectedRecoveryHash, options) => completeProcessing(f.capability,
  { ...f.args, expectedClaimHash: p.claimHash, outcome: 'cancelled', ...(expectedRecoveryHash === undefined ? {} : { expectedRecoveryHash }) }, options);
async function interrupted(f, p, phase = 'write-intent') {
  await assert.rejects(save(f, p, { fault: at => { if (at === phase) throw new Error('crash'); } }), /crash/);
  return (await inspectProcessing(f.capability, f.operationId)).recoveryHash;
}
const resume = async f => recoverProcessing(f.capability, { operationId: f.operationId,
  expectedRecoveryHash: (await inspectProcessing(f.capability, f.operationId)).recoveryHash });

test('stale existing and newly appeared outputs reject before writer reservation and remain cancellable', async t => {
  for (const existing of [false, true]) {
    const f = await processingFixture(t), target = path.join(f.collection.notes.notesDir, 'selected.md');
    if (existing) await fs.writeFile(target, '# Original\n');
    const p = await proposedClaim(f, { name: 'selected.md' });
    await fs.writeFile(target, '# Human edit\n');
    await assert.rejects(save(f, p), /output changed/);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).pendingTransaction, false);
    await assert.rejects(cancel(f, p, '0'.repeat(64)), /RECOVERY_CHANGED/);
    assert.equal((await cancel(f, p)).status, 'cancelled');
    assert.equal(await fs.readFile(target, 'utf8'), '# Human edit\n');
    assert((await prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs })).claimHash);
  }
});

test('a raced pre-journal transaction cancels by inspected hash after policy and evidence changes', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f, { name: 'selected.md' });
  await assert.rejects(save(f, p, { fault: async at => {
    if (at === 'write-intent') await fs.writeFile(p.target, '# Later human edit\n');
  } }), /output changed/);
  const txHash = (await inspectProcessing(f.capability, f.operationId)).recoveryHash;
  await assert.rejects(cancel(f, p), /RECOVERY_REQUIRED/);
  await assert.rejects(cancel(f, p, '0'.repeat(64)), /RECOVERY_CHANGED/);
  for (const outcome of ['skipped', 'unchanged']) await assert.rejects(completeProcessing(f.capability,
    { ...f.args, expectedClaimHash: p.claimHash, expectedRecoveryHash: txHash, outcome }), /INVALID_PROCESSING_REQUEST/);
  await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: '0'.repeat(64),
    expectedRecoveryHash: txHash, outcome: 'cancelled' }), /CLAIM_CHANGED/);
  f.config.routes[0].excluded = true;
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  f.capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  await fs.unlink(p.plan.files[0].sources[0].path);
  await assert.rejects(resume(f), /POLICY_CHANGED/);
  assert.equal((await cancel(f, p, txHash)).status, 'cancelled');
  assert.equal(await fs.readFile(p.target, 'utf8'), '# Later human edit\n');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).pendingTransaction, false);
});

for (const phase of ['operation-receipt', 'proposal-cleanup', 'claim-release', 'transaction-cleanup']) {
  test(`cancellation resumes safely after ${phase}`, async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), txHash = await interrupted(f, p);
    await assert.rejects(cancel(f, p, txHash, { fault: at => { if (at === phase) throw new Error('cancel crash'); } }), /cancel crash/);
    assert.equal((await resume(f)).status, 'cancelled');
    assert.equal(await fingerprint(p.target), null);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).pendingTransaction, false);
    assert((await prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs })).claimHash);
  });
}

test('cancellation retains transactions with staged, replaced or receipted writes', async t => {
  for (const phase of ['afterStage', 'afterReplace', 'afterReceipt', 'afterJournalRemoval']) {
    const f = await processingFixture(t), p = await proposedClaim(f), txHash = await interrupted(f, p, phase);
    const before = await fingerprint(p.target);
    await assert.rejects(cancel(f, p, txHash), /RECOVERY_REQUIRED/);
    assert.equal(await fingerprint(p.target), before);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).pendingTransaction, true);
    assert.equal((await resume(f)).status, 'saved');
  }
});

test('cancellation refuses incomplete receipts and foreign transactions', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f), txHash = await interrupted(f, p);
  const receipt = path.join(f.collection.notes.writerStateDir, 'processed/writes', f.operationId);
  await fs.mkdir(receipt, { recursive: true, mode: 0o700 });
  await assert.rejects(cancel(f, p, txHash), /WRITER_RECEIPT_INCOMPLETE/);
  await fs.rmdir(receipt);
  const foreign = path.join(f.collection.notes.writerStateDir, 'transactions', randomUUID() + '.json');
  await fs.writeFile(foreign, '{}', { mode: 0o600 });
  await assert.rejects(cancel(f, p, txHash), /RECOVERY_REQUIRED/);
  assert.equal(await fs.readFile(foreign, 'utf8'), '{}');
});

test('cancellation replay does not adopt a changed transaction', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f), txHash = await interrupted(f, p);
  await assert.rejects(cancel(f, p, txHash, { fault: at => { if (at === 'operation-receipt') throw new Error('crash'); } }), /crash/);
  const txPath = path.join(f.collection.notes.writerStateDir, 'transactions', f.operationId + '.json');
  await fs.appendFile(txPath, '\n');
  const changed = await fs.readFile(txPath);
  await assert.rejects(resume(f), /RECOVERY_CHANGED/);
  assert.equal(await fingerprint(p.target), null);
  assert.deepEqual(await fs.readFile(txPath), changed);
});

test('CLI can cancel an inspected unapplied transaction but never a no-op save receipt', async t => {
  const f = await processingFixture(t), content = '# Existing\n\n## Decision\n\nKeep it.\n';
  const p = await proposedClaim(f, { name: 'selected.md', content }), txHash = await interrupted(f, p);
  const done = await executeWorkflow('processing-complete', { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash,
    args: { ...f.args, expectedClaimHash: p.claimHash, expectedRecoveryHash: txHash, outcome: 'cancelled' } }, { configPath: f.options.configPath });
  assert.equal(done.status, 'cancelled');
  f.operationId = randomUUID(); f.args = { ...f.args, operationId: f.operationId };
  await fs.writeFile(p.target, content);
  const noOp = await proposedClaim(f, { name: 'selected.md', content }), receiptTx = await interrupted(f, noOp, 'afterReceipt');
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'journal.json')), null);
  await assert.rejects(cancel(f, noOp, receiptTx), /RECOVERY_REQUIRED/);
  assert.equal((await resume(f)).status, 'saved');
});

test('an output edited during receipt staging is preserved and receives no save receipt', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f);
  let changed = false;
  const open = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (typeof file === 'string' && file.includes(`${path.sep}.write-`) && file.endsWith('record.json')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); await fs.writeFile(p.target, '# Concurrent edit\n'); changed = true; };
    }
    return handle;
  };
  try { await assert.rejects(save(f, p), /Output changed before/); }
  finally { fs.open = open; }
  assert(changed);
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'processed/writes', f.operationId, 'record.json')), null);
  assert.equal(await fs.readFile(p.target, 'utf8'), '# Concurrent edit\n');
  assert.equal((await fs.readdir(path.join(f.collection.notes.writerStateDir, 'processed/writes'))).some(name => name.startsWith('.write-')), false);
});

test('cancelled-operation recovery still refuses a new journal or incomplete receipt', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f), txHash = await interrupted(f, p);
  await assert.rejects(cancel(f, p, txHash, { fault: at => { if (at === 'transaction-cleanup') throw new Error('crash'); } }), /crash/);
  const journal = path.join(f.collection.notes.writerStateDir, 'journal.json');
  await fs.writeFile(journal, '{}', { mode: 0o600 });
  await assert.rejects(resume(f), /RECOVERY_REQUIRED/);
  assert.equal(await fs.readFile(journal, 'utf8'), '{}'); await fs.unlink(journal);
  const receipt = path.join(f.collection.notes.writerStateDir, 'processed/writes', f.operationId);
  await fs.mkdir(receipt, { recursive: true, mode: 0o700 });
  await assert.rejects(resume(f), /WRITER_RECEIPT_INCOMPLETE/);
  await fs.rmdir(receipt);
  assert.equal((await resume(f)).status, 'cancelled');
  assert.equal(await fingerprint(p.target), null);
});

test('regular and no-op receipts hash outputs once at final publication', async t => {
  for (const noOp of [false, true]) {
    const f = await processingFixture(t), content = '# Saved note\n\n## Decision\n\nKeep it.\n';
    const target = path.join(f.collection.notes.notesDir, 'selected.md');
    if (noOp) await fs.writeFile(target, content);
    const p = await proposedClaim(f, { name: 'selected.md', content });
    let final = false, reads = 0; const open = fs.open;
    fs.open = async (file, ...args) => { if (final && file === target) reads++; return open(file, ...args); };
    try {
      assert.equal((await save(f, p, { fault: at => {
        if (at === 'afterVerification') final = true;
        if (at === 'afterReceipt') final = false;
      } })).status, 'saved');
    } finally { fs.open = open; }
    assert.equal(reads, 1);
  }
});
