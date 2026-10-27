import path from 'node:path';
import { fail } from '../core/errors.mjs';
import { SEMVER_VERSION_PATTERN } from '../core/version.mjs';
import { pinRunLogging, confirmLogEvent, failLogEvent, setLogPublication, addRunWarning, validateRun, RUN_LIMITS } from '../core/run.mjs';
import { withCurrentAttempt, withAttemptWriter } from '../storage/attempts.mjs';
import { writeJSON, readSnapshot, hashBytes } from '../storage/files.mjs';
import { prepareNotePublication, publishNotePublication, readPublicationSource, discardNoteStage, discardRecordedNoteStage } from '../storage/note-writer.mjs';
import { inspectActivityLogSeries, logPin, logCandidate, logYear, logRelative } from '../logs/storage.mjs';
import { logDiagnostic } from '../logs/index.mjs';
import { NOTE_PROFILE } from '../notes/index.mjs';

const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'LOG_WRITE_FAILED';
const detailOf = error => { const location = logDiagnostic(error); return location ? ` at ${JSON.stringify(location)}` : ''; };
const warning = (eventId, code, detail = '') => `Activity log entry ${eventId} was not confirmed (${code}${detail}); the saved note is intact and the entry may be absent.`;
const summarize = run => {
  const count = run.logEvents.filter(event => !event.confirmed).length;
  return count ? `${count} saved note change${count === 1 ? ' was' : 's were'} not confirmed in the activity log. Retry details end with this run; no later backfill is scheduled.` : null;
};

function addWarning(run, message) {
  if (run.warnings.includes(message)) return run;
  const warnings = run.warnings.length < RUN_LIMITS.warnings ? [...run.warnings, message] : [...run.warnings.slice(0, RUN_LIMITS.warnings - 1), message];
  return validateRun({ ...run, warnings });
}

function eventInput(run, event) {
  const draft = run.drafts.find(item => item.id === event.draftId);
  if (!draft) fail('LOG_EVENT_INVALID', 'The saved event has no exact draft descriptor.');
  return { eventId: event.id, projectId: run.projectId, savedAt: event.savedAt, action: draft.expectedHash === null ? 'created' : 'updated',
    target: path.relative(run.logging.root, draft.target).split(path.sep).join('/'), ...(draft.heading === null ? {} : { heading: draft.heading }), summary: draft.summary };
}

function persistence(store, context) {
  let run = context.run, hash = context.hash;
  return { get run() { return run; }, async persist(next) {
    if (context.persist) await context.persist(next);
    else { const result = await writeJSON(store.pin, `${context.directory}/run.json`, next, { expectedHash: hash }); hash = result.hash; }
    run = next; return next;
  } };
}

/** Optional setup trouble records a warning while note processing continues. */
export async function pinProcessingLogging(store, owner) {
  const initial = await withCurrentAttempt(owner, ({ run }) => run);
  if (!initial.settings.activityLog.enabled || initial.logging) return initial.logging;
  try {
    return await withAttemptWriter(owner, async context => {
      if (context.run.logging) return context.run.logging;
      const inspected = await inspectActivityLogSeries(context.run.settings.destination);
      await context.persist(pinRunLogging(context.run, owner.attemptId, inspected.binding));
      return inspected.binding;
    });
  } catch (error) {
    return withCurrentAttempt(owner, async context => {
      const state = persistence(store, context);
      await state.persist(addRunWarning(state.run, owner.attemptId, `Activity logging is unavailable for this run (${codeOf(error)}${detailOf(error)}); note processing can continue.`));
      return null;
    });
  }
}

async function discardOwned(pin, publication, persistIntent) {
  try { return await discardNoteStage(pin, publication.note, { persistIntent }); }
  catch {
    const result = await discardRecordedNoteStage(pin, publication.note, { persistIntent });
    return { ...result, applied: false };
  }
}

/** One independently fenced log operation per event. Known failures are final
 * for that event; an interrupted publication retains exact expectations. */
