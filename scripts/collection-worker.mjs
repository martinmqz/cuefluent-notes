import path from 'node:path';
import { collectionJobs, readCollectionScheduler, reserveCollectionAttempt } from './collection-scheduler.mjs';
import { collectionGrantHash } from './collection-grant.mjs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isMain, lstatOrNull } from './file-io.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { verifyWorkflowStorage, assertWorkflowStorage } from './workflow-storage.mjs';
import { inspectIntakeStore, openWorkflowIntake, openExplicitCaptureIntake, intakePath, intakeSnapshot, intakeJSON, withIntakeLock, replaceIntakeJSON } from './intake-io.mjs';
import { readSelection, controlSelection, resolveStoredSelectionAnchor, readCaptureHead, publishCapture, commitReaderProgress, recoverPendingPublication, inspectPendingPublication, readReaderProgress } from './intake-store.mjs';
import { newSelectionState, inspectSourceBoundary, currentIntervals, stableSourceIdentity } from './capture-selection.mjs';
import { codexRegistrationHeader, readCodexSelection, codexPublicationPlan, codexProgressPlan, codexCheckpoint } from './codex-reader.mjs';
import { claudeRegistrationHeader, readClaudeSelection, claudePublicationPlan, isClaudeHumanRow, CLAUDE_READER_RULES_REVISION } from './claude-reader.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { createProcessingExecutionResolver } from './processing-execution-receipts.mjs';
import { hydrateReaderCheckpoint } from './reader-pages.mjs';
import { readTombstone } from './capture-retention.mjs';
import { readRegistration, publishIngressMetadata, wakePath, collectionStatusPath, registrationPath, drainedPath, suspendedPath, READER_SUSPENSION_VERSION, assertRegistrationGrant,
  registrationFloorPath, snapshotSourceMetadata } from './collection-ingress.mjs';
import { withWorkflowBudget, checkWorkflowBudget } from './workflow-budget.mjs';
import { CLIENTS, fail, nativeId, keys, hash, integer, choice, canonicalJSON, digest } from './workflow-values.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { canonicalWorkflowProject } from './workflow-paths.mjs';
import { createProcessingControlResolver } from './processing-control-receipts.mjs';
import { readContinuesLink, readContinuedLink, continuationTarget, continuationOrigin, linkClaudeContinuation, ensureContinuesPointer } from './claude-continuation.mjs';

// ACKs are disposable scheduling hints. They never replace fresh policy,
// immutable registration/source checks, native boundaries, or reader progress.
async function sourceVersion(file) {
  checkWorkflowBudget();
  try {
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || await fs.realpath(file) !== file) return null;
    const after = await fs.lstat(file, { bigint: true });
    const value = stat => ({ fileIdentity: stableSourceIdentity(stat), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
    if (after.nlink !== 1n || canonicalJSON(value(before)) !== canonicalJSON(value(after))) return null;
    return value(after);
  } catch { return null; } // A drained scope does not need its old native file.
}
const ackValue = (registrationHash, selectionHash, grantHash, wakeHash, version) =>
  ({ version: 1, registrationHash, selectionHash, grantHash, wakeHash, sourceVersion: version });
async function hasAcknowledgement(store, name, expected) {
  let snapshot;
  try { snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: 16384 }); }
  catch (error) { if (error.code === 'FILE_SIZE_LIMIT_EXCEEDED') return false; throw error; }
  try { return canonicalJSON(intakeJSON(snapshot)) === canonicalJSON(expected); }
  catch { return false; }
}

// A fresh Claude session can create its transcript only after its prompt hook
// ran, so neither the registration nor that prompt's wake holds a floor. The
// worker then waits, at most as long as control binding settles, for the file
// to appear, and takes the hook's own metadata-only snapshot itself. Claude
// can write bookkeeping rows before the first row that identifies the session,
// so a header that is not readable yet is retried within the same wait.
const PROMPT_SOURCE_WAIT_MS = 1000;
const promptWakeWithoutFloor = (registration, wake) => registration.client === 'claude' && registration.snapshot === null &&
  wake?.event === 'UserPromptSubmit' && (wake.snapshot ?? null) === null;
/** Wait for the transcript of a prompt wake without a floor; returns the end
 * of this bounded wait, or null when the session is not in that state. */
async function awaitPromptSource(store, registration) {
  if (registration.client !== 'claude' || registration.snapshot !== null) return null;
  let wake, floor;
  try {
    wake = intakeJSON(await intakeSnapshot(store, 'state', wakePath(registration), { maxBytes: 16384 }));
    floor = (await intakeSnapshot(store, 'state', registrationFloorPath(registration), { maxBytes: 16384 })).bytes;
  } catch { return null; } // A hint only: the locked pass validates everything again.
  if (floor !== null || !promptWakeWithoutFloor(registration, wake)) return null;
  const deadline = performance.now() + PROMPT_SOURCE_WAIT_MS;
  const present = async () => { try { return (await lstatOrNull(registration.sourcePath))?.size > 0; } catch { return true; } };
  for (let attempt = 0; !await present(); attempt++) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    checkWorkflowBudget();
    await delay(Math.min(50 * 2 ** attempt, remaining));
  }
  return deadline;
}

/** First registration waits for a real post-floor native boundary, excludes that
 * boundary prompt, then authorizes subsequent full units. Never look behind EOF.
 */
