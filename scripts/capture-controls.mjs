import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWorkflowStorage, workflowCollectionGrant } from './workflow-storage.mjs';
import { openWorkflowIntake, openExplicitCaptureIntake, inspectIntakeStore, withIntakeLock, withIntakeLockWaiting, intakeSnapshot, intakeJSON, replaceIntakeJSON, intakePath } from './intake-io.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { canonicalWorkflowProject, validateWorkflowPlacement } from './workflow-paths.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { readContinuesLink, readContinuedLink, continuationTarget, continuationOrigin } from './claude-continuation.mjs';
import { readSelection, controlSelection, recoverPendingPublication, selectionPendingWarning, readReaderHeadroom, readCaptureHead, readReaderProgress, verifySourceCursor } from './intake-store.mjs';
import { openGuarded, lstatOrNull, sameFileIdentity } from './file-io.mjs';
import { chosenStretch } from './session-jsonl.mjs';
import { inspectSourceBoundary, newSelectionState, currentIntervals, stableSourceIdentity, MAX_SELECTION_BYTES } from './capture-selection.mjs';
import { codexRegistrationHeader, readCodexSelection } from './codex-reader.mjs';
import { claudeRegistrationHeader, readClaudeSelection } from './claude-reader.mjs';
import { snapshotSourceMetadata } from './collection-ingress.mjs';
import { processScope, READER_BLOCK_CODES, clearReaderBlock } from './collection-worker.mjs';
import { normalizeWorkflowSelection as selected } from './workflow-selection.mjs';
import { withWorkflowBudget } from './workflow-budget.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { keys, nativeId, isNativeId, hash, integer, list, unique, choice, canonicalJSON, digest, digestId, fail, safeErrorCode } from './workflow-values.mjs';

const identityOf = ({ client, sessionId }) => ({ client, sessionId });
const oldHash = value => { if (value !== null) hash(value); };
// One bounded operation of at most 10 s, or less when a typed command's
// `deadline` (`performance.now()`) comes first.
const bounded = (now, run, deadline = null) => {
  const milliseconds = deadline === null ? 10_000 : Math.min(10_000, Math.floor(deadline - performance.now()));
  if (milliseconds <= 0) fail('WORKER_TIME_BUDGET');
  return withWorkflowBudget({ now, milliseconds }, () => withStorageProbes(run));
};
// A typed command's steps wait briefly for an intake lock another pass holds,
// as its own bookkeeping does; a CLI step refuses at once as busy.
const intakeLock = wait => wait ? withIntakeLockWaiting : withIntakeLock;
const reader = client => client === 'codex' ? readCodexSelection : readClaudeSelection;
// Public retries bind the original request, including its inspected hash. They
// reuse the saved effect without deriving another EOF or rereading evidence.
async function replayControl(current, request, store) {
  if (current.state?.lastRequest?.id !== request.operationId) return null;
  if (current.state.lastRequest.callerRequestHash !== digest(canonicalJSON(request))) fail('SELECTION_REQUEST_CONFLICT');
  const pendingWarning = ['pause', 'exclude'].includes(request.operation)
    ? await selectionPendingWarning(store, request.selection) : null;
  return { ...current, ...(pendingWarning ? { pendingWarning } : {}) };
}
async function sourceBoundary(selection, sourcePath, expectedSourceIdentity, unitId, continuation = null) {
  hash(expectedSourceIdentity);
  const source = { client: selection.client, sessionId: selection.sessionId, projectRoot: selection.cwd, path: sourcePath };
  const observed = await inspectSourceBoundary(source, { currentUnitId: unitId, verifyHeader: selection.client === 'codex'
    ? codexRegistrationHeader(source) : claudeRegistrationHeader(source, { sessionKinds: continuation?.from?.sessionKinds ?? [] }) });
  if (observed.status !== 'registered') fail('SOURCE_BOUNDARY_PENDING');
  if (observed.source.fileIdentity !== expectedSourceIdentity) fail('SOURCE_CHANGED');
  return observed;
}

// A Claude chat continued from another (`/bg`) or into one, as its verified
// links record it, the way the worker reads it: the successor's session kind
// is accepted and its re-homed prefix is checked, never read as its own.
async function chatContinuation(store, selection, sourcePath, fileIdentity, observeRead = () => {}) {
  if (selection.client !== 'claude') return null;
  const source = { client: selection.client, sessionId: selection.sessionId, projectRoot: selection.cwd, path: sourcePath, fileIdentity };
  const from = await continuationTarget(await readContinuesLink(store, selection.sessionId), source, null, { observeRead });
  const into = continuationOrigin(await readContinuedLink(store, selection.sessionId), source, null);
  return from || into ? { from, into } : null;
}

/** Explicit inspection of one named source. No transcript content or filesystem writes. */
export async function captureSelectionStatus(capability, { selection, sourcePath = null, scopeId, includeReaderAllocation = false }) {
  selection = await selected(selection);
  if (scopeId !== undefined) nativeId(scopeId);
  if (typeof includeReaderAllocation !== 'boolean') fail('INVALID_WORKFLOW');
  await assertWorkflowStorage(capability); // Status and restrictive controls remain available after opting out.
  const store = await openWorkflowIntake(capability), current = await readSelection(store, identityOf(selection));
  if (current.state && current.state.source.projectRoot !== selection.cwd) fail('SOURCE_IDENTITY_MISMATCH');
  const readerAllocation = includeReaderAllocation || scopeId !== undefined
    ? await selectionHeadroom(store, selection, current.state, scopeId) : undefined;
  return { ...current, source: sourcePath === null ? null : await snapshotSourceMetadata(sourcePath),
    ...(readerAllocation === undefined ? {} : { readerAllocation }) };
}

const headroomReadErrors = new Set(['READER_ALLOCATION_INCONSISTENT', 'INVALID_INTAKE_METADATA', 'INVALID_READER_PROGRESS',
  'INVALID_READER_CHECKPOINT', 'READER_CHECKPOINT_CAPACITY', 'INTAKE_FILE_CHANGED',
  'FILE_IDENTITY_CHANGED', 'FILE_NOT_REGULAR', 'FILE_SIZE_LIMIT_EXCEEDED',
  'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO']);
async function selectionHeadroom(store, selection, state, scopeId) {
  const scopeIds = state ? [...state.intervals, ...state.explicitScopes].map(item => item.id) : [];
  if (scopeId !== undefined && !scopeIds.includes(scopeId)) fail('UNKNOWN_CAPTURE_SCOPE');
  if (selection.client === 'codex') return { status: 'not-applicable', scopeIds };
  const limits = 'Cumulative reserved allocation includes interrupted attempts and obsolete pages; it is not disk usage. Checkpoint counts are references, not page validation. Metadata reads may lag active collection; headroom is informational, not a reservation.';
  const base = { scopeIds, maxScopes: 32, limits };
  if (!state || !scopeIds.length) return { ...base, status: 'unavailable', reason: state ? 'no-known-scopes' : 'no-selection', scopes: [] };
  if (scopeId === undefined && scopeIds.length > base.maxScopes) return { ...base, status: 'scope-selection-required', scopes: [] };
  const scopes = [];
  for (const id of scopeId === undefined ? scopeIds : [scopeId]) {
    try { scopes.push(await readReaderHeadroom(store, identityOf(selection), id, state.source.fileIdentity)); }
    catch (error) {
      const code = safeErrorCode(error);
      if (!headroomReadErrors.has(code)) throw error;
      scopes.push({ scopeId: id, status: code === 'READER_ALLOCATION_INCONSISTENT' ? 'inconsistent' : 'unavailable', error: code });
    }
  }
  return { ...base, status: scopes.some(item => item.error) ? 'partial' : 'available', scopes };
}

/** Future start/resume freezes EOF. With no verified current native anchor the
 * first subsequent full native unit establishes (and is excluded by) the floor. */
