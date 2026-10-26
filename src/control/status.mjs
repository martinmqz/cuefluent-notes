import { fail } from '../core/errors.mjs';
import { validateRun, everyNoteSaved } from '../core/run.mjs';
import { validateResult } from '../core/result.mjs';
import { withProject, gateOptions } from '../storage/store.mjs';
import { probeGate } from '../storage/gates.mjs';
import { readJSON } from '../storage/files.mjs';
import { iterateProjectChats, readProjectChat, queueRelative } from '../storage/chats.mjs';
import { inspectQueue } from '../storage/queue.mjs';

/** Inspect only run bookkeeping under the caller's project gate. Direct notes
 * share this view without enumerating tracked chats or conversation queues. */
export async function readRunSnapshot(store, context) {
  const pending = await readJSON(store.pin, `${context.directory}/run.json`, { missing: true });
  const result = await readJSON(store.pin, `${context.directory}/result.json`, { missing: true });
  const run = pending ? validateRun(pending.value) : null;
  const latest = result ? validateResult(result.value) : null;
  if (run && run.projectId !== context.project.id || latest && latest.projectId !== context.project.id) {
    fail('STATUS_PROJECT_MISMATCH', 'Stored status belongs to another project.');
  }
  return Object.freeze({ run, latest, active: Boolean(probeGate(context.gates.workerGate, gateOptions).busy) });
}

/** Status is descriptive. It neither reconciles sources, retries a run nor
 * repairs log entries. Counts are bounded observations while hooks may append. */
export async function readProjectStatus(store, projectId, { chat = null, inventoryLimit = 1000 } = {}) {
  if (!store) return Object.freeze({ state: 'unconfigured' });
  if (!Number.isSafeInteger(inventoryLimit) || inventoryLimit < 1 || inventoryLimit > 10000) fail('STATUS_LIMIT_INVALID', 'Invalid status inventory bound.');
  const snapshot = await withProject(store, projectId, async context =>
    ({ settings: context.project, ...await readRunSnapshot(store, context) }));
  const counts = { chats: 0, tracked: 0, optedOut: 0, queued: 0, pendingSources: 0, incomplete: false };
  const warnings = [];
  async function inspect(saved) {
    if (!saved) return;
    const item = saved.value; counts.chats++;
    if (item.tracked) counts.tracked++;
    if (item.optOut) counts.optedOut++;
    if (item.pending || item.uncommitted || item.sourceCandidate) counts.pendingSources++;
    // This limitation is derivable from the frozen enrollment policy. Reporting
    // it needs neither a transcript scan nor a status-side metadata mutation.
    if (item.client === 'claude' && item.history.mode === 'automatic' && item.history.startSource === 'fork' && item.history.inheritedBoundary === null &&
        !warnings.includes('HISTORY_INHERITED_BOUNDARY_UNKNOWN') && warnings.length < 32) warnings.push('HISTORY_INHERITED_BOUNDARY_UNKNOWN');
    if (item.clientContractOverflow && !warnings.includes('CLIENT_CONTRACT_LIMIT') && warnings.length < 32) warnings.push('CLIENT_CONTRACT_LIMIT');
    try {
      const queue = await inspectQueue(store.pin, queueRelative(item.client, item.sessionId));
      const sum = counts.queued + queue.records;
      if (!Number.isSafeInteger(sum)) { counts.incomplete = true; return; }
      counts.queued = sum;
      if (queue.pending) counts.incomplete = true;
    } catch (error) {
      counts.incomplete = true;
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'STATUS_QUEUE_UNAVAILABLE';
      if (!warnings.includes(code) && warnings.length < 32) warnings.push(code);
    }
  }
  if (chat) await inspect(await readProjectChat(store, projectId, chat.client, chat.sessionId));
  else {
    for await (const saved of iterateProjectChats(store, projectId, { onWarning: code => { counts.incomplete = true; if (!warnings.includes(code) && warnings.length < 32) warnings.push(code); } })) {
      if (counts.chats >= inventoryLimit) { counts.incomplete = true; break; }
      await inspect(saved);
    }
  }
  const run = snapshot.run;
  // Three states: `running` needs a live worker, `review` means drafts await a
  // decision, and `idle` covers everything else, including a retained run that
  // stopped between phases; its `recovery` names the action that continues it.
  return Object.freeze({ projectId, state: snapshot.active ? 'running' : run?.phase === 'review' ? 'review' : 'idle',
    settings: snapshot.settings, counts: Object.freeze(counts), warnings: Object.freeze(warnings), latest: snapshot.latest,
    // The revision a decision cites comes only from the review pages that show
    // the drafts, never from status.
    run: run ? Object.freeze({ id: run.id, scope: run.scope, kind: run.scope.kind, phase: run.phase, active: snapshot.active,
      selected: run.selection.length, saved: run.saved.length,
      drafts: Object.freeze(run.drafts.map(item => Object.freeze({ target: item.target, summary: item.summary, heading: item.heading }))),
      savedPaths: Object.freeze(run.saved.map(item => item.target)), warnings: run.warnings,
      recovery: runRecovery(run, snapshot.active) }) : null });
}

const RECOVERY = Object.freeze({
  active: 'A worker is working on this run. Read status again later; do not start another command for this project.',
  review: 'Drafts await a decision. Show them with cuefluent_review_note and relay the user\'s choice with the revision of that page.',
  direct: 'Drafting stopped before the draft was complete. Retry the original request with its requestId, or show the retained draft with cuefluent_review_note and relay Discard.',
  queued: 'Drafting stopped before the draft set was published. Repeat process to resume it with the same frozen input, or show it with cuefluent_review_note and relay Skip; keep input.',
  saving: 'Saving stopped before every note was written; savedPaths lists the notes already saved. Repeat process for automatic saving, or relay Save with the reviewed revision, to finish it.',
  directSaving: 'Saving stopped before every note was written; savedPaths lists the notes already saved. Relay Save with the reviewed revision through cuefluent_save_note to finish it.',
  cleanup: 'Every note is saved and only cleanup remains. Show the run with cuefluent_review_note and relay Finish.',
});
function runRecovery(run, active) {
  if (active) return RECOVERY.active;
  const direct = run.scope.kind === 'direct';
  if (run.phase === 'drafting') return direct ? RECOVERY.direct : RECOVERY.queued;
  // A worker can stop after the last durable saved receipt and before the
  // cleanup transition; the review page then offers Finish, and so does status.
  if (run.phase === 'saving') return everyNoteSaved(run) ? RECOVERY.cleanup : direct ? RECOVERY.directSaving : RECOVERY.saving;
  return RECOVERY[run.phase];
}
