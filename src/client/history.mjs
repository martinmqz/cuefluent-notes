import { createHash } from 'node:crypto';
import { inspectNativeRow, metaValue as value, assertSource, verifyRow, rowTokenStream, transcriptError, transcriptLimits } from '../transcript/source.mjs';
import { validateCheckpoint, nativeId } from '../transcript/checkpoint.mjs';

const MAX_SOURCES = 32;
const pending = reason => Object.freeze({ status: 'pending', reason });

/** The native expansion hook generates this nonce, never a model/tool argument.
 * Return the exact string in hookSpecificOutput.additionalContext for
 * hookEventName UserPromptExpansion. The nonce may double as the opaque result
 * handle. It belongs only to this invocation; no command-history registry.
 */
export function buildClaudeCommandContext(nonce) {
  if (typeof nonce !== 'string' || !(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce) ||
      /^[A-Za-z0-9_-]{86}$/.test(nonce) && Buffer.from(nonce, 'base64url').toString('base64url') === nonce)) {
    transcriptError('HISTORY_CONTEXT_INVALID', 'A fresh unpredictable invocation nonce is required');
  }
  return `Cuefluent Notes invocation: ${nonce}`;
}

async function singleContext(source, row, limits) {
  const base = ['attachment', 'content']; let count = 0;
  for await (const token of rowTokenStream(source, row, limits)) {
    if (token.path.length === 3 && base.every((part, index) => token.path[index] === part) &&
        ['startString', 'startNumber', 'startArray', 'startObject', 'trueValue', 'falseValue', 'nullValue'].includes(token.name)) {
      if (token.name !== 'startString' || ++count > 1 || token.path[2] !== 0) return false;
    }
    if (token.name === 'endArray' && token.path.length === 2 && base.every((part, index) => token.path[index] === part)) return count === 1;
  }
  return false;
}

/** Find the current authorized Claude command on a copied-history fork. The
 * trusted hook's unpredictable context nonce is persisted as an attachment
 * parented to the native expansion, immediately after expansion + wrapper.
 * Only that exact native three-row chain selects a boundary; ordinary text and
 * api-request snapshots containing the nonce are irrelevant. Scan in bounded
 * chunks with two metadata rows of lookbehind, never an identity/history index.
 * This does not authorize a command: the hook envelope already did so.
 */
export async function resolveClaudeCommandBoundary(source, { sessionId, promptId, nonce, classifyCommand, limits: inputLimits = {} } = {}) {
  assertSource(source); nativeId(sessionId); nativeId(promptId);
  if (typeof classifyCommand !== 'function') transcriptError('HISTORY_CONTEXT_INVALID', 'The current command requires its installed-skill classifier');
  const context = buildClaudeCommandContext(nonce), expected = createHash('sha256').update(context).digest('hex'), limits = transcriptLimits(inputLimits);
  let previous = null, beforePrevious = null, matched = null;
  for (let offset = 0; offset < source.size;) {
    const row = await inspectNativeRow(source, offset, { limits });
    if (row.pending) return pending('HISTORY_COMMAND_BOUNDARY_PENDING');
    const text = row.strings[JSON.stringify(['attachment', 'content', 0])];
    if (value(row, 'type') === 'attachment' && value(row, 'attachment', 'type') === 'hook_additional_context' &&
        value(row, 'attachment', 'hookName') === 'UserPromptExpansion' && value(row, 'attachment', 'hookEvent') === 'UserPromptExpansion' &&
        value(row, 'isSidechain') !== true && value(row, 'sessionId') === sessionId && text?.hash === expected && text.units === context.length &&
        await singleContext(source, row, limits)) {
      if (!previous || !beforePrevious || value(previous, 'uuid') !== value(row, 'parentUuid') ||
          value(previous, 'sessionId') !== sessionId || value(previous, 'promptId') !== promptId ||
          value(previous, 'parentUuid') !== value(beforePrevious, 'uuid')) return pending('HISTORY_COMMAND_PROOF_PENDING');
      const proof = await classifyCommand(source, beforePrevious, { client: 'claude', sessionId, collectionSessionId: sessionId });
      if (proof?.pending || !proof || proof.promptId !== promptId || proof.rowId !== value(beforePrevious, 'uuid') ||
          !['track', 'untrack', 'process', 'process project', 'save', 'skip', 'status'].includes(proof.action) ||
          !Array.isArray(proof.anchors) || proof.anchors.length !== 2 ||
          !proof.anchors.every((item, index) => item.start === [beforePrevious, previous][index].start &&
            item.end === [beforePrevious, previous][index].end && item.hash === [beforePrevious, previous][index].hash)) return pending('HISTORY_COMMAND_PROOF_PENDING');
      if (matched) return pending('HISTORY_COMMAND_BOUNDARY_AMBIGUOUS');
      matched = Object.freeze({ status: 'ready', beforePromptId: promptId, beforeRowId: nativeId(proof.rowId), action: proof.action,
        anchors: Object.freeze([beforePrevious, previous, row].map(item => Object.freeze({ start: item.start, end: item.end, hash: item.hash }))) });
    }
    beforePrevious = previous; previous = row; offset = row.end;
  }
  if (!matched) return pending('HISTORY_COMMAND_BOUNDARY_PENDING');
  await source.verify?.();
  for (const inspected of matched.anchors) await verifyRow(source, inspected, { limits });
  return matched;
}

