import { randomUUID } from 'node:crypto';
import { assertWorkflowStorage, workflowCollectionGrant } from './workflow-storage.mjs';
import { openWorkflowIntake, openExplicitCaptureIntake, inspectIntakeStore, withIntakeLock } from './intake-io.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { canonicalWorkflowProject, validateWorkflowPlacement } from './workflow-paths.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { readSelection, controlSelection, recoverPendingPublication, selectionPendingWarning, readReaderHeadroom } from './intake-store.mjs';
import { inspectSourceBoundary, newSelectionState, currentIntervals } from './capture-selection.mjs';
import { codexRegistrationHeader, readCodexSelection } from './codex-reader.mjs';
import { claudeRegistrationHeader, readClaudeSelection } from './claude-reader.mjs';
import { snapshotSourceMetadata } from './collection-ingress.mjs';
import { processScope } from './collection-worker.mjs';
import { normalizeWorkflowSelection as selected } from './workflow-selection.mjs';
import { withWorkflowBudget } from './workflow-budget.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { keys, nativeId, hash, integer, list, unique, choice, canonicalJSON, digest, fail, safeErrorCode } from './workflow-values.mjs';

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