async function armRegistration(transaction, store, registration, wake, authorize, observeRead, current, grantHash, link = null) {
  const selected = { client: registration.client, sessionId: registration.sessionId,
    path: registration.sourcePath, projectRoot: registration.cwd };
  const floorName = registrationFloorPath(registration);
  const floorSnapshot = await intakeSnapshot(store, 'state', floorName, { maxBytes: 16384 }), floor = intakeJSON(floorSnapshot);
  if (floor) { keys(floor, ['registrationId', 'snapshot']); nativeId(floor.registrationId); }
  if (floor && floor.registrationId !== registration.id) fail('REGISTRATION_REQUIRES_REVIEW');
  let frozen = registration.snapshot ?? floor?.snapshot ?? wake?.snapshot ?? null;
  // Only the worker freezes a floor. Later is never wider: the first prompt,
  // already persisted, stays before it and the next prompt is the boundary.
  const freezing = !frozen && promptWakeWithoutFloor(registration, wake);
  if (freezing) frozen = await snapshotSourceMetadata(registration.sourcePath);
  if (!frozen) return { pending: 'SOURCE_BOUNDARY_PENDING' };
  keys(frozen, ['path', 'fileIdentity', 'eofByte']); hash(frozen.fileIdentity); integer(frozen.eofByte);
  if (frozen.path !== selected.path) fail('SOURCE_IDENTITY_MISMATCH');
  // A verified continuation of a registered root session may carry Claude's
  // background kind and re-homes that session's history, which is never
  // collected again: its boundary is the first own prompt after both floors.
  const continued = registration.client === 'claude' ? await readContinuesLink(store, registration.sessionId) : null;
  const sessionHeader = registration.client === 'codex' ? codexRegistrationHeader(selected)
    : claudeRegistrationHeader(selected, { sessionKinds: continued?.link.to.sessionKinds ?? [] });
  // A floor the worker freezes must already hold the rows that identify the
  // session. Rows written after the snapshot (Claude writes bookkeeping first)
  // would otherwise verify the header while the first prompt falls past the
  // floor; such a pass finds the header unavailable and retries within its wait.
  const verifyHeader = !freezing ? sessionHeader : io => sessionHeader({ ...io, size: Math.min(io.size, frozen.eofByte),
    readHeader: (offset, length) => offset + length > frozen.eofByte ? fail('SESSION_HEADER_UNAVAILABLE') : io.readHeader(offset, length) });
  const observed = await inspectSourceBoundary(selected, { verifyHeader, frozen, currentUnitId: registration.unitId });
  if (observed.status !== 'registered') return { pending: 'SOURCE_BOUNDARY_PENDING' };
  const continuation = registration.client === 'claude' ? await claudeContinuation(transaction, store, observed.source, link, authorize, observeRead) : null;
  const target = continuation?.from ?? null;
  // An attachment or system row can identify the session before its first
  // prompt is written, so that floor must hold a complete human prompt of its
  // own too: past a continuation's re-homed prefix, whose rows carry this
  // session's ID. A record the bounded read cannot reach names its own cause.
  if (freezing) {
    const read = await readSessionRange({ source: observed.source, from: 0, endByte: frozen.eofByte,
      readHeader: verifyHeader, verifyHeader: identity => identity, observeRead, maxBytes: 8 * 1024 * 1024 });
    const own = target?.prefix.endByte ?? 0;
    if (!read.records.some(record => record.startByte >= own && isClaudeHumanRow(record.value))) fail(read.blocked?.code ?? 'SESSION_HEADER_UNAVAILABLE');
  }
  if (registration.snapshot === null && floor === null) await replaceIntakeJSON(transaction, floorName,
    { registrationId: registration.id, snapshot: frozen }, null);
  const intervalId = randomUUID(), temporary = newSelectionState(observed.source);
  temporary.active = true; temporary.intervals = [{ id: intervalId, lower: { ...observed.boundary, unitId: null }, upper: null }];
  const result = await (registration.client === 'codex' ? readCodexSelection : readClaudeSelection)({ state: temporary, scopeId: intervalId, maxBytes: 8 * 1024 * 1024, observeRead,
    ...(continuation ? { continuation } : {}) });
  const anchors = result.nativeAnchors, floorByte = Math.max(frozen.eofByte, target?.prefix.endByte ?? 0);
  const usable = anchors.filter(item => item.record.startByte >= floorByte && item.record.endByte - item.record.startByte <= 64 * 1024);
  const anchor = usable.find(item => item.unitId === registration.unitId) ?? usable[0];
  if (!anchor) {
    // A session continued before its first boundary prompt (a fresh session
    // whose only prompt was a control) links here; it never arms afterwards.
    if (result.continuedIn && link && !link.attempted) {
      link.attempted = true;
      await authorize();
      const linked = await linkClaudeContinuation(transaction, store, { source: observed.source, registration, originKinds: target?.sessionKinds ?? [],
        hint: result.continuedIn, config: link.config, authorize, observeRead });
      if (linked) link.successor = linked.to.sessionId;
    }
    if (result.terminal && !result.blocked) return { pending: null };
    return { pending: result.blocked?.code ?? 'NATIVE_BOUNDARY_PENDING' };
  }
  const boundary = { ...observed.boundary, unitId: anchor.unitId, record: anchor.record };
  const selection = await controlSelection(transaction, { source: observed.source, expectedHash: current.hash, boundary, authorize, grantHash,
    request: { id: registration.id, operation: 'start', client: registration.client, sessionId: registration.sessionId, unitId: anchor.unitId, expectedRevision: current.state?.revision ?? 0 } });
  return { selection, boundaryExcluded: anchor.unitId };
}

// Verified links of this Claude source, read fresh on every pass. They never
// widen a scope: a successor skips its re-homed prefix, an origin stops at its
// marker. Only the worker, with the registration and policy, creates a link.
async function claudeContinuation(transaction, store, source, link, authorize, observeRead) {
  const registration = link?.registration ?? null;
  const origin = await readContinuedLink(store, source.sessionId);
  // Repair a pointer lost between the two create-once writes.
  if (origin && registration) await ensureContinuesPointer(transaction, store, origin, authorize);
  // The pinned prefix record is re-read here, so a rewrite behind a floor that
  // starts past it still fails this pass rather than reading as structural.
  const from = await continuationTarget(await readContinuesLink(store, source.sessionId), source, registration, { observeRead });
  const into = continuationOrigin(origin, source, registration);
  return from || into ? { from, into } : null;
}

