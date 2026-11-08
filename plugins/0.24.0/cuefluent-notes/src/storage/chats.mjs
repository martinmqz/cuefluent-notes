import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../core/errors.mjs';
import { createChat, changeTracking, validateChat, stageChatPart, advanceChat, resolveChatHistoryBoundary, retainChatClientContract } from '../core/chat.mjs';
import { chooseProject } from '../core/settings.mjs';
import { nativeId } from '../transcript/checkpoint.mjs';
import { hashBytes, readJSON, writeJSON } from './files.mjs';
import { projectKey, readSettings, withProject, withSelectedProject } from './store.mjs';
import { appendQueueRecord, inspectQueue, recoverQueueAppend, selectQueue } from './queue.mjs';
import { inputRecord } from './queue-format.mjs';
import { assertChain, assertDirectory, inspectParent } from './paths.mjs';

export const CHAT_METADATA_BYTES = 64 * 1024;

export function chatKey(client, sessionId) {
  if (!['claude', 'codex'].includes(client)) fail('CHAT_INVALID', 'Unsupported native client.');
  nativeId(sessionId);
  return hashBytes(JSON.stringify([client, sessionId]));
}

export const chatRelative = (projectId, client, sessionId) => `store/projects/${projectKey(projectId)}/chats/${chatKey(client, sessionId)}.json`;
export const queueRelative = (client, sessionId) => `store/chats/${chatKey(client, sessionId)}.queue`;

export async function readProjectChat(store, projectId, client, sessionId) {
  const relative = chatRelative(projectId, client, sessionId);
  const saved = await readJSON(store.pin, relative, { missing: true, maxBytes: CHAT_METADATA_BYTES });
  if (!saved) return null;
  const value = validateChat(saved.value);
  if (value.client !== client || value.sessionId !== sessionId || value.projectId !== projectId) fail('CHAT_IDENTITY_MISMATCH', 'Stored chat identity differs from its native binding.');
  return { value, hash: saved.hash, relative };
}

/** Streaming project inventory. No transcript or queue is opened, and no state
 * is created. Project commands catch up tracked chats even if their queue is empty.
 */
export async function* iterateProjectChats(store, projectId, { onWarning = () => {}, readSnapshot = readJSON } = {}) {
  if (!store) return;
  if (typeof onWarning !== 'function' || typeof readSnapshot !== 'function') fail('CHAT_INVENTORY_INVALID', 'Inventory requires trusted observation callbacks.');
  const settings = await readSettings(store);
  if (!settings.value.projects.some(project => project.id === projectId)) fail('PROJECT_UNCONFIGURED', 'The project is not configured.');
  const relative = `store/projects/${projectKey(projectId)}/chats`;
  const parent = await inspectParent(store.pin, `${relative}/inventory`);
  const directory = await fs.opendir(path.dirname(parent.file));
  try {
    for (;;) {
      const entry = await directory.read();
      if (!entry) break;
      if (/^\.[a-f0-9]{64}\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(entry.name)) { onWarning('CHAT_STAGE_RETAINED'); continue; }
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || !entry.isFile()) { onWarning('CHAT_INVENTORY_INVALID'); continue; }
      await assertChain(parent.chain);
      let saved;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const snapshot = await readSnapshot(store.pin, `${relative}/${entry.name}`, { maxBytes: CHAT_METADATA_BYTES });
          const value = validateChat(snapshot.value);
          if (value.projectId !== projectId || entry.name !== `${chatKey(value.client, value.sessionId)}.json`) fail('CHAT_IDENTITY_MISMATCH', 'Chat metadata differs from its project inventory binding.');
          saved = { value, hash: snapshot.hash, relative: `${relative}/${entry.name}` }; break;
        } catch (error) {
          if (attempt < 2 && ['FILE_CHANGED', 'FILE_MISSING', 'ENOENT'].includes(error.code)) continue;
          onWarning(typeof error.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : 'CHAT_INVENTORY_INVALID'); break;
        }
      }
      if (saved) yield saved;
    }
  } finally { await directory.close(); await assertChain(parent.chain); await assertDirectory(store.pin); }
}

