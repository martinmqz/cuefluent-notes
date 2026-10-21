import path from 'node:path';
import { readBoundedBytes } from './file-io.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { verifyCodexHeader, codexSkillSelection, codexSelectedMentionText, codexCellOutput, codexToolRenderings } from './codex-reader.mjs';
import { claudeRegistrationHeader, claudeSessionKinds } from './claude-reader.mjs';
import { canonicalJSON, digest, integer, isNativeId, object } from './workflow-values.mjs';

const proofs = new WeakSet();
const MAX_CONTROL_BYTES = 2 * 1024 * 1024;
const MAX_CONTROL_RECORDS = 1024;
const CONTROL = 'process';
// One skill. Its name is the Codex skill block and the receipt skill name;
// Claude records it as this command whichever spelling was typed (the bare
// `/cuefluent-notes` or the full `/cuefluent-notes:cuefluent-notes`).
export const SKILL_NAME = 'cuefluent-notes';
export const CLAUDE_SKILL_COMMAND = `cuefluent-notes:${SKILL_NAME}`;
// How a person types a command in each client: this, one space, then the
// words. Display only; the typed text is verified from the native transcript.
export const REVIEW_COMMANDS = Object.freeze({ claude: '/cuefluent-notes', codex: `$${SKILL_NAME}` });
// Review drafts are named by a short code (no i, l, o, u, 0 or 1).
export const REVIEW_CODE = /^[a-hjkmnp-tv-z2-9]{6}$/;
export const REVIEW_CODE_PLACEHOLDER = '<draft code>';
// Typed review decisions. The Codex native form also offers Later; a typed
// Later waits for the ready line it would silence.
export const REVIEW_DECISIONS = Object.freeze(['save', 'skip', 'cancel']);
const CODE = REVIEW_CODE_PLACEHOLDER;
// Every typed form and the one tool call it is, as words separated by one
// space; `#` stands for a draft code. Exact matching, the tool mapping, the
// help list and nearest-command suggestions all derive from this table.
const GRAMMAR = Object.freeze([
  ['help', 'processing_status', { help: true }],
  ['status', 'processing_status', {}], ['status --verbose', 'processing_status', { verbose: true }],
  ['capture', 'capture_turns', {}], ['pause chat', 'pause_capture', {}], ['resume chat', 'resume_capture', {}],
  ['process', 'process_selected_captures', {}], ['process repo', 'process_selected_captures', { scope: 'repo' }],
  ['process chat', 'process_selected_captures', { scope: 'chat' }],
  ['process resume', 'processing_resume', {}], ['process cancel', 'processing_cancel', {}],
  ['review', 'processing_review', {}], ['review #', 'processing_review', { draft: CODE }],
  ['review cancel', 'processing_review', { decision: 'cancel' }], ['review cancel #', 'processing_review', { decision: 'cancel', draft: CODE }],
  ['save', 'processing_review', { decision: 'save' }], ['save #', 'processing_review', { decision: 'save', draft: CODE }],
  ['skip', 'processing_review', { decision: 'skip' }], ['skip #', 'processing_review', { decision: 'skip', draft: CODE }],
].map(([text, tool, fields]) => Object.freeze({ words: Object.freeze(text.split(' ').map(word => word === '#' ? CODE : word)),
  tool, fields: Object.freeze(fields) })));
export const PROCESSING_CONTROL_FORMS = Object.freeze(GRAMMAR.map(form => form.words));
// A known word that is not a formal control: setup starts the setup workflow,
// calls no control tool, and so has no receipt and excludes nothing.
export const PROCESSING_KNOWN_WORDS = Object.freeze(['setup']);
const formMatches = (form, words) => form.length === words.length &&
  form.every((word, index) => word === CODE ? REVIEW_CODE.test(words[index]) : word === words[index]);
// Longer than any form with a code; bounds the split of arbitrary typed text.
const MAX_CONTROL_TEXT = 64;
function exactForm(text) {
  if (typeof text !== 'string' || text.length > MAX_CONTROL_TEXT) return null;
  const words = text.split(' ');
  return GRAMMAR.find(form => formMatches(form.words, words)) ?? null;
}
/** The exact typed control text, or null. Whitespace, case and other spellings
 * are not normalized, so a near miss stays ordinary input rather than a control. */
