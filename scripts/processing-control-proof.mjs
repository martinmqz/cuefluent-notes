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
// Every typed form, as words separated by one space; the placeholder stands for
// a draft code. Exact matching and nearest-command suggestions both derive from
// this table, so a renamed or added command changes only the constants above.
export const REVIEW_CODE_PLACEHOLDER = '<draft code>';
const CONTROL_FORMS = Object.freeze([
  ...PROCESSING_CONTROLS.map(text => text.split(' ')),
  ['review', REVIEW_CODE_PLACEHOLDER],
  ...REVIEW_DECISIONS.flatMap(decision => [['review', decision], ['review', decision, REVIEW_CODE_PLACEHOLDER]]),
].map(form => Object.freeze(form)));
export const PROCESSING_CONTROL_FORMS = CONTROL_FORMS;
const formMatches = (form, words) => form.length === words.length &&
  form.every((word, index) => word === REVIEW_CODE_PLACEHOLDER ? REVIEW_CODE.test(words[index]) : word === words[index]);
// Longer than any form with a code; bounds the split of arbitrary typed text.
const MAX_CONTROL_TEXT = 64;
/** The exact typed control text, or null. Whitespace, case and other spellings
 * are not normalized, so a near miss stays ordinary input rather than a control. */
export function processingControlText(text) {
  if (typeof text !== 'string' || text.length > MAX_CONTROL_TEXT) return null;
  const words = text.split(' ');
  return CONTROL_FORMS.some(form => formMatches(form, words)) ? text : null;
}

// Nearest-command suggestions for typed arguments that are not an exact control.
// Deterministic and bounded; a suggestion is display text, never authority.
const SUGGESTION_LIMIT = 3, SUGGESTION_TEXT = 16 * 1024, SUGGESTION_WORDS = 256, SUGGESTION_COST = 2;
const DEFAULT_SUGGESTIONS = Object.freeze(['review', 'status', 'process']);
const GRAMMAR_WORDS = Object.freeze([...new Set(CONTROL_FORMS.flat().filter(word => word !== REVIEW_CODE_PLACEHOLDER))]);
const TEMPLATES = new Set(CONTROL_FORMS.filter(form => form.includes(REVIEW_CODE_PLACEHOLDER)).map(form => form.join(' ')));
if (DEFAULT_SUGGESTIONS.some(text => processingControlText(text) === null)) throw new Error('INVALID_CONTROL_GRAMMAR');
/** Characters a draft code never contains, derived from the code pattern. */
export const REVIEW_CODE_EXCLUDED = Object.freeze([...'abcdefghijklmnopqrstuvwxyz0123456789'].filter(char => !REVIEW_CODE.test(char.repeat(6))));
// Optimal string alignment distance, bounded to short words.
function distance(a, b) {
  if (a.length > 32 || b.length > 32) return Infinity;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i ? (j ? 0 : i) : j));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}
// A misspelling or unique abbreviation of a grammar word costs its correction.
// Short words also keep their first letter, so ordinary words rarely match.
function wordCost(token, word) {
  if (token === word) return 0;
  if (token.length >= 3 && word.startsWith(token) && GRAMMAR_WORDS.filter(item => item.startsWith(token)).length === 1) return 1;
  if (token.length < 2 || (word.length < 6 && token[0] !== word[0])) return Infinity;
  const edits = distance(token, word);
  return edits <= (word.length >= 6 ? 2 : 1) ? edits : Infinity;
}
const nearGrammarWord = token => GRAMMAR_WORDS.some(word => wordCost(token, word) !== Infinity);
// A valid code is kept; a code-like token that is not one becomes the placeholder.
function codeCost(token) {
  if (REVIEW_CODE.test(token)) return { cost: 0, word: token };
  if (!nearGrammarWord(token) && (/^[a-z0-9]{6}$/.test(token) || (/^[a-z0-9]{5,7}$/.test(token) && /\d/.test(token)))) return { cost: 1, word: REVIEW_CODE_PLACEHOLDER };
  return null;
}
// Only the review prefix of a longer form may be missing (`save <code>`).
const OMITTABLE_PREFIXES = Object.freeze(['review']);
// A match scores the typed words it consumes less its corrections; ties prefer
// the match consuming more words. A missing prefix costs one, and so does each
// filler word inside a command ("process my repo" is nearer `process repo` than
// the broader `process`); a code is never invented: an unusable one becomes
// the placeholder.
const better = (a, b) => !b || a.score > b.score || (a.score === b.score && a.used > b.used);
function alignForm(form, tokens) {
  let best = null;
  const walk = (i, j, cost, used, words) => {
    if (cost > SUGGESTION_COST) return;
    if (i === form.length) {
      const match = { score: used - cost, used, text: words.join(' ') };
      if (used && better(match, best)) best = match;
      return;
    }
    const expected = form[i];
    if (i === 0 && form.length > 1 && OMITTABLE_PREFIXES.includes(expected)) walk(i + 1, j, cost + 1, used, [expected]);
    if (j >= tokens.length) return;
    if (expected === REVIEW_CODE_PLACEHOLDER) {
      const code = codeCost(tokens[j]);
      if (code) walk(i + 1, j + 1, cost + code.cost, used + 1, [...words, code.word]);
    } else {
      const corrected = wordCost(tokens[j], expected);
      if (corrected !== Infinity) walk(i + 1, j + 1, cost + corrected, used + 1, [...words, expected]);
    }
    if (used) walk(i, j + 1, cost + 1, used, words);
  };
  for (let start = 0; start < tokens.length; start++) walk(0, start, 0, 0, []);
  return best;
}
/** Up to three exact commands (or code templates) nearest to typed text that
 * is not an exact control: case, spacing, punctuation, a missing `review`, a
 * misspelling or abbreviation, an invalid code, or a control among other words.
 * Free text with no nearby command gets the general commands. */
