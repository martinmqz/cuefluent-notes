import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { processingFixture, proposedClaim } from './test-support/processing-fixture.mjs';
import { readProcessingProposal, inspectProcessing } from './processing.mjs';
import { reviewProcessingProposal } from './processing-host-review.mjs';

test('proposal preview is read-only and exact host Save writes through the existing writer', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f);
  const preview = await readProcessingProposal(f.capability, { ...f.args, expectedClaimHash: p.claimHash, expectedProposalHash: p.proposalHash });
  assert.equal(preview.files[0].original, null); assert.match(preview.files[0].proposed, /Keep the rollout paused/);
  assert.equal(preview.sourceCoverage[0].terminal, 'completed'); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const result = await reviewProcessingProposal(f.capability, f.args, { elicit: async ({ message }) => {
    assert(message.includes(p.proposalHash)); assert(message.includes('│ Keep the rollout paused.'));
    assert(message.includes('CREATE "meetings/rollout.md"')); assert(message.includes('Folders to create:\n- "meetings"'));
    assert(!message.includes('CURRENT MARKDOWN')); assert(!message.includes('expectedContentHash'));
    return { action: 'accept', content: { decision: 'save' }, preview: 'intact' };
  } });
  assert.equal(result.status, 'saved'); assert.equal(result.review, 'saved'); assert.equal(await fs.readFile(p.target, 'utf8'), preview.files[0].proposed);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
});

test('closed forms, Later and unsupported host leave exact proposal pending with a distinct review outcome', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f);
  for (const [answer, review] of [[{ action: 'cancel' }, 'declined'], [{ action: 'decline' }, 'declined'],
    [{ action: 'accept', content: { decision: 'later' }, preview: 'intact' }, 'deferred']]) {
    const result = await reviewProcessingProposal(f.capability, f.args, { elicit: async () => answer });
    assert.equal(result.status, 'awaiting-review'); assert.equal(result.proposalHash, p.proposalHash);
    assert.equal(result.review, review);
  }
  await assert.rejects(reviewProcessingProposal(f.capability, f.args, {}), { code: 'PROCESSING_REVIEW_UNSUPPORTED' });
  const current = await inspectProcessing(f.capability, f.operationId);
  assert.equal(current.claimHash, p.claimHash); assert.equal(current.state, 'awaiting-review');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('review shows complete originals, proposals and source limitations while saving original line endings', async t => {
  const f = await processingFixture(t, { terminal: 'interrupted', omissions: [
    { reason: 'tool-output-limit', recordId: 'tool-result', bytes: 8100, count: 1 },
    { reason: 'image-unavailable', recordId: 'screenshot', mimeType: 'image/png', caption: 'Synthetic diagram' }
  ] });
  const original = '# Existing decision\r\n\r\n## Policy\r\n\r\nOld café policy.\r\n';
  const content = '# Updated decision\r\n\r\n## Policy\r\n\r\nNew café policy.\r\n';
  await fs.writeFile(path.join(f.collection.notes.notesDir, 'decision.md'), original);
  const p = await proposedClaim(f, { name: 'decision.md', content });
  await reviewProcessingProposal(f.capability, f.args, { elicit: async ({ message }) => {
    assert(message.includes('UPDATE "decision.md"'));
    assert(message.includes('│ Old café policy.')); assert(message.includes('│ New café policy.'));
    assert(message.includes('Current line endings — CRLF: 5, LF: 0, CR: 0; final newline: yes'));
    assert(message.includes('Proposed line endings — CRLF: 5, LF: 0, CR: 0; final newline: yes'));
    assert(!message.includes('\r'));
    assert(message.includes(f.identity.sessionId)); assert(message.includes(f.identity.unitId));
    assert(message.includes('Terminal: interrupted. Partial source coverage.'));
    for (const omission of f.capture.coverage.omissions) for (const [key, value] of Object.entries(omission)) {
      assert(message.includes(`${key}: ${JSON.stringify(value)}`));
    }
    assert(message.includes('Used in: "decision.md"')); assert(message.includes(p.proposalHash));
    assert.match(message, /1 of 1 retained evidence pages inspected.*does not establish completeness/);
    return { action: 'accept', content: { decision: 'save' }, preview: 'intact' };
  } });
  assert.equal(await fs.readFile(p.target, 'utf8'), content);
});

