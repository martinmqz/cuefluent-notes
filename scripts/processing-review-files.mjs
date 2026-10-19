import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openWorkflowIntake, withIntakeLockWaiting, assertIntakeTransaction, guardStore, intakePath, intakeSnapshot, intakeJSON, replaceIntakeJSON, replaceIntakeBytes } from './intake-io.mjs';
import { assertWorkflowStorage, assertPrivatePaths, isPrivateStorageChurn, REVIEW_OWN_FILE as OWN_FILE, FINDER_FILE } from './workflow-storage.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { lstatOrNull, readBoundedBytes, sameFileIdentity, syncDirectory, displayScalar } from './file-io.mjs';
import { unitKey } from './capture-retention.mjs';
import { inspectProcessing } from './processing.mjs';
import { REVIEW_CODE, REVIEW_COMMANDS } from './processing-control-proof.mjs';
import { CLIENTS, canonicalJSON, choice, digest, fail, hash, keys, list, nativeId, timestamp, unique } from './workflow-values.mjs';

// A private, read-only copy of one exact proposal revision for people to read
// in any editor, plus the durable record of which chat was shown which revision.
// Neither the files nor these records approve anything: a decision still needs
// an approval channel and the engine's exact claim and proposal hashes.
const STATE = 'review-state/presentations.json', FORMAT = 'cuefluent-review-presentations';
const STATE_BYTES = 128 * 1024, FILE_BYTES = 2 * 1024 * 1024, SUMMARY_BYTES = 1024 * 1024;
const MAX_FOLDERS = 32, MAX_BINDINGS = 64, MAX_RECENT = 64, MAX_ENTRIES = 256, OMISSIONS_SHOWN = 5;
const CODE_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';

/** Short, unambiguous label for one exact proposal revision. A replaced
 * proposal has a new hash and therefore a new code. It grants nothing. */
