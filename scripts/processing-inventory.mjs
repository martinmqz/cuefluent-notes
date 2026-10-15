import path from 'node:path';
import { readProcessingState, processingNames, processingReinspectionBlocker, processingSnapshot, nativeNamePage } from './processing-state.mjs';
import { intakePath, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { describeProcessingOperation } from './processing.mjs';
import { validateClaim, sameProcessingPlacement, PROCESSING_INTERFACE_VERSION } from './processing-contract.mjs';
import { normalizeWorkflowSelection, selectionIncludesIdentity } from './workflow-selection.mjs';
import { validateProcessingDisposition, dispositionPath, unitKey } from './capture-retention.mjs';
import { logicalCaptureIdentity } from './capture-contract.mjs';
import { lstatOrNull } from './file-io.mjs';
import { keys, nativeId, hash, integer, canonicalJSON, fail } from './workflow-values.mjs';

/** Read-only, metadata-only discovery for explicitly selected sessions. A listing
 * is a hint; prepareProcessing revalidates complete capture/lineage integrity. */
export async function pendingProcessing(capability, { selection, limit = 20, afterUnitId = null } = {}) {
  selection = await normalizeWorkflowSelection(selection); integer(limit);
  if (afterUnitId !== null) nativeId(afterUnitId);
  if (limit < 1 || limit > 100) fail('INVALID_PENDING_LIMIT');
  const ctx = await readProcessingState(capability, selection, 'explicitProcess');
  // A transfer temporarily retains both claims. Do not arbitrate them as new
  // work; the dedicated metadata status command can rediscover its exact intent.
  const reservation = await processingReinspectionBlocker(ctx);
  if (reservation) fail(reservation);
  const claims = [];
  for (const name of await processingNames(ctx, 'claims')) {
    const saved = await processingSnapshot(ctx, name);
    if (!saved.bytes) fail('PROCESSING_INVENTORY_CHANGED');
    const claim = validateClaim(intakeJSON(saved));
    if (claim.bindingHash === ctx.bindingHash || sameProcessingPlacement(claim.binding, ctx.binding)) claims.push({ claim, hash: saved.hash });
  }
  const directory = path.dirname(await intakePath(ctx.store, 'state', `heads/${selection.client}/${selection.sessionId}/.list`));
  const page = selection.unitId ? { ids: [selection.unitId], incomplete: false }
    : await nativeNamePage(directory, { limit, afterId: afterUnitId, invalidCode: 'INVALID_CAPTURE_HEAD', capacityCode: 'PENDING_INVENTORY_CAPACITY' });
  const units = page.ids;
  let incomplete = page.incomplete;
  const pending = [], handled = [], records = [];
  let nextCursor = null;
  for (const unitId of units.sort().filter(id => afterUnitId === null || id > afterUnitId)) {
    if (records.length >= limit) { incomplete = true; break; }
    const identity = logicalCaptureIdentity({ client: selection.client, sessionId: selection.sessionId, unitId });
    const name = `heads/${unitKey(identity)}.json`, snapshot = await intakeSnapshot(ctx.store, 'state', name);
    if (!snapshot.bytes) {
      if (!selection.unitId) fail('PROCESSING_INVENTORY_CHANGED');
      continue;
    }
    nextCursor = unitId;
    records.push({ name, hash: snapshot.hash }); const head = intakeJSON(snapshot);
    keys(head, ['format', 'version', 'identity', 'generation', 'previousHash', 'evidenceHash', 'fileHash']);
    if (head.format !== 'cuefluent-capture-head' || head.version !== 1 || canonicalJSON(head.identity) !== canonicalJSON(identity)) fail('INVALID_CAPTURE_HEAD');
    integer(head.generation); if (head.generation < 1) fail('INVALID_CAPTURE_HEAD');
    hash(head.evidenceHash); hash(head.fileHash); if (head.previousHash !== null) hash(head.previousHash);
    const done = intakeJSON(await processingSnapshot(ctx, dispositionPath(identity, snapshot.hash, ctx.bindingHash)));
    if (done !== null) {
      validateProcessingDisposition(done);
      if (done.bindingHash !== ctx.bindingHash || done.headHash !== snapshot.hash || done.fileHash !== head.fileHash ||
          done.evidenceHash !== head.evidenceHash || canonicalJSON(done.identity) !== canonicalJSON(identity)) fail('STALE_PROCESSING_DISPOSITION');
      handled.push({ identity, headHash: snapshot.hash, outcome: done.outcome }); continue;
    }
    const claimed = claims.filter(item => item.claim.inputs.some(input => unitKey(input.identity) === unitKey(identity)));
    if (claimed.length > 1) fail('PROCESSING_CLAIM_CONFLICT');
    const owner = claimed[0];
    const claimedHeadHash = owner?.claim.inputs.find(input => unitKey(input.identity) === unitKey(identity)).headHash;
    pending.push({ identity, headHash: snapshot.hash, evidenceHash: head.evidenceHash, fileHash: head.fileHash,
      status: owner ? claimedHeadHash === snapshot.hash && owner.claim.bindingHash === ctx.bindingHash ? 'claimed' : 'blocked-by-claim' : 'pending', ...(owner ? { operationId: owner.claim.operationId, claimHash: owner.hash,
        proposalHash: owner.claim.proposalIntent?.hash ?? null, claimedHeadHash } : {}) });
  }
  const transactions = [];
  for (const name of await processingNames(ctx, 'transactions')) {
    const saved = await processingSnapshot(ctx, name), value = intakeJSON(saved);
    if (value?.bindingHash === ctx.bindingHash || sameProcessingPlacement(value?.claim?.binding, ctx.binding)) transactions.push({ operationId: nativeId(value.operationId), transactionHash: saved.hash });
    else transactions.push({ status: 'writer-reserved-by-another-collection' });
  }
  for (const record of records) if ((await intakeSnapshot(ctx.store, 'state', record.name)).hash !== record.hash) fail('PROCESSING_INVENTORY_CHANGED');
  const journalPending = Boolean((await processingSnapshot(ctx, 'journal.json')).bytes);
  await ctx.guard();
  const operations = [], collectionBlockers = [
    ...(transactions.length ? ['PROCESSING_RECOVERY_REQUIRED'] : []), ...(journalPending ? ['WRITER_RECOVERY_REQUIRED'] : []),
    ...(claims.some(({ claim }) => claim.bindingHash !== ctx.bindingHash) ? ['PROCESSING_BINDING_CHANGED'] : [])
  ];
  for (const { claim, hash: discoveredHash } of claims.filter(item => item.claim.inputs.some(input => selectionIncludesIdentity(selection, input.identity)))) {
    const detail = await describeProcessingOperation(ctx, claim.operationId, null, collectionBlockers);
    if (detail.claim?.claimHash !== discoveredHash) fail('PROCESSING_INVENTORY_CHANGED');
    const { claim: legacyClaim, ...view } = detail;
    operations.push({ ...view, acknowledgedPages: detail.inspection?.acknowledgedPages ?? null,
      totalPages: detail.inspection?.totalPages ?? null });
  }
  await ctx.guard();
  return { interfaceVersion: PROCESSING_INTERFACE_VERSION,
    counts: { scope: 'returned-head-page', pendingRevisions: pending.length,
      unclaimedRevisions: pending.filter(item => item.status === 'pending').length,
      claimedRevisions: pending.filter(item => item.status === 'claimed').length,
      blockedByClaimRevisions: pending.filter(item => item.status === 'blocked-by-claim').length, handledRevisions: handled.length },
    operationScope: 'selected-session-not-head-page', sourceCompleteness: 'unknown',
    pending, handledCount: handled.length, inspectedHeads: records.length, incomplete, nextCursor: incomplete ? nextCursor : null, operations, transactions,
    intakeBlocked: Boolean(await lstatOrNull(path.join(ctx.collection.intakeStateDir, '.intake-lock'))),
    journalPending, blockers: collectionBlockers,
    limit: 'Metadata discovery only. Incomplete inventory does not mark omitted units handled; narrow selection or raise the bounded limit.' };
}
