import { fail } from '../core/errors.mjs';
import { validateRun } from '../core/run.mjs';
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
  return Object.freeze({ projectId, state: snapshot.active ? 'running' : run?.phase === 'review' ? 'review' : run ? 'interrupted' : 'idle',
    settings: snapshot.settings, counts: Object.freeze(counts), warnings: Object.freeze(warnings), latest: snapshot.latest,
    // The revision a decision cites comes only from the review pages that show
    // the drafts, never from status.
    run: run ? Object.freeze({ id: run.id, scope: run.scope, kind: run.scope.kind, phase: run.phase, active: snapshot.active,
      selected: run.selection.length, saved: run.saved.length,
      drafts: Object.freeze(run.drafts.map(item => Object.freeze({ target: item.target, summary: item.summary, heading: item.heading }))),
      savedPaths: Object.freeze(run.saved.map(item => item.target)), warnings: run.warnings }) : null });
}
