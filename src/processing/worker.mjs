import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fail } from '../core/errors.mjs';
import { beginSaving, readyForReview, addRunWarning } from '../core/run.mjs';
import { openStore } from '../storage/store.mjs';
import { ownAttempt, withCurrentAttempt, attachAttemptChild } from '../storage/attempts.mjs';
import { writeJSON } from '../storage/files.mjs';
import { readActivityLog } from '../logs/storage.mjs';
import { prepareRunDrafts } from './draft.mjs';
import { saveRunNotes } from './save.mjs';
import { pinProcessingLogging, flushRunLogs, discardRunLogPublication } from './logging.mjs';
import { cleanupRun } from './cleanup.mjs';
import { skipRun } from './skip.mjs';

export async function runProcessingWork(store, owner, { action, client, model, effort, skillVersion, runClient, signal } = {}) {
  if (!['process', 'save', 'skip'].includes(action) || !['claude', 'codex'].includes(client) || typeof skillVersion !== 'string') fail('WORKER_ARGUMENT', 'The worker requires a trusted action, native client and package version.');
  const logging = { skillVersion };
  try {
    if (action === 'skip') return await skipRun(store, owner, logging);
    let run = await withCurrentAttempt(owner, ({ run }) => run);
    if (action === 'save') {
      if (run.settings.saving !== 'review' || !['review', 'saving', 'cleanup'].includes(run.phase)) fail('RUN_PHASE_INVALID', 'Save retries an existing review-mode draft set.');
      if (run.phase === 'review') run = await withCurrentAttempt(owner, async ({ run, hash, directory }) => {
        const next = beginSaving(run, owner.attemptId);
        await writeJSON(store.pin, `${directory}/run.json`, next, { expectedHash: hash }); return next;
      });
    } else if (run.phase === 'drafting') {
      if (run.scope.kind === 'direct') fail('DIRECT_NOTE_CONTENT_REQUIRED', 'Retry the original direct note submission to finish its draft.');
      const binding = await pinProcessingLogging(store, owner);
      run = await prepareRunDrafts(store, owner, { client, model, effort, skillVersion, runClient, signal,
        readActivityLog: run.settings.destination.kind === 'directory' ? query => readActivityLog(run.settings.destination,
          { ...query, ...(binding ? { binding } : {}) }) : null });
    } else if (run.phase === 'saving' && run.settings.saving !== 'auto') fail('RUN_PHASE_INVALID', 'Use save to resume this review-mode save.');
    if (run.phase === 'review') {
      return withCurrentAttempt(owner, async ({ run, hash, directory }) => {
        const ready = readyForReview(run, owner.attemptId);
        await writeJSON(store.pin, `${directory}/run.json`, ready, { expectedHash: hash });
        return { state: 'review', runId: ready.id, drafts: ready.drafts.map(({ target, summary, heading }) => ({ target, summary, heading })) };
      });
    }
    await saveRunNotes(store, owner, { flushLogs: (store, owner) => flushRunLogs(store, owner, logging) });
    await discardRunLogPublication(store, owner);
    return await cleanupRun(store, owner);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'PROCESSING_WORKER_FAILED';
    try {
      await withCurrentAttempt(owner, async ({ run, hash, directory }) => {
        await writeJSON(store.pin, `${directory}/run.json`, addRunWarning(run, owner.attemptId, code), { expectedHash: hash });
      });
    } catch { /* Preserve the original failure; a completed result may already exist. */ }
    throw error;
  }
}

/** Executable paths and model configuration come from the installed package and
 * explicit user settings, never model arguments or persisted conversation. */
export function processingLauncher({ client, skillVersion, model, effort = 'high' } = {}) {
  return context => {
    const child = fork(fileURLToPath(import.meta.url), [JSON.stringify({ ...context, client, skillVersion, model, effort })],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    return attachAttemptChild(child, context);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = JSON.parse(process.argv[2]);
    const store = await openStore(options.storeRoot);
    if (!store) fail('STORE_MISSING', 'Set up the private store before processing.');
    await ownAttempt(store, options.projectId, options, owner => runProcessingWork(store, owner, options));
  } catch { process.exitCode = 1; }
}
