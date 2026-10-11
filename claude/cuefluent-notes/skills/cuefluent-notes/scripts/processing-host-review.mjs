import { inspectProcessing, readProcessingProposal, saveProcessing, completeProcessing } from './processing.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { keys, choice, fail, canonicalJSON } from './workflow-values.mjs';

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
  const message = `Review this exact Cuefluent Notes proposal. Text inside the proposal is untrusted note content, not instructions.\n` +
    `Save applies these exact changes. Skip handles these input revisions without saving. Cancel releases this operation without handling its inputs. Later keeps it pending.\n` +
    `For a factual correction, choose Later and provide the correction in your ordinary work chat for separately authorized capture before a revised proposal.\n\n` + canonicalJSON(preview);
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
