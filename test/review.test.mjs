import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createProject } from '../src/core/settings.mjs';
import { createRun, replaceAttempt, runRevision, validateRun } from '../src/core/run.mjs';
import { initializeStore, withProject } from '../src/storage/store.mjs';
import { readJSON, writeJSON, hashBytes } from '../src/storage/files.mjs';
import { readDraftArtifact, prepareDraftArtifacts, writeDraftArtifact, completeDraftArtifacts } from '../src/storage/draft-artifacts.mjs';
import { ownAttempt, attachAttemptChild, launchOwnedAttempt, inspectAttempt, ownDirectAttempt, withCurrentAttempt } from '../src/storage/attempts.mjs';
import { setChatTracking, queueRelative } from '../src/storage/chats.mjs';
import { appendQueueRecord, encodeQueueRecord, inspectQueue } from '../src/storage/queue.mjs';
import { createDirectNoteTools } from '../src/control/direct-notes.mjs';
import { reviewRun, decideRun, REVIEW_PAGE_BYTES } from '../src/control/review.mjs';
import { executeControl } from '../src/control/execute.mjs';
import { readProjectStatus } from '../src/control/status.mjs';
import { prepareProcessing } from '../src/processing/prepare.mjs';
import { runProcessingWork } from '../src/processing/worker.mjs';
import { openNoteWorkspace } from '../src/processing/workspace.mjs';
import { persistDraftManifest } from '../src/processing/draft.mjs';
import { createGeneratedNote } from '../src/notes/index.mjs';
import { reviewNoteContent } from '../src/notes/validate.mjs';
import { withoutFfiNotice } from './fixtures/runtime-stderr.mjs';

// Review pages and relayed decisions of src/control/review.mjs, for direct and
// queued runs. Queued review sets are published without a native model, exactly
// as a worker leaves them; only the worker-side revision check runs in a child.
const PROJECT = 'project', SKILL_VERSION = '0.16.0', PAGE = 48 * 1024, STALE = 'e'.repeat(64);
const CREATED_AT = '2026-10-01T00:00:00.000Z', DRAFTED_AT = '2026-10-25T00:00:00.000Z';
const QUEUED_CHOICES = ['Save', 'Skip draft; keep input', 'Keep pending'], DRAFTING_CHOICES = ['Skip; keep input', 'Keep pending'];
const RETRY = { target: 'decisions/retry.md', content: '# Retry decision\n\n## Design\nUse exact original hashes.\n', summary: 'Record the retry design.', heading: 'Design' };
const serialized = value => Buffer.byteLength(JSON.stringify(value));

/** Valid Markdown (topic H1, H2 sections) whose lines mix text a JSON string must
 * escape (quotes, backslashes, tabs, newlines) with 2-, 3- and 4-byte UTF-8
 * characters. `width` scales the repeated runs, so a few long lines (each under
 * the 64 KiB line limit) make a very large note with little parsing work. */
function noteBody(label, bytes, width = 1) {
  const lines = [
    n => `Entry ${n} of ${label}: "quoted ${n}" at C:\\notes\\${n}.md with café.`,
    n => `${'界'.repeat(36 * width)} ${n}`,
    n => `${'𝄞'.repeat(18 * width)} ${label} ${n}`,
    n => `Tab\tcolumns\t${n}: ${'"a\\b" '.repeat(2 * width)}'single' — café 界`,
  ];
  const parts = [`# ${label} café 界 reference\n\n`];
  let size = Buffer.byteLength(parts[0]), section = 0, line = 0;
  while (size < bytes) {
    const head = `## Section ${++section} café\n${section === 1 ? `<!-- aliases: ${label} first, ${label} second -->\n` : ''}\n` +
      (section === 1 ? `Unique marker for ${label}.\n\n` : '');
    parts.push(head); size += Buffer.byteLength(head);
    for (let i = 0; i === 0 || i < 40 && size < bytes; i++) {
      const text = `${lines[line % lines.length](line++)}\n\n`;
      parts.push(text); size += Buffer.byteLength(text);
    }
  }
  return parts.join('');
}

/** Every page stays within the byte budget, and the entries across the pages
 * cover each draft's preview bytes contiguously, in order, exactly once, from
 * `from` onward: entry bounds, text, continuation pointers and UTF-8 integrity. */
function assertCoverage(walked, previews, from = { draft: 0, start: 0 }) {
  let expected = from;
  walked.forEach((page, number) => {
    assert.ok(serialized(page) <= PAGE, `Page ${number} serialized to ${serialized(page)} bytes.`);
    for (const entry of page.drafts) {
      const bytes = previews[entry.index];
      assert.deepEqual({ draft: entry.index, start: entry.start }, expected);
      assert.equal(entry.totalBytes, bytes.length);
      assert.ok(entry.end > entry.start && entry.end <= bytes.length);
      assert.equal(entry.content, bytes.subarray(entry.start, entry.end).toString('utf8'));
      // A split character would decode to replacement characters.
      assert.ok(!entry.content.includes('\uFFFD')); assert.equal(Buffer.byteLength(entry.content), entry.end - entry.start);
      assert.equal(entry.next, entry.end < bytes.length ? entry.end : null);
      expected = entry.next === null ? { draft: entry.index + 1, start: 0 } : { draft: entry.index, start: entry.next };
    }
    assert.deepEqual(page.next, number === walked.length - 1 ? null : expected);
  });
  assert.deepEqual(expected, { draft: previews.length, start: 0 });
}

