import { assertIntakeTransaction, assertIntakePrivacy, intakeSnapshot, intakeJSON, replaceIntakeJSON } from './intake-io.mjs';
import { readSelection, verifySourceCursor } from './intake-store.mjs';
import { newSelectionState, validateSelectionState } from './capture-selection.mjs';
import { absolutePath } from './workflow-paths.mjs';
import { canonicalJSON, digest, fail, keys, nativeId, hash, string, id } from './workflow-values.mjs';

const FORMAT = 'cuefluent-processing-control-dispatch';
const MAX_RECEIPT_BYTES = 32 * 1024;
const FIELDS = ['client', 'sessionId', 'unitId', 'callId', 'tool', 'argsHash', 'sourceIdentity', 'sourcePath',
  'requestHash', 'skillName', 'skillPath', 'statusText', 'resultHash'];
const CLAUDE_FIELDS = ['inputId', 'inputHash', 'companionId', 'companionHash', 'skillExpansionHash', 'skillCommand'];
// A Codex code-mode control: the handshake's first cell (its item ID), the
// retry's cell and nested call, and the handshake result, all from native
// metadata. callId is the handshake's nested call. All four or none.
const CODEX_CODE_MODE_FIELDS = ['outerItemId', 'retryItemId', 'retryCallId', 'handshakeResultHash'];
const nativeToken = value => { string(value, 128); if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail('INVALID_PROCESSING_CONTROL_RECEIPT'); };

function dispatchDescriptor(value) {
  keys(value, value?.client === 'claude' ? [...FIELDS, ...CLAUDE_FIELDS] : FIELDS, ['response', ...(value?.client === 'codex' ? CODEX_CODE_MODE_FIELDS : [])]);
  if (!['codex', 'claude'].includes(value.client) || value.skillName !== 'cuefluent-notes') fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  nativeId(value.sessionId); nativeId(value.unitId); string(value.callId, 512);
  if (value.client === 'codex' && CODEX_CODE_MODE_FIELDS.some(field => value[field] !== undefined)) {
    if (CODEX_CODE_MODE_FIELDS.some(field => value[field] === undefined)) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
    nativeToken(value.outerItemId); nativeToken(value.retryItemId); nativeToken(value.retryCallId); hash(value.handshakeResultHash);
    if (value.outerItemId === value.retryItemId || value.retryCallId === value.callId) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  }
  if (!(value.client === 'codex' ? /^mcp__[a-zA-Z0-9_-]{1,128}\.[a-zA-Z0-9_-]{1,128}$/
    : /^mcp__[a-zA-Z0-9_-]*cuefluent_control__(?:process_selected_captures|processing_review|processing_status|processing_resume|processing_cancel)$/).test(value.tool)) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  if (value.client === 'claude') {
    nativeId(value.inputId); nativeId(value.companionId);
    for (const field of ['inputHash', 'companionHash', 'skillExpansionHash']) hash(value[field]);
    if (!/^[a-z][a-z0-9-]{0,63}:cuefluent-notes$/.test(value.skillCommand)) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  }
  for (const field of ['argsHash', 'sourceIdentity', 'requestHash', 'resultHash']) hash(value[field]);
  absolutePath(value.sourcePath); absolutePath(value.skillPath); string(value.statusText, 4096);
  if (Buffer.byteLength(value.statusText) > 4096) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  // The stored reply is checked against the text and result hash recorded with
  // it, never re-rendered: a receipt stays valid when a later release words
  // its replies differently.
  if (value.response !== undefined) {
    if (value.response === null || typeof value.response !== 'object' || Array.isArray(value.response)) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
    id(value.response.collectionId);
    const result = { content: [{ type: 'text', text: canonicalJSON(value.response) }], isError: false };
    if (value.response.statusText !== value.statusText ||
        digest(canonicalJSON(value.client === 'claude' ? result.content : result)) !== value.resultHash) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  }
  return value;
}

function receiptValue(value) {
  keys(value, ['format', 'version', 'source', 'selectionHash', 'dispatch']);
  if (value.format !== FORMAT || value.version !== 1) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  newSelectionState(value.source); hash(value.selectionHash); dispatchDescriptor(value.dispatch);
  const d = value.dispatch;
  if (d.client !== value.source.client || d.sessionId !== value.source.sessionId ||
      d.sourceIdentity !== value.source.fileIdentity || d.sourcePath !== value.source.path) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  if (Buffer.byteLength(canonicalJSON(value)) > MAX_RECEIPT_BYTES - 1) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  return value;
}

