import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, proposedClaim, inspectedClaim } from './test-support/processing-fixture.mjs';
import { body, harness } from './test-support/processing-mcp.mjs';
import { inspectProcessing, completeProcessing, proposeProcessing } from './processing.mjs';
import { reviewCode, presentReviewFiles, readReviewPresentations } from './processing-review-files.mjs';
import { readReviewPreview } from './processing-host-review.mjs';
import { REVIEW_CODE, REVIEW_COMMANDS } from './processing-control-proof.mjs';
import { fingerprint } from './safe-update.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { readSelection } from './intake-store.mjs';

const content = '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n';
const claude = REVIEW_COMMANDS.claude, codex = REVIEW_COMMANDS.codex;
const posix = process.platform !== 'win32';
const stateFile = f => path.join(f.collection.intakeStateDir, 'review-state', 'presentations.json');
const reviewState = async f => JSON.parse(await fs.readFile(stateFile(f), 'utf8'));
const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function claudeReview(t, f) {
  const h = await harness(t, f, { client: 'claude' });
  // The stub binding has no Claude receipt fields; exclusion receipts are
  // covered for Codex below and in the receipt suite.
  h.captureActive = false;
  return h;
}
const review = async (h, args = {}) => body(await h.call('processing_review', args));
// The reply is for people: no hashes, operation IDs, session IDs or codes.
function assertPlainReply(view, f) {
  const text = view.draft?.folder ? view.statusText.replaceAll(view.draft.folder, '<folder>') : view.statusText;
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.doesNotMatch(text, /[0-9a-f]{64}/);
  assert.doesNotMatch(text, /\b[A-Z]+_[A-Z_]+\b/);
  assert(!text.includes(f.operationId));
}
async function multiFileProposal(f, files) {
  const claim = await inspectedClaim(f), request = { files: [], mappings: [{ identity: f.identity, paths: files.map(file => file.name) }] };
  for (const file of files) {
    const contentPath = path.join(f.root, `${randomUUID()}.md`); await fs.writeFile(contentPath, file.content, { mode: 0o600 });
    request.files.push({ path: file.name, expectedHash: await fingerprint(path.join(f.collection.notes.notesDir, file.name)),
      contentPath, expectedContentHash: await fingerprint(contentPath) });
  }
  return proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, proposal: request });
}

