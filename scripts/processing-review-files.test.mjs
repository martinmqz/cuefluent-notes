import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { processingFixture, proposedClaim, inspectedClaim } from './test-support/processing-fixture.mjs';
import { body, harness, deferred } from './test-support/processing-mcp.mjs';
import { inspectProcessing, completeProcessing, proposeProcessing } from './processing.mjs';
import { reviewCode, presentReviewFiles, confirmReviewPresentation, readReviewPresentations, settleReviewFiles } from './processing-review-files.mjs';
import { auditWorkflowStorage } from './workflow-storage.mjs';
import { readReviewPreview } from './processing-host-review.mjs';
import { REVIEW_CODE, REVIEW_COMMANDS, processingControlCall } from './processing-control-proof.mjs';
import { reviewPathLink, processingControlRefusalText } from './processing-control-server.mjs';
import { fingerprint } from './safe-update.mjs';
import { openGuarded } from './file-io.mjs';
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
  assert.deepEqual(shown.draft.files, [{ path: 'meetings/rollout.md', bytes: Buffer.byteLength(content), change: 'create', review: 'proposed.md' }]);
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
    `${claude} save ${code} (Codex: ${codex} save ${code})`, `${claude} skip ${code}`, `${claude} review cancel ${code}`,
    'To keep the draft pending, type nothing.', `Operation: ${f.operationId}`, `Claim hash: ${p.claimHash}`, `Proposal hash: ${p.proposalHash}`]) {
    assert(summary.includes(expected), expected);
  }
  assert(!summary.includes('Keep the rollout paused'), 'note content stays in proposed.md');
  assert(!summary.includes('later') && !summary.includes('review save'), 'only current command spellings');
  // The folder and the proposed copy open with one click.
  assert(shown.statusText.startsWith(`Cuefluent: Draft ${code} ("meetings/rollout.md") is ready for review; nothing has been saved.\n\nReview folder: <${pathToFileURL(folder).href}/>\n\n`));
  assert(shown.statusText.includes(`- "meetings/rollout.md" (new note, ${Buffer.byteLength(content)} bytes): <${pathToFileURL(path.join(folder, 'proposed.md')).href}>`));
  assert(shown.statusText.includes(`To decide, type ${claude} save ${code} or ${claude} skip ${code}.`));
  assertPlainReply(shown, f);
  // The durable presentation binding names this chat and the exact revision.
  const state = await reviewState(f);
  assert.deepEqual(state.bindings.map(({ attempt, presentedAt, ...item }) => item), [{ chatLineage: { client: 'claude', sessionId: f.identity.sessionId },
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
  assert.deepEqual(shown.draft.files, [{ path: 'policy.md', bytes: Buffer.byteLength(updated), change: 'update', review: '1-proposed.md' },
    { path: 'meetings/rollout.md', bytes: Buffer.byteLength(content), change: 'create', review: '2-proposed.md' }]);
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
  assert(shown.statusText.includes('- and 1 more file listed in summary.txt'));
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
  assert.equal(unseen.statusText, `Cuefluent: Nothing was applied: draft ${code} ("meetings/rollout.md") has not been shown in this chat by a typed review. Read it first with ${claude} review ${code}.`);
  const shown = await review(h), folder = shown.draft.folder;
  // Model-chosen decision fields are not an approval channel.
  h.nativeSkill = false;
  const model = await review(h, { decision: 'save', draft: code });
  assert.equal(model.review, 'unverified'); assertPlainReply(model, f);
  h.nativeSkill = true;
  // A code no pending draft has is not pending, shown here or not.
  const unknown = await review(h, { decision: 'save', draft: 'k2mn9p' });
  assert.equal(unknown.review, 'changed'); assert.equal(unknown.reason, 'not-pending');
  // A typed Later waits for Phase 2: a model cannot pass it either.
  assert.equal((await h.call('processing_review', { decision: 'later', draft: code })).error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []); assert(await exists(folder));
  // An editor's swap file is not this module's to delete; it keeps the folder.
  await fs.writeFile(path.join(folder, '.proposed.md.swp'), 'editor state', { mode: 0o600 });
  const saved = await review(h, { decision: 'save', draft: code });
  assert.equal(saved.review, 'saved');
  assert.match(saved.statusText, new RegExp(`^Cuefluent: Review completed: the exact reviewed proposal of draft ${code} \\("meetings/rollout\\.md"\\) was saved\\.`));
  assert.deepEqual(saved.draft, { code, path: 'meetings/rollout.md', fileCount: 1 }); assertPlainReply(saved, f);
  assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
  assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
  assert.deepEqual(await fs.readdir(folder), ['.proposed.md.swp']);
  await fs.rm(folder, { recursive: true });
  const state = await reviewState(f);
  assert.deepEqual(state.bindings, []); assert.deepEqual(state.folders, []);
  // The decided revision is no longer pending or bound; a bare decision still points at it.
  const again = await review(h, { decision: 'save', draft: code });
  assert.equal(again.review, 'changed'); assert.equal(again.reason, 'not-pending');
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
  assert(bare.statusText.endsWith(`\n\nPending drafts:\n\n- ${codeB} "meetings/rollout.md"`)); assertPlainReply(bare, f);
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

// The plan's automated acceptance, typed as a person types it after the skill
// command: every step is one exact line, mapped to its call by the grammar.
test('acceptance, in either client: A typed-reviewed and replaced by B shown unverified; bare save and A\'s code are refused, B saves only after a typed review', async t => {
  for (const client of ['claude', 'codex']) await t.test(client, async t => {
    const f = await processingFixture(t, client === 'claude' ? { client } : {}), a = await proposedClaim(f);
    const h = client === 'claude' ? await claudeReview(t, f) : await harness(t, f, { capabilities: {} });
    const prefix = client === 'claude' ? claude : codex;
    // A verified typed line. Claude mirrors the typed fields in its call; Codex's
    // call carries none and the verified typed text alone names them.
    const typed = async line => {
      const call = processingControlCall(line);
      assert(call, line);
      h.nativeSkill = true; h.typedControl = line;
      return body(await h.call(call.tool, client === 'claude' ? { ...call.fields } : {}));
    };
    const shownA = await typed('review'), codeA = shownA.draft.code;
    assert.equal(shownA.review, 'presented'); assert.equal(codeA, reviewCode(a.proposalHash));
    // B replaces A: A's operation is cancelled and the same capture is drafted again.
    await completeProcessing(f.capability, { ...f.args, expectedClaimHash: a.claimHash, outcome: 'cancelled' });
    f.operationId = randomUUID(); f.args = { ...f.args, operationId: f.operationId };
    const contentB = '# Rollout meeting\n\n## Decision\n\nResume the rollout on Monday.\n';
    const b = await proposedClaim(f, { content: contentB }), codeB = reviewCode(b.proposalHash);
    // B's folder comes from an unverified display: no typed review.
    h.nativeSkill = false; delete h.typedControl;
    const shownB = body(await h.call('processing_review', {}));
    assert.equal(shownB.review, 'presented'); assert.equal(shownB.draft.code, codeB);
    assert.deepEqual(await fs.readFile(path.join(shownB.draft.folder, 'proposed.md')), Buffer.from(contentB));
    const bare = await typed('save');
    assert.equal(bare.review, 'unresolved');
    assert.equal(bare.statusText, `Cuefluent: Nothing was applied: name the draft to decide on, as in ${prefix} save <draft code>, after reading it with ${prefix} review <draft code>.` +
      `\n\nPending drafts:\n\n- ${codeB} "meetings/rollout.md"`);
    // A was replaced: the refusal names that cause, and B is listed.
    const old = await typed(`save ${codeA}`);
    assert.equal(old.review, 'changed'); assert.equal(old.reason, 'not-pending'); assert.equal(old.draft.code, codeA);
    assert.equal(old.statusText, `Cuefluent: Nothing was applied: draft ${codeA} is not pending. Review the current draft with ${prefix} review before deciding.` +
      `\n\nPending drafts:\n\n- ${codeB} "meetings/rollout.md"`);
    const coded = await typed(`save ${codeB}`);
    assert.equal(coded.review, 'not-shown');
    assert(coded.statusText.endsWith(`Read it first with ${prefix} review ${codeB}.`), coded.statusText);
    for (const reply of [bare, old, coded]) assertPlainReply(reply, f);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
    // A typed review of B makes the bare save resolve to B, with exact bytes.
    assert.equal((await typed(`review ${codeB}`)).review, 'presented');
    const saved = await typed('save');
    assert.equal(saved.review, 'saved'); assert.deepEqual(saved.draft, { code: codeB, path: 'meetings/rollout.md', fileCount: 1 });
    assert.deepEqual(await fs.readFile(b.target), Buffer.from(contentB));
    assert.equal((await inspectProcessing(f.capability, f.operationId)).outcome, 'saved');
    assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
  });
});

// Codex CLI 0.163 runs every tool call through code mode. The typed text and
// the skill selection verify the same way, and the turn gets its exclusion receipt.
test('Codex code mode: a typed review and a bare save decide the exact draft; each turn gets an exclusion receipt', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f, { capabilities: {} });
  const typed = async line => {
    h.nativeSkill = true; h.codeMode = true; h.typedControl = line; h.callId = `exec-${randomUUID()}`;
    return body(await h.call(processingControlCall(line).tool, {}));
  };
  const shown = await typed('review'), code = reviewCode(p.proposalHash);
  assert.equal(shown.review, 'presented'); assert.equal(shown.draft.code, code);
  assert.deepEqual((await reviewState(f)).bindings.map(item => [item.verified, item.delivered, item.typedDelivered]), [[true, true, true]]);
  const saved = await typed('save');
  assert.equal(saved.review, 'saved'); assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
  assert(!saved.diagnostics.includes('PROCESSING_EXCLUSION_UNVERIFIED'));
  assert(!saved.statusText.includes('status --verbose')); assertPlainReply(saved, f);
  const receipts = await fs.readdir(path.join(f.collection.intakeStateDir, 'control-dispatch', 'codex', f.identity.sessionId));
  assert.equal(receipts.length, 2);
  assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
});

test('Codex: a mention typed out by hand applies nothing, whichever tool is called, and says how to type it', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f, { capabilities: {} });
  h.typedUnattached = ['save'];
  for (const name of ['processing_review', 'processing_status', 'process_selected_captures']) {
    const reply = body(await h.call(name, {}));
    assert.equal(reply.command, 'skill-not-attached', name); assert.deepEqual(reply.suggestions, ['save']);
    assert.equal(reply.statusText, `Cuefluent: Nothing was applied: Codex did not attach the Cuefluent Notes skill to that message, so it was not a command. Type $, choose cuefluent-notes from the list, then the action, for example ${codex} save.`);
  }
  assert.equal(await exists(stateFile(f)), false); assert.equal(await exists(path.join(f.collection.intakeStateDir, 'review', reviewCode(p.proposalHash))), false);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
});

