import path from 'node:path';
import { readBoundedBytes } from './file-io.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { verifyCodexHeader } from './codex-reader.mjs';
import { claudeRegistrationHeader, claudeSessionKinds } from './claude-reader.mjs';
import { canonicalJSON, digest, integer, isNativeId, object } from './workflow-values.mjs';

const proofs = new WeakSet();
const MAX_CONTROL_BYTES = 2 * 1024 * 1024;
const MAX_CONTROL_RECORDS = 1024;
const CONTROL = 'process';
export const PROCESSING_CONTROLS = Object.freeze(['process', 'process repo', 'process chat', 'resume', 'status', 'review', 'cancel']);
// Review drafts are named by a short code (no i, l, o, u, 0 or 1). A typed
// review action may name a draft, a decision, or both; nothing is normalized.
export const REVIEW_CODE = /^[a-hjkmnp-tv-z2-9]{6}$/;
export const REVIEW_DECISIONS = Object.freeze(['save', 'skip', 'cancel', 'later']);
// How a person types a formal action in each client. Display only; the typed
// text itself is verified from the native transcript.
export const REVIEW_COMMANDS = Object.freeze({ claude: '/cuefluent-notes:cuefluent-notes', codex: '$cuefluent-notes' });
/** Canonical typed review action for review tool fields, or null. */
export function reviewControl({ draft, decision } = {}) {
  if (draft !== undefined && (typeof draft !== 'string' || !REVIEW_CODE.test(draft))) return null;
  if (decision !== undefined && !REVIEW_DECISIONS.includes(decision)) return null;
  return ['review', decision, draft].filter(part => part !== undefined).join(' ');
}
/** The exact typed control text, or null. Whitespace, case and other spellings
 * are not normalized, so a near miss stays ordinary input rather than a control. */
export function processingControlText(text) {
  if (typeof text !== 'string') return null;
  if (PROCESSING_CONTROLS.includes(text)) return text;
  const match = /^review (?:(save|skip|cancel|later)(?: ([a-z2-9]{6}))?|([a-z2-9]{6}))$/.exec(text);
  if (!match) return null;
  const args = match[1] ? { decision: match[1], ...(match[2] ? { draft: match[2] } : {}) } : { draft: match[3] };
  return reviewControl(args) === text ? text : null;
}
/** Fields of a typed review action; null when the text is not one. */
export function reviewControlFields(text) {
  if (processingControlText(text) === null || (text !== 'review' && !text.startsWith('review '))) return null;
  const parts = text.split(' ').slice(1), fields = {};
  if (REVIEW_DECISIONS.includes(parts[0])) fields.decision = parts.shift();
  if (parts.length) fields.draft = parts[0];
  return fields;
}
/** Exact action/argument binding, shared by native invocation and retained proof.
 * No keyword or substring classifies ordinary user work as processing output. */
export function processingControlAction(tool, args = {}) {
  const name = typeof tool === 'string' ? tool.split(/\.|__/).at(-1) : null;
  if (name === 'process_selected_captures' || name === 'process') {
    const scope = args.scope ?? 'collection';
    return scope === 'collection' ? 'process' : ['repo', 'chat'].includes(scope) ? `process ${scope}` : null;
  }
  if (name === 'processing_review') return reviewControl(args);
  return { processing_resume: 'resume', processing_status: 'status', processing_cancel: 'cancel' }[name] ?? null;
}
/** Claude copies typed review fields into its tool call, verified exactly.
 * Codex refuses those fields: its verified typed text alone names the draft
 * and decision, so its call to the review tool carries no review fields. */
export function processingControlMatches(command, tool, args, client) {
  const action = processingControlAction(tool, args);
  if (action === null || processingControlText(command) === null) return false;
  return command === action || (client === 'codex' && action === 'review' && reviewControlFields(command) !== null);
}
const hashLike = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const textBlocks = (blocks, kind) => Array.isArray(blocks) && blocks.length > 0 &&
  blocks.every(b => object(b) && b.type === kind && typeof b.text === 'string' &&
    Object.keys(b).every(k => ['type', 'text', 'annotations'].includes(k)))
  ? blocks.map(b => b.text).join('') : null;
