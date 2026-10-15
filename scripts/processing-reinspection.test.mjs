import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, proposedClaim, inspectedClaim } from './test-support/processing-fixture.mjs';
import { verifyWorkflowStorage, workflowProcessingBinding } from './workflow-storage.mjs';
import { previewProcessingReinspection, reinspectProcessing, inspectProcessingReinspection, abandonProcessingReinspection,
  prepareProcessing, inspectProcessing, readProcessingPage, acknowledgeProcessingPages, proposeProcessing,
  readProcessingProposal, saveProcessing, completeProcessing } from './processing.mjs';
import { executeWorkflow } from './workflow.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { dispositionPath } from './capture-retention.mjs';
import { applyPlan, fingerprint, inspectWriterMaintenance } from './safe-update.mjs';
import { captureRelativePath, createCapture } from './capture-contract.mjs';
import { openWorkflowIntake, withIntakeLock } from './intake-io.mjs';
import { publishCapture } from './intake-store.mjs';
import { pendingProcessing } from './processing-inventory.mjs';
import { pendingCollectionProcessing } from './processing-collection.mjs';
import { inspectFrozenProcessingInputs } from './processing-workset.mjs';
import { selectProcessingShortcut, inspectProcessingShortcut } from './processing-shortcuts.mjs';
import { processingControlStatusView } from './processing-control-server.mjs';
import { processingStatusView } from './processing-mcp.mjs';