export function processingControlText(text) {
  return exactForm(text) === null ? null : text;
}
const formFields = (form, text) => Object.fromEntries(Object.entries(form.fields)
  .map(([key, value]) => [key, value === CODE ? text.split(' ')[form.words.indexOf(CODE)] : value]));
/** The one tool call an exact typed control is: its tool and fields. */
export function processingControlCall(text) {
  const form = exactForm(text);
  return form && Object.freeze({ tool: form.tool, fields: Object.freeze(formFields(form, text)) });
}
/** Canonical typed review action for review tool fields, or null. */
export function reviewControl({ draft, decision } = {}) {
  if (draft !== undefined && (typeof draft !== 'string' || !REVIEW_CODE.test(draft))) return null;
  if (decision !== undefined && !REVIEW_DECISIONS.includes(decision)) return null;
  const words = decision === undefined ? ['review'] : decision === 'cancel' ? ['review', 'cancel'] : [decision];
  return [...words, ...(draft === undefined ? [] : [draft])].join(' ');
}
/** Fields of a typed review action; null when the text is not one. */
export function reviewControlFields(text) {
  const call = processingControlCall(text);
  return call?.tool === 'processing_review' ? { ...call.fields } : null;
}

// Nearest-command suggestions for typed arguments that are not an exact control.
// Deterministic and bounded; a suggestion is display text, never authority.
const SUGGESTION_LIMIT = 3, SUGGESTION_TEXT = 16 * 1024, SUGGESTION_WORDS = 256, SUGGESTION_COST = 2;
const DEFAULT_SUGGESTIONS = Object.freeze(['help', 'review', 'status']);
const SUGGESTION_FORMS = Object.freeze([...PROCESSING_CONTROL_FORMS, ...PROCESSING_KNOWN_WORDS.map(word => Object.freeze([word]))]);
// The help list: each first word with what it does and its other forms.
const HELP_SUMMARIES = Object.freeze({
  setup: 'choose the capture and processing modes',
  status: 'show processing, captured turns and drafts',
  capture: 'capture this chat\'s finished turns not captured yet',
  pause: 'stop Automatic capture of this chat from now on',
  resume: 'restart Automatic capture of this chat',
  process: 'draft notes from captured turns',
  review: 'write a pending draft to a private review folder',
  save: 'save the draft your last typed review showed, exactly as shown',
  skip: 'handle that draft\'s captured turns without saving',
  help: 'show this list',
});
// A first word that is no command alone (`pause`) is listed as its one form.
export const PROCESSING_HELP = Object.freeze(Object.entries(HELP_SUMMARIES).map(([word, summary]) => {
  const forms = SUGGESTION_FORMS.filter(form => form[0] === word).map(form => form.join(' '));
  const text = forms.includes(word) ? word : forms[0];
  return Object.freeze({ word, text, summary, also: Object.freeze(forms.filter(form => form !== text)) });
}));
if (SUGGESTION_FORMS.some(form => !Object.hasOwn(HELP_SUMMARIES, form[0]))) throw new Error('INVALID_CONTROL_GRAMMAR');
// Typed text is compared as letters and digits only (`--verbose` as `verbose`).
const matchWord = word => word.replace(/[^a-z0-9]/g, '');
const GRAMMAR_WORDS = Object.freeze([...new Set(SUGGESTION_FORMS.flat().filter(word => word !== CODE).map(matchWord))]);
const TEMPLATES = new Set(PROCESSING_CONTROL_FORMS.filter(form => form.includes(CODE)).map(form => form.join(' ')));
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
  if (!nearGrammarWord(token) && (/^[a-z0-9]{6}$/.test(token) || (/^[a-z0-9]{5,7}$/.test(token) && /\d/.test(token)))) return { cost: 1, word: CODE };
  return null;
}
// Only the first word of a longer form may be missing (`resume` is nearer
// `process resume`, `cancel k2mn9p` nearer `review cancel k2mn9p`).
const OMITTABLE_PREFIXES = Object.freeze(['status', 'process', 'review']);
// The last word of a chat command may be missing too (`pause` is nearer `pause chat`).
const OMITTABLE_SUFFIXES = Object.freeze(['chat']);
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
    if (i > 0 && i === form.length - 1 && OMITTABLE_SUFFIXES.includes(expected)) walk(i + 1, j, cost + 1, used, [...words, expected]);
    if (j >= tokens.length) return;
    if (expected === CODE) {
      const code = codeCost(tokens[j]);
      if (code) walk(i + 1, j + 1, cost + code.cost, used + 1, [...words, code.word]);
    } else {
      const corrected = wordCost(tokens[j], matchWord(expected));
      if (corrected !== Infinity) walk(i + 1, j + 1, cost + corrected, used + 1, [...words, expected]);
    }
    if (used) walk(i, j + 1, cost + 1, used, words);
  };
  for (let start = 0; start < tokens.length; start++) walk(0, start, 0, 0, []);
  return best;
}
/** Up to three exact commands (or code templates) nearest to typed text that
 * is not an exact control: case, spacing, punctuation, a missing first word,
 * an old spelling, a misspelling or abbreviation, an invalid code, or a
 * control among other words. Free text with no nearby command gets the
 * general commands. */
