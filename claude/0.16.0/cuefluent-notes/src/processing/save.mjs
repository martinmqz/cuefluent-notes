import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { setNotePublication, markNoteSaved, completeSaving } from '../core/run.mjs';
import { withAttemptWriter } from '../storage/attempts.mjs';
import { readSnapshot, syncDirectory, hashBytes } from '../storage/files.mjs';
import { assertChain, pinDirectory, inspectAncestors, fileIdentity, lstatOrNull } from '../storage/paths.mjs';
import { prepareNotePublication, publishNotePublication, inspectPublicationOutcome } from '../storage/note-writer.mjs';
import { readDraftArtifact } from '../storage/draft-artifacts.mjs';

/** Only save creates missing type folders. Every ancestor observed by the model
 * is still pinned; directories created by concurrent authorized saves may be
 * adopted only after the same link/type checks as an existing parent. */
async function noteParent(draft) {
  await assertChain(draft.binding.parent);
  const parent = path.dirname(draft.target);
  const chain = [...await inspectAncestors(parent, { allowMissing: true })];
  for (const expected of draft.binding.parent) {
    const actual = chain.find(item => item.path === expected.path);
    if (!actual || actual.device !== expected.device || actual.inode !== expected.inode) fail('PATH_CHANGED', 'The note root or inspected parent was replaced.');
  }
  let current = chain.at(-1).path;
  for (const part of path.relative(current, parent).split(path.sep).filter(Boolean)) {
    await assertChain(chain); current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o777 }); await syncDirectory(path.dirname(current)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstatOrNull(current);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('PATH_UNSAFE', 'A note parent is not an ordinary directory.');
    await assertChain(chain); chain.push(Object.freeze({ path: current, ...fileIdentity(stat) }));
  }
  await assertChain(chain);
  return { pin: await pinDirectory(draft.binding.root), parent: chain };
}

export async function readPrivateDraft(store, directory, run, draft) {
  if (!run.artifacts) fail('DRAFT_ARTIFACTS_MISSING', 'The complete private artifact journal is required.');
  const bytes = await readDraftArtifact(store.pin, run.artifacts, draft.id);
  if (hashBytes(bytes) !== draft.hash || bytes.length !== draft.byteLength) fail('DRAFT_CHANGED', 'The private draft differs from its complete published version.');
  return bytes;
}

/** Save only an already-published complete draft set under an owned attempt.
 * Explicit review authorization must transition the run to saving beforehand.
 * Log additions are independent and best effort; the injected handler performs
 * its own short current-attempt/writer-fenced operations between note writes. */
export async function saveRunNotes(store, owner, { readDraft = readPrivateDraft, flushLogs = async () => {} } = {}) {
  for (;;) {
    const step = await withAttemptWriter(owner, async context => {
      let { run } = context;
      if (run.phase === 'cleanup') return { done: true };
      if (run.phase !== 'saving') fail('RUN_PHASE_INVALID', 'Only an authorized save can publish note drafts.');
      const draft = run.publication ? run.drafts.find(item => item.id === run.publication.note.draftId) :
        run.drafts.find(item => !run.saved.some(saved => saved.draftId === item.id));
      const persist = async next => {
        await context.persist(next); run = next;
      };
      if (!draft) { await persist(completeSaving(run, owner.attemptId)); return { done: true }; }
      const bytes = await readDraft(store, context.directory, run, draft);
      if (!Buffer.isBuffer(bytes) || bytes.length !== draft.byteLength || hashBytes(bytes) !== draft.hash) fail('DRAFT_CHANGED', 'The exact complete draft bytes are required.');
      const { pin, parent } = await noteParent(draft);
      const relative = path.relative(pin.root, draft.target).split(path.sep).join('/');
      if (draft.expectedHash === draft.hash) {
        const unchanged = await readSnapshot(pin, relative, { maxBytes: draft.byteLength });
        if (unchanged.hash !== draft.expectedHash || unchanged.bytes.length !== draft.byteLength) fail('DRAFT_CHANGED', 'The unchanged note no longer matches its exact original.');
        await persist(markNoteSaved(run, owner.attemptId, draft.id, { changed: false }));
        return { done: false };
      }
      if (!run.publication) {
        const note = await prepareNotePublication(pin, relative, bytes, { runId: run.id, draftId: draft.id,
          expectedHash: draft.expectedHash, hash: draft.hash, expectedParentChain: parent });
        const event = run.settings.activityLog.enabled && draft.expectedHash !== draft.hash ? { id: randomUUID(), savedAt: new Date().toISOString() } : null;
        await persist(setNotePublication(run, owner.attemptId, note, { event }));
      } else if (run.publication.event) {
        const outcome = await inspectPublicationOutcome(pin, run.publication.note);
        // An unapplied retry receives its actual attempt time; an already applied
        // write retains the timestamp durably recorded immediately before it.
        if (outcome.status === 'unapplied') await persist(setNotePublication(run, owner.attemptId, run.publication.note,
          { event: { ...run.publication.event, savedAt: new Date().toISOString() } }));
      }
      const outcome = await publishNotePublication(pin, run.publication.note, bytes, {
        beforePublish: context.assertCurrent,
        persistIntent: note => persist(setNotePublication(run, owner.attemptId, note, { event: run.publication.event })),
      });
      await persist(markNoteSaved(run, owner.attemptId, draft.id, { changed: outcome.changed }));
      return { done: false };
    });
    await flushLogs(store, owner);
    if (step.done) return;
  }
}
