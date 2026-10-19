import path from 'node:path';
import { intakeSnapshot, intakeJSON, replaceIntakeJSON } from './intake-io.mjs';
import { readRegistration } from './collection-ingress.mjs';
import { readSelection } from './intake-store.mjs';
import { inspectSourceBoundary } from './capture-selection.mjs';
import { readSessionRange, SESSION_LINE_LIMIT } from './session-jsonl.mjs';
import { workflowReadLimit } from './workflow-budget.mjs';
import { claudeHeaderRow, claudeRegistrationHeader, claudeContinuedIn, claudeSessionKinds, isClaudeHumanRow, readClaudeMarkerTail } from './claude-reader.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { collectionGrantHash } from './collection-grant.mjs';
import { canonicalWorkflowProject } from './workflow-paths.mjs';
import { canonicalJSON, fail, keys, nativeId, hash, integer, timestamp, string, isNativeId } from './workflow-values.mjs';

// Claude CLI can move a conversation into a new session ID: the old transcript
// ends with `continued-in <new>`, and the new transcript re-homes the history
// under the new ID. A link joins the two only after both registered transcripts
// agree; it is recorded once and never inferred from timing, titles or a marker
// alone. It governs reading and chat lineage, never collection or processing
// consent, and it never widens any interval.
const FORMAT = 'cuefluent-session-continuation', POINTER = 'cuefluent-session-continues';
// Bounded reads: the marker, a window before it, and the successor's prefix.
const TAIL_WINDOW = 4 * 1024 * 1024, PREFIX_BYTES = 16 * 1024 * 1024, PREFIX_RECORDS = 16384;
const rootTypes = new Set(['user', 'assistant', 'system', 'attachment']);
// Source-shape refusals of the successor transcript. Privacy, storage and
// budget failures are not in this set and still stop the worker.
const UNREADABLE_SUCCESSOR = new Set(['SOURCE_IDENTITY_MISMATCH', 'UNSUPPORTED_SESSION_OWNERSHIP', 'UNSUPPORTED_CLAUDE_HEADER',
  'SESSION_HEADER_UNAVAILABLE', 'SESSION_HEADER_LIMIT', 'SOURCE_HEADER_LIMIT', 'INVALID_SESSION_RECORD', 'INVALID_SESSION_CLIENT_VERSION',
  'UNSUPPORTED_NATIVE_IDENTITY', 'SOURCE_CHANGED', 'UNSAFE_SESSION_SOURCE', 'WORKFLOW_PATH_MISSING', 'UNSAFE_WORKFLOW_PATH', 'ENOENT', 'ENOTDIR']);
const discontinuities = new Set(['relocated', 'continued-in', 'bridge-session', 'history-suppression',
  'content-replacement', 'fork-context-ref', 'observer-ref']);

/** Origin-keyed link: written once by the worker that read the marker. */
export const continuedPath = sessionId => `session-links/claude/continued/${nativeId(sessionId)}.json`;
/** Successor-keyed pointer to that link: the only way a session finds its predecessor. */
export const continuesPath = sessionId => `session-links/claude/continues/${nativeId(sessionId)}.json`;

// One exact record; a link never holds one past the reader's line limit.
function anchor(value) {
  keys(value, ['startByte', 'endByte', 'hash']); integer(value.startByte); integer(value.endByte); hash(value.hash);
  if (value.endByte <= value.startByte || value.endByte - value.startByte > SESSION_LINE_LIMIT) fail('INVALID_SESSION_CONTINUATION');
}
function validateLink(value) {
  try {
    keys(value, ['format', 'version', 'client', 'lineage', 'from', 'to', 'linkedAt']);
    if (value.format !== FORMAT || value.version !== 1 || value.client !== 'claude') fail('INVALID_SESSION_CONTINUATION');
    nativeId(value.lineage); timestamp(value.linkedAt);
    keys(value.from, ['sessionId', 'registrationId', 'sourcePath', 'sourceIdentity', 'marker']);
    keys(value.to, ['sessionId', 'registrationId', 'sourcePath', 'sourceIdentity', 'prefix', 'sessionKinds']);
    for (const side of [value.from, value.to]) {
      nativeId(side.sessionId); nativeId(side.registrationId); hash(side.sourceIdentity);
      if (!path.isAbsolute(string(side.sourcePath))) fail('INVALID_SESSION_CONTINUATION');
    }
    anchor(value.from.marker); anchor(value.to.prefix); claudeSessionKinds(value.to.sessionKinds);
    if (value.from.sessionId === value.to.sessionId || value.lineage === value.to.sessionId) fail('INVALID_SESSION_CONTINUATION');
    return value;
  } catch { fail('INVALID_SESSION_CONTINUATION'); }
}
function validatePointer(value) {
  try {
    keys(value, ['format', 'version', 'client', 'sessionId', 'from', 'lineage', 'linkHash']);
    if (value.format !== POINTER || value.version !== 1 || value.client !== 'claude') fail('INVALID_SESSION_CONTINUATION');
    nativeId(value.sessionId); nativeId(value.from); nativeId(value.lineage); hash(value.linkHash);
    return value;
  } catch { fail('INVALID_SESSION_CONTINUATION'); }
}
// Helper-owned canonical bytes only; duplicate keys or other encodings refuse.
async function readCanonical(store, name, validate) {
  const snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: 16384 });
  if (snapshot.bytes === null) return null;
  let value;
  try { value = intakeJSON(snapshot); } catch { fail('INVALID_SESSION_CONTINUATION'); }
  validate(value);
  if (!snapshot.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('INVALID_SESSION_CONTINUATION');
  return { value, hash: snapshot.hash };
}

