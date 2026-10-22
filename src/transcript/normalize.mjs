import { createHash } from 'node:crypto';
import { validateCheckpoint, nativeId } from './checkpoint.mjs';
import { classifyNativeRow, extractNativeFields } from './native.mjs';
import { inspectNativeRow, transcriptLimits, transcriptError, verifyRow, assertSource, metaValue } from './source.mjs';

const anchor = (row, rowId) => ({ start: row.start, end: row.end, hash: row.hash,
  rowId: rowId ?? (metaValue(row, 'ordinal') !== undefined ? `ordinal:${metaValue(row, 'ordinal')}` : `offset:${row.start}`) });
const nativeOptions = (source, row, options, currentPromptId = null, currentRowId = null) => ({ ...options, currentPromptId, currentRowId,
  sessionId: typeof source.nativeSessionIdAt === 'function' ? nativeId(source.nativeSessionIdAt(row.start)) : options.sessionId,
  historyVerified: source.historyResolved === true });
const checkpoint = state => validateCheckpoint(state, { client: state.client, sessionId: state.sessionId });
const freeze = value => {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
};

function controls(input) {
  if (!Array.isArray(input) || input.length > 4096) transcriptError('TRANSCRIPT_COMMAND_INVALID', 'Verified native controls must be a bounded array');
  const prompts = new Set(), rows = new Set();
  input.forEach(item => {
    if (!item || !['track', 'untrack', 'process', 'process project', 'save', 'skip', 'status'].includes(item.action)) transcriptError('TRANSCRIPT_COMMAND_INVALID', 'Unsupported verified control');
    const promptId = nativeId(item.promptId);
    if (item.rowId === undefined) prompts.add(promptId);
    else rows.add(JSON.stringify([promptId, nativeId(item.rowId)]));
  });
  return { prompts, rows };
}

function completionSignal(value) {
  if (value === null) return null;
  if (!value || !['completed', 'interrupted', 'failed', 'observed'].includes(value.kind) ||
      (value.finalTextHash !== undefined && value.finalTextHash !== null && !/^[a-f0-9]{64}$/.test(value.finalTextHash))) {
    transcriptError('TRANSCRIPT_COMPLETION_INVALID', 'Invalid native completion expectation');
  }
  return { promptId: nativeId(value.promptId), kind: value.kind, finalTextHash: value.finalTextHash ?? null };
}

async function verify(source, row, limits) {
  if (typeof source.verify === 'function') await source.verify(row);
  else await verifyRow(source, row, { limits });
}

async function terminalMatches(source, row, classified, signal, limits) {
  if (!signal?.finalTextHash) return true;
  const fields = classified.fields.filter(field => field.kind === 'assistant'), digest = createHash('sha256');
  let carry = '';
  for await (const chunk of extractNativeFields(source, row, fields, { limits })) {
    if (chunk.type === 'text') {
      let text = carry + chunk.text; carry = '';
      if (/[\uD800-\uDBFF]$/.test(text)) { carry = text.slice(-1); text = text.slice(0, -1); }
      digest.update(text);
    } else if (chunk.type === 'end') { digest.update(carry); carry = ''; }
  }
  return digest.digest('hex') === signal.finalTextHash;
}

function prefixByBytes(text, budget) {
  let bytes = 0, units = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > budget) break;
    bytes += size; units += point.length;
  }
  return { text: text.slice(0, units), bytes, units };
}