// Claude reader blocks a paused interval may be suspended at.
const CLAUDE_FROZEN_BLOCKS = Object.freeze(['UNSUPPORTED_CLAUDE_RECORD', 'CLAUDE_HISTORY_REQUIRES_REVIEW',
  'CONFLICTING_CLAUDE_MIRROR', 'CLAUDE_PARENT_CYCLE', 'CLAUDE_COMPACTION_ANCESTRY_UNAVAILABLE',
  'UNSUPPORTED_CLAUDE_CONTENT', 'INVALID_SESSION_CLIENT_VERSION', 'INVALID_SESSION_RECORD', 'SESSION_RECORD_LIMIT',
  'READER_CHECKPOINT_CAPACITY', 'INVALID_WORKFLOW']);
// Reader blocks no later pass can get past, in either client: a record the
// reader stops at, or a turn it can never read or publish, such as one whose
// records break the turn's own order. Automatic capture of that chat has
// stopped until the cause is reviewed.
export const READER_BLOCK_CODES = Object.freeze([...CLAUDE_FROZEN_BLOCKS, 'UNSUPPORTED_SESSION_OWNERSHIP',
  'UNSUPPORTED_CODEX_RECORD', 'UNSUPPORTED_CODEX_ORDER', 'UNSUPPORTED_CODEX_HISTORY', 'UNSUPPORTED_CODEX_CONTENT',
  'UNSUPPORTED_CODEX_TOOL_OUTPUT', 'UNSUPPORTED_CODEX_ITEM', 'UNSUPPORTED_CODEX_ROLE', 'UNSUPPORTED_CODEX_RESPONSE',
  'AMBIGUOUS_CODEX_ATTRIBUTION', 'CONFLICTING_CODEX_MIRROR', 'CONFLICTING_CODEX_CALL', 'CODEX_ROLLBACK_REQUIRES_REVIEW',
  'SESSION_UNIT_LIMIT', 'SOURCE_ANCHOR_LIMIT', 'EVIDENCE_AFTER_CODEX_TERMINAL', 'DUPLICATE_CODEX_START',
  'EVIDENCE_BEFORE_CODEX_START', 'CONFLICTING_CODEX_TERMINAL', 'LATE_NATIVE_EVIDENCE_REQUIRES_REVIEW',
  'UNSUPPORTED_CODEX_HEADER', 'UNSUPPORTED_CLAUDE_HEADER', 'READER_CHECKPOINT_ALLOCATION_CAPACITY',
  'INVALID_READER_CHECKPOINT', 'READER_PAGE_CONFLICT', 'UNSUPPORTED_CLAUDE_READER',
  // Saved reader state that is malformed or no longer fits its scope fails
  // every visit the same way until it is repaired.
  'READER_CHECKPOINT_CONFLICT', 'READER_CHECKPOINT_IDENTITY_MISMATCH', 'READER_ALLOCATION_INCONSISTENT',
  'INVALID_READER_PROGRESS', 'INVALID_READER_SUSPENSION', 'READER_CHECKPOINT_REQUIRED', 'INVALID_INTAKE_CURSOR',
  // A turn whose earlier capture this reader cannot extend, or that conflicts
  // with the current transcript, is held on every pass.
  'UNSUPPORTED_CODEX_READER', 'CAPTURE_REVISION_CONFLICT', 'CAPTURE_REVISION_SCOPE_CONFLICT', 'CAPTURE_BASELINE_REQUIRED',
  'SOURCE_IDENTITY_MISMATCH', 'FINAL_CAPTURE_CONFLICT',
  // A turn whose capture would be larger than a capture may be, or would hold
  // what a capture cannot: every pass refuses it the same way.
  'CAPTURE_SIZE_LIMIT', 'CAPTURE_TOOL_LIMIT', 'UNSUPPORTED_ATTACHMENT',
  // Saved capture state that is malformed, or a head whose saved capture is
  // missing or changed, fails every visit that reads it.
  'INVALID_CAPTURE_HEAD', 'CAPTURE_HEAD_CONFLICT', 'INVALID_INTAKE_METADATA', 'UNSUPPORTED_CAPTURE_SCHEMA', 'INVALID_CAPTURE_READER',
  'INVALID_CAPTURE_COVERAGE', 'INVALID_CAPTURE_RANGE', 'CAPTURE_HASH_MISMATCH']);

// The reader block a visit of a chat last ended on, kept per chat: a later
// pass that does not visit the chat cannot erase it the way it rebuilds the
// collection-wide status notice. A visit that ends without one clears it. The
// visit keeps it under its own intake lock, so visits replace it in order. The
// marker is the visit's own record, so one that cannot be read is replaced.
export const readerBlockPath = identity => `reader-blocks/${identity.client}/${nativeId(identity.sessionId)}.json`;
async function recordReaderBlock(store, identity, code) {
  const next = READER_BLOCK_CODES.includes(code) ? code : null, name = readerBlockPath(identity);
  let previous;
  try { previous = intakeJSON(await intakeSnapshot(store, 'state', name, { maxBytes: 4096 })); } catch { previous = undefined; }
  if (previous !== undefined && (previous?.code ?? null) === next) return;
  await publishIngressMetadata(store, name, { version: 1, code: next });
}
/** The reader block a scope's result holds a turn on, if any: any of its hold
 * reasons, not only the first. */
