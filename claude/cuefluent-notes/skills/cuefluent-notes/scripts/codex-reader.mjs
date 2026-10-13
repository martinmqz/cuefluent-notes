import fs from 'node:fs/promises';
import path from 'node:path';
import { readSessionRange, readSessionHeader } from './session-jsonl.mjs';
import { evidenceCollector } from './capture-evidence.mjs';
import { createCapture, validateCapture, clientVersion } from './capture-contract.mjs';
import { validateSelectionState, evaluateUnitSelection, resolveSelectionAnchor, currentIntervals } from './capture-selection.mjs';
import { absolutePath } from './workflow-paths.mjs';
import { verifySourceCursor } from './intake-store.mjs';
import { verifyCodexProcessingControl, isProcessingControlProof } from './processing-control-proof.mjs';
import { verifyProcessingExecution, isProcessingExecutionProof } from './processing-execution-proof.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { nativeId, integer, timestamp, string, choice, canonicalJSON, digest, fail } from './workflow-values.mjs';

// v2 allocates separate bounded call/result text pools and preserves native
// descriptors after text exhaustion. Published v1 captures remain immutable.
export const CODEX_READER_VERSION = '2';
// Retain every supported historical reader independently of later reader bumps.
export const CODEX_TOOL_RULES = Object.freeze({ '1': '1', '2': '2' });
const structural = new Set(['compacted', 'token_usage_record', 'world_state', 'retained_context', 'security_risk_score',
  'inter_agent_communication', 'inter_agent_communication_metadata', 'realtime_item']);
const ignoredEvents = new Set(['token_count', 'thread_goal_updated', 'thread_settings_applied', 'agent_reasoning',
  'agent_reasoning_raw_content', 'context_compacted', 'sub_agent_activity']);
const legacyItems = new Set(['patch_apply_end', 'mcp_tool_call_end', 'web_search_end', 'image_generation_end', 'entered_review_mode', 'exited_review_mode']);
const ignoredResponses = new Set(['reasoning', 'agent_message', 'configuration_update', 'compaction', 'context_compaction']);
const ignoredItems = new Set(['Reasoning', 'HookPrompt', 'ContextCompaction', 'SubAgentActivity']);
const collaborationTools = new Set(['spawn_agent', 'send_input', 'resume_agent', 'wait', 'close_agent', 'send_message', 'followup_task', 'interrupt_agent', 'list_agents']);
const textValue = value => { if (typeof value !== 'string' || value.length > 8 * 1024 * 1024) fail('UNSUPPORTED_CODEX_CONTENT'); return value; };
const toolName = item => string(item.namespace ? `${item.namespace}.${item.name}` : item.name, 128);
const orderOf = record => {
  const match = /^codex:ordinal:(\d+)$/.exec(record.id);
  if (!match) fail('UNSUPPORTED_CODEX_ORDER');
  return integer(Number(match[1]));
};
const anchor = record => ({ id: record.id, startByte: record.startByte, endByte: record.endByte, hash: record.hash });
const range = record => ({ startByte: record.startByte, endByte: record.endByte, recordIds: [record.id] });
function compactRanges(records) {
  const result = [];
  for (const record of records) {
    const previous = result.at(-1);
    if (previous && previous.endByte === record.startByte && previous.recordIds.length < 1024) {
      previous.endByte = record.endByte; previous.recordIds.push(record.id);
    } else result.push(range(record));
  }
  return result;
}
const terminalCursor = (source, record) => ({ sourceIdentity: source.fileIdentity, offset: record.endByte,
  anchor: { startByte: record.startByte, endByte: record.endByte, hash: record.hash } });

