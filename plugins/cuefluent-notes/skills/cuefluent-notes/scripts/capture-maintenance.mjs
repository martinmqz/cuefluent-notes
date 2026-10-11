import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstatOrNull, syncDirectory } from './file-io.mjs';
import { workflowMaintenanceContext, workflowProcessingBinding, assertWorkflowStorage, assertPrivatePaths, verifyPrivateDirectories } from './workflow-storage.mjs';
import { canonicalWorkflowPath, inside } from './workflow-paths.mjs';
import { inspectIntakeStore, openWorkflowIntake, intakePath, intakeSnapshot, intakeJSON, withIntakeLock, assertIntakeTransaction, replaceIntakeJSON } from './intake-io.mjs';
import { readCaptureHead } from './intake-store.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { validateCapture, MAX_CAPTURE_BYTES, assertCaptureExtension } from './capture-contract.mjs';
import { unitKey, readTombstone, tombstonePath, validateTombstone, dispositionPath, validateProcessingDisposition, captureLineage } from './capture-retention.mjs';
import { withLock, inspectWriterMaintenance } from './safe-update.mjs';
import { keys, list, timestamp, nativeId, hash, canonicalJSON, digest, fail } from './workflow-values.mjs';

const LOSS = 'Deletes all retained evidence revisions of these logical units. Future source review will be unavailable; upstream sessions and finished notes are unchanged. Reimport is not implemented.';
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const identityOf = stat => stableSourceIdentity(stat);

async function filesUnder(store, area, prefix, limit = 10000) {
  const files = [];
  const root = await intakePath(store, area, prefix ? `${prefix}/.inspect` : '.inspect');
  async function visit(dir, relative, depth = 0) {
    if (depth > 6) fail('MAINTENANCE_CAPACITY');
    const stat = await lstatOrNull(dir);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) fail('UNSAFE_INTAKE_PATH');
    const stream = await fs.opendir(dir);
    for await (const entry of stream) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      await intakePath(store, area, name); // validate every component before use
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), name, depth + 1);
      else if (entry.isFile()) { files.push(name); if (files.length > limit) fail('MAINTENANCE_CAPACITY'); }
      else fail('UNSAFE_INTAKE_PATH');
    }
  }
  await visit(path.dirname(root), prefix);
  return files.sort();
}

async function context(capability) {
  const value = await workflowMaintenanceContext(capability);
  await verifyPrivateDirectories(value.writers);
  const store = await openWorkflowIntake(capability);
  const roots = {};
  for (const root of [store.rawDir, store.intakeStateDir, ...value.writers]) roots[root] = identityOf(await fs.lstat(root, { bigint: true }));
  return { ...value, store, roots, capability, bindingHash: (await workflowProcessingBinding(capability)).hash };
}

async function ownContext(capability, plan) {
  const collection = await assertWorkflowStorage(capability), store = await openWorkflowIntake(capability);
  if (collection.id !== plan.collectionId) fail('STALE_PRUNE_PREVIEW');
  for (const root of [store.rawDir, store.intakeStateDir]) {
    if (plan.roots[root] !== identityOf(await fs.lstat(root, { bigint: true }))) fail('STALE_PRUNE_PREVIEW');
  }
  return { collection, store };
}

async function finishRecordedPrune(capability, plan, planHash) {
  const { store } = await ownContext(capability, plan);
  return withIntakeLock(store, async transaction => {
    const receipt = intakeJSON(await intakeSnapshot(store, 'state', `prune-receipts/${plan.id}.json`));
    if (!equal(receipt, { format: 'cuefluent-prune-receipt', version: 1, planHash })) fail('PRUNE_RECEIPT_CONFLICT');
    for (const unit of plan.units) {
      if (!equal(await readTombstone(store, unit.identity), unit.tombstone)) fail('PRUNE_TOMBSTONE_CONFLICT');
      for (const revision of unit.tombstone.revisions) {
        if (await lstatOrNull(await intakePath(store, 'raw', revision.path))) fail('PRUNED_CAPTURE_REAPPEARED');
      }
    }
    const pending = await intakeSnapshot(store, 'state', 'prune-pending.json'), active = intakeJSON(pending);
    if (active !== null) {
      if (!equal(active, { plan, planHash })) fail('PRUNE_RECOVERY_REQUIRED');
      await replaceIntakeJSON(transaction, 'prune-pending.json', null, pending.hash);
    }
    return { status: 'already-pruned', units: plan.units.length };
  });
}

