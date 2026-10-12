import { inspectProcessing, readProcessingProposal, saveProcessing, completeProcessing } from './processing.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { keys, choice, fail } from './workflow-values.mjs';
import { CONTROLS } from './file-io.mjs';
import { unitKey } from './capture-retention.mjs';

// Also escape Unicode line separators and directional overrides so untrusted
// text cannot add structural lines or rearrange the review's labels.
const displayControls = new RegExp(`${CONTROLS.source}|[\u2028\u2029\u202a-\u202e\u2066-\u2069]`, 'g');
const controlEscape = char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
const scalar = value => JSON.stringify(value).replace(displayControls, controlEscape);
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