export async function controlCapture(capability, request, { now, resumeAt = null, waitForLock = false, deadline = null } = {}) {
  keys(request, ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'operation']);
  const { operationId, operation, expectedSelectionHash } = request;
  nativeId(operationId); oldHash(expectedSelectionHash); choice(operation, ['start', 'resume', 'pause', 'exclude']);
  // The project path is resolved within the step, and its time.
  return bounded(now, async () => {
    const selection = await selected(request.selection);
    if (['pause', 'exclude'].includes(operation) && selection.unitId === null) fail('NATIVE_BOUNDARY_REQUIRED');
    const restrictive = ['pause', 'exclude'].includes(operation), authority = restrictive ? 'maintenance' : 'collect';
    await assertWorkflowStorage(capability, selection, authority);
    const store = await openWorkflowIntake(capability, selection, authority);
    return intakeLock(waitForLock)(store, async tx => {
      const current = await readSelection(store, identityOf(selection));
      await assertWorkflowStorage(capability, selection, authority);
      const grantHash = restrictive ? undefined : await workflowCollectionGrant(capability, selection);
      if (!restrictive && current.state?.lastRequest?.id === operationId && current.state.currentGrantHash !== grantHash) fail('COLLECTION_GRANT_REQUIRES_REVIEW');
      const replay = await replayControl(current, request, store); if (replay) return replay;
      if (current.hash !== expectedSelectionHash) fail('STALE_SELECTION');
      const continuation = await chatContinuation(store, selection, request.sourcePath, request.expectedSourceIdentity);
      const observed = await sourceBoundary(selection, request.sourcePath, request.expectedSourceIdentity,
        restrictive ? selection.unitId : null, continuation);
      // A typed resume starts the new interval at its own command turn, so
      // that turn, not the next one, is the boundary left out. The record that
      // starts the turn must still be the one read there.
      let boundary = observed.boundary;
      if (resumeAt !== null) {
        if (operation !== 'resume' || resumeAt.eofByte > boundary.eofByte || resumeAt.record?.startByte !== resumeAt.eofByte ||
            !await holds(observed.source, resumeAt.record.endByte, resumeAt.record)) fail('SOURCE_CHANGED');
        boundary = { ...boundary, eofByte: resumeAt.eofByte, startsMidRecord: false, unitId: resumeAt.unitId };
      }
      const authorize = async () => { await assertWorkflowStorage(capability, selection, authority); return true; };
      const result = await controlSelection(tx, { source: observed.source, boundary, expectedHash: current.hash, authorize, grantHash,
        callerRequestHash: digest(canonicalJSON(request)),
        request: { id: operationId, client: selection.client, sessionId: selection.sessionId, unitId: boundary.unitId,
          expectedRevision: current.state?.revision ?? 0, operation } });
      // A resume starts a new stretch, which no stop kept for an earlier one
      // applies to. Cleared under the lock the worker records stops under, so
      // it never erases a newer one. Display only.
      if (operation === 'resume') { try { await clearReaderBlock(store, identityOf(selection)); } catch { /* the next visit */ } }
      return result;
    });
  }, deadline);
}

/** Reducing selection does not depend on a grant to read/copy private evidence.
 * Structural path checks and the existing intake lock still apply. */
export async function restrictCapture({ configPath, expectedConfigHash, collectionId }, request) {
  keys(request, ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'operation']);
  choice(request.operation, ['pause', 'exclude']); nativeId(request.operationId);
  hash(expectedConfigHash); hash(request.expectedSourceIdentity); oldHash(request.expectedSelectionHash);
  const selection = await selected(request.selection); nativeId(selection.unitId);
  const snapshot = await readWorkflowSnapshot(configPath);
  if (snapshot.hash !== expectedConfigHash) fail('WORKFLOW_POLICY_CHANGED');
  const placement = await validateWorkflowPlacement(snapshot.config, { configPath });
  const collection = placement.collections.find(item => item.id === collectionId);
  if (!collection) fail('WORKFLOW_NOT_AUTHORIZED');
  const store = await inspectIntakeStore(collection);
  return withIntakeLock(store, async tx => {
    const current = await readSelection(store, identityOf(selection));
    if (current.state) {
      if (current.state.source.projectRoot !== selection.cwd) fail('WORKFLOW_NOT_AUTHORIZED');
    } else {
      const route = await resolveWorkflowRoute(snapshot.config, selection);
      if (route.collection?.id !== collectionId) fail('WORKFLOW_NOT_AUTHORIZED');
      if (await canonicalWorkflowProject(request.selection.cwd, { allowMissing: false }) !== selection.cwd) fail('SOURCE_IDENTITY_MISMATCH');
    }
    if ((await readWorkflowSnapshot(configPath)).hash !== expectedConfigHash) fail('WORKFLOW_POLICY_CHANGED');
    const replay = await replayControl(current, request, store); if (replay) return replay;
    if (current.hash !== request.expectedSelectionHash) fail('STALE_SELECTION');
    const metadata = await snapshotSourceMetadata(request.sourcePath);
    if (!metadata || metadata.fileIdentity !== request.expectedSourceIdentity) fail('SOURCE_CHANGED');
    const source = { client: selection.client, sessionId: selection.sessionId, path: metadata.path,
      projectRoot: selection.cwd, fileIdentity: metadata.fileIdentity };
    if (current.state && canonicalJSON(current.state.source) !== canonicalJSON(source)) fail('SOURCE_IDENTITY_MISMATCH');
    if ((await readWorkflowSnapshot(configPath)).hash !== expectedConfigHash) fail('WORKFLOW_POLICY_CHANGED');
    // EOF and identity use metadata only. Treat a possibly partial last line
    // conservatively; restrictive controls never select additional bytes.
    return controlSelection(tx, { source, expectedHash: current.hash, callerRequestHash: digest(canonicalJSON(request)),
      boundary: { sourceIdentity: metadata.fileIdentity, eofByte: metadata.eofByte, startsMidRecord: true, unitId: selection.unitId, record: null },
      request: { id: request.operationId, client: selection.client, sessionId: selection.sessionId, unitId: selection.unitId,
        expectedRevision: current.state?.revision ?? 0, operation: request.operation } });
  });
}

async function explicitRequest(request) {
  keys(request, ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'kind', 'unitIds', 'readRange'], ['bounds']);
  if (request.bounds !== undefined) {
    keys(request.bounds, ['start', 'end', 'content'], ['leftOut', 'passed']); hash(request.bounds.start); hash(request.bounds.end); hash(request.bounds.content);
    if (request.bounds.leftOut !== undefined) { list(request.bounds.leftOut, 2048, { empty: false }).forEach(nativeId); unique(request.bounds.leftOut); }
    if (request.bounds.passed !== undefined) {
      keys(request.bounds.passed, ['from', 'hash']); integer(request.bounds.passed.from); hash(request.bounds.passed.hash);
      if (request.bounds.passed.from >= request.readRange.fromByte) fail('INVALID_WORKFLOW');
    }
  }
  const selection = await selected(request.selection);
  nativeId(request.operationId); oldHash(request.expectedSelectionHash); choice(request.kind, ['current', 'historical']);
  list(request.unitIds, 100, { empty: false }).forEach(nativeId); unique(request.unitIds);
  if (request.kind === 'current' && (request.unitIds.length !== 1 || selection.unitId !== request.unitIds[0])) fail('SELECTION_IDENTITY_MISMATCH');
  keys(request.readRange, ['fromByte', 'endByte']); integer(request.readRange.fromByte); integer(request.readRange.endByte);
  if (request.readRange.endByte <= request.readRange.fromByte || request.readRange.endByte - request.readRange.fromByte > 8 * 1024 * 1024) fail('EXPLICIT_RANGE_LIMIT');
  return selection;
}
async function deriveExplicitScope(capability, request, selection, observeRead) {
  await assertWorkflowStorage(capability, selection, 'explicitCollect');
  const continuation = await chatContinuation(await openWorkflowIntake(capability), selection, request.sourcePath, request.expectedSourceIdentity, observeRead);
  const observed = await sourceBoundary(selection, request.sourcePath, request.expectedSourceIdentity, null, continuation);
  if (request.readRange.endByte > observed.boundary.eofByte) fail('SOURCE_RANGE_UNAVAILABLE');
  // This window is explicit read authorization, never a serialized native proof.
  // Both native IDs and record anchors come from the same production readers.
  const state = newSelectionState(observed.source), scopeId = randomUUID();
  state.active = true; state.intervals = [{ id: scopeId, lower: { ...observed.boundary,
    eofByte: request.readRange.fromByte, startsMidRecord: false, unitId: null }, upper: null }];
  // The window is hashed before and after the reader reads it: the scope's
  // hash then describes the same bytes its turns and anchors were read from.
  const read = await stretchHash(observed.source, request.readRange.fromByte, request.readRange.endByte);
  const inspected = await reader(selection.client)({ state, scopeId, endByte: request.readRange.endByte, observeRead, continuation });
  if (inspected.blocked || inspected.diagnostics.limited || inspected.diagnostics.pendingTail) fail(inspected.blocked?.code ?? 'INCOMPLETE_EXPLICIT_RANGE');
  const anchors = request.unitIds.map(unitId => inspected.nativeAnchors.find(item => item.unitId === unitId));
  if (anchors.some(item => !item)) fail('NATIVE_BOUNDARY_UNAVAILABLE');
  anchors.sort((a, b) => a.record.startByte - b.record.startByte);
  const end = inspected.recordAnchors.at(-1);
  if (!end || end.endByte !== request.readRange.endByte || end.endByte - end.startByte > 64 * 1024) fail('SOURCE_ANCHOR_LIMIT');
  // The hash of every byte the scope covers: a later capture moves past it
  // only while the transcript still holds exactly these bytes. A typed window
  // also keeps the hash from where its capture began reading, past turns it
  // did not take, so a later capture never moves past those unchecked.
  const passed = request.bounds?.passed;
  const hashes = await rangeHashes(observed.source, [{ from: request.readRange.fromByte, to: request.readRange.endByte },
    { from: anchors[0].record.startByte, to: end.endByte }, ...(passed ? [{ from: passed.from, to: end.endByte }] : [])]);
  if (!hashes || hashes[0] !== read) fail('SOURCE_CHANGED');
  const turns = inspected.nativeAnchors.filter(item => item.record.startByte >= anchors[0].record.startByte && item.record.startByte < end.endByte);
  return { source: observed.source, turns, scope: { unitIds: request.unitIds, start: anchors[0].record, end, contentHash: hashes[1],
    ...(passed ? { passed: { from: passed.from, hash: hashes[2] } } : {}) } };
}

