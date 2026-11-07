import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject } from '../../src/core/settings.mjs';
import { createRun, isRepairRun, runKind, validateRun } from '../../src/core/run.mjs';
import { REPAIR_CURSOR_PATTERN } from '../../src/core/entry-contract.mjs';
import { initializeStore, readSettings, updateSettings, withProject } from '../../src/storage/store.mjs';
import { hashBytes, readJSON, writeJSON } from '../../src/storage/files.mjs';
import { NOTE_PROFILE, constructRepair, createGeneratedNote, describeRepair, inspectMetadata, serializeRepair } from '../../src/notes/index.mjs';
import { createDirectNoteTools } from '../../src/control/direct-notes.mjs';
import { previewRepair, repairNotes, REPAIR_BATCH } from '../../src/control/repair.mjs';
import { REVIEW_PAGE_BYTES } from '../../src/control/review.mjs';
import { readProjectStatus } from '../../src/control/status.mjs';
import { createControlBridge } from '../../src/client/control-server.mjs';
import { WORKSPACE_LIMITS, openNoteWorkspace } from '../../src/processing/workspace.mjs';
import { persistDraftManifest } from '../../src/processing/draft.mjs';
import { ownDirectAttempt } from '../../src/storage/attempts.mjs';
import { parseDocument } from 'yaml';
import { createAnnualLog } from '../../src/logs/index.mjs';
import { logYear } from '../../src/logs/storage.mjs';

const skillVersion = '0.24.0', sha = character => `sha256:${character.repeat(64)}`;
const body = name => `# Topic ${name}\n\n## Overview\n<!-- aliases: alias ${name}, shared -->\nVisible ${name}.\n`;
const note = (name, extra = {}) => createGeneratedNote(body(name), { id: randomUUID(), now: '2026-10-22T01:00:00Z', skillVersion: '0.19.0',
  metadata: { type: 'meeting', generation: { content_hash: sha('a') }, sources: [{ type: 'document', ref: `repository ${name}`, source_hash: sha('b') }], ...extra } });
const mechanical = [{ op: 'remove-content-hash' }, { op: 'strip-source-hashes' }, { op: 'remove-fields', fields: ['type'] }];
const repairsFor = names => names.map(name => ({ target: `${name}.md`, operations: mechanical }));

