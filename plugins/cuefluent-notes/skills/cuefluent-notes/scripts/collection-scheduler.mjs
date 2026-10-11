import fs from 'node:fs/promises';
import path from 'node:path';
import { intakePath, intakeSnapshot, intakeJSON, withIntakeLock, replaceIntakeJSON } from './intake-io.mjs';
import { assertWorkflowStorage } from './workflow-storage.mjs';
import { registrationPath, registrationShard } from './collection-ingress.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { keys, choice, nativeId, fail } from './workflow-values.mjs';

export const schedulerPath = 'ingress/scheduler/record.json';
const clients = ['codex', 'claude'];
const ordinal = ({ client, shard }) => clients.indexOf(client) * 256 + parseInt(shard, 16);
const report = (pending, code) => { if (!pending.includes(code)) pending.push(code); };
function validateCursor(value) {
  if (value === null) return;
  keys(value, ['client', 'shard', 'sessionId']); choice(value.client, clients);
  if (!/^[a-f0-9]{2}$/.test(value.shard)) fail('INVALID_COLLECTION_SCHEDULER');
  if (value.sessionId !== null) { nativeId(value.sessionId); if (registrationShard(value.sessionId) !== value.shard) fail('INVALID_COLLECTION_SCHEDULER'); }
}
export async function readCollectionScheduler(store) {
  const snapshot = await intakeSnapshot(store, 'state', schedulerPath, { maxBytes: 16384 });
  const value = intakeJSON(snapshot) ?? { version: 1, cursor: null, triggerFirst: true };
  keys(value, ['version', 'cursor', 'triggerFirst']); validateCursor(value.cursor);
  if (value.version !== 1 || typeof value.triggerFirst !== 'boolean') fail('INVALID_COLLECTION_SCHEDULER');
  return { value, hash: snapshot.hash };
}
/** Reserve one attempt, never an unprocessed page. Even parsing or authorization
 * that exhausts the budget cannot pin every subsequent pass to the same entry. */
export async function reserveCollectionAttempt(capability, store, expected, value) {
  return withIntakeLock(store, async tx => {
    await assertWorkflowStorage(capability);
    const current = await readCollectionScheduler(store);
    if (current.hash !== expected.hash) fail('COLLECTION_SCHEDULER_CHANGED');
    validateCursor(value.cursor);
    const saved = await replaceIntakeJSON(tx, schedulerPath, value, expected.hash);
    return { value, hash: saved };
  });
}

/** Only complete, bounded shard enumerations are sorted/paged. There is no
 * lifetime registration inventory or dependence on filesystem listing order. */
export async function* collectionJobs(store, cursor, pending) {
  validateCursor(cursor);
  const groups = [];
  for (const client of clients) {
    const root = path.dirname(await intakePath(store, 'state', `ingress/registrations/${client}/.scan`));
    let count = 0, found = [];
    try {
      for await (const entry of await fs.opendir(root)) {
        checkWorkflowBudget();
        if (++count > 512) { report(pending, 'REGISTRATION_SHARDS_CAPACITY'); found = []; break; }
        if (!entry.isDirectory() || !/^[a-f0-9]{2}$/.test(entry.name)) { report(pending, 'INVALID_REGISTRATION_SHARD'); continue; }
        found.push({ client, shard: entry.name });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    groups.push(...found);
  }
  checkWorkflowBudget(); groups.sort((a, b) => ordinal(a) - ordinal(b));
  const cached = new Map();
  async function members(group) {
    const key = ordinal(group); if (cached.has(key)) return cached.get(key);
    const names = []; let count = 0, diagnostic = null;
    try {
      const root = path.dirname(await intakePath(store, 'state', `ingress/registrations/${group.client}/${group.shard}/.scan`));
      for await (const entry of await fs.opendir(root)) {
        checkWorkflowBudget();
        if (++count > 2048) { diagnostic = 'REGISTRATION_SHARD_CAPACITY'; names.length = 0; break; }
        try { nativeId(entry.name); } catch { report(pending, 'INVALID_REGISTRATION'); continue; }
        if (!entry.isDirectory() || registrationShard(entry.name) !== group.shard) { report(pending, 'INVALID_REGISTRATION'); continue; }
        names.push(entry.name);
      }
    } catch (error) {
      if (['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'UNSAFE_INTAKE_PATH'].includes(error.code)) {
        names.length = 0; diagnostic = 'REGISTRATION_SHARD_UNAVAILABLE';
      } else if (error.code !== 'ENOENT') throw error;
    }
    checkWorkflowBudget(); names.sort();
    const result = { names, diagnostic }; cached.set(key, result); return result;
  }
  for (const phase of [0, 1]) {
    if (phase === 1 && cursor === null) break;
    for (const group of groups) {
      const same = cursor !== null && ordinal(group) === ordinal(cursor);
      const after = cursor === null || ordinal(group) > ordinal(cursor) || (same && cursor.sessionId !== null);
      if (!same && after !== (phase === 0)) continue;
      if (same && cursor.sessionId === null && phase === 0) continue;
      const { names, diagnostic } = await members(group);
      if (!names.length) {
        if (same && cursor.sessionId !== null && phase === 1) continue;
        yield { cursor: { ...group, sessionId: null }, diagnostic, maintenance: true }; continue;
      }
      for (const sessionId of names) {
        if (same && cursor.sessionId !== null && (sessionId > cursor.sessionId) !== (phase === 0)) continue;
        yield { client: group.client, sessionId, file: registrationPath({ client: group.client, sessionId }), cursor: { ...group, sessionId } };
      }
    }
  }
}