export function processingControlSuggestions(text) {
  const tokens = typeof text === 'string' ? text.slice(0, SUGGESTION_TEXT).normalize('NFKC').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean).slice(0, SUGGESTION_WORDS) : [];
  // A match that needs more corrections than the words it explains is noise.
  const matches = SUGGESTION_FORMS.map(form => alignForm(form, tokens)).filter(item => item && item.score >= 0);
  const top = matches.reduce((best, item) => better(item, best) ? item : best, null);
  const chosen = [...new Set(matches.filter(item => item.score === top.score && item.used === top.used).map(item => item.text))];
  return Object.freeze((chosen.length ? chosen : DEFAULT_SUGGESTIONS).slice(0, SUGGESTION_LIMIT));
}
/** A suggestion is an exact control, a form with the draft-code placeholder,
 * or a known word. */
export const isProcessingControlSuggestion = text => processingControlText(text) !== null || TEMPLATES.has(text) || PROCESSING_KNOWN_WORDS.includes(text);
/** Exact action/argument binding, shared by native invocation and retained proof.
 * No keyword or substring classifies ordinary user work as processing output. */
export function processingControlAction(tool, args = {}) {
  const name = typeof tool === 'string' ? tool.split(/\.|__/).at(-1) : null;
  if (name === 'process_selected_captures' || name === 'process') {
    const scope = args.scope ?? 'collection';
    return scope === 'collection' ? 'process' : ['repo', 'chat'].includes(scope) ? `process ${scope}` : null;
  }
  if (name === 'processing_review') return reviewControl(args);
  if (name === 'processing_status') {
    if (args.help !== undefined) return args.help === true && args.verbose === undefined ? 'help' : null;
    return args.verbose === undefined ? 'status' : args.verbose === true ? 'status --verbose' : null;
  }
  return { processing_resume: 'process resume', processing_cancel: 'process cancel',
    capture_turns: 'capture', pause_capture: 'pause chat', resume_capture: 'resume chat' }[name] ?? null;
}
// Typed chat capture commands; each carries no fields of its own.
export const CAPTURE_TOOLS = Object.freeze(['capture_turns', 'pause_capture', 'resume_capture']);
// The table and the tool mapping must agree; a known word is never a control.
for (const form of GRAMMAR) {
  const text = form.words.map(word => word === CODE ? 'k2mn9p' : word).join(' ');
  if (processingControlAction(form.tool, formFields(form, text)) !== text) throw new Error('INVALID_CONTROL_GRAMMAR');
}
if (DEFAULT_SUGGESTIONS.some(text => processingControlText(text) === null) || PROCESSING_KNOWN_WORDS.some(word => exactForm(word))) throw new Error('INVALID_CONTROL_GRAMMAR');
/** Claude copies typed fields into its tool call, verified exactly. Codex
 * refuses those fields: its verified typed text alone names the draft, the
 * decision, verbosity or help, so its review and status calls carry none. */