async function guardSnapshots(ctx) {
  const pending = await intakeSnapshot(ctx.store, 'state', 'pending.json');
  if (intakeJSON(pending) !== null) fail('INTAKE_RECOVERY_REQUIRED');
  const writers = [];
  for (const writer of ctx.writers) {
    await verifyPrivateDirectories([writer], { paths: ['manifest.json', 'journal.json', 'claims', 'proposals', 'transactions'].map(name => path.join(writer, name)) });
    const inspected = await inspectWriterMaintenance(writer);
    const uniqueSources = [...new Set(inspected.sources)];
    if (uniqueSources.length > 4096) fail('MAINTENANCE_CAPACITY');
    inspected.sources = [];
    for (const source of uniqueSources) inspected.sources.push(await canonicalWorkflowPath(source, { directory: false }));
    writers.push(inspected);
  }
  return { pendingHash: pending.hash, writers };
}

async function selectedUnit(ctx, identity, guards) {
  const current = await readCaptureHead(ctx.store, identity);
  if (!current.capture) fail('CAPTURE_MISSING');
  if (current.capture.terminal === 'unconfirmed') fail('CAPTURE_NOT_TERMINAL');
  const writer = await inspectIntakeStore({ rawDir: ctx.store.rawDir, intakeStateDir: ctx.collection.notes.writerStateDir });
  const dispositionName = dispositionPath(identity, current.hash, ctx.bindingHash);
  await assertPrivatePaths(ctx.capability, [path.join(ctx.collection.notes.writerStateDir, dispositionName)]);
  const processed = await intakeSnapshot(writer, 'state', dispositionName, { maxBytes: 16384 });
  if (!processed.bytes) fail('CAPTURE_NOT_PROCESSED');
  const disposition = validateProcessingDisposition(intakeJSON(processed));
  if (disposition.bindingHash !== ctx.bindingHash || !equal(disposition.identity, identity) || disposition.headHash !== current.hash || disposition.fileHash !== current.head.fileHash ||
      disposition.evidenceHash !== current.head.evidenceHash) fail('STALE_PROCESSING_DISPOSITION');
  const chain = [], known = new Map();
  let generation = current.head.generation;
  for (const item of await captureLineage(ctx.store, identity, current.hash)) {
    if (!equal(item.value.identity, identity) || item.value.nextHead.generation !== generation ||
        item.value.sourceIdentity !== current.capture.source.fileIdentity) fail('UNVERIFIED_CAPTURE_LINEAGE');
    chain.push({ path: item.path, hash: item.hash });
    chain.push({ path: item.indexPath, hash: item.indexHash });
    known.set(item.value.evidenceHash, item.value.fileHash);
    generation--;
  }
  if (generation !== 0) fail('UNVERIFIED_CAPTURE_LINEAGE');
  const revisions = [];
  for (const name of await filesUnder(ctx.store, 'raw', unitKey(identity), 100)) {
    const snapshot = await intakeSnapshot(ctx.store, 'raw', name, { maxBytes: MAX_CAPTURE_BYTES });
    const capture = validateCapture(intakeJSON(snapshot));
    if (!equal(capture.identity, identity) || known.get(capture.evidenceHash) !== snapshot.hash) fail('UNVERIFIED_CAPTURE_LINEAGE');
    assertCaptureExtension(capture, current.capture);
    revisions.push({ path: name, evidenceHash: capture.evidenceHash, fileHash: snapshot.hash, bytes: snapshot.bytes.length,
      fileIdentity: identityOf(snapshot.identity), ranges: capture.source.ranges.map(({ startByte, endByte }) => ({ startByte, endByte })) });
    const file = path.join(ctx.store.rawDir, name);
    if (guards.writers.some(writer => writer.sources.some(source => inside(source, file) && inside(file, source)))) fail('CAPTURE_REQUIRED_BY_DERIVED_NOTES');
  }
  if (revisions.length !== known.size) fail('UNVERIFIED_CAPTURE_LINEAGE');
  const tombstone = validateTombstone({ format: 'cuefluent-pruned-unit', version: 1, identity,
    operationId: '00000000-0000-0000-0000-000000000000', headHash: current.hash, sourceIdentity: current.capture.source.fileIdentity,
    processingHash: processed.hash, prunedAt: '2000-01-01T00:00:00.000Z', revisions }, identity);
  return { identity, bindingHash: ctx.bindingHash, headHash: current.hash, occurredAt: current.capture.occurredAt, terminal: current.capture.terminal,
    processingPath: dispositionName, processingHash: processed.hash, lineage: chain, tombstone };
}

