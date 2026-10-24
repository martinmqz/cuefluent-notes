import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fail } from '../core/errors.mjs';
import { DRAFT_ARTIFACT_LIMITS as L, validateDraftArtifactManifest, validateDraftArtifactPointer } from '../core/draft-artifacts.mjs';
import { hashBytes, jsonBytes, readSnapshot } from './files.mjs';
import { assertChain, assertDirectory, assertRegularFile, createPrivateDirectory, fileIdentity, inspectParent, lstatOrNull, pinDirectory, relativePath, sameIdentity } from './paths.mjs';
import { assertEmptyPrivateReservation, assertPrivateAccess, establishWindowsPrivacy } from './platform.mjs';
import { readHandleStat, readPathStat } from './stat.mjs';

export { DRAFT_ARTIFACT_LIMITS, validateDraftArtifactManifest, validateDraftArtifactPointer } from '../core/draft-artifacts.mjs';
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const JOURNAL = 'journal.jsonl';
const lineBytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const conflict = message => fail('DRAFT_ARTIFACT_CONFLICT', message);
const invalid = message => fail('DRAFT_ARTIFACT_INVALID', message);
const stageName = id => `${id}.tmp`;
const finalName = id => `${id}.draft`;

function fields(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid('Artifact journal records must be plain data.');
  const descriptors = Object.getOwnPropertyDescriptors(input), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')) || actual.some(key => typeof key !== 'string' || !keys.includes(key))) invalid('Unsupported artifact journal fields.');
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
  catch (error) { if (!(process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code))) throw error; }
  finally { await handle?.close(); }
}

function publicPointer(runId, relative, directory, journal, manifestHash) {
  return validateDraftArtifactPointer({ schema: 1, runId, relative, directory, journal, manifestHash });
}

function reservation(pin, relative, runId) {
  if (pin?.private !== true) invalid('Draft artifacts require a pinned private store.');
  // Validate the complete relative reservation before creating anything.
  publicPointer(runId, relative, { device: '1', inode: '1' }, { device: '1', inode: '2' }, '0'.repeat(64));
  return relativePath(pin, relative);
}

async function location(pin, pointer) {
  const directory = reservation(pin, pointer.relative, pointer.runId);
  await assertDirectory(pin);
  const parent = await inspectParent(pin, pointer.relative), stat = await lstatOrNull(directory);
  if (!stat) { await assertChain(parent.chain); return null; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, pointer.directory)) conflict('The artifact run directory was replaced.');
  assertPrivateAccess(directory, stat);
  const local = await pinDirectory(directory, { private: true });
  await assertChain(parent.chain); await assertDirectory(pin);
  return { pin: local, parent, directory };
}

function parseRecord(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { invalid('A newline-complete artifact journal record is malformed; preserve it.'); }
  if (!lineBytes(value).equals(Buffer.concat([bytes, Buffer.from('\n')]))) invalid('Artifact journal records must use their exact canonical encoding.');
  return value;
}

