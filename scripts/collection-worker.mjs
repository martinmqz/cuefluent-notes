import path from 'node:path';
import { collectionJobs, readCollectionScheduler, reserveCollectionAttempt } from './collection-scheduler.mjs';
import { collectionGrantHash } from './collection-grant.mjs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isMain, lstatOrNull } from './file-io.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { verifyWorkflowStorage, assertWorkflowStorage } from './workflow-storage.mjs';
import { inspectIntakeStore, openWorkflowIntake, intakePath, intakeSnapshot, intakeJSON, withIntakeLock, replaceIntakeJSON } from './intake-io.mjs';
import { readSelection, controlSelection, resolveStoredSelectionAnchor, readCaptureHead, publishCapture, commitReaderProgress, recoverPendingPublication, inspectPendingPublication, readReaderProgress } from './intake-store.mjs';
import { newSelectionState, inspectSourceBoundary, currentIntervals, stableSourceIdentity } from './capture-selection.mjs';
import { codexRegistrationHeader, readCodexSelection, codexPublicationPlan, codexProgressPlan, codexCheckpoint } from './codex-reader.mjs';
import { claudeRegistrationHeader, readClaudeSelection, claudePublicationPlan, CLAUDE_READER_RULES_REVISION } from './claude-reader.mjs';
import { hydrateReaderCheckpoint } from './reader-pages.mjs';
import { readTombstone } from './capture-retention.mjs';
import { validateRegistration, publishIngressMetadata, wakePath, collectionStatusPath, registrationPath, drainedPath, suspendedPath, READER_SUSPENSION_VERSION, assertRegistrationGrant } from './collection-ingress.mjs';
import { withWorkflowBudget, checkWorkflowBudget } from './workflow-budget.mjs';
import { CLIENTS, fail, nativeId, keys, hash, integer, choice, canonicalJSON, digest } from './workflow-values.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { canonicalWorkflowProject } from './workflow-paths.mjs';

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

/** First registration waits for a real post-floor native boundary, excludes that
 * boundary prompt, then authorizes subsequent full units. Never look behind EOF.
 */
async function armRegistration(transaction, store, registration, wake, authorize, observeRead, current, grantHash) {
  const selected = { client: registration.client, sessionId: registration.sessionId,
    path: registration.sourcePath, projectRoot: registration.cwd };
  const floorName = `registration-floors/${registration.client}/${registration.sessionId}.json`;
  const floorSnapshot = await intakeSnapshot(store, 'state', floorName, { maxBytes: 16384 }), floor = intakeJSON(floorSnapshot);
  if (floor) { keys(floor, ['registrationId', 'snapshot']); nativeId(floor.registrationId); }
  if (floor && floor.registrationId !== registration.id) fail('REGISTRATION_REQUIRES_REVIEW');
  const frozen = registration.snapshot ?? floor?.snapshot ?? wake?.snapshot;
  if (!frozen) return { pending: 'SOURCE_BOUNDARY_PENDING' };
  keys(frozen, ['path', 'fileIdentity', 'eofByte']); hash(frozen.fileIdentity); integer(frozen.eofByte);
  if (frozen.path !== selected.path) fail('SOURCE_IDENTITY_MISMATCH');
  const verifyHeader = registration.client === 'codex' ? codexRegistrationHeader(selected) : claudeRegistrationHeader(selected);
  const observed = await inspectSourceBoundary(selected, { verifyHeader, frozen, currentUnitId: registration.unitId });
  if (observed.status !== 'registered') return { pending: 'SOURCE_BOUNDARY_PENDING' };
  if (registration.snapshot === null && floor === null) await replaceIntakeJSON(transaction, floorName,
    { registrationId: registration.id, snapshot: frozen }, null);
  const intervalId = randomUUID(), temporary = newSelectionState(observed.source);
  temporary.active = true; temporary.intervals = [{ id: intervalId, lower: { ...observed.boundary, unitId: null }, upper: null }];
  const result = await (registration.client === 'codex' ? readCodexSelection : readClaudeSelection)({ state: temporary, scopeId: intervalId, maxBytes: 8 * 1024 * 1024, observeRead });
  const anchors = result.nativeAnchors;
  const usable = anchors.filter(item => item.record.startByte >= frozen.eofByte && item.record.endByte - item.record.startByte <= 64 * 1024);
  const anchor = usable.find(item => item.unitId === registration.unitId) ?? usable[0];
  if (!anchor) return { pending: result.blocked?.code ?? 'NATIVE_BOUNDARY_PENDING' };
  const boundary = { ...observed.boundary, unitId: anchor.unitId, record: anchor.record };
  const selection = await controlSelection(transaction, { source: observed.source, expectedHash: current.hash, boundary, authorize, grantHash,
    request: { id: registration.id, operation: 'start', client: registration.client, sessionId: registration.sessionId, unitId: anchor.unitId, expectedRevision: current.state?.revision ?? 0 } });
  return { selection, boundaryExcluded: anchor.unitId };
}

