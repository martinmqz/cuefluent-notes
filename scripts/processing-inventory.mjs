import fs from 'node:fs/promises';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import path from 'node:path';
import { readProcessingState, processingNames, processingSnapshot } from './processing-state.mjs';
import { intakePath, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { validateClaim } from './processing-contract.mjs';
import { normalizeWorkflowSelection } from './workflow-selection.mjs';
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
  const claims = [];
  for (const name of await processingNames(ctx, 'claims')) {
    const saved = await processingSnapshot(ctx, name), claim = validateClaim(intakeJSON(saved));
    if (claim.bindingHash === ctx.bindingHash) claims.push({ claim, hash: saved.hash });
  }
  const units = [], directory = path.dirname(await intakePath(ctx.store, 'state', `heads/${selection.client}/${selection.sessionId}/.list`));
  let incomplete = false;
  if (selection.unitId) units.push(selection.unitId);
  else if (await lstatOrNull(directory)) {
    let scanned = 0;
    for await (const entry of await fs.opendir(directory)) {
      checkWorkflowBudget();
      if (++scanned > 65536) fail('PENDING_INVENTORY_CAPACITY');
      if (!entry.isFile() || !entry.name.endsWith('.json')) fail('INVALID_CAPTURE_HEAD');
      const unitId = nativeId(entry.name.slice(0, -5));
      if (afterUnitId !== null && unitId <= afterUnitId) continue;
      // Scan the complete bounded directory, retaining only the lexical page
      // and one lookahead. Filesystem enumeration order is not a cursor.
      units.push(unitId); units.sort();
      if (units.length > limit + 1) units.pop();
    }
  }
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
    pending.push({ identity, headHash: snapshot.hash, evidenceHash: head.evidenceHash, fileHash: head.fileHash,
      status: owner ? 'claimed' : 'pending', ...(owner ? { operationId: owner.claim.operationId, claimHash: owner.hash,
        proposalHash: owner.claim.proposalIntent?.hash ?? null, claimedHeadHash: owner.claim.inputs.find(input => unitKey(input.identity) === unitKey(identity)).headHash } : {}) });
  }
  const transactions = [];
  for (const name of await processingNames(ctx, 'transactions')) {
    const saved = await processingSnapshot(ctx, name), value = intakeJSON(saved);
    if (value?.bindingHash === ctx.bindingHash) transactions.push({ operationId: nativeId(value.operationId), transactionHash: saved.hash });
    else transactions.push({ status: 'writer-reserved-by-another-collection' });
  }
  for (const record of records) if ((await intakeSnapshot(ctx.store, 'state', record.name)).hash !== record.hash) fail('PROCESSING_INVENTORY_CHANGED');
  const journalPending = Boolean((await processingSnapshot(ctx, 'journal.json')).bytes);
  await ctx.guard();
  const operations = claims.filter(item => item.claim.inputs.some(input => input.identity.client === selection.client &&
    input.identity.sessionId === selection.sessionId && (!selection.unitId || input.identity.unitId === selection.unitId)))
    .map(({ claim, hash }) => ({ operationId: claim.operationId, claimHash: hash, proposalHash: claim.proposalIntent?.hash ?? null,
      acknowledgedPages: claim.acknowledged.length, totalPages: claim.packet.pages.length }));
  return { pending, handledCount: handled.length, inspectedHeads: records.length, incomplete, nextCursor: incomplete ? nextCursor : null, operations, transactions,
    intakeBlocked: Boolean(await lstatOrNull(path.join(ctx.collection.intakeStateDir, '.intake-lock'))),
    journalPending,
    limit: 'Metadata discovery only. Incomplete inventory does not mark omitted units handled; narrow selection or raise the bounded limit.' };
}