async function fixture(t, { saving = 'review' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-review-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  // Activity logging stays off: these tests observe previews and decisions, and
  // the notes directory must hold exactly the notes a test creates.
  const project = createProject({ id: PROJECT, root: cwd, destination: { kind: 'directory', path: notes }, saving, activityLog: { enabled: false } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const file = target => path.join(notes, ...target.split('/'));
  const current = async () => (await inspectAttempt(store, PROJECT)).run;
  const queue = () => inspectQueue(store.pin, queueRelative('codex', 'synthetic'));

  // The worker side of an owned attempt without a child process: this channel
  // performs the same ready/activate handshake that launchOwnedAttempt completes.
  const own = (runId, work) => {
    const channel = new EventEmitter(), attemptId = randomUUID(); channel.connected = true;
    channel.disconnect = () => { channel.connected = false; };
    channel.send = (message, callback) => {
      callback?.();
      if (message.type === 'cuefluent-attempt-ready') void withProject(store, PROJECT, async context => {
        const saved = await readJSON(store.pin, `${context.directory}/run.json`);
        await writeJSON(store.pin, `${context.directory}/run.json`, replaceAttempt(saved.value, attemptId), { expectedHash: saved.hash });
      }).then(() => channel.emit('message', { type: 'cuefluent-attempt-activate', attemptId }));
    };
    return ownAttempt(store, PROJECT, { runId, attemptId, channel }, work);
  };

  /** A pending queued (project-scope) run, still drafting, with one frozen input record. */
  async function prepare() {
    await setChatTracking(store, { client: 'codex', sessionId: 'synthetic', promptId: 'track', action: 'track', cwd, sourcePath: null });
    await withProject(store, PROJECT, () => appendQueueRecord(store.pin, queueRelative('codex', 'synthetic'),
      encodeQueueRecord('input', Buffer.from('{"text":"Record the synthetic decisions."}'))));
    const prepared = await prepareProcessing(store, PROJECT, { kind: 'project' }, { reconcileChat: async () => ({ status: 'caught-up' }) });
    assert.equal(prepared.state, 'created');
    return prepared.run;
  }

  /** That run, left in review exactly as a worker leaves it, without a model.
   * Existing notes (`size`) are read once and revised by one small exact edit, so
   * a draft can be far larger than the 128 KiB submission budget; new notes
   * (`content`) are submitted whole. `pad` grows the revised text by that many bytes. */
  async function queued(specs, drafting, { publishOnly = false } = {}) {
    const pending = drafting ?? await prepare(), originals = [];
    for (const spec of specs) {
      if (spec.size === undefined) { originals.push(null); continue; }
      const label = path.basename(spec.target, '.md');
      const bytes = createGeneratedNote(noteBody(label, spec.size, spec.width), { id: `note-${label}`, now: CREATED_AT, skillVersion: SKILL_VERSION });
      await fs.mkdir(path.dirname(file(spec.target)), { recursive: true }); await fs.writeFile(file(spec.target), bytes);
      originals.push(bytes);
    }
    await own(pending.id, async owner => {
      const workspace = await openNoteWorkspace({ project: pending.settings, runId: pending.id, skillVersion: SKILL_VERSION, now: DRAFTED_AT });
      for (const spec of specs) {
        const target = file(spec.target), label = path.basename(spec.target, '.md');
        const summary = spec.summary ?? `Record ${label}.`, heading = spec.heading ?? null;
        if (spec.size === undefined) { await workspace.draft_note({ target, content: spec.content, summary, heading }); continue; }
        await workspace.read_note({ target, maxBytes: 4 });
        await workspace.draft_note({ target, summary, heading, edits: [{ oldText: `Unique marker for ${label}.`, newText: `Revised marker for ${label}.${'p'.repeat(spec.pad ?? 0)}` }] });
      }
      await workspace.finish_drafting({ outcome: 'drafted' });
      await persistDraftManifest(store, owner, await workspace.manifest());
      if (publishOnly) return;
      const result = await runProcessingWork(store, owner, { action: 'process', client: 'codex', skillVersion: SKILL_VERSION, runClient: () => assert.fail('A published draft set needs no model.') });
      assert.equal(result.state, 'review');
    });
    const run = await current();
    if (publishOnly) return { run, revision: runRevision(run), originals };
    assert.equal(run.id, pending.id); assert.equal(run.phase, 'review'); assert.equal(run.attempt, null); assert.equal(run.drafts.length, specs.length);
    return { run, revision: runRevision(run), originals };
  }

  /** Follow `next` from a position until the last page. */
  async function pages(run, from = { draft: 0, start: 0 }) {
    const result = [];
    for (let cursor = from; cursor; cursor = result.at(-1).next) {
      assert.ok(result.length < 64, 'Paging must reach a last page.');
      result.push(await reviewRun(store, { projectId: PROJECT, runId: run.id, ...cursor }));
    }
    return result;
  }
  /** The retained private bytes of one draft and the preview they must produce. */
  async function retained(run, index) {
    const bytes = await readDraftArtifact(store.pin, run.artifacts, run.drafts[index].id);
    return { bytes, preview: reviewNoteContent(bytes) };
  }
  const previewsOf = (run, count) => Promise.all(Array.from({ length: count }, async (_, index) => Buffer.from((await retained(run, index)).preview)));

  // The fixture worker finishes a decision through the same runProcessingWork a
  // production worker uses, in a separate process, with the launch context it is given.
  const workers = [];
  function launchWorker(options) {
    const child = fork(fileURLToPath(new URL('./fixtures/processing-worker.mjs', import.meta.url)), [root, JSON.stringify(options)],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', code => resolve({ code, stderr: withoutFfiNotice(stderr, child.pid) })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    workers.push({ attemptId: options.attemptId, exited });
    return attachAttemptChild(child, options);
  }
  const read = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));

  const tools = createDirectNoteTools({ store, client: 'codex', skillVersion: SKILL_VERSION,
    launchProcessing: () => assert.fail('A direct run never starts a separate worker.') });
  const direct = (target, content) => tools.call('cuefluent_create_note', { projectId: PROJECT, requestId: randomUUID(), target, content, summary: 'Synthetic summary.' });
  const decide = (runId, revision, action) => decideRun(store, { projectId: PROJECT, runId, revision, action }, { client: 'codex', skillVersion: SKILL_VERSION });
  return { notes, store, file, current, queue, own, prepare, queued, pages, retained, previewsOf, workers, launchWorker, read, direct, decide };
}

test('queued review pages fill up to the byte budget with whole drafts; following next visits every draft once, in order', async t => {
  const f = await fixture(t);
  assert.equal(REVIEW_PAGE_BYTES, PAGE);
  // Serialized, the drafts are about 15, 15, 15, 24, 12, 32 and 11 KiB: three fill
  // a page and the 24 KiB draft cannot join them, then two, then two. No draft
  // alone exceeds a page, so none is split.
  const specs = [['a', 14], ['b', 14], ['knowledge-base/c', 14], ['d', 23], ['e', 11], ['f', 30], ['g', 10]]
    .map(([name, kib]) => ({ target: `${name}.md`, size: kib * 1024, summary: `Revise ${name}.`, heading: 'Section 1 café' }));
  const { run, revision, originals } = await f.queued(specs);
  const before = { run: await f.current(), queue: await f.queue(), notes: await fs.readdir(f.notes) };

  const walked = await f.pages(run);
  assertCoverage(walked, await f.previewsOf(run, specs.length));
  assert.deepEqual(walked.map(page => page.drafts.map(entry => entry.index)), [[0, 1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(walked.map(page => page.next), [{ draft: 3, start: 0 }, { draft: 5, start: 0 }, null]);
  assert.match(revision, /^[a-f0-9]{64}$/);
  for (const page of walked) {
    assert.deepEqual(Object.keys(page).sort(), ['choices', 'draftCount', 'drafts', 'kind', 'next', 'phase', 'projectId', 'revision', 'runId', 'savedCount', 'state', 'warnings', 'warningsTruncated']);
    // The decision context never changes between pages.
    const { drafts, next, ...stable } = page;
    assert.deepEqual(stable, { state: 'review', projectId: PROJECT, runId: run.id, kind: 'project', phase: 'review', revision, draftCount: specs.length,
      savedCount: 0, choices: QUEUED_CHOICES, warnings: [], warningsTruncated: false });
  }

  const entries = walked.flatMap(page => page.drafts);
  assert.deepEqual(entries.map(entry => entry.index), specs.map((_, index) => index));
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['content', 'end', 'expectedHash', 'hash', 'heading', 'index', 'next', 'saved', 'start', 'summary', 'target', 'totalBytes']);
    assert.equal(entry.saved, false);
    const draft = run.drafts[entry.index], { bytes, preview } = await f.retained(run, entry.index);
    assert.equal(entry.target, f.file(specs[entry.index].target)); assert.equal(entry.target, draft.target);
    assert.equal(entry.summary, specs[entry.index].summary); assert.equal(entry.heading, 'Section 1 café');
    assert.equal(entry.expectedHash, hashBytes(originals[entry.index])); assert.equal(entry.hash, hashBytes(bytes)); assert.equal(entry.hash, draft.hash);
    // The preview is exactly the content-only view of the retained bytes, whole.
    assert.equal(entry.content, preview); assert.equal(entry.totalBytes, Buffer.byteLength(preview));
    assert.deepEqual([entry.start, entry.end, entry.next], [0, entry.totalBytes, null]);
    assert.ok(entry.totalBytes < bytes.length);
    assert.doesNotMatch(entry.content, /<!--|cuefluent/);
    assert.match(entry.content, /Revised marker for/); assert.match(entry.content, /界/); assert.match(entry.content, /𝄞/);
  }
  // A page depends only on its position, and reviewing changes nothing.
  assert.deepEqual(await reviewRun(f.store, { projectId: PROJECT, runId: run.id, draft: 3, start: 0 }), walked[1]);
  assert.deepEqual(await f.pages(run), walked);
  assert.deepEqual(await f.pages(run, { draft: 5, start: 0 }), [walked[2]]);
  assert.deepEqual({ run: await f.current(), queue: await f.queue(), notes: await fs.readdir(f.notes) }, before);
});

test('a draft larger than one page is previewed in contiguous UTF-8-safe pieces; out-of-range and mid-character requests are refused', async t => {
  const f = await fixture(t);
  // The huge note is revised by one small edit, so the production submission
  // budget is untouched while its preview is several pages long. Its lines are
  // mostly 3- and 4-byte characters, so most byte positions fall inside one.
  const specs = [
    { target: 'new-choice.md', content: '# Café 界 decision\n\n## Choice\nKeep "quotes", tabs\tand C:\\temp\\notes intact.\n', summary: 'Record the new choice.', heading: 'Choice' },
    { target: 'huge.md', size: 300_000, width: 100, summary: 'Revise the huge note.', heading: 'Section 1 café' },
    { target: 'tail.md', size: 2_000, summary: 'Revise the tail.' },
  ];
  const { run, revision, originals } = await f.queued(specs);
  const previews = await f.previewsOf(run, specs.length), texts = previews.map(bytes => bytes.toString());
  assert.ok(previews[1].length > 3 * PAGE); assert.ok(texts.every(text => !text.includes('\uFFFD')));

  const walked = await f.pages(run);
  assertCoverage(walked, previews);
  // The small draft fills page one alone: the huge draft cannot join it, and
  // the next page starts at the whole draft, not part-way through it.
  assert.deepEqual(walked[0].drafts.map(entry => [entry.index, entry.start, entry.end, entry.next]), [[0, 0, previews[0].length, null]]);
  assert.deepEqual(walked[0].next, { draft: 1, start: 0 });
  assert.equal(walked[0].drafts[0].expectedHash, null);
  const pieces = walked.flatMap(page => page.drafts).filter(entry => entry.index === 1);
  assert.ok(pieces.length >= 6, `The huge preview spans ${pieces.length} pieces.`);
  assert.deepEqual(pieces.map(entry => entry.start).slice(0, 2), [0, pieces[0].end]);
  assert.equal(pieces.at(-1).end, previews[1].length); assert.equal(pieces.at(-1).next, null);
  assert.equal(pieces.map(entry => entry.content).join(''), texts[1]);
  // Every piece names the same draft: its destination, original and result.
  const described = ({ start, end, next, content, ...rest }) => rest;
  assert.deepEqual(pieces.map(described), pieces.map(() => described(pieces[0])));
  assert.deepEqual([pieces[0].target, pieces[0].expectedHash, pieces[0].hash], [f.file('huge.md'), hashBytes(originals[1]), run.drafts[1].hash]);
  for (const page of walked.slice(1)) {
    const [piece] = page.drafts;
    if (piece.next === null) continue;
    // A piece that does not end its draft owns its page and nearly fills it.
    assert.equal(page.drafts.length, 1); assert.deepEqual(page.next, { draft: 1, start: piece.end });
    assert.ok(serialized(page) > PAGE - 4 * 1024, `A middle piece page serialized to only ${serialized(page)} bytes.`);
  }
  // Metadata is not part of any piece, and the decision context is on every page.
  assert.ok(previews[1].length < (await f.retained(run, 1)).bytes.length);
  assert.ok(walked.every(page => page.revision === revision && page.draftCount === 3 && page.state === 'review'));

  // Any piece boundary is itself a valid starting point.
  const middle = pieces[2];
  assertCoverage(await f.pages(run, { draft: 1, start: middle.start }), previews, { draft: 1, start: middle.start });

  // Offsets must be UTF-8 boundaries inside the draft, and the draft must exist.
  const review = position => reviewRun(f.store, { projectId: PROJECT, runId: run.id, ...position });
  const refused = { code: 'REVIEW_ARGUMENT' };
  const cjk = previews[1].indexOf('界'), astral = previews[1].indexOf('𝄞');
  assert.ok(cjk > 0 && astral > 0);
  for (const start of [cjk + 1, cjk + 2, astral + 1, astral + 2, astral + 3]) await assert.rejects(review({ draft: 1, start }), refused);
  for (const start of [cjk, astral]) {
    const [piece] = (await review({ draft: 1, start })).drafts;
    assert.equal(piece.start, start); assert.equal(piece.content, previews[1].subarray(start, piece.end).toString());
  }
  await assert.rejects(review({ draft: 1, start: previews[1].length + 1 }), refused);
  await assert.rejects(review({ draft: 3 }), refused); await assert.rejects(review({ draft: 1024 }), refused);
});

test('a page filled to its brim still serializes within the byte budget, because the continuation marker is counted before a draft is admitted', async t => {
  // A first page that ends before the last draft carries a `next` pointer, which
  // is larger than `null`. Size one draft so that it alone fits the budget but
  // leaves less room than that pointer needs: it must not be placed whole.
  const specs = pad => [{ target: 'brim.md', size: 37 * 1024, pad }, { target: 'next.md', size: 10 * 1024 }];
  // A test-side model of one whole entry, checked against the real page below.
  const wholeEntry = (run, index, preview) => {
    const { target, summary, heading, expectedHash, hash } = run.drafts[index], totalBytes = Buffer.byteLength(preview);
    return { index, target, summary, heading, expectedHash, hash, saved: false, totalBytes, start: 0, end: totalBytes, next: null, content: preview };
  };
  const probe = await fixture(t), measured = await probe.queued(specs(0));
  const [probePage] = await probe.pages(measured.run);
  assert.deepEqual(probePage.drafts.map(entry => entry.index), [0]); assert.deepEqual(probePage.next, { draft: 1, start: 0 });
  assert.equal(serialized(probePage.drafts[0]), serialized(wholeEntry(measured.run, 0, (await probe.retained(measured.run, 0)).preview)));
  const base = serialized({ ...probePage, drafts: [], next: null }), room = PAGE - base - serialized(probePage.drafts[0]);
  assert.ok(room > 8 + 1024, `Draft 0 should leave real room, not ${room} bytes.`);

  // The same draft grown to leave exactly 8 bytes: it fits alone, but not with
  // the 17 bytes by which a pointer to draft 1 outgrows `null`.
  const brim = await fixture(t), set = await brim.queued(specs(room - 8));
  const preview = (await brim.retained(set.run, 0)).preview;
  assert.equal(PAGE - base - serialized(wholeEntry(set.run, 0, preview)), 8);
  const walked = await brim.pages(set.run);
  assertCoverage(walked, await brim.previewsOf(set.run, 2));
  assert.ok(walked[0].drafts[0].end < Buffer.byteLength(preview));
  assert.ok(walked.length >= 2 && walked.every(page => page.revision === set.revision));
});

test('after the pending run is replaced, a decision citing the earlier run replays its outcome or is refused, and never touches the new run', async t => {
  const f = await fixture(t);
  const first = '# Planning meeting\n\n## Decisions\nKeep the release small.\n\n## Actions\nSam will verify the result.\n';
  const a = await f.direct('a.md', first);
  assert.equal(a.state, 'review'); assert.equal(a.kind, 'direct'); assert.deepEqual(a.choices, ['Save', 'Discard', 'Keep pending']);
  // A decision must cite a well-formed revision and a supported action.
  for (const revision of [undefined, 64, 'E'.repeat(64), a.revision.slice(1), `${a.revision}\n`]) await assert.rejects(f.decide(a.runId, revision, 'save'), { code: 'REVIEW_ARGUMENT' });
  await assert.rejects(f.decide(a.runId, a.revision, 'process'), { code: 'REVIEW_ARGUMENT' });
  assert.deepEqual(await fs.readdir(f.notes), []);

  const skipped = await f.decide(a.runId, a.revision, 'skip');
  assert.deepEqual([skipped.state, skipped.runId, skipped.result.status, skipped.result.paths], ['skipped', a.runId, 'skipped', []]);
  const b = await f.direct('b.md', first.replace('small', 'focused'));
  assert.equal(b.state, 'review'); assert.notEqual(b.runId, a.runId); assert.notEqual(b.revision, a.revision);
  const before = await f.current();
  assert.equal(before.id, b.runId); assert.equal(before.phase, 'review');

  // The earlier run is now the latest outcome: any decision about it, with any
  // well-formed revision, replays that outcome and acts on nothing.
  for (const [revision, action] of [[a.revision, 'save'], [a.revision, 'skip'], [b.revision, 'save'], [STALE, 'save']]) {
    assert.deepEqual(await f.decide(a.runId, revision, action), skipped);
  }
  assert.deepEqual(await reviewRun(f.store, { projectId: PROJECT, runId: a.runId }), skipped);
  // The pending run only obeys a decision citing its own reviewed revision.
  for (const action of ['save', 'skip']) await assert.rejects(f.decide(b.runId, a.revision, action), { code: 'REVIEW_REVISION_STALE' });
  // A run that is neither pending nor the latest outcome is unknown.
  const unknown = randomUUID();
  for (const action of ['save', 'skip']) {
    await assert.rejects(f.decide(unknown, a.revision, action), { code: 'REVIEW_RUN_CHANGED' });
    await assert.rejects(f.decide(unknown, b.revision, action), { code: 'REVIEW_RUN_CHANGED' });
  }
  await assert.rejects(reviewRun(f.store, { projectId: PROJECT, runId: unknown }), { code: 'REVIEW_RUN_CHANGED' });
  // Every refusal and replay left the pending run and the notes untouched.
  assert.deepEqual(await f.current(), before); assert.deepEqual(await fs.readdir(f.notes), []);
  assert.deepEqual(await reviewRun(f.store, { projectId: PROJECT, runId: b.runId }), b);

  // Its own revision saves exactly the reviewed draft, once.
  const saved = await f.decide(b.runId, b.revision, 'save');
  assert.deepEqual([saved.state, saved.runId, saved.result.status, saved.result.paths], ['saved', b.runId, 'saved', [f.file('b.md')]]);
  const bytes = await fs.readFile(f.file('b.md'));
  assert.equal(hashBytes(bytes), b.drafts[0].hash); assert.equal(reviewNoteContent(bytes), first.replace('small', 'focused'));
  assert.deepEqual(await fs.readdir(f.notes), ['b.md']);
  // Once another run is the latest outcome, the first one is unknown, and the
  // second only replays: deciding again neither saves nor discards anything.
  await assert.rejects(f.decide(a.runId, a.revision, 'save'), { code: 'REVIEW_RUN_CHANGED' });
  assert.deepEqual(await f.decide(b.runId, b.revision, 'skip'), saved);
  assert.deepEqual(await fs.readFile(f.file('b.md')), bytes);
});

test('a queued decision is relayed to a separate worker that rechecks the revision itself; a stale citation changes nothing', async t => {
  const f = await fixture(t), target = f.file(RETRY.target);
  const { run, revision } = await f.queued([RETRY]);
  const before = await f.current(), input = await f.queue();
  assert.equal(input.records, 1); assert.deepEqual(await fs.readdir(f.notes), []);

  // The control side refuses a stale citation before it launches any worker.
  const contexts = [], refuse = Object.assign(new Error('Synthetic launch refusal.'), { code: 'SYNTHETIC_LAUNCH' });
  const relay = (action, citation) => decideRun(f.store, { projectId: PROJECT, runId: run.id, revision: citation, action },
    { client: 'codex', skillVersion: SKILL_VERSION, launchProcessing: context => { contexts.push(context); throw refuse; } });
  await assert.rejects(relay('save', STALE), { code: 'REVIEW_REVISION_STALE' });
  assert.deepEqual(contexts, []);
  // A current citation reaches the launcher with the run, action and revision.
  for (const action of ['save', 'skip']) await assert.rejects(relay(action, revision), { code: 'SYNTHETIC_LAUNCH' });
  assert.deepEqual(contexts.map(({ projectId, runId, action, revision: cited }) => ({ projectId, runId, action, revision: cited })),
    ['save', 'skip'].map(action => ({ projectId: PROJECT, runId: run.id, action, revision })));
  assert.deepEqual(await f.current(), before);

  // A worker can still be reached with a stale citation if the set changed after
  // that check. It has no sight of the control check: it must refuse by itself.
  const startupTimeoutMs = process.platform === 'win32' ? 15_000 : undefined;
  const launched = await launchOwnedAttempt(f.store, PROJECT, { runId: run.id, startupTimeoutMs,
    launch: context => f.launchWorker({ ...context, action: 'save', revision: STALE }) });
  const stale = f.workers.at(-1);
  assert.equal(launched.state, 'running'); assert.equal(launched.attemptId, stale.attemptId);
  assert.equal((await stale.exited).code, 1);
  assert.equal((await f.read(`error-${stale.attemptId}.json`)).code, 'REVIEW_REVISION_STALE');
  // The run is still the reviewed set in review, with no warning recorded for
  // the refused decision; no note was written and no queued input was consumed.
  const after = await inspectAttempt(f.store, PROJECT);
  assert.equal(after.active, false); assert.equal(after.run.phase, 'review'); assert.deepEqual(after.run.warnings, []);
  assert.deepEqual({ ...after.run, attempt: null }, before);
  assert.deepEqual(await fs.readdir(f.notes), []); assert.deepEqual(await f.queue(), input);
  const reviewed = await reviewRun(f.store, { projectId: PROJECT, runId: run.id });
  assert.deepEqual([reviewed.state, reviewed.revision, reviewed.warnings], ['review', revision, []]);

  // Nothing was lost: the same decision with the true revision completes.
  const retried = await decideRun(f.store, { projectId: PROJECT, runId: run.id, revision, action: 'save' },
    { client: 'codex', skillVersion: SKILL_VERSION, launchProcessing: context => f.launchWorker(context) });
  assert.deepEqual(retried, { state: 'running', projectId: PROJECT, runId: run.id, started: true });
  const saver = f.workers.at(-1);
  assert.deepEqual(await saver.exited, { code: 0, stderr: '' });
  const outcome = await f.read(`outcome-${saver.attemptId}.json`);
  assert.deepEqual([outcome.status, outcome.paths], ['saved', [target]]);
  assert.equal(hashBytes(await fs.readFile(target)), run.drafts[0].hash);
  assert.equal((await f.queue()).records, 0);
});

test('a queued run that is still drafting has nothing to page, and one owned by a worker is only reported as running', async t => {
  const f = await fixture(t), drafting = await f.prepare();
  const review = position => reviewRun(f.store, { projectId: PROJECT, runId: drafting.id, ...position });
  assert.deepEqual(await review(), { state: 'interrupted', projectId: PROJECT, runId: drafting.id, kind: 'project', phase: 'drafting', revision: runRevision(drafting),
    draftCount: 0, savedCount: 0, choices: DRAFTING_CHOICES, drafts: [], next: null, warnings: [], warningsTruncated: false });
  for (const position of [{ draft: 1 }, { start: 1 }, { draft: -1 }, { start: 1.5 }]) await assert.rejects(review(position), { code: 'REVIEW_ARGUMENT' });
  // Nothing is reviewed yet, so there is nothing for a decision to save.
  await assert.rejects(decideRun(f.store, { projectId: PROJECT, runId: drafting.id, revision: runRevision(drafting), action: 'save' },
    { client: 'codex', skillVersion: SKILL_VERSION, launchProcessing: () => assert.fail('No worker may start for unfinished drafting.') }), { code: 'RUN_PHASE_INVALID' });

  const { run, revision } = await f.queued([RETRY], drafting);
  const reviewed = await f.pages(run);
  assert.deepEqual(reviewed.map(page => [page.state, page.phase, page.drafts.length, page.next]), [['review', 'review', 1, null]]);
  // While a worker owns the run, review and either decision only report it:
  // nothing is read, decided or launched.
  const running = { state: 'running', projectId: PROJECT, runId: run.id, started: false };
  await f.own(run.id, async () => {
    assert.deepEqual(await reviewRun(f.store, { projectId: PROJECT, runId: run.id }), running);
    for (const action of ['save', 'skip']) {
      assert.deepEqual(await decideRun(f.store, { projectId: PROJECT, runId: run.id, revision, action },
        { client: 'codex', skillVersion: SKILL_VERSION, launchProcessing: () => assert.fail('A second worker must not start.') }), running);
    }
  });
  assert.deepEqual(await f.pages(run), reviewed);
  assert.deepEqual(await fs.readdir(f.notes), []);
});

test('an interrupted partial save lists what it saved and why it stopped, keeps its revision, and still pages every draft', async t => {
  const f = await fixture(t);
  const specs = ['a', 'z'].map(name => ({ target: `${name}.md`, content: `# ${name.toUpperCase()} note\n\n## Choice\nKeep the ${name} choice.\n`, summary: `Record ${name}.`, heading: 'Choice' }));
  const { run, revision } = await f.queued(specs);
  // The user creates the second target after review, so its save conflicts once
  // the first note has been published.
  await fs.writeFile(f.file('z.md'), 'User file arrived after drafting.');
  let code;
  await assert.rejects(f.own(run.id, owner => runProcessingWork(f.store, owner, { action: 'save', client: 'codex', skillVersion: SKILL_VERSION, revision })),
    error => { code = error.code; return true; });
  assert.match(code, /^[A-Z][A-Z0-9_]+$/);
  const saved = await fs.readFile(f.file('a.md'));
  assert.equal(hashBytes(saved), run.drafts[0].hash);

  const [page, ...rest] = await f.pages(run);
  assert.deepEqual(rest, []);
  assert.deepEqual([page.state, page.phase, page.kind, page.revision, page.savedCount, page.warnings, page.choices],
    ['interrupted', 'saving', 'project', revision, 1, [code], QUEUED_CHOICES]);
  assert.deepEqual(page.drafts.map(entry => [entry.target, entry.saved]), [[f.file('a.md'), true], [f.file('z.md'), false]]);
  assertCoverage([page], await f.previewsOf(run, 2));
  // The same revision still authorizes a retry or a skip of the rest: the relay
  // carries it to the launcher. Nothing was lost on the way.
  const contexts = [];
  for (const action of ['save', 'skip']) {
    await assert.rejects(decideRun(f.store, { projectId: PROJECT, runId: run.id, revision, action }, { client: 'codex', skillVersion: SKILL_VERSION,
      launchProcessing: context => { contexts.push(context); throw Object.assign(new Error('Synthetic launch refusal.'), { code: 'SYNTHETIC_LAUNCH' }); } }), { code: 'SYNTHETIC_LAUNCH' });
  }
  assert.deepEqual(contexts.map(({ runId, action, revision: cited }) => ({ runId, action, revision: cited })), ['save', 'skip'].map(action => ({ runId: run.id, action, revision })));
  assert.equal(await fs.readFile(f.file('z.md'), 'utf8'), 'User file arrived after drafting.');
  assert.deepEqual(await fs.readFile(f.file('a.md')), saved); assert.equal((await f.queue()).records, 1);
});

test('a run whose notes are all saved offers only Finish, and either decision finishes its cleanup and consumes the handled input', async t => {
  const f = await fixture(t);
  const { run, revision } = await f.queued([RETRY]);
  const draft = run.drafts[0], saved = [{ draftId: draft.id, target: draft.target, hash: draft.hash, changed: true }];
  // The worker published the note and stopped before cleanup finished.
  const interrupt = phase => withProject(f.store, PROJECT, async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, phase, saved, attempt: null }), { expectedHash: stored.hash });
  });
  await interrupt('saving');
  let page = await reviewRun(f.store, { projectId: PROJECT, runId: run.id });
  assert.deepEqual([page.state, page.phase, page.choices, page.savedCount, page.drafts[0].saved, page.revision], ['interrupted', 'saving', ['Finish', 'Keep pending'], 1, true, revision]);
  // Status agrees with the page: every note is saved, so the recovery is Finish, not Save.
  let status = await readProjectStatus(f.store, PROJECT);
  assert.deepEqual([status.state, status.run.phase, status.run.saved, status.run.savedPaths], ['idle', 'saving', 1, [draft.target]]);
  assert.match(status.run.recovery, /only cleanup remains.*relay Finish/); assert.doesNotMatch(status.run.recovery, /Save/);
  await interrupt('cleanup');
  page = await reviewRun(f.store, { projectId: PROJECT, runId: run.id });
  assert.deepEqual([page.state, page.phase, page.choices, page.drafts, page.revision], ['interrupted', 'cleanup', ['Finish', 'Keep pending'], [], revision]);
  status = await readProjectStatus(f.store, PROJECT); assert.match(status.run.recovery, /relay Finish/);
  assert.equal((await f.queue()).records, 1);
  const finished = await decideRun(f.store, { projectId: PROJECT, runId: run.id, revision, action: 'save' },
    { client: 'codex', skillVersion: SKILL_VERSION, launchProcessing: context => f.launchWorker(context), startupTimeoutMs: process.platform === 'win32' ? 15_000 : undefined });
  assert.deepEqual(finished, { state: 'running', projectId: PROJECT, runId: run.id, started: true });
  const worker = f.workers.at(-1);
  assert.deepEqual(await worker.exited, { code: 0, stderr: '' });
  const outcome = await f.read(`outcome-${worker.attemptId}.json`);
  assert.deepEqual([outcome.status, outcome.counts.handled, outcome.paths], ['saved', 1, [draft.target]]);
  assert.equal((await f.queue()).records, 0);
  await assert.rejects(inspectAttempt(f.store, PROJECT), { code: 'RUN_MISSING' });
});