test('Claude review writes the exact proposal to a private review folder and replies with its path, size and typed commands', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const shown = await review(h);
  assert.equal(shown.review, 'presented'); assert.equal(shown.status, 'awaiting-review'); assert.equal(h.forms.length, 0);
  const code = shown.draft.code, folder = path.join(f.collection.intakeStateDir, 'review', code);
  assert.match(code, REVIEW_CODE); assert.equal(code, reviewCode(p.proposalHash));
  assert.equal(shown.draft.folder, folder);
  assert.deepEqual(shown.draft.files, [{ path: 'meetings/rollout.md', bytes: Buffer.byteLength(content), change: 'create' }]);
  // Private state only: never the notes folder or the project.
  for (const outside of [f.collection.notes.notesDir, f.project]) assert(path.relative(outside, folder).startsWith('..'));
  assert.deepEqual((await fs.readdir(folder)).sort(), ['proposed.md', 'summary.txt']);
  assert.deepEqual(await fs.readFile(path.join(folder, 'proposed.md')), Buffer.from(content));
  if (posix) {
    for (const directory of [path.dirname(folder), folder]) assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    for (const name of ['proposed.md', 'summary.txt']) assert.equal((await fs.stat(path.join(folder, name))).mode & 0o777, 0o600);
  }
  const summary = await fs.readFile(path.join(folder, 'summary.txt'), 'utf8');
  for (const expected of [`draft ${code}`, 'Create "meetings/rollout.md"', `Proposed: proposed.md (${Buffer.byteLength(content)} bytes)`,
    `claude session ${f.identity.sessionId}, turn ${f.identity.unitId}`, '1 of 1 retained evidence pages inspected',
    `${claude} review save ${code}`, `${claude} review skip ${code}`, `${claude} review later ${code}`, `${claude} review cancel ${code}`,
    `${codex} review save ${code}`, `Operation: ${f.operationId}`, `Claim hash: ${p.claimHash}`, `Proposal hash: ${p.proposalHash}`]) {
    assert(summary.includes(expected), expected);
  }
  assert(!summary.includes('Keep the rollout paused'), 'note content stays in proposed.md');
  assert(shown.statusText.startsWith(`Cuefluent: Draft ${code} is ready for review; nothing has been saved. Review folder: ${folder}\n`));
  assert(shown.statusText.includes(`- "meetings/rollout.md" (new note, ${Buffer.byteLength(content)} bytes)`));
  assert(shown.statusText.includes(`${claude} review save ${code}, ${claude} review skip ${code} or ${claude} review later ${code}`));
  assertPlainReply(shown, f);
  // The durable presentation binding names this chat and the exact revision.
  const state = await reviewState(f);
  assert.deepEqual(state.bindings.map(({ presentedAt, ...item }) => item), [{ chatLineage: { client: 'claude', sessionId: f.identity.sessionId },
    operationId: f.operationId, proposalHash: p.proposalHash, claimHash: p.claimHash, verified: true, delivered: true, typedDelivered: true }]);
  assert.deepEqual(state.recent, state.bindings);
  assert.deepEqual(state.folders, [{ code, operationId: f.operationId, proposalHash: p.proposalHash, claimHash: p.claimHash }]);
  if (posix) assert.equal((await fs.stat(stateFile(f))).mode & 0o777, 0o600);
  // Showing the same revision again rewrites nothing.
  const before = await fs.stat(path.join(folder, 'proposed.md'), { bigint: true });
  assert.equal((await review(h, { draft: code })).draft.folder, folder);
  const after = await fs.stat(path.join(folder, 'proposed.md'), { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
});

test('updates add exact current bytes, several files are numbered, and an unverified display records verified false', async t => {
  const f = await processingFixture(t, { client: 'claude' });
  const original = '# Policy\r\n\r\n## Decision\r\n\r\nOld café rule.\r\n', updated = '# Policy\r\n\r\n## Decision\r\n\r\nNew café rule.\r\n';
  await fs.writeFile(path.join(f.collection.notes.notesDir, 'policy.md'), original);
  const p = await multiFileProposal(f, [{ name: 'policy.md', content: updated }, { name: 'meetings/rollout.md', content }]);
  const h = await claudeReview(t, f); // A model-initiated call: display only.
  const shown = await review(h), folder = shown.draft.folder;
  assert.equal(shown.review, 'presented');
  assert.deepEqual(shown.draft.files, [{ path: 'policy.md', bytes: Buffer.byteLength(updated), change: 'update' },
    { path: 'meetings/rollout.md', bytes: Buffer.byteLength(content), change: 'create' }]);
  assert.deepEqual((await fs.readdir(folder)).sort(), ['1-current.md', '1-proposed.md', '2-proposed.md', 'summary.txt']);
  assert.deepEqual(await fs.readFile(path.join(folder, '1-current.md')), Buffer.from(original));
  assert.deepEqual(await fs.readFile(path.join(folder, '1-proposed.md')), Buffer.from(updated));
  assert.deepEqual(await fs.readFile(path.join(folder, '2-proposed.md')), Buffer.from(content));
  const summary = await fs.readFile(path.join(folder, 'summary.txt'), 'utf8');
  assert(summary.includes('1. Update "policy.md"') && summary.includes('Current: 1-current.md') && summary.includes('2. Create "meetings/rollout.md"'));
  assert(summary.includes(`Proposal hash: ${p.proposalHash}`));
  assert.equal((await reviewState(f)).bindings[0].verified, false);
  assert(shown.statusText.includes(`- "policy.md" (update, ${Buffer.byteLength(updated)} bytes)`));
  assertPlainReply(shown, f);
});

test('a large proposal stays within the reply and receipt bounds while summary.txt keeps every full path', async t => {
  const f = await processingFixture(t, { client: 'claude' });
  // Existing nested folders (a version-1 plan) allow note paths beyond the reply
  // bound; three-byte characters keep the absolute path within Windows MAX_PATH.
  const deep = ['漢'.repeat(58), '字'.repeat(58)].join('/');
  const files = Array.from({ length: 6 }, (_, index) => ({ name: `${deep}/${'語'.repeat(55)}${index}.md`, content: `# Note ${index}\n\n## Decision\n\nKeep ${index}.\n` }));
  assert(Buffer.byteLength(files[0].name) > 512);
  if (process.platform === 'win32' && path.join(f.collection.notes.notesDir, files[0].name).length > 259) return t.skip('the temporary root leaves no room under MAX_PATH');
  await fs.mkdir(path.join(f.collection.notes.notesDir, deep), { recursive: true });
  await multiFileProposal(f, files);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const row = await h.call('processing_review', {}), shown = body(row);
  assert.equal(shown.review, 'presented'); assert.equal(shown.draft.fileCount, 6); assert.equal(shown.draft.files.length, 5);
  for (const file of shown.draft.files) { assert(Buffer.byteLength(file.path) <= 512); assert(file.path.endsWith('…')); }
  assert(shown.statusText.includes('- and 1 more files listed in summary.txt'));
  assert(Buffer.byteLength(shown.statusText) <= 4096); assert(Buffer.byteLength(JSON.stringify(row)) < 16 * 1024);
  const summary = await fs.readFile(path.join(shown.draft.folder, 'summary.txt'), 'utf8');
  for (const [index, file] of files.entries()) {
    assert(summary.includes(`${index + 1}. Create ${JSON.stringify(file.name)}`));
    assert.deepEqual(await fs.readFile(path.join(shown.draft.folder, `${index + 1}-proposed.md`)), Buffer.from(file.content));
  }
});

test('typed decisions need a verified command and a presentation to this chat; Save writes exact bytes and removes the folder', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const h = await claudeReview(t, f);
  // A decision for a draft this chat never saw applies nothing.
  h.nativeSkill = true;
  const code = reviewCode(p.proposalHash);
  const unseen = await review(h, { decision: 'save', draft: code });
  assert.equal(unseen.review, 'not-shown'); assert.equal(unseen.status, 'awaiting-review');
  assert.equal(unseen.statusText, `Cuefluent: Nothing was applied: draft ${code} has not been shown in this chat by a typed review. Read it first with ${claude} review ${code}.`);
  const shown = await review(h), folder = shown.draft.folder;
  // Model-chosen decision fields are not an approval channel.
  h.nativeSkill = false;
  const model = await review(h, { decision: 'save', draft: code });
  assert.equal(model.review, 'unverified'); assertPlainReply(model, f);
  h.nativeSkill = true;
  assert.equal((await review(h, { decision: 'save', draft: 'k2mn9p' })).review, 'not-shown');
  const later = await review(h, { decision: 'later', draft: code });
  assert.equal(later.review, 'deferred'); assert.equal(later.statusText, 'Cuefluent: Review deferred with Later. The draft remains pending; nothing was saved.');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []); assert(await exists(folder));
  // An editor's swap file is not this module's to delete; it keeps the folder.
  await fs.writeFile(path.join(folder, '.proposed.md.swp'), 'editor state', { mode: 0o600 });
  const saved = await review(h, { decision: 'save', draft: code });
  assert.equal(saved.review, 'saved'); assert.match(saved.statusText, /^Cuefluent: Review completed: the exact reviewed proposal was saved\./);
  assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.deepEqual(await fs.readdir(folder), ['.proposed.md.swp']);
  await fs.rm(folder, { recursive: true });
  const state = await reviewState(f);
  assert.deepEqual(state.bindings, []); assert.deepEqual(state.folders, []);
  // The decided revision is no longer bound; a bare decision still points at it.
  assert.equal((await review(h, { decision: 'save', draft: code })).review, 'not-shown');
  const bare = await review(h, { decision: 'save' });
  assert.equal(bare.review, 'changed'); assert.notEqual(bare.status, 'awaiting-review');
  assert.equal(h.dispatches, 0);
});

