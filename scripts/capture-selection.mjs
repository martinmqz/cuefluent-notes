import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { openGuarded, sameFileIdentity } from './file-io.mjs';
import { canonicalWorkflowProject, absolutePath, canonicalWorkflowPath } from './workflow-paths.mjs';
import { CLIENTS, keys, choice, nativeId, integer, hash, list, unique, string, canonicalJSON, digest, fail } from './workflow-values.mjs';

// Every source-header read is bounded by this. Claude CLI 2.1.303 writes about
// 160 KiB of API request snapshots before a session's first identity row.
export const SOURCE_HEADER_BYTES = 1024 * 1024;

export const MAX_SELECTION_BYTES = 1024 * 1024;
const ACTIVE_SELECTION_BYTES = MAX_SELECTION_BYTES - 16 * 1024;
// An explicit capture stops this far short of the active ceiling, so `pause
// chat` and `resume chat` keep room after captures fill the record.
const CAPTURE_SELECTION_BYTES = ACTIVE_SELECTION_BYTES - 16 * 1024;
export const stableSourceIdentity = stat => digest(canonicalJSON([stat.dev, stat.ino, stat.birthtimeNs].map(String)));
const optionalId = value => value === null ? null : nativeId(value);
function record(value) {
  keys(value, ['id', 'startByte', 'endByte', 'hash']); string(value.id, 256);
  integer(value.startByte); integer(value.endByte); hash(value.hash);
  if (value.endByte <= value.startByte) fail('INVALID_SOURCE_ANCHOR');
}
// A typed window's `passed` stretch: from where its capture began reading,
// before its first turn, to its end, with the hash of those bytes.
function passedStretch(scope) {
  if (scope.passed === undefined) return;
  keys(scope.passed, ['from', 'hash']); integer(scope.passed.from); hash(scope.passed.hash);
  if (scope.passed.from >= scope.start.startByte) fail('INVALID_SELECTION');
}
function boundary(value) {
  keys(value, ['sourceIdentity', 'eofByte', 'startsMidRecord', 'unitId', 'record']);
  hash(value.sourceIdentity); integer(value.eofByte); optionalId(value.unitId);
  if (typeof value.startsMidRecord !== 'boolean') fail('INVALID_SOURCE_ANCHOR');
  if (value.record !== null) record(value.record);
}

/** Explicit selection only. A registered reader verifies a bounded header; never scan history.
 * verifyHeader is trusted adapter code, not serialized/user-supplied configuration.
 */
export async function inspectSourceBoundary(selected, { verifyHeader, currentUnitId = null, frozen = null } = {}) {
  keys(selected, ['client', 'sessionId', 'path', 'projectRoot']);
  choice(selected.client, CLIENTS); nativeId(selected.sessionId); optionalId(currentUnitId);
  const file = await canonicalWorkflowPath(selected.path, { directory: false });
  const project = await canonicalWorkflowProject(selected.projectRoot, { allowMissing: false });
  if (typeof verifyHeader !== 'function') fail('SOURCE_READER_REQUIRED');
  const opened = await openGuarded(file, { missing: true, singleLink: true });
  if (!opened) return { status: 'pending-source', selected: structuredClone(selected) };
  const { handle, stat } = opened;
  try {
    const size = frozen === null ? Number(stat.size) : integer(frozen.eofByte);
    integer(size);
    if (frozen !== null && (stableSourceIdentity(stat) !== frozen.fileIdentity || stat.size < BigInt(size))) fail('SOURCE_CHANGED');
    let headerBytes = 0;
    const readHeader = async (offset, length) => {
      integer(offset); integer(length);
      if (offset + length > Math.min(Number(stat.size), SOURCE_HEADER_BYTES) || headerBytes + length > SOURCE_HEADER_BYTES) fail('SOURCE_HEADER_LIMIT');
      headerBytes += length;
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, offset);
      return bytes.subarray(0, result.bytesRead);
    };
    const header = await verifyHeader({ readHeader, size: Number(stat.size) });
    if (header?.client !== selected.client || header.sessionId !== selected.sessionId ||
        await canonicalWorkflowProject(header.projectRoot, { allowMissing: false }) !== project) fail('SOURCE_IDENTITY_MISMATCH');
    let startsMidRecord = false;
    if (size) {
      const byte = Buffer.alloc(1);
      if ((await handle.read(byte, 0, 1, size - 1)).bytesRead !== 1) fail('SOURCE_CHANGED');
      startsMidRecord = byte[0] !== 10;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(file, { bigint: true });
    if (!sameFileIdentity(stat, after) || !sameFileIdentity(stat, current) || after.size < stat.size ||
        after.nlink !== 1n || current.nlink !== 1n) fail('SOURCE_CHANGED');
    return { status: 'registered', source: { ...selected, path: file, projectRoot: project,
      fileIdentity: stableSourceIdentity(stat) }, boundary: { sourceIdentity: stableSourceIdentity(stat),
      eofByte: size, startsMidRecord, unitId: currentUnitId, record: null } };
  } finally { await handle.close(); }
}