async function fixture(t, { saving = 'auto', notes: names = ['a', 'b'], expandedMetadata = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-repair-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  const project = createProject({ id: 'demo', root: cwd, destination: { kind: 'directory', path: notes }, saving, expandedMetadata });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const file = name => path.join(notes, `${name}.md`), originals = new Map();
  for (const name of names) { originals.set(name, note(name)); await fs.writeFile(file(name), originals.get(name)); }
  const tools = createDirectNoteTools({ store, client: 'claude', skillVersion });
  const call = (name, input) => tools.call(name, { projectId: 'demo', ...input });
  return { root, notes, store, project, tools, call, file, originals, read: name => fs.readFile(file(name)), status: () => readProjectStatus(store, 'demo'),
    preview: (repairs, extra = {}) => call('cuefluent_preview_repair', { repairs, ...extra }),
    repair: (repairs, proposal, requestId = randomUUID()) => call('cuefluent_repair_notes', { requestId, proposal, repairs }) };
}
/** Every entry below a folder with its identity, size, time and bytes. */
async function tree(directory) {
  const names = (await fs.readdir(directory, { recursive: true })).sort();
  return Promise.all(names.map(async relative => {
    const file = path.join(directory, relative), stat = await fs.lstat(file, { bigint: true });
    return { relative, inode: stat.ino, size: stat.size, modified: stat.mtimeNs, bytes: stat.isFile() ? await fs.readFile(file) : null };
  }));
}
/** Every page of a preview or a review, following its cursor a bounded number of times. */
async function paged(first, more) {
  const pages = [first];
  for (let guard = 0; pages.at(-1).next; guard++) { assert.ok(guard < 64, 'a paging loop must end'); pages.push(await more(pages.at(-1).next)); }
  return pages;
}
const code = (expected, work) => assert.rejects(work, error => error.code === expected, `expected ${expected}`);
const untouched = async f => { const status = await f.status(); assert.equal(status.run, null); assert.equal(status.latest, null); };

test('a preview lists every selected note under one proposal and writes, retains and reserves nothing', async t => {
  const f = await fixture(t, { notes: ['a', 'b'] });
  await fs.writeFile(f.file('plain'), body('plain')); await fs.writeFile(f.file('broken'), '# Only a topic\n'); await fs.mkdir(f.file('folder'));
  const before = await tree(f.root);
  const repairs = [...repairsFor(['a', 'plain', 'broken', 'folder', 'absent']), { target: 'b.md', operations: [{ op: 'remove-sources', sources: [4] }] }];
  const preview = await f.preview(repairs);
  assert.deepEqual(await tree(f.root), before); await untouched(f);
  assert.equal(preview.state, 'previewed'); assert.equal(preview.saving, 'auto'); assert.equal(preview.next, null); assert.match(preview.proposal, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.counts, { change: 1, unchanged: 1, refused: 4, deferred: 0 });
  assert.deepEqual(preview.targets.map(item => [path.basename(item.target), item.state, item.code]), [['a.md', 'change', undefined], ['plain.md', 'unchanged', undefined],
    ['broken.md', 'refused', 'REPAIR_NOTE_BLOCKED'], ['folder.md', 'refused', 'PATH_UNSAFE'], ['absent.md', 'refused', 'REPAIR_NOTE_MISSING'], ['b.md', 'refused', 'REPAIR_OPERATION_INVALID']]);
  const [changed] = preview.targets, original = f.originals.get('a'), candidate = constructRepair(original, mechanical).bytes;
  assert.deepEqual([changed.expectedHash, changed.hash, changed.bytes], [hashBytes(original), hashBytes(candidate), { before: original.length, after: candidate.length }]);
  assert.deepEqual(changed.operations, ['remove-content-hash', 'strip-source-hashes', 'remove-fields']);
  assert.equal(changed.changes, serializeRepair(describeRepair(original, candidate))); assert.deepEqual(changed.remaining, {});
  // A name that is no note target, a repeated note and a malformed selection are argument errors.
  for (const [expected, invalid] of [['PATH_INVALID', [{ target: '../outside.md', operations: mechanical }]], ['NOTE_TARGET_RESERVED', [{ target: 'logs/2026.md', operations: mechanical }]],
    ['NOTE_TARGET_INVALID', [{ target: 'a.txt', operations: mechanical }]], ['REPAIR_ARGUMENT', [...repairsFor(['a']), { target: f.file('a'), operations: mechanical }]],
    ['REPAIR_ARGUMENT', [{ target: 'a.md', operations: [] }]], ['REPAIR_ARGUMENT', [{ target: 'a.md' }]], ['REPAIR_ARGUMENT', [{ target: 'a.md', operations: mechanical, extra: 1 }]], ['REPAIR_ARGUMENT', []],
    ['REPAIR_ARGUMENT', Array.from({ length: REPAIR_BATCH.targets + 1 }, (_, index) => ({ target: `n${index}.md`, operations: mechanical }))]]) {
    await code(expected, () => f.preview(invalid));
  }
  await code('PROJECT_UNCONFIGURED', () => f.tools.call('cuefluent_preview_repair', { projectId: 'other', repairs }));
  assert.deepEqual(await tree(f.root), before);
});

test('a long change list spans bounded pages under one proposal, and a changed note refuses the next page', async t => {
  const f = await fixture(t, { notes: [] }), wide = `a "quoted" réference ${'é"'.repeat(80)}`;
  const sources = Array.from({ length: 110 }, (_, index) => ({ type: 'document', ref: `${index} ${wide}` }));
  const original = note('wide', { sources }); await fs.writeFile(f.file('wide'), original); await fs.writeFile(f.file('small'), note('small'));
  const repairs = [{ target: 'wide.md', operations: [{ op: 'remove-sources', sources: sources.map((_, index) => index) }] }, ...repairsFor(['small'])];
  const pages = await paged(await f.preview(repairs), cursor => f.preview(repairs, { cursor }));
  assert.ok(pages.length > 1, `expected several pages, got ${pages.length}`);
  for (const page of pages) { assert.ok(Buffer.byteLength(JSON.stringify(page)) <= REVIEW_PAGE_BYTES); assert.equal(page.proposal, pages[0].proposal); assert.deepEqual(page.counts, pages[0].counts); }
  const pieces = pages.flatMap(page => page.targets).filter(item => item.index === 0);
  assert.equal(pieces.map(item => item.changes).join(''), serializeRepair(describeRepair(original, constructRepair(original, repairs[0].operations).bytes)));
  assert.deepEqual(pages.at(-1).targets.at(-1).state, 'change');
  for (const cursor of ['x', `${pages[0].proposal}:9:0`, `${pages[0].proposal}:1:99999`, `${pages[0].proposal}:0:99999999`, `${pages[0].proposal}:01:0`]) {
    await assert.rejects(() => f.preview(repairs, { cursor }), error => ['DIRECT_NOTE_ARGUMENT', 'REPAIR_ARGUMENT'].includes(error.code), cursor);
  }
  await fs.appendFile(f.file('small'), '\nAn edit.\n');
  await code('REPAIR_PROPOSAL_CHANGED', () => f.preview(repairs, { cursor: pages[0].next }));
});

test('the proposal stands for the notes, their order, the operations and the candidates, not for how a request is spelled', async t => {
  const f = await fixture(t, { notes: ['a', 'b'] }), descriptor = { type: 'document', ref: 'Design notes', locator: 'Part 1' };
  const repairs = [{ target: 'a.md', operations: [{ op: 'replace-sources', sources: [0], with: descriptor }, { op: 'remove-content-hash' }] }, ...repairsFor(['b'])];
  const proposal = async selected => (await f.preview(selected)).proposal, first = await proposal(repairs);
  const respelled = [{ operations: [{ with: { locator: 'Part 1', ref: 'Design notes', type: 'document' }, sources: [0], op: 'replace-sources' }, { op: 'remove-content-hash' }], target: f.file('a') }, repairs[1]];
  assert.equal(await proposal(respelled), first);
  const variants = { order: [repairs[1], repairs[0]], operation: [{ target: 'a.md', operations: [repairs[0].operations[0]] }, repairs[1]],
    replacement: [{ target: 'a.md', operations: [{ op: 'replace-sources', sources: [0], with: { ...descriptor, locator: 'Part 2' } }, { op: 'remove-content-hash' }] }, repairs[1]], subset: [repairs[0]] };
  for (const [name, selected] of Object.entries(variants)) assert.notEqual(await proposal(selected), first, name);
  await fs.appendFile(f.file('b'), '\nAn edit.\n');
  assert.notEqual(await proposal(repairs), first);
});

test('a repair without its exact proposal, or with a refused note, is refused before a run or a write exists', async t => {
  const f = await fixture(t, { notes: ['a', 'b'] }), repairs = repairsFor(['a', 'b']), before = await tree(f.notes), preview = await f.preview(repairs);
  await code('REPAIR_PROPOSAL_CHANGED', () => f.repair(repairs, 'f'.repeat(64)));
  await code('REPAIR_PROPOSAL_CHANGED', () => f.repair([repairs[0]], preview.proposal));
  await code('DIRECT_NOTE_ARGUMENT', () => f.call('cuefluent_repair_notes', { requestId: randomUUID(), repairs }));
  await code('DIRECT_NOTE_ARGUMENT', () => f.repair(repairs, preview.proposal, 'not-a-uuid'));
  const refused = [...repairs, ...repairsFor(['absent'])], refusedPreview = await f.preview(refused);
  await code('REPAIR_TARGET_REFUSED', () => f.repair(refused, refusedPreview.proposal));
  assert.deepEqual(await tree(f.notes), before); await untouched(f);
  // The inspected bytes are part of the proposal: an edit after the preview needs a fresh one.
  await fs.appendFile(f.file('b'), '\nAn edit.\n'); const edited = await f.read('b');
  await code('REPAIR_PROPOSAL_CHANGED', () => f.repair(repairs, preview.proposal));
  assert.deepEqual(await f.read('b'), edited); assert.deepEqual(await f.read('a'), f.originals.get('a')); await untouched(f);
});

test('automatic saving writes the exact candidates, keeps identity, times and writer version, and logs no activity', async t => {
  const f = await fixture(t, { notes: ['a', 'b'] });
  await fs.writeFile(f.file('plain'), body('plain'));
  // An ordinary note is logged in the project's series, which a repair must leave alone.
  const timezone = f.project.activityLog.timezone, year = logYear(new Date().toISOString(), timezone), log = path.join(f.notes, 'logs', `${year}.md`);
  await fs.mkdir(path.dirname(log));
  await fs.writeFile(log, createAnnualLog({ year, noteId: randomUUID(), seriesId: 'series', timezone, skillVersion, createdAt: `${year}-01-01T00:00:00Z` }));
  const empty = await fs.readFile(log);
  const created = await f.call('cuefluent_create_note', { requestId: randomUUID(), target: 'ordinary.md', content: '# Ordinary\n\n## Section\nText.\n', summary: 'An ordinary note' });
  assert.equal(created.state, 'saved');
  const logged = await fs.readFile(log), plain = await fs.lstat(f.file('plain'), { bigint: true });
  assert.ok(logged.length > empty.length, 'the ordinary note is logged');
  const repairs = repairsFor(['a', 'plain', 'b']), preview = await f.preview(repairs), requestId = randomUUID();
  const applied = await f.repair(repairs, preview.proposal, requestId);
  assert.equal(applied.state, 'saved'); assert.equal(applied.runId, requestId);
  assert.deepEqual(applied.result.paths, [f.file('a'), f.file('b')]); assert.deepEqual(applied.result.counts, { handled: 0, saved: 2, remaining: null });
  assert.deepEqual(applied.batch, { selected: 3, counts: { change: 2, unchanged: 1, refused: 0, deferred: 0 }, omitted: 0, unchanged: [f.file('plain')], deferred: [],
    changed: ['a', 'b'].map(name => ({ target: f.file(name), before: f.originals.get(name).length, after: constructRepair(f.originals.get(name), mechanical).bytes.length })) });
  for (const name of ['a', 'b']) {
    const original = f.originals.get(name), saved = await f.read(name), was = inspectMetadata(original).value, now = inspectMetadata(saved).value;
    assert.deepEqual(saved, constructRepair(original, mechanical).bytes);
    assert.deepEqual([now.id, now.created, now.updated, now.generation], [was.id, was.created, was.updated, { skill_version: '0.19.0' }]);
  }
  const after = await fs.lstat(f.file('plain'), { bigint: true });
  assert.deepEqual([after.ino, after.mtimeNs, after.size], [plain.ino, plain.mtimeNs, plain.size]);
  assert.deepEqual(await fs.readFile(log), logged); assert.deepEqual(await fs.readdir(path.join(f.notes, 'logs')), [`${year}.md`]);
  // A repaired note takes the same mechanical request again unchanged, and an ordinary update still follows and is logged.
  assert.deepEqual((await f.preview(repairs)).counts, { change: 0, unchanged: 3, refused: 0, deferred: 0 });
  const read = await f.call('cuefluent_read_note', { target: 'a.md' });
  const updated = await f.call('cuefluent_update_note', { requestId: randomUUID(), target: 'a.md', expectedHash: read.hash, content: `${body('a')}\nAdded text.\n`, summary: 'An ordinary update' });
  assert.equal(updated.state, 'saved'); assert.ok((await fs.readFile(log)).length > logged.length);
  assert.equal(inspectMetadata(await f.read('a')).value.generation.skill_version, skillVersion);
});

test('a retry returns the settled outcome, a requestId serves only its own batch, and an older batch is not replayed', async t => {
  const f = await fixture(t, { notes: ['a', 'b'] }), first = repairsFor(['a']), second = repairsFor(['b']);
  const preview = await f.preview(first), requestId = randomUUID(), applied = await f.repair(first, preview.proposal, requestId), saved = await tree(f.notes);
  const replayed = await f.repair(first, preview.proposal, requestId);
  assert.deepEqual(replayed, { state: applied.state, projectId: applied.projectId, runId: applied.runId, result: applied.result });
  await code('REPAIR_REQUEST_CHANGED', () => f.repair(second, preview.proposal, requestId));
  await code('REPAIR_REQUEST_CHANGED', () => f.repair(first, 'e'.repeat(64), requestId));
  await code('DIRECT_NOTE_REQUEST_CHANGED', () => f.call('cuefluent_create_note', { requestId, target: 'other.md', content: '# T\n\n## S\nText.\n', summary: 'Another request' }));
  assert.deepEqual(await tree(f.notes), saved);
  // Only the latest outcome answers a retry; after another batch the first is checked afresh, and its proposal no longer stands.
  assert.equal((await f.repair(second, (await f.preview(second)).proposal)).state, 'saved');
  await code('REPAIR_PROPOSAL_CHANGED', () => f.repair(first, preview.proposal, requestId));
});

test('review mode retains the batch for Save, Discard or Keep pending, and shows its complete change list', async t => {
  const f = await fixture(t, { saving: 'review', notes: ['a', 'b', 'c'] }), repairs = repairsFor(['a', 'b']), before = await tree(f.notes);
  const preview = await f.preview(repairs), requestId = randomUUID(), review = await f.repair(repairs, preview.proposal, requestId);
  assert.deepEqual([review.state, review.kind, review.phase, review.draftCount, review.choices], ['review', 'repair', 'review', 2, ['Save', 'Discard', 'Keep pending']]);
  // A review page is already a whole page: it lists the changed notes and carries no second report.
  assert.equal(review.batch, undefined); assert.ok(Buffer.byteLength(JSON.stringify(review)) <= REVIEW_PAGE_BYTES);
  for (const [index, name] of ['a', 'b'].entries()) {
    const draft = review.drafts[index], original = f.originals.get(name), candidate = constructRepair(original, mechanical).bytes;
    assert.deepEqual([draft.target, draft.part, draft.content, draft.expectedHash, draft.hash, draft.saved], [f.file(name), 'changes', '', hashBytes(original), hashBytes(candidate), false]);
    assert.equal(draft.changes, serializeRepair(describeRepair(original, candidate))); assert.match(draft.summary, /^Metadata repair: /);
  }
  assert.deepEqual(await tree(f.notes), before);
  const status = await f.status();
  assert.deepEqual([status.state, status.run.kind, status.run.id, isRepairRun(status.run), status.run.scope.repair], ['review', 'repair', requestId, true, preview.proposal]);
  // Keeping it pending answers the same request with the same retained set, and holds the project's one run.
  const again = await f.repair(repairs, preview.proposal, requestId);
  assert.deepEqual([again.revision, again.drafts.map(item => item.changes)], [review.revision, review.drafts.map(item => item.changes)]);
  assert.equal((await f.repair(repairsFor(['c']), (await f.preview(repairsFor(['c']))).proposal)).state, 'busy');
  assert.equal((await f.call('cuefluent_create_note', { requestId: randomUUID(), target: 'new.md', content: '# T\n\n## S\nText.\n', summary: 'A note' })).state, 'busy');
  assert.equal((await f.call('cuefluent_check_notes', {})).run.kind, 'repair');
  await code('REVIEW_REVISION_STALE', () => f.call('cuefluent_save_note', { runId: requestId, revision: 'f'.repeat(64) }));
  const discarded = await f.call('cuefluent_skip_note', { runId: requestId, revision: review.revision });
  assert.equal(discarded.state, 'skipped'); assert.deepEqual(await tree(f.notes), before); assert.equal((await f.status()).run, null);
  // A discarded batch is not applied by repeating its request; a fresh one saves the exact candidates.
  const fresh = randomUUID(), second = await f.repair(repairs, preview.proposal, fresh);
  const saved = await f.call('cuefluent_save_note', { runId: fresh, revision: second.revision });
  assert.equal(saved.state, 'saved'); assert.deepEqual(saved.result.paths, [f.file('a'), f.file('b')]);
  for (const name of ['a', 'b']) assert.deepEqual(await f.read(name), constructRepair(f.originals.get(name), mechanical).bytes);
  assert.deepEqual(await f.read('c'), f.originals.get('c')); assert.equal(await fs.stat(path.join(f.notes, 'logs')).then(() => true, () => false), false);
});

test('a reviewed change list that exceeds one page is followed with its cursor, like the preview', async t => {
  const f = await fixture(t, { saving: 'review', notes: [] }), wide = `a "quoted" réference ${'é"'.repeat(80)}`;
  const sources = Array.from({ length: 110 }, (_, index) => ({ type: 'document', ref: `${index} ${wide}` })), original = note('wide', { sources });
  await fs.writeFile(f.file('wide'), original);
  const repairs = [{ target: 'wide.md', operations: [{ op: 'remove-sources', sources: sources.map((_, index) => index) }] }], requestId = randomUUID();
  const pages = await paged(await f.repair(repairs, (await f.preview(repairs)).proposal, requestId), next => f.call('cuefluent_review_note', { runId: requestId, ...next }));
  assert.ok(pages.length > 1);
  for (const page of pages) { assert.ok(Buffer.byteLength(JSON.stringify(page)) <= REVIEW_PAGE_BYTES); assert.equal(page.revision, pages[0].revision); }
  assert.deepEqual(pages[0].next.part, 'changes');
  assert.equal(pages.flatMap(page => page.drafts).map(item => item.changes).join(''), serializeRepair(describeRepair(original, constructRepair(original, repairs[0].operations).bytes)));
  await code('REVIEW_ARGUMENT', () => f.call('cuefluent_review_note', { runId: requestId, part: 'sources' }));
});

test('a note edited after review is not overwritten, and the batch says truthfully what was saved', async t => {
  const f = await fixture(t, { saving: 'review', notes: ['a', 'b'] }), repairs = repairsFor(['a', 'b']), requestId = randomUUID();
  const review = await f.repair(repairs, (await f.preview(repairs)).proposal, requestId);
  await fs.appendFile(f.file('b'), '\nAn edit made after the review.\n'); const edited = await f.read('b');
  await code('NOTE_PUBLICATION_CONFLICT', () => f.call('cuefluent_save_note', { runId: requestId, revision: review.revision }));
  assert.deepEqual(await f.read('a'), constructRepair(f.originals.get('a'), mechanical).bytes); assert.deepEqual(await f.read('b'), edited);
  const interrupted = await f.call('cuefluent_review_note', { runId: requestId });
  assert.deepEqual([interrupted.state, interrupted.revision, interrupted.savedCount], ['interrupted', review.revision, 1]);
  assert.deepEqual(interrupted.drafts.map(item => [item.saved, JSON.parse(item.changes)]), [[true, { unavailable: 'saved' }], [false, { unavailable: 'changed' }]]);
  const stopped = (await f.status()).run;
  assert.deepEqual(stopped.savedPaths, [f.file('a')]); assert.match(stopped.recovery, /Relay Discard to release the run, then check the note and preview the repair again/);
  const released = await f.call('cuefluent_skip_note', { runId: requestId, revision: review.revision });
  assert.equal(released.state, 'skipped'); assert.deepEqual(await f.read('b'), edited);
  // The edited note takes a fresh preview against its current bytes.
  const fresh = repairsFor(['b']), applied = await f.repair(fresh, (await f.preview(fresh)).proposal);
  assert.equal(applied.state, 'review'); assert.equal(applied.draftCount, 1);
});

test('an interrupted repair is restored from its retained candidates instead of being built again', async t => {
  const f = await fixture(t, { saving: 'review', notes: ['a', 'b'] }), repairs = repairsFor(['a', 'b']), requestId = randomUUID(), preview = await f.preview(repairs);
  const review = await f.repair(repairs, preview.proposal, requestId);
  // As if the process stopped after the candidates were retained and before the set was published.
  await withProject(f.store, 'demo', async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, phase: 'drafting', drafts: [] }), { expectedHash: stored.hash });
  });
  const interrupted = await f.call('cuefluent_review_note', { runId: requestId });
  assert.deepEqual([interrupted.state, interrupted.phase, interrupted.kind, interrupted.choices], ['interrupted', 'drafting', 'repair', ['Restore draft', 'Discard', 'Keep pending']]);
  await code('REVIEW_REVISION_STALE', () => f.call('cuefluent_save_note', { runId: requestId, revision: review.revision }));
  // Restore draft relays to the save tool and only brings the review back; nothing is written.
  const viaTool = await f.call('cuefluent_save_note', { runId: requestId, revision: interrupted.revision });
  assert.deepEqual([viaTool.state, viaTool.revision, viaTool.drafts.map(item => item.changes)], ['review', review.revision, review.drafts.map(item => item.changes)]);
  assert.deepEqual(await f.read('a'), f.originals.get('a'));
  // A note edited meanwhile would refuse a rebuilt batch; the retained one comes back as it was and says so.
  await fs.appendFile(f.file('b'), '\nAn edit made meanwhile.\n'); const edited = await f.read('b');
  const restored = await f.repair(repairs, preview.proposal, requestId);
  assert.deepEqual([restored.state, restored.revision, restored.batch], ['review', review.revision, undefined]);
  assert.deepEqual(restored.drafts.map(item => [item.hash, item.changes]), [[review.drafts[0].hash, review.drafts[0].changes], [review.drafts[1].hash, serializeRepair({ unavailable: 'changed' })]]);
  await code('NOTE_PUBLICATION_CONFLICT', () => f.call('cuefluent_save_note', { runId: requestId, revision: restored.revision }));
  assert.deepEqual(await f.read('a'), constructRepair(f.originals.get('a'), mechanical).bytes); assert.deepEqual(await f.read('b'), edited);
  assert.equal(await fs.stat(path.join(f.notes, 'logs')).then(() => true, () => false), false);
});