export async function verifyCodexHeader(line, source) {
  const meta = line?.payload;
  if (line?.type !== 'session_meta' || !meta) fail('UNSUPPORTED_CODEX_HEADER');
  // The client version is provenance; compatibility comes from the native shape.
  clientVersion(meta.cli_version);
  // thread_source is a creation-origin label. An app-created independent chat
  // still has to prove root ownership through both IDs and every lineage field.
  if (meta.id !== source.sessionId || meta.session_id !== source.sessionId || source.client !== 'codex' ||
      !['cli', 'vscode', 'exec', 'mcp'].includes(meta.source) || (meta.thread_source != null && !['user', 'agent_created_thread'].includes(meta.thread_source)) ||
      meta.parent_thread_id != null || meta.agent_path != null || meta.subagent_history_start_ordinal != null || meta.history_base != null ||
      meta.forked_from_id != null || meta.forked_from_ordinal_exclusive != null) fail('UNSUPPORTED_SESSION_OWNERSHIP');
  absolutePath(meta.cwd);
  // Registered canonical spelling remains usable after a project is moved/deleted.
  if (path.normalize(meta.cwd) !== path.normalize(source.projectRoot) &&
      await fs.realpath(meta.cwd).catch(() => null) !== source.projectRoot) fail('SOURCE_IDENTITY_MISMATCH');
  if (!['legacy', 'paginated'].includes(meta.history_mode)) fail('UNSUPPORTED_CODEX_HISTORY');
  if (meta.history_mode === 'paginated') integer(line.ordinal);
  return { client: 'codex', sessionId: meta.id, projectRoot: source.projectRoot,
    version: meta.cli_version, historyMode: meta.history_mode };
}

/** Same bounded parser and verifier for explicit registration and later reads. */
export const codexRegistrationHeader = selected => async io => verifyCodexHeader(await readSessionHeader(io),
  { ...selected, projectRoot: await fs.realpath(selected.projectRoot) });

function blocks(collector, record, content, kind, syntax) {
  if (!Array.isArray(content)) fail('UNSUPPORTED_CODEX_RECORD');
  for (const item of content) {
    if (['text', 'input_text', 'output_text', 'Text'].includes(item?.type)) {
      collector.add(kind, record, { text: textValue(item.text) });
    } else if (['image', 'input_image'].includes(item?.type)) {
      collector.add('attachment', record, { reference: item.image_url ?? item.url,
        ...(typeof item.caption === 'string' ? { caption: item.caption } : {}) });
    } else if (['local_image', 'local_audio'].includes(item?.type) && syntax === 'user') {
      collector.add('attachment', record, { reference: item.path });
    } else if (item?.type === 'encrypted_content') collector.omit('encrypted-content-excluded', record);
    else if (['input_audio', 'audio', 'skill', 'mention'].includes(item?.type)) collector.omit('unsupported-content-block', record);
    else fail('UNSUPPORTED_CODEX_CONTENT');
  }
}

function toolText(collector, record, output) {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) fail('UNSUPPORTED_CODEX_TOOL_OUTPUT');
  const texts = [];
  for (const block of output) {
    if (block?.type === 'input_text') texts.push(textValue(block.text));
    else if (block?.type === 'input_image') collector.add('attachment', record, { reference: block.image_url });
    else if (['input_audio', 'encrypted_content'].includes(block?.type)) collector.omit('unsupported-tool-content', record);
    else fail('UNSUPPORTED_CODEX_TOOL_OUTPUT');
  }
  return texts.join('\n');
}