export async function processScope(transaction, store, selection, scopeId, authorize, observeRead) {
  let saved = 0, pending = null;
  for (let pass = 0; pass < 8; pass++) {
    checkWorkflowBudget();
    const identity = { client: selection.state.source.client, sessionId: selection.state.source.sessionId };
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
      ...(identity.client === 'claude' ? { loadHead: unitId => readCaptureHead(store, { ...identity, unitId }) } : {}) });
    // A later event for an already published/pruned Codex unit is not harmless
    // structural content. Do not advance through it as an excluded prefix.
    for (const unitId of result.unanchoredUnits) {
      const unit = { client: identity.client, sessionId: identity.sessionId, unitId };
      if (await readTombstone(store, unit) || (await readCaptureHead(store, unit)).head) fail('LATE_NATIVE_EVIDENCE_REQUIRES_REVIEW');
    }
    if (result.anchorUpdates.length) {
      for (const update of result.anchorUpdates) selection = await resolveStoredSelectionAnchor(transaction,
        { identity, ...update, expectedHash: selection.hash, authorize });
      continue; // Fresh reader proofs must use the persisted selection hash.
    }
    const published = new Map((result.covered ?? []).map(({ unitId, ...reference }) => [unitId, reference])), expectedHeads = new Map();
    let advanced = false;
    for (const candidate of result.candidates) {
      const unitId = candidate.capture.identity.unitId, head = await readCaptureHead(store, candidate.capture.identity);
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
    const frozenBlock = !result.blocked || ['UNSUPPORTED_CLAUDE_RECORD', 'CLAUDE_HISTORY_REQUIRES_REVIEW',
      'CONFLICTING_CLAUDE_MIRROR', 'CLAUDE_PARENT_CYCLE', 'CLAUDE_COMPACTION_ANCESTRY_UNAVAILABLE',
      'UNSUPPORTED_CLAUDE_CONTENT', 'INVALID_SESSION_CLIENT_VERSION', 'INVALID_SESSION_RECORD', 'SESSION_RECORD_LIMIT',
      'READER_CHECKPOINT_CAPACITY', 'INVALID_WORKFLOW'].includes(result.blocked.code);
    if (suspensionBinding && result.diagnostics.automaticCeilingReached && frozenBlock &&
        result.pending.every(item => item.reason === 'anchor-unresolved')) {
      const unresolved = result.blocked?.code ?? result.pending[0]?.reason ?? plan.heldReason ?? pending;
      return suspend(unresolved ? 'unresolved-boundary' : result.diagnostics.pendingTail ? 'partial-tail' : 'pause-boundary',
        unresolved ?? (result.diagnostics.pendingTail ? 'CLAUDE_PAUSED_PARTIAL_TAIL' : null));
    }
    return { saved, pending: result.blocked?.code ?? result.pending[0]?.reason ?? plan.heldReason ?? pending,
      incomplete: result.diagnostics.pendingTail || result.diagnostics.limited };
  }
  return { saved, pending: 'WORKER_PASS_LIMIT', incomplete: true };
}

