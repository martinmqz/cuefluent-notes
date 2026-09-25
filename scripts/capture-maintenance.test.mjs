import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { openWorkflowIntake, withIntakeLock, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { controlSelection, publishCapture, readCaptureHead, readSelection, commitReaderProgress } from './intake-store.mjs';
import { createCapture, captureRelativePath } from './capture-contract.mjs';
import { previewCapturePrune, applyCapturePrune, recoverCapturePrune, abandonCapturePrune, captureStorageStatus } from './capture-maintenance.mjs';
import { verifyWorkflowStorage, prepareWorkflowStorage, workflowProcessingBinding } from './workflow-storage.mjs';
import { dispositionPath, readTombstone } from './capture-retention.mjs';
import { withLock } from './safe-update.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';

const S = '10000000-0000-4000-8000-000000000001', U = '20000000-0000-4000-8000-000000000001';
const stamp = '2026-01-01T00:00:00.000Z', allow = async () => true;

async function fixture(t, { processed = true, terminal = 'completed', base = null, sessionId = S, unitId = U } = {}) {
  const f = (base ?? await storageFixture(t, { fullSetup: false })), store = await openWorkflowIntake(f.capability, { client: 'codex', sessionId, cwd: f.project }, 'collect');
  const source = { client: 'codex', sessionId, projectRoot: f.project, path: path.join(f.project, `session-${sessionId}.jsonl`) };
  await fs.writeFile(source.path, 'x'.repeat(300));
  source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
  const proof = { client: 'codex', sessionId, unitId, sourceIdentity: source.fileIdentity,
    start: { id: 'start', startByte: 200, endByte: 220, hash: digest('x'.repeat(20)) },
    end: { id: 'end', startByte: 280, endByte: 300, hash: digest('x'.repeat(20)) }, nativeOrder: null };
  const request = { id: randomUUID(), operation: 'capture-current', client: 'codex', sessionId, unitId,
    expectedRevision: 0, scope: { unitIds: [unitId], start: proof.start, end: null } };
  const selection = await withIntakeLock(store, tx => controlSelection(tx, { source, request, expectedHash: null, authorize: allow }));
  const identity = { client: 'codex', sessionId, unitId };
  const range = { startByte: 220, endByte: 280, recordIds: ['message'] };
  const capture = createCapture({ format: 'cuefluent-capture', schemaVersion: 2, identity, projectRoot: f.project,
    source: { path: source.path, fileIdentity: source.fileIdentity, ranges: [range] }, reader: { name: 'fixture', version: '1', clientVersion: 'fixture' },
    occurredAt: stamp, capturedAt: stamp, terminal, coverage: { partial: terminal !== 'completed', omissions: [] },
    evidence: [{ kind: 'user', recordId: 'message', range, text: 'Synthetic decision: keep private evidence.' }] });
  const scan = { from: { sourceIdentity: source.fileIdentity, offset: 200, anchor: null },
    to: { sourceIdentity: source.fileIdentity, offset: 300, anchor: { startByte: 280, endByte: 300, hash: proof.end.hash } },
    accounted: [{ kind: 'captured', unitId, startByte: 200, endByte: 300 }] };
  const args = { capture, proof, scopeId: request.id, selectionHash: selection.hash, cursorHash: null, scan, authorize: allow };
  const result = await withIntakeLock(store, tx => publishCapture(tx, args));
  const bindingHash = (await workflowProcessingBinding(f.capability)).hash;
  const disposition = { format: 'cuefluent-processing-disposition', version: 2, bindingHash, identity, headHash: result.headHash,
    evidenceHash: capture.evidenceHash, fileHash: result.fileHash, operationId: randomUUID(), outcome: 'saved', processedAt: stamp };
  const processedPath = path.join(f.collection.notes.writerStateDir, dispositionPath(identity, result.headHash, bindingHash));
  if (processed) { await fs.mkdir(path.dirname(processedPath), { recursive: true, mode: 0o700 }); await fs.writeFile(processedPath, canonicalJSON(disposition) + '\n', { mode: 0o600 }); }
  return { ...f, store, args, source, identity, capture, result, processedPath, bindingHash };
}
const preview = f => previewCapturePrune(f.capability, { identities: [f.identity], before: '2026-02-01T00:00:00.000Z' });

test('prune requires terminal exact-head processing evidence, not publication receipts', async t => {
  const missing = await fixture(t, { processed: false });
  await assert.rejects(preview(missing), { code: 'CAPTURE_NOT_PROCESSED' });
  const pending = await fixture(t, { terminal: 'unconfirmed' });
  await assert.rejects(preview(pending), { code: 'CAPTURE_NOT_TERMINAL' });
  const changed = await fixture(t);
  const value = JSON.parse(await fs.readFile(changed.processedPath)); value.headHash = 'f'.repeat(64);
  await fs.writeFile(changed.processedPath, JSON.stringify(value));
  await assert.rejects(preview(changed), { code: 'STALE_PROCESSING_DISPOSITION' });
});

test('reviewed prune preserves sources, notes, receipts and progress; retry never recreates raw', async t => {
  const f = await fixture(t); await fs.mkdir(f.collection.notes.notesDir);
  const note = path.join(f.collection.notes.notesDir, 'decision.md'); await fs.writeFile(note, '# User note\n');
  const plan = await preview(f), before = await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${f.args.scopeId}.json`);
  assert.equal(plan.units[0].tombstone.revisions.length, 1);
  const status = await captureStorageStatus(f.capability);
  assert.equal(status.units, 1); assert.equal(status.revisions, 1); assert(status.logicalBytes > 0);
  assert.equal((await applyCapturePrune(f.capability, plan)).status, 'pruned');
  assert.equal((await applyCapturePrune(f.capability, plan)).status, 'already-pruned');
  assert.equal((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.identity, f.capture.evidenceHash))).bytes, null);
  assert(await readTombstone(f.store, f.identity));
  await assert.rejects(readCaptureHead(f.store, f.identity), { code: 'CAPTURE_PRUNED' });
  await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, f.args)), { code: 'CAPTURE_PRUNED' });
  assert.equal((await intakeSnapshot(f.store, 'state', `progress/codex/${S}/${f.args.scopeId}.json`)).hash, before.hash);
  assert.equal((await fs.readFile(f.source.path)).length, 300); assert.equal(await fs.readFile(note, 'utf8'), '# User note\n');
  assert.equal((await fs.readdir(path.join(f.collection.intakeStateDir, 'receipts'))).length, 1);
  const after = await captureStorageStatus(f.capability);
  assert.equal(after.units, 0); assert.equal(after.tombstonedUnits, 1); assert.equal(after.revisions, 0);
});

for (const phase of ['intent', 'tombstone', 'unlink', 'receipt', 'complete']) {
  test(`prune resumes only its unchanged owned intent after ${phase}`, async t => {
    const f = await fixture(t), plan = await preview(f);
    await assert.rejects(applyCapturePrune(f.capability, plan, { fault: async at => { if (at === phase) throw new Error('crash'); } }), /crash/);
    const active = intakeJSON(await intakeSnapshot(f.store, 'state', 'prune-pending.json'));
    if (active) {
      await assert.rejects(withIntakeLock(f.store, tx => publishCapture(tx, f.args)), { code: 'PRUNE_RECOVERY_REQUIRED' });
      await recoverCapturePrune(f.capability, active.planHash);
    } else assert.equal((await applyCapturePrune(f.capability, plan)).status, 'already-pruned');
    assert.equal((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.identity, f.capture.evidenceHash))).bytes, null);
  });
}

test('prune rejects stale previews, changed bytes, orphan files, claims and writer journals', async t => {
  for (const alter of [
    async f => fs.appendFile(f.processedPath, ' '),
    async f => fs.appendFile(path.join(f.store.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash)), ' '),
    async f => fs.writeFile(path.join(f.store.rawDir, path.dirname(captureRelativePath(f.identity, f.capture.evidenceHash)), 'unfamiliar.tmp'), 'x', { mode: 0o600 }),
    async f => { const dir = path.join(f.collection.notes.writerStateDir, 'claims'); await fs.mkdir(dir, { mode: 0o700 }); await fs.writeFile(path.join(dir, 'unknown.json'), '{}', { mode: 0o600 }); },
    async f => fs.writeFile(path.join(f.collection.notes.writerStateDir, 'journal.json'), 'invalid', { mode: 0o600 }),
  ]) {
    const f = await fixture(t), plan = await preview(f); await alter(f);
    await assert.rejects(applyCapturePrune(f.capability, plan));
    assert.equal(await readTombstone(f.store, f.identity), null);
    assert((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.identity, f.capture.evidenceHash))).bytes);
  }
});

test('live derived manifest dependencies block prune without reading source or note bodies', async t => {
  const f = await fixture(t);
  const manifest = { version: 1, mode: 'derived', root: f.collection.notes.notesDir, guideVersion: 'fixture', files: [{ path: 'derived.md', hash: 'f'.repeat(64),
    sources: [{ path: path.join(f.store.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash)), hash: f.result.fileHash }], entries: [] }] };
  await fs.writeFile(path.join(f.collection.notes.writerStateDir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await assert.rejects(preview(f), { code: 'CAPTURE_REQUIRED_BY_DERIVED_NOTES' });
});

test('a closed logical unit prunes its recognized earlier snapshots together', async t => {
  const f = await fixture(t, { terminal: 'unconfirmed', processed: false });
  const capture = createCapture({ ...f.capture, terminal: 'completed', coverage: { partial: false, omissions: [] } });
  const result = await withIntakeLock(f.store, tx => publishCapture(tx, { ...f.args, capture,
    expectedHeadHash: f.result.headHash, cursorHash: f.result.cursorHash,
    scan: { from: f.args.scan.to, to: f.args.scan.to, accounted: [] } }));
  const file = path.join(f.collection.notes.writerStateDir, dispositionPath(f.identity, result.headHash, f.bindingHash));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ format: 'cuefluent-processing-disposition', version: 2, bindingHash: f.bindingHash, identity: f.identity,
    headHash: result.headHash, evidenceHash: capture.evidenceHash, fileHash: result.fileHash, operationId: randomUUID(), outcome: 'unchanged', processedAt: stamp }), { mode: 0o600 });
  const plan = await preview(f);
  assert.equal(plan.units[0].tombstone.revisions.length, 2);
  const done = await applyCapturePrune(f.capability, plan); assert.equal(done.revisions, 2);
});

test('accounting can cite exact pruned revision ranges without recreating their bytes', async t => {
  const f = await fixture(t); await applyCapturePrune(f.capability, await preview(f));
  const selection = await readSelection(f.store, f.identity), id = randomUUID();
  const scoped = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, expectedHash: selection.hash, authorize: allow,
    request: { id, operation: 'capture-historical', client: 'codex', sessionId: S, expectedRevision: selection.state.revision,
      scope: { unitIds: [U], start: f.args.proof.start, end: f.args.proof.end } } }));
  const args = { identity: { client: 'codex', sessionId: S }, scopeId: id, selectionHash: scoped.hash, cursorHash: null, authorize: allow,
    scan: { ...f.args.scan, accounted: [{ kind: 'structural', startByte: 200, endByte: 220 },
      { kind: 'published', startByte: 220, endByte: 280, unitId: U, evidenceHash: f.capture.evidenceHash, fileHash: 'f'.repeat(64) },
      { kind: 'structural', startByte: 280, endByte: 300 }] },
    checkpoint: { format: 'cuefluent-reader-checkpoint', version: 1, reader: 'fixture', client: 'codex', sessionId: S,
      scopeId: id, sourceIdentity: f.source.fileIdentity, offset: 300, records: [], units: [] } };
  await assert.rejects(withIntakeLock(f.store, tx => commitReaderProgress(tx, args)), { code: 'UNVERIFIED_PUBLISHED_UNIT' });
  args.scan.accounted[1].fileHash = f.result.fileHash;
  assert.equal((await withIntakeLock(f.store, tx => commitReaderProgress(tx, args))).status, 'checkpointed');
  const tombstone = await readTombstone(f.store, f.identity);
  assert.equal(tombstone.revisions[0].fileHash, f.result.fileHash);
  assert.deepEqual(tombstone.revisions[0].ranges, [{ startByte: 220, endByte: 280 }]);
});

test('recovery preserves changed remaining files and unfamiliar additions after partial deletion', async t => {
  const f = await fixture(t), plan = await preview(f);
  await assert.rejects(applyCapturePrune(f.capability, plan, { fault: async at => { if (at === 'tombstone') throw new Error('crash'); } }), /crash/);
  const raw = path.join(f.store.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash)); await fs.appendFile(raw, ' ');
  const active = intakeJSON(await intakeSnapshot(f.store, 'state', 'prune-pending.json'));
  await assert.rejects(recoverCapturePrune(f.capability, active.planHash), { code: 'PRUNE_FILE_CHANGED' });
  assert((await fs.stat(raw)).size > 0);
});

test('writer maintenance guard rejects changed ownership and expires with its lock', async t => {
  const f = await fixture(t); let saved;
  await withLock(f.collection.notes.writerStateDir, async guard => { saved = guard; await guard(); });
  await assert.rejects(saved(), /no longer held/);
  await assert.rejects(withLock(f.collection.notes.writerStateDir, async guard => {
    const owner = path.join(f.collection.notes.writerStateDir, '.lock', 'owner.json');
    await fs.writeFile(owner, '{}'); await guard();
  }), /ownership changed/);
});

test('a completed prune finalizes despite an unrelated configuration change', async t => {
  const f = await fixture(t), plan = await preview(f);
  await assert.rejects(applyCapturePrune(f.capability, plan, { fault: async at => { if (at === 'receipt') throw new Error('crash'); } }), /crash/);
  const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'prune-pending.json'));
  f.config.routes[0].processing.scope = 'Changed unrelated scope';
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  assert.equal((await recoverCapturePrune(capability, pending.planHash)).status, 'already-pruned');
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'prune-pending.json')), null);
});

test('reviewed abandon releases a conflicting intent without deleting remaining evidence or tombstones', async t => {
  const f = await fixture(t), plan = await preview(f);
  await assert.rejects(applyCapturePrune(f.capability, plan, { fault: async at => { if (at === 'tombstone') throw new Error('crash'); } }), /crash/);
  const pending = intakeJSON(await intakeSnapshot(f.store, 'state', 'prune-pending.json'));
  f.config.collections.push({ id: 'unprepared', rawDir: path.join(f.root, 'other-raw'), intakeStateDir: path.join(f.root, 'other-state'),
    notes: { notesDir: path.join(f.root, 'other-notes'), writerStateDir: path.join(f.root, 'other-writer') } });
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  assert.equal((await abandonCapturePrune(capability, pending.planHash)).status, 'abandoned');
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', 'prune-pending.json')), null);
  assert(await readTombstone(f.store, f.identity));
  assert((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.identity, f.capture.evidenceHash))).bytes);
  assert.equal(intakeJSON(await intakeSnapshot(f.store, 'state', `prune-abandoned/${pending.planHash}.json`)).planHash, pending.planHash);
});

test('preview identities/ranges and caller-edited eligibility never bypass exact review', async t => {
  const f = await fixture(t), plan = await preview(f);
  await assert.rejects(previewCapturePrune(f.capability, { identities: [f.identity, f.identity] }), { code: 'DUPLICATE_PRUNE_UNIT' });
  await assert.rejects(previewCapturePrune(f.capability, { identities: [f.identity], before: stamp }), { code: 'CAPTURE_OUTSIDE_PRUNE_RANGE' });
  for (const change of [p => p.loss = 'changed', p => p.units[0].tombstone.revisions[0].ranges[0].startByte++,
    p => p.units[0].tombstone.revisions.pop(), p => p.units[0].processingHash = 'e'.repeat(64)]) {
    const changed = structuredClone(plan); change(changed);
    await assert.rejects(applyCapturePrune(f.capability, changed));
    assert.equal(await readTombstone(f.store, f.identity), null);
  }
});

test('status identifies orphans and reappeared pruned files without counting them as retained revisions', async t => {
  const f = await fixture(t), plan = await preview(f);
  const raw = path.join(f.store.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash));
  const bytes = await fs.readFile(raw);
  const extra = path.join(path.dirname(raw), 'unknown.json'); await fs.writeFile(extra, bytes, { mode: 0o600 });
  const orphan = await captureStorageStatus(f.capability);
  assert.equal(orphan.complete, false); assert.equal(orphan.revisions, 1);
  assert.equal(orphan.blocked.filter(code => code === 'UNOWNED_CAPTURE_FILES').length, 1);
  await fs.unlink(extra); await applyCapturePrune(f.capability, plan);
  await fs.writeFile(raw, bytes, { mode: 0o600 });
  const reappeared = await captureStorageStatus(f.capability);
  assert.equal(reappeared.revisions, 0); assert.equal(reappeared.complete, false);
  assert.equal(reappeared.retainedPrunedBytes, bytes.length);
});

test('another configured writer can protect this raw collection and an unavailable writer is not ignored', async t => {
  const f = await fixture(t);
  const other = { id: 'other', rawDir: path.join(f.root, 'other-raw'), intakeStateDir: path.join(f.root, 'other-state'),
    notes: { notesDir: path.join(f.root, 'other-notes'), writerStateDir: path.join(f.root, 'other-writer') } };
  f.config.collections.push(other);
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const options = { ...f.options, expectedConfigHash: digest(bytes) };
  f.capability = await verifyWorkflowStorage(options);
  await assert.rejects(preview(f), { code: 'ENOENT' });
  await prepareWorkflowStorage({ ...options, collectionId: other.id });
  const manifest = { version: 1, mode: 'derived', root: other.notes.notesDir, guideVersion: 'fixture', files: [{ path: 'derived.md', hash: 'f'.repeat(64),
    sources: [{ path: path.join(f.store.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash)), hash: f.result.fileHash }], entries: [] }] };
  await fs.writeFile(path.join(other.notes.writerStateDir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await assert.rejects(preview(f), { code: 'CAPTURE_REQUIRED_BY_DERIVED_NOTES' });
});


test('partial multi-unit prune resumes exact remaining evidence and preserves completed tombstones', async t => {
  const first = await fixture(t), second = await fixture(t, { base: first,
    sessionId: '10000000-0000-4000-8000-000000000002', unitId: '20000000-0000-4000-8000-000000000002' });
  const plan = await previewCapturePrune(first.capability, { identities: [first.identity, second.identity] });
  await assert.rejects(applyCapturePrune(first.capability, plan, { fault: async at => { if (at === 'unlink') throw new Error('crash'); } }), /crash/);
  assert(await readTombstone(first.store, first.identity));
  assert.equal(await readTombstone(first.store, second.identity), null);
  assert.equal((await intakeSnapshot(first.store, 'raw', captureRelativePath(first.identity, first.capture.evidenceHash))).bytes, null);
  assert((await intakeSnapshot(second.store, 'raw', captureRelativePath(second.identity, second.capture.evidenceHash))).bytes);
  const pending = intakeJSON(await intakeSnapshot(first.store, 'state', 'prune-pending.json'));
  await recoverCapturePrune(first.capability, pending.planHash);
  assert(await readTombstone(first.store, second.identity));
  assert.equal((await captureStorageStatus(first.capability)).tombstonedUnits, 2);
});

test('a changed disposition after intent cannot authorize its first deletion', async t => {
  const f = await fixture(t), plan = await preview(f);
  await assert.rejects(applyCapturePrune(f.capability, plan, { fault: async at => {
    if (at === 'tombstone') await fs.appendFile(f.processedPath, ' ');
  } }), { code: 'STALE_PRUNE_PREVIEW' });
  assert((await intakeSnapshot(f.store, 'raw', captureRelativePath(f.identity, f.capture.evidenceHash))).bytes);
});
