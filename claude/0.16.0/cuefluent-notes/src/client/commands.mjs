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
  const action = parseAction(envelope.command_args);
  if (typeof envelope.prompt !== 'string' || envelope.prompt.length > name.length + 130 ||
      CONTROL.test(envelope.prompt) || envelope.prompt.trim() !== `/${name} ${envelope.command_args.trim()}`) {
    fail('NATIVE_COMMAND_MISMATCH', 'The native command expansion does not match its direct invocation.');
  }
  return Object.freeze({ client: 'claude', sessionId: token(envelope.session_id, 'session identity'),
    promptId: token(envelope.prompt_id, 'prompt identity'), action,
    cwd: absolute(envelope.cwd, 'working directory'), sourcePath: absolute(envelope.transcript_path, 'transcript path', true) });
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
  const parts = event.item.content;
  if (!Array.isArray(parts) || parts.length !== 2) fail('NATIVE_COMMAND_MISMATCH', 'A command requires one selected skill and one exact action.');
  const skills = parts.filter(item => item?.type === 'skill'), texts = parts.filter(item => item?.type === 'text');
  if (skills.length !== 1 || texts.length !== 1 || skills[0].name !== name || skills[0].path !== skillPath ||
      (texts[0].text_elements !== undefined && (!Array.isArray(texts[0].text_elements) || texts[0].text_elements.length))) {
    fail('NATIVE_COMMAND_MISMATCH', 'The native selection does not match this installed skill and exact action.');
  }
  return Object.freeze({ client: 'codex', sessionId, promptId, action: parseAction(texts[0].text),
    cwd: absolute(cwd, 'working directory'), sourcePath: absolute(sourcePath, 'transcript path', true) });
}