const boundTo = (p, unitId) => p?.internal_chat_message_metadata_passthrough?.turn_id === unitId;
const ordinal = value => Number.isSafeInteger(value) && value >= 0;
const skillCommandLike = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}:cuefluent-notes$/.test(value);
const claudeText = row => typeof row?.message?.content === 'string' ? row.message.content : textBlocks(row?.message?.content, 'text');
const claudeHuman = row => row?.type === 'user' && row.message?.role === 'user' && row.isMeta !== true &&
  row.isVirtual !== true && row.isCompactSummary !== true && row.isVisibleInTranscriptOnly !== true &&
  !(Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'tool_result'));
// sessionKinds names a background kind tolerated only for a verified continuation.
const claudeRoot = (row, source, sessionKinds = []) => row?.sessionId === source.sessionId && row.isSidechain === false &&
  row.agentId == null && row.forkedFrom == null && row.foreignToBridgeSession == null &&
  (row.sessionKind == null || sessionKinds.includes(row.sessionKind));
const commandText = (command, control = CONTROL) => `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${control}</command-args>`;
export function claudeProcessingCommandKind(row, skillCommand = 'cuefluent-notes:cuefluent-notes') {
  if (!skillCommandLike(skillCommand) || !claudeHuman(row) || row.promptSource !== undefined) return null;
  const text = claudeText(row), prefix = commandText(skillCommand, ''), suffix = '</command-args>';
  if (typeof text !== 'string' || !text.startsWith(prefix.slice(0, -suffix.length)) || !text.endsWith(suffix)) return null;
  const control = processingControlText(text.slice(prefix.length - suffix.length, -suffix.length));
  return control !== null && text === commandText(skillCommand, control) ? control : null;
}
export const isClaudeProcessingCommand = (row, skillCommand) => claudeProcessingCommandKind(row, skillCommand) !== null;

/** Trusted installed skill only. This does not discover plugins or accept a
 * model-provided expansion. Unsupported substitutions remain unverified. */
