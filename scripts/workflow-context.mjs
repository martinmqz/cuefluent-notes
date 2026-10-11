import { randomBytes } from 'node:crypto';
import { absolutePath } from './workflow-paths.mjs';
import { keys, string, choice, nativeId, hash, list, unique, fail, canonicalJSON } from './workflow-values.mjs';

const EVENTS = {
  codex: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'Interrupt'],
  claude: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'StopFailure'],
};
const OPERATIONS = ['collect', 'process', 'control', 'direct-save'];
const token = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('INVALID_CONTEXT_REFERENCE');
  return value;
};
const lifecycleCode = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : 'unknown';

/** Implementation capabilities, not user policy or a caller-supplied proof.
 * Arbitrary CLI stdout has no verified copy attribution. The dedicated native
 * controller has a separate, narrower record proof; neither is user policy. */
export function generatedOutputCapabilities() {
  return { verified: false, collectionExclusions: false, processingExclusions: false,
    reason: 'HELPER_INVOCATION_BINDING_UNAVAILABLE',
    clients: {
      codex: { retainedEvidence: 'human-assistant-tools', retainedToolCallIds: true, helperInvocationBinding: false },
      claude: { retainedEvidence: 'proven-human-only', retainedToolCallIds: false, helperInvocationBinding: false }
    },
    requiredProof: ['native-session-unit-call-ownership', 'trusted-helper-invocation', 'immutable-artifact-hash', 'exact-output-ranges'],
    isolatedProcessing: { interfaceVersion: 1, execution: 'installed-native-client',
      collectionExclusions: 'verified-native-records-only', processingExclusions: false,
      codex: 'completed-restricted-unit', claude: 'controller-input-only',
      sourceControls: 'verified-formal-skill-invocation', inheritedHooks: 'disabled-before-input',
      review: 'native-host-form', desktopVisibility: 'unverified' },
    limit: 'Native call identity alone does not prove helper execution. Markers, command text, operation IDs and matching hashes cannot enable exclusions.' };
}

/** Stateless adapter: intentionally discard prompt/error bodies and all unknown fields. */
export function nativeContextEnvelope(client, payload) {
  choice(client, ['codex', 'claude']);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.hasOwn(payload, 'agent_id')) fail('UNSUPPORTED_NATIVE_CONTEXT');
  const event = choice(payload.hook_event_name, EVENTS[client]);
  const sessionId = nativeId(payload.session_id);
  const value = client === 'codex' ? payload.turn_id : payload.prompt_id;
  const unitId = value === undefined && ['SessionStart', 'SessionEnd'].includes(event) ? null : nativeId(value);
  const result = { client, event, sessionId, unitId, cwd: absolutePath(payload.cwd),
    sourcePath: payload.transcript_path === null || payload.transcript_path === undefined ? null : absolutePath(payload.transcript_path) };
  if (event === 'SessionStart') result.startSource = choice(payload.source, ['startup', 'resume', 'clear', 'compact']);
  if (event === 'SessionEnd') result.endReason = lifecycleCode(payload.reason);
  if (event === 'Stop') {
    if (typeof payload.stop_hook_active !== 'boolean') fail('UNSUPPORTED_NATIVE_CONTEXT');
    result.stopHookActive = payload.stop_hook_active;
  }
  if (event === 'StopFailure') result.failure = lifecycleCode(payload.error);
  return result;
}

function bindingShape(value) {
  keys(value, ['version', 'contextRef', 'client', 'sessionId', 'unitId', 'sourcePath', 'sourceIdentity',
    'cwd', 'projectRoot', 'routeId', 'collectionId', 'policyHash', 'epoch', 'operations']);
  if (value.version !== 1) fail('INVALID_CONTEXT_REFERENCE');
  token(value.contextRef); choice(value.client, ['codex', 'claude']);
  nativeId(value.sessionId); nativeId(value.unitId);
  for (const field of ['sourcePath', 'cwd', 'projectRoot']) absolutePath(value[field]);
  for (const field of ['sourceIdentity', 'routeId', 'collectionId', 'epoch']) string(value[field], 512);
  hash(value.policyHash);
  list(value.operations, OPERATIONS.length, { empty: false }).forEach(op => choice(op, OPERATIONS));
  unique(value.operations);
  return value;
}

/** Pure registration contract. Call only after trusted native source/epoch validation.
 * This function does not persist a binding or establish current-turn authority.
 */
export function createContextBinding({ envelope, sourceIdentity, route, policyHash, epoch, operations }) {
  return bindingShape({ version: 1, contextRef: randomBytes(32).toString('hex'),
    client: envelope.client, sessionId: envelope.sessionId, unitId: envelope.unitId,
    sourcePath: envelope.sourcePath, sourceIdentity, cwd: envelope.cwd,
    projectRoot: route.projectRoot, routeId: route.id, collectionId: route.collectionId,
    policyHash, epoch, operations: [...operations] });
}

/** stored/latest/selection come from helper-owned state and current policy, NEVER source prose.
 * latest must be advanced by native lifecycle order, not lexical IDs or notification arrival.
 */
export function validateContextReference({ contextRef, operation, stored, latest, selection }) {
  token(contextRef); choice(operation, OPERATIONS);
  bindingShape(stored); bindingShape(latest);
  if (stored.contextRef !== contextRef || latest.contextRef !== contextRef ||
      canonicalJSON(stored) !== canonicalJSON(latest) || !stored.operations.includes(operation)) fail('STALE_CONTEXT_REFERENCE');
  keys(selection, ['client', 'sessionId', 'unitId', 'sourcePath', 'sourceIdentity', 'cwd', 'projectRoot',
    'routeId', 'collectionId', 'policyHash', 'epoch']);
  for (const key of Object.keys(selection)) if (selection[key] !== stored[key]) fail('STALE_CONTEXT_REFERENCE');
  return structuredClone(stored);
}