async function load(pin, input) {
  const pointer = validateDraftArtifactPointer(input), place = await location(pin, pointer);
  if (!place) return { pointer, missing: true, manifest: null, entries: new Map(), phase: 'missing' };
  const snapshot = await readSnapshot(place.pin, JOURNAL, { missing: true, maxBytes: L.journalBytes });
  if (!snapshot) return { ...place, pointer, missing: true, manifest: null, entries: new Map(), phase: 'missing' };
  if (snapshot.identity.device !== pointer.journal.device || snapshot.identity.inode !== pointer.journal.inode) conflict('The artifact ownership journal was replaced.');
  const end = snapshot.bytes.lastIndexOf(10) + 1, tail = snapshot.bytes.subarray(end);
  const state = { ...place, pointer, snapshot, end, tail, manifest: null, entries: new Map(), phase: 'partial', missing: false };
  if (!end) return state;
  const lines = []; let cursor = 0;
  while (cursor < end) { const next = snapshot.bytes.indexOf(10, cursor); lines.push(snapshot.bytes.subarray(cursor, next)); cursor = next + 1; }
  if (lines.length > L.drafts * 3 + 3) invalid('The current-run artifact journal exceeds its bounded event profile.');
  const first = parseRecord(lines.shift()); fields(first, ['type', 'schema', 'manifest']);
  if (first.type !== 'manifest' || first.schema !== 1) invalid('Unsupported artifact manifest journal.');
  state.manifest = validateDraftArtifactManifest(first.manifest);
  if (state.manifest.runId !== pointer.runId || hashBytes(jsonBytes(state.manifest)) !== pointer.manifestHash) conflict('The immutable artifact manifest differs from the current run pointer.');
  state.phase = 'writing';
  for (const draft of state.manifest.drafts) state.entries.set(draft.id, { draft, status: 'unowned', identity: null });
  for (const line of lines) {
    const event = parseRecord(line);
    if (event.type === 'own') {
      fields(event, ['type', 'id', 'device', 'inode']);
      const entry = state.entries.get(event.id);
      if (!entry || entry.status !== 'unowned' || !['writing', 'discard'].includes(state.phase) ||
          typeof event.device !== 'string' || typeof event.inode !== 'string' || !/^(?:0|[1-9][0-9]{0,39})$/.test(event.device) || !/^(?:0|[1-9][0-9]{0,39})$/.test(event.inode)) invalid('Invalid artifact ownership transition.');
      entry.identity = { device: event.device, inode: event.inode }; entry.status = 'owned';
    } else if (event.type === 'complete') {
      fields(event, ['type', 'id']); const entry = state.entries.get(event.id);
      if (state.phase !== 'writing' || !entry || entry.status !== 'owned') invalid('Invalid artifact completion transition.');
      entry.status = 'complete';
    } else if (event.type === 'ready') {
      fields(event, ['type']);
      if (state.phase !== 'writing' || [...state.entries.values()].some(entry => entry.status !== 'complete')) invalid('Only a complete exact draft set can be ready.');
      state.phase = 'ready';
    } else if (event.type === 'discard') {
      fields(event, ['type']); if (!['writing', 'ready'].includes(state.phase)) invalid('Invalid artifact discard transition.'); state.phase = 'discard';
    } else if (event.type === 'deleted') {
      fields(event, ['type', 'id']); const entry = state.entries.get(event.id);
      if (state.phase !== 'discard' || !entry || !['owned', 'complete'].includes(entry.status)) invalid('Invalid artifact deletion transition.'); entry.status = 'deleted';
    } else invalid('Unsupported artifact journal event.');
  }
  return state;
}

async function append(state, event, { abortTail = false } = {}) {
  const line = event === null ? Buffer.alloc(0) : lineBytes(event);
  if (state.tail.length && !abortTail && (state.tail.length >= line.length || !line.subarray(0, state.tail.length).equals(state.tail))) conflict('The torn artifact journal differs from the exact proposed event.');
  if (state.end + line.length > L.journalBytes) invalid('The current-run artifact journal exceeds its bounded profile.');
  await assertDirectory(state.pin);
  const file = path.join(state.directory, JOURNAL), handle = await fs.open(file, constants.O_RDWR | NO_FOLLOW);
  try {
    const stat = await readHandleStat(handle); assertRegularFile(file, stat, state.pin);
    if (!sameIdentity(stat, state.pointer.journal) || stat.size !== state.snapshot.bytes.length) conflict('The artifact journal changed before append.');
    const actual = Buffer.alloc(stat.size); let cursor = 0;
    while (cursor < actual.length) { const read = await handle.read(actual, cursor, actual.length - cursor, cursor); if (!read.bytesRead) conflict('The artifact journal was shortened.'); cursor += read.bytesRead; }
    const observed = await readHandleStat(handle);
    if (observed.size !== stat.size || observed.mtimeNs !== stat.mtimeNs || observed.ctimeNs !== stat.ctimeNs) conflict('The artifact journal changed during verification.');
    if (hashBytes(actual) !== state.snapshot.hash) conflict('The artifact journal changed before append.');
    await assertDirectory(state.pin);
    if (state.tail.length) await handle.truncate(state.end);
    let offset = 0;
    while (offset < line.length) { const written = await handle.write(line, offset, line.length - offset, state.end + offset); if (!written.bytesWritten) conflict('The artifact journal write stopped.'); offset += written.bytesWritten; }
    await handle.sync();
    if (!sameIdentity(await readPathStat(file), state.pointer.journal)) conflict('The artifact journal changed during append.');
  } finally { await handle.close(); }
  await assertDirectory(state.pin);
}

