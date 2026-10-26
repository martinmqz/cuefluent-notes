import { fail } from '../core/errors.mjs';
import { runRevision, everyNoteSaved } from '../core/run.mjs';
import { withProject } from '../storage/store.mjs';
import { ownDirectAttempt, launchOwnedAttempt } from '../storage/attempts.mjs';
import { reviewNoteContent } from '../notes/validate.mjs';
import { readPrivateDraft } from '../processing/save.mjs';
import { runProcessingWork } from '../processing/worker.mjs';
import { readRunSnapshot } from './status.mjs';

/** One review page is sized for what a host passes to its model in one tool
 * result (Claude Code's default is 25,000 tokens), well inside the 256 KiB
 * control projection. The complete set is shown across pages, never cut. */
export const REVIEW_PAGE_BYTES = 48 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const invalid = message => fail('REVIEW_ARGUMENT', message);
const continuation = (bytes, at) => at < bytes.length && (bytes[at] & 0xc0) === 0x80;
const serialized = value => Buffer.byteLength(JSON.stringify(value));

/** The exact wording to offer for a pending run. `Save`, `Finish` and `Restore
 * draft` relay to the save tool; `Discard` and the skip wordings relay to the
 * skip tool; `Keep pending` makes no call. Queued skip keeps the selected input
 * until only cleanup remains, where either tool finishes the run. A direct run
 * interrupted while drafting with a retained manifest restores its preview for
 * a fresh decision in review mode, and saves it in automatic mode. */
export function decisionChoices(run) {
  const direct = run.scope.kind === 'direct';
  if (run.phase === 'cleanup' || (run.phase === 'saving' && everyNoteSaved(run))) return ['Finish', 'Keep pending'];
  if (run.phase === 'drafting') {
    const retained = direct && run.artifacts ? [run.settings.saving === 'review' ? 'Restore draft' : 'Save'] : [];
    return [...retained, direct ? 'Discard' : 'Skip; keep input', 'Keep pending'];
  }
  return ['Save', direct ? 'Discard' : 'Skip draft; keep input', 'Keep pending'];
}
/** Page metadata stays bounded whatever the run accumulated: at most this many
 * warnings travel with a page; status carries the complete list. */
export const PAGE_WARNINGS = 16;

export const completedOutcome = result => ({ state: result.status, projectId: result.projectId, runId: result.runId, result });

/** Resolve a cited run to its pending state, its completed outcome, or a
 * refusal. The caller already holds the project gate. */
export function locateRun({ run, latest, active }, runId) {
  if (latest?.runId === runId && run?.id !== runId) return { result: completedOutcome(latest) };
  if (!run || run.id !== runId) fail('REVIEW_RUN_CHANGED', 'The identified run is neither pending nor the latest outcome.');
  return active ? { result: { state: 'running', projectId: run.projectId, runId: run.id, started: false } } : { run };
}

