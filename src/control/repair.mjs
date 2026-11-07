import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { REPAIR_CURSOR_PATTERN } from '../core/entry-contract.mjs';
import { hashBytes } from '../storage/files.mjs';
import { readSettings } from '../storage/store.mjs';
import { openNoteWorkspace, targetKey } from '../processing/workspace.mjs';
import { inspectNoteHealth, serializeSources, validateRepairOperations } from '../notes/index.mjs';
import { fields } from '../client/control-server.mjs';
import { REVIEW_PAGE_BYTES, fitJsonPiece } from './review.mjs';
import { submitDirectRun } from './direct-run.mjs';

/** One call names at most this many notes; the batch it forms holds as many
 * changed notes as one run may retain, and the rest is said to be deferred. */
export const REPAIR_BATCH = Object.freeze({ targets: 128, reportBytes: 16 * 1024 });
const CURSOR = new RegExp(REPAIR_CURSOR_PATTERN);
const invalid = () => fail('REPAIR_ARGUMENT', 'Use only the advertised repair arguments with valid values.');
const serialized = value => Buffer.byteLength(JSON.stringify(value));
const continuation = (bytes, at) => at < bytes.length && (bytes[at] & 0xc0) === 0x80;
// The batch is full: this note and those after it wait for another batch.
const FULL = new Set(['WORKSPACE_DRAFT_LIMIT', 'WORKSPACE_PRIVATE_LIMIT']);
// A note that cannot take its repair as it is now. The reason is that note's
// alone; the others are still previewed.
const REFUSED = new Set(['REPAIR_NOTE_MISSING', 'REPAIR_NOTE_BLOCKED', 'REPAIR_OPERATION_INVALID', 'REPAIR_SOURCE_CONFLICT', 'NOTE_REPAIR_LAYOUT',
  'WORKSPACE_LIST_LIMIT', 'REPAIR_SCOPE_VIOLATION', 'REPAIR_CHANGES_LIMIT', 'NOTE_FILE_LIMIT', 'WORKSPACE_TARGET_ALIAS', 'NOTE_UTF8_INVALID', 'READ_LIMIT_EXCEEDED', 'PATH_UNSAFE', 'FILE_CHANGED', 'EACCES', 'EPERM', 'EBUSY']);

/** The selected notes with their operations, closed and in the caller's order. */
export function validateRepairs(input) {
  if (!Array.isArray(input) || !input.length || input.length > REPAIR_BATCH.targets || Object.keys(input).length !== input.length) invalid();
  return Object.freeze(input.map(item => {
    const { target, operations } = fields(item, ['target', 'operations'], [], invalid);
    if (typeof target !== 'string' || !target || target.length > 32768) invalid();
    return Object.freeze({ target, operations: validateRepairOperations(operations) });
  }));
}

/** Build every candidate of one batch, in order, until the batch is full. The
 * digest names the project and destination, each selected note with its
 * operations, the hash it was inspected at and the hash of its exact candidate,
 * so a preview and the repair that cites it stand for the same bytes. It is a
 * consistency check, not an approval: the caller still needs the user's word. */
async function propose(project, repairs, { skillVersion, runId, limits = {} }) {
  // Callers may only narrow a bound, never widen one.
  const workspace = await openNoteWorkspace({ project, runId, skillVersion, limits }), files = [];
  // A name that is no note target is an argument error before any note is read.
  for (const repair of repairs) files.push(await workspace.resolve(repair.target));
  if (new Set(files.map(targetKey)).size !== files.length) invalid();
  const entries = []; let full = false;
  for (const [index, repair] of repairs.entries()) {
    const entry = { target: files[index], operations: repair.operations };
    if (!full) {
      try {
        const receipt = await workspace.repair({ target: repair.target, operations: repair.operations });
        entries.push({ ...entry, state: receipt.changed ? 'change' : 'unchanged', expectedHash: receipt.expectedHash, hash: receipt.hash, before: receipt.bytes,
          ...(receipt.changed ? { after: receipt.candidate.length, summary: receipt.summary, changes: receipt.changes,
            remaining: Object.fromEntries(inspectNoteHealth(receipt.candidate).findings.map(item => [item.code, item.count])) } : {}) });
        continue;
      } catch (error) {
        if (REFUSED.has(error?.code)) { entries.push({ ...entry, state: 'refused', code: error.code }); continue; }
        if (!FULL.has(error?.code)) throw error;
        full = true;
      }
    }
    entries.push({ ...entry, state: 'deferred' });
  }
  // A refusal belongs to its note only while the notes root still stands.
  await workspace.verify();
  const digest = hashBytes(serializeSources(['cuefluent-repair-proposal', 1, project.id, project.destination, project.saving,
    entries.map(entry => [entry.target, entry.state, entry.operations, entry.expectedHash ?? null, entry.hash ?? null, entry.code ?? null])]));
  return { workspace, entries, digest };
}

const counts = entries => Object.fromEntries(['change', 'unchanged', 'refused', 'deferred'].map(state => [state, entries.filter(entry => entry.state === state).length]));

function shown(entry, index, start, end) {
  const base = { index, target: entry.target, state: entry.state, operations: entry.operations.map(item => item.op) };
  if (entry.state === 'refused') return { ...base, code: entry.code };
  if (entry.state === 'deferred') return base;
  if (entry.state === 'unchanged') return { ...base, expectedHash: entry.expectedHash, bytes: { before: entry.before, after: entry.before } };
  return { ...base, expectedHash: entry.expectedHash, hash: entry.hash, summary: entry.summary, bytes: { before: entry.before, after: entry.after }, remaining: entry.remaining,
    totalBytes: entry.changes.length, start, end, next: end < entry.changes.length ? end : null, changes: entry.changes.subarray(start, end).toString('utf8') };
}

