import { transcriptError } from './source.mjs';

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Checkpoint fields must be plain objects');
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) {
    transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Checkpoint contains unsupported or missing fields');
  }
}

export function nativeId(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\s/\\\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..') {
    transcriptError('TRANSCRIPT_IDENTITY_INVALID', 'A bounded native identity is required');
  }
  return value;
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Checkpoint positions must be nonnegative safe integers');
  return value;
}

function anchor(input) {
  if (input === null) return null;
  record(input, ['start', 'end', 'hash', 'rowId']);
  const start = integer(input.start), end = integer(input.end);
  if (end <= start || typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.hash)) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Invalid exact source anchor');
  return Object.freeze({ start, end, hash: input.hash, rowId: nativeId(input.rowId) });
}

/** null creates a fresh metadata-only checkpoint when client/sessionId are given.
 * No prompt text, tool arguments, output, parser buffers or identity history is
 * admitted. Source offsets refer to the caller-verified physical append stream.
 */
export function validateCheckpoint(input, { client, sessionId } = {}) {
  if (input === null) input = { schemaVersion: 1, client, sessionId, offset: 0, anchor: null, exchange: null, scanOffset: 0, cursor: null, boundary: null };
  record(input, ['schemaVersion', 'client', 'sessionId', 'offset', 'anchor', 'exchange', 'scanOffset', 'cursor', 'boundary']);
  if (input.schemaVersion !== 1) transcriptError('TRANSCRIPT_SCHEMA_UNSUPPORTED', 'Unsupported transcript checkpoint schema');
  if (!['claude', 'codex'].includes(input.client) || (client !== undefined && client !== input.client) ||
      (sessionId !== undefined && sessionId !== input.sessionId)) transcriptError('TRANSCRIPT_IDENTITY_MISMATCH', 'Checkpoint native identity does not match the source');
  const offset = integer(input.offset), scanOffset = integer(input.scanOffset), checkedAnchor = anchor(input.anchor);
  nativeId(input.sessionId);
  if (scanOffset < offset || (offset > 0 && checkedAnchor === null)) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Advanced checkpoints need an inspected anchor');
  let exchange = null, cursor = null, boundary = null;
  if (input.exchange !== null) {
    const value = input.exchange;
    record(value, ['id', 'promptId', 'nextPart', 'excluded', 'completed', 'start', 'outcome']);
    if (typeof value.excluded !== 'boolean' || typeof value.completed !== 'boolean' ||
        !(value.outcome === null || ['completed', 'interrupted', 'failed', 'observed'].includes(value.outcome)) || value.completed !== (value.outcome !== null)) {
      transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Invalid exchange state');
    }
    exchange = Object.freeze({ id: nativeId(value.id), promptId: nativeId(value.promptId), nextPart: integer(value.nextPart),
      excluded: value.excluded, completed: value.completed, start: integer(value.start), outcome: value.outcome });
    if (exchange.start > offset) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Exchange starts after the retained emission position');
  }
  if (input.cursor !== null) {
    const value = input.cursor;
    record(value, ['until', 'rowStart', 'fieldIndex', 'textOffset', 'supplement']);
    if (typeof value.supplement !== 'boolean') transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Invalid supplementary-part cursor');
    cursor = Object.freeze({ until: integer(value.until), rowStart: integer(value.rowStart), fieldIndex: integer(value.fieldIndex), textOffset: integer(value.textOffset), supplement: value.supplement });
    if (!exchange || !exchange.completed || cursor.until <= cursor.rowStart || cursor.rowStart !== offset || scanOffset < cursor.until) {
      transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Invalid streaming emission cursor');
    }
    if (cursor.fieldIndex >= 2048 || (cursor.supplement && exchange.nextPart === 0)) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Invalid streaming field or supplementary-part position');
  }
  if (input.boundary !== null) {
    const value = input.boundary;
    record(value, ['promptId', 'rowId', 'scanOffset', 'start', 'matches', 'scanPromptId']);
    if (![0, 1, 2].includes(value.matches) || (value.matches === 0) !== (value.start === null)) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Invalid stop-boundary candidates');
    boundary = Object.freeze({ promptId: nativeId(value.promptId), rowId: value.rowId === null ? null : nativeId(value.rowId),
      scanOffset: integer(value.scanOffset), start: value.start === null ? null : integer(value.start), matches: value.matches,
      scanPromptId: value.scanPromptId === null ? null : nativeId(value.scanPromptId) });
    if (boundary.start !== null && boundary.scanOffset < boundary.start) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'Invalid native stop boundary');
  }
  return Object.freeze({ schemaVersion: 1, client: input.client, sessionId: input.sessionId, offset, anchor: checkedAnchor, exchange, scanOffset, cursor, boundary });
}