export function readerBlockOf(result) {
  return (result.holds ?? []).find(code => READER_BLOCK_CODES.includes(code)) ??
    (READER_BLOCK_CODES.includes(result.pending) ? result.pending : null);
}
/** The reader block this chat's last visit ended on, if any. */
/** `resume chat` starts a new stretch, which no block of an earlier one stops. */
export const clearReaderBlock = (store, identity) => recordReaderBlock(store, identity, null);
export async function readReaderBlock(store, identity) {
  const value = intakeJSON(await intakeSnapshot(store, 'state', readerBlockPath(identity), { maxBytes: 4096 }));
  return value !== null && READER_BLOCK_CODES.includes(value.code) ? value.code : null;
}

// `link` carries the registration and policy for creating a session link; its
// `attempted` flag is shared by all scopes of one registration visit.
export async function processScope(transaction, store, selection, scopeId, authorize, observeRead, link = null) {
  let saved = 0, pending = null;
  for (let pass = 0; pass < 8; pass++) {
    checkWorkflowBudget();
    const identity = { client: selection.state.source.client, sessionId: selection.state.source.sessionId };
    const continuation = identity.client === 'claude' ? await claudeContinuation(transaction, store, selection.state.source, link, authorize, observeRead) : null;
    const { snapshot: progress, cursor, checkpointRoot } = await readReaderProgress(store, identity, scopeId, selection.state.source.fileIdentity, { metadataOnly: true });
    const scope = currentIntervals(selection.state).find(item => item.id === scopeId) ?? selection.state.explicitScopes.find(item => item.id === scopeId);
    if (scope?.end && cursor?.offset === scope.end.endByte) return { saved, pending: null, incomplete: false, drained: true };
    const suspensionName = `reader-suspensions/${identity.client}/${identity.sessionId}/${scopeId}.json`;
    const suspensionBinding = scope?.upper && identity.client === 'claude' ? {
      readerRulesRevision: CLAUDE_READER_RULES_REVISION,
      sourceIdentity: selection.state.source.fileIdentity, intervalHash: digest(canonicalJSON(scope)), cursorHash: progress.hash,
      ceilingByte: scope.upper.eofByte } : null;
    let suspensionSnapshot = null;
    const suspend = async (reason, diagnostic = null) => {
      await authorize();
      if ((await readSelection(store, identity)).hash !== selection.hash) fail('STALE_SELECTION');
      if (!suspensionSnapshot) suspensionSnapshot = await intakeSnapshot(store, 'state', suspensionName);
      await replaceIntakeJSON(transaction, suspensionName, { version: READER_SUSPENSION_VERSION, ...suspensionBinding, reason, diagnostic }, suspensionSnapshot.hash);
      return { saved, pending: diagnostic, incomplete: false, suspended: true, suspensionReason: reason };
    };
    if (suspensionBinding) {
      suspensionSnapshot = await intakeSnapshot(store, 'state', suspensionName);
      const old = intakeJSON(suspensionSnapshot);
      if (old) {
        if (!Number.isSafeInteger(old.version) || old.version < 1) fail('INVALID_READER_SUSPENSION');
        // Unknown cache shapes and stale reader rules are misses, not permanent
        // errors. Re-read only the already-authorized, frozen range.
        if (old.version === READER_SUSPENSION_VERSION && old.readerRulesRevision === CLAUDE_READER_RULES_REVISION) {
          keys(old, ['version', 'readerRulesRevision', 'sourceIdentity', 'intervalHash', 'cursorHash', 'ceilingByte', 'reason', 'diagnostic']);
          choice(old.reason, ['pause-boundary', 'partial-tail', 'unresolved-boundary']);
          if (old.diagnostic !== null && typeof old.diagnostic !== 'string') fail('INVALID_READER_SUSPENSION');
          const { version: _version, reason, diagnostic, ...binding } = old;
          if (canonicalJSON(binding) === canonicalJSON(suspensionBinding)) {
            return { saved, pending: diagnostic, incomplete: false, suspended: true, suspensionReason: reason };
          }
        }
      }
    }
    // A contiguous committed Codex prefix cannot cross an unfinished selected
    // unit. Once it passes the resolved upper anchor, closed work is terminal.
    // Claude snapshots have no corresponding closure proof.
    if (identity.client === 'codex' && scope?.upper?.record && cursor?.offset >= scope.upper.record.endByte) {
      return { saved, pending: null, incomplete: false, drained: true };
    }
    const checkpoint = await hydrateReaderCheckpoint(store, checkpointRoot);
    if (identity.client === 'claude' && scope?.upper && !scope.upper.record && checkpoint) {
      const unit = checkpoint.units.find(unit => unit.id === scope.upper.unitId);
      const record = checkpoint.records.find(row => row.id === unit?.recordId);
      if (record && record.startByte >= scope.lower.eofByte && record.startByte <= scope.upper.eofByte) {
        selection = await resolveStoredSelectionAnchor(transaction, { identity, intervalId: scope.id, side: 'upper',
          proven: { sourceIdentity: selection.state.source.fileIdentity, unitId: unit.id,
            record: { id: record.id, startByte: record.startByte, endByte: record.endByte, hash: record.hash } },
          expectedHash: selection.hash, authorize });
        continue;
      }
    }
    if (suspensionBinding && (cursor?.offset ?? scope.lower.eofByte) >= scope.upper.eofByte) {
      return suspend(scope.upper.record ? 'pause-boundary' : 'unresolved-boundary', scope.upper.record ? null : 'anchor-unresolved');
    }
    const result = await (identity.client === 'codex' ? readCodexSelection : readClaudeSelection)({ state: selection.state, scopeId,
      cursor, checkpoint, observeRead,
      resolveProcessingExecution: createProcessingExecutionResolver(transaction, { source: selection.state.source,
        authorize: () => authorize({ operation: 'capture', identity, projectRoot: selection.state.source.projectRoot,
          sourcePath: selection.state.source.path }) }),
      resolveProcessingDispatch: createProcessingControlResolver(transaction,
        { state: selection.state, selectionHash: selection.hash, authorize, scopeId }),
      loadHead: unitId => readCaptureHead(store, { ...identity, unitId }), ...(identity.client === 'claude' ? { continuation } : {}) });
    // A later event for an already published/pruned Codex unit is not harmless
    // structural content. Do not advance through it as an excluded prefix.
    for (const unitId of result.unanchoredUnits) {
      const unit = { client: identity.client, sessionId: identity.sessionId, unitId };
      if (await readTombstone(store, unit) || (await readCaptureHead(store, unit, { metadataOnly: true })).head) fail('LATE_NATIVE_EVIDENCE_REQUIRES_REVIEW');
    }
    if (result.anchorUpdates.length) {
      for (const update of result.anchorUpdates) selection = await resolveStoredSelectionAnchor(transaction,
        { identity, ...update, expectedHash: selection.hash, authorize });
      continue; // Fresh reader proofs must use the persisted selection hash.
    }
    const published = new Map((result.covered ?? []).map(({ unitId, ...reference }) => [unitId, reference])), expectedHeads = new Map();
    let advanced = false;
    for (const candidate of result.candidates) {
      const unitId = candidate.capture.identity.unitId, head = await readCaptureHead(store, candidate.capture.identity, { metadataOnly: true });
      expectedHeads.set(unitId, head.hash);
      if (head.head?.evidenceHash === candidate.capture.evidenceHash) published.set(unitId, { evidenceHash: head.head.evidenceHash, fileHash: head.head.fileHash });
    }
    for (const candidate of result.candidates) {
      checkWorkflowBudget();
      const unitId = candidate.capture.identity.unitId;
      const plan = identity.client === 'codex' ? codexPublicationPlan(result, unitId, published) : claudePublicationPlan(result, unitId, published);
      const output = await publishCapture(transaction, { ...candidate, selectionHash: selection.hash, cursorHash: progress.hash, scan: plan.scan,
        checkpoint: identity.client === 'codex' ? codexCheckpoint(result, plan.scan.to.offset) : plan.checkpoint,
        expectedHeadHash: Object.hasOwn(candidate, 'expectedHeadHash') ? candidate.expectedHeadHash : expectedHeads.get(unitId), authorize });
      if (!published.has(unitId)) saved++;
      published.set(unitId, { evidenceHash: output.evidenceHash, fileHash: output.fileHash });
      if (output.cursorHash !== progress.hash) { advanced = true; break; }
      pending ??= plan.heldReason;
    }
    if (advanced) continue;
    const plan = identity.client === 'codex' ? codexProgressPlan(result, published) : claudePublicationPlan(result, null, published);
    if (plan.scan.to.offset > plan.scan.from.offset) {
      await commitReaderProgress(transaction, { identity: { client: identity.client, sessionId: identity.sessionId }, scopeId,
        selectionHash: selection.hash, cursorHash: progress.hash, scan: plan.scan, checkpoint: plan.checkpoint, authorize });
      continue;
    }
    // One bounded link attempt per registration visit; a refused link leaves
    // the marker diagnostic exactly as before.
    if (result.continuedIn && link && !link.attempted) {
      link.attempted = true;
      await authorize();
      const linked = await linkClaudeContinuation(transaction, store, { source: selection.state.source, registration: link.registration,
        originKinds: continuation?.from?.sessionKinds ?? [], hint: result.continuedIn, config: link.config, authorize, observeRead,
        ...(scope?.upper ? { ceiling: scope.upper.eofByte } : {}) });
      if (linked) { link.successor = linked.to.sessionId; continue; }
    }
    const frozenBlock = !result.blocked || CLAUDE_FROZEN_BLOCKS.includes(result.blocked.code);
    if (suspensionBinding && result.diagnostics.automaticCeilingReached && frozenBlock &&
        result.pending.every(item => item.reason === 'anchor-unresolved')) {
      const unresolved = result.blocked?.code ?? result.pending[0]?.reason ?? plan.heldReason ?? pending;
      return suspend(unresolved ? 'unresolved-boundary' : result.diagnostics.pendingTail ? 'partial-tail' : 'pause-boundary',
        unresolved ?? (result.diagnostics.pendingTail ? 'CLAUDE_PAUSED_PARTIAL_TAIL' : null));
    }
    // `holds` names every reason a unit of the scope was held, not only the first.
    return { saved, pending: result.blocked?.code ?? result.pending[0]?.reason ?? plan.heldReason ?? pending,
      holds: [...new Set([result.blocked?.code, ...result.pending.map(item => item.reason)].filter(Boolean))],
      incomplete: result.diagnostics.pendingTail || result.diagnostics.limited };
  }
  return { saved, pending: 'WORKER_PASS_LIMIT', incomplete: true };
}