export function processingControlMatches(command, tool, args, client) {
  const action = processingControlAction(tool, args), typed = processingControlCall(command);
  if (action === null || typed === null) return false;
  return command === action || (client === 'codex' && ['review', 'status'].includes(action) && typed.tool === processingControlCall(action).tool);
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
const COMMAND_ARGS_END = '</command-args>';
// Claude records a skill command by its registered name and, only when
// something was typed after it, an arguments element holding that text.
const commandHead = command => `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>`;
const commandText = (command, control = CONTROL) => `${commandHead(command)}\n<command-args>${control}${COMMAND_ARGS_END}`;
/** The typed arguments inside the trusted skill command's exact envelope, as
 * written ('' when nothing was typed and the arguments element is absent);
 * null for any other text, including another skill or plugin, another order,
 * spacing or line ending, or text outside the envelope. */
export function claudeSkillArguments(text, skillCommand = CLAUDE_SKILL_COMMAND) {
  if (typeof text !== 'string' || !skillCommandLike(skillCommand)) return null;
  const head = commandHead(skillCommand), open = `${head}\n<command-args>`;
  if (text === head) return '';
  return text.length >= open.length + COMMAND_ARGS_END.length && text.startsWith(open) && text.endsWith(COMMAND_ARGS_END)
    ? text.slice(open.length, -COMMAND_ARGS_END.length) : null;
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
  // Without `$ARGUMENTS`, Claude appends them only when something was typed.
  body = body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', () => args) : args === '' ? body : `${body}\n\nARGUMENTS: ${args}`;
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
      receipt.skillName !== SKILL_NAME || typeof receipt.skillPath !== 'string' ||
      !path.isAbsolute(receipt.skillPath) || !hashLike(receipt.requestHash) || !hashLike(receipt.resultHash) ||
      typeof receipt.statusText !== 'string' || !receipt.statusText ||
      Buffer.byteLength(receipt.statusText) > 4096) return false;
  return true;
}

