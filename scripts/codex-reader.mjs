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
// descriptors after text exhaustion. v3 treats this plugin's own skill block as
// command markup and leaves out this plugin's control-server exchanges in a
// unit started with that skill. v4 adds the Codex 0.163 forms: a skill picked
// from the `$` list (its selection item and leading mention are markup), a
// mention typed out by hand (kept as typed) and control exchanges made in code
// mode, and leaves out this plugin's control exchanges and the assistant's
// repetition of their replies in every unit, with or without this skill,
// comparing a reply and its relay in the form `codexReplyForm` gives both.
// v5 keeps the v4 rules with the chat capture commands (`capture`, `pause
// chat`, `resume chat`) in the command grammar it decides command-only messages
// with. Published v1-v4 captures remain immutable under their own rules.
export const CODEX_READER_VERSION = '5';
// Retain every supported historical reader independently of later reader bumps.
export const CODEX_TOOL_RULES = Object.freeze({ '1': '1', '2': '2', '3': '2', '4': '2', '5': '2' });
export const CODEX_SKILL_RULES = Object.freeze({ '1': 'retain', '2': 'retain', '3': 'markup', '4': 'mention', '5': 'mention-5' });
const SKILL_MARKUP_RULES = Object.freeze(['markup', 'mention', 'mention-5']);
// Which mentioned-skill message is only a command is decided with the command
// grammar and draft-code alphabet as version 4 shipped them, frozen here: a
// later grammar changes what a new reader version accepts, never the evidence
// of a capture version 4 published. `#` stands for a draft code.
export const CODEX_V4_CONTROL_FORMS = Object.freeze(['help', 'status', 'status --verbose', 'process', 'process repo', 'process chat',
  'process resume', 'process cancel', 'review', 'review #', 'review cancel', 'review cancel #', 'save', 'save #', 'skip', 'skip #']
  .map(form => Object.freeze(form.split(' '))));
export const CODEX_V4_CODE = /^[a-hjkmnp-tv-z2-9]{6}$/;
// The grammar version 5 shipped with, frozen the same way.
export const CODEX_V5_CONTROL_FORMS = Object.freeze(['help', 'status', 'status --verbose', 'capture', 'pause chat', 'resume chat',
  'process', 'process repo', 'process chat', 'process resume', 'process cancel', 'review', 'review #', 'review cancel', 'review cancel #',
  'save', 'save #', 'skip', 'skip #'].map(form => Object.freeze(form.split(' '))));
// Each mention rule set and the command forms it decides command-only messages with.
const MENTION_FORMS = Object.freeze({ mention: CODEX_V4_CONTROL_FORMS, 'mention-5': CODEX_V5_CONTROL_FORMS });
const mentionRules = rules => Object.hasOwn(MENTION_FORMS, rules);
const commandOnly = (rules, text) => typeof text === 'string' && text.length <= 64 && MENTION_FORMS[rules].some(form => {
  const words = text.split(' ');
  return form.length === words.length && form.every((word, index) => word === '#' ? CODEX_V4_CODE.test(words[index]) : word === words[index]);
});
const CONTROL_SERVER = 'cuefluent_control';
// Evidence rules are a pure function of the transcript and the capture's reader
// version, so a published unit replays to the same bytes after an upgrade or a
// move. This plugin's skill block is therefore recognized by its exact native
// shape and the skill name frozen with version 3, never by the installed path,
// which changes with each plugin version. A renamed skill needs a new version.
const MARKUP_SKILL_NAME = 'cuefluent-notes';
const pluginSkillBlock = part => part?.type === 'skill' && part.name === MARKUP_SKILL_NAME && typeof part.path === 'string' &&
  Object.keys(part).every(key => ['type', 'name', 'path'].includes(key));
