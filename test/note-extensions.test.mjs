import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject, validateSettings } from '../src/core/settings.mjs';
import { validateDraftArtifactManifest } from '../src/core/draft-artifacts.mjs';
import { validateNotePublication } from '../src/core/note-publication.mjs';
import { assertOrdinaryTarget } from '../src/notes/validate.mjs';
import { inspectMetadata } from '../src/notes/metadata.mjs';
import { openNoteWorkspace } from '../src/processing/workspace.mjs';
import { initializeStore } from '../src/storage/store.mjs';
import { createDirectNoteTools } from '../src/control/direct-notes.mjs';
import { readProjectStatus } from '../src/control/status.mjs';

const content = '# Synthetic design review\n\n## Decision\nKeep the original note in place.\n';

async function fixture(t, filename = null) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-extensions-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = path.join(root, 'notes'), projectRoot = path.join(root, 'project');
  await fs.mkdir(notes); await fs.mkdir(projectRoot);
  const project = createProject({ id: 'extensions', root: projectRoot,
    destination: { kind: filename ? 'file' : 'directory', path: filename ? path.join(notes, filename) : notes },
    saving: 'auto', activityLog: { enabled: false } });
  return { root, notes, project };
}

test('Markdown extension settings round-trip on both path platforms without widening destinations', () => {
  for (const platform of ['posix', 'win32']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const root = platform === 'win32' ? 'C:\\project' : '/project';
    const notes = platform === 'win32' ? 'C:\\notes' : '/notes';
    for (const extension of ['md', 'MD', 'markdown', 'MARKDOWN']) {
      const target = paths.join(notes, `selected.${extension}`);
      const project = createProject({ id: 'extensions', root, destination: { kind: 'file', path: target } }, { platform });
      assert.deepEqual(validateSettings({ schemaVersion: 1, projects: [project] }, { platform }).projects[0], project);
      assert.equal(assertOrdinaryTarget(project, target, { platform }), target);
      assert.throws(() => assertOrdinaryTarget(project, paths.join(notes, `other.${extension}`), { platform }), { code: 'NOTE_TARGET_OUTSIDE' });
      const directory = createProject({ id: 'extensions', root, destination: { kind: 'directory', path: notes } }, { platform });
      assert.throws(() => assertOrdinaryTarget(directory, paths.join(notes, 'logs', `2026.${extension}`), { platform }), { code: 'NOTE_TARGET_RESERVED' });
    }
    for (const filename of ['selected.txt', 'selected.markdown.tmp', 'selected.markdownx', '.md', '.markdown', 'selected.marKdown']) {
      assert.throws(() => createProject({ id: 'extensions', root, destination: { kind: 'file', path: paths.join(notes, filename) } }, { platform }), { code: 'SETTINGS_INVALID' });
      const directory = createProject({ id: 'extensions', root, destination: { kind: 'directory', path: notes } }, { platform });
      assert.throws(() => assertOrdinaryTarget(directory, paths.join(notes, filename), { platform }), { code: 'NOTE_TARGET_INVALID' });
    }
  }
});

test('draft artifacts and publication apply the same filename contract on both path platforms', () => {
  for (const platform of ['posix', 'win32']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const root = platform === 'win32' ? 'C:\\notes' : '/notes';
    const parent = [paths.parse(root).root, root].map((name, index) => ({ path: name, device: '1', inode: String(index + 1) }));
    const runId = randomUUID(), id = randomUUID(), hash = 'a'.repeat(64);
    const artifact = filename => ({ runId, outcome: 'drafted', drafts: [{ id, target: paths.join(root, filename), expectedHash: null, hash,
      summary: 'Synthetic note', heading: null, byteLength: 1, binding: { root, parent } }] });
    const publication = relative => ({ schema: 1, runId, draftId: id, root, relative, parent, expectedHash: null, hash, bytes: 1,
      original: null, stage: null, capture: null });
    for (const filename of ['selected.md', 'selected.MARKDOWN', '.hidden.md']) {
      assert.equal(validateDraftArtifactManifest(artifact(filename), { platform }).drafts[0].target, paths.join(root, filename));
      assert.equal(validateNotePublication(publication(filename), { platform }).relative, filename);
    }
    for (const filename of ['.md', '.MD', '.markdown', '.MARKDOWN', 'selected.marKdown']) {
      assert.throws(() => validateDraftArtifactManifest(artifact(filename), { platform }), { code: 'DRAFT_ARTIFACT_INVALID' });
      assert.throws(() => validateNotePublication(publication(filename), { platform }), { code: 'NOTE_PUBLICATION_INVALID' });
    }
  }
});