export function processingControlSuggestions(text) {
  const tokens = typeof text === 'string' ? text.slice(0, SUGGESTION_TEXT).normalize('NFKC').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean).slice(0, SUGGESTION_WORDS) : [];
  // A match that needs more corrections than the words it explains is noise.
  const matches = CONTROL_FORMS.map(form => alignForm(form, tokens)).filter(item => item && item.score >= 0);
  const top = matches.reduce((best, item) => better(item, best) ? item : best, null);
  const chosen = [...new Set(matches.filter(item => item.score === top.score && item.used === top.used).map(item => item.text))];
  return Object.freeze((chosen.length ? chosen : DEFAULT_SUGGESTIONS).slice(0, SUGGESTION_LIMIT));
}
/** A suggestion is an exact control or a form with the draft-code placeholder. */
export const isProcessingControlSuggestion = text => processingControlText(text) !== null || TEMPLATES.has(text);
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
const CLAUDE_SKILL_COMMAND = 'cuefluent-notes:cuefluent-notes';
const COMMAND_ARGS_END = '</command-args>';
const commandText = (command, control = CONTROL) => `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${control}${COMMAND_ARGS_END}`;
/** The typed arguments inside the trusted skill command's exact envelope, as
 * written; null for any other text, including another skill or plugin, another
 * order, spacing or line ending, or text outside the envelope. */
export function claudeSkillArguments(text, skillCommand = CLAUDE_SKILL_COMMAND) {
  if (typeof text !== 'string' || !skillCommandLike(skillCommand)) return null;
  const head = commandText(skillCommand, '').slice(0, -COMMAND_ARGS_END.length);
  return text.length >= head.length + COMMAND_ARGS_END.length && text.startsWith(head) && text.endsWith(COMMAND_ARGS_END)
    ? text.slice(head.length, -COMMAND_ARGS_END.length) : null;
}
export function claudeProcessingCommandKind(row, skillCommand = CLAUDE_SKILL_COMMAND) {
  if (!skillCommandLike(skillCommand) || !claudeHuman(row) || row.promptSource !== undefined) return null;
  return processingControlText(claudeSkillArguments(claudeText(row), skillCommand));
}
export const isClaudeProcessingCommand = (row, skillCommand) => claudeProcessingCommandKind(row, skillCommand) !== null;
// The envelope's arguments in a typed human input: its whole text, or one text
// block among other content (`extra`). Pasted or SDK input is not typed.
function claudeTypedSkillInput(row, skillCommand) {
  if (!claudeHuman(row) || row.promptSource !== undefined) return null;
  const content = row.message.content;
  if (typeof content === 'string') { const args = claudeSkillArguments(content, skillCommand); return args === null ? null : { args, extra: false }; }
  if (!Array.isArray(content)) return null;
  const found = content.filter(block => block?.type === 'text').map(block => claudeSkillArguments(block.text, skillCommand)).find(args => args !== null);
  return found === undefined ? null : { args: found, extra: content.length > 1 };
}

const MAX_SKILL_ARGUMENT_BYTES = 2 * 1024 * 1024;
/** Trusted installed skill only. This does not discover plugins or accept a
 * model-provided expansion. Unsupported substitutions remain unverified. */