/** Preview reads only the explicitly authorized byte window of the named source. */
export async function previewExplicitCapture(capability, request, { observeRead = () => {}, now } = {}) {
  const selection = await explicitRequest(request);
  return bounded(now, async () => {
    const store = await openWorkflowIntake(capability), current = await readSelection(store, identityOf(selection));
    if (current.hash !== request.expectedSelectionHash) fail('STALE_SELECTION');
    const { source, scope } = await deriveExplicitScope(capability, request, selection, observeRead);
    return { status: 'selection-verified', sourcePath: source.path, sourceIdentity: source.fileIdentity,
      unitIds: scope.unitIds, readRange: request.readRange, selectionHash: current.hash,
      coverage: selection.client === 'claude' ? 'Proven human input only; finality unconfirmed.' : 'Native terminal required before publication.' };
  });
}

/** Persist one bounded selection without enabling ongoing collection. Run it
 * separately so a worker budget failure leaves a reviewable, retryable scope. */
export async function selectExplicitCapture(capability, request, { observeRead = () => {}, now, waitForLock = false } = {}) {
  const selection = await explicitRequest(request);
  return bounded(now, async () => {
    const store = await openExplicitCaptureIntake(capability, selection, { scopeId: request.operationId, unitIds: request.unitIds });
    return intakeLock(waitForLock)(store, async tx => {
      const current = await readSelection(store, identityOf(selection));
      await assertWorkflowStorage(capability, selection, 'explicitCollect');
      const replay = await replayControl(current, request, store); if (replay) return replay;
      if (current.hash !== request.expectedSelectionHash) fail('STALE_SELECTION');
      const { source, scope, turns } = await deriveExplicitScope(capability, request, selection, observeRead);
      // A window chosen from an earlier read names the hashes of its first and
      // last records and of all its bytes; this read must find the same bytes,
      // or the scope would be published under an identity that describes others.
      if (request.bounds && (scope.start.hash !== request.bounds.start || scope.end.hash !== request.bounds.end ||
          scope.contentHash !== request.bounds.content || scope.passed?.hash !== request.bounds.passed?.hash)) fail('SOURCE_ANCHOR_CONFLICT');
      // Every other turn in a chat window's bytes was left out or captured
      // when it was chosen, including a turn the window left out when the
      // selection had no room to record it; one that is neither came from
      // other bytes.
      if (request.bounds) {
        const withheld = withheldTurns(current.state), taken = await capturedUnits(store, selection), passed = new Set(request.bounds.leftOut ?? []);
        if (turns.some(item => !request.unitIds.includes(item.unitId) && !withheld(item) && !taken.has(item.unitId) && !passed.has(item.unitId))) fail('SOURCE_ANCHOR_CONFLICT');
      }
      const authorize = async () => { await assertWorkflowStorage(capability, selection, 'explicitCollect'); return true; };
      return controlSelection(tx, { source, expectedHash: current.hash, authorize, callerRequestHash: digest(canonicalJSON(request)),
        request: { id: request.operationId, client: selection.client, sessionId: selection.sessionId,
          ...(request.kind === 'current' ? { unitId: selection.unitId } : {}), operation: `capture-${request.kind}`,
          expectedRevision: current.state?.revision ?? 0, scope } });
    });
  });
}

/** A run names one inspected scope; explicit scopes never sweep future intervals. */
export async function runSelectedCapture(capability, request, { observeRead = () => {}, now, waitForLock = false } = {}) {
  keys(request, ['selection', 'scopeId', 'expectedSelectionHash'], ['unitIds']);
  const selection = await selected(request.selection); nativeId(request.scopeId); hash(request.expectedSelectionHash);
  if (request.unitIds !== undefined) { list(request.unitIds, 100, { empty: false }).forEach(nativeId); unique(request.unitIds); }
  return bounded(now, async () => {
    const operation = request.unitIds ? 'explicitCollect' : 'collect';
    const authorize = async context => {
      if (context?.scopeId && context.scopeId !== request.scopeId) fail('CAPTURE_NOT_SELECTED');
      await assertWorkflowStorage(capability, selection, operation); return true;
    };
    await authorize();
    const store = request.unitIds ? await openExplicitCaptureIntake(capability, selection, { scopeId: request.scopeId, unitIds: request.unitIds })
      : await openWorkflowIntake(capability, selection, 'collect');
    return intakeLock(waitForLock)(store, async tx => {
      const current = await readSelection(store, identityOf(selection));
      if (!current.state || current.hash !== request.expectedSelectionHash) fail('STALE_SELECTION');
      if (current.state.source.projectRoot !== selection.cwd) fail('SOURCE_IDENTITY_MISMATCH');
      if (!request.unitIds && current.state.currentGrantHash !== await workflowCollectionGrant(capability, selection)) fail('COLLECTION_GRANT_REQUIRES_REVIEW');
      const scope = (request.unitIds ? current.state.explicitScopes : currentIntervals(current.state)).find(item => item.id === request.scopeId);
      if (!scope || (request.unitIds && canonicalJSON(scope.unitIds) !== canonicalJSON(request.unitIds))) fail('CAPTURE_NOT_SELECTED');
      // A window runs only on the bytes it was chosen from: its reader hashes
      // every byte it covers through the handle it reads them with.
      await recoverPendingPublication(tx, { authorize });
      const result = await processScope(tx, store, current, request.scopeId, authorize, observeRead);
      return { ...result, ...(await readSelection(store, identityOf(selection))) };
    });
  });
}

// Typed chat commands. A verified binding names the chat, its command turn and
// the point it may be read from; the model supplies no unit, range or source.
// A window's turns are published within one bounded operation, so it stays small.
const CHAT_WINDOW_BYTES = 8 * 1024 * 1024, CHAT_WINDOW_UNITS = 10, CHAT_ANCHOR_BYTES = 64 * 1024, CHAT_RUN_PASSES = 6;
// How far past an uncapturable turn a capture looks for the next one. One
// command ends within 50 s of when it started, inside a host's tool timeout:
// each step is one bounded operation of at most 10 s, started only while it
// can still finish in time, and the capture keeps one step for the command's
// own small bookkeeping writes after it (leaving its turn out and keeping its
// reply).
const CHAT_SCAN_WINDOWS = 8, CHAT_COMMAND_MS = 50_000, CHAT_STEP_MS = 10_000, CHAT_AFTER_STEPS = 1;
const timeFor = (deadline, steps) => performance.now() + steps * CHAT_STEP_MS <= deadline;
/** The deadline of a typed capture whose command started at `started`
 * (`performance.now()`), and of the whole command, whose own bookkeeping
 * writes after the capture share the time left until it. */
export const typedCaptureDeadline = started => started + CHAT_COMMAND_MS - CHAT_AFTER_STEPS * CHAT_STEP_MS;
export const typedCommandDeadline = started => started + CHAT_COMMAND_MS;
// Housekeeping exclusions stop well short of selection capacity: at capacity
// an exclusion becomes a safety stop that denies every turn of the chat, which
// only a real opt-out may cause.
const HOUSEKEEPING_EXCLUSIONS = 2048, HOUSEKEEPING_BYTES = MAX_SELECTION_BYTES / 2;
// Excluded turns, pause turns and the boundary turn each Automatic interval
// leaves out by design.
const deniedUnits = state => new Set(state ? [...state.exclusions,
  ...state.intervals.flatMap(item => [item.upper?.unitId, item.lower.unitId]).filter(Boolean)] : []);
