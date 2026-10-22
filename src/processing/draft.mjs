import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { validateRun, publishDrafts, addRunWarning } from '../core/run.mjs';
import { withCurrentAttempt } from '../storage/attempts.mjs';
import { createPrivateDirectory, assertDirectory } from '../storage/paths.mjs';
import { writeJSON } from '../storage/files.mjs';
import { prepareDraftArtifacts, writeDraftArtifact, completeDraftArtifacts, inspectDraftArtifacts,
  readDraftArtifact, discardDraftArtifacts } from '../storage/draft-artifacts.mjs';
import { openNoteWorkspace, NOTE_WORKSPACE_TOOLS } from './workspace.mjs';
import { serveDraftTools } from './draft-server.mjs';
import { runDraftingSession } from './clients/index.mjs';
import { readProcessingInput } from './prepare.mjs';
import { DRAFTING_PROMPT, draftingInput } from './prompt.mjs';

/** One artifact deletion per short gate, with its progress retained in the
 * artifact journal until the directory is durably absent. */
export async function discardRunDrafts(store, owner, { clearPointer = false } = {}) {
  for (;;) {
    const result = await withCurrentAttempt(owner, async ({ run, hash, directory }) => {
      const removed = await discardDraftArtifacts(store.pin, run.artifacts ?? `${directory}/drafts/${run.id}`, { limit: 1, runId: run.id });
      if (removed.removed && clearPointer && run.artifacts) {
        if (run.phase !== 'drafting') fail('RUN_PHASE_INVALID', 'Only unfinished drafting can discard and replace its draft set.');
        await writeJSON(store.pin, `${directory}/run.json`, validateRun({ ...run, artifacts: null }), { expectedHash: hash });
      }
      return removed;
    });
    if (result.removed) return;
  }
}

async function publishReady(store, owner) {
  return withCurrentAttempt(owner, async ({ run, hash, directory }) => {
    if (!run.artifacts) fail('DRAFT_ARTIFACTS_MISSING', 'A complete private draft journal is required.');
    const inspected = await inspectDraftArtifacts(store.pin, run.artifacts);
    if (inspected.status !== 'ready') fail('DRAFT_ARTIFACTS_INCOMPLETE', 'The private draft set is not ready.');
    const next = publishDrafts(run, owner.attemptId, inspected.manifest.drafts);
    await writeJSON(store.pin, `${directory}/run.json`, next, { expectedHash: hash });
    return next;
  });
}

async function recoverDrafts(store, owner) {
  const current = await withCurrentAttempt(owner, async ({ run }) => run.artifacts ? inspectDraftArtifacts(store.pin, run.artifacts) : null);
  if (!current) {
    // Only an empty reservation can predate its pointer. Nonempty unknown files
    // are preserved, never adopted as a new model's output.
    await discardRunDrafts(store, owner); return null;
  }
  if (current.manifest) {
    let complete = true;
    for (const draft of current.manifest.drafts) {
      const result = await withCurrentAttempt(owner, ({ run }) => writeDraftArtifact(store.pin, run.artifacts, draft.id));
      if (!result.complete) { complete = false; break; }
    }
    if (complete) {
      await withCurrentAttempt(owner, ({ run }) => completeDraftArtifacts(store.pin, run.artifacts));
      // Recovered ready bytes are checked again before a review set is published.
      for (const draft of current.manifest.drafts) await withCurrentAttempt(owner, ({ run }) => readDraftArtifact(store.pin, run.artifacts, draft.id));
      return publishReady(store, owner);
    }
  }
  await discardRunDrafts(store, owner, { clearPointer: true });
  return null;
}

export async function prepareRunDrafts(store, owner, { client, skillVersion, model, effort = 'high',
  runClient = runDraftingSession, readActivityLog, signal } = {}) {
  const initial = await withCurrentAttempt(owner, ({ run }) => run);
  if (initial.phase !== 'drafting') return initial;
  const recovered = await recoverDrafts(store, owner);
  if (recovered) return recovered;
  const run = await withCurrentAttempt(owner, ({ run }) => run);
  const input = await readProcessingInput(store, run);
  const workspace = await openNoteWorkspace({ project: run.settings, runId: run.id, skillVersion,
    now: new Date().toISOString(), readActivityLog });
  const cwd = await createPrivateDirectory(path.join(store.root, 'processing', randomUUID()));
  let bridge, ready, failure;
  try {
    bridge = await serveDraftTools(workspace, { definitions: NOTE_WORKSPACE_TOOLS, version: skillVersion, signal });
    const result = await runClient({ client, model, effort, cwd: cwd.root, prompt: DRAFTING_PROMPT,
      input: draftingInput(input, run.settings), mcp: bridge.descriptor, signal });
    if (result?.status !== 'completed') fail('DRAFT_SESSION_INCOMPLETE', 'The native drafting session did not complete.');
    const manifest = await workspace.manifest();
    if (manifest.runId !== run.id) fail('DRAFT_RUN_CHANGED', 'The draft workspace belongs to a different run.');
    const metadata = { runId: run.id, outcome: manifest.outcome,
      drafts: manifest.drafts.map(({ bytes, ...draft }) => ({ ...draft, byteLength: bytes.length })) };
    await withCurrentAttempt(owner, async context => {
      let current = context.run, hash = context.hash;
      if (current.phase !== 'drafting' || current.artifacts) fail('DRAFT_RUN_CHANGED', 'The current draft reservation changed.');
      await prepareDraftArtifacts(store.pin, `${context.directory}/drafts/${run.id}`, metadata, {
        persistIntent: async pointer => {
          current = validateRun({ ...current, artifacts: pointer });
          hash = (await writeJSON(store.pin, `${context.directory}/run.json`, current, { expectedHash: hash })).hash;
        },
      });
    });
    for (const draft of manifest.drafts) await withCurrentAttempt(owner, ({ run }) => writeDraftArtifact(store.pin, run.artifacts, draft.id, draft.bytes));
    await withCurrentAttempt(owner, ({ run }) => completeDraftArtifacts(store.pin, run.artifacts));
    ready = await publishReady(store, owner);
  } catch (error) {
    failure = error;
  } finally {
    const warnings = [];
    for (const clean of [() => bridge?.close(), async () => {
      // Never recursively remove unexpected files left by a native client.
      await assertDirectory(cwd); await fs.rmdir(cwd.root);
    }]) {
      try { await clean(); }
      catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'CLEANUP_FAILED';
        warnings.push(`Private drafting-session cleanup was incomplete (${code}); unexpected files were preserved.`);
      }
    }
    if (warnings.length) {
      try {
        const next = await withCurrentAttempt(owner, async ({ run, hash, directory }) => {
          const updated = warnings.reduce((current, warning) => addRunWarning(current, owner.attemptId, warning), run);
          await writeJSON(store.pin, `${directory}/run.json`, updated, { expectedHash: hash }); return updated;
        });
        if (ready) ready = next;
      } catch { /* Cleanup reporting must never replace the model/publication outcome. */ }
    }
  }
  if (failure) throw failure;
  return ready;
}