/** The link recording that `sessionId` was continued elsewhere, or null. */
export async function readContinuedLink(store, sessionId) {
  const found = await readCanonical(store, continuedPath(sessionId), validateLink);
  if (found && found.value.from.sessionId !== sessionId) fail('INVALID_SESSION_CONTINUATION');
  return found;
}
/** The verified predecessor link of `sessionId`, or null. The pointer must name
 * the exact link bytes, so a replaced or partial record never joins a lineage. */
export async function readContinuesLink(store, sessionId) {
  const pointer = await readCanonical(store, continuesPath(sessionId), validatePointer);
  if (!pointer) return null;
  const link = await readContinuedLink(store, pointer.value.from);
  if (pointer.value.sessionId !== sessionId || !link || link.hash !== pointer.value.linkHash ||
      link.value.to.sessionId !== sessionId || link.value.lineage !== pointer.value.lineage) fail('INVALID_SESSION_CONTINUATION');
  return { link: link.value, linkHash: link.hash, pointerHash: pointer.hash };
}

/** Reader view for a session that continues a verified predecessor: the exact
 * last re-homed record (its end is the prefix boundary) and the accepted kind.
 * The saved record is re-read and compared on every use, whatever position the
 * caller then reads from: a prefix rewritten in place behind a floor or a
 * binding window fails `SOURCE_CHANGED` instead of lending the predecessor's
 * lineage. One bounded read of that record only; nothing else is scanned. */
export async function continuationTarget(found, source, registration = null, { observeRead = () => {} } = {}) {
  if (!found) return null;
  const to = found.link.to;
  if (to.sourcePath !== source.path || to.sourceIdentity !== source.fileIdentity ||
      (registration && to.registrationId !== registration.id)) fail('INVALID_SESSION_CONTINUATION');
  const { prefix } = to, length = prefix.endByte - prefix.startByte;
  // A pass too short of bytes for this one record stops as a budget, never as a change.
  if (workflowReadLimit(length) < length) fail('WORKER_READ_BUDGET');
  const read = await readSessionRange({ source, from: prefix.startByte, endByte: prefix.endByte, observeRead, maxRecords: 1, maxBytes: length,
    readHeader: claudeRegistrationHeader(source, { sessionKinds: to.sessionKinds }), verifyHeader: value => value });
  const record = read.records[0];
  if (read.blocked || read.limited || read.records.length !== 1 || record.startByte !== prefix.startByte ||
      record.endByte !== prefix.endByte || record.hash !== prefix.hash) fail('SOURCE_CHANGED');
  return Object.freeze({ prefix: Object.freeze({ ...prefix }), sessionKinds: to.sessionKinds });
}
/** Reader view for a session continued into a verified successor. */
export function continuationOrigin(found, source, registration = null) {
  if (!found) return null;
  const from = found.value.from;
  if (from.sourcePath !== source.path || from.sourceIdentity !== source.fileIdentity ||
      (registration && from.registrationId !== registration.id)) fail('INVALID_SESSION_CONTINUATION');
  return Object.freeze({ sessionId: found.value.to.sessionId, record: Object.freeze({ ...from.marker }) });
}