test('an automatic repair that stopped before saving is finished from its retained candidates and still logs nothing', async t => {
  const f = await fixture(t, { notes: ['a', 'b'] }), repairs = repairsFor(['a', 'b']), requestId = randomUUID(), preview = await f.preview(repairs);
  // Reserve and retain the batch as the tool does, then stop before the set is published, as a crash would.
  const workspace = await openNoteWorkspace({ project: f.project, runId: requestId, skillVersion });
  for (const repair of repairs) await workspace.repair(repair);
  await workspace.finish_drafting({ outcome: 'drafted' }); const manifest = await workspace.manifest();
  const run = createRun(f.project, [], { id: requestId, scope: { kind: 'direct', requestHash: 'c'.repeat(64), repair: preview.proposal } });
  await withProject(f.store, 'demo', ({ directory }) => writeJSON(f.store.pin, `${directory}/run.json`, run, { expectedHash: null }));
  await ownDirectAttempt(f.store, 'demo', requestId, owner => persistDraftManifest(f.store, owner, manifest));
  await withProject(f.store, 'demo', async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, phase: 'drafting', drafts: [] }), { expectedHash: stored.hash });
  });
  assert.deepEqual(await f.read('a'), f.originals.get('a'));
  const offered = await f.call('cuefluent_review_note', { runId: requestId });
  assert.deepEqual([offered.phase, offered.kind, offered.choices], ['drafting', 'repair', ['Save', 'Discard', 'Keep pending']]);
  const saved = await f.call('cuefluent_save_note', { runId: requestId, revision: offered.revision });
  assert.equal(saved.state, 'saved'); assert.deepEqual(saved.result.paths, [f.file('a'), f.file('b')]);
  for (const name of ['a', 'b']) assert.deepEqual(await f.read(name), constructRepair(f.originals.get(name), mechanical).bytes);
  assert.equal(await fs.stat(path.join(f.notes, 'logs')).then(() => true, () => false), false); assert.equal((await f.status()).run, null);
});

