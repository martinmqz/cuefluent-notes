import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProcessingEngineTools } from './processing-engine-tools.mjs';
import { processingFixture, inspectedClaim } from './test-support/processing-fixture.mjs';
import { digest } from './workflow-values.mjs';
import { createProcessingWorkset, inspectProcessingWorkset, prepareWorksetBatch, worksetOperationId } from './processing-workset.mjs';
import { inspectProcessing, prepareProcessing } from './processing.mjs';
import { inspectNoteMetadata } from './note-metadata.mjs';
import { PROCESSING_GUIDES, processingToolDeclarations } from './processing-tool-contracts.mjs';
import { SKILL_ROOT } from './runtime-paths.mjs';

const adapter = f => createProcessingEngineTools({ ...f.options, selection: f.selection });
const markdown = '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n';
const proposal = (f, content = markdown) => ({ files: [{ path: 'meetings/rollout.md', expectedHash: null, content }],
  mappings: [{ identity: f.identity, paths: ['meetings/rollout.md'] }] });

test('restricted guidance delivers complete bounded bundled guides without arbitrary file access', async t => {
  const f = await processingFixture(t), tools = await adapter(f);
  const declared = processingToolDeclarations().find(tool => tool.name === 'guidance_read');
  assert.deepEqual(declared.inputSchema.properties.guide.enum, Object.keys(PROCESSING_GUIDES));
  assert.equal(declared.inputSchema.additionalProperties, false);
  for (const [guide, relative] of Object.entries(PROCESSING_GUIDES)) {
    const original = await fs.readFile(path.join(SKILL_ROOT, relative)), before = Date.now();
    const read = await tools.call('guidance_read', { guide });
    assert.equal(read.source, relative); assert.equal(read.content, original.toString('utf8'));
    assert.equal(read.bytes, original.length); assert.equal(read.hash, digest(original));
    assert(read.bytes <= 64 * 1024);
    assert(Date.parse(read.recordingContext.now) >= before && Date.parse(read.recordingContext.now) <= Date.now());
    assert.match(read.recordingContext.meaning, /Recording time only/);
  }
  for (const guide of ['../SKILL.md', 'references/authoring.md', path.join(f.root, 'private.json'), '__proto__', 'toString']) {
    await assert.rejects(tools.call('guidance_read', { guide }), { code: 'PROCESSING_GUIDANCE_NOT_ALLOWED' });
  }
  await assert.rejects(tools.call('guidance_read', { guide: 'authoring', path: f.options.configPath }), { code: 'INVALID_WORKFLOW' });
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'missing');
});

test('oversized or redirected bundled guidance fails instead of truncating or following another directory', async t => {
  const f = await processingFixture(t), tools = await adapter(f), file = path.join(SKILL_ROOT, PROCESSING_GUIDES.authoring);
  const lstat = fs.lstat;
  const large = t.mock.method(fs, 'lstat', async (name, ...args) => {
    const stat = await lstat(name, ...args);
    return name === file ? Object.assign(Object.create(stat), { size: 65537n }) : stat;
  });
  await assert.rejects(tools.call('guidance_read', { guide: 'authoring' }), { code: 'FILE_SIZE_LIMIT_EXCEEDED' });
  large.mock.restore();
  const realpath = fs.realpath;
  t.mock.method(fs, 'realpath', async (name, ...args) => name === path.dirname(file) ? f.root : realpath(name, ...args));
  await assert.rejects(tools.call('guidance_read', { guide: 'authoring' }), { code: 'PROCESSING_GUIDANCE_INVALID' });
});