test('a replaced revision needs a fresh verified review: bare save and the old code are refused', async t => {
  const f = await processingFixture(t, { client: 'claude' }), a = await proposedClaim(f);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const shownA = await review(h), codeA = shownA.draft.code;
  // Revision B replaces A: A's operation is cancelled and the same captures are drafted again.
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: a.claimHash, outcome: 'cancelled' });
  f.operationId = randomUUID(); f.args = { ...f.args, operationId: f.operationId };
  const contentB = '# Rollout meeting\n\n## Decision\n\nResume the rollout on Monday.\n';
  const b = await proposedClaim(f, { content: contentB }), codeB = reviewCode(b.proposalHash);
  assert.notEqual(codeB, codeA);
  // B's folder comes from an unverified display (a natural-language request).
  h.nativeSkill = false;
  const shownB = await review(h);
  assert.equal(shownB.review, 'presented'); assert.equal(shownB.draft.code, codeB);
  // A's folder is gone with its revision; its binding remains to report the change.
  assert.equal(await exists(shownA.draft.folder), false);
  assert.deepEqual((await reviewState(f)).bindings.map(item => [reviewCode(item.proposalHash), item.verified]), [[codeA, true], [codeB, false]]);
  h.nativeSkill = true;
  const bare = await review(h, { decision: 'save' });
  assert.equal(bare.review, 'unresolved');
  assert.deepEqual(bare.drafts, [{ code: codeB, path: 'meetings/rollout.md', fileCount: 1 }]);
  assert(bare.statusText.includes(`Pending drafts: ${codeB} "meetings/rollout.md".`)); assertPlainReply(bare, f);
  // Naming B's code does not bypass the typed review: B's only display was unverified.
  const coded = await review(h, { decision: 'save', draft: codeB });
  assert.equal(coded.review, 'not-shown'); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  const old = await review(h, { decision: 'save', draft: codeA });
  assert.equal(old.review, 'changed'); assert.equal(old.draft.code, codeA);
  assert.deepEqual((await reviewState(f)).bindings.map(item => reviewCode(item.proposalHash)), [codeB]);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  // A verified review of B makes the bare decision resolve to B.
  assert.equal((await review(h, { draft: codeB })).review, 'presented');
  const saved = await review(h, { decision: 'save' });
  assert.equal(saved.review, 'saved');
  assert.deepEqual(await fs.readFile(b.target), Buffer.from(contentB));
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
});

