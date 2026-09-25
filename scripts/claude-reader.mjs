import fs from 'node:fs/promises';
import path from 'node:path';
import { absolutePath } from './workflow-paths.mjs';
import { validateReaderCheckpoint, MAX_READER_CHECKPOINT_BYTES, checkpointPageBuilder } from './reader-checkpoint.mjs';
import { readSessionRange, decodeSessionRecord } from './session-jsonl.mjs';
import { validateSelectionState, evaluateUnitSelection, resolveSelectionAnchor, currentIntervals } from './capture-selection.mjs';
import { verifySourceCursor } from './intake-store.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { evidenceCollector } from './capture-evidence.mjs';
import { createCapture, validateCapture, assertCaptureExtension } from './capture-contract.mjs';
import { nativeId, timestamp, canonicalJSON, fail } from './workflow-values.mjs';

export const CLAUDE_READER_VERSION = '1';
export const CLAUDE_CLIENT_VERSIONS = Object.freeze(['2.1.280']);
const metadataTypes = new Set(['summary', 'custom-title', 'ended-by-model', 'ai-title', 'last-prompt', 'tag',
  'agent-name', 'agent-color', 'agent-setting', 'pr-link', 'frame-link', 'artifact-comment-monitor',
  'artifact-autoreact-ledger', 'file-history-snapshot', 'file-history-delta', 'attribution-snapshot',
  'mode', 'permission-mode', 'isolation-latch', 'memory-mode', 'atis-latch', 'worktree-state', 'cost-state', 'queue-operation']);
const discontinuities = new Set(['relocated', 'continued-in', 'bridge-session', 'history-suppression',
  'content-replacement', 'fork-context-ref', 'observer-ref']);
const rootTypes = new Set(['user', 'assistant', 'system', 'attachment']);
const anchor = r => ({ id: r.id, startByte: r.startByte, endByte: r.endByte, hash: r.hash });
const range = r => ({ startByte: r.startByte, endByte: r.endByte, recordIds: [r.id] });
const captureRange = r => ({ ...range(r), hash: r.hash });
const toolResult = row => row.type === 'user' && Array.isArray(row.message?.content) && row.message.content.some(b => b.type === 'tool_result');
const synthetic = row => row.isMeta === true || row.isVirtual === true || row.isVisibleInTranscriptOnly === true ||
  row.isCompactSummary === true || (row.origin !== undefined && row.origin?.kind !== 'human');
const human = row => row.type === 'user' && row.message?.role === 'user' && !toolResult(row) && !synthetic(row) &&
  row.interruptedMessageId === undefined && row.interruptedByShutdown !== true;
const emptyHuman = row => row.message.content === '' || (Array.isArray(row.message.content) &&
  row.message.content.every(block => (block.type === 'text' && block.text === '') || ['thinking', 'redacted_thinking'].includes(block.type)));

/** Claude can prepend metadata before its first native identity row. Never scan past 64 KiB. */
export async function readClaudeHeader({ readHeader, size }) {
  let offset = 0, pending = Buffer.alloc(0), prefixSessionId = null;
  while (offset < Math.min(size, 64 * 1024)) {
    const chunk = await readHeader(offset, Math.min(1024, size - offset, 64 * 1024 - offset));
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
async function verifyClaudeIdentity(row, source, { header = false } = {}) {
  if (source.client !== 'claude' || row.sessionId !== source.sessionId) fail('SOURCE_IDENTITY_MISMATCH');
  if (!CLAUDE_CLIENT_VERSIONS.includes(row.version)) fail('UNSUPPORTED_CLAUDE_VERSION');
  if (row.isSidechain !== false || row.agentId != null || row.forkedFrom != null || row.foreignToBridgeSession != null ||
      row.sessionKind != null) fail('UNSUPPORTED_SESSION_OWNERSHIP');
  if (header) {
    absolutePath(row.cwd);
    if (path.normalize(row.cwd) !== path.normalize(source.projectRoot) && await fs.realpath(row.cwd).catch(() => null) !== source.projectRoot) fail('SOURCE_IDENTITY_MISMATCH');
  }
  return { client: 'claude', sessionId: row.sessionId, projectRoot: source.projectRoot, version: row.version };
}
export const claudeRegistrationHeader = selected => async io => verifyClaudeIdentity(await readClaudeHeader(io),
  { ...selected, projectRoot: await fs.realpath(selected.projectRoot) }, { header: true });

function normalizeHuman(record, out) {
  const content = record.value.message.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) fail('UNSUPPORTED_CLAUDE_CONTENT');
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') out.add('user', record, { text: block.text });
    else if (['image', 'document'].includes(block.type)) {
      if (block.source?.type === 'url' && typeof block.source.url === 'string') out.add('attachment', record, { reference: block.source.url });
      else out.omit(block.source?.type === 'base64' ? 'inline-attachment-not-copied' : 'attachment-without-reusable-reference', record,
        typeof block.source?.media_type === 'string' ? { mimeType: block.source.media_type } : {});
    } else if (!['thinking', 'redacted_thinking'].includes(block.type)) out.omit('unsupported-content-block', record);
  }
}
const progressAt = (source, record) => ({ sourceIdentity: source.fileIdentity, offset: record.endByte,
  anchor: record.tailAnchor ?? { startByte: record.startByte, endByte: record.endByte, hash: record.hash } });

/** Native parent links establish ancestry of human input, not causal ownership
 * of ordinary assistant/tool records. Only proven human records are copied.
 * Carry is bounded metadata; no unowned payload enters a capture or checkpoint.
 */
