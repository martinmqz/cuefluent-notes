import { validateNotePublication } from './note-publication.mjs';
import { validateNoteBinding } from './note-binding.mjs';
import { validateDraftArtifactPointer } from './draft-artifacts.mjs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createProject, validateSettings } from './settings.mjs';

export const RUN_SCHEMA_VERSION = 1;
export const RUN_LIMITS = Object.freeze({ selection: 4096, drafts: 1024, warnings: 128, tokenLength: 1024, summaryLength: 1024, headingLength: 512 });
const FIELDS = ['schemaVersion', 'id', 'projectId', 'settings', 'scope', 'selection', 'attempt', 'phase', 'drafts', 'saved', 'warnings', 'cleanup', 'publication', 'logging', 'logEvents', 'logPublication', 'artifacts'];

function fail(code, message) {
  const error = new Error(message); error.code = code; throw error;
}

function invalid(message) { fail('RUN_INVALID', message); }

function record(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(descriptors, key)) ||
      keys.some(key => typeof key !== 'string' || !fields.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) {
    invalid(`${label} must contain exactly its supported data fields`);
  }
}

function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must be a bounded array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid(`${label} must be a dense data array`);
  const result = [];
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(descriptors, i) || !Object.hasOwn(descriptors[i], 'value') || !descriptors[i].enumerable) invalid(`${label} must be a dense data array`);
    result.push(descriptors[i].value);
  }
  return result;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    invalid(`${label} must be a lowercase UUID`);
  }
  return value;
}

function token(value, label) {
  if (typeof value !== 'string' || !value || value.length > RUN_LIMITS.tokenLength ||
      /^[.]{1,2}$/.test(value) || /[\s/\\\u0000-\u001f\u007f]/.test(value)) invalid(`${label} must be a bounded opaque identity`);
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid(`${label} must be an exact lowercase SHA-256 hash`);
  return value;
}

