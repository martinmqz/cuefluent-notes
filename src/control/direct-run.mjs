import { isDeepStrictEqual } from 'node:util';
import { fail } from '../core/errors.mjs';
import { createRun, validateRunScope } from '../core/run.mjs';
import { writeJSON } from '../storage/files.mjs';
import { withProject } from '../storage/store.mjs';
import { ownDirectAttempt } from '../storage/attempts.mjs';
import { persistDraftManifest, recoverDrafts } from '../processing/draft.mjs';
import { pinProcessingLogging } from '../processing/logging.mjs';
import { runProcessingWork } from '../processing/worker.mjs';
import { readRunSnapshot } from './status.mjs';
import { reviewRun, completedOutcome } from './review.mjs';

const busy = run => ({ state: 'busy', projectId: run.projectId });

/** Reserve, draft and settle one direct run: a note request or a metadata
 * repair. `scope` carries the request hash that makes a `requestId` replayable
 * only with its exact request, and `changed` refuses any other use of it.
 * `build` makes the complete draft manifest from the pinned project; it runs
 * before the run is reserved, so a refused request starts nothing. `logging`
 * says whether the saved notes are activity. The outcome is a busy notice, the
 * replayed or fresh result, or the review page of the retained draft set. */
export async function submitDirectRun(store, { projectId, requestId, scope: requested, build, changed, logging = true }, options) {
  const scope = validateRunScope(requested), other = run => !isDeepStrictEqual(run.scope, scope);
  const read = context => readRunSnapshot(store, context).then(value => ({ ...value, project: context.project }));
  const initial = await withProject(store, projectId, read);
  if (initial.run && initial.run.id !== requestId) return busy(initial.run);
  const replay = latest => {
    if (latest.requestHash !== scope.requestHash) changed();
    return completedOutcome(latest);
  };
  if (!initial.run && initial.latest?.runId === requestId) return replay(initial.latest);
  if (initial.run && other(initial.run)) changed();
  let manifest;
  if (!initial.run) manifest = await build(initial.project);
  const reserved = await withProject(store, projectId, async context => {
    const current = await readRunSnapshot(store, context);
    if (current.run) {
      if (current.run.id !== requestId) return { result: busy(current.run) };
      if (other(current.run)) changed();
      return { run: current.run, active: current.active };
    }
    if (current.latest?.runId === requestId) return { result: replay(current.latest) };
    if (initial.run) fail('DIRECT_NOTE_RUN_CHANGED', 'Pending work changed while retrying.');
    if (JSON.stringify(context.project) !== JSON.stringify(initial.project)) fail('SETTINGS_CONFLICT', 'The selected destination or preferences changed.');
    const run = createRun(context.project, [], { id: requestId, scope });
    await writeJSON(store.pin, `${context.directory}/run.json`, run, { expectedHash: null });
    return { run, active: false, fresh: true };
  });
  if (reserved.result) return reserved.result;
  // Another retry may have reserved this request with different preferences.
  // Only our fresh reservation can use the manifest built before the gate.
  if (!reserved.fresh) manifest = undefined;
  const reference = { projectId, runId: requestId };
  if (reserved.active || reserved.run.phase === 'review' || reserved.run.settings.saving === 'review' && reserved.run.phase === 'saving') return reviewRun(store, reference);
  const result = await ownDirectAttempt(store, projectId, requestId, async (owner, current) => {
    if (current.phase === 'drafting') {
      if (reserved.fresh || !await recoverDrafts(store, owner)) {
        manifest ??= await build(current.settings);
        if (logging) await pinProcessingLogging(store, owner);
        await persistDraftManifest(store, owner, manifest);
      }
    }
    return runProcessingWork(store, owner, { client: options.client, skillVersion: options.skillVersion, action: 'process' });
  });
  return result.state === 'review' ? reviewRun(store, reference) : completedOutcome(result);
}
