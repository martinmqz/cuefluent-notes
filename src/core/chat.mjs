import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fail } from './errors.mjs';
import { assertAbsolute } from '../storage/paths.mjs';
import { nativeId, validateCheckpoint } from '../transcript/checkpoint.mjs';

function object(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('CHAT_INVALID', 'Chat metadata must use plain objects.');
  const fields = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(fields);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable)) {
    fail('CHAT_INVALID', 'Chat metadata contains unsupported or missing fields.');
  }
}

function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('CHAT_INVALID', 'A chat generation or request requires a UUID.');
  return value;
}

export const CLIENT_CONTRACT_LIMITS = Object.freeze({ identities: 8, pathBytes: 4096 });

/** An installed package supplies this identity. Validation grants no authority
 * to model arguments or transcript text. No package discovery or filesystem IO.
 */
export function validateClientContract(input, { nullable = true } = {}) {
  if (input === null && nullable) return null;
  object(input, ['name', 'skillPath']);
  if (typeof input.name !== 'string' || !input.name || input.name === '.' || input.name === '..' || input.name.length > 256 || /[\s/\\\u0000-\u001f\u007f]/.test(input.name)) fail('CLIENT_CONTRACT_INVALID', 'The installed skill name is invalid.');
  assertAbsolute(input.skillPath);
  if (Buffer.byteLength(input.skillPath) > CLIENT_CONTRACT_LIMITS.pathBytes) fail('CLIENT_CONTRACT_PATH_LIMIT', 'The installed skill path exceeds the bounded command identity profile.');
  if (path.basename(input.skillPath) !== 'SKILL.md') fail('CLIENT_CONTRACT_INVALID', 'The installed skill identity must name SKILL.md.');
  return Object.freeze({ name: input.name, skillPath: input.skillPath });
}

/** Append only verified installed identities. Never discard an older identity:
 * earlier selected commands still need exclusion after an installed path change.
 * Overflow blocks collection while allowing an explicit opt-out to take effect.
 */
export function retainChatClientContract(input, contract) {
  const chat = validateChat(input);
  let identity;
  try { identity = validateClientContract(contract); }
  catch (error) {
    if (error.code !== 'CLIENT_CONTRACT_PATH_LIMIT') throw error;
    return validateChat({ ...chat, clientContractOverflow: true });
  }
  if (identity === null || chat.clientContracts.some(item => item.name === identity.name && item.skillPath === identity.skillPath)) return chat;
  if (chat.clientContracts.length >= CLIENT_CONTRACT_LIMITS.identities) return validateChat({ ...chat, clientContractOverflow: true });
  return validateChat({ ...chat, clientContracts: [...chat.clientContracts, identity] });
}

function source(input) {
  if (input === null) return null;
  object(input, ['path', 'identity']);
  assertAbsolute(input.path);
  if (input.path.length > 32768) fail('CHAT_INVALID', 'The source path is too long.');
  if (input.identity === null) return Object.freeze({ path: input.path, identity: null });
  object(input.identity, ['device', 'inode']);
  for (const value of Object.values(input.identity)) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(value)) fail('CHAT_INVALID', 'Source identity must use exact integer strings.');
  }
  return Object.freeze({ path: input.path, identity: Object.freeze({ ...input.identity }) });
}