function pageEntry(run, draft, index, content, start, end) {
  return { index, target: draft.target, summary: draft.summary, heading: draft.heading, expectedHash: draft.expectedHash, hash: draft.hash,
    saved: run.saved.some(item => item.draftId === draft.id),
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
  if (![first, offset].every(value => Number.isSafeInteger(value) && value >= 0)) invalid('A review page position is a nonnegative draft index and byte offset.');
  return withProject(store, projectId, async context => {
    const located = locateRun(await readRunSnapshot(store, context), runId);
    if (located.result) return located.result;
    const { run } = located;
    const page = { state: run.phase === 'review' ? 'review' : 'interrupted', projectId: run.projectId, runId: run.id, kind: run.scope.kind, phase: run.phase,
      revision: runRevision(run), draftCount: run.drafts.length, savedCount: run.saved.length, choices: decisionChoices(run), drafts: [], next: null,
      warnings: run.warnings.slice(0, PAGE_WARNINGS), warningsTruncated: run.warnings.length > PAGE_WARNINGS };
    if (!['review', 'saving'].includes(run.phase)) {
      if (first !== 0 || offset !== 0) invalid('This run has no reviewable draft page at that position.');
      return page;
    }
    if (first >= run.drafts.length) invalid('The requested draft index is beyond this draft set.');
    // Measure with the largest possible continuation marker and one separator
    // per entry, so the finished page never exceeds the budget it was built to.
    let size = serialized({ ...page, next: { draft: 1023, start: 10 * 1024 * 1024 } }) + 1;
    for (let index = first; index < run.drafts.length; index++) {
      const draft = run.drafts[index];
      const content = Buffer.from(reviewNoteContent(await readPrivateDraft(store, context.directory, run, draft)), 'utf8');
      if ((offset && offset >= content.length) || continuation(content, offset)) invalid('The requested preview offset is not a UTF-8 boundary inside this draft.');
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

/** A decision that lost a race to another owner or to a finished run is
 * answered from the current state, never with an internal ownership code. */
async function settled(store, projectId, runId, error) {
  if (error?.code === 'ATTEMPT_ACTIVE') return { state: 'running', projectId, runId, started: false };
  if (!['RUN_MISSING', 'RUN_CHANGED'].includes(error?.code)) throw error;
  const located = locateRun(await withProject(store, projectId, context => readRunSnapshot(store, context)), runId);
  if (located.result) return located.result;
  fail('REVIEW_RUN_CHANGED', 'The identified run changed while the decision was being applied.');
}

/** Relay a user's decision about the cited reviewed run. The revision binds the
 * exact draft set; the backend checks identity, destination state and
 * concurrency rather than proving a click. Direct drafts save or discard in
 * this process; queued sets hand the same action to the separate worker. */
export async function decideRun(store, { projectId, runId, revision, action }, { client, skillVersion, launchProcessing, startupTimeoutMs } = {}) {
  if (!['save', 'skip'].includes(action) || typeof revision !== 'string' || !HASH.test(revision)) invalid('A decision cites the reviewed revision with a save or skip action.');
  const located = locateRun(await withProject(store, projectId, context => readRunSnapshot(store, context)), runId);
  if (located.result) return located.result;
  const { run } = located, work = { client, skillVersion };
  if (runRevision(run) !== revision) stale();
  if (run.scope.kind === 'direct') {
    try {
      // A complete retained manifest of a run still drafting is restored
      // without resubmission or a model; in review mode that only restores the
      // preview, and the decision follows it.
      if (action === 'save' && run.phase === 'drafting' && run.settings.saving === 'review') {
        const recovered = await ownDirectAttempt(store, projectId, runId, owner => runProcessingWork(store, owner, { ...work, action: 'process' }));
        return recovered.state === 'review' ? reviewRun(store, { projectId, runId }) : completedOutcome(recovered);
      }
      const result = await ownDirectAttempt(store, projectId, runId, async (owner, current) => {
        if (runRevision(current) !== revision) stale();
        return runProcessingWork(store, owner, { ...work, revision, action: action === 'skip' ? 'skip' : current.settings.saving === 'auto' ? 'process' : 'save' });
      });
      return result.state === 'review' ? reviewRun(store, { projectId, runId }) : completedOutcome(result);
    } catch (error) { return settled(store, projectId, runId, error); }
  }
  if (typeof launchProcessing !== 'function') fail('PROCESSING_LAUNCH_REQUIRED', 'A trusted separate worker launcher is required.');
  if (action === 'save' && run.phase === 'drafting') fail('RUN_PHASE_INVALID', 'Save publishes a reviewed draft set or finishes an interrupted save; process resumes drafting.');
  // An automatic run finishes its interrupted save or cleanup through the same
  // resume path process uses; no model runs once drafts are published. The
  // worker is bound to this exact run id and rechecks the revision before
  // acting; published drafts never change under one run id.
  const workerAction = action === 'skip' ? 'skip' : run.settings.saving === 'auto' ? 'process' : 'save';
  try {
    const launched = await launchOwnedAttempt(store, projectId, { runId, startupTimeoutMs, launch: context => launchProcessing({ ...context, action: workerAction, revision }) });
    return { state: 'running', projectId, runId: launched.runId, started: launched.launched };
  } catch (error) { return settled(store, projectId, runId, error); }
}