test('restricted prepare_note uses runtime recording metadata and cannot accept invented dates or versions', async t => {
  const f = await processingFixture(t), tools = await adapter(f);
  const pkg = JSON.parse(await fs.readFile(path.join(SKILL_ROOT, 'package.json'), 'utf8'));
  const guide = await tools.call('guidance_read', { guide: 'metadata' });
  assert.equal(guide.recordingContext.skillVersion, pkg.version);
  const before = Date.now(), prepared = await tools.call('prepare_note', { original: null, content: markdown });
  const metadata = inspectNoteMetadata(prepared.content);
  assert.equal(metadata.status, 'valid'); assert.equal(metadata.value.generation.skill_version, pkg.version);
  assert(Date.parse(metadata.value.created) >= before && Date.parse(metadata.value.created) <= Date.now());
  assert.equal(metadata.value.updated, metadata.value.created);
  assert.equal(Object.hasOwn(metadata.value, 'period'), false);
  assert(prepared.content.endsWith(markdown));
  for (const extra of [{ now: '1999-01-01T00:00:00.000Z' }, { skillVersion: '99.0.0' }]) {
    await assert.rejects(tools.call('prepare_note', { original: null, content: markdown, ...extra }), { code: 'INVALID_WORKFLOW' });
  }
  f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  await assert.rejects(tools.call('guidance_read', { guide: 'metadata' }), { code: 'WORKFLOW_POLICY_CHANGED' });
  await assert.rejects(tools.call('prepare_note', { original: null, content: markdown }), { code: 'WORKFLOW_POLICY_CHANGED' });
});

test('restricted adapter exposes processing only, binds immutable context, and refuses forged scope and approval', async t => {
  const f = await processingFixture(t), context = { ...f.options, selection: { ...f.selection } };
  const tools = await createProcessingEngineTools(context);
  context.selection.sessionId = randomUUID(); context.configPath = path.join(f.root, 'unselected.json');
  assert.equal((await tools.call('processing_pending')).pending[0].identity.sessionId, f.identity.sessionId);
  for (const name of ['configure', 'direct-save', 'fingerprint', 'capture-run', 'processing_save', 'processing_recover', 'unknown']) {
    await assert.rejects(tools.call(name, {}), { code: 'PROCESSING_TOOL_NOT_ALLOWED' });
    assert(!tools.toolNames.includes(name));
  }
  await assert.rejects(tools.call('processing_pending', { selection: context.selection }), { code: 'INVALID_WORKFLOW' });
  await assert.rejects(tools.call('processing_pending', { configPath: context.configPath }), { code: 'INVALID_WORKFLOW' });
  await assert.rejects(tools.call('processing_propose', { operationId: f.operationId, expectedClaimHash: '0'.repeat(64), approved: true }), { code: 'INVALID_WORKFLOW' });
  await assert.rejects(tools.call('processing_prepare', { operationId: f.operationId,
    inputs: [{ ...f.inputs[0], identity: { ...f.identity, sessionId: randomUUID() } }] }), { code: 'PROCESSING_SELECTION_CHANGED' });
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'missing');
});

