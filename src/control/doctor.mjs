import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { CHECK_CURSOR_PATTERN } from '../core/entry-contract.mjs';
import { hashBytes } from '../storage/files.mjs';
import { readSettings, withProject } from '../storage/store.mjs';
import { openNoteWorkspace } from '../processing/workspace.mjs';
import { DOCTOR_FINDINGS, inspectNoteHealth, sharedAliases, repeatedIdentities } from '../notes/index.mjs';
import { CONTROL_LIMITS } from '../client/control-server.mjs';
import { readRunSnapshot } from './status.mjs';
import { REVIEW_PAGE_BYTES } from './review.mjs';

/** One check reads at most this much of a destination and reports the rest as
 * partial coverage. A page shares the review and read budget, and stays below
 * the number of values the connector accepts in one response. */
export const DOCTOR_LIMITS = Object.freeze({ notes: 1024, bytes: 32 * 1024 * 1024, directories: 512, depth: 16,
  items: 20, itemBytes: 512, related: 5, noteBytes: 8 * 1024, pageBytes: REVIEW_PAGE_BYTES, pageNodes: CONTROL_LIMITS.nodes * 0.8 });
const CURSOR = new RegExp(CHECK_CURSOR_PATTERN);
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// A file that cannot be read as a note is a finding of that file; anything else,
// such as a replaced notes root, ends the check.
const UNREADABLE = new Set(['NOTE_UTF8_INVALID', 'NOTE_FILE_LIMIT', 'READ_LIMIT_EXCEEDED', 'PATH_UNSAFE', 'PATH_INVALID', 'NOTE_TARGET_INVALID', 'WORKSPACE_TARGET_ALIAS']);
const CHANGED = new Set(['FILE_CHANGED', 'FILE_MISSING']);
const ORDER = Object.keys(DOCTOR_FINDINGS);
const size = value => Buffer.byteLength(JSON.stringify(value));
// Counted as the response contract counts them: every value, whatever its kind.
const nodes = value => value === null || typeof value !== 'object' ? 1 : Object.values(value).reduce((total, item) => total + nodes(item), 1);
const invalid = () => fail('DIRECT_NOTE_ARGUMENT', 'Use only the advertised direct note arguments.');

function checkArguments(input) {
  if (!input || typeof input !== 'object' || typeof input.projectId !== 'string' || !PROJECT.test(input.projectId)) invalid();
  if (input.target !== undefined && (typeof input.target !== 'string' || !input.target || input.target.length > 32768)) invalid();
  // A cursor continues a project check; one note is always a single page.
  if (input.cursor !== undefined && (input.target !== undefined || typeof input.cursor !== 'string' || !CURSOR.test(input.cursor))) invalid();
  const [corpus, offset] = input.cursor?.split(':') ?? [];
  return { projectId: input.projectId, target: input.target, cursor: input.cursor === undefined ? null : { corpus, offset: Number(offset) } };
}

/** Every Markdown-named file of the destination, within fixed bounds and
 * without the reserved logs folder. One that is not an ordinary file is kept so
 * that it is reported instead of read. A folder without a portable name is not
 * entered and a link is not followed; each makes the coverage partial. */
