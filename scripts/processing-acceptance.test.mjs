import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, inspectedClaim } from './test-support/processing-fixture.mjs';
import { prepareProcessing, readProcessingPage, acknowledgeProcessingPages, proposeProcessing, saveProcessing, completeProcessing, inspectProcessing } from './processing.mjs';
import { createProcessingWorkset, prepareWorksetBatch, inspectProcessingWorkset } from './processing-workset.mjs';
import { fingerprint } from './safe-update.mjs';
import MarkdownIt from 'markdown-it';

// These are deliberately authored synthetic drafts. They verify engine behavior,
// not semantic synthesis, app rendering or automatic model invocation.
const save = (f, p, hash = p.proposalHash) => saveProcessing(f.capability, { ...f.args, expectedClaimHash: p.claimHash, approvedProposalHash: hash, trigger: 'approved' });
async function readAll(f, claim) {
  let text = '';
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const issued = await readProcessingPage(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, page });
    text += issued.evidence.text;
    claim = await acknowledgeProcessingPages(f.capability, { ...f.args, expectedClaimHash: issued.claimHash, pages: [{ index: page, hash: issued.hash }] });
  }
  return { claim, packet: JSON.parse(text) };
}
async function consolidate(f, claim, content, name) {
  const contentPath = path.join(f.root, randomUUID() + '.md'); await fs.writeFile(contentPath, content);
  return proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, proposal: {
    files: [{ path: name, expectedHash: await fingerprint(path.join(f.collection.notes.notesDir, name)), contentPath, expectedContentHash: await fingerprint(contentPath) }],
    mappings: claim.inputs.map(input => ({ identity: input.identity, paths: [name] })),
  } });
}

test('retained repeated facts from both clients complete unchanged without another note', async t => {
  const a = await processingFixture(t, { text: 'Synthetic contract: caller must retry explicitly.' });
  const b = await processingFixture(t, { base: a, client: 'claude', text: 'Synthetic contract: caller must retry explicitly.' });
  const note = '# Retry contract\n\n## Explicit retries\n\nCaller must retry explicitly.\n';
  const target = path.join(a.collection.notes.notesDir, 'retry-contract.md'); await fs.writeFile(target, note);
  for (const f of [a, b]) {
    const claim = await inspectedClaim(f);
    assert.equal((await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'unchanged' })).status, 'unchanged');
    const status = await inspectProcessing(f.capability, f.operationId);
    assert.equal(status.outcome, 'unchanged');
    await assert.rejects(prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs }), /ALREADY_HANDLED/);
  }
  assert.equal(await fs.readFile(target, 'utf8'), note);
  assert.deepEqual(await fs.readdir(a.collection.notes.notesDir), ['retry-contract.md']);
});

test('selected failure, diagnosis and fix-testing evidence map to one existing subject note', async t => {
  const a = await processingFixture(t, { text: 'Synthetic Atlas library: unchanged compiled caller fails after an API change.' });
  const b = await processingFixture(t, { base: a, text: 'Recompiling the caller hides the binary incompatibility. Restore the missing entry point.' });
  const c = await processingFixture(t, { base: a, client: 'claude', text: 'Rina reports one unchanged compiled caller passed with the restored entry point. Other clients remain untested.' });
  a.inputs.push(...b.inputs, ...c.inputs);
  const target = path.join(a.collection.notes.notesDir, 'binary-compatibility.md');
  const original = '# Atlas compatibility\n\n## Existing constraint\n\nPreserve the human constraint.\n'; await fs.writeFile(target, original);
  const { claim, packet } = await readAll(a, await prepareProcessing(a.capability, { ...a.args, inputs: a.inputs }));
  assert.equal(packet.sources.length, 3);
  const content = original + '\n## Binary callers\n\nAn unchanged compiled caller failed after the API change; recompiling hid the issue. Rina reports one unchanged caller passed after the missing entry point was restored. Other clients remain untested.\n\n<!-- source-review: three selected synthetic revisions reconciled -->\n';
  const p = await consolidate(a, claim, content, 'binary-compatibility.md');
  assert.equal(p.mappings.length, 3); assert.equal(p.plan.files.length, 1);
  assert.equal(await fs.readFile(target, 'utf8'), original, 'staging is draft-only');
  await save(a, p);
  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.deepEqual(await fs.readdir(a.collection.notes.notesDir), ['binary-compatibility.md']);
  const rendered = new MarkdownIt({ html: true }).render(content);
  assert(rendered.includes('<!-- source-review:'));
  assert(!new MarkdownIt({ html: true }).parse(content, {}).filter(t => t.type === 'inline').some(t => t.content.includes('three selected synthetic')));
});