/** Only the controller supplies resolveDispatch, backed by its private invocation receipts.
 * It is an internal callback, never a CLI request field or a model-supplied assertion.
 * Unknown/mixed native units return null and remain collectible in their entirety.
 *
 * The whole completed unit must be exactly one verified control turn: the typed
 * input (the older skill part plus text, or the Codex 0.163 leading mention plus
 * the selection item), native context, the one call (direct, or in code mode
 * the two cells of the verification handshake and any `wait` on the second)
 * and the one final reply, which is the receipt's status text byte for byte
 * (a reply the model reformatted refuses the proof; the reader then leaves
 * that relay out under its own rule, codexReplyForm). Any other
 * record refuses: another tool or nested item, reading a file, commentary or
 * another message, an unknown record. Model-written
 * JavaScript is never read; cells are bound by native IDs the receipt names.
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
  let user = null, userText = null, selection = null, invocation = null, contextSeen = false;
  const assistant = [], assistantNative = [], nativeCalls = [], cells = [], waits = [], outputs = new Map();
  for (let index = 1; index < rows.length - 1; index++) {
    const row = rows[index], p = row.payload;
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
      // A session's first turn applies its settings; settings are no input.
      if (p.type === 'thread_settings_applied' && p.thread_id === source.sessionId) continue;
      if (p.type !== 'item_completed' || p.thread_id !== source.sessionId || p.turn_id !== unitId || !object(p.item)) return null;
      const item = p.item;
      if (item.type === 'Reasoning') continue;
      if (item.type === 'UserMessage') {
        if (user || !Array.isArray(item.content)) return null;
        user = { index, content: item.content }; continue;
      }
      if (item.type === 'McpToolCall') {
        if (nativeCalls.length === 2 || typeof item.id !== 'string' || item.status !== 'completed' || item.error != null ||
            Object.keys(item).some(key => !MCP_ITEM_KEYS.includes(key)) ||
            typeof item.server !== 'string' || typeof item.tool !== 'string' || !object(item.arguments) ||
            !object(item.result) || item.result.isError === true) return null;
        nativeCalls.push({ index, item }); continue;
      }
      if (item.type === 'AgentMessage') {
        const text = textBlocks(item.content, 'Text');
        if (text === null || !text || Object.keys(item).some(key => !['type', 'id', 'content', 'phase'].includes(key))) return null;
        assistantNative.push({ index, id: item.id, phase: item.phase, text }); continue;
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
        if (kinds.length === 1 && kinds[0] === 'skills.selected_skill_instructions') {
          const selected = codexSkillSelection(p);
          if (selection !== null || selected === null) return null;
          selection = { index, skillPath: selected }; continue;
        }
        if (kinds.every(k => USER_CONTEXT_KINDS.includes(k))) {
          if (textBlocks(p.content, 'input_text') === null) return null;
          continue;
        }
        if (userText !== null || kinds.length !== 1 || kinds[0] !== 'user.text' || textBlocks(p.content, 'input_text') === null) return null;
        userText = textBlocks(p.content, 'input_text'); continue;
      }
      if (p.role === 'assistant') {
        const text = outputText(p.content);
        if (text === null || !text) return null;
        assistant.push({ index, id: p.id, phase: p.phase, text }); continue;
      }
      return null;
    }
    if (p.type === 'function_call') {
      if (typeof p.call_id !== 'string' || !p.call_id || p.call_id.length > 512 || typeof p.arguments !== 'string' || outputs.has(p.call_id)) return null;
      let args;
      try { args = JSON.parse(p.arguments); } catch { return null; }
      if (!object(args)) return null;
      // Code mode's `wait` on a running cell; the cell's own ID is checked below.
      if (p.name === 'wait' && p.namespace == null) {
        if (waits.length === MAX_WAITS || Object.keys(args).some(key => !['cell_id', 'yield_time_ms', 'max_tokens'].includes(key)) ||
            typeof args.cell_id !== 'string') return null;
        waits.push({ index, callId: p.call_id, cellId: args.cell_id }); continue;
      }
      if (invocation || typeof p.namespace !== 'string' || !/^mcp__[a-zA-Z0-9_-]{1,128}$/.test(p.namespace) ||
          typeof p.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(p.name)) return null;
      invocation = { callId: p.call_id, tool: `${p.namespace}.${p.name}`, argsHash: digest(canonicalJSON(args)) }; continue;
    }
    if (p.type === 'custom_tool_call') {
      if (cells.length === 2 || p.name !== 'exec' || p.namespace != null || typeof p.call_id !== 'string' || !p.call_id ||
          p.call_id.length > 512 || typeof p.id !== 'string' || typeof p.input !== 'string') return null;
      cells.push({ index, id: p.id, callId: p.call_id }); continue;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      if (typeof p.call_id !== 'string' || outputs.has(p.call_id)) return null;
      outputs.set(p.call_id, { index, type: p.type, output: p.output, clientAuthored: row.metadata?.client_authored }); continue;
    }
    return null;
  }
  if (!user || !contextSeen || userText === null) return null;
  // The typed control: the words after the 0.163 mention and one space with
  // this skill's selection item, or the text after the older skill part.
  let command, skillPath;
  if (selection) {
    const after = codexSelectedMentionText(user.content, selection.skillPath)?.text ?? null;
    if (after === null || !after.startsWith(' ') || userText !== user.content[0].text) return null;
    command = after.slice(1); skillPath = selection.skillPath;
  } else {
    if (user.content.length !== 2) return null;
    const [skill, typed] = user.content;
    if (skill?.type !== 'skill' || skill.name !== SKILL_NAME || typeof skill.path !== 'string' ||
        Object.keys(skill).some(k => !['type', 'name', 'path'].includes(k)) || typed?.type !== 'text' ||
        typeof typed.text !== 'string' || !Array.isArray(typed.text_elements) || typed.text_elements.length ||
        Object.keys(typed).some(k => !['type', 'text', 'text_elements'].includes(k)) || userText !== typed.text) return null;
    command = typed.text; skillPath = skill.path;
  }
  if (processingControlText(command) === null) return null;
  const reply = assistantReply(assistant, assistantNative);
  if (!reply || last.payload.last_agent_message !== reply.text) return null;
  // The one dispatched call and the native result the receipt names.
  let nativeCall, codeMode = null;
  if (cells.length) {
    codeMode = codeModeCall({ cells, waits, outputs, nativeCalls, invocation, reply });
    if (!codeMode) return null;
    invocation = codeMode.invocation; nativeCall = codeMode.retry;
  } else {
    if (!invocation || waits.length || nativeCalls.length !== 1 || outputs.size !== 1) return null;
    nativeCall = nativeCalls[0].item;
    const nativeOutput = outputs.get(invocation.callId);
    if (!nativeOutput || nativeOutput.type !== 'function_call_output' || nativeCall.id !== invocation.callId ||
        `mcp__${nativeCall.server}.${nativeCall.tool}` !== invocation.tool ||
        digest(canonicalJSON(nativeCall.arguments)) !== invocation.argsHash || !directOutput(nativeOutput.output, nativeCall.result)) return null;
  }
  if (!processingControlMatches(command, invocation.tool, codeMode ? codeMode.handshake.arguments : nativeCall.arguments, 'codex')) return null;
  const query = { client: 'codex', sessionId: source.sessionId, unitId, ...invocation };
  const receipt = await resolveDispatch(Object.freeze(query));
  if (!receiptMatches(receipt, query, source) || path.normalize(skillPath) !== path.normalize(receipt.skillPath) ||
      digest(canonicalJSON(nativeCall.result)) !== receipt.resultHash || reply.text !== receipt.statusText) return null;
  // A code-mode receipt names both cells and the retry; a direct one names none.
  if (codeMode ? receipt.outerItemId !== codeMode.cells[0].id || receipt.retryItemId !== codeMode.cells[1].id ||
      receipt.retryCallId !== codeMode.retry.id || receipt.handshakeResultHash !== digest(canonicalJSON(codeMode.handshake.result))
    : CODE_MODE_RECEIPT_FIELDS.some(key => receipt[key] !== undefined)) return null;
  const proof = Object.freeze({ version: 1, kind: 'codex-processing-control', client: 'codex',
    sessionId: source.sessionId, unitId, sourceIdentity: source.fileIdentity, sourcePath: source.path,
    fromByte, endByte, requestHash: receipt.requestHash, callId: invocation.callId,
    recordsHash: digest(canonicalJSON(read.records.map(r => r.hash))) });
  proofs.add(proof);
  return proof;
}

const MCP_ITEM_KEYS = Object.freeze(['type', 'id', 'server', 'tool', 'arguments', 'pluginId', 'readOnlyHint', 'status', 'result', 'duration']);
// Native context a control turn may carry; never the person's input.
const USER_CONTEXT_KINDS = Object.freeze(['environments.environment_context', 'skills.instructions', 'agents_md.instructions']);
const CODE_MODE_RECEIPT_FIELDS = Object.freeze(['outerItemId', 'retryItemId', 'retryCallId', 'handshakeResultHash']);
const MAX_WAITS = 8;
// The assistant mirror's text: output text blocks with no annotations.
const outputText = blocks => Array.isArray(blocks) && blocks.length > 0 &&
  blocks.every(b => object(b) && b.type === 'output_text' && typeof b.text === 'string' &&
    Object.keys(b).every(k => ['type', 'text', 'annotations', 'logprobs'].includes(k)) &&
    ['annotations', 'logprobs'].every(k => b[k] === undefined || (Array.isArray(b[k]) && !b[k].length)))
  ? blocks.map(b => b.text).join('') : null;
/** The one final reply with its identical mirror. Any other assistant message,
 * commentary included, is the assistant's own text: it keeps the turn
 * collectible, never part of an excluded control. Null for anything else. */