test('bare decisions never pick the only draft and refuse an unverified latest display', async t => {
  await t.test('no pending drafts', async t => {
    const f = await processingFixture(t, { client: 'claude' });
    const h = await claudeReview(t, f); h.nativeSkill = true;
    const bare = await review(h, { decision: 'skip' });
    assert.equal(bare.review, 'unresolved'); assert.deepEqual(bare.drafts, []);
    assert(bare.statusText.endsWith('\nNo drafts are pending.'));
    assert.equal(await exists(stateFile(f)), false);
  });
  await t.test('two pending drafts', async t => {
    const f = await processingFixture(t, { client: 'claude' }), g = await processingFixture(t, { client: 'claude', base: f });
    const claims = [await inspectedClaim(f, { parallelism: 2 }), await inspectedClaim(g, { parallelism: 2 })];
    const first = await proposedClaim(f, { claim: claims[0], name: 'meetings/first.md' });
    const second = await proposedClaim(g, { claim: claims[1], name: 'meetings/second.md' });
    const codes = [reviewCode(first.proposalHash), reviewCode(second.proposalHash)];
    const h = await claudeReview(t, f); h.nativeSkill = true;
    const none = await review(h, { decision: 'save' });
    assert.equal(none.review, 'unresolved');
    assert.deepEqual(none.drafts.map(item => item.code).sort(), [...codes].sort());
    // Even the only draft shown, if shown by an unverified display, is not a bare target.
    h.nativeSkill = false; assert.equal((await review(h, { draft: codes[0] })).review, 'presented');
    h.nativeSkill = true; assert.equal((await review(h, { decision: 'save' })).review, 'unresolved');
    assert.equal((await review(h, { decision: 'save', draft: codes[0] })).review, 'not-shown');
    const shown = await review(h, { draft: codes[1] });
    assert.equal(shown.review, 'presented'); assert.deepEqual(shown.drafts, [{ code: codes[0], path: 'meetings/first.md', fileCount: 1 }]);
    assert.equal((await review(h, { decision: 'skip' })).review, 'skipped');
    assert.equal((await inspectProcessing(f.capability, g.operationId)).outcome, 'skipped');
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
});

test('a verified continuation keeps the chat lineage: a bare decision after the move applies the draft typed-reviewed before it', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const origin = f.identity.sessionId, successor = randomUUID(), other = randomUUID();
  // The real binding supplies chatLineage only for a link verified from both
  // registered transcripts (claude-session-lifecycle tests); this stub stands in.
  let chat = { sessionId: origin, lineage: null }, h;
  h = await harness(t, f, { client: 'claude', async resolveInvocation(capability, context, invocation) {
    const selected = await readSelection(f.store, { client: 'claude', sessionId: origin });
    return Object.freeze({ source: f.source, selection: { ...f.selection, sessionId: chat.sessionId }, selectionHash: selected.hash,
      nativeSkill: h.nativeSkill, controlExclusionUnsupported: false, unitId: f.identity.unitId, argsHash: digest(canonicalJSON(invocation.arguments)),
      captureActive: false, tool: `mcp__cuefluent_control.${invocation.tool}`, callId: context.toolCallId,
      ...(chat.lineage ? { chatLineage: { client: 'claude', sessionId: chat.lineage } } : {}) });
  } });
  h.nativeSkill = true;
  const shown = await review(h), code = shown.draft.code;
  assert.equal(shown.review, 'presented');
  assert.deepEqual((await reviewState(f)).recent.map(item => item.chatLineage), [{ client: 'claude', sessionId: origin }]);
  // Another chat, even in the same project, was never shown the draft.
  chat = { sessionId: other, lineage: null };
  assert.equal((await review(h, { decision: 'save' })).review, 'unresolved');
  assert.equal((await review(h, { decision: 'save', draft: code })).review, 'not-shown');
  // The continued session shares the origin's lineage, so its latest typed review counts.
  chat = { sessionId: successor, lineage: origin };
  const saved = await review(h, { decision: 'save' });
  assert.equal(saved.review, 'saved');
  assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  const state = await reviewState(f);
  assert.deepEqual(state.bindings, []);
  assert.deepEqual(state.recent.map(item => item.chatLineage), [{ client: 'claude', sessionId: origin }]);
});

test('a presentation counts only once its reply is committed; an unconfirmed one is never a decision target', async t => {
  const f = await processingFixture(t, { client: 'claude' }), g = await processingFixture(t, { client: 'claude', base: f });
  const claims = [await inspectedClaim(f, { parallelism: 2 }), await inspectedClaim(g, { parallelism: 2 })];
  const a = await proposedClaim(f, { claim: claims[0], name: 'meetings/first.md' });
  // Separate folders: saving A must not change B's expected destination.
  const b = await proposedClaim(g, { claim: claims[1], name: 'tasks/second.md' });
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const codeA = reviewCode(a.proposalHash), codeB = reviewCode(b.proposalHash);
  assert.equal((await review(h, { draft: codeA })).draft.code, codeA);
  // B's review is interrupted after its folder and record are written, before
  // its reply commits: the same state as a cancelled or failed request.
  const lineage = { client: 'claude', sessionId: f.identity.sessionId };
  const preview = await readReviewPreview(f.capability, { selection: g.selection, operationId: g.operationId });
  await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage: lineage, verified: true });
  const state = await reviewState(f);
  assert.deepEqual(state.bindings.map(item => [reviewCode(item.proposalHash), item.verified, item.delivered, item.typedDelivered]),
    [[codeA, true, true, true], [codeB, true, false, false]]);
  // The unconfirmed attempt is the chat's latest, so a bare decision falls back to nothing.
  assert.equal(reviewCode(state.recent[0].proposalHash), codeB); assert.equal(state.recent[0].delivered, false);
  assert.deepEqual((await readReviewPresentations(f.capability, lineage)).bindings.map(item => reviewCode(item.proposalHash)), [codeA]);
  assert.equal((await review(h, { decision: 'save', draft: codeB })).review, 'not-shown');
  assert.equal((await review(h, { decision: 'save' })).review, 'unresolved');
  await assert.rejects(fs.stat(a.target), { code: 'ENOENT' });
  // The draft this chat did receive by a typed review stays decidable by its code.
  const saved = await review(h, { decision: 'save', draft: codeA });
  assert.equal(saved.review, 'saved');
  assert.deepEqual(await fs.readFile(a.target), Buffer.from(content));
  assert.equal((await inspectProcessing(f.capability, g.operationId)).state, 'awaiting-review');
  await assert.rejects(fs.stat(b.target), { code: 'ENOENT' });
  // Once B is shown by a reply that commits, it is decidable.
  assert.equal((await review(h, { draft: codeB })).review, 'presented');
  assert.equal((await review(h, { decision: 'skip', draft: codeB })).review, 'skipped');
});