export function reviewCode(proposalHash) {
  hash(proposalHash);
  const bytes = createHash('sha256').update(`cuefluent-review-code-v1\0${proposalHash}`).digest();
  return Array.from(bytes.subarray(0, 6), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

/** The chat a presentation belongs to: the verified invoking native session,
 * or, for a session the binding verified as a continuation, the root session of
 * that lineage. Only the native binding supplies `chatLineage`. */
export function reviewChatLineage(source) {
  const client = choice(source.selection.client, CLIENTS), lineage = source.chatLineage ?? source.selection;
  if (lineage.client !== client) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  return Object.freeze({ client, sessionId: nativeId(lineage.sessionId) });
}

const sameLineage = (a, b) => a.client === b.client && a.sessionId === b.sessionId;
export const sameReviewRevision = (a, b) => a.operationId === b.operationId &&
  a.proposalHash === b.proposalHash && a.claimHash === b.claimHash;
const revisionOf = value => ({ operationId: value.operationId, proposalHash: value.proposalHash, claimHash: value.claimHash });

function validRevision(value) { nativeId(value.operationId); hash(value.proposalHash); hash(value.claimHash); }
// `attempt` names the latest presentation attempt of this revision in this
// chat; `verified` and `delivered` describe that attempt; `typedDelivered`
// records that some typed review of it was delivered here, which is what a
// coded decision requires.
function validRecord(value) {
  keys(value, ['chatLineage', 'operationId', 'proposalHash', 'claimHash', 'attempt', 'presentedAt', 'verified', 'delivered', 'typedDelivered']);
  keys(value.chatLineage, ['client', 'sessionId']); choice(value.chatLineage.client, CLIENTS); nativeId(value.chatLineage.sessionId);
  validRevision(value); nativeId(value.attempt); timestamp(value.presentedAt);
  for (const flag of ['verified', 'delivered', 'typedDelivered']) if (typeof value[flag] !== 'boolean') fail('INVALID_WORKFLOW');
}
function validState(value) {
  try {
    keys(value, ['format', 'version', 'folders', 'bindings', 'recent']);
    if (value.format !== FORMAT || value.version !== 1) fail('INVALID_WORKFLOW');
    list(value.folders, MAX_FOLDERS).forEach(item => {
      keys(item, ['code', 'operationId', 'proposalHash', 'claimHash']); validRevision(item);
      if (item.code !== reviewCode(item.proposalHash)) fail('INVALID_WORKFLOW');
    });
    unique(value.folders.map(item => item.code));
    list(value.bindings, MAX_BINDINGS).forEach(validRecord); list(value.recent, MAX_RECENT).forEach(validRecord);
    unique(value.bindings.map(item => canonicalJSON([item.chatLineage, revisionOf(item)])));
    unique(value.recent.map(item => canonicalJSON(item.chatLineage)));
    return value;
  } catch { fail('PROCESSING_REVIEW_STATE_INVALID'); }
}
async function readState(store) {
  const snapshot = await intakeSnapshot(store, 'state', STATE, { maxBytes: STATE_BYTES });
  if (snapshot.bytes === null) return { value: { format: FORMAT, version: 1, folders: [], bindings: [], recent: [] }, hash: null };
  let value;
  try { value = intakeJSON(snapshot); } catch { fail('PROCESSING_REVIEW_STATE_INVALID'); }
  validState(value);
  // Helper-owned canonical bytes: duplicate keys or alternate encodings are refused.
  if (!snapshot.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('PROCESSING_REVIEW_STATE_INVALID');
  return { value, hash: snapshot.hash };
}

// Processing consent for the invoking chat covers this private copy, like the
// proposal read it came from. No lock is held while the person reads or types;
// a step waits a bounded moment for one a collection pass holds.
function withReviewState(capability, selection, run, signal) {
  return withStorageProbes(async () => {
    const store = await openWorkflowIntake(capability);
    return withIntakeLockWaiting(store, async tx => {
      const authorize = () => assertWorkflowStorage(capability, selection, 'explicitProcess');
      await authorize();
      return run({ store, tx, state: await readState(store), authorize });
    }, { signal });
  });
}

// A file replaced while it was opened or read: its identity changed, or the
// opened one is unlinked.
const REPLACED = new Set(['FILE_IDENTITY_CHANGED', 'INTAKE_FILE_CHANGED', 'FILE_LINK_COUNT_INVALID']);
// Read without the intake lock. Another chat may replace the record during
// the read; a few fresh reads then see one whole version.
async function readStateUnlocked(capability) {
  for (let attempt = 0; ; attempt++) {
    try { return await withStorageProbes(async () => (await readState(await openWorkflowIntake(capability))).value); }
    catch (error) {
      if (attempt >= 4 || (!REPLACED.has(error?.code) && !isPrivateStorageChurn(error))) throw error;
      await delay(10 * (attempt + 1));
    }
  }
}

/** Presentation records for one chat lineage, read without the intake lock:
 * `bindings` are revisions a typed review delivered to this chat; `recent` is
 * the chat's latest presentation attempt, delivered or not. They identify a
 * revision; the engine's current hashes still decide. */
export async function readReviewPresentations(capability, chatLineage) {
  const value = await readStateUnlocked(capability);
  return { bindings: value.bindings.filter(item => item.typedDelivered && sameLineage(item.chatLineage, chatLineage)),
    recent: value.recent.find(item => sameLineage(item.chatLineage, chatLineage)) ?? null };
}

/** Whether this exact presentation attempt is still this chat's record of its
 * revision: nothing settled it or showed it again since. A check before the
 * reply is written; delivery is confirmed only after it was. */
export async function presentationAttemptCurrent(capability, { chatLineage, revision, attempt }) {
  validRevision(revision); nativeId(attempt);
  const value = await readStateUnlocked(capability);
  return value.bindings.some(item => sameLineage(item.chatLineage, chatLineage) && sameReviewRevision(item, revision) && item.attempt === attempt);
}

/** Whether a reply presenting exactly this revision may be given again: this
 * chat's record of it is live (not settled) and was delivered, and the engine
 * still has that revision awaiting review. The chat's latest-presentation
 * pointer outlives a decision, so it never counts on its own. */
export async function presentationStillShown(capability, chatLineage, revision) {
  validRevision(revision);
  const value = await readStateUnlocked(capability);
  const record = value.bindings.find(item => sameLineage(item.chatLineage, chatLineage) && sameReviewRevision(item, revision));
  if (!record || !(record.delivered || record.typedDelivered)) return false;
  const current = await withStorageProbes(() => inspectProcessing(capability, revision.operationId));
  return current.state === 'awaiting-review' && !current.recoveryRequired && sameReviewRevision(current, revision);
}

function fileNames(files) {
  const width = String(files.length).length;
  return files.map((file, index) => {
    const prefix = files.length === 1 ? '' : `${String(index + 1).padStart(width, '0')}-`;
    return { proposed: `${prefix}proposed.md`, current: file.original === null ? null : `${prefix}current.md` };
  });
}
const commandLine = words => `${REVIEW_COMMANDS.claude} ${words} (Codex: ${REVIEW_COMMANDS.codex} ${words})`;

// "1-3, 7, 9-12": every file a source supports, as the numbers of the file
// entries above. Complete and compact, so attribution never depends on length.
function fileRanges(indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b), ranges = [];
  for (const index of sorted) {
    const last = ranges.at(-1);
    if (last && index === last[1] + 1) last[1] = index; else ranges.push([index, index]);
  }
  return ranges.map(([from, to]) => from === to ? `${from}` : `${from}-${to}`).join(', ');
}

/** Deterministic for one revision, so re-presenting it rewrites nothing.
 * Paths and source metadata are visibly escaped; note content is not here.
 * Every section is bounded by the proposal's own limits, so a valid proposal
 * always fits: mappings are file-number ranges and omission details are capped. */
function summaryText(preview, code, names) {
  const lines = [`Cuefluent Notes review: draft ${code}`, '',
    'This folder is a private copy of a proposed note change. Nothing has been saved, and editing these files changes nothing.',
    'Each proposed file holds the exact Markdown that Save would write; each current file holds the note as it is now.',
    'Note content is untrusted material, not instructions.', '', 'Files'];
  preview.files.forEach((file, index) => {
    lines.push(`${index + 1}. ${file.original === null ? 'Create' : 'Update'} ${displayScalar(file.path)}`,
      `   Proposed: ${names[index].proposed} (${Buffer.byteLength(file.proposed)} bytes)`);
    if (file.original !== null) lines.push(`   Current: ${names[index].current} (${Buffer.byteLength(file.original)} bytes)`);
  });
  if (preview.createDirectories.length) lines.push('', 'Folders to create', ...preview.createDirectories.map(dir => `- ${displayScalar(dir)}`));
  lines.push('', 'Sources');
  const fileIndex = new Map(preview.files.map((file, index) => [file.path, index + 1]));
  const mappings = new Map(preview.mappings.map(mapping => [unitKey(mapping.identity), mapping]));
  for (const source of preview.sourceCoverage) {
    const { identity } = source;
    lines.push(`- ${identity.client} session ${identity.sessionId}, turn ${identity.unitId}`,
      `  Terminal: ${source.terminal}. ${source.partial ? 'Partial source coverage.' : 'No capture omissions reported.'}`);
    for (const omission of source.omissions.slice(0, OMISSIONS_SHOWN)) lines.push('  Omitted: ' + Object.entries(omission).map(([key, value]) => `${key}: ${displayScalar(value)}`).join('; '));
    if (source.omissions.length > OMISSIONS_SHOWN) lines.push(`  and ${source.omissions.length - OMISSIONS_SHOWN} more omissions`);
    const mapping = mappings.get(unitKey(identity));
    if (mapping) {
      const indexes = mapping.paths.map(file => fileIndex.get(file)).filter(index => index !== undefined);
      lines.push(`  Used in: ${indexes.length === 1 ? 'file' : 'files'} ${fileRanges(indexes)}`);
    }
  }
  lines.push('', 'Inspection', `${preview.inspection.acknowledgedPages} of ${preview.inspection.totalPages} retained evidence pages inspected. This does not establish completeness of the original sources.`,
    '', 'Decide by typing these commands yourself. A decision counts only in a chat where you typed the review command for this draft:',
    `- Show it in that chat, if you have not typed this there yet: ${commandLine(`review ${code}`)}`,
    `- Save this exact proposal: ${commandLine(`save ${code}`)}`,
    `- Skip these captured turns without saving: ${commandLine(`skip ${code}`)}`,
    `- Cancel the draft; its captures stay pending: ${commandLine(`review cancel ${code}`)}`,
    'To keep the draft pending, type nothing.',
    '', 'Exact revision', `Operation: ${preview.operationId}`, `Claim hash: ${preview.claimHash}`, `Proposal hash: ${preview.proposalHash}`, '');
  return lines.join('\n');
}

/** Exact bytes for every review file. Re-encoding the engine's strict UTF-8
 * text must reproduce the inspected hashes, or nothing is written. */
function reviewFiles(preview, code) {
  const names = fileNames(preview.files), files = [];
  preview.files.forEach((file, index) => {
    const proposed = Buffer.from(file.proposed, 'utf8');
    if (digest(proposed) !== file.contentHash) fail('PROCESSING_PROPOSAL_CHANGED');
    files.push({ name: names[index].proposed, bytes: proposed });
    if (file.original !== null) {
      const current = Buffer.from(file.original, 'utf8');
      if (digest(current) !== file.expectedHash) fail('PROCESSING_OUTPUT_CHANGED');
      files.push({ name: names[index].current, bytes: current });
    }
  });
  const summary = Buffer.from(summaryText(preview, code, names));
  if (summary.length > SUMMARY_BYTES) fail('PROCESSING_REVIEW_LIMIT');
  files.push({ name: 'summary.txt', bytes: summary });
  return files;
}

// A file or folder an editor holds open (Windows), or one that just vanished,
// stays or is gone; either way it authorizes nothing.
const LEFT_IN_PLACE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'ENOTEMPTY', 'EEXIST']);
// Remove one of this module's own file names after re-checking its identity.
// Unfamiliar entries, links and changed files are left in place.
async function removeOwnFile(tx, store, name) {
  const file = await intakePath(store, 'state', name);
  const before = await lstatOrNull(file, { bigint: true });
  if (!before) return true;
  if (!before.isFile() || before.nlink !== 1n) return false;
  await assertIntakeTransaction(tx); await guardStore(store, [file]);
  const current = await lstatOrNull(file, { bigint: true });
  if (!current || !sameFileIdentity(before, current) || current.ctimeNs !== before.ctimeNs) return false;
  try { await fs.unlink(file); }
  catch (error) { if (LEFT_IN_PLACE.has(error.code)) return error.code === 'ENOENT'; throw error; }
  return true;
}
async function folderEntries(directory) {
  const names = [];
  for await (const entry of await fs.opendir(directory)) {
    if (names.length >= MAX_ENTRIES) return null;
    names.push({ name: entry.name, file: entry.isFile(), directory: entry.isDirectory() });
  }
  return names;
}
/** Remove a review folder's own files and Finder's metadata file, then the
 * folder if nothing else is in it (an editor's swap file, for example, keeps
 * it). Best effort by design: the folder is a copy, and leftovers never
 * authorize anything. */