function line(value, max, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label} must be bounded nonempty text on one line`);
  return value;
}

function pathsFor(platform) { return platform === 'win32' || (platform === undefined && process.platform === 'win32') ? path.win32 : path.posix; }
function key(target, paths) { return paths === path.win32 ? target.toLowerCase() : target; }
const portableTargetKey = target => target.normalize('NFC').toLowerCase();

export const cleanupContext = runId => createHash('sha256').update(`cuefluent-cleanup\0${uuid(runId, 'run.id')}`).digest('hex');

function cleanupState(input, runId, phase, selection) {
  record(input, ['next', 'ack'], 'cleanup');
  if (!Number.isSafeInteger(input.next) || input.next < 0 || input.next > selection.length ||
      (phase !== 'cleanup' && (input.next !== 0 || input.ack !== null))) invalid('Invalid cleanup progress');
  let ack = null;
  if (input.ack !== null) {
    const value = input.ack;
    record(value, ['schema', 'queueId', 'transactionId', 'context', 'index', 'id', 'hash'], 'cleanup cursor');
    const selected = selection[input.next - 1];
    if (value.schema !== 1 || !selected || value.index !== input.next - 1 || value.context !== cleanupContext(runId) ||
        value.id !== selected.recordId || value.hash !== selected.hash) invalid('Cleanup cursor must identify the last exact selected record');
    // Queue identity is a deterministic 128-bit directory identity, formatted
    // with separators; it is not a generated RFC UUID with version/variant bits.
    if (typeof value.queueId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.queueId)) invalid('Invalid queue identity');
    ack = Object.freeze({ schema: 1, queueId: value.queueId, transactionId: uuid(value.transactionId, 'queue.transactionId'),
      context: value.context, index: value.index, id: value.id, hash: value.hash });
  }
  return Object.freeze({ next: input.next, ack });
}

function selectionRecords(input, scope) {
  const records = array(input, RUN_LIMITS.selection, 'selection'), seen = new Set();
  if (scope.kind === 'direct' ? records.length !== 0 : !records.length) invalid('Direct notes select no queue input; processing runs must select input');
  return Object.freeze(records.map(item => {
    record(item, ['client', 'sessionId', 'recordId', 'hash'], 'selected record');
    if (!['claude', 'codex'].includes(item.client)) invalid('A selected record requires a supported client');
    const checked = { client: item.client, sessionId: token(item.sessionId, 'sessionId'), recordId: token(item.recordId, 'recordId'), hash: hash(item.hash, 'selected hash') };
    const identity = JSON.stringify([checked.client, checked.sessionId, checked.recordId]);
    if (seen.has(identity)) invalid('A record can be selected only once, without hash replacement');
    seen.add(identity); return Object.freeze(checked);
  }));
}

export function validateRunScope(input) {
  if (input?.kind === 'project') { record(input, ['kind'], 'scope'); return Object.freeze({ kind: 'project' }); }
  if (input?.kind === 'direct') {
    record(input, ['kind', 'requestHash'], 'scope');
    return Object.freeze({ kind: 'direct', requestHash: hash(input.requestHash, 'scope.requestHash') });
  }
  record(input, ['kind', 'client', 'sessionId'], 'scope');
  if (input.kind !== 'chat' || !['claude', 'codex'].includes(input.client)) invalid('Run scope must select a project or a native chat');
  return Object.freeze({ kind: 'chat', client: input.client, sessionId: token(input.sessionId, 'scope.sessionId') });
}

function draftDescriptors(input, project, platform) {
  const paths = pathsFor(platform), seenIds = new Set(), seenTargets = new Set();
  return Object.freeze(array(input, RUN_LIMITS.drafts, 'drafts').map(item => {
    record(item, ['id', 'target', 'expectedHash', 'hash', 'summary', 'heading', 'byteLength', 'binding'], 'draft');
    const id = uuid(item.id, 'draft.id');
    // Reuse the settings contract's canonical path and Markdown-file checks.
    const target = createProject({ id: 'draft-target', root: project.root, destination: { kind: 'file', path: item.target } }, { platform }).destination.path;
    const targetKey = key(target, paths), destinationKey = key(project.destination.path, paths);
    const uniqueKey = portableTargetKey(target);
    if (project.destination.kind === 'file') {
      if (targetKey !== destinationKey) invalid('A draft must target its pinned file destination');
    } else {
      const relative = paths.relative(destinationKey, targetKey);
      if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) invalid('A draft must stay within its pinned directory destination');
      if (portableTargetKey(relative.split(paths.sep)[0]) === 'logs') invalid('Activity logs are reserved writer targets');
    }
    const expectedHash = item.expectedHash === null ? null : hash(item.expectedHash, 'draft.expectedHash');
    const resultingHash = hash(item.hash, 'draft.hash');
    const summary = line(item.summary, RUN_LIMITS.summaryLength, 'draft.summary', !project.activityLog.enabled || expectedHash === resultingHash);
    const heading = line(item.heading, RUN_LIMITS.headingLength, 'draft.heading', true);
    if (!Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 10 * 1024 * 1024) invalid('Invalid draft byte length');
    const binding = validateNoteBinding(item.binding, target, project.destination, { platform });
    if (seenIds.has(id) || seenTargets.has(uniqueKey)) invalid('Draft IDs and target paths must be unique');
    seenIds.add(id); seenTargets.add(uniqueKey);
    return Object.freeze({ id, target, expectedHash, hash: resultingHash, summary, heading, byteLength: item.byteLength, binding });
  }));
}

function eventDescriptor(input) {
  record(input, ['id', 'savedAt'], 'log event');
  const id = uuid(input.id, 'event.id');
  if (typeof input.savedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.savedAt) ||
      !Number.isFinite(Date.parse(input.savedAt)) || new Date(input.savedAt).toISOString() !== input.savedAt) invalid('A save event requires its original UTC save time');
  return Object.freeze({ id, savedAt: input.savedAt });
}

function loggingBinding(input, project, platform) {
  if (input === null) return null;
  record(input, ['root', 'parent', 'seriesId', 'timezone'], 'logging binding');
  if (!project.activityLog.enabled || project.destination.kind !== 'directory') invalid('Logging requires an opted-in directory destination');
  const paths = pathsFor(platform);
  const binding = validateNoteBinding({ root: input.root, parent: input.parent }, paths.join(project.destination.path, 'logs', '0000.md'), project.destination, { platform });
  if (binding.parent.at(-1).path !== paths.join(binding.root, 'logs')) invalid('Pin the existing reserved logs directory');
  const seriesId = line(input.seriesId, 128, 'log.seriesId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(seriesId)) invalid('Invalid log series identity');
  if (typeof input.timezone !== 'string' || !input.timezone || input.timezone.length > 128 || input.timezone.trim() !== input.timezone || /^[+-]/.test(input.timezone) || /\p{Cc}/u.test(input.timezone)) invalid('Invalid log timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { invalid('Invalid log timezone'); }
  return Object.freeze({ ...binding, seriesId, timezone: input.timezone });
}

function publicationState(input, { id, phase, drafts, saved, settings, platform }) {
  if (input === null) return null;
  record(input, ['note', 'event'], 'publication');
  const note = validateNotePublication(input.note, { platform }), paths = pathsFor(platform);
  const draft = drafts.find(item => item.id === note.draftId);
  if (phase !== 'saving' || note.runId !== id || !draft || saved.some(item => item.draftId === draft.id) ||
      paths.join(note.root, ...note.relative.split('/')) !== draft.target || note.expectedHash !== draft.expectedHash ||
      note.hash !== draft.hash || note.bytes !== draft.byteLength || note.root !== draft.binding.root ||
      draft.binding.parent.some((item, index) => JSON.stringify(item) !== JSON.stringify(note.parent[index]))) invalid('Publication must match the exact unsaved draft and its original root binding');
  const event = input.event === null ? null : eventDescriptor(input.event);
  if (event && (!settings.activityLog.enabled || draft.hash === draft.expectedHash)) invalid('Only an opted-in changed note has a pending log event');
  return Object.freeze({ note, event });
}

/** Validate loaded metadata only; private draft bytes, filesystem identity,
 * exact source hashes, and OS worker liveness are checked by the storage caller.
 */
export function validateRun(input, { platform } = {}) {
  record(input, FIELDS, 'run');
  if (input.schemaVersion !== RUN_SCHEMA_VERSION) fail('RUN_SCHEMA_UNSUPPORTED', 'Unsupported run schema version');
  const project = validateSettings({ schemaVersion: 1, projects: [input.settings] }, { platform }).projects[0];
  if (input.projectId !== project.id) invalid('The run project must match its pinned settings');
  const id = uuid(input.id, 'run.id'), scope = validateRunScope(input.scope), selection = selectionRecords(input.selection, scope);
  if (scope.kind === 'chat' && selection.some(item => item.client !== scope.client || item.sessionId !== scope.sessionId)) invalid('A chat run can only select its bound native chat');
  let attempt = null;
  if (input.attempt !== null) {
    record(input.attempt, ['id'], 'attempt'); attempt = Object.freeze({ id: uuid(input.attempt.id, 'attempt.id') });
    if (attempt.id === id) invalid('The attempt must have its own identity');
  }
  if (!['drafting', 'review', 'saving', 'cleanup'].includes(input.phase)) invalid('Unsupported run phase');
  const drafts = draftDescriptors(input.drafts, project, platform), byId = new Map(drafts.map(draft => [draft.id, draft]));
  const seen = new Set(), saved = Object.freeze(array(input.saved, RUN_LIMITS.drafts, 'saved').map(item => {
    record(item, ['draftId', 'target', 'hash', 'changed'], 'saved note');
    const draft = byId.get(uuid(item.draftId, 'saved.draftId'));
    if (!draft || item.target !== draft.target || item.hash !== draft.hash || seen.has(item.draftId) || typeof item.changed !== 'boolean' ||
        (draft.expectedHash === draft.hash && item.changed)) invalid('Saved notes must match unique exact draft descriptors and their change outcome');
    seen.add(item.draftId); return Object.freeze({ draftId: item.draftId, target: item.target, hash: item.hash, changed: item.changed });
  }));
  if (input.phase === 'drafting' && (drafts.length || saved.length)) invalid('Drafting cannot contain a published draft set or save receipts');
  if (input.phase === 'review' && (project.saving !== 'review' || !drafts.length || saved.length)) invalid('Review requires unsaved complete review-mode drafts');
  if (input.phase === 'saving' && !drafts.length) invalid('Saving requires a complete nonempty draft set');
  if (input.phase === 'cleanup' && drafts.length !== saved.length) invalid('Cleanup requires every draft save to be confirmed');
  const warnings = Object.freeze(array(input.warnings, RUN_LIMITS.warnings, 'warnings').map(item => line(item, RUN_LIMITS.summaryLength, 'warning')));
  const cleanup = cleanupState(input.cleanup, id, input.phase, selection);
  const logging = loggingBinding(input.logging, project, platform);
  const publication = publicationState(input.publication, { id, phase: input.phase, drafts, saved, settings: project, platform });
  const seenEvents = new Set(), eventDrafts = new Set();
  const logEvents = Object.freeze(array(input.logEvents, RUN_LIMITS.drafts, 'logEvents').map(item => {
    record(item, ['draftId', 'id', 'savedAt', 'confirmed', 'failure'], 'saved log event');
    const receipt = saved.find(savedNote => savedNote.draftId === item.draftId);
    const event = eventDescriptor({ id: item.id, savedAt: item.savedAt });
    if (!project.activityLog.enabled || !receipt?.changed || typeof item.confirmed !== 'boolean' ||
        (item.failure !== null && (typeof item.failure !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.failure))) || (item.confirmed && item.failure !== null) || seenEvents.has(event.id) || eventDrafts.has(item.draftId)) invalid('Log events must correspond to unique actual changed notes');
    seenEvents.add(event.id); eventDrafts.add(item.draftId);
    return Object.freeze({ draftId: item.draftId, ...event, confirmed: item.confirmed, failure: item.failure });
  }));
  let logPublication = null;
  if (input.logPublication !== null) {
    record(input.logPublication, ['eventId', 'note'], 'log publication');
    const eventId = uuid(input.logPublication.eventId, 'logPublication.eventId');
    const event = logEvents.find(item => item.id === eventId), note = validateNotePublication(input.logPublication.note, { platform });
    if (!logging || !['saving', 'cleanup'].includes(input.phase) || !event || event.confirmed || event.failure !== null || note.runId !== id || note.draftId !== eventId ||
        note.root !== logging.root || !/^logs\/[1-9][0-9]{3}\.md$/.test(note.relative) || JSON.stringify(note.parent) !== JSON.stringify(logging.parent)) invalid('A log publication must match this run\'s pinned annual series and unconfirmed saved event');
    logPublication = Object.freeze({ eventId, note });
  }
  const artifacts = input.artifacts === null ? null : validateDraftArtifactPointer(input.artifacts);
  if (artifacts && (artifacts.runId !== id || artifacts.relative !== `store/projects/${createHash('sha256').update(project.id).digest('hex')}/drafts/${id}`)) invalid('Artifact intent must identify this project and run\'s exact private draft directory');
  return Object.freeze({ schemaVersion: RUN_SCHEMA_VERSION, id, projectId: project.id, settings: project, scope, selection, attempt,
    phase: input.phase, drafts, saved, warnings, cleanup, publication, logging, logEvents, logPublication, artifacts });
}

export function createRun(project, selection, { id = randomUUID(), platform, scope = { kind: 'project' } } = {}) {
  const pinned = validateSettings({ schemaVersion: 1, projects: [project] }, { platform }).projects[0];
  return validateRun({ schemaVersion: RUN_SCHEMA_VERSION, id, projectId: pinned.id, settings: pinned, scope, selection,
    attempt: null, phase: 'drafting', drafts: [], saved: [], warnings: [], cleanup: { next: 0, ack: null }, publication: null, logging: null, logEvents: [], logPublication: null, artifacts: null }, { platform });
}

/** Persist this progress before acknowledging the queue's one current journal.
 * Selected hashes remain until the run ends; no completed receipt store exists.
 */
export function advanceCleanup(run, attemptId, cursor, options = {}) {
  const checked = assertAttempt(run, attemptId, options);
  if (checked.phase !== 'cleanup' || checked.cleanup.ack !== null || cursor?.index !== checked.cleanup.next) fail('RUN_CLEANUP_INVALID', 'Finish the current cleanup acknowledgment before advancing.');
  return validateRun({ ...checked, cleanup: { next: checked.cleanup.next + 1, ack: cursor } }, options);
}

export function clearCleanupAcknowledgment(run, attemptId, cursor, options = {}) {
  const checked = assertAttempt(run, attemptId, options);
  if (!checked.cleanup.ack || JSON.stringify(checked.cleanup.ack) !== JSON.stringify(cursor)) fail('RUN_CLEANUP_INVALID', 'The queue acknowledgment must match the current cleanup cursor.');
  return validateRun({ ...checked, cleanup: { next: checked.cleanup.next, ack: null } }, options);
}

/** The caller must acquire OS liveness and mutation gates before superseding an
 * attempt. Supply a fresh, never-reused UUID; this function establishes no liveness.
 */
export function replaceAttempt(run, attemptId = randomUUID(), options = {}) {
  const checked = validateRun(run, options), id = uuid(attemptId, 'attempt.id');
  if (id === checked.attempt?.id) fail('RUN_ATTEMPT_REUSED', 'A replacement attempt requires a fresh identity');
  return validateRun({ ...checked, attempt: { id } }, options);
}

export function assertAttempt(run, attemptId, options = {}) {
  const checked = validateRun(run, options); uuid(attemptId, 'attempt.id');
  if (checked.attempt?.id !== attemptId) fail('RUN_ATTEMPT_STALE', 'The attempt no longer owns this run');
  return checked;
}

/** Release only after the caller's OS gate proves the worker/writer inactive. */
export function releaseAttempt(run, attemptId, options = {}) {
  return validateRun({ ...assertAttempt(run, attemptId, options), attempt: null }, options);
}

function phase(run, expected) {
  if (!expected.includes(run.phase)) fail('RUN_PHASE_INVALID', `This operation cannot run during ${run.phase}`);
}

/** A successful call publishes the complete descriptor set once. An explicit
 * empty set means nothing useful to save; malformed/failed output must not call it.
 * The caller has already verified hashes of the separate private draft bytes.
 */
export function publishDrafts(run, attemptId, drafts, options = {}) {
  const checked = assertAttempt(run, attemptId, options); phase(checked, ['drafting']);
  const published = draftDescriptors(drafts, checked.settings, options.platform);
  return validateRun({ ...checked, drafts: published, phase: !published.length ? 'cleanup' : checked.settings.saving === 'review' ? 'review' : 'saving' }, options);
}

export function readyForReview(run, attemptId, options = {}) {
  const checked = assertAttempt(run, attemptId, options); phase(checked, ['review']);
  return releaseAttempt(checked, attemptId, options);
}

/** The command caller establishes explicit save authorization for review mode. */
export function beginSaving(run, attemptId, options = {}) {
  const checked = assertAttempt(run, attemptId, options); phase(checked, ['review', 'saving']);
  return validateRun({ ...checked, phase: 'saving' }, options);
}

/** Record only an externally confirmed exact note replacement or durable receipt. */
export function markNoteSaved(run, attemptId, draftId, { changed, event = null, ...options } = {}) {
  const checked = assertAttempt(run, attemptId, options); phase(checked, ['saving']);
  const draft = checked.drafts.find(item => item.id === uuid(draftId, 'draft.id'));
  if (!draft) fail('RUN_DRAFT_MISSING', 'The saved note must belong to this exact draft set');
  if (changed === undefined) changed = draft.expectedHash !== draft.hash;
  if (typeof changed !== 'boolean' || (draft.expectedHash === draft.hash && changed)) invalid('The saved change outcome must match the draft');
  if (checked.saved.some(item => item.draftId === draftId)) return checked;
  const savedEvent = event ?? checked.publication?.event ?? null;
  if (changed && checked.settings.activityLog.enabled && !savedEvent) invalid('A changed opted-in note needs its durable original log event');
  const logEvents = savedEvent && changed ? [...checked.logEvents, { draftId, ...eventDescriptor(savedEvent), confirmed: false, failure: null }] : checked.logEvents;
  return validateRun({ ...checked, saved: [...checked.saved, { draftId, target: draft.target, hash: draft.hash, changed }], logEvents,
    publication: checked.publication?.note.draftId === draftId ? null : checked.publication }, options);
}

export function completeSaving(run, attemptId, options = {}) {
  const checked = assertAttempt(run, attemptId, options); phase(checked, ['saving', 'cleanup']);
  if (checked.saved.length !== checked.drafts.length) fail('RUN_SAVE_INCOMPLETE', 'Every note save must be confirmed before cleanup');
  return validateRun({ ...checked, phase: 'cleanup' }, options);
}

/** Call after revoking the attempt under OS liveness and mutation gates. The
 * returned disposition does not delete the run, queues, drafts, or saved notes.
 */
export function skipDisposition(run, options = {}) {
  const checked = validateRun(run, options);
  if (checked.attempt !== null) fail('RUN_ACTIVE_ATTEMPT', 'Revoke the inactive attempt under its OS gate before skipping');
  const complete = checked.phase === 'cleanup' || checked.phase === 'saving' && checked.saved.length === checked.drafts.length;
  return Object.freeze({ kind: complete ? 'finish-cleanup' : 'preserve-input', selection: checked.selection, saved: checked.saved });
}

/** Pin the annual series before the model runs; missing/broken log metadata is a
 * best-effort warning, never permission to invent a new series. */
export function pinRunLogging(run, attemptId, binding, options = {}) {
  const checked = assertAttempt(run, attemptId, options); phase(checked, ['drafting']);
  if (checked.logging !== null && JSON.stringify(checked.logging) !== JSON.stringify(binding)) fail('RUN_LOGGING_PINNED', 'The log series is already pinned for this run');
  return validateRun({ ...checked, logging: binding }, options);
}

export function setNotePublication(run, attemptId, note, { event = null, ...options } = {}) {
  const checked = assertAttempt(run, attemptId, options); phase(checked, ['saving']);
  if (checked.publication) {
    const previous = checked.publication.note;
    if (JSON.stringify({ ...previous, stage: null, capture: null }) !== JSON.stringify({ ...note, stage: null, capture: null }) ||
        (previous.stage && JSON.stringify(previous.stage) !== JSON.stringify(note.stage)) ||
        (previous.capture && JSON.stringify(previous.capture) !== JSON.stringify(note.capture)) ||
        (checked.publication.event && checked.publication.event.id !== event?.id)) fail('RUN_PUBLICATION_CHANGED', 'A pending publication cannot replace its original expectations or stage');
  }
  return validateRun({ ...checked, publication: { note, event } }, options);
}

export function confirmLogEvent(run, attemptId, eventId, options = {}) {
  const checked = assertAttempt(run, attemptId, options);
  if (!checked.logEvents.some(item => item.id === eventId && item.failure === null)) fail('RUN_LOG_EVENT_MISSING', 'The pending log event must belong to this current run');
  return validateRun({ ...checked, logEvents: checked.logEvents.map(item => item.id === eventId ? { ...item, confirmed: true } : item),
    logPublication: checked.logPublication?.eventId === eventId ? null : checked.logPublication }, options);
}

/** A known best-effort failure is final for this event in this run. A crash
 * before this disposition retains its exact publication for recovery. */
export function failLogEvent(run, attemptId, eventId, code, options = {}) {
  const checked = assertAttempt(run, attemptId, options);
  if (!checked.logEvents.some(item => item.id === eventId && !item.confirmed)) fail('RUN_LOG_EVENT_MISSING', 'The failed log event must belong to this current run');
  return validateRun({ ...checked, logEvents: checked.logEvents.map(item => item.id === eventId ? { ...item, failure: code } : item),
    logPublication: checked.logPublication?.eventId === eventId ? null : checked.logPublication }, options);
}

export function setLogPublication(run, attemptId, eventId, note, options = {}) {
  const checked = assertAttempt(run, attemptId, options), prior = checked.logPublication;
  if (prior && (prior.eventId !== eventId || JSON.stringify({ ...prior.note, stage: null, capture: null }) !== JSON.stringify({ ...note, stage: null, capture: null }) ||
      (prior.note.stage && JSON.stringify(prior.note.stage) !== JSON.stringify(note.stage)) ||
      (prior.note.capture && JSON.stringify(prior.note.capture) !== JSON.stringify(note.capture)))) fail('RUN_PUBLICATION_CHANGED', 'A pending log publication cannot replace its original expectations or stage');
  return validateRun({ ...checked, logPublication: { eventId, note } }, options);
}

/** Only after the writer reconciles/discards this exact owned public stage. */
export function clearLogPublication(run, attemptId, options = {}) {
  return validateRun({ ...assertAttempt(run, attemptId, options), logPublication: null }, options);
}

export function addRunWarning(run, attemptId, warning, options = {}) {
  const checked = assertAttempt(run, attemptId, options);
  line(warning, RUN_LIMITS.summaryLength, 'warning');
  if (checked.warnings.includes(warning)) return checked;
  const warnings = checked.warnings.length < RUN_LIMITS.warnings ? [...checked.warnings, warning] :
    [...checked.warnings.slice(0, RUN_LIMITS.warnings - 1), 'Additional problems were reported during this run.'];
  return validateRun({ ...checked, warnings }, options);
}