test('adapter completes exact evidence inspection and unchanged disposition without a shell or another claim', async t => {
  const f = await processingFixture(t), tools = await adapter(f);
  let claim = await tools.call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  await assert.rejects(tools.call('processing_complete', { operationId: f.operationId, expectedClaimHash: claim.claimHash }), { code: 'PROCESSING_INSPECTION_INCOMPLETE' });
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await tools.call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page });
    assert(read.evidence.text.includes('Synthetic meeting'));
    claim = await tools.call('processing_ack', { operationId: f.operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  await tools.call('processing_complete', { operationId: f.operationId, expectedClaimHash: claim.claimHash });
  const complete = await tools.call('processing_status', { operationId: f.operationId });
  assert.equal(complete.state, 'completed'); assert.equal(complete.outcome, 'unchanged');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('adapter stages inline drafts in the existing writer and creates an ordinary immutable proposal without saving notes', async t => {
  const f = await processingFixture(t), tools = await adapter(f), claim = await inspectedClaim(f);
  const result = await tools.call('processing_propose', { operationId: f.operationId, expectedClaimHash: claim.claimHash, proposal: proposal(f) });
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'awaiting-review');
  assert.equal(await fs.readFile(result.plan.files[0].contentPath, 'utf8'), markdown);
  assert.equal(result.plan.stateDir, f.collection.notes.writerStateDir);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  assert(!(await fs.readdir(path.join(f.collection.notes.writerStateDir, 'processing-stages'))).some(name => name.startsWith('adapter-')));
  await assert.rejects(tools.call('processing_complete', { operationId: f.operationId, expectedClaimHash: result.claimHash }), { code: 'PROCESSING_REVIEW_REQUIRED' });
  const retry = await tools.call('processing_propose', { operationId: f.operationId, expectedClaimHash: result.claimHash, proposal: proposal(f) });
  assert.equal(retry.proposalHash, result.proposalHash);
  await assert.rejects(tools.call('processing_propose', { operationId: f.operationId, expectedClaimHash: result.claimHash,
    proposal: proposal(f, '# Changed\n\n## Decision\nDifferent text.\n') }), { code: 'PROCESSING_PROPOSAL_CHANGED' });
  assert.equal(await fs.readFile(result.plan.files[0].contentPath, 'utf8'), markdown);
});

test('inline draft validation refuses arbitrary paths, stale claims, oversized bytes, and unmapped files', async t => {
  const f = await processingFixture(t), tools = await adapter(f), claim = await inspectedClaim(f);
  const request = { operationId: f.operationId, expectedClaimHash: claim.claimHash, proposal: proposal(f) };
  const arbitrary = structuredClone(request); arbitrary.proposal.files[0].contentPath = path.join(f.root, 'secret.md');
  await assert.rejects(tools.call('processing_propose', arbitrary), { code: 'INVALID_WORKFLOW' });
  const escape = structuredClone(request); escape.proposal.files[0].path = '../secret.md';
  await assert.rejects(tools.call('processing_propose', escape), { code: 'INVALID_PROCESSING_OUTPUT' });
  await assert.rejects(tools.call('processing_propose', { ...request, expectedClaimHash: '0'.repeat(64) }), { code: 'PROCESSING_CLAIM_CHANGED' });
  const oversized = proposal(f, 'é'.repeat(500000));
  await assert.rejects(tools.call('processing_propose', { ...request, proposal: oversized }), { code: 'PROCESSING_PROPOSAL_CAPACITY' });
  const unmapped = structuredClone(request); unmapped.proposal.mappings = [];
  await assert.rejects(tools.call('processing_propose', unmapped));
  assert.equal((await inspectProcessing(f.capability, f.operationId)).state, 'inspected');
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('bounded note discovery and exact reads remain inside the selected notes root', async t => {
  const f = await processingFixture(t), tools = await adapter(f), notes = f.collection.notes.notesDir;
  await fs.mkdir(path.join(notes, 'meetings')); await fs.mkdir(path.join(notes, 'custom'));
  await fs.writeFile(path.join(notes, 'a.md'), markdown); await fs.writeFile(path.join(notes, 'z.markdown'), 'Another note');
  await fs.writeFile(path.join(notes, 'ignored.json'), 'not a note');
  await fs.writeFile(path.join(notes, 'meetings', 'review.md'), '\uFEFF# Review\r\n');
  const first = await tools.call('note_list', { limit: 2 });
  assert.deepEqual(first.entries, [{ path: 'a.md', kind: 'note' }, { path: 'custom', kind: 'directory' }]);
  assert.equal(first.incomplete, true);
  const second = await tools.call('note_list', { limit: 2, afterPath: first.nextCursor });
  assert.deepEqual(second.entries, [{ path: 'meetings', kind: 'directory' }, { path: 'z.markdown', kind: 'note' }]);
  assert.equal(second.incomplete, false);
  const read = await tools.call('note_read', { path: 'meetings/review.md' });
  assert.equal(read.content, '\uFEFF# Review\r\n'); assert.equal(read.hash, digest(Buffer.from(read.content)));
  await fs.mkdir(path.join(notes, '!custom')); await fs.writeFile(path.join(notes, '!custom', 'topic.md'), markdown);
  assert.equal((await tools.call('note_read', { path: '!custom/topic.md' })).content, markdown);
  assert.deepEqual(await tools.call('note_read', { path: 'decisions/new.md' }), { path: 'decisions/new.md', content: null, hash: null, bytes: 0 });
  for (const name of ['../outside.md', path.join(f.root, 'outside.md'), 'meetings/../../outside.md', 'meetings\\review.md']) {
    await assert.rejects(tools.call('note_read', { path: name }), { code: 'INVALID_PROCESSING_OUTPUT' });
  }
  await assert.rejects(tools.call('note_list', { directory: '..' }), { code: 'INVALID_PROCESSING_OUTPUT' });
  await fs.link(path.join(notes, 'a.md'), path.join(f.root, 'outside-link.md'));
  await assert.rejects(tools.call('note_read', { path: 'a.md' }), { code: 'FILE_LINK_COUNT_INVALID' });
});

test('note reads reject replacement during reads and adapter loses authority when settings change', async t => {
  const f = await processingFixture(t), tools = await adapter(f), file = path.join(f.collection.notes.notesDir, 'note.md');
  await fs.writeFile(file, markdown);
  const open = fs.open;
  fs.open = async (name, ...args) => {
    const handle = await open(name, ...args);
    if (name === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => { const result = await read(...args); await fs.appendFile(file, 'Changed'); return result; };
    }
    return handle;
  };
  try { await assert.rejects(tools.call('note_read', { path: 'note.md' }), { code: 'PROCESSING_NOTE_CHANGED' }); }
  finally { fs.open = open; }
  f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  await assert.rejects(tools.call('note_read', { path: 'note.md' }), { code: 'WORKFLOW_POLICY_CHANGED' });
  await assert.rejects(tools.call('processing_pending'), { code: 'WORKFLOW_POLICY_CHANGED' });
});

test('an adapter cannot read a foreign session operation or a broader preexisting claim', async t => {
  const f = await processingFixture(t), other = await processingFixture(t, { base: f }), tools = await adapter(f);
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: [...f.inputs, ...other.inputs] });
  const pending = await tools.call('processing_pending');
  assert.deepEqual(pending.operations[0], { operationId: f.operationId, state: 'unread', resumeSupported: false,
    diagnostic: 'PROCESSING_SELECTION_CHANGED', nextAction: 'inspect-with-original-selection' });
  await assert.rejects(tools.call('processing_status', { operationId: f.operationId }), { code: 'PROCESSING_SELECTION_CHANGED' });
  await assert.rejects(tools.call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page: 0 }), { code: 'PROCESSING_SELECTION_CHANGED' });
  assert.deepEqual((await inspectProcessing(f.capability, f.operationId)).claim.issued, []);
});

