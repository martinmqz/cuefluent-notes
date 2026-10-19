import fs from 'node:fs/promises';
import path from 'node:path';
import { absolutePath } from './workflow-paths.mjs';
import { validateReaderCheckpoint, MAX_READER_CHECKPOINT_BYTES, checkpointPageBuilder } from './reader-checkpoint.mjs';
import { readSessionRange, decodeSessionRecord } from './session-jsonl.mjs';
import { validateSelectionState, evaluateUnitSelection, resolveSelectionAnchor, currentIntervals, SOURCE_HEADER_BYTES } from './capture-selection.mjs';
import { verifySourceCursor } from './intake-store.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { evidenceCollector } from './capture-evidence.mjs';
import { createCapture, validateCapture, assertCaptureExtension, clientVersion, captureReader } from './capture-contract.mjs';
import { SKILL_ROOT } from './runtime-paths.mjs';
import { loadClaudeProcessingSkill, claudeProcessingCommandKind, isClaudeProcessingCommand, verifyClaudeProcessingControl, isProcessingControlProof, claudeSkillArguments,
  CLAUDE_SKILL_COMMAND } from './processing-control-proof.mjs';
import { verifyProcessingExecution, isProcessingExecutionProof } from './processing-execution-proof.mjs';
import { nativeId, timestamp, canonicalJSON, fail, integer, hash, keys, isNativeId } from './workflow-values.mjs';

// The capture reader version names its evidence text rules. Every supported
// version keeps a mapping, so a published head extends under its own rules:
// 1 copies human text verbatim; 2 keeps the typed arguments of the trusted
// skill command's envelope without its markup. The skill name each version
// strips is frozen with it (2: `cuefluent-notes:cuefluent-notes`).
export const CLAUDE_READER_VERSION = '2';
export const CLAUDE_EVIDENCE_RULES = Object.freeze({ '1': 'verbatim', '2': 'skill-arguments' });
const MARKUP_SKILL_COMMAND = 'cuefluent-notes:cuefluent-notes';
// Structural checkpoint metadata (record kinds, ancestry, units) has its own
// version, unchanged by evidence text rules.
const CLAUDE_CHECKPOINT_READER = 'claude-transcript/1';
// Bump when compatibility or classification rules change. This expires only
// disposable suspensions, independently of immutable captures/checkpoints.
export const CLAUDE_READER_RULES_REVISION = 6;
// Claude CLI background sessions (CLAUDE_CODE_SESSION_KIND=bg) stamp every
// record with this kind, including the history a session moved there carries.
// Accepted only for a session verified as the continuation of a registered root
// session; any other kind, agent or sidechain keeps its ownership refusal.
export const CLAUDE_CONTINUATION_SESSION_KINDS = Object.freeze(['bg']);
export function claudeSessionKinds(value = []) {
  if (!Array.isArray(value) || value.length > 1 || value.some(kind => !CLAUDE_CONTINUATION_SESSION_KINDS.includes(kind))) fail('INVALID_WORKFLOW');
  return Object.freeze([...value]);
}
const metadataTypes = new Set(['summary', 'custom-title', 'ended-by-model', 'ai-title', 'last-prompt', 'tag',
  'agent-name', 'agent-color', 'agent-setting', 'pr-link', 'frame-link', 'artifact-comment-monitor',
  'artifact-autoreact-ledger', 'file-history-snapshot', 'file-history-delta', 'attribution-snapshot',
  'mode', 'permission-mode', 'isolation-latch', 'memory-mode', 'atis-latch', 'worktree-state', 'cost-state', 'queue-operation',
  // Claude CLI 2.1.299 API request snapshots: shapes, digests and message copies
  // of records already present as root user/assistant rows. Never human input.
  'api-request-shape', 'api-request-blob', 'api-request']);
const discontinuities = new Set(['relocated', 'continued-in', 'bridge-session', 'history-suppression',
  'content-replacement', 'fork-context-ref', 'observer-ref']);
const rootTypes = new Set(['user', 'assistant', 'system', 'attachment']);
// Claude CLI 2.1.302 writes session bookkeeping after `continued-in` (cost,
// file-history and last-prompt rows). Only such rows may follow the marker:
// known metadata of this session, never a root row, another discontinuity, a
// rewind, a queued prompt or an API request snapshot, which would carry
// conversation written after the move. One bounded window; nothing is kept.
const MARKER_TAIL_TYPES = new Set([...metadataTypes].filter(type => !['queue-operation', 'api-request-shape', 'api-request-blob', 'api-request'].includes(type)));
const MARKER_TAIL_BYTES = 64 * 1024, MARKER_TAIL_RECORDS = 64;
const markerTailRow = (row, source) => row !== null && typeof row === 'object' && MARKER_TAIL_TYPES.has(row.type) &&
  !(row.type === 'last-prompt' && row.rewound === true) && (row.sessionId === undefined || row.sessionId === source.sessionId);