// Which turns no capture takes: those `deniedUnits` names, and every turn that
// starts in an earlier pause a later resume closed, from the pause's end to
// where Automatic capture began again. Only the current pause stays open to a
// typed capture.
function withheldTurns(state) {
  const denied = deniedUnits(state), intervals = [...state?.intervals ?? []].sort((a, b) => a.lower.eofByte - b.lower.eofByte);
  const gaps = intervals.slice(0, -1).flatMap((item, index) => item.upper ? [[item.upper.eofByte, intervals[index + 1].lower.eofByte]] : []);
  return item => denied.has(item.unitId) || gaps.some(([from, to]) => item.record.startByte >= from && item.record.startByte < to);
}

/** Leave one turn of the chat out of captured turns: a typed command's own turn
 * or a turn too large to capture. An opt-out needs no capture consent and is
 * idempotent; it waits briefly for the intake lock, never refreshes a hash to
 * get past a conflict, and is skipped (`excluded: false`) when the selection
 * has no housekeeping room left. */
export async function excludeChatTurn(capability, { selection, source, unitId }, { now, signal, deadline = null } = {}) {
  nativeId(unitId); hash(source.fileIdentity);
  return bounded(now, async () => {
    const chat = await selected(selection);
    await assertWorkflowStorage(capability);
    const store = await openWorkflowIntake(capability);
    return withIntakeLockWaiting(store, tx => excludeTurn(tx, store, chat, source, unitId), { signal });
  }, deadline);
}
// Several turns a chat window left out, in one locked step that first checks,
// with `verify`, right before each is written, that the bytes they were judged
// by are unchanged: once they changed, no further turn is left out (`stale`),
// and `recorded` counts those already written.
async function excludeChatTurns(capability, { chat, source, unitIds, verify }, { now, signal }) {
  return bounded(now, async () => {
    await assertWorkflowStorage(capability);
    const store = await openWorkflowIntake(capability);
    return withIntakeLockWaiting(store, async tx => {
      const metadata = await sourceMetadata(source);
      let recorded = 0;
      for (const unitId of unitIds) {
        if ((await excludeTurn(tx, store, chat, source, unitId, metadata, verify)).stale) return { stale: true, recorded };
        recorded++;
      }
      return { stale: false, recorded };
    }, { signal });
  });
}
async function sourceMetadata(source) {
  const metadata = await snapshotSourceMetadata(source.path);
  if (!metadata || metadata.fileIdentity !== source.fileIdentity) fail('SOURCE_CHANGED');
  return metadata;
}
// `verify`, when given, runs last before the write: the transcript has no lock
// its writer takes, so this is as close to the write as a check can be.
async function excludeTurn(tx, store, chat, source, unitId, seen = null, verify = null) {
  const current = await readSelection(store, identityOf(chat));
  if (current.state?.safetyStop || deniedUnits(current.state).has(unitId)) return { ...current, excluded: true };
  if (current.state && (current.state.exclusions.length >= HOUSEKEEPING_EXCLUSIONS ||
      Buffer.byteLength(canonicalJSON(current.state)) >= HOUSEKEEPING_BYTES)) return { ...current, excluded: false };
  const metadata = seen ?? await sourceMetadata(source);
  if (verify && !await verify()) return { stale: true };
  const observed = { client: chat.client, sessionId: chat.sessionId, path: metadata.path, projectRoot: chat.cwd, fileIdentity: metadata.fileIdentity };
  return { ...await controlSelection(tx, { source: observed, expectedHash: current.hash,
    boundary: { sourceIdentity: metadata.fileIdentity, eofByte: metadata.eofByte, startsMidRecord: true, unitId, record: null },
    request: { id: digestId('cuefluent-command-turn-v1', { client: chat.client, sessionId: chat.sessionId, unitId }),
      client: chat.client, sessionId: chat.sessionId, unitId, expectedRevision: current.state?.revision ?? 0, operation: 'exclude' } }), excluded: true };
}