async function listTargets(workspace, coverage, limits) {
  const targets = [], pending = [{ directory: undefined, depth: 0 }];
  for (let next = 0; next < pending.length; next++) {
    const { directory, depth } = pending[next];
    if (coverage.directories === limits.directories) { coverage.partial('directory-limit'); break; }
    coverage.directories++;
    for (let cursor; ;) {
      let page;
      try { page = await workspace.entries({ ...(directory === undefined ? {} : { directory }), ...(cursor === undefined ? {} : { cursor }), limit: 100 }); }
      catch (error) {
        if (error?.code === 'WORKSPACE_LIST_LIMIT') coverage.partial('directory-entry-limit');
        // A folder whose name differs from an earlier one only by case or
        // normalization has no portable name of its own.
        else if (error?.code === 'WORKSPACE_TARGET_ALIAS') { coverage.directories--; coverage.partial('skipped-directory'); }
        else throw error;
        break;
      }
      for (const entry of page.entries) {
        if (entry.kind === 'note' || entry.kind === 'skipped-note') targets.push(entry.target);
        else if (entry.kind === 'skipped-directory' || entry.kind === 'skipped-link') coverage.partial(entry.kind);
        else if (depth === limits.depth) coverage.partial('depth-limit');
        else pending.push({ directory: entry.target, depth: depth + 1 });
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }
  return targets;
}

const unreadable = reason => ({ status: 'unreadable', bytes: 0, id: null, headerBytes: 0, aliasBytes: 0, sections: 0, aliases: [],
  sources: { document: 0, session: 0 }, findings: [{ code: 'note-unreadable', count: 1, bytes: 0, items: [{ reason }] }] });

/** Read one note without retaining it. `null` means it changed or vanished
 * while it was read, which is partial coverage, not a finding. */
async function readNote(workspace, target) {
  try {
    const read = await workspace.peek({ target });
    return read.exists ? { target: read.target, hash: read.hash, health: inspectNoteHealth(read.bytes) } : null;
  } catch (error) {
    if (CHANGED.has(error?.code)) return null;
    if (!UNREADABLE.has(error?.code)) throw error;
    return { target, hash: error.code, health: unreadable(error.code) };
  }
}

/** The report is about notes, so it never waits for whoever holds the project
 * and is not lost when the run bookkeeping cannot be read: both are said, and
 * status explains them. */
async function runState(store, projectId) {
  try {
    const { run, active } = await withProject(store, projectId, context => readRunSnapshot(store, context));
    return run ? { state: 'pending', kind: run.scope.kind, phase: run.phase, active } : { state: 'none' };
  } catch (error) {
    if (typeof error?.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)) throw error;
    return error.code === 'GATE_BUSY' ? { state: 'busy' } : { state: 'unavailable', reason: error.code };
  }
}

function presentNote(note, limits) {
  const findings = [...note.health.findings].sort((left, right) => ORDER.indexOf(left.code) - ORDER.indexOf(right.code)).map(({ code, count, bytes, items }) => {
    const shown = []; let more = 0;
    for (const item of items) { if (shown.length < limits.items && size(item) <= limits.itemBytes) shown.push(item); else more++; }
    return { code, repair: DOCTOR_FINDINGS[code].repair, count, ...(bytes ? { bytes } : {}), ...(shown.length ? { items: shown } : {}), ...(more ? { more } : {}) };
  });
  const entry = { target: note.target, metadata: note.health.status, bytes: note.health.bytes, headerBytes: note.health.headerBytes, findings };
  if (size(entry) <= limits.noteBytes) return entry;
  // The counts stay exact; only the per-item detail of a very large note is left out, and said so.
  return { ...entry, findings: findings.map(({ items, more, ...rest }) => ({ ...rest, more: (items?.length ?? 0) + (more ?? 0) })) };
}

/** Read-only check of one project's notes, or of one note within it. It reads
 * note files and the project's run bookkeeping; it writes nothing, creates no
 * private state and starts no run, tracking, collection or model session. */
export async function checkNotes(store, input, { skillVersion, limits: lower = {} } = {}) {
  const { projectId, target, cursor } = checkArguments(input), limits = { ...DOCTOR_LIMITS };
  // Callers may only narrow a bound, never widen one.
  for (const [key, value] of Object.entries(lower)) {
    if (!Object.hasOwn(DOCTOR_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > DOCTOR_LIMITS[key]) fail('DOCTOR_LIMIT_INVALID', 'A check bound can only be lowered within its supported range.');
    limits[key] = value;
  }
  if (!store) return { state: 'unconfigured', message: 'Set up a note destination first.' };
  const before = await readSettings(store), project = before.value.projects.find(item => item.id === projectId);
  if (!project) fail('PROJECT_UNCONFIGURED', 'The project is not configured.');
  const workspace = await openNoteWorkspace({ project, runId: randomUUID(), skillVersion });
  const root = project.destination.kind === 'file' ? path.dirname(project.destination.path) : project.destination.path;
  const name = file => path.relative(root, file).split(path.sep).join('/');

  const reasons = [], coverage = { directories: 0, partial: reason => { if (!reasons.includes(reason)) reasons.push(reason); } };
  const targets = (await listTargets(workspace, coverage, limits)).sort((left, right) => name(left) < name(right) ? -1 : name(left) > name(right) ? 1 : 0);
  let selected = null;
  if (target !== undefined) {
    // A note is selected by its portable name, in whatever spelling the listing
    // found on disk. One the listing did not reach is read on its own, and it is
    // always inspected, even when the bounds stop before it.
    const key = value => value.normalize('NFC').toLowerCase();
    const wanted = key(path.isAbsolute(target) ? target : path.join(root, ...target.split('/')));
    selected = targets.find(file => key(file) === wanted) ?? null;
    if (!selected) {
      const read = await workspace.peek({ target });
      if (!read.exists) return { state: 'absent', projectId, target: read.target };
      selected = read.target;
    } else targets.splice(targets.indexOf(selected), 1);
    targets.unshift(selected);
  }
  const notes = []; let bytes = 0;
  for (const file of targets) {
    if (notes.length === limits.notes) { coverage.partial('note-limit'); break; }
    const note = await readNote(workspace, file);
    if (!note) { coverage.partial('changed'); continue; }
    if (bytes + note.health.bytes > limits.bytes) { coverage.partial('byte-limit'); break; }
    bytes += note.health.bytes; notes.push({ ...note, name: name(note.target) });
  }
  notes.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  // Findings that need the other notes: shared aliases and repeated identities.
  const findings = new Map(notes.map(note => [note.name, note.health.findings]));
  for (const [holder, items] of sharedAliases(notes.map(note => [note.name, note.health.aliases]), limits.related)) {
    findings.get(holder).push({ code: 'alias-across-notes', count: items.length, bytes: 0, items });
  }
  for (const [holder, item] of repeatedIdentities(notes.map(note => [note.name, note.health.id]), limits.related)) {
    findings.get(holder).push({ code: 'note-id-duplicate', count: 1, bytes: 0, items: [item] });
  }
  if ((await readSettings(store)).hash !== before.hash) fail('SETTINGS_CONFLICT', 'The configured note destination changed during inspection.');

  const totals = { notes: notes.length, withFindings: 0, bytes: 0, headerBytes: 0, aliasBytes: 0, sections: 0, aliases: 0,
    sources: { document: 0, session: 0 }, metadata: { supported: 0, absent: 0, invalid: 0, unsupported: 0, unreadable: 0 }, findings: {} };
  for (const { health } of notes) {
    totals.bytes += health.bytes; totals.headerBytes += health.headerBytes; totals.aliasBytes += health.aliasBytes;
    totals.sections += health.sections; totals.aliases += health.aliases.length; totals.metadata[health.status]++;
    totals.sources.document += health.sources.document; totals.sources.session += health.sources.session;
    if (health.findings.length) totals.withFindings++;
    for (const item of health.findings) {
      const total = totals.findings[item.code] ??= { notes: 0, count: 0, bytes: 0 };
      total.notes++; total.count += item.count; total.bytes += item.bytes;
    }
  }
  totals.findings = Object.fromEntries(ORDER.filter(code => totals.findings[code]).map(code => [code, totals.findings[code]]));

  const corpus = hashBytes(JSON.stringify(notes.map(note => [note.name, note.hash])));
  if (cursor && cursor.corpus !== corpus) fail('WORKSPACE_LIST_CHANGED', 'The notes changed between report pages. Restart the check without a cursor.');
  const reported = selected ? notes.filter(note => note.target === selected) : notes.filter(note => note.health.findings.length);
  const start = cursor?.offset ?? 0;
  if (cursor && start >= reported.length) invalid();
  const result = { state: 'checked', projectId, scope: selected ? 'note' : 'project', corpus,
    coverage: { complete: reasons.length === 0, notes: notes.length, directories: coverage.directories, reasons },
    run: await runState(store, projectId), totals, codes: {}, notes: [], next: null };
  let offset = start;
  for (; offset < reported.length; offset++) {
    const entry = presentNote(reported[offset], limits), codes = { ...result.codes };
    for (const { code } of entry.findings) codes[code] = DOCTOR_FINDINGS[code].message;
    const page = { ...result, codes, notes: [...result.notes, entry], next: offset + 1 < reported.length ? `${corpus}:${offset + 1}` : null };
    if (size(page) > limits.pageBytes || nodes(page) > limits.pageNodes) break;
    result.codes = codes; result.notes.push(entry);
  }
  if (offset === start && offset < reported.length) fail('CONTROL_RESPONSE_LIMIT', 'The note check cannot fit a bounded result.');
  result.next = offset < reported.length ? `${corpus}:${offset}` : null;
  return result;
}