test('paginated note discovery includes both Markdown extensions and keeps reserved logs hidden', async t => {
  const f = await fixture(t);
  const filenames = ['a.md', 'b.MD', 'c.markdown', 'd.MARKDOWN'];
  for (const filename of [...filenames, 'ignored.markdown.tmp', 'ignored.markdownx', 'ignored.txt', '.md', '.markdown', 'ignored.marKdown']) await fs.writeFile(path.join(f.notes, filename), content);
  await fs.mkdir(path.join(f.notes, 'logs')); await fs.writeFile(path.join(f.notes, 'logs', '2026.markdown'), content);
  const workspace = await openNoteWorkspace({ project: f.project, runId: randomUUID(), skillVersion: '0.20.0' });
  const found = []; let cursor;
  do {
    const page = await workspace.list_notes({ limit: 1, ...(cursor ? { cursor } : {}) });
    found.push(...page.entries.map(entry => path.basename(entry.target)));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(found, filenames);
  for (const filename of filenames) assert.equal((await workspace.read_note({ target: filename })).content, content);
  await assert.rejects(workspace.read_note({ target: 'logs/2026.markdown' }), { code: 'NOTE_TARGET_RESERVED' });
  await assert.rejects(workspace.draft_note({ target: 'logs/new.MARKDOWN', content, summary: 'Forbidden ordinary log' }), { code: 'NOTE_TARGET_RESERVED' });
});

test('dotfile and confusable extension refusals never reserve a direct run', async t => {
  const f = await fixture(t), store = await initializeStore(path.join(f.root, 'private'), { schemaVersion: 1, projects: [f.project] });
  const tools = createDirectNoteTools({ store, client: 'codex', skillVersion: '0.21.0' });
  await fs.mkdir(path.join(f.notes, 'meetings'));
  for (const target of ['.md', '.markdown', 'meetings/.md', 'meetings/.markdown', 'selected.marKdown']) {
    await assert.rejects(tools.call('cuefluent_create_note', { projectId: f.project.id, requestId: randomUUID(), target, content,
      summary: 'Invalid note target' }), { code: 'NOTE_TARGET_INVALID' });
    assert.equal((await readProjectStatus(store, f.project.id)).run, null);
  }
  const created = await tools.call('cuefluent_create_note', { projectId: f.project.id, requestId: randomUUID(), target: 'selected.MARKDOWN', content,
    summary: 'Valid note after refusals' });
  assert.equal(created.state, 'saved');
  assert.deepEqual(await fs.readdir(path.join(f.notes, 'meetings')), []);
});

for (const fileDestination of [false, true]) {
  test(`${fileDestination ? 'explicit file' : 'directory'} destination creates and updates .markdown in place`, async t => {
    const filename = fileDestination ? 'selected.MARKDOWN' : 'selected.markdown';
    const f = await fixture(t, fileDestination ? filename : null);
    const store = await initializeStore(path.join(f.root, 'private'), { schemaVersion: 1, projects: [f.project] });
    const tools = createDirectNoteTools({ store, client: 'codex', skillVersion: '0.20.0' });
    const target = path.join(f.notes, filename);
    const created = await tools.call('cuefluent_create_note', { projectId: f.project.id, requestId: randomUUID(), target: filename, content, summary: 'Record design decision' });
    assert.equal(created.state, 'saved'); assert.deepEqual(created.result.paths, [target]);
    const read = await tools.call('cuefluent_read_note', { projectId: f.project.id, target: filename });
    const original = inspectMetadata(read.content), revised = content.replace('Keep the original note in place.', 'Keep the original note and its manual corrections in place.');
    const updated = await tools.call('cuefluent_update_note', { projectId: f.project.id, requestId: randomUUID(), target: filename,
      expectedHash: read.hash, content: revised, summary: 'Clarify preservation' });
    assert.equal(updated.state, 'saved'); assert.deepEqual(updated.result.paths, [target]);
    const bytes = await fs.readFile(target), metadata = inspectMetadata(bytes);
    assert.equal(metadata.value.id, original.value.id); assert.equal(metadata.value.created, original.value.created);
    assert.ok(bytes.toString().endsWith(revised)); assert.deepEqual(await fs.readdir(f.notes), [filename]);
    const listed = await tools.call('cuefluent_list_notes', { projectId: f.project.id });
    assert.deepEqual(listed.entries, [{ target, kind: 'note' }]);
    if (fileDestination) {
      await assert.rejects(tools.call('cuefluent_create_note', { projectId: f.project.id, requestId: randomUUID(), target: 'other.markdown', content, summary: 'Outside file selection' }), { code: 'NOTE_TARGET_OUTSIDE' });
      assert.deepEqual(await fs.readdir(f.notes), [filename]);
    }
  });
}
