import { fail } from '../core/errors.mjs';
import { validateRun, setNotePublication, markNoteSaved, completeSaving, addRunWarning } from '../core/run.mjs';
import { completedResult } from '../core/result.mjs';
import { withCurrentAttempt } from '../storage/attempts.mjs';
import { withWriter } from '../storage/store.mjs';
import { pinDirectory } from '../storage/paths.mjs';
import { readJSON, writeJSON, removeExact } from '../storage/files.mjs';
import { discardNoteStage, discardRecordedNoteStage } from '../storage/note-writer.mjs';
import { discardRunDrafts } from './draft.mjs';
import { cleanupRun } from './cleanup.mjs';
import { flushRunLogs, discardRunLogPublication } from './logging.mjs';

/** Skip claims the same actual worker gate as processing. The command launcher
 * returns running if another owner exists; no PID/age/socket guess revokes it. */
export async function skipRun(store, owner, { skillVersion } = {}) {
  await withCurrentAttempt(owner, context => withWriter(store, async () => {
    let { run, hash } = context;
    const persist = async next => {
      hash = (await writeJSON(store.pin, `${context.directory}/run.json`, next, { expectedHash: hash })).hash; run = next;
    };
    if (run.publication) {
      const note = run.publication.note;
      const persistIntent = updated => persist(setNotePublication(run, owner.attemptId, updated, { event: run.publication.event }));
      try {
        const pin = await pinDirectory(note.root);
        const result = await discardNoteStage(pin, note, { persistIntent });
        if (result.applied) await persist(markNoteSaved(run, owner.attemptId, note.draftId, { changed: true }));
        else await persist(validateRun({ ...run, publication: null }));
      } catch {
        // An edited public target cannot prevent releasing an inactive failed
        // run. Its bytes stay untouched, and only exact transient inodes can go.
        let next = addRunWarning(run, owner.attemptId, `NOTE_SAVE_OUTCOME_UNCONFIRMED (${note.draftId})`);
        await persist(next);
        try {
          const result = await discardRecordedNoteStage(await pinDirectory(note.root), run.publication.note, { persistIntent });
          if (result.backupPreserved) await persist(addRunWarning(run, owner.attemptId, `NOTE_BACKUP_PRESERVED (${note.draftId})`));
        } catch { await persist(addRunWarning(run, owner.attemptId, `NOTE_STAGE_PRESERVED (${note.draftId})`)); }
        await persist(validateRun({ ...run, publication: null }));
      }
    }
    if (run.phase === 'saving' && run.saved.length === run.drafts.length) await persist(completeSaving(run, owner.attemptId));
  }));
  await flushRunLogs(store, owner, { skillVersion });
  await discardRunLogPublication(store, owner);
  const phase = await withCurrentAttempt(owner, ({ run }) => run.phase);
  if (phase === 'cleanup') return cleanupRun(store, owner);
  try { await discardRunDrafts(store, owner); }
  catch {
    await withCurrentAttempt(owner, async ({ run, hash, directory }) => {
      await writeJSON(store.pin, `${directory}/run.json`, addRunWarning(run, owner.attemptId, `DRAFT_ARTIFACTS_PRESERVED (${run.id})`), { expectedHash: hash });
    });
  }
  return withCurrentAttempt(owner, async ({ run, hash, directory }) => {
    if (run.phase === 'cleanup') fail('RUN_PHASE_INVALID', 'Completed saving must finish source cleanup.');
    const result = completedResult(run, { skipped: true });
    const previous = await readJSON(store.pin, `${directory}/result.json`, { missing: true });
    await writeJSON(store.pin, `${directory}/result.json`, result, { expectedHash: previous?.hash ?? null });
    await removeExact(store.pin, `${directory}/run.json`, hash);
    return result;
  });
}
