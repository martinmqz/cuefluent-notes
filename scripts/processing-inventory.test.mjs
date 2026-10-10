import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, proposedClaim } from './test-support/processing-fixture.mjs';
import { pendingProcessing } from './processing-inventory.mjs';
import { prepareProcessing, completeProcessing, inspectProcessing, saveProcessing, readProcessingPage, acknowledgeProcessingPages, proposeProcessing } from './processing.mjs';
import { executeWorkflow, workflowHelp, workflowErrorReport } from './workflow.mjs';
import { captureRelativePath } from './capture-contract.mjs';

test('pending and operation status read only metadata and create no lock/state files', async t => {
  const f = await processingFixture(t), before = await fs.readdir(f.collection.intakeStateDir);
  const writerBefore = await fs.readdir(f.collection.notes.writerStateDir);
  const raw = path.join(f.collection.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash)); await fs.unlink(raw);
  const pending = await pendingProcessing(f.capability, { selection: f.selection });
  assert.equal(pending.pending[0].headHash, f.published.headHash); assert.equal(pending.incomplete, false);
  assert.equal((await inspectProcessing(f.capability, randomUUID())).claim, null);
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
  assert.deepEqual(await fs.readdir(f.collection.notes.writerStateDir), writerBefore);
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, inputs: f.inputs }));
});

test('claims stay visible until cleanup and exact handled revisions leave pending inventory', async t => {
  const f = await processingFixture(t), claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  let pending = await pendingProcessing(f.capability, { selection: f.selection });
  assert.equal(pending.pending[0].status, 'claimed'); assert.equal(pending.operations[0].operationId, f.operationId);
  await assert.rejects(completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' },
    { fault: at => { if (at === 'disposition') throw new Error('crash'); } }), /crash/);
  pending = await pendingProcessing(f.capability, { selection: f.selection });
  assert.equal(pending.pending.length, 0); assert.equal(pending.handledCount, 1); assert.equal(pending.operations.length, 1);
  assert.equal(pending.operations[0].state, 'completed');
  assert.equal(pending.operations[0].recoveryRequired, true);
  assert.deepEqual(pending.counts, { scope: 'returned-head-page', pendingRevisions: 0, unclaimedRevisions: 0, claimedRevisions: 0, blockedByClaimRevisions: 0, handledRevisions: 1 });
});

test('public operation view distinguishes delivery, inspection, review and completion without claiming source completeness', async t => {
  const f = await processingFixture(t, { text: 'Synthetic evidence. '.repeat(4000) });
  let claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs, budget: { maxInputs: 5, maxPacketBytes: 4 * 1024 * 1024 } });
  let status = await inspectProcessing(f.capability, f.operationId);
  assert.equal(status.interfaceVersion, 1); assert.equal(status.state, 'unread');
  assert.equal(status.inspection.packetBytes, claim.packet.bytes);
  const issued = await readProcessingPage(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, page: 0 });
  status = await inspectProcessing(f.capability, f.operationId);
  assert.equal(status.state, 'unread'); assert.equal(status.inspection.issuedPages, 1);
  assert.equal(status.nextAction.page, 0);
  claim = await acknowledgeProcessingPages(f.capability, { ...f.args, expectedClaimHash: issued.claimHash, pages: [{ index: 0, hash: issued.hash }] });
  status = await inspectProcessing(f.capability, f.operationId);
  assert.equal(status.state, 'inspecting'); assert.equal(status.nextAction.page, 1);
  for (let page = 1; page < claim.packet.pages.length; page++) {
    const next = await readProcessingPage(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, page });
    claim = await acknowledgeProcessingPages(f.capability, { ...f.args, expectedClaimHash: next.claimHash, pages: [{ index: page, hash: next.hash }] });
  }
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'inspected');
  const proposal = await proposedClaim(f, { claim });
  status = await inspectProcessing(f.capability, f.operationId);
  assert.equal(status.state, 'awaiting-review'); assert.equal(status.sourceCompleteness, 'unknown');
  assert.equal(status.proposalHash, proposal.proposalHash);
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash, outcome: 'cancelled' });
  status = await inspectProcessing(f.capability, f.operationId);
  assert.equal(status.state, 'completed'); assert.equal(status.outcome, 'cancelled');
  assert.equal(status.nextAction, null); assert.equal(status.claim, null);
});