test('a note keeps its own header layout whichever formatting the project prefers', async t => {
  for (const expandedMetadata of [false, true]) {
    const f = await fixture(t, { notes: [], expandedMetadata });
    const compact = note('compact'), expanded = createGeneratedNote(body('expanded'), { id: randomUUID(), now: '2026-10-22T01:00:00Z', skillVersion: '0.19.0', expandedMetadata: true,
      metadata: { type: 'meeting', generation: { content_hash: sha('a') }, sources: [{ type: 'document', ref: 'repository', source_hash: sha('b') }] } });
    await fs.writeFile(f.file('compact'), compact); await fs.writeFile(f.file('expanded'), expanded);
    const repairs = repairsFor(['compact', 'expanded']);
    assert.equal((await f.repair(repairs, (await f.preview(repairs)).proposal)).state, 'saved');
    const flow = async name => parseDocument(inspectMetadata(await f.read(name)).raw.split(/\r?\n/).slice(1, -2).join('\n')).contents.flow === true;
    assert.deepEqual(await f.read('compact'), constructRepair(compact, mechanical).bytes); assert.deepEqual(await f.read('expanded'), constructRepair(expanded, mechanical).bytes);
    assert.deepEqual([await flow('compact'), await flow('expanded')], [true, false]);
  }
});