async function inventory(state) {
  if (!state.directory) return [];
  const names = [], stream = await fs.opendir(state.directory);
  try {
    for await (const entry of stream) {
      names.push(entry.name);
      if (names.length > 2 * L.drafts + 1) conflict('Unexpected files exceed the bounded current-run artifact layout.');
    }
  } finally { try { await stream.close(); } catch (error) { if (error.code !== 'ERR_DIR_CLOSED') throw error; } }
  await assertDirectory(state.pin); return names;
}

async function payloads(state, entry) {
  const stage = path.join(state.directory, stageName(entry.draft.id)), final = path.join(state.directory, finalName(entry.draft.id));
  const a = await lstatOrNull(stage), b = await lstatOrNull(final);
  for (const [file, stat] of [[stage, a], [final, b]]) {
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink) || stat.size > L.fileBytes || (entry.identity && !sameIdentity(stat, entry.identity))) conflict('An artifact payload inode or link count changed.');
    if (!entry.identity && file === stage) assertEmptyPrivateReservation(file, stat);
    else assertPrivateAccess(file, stat);
  }
  if (a && b && (!entry.identity || a.nlink !== 2 || b.nlink !== 2 || !sameIdentity(a, fileIdentity(b)))) conflict('A final artifact name conflicts with its exact owned stage.');
  if ((a && !b && a.nlink !== 1) || (b && !a && b.nlink !== 1)) conflict('An artifact payload has an unknown hard link.');
  if (!entry.identity && (b || (a && a.size !== 0))) conflict('An unjournaled artifact payload is not an empty reserved stage.');
  return { stage, final, a, b };
}

async function reconcileLinks(state, entry, files) {
  if (files.a && files.b) {
    await assertDirectory(state.pin);
    if (!sameIdentity(await readPathStat(files.stage), entry.identity)) conflict('The artifact stage changed before reconciliation.');
    await fs.unlink(files.stage); await syncDirectory(state.directory);
  }
}

async function completePayload(state, entry, file) {
  const snapshot = await readSnapshot(state.pin, path.basename(file), { maxBytes: L.fileBytes });
  if (snapshot.identity.device !== entry.identity.device || snapshot.identity.inode !== entry.identity.inode || snapshot.hash !== entry.draft.hash || snapshot.bytes.length !== entry.draft.byteLength) conflict('A completed artifact differs from its immutable hash or inode.');
  return snapshot;
}