export function newSelectionState(source) {
  const value = { format: 'cuefluent-selection', schemaVersion: 1, source: structuredClone(source), revision: 0,
    active: false, paused: false, currentGrantHash: null, intervals: [], exclusions: [], explicitScopes: [], safetyStop: null, lastRequest: null };
  validateSelectionState(value); return value;
}
export function validateSelectionState(value) {
  keys(value, ['format', 'schemaVersion', 'source', 'revision', 'active', 'paused', 'currentGrantHash', 'intervals', 'exclusions', 'explicitScopes', 'safetyStop', 'lastRequest']);
  if (value.currentGrantHash !== null) hash(value.currentGrantHash);
  if (typeof value.paused !== 'boolean' || (value.paused && value.active)) fail('INVALID_SELECTION');
  if (value.format !== 'cuefluent-selection' || value.schemaVersion !== 1 || typeof value.active !== 'boolean') fail('INVALID_SELECTION');
  if (value.intervals?.length > 1024 || value.exclusions?.length > 4096 || value.explicitScopes?.length > 4096 ||
      Buffer.byteLength(canonicalJSON(value)) > MAX_SELECTION_BYTES) fail('SELECTION_CAPACITY_EXCEEDED');
  keys(value.source, ['client', 'sessionId', 'path', 'projectRoot', 'fileIdentity']);
  choice(value.source.client, CLIENTS); nativeId(value.source.sessionId); hash(value.source.fileIdentity);
  absolutePath(value.source.path); absolutePath(value.source.projectRoot); integer(value.revision);
  let open = 0, lastFloor = -1;
  list(value.intervals, 1024).forEach(item => {
    keys(item, ['id', 'lower', 'upper'], ['grantHash']); nativeId(item.id); boundary(item.lower);
    if (item.grantHash != null) hash(item.grantHash);
    if (item.lower.sourceIdentity !== value.source.fileIdentity || item.lower.eofByte < lastFloor) fail('INVALID_SELECTION');
    lastFloor = item.lower.eofByte;
    if (item.upper === null) { if (currentInterval(value, item)) open++; }
    else { boundary(item.upper); if (item.upper.sourceIdentity !== value.source.fileIdentity || item.upper.eofByte < item.lower.eofByte) fail('INVALID_SELECTION'); }
  });
  unique(value.intervals.map(item => item.id));
  if (open !== Number(value.active) || (value.active && (!currentInterval(value, value.intervals.at(-1)) || value.intervals.at(-1)?.upper !== null))) fail('INVALID_SELECTION');
  list(value.exclusions, 4096).forEach(nativeId); unique(value.exclusions);
  list(value.explicitScopes, 4096).forEach(item => {
    keys(item, ['id', 'kind', 'unitIds', 'start', 'end'], ['contentHash', 'passed']); nativeId(item.id); choice(item.kind, ['current', 'historical']);
    if (item.contentHash !== undefined) hash(item.contentHash);
    list(item.unitIds, 4096, { empty: false }).forEach(nativeId); unique(item.unitIds);
    record(item.start); passedStretch(item);
    if (item.end !== null) { record(item.end); if (item.end.endByte < item.start.endByte) fail('INVALID_SELECTION'); }
    if (item.kind === 'historical' && item.end === null) fail('INVALID_SELECTION');
  });
  unique(value.explicitScopes.map(item => item.id));
  unique([...value.intervals, ...value.explicitScopes].map(item => item.id));
  if (value.safetyStop !== null) {
    keys(value.safetyStop, ['reason', 'unitId']); choice(value.safetyStop.reason, ['capacity']); nativeId(value.safetyStop.unitId);
  }
  if (value.lastRequest !== null) {
    keys(value.lastRequest, ['id', 'inputHash'], ['callerRequestHash']); nativeId(value.lastRequest.id); hash(value.lastRequest.inputHash);
    if (value.lastRequest.callerRequestHash !== undefined) hash(value.lastRequest.callerRequestHash);
  }
  if (Buffer.byteLength(canonicalJSON(value)) > MAX_SELECTION_BYTES) fail('SELECTION_CAPACITY_EXCEEDED');
  return value;
}
export const currentInterval = (state, interval) => (interval.grantHash ?? null) === state.currentGrantHash;
export const currentIntervals = state => state.intervals.filter(interval => currentInterval(state, interval));
const deniedUnit = (state, unitId) => state.safetyStop !== null || state.exclusions.includes(unitId) ||
  state.intervals.some(item => item.upper?.unitId === unitId);