async function replaceRoots(f) {
  for (const root of [f.collection.rawDir, f.collection.intakeStateDir, f.collection.notes.writerStateDir, f.collection.notes.notesDir]) {
    await fs.rename(root, `${root}-original`);
    await fs.cp(`${root}-original`, root, { recursive: true, preserveTimestamps: true });
  }
  f.capability = await verifyWorkflowStorage(f.options);
}
async function fixture(t, options) {
  const f = await processingFixture(t, options), proposal = await proposedClaim(f);
  const originalClaim = await fs.readFile(path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`));
  const settings = await fs.readFile(f.options.configPath);
  await fs.unlink(proposal.contentPath); // The disposable preview is not recovery authority.
  await replaceRoots(f);
  const request = { ...f.args, replacementOperationId: randomUUID(), expectedClaimHash: proposal.claimHash,
    expectedProposalHash: proposal.proposalHash };
  return { ...f, proposal, originalClaim, settings, request };
}
const preview = f => previewProcessingReinspection(f.capability, f.request);
async function inspectAll(f, operationId) {
  let claim = (await inspectProcessing(f.capability, operationId)).claim;
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const issued = await readProcessingPage(f.capability, { selection: f.selection, operationId, expectedClaimHash: claim.claimHash, page });
    claim = await acknowledgeProcessingPages(f.capability, { selection: f.selection, operationId,
      expectedClaimHash: issued.claimHash, pages: [{ index: page, hash: issued.hash }] });
  }
  return claim;
}

test('explicit reinspection preserves the durable draft and history, then requires fresh inspection and exact approval', async t => {
  const f = await fixture(t), before = await preview(f);
  assert.equal(before.savesNotes, false);
  assert.equal(before.files[0].proposed, '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n');
  assert.notDeepEqual(before.currentBinding, before.previousBinding);
  assert.notDeepEqual(before.currentDirectories, before.previousDirectories);
  const args = { ...f.request, expectedPreviewHash: before.previewHash };
  const transferred = await reinspectProcessing(f.capability, args);
  assert.equal(transferred.status, 'transferred'); assert.equal(transferred.savesNotes, false);
  assert.deepEqual(await fs.readFile(f.options.configPath), f.settings);
  assert.equal(await fingerprint(f.proposal.target), null);
  const old = JSON.parse(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'processed', 'operations', `${f.operationId}.json`)));
  assert.equal(old.outcome, 'cancelled'); assert.deepEqual(old.claim, JSON.parse(f.originalClaim));
  const successor = await inspectProcessing(f.capability, transferred.replacementOperationId);
  assert.equal(successor.state, 'unread'); assert.equal(successor.proposalHash, null);
  assert.equal(successor.inspection.acknowledgedPages, 0);
  assert.equal(await fs.readFile(transferred.proposal.files[0].contentPath, 'utf8'), before.files[0].proposed);
  await assert.rejects(saveProcessing(f.capability, { selection: f.selection, operationId: transferred.replacementOperationId,
    expectedClaimHash: successor.claimHash, approvedProposalHash: f.proposal.proposalHash }), { code: 'PROCESSING_INSPECTION_INCOMPLETE' });
  const inspected = await inspectAll(f, transferred.replacementOperationId);
  const next = await proposeProcessing(f.capability, { selection: f.selection, operationId: transferred.replacementOperationId,
    expectedClaimHash: inspected.claimHash, proposal: transferred.proposal });
  assert.notEqual(next.proposalHash, f.proposal.proposalHash);
  const reviewed = await readProcessingProposal(f.capability, { selection: f.selection, operationId: transferred.replacementOperationId,
    expectedClaimHash: next.claimHash, expectedProposalHash: next.proposalHash });
  assert.equal(reviewed.files[0].proposed, before.files[0].proposed);
  assert.equal((await saveProcessing(f.capability, { selection: f.selection, operationId: transferred.replacementOperationId,
    expectedClaimHash: next.claimHash, approvedProposalHash: next.proposalHash })).status, 'saved');
  await fs.writeFile(f.proposal.target, 'Later human edit.\n');
  assert.deepEqual(await reinspectProcessing(f.capability, args), transferred);
  assert.equal(await fs.readFile(f.proposal.target, 'utf8'), 'Later human edit.\n');
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs }),
    { code: 'PROCESSING_INPUT_ALREADY_HANDLED' });
});

for (const phase of ['reinspection-intent', 'reinspection-copies', 'reinspection-claim', 'reinspection-cancellation',
  'projections-complete', 'proposal-cleanup', 'claim-release', 'reinspection-cleanup', 'reinspection-archive']) {
  test(`interrupted draft transfer is rediscoverable and finishes exactly once after ${phase}`, async t => {
    const f = await fixture(t), before = await preview(f), args = { ...f.request, expectedPreviewHash: before.previewHash };
    await assert.rejects(reinspectProcessing(f.capability, args, { fault: at => { if (at === phase) throw new Error('interrupted'); } }), /interrupted/);
    const status = await inspectProcessingReinspection(f.capability);
    assert.equal(status.state, 'transfer-pending'); assert.equal(status.conflict, null);
    assert.deepEqual(status.args, args);
    await assert.rejects(prepareProcessing(f.capability, { ...f.args, operationId: randomUUID(), inputs: f.inputs }),
      { code: 'PROCESSING_REINSPECTION_REQUIRED' });
    const result = await reinspectProcessing(f.capability, status.args);
    assert.deepEqual(await reinspectProcessing(f.capability, args), result);
    assert.equal((await inspectProcessingReinspection(f.capability, { operationId: f.operationId })).state, 'transferred');
    assert.equal((await inspectProcessingReinspection(f.capability)).state, 'missing');
    assert.equal((await inspectProcessing(f.capability, args.replacementOperationId)).state, 'unread');
    assert.equal(await fs.readFile(result.proposal.files[0].contentPath, 'utf8'), before.files[0].proposed);
    assert.equal(await fingerprint(f.proposal.target), null);
  });
}

for (const changed of ['preview', 'draft', 'output', 'head', 'settings', 'replacement', 'receipt']) {
  test(`reinspection refuses changed ${changed} without retiring the old claim`, async t => {
    const f = await fixture(t, changed === 'head' ? { terminal: 'unconfirmed' } : undefined), before = await preview(f), args = { ...f.request, expectedPreviewHash: before.previewHash };
    const writer = f.collection.notes.writerStateDir;
    const expected = { preview: 'PROCESSING_REINSPECTION_CHANGED', draft: 'PROCESSING_PROPOSAL_CHANGED', output: 'PROCESSING_OUTPUT_CHANGED',
      head: 'PROCESSING_HEAD_CHANGED', settings: 'WORKFLOW_POLICY_CHANGED', replacement: 'PROCESSING_REINSPECTION_CONFLICT', receipt: 'WRITER_RECEIPT_INCOMPLETE' }[changed];
    if (changed === 'preview') args.expectedPreviewHash = digest('stale preview');
    if (changed === 'draft') await fs.writeFile(f.proposal.plan.files[0].contentPath, 'Altered draft.\n');
    if (changed === 'output') { await fs.mkdir(path.dirname(f.proposal.target), { recursive: true }); await fs.writeFile(f.proposal.target, 'Human note.\n'); }
    if (changed === 'head') {
      const store = await openWorkflowIntake(f.capability, f.selection, 'collect');
      const capture = createCapture({ ...f.capture, terminal: 'completed', coverage: { partial: false, omissions: [] } });
      await withIntakeLock(store, tx => publishCapture(tx, { ...f.publishArgs, capture,
        expectedHeadHash: f.published.headHash, cursorHash: f.published.cursorHash,
        scan: { from: f.publishArgs.scan.to, to: f.publishArgs.scan.to, accounted: [] } }));
    }
    if (changed === 'settings') {
      f.config.routes[0].processing.mode = 'prompted'; const bytes = JSON.stringify(f.config);
      await fs.writeFile(f.options.configPath, bytes); f.options.expectedConfigHash = digest(bytes);
      f.capability = await verifyWorkflowStorage(f.options);
    }
    if (changed === 'replacement') await fs.mkdir(path.join(writer, 'proposals', args.replacementOperationId), { mode: 0o700 });
    if (changed === 'receipt') await fs.mkdir(path.join(writer, 'processed', 'writes', f.operationId), { recursive: true, mode: 0o700 });
    await assert.rejects(reinspectProcessing(f.capability, args), { code: expected });
    assert.deepEqual(await fs.readFile(path.join(writer, 'claims', `${f.operationId}.json`)), f.originalClaim);
    await assert.rejects(fs.stat(path.join(writer, 'claims', `${args.replacementOperationId}.json`)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(writer, 'reinspection.json')), { code: 'ENOENT' });
  });
}

test('current namespace dispositions cannot be overwritten by recovery from an older binding', async t => {
  const f = await fixture(t), binding = await workflowProcessingBinding(f.capability);
  const record = { format: 'cuefluent-processing-disposition', version: 2, bindingHash: binding.hash,
    identity: f.identity, headHash: f.inputs[0].headHash, evidenceHash: f.capture.evidenceHash,
    fileHash: f.published.fileHash, operationId: randomUUID(), outcome: 'skipped', processedAt: '2026-01-01T00:00:00.000Z' };
  const claim = JSON.parse(f.originalClaim); record.fileHash = claim.inputs[0].fileHash;
  const file = path.join(f.collection.notes.writerStateDir, dispositionPath(f.identity, record.headHash, binding.hash));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, canonicalJSON(record) + '\n', { mode: 0o600 });
  await assert.rejects(preview(f), { code: 'PROCESSING_INPUT_CHANGED' });
});

test('a pending transfer blocks direct writing and normal successor mutation', async t => {
  const f = await fixture(t), before = await preview(f), args = { ...f.request, expectedPreviewHash: before.previewHash };
  await assert.rejects(reinspectProcessing(f.capability, args, { fault: at => { if (at === 'reinspection-claim') throw new Error('interrupted'); } }), /interrupted/);
  const current = await inspectProcessing(f.capability, args.replacementOperationId);
  const inventory = await pendingCollectionProcessing(f.capability, { selection: f.selection });
  assert.equal(inventory.incomplete, true);
  assert(inventory.blockers.includes('PROCESSING_REINSPECTION_REQUIRED'));
  const view = processingControlStatusView(processingStatusView({ state: 'missing', requestId: null },
    { phase: 'missing', operations: [], worksets: [] }, { inventory }), { collectionId: f.collection.id });
  assert.deepEqual(view.diagnostics, ['PROCESSING_REINSPECTION_REQUIRED']);
  await assert.rejects(pendingProcessing(f.capability, { selection: f.selection }), { code: 'PROCESSING_REINSPECTION_REQUIRED' });
  await assert.rejects(inspectFrozenProcessingInputs(f.capability, { inputs: f.inputs, policyHash: f.options.expectedConfigHash }),
    { code: 'PROCESSING_REINSPECTION_REQUIRED' });
  await assert.rejects(inspectWriterMaintenance(f.collection.notes.writerStateDir), /reinspection is pending/);
  await assert.rejects(readProcessingPage(f.capability, { selection: f.selection, operationId: args.replacementOperationId,
    expectedClaimHash: current.claimHash, page: 0 }), { code: 'PROCESSING_REINSPECTION_REQUIRED' });
  await assert.rejects(completeProcessing(f.capability, { selection: f.selection, operationId: args.replacementOperationId,
    expectedClaimHash: current.claimHash, outcome: 'cancelled' }), { code: 'PROCESSING_REINSPECTION_REQUIRED' });
  const contentPath = path.join(f.root, 'direct.md'); await fs.writeFile(contentPath, '# Direct\n\n## Decision\n\nKeep it.\n');
  await assert.rejects(applyPlan({ version: 1, mode: 'authored', root: f.collection.notes.notesDir, stateDir: f.collection.notes.writerStateDir,
    files: [{ path: 'direct.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) }] }),
    { code: 'PROCESSING_REINSPECTION_REQUIRED' });
});

test('CLI preview and transfer bind exact public request fields without saving notes', async t => {
  const f = await fixture(t), envelope = { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash, args: f.request };
  const options = { configPath: f.options.configPath };
  const inspected = await executeWorkflow('processing-reinspection-preview', envelope, options);
  const result = await executeWorkflow('processing-reinspect', { ...envelope,
    args: { ...f.request, expectedPreviewHash: inspected.previewHash } }, options);
  const status = await executeWorkflow('processing-reinspection-status', { ...envelope, args: { operationId: f.operationId } }, options);
  assert.equal(status.state, 'transferred'); assert.equal(status.args.replacementOperationId, result.replacementOperationId);
  assert.equal(await fingerprint(f.proposal.target), null);
  await assert.rejects(executeWorkflow('processing-reinspect', { ...envelope,
    args: { ...f.request, expectedPreviewHash: inspected.previewHash, trigger: 'automatic' } }, options), { code: 'INVALID_WORKFLOW' });
});

for (const client of ['codex', 'claude']) test(`${client} draft with only a changed notes root needs explicit reinspection`, async t => {
  const f = await processingFixture(t, { client }), proposal = await proposedClaim(f);
  const request = { ...f.args, replacementOperationId: randomUUID(), expectedClaimHash: proposal.claimHash, expectedProposalHash: proposal.proposalHash };
  await assert.rejects(previewProcessingReinspection(f.capability, request), { code: 'PROCESSING_REINSPECTION_NOT_REQUIRED' });
  const root = f.collection.notes.notesDir;
  await fs.rename(root, `${root}-old`); await fs.cp(`${root}-old`, root, { recursive: true, preserveTimestamps: true });
  const before = await previewProcessingReinspection(f.capability, request);
  assert.deepEqual(before.previousBinding, before.currentBinding);
  assert.notDeepEqual(before.previousDirectories, before.currentDirectories);
  const result = await reinspectProcessing(f.capability, { ...request, expectedPreviewHash: before.previewHash });
  const successor = await inspectProcessing(f.capability, result.replacementOperationId);
  await completeProcessing(f.capability, { selection: f.selection, operationId: result.replacementOperationId,
    expectedClaimHash: successor.claimHash, outcome: 'cancelled' });
  assert.equal(await fs.readFile(result.proposal.files[0].contentPath, 'utf8'), before.files[0].proposed);
  assert.equal(await fingerprint(proposal.target), null);
  assert.deepEqual(await fs.readdir(path.join(f.collection.notes.writerStateDir, 'proposals')), []);
});

test('a second binding change after transfer intent refuses replay and preserves both evidence and intent', async t => {
  const f = await fixture(t), before = await preview(f), args = { ...f.request, expectedPreviewHash: before.previewHash };
  await assert.rejects(reinspectProcessing(f.capability, args, { fault: at => { if (at === 'reinspection-intent') throw new Error('interrupted'); } }), /interrupted/);
  const journal = path.join(f.collection.notes.writerStateDir, 'reinspection.json'), bytes = await fs.readFile(journal);
  const root = f.collection.rawDir;
  await fs.rename(root, `${root}-again`); await fs.cp(`${root}-again`, root, { recursive: true, preserveTimestamps: true });
  f.capability = await verifyWorkflowStorage(f.options);
  assert.equal((await inspectProcessingReinspection(f.capability)).conflict, 'PROCESSING_BINDING_CHANGED');
  await assert.rejects(reinspectProcessing(f.capability, args), { code: 'PROCESSING_REINSPECTION_CHANGED' });
  assert.deepEqual(await fs.readFile(journal), bytes);
  assert.equal(await fingerprint(f.proposal.target), null);
});

for (const changed of ['raw-bytes', 'notes-parent', 'linked-parent']) test(`fresh reinspection refuses ${changed} changed after preview`, async t => {
  const f = await fixture(t), before = await preview(f), args = { ...f.request, expectedPreviewHash: before.previewHash };
  if (changed === 'raw-bytes') await fs.appendFile(path.join(f.collection.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash)), ' ');
  else {
    const root = f.collection.notes.notesDir;
    await fs.rename(root, `${root}-again`);
    if (changed === 'linked-parent') await fs.symlink(`${root}-again`, root, process.platform === 'win32' ? 'junction' : 'dir');
    else await fs.cp(`${root}-again`, root, { recursive: true, preserveTimestamps: true });
  }
  await assert.rejects(reinspectProcessing(f.capability, args), { code: { 'raw-bytes': 'CAPTURE_HEAD_CONFLICT',
    'notes-parent': 'PROCESSING_REINSPECTION_CHANGED', 'linked-parent': 'UNSAFE_WORKFLOW_PATH' }[changed] });
  assert.deepEqual(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`)), f.originalClaim);
  await assert.rejects(fs.stat(path.join(f.collection.notes.writerStateDir, 'reinspection.json')), { code: 'ENOENT' });
  assert.equal(await fingerprint(f.proposal.target), null);
});