test('a typed skip binds the run it inspected: a set published before its worker owns the run is refused, not discarded', async t => {
  const f = await fixture(t), pending = await f.prepare();
  assert.equal(pending.phase, 'drafting');
  let published, received;
  const result = await executeControl(f.store, { action: 'skip', client: 'codex', sessionId: 'synthetic', promptId: 'typed-skip', cwd: pending.settings.root, sourcePath: null }, {
    startupTimeoutMs: process.platform === 'win32' ? 15_000 : undefined,
    launchProcessing: async context => {
      received = context;
      // Another worker finishes drafting and publishes the review set before
      // this typed skip's worker acquires the run.
      published = (await f.queued([RETRY], pending)).run;
      return f.launchWorker(context);
    },
  });
  assert.equal(result.state, 'running');
  assert.equal(received.action, 'skip'); assert.equal(received.revision, runRevision(pending)); assert.equal(published.phase, 'review');
  const worker = f.workers.at(-1);
  assert.equal((await worker.exited).code, 1);
  assert.equal((await f.read(`error-${worker.attemptId}.json`)).code, 'REVIEW_REVISION_STALE');
  // The review-ready set is intact and still the pending run; its input is kept.
  const current = await f.current();
  assert.equal(current.phase, 'review'); assert.equal(current.drafts.length, 1); assert.deepEqual(current.warnings, []);
  assert.equal((await f.queue()).records, 1); assert.deepEqual(await fs.readdir(f.notes), []);
  const page = await reviewRun(f.store, { projectId: PROJECT, runId: pending.id });
  assert.equal(page.state, 'review'); assert.equal(page.revision, runRevision(published));
});

