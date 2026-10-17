import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { lstatOrNull } from './file-io.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import path from 'node:path';
import { openWorkflowIntake, intakePath, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { readSelection } from './intake-store.mjs';
import { assertWorkflowStorage, workflowProcessingContext, workflowCollectionGrant } from './workflow-storage.mjs';
import { currentIntervals, inspectSourceBoundary } from './capture-selection.mjs';
import { processingSourceDirectory, processingSourcePath, validateProcessingSource, readRegistration, registrationPath, registrationFloorPath } from './collection-ingress.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { verifyCodexHeader, codexRegistrationHeader } from './codex-reader.mjs';
import { claudeRegistrationHeader, isClaudeHumanRow } from './claude-reader.mjs';
import { readContinuesLink, continuationTarget, continuesPath, continuedPath } from './claude-continuation.mjs';
import { loadClaudeProcessingSkill, findClaudeProcessingControlInput, findClaudeSkillArguments, claudeProcessingCommandKind, processingControlAction,
  processingControlText, processingControlMatches, processingControlSuggestions } from './processing-control-proof.mjs';
import { canonicalJSON, digest, fail, object, isNativeId, keys, hash, integer } from './workflow-values.mjs';

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

/** A Claude session registered for collection whose selection is not armed
 * yet: its first prompt is often persisted before the hook froze the floor.
 * The exact current registration and its saved floor pin the native file; the
 * registration's own grant must still be current collection consent. This
 * binds a call only; it creates no selection and moves no floor. */
async function registeredSource(capability, store, identity, sessionKinds) {
  const { snapshot, registration } = await readRegistration(store, identity, { mismatchCode: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' });
  if (!registration) throw new MissingNativeInvocation();
  const { collection } = await workflowProcessingContext(capability);
  const selection = { ...identity, cwd: registration.cwd };
  if (registration.collectionId !== collection.id) throw new UnavailableNativeSource();
  let grant;
  try { grant = await workflowCollectionGrant(capability, selection); }
  catch (error) { if (['WORKFLOW_NOT_AUTHORIZED', 'COLLECTION_GRANT_REQUIRES_SETUP'].includes(error.code)) throw new UnavailableNativeSource(); throw error; }
  if (grant !== registration.grantHash) throw new UnavailableNativeSource();
  const records = [{ name: registrationPath(identity), hash: snapshot.hash }];
  let frozen = registration.snapshot;
  if (!frozen) {
    // Only the worker freezes a floor; until then there is nothing to pin.
    const floorName = registrationFloorPath(identity), saved = await intakeSnapshot(store, 'state', floorName, { maxBytes: 16384 });
    const value = intakeJSON(saved);
    if (!value) throw new MissingNativeInvocation();
    keys(value, ['registrationId', 'snapshot']);
    if (value.registrationId !== registration.id) throw new UnavailableNativeSource();
    frozen = value.snapshot; records.push({ name: floorName, hash: saved.hash });
  }
  keys(frozen, ['path', 'fileIdentity', 'eofByte']); hash(frozen.fileIdentity); integer(frozen.eofByte);
  if (frozen.path !== registration.sourcePath) throw new UnavailableNativeSource();
  await assertWorkflowStorage(capability, selection, 'explicitProcess');
  const selected = { ...identity, path: registration.sourcePath, projectRoot: registration.cwd };
  const inspected = await inspectSourceBoundary(selected, { frozen, verifyHeader: claudeRegistrationHeader(selected, { sessionKinds }) });
  if (inspected.status !== 'registered') throw new UnavailableNativeSource();
  return { source: inspected.source, floor: inspected.boundary, records, unitId: registration.unitId };
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
  // A verified continuation of a registered root session: its background kind
  // is accepted, its re-homed prefix is never read, and it shares the
  // predecessor's chat lineage. Unverified or changed links bind nothing.
  let continued = null;
  if (context.client === 'claude') {
    try { continued = await readContinuesLink(store, identity.sessionId); }
    catch (error) { if (error.code === 'INVALID_SESSION_CONTINUATION') throw new UnavailableNativeSource(); throw error; }
  }
  const sessionKinds = continued?.link.to.sessionKinds ?? [];
  const pinned = context.client === 'claude' ? [{ name: continuesPath(identity.sessionId), hash: continued?.pointerHash ?? null },
    ...(continued ? [{ name: continuedPath(continued.link.from.sessionId), hash: continued.linkHash }] : [])] : [];
  let registered = null;
  const intervals = selected.state ? currentIntervals(selected.state) : [];
  const interval = selected.state?.paused ? intervals.at(-1) : intervals.find(value => value.upper === null);
  let source = selected.state?.source, floor = interval ? (selected.state.paused ? interval.upper ?? interval.lower : interval.lower) : null;
  if (!floor && selected.state?.explicitScopes.length) {
    floor = { eofByte: Math.min(...selected.state.explicitScopes.map(scope => scope.start.startByte)), startsMidRecord: false };
  }
  if (!floor) {
    const name = processingSourcePath(identity, configHash), snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: 16384 });
    if (snapshot.bytes) {
      const value = validateProcessingSource(intakeJSON(snapshot), identity, configHash, snapshot.bytes);
      source = { ...identity, path: value.snapshot.path, fileIdentity: value.snapshot.fileIdentity, projectRoot: value.cwd };
      // Collection stays off. Only the explicit MCP request may inspect this
      // source, starting at the immutable metadata-only hook boundary.
      await assertWorkflowStorage(capability, { ...identity, cwd: source.projectRoot }, 'explicitProcess');
      const inspected = await inspectSourceBoundary({ ...identity, path: source.path, projectRoot: source.projectRoot }, {
        frozen: value.snapshot, verifyHeader: context.client === 'codex' ? codexRegistrationHeader(source) : claudeRegistrationHeader(source, { sessionKinds }) });
      if (inspected.status !== 'registered') throw new UnavailableNativeSource();
      source = inspected.source; floor = inspected.boundary;
      pinned.push({ name, hash: snapshot.hash });
      // No collection, so no capture to exclude: a typed control on either side of the boundary binds.
      registered = { unitId: null, preFloorControlsOnly: false };
    } else if (context.client === 'claude' && selected.state === null) {
      // Only a session with no selection state at all; an exclusion-only or
      // retired selection keeps its existing refusal, also as a fallback candidate.
      const found = await registeredSource(capability, store, identity, sessionKinds);
      source = found.source; floor = found.floor; pinned.push(...found.records);
      // Collection is on but not armed: a later typed control needs the armed
      // selection, whose exclusion receipt keeps it out of captured evidence.
      registered = { unitId: found.unitId, preFloorControlsOnly: true };
    } else throw new MissingNativeInvocation();
  }
  const selection = { client: context.client, sessionId: context.sessionId, cwd: source.projectRoot, unitId: null };
  // Authorization precedes every transcript read, including the link's pinned
  // prefix record just below: an excluded route reads nothing.
  await assertWorkflowStorage(capability, selection, 'explicitProcess');
  // The link's pinned prefix record is re-read on every guard: the binding
  // window starts past it, so only this check notices a prefix rewritten in
  // place, which otherwise would lend the predecessor's lineage to a decision.
  const verifiedTarget = async () => {
    let verified;
    try { verified = await continuationTarget(continued, source); }
    catch (error) { if (error.code === 'INVALID_SESSION_CONTINUATION') throw new UnavailableNativeSource(); throw error; }
    if (verified) readBudget.bytes += verified.prefix.endByte - verified.prefix.startByte;
    if (readBudget.bytes > MAX_READS * MAX_PREFIX) fail('PROCESSING_SOURCE_DISCOVERY_LIMIT');
    return verified;
  };
  const target = await verifiedTarget();
  const guard = async () => {
    signal?.throwIfAborted();
    await assertWorkflowStorage(capability, selection, 'explicitProcess');
    if ((await readSelection(store, identity)).hash !== selected.hash) throw new UnavailableNativeSource();
    for (const record of pinned) if ((await intakeSnapshot(store, 'state', record.name, { maxBytes: 16384 })).hash !== record.hash) throw new UnavailableNativeSource();
    if (target) await verifiedTarget();
    signal?.throwIfAborted();
  };
  const deadline = performance.now() + settleMs;
  let found;
  for (let attempt = 0; ; attempt++) {
    await guard();
    try {
      found = await readBoundCall(source, floor, context, invocation, { skillPath, skillCommand, readBudget, sessionKinds, base: target?.prefix.endByte ?? 0, registered });
      if (requireCompleted && found.call.pending) throw new MissingNativeInvocation();
      break;
    } catch (error) {
      const remaining = deadline - performance.now();
      if (!(error instanceof MissingNativeInvocation) || remaining <= 0 || attempt === SETTLE_ATTEMPTS - 1) throw error;
      await delay(Math.min(50 * 2 ** attempt, remaining), undefined, { signal });
    }
  }
  await guard();
  const { call, unitId, nativeSkill, nested, controlInput, argsHash, typedControl, typedSuggestions } = found;
  // typedControl is the exact verified typed action. Only a verified binding
  // carries it; a model-chosen call or a code-mode call never does.
  // typedSuggestions marks a typed skill invocation that is not an exact action:
  // nothing may be applied for it, whichever tool the model called; it names
  // the nearest exact commands and is never authority.
  const result = Object.freeze({ source: Object.freeze(structuredClone(source)), selection: Object.freeze(selection),
    configHash, selectionHash: selected.hash, captureActive: selected.state?.active === true && !selected.state.paused, nativeSkill: nested ? false : nativeSkill,
    controlExclusionUnsupported: Boolean(nested && nativeSkill), unitId, argsHash, ...call,
    ...(nativeSkill && !nested ? { typedControl } : {}),
    ...(typedSuggestions ? { typedSuggestions } : {}),
    ...(continued ? { chatLineage: Object.freeze({ client: 'claude', sessionId: continued.link.lineage }) } : {}),
    ...(controlInput ? Object.fromEntries(['inputId', 'inputHash', 'companionId', 'companionHash', 'skillExpansionHash', 'skillCommand'].map(key => [key, controlInput[key]])) : {}) });
  if (call.pending) pendingBindings.add(result);
  else bindings.add(result);
  return result;
}

// Re-read only the selected source tail while persistence catches up. Source
// identity and the immutable floor remain pinned by resolveBoundInvocation.
// `base` is the end of a verified re-homed prefix, which is never read.
async function readBoundCall(source, floor, context, invocation, { skillPath, skillCommand, readBudget, sessionKinds = [], base = 0, registered = null }) {
  const endByte = Number((await fs.lstat(source.path, { bigint: true })).size);
  // A registered source without a selection may also read back to its own
  // start: a fresh session's first prompt precedes the floor its hook froze.
  // The whole window is then bounded like the tail, and it is used only when
  // it holds no earlier prompt than the registered one.
  const early = context.client === 'claude' && registered !== null && base < floor.eofByte && endByte - base <= MAX_PREFIX;
  const from = early ? base : Math.max(floor.eofByte, base, endByte - MAX_PREFIX);
  readBudget.bytes += endByte - from;
  if (++readBudget.reads > MAX_READS || readBudget.bytes > MAX_READS * MAX_PREFIX) fail('PROCESSING_SOURCE_DISCOVERY_LIMIT');
  const read = await readSessionRange({ source, from, endByte,
    startsMidRecord: from === floor.eofByte ? floor.startsMidRecord : from !== base,
    maxBytes: MAX_PREFIX, maxRecords: 4096,
    ...(context.client === 'codex' ? { verifyHeader: verifyCodexHeader }
      : { readHeader: claudeRegistrationHeader(source, { sessionKinds }), verifyHeader: value => value }) });
  if (read.blocked || read.limited) throw new UnavailableNativeSource();
  let records = read.records;
  if (early) {
    const prompts = new Set(records.filter(({ value, startByte }) => startByte < floor.eofByte && value?.sessionId === source.sessionId &&
      isClaudeHumanRow(value) && isNativeId(value.promptId)).map(({ value }) => value.promptId));
    const fresh = prompts.size <= 1 && (registered.unitId === null || [...prompts].every(unitId => unitId === registered.unitId));
    // Otherwise exactly the records the floor-bounded read would have returned.
    if (!fresh) records = records.filter(record => record.startByte >= floor.eofByte);
  }
  // Resume metadata inside the already authorized tail must preserve the same
  // root ownership and history shape as the initial header. Never scan backward
  // beyond that bounded tail to look for another source or a usable header.
  if (context.client === 'codex') for (const { value } of records) {
    if (value.type !== 'session_meta') continue;
    const resumed = await verifyCodexHeader(value, source);
    if (resumed.historyMode !== read.metadata.historyMode) fail('UNSUPPORTED_CODEX_HISTORY');
  }
  const argsHash = digest(canonicalJSON(invocation.arguments));
  let call = null, unitId = context.unitId ?? null, nativeSkill = false, typedControl = null, typedSuggestions = null;
  const nested = context.client === 'codex' ? codexNestedCall(records, context, invocation, argsHash) : null;
  const users = [];
  for (const record of records) {
    const row = record.value;
    if (context.client === 'codex') {
      const p = row.payload;
      if (row.type === 'event_msg' && p?.type === 'item_completed' && p.turn_id === unitId && p.item?.type === 'UserMessage') users.push(p.item);
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
  if (context.client === 'codex') {
    // One native user message of exactly this skill and an exact action is a
    // typed control. This skill with anything else (other text, a control plus
    // more words, lines, content or a second message) is a typed non-control.
    const trusted = part => part?.type === 'skill' && part.name === 'cuefluent-notes' && path.normalize(part.path ?? '') === path.normalize(skillPath);
    const typedText = content => Array.isArray(content) && content.length === 2 && trusted(content[0]) &&
      content[1]?.type === 'text' && typeof content[1].text === 'string' ? content[1].text : null;
    // Codex can persist identical mirrors of one native item: as in the reader,
    // the same item ID with the same item is one message, and a changed mirror
    // leaves the typed input unverifiable.
    const messages = new Map();
    for (const item of users) {
      const key = typeof item.id === 'string' ? item.id : Symbol('unidentified'), value = canonicalJSON(item);
      if (messages.has(key) && messages.get(key).value !== value) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      messages.set(key, { value, content: item.content });
    }
    const contents = [...messages.values()].map(message => message.content);
    const exact = contents.length === 1 ? processingControlText(typedText(contents[0])) : null;
    if (exact !== null) {
      nativeSkill = processingControlMatches(exact, invocation.tool, invocation.arguments, 'codex');
      if (!nativeSkill) fail('PROCESSING_CONTROL_SELECTION_MISMATCH');
      typedControl = exact;
    } else if (contents.some(content => Array.isArray(content) && content.some(trusted))) {
      typedSuggestions = processingControlSuggestions(contents.flatMap(content => Array.isArray(content)
        ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text) : []).join('\n'));
    }
  }
  let controlInput = null;
  if (context.client === 'claude') {
    const skill = await loadClaudeProcessingSkill({ skillPath, skillCommand, control: processingControlAction(invocation.tool, invocation.arguments) });
    controlInput = findClaudeProcessingControlInput(records, { source, ...call, argsHash, skill, sessionKinds });
    // Without an armed selection there is no exclusion receipt. The first human
    // prompt after the floor is the boundary the worker will exclude, so a typed
    // control there is never collected and may bind now; a later one would be
    // collected and binds only once the selection is armed. Only a window that
    // reaches the floor (or the re-homed prefix end) can show that no earlier
    // prompt exists: a longer unarmed tail waits for the armed selection.
    if (controlInput && registered?.preFloorControlsOnly && controlInput.inputRange.fromByte >= floor.eofByte) {
      const start = Math.max(floor.eofByte, base);
      if (from > start) throw new UnavailableNativeSource();
      const earlier = records.some(record => record.startByte >= start && record.startByte < controlInput.inputRange.fromByte &&
        record.value?.sessionId === source.sessionId && isClaudeHumanRow(record.value) && isNativeId(record.value.promptId) && record.value.promptId !== controlInput.unitId);
      if (earlier) throw new UnavailableNativeSource();
    }
    if (controlInput) { nativeSkill = true; unitId = controlInput.unitId; typedControl = processingControlAction(invocation.tool, invocation.arguments); }
    else {
      const alternatives = new Set(records.map(({ value }) => claudeProcessingCommandKind(value, skillCommand)));
      alternatives.delete(null); alternatives.delete(processingControlAction(invocation.tool, invocation.arguments));
      for (const control of alternatives) {
        const otherSkill = await loadClaudeProcessingSkill({ skillPath, skillCommand, control });
        if (findClaudeProcessingControlInput(records, { source, ...call, argsHash, skill: otherSkill, control, sessionKinds })) fail('PROCESSING_CONTROL_SELECTION_MISMATCH');
      }
      // The verified typed arguments of this skill, when they are no exact action.
      const typed = await findClaudeSkillArguments(records, { source, ...call, argsHash, skillPath, skillCommand, sessionKinds });
      if (typed) typedSuggestions = processingControlSuggestions(typed.arguments);
    }
  }
  return { call, unitId, nativeSkill, nested, controlInput, argsHash, typedControl, typedSuggestions };
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
