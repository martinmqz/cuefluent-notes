import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { openNoteWorkspace, NOTE_WORKSPACE_TOOLS } from '../../src/processing/workspace.mjs';
import { createProject } from '../../src/core/settings.mjs';
import { createGeneratedNote, inspectMetadata } from '../../src/notes/index.mjs';
import { createAnnualLog, appendLogEntry, queryLogEntries } from '../../src/logs/index.mjs';

const runId = '12345678-1234-4123-8123-123456789abc', now = '2026-10-22T01:00:00Z', skillVersion = '0.16.0-dev.0';
const body = '# Synthetic topic\n\n## Answer\n\nUseful original content.\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cuefluent-workspace-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'notes'); await fs.mkdir(root);
  const project = createProject({ id: 'synthetic', root: path.join(temporary, 'project'), destination: options.file ? { kind: 'file', path: path.join(root, 'chosen.md') } : { kind: 'directory', path: root } });
  const open = extra => openNoteWorkspace({ project, runId, skillVersion, now, ...extra });
  return { temporary, root, project, open };
}
const finish = async workspace => { await workspace.finish_drafting({ outcome: 'drafted' }); return workspace.manifest(); };

test('draft workspaces reject malformed SemVer and retain valid build metadata without imposing a new version length limit', async t => {
  const f = await fixture(t);
  for (const skillVersion of ['0.16.0-01', '0.16.0-.', '0.16.0-dev..1', '0.16.0+build..1', '01.16.0']) {
    await assert.rejects(f.open({ skillVersion }), { code: 'WORKSPACE_CONTEXT_INVALID' });
    assert.deepEqual(await fs.readdir(f.root), []);
  }
  for (const skillVersion of ['0.16.0-01a+001.build-0', `0.16.0-${'x'.repeat(300)}`]) {
    const workspace = await f.open({ skillVersion });
    await workspace.draft_note({ target: 'new.md', content: body, summary: 'Add synthetic answer' });
    const metadata = inspectMetadata((await finish(workspace)).drafts[0].bytes);
    assert.equal(metadata.value.generation.skill_version, skillVersion);
    assert.deepEqual(await fs.readdir(f.root), []);
  }
});

test('new note drafts stay private, receive fresh metadata, retain existing parent binding, and return independent manifest bytes', async t => {
  const f = await fixture(t), workspace = await f.open();
  await assert.rejects(workspace.manifest(), { code: 'WORKSPACE_NOT_FINISHED' });
  const result = await workspace.draft_note({ target: 'knowledge-base/new.md', content: body, summary: 'Add synthetic answer', heading: 'Answer' });
  assert.equal(result.expectedHash, null); assert(!JSON.stringify(result).includes(body));
  assert.deepEqual(await fs.readdir(f.root), []);
  const manifest = await finish(workspace), draft = manifest.drafts[0];
  assert.equal(draft.target, path.join(f.root, 'knowledge-base', 'new.md')); assert.equal(draft.hash, hash(draft.bytes));
  assert.equal(draft.binding.root, f.root); assert.equal(draft.binding.parent.at(-1).path, f.root);
  assert(draft.binding.parent.every(parent => typeof parent.device === 'string' && typeof parent.inode === 'string'));
  const metadata = inspectMetadata(draft.bytes);
  assert.equal(metadata.status, 'supported'); assert.equal(metadata.value.generation.skill_version, skillVersion); assert.equal(metadata.value.sources, undefined);
  draft.bytes.fill(0); assert.equal(hash((await workspace.manifest()).drafts[0].bytes), draft.hash);
  await assert.rejects(workspace.draft_note({ target: 'other.md', content: body, summary: 'Other' }), { code: 'WORKSPACE_FINISHED' });
});

