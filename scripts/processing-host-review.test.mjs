import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { processingFixture, proposedClaim } from './test-support/processing-fixture.mjs';
import { readProcessingProposal, inspectProcessing } from './processing.mjs';
import { reviewProcessingProposal } from './processing-host-review.mjs';

test('proposal preview is read-only and exact host Save writes through the existing writer', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f);
  const preview = await readProcessingProposal(f.capability, { ...f.args, expectedClaimHash: p.claimHash, expectedProposalHash: p.proposalHash });
  assert.equal(preview.files[0].original, null); assert.match(preview.files[0].proposed, /Keep the rollout paused/);
  assert.equal(preview.sourceCoverage[0].terminal, 'completed'); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const result = await reviewProcessingProposal(f.capability, f.args, { elicit: async ({ message }) => {
    assert(message.includes(p.proposalHash)); assert(message.includes(preview.files[0].proposed.replaceAll('\n', '\\n')));
    return { action: 'accept', content: { decision: 'save' } };
  } });
  assert.equal(result.status, 'saved'); assert.equal(await fs.readFile(p.target, 'utf8'), preview.files[0].proposed);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
});

test('closed forms, Later and unsupported host leave exact proposal pending', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f);
  for (const answer of [{ action: 'cancel' }, { action: 'decline' }, { action: 'accept', content: { decision: 'later' } }]) {
    const result = await reviewProcessingProposal(f.capability, f.args, { elicit: async () => answer });
    assert.equal(result.status, 'awaiting-review'); assert.equal(result.proposalHash, p.proposalHash);
  }
  await assert.rejects(reviewProcessingProposal(f.capability, f.args, {}), { code: 'PROCESSING_REVIEW_UNSUPPORTED' });
  const current = await inspectProcessing(f.capability, f.operationId);
  assert.equal(current.claimHash, p.claimHash); assert.equal(current.state, 'awaiting-review');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('cancellation before or just after elicitation preserves the exact pending proposal', async t => {
  for (const decision of ['save', 'skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), abort = new AbortController();
    const cancelled = Object.assign(new Error('Cancelled synthetic review'), { code: 'PROCESSING_CONTROL_CANCELLED' });
    let forms = 0, commits = 0;
    const options = { signal: abort.signal, commitResponse: () => { commits++; }, elicit: async () => {
      forms++; abort.abort(cancelled); return { action: 'accept', content: { decision } };
    } };
    await assert.rejects(reviewProcessingProposal(f.capability, f.args, options), cancelled);
    await assert.rejects(reviewProcessingProposal(f.capability, f.args, options), cancelled);
    assert.equal(forms, 1); assert.equal(commits, 0);
    const current = await inspectProcessing(f.capability, f.operationId);
    assert.equal(current.state, 'awaiting-review'); assert.equal(current.claimHash, p.claimHash);
    assert.equal(current.proposalHash, p.proposalHash); assert.equal(current.recoveryRequired, false);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

test('human edits during the host wait keep conflict protection and do not refresh approval', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f, { name: 'rollout.md' });
  await assert.rejects(reviewProcessingProposal(f.capability, f.args, { elicit: async () => {
    await fs.writeFile(p.target, '# Human edit\n');
    return { action: 'accept', content: { decision: 'save' } };
  } }), error => /output changed since inspection/.test(error.message));
  assert.equal(await fs.readFile(p.target, 'utf8'), '# Human edit\n');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, null);
});

test('host Skip and Cancel use distinct authoritative dispositions; model-shaped decisions fail', async t => {
  for (const [decision, outcome] of [['skip', 'skipped'], ['cancel', 'cancelled']]) await t.test(decision, async t => {
    const f = await processingFixture(t); await proposedClaim(f);
    for (const response of [{ decision }, { action: 'accept', content: { decision, correction: 'new source' } },
      { action: 'accept', content: { decision: 'save' }, approved: true }]) {
      await assert.rejects(reviewProcessingProposal(f.capability, f.args, { elicit: async () => response }));
    }
    const result = await reviewProcessingProposal(f.capability, f.args, { elicit: async () => ({ action: 'accept', content: { decision } }) });
    assert.equal(result.status, outcome); assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, outcome);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});