// `linked` names a successor session this visit linked, if any. Only the
// session whose hook launched this worker waits for its transcript: a stale
// registration whose file never appears must not slow every later pass.
async function runRegistration(capability, registration, registrationHash, route, grantHash, observeRead, config, { awaitSource = false } = {}) {
  const identity = { client: registration.client, sessionId: registration.sessionId };
  const selectionIdentity = { ...identity, cwd: registration.cwd };
  await assertWorkflowStorage(capability, selectionIdentity, 'collect');
  const store = await openWorkflowIntake(capability, selectionIdentity, 'collect');
  const authorize = async () => { await assertWorkflowStorage(capability, selectionIdentity, 'collect'); return true; };
  // Outside the intake lock: waiting for a file holds no other session up.
  const settleBy = awaitSource ? await awaitPromptSource(store, registration) : null;
  const keepBlock = async code => { try { await recordReaderBlock(store, identity, code); } catch { /* the notice still reports this pass */ } };
  const visit = link => withIntakeLock(store, async transaction => {
    let result;
    try { result = await visitChat(transaction, link); }
    catch (error) { if (READER_BLOCK_CODES.includes(error.code)) await keepBlock(error.code); throw error; }
    // Any scope's reader block counts, not only the first reason one reported.
    await keepBlock(result.readerBlock !== undefined ? result.readerBlock : result.pending);
    return result;
  });
  const visitChat = async (transaction, link) => {
    if (await lstatOrNull(await intakePath(store, 'state', '.intake-maintenance'))) fail('INTAKE_OFFLINE_MAINTENANCE');
    // Another worker may have left an intent after this pass's initial recovery.
    // Never reconcile it through the registration currently being visited.
    if (await inspectPendingPublication(store)) fail('INTAKE_RECOVERY_REQUIRED');
    const wakeName = wakePath(registration), wakeSnapshot = await intakeSnapshot(store, 'state', wakeName, { maxBytes: 16384 });
    let selection = await readSelection(store, identity), boundaryExcluded = null;
    await assertRegistrationGrant(store, registration, selection.state, grantHash, route);
    if (selection.state?.safetyStop) return { saved: 0, pending: 'SELECTION_CAPACITY_EXCEEDED' };
    if (selection.state && selection.state.source.path !== registration.sourcePath) fail('SOURCE_IDENTITY_MISMATCH');
    const ackName = wakeName.replace('/wake/', '/wake-acks/'), beforeVersion = await sourceVersion(registration.sourcePath);
    if (selection.state && beforeVersion && await hasAcknowledgement(store, ackName,
      ackValue(registrationHash, selection.hash, grantHash, wakeSnapshot.hash, beforeVersion))) {
      await authorize();
      if (canonicalJSON(beforeVersion) === canonicalJSON(await sourceVersion(registration.sourcePath))) {
        return { saved: 0, pending: selection.state.paused ? 'COLLECTION_PAUSED' : null, boundaryExcluded: currentIntervals(selection.state)[0]?.lower.unitId ?? null };
      }
    }
    if (selection.state === null || (!selection.state.active && !selection.state.paused)) {
      await authorize(); // Before ANY selected-source bytes are read.
      const armed = await armRegistration(transaction, store, registration, intakeJSON(wakeSnapshot), authorize, observeRead, selection, grantHash, link);
      if (!armed.selection) return { saved: 0, pending: armed.pending };
      selection = armed.selection; boundaryExcluded = armed.boundaryExcluded;
    }
    // The native source cwd is distinct from the broader configured route root.
    // Keep the excluded initial boundary visible on later visits as well.
    boundaryExcluded ??= currentIntervals(selection.state)[0]?.lower.unitId ?? null;
    let saved = 0, pending = null, readerBlock = null, incomplete = false, drained = true, suspended = true;
    // Only the latest interval, the stretch Automatic capture extends, can stop
    // it: a block in an earlier pause's stretch or in a typed or CLI capture
    // leaves later turns to Automatic capture.
    const latest = currentIntervals(selection.state).at(-1)?.id;
    for (const scope of [...currentIntervals(selection.state), ...selection.state.explicitScopes]) {
      await authorize();
      const result = await processScope(transaction, store, selection, scope.id, authorize, observeRead, link);
      saved += result.saved; pending ??= result.pending; incomplete ||= Boolean(result.incomplete);
      if (scope.id === latest) readerBlock ??= readerBlockOf(result);
      drained &&= result.drained === true; suspended &&= result.suspended === true || result.drained === true;
      selection = await readSelection(store, identity);
    }
    if (!pending && !incomplete && beforeVersion) {
      const afterVersion = await sourceVersion(registration.sourcePath);
      if (canonicalJSON(beforeVersion) === canonicalJSON(afterVersion)) {
        await authorize();
        try { await publishIngressMetadata(store, ackName, ackValue(registrationHash, selection.hash, grantHash, wakeSnapshot.hash, afterVersion)); }
        catch (error) {
          // Preserve an oversized disposable hint. It cannot prevent capture or
          // justify bypassing a path/privacy/identity failure during replacement.
          if (error.code !== 'FILE_SIZE_LIMIT_EXCEEDED') throw error;
        }
      }
    }
    if (selection.state.paused && drained && !pending && !incomplete) {
      await publishIngressMetadata(store, drainedPath(identity), { version: 1, selectionHash: selection.hash });
    }
    if (selection.state.paused && suspended && !incomplete && !await inspectPendingPublication(store)) {
      await publishIngressMetadata(store, suspendedPath(identity), { version: READER_SUSPENSION_VERSION,
        readerRulesRevision: CLAUDE_READER_RULES_REVISION, selectionHash: selection.hash });
    }
    return { saved, pending: pending ?? (selection.state.paused ? 'COLLECTION_PAUSED' : null), readerBlock, incomplete, boundaryExcluded };
  };
  for (let attempt = 0; ; attempt++) {
    const link = { registration, config, attempted: false, successor: null };
    try { return { ...await visit(link), linked: link.successor }; }
    catch (error) {
      // Only within the triggering session's bounded wait, and outside the
      // lock: a transcript holding only bookkeeping so far has no readable
      // header yet. Every other failure, or one after the wait, stands.
      const remaining = settleBy === null ? 0 : settleBy - performance.now();
      if (error?.code !== 'SESSION_HEADER_UNAVAILABLE' || remaining <= 0) throw error;
      checkWorkflowBudget();
      await delay(Math.min(50 * 2 ** attempt, remaining));
    }
  }
}

