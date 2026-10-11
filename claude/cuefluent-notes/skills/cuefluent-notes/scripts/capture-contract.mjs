import { absolutePath } from './workflow-paths.mjs';
import { CONTROLS } from './file-io.mjs';
import { keys, string, choice, list, nativeId, integer, timestamp, hash, canonicalJSON, digest, fail } from './workflow-values.mjs';

export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_BYTES = 32 * 1024;
export const MAX_CAPTURE_TOOL_BYTES = 256 * 1024;
const recordId = value => string(value, 256);

// Client labels are bounded provenance, not a supported-version allowlist.
export function clientVersion(value) {
  try { return string(value, 128); }
  catch { fail('INVALID_SESSION_CLIENT_VERSION'); }
}

// Preserve existing immutable captures without mistaking header provenance for
// the version that emitted every record in a resumed session.
export function captureReader(reader) {
  keys(reader, ['name', 'version'], ['clientVersion', 'headerClientVersion']);
  for (const field of ['name', 'version']) string(reader[field], 128);
  if (Object.hasOwn(reader, 'clientVersion') === Object.hasOwn(reader, 'headerClientVersion')) fail('INVALID_CAPTURE_READER');
  return { name: reader.name, version: reader.version,
    headerClientVersion: clientVersion(reader.headerClientVersion ?? reader.clientVersion) };
}

export function logicalCaptureIdentity(value) {
  keys(value, ['client', 'sessionId', 'unitId']);
  return { client: choice(value.client, ['codex', 'claude']), sessionId: nativeId(value.sessionId), unitId: nativeId(value.unitId) };
}
export function captureRelativePath(identity, evidenceHash) {
  const { client, sessionId, unitId } = logicalCaptureIdentity(identity);
  hash(evidenceHash);
  return `${client}/${sessionId}/${unitId}/${evidenceHash.slice(0, 20)}.json`;
}
function sourceRange(value) {
  keys(value, ['startByte', 'endByte', 'recordIds'], ['hash']);
  integer(value.startByte); integer(value.endByte);
  if (value.endByte <= value.startByte) fail('INVALID_CAPTURE_RANGE');
  list(value.recordIds, 1024, { empty: false }).forEach(recordId);
  if (value.hash !== undefined) { hash(value.hash); if (value.recordIds.length !== 1) fail('INVALID_CAPTURE_RANGE'); }
}
function evidence(value) {
  const variants = {
    user: ['text'], assistant: ['text'],
    'tool-call': ['tool', 'callId', 'text'],
    'tool-result': ['tool', 'callId', 'outcome', 'text'],
    attachment: ['reference'],
  };
  choice(value?.kind, Object.keys(variants));
  keys(value, ['kind', 'recordId', 'range', ...variants[value.kind]], value.kind === 'attachment' ? ['mimeType', 'caption'] : []);
  recordId(value.recordId); sourceRange(value.range);
  if (!value.range.recordIds.includes(value.recordId)) fail('INVALID_CAPTURE_RANGE');
  if (value.kind === 'attachment') {
    string(value.reference, 8192);
    // No embedded binary or executable links. Preserve supplied relative/absolute references.
    if (CONTROLS.test(value.reference) || /^(?:data|javascript|vbscript):/i.test(value.reference.trim())) fail('UNSUPPORTED_ATTACHMENT');
    if (value.mimeType !== undefined) {
      string(value.mimeType, 256);
      if (CONTROLS.test(value.mimeType)) fail('UNSUPPORTED_ATTACHMENT');
    }
    if (value.caption !== undefined) string(value.caption, 8192, { empty: true });
  } else {
    string(value.text, MAX_CAPTURE_BYTES, { empty: true });
    if (value.kind.startsWith('tool-')) {
      string(value.tool, 128); string(value.callId, 256);
      if (Buffer.byteLength(value.text) > MAX_TOOL_BYTES) fail('CAPTURE_TOOL_LIMIT');
      if (value.kind === 'tool-result') choice(value.outcome, ['succeeded', 'failed', 'unknown']);
    }
  }
}
function validateShape(value) {
  keys(value, ['format', 'schemaVersion', 'identity', 'revision', 'projectRoot', 'source', 'reader',
    'occurredAt', 'capturedAt', 'terminal', 'coverage', 'evidence', 'evidenceHash']);
  if (value.format !== 'cuefluent-capture' || value.schemaVersion !== 2) fail('UNSUPPORTED_CAPTURE_SCHEMA');
  hash(value.revision);
  if (value.revision !== value.evidenceHash) fail('CAPTURE_HASH_MISMATCH');
  logicalCaptureIdentity(value.identity); absolutePath(value.projectRoot);
  keys(value.source, ['path', 'fileIdentity', 'ranges']);
  absolutePath(value.source.path); string(value.source.fileIdentity, 512);
  const ranges = list(value.source.ranges, 4096, { empty: false });
  ranges.forEach(sourceRange);
  const sourceIds = ranges.flatMap(range => range.recordIds);
  if (new Set(sourceIds).size !== sourceIds.length) fail('INVALID_CAPTURE_RANGE');
  for (let i = 1; i < ranges.length; i++) if (ranges[i].startByte < ranges[i - 1].endByte) fail('INVALID_CAPTURE_RANGE');
  captureReader(value.reader);
  timestamp(value.occurredAt); timestamp(value.capturedAt);
  choice(value.terminal, ['unconfirmed', 'completed', 'interrupted', 'failed']);
  keys(value.coverage, ['partial', 'omissions']);
  if (typeof value.coverage.partial !== 'boolean' || (value.terminal !== 'completed' && !value.coverage.partial)) fail('INVALID_CAPTURE_COVERAGE');
  list(value.coverage.omissions, 4096).forEach(item => {
    keys(item, ['reason'], ['recordId', 'bytes', 'count', 'mimeType', 'caption']);
    string(item.reason, 128);
    if (item.recordId !== undefined) recordId(item.recordId);
    if (item.bytes !== undefined) integer(item.bytes);
    if (item.count !== undefined && integer(item.count) < 1) fail('INVALID_CAPTURE_COVERAGE');
    if (item.mimeType !== undefined) string(item.mimeType, 256);
    if (item.caption !== undefined) string(item.caption, 8192, { empty: true });
  });
  if (value.coverage.omissions.length && !value.coverage.partial) fail('INVALID_CAPTURE_COVERAGE');
  let tools = 0, position = -1;
  // Image-only selected turns may contain solely explicit attachment omissions.
  list(value.evidence, 4096, { empty: value.coverage.omissions.length > 0 }).forEach(item => {
    evidence(item);
    if (item.range.startByte < position || !ranges.some(range => range.startByte <= item.range.startByte &&
        range.endByte >= item.range.endByte && item.range.recordIds.every(id => range.recordIds.includes(id)))) fail('INVALID_CAPTURE_RANGE');
    position = item.range.startByte;
    if (item.kind.startsWith('tool-')) tools += Buffer.byteLength(item.text);
  });
  if (tools > MAX_CAPTURE_TOOL_BYTES) fail('CAPTURE_TOOL_LIMIT');
}

