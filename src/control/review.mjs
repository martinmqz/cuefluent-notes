import { fail } from '../core/errors.mjs';
import { runRevision } from '../core/run.mjs';
import { withProject } from '../storage/store.mjs';
import { ownDirectAttempt, launchOwnedAttempt } from '../storage/attempts.mjs';
import { reviewNoteContent } from '../notes/validate.mjs';
import { readPrivateDraft } from '../processing/save.mjs';
import { runProcessingWork } from '../processing/worker.mjs';
import { readRunSnapshot } from './status.mjs';

/** One review page stays well inside the 256 KiB control projection so the
 * presenter can still append bounded warning details. */
export const REVIEW_PAGE_BYTES = 192 * 1024;
const HASH = /^[a-f0-9]{64}$/;
/** The same wording on every client. Queued input is preserved by skip until a
 * consuming discard is specified for it. */
export const DECISION_CHOICES = Object.freeze({
  direct: Object.freeze(['Save', 'Discard', 'Keep pending']),
  queued: Object.freeze(['Save', 'Skip draft; keep input', 'Keep pending']),
});
const choicesFor = run => DECISION_CHOICES[run.scope.kind === 'direct' ? 'direct' : 'queued'];
const continuation = (bytes, at) => at < bytes.length && (bytes[at] & 0xc0) === 0x80;
const serialized = value => Buffer.byteLength(JSON.stringify(value));

export const completedOutcome = result => ({ state: result.status, projectId: result.projectId, runId: result.runId, result });

/** Resolve a cited run to its pending state, its completed outcome, or a
 * refusal. The caller already holds the project gate. */
export function locateRun({ run, latest, active }, runId) {
  if (latest?.runId === runId && run?.id !== runId) return { result: completedOutcome(latest) };
  if (!run || run.id !== runId) fail('REVIEW_RUN_CHANGED', 'The identified run is no longer pending or the latest outcome.');
  return active ? { result: { state: 'running', projectId: run.projectId, runId: run.id } } : { run };
}

function pageEntry(run, draft, index, content, start, end) {
  return { index, target: draft.target, summary: draft.summary, heading: draft.heading, expectedHash: draft.expectedHash, hash: draft.hash,
    totalBytes: content.length, start, end, next: end < content.length ? end : null, content: content.subarray(start, end).toString('utf8') };
}

/** Largest UTF-8 boundary so the serialized piece fits the remaining budget. */
function fitPiece(run, draft, index, content, start, available) {
  let end = Math.min(content.length, start + available);
  for (let attempt = 0; attempt < 64 && end > start; attempt++) {
    while (end > start && continuation(content, end)) end--;
    if (end === start) break;
    const size = serialized(pageEntry(run, draft, index, content, start, end));
    if (size <= available) return end;
    const next = start + Math.floor((end - start) * available / size);
    end = Math.min(end - 1, Math.max(start, next));
  }
  fail('CONTROL_RESPONSE_LIMIT', 'The draft preview cannot be split into a bounded page.');
}

/** Content-only previews of a pending direct or queued draft set, in bounded
 * pages, with the immutable revision every decision must cite. Read-only: no
 * model, synchronization or save is started. */