test('published draft differs from interrupted staging through the public CLI', async t => {
  const f = await processingFixture(t);
  const proposal = await proposedClaim(f);
  const request = { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash, args: { operationId: f.operationId } };
  assert.equal(workflowHelp().interfaceVersion, 1);
  const status = await executeWorkflow('processing-status', request, { configPath: f.options.configPath });
  assert.equal(status.state, 'awaiting-review'); assert.equal(status.proposalHash, proposal.proposalHash);
  const record = path.join(f.collection.notes.writerStateDir, 'proposals', f.operationId, 'record.json');
  await fs.unlink(record);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'draft-staging');
  await fs.unlink(proposal.contentPath);
  await executeWorkflow('processing-propose', { ...request, args: { ...f.args, expectedClaimHash: proposal.claimHash } }, { configPath: f.options.configPath });
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
});

test('pending pagination leaves omitted heads unhandled and does not imply native ordering', async t => {
  const f = await processingFixture(t), otherId = randomUUID();
  const directory = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId);
  const head = JSON.parse(await fs.readFile(path.join(directory, `${f.identity.unitId}.json`), 'utf8'));
  // Metadata-only discovery must not need raw bodies even for an incomplete page.
  head.identity.unitId = otherId;
  await fs.writeFile(path.join(directory, `${otherId}.json`), JSON.stringify(head), { mode: 0o600 });
  const first = await pendingProcessing(f.capability, { selection: f.selection, limit: 1 });
  assert.equal(first.pending.length, 1); assert.equal(first.incomplete, true); assert(first.nextCursor);
  const second = await pendingProcessing(f.capability, { selection: f.selection, limit: 1, afterUnitId: first.nextCursor });
  assert.equal(second.pending.length, 1); assert.equal(second.incomplete, false);
  assert.notEqual(first.pending[0].identity.unitId, second.pending[0].identity.unitId);
  assert.equal(first.handledCount + second.handledCount, 0);
});

test('metadata status refuses a concurrently changing claim and corrupt progress', async t => {
  const f = await processingFixture(t);
  await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const file = path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`);
  const original = await fs.readFile(file, 'utf8'), claim = JSON.parse(original);
  const open = fs.open; let reads = 0;
  fs.open = async (name, ...args) => {
    if (name === file && ++reads === 2) await fs.writeFile(file, JSON.stringify({ ...claim, issued: [0] }));
    return open(name, ...args);
  };
  try { await assert.rejects(inspectProcessing(f.capability, f.operationId), /PROCESSING_INVENTORY_CHANGED/); }
  finally { fs.open = open; }
  await fs.writeFile(file, JSON.stringify({ ...claim, acknowledged: [0] }));
  await assert.rejects(inspectProcessing(f.capability, f.operationId), /UNISSUED_PROCESSING_PAGE/);
});

test('head conflict remains visible without reading capture bodies', async t => {
  const f = await processingFixture(t);
  await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const file = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const head = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...head, generation: head.generation + 1 }));
  await fs.unlink(path.join(f.collection.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash)));
  const view = await pendingProcessing(f.capability, { selection: f.selection });
  assert.equal(view.operations[0].state, 'conflicted');
  assert.equal(view.operations[0].conflict, 'PROCESSING_HEAD_CHANGED');
  assert.equal(view.counts.claimedRevisions, 0); assert.equal(view.counts.blockedByClaimRevisions, 1);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).conflict, 'PROCESSING_HEAD_CHANGED');
  const later = await pendingProcessing(f.capability, { selection: f.selection, afterUnitId: f.identity.unitId });
  assert.equal(later.pending.length, 0); assert.equal(later.operations[0].conflict, 'PROCESSING_HEAD_CHANGED');
});

test('processing discovery and claims remain usable through parent aliases and after worktree deletion', async t => {
  const f = await processingFixture(t), alias = path.join(f.root, 'parent-alias');
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const selection = { ...f.selection, cwd: path.join(alias, 'project') + path.sep };
  await fs.rm(f.project, { recursive: true });
  assert.equal((await pendingProcessing(f.capability, { selection })).pending[0].headHash, f.published.headHash);
  f.args = { ...f.args, selection };
  const proposal = await proposedClaim(f);
  assert.equal((await saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash, approvedProposalHash: proposal.proposalHash })).status, 'saved');
  assert.match(await fs.readFile(proposal.target, 'utf8'), /rollout paused/);
  assert.equal((await pendingProcessing(f.capability, { selection })).pending.length, 0);
});

test('lexical pending pages reach heads beyond the first 4096 directory entries', async t => {
  const f = await processingFixture(t), directory = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId);
  const head = JSON.parse(await fs.readFile(path.join(directory, `${f.identity.unitId}.json`), 'utf8'));
  const ids = Array.from({ length: 4200 }, (_, index) => `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
  // Reverse creation order; lexical pagination must not depend on directory order.
  for (const unitId of [...ids].reverse()) await fs.writeFile(path.join(directory, `${unitId}.json`), JSON.stringify({ ...head, identity: { ...head.identity, unitId } }), { mode: 0o600 });
  const first = await pendingProcessing(f.capability, { selection: f.selection, afterUnitId: ids[0], limit: 1 });
  assert.equal(first.pending[0].identity.unitId, ids[1]); assert.equal(first.nextCursor, ids[1]);
  const all = [...ids, f.identity.unitId].sort(), after = all.at(-3);
  const last = await pendingProcessing(f.capability, { selection: f.selection, afterUnitId: after, limit: 2 });
  assert.deepEqual(last.pending.map(item => item.identity.unitId), all.slice(-2));
  assert.equal(last.incomplete, false); assert.equal(last.nextCursor, null);
});