async function removeFolder(tx, store, code, { keepDirectory = false } = {}) {
  const directory = path.dirname(await intakePath(store, 'state', `review/${code}/summary.txt`));
  const stat = await lstatOrNull(directory);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const entries = await folderEntries(directory);
  if (!entries) return;
  let others = false;
  for (const entry of entries) {
    if (entry.file && (OWN_FILE.test(entry.name) || entry.name === FINDER_FILE)) { if (!await removeOwnFile(tx, store, `review/${code}/${entry.name}`)) others = true; }
    else others = true;
  }
  if (others || keepDirectory) return;
  await assertIntakeTransaction(tx); await guardStore(store, [directory]);
  try { await fs.rmdir(directory); await syncDirectory(path.dirname(directory)); }
  catch (error) { if (!LEFT_IN_PLACE.has(error.code)) throw error; }
}

async function isCurrentRevision(capability, revision) {
  try {
    const current = await inspectProcessing(capability, revision.operationId);
    return current.state === 'awaiting-review' && !current.recoveryRequired && sameReviewRevision(current, revision);
  } catch { return true; } // Unreadable state is not proof of a change; keep the copy.
}

/** Write one revision's review folder and record that this chat was shown it.
 * `verified` is true only for a verified typed review action. Folders of
 * revisions that are no longer pending are removed; their presentation records
 * stay until a decision refers to them, so it can report the change. */