test('an automatic run interrupted after its writes offers Finish, and the decision finishes its cleanup without a model', async t => {
  const f = await fixture(t, { saving: 'auto' });
  const { run, revision } = await f.queued([RETRY], undefined, { publishOnly: true });
  assert.equal(run.phase, 'saving'); assert.equal(run.settings.saving, 'auto');
  const draft = run.drafts[0], saved = [{ draftId: draft.id, target: draft.target, hash: draft.hash, changed: true }];
  await fs.mkdir(path.dirname(draft.target), { recursive: true }); await fs.writeFile(draft.target, await readDraftArtifact(f.store.pin, run.artifacts, draft.id));
  await withProject(f.store, PROJECT, async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, phase: 'cleanup', saved, attempt: null }), { expectedHash: stored.hash });
  });
  const page = await reviewRun(f.store, { projectId: PROJECT, runId: run.id });
  assert.deepEqual([page.state, page.phase, page.choices, page.savedCount], ['interrupted', 'cleanup', ['Finish', 'Keep pending'], 1]);
  assert.equal(page.revision, runRevision((await inspectAttempt(f.store, PROJECT)).run));
  const contexts = [];
  const finished = await decideRun(f.store, { projectId: PROJECT, runId: run.id, revision: page.revision, action: 'save' },
    { client: 'codex', skillVersion: SKILL_VERSION, startupTimeoutMs: process.platform === 'win32' ? 15_000 : undefined,
      launchProcessing: context => { contexts.push(context); return f.launchWorker({ ...context, runClient: undefined }); } });
  assert.deepEqual(finished, { state: 'running', projectId: PROJECT, runId: run.id, started: true });
  // An automatic run resumes through process; the worker still checks the revision.
  assert.deepEqual(contexts.map(({ action, revision: cited }) => ({ action, revision: cited })), [{ action: 'process', revision: page.revision }]);
  const worker = f.workers.at(-1);
  assert.deepEqual(await worker.exited, { code: 0, stderr: '' });
  const outcome = await f.read(`outcome-${worker.attemptId}.json`);
  assert.deepEqual([outcome.status, outcome.counts.handled, outcome.paths], ['saved', 1, [draft.target]]);
  assert.equal(hashBytes(await fs.readFile(draft.target)), draft.hash);
  assert.equal((await f.queue()).records, 0);
  await assert.rejects(inspectAttempt(f.store, PROJECT), { code: 'RUN_MISSING' });
});

