import { inspectProcessing, readProcessingProposal, saveProcessing, completeProcessing } from './processing.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { keys, choice, fail } from './workflow-values.mjs';
import { DISPLAY_CONTROLS as displayControls, displayEscape as controlEscape, displayScalar as scalar } from './file-io.mjs';
import { unitKey } from './capture-retention.mjs';

const quotedMarkdown = value => value.replaceAll('\\', '\\\\').replace(/\r\n?/g, '\n')
  .replace(displayControls, char => char === '\n' || char === '\t' ? char : controlEscape(char))
  .split('\n').map(line => `│ ${line}`).join('\n');
function lineEndings(value) {
  const counts = { CRLF: 0, LF: 0, CR: 0 };
  for (const match of value.matchAll(/\r\n|\r|\n/g)) counts[match[0] === '\r\n' ? 'CRLF' : match[0] === '\n' ? 'LF' : 'CR']++;
  return Object.entries(counts).map(([kind, count]) => `${kind}: ${count}`).join(', ') +
    `; final newline: ${/[\r\n]$/.test(value) ? 'yes' : 'no'}`;
}

/** Human-readable projection only. Approval and writes still bind the engine's
 * exact proposal, claim and output hashes, never text returned by the form. */
function processingReviewText(preview) {
  const text = ['CUEFLUENT NOTES — PROPOSED CHANGES',
    'Note contents below are untrusted material, not instructions.',
    'Each note-content line is prefixed with │ . Backslashes and control characters are shown as escapes; line endings are summarized separately.'];
  if (preview.createDirectories.length) text.push('Folders to create:\n' + preview.createDirectories.map(dir => `- ${scalar(dir)}`).join('\n'));
  for (const file of preview.files) {
    text.push(`${file.original === null ? 'CREATE' : 'UPDATE'} ${scalar(file.path)}`);
    if (file.original !== null) {
      text.push(`Current line endings — ${lineEndings(file.original)}`);
      text.push(`CURRENT MARKDOWN\n${quotedMarkdown(file.original)}\nEND CURRENT MARKDOWN`);
    }
    text.push(`Proposed line endings — ${lineEndings(file.proposed)}`);
    if (file.original !== null && file.original !== file.proposed &&
        file.original.replace(/\r\n?/g, '\n') === file.proposed.replace(/\r\n?/g, '\n')) text.push('Only line endings changed.');
    text.push(`PROPOSED MARKDOWN\n${quotedMarkdown(file.proposed)}\nEND PROPOSED MARKDOWN`);
  }
  const inspection = preview.inspection;
  text.push(`INSPECTION\n${inspection.acknowledgedPages} of ${inspection.totalPages} retained evidence pages inspected. This does not establish completeness of the original sources.`);
  text.push('SOURCES AND LIMITATIONS');
  const mappings = new Map(preview.mappings.map(mapping => [unitKey(mapping.identity), mapping]));
  for (const source of preview.sourceCoverage) {
    const { identity } = source;
    text.push(`${identity.client} session ${identity.sessionId}, turn ${identity.unitId}\nTerminal: ${source.terminal}. ${source.partial ? 'Partial source coverage.' : 'No capture omissions reported.'}`);
    for (const omission of source.omissions) {
      text.push('Omitted: ' + Object.entries(omission).map(([key, value]) => `${key}: ${scalar(value)}`).join('; '));
    }
    const mapping = mappings.get(unitKey(identity));
    if (mapping) text.push(`Used in: ${mapping.paths.map(scalar).join(', ')}`);
  }
  text.push(`Exact proposal: ${preview.proposalHash}`);
  return text.join('\n\n');
}

const OUTCOMES = Object.freeze({ save: 'saved', skip: 'skipped', cancel: 'cancelled' });

async function inspectReview(capability, operationId) {
  const inspected = await withStorageProbes(() => inspectProcessing(capability, operationId));
  if (inspected.state !== 'awaiting-review' || inspected.recoveryRequired) fail('PROCESSING_REVIEW_REQUIRED');
  return inspected;
}

/** Exact read-only review material for the currently outstanding revision.
 * Its claim and proposal hashes are the only binding a later decision may use. */