/** Read-only. Explicit identities, optionally further restricted by occurrence date. */
export async function previewCapturePrune(capability, { identities, before = null, createdAt = new Date().toISOString() }) {
  list(identities, 20, { empty: false }).forEach(unitKey); timestamp(createdAt);
  if (new Set(identities.map(unitKey)).size !== identities.length) fail('DUPLICATE_PRUNE_UNIT');
  if (before !== null) timestamp(before);
  const ctx = await context(capability);
  if (intakeJSON(await intakeSnapshot(ctx.store, 'state', 'prune-pending.json')) !== null) fail('PRUNE_RECOVERY_REQUIRED');
  const guards = await guardSnapshots(ctx);
  const units = [];
  for (const identity of identities) {
    const unit = await selectedUnit(ctx, identity, guards);
    if (before !== null && unit.occurredAt >= before) fail('CAPTURE_OUTSIDE_PRUNE_RANGE');
    units.push(unit);
  }
  const plan = { format: 'cuefluent-prune-preview', version: 1, id: randomUUID(), createdAt,
    collectionId: ctx.collection.id, configHash: ctx.configHash, roots: ctx.roots, guards, units, loss: LOSS };
  for (const unit of units) { unit.tombstone.operationId = plan.id; unit.tombstone.prunedAt = createdAt; }
  if (Buffer.byteLength(canonicalJSON(plan)) > 900000) fail('MAINTENANCE_CAPACITY');
  await assertWorkflowStorage(capability);
  return plan;
}

function validatePlan(plan) {
  keys(plan, ['format', 'version', 'id', 'createdAt', 'collectionId', 'configHash', 'roots', 'guards', 'units', 'loss']);
  if (plan.format !== 'cuefluent-prune-preview' || plan.version !== 1 || plan.loss !== LOSS) fail('INVALID_PRUNE_PREVIEW');
  nativeId(plan.id); timestamp(plan.createdAt); hash(plan.configHash); list(plan.units, 20, { empty: false });
  const seen = new Set();
  for (const unit of plan.units) {
    keys(unit, ['identity', 'bindingHash', 'headHash', 'occurredAt', 'terminal', 'processingPath', 'processingHash', 'lineage', 'tombstone']);
    const key = unitKey(unit.identity); if (seen.has(key)) fail('INVALID_PRUNE_PREVIEW'); seen.add(key);
    hash(unit.headHash); hash(unit.bindingHash); hash(unit.processingHash); timestamp(unit.occurredAt);
    if (!['completed', 'interrupted', 'failed'].includes(unit.terminal) || unit.processingPath !== dispositionPath(unit.identity, unit.headHash, unit.bindingHash)) fail('INVALID_PRUNE_PREVIEW');
    list(unit.lineage, 200, { empty: false });
    for (const item of unit.lineage) {
      keys(item, ['path', 'hash']); hash(item.hash);
      const prefix = `lineage/${key}/`;
      if (!/^receipts\/[a-f0-9]{64}\.json$/.test(item.path) &&
          !(item.path.startsWith(prefix) && /^[a-f0-9]{20}\.json$/.test(item.path.slice(prefix.length)))) fail('INVALID_PRUNE_PREVIEW');
    }
    validateTombstone(unit.tombstone, unit.identity);
    if (unit.tombstone.operationId !== plan.id || unit.tombstone.headHash !== unit.headHash || unit.tombstone.processingHash !== unit.processingHash || unit.tombstone.prunedAt !== plan.createdAt) fail('INVALID_PRUNE_PREVIEW');
  }
  return plan;
}

async function withWriters(writers, run, guards = [], held = new Map()) {
  if (!writers.length) return run(async () => { for (const guard of guards) await guard(); }, held);
  return withLock(writers[0], guard => withWriters(writers.slice(1), run, [...guards, guard], new Map([...held, [writers[0], guard]])));
}