test('a batch holds as many changed notes as one run retains and names the rest as deferred', async t => {
  // One note more than a run retains, and one that does not change and so does not count.
  const bound = WORKSPACE_LIMITS.drafts, last = `n${String(bound + 1).padStart(2, '0')}`;
  const names = Array.from({ length: bound + 2 }, (_, index) => `n${String(index).padStart(2, '0')}`), f = await fixture(t, { notes: names });
  await fs.writeFile(f.file('n05'), body('plain'));
  const before = await tree(f.notes), repairs = repairsFor(names), preview = await f.preview(repairs);
  const listed = (await paged(preview, cursor => f.preview(repairs, { cursor }))).flatMap(page => page.targets);
  assert.deepEqual(preview.counts, { change: bound, unchanged: 1, refused: 0, deferred: 1 }); assert.equal(listed.length, names.length);
  assert.deepEqual(listed.filter(item => item.state !== 'change').map(item => [path.basename(item.target), item.state]), [['n05.md', 'unchanged'], [`${last}.md`, 'deferred']]);
  assert.deepEqual(await tree(f.notes), before);
  // The same rule through a save, with the bound lowered: one call is one run, and the deferred note is untouched.
  const apply = (selected, proposal, limits) => repairNotes(f.store, { projectId: 'demo', requestId: randomUUID(), proposal, repairs: selected }, { client: 'claude', skillVersion, limits });
  const selected = repairsFor(['n00', 'n05', 'n01', 'n02']), small = await previewRepair(f.store, { projectId: 'demo', repairs: selected }, { skillVersion, limits: { drafts: 2 } });
  assert.deepEqual(small.targets.map(item => item.state), ['change', 'unchanged', 'change', 'deferred']);
  const applied = await apply(selected, small.proposal, { drafts: 2 });
  assert.deepEqual([applied.result.paths, applied.batch.unchanged, applied.batch.deferred], [[f.file('n00'), f.file('n01')], [f.file('n05')], [f.file('n02')]]);
  assert.deepEqual(await f.read('n02'), f.originals.get('n02'));
  // Without that bound the same selection is another proposal, and the deferred note is a batch of its own.
  await code('REPAIR_PROPOSAL_CHANGED', () => f.repair(selected, small.proposal));
  const rest = repairsFor(['n02']), next = await f.preview(rest);
  assert.deepEqual(next.counts, { change: 1, unchanged: 0, refused: 0, deferred: 0 }); assert.notEqual(next.proposal, small.proposal);
  assert.deepEqual((await f.repair(rest, next.proposal)).result.paths, [f.file('n02')]);
  // A smaller private budget makes a smaller batch, said the same way.
  const limits = { privateBytes: f.originals.get('n10').length + constructRepair(f.originals.get('n10'), mechanical).bytes.length }, three = repairsFor(['n10', 'n11', 'n12']);
  const tight = await previewRepair(f.store, { projectId: 'demo', repairs: three }, { skillVersion, limits });
  assert.deepEqual(tight.targets.map(item => item.state), ['change', 'deferred', 'deferred']);
  const saved = await apply(three, tight.proposal, limits);
  assert.deepEqual([saved.result.paths, saved.batch.deferred], [[f.file('n10')], [f.file('n11'), f.file('n12')]]);
});