/** Classify the bytes after an exact `continued-in` marker, up to the
 * authorized `endByte`: `metadata` when every complete record there is session
 * bookkeeping (or there is none), `pending` while a record is still being
 * written, and `other` for anything else or more than the bounded window. Reads
 * nothing past `endByte`; `snapshotEnd` is the file size this read observed, so
 * a caller can tell that the file has grown beyond what it may read. */
export async function readClaudeMarkerTail({ source, from, endByte, readHeader, verifyHeader, observeRead = () => {}, deadline = Infinity, now = Date.now }) {
  integer(endByte);
  const tail = await readSessionRange({ source, from, endByte, readHeader, verifyHeader, observeRead, deadline, now,
    maxBytes: MARKER_TAIL_BYTES, maxRecords: MARKER_TAIL_RECORDS });
  const kind = tail.blocked || tail.limited || tail.discarded.length || !tail.records.every(record => markerTailRow(record.value, source)) ? 'other'
    : tail.pendingTail ? 'pending' : 'metadata';
  return { kind, snapshotEnd: tail.snapshotEnd };
}
const anchor = r => ({ id: r.id, startByte: r.startByte, endByte: r.endByte, hash: r.hash });
const range = r => ({ startByte: r.startByte, endByte: r.endByte, recordIds: [r.id] });
const captureRange = r => ({ ...range(r), hash: r.hash });
const toolResult = row => row.type === 'user' && Array.isArray(row.message?.content) && row.message.content.some(b => b.type === 'tool_result');
const synthetic = row => row.isMeta === true || row.isVirtual === true || row.isVisibleInTranscriptOnly === true ||
  row.isCompactSummary === true || (row.origin !== undefined && row.origin?.kind !== 'human');
const human = row => row.type === 'user' && row.message?.role === 'user' && !toolResult(row) && !synthetic(row) &&
  row.interruptedMessageId === undefined && row.interruptedByShutdown !== true;
// The trusted skill command's envelope with nothing typed after the command
// (which Claude records without an arguments element) is markup only. Like
// empty text, it is structural input under every rule set.
const markupOnly = (row, text) => row.promptSource === undefined && claudeSkillArguments(text, MARKUP_SKILL_COMMAND) === '';
const emptyHuman = row => row.message.content === '' || markupOnly(row, row.message.content) || (Array.isArray(row.message.content) &&
  row.message.content.every(block => (block.type === 'text' && (block.text === '' || markupOnly(row, block.text))) || ['thinking', 'redacted_thinking'].includes(block.type)));

/** Claude can prepend metadata before its first native identity row (about
 * 160 KiB of API request snapshots from CLI 2.1.303). Never scan past
 * SOURCE_HEADER_BYTES. */
export async function readClaudeHeader({ readHeader, size }) {
  let offset = 0, pending = Buffer.alloc(0), prefixSessionId = null;
  while (offset < Math.min(size, SOURCE_HEADER_BYTES)) {
    const chunk = await readHeader(offset, Math.min(16 * 1024, size - offset, SOURCE_HEADER_BYTES - offset));
    if (!chunk.length) fail('SOURCE_CHANGED');
    offset += chunk.length; pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const value = decodeSessionRecord(pending.subarray(0, end)); pending = pending.subarray(end + 1);
      if (rootTypes.has(value?.type)) {
        if (prefixSessionId !== null && prefixSessionId !== value.sessionId) fail('SOURCE_IDENTITY_MISMATCH');
        return value;
      }
      if (!metadataTypes.has(value?.type) && value?.type !== 'progress') fail('UNSUPPORTED_CLAUDE_HEADER');
      if (value.sessionId !== undefined) {
        nativeId(value.sessionId);
        if (prefixSessionId !== null && prefixSessionId !== value.sessionId) fail('SOURCE_IDENTITY_MISMATCH');
        prefixSessionId = value.sessionId;
      }
    }
  }
  fail('SESSION_HEADER_UNAVAILABLE');
}
async function verifyClaudeIdentity(row, source, { header = false, sessionKinds = [] } = {}) {
  if (source.client !== 'claude' || row.sessionId !== source.sessionId) fail('SOURCE_IDENTITY_MISMATCH');
  // Resumed sessions can contain different client versions with the same format.
  clientVersion(row.version);
  if (row.isSidechain !== false || row.agentId != null || row.forkedFrom != null || row.foreignToBridgeSession != null ||
      (row.sessionKind != null && !sessionKinds.includes(row.sessionKind))) fail('UNSUPPORTED_SESSION_OWNERSHIP');
  if (header) {
    absolutePath(row.cwd);
    if (path.normalize(row.cwd) !== path.normalize(source.projectRoot) && await fs.realpath(row.cwd).catch(() => null) !== source.projectRoot) fail('SOURCE_IDENTITY_MISMATCH');
  }
  return { client: 'claude', sessionId: row.sessionId, projectRoot: source.projectRoot, version: row.version };
}
export const claudeRegistrationHeader = (selected, { sessionKinds = [] } = {}) => {
  const kinds = claudeSessionKinds(sessionKinds);
  return async io => verifyClaudeIdentity(await readClaudeHeader(io),
    { ...selected, projectRoot: await fs.realpath(selected.projectRoot) }, { header: true, sessionKinds: kinds });
};
/** The verified header identity plus its first root row, for comparing two
 * registered transcripts. The row is untrusted content; nothing is copied. */