export async function withWorkflowWriterLocks(transaction, writers, run) {
  await assertIntakeTransaction(transaction);
  list(writers, 100, { empty: false });
  const canonical = [];
  for (const writer of writers) canonical.push(await canonicalWorkflowPath(writer, { allowMissing: false }));
  return withWriters([...new Set(canonical)].sort(), async (writerGuard, held) => run(async () => {
    await assertIntakeTransaction(transaction); await writerGuard();
  }, held));
}

async function checkReviewed(ctx, plan, { recovery = false } = {}) {
  if (plan.collectionId !== ctx.collection.id || plan.configHash !== ctx.configHash || !equal(plan.roots, ctx.roots) ||
      !equal(plan.guards, await guardSnapshots(ctx))) fail('STALE_PRUNE_PREVIEW');
  const writer = await inspectIntakeStore({ rawDir: ctx.store.rawDir, intakeStateDir: ctx.collection.notes.writerStateDir });
  for (const unit of plan.units) {
    const head = await intakeSnapshot(ctx.store, 'state', `heads/${unitKey(unit.identity)}.json`);
    await assertPrivatePaths(ctx.capability, [path.join(ctx.collection.notes.writerStateDir, unit.processingPath)]);
    if (head.hash !== unit.headHash || (await intakeSnapshot(writer, 'state', unit.processingPath, { maxBytes: 16384 })).hash !== unit.processingHash) fail('STALE_PRUNE_PREVIEW');
    for (const item of unit.lineage) if ((await intakeSnapshot(ctx.store, 'state', item.path, { maxBytes: 16384 })).hash !== item.hash) fail('STALE_PRUNE_PREVIEW');
    const tombstone = await readTombstone(ctx.store, unit.identity);
    if (tombstone && (!recovery || !equal(tombstone, unit.tombstone))) fail('PRUNE_TOMBSTONE_CONFLICT');
    const paths = await filesUnder(ctx.store, 'raw', unitKey(unit.identity), 100);
    if (paths.some(name => !unit.tombstone.revisions.some(item => item.path === name))) fail('UNFAMILIAR_PRUNE_FILE');
    for (const revision of unit.tombstone.revisions) {
      const raw = await intakeSnapshot(ctx.store, 'raw', revision.path, { maxBytes: MAX_CAPTURE_BYTES });
      if (!raw.bytes) { if (!recovery || !tombstone) fail('PRUNE_FILE_CHANGED'); }
      else if (raw.hash !== revision.fileHash || raw.bytes.length !== revision.bytes || identityOf(raw.identity) !== revision.fileIdentity) fail('PRUNE_FILE_CHANGED');
    }
  }
}