export async function flushRunLogs(store, owner, { skillVersion } = {}) {
  if (typeof skillVersion !== 'string' || !SEMVER_VERSION_PATTERN.test(skillVersion) || skillVersion.length > 256) fail('LOG_ARGUMENT', 'Activity logging requires the installed skill version.');
  const events = await withCurrentAttempt(owner, ({ run }) => [
    ...(run.logPublication ? [run.logPublication.eventId] : []),
    ...run.logEvents.filter(event => !event.confirmed && event.failure === null && event.id !== run.logPublication?.eventId).map(event => event.id),
  ]);
  for (const eventId of events) await withAttemptWriter(owner, async context => {
    const state = persistence(store, context), current = state.run.logEvents.find(event => event.id === eventId);
    if (!current || current.confirmed || current.failure !== null) return;
    if (!state.run.logging) {
      await state.persist(addRunWarning(failLogEvent(state.run, owner.attemptId, eventId, 'LOG_SERIES_UNAVAILABLE'), owner.attemptId, warning(eventId, 'LOG_SERIES_UNAVAILABLE'))); return;
    }
    try {
      await (async () => {
        let pin;
        try {
          pin = await logPin(state.run.logging);
          const input = eventInput(state.run, current); let bytes;
          if (state.run.logPublication) {
            if (state.run.logPublication.eventId !== eventId) fail('LOG_PUBLICATION_BUSY', 'Finish the current log event first.');
            const source = await readPublicationSource(pin, state.run.logPublication.note);
            bytes = source.status === 'applied' ? source.bytes : logCandidate(state.run.logging, input, source.bytes, { skillVersion, expandedMetadata: state.run.settings.expandedMetadata }).bytes;
            if (hashBytes(bytes) !== state.run.logPublication.note.hash || bytes.length !== state.run.logPublication.note.bytes) fail('LOG_CANDIDATE_CHANGED', 'The exact pending log proposal cannot be reconstructed.');
          } else {
            const series = await inspectActivityLogSeries(state.run.settings.destination);
            if (series.binding.seriesId !== state.run.logging.seriesId || series.binding.timezone !== state.run.logging.timezone) fail('LOG_SERIES_CONFLICT', 'The pinned series no longer matches the destination.');
            const relative = logRelative(logYear(current.savedAt, state.run.logging.timezone));
            const original = await readSnapshot(pin, relative, { missing: true, maxBytes: NOTE_PROFILE.fileBytes });
            const candidate = logCandidate(state.run.logging, input, original?.bytes ?? null, { skillVersion, expandedMetadata: state.run.settings.expandedMetadata }); bytes = candidate.bytes;
            if (!candidate.changed) { await state.persist(confirmLogEvent(state.run, owner.attemptId, eventId)); return; }
            const note = await prepareNotePublication(pin, relative, bytes, { runId: state.run.id, draftId: eventId, expectedHash: original?.hash ?? null, hash: hashBytes(bytes), expectedParentChain: state.run.logging.parent });
            await state.persist(setLogPublication(state.run, owner.attemptId, eventId, note));
          }
          await publishNotePublication(pin, state.run.logPublication.note, bytes, { beforePublish: context.assertCurrent, persistIntent: note => state.persist(setLogPublication(state.run, owner.attemptId, eventId, note)) });
          await state.persist(confirmLogEvent(state.run, owner.attemptId, eventId));
        } catch (error) {
          let code = codeOf(error);
          if (state.run.logPublication) {
            try {
              pin ??= await logPin(state.run.logging);
              const discarded = await discardOwned(pin, state.run.logPublication, note => state.persist(setLogPublication(state.run, owner.attemptId, eventId, note)));
              if (discarded.applied) { await state.persist(confirmLogEvent(state.run, owner.attemptId, eventId)); return; }
              // A person may have edited a complete published entry before its
              // receipt was durable. Abandon only our exact transient stage,
              // then recognize the existing ID from the current preserved file.
              // A missing event never permits rebasing the interrupted proposal.
              try {
                const latest = await readSnapshot(pin, state.run.logPublication.note.relative, { missing: true, maxBytes: NOTE_PROFILE.fileBytes });
                if (latest && !logCandidate(state.run.logging, eventInput(state.run, current), latest.bytes, { skillVersion, expandedMetadata: state.run.settings.expandedMetadata }).changed) {
                  let confirmed = confirmLogEvent(state.run, owner.attemptId, eventId);
                  if (discarded.backupPreserved) confirmed = addRunWarning(confirmed, owner.attemptId, `Activity log entry ${eventId} was confirmed; an interrupted publication backup was preserved for inspection.`);
                  await state.persist(confirmed); return;
                }
              } catch { /* Preserve the original conflict and report below. */ }
              if (discarded.backupPreserved) code = 'LOG_STAGE_PRESERVED';
            } catch { code = 'LOG_STAGE_PRESERVED'; }
          }
          await state.persist(addRunWarning(failLogEvent(state.run, owner.attemptId, eventId, code), owner.attemptId, warning(eventId, code, detailOf(error))));
        }
      })();
    } catch (error) {
      // Failure to acquire the destination gate is itself best effort. A known
      // stage is left journaled for a later owned cleanup, never blindly unlinked.
      await state.persist(addRunWarning(state.run, owner.attemptId, warning(eventId, codeOf(error))));
    }
  }).catch(error => withCurrentAttempt(owner, async context => {
    const state = persistence(store, context);
    await state.persist(addRunWarning(state.run, owner.attemptId, warning(eventId, codeOf(error))));
  }));
  return withCurrentAttempt(owner, async context => {
    const state = persistence(store, context), summary = summarize(state.run);
    if (summary) await state.persist(addRunWarning(state.run, owner.attemptId, summary));
    return state.run;
  });
}