export const claudeHeaderRow = (selected, { sessionKinds = [] } = {}) => {
  const kinds = claudeSessionKinds(sessionKinds), out = { row: null };
  const verify = async io => {
    const row = await readClaudeHeader(io);
    const identity = await verifyClaudeIdentity(row, { ...selected, projectRoot: await fs.realpath(selected.projectRoot) }, { header: true, sessionKinds: kinds });
    out.row = row; return identity;
  };
  return { verify, out };
};
export const isClaudeHumanRow = row => row?.type === 'user' && human(row);
/** An exact `continued-in` marker written by this source: the session it names. */
export function claudeContinuedIn(row, source) {
  if (row?.type !== 'continued-in' || Object.keys(row).length !== 4 || row.sessionId !== source.sessionId ||
      typeof row.timestamp !== 'string' || !isNativeId(row.continuedInSessionId) || row.continuedInSessionId === source.sessionId) return null;
  try { timestamp(row.timestamp); } catch { return null; }
  return row.continuedInSessionId;
}

function normalizeHuman(record, out, rules) {
  const content = record.value.message.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) fail('UNSUPPORTED_CLAUDE_CONTENT');
  // A typed text block that is exactly the trusted skill command's envelope is
  // client markup around what the person typed: keep those arguments, as
  // written. Any other text, another skill's envelope or SDK input is verbatim.
  const typed = rules === 'skill-arguments' && record.value.promptSource === undefined;
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const args = typed ? claudeSkillArguments(block.text, MARKUP_SKILL_COMMAND) : null;
      if (args === null) out.add('user', record, { text: block.text });
      else if (args !== '') out.add('user', record, { text: args });
    }
    else if (['image', 'document'].includes(block.type)) {
      if (block.source?.type === 'url' && typeof block.source.url === 'string') out.add('attachment', record, { reference: block.source.url });
      else out.omit(block.source?.type === 'base64' ? 'inline-attachment-not-copied' : 'attachment-without-reusable-reference', record,
        typeof block.source?.media_type === 'string' ? { mimeType: block.source.media_type } : {});
    } else if (!['thinking', 'redacted_thinking'].includes(block.type)) out.omit('unsupported-content-block', record);
  }
}
const progressAt = (source, record) => ({ sourceIdentity: source.fileIdentity, offset: record.endByte,
  anchor: record.tailAnchor ?? { startByte: record.startByte, endByte: record.endByte, hash: record.hash } });

/** Trusted view of a verified session link, supplied by the worker under its
 * intake lock: `from` when this session continues a registered root session
 * (its re-homed prefix and background kind), `into` when this session was
 * continued elsewhere (its exact terminal marker). Never caller JSON. */
function continuationView(value) {
  if (value === null) return { from: null, into: null };
  keys(value, ['from', 'into']);
  const record = value => {
    keys(value, ['startByte', 'endByte', 'hash']); integer(value.startByte); integer(value.endByte); hash(value.hash);
    if (value.endByte <= value.startByte) fail('INVALID_WORKFLOW');
  };
  if (value.from !== null) { keys(value.from, ['prefix', 'sessionKinds']); record(value.from.prefix); claudeSessionKinds(value.from.sessionKinds); }
  if (value.into !== null) { keys(value.into, ['sessionId', 'record']); nativeId(value.into.sessionId); record(value.into.record); }
  return value;
}

/** Native parent links establish ancestry of human input, not causal ownership
 * of ordinary assistant/tool records. Only proven human records are copied.
 * Carry is bounded metadata; no unowned payload enters a capture or checkpoint.
 */