export function validateHistorySources(input, { client } = {}) {
  if (!Array.isArray(input) || input.length > 32 || (client !== 'codex' && input.length)) fail('CHAT_HISTORY_INVALID', 'Historical source capabilities exceed the native profile.');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== input.length + 1 || Array.from({ length: input.length }, (_, index) => descriptors[index]).some(item => !item || !Object.hasOwn(item, 'value') || !item.enumerable)) fail('CHAT_HISTORY_INVALID', 'Historical source capabilities require dense inert lists.');
  const seen = new Set();
  return Object.freeze(input.map(item => {
    object(item, ['sessionId', 'source', 'before', 'hash']); nativeId(item.sessionId);
    const physical = source(item.source); if (!physical?.identity) fail('CHAT_HISTORY_INVALID', 'A historical source requires its exact retained inode.');
    object(item.before, ['ordinalExclusive', 'byteOffset']);
    if (!Number.isSafeInteger(item.before.ordinalExclusive) || item.before.ordinalExclusive < 1 || !Number.isSafeInteger(item.before.byteOffset) || item.before.byteOffset < 1 || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) fail('CHAT_HISTORY_INVALID', 'A historical source requires its exact native cutoff and prefix hash.');
    const key = JSON.stringify([item.sessionId, item.before.ordinalExclusive, item.before.byteOffset]); if (seen.has(key)) fail('CHAT_HISTORY_INVALID', 'A historical cutoff has ambiguous physical capabilities.'); seen.add(key);
    return Object.freeze({ sessionId: item.sessionId, source: physical, before: Object.freeze({ ordinalExclusive: item.before.ordinalExclusive, byteOffset: item.before.byteOffset }), hash: item.hash });
  }));
}

/** Initial enrollment policy is immutable. Hook-provided inherited boundaries
 * are exact prefix metadata, never inferred from an EOF or copied prompt ID. */
export function validateChatHistory(input, { client } = {}) {
  object(input, ['mode', 'startSource', 'inheritedBoundary', ...(Object.hasOwn(input ?? {}, 'startPromptId') ? ['startPromptId'] : [])]);
  if (Object.hasOwn(input, 'startPromptId')) {
    if (input.mode !== 'automatic' || input.startSource !== 'prompt') fail('CHAT_HISTORY_INVALID', 'A prompt enrollment boundary belongs to automatic prompt tracking.');
    nativeId(input.startPromptId);
  }
  if (!['manual', 'automatic'].includes(input.mode) || !['prompt', 'startup', 'resume', 'fork', 'clear', 'compact'].includes(input.startSource)) fail('CHAT_HISTORY_INVALID', 'Unsupported native enrollment history policy.');
  if (input.startSource === 'prompt' && !Object.hasOwn(input, 'startPromptId')) fail('CHAT_HISTORY_INVALID', 'Prompt enrollment requires its first native prompt identity.');
  let inheritedBoundary = null;
  if (input.inheritedBoundary !== null) {
    if (client !== 'claude' || input.mode !== 'automatic' || input.startSource !== 'fork') fail('CHAT_HISTORY_INVALID', 'Only an automatically enrolled Claude fork accepts a separately verified inherited prefix.');
    const prefix = input.inheritedBoundary;
    object(prefix, ['endByteOffset', 'hash', 'anchor']);
    if (!Number.isSafeInteger(prefix.endByteOffset) || prefix.endByteOffset < 0 || typeof prefix.hash !== 'string' || !/^[a-f0-9]{64}$/.test(prefix.hash)) fail('CHAT_HISTORY_INVALID', 'The inherited prefix requires an exact size and hash.');
    let anchor = null;
    if (prefix.endByteOffset !== 0) {
      object(prefix.anchor, ['start', 'end', 'hash', 'rowId']);
      if (!Number.isSafeInteger(prefix.anchor.start) || prefix.anchor.start < 0 || prefix.anchor.end !== prefix.endByteOffset || prefix.anchor.start >= prefix.anchor.end ||
          typeof prefix.anchor.hash !== 'string' || !/^[a-f0-9]{64}$/.test(prefix.anchor.hash)) fail('CHAT_HISTORY_INVALID', 'The inherited prefix requires its exact last complete native row.');
      anchor = Object.freeze({ ...prefix.anchor, rowId: nativeId(prefix.anchor.rowId) });
    } else if (prefix.anchor !== null) fail('CHAT_HISTORY_INVALID', 'An empty inherited prefix has no source anchor.');
    inheritedBoundary = Object.freeze({ endByteOffset: prefix.endByteOffset, hash: prefix.hash, anchor });
  }
  return Object.freeze({ mode: input.mode, startSource: input.startSource, inheritedBoundary,
    ...(Object.hasOwn(input, 'startPromptId') ? { startPromptId: input.startPromptId } : {}) });
}