async function recoverOwner(capability, store, snapshot, collectionId) {
  const pending = await inspectPendingPublication(store);
  if (!pending) return;
  let recoveryStore = store, authorize;
  if (pending.committed) {
    authorize = async context => {
      if (context.phase !== 'reconcile-published') fail('INTAKE_RECOVERY_REQUIRED');
      await assertWorkflowStorage(capability, null, 'maintenance'); return true;
    };
  } else {
    // Exact lookup precedes the bounded registration batch. Missing/revoked
    // ongoing authority leaves foreign intent untouched for recovery; an
    // explicit capture's own is finished under its explicit authority.
    const { registration } = await readRegistration(store, pending.identity, { mismatchCode: 'INTAKE_RECOVERY_REQUIRED' });
    const route = registration && await resolveWorkflowRoute(snapshot.config, registration);
    if (!registration || !route.intended?.collect || route.collection.id !== collectionId) {
      ({ recoveryStore, authorize } = await explicitRecovery(capability, store, pending));
      await withIntakeLock(recoveryStore, transaction => recoverPendingPublication(transaction, { expectedHash: pending.hash, authorize }));
      return;
    }
    const selected = await readSelection(store, pending.identity);
    await assertRegistrationGrant(store, registration, selected.state, await collectionGrantHash(snapshot.config, route.route.id, registration), route);
    if (!selected.state || ![...currentIntervals(selected.state), ...selected.state.explicitScopes].some(scope => scope.id === pending.scopeId) || selected.state.source.path !== registration.sourcePath ||
        selected.state.source.projectRoot !== await canonicalWorkflowProject(registration.cwd)) fail('INTAKE_RECOVERY_REQUIRED');
    const identity = { client: registration.client, sessionId: registration.sessionId, cwd: registration.cwd };
    recoveryStore = await openWorkflowIntake(capability, identity, 'collect');
    authorize = async context => {
      if (context.identity.client !== identity.client || context.identity.sessionId !== identity.sessionId || context.scopeId !== pending.scopeId) fail('INTAKE_RECOVERY_REQUIRED');
      await assertWorkflowStorage(capability, identity, 'collect'); return true;
    };
  }
  await withIntakeLock(recoveryStore, transaction => recoverPendingPublication(transaction, { expectedHash: pending.hash, authorize }));
}

