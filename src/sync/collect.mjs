import { createHash } from 'node:crypto';
import { advanceChat, rebindChatSource, requestReconciliation, resolveChatHistoryBoundary, validateChat, validateHistorySources } from '../core/chat.mjs';
import { fail } from '../core/errors.mjs';
import { openTranscript } from '../client/source.mjs';
import { createHistoricalCommandClassifiers } from '../client/historical-commands.mjs';
import { resolveClaudeCommandBoundary, resolveNativeHistory, reanchorNativeCheckpoint } from '../client/history.mjs';
import { normalizeTranscript } from '../transcript/index.mjs';
import { hashBytes } from '../storage/files.mjs';
import { encodeQueueRecord } from '../storage/queue-format.mjs';
import { readChat, updateChat, commitChatPart } from '../storage/chats.mjs';

/** Stable part identity is independent of collection timing and queue layout. */
export function transcriptPartRecord(part) {
  if (!part || !['claude', 'codex'].includes(part.client) || typeof part.sessionId !== 'string' ||
      typeof part.exchangeId !== 'string' || !Number.isSafeInteger(part.partIndex) || part.partIndex < 0) {
    fail('TRANSCRIPT_PART_INVALID', 'The normalized part has no stable native identity.');
  }
  const id = hashBytes(JSON.stringify([part.client, part.sessionId, part.exchangeId, part.partIndex]));
  return encodeQueueRecord(id, Buffer.from(JSON.stringify(part)));
}

function satisfied(chat, size) {
  const { checkpoint: point, pending } = chat;
  if (chat.uncommitted) return false;
  if (pending?.beforePromptId !== null && pending?.beforePromptId !== undefined) {
    return point.boundary?.promptId === pending.beforePromptId && point.boundary.start !== null &&
      point.offset >= point.boundary.start;
  }
  if (point.cursor) return false;
  if (point.offset !== size || point.exchange && !point.exchange.completed) return false;
  if (pending?.completion) return point.exchange?.promptId === pending.completion.promptId && point.exchange.completed;
  return true;
}

/** One bounded reconciliation, without a model. Eligibility is checked before
 * opening a native source. Source parsing/hashing never holds a mutation gate.
 * A pending reason preserves all previously committed queue data for processing.
 */