function assistantReply(mirrors, natives) {
  if (mirrors.length !== 1 || natives.length !== 1) return null;
  const [a] = mirrors, [reply] = natives;
  if (a.id !== reply.id || a.text !== reply.text || a.phase !== reply.phase) return null;
  if (![undefined, 'final_answer'].includes(reply.phase) || Buffer.byteLength(reply.text) > 4096) return null;
  return { text: reply.text, index: Math.max(reply.index, a.index) };
}
// The native CLI adds a wall-time framing block. Only that observed wrapper is
// permitted around the byte-exact controller response; no arbitrary echoed prose.
function directOutput(output, result) {
  const resultText = textBlocks(result.content, 'text');
  if (resultText === null) return false;
  if (typeof output === 'string') return output === resultText;
  return Array.isArray(output) && output.length === 2 && output[0]?.type === 'input_text' &&
    typeof output[0].text === 'string' && /^Wall time: \d+(?:\.\d+)? seconds\nOutput:$/.test(output[0].text) &&
    textBlocks(output.slice(1), 'input_text') === resultText;
}
/** Code mode: the verification handshake's two cells, in native order. Cell 1
 * makes the call and prints the handshake; cell 2 repeats it with that retry
 * token and prints the response, either at once or through `wait` calls on
 * that cell. Each cell has its one output, framed by Codex around exactly what
 * its call returned; nothing else is printed or called. */
