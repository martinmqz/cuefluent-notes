import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openGuarded, lstatOrNull, sameFileIdentity, syncDirectory, removeOwnedStage } from './file-io.mjs';
import { validateCapture, serializeCapture, captureRelativePath, logicalCaptureIdentity, assertCaptureExtension, MAX_CAPTURE_BYTES } from './capture-contract.mjs';
import { planReaderCheckpoint, validateStoredCheckpoint, hydrateReaderCheckpoint, publishReaderPages, readReaderAllocation } from './reader-pages.mjs';
import { validateReaderCheckpoint, assertCheckpointExtension } from './reader-checkpoint.mjs';
import { assertCaptureRetained, assertNoPrune, readTombstone, lineagePath, readLineageRecord, captureLineage } from './capture-retention.mjs';
import { newSelectionState, validateSelectionState, applySelectionControl, evaluateUnitSelection, resolveSelectionAnchor, stableSourceIdentity, currentIntervals } from './capture-selection.mjs';
import { guardStore, intakePath, intakeSnapshot, intakeJSON, assertIntakeTransaction, assertIntakePrivacy, replaceIntakeJSON, writeIntakeStage, MAX_INTAKE_METADATA_BYTES } from './intake-io.mjs';
import { keys, hash, nativeId, integer, list, choice, canonicalJSON, digest, fail } from './workflow-values.mjs';

const selectionPath = identity => {
  logicalCaptureIdentity({ ...identity, unitId: identity.unitId ?? identity.sessionId });
  return `sessions/${identity.client}/${identity.sessionId}.json`;
};
const progressPath = (identity, scopeId) => {
  nativeId(scopeId);
  return `progress/${identity.client}/${identity.sessionId}/${scopeId}.json`;
};
const headPath = identity => {
  const { client, sessionId, unitId } = logicalCaptureIdentity(identity);
  return `heads/${client}/${sessionId}/${unitId}.json`;
};
const capturePath = capture => captureRelativePath(capture.identity, capture.evidenceHash);
function validateHead(value, identity) {
  keys(value, ['format', 'version', 'identity', 'generation', 'previousHash', 'evidenceHash', 'fileHash']);
  if (value.format !== 'cuefluent-capture-head' || value.version !== 1 || value.generation < 1) fail('INVALID_CAPTURE_HEAD');
  logicalCaptureIdentity(value.identity); integer(value.generation); hash(value.evidenceHash); hash(value.fileHash);
  if (value.previousHash !== null) hash(value.previousHash);
  if ((value.generation === 1) !== (value.previousHash === null)) fail('INVALID_CAPTURE_HEAD');
  if (canonicalJSON(value.identity) !== canonicalJSON(identity)) fail('INVALID_CAPTURE_HEAD');
  return value;
}
export async function readCaptureHead(store, identity, { metadataOnly = false } = {}) {
  await assertCaptureRetained(store, identity);
  const snapshot = await intakeSnapshot(store, 'state', headPath(identity));
  const head = intakeJSON(snapshot);
  if (head === null) return { head: null, hash: snapshot.hash, capture: null };
  validateHead(head, identity);
  // Advisory identity/hash inventory only. Publication and evidence use retain
  // the default full raw read, validation and exact file-hash check.
  if (metadataOnly) return { head, hash: snapshot.hash, capture: null };
  const raw = await captureSnapshot(store, captureRelativePath(identity, head.evidenceHash));
  const capture = intakeJSON(raw);
  if (raw.hash !== head.fileHash || !capture || capture.evidenceHash !== head.evidenceHash ||
      canonicalJSON(capture.identity) !== canonicalJSON(identity)) fail('CAPTURE_HEAD_CONFLICT');
  return { head, hash: snapshot.hash, capture };
}
const progressCursor = value => {
  if (value === null) return null;
  const { checkpoint: _checkpoint, ...current } = value;
  cursor(current); return current;
};
const nextProgress = pending => ({ ...pending.transition.to, ...(pending.checkpoint !== null ? { checkpoint: pending.checkpoint } : {}) });
function validateProgress(value, identity, scopeId, sourceIdentity) {
  const current = progressCursor(value);
  if (current && current.sourceIdentity !== sourceIdentity) fail('SOURCE_IDENTITY_MISMATCH');
  if (value?.checkpoint != null) validateStoredCheckpoint(value.checkpoint, { identity, scopeId, sourceIdentity, offset: current.offset });
  return current;
}
export async function readReaderProgress(store, identity, scopeId, sourceIdentity, { metadataOnly = false } = {}) {
  const snapshot = await intakeSnapshot(store, 'state', progressPath(identity, scopeId));
  const value = intakeJSON(snapshot);
  const current = validateProgress(value, identity, scopeId, sourceIdentity);
  const checkpoint = metadataOnly ? null : await hydrateReaderCheckpoint(store, value?.checkpoint ?? null);
  if (checkpoint !== null) validateReaderCheckpoint(checkpoint, { identity, scopeId, sourceIdentity, offset: current.offset });
  return { snapshot, cursor: current, checkpoint, checkpointRoot: value?.checkpoint ?? null };
}
export async function readReaderHeadroom(store, identity, scopeId, sourceIdentity) {
  // Publication reserves counters before pages and progress. Read the checkpoint
  // first: parallel/reversed reads can falsely pair a new root with an absent counter.
  const snapshot = await intakeSnapshot(store, 'state', progressPath(identity, scopeId));
  const value = intakeJSON(snapshot);
  try {
    validateProgress(value, identity, scopeId, sourceIdentity);
  } catch (error) {
    // Only headroom reporting remaps saved-data validation. Collection retains
    // the original errors; guarded reads, privacy and budget failures stay outside.
    if (['INVALID_WORKFLOW', 'INVALID_INTAKE_CURSOR', 'SOURCE_ANCHOR_LIMIT', 'UNSUPPORTED_NATIVE_IDENTITY',
      'SOURCE_IDENTITY_MISMATCH', 'INVALID_READER_CHECKPOINT', 'READER_CHECKPOINT_CAPACITY',
      'READER_CHECKPOINT_IDENTITY_MISMATCH'].includes(error.code)) fail('INVALID_READER_PROGRESS');
    throw error;
  }
  return readReaderAllocation(store, { ...identity, scopeId, sourceIdentity }, value?.checkpoint ?? null);
}
const publicationIdentity = value => digest(canonicalJSON({ identity: value.identity, evidenceHash: value.evidenceHash,
  headHash: value.headHash, scopeId: value.scopeId, selectionHash: value.selectionHash, cursorHash: value.cursorHash,
  checkpointHash: value.checkpoint === null ? null : digest(canonicalJSON(value.checkpoint)),
  floor: value.floor, terminalCursor: value.terminalCursor, scan: value.transition }));