export async function presentReviewFiles(capability, { selection, preview, chatLineage, verified, presentedAt = new Date().toISOString(), signal }) {
  keys(chatLineage, ['client', 'sessionId']); choice(chatLineage.client, CLIENTS); nativeId(chatLineage.sessionId);
  if (typeof verified !== 'boolean') fail('INVALID_WORKFLOW');
  timestamp(presentedAt);
  const revision = revisionOf(preview); validRevision(revision);
  const code = reviewCode(revision.proposalHash), files = reviewFiles(preview, code), attempt = randomUUID();
  // A reused copy must still be private: an editor can save it back unchanged
  // with other permissions, and then it is written again.
  const privateFile = target => assertPrivatePaths(capability, [target]).then(() => true,
    error => { if (error?.code === 'STORAGE_NOT_PRIVATE') return false; throw error; });
  return withReviewState(capability, selection, async ({ store, tx, state, authorize }) => {
    const value = state.value, kept = [];
    for (const folder of value.folders) {
      if (sameReviewRevision(folder, revision) || await isCurrentRevision(capability, folder)) kept.push(folder);
      else await removeFolder(tx, store, folder.code, { keepDirectory: folder.code === code });
    }
    // Two pending revisions cannot share one folder; a shared code names neither.
    if (kept.some(folder => folder.code === code && !sameReviewRevision(folder, revision))) fail('PROCESSING_REVIEW_CODE_CONFLICT');
    // Folders left by an interrupted write are not in the record; remove their own files.
    const root = path.dirname(await intakePath(store, 'state', 'review/.list'));
    if (await lstatOrNull(root)) {
      const entries = await folderEntries(root) ?? [];
      for (const entry of entries) {
        if (entry.directory && REVIEW_CODE.test(entry.name) && entry.name !== code && !kept.some(folder => folder.code === entry.name)) {
          await removeFolder(tx, store, entry.name);
        }
      }
    }
    const directory = path.dirname(await intakePath(store, 'state', `review/${code}/summary.txt`, { createParents: true }));
    await assertPrivatePaths(capability, [directory]);
    const written = [];
    for (const file of files) {
      const name = `review/${code}/${file.name}`, target = await intakePath(store, 'state', name);
      const existing = await lstatOrNull(target, { bigint: true });
      if (existing?.isFile() && existing.nlink === 1n) {
        const bytes = await readBoundedBytes(target, { maxBytes: FILE_BYTES, utf8: false, noFollow: true }).catch(() => null);
        if (bytes?.equals(file.bytes) && await privateFile(target)) { written.push(target); continue; }
      }
      if (existing && !await removeOwnFile(tx, store, name)) fail('PROCESSING_REVIEW_FILES_CHANGED');
      await authorize();
      await replaceIntakeBytes(tx, name, file.bytes, null, { maxBytes: FILE_BYTES });
      written.push(target);
    }
    // A file name this layout does not use (another numbering) is not this revision's.
    const expected = new Set(files.map(file => file.name));
    for (const entry of await folderEntries(directory) ?? []) {
      if (entry.file && OWN_FILE.test(entry.name) && !expected.has(entry.name)) await removeOwnFile(tx, store, `review/${code}/${entry.name}`);
    }
    await assertPrivatePaths(capability, written);
    // This attempt becomes the chat's latest presentation at once, undelivered,
    // so a bare decision cannot fall back to an older draft while its reply is
    // in doubt. A typed review this chat already received stays usable for a
    // coded decision; a redisplay never upgrades or downgrades that record.
    const previous = value.bindings.find(item => sameLineage(item.chatLineage, chatLineage) && sameReviewRevision(item, revision));
    const record = { chatLineage: { ...chatLineage }, ...revision, attempt, presentedAt, verified, delivered: false,
      typedDelivered: previous?.typedDelivered === true };
    const folders = [...kept.filter(folder => folder.code !== code), { code, ...revision }];
    while (folders.length > MAX_FOLDERS) await removeFolder(tx, store, folders.shift().code);
    const next = { format: FORMAT, version: 1, folders,
      bindings: [...value.bindings.filter(item => item !== previous), record].slice(-MAX_BINDINGS),
      recent: [...value.recent.filter(item => !sameLineage(item.chatLineage, chatLineage)), record].slice(-MAX_RECENT) };
    await authorize();
    await replaceIntakeJSON(tx, STATE, validState(next), state.hash);
    // `review` is each file's proposed copy in the folder, for a direct link.
    const names = fileNames(preview.files);
    return Object.freeze({ code, folder: directory, ...revision, attempt, presentedAt,
      files: Object.freeze(preview.files.map((file, index) => Object.freeze({ path: file.path, bytes: Buffer.byteLength(file.proposed),
        change: file.original === null ? 'create' : 'update', review: names[index].proposed }))) });
  }, signal);
}