export async function readClaudeSelection({ state, scopeId, cursor = null, checkpoint = null, heads = new Map(), loadHead = null,
  capturedAt = new Date().toISOString(), deadline = Infinity, now = Date.now, ...limits }) {
  validateSelectionState(state); nativeId(scopeId); timestamp(capturedAt);
  const scope = currentIntervals(state).find(item => item.id === scopeId) ?? state.explicitScopes.find(item => item.id === scopeId);
  if (!scope) fail('CAPTURE_NOT_SELECTED');
  const source = state.source, floor = scope.lower?.eofByte ?? scope.start.startByte;
  const from = cursor ?? { sourceIdentity: source.fileIdentity, offset: floor, anchor: null };
  if (from.sourceIdentity !== source.fileIdentity || from.offset < floor) fail('INVALID_INTAKE_CURSOR');
  const ceiling = scope.upper?.eofByte ?? scope.end?.endByte;
  if (ceiling !== undefined && from.offset > ceiling) fail('CLAUDE_INSPECTION_SUSPENDED');
  if (cursor) await verifySourceCursor(source, cursor);
  if (from.offset > floor && !checkpoint) fail('READER_CHECKPOINT_REQUIRED');
  if (checkpoint) validateReaderCheckpoint(checkpoint, { identity: source, scopeId, sourceIdentity: source.fileIdentity, offset: from.offset });
  if (checkpoint?.records.some(record => record.startByte < floor)) fail('READER_CHECKPOINT_CONFLICT');
  if (checkpoint && checkpoint.reader !== `claude-transcript/${CLAUDE_READER_VERSION}`) fail('READER_CHECKPOINT_CONFLICT');
  const carry = structuredClone(checkpoint ?? { format: 'cuefluent-reader-checkpoint', version: 1,
    reader: `claude-transcript/${CLAUDE_READER_VERSION}`, client: 'claude', sessionId: source.sessionId,
    scopeId, sourceIdentity: source.fileIdentity, offset: from.offset, records: [], units: [] });
  const pager = checkpointPageBuilder(carry);
  let checkpointBytes = Buffer.byteLength(canonicalJSON(carry));
  const checkBudget = () => { checkWorkflowBudget(); if (now() >= deadline) fail('SESSION_READ_BUDGET'); };
  const scan = await readSessionRange({ ...limits, source, from: from.offset, deadline, now, readHeader: readClaudeHeader,
    verifyHeader: (row, source) => verifyClaudeIdentity(row, source, { header: true }), ...(ceiling !== undefined ? { endByte: Math.min(ceiling, limits.endByte ?? ceiling) } : {}),
    startsMidRecord: from.offset === floor && Boolean(scope.lower?.startsMidRecord) });
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
      if (discontinuities.has(row.type) || (row.type === 'last-prompt' && row.rewound === true)) fail('CLAUDE_HISTORY_REQUIRES_REVIEW');
      if (row.sessionId !== undefined && row.sessionId !== source.sessionId) fail('SOURCE_IDENTITY_MISMATCH');
      const excluded = row.type === 'progress' || metadataTypes.has(row.type) || row.isSidechain === true || row.agentId != null;
      if (!excluded) {
        if (!rootTypes.has(row.type)) fail('UNSUPPORTED_CLAUDE_RECORD');
        await verifyClaudeIdentity(row, source); nativeId(row.uuid); timestamp(row.timestamp);
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
  const candidates = [], pending = [], eligibility = new Map(), noEvidence = [], covered = [];
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
            baseline.reader.name !== 'claude-transcript' || baseline.reader.version !== CLAUDE_READER_VERSION || baseline.reader.clientVersion !== scan.metadata.version) fail('CAPTURE_REVISION_CONFLICT');
      }
      const oldHuman = (checkpoint?.records ?? []).filter(item => item.kind === 'human' && item.unitId === unitId);
      if (oldHuman.length && (!baseline || oldHuman.some(item => !baseline.source.ranges.some(r => r.recordIds.includes(item.id))))) fail('CAPTURE_BASELINE_REQUIRED');
      const additions = records.filter(record => {
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
      for (const record of additions) { checkBudget(); normalizeHuman(record, out); }
      if (!out.evidence.length && !out.omissions.length) { noEvidence.push(unitId); eligibility.set(unitId, 'structural'); continue; }
      const capture = createCapture({ format: 'cuefluent-capture', schemaVersion: 2, identity: { client: 'claude', sessionId: source.sessionId, unitId },
        projectRoot: source.projectRoot, source: { path: source.path, fileIdentity: source.fileIdentity,
          ranges: [...(baseline?.source.ranges ?? []), ...additions.map(captureRange)] },
        reader: { name: 'claude-transcript', version: CLAUDE_READER_VERSION, clientVersion: scan.metadata.version },
        occurredAt: baseline?.occurredAt ?? carry.units.find(unit => unit.id === unitId).occurredAt, capturedAt, terminal: 'unconfirmed',
        coverage: { partial: true, omissions: out.omissions }, evidence: out.evidence });
      if (baseline) assertCaptureExtension(baseline, capture);
      candidates.push({ capture, proof, scopeId, expectedHeadHash: previous?.hash ?? null });
    } catch (error) { pending.push({ unitId, reason: error.code ?? 'UNSUPPORTED_CLAUDE_UNIT' }); }
  }
  return { candidates, covered, pending, noEvidence, unanchoredUnits: [], blocked, anchorUpdates, selection, from, to, frames, eligibility, checkpoint: carry,
    nativeAnchors: carry.units.map(unit => ({ unitId: unit.id, record: anchor(rows.get(unit.recordId)) })), recordAnchors: scan.records.filter(record => record.id && record.endByte <= to.offset).map(anchor),
    diagnostics: { pendingTail: scan.pendingTail, limited: scan.limited, bytesRead: scan.bytesRead, snapshotEnd: scan.snapshotEnd,
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