function normalizeUnit(unit, historyMode, checkBudget, toolRulesVersion) {
  const collector = evidenceCollector(undefined, { toolRulesVersion }), calls = new Map(), seen = new Map(), outcomes = new Map(), collabIds = new Set(unit.collaborationIds);
  // Only structured native completion status can refine an observed tool outcome.
  for (const record of unit.records) {
    checkBudget();
    const p = record.value.payload, item = p?.type === 'item_completed' ? p.item : null;
    if (item?.type === 'CommandExecution') {
      string(item.id, 256); choice(item.status, ['in_progress', 'completed', 'failed', 'declined']);
      outcomes.set(item.id, item.status === 'completed' && item.exit_code === 0 ? 'succeeded'
        : item.status === 'failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0) ? 'failed' : 'unknown');
    }
    if (p?.type === 'patch_apply_end') outcomes.set(p.call_id, p.status === 'declined' ? 'unknown' : p.success === true ? 'succeeded' : p.success === false ? 'failed' : 'unknown');
    if (p?.type === 'mcp_tool_call_end') outcomes.set(p.call_id, p.result?.Err != null || p.result?.Ok?.isError === true ? 'failed' : p.result?.Ok?.isError === false ? 'succeeded' : 'unknown');
    if (record.value.type === 'response_item' && collaborationTools.has(p.name) &&
        (!p.namespace || p.namespace === 'collaboration' || (p.namespace === 'functions' && p.name !== 'wait'))) collabIds.add(p.call_id);
  }
  for (const record of unit.records) {
    checkBudget();
    const { type, payload: p, metadata } = record.value;
    if (metadata?.inherited_user_message) continue;
    // IDs identify duplicate representations, not repeated text from distinct events.
    const id = type === 'response_item' ? p.id : p?.type === 'item_completed' ? p.item?.id : null;
    if (id != null) {
      const { internal_chat_message_metadata_passthrough: timingMetadata, ...nativePayload } = p;
      void timingMetadata; // Unit attribution already verified independently; creation time is not evidence.
      string(id, 256); const key = `${type}:${p.type}:${p.item?.type ?? ''}:${id}`, normalized = canonicalJSON(p.item ?? nativePayload);
      if (seen.has(key)) { if (seen.get(key) !== normalized) fail('CONFLICTING_CODEX_MIRROR'); continue; }
      seen.set(key, normalized);
    }
    if (type === 'event_msg') {
      if (p.type === 'user_message' && historyMode === 'legacy') {
        collector.add('user', record, { text: textValue(p.message) });
        for (const reference of [...(p.images ?? []), ...(p.local_images ?? []), ...(p.local_audio ?? [])]) collector.add('attachment', record, { reference });
        for (let i = 0; i < (p.file_ids?.length ?? 0); i++) collector.omit('opaque-attachment-id', record);
        for (let i = 0; i < (p.audio?.length ?? 0); i++) collector.omit('inline-audio-not-copied', record);
        continue;
      }
      if (legacyItems.has(p.type)) {
        if (!unit.records.some(r => r.value.type === 'response_item' && r.value.payload.call_id === p.call_id && p.call_id != null)) collector.omit('unsupported-native-item', record);
        continue;
      }
      if (p.type !== 'item_completed') continue;
      const item = p.item;
      if (ignoredItems.has(item?.type)) continue;
      if (item?.type === 'UserMessage' || item?.type === 'AgentMessage') {
        if (historyMode !== 'paginated') fail('UNSUPPORTED_CODEX_HISTORY');
        blocks(collector, record, item.content, item.type === 'UserMessage' ? 'user' : 'assistant', item.type === 'UserMessage' ? 'user' : 'assistant');
      } else if (item?.type === 'CommandExecution') {
        // Status corroborates raw tool evidence; command output is not copied a second time.
        if (!unit.records.some(r => r.value.type === 'response_item' && r.value.payload.call_id === item.id)) collector.omit('native-tool-without-raw-evidence', record);
      } else if (item?.type === 'FunctionCallOutput') {
        if (!unit.records.some(r => r.value.type === 'response_item' && r.value.payload.call_id === item.id && r.value.payload.type.endsWith('_output'))) {
          if (collabIds.has(item.id)) collector.omit('child-agent-output-excluded', record);
          else collector.add('tool-result', record, { tool: toolName(item), callId: string(item.id, 256), outcome: outcomes.get(item.id) ?? 'unknown', text: toolText(collector, record, item.output) });
        }
      } else if (['Plan', 'FileChange', 'McpToolCall', 'DynamicToolCall', 'WebSearch', 'ImageView', 'ImageGeneration', 'Extension', 'EnteredReviewMode', 'ExitedReviewMode'].includes(item?.type)) {
        const represented = unit.records.some(r => r.value.type === 'response_item' && r.value.payload.call_id === item.id);
        if (!represented) collector.omit('unsupported-native-item', record);
      }
      else fail('UNSUPPORTED_CODEX_ITEM');
      continue;
    }
    if (type !== 'response_item' || ignoredResponses.has(p.type)) continue;
    if (p.type === 'message') {
      if (p.role === 'assistant' && historyMode === 'legacy') blocks(collector, record, p.content, 'assistant', 'response');
      else if (!['assistant', 'user', 'developer', 'system'].includes(p.role)) fail('UNSUPPORTED_CODEX_ROLE');
      // User-facing native records above are authoritative; model context may be injected.
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const callId = string(p.call_id, 256), tool = toolName(p);
      if (calls.has(callId)) fail('CONFLICTING_CODEX_CALL'); calls.set(callId, tool);
      if (collabIds.has(callId)) { collector.omit('child-agent-output-excluded', record); continue; }
      collector.add('tool-call', record, { tool, callId, text: p.type === 'function_call' ? p.arguments : p.input });
      if (p.encrypted_function_args?.length) collector.omit('encrypted-tool-arguments-excluded', record);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      if (p.call_id == null) { collector.omit('unattributed-tool-output', record); continue; }
      const callId = string(p.call_id, 256), tool = calls.get(callId) ?? (p.name ? toolName(p) : null);
      if (collabIds.has(callId)) { collector.omit('child-agent-output-excluded', record); continue; }
      if (!tool) { collector.omit('unattributed-tool-output', record); continue; }
      collector.add('tool-result', record, { tool, callId, outcome: outcomes.get(callId) ?? 'unknown', text: toolText(collector, record, p.output) });
    } else if (['local_shell_call', 'tool_search_call', 'tool_search_output', 'web_search_call', 'image_generation_call'].includes(p.type)) collector.omit('unsupported-native-tool', record);
    else fail('UNSUPPORTED_CODEX_RESPONSE');
  }
  return collector;
}

/** Library-only preview/extraction. Selection and source are helper-owned, never transcript controls. */
export async function readCodexSelection({ state, scopeId, cursor = null, loadHead = null, resolveProcessingDispatch = null,
  resolveProcessingExecution = null,
  capturedAt = new Date().toISOString(), deadline = Infinity, now = Date.now, ...limits }) {
  validateSelectionState(state); nativeId(scopeId); timestamp(capturedAt);
  const scope = currentIntervals(state).find(item => item.id === scopeId) ?? state.explicitScopes.find(item => item.id === scopeId);
  if (!scope) fail('CAPTURE_NOT_SELECTED');
  const floor = scope.lower?.eofByte ?? scope.start.startByte, source = state.source;
  const from = cursor ?? { sourceIdentity: source.fileIdentity, offset: floor, anchor: null };
  if (from.sourceIdentity !== source.fileIdentity || from.offset < floor) fail('INVALID_INTAKE_CURSOR');
  if (cursor) await verifySourceCursor(source, cursor);
  const checkBudget = () => { checkWorkflowBudget(); if (now() >= deadline) fail('SESSION_READ_BUDGET'); };
  const scan = await readSessionRange({ ...limits, source, from: from.offset, deadline, now,
    ...(scope.end ? { endByte: scope.end.endByte } : {}),
    startsMidRecord: from.offset === floor && Boolean(scope.lower?.startsMidRecord), verifyHeader: verifyCodexHeader });
  let selection = structuredClone(state), previousOrdinal = -1, blocked = scan.blocked;
  const units = new Map(), anchors = [], anchorUpdates = [], unanchoredUnits = new Set(), noEvidence = [], frames = scan.discarded.map(item => ({ ...item, kind: 'excluded' }));
  const remember = (unitId, record) => {
    anchors.push({ unitId, record: anchor(record) });
    for (const interval of selection.intervals.filter(item => item.id === scopeId)) for (const side of ['lower', 'upper']) {
      const boundary = interval[side];
      // A pause prompt is normally already persisted before its EOF snapshot.
      // Its upper anchor must start by that EOF; a delayed duplicate cannot move
      // the pause past intervening turns. Lower anchors respect the frozen floor.
      if (boundary && (boundary.unitId === unitId || (side === 'lower' && boundary.unitId === null)) && boundary.record === null &&
          (side === 'lower' || (record.value.payload.type === 'task_started' && record.startByte <= boundary.eofByte)) &&
          record.startByte >= (side === 'lower' ? boundary.eofByte : interval.lower.eofByte)) {
        const proven = { sourceIdentity: source.fileIdentity, unitId, record: anchor(record) };
        selection = resolveSelectionAnchor(selection, interval.id, side, proven);
        anchorUpdates.push({ intervalId: interval.id, side, proven });
      }
    }
  };
  const owned = (record, unitId) => {
    nativeId(unitId);
    const unit = units.get(unitId);
    if (!unit) { unanchoredUnits.add(unitId); frames.push({ ...range(record), kind: 'excluded' }); return; }
    if (unit.end) { unit.fault = 'EVIDENCE_AFTER_CODEX_TERMINAL'; frames.push({ ...range(record), kind: 'unit', unitId }); return; }
    unit.records.push(record); frames.push({ ...range(record), kind: 'unit', unitId });
  };
  for (const record of scan.records) {
    try {
    checkBudget();
    const line = record.value, p = line?.payload;
    if (!line || !p || typeof p !== 'object') fail('UNSUPPORTED_CODEX_RECORD');
    timestamp(line.timestamp);
    if (line.type === 'session_meta') {
      const metadata = await verifyCodexHeader(line, source);
      if (metadata.historyMode !== scan.metadata.historyMode) fail('UNSUPPORTED_CODEX_HISTORY');
    }
    if (scan.metadata.historyMode === 'paginated') {
      integer(line.ordinal);
      if (line.ordinal <= previousOrdinal) fail('UNSUPPORTED_CODEX_ORDER'); previousOrdinal = line.ordinal;
      record.id = `codex:ordinal:${line.ordinal}`;
    } else record.id = `codex:byte:${record.startByte}:${record.hash.slice(0, 20)}`;
    if (line.type === 'session_meta') {
      frames.push({ ...range(record), kind: 'structural' }); continue;
    }
    if (structural.has(line.type)) { frames.push({ ...range(record), kind: 'structural' }); continue; }
    if (line.type === 'event_msg' && p.type === 'task_started') {
      const unitId = nativeId(p.turn_id);
      if (p.root_turn_id != null && p.root_turn_id !== unitId) fail('UNSUPPORTED_SESSION_OWNERSHIP');
      if (units.has(unitId)) { units.get(unitId).fault = 'DUPLICATE_CODEX_START'; frames.push({ ...range(record), kind: 'unit', unitId }); continue; }
      // The verified root task lifecycle serializes legacy turns. Without ordinals,
      // overlapping starts cannot establish succession or legacy event ownership.
      if (scan.metadata.historyMode === 'legacy' && [...units.values()].some(unit => !unit.end)) fail('UNSUPPORTED_CODEX_ORDER');
      if (units.size >= 4096) fail('SESSION_UNIT_LIMIT');
      units.set(unitId, { id: unitId, start: record, records: [record], end: null, terminal: null, collaborationIds: new Set() });
      if (unanchoredUnits.has(unitId)) units.get(unitId).fault = 'EVIDENCE_BEFORE_CODEX_START';
      remember(unitId, record); frames.push({ ...range(record), kind: 'unit', unitId }); continue;
    }
    if (line.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(p.type)) {
      const unitId = nativeId(p.turn_id), unit = units.get(unitId);
      if (unit?.end) {
        if (canonicalJSON(unit.end.value.payload) !== canonicalJSON(p)) unit.fault = 'CONFLICTING_CODEX_TERMINAL';
        frames.push({ ...range(record), kind: 'structural' }); continue;
      }
      if (!unit) { remember(unitId, record); frames.push({ ...range(record), kind: 'excluded' }); continue; }
      owned(record, unitId); unit.end = record;
      if (p.type === 'turn_aborted') { choice(p.reason, ['interrupted', 'replaced', 'review_ended', 'budget_limited']); unit.terminal = 'interrupted'; }
      else unit.terminal = p.error == null ? 'completed' : 'failed';
      continue;
    }
    if (line.type === 'turn_context') {
      if (p.root_turn_id != null && p.turn_id != null && p.root_turn_id !== p.turn_id) fail('UNSUPPORTED_SESSION_OWNERSHIP');
      frames.push({ ...range(record), kind: 'structural' }); continue;
    }
    if (line.type === 'event_msg' && (ignoredEvents.has(p.type) || (p.type === 'agent_message' && scan.metadata.historyMode === 'legacy'))) {
      frames.push({ ...range(record), kind: 'structural' }); continue;
    }
    if (line.type === 'event_msg' && p.type === 'thread_rolled_back') {
      for (const unit of units.values()) unit.fault = 'CODEX_ROLLBACK_REQUIRES_REVIEW';
      fail('CODEX_ROLLBACK_REQUIRES_REVIEW');
    }
    if (line.type === 'event_msg' && p.type === 'item_completed' && (ignoredItems.has(p.item?.type) || p.item?.type === 'CollabAgentToolCall')) {
      if (p.item?.type === 'CollabAgentToolCall' && units.has(p.turn_id)) units.get(p.turn_id).collaborationIds.add(p.item.id);
      frames.push({ ...range(record), kind: 'structural' }); continue;
    }
    if (line.type === 'response_item' || (line.type === 'event_msg' && (['user_message', 'item_completed'].includes(p.type) || legacyItems.has(p.type)))) {
      if (line.type === 'event_msg' && p.type === 'item_completed' && p.thread_id !== source.sessionId) fail('SOURCE_IDENTITY_MISMATCH');
      if (line.type === 'event_msg' && p.type === 'user_message' && scan.metadata.historyMode !== 'legacy') fail('UNSUPPORTED_CODEX_HISTORY');
      if (line.type === 'response_item' && (ignoredResponses.has(p.type) ||
          (p.type === 'message' && ['user', 'developer', 'system'].includes(p.role)) || line.metadata?.inherited_user_message)) {
        frames.push({ ...range(record), kind: 'structural' }); continue;
      }
      let unitId = line.type === 'response_item' ? p.internal_chat_message_metadata_passthrough?.turn_id : p.turn_id;
      if (unitId == null) {
        const open = [...units.values()].filter(unit => !unit.end);
        if (units.size === 0) { frames.push({ ...range(record), kind: 'excluded' }); continue; }
        if (open.length !== 1) fail('AMBIGUOUS_CODEX_ATTRIBUTION');
        unitId = open[0].id;
      }
      owned(record, unitId); continue;
    }
    fail('UNSUPPORTED_CODEX_RECORD');
    } catch (error) { blocked = { offset: record.startByte, code: error.code ?? 'UNSUPPORTED_CODEX_RECORD' }; break; }
  }
  const knownAnchors = [...anchors];
  for (const interval of currentIntervals(selection).filter(item => item.id === scopeId)) for (const boundary of [interval.lower, interval.upper]) {
    if (boundary?.record && !knownAnchors.some(item => item.unitId === boundary.unitId && canonicalJSON(item.record) === canonicalJSON(boundary.record)))
      knownAnchors.push({ unitId: boundary.unitId, record: boundary.record });
  }
  const ordered = [...knownAnchors].sort((a, b) => scan.metadata.historyMode === 'paginated'
    ? orderOf(a.record) - orderOf(b.record) : a.record.startByte - b.record.startByte);
  const nativeOrder = { kind: scan.metadata.historyMode === 'paginated' ? 'native-sequence' : 'verified-lifecycle',
    units: [...new Set(ordered.map(item => item.unitId))], anchors: knownAnchors };
  const candidates = [], pending = [], processingControls = [], eligibility = new Map();
  for (const unit of units.values()) {
    try {
    if (unit.fault) { pending.push({ unitId: unit.id, reason: unit.fault }); continue; }
    const proof = { client: 'codex', sessionId: source.sessionId, sourceIdentity: source.fileIdentity, unitId: unit.id,
      start: anchor(unit.start), end: anchor(unit.end ?? unit.start), nativeOrder };
    const selected = evaluateUnitSelection(selection, proof), permitted = selected.scopes.some(item => item.scopeId === scopeId);
    eligibility.set(unit.id, permitted ? 'selected' : selected.pendingScopes?.includes(scopeId) ? 'unresolved' : 'excluded');
    const upper = selection.intervals.find(item => item.id === scopeId)?.upper;
    const upperIndex = upper?.record ? nativeOrder.units.indexOf(upper.unitId) : -1;
    const closedExclusion = !permitted && !selected.pendingScopes?.includes(scopeId) && upperIndex >= 0 && nativeOrder.units.indexOf(unit.id) >= upperIndex;
    // Only a proven closed tail can ignore its excluded lifecycle. Active
    // legacy scopes must retain an unfinished boundary so the next pass still
    // detects overlapping starts and cannot misattribute untagged evidence.
    if (!unit.end && !closedExclusion) {
      eligibility.delete(unit.id);
      pending.push({ unitId: unit.id, reason: blocked?.code ?? (scan.limited ? 'SESSION_READ_LIMIT' : 'terminal-not-persisted') }); continue;
    }
    if (!permitted) { if (selected.pendingScopes?.includes(scopeId)) pending.push({ unitId: unit.id, reason: 'anchor-unresolved' }); continue; }
    if (unit.end.endByte - unit.end.startByte > 64 * 1024) { pending.push({ unitId: unit.id, reason: 'SOURCE_ANCHOR_LIMIT' }); continue; }
    // An already-published unit may be reread while an earlier unit holds the
    // cursor. Reproduce its original rules rather than replacing finalized data.
    const loadedHead = await loadHead?.(unit.id), prior = loadedHead?.capture;
    let readerVersion = CODEX_READER_VERSION;
    if (prior) {
      validateCapture(prior);
      if (prior.identity.client !== 'codex' || prior.identity.sessionId !== source.sessionId || prior.identity.unitId !== unit.id ||
          prior.source.fileIdentity !== source.fileIdentity || prior.source.path !== source.path || prior.projectRoot !== source.projectRoot) fail('SOURCE_IDENTITY_MISMATCH');
      if (prior.reader.name !== 'codex-rollout') fail('UNSUPPORTED_CODEX_READER');
      readerVersion = choice(prior.reader.version, Object.keys(CODEX_TOOL_RULES));
    }
    // Only a trusted native controller receipt plus a complete byte-level proof
    // can exclude a control-only turn. Published evidence keeps its old identity
    // and content; absent head loading is not evidence that no head exists.
    const selectedSkill = unit.records.some(record => record.value.payload?.item?.type === 'UserMessage' &&
      record.value.payload.item.content?.some?.(part => part.type === 'skill' && part.name === 'cuefluent-notes'));
    if (!prior && !loadedHead?.head && typeof loadHead === 'function' && typeof resolveProcessingExecution === 'function' && unit.terminal === 'completed') {
      const receipt = await resolveProcessingExecution({ client: 'codex', sessionId: source.sessionId, unitId: unit.id });
      if (receipt) {
        const execution = await verifyProcessingExecution({ source, unitId: unit.id, fromByte: unit.start.startByte,
          endByte: unit.end.endByte }, { resolveExecution: async () => receipt });
        if (isProcessingExecutionProof(execution)) {
          const original = scan.records.filter(record => record.startByte >= execution.fromByte && record.endByte <= execution.endByte);
          if (digest(canonicalJSON(original.map(record => ({ startByte: record.startByte, endByte: record.endByte, hash: record.hash })))) !== execution.recordsHash) fail('SOURCE_CHANGED');
          processingControls.push(execution); eligibility.set(unit.id, 'excluded'); continue;
        }
      }
    }
    if (!prior && !loadedHead?.head && typeof loadHead === 'function' && typeof resolveProcessingDispatch === 'function' &&
        unit.terminal === 'completed' && selectedSkill) {
      checkBudget();
      const control = await verifyCodexProcessingControl({ source, unitId: unit.id,
        fromByte: unit.start.startByte, endByte: unit.end.endByte }, { resolveDispatch: resolveProcessingDispatch });
      checkBudget();
      if (isProcessingControlProof(control)) {
        const original = scan.records.filter(record => record.startByte >= control.fromByte && record.endByte <= control.endByte);
        if (digest(canonicalJSON(original.map(record => record.hash))) !== control.recordsHash) fail('SOURCE_CHANGED');
        processingControls.push(control); eligibility.set(unit.id, 'excluded'); continue;
      }
    }
    const collected = normalizeUnit(unit, scan.metadata.historyMode, checkBudget, CODEX_TOOL_RULES[choice(readerVersion, Object.keys(CODEX_TOOL_RULES))]);
    if (!collected.evidence.length && !collected.omissions.length) { noEvidence.push(unit.id); eligibility.set(unit.id, 'excluded'); continue; }
    const occurredAt = Number.isSafeInteger(unit.start.value.payload.started_at)
      ? new Date(unit.start.value.payload.started_at * 1000).toISOString() : unit.start.value.timestamp;
    const capture = createCapture({ format: 'cuefluent-capture', schemaVersion: 2,
      identity: { client: 'codex', sessionId: source.sessionId, unitId: unit.id }, projectRoot: source.projectRoot,
      source: { path: source.path, fileIdentity: source.fileIdentity, ranges: compactRanges(unit.records) },
      reader: { name: 'codex-rollout', version: readerVersion, headerClientVersion: scan.metadata.version },
      occurredAt, capturedAt, terminal: unit.terminal,
      coverage: { partial: unit.terminal !== 'completed' || collected.omissions.length > 0, omissions: collected.omissions }, evidence: collected.evidence });
    candidates.push({ capture, proof, scopeId });
    } catch (error) { pending.push({ unitId: unit.id, reason: error.code ?? 'UNSUPPORTED_CODEX_UNIT' }); }
  }
  return { candidates, pending, noEvidence, processingControls, unanchoredUnits: [...unanchoredUnits], blocked, anchorUpdates, selection, from, frames, eligibility, scopeId,
    nativeAnchors: anchors, cursorAnchors: scan.records.map(record => record.tailAnchor),
    recordAnchors: scan.records.filter(record => record.id && (!blocked || record.endByte <= blocked.offset)).map(anchor),
    diagnostics: { pendingTail: scan.pendingTail, limited: scan.limited, bytesRead: scan.bytesRead, snapshotEnd: scan.snapshotEnd } };
}

/** Preview and intake use the same conservative prefix accounting. Published hashes are helper-owned. */
export function codexPublicationPlan(result, unitId, published = new Map()) {
  const candidate = result.candidates.find(item => item.capture.identity.unitId === unitId);
  if (!candidate) fail('CAPTURE_NOT_SELECTED');
  const to = terminalCursor(result.selection.source, candidate.proof.end), accounted = [];
  const held = reason => ({ scan: { from: result.from, to: result.from, accounted: [] }, heldReason: reason });
  let offset = result.from.offset;
  for (const frame of result.frames) {
    if (frame.startByte >= to.offset) break;
    if (frame.startByte !== offset) return held('unaccounted-source-gap');
    let kind = frame.kind, fields = {};
    if (kind === 'unit') {
      if (frame.unitId === unitId) { kind = 'captured'; fields = { unitId }; }
      else if (result.eligibility.get(frame.unitId) === 'excluded') kind = 'excluded';
      else if (published.has(frame.unitId)) { kind = 'published'; fields = { unitId: frame.unitId, ...published.get(frame.unitId) }; }
      else return held(result.pending.find(item => item.unitId === frame.unitId)?.reason ?? 'unpublished-earlier-unit');
    }
    // Known structural records within the current native turn are safe to fold
    // into its captured span; foreign unit records always retain their ownership.
    if (kind === 'structural' && frame.startByte >= candidate.proof.start.startByte) { kind = 'captured'; fields = { unitId }; }
    const previous = accounted.at(-1);
    if (previous && previous.kind === kind && previous.unitId === fields.unitId && previous.fileHash === fields.fileHash) previous.endByte = frame.endByte;
    else accounted.push({ startByte: frame.startByte, endByte: frame.endByte, kind, ...fields });
    offset = frame.endByte;
  }
  return offset === to.offset && accounted.length <= 1024 ? { scan: { from: result.from, to, accounted }, heldReason: null }
    : held(accounted.length > 1024 ? 'interleaved-accounting-limit' : 'unaccounted-source-gap');
}

/** Advance only a fully accounted prefix; unresolved units keep their bytes pending. */
export function codexProgressPlan(result, published = new Map()) {
  if (result.anchorUpdates.length) fail('SELECTION_ANCHORS_PENDING');
  const accounted = []; let offset = result.from.offset, heldReason = null, lastAnchor = null;
  const anchorsByEnd = new Map(result.cursorAnchors.map(anchor => [anchor.endByte, anchor]));
  for (const frame of result.frames) {
    if (frame.startByte !== offset || (result.blocked && frame.startByte >= result.blocked.offset)) break;
    let kind = frame.kind, fields = {};
    if (kind === 'unit') {
      if (result.eligibility.get(frame.unitId) === 'excluded') kind = 'excluded';
      else if (published.has(frame.unitId)) { kind = 'published'; fields = { unitId: frame.unitId, ...published.get(frame.unitId) }; }
      else { heldReason = result.pending.find(item => item.unitId === frame.unitId)?.reason ?? 'unpublished-earlier-unit'; break; }
    }
    if (!['structural', 'excluded', 'published'].includes(kind)) break;
    const previous = accounted.at(-1);
    if (previous && previous.kind === kind && previous.unitId === fields.unitId && previous.fileHash === fields.fileHash) previous.endByte = frame.endByte;
    else {
      if (accounted.length === 1024) { heldReason = 'interleaved-accounting-limit'; break; }
      accounted.push({ startByte: frame.startByte, endByte: frame.endByte, kind, ...fields });
    }
    offset = frame.endByte;
    lastAnchor = anchorsByEnd.get(offset) ?? lastAnchor;
  }
  const end = lastAnchor?.endByte ?? result.from.offset;
  const to = end === result.from.offset ? result.from : { sourceIdentity: result.from.sourceIdentity, offset: end, anchor: lastAnchor };
  return { scan: { from: result.from, to, accounted: accounted.filter(item => item.startByte < end).map(item => ({ ...item, endByte: Math.min(item.endByte, end) })) },
    checkpoint: codexCheckpoint(result, to.offset), heldReason };
}

export function codexCheckpoint(result, offset) {
  // Cursor-only checkpoint representation is unchanged by capture text rules.
  return { format: 'cuefluent-reader-checkpoint', version: 1, reader: 'codex-rollout/1',
    client: 'codex', sessionId: result.selection.source.sessionId, scopeId: result.scopeId,
    sourceIdentity: result.from.sourceIdentity, offset, records: [], units: [] };
}