test('page metadata stays bounded: many long saved targets and many warnings never push a page over its budget', async t => {
  const f = await fixture(t);
  // 64 drafts with deep relative targets, all already written, under the
  // processor's unchanged 64 KiB receipt budget.
  const segment = 'section-' + 'x'.repeat(88);
  const specs = Array.from({ length: 64 }, (_, index) => ({ target: `${segment}/${segment}/${segment}/note-${index}.md`,
    content: `# Note ${index}\n\n## Choice\nKeep choice ${index}.\n`, summary: `Record ${index}.`, heading: 'Choice' }));
  const { run, revision } = await f.queued(specs);
  const saved = run.drafts.map(draft => ({ draftId: draft.id, target: draft.target, hash: draft.hash, changed: true }));
  const warnings = Array.from({ length: 128 }, (_, index) => `SYNTHETIC_WARNING_${index} ${'w'.repeat(1000)}`);
  await withProject(f.store, PROJECT, async ({ directory }) => {
    const stored = await readJSON(f.store.pin, `${directory}/run.json`);
    await writeJSON(f.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, phase: 'saving', saved, warnings }), { expectedHash: stored.hash });
  });
  assert.ok(Buffer.byteLength(JSON.stringify(warnings)) > PAGE);
  const walked = await f.pages(run);
  assertCoverage(walked, await f.previewsOf(run, specs.length));
  for (const page of walked) {
    assert.ok(serialized(page) <= PAGE, `A page serialized to ${serialized(page)} bytes.`);
    assert.equal(page.savedCount, 64); assert.equal(page.revision, revision); assert.deepEqual(page.choices, ['Finish', 'Keep pending']);
    assert.equal(page.warnings.length, 16); assert.equal(page.warningsTruncated, true);
    assert.deepEqual(page.warnings, warnings.slice(0, 16));
    for (const entry of page.drafts) assert.equal(entry.saved, true);
  }
  assert.equal(walked.flatMap(page => page.drafts).length, 64);
});