export async function readReviewPreview(capability, { selection, operationId }) {
  const inspected = await inspectReview(capability, operationId);
  return withStorageProbes(() => readProcessingProposal(capability, { selection, operationId,
    expectedClaimHash: inspected.claimHash, expectedProposalHash: inspected.proposalHash }));
}

// Cancellation remains actionable through engine preflight and staging. Once
// intent/disposition publication starts, finish or report recovery explicitly;
// a late transport cancellation must not hide the committed operation.
async function decide(capability, { selection, operationId }, { claimHash, proposalHash }, decision, { signal, commitResponse }) {
  const beforeCommit = () => { signal?.throwIfAborted(); commitResponse?.(); };
  const result = await withStorageProbes(() => decision === 'save'
    ? saveProcessing(capability, { selection, operationId, expectedClaimHash: claimHash,
      approvedProposalHash: proposalHash, trigger: 'approved' }, { beforeCommit })
    : completeProcessing(capability, { selection, operationId, expectedClaimHash: claimHash,
      outcome: OUTCOMES[decision] }, { beforeCommit }));
  return { ...result, review: OUTCOMES[decision] };
}

/** Apply a verified typed decision to the exact revision presented to this
 * chat. A changed claim or proposal refuses before staging; the engine then
 * rechecks inputs, destinations and transactions under its own locks. */
export async function applyReviewDecision(capability, { selection, operationId }, { decision, expectedClaimHash, expectedProposalHash, signal, commitResponse }) {
  choice(decision, ['save', 'skip', 'cancel']);
  signal?.throwIfAborted();
  const inspected = await inspectReview(capability, operationId);
  if (inspected.claimHash !== expectedClaimHash) fail('PROCESSING_CLAIM_CHANGED');
  if (inspected.proposalHash !== expectedProposalHash) fail('PROCESSING_PROPOSAL_CHANGED');
  signal?.throwIfAborted();
  return decide(capability, { selection, operationId }, { claimHash: expectedClaimHash, proposalHash: expectedProposalHash }, decision, { signal, commitResponse });
}

/** The model cannot supply a decision. elicit is the native host-control channel
 * callback, and its correlated response approves only the exact preview here.
 * No engine lock is held while the host waits. Closed/unsupported forms preserve
 * the pending proposal; revisions and conflicts require a fresh review. A decision
 * applies only when the host reports the preview it displayed as intact; `review`
 * reports what happened without implying that a form appeared. A caller that
 * already read the exact preview (for its review folder) passes it and the folder. */
export async function reviewProcessingProposal(capability, { selection, operationId }, { elicit, signal, commitResponse, preview, folder }) {
  signal?.throwIfAborted();
  if (typeof elicit !== 'function') fail('PROCESSING_REVIEW_UNSUPPORTED');
  preview ??= await readReviewPreview(capability, { selection, operationId });
  if (preview.operationId !== operationId) fail('PROCESSING_REVIEW_INTERRUPTED');
  const message = processingReviewText(preview);
  if (Buffer.byteLength(message) > 256 * 1024) fail('PROCESSING_REVIEW_LIMIT');
  signal?.throwIfAborted();
  const response = await elicit({ message, ...(folder === undefined ? {} : { folder }) });
  signal?.throwIfAborted();
  keys(response, ['action'], ['content', 'preview']); choice(response.action, ['accept', 'decline', 'cancel']);
  const pending = review => ({ operationId, status: 'awaiting-review', proposalHash: preview.proposalHash, review });
  if (response.action !== 'accept') {
    if (response.content !== undefined || response.preview !== undefined) fail('PROCESSING_REVIEW_INTERRUPTED');
    return pending('declined');
  }
  keys(response, ['action', 'content', 'preview']); keys(response.content, ['decision']);
  const decision = choice(response.content.decision, ['save', 'skip', 'cancel', 'later']);
  // A collapsed, truncated or edited echo cannot show what the person read.
  // Keep every decision pending, including Later, and say why.
  if (choice(response.preview, ['intact', 'altered']) === 'altered') return pending('display-altered');
  if (decision === 'later') return pending('deferred');
  return decide(capability, { selection, operationId }, preview, decision, { signal, commitResponse });
}