// Codex 0.163 records a skill picked from the `$` list as a user context item
// of its own and the message as one text part starting with the mention the
// list inserted. These shapes are frozen with reader version 4 and shared with
// the binder and the exclusion proof; a changed shape or name needs a new
// reader version. The installed path is returned, never used by the reader.
export const CODEX_SKILL_MENTIONS = Object.freeze([`$${MARKUP_SKILL_NAME}:${MARKUP_SKILL_NAME}`, `$${MARKUP_SKILL_NAME}`]);
const SELECTION_NAMES = Object.freeze([`${MARKUP_SKILL_NAME}:${MARKUP_SKILL_NAME}`, MARKUP_SKILL_NAME]);
const SELECTION_HEADER = /^<skill>\n<name>([^<\n]{1,128})<\/name>\n<path>([^<\n]{1,4096})<\/path>\n/;
/** This skill's selection item (a user message payload): the SKILL.md path it
 * names, or null for anything else. */
export function codexSkillSelection(payload) {
  const kinds = payload?.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(kinds) || kinds.length !== 1 ||
      kinds[0] !== 'skills.selected_skill_instructions' || !Array.isArray(payload.content) || payload.content.length !== 1) return null;
  const [block] = payload.content;
  if (block?.type !== 'input_text' || typeof block.text !== 'string' || Object.keys(block).some(key => !['type', 'text'].includes(key))) return null;
  const header = SELECTION_HEADER.exec(block.text);
  return header && SELECTION_NAMES.includes(header[1]) && path.isAbsolute(header[2]) ? header[2] : null;
}
/** The text after this skill's leading mention in a one-part message: '' for
 * the mention alone, else what follows it, starting with its separator. The
 * mention may be recorded as the list's one placeholder element covering
 * exactly it, or not at all. Anything else is null. */
export function codexMentionText(content) {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const [part] = content;
  if (part?.type !== 'text' || typeof part.text !== 'string' || Object.keys(part).some(key => !['type', 'text', 'text_elements'].includes(key))) return null;
  const mention = CODEX_SKILL_MENTIONS.find(value => part.text === value || part.text.startsWith(`${value} `) ||
    (part.text.startsWith(value) && !/^[a-z0-9:_-]/i.test(part.text.slice(value.length))));
  if (mention === undefined) return null;
  const elements = part.text_elements ?? [];
  if (!Array.isArray(elements) || elements.length > 1) return null;
  if (elements.length) {
    const [element] = elements;
    if (!element || typeof element !== 'object' || Object.keys(element).some(key => !['byte_range', 'placeholder'].includes(key)) || element.placeholder !== mention ||
        !element.byte_range || typeof element.byte_range !== 'object' || Object.keys(element.byte_range).some(key => !['start', 'end'].includes(key)) ||
        element.byte_range.start !== 0 || element.byte_range.end !== Buffer.byteLength(mention)) return null;
  }
  return part.text.slice(mention.length);
}
// Code mode frames each cell's output with this host status line; what the
// cell printed follows it. A cell still running has printed nothing yet here.
const CELL_FRAMING = /^Script (completed|running with cell ID ([A-Za-z0-9_-]{1,64}))\nWall time \d+(?:\.\d+)? seconds(?: \(code-mode \d+(?:\.\d+)? seconds; overhead -?\d+(?:\.\d+)? seconds\))?\nOutput:\n/;
/** A code-mode cell output: { running, cellId, text } with the printed text,
 * or null for any other shape (an error, other content, no framing). */
export function codexCellOutput(output) {
  let framed, rest;
  if (typeof output === 'string') {
    framed = CELL_FRAMING.exec(output); rest = framed ? output.slice(framed[0].length) : null;
  } else if (Array.isArray(output) && output.length && output.every(block => block?.type === 'input_text' && typeof block.text === 'string' &&
      Object.keys(block).every(key => ['type', 'text'].includes(key)))) {
    framed = CELL_FRAMING.exec(output[0].text);
    rest = framed && framed[0].length === output[0].text.length ? output.slice(1).map(block => block.text).join('') : null;
  }
  if (!framed || rest === null) return null;
  return { running: framed[1] !== 'completed', cellId: framed[2] ?? null, text: rest };
}
/** The text a cell prints for a native MCP item's result: the result object
 * as JSON, or its one text block. A failed call is shown as an error result. */