function readReceipt(snapshot) {
  if (snapshot.bytes === null) return null;
  const value = receiptValue(intakeJSON(snapshot));
  // These files are helper-owned immutable metadata. Canonical bytes reject
  // duplicate keys and alternate serialized assertions rather than normalizing
  // unfamiliar metadata into new exclusion authority.
  if (!snapshot.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  return value;
}

// Call IDs are native opaque strings, never path components. Full values remain
// in the record so even a filename hash collision is an explicit conflict.
const receiptPath = ({ client, sessionId, callId }) => {
  if (!['codex', 'claude'].includes(client)) fail('INVALID_PROCESSING_CONTROL_RECEIPT');
  nativeId(sessionId); string(callId, 512);
  return `control-dispatch/${client}/${sessionId}/${digest(callId).slice(0, 24)}.json`;
};

// A one-time capture's store admits only its own scope, so a read for it names that scope.
async function selectionGuard(transaction, source, selectionHash, unitId, authorize, scopeId = null) {
  const store = await assertIntakeTransaction(transaction);
  await assertIntakePrivacy(transaction, { identity: { client: source.client, sessionId: source.sessionId, unitId }, projectRoot: source.projectRoot, scopeId });
  const selected = await readSelection(store, { client: source.client, sessionId: source.sessionId });
  if (!selected.state || selected.hash !== selectionHash) fail('STALE_SELECTION');
  if (canonicalJSON(selected.state.source) !== canonicalJSON(source)) fail('SOURCE_IDENTITY_MISMATCH');
  if (selected.state.safetyStop || selected.state.exclusions.includes(unitId)) fail('CAPTURE_NOT_SELECTED');
  if (typeof authorize !== 'function' || await authorize({ phase: 'processing-control-receipt', operation: 'capture',
    identity: { client: source.client, sessionId: source.sessionId, unitId }, projectRoot: source.projectRoot, sourcePath: source.path }) !== true) fail('INTAKE_NOT_AUTHORIZED');
  return store;
}

/** Internal native-controller callback only. Source/call identity must originate
 * in the verified native connection; no CLI command accepts this descriptor.
 * This receipt never excludes content by itself: the native reader must prove
 * the entire completed unit, selected skill, actual tool result and exact status.
 */
export async function recordProcessingControlDispatch(transaction, { source, selectionHash, dispatch }, { authorize, beforePublish } = {}) {
  const value = receiptValue({ format: FORMAT, version: 1, source: structuredClone(source), selectionHash,
    dispatch: structuredClone(dispatch) });
  const bound = value.dispatch;
  const store = await selectionGuard(transaction, value.source, selectionHash, bound.unitId, authorize);
  const name = receiptPath(bound), previous = await intakeSnapshot(store, 'state', name, { maxBytes: MAX_RECEIPT_BYTES });
  const old = readReceipt(previous);
  if (old !== null) {
    if (canonicalJSON(old) !== canonicalJSON(value)) fail('PROCESSING_CONTROL_RECEIPT_CONFLICT');
    return Object.freeze({ status: 'already-recorded', receiptHash: previous.hash });
  }
  await verifySourceCursor(value.source, { sourceIdentity: value.source.fileIdentity, offset: 0, anchor: null });
  await selectionGuard(transaction, value.source, selectionHash, bound.unitId, authorize);
  // Once immutable admission publication begins, a late transport cancellation
  // cannot leave a replayable receipt for a run that was never released.
  beforePublish?.();
  return Object.freeze({ status: 'recorded', receiptHash: await replaceIntakeJSON(transaction, name, value, null) });
}

/** Read authority expires with the enclosing intake transaction. A missing
 * receipt is ordinary evidence, not an error or permission to skip that unit.
 * Current selection is pinned independently of the historical receipt hash.
 */
export function createProcessingControlResolver(transaction, { state, selectionHash, authorize, scopeId = null }) {
  validateSelectionState(state); hash(selectionHash);
  if (scopeId !== null) nativeId(scopeId);
  const source = structuredClone(state.source);
  return async query => {
    query = structuredClone(query);
    keys(query, ['client', 'sessionId', 'unitId', 'callId', 'tool', 'argsHash']);
    nativeId(query.unitId); hash(query.argsHash);
    if (query.client !== source.client || query.sessionId !== source.sessionId) return null;
    const store = await selectionGuard(transaction, source, selectionHash, query.unitId, authorize, scopeId);
    const snapshot = await intakeSnapshot(store, 'state', receiptPath(query), { maxBytes: MAX_RECEIPT_BYTES });
    if (snapshot.bytes === null) return null;
    const value = readReceipt(snapshot);
    if (canonicalJSON(value.source) !== canonicalJSON(source) ||
        Object.entries(query).some(([key, item]) => value.dispatch[key] !== item)) return null;
    await selectionGuard(transaction, source, selectionHash, query.unitId, authorize, scopeId);
    return Object.freeze({ ...value.dispatch });
  };
}