export async function readClaudeSelection({ state, scopeId, cursor = null, checkpoint = null, heads = new Map(), loadHead = null,
  resolveProcessingDispatch = null, resolveProcessingExecution = null, processingSkillPath = path.join(SKILL_ROOT, 'SKILL.md'),
  capturedAt = new Date().toISOString(), deadline = Infinity, now = Date.now, continuation = null, ...limits }) {
  validateSelectionState(state); nativeId(scopeId); timestamp(capturedAt);
  const { from: continuedFrom, into: continuedInto } = continuationView(continuation);
  const sessionKinds = continuedFrom?.sessionKinds ?? [];
  const scope = currentIntervals(state).find(item => item.id === scopeId) ?? state.explicitScopes.find(item => item.id === scopeId);
  if (!scope) fail('CAPTURE_NOT_SELECTED');
  const source = state.source, floor = scope.lower?.eofByte ?? scope.start.startByte;
  const from = cursor ?? { sourceIdentity: source.fileIdentity, offset: floor, anchor: null };
  if (from.sourceIdentity !== source.fileIdentity || from.offset < floor) fail('INVALID_INTAKE_CURSOR');
  const ceiling = scope.upper?.eofByte ?? scope.end?.endByte;
  if (ceiling !== undefined && from.offset > ceiling) fail('CLAUDE_INSPECTION_SUSPENDED');
  // A verified continuation marker is terminal: nothing after it is read.
  if (continuedInto && from.offset > continuedInto.record.endByte) fail('INVALID_INTAKE_CURSOR');
  const stops = [ceiling, limits.endByte, continuedInto?.record.endByte].filter(value => value !== undefined);
  if (cursor) await verifySourceCursor(source, cursor);
  if (from.offset > floor && !checkpoint) fail('READER_CHECKPOINT_REQUIRED');
  if (checkpoint) validateReaderCheckpoint(checkpoint, { identity: source, scopeId, sourceIdentity: source.fileIdentity, offset: from.offset });
  if (checkpoint?.records.some(record => record.startByte < floor)) fail('READER_CHECKPOINT_CONFLICT');
  if (checkpoint && checkpoint.reader !== CLAUDE_CHECKPOINT_READER) fail('READER_CHECKPOINT_CONFLICT');
  const carry = structuredClone(checkpoint ?? { format: 'cuefluent-reader-checkpoint', version: 1,
    reader: CLAUDE_CHECKPOINT_READER, client: 'claude', sessionId: source.sessionId,
    scopeId, sourceIdentity: source.fileIdentity, offset: from.offset, records: [], units: [] });
  const pager = checkpointPageBuilder(carry);
  let checkpointBytes = Buffer.byteLength(canonicalJSON(carry));
  const checkBudget = () => { checkWorkflowBudget(); if (now() >= deadline) fail('SESSION_READ_BUDGET'); };
  const scan = await readSessionRange({ ...limits, source, from: from.offset, deadline, now, readHeader: readClaudeHeader,
    verifyHeader: (row, source) => verifyClaudeIdentity(row, source, { header: true, sessionKinds }), ...(stops.length ? { endByte: Math.min(...stops) } : {}),
    startsMidRecord: from.offset === floor && Boolean(scope.lower?.startsMidRecord) });
  let continuedIn = null, terminal = false;
  let selection = structuredClone(state), blocked = scan.blocked, to = from;
  const rows = new Map(carry.records.map(row => [row.id, row])), changes = new Map(), badUnits = new Set();
  const frames = scan.discarded.map(r => ({ ...r, kind: 'excluded' })), anchorUpdates = [];
  const resolveBoundaries = (current, unitId, record) => {
    const updates = [], interval = current.intervals.find(item => item.id === scopeId);
    if (interval) for (const side of ['lower', 'upper']) {
      const boundary = interval[side];
      if (boundary && (boundary.unitId === unitId || (side === 'lower' && boundary.unitId === null)) && boundary.record === null &&
          (side === 'lower' || record.startByte <= boundary.eofByte) &&
          record.startByte >= (side === 'lower' ? boundary.eofByte : interval.lower.eofByte)) {
        const proven = { sourceIdentity: source.fileIdentity, unitId, record: anchor(record) };
        current = resolveSelectionAnchor(current, interval.id, side, proven);
        updates.push({ intervalId: interval.id, side, proven });
      }
    }
    return { selection: current, updates };
  };
  // Metadata was validated against this source, scope and cursor above. A pause
  // may name a human row already consumed by a preceding worker pass.
  for (const unit of carry.units) {
    const resolved = resolveBoundaries(selection, unit.id, rows.get(unit.recordId));
    selection = resolved.selection; anchorUpdates.push(...resolved.updates);
  }
  for (const record of scan.records) {
    try {
      checkBudget();
      const row = record.value;
      if (!row || typeof row !== 'object') fail('UNSUPPORTED_CLAUDE_RECORD');
      const marker = claudeContinuedIn(row, source);
      const sealed = marker !== null && continuedInto?.sessionId === marker && record.startByte === continuedInto.record.startByte &&
        record.endByte === continuedInto.record.endByte && record.hash === continuedInto.record.hash;
      if (!sealed && (discontinuities.has(row.type) || (row.type === 'last-prompt' && row.rewound === true))) {
        // Only the registered successor, verified from both transcripts, can
        // turn this marker into a terminal record; the hint carries no authority.
        if (marker !== null && !continuedInto) continuedIn = { sessionId: marker, record: { startByte: record.startByte, endByte: record.endByte, hash: record.hash } };
        fail('CLAUDE_HISTORY_REQUIRES_REVIEW');
      }
      if (row.sessionId !== undefined && row.sessionId !== source.sessionId) fail('SOURCE_IDENTITY_MISMATCH');
      // Re-homed history of the verified predecessor was that session's
      // evidence; here it is structural and never a second capture. The exact
      // boundary record pins the prefix the link verified.
      const boundary = continuedFrom?.prefix;
      if (boundary && ((record.startByte < boundary.endByte && record.endByte > boundary.endByte) || (record.endByte === boundary.endByte &&
          (record.startByte !== boundary.startByte || record.hash !== boundary.hash)))) fail('SOURCE_CHANGED');
      const rehomed = boundary !== undefined && record.endByte <= boundary.endByte;
      const excluded = sealed || rehomed || row.type === 'progress' || metadataTypes.has(row.type) || row.isSidechain === true || row.agentId != null;
      if (sealed) terminal = true;
      if (!excluded) {
        if (!rootTypes.has(row.type)) fail('UNSUPPORTED_CLAUDE_RECORD');
        await verifyClaudeIdentity(row, source, { sessionKinds }); nativeId(row.uuid); timestamp(row.timestamp);
        if (row.parentUuid !== null) nativeId(row.parentUuid);
        if (row.parentUuid === row.uuid) fail('CLAUDE_PARENT_CYCLE');
      }
      // Excluded transport metadata has no reusable native UUID or ancestry role.
      // Account its bytes without retaining an ever-growing byte-key history.
      if (excluded) {
        record.id = `claude:byte:${record.startByte}`;
        checkpointBytes += String(record.endByte).length - String(carry.offset).length;
        if (checkpointBytes > MAX_READER_CHECKPOINT_BYTES) fail('READER_CHECKPOINT_CAPACITY');
        carry.offset = record.endByte; to = progressAt(source, record);
        frames.push({ ...range(record), kind: 'structural', cursor: progressAt(source, record) }); continue;
      }
      record.id = row.uuid;
      const prior = rows.get(record.id);
      if (prior) {
        if (prior.hash !== record.hash) {
          if (prior.unitId) badUnits.add(prior.unitId);
          fail('CONFLICTING_CLAUDE_MIRROR');
        }
        const proposedBytes = checkpointBytes + String(record.endByte).length - String(carry.offset).length;
        if (proposedBytes > MAX_READER_CHECKPOINT_BYTES) fail('READER_CHECKPOINT_CAPACITY');
        checkpointBytes = proposedBytes; carry.offset = record.endByte;
        frames.push({ ...range(record), kind: 'structural', cursor: progressAt(source, record) }); to = progressAt(source, record); continue;
      }
      const isHuman = !excluded && human(row), unitId = isHuman ? nativeId(row.promptId) : null;
      const structural = excluded || synthetic(row) || row.type === 'system' || row.type === 'attachment';
      if (!excluded && row.type === 'system' && row.subtype === 'compact_boundary' &&
          (row.parentUuid !== null || row.logicalParentUuid == null)) fail('CLAUDE_COMPACTION_ANCESTRY_UNAVAILABLE');
      const parentId = !excluded && row.type === 'system' && row.subtype === 'compact_boundary' && row.logicalParentUuid != null
        ? nativeId(row.logicalParentUuid) : excluded ? null : row.parentUuid;
      if (parentId === record.id) fail('CLAUDE_PARENT_CYCLE');
      const meta = { id: record.id, parentId, unitId,
        kind: isHuman ? emptyHuman(row) ? 'human-empty' : 'human' : structural ? 'structural' : 'unowned',
        startByte: record.startByte, endByte: record.endByte, hash: record.hash };
      // Validate a proposed extension before making any prefix progress visible.
      const addUnit = isHuman && !carry.units.some(unit => unit.id === unitId);
      const unit = { id: unitId, recordId: record.id, occurredAt: row.timestamp };
      const proposedBytes = checkpointBytes + Buffer.byteLength(canonicalJSON(meta)) + (carry.records.length ? 1 : 0) +
        (addUnit ? Buffer.byteLength(canonicalJSON(unit)) + (carry.units.length ? 1 : 0) : 0) + String(record.endByte).length - String(carry.offset).length;
      if (carry.records.length >= 32768 || (addUnit && carry.units.length >= 8192) || proposedBytes > MAX_READER_CHECKPOINT_BYTES) fail('READER_CHECKPOINT_CAPACITY');
      let nextSelection = selection;
      const updates = [];
      if (isHuman && addUnit) {
        const resolved = resolveBoundaries(selection, unitId, record);
        nextSelection = resolved.selection; updates.push(...resolved.updates);
      }
      pager.append(meta, addUnit ? unit : null);
      // Commit this record to the returned prefix only after every fallible check.
      checkpointBytes = proposedBytes; carry.records.push(meta); if (addUnit) carry.units.push(unit);
      carry.offset = record.endByte; rows.set(record.id, meta); selection = nextSelection; anchorUpdates.push(...updates);
      to = progressAt(source, record);
      frames.push({ ...range(record), cursor: progressAt(source, record), kind: isHuman && !emptyHuman(row) ? 'unit' : structural || isHuman ? 'structural' : 'retained', ...(isHuman ? { unitId } : {}) });
      if (isHuman) {
        if (!changes.has(unitId)) changes.set(unitId, []);
        changes.get(unitId).push(record);
      }
    } catch (error) {
      if (['SOURCE_IDENTITY_MISMATCH', 'UNSUPPORTED_SESSION_OWNERSHIP'].includes(error.code)) throw error;
      blocked = { offset: record.startByte, code: error.code ?? 'UNSUPPORTED_CLAUDE_RECORD' }; break;
    }
  }
  // Nothing after a terminal marker is evidence. Only session bookkeeping may
  // follow it (one bounded look, never kept); anything else keeps the session
  // in review rather than silently dropping later evidence. A record still
  // being written there waits. A cursor already at the marker is terminal too.
  let markerTailPending = false;
  if (continuedInto && !blocked && scan.readEnd === continuedInto.record.endByte) {
    terminal = true;
    const stop = Math.min(scan.snapshotEnd, ...[ceiling, limits.endByte].filter(value => value !== undefined));
    if (stop > continuedInto.record.endByte) {
      const after = await readClaudeMarkerTail({ source, from: continuedInto.record.endByte, endByte: stop, observeRead: limits.observeRead, deadline, now,
        readHeader: readClaudeHeader, verifyHeader: (row, source) => verifyClaudeIdentity(row, source, { header: true, sessionKinds }) });
      if (after.kind === 'pending') markerTailPending = true;
      else if (after.kind !== 'metadata') blocked = { offset: continuedInto.record.endByte, code: 'CLAUDE_HISTORY_REQUIRES_REVIEW' };
    }
  }
  carry.offset = to.offset;
  validateReaderCheckpoint(carry);
  const nativeAnchors = carry.units.map(unit => ({ unitId: unit.id, record: anchor(rows.get(unit.recordId)) }));
  for (const interval of selection.intervals.filter(item => item.id === scopeId)) for (const boundary of [interval.lower, interval.upper]) {
    if (boundary?.record && !nativeAnchors.some(item => item.unitId === boundary.unitId)) nativeAnchors.push({ unitId: boundary.unitId, record: boundary.record });
  }
  // Prove only this scope's boundaries around each candidate with native links.
  // Unrelated earlier intervals cannot poison a resumed interval's proof.
  const ordered = [...nativeAnchors].sort((a, b) => a.record.startByte - b.record.startByte);
  const linked = (before, after) => {
    let id = after.record.id; const seen = new Set();
    while (id !== before.record.id) {
      if (!id || seen.has(id)) return false;
      seen.add(id); id = rows.get(id)?.parentId;
    }
    return true;
  };
  const orderFor = unitId => {
    const interval = selection.intervals.find(item => item.id === scopeId);
    const wanted = interval ? [interval.lower.unitId, unitId, ...(interval.upper ? [interval.upper.unitId] : [])] : [unitId];
    const anchors = [...new Set(wanted)].map(id => ordered.find(item => item.unitId === id));
    if (anchors.some(item => !item)) return null;
    anchors.sort((a, b) => a.record.startByte - b.record.startByte);
    return anchors.every((item, i) => i === 0 || linked(anchors[i - 1], item))
      ? { kind: 'native-links', units: anchors.map(item => item.unitId), anchors } : null;
  };
  const candidates = [], pending = [], eligibility = new Map(), noEvidence = [], covered = [], processingControls = [];
  const trustedSkills = new Map();
  const excludeInput = (proof, records) => {
    if (proof.evidenceScope !== 'controller-input' || proof.recordIds.length !== 1) return false;
    const input = records.find(record => record.id === proof.recordIds[0]);
    if (!input) return false; // A later same-prompt correction is not the sealed input.
    if (input.startByte !== proof.inputRange.fromByte || input.endByte !== proof.inputRange.endByte || input.hash !== proof.inputRange.hash) fail('SOURCE_CHANGED');
    // Preserve native unit/ancestry metadata without claiming absent evidence on
    // replay. human-empty is already a structural, no-evidence checkpoint kind.
    const metadata = rows.get(input.id), oldKind = metadata.kind;
    metadata.kind = 'human-empty';
    try { validateReaderCheckpoint(carry); checkpointPageBuilder(carry); }
    catch (error) { metadata.kind = oldKind; throw error; }
    const frame = frames.find(value => value.recordIds?.includes(input.id)); if (frame) frame.kind = 'structural';
    processingControls.push(proof); return true;
  };
  for (const [unitId, records] of changes) {
    try {
      checkBudget();
      if (badUnits.has(unitId)) fail('CONFLICTING_CLAUDE_MIRROR');
      const start = nativeAnchors.find(item => item.unitId === unitId).record, last = records.at(-1);
      const proof = { client: 'claude', sessionId: source.sessionId, sourceIdentity: source.fileIdentity, unitId,
        start, end: { id: last.id, ...last.tailAnchor }, nativeOrder: orderFor(unitId) };
      const chosen = evaluateUnitSelection(selection, proof), selected = chosen.scopes.some(item => item.scopeId === scopeId);
      eligibility.set(unitId, selected ? 'selected' : chosen.pendingScopes?.includes(scopeId) ? 'unresolved' : 'excluded');
      if (!selected) { if (chosen.pendingScopes?.includes(scopeId)) pending.push({ unitId, reason: 'anchor-unresolved' }); continue; }
      // A new explicit window has no checkpoint, but can extend a previously
      // captured unit. Bind its current head before synthesis, under the caller's
      // intake lock; never substitute a refreshed expectation at publication.
      const previous = heads.get(unitId) ?? await loadHead?.(unitId), baseline = previous?.capture ?? null;
      if (baseline) {
        validateCapture(baseline);
        if (baseline.identity.client !== 'claude' || baseline.identity.sessionId !== source.sessionId || baseline.identity.unitId !== unitId ||
            baseline.source.fileIdentity !== source.fileIdentity || baseline.source.path !== source.path || baseline.projectRoot !== source.projectRoot ||
            baseline.reader.name !== 'claude-transcript' || captureReader(baseline.reader).headerClientVersion !== scan.metadata.version) fail('CAPTURE_REVISION_CONFLICT');
        // An unknown (newer) rule set is never reinterpreted under these rules.
        if (!Object.hasOwn(CLAUDE_EVIDENCE_RULES, baseline.reader.version)) fail('UNSUPPORTED_CLAUDE_READER');
      }
      // A published head extends under the evidence rules it was captured with.
      const readerVersion = baseline?.reader.version ?? CLAUDE_READER_VERSION;
      const provenInputs = new Set();
      if (!baseline && !previous?.head && typeof loadHead === 'function') {
        if (typeof resolveProcessingExecution === 'function') {
          const receipt = await resolveProcessingExecution({ client: 'claude', sessionId: source.sessionId, unitId });
          if (receipt) {
            const execution = await verifyProcessingExecution({ source, unitId, fromByte: receipt.fromByte, endByte: receipt.endByte }, { resolveExecution: async () => receipt });
            if (isProcessingExecutionProof(execution) && excludeInput(execution, records)) for (const id of execution.recordIds) provenInputs.add(id);
          }
        }
        if (!provenInputs.size && typeof resolveProcessingDispatch === 'function' && isClaudeProcessingCommand(records[0]?.value)) {
          const controlKind = claudeProcessingCommandKind(records[0].value);
          if (!trustedSkills.has(controlKind)) trustedSkills.set(controlKind, loadClaudeProcessingSkill({ skillPath: processingSkillPath, control: controlKind }));
          if (await trustedSkills.get(controlKind)) {
            const input = records[0], laterInput = scan.records.find(record => record.startByte > input.startByte && human(record.value));
            const endByte = laterInput?.startByte ?? to.offset;
            const control = await verifyClaudeProcessingControl({ source, unitId, fromByte: input.startByte, endByte }, { resolveDispatch: resolveProcessingDispatch, trustedSkill: await trustedSkills.get(controlKind), sessionKinds });
            if (isProcessingControlProof(control) && excludeInput(control, records)) for (const id of control.recordIds) provenInputs.add(id);
            else {
              const finished = scan.records.some(record => record.startByte > input.startByte && record.endByte <= endByte &&
                record.value.type === 'assistant' && record.value.message?.stop_reason === 'end_turn' &&
                record.value.attributionSkill === CLAUDE_SKILL_COMMAND);
              // Deferral is not exclusion. A torn formal command has no proof
              // yet; keep its cursor held until completion or a later real input.
              if (!laterInput && !finished) { pending.push({ unitId, reason: 'PROCESSING_CONTROL_PROVENANCE_PENDING' }); continue; }
            }
          }
        }
      }
      const oldHuman = (checkpoint?.records ?? []).filter(item => item.kind === 'human' && item.unitId === unitId);
      if (oldHuman.length && (!baseline || oldHuman.some(item => !baseline.source.ranges.some(r => r.recordIds.includes(item.id))))) fail('CAPTURE_BASELINE_REQUIRED');
      const additions = records.filter(record => {
        if (provenInputs.has(record.id)) return false;
        const old = baseline?.source.ranges.find(range => range.recordIds.includes(record.id));
        if (old) {
          if (canonicalJSON(old) !== canonicalJSON(captureRange(record))) fail('CAPTURE_REVISION_CONFLICT');
          return false;
        }
        return !emptyHuman(record.value);
      });
      if (!additions.length) {
        if (!baseline) { noEvidence.push(unitId); eligibility.set(unitId, 'structural'); }
        else covered.push({ unitId, evidenceHash: baseline.evidenceHash, fileHash: previous.head.fileHash });
        continue;
      }
      // Reusing evidence in a new revision must not widen the selected window.
      // A fully covered replay above creates no snapshot and accounts only the
      // observed frames, which the intake helper verifies against the live head.
      if (baseline?.source.ranges.some(range => range.startByte < floor || (scope.end && range.endByte > scope.end.endByte))) fail('CAPTURE_REVISION_SCOPE_CONFLICT');
      const out = evidenceCollector(baseline ? { evidence: baseline.evidence, omissions: baseline.coverage.omissions } : undefined);
      for (const record of additions) { checkBudget(); normalizeHuman(record, out, CLAUDE_EVIDENCE_RULES[readerVersion]); }
      if (!out.evidence.length && !out.omissions.length) { noEvidence.push(unitId); eligibility.set(unitId, 'structural'); continue; }
      const capture = createCapture({ format: 'cuefluent-capture', schemaVersion: 2, identity: { client: 'claude', sessionId: source.sessionId, unitId },
        projectRoot: source.projectRoot, source: { path: source.path, fileIdentity: source.fileIdentity,
          ranges: [...(baseline?.source.ranges ?? []), ...additions.map(captureRange)] },
        reader: { name: 'claude-transcript', version: readerVersion, headerClientVersion: scan.metadata.version },
        occurredAt: baseline?.occurredAt ?? carry.units.find(unit => unit.id === unitId).occurredAt, capturedAt, terminal: 'unconfirmed',
        coverage: { partial: true, omissions: out.omissions }, evidence: out.evidence });
      if (baseline) assertCaptureExtension(baseline, capture);
      candidates.push({ capture, proof, scopeId, expectedHeadHash: previous?.hash ?? null });
    } catch (error) { pending.push({ unitId, reason: error.code ?? 'UNSUPPORTED_CLAUDE_UNIT' }); }
  }
  return { candidates, covered, pending, noEvidence, processingControls, unanchoredUnits: [], blocked, anchorUpdates, selection, from, to, frames, eligibility, checkpoint: carry,
    continuedIn: blocked?.code === 'CLAUDE_HISTORY_REQUIRES_REVIEW' && continuedIn?.record.startByte === blocked.offset ? continuedIn : null, terminal,
    nativeAnchors: carry.units.map(unit => ({ unitId: unit.id, record: anchor(rows.get(unit.recordId)) })), recordAnchors: scan.records.filter(record => record.id && record.endByte <= to.offset).map(anchor),
    diagnostics: { pendingTail: scan.pendingTail || markerTailPending, limited: scan.limited, bytesRead: scan.bytesRead, snapshotEnd: scan.snapshotEnd,
      automaticCeilingReached: Boolean(scope.upper && scan.snapshotEnd >= ceiling && !scan.limited && !scan.blocked),
      unownedRecords: carry.records.filter(row => row.kind === 'unowned').length, coverage: 'proven-human-input-only' } };
}