export function codexToolRenderings(item) {
  const result = item?.result != null && typeof item.result === 'object' ? item.result
    : typeof item?.error?.message === 'string' ? { content: [{ type: 'text', text: item.error.message }], isError: true } : null;
  if (!result) return [];
  const renderings = [JSON.stringify(result)], content = result.content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string' &&
      Object.keys(content[0]).every(key => ['type', 'text'].includes(key))) renderings.push(content[0].text);
  return renderings;
}
// A link destination that is a local path: an absolute path or a `file:///`
// URL (no host, query or fragment), decoded as Codex decodes a local link
// (percent-decoding as UTF-8). Null when it is neither, does not decode, or
// decodes to a control or line-separator character.
const FILE_URL = /^file:\/\/(\/[^?#]*)$/;
const LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
function linkedPath(target) {
  const encoded = FILE_URL.exec(target)?.[1] ?? target;
  if (!encoded.startsWith('/')) return null;
  let decoded;
  try { decoded = decodeURIComponent(encoded); } catch { return null; }
  return LINE_CONTROLS.test(decoded) ? null : decoded;
}
// A Markdown link with a plain or angle-bracket destination, or a file URL autolink.
const LOCAL_LINKS = /\[([^[\]\n]*)\]\((?:<([^<>\n]*)>|([^\s()<>]+))\)|<(file:\/\/[^\s<>]*)>/g;
// Prose with each local link that rule 3 recognizes replaced by its path.
function linkPieces(text, pieces) {
  let at = 0;
  for (const match of text.matchAll(LOCAL_LINKS)) {
    const [whole, name, angled, plain, autolink] = match;
    const decoded = linkedPath(autolink ?? angled ?? plain);
    if (decoded === null || (autolink === undefined && decoded.split('/').filter(Boolean).at(-1) !== name)) continue;
    if (match.index > at) pieces.push({ prose: text.slice(at, match.index) });
    pieces.push({ path: decoded });
    at = match.index + whole.length;
  }
  if (at < text.length) pieces.push({ prose: text.slice(at) });
}
/** The form in which reader version 4 compares a control reply with an
 * assistant message that may relay it, so a relay Codex's model reformatted is
 * still recognized as that reply. Each rule changes only how the same words
 * are marked up, never which words appear, and is part of version 4's
 * evidence rules: changing one needs a new reader version.
 * 1. CRLF and CR become LF.
 * 2. A code span (a run of backticks closed by the next run of the same
 *    length) is one unit: its content, with a line ending read as a space and
 *    one space dropped from each end when both ends have one and it is not all
 *    spaces, is compared as written; no other rule looks inside it. An
 *    unclosed run is text, and so is a backtick after an odd number of
 *    backslashes outside a code span (escaped), so it never opens one; the
 *    rest of its run still may.
 * 3. Outside code spans, a file URL autolink (`<file:///…>`) becomes its
 *    decoded path, and a link `[name](target)` or `[name](<target>)` whose
 *    target is an absolute path or a `file:///` URL becomes its decoded path
 *    when `name` is exactly the path's last segment; any other link stays as
 *    written, so words in its label stay distinct. A path that does not
 *    decode, or decodes to a control or line-separator character, keeps its
 *    link as written. A decoded path is one unit, compared as written.
 * 4. Spaces and tabs at the start and end of each line are dropped, except
 *    inside a code span or a decoded path. Inside a line they stay as written,
 *    so a path or name that differs only in its spacing stays distinct.
 * 5. A line starting with `* `, `+ ` or `• ` starts with `- ` instead.
 * 6. Empty lines are dropped.
 * The result is a canonical encoding of these lines and their units ('' when
 * no line is left), so text never collides with a unit. Pure and
 * deterministic: no platform, locale or file system is consulted. */
export function codexReplyForm(text) {
  const source = text.replace(/\r\n?/g, '\n'), pieces = [];
  // Code spans first: a backtick run closes only on the next run of its length.
  // An opening backtick after an odd number of backslashes is escaped text;
  // inside a code span a backslash is literal, so a closing run is any run.
  const runs = [...source.matchAll(/`+/g)].map(match => ({ at: match.index, length: match[0].length }));
  const byLength = new Map(), seen = new Map();
  runs.forEach((run, index) => { if (!byLength.has(run.length)) byLength.set(run.length, []); byLength.get(run.length).push(index); });
  let at = 0;
  for (let index = 0; index < runs.length; index++) {
    const raw = runs[index];
    if (raw.at < at) continue;
    let slashes = 0;
    while (raw.at - slashes - 1 >= at && source[raw.at - slashes - 1] === '\\') slashes++;
    const run = slashes % 2 ? { at: raw.at + 1, length: raw.length - 1 } : raw, same = byLength.get(run.length);
    if (!same) continue;
    let position = seen.get(run.length) ?? 0;
    while (position < same.length && same[position] <= index) position++;
    seen.set(run.length, position);
    if (position === same.length) continue;
    const close = runs[same[position]];
    if (run.at > at) linkPieces(source.slice(at, run.at), pieces);
    let code = source.slice(run.at + run.length, close.at).replace(/\n/g, ' ');
    if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) code = code.slice(1, -1);
    pieces.push({ code });
    at = close.at + close.length;
  }
  if (at < source.length) linkPieces(source.slice(at), pieces);
  // Lines of units: prose splits on line endings; a code span or a path never does.
  const lines = [[]];
  for (const piece of pieces) {
    if (piece.prose === undefined) { lines.at(-1).push(piece); continue; }
    piece.prose.split('\n').forEach((part, index) => {
      if (index) lines.push([]);
      const line = lines.at(-1), last = line.at(-1);
      if (last?.prose !== undefined) last.prose += part;
      else if (part !== '') line.push({ prose: part });
    });
  }
  const kept = [];
  for (const line of lines) {
    if (line[0]?.prose !== undefined) line[0].prose = line[0].prose.replace(/^[ \t]+/, '').replace(/^[*+\u2022] /, '- ');
    if (line.at(-1)?.prose !== undefined) line.at(-1).prose = line.at(-1).prose.replace(/[ \t]+$/, '');
    const units = line.filter(unit => unit.prose !== '');
    if (units.length) kept.push(units.map(unit => unit.prose ?? (unit.path !== undefined ? ['path', unit.path] : ['code', unit.code])));
  }
  return kept.length ? JSON.stringify(kept) : '';
}
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

function blocks(collector, record, content, kind, syntax, skillRules = 'retain', selected = false, replies = null) {
  if (!Array.isArray(content)) fail('UNSUPPORTED_CODEX_RECORD');
  if (mentionRules(skillRules)) {
    // On the message that selected this skill from the `$` list, the leading
    // mention the list inserted is markup; the words after it and one space
    // stay, unless they are exactly one action: then the message is only the
    // command. Other messages, and a mention typed by hand, stay as typed.
    const after = syntax === 'user' && selected ? codexMentionText(content) : null;
    if (after !== null) {
      if (after.startsWith(' ') && commandOnly(skillRules, after.slice(1))) return;
      collector.add(kind, record, { text: textValue(after.replace(/^ /, '')) }); return;
    }
    // The older skill part with exactly one action is only the command too.
    if (syntax === 'user' && content.length === 2 && pluginSkillBlock(content[0]) && content[1]?.type === 'text' &&
        commandOnly(skillRules, content[1].text)) return;
    // An assistant message that only repeats this plugin's reply in this turn,
    // compared in the form `codexReplyForm` gives both, is that reply, not the
    // assistant's own text.
    if (kind === 'assistant' && replies?.size && content.length && content.every(item => ['text', 'output_text', 'Text'].includes(item?.type) && typeof item.text === 'string') &&
        replies.has(codexReplyForm(content.map(item => item.text).join('')))) return;
  }
  for (const item of content) {
    // Selecting this skill is command markup around the typed text, which stays.
    if (syntax === 'user' && SKILL_MARKUP_RULES.includes(skillRules) && pluginSkillBlock(item)) continue;
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

const completedItem = value => value.type === 'event_msg' && value.payload?.type === 'item_completed' ? value.payload.item : null;
// Calls to this plugin's control server are its own processing and review
// activity: version 3 leaves them out in a unit the person started with this
// skill, version 4 in every unit, whether the person picked the skill, typed a
// mention or asked in their own words. They are identified only by native
// identity: the call's namespace and its native MCP item's server and tool,
// never by text. Other tools and user text are unchanged; assistant text is
// left out only when it repeats one of these calls' replies (see `blocks`).
function controlExchanges(unit, skillRules) {
  const ids = new Set();
  if (!SKILL_MARKUP_RULES.includes(skillRules)) return ids;
  const values = unit.records.map(record => record.value), item = completedItem;
  if (skillRules === 'markup' && !values.some(value => item(value)?.type === 'UserMessage' && Array.isArray(item(value).content) &&
    item(value).content.some(pluginSkillBlock))) return ids;
  const native = new Map();
  for (const value of values) {
    const call = item(value);
    if (call?.type !== 'McpToolCall' || typeof call.id !== 'string') continue;
    const identity = `${call.server}\0${call.tool}`;
    native.set(call.id, native.has(call.id) && native.get(call.id) !== identity ? null : identity);
  }
  for (const value of values) {
    const p = value.payload;
    if (value.type === 'response_item' && p?.type === 'function_call' && typeof p.call_id === 'string' &&
        p.namespace === `mcp__${CONTROL_SERVER}` && native.get(p.call_id) === `${CONTROL_SERVER}\0${p.name}`) ids.add(p.call_id);
  }
  if (mentionRules(skillRules)) for (const id of codeModeExchanges(unit, values)) ids.add(id);
  return ids;
}

// Codex CLI 0.163 records a refused call's JSON-RPC error in its own framing
// (codex-rs `mcp_tool_call.rs` and `codex-mcp/src/binding.rs` at
// rust-v0.163.0): its context line, then anyhow's "Caused by:" block holding
// rmcp's `Mcp error: <code>: <message>` followed by the error's data, which for
// this server is `{"code":…}`, with every further line indented four spaces.
// The message inside is the plain reply the assistant is told to return. Any
// other framing yields nothing, so its relay stays.
function codexErrorReply(item) {
  const prefix = `tool call error: tool call failed for \`${CONTROL_SERVER}/${item.tool}\`\n\nCaused by:\n    Mcp error: `;
  if (!item.error.message.startsWith(prefix)) return null;
  const [first, ...rest] = item.error.message.slice(prefix.length).split('\n');
  if (rest.some(line => !line.startsWith('    '))) return null;
  return /^-?\d+: ([\s\S]+?)\(\{"code":"[A-Z_]+"\}\)$/.exec([first, ...rest.map(line => line.slice(4))].join('\n'))?.[1] ?? null;
}

// The plain replies this plugin's control calls in the unit returned, in the
// form `codexReplyForm` gives them: the status text of each result (including
// the command list and a not-a-command reply), or a refusal's message, both as
// Codex recorded it and as the plain message inside its framing. Identified
// through the native items already proven to be control exchanges, never by
// text alone.
function controlReplies(unit, exchanges) {
  const replies = new Set(), add = text => { const form = codexReplyForm(text); if (form) replies.add(form); };
  for (const record of unit.records) {
    const item = completedItem(record.value);
    if (item?.type !== 'McpToolCall' || item.server !== CONTROL_SERVER || !exchanges.has(item.id)) continue;
    const content = item.result?.content;
    if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') {
      try { const value = JSON.parse(content[0].text); if (typeof value?.statusText === 'string' && value.statusText) add(value.statusText); }
      catch { /* Not a control reply. */ }
    }
    if (typeof item.error?.message === 'string' && item.error.message) {
      add(item.error.message);
      const reply = codexErrorReply(item);
      if (reply) add(reply);
    }
  }
  return replies;
}

// Native items a tool call can leave. In code mode a cell's nested calls have
// such an item and no model call record of their own.
const toolItems = new Set(['McpToolCall', 'CommandExecution', 'FileChange', 'DynamicToolCall', 'WebSearch', 'ImageView',
  'ImageGeneration', 'Extension', 'Plan', 'EnteredReviewMode', 'ExitedReviewMode']);
// Code-mode cells are model JavaScript, which is never read. A cell is this
// plugin's exchange only when nothing else can have happened in it: every
// nested native item inside the cell's span (from its call to its last output,
// including `wait` calls on it) is a call to this plugin's control server, and
// every output of the cell is Codex's framing around nothing or around exactly
// what one of those calls returned. Such a cell, its waits, outputs and nested
// items are left out; other cells stay. A nested item outside every cell, or
// inside two open cells, keeps every code-mode record, and so does a child agent.
function codeModeExchanges(unit, values) {
  if (unit.collaborationIds.size) return [];
  const calls = [], outputs = new Map(), nested = [];
  values.forEach((value, index) => {
    const p = value.payload, item = completedItem(value);
    if (value.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p?.type) && typeof p.call_id === 'string') calls.push({ index, p });
    const callId = item?.type === 'FunctionCallOutput' ? item.id
      : value.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p?.type) ? p.call_id : null;
    if (typeof callId === 'string') outputs.set(callId, [...(outputs.get(callId) ?? []), { index, printed: codexCellOutput(item ? item.output : p.output) }]);
    if (toolItems.has(item?.type)) nested.push({ index, item });
  });
  const direct = new Set(calls.map(call => call.p.call_id));
  const cells = calls.filter(call => call.p.type === 'custom_tool_call' && call.p.name === 'exec' && call.p.namespace == null)
    .map(call => ({ index: call.index, callId: call.p.call_id, waits: [], nested: [], outputs: [...(outputs.get(call.p.call_id) ?? [])] }));
  if (!cells.length) return [];
  // A running cell announces its runtime ID; `wait` calls name it.
  const running = new Map();
  for (const cell of cells) for (const output of cell.outputs) if (output.printed?.running) {
    running.set(output.printed.cellId, running.has(output.printed.cellId) && running.get(output.printed.cellId) !== cell ? null : cell);
  }
  for (const call of calls.filter(entry => entry.p.type === 'function_call' && entry.p.name === 'wait' && entry.p.namespace == null)) {
    let cellId = null;
    try { cellId = JSON.parse(call.p.arguments)?.cell_id; } catch { /* An unreadable wait names no cell. */ }
    const cell = typeof cellId === 'string' ? running.get(cellId) : null;
    if (cell) { cell.waits.push(call.p.call_id); cell.outputs.push(...(outputs.get(call.p.call_id) ?? [])); }
  }
  for (const cell of cells) cell.end = cell.outputs.length ? Math.max(...cell.outputs.map(output => output.index)) : values.length;
  for (const entry of nested.filter(entry => !direct.has(entry.item.id))) {
    const owners = cells.filter(cell => cell.index < entry.index && entry.index < cell.end);
    if (owners.length !== 1) return [];
    owners[0].nested.push(entry.item);
  }
  const ids = [];
  for (const cell of cells) {
    if (!cell.nested.length || cell.nested.some(item => item.type !== 'McpToolCall' || item.server !== CONTROL_SERVER || typeof item.id !== 'string' ||
        typeof item.tool !== 'string' || !['completed', 'failed'].includes(item.status))) continue;
    const shown = new Set(cell.nested.flatMap(codexToolRenderings));
    if (cell.outputs.some(({ printed }) => !printed || (printed.text !== '' && (printed.running || !shown.has(printed.text))))) continue;
    ids.push(cell.callId, ...cell.waits, ...cell.nested.map(item => item.id));
  }
  return ids;
}

function normalizeUnit(unit, historyMode, checkBudget, toolRulesVersion, skillRules = 'retain') {
  const collector = evidenceCollector(undefined, { toolRulesVersion }), calls = new Map(), seen = new Map(), outcomes = new Map(), collabIds = new Set(unit.collaborationIds);
  const exchanges = controlExchanges(unit, skillRules);
  const replies = mentionRules(skillRules) ? controlReplies(unit, exchanges) : null;
  // Markup belongs only to the message the `$` list selection was made for.
  const selectedMessage = id => mentionRules(skillRules) && unit.selectedMessages.has(id);
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
        blocks(collector, record, item.content, item.type === 'UserMessage' ? 'user' : 'assistant', item.type === 'UserMessage' ? 'user' : 'assistant', skillRules,
          item.type === 'UserMessage' && selectedMessage(item.id), replies);
      } else if (item?.type === 'CommandExecution') {
        // Status corroborates raw tool evidence; command output is not copied a second time.
        if (!unit.records.some(r => r.value.type === 'response_item' && r.value.payload.call_id === item.id)) collector.omit('native-tool-without-raw-evidence', record);
      } else if (item?.type === 'FunctionCallOutput') {
        if (exchanges.has(item.id)) continue;
        if (!unit.records.some(r => r.value.type === 'response_item' && r.value.payload.call_id === item.id && r.value.payload.type.endsWith('_output'))) {
          if (collabIds.has(item.id)) collector.omit('child-agent-output-excluded', record);
          else collector.add('tool-result', record, { tool: toolName(item), callId: string(item.id, 256), outcome: outcomes.get(item.id) ?? 'unknown', text: toolText(collector, record, item.output) });
        }
      } else if (['Plan', 'FileChange', 'McpToolCall', 'DynamicToolCall', 'WebSearch', 'ImageView', 'ImageGeneration', 'Extension', 'EnteredReviewMode', 'ExitedReviewMode'].includes(item?.type)) {
        if (exchanges.has(item.id)) continue;
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
      if (exchanges.has(callId)) continue;
      if (collabIds.has(callId)) { collector.omit('child-agent-output-excluded', record); continue; }
      collector.add('tool-call', record, { tool, callId, text: p.type === 'function_call' ? p.arguments : p.input });
      if (p.encrypted_function_args?.length) collector.omit('encrypted-tool-arguments-excluded', record);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      if (p.call_id == null) { collector.omit('unattributed-tool-output', record); continue; }
      const callId = string(p.call_id, 256), tool = calls.get(callId) ?? (p.name ? toolName(p) : null);
      if (exchanges.has(callId)) continue;
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
      units.set(unitId, { id: unitId, start: record, records: [record], end: null, terminal: null, collaborationIds: new Set(), selected: false, selectedMessages: new Set() });
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
        // Model context, never evidence. A Codex 0.163 selection of this skill
        // still marks its own open turn as started with this skill.
        const selecting = !line.metadata?.inherited_user_message && codexSkillSelection(p) !== null ? units.get(p.internal_chat_message_metadata_passthrough?.turn_id) : null;
        if (selecting && !selecting.end) {
          selecting.selected = true;
          // The selection is made for the message just submitted: the turn's
          // latest user message before it.
          const message = selecting.records.findLast(entry => completedItem(entry.value)?.type === 'UserMessage');
          if (typeof message?.value.payload.item.id === 'string') selecting.selectedMessages.add(message.value.payload.item.id);
        }
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
    // Either native form of selecting this skill: the older skill part of the
    // message, or the Codex 0.163 selection item. The proof checks the rest.
    const selectedSkill = unit.selected || unit.records.some(record => record.value.payload?.item?.type === 'UserMessage' &&
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
    const version = choice(readerVersion, Object.keys(CODEX_TOOL_RULES));
    const collected = normalizeUnit(unit, scan.metadata.historyMode, checkBudget, CODEX_TOOL_RULES[version], CODEX_SKILL_RULES[version]);
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