async function findOwned(store, settings, client, sessionId) {
  let found = null;
  // One exact filename per configured project, whose count is schema-bounded.
  // Never enumerate chats or scan an unbounded queue to determine ownership.
  for (const project of settings.projects) {
    const saved = await readProjectChat(store, project.id, client, sessionId);
    if (saved) {
      if (found) fail('CHAT_OWNERSHIP_CONFLICT', 'The chat has conflicting project bindings; both have been preserved.');
      found = saved;
    }
  }
  return found;
}

/** Read-only: absent/unconfigured status creates no registration, queue or gate. */
export async function readChat(store, client, sessionId) {
  chatKey(client, sessionId);
  if (!store) return null;
  return findOwned(store, (await readSettings(store)).value, client, sessionId);
}

/** invocation comes only from the verified native command binder. Source identity
 * is inspected before this short operation. Missing source stays pending.
 */
export async function setChatTracking(store, invocation, { source = null, history } = {}) {
  const { client, sessionId, promptId, action, cwd } = invocation;
  chatKey(client, sessionId); nativeId(promptId);
  if (!['track', 'untrack'].includes(action)) fail('CHAT_ACTION_INVALID', 'Choose track or untrack.');
  const located = source ?? (invocation.sourcePath ? { path: invocation.sourcePath, identity: null } : null);
  let found;
  return withSelectedProject(store, async settings => {
    found = await findOwned(store, settings, client, sessionId);
    return chooseProject(settings, cwd, { existingOwnerId: found?.value.projectId })?.id ?? null;
  }, async context => {
    let current = found?.value ?? createChat({ client, sessionId, projectId: context.project.id, source: located, history });
    current = retainChatClientContract(current, invocation.clientContract ?? null);
    if (located) {
      if (current.source && (current.source.path !== located.path || current.source.identity && located.identity &&
          ['device', 'inode'].some(key => current.source.identity[key] !== located.identity[key]))) {
        // The verified invocation still revokes collection immediately. Retain
        // its candidate until an independent provider can resolve/reanchor it.
        current = validateChat({ ...current, sourceCandidate: located });
      } else current = validateChat({ ...current, source: located.identity ? located : current.source ?? located });
    }
    const next = changeTracking(current, action, promptId, { commandNonce: invocation.commandNonce ?? null });
    const relative = chatRelative(context.project.id, client, sessionId);
    const written = await writeJSON(store.pin, relative, next, { expectedHash: found?.hash ?? null, maxBytes: CHAT_METADATA_BYTES });
    return { value: next, hash: written.hash, relative };
  });
}

/** A processing mutation may arrive from a relocated verified package before
 * its Stop hook. Retain that binding for an existing tracked chat before catch-up.
 * Read-only status and absent/untracked chats make no metadata writes here.
 */
export async function retainChatContract(store, invocation) {
  const { client, sessionId, cwd, action } = invocation;
  chatKey(client, sessionId);
  if (!store || action === 'status') return null;
  if (!['track', 'untrack', 'process', 'process project', 'save', 'skip'].includes(action)) fail('CHAT_ACTION_INVALID', 'Unsupported trusted command action.');
  let found;
  return withSelectedProject(store, async settings => {
    found = await findOwned(store, settings, client, sessionId);
    if (!found?.value.tracked) return null;
    return chooseProject(settings, cwd, { existingOwnerId: found.value.projectId })?.id ?? null;
  }, async () => {
    const next = retainChatClientContract(found.value, invocation.clientContract ?? null);
    if (JSON.stringify(next) === JSON.stringify(found.value)) return found;
    const written = await writeJSON(store.pin, found.relative, next, { expectedHash: found.hash, maxBytes: CHAT_METADATA_BYTES });
    return { value: next, hash: written.hash, relative: found.relative };
  });
}

