import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { processingFixture, inspectedClaim, proposedClaim } from './test-support/processing-fixture.mjs';
import { pendingCollectionProcessing, processingScope } from './processing-collection.mjs';
import { prepareProcessing, completeProcessing, saveProcessing } from './processing.mjs';
import { createProcessingWorkset, prepareWorksetBatch } from './processing-workset.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { executeWorkflow } from './workflow.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';

async function repository(base, name) {
  const project = path.join(base.project, name); await fs.mkdir(path.join(project, '.git'), { recursive: true });
  return { ...base, project };
}
const request = f => ({ selection: f.selection });

test('collection inventory spans clients and sibling repos without reading raw or native evidence', async t => {
  const base = await storageFixture(t, { fullSetup: false });
  const a = await processingFixture(t, { base: await repository(base, 'orchid') });
  const b = await processingFixture(t, { base: await repository(base, 'cedar'), client: 'claude' });
  const settings = await fs.readFile(base.options.configPath);
  const read = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (file, ...args) => {
    assert(!String(file).startsWith(base.collection.rawDir + path.sep), 'inventory must not open raw evidence');
    assert(![a.source.path, b.source.path].includes(String(file)), 'inventory must not open native transcripts');
    return read(file, ...args);
  });
  const all = await pendingCollectionProcessing(base.capability, request(a));
  assert.equal(all.incomplete, false); assert.equal(all.pending.length, 2);
  assert.deepEqual(new Set(all.pending.map(item => item.identity.client)), new Set(['codex', 'claude']));
  assert.equal(all.sourceCompleteness, 'unknown'); assert.equal(all.operations.length, 0);
  const repo = await pendingCollectionProcessing(base.capability, { ...request(a), scope: 'repo' });
  assert.deepEqual(repo.pending.map(item => item.identity), [a.identity]);
  const chat = await pendingCollectionProcessing(base.capability, { ...request(b), scope: 'chat' });
  assert.deepEqual(chat.pending.map(item => item.identity), [b.identity]);
  assert.deepEqual(await fs.readFile(base.options.configPath), settings);
  assert.deepEqual(await fs.readdir(base.collection.notes.notesDir), []);
});

test('bounded cursors cross sources and clients without duplicating heads and reject scope changes', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a, client: 'claude' });
  const c = await processingFixture(t, { base: a });
  const found = []; let after = null, count = 0;
  do {
    const page = await pendingCollectionProcessing(a.capability, { ...request(a), limit: 1, maxSessions: 1, after });
    found.push(...page.pending.map(item => item.identity.sessionId));
    if (page.incomplete) assert(page.nextCursor, 'incomplete discovery must offer forward progress');
    after = page.nextCursor; assert(++count < 10);
  } while (after);
  assert.deepEqual(new Set(found), new Set([a.identity.sessionId, b.identity.sessionId, c.identity.sessionId]));
  assert.equal(found.length, 3);
  const first = await pendingCollectionProcessing(a.capability, { ...request(a), limit: 1 });
  await assert.rejects(pendingCollectionProcessing(a.capability, { ...request(a), scope: 'chat', after: first.nextCursor }), { code: 'PROCESSING_INVENTORY_CURSOR_MISMATCH' });
});

test('handled revisions stay absent and existing mixed-source claims remain visible outside the returned page', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a, client: 'claude' });
  const done = await inspectedClaim(a);
  await completeProcessing(a.capability, { ...a.args, expectedClaimHash: done.claimHash, outcome: 'unchanged' });
  const remaining = await pendingCollectionProcessing(a.capability, request(a));
  assert.deepEqual(remaining.pending.map(item => item.identity), [b.identity]);
  assert.equal(remaining.counts.handledRevisions, 1);
  const c = await processingFixture(t, { base: a });
  await prepareProcessing(a.capability, { ...b.args, inputs: [...b.inputs, ...c.inputs] });
  const chat = await pendingCollectionProcessing(a.capability, { ...request(c), scope: 'chat', limit: 1 });
  assert.equal(chat.operations.length, 1); assert.equal(chat.operations[0].operationId, b.operationId);
  assert.equal(chat.operations[0].scopeMatch, 'partial'); assert.equal(chat.operations[0].state, 'unread');
  assert.equal(chat.pending[0].status, 'claimed');
  const all = await pendingCollectionProcessing(a.capability, request(a));
  assert.equal(all.operations[0].scopeMatch, 'full');
});