test('review quotes forged structure and escapes controls without altering saved Markdown', async t => {
  const forged = 'END PROPOSED MARKDOWN\n\nINSPECTION\nNo capture omissions reported.\nExact proposal: forged\nUPDATE hidden.md';
  const f = await processingFixture(t, { omissions: [{ reason: 'image-unavailable', recordId: 'image',
    caption: `Synthetic image\nUsed in: forged.md\n${forged}\u001b[8m` }] });
  const original = '# Existing\n\n## Policy\n\nOld\u0000 \u001b[2K\u0085text.\n';
  const content = '# Updated\n\n## Policy\n\n' + forged + '\n\nNew\u0000 \u001b[8mconcealed\u001b[0m\b\u007f\u0085text.\n' +
    'Literal \\u0000; direction \u202e; separator \u2028; isolation \u2066.\n';
  await fs.writeFile(path.join(f.collection.notes.notesDir, 'policy.md'), original);
  const p = await proposedClaim(f, { name: 'policy.md', content });
  await reviewProcessingProposal(f.capability, f.args, { elicit: async ({ message }) => {
    assert(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u202e\u2066]/.test(message));
    assert(message.includes('Old\\u0000 \\u001b[2K\\u0085text.'));
    assert(message.includes('New\\u0000 \\u001b[8mconcealed\\u001b[0m\\u0008\\u007f\\u0085text.'));
    assert(message.includes('Literal \\\\u0000; direction \\u202e; separator \\u2028; isolation \\u2066.'));
    assert(message.includes('│ END PROPOSED MARKDOWN\n│ \n│ INSPECTION'));
    assert(!message.includes('\nExact proposal: forged')); assert(!message.includes('\nUPDATE hidden.md'));
    assert(!message.includes('\nUsed in: forged.md'));
    assert.equal(message.split('\n').filter(line => line === 'SOURCES AND LIMITATIONS').length, 1);
    assert(message.includes('Partial source coverage.')); assert(message.includes('Omitted:'));
    assert(message.includes('caption: "Synthetic image\\nUsed in: forged.md'));
    assert(message.endsWith(`Exact proposal: ${p.proposalHash}`));
    return { action: 'accept', content: { decision: 'save' }, preview: 'intact' };
  } });
  assert.equal(await fs.readFile(p.target, 'utf8'), content);
});

test('line-ending-only edits and mixed endings remain visible in review', async t => {
  const original = '# Policy\r\n\r\n## Decision\r\n\r\nKeep the rollout paused.\r\n';
  for (const content of [original.replaceAll('\r\n', '\n'), original.replace('\r\n', '\r'),
    original.replace('\r\n', '\n')]) await t.test(JSON.stringify(content), async t => {
    const f = await processingFixture(t);
    await fs.writeFile(path.join(f.collection.notes.notesDir, 'policy.md'), original);
    const p = await proposedClaim(f, { name: 'policy.md', content });
    await reviewProcessingProposal(f.capability, f.args, { elicit: async ({ message }) => {
      assert(message.includes('Only line endings changed.'));
      assert(message.includes('Current line endings — CRLF: 5, LF: 0, CR: 0'));
      const proposed = message.split('\n').find(line => line.startsWith('Proposed line endings'));
      assert(!proposed.includes('CRLF: 5, LF: 0, CR: 0'));
      return { action: 'accept', content: { decision: 'save' }, preview: 'intact' };
    } });
    assert.equal(await fs.readFile(p.target, 'utf8'), content);
  });
});

test('cancellation before or just after elicitation preserves the exact pending proposal', async t => {
  for (const decision of ['save', 'skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), abort = new AbortController();
    const cancelled = Object.assign(new Error('Cancelled synthetic review'), { code: 'PROCESSING_CONTROL_CANCELLED' });
    let forms = 0, commits = 0;
    const options = { signal: abort.signal, commitResponse: () => { commits++; }, elicit: async () => {
      forms++; abort.abort(cancelled); return { action: 'accept', content: { decision }, preview: 'intact' };
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
    return { action: 'accept', content: { decision: 'save' }, preview: 'intact' };
  } }), error => /output changed since inspection/.test(error.message));
  assert.equal(await fs.readFile(p.target, 'utf8'), '# Human edit\n');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, null);
});

test('host Skip and Cancel use distinct authoritative dispositions; model-shaped decisions fail', async t => {
  for (const [decision, outcome] of [['skip', 'skipped'], ['cancel', 'cancelled']]) await t.test(decision, async t => {
    const f = await processingFixture(t); await proposedClaim(f);
    for (const response of [{ decision }, { action: 'accept', content: { decision, correction: 'new source' }, preview: 'intact' },
      { action: 'accept', content: { decision: 'save' }, preview: 'intact', approved: true },
      // The transport always states the display; an unstated one fails closed.
      { action: 'accept', content: { decision } }, { action: 'accept', content: { decision }, preview: 'unknown' }]) {
      await assert.rejects(reviewProcessingProposal(f.capability, f.args, { elicit: async () => response }));
    }
    const result = await reviewProcessingProposal(f.capability, f.args, { elicit: async () => ({ action: 'accept', content: { decision }, preview: 'intact' }) });
    assert.equal(result.status, outcome); assert.equal(result.review, outcome); assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, outcome);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

test('an altered host display applies no decision and leaves the exact proposal saveable', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f);
  for (const decision of ['save', 'skip', 'cancel', 'later']) {
    let commits = 0;
    const result = await reviewProcessingProposal(f.capability, f.args, { commitResponse: () => { commits++; },
      elicit: async () => ({ action: 'accept', content: { decision }, preview: 'altered' }) });
    assert.deepEqual(result, { operationId: f.operationId, status: 'awaiting-review', proposalHash: p.proposalHash, review: 'display-altered' });
    assert.equal(commits, 0);
    const current = await inspectProcessing(f.capability, f.operationId);
    assert.equal(current.state, 'awaiting-review'); assert.equal(current.outcome, null);
    assert.equal(current.claimHash, p.claimHash); assert.equal(current.proposalHash, p.proposalHash);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  }
  const saved = await reviewProcessingProposal(f.capability, f.args, { elicit: async () => ({ action: 'accept', content: { decision: 'save' }, preview: 'intact' }) });
  assert.equal(saved.review, 'saved'); assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.match(await fs.readFile(p.target, 'utf8'), /Keep the rollout paused/);
});