test('read versions and expected hashes remain pinned after manual file changes and model drafts', async t => {
  const f = await fixture(t), file = path.join(f.root, 'existing.md'); await fs.writeFile(file, body);
  const workspace = await f.open(), first = await workspace.read_note({ target: 'existing.md' });
  await fs.writeFile(file, body.replace('original', 'manual edit'));
  const again = await workspace.read_note({ target: 'existing.md' }); assert.equal(again.content, first.content); assert.equal(again.hash, first.hash);
  await workspace.draft_note({ target: 'existing.md', edits: [{ oldText: 'original', newText: 'drafted' }], summary: 'Update answer' });
  await fs.writeFile(file, 'Another manual edit');
  const manifest = await finish(workspace), draft = manifest.drafts[0];
  assert.equal(draft.expectedHash, hash(body)); assert.equal(draft.bytes.toString(), body.replace('original', 'drafted'));
  assert.equal(await fs.readFile(file, 'utf8'), 'Another manual edit');
});

test('unread existing files conflict, absent versions remain absent, and duplicate portable target spellings fail', async t => {
  const f = await fixture(t), file = path.join(f.root, 'existing.md'); await fs.writeFile(file, body);
  const workspace = await f.open();
  await assert.rejects(workspace.draft_note({ target: file, content: body, summary: 'Overwrite unread' }), { code: 'WORKSPACE_NOTE_UNREAD' });
  assert.equal((await workspace.read_note({ target: 'new.md' })).exists, false);
  await fs.writeFile(path.join(f.root, 'new.md'), 'Concurrent newly created note');
  await workspace.draft_note({ target: 'new.md', content: body, summary: 'Create from pinned absence' });
  await assert.rejects(workspace.read_note({ target: 'NEW.md' }), { code: 'WORKSPACE_TARGET_ALIAS' });
  assert.equal((await finish(workspace)).drafts[0].expectedHash, null);
});

test('small exact edits preserve a large existing note without model-visible full content or private truncation', async t => {
  const f = await fixture(t), large = body + '\n' + ('A useful retained paragraph. '.repeat(100) + '\n\n').repeat(100);
  await fs.writeFile(path.join(f.root, 'large.md'), large);
  const workspace = await f.open(), read = await workspace.read_note({ target: 'large.md', maxBytes: 80 });
  assert.equal(read.totalBytes, Buffer.byteLength(large)); assert(read.content.length <= 80); assert(read.next !== null);
  const result = await workspace.draft_note({ target: 'large.md', edits: [{ oldText: 'Useful original content.', newText: 'Useful precise change.' }], summary: 'Refine answer' });
  assert(result.bytes > 128 * 1024); assert(JSON.stringify(result).length < 1024);
  const manifest = await finish(workspace); assert.equal(manifest.drafts[0].bytes.toString(), large.replace('Useful original content.', 'Useful precise change.'));
  assert.equal(await fs.readFile(path.join(f.root, 'large.md'), 'utf8'), large);
});

test('edits require one exact match in the pinned original and safe UTF-8 boundaries', async t => {
  const f = await fixture(t), text = '# Topic\n\n## Answer\n\n😀 unique café; duplicate duplicate.\n'; await fs.writeFile(path.join(f.root, 'utf8.md'), text);
  const workspace = await f.open(); await workspace.read_note({ target: 'utf8.md', maxBytes: 20 });
  const start = Buffer.byteLength(text.slice(0, text.indexOf('😀')));
  const point = await workspace.read_note({ target: 'utf8.md', start, maxBytes: 5 }); assert.equal(point.content, '😀 '); assert.equal(point.end, start + 5);
  await assert.rejects(workspace.read_note({ target: 'utf8.md', start: start + 1 }), { code: 'WORKSPACE_RANGE_INVALID' });
  for (const oldText of ['missing', 'duplicate']) await assert.rejects(workspace.draft_note({ target: 'utf8.md', edits: [{ oldText, newText: 'replacement' }], summary: 'Bad edit' }), { code: 'WORKSPACE_EDIT_NOT_UNIQUE' });
  await assert.rejects(workspace.draft_note({ target: 'utf8.md', content: '\uD800', summary: 'Invalid unicode' }), { code: 'NOTE_UTF8_INVALID' });
});