function addExclusion(state, unitId) {
  if (deniedUnit(state, unitId)) return;
  if (state.exclusions.length >= 4096 || Buffer.byteLength(canonicalJSON(state)) + 256 > ACTIVE_SELECTION_BYTES) {
    state.safetyStop = { reason: 'capacity', unitId }; return;
  }
  state.exclusions.push(unitId);
}

/** Pure structured control. The caller holds the intake lock, checks current policy/context,
 * and durably acknowledges the returned state before reporting success.
 */
export function applySelectionControl(state, request, trustedBoundary, { grantHash = state.currentGrantHash } = {}) {
  validateSelectionState(state);
  keys(request, ['id', 'client', 'sessionId', 'operation', 'expectedRevision'], ['unitId', 'scope']);
  nativeId(request.id); nativeId(request.sessionId); choice(request.client, CLIENTS); integer(request.expectedRevision);
  choice(request.operation, ['start', 'resume', 'pause', 'exclude', 'capture-current', 'capture-historical']);
  keys(request, ['id', 'client', 'sessionId', 'operation', 'expectedRevision',
    ...(request.operation !== 'capture-historical' ? ['unitId'] : []),
    ...(request.operation.startsWith('capture-') ? ['scope'] : [])]);
  if (request.client !== state.source.client || request.sessionId !== state.source.sessionId) fail('SELECTION_IDENTITY_MISMATCH');
  if (grantHash !== null) hash(grantHash);
  const inputHash = digest(canonicalJSON({ request, grantHash }));
  if (state.lastRequest?.id === request.id) {
    if (state.lastRequest.inputHash !== inputHash) fail('SELECTION_REQUEST_CONFLICT');
    return structuredClone(state);
  }
  if (request.expectedRevision !== state.revision) fail('STALE_SELECTION');
  const next = structuredClone(state);
  const restrictive = ['pause', 'exclude'].includes(request.operation);
  if (!restrictive && state.safetyStop !== null) fail('SELECTION_CAPACITY_EXCEEDED');
  if (['start', 'resume', 'pause'].includes(request.operation)) {
    boundary(trustedBoundary);
    if (trustedBoundary.sourceIdentity !== state.source.fileIdentity) fail('SOURCE_IDENTITY_MISMATCH');
    if (request.unitId !== trustedBoundary.unitId) fail('SELECTION_IDENTITY_MISMATCH');
    if (request.operation === 'pause' && trustedBoundary.unitId === null) fail('NATIVE_BOUNDARY_REQUIRED');
    if (state.intervals.some(item => item.lower.eofByte > trustedBoundary.eofByte || (item.upper && item.upper.eofByte > trustedBoundary.eofByte))) fail('SOURCE_CHANGED');
    if (request.operation === 'pause') {
      // Native ancestry still determines eligibility. Claude additionally freezes
      // automatic inspection at this EOF; Codex may drain late native terminals.
      if (next.active) next.intervals.at(-1).upper = structuredClone(trustedBoundary);
      next.active = false;
      next.paused = true;
      addExclusion(next, trustedBoundary.unitId);
    } else if (!next.active || next.currentGrantHash !== grantHash) {
      next.currentGrantHash = grantHash;
      next.intervals.push({ id: randomUUID(), lower: structuredClone(trustedBoundary), upper: null, grantHash }); next.active = true; next.paused = false;
    }
  } else if (request.operation === 'exclude') {
    nativeId(request.unitId);
    addExclusion(next, request.unitId);
  } else {
    keys(request.scope, ['unitIds', 'start', 'end'], ['contentHash', 'passed']);
    if (request.scope.contentHash !== undefined) hash(request.scope.contentHash);
    record(request.scope.start); passedStretch(request.scope);
    list(request.scope.unitIds, 4096, { empty: false }).forEach(nativeId);
    if (request.scope.unitIds.some(unit => deniedUnit(state, unit))) fail('EXCLUDED_CAPTURE_REQUEST');
    if (request.operation === 'capture-current' && (request.scope.unitIds.length !== 1 || request.scope.unitIds[0] !== request.unitId)) fail('SELECTION_IDENTITY_MISMATCH');
    next.explicitScopes.push({ id: request.id, kind: request.operation === 'capture-current' ? 'current' : 'historical', ...structuredClone(request.scope) });
  }
  next.revision++;
  next.lastRequest = { id: request.id, inputHash };
  const ceiling = request.operation.startsWith('capture-') ? CAPTURE_SELECTION_BYTES : ACTIVE_SELECTION_BYTES;
  if (!restrictive && Buffer.byteLength(canonicalJSON(next)) > ceiling) fail('SELECTION_CAPACITY_EXCEEDED');
  return validateSelectionState(next);
}