const authorizationContext = (phase, operation, identity, source, scopeId = null) => ({ phase, operation,
  identity: structuredClone(identity), projectRoot: source.projectRoot, sourcePath: source.path, scopeId });
const authorizeOperation = async (authorize, context) => {
  if (typeof authorize !== 'function' || await authorize(context) !== true) fail('INTAKE_NOT_AUTHORIZED');
};

export async function readSelection(store, identity) {
  const snapshot = await intakeSnapshot(store, 'state', selectionPath(identity));
  const state = intakeJSON(snapshot);
  if (state !== null) {
    validateSelectionState(state);
    if (state.source.client !== identity.client || state.source.sessionId !== identity.sessionId) fail('SELECTION_IDENTITY_MISMATCH');
  }
  return { state, hash: snapshot.hash };
}

/** Retrying an opt-out acknowledges its selection but does not hide unresolved
 * publication state. This inspects metadata only and never attempts recovery. */
export async function selectionPendingWarning(store, identity) {
  try {
    const pending = intakeJSON(await intakeSnapshot(store, 'state', 'pending.json'));
    if (pending !== null) descriptor(pending);
    if (pending?.identity?.client === identity.client && pending.identity.sessionId === identity.sessionId) return 'INTAKE_RECOVERY_REQUIRED';
  } catch (error) { return error.code ?? 'INTAKE_RECOVERY_REQUIRED'; }
  return null;
}

export async function controlSelection(transaction, { source, request, boundary, expectedHash, authorize, callerRequestHash, grantHash }) {
  if (callerRequestHash !== undefined) hash(callerRequestHash);
  const store = await assertIntakeTransaction(transaction);
  const restrictive = ['pause', 'exclude'].includes(request.operation);
  if (!restrictive) await assertIntakePrivacy(transaction, { identity: request, projectRoot: source.projectRoot,
    scopeId: request.operation.startsWith('capture-') ? request.id : null });
  // Explicit opt-outs need native/source/state identity, never collection or privacy authorization.
  if (!restrictive) await authorizeOperation(authorize, authorizationContext('control', request.operation,
    { client: request.client, sessionId: request.sessionId, ...(request.unitId ? { unitId: request.unitId } : {}) }, source));
  const before = await readSelection(store, { client: source.client, sessionId: source.sessionId });
  if (before.state && canonicalJSON(before.state.source) !== canonicalJSON(source)) fail('SOURCE_IDENTITY_MISMATCH');
  const state = applySelectionControl(before.state ?? newSelectionState(source), request, boundary, { grantHash });
  if (before.state && canonicalJSON(state) === canonicalJSON(before.state)) return before;
  if (before.hash !== expectedHash) fail('STALE_SELECTION');
  if (callerRequestHash !== undefined) state.lastRequest.callerRequestHash = callerRequestHash;
  let pendingWarning;
  let pending;
  try {
    pending = intakeJSON(await intakeSnapshot(store, 'state', 'pending.json'));
    if (pending !== null) descriptor(pending);
  } catch (error) {
    if (!restrictive) throw error;
    pendingWarning = error.code ?? 'INTAKE_RECOVERY_REQUIRED';
    pending = null;
  }
  if (pending?.identity?.client === source.client && pending.identity.sessionId === source.sessionId) {
    if (!restrictive) fail('INTAKE_RECOVERY_REQUIRED');
    try {
      const cancellation = await abandonPendingPublication(transaction, { reason: 'opt-out' });
      if (cancellation.status === 'already-published') await recoverPendingPublication(transaction, { authorize: async () => true });
    } catch (error) {
      // Preserve unfamiliar recovery evidence while still honoring the disabling control.
      pendingWarning = error.code ?? 'INTAKE_RECOVERY_REQUIRED';
    }
  }
  const resultHash = await replaceIntakeJSON(transaction, selectionPath({ client: source.client, sessionId: source.sessionId }), state, before.hash);
  return { state, hash: resultHash, ...(pendingWarning ? { pendingWarning } : {}) };
}

export async function resolveStoredSelectionAnchor(transaction, { identity, intervalId, side, proven, expectedHash, authorize }) {
  const store = await assertIntakeTransaction(transaction), before = await readSelection(store, identity);
  if (before.state === null || before.hash !== expectedHash) fail('STALE_SELECTION');
  await assertIntakePrivacy(transaction, { identity, projectRoot: before.state.source.projectRoot });
  await authorizeOperation(authorize, authorizationContext('resolve-anchor', 'resolve-anchor', identity, before.state.source, intervalId));
  const pending = intakeJSON(await intakeSnapshot(store, 'state', 'pending.json'));
  if (pending !== null) descriptor(pending);
  if (pending?.identity?.client === identity.client && pending.identity.sessionId === identity.sessionId) fail('INTAKE_RECOVERY_REQUIRED');
  const state = resolveSelectionAnchor(before.state, intervalId, side, proven);
  if (canonicalJSON(state) === canonicalJSON(before.state)) return before;
  return { state, hash: await replaceIntakeJSON(transaction, selectionPath(identity), state, before.hash) };
}