/** A direct run reserved for `requestId`, interrupted after its draft artifact
 * pointer was persisted and, when `complete`, after its bytes were written. */
async function interruptedDirectDraft(f, requestId, { complete }) {
  const project = await withProject(f.store, PROJECT, async context => context.project);
  await withProject(f.store, PROJECT, async context => writeJSON(f.store.pin, `${context.directory}/run.json`,
    createRun(context.project, [], { id: requestId, scope: { kind: 'direct', requestHash: hashBytes(Buffer.from('synthetic request')) } }), { expectedHash: null }));
  const workspace = await openNoteWorkspace({ project, runId: requestId, skillVersion: SKILL_VERSION });
  await workspace.draft_note({ target: RETRY.target, content: RETRY.content, summary: RETRY.summary });
  await workspace.finish_drafting({ outcome: 'drafted' });
  const manifest = await workspace.manifest();
  const metadata = { runId: manifest.runId, outcome: manifest.outcome, drafts: manifest.drafts.map(({ bytes, ...draft }) => ({ ...draft, byteLength: bytes.length })) };
  await assert.rejects(ownDirectAttempt(f.store, PROJECT, requestId, async owner => {
    await withCurrentAttempt(owner, async context => {
      let current = context.run, hash = context.hash;
      await prepareDraftArtifacts(f.store.pin, `${context.directory}/drafts/${current.id}`, metadata, { persistIntent: async pointer => {
        current = validateRun({ ...current, artifacts: pointer });
        hash = (await writeJSON(f.store.pin, `${context.directory}/run.json`, current, { expectedHash: hash })).hash;
      } });
    });
    if (complete) {
      for (const draft of manifest.drafts) await withCurrentAttempt(owner, ({ run }) => writeDraftArtifact(f.store.pin, run.artifacts, draft.id, draft.bytes));
      await withCurrentAttempt(owner, ({ run }) => completeDraftArtifacts(f.store.pin, run.artifacts));
    }
    throw Object.assign(new Error('Synthetic interruption.'), { code: 'SYNTHETIC_STOP' });
  }), { code: 'SYNTHETIC_STOP' });
  return f.current();
}

