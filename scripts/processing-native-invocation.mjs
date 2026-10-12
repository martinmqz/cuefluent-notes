import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { lstatOrNull } from './file-io.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import path from 'node:path';
import { openWorkflowIntake, intakePath, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { readSelection } from './intake-store.mjs';
import { assertWorkflowStorage, workflowProcessingContext } from './workflow-storage.mjs';
import { currentIntervals, inspectSourceBoundary } from './capture-selection.mjs';
import { processingSourceDirectory, processingSourcePath, validateProcessingSource } from './collection-ingress.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { verifyCodexHeader, codexRegistrationHeader } from './codex-reader.mjs';
import { claudeRegistrationHeader } from './claude-reader.mjs';
import { loadClaudeProcessingSkill, findClaudeProcessingControlInput } from './processing-control-proof.mjs';
import { canonicalJSON, digest, fail, object, isNativeId } from './workflow-values.mjs';

const MAX_PREFIX = 2 * 1024 * 1024, SETTLE_ATTEMPTS = 5, FALLBACK_SOURCES = 32;
// A bounded primary wait plus one complete fallback pass, never a scan per retry.
const MAX_READS = SETTLE_ATTEMPTS + FALLBACK_SOURCES;
// A candidate may be unavailable without disproving the requested call in a
// different registered session. Exact-call mismatches remain fatal; only missing
// records may settle, and privacy/identity failures are never candidate misses.
class UnavailableNativeSource extends Error {
  constructor() { super('PROCESSING_CONTROL_SOURCE_UNVERIFIED'); this.code = this.message; }
}
class MissingNativeInvocation extends UnavailableNativeSource {}
const bindings = new WeakSet(), pendingBindings = new WeakSet();
export const isPendingProcessingInvocation = value => object(value) && pendingBindings.has(value);
export const isProcessingInvocation = value => object(value) && bindings.has(value);

/** Code-mode source contains the outer exec before dispatch, but the native
 * inner MCP event only after its response. The outer item can request a handshake;
 * it cannot authorize processing. Never interpret model-written JavaScript.
 */
function codexNestedCall(records, context, invocation, argsHash) {
  if (typeof context.itemId !== 'string' || !context.toolCallId.startsWith('exec-') || !isNativeId(context.toolCallId.slice(5))) return null;
  const outer = records.filter(r => r.value.type === 'response_item' && r.value.payload?.id === context.itemId);
  if (!outer.length) return null;
  if (outer.length !== 1) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  const record = outer[0], p = record.value.payload;
  if (p.type !== 'custom_tool_call' || p.name !== 'exec' || typeof p.input !== 'string' ||
      typeof p.call_id !== 'string' || !p.call_id || p.internal_chat_message_metadata_passthrough?.turn_id !== context.unitId) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  const outputs = records.filter(r => r.value.type === 'response_item' && r.value.payload?.call_id === p.call_id &&
    r.value.payload.type === 'custom_tool_call_output');
  const calls = records.filter(r => r.value.type === 'event_msg' && r.value.payload?.type === 'item_completed' &&
    r.value.payload.item?.id === context.toolCallId);
  if (calls.length > 1 || outputs.length > 1) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  const event = calls[0], e = event?.value.payload, item = e?.item, output = outputs[0];
  // Validate every present record immediately; only absence may settle.
  if (event && (event.startByte <= record.startByte || e.thread_id !== context.sessionId || e.turn_id !== context.unitId ||
      item.type !== 'McpToolCall' || item.server !== 'cuefluent_control' || item.tool !== invocation.tool ||
      item.status !== 'completed' || !object(item.result) || item.result.isError === true ||
      digest(canonicalJSON(item.arguments)) !== argsHash)) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  if (output && (output.startByte <= record.startByte ||
      output.value.payload.internal_chat_message_metadata_passthrough?.turn_id !== context.unitId ||
      output.value.metadata?.client_authored !== false || records.some(r => r.startByte > record.startByte &&
        r.startByte < output.startByte && r.value.type === 'response_item' && r.value.payload?.type === 'custom_tool_call'))) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  if (!event || !output) return { pending: true, callId: context.toolCallId, tool: `mcp__cuefluent_control.${invocation.tool}`, outerItemId: p.id, outerRecordHash: record.hash };
  if (output.startByte <= event.startByte) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  // The handshake is verified below against our exact first response as well.
  return { callId: item.id, tool: `mcp__${item.server}.${item.tool}`, outerItemId: p.id, outerRecordHash: record.hash,
    handshakeResultHash: digest(canonicalJSON(item.result)) };
}

/** Bind native MCP metadata to the actual call in an already selected source.
 * No archive search, last-session heuristic, caller JSON proof or source write.
 * Pausing collection preserves this binding for independently authorized
 * processing; it does not reopen or extend any collection interval.
 */
async function resolveBoundInvocation(capability, context, invocation, { skillPath, skillCommand, signal, readBudget, configHash, settleMs, requireCompleted }) {
  signal?.throwIfAborted();
  const store = await openWorkflowIntake(capability);
  const identity = { client: context.client, sessionId: context.sessionId };
  const selected = await readSelection(store, identity);
  if (selected.state?.safetyStop) throw new UnavailableNativeSource();
  const intervals = selected.state ? currentIntervals(selected.state) : [];
  const interval = selected.state?.paused ? intervals.at(-1) : intervals.find(value => value.upper === null);
  let source = selected.state?.source, floor = interval ? (selected.state.paused ? interval.upper ?? interval.lower : interval.lower) : null;
  let processingBinding = null;
  if (!floor && selected.state?.explicitScopes.length) {
    floor = { eofByte: Math.min(...selected.state.explicitScopes.map(scope => scope.start.startByte)), startsMidRecord: false };
  }
  if (!floor) {
    const name = processingSourcePath(identity, configHash), snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: 16384 });
    if (!snapshot.bytes) throw new MissingNativeInvocation();
    const value = validateProcessingSource(intakeJSON(snapshot), identity, configHash, snapshot.bytes);
    source = { ...identity, path: value.snapshot.path, fileIdentity: value.snapshot.fileIdentity, projectRoot: value.cwd };
    // Collection stays off. Only the explicit MCP request may inspect this
    // source, starting at the immutable metadata-only hook boundary.
    await assertWorkflowStorage(capability, { ...identity, cwd: source.projectRoot }, 'explicitProcess');
    const inspected = await inspectSourceBoundary({ ...identity, path: source.path, projectRoot: source.projectRoot }, {
      frozen: value.snapshot, verifyHeader: (context.client === 'codex' ? codexRegistrationHeader : claudeRegistrationHeader)(source) });
    if (inspected.status !== 'registered') throw new UnavailableNativeSource();
    source = inspected.source; floor = inspected.boundary;
    processingBinding = { name, hash: snapshot.hash };
  }
  const selection = { client: context.client, sessionId: context.sessionId, cwd: source.projectRoot, unitId: null };
  const guard = async () => {
    signal?.throwIfAborted();
    await assertWorkflowStorage(capability, selection, 'explicitProcess');
    if ((await readSelection(store, identity)).hash !== selected.hash || (processingBinding &&
        (await intakeSnapshot(store, 'state', processingBinding.name, { maxBytes: 16384 })).hash !== processingBinding.hash)) throw new UnavailableNativeSource();
    signal?.throwIfAborted();
  };
  const deadline = performance.now() + settleMs;
  let found;
  for (let attempt = 0; ; attempt++) {
    await guard();
    try {
      found = await readBoundCall(source, floor, context, invocation, { skillPath, skillCommand, readBudget });
      if (requireCompleted && found.call.pending) throw new MissingNativeInvocation();
      break;
    } catch (error) {
      const remaining = deadline - performance.now();
      if (!(error instanceof MissingNativeInvocation) || remaining <= 0 || attempt === SETTLE_ATTEMPTS - 1) throw error;
      await delay(Math.min(50 * 2 ** attempt, remaining), undefined, { signal });
    }
  }
  await guard();
  const { call, unitId, nativeSkill, nested, controlInput, argsHash } = found;
  const result = Object.freeze({ source: Object.freeze(structuredClone(source)), selection: Object.freeze(selection),
    configHash, selectionHash: selected.hash, captureActive: selected.state?.active === true && !selected.state.paused, nativeSkill: nested ? false : nativeSkill,
    controlExclusionUnsupported: Boolean(nested && nativeSkill), unitId, argsHash, ...call,
    ...(controlInput ? Object.fromEntries(['inputId', 'inputHash', 'companionId', 'companionHash', 'skillExpansionHash', 'skillCommand'].map(key => [key, controlInput[key]])) : {}) });
  if (call.pending) pendingBindings.add(result);
  else bindings.add(result);
  return result;
}