/** A trusted reader must prove this order using native links/sequence/lifecycle semantics.
 * Schema validation cannot establish the truth of a proof. No CLI accepts serialized proofs.
 */
export function evaluateUnitSelection(state, proof) {
  validateSelectionState(state);
  keys(proof, ['client', 'sessionId', 'sourceIdentity', 'unitId', 'start', 'end', 'nativeOrder']);
  choice(proof.client, CLIENTS); nativeId(proof.sessionId); hash(proof.sourceIdentity); nativeId(proof.unitId);
  record(proof.start); record(proof.end);
  if (proof.client !== state.source.client || proof.sessionId !== state.source.sessionId || proof.sourceIdentity !== state.source.fileIdentity) fail('SOURCE_IDENTITY_MISMATCH');
  if (proof.end.endByte < proof.start.endByte) fail('INVALID_SOURCE_ANCHOR');
  if (deniedUnit(state, proof.unitId)) return { selected: false, scopes: [], reason: state.safetyStop ? 'safety-stop' : 'excluded' };
  const scopes = state.explicitScopes.filter(scope => scope.unitIds.includes(proof.unitId) &&
    proof.start.startByte >= scope.start.startByte && (scope.end === null || proof.end.endByte <= scope.end.endByte) &&
    (scope.kind !== 'current' || canonicalJSON(proof.start) === canonicalJSON(scope.start)))
    .reverse().map(scope => ({ scopeId: scope.id, kind: scope.kind }));
  const pendingScopes = [];
  if (proof.nativeOrder === null) {
    pendingScopes.push(...currentIntervals(state).filter(item => proof.start.startByte >= item.lower.eofByte).map(item => item.id));
    return scopes.length ? { selected: true, ...scopes[0], scopes, pendingScopes }
      : { selected: false, scopes, pendingScopes, reason: pendingScopes.length ? 'anchor-unresolved' : 'outside-interval' };
  }
  keys(proof.nativeOrder, ['kind', 'units', 'anchors']);
  choice(proof.nativeOrder.kind, ['native-links', 'native-sequence', 'verified-lifecycle']);
  list(proof.nativeOrder.units, 4096, { empty: false }).forEach(nativeId); unique(proof.nativeOrder.units);
  list(proof.nativeOrder.anchors, 4096, { empty: false }).forEach(item => {
    keys(item, ['unitId', 'record']); nativeId(item.unitId); record(item.record);
  });
  if (!proof.nativeOrder.anchors.some(item => item.unitId === proof.unitId && canonicalJSON(item.record) === canonicalJSON(proof.start))) fail('INVALID_SOURCE_ANCHOR');
  const position = proof.nativeOrder.units.indexOf(proof.unitId);
  if (position < 0) fail('INVALID_SOURCE_ANCHOR');
  const anchored = anchor => anchor.unitId !== null && proof.nativeOrder.anchors.some(item =>
    item.unitId === anchor.unitId && anchor.record !== null && canonicalJSON(item.record) === canonicalJSON(anchor.record));
  for (const interval of currentIntervals(state)) {
    if (proof.start.startByte < interval.lower.eofByte ||
        (interval.lower.startsMidRecord && proof.start.startByte === interval.lower.eofByte)) continue;
    if (!anchored(interval.lower)) { pendingScopes.push(interval.id); continue; }
    const low = proof.nativeOrder.units.indexOf(interval.lower.unitId);
    if (low < 0) { pendingScopes.push(interval.id); continue; }
    if (position <= low) continue;
    if (interval.upper !== null) {
      if (!anchored(interval.upper)) { pendingScopes.push(interval.id); continue; }
      const high = proof.nativeOrder.units.indexOf(interval.upper.unitId);
      if (high < 0) { pendingScopes.push(interval.id); continue; }
      if (position >= high) continue;
    }
    scopes.push({ scopeId: interval.id, kind: 'future' });
  }
  return scopes.length ? { selected: true, ...scopes[0], scopes, pendingScopes }
    : { selected: false, scopes, pendingScopes, reason: pendingScopes.length ? 'anchor-unresolved' : 'outside-interval' };
}