// How far typed captures have read past turns they left out, for this exact
// transcript file: a turn too large for one command's scans is passed over
// several commands, never restarted. It only moves forward, and carries the
// hash of the bytes just before it: a transcript truncated or rewritten in
// place under the same file identity drops it, so the next capture reads
// again instead of trusting an offset into other contents.
const CHAT_CURSOR_ANCHOR_BYTES = 4096;
const SOURCE_CONFLICTS = ['SOURCE_CHANGED', 'SOURCE_ANCHOR_CONFLICT', 'SOURCE_IDENTITY_MISMATCH'];
const chatCursorPath = chat => `chat-capture/${chat.client}/${nativeId(chat.sessionId)}.json`;
// The position counts with the hash of the stretch it moved past (`from` up
// to it), and, where `stretch` asks, only while those bytes are unchanged.
async function readChatCursor(store, chat, source, { stretch = false } = {}) {
  const snapshot = await intakeSnapshot(store, 'state', chatCursorPath(chat), { maxBytes: 4096 }), value = intakeJSON(snapshot);
  if (value === null) return { snapshot, cursor: null };
  keys(value, ['format', 'version', 'sourceIdentity', 'offset', 'startsMidRecord', 'anchor', 'from', 'contentHash']); hash(value.sourceIdentity); integer(value.offset);
  integer(value.from); hash(value.contentHash);
  if (value.format !== 'cuefluent-chat-capture-cursor' || value.version !== 1 || typeof value.startsMidRecord !== 'boolean' || value.from > value.offset) fail('INVALID_INTAKE_METADATA');
  if (value.sourceIdentity !== source.fileIdentity) return { snapshot, cursor: null };
  try { await verifySourceCursor(source, { sourceIdentity: value.sourceIdentity, offset: value.offset, anchor: value.anchor }); }
  catch (error) {
    if (SOURCE_CONFLICTS.includes(error.code)) return { snapshot, cursor: null };
    throw error;
  }
  if (stretch && !await stretchHolds(source, value.from, value.offset, value.contentHash)) return { snapshot, cursor: null };
  return { snapshot, cursor: value };
}
// The hash of the transcript's bytes from `from` to `to`, read as they are
// now. Capture moves past a stretch only while its bytes still hash as they
// did when it was first passed; end anchors alone vouch for nothing between.
const STRETCH_READ_BYTES = 1024 * 1024;
async function stretchHash(source, from, to) {
  const hashes = await rangeHashes(source, [{ from, to }]);
  if (!hashes) fail('SOURCE_CHANGED');
  return hashes[0];
}
async function stretchHolds(source, from, to, expected) {
  try { return await stretchHash(source, from, to) === expected; }
  catch (error) { if (SOURCE_CONFLICTS.includes(error.code)) return false; throw error; }
}
// The hash of the stretch a capture passed (`from` to `eofByte`), from one
// read that also finds its endpoint anchor and every byte its scans consumed
// as they read them; null when any of those changed since.
async function scannedStretch(source, { from, eofByte, anchor, reads }) {
  const hashes = await rangeHashes(source, [{ from, to: eofByte }, { from: anchor.startByte, to: anchor.endByte }, ...reads]);
  if (!hashes) return null;
  const [stretch, ends, ...consumed] = hashes;
  return ends === anchor.hash && consumed.every((value, index) => value === reads[index].hash) ? stretch : null;
}
// Whether every byte a chat window's scans consumed still hashes as they read it.
async function readsHold(source, reads) {
  const hashes = await rangeHashes(source, reads);
  return Boolean(hashes) && hashes.every((value, index) => value === reads[index].hash);
}
// The hashes of several `from`..`to` ranges of the transcript, from one
// guarded read; null when the file is no longer the same or that long, or
// was written in place while it was read. A file that only grew meanwhile is
// read a second time, since an append can hide a rewrite from its times, and
// that read counts only if the file did not change at all during it.
async function rangeHashes(source, ranges) {
  if (!ranges.length) return [];
  const start = Math.min(...ranges.map(range => range.from)), end = Math.max(...ranges.map(range => range.to));
  const { handle, stat } = await openGuarded(source.path, { singleLink: true });
  try {
    if (stableSourceIdentity(stat) !== source.fileIdentity || stat.size < BigInt(end)) return null;
    const buffer = Buffer.alloc(Math.max(1, Math.min(STRETCH_READ_BYTES, end - start)));
    const pass = async () => {
      const hashers = ranges.map(() => createHash('sha256'));
      for (let offset = start; offset < end;) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
        if (!bytesRead) return null;
        ranges.forEach((range, index) => {
          const low = Math.max(range.from, offset), high = Math.min(range.to, offset + bytesRead);
          if (low < high) hashers[index].update(buffer.subarray(low - offset, high - offset));
        });
        offset += bytesRead;
      }
      return hashers.map(hasher => hasher.digest('hex'));
    };
    const first = await pass();
    const after = await handle.stat({ bigint: true });
    if (!first || !sameFileIdentity(stat, after) || after.size < stat.size || after.nlink !== 1n ||
        (after.size === stat.size && (after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs))) return null;
    if (after.size === stat.size) return first;
    const second = await pass(), final = await handle.stat({ bigint: true });
    if (!second || !sameFileIdentity(after, final) || final.size !== after.size || final.nlink !== 1n ||
        final.mtimeNs !== after.mtimeNs || final.ctimeNs !== after.ctimeNs) return null;
    return second.every((value, index) => value === first[index]) ? first : null;
  } finally { await handle.close(); }
}
// The hash of up to 4 KiB of transcript bytes ending at `offset`, read from
// the verified file.
async function chatCursorAnchor(source, offset) {
  const { handle, stat } = await openGuarded(source.path, { singleLink: true });
  try {
    if (stableSourceIdentity(stat) !== source.fileIdentity || stat.size < BigInt(offset)) fail('SOURCE_CHANGED');
    const startByte = Math.max(0, offset - CHAT_CURSOR_ANCHOR_BYTES), bytes = Buffer.alloc(offset - startByte);
    for (let read = 0; read < bytes.length;) {
      const result = await handle.read(bytes, read, bytes.length - read, startByte + read);
      if (!result.bytesRead) fail('SOURCE_CHANGED'); read += result.bytesRead;
    }
    return { startByte, endByte: offset, hash: digest(bytes) };
  } finally { await handle.close(); }
}
// Whether the transcript still reaches `offset` and holds a stored record (if
// any): the same bytes at the same place. One truncated or rewritten in place
// under the same file identity may not, and progress stored there no longer
// counts.
async function holds(source, offset, record = null) {
  if (record && record.endByte - record.startByte > CHAT_ANCHOR_BYTES) return false;
  const at = (end, anchor) => verifySourceCursor(source, { sourceIdentity: source.fileIdentity, offset: end, anchor });
  try {
    if (record) await at(record.endByte, { startByte: record.startByte, endByte: record.endByte, hash: record.hash });
    if (!record || offset !== record.endByte) await at(offset, null);
    return true;
  } catch (error) { if (SOURCE_CONFLICTS.includes(error.code)) return false; throw error; }
}
// The record an explicit capture ends with.
const scopeEnd = scope => scope.end ?? scope.start;
// An earlier capture counts while the transcript still holds its last record
// and, where its selection kept one, the hash of every byte it covers.
async function scopeHolds(source, scope) {
  const end = scopeEnd(scope);
  if (!await holds(source, end.endByte, end)) return false;
  if (scope.passed && !await stretchHolds(source, scope.passed.from, end.endByte, scope.passed.hash)) return false;
  return scope.contentHash === undefined || stretchHolds(source, scope.start.startByte, end.endByte, scope.contentHash);
}
// The bytes a later capture passes when it starts at this scope's end, with
// their hash: from where its capture began reading, when it kept that.
const passedBy = scope => scope.passed ? { from: scope.passed.from, to: scopeEnd(scope).endByte, hash: scope.passed.hash } : chosenStretch(scope);
// After a record too large to anchor whole, the anchor is the hash of its last
// bytes, read again and accepted only while the whole record still hashes as
// the scan read it: still bound to that read.
async function recordTailAnchor(source, record) {
  const { handle, stat } = await openGuarded(source.path, { singleLink: true });
  try {
    if (stableSourceIdentity(stat) !== source.fileIdentity || stat.size < BigInt(record.endByte)) return null;
    const bytes = Buffer.alloc(record.endByte - record.startByte);
    for (let read = 0; read < bytes.length;) {
      const result = await handle.read(bytes, read, bytes.length - read, record.startByte + read);
      if (!result.bytesRead) return null; read += result.bytesRead;
    }
    if (digest(bytes) !== record.hash) return null;
    const tail = bytes.subarray(-CHAT_CURSOR_ANCHOR_BYTES);
    return { startByte: record.endByte - tail.length, endByte: record.endByte, hash: digest(tail) };
  } finally { await handle.close(); }
}
// The reply a typed capture command gave, kept once for its exact native call,
// as dispatch receipts are. The call is reserved under the intake lock before
// it acts, so only one delivery acts, even in another server process: any
// other delivery answers with the kept reply, or, while the call has none, is
// refused without acting. A later delivery never replaces the reply. The bound
// is a dispatch receipt's, above any reply the transport can deliver; a reply
// that cannot be kept fails the command.
const CHAT_REPLY_BYTES = 32 * 1024, CHAT_REPLY_FORMAT = 'cuefluent-chat-command-reply';
const chatReplyPath = (chat, call) => `chat-capture/${chat.client}/${nativeId(chat.sessionId)}/replies/${digest(canonicalJSON(call)).slice(0, 24)}.json`;
const replyCall = call => { keys(call, ['unitId', 'callId', 'tool', 'argsHash']); nativeId(call.unitId);
  for (const field of ['callId', 'tool']) if (typeof call[field] !== 'string' || !call[field] || call[field].length > 256) fail('INVALID_INTAKE_METADATA');
  hash(call.argsHash); return call; };
// The call's kept reply, null while it is only reserved, or undefined.
function keptReply(snapshot, call) {
  const value = intakeJSON(snapshot);
  if (value === null) return undefined;
  keys(value, ['format', 'version', 'call', 'response']); replyCall(value.call);
  if (value.format !== CHAT_REPLY_FORMAT || value.version !== 1 || canonicalJSON(value.call) !== canonicalJSON(call) ||
      (value.response !== null && (typeof value.response !== 'object' || Array.isArray(value.response)))) fail('INVALID_INTAKE_METADATA');
  return value.response;
}
/** Reserves a typed capture command's call before it acts: `acting` only for
 * the delivery that reserved it; any other gets the kept reply, or null. */
export async function reserveChatCommand(capability, selection, call, { now, signal, deadline = null } = {}) {
  replyCall(call);
  // The project path is resolved within the step and the command's time, so
  // the reservation is never written after it.
  return bounded(now, async () => {
    const name = chatReplyPath(await selected(selection), replyCall(call));
    const store = await openWorkflowIntake(capability);
    return withIntakeLockWaiting(store, async tx => {
      const kept = keptReply(await intakeSnapshot(store, 'state', name, { maxBytes: CHAT_REPLY_BYTES }), call);
      if (kept !== undefined) return { acting: false, reply: kept };
      await replaceIntakeJSON(tx, name, { format: CHAT_REPLY_FORMAT, version: 1, call, response: null }, null);
      return { acting: true };
    }, { signal });
  }, deadline);
}
/** Keeps the reply of the delivery that reserved the call. */
export async function recordChatCommandReply(capability, selection, call, response, { now, signal, deadline = null } = {}) {
  const value = { format: CHAT_REPLY_FORMAT, version: 1, call: replyCall(call), response };
  if (Buffer.byteLength(canonicalJSON(value) + '\n') > CHAT_REPLY_BYTES) fail('INTAKE_METADATA_CAPACITY_EXCEEDED');
  return bounded(now, async () => {
    const name = chatReplyPath(await selected(selection), call);
    const store = await openWorkflowIntake(capability);
    return withIntakeLockWaiting(store, async tx => {
      const snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: CHAT_REPLY_BYTES });
      if (keptReply(snapshot, call) !== null) fail('INVALID_INTAKE_METADATA');
      await replaceIntakeJSON(tx, name, value, snapshot.hash);
    }, { signal });
  }, deadline);
}

// The position is stored with the anchor the read that reached it took, and
// only while the transcript still holds that anchor: bytes rewritten since that
// read never vouch for it.
async function advanceChatCursor(capability, chat, source, position, { now, signal }) {
  if (position.eofByte <= 0 || !position.anchor) return;
  return bounded(now, async () => {
    const contentHash = await scannedStretch(source, position);
    if (!contentHash) return;
    const store = await openWorkflowIntake(capability);
    return withIntakeLockWaiting(store, async tx => {
      // A stored position whose stretch no longer holds is replaced, so a
      // capture that reads that stretch again can store where it got to.
      const { snapshot, cursor } = await readChatCursor(store, chat, source, { stretch: true });
      if (cursor && cursor.offset >= position.eofByte) return;
      await replaceIntakeJSON(tx, chatCursorPath(chat), { format: 'cuefluent-chat-capture-cursor', version: 1, sourceIdentity: source.fileIdentity,
        offset: position.eofByte, startsMidRecord: position.startsMidRecord,
        anchor: { startByte: position.anchor.startByte, endByte: position.anchor.endByte, hash: position.anchor.hash },
        from: position.from, contentHash }, snapshot.hash);
    }, { signal });
  });
}

