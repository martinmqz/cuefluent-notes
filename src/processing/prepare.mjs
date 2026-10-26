import { validateResult } from '../core/result.mjs';
import { fail } from '../core/errors.mjs';
import { createRun, validateRun, validateRunScope } from '../core/run.mjs';
import { hashBytes, readJSON, writeJSON } from '../storage/files.mjs';
import { withProject } from '../storage/store.mjs';
import { readProjectChat, iterateProjectChats, selectChatQueue, queueRelative } from '../storage/chats.mjs';
import { readQueueRecord } from '../storage/queue.mjs';

export const INPUT_BUDGET = Object.freeze({ bytes: 96 * 1024, records: 128 });
const warningCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : 'CATCHUP_FAILED';

async function pending(store, context) {
  const saved = await readJSON(store.pin, `${context.directory}/run.json`, { missing: true });
  if (!saved) return null;
  const run = validateRun(saved.value);
  if (run.projectId !== context.project.id) fail('RUN_CHANGED', 'Pending work belongs to another project.');
  return run;
}

async function* candidates(store, projectId, scope, onWarning) {
  if (scope.kind === 'project') yield* iterateProjectChats(store, projectId, { onWarning });
  else {
    const chat = await readProjectChat(store, projectId, scope.client, scope.sessionId);
    if (chat) yield chat;
  }
}

/** Catch up every tracked candidate, including empty queues. The model budget
 * limits this run's selection, never the stored backlog. Callbacks may read native
 * sources but cannot run inside the short publication gate.
 */
export async function prepareProcessing(store, projectId, inputScope, { reconcileChat,
  inputBytes = INPUT_BUDGET.bytes, maxRecords = INPUT_BUDGET.records } = {}) {
  const scope = validateRunScope(inputScope);
  if (scope.kind === 'direct') fail('PROCESSING_SCOPE_INVALID', 'Direct notes do not select queued conversation.');
  if (typeof reconcileChat !== 'function') fail('PROCESSING_RECONCILER_REQUIRED', 'Provide the native chat reconciler.');
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 64 * 1024 || inputBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > INPUT_BUDGET.records) fail('PROCESSING_BUDGET_INVALID', 'Use a verified bounded model input budget.');
  const existing = await withProject(store, projectId, context => pending(store, context));
  if (existing) return { state: 'pending', run: existing, scopeMatches: JSON.stringify(existing.scope) === JSON.stringify(scope) };
  let bytes = 0, failures = 0;
  const selection = [], warnings = [];
  const warn = (code, chat) => {
    failures++;
    if (warnings.length < 127) warnings.push(`${code} (${chat.client}, chat ${hashBytes(chat.sessionId).slice(0, 16)})`);
  };
  for await (const candidate of candidates(store, projectId, scope, code => { failures++; if (warnings.length < 127) warnings.push(code); })) {
    const chat = candidate.value;
    if (chat.tracked) {
      try {
        const result = await reconcileChat({ client: chat.client, sessionId: chat.sessionId });
        if (result.status === 'pending') warn(warningCode({ code: result.reason }), chat);
      } catch (error) { warn(warningCode(error), chat); }
    }
    if (selection.length >= maxRecords || bytes >= inputBytes) continue;
    try {
      const records = await selectChatQueue(store, projectId, chat.client, chat.sessionId, { limit: maxRecords - selection.length });
      for (const record of records) {
        if (bytes + record.bytes.length > inputBytes) {
          if (selection.length === 0) fail('PROCESSING_INPUT_TOO_LARGE', 'A normalized part does not fit this model input budget; preserve it and select a supported capacity.');
          break;
        }
        selection.push({ client: chat.client, sessionId: chat.sessionId, recordId: record.id, hash: record.hash });
        bytes += record.bytes.length;
      }
    } catch (error) {
      if (error.code === 'PROCESSING_INPUT_TOO_LARGE') throw error;
      warn(warningCode(error), chat);
    }
  }
  if (failures > warnings.length) warnings.push(`${failures - warnings.length} additional catch-up or queue problems.`);
  return withProject(store, projectId, async context => {
    const competing = await pending(store, context);
    if (competing) return { state: 'pending', run: competing, scopeMatches: JSON.stringify(competing.scope) === JSON.stringify(scope) };
    if (!selection.length) {
      const result = validateResult({ schemaVersion: 1, runId: null, projectId, status: 'empty', paths: [],
        counts: { handled: 0, saved: 0, remaining: warnings.length ? null : 0 }, warnings });
      const prior = await readJSON(store.pin, `${context.directory}/result.json`, { missing: true });
      await writeJSON(store.pin, `${context.directory}/result.json`, result, { expectedHash: prior?.hash ?? null });
      return { state: 'empty', projectId, runId: null, result };
    }
    // Recheck each exact frozen record and bookmark eligibility. Concurrent
    // appends are harmless; a changed selected record is never silently refreshed.
    const chats = new Map();
    for (const item of selection) {
      const key = JSON.stringify([item.client, item.sessionId]);
      if (!chats.has(key)) chats.set(key, await readProjectChat(store, projectId, item.client, item.sessionId));
      const chat = chats.get(key);
      if (!chat || chat.value.uncommitted?.recordId === item.recordId) fail('PROCESSING_SELECTION_CHANGED', 'Selected input is no longer committed to its chat bookmark.');
      await readQueueRecord(store.pin, queueRelative(item.client, item.sessionId), { id: item.recordId, hash: item.hash });
    }
    const run = validateRun({ ...createRun(context.project, selection, { scope }), warnings });
    await writeJSON(store.pin, `${context.directory}/run.json`, run, { expectedHash: null });
    return { state: 'created', run, inputBytes: bytes };
  });
}

/** Worker reads only the frozen selection. A caller supplies an aggregate model
 * budget; newly appended records never enter an existing run's prompt.
 */
export async function readProcessingInput(store, inputRun, { maxBytes = INPUT_BUDGET.bytes } = {}) {
  const run = validateRun(inputRun), parts = [];
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) fail('PROCESSING_BUDGET_INVALID', 'Invalid input byte budget.');
  let bytes = 0;
  for (const selected of run.selection) {
    const record = await readQueueRecord(store.pin, queueRelative(selected.client, selected.sessionId), { id: selected.recordId, hash: selected.hash });
    bytes += record.bytes.length;
    if (bytes > maxBytes) fail('PROCESSING_INPUT_TOO_LARGE', 'Frozen input exceeds the selected model budget.');
    parts.push(record.data);
  }
  return Object.freeze({ parts: Object.freeze(parts), bytes });
}
