import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { withLock, applyPlan, recover, abortUpdate, finalizeRecordedWriter, fingerprint } from './safe-update.mjs';
import { readWriterReceipt } from './writer-protocol.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';

async function fixture(t) {
  const f = await storageFixture(t, { fullSetup: false }), root = f.collection.notes.notesDir, stateDir = f.collection.notes.writerStateDir;
  await fs.mkdir(root); const contentPath = path.join(f.root, 'proposal.md');
  await fs.writeFile(contentPath, '# Decision\n\n## Result\n\nKeep the synthetic result.\n');
  const operationId = randomUUID(), plan = { version: 1, mode: 'authored', root, stateDir,
    files: [{ path: 'decision.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) }] };
  const binding = { operationId, proposalHash: 'a'.repeat(64), inputsHash: 'b'.repeat(64), collectionHash: 'c'.repeat(64), root, stateDir };
  const transaction = { writerBinding: binding, plan, planHash: digest(canonicalJSON(plan)) };
  const bytes = canonicalJSON(transaction) + '\n';
  await fs.mkdir(path.join(stateDir, 'transactions'), { mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'transactions', operationId + '.json'), bytes, { mode: 0o600 });
  const coordination = { binding, transactionHash: digest(bytes) };
  const owned = (run, options = {}) => withLock(stateDir, writerGuard => run({ ...options, writerGuard, coordination }));
  return { ...f, root, stateDir, contentPath, target: path.join(root, 'decision.md'), operationId, plan, coordination, owned };
}

test('coordinated writes reject public, forged, expired and wrong-directory capabilities', async t => {
  const f = await fixture(t);
  await assert.rejects(applyPlan(f.plan), /PROCESSING_RECOVERY_REQUIRED/);
  await assert.rejects(recover(f.stateDir), /PROCESSING_RECOVERY_REQUIRED/);
  await assert.rejects(abortUpdate({ version: 1, stateDir: f.stateDir, expectedJournalHash: 'a'.repeat(64), expectedManifestHash: null }), /PROCESSING_RECOVERY_REQUIRED/);
  await assert.rejects(applyPlan(f.plan, { writerGuard: async () => {}, coordination: f.coordination }), /capability/);
  let expired; await withLock(f.stateDir, guard => { expired = guard; });
  await assert.rejects(applyPlan(f.plan, { writerGuard: expired, coordination: f.coordination }), /capability/);
  const other = path.join(f.root, 'other-state'); await fs.mkdir(other);
  await withLock(other, async writerGuard => assert.rejects(applyPlan(f.plan, { writerGuard, coordination: f.coordination }), /capability/));
  assert.equal(await fingerprint(f.target), null);
});

test('the actual writer-read proposal bytes must match the immutable approved plan', async t => {
  const f = await fixture(t); await fs.appendFile(f.contentPath, '\nUnapproved change.\n');
  await assert.rejects(f.owned(options => applyPlan(f.plan, options)), /proposal content changed/);
  assert.equal(await fingerprint(f.target), null);
  await assert.rejects(f.owned(async options => applyPlan({ ...f.plan, files: [{ ...f.plan.files[0], expectedContentHash: await fingerprint(f.contentPath) }] }, options)), /plan changed/);
});

for (const phase of ['afterStage', 'afterReplace', 'afterVerification', 'afterReceipt', 'afterJournalRemoval']) {
  test(`coordinated recovery retains exact output proof after ${phase}`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.owned(options => applyPlan(f.plan, options), { [phase]: async () => { throw new Error('crash'); } }), /crash/);
    const receipt = await readWriterReceipt(f.stateDir, f.operationId);
    if (['afterReceipt', 'afterJournalRemoval'].includes(phase)) {
      assert(receipt); await fs.appendFile(f.target, '\nLater human edit.\n');
      await f.owned(options => finalizeRecordedWriter(f.stateDir, receipt.hash, options));
      assert.match(await fs.readFile(f.target, 'utf8'), /Later human edit/);
    } else {
      assert.equal(receipt, null);
      await f.owned(options => recover(f.stateDir, options));
      assert(await readWriterReceipt(f.stateDir, f.operationId));
    }
    assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
    await assert.rejects(applyPlan(f.plan), /PROCESSING_RECOVERY_REQUIRED/); // envelope still owns finalization
  });
}

test('a human edit before receipt publication preserves the unresolved journal', async t => {
  const f = await fixture(t);
  await assert.rejects(f.owned(options => applyPlan(f.plan, options), { afterVerification: () => fs.appendFile(f.target, '\nHuman change.\n') }), /Output changed/);
  assert.equal(await readWriterReceipt(f.stateDir, f.operationId), null);
  await assert.rejects(f.owned(options => recover(f.stateDir, options)), /conflict|changed/);
  assert.match(await fs.readFile(f.target, 'utf8'), /Human change/);
});