async function flushPayload(state, entry, file) {
  // Windows FlushFileBuffers needs write access even though this step changes no
  // bytes. The exact owned payload inode is still checked before flushing it.
  const handle = await fs.open(file, (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | NO_FOLLOW);
  try {
    const stat = await readHandleStat(handle); assertRegularFile(file, stat, state.pin);
    if (!sameIdentity(stat, entry.identity)) conflict('The artifact payload changed before durability was confirmed.');
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(state.directory); await assertDirectory(state.pin);
}

async function initializeEmptyReservation(pin, file, expected) {
  await assertDirectory(pin);
  const before = await readPathStat(file);
  if (!sameIdentity(before, fileIdentity(expected))) conflict('The empty artifact reservation changed before initialization.');
  assertEmptyPrivateReservation(file, before);
  establishWindowsPrivacy(file);
  const after = await readPathStat(file);
  if (!sameIdentity(after, fileIdentity(expected)) || after.size !== 0) conflict('The empty artifact reservation changed during initialization.');
  assertRegularFile(file, after, pin); await assertDirectory(pin);
}

/** Persist the returned pointer before the initial manifest bytes enter the
 * journal. existingPointer is mandatory when retrying a nonempty journal.
 */
export async function prepareDraftArtifacts(pin, relative, input, { persistIntent, existingPointer } = {}) {
  const manifest = validateDraftArtifactManifest(input), directory = reservation(pin, relative, manifest.runId), manifestHash = hashBytes(jsonBytes(manifest));
  if (typeof persistIntent !== 'function') invalid('Artifact preparation requires a durable current-run pointer callback.');
  const parent = await inspectParent(pin, relative);
  const local = await createPrivateDirectory(directory);
  await assertChain(parent.chain); await assertDirectory(pin);
  const known = existingPointer === undefined ? null : validateDraftArtifactPointer(existingPointer);
  if (!known && (await inventory({ directory, pin: local })).some(name => name !== JOURNAL)) conflict('An unprepared artifact directory contains unexpected files.');
  const before = await lstatOrNull(path.join(directory, JOURNAL));
  if (known && (!sameIdentity(await readPathStat(directory), known.directory) || known.relative !== relative || known.runId !== manifest.runId || known.manifestHash !== manifestHash)) conflict('Artifact preparation cannot refresh its current-run pointer.');
  if (before) {
    if (!known) {
      await initializeEmptyReservation(local, path.join(directory, JOURNAL), before);
    }
    assertRegularFile(path.join(directory, JOURNAL), before, local);
    if (known ? !sameIdentity(before, known.journal) : before.size !== 0) conflict('A nonempty artifact journal requires its exact current-run pointer.');
  } else {
    if (known) conflict('The recorded artifact journal disappeared.');
    const handle = await fs.open(path.join(directory, JOURNAL), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
    try { establishWindowsPrivacy(path.join(directory, JOURNAL)); assertRegularFile(path.join(directory, JOURNAL), await readHandleStat(handle), local); await handle.sync(); }
    finally { await handle.close(); }
  }
  const pointer = publicPointer(manifest.runId, relative, fileIdentity(await readPathStat(directory)), fileIdentity(await readPathStat(path.join(directory, JOURNAL))), manifestHash);
  const state = await load(pin, pointer), names = await inventory(state);
  if (!known && names.some(name => name !== JOURNAL)) conflict('An unprepared artifact directory contains unexpected files.');
  if (known && state.manifest) await preflight(state);
  await syncDirectory(directory); await syncDirectory(path.dirname(directory)); await assertChain(parent.chain); await persistIntent(pointer);
  if (!state.manifest) await append(state, { type: 'manifest', schema: 1, manifest });
  else if (JSON.stringify(state.manifest) !== JSON.stringify(manifest) || state.phase === 'discard') conflict('The completed artifact manifest is immutable.');
  return pointer;
}

/** One bounded draft per mutation. Omitting bytes recovers only a fully written,
 * hash-matching payload; a partial result requires explicit discard/redrafting.
 */
export async function writeDraftArtifact(pin, input, id, bytes) {
  let state = await load(pin, input);
  if (!state.manifest || state.phase === 'discard') conflict('The artifact set is not available for draft publication.');
  await preflight(state);
  let entry = state.entries.get(id);
  if (!entry) invalid('The draft does not belong to this immutable manifest.');
  let proposed;
  if (bytes !== undefined) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) invalid('Draft publication requires exact bytes.');
    if (bytes.byteLength !== entry.draft.byteLength || bytes.byteLength > L.fileBytes) conflict('The proposed draft exceeds its immutable byte profile.');
    proposed = Buffer.from(bytes);
    if (proposed.length !== entry.draft.byteLength || proposed.length > L.fileBytes || hashBytes(proposed) !== entry.draft.hash) conflict('The proposed draft differs from the immutable manifest.');
  }
  let files = await payloads(state, entry);
  if (entry.status === 'complete') { await reconcileLinks(state, entry, files); await completePayload(state, entry, files.final); return Object.freeze({ complete: true }); }
  if ([...state.entries.values()].some(other => other.draft.id !== id && other.status === 'owned')) conflict('Recover the one pending draft before writing another.');
  if (state.phase !== 'writing') conflict('A ready artifact set cannot accept new content.');
  if (!entry.identity) {
    if (!files.a && proposed === undefined) return Object.freeze({ complete: false, missing: true });
    if (!files.a) {
      const handle = await fs.open(files.stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      try { establishWindowsPrivacy(files.stage); assertRegularFile(files.stage, await readHandleStat(handle), state.pin); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(state.directory);
    } else await initializeEmptyReservation(state.pin, files.stage, files.a);
    const stat = await readPathStat(files.stage); assertRegularFile(files.stage, stat, state.pin);
    if (stat.size !== 0) conflict('An unjournaled artifact stage contains unexpected content.');
    await append(state, { type: 'own', id, ...fileIdentity(stat) });
    state = await load(pin, input); entry = state.entries.get(id); files = await payloads(state, entry);
  }
  await reconcileLinks(state, entry, files); files = await payloads(state, entry);
  if (files.b) { await completePayload(state, entry, files.final); await flushPayload(state, entry, files.final); await append(state, { type: 'complete', id }); return Object.freeze({ complete: true }); }
  if (!files.a) return Object.freeze({ complete: false, missing: true });
  const partial = await readSnapshot(state.pin, stageName(id), { maxBytes: L.fileBytes });
  if (proposed === undefined) {
    if (partial.hash !== entry.draft.hash || partial.bytes.length !== entry.draft.byteLength) return Object.freeze({ complete: false, partial: true });
  } else {
    if (!proposed.subarray(0, partial.bytes.length).equals(partial.bytes)) conflict('The owned partial draft is not an exact prefix of the completed output.');
    const handle = await fs.open(files.stage, constants.O_RDWR | NO_FOLLOW);
    try {
      const observed = await readHandleStat(handle); assertRegularFile(files.stage, observed, state.pin);
      if (!sameIdentity(observed, entry.identity) || observed.size !== partial.bytes.length) conflict('The artifact stage changed before writing.');
      let offset = partial.bytes.length;
      while (offset < proposed.length) {
        const size = Math.min(256 * 1024, proposed.length - offset), written = await handle.write(proposed, offset, size, offset);
        if (!written.bytesWritten) conflict('The draft write stopped.'); offset += written.bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
  }
  await completePayload(state, entry, files.stage); await flushPayload(state, entry, files.stage); await assertDirectory(state.pin);
  try { await fs.link(files.stage, files.final); }
  catch (cause) { if (cause.code === 'EEXIST') conflict('A final draft destination appeared unexpectedly.'); throw cause; }
  await reconcileLinks(state, entry, await payloads(state, entry)); await syncDirectory(state.directory);
  await append(state, { type: 'complete', id });
  return Object.freeze({ complete: true });
}

export async function completeDraftArtifacts(pin, input) {
  const state = await load(pin, input);
  if (!state.manifest || state.phase === 'discard' || [...state.entries.values()].some(entry => entry.status !== 'complete')) conflict('The exact draft set is not complete.');
  await preflight(state);
  for (const entry of state.entries.values()) {
    const files = await payloads(state, entry);
    if (!files.b || files.a || files.b.size !== entry.draft.byteLength) conflict('A completed draft payload is missing or changed.');
  }
  if (state.phase !== 'ready') await append(state, { type: 'ready' });
  else if (state.tail.length) conflict('Unexpected torn metadata follows the completed artifact set.');
  return state.manifest;
}

export async function inspectDraftArtifacts(pin, input) {
  const state = await load(pin, input);
  if (state.manifest) await preflight(state);
  else if (state.directory && (await inventory(state)).some(name => name !== JOURNAL)) conflict('Uncommitted artifact metadata has unexpected payload files.');
  const drafts = [];
  for (const entry of state.entries.values()) {
    const files = await payloads(state, entry);
    drafts.push(Object.freeze({ id: entry.draft.id, complete: entry.status === 'complete' && Boolean(files.b) && !files.a, deleted: entry.status === 'deleted' }));
  }
  return Object.freeze({ status: state.missing ? 'missing' : state.phase === 'ready' && !state.tail.length && drafts.every(draft => draft.complete) ? 'ready' : 'partial', manifest: state.manifest, drafts: Object.freeze(drafts) });
}

export async function readDraftArtifact(pin, input, id) {
  const state = await load(pin, input), entry = state.entries.get(id);
  if (state.phase !== 'ready' || state.tail.length || !entry || entry.status !== 'complete') conflict('Only the completed immutable draft set can be read for saving.');
  const files = await payloads(state, entry);
  if (files.a) conflict('A completed draft has an unexpected staging alias.');
  return (await completePayload(state, entry, files.final)).bytes;
}

async function preflight(state) {
  const names = await inventory(state), allowed = new Set([JOURNAL]);
  let unowned = 0;
  for (const entry of state.entries.values()) {
    allowed.add(stageName(entry.draft.id)); allowed.add(finalName(entry.draft.id));
    const files = await payloads(state, entry);
    if (entry.status === 'deleted' && (files.a || files.b)) conflict('A deleted artifact path reappeared.');
    if (entry.status === 'unowned' && files.a && ++unowned > 1) conflict('More than one unjournaled artifact stage exists.');
  }
  if (names.some(name => !allowed.has(name))) conflict('Unexpected files in the artifact directory were preserved.');
}

async function knownTornEvent(state) {
  const candidates = [];
  if (['writing', 'ready'].includes(state.phase)) candidates.push({ type: 'discard' });
  if (state.phase === 'writing' && [...state.entries.values()].every(entry => entry.status === 'complete')) candidates.push({ type: 'ready' });
  for (const entry of state.entries.values()) {
    const files = await payloads(state, entry);
    if (entry.status === 'unowned' && files.a) candidates.push({ type: 'own', id: entry.draft.id, ...fileIdentity(files.a) });
    if (entry.status === 'owned' && files.b) candidates.push({ type: 'complete', id: entry.draft.id });
    if (state.phase === 'discard' && ['owned', 'complete'].includes(entry.status) && !files.a && !files.b) candidates.push({ type: 'deleted', id: entry.draft.id });
  }
  if (!candidates.some(event => { const bytes = lineBytes(event); return state.tail.length < bytes.length && bytes.subarray(0, state.tail.length).equals(state.tail); })) conflict('Unknown torn artifact metadata was preserved.');
}

async function removeOwned(state, entry) {
  let files = await payloads(state, entry);
  if (entry.status === 'complete' && (files.a || files.b)) {
    await reconcileLinks(state, entry, files); files = await payloads(state, entry);
    await completePayload(state, entry, files.final);
  }
  await assertDirectory(state.pin);
  if (files.a && files.b) { await reconcileLinks(state, entry, files); files = await payloads(state, entry); }
  for (const [file, stat] of [[files.stage, files.a], [files.final, files.b]]) {
    if (!stat) continue;
    const current = await readPathStat(file); assertRegularFile(file, current, state.pin);
    if (!sameIdentity(current, entry.identity)) conflict('The owned artifact changed before deletion.');
    await fs.unlink(file);
  }
  await syncDirectory(state.directory); await append(state, { type: 'deleted', id: entry.draft.id });
}

async function removeRunDirectory(pin, state) {
  const names = await inventory(state);
  if (names.some(name => name !== JOURNAL)) conflict('Unexpected files prevent removing the artifact run directory.');
  if (names.includes(JOURNAL)) {
    const stat = await readPathStat(path.join(state.directory, JOURNAL)); assertRegularFile(path.join(state.directory, JOURNAL), stat, state.pin);
    if (!sameIdentity(stat, state.pointer.journal)) conflict('The artifact journal changed before removal.');
    await fs.unlink(path.join(state.directory, JOURNAL)); await syncDirectory(state.directory);
  }
  await assertDirectory(pin); await assertChain(state.parent.chain);
  if (!sameIdentity(await readPathStat(state.directory), state.pointer.directory)) conflict('The artifact directory changed before removal.');
  await fs.rmdir(state.directory); await syncDirectory(path.dirname(state.directory)); await assertDirectory(pin);
}

/** Explicit pre-pointer cleanup accepts only an empty private reservation or its
 * empty private journal. No nonempty unrecorded metadata or payload is adopted.
 */
async function discardUnprepared(pin, relative, runId) {
  const directory = reservation(pin, relative, runId), parent = await inspectParent(pin, relative), stat = await lstatOrNull(directory);
  if (!stat) return Object.freeze({ removed: true, remaining: 0 });
  if (!stat.isDirectory() || stat.isSymbolicLink()) conflict('The unprepared artifact reservation is unsafe.');
  assertPrivateAccess(directory, stat);
  const local = await pinDirectory(directory, { private: true }), names = await inventory({ directory, pin: local });
  if (names.some(name => name !== JOURNAL)) conflict('An unprepared artifact directory has unexpected files.');
  if (names.includes(JOURNAL)) {
    const file = path.join(directory, JOURNAL), before = await readPathStat(file);
    assertEmptyPrivateReservation(file, before);
    // No bytes are read or adopted. This exact reserved empty inode may precede
    // Windows owner initialization, so its narrower DACL check is explicit.
    const empty = await readSnapshot({ ...local, private: false }, JOURNAL, { maxBytes: 0 });
    const current = await readPathStat(path.join(directory, JOURNAL));
    if (!sameIdentity(current, empty.identity) || !sameIdentity(current, fileIdentity(before))) conflict('The empty artifact journal changed before removal.');
    assertEmptyPrivateReservation(file, current); await assertDirectory(local);
    await fs.unlink(path.join(directory, JOURNAL)); await syncDirectory(directory);
  }
  await assertChain(parent.chain); await assertDirectory(local);
  await fs.rmdir(directory); await syncDirectory(path.dirname(directory)); await assertDirectory(pin);
  return Object.freeze({ removed: true, remaining: 0 });
}

/** The artifact journal is the bounded resumable cleanup cursor. Call until
 * removed:true, then clear the current run. No completed artifact history remains.
 */
export async function discardDraftArtifacts(pin, input, { limit = 1, runId } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > L.drafts) invalid('Artifact cleanup requires a bounded positive limit.');
  if (typeof input === 'string') return discardUnprepared(pin, input, runId);
  let state = await load(pin, input);
  if (!state.directory) return Object.freeze({ removed: true, remaining: 0 });
  if (!state.manifest) {
    if ((await inventory(state)).some(name => name !== JOURNAL)) conflict('Uncommitted artifact metadata has unexpected payload files.');
    await removeRunDirectory(pin, state); return Object.freeze({ removed: true, remaining: 0 });
  }
  await preflight(state);
  if (state.tail.length) await knownTornEvent(state);
  if (state.phase !== 'discard') { await append(state, { type: 'discard' }, { abortTail: true }); state = await load(pin, input); }
  else if (state.tail.length) { await append(state, null, { abortTail: true }); state = await load(pin, input); }
  let removed = 0;
  for (const value of state.entries.values()) {
    if (value.status === 'deleted') continue;
    let entry = value;
    if (entry.status === 'unowned') {
      const files = await payloads(state, entry);
      if (!files.a) continue;
      await append(state, { type: 'own', id: entry.draft.id, ...fileIdentity(files.a) }, { abortTail: true });
      state = await load(pin, input); entry = state.entries.get(entry.draft.id);
    }
    await removeOwned(state, entry); state = await load(pin, input);
    if (++removed === limit) break;
  }
  const remaining = [...state.entries.values()].filter(entry => ['owned', 'complete'].includes(entry.status)).length;
  if (remaining || [...state.entries.values()].some(entry => entry.status === 'unowned')) {
    // Unowned and absent payloads never contained bytes and need no receipt.
    const pending = [];
    for (const entry of state.entries.values()) if (entry.status === 'unowned' && (await payloads(state, entry)).a) pending.push(entry);
    if (remaining || pending.length) return Object.freeze({ removed: false, remaining: remaining + pending.length });
  }
  await removeRunDirectory(pin, state); return Object.freeze({ removed: true, remaining: 0 });
}