test('a change list above its bound refuses only that note, and every offset within the bound can be paged', async t => {
  const f = await fixture(t), repairs = [{ target: 'a.md', operations: mechanical }, { target: 'b.md', operations: [{ op: 'remove-content-hash' }] }];
  const whole = await previewRepair(f.store, { projectId: 'demo', repairs }, { skillVersion }), [large, small] = whole.targets.map(item => item.totalBytes);
  assert.ok(large > small);
  const bounded = await previewRepair(f.store, { projectId: 'demo', repairs }, { skillVersion, limits: { changeBytes: small } });
  assert.deepEqual(bounded.targets.map(item => [item.state, item.code ?? null]), [['refused', 'REPAIR_CHANGES_LIMIT'], ['change', null]]);
  assert.equal(bounded.targets[1].changes, whole.targets[1].changes);
  // A change list can outgrow its note, so both cursors reach the whole bound, not only the note file limit.
  assert.ok(WORKSPACE_LIMITS.changeBytes > NOTE_PROFILE.fileBytes);
  assert.match(`${whole.proposal}:${REPAIR_BATCH.targets - 1}:${WORKSPACE_LIMITS.changeBytes - 1}`, new RegExp(REPAIR_CURSOR_PATTERN));
  const review = start => f.call('cuefluent_review_note', { runId: randomUUID(), part: 'changes', start });
  await code('REVIEW_RUN_CHANGED', () => review(WORKSPACE_LIMITS.changeBytes - 1));
  await code('DIRECT_NOTE_ARGUMENT', () => review(WORKSPACE_LIMITS.changeBytes + 1));
});