for (const mode of ['authored', 'derived']) test(`reinspection preserves ${mode} existing custom-path updates and a new output`, async t => {
  const f = await processingFixture(t);
  const names = ['custom/nested/existing.md', 'custom/nested/new.md'];
  await fs.mkdir(path.join(f.collection.notes.notesDir, 'custom/nested'), { recursive: true });
  const initial = path.join(f.root, 'initial.md');
  await fs.writeFile(initial, '# Existing\n\n## Decision\n\nRollout timing is undecided.\n');
  if (mode === 'derived') {
    const raw = path.join(f.collection.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash));
    await applyPlan({ version: 1, mode, root: f.collection.notes.notesDir, stateDir: f.collection.notes.writerStateDir,
      expectedManifestHash: null, files: [{ path: names[0], contentPath: initial, expectedHash: null,
        expectedContentHash: await fingerprint(initial), sources: [{ path: raw, expectedHash: await fingerprint(raw) }] }] });
  } else await fs.copyFile(initial, path.join(f.collection.notes.notesDir, names[0]));
  const claim = await inspectedClaim(f);
  const files = [];
  for (const [index, name] of names.entries()) {
    const contentPath = path.join(f.root, `${index}-draft.md`);
    await fs.writeFile(contentPath, `# Rollout ${index}\n\n## Decision\n\nKeep the rollout paused.\n`);
    files.push({ path: name, contentPath, expectedHash: await fingerprint(path.join(f.collection.notes.notesDir, name)), expectedContentHash: await fingerprint(contentPath) });
  }
  const proposal = await proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash,
    proposal: { mode, ...(mode === 'derived' ? { expectedManifestHash: await fingerprint(path.join(f.collection.notes.writerStateDir, 'manifest.json')) } : {}),
      files, mappings: [{ identity: f.identity, paths: names }] } });
  await replaceRoots(f);
  const request = { ...f.args, replacementOperationId: randomUUID(), expectedClaimHash: proposal.claimHash, expectedProposalHash: proposal.proposalHash };
  const before = await previewProcessingReinspection(f.capability, request);
  const result = await reinspectProcessing(f.capability, { ...request, expectedPreviewHash: before.previewHash });
  const inspected = await inspectAll(f, result.replacementOperationId);
  const next = await proposeProcessing(f.capability, { selection: f.selection, operationId: result.replacementOperationId,
    expectedClaimHash: inspected.claimHash, proposal: result.proposal });
  await saveProcessing(f.capability, { selection: f.selection, operationId: result.replacementOperationId,
    expectedClaimHash: next.claimHash, approvedProposalHash: next.proposalHash });
  for (const [index, name] of names.entries()) assert.equal(await fingerprint(path.join(f.collection.notes.notesDir, name)), files[index].expectedContentHash);
});