test('existing plain/schema1/future metadata and useful aliases are preserved and malformed updates fail', async t => {
  const f = await fixture(t), aliasBody = body.replace('Useful', '<!-- aliases: stable alias -->\n\nUseful');
  const supported = createGeneratedNote(aliasBody, { id: 'stable', now: '2026-10-21T00:00:00Z', skillVersion: '1.0.0', metadata: { custom: { owner: 'synthetic' } } });
  const futurePrefix = '\uFEFF\r\n<!-- cuefluent\r\nschema_version: 99\r\nfuture: [one, two]\r\n-->\r\n';
  const originals = { 'plain.md': aliasBody, 'schema.md': supported, 'future.md': futurePrefix + aliasBody };
  const workspace = await f.open();
  for (const [name, bytes] of Object.entries(originals)) { await fs.writeFile(path.join(f.root, name), bytes); await workspace.read_note({ target: name });
    await workspace.draft_note({ target: name, edits: [{ oldText: 'original', newText: 'verified' }], summary: 'Useful change' }); }
  await assert.rejects(workspace.draft_note({ target: 'plain.md', content: body, summary: 'Drop alias' }), { code: 'NOTE_ALIASES_CHANGED' });
  const manifest = await finish(workspace), schema = inspectMetadata(manifest.drafts.find(draft => draft.target.endsWith('schema.md')).bytes);
  assert.equal(schema.value.id, 'stable'); assert.equal(schema.value.custom.owner, 'synthetic'); assert.equal(schema.value.created, '2026-10-21T00:00:00Z');
  assert(manifest.drafts.find(draft => draft.target.endsWith('future.md')).bytes.toString().startsWith(futurePrefix));
  assert.equal(inspectMetadata(manifest.drafts.find(draft => draft.target.endsWith('plain.md')).bytes).status, 'absent');
  await fs.writeFile(path.join(f.root, 'malformed.md'), '<!-- cuefluent\nschema_version: 1\nid: [bad\n-->\n' + body);
  const malformed = await f.open(); await malformed.read_note({ target: 'malformed.md' });
  await assert.rejects(malformed.draft_note({ target: 'malformed.md', content: body, summary: 'Repair silently' }), { code: 'NOTE_METADATA_INVALID' });
});

test('no useful edit keeps exact bytes/timestamps and requires an explicit successful finish', async t => {
  const f = await fixture(t), bytes = createGeneratedNote(body, { now: '2026-10-21T00:00:00Z', skillVersion: '1.0.0' });
  await fs.writeFile(path.join(f.root, 'same.md'), bytes);
  const workspace = await f.open(); await workspace.read_note({ target: 'same.md' });
  const receipt = await workspace.draft_note({ target: 'same.md', content: body.replace('original', 'unnecessary'), usefulChange: false, summary: 'No useful change' });
  assert.equal(receipt.hash, hash(bytes)); assert.equal(receipt.hash, receipt.expectedHash);
  const manifest = await finish(workspace); assert.equal(manifest.outcome, 'nothing-useful'); assert.deepEqual(manifest.drafts, []);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'same.md')), bytes);
  const empty = await f.open(); await empty.finish_drafting({ outcome: 'nothing-useful' }); assert.deepEqual((await empty.manifest()).drafts, []);
  const conflict = await f.open(); await conflict.draft_note({ target: 'new.md', content: body, summary: 'New useful note' });
  await assert.rejects(conflict.finish_drafting({ outcome: 'nothing-useful' }), { code: 'WORKSPACE_FINISH_CONFLICT' });
});