export async function reviewRun(store, { projectId, runId, draft: first = 0, start: offset = 0 }) {
  if (![first, offset].every(value => Number.isSafeInteger(value) && value >= 0)) fail('DIRECT_NOTE_ARGUMENT', 'A review page position must be nonnegative integers.');
  return withProject(store, projectId, async context => {
    const located = locateRun(await readRunSnapshot(store, context), runId);
    if (located.result) return located.result;
    const { run } = located;
    const page = { state: run.phase === 'review' ? 'review' : 'interrupted', projectId: run.projectId, runId: run.id, kind: run.scope.kind, phase: run.phase,
      revision: runRevision(run), draftCount: run.drafts.length, choices: choicesFor(run), drafts: [], next: null,
      savedPaths: run.saved.map(item => item.target), warnings: run.warnings };
    if (!['review', 'saving'].includes(run.phase)) {
      if (first !== 0 || offset !== 0) fail('DIRECT_NOTE_ARGUMENT', 'This run has no reviewable draft page at that position.');
      return page;
    }
    if (first >= run.drafts.length) fail('DIRECT_NOTE_ARGUMENT', 'The requested draft index is beyond this draft set.');
    // Measure with the largest possible continuation marker and one separator
    // per entry, so the finished page never exceeds the budget it was built to.
    let size = serialized({ ...page, next: { draft: 1023, start: 10 * 1024 * 1024 } }) + 1;
    for (let index = first; index < run.drafts.length; index++) {
      const draft = run.drafts[index];
      const content = Buffer.from(reviewNoteContent(await readPrivateDraft(store, context.directory, run, draft)), 'utf8');
      if ((offset && offset >= content.length) || continuation(content, offset)) fail('DIRECT_NOTE_ARGUMENT', 'The requested preview offset is not a UTF-8 boundary inside this draft.');
      const whole = pageEntry(run, draft, index, content, offset, content.length), wholeSize = serialized(whole) + 1;
      if (size + wholeSize <= REVIEW_PAGE_BYTES) { page.drafts.push(whole); size += wholeSize; offset = 0; continue; }
      if (page.drafts.length) { page.next = { draft: index, start: offset }; break; }
      const end = fitPiece(run, draft, index, content, offset, REVIEW_PAGE_BYTES - size - 1);
      page.drafts.push(pageEntry(run, draft, index, content, offset, end));
      page.next = { draft: index, start: end }; break;
    }
    return page;
  });
}

const stale = () => fail('REVIEW_REVISION_STALE', 'The reviewed draft set changed since this decision was prepared.');

/** Relay a user's decision about the cited reviewed run. The revision binds the
 * exact draft set; the backend checks identity, destination state and
 * concurrency rather than proving a click. Direct drafts save or discard in
 * this process; queued sets hand the same action to the separate worker. */
export async function decideRun(store, { projectId, runId, revision, action }, { client, skillVersion, launchProcessing } = {}) {
  if (!['save', 'skip'].includes(action) || typeof revision !== 'string' || !HASH.test(revision)) fail('DIRECT_NOTE_ARGUMENT', 'A decision needs the reviewed revision and a supported action.');
  const located = locateRun(await withProject(store, projectId, context => readRunSnapshot(store, context)), runId);
  if (located.result) return located.result;
  const { run } = located, work = { client, skillVersion };
  if (run.scope.kind === 'direct') {
    // A complete retained manifest can be restored without resubmission or a
    // model. Review mode only restores the preview; the decision follows it.
    if (action === 'save' && run.phase === 'drafting' && run.settings.saving === 'review') {
      const recovered = await ownDirectAttempt(store, projectId, runId, owner => runProcessingWork(store, owner, { ...work, action: 'process' }));
      return recovered.state === 'review' ? reviewRun(store, { projectId, runId }) : completedOutcome(recovered);
    }
    if (runRevision(run) !== revision) stale();
    const result = await ownDirectAttempt(store, projectId, runId, async (owner, current) => {
      if (runRevision(current) !== revision) stale();
      return runProcessingWork(store, owner, { ...work, revision, action: action === 'skip' ? 'skip' : current.settings.saving === 'auto' ? 'process' : 'save' });
    });
    return result.state === 'review' ? reviewRun(store, { projectId, runId }) : completedOutcome(result);
  }
  if (typeof launchProcessing !== 'function') fail('PROCESSING_LAUNCH_REQUIRED', 'A trusted separate worker launcher is required.');
  if (runRevision(run) !== revision) stale();
  if (action === 'save' && (run.settings.saving !== 'review' || !['review', 'saving'].includes(run.phase))) {
    fail('RUN_PHASE_INVALID', 'Save publishes a reviewed draft set; process resumes drafting or automatic saving.');
  }
  // The worker is bound to this exact run id and rechecks the revision before
  // acting; published drafts never change under one run id.
  const launched = await launchOwnedAttempt(store, projectId, { runId, launch: context => launchProcessing({ ...context, action, revision }) });
  return { state: launched.state, projectId, runId: launched.runId };
}