test('explicit-file destinations cannot list or read neighboring notes and replacement roots revoke adapter reads', async t => {
  const f = await processingFixture(t), notes = f.collection.notes.notesDir;
  await fs.writeFile(path.join(notes, 'selected.md'), markdown); await fs.writeFile(path.join(notes, 'neighbor.md'), 'Other subject');
  delete f.collection.notes.notesDir; f.collection.notes.destination = path.join(notes, 'selected.md');
  const configBytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, configBytes);
  f.options.expectedConfigHash = digest(configBytes);
  const tools = await adapter(f);
  assert.deepEqual((await tools.call('note_list')).entries, [{ path: 'selected.md', kind: 'note' }]);
  assert.equal((await tools.call('note_read', { path: 'selected.md' })).content, markdown);
  await assert.rejects(tools.call('note_read', { path: 'neighbor.md' }), { code: 'PROCESSING_DESTINATION_MISMATCH' });
  await fs.rename(notes, notes + '-old'); await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, 'selected.md'), 'Replacement root');
  await assert.rejects(tools.call('note_read', { path: 'selected.md' }), { code: 'PROCESSING_NOTES_ROOT_CHANGED' });
});


test('a narrower unfinished CLI claim resumes with its exact selection through the session adapter', async t => {
  const f = await processingFixture(t), selection = { ...f.selection, unitId: f.identity.unitId };
  let claim = await prepareProcessing(f.capability, { selection, operationId: f.operationId, inputs: f.inputs });
  const tools = await adapter(f), pending = await tools.call('processing_pending');
  assert.equal(pending.operations[0].resumeSupported, true);
  assert.equal((await tools.call('processing_status', { operationId: f.operationId })).selection.unitId, f.identity.unitId);
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await tools.call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page });
    claim = await tools.call('processing_ack', { operationId: f.operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  const done = await tools.call('processing_propose', { operationId: f.operationId, expectedClaimHash: claim.claimHash, proposal: proposal(f) });
  assert.equal(typeof done.proposalHash, 'string');
  const saved = await inspectProcessing(f.capability, f.operationId);
  assert.equal(saved.state, 'awaiting-review');
  assert.equal(saved.selection.unitId, f.identity.unitId);
});