/** Intake first, then all configured writers in canonical sorted order. */
export async function applyCapturePrune(capability, reviewed, { fault = async () => {} } = {}) {
  const plan = validatePlan(structuredClone(reviewed)), planHash = digest(canonicalJSON(plan));
  const own = await ownContext(capability, plan);
  if ((await intakeSnapshot(own.store, 'state', `prune-receipts/${plan.id}.json`)).bytes) return finishRecordedPrune(capability, plan, planHash);
  const ctx = await context(capability);
  return withIntakeLock(ctx.store, transaction => withWorkflowWriterLocks(transaction, ctx.writers, async writerGuard => {
    const guard = async () => { await assertIntakeTransaction(transaction); await writerGuard(); await assertWorkflowStorage(capability); await verifyPrivateDirectories(ctx.writers); };
    const pending = await intakeSnapshot(ctx.store, 'state', 'prune-pending.json');
    const active = intakeJSON(pending);
    if (active !== null && !equal(active, { plan, planHash })) fail('PRUNE_RECOVERY_REQUIRED');
    if ((await intakeSnapshot(ctx.store, 'state', `prune-receipts/${plan.id}.json`)).bytes) fail('PRUNE_STATE_CHANGED');
    if ((await intakeSnapshot(ctx.store, 'state', `prune-abandoned/${planHash}.json`)).bytes) fail('PRUNE_ALREADY_ABANDONED');
    if (active === null) {
      // Never trust caller-created revision lists or eligibility booleans.
      const fresh = await previewCapturePrune(capability, { identities: plan.units.map(item => item.identity), createdAt: plan.createdAt });
      fresh.id = plan.id; for (const unit of fresh.units) unit.tombstone.operationId = plan.id;
      if (!equal(plan, fresh)) fail('STALE_PRUNE_PREVIEW');
    }
    await guard(); await checkReviewed(ctx, plan, { recovery: active !== null });
    let pendingHash = pending.hash;
    if (active === null) pendingHash = await replaceIntakeJSON(transaction, 'prune-pending.json', { plan, planHash }, pending.hash);
    await fault('intent');
    const writer = await inspectIntakeStore({ rawDir: ctx.store.rawDir, intakeStateDir: ctx.collection.notes.writerStateDir });
    for (const unit of plan.units) {
      const name = tombstonePath(unit.identity), old = await intakeSnapshot(ctx.store, 'state', name);
      if (old.bytes && !equal(intakeJSON(old), unit.tombstone)) fail('PRUNE_TOMBSTONE_CONFLICT');
      if (!old.bytes) { await guard(); await replaceIntakeJSON(transaction, name, unit.tombstone, null); }
      await fault('tombstone');
      for (const revision of unit.tombstone.revisions) {
        await guard();
        if (!equal(plan.guards, await guardSnapshots(ctx))) fail('STALE_PRUNE_PREVIEW');
        if ((await intakeSnapshot(ctx.store, 'state', `heads/${unitKey(unit.identity)}.json`)).hash !== unit.headHash ||
            !equal(await readTombstone(ctx.store, unit.identity), unit.tombstone)) fail('STALE_PRUNE_PREVIEW');
        await assertPrivatePaths(capability, [path.join(ctx.collection.notes.writerStateDir, unit.processingPath)]);
        if ((await intakeSnapshot(writer, 'state', unit.processingPath, { maxBytes: 16384 })).hash !== unit.processingHash) fail('STALE_PRUNE_PREVIEW');
        const raw = await intakeSnapshot(ctx.store, 'raw', revision.path, { maxBytes: MAX_CAPTURE_BYTES });
        if (raw.bytes) {
          if (raw.hash !== revision.fileHash || identityOf(raw.identity) !== revision.fileIdentity || raw.bytes.length !== revision.bytes) fail('PRUNE_FILE_CHANGED');
          await assertIntakeTransaction(transaction); await writerGuard();
          const file = await intakePath(ctx.store, 'raw', revision.path), now = await fs.lstat(file, { bigint: true });
          if (identityOf(now) !== revision.fileIdentity || now.ctimeNs !== raw.identity.ctimeNs || now.nlink !== 1n) fail('PRUNE_FILE_CHANGED');
          await fs.unlink(file);
          await syncDirectory(path.dirname(path.join(ctx.store.rawDir, revision.path)));
        }
        await fault('unlink');
      }
    }
    await guard(); await checkReviewed(ctx, plan, { recovery: true });
    await replaceIntakeJSON(transaction, `prune-receipts/${plan.id}.json`, { format: 'cuefluent-prune-receipt', version: 1, planHash }, null);
    await fault('receipt');
    await replaceIntakeJSON(transaction, 'prune-pending.json', null, pendingHash);
    await fault('complete');
    return { status: 'pruned', units: plan.units.length, revisions: plan.units.reduce((n, unit) => n + unit.tombstone.revisions.length, 0) };
  }));
}

export async function recoverCapturePrune(capability, expectedPlanHash, options) {
  hash(expectedPlanHash);
  const store = await openWorkflowIntake(capability), active = intakeJSON(await intakeSnapshot(store, 'state', 'prune-pending.json'));
  if (!active || active.planHash !== expectedPlanHash || digest(canonicalJSON(active.plan)) !== expectedPlanHash) fail('PRUNE_INTENT_CHANGED');
  return applyCapturePrune(capability, active.plan, options);
}

/** Explicit reviewed escape from a conflicting intent. Never deletes evidence,
 * rewrites a preview, refreshes its hashes, or removes established tombstones. */