test('bare decisions never pick the only draft and refuse an unverified latest display', async t => {
  await t.test('no pending drafts', async t => {
    const f = await processingFixture(t, { client: 'claude' });
    const h = await claudeReview(t, f); h.nativeSkill = true;
    const bare = await review(h, { decision: 'skip' });
    assert.equal(bare.review, 'unresolved'); assert.deepEqual(bare.drafts, []);
    assert(bare.statusText.endsWith('\n\nNo drafts are pending.'));
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
      nativeSkill: h.nativeSkill, unitId: f.identity.unitId, argsHash: digest(canonicalJSON(invocation.arguments)),
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

test('a presentation another request supersedes or settles before its reply commits fails that reply', async t => {
  for (const [name, compete] of [
    // Another MCP process shows the same revision to this chat again.
    ['superseded', async (f, lineage) => {
      const preview = await readReviewPreview(f.capability, { selection: f.selection, operationId: f.operationId });
      await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage: lineage, verified: false,
        presentedAt: new Date(Date.now() + 60_000).toISOString() });
    }],
    // Another MCP process settles this chat's record of the revision.
    ['settled', async (f, lineage, p) => settleReviewFiles(f.capability, { selection: f.selection, chatLineage: lineage,
      revision: { operationId: f.operationId, proposalHash: p.proposalHash, claimHash: p.claimHash } })],
  ]) await t.test(name, async t => {
    const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
    const h = await claudeReview(t, f); h.nativeSkill = true;
    const lineage = { client: 'claude', sessionId: f.identity.sessionId }, code = reviewCode(p.proposalHash);
    // After this request wrote its record and before its reply commits.
    h.beforeConfirm = async () => { h.beforeConfirm = null; await compete(f, lineage, p); };
    const row = await h.call('processing_review', {});
    assert.equal(row.result, undefined); assert.equal(row.error.data.code, 'PROCESSING_REVIEW_SUPERSEDED');
    assert.match(row.error.message, /^Cuefluent: This command was refused: the draft was decided, replaced or shown again before this review was confirmed/);
    // The chat never received a usable review: no decision form applies it.
    assert.equal((await review(h, { decision: 'save', draft: code })).review, 'not-shown');
    assert.equal((await review(h, { decision: 'save' })).review, 'unresolved');
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    // A typed review whose reply commits makes it decidable.
    assert.equal((await review(h, { draft: code })).review, 'presented');
    assert.equal((await review(h, { decision: 'save', draft: code })).review, 'saved');
    assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
  });
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
  // The refusal names the cause: the destination changed.
  assert.equal(refused.reason, 'destination');
  assert.equal(refused.statusText, `Cuefluent: Nothing was applied: a note at the destination of draft ${code} ("meetings/rollout.md") changed after the draft was prepared. Restore that note, or process again for a new draft, then review it with ${claude} review.`);
  assertPlainReply(refused, f);
  assert.equal(await fs.readFile(p.target, 'utf8'), '# Human edit\n');
  const pending = await inspectProcessing(f.capability, f.operationId);
  assert.equal(pending.state, 'awaiting-review'); assert.equal(pending.pendingTransaction, false); assert.equal(pending.outcome, null);
  assert.equal(await exists(shown.draft.folder), false);
  const state = await reviewState(f);
  assert.deepEqual(state.bindings, []); assert.deepEqual(state.folders, []);
  // A bare save now finds no current review of that draft in this chat.
  const bare = await review(h, { decision: 'save' });
  assert.equal(bare.review, 'changed'); assert.equal(bare.reason, 'stale');
  assert.equal(bare.statusText, `Cuefluent: Nothing was applied: draft ${code} ("meetings/rollout.md") needs a fresh review in this chat. Read it again with ${claude} review ${code}.`);
  // While the destination differs, a fresh review reports the change and writes nothing.
  const again = await review(h, { draft: code });
  assert.equal(again.review, 'changed'); assert.equal(again.reason, 'destination');
  assert.equal(await exists(shown.draft.folder), false);
  assert.equal(await fs.readFile(p.target, 'utf8'), '# Human edit\n');
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
    // Codex links the folder the way its model writes a local link; a path it
    // cannot link, such as a Windows path, is a code span.
    assert.equal(later.statusText, `Cuefluent: Review deferred with Later. Draft ${code} ("meetings/rollout.md") remains pending; nothing was saved.\n\nReview folder: ${reviewPathLink(codex, later.draft.folder, { folder: true }) ?? `\`${later.draft.folder}\``}\n\n` +
      `To decide, type ${codex} save ${code} or ${codex} skip ${code}.`);
    // The typed text alone carries the decision; the call has no review fields.
    h.typedControl = `save ${code}`;
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
    assert(shown.statusText.includes(`${codex} save ${code}`));
    h.typedControl = `save ${code}`;
    assert.equal(body(await h.call('processing_review', {})).review, 'saved');
    assert.deepEqual(await fs.readFile(p.target), Buffer.from(big));
    assert.equal(await exists(shown.draft.folder), false);
  });
  await t.test('model-chosen review fields are refused', async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f); h.nativeSkill = true;
    const code = reviewCode(p.proposalHash);
    for (const args of [{ decision: 'save' }, { draft: code }, { decision: 'save', draft: code }]) {
      assert.equal((await h.call('processing_review', args)).error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST');
    }
    const tools = (await h.send({ jsonrpc: '2.0', id: 900, method: 'tools/list' })).result.tools;
    assert.deepEqual(Object.keys(tools.find(tool => tool.name === 'processing_review').inputSchema.properties), ['collectionId', 'retryToken']);
    assert.equal(h.forms.length, 0); assert.equal(await exists(stateFile(f)), false);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  });
});

test('a mixed or misspelled typed review command after a delivered typed review stages nothing, in either client', async t => {
  for (const client of ['claude', 'codex']) await t.test(client, async t => {
    const f = await processingFixture(t, client === 'claude' ? { client } : {}), p = await proposedClaim(f);
    const h = client === 'claude' ? await claudeReview(t, f) : await harness(t, f, { capabilities: {} });
    const prefix = client === 'claude' ? claude : codex;
    h.nativeSkill = true; h.typedControl = 'review';
    const shown = await review(h), code = shown.draft.code;
    assert.equal(shown.review, 'presented'); assert.equal(code, reviewCode(p.proposalHash));
    const state = await fs.readFile(stateFile(f));
    // The person typed `save <code>` with more words; the binder found no
    // exact action. The model may still copy a decision into the call (Claude).
    h.nativeSkill = false; delete h.typedControl; h.typedSuggestions = [`save ${code}`];
    const calls = [['processing_review', client === 'claude' ? { decision: 'save', draft: code } : {}], ['processing_review', {}],
      ['processing_status', {}], ['process_selected_captures', {}], ['processing_resume', {}], ['processing_cancel', {}]];
    for (const [name, args] of calls) {
      const reply = body(await h.call(name, args));
      assert.equal(reply.command, 'not-a-command', name); assert.equal(reply.review, undefined);
      assert.deepEqual(reply.suggestions, [`save ${code}`]); assert.equal(reply.commandPrefix, prefix);
      assert.equal(reply.statusText, `Cuefluent: Nothing was applied: that was not an exact command. Type the command yourself, exactly as written, for example ${prefix} save ${code}.`);
      assertPlainReply(reply, f);
    }
    // Nothing was decided, displayed, dispatched or recorded.
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
    assert.deepEqual(await fs.readFile(stateFile(f)), state); assert(await exists(shown.draft.folder));
    assert.equal(h.dispatches, 0); assert.equal(h.creates, 0); assert.equal(h.forms.length, 0);
    // Typed exactly, alone, the same decision applies.
    delete h.typedSuggestions; h.nativeSkill = true;
    if (client === 'codex') h.typedControl = `save ${code}`;
    assert.equal((await review(h, client === 'claude' ? { decision: 'save', draft: code } : {})).review, 'saved');
    assert.deepEqual(await fs.readFile(p.target), Buffer.from(content));
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

// Every file under root, relative and sorted (listing order is not portable).
async function fileTree(root) {
  const out = [];
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file); else out.push(path.relative(root, file));
    }
  };
  await walk(root); return out.sort();
}

test('help works before setup: with no configuration a status request lists the commands and touches no storage', async t => {
  for (const client of ['claude', 'codex']) await t.test(client, async t => {
    const f = await processingFixture(t, client === 'claude' ? { client } : {});
    const h = client === 'claude' ? await claudeReview(t, f) : await harness(t, f, { capabilities: {} });
    const prefix = client === 'claude' ? claude : codex;
    // Before setup there is no configuration file at all.
    await fs.rm(f.options.configPath);
    const before = await fileTree(f.root);
    // Claude mirrors a typed `help`; the skill typed alone and Codex call with no arguments.
    for (const args of client === 'claude' ? [{ help: true }, {}] : [{}]) {
      const reply = body(await h.call('processing_status', args));
      assert.equal(reply.help, true); assert.equal(reply.status, 'missing'); assert.equal(reply.statusDetail, 'unbound');
      assert.equal(reply.collectionId, null); assert.equal(reply.commandPrefix, prefix);
      assert.deepEqual(reply.diagnostics, ['PROCESSING_CONTROL_SOURCE_UNVERIFIED']);
      const lines = reply.statusText.split('\n');
      assert.equal(lines[0], `Cuefluent: This chat has no verified Cuefluent Notes source yet. To set up Cuefluent Notes, type ${prefix} setup. Type one of these yourself, exactly as written${
        client === 'codex' ? '; for the first word, type $ and choose cuefluent-notes from the list' : ''}:`);
      assert(lines.includes(`- ${prefix} setup: choose collection and processing settings.`));
      assert(lines.includes(`- ${prefix} help: show this list.`));
      assertPlainReply(reply, f);
    }
    // Every other control still refuses; nothing was opened, dispatched or written.
    for (const name of ['processing_review', 'process_selected_captures', 'processing_resume', 'processing_cancel']) {
      assert.equal((await h.call(name, {})).error?.data?.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED', name);
    }
    assert.equal(h.opens, 0); assert.equal(h.dispatches, 0);
    assert.deepEqual(await fileTree(f.root), before);
  });
});

test('help, the bare skill, status and status --verbose reply in the client spelling and apply nothing', async t => {
  for (const client of ['claude', 'codex']) await t.test(client, async t => {
    const f = await processingFixture(t, client === 'claude' ? { client } : {}), p = await proposedClaim(f);
    const h = client === 'claude' ? await claudeReview(t, f) : await harness(t, f, { capabilities: {} });
    const prefix = client === 'claude' ? claude : codex, code = reviewCode(p.proposalHash);
    const receipts = path.join(f.collection.intakeStateDir, 'control-dispatch', client, f.identity.sessionId);
    const receiptCount = async () => (await exists(receipts)) ? (await fs.readdir(receipts)).length : 0;
    const status = async (typed, args) => {
      h.nativeSkill = true; h.typedControl = typed; h.callId = `call_${randomUUID()}`;
      return body(await h.call('processing_status', client === 'claude' ? args : {}));
    };
    // A typed `help` is a formal read-only control, receipted (and so excluded) like `status`.
    const help = await status('help', { help: true });
    assert.equal(help.help, true); assert.equal(help.commandPrefix, prefix);
    assert.equal(help.statusText.split('\n')[0], `Cuefluent: Type one of these yourself, exactly as written${client === 'codex' ? '; for the first word, type $ and choose cuefluent-notes from the list' : ''}:`);
    assert(help.statusText.includes(`\n- ${prefix} process: draft notes from pending captures (also: process repo, process chat, process resume, process cancel).`));
    assertPlainReply(help, f);
    if (client === 'codex') assert.equal(await receiptCount(), 1);
    // The skill typed alone gets the same list; it is no control, so no receipt.
    h.nativeSkill = false; delete h.typedControl; h.typedHelp = true; h.callId = `call_${randomUUID()}`;
    for (const name of ['processing_status', 'processing_review', 'process_selected_captures']) {
      const bare = body(await h.call(name, {}));
      assert.equal(bare.help, true, name); assert.equal(bare.statusText, help.statusText, name); assert.equal(bare.review, undefined, name);
    }
    delete h.typedHelp;
    if (client === 'codex') assert.equal(await receiptCount(), 1);
    // Plain status lists the pending draft by code and note path, without codes.
    const plain = await status('status', {});
    assert.deepEqual(plain.drafts, [{ code, path: 'meetings/rollout.md', fileCount: 1 }]);
    assert(plain.statusText.includes(`\n\nDrafts awaiting review:\n\n- ${code} "meetings/rollout.md"\n\nRead one with ${prefix} review <draft code>.`));
    assertPlainReply(plain, f);
    // The verbose reply names the exact revision and every detail.
    const verbose = await status('status --verbose', { verbose: true });
    assert.equal(verbose.verbose, true);
    assert.deepEqual(verbose.drafts, [{ code, path: 'meetings/rollout.md', fileCount: 1, operationId: f.operationId, proposalHash: p.proposalHash, claimHash: p.claimHash }]);
    assert(verbose.statusText.includes(`\n\n- ${code} "meetings/rollout.md": operation ${f.operationId}; proposal ${p.proposalHash}; claim ${p.claimHash}`));
    assert.match(verbose.statusText, /\n- Diagnostics: [^\n]+\.\n/);
    // Nothing was displayed, decided, dispatched or written.
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
    assert.equal(await exists(stateFile(f)), false);
    assert.equal(h.dispatches, 0); assert.equal(h.forms.length, 0);
  });
});

test('a plain-language request that starts with save is never a decision, in either client', async t => {
  for (const client of ['claude', 'codex']) await t.test(client, async t => {
    const f = await processingFixture(t, client === 'claude' ? { client } : {}), p = await proposedClaim(f);
    const h = client === 'claude' ? await claudeReview(t, f) : await harness(t, f, { capabilities: {} });
    h.nativeSkill = true; h.typedControl = 'review';
    const shown = await review(h), code = shown.draft.code;
    // "save this meeting note: ..." binds as a typed non-command (the skill
    // routes it to its normal workflows); a control call still applies nothing.
    h.nativeSkill = false; delete h.typedControl; h.typedSuggestions = ['save'];
    for (const args of client === 'claude' ? [{ decision: 'save' }, { decision: 'save', draft: code }, {}] : [{}]) {
      const reply = await review(h, args);
      assert.equal(reply.command, 'not-a-command'); assert.equal(reply.review, undefined); assertPlainReply(reply, f);
    }
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
    assert.equal(p.proposalHash.length, 64);
  });
});

test('files an editor or Finder adds to a review folder never fail the storage check, and Finder\'s goes with the folder', async t => {
  const f = await processingFixture(t, { client: 'claude' }); await proposedClaim(f);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const view = await review(h), folder = view.draft.folder;
  for (const file of [path.join(folder, '.DS_Store'), path.join(path.dirname(folder), '.DS_Store'), path.join(folder, 'proposed.md~')]) {
    await fs.writeFile(file, 'synthetic', { mode: 0o644 }); await fs.chmod(file, 0o644);
  }
  // An editor's lock file is a dangling link (Emacs).
  if (posix) await fs.symlink('user@host.4242:1700000000', path.join(folder, '.#proposed.md'));
  assert.deepEqual(await auditWorkflowStorage(f.capability), { complete: true });
  // The folder's own files are still checked.
  if (posix) {
    await fs.chmod(path.join(folder, 'proposed.md'), 0o644);
    assert.deepEqual(await auditWorkflowStorage(f.capability), { complete: false, reason: 'STORAGE_NOT_PRIVATE' });
    await fs.chmod(path.join(folder, 'proposed.md'), 0o600);
  }
  assert.equal((await review(h, { decision: 'save', draft: view.draft.code })).review, 'saved');
  // Finder's file went with the folder's own files; the editor's keep the folder.
  assert.deepEqual((await fs.readdir(folder)).sort(), [...(posix ? ['.#proposed.md'] : []), 'proposed.md~']);
  await fs.rm(path.join(folder, 'proposed.md~')); if (posix) await fs.unlink(path.join(folder, '.#proposed.md'));
  assert.deepEqual(await auditWorkflowStorage(f.capability), { complete: true });
});

test('a reused review copy whose permissions changed is written again', async t => {
  if (!posix) { t.skip('POSIX file modes'); return; }
  const f = await processingFixture(t, { client: 'claude' }); await proposedClaim(f);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const view = await review(h), proposed = path.join(view.draft.folder, 'proposed.md');
  // An editor saved it back unchanged with its own permissions.
  await fs.chmod(proposed, 0o644);
  assert.equal((await review(h, { draft: view.draft.code })).review, 'presented');
  assert.equal((await fs.stat(proposed)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(proposed, 'utf8'), content);
});

test('two presentation attempts in one millisecond are told apart', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const chatLineage = { client: 'claude', sessionId: f.identity.sessionId }, presentedAt = new Date().toISOString();
  const revision = { operationId: f.operationId, proposalHash: p.proposalHash, claimHash: p.claimHash };
  const preview = await readReviewPreview(f.capability, { selection: f.selection, operationId: f.operationId });
  // A model-started display, then a typed review from another process, both stamped alike.
  const shown = await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage, verified: false, presentedAt });
  const typed = await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage, verified: true, presentedAt });
  assert.notEqual(shown.attempt, typed.attempt);
  // The first reply confirms nothing: its attempt was superseded.
  assert.equal(await confirmReviewPresentation(f.capability, { selection: f.selection, chatLineage, revision, attempt: shown.attempt }), false);
  let { bindings, recent } = await readReviewPresentations(f.capability, chatLineage);
  assert.deepEqual(bindings, []); assert.equal(recent.delivered, false);
  assert.equal(await confirmReviewPresentation(f.capability, { selection: f.selection, chatLineage, revision, attempt: typed.attempt }), true);
  ({ bindings, recent } = await readReviewPresentations(f.capability, chatLineage));
  assert.equal(bindings.length, 1); assert.equal(recent.attempt, typed.attempt); assert.equal(recent.delivered, true);
});

test('a review the model started says to type the review before deciding, and so does its summary', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const h = await claudeReview(t, f), code = reviewCode(p.proposalHash);
  const shown = await review(h);
  assert.equal(shown.review, 'presented'); assert.equal(shown.untyped, true);
  assert(shown.statusText.includes(`To decide, first type ${claude} review ${code} yourself, then ${claude} save ${code} or ${claude} skip ${code}.`));
  const summary = await fs.readFile(path.join(shown.draft.folder, 'summary.txt'), 'utf8');
  assert(summary.includes(`- Show it in that chat, if you have not typed this there yet: ${claude} review ${code} (Codex: ${codex} review ${code})`));
  // A typed review then makes it decidable, and its reply has no such step.
  h.nativeSkill = true;
  const typed = await review(h, { draft: code });
  assert.equal(typed.untyped, undefined); assert(typed.statusText.includes(`To decide, type ${claude} save ${code} or ${claude} skip ${code}.`));
  assert.equal((await review(h, { decision: 'save', draft: code })).review, 'saved');
});

test('a coded decision typed again after the draft was decided says it is not pending', async t => {
  const f = await processingFixture(t, { client: 'claude' }); await proposedClaim(f);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const code = (await review(h)).draft.code;
  assert.equal((await review(h, { decision: 'save', draft: code })).review, 'saved');
  const again = await review(h, { decision: 'save', draft: code });
  assert.equal(again.review, 'changed'); assert.equal(again.reason, 'not-pending');
  assert.equal(again.statusText, `Cuefluent: Nothing was applied: draft ${code} is not pending.`);
});

test('a collection step finishing during a decision leaves the draft and this chat\'s review in place', async t => {
  const f = await processingFixture(t, { client: 'claude' }); await proposedClaim(f);
  const h = await claudeReview(t, f); h.nativeSkill = true;
  const code = (await review(h)).draft.code, pending = path.join(f.collection.intakeStateDir, 'pending.json');
  // A capture publication starts after the inventory and before the decision's inspection.
  const open = fs.open.bind(fs); let injected = false;
  const mock = t.mock.method(fs, 'open', async (file, ...args) => {
    if (!injected && file === stateFile(f)) { injected = true; await fs.writeFile(pending, '{}', { mode: 0o600 }); }
    return open(file, ...args);
  });
  let row;
  try { row = await h.call('processing_review', { decision: 'save', draft: code }); }
  finally { mock.mock.restore(); }
  assert(injected);
  assert.equal(row.error.data.code, 'PROCESSING_REVIEW_BLOCKED');
  assert.equal(row.error.message, `Cuefluent: This command was refused: another Cuefluent Notes step had not finished, or needs recovery, so nothing was shown or decided; type the command again in a moment. Type ${claude} status to see where things stand.`);
  assert.equal((await readReviewPresentations(f.capability, { client: 'claude', sessionId: f.identity.sessionId })).bindings.length, 1);
  await fs.rm(pending);
  assert.equal((await review(h, { decision: 'save', draft: code })).review, 'saved');
});

test('a review step waits a bounded moment for the collection lock', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const chatLineage = { client: 'claude', sessionId: f.identity.sessionId };
  const preview = await readReviewPreview(f.capability, { selection: f.selection, operationId: f.operationId });
  // Collection holds the intake lock; it releases it after a short pass.
  const lock = path.join(f.collection.intakeStateDir, '.intake-lock');
  await fs.mkdir(lock, { mode: 0o700 });
  const released = new Promise(resolve => setTimeout(() => fs.rmdir(lock).then(resolve), 300));
  const shown = await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage, verified: true });
  await released;
  assert.equal(shown.code, reviewCode(p.proposalHash));
  // A lock held past the wait refuses as busy, and the reply says so.
  await fs.mkdir(lock, { mode: 0o700 }); t.after(() => fs.rm(lock, { recursive: true, force: true }));
  const started = performance.now();
  await assert.rejects(confirmReviewPresentation(f.capability, { selection: f.selection, chatLineage, attempt: shown.attempt,
    revision: { operationId: f.operationId, proposalHash: p.proposalHash, claimHash: p.claimHash } }), { code: 'INTAKE_BLOCKED' });
  assert(performance.now() - started >= 1900);
  assert.equal(processingControlRefusalText('INTAKE_BLOCKED', { client: 'claude', stage: 'action', tool: 'processing_review' }),
    `Cuefluent: This command was refused: Cuefluent Notes was busy with another operation; type the command again in a moment. Type ${claude} status to see where things stand.`);
  // Another action, such as a cancel, may have taken effect before its receipt found the lock busy.
  assert.match(processingControlRefusalText('INTAKE_BLOCKED', { client: 'claude', stage: 'action', tool: 'processing_cancel' }),
    /^Cuefluent: This command stopped before it finished, so it is not certain whether anything changed./);
});

test('a confirmation waits out another chat\'s brief read of the presentation record', async t => {
  const f = await processingFixture(t, { client: 'claude' }), p = await proposedClaim(f);
  const chatLineage = { client: 'claude', sessionId: f.identity.sessionId };
  const preview = await readReviewPreview(f.capability, { selection: f.selection, operationId: f.operationId });
  const shown = await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage, verified: true });
  // Another chat's unlocked read holds the record open, as Windows then
  // refuses to replace it, and closes it a moment later.
  const { handle } = await openGuarded(stateFile(f), { singleLink: true });
  const closed = new Promise(resolve => setTimeout(() => handle.close().then(resolve), 100));
  try {
    assert.equal(await confirmReviewPresentation(f.capability, { selection: f.selection, chatLineage, attempt: shown.attempt,
      revision: { operationId: f.operationId, proposalHash: p.proposalHash, claimHash: p.claimHash } }), true);
  } finally { await closed; }
  assert.equal((await readReviewPresentations(f.capability, chatLineage)).recent.delivered, true);
});

test('an unlocked read of the presentation record survives another chat replacing it', async t => {
  // POSIX replaces the open file (the opened copy is unlinked); Windows refuses
  // to, so there the read sees the path's identity change after it opened.
  for (const variant of posix ? ['replaced', 'identity changed'] : ['identity changed']) await t.test(variant, async t => {
    const f = await processingFixture(t, { client: 'claude' }); await proposedClaim(f);
    const h = await claudeReview(t, f); h.nativeSkill = true;
    const code = (await review(h)).draft.code, state = stateFile(f), { open, lstat } = fs;
    let opens = 0, changed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === state && opens++ === 0) {
        if (variant === 'replaced') { const copy = `${state}.copy`; await fs.copyFile(state, copy); await fs.rename(copy, state); }
        else changed = true;
      }
      return handle;
    });
    t.mock.method(fs, 'lstat', async (file, ...args) => {
      const stat = await lstat(file, ...args);
      if (!changed || file !== state) return stat;
      changed = false;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + (typeof stat.ino === 'bigint' ? 1n : 1) });
    });
    assert.equal((await readReviewPresentations(f.capability, { client: 'claude', sessionId: f.identity.sessionId })).bindings.length, 1);
    t.mock.restoreAll();
    assert(opens >= 2);
    assert.equal((await review(h, { decision: 'skip', draft: code })).review, 'skipped');
  });
});

test('a redelivered review call whose presentation was superseded is refused again, never replayed as presented', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f, { capabilities: {} });
  h.nativeSkill = true; h.typedControl = 'review'; h.callId = 'call_redelivered';
  const chatLineage = { client: 'codex', sessionId: f.identity.sessionId };
  h.beforeConfirm = async () => {
    h.beforeConfirm = null;
    const preview = await readReviewPreview(f.capability, { selection: f.selection, operationId: f.operationId });
    await presentReviewFiles(f.capability, { selection: f.selection, preview, chatLineage, verified: false });
  };
  for (const attempt of ['first', 'redelivered']) {
    const row = await h.call('processing_review', {});
    assert.equal(row.result, undefined, attempt); assert.equal(row.error.data.code, 'PROCESSING_REVIEW_SUPERSEDED', attempt);
  }
  // A new typed review is a new call and shows the draft.
  delete h.callId;
  assert.equal(body(await h.call('processing_review', {})).review, 'presented');
  assert.equal(p.proposalHash.length, 64);
});

test('a redelivered review call replays only when its exact revision was delivered, not another with its code', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f), h = await harness(t, f, { capabilities: {} });
  h.nativeSkill = true; h.typedControl = 'review'; h.callId = 'call_exact_revision';
  const shown = body(await h.call('processing_review', {}));
  assert.equal(shown.review, 'presented'); assert.equal(shown.draft.code, reviewCode(p.proposalHash));
  // Redelivered while that exact revision is the one delivered here: the same reply.
  assert.deepEqual(body(await h.call('processing_review', {})), shown);
  // A draft code comes from the proposal alone, so a later revision with the
  // same proposal under another claim has the same code. Delivered here, it
  // does not stand in for the revision this call presented.
  const state = await reviewState(f);
  for (const item of [...state.bindings, ...state.recent]) item.claimHash = 'c'.repeat(64);
  await fs.writeFile(stateFile(f), canonicalJSON(state) + '\n');
  const row = await h.call('processing_review', {});
  assert.equal(row.result, undefined); assert.equal(row.error.data.code, 'PROCESSING_REVIEW_SUPERSEDED');
});

test('a review typed while this chat\'s own processing run is still going applies nothing and says so', async t => {
  const f = await processingFixture(t), h = await harness(t, f, { capabilities: {} }), gate = deferred();
  h.script = async call => { await gate.promise; await call('processing_pending', {}); };
  assert.equal(body(await h.call('process_selected_captures', { collectionId: f.collection.id })).statusDetail, 'accepted');
  h.nativeSkill = true;
  for (const typed of ['review', 'save t7xb88']) {
    h.typedControl = typed;
    const busy = body(await h.call('processing_review', {}));
    assert.equal(busy.review, 'busy', typed); assert.equal(busy.status, 'busy', typed);
    assert.match(busy.statusText, /^Cuefluent: Nothing was applied: this chat is still processing\. Type the command again once it finishes\./, typed);
  }
  assert.equal(h.dispatches, 1);
  gate.resolve(); await Promise.all(h.jobs);
});
