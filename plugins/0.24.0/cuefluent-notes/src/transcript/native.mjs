import { metaValue as value, rowTokenStream, transcriptError } from './source.mjs';
import { nativeId } from './checkpoint.mjs';

const atKey = at => JSON.stringify(at);
const hasString = (row, at) => Object.hasOwn(row.strings, atKey(at)) || Object.hasOwn(row.stringShapes ?? {}, atKey(at));
const blockIndices = (row, prefix) => [...new Set(Object.keys(row.values).map(key => JSON.parse(key))
  .filter(at => at.length === prefix.length + 2 && prefix.every((part, i) => at[i] === part) && Number.isInteger(at[prefix.length]))
  .map(at => at[prefix.length]))].sort((a, b) => a - b);

function field(row, kind, path, { blockIndex = 0, callId = null, tool = null, format = 'text' } = {}) {
  if (!hasString(row, path) && !Object.hasOwn(row.containers, atKey(path))) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'A native content value is missing or unsupported');
  return Object.freeze({ kind, path: Object.freeze(path), blockIndex, callId, tool, format,
    total: row.strings[atKey(path)]?.units ?? null, bytes: row.strings[atKey(path)]?.bytes ?? null });
}

function contentFields(row, prefix, kind, acceptedType, options = {}, omittedTypes = []) {
  return blockIndices(row, prefix).map(index => {
    const type = value(row, ...prefix, index, 'type');
    if (omittedTypes.includes(type)) return Object.freeze({ ...field(row, kind, [...prefix, index], { ...options, blockIndex: index, format: 'notice' }),
      total: 0, bytes: 0, omittedType: type });
    if (type !== acceptedType) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported native content block');
    return field(row, kind, [...prefix, index, 'text'], { ...options, blockIndex: index });
  });
}

/** Classify only the observed CLI append shapes. Parent pointers identify native
 * structure; they do not assign a late row to an older human exchange.
 */