test('existing imperfect notes can be improved or explicitly left byte-identical', async t => {
  const f = await fixture(t), file = path.join(f.root, 'plain.md'), original = '# Existing topic\n\nRetained useful content.\n';
  await fs.writeFile(file, original);
  const repair = await f.open(); await repair.read_note({ target: 'plain.md' });
  await repair.draft_note({ target: 'plain.md', edits: [{ oldText: 'Retained useful content.', newText: '## Answer\n\nRetained useful content.' }], summary: 'Organize existing content' });
  const repaired = await finish(repair);
  assert.equal(repaired.drafts[0].expectedHash, hash(original));
  assert.equal(repaired.drafts[0].bytes.toString(), '# Existing topic\n\n## Answer\n\nRetained useful content.\n');
  const unchanged = await f.open(); await unchanged.read_note({ target: 'plain.md' });
  const receipt = await unchanged.draft_note({ target: 'plain.md', content: 'An unnecessary replacement', usefulChange: false, summary: 'Nothing useful to add' });
  assert.equal(receipt.changed, false); assert(receipt.warnings.includes('no-answer-sections'));
  assert.equal((await finish(unchanged)).outcome, 'nothing-useful');
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('context, submitted output, private aggregate and per-file bounds fail explicitly without publishing/truncating notes', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'one.md'), body);
  const smallContext = await f.open({ limits: { contextBytes: 400 } }); await smallContext.read_note({ target: 'one.md', maxBytes: 10 });
  await assert.rejects(smallContext.read_note({ target: 'one.md', maxBytes: 10 }), { code: 'WORKSPACE_CONTEXT_LIMIT' });
  const smallDraft = await f.open({ limits: { draftBytes: 50 } });
  await assert.rejects(smallDraft.draft_note({ target: 'new.md', content: body, summary: 'Too much' }), { code: 'WORKSPACE_DRAFT_LIMIT' });
  const smallPrivate = await f.open({ limits: { privateBytes: 80 } }); await smallPrivate.read_note({ target: 'one.md' });
  await assert.rejects(smallPrivate.draft_note({ target: 'one.md', content: body.replace('original', 'updated'), summary: 'Private cap' }), { code: 'WORKSPACE_PRIVATE_LIMIT' });
  const smallFile = await f.open({ limits: { fileBytes: 20 } }); await assert.rejects(smallFile.read_note({ target: 'one.md' }), { code: 'READ_LIMIT_EXCEEDED' });
  assert.deepEqual(await fs.readdir(f.root), ['one.md']); assert.equal(await fs.readFile(path.join(f.root, 'one.md'), 'utf8'), body);
});

test('listing is bounded/paged and does not grant overwrite authority; explicit file destination remains exact', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'logs')); await fs.mkdir(path.join(f.root, 'tasks'));
  await fs.writeFile(path.join(f.root, 'b.md'), body); await fs.writeFile(path.join(f.root, 'a.md'), body);
  const workspace = await f.open(), page = await workspace.list_notes({ limit: 1 });
  assert.equal(page.entries[0].target, path.join(f.root, 'a.md')); assert.equal(page.nextCursor, 'a.md');
  const next = await workspace.list_notes({ cursor: page.nextCursor, limit: 10 }); assert.deepEqual(next.entries.map(entry => path.basename(entry.target)), ['b.md', 'tasks']);
  await assert.rejects(workspace.draft_note({ target: 'a.md', content: body, summary: 'Listed only' }), { code: 'WORKSPACE_NOTE_UNREAD' });
  const explicit = await fixture(t, { file: true }), fileWorkspace = await explicit.open();
  await fileWorkspace.draft_note({ target: 'chosen.md', content: body, summary: 'Explicit target' });
  await assert.rejects(fileWorkspace.draft_note({ target: 'elsewhere.md', content: body, summary: 'Wrong target' }), { code: 'NOTE_TARGET_OUTSIDE' });
  assert.equal((await finish(fileWorkspace)).drafts[0].target, explicit.project.destination.path);
});

test('path/link defenses reserve logs even off and bind replaced parents/root without creating missing directories', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'tasks')); await fs.writeFile(path.join(f.root, 'tasks', 'one.md'), body);
  const workspace = await f.open();
  for (const target of ['logs/new.md', '../outside.md', 'NUL.md', 'bad\\name.md']) await assert.rejects(workspace.draft_note({ target, content: body, summary: 'Unsafe target' }));
  await workspace.read_note({ target: 'tasks/one.md' }); await fs.rename(path.join(f.root, 'tasks'), path.join(f.root, 'old-tasks')); await fs.mkdir(path.join(f.root, 'tasks'));
  await assert.rejects(workspace.read_note({ target: 'tasks/one.md' }), { code: 'PATH_CHANGED' });
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(f.root, 'old-tasks'), path.join(f.root, 'linked'));
    await assert.rejects(workspace.read_note({ target: 'linked/one.md' }), { code: 'PATH_UNSAFE' });
    await fs.link(path.join(f.root, 'old-tasks', 'one.md'), path.join(f.root, 'hard.md'));
    await assert.rejects(workspace.read_note({ target: 'hard.md' }), { code: 'PATH_UNSAFE' });
  }
  const pinned = await f.open(); await fs.rename(f.root, path.join(f.temporary, 'old-root')); await fs.mkdir(f.root);
  await assert.rejects(pinned.list_notes(), { code: 'PATH_CHANGED' });
});

