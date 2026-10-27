import { createHash } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { bindClaudeCommand } from './commands.mjs';
import { validateClientContract } from '../core/chat.mjs';
import { validateNativeEvent, ingestNativeEvent } from '../sync/ingress.mjs';

const STARTS = new Set(['startup', 'resume', 'fork', 'clear', 'compact']);
const CLAUDE_FAILURES = new Set(['rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown']);
export const NATIVE_HOOK_LIMITS = Object.freeze({ fields: 128, finalTextUnits: 16 * 1024 * 1024 });

function envelopeObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('NATIVE_HOOK_INVALID', 'Native hook input must be an inert object.');
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  if (keys.length > NATIVE_HOOK_LIMITS.fields || keys.some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail('NATIVE_HOOK_INVALID', 'Native hook input has unsupported fields.');
}

function finalHash(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > NATIVE_HOOK_LIMITS.finalTextUnits || !value.isWellFormed()) fail('NATIVE_HOOK_INVALID', 'The native final-message expectation is outside the supported profile.');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Called only on trusted native hook stdin. The installed package supplies the
 * command identity and invocation-only launch marker; neither comes from model
 * arguments. Unknown native fields are discarded without copying conversation.
 * This function performs no filesystem reads, transcript discovery or dispatch.
 */
export function mapNativeHook(client, input, { claudeCommand = null, launchMarker = null, clientContract = null } = {}) {
  if (!['claude', 'codex'].includes(client)) fail('NATIVE_HOOK_INVALID', 'Unsupported native hook client.');
  envelopeObject(input);
  const installed = validateClientContract(clientContract);
  const hook = input.hook_event_name;
  const result = (event = null, command = null) => Object.freeze({ event, command });
  if (hook === 'UserPromptExpansion' && client === 'claude') {
    const command = claudeCommand === null ? null : bindClaudeCommand(input, claudeCommand);
    return result(null, command === null ? null : Object.freeze({ ...command, clientContract: installed }));
  }
  // Prompt-submit is not a completed human exchange. PreCompact is not a final
  // message. SessionEnd (including reason:other/clear) proves no turn outcome.
  if (!['SessionStart', 'Stop', 'SessionEnd', ...(client === 'claude' ? ['PostCompact', 'StopFailure'] : ['Interrupt'])].includes(hook)) return result();
  let kind = 'end', startSource = null, newSession = false, completion = null;
  if (hook === 'SessionStart') {
    if (!STARTS.has(input.source)) fail('NATIVE_HOOK_UNSUPPORTED', 'The native session-start source is unsupported.');
    kind = 'start'; startSource = input.source; newSession = ['startup', 'fork', 'clear'].includes(startSource);
  } else if (hook === 'Stop') {
    kind = 'completed'; completion = { promptId: client === 'claude' ? input.prompt_id : input.turn_id,
      kind: 'completed', finalTextHash: finalHash(input.last_assistant_message) };
  } else if (client === 'claude' && hook === 'SessionEnd' && input.prompt_id !== undefined) {
    // Native session end authorizes publishing already-observed data for this
    // exact prompt. It proves neither successful completion nor interruption.
    completion = { promptId: input.prompt_id, kind: 'observed', finalTextHash: null };
  } else if (client === 'codex' && hook === 'Interrupt') {
    kind = 'interrupted'; completion = { promptId: input.turn_id, kind: 'interrupted', finalTextHash: null };
  } else if (client === 'claude' && hook === 'StopFailure') {
    if (!CLAUDE_FAILURES.has(input.error)) fail('NATIVE_HOOK_UNSUPPORTED', 'Unsupported native API failure classification.');
    // This hook's last_assistant_message is a rendered API error, not canonical
    // assistant output. Do not use or retain it as a final-text expectation.
    if (input.prompt_id !== undefined) { kind = 'failed'; completion = { promptId: input.prompt_id, kind: 'failed', finalTextHash: null }; }
  }
  const path = input.transcript_path;
  const source = path === null || path === undefined || path === '' ? null : { path, identity: null };
  const event = validateNativeEvent({ client, sessionId: input.session_id, cwd: input.cwd, kind, source,
    startSource, newSession, completion, history: null, launchMarker, clientContract: installed });
  return result(event);
}

/** Metadata-only convenience ingress. A command is returned to the caller's
 * detached command scheduler; it is never executed here. Processing exclusion
 * must also cover command expansion, which has no automatic ingress event.
 */
export async function handleNativeHook(store, client, input, { claudeCommand = null, launchMarker = null,
  clientContract = null, verifyProcessingSession = null, schedule = null } = {}) {
  const mapped = mapNativeHook(client, input, { claudeCommand, launchMarker, clientContract });
  if (mapped.event) return Object.freeze({ ...mapped, ingress: await ingestNativeEvent(store, mapped.event, { verifyProcessingSession, schedule }) });
  if (!mapped.command) return Object.freeze({ ...mapped, ingress: { status: 'ignored' } });
  const command = mapped.command;
  const context = validateNativeEvent({ client, sessionId: command.sessionId, cwd: command.cwd, kind: 'end',
    source: command.sourcePath === null ? null : { path: command.sourcePath, identity: null },
    startSource: null, newSession: false, completion: null, history: null, launchMarker });
  if (verifyProcessingSession !== null) {
    if (typeof verifyProcessingSession !== 'function') fail('NATIVE_HOOK_INVALID', 'Processing exclusion must be a trusted callback.');
    const excluded = await verifyProcessingSession(context);
    if (typeof excluded !== 'boolean') fail('NATIVE_HOOK_INVALID', 'Processing exclusion must return an exact boolean.');
    if (excluded) return Object.freeze({ event: null, command: null, ingress: { status: 'excluded', reason: 'PROCESSING_SESSION' } });
  }
  if (launchMarker !== null) return Object.freeze({ event: null, command: null, ingress: { status: 'pending', reason: 'PROCESSING_IDENTITY_UNVERIFIED' } });
  return Object.freeze({ ...mapped, ingress: { status: 'command' } });
}