for (const reverse of [false, true]) test(`frozen correction review resumes with omissions and rejects earlier proposal authority, reverse=${reverse}`, async t => {
  const a = await processingFixture(t, { text: 'Synthetic cases A and B are unresolved. No outcomes are verified.' });
  const b = await processingFixture(t, { base: a, text: 'Rina reports case A passed. The cited image is unavailable. No new result for case B.',
    omissions: [{ reason: 'inline-attachment-not-copied', recordId: 'message' }, { reason: 'tool-result-call-limit', recordId: 'message', bytes: 12000 }] });
  const ordered = reverse ? [b, a] : [a, b], inputs = ordered.flatMap(f => f.inputs), worksetId = randomUUID();
  let workset = await createProcessingWorkset(a.capability, { selection: a.selection, worksetId, inputs });
  const first = await prepareWorksetBatch(a.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  const f = { ...a, operationId: first.operationId, args: { ...a.args, operationId: first.operationId } };
  // Delivery then interruption: no acknowledgment is inferred on resumption.
  const issued = await readProcessingPage(f.capability, { ...f.args, expectedClaimHash: first.claimHash, page: 0 });
  const status = await inspectProcessing(f.capability, f.operationId);
  assert.equal(status.inspection.acknowledgedPages, 0);
  const inspected = await readAll(f, { ...first, claimHash: issued.claimHash });
  const p = await consolidate(f, inspected.claim, '# Case outcomes\n\n## Partial review\n\nOne selected source remains unread; do not finalize outcomes.\n', 'cases.md');
  await assert.rejects(consolidate(f, { ...inspected.claim, claimHash: p.claimHash },
    '# Case outcomes\n\n## Partial review\n\nDifferent text cannot reuse the same immutable proposal.\n', 'cases.md'), /PROPOSAL_CHANGED/);
  workset = await inspectProcessingWorkset(a.capability, { worksetId });
  const second = await prepareWorksetBatch(a.capability, { worksetId, expectedWorksetHash: workset.worksetHash, indexes: [1] });
  const g = { ...a, operationId: second.operationId, args: { ...a.args, operationId: second.operationId } };
  const later = await readAll(g, second);
  const packets = [...inspected.packet.sources, ...later.packet.sources];
  assert.deepEqual(packets.find(item => item.capture.identity.unitId === b.identity.unitId).capture.coverage.omissions, b.capture.coverage.omissions);
  assert.equal((await inspectProcessing(g.capability, g.operationId)).inspection.state, 'inspected');
  assert.equal((await inspectProcessing(g.capability, g.operationId)).inspection.sourceCompleteness, 'unknown', 'metadata-only status must not equate acknowledgment with source completeness');
  // Immutable drafts must be cancelled deliberately, not rewritten under approval.
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: p.claimHash, outcome: 'cancelled' });
  await completeProcessing(g.capability, { ...g.args, expectedClaimHash: later.claim.claimHash, outcome: 'cancelled' });
  const cancelled = await inspectProcessingWorkset(a.capability, { worksetId });
  assert.equal(cancelled.remainingSelected, 2); assert.equal(cancelled.inputCounts.cancelled, 2);
  const operationId = randomUUID(), merged = { ...a, inputs, operationId, args: { ...a.args, operationId } };
  const claim = await inspectedClaim(merged);
  const content = '# Case outcomes\n\n## Case A\n\nRina reports that case A passed; the image was unavailable, so its contents were not verified. Some tool output was omitted; no broader test conclusion is supported.\n\n## Case B\n\nCase B remains unresolved.\n';
  const revised = await consolidate(merged, claim, content, 'cases.md');
  assert.notEqual(revised.proposalHash, p.proposalHash);
  await assert.rejects(save(merged, revised, p.proposalHash), /PROPOSAL_CHANGED/);
  assert.equal(await fingerprint(path.join(a.collection.notes.notesDir, 'cases.md')), null);
  await save(merged, revised);
  assert.equal(await fs.readFile(path.join(a.collection.notes.notesDir, 'cases.md'), 'utf8'), content);
  const completed = await inspectProcessingWorkset(a.capability, { worksetId });
  assert.equal(completed.inputs.length, 2); assert.equal(completed.remainingSelected, 0);
  assert.equal(completed.outcomeCounts.cancelled, 2, 'original operation outcomes are historical');
  assert.equal(completed.inputCounts.handledElsewhere, 2);
  assert(completed.items.every(item => item.state === 'handled-elsewhere' && item.externalOutcome === 'saved'));
});
