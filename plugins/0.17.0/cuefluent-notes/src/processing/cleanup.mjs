import { fail } from '../core/errors.mjs';
import { advanceCleanup, clearCleanupAcknowledgment, cleanupContext } from '../core/run.mjs';
import { completedResult } from '../core/result.mjs';
import { readJSON, writeJSON, removeExact } from '../storage/files.mjs';
import { withCurrentAttempt } from '../storage/attempts.mjs';
import { cleanupQueueStep, acknowledgeQueueCleanup, inspectQueue, removeEmptyQueue } from '../storage/queue.mjs';
import { queueRelative, readProjectChat } from '../storage/chats.mjs';
import { discardRunDrafts } from './draft.mjs';

/** Advance one exact record and its acknowledgment per short mutation gate.
 * Queue completion is persisted before its journal is released. Every retry
 * resumes the existing run; no model or note writer participates in cleanup.
 */
export async function cleanupRun(store, owner) {
  for (;;) {
    const step = await withCurrentAttempt(owner, async context => {
      const { run, hash, directory } = context;
      if (run.phase !== 'cleanup') fail('RUN_PHASE_INVALID', 'Source cleanup requires durable completion of every save.');
      const ack = run.cleanup.ack;
      if (ack) {
        const selected = run.selection[ack.index];
        await acknowledgeQueueCleanup(store.pin, queueRelative(selected.client, selected.sessionId), ack);
        const next = clearCleanupAcknowledgment(run, owner.attemptId, ack);
        await writeJSON(store.pin, `${directory}/run.json`, next, { expectedHash: hash });
        return { done: false };
      }
      if (run.cleanup.next < run.selection.length) {
        const selected = run.selection[run.cleanup.next];
        const result = await cleanupQueueStep(store.pin, queueRelative(selected.client, selected.sessionId), {
          selected: { id: selected.recordId, hash: selected.hash }, context: cleanupContext(run.id), index: run.cleanup.next,
        });
        const next = advanceCleanup(run, owner.attemptId, result.cursor);
        await writeJSON(store.pin, `${directory}/run.json`, next, { expectedHash: hash });
        return { done: false };
      }
      return { done: true };
    });
    if (step.done) break;
  }
  await discardRunDrafts(store, owner);
  const identities = await withCurrentAttempt(owner, ({ run }) => Array.from(new Map(run.selection.map(item =>
    [JSON.stringify([item.client, item.sessionId]), { client: item.client, sessionId: item.sessionId }])).values()));
  let remaining = 0;
  for (const item of identities) await withCurrentAttempt(owner, async ({ run }) => {
    const chat = await readProjectChat(store, run.projectId, item.client, item.sessionId);
    if (!chat) fail('CHAT_MISSING', 'Retained chat metadata disappeared before cleanup.');
    const relative = queueRelative(item.client, item.sessionId), queue = await inspectQueue(store.pin, relative);
    remaining += queue.records;
    if (queue.exists && !queue.records && !queue.pending && !chat.value.tracked && !chat.value.uncommitted) {
      await removeEmptyQueue(store.pin, relative, { queueId: queue.queueId });
    }
  });
  return withCurrentAttempt(owner, async ({ run, hash, directory }) => {
    if (run.phase !== 'cleanup' || run.cleanup.next !== run.selection.length || run.cleanup.ack) fail('RUN_CLEANUP_INVALID', 'Cleanup is not complete.');
    // Counts are a just-inspected snapshot of the selected chats; concurrent
    // appends can continue. Status never interprets these counts as authority.
    const result = completedResult(run, { remaining: run.scope.kind === 'chat' ? remaining : null });
    const prior = await readJSON(store.pin, `${directory}/result.json`, { missing: true });
    await writeJSON(store.pin, `${directory}/result.json`, result, { expectedHash: prior?.hash ?? null });
    await removeExact(store.pin, `${directory}/run.json`, hash);
    return result;
  });
}