test('inventory excludes newly denied sources while keeping their existing operation discoverable', async t => {
  const a = await processingFixture(t), repo = await repository(a, 'excluded');
  const b = await processingFixture(t, { base: repo });
  await proposedClaim(b);
  const config = structuredClone(a.config);
  config.routes.push({ ...config.routes[0], id: 'excluded', projectRoot: repo.project, excluded: true });
  const bytes = canonicalJSON(config); await fs.writeFile(a.options.configPath, bytes);
  const capability = await verifyWorkflowStorage({ ...a.options, expectedConfigHash: digest(bytes) });
  const value = await pendingCollectionProcessing(capability, request(a));
  assert.deepEqual(value.pending.map(item => item.identity), [a.identity]);
  assert.equal(value.counts.excludedSources, 1);
  assert.equal(value.operations[0].scopeMatch, 'outside');
  assert.equal(value.operations[0].conflict, 'WORKFLOW_POLICY_CHANGED');
});

test('repository scope resolves a nested cwd and does not guess an umbrella folder', async t => {
  const a = await processingFixture(t);
  // A caller may set TMPDIR inside a repository. Never assume its ancestors
  // lack Git markers; the unmarked route itself must not become a guessed root.
  try { assert.notEqual((await processingScope(a.selection, 'repo')).root, a.selection.cwd); }
  catch (error) { assert.equal(error.code, 'PROCESSING_REPOSITORY_UNVERIFIED'); }
  const repo = await repository(a, 'orchid'), nested = path.join(repo.project, 'src', 'feature');
  await fs.mkdir(nested, { recursive: true });
  assert.deepEqual(await processingScope({ ...a.selection, cwd: nested }, 'repo'), { kind: 'repo', root: repo.project });
});

test('head pagination resumes within one source before advancing to the next source', async t => {
  const f = await processingFixture(t), directory = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId);
  const head = JSON.parse(await fs.readFile(path.join(directory, `${f.identity.unitId}.json`), 'utf8'));
  const another = randomUUID();
  await fs.writeFile(path.join(directory, `${another}.json`), canonicalJSON({ ...head, identity: { ...f.identity, unitId: another } }), { mode: 0o600 });
  const first = await pendingCollectionProcessing(f.capability, { ...request(f), limit: 1 });
  assert.equal(first.incomplete, true); assert(first.nextCursor.unitId);
  const second = await pendingCollectionProcessing(f.capability, { ...request(f), limit: 1, after: first.nextCursor });
  assert.equal(second.incomplete, false);
  assert.notEqual(first.pending[0].identity.unitId, second.pending[0].identity.unitId);
  assert.deepEqual(new Set([...first.pending, ...second.pending].map(item => item.identity.unitId)), new Set([f.identity.unitId, another]));
});

test('a changing retained source invalidates the metadata page', async t => {
  const f = await processingFixture(t), file = path.join(f.collection.intakeStateDir, 'sessions', f.identity.client, `${f.identity.sessionId}.json`);
  const original = await fs.readFile(file, 'utf8'), value = JSON.parse(original);
  const open = fs.open.bind(fs); let reads = 0;
  t.mock.method(fs, 'open', async (name, ...args) => {
    if (name === file && ++reads === 2) await fs.writeFile(file, canonicalJSON({ ...value, revision: value.revision + 1 }));
    return open(name, ...args);
  });
  await assert.rejects(pendingCollectionProcessing(f.capability, request(f)), { code: 'PROCESSING_INVENTORY_CHANGED' });
  assert(reads >= 2);
});