// An explicit capture (a typed `capture` or the CLI) stopped mid-publication
// has no ongoing owner. While its chat's route still allows explicit capture it
// is finished under that same authority, so one chat's interrupted capture
// never stops a pass for every chat; any other intent stays untouched.
async function explicitRecovery(capability, store, pending) {
  const selected = await readSelection(store, pending.identity);
  const scope = selected.state?.explicitScopes.find(item => item.id === pending.scopeId);
  if (!scope) fail('INTAKE_RECOVERY_REQUIRED');
  const identity = { client: pending.identity.client, sessionId: pending.identity.sessionId, cwd: selected.state.source.projectRoot };
  const explicit = async () => {
    try { await assertWorkflowStorage(capability, identity, 'explicitCollect'); }
    catch (error) { if (error.code === 'WORKFLOW_NOT_AUTHORIZED') fail('INTAKE_RECOVERY_REQUIRED'); throw error; }
  };
  await explicit();
  const recoveryStore = await openExplicitCaptureIntake(capability, identity, { scopeId: scope.id, unitIds: scope.unitIds });
  const authorize = async context => {
    if (context.identity.client !== identity.client || context.identity.sessionId !== identity.sessionId || context.scopeId !== pending.scopeId) fail('INTAKE_RECOVERY_REQUIRED');
    await explicit(); return true;
  };
  return { recoveryStore, authorize };
}

const passStopCodes = new Set(['INTAKE_BLOCKED', 'INTAKE_RECOVERY_REQUIRED', 'WORKER_TIME_BUDGET', 'WORKER_READ_BUDGET']);

