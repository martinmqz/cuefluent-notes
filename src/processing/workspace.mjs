import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { validateSettings } from '../core/settings.mjs';
import { assertChain, assertDirectory, assertRegularFile, inspectAncestors, lstatOrNull, pinDirectory, relativePath } from '../storage/paths.mjs';
import { hashBytes, readSnapshot } from '../storage/files.mjs';
import { NOTE_PROFILE, assertOrdinaryTarget, assertValidNote, validateNote, createGeneratedNote, decodeNote, isNoteTimestamp, preserveMetadata } from '../notes/index.mjs';

export const WORKSPACE_LIMITS = Object.freeze({ contextBytes: 64 * 1024, draftBytes: 128 * 1024, privateBytes: 64 * 1024 * 1024,
  fileBytes: NOTE_PROFILE.fileBytes, readBytes: 8192, targets: 128, drafts: 64, listEntries: 8192, listResults: 100, edits: 128 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const freeze = value => { if (value && typeof value === 'object' && !(value instanceof Uint8Array)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const targetSchema = { type: 'string', minLength: 1, maxLength: 32768 };
const cursorSchema = schema({ sourceHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, filterHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, offset: { type: 'integer', minimum: 0 } }, ['sourceHash', 'filterHash', 'offset']);
/** Stable MCP tool definitions. manifest() is deliberately not a model tool. */
export const NOTE_WORKSPACE_TOOLS = freeze([
  { name: 'list_notes', description: 'List one notes directory with bounded pagination. Listing does not read a note or authorize its replacement. The logs directory is reserved.',
    inputSchema: schema({ directory: { type: 'string', maxLength: 32768 }, cursor: { type: 'string', maxLength: 32768 }, limit: { type: 'integer', minimum: 1, maximum: WORKSPACE_LIMITS.listResults } }) },
  { name: 'read_note', description: 'Read exact UTF-8 byte ranges from a pinned original note version. Repeated reads retain the same hash. Read an existing target before drafting. All returned note context shares a 64 KiB budget.',
    inputSchema: schema({ target: targetSchema, start: { type: 'integer', minimum: 0, maximum: NOTE_PROFILE.fileBytes }, maxBytes: { type: 'integer', minimum: 1, maximum: WORKSPACE_LIMITS.readBytes } }, ['target']) },
  { name: 'draft_note', description: 'Keep a complete proposed note privately. Supply complete content or sequential exact unique oldText/newText edits against the pinned original. Each call starts from the original, preserves metadata and aliases, and returns only a receipt. New targets must be absent. Submitted output shares a 128 KiB budget.',
    inputSchema: { ...schema({ target: targetSchema, content: { type: 'string', maxLength: WORKSPACE_LIMITS.draftBytes },
      edits: { type: 'array', minItems: 1, maxItems: WORKSPACE_LIMITS.edits, items: schema({ oldText: { type: 'string', minLength: 1, maxLength: WORKSPACE_LIMITS.draftBytes }, newText: { type: 'string', maxLength: WORKSPACE_LIMITS.draftBytes } }, ['oldText', 'newText']) },
      summary: { type: 'string', minLength: 1, maxLength: 1024 }, heading: { type: ['string', 'null'], minLength: 1, maxLength: 512 }, usefulChange: { type: 'boolean' } }, ['target', 'summary']),
      oneOf: [{ required: ['content'], not: { required: ['edits'] } }, { required: ['edits'], not: { required: ['content'] } }] } },
  { name: 'read_activity_log', description: 'Query bounded activity-log entries as pointers to notes. Read those notes before making substantive claims. Requires the trusted annual-log reader and shares the 64 KiB context budget.',
    inputSchema: schema({ year: { type: 'integer', minimum: 1000, maximum: 9999 }, from: { type: 'string', maxLength: 40 }, to: { type: 'string', maxLength: 40 }, target: targetSchema,
      projectId: { type: 'string', minLength: 1, maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: cursorSchema }, ['year']) },
  { name: 'finish_drafting', description: 'Finish drafting once with drafted or nothing-useful. Nothing-useful requires no changed drafts. After success, no further workspace tool may run. This does not save notes.',
    inputSchema: schema({ outcome: { type: 'string', enum: ['drafted', 'nothing-useful'] } }, ['outcome']) },
]);
function object(value, keys, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('WORKSPACE_ARGUMENT', 'Tool arguments must be plain data.');
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(entries).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(entries[key], 'value') || !entries[key].enumerable) ||
      required.some(key => !Object.hasOwn(entries, key))) fail('WORKSPACE_ARGUMENT', 'Unsupported or missing tool arguments.');
}
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('WORKSPACE_ARGUMENT', 'Tool range exceeds its supported bounds.'); return value; }
function line(value, max, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) fail('WORKSPACE_ARGUMENT', 'Provide bounded nonempty text on one line.');
  return value;
}
const targetKey = value => value.normalize('NFC').toLowerCase();
const continuation = (bytes, at) => at < bytes.length && (bytes[at] & 0xc0) === 0x80;

/** Draft-only capability: no writes, mkdir, shell or model launch. Tool responses
 * contain bounded context/receipts; only the trusted manifest() consumer receives
 * complete private proposed bytes. File expectations never refresh after read.
 */
export async function openNoteWorkspace({ project: inputProject, runId, skillVersion, now = new Date().toISOString(), limits: inputLimits = {}, readActivityLog = null } = {}) {
  const project = validateSettings({ schemaVersion: 1, projects: [inputProject] }).projects[0];
  if (typeof runId !== 'string' || !UUID.test(runId) || typeof skillVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(skillVersion) || !isNoteTimestamp(now)) fail('WORKSPACE_CONTEXT_INVALID', 'A validated run identity, plugin version and timestamp are required.');
  if (readActivityLog !== null && typeof readActivityLog !== 'function') fail('WORKSPACE_CONTEXT_INVALID', 'The activity-log reader must be a trusted capability.');
  object(inputLimits, Object.keys(WORKSPACE_LIMITS));
  const limits = { ...WORKSPACE_LIMITS };
  for (const [key, value] of Object.entries(inputLimits)) limits[key] = integer(value, 1, limits[key]);
  const root = project.destination.kind === 'file' ? path.dirname(project.destination.path) : project.destination.path;
  const pin = await pinDirectory(root), originals = new Map(), drafts = new Map(), spellings = new Map();
  // One terminal receipt remains available even after ordinary context is full.
  const finishBytes = Math.max(...['drafted', 'nothing-useful'].map(outcome => Buffer.byteLength(JSON.stringify({ outcome, drafts: limits.drafts }))));
  if (limits.contextBytes < finishBytes) fail('WORKSPACE_CONTEXT_INVALID', 'The context budget must include a terminal drafting receipt.');
  let contextBytes = 0, draftBytes = 0, privateBytes = 0, finished = null, tail = Promise.resolve();
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const active = async () => { if (finished) fail('WORKSPACE_FINISHED', 'Drafting has already finished.'); await assertDirectory(pin); };
  const visible = (result, terminal = false) => {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (contextBytes + bytes > limits.contextBytes - (terminal ? 0 : finishBytes)) fail('WORKSPACE_CONTEXT_LIMIT', 'The model-visible note context budget is exhausted.');
    contextBytes += bytes; return freeze(result);
  };
  function target(input, ordinary = true) {
    if (typeof input !== 'string' || input.length > 32768) fail('WORKSPACE_ARGUMENT', 'A bounded note target is required.');
    const relative = path.isAbsolute(input) ? path.relative(root, input).split(path.sep).join('/') : input;
    if (relative.split('/').some(part => /^(?:com[¹²³]|lpt[¹²³])(?:\.|$)/i.test(part))) fail('PATH_INVALID', 'Reserved Windows device names are not portable note targets.');
    const file = relativePath(pin, relative);
    if (path.isAbsolute(input) && file !== input) fail('NOTE_TARGET_INVALID', 'Use a canonical note target.');
    if (ordinary) assertOrdinaryTarget(project, file);
    const key = targetKey(file), prior = spellings.get(key);
    if (prior && prior !== file) fail('WORKSPACE_TARGET_ALIAS', 'Two target spellings resolve to the same portable note name.');
    spellings.set(key, file); return { file, relative, key };
  }
  async function inspect(selected, { absentOnly = false } = {}) {
    const parent = await inspectAncestors(path.dirname(selected.file), { allowMissing: true });
    await assertDirectory(pin);
    const stat = await lstatOrNull(selected.file);
    if (stat) {
      assertRegularFile(selected.file, stat);
      if (absentOnly) fail('WORKSPACE_NOTE_UNREAD', 'Read the existing note before drafting an update.');
    }
    let snapshot = null;
    if (stat && privateBytes >= limits.privateBytes) fail('WORKSPACE_PRIVATE_LIMIT', 'The private note workspace budget is exhausted.');
    if (!absentOnly && parent.at(-1)?.path === path.dirname(selected.file)) snapshot = await readSnapshot(pin, selected.relative, { maxBytes: Math.min(limits.fileBytes, limits.privateBytes - privateBytes), missing: true });
    await assertChain(parent); await assertDirectory(pin);
    if (absentOnly && await lstatOrNull(selected.file)) fail('WORKSPACE_NOTE_UNREAD', 'An unread target must remain absent.');
    if (absentOnly && snapshot) fail('WORKSPACE_NOTE_UNREAD', 'An unread target must remain absent.');
    if (snapshot) decodeNote(snapshot.bytes);
    return { ...selected, bytes: snapshot?.bytes ?? null, hash: snapshot?.hash ?? null, noteId: randomUUID(), binding: freeze({ root, parent }) };
  }
  function retain(snapshot, collection) {
    if (originals.size >= limits.targets) fail('WORKSPACE_TARGET_LIMIT', 'Too many note versions are retained in one workspace.');
    const size = snapshot.bytes?.length ?? 0;
    if (privateBytes + size > limits.privateBytes) fail('WORKSPACE_PRIVATE_LIMIT', 'The private note workspace budget is exhausted.');
    privateBytes += size; collection.set(snapshot.key, snapshot); return snapshot;
  }
  async function read_note(input) {
    object(input, ['target', 'start', 'maxBytes'], ['target']); await active();
    const selected = target(input.target), start = integer(input.start === undefined ? 0 : input.start, 0, limits.fileBytes), maxBytes = integer(input.maxBytes === undefined ? limits.readBytes : input.maxBytes, 1, limits.readBytes);
    const snapshot = originals.get(selected.key) ?? retain(await inspect(selected), originals);
    await assertChain(snapshot.binding.parent);
    if (!snapshot.bytes) return visible({ target: snapshot.file, exists: false, hash: null, totalBytes: 0, start: 0, end: 0, next: null, content: '' });
    if (start > snapshot.bytes.length || continuation(snapshot.bytes, start)) fail('WORKSPACE_RANGE_INVALID', 'The requested byte offset is not a UTF-8 boundary.');
    let end = Math.min(snapshot.bytes.length, start + maxBytes);
    while (end > start && continuation(snapshot.bytes, end)) end--;
    if (end === start && start !== snapshot.bytes.length) fail('WORKSPACE_RANGE_INVALID', 'The range cannot contain one complete UTF-8 character.');
    return visible({ target: snapshot.file, exists: true, hash: snapshot.hash, totalBytes: snapshot.bytes.length, start, end,
      next: end < snapshot.bytes.length ? end : null, content: decodeNote(snapshot.bytes.subarray(start, end)) });
  }
  async function list_notes(input = {}) {
    object(input, ['directory', 'cursor', 'limit']); await active();
    const limit = integer(input.limit === undefined ? 25 : input.limit, 1, limits.listResults), cursor = input.cursor === undefined ? '' : input.cursor;
    if (typeof cursor !== 'string' || cursor.length > 32768 || /[\p{Cc}\p{Cs}]/u.test(cursor)) fail('WORKSPACE_ARGUMENT', 'Invalid directory cursor.');
    if (input.directory !== undefined && typeof input.directory !== 'string') fail('WORKSPACE_ARGUMENT', 'A portable directory path is required.');
    if (project.destination.kind === 'file') {
      if (input.directory || cursor) fail('WORKSPACE_ARGUMENT', 'The project has one explicit file destination.');
      const selected = target(project.destination.path), stat = await lstatOrNull(selected.file);
      if (stat) assertRegularFile(selected.file, stat);
      await assertDirectory(pin); return visible({ entries: stat ? [{ target: selected.file, kind: 'note' }] : [], nextCursor: null });
    }
    const directory = input.directory ? path.dirname(target(path.isAbsolute(input.directory) ? path.join(input.directory, 'workspace-list.md') : `${input.directory}/workspace-list.md`).file) : root;
    const chain = await inspectAncestors(directory), candidates = []; let count = 0;
    const opened = await fs.opendir(directory);
    for await (const entry of opened) {
      if (++count > limits.listEntries) fail('WORKSPACE_LIST_LIMIT', 'Narrow the directory listing to stay within its inspection budget.');
      if (directory === root && entry.name.toLowerCase() === 'logs') continue;
      const file = path.join(directory, entry.name), relative = path.relative(root, file).split(path.sep).join('/');
      if (relative <= cursor) continue;
      if (!entry.isDirectory() && !/\.md$/i.test(entry.name)) continue;
      // An unsafe unrelated entry cannot authorize access or make every safe
      // sibling unavailable. Direct reads/drafts retain their strict checks.
      try { relativePath(pin, relative); } catch (error) { if (error.code === 'PATH_INVALID') continue; throw error; }
      const stat = await lstatOrNull(file);
      if (!stat) fail('WORKSPACE_LIST_CHANGED', 'The notes directory changed during inspection.');
      if (stat.isDirectory() && !stat.isSymbolicLink()) candidates.push({ target: file, kind: 'directory', relative });
      else {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
        assertRegularFile(file, stat); candidates.push({ target: file, kind: 'note', relative });
      }
      candidates.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
      if (candidates.length > limit + 1) candidates.pop();
    }
    await assertChain(chain); await assertDirectory(pin);
    return visible({ entries: candidates.slice(0, limit).map(({ target, kind }) => ({ target, kind })), nextCursor: candidates.length > limit ? candidates[limit - 1].relative : null });
  }
  async function draft_note(input) {
    object(input, ['target', 'content', 'edits', 'summary', 'heading', 'usefulChange'], ['target', 'summary']); await active();
    if (Object.hasOwn(input, 'content') === Object.hasOwn(input, 'edits') || (input.usefulChange !== undefined && typeof input.usefulChange !== 'boolean')) fail('WORKSPACE_ARGUMENT', 'Provide complete content or exact text edits.');
    const summary = line(input.summary, 1024), heading = line(input.heading ?? null, 512, true), selected = target(input.target);
    if (Object.hasOwn(input, 'content')) { if (typeof input.content !== 'string') fail('WORKSPACE_ARGUMENT', 'Draft content must be UTF-8 text.'); decodeNote(input.content); }
    else {
      if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > limits.edits || Object.keys(input.edits).length !== input.edits.length) fail('WORKSPACE_ARGUMENT', 'Provide a bounded dense array of exact edits.');
      for (const edit of input.edits) {
        object(edit, ['oldText', 'newText'], ['oldText', 'newText']);
        if (typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string') fail('WORKSPACE_ARGUMENT', 'Each edit needs nonempty exact old text and replacement text.');
        decodeNote(edit.oldText); decodeNote(edit.newText);
      }
    }
    const submitted = Buffer.byteLength(JSON.stringify(input));
    if (draftBytes + submitted > limits.draftBytes) fail('WORKSPACE_DRAFT_LIMIT', 'The cumulative submitted draft budget is exhausted.');
    const retained = originals.get(selected.key), original = retained ?? await inspect(selected, { absentOnly: true });
    if (!retained && originals.size >= limits.targets) fail('WORKSPACE_TARGET_LIMIT', 'Too many note versions are retained in one workspace.');
    await assertChain(original.binding.parent);
    let proposed = input.content;
    if (input.edits) {
      if (!original.bytes) fail('WORKSPACE_EDIT_BASE_MISSING', 'Exact edits require a previously read existing note.');
      proposed = decodeNote(original.bytes);
      for (const edit of input.edits) {
        const at = proposed.indexOf(edit.oldText);
        if (at < 0 || proposed.indexOf(edit.oldText, at + 1) >= 0) fail('WORKSPACE_EDIT_NOT_UNIQUE', 'Each edit must match exactly one occurrence in the pinned note version.');
        proposed = proposed.slice(0, at) + edit.newText + proposed.slice(at + edit.oldText.length); decodeNote(proposed);
      }
    }
    const bytes = original.bytes ? preserveMetadata(original.bytes, proposed, { usefulChange: input.usefulChange, updated: now, skillVersion }).bytes :
      createGeneratedNote(proposed, { id: original.noteId, now, skillVersion });
    if (bytes.length > limits.fileBytes) fail('NOTE_FILE_LIMIT', 'The complete proposed note exceeds its file profile.');
    if (!original.bytes && input.usefulChange === false) fail('WORKSPACE_ARGUMENT', 'A new note cannot be an unchanged outcome.');
    const unchanged = original.bytes !== null && bytes.equals(original.bytes);
    const validation = unchanged ? validateNote(bytes) : assertValidNote(bytes, { ...(original.bytes ? { existing: original.bytes } : { generated: true }) });
    if (original.bytes) {
      const old = validateNote(original.bytes), aliases = new Set(validation.sections.flatMap(section => section.aliases).map(alias => alias.normalize('NFKC').toLowerCase()));
      if (old.sections.some(section => section.aliases.some(alias => !aliases.has(alias.normalize('NFKC').toLowerCase())))) fail('NOTE_ALIASES_CHANGED', 'Preserve existing useful section aliases.');
    }
    const prior = drafts.get(selected.key);
    if (!prior && drafts.size >= limits.drafts) fail('WORKSPACE_DRAFT_LIMIT', 'Too many draft targets are retained.');
    if (privateBytes - (prior?.bytes.length ?? 0) + bytes.length > limits.privateBytes) fail('WORKSPACE_PRIVATE_LIMIT', 'The complete private draft exceeds the workspace budget.');
    const draft = { id: prior?.id ?? randomUUID(), target: original.file, expectedHash: original.hash, hash: hashBytes(bytes), summary, heading, bytes: Buffer.from(bytes), binding: original.binding };
    const receipt = visible({ id: draft.id, target: draft.target, hash: draft.hash, expectedHash: draft.expectedHash, bytes: draft.bytes.length, changed: draft.expectedHash !== draft.hash,
      warnings: validation.diagnostics.filter(item => unchanged || item.severity === 'warning').map(item => item.code) });
    // No fallible operation follows admission: a rejected receipt never changes
    // the draft set or consumes its submitted/private budgets.
    if (!retained) originals.set(selected.key, original);
    privateBytes += bytes.length - (prior?.bytes.length ?? 0); draftBytes += submitted;
    drafts.set(selected.key, draft); return receipt;
  }
  async function read_activity_log(input) {
    object(input, ['year', 'from', 'to', 'target', 'projectId', 'limit', 'cursor'], ['year']); await active();
    if (!readActivityLog || project.destination.kind !== 'directory') fail('WORKSPACE_LOG_UNAVAILABLE', 'A verified bounded activity-log reader is required.');
    integer(input.year, 1000, 9999); if (input.limit !== undefined) integer(input.limit, 1, 100);
    for (const key of ['from', 'to']) if (input[key] !== undefined && !isNoteTimestamp(input[key])) fail('WORKSPACE_ARGUMENT', 'Activity-log dates must be exact timestamps.');
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) fail('WORKSPACE_ARGUMENT', 'Activity-log dates are reversed.');
    const query = { ...input };
    if (input.target !== undefined) query.target = target(input.target).relative;
    if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId))) fail('WORKSPACE_ARGUMENT', 'Invalid activity-log project identity.');
    if (input.cursor !== undefined) {
      object(input.cursor, ['sourceHash', 'filterHash', 'offset'], ['sourceHash', 'filterHash', 'offset']);
      if (![input.cursor.sourceHash, input.cursor.filterHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail('WORKSPACE_ARGUMENT', 'Invalid activity-log cursor.');
      integer(input.cursor.offset, 0, Number.MAX_SAFE_INTEGER);
    }
    const result = await readActivityLog(freeze(structuredClone(query)));
    // The injected reader owns annual-file pinning. Admit only bounded inert JSON
    // into the model response; it cannot expose capabilities or private bytes.
    let nodes = 0, stringBytes = 0;
    function clone(value, depth = 0) {
      if (++nodes > 8192 || depth > 16) fail('WORKSPACE_LOG_INVALID', 'Activity-log output exceeds its structural budget.');
      if (typeof value === 'string') { stringBytes += Buffer.byteLength(value); if (stringBytes > limits.contextBytes) fail('WORKSPACE_CONTEXT_LIMIT', 'Activity-log output exceeds the note context budget.'); return value; }
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) fail('WORKSPACE_LOG_INVALID', 'Activity-log output must be dense JSON.');
        return Array.from({ length: value.length }, (_, index) => { const descriptor = Object.getOwnPropertyDescriptor(value, index); if (!Object.hasOwn(descriptor, 'value')) fail('WORKSPACE_LOG_INVALID', 'Activity-log output must be inert JSON.'); return clone(descriptor.value, depth + 1); });
      }
      if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('WORKSPACE_LOG_INVALID', 'Activity-log output must be inert JSON.');
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail('WORKSPACE_LOG_INVALID', 'Activity-log output must be inert JSON.');
      return Object.fromEntries(keys.map(key => [key, clone(descriptors[key].value, depth + 1)]));
    }
    return visible(clone(result));
  }
  async function finish_drafting(input) {
    object(input, ['outcome'], ['outcome']); await active();
    if (!['drafted', 'nothing-useful'].includes(input.outcome) || (input.outcome === 'drafted' && !drafts.size) ||
        (input.outcome === 'nothing-useful' && [...drafts.values()].some(draft => draft.hash !== draft.expectedHash))) fail('WORKSPACE_FINISH_CONFLICT', 'Choose an explicit outcome consistent with the private drafts.');
    for (const draft of drafts.values()) await assertChain(draft.binding.parent);
    const outcome = [...drafts.values()].some(draft => draft.hash !== draft.expectedHash) ? 'drafted' : 'nothing-useful';
    const result = visible({ outcome, drafts: outcome === 'drafted' ? drafts.size : 0 }, true);
    finished = outcome; return result;
  }
  return Object.freeze({ list_notes: input => serial(() => list_notes(input)), read_note: input => serial(() => read_note(input)), draft_note: input => serial(() => draft_note(input)),
    read_activity_log: input => serial(() => read_activity_log(input)), finish_drafting: input => serial(() => finish_drafting(input)),
    manifest: () => serial(async () => {
      if (!finished) fail('WORKSPACE_NOT_FINISHED', 'An explicit successful drafting outcome is required.');
      return freeze({ runId, outcome: finished, drafts: finished === 'drafted' ? [...drafts.values()].map(draft => ({ ...draft, bytes: Buffer.from(draft.bytes) })) : [] });
    }),
  });
}