test('oversized directory inventories fail explicitly instead of returning a partial lexical cursor', async t => {
  const f = await processingFixture(t), directory = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId), opendir = fs.opendir;
  fs.opendir = async (file, ...args) => file === directory ? (async function* () {
    for (let index = 0; index <= 65536; index++) yield { name: `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.json`, isFile: () => true };
  })() : opendir(file, ...args);
  try { await assert.rejects(pendingProcessing(f.capability, { selection: f.selection }), /PENDING_INVENTORY_CAPACITY/); }
  finally { fs.opendir = opendir; }
  assert.equal((await pendingProcessing(f.capability, { selection: { ...f.selection, unitId: f.identity.unitId } })).pending.length, 1);
});

test('a head removed during enumeration invalidates the page instead of hiding later candidates', async t => {
  const f = await processingFixture(t), file = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  const open = fs.open; let removed = false;
  fs.open = async (name, ...args) => {
    if (!removed && name === file) { removed = true; await fs.unlink(file); }
    return open(name, ...args);
  };
  try { await assert.rejects(pendingProcessing(f.capability, { selection: f.selection }), /PROCESSING_INVENTORY_CHANGED/); }
  finally { fs.open = open; }
  assert(removed);
  assert.equal((await pendingProcessing(f.capability, { selection: { ...f.selection, unitId: f.identity.unitId } })).pending.length, 0);
});


test('status after note replacement shows exact recovery and blocks other collection work', async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  const other = await processingFixture(t, { base: f });
  await prepareProcessing(other.capability, { ...other.args, inputs: other.inputs });
  await assert.rejects(saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash, approvedProposalHash: proposal.proposalHash },
    { fault: at => { if (at === 'afterReplace') throw new Error('crash'); } }), /crash/);
  assert.match(await fs.readFile(proposal.target, 'utf8'), /rollout paused/);
  const view = await inspectProcessing(f.capability, f.operationId);
  assert.equal(view.state, 'recovery-required'); assert(view.recoveryHash); assert.equal(view.nextAction.command, 'processing-recover');
  const blocked = await inspectProcessing(other.capability, other.operationId);
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.nextAction.command, null);
  assert(blocked.blockers.includes('PROCESSING_RECOVERY_REQUIRED'));
});

test('a corrupt proposal reports its operation identity without exposing its bytes', async t => {
  const f = await processingFixture(t); await proposedClaim(f);
  await fs.writeFile(path.join(f.collection.notes.writerStateDir, 'proposals', f.operationId, 'record.json'), '{');
  await assert.rejects(pendingProcessing(f.capability, { selection: f.selection }), error => {
    const report = workflowErrorReport(error);
    assert.equal(report.operationId, f.operationId);
    assert(!JSON.stringify(report).includes('record.json'));
    return true;
  });
});