function cursor(value) {
  keys(value, ['sourceIdentity', 'offset', 'anchor']); hash(value.sourceIdentity); integer(value.offset);
  if (value.anchor !== null) {
    keys(value.anchor, ['startByte', 'endByte', 'hash']);
    integer(value.anchor.startByte); integer(value.anchor.endByte); hash(value.anchor.hash);
    if (value.anchor.startByte >= value.anchor.endByte || value.anchor.endByte !== value.offset) fail('INVALID_INTAKE_CURSOR');
    if (value.anchor.endByte - value.anchor.startByte > 64 * 1024) fail('SOURCE_ANCHOR_LIMIT');
  }
}
function transition(value, capture, floor) {
  keys(value, ['from', 'to', 'accounted']); cursor(value.from); cursor(value.to);
  if (value.from.sourceIdentity !== capture.source.fileIdentity || value.to.sourceIdentity !== capture.source.fileIdentity || value.from.offset < floor || value.to.offset < value.from.offset) fail('INVALID_INTAKE_CURSOR');
  if (value.to.offset === value.from.offset) {
    if (canonicalJSON(value.to) !== canonicalJSON(value.from) || !Array.isArray(value.accounted) || value.accounted.length) fail('INVALID_INTAKE_CURSOR');
    return;
  }
  if (value.to.anchor === null) fail('INVALID_INTAKE_CURSOR');
  let offset = value.from.offset;
  list(value.accounted, 1024, { empty: false }).forEach(item => {
    keys(item, ['startByte', 'endByte', 'kind'], ['unitId', 'fileHash', 'evidenceHash']); integer(item.startByte); integer(item.endByte);
    choice(item.kind, ['captured', 'published', 'excluded', 'structural', 'retained']);
    if (item.kind !== 'published' && (item.fileHash !== undefined || item.evidenceHash !== undefined)) fail('INVALID_INTAKE_CURSOR');
    if (item.startByte !== offset || item.endByte <= offset) fail('NONCONTIGUOUS_INTAKE_CURSOR');
    offset = item.endByte;
    if (item.unitId !== undefined) nativeId(item.unitId);
    if (item.kind === 'captured') {
      if (item.unitId !== capture.identity.unitId) fail('INVALID_INTAKE_CURSOR');
    }
    if (item.kind === 'published') { nativeId(item.unitId); hash(item.fileHash); hash(item.evidenceHash); }
  });
  if (offset !== value.to.offset) fail('NONCONTIGUOUS_INTAKE_CURSOR');
}

async function verifyPublishedAccounting(store, pending) {
  const cached = new Map();
  for (const item of pending.transition.accounted.filter(item => item.kind === 'published')) {
    const key = `${item.unitId}/${item.evidenceHash}`;
    let value = cached.get(key);
    if (!value) {
      const identity = { ...pending.identity, unitId: item.unitId };
      const pruned = await readTombstone(store, identity);
      if (pruned) {
        const revision = pruned.revisions.find(entry => entry.evidenceHash === item.evidenceHash && entry.fileHash === item.fileHash);
        if (!revision || pruned.sourceIdentity !== pending.sourceIdentity || !coversRange(item, revision.ranges)) fail('UNVERIFIED_PUBLISHED_UNIT');
        value = { capture: { source: { ranges: revision.ranges } }, hash: revision.fileHash };
        cached.set(key, value);
      }
      if (!value) {
      const snapshot = await captureSnapshot(store, captureRelativePath(identity, item.evidenceHash));
      if (snapshot.bytes === null || snapshot.hash !== item.fileHash) fail('UNVERIFIED_PUBLISHED_UNIT');
      const capture = intakeJSON(snapshot);
      if (canonicalJSON(capture.identity) !== canonicalJSON(identity) || capture.evidenceHash !== item.evidenceHash || capture.source.fileIdentity !== pending.sourceIdentity) fail('UNVERIFIED_PUBLISHED_UNIT');
      const active = await readCaptureHead(store, identity);
      if (!active.capture) fail('UNVERIFIED_PUBLISHED_UNIT');
      if (active.head.evidenceHash !== capture.evidenceHash) {
        const lineage = await captureLineage(store, identity, active.head.previousHash);
        if (!lineage.some(record => record.value.evidenceHash === capture.evidenceHash && record.value.fileHash === snapshot.hash)) fail('UNVERIFIED_PUBLISHED_UNIT');
      }
      // An inert orphan is insufficient. The active head must contain this exact
      // evidence (possibly as a preserved predecessor of its current revision).
      assertCaptureExtension(capture, active.capture);
      value = { capture, hash: snapshot.hash }; cached.set(key, value);
      }
    }
    if (value.hash !== item.fileHash || !coversRange(item, value.capture.source.ranges)) fail('UNVERIFIED_PUBLISHED_UNIT');
  }
}
function verifyRetainedAccounting(scan, checkpoint) {
  for (const segment of scan.accounted.filter(item => item.kind === 'retained')) {
    const records = (checkpoint?.records ?? []).filter(record => record.kind === 'unowned');
    if (!coversRange(segment, records)) fail('UNVERIFIED_READER_CHECKPOINT');
  }
}
function verifyCheckpointSelection(selection, scopeId, scan, checkpoint) {
  if (selection.source.client === 'claude' && scan.to.offset > scan.from.offset && checkpoint === null) fail('READER_CHECKPOINT_REQUIRED');
  const interval = currentIntervals(selection).find(item => item.id === scopeId);
  for (const boundary of [interval?.lower, interval?.upper]) {
    if (boundary && boundary.record === null && checkpoint?.units.some(unit => unit.id === boundary.unitId)) fail('SELECTION_ANCHORS_PENDING');
  }
}
function coversRange(range, segments) {
  let position = range.startByte;
  for (const item of segments) {
    if (item.endByte <= position) continue;
    if (item.startByte > position) return false;
    position = item.endByte;
    if (position >= range.endByte) return true;
  }
  return false;
}