// The successor's record is the predecessor's, re-homed: same native identity,
// time and message. Envelope fields the client rewrites (session, kind, cwd,
// version, branch, parent chain) are not compared; human input must stay human.
const copyOf = (copy, original, from, to) => copy?.sessionId === to && original?.sessionId === from &&
  isNativeId(copy.uuid) && copy.uuid === original.uuid && copy.type === original.type && copy.timestamp === original.timestamp &&
  canonicalJSON(copy.message ?? null) === canonicalJSON(original.message ?? null) && isClaudeHumanRow(copy) === isClaudeHumanRow(original);
const ownedBy = (row, sessionId, kinds) => row.sessionId === sessionId && row.isSidechain === false && row.agentId == null &&
  row.forkedFrom == null && row.foreignToBridgeSession == null && (row.sessionKind == null || kinds.includes(row.sessionKind));

/** Verify a marker hint from the registered origin's reader and record the link
 * once. Runs inside the worker's intake transaction with collection authority
 * for the origin. Returns the link, or null when the successor is not (yet)
 * proven: unregistered, another route, already collected, or a mismatched or
 * unbounded prefix. Reads only the two registered sources, and the origin never
 * past `ceiling`, the paused scope's saved EOF. */
export async function linkClaudeContinuation(transaction, store, { source, registration, originKinds = [], hint, config, authorize, observeRead = () => {}, ceiling }) {
  keys(hint, ['sessionId', 'record']); nativeId(hint.sessionId); anchor(hint.record);
  const A = source.sessionId, B = hint.sessionId;
  if (source.client !== 'claude' || registration.sessionId !== A || B === A) return null;
  const originSelected = { client: 'claude', sessionId: A, path: source.path, projectRoot: source.projectRoot };
  // 1. The exact marker, followed by nothing but the session bookkeeping the
  // client writes after it (no root row or other discontinuity).
  const origin = claudeHeaderRow(originSelected, { sessionKinds: originKinds });
  const marker = await readSessionRange({ source, from: hint.record.startByte, endByte: hint.record.endByte, observeRead,
    readHeader: origin.verify, verifyHeader: value => value, maxBytes: 64 * 1024, maxRecords: 1 });
  if (marker.blocked || marker.limited || marker.records.length !== 1 || marker.readEnd !== hint.record.endByte) return null;
  const markerRecord = marker.records[0];
  if (markerRecord.hash !== hint.record.hash || markerRecord.startByte !== hint.record.startByte ||
      claudeContinuedIn(markerRecord.value, source) !== B) return null;
  // Under a pause, bytes past the saved EOF are never read: they could hold
  // anything, so the marker cannot be shown to end the origin yet.
  if (ceiling !== undefined && marker.snapshotEnd > ceiling) return null;
  if (marker.snapshotEnd > hint.record.endByte) {
    // Read only up to what the marker read observed, which is within any
    // ceiling. The file can keep growing meanwhile: those bytes stay unread,
    // and under a pause they leave the marker unproven, as above.
    const tail = await readClaudeMarkerTail({ source, from: hint.record.endByte, endByte: marker.snapshotEnd, observeRead,
      readHeader: claudeRegistrationHeader(originSelected, { sessionKinds: originKinds }), verifyHeader: value => value });
    if (tail.kind !== 'metadata' || (ceiling !== undefined && tail.snapshotEnd > ceiling)) return null;
  }
  const originHeader = origin.out.row;
  // 2. The origin's last human input before the marker, from a bounded window.
  const windowStart = Math.max(0, hint.record.startByte - TAIL_WINDOW);
  const tail = await readSessionRange({ source, from: windowStart, endByte: hint.record.startByte, startsMidRecord: windowStart > 0, observeRead,
    readHeader: claudeRegistrationHeader(originSelected, { sessionKinds: originKinds }), verifyHeader: value => value, maxBytes: TAIL_WINDOW, maxRecords: PREFIX_RECORDS });
  if (tail.blocked || tail.limited || tail.pendingTail) return null;
  const lastHuman = tail.records.map(record => record.value).filter(row => row?.sessionId === A && isClaudeHumanRow(row)).at(-1);
  if (!lastHuman || !isNativeId(lastHuman.uuid)) return null;
  // 3. The successor registered through its own hooks for this route, project
  // and collection, as the origin's sibling transcript, and was never collected.
  const { registration: successor } = await readRegistration(store, { client: 'claude', sessionId: B });
  if (!successor || successor.collectionId !== registration.collectionId || successor.routeId !== registration.routeId ||
      successor.projectRoot !== registration.projectRoot ||
      successor.sourcePath !== path.join(path.dirname(source.path), `${B}.jsonl`)) return null;
  const route = await resolveWorkflowRoute(config, successor);
  if (!route.intended?.collect || route.collection.id !== registration.collectionId || route.route.id !== successor.routeId ||
      await collectionGrantHash(config, route.route.id, successor) !== successor.grantHash) return null;
  if ((await readSelection(store, { client: 'claude', sessionId: B })).state !== null) return null;
  // 4. The successor's own header fixes its session kind; its prefix re-homes the
  // origin's first record and runs through the origin's last human input. A
  // successor that cannot be read this way is simply not linked; the origin's
  // own collection continues and keeps its marker diagnostic.
  const successorSelected = { client: 'claude', sessionId: B, path: successor.sourcePath, projectRoot: successor.cwd };
  let kinds, successorSource, rows;
  try {
    if (await canonicalWorkflowProject(successor.cwd) !== source.projectRoot) return null;
    const probe = claudeHeaderRow(successorSelected, { sessionKinds: ['bg'] });
    const inspected = await inspectSourceBoundary(successorSelected, { verifyHeader: probe.verify });
    if (inspected.status !== 'registered') return null;
    kinds = probe.out.row.sessionKind == null ? [] : ['bg'];
    successorSource = inspected.source;
    rows = await readSessionRange({ source: successorSource, from: 0, observeRead, maxBytes: PREFIX_BYTES, maxRecords: PREFIX_RECORDS,
      readHeader: claudeRegistrationHeader(successorSelected, { sessionKinds: kinds }), verifyHeader: value => value });
  } catch (error) {
    if (UNREADABLE_SUCCESSOR.has(error.code)) return null;
    throw error;
  }
  if (rows.blocked) return null;
  let first = true, prefix = null;
  for (const record of rows.records) {
    const row = record.value;
    if (!row || typeof row !== 'object' || discontinuities.has(row.type)) return null;
    if (!rootTypes.has(row.type)) {
      if (row.sessionId !== undefined && row.sessionId !== B) return null;
      continue; // Known metadata is checked by the reader that later reads it.
    }
    if (!ownedBy(row, B, kinds)) return null;
    if (first && !copyOf(row, originHeader, A, B)) return null;
    first = false;
    if (row.uuid === lastHuman.uuid) {
      if (!copyOf(row, lastHuman, A, B)) return null;
      prefix = { startByte: record.startByte, endByte: record.endByte, hash: record.hash }; break;
    }
  }
  if (prefix === null) return null;
  // 5. Record once: the link, then its pointer. A lineage root carries over
  // from a predecessor of the origin, so chains resolve with one read.
  const prior = await readContinuesLink(store, A);
  const link = { format: FORMAT, version: 1, client: 'claude', lineage: prior?.link.lineage ?? A,
    from: { sessionId: A, registrationId: registration.id, sourcePath: source.path, sourceIdentity: source.fileIdentity, marker: { ...hint.record } },
    to: { sessionId: B, registrationId: successor.id, sourcePath: successorSource.path, sourceIdentity: successorSource.fileIdentity, prefix, sessionKinds: kinds },
    linkedAt: new Date().toISOString() };
  validateLink(link);
  if (await intakeSnapshot(store, 'state', continuesPath(B), { maxBytes: 16384 }).then(value => value.bytes !== null)) return null;
  await authorize();
  await replaceIntakeJSON(transaction, continuedPath(A), link, null);
  return ensureContinuesPointer(transaction, store, await readContinuedLink(store, A), authorize);
}

/** Publish the successor's pointer for an existing link, if it is missing; a
 * different pointer is a conflict, never replaced. */
export async function ensureContinuesPointer(transaction, store, found, authorize) {
  const { value: link, hash: linkHash } = found;
  const pointer = { format: POINTER, version: 1, client: 'claude', sessionId: link.to.sessionId, from: link.from.sessionId, lineage: link.lineage, linkHash };
  const existing = await readCanonical(store, continuesPath(link.to.sessionId), validatePointer);
  if (existing) {
    if (canonicalJSON(existing.value) !== canonicalJSON(pointer)) fail('INVALID_SESSION_CONTINUATION');
    return link;
  }
  await authorize();
  await replaceIntakeJSON(transaction, continuesPath(link.to.sessionId), pointer, null);
  return link;
}
