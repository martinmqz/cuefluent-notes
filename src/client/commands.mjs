import path from 'node:path';
import { fail } from '../core/errors.mjs';

const ACTIONS = new Set(['track', 'untrack', 'process', 'process project', 'save', 'skip', 'status']);
const CONTROL = /[\u0000-\u001f\u007f]/;

function token(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\s/\\\u0000-\u001f\u007f]/.test(value)) {
    fail('NATIVE_CONTEXT_INVALID', `The native ${label} is missing or invalid.`);
  }
  return value;
}

function absolute(value, label, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || value.length > 32768 || CONTROL.test(value) || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail('NATIVE_CONTEXT_INVALID', `The native ${label} must be an absolute path.`);
  }
  return value;
}

export function parseAction(value) {
  if (typeof value !== 'string' || value.length > 128 || CONTROL.test(value)) {
    fail('COMMAND_INVALID', 'Use track, untrack, process, process project, save, skip, or status.');
  }
  const action = value.trim().replace(/ +/g, ' ');
  if (!ACTIONS.has(action)) fail('COMMAND_INVALID', 'Use track, untrack, process, process project, save, skip, or status.');
  return action;
}

/** Only the installed native hook calls this with its stdin envelope. Never
 * expose envelope fields as model-provided mutation-tool arguments. The expected
 * name/source come from the selected, verified client package contract.
 */
export function bindClaudeCommand(envelope, { name, source } = {}) {
  token(name, 'command name'); token(source, 'command source');
  if (envelope?.hook_event_name !== 'UserPromptExpansion' || envelope.expansion_type !== 'slash_command' ||
      envelope.command_name !== name || envelope.command_source !== source) return null;
  let action;
  try { action = parseAction(envelope.command_args); }
  catch (error) {
    // Natural-language note requests are handled by the skill's content tools.
    // They grant no native tracking or queue-processing command authority.
    if (error.code === 'COMMAND_INVALID') return null;
    throw error;
  }
  if (typeof envelope.prompt !== 'string' || envelope.prompt.length > name.length + 130 ||
      CONTROL.test(envelope.prompt) || envelope.prompt.trim() !== `/${name} ${envelope.command_args.trim()}`) {
    fail('NATIVE_COMMAND_MISMATCH', 'The native command expansion does not match its direct invocation.');
  }
  return Object.freeze({ client: 'claude', sessionId: token(envelope.session_id, 'session identity'),
    promptId: token(envelope.prompt_id, 'prompt identity'), action,
    cwd: absolute(envelope.cwd, 'working directory'), sourcePath: absolute(envelope.transcript_path, 'transcript path', true) });
}

/** Exact native linked history representation, shared by current command binding
 * and historical exclusion. The caller independently establishes native identity. */
export function codexLinkedAction(text, name, skillPath) {
  if (typeof text !== 'string') return null;
  for (const label of [name, `cuefluent-notes:${name}`]) {
    const prefix = `[$${label}](${skillPath}) `;
    if (text.length > prefix.length + 130 || !text.startsWith(prefix)) continue;
    const action = text.slice(prefix.length).replace(/\r?\n$/, '');
    if (ACTIONS.has(action)) return action;
  }
  return null;
}

function codexAction(parts, name, skillPath) {
  if (!Array.isArray(parts)) fail('NATIVE_COMMAND_MISMATCH', 'The native user item has no supported command content.');
  const texts = parts.filter(item => item?.type === 'text');
  if (texts.length !== 1 || (texts[0].text_elements !== undefined &&
      (!Array.isArray(texts[0].text_elements) || texts[0].text_elements.length))) {
    fail('NATIVE_COMMAND_MISMATCH', 'A command requires one unannotated action text.');
  }
  if (parts.length === 2) {
    const skills = parts.filter(item => item?.type === 'skill');
    if (skills.length === 1 && skills[0].name === name && skills[0].path === skillPath) return parseAction(texts[0].text);
  } else if (parts.length === 1) {
    // Codex history can reconstruct a selected skill as a linked text mention.
    // Match the entire direct invocation, not Markdown found inside ordinary
    // prose. Identity still comes from the transport and exact native turn.
    const action = codexLinkedAction(texts[0].text, name, skillPath);
    if (action !== null) return action;
  }
  fail('NATIVE_COMMAND_MISMATCH', 'The native selection does not match this installed skill and exact action.');
}

/** Match transport-owned MCP metadata to an independently read native rollout
 * UserMessage item. Model arguments supply neither object. A source resolver must
 * establish the rollout identity/path and row integrity before calling this.
 */
export function bindCodexCommand(meta, row, { name, skillPath, cwd, sourcePath = null } = {}) {
  token(name, 'skill name'); absolute(skillPath, 'selected skill path');
  const native = meta?.['x-codex-turn-metadata'];
  const sessionId = token(native?.session_id, 'session identity');
  const threadId = token(native?.thread_id, 'thread identity');
  const promptId = token(native?.turn_id, 'turn identity');
  if (sessionId !== threadId) fail('NATIVE_CONTEXT_UNSUPPORTED', 'This native session/thread identity shape is not supported.');
  const event = row?.type === 'event_msg' ? row.payload : null;
  if (event?.type !== 'item_completed' || event.thread_id !== threadId || event.turn_id !== promptId || event.item?.type !== 'UserMessage') {
    fail('NATIVE_COMMAND_MISMATCH', 'The selected native user item does not belong to this tool invocation.');
  }
  token(event.item.id, 'user item identity');
  return Object.freeze({ client: 'codex', sessionId, promptId, action: codexAction(event.item.content, name, skillPath),
    cwd: absolute(cwd, 'working directory'), sourcePath: absolute(sourcePath, 'transcript path', true) });
}