export async function loadClaudeProcessingSkill({ skillPath, skillCommand = 'cuefluent-notes:cuefluent-notes', control = CONTROL }) {
  if (typeof skillPath !== 'string' || !path.isAbsolute(skillPath) || !skillCommandLike(skillCommand) || processingControlText(control) === null) return null;
  let snapshot;
  try { snapshot = await readBoundedBytes(skillPath, { maxBytes: 128 * 1024, noFollow: true, missing: true }); }
  catch { return null; }
  if (!snapshot) return null;
  const content = snapshot.toString('utf8'), header = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  if (!header) return null;
  let body = content.slice(header[0].length).trimStart();
  if (body.includes('${') || /\$\d|\$ARGUMENTS\[/.test(body)) return null;
  body = body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', control) : `${body}\n\nARGUMENTS: ${control}`;
  const expansion = `Base directory for this skill: ${path.dirname(skillPath)}\n\n${body}`;
  return Object.freeze({ skillPath, skillCommand, skillExpansionHash: digest(expansion) });
}

/** A typed native companion plus native skill-attributed MCP call binds the
 * formal command. Ordinary assistant parentUuid links are deliberately unused. */
export function findClaudeProcessingControlInput(records, { source, callId, tool, argsHash, skill, control, sessionKinds = [] }) {
  if (!skill || !skillCommandLike(skill.skillCommand) || !hashLike(skill.skillExpansionHash)) return null;
  const kinds = claudeSessionKinds(sessionKinds);
  if (control !== undefined && processingControlText(control) === null) return null;
  const plugin = skill.skillCommand.split(':')[0], calls = [];
  for (let index = 0; index < records.length; index++) {
    const row = records[index].value;
    if (row?.type !== 'assistant' || row.message?.role !== 'assistant' || !Array.isArray(row.message.content)) continue;
    for (const block of row.message.content) if (block?.type === 'tool_use' && block.id === callId) calls.push({ index, row, block });
  }
  if (calls.length !== 1) return null;
  const call = calls[0];
  if (!claudeRoot(call.row, source, kinds) || call.row.attributionSkill !== skill.skillCommand || call.row.attributionPlugin !== plugin ||
      call.block.name !== tool || !object(call.block.input) || digest(canonicalJSON(call.block.input)) !== argsHash || !isNativeId(call.row.uuid)) return null;
  let inputIndex = call.index - 1;
  while (inputIndex >= 0 && !claudeHuman(records[inputIndex].value)) inputIndex--;
  if (inputIndex < 0) return null;
  const input = records[inputIndex], row = input.value;
  if (!claudeRoot(row, source, kinds) || !isNativeId(row.uuid) || !isNativeId(row.promptId) || row.promptSource !== undefined ||
      row.interruptedMessageId !== undefined || row.interruptedByShutdown === true) return null;
  const typed = control ?? processingControlAction(tool, call.block.input);
  if (typed === null || claudeText(row) !== commandText(skill.skillCommand, typed)) return null;
  const companions = records.slice(inputIndex + 1, call.index).filter(record => record.value?.turnCompanion === true);
  if (companions.length !== 1) return null;
  const companion = companions[0], meta = companion.value;
  if (!claudeRoot(meta, source, kinds) || meta.type !== 'user' || meta.message?.role !== 'user' || meta.isMeta !== true ||
      meta.promptId !== row.promptId || meta.parentUuid !== row.uuid || !isNativeId(meta.uuid) ||
      digest(claudeText(meta) ?? '') !== skill.skillExpansionHash) return null;
  return { unitId: row.promptId, inputId: row.uuid, inputHash: digest(claudeText(row)),
    companionId: meta.uuid, companionHash: companion.hash, skillCommand: skill.skillCommand,
    skillExpansionHash: skill.skillExpansionHash, callRecordId: call.row.uuid,
    inputRange: { fromByte: input.startByte, endByte: input.endByte, hash: input.hash } };
}

/** True only for a process-local proof produced after guarded native byte inspection.
 * JSON, native IDs, claimed hashes and copies of a returned descriptor are not proofs.
 */
export const isProcessingControlProof = value => object(value) && proofs.has(value);

function receiptMatches(receipt, query, source) {
  if (!object(receipt) || !Object.isFrozen(receipt) ||
      Object.entries(query).some(([key, value]) => receipt[key] !== value) ||
      receipt.sourceIdentity !== source.fileIdentity || receipt.sourcePath !== source.path ||
      receipt.skillName !== 'cuefluent-notes' || typeof receipt.skillPath !== 'string' ||
      !path.isAbsolute(receipt.skillPath) || !hashLike(receipt.requestHash) || !hashLike(receipt.resultHash) ||
      typeof receipt.statusText !== 'string' || !receipt.statusText ||
      Buffer.byteLength(receipt.statusText) > 4096) return false;
  return true;
}

/** Only the controller supplies resolveDispatch, backed by its private invocation receipts.
 * It is an internal callback, never a CLI request field or a model-supplied assertion.
 * Unknown/mixed native units return null and remain collectible in their entirety.
 */
export async function verifyCodexProcessingControl({ source, fromByte, endByte, unitId }, { resolveDispatch }) {
  integer(fromByte); integer(endByte);
  if (!isNativeId(unitId) || source?.client !== 'codex' || !isNativeId(source.sessionId) ||
      endByte <= fromByte || endByte - fromByte > MAX_CONTROL_BYTES || typeof resolveDispatch !== 'function') return null;
  const read = await readSessionRange({ source, from: fromByte, endByte,
    maxBytes: MAX_CONTROL_BYTES, maxRecords: MAX_CONTROL_RECORDS, verifyHeader: verifyCodexHeader });
  if (read.metadata.historyMode !== 'paginated' || read.blocked || read.limited || read.pendingTail ||
      read.discarded.length || read.readEnd !== endByte || read.records.length < 7) return null;
  const rows = read.records.map(r => r.value);
  if (rows.some((row, i) => !object(row) || !ordinal(row.ordinal) ||
      (i && row.ordinal !== rows[i - 1].ordinal + 1))) return null;
  const first = rows[0], last = rows.at(-1);
  if (first.type !== 'event_msg' || first.payload?.type !== 'task_started' ||
      first.payload.turn_id !== unitId || first.payload.root_turn_id !== unitId ||
      last.type !== 'event_msg' || last.payload?.type !== 'task_complete' || last.payload.turn_id !== unitId ||
      last.payload.error != null) return null;
  let user = null, userText = null, invocation = null, nativeCall = null, nativeOutput = null;
  let contextSeen = false;
  const assistant = [], assistantNative = [];
  for (const row of rows.slice(1, -1)) {
    const p = row.payload;
    if (!object(p)) return null;
    if (row.type === 'turn_context') {
      if (contextSeen || p.turn_id !== unitId || p.root_turn_id !== unitId) return null;
      contextSeen = true; continue;
    }
    if (row.type === 'world_state') {
      // Native tool/instruction context is generated configuration, never original input.
      if (typeof p.full !== 'boolean' || !object(p.state)) return null;
      continue;
    }
    if (row.type === 'token_usage_record') {
      if (p.thread_id !== source.sessionId || p.session_id !== source.sessionId ||
          p.turn_id !== unitId || p.root_turn_id !== unitId) return null;
      continue;
    }
    if (row.type === 'event_msg') {
      if (p.type === 'token_count') continue;
      if (['agent_reasoning', 'agent_reasoning_raw_content'].includes(p.type) && p.turn_id === unitId) continue;
      if (p.type !== 'item_completed' || p.thread_id !== source.sessionId || p.turn_id !== unitId || !object(p.item)) return null;
      const item = p.item;
      if (item.type === 'Reasoning') continue;
      if (item.type === 'UserMessage') {
        if (user || !Array.isArray(item.content) || item.content.length !== 2) return null;
        const [skill, command] = item.content;
        if (skill?.type !== 'skill' || skill.name !== 'cuefluent-notes' || typeof skill.path !== 'string' ||
            Object.keys(skill).some(k => !['type', 'name', 'path'].includes(k)) || command?.type !== 'text' ||
            processingControlText(command.text) === null || !Array.isArray(command.text_elements) || command.text_elements.length ||
            Object.keys(command).some(k => !['type', 'text', 'text_elements'].includes(k))) return null;
        user = { skillName: skill.name, skillPath: skill.path, command: command.text }; continue;
      }
      if (item.type === 'McpToolCall') {
        if (nativeCall || typeof item.id !== 'string' || item.status !== 'completed' ||
            typeof item.server !== 'string' || typeof item.tool !== 'string' || !object(item.arguments) ||
            !object(item.result) || item.result.isError === true) return null;
        nativeCall = item; continue;
      }
      if (item.type === 'AgentMessage') {
        const text = textBlocks(item.content, 'Text');
        if (text === null || !text || Buffer.byteLength(text) > 4096) return null;
        assistantNative.push({ id: item.id, text }); continue;
      }
      return null;
    }
    if (row.type !== 'response_item' || !boundTo(p, unitId)) return null;
    // Native model reasoning is excluded by the existing reader as well. Its
    // presence cannot turn a text marker into control authority.
    if (p.type === 'reasoning') continue;
    if (p.type === 'message') {
      const kinds = p.internal_chat_message_metadata_passthrough.content_item_kinds;
      if (p.role === 'developer') {
        // Developer messages can only be native instruction context. Human text still has
        // to match both user representations below; a copied XML marker cannot do this.
        if (textBlocks(p.content, 'input_text') === null) return null;
        continue;
      }
      if (p.role === 'user') {
        if (!Array.isArray(kinds) || kinds.length !== p.content?.length) return null;
        if (kinds.every(k => ['environments.environment_context', 'skills.instructions'].includes(k))) {
          if (textBlocks(p.content, 'input_text') === null) return null;
          continue;
        }
        if (userText !== null || kinds.length !== 1 || kinds[0] !== 'user.text' ||
            processingControlText(textBlocks(p.content, 'input_text')) === null) return null;
        userText = textBlocks(p.content, 'input_text'); continue;
      }
      if (p.role === 'assistant') {
        const text = textBlocks(p.content, 'output_text');
        if (text === null || !text || Buffer.byteLength(text) > 4096) return null;
        assistant.push({ id: p.id, text }); continue;
      }
      return null;
    }
    if (p.type === 'function_call') {
      if (invocation || typeof p.call_id !== 'string' || !p.call_id || p.call_id.length > 512 ||
          typeof p.namespace !== 'string' || !/^mcp__[a-zA-Z0-9_-]{1,128}$/.test(p.namespace) ||
          typeof p.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(p.name) || typeof p.arguments !== 'string') return null;
      let args;
      try { args = JSON.parse(p.arguments); } catch { return null; }
      if (!object(args)) return null;
      invocation = { callId: p.call_id, tool: `${p.namespace}.${p.name}`, argsHash: digest(canonicalJSON(args)) }; continue;
    }
    if (p.type === 'function_call_output') {
      if (nativeOutput || typeof p.call_id !== 'string') return null;
      nativeOutput = p; continue;
    }
    return null;
  }
  if (!user || userText !== user.command || !contextSeen || !invocation || !nativeCall || !nativeOutput ||
      assistant.length !== 1 || assistantNative.length !== 1 || assistant[0].id !== assistantNative[0].id ||
      assistant[0].text !== assistantNative[0].text || last.payload.last_agent_message !== assistant[0].text ||
      nativeCall.id !== invocation.callId || nativeOutput.call_id !== invocation.callId ||
      `mcp__${nativeCall.server}.${nativeCall.tool}` !== invocation.tool ||
      digest(canonicalJSON(nativeCall.arguments)) !== invocation.argsHash) return null;
  if (!processingControlMatches(user.command, invocation.tool, nativeCall.arguments, 'codex')) return null;
  const query = { client: 'codex', sessionId: source.sessionId, unitId, ...invocation };
  const receipt = await resolveDispatch(Object.freeze(query));
  if (!receiptMatches(receipt, query, source) || user.skillPath !== receipt.skillPath ||
      digest(canonicalJSON(nativeCall.result)) !== receipt.resultHash || assistant[0].text !== receipt.statusText) return null;
  const resultText = textBlocks(nativeCall.result.content, 'text');
  if (resultText === null) return null;
  // The native CLI adds a wall-time framing block. Only that observed wrapper is
  // permitted around the byte-exact controller response; no arbitrary echoed prose.
  const output = nativeOutput.output;
  if (typeof output === 'string') {
    if (output !== resultText) return null;
  } else {
    if (!Array.isArray(output) || output.length !== 2 || output[0]?.type !== 'input_text' ||
        typeof output[0].text !== 'string' || !/^Wall time: \d+(?:\.\d+)? seconds\nOutput:$/.test(output[0].text) ||
        textBlocks(output.slice(1), 'input_text') !== resultText) return null;
  }
  const proof = Object.freeze({ version: 1, kind: 'codex-processing-control', client: 'codex',
    sessionId: source.sessionId, unitId, sourceIdentity: source.fileIdentity, sourcePath: source.path,
    fromByte, endByte, requestHash: receipt.requestHash, callId: invocation.callId,
    recordsHash: digest(canonicalJSON(read.records.map(r => r.hash))) });
  proofs.add(proof);
  return proof;
}

/** The Claude reader retains human inputs only. This proof excludes only the
 * exact formal command record; ordinary assistant/tool records gain no new
 * ownership classification from their parent links or their position. */
export async function verifyClaudeProcessingControl({ source, fromByte, endByte, unitId }, { resolveDispatch, trustedSkill, sessionKinds = [] }) {
  integer(fromByte); integer(endByte);
  const kinds = claudeSessionKinds(sessionKinds);
  if (!isNativeId(unitId) || source?.client !== 'claude' || !isNativeId(source.sessionId) ||
      endByte <= fromByte || endByte - fromByte > MAX_CONTROL_BYTES || typeof resolveDispatch !== 'function') return null;
  const read = await readSessionRange({ source, from: fromByte, endByte, maxBytes: MAX_CONTROL_BYTES, maxRecords: MAX_CONTROL_RECORDS,
    readHeader: claudeRegistrationHeader(source, { sessionKinds: kinds }), verifyHeader: value => value });
  if (read.blocked || read.limited || read.pendingTail || read.discarded.length || read.readEnd !== endByte) return null;
  const calls = [], results = [], humans = [];
  for (const record of read.records) {
    const row = record.value;
    if (!object(row) || (row.sessionId !== undefined && row.sessionId !== source.sessionId)) return null;
    if (claudeHuman(row)) humans.push(record);
    if (row.type === 'user' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) if (block?.type === 'tool_result') results.push({ row, block });
    }
    if (row.type !== 'assistant') continue;
    if (!claudeRoot(row, source, kinds) || row.message?.role !== 'assistant' || !Array.isArray(row.message.content)) return null;
    for (const block of row.message.content) {
      if (block.type === 'tool_use') calls.push({ row, block });
      else if (!['text', 'thinking', 'redacted_thinking'].includes(block.type)) return null;
    }
  }
  // Claude can defer MCP schemas: its built-in ToolSearch may first load exactly
  // the Cuefluent tool this control calls. That pair carries no user content; any
  // other tool, query, extra match or error keeps the whole unit collectible.
  const controls = calls.filter(item => item.block.name !== 'ToolSearch');
  if (controls.length !== 1 || humans.length !== 1) return null;
  const call = controls[0], loaders = calls.filter(item => item !== call), resultFor = id => results.filter(item => item.block.tool_use_id === id);
  if (results.length !== loaders.length + 1) return null;
  for (const loader of loaders) {
    const paired = resultFor(loader.block.id), input = loader.block.input, used = paired[0];
    if (typeof loader.block.id !== 'string' || calls.indexOf(loader) > calls.indexOf(call) || paired.length !== 1 || !object(input) ||
        Object.keys(input).some(key => !['query', 'max_results'].includes(key)) || input.query !== `select:${call.block.name}` ||
        (input.max_results !== undefined && !(Number.isSafeInteger(input.max_results) && input.max_results >= 1 && input.max_results <= 5)) ||
        !claudeRoot(used.row, source, kinds) || used.row.promptId !== unitId || used.row.sourceToolAssistantUUID !== loader.row.uuid || used.block.is_error === true ||
        !Array.isArray(used.block.content) || used.block.content.length !== 1 || canonicalJSON(used.block.content[0]) !== canonicalJSON({ type: 'tool_reference', tool_name: call.block.name }) ||
        !object(used.row.toolUseResult) || canonicalJSON(used.row.toolUseResult.matches) !== canonicalJSON([call.block.name])) return null;
  }
  const outputs = resultFor(call.block.id);
  if (outputs.length !== 1) return null;
  const output = outputs[0];
  if (typeof call.block.id !== 'string' || !/^mcp__[a-zA-Z0-9_-]*cuefluent_control__(?:process_selected_captures|processing_review|processing_status|processing_resume|processing_cancel)$/.test(call.block.name ?? '') ||
      !object(call.block.input)) return null;
  const query = { client: 'claude', sessionId: source.sessionId, unitId, callId: call.block.id,
    tool: call.block.name, argsHash: digest(canonicalJSON(call.block.input)) };
  const receipt = await resolveDispatch(Object.freeze(query));
  if (!receiptMatches(receipt, query, source)) return null;
  if (!trustedSkill || !Object.isFrozen(trustedSkill) || ['skillPath', 'skillCommand', 'skillExpansionHash'].some(key => trustedSkill[key] !== receipt[key])) return null;
  const mapping = findClaudeProcessingControlInput(read.records, { source, ...query, skill: trustedSkill, sessionKinds: kinds });
  if (!mapping || ['unitId', 'inputId', 'inputHash', 'companionId', 'companionHash', 'skillCommand', 'skillExpansionHash'].some(key => mapping[key] !== receipt[key]) ||
      humans[0].value.uuid !== mapping.inputId) return null;
  if (!claudeRoot(output.row, source, kinds) || output.row.promptId !== unitId || output.row.sourceToolAssistantUUID !== call.row.uuid ||
      output.block.tool_use_id !== call.block.id || output.block.is_error === true ||
      !Array.isArray(output.block.content) || !Array.isArray(output.row.toolUseResult) ||
      digest(canonicalJSON(output.block.content)) !== receipt.resultHash ||
      digest(canonicalJSON(output.row.toolUseResult)) !== receipt.resultHash) return null;
  const proof = Object.freeze({ version: 1, kind: 'claude-processing-control', client: 'claude',
    sessionId: source.sessionId, unitId, sourceIdentity: source.fileIdentity, sourcePath: source.path,
    fromByte, endByte, requestHash: receipt.requestHash, callId: call.block.id, evidenceScope: 'controller-input',
    recordIds: Object.freeze([mapping.inputId]), inputRange: Object.freeze(mapping.inputRange),
    recordsHash: digest(canonicalJSON(read.records.map(record => record.hash))) });
  proofs.add(proof); return proof;
}