test('a direct draft whose retained bytes never completed offers no restoration, while a complete one offers Restore draft and restores', async t => {
  for (const complete of [false, true]) {
    const f = await fixture(t), requestId = randomUUID();
    const run = await interruptedDirectDraft(f, requestId, { complete });
    assert.equal(run.phase, 'drafting'); assert.ok(run.artifacts);
    const page = await reviewRun(f.store, { projectId: PROJECT, runId: requestId });
    assert.deepEqual([page.state, page.draftCount, page.drafts], ['interrupted', 0, []]);
    assert.deepEqual(page.choices, complete ? ['Restore draft', 'Discard', 'Keep pending'] : ['Discard', 'Keep pending']);
    // Status describes the same choices without promising a draft the page does not carry.
    const status = await readProjectStatus(f.store, PROJECT);
    assert.equal(status.state, 'idle'); assert.match(status.run.recovery, /Restore draft or Save when a complete draft was retained, otherwise Discard/);
    assert.doesNotMatch(status.run.recovery, /show the retained draft/);
    if (complete) {
      const restored = await f.decide(requestId, page.revision, 'save');
      assert.equal(restored.state, 'review'); assert.equal(restored.drafts.length, 1); assert.equal(restored.drafts[0].content.includes('Use exact original hashes'), true);
    } else {
      const discarded = await f.decide(requestId, page.revision, 'skip');
      assert.equal(discarded.state, 'skipped'); assert.deepEqual(await fs.readdir(path.join(f.store.root, '..', 'notes')), []);
    }
  }
});