test('a repair run carries its proposal, can hold no log event, and no ordinary request can become one', async t => {
  const f = await fixture(t, { notes: ['a'] }), requestHash = 'a'.repeat(64), proposal = 'b'.repeat(64);
  const run = createRun(f.project, [], { id: randomUUID(), scope: { kind: 'direct', requestHash, repair: proposal } }), ordinary = createRun(f.project, [], { id: randomUUID(), scope: { kind: 'direct', requestHash } });
  assert.deepEqual([isRepairRun(run), runKind(run), isRepairRun(ordinary), runKind(ordinary)], [true, 'repair', false, 'direct']);
  for (const scope of [{ kind: 'direct', requestHash, repair: 'short' }, { kind: 'direct', requestHash, repair: proposal, other: 1 }, { kind: 'project', repair: proposal }]) {
    assert.throws(() => createRun(f.project, [], { id: randomUUID(), scope }), error => error.code === 'RUN_INVALID');
  }
  const binding = { root: f.notes, parent: [], seriesId: 'series', timezone: 'UTC' };
  assert.throws(() => validateRun({ ...run, logging: binding }), error => error.code === 'RUN_INVALID');
  // The ordinary tools take content and document sources only: no argument names a repair or reaches a header.
  for (const name of ['cuefluent_create_note', 'cuefluent_update_note']) {
    const properties = Object.keys(f.tools.tools.find(tool => tool.name === name).inputSchema.properties);
    assert.deepEqual(properties.filter(key => ['repairs', 'proposal', 'operations', 'repair'].includes(key)), []);
  }
  const read = await f.call('cuefluent_read_note', { target: 'a.md' });
  const stripped = constructRepair(f.originals.get('a'), mechanical).bytes.toString();
  const update = await f.call('cuefluent_update_note', { requestId: randomUUID(), target: 'a.md', expectedHash: read.hash, content: `${stripped}\nMore.\n`, summary: 'An update that carries another header' });
  assert.equal(update.state, 'saved');
  const value = inspectMetadata(await f.read('a')).value;
  assert.deepEqual([value.type, value.generation.content_hash, value.sources[0].source_hash], ['meeting', sha('a'), sha('b')]);
  assert.equal((await f.status()).latest.requestHash.length, 64);
});

test('both MCP hosts serve preview and repair through the response contract, and both stay unavailable without a store', async t => {
  for (const client of ['claude', 'codex']) {
    const f = await fixture(t, { notes: ['a'] }), tools = createDirectNoteTools({ store: f.store, client, skillVersion }), repairs = repairsFor(['a']);
    assert.equal(tools.tools.find(tool => tool.name === 'cuefluent_preview_repair').annotations.readOnlyHint, true);
    assert.equal(tools.tools.find(tool => tool.name === 'cuefluent_repair_notes').annotations.readOnlyHint, false);
    const bridge = createControlBridge({ client, directNotes: tools, codexAdapter: { bindCommand: () => assert.fail('No native transcript reads') },
      executeInvocation: () => assert.fail('No native commands'), readInvocation: () => assert.fail('No native handle') });
    const protocol = bridge.protocol({ version: skillVersion });
    await protocol({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } });
    await protocol({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const call = async (id, name, args) => (await protocol({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { projectId: 'demo', ...args },
      ...(client === 'codex' ? { _meta: { 'x-codex-turn-metadata': { session_id: 'native-session', thread_id: 'native-session', turn_id: `turn-${id}` } } } : {}) } })).result;
    const preview = await call(2, 'cuefluent_preview_repair', { repairs });
    assert.equal(preview.isError, false); assert.deepEqual(preview.structuredContent.counts, { change: 1, unchanged: 0, refused: 0, deferred: 0 });
    const refused = await call(3, 'cuefluent_repair_notes', { requestId: randomUUID(), proposal: 'f'.repeat(64), repairs });
    assert.equal(refused.isError, true); assert.equal(JSON.parse(refused.content[0].text).error, 'REPAIR_PROPOSAL_CHANGED');
    const malformed = await call(4, 'cuefluent_preview_repair', { repairs: [{ target: 'a.md', operations: [{ op: 'rewrite' }] }] });
    assert.equal(malformed.isError, true); assert.equal(JSON.parse(malformed.content[0].text).error, 'REPAIR_ARGUMENT');
    const applied = await call(5, 'cuefluent_repair_notes', { requestId: randomUUID(), proposal: preview.structuredContent.proposal, repairs });
    assert.equal(applied.isError, false); assert.equal(applied.structuredContent.state, 'saved');
    const absent = createDirectNoteTools({ store: null, client, skillVersion });
    for (const [name, args] of [['cuefluent_preview_repair', { repairs }], ['cuefluent_repair_notes', { requestId: randomUUID(), proposal: 'f'.repeat(64), repairs }]]) {
      assert.equal((await absent.call(name, { projectId: 'demo', ...args })).state, 'unconfigured');
    }
  }
});