test('a redisplay keeps the earlier typed review of the same revision', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const code = (await review(h)).draft.code;
  // A natural-language redisplay of the same revision.
  h.nativeSkill = false; assert.equal((await review(h, { draft: code })).review, 'presented');
  h.nativeSkill = true;
  const state = await reviewState(f);
  assert.deepEqual(state.bindings.map(item => [item.verified, item.delivered, item.typedDelivered]), [[false, true, true]]);
  assert.equal(state.recent[0].verified, false, 'the latest attempt is the unverified redisplay');
  assert.equal((await review(h, { decision: 'save' })).review, 'unresolved');
  assert.equal((await review(h, { decision: 'save', draft: code })).review, 'saved');
  assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
});

test('a typed review that never reached the chat cannot lend its verification to an earlier display', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const h = await claudeReview(t, f);
  // A natural-language display is delivered but not typed.
  h.nativeSkill = false; const code = (await review(h)).draft.code;
  // Then a typed review of the same revision is cut off before its reply.
  const lineage = { client: 'claude', sessionId: f.identity.sessionId };
  const preview = await readReviewPreview(f.capability, { selection: f.selection, operationId: f.operationId });
  await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage: lineage, verified: true });
  const state = await reviewState(f);
  assert.deepEqual(state.bindings.map(item => [item.verified, item.delivered, item.typedDelivered]), [[true, false, false]]);
  h.nativeSkill = true;
  assert.equal((await review(h, { decision: 'save', draft: code })).review, 'not-shown');
  assert.equal((await review(h, { decision: 'save' })).review, 'unresolved');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  // A typed review whose reply commits makes it decidable.
  assert.equal((await review(h, { draft: code })).review, 'presented');
  assert.equal((await review(h, { decision: 'save', draft: code })).review, 'saved');
  assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
});