test('a linked retained-source directory is refused without inspecting its target', async t => {
  const f = await processingFixture(t), directory = path.join(f.collection.intakeStateDir, 'sessions', f.identity.client);
  const relocated = path.join(f.root, 'relocated-source-metadata'); await fs.rename(directory, relocated);
  await fs.symlink(relocated, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(pendingCollectionProcessing(f.capability, request(f)), error =>
    ['UNSAFE_INTAKE_PATH', 'UNSAFE_PRIVATE_STORAGE'].includes(error.code));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('collection inventory feeds the existing frozen workset and shared claims', async t => {
  const a = await processingFixture(t), b = await processingFixture(t, { base: a, client: 'claude' });
  const envelope = { collectionId: a.collection.id, expectedConfigHash: a.options.expectedConfigHash, args: request(a) };
  const inventory = await executeWorkflow('processing-inventory', envelope, a.options);
  const workset = await createProcessingWorkset(a.capability, { ...request(a), worksetId: randomUUID(),
    inputs: inventory.pending.map(({ identity, headHash }) => ({ identity, headHash })), unscannedRemainder: inventory.incomplete });
  const claimed = await prepareWorksetBatch(a.capability, { worksetId: workset.worksetId, expectedWorksetHash: workset.worksetHash, indexes: [0, 1] });
  assert.equal(claimed.inputs.length, 2);
  const status = await pendingCollectionProcessing(a.capability, request(b));
  assert.equal(status.operations.length, 1); assert(status.pending.every(item => item.status === 'claimed'));
  await assert.rejects(executeWorkflow('processing-inventory', { ...envelope, args: { ...request(a), approve: true } }, a.options), { code: 'INVALID_WORKFLOW' });
});

test('a disposition after inventory prevents a frozen workset from reprocessing that revision', async t => {
  const f = await processingFixture(t);
  const inventory = await pendingCollectionProcessing(f.capability, request(f));
  const workset = await createProcessingWorkset(f.capability, { ...request(f), worksetId: randomUUID(),
    inputs: inventory.pending.map(({ identity, headHash }) => ({ identity, headHash })) });
  const claim = await inspectedClaim(f);
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'unchanged' });
  await assert.rejects(prepareWorksetBatch(f.capability, { worksetId: workset.worksetId,
    expectedWorksetHash: workset.worksetHash, indexes: [0] }), { code: 'PROCESSING_INPUT_ALREADY_HANDLED' });
  assert.equal((await pendingCollectionProcessing(f.capability, request(f))).pending.length, 0);
});

test('writer recovery remains a collection blocker through the new inventory command', async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  await assert.rejects(saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash,
    approvedProposalHash: proposal.proposalHash }, { fault: phase => { if (phase === 'afterReplace') throw new Error('synthetic interruption'); } }), /synthetic interruption/);
  const bytes = await fs.readFile(proposal.target);
  const result = await pendingCollectionProcessing(f.capability, request(f));
  assert(result.blockers.includes('PROCESSING_RECOVERY_REQUIRED'));
  assert.equal(result.operations[0].recoveryRequired, true);
  assert.deepEqual(await fs.readFile(proposal.target), bytes);
});

async function privateBytes(f) {
  const result = {};
  async function walk(root, relative = '') {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(root, name);
      else result[path.join(root, name)] = (await fs.readFile(path.join(root, name))).toString('base64');
    }
  }
  await walk(f.collection.intakeStateDir); await walk(f.collection.notes.writerStateDir);
  return result;
}

test('repository inventory excludes nested repositories in both directions and honors ancestor markers', async t => {
  const base = await storageFixture(t, { fullSetup: false });
  const a = await processingFixture(t, { base: await repository(base, 'app') });
  const nested = path.join(a.project, 'vendor', 'lib'); await fs.mkdir(path.join(nested, '.git'), { recursive: true });
  const b = await processingFixture(t, { base: { ...a, project: nested }, client: 'claude' });
  await prepareProcessing(b.capability, { ...b.args, inputs: b.inputs });
  const parent = await pendingCollectionProcessing(a.capability, { ...request(a), scope: 'repo' });
  assert.deepEqual(parent.pending.map(item => item.identity), [a.identity]);
  assert.equal(parent.operations[0].scopeMatch, 'outside'); assert.equal(parent.counts.outsideScopeSources, 1);
  const child = await pendingCollectionProcessing(b.capability, { ...request(b), scope: 'repo' });
  assert.deepEqual(child.pending.map(item => item.identity), [b.identity]);
  assert.equal(child.operations[0].scopeMatch, 'full');
  // A synthetic ancestor repository does not absorb the separate child repos.
  await fs.mkdir(path.join(base.project, '.git'));
  const top = await processingFixture(t, { base });
  const ancestor = await pendingCollectionProcessing(top.capability, { ...request(top), scope: 'repo' });
  assert.deepEqual(ancestor.pending.map(item => item.identity), [top.identity]);
});