test('bounded activity log queries require trusted reader and do not authorize ordinary log drafts', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'logs'));
  const log = createAnnualLog({ year: 2026, noteId: 'annual', seriesId: 'series', timezone: 'UTC', skillVersion, createdAt: now });
  const appended = appendLogEntry(log, { eventId: runId, projectId: 'synthetic', savedAt: now, action: 'created', target: 'topic.md', summary: 'Synthetic save' }, { year: 2026, seriesId: 'series', timezone: 'UTC' });
  await fs.writeFile(path.join(f.root, 'logs', '2026.md'), appended.bytes);
  const workspace = await f.open({ readActivityLog: async query => queryLogEntries(appended.bytes, { ...query, seriesId: 'series', timezone: 'UTC' }) });
  const result = await workspace.read_activity_log({ year: 2026, limit: 1 }); assert.equal(result.entries.length, 1); assert.equal(result.entries[0].target, 'topic.md');
  await assert.rejects(workspace.draft_note({ target: 'logs/2026.md', content: body, summary: 'Forbidden' }), { code: 'NOTE_TARGET_RESERVED' });
  await assert.rejects((await f.open()).read_activity_log({ year: 2026 }), { code: 'WORKSPACE_LOG_UNAVAILABLE' });
  const tooMuch = await f.open({ limits: { contextBytes: 100 }, readActivityLog: async () => ({ entries: ['x'.repeat(101)] }) });
  await assert.rejects(tooMuch.read_activity_log({ year: 2026 }), { code: 'WORKSPACE_CONTEXT_LIMIT' });
  assert.equal(NOTE_WORKSPACE_TOOLS.length, 5); assert(NOTE_WORKSPACE_TOOLS.every(tool => tool.inputSchema.additionalProperties === false));
  assert(Object.isFrozen(NOTE_WORKSPACE_TOOLS[2].inputSchema.properties.edits.items)); assert(!NOTE_WORKSPACE_TOOLS.some(tool => tool.name === 'manifest'));
});

test('a refused draft receipt leaves no draft and the reserved terminal receipt remains usable', async t => {
  const f = await fixture(t), workspace = await f.open({ limits: { contextBytes: 100 } });
  await assert.rejects(workspace.draft_note({ target: 'new.md', content: body, summary: 'Should not be retained' }), { code: 'WORKSPACE_CONTEXT_LIMIT' });
  assert.deepEqual(await workspace.finish_drafting({ outcome: 'nothing-useful' }), { outcome: 'nothing-useful', drafts: 0 });
  assert.deepEqual((await workspace.manifest()).drafts, []);
});

test('exhausted ordinary context cannot strand an acknowledged draft set', async t => {
  const f = await fixture(t), workspace = await f.open({ limits: { contextBytes: 550 } });
  const receipt = await workspace.draft_note({ target: 'new.md', content: body, summary: 'Retain this draft' });
  for (;;) {
    try { await workspace.list_notes(); } catch (error) { assert.equal(error.code, 'WORKSPACE_CONTEXT_LIMIT'); break; }
  }
  assert.equal((await finish(workspace)).drafts[0].hash, receipt.hash);
});

test('unsafe linked entries do not hide safe notes from a listing or grant read/write authority', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'safe.md'), body);
  await fs.writeFile(path.join(f.temporary, 'outside.md'), body);
  await fs.link(path.join(f.temporary, 'outside.md'), path.join(f.root, 'hard.md'));
  if (process.platform !== 'win32') await fs.symlink(path.join(f.temporary, 'outside.md'), path.join(f.root, 'linked.md'));
  const workspace = await f.open();
  assert.deepEqual((await workspace.list_notes()).entries, [{ target: path.join(f.root, 'safe.md'), kind: 'note' }]);
  await assert.rejects(workspace.read_note({ target: 'hard.md' }), { code: 'PATH_UNSAFE' });
  await assert.rejects(workspace.draft_note({ target: 'hard.md', content: body, summary: 'Must refuse' }), { code: 'PATH_UNSAFE' });
});