function completion(input) {
  if (input === null) return null;
  object(input, ['promptId', 'kind', 'finalTextHash']);
  nativeId(input.promptId);
  if (!['completed', 'interrupted', 'failed', 'observed'].includes(input.kind) ||
      !(input.finalTextHash === null || input.kind !== 'observed' && typeof input.finalTextHash === 'string' && /^[a-f0-9]{64}$/.test(input.finalTextHash))) {
    fail('CHAT_INVALID', 'The native completion expectation is invalid.');
  }
  return Object.freeze({ ...input });
}

export function validateChat(input) {
  object(input, ['schemaVersion', 'client', 'sessionId', 'projectId', 'tracked', 'optOut', 'generation', 'source', 'sourceCandidate', 'history', 'historySources', 'clientContracts', 'clientContractOverflow', 'checkpoint', 'pending', 'uncommitted']);
  if (input.schemaVersion !== 1) fail('CHAT_SCHEMA_UNSUPPORTED', 'Unsupported chat metadata schema.');
  if (!['claude', 'codex'].includes(input.client) || typeof input.projectId !== 'string' || input.projectId.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.projectId) || typeof input.tracked !== 'boolean' || typeof input.optOut !== 'boolean' ||
      input.tracked && input.optOut) fail('CHAT_INVALID', 'The chat identity or tracking state is invalid.');
  nativeId(input.sessionId); uuid(input.generation);
  const checkedSource = source(input.source);
  const sourceCandidate = source(input.sourceCandidate), history = validateChatHistory(input.history, { client: input.client });
  if (!Array.isArray(input.clientContracts) || input.clientContracts.length > CLIENT_CONTRACT_LIMITS.identities || typeof input.clientContractOverflow !== 'boolean') fail('CLIENT_CONTRACT_INVALID', 'Stored installed skill identities exceed the supported profile.');
  const clientContracts = Object.freeze(input.clientContracts.map(item => validateClientContract(item, { nullable: false })));
  if (new Set(clientContracts.map(item => JSON.stringify(item))).size !== clientContracts.length) fail('CLIENT_CONTRACT_INVALID', 'Stored installed skill identities must be unique.');
  const checkpoint = validateCheckpoint(input.checkpoint, { client: input.client, sessionId: input.sessionId });
  if (!checkedSource?.identity && (checkpoint.offset || checkpoint.scanOffset || checkpoint.anchor)) fail('CHAT_INVALID', 'An advanced source bookmark requires its source identity.');
  let uncommitted = null;
  if (input.uncommitted !== null) {
    object(input.uncommitted, ['recordId', 'hash', 'checkpoint']);
    if (typeof input.uncommitted.recordId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.uncommitted.recordId) ||
        typeof input.uncommitted.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.uncommitted.hash) || !checkedSource?.identity) {
      fail('CHAT_INVALID', 'The uncommitted part must identify exact inspected source data.');
    }
    uncommitted = Object.freeze({ recordId: input.uncommitted.recordId, hash: input.uncommitted.hash,
      checkpoint: validateCheckpoint(input.uncommitted.checkpoint, { client: input.client, sessionId: input.sessionId }) });
  }
  let pending = null;
  if (input.pending !== null) {
    object(input.pending, ['id', 'reason', 'beforePromptId', 'commandNonce', 'completion']);
    if (!['track', 'untrack', 'native', 'periodic'].includes(input.pending.reason) ||
        !input.tracked && input.pending.reason !== 'untrack') fail('CHAT_INVALID', 'The pending reconciliation does not match tracking consent.');
    if (input.pending.beforePromptId !== null) nativeId(input.pending.beforePromptId);
    if (input.pending.commandNonce !== null) {
      const nonce = input.pending.commandNonce;
      if (!(typeof nonce === 'string' && (/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce) ||
          /^[A-Za-z0-9_-]{86}$/.test(nonce) && Buffer.from(nonce, 'base64url').length === 64 && Buffer.from(nonce, 'base64url').toString('base64url') === nonce))) fail('CHAT_INVALID', 'A native command boundary requires a UUIDv4 or canonical opaque handle.');
      if (input.client !== 'claude' || !['track', 'untrack'].includes(input.pending.reason)) fail('CHAT_INVALID', 'A command boundary nonce belongs only to an explicit Claude tracking invocation.');
    }
    if (['track', 'untrack'].includes(input.pending.reason) && input.pending.beforePromptId === null) fail('CHAT_INVALID', 'Explicit tracking changes require their native command boundary.');
    pending = Object.freeze({ id: uuid(input.pending.id), reason: input.pending.reason,
      beforePromptId: input.pending.beforePromptId, commandNonce: input.pending.commandNonce, completion: completion(input.pending.completion) });
  }
  return Object.freeze({ schemaVersion: 1, client: input.client, sessionId: input.sessionId, projectId: input.projectId,
    tracked: input.tracked, optOut: input.optOut, generation: input.generation, source: checkedSource, sourceCandidate, history, historySources: validateHistorySources(input.historySources, { client: input.client }), clientContracts, clientContractOverflow: input.clientContractOverflow, checkpoint, pending, uncommitted });
}