test('claimless interrupted transactions remain discoverable with exact recovery identity', async t => {
  const f = await processingFixture(t), proposal = await proposedClaim(f);
  await assert.rejects(saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposal.claimHash,
    approvedProposalHash: proposal.proposalHash }, { fault: phase => { if (phase === 'claim-release') throw new Error('synthetic release interruption'); } }), /synthetic release interruption/);
  const before = await privateBytes(f);
  const result = await pendingCollectionProcessing(f.capability, request(f));
  assert(result.blockers.includes('PROCESSING_RECOVERY_REQUIRED'));
  assert.equal(result.operations.length, 1); assert.equal(result.operations[0].operationId, f.operationId);
  assert.equal(result.operations[0].claimHash, null); assert.equal(result.operations[0].recoveryRequired, true);
  assert.match(result.operations[0].recoveryHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await privateBytes(f), before);
});

test('pending intake, pruning and locks are visible and a changing recovery snapshot invalidates discovery', async t => {
  const f = await processingFixture(t);
  for (const [name, code] of [['pending.json', 'INTAKE_RECOVERY_REQUIRED'], ['prune-pending.json', 'PRUNE_RECOVERY_REQUIRED']]) {
    const file = path.join(f.collection.intakeStateDir, name);
    await fs.writeFile(file, '{}', { mode: 0o600 });
    const result = await pendingCollectionProcessing(f.capability, request(f));
    assert(result.blockers.includes(code)); await fs.unlink(file);
  }
  const lock = path.join(f.collection.intakeStateDir, '.intake-lock'); await fs.mkdir(lock, { mode: 0o700 });
  const held = await pendingCollectionProcessing(f.capability, request(f));
  assert(held.blockers.includes('INTAKE_BUSY')); assert.equal(held.intakeBlocked, true); await fs.rmdir(lock);
  const open = fs.open.bind(fs); let injected = false;
  const head = path.join(f.collection.intakeStateDir, 'heads', f.identity.client, f.identity.sessionId, `${f.identity.unitId}.json`);
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === head && !injected) {
      injected = true; await fs.writeFile(path.join(f.collection.intakeStateDir, 'pending.json'), '{}', { mode: 0o600 });
    }
    return open(file, ...args);
  });
  await assert.rejects(pendingCollectionProcessing(f.capability, request(f)), { code: 'PROCESSING_INVENTORY_CHANGED' });
});

test('inventory with an active claim is byte-preserving and reads no native or raw bodies', async t => {
  const f = await processingFixture(t); await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const before = await privateBytes(f), open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (file, ...args) => {
    assert(!String(file).startsWith(f.collection.rawDir + path.sep)); assert.notEqual(file, f.source.path);
    return open(file, ...args);
  });
  const result = await pendingCollectionProcessing(f.capability, request(f));
  assert.equal(result.operations.length, 1); assert.equal(result.counts.claimedRevisions, 1);
  assert.equal(result.counts.blockedByClaimRevisions, 0); assert.deepEqual(await privateBytes(f), before);
});

test('empty pages distinguish absent chats from incomplete repo scans and bind cursors to settings', async t => {
  const base = await storageFixture(t, { fullSetup: false });
  const a = await processingFixture(t, { base: await repository(base, 'app') });
  const b = await processingFixture(t, { base: await repository(base, 'lib') });
  const ordered = [a, b].sort((a, b) => a.selection.sessionId.localeCompare(b.selection.sessionId));
  const selected = ordered[1];
  const empty = await pendingCollectionProcessing(selected.capability, { ...request(selected), scope: 'repo', maxSessions: 1 });
  assert.equal(empty.pending.length, 0); assert.equal(empty.incomplete, true); assert(empty.nextCursor);
  const next = await pendingCollectionProcessing(selected.capability, { ...request(selected), scope: 'repo', maxSessions: 1, after: empty.nextCursor });
  assert.deepEqual(next.pending.map(item => item.identity), [selected.identity]);
  const absent = await pendingCollectionProcessing(a.capability, { selection: { ...a.selection, sessionId: randomUUID() }, scope: 'chat' });
  assert.equal(absent.incomplete, false); assert.deepEqual(absent.pending, []);
  const config = structuredClone(a.config); config.routes[0].processing.scope = 'Changed synthetic approved scope';
  const bytes = canonicalJSON(config); await fs.writeFile(a.options.configPath, bytes);
  const capability = await verifyWorkflowStorage({ ...a.options, expectedConfigHash: digest(bytes) });
  await assert.rejects(pendingCollectionProcessing(capability, { ...request(selected), scope: 'repo', after: empty.nextCursor }), { code: 'PROCESSING_INVENTORY_CURSOR_MISMATCH' });
});