/** Collectors and hooks use this bounded metadata operation. A collector passes
 * its exact inspected hash; concurrent tracking or source changes are conflicts.
 */
export async function updateChat(store, projectId, client, sessionId, { expectedHash, change }) {
  return withProject(store, projectId, async context => {
    const saved = await readProjectChat(store, context.project.id, client, sessionId);
    if (!saved || saved.hash !== expectedHash) fail('CHAT_CHANGED', 'Chat metadata changed after inspection; retry from its current state.');
    const next = validateChat(await change(saved.value, context));
    if (next.client !== client || next.sessionId !== sessionId || next.projectId !== projectId) fail('CHAT_IDENTITY_MISMATCH', 'A chat update cannot reassign native or project identity.');
    if (JSON.stringify(next.clientContracts) !== JSON.stringify(saved.value.clientContracts) || next.clientContractOverflow !== saved.value.clientContractOverflow) fail('CLIENT_CONTRACT_CHANGED', 'Only trusted native ingress or command bindings may retain installed skill identities.');
    if (JSON.stringify(next.history) !== JSON.stringify(saved.value.history)) {
      const settled = resolveChatHistoryBoundary(saved.value, next.history.inheritedBoundary, { generation: saved.value.generation });
      if (JSON.stringify(settled.history) !== JSON.stringify(next.history)) fail('CHAT_HISTORY_CHANGED', 'Initial enrollment history cannot change on resume or re-track.');
    }
    const written = await writeJSON(store.pin, saved.relative, next, { expectedHash: saved.hash, maxBytes: CHAT_METADATA_BYTES });
    return { value: next, hash: written.hash, relative: saved.relative };
  });
}

/** The source was verified outside the gate. The durable metadata intent keeps
 * this part ineligible for processing until its append AND bookmark are durable.
 * A crash at either publication is retried with the exact reconstructed part.
 */
export async function commitChatPart(store, projectId, client, sessionId,
  { expectedHash, generation, checkpoint, requestId, record: input }) {
  const record = inputRecord(input);
  return withProject(store, projectId, async context => {
    const saved = await readProjectChat(store, context.project.id, client, sessionId);
    if (!saved || saved.hash !== expectedHash) fail('CHAT_CHANGED', 'Chat metadata changed after source inspection.');
    const staged = stageChatPart(saved.value, { generation, recordId: record.id, hash: record.hash, checkpoint });
    const intent = await writeJSON(store.pin, saved.relative, staged, { expectedHash: saved.hash, maxBytes: CHAT_METADATA_BYTES });
    const relative = queueRelative(client, sessionId);
    const queue = await inspectQueue(store.pin, relative);
    if (queue.pending?.op === 'append') {
      if (queue.pending.id !== record.id || queue.pending.hash !== record.hash) fail('CHAT_PART_CONFLICT', 'Pending queue data differs from the retained chat append intent.');
      await recoverQueueAppend(store.pin, relative, { record, expectedTailHash: queue.pending.part?.hash ?? null });
    }
    await appendQueueRecord(store.pin, relative, record);
    const value = advanceChat(staged, { generation, checkpoint, requestId, record });
    const written = await writeJSON(store.pin, saved.relative, value, { expectedHash: intent.hash, maxBytes: CHAT_METADATA_BYTES });
    return { value, hash: written.hash, relative: saved.relative };
  });
}

/** Select only the committed prefix, even when a source is unavailable and an
 * interrupted append remains. Input becomes eligible at bookmark publication.
 */
export async function selectChatQueue(store, projectId, client, sessionId, options = {}) {
  return withProject(store, projectId, async context => {
    const saved = await readProjectChat(store, context.project.id, client, sessionId);
    if (!saved) return [];
    const selected = await selectQueue(store.pin, queueRelative(client, sessionId), { ...options, allowPendingAppend: true });
    const boundary = selected.findIndex(record => record.id === saved.value.uncommitted?.recordId);
    return boundary < 0 ? selected : selected.slice(0, boundary);
  });
}
