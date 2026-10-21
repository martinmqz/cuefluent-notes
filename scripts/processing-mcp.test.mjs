import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, proposedClaim, replaceProcessingStorage } from './test-support/processing-fixture.mjs';
import { deferred, body, selectedInput, harness, prepareFromPending, draft, proposeThroughTools, proposeInChat } from './test-support/processing-mcp.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { inspectProcessingShortcut } from './processing-shortcuts.mjs';
import { processingStatusView } from './processing-mcp.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { inspectProcessing, readProcessingProposal, completeProcessing } from './processing.mjs';
import { createProcessingWorkset } from './processing-workset.mjs';
import { reviewProcessingProposal } from './processing-host-review.mjs';
import { openWorkflowIntake } from './intake-io.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';

test('source review requires a correlated host action and saves the exact engine proposal without exposing the draft to the source model', async t => {
  const f = await processingFixture(t), h = await harness(t, f), first = await proposeInChat(f, h);
  const forged = await h.call('processing_review', { collectionId: f.collection.id, decision: 'save' });
  assert.equal(forged.error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const nextForm = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await nextForm;
  assert(form.params.requestedSchema.properties.changes.default.includes('PRIVATE-SYNTHETIC-PROPOSAL'));
  assert(form.params.requestedSchema.properties.changes.default.includes((await inspectProcessing(f.capability, f.operationId)).proposalHash));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  h.answer(form, { action: 'accept', content: { decision: 'save' } });
  const result = body(await review);
  assert.equal(result.status, 'idle'); assert.equal(result.chat.sessionId, first.chat.sessionId);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert(!JSON.stringify(h.responses.filter(row => row.method !== 'elicitation/create')).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
  h.script = async call => { assert.deepEqual((await call('processing_pending', {})).pending, []); };
  const closed = h.whenClosed(); body(await h.call('process_selected_captures', { collectionId: f.collection.id, requestId: randomUUID(), selection: selectedInput(f) }));
  await closed; assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
});

test('editing the native preview refuses Save and preserves the exact proposal for fresh review', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const before = await inspectProcessing(f.capability, f.operationId);
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next;
  h.answer(form, { action: 'accept', content: {
    changes: form.params.requestedSchema.properties.changes.default + '\nUser edit', decision: 'save'
  } });
  const refused = body(await review);
  assert.equal(refused.status, 'awaiting-review'); assert.equal(refused.review, 'display-altered');
  assert.equal(refused.nextAction, 'review'); assert.deepEqual(refused.diagnostics, []);
  assert.match(refused.statusText, /Nothing was saved, skipped or cancelled; draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) remains pending\./);
  const after = await inspectProcessing(f.capability, f.operationId);
  assert.equal(after.state, 'awaiting-review'); assert.equal(after.outcome, null);
  assert.equal(after.claimHash, before.claimHash); assert.equal(after.proposalHash, before.proposalHash);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const retry = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
  const fresh = await retry;
  assert.equal(fresh.params.requestedSchema.properties.changes.default, form.params.requestedSchema.properties.changes.default);
  h.answer(fresh, { action: 'accept', content: { decision: 'skip' } });
  assert.equal(body(await result).status, 'idle');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'skipped');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  assert(!JSON.stringify(h.responses.filter(row => row.method !== 'elicitation/create')).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
});

test('observed Claude review responses keep the exact draft pending with truthful outcomes', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const before = await inspectProcessing(f.capability, f.operationId);
  const review = async answer => {
    const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
    const form = await next; h.answer(form, answer(form)); return result;
  };
  // Claude CLI 2.1.294 and 2.1.299 initialize string defaults through a sanitizer
  // that replaces LF/CR/U+2028/U+2029 with U+FFFD; the person cannot read the
  // original multiline preview, then submits only a navigated decision.
  const sanitized = form => form.params.requestedSchema.properties.changes.default.replace(/[\n\r\u2028\u2029]/g, '\uFFFD');
  for (const [name, answer, outcome] of [
    // Claude Desktop 2.42304.0 advertises elicitation without a host handler;
    // its SDK returns this decline without displaying any form.
    ['Desktop decline', () => ({ action: 'decline' }), 'declined'],
    // Later applies nothing, so it needs no intact display.
    ['CLI Later', form => ({ action: 'accept', content: { changes: sanitized(form), decision: 'later' } }), 'deferred'],
    ['CLI Save', form => ({ action: 'accept', content: { changes: sanitized(form), decision: 'save' } }), 'display-altered'],
    ['CLI Skip', form => ({ action: 'accept', content: { changes: sanitized(form), decision: 'skip' } }), 'display-altered'],
  ]) {
    const row = await review(answer);
    assert.equal(row.error, undefined, name);
    const reported = body(row);
    assert.equal(reported.status, 'awaiting-review', name); assert.equal(reported.review, outcome, name);
    assert.equal(reported.nextAction, 'review', name); assert.deepEqual(reported.diagnostics, [], name);
    // Neither result claims a displayed form, a changed draft, or bare readiness.
    assert(!reported.statusText.includes('Draft ready'), name);
    assert(!JSON.stringify(row).includes('PREVIEW_CHANGED'), name);
    assert.match(reported.statusText, { declined: /may not have been displayed/, deferred: /deferred with Later/ }[outcome] ?? /may not have been readable/, name);
    const current = await inspectProcessing(f.capability, f.operationId);
    assert.equal(current.state, 'awaiting-review', name); assert.equal(current.outcome, null, name);
    assert.equal(current.claimHash, before.claimHash, name); assert.equal(current.proposalHash, before.proposalHash, name);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), [], name);
  }
  // The same pending draft still saves exactly when a host round-trips its display.
  const saved = body(await review(() => ({ action: 'accept', content: { decision: 'save' } })));
  assert.equal(saved.review, 'saved');
  assert.match(saved.statusText, /^Cuefluent: Review completed: the exact reviewed proposal of draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) was saved\./);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert(!JSON.stringify(h.responses.filter(row => row.method !== 'elicitation/create')).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
  assert.equal(h.dispatches, 1);
});

test('native review safely displays controls and accepts a CRLF echo while saving the exact draft bytes', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const target = path.join(f.collection.notes.notesDir, 'meetings/rollout.md');
  const original = '# Existing policy\n\n## Decision\n\nOld\u0000\u001b[2Kpolicy.\n';
  await fs.mkdir(path.dirname(target)); await fs.writeFile(target, original);
  const content = '# Synthetic policy\r\n\r\n## Decision\r\n\r\nKeep the rollout paused.\u001b[8mHidden\u001b[0m\r\n';
  await proposeInChat(f, h, content, digest(original));
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next, preview = form.params.requestedSchema.properties.changes.default;
  assert(!preview.includes('\u0000')); assert(!preview.includes('\u001b'));
  assert(preview.includes('Old\\u0000\\u001b[2Kpolicy.'));
  assert(preview.includes('\\u001b[8mHidden\\u001b[0m'));
  h.answer(form, { action: 'accept', content: { decision: 'save', changes: preview.replaceAll('\n', '\r\n') } });
  assert.equal(body(await review).status, 'idle');
  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
});

test('an oversized decoded form reply preserves the exact proposal and permits a new review', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const before = await inspectProcessing(f.capability, f.operationId);
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next;
  h.answer(form, { action: 'accept', content: { decision: 'save', changes: 'x'.repeat(256 * 1024 + 1) } });
  assert.equal(body(await review).review, 'display-altered');
  const after = await inspectProcessing(f.capability, f.operationId);
  assert.equal(after.claimHash, before.claimHash); assert.equal(after.proposalHash, before.proposalHash);
  assert.equal(after.state, 'awaiting-review'); assert.equal(after.outcome, null);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  const retry = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
  h.answer(await retry, { action: 'accept', content: { decision: 'later' } });
  assert.equal(body(await result).status, 'awaiting-review');
});