export function classifyNativeRow(row, { client, sessionId, completion = null, currentPromptId = null, currentRowId = null, historyVerified = false } = {}) {
  const type = value(row, 'type');
  if (client === 'claude') {
    const nativeSession = value(row, 'sessionId');
    if (nativeSession !== undefined && nativeSession !== sessionId) transcriptError('TRANSCRIPT_IDENTITY_MISMATCH', 'Claude row belongs to another native session');
    if (value(row, 'isSidechain') === true) return { kind: 'ignore', rowId: value(row, 'uuid') };
    if (value(row, 'isCompactSummary') === true || value(row, 'isVisibleInTranscriptOnly') === true ||
        value(row, 'isMeta') === true || value(row, 'turnCompanion') === true) return { kind: 'ignore', rowId: value(row, 'uuid') };
    if (!['user', 'assistant'].includes(type)) {
      const known = ['queue-operation', 'attachment', 'system', 'last-prompt', 'atis-latch', 'cost-state', 'api-request', 'api-request-blob', 'api-request-shape', 'file-history-snapshot', 'file-history-delta', 'progress', 'summary', 'mode',
        'custom-title', 'ai-title', 'agent-name', 'agent-color', 'agent-setting', 'bridge-session', 'pr-link', 'permission-mode', 'tag', 'worktree-state', 'isolation-latch', 'attribution-snapshot'];
      // Unlisted producer bookkeeping is excluded only when it carries this exact
      // native session identity; an unknown kind without it stays an explicit gap.
      if (!known.includes(type) && (typeof type !== 'string' || nativeSession !== sessionId)) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported Claude native row kind');
      if (type === 'api-request-shape' && nativeSession !== sessionId) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'API request shape bookkeeping requires its native session identity');
      if (type === 'mode' && (nativeSession !== sessionId || !hasString(row, ['mode']))) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported Claude mode bookkeeping row');
      return { kind: 'ignore', rowId: value(row, 'uuid') };
    }
    if (nativeSession !== sessionId) transcriptError('TRANSCRIPT_IDENTITY_MISMATCH', 'Claude conversation rows require the verified native session identity');
    const rowId = nativeId(value(row, 'uuid')), role = value(row, 'message', 'role');
    if (role !== type) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Claude message role does not match its row');
    const fields = [], indices = blockIndices(row, ['message', 'content']);
    const results = indices.filter(index => value(row, 'message', 'content', index, 'type') === 'tool_result');
    if (type === 'user' && results.length) {
      for (const index of indices) {
        if (value(row, 'message', 'content', index, 'type') !== 'tool_result') transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Mixed native tool-result and human content is ambiguous');
        const callId = nativeId(value(row, 'message', 'content', index, 'tool_use_id')), base = ['message', 'content', index, 'content'];
        if (hasString(row, base)) fields.push(field(row, 'tool-result', base, { blockIndex: index, callId }));
        else fields.push(...contentFields(row, base, 'tool-result', 'text', { callId }, ['image', 'tool_reference']));
      }
      return { kind: 'content', rowId, fields };
    }
    if (type === 'user') {
      const promptId = value(row, 'promptId');
      if (value(row, 'turnOrigin') === undefined && value(row, 'turnPosition', 'turnIndex') === undefined) {
        // Native companion/interruption rows share the actual human's prompt
        // identity and lack its origin/position fields. Never match their text.
        // The row that opened the current exchange is that human, not a companion.
        if (promptId !== undefined && rowId !== currentRowId && promptId === currentPromptId) return { kind: 'ignore', rowId };
        // A completion signal identifies a turn, not which row opened it. Keep
        // any other prompt-shaped row verbatim, including local-command-looking
        // text: without native provenance it may be literal human input.
        if (promptId === undefined) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'The native user row has no prompt identity');
      }
      nativeId(promptId);
      if (hasString(row, ['message', 'content'])) fields.push(field(row, 'human', ['message', 'content']));
      else fields.push(...contentFields(row, ['message', 'content'], 'human', 'text', {}, ['image']));
      if (!fields.length) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'A native human prompt has no supported content');
      return { kind: 'human', rowId, promptId, fields };
    }
    for (const index of indices) {
      const block = value(row, 'message', 'content', index, 'type');
      if (block === 'text') fields.push(field(row, 'assistant', ['message', 'content', index, 'text'], { blockIndex: index }));
      else if (block === 'tool_use') {
        const base = ['message', 'content', index, 'input'];
        fields.push(field(row, 'tool-call', base, { blockIndex: index, callId: nativeId(value(row, 'message', 'content', index, 'id')),
          tool: nativeId(value(row, 'message', 'content', index, 'name')), format: hasString(row, base) ? 'text' : 'json' }));
      } else if (block === 'thinking') {
        // Native/API reasoning blocks are separate from the canonical response.
        // Validate the known envelope without retaining thinking/signature bytes.
        if (!hasString(row, ['message', 'content', index, 'thinking']) || !hasString(row, ['message', 'content', index, 'signature'])) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported Claude thinking block');
      } else if (block === 'redacted_thinking') {
        if (!hasString(row, ['message', 'content', index, 'data'])) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported Claude redacted thinking block');
      } else transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported Claude assistant block');
    }
    if (!fields.length) return { kind: 'ignore', rowId };
    return { kind: 'content', rowId, fields, terminal: value(row, 'message', 'stop_reason') === 'end_turn' };
  }
  if (client !== 'codex') transcriptError('TRANSCRIPT_IDENTITY_INVALID', 'Unsupported native client');
  if (type === 'session_meta') {
    if (value(row, 'payload', 'id') !== sessionId) transcriptError('TRANSCRIPT_IDENTITY_MISMATCH', 'Codex source belongs to another native session');
    if (!historyVerified && (value(row, 'payload', 'history_base', 'thread_id') !== undefined || value(row, 'payload', 'forked_from_id') !== undefined)) {
      transcriptError('TRANSCRIPT_HISTORY_REQUIRED', 'Paginated or inherited history requires a verified native history resolver');
    }
    return { kind: 'ignore', rowId: sessionId };
  }
  if (type === 'compacted') return { kind: 'ignore' }; // replacement_history is a snapshot, never a new human input.
  if (type === 'event_msg') {
    const nativeThread = value(row, 'payload', 'thread_id');
    if (nativeThread !== undefined && nativeThread !== sessionId) transcriptError('TRANSCRIPT_IDENTITY_MISMATCH', 'Codex event belongs to another native thread');
    if (value(row, 'payload', 'type') === 'task_started' &&
        (value(row, 'payload', 'turn_attribution', 'parent_turn_id') != null || value(row, 'payload', 'turn_attribution', 'initiating_agent_path') != null)) {
      transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'A child-agent turn requires verified native main-branch selection');
    }
    if (value(row, 'payload', 'type') === 'item_completed' && value(row, 'payload', 'item', 'type') === 'UserMessage') {
      if (nativeThread !== sessionId) transcriptError('TRANSCRIPT_IDENTITY_MISMATCH', 'Codex user input requires its verified native thread identity');
      const prefix = ['payload', 'item', 'content'], fields = [];
      for (const index of blockIndices(row, prefix)) {
        const block = value(row, ...prefix, index, 'type');
        if (block === 'skill') continue;
        if (block !== 'text') transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported Codex user input block');
        fields.push(field(row, 'human', [...prefix, index, 'text'], { blockIndex: index }));
      }
      return { kind: 'human', rowId: nativeId(value(row, 'payload', 'item', 'id')), promptId: nativeId(value(row, 'payload', 'turn_id')), fields };
    }
    // Completed AgentMessage/tool execution events duplicate the response layer.
    return { kind: 'ignore', rowId: value(row, 'payload', 'item', 'id') };
  }
  if (type !== 'response_item') {
    if (!['world_state', 'turn_context', 'token_usage_record', 'inter_agent_communication_metadata'].includes(type)) transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported Codex native row kind');
    return { kind: 'ignore' };
  }
  const subtype = value(row, 'payload', 'type'), rowId = value(row, 'payload', 'id');
  // These producer-defined input/control envelopes are not canonical assistant
  // messages or human prompts. Inspect their shape without retaining payloads.
  if (subtype === 'reasoning' && row.containers[atKey(['payload', 'summary'])] === 'array' ||
      ['compaction', 'compaction_summary'].includes(subtype) && hasString(row, ['payload', 'encrypted_content']) ||
      subtype === 'context_compaction' ||
      subtype === 'additional_tools' && typeof value(row, 'payload', 'role') === 'string' && row.containers[atKey(['payload', 'tools'])] === 'array' ||
      subtype === 'agent_message' && hasString(row, ['payload', 'author']) && hasString(row, ['payload', 'recipient']) && row.containers[atKey(['payload', 'content'])] === 'array') return { kind: 'ignore', rowId };
  if (subtype === 'message') {
    if (value(row, 'payload', 'role') !== 'assistant') return { kind: 'ignore', rowId };
    return { kind: 'content', rowId: nativeId(rowId), fields: contentFields(row, ['payload', 'content'], 'assistant', 'output_text'),
      terminal: value(row, 'payload', 'phase') === 'final_answer' };
  }
  if (['custom_tool_call', 'function_call'].includes(subtype)) {
    const at = ['payload', subtype === 'custom_tool_call' ? 'input' : 'arguments'];
    return { kind: 'content', rowId: nativeId(rowId), fields: [field(row, 'tool-call', at, {
      callId: nativeId(value(row, 'payload', 'call_id')), tool: nativeId(value(row, 'payload', 'name')) })] };
  }
  if (['custom_tool_call_output', 'function_call_output'].includes(subtype)) {
    const at = ['payload', 'output'], callId = nativeId(value(row, 'payload', 'call_id'));
    const fields = hasString(row, at) ? [field(row, 'tool-result', at, { callId })] : contentFields(row, at, 'tool-result', 'input_text', { callId }, ['input_image', 'input_audio', 'encrypted_content']);
    return { kind: 'content', rowId: nativeId(rowId), fields };
  }
  // Unknown response shapes remain explicit gaps rather than dropped prose.
  transcriptError('TRANSCRIPT_NATIVE_UNSUPPORTED', 'Unsupported Codex response item');
}

