import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, inspectedClaim } from './test-support/processing-fixture.mjs';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { selectProcessingShortcut, inspectProcessingShortcut, cancelProcessingShortcut } from './processing-shortcuts.mjs';
import { prepareProcessing, completeProcessing, inspectProcessing } from './processing.mjs';
import { prepareWorksetBatch } from './processing-workset.mjs';
import { executeWorkflow } from './workflow.mjs';

const select = (f, args = {}) => selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID(), ...args });
async function repository(base, name) {
  const project = path.join(base.project, name); await fs.mkdir(path.join(project, '.git'), { recursive: true });
  return { ...base, project };
}
async function finish(f, operationId) {
  const claim = await inspectProcessing(f.capability, operationId);
  return completeProcessing(f.capability, { selection: claim.selection, operationId, expectedClaimHash: claim.claimHash, outcome: 'skipped' });
}

test('collection shortcut freezes both clients and resumes without adding later arrivals or changing settings', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f, client: 'claude' });
  const settings = await fs.readFile(f.options.configPath);
  const chosen = await select(f);
  assert.equal(chosen.scope.kind, 'collection'); assert.equal(chosen.counts.selected, 2);
  assert.equal(chosen.worksets.length, 1); assert.deepEqual(chosen.nextRun, { worksetId: chosen.worksets[0].worksetId });
  assert.deepEqual(new Set(chosen.worksets[0].inputs.map(item => item.identity.sessionId)), new Set([f.identity.sessionId, b.identity.sessionId]));
  await processingFixture(t, { base: f });
  const resumed = await select(f, { mode: 'resume' });
  assert.equal(resumed.requestId, chosen.requestId); assert.equal(resumed.checkpointHash, chosen.checkpointHash);
  assert.equal(resumed.counts.selected, 2); assert.equal(resumed.operations.length, 0);
  assert.deepEqual(await fs.readFile(f.options.configPath), settings);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('repo and chat scopes preserve existing broad selections instead of silently replacing them', async t => {
  const base = await storageFixture(t, { fullSetup: false });
  const a = await processingFixture(t, { base: await repository(base, 'orchid') });
  const b = await processingFixture(t, { base: await repository(base, 'cedar'), client: 'claude' });
  const repo = await select(a, { scope: 'repo' });
  assert.deepEqual(repo.worksets[0].inputs.map(item => item.identity), [a.identity]);
  await assert.rejects(select(b, { scope: 'chat' }), { code: 'PROCESSING_SHORTCUT_SCOPE_CONFLICT' });
  assert.equal((await select(b)).requestId, repo.requestId, 'collection process resumes an existing narrower selection first');
  assert.equal((await inspectProcessingShortcut(a.capability, { selection: a.selection })).checkpointHash, repo.checkpointHash);
});

test('CLI resume without unfinished work never creates a selection or claims newly arrived evidence', async t => {
  const f = await processingFixture(t), requestId = randomUUID();
  const result = await executeWorkflow('processing-shortcut-select', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { selection: f.selection, requestId, mode: 'resume' } }, { configPath: f.options.configPath });
  assert.equal(result.reason, 'nothing-to-resume'); assert.equal(result.checkpointHash, null);
  const status = await executeWorkflow('processing-shortcut-status', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { selection: f.selection } }, { configPath: f.options.configPath });
  assert.equal(status.phase, 'missing');
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'missing');
});

test('legacy unfinished operation is resumed exactly before the frozen unclaimed remainder', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f, client: 'claude' });
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const chosen = await selectProcessingShortcut(b.capability, { selection: b.selection, requestId: randomUUID() },
    { canResumeOperation: async id => id === f.operationId });
  assert.deepEqual(chosen.nextRun, { resumeOperationId: f.operationId });
  assert.equal(chosen.worksets.length, 0); assert.equal(chosen.counts.selected, 1);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
  await finish(f, f.operationId);
  const next = await select(b, { mode: 'resume' });
  assert.equal(next.requestId, chosen.requestId); assert.equal(next.worksets.length, 1);
  assert.deepEqual(next.worksets[0].inputs.map(item => item.identity), [b.identity]);
});