// Where the next window may start: past the chat's own start (`floor`), its
// last typed or explicit capture and how far captures read past turns they
// left out, each only while the transcript still holds every byte it passed.
// Stretches Automatic capture covered are not passed unread: a window reads
// them and skips the turns Automatic capture took, so no turn is captured
// twice and a turn written into them later is never skipped as covered.
async function chatStart(store, chat, state, floor, source) {
  // `stretch` names the bytes the start passes and their hash, which the read
  // from it checks again through its own handle.
  let start = { eofByte: floor.eofByte, startsMidRecord: floor.startsMidRecord }, stretch = null;
  const later = (eofByte, startsMidRecord, passed) => { if (eofByte > start.eofByte) { start = { eofByte, startsMidRecord }; stretch = passed; } };
  // Latest first: the first capture that still holds is the one that counts.
  const scopes = [...(state?.explicitScopes ?? [])].sort((a, b) => scopeEnd(b).endByte - scopeEnd(a).endByte);
  for (const scope of scopes) {
    if (scopeEnd(scope).endByte <= start.eofByte) break;
    if (await scopeHolds(source, scope)) { later(scopeEnd(scope).endByte, false, passedBy(scope)); break; }
  }
  // The position past turns a capture left out counts where it is later
  // still, and only while the stretch it passed is unchanged.
  const { cursor } = await readChatCursor(store, chat, source);
  if (cursor && cursor.offset > start.eofByte && (await readChatCursor(store, chat, source, { stretch: true })).cursor) {
    later(cursor.offset, cursor.startsMidRecord, { from: cursor.from, to: cursor.offset, hash: cursor.contentHash });
  }
  return { start, stretch };
}

// The turns of this chat with a capture, or one since pruned: one guarded
// listing of their folders, not a read per turn. Only a plain `<turn>.json`
// entry counts; anything else leaves its turn capturable.
const CAPTURED_UNITS_LIMIT = 100_000;
async function capturedUnits(store, chat) {
  const units = new Set();
  for (const folder of [`heads/${chat.client}/${nativeId(chat.sessionId)}`, `pruned/${chat.client}/${nativeId(chat.sessionId)}`]) {
    const dir = path.dirname(await intakePath(store, 'state', `${folder}/.inspect`)), stat = await lstatOrNull(dir);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) fail('UNSAFE_INTAKE_PATH');
    for await (const entry of await fs.opendir(dir)) {
      const unitId = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : null;
      if (entry.isFile() && isNativeId(unitId)) units.add(unitId);
      if (units.size > CAPTURED_UNITS_LIMIT) fail('INTAKE_METADATA_CAPACITY_EXCEEDED');
    }
  }
  return units;
}

// One bounded read of the source from `start`: its turns, in order, and its
// records. Reads only the explicitly authorized window of the verified source.
async function scanChat(chat, source, start, endByte, observeRead, continuation = null, stretch = null) {
  const state = newSelectionState(source), scopeId = randomUUID();
  state.active = true; state.intervals = [{ id: scopeId, upper: null,
    lower: { sourceIdentity: source.fileIdentity, eofByte: start.eofByte, startsMidRecord: start.startsMidRecord, unitId: null, record: null } }];
  const inspected = await reader(chat.client)({ state, scopeId, endByte, observeRead, continuation, ...(stretch ? { stretch } : {}) });
  // A read that reached its record limit ends where it stopped: the turns
  // before that point are complete, and the next read continues from it.
  const limited = inspected.blocked?.code === 'SESSION_READ_LIMIT';
  if (inspected.blocked && !limited) fail(inspected.blocked.code ?? 'INCOMPLETE_EXPLICIT_RANGE');
  const anchors = [...new Map(inspected.nativeAnchors.map(item => [item.unitId, item])).values()]
    .filter(item => item.record.startByte >= start.eofByte && (!limited || item.record.startByte < inspected.blocked.offset))
    .sort((a, b) => a.record.startByte - b.record.startByte);
  // The turns the reader holds because their own terminal record is too large to anchor.
  const tooLarge = new Set(inspected.pending.filter(item => item.reason === 'SOURCE_ANCHOR_LIMIT').map(item => item.unitId));
  // A turn's own last record, where the reader knows it (Codex owns records by
  // turn); otherwise a turn runs to the next turn's start.
  const unitEnds = new Map((inspected.unitEnds ?? []).map(item => [item.unitId, item.record]));
  // Whether a record runs past the read's end, so a read from there starts
  // inside it; a read that ends exactly between records does not.
  const straddles = !limited && inspected.diagnostics.pendingTail === true && !inspected.recordAnchors.some(record => record.endByte === endByte);
  return { anchors, records: inspected.recordAnchors, end: limited ? inspected.blocked.offset : endByte, tooLarge, unitEnds, straddles,
    consumed: inspected.diagnostics.consumed };
}

