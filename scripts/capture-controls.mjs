import { randomUUID } from 'node:crypto';
import { assertWorkflowStorage, workflowCollectionGrant } from './workflow-storage.mjs';
import { openWorkflowIntake, openExplicitCaptureIntake, inspectIntakeStore, withIntakeLock } from './intake-io.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { canonicalWorkflowProject, validateWorkflowPlacement } from './workflow-paths.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { readSelection, controlSelection, recoverPendingPublication, selectionPendingWarning, readReaderHeadroom, readCaptureHead } from './intake-store.mjs';
import { inspectSourceBoundary, newSelectionState, currentIntervals } from './capture-selection.mjs';
import { codexRegistrationHeader, readCodexSelection } from './codex-reader.mjs';
import { claudeRegistrationHeader, readClaudeSelection } from './claude-reader.mjs';
import { snapshotSourceMetadata } from './collection-ingress.mjs';
import { processScope } from './collection-worker.mjs';
import { normalizeWorkflowSelection as selected } from './workflow-selection.mjs';
import { withWorkflowBudget } from './workflow-budget.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { keys, nativeId, hash, integer, list, unique, choice, canonicalJSON, digest, digestId, fail, safeErrorCode } from './workflow-values.mjs';

const identityOf = ({ client, sessionId }) => ({ client, sessionId });
const oldHash = value => { if (value !== null) hash(value); };
const bounded = (now, run) => withWorkflowBudget({ now }, () => withStorageProbes(run));
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
async function sourceBoundary(selection, sourcePath, expectedSourceIdentity, unitId) {
  hash(expectedSourceIdentity);
  const source = { client: selection.client, sessionId: selection.sessionId, projectRoot: selection.cwd, path: sourcePath };
  const observed = await inspectSourceBoundary(source, { currentUnitId: unitId,
    verifyHeader: selection.client === 'codex' ? codexRegistrationHeader(source) : claudeRegistrationHeader(source) });
  if (observed.status !== 'registered') fail('SOURCE_BOUNDARY_PENDING');
  if (observed.source.fileIdentity !== expectedSourceIdentity) fail('SOURCE_CHANGED');
  return observed;
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
export async function controlCapture(capability, request, { now } = {}) {
  keys(request, ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'operation']);
  const selection = await selected(request.selection), { operationId, operation, expectedSelectionHash } = request;
  nativeId(operationId); oldHash(expectedSelectionHash); choice(operation, ['start', 'resume', 'pause', 'exclude']);
  if (['pause', 'exclude'].includes(operation) && selection.unitId === null) fail('NATIVE_BOUNDARY_REQUIRED');
  return bounded(now, async () => {
    const restrictive = ['pause', 'exclude'].includes(operation), authority = restrictive ? 'maintenance' : 'collect';
    await assertWorkflowStorage(capability, selection, authority);
    const store = await openWorkflowIntake(capability, selection, authority);
    return withIntakeLock(store, async tx => {
      const current = await readSelection(store, identityOf(selection));
      await assertWorkflowStorage(capability, selection, authority);
      const grantHash = restrictive ? undefined : await workflowCollectionGrant(capability, selection);
      if (!restrictive && current.state?.lastRequest?.id === operationId && current.state.currentGrantHash !== grantHash) fail('COLLECTION_GRANT_REQUIRES_REVIEW');
      const replay = await replayControl(current, request, store); if (replay) return replay;
      if (current.hash !== expectedSelectionHash) fail('STALE_SELECTION');
      const observed = await sourceBoundary(selection, request.sourcePath, request.expectedSourceIdentity,
        restrictive ? selection.unitId : null);
      const authorize = async () => { await assertWorkflowStorage(capability, selection, authority); return true; };
      return controlSelection(tx, { source: observed.source, boundary: observed.boundary, expectedHash: current.hash, authorize, grantHash,
        callerRequestHash: digest(canonicalJSON(request)),
        request: { id: operationId, client: selection.client, sessionId: selection.sessionId, unitId: observed.boundary.unitId,
          expectedRevision: current.state?.revision ?? 0, operation } });
    });
  });
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
  keys(request, ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'kind', 'unitIds', 'readRange']);
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
  const observed = await sourceBoundary(selection, request.sourcePath, request.expectedSourceIdentity, null);
  if (request.readRange.endByte > observed.boundary.eofByte) fail('SOURCE_RANGE_UNAVAILABLE');
  // This window is explicit read authorization, never a serialized native proof.
  // Both native IDs and record anchors come from the same production readers.
  const state = newSelectionState(observed.source), scopeId = randomUUID();
  state.active = true; state.intervals = [{ id: scopeId, lower: { ...observed.boundary,
    eofByte: request.readRange.fromByte, startsMidRecord: false, unitId: null }, upper: null }];
  const inspected = await reader(selection.client)({ state, scopeId, endByte: request.readRange.endByte, observeRead });
  if (inspected.blocked || inspected.diagnostics.limited || inspected.diagnostics.pendingTail) fail(inspected.blocked?.code ?? 'INCOMPLETE_EXPLICIT_RANGE');
  const anchors = request.unitIds.map(unitId => inspected.nativeAnchors.find(item => item.unitId === unitId));
  if (anchors.some(item => !item)) fail('NATIVE_BOUNDARY_UNAVAILABLE');
  anchors.sort((a, b) => a.record.startByte - b.record.startByte);
  const end = inspected.recordAnchors.at(-1);
  if (!end || end.endByte !== request.readRange.endByte || end.endByte - end.startByte > 64 * 1024) fail('SOURCE_ANCHOR_LIMIT');
  return { source: observed.source, scope: { unitIds: request.unitIds, start: anchors[0].record, end } };
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
export async function selectExplicitCapture(capability, request, { observeRead = () => {}, now } = {}) {
  const selection = await explicitRequest(request);
  return bounded(now, async () => {
    const store = await openExplicitCaptureIntake(capability, selection, { scopeId: request.operationId, unitIds: request.unitIds });
    return withIntakeLock(store, async tx => {
      const current = await readSelection(store, identityOf(selection));
      await assertWorkflowStorage(capability, selection, 'explicitCollect');
      const replay = await replayControl(current, request, store); if (replay) return replay;
      if (current.hash !== request.expectedSelectionHash) fail('STALE_SELECTION');
      const { source, scope } = await deriveExplicitScope(capability, request, selection, observeRead);
      const authorize = async () => { await assertWorkflowStorage(capability, selection, 'explicitCollect'); return true; };
      return controlSelection(tx, { source, expectedHash: current.hash, authorize, callerRequestHash: digest(canonicalJSON(request)),
        request: { id: request.operationId, client: selection.client, sessionId: selection.sessionId,
          ...(request.kind === 'current' ? { unitId: selection.unitId } : {}), operation: `capture-${request.kind}`,
          expectedRevision: current.state?.revision ?? 0, scope } });
    });
  });
}