export async function loadClaudeProcessingSkill({ skillPath, skillCommand = CLAUDE_SKILL_COMMAND, control = CONTROL }) {
  return processingControlText(control) === null ? null : loadClaudeSkill({ skillPath, skillCommand, args: control });
}
async function loadClaudeSkill({ skillPath, skillCommand, args }) {
  if (typeof skillPath !== 'string' || !path.isAbsolute(skillPath) || !skillCommandLike(skillCommand) ||
      typeof args !== 'string' || Buffer.byteLength(args) > MAX_SKILL_ARGUMENT_BYTES) return null;
  let snapshot;
  try { snapshot = await readBoundedBytes(skillPath, { maxBytes: 128 * 1024, noFollow: true, missing: true }); }
  catch { return null; }
  if (!snapshot) return null;
  const content = snapshot.toString('utf8'), header = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  if (!header) return null;
  let body = content.slice(header[0].length).trimStart();
  if (body.includes('${') || /\$\d|\$ARGUMENTS\[/.test(body)) return null;
  // Literal substitution: typed arguments may contain `$` replacement patterns.
  body = body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', () => args) : `${body}\n\nARGUMENTS: ${args}`;
  const expansion = `Base directory for this skill: ${path.dirname(skillPath)}\n\n${body}`;
  return Object.freeze({ skillPath, skillCommand, skillExpansionHash: digest(expansion) });
}

// The native call and the human input that started its skill turn: exactly one
// matching call, attributed to the trusted skill, and the nearest earlier
// human input as a root prompt with native identities.
function claudeSkillTurn(records, { source, callId, tool, argsHash, skillCommand, kinds }) {
  const plugin = skillCommand.split(':')[0], calls = [];
  for (let index = 0; index < records.length; index++) {
    const row = records[index].value;
    if (row?.type !== 'assistant' || row.message?.role !== 'assistant' || !Array.isArray(row.message.content)) continue;
    for (const block of row.message.content) if (block?.type === 'tool_use' && block.id === callId) calls.push({ index, row, block });
  }
  if (calls.length !== 1) return null;
  const call = calls[0];
  if (!claudeRoot(call.row, source, kinds) || call.row.attributionSkill !== skillCommand || call.row.attributionPlugin !== plugin ||
      call.block.name !== tool || !object(call.block.input) || digest(canonicalJSON(call.block.input)) !== argsHash || !isNativeId(call.row.uuid)) return null;
  let inputIndex = call.index - 1;
  while (inputIndex >= 0 && !claudeHuman(records[inputIndex].value)) inputIndex--;
  if (inputIndex < 0) return null;
  const input = records[inputIndex], row = input.value;
  if (!claudeRoot(row, source, kinds) || !isNativeId(row.uuid) || !isNativeId(row.promptId) || row.promptSource !== undefined ||
      row.interruptedMessageId !== undefined || row.interruptedByShutdown === true) return null;
  return { call, inputIndex, input, row };
}
// The one native companion carrying the trusted skill expansion for that input.
function claudeSkillCompanion(records, { call, inputIndex, row }, { source, kinds, expansionHash }) {
  const companions = records.slice(inputIndex + 1, call.index).filter(record => record.value?.turnCompanion === true);
  if (companions.length !== 1) return null;
  const companion = companions[0], meta = companion.value;
  if (!claudeRoot(meta, source, kinds) || meta.type !== 'user' || meta.message?.role !== 'user' || meta.isMeta !== true ||
      meta.promptId !== row.promptId || meta.parentUuid !== row.uuid || !isNativeId(meta.uuid) ||
      digest(claudeText(meta) ?? '') !== expansionHash) return null;
  return companion;
}

/** A typed native companion plus native skill-attributed MCP call binds the
 * formal command. Ordinary assistant parentUuid links are deliberately unused. */
export function findClaudeProcessingControlInput(records, { source, callId, tool, argsHash, skill, control, sessionKinds = [] }) {
  if (!skill || !skillCommandLike(skill.skillCommand) || !hashLike(skill.skillExpansionHash)) return null;
  const kinds = claudeSessionKinds(sessionKinds);
  if (control !== undefined && processingControlText(control) === null) return null;
  const turn = claudeSkillTurn(records, { source, callId, tool, argsHash, skillCommand: skill.skillCommand, kinds });
  if (!turn) return null;
  const { call, input, row } = turn;
  const typed = control ?? processingControlAction(tool, call.block.input);
  if (typed === null || claudeText(row) !== commandText(skill.skillCommand, typed)) return null;
  const companion = claudeSkillCompanion(records, turn, { source, kinds, expansionHash: skill.skillExpansionHash });
  if (!companion) return null;
  const meta = companion.value;
  return { unitId: row.promptId, inputId: row.uuid, inputHash: digest(claudeText(row)),
    companionId: meta.uuid, companionHash: companion.hash, skillCommand: skill.skillCommand,
    skillExpansionHash: skill.skillExpansionHash, callRecordId: call.row.uuid,
    inputRange: { fromByte: input.startByte, endByte: input.endByte, hash: input.hash } };
}

/** The typed arguments of a trusted skill invocation that started this native
 * call's turn but are not an exact control: other text, or a control mixed with
 * other content. Verified like a control (attributed call, typed root input,
 * native companion of the trusted expansion for exactly those arguments). Only
 * a refusal and a suggestion source: never control authority or an exclusion. */
export async function findClaudeSkillArguments(records, { source, callId, tool, argsHash, skillPath, skillCommand = CLAUDE_SKILL_COMMAND, sessionKinds = [] }) {
  if (!skillCommandLike(skillCommand)) return null;
  const kinds = claudeSessionKinds(sessionKinds);
  const turn = claudeSkillTurn(records, { source, callId, tool, argsHash, skillCommand, kinds });
  const typed = turn && claudeTypedSkillInput(turn.row, skillCommand);
  if (!typed || (!typed.extra && processingControlText(typed.args) !== null)) return null;
  const skill = await loadClaudeSkill({ skillPath, skillCommand, args: typed.args });
  if (!skill || !claudeSkillCompanion(records, turn, { source, kinds, expansionHash: skill.skillExpansionHash })) return null;
  return Object.freeze({ unitId: turn.row.promptId, inputId: turn.row.uuid, arguments: typed.args, mixed: typed.extra });
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