function descriptor(value) {
  keys(value, ['format', 'version', 'id', 'identity', 'sourceIdentity', 'selectionHash', 'scopeId', 'cursorHash',
    'floor', 'terminalCursor', 'transition', 'target', 'existingTarget', 'evidenceHash', 'stage', 'headHash', 'nextHead', 'checkpoint', 'reuseHead']);
  if (value.format !== 'cuefluent-publication' || value.version !== 2) fail('INVALID_INTAKE_METADATA');
  hash(value.id); logicalCaptureIdentity(value.identity); hash(value.sourceIdentity); hash(value.selectionHash);
  nativeId(value.scopeId); if (value.cursorHash !== null) hash(value.cursorHash);
  integer(value.floor); cursor(value.terminalCursor);
  if (value.terminalCursor.sourceIdentity !== value.sourceIdentity) fail('INVALID_INTAKE_METADATA');
  hash(value.evidenceHash);
  if (typeof value.reuseHead !== 'boolean') fail('INVALID_INTAKE_METADATA');
  if (value.target !== captureRelativePath(value.identity, value.evidenceHash)) fail('INVALID_INTAKE_METADATA');
  if (value.headHash !== null) hash(value.headHash);
  validateHead(value.nextHead, value.identity);
  if (value.nextHead.evidenceHash !== value.evidenceHash || value.nextHead.fileHash !== (value.existingTarget?.hash ?? value.stage.hash)) fail('INVALID_CAPTURE_HEAD');
  if (value.checkpoint !== null) validateStoredCheckpoint(value.checkpoint, { identity: value.identity, scopeId: value.scopeId, sourceIdentity: value.sourceIdentity, offset: value.transition.to.offset });
  if (value.existingTarget !== null) { keys(value.existingTarget, ['identity', 'hash']); hash(value.existingTarget.identity); hash(value.existingTarget.hash); }
  keys(value.stage, ['path', 'identity', 'hash', 'bytes']); hash(value.stage.identity); hash(value.stage.hash); integer(value.stage.bytes);
  if (value.stage.bytes > MAX_CAPTURE_BYTES || !new RegExp(`^${value.identity.client}/${value.identity.sessionId}/${value.identity.unitId}/\\.stage-${value.id.slice(0, 20)}-[0-9a-f-]{36}\\.tmp$`).test(value.stage.path)) fail('INVALID_INTAKE_METADATA');
  cursor(value.transition.from); cursor(value.transition.to);
  if (value.id !== publicationIdentity(value)) fail('INVALID_INTAKE_METADATA');
  return value;
}

/** Bounded native cursor anchor check; never scans an archive to recover bookkeeping. */
export async function verifySourceCursor(source, current) {
  try { return await sourceCursor(source, current); }
  catch (error) {
    if (!error.code || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'EBADF',
      'FILE_NOT_REGULAR', 'FILE_LINK_COUNT_INVALID', 'FILE_IDENTITY_CHANGED'].includes(error.code)) {
      throw Object.assign(new Error('Source is unavailable or unsafe.', { cause: error }), { code: 'SOURCE_UNAVAILABLE' });
    }
    throw error;
  }
}
async function sourceCursor(source, current) {
  cursor(current);
  if (current.sourceIdentity !== source.fileIdentity) fail('SOURCE_IDENTITY_MISMATCH');
  const { handle, stat } = await openGuarded(source.path, { singleLink: true });
  try {
    if (stableSourceIdentity(stat) !== source.fileIdentity || stat.size < current.offset) fail('SOURCE_CHANGED');
    if (current.anchor) {
      const size = current.anchor.endByte - current.anchor.startByte;
      if (size > 64 * 1024) fail('SOURCE_ANCHOR_LIMIT');
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await handle.read(bytes, offset, size - offset, current.anchor.startByte + offset);
        if (!result.bytesRead) fail('SOURCE_CHANGED'); offset += result.bytesRead;
      }
      if (digest(bytes) !== current.anchor.hash) fail('SOURCE_ANCHOR_CONFLICT');
    }
    const after = await handle.stat({ bigint: true });
    const currentStat = await fs.lstat(source.path, { bigint: true });
    if (!sameFileIdentity(stat, after) || after.size < stat.size || !sameFileIdentity(stat, currentStat) ||
        after.nlink !== 1n || currentStat.nlink !== 1n) fail('SOURCE_CHANGED');
  } finally { await handle.close(); }
}

async function captureSnapshot(store, name, links = 1) {
  const snapshot = await intakeSnapshot(store, 'raw', name, { maxBytes: MAX_CAPTURE_BYTES, allowLinks: links });
  if (snapshot.bytes !== null) validateCapture(intakeJSON(snapshot));
  return snapshot;
}

/** Only removes the exact descriptor-owned stage; permits the intentional two-link window. */
async function inspectPublicationFiles(transaction, pending) {
  const store = await assertIntakeTransaction(transaction);
  const target = await intakePath(store, 'raw', pending.target), stage = await intakePath(store, 'raw', pending.stage.path);
  const [targetStat, stageStat] = await Promise.all([lstatOrNull(target, { bigint: true }), lstatOrNull(stage, { bigint: true })]);
  const shared = targetStat && stageStat && sameFileIdentity(targetStat, stageStat);
  const targetSnapshot = await captureSnapshot(store, pending.target, shared ? 2 : 1);
  const stageSnapshot = await captureSnapshot(store, pending.stage.path, shared ? 2 : 1);
  if (stageSnapshot.bytes && (stableSourceIdentity(stageSnapshot.identity) !== pending.stage.identity ||
      stageSnapshot.hash !== pending.stage.hash || stageSnapshot.bytes.length !== pending.stage.bytes)) fail('INTAKE_STAGE_CHANGED');
  if (stageSnapshot.bytes && (canonicalJSON(intakeJSON(stageSnapshot).identity) !== canonicalJSON(pending.identity) ||
      intakeJSON(stageSnapshot).evidenceHash !== pending.evidenceHash)) fail('INTAKE_STAGE_CHANGED');
  if (shared && (targetSnapshot.hash !== pending.stage.hash || stableSourceIdentity(targetSnapshot.identity) !== pending.stage.identity)) fail('INTAKE_STAGE_CHANGED');
  if (targetSnapshot.bytes) {
    const value = intakeJSON(targetSnapshot);
    const expected = pending.existingTarget ?? pending.stage;
    if (canonicalJSON(value.identity) !== canonicalJSON(pending.identity) || value.evidenceHash !== pending.evidenceHash ||
        targetSnapshot.hash !== expected.hash || stableSourceIdentity(targetSnapshot.identity) !== expected.identity) fail('CAPTURE_CONFLICT');
  }
  return { target, stage, targetSnapshot, stageSnapshot };
}