test('workset-bound tools reject new evidence, invented operation IDs, policy drift and extra authority', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a, client: 'claude' });
  const worksetId = randomUUID();
  await createProcessingWorkset(a.capability, { selection: a.selection, worksetId, inputs: b.inputs });
  const tools = await createProcessingEngineTools({ ...a.options, selection: a.selection, worksetId });
  await assert.rejects(tools.call('processing_prepare', { operationId: randomUUID(), inputs: a.inputs }), { code: 'PROCESSING_SELECTION_CHANGED' });
  await assert.rejects(tools.call('processing_prepare', { operationId: randomUUID(), inputs: b.inputs }), { code: 'PROCESSING_OPERATION_CONFLICT' });
  await assert.rejects(tools.call('processing_pending', { limit: 0 }), { code: 'INVALID_PENDING_LIMIT' });
  await assert.rejects(tools.call('processing_pending', { afterUnitId: a.identity.unitId }), { code: 'PROCESSING_WORKSET_CURSOR_UNSUPPORTED' });
  await assert.rejects(tools.call('processing_pending', { approve: true }), { code: 'INVALID_WORKFLOW' });
  assert.equal((await inspectProcessingWorkset(a.capability, { worksetId })).chargedBatches, 0);
  const preparation = (await tools.call('processing_pending')).nextPreparation;
  assert.equal(preparation.operationId, worksetOperationId(worksetId, [0]));
  const claim = await tools.call('processing_prepare', preparation);
  assert.deepEqual(claim.inputs.map(item => item.identity), [b.identity]);
  // Changing only recorded settings still revokes this context's pinned authority.
  const bytes = await fs.readFile(a.options.configPath); await fs.writeFile(a.options.configPath, Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(tools.call('processing_page', { operationId: claim.operationId, expectedClaimHash: claim.claimHash, page: 0 }), { code: 'WORKFLOW_POLICY_CHANGED' });
});

test('workset preparation enforces its byte budget without charging rejected evidence', async t => {
  const f = await processingFixture(t, { text: 'Synthetic long evidence. '.repeat(4000) }), worksetId = randomUUID();
  await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs,
    runBudget: { maxBatches: 2, maxPacketBytes: 65536 } });
  const tools = await createProcessingEngineTools({ ...f.options, selection: f.selection, worksetId });
  const preparation = (await tools.call('processing_pending')).nextPreparation;
  await assert.rejects(tools.call('processing_prepare', preparation), { code: 'PROCESSING_BATCH_BUDGET' });
  const workset = await inspectProcessingWorkset(f.capability, { worksetId });
  assert.equal(workset.chargedBatches, 0); assert.equal(workset.operations.length, 0);
});