test('summary.txt keeps every source-to-file association as file numbers and caps omission details', async t => {
  const f = await processingFixture(t, { client: 'claude' });
  const sources = Array.from({ length: 8 }, () => ({ client: 'claude', sessionId: randomUUID(), unitId: randomUUID() }));
  const proposed = '# Note\n\n## Decision\n\nKeep.\n';
  const files = [{ path: 'knowledge-base/only.md', original: null, expectedHash: null, proposed, contentHash: digest(proposed) }];
  const omissions = Array.from({ length: 60 }, (_, index) => ({ kind: 'tool-output', recordId: `record-${index}`, bytes: 4096 }));
  const preview = { operationId: randomUUID(), proposalHash: digest('synthetic proposal'), claimHash: digest('synthetic claim'),
    files, createDirectories: ['knowledge-base'], mappings: sources.map(identity => ({ identity, paths: ['knowledge-base/only.md'] })),
    sourceCoverage: sources.map(identity => ({ identity, terminal: 'unconfirmed', partial: true, omissions })),
    inspection: { acknowledgedPages: 8, totalPages: 8 } };
  const shown = await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage: { client: 'claude', sessionId: f.identity.sessionId }, verified: true });
  const summary = await fs.readFile(path.join(shown.folder, 'summary.txt'), 'utf8');
  assert.equal((summary.match(/^  and 55 more omissions$/gm) ?? []).length, 8);
  assert.equal((summary.match(/^  Omitted: /gm) ?? []).length, 40);
  assert.equal((summary.match(/^  Used in: file 1$/gm) ?? []).length, 8);
  assert(Buffer.byteLength(summary) < 64 * 1024);
});

