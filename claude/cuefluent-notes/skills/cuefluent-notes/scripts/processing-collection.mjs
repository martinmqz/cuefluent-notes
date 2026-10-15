import path from 'node:path';
import { PROCESSING_REINSPECTION_FILE } from './writer-protocol.mjs';
import { lstatOrNull } from './file-io.mjs';
import { inside } from './workflow-paths.mjs';
import { assertWorkflowStorage } from './workflow-storage.mjs';
import { normalizeWorkflowSelection, selectionIncludesIdentity } from './workflow-selection.mjs';
import { readSelection, readCaptureHead } from './intake-store.mjs';
import { intakePath, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { readProcessingState, nativeNamePage, processingNames, processingSnapshot, processingReinspectionBlocker } from './processing-state.mjs';
import { activeProcessingClaims, describeProcessingOperation } from './processing.mjs';
import { pendingProcessing } from './processing-inventory.mjs';
import { PROCESSING_INTERFACE_VERSION, claimPath, sameProcessingPlacement } from './processing-contract.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { CLIENTS, PROCESSING_SCOPES, validateProcessingCursor, choice, nativeId, hash, integer, canonicalJSON, digest, fail } from './workflow-values.mjs';

/** Resolve repository narrowing from a real Git marker, never from a guessed
 * route basename. This is metadata only; Git configuration is not executed. */
export async function processingScope(selection, kind = 'collection') {
  choice(kind, PROCESSING_SCOPES);
  selection = await normalizeWorkflowSelection(selection);
  if (kind === 'collection') return { kind };
  if (kind === 'chat') return { kind, client: selection.client, sessionId: selection.sessionId, unitId: selection.unitId };
  let current = selection.cwd;
  for (let depth = 0; depth < 64; depth++) {
    checkWorkflowBudget();
    const marker = await lstatOrNull(path.join(current, '.git'));
    if (marker) {
      if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) fail('PROCESSING_REPOSITORY_UNVERIFIED');
      return { kind, root: current };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail('PROCESSING_REPOSITORY_UNVERIFIED');
}

async function recoverySnapshot(ctx) {
  const transactions = [];
  for (const name of await processingNames(ctx, 'transactions')) {
    const saved = await processingSnapshot(ctx, name);
    if (!saved.bytes) fail('PROCESSING_INVENTORY_CHANGED');
    const value = intakeJSON(saved);
    hash(value?.bindingHash);
    transactions.push({ name, hash: saved.hash, operationId: value.bindingHash === ctx.bindingHash || sameProcessingPlacement(value?.claim?.binding, ctx.binding) ? nativeId(value.operationId) : null });
  }
  const journal = await processingSnapshot(ctx, 'journal.json');
  const reinspection = await processingSnapshot(ctx, PROCESSING_REINSPECTION_FILE);
  const pending = await intakeSnapshot(ctx.store, 'state', 'pending.json');
  const prune = await intakeSnapshot(ctx.store, 'state', 'prune-pending.json');
  return { transactions, journalHash: journal.hash, reinspectionHash: reinspection.hash, pendingHash: pending.hash, pruneHash: prune.hash,
    blockers: [...(reinspection.bytes ? [await processingReinspectionBlocker(ctx, reinspection)] : []), ...(transactions.length ? ['PROCESSING_RECOVERY_REQUIRED'] : []),
      ...(journal.bytes ? ['WRITER_RECOVERY_REQUIRED'] : []), ...(intakeJSON(pending) !== null ? ['INTAKE_RECOVERY_REQUIRED'] : []),
      ...(intakeJSON(prune) !== null ? ['PRUNE_RECOVERY_REQUIRED'] : [])] };
}

/** Inventory only retained, already-selected sources. No model, native history,
 * evidence body, settings mutation, claim or writer mutation is involved. */
export async function pendingCollectionProcessing(capability, { selection, scope = 'collection', limit = 100, maxSessions = 32, after = null } = {}) {
  selection = await normalizeWorkflowSelection(selection);
  integer(limit); integer(maxSessions);
  if (limit < 1 || limit > 100 || maxSessions < 1 || maxSessions > 128) fail('INVALID_PENDING_LIMIT');
  const ctx = await readProcessingState(capability, selection, 'explicitProcess');
  const selectedScope = await processingScope(selection, scope);
  const scopeHash = digest(canonicalJSON({ scope: selectedScope, bindingHash: ctx.bindingHash, policyHash: ctx.policyHash }));
  if (after !== null) {
    validateProcessingCursor(after);
    if (after.scopeHash !== scopeHash) fail('PROCESSING_INVENTORY_CURSOR_MISMATCH');
  }
  const sources = new Map(), repositories = new Map();
  async function repositoryRoot(selected) {
    if (!repositories.has(selected.cwd)) {
      let root = null;
      try { root = (await processingScope(selected, 'repo')).root; }
      catch (error) { if (error.code !== 'PROCESSING_REPOSITORY_UNVERIFIED') throw error; }
      repositories.set(selected.cwd, { selected, root });
    }
    return repositories.get(selected.cwd).root;
  }
  async function matches(selected) {
    if (selectedScope.kind === 'collection') return true;
    if (selectedScope.kind === 'chat') return selectedScope.client === selected.client && selectedScope.sessionId === selected.sessionId;
    return inside(selectedScope.root, selected.cwd) && await repositoryRoot(selected) === selectedScope.root;
  }
  async function source(identity) {
    const key = `${identity.client}/${identity.sessionId}`;
    if (sources.has(key)) return sources.get(key);
    if (sources.size >= 256) fail('PROCESSING_INVENTORY_CAPACITY');
    const saved = await readSelection(ctx.store, identity);
    const sourceIdentity = { client: identity.client, sessionId: identity.sessionId };
    if (!saved.state) {
      // Retained writer claims can outlive their intake selections. Absence is
      // not source authorization; keep it in the snapshot for the final recheck.
      if (saved.hash !== null) fail('PROCESSING_SOURCE_SELECTION_MISSING');
      const result = { identity: sourceIdentity, selected: null, hash: null, authorized: false };
      sources.set(key, result); return result;
    }
    const selected = await normalizeWorkflowSelection({ client: identity.client, sessionId: identity.sessionId,
      cwd: saved.state.source.projectRoot });
    let authorized = true;
    try { await assertWorkflowStorage(capability, selected, 'explicitProcess'); }
    catch (error) { if (error.code !== 'WORKFLOW_NOT_AUTHORIZED') throw error; authorized = false; }
    const result = { identity: sourceIdentity, selected, hash: saved.hash, authorized };
    sources.set(key, result); return result;
  }
  const recovery = await recoverySnapshot(ctx), blockers = [...recovery.blockers], operations = [];
  const claimNames = await processingNames(ctx, 'claims');
  const claims = await activeProcessingClaims(ctx, { allowBindingConflict: true });
  if (claims.some(item => item.bindingChanged)) blockers.push('PROCESSING_BINDING_CHANGED');
  const operationIds = new Set(claims.map(({ claim }) => claim.operationId));
  for (const tx of recovery.transactions) if (tx.operationId !== null) operationIds.add(tx.operationId);
  for (const operationId of operationIds) {
    const { claim: _claim, ...operation } = await describeProcessingOperation(ctx, operationId, null, blockers);
    const membership = [];
    let missingSelection = false;
    for (const input of operation.inputs) {
      const saved = await source(input.identity);
      if (!saved.selected) missingSelection = true;
      membership.push(saved.authorized && await matches(saved.selected) &&
        (selectedScope.kind !== 'chat' || selectionIncludesIdentity(selectedScope, input.identity)));
    }
    if (missingSelection && !operation.outcome) {
      const previousConflict = operation.conflict;
      operation.conflict ??= 'PROCESSING_SOURCE_SELECTION_MISSING';
      operation.blockers.push('PROCESSING_SOURCE_SELECTION_MISSING');
      // Preserve existing cancellation/recovery guidance, but never offer an
      // otherwise healthy draft or inspection as authorized without its source.
      if (!operation.recoveryRequired && operation.state !== 'blocked') {
        operation.state = 'conflicted';
        if (!previousConflict) operation.nextAction = { command: null, reason: 'resolve-conflict' };
      }
    }
    operations.push({ ...operation, scopeMatch: membership.every(Boolean) ? 'full' : membership.some(Boolean) ? 'partial' : 'outside' });
  }
  const pending = []; let inspectedHeads = 0, handledRevisions = 0, visitedSessions = 0, excludedSources = 0, outsideScopeSources = 0;
  let incomplete = recovery.reinspectionHash !== null, cursor = after;
  const clients = incomplete ? [] : [...CLIENTS].sort();
  outer: for (const client of clients) {
    if (after && client < after.client) continue;
    if (scope === 'chat' && client !== selection.client) continue;
    const parent = path.dirname(await intakePath(ctx.store, 'state', `sessions/${client}/.list`));
    const previous = after?.client === client ? after : null;
    const page = scope === 'chat' ? { ids: [selection.sessionId], incomplete: false }
      : await nativeNamePage(parent, { limit: maxSessions + 1, afterId: previous?.sessionId ?? null,
        invalidCode: 'INVALID_CAPTURE_SELECTION', capacityCode: 'PROCESSING_INVENTORY_CAPACITY' });
    if (scope !== 'chat' && previous && previous.unitId !== null) page.ids.unshift(previous.sessionId);
    for (const sessionId of page.ids) {
      if (previous && (sessionId < previous.sessionId || (sessionId === previous.sessionId && previous.unitId === null))) continue;
      if (visitedSessions >= maxSessions || inspectedHeads >= limit) { incomplete = true; break outer; }
      visitedSessions++;
      // A new source chat can have no retained selection yet. Collection scans
      // enumerate existing session metadata and must not silently lose an entry.
      if (scope === 'chat' && (await readSelection(ctx.store, { client, sessionId })).state === null) continue;
      const saved = await source({ client, sessionId });
      if (!saved.selected) fail('PROCESSING_INVENTORY_CHANGED');
      if (!saved.authorized || !await matches(saved.selected)) {
        if (!saved.authorized) excludedSources++; else outsideScopeSources++;
        cursor = { scopeHash, client, sessionId, unitId: null }; continue;
      }
      const result = await pendingProcessing(capability, { selection: { ...saved.selected, unitId: scope === 'chat' ? selection.unitId : null },
        limit: limit - inspectedHeads, afterUnitId: previous?.sessionId === sessionId ? previous.unitId : null });
      pending.push(...result.pending); inspectedHeads += result.inspectedHeads; handledRevisions += result.handledCount;
      cursor = { scopeHash, client, sessionId, unitId: result.nextCursor };
      if (result.incomplete) { incomplete = true; break outer; }
    }
    if (page.incomplete) { incomplete = true; break; }
  }
  for (const saved of sources.values()) {
    const { client, sessionId } = saved.identity;
    if ((await readSelection(ctx.store, { client, sessionId })).hash !== saved.hash) fail('PROCESSING_INVENTORY_CHANGED');
    if (saved.authorized) await assertWorkflowStorage(capability, saved.selected, 'explicitProcess');
  }
  if (canonicalJSON(await recoverySnapshot(ctx)) !== canonicalJSON(recovery)) fail('PROCESSING_INVENTORY_CHANGED');
  if (selectedScope.kind === 'repo') {
    if (!inside(selectedScope.root, selection.cwd) || (await processingScope(selection, 'repo')).root !== selectedScope.root) fail('PROCESSING_INVENTORY_CHANGED');
    for (const { selected, root } of repositories.values()) {
      let fresh = null;
      try { fresh = (await processingScope(selected, 'repo')).root; }
      catch (error) { if (error.code !== 'PROCESSING_REPOSITORY_UNVERIFIED') throw error; }
      if (fresh !== root) fail('PROCESSING_INVENTORY_CHANGED');
    }
  }
  if (canonicalJSON(await processingNames(ctx, 'claims')) !== canonicalJSON(claimNames)) fail('PROCESSING_INVENTORY_CHANGED');
  for (const operation of operations) if ((await processingSnapshot(ctx, claimPath(operation.operationId))).hash !== operation.claimHash) fail('PROCESSING_INVENTORY_CHANGED');
  for (const input of pending) if ((await readCaptureHead(ctx.store, input.identity, { metadataOnly: true })).hash !== input.headHash) fail('PROCESSING_INVENTORY_CHANGED');
  // Lock presence is an observation, not recovery state or read authority.
  // Mutations still acquire the intake lock and revalidate exact inputs.
  const intakeBlocked = Boolean(await lstatOrNull(path.join(ctx.collection.intakeStateDir, '.intake-lock')));
  await ctx.guard();
  return { interfaceVersion: PROCESSING_INTERFACE_VERSION, scope: selectedScope, scopeHash,
    pending, operations, blockers, intakeBlocked, incomplete, nextCursor: incomplete ? cursor : null,
    counts: { scope: 'returned-head-page', pendingRevisions: pending.length,
      unclaimedRevisions: pending.filter(item => item.status === 'pending').length,
      claimedRevisions: pending.filter(item => item.status === 'claimed').length,
      blockedByClaimRevisions: pending.filter(item => item.status === 'blocked-by-claim').length,
      handledRevisions, inspectedHeads, visitedSessions, excludedSources, outsideScopeSources }, sourceCompleteness: 'unknown',
    limitation: 'Metadata pages are not an atomic queue snapshot. Preparation revalidates each exact input; incomplete discovery is not an empty backlog.' };
}

/** Retry only a changed read snapshot, never a mutation or recovery blocker. */
export async function stablePendingCollectionProcessing(capability, args) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await pendingCollectionProcessing(capability, args); }
    catch (error) { if (error.code !== 'PROCESSING_INVENTORY_CHANGED' || attempt) throw error; }
  }
}