/** A run names one inspected scope; explicit scopes never sweep future intervals. */
export async function runSelectedCapture(capability, request, { observeRead = () => {}, now } = {}) {
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
    return withIntakeLock(store, async tx => {
      const current = await readSelection(store, identityOf(selection));
      if (!current.state || current.hash !== request.expectedSelectionHash) fail('STALE_SELECTION');
      if (current.state.source.projectRoot !== selection.cwd) fail('SOURCE_IDENTITY_MISMATCH');
      if (!request.unitIds && current.state.currentGrantHash !== await workflowCollectionGrant(capability, selection)) fail('COLLECTION_GRANT_REQUIRES_REVIEW');
      const scope = (request.unitIds ? current.state.explicitScopes : currentIntervals(current.state)).find(item => item.id === request.scopeId);
      if (!scope || (request.unitIds && canonicalJSON(scope.unitIds) !== canonicalJSON(request.unitIds))) fail('CAPTURE_NOT_SELECTED');
      await recoverPendingPublication(tx, { authorize });
      const result = await processScope(tx, store, current, request.scopeId, authorize, observeRead);
      return { ...result, ...(await readSelection(store, identityOf(selection))) };
    });
  });
}

// Typed chat commands. A verified binding names the chat, its command turn and
// the floor it may be read from; the model supplies no unit, range or source.
// A window's turns are published within one bounded operation, so it stays small.
const CHAT_WINDOW_BYTES = 8 * 1024 * 1024, CHAT_WINDOW_UNITS = 10, CHAT_ANCHOR_BYTES = 64 * 1024, CHAT_RUN_PASSES = 6;
const deniedUnits = state => new Set(state ? [...state.exclusions, ...state.intervals.map(item => item.upper?.unitId).filter(Boolean)] : []);
// Where the last typed or explicit capture of this chat ended, if any.
const capturedThrough = state => state?.explicitScopes.length
  ? Math.max(...state.explicitScopes.map(scope => (scope.end ?? scope.start).endByte)) : null;

/** Keep a typed command's own turn out of captured turns. An exclusion is an
 * opt-out: it needs no capture consent, applies to the latest state and is
 * idempotent, so it never refreshes a hash to get past a conflict. */