test('summary.txt stays bounded when many sources map to many notes', async t => {
  const f = await processingFixture(t, { client: 'claude' });
  const sources = Array.from({ length: 20 }, () => ({ client: 'claude', sessionId: randomUUID(), unitId: randomUUID() }));
  const files = Array.from({ length: 80 }, (_, index) => {
    const proposed = `# Note ${index}\n\n## Decision\n\nKeep ${index}.\n`;
    return { path: `knowledge-base/${'topic-'.repeat(20)}${index}.md`, original: null, expectedHash: null, proposed, contentHash: digest(proposed) };
  });
  const preview = { operationId: randomUUID(), proposalHash: digest('synthetic proposal'), claimHash: digest('synthetic claim'),
    files, createDirectories: ['knowledge-base'], mappings: sources.map(identity => ({ identity, paths: files.map(file => file.path) })),
    sourceCoverage: sources.map(identity => ({ identity, terminal: 'unconfirmed', partial: true, omissions: [] })),
    inspection: { acknowledgedPages: 20, totalPages: 20 } };
  const shown = await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage: { client: 'claude', sessionId: f.identity.sessionId }, verified: true });
  const summary = await fs.readFile(path.join(shown.folder, 'summary.txt'), 'utf8');
  assert(Buffer.byteLength(summary) <= 1024 * 1024);
  assert.equal((summary.match(/^  Used in: files 1-80$/gm) ?? []).length, 20);
  assert.equal((await fs.readdir(shown.folder)).length, 81);
  assert.deepEqual(await fs.readFile(path.join(shown.folder, '80-proposed.md')), Buffer.from(files[79].proposed));
});

test('a changed destination is refused before staging and clears the stale review folder and binding', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const shown = await review(h), code = shown.draft.code;
  await fs.mkdir(path.dirname(p.target), { recursive: true }); await fs.writeFile(p.target, '# Human edit\n');
  const refused = await review(h, { decision: 'save', draft: code });
  assert.equal(refused.review, 'changed'); assert.equal(refused.draft.code, code);
  assert.match(refused.statusText, /^Cuefluent: Nothing was applied: draft [a-z2-9]{6} changed, its destination changed, or it is no longer pending\./);
  assertPlainReply(refused, f);
  assert.equal(await fs.readFile(p.target, 'utf8'), '# Human edit\n');
  const pending = await inspectProcessing(f.capability, f.operationId);
  assert.equal(pending.state, 'awaiting-review'); assert.equal(pending.pendingTransaction, false); assert.equal(pending.outcome, null);
  assert.equal(await exists(shown.draft.folder), false);
  const state = await reviewState(f);
  assert.deepEqual(state.bindings, []); assert.deepEqual(state.folders, []);
  // While the destination differs, a fresh review reports the change and writes nothing.
  assert.equal((await review(h, { draft: code })).review, 'changed');
  assert.equal(await exists(shown.draft.folder), false);
});