test('status names the command that resumes a queued run and, after a save conflict, the release path instead of the refused Save', async t => {
  const f = await fixture(t);
  // A project-scope run still drafting resumes only through `process project`.
  const drafting = await f.prepare();
  let status = await readProjectStatus(f.store, PROJECT);
  assert.equal(status.run.id, drafting.id); assert.match(status.run.recovery, /^Drafting stopped before the draft set was published\. Repeat process project to resume it/);
  const g = await fixture(t), { run } = await g.queued([RETRY]);
  const rewrite = patch => withProject(g.store, PROJECT, async ({ directory }) => {
    const stored = await readJSON(g.store.pin, `${directory}/run.json`);
    await writeJSON(g.store.pin, `${directory}/run.json`, validateRun({ ...stored.value, ...patch }), { expectedHash: stored.hash });
  });
  // An approved save that the writer refused leaves its conflict code on the run.
  await rewrite({ phase: 'saving', saved: [], attempt: null, warnings: ['NOTE_PUBLICATION_CONFLICT'] });
  status = await readProjectStatus(g.store, PROJECT);
  assert.equal(status.state, 'idle'); assert.equal(status.run.phase, 'saving');
  assert.match(status.run.recovery, /A note changed after it was reviewed, so saving it again is refused/);
  assert.match(status.run.recovery, /Relay Skip draft; keep input to release the run/); assert.doesNotMatch(status.run.recovery, /to finish it/);
  assert.deepEqual((await reviewRun(g.store, { projectId: PROJECT, runId: run.id })).choices, ['Save', 'Skip draft; keep input', 'Keep pending']);
  // Without a conflict, an interrupted automatic or approved save resumes through its own command or Save.
  await rewrite({ warnings: [] });
  status = await readProjectStatus(g.store, PROJECT);
  assert.match(status.run.recovery, /Repeat process project for automatic saving, or relay Save with the reviewed revision, to finish it/);
});