test('handled evidence is not readmitted; exact completed request replay does not expand its selection', async t => {
  const f = await processingFixture(t), inspected = await inspectedClaim(f);
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: inspected.claimHash, outcome: 'unchanged' });
  const requestId = randomUUID(), empty = await select(f, { requestId });
  assert.equal(empty.nextRun, null); assert.equal(empty.counts.selected, 0);
  const b = await processingFixture(t, { base: f });
  const replay = await select(f, { requestId });
  assert.equal(replay.checkpointHash, empty.checkpointHash); assert.equal(replay.counts.selected, 0);
  const fresh = await select(f);
  assert.deepEqual(fresh.worksets[0].inputs.map(item => item.identity), [b.identity]);
});

test('cancel requires internal stop verification and leaves retained evidence pending', async t => {
  const f = await processingFixture(t), chosen = await select(f), workset = chosen.worksets[0];
  const claim = await prepareWorksetBatch(f.capability, { worksetId: workset.worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  const args = { selection: f.selection, expectedCheckpointHash: chosen.checkpointHash };
  await assert.rejects(cancelProcessingShortcut(f.capability, args), { code: 'PROCESSING_CANCEL_UNVERIFIED' });
  await assert.rejects(cancelProcessingShortcut(f.capability, args, { assertStopped: async () => { throw new Error('still running'); } }), /still running/);
  assert.equal((await inspectProcessing(f.capability, claim.operationId)).claimHash, claim.claimHash);
  const cancelled = await cancelProcessingShortcut(f.capability, args, { assertStopped: async () => {},
    canResumeOperation: async id => id === claim.operationId });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal((await inspectProcessing(f.capability, claim.operationId)).outcome, 'cancelled');
  const resume = await select(f, { mode: 'resume' });
  assert.equal(resume.reason, 'nothing-to-resume');
  const fresh = await select(f);
  assert.deepEqual(fresh.worksets[0].inputs.map(item => item.identity), [f.identity]);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('selection crosses metadata source-page boundaries instead of stopping after the first page', async t => {
  const f = await processingFixture(t);
  for (let i = 0; i < 32; i++) await processingFixture(t, { base: f });
  const chosen = await select(f);
  assert.equal(chosen.counts.selected, 33); assert.equal(chosen.incomplete, false);
  assert.equal(chosen.worksets[0].inputs.length, 33);
  assert.equal(new Set(chosen.worksets[0].inputs.map(input => input.identity.sessionId)).size, 33);
});

test('an exhausted workset continues with the exact unattempted frozen remainder', async t => {
  const f = await processingFixture(t), b = await processingFixture(t, { base: f });
  const chosen = await select(f), workset = chosen.worksets[0];
  const file = path.join(f.collection.notes.writerStateDir, 'processed', 'worksets', `${workset.worksetId}.json`);
  const value = JSON.parse(await fs.readFile(file)); value.budget.maxBatches = 1;
  const { canonicalJSON } = await import('./workflow-values.mjs');
  await fs.writeFile(file, canonicalJSON(value) + '\n');
  const { inspectProcessingWorkset } = await import('./processing-workset.mjs');
  const bounded = await inspectProcessingWorkset(f.capability, { worksetId: workset.worksetId });
  const admitted = await prepareWorksetBatch(f.capability, { worksetId: bounded.worksetId, expectedWorksetHash: bounded.worksetHash, indexes: [0] });
  await finish(f, admitted.operationId);
  await processingFixture(t, { base: f, client: 'claude' });
  const next = await select(f, { mode: 'resume' });
  assert.equal(next.worksets.length, 2); assert.equal(next.counts.selected, 2);
  assert.equal(next.counts.handled, 1);
  assert.deepEqual(next.worksets[1].inputs, [bounded.inputs[1]]);
  assert([f.identity.sessionId, b.identity.sessionId].includes(next.worksets[1].inputs[0].identity.sessionId));
});

test('interrupted cancellation gates native admission and resumes without discarding claims', async t => {
  const f = await processingFixture(t), chosen = await select(f), workset = chosen.worksets[0];
  const admitted = await prepareWorksetBatch(f.capability, { worksetId: workset.worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  let checks = 0;
  await assert.rejects(cancelProcessingShortcut(f.capability, { selection: f.selection, expectedCheckpointHash: chosen.checkpointHash }, {
    canResumeOperation: async id => id === admitted.operationId,
    assertStopped: async () => { if (++checks === 2) throw Object.assign(new Error('interrupted'), { code: 'SYNTHETIC_INTERRUPTION' }); }
  }), { code: 'SYNTHETIC_INTERRUPTION' });
  const pending = await inspectProcessingShortcut(f.capability, { selection: f.selection });
  assert.equal(pending.phase, 'cancelling');
  assert.equal((await inspectProcessing(f.capability, admitted.operationId)).outcome, null);
  const { assertProcessingShortcutExecution } = await import('./processing-shortcuts.mjs');
  await assert.rejects(assertProcessingShortcutExecution(f.capability), { code: 'PROCESSING_CANCELLATION_PENDING' });
  const cancelled = await cancelProcessingShortcut(f.capability, { selection: f.selection, expectedCheckpointHash: pending.checkpointHash }, {
    assertStopped: async () => {}, canResumeOperation: async id => id === admitted.operationId });
  assert.equal(cancelled.phase, 'cancelled');
  await assert.rejects(assertProcessingShortcutExecution(f.capability, { worksetId: workset.worksetId }), { code: 'PROCESSING_CANCELLATION_PENDING' });
  assert.equal((await inspectProcessing(f.capability, admitted.operationId)).outcome, 'cancelled');
});

async function changedPolicy(f) {
  const { digest } = await import('./workflow-values.mjs');
  const { verifyWorkflowStorage } = await import('./workflow-storage.mjs');
  const config = structuredClone(f.config); config.routes[0].processing.scope = `Synthetic subject ${randomUUID()}`;
  const bytes = JSON.stringify(config); await fs.writeFile(f.options.configPath, bytes);
  const options = { ...f.options, expectedConfigHash: digest(bytes) };
  return { ...f, config, options, capability: await verifyWorkflowStorage(options) };
}

test('fresh selection after a settings change replaces finished or cancelled checkpoints without resetting unfinished work', async t => {
  const f = await processingFixture(t), chosen = await select(f);
  const current = await changedPolicy(f);
  await assert.rejects(select(current), { code: 'WORKFLOW_POLICY_CHANGED' });
  assert.equal((await inspectProcessingShortcut(current.capability, { selection: f.selection })).checkpointHash, chosen.checkpointHash);
  const cancelled = await cancelProcessingShortcut(current.capability, { selection: f.selection, expectedCheckpointHash: chosen.checkpointHash }, { assertStopped: async () => {} });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal((await select(current)).counts.selected, 1);
  const selected = await inspectProcessingShortcut(current.capability, { selection: f.selection });
  const workset = selected.worksets[0];
  const prepared = await prepareWorksetBatch(current.capability, { worksetId: workset.worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  await finish(current, prepared.operationId);
  current.config.routes[0].processing.scope = 'Before another synthetic policy change';
  const renewed = await changedPolicy(current);
  const empty = await select(renewed);
  assert.equal(empty.counts.selected, 0); assert.equal(empty.nextRun, null);
});

test('unowned standalone claims cannot be adopted for shortcut processing', async t => {
  const f = await processingFixture(t);
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  for (const mode of ['process', 'resume']) {
    const result = await select(f, { mode });
    assert.deepEqual(result.blockers, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    assert.equal(result.nextRun, null); assert.equal(result.checkpointHash, null);
  }
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
});

test('workset membership does not authorize resume or cancel of a standalone claim', async t => {
  const f = await processingFixture(t), chosen = await select(f), workset = chosen.worksets[0];
  const claim = await prepareWorksetBatch(f.capability, { worksetId: workset.worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] });
  const checked = [], canResumeOperation = async id => { checked.push(id); return false; };
  const resumed = await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID(), mode: 'resume' }, { canResumeOperation });
  assert.deepEqual(checked, [claim.operationId]);
  assert.equal(resumed.nextRun, null); assert.deepEqual(resumed.blockers, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
  await assert.rejects(cancelProcessingShortcut(f.capability, { selection: f.selection, expectedCheckpointHash: chosen.checkpointHash },
    { assertStopped: async () => {}, canResumeOperation }), { code: 'PROCESSING_CANCEL_UNVERIFIED' });
  assert.deepEqual(checked, [claim.operationId, claim.operationId]);
  assert.equal((await inspectProcessing(f.capability, claim.operationId)).claimHash, claim.claimHash);
  assert.equal((await inspectProcessingShortcut(f.capability, { selection: f.selection })).checkpointHash, chosen.checkpointHash);
  const allowed = await selectProcessingShortcut(f.capability, { selection: f.selection, requestId: randomUUID(), mode: 'resume' },
    { canResumeOperation: async id => id === claim.operationId });
  assert.deepEqual(allowed.nextRun, { worksetId: workset.worksetId });
});

test('charged workset admissions without a published claim remain resumable and cancellable', async t => {
  const f = await processingFixture(t), chosen = await select(f), workset = chosen.worksets[0];
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId: workset.worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0] },
    { fault: at => { if (at === 'workset-admission') throw new Error('interrupted admission'); } }), /interrupted admission/);
  const resumed = await select(f, { mode: 'resume' });
  assert.deepEqual(resumed.nextRun, { worksetId: workset.worksetId });
  assert.equal(resumed.operations[0].admissionPending, true); assert.equal(resumed.operations[0].claimHash, null);
  const cancelled = await cancelProcessingShortcut(f.capability, { selection: f.selection, expectedCheckpointHash: chosen.checkpointHash },
    { assertStopped: async () => {} });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal((await inspectProcessing(f.capability, resumed.operations[0].operationId)).state, 'missing');
});

test('collections sharing a writer keep separate shortcut checkpoints and execution gates', async t => {
  const base = await storageFixture(t, { fullSetup: false });
  const { digest } = await import('./workflow-values.mjs');
  const { prepareWorkflowStorage, verifyWorkflowStorage } = await import('./workflow-storage.mjs');
  const other = { ...base.collection, id: 'other', rawDir: path.join(base.root, 'other-raw'), intakeStateDir: path.join(base.root, 'other-state') };
  const project = path.join(base.root, 'other-project'); await fs.mkdir(project);
  const config = structuredClone(base.config); config.collections.push(other);
  config.routes.push({ ...config.routes[0], id: 'other', collectionId: 'other', projectRoot: project });
  const bytes = JSON.stringify(config); await fs.writeFile(base.options.configPath, bytes);
  const options = { ...base.options, expectedConfigHash: digest(bytes) };
  const a = await processingFixture(t, { base: { ...base, config, options, capability: await verifyWorkflowStorage(options) } });
  const otherOptions = { ...options, collectionId: 'other' };
  const b = await processingFixture(t, { base: { ...base, config, project, collection: other, options: otherOptions,
    capability: await prepareWorkflowStorage(otherOptions) } });
  const first = await select(a), second = await select(b);
  assert.notEqual(first.checkpointHash, second.checkpointHash);
  assert.deepEqual(first.worksets[0].inputs, a.inputs); assert.deepEqual(second.worksets[0].inputs, b.inputs);
  await cancelProcessingShortcut(a.capability, { selection: a.selection, expectedCheckpointHash: first.checkpointHash }, { assertStopped: async () => {} });
  const { assertProcessingShortcutExecution } = await import('./processing-shortcuts.mjs');
  await assertProcessingShortcutExecution(b.capability, second.nextRun);
  assert.equal((await inspectProcessingShortcut(b.capability, { selection: b.selection })).checkpointHash, second.checkpointHash);
});