function codeModeCall({ cells, waits, outputs, nativeCalls, invocation, reply }) {
  if (invocation || cells.length !== 2 || nativeCalls.length !== 2 || outputs.size !== 2 + waits.length) return null;
  const [handshake, retry] = nativeCalls.map(entry => entry.item), [outer, inner] = cells;
  if (retry.server !== handshake.server || retry.tool !== handshake.tool || Object.hasOwn(handshake.arguments, 'retryToken')) return null;
  const token = handshakeToken(handshake.result);
  if (token === null || canonicalJSON(retry.arguments) !== canonicalJSON({ ...handshake.arguments, retryToken: token })) return null;
  const printed = (callId, item) => {
    const output = outputs.get(callId), value = output?.clientAuthored === false ? codexCellOutput(output.output) : null;
    return value && { ...value, index: output.index, shows: item !== null && codexToolRenderings(item).includes(value.text) };
  };
  const first = printed(outer.callId, handshake);
  if (!first || first.running || !first.shows || !(outer.index < nativeCalls[0].index && nativeCalls[0].index < first.index && first.index < inner.index)) return null;
  // The second cell either completes at once or yields; a yielded cell is
  // finished only by `wait` calls on exactly that cell, each after the last.
  let done = printed(inner.callId, retry);
  if (!done || done.index < inner.index) return null;
  if (done.running) {
    const cellId = done.cellId;
    if (done.text !== '' || !waits.length) return null;
    for (const [i, wait] of waits.entries()) {
      const next = printed(wait.callId, retry);
      if (wait.cellId !== cellId || wait.index < done.index || !next || next.index < wait.index ||
          (i < waits.length - 1 ? !next.running || next.cellId !== cellId || next.text !== '' : next.running)) return null;
      done = next;
    }
  } else if (waits.length) return null;
  if (!done.shows || !(inner.index < nativeCalls[1].index && nativeCalls[1].index < done.index) || reply.index < done.index) return null;
  return { cells, handshake, retry,
    invocation: { callId: handshake.id, tool: `mcp__${handshake.server}.${handshake.tool}`, argsHash: digest(canonicalJSON(handshake.arguments)) } };
}
/** The retry token of this server's verification handshake result, or null. */
function handshakeToken(result) {
  const text = textBlocks(result?.content, 'text');
  if (text === null || result.isError === true || Object.keys(result).some(key => !['content', 'isError'].includes(key))) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!object(value) || Object.keys(value).length !== 4 || value.interfaceVersion !== 1 || value.status !== 'verification-required' ||
      typeof value.instruction !== 'string' || !isNativeId(value.retryToken)) return null;
  return value.retryToken;
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