test('Codex keeps its native form, names the review folder, and accepts the same typed decisions', async t => {
  await t.test('form Save', async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f);
    h.nativeSkill = true; h.typedControl = 'review';
    const next = h.nextForm(), call = h.call('processing_review', {});
    const form = await next, code = reviewCode(p.proposalHash), folder = path.join(f.collection.intakeStateDir, 'review', code);
    assert(form.params.message.endsWith(`The same proposal is in the private review folder ${folder}`));
    assert.deepEqual(await fs.readFile(path.join(folder, 'proposed.md')), Buffer.from(content));
    h.answer(form, { action: 'accept', content: { decision: 'save' } });
    const saved = body(await call);
    assert.equal(saved.review, 'saved'); assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
    assert.equal(await exists(folder), false); assert.deepEqual((await reviewState(f)).bindings, []);
  });
  await t.test('form Save survives intake-lock contention after the decision committed', async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f);
    h.nativeSkill = true; h.typedControl = 'review';
    const lock = path.join(f.collection.intakeStateDir, '.intake-lock');
    t.after(() => fs.rm(lock, { recursive: true, force: true }));
    // Another process holds the intake lock from the moment the review's
    // controller closes until the reply is out: receipts and any presentation
    // confirmation would block, but the note is already written.
    const next = h.nextForm(), call = h.call('processing_review', {});
    const form = await next;
    h.beforeClose = async () => { await fs.mkdir(lock, { recursive: true, mode: 0o700 }); h.beforeClose = null; };
    h.answer(form, { action: 'accept', content: { decision: 'save' } });
    const row = await call;
    assert.equal(row.error, undefined, JSON.stringify(row.error));
    const saved = body(row);
    assert.equal(saved.review, 'saved');
    assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  });
  await t.test('form Later, then a typed Save', async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f);
    h.nativeSkill = true; h.typedControl = 'review';
    const next = h.nextForm(), call = h.call('processing_review', {});
    h.answer(await next, { action: 'accept', content: { decision: 'later' } });
    const later = body(await call), code = later.draft.code;
    assert.equal(later.review, 'deferred');
    assert.equal(later.statusText, `Cuefluent: Review deferred with Later. The draft remains pending; nothing was saved.\nReview folder: ${later.draft.folder}\n` +
      `To decide, type ${codex} review save ${code}, ${codex} review skip ${code} or ${codex} review later ${code}.`);
    // The typed text alone carries the decision; the call has no review fields.
    h.typedControl = `review save ${code}`;
    const saved = body(await h.call('processing_review', {}));
    assert.equal(saved.review, 'saved'); assert.equal(h.forms.length, 1);
    assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
    assert.equal(await exists(later.draft.folder), false);
  });
  await t.test('a proposal too large for the form is reviewed through the folder and a typed Save', async t => {
    const f = await processingFixture(t), big = '# Bounded review\n\n## Knowledge\n\n' + 'Synthetic content.\n'.repeat(16000);
    const p = await proposedClaim(f, { content: big }), h = await harness(t, f);
    h.nativeSkill = true; h.typedControl = 'review';
    const shown = body(await h.call('processing_review', {})), code = reviewCode(p.proposalHash);
    assert.equal(shown.review, 'presented'); assert.equal(shown.draft.code, code); assert.equal(h.forms.length, 0);
    assert.deepEqual(await fs.readFile(path.join(shown.draft.folder, 'proposed.md')), Buffer.from(big));
    assert(shown.statusText.includes(`${codex} review save ${code}`));
    h.typedControl = `review save ${code}`;
    assert.equal(body(await h.call('processing_review', {})).review, 'saved');
    assert.deepEqual(await fs.readFile(p.target), Buffer.from(big));
    assert.equal(await exists(shown.draft.folder), false);
  });
  await t.test('model-chosen review fields are refused', async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f); h.nativeSkill = true;
    const code = reviewCode(p.proposalHash);
    for (const args of [{ decision: 'save' }, { draft: code }, { decision: 'save', draft: code }]) {
      assert.equal((await h.call('processing_review', args)).error.message, 'PROCESSING_CONTROL_INVALID_REQUEST');
    }
    const tools = (await h.send({ jsonrpc: '2.0', id: 900, method: 'tools/list' })).result.tools;
    assert.deepEqual(Object.keys(tools.find(tool => tool.name === 'processing_review').inputSchema.properties), ['collectionId', 'retryToken']);
    assert.equal(h.forms.length, 0); assert.equal(await exists(stateFile(f)), false);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  });
});

test('verified review replies are receipted canonically and replay byte-for-byte without rewriting files', async t => {
  for (const capabilities of [{}, undefined]) await t.test(capabilities ? 'review folder only' : 'form Later', async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f, { capabilities });
    h.nativeSkill = true; h.typedControl = 'review'; h.callId = 'review_call';
    let first;
    if (capabilities) first = await h.call('processing_review', {});
    else { const next = h.nextForm(), call = h.call('processing_review', {}); h.answer(await next, { action: 'accept', content: { decision: 'later' } }); first = await call; }
    const view = body(first);
    assert.equal(view.review, capabilities ? 'presented' : 'deferred');
    const receiptFile = path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId, `${digest(h.callId).slice(0, 24)}.json`);
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    assert.deepEqual(receipt.dispatch.response, view); assert.equal(receipt.dispatch.statusText, view.statusText);
    const state = await fs.readFile(stateFile(f));
    assert.deepEqual((await h.call('processing_review', {})).result, first.result);
    assert.equal(h.forms.length, capabilities ? 0 : 1);
    assert.deepEqual(await fs.readFile(stateFile(f)), state);
    assert.equal(view.draft.code, reviewCode(p.proposalHash));
  });
});