export async function excludeCommandTurn(capability, { selection, source, unitId }, { now } = {}) {
  const chat = await selected(selection); nativeId(unitId); hash(source.fileIdentity);
  return bounded(now, async () => {
    await assertWorkflowStorage(capability);
    const store = await openWorkflowIntake(capability);
    return withIntakeLock(store, async tx => {
      const current = await readSelection(store, identityOf(chat));
      if (current.state?.safetyStop || deniedUnits(current.state).has(unitId)) return current;
      const metadata = await snapshotSourceMetadata(source.path);
      if (!metadata || metadata.fileIdentity !== source.fileIdentity) fail('SOURCE_CHANGED');
      const observed = { client: chat.client, sessionId: chat.sessionId, path: metadata.path, projectRoot: chat.cwd, fileIdentity: metadata.fileIdentity };
      return controlSelection(tx, { source: observed, expectedHash: current.hash,
        boundary: { sourceIdentity: metadata.fileIdentity, eofByte: metadata.eofByte, startsMidRecord: true, unitId, record: null },
        request: { id: digestId('cuefluent-command-turn-v1', { client: chat.client, sessionId: chat.sessionId, unitId }),
          client: chat.client, sessionId: chat.sessionId, unitId, expectedRevision: current.state?.revision ?? 0, operation: 'exclude' } });
    });
  });
}

// The next window of a chat's finished turns: from where its last capture
// ended (or its floor), up to the command turn, at most 100 turns or 8 MiB,
// leaving out excluded turns. Reads only that window of the verified source.
async function chatWindow(capability, { chat, source, floor, commandUnitId, observeRead }) {
  await assertWorkflowStorage(capability, chat, 'explicitCollect');
  const store = await openWorkflowIntake(capability), current = await readSelection(store, identityOf(chat));
  if (current.state?.safetyStop) fail('SELECTION_CAPACITY_EXCEEDED');
  if (current.state && current.state.source.fileIdentity !== source.fileIdentity) fail('SOURCE_CHANGED');
  const through = capturedThrough(current.state), fromScope = through !== null && through >= floor.eofByte;
  const from = fromScope ? through : floor.eofByte;
  const observed = await sourceBoundary(chat, source.path, source.fileIdentity, null), eof = observed.boundary.eofByte;
  const limit = Math.min(eof, from + CHAT_WINDOW_BYTES);
  if (limit <= from) return { current, unitIds: [], more: false };
  const state = newSelectionState(observed.source), scopeId = randomUUID();
  state.active = true; state.intervals = [{ id: scopeId, upper: null,
    lower: { ...observed.boundary, eofByte: from, startsMidRecord: fromScope ? false : floor.startsMidRecord, unitId: null } }];
  const inspected = await reader(chat.client)({ state, scopeId, endByte: limit, observeRead });
  if (inspected.blocked) fail(inspected.blocked.code ?? 'INCOMPLETE_EXPLICIT_RANGE');
  const anchors = [...new Map(inspected.nativeAnchors.map(item => [item.unitId, item])).values()]
    .sort((a, b) => a.record.startByte - b.record.startByte);
  // The command turn bounds the window; a window cut short by its size limit
  // ends before its last turn, which may continue past it.
  const command = anchors.find(item => item.unitId === commandUnitId);
  let more = false, stop = command?.record.startByte;
  if (stop === undefined) {
    if (limit === eof || anchors.length < 2) fail('NATIVE_BOUNDARY_UNAVAILABLE');
    stop = anchors.at(-1).record.startByte; more = true;
  }
  const denied = deniedUnits(current.state);
  let units = anchors.filter(item => item.record.startByte >= from && item.record.startByte < stop &&
    item.unitId !== commandUnitId && !denied.has(item.unitId));
  if (units.length > CHAT_WINDOW_UNITS) { stop = units[CHAT_WINDOW_UNITS].record.startByte; units = units.slice(0, CHAT_WINDOW_UNITS); more = true; }
  if (!units.length) return { current, unitIds: [], more };
  // The scope ends with the last complete record before the stop.
  const end = inspected.recordAnchors.filter(record => record.endByte <= stop).at(-1);
  if (!end || end.endByte <= units[0].record.startByte || end.endByte - end.startByte > CHAT_ANCHOR_BYTES) fail('SOURCE_ANCHOR_LIMIT');
  return { current, unitIds: units.map(item => item.unitId), readRange: { fromByte: units[0].record.startByte, endByte: end.endByte }, more };
}