export async function collectChat(store, { client, sessionId, classifyCommand = null, resolveNativeSource = null, limits = {} }) {
  let saved;
  try { saved = await readChat(store, client, sessionId); }
  catch (error) {
    if (error.code !== 'FILE_CHANGED') throw error;
    return { status: 'pending', reason: 'FILE_CHANGED', parts: 0 };
  }
  if (!saved) return { status: 'unconfigured', parts: 0 };
  if (!saved.value.tracked && saved.value.pending?.reason !== 'untrack') return { status: 'untracked', parts: 0 };
  if (saved.value.clientContractOverflow) return { status: 'pending', reason: 'CLIENT_CONTRACT_LIMIT', parts: 0 };
  if (classifyCommand === null) {
    if (!saved.value.clientContracts.length) return { status: 'pending', reason: 'CLIENT_CONTRACT_UNAVAILABLE', parts: 0 };
    classifyCommand = createHistoricalCommandClassifiers({ client, clientContracts: saved.value.clientContracts, limits });
  }
  if (typeof classifyCommand !== 'function') fail('TRANSCRIPT_COMMAND_INVALID', 'Collection requires a native historical command classifier.');
  if (resolveNativeSource !== null && typeof resolveNativeSource !== 'function') fail('SOURCE_RESOLVER_INVALID', 'Native source authority must be a trusted callback.');
  if (!saved.value.source && !resolveNativeSource) return { status: 'pending', reason: 'SOURCE_UNAVAILABLE', parts: 0 };
  if (saved.value.sourceCandidate && !resolveNativeSource) return { status: 'pending', reason: 'SOURCE_TRANSITION_PENDING', parts: 0 };
  let source, active, parts = 0, pendingReason = null, nativeCompletion = null;
  const initialCheckpoint = JSON.stringify(saved.value.checkpoint), historySources = [];
  const progress = () => parts > 0 || JSON.stringify(saved.value.checkpoint) !== initialCheckpoint ? { progress: true } : {};
  const projectId = saved.value.projectId, generation = saved.value.generation;
  let requestId = saved.value.pending?.id;
  try {
    // resolveNativeSource is native authority, not model input. With a provider,
    // ask for the active native source on every pass: an old revert file may
    // remain readable while no longer belonging to the selected native history.
    // Return {path,source} with an independently verified physical capability;
    // before:null selects active, historical calls carry native ordinal/byte cut.
    const resolved = resolveNativeSource ? await resolveNativeSource(Object.freeze({ client, sessionId, previous: saved.value.source,
      candidate: saved.value.sourceCandidate, historySources: saved.value.historySources, before: null, excludeIdentity: null })) : null;
    if (resolveNativeSource && !resolved) return { status: 'pending', reason: 'SOURCE_UNAVAILABLE', parts };
    active = resolved ? resolved.source : await openTranscript(saved.value.source.path, { identity: saved.value.source.identity });
    if (!active) return { status: 'pending', reason: 'SOURCE_UNAVAILABLE', parts };
    if (typeof active.verify !== 'function' || typeof active.close !== 'function' || !active.identity) fail('SOURCE_RESOLVER_INVALID', 'A native resolver must provide a verified physical source capability.');
    const located = validateChat({ ...saved.value, source: { path: resolved ? resolved.path : saved.value.source.path, identity: active.identity } }).source;
    await active.verify();
    if (resolved?.completion && !['track', 'untrack'].includes(saved.value.pending?.reason)) {
      const incoming = resolved.completion, prior = saved.value.pending?.completion;
      if (client !== 'codex' || !['failed', 'interrupted'].includes(incoming.kind) || incoming.finalTextHash !== null) fail('SOURCE_RESOLVER_INVALID', 'A native source completion requires an explicit failed or interrupted status.');
      nativeCompletion = prior?.promptId === incoming.promptId && prior.kind === 'completed' ? prior : incoming;
      const alreadyObserved = saved.value.checkpoint.exchange?.completed && saved.value.checkpoint.exchange.promptId === incoming.promptId;
      if (!alreadyObserved && !(prior?.promptId === incoming.promptId && prior.kind === 'completed') && JSON.stringify(prior) !== JSON.stringify(incoming)) {
        saved = await updateChat(store, projectId, client, sessionId, { expectedHash: saved.hash, change: chat => requestReconciliation(chat, incoming) });
        requestId = saved.value.pending?.id;
      }
    }
    const historyCandidate = resolved?.inheritedBoundary === undefined ? saved.value : resolveChatHistoryBoundary(saved.value, resolved.inheritedBoundary, { generation });
    const historical = await resolveNativeHistory(active, { client, sessionId, ...historyCandidate.history, limits,
      resolveSource: resolveNativeSource ? async request => {
        const result = await resolveNativeSource(Object.freeze({ ...request, previous: saved.value.source, candidate: saved.value.sourceCandidate, historySources: saved.value.historySources }));
        if (!result) return null;
        const capability = result.source;
        try {
          if (typeof capability?.verify !== 'function' || typeof capability.close !== 'function' || !capability.identity) fail('SOURCE_RESOLVER_INVALID', 'Historical native sources require verified physical capabilities.');
          validateChat({ ...saved.value, source: { path: result.path, identity: capability.identity } });
          if (request.before.byteOffset > capability.size) fail('HISTORY_BOUNDARY_INVALID', 'The exact historical prefix is not available in this physical source.');
          const digest = createHash('sha256');
          for (let offset = 0; offset < request.before.byteOffset;) { const bytes = await capability.read(offset, Math.min(65536, request.before.byteOffset - offset)); if (!bytes.length) fail('HISTORY_BOUNDARY_INVALID', 'Historical prefix reads must make progress.'); digest.update(bytes); offset += bytes.length; }
          const hash = digest.digest('hex'), prior = saved.value.historySources.find(item => item.sessionId === request.sessionId && JSON.stringify(item.before) === JSON.stringify(request.before));
          const captured = { sessionId: request.sessionId, source: { path: result.path, identity: capability.identity }, before: { ...request.before }, hash };
          if (prior && JSON.stringify(prior) !== JSON.stringify(captured)) fail('HISTORY_SOURCE_CHANGED', 'The exact retained historical capability changed.');
          if (!historySources.some(item => item.sessionId === request.sessionId && JSON.stringify(item.before) === JSON.stringify(request.before))) { historySources.push(captured); validateHistorySources(historySources, { client }); }
          await capability.verify(); return capability;
        } catch (error) { if (capability !== active) await capability?.close?.(); throw error; }
      } : undefined });
    if (historical.status !== 'ready') return { status: 'pending', reason: historical.reason, parts };
    source = historical.source;
    if (JSON.stringify(historyCandidate.history) !== JSON.stringify(saved.value.history)) {
      await source.verify();
      saved = await updateChat(store, projectId, client, sessionId, { expectedHash: saved.hash,
        change: chat => resolveChatHistoryBoundary(chat, historyCandidate.history.inheritedBoundary, { generation }) });
    }
    const changed = JSON.stringify(saved.value.source) !== JSON.stringify(located);
    if (changed || saved.value.sourceCandidate) {
      if (saved.value.uncommitted) return { status: 'pending', reason: 'HISTORY_REANCHOR_PENDING', parts };
      const relocated = await reanchorNativeCheckpoint(source, saved.value.checkpoint, { client, sessionId, limits });
      if (relocated.status !== 'ready') return { status: 'pending', reason: relocated.reason, parts };
      await source.verify(relocated.checkpoint.anchor);
      saved = await updateChat(store, projectId, client, sessionId, { expectedHash: saved.hash,
        change: chat => rebindChatSource({ ...chat, historySources }, { generation, source: located, checkpoint: relocated.checkpoint }) });
    }
    if (JSON.stringify(saved.value.historySources) !== JSON.stringify(historySources)) saved = await updateChat(store, projectId, client, sessionId, { expectedHash: saved.hash,
      change: chat => validateChat({ ...chat, historySources }) });
    if (saved.value.history.startPromptId && saved.value.checkpoint.offset === 0 && !saved.value.checkpoint.exchange) {
      for await (const event of normalizeTranscript(source, { client, sessionId, checkpoint: saved.value.checkpoint,
        fromPromptId: saved.value.history.startPromptId, limits })) {
        await source.verify(event.checkpoint.anchor);
        saved = await updateChat(store, projectId, client, sessionId, { expectedHash: saved.hash,
          change: chat => advanceChat(chat, { generation, checkpoint: event.checkpoint, requestId }) });
        if (event.type === 'pending') return { status: 'pending', reason: event.reason, parts, ...progress() };
      }
    }
    if (saved.value.uncommitted) {
      // Reconstruct exactly the retained emission plan, including its original
      // outcome and range. A newer hook or appended final row cannot change the
      // bytes of an interrupted publication. The retained ID/hash remains the
      // authority; this cursor is never published as a replacement checkpoint.
      const intent = saved.value.uncommitted, planned = intent.checkpoint, prior = saved.value.checkpoint;
      const exchange = planned.exchange, sameExchange = prior.exchange?.id === exchange?.id;
      if (!exchange?.completed || exchange.nextPart < 1) fail('CHAT_PART_CONFLICT', 'The interrupted publication has no complete retained emission plan.');
      const until = planned.cursor?.until ?? planned.offset, offset = Math.max(prior.offset, exchange.start);
      const priorCursor = sameExchange ? prior.cursor : null;
      const replay = { ...prior, offset, anchor: planned.anchor, scanOffset: until,
        exchange: { ...exchange, nextPart: exchange.nextPart - 1 }, boundary: null,
        cursor: { until, rowStart: offset, fieldIndex: priorCursor?.fieldIndex ?? 0, textOffset: priorCursor?.textOffset ?? 0,
          supplement: priorCursor?.supplement ?? (sameExchange && prior.exchange.completed && prior.exchange.nextPart > 0) } };
      await source.verify(planned.anchor);
      for await (const event of normalizeTranscript(source, { client, sessionId, checkpoint: replay,
        classifyCommand, limits: { ...limits, parts: 1 } })) {
        if (event.type !== 'part') continue;
        const record = transcriptPartRecord(event.part);
        if (record.id !== intent.recordId || record.hash !== intent.hash) fail('CHAT_PART_CONFLICT', 'The interrupted publication no longer reconstructs its exact record.');
        await source.verify(intent.checkpoint.anchor);
        saved = await commitChatPart(store, projectId, client, sessionId, { expectedHash: saved.hash, generation,
          checkpoint: intent.checkpoint, requestId, record });
        parts++; break;
      }
      if (saved.value.uncommitted) return { status: 'pending', reason: 'CHAT_PART_UNCOMMITTED', parts, ...progress() };
      if (parts >= (limits.parts ?? 64)) return { status: 'pending', reason: 'TRANSCRIPT_RECONCILIATION_PENDING', parts, ...progress() };
    }
    const initial = saved.value;
    let beforeRowId = null;
    if (initial.pending?.commandNonce) {
      const boundary = await resolveClaudeCommandBoundary(source, { sessionId,
        promptId: initial.pending.beforePromptId, nonce: initial.pending.commandNonce, classifyCommand, limits });
      if (boundary.status !== 'ready') return { status: 'pending', reason: boundary.reason, parts };
      if (boundary.action !== initial.pending.reason) return { status: 'pending', reason: 'HISTORY_COMMAND_BOUNDARY_CONFLICT', parts };
      beforeRowId = boundary.beforeRowId;
    }
    for await (const event of normalizeTranscript(source, {
      client, sessionId, checkpoint: initial.checkpoint, completion: initial.pending?.completion ?? nativeCompletion,
      beforePromptId: initial.pending?.beforePromptId ?? null, beforeRowId, classifyCommand,
      limits: { ...limits, parts: (limits.parts ?? 64) - parts },
    })) {
      await source.verify(event.checkpoint.anchor);
      if (event.type === 'part') {
        const record = transcriptPartRecord(event.part);
        saved = await commitChatPart(store, projectId, client, sessionId, {
          expectedHash: saved.hash, generation, checkpoint: event.checkpoint, requestId, record,
        });
        parts++;
      } else {
        // Replay metadata while reconstructing an interrupted part cannot move
        // its durable bookmark past bytes that are still ineligible to process.
        if (!saved.value.uncommitted) {
          saved = await updateChat(store, projectId, client, sessionId, { expectedHash: saved.hash,
            change: chat => advanceChat(chat, { generation, checkpoint: event.checkpoint, requestId }) });
        }
        if (event.type === 'pending') pendingReason = event.reason;
      }
    }
    if (!pendingReason && satisfied(saved.value, source.size)) {
      await source.verify(saved.value.checkpoint.anchor);
      if (saved.value.pending) saved = await updateChat(store, projectId, client, sessionId, { expectedHash: saved.hash,
        change: chat => advanceChat(chat, { generation, checkpoint: chat.checkpoint, requestId, complete: true }) });
      return { status: 'caught-up', parts };
    }
    return { status: 'pending', reason: pendingReason ?? 'TRANSCRIPT_RECONCILIATION_PENDING', parts, ...progress() };
  } catch (error) {
    return { status: 'pending', reason: typeof error.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : 'COLLECTION_FAILED', parts, ...progress() };
  } finally {
    try { await source?.close(); }
    finally { await active?.close(); }
  }
}