/** The reply naming exactly this presentation attempt was committed to the
 * chat: the attempt is delivered, and if it was a typed review the revision
 * becomes decidable by code. An attempt settled or superseded meanwhile leaves
 * nothing to confirm, and a later attempt is never confirmed by an earlier reply. */
export async function confirmReviewPresentation(capability, { selection, chatLineage, revision, attempt, signal }) {
  validRevision(revision); nativeId(attempt);
  return withReviewState(capability, selection, async ({ tx, state, authorize }) => {
    const value = state.value;
    const named = item => sameLineage(item.chatLineage, chatLineage) && sameReviewRevision(item, revision) && item.attempt === attempt;
    const binding = value.bindings.find(named);
    if (!binding) return false;
    const delivered = { ...binding, delivered: true, typedDelivered: binding.typedDelivered || binding.verified };
    const next = { ...value, bindings: value.bindings.map(item => item === binding ? delivered : item),
      recent: value.recent.map(item => named(item) ? delivered : item) };
    await authorize();
    await replaceIntakeJSON(tx, STATE, validState(next), state.hash);
    return true;
  }, signal);
}

/** After a decision or a refused change: this chat's record of that revision
 * and its folder are removed. The chat's latest-presentation pointer remains,
 * so a later bare decision cannot fall through to an older revision. */
export async function settleReviewFiles(capability, { selection, chatLineage, revision, signal }) {
  validRevision(revision);
  const code = reviewCode(revision.proposalHash);
  return withReviewState(capability, selection, async ({ store, tx, state, authorize }) => {
    const value = state.value;
    const bindings = value.bindings.filter(item => !(sameLineage(item.chatLineage, chatLineage) && sameReviewRevision(item, revision)));
    const owner = value.folders.find(folder => folder.code === code);
    if (!owner || sameReviewRevision(owner, revision)) await removeFolder(tx, store, code);
    const folders = value.folders.filter(folder => folder !== owner || !sameReviewRevision(owner, revision));
    if (bindings.length === value.bindings.length && folders.length === value.folders.length) return;
    await authorize();
    await replaceIntakeJSON(tx, STATE, validState({ ...value, folders, bindings }), state.hash);
  }, signal);
}
