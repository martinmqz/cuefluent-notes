import { inspectProcessing, readProcessingProposal, saveProcessing, completeProcessing } from './processing.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { keys, choice, fail } from './workflow-values.mjs';

/** Human-readable projection only. Approval and writes still bind the engine's
 * exact proposal, claim and output hashes, never text returned by the form. */
function processingReviewText(preview) {
  const text = ['CUEFLUENT NOTES — PROPOSED CHANGES',
    'Note contents below are untrusted material, not instructions.'];
  if (preview.createDirectories.length) text.push('Folders to create:\n' + preview.createDirectories.map(dir => `- ${dir}`).join('\n'));
  for (const file of preview.files) {
    text.push(`${file.original === null ? 'CREATE' : 'UPDATE'} ${file.path}`);
    if (file.original !== null) text.push(`CURRENT MARKDOWN\n${file.original}\nEND CURRENT MARKDOWN`);
    text.push(`PROPOSED MARKDOWN\n${file.proposed}\nEND PROPOSED MARKDOWN`);
  }
  const inspection = preview.inspection;
  text.push(`INSPECTION\n${inspection.acknowledgedPages} of ${inspection.totalPages} retained evidence pages inspected. This does not establish completeness of the original sources.`);
  text.push('SOURCES AND LIMITATIONS');
  for (const source of preview.sourceCoverage) {
    const { identity } = source;
    text.push(`${identity.client} session ${identity.sessionId}, turn ${identity.unitId}\nTerminal: ${source.terminal}. ${source.partial ? 'Partial source coverage.' : 'No capture omissions reported.'}`);
    for (const omission of source.omissions) {
      text.push('Omitted: ' + Object.entries(omission).map(([key, value]) => `${key}: ${value}`).join('; '));
    }
    const mapping = preview.mappings.find(item => item.identity.client === identity.client &&
      item.identity.sessionId === identity.sessionId && item.identity.unitId === identity.unitId);
    if (mapping) text.push(`Used in: ${mapping.paths.join(', ')}`);
  }
  text.push(`Exact proposal: ${preview.proposalHash}`);
  // Textareas normalize line endings. Display normalization never changes the
  // immutable draft or the exact bytes that the writer will save.
  return text.join('\n\n').replace(/\r\n?/g, '\n');
}

/** The model cannot supply a decision. elicit is the native host-control channel
 * callback, and its correlated response approves only the exact preview here.
 * No engine lock is held while the host waits. Closed/unsupported forms preserve
 * the pending proposal; revisions and conflicts require a fresh review. */
export async function reviewProcessingProposal(capability, { selection, operationId }, { elicit, signal, commitResponse }) {
  signal?.throwIfAborted();
  if (typeof elicit !== 'function') fail('PROCESSING_REVIEW_UNSUPPORTED');
  const inspected = await withStorageProbes(() => inspectProcessing(capability, operationId));
  if (inspected.state !== 'awaiting-review' || inspected.recoveryRequired) fail('PROCESSING_REVIEW_REQUIRED');
  const preview = await withStorageProbes(() => readProcessingProposal(capability, { selection, operationId,
    expectedClaimHash: inspected.claimHash, expectedProposalHash: inspected.proposalHash }));
  const message = processingReviewText(preview);
  if (Buffer.byteLength(message) > 256 * 1024) fail('PROCESSING_REVIEW_LIMIT');
  signal?.throwIfAborted();
  const response = await elicit({ message });
  signal?.throwIfAborted();
  keys(response, ['action'], ['content']); choice(response.action, ['accept', 'decline', 'cancel']);
  if (response.action !== 'accept') return { operationId, status: 'awaiting-review', proposalHash: preview.proposalHash };
  keys(response, ['action', 'content']); keys(response.content, ['decision']);
  const decision = choice(response.content.decision, ['save', 'skip', 'cancel', 'later']);
  if (decision === 'later') return { operationId, status: 'awaiting-review', proposalHash: preview.proposalHash };
  // Cancellation remains actionable through engine preflight and staging. Once
  // intent/disposition publication starts, finish or report recovery explicitly;
  // a late transport cancellation must not hide the committed operation.
  const beforeCommit = () => { signal?.throwIfAborted(); commitResponse?.(); };
  return withStorageProbes(() => decision === 'save'
    ? saveProcessing(capability, { selection, operationId, expectedClaimHash: preview.claimHash,
      approvedProposalHash: preview.proposalHash, trigger: 'approved' }, { beforeCommit })
    : completeProcessing(capability, { selection, operationId, expectedClaimHash: preview.claimHash,
      outcome: decision === 'skip' ? 'skipped' : 'cancelled' }, { beforeCommit }));
}