function safeCut(text, units) {
  let end = Math.min(units, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  if (!end && text.length) end = Math.min(2, text.length);
  return end;
}

function emissionPosition(state, row, classified, fieldIndex, textOffset, until, supplement, done = false) {
  const rowDone = done && fieldIndex + 1 >= classified.fields.length;
  const offset = rowDone ? row.end : row.start;
  return checkpoint({ ...state, offset, scanOffset: Math.max(state.scanOffset, until), anchor: anchor(row, classified.rowId),
    cursor: offset >= until ? null : { until, rowStart: offset, fieldIndex: rowDone ? 0 : fieldIndex + (done ? 1 : 0), textOffset: done ? 0 : textOffset, supplement } });
}

async function* emitRange(source, initial, until, options) {
  const { limits, completion } = options;
  let state = initial, offset = initial.cursor?.rowStart ?? initial.offset;
  const supplement = initial.cursor?.supplement ?? false;
  const unitsPerFragment = Math.max(1, Math.floor((limits.partBytes - 4096) / 6));
  while (offset < until) {
    const row = await inspectNativeRow(source, offset, { limits, end: until });
    if (row.pending) transcriptError('TRANSCRIPT_SOURCE_CHANGED', 'A planned complete native row became incomplete');
    const rowOptions = nativeOptions(source, row, options, state.exchange?.promptId, state.exchange?.id);
    const classified = classifyNativeRow(row, rowOptions);
    await verify(source, row, limits);
    if (classified.kind === 'ignore' || !classified.fields?.length) {
      state = checkpoint({ ...state, offset: row.end, anchor: anchor(row, classified.rowId), cursor: row.end >= until ? null : {
        until, rowStart: row.end, fieldIndex: 0, textOffset: 0, supplement } });
      yield { type: 'advance', after: state }; offset = row.end; continue;
    }
    const resumeField = initial.cursor?.rowStart === row.start ? initial.cursor.fieldIndex : 0;
    const resumeText = initial.cursor?.rowStart === row.start ? initial.cursor.textOffset : 0;
    if (resumeField >= classified.fields.length || (classified.fields[resumeField].total !== null && resumeText > classified.fields[resumeField].total)) {
      transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'The streaming cursor is outside its exact native field');
    }
    let text = '', fieldStart = 0, position = 0, retainedBytes = 0, inputCarry = '', outputAllowance = 0, selected;
    for await (const item of extractNativeFields(source, row, classified.fields, { limits })) {
      const index = item.fieldIndex;
      selected = classified.fields[index];
      if (item.type === 'start') {
        text = ''; position = 0; retainedBytes = 0; inputCarry = ''; fieldStart = 0;
        outputAllowance = selected.kind === 'tool-result' ? Math.max(0, limits.toolOutputBytes - classified.fields.slice(0, index)
          .filter(field => field.kind === 'tool-result').reduce((sum, field) => sum + field.bytes, 0)) : Infinity;
        continue;
      }
      if (item.type === 'text' || item.type === 'end') {
        let incoming = inputCarry + (item.text ?? ''); inputCarry = '';
        if (item.type !== 'end' && /[\uD800-\uDBFF]$/.test(incoming)) { inputCarry = incoming.slice(-1); incoming = incoming.slice(0, -1); }
        if (selected.kind === 'tool-result') {
          const kept = prefixByBytes(incoming, Math.max(0, outputAllowance - retainedBytes)); incoming = kept.text; retainedBytes += kept.bytes;
        }
        if (index < resumeField) { position += incoming.length; continue; }
        if (index === resumeField && position < resumeText) {
          const skip = Math.min(incoming.length, resumeText - position); incoming = incoming.slice(skip); position += skip;
        }
        if (!text) fieldStart = position;
        text += incoming;
        while (text.length >= unitsPerFragment && (text.length > unitsPerFragment || item.type === 'end')) {
          const length = safeCut(text, unitsPerFragment), fragment = text.slice(0, length); text = text.slice(length); position += length;
          const after = emissionPosition(state, row, classified, index, position, until, supplement);
          yield { type: 'segment', segment: { kind: selected.kind, rowId: classified.rowId, blockIndex: selected.blockIndex,
            field: selected.path, callId: selected.callId, tool: selected.tool, format: selected.format,
            source: { ...anchor(row, classified.rowId), nativeSessionId: rowOptions.sessionId }, range: { unit: 'utf16', start: fieldStart, end: position, total: selected.total }, text: fragment }, notices: [], after };
          state = after; fieldStart = position;
        }
        if (item.type === 'end') {
          if (index === resumeField && position + text.length < resumeText) transcriptError('TRANSCRIPT_CHECKPOINT_INVALID', 'The streaming cursor is outside its exact native field');
          position += text.length;
          const notices = selected.omittedType ? [{ kind: 'non-text-content-omitted', rowId: classified.rowId,
            blockIndex: selected.blockIndex, field: selected.path, contentType: selected.omittedType }] : selected.kind === 'tool-result' && selected.bytes > retainedBytes ? [{ kind: 'tool-output-clipped', rowId: classified.rowId,
            blockIndex: selected.blockIndex, field: selected.path, originalBytes: selected.bytes, retainedBytes,
            omittedBytes: selected.bytes - retainedBytes }] : [];
          const after = emissionPosition(state, row, classified, index, position, until, supplement, true);
          if (text || notices.length || (selected.total === 0 && resumeText === 0)) {
            yield { type: 'segment', segment: { kind: selected.kind, rowId: classified.rowId, blockIndex: selected.blockIndex,
              field: selected.path, callId: selected.callId, tool: selected.tool, format: selected.format, source: { ...anchor(row, classified.rowId), nativeSessionId: rowOptions.sessionId },
              range: { unit: 'utf16', start: fieldStart, end: position, total: selected.total }, text }, notices, after };
          } else yield { type: 'advance', after };
          state = after; text = '';
        }
      }
    }
    offset = row.end;
  }
  yield { type: 'advance', after: checkpoint({ ...state, offset: until, scanOffset: until, cursor: null }) };
}