export async function runCollectionWorker({ configPath, collectionId, milliseconds = 10000, bytes = 64 * 1024 * 1024, now, observeRead = () => {}, trigger = null, maxJobs = 32 }) {
  integer(maxJobs); if (maxJobs < 1 || maxJobs > 32) fail('INVALID_COLLECTION_JOB_LIMIT');
  if (trigger !== null) { keys(trigger, ['client', 'sessionId']); choice(trigger.client, CLIENTS); nativeId(trigger.sessionId); }
  const snapshot = await readWorkflowSnapshot(configPath), collection = snapshot.config?.collections.find(item => item.id === collectionId);
  if (!collection || !snapshot.config.routes.some(route => route.collectionId === collectionId && !route.excluded && route.collection.enabled)) return { status: 'disabled', saved: 0 };
  let output = { status: 'idle', saved: 0, pending: [], diagnostics: [], boundaryExcluded: [], updatedAt: new Date().toISOString() };
  try {
    await withWorkflowBudget({ milliseconds, bytes, now }, () => withStorageProbes(async () => {
      const capability = await verifyWorkflowStorage({ configPath, collectionId, expectedConfigHash: snapshot.hash });
      const store = await openWorkflowIntake(capability);
      if (await lstatOrNull(await intakePath(store, 'state', '.intake-maintenance'))) fail('INTAKE_OFFLINE_MAINTENANCE');
      await recoverOwner(capability, store, snapshot, collectionId);
      // Keep scheduler transactions independent of the growing set of pinned
      // registration directories inspected by this pass.
      const schedulerStore = await openWorkflowIntake(capability);
      let scheduler = await readCollectionScheduler(schedulerStore);
      const background = collectionJobs(store, scheduler.value.cursor, output.pending);
      // A hint supplies a locator, not an existence or permission guarantee.
      // Inspect it only inside the same reserved, isolated attempt as any job.
      let hinted = trigger ? { ...trigger, file: registrationPath(trigger), cursor: null } : null;
      let preferHint = scheduler.value.triggerFirst, first = true, count = 0;
      const seen = new Set();
      // A successor visited before its origin linked it in this pass is
      // visited once more, so its floor and boundary follow the new link.
      const revisits = [], revisited = new Set();
      for (; count < maxJobs; count++) {
        let job;
        if (revisits.length) job = revisits.shift();
        else if (hinted && preferHint) { job = hinted; hinted = null; }
        else {
          const next = await background.next();
          if (!next.done) job = next.value;
          else if (hinted) { job = hinted; hinted = null; }
          else break;
        }
        preferHint = true; // Background-first runs reserve one fair slot first.
        scheduler = await reserveCollectionAttempt(capability, schedulerStore, scheduler,
          { ...scheduler.value, cursor: job.cursor ?? scheduler.value.cursor,
            triggerFirst: first ? !scheduler.value.triggerFirst : scheduler.value.triggerFirst });
        first = false;
        if (job.diagnostic && !output.pending.includes(job.diagnostic)) output.pending.push(job.diagnostic);
        if (job.maintenance) continue;
        if (seen.has(job.file) && !job.revisit) continue;
        seen.add(job.file);
        if (job.revisit) {
          // This pass's earlier result for the session is superseded.
          output.diagnostics = output.diagnostics.filter(item => {
            if (item.client !== job.client || item.sessionId !== job.sessionId) return true;
            const at = output.pending.indexOf(item.code); if (at >= 0) output.pending.splice(at, 1);
            return false;
          });
        }
        output.lastRegistration = job.file;
        try {
          const { snapshot: registered, registration } = await readRegistration(store, job);
          if (registered.bytes === null) {
            // A locator-only trigger can have no registration yet. A discovered
            // directory without its atomically published record is damaged.
            if (job.cursor !== null || await lstatOrNull(path.dirname(await intakePath(store, 'state', job.file)))) fail('INVALID_REGISTRATION');
            continue;
          }
          const route = await resolveWorkflowRoute(snapshot.config, registration);
          if (!route.intended?.collect) continue;
          if (route.collection.id !== collectionId) continue;
          const grantHash = await collectionGrantHash(snapshot.config, route.route.id, registration);
          const result = await runRegistration(capability, registration, registered.hash, route, grantHash, observeRead, snapshot.config,
            { awaitSource: Boolean(trigger) && job.file === registrationPath(trigger) });
          output.saved += result.saved;
          if (result.pending) {
            output.pending.push(result.pending);
            // A reader block names this chat's stop only where it stops
            // Automatic capture, as the chat's kept marker does.
            const code = result.readerBlock !== undefined && READER_BLOCK_CODES.includes(result.pending) ? result.readerBlock : result.pending;
            if (code && !passStopCodes.has(code)) output.diagnostics.push({ client: job.client, sessionId: job.sessionId, code });
          }
          if (result.boundaryExcluded) output.boundaryExcluded.push({ client: registration.client, sessionId: registration.sessionId, unitId: result.boundaryExcluded });
          if (result.linked) {
            const successor = { client: 'claude', sessionId: result.linked, file: registrationPath({ client: 'claude', sessionId: result.linked }), cursor: null, revisit: true };
            if (seen.has(successor.file) && !revisited.has(successor.file)) { revisited.add(successor.file); revisits.push(successor); }
          }
        } catch (error) {
          output.pending.push(error.code ?? 'COLLECTION_FAILED');
          if (passStopCodes.has(error.code)) break;
          output.diagnostics.push({ client: job.client, sessionId: job.sessionId, code: error.code ?? 'COLLECTION_FAILED' });
        }
      }
      if (count === maxJobs) {
        let remaining = hinted && !seen.has(hinted.file);
        while (!remaining) {
          const next = await background.next();
          if (next.done) break;
          remaining = next.value.maintenance || !seen.has(next.value.file);
        }
        if (remaining) output.pending.push('REGISTERED_BACKLOG_PENDING');
      }
      await background.return();
    }));
  } catch (error) { output.pending.push(error.code ?? 'COLLECTION_FAILED'); }
  output.pending = [...new Set(output.pending)].slice(0, 32);
  output.status = output.pending.length ? 'pending' : 'idle';
  // A bounded diagnostic is not capture authority. Publish outside an exhausted
  // pass budget only while the exact original policy still applies.
  if (!output.pending.some(code => ['INTAKE_BLOCKED', 'INTAKE_OFFLINE_MAINTENANCE'].includes(code)) &&
      (await readWorkflowSnapshot(configPath)).hash === snapshot.hash) {
    const store = await inspectIntakeStore(collection);
    const offline = async () => Boolean(await lstatOrNull(await intakePath(store, 'state', '.intake-maintenance')));
    if (!await offline()) try {
      await withIntakeLock(store, async () => {
        if (await offline()) return;
        if ((await readWorkflowSnapshot(configPath)).hash !== snapshot.hash) return;
        const previous = intakeJSON(await intakeSnapshot(store, 'state', collectionStatusPath, { maxBytes: 16384 }));
        if (previous?.updatedAt > output.updatedAt) return;
        await publishIngressMetadata(store, collectionStatusPath, output);
      });
    } catch (error) {
      if (error.code !== 'INTAKE_BLOCKED') throw error;
      // A current owner is authoritative; a losing worker publishes no status.
    }
  }
  return output;
}

if (await isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if ([4, 8].includes(args.length) && args[0] === '--config' && args[2] === '--collection' &&
      (args.length === 4 || (args[4] === '--client' && args[6] === '--session'))) {
    runCollectionWorker({ configPath: args[1], collectionId: args[3], ...(args.length === 8 ? { trigger: { client: args[5], sessionId: args[7] } } : {}) }).catch(() => { process.exitCode = 0; });
  }
}