test('started writer transactions cannot be converted into reinspection transfers', async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  await assert.rejects(saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash, approvedProposalHash: proposal.proposalHash },
    { fault: at => { if (at === 'write-intent') throw new Error('interrupted'); } }), /interrupted/);
  await replaceRoots(f);
  await assert.rejects(previewProcessingReinspection(f.capability, { ...f.args, replacementOperationId: randomUUID(),
    expectedClaimHash: proposal.claimHash, expectedProposalHash: proposal.proposalHash }), { code: 'PROCESSING_RECOVERY_REQUIRED' });
  assert.equal(await fingerprint(proposal.target), null);
});

for (const change of ['head', 'note', 'policy', 'binding']) test(`uncommitted transfer can be abandoned after ${change} changes`, async t => {
  const f = await fixture(t, { terminal: 'unconfirmed' }), before = await preview(f);
  const args = { ...f.request, expectedPreviewHash: before.previewHash };
  await assert.rejects(reinspectProcessing(f.capability, args, { fault: at => { if (at === 'reinspection-copies') throw new Error('interrupted'); } }), /interrupted/);
  const status = await inspectProcessingReinspection(f.capability);
  if (change === 'head') {
    const store = await openWorkflowIntake(f.capability, f.selection, 'collect');
    const capture = createCapture({ ...f.capture, terminal: 'completed', coverage: { partial: false, omissions: [] } });
    await withIntakeLock(store, tx => publishCapture(tx, { ...f.publishArgs, capture,
      expectedHeadHash: f.published.headHash, cursorHash: f.published.cursorHash,
      scan: { from: f.publishArgs.scan.to, to: f.publishArgs.scan.to, accounted: [] } }));
  } else if (change === 'note') {
    await fs.mkdir(path.dirname(f.proposal.target), { recursive: true }); await fs.writeFile(f.proposal.target, 'A human edit.\n');
  } else if (change === 'policy') {
    f.config.routes[0].processing.mode = 'prompted'; const bytes = JSON.stringify(f.config);
    await fs.writeFile(f.options.configPath, bytes); f.options.expectedConfigHash = digest(bytes);
  } else {
    const root = f.collection.rawDir; await fs.rename(root, `${root}-again`);
    await fs.cp(`${root}-again`, root, { recursive: true, preserveTimestamps: true });
  }
  f.capability = await verifyWorkflowStorage(f.options);
  await assert.rejects(reinspectProcessing(f.capability, args), { code: {
    head: 'PROCESSING_HEAD_CHANGED', note: 'SAFE_UPDATE_REJECTED', policy: 'PROCESSING_REINSPECTION_CHANGED', binding: 'PROCESSING_REINSPECTION_CHANGED',
  }[change] });
  const request = { expectedRecordHash: status.recordHash };
  assert.equal((await executeWorkflow('processing-reinspection-abandon', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: request }, { configPath: f.options.configPath })).status, 'abandoned');
  assert.equal((await abandonProcessingReinspection(f.capability, request)).status, 'abandoned');
  assert.deepEqual(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`)), f.originalClaim);
  assert.equal(await fingerprint(f.proposal.target), change === 'note' ? digest('A human edit.\n') : null);
  assert.equal((await inspectProcessingReinspection(f.capability)).state, 'missing');
  const contentPath = path.join(f.root, 'direct-after-abandon.md'); await fs.writeFile(contentPath, '# Direct\n\n## Decision\n\nKeep it.\n');
  await applyPlan({ version: 1, mode: 'authored', root: f.collection.notes.notesDir, stateDir: f.collection.notes.writerStateDir,
    files: [{ path: 'direct.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) }] });
  assert.equal(await fingerprint(path.join(f.collection.notes.notesDir, 'direct.md')), await fingerprint(contentPath));
});

for (const phase of ['reinspection-abandon-intent', 'reinspection-abandon-copies']) test(`abandonment resumes exactly after ${phase}`, async t => {
  const f = await fixture(t), before = await preview(f), args = { ...f.request, expectedPreviewHash: before.previewHash };
  await assert.rejects(reinspectProcessing(f.capability, args, { fault: at => { if (at === 'reinspection-copies') throw new Error('interrupted'); } }), /interrupted/);
  const status = await inspectProcessingReinspection(f.capability), request = { expectedRecordHash: status.recordHash };
  await assert.rejects(abandonProcessingReinspection(f.capability, request, { fault: at => { if (at === phase) throw new Error('interrupted'); } }), /interrupted/);
  assert.equal((await inspectProcessingReinspection(f.capability)).nextAction, 'processing-reinspection-abandon');
  await assert.rejects(reinspectProcessing(f.capability, args), { code: 'PROCESSING_REINSPECTION_ABANDONING' });
  await abandonProcessingReinspection(f.capability, request);
  const next = await preview(f);
  assert.equal(next.previewHash, before.previewHash);
  await reinspectProcessing(f.capability, { ...f.request, replacementOperationId: randomUUID(), expectedPreviewHash: before.previewHash }).then(
    () => assert.fail('stale preview accepted'), error => assert.equal(error.code, 'PROCESSING_REINSPECTION_CHANGED'));
});

for (const change of ['policy', 'binding']) test(`committed transfer finishes metadata after ${change} changes`, async t => {
  const f = await fixture(t), before = await preview(f), args = { ...f.request, expectedPreviewHash: before.previewHash };
  await assert.rejects(reinspectProcessing(f.capability, args, { fault: at => { if (at === 'reinspection-claim') throw new Error('interrupted'); } }), /interrupted/);
  const status = await inspectProcessingReinspection(f.capability);
  await assert.rejects(abandonProcessingReinspection(f.capability, { expectedRecordHash: status.recordHash }), { code: 'PROCESSING_REINSPECTION_COMMITTED' });
  if (change === 'policy') {
    f.config.routes[0].processing.mode = 'prompted'; const bytes = JSON.stringify(f.config);
    await fs.writeFile(f.options.configPath, bytes); f.options.expectedConfigHash = digest(bytes);
  } else {
    const root = f.collection.rawDir; await fs.rename(root, `${root}-again`);
    await fs.cp(`${root}-again`, root, { recursive: true, preserveTimestamps: true });
  }
  f.capability = await verifyWorkflowStorage(f.options);
  assert.equal((await inspectProcessingReinspection(f.capability)).nextAction, 'processing-reinspect');
  assert.equal((await reinspectProcessing(f.capability, args)).status, 'transferred');
  assert.equal((await inspectProcessingReinspection(f.capability)).state, 'missing');
  assert.equal(await fingerprint(f.proposal.target), null);
});

test('existing shortcut and completed original project the transfer blocker and its actual recovery command', async t => {
  const f = await processingFixture(t);
  await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID() });
  const proposal = await proposedClaim(f), root = f.collection.notes.notesDir;
  await fs.rename(root, `${root}-old`); await fs.cp(`${root}-old`, root, { recursive: true, preserveTimestamps: true });
  const request = { ...f.args, replacementOperationId: randomUUID(), expectedClaimHash: proposal.claimHash, expectedProposalHash: proposal.proposalHash };
  const before = await previewProcessingReinspection(f.capability, request);
  await assert.rejects(reinspectProcessing(f.capability, { ...request, expectedPreviewHash: before.previewHash },
    { fault: at => { if (at === 'reinspection-cancellation') throw new Error('interrupted'); } }), /interrupted/);
  const original = await inspectProcessing(f.capability, f.operationId);
  assert.equal(original.state, 'blocked'); assert(original.blockers.includes('PROCESSING_REINSPECTION_REQUIRED'));
  assert.deepEqual(original.nextAction, { command: 'processing-reinspection-status' });
  const shortcut = await inspectProcessingShortcut(f.capability, { selection: f.selection });
  assert(shortcut.blockers.includes('PROCESSING_REINSPECTION_REQUIRED')); assert.equal(shortcut.nextRun, null);
  const selected = await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID(), mode: 'resume' });
  assert(selected.blockers.includes('PROCESSING_REINSPECTION_REQUIRED')); assert.equal(selected.nextRun, null);
  const view = processingControlStatusView(processingStatusView({ state: 'missing', requestId: null }, shortcut), { collectionId: f.collection.id });
  assert.equal(view.status, 'blocked'); assert.equal(view.nextAction, 'inspect'); assert.deepEqual(view.diagnostics, ['PROCESSING_REINSPECTION_REQUIRED']);
});

test('one draft can be reproposed while another old draft remains and its archive stays readable during another transfer', async t => {
  const f = await processingFixture(t), a = await proposedClaim(f);
  const b = await processingFixture(t, { base: f }), bp = await proposedClaim(b, { name: 'meetings/second.md' });
  await replaceRoots(f); b.capability = f.capability;
  const request = { ...f.args, replacementOperationId: randomUUID(), expectedClaimHash: a.claimHash, expectedProposalHash: a.proposalHash };
  const before = await previewProcessingReinspection(f.capability, request), args = { ...request, expectedPreviewHash: before.previewHash };
  const transferred = await reinspectProcessing(f.capability, args), inspected = await inspectAll(f, transferred.replacementOperationId);
  await proposeProcessing(f.capability, { selection: f.selection, operationId: transferred.replacementOperationId,
    expectedClaimHash: inspected.claimHash, proposal: transferred.proposal });
  const requestB = { ...b.args, replacementOperationId: randomUUID(), expectedClaimHash: bp.claimHash, expectedProposalHash: bp.proposalHash };
  const previewB = await previewProcessingReinspection(f.capability, requestB);
  await assert.rejects(reinspectProcessing(f.capability, { ...requestB, expectedPreviewHash: previewB.previewHash },
    { fault: at => { if (at === 'reinspection-intent') throw new Error('interrupted'); } }), /interrupted/);
  const archived = await inspectProcessingReinspection(f.capability, { operationId: f.operationId });
  assert.equal(archived.state, 'transferred'); assert.equal(archived.otherPendingTransfer.operationId, b.operationId);
  assert.equal(archived.retainedDrafts.files, 1); assert.match(archived.retainedDrafts.retention, /indefinite/);
  assert.deepEqual(await reinspectProcessing(f.capability, args), transferred);
});

test('reinspection stores a large valid proposal once within the metadata bound', async t => {
  const f = await processingFixture(t), captures = [f];
  for (let index = 1; index < 12; index++) captures.push(await processingFixture(t, { base: f }));
  f.inputs = captures.flatMap(item => item.inputs);
  const claim = await inspectedClaim(f, { budget: { maxInputs: 20, maxPacketBytes: 64 * 1024 } });
  const contentPath = path.join(f.root, 'large-proposal.md'); await fs.writeFile(contentPath, '# Rollout\n\n## Decision\n\nKeep it paused.\n');
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `${String(i).padStart(3, '0')}-${'topic-'.repeat(30)}.md`,
    contentPath, expectedHash: null, expectedContentHash: digest('# Rollout\n\n## Decision\n\nKeep it paused.\n') }));
  const mappings = captures.map(item => ({ identity: item.identity, paths: files.map(file => file.path) }));
  const proposal = await proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, proposal: { files, mappings } });
  await replaceRoots(f);
  const request = { ...f.args, replacementOperationId: randomUUID(), expectedClaimHash: proposal.claimHash, expectedProposalHash: proposal.proposalHash };
  const before = await previewProcessingReinspection(f.capability, request);
  await assert.rejects(reinspectProcessing(f.capability, { ...request, expectedPreviewHash: before.previewHash },
    { fault: at => { if (at === 'reinspection-intent') throw new Error('interrupted'); } }), /interrupted/);
  const bytes = await fs.readFile(path.join(f.collection.notes.writerStateDir, 'reinspection.json')), record = JSON.parse(bytes);
  const proposalBytes = Buffer.byteLength(canonicalJSON(record.claim.proposalIntent.value));
  assert(bytes.length < 1024 * 1024); assert(bytes.length + 2 * proposalBytes > 1024 * 1024);
  const status = await inspectProcessingReinspection(f.capability);
  await abandonProcessingReinspection(f.capability, { expectedRecordHash: status.recordHash });
});