/** Stream normalized main-conversation parts from a caller-verified source.
 * Publish each part durably before its accompanying checkpoint, and make queued
 * parts processable only after that checkpoint is durable. No queue I/O occurs
 * here. A stop boundary is preflighted before any conversation part is yielded.
 */
export async function* normalizeTranscript(source, { client, sessionId, checkpoint: input = null, completion: signal = null,
  beforePromptId = null, beforeRowId = null, commands = [], classifyCommand = null, limits: inputLimits = {} } = {}) {
  assertSource(source);
  if (classifyCommand !== null && typeof classifyCommand !== 'function') transcriptError('TRANSCRIPT_COMMAND_INVALID', 'Historical command classification requires a trusted callback');
  const limits = transcriptLimits(inputLimits), excluded = controls(commands), completion = completionSignal(signal);
  let state = validateCheckpoint(input, { client, sessionId }), rows = 0, parts = 0;
  const options = { client: state.client, sessionId: state.sessionId, completion, limits };
  if (state.offset > source.size || state.scanOffset > source.size) transcriptError('TRANSCRIPT_SOURCE_CHANGED', 'The retained source position no longer exists');
  if (state.anchor) await verify(source, state.anchor, limits);
  try {
    let end = source.size;
    if (beforePromptId !== null) {
      const retainedAnchor = state.anchor;
      nativeId(beforePromptId);
      if (beforeRowId !== null) nativeId(beforeRowId);
      let boundary = state.boundary?.promptId === beforePromptId && state.boundary.rowId === beforeRowId ? state.boundary :
        { promptId: beforePromptId, rowId: beforeRowId, scanOffset: 0, start: null, matches: 0, scanPromptId: null };
      if (boundary.matches > 1) { yield { type: 'pending', reason: 'TRANSCRIPT_BOUNDARY_AMBIGUOUS', checkpoint: state }; return; }
      if (boundary.start === null || (beforeRowId === null && boundary.scanOffset < source.size)) {
        for (let position = boundary.scanOffset; position < source.size;) {
          const row = await inspectNativeRow(source, position, { limits });
          if (row.pending) { yield { type: 'pending', reason: 'TRANSCRIPT_BOUNDARY_PENDING', checkpoint: state }; return; }
          const classified = classifyNativeRow(row, nativeOptions(source, row, options, boundary.scanPromptId));
          const match = classified.kind === 'human' && classified.promptId === beforePromptId && (beforeRowId === null || classified.rowId === beforeRowId);
          boundary = { promptId: beforePromptId, rowId: beforeRowId, scanOffset: row.end, start: match && boundary.start === null ? row.start : boundary.start,
            matches: Math.min(2, boundary.matches + Number(match)),
            scanPromptId: classified.kind === 'human' ? classified.promptId : boundary.scanPromptId };
          state = checkpoint({ ...state, boundary, anchor: anchor(row, classified.rowId) });
          if (boundary.matches > 1) { yield { type: 'pending', reason: 'TRANSCRIPT_BOUNDARY_AMBIGUOUS', checkpoint: state }; return; }
          if (beforeRowId !== null && boundary.start !== null) break;
          position = row.end;
          if (++rows >= limits.rows) { yield { type: 'pending', reason: 'TRANSCRIPT_BOUNDARY_PENDING', checkpoint: state }; return; }
        }
      }
      if (boundary.start === null) { yield { type: 'pending', reason: 'TRANSCRIPT_BOUNDARY_PENDING', checkpoint: state }; return; }
      end = boundary.start;
      // A continuously tracked collector may commit beyond this command before
      // its detached dispatcher publishes the tracking change. The verified
      // boundary still stops this pass immediately. Preserve that earlier
      // publication and any streaming cursor; neither rewind nor replay it.
      if (state.offset > end) {
        yield { type: 'checkpoint', checkpoint: checkpoint({ ...state, anchor: retainedAnchor }) }; return;
      }
      if (state.cursor && state.cursor.until > end) transcriptError('TRANSCRIPT_BOUNDARY_CONFLICT', 'The stop boundary crosses retained collection');
    } else {
      if (beforeRowId !== null) transcriptError('TRANSCRIPT_BOUNDARY_CONFLICT', 'A row boundary requires its native prompt identity');
      if (state.boundary !== null) state = checkpoint({ ...state, boundary: null });
    }
    while (state.offset < end) {
      if (!state.cursor) {
        let until = null, position = state.scanOffset, mismatchedFinal = false;
        for (; position < end;) {
          const row = await inspectNativeRow(source, position, { limits, end });
          if (row.pending) { yield { type: 'pending', reason: 'TRANSCRIPT_TAIL_PENDING', checkpoint: state }; return; }
          const rowOptions = nativeOptions(source, row, options, state.exchange?.promptId, state.exchange?.id);
          const classified = classifyNativeRow(row, rowOptions);
          if (classified.kind === 'human') {
            if (state.exchange && !state.exchange.completed && state.exchange.id !== classified.rowId) {
              const outcome = completion?.promptId === state.exchange.promptId && ['interrupted', 'failed'].includes(completion.kind) ? completion.kind : 'observed';
              until = row.start; state = checkpoint({ ...state, exchange: { ...state.exchange, completed: true, outcome }, scanOffset: until }); break;
            }
            if (state.exchange?.completed && state.exchange.id !== classified.rowId && state.offset < row.start) {
              until = row.start; break;
            }
            if (!state.exchange || state.exchange.id !== classified.rowId) {
              let isControl = excluded.rows.has(JSON.stringify([classified.promptId, classified.rowId])) ||
                (classifyCommand === null && excluded.prompts.has(classified.promptId));
              if (classifyCommand !== null) {
                const recognized = await classifyCommand(source, row, { client: state.client, sessionId: rowOptions.sessionId, collectionSessionId: state.sessionId });
                if (recognized?.pending) {
                  if (typeof recognized.pending !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(recognized.pending)) transcriptError('TRANSCRIPT_COMMAND_INVALID', 'Invalid command-classifier pending result');
                  yield { type: 'pending', reason: recognized.pending, checkpoint: state }; return;
                }
                if (recognized !== null) {
                  if (!recognized || recognized.promptId !== classified.promptId || recognized.rowId !== classified.rowId ||
                      !['track', 'untrack', 'process', 'process project', 'save', 'skip', 'status'].includes(recognized.action) ||
                      !Array.isArray(recognized.anchors) || recognized.anchors.length < 1 || recognized.anchors.length > 2) {
                    transcriptError('TRANSCRIPT_COMMAND_INVALID', 'Historical command proof does not match this exact native human input');
                  }
                  for (const proof of recognized.anchors) await verify(source, proof, limits);
                  isControl = true;
                  // The native row can persist before its detached command
                  // worker changes tracking. Do not admit anything after an
                  // opt-out while that dispatch is pending. A later explicit
                  // tracking boundary authorizes historical catch-up instead.
                  if (recognized.action === 'untrack' && beforePromptId === null) {
                    state = checkpoint({ ...state, offset: row.start, scanOffset: row.start, anchor: anchor(row, classified.rowId) });
                    yield { type: 'pending', reason: 'TRANSCRIPT_UNTRACK_PENDING', checkpoint: state }; return;
                  }
                }
              }
              state = checkpoint({ ...state, offset: row.start, scanOffset: row.start, anchor: anchor(row, classified.rowId), exchange: {
                id: classified.rowId, promptId: classified.promptId, nextPart: 0, excluded: isControl, completed: false, start: row.start, outcome: null } });
            }
          }
          const inspected = anchor(row, classified.rowId);
          if (!state.exchange || state.exchange.excluded) {
            state = checkpoint({ ...state, offset: row.end, scanOffset: row.end, anchor: inspected,
              exchange: state.exchange?.excluded ? { ...state.exchange, completed: true, outcome: 'completed' } : state.exchange });
            yield { type: 'checkpoint', checkpoint: state }; position = row.end;
          } else if (state.exchange.completed) {
            until = row.end; state = checkpoint({ ...state, scanOffset: until }); break;
          } else if (classified.terminal) {
            const matchingSignal = completion?.promptId === state.exchange.promptId ? completion : null;
            if (!(await terminalMatches(source, row, classified, matchingSignal, limits))) {
              // A later persisted final row may satisfy the native expectation.
              // Keep this row as observed content and continue reconciliation.
              mismatchedFinal = true;
              state = checkpoint({ ...state, scanOffset: row.end, anchor: inspected }); position = row.end;
              if (++rows >= limits.rows) { yield { type: 'pending', reason: 'TRANSCRIPT_FINAL_TEXT_PENDING', checkpoint: state }; return; }
              continue;
            }
            until = row.end; state = checkpoint({ ...state, scanOffset: until, exchange: { ...state.exchange, completed: true, outcome: 'completed' } }); break;
          } else { state = checkpoint({ ...state, scanOffset: row.end, anchor: inspected }); position = row.end; }
          if (++rows >= limits.rows) { yield { type: 'pending', reason: 'TRANSCRIPT_SCAN_PENDING', checkpoint: state }; return; }
        }
        if (until === null && state.exchange && !state.exchange.completed && completion?.promptId === state.exchange.promptId && ['interrupted', 'failed', 'observed'].includes(completion.kind)) {
          until = position; state = checkpoint({ ...state, scanOffset: until, exchange: { ...state.exchange, completed: true, outcome: completion.kind } });
        }
        if (until === null && state.exchange && !state.exchange.completed && state.boundary?.start === end) {
          until = end; state = checkpoint({ ...state, scanOffset: until, exchange: { ...state.exchange, completed: true, outcome: 'observed' } });
        }
        if (until === null) {
          if (state.offset < end) yield { type: 'pending', reason: mismatchedFinal ? 'TRANSCRIPT_FINAL_TEXT_PENDING' : 'TRANSCRIPT_COMPLETION_PENDING', checkpoint: state };
          else yield { type: 'checkpoint', checkpoint: state };
          return;
        }
        if (until === state.offset) continue;
        state = checkpoint({ ...state, scanOffset: Math.max(state.scanOffset, until), cursor: { until, rowStart: state.offset, fieldIndex: 0, textOffset: 0,
          supplement: state.exchange.nextPart > 0 } });
      }
      let segments = [], notices = [], bufferedAfter = state, partIndex = state.exchange.nextPart;
      const supplement = state.cursor.supplement;
      const makePart = (items, omitted) => ({ schemaVersion: 1, client: state.client, sessionId: state.sessionId,
        exchangeId: state.exchange.id, partIndex, supplement, outcome: state.exchange.outcome, segments: items, notices: omitted });
      const publication = after => checkpoint({ ...after, exchange: { ...after.exchange, nextPart: partIndex + 1 } });
      for await (const item of emitRange(source, state, state.cursor.until, options)) {
        if (item.type === 'segment') {
          const candidate = makePart([...segments, item.segment], [...notices, ...item.notices]);
          if (Buffer.byteLength(JSON.stringify(candidate)) > limits.partBytes && segments.length) {
            const part = freeze(makePart(segments, notices)), next = publication(bufferedAfter);
            await verify(source, next.anchor, limits);
            yield { type: 'part', part, checkpoint: next }; parts++; partIndex++; state = next; segments = []; notices = [];
            if (parts >= limits.parts) return;
          }
          if (Buffer.byteLength(JSON.stringify(makePart([item.segment], item.notices))) > limits.partBytes) transcriptError('TRANSCRIPT_PART_LIMIT', 'The configured part budget cannot hold native identity metadata');
          segments.push(item.segment); notices.push(...item.notices);
        }
        bufferedAfter = item.after;
      }
      if (segments.length) {
        const part = freeze(makePart(segments, notices)), next = publication(bufferedAfter);
        await verify(source, next.anchor, limits);
        yield { type: 'part', part, checkpoint: next }; state = next; parts++;
        if (parts >= limits.parts) return;
      } else { state = checkpoint({ ...bufferedAfter, exchange: { ...bufferedAfter.exchange, nextPart: partIndex } }); yield { type: 'checkpoint', checkpoint: state }; }
    }
    yield { type: 'checkpoint', checkpoint: state };
  } catch (error) {
    if (['TRANSCRIPT_NATIVE_UNSUPPORTED', 'TRANSCRIPT_HISTORY_REQUIRED', 'TRANSCRIPT_JSON_INVALID', 'TRANSCRIPT_UTF8_INVALID', 'TRANSCRIPT_METADATA_LIMIT', 'TRANSCRIPT_STRUCTURE_LIMIT', 'TRANSCRIPT_PART_LIMIT'].includes(error.code)) {
      yield { type: 'pending', reason: error.code, checkpoint: state }; return;
    }
    throw error;
  }
}