async function reconcile(transaction, pending, pendingHash, authorize, fault) {
  descriptor(pending);
  const store = await assertIntakeTransaction(transaction);
  const checkpoint = await hydrateReaderCheckpoint(store, pending.checkpoint);
  let inspected = await inspectPublicationFiles(transaction, pending);
  if (!inspected.targetSnapshot.bytes && !inspected.stageSnapshot.bytes) fail('INTAKE_STAGE_MISSING');
  const capture = intakeJSON(inspected.targetSnapshot.bytes ? inspected.targetSnapshot : inspected.stageSnapshot);
  const source = { ...capture.source, projectRoot: capture.projectRoot };
  const oldHead = await readCaptureHead(store, pending.identity);
  const headBytes = canonicalJSON(pending.nextHead) + '\n', nextHeadHash = digest(headBytes);
  const active = oldHead.hash === nextHeadHash;
  if (!active && oldHead.hash !== pending.headHash) fail('STALE_CAPTURE_HEAD');
  if (!active && (pending.nextHead.previousHash !== oldHead.hash ||
      pending.nextHead.generation !== (oldHead.head?.generation ?? 0) + 1)) fail('INVALID_CAPTURE_HEAD');
  const progressName = progressPath(pending.identity, pending.scopeId);
  const progress = await intakeSnapshot(store, 'state', progressName);
  const nextBytes = Buffer.from(canonicalJSON(nextProgress(pending)) + '\n');
  const progressCommitted = progress.hash === digest(nextBytes);
  const committed = active && (!pending.reuseHead || progressCommitted);
  await assertIntakePrivacy(transaction, { identity: pending.identity, projectRoot: source.projectRoot, scopeId: pending.scopeId, operation: committed ? 'maintenance' : 'collect' });
  const priorReceipt = await intakeSnapshot(store, 'state', `receipts/${pending.id}.json`, { maxBytes: 16 * 1024 });
  if (priorReceipt.bytes !== null && (!committed || canonicalJSON(intakeJSON(priorReceipt)) !==
      canonicalJSON(publicationReceipt(pending, pending.nextHead.fileHash)))) fail('INTAKE_RECEIPT_CONFLICT');
  await authorizeOperation(authorize, authorizationContext(committed ? 'reconcile-published' : 'publish', 'capture', pending.identity, source, pending.scopeId));
  const selection = await readSelection(store, pending.identity);
  if (!committed && selection.hash !== pending.selectionHash) fail('STALE_SELECTION');
  if (!committed && ![...currentIntervals(selection.state), ...selection.state.explicitScopes].some(scope => scope.id === pending.scopeId)) fail('CAPTURE_NOT_SELECTED');
  if (capture.source.fileIdentity !== pending.sourceIdentity) fail('SOURCE_IDENTITY_MISMATCH');
  if (!active && oldHead.capture) assertCaptureExtension(oldHead.capture, capture);
  transition(pending.transition, capture, pending.floor);
  verifyRetainedAccounting(pending.transition, checkpoint);
  await verifyPublishedAccounting(store, pending);
  if (progress.hash !== pending.cursorHash && !progressCommitted) fail('INTAKE_CURSOR_CONFLICT');
  if (progress.hash === pending.cursorHash) assertCheckpointExtension(await hydrateReaderCheckpoint(store, intakeJSON(progress)?.checkpoint ?? null), checkpoint);
  if (!committed) {
    verifyCheckpointSelection(selection.state, pending.scopeId, pending.transition, checkpoint);
    await verifySourceCursor(source, pending.transition.from);
    await verifySourceCursor(source, pending.transition.to);
    await verifySourceCursor(source, pending.terminalCursor);
  }
  if (!inspected.targetSnapshot.bytes) {
    if (pending.existingTarget !== null || !inspected.stageSnapshot.bytes) fail('CAPTURE_CONFLICT');
    await assertIntakeTransaction(transaction);
    await guardStore(store, [inspected.stage, inspected.target]);
    try { await fs.link(inspected.stage, inspected.target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await syncDirectory(path.dirname(inspected.target)); await fault('published');
    inspected = await inspectPublicationFiles(transaction, pending);
  }
  if (inspected.stageSnapshot.bytes) {
    await assertIntakeTransaction(transaction);
    inspected = await inspectPublicationFiles(transaction, pending);
    await guardStore(store, [inspected.stage, inspected.target]);
    await fs.unlink(inspected.stage); await syncDirectory(path.dirname(inspected.stage));
  }
  await fault('stage-removed');
  const final = await captureSnapshot(store, pending.target);
  if (final.hash !== pending.nextHead.fileHash) fail('CAPTURE_CONFLICT');
  if (!active) {
    // Immutable bytes can be an inert orphan. Recheck consent immediately before activation.
    await authorizeOperation(authorize, authorizationContext('activate-head', 'capture', pending.identity, source, pending.scopeId));
    if ((await readSelection(store, pending.identity)).hash !== pending.selectionHash) fail('STALE_SELECTION');
    await hydrateReaderCheckpoint(store, pending.checkpoint);
    await replaceIntakeJSON(transaction, headPath(pending.identity), pending.nextHead, pending.headHash);
  }
  await fault('head');
  const writeReceipt = async () => {
    const receipt = publicationReceipt(pending, final.hash);
    const receiptBytes = Buffer.from(canonicalJSON(receipt) + '\n');
    if (receiptBytes.length > 16 * 1024) fail('INTAKE_RECEIPT_CAPACITY_EXCEEDED');
    const receiptName = `receipts/${pending.id}.json`, oldReceipt = await intakeSnapshot(store, 'state', receiptName, { maxBytes: 16 * 1024 });
    if (oldReceipt.bytes !== null && !oldReceipt.bytes.equals(receiptBytes)) fail('INTAKE_RECEIPT_CONFLICT');
    if (oldReceipt.bytes === null) await replaceIntakeJSON(transaction, receiptName, receipt, null);
    await fault('receipt-index-pending');
    const indexName = lineagePath(pending.identity, receipt.nextHeadHash);
    const index = await intakeSnapshot(store, 'state', indexName, { maxBytes: 16384 });
    if (index.bytes) await readLineageRecord(store, pending.identity, receipt.nextHeadHash);
    else await replaceIntakeJSON(transaction, indexName, { format: 'cuefluent-publication-index', version: 1,
      identity: pending.identity, headHash: receipt.nextHeadHash, receiptPath: receiptName, receiptHash: digest(receiptBytes) }, null);
    await fault('receipt');
  };
  // A new head is the capture commit point. For an already-active head, the
  // combined cursor/checkpoint write commits this new prefix; receipt comes last.
  if (!pending.reuseHead) await writeReceipt();
  if (pending.reuseHead && !progressCommitted) {
    await authorizeOperation(authorize, authorizationContext('commit-progress', 'capture', pending.identity, source, pending.scopeId));
    if ((await readSelection(store, pending.identity)).hash !== pending.selectionHash) fail('STALE_SELECTION');
    await verifySourceCursor(source, pending.transition.from); await verifySourceCursor(source, pending.transition.to);
  }
  if ((await readCaptureHead(store, pending.identity)).hash !== nextHeadHash) fail('CAPTURE_HEAD_CONFLICT');
  await verifyPublishedAccounting(store, pending);
  await hydrateReaderCheckpoint(store, pending.checkpoint);
  if (!progressCommitted) await replaceIntakeJSON(transaction, progressName, nextProgress(pending), pending.cursorHash);
  await fault('cursor');
  if (pending.reuseHead) await writeReceipt();
  await replaceIntakeJSON(transaction, 'pending.json', null, pendingHash);
  return { status: 'published', identity: pending.identity, fileHash: final.hash, evidenceHash: pending.evidenceHash,
    headHash: nextHeadHash, cursorHash: digest(nextBytes), cursor: pending.transition.to, checkpoint };
}

function publicationReceipt(pending, fileHash) {
  return { format: 'cuefluent-capture-receipt', version: 2, publicationId: pending.id, identity: pending.identity,
    evidenceHash: pending.evidenceHash, fileHash, sourceIdentity: pending.sourceIdentity, scopeId: pending.scopeId,
    selectionHash: pending.selectionHash, transitionHash: digest(canonicalJSON(pending.transition)),
    reuseHead: pending.reuseHead, headHash: pending.headHash, nextHead: pending.nextHead, nextHeadHash: digest(canonicalJSON(pending.nextHead) + '\n'),
    checkpointHash: pending.checkpoint === null ? null : digest(canonicalJSON(pending.checkpoint)),
    cursorHash: pending.cursorHash, nextCursorHash: digest(canonicalJSON(nextProgress(pending)) + '\n') };
}

/** Abandon only an unpublished attempt. Preserve its descriptor and never touch existing captures. */
export async function abandonPendingPublication(transaction, { reason = 'cancelled', expectedHash } = {}) {
  const store = await assertIntakeTransaction(transaction);
  const snapshot = await intakeSnapshot(store, 'state', 'pending.json'), pending = intakeJSON(snapshot);
  if (pending === null) return { status: 'idle' };
  if (expectedHash !== undefined && expectedHash !== snapshot.hash) fail('INTAKE_STATE_CONFLICT');
  descriptor(pending);
  if (typeof reason !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(reason)) fail('INVALID_INTAKE_METADATA');
  const inspected = await inspectPublicationFiles(transaction, pending);
  const active = (await readCaptureHead(store, pending.identity)).hash === digest(canonicalJSON(pending.nextHead) + '\n');
  const committedProgress = (await intakeSnapshot(store, 'state', progressPath(pending.identity, pending.scopeId))).hash === digest(canonicalJSON(nextProgress(pending)) + '\n');
  if (active && (!pending.reuseHead || committedProgress)) return { status: 'already-published' };
  if (pending.reuseHead && (await intakeSnapshot(store, 'state', `receipts/${pending.id}.json`)).bytes !== null) fail('INTAKE_RECEIPT_CONFLICT');
  const retained = { format: 'cuefluent-abandoned-publication', version: 1, reason, pending };
  const retainedName = `abandoned/${snapshot.hash}.json`, previous = await intakeSnapshot(store, 'state', retainedName);
  // An earlier cleanup attempt may have retained this exact intent with another diagnostic.
  if (previous.bytes !== null && canonicalJSON(intakeJSON(previous)?.pending) !== canonicalJSON(pending)) fail('INTAKE_STATE_CONFLICT');
  if (previous.bytes === null) await replaceIntakeJSON(transaction, retainedName, retained, null);
  if (inspected.stageSnapshot.bytes) {
    const guard = async () => { await assertIntakeTransaction(transaction); await guardStore(store, [inspected.stage, inspected.target]); };
    await guard();
    if (inspected.stageSnapshot.identity.nlink === 2n && inspected.targetSnapshot.identity && sameFileIdentity(inspected.stageSnapshot.identity, inspected.targetSnapshot.identity)) {
      await inspectPublicationFiles(transaction, pending); await guard(); await fs.unlink(inspected.stage);
    } else if (!await removeOwnedStage(inspected.stage, inspected.stageSnapshot.identity, inspected.stageSnapshot.bytes, { guard })) fail('INTAKE_STAGE_CHANGED');
    await syncDirectory(path.dirname(inspected.stage));
  }
  await replaceIntakeJSON(transaction, 'pending.json', null, snapshot.hash);
  return { status: 'abandoned', reason, identity: pending.identity };
}

async function recoverOrAbandon(transaction, pending, pendingHash, authorize, fault) {
  try { return await reconcile(transaction, pending, pendingHash, authorize, fault); }
  catch (error) {
    // Never bypass changed capture/stage/receipt bytes. Only failures before publication qualify.
    if (['INTAKE_NOT_AUTHORIZED', 'SOURCE_CHANGED', 'SOURCE_IDENTITY_MISMATCH', 'SOURCE_ANCHOR_CONFLICT',
      'SOURCE_ANCHOR_LIMIT', 'SOURCE_UNAVAILABLE', 'ENOENT', 'EACCES', 'EPERM', 'STALE_SELECTION', 'STALE_CAPTURE_HEAD', 'INTAKE_STAGE_MISSING', 'READER_PAGE_CONFLICT'].includes(error.code)) {
      try {
        const abandoned = await abandonPendingPublication(transaction, { expectedHash: pendingHash, reason: error.code });
        if (abandoned.status === 'abandoned') error.abandonedPublication = abandoned;
      } catch (cleanupError) { error.cleanupWarnings = [...(error.cleanupWarnings ?? []), cleanupError.code ?? 'INTAKE_RECOVERY_REQUIRED']; }
    }
    throw error;
  }
}

/** Metadata-only dispatch hint. Recovery rechecks this exact descriptor under the
 * lock; a matching head is not itself authority to publish any new evidence. */
export async function inspectPendingPublication(store) {
  const snapshot = await intakeSnapshot(store, 'state', 'pending.json'), pending = intakeJSON(snapshot);
  if (pending === null) return null;
  descriptor(pending);
  const head = await intakeSnapshot(store, 'state', headPath(pending.identity));
  const progress = await intakeSnapshot(store, 'state', progressPath(pending.identity, pending.scopeId));
  const committed = head.hash === digest(canonicalJSON(pending.nextHead) + '\n') &&
    (!pending.reuseHead || progress.hash === digest(canonicalJSON(nextProgress(pending)) + '\n'));
  return { hash: snapshot.hash, identity: pending.identity, scopeId: pending.scopeId, committed };
}

export async function recoverPendingPublication(transaction, { authorize, expectedHash, fault = async () => {} } = {}) {
  const store = await assertIntakeTransaction(transaction);
  await assertNoPrune(store);
  const snapshot = await intakeSnapshot(store, 'state', 'pending.json'), pending = intakeJSON(snapshot);
  if (pending === null) return { status: 'idle' };
  if (expectedHash !== undefined && snapshot.hash !== expectedHash) fail('INTAKE_RECOVERY_CONFLICT');
  return recoverOrAbandon(transaction, pending, snapshot.hash, authorize, fault);
}

/** Advance a fully accounted reader prefix without manufacturing a capture.
 * Cursor and bounded carry are one atomic metadata value, so there is no second
 * publication transaction to recover. Caller is a trusted registered reader.
 */
export async function commitReaderProgress(transaction, { identity, scopeId, selectionHash, cursorHash, scan, checkpoint, authorize }) {
  const store = await assertIntakeTransaction(transaction);
  await assertNoPrune(store);
  keys(identity, ['client', 'sessionId']); choice(identity.client, ['claude', 'codex']); nativeId(identity.sessionId);
  hash(selectionHash); if (cursorHash !== null) hash(cursorHash);
  if (intakeJSON(await intakeSnapshot(store, 'state', 'pending.json')) !== null) fail('INTAKE_RECOVERY_REQUIRED');
  const selection = await readSelection(store, identity);
  if (!selection.state || selection.hash !== selectionHash) fail('STALE_SELECTION');
  const scope = currentIntervals(selection.state).find(item => item.id === scopeId) ?? selection.state.explicitScopes.find(item => item.id === scopeId);
  if (!scope) fail('CAPTURE_NOT_SELECTED');
  const source = selection.state.source, floor = scope.lower?.eofByte ?? scope.start.startByte;
  await assertIntakePrivacy(transaction, { identity, projectRoot: source.projectRoot, scopeId });
  await authorizeOperation(authorize, authorizationContext('checkpoint', 'capture', identity, source, scopeId));
  transition(scan, { source, identity }, floor);
  if (scan.accounted.some(item => item.kind === 'captured')) fail('UNVERIFIED_PUBLISHED_UNIT');
  validateReaderCheckpoint(checkpoint, { identity, scopeId, sourceIdentity: source.fileIdentity, offset: scan.to.offset });
  verifyRetainedAccounting(scan, checkpoint);
  verifyCheckpointSelection(selection.state, scopeId, scan, checkpoint);
  await verifyPublishedAccounting(store, { identity, sourceIdentity: source.fileIdentity, transition: scan });
  const name = progressPath(identity, scopeId), previous = await intakeSnapshot(store, 'state', name);
  if (previous.hash !== cursorHash || (previous.bytes === null ? scan.from.offset !== floor :
      canonicalJSON(progressCursor(intakeJSON(previous))) !== canonicalJSON(scan.from))) fail('INTAKE_CURSOR_CONFLICT');
  assertCheckpointExtension(await hydrateReaderCheckpoint(store, intakeJSON(previous)?.checkpoint ?? null), checkpoint);
  await verifySourceCursor(source, scan.from); await verifySourceCursor(source, scan.to);
  const next = { ...scan.to, checkpoint: await publishReaderPages(transaction, checkpoint) };
  await authorizeOperation(authorize, authorizationContext('checkpoint', 'capture', identity, source, scopeId));
  if ((await readSelection(store, identity)).hash !== selectionHash) fail('STALE_SELECTION');
  await verifyPublishedAccounting(store, { identity, sourceIdentity: source.fileIdentity, transition: scan });
  await verifySourceCursor(source, scan.from); await verifySourceCursor(source, scan.to);
  await hydrateReaderCheckpoint(store, next.checkpoint);
  const resultHash = await replaceIntakeJSON(transaction, name, next, cursorHash);
  return { status: 'checkpointed', cursorHash: resultHash, cursor: scan.to, checkpoint };
}

/** Caller is a registered reader under current policy; no public command accepts proof JSON. */
export async function publishCapture(transaction, { capture, proof, scopeId, selectionHash, cursorHash, scan,
  expectedHeadHash = null, checkpoint = null, authorize, fault = async () => {} }) {
  const store = await assertIntakeTransaction(transaction);
  await assertNoPrune(store);
  await assertCaptureRetained(store, capture.identity);
  await assertIntakePrivacy(transaction, { identity: capture.identity, projectRoot: capture.projectRoot, scopeId });
  await authorizeOperation(authorize, authorizationContext('prepare', 'capture', capture.identity, { ...capture.source, projectRoot: capture.projectRoot }, scopeId));
  validateCapture(capture); hash(selectionHash); if (cursorHash !== null) hash(cursorHash);
  if (expectedHeadHash !== null) hash(expectedHeadHash);
  nativeId(scopeId);
  if (checkpoint !== null) validateReaderCheckpoint(checkpoint, { identity: capture.identity, scopeId, sourceIdentity: capture.source.fileIdentity, offset: scan.to.offset });
  const before = await intakeSnapshot(store, 'state', 'pending.json');
  if (intakeJSON(before) !== null) fail('INTAKE_RECOVERY_REQUIRED');
  const selection = await readSelection(store, capture.identity);
  if (!selection.state || selection.hash !== selectionHash) fail('STALE_SELECTION');
  const eligibility = evaluateUnitSelection(selection.state, proof).scopes.find(item => item.scopeId === scopeId);
  if (!eligibility || proof.unitId !== capture.identity.unitId || capture.source.path !== selection.state.source.path ||
      capture.projectRoot !== selection.state.source.projectRoot || capture.source.fileIdentity !== selection.state.source.fileIdentity ||
      capture.source.ranges.some(range => range.startByte < proof.start.startByte || range.endByte > proof.end.endByte)) fail('CAPTURE_NOT_SELECTED');
  const interval = currentIntervals(selection.state).find(item => item.id === eligibility.scopeId);
  const explicit = selection.state.explicitScopes.find(item => item.id === eligibility.scopeId);
  const floor = interval?.lower.eofByte ?? explicit.start.startByte;
  transition(scan, capture, floor);
  verifyRetainedAccounting(scan, checkpoint);
  verifyCheckpointSelection(selection.state, scopeId, scan, checkpoint);
  const terminalCursor = { sourceIdentity: capture.source.fileIdentity, offset: proof.end.endByte,
    anchor: { startByte: proof.end.startByte, endByte: proof.end.endByte, hash: proof.end.hash } };
  cursor(terminalCursor);
  if (scan.to.offset > scan.from.offset && (canonicalJSON(scan.to) !== canonicalJSON(terminalCursor) ||
      capture.source.ranges.filter(r => r.endByte > scan.from.offset).some(range => !coversRange({ ...range, startByte: Math.max(range.startByte, scan.from.offset) },
        scan.accounted.filter(item => ['captured', 'published'].includes(item.kind) && item.unitId === capture.identity.unitId))))) fail('INVALID_INTAKE_CURSOR');
  const progress = await intakeSnapshot(store, 'state', progressPath(capture.identity, eligibility.scopeId));
  const currentHead = await readCaptureHead(store, capture.identity);
  const existing = await captureSnapshot(store, capturePath(capture));
  if (existing.bytes && (canonicalJSON(intakeJSON(existing).identity) !== canonicalJSON(capture.identity) || intakeJSON(existing).evidenceHash !== capture.evidenceHash)) fail('CAPTURE_LOCATOR_COLLISION');
  const bytes = serializeCapture(capture);
  const sameHead = currentHead.head?.evidenceHash === capture.evidenceHash;
  const nextHead = sameHead ? currentHead.head : { format: 'cuefluent-capture-head', version: 1, identity: capture.identity,
    generation: (currentHead.head?.generation ?? 0) + 1, previousHash: expectedHeadHash,
    evidenceHash: capture.evidenceHash, fileHash: existing.hash ?? digest(bytes) };
  const pending = { format: 'cuefluent-publication', version: 2, identity: capture.identity,
    sourceIdentity: capture.source.fileIdentity, selectionHash, scopeId, cursorHash, floor, terminalCursor, transition: scan,
    headHash: expectedHeadHash, nextHead, checkpoint: planReaderCheckpoint(checkpoint).root, reuseHead: Boolean(sameHead), target: capturePath(capture),
    existingTarget: existing.bytes ? { identity: stableSourceIdentity(existing.identity), hash: existing.hash } : null,
    evidenceHash: capture.evidenceHash };
  const id = publicationIdentity(pending); pending.id = id;
  const completed = intakeJSON(await intakeSnapshot(store, 'state', `receipts/${id}.json`, { maxBytes: 16 * 1024 }));
  if (completed !== null) {
    // An exact old receipt is idempotent even after a newer head; never reactivate it.
    validateHead(completed.nextHead, capture.identity);
    if (typeof completed.reuseHead !== 'boolean') fail('INTAKE_RECEIPT_CONFLICT');
    if (!existing.bytes || completed.nextHead.evidenceHash !== capture.evidenceHash || completed.nextHead.fileHash !== existing.hash ||
        canonicalJSON(completed) !== canonicalJSON(publicationReceipt({ ...pending, nextHead: completed.nextHead, reuseHead: completed.reuseHead }, existing.hash)) ||
        !currentHead.head || (sameHead && currentHead.hash !== completed.nextHeadHash) ||
        (!sameHead && currentHead.head.generation <= completed.nextHead.generation)) fail('INTAKE_RECEIPT_CONFLICT');
    const current = progressCursor(intakeJSON(progress));
    if (current === null || current.sourceIdentity !== capture.source.fileIdentity || current.offset < scan.to.offset) fail('INTAKE_CURSOR_CONFLICT');
    return { status: 'already-published', identity: capture.identity, fileHash: existing.hash, evidenceHash: capture.evidenceHash,
      headHash: currentHead.hash, cursorHash: progress.hash, cursor: current, checkpoint: await hydrateReaderCheckpoint(store, intakeJSON(progress)?.checkpoint ?? null) };
  }
  if (!sameHead && currentHead.hash !== expectedHeadHash) fail('STALE_CAPTURE_HEAD');
  if (currentHead.capture) assertCaptureExtension(currentHead.capture, capture);
  if (progress.hash !== cursorHash || (progress.bytes === null ? scan.from.offset !== floor : canonicalJSON(progressCursor(intakeJSON(progress))) !== canonicalJSON(scan.from))) fail('INTAKE_CURSOR_CONFLICT');
  assertCheckpointExtension(await hydrateReaderCheckpoint(store, intakeJSON(progress)?.checkpoint ?? null), checkpoint);
  pending.stage = { path: `${capture.identity.client}/${capture.identity.sessionId}/${capture.identity.unitId}/.stage-${id.slice(0, 20)}-${randomUUID()}.tmp`,
    identity: '0'.repeat(64), hash: digest(bytes), bytes: bytes.length };
  if (Buffer.byteLength(canonicalJSON(pending)) + 1024 > MAX_INTAKE_METADATA_BYTES) fail('INTAKE_METADATA_CAPACITY_EXCEEDED');
  await verifyPublishedAccounting(store, pending);
  await authorizeOperation(authorize, authorizationContext('publish', 'capture', capture.identity, selection.state.source, scopeId));
  if (!sameHead || scan.to.offset > scan.from.offset || checkpoint !== null) {
    await verifySourceCursor(selection.state.source, scan.from);
    await verifySourceCursor(selection.state.source, scan.to);
    await verifySourceCursor(selection.state.source, terminalCursor);
  }
  await publishReaderPages(transaction, checkpoint);
  const stage = await writeIntakeStage(store, 'raw', pending.stage.path, bytes, () => assertIntakeTransaction(transaction));
  pending.stage.identity = stableSourceIdentity(stage.identity);
  await fault('staged');
  const pendingHash = await replaceIntakeJSON(transaction, 'pending.json', descriptor(pending), before.hash);
  await fault('intent');
  return recoverOrAbandon(transaction, pending, pendingHash, authorize, fault);
}