/** No I/O and no enrollment. The caller binds the first owner under store gates. */
export function createChat({ client, sessionId, projectId, source = null, clientContract = null, history = { mode: 'manual', startSource: 'startup', inheritedBoundary: null } }) {
  return retainChatClientContract(validateChat({ schemaVersion: 1, client, sessionId, projectId, tracked: false, optOut: false,
    generation: randomUUID(), source, sourceCandidate: null, history, historySources: [], clientContracts: [], clientContractOverflow: false, checkpoint: null, pending: null, uncommitted: null }), clientContract);
}

/** The caller has independently resolved active native history and verified the
 * exact retained anchor outside the mutation gate. This pure transition grants
 * no source authority and never abandons an interrupted queue publication. */
export function rebindChatSource(input, { generation, source: nextSource, checkpoint }) {
  const chat = validateChat(input);
  if (generation !== chat.generation) fail('CHAT_GENERATION_CHANGED', 'Tracking changed while native history was being resolved.');
  if (chat.uncommitted) fail('CHAT_PART_UNCOMMITTED', 'Finish the exact interrupted append before changing native source.');
  const next = validateCheckpoint(checkpoint, { client: chat.client, sessionId: chat.sessionId });
  const sameMeaning = point => ({ ...point, offset: 0, scanOffset: 0,
    anchor: point.anchor && { hash: point.anchor.hash, rowId: point.anchor.rowId, edge: point.offset === point.anchor.start ? 'start' : 'end' },
    exchange: point.exchange && { ...point.exchange, start: 0 } });
  const inactive = point => !point.cursor && !point.boundary && (!point.exchange || point.exchange.completed) &&
    point.scanOffset === point.offset && (point.anchor === null ? point.offset === 0 :
      point.offset === point.anchor.end || !point.exchange && point.offset === point.anchor.start);
  if (!inactive(chat.checkpoint) || !inactive(next) ||
      JSON.stringify(sameMeaning(chat.checkpoint)) !== JSON.stringify(sameMeaning(next))) fail('CHAT_SOURCE_TRANSITION_INVALID', 'A source transition must preserve the exact retained native record and exchange identity.');
  return validateChat({ ...chat, source: nextSource, sourceCandidate: null, checkpoint: next });
}

/** Call only after native authority's supplied prefix was verified against the
 * exact source bytes outside the gate. Unknown may settle once before collection;
 * a known inherited boundary and the enrollment semantics never change. */