/** One combined cursor/carry checkpoint is trimmed to the proven prefix. */
export function claudePublicationPlan(result, unitId = null, published = new Map()) {
  if (result.anchorUpdates.length) fail('SELECTION_ANCHORS_PENDING');
  const candidate = unitId === null ? null : result.candidates.find(item => item.capture.identity.unitId === unitId);
  if (unitId !== null && !candidate) fail('CAPTURE_NOT_SELECTED');
  const desired = candidate ? { sourceIdentity: result.from.sourceIdentity, offset: candidate.proof.end.endByte,
    anchor: { startByte: candidate.proof.end.startByte, endByte: candidate.proof.end.endByte, hash: candidate.proof.end.hash } } : result.to;
  const accounted = []; let offset = result.from.offset, heldReason = null, prefixCursor = result.from, bounded = false;
  for (const frame of result.frames) {
    if (frame.startByte >= desired.offset) break;
    if (frame.startByte !== offset) { heldReason = 'unaccounted-source-gap'; break; }
    let kind = frame.kind, fields = {};
    if (kind === 'unit') {
      if (frame.unitId === unitId) { kind = 'captured'; fields = { unitId }; }
      else if (result.eligibility.get(frame.unitId) === 'excluded') kind = 'excluded';
      else if (result.eligibility.get(frame.unitId) === 'structural') kind = 'structural';
      else if (published.has(frame.unitId)) { kind = 'published'; fields = { unitId: frame.unitId, ...published.get(frame.unitId) }; }
      else { heldReason = 'unpublished-earlier-unit'; break; }
    }
    const previous = accounted.at(-1);
    if (previous && previous.kind === kind && previous.unitId === fields.unitId && previous.fileHash === fields.fileHash && previous.evidenceHash === fields.evidenceHash) previous.endByte = frame.endByte;
    else {
      if (accounted.length === 1024) { heldReason = 'interleaved-accounting-limit'; bounded = unitId === null; break; }
      accounted.push({ startByte: frame.startByte, endByte: frame.endByte, kind, ...fields });
    }
    offset = frame.endByte; prefixCursor = frame.cursor ?? result.from;
  }
  if (offset !== desired.offset) heldReason ??= 'unaccounted-source-gap';
  const to = bounded && prefixCursor.offset > result.from.offset ? prefixCursor : heldReason ? result.from : desired;
  if (bounded && to.offset > result.from.offset) heldReason = null;
  const records = result.checkpoint.records.filter(row => row.endByte <= to.offset), ids = new Set(records.map(row => row.id));
  const checkpoint = { ...result.checkpoint, offset: to.offset, records, units: result.checkpoint.units.filter(unit => ids.has(unit.recordId)) };
  return { scan: { from: result.from, to, accounted: heldReason ? [] : accounted }, checkpoint, heldReason };
}