// Re-read only the selected source tail while persistence catches up. Source
// identity and the immutable floor remain pinned by resolveBoundInvocation.
async function readBoundCall(source, floor, context, invocation, { skillPath, skillCommand, readBudget }) {
  const endByte = Number((await fs.lstat(source.path, { bigint: true })).size);
  const from = Math.max(floor.eofByte, endByte - MAX_PREFIX);
  readBudget.bytes += endByte - from;
  if (++readBudget.reads > MAX_READS || readBudget.bytes > MAX_READS * MAX_PREFIX) fail('PROCESSING_SOURCE_DISCOVERY_LIMIT');
  const read = await readSessionRange({ source, from, endByte,
    startsMidRecord: from === floor.eofByte ? floor.startsMidRecord : true,
    maxBytes: MAX_PREFIX, maxRecords: 4096,
    ...(context.client === 'codex' ? { verifyHeader: verifyCodexHeader }
      : { readHeader: claudeRegistrationHeader(source), verifyHeader: value => value }) });
  if (read.blocked || read.limited) throw new UnavailableNativeSource();
  const argsHash = digest(canonicalJSON(invocation.arguments));
  let call = null, unitId = context.unitId ?? null, nativeSkill = false;
  const nested = context.client === 'codex' ? codexNestedCall(read.records, context, invocation, argsHash) : null;
  for (const record of read.records) {
    const row = record.value;
    if (context.client === 'codex') {
      const p = row.payload;
      if (row.type === 'event_msg' && p?.type === 'item_completed' && p.turn_id === unitId && p.item?.type === 'UserMessage') {
        const content = p.item.content;
        nativeSkill = Array.isArray(content) && content.length === 2 && content[0]?.type === 'skill' &&
          content[0].name === 'cuefluent-notes' && path.normalize(content[0].path ?? '') === path.normalize(skillPath) &&
          content[1]?.type === 'text' && content[1].text === (invocation.tool === 'processing_review' ? 'review' : 'process');
      }
      if (row.type !== 'response_item' || p?.type !== 'function_call' || p.call_id !== context.toolCallId) continue;
      if (call || p.internal_chat_message_metadata_passthrough?.turn_id !== unitId ||
          !/^mcp__[a-zA-Z0-9_-]*cuefluent_control$/.test(p.namespace ?? '') || p.name !== invocation.tool) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      let args; try { args = JSON.parse(p.arguments); } catch { fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED'); }
      if (digest(canonicalJSON(args)) !== argsHash) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      call = { tool: `${p.namespace}.${p.name}`, callId: p.call_id };
    } else {
      if (row.sessionId !== source.sessionId || row.type !== 'assistant' || row.isSidechain === true ||
          row.message?.role !== 'assistant' || !Array.isArray(row.message?.content)) continue;
      for (const block of row.message.content) {
        if (block?.type !== 'tool_use' || block.id !== context.toolCallId) continue;
        if (call || !/^mcp__[a-zA-Z0-9_-]*cuefluent_control__/.test(block.name ?? '') ||
            !block.name.endsWith(`__${invocation.tool}`) || digest(canonicalJSON(block.input)) !== argsHash) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
        call = { tool: block.name, callId: block.id };
        // Ordinary Claude assistant parentage is not prompt identity evidence.
        // This binding does not authorize excluding the parent user message.
      }
    }
  }
  if (call && nested) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  call ??= nested;
  if (!call) throw new MissingNativeInvocation();
  let controlInput = null;
  if (context.client === 'claude') {
    const skill = await loadClaudeProcessingSkill({ skillPath, skillCommand, control: invocation.tool === 'processing_review' ? 'review' : 'process' });
    controlInput = findClaudeProcessingControlInput(read.records, { source, ...call, argsHash, skill });
    if (controlInput) { nativeSkill = true; unitId = controlInput.unitId; }
  }
  return { call, unitId, nativeSkill, nested, controlInput, argsHash };
}

/** Claude may keep its MCP process across /clear. The launch UUID is a hint;
 * a fallback binds only the exact native tool-use ID in already registered,
 * authorized sources. No client archive discovery, cwd/latest guess or new grant.
 */
async function resolveClaudeFallback(capability, context, invocation, options) {
  const store = await openWorkflowIntake(capability);
  const matches = [], seen = new Set([context.sessionId]); let entries = 0, inspected = 0;
  for (const [name, directories] of [['sessions/claude', false], [processingSourceDirectory('claude'), true]]) {
    const directory = path.dirname(await intakePath(store, 'state', `${name}/.list`));
    if (!await lstatOrNull(directory)) continue;
    for await (const entry of await fs.opendir(directory)) {
      checkWorkflowBudget();
      if (++entries > 128) fail('PROCESSING_SOURCE_DISCOVERY_LIMIT');
      const sessionId = directories ? entry.name : entry.name.endsWith('.json') ? entry.name.slice(0, -5) : null;
      if (!isNativeId(sessionId)) continue; // Unrelated files cannot supply a candidate.
      if (directories ? !entry.isDirectory() : !entry.isFile()) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      if (++inspected > FALLBACK_SOURCES) fail('PROCESSING_SOURCE_DISCOVERY_LIMIT');
      try { matches.push(await resolveBoundInvocation(capability, { ...context, sessionId }, invocation, options)); }
      catch (error) {
        if (!(error instanceof UnavailableNativeSource) && !['WORKFLOW_NOT_AUTHORIZED', 'ENOENT'].includes(error.code)) throw error;
      }
    }
  }
  if (matches.length !== 1) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  return matches[0];
}

/** Native logging can lag an MCP request. Retry only a missing call, with an
 * unchanged source/selection, a shared finite read budget and cancellation.
 * No sleep, source scan or write is performed by hook ingress.
 */
export async function resolveProcessingInvocation(capability, context, invocation, { settleMs = 1000, signal, requireCompleted = false, ...options } = {}) {
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 1000 || typeof requireCompleted !== 'boolean') fail('PROCESSING_CONTROL_INVALID_REQUEST');
  signal?.throwIfAborted();
  const { configHash } = await workflowProcessingContext(capability);
  const boundOptions = { ...options, signal, requireCompleted, configHash, readBudget: { reads: 0, bytes: 0 } };
  try { return await resolveBoundInvocation(capability, context, invocation, { ...boundOptions, settleMs }); }
  catch (error) { if (context.client !== 'claude' || !(error instanceof UnavailableNativeSource)) throw error; }
  return resolveClaudeFallback(capability, context, invocation, { ...boundOptions, settleMs: 0 });
}