test('bound tools retry exact interrupted admission and refuse skipping to another batch', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a }), worksetId = randomUUID();
  const created = await createProcessingWorkset(a.capability, { selection: a.selection, worksetId, inputs: [...a.inputs, ...b.inputs] });
  await assert.rejects(prepareWorksetBatch(a.capability, { worksetId, expectedWorksetHash: created.worksetHash, indexes: [0] },
    { fault: () => { throw new Error('synthetic crash'); } }), /synthetic crash/);
  const tools = await createProcessingEngineTools({ ...a.options, selection: a.selection, worksetId });
  const pending = await tools.call('processing_pending');
  assert.equal(pending.operations[0].admissionPending, true);
  assert.deepEqual(pending.nextPreparation, { operationId: worksetOperationId(worksetId, [0]), inputs: a.inputs });
  await assert.rejects(tools.call('processing_prepare', { operationId: worksetOperationId(worksetId, [1]), inputs: b.inputs }), { code: 'PROCESSING_RESUME_REQUIRED' });
  const claim = await tools.call('processing_prepare', pending.nextPreparation);
  assert.equal(claim.workset.chargedBatches, 1);
  assert.equal((await tools.call('processing_pending')).nextPreparation, null);
});

test('oversized multi-input preparation offers a fitting exact prefix without charging the rejection', async t => {
  const a = await processingFixture(t, { text: 'Synthetic bounded evidence. '.repeat(1400) });
  const b = await processingFixture(t, { base: a, text: 'Other synthetic evidence. '.repeat(1400) }), worksetId = randomUUID();
  await createProcessingWorkset(a.capability, { selection: a.selection, worksetId, inputs: [...a.inputs, ...b.inputs],
    runBudget: { maxBatches: 3, maxPacketBytes: 65536 } });
  const tools = await createProcessingEngineTools({ ...a.options, selection: a.selection, worksetId });
  await assert.rejects(tools.call('processing_prepare', (await tools.call('processing_pending')).nextPreparation), { code: 'PROCESSING_BATCH_BUDGET' });
  assert.equal((await inspectProcessingWorkset(a.capability, { worksetId })).chargedBatches, 0);
  const fitting = (await tools.call('processing_pending')).nextPreparation;
  assert.deepEqual(fitting, { operationId: worksetOperationId(worksetId, [0]), inputs: a.inputs });
  assert.equal((await tools.call('processing_prepare', fitting)).workset.chargedBatches, 1);
});

test('per-run packet budget pauses a fitting workset remainder and a fresh adapter resumes it', async t => {
  const a = await processingFixture(t, { text: 'Synthetic bounded evidence. '.repeat(1400) });
  const b = await processingFixture(t, { base: a, text: 'Other synthetic evidence. '.repeat(1400) }), worksetId = randomUUID();
  await createProcessingWorkset(a.capability, { selection: a.selection, worksetId, inputs: [...a.inputs, ...b.inputs] });
  const context = { ...a.options, selection: a.selection, worksetId };
  const tools = await createProcessingEngineTools(context, { runBudget: { maxOperations: 3, maxPacketBytes: 65536, maxElapsedMs: 60000 } });
  await assert.rejects(tools.call('processing_prepare', (await tools.call('processing_pending')).nextPreparation), { code: 'PROCESSING_BATCH_BUDGET' });
  let claim = await tools.call('processing_prepare', (await tools.call('processing_pending')).nextPreparation);
  const operationId = claim.operationId;
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await tools.call('processing_page', { operationId, expectedClaimHash: claim.claimHash, page });
    claim = await tools.call('processing_ack', { operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  await tools.call('processing_complete', { operationId, expectedClaimHash: claim.claimHash });
  const stopped = await tools.call('processing_pending');
  assert.equal(stopped.reason, 'run-budget'); assert.equal(stopped.nextPreparation, null);
  const reopened = await createProcessingEngineTools(context);
  assert.deepEqual((await reopened.call('processing_pending')).nextPreparation.inputs, b.inputs);
});