/** Read-only preview of selected repairs: the complete change list of the batch
 * in bounded pages, every page under one proposal. It saves nothing, retains
 * nothing and claims no run; each page builds the candidates again, and a page
 * whose notes or operations differ from its cursor's proposal is refused. */
export async function previewRepair(store, input, { skillVersion, limits } = {}) {
  const repairs = validateRepairs(input?.repairs);
  if (typeof input.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId) || (input.cursor !== undefined && (typeof input.cursor !== 'string' || !CURSOR.test(input.cursor)))) invalid();
  const [proposal, at, offset] = input.cursor?.split(':') ?? [];
  if (!store) return { state: 'unconfigured', message: 'Set up a note destination first.' };
  const before = await readSettings(store), project = before.value.projects.find(item => item.id === input.projectId);
  if (!project) fail('PROJECT_UNCONFIGURED', 'The project is not configured.');
  const { entries, digest } = await propose(project, repairs, { skillVersion, runId: randomUUID(), limits });
  if ((await readSettings(store)).hash !== before.hash) fail('SETTINGS_CONFLICT', 'The configured note destination changed during inspection.');
  if (proposal !== undefined && proposal !== digest) fail('REPAIR_PROPOSAL_CHANGED', 'The notes or the selected repairs changed between preview pages. Preview again without a cursor.');
  const page = { state: 'previewed', projectId: project.id, proposal: digest, saving: project.saving, selected: entries.length, counts: counts(entries), targets: [], next: null };
  let size = serialized({ ...page, next: `${digest}:999:99999999` }) + 1, start = Number(offset ?? 0);
  if (Number(at ?? 0) >= entries.length) invalid();
  for (let index = Number(at ?? 0); index < entries.length; index++, start = 0) {
    const entry = entries[index], total = entry.changes?.length ?? 0;
    if (start && (start >= total || continuation(entry.changes, start))) invalid();
    const whole = shown(entry, index, start, total), wholeSize = serialized(whole) + 1;
    if (size + wholeSize <= REVIEW_PAGE_BYTES) { page.targets.push(whole); size += wholeSize; continue; }
    if (!page.targets.length) {
      // One note's change list is larger than a page: cut it at a UTF-8 boundary.
      const end = fitJsonPiece(entry.changes, start, REVIEW_PAGE_BYTES - size - 1, end => shown(entry, index, start, end));
      page.targets.push(shown(entry, index, start, end)); start = end;
    }
    page.next = `${digest}:${index}:${start}`; break;
  }
  return page;
}

/** What one batch did with each selected note, within the bytes its result has
 * left: the lists say how many names they leave out. */
function report(entries, budget) {
  const batch = { selected: entries.length, counts: counts(entries), changed: [], unchanged: [], deferred: [], omitted: 0 }, limit = Math.min(REPAIR_BATCH.reportBytes, budget);
  let bytes = serialized(batch);
  for (const entry of entries) {
    const item = entry.state === 'change' ? { target: entry.target, before: entry.before, after: entry.after } : entry.target, size = serialized(item) + 1;
    if (bytes + size > limit) { batch.omitted++; continue; }
    bytes += size; batch[entry.state === 'change' ? 'changed' : entry.state].push(item);
  }
  return batch;
}

/** Apply one previewed batch through the ordinary run: review mode retains the
 * candidates for the Save, Discard or Keep pending decision, automatic mode
 * saves them. Fresh work builds the candidates again and must arrive at the
 * cited proposal; anything else is refused before a run exists. A retry with
 * the same `requestId` and request returns the retained or completed outcome
 * without building anything. Repaired notes keep their timestamps and writer
 * version, and no activity is logged. */
export async function repairNotes(store, input, { client, skillVersion, limits } = {}) {
  const repairs = validateRepairs(input?.repairs);
  if (typeof input.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId) || typeof input.proposal !== 'string' || !/^[a-f0-9]{64}$/.test(input.proposal) ||
      typeof input.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.requestId)) invalid();
  if (!store) return { state: 'unconfigured', message: 'Set up a note destination first.' };
  const requestHash = hashBytes(serializeSources(['cuefluent-repair-request', 1, input.proposal, repairs.map(repair => [repair.target, repair.operations])]));
  let built = null;
  const outcome = await submitDirectRun(store, { projectId: input.projectId, requestId: input.requestId,
    scope: { kind: 'direct', requestHash, repair: input.proposal },
    changed: () => fail('REPAIR_REQUEST_CHANGED', 'Reuse a requestId only with its exact original repair batch.'),
    build: async project => {
      const { workspace, entries, digest } = await propose(project, repairs, { skillVersion, runId: input.requestId, limits });
      if (digest !== input.proposal) fail('REPAIR_PROPOSAL_CHANGED', 'The notes or the selected repairs differ from the cited preview. Preview again and cite the new proposal.');
      if (entries.some(entry => entry.state === 'refused')) fail('REPAIR_TARGET_REFUSED', 'A selected note cannot take its repair. Correct or leave out that selection and preview again.');
      built = entries;
      await workspace.finish_drafting({ outcome: entries.some(entry => entry.state === 'change') ? 'drafted' : 'nothing-useful' });
      return workspace.manifest();
    } }, { client, skillVersion });
  // A completed outcome also says what became of each selected note. A review
  // page is already a full page, and its drafts are the changed notes.
  return built && outcome.result ? { ...outcome, batch: report(built, REVIEW_PAGE_BYTES - serialized(outcome) - 16) } : outcome;
}