export async function abandonCapturePrune(capability, expectedPlanHash) {
  hash(expectedPlanHash);
  const inspected = await openWorkflowIntake(capability), snapshot = await intakeSnapshot(inspected, 'state', 'prune-pending.json');
  const active = intakeJSON(snapshot);
  if (!active || active.planHash !== expectedPlanHash || digest(canonicalJSON(active.plan)) !== expectedPlanHash) fail('PRUNE_INTENT_CHANGED');
  const plan = validatePlan(active.plan), { store } = await ownContext(capability, plan);
  return withIntakeLock(store, async transaction => {
    if ((await intakeSnapshot(store, 'state', 'prune-pending.json')).hash !== snapshot.hash) fail('PRUNE_INTENT_CHANGED');
    if ((await intakeSnapshot(store, 'state', `prune-receipts/${plan.id}.json`)).bytes) fail('PRUNE_ALREADY_COMPLETED');
    const tombstones = [];
    for (const unit of plan.units) {
      const existing = await readTombstone(store, unit.identity);
      if (existing && !equal(existing, unit.tombstone)) fail('PRUNE_TOMBSTONE_CONFLICT');
      if (existing) tombstones.push(unit.identity);
    }
    const name = `prune-abandoned/${expectedPlanHash}.json`, old = await intakeSnapshot(store, 'state', name);
    const archive = { format: 'cuefluent-abandoned-prune', version: 1, ...active, tombstones };
    if (old.bytes && !equal(intakeJSON(old), archive)) fail('PRUNE_INTENT_CHANGED');
    if (!old.bytes) await replaceIntakeJSON(transaction, name, archive, null);
    await replaceIntakeJSON(transaction, 'prune-pending.json', null, snapshot.hash);
    return { status: 'abandoned', retainedTombstones: tombstones.length,
      notice: 'Remaining evidence bytes and the original reviewed intent are preserved. Existing tombstones remain permanent; cleanup of these retained bytes is a separate explicit operation.' };
  });
}

export async function captureStorageStatus(capability) {
  const result = { units: 0, revisions: 0, logicalBytes: 0, tombstonedUnits: 0,
    retainedPrunedBytes: 0, complete: true, blocked: [], pending: false };
  const blocked = new Set(), known = new Map(), pruned = new Set();
  try {
    const ctx = await context(capability);
    for (const name of ['pending.json', 'prune-pending.json']) {
      if (intakeJSON(await intakeSnapshot(ctx.store, 'state', name)) !== null) {
        result.pending = true; blocked.add(name === 'pending.json' ? 'INTAKE_RECOVERY_REQUIRED' : 'PRUNE_RECOVERY_REQUIRED');
      }
    }
    for (const name of await filesUnder(ctx.store, 'state', 'heads')) {
      const match = /^heads\/(codex|claude)\/([^/]+)\/([^/]+)\.json$/.exec(name);
      if (!match) fail('UNFAMILIAR_CAPTURE_HEAD');
      const identity = { client: match[1], sessionId: match[2], unitId: match[3] };
      const tombstone = await readTombstone(ctx.store, identity);
      if (tombstone) {
        result.tombstonedUnits++;
        for (const revision of tombstone.revisions) pruned.add(revision.path);
        continue;
      }
      const head = await intakeSnapshot(ctx.store, 'state', name);
      for (const record of await captureLineage(ctx.store, identity, head.hash)) {
        const file = `${unitKey(identity)}/${record.value.evidenceHash.slice(0, 20)}.json`;
        known.set(file, record.value.fileHash);
      }
      result.units++;
    }
    for (const file of await filesUnder(ctx.store, 'raw', '')) {
      if (pruned.has(file)) {
        result.retainedPrunedBytes += Number((await fs.lstat(await intakePath(ctx.store, 'raw', file))).size);
        result.complete = false; blocked.add('PRUNED_CAPTURE_BYTES_PRESENT'); continue;
      }
      if (!known.has(file)) { result.complete = false; blocked.add('UNOWNED_CAPTURE_FILES'); continue; }
      const raw = await intakeSnapshot(ctx.store, 'raw', file, { maxBytes: MAX_CAPTURE_BYTES });
      if (raw.hash !== known.get(file)) fail('CAPTURE_HEAD_CONFLICT');
      known.delete(file); result.revisions++; result.logicalBytes += raw.bytes.length;
    }
    if (known.size) { result.complete = false; blocked.add('CAPTURE_REVISION_MISSING'); }
    if (await lstatOrNull(path.join(ctx.store.intakeStateDir, '.intake-lock'))) blocked.add('INTAKE_BLOCKED');
    try { await guardSnapshots(ctx); } catch (error) { blocked.add(error.code ?? 'WRITER_MAINTENANCE_BLOCKED'); }
  } catch (error) { result.complete = false; blocked.add(error.code ?? 'MAINTENANCE_INSPECTION_FAILED'); }
  result.blocked = [...blocked]; return result;
}
