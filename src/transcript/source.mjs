import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parser } from 'stream-json/parser.js';

export const TRANSCRIPT_LIMITS = Object.freeze({ readBytes: 65536, depth: 64, keyBytes: 1024, metadataBytes: 65536,
  metadataValues: 2048, structuralValues: 65536, partBytes: 65536, toolOutputBytes: 32768, rows: 256, parts: 64 });

export function transcriptError(code, message) {
  const error = new Error(message); error.code = code; throw error;
}

export function transcriptLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) transcriptError('TRANSCRIPT_LIMIT_INVALID', 'Limits must be an object');
  const result = { ...TRANSCRIPT_LIMITS };
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(result, name) || !Number.isSafeInteger(value) || value < 1 || value > TRANSCRIPT_LIMITS[name]) {
      transcriptError('TRANSCRIPT_LIMIT_INVALID', 'Limits must be positive and may only reduce the supported bounds');
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

export function assertSource(source) {
  if (!source || !Number.isSafeInteger(source.size) || source.size < 0 || typeof source.read !== 'function') {
    transcriptError('TRANSCRIPT_SOURCE_INVALID', 'A bounded immutable source snapshot is required');
  }
}

async function read(source, offset, length) {
  const value = await source.read(offset, length);
  if (!(value instanceof Uint8Array) || value.byteLength !== length) transcriptError('TRANSCRIPT_SOURCE_CHANGED', 'A source read did not match the inspected snapshot');
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Read only bounded chunks. The caller owns the source handle, path checks and
 * snapshot identity; a trailing non-newline row is never committed.
 */
async function* rowBytes(source, start, state, limits, end) {
  let offset = start;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  while (offset < (end ?? source.size)) {
    const size = Math.min(limits.readBytes, (end ?? source.size) - offset);
    const bytes = await read(source, offset, size), newline = bytes.indexOf(10);
    const chunk = newline < 0 ? bytes : bytes.subarray(0, newline + 1);
    state.digest.update(chunk); offset += chunk.length; state.end = offset; state.complete = newline >= 0;
    try { utf8.decode(chunk, { stream: true }); }
    catch { transcriptError('TRANSCRIPT_UTF8_INVALID', 'Native transcript bytes are not valid UTF-8'); }
    yield chunk;
    if (newline >= 0) break;
  }
  try { utf8.decode(); }
  catch { transcriptError(state.complete ? 'TRANSCRIPT_UTF8_INVALID' : 'TRANSCRIPT_JSON_INVALID', 'Native UTF-8 text is incomplete'); }
}

/** Token paths are bounded metadata. No packed string/number values or assembled
 * native objects are requested from stream-json, including for enormous rows.
 */
export async function* tokensAtPaths(chunks, limits = TRANSCRIPT_LIMITS) {
  const input = Readable.from(chunks), stream = parser.asStream({ packValues: false, streamValues: true });
  // A part budget can stop extraction mid-row. Own and await both stream ends
  // so cancellation cannot produce a later unhandled AbortError.
  const completion = pipeline(input, stream).then(() => null, error => error);
  const stack = [];
  let inKey = false, key = '', scalarPath = null, structures = 0, rootSeen = false, keyBytes = 0;
  const valuePath = () => {
    const parent = stack.at(-1);
    return parent ? [...parent.path, parent.kind === 'array' ? parent.index : parent.key] : [];
  };
  const finished = () => { const parent = stack.at(-1); if (parent?.kind === 'array') parent.index++; else if (parent) parent.key = null; };
  try {
    for await (const token of stream.iterator({ destroyOnReturn: false })) {
      const name = token.name;
      if (name === 'startKey') { inKey = true; key = ''; continue; }
      if (name === 'endKey') {
        inKey = false;
        const parent = stack.at(-1);
        if (!parent || parent.kind !== 'object' || parent.keys.has(key)) transcriptError('TRANSCRIPT_JSON_INVALID', 'Duplicate or misplaced native JSON key');
        keyBytes += Buffer.byteLength(key);
        if (keyBytes > limits.metadataBytes) transcriptError('TRANSCRIPT_METADATA_LIMIT', 'Native structural keys exceed the supported bound');
        parent.keys.add(key); parent.key = key;
        if (++structures > limits.structuralValues) transcriptError('TRANSCRIPT_STRUCTURE_LIMIT', 'Native row structure exceeds the supported bound');
        yield { name: 'key', value: key, path: [...parent.path, key] }; continue;
      }
      if (inKey && name === 'stringChunk') {
        key += token.value;
        if (Buffer.byteLength(key) > limits.keyBytes) transcriptError('TRANSCRIPT_METADATA_LIMIT', 'Native JSON key exceeds the supported bound');
        continue;
      }
      if (name === 'startObject' || name === 'startArray') {
        if (++structures > limits.structuralValues || stack.length >= limits.depth) transcriptError('TRANSCRIPT_STRUCTURE_LIMIT', 'Native row structure exceeds the supported bound');
        const at = valuePath();
        if (!stack.length) { if (rootSeen || name !== 'startObject') transcriptError('TRANSCRIPT_JSON_INVALID', 'Each native row must be one JSON object'); rootSeen = true; }
        yield { name, path: at };
        stack.push({ path: at, kind: name === 'startObject' ? 'object' : 'array', key: null, index: 0, keys: new Set() }); continue;
      }
      if (name === 'endObject' || name === 'endArray') {
        const parent = stack.pop();
        yield { name, path: parent.path }; finished(); continue;
      }
      if (name === 'startString' || name === 'startNumber') {
        scalarPath = valuePath(); yield { name, path: scalarPath }; continue;
      }
      if (name === 'stringChunk' || name === 'numberChunk') { yield { name, value: token.value, path: scalarPath }; continue; }
      if (name === 'endString' || name === 'endNumber') { yield { name, path: scalarPath }; scalarPath = null; finished(); continue; }
      if (name === 'trueValue' || name === 'falseValue' || name === 'nullValue') {
        yield { name, value: token.value, path: valuePath() }; finished(); continue;
      }
    }
    if (!rootSeen || stack.length) transcriptError('TRANSCRIPT_JSON_INVALID', 'Native row is not a complete object');
  } catch (error) {
    if (error.code?.startsWith('TRANSCRIPT_')) throw error;
    const wrapped = new Error('Native transcript row is malformed', { cause: error }); wrapped.code = 'TRANSCRIPT_JSON_INVALID'; throw wrapped;
  } finally { input.destroy(); stream.destroy(); await completion; }
}

function metadataPath(at) {
  const joined = at.join('/');
  if (/^(type|uuid|parentUuid|logicalParentUuid|sessionId|promptId|isSidechain|isMeta|turnCompanion|turnOrigin|ordinal|subtype|isCompactSummary|isVisibleInTranscriptOnly)$/.test(joined)) return true;
  if (/^turnPosition\/(promptIndex|turnIndex)$/.test(joined)) return true;
  if (/^attachment\/(type|hookName|hookEvent)$/.test(joined)) return true;
  if (/^(message|payload)\/(role|type|id|phase|stop_reason|name|call_id|thread_id|turn_id|root_turn_id|history_mode|forked_from_id|forked_from_ordinal_exclusive)$/.test(joined)) return true;
  if (/^payload\/history_base\/(thread_id|end_ordinal_exclusive|end_byte_offset)$/.test(joined)) return true;
  if (/^payload\/turn_attribution\/(turn_id|turn_trigger|parent_turn_id|initiating_agent_path|root_turn_id)$/.test(joined)) return true;
  if (/^payload\/internal_chat_message_metadata_passthrough\/turn_id$/.test(joined)) return true;
  if (/^payload\/item\/(type|id|phase)$/.test(joined)) return true;
  if (/^(message\/content|payload\/content|payload\/item\/content|payload\/output)\/\d+\/(type|id|name|path|tool_use_id|is_error)$/.test(joined)) return true;
  if (/^message\/content\/\d+\/content\/\d+\/type$/.test(joined)) return true;
  return false;
}

function contentPath(at) {
  const joined = at.join('/');
  return /^attachment\/content\/\d+$/.test(joined) || /^(message\/content|payload\/(input|arguments|output))$/.test(joined) ||
    /^(message\/content|payload\/content|payload\/item\/content|payload\/output)\/\d+\/(text|content|input)$/.test(joined) ||
    /^message\/content\/\d+\/content\/\d+\/text$/.test(joined);
}

function opaqueStringPath(at) {
  return at.length === 1 && at[0] === 'mode' || /^message\/content\/\d+\/(thinking|signature|data)$/.test(at.join('/'));
}

function digestText(hash, value, state, final = false) {
  let text = state.carry + value; state.carry = '';
  if (!final && /[\uD800-\uDBFF]$/.test(text)) { state.carry = text.slice(-1); text = text.slice(0, -1); }
  hash.update(text); state.units += text.length; state.bytes += Buffer.byteLength(text);
}

export function metaValue(row, ...at) { return row.values[JSON.stringify(at)]; }

export async function inspectNativeRow(source, start, { limits: inputLimits = {}, end } = {}) {
  assertSource(source);
  const limits = transcriptLimits(inputLimits);
  if (!Number.isSafeInteger(start) || start < 0 || start >= source.size || (end !== undefined && (!Number.isSafeInteger(end) || end <= start || end > source.size))) {
    transcriptError('TRANSCRIPT_SOURCE_INVALID', 'Invalid native source range');
  }
  const state = { end: start, complete: false, digest: createHash('sha256') }, values = Object.create(null), strings = Object.create(null), containers = Object.create(null), stringShapes = Object.create(null);
  let selected = null, value = '', metadataBytes = 0, count = 0, textHash = null, textState = null;
  try {
    for await (const token of tokensAtPaths(rowBytes(source, start, state, limits, end), limits)) {
      const at = JSON.stringify(token.path);
      if (['startObject', 'startArray'].includes(token.name) && (contentPath(token.path) || /^message\/content\/\d+\/input$/.test(token.path.join('/')))) {
        containers[at] = token.name === 'startObject' ? 'object' : 'array'; count++;
      }
      if (token.name === 'startString' || token.name === 'startNumber') {
        // Reasoning/signature/data and native mode bookkeeping need only a type
        // check. Never assemble, expose or separately digest their payloads.
        if (token.name === 'startString' && opaqueStringPath(token.path)) { stringShapes[at] = true; count++; }
        selected = metadataPath(token.path) ? at : null; value = '';
        textHash = token.name === 'startString' && contentPath(token.path) ? createHash('sha256') : null;
        textState = textHash ? { units: 0, bytes: 0, carry: '' } : null;
      } else if (token.name === 'stringChunk' || token.name === 'numberChunk') {
        if (selected) {
          value += token.value;
          if (Buffer.byteLength(value) + metadataBytes > limits.metadataBytes || value.length > limits.metadataBytes) transcriptError('TRANSCRIPT_METADATA_LIMIT', 'Native identity metadata exceeds the supported bound');
        }
        if (textHash) digestText(textHash, token.value, textState);
      } else if (token.name === 'endString' || token.name === 'endNumber') {
        if (selected) {
          if (token.name === 'endNumber' && (!Number.isSafeInteger(Number(value)) || Number(value) < 0)) transcriptError('TRANSCRIPT_METADATA_LIMIT', 'Native metadata positions must be nonnegative safe integers');
          values[selected] = token.name === 'endNumber' ? Number(value) : value; metadataBytes += Buffer.byteLength(value); count++;
        }
        if (textHash) { digestText(textHash, '', textState, true); strings[at] = Object.freeze({ hash: textHash.digest('hex'), units: textState.units, bytes: textState.bytes }); count++; }
        selected = null; textHash = null;
      } else if (['trueValue', 'falseValue', 'nullValue'].includes(token.name) && metadataPath(token.path)) {
        values[at] = token.name === 'nullValue' ? null : token.name === 'trueValue'; count++;
      }
      if (count > limits.metadataValues) transcriptError('TRANSCRIPT_METADATA_LIMIT', 'Too many native metadata fields');
    }
  } catch (error) {
    // A partial last line can contain incomplete JSON. It remains uncommitted.
    if (!state.complete && state.end === source.size && error.code === 'TRANSCRIPT_JSON_INVALID') return Object.freeze({ pending: true, start, end: state.end });
    throw error;
  }
  if (!state.complete) return Object.freeze({ pending: true, start, end: state.end });
  return Object.freeze({ start, end: state.end, hash: state.digest.digest('hex'), values: Object.freeze(values), strings: Object.freeze(strings), containers: Object.freeze(containers), stringShapes: Object.freeze(stringShapes) });
}

export async function* nativeRows(source, { start = 0, end = source.size, limits = {} } = {}) {
  assertSource(source);
  let offset = start;
  while (offset < end) {
    const row = await inspectNativeRow(source, offset, { limits, end });
    yield row;
    if (row.pending) return;
    offset = row.end;
  }
}

/** Re-read the exact raw row, including its newline, without assembling it. */
export async function verifyRow(source, row, { limits = {} } = {}) {
  assertSource(source); const bounded = transcriptLimits(limits), digest = createHash('sha256');
  if (!row || row.start < 0 || row.end > source.size || row.end <= row.start) transcriptError('TRANSCRIPT_SOURCE_CHANGED', 'The native anchor is outside this source');
  for (let offset = row.start; offset < row.end;) {
    const bytes = await read(source, offset, Math.min(bounded.readBytes, row.end - offset)); digest.update(bytes); offset += bytes.length;
  }
  if (digest.digest('hex') !== row.hash) transcriptError('TRANSCRIPT_SOURCE_CHANGED', 'The retained native row hash changed');
}

export function rowTokenStream(source, row, limits = TRANSCRIPT_LIMITS) {
  const state = { digest: createHash('sha256'), end: row.start, complete: false };
  return tokensAtPaths(rowBytes(source, row.start, state, limits, row.end), limits);
}