// Bounded runs of a chat's capture scope, each publishing a few turns, while
// they make progress. Publication keeps every turn it finished; when runs or a
// budget run out, the rest of the scope waits for the next capture. Finished
// runs count their own turns. Only after a run is cut short are the scope's
// stored captures read, to count what that run kept; a scope another capture
// started counts finished runs only. A privacy probe started near the deadline
// gets only the time left and fails as a probe: after progress that is the
// budget too, while a real probe failure makes no progress and is reported.
const RUN_BUDGET_CODES = new Set(['WORKER_TIME_BUDGET', 'WORKER_READ_BUDGET', 'PRIVACY_PROBE_FAILED']);
async function storedTurns(capability, chat, unitIds, now) {
  return bounded(now, async () => {
    const store = await openWorkflowIntake(capability);
    let count = 0;
    for (const unitId of unitIds) if ((await readCaptureHead(store, { ...identityOf(chat), unitId }, { metadataOnly: true })).head) count++;
    return count;
  });
}
async function runChatScope(capability, chat, scope, { observeRead, now, fresh }) {
  let saved = 0, failure = null, finished = false;
  for (let pass = 0; pass < CHAT_RUN_PASSES && !finished; pass++) {
    let run;
    try {
      const current = await bounded(now, async () => readSelection(await openWorkflowIntake(capability), identityOf(chat)));
      run = await runSelectedCapture(capability, { selection: chat, scopeId: scope.id, expectedSelectionHash: current.hash, unitIds: scope.unitIds }, { observeRead, now });
    } catch (error) { failure = error; break; }
    saved += run.saved;
    // A turn held for another reason (no terminal record yet) does not hold
    // up the chat's later turns; only the pass limit continues here.
    finished = run.drained === true || (!run.incomplete && run.pending !== 'WORKER_PASS_LIMIT');
    if (!finished && !run.saved) break;
  }
  if (!failure) return { saved, finished };
  if (!RUN_BUDGET_CODES.has(failure.code)) throw failure;
  if (fresh) {
    try { saved = Math.max(saved, await storedTurns(capability, chat, scope.unitIds, now)); } catch { /* keep the finished runs' count */ }
  }
  if (failure.code === 'PRIVACY_PROBE_FAILED' && !saved) throw failure;
  return { saved, finished: false };
}

/** `capture`: this chat's finished turns since its last capture, oldest first,
 * as one explicit scope per window. A window a previous capture could not
 * finish runs first; a new window is read only once it has. The command turn
 * is never part of a window. */
export async function captureChatTurns(capability, { selection, source, floor, commandUnitId }, { observeRead = () => {}, now } = {}) {
  const chat = await selected(selection); nativeId(commandUnitId); hash(source.fileIdentity);
  keys(floor, ['eofByte', 'startsMidRecord']); integer(floor.eofByte);
  let turns = 0;
  const previous = await bounded(now, async () => readSelection(await openWorkflowIntake(capability), identityOf(chat)));
  const last = previous.state?.explicitScopes.filter(scope => scope.kind === 'historical').at(-1);
  if (last) {
    const rerun = await runChatScope(capability, chat, last, { observeRead, now, fresh: false });
    turns += rerun.saved;
    if (!rerun.finished) return { turns, more: true };
  }
  const window = await bounded(now, () => chatWindow(capability, { chat, source, floor, commandUnitId, observeRead }));
  if (!window.unitIds.length) return { turns, more: window.more };
  const operationId = digestId('cuefluent-chat-capture-v1', { client: chat.client, sessionId: chat.sessionId,
    unitIds: window.unitIds, readRange: window.readRange });
  await selectExplicitCapture(capability, { selection: chat, sourcePath: source.path, expectedSourceIdentity: source.fileIdentity,
    expectedSelectionHash: window.current.hash, operationId, kind: 'historical', unitIds: window.unitIds, readRange: window.readRange }, { observeRead, now });
  const run = await runChatScope(capability, chat, { id: operationId, unitIds: window.unitIds }, { observeRead, now, fresh: true });
  return { turns: turns + run.saved, more: window.more || !run.finished };
}

/** `pause chat` and `resume chat`: the existing pause and resume controls at
 * the command turn, which each leaves out of captured turns. */
export async function controlChatCapture(capability, { selection, source, unitId, operation }, { now } = {}) {
  choice(operation, ['pause', 'resume']);
  const chat = await selected({ ...selection, unitId });
  const current = await bounded(now, async () => readSelection(await openWorkflowIntake(capability), identityOf(chat)));
  return controlCapture(capability, { selection: chat, sourcePath: source.path, expectedSourceIdentity: source.fileIdentity,
    expectedSelectionHash: current.hash, operation,
    operationId: digestId('cuefluent-chat-capture-control-v1', { client: chat.client, sessionId: chat.sessionId, unitId, operation }) }, { now });
}