// The next window of the chat's finished turns: at most 10 turns or 8 MiB, up
// to the command turn, leaving out excluded turns. A turn that cannot be
// captured within those limits (larger than a window, or ending in a record too
// large to anchor) is reported in `leftOut` and passed, so it never blocks the
// chat's later turns.
async function chatWindow(capability, { chat, source, floor, commandUnitId, observeRead, scanWindows = CHAT_SCAN_WINDOWS }) {
  await assertWorkflowStorage(capability, chat, 'explicitCollect');
  const store = await openWorkflowIntake(capability), current = await readSelection(store, identityOf(chat));
  if (current.state?.safetyStop) fail('SELECTION_CAPACITY_EXCEEDED');
  if (current.state && current.state.source.fileIdentity !== source.fileIdentity) fail('SOURCE_CHANGED');
  const continuation = await chatContinuation(store, chat, source.path, source.fileIdentity, observeRead);
  const observed = await sourceBoundary(chat, source.path, source.fileIdentity, null, continuation), eof = observed.boundary.eofByte;
  const withheld = withheldTurns(current.state), leftOut = [], reads = [];
  let { start, stretch } = await chatStart(store, chat, current.state, floor, observed.source);
  const from = start.eofByte;
  // A turn already captured (by Automatic capture or an earlier capture,
  // including one since pruned) is skipped like an excluded turn. Whether a
  // turn was captured is read from its capture, never from where it lies.
  const taken = await capturedUnits(store, chat);
  const skipped = item => withheld(item) || taken.has(item.unitId);
  for (let scan = 0; scan < scanWindows; scan++) {
    const limit = Math.min(eof, start.eofByte + CHAT_WINDOW_BYTES);
    if (limit <= start.eofByte) return { current, unitIds: [], more: false, leftOut, reads };
    // Where a later read may resume, with an anchor taken from this read: the
    // bytes before its limit, hashed just before it reads them, or the record
    // it read that ends there (its last bytes, when it is too large whole).
    const limitAnchor = limit < eof ? await chatCursorAnchor(observed.source, limit) : null;
    // The first read also checks, through its own handle, the stretch its start
    // passes; one rewritten since it was checked is not passed, and the next
    // capture starts before it.
    let scanned;
    try { scanned = await scanChat(chat, observed.source, start, limit, observeRead, continuation, scan === 0 ? stretch : null); }
    catch (error) {
      if (scan === 0 && stretch && error.code === 'SOURCE_CHANGED' && !await stretchHolds(observed.source, stretch.from, stretch.to, stretch.hash)) {
        return { current, unitIds: [], more: true, leftOut, reads };
      }
      throw error;
    }
    reads.push(scanned.consumed);
    const { anchors, records, end, tooLarge, unitEnds, straddles } = scanned;
    const at = async (eofByte, startsMidRecord) => {
      const record = eofByte === limit ? null : records.find(item => item.endByte === eofByte);
      const anchor = eofByte === limit ? limitAnchor : !record ? null : record.endByte - record.startByte <= CHAT_ANCHOR_BYTES
        ? { startByte: record.startByte, endByte: record.endByte, hash: record.hash } : await recordTailAnchor(observed.source, record);
      return { eofByte, startsMidRecord, anchor };
    };
    // The command turn bounds the window. A window cut short by its size limit
    // ends before its last turn, which may continue past it.
    const command = anchors.find(item => item.unitId === commandUnitId);
    const before = anchors.filter(item => !command || item.record.startByte < command.record.startByte);
    const cut = !command && end < eof ? before.pop() : null;
    let stop = command?.record.startByte ?? cut?.record.startByte ?? end, more = Boolean(cut);
    // A Codex turn whose own last record is too large to anchor can never be
    // published (the reader holds it as SOURCE_ANCHOR_LIMIT): leave it out,
    // whether that record is the last before the next turn or the reader
    // finds it behind later metadata. The Claude reader anchors such a record
    // by its last bytes, so a Claude turn is only left out when no window can
    // hold it.
    const lastRecord = item => {
      if (unitEnds.has(item.unitId)) return unitEnds.get(item.unitId);
      const next = anchors.find(other => other.record.startByte > item.record.startByte)?.record.startByte ?? stop;
      return records.filter(record => record.endByte <= next).at(-1);
    };
    for (const item of before) {
      const last = lastRecord(item);
      if (item.unitId !== commandUnitId && !skipped(item) && !leftOut.includes(item.unitId) &&
          (tooLarge.has(item.unitId) || (chat.client === 'codex' && last && last.startByte >= item.record.startByte &&
            last.endByte - last.startByte > CHAT_ANCHOR_BYTES))) leftOut.push(item.unitId);
    }
    const units = before.filter(item => item.unitId !== commandUnitId && !skipped(item) && !leftOut.includes(item.unitId));
    if (!units.length) {
      if (!cut) {
        if (anchors.length || end >= eof) return { current, unitIds: [], more: false, leftOut, reads };
        // Still inside a turn larger than a window: read on from here.
        start = await at(end, end === limit && straddles); continue;
      }
      // A turn that fills this whole read is larger than a window: leave it
      // out and read on. Otherwise only excluded turns came first: start the
      // next read at the cut turn, which may fit.
      if (!before.length && cut.record.startByte === start.eofByte) {
        if (!skipped(cut)) leftOut.push(cut.unitId);
        start = await at(end, end === limit && straddles);
      }
      else start = await at(cut.record.startByte, false);
      continue;
    }
    if (units.length > CHAT_WINDOW_UNITS) { stop = units[CHAT_WINDOW_UNITS].record.startByte; units.length = CHAT_WINDOW_UNITS; more = true; }
    // The scope ends with a complete record that can anchor it, from the end of
    // its own turns up to its stop (the next chosen turn, or the command): the
    // latest such record. A larger record of a turn it passes (left out,
    // excluded or captured) never costs it its own turns. Drop trailing turns
    // until such a record exists; a first turn that has none is left out and
    // the window starts after it.
    const fits = (record, until) => record.endByte > units[0].record.startByte && record.endByte <= until && record.endByte - record.startByte <= CHAT_ANCHOR_BYTES;
    for (let count = units.length; count > 0; count--) {
      const until = count < units.length ? units[count].record.startByte : stop;
      const own = Math.max(...units.slice(0, count).map(item => lastRecord(item)?.endByte ?? Infinity));
      const closing = records.filter(record => record.endByte >= own && fits(record, until)).at(-1) ??
        [records.filter(record => record.endByte <= until).at(-1)].find(record => record && fits(record, until));
      if (closing) {
        // The window's bytes, and from where this capture began reading when
        // it passed turns before them, hashed while every byte the scans
        // consumed still hashes as read: a later capture moves past exactly
        // what was read here.
        const prefix = from < units[0].record.startByte;
        const hashes = await rangeHashes(observed.source, [{ from: units[0].record.startByte, to: closing.endByte },
          ...(prefix ? [{ from, to: closing.endByte }] : []), ...reads]);
        const consumed = hashes?.slice(prefix ? 2 : 1);
        if (!hashes || consumed.some((value, index) => value !== reads[index].hash)) return { current, unitIds: [], more: true, leftOut, reads };
        return { current, unitIds: units.slice(0, count).map(item => item.unitId),
          readRange: { fromByte: units[0].record.startByte, endByte: closing.endByte },
          bounds: { start: units[0].record.hash, end: closing.hash, content: hashes[0],
            ...(prefix ? { passed: { from, hash: hashes[1] } } : {}), ...(leftOut.length ? { leftOut: [...leftOut] } : {}) },
          more: more || count < units.length, leftOut, reads };
      }
    }
    // A Claude turn that ends in a record too large to close a window waits
    // for a later, smaller record, such as the command turn's own, to close
    // it: the next capture takes it.
    const last = lastRecord(units[0]);
    if (chat.client === 'claude' && last && last.endByte - last.startByte > CHAT_ANCHOR_BYTES) return { current, unitIds: [], more: true, leftOut, reads };
    leftOut.push(units[0].unitId);
    start = await at(units[1]?.record.startByte ?? stop, false);
  }
  // Out of reads inside left-out or excluded turns: the next capture resumes here.
  return { current, unitIds: [], more: true, leftOut, reads, resumeAt: { ...start, from, reads } };
}

// Bounded runs of a chat's capture scope, each publishing a few turns, while
// they make progress and the command's time lasts. Publication keeps every turn
// it finished; when runs, time or a budget run out, or a later run fails, the
// rest of the scope waits for the next capture. Finished runs count their own turns. Only after a run
// is cut short are the scope's stored captures read, to count what that run
// kept; a scope another capture started counts finished runs only. A privacy
// probe started near the deadline gets only the time left and fails as a probe:
// after progress that is the budget too, while a real probe failure makes no
// progress and is reported.
const RUN_BUDGET_CODES = new Set(['WORKER_TIME_BUDGET', 'WORKER_READ_BUDGET', 'PRIVACY_PROBE_FAILED']);
// Every reader block keeps a window waiting, except those that stop Automatic
// capture but that a typed capture passes: a turn too large to anchor, which it
// leaves out, and a turn whose earlier capture came from another reader or
// revision (or was final), or is invalid, missing or changed.
const WINDOW_HOLDS = new Set(READER_BLOCK_CODES.filter(code => !['SOURCE_ANCHOR_LIMIT', 'UNSUPPORTED_CLAUDE_READER',
  'UNSUPPORTED_CODEX_READER', 'CAPTURE_REVISION_CONFLICT', 'FINAL_CAPTURE_CONFLICT', 'CAPTURE_REVISION_SCOPE_CONFLICT', 'UNSUPPORTED_CAPTURE_SCHEMA',
  'INVALID_CAPTURE_READER', 'INVALID_CAPTURE_COVERAGE', 'INVALID_CAPTURE_RANGE', 'CAPTURE_HASH_MISMATCH', 'CAPTURE_HEAD_CONFLICT'].includes(code)));
async function storedTurns(capability, chat, unitIds, now) {
  return bounded(now, async () => {
    const store = await openWorkflowIntake(capability);
    let count = 0;
    for (const unitId of unitIds) if ((await readCaptureHead(store, { ...identityOf(chat), unitId }, { metadataOnly: true })).head) count++;
    return count;
  });
}
async function runChatScope(capability, chat, scope, { observeRead, now, fresh, signal, deadline }) {
  let saved = 0, failure = null, finished = false, held;
  // A pass reads the selection and runs the scope: two bounded operations.
  for (let pass = 0; pass < CHAT_RUN_PASSES && !finished && timeFor(deadline, 2); pass++) {
    signal?.throwIfAborted();
    let run;
    try {
      const current = await bounded(now, async () => readSelection(await openWorkflowIntake(capability), identityOf(chat)));
      // The run takes no signal: a cancellation during the read stops it here.
      signal?.throwIfAborted();
      run = await runSelectedCapture(capability, { selection: chat, scopeId: scope.id, expectedSelectionHash: current.hash, unitIds: scope.unitIds }, { observeRead, now, waitForLock: true });
    } catch (error) { failure = error; break; }
    saved += run.saved;
    // A turn held for want of its terminal record does not hold up the
    // chat's later turns, but a turn whose records break the transcript's
    // rules, or a reader block, keeps the window waiting, as it keeps
    // Automatic capture waiting: a later window never passes it. Only the
    // pass limit continues here. A run that ends on such a hold alone and
    // captures nothing is `held`: no later capture gets past it.
    const stalled = !run.incomplete && run.pending !== 'WORKER_PASS_LIMIT', holds = (run.holds ?? [run.pending]).filter(code => WINDOW_HOLDS.has(code));
    finished = run.drained === true || (stalled && !holds.length);
    if (!finished && !run.saved) { if (stalled) held = holds[0]; break; }
  }
  if (!failure) return { saved, finished, ...(held ? { held } : {}) };
  // A later run that fails, such as on a busy lock or a selection another
  // capture changed, keeps what earlier runs kept: the command reports those
  // turns and the next capture meets the failure again.
  if (!RUN_BUDGET_CODES.has(failure.code)) { if (saved) return { saved, finished: false }; throw failure; }
  if (fresh && timeFor(deadline, 1)) {
    try { saved = Math.max(saved, await storedTurns(capability, chat, scope.unitIds, now)); } catch { /* keep the finished runs' count */ }
  }
  if (failure.code === 'PRIVACY_PROBE_FAILED' && !saved) throw failure;
  return { saved, finished: false };
}
// Whether a capture scope needs no further run: the reader read it to its
// end, or every turn in it is left out, or, once its own run has made
// progress, every turn in it is captured or left out. A finished window is
// never read again by a later capture. Turns captured before it ran, from an
// earlier read of other bytes, never finish a scope that has not run.
async function scopeDrained(capability, chat, state, scope, now) {
  return bounded(now, async () => {
    const store = await openWorkflowIntake(capability);
    const { cursor } = await readReaderProgress(store, identityOf(chat), scope.id, state.source.fileIdentity, { metadataOnly: true });
    if (cursor?.offset === scopeEnd(scope).endByte) return true;
    const denied = deniedUnits(state);
    if (!cursor) return scope.unitIds.every(unitId => denied.has(unitId));
    for (const unitId of scope.unitIds) {
      if (!denied.has(unitId) && !(await readCaptureHead(store, { ...identityOf(chat), unitId }, { metadataOnly: true })).head) return false;
    }
    return true;
  });
}