export function resolveChatHistoryBoundary(input, inheritedBoundary, { generation } = {}) {
  const chat = validateChat(input);
  if (generation !== chat.generation) fail('CHAT_GENERATION_CHANGED', 'Tracking changed while native inheritance was being verified.');
  const history = validateChatHistory({ ...chat.history, inheritedBoundary }, { client: chat.client });
  if (JSON.stringify(history) === JSON.stringify(chat.history)) return chat;
  const point = chat.checkpoint;
  if (!chat.pending || chat.history.inheritedBoundary !== null || history.inheritedBoundary === null || chat.uncommitted ||
      point.offset !== 0 || point.scanOffset !== 0 || point.anchor || point.exchange || point.cursor || point.boundary) fail('CHAT_HISTORY_CHANGED', 'An inherited boundary may settle only once before any collection.');
  return validateChat({ ...chat, history });
}

/** A generation change fences collectors before the final untrack catch-up.
 * Re-track preserves the bookmark and includes the interval spent untracked.
 */
export function changeTracking(input, action, promptId, { commandNonce = null } = {}) {
  const chat = validateChat(input); nativeId(promptId);
  if (!['track', 'untrack'].includes(action)) fail('CHAT_ACTION_INVALID', 'Choose track or untrack.');
  if (action === 'untrack' && !chat.tracked) return validateChat({ ...chat, optOut: true, generation: randomUUID() });
  return validateChat({ ...chat, tracked: action === 'track', optOut: action === 'untrack', generation: randomUUID(),
    pending: { id: randomUUID(), reason: action, beforePromptId: promptId, commandNonce, completion: null } });
}

export function requestReconciliation(input, expectation = null) {
  const chat = validateChat(input);
  if (!chat.tracked) return chat;
  // A later completion hook cannot erase an explicit invocation's required
  // boundary proof. Periodic reconciliation continues after that boundary settles.
  if (chat.pending?.reason === 'track') return chat;
  if (expectation?.kind === 'observed' && chat.pending?.completion?.promptId === expectation.promptId && chat.pending.completion.kind !== 'observed') return chat;
  return validateChat({ ...chat, pending: { id: randomUUID(), reason: expectation ? 'native' : 'periodic', beforePromptId: null, commandNonce: null, completion: completion(expectation) } });
}

/** Publish only after durable queue append under a rechecked chat file hash.
 * Completing an older request never erases a newer hook's pending request.
 */
export function advanceChat(input, { generation, checkpoint, requestId, complete = false, record = null }) {
  const chat = validateChat(input);
  if (chat.generation !== generation) fail('CHAT_GENERATION_CHANGED', 'Tracking changed while the source was being collected.');
  let next = validateCheckpoint(checkpoint, { client: chat.client, sessionId: chat.sessionId });
  if (chat.uncommitted && (record?.id !== chat.uncommitted.recordId || record?.hash !== chat.uncommitted.hash ||
      JSON.stringify(next) !== JSON.stringify(chat.uncommitted.checkpoint))) fail('CHAT_PART_UNCOMMITTED', 'Complete the exact interrupted append before advancing its bookmark.');
  if (next.offset < chat.checkpoint.offset || next.scanOffset < chat.checkpoint.scanOffset) fail('CHAT_CHECKPOINT_REWIND', 'Normal collection cannot rewind a retained bookmark.');
  if (complete && chat.pending?.id === requestId && next.boundary) next = validateCheckpoint({ ...next, boundary: null,
    anchor: next.offset === 0 && next.exchange === null ? null : next.anchor }, { client: chat.client, sessionId: chat.sessionId });
  return validateChat({ ...chat, checkpoint: next, pending: complete && chat.pending?.id === requestId ? null : chat.pending, uncommitted: null });
}

/** Record metadata before append. Processing excludes this one ID until the
 * exact append and subsequent bookmark publication both become durable.
 */
export function stageChatPart(input, { generation, recordId, hash, checkpoint }) {
  const chat = validateChat(input);
  if (chat.generation !== generation) fail('CHAT_GENERATION_CHANGED', 'Tracking changed while the source was being collected.');
  const next = validateChat({ ...chat, uncommitted: { recordId, hash, checkpoint } });
  if (chat.uncommitted && JSON.stringify(chat.uncommitted) !== JSON.stringify(next.uncommitted)) fail('CHAT_PART_CONFLICT', 'The reconstructed part differs from its retained append intent.');
  return next;
}