/** Resolve only the named native anchor; never lower a saved floor or change unit identity. */
export function resolveSelectionAnchor(state, intervalId, side, proven) {
  validateSelectionState(state); nativeId(intervalId); choice(side, ['lower', 'upper']);
  keys(proven, ['sourceIdentity', 'unitId', 'record']); hash(proven.sourceIdentity); nativeId(proven.unitId); record(proven.record);
  const next = structuredClone(state), anchor = currentIntervals(next).find(item => item.id === intervalId)?.[side];
  if (!anchor || (anchor.unitId !== null && anchor.unitId !== proven.unitId) || anchor.sourceIdentity !== proven.sourceIdentity ||
      (anchor.unitId === null && (side !== 'lower' || proven.record.startByte < anchor.eofByte))) fail('SOURCE_IDENTITY_MISMATCH');
  if (anchor.record !== null && canonicalJSON(anchor.record) !== canonicalJSON(proven.record)) fail('SOURCE_ANCHOR_CONFLICT');
  anchor.unitId = proven.unitId; anchor.record = structuredClone(proven.record);
  if (Buffer.byteLength(canonicalJSON(next)) > ACTIVE_SELECTION_BYTES) fail('SELECTION_CAPACITY_EXCEEDED');
  return validateSelectionState(next);
}