test('changing the saving mode invalidates a repair proposal before reservation', async t => {
  const f = await fixture(t, { saving: 'review' }), repairs = repairsFor(['a']), preview = await f.preview(repairs);
  const settings = await readSettings(f.store);
  await updateSettings(f.store, { ...settings.value, projects: settings.value.projects.map(project => ({ ...project, saving: 'auto' })) }, { expectedHash: settings.hash });
  await code('REPAIR_PROPOSAL_CHANGED', () => f.repair(repairs, preview.proposal));
  await untouched(f); assert.deepEqual(await f.read('a'), f.originals.get('a'));
});

test('a repair refuses case and normalization aliases instead of renaming the saved note', async t => {
  const f = await fixture(t);
  for (const [stored, requested] of [['meeting', 'Meeting'], ['café', 'cafe\u0301']]) {
    await fs.writeFile(f.file(stored), note(stored));
    const preview = await f.preview(repairsFor([requested, 'a']));
    assert.equal(preview.targets[0].state, 'refused');
    assert.equal(preview.targets[0].code, 'WORKSPACE_TARGET_ALIAS');
    assert.equal(preview.targets[1].state, 'change');
  }
  await untouched(f);
});

test('repair inspection uses remaining bytes rather than reserving a maximum-sized file', async t => {
  const f = await fixture(t), repairs = repairsFor(['a', 'b']);
  const preview = await previewRepair(f.store, { projectId: 'demo', repairs }, { skillVersion, limits: { privateBytes: 8192 } });
  assert.deepEqual(preview.counts, { change: 2, unchanged: 0, refused: 0, deferred: 0 });
});

test('a repair exceeding the line profile refuses only its target', async t => {
  const f = await fixture(t), prefix = '<!-- aliases: a, ';
  const huge = `# Topic\n\n## Overview\n${prefix}${'b'.repeat(NOTE_PROFILE.lineBytes - Buffer.byteLength(prefix + ' -->'))} -->\nBody.\n`;
  await fs.writeFile(f.file('huge'), huge);
  const preview = await f.preview([{ target: 'huge.md', operations: [{ op: 'replace-alias', line: 3, alias: 'a', with: 'longer' }] }, ...repairsFor(['a'])]);
  assert.equal(preview.targets[0].state, 'refused'); assert.equal(preview.targets[0].code, 'REPAIR_SCOPE_VIOLATION');
  assert.equal(preview.targets[1].state, 'change');
});

test('a continuation of a repair review reports a changed original instead of applying the old offset', async t => {
  const f = await fixture(t, { saving: 'review', notes: [] });
  const sources = Array.from({ length: 110 }, (_, index) => ({ type: 'document', ref: `${index} ${'é"'.repeat(80)}` }));
  await fs.writeFile(f.file('wide'), note('wide', { sources }));
  const repairs = [{ target: 'wide.md', operations: [{ op: 'remove-sources', sources: sources.map((_, index) => index) }] }];
  const preview = await f.preview(repairs), review = await f.repair(repairs, preview.proposal);
  assert.ok(review.next?.start > 0);
  await fs.appendFile(f.file('wide'), '\nManual edit.\n');
  const next = await f.call('cuefluent_review_note', { runId: review.runId, ...review.next });
  assert.equal(next.drafts[0].start, 0); assert.deepEqual(JSON.parse(next.drafts[0].changes), { unavailable: 'changed' });
});


test('one repair review page reads only the candidate it reaches', async t => {
  const f = await fixture(t, { saving: 'review', notes: ['a', 'b', 'c'] });
  const sources = Array.from({ length: 110 }, (_, index) => ({ type: 'document', ref: `${index} ${'é"'.repeat(80)}` }));
  await fs.writeFile(f.file('wide'), note('wide', { sources }));
  const repairs = [{ target: 'wide.md', operations: [{ op: 'remove-sources', sources: sources.map((_, index) => index) }] }, ...repairsFor(['a', 'b', 'c'])];
  const preview = await f.preview(repairs), review = await f.repair(repairs, preview.proposal);
  const opened = [], open = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => { if (String(file).endsWith('.draft')) opened.push(file); return open(file, ...args); });
  const page = await f.call('cuefluent_review_note', { runId: review.runId });
  assert.equal(page.drafts.length, 1); assert.equal(page.next.draft, 0);
  assert.equal(opened.length, 1);
});


test('a candidate exceeding the file profile refuses only its target', async t => {
  const f = await fixture(t), prefix = '# Topic\n\n## Section\n<!-- aliases: a -->\n';
  const line = 'x'.repeat(NOTE_PROFILE.lineBytes - 1) + '\n', remaining = NOTE_PROFILE.fileBytes - Buffer.byteLength(prefix);
  const original = prefix + line.repeat(Math.floor(remaining / line.length)) + 'x'.repeat(remaining % line.length);
  await fs.writeFile(f.file('full'), original);
  const preview = await f.preview([{ target: 'full.md', operations: [{ op: 'replace-alias', line: 3, alias: 'a', with: 'longer' }] }, ...repairsFor(['a'])]);
  assert.equal(preview.targets[0].state, 'refused'); assert.equal(preview.targets[0].code, 'NOTE_FILE_LIMIT');
  assert.equal(preview.targets[1].state, 'change');
});