function position(input) {
  if (!Number.isSafeInteger(input) || input < 0) transcriptError('HISTORY_CONTEXT_INVALID', 'Native history boundaries must be nonnegative safe integers');
  return input;
}

async function read(source, offset, length) {
  const bytes = await source.read(offset, length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) transcriptError('TRANSCRIPT_SOURCE_CHANGED', 'A native historical source no longer matches its inspected size');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function digest(source, end = source.size) {
  const hash = createHash('sha256');
  for (let offset = 0; offset < end;) {
    const bytes = await read(source, offset, Math.min(65536, end - offset)); hash.update(bytes); offset += bytes.length;
  }
  return hash.digest('hex');
}

async function lastRow(source, end, limits) {
  if (!end || end > source.size || (await read(source, end - 1, 1))[0] !== 10) transcriptError('HISTORY_BOUNDARY_INVALID', 'The native history cutoff must end at a durable complete JSONL row');
  let cursor = end - 1, start = 0;
  while (cursor > 0) {
    const from = Math.max(0, cursor - limits.readBytes), bytes = await read(source, from, cursor - from), index = bytes.lastIndexOf(10);
    if (index >= 0) { start = from + index + 1; break; }
    cursor = from;
  }
  const row = await inspectNativeRow(source, start, { end, limits });
  if (row.pending || row.end !== end) transcriptError('HISTORY_BOUNDARY_INVALID', 'The native history cutoff does not identify a complete row');
  return row;
}

async function release(sources) {
  const results = await Promise.allSettled([...sources].map(source => source.close?.()));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Native historical source release failed');
}

async function composite(active, segments, history, owned) {
  let size = 0;
  const ranges = segments.map(segment => {
    const length = segment.end - segment.start;
    if (length < 0 || !Number.isSafeInteger(size + length)) transcriptError('HISTORY_CONTEXT_INVALID', 'Native history exceeds safe source positions');
    const result = Object.freeze({ ...segment, from: size, to: size + length }); size += length; return result;
  });
  const physical = [...new Set(ranges.map(range => range.source))];
  const verifiedPhysical = physical.filter(item => typeof item.verify === 'function');
  const needsDigest = verifiedPhysical.length !== physical.length;
  const verifyPhysical = () => Promise.all(verifiedPhysical.map(item => item.verify()));
  let closed = false, verifiedAnchor = null;
  const source = {
    size, identity: active.identity, historyResolved: true, history: Object.freeze(history),
    nativeSessionIdAt(offset) {
      position(offset);
      const segment = ranges.find(item => offset >= item.from && offset < item.to);
      if (!segment) transcriptError('HISTORY_CONTEXT_INVALID', 'The native position is outside the resolved history');
      return segment.sessionId;
    },
    async read(offset, length) {
      if (closed || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536 || offset + length > size) {
        transcriptError('TRANSCRIPT_SOURCE_INVALID', 'Invalid resolved-history source read');
      }
      const bytes = Buffer.alloc(length); let copied = 0;
      while (copied < length) {
        const at = offset + copied, segment = ranges.find(item => at >= item.from && at < item.to);
        const count = Math.min(length - copied, segment.to - at);
        bytes.set(await read(segment.source, segment.start + at - segment.from, count), copied); copied += count;
      }
      return bytes;
    },
    async verify(anchor) {
      if (closed) transcriptError('TRANSCRIPT_SOURCE_INVALID', 'The resolved historical source has been released');
      await verifyPhysical();
      // A physical capability proves its entire immutable inspected prefix.
      // Rehashing the same concatenated history per part would make progress
      // proportional to history length times the number of emitted parts.
      if (needsDigest && await digest(source) !== source.hash) transcriptError('TRANSCRIPT_SOURCE_CHANGED', 'The resolved native history prefix changed');
      if (anchor && (!verifiedAnchor || anchor.start !== verifiedAnchor.start || anchor.end !== verifiedAnchor.end || anchor.hash !== verifiedAnchor.hash)) {
        await verifyRow(source, anchor);
        await verifyPhysical();
        if (needsDigest && await digest(source) !== source.hash) transcriptError('TRANSCRIPT_SOURCE_CHANGED', 'The resolved native history prefix changed');
        verifiedAnchor = { start: anchor.start, end: anchor.end, hash: anchor.hash };
      }
    },
    async close() { if (!closed) { closed = true; await release(owned); } },
  };
  // Verified physical sources already protect every byte of their inspected
  // prefixes. A composite digest is needed only for unverified test/providers.
  source.hash = needsDigest ? await digest(source) : null;
  await verifyPhysical();
  return Object.freeze(source);
}

/** Resolve only sources supplied by native authority. resolveSource is injected:
 * ({client,sessionId,before:{ordinalExclusive,byteOffset},excludeIdentity}) ->
 * verified physical source or null. It must not choose by newest filename.
 * The returned source owns acquired ancestors; close it and separately close
 * the borrowed active source. All reads stay bounded and no files are created.
 * `automatic` excludes verified inherited history; `manual` includes it.
 * Claude's observed fork hook does not identify the inherited cutoff. A supplied
 * inheritedBoundary requires independent native authority; an observed EOF or
 * matching rewritten promptId is not that authority. UserPromptExpansion also
 * lacks a row UUID: historical command provenance alone cannot select its
 * current invocation when copied human rows share the new promptId. Pass an
 * exact beforeRowId to normalization only when native evidence proves it.
 */
export async function resolveNativeHistory(active, { client, sessionId, mode = 'manual', startSource = 'startup', resolveSource,
  inheritedBoundary = null, limits: inputLimits = {} } = {}) {
  assertSource(active); nativeId(sessionId);
  if (!['claude', 'codex'].includes(client) || !['manual', 'automatic'].includes(mode) || !['prompt', 'startup', 'resume', 'fork', 'clear', 'compact'].includes(startSource)) {
    transcriptError('HISTORY_CONTEXT_INVALID', 'Unsupported native history context');
  }
  const limits = transcriptLimits(inputLimits), owned = new Set(), seen = new Set();
  let omittedInherited = 0;
  try {
    if (!active.size) return pending('HISTORY_SOURCE_PENDING');
    if (client === 'claude') {
      let identified = false, inspectedRows = 0;
      for (let offset = 0; offset < active.size && inspectedRows++ < limits.rows;) {
        const row = await inspectNativeRow(active, offset, { limits });
        if (row.pending) return pending('HISTORY_SOURCE_PENDING');
        const id = value(row, 'sessionId');
        if (id !== undefined) {
          if (id !== sessionId) return pending('HISTORY_IDENTITY_MISMATCH');
          identified = true; break;
        }
        offset = row.end;
      }
      if (!identified) return pending('HISTORY_SOURCE_IDENTITY_PENDING');
      let start = 0;
      if (mode === 'automatic' && startSource === 'fork') {
        if (!inheritedBoundary) return pending('HISTORY_INHERITED_BOUNDARY_UNKNOWN');
        const end = position(inheritedBoundary.endByteOffset);
        if (end > active.size || typeof inheritedBoundary.hash !== 'string' || !/^[a-f0-9]{64}$/.test(inheritedBoundary.hash) ||
            await digest(active, end) !== inheritedBoundary.hash) transcriptError('HISTORY_BOUNDARY_INVALID', 'The trusted inherited prefix no longer matches its exact hash');
        if (end) {
          await lastRow(active, end, limits);
          const inspected = inheritedBoundary.anchor;
          if (!inspected || inspected.end > end) transcriptError('HISTORY_BOUNDARY_INVALID', 'The inherited prefix requires its inspected native anchor');
          await verifyRow(active, inspected, { limits });
          const row = await inspectNativeRow(active, inspected.start, { end: inspected.end, limits });
          if (value(row, 'uuid') !== nativeId(inspected.rowId) || value(row, 'sessionId') !== sessionId) transcriptError('HISTORY_BOUNDARY_INVALID', 'The inherited prefix anchor has another native identity');
        } else if (inheritedBoundary.anchor !== null) transcriptError('HISTORY_BOUNDARY_INVALID', 'An empty inherited prefix has no native anchor');
        start = end; omittedInherited = end;
      }
      const source = await composite(active, [{ source: active, start, end: active.size, sessionId }],
        { client, sessionId, mode, kind: 'claude-selected-linear', sources: 1, omittedInheritedBytes: omittedInherited }, owned);
      return Object.freeze({ status: 'ready', source, history: source.history });
    }
    async function build(source, id, end, before = null, depth = 0) {
      assertSource(source);
      if (depth >= MAX_SOURCES || !end || end > source.size) transcriptError('HISTORY_BOUNDARY_INVALID', 'Native history source chain is invalid or too deep');
      // Inspect the physical header before applying a requested historical cut.
      // A malformed cutoff must not turn a valid header into partial JSON.
      const header = await inspectNativeRow(source, 0, { limits });
      if (header.pending) transcriptError('HISTORY_SOURCE_PENDING', 'The native history header is not yet durable');
      if (value(header, 'type') !== 'session_meta' || value(header, 'payload', 'id') !== id) transcriptError('HISTORY_IDENTITY_MISMATCH', 'The resolved source has another native identity');
      const key = JSON.stringify([id, header.hash]);
      if (seen.has(key)) transcriptError('HISTORY_CYCLE', 'Native history resolution repeated an active source');
      if (header.end > end) transcriptError('HISTORY_BOUNDARY_INVALID', 'The native history cutoff precedes its complete source header');
      seen.add(key);
      const firstOrdinal = value(header, 'ordinal');
      if (!Number.isSafeInteger(firstOrdinal) || firstOrdinal < 0) transcriptError('HISTORY_BOUNDARY_INVALID', 'A paginated native source requires its ordinal');
      if (before) {
        const final = await lastRow(source, end, limits);
        if (value(final, 'ordinal') !== before.ordinalExclusive - 1 || firstOrdinal >= before.ordinalExclusive) {
          transcriptError('HISTORY_BOUNDARY_INVALID', 'Native history byte and ordinal cutoffs disagree');
        }
      }
      const baseId = value(header, 'payload', 'history_base', 'thread_id');
      let inherited = [];
      if (baseId !== undefined) {
        nativeId(baseId);
        const ordinalExclusive = position(value(header, 'payload', 'history_base', 'end_ordinal_exclusive'));
        const byteOffset = position(value(header, 'payload', 'history_base', 'end_byte_offset'));
        if (ordinalExclusive !== firstOrdinal || (byteOffset === 0) !== (ordinalExclusive === 0)) transcriptError('HISTORY_BOUNDARY_INVALID', 'Native header and inherited cutoff disagree');
        if (baseId !== id && (value(header, 'payload', 'forked_from_id') !== baseId ||
            value(header, 'payload', 'forked_from_ordinal_exclusive') !== ordinalExclusive)) {
          transcriptError('HISTORY_BOUNDARY_INVALID', 'The external inherited prefix lacks the matching native fork boundary');
        }
        if (byteOffset === 0) inherited = [];
        else if (mode === 'automatic' && baseId !== id) omittedInherited += byteOffset;
        else {
          if (typeof resolveSource !== 'function') transcriptError('HISTORY_SOURCE_UNAVAILABLE', 'This history requires a trusted native source resolver');
          const parent = await resolveSource(Object.freeze({ client, sessionId: baseId,
            before: Object.freeze({ ordinalExclusive, byteOffset }), excludeIdentity: source.identity ?? null }));
          if (!parent) transcriptError('HISTORY_SOURCE_UNAVAILABLE', 'The exact native historical source is unavailable');
          if (parent !== active) owned.add(parent);
          inherited = await build(parent, baseId, byteOffset, { ordinalExclusive }, depth + 1);
        }
      } else if (value(header, 'payload', 'forked_from_id') !== undefined || firstOrdinal !== 0) {
        transcriptError('HISTORY_INHERITED_BOUNDARY_UNKNOWN', 'The native source lacks its inherited history boundary');
      }
      seen.delete(key);
      return [...inherited, { source, start: 0, end, sessionId: id }];
    }
    const segments = await build(active, sessionId, active.size);
    const source = await composite(active, segments, { client, sessionId, mode, kind: 'codex-paginated', sources: segments.length,
      omittedInheritedBytes: omittedInherited }, owned);
    return Object.freeze({ status: 'ready', source, history: source.history });
  } catch (error) {
    await release(owned);
    if (['HISTORY_SOURCE_PENDING', 'HISTORY_SOURCE_UNAVAILABLE', 'HISTORY_INHERITED_BOUNDARY_UNKNOWN', 'HISTORY_BOUNDARY_INVALID', 'HISTORY_CYCLE', 'HISTORY_IDENTITY_MISMATCH'].includes(error.code)) return pending(error.code);
    throw error;
  }
}

function stableRowId(row) {
  return value(row, 'uuid') ?? value(row, 'payload', 'item', 'id') ?? value(row, 'payload', 'id') ??
    (value(row, 'ordinal') !== undefined ? `ordinal:${value(row, 'ordinal')}` : null);
}

/** Relocate an inactive bookmark before or after the same native record/hash.
 * Removed anchors, active field cursors and unresolved stop boundaries retain the
 * original checkpoint and return pending. No hashes or run selections refresh.
 */
export async function reanchorNativeCheckpoint(source, input, { client, sessionId, limits: inputLimits = {} } = {}) {
  assertSource(source);
  const original = validateCheckpoint(input, { client, sessionId }), limits = transcriptLimits(inputLimits);
  if (original.offset === 0 && original.anchor === null && original.exchange === null) return Object.freeze({ status: 'ready', checkpoint: original });
  const beforeRow = !original.exchange && original.offset === original.anchor?.start;
  if (original.cursor || original.boundary || original.scanOffset !== original.offset || (!beforeRow && original.offset !== original.anchor?.end) ||
      (original.exchange && !original.exchange.completed) || original.anchor?.rowId.startsWith('offset:')) return pending('HISTORY_REANCHOR_PENDING');
  let found = null, human = null, duplicates = false;
  for (let offset = 0; offset < source.size;) {
    const row = await inspectNativeRow(source, offset, { limits });
    if (row.pending) return pending('HISTORY_SOURCE_PENDING');
    const id = stableRowId(row);
    if (id === original.anchor.rowId && row.hash === original.anchor.hash) { if (found) duplicates = true; found = row; }
    if (original.exchange && id === original.exchange.id) { if (human) duplicates = true; human = row; }
    offset = row.end;
  }
  if (!found || (original.exchange && !human)) return pending('HISTORY_ANCHOR_MISSING');
  if (duplicates) return pending('HISTORY_ANCHOR_AMBIGUOUS');
  if (human && human.start > found.start) return pending('HISTORY_ANCHOR_MISSING');
  await source.verify?.(); await verifyRow(source, found, { limits });
  const offset = beforeRow ? found.start : found.end;
  const relocated = validateCheckpoint({ ...original, offset, scanOffset: offset,
    anchor: { ...original.anchor, start: found.start, end: found.end }, exchange: original.exchange ? { ...original.exchange, start: human.start } : null }, { client, sessionId });
  return Object.freeze({ status: 'ready', checkpoint: relocated });
}