/** `capture`: this chat's finished turns since its last capture, or since it
 * started, oldest first, as one explicit scope per window. The capture a new
 * window would start after (the latest-ending one the transcript still holds,
 * of either kind) runs first while unfinished; when it captures turns or stays
 * unfinished it is the command's one window, and a new one is read only after.
 * The command turn is never part of a window. A window that stays waiting on
 * a record the reader holds names it as `held`. The capture ends by
 * `deadline`, by default as for a command started now, and stops on
 * cancellation, keeping what it captured. */
export async function captureChatTurns(capability, { selection, source, floor, commandUnitId }, { observeRead = () => {}, now, signal, scanWindows,
  deadline = typedCaptureDeadline(performance.now()) } = {}) {
  nativeId(commandUnitId); hash(source.fileIdentity);
  keys(floor, ['eofByte', 'startsMidRecord']); integer(floor.eofByte);
  const options = { observeRead, now, signal, deadline };
  let turns = 0;
  signal?.throwIfAborted();
  // The project path is resolved in the first step, within the command's time.
  const { chat, previous } = await bounded(now, async () => {
    const chat = await selected(selection);
    return { chat, previous: await readSelection(await openWorkflowIntake(capability), identityOf(chat)) };
  }, deadline);
  // Each check of an earlier capture's end, and the drain check after it, is
  // a bounded operation within the command's time.
  let last = null;
  for (const scope of [...previous.state?.explicitScopes ?? []].sort((a, b) => scopeEnd(b).endByte - scopeEnd(a).endByte)) {
    signal?.throwIfAborted();
    if (!timeFor(deadline, 2)) return { turns, more: true, leftOut: 0 };
    if (await bounded(now, () => scopeHolds(source, scope))) { last = scope; break; }
  }
  signal?.throwIfAborted();
  if (last && !await scopeDrained(capability, chat, previous.state, last, now)) {
    // A window that captures turns now, or stays unfinished, is this
    // command's one window; a new one waits for the next command.
    const rerun = await runChatScope(capability, chat, last, { ...options, fresh: false });
    turns += rerun.saved;
    if (rerun.held) return { turns, more: false, leftOut: 0, held: rerun.held };
    if (!rerun.finished || turns) return { turns, more: true, leftOut: 0 };
  }
  // A command turn takes one window: another call of the same typed command,
  // whose turn is already left out, only finishes that window.
  if (deniedUnits(previous.state).has(commandUnitId)) return { turns, more: true, leftOut: 0 };
  signal?.throwIfAborted();
  // A window is read only when what it finds can still be recorded after it:
  // the turns it left out and how far it read, and the window itself. The
  // read is one bounded operation, so recording always has its turn, and a
  // slow read never leaves the next capture to read it again.
  if (!timeFor(deadline, 3)) return { turns, more: true, leftOut: 0 };
  const window = await bounded(now, () => chatWindow(capability, { chat, source, floor, commandUnitId, observeRead, scanWindows }));
  // A turn too large to capture is left out once, so later captures pass it.
  // Its exclusion is recorded before the scan position moves past it, so a
  // capture stopped first reads it again; a selection with no housekeeping
  // room left passes it unrecorded. Either way the reply counts it.
  // They are left out for good only while the bytes the scans judged them by
  // are unchanged, checked under the lock that records them: a turn
  // rewritten since may now be capturable.
  let leftOut = 0;
  if (window.leftOut.length) {
    if (!timeFor(deadline, 2)) return { turns, more: true, leftOut };
    const recorded = await excludeChatTurns(capability, { chat, source, unitIds: window.leftOut, verify: () => readsHold(source, window.reads) }, { now, signal });
    leftOut = recorded.recorded;
    if (recorded.stale) return { turns, more: true, leftOut };
  }
  if (window.resumeAt) await advanceChatCursor(capability, chat, source, window.resumeAt, { now, signal });
  if (!window.unitIds.length) return { turns, more: window.more, leftOut };
  signal?.throwIfAborted();
  // The window is selected now (after reading the selection again when turns
  // were left out) and runs while a run still fits; otherwise the next
  // capture runs it first.
  if (!timeFor(deadline, window.leftOut.length ? 2 : 1)) return { turns, more: true, leftOut };
  // The window's identity covers the hash of all its bytes, so a window
  // rewritten in place over the same turns and offsets, even only inside, is a
  // new window, never the earlier one replayed.
  const operationId = digestId('cuefluent-chat-capture-v1', { client: chat.client, sessionId: chat.sessionId,
    unitIds: window.unitIds, readRange: window.readRange, bounds: window.bounds });
  const fresh = window.leftOut.length ? await bounded(now, async () => readSelection(await openWorkflowIntake(capability), identityOf(chat))) : window.current;
  await selectExplicitCapture(capability, { selection: chat, sourcePath: source.path, expectedSourceIdentity: source.fileIdentity,
    expectedSelectionHash: fresh.hash, operationId, kind: 'historical', unitIds: window.unitIds, readRange: window.readRange, bounds: window.bounds }, { observeRead, now, waitForLock: true });
  const run = await runChatScope(capability, chat, { id: operationId, unitIds: window.unitIds }, { ...options, fresh: true });
  if (run.held) return { turns: turns + run.saved, more: false, leftOut, held: run.held };
  return { turns: turns + run.saved, more: window.more || !run.finished, leftOut };
}

/** `pause chat` and `resume chat`: the existing pause and resume controls at
 * the command turn, which each leaves out of captured turns. */
// Each step ends by `deadline`, when given: a typed command's, which leaves
// time for its own bookkeeping after.
export async function controlChatCapture(capability, { selection, source, unitId, operation }, { now, deadline = null } = {}) {
  choice(operation, ['pause', 'resume']);
  const { chat, current } = await bounded(now, async () => {
    const chat = await selected({ ...selection, unitId });
    return { chat, current: await readSelection(await openWorkflowIntake(capability), identityOf(chat)) };
  }, deadline);
  const resumeAt = operation === 'resume' ? { ...await bounded(now, () => commandStart(capability, chat, source, unitId), deadline), unitId } : null;
  return controlCapture(capability, { selection: chat, sourcePath: source.path, expectedSourceIdentity: source.fileIdentity,
    expectedSelectionHash: current.hash, operation,
    operationId: digestId('cuefluent-chat-capture-control-v1', { client: chat.client, sessionId: chat.sessionId, unitId, operation }) }, { now, resumeAt, waitForLock: true, deadline });
}
// Where the command turn starts, read from the end of the transcript, where
// the command was just typed, with the record that starts it as read there. A
// command turn not found there refuses.
const CHAT_COMMAND_BYTES = 2 * 1024 * 1024;
async function commandStart(capability, chat, source, unitId) {
  await assertWorkflowStorage(capability, chat, 'collect');
  const continuation = await chatContinuation(await openWorkflowIntake(capability), chat, source.path, source.fileIdentity);
  const observed = await sourceBoundary(chat, source.path, source.fileIdentity, null, continuation), eof = observed.boundary.eofByte;
  const from = Math.max(0, eof - CHAT_COMMAND_BYTES);
  const { anchors } = await scanChat(chat, observed.source, { eofByte: from, startsMidRecord: from > 0 }, eof, () => {}, continuation);
  const own = anchors.find(item => item.unitId === unitId);
  if (!own) fail('NATIVE_BOUNDARY_UNAVAILABLE');
  const { startByte, endByte, hash: recordHash } = own.record;
  return { eofByte: startByte, record: { startByte, endByte, hash: recordHash } };
}