/** Low-level release for a caller holding the live attempt worker and writer
 * gates. persistRun journals an adopted empty stage
 * before its removal. A log problem alone never prevents releasing this run. */
export async function discardLogPublication(store, input, { persistRun } = {}) {
  let run = validateRun(input);
  if (typeof persistRun !== 'function') fail('LOG_ARGUMENT', 'Log release needs its current-run persistence callback.');
  if (run.logPublication) {
    try {
      const pin = await logPin(run.logging), result = await discardOwned(pin, run.logPublication, async note => {
        run = validateRun({ ...run, logPublication: { ...run.logPublication, note } }); await persistRun(run);
      });
      if (result.backupPreserved) run = addWarning(run, 'An unreconciled activity-log recovery file was preserved.');
      if (result.applied) run = validateRun({ ...run, logEvents: run.logEvents.map(event => event.id === run.logPublication.eventId ? { ...event, confirmed: true } : event), logPublication: null });
    } catch { run = addWarning(run, 'An unverifiable activity-log staging or recovery file was preserved.'); }
  }
  run = validateRun({ ...run, logPublication: null, logEvents: run.logEvents.map(event => event.confirmed ? event : { ...event, failure: event.failure ?? 'LOG_RUN_RELEASED' }) });
  const summary = summarize(run); if (summary) run = addWarning(run, summary);
  await persistRun(run); return run;
}

export async function discardRunLogPublication(store, owner) {
  try {
    return await withAttemptWriter(owner, context => discardLogPublication(store, context.run, { persistRun: context.persist }));
  } catch (error) {
    return withCurrentAttempt(owner, async context => {
      const state = persistence(store, context);
      // No public write happens without the gate. Preserve and report any
      // unverified staging path; cleanup must not turn into a cross-run backlog.
      let run = addWarning(state.run, `Activity-log cleanup was unavailable (${codeOf(error)}); unverified staging paths were preserved.`);
      run = validateRun({ ...run, logPublication: null, logEvents: run.logEvents.map(event => event.confirmed ? event : { ...event, failure: event.failure ?? 'LOG_RUN_RELEASED' }) });
      const summary = summarize(run); if (summary) run = addWarning(run, summary);
      return state.persist(run);
    });
  }
}