const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Stream lossless values. JSON object arguments keep every value and numeric
 * lexeme; whitespace and escaping are serialized canonically, not assembled.
 */
export async function* extractNativeFields(source, row, fields, { limits } = {}) {
  let active = -1, jsonStack = [], stringCarry = '';
  const beginValue = () => {
    const parent = jsonStack.at(-1);
    if (parent?.kind === 'array') return parent.count++ ? ',' : '';
    return '';
  };
  for await (const token of rowTokenStream(source, row, limits)) {
    if (active < 0) {
      active = fields.findIndex(item => same(item.path, token.path) && ['startString', 'startObject', 'startArray', 'startNumber', 'trueValue', 'falseValue', 'nullValue'].includes(token.name));
      if (active < 0) continue;
      jsonStack = []; stringCarry = '';
      yield { fieldIndex: active, type: 'start' };
    }
    const selected = fields[active]; let text = '';
    if (selected.format === 'notice') {
      // The field produces an explicit omission notice, never opaque content.
    } else if (selected.format === 'text') {
      if (token.name === 'stringChunk') text = token.value;
    } else {
      if (token.name === 'startObject' || token.name === 'startArray') {
        text = beginValue() + (token.name === 'startObject' ? '{' : '[');
        jsonStack.push({ kind: token.name === 'startObject' ? 'object' : 'array', count: 0 });
      } else if (token.name === 'endObject' || token.name === 'endArray') { jsonStack.pop(); text = token.name === 'endObject' ? '}' : ']'; }
      else if (token.name === 'key') { const parent = jsonStack.at(-1); text = (parent.count++ ? ',' : '') + JSON.stringify(token.value) + ':'; }
      else if (token.name === 'startString') text = beginValue() + '"';
      else if (token.name === 'stringChunk') {
        let value = stringCarry + token.value; stringCarry = '';
        if (/[\uD800-\uDBFF]$/.test(value)) { stringCarry = value.slice(-1); value = value.slice(0, -1); }
        text = JSON.stringify(value).slice(1, -1);
      } else if (token.name === 'endString') { text = JSON.stringify(stringCarry).slice(1, -1) + '"'; stringCarry = ''; }
      else if (token.name === 'startNumber') text = beginValue();
      else if (token.name === 'numberChunk') text = token.value;
      else if (['trueValue', 'falseValue', 'nullValue'].includes(token.name)) text = beginValue() + ({ trueValue: 'true', falseValue: 'false', nullValue: 'null' })[token.name];
    }
    if (text) yield { fieldIndex: active, type: 'text', text };
    if (same(selected.path, token.path) && ['endString', 'endObject', 'endArray', 'endNumber', 'trueValue', 'falseValue', 'nullValue'].includes(token.name)) {
      yield { fieldIndex: active, type: 'end' }; active = -1;
    }
  }
}