async function runRegistration(capability, registration, registrationHash, route, grantHash, observeRead) {
  const identity = { client: registration.client, sessionId: registration.sessionId };
  const selectionIdentity = { ...identity, cwd: registration.cwd };
  await assertWorkflowStorage(capability, selectionIdentity, 'collect');
  const store = await openWorkflowIntake(capability, selectionIdentity, 'collect');
  const authorize = async () => { await assertWorkflowStorage(capability, selectionIdentity, 'collect'); return true; };
  return withIntakeLock(store, async transaction => {
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
      const armed = await armRegistration(transaction, store, registration, intakeJSON(wakeSnapshot), authorize, observeRead, selection, grantHash);
      if (!armed.selection) return { saved: 0, pending: armed.pending };
      selection = armed.selection; boundaryExcluded = armed.boundaryExcluded;
    }
    // The native source cwd is distinct from the broader configured route root.
    // Keep the excluded initial boundary visible on later visits as well.
    boundaryExcluded ??= currentIntervals(selection.state)[0]?.lower.unitId ?? null;
    let saved = 0, pending = null, incomplete = false, drained = true, suspended = true;
    for (const scope of [...currentIntervals(selection.state), ...selection.state.explicitScopes]) {
      await authorize();
      const result = await processScope(transaction, store, selection, scope.id, authorize, observeRead);
      saved += result.saved; pending ??= result.pending; incomplete ||= Boolean(result.incomplete);
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
    return { saved, pending: pending ?? (selection.state.paused ? 'COLLECTION_PAUSED' : null), incomplete, boundaryExcluded };
  });
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
    // ongoing authority leaves explicit or foreign intent untouched for recovery.
    const value = intakeJSON(await intakeSnapshot(store, 'state', registrationPath(pending.identity), { maxBytes: 16384 }));
    if (value === null) fail('INTAKE_RECOVERY_REQUIRED');
    const registration = validateRegistration(value);
    if (registration.client !== pending.identity.client || registration.sessionId !== pending.identity.sessionId) fail('INTAKE_RECOVERY_REQUIRED');
    const route = await resolveWorkflowRoute(snapshot.config, registration);
    if (!route.intended?.collect || route.collection.id !== collectionId) fail('INTAKE_RECOVERY_REQUIRED');
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
      for (; count < maxJobs; count++) {
        let job;
        if (hinted && preferHint) { job = hinted; hinted = null; }
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
        if (seen.has(job.file)) continue;
        seen.add(job.file);
        output.lastRegistration = job.file;
        try {
          const registered = await intakeSnapshot(store, 'state', job.file, { maxBytes: 16384 });
          if (registered.bytes === null) {
            // A locator-only trigger can have no registration yet. A discovered
            // directory without its atomically published record is damaged.
            if (job.cursor !== null || await lstatOrNull(path.dirname(await intakePath(store, 'state', job.file)))) fail('INVALID_REGISTRATION');
            continue;
          }
          const registration = validateRegistration(intakeJSON(registered));
          if (registration.client !== job.client || registration.sessionId !== job.sessionId) fail('INVALID_REGISTRATION');
          const route = await resolveWorkflowRoute(snapshot.config, registration);
          if (!route.intended?.collect) continue;
          if (route.collection.id !== collectionId) continue;
          const grantHash = await collectionGrantHash(snapshot.config, route.route.id, registration);
          const result = await runRegistration(capability, registration, registered.hash, route, grantHash, observeRead);
          output.saved += result.saved;
          if (result.pending) {
            output.pending.push(result.pending);
            if (!passStopCodes.has(result.pending)) output.diagnostics.push({ client: job.client, sessionId: job.sessionId, code: result.pending });
          }
          if (result.boundaryExcluded) output.boundaryExcluded.push({ client: registration.client, sessionId: registration.sessionId, unitId: result.boundaryExcluded });
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