test('formal review replay preserves its exact completed result without another host form or write', async t => {
  for (const decision of ['save', 'skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
    h.nativeSkill = true; h.callId = 'review_call';
    const args = { collectionId: f.collection.id }, next = h.nextForm(), review = h.call('processing_review', args);
    h.answer(await next, { action: 'accept', content: { decision } });
    const first = await review; assert.equal(first.error, undefined);
    const operation = await inspectProcessing(f.capability, f.operationId);
    const receiptFile = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest(h.callId).slice(0, 24)}.json`);
    const receipt = await fs.readFile(receiptFile);
    assert.deepEqual((await h.call('processing_review', args)).result, first.result);
    assert.equal(h.forms.length, 1); assert.equal(h.finishReviewCalls, 1);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), operation);
    assert.deepEqual(await fs.readFile(receiptFile), receipt);
    if (decision === 'save') assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
    else assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

test('review cancellation after host approval but before durable publication preserves the proposal and inputs', async t => {
  for (const decision of ['save', 'skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
    const before = await inspectProcessing(f.capability, f.operationId), entered = deferred(), gate = deferred();
    h.release = gate.resolve;
    const open = fs.open; let staged = false;
    t.mock.method(fs, 'open', async function(file, ...args) {
      if (!staged && typeof file === 'string' && path.basename(file).startsWith('.processing-') && args[0] === 'wx') {
        staged = true; entered.resolve(); await gate.promise;
      }
      return open.call(this, file, ...args);
    });
    const next = h.nextForm(); void h.call('processing_review', { collectionId: f.collection.id });
    h.answer(await next, { action: 'accept', content: { decision } });
    await entered.promise;
    h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await new Promise(resolve => setImmediate(resolve)); gate.resolve();
    await h.send({ jsonrpc: '2.0', id: 100, method: 'ping' });
    assert(!h.responses.some(row => row.id === 2)); assert.equal(h.finishReviewCalls ?? 0, 0);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), before);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    assert.deepEqual(await fs.readdir(path.join(f.collection.notes.writerStateDir, 'processing-stages')), []);
    const retryForm = h.nextForm(), retry = h.call('processing_review', { collectionId: f.collection.id });
    h.answer(await retryForm, { action: 'accept', content: { decision } });
    assert.equal((await retry).error, undefined);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome,
      { save: 'saved', skip: 'skipped', cancel: 'cancelled' }[decision]);
  });
});

test('review cancellation during durable publication preserves the committed result and replay', async t => {
  for (const decision of ['save', 'skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
    h.nativeSkill = true; h.callId = 'review_publication';
    const target = path.join(f.collection.notes.writerStateDir,
      decision === 'save' ? 'transactions' : 'processed/operations', `${f.operationId}.json`);
    const rename = fs.rename; let cancelled = false;
    t.mock.method(fs, 'rename', async function(from, to) {
      if (!cancelled && to === target) {
        cancelled = true;
        h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
        await new Promise(resolve => setImmediate(resolve));
      }
      return rename.call(this, from, to);
    });
    const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
    h.answer(await next, { action: 'accept', content: { decision } });
    const result = await review;
    assert.equal(cancelled, true); assert.equal(body(result).status, 'idle');
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome,
      { save: 'saved', skip: 'skipped', cancel: 'cancelled' }[decision]);
    if (decision === 'save') assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
    else assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    assert.deepEqual((await h.call('processing_review', { collectionId: f.collection.id })).result, result.result);
    assert.equal(h.finishReviewCalls, 1); assert.equal(h.forms.length, 1);
  });
});

test('committed source Save stays successful when the chat registry requires later reconciliation', async t => {
  const f = await processingFixture(t), h = await harness(t, f), first = await proposeInChat(f, h);
  h.finishReviewFailure = Object.assign(new Error('private registry detail'), { code: 'PROCESSING_CHAT_CONFLICT' });
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  h.answer(await next, { action: 'accept', content: { decision: 'save' } });
  const row = await review;
  assert.equal(row.error, undefined);
  const result = body(row);
  assert.equal(result.status, 'completed'); assert.equal(result.nextAction, 'inspect');
  assert.equal(result.statusDetail, 'completed');
  assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_CONFLICT']);
  // The visible reply keeps the saved outcome and still says to look further.
  assert.match(result.statusText, /^Cuefluent: Review completed: the exact reviewed proposal of draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) was saved\./);
  assert(result.statusText.endsWith('\nSomething needs attention; for details, type $cuefluent-notes status --verbose.'), result.statusText);
  assert.equal(result.requestId, first.requestId); assert.deepEqual(result.chat, first.chat);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.equal(body(await h.call('processing_status', { collectionId: f.collection.id })).status, 'idle');
  assert.equal(h.finishReviewCalls, 1); assert.equal(h.dispatches, 1);
  assert(!JSON.stringify(row).includes('private registry detail'));
});

test('committed source Save survives revoked receipt authorization without fabricating exclusion proof', async t => {
  const f = await processingFixture(t), h = await harness(t, f), first = await proposeInChat(f, h);
  const original = await fs.readFile(f.options.configPath), changed = JSON.parse(original);
  changed.routes[0].collection.enabled = false;
  h.nativeSkill = true;
  h.beforeFinishReview = () => fs.writeFile(f.options.configPath, JSON.stringify(changed));
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  h.answer(await next, { action: 'accept', content: { decision: 'save' } });
  const row = await review;
  assert.equal(row.error, undefined);
  const result = body(row);
  assert.equal(result.status, 'completed'); assert.equal(result.nextAction, 'inspect');
  assert.equal(result.statusDetail, 'completed');
  assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_CONFLICT']);
  // The visible reply keeps the saved outcome and still says to look further.
  assert.match(result.statusText, /^Cuefluent: Review completed: the exact reviewed proposal of draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) was saved\./);
  assert(result.statusText.endsWith('\nSomething needs attention; for details, type $cuefluent-notes status --verbose.'), result.statusText);
  assert.equal(result.requestId, first.requestId); assert.deepEqual(result.chat, first.chat);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  await assert.rejects(fs.lstat(path.join(f.collection.intakeStateDir, 'control-dispatch')), { code: 'ENOENT' });
  await fs.writeFile(f.options.configPath, original);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.equal(body(await h.call('processing_status', { collectionId: f.collection.id })).status, 'idle');
  assert.equal(h.finishReviewCalls, 1); assert.equal(h.dispatches, 1);
});

test('controller close failure after source Save preserves its committed outcome', async t => {
  const f = await processingFixture(t), h = await harness(t, f), first = await proposeInChat(f, h);
  h.closeFailure = Object.assign(new Error('private cleanup detail'), { code: 'PRIVATE_CLEANUP_ERROR' });
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  h.answer(await next, { action: 'accept', content: { decision: 'save' } });
  const row = await review;
  assert.equal(row.error, undefined);
  const result = body(row);
  assert.equal(result.status, 'completed'); assert.equal(result.nextAction, 'inspect');
  assert.equal(result.statusDetail, 'completed');
  assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_CONFLICT']);
  // The visible reply keeps the saved outcome and still says to look further.
  assert.match(result.statusText, /^Cuefluent: Review completed: the exact reviewed proposal of draft [a-hjkmnp-tv-z2-9]{6} \("meetings\/rollout\.md"\) was saved\./);
  assert(result.statusText.endsWith('\nSomething needs attention; for details, type $cuefluent-notes status --verbose.'), result.statusText);
  assert.equal(result.requestId, first.requestId); assert.deepEqual(result.chat, first.chat);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.equal(h.finishReviewCalls, 1); assert.equal(h.dispatches, 1);
  assert(!JSON.stringify(row).includes('private cleanup detail'));
});

test('exact proposal preview refuses stale hashes and oversized native review never truncates or opens a form', async t => {
  const f = await processingFixture(t), content = '# Bounded review\n\n## Knowledge\n\n' + 'Synthetic content.\n'.repeat(16000);
  const proposed = await proposedClaim(f, { content });
  const args = { ...f.args, expectedClaimHash: proposed.claimHash, expectedProposalHash: proposed.proposalHash };
  await assert.rejects(readProcessingProposal(f.capability, { ...args, expectedClaimHash: digest('stale claim') }), { code: 'PROCESSING_CLAIM_CHANGED' });
  await assert.rejects(readProcessingProposal(f.capability, { ...args, expectedProposalHash: digest('stale proposal') }), { code: 'PROCESSING_PROPOSAL_CHANGED' });
  const preview = await readProcessingProposal(f.capability, args);
  assert.equal(preview.files[0].proposed, content);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, proposed.claimHash);
  let elicited = false;
  await assert.rejects(reviewProcessingProposal(f.capability, f.args, { elicit: async () => { elicited = true; return { action: 'cancel' }; } }),
    { code: 'PROCESSING_REVIEW_LIMIT' });
  assert.equal(elicited, false);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('source review preserves exact pending proposal on Later, decline and closed form, then distinguishes skip from cancel', async t => {
  for (const decision of ['skip', 'cancel']) await t.test(decision, async t => {
    const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
    const pending = await inspectProcessing(f.capability, f.operationId);
    for (const [response, review] of [[{ action: 'accept', content: { decision: 'later' } }, 'deferred'],
      [{ action: 'decline' }, 'declined'], [{ action: 'cancel' }, 'declined']]) {
      const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
      h.answer(await next, response);
      const reported = body(await result);
      assert.equal(reported.status, 'awaiting-review'); assert.equal(reported.review, review);
      assert.equal((await inspectProcessing(f.capability, f.operationId)).proposalHash, pending.proposalHash);
    }
    const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
    h.answer(await next, { action: 'accept', content: { decision } });
    const completed = body(await result);
    assert.equal(completed.status, 'idle'); assert.equal(completed.review, decision === 'skip' ? 'skipped' : 'cancelled');
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, decision === 'skip' ? 'skipped' : 'cancelled');
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []); assert.equal(h.dispatches, 1);
  });
});

test('busy source review does not open a form or duplicate the processing session', async t => {
  const f = await processingFixture(t), h = await harness(t, f), gate = deferred(); h.release = gate.resolve;
  h.script = async () => gate.promise;
  await h.call('process_selected_captures', { collectionId: f.collection.id, requestId: randomUUID() });
  const status = body(await h.call('processing_review', { collectionId: f.collection.id }));
  assert.equal(status.status, 'busy'); assert.deepEqual(status.diagnostics, ['PROCESSING_CHAT_BUSY']);
  assert.equal(h.forms.length, 0); assert.equal(h.creates, 1); assert.equal(h.dispatches, 1); gate.resolve();
});

test('a settings change while native review is open cannot authorize the stale proposal', async t => {
  const f = await processingFixture(t), h = await harness(t, f); await proposeInChat(f, h);
  const next = h.nextForm(), result = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next, original = await fs.readFile(f.options.configPath), config = JSON.parse(original);
  config.routes[0].collection.enabled = false;
  await fs.writeFile(f.options.configPath, JSON.stringify(config));
  h.answer(form, { action: 'accept', content: { decision: 'save' } });
  const refused = await result;
  assert(refused.error); assert(!JSON.stringify(refused).includes('PRIVATE-SYNTHETIC-PROPOSAL'));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  await fs.writeFile(f.options.configPath, original);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
});

// A selection that changed only by the exclusions of typed command turns.
async function completeNextBatch(call, f) {
  let claim = await prepareFromPending(call, f);
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page });
    claim = await call('processing_ack', { operationId: f.operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  await call('processing_complete', { operationId: f.operationId, expectedClaimHash: claim.claimHash });
}

test('process drafts across the collection in bounded batches using one reusable native session', async t => {
  const f = await processingFixture(t);
  for (let i = 0; i < 5; i++) await processingFixture(t, { base: f, client: i % 2 ? 'claude' : 'codex' });
  const before = await fs.readFile(f.options.configPath), h = await harness(t, f);
  h.script = call => completeNextBatch(call, f);
  const closed = h.whenClosed(), accepted = body(await h.call('process_selected_captures', {}));
  assert.equal(accepted.scope, 'collection'); assert.equal(accepted.statusDetail, 'accepted');
  await closed;
  const status = body(await h.call('processing_status', {}));
  assert.equal(status.progress.handled, 6); assert.equal(status.progress.unattempted, 0);
  assert.equal(status.inventory.pending, 0); assert.equal(status.inventory.sourceCompleteness, 'unknown');
  assert.equal(h.dispatches, 2); assert.equal(h.creates, 1); assert.equal(h.resumes, 1);
  const again = body(await h.call('process_selected_captures', {}));
  assert.equal(again.statusDetail, 'nothing-pending'); assert.equal(h.dispatches, 2);
  assert.deepEqual(await fs.readFile(f.options.configPath), before);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('resume without unfinished work reports a no-op and starts no native session', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const result = body(await h.call('processing_resume', {}));
  assert.equal(result.statusDetail, 'nothing-to-resume'); assert.equal(h.dispatches, 0); assert.equal(h.creates, 0);
  assert.equal(body(await h.call('processing_status', {})).inventory.pending, 1);
});

test('cancel waits for the owned native turn to end before releasing its exact claim', async t => {
  const f = await processingFixture(t), h = await harness(t, f), entered = deferred(), gate = deferred();
  h.release = gate.resolve; h.onInterrupt = gate.resolve;
  h.script = async call => { await prepareFromPending(call, f); entered.resolve(); await gate.promise; };
  body(await h.call('process_selected_captures', {})); await entered.promise;
  const before = await fs.readFile(f.options.configPath);
  const cancelled = body(await h.call('processing_cancel', {}));
  assert.equal(cancelled.statusDetail, 'cancelled'); assert.equal(h.interrupts, 1);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'cancelled');
  assert.equal(body(await h.call('processing_status', {})).inventory.pending, 1);
  assert.deepEqual(await fs.readFile(f.options.configPath), before);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  // Re-delivery of Cancel cannot affect a newer frozen processing selection.
  h.script = async call => call('processing_pending', {});
  const closed = h.whenClosed(); body(await h.call('process_selected_captures', {})); await closed;
  h.callId = 'call_2';
  assert.deepEqual(body(await h.call('processing_cancel', {})), cancelled);
  assert.equal(h.interrupts, 1);
});

test('review selects one exact collection proposal before presenting its contents', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f, client: 'claude' });
  await proposedClaim(f); await proposedClaim(b);
  const h = await harness(t, f), choose = h.nextForm(), review = h.call('processing_review', {});
  const selector = await choose;
  const choices = selector.params.requestedSchema.properties.operationId.oneOf;
  assert.equal(choices.length, 2); assert(choices.some(item => item.const === b.operationId));
  // The picker names each draft by its captured turns, never in internal words.
  for (const item of choices) assert.match(item.title, /^Draft [12]: \d+ captured turns?; /);
  assert.doesNotMatch(JSON.stringify(selector.params), /collect|captures/i);
  const preview = h.nextForm(); h.answer(selector, { action: 'accept', content: { operationId: b.operationId } });
  const form = await preview;
  assert(form.params.requestedSchema.properties.changes.default.includes((await inspectProcessing(b.capability, b.operationId)).proposalHash));
  h.answer(form, { action: 'accept', content: { decision: 'skip' } }); await review;
  assert.equal((await inspectProcessing(b.capability, b.operationId)).outcome, 'skipped');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  assert.equal(h.dispatches, 0); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('cancel from another controller refuses an unverified active owner and preserves its claim', async t => {
  const f = await processingFixture(t), owner = await harness(t, f), gate = deferred(), entered = deferred();
  owner.release = gate.resolve;
  owner.script = async call => { await prepareFromPending(call, f); entered.resolve(); await gate.promise; };
  body(await owner.call('process_selected_captures', {})); await entered.promise;
  const before = await inspectProcessing(f.capability, f.operationId), outsider = await harness(t, f);
  outsider.callId = 'cancel_from_other';
  const result = await outsider.call('processing_cancel', {});
  assert.equal(result.error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, before.claimHash);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, null);
  assert.equal(outsider.dispatches, 0); gate.resolve();
});

test('status in another native host reports the existing collection run instead of a second idle processor', async t => {
  const f = await processingFixture(t), owner = await harness(t, f), gate = deferred();
  owner.release = gate.resolve; owner.script = async () => gate.promise;
  const accepted = body(await owner.call('process_selected_captures', {}));
  const other = await harness(t, f, { controllerIdentity: { hostId: digest('other-synthetic-host') } });
  other.callId = 'status_from_other';
  const status = body(await other.call('processing_status', {}));
  assert.equal(status.status, 'busy'); assert.equal(status.statusDetail, 'processing');
  assert.deepEqual(status.chat, accepted.chat); assert.equal(status.requestId, accepted.requestId);
  assert(status.diagnostics.includes('PROCESSING_COLLECTION_BUSY'));
  assert.equal(other.dispatches, 0); gate.resolve();
});


test('shortcut process and cancel preserve standalone claims and drafts without verified native ownership', async t => {
  for (const proposed of [false, true]) await t.test(proposed ? 'draft' : 'claim', async t => {
    const f = await processingFixture(t);
    const { prepareProcessing } = await import('./processing.mjs');
    const claim = proposed ? await proposedClaim(f) : await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
    const h = await harness(t, f);
    const process = body(await h.call('process_selected_captures', { collectionId: f.collection.id }));
    assert.equal(process.nextAction, proposed ? 'review' : 'inspect');
    if (!proposed) assert.deepEqual(process.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    const cancelled = await h.call('processing_cancel', { collectionId: f.collection.id });
    assert.equal(cancelled.error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
    assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
    assert.equal(h.dispatches, 0); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

test('MCP resume and cancel preserve a standalone claim in the shortcut workset', async t => {
  const f = await processingFixture(t);
  const { selectProcessingShortcut, inspectProcessingShortcut } = await import('./processing-shortcuts.mjs');
  const { prepareWorksetBatch } = await import('./processing-workset.mjs');
  const chosen = await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID() });
  const workset = chosen.worksets[0];
  const claim = await prepareWorksetBatch(f.capability, { worksetId: workset.worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  const h = await harness(t, f);
  const resumed = body(await h.call('processing_resume', { collectionId: f.collection.id }));
  assert.deepEqual(resumed.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
  assert.equal(resumed.nextAction, 'inspect');
  const cancelled = await h.call('processing_cancel', { collectionId: f.collection.id });
  assert.equal(cancelled.error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
  assert.equal((await inspectProcessing(f.capability, claim.operationId)).claimHash, claim.claimHash);
  assert.equal((await inspectProcessingShortcut(f.capability, { selection: f.selection })).checkpointHash, chosen.checkpointHash);
  assert.equal(h.dispatches, 0); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('routine intake contention does not block read-only inventory or review discovery', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const lock = path.join(f.collection.intakeStateDir, '.intake-lock'); await fs.mkdir(lock, { mode: 0o700 });
  try {
    const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
    assert.equal(status.statusDetail, 'pending'); assert.equal(status.nextAction, 'process');
    assert.deepEqual(status.diagnostics, []);
    const review = body(await h.call('processing_review', { collectionId: f.collection.id }));
    assert.equal(review.statusDetail, 'pending'); assert.equal(h.forms.length, 0);
    assert.equal((await h.call('process_selected_captures', {})).error.data.code, 'INTAKE_BLOCKED');
  } finally { await fs.rmdir(lock); }
});

test('MCP review offers a healthy replacement while another retained draft lacks its source selection', async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  const other = await processingFixture(t, { base: f });
  await proposedClaim(other, { name: 'meetings/second.md' });
  await replaceProcessingStorage(f.collection.intakeStateDir);
  f.capability = await verifyWorkflowStorage(f.options);
  f.store = await openWorkflowIntake(f.capability, f.selection, 'collect');
  const { previewProcessingReinspection, reinspectProcessing, readProcessingPage, acknowledgeProcessingPages, proposeProcessing } = await import('./processing.mjs');
  const request = { ...f.args, replacementOperationId: randomUUID(), expectedClaimHash: proposal.claimHash, expectedProposalHash: proposal.proposalHash };
  const preview = await previewProcessingReinspection(f.capability, request);
  const transfer = await reinspectProcessing(f.capability, { ...request, expectedPreviewHash: preview.previewHash });
  const args = { selection: f.selection, operationId: transfer.replacementOperationId };
  let claim = (await inspectProcessing(f.capability, args.operationId)).claim;
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await readProcessingPage(f.capability, { ...args, expectedClaimHash: claim.claimHash, page });
    claim = await acknowledgeProcessingPages(f.capability, { ...args, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  await proposeProcessing(f.capability, { ...args, expectedClaimHash: claim.claimHash, proposal: transfer.proposal });
  await fs.unlink(path.join(f.collection.intakeStateDir, 'sessions', other.identity.client, `${other.identity.sessionId}.json`));
  const h = await harness(t, f);
  const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(status.status, 'awaiting-review'); assert.equal(status.nextAction, 'review');
  const next = h.nextForm(), review = h.call('processing_review', { collectionId: f.collection.id });
  const form = await next;
  assert(form.params.requestedSchema.properties.changes.default.includes('Keep the rollout paused.'));
  h.answer(form, { action: 'accept', content: { decision: 'save' } });
  body(await review);
  assert.equal((await inspectProcessing(f.capability, args.operationId)).outcome, 'saved');
  assert.equal((await inspectProcessing(f.capability, other.operationId)).state, 'conflicted');
});

test('status preserves execution with explicit incomplete inventory after bounded concurrent-change retries', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const pending = path.join(f.collection.intakeStateDir, 'pending.json');
  const head = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const open = fs.open.bind(fs); let reads = 0;
  const mock = t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === head && ++reads % 2 === 1) await fs.writeFile(pending, reads < 3 ? '{}' : 'null', { mode: 0o600 });
    return open(file, ...args);
  });
  try {
    const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
    assert(status.diagnostics.includes('PROCESSING_INVENTORY_INCOMPLETE'));
    assert.equal(status.inventory, undefined); assert.equal(h.dispatches, 0);
  } finally { mock.mock.restore(); await fs.rm(pending, { force: true }); }
});

test('completed selection status suggests process when fresh retained evidence is available', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = call => completeNextBatch(call, f);
  const closed = h.whenClosed(); await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  await processingFixture(t, { base: f, client: 'claude' });
  const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
  assert.equal(status.nextAction, 'process'); assert.equal(status.inventory.pending, 1); assert.equal(h.dispatches, 1);
});

test('committed capture admission still dispatches if secondary control publication fails', async t => {
  const f = await processingFixture(t), h = await harness(t, f); h.nativeSkill = true;
  const rename = fs.rename.bind(fs); let injected = false;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to).includes(`${path.sep}shortcut-controls${path.sep}`)) {
      const value = JSON.parse(await fs.readFile(from));
      if (value.response && !injected) { injected = true; throw Object.assign(new Error('synthetic publication failure'), { code: 'EIO' }); }
    }
    return rename(from, to);
  });
  const closed = h.whenClosed();
  try {
    const response = await h.call('process_selected_captures', { collectionId: f.collection.id });
    assert.equal(response.error.data.code, 'PROCESSING_CONTROL_FAILED'); await closed;
    assert.equal(injected, true); assert.equal(h.dispatches, 1);
    mock.mock.restore(); h.callId = 'call_1';
    assert.equal(body(await h.call('process_selected_captures', { collectionId: f.collection.id })).statusDetail, 'accepted');
    assert.equal(h.dispatches, 1);
  } finally { mock.mock.restore(); }
});

test('cancellation at durable shortcut response publication cannot revoke committed admission', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const rename = fs.rename.bind(fs); let injected = false;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to).includes(`${path.sep}shortcut-controls${path.sep}`)) {
      const value = JSON.parse(await fs.readFile(from));
      if (value.response && !injected) {
        injected = true; h.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    return rename(from, to);
  });
  const closed = h.whenClosed();
  try {
    const response = body(await h.call('process_selected_captures', { collectionId: f.collection.id }));
    await closed; assert.equal(injected, true); assert.equal(response.statusDetail, 'accepted'); assert.equal(h.dispatches, 1);
    mock.mock.restore(); h.callId = 'call_1';
    assert.deepEqual(body(await h.call('process_selected_captures', { collectionId: f.collection.id })), response);
  } finally { mock.mock.restore(); }
});


test('native history capacity is explicit before another shortcut turn can dispatch', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = call => completeNextBatch(call, f);
  const closed = h.whenClosed(); await h.call('process_selected_captures', {}); await closed;
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const file = path.join(directory, (await fs.readdir(directory))[0]);
  const value = JSON.parse(await fs.readFile(file));
  value.runs = Array.from({ length: 128 }, (_, index) => {
    const run = structuredClone(value.runs[0]);
    run.request.requestId = randomUUID(); run.request.inputHash = digest(`synthetic history ${index}`);
    run.native.runId = randomUUID(); run.native.inputId = randomUUID(); run.native.unitIds = [randomUUID()];
    return run;
  });
  await fs.writeFile(file, canonicalJSON(value) + '\n');
  await processingFixture(t, { base: f });
  const result = body(await h.call('process_selected_captures', {}));
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_HISTORY_FULL']);
  assert.equal(h.dispatches, 1);
  const status = body(await h.call('processing_status', {}));
  assert.deepEqual(status.diagnostics, ['PROCESSING_CHAT_HISTORY_FULL']); assert.equal(status.nextAction, 'inspect');
});

test('owned cancel tolerates operation-pin revision changes without targeting a different request', async t => {
  const f = await processingFixture(t), h = await harness(t, f), entered = deferred(), gate = deferred();
  h.release = gate.resolve; h.onInterrupt = gate.resolve;
  h.script = async call => { h.callEngine = call; entered.resolve(); await gate.promise; };
  await h.call('process_selected_captures', {}); await entered.promise;
  h.beforeStop = () => prepareFromPending(h.callEngine, f);
  const result = body(await h.call('processing_cancel', {}));
  assert.equal(result.statusDetail, 'cancelled'); assert.equal(h.interrupts, 1);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'cancelled');
});


test('unavailable frozen inputs offer safe cancellation instead of an endless inspect instruction', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  const closed = h.whenClosed(); await h.call('process_selected_captures', {}); await closed;
  const head = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const bytes = await fs.readFile(head); await fs.unlink(head);
  const status = body(await h.call('processing_status', {}));
  assert.equal(status.nextAction, 'cancel'); assert.equal(status.progress.unavailable, 1);
  assert.equal(body(await h.call('processing_cancel', {})).statusDetail, 'cancelled');
  await fs.writeFile(head, bytes, { mode: 0o600 });
  const freshClosed = h.whenClosed();
  assert.equal(body(await h.call('process_selected_captures', {})).statusDetail, 'accepted'); await freshClosed;
  assert.equal(h.dispatches, 2);
});

test('the engine enforces the draft-selector limit even for claims prepared before the queue fills', async t => {
  const { inspectedClaim } = await import('./test-support/processing-fixture.mjs');
  const f = await processingFixture(t), fixtures = [f];
  for (let i = 1; i < 6; i++) fixtures.push(await processingFixture(t, { base: f }));
  const claims = [];
  for (let i = 0; i < 5; i++) claims.push(await inspectedClaim(fixtures[i], { parallelism: 5 }));
  for (let i = 0; i < 4; i++) await proposedClaim(fixtures[i], { claim: claims[i], name: `meetings/synthetic-${i}.md` });
  claims.push(await inspectedClaim(fixtures[5], { parallelism: 5 }));
  await proposedClaim(fixtures[4], { claim: claims[4], name: 'meetings/synthetic-4.md' });
  await assert.rejects(proposedClaim(fixtures[5], { claim: claims[5], name: 'meetings/synthetic-5.md' }), { code: 'PROCESSING_PROPOSAL_QUEUE_FULL' });
  const h = await harness(t, f), ready = h.nextForm(), result = h.call('processing_review', {}), selector = await ready;
  const choices = selector.params.requestedSchema.properties.operationId.oneOf;
  assert.equal(choices.length, 5); assert(!choices.some(item => item.const === fixtures[5].operationId));
  h.answer(selector, { action: 'cancel' });
  const dismissed = body(await result); assert.equal(dismissed.status, 'awaiting-review'); assert.equal(dismissed.review, 'declined');
  assert.equal(h.dispatches, 0); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('an unauthorized draft stays intact while an authorized draft can be reviewed', async t => {
  const f = await processingFixture(t);
  const project = path.join(f.project, 'restricted'); await fs.mkdir(project);
  const b = await processingFixture(t, { base: { ...f, project } });
  const allowed = await proposedClaim(f), denied = await proposedClaim(b);
  // The retained source registration now points outside authorized projects;
  // the immutable draft still belongs to its original inspected input.
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const sourceFile = path.join(f.collection.intakeStateDir, 'sessions', b.identity.client, `${b.identity.sessionId}.json`);
  const source = JSON.parse(await fs.readFile(sourceFile)); source.source.projectRoot = outside;
  await fs.writeFile(sourceFile, canonicalJSON(source) + '\n');
  assert.equal((await inspectProcessing(f.capability, b.operationId)).state, 'awaiting-review');
  const h = await harness(t, f), status = body(await h.call('processing_status', {}));
  assert.equal(status.nextAction, 'review'); assert.equal(status.inventory.awaitingReview, 1);
  const ready = h.nextForm(), result = h.call('processing_review', {}), preview = await ready;
  assert(preview.params.requestedSchema.properties.changes.default.includes(allowed.proposalHash));
  h.answer(preview, { action: 'accept', content: { decision: 'later' } }); body(await result);
  assert.equal((await inspectProcessing(f.capability, b.operationId)).claimHash, denied.claimHash);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, allowed.claimHash);
});

test('review acknowledges its own completed draft after another host applied the outcome', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  await proposeInChat(f, h);
  await reviewProcessingProposal(f.capability, { selection: f.selection, operationId: f.operationId }, { elicit: async () => ({ action: 'accept', content: { decision: 'skip' }, preview: 'intact' }) });
  const status = body(await h.call('processing_status', {}));
  assert.notEqual(status.status, 'awaiting-review'); assert.equal(h.finishReviewCalls ?? 0, 0, 'status remains read-only');
  const reviewed = body(await h.call('processing_review', {}));
  assert.notEqual(reviewed.status, 'awaiting-review'); assert.equal(h.finishReviewCalls, 1); assert.equal(h.forms.length, 0);
  const again = body(await h.call('processing_status', {})); assert.notEqual(again.status, 'awaiting-review');
});

test('status distinguishes selection conflicts, mixed policy conflicts and genuine recovery', async () => {
  const { processingStatusView } = await import('./processing-mcp.mjs');
  const native = { state: 'idle', requestId: null, chat: null }, shortcut = { phase: 'ready', counts: { selected: 1 }, reviews: [] };
  for (const code of ['PROCESSING_REINSPECTION_REQUIRED', 'PROCESSING_OPERATION_CONFLICT']) {
    const blocked = processingStatusView({ ...native, state: 'blocked', diagnostics: [code] }, shortcut);
    assert.equal(blocked.status, 'blocked'); assert.equal(blocked.nextAction, 'inspect');
    assert.deepEqual(blocked.diagnostics, [code]);
  }
  for (const blockers of [['PROCESSING_INPUT_CHANGED'], ['PROCESSING_INPUT_ALREADY_HANDLED'], ['WORKFLOW_POLICY_CHANGED', 'PROCESSING_HEAD_CHANGED']]) {
    const status = processingStatusView(native, { ...shortcut, blockers });
    assert.equal(status.nextAction, 'cancel'); assert(!status.diagnostics.includes('PROCESSING_RECOVERY_REQUIRED'));
  }
  const recovery = processingStatusView(native, { ...shortcut, blockers: ['PROCESSING_INPUT_CHANGED', 'WRITER_RECOVERY_REQUIRED'] });
  assert.equal(recovery.nextAction, 'inspect'); assert.deepEqual(recovery.diagnostics, ['PROCESSING_RECOVERY_REQUIRED']);
});

test('cancel drains a checkpoint transition before pinning its target and cannot cancel a later request on replay', async t => {
  const { selectProcessingShortcut } = await import('./processing-shortcuts.mjs');
  const f = await processingFixture(t);
  await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID() });
  const h = await harness(t, f), entered = deferred(), release = deferred(); h.release = release.resolve;
  h.script = call => completeNextBatch(call, f);
  const rename = fs.rename.bind(fs); let transition = false, arriving;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to).includes(`${path.sep}processed${path.sep}shortcuts${path.sep}`)) {
      const value = JSON.parse(await fs.readFile(from));
      if (value.phase === 'discovering' && !transition) { transition = true; entered.resolve(); await release.promise; }
    }
    return rename(from, to);
  });
  const closed = h.whenClosed();
  // The pre-existing selection completes, then this process request starts its
  // fresh bounded selection. Hold that publication while Cancel arrives.
  await h.call('process_selected_captures', {}); await entered.promise;
  arriving = h.call('processing_cancel', {});
  await new Promise(resolve => setTimeout(resolve, 30)); release.resolve();
  const cancelled = body(await arriving); await closed; mock.mock.restore();
  assert(transition); assert.equal(cancelled.statusDetail, 'cancelled'); assert.equal(h.dispatches, 1);
  await processingFixture(t, { base: f });
  h.script = async call => call('processing_pending', {});
  const nextClosed = h.whenClosed(); await h.call('process_selected_captures', {}); await nextClosed;
  h.callId = 'call_2'; assert.deepEqual(body(await h.call('processing_cancel', {})), cancelled);
  assert.equal(h.dispatches, 2);
});

for (const failure of ['abandoned', 'not-dispatched']) for (const tool of ['processing_resume', 'process_selected_captures']) {
  test(`MCP ${tool} restarts ${failure} execution without replacing its frozen workset`, async t => {
    const f = await processingFixture(t), h = await harness(t, f);
    h.callId = 'original-call';
    if (failure === 'not-dispatched') h.createError = Object.assign(new Error('synthetic unavailable client'), {
      code: 'PROCESSING_CLIENT_UNAVAILABLE', outcome: 'not-dispatched' });
    else h.script = async () => { throw new Error('synthetic lost terminal'); };
    const failedClosed = h.whenClosed();
    await h.call('process_selected_captures', { collectionId: f.collection.id });
    await failedClosed;
    const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
      env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
    });
    t.after(() => controller.close());
    let before = await controller.status();
    assert.equal(before.state, failure === 'abandoned' ? 'blocked' : 'idle');
    const retiredSession = before.chat?.sessionId;
    if (failure === 'abandoned') before = await controller.abandon({
      expectedChatHash: before.chatHash, requestId: before.requestId, offline: true });
    before = await controller.status();
    assert.equal(before.restartSupported, true);
    assert.equal(before.chat, null); assert.equal(before.requestId, null);
    if (failure === 'abandoned') {
      await h.call('process_selected_captures', { collectionId: f.collection.id });
      assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
      assert.equal((await controller.status()).chatHash, before.chatHash);
    }
    const frozen = (await inspectProcessingShortcut(f.capability, { selection: f.selection })).worksets[0];
    assert.equal(frozen.inputCounts.unattempted, 1);
    h.callId = 'retired-status';
    const status = body(await h.call('processing_status', { collectionId: f.collection.id }));
    assert.equal(status.status, 'idle'); assert.equal(status.nextAction, 'resume');
    assert(!status.diagnostics.includes('PROCESSING_CHAT_OUTCOME_UNKNOWN'));
    assert(!status.diagnostics.includes('PROCESSING_CLIENT_UNAVAILABLE'));
    const dispatches = h.dispatches;
    h.createError = null; h.script = async call => call('processing_pending', {});
    h.callId = 'fresh-call';
    const retryClosed = h.whenClosed();
    const admitted = body(await h.call(tool, { collectionId: f.collection.id }));
    assert.equal(admitted.statusDetail, 'accepted');
    await retryClosed;
    const after = await controller.status();
    assert.equal(after.state, 'idle'); assert.equal(after.restartSupported, false);
    assert.equal(h.creates, 2); assert.equal(h.resumes, 0); assert.equal(h.dispatches, dispatches + 1);
    assert.notEqual(after.chat.sessionId, retiredSession);
    assert.equal(after.worksetId, frozen.worksetId);
    assert.equal(after.workset.worksetHash, frozen.worksetHash);
    assert.deepEqual(after.workset.inputs, frozen.inputs);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    // Exact native call replay must not dispatch again after successful retry.
    await h.call(tool, { collectionId: f.collection.id });
    assert.equal(h.dispatches, dispatches + 1);
  });
}

for (const phase of ['creation', 'dispatch']) test(`MCP refuses unknown ${phase} outcome without labelling it busy`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  if (phase === 'creation') h.createError = Object.assign(new Error('synthetic lost creation'), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
  else h.script = async () => { throw new Error('synthetic lost terminal'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  const creates = h.creates, dispatches = h.dispatches;
  for (const tool of ['processing_resume', 'process_selected_captures']) {
    const result = body(await h.call(tool, { collectionId: f.collection.id }));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_OUTCOME_UNKNOWN']);
    assert.equal(h.creates, creates); assert.equal(h.dispatches, dispatches);
  }
});

for (const foreign of [false, true]) test(`MCP retired unpinned workset preserves ${foreign ? 'foreign' : 'own'} reservation diagnostics`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', {}); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  assert.equal(retired.operationId, null); assert(retired.worksetId);
  const frozen = (await inspectProcessingShortcut(f.capability, { selection: f.selection })).worksets[0];
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const registry = path.join(directory, (await fs.readdir(directory))[0]), stored = await fs.readFile(registry);
  const reservation = path.join(f.collection.notes.writerStateDir, 'reinspection.json');
  const bytes = foreign ? canonicalJSON({ preview: { binding: { collectionId: 'other' } } }) + '\n' : '{}\n';
  await fs.writeFile(reservation, bytes, { mode: 0o600 });
  const code = foreign ? 'PROCESSING_RECOVERY_REQUIRED' : 'PROCESSING_REINSPECTION_REQUIRED';
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const result = body(await h.call(tool, {}));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert.deepEqual(result.diagnostics, [code]);
    assert.equal(result.chat, null); assert.equal(result.requestId, null);
    assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
    assert.deepEqual(await fs.readFile(registry), stored);
    assert.equal(await fs.readFile(reservation, 'utf8'), bytes);
  }
  await fs.unlink(reservation);
  const clear = body(await h.call('processing_status', {}));
  assert.equal(clear.status, 'idle'); assert.equal(clear.nextAction, 'resume');
  assert.deepEqual(clear.diagnostics, []);
  const after = (await inspectProcessingShortcut(f.capability, { selection: f.selection })).worksets[0];
  assert.equal(after.worksetHash, frozen.worksetHash); assert.deepEqual(after.inputs, frozen.inputs);
  assert.deepEqual(await fs.readFile(registry), stored);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

for (const beforePin of [false, true]) test(`MCP retired execution exposes the ${beforePin ? 'unpinned' : 'pinned'} claim blocker without relaunch or claim changes`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  let pinFailed = false;
  h.script = async call => {
    if (beforePin) {
      const rename = fs.rename;
      const mock = t.mock.method(fs, 'rename', async (from, to) => {
        if (path.dirname(to) === path.join(f.collection.intakeStateDir, 'processing-chats')) {
          const next = JSON.parse(await fs.readFile(from, 'utf8'));
          if (next.state === 'busy' && next.active.operationId === f.operationId) {
            pinFailed = true; mock.mock.restore();
            throw Object.assign(new Error('synthetic controller loss before operation pin'), { code: 'EIO' });
          }
        }
        return rename(from, to);
      });
    }
    await prepareFromPending(call, f); throw new Error('synthetic lost terminal after claim');
  };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  assert.equal(pinFailed, beforePin);
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const claim = await inspectProcessing(f.capability, f.operationId);
  for (const tool of ['processing_status', 'processing_review', 'processing_resume', 'process_selected_captures']) {
    const result = body(await h.call(tool, { collectionId: f.collection.id }));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert.deepEqual(result.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    assert.equal(h.creates, 1); assert.equal(h.dispatches, 1);
    assert.equal((await controller.status()).chatHash, retired.chatHash);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  }
  assert.equal((await h.call('processing_cancel', {})).error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.equal(h.forms.length, 0); assert.equal(h.dispatches, 1);
  const peer = await harness(t, f, { controllerIdentity: { hostId: digest('synthetic-peer-host') } });
  peer.callId = 'distinct-peer-call';
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const result = body(await peer.call(tool, { collectionId: f.collection.id }));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert(result.diagnostics.includes('PROCESSING_COLLECTION_BUSY'));
    assert.equal(peer.creates, 0); assert.equal(peer.dispatches, 0);
    assert.equal((await controller.status()).chatHash, retired.chatHash);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  }
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});


for (const damage of ['missing', 'corrupt']) test(`MCP reports a blocked retired peer with ${damage} workset metadata without leaking its inspection error`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
  // A standalone workset is independent of the collection shortcut checkpoint.
  const worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
  const controller = await h.openController({ ...f.options, client: 'codex' });
  t.after(() => controller.close());
  await assert.rejects(controller.run({ requestId: randomUUID(), selection: f.selection, worksetId, expectedChatHash: null }));
  const failed = await controller.status();
  await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const registry = path.join(directory, (await fs.readdir(directory))[0]), stored = await fs.readFile(registry);
  const workset = path.join(f.collection.notes.writerStateDir, 'processed', 'worksets', `${failed.worksetId}.json`);
  const original = await fs.readFile(workset);
  if (damage === 'missing') await fs.unlink(workset);
  else await fs.writeFile(workset, 'null\n');
  const peer = await harness(t, f, { controllerIdentity: { hostId: digest('synthetic-peer-host') } });
  peer.callId = 'distinct-peer-call';
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const result = body(await peer.call(tool, {}));
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, 'inspect');
    assert.deepEqual(result.diagnostics, ['PROCESSING_COLLECTION_BUSY']);
  }
  assert.equal((await peer.call('processing_cancel', {})).error.data.code, 'PROCESSING_CANCEL_UNVERIFIED');
  assert.equal(peer.creates, 0); assert.equal(peer.dispatches, 0); assert.equal(peer.forms.length, 0);
  assert.deepEqual(await fs.readFile(registry), stored);
  if (damage === 'missing') await assert.rejects(fs.readFile(workset), { code: 'ENOENT' });
  else assert.equal(await fs.readFile(workset, 'utf8'), 'null\n');
  // Repairing only the synthetic metadata must be observed on the next call.
  await fs.writeFile(workset, original, { mode: 0o600 });
  const healthy = body(await peer.call('processing_status', {}));
  assert.notEqual(healthy.status, 'blocked'); assert.deepEqual(healthy.diagnostics, []);
  assert.deepEqual(await fs.readFile(registry), stored);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

for (const failure of ['abandoned', 'not-dispatched']) test(`MCP review and cancel of ${failure} workset have no retired identifiers or errors`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  if (failure === 'not-dispatched') h.createError = Object.assign(new Error('synthetic unavailable client'), {
    code: 'PROCESSING_CLIENT_UNAVAILABLE', outcome: 'not-dispatched' });
  else h.script = async () => { throw new Error('synthetic lost terminal'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', {}); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  if (failure === 'abandoned') await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const retired = await controller.status();
  const before = await inspectProcessingShortcut(f.capability, { selection: f.selection });
  for (const tool of ['processing_status', 'processing_review', 'processing_cancel', 'processing_status', 'processing_review']) {
    const result = body(await h.call(tool, {}));
    assert.equal(result.status, 'idle'); assert.deepEqual(result.diagnostics, []);
    assert.equal(result.chat, null); assert.equal(result.requestId, null);
    if (tool === 'processing_cancel') assert.equal(result.statusDetail, 'cancelled');
  }
  const after = await inspectProcessingShortcut(f.capability, { selection: f.selection });
  assert.equal(after.phase, 'cancelled');
  assert.deepEqual(after.worksets, before.worksets);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.equal(h.forms.length, 0); assert.equal(h.creates, 1);
  assert.equal(h.dispatches, failure === 'abandoned' ? 1 : 0);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('MCP retired peer proposal offers review while blocking new execution and preserves later conflicts', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => { await proposeThroughTools(f)(call); throw new Error('synthetic lost terminal after proposal'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', {}); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const claim = await inspectProcessing(f.capability, f.operationId);
  const peer = await harness(t, f, { controllerIdentity: { hostId: digest('synthetic-peer-host') } });
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const status = body(await peer.call(tool, {}));
    assert.equal(status.status, 'awaiting-review'); assert.equal(status.nextAction, 'review');
    assert.equal(status.chat, null); assert.equal(status.requestId, null);
  }
  const ready = peer.nextForm(), review = peer.call('processing_review', {}), form = await ready;
  assert(form.params.requestedSchema.properties.changes.default.includes(claim.proposalHash));
  peer.answer(form, { action: 'accept', content: { decision: 'later' } });
  assert.equal(body(await review).status, 'awaiting-review');
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  const file = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const headBytes = await fs.readFile(file), head = JSON.parse(headBytes);
  await fs.writeFile(file, canonicalJSON({ ...head, generation: head.generation + 1, previousHash: digest(headBytes) }) + '\n');
  const conflict = body(await peer.call('processing_status', {}));
  assert.equal(conflict.status, 'blocked'); assert.equal(conflict.nextAction, 'inspect');
  await completeProcessing(f.capability, { selection: f.selection, operationId: f.operationId, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
  const settledPeer = await peer.openController({ ...f.options, client: 'codex' });
  try { assert.deepEqual(await settledPeer.collectionActivity(), []); }
  finally { await settledPeer.close(); }
  // Disposing the claim does not refresh the frozen checkpoint's old input.
  const frozen = body(await peer.call('processing_status', {}));
  assert.equal(frozen.status, 'blocked'); assert.equal(frozen.nextAction, 'cancel');
  assert.deepEqual(frozen.diagnostics, ['PROCESSING_SELECTION_CHANGED']);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.equal(peer.creates, 0); assert.equal(peer.dispatches, 0); assert.equal(h.dispatches, 1);
  assert.equal(peer.finishReviewCalls ?? 0, 0);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

for (const completion of ['save', 'external']) test(`MCP retired proposal supports Later then ${completion} completion without native review acknowledgement`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async call => { await proposeThroughTools(f)(call); throw new Error('synthetic lost terminal after proposal'); };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', {}); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const claim = await inspectProcessing(f.capability, f.operationId);
  const status = body(await h.call('processing_status', {}));
  assert.equal(status.status, 'awaiting-review'); assert.equal(status.nextAction, 'review');
  assert.deepEqual(status.diagnostics, []); assert.equal(status.chat, null); assert.equal(status.requestId, null);
  const next = h.nextForm(), review = h.call('processing_review', {});
  const form = await next;
  assert(form.params.requestedSchema.properties.changes.default.includes(claim.proposalHash));
  h.answer(form, { action: 'accept', content: { decision: 'later' } });
  const result = body(await review);
  assert.equal(result.status, 'awaiting-review'); assert.deepEqual(result.diagnostics, []);
  assert.equal(result.chat, null); assert.equal(result.requestId, null);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal(h.dispatches, 1); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  if (completion === 'save') {
    const ready = h.nextForm(), save = h.call('processing_review', {});
    h.answer(await ready, { action: 'accept', content: { decision: 'save' } });
    const saved = body(await save);
    assert.equal(saved.status, 'idle'); assert.equal(saved.nextAction, 'none'); assert.deepEqual(saved.diagnostics, []);
    assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meetings/rollout.md'), 'utf8'), draft);
  } else {
    // The engine can finish after native status inspection, before the MCP
    // layer checks completion. A retired row has no terminal review to ack.
    h.inspectOperation = async operationId => {
      const operation = await inspectProcessing(f.capability, operationId);
      h.inspectOperation = null;
      await reviewProcessingProposal(f.capability, { selection: f.selection, operationId },
        { elicit: async () => ({ action: 'accept', content: { decision: 'skip' }, preview: 'intact' }) });
      return operation;
    };
    const completed = body(await h.call('processing_status', {}));
    assert.equal(completed.status, 'idle'); assert.equal(completed.nextAction, 'none');
    assert.deepEqual(completed.diagnostics, []);
    assert.equal(body(await h.call('processing_review', {})).status, 'idle');
  }
  assert.equal(h.finishReviewCalls ?? 0, 0);
  assert.equal((await controller.status()).state, 'idle');
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.equal(h.dispatches, 1);
});

for (const retainedClaim of [false, true]) test(`MCP retired binding ${retainedClaim ? 'with terminal-owned claim' : 'without claim'} reports a competing active namespace without relaunch`, async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  if (retainedClaim) {
    h.script = async call => prepareFromPending(call, f);
    const firstClosed = h.whenClosed();
    await h.call('process_selected_captures', {}); await firstClosed;
  }
  h.script = async call => {
    if (retainedClaim) {
      const claim = await call('processing_status', { operationId: f.operationId });
      await call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page: 0 });
    }
    throw new Error('synthetic lost terminal');
  };
  const closed = h.whenClosed();
  await h.call('process_selected_captures', { collectionId: f.collection.id }); await closed;
  const controller = await openProcessingController({ ...f.options, client: 'codex' }, {
    env: {}, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host')
  });
  t.after(() => controller.close());
  const failed = await controller.status();
  const retired = await controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  assert.equal(retired.state, 'idle');
  const claim = await inspectProcessing(f.capability, f.operationId), dispatches = h.dispatches;
  if (retainedClaim) {
    assert.equal(retired.operationId, f.operationId);
    assert.equal(await controller.canResumeOperation(f.operationId), true);
  }
  const peer = await harness(t, f, { controllerIdentity: { hostId: digest('synthetic-peer-host') } });
  const gate = deferred(); peer.release = gate.resolve; peer.script = async () => gate.promise;
  peer.callId = 'distinct-peer-call';
  const peerClosed = peer.whenClosed();
  const admitted = body(await peer.call('process_selected_captures', { collectionId: f.collection.id }));
  assert.equal(admitted.statusDetail, 'accepted');
  for (const tool of ['processing_status', 'processing_resume', 'process_selected_captures']) {
    const result = body(await h.call(tool, { collectionId: f.collection.id }));
    assert.equal(result.status, 'busy'); assert.equal(result.nextAction, 'wait');
    assert(result.diagnostics.includes('PROCESSING_COLLECTION_BUSY'));
    assert.equal(result.chat.sessionId, admitted.chat.sessionId);
    assert.equal(h.creates, 1); assert.equal(h.dispatches, dispatches);
    assert.equal((await controller.status()).chatHash, retired.chatHash);
  }
  assert.equal(await controller.canResumeOperation(f.operationId), false);
  await assert.rejects(controller.run({ requestId: randomUUID(), selection: f.selection,
    expectedChatHash: retired.chatHash, ...(retainedClaim ? { resumeOperationId: f.operationId } : {}) }), { code: 'PROCESSING_COLLECTION_BUSY' });
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal((await controller.status()).chatHash, retired.chatHash);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  gate.resolve(); await peerClosed;
  if (retainedClaim) {
    assert.equal(await controller.canResumeOperation(f.operationId), true);
    const status = body(await h.call('processing_status', {}));
    assert.equal(status.status, 'idle'); assert.equal(status.nextAction, 'resume');
    assert.deepEqual(status.diagnostics, []);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  }
});