/** Provenance changes alone never create new normalized evidence. No self-referential file hash. */
export function evidenceFingerprint(value) {
  return digest(canonicalJSON({ format: value.format, schemaVersion: value.schemaVersion,
    identity: value.identity, projectRoot: value.projectRoot,
    source: value.source, occurredAt: value.occurredAt, terminal: value.terminal,
    coverage: value.coverage, evidence: value.evidence }));
}
export function serializeCapture(value) {
  validateShape(value); hash(value.evidenceHash);
  if (value.evidenceHash !== evidenceFingerprint(value)) fail('CAPTURE_HASH_MISMATCH');
  const bytes = Buffer.from(canonicalJSON(value) + '\n');
  if (bytes.length > MAX_CAPTURE_BYTES) fail('CAPTURE_SIZE_LIMIT');
  return bytes;
}
export function validateCapture(value) { serializeCapture(value); return value; }
export function createCapture(value) {
  const evidenceHash = evidenceFingerprint(value);
  const capture = { ...value, revision: evidenceHash, evidenceHash };
  validateCapture(capture);
  return capture;
}

/** Automatic snapshots may extend proven evidence, never reinterpret a prior revision. */
export function assertCaptureExtension(previous, next) {
  validateCapture(previous); validateCapture(next);
  if (previous.evidenceHash === next.evidenceHash) return;
  if (previous.terminal !== 'unconfirmed') fail('FINAL_CAPTURE_CONFLICT');
  if (canonicalJSON(captureReader(previous.reader)) !== canonicalJSON(captureReader(next.reader))) fail('CAPTURE_REVISION_CONFLICT');
  for (const field of ['identity', 'projectRoot', 'occurredAt']) {
    if (canonicalJSON(previous[field]) !== canonicalJSON(next[field])) fail('CAPTURE_REVISION_CONFLICT');
  }
  if (previous.source.path !== next.source.path || previous.source.fileIdentity !== next.source.fileIdentity) fail('CAPTURE_REVISION_CONFLICT');
  const containsSequence = (old, updated) => {
    let index = 0;
    for (const item of updated) if (index < old.length && canonicalJSON(item) === canonicalJSON(old[index])) index++;
    if (index !== old.length) fail('CAPTURE_REVISION_CONFLICT');
  };
  containsSequence(previous.evidence, next.evidence);
  const previousIds = new Set(previous.source.ranges.flatMap(range => range.recordIds));
  const oldItems = new Map();
  for (const item of previous.evidence) {
    const key = canonicalJSON(item); oldItems.set(key, (oldItems.get(key) ?? 0) + 1);
  }
  for (const item of next.evidence) {
    const key = canonicalJSON(item), remaining = oldItems.get(key) ?? 0;
    if (remaining) oldItems.set(key, remaining - 1);
    else if (previousIds.has(item.recordId)) fail('CAPTURE_REVISION_CONFLICT');
  }
  containsSequence(previous.source.ranges.flatMap(r => r.recordIds), next.source.ranges.flatMap(r => r.recordIds));
  for (const old of previous.source.ranges) {
    if (old.hash !== undefined && !next.source.ranges.some(range => canonicalJSON(range) === canonicalJSON(old))) fail('CAPTURE_REVISION_CONFLICT');
    let offset = old.startByte;
    for (const current of next.source.ranges) {
      if (current.endByte <= offset) continue;
      if (current.startByte > offset) break;
      offset = current.endByte;
      if (offset >= old.endByte) break;
    }
    if (offset < old.endByte) fail('CAPTURE_REVISION_CONFLICT');
  }
  for (const old of previous.coverage.omissions) {
    const { bytes, count, ...identity } = old;
    if (!next.coverage.omissions.some(item => {
      const { bytes: newBytes, count: newCount, ...newIdentity } = item;
      return canonicalJSON(identity) === canonicalJSON(newIdentity) && (bytes === undefined || (newBytes ?? -1) >= bytes) && (newCount ?? 1) >= (count ?? 1);
    })) fail('CAPTURE_REVISION_CONFLICT');
  }
}
