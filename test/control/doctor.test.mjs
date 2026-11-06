import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject } from '../../src/core/settings.mjs';
import { initializeStore, withProject } from '../../src/storage/store.mjs';
import { writeJSON } from '../../src/storage/files.mjs';
import { createGeneratedNote } from '../../src/notes/index.mjs';
import { checkNotes, DOCTOR_LIMITS } from '../../src/control/doctor.mjs';
import { createDirectNoteTools } from '../../src/control/direct-notes.mjs';
import { createControlBridge, CONTROL_LIMITS } from '../../src/client/control-server.mjs';
import { readProjectStatus } from '../../src/control/status.mjs';

const skillVersion = '0.24.0', hash = `sha256:${'a'.repeat(64)}`;
const text = (title, aliases, extra = '') => `# ${title}\n\n## Overview\n<!-- aliases: ${aliases} -->\nVisible overview.\n${extra}`;
const generated = (id, body, metadata = {}) => createGeneratedNote(body, { id, now: '2026-10-22T01:00:00Z', skillVersion, metadata });
const comment = '\n<!-- Evidence: captured earlier -->\n';

async function fixture(t, { file = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-doctor-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  const project = createProject({ id: 'demo', root: cwd, destination: file ? { kind: 'file', path: path.join(notes, 'explicit.md') } : { kind: 'directory', path: notes }, saving: 'review' });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const write = async (relative, bytes) => {
    const target = path.join(notes, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return target;
  };
  const check = (input = {}, options = {}) => checkNotes(store, { projectId: 'demo', ...input }, { skillVersion, ...options });
  return { root, notes, store, write, check };
}
/** Every entry below a folder with its identity, size, time and bytes. */
async function tree(directory) {
  const names = (await fs.readdir(directory, { recursive: true })).sort();
  return Promise.all(names.map(async relative => {
    const file = path.join(directory, relative), stat = await fs.lstat(file, { bigint: true });
    return { relative, inode: stat.ino, size: stat.size, modified: stat.mtimeNs, bytes: stat.isFile() ? await fs.readFile(file) : null };
  }));
}
const names = (f, report) => report.notes.map(note => path.relative(f.notes, note.target).split(path.sep).join('/'));
const codes = note => note.findings.map(item => item.code);

test('a project check reports each note with findings in name order, leaves out logs and other files, and writes nothing', async t => {
  const f = await fixture(t);
  await f.write('knowledge-base/clean.md', generated('clean', text('Clean topic', 'clean alias')));
  await f.write('meetings/planning.md', generated('planning', text('Planning', 'planning alias', comment),
    { sources: [{ type: 'document', ref: 'Synthetic agenda', source_hash: hash }], generation: { content_hash: hash } }));
  await f.write('tasks/plain.md', text('Plain task', 'plain alias', comment));
  await f.write('logs/2026.md', text('Reserved log', 'planning alias', comment));
  await f.write('scratch.txt', comment);
  const before = { notes: await tree(f.notes), store: await tree(f.store.root) };
  const report = await f.check();
  assert.equal(report.state, 'checked'); assert.equal(report.scope, 'project'); assert.equal(report.next, null);
  assert.deepEqual(report.coverage, { complete: true, notes: 3, directories: 4, reasons: [] });
  assert.deepEqual(report.run, { state: 'none' });
  assert.deepEqual(names(f, report), ['meetings/planning.md', 'tasks/plain.md']);
  assert.deepEqual(codes(report.notes[0]), ['content-hash', 'source-hash', 'hidden-comment']);
  assert.deepEqual(report.notes[0].findings.map(item => item.repair), ['mechanical', 'mechanical', 'content-update']);
  assert.equal(report.notes[0].metadata, 'supported'); assert.ok(report.notes[0].headerBytes > 0);
  assert.deepEqual(codes(report.notes[1]), ['hidden-comment']); assert.equal(report.notes[1].metadata, 'absent');
  assert.deepEqual(Object.keys(report.codes), ['content-hash', 'source-hash', 'hidden-comment']);
  assert.equal(report.totals.notes, 3); assert.equal(report.totals.withFindings, 2);
  assert.deepEqual(report.totals.metadata, { supported: 2, absent: 1, invalid: 0, unsupported: 0, unreadable: 0 });
  assert.deepEqual(report.totals.sources, { document: 1, session: 0 }); assert.equal(report.totals.sections, 3); assert.equal(report.totals.aliases, 3);
  assert.deepEqual(report.totals.findings['hidden-comment'], { notes: 2, count: 2, bytes: 2 * Buffer.byteLength(comment.trim()) });
  assert.deepEqual({ notes: await tree(f.notes), store: await tree(f.store.root) }, before);
});

test('aliases shared across notes and repeated identities are counted on every note that holds them', async t => {
  const f = await fixture(t);
  const twice = '# Billing\n\n## Overview\n<!-- aliases: 123456, billing overview -->\nVisible.\n\n## History\n<!-- aliases: 123456 -->\nVisible.\n';
  await f.write('a.md', generated('shared-identity', twice));
  await f.write('b.md', generated('shared-identity', text('Invoices', '123456, invoices')));
  await f.write('c.md', generated('other', text('Unrelated', 'unrelated alias')));
  const report = await f.check(), [a, b] = report.notes;
  assert.deepEqual(names(f, report), ['a.md', 'b.md']);
  assert.deepEqual(codes(a), ['note-id-duplicate', 'alias-in-note', 'alias-across-notes']); assert.deepEqual(codes(b), ['note-id-duplicate', 'alias-across-notes']);
  const item = (note, code) => note.findings.find(entry => entry.code === code);
  assert.equal(item(a, 'alias-in-note').count, 2); assert.equal(item(a, 'alias-across-notes').count, 2); assert.equal(item(b, 'alias-across-notes').count, 1);
  assert.deepEqual(item(a, 'alias-across-notes').items.map(entry => [entry.alias, entry.heading, entry.notes]), [['123456', 'Overview', ['b.md']], ['123456', 'History', ['b.md']]]);
  assert.deepEqual(item(a, 'note-id-duplicate').items, [{ notes: ['b.md'] }]); assert.equal(item(a, 'note-id-duplicate').repair, 'blocked');
  assert.deepEqual(report.totals.findings['alias-across-notes'], { notes: 2, count: 3, bytes: 0 });
  assert.deepEqual(report.totals.findings['alias-in-note'], { notes: 1, count: 2, bytes: 0 });
});

test('a long report is paged within its byte budget and a cursor is refused once the notes change', async t => {
  const f = await fixture(t), total = 12, pageBytes = 2048;
  for (let index = 0; index < total; index++) await f.write(`note-${String(index).padStart(2, '0')}.md`, text(`Topic ${index}`, `alias ${index}`, comment));
  const seen = []; let page = await f.check({}, { limits: { pageBytes } }), pages = 1;
  const corpus = page.corpus, second = page.next;
  for (; pages <= total; pages++) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= pageBytes); assert.equal(page.corpus, corpus); assert.equal(page.totals.withFindings, total);
    seen.push(...names(f, page));
    if (page.next === null) break;
    page = await f.check({ cursor: page.next }, { limits: { pageBytes } });
  }
  assert.ok(pages > 1); assert.equal(page.next, null);
  assert.deepEqual(seen, Array.from({ length: total }, (_, index) => `note-${String(index).padStart(2, '0')}.md`));
  for (const cursor of ['0', `${corpus}:`, `${corpus}:0`, `${corpus}:01`, `${corpus.slice(1)}:1`, `${corpus}:${total}`, `${corpus}:${total + 1}`, `${corpus}:12345`, 7]) {
    await assert.rejects(f.check({ cursor }), { code: 'DIRECT_NOTE_ARGUMENT' });
  }
  await assert.rejects(f.check({ cursor: second, target: 'note-00.md' }), { code: 'DIRECT_NOTE_ARGUMENT' });
  await f.write('note-00.md', text('Topic 0', 'alias 0, another', comment));
  await assert.rejects(f.check({ cursor: second }, { limits: { pageBytes } }), { code: 'WORKSPACE_LIST_CHANGED' });
  assert.notEqual((await f.check()).corpus, corpus);
});

test('one note is selected by its portable name, reported even when clean, and absent or reserved targets say so', async t => {
  const f = await fixture(t);
  const clean = await f.write('knowledge-base/clean.md', generated('clean', text('Clean topic', 'shared alias')));
  await f.write('other.md', text('Other', 'shared alias', comment));
  for (const target of ['knowledge-base/clean.md', clean, 'Knowledge-Base/CLEAN.md']) {
    const report = await f.check({ target });
    assert.equal(report.scope, 'note'); assert.equal(report.next, null); assert.equal(report.totals.notes, 2);
    assert.deepEqual(report.notes.map(note => note.target), [clean]);
    assert.deepEqual(codes(report.notes[0]), ['alias-across-notes']);
  }
  await fs.rm(path.join(f.notes, 'other.md'));
  assert.deepEqual((await f.check({ target: 'knowledge-base/clean.md' })).notes[0].findings, []);
  assert.deepEqual(await f.check({ target: 'missing.md' }), { state: 'absent', projectId: 'demo', target: path.join(f.notes, 'missing.md') });
  await assert.rejects(f.check({ target: path.join(f.root, 'outside.md') }), { code: 'PATH_INVALID' });
  await assert.rejects(f.check({ target: 'logs/2026.md' }), { code: 'NOTE_TARGET_RESERVED' });
  for (const target of ['', 7, 'x'.repeat(32769)]) await assert.rejects(f.check({ target }), { code: 'DIRECT_NOTE_ARGUMENT' });
});

test('files that cannot be interpreted are reported as blocked while every other note is still checked', async t => {
  const f = await fixture(t);
  await f.write('binary.md', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  await f.write('future.md', `<!-- cuefluent\nschema_version: 99\nfuture: [one, two]\n-->\n${text('Future', 'future alias')}`);
  await f.write('malformed.md', `<!-- cuefluent\nschema_version: 1\nid: [bad\n-->\n${text('Malformed', 'malformed alias')}`);
  await f.write('readable.md', text('Readable', 'readable alias', comment));
  const before = await tree(f.notes), report = await f.check();
  assert.deepEqual(names(f, report), ['binary.md', 'future.md', 'malformed.md', 'readable.md']);
  assert.deepEqual(report.notes.map(codes), [['note-unreadable'], ['metadata-unsupported'], ['metadata-invalid'], ['hidden-comment']]);
  assert.deepEqual(report.notes[0].findings[0].items, [{ reason: 'NOTE_UTF8_INVALID' }]); assert.equal(report.notes[0].metadata, 'unreadable');
  assert.deepEqual(report.notes.slice(0, 3).map(note => note.findings[0].repair), ['blocked', 'blocked', 'blocked']);
  assert.deepEqual(report.totals.metadata, { supported: 0, absent: 1, invalid: 1, unsupported: 1, unreadable: 1 });
  assert.equal(report.coverage.complete, true); assert.deepEqual(await tree(f.notes), before);
});

test('a check stops at its bounds, says the coverage is partial, and still inspects a selected note beyond them', async t => {
  const f = await fixture(t);
  for (const name of ['a', 'b', 'c']) await f.write(`${name}.md`, text(`Topic ${name}`, `alias ${name}`, comment));
  const bounded = await f.check({}, { limits: { notes: 2 } });
  assert.deepEqual(bounded.coverage, { complete: false, notes: 2, directories: 1, reasons: ['note-limit'] });
  assert.deepEqual(names(f, bounded), ['a.md', 'b.md']); assert.equal(bounded.totals.notes, 2);
  const selected = await f.check({ target: 'c.md' }, { limits: { notes: 2 } });
  assert.deepEqual(names(f, selected), ['c.md']); assert.equal(selected.coverage.complete, false);
  const size = Buffer.byteLength(text('Topic a', 'alias a', comment));
  assert.deepEqual((await f.check({}, { limits: { bytes: size * 2 } })).coverage.reasons, ['byte-limit']);
  await fs.mkdir(path.join(f.notes, 'one', 'two'), { recursive: true }); await f.write('one/two/deep.md', text('Deep', 'deep alias', comment));
  assert.deepEqual((await f.check({}, { limits: { depth: 1 } })).coverage.reasons, ['depth-limit']);
  assert.deepEqual((await f.check({}, { limits: { directories: 2 } })).coverage.reasons, ['directory-limit']);
  assert.equal((await f.check()).coverage.complete, true);
  for (const limits of [{ notes: DOCTOR_LIMITS.notes + 1 }, { notes: 0 }, { unknown: 1 }, { pageBytes: 1.5 }]) {
    await assert.rejects(f.check({}, { limits }), { code: 'DOCTOR_LIMIT_INVALID' });
  }
});

test('a pending run is reported and left exactly as it was, and a busy project does not stop the check', async t => {
  const f = await fixture(t), tools = createDirectNoteTools({ store: f.store, client: 'codex', skillVersion });
  await f.write('existing.md', text('Existing', 'existing alias', comment));
  const draft = await tools.call('cuefluent_create_note', { projectId: 'demo', requestId: randomUUID(), target: 'meetings/planning.md',
    content: '# Planning meeting\n\n## Decisions\nKeep the release small.\n', summary: 'Planning decisions.' });
  assert.equal(draft.state, 'review');
  const before = { status: await readProjectStatus(f.store, 'demo'), notes: await tree(f.notes), store: await tree(f.store.root) };
  const report = await f.check();
  assert.deepEqual(report.run, { state: 'pending', kind: 'direct', phase: 'review', active: false });
  assert.deepEqual(names(f, report), ['existing.md']);
  assert.deepEqual({ status: await readProjectStatus(f.store, 'demo'), notes: await tree(f.notes), store: await tree(f.store.root) }, before);
  await withProject(f.store, 'demo', async () => {
    const busy = await f.check();
    assert.deepEqual(busy.run, { state: 'busy' }); assert.deepEqual(names(f, busy), ['existing.md']);
  });
});

test('an unconfigured store, an unknown project and malformed selectors are refused without creating anything', async t => {
  const f = await fixture(t);
  assert.deepEqual(await checkNotes(null, { projectId: 'demo' }, { skillVersion }), { state: 'unconfigured', message: 'Set up a note destination first.' });
  await assert.rejects(f.check({ projectId: 'other' }), { code: 'PROJECT_UNCONFIGURED' });
  for (const projectId of ['../demo', '', 7]) await assert.rejects(f.check({ projectId }), { code: 'DIRECT_NOTE_ARGUMENT' });
  assert.deepEqual(await fs.readdir(f.notes), []);
});

test('a file destination checks exactly its one note', async t => {
  const f = await fixture(t, { file: true });
  await f.write('sibling.md', text('Sibling', 'sibling alias', comment));
  assert.equal((await f.check()).totals.notes, 0);
  const target = await f.write('explicit.md', text('Explicit', 'explicit alias', comment));
  const report = await f.check();
  assert.equal(report.totals.notes, 1); assert.deepEqual(report.notes.map(note => note.target), [target]);
  assert.deepEqual((await f.check({ target: 'explicit.md' })).notes.map(note => note.target), [target]);
});

test('both MCP hosts serve the check through the response contract, and it stays unavailable without a store', async t => {
  const f = await fixture(t);
  await f.write('note.md', generated('note', text('Topic', 'topic alias', comment), { generation: { content_hash: hash } }));
  const expected = await f.check();
  for (const client of ['claude', 'codex']) {
    const tools = createDirectNoteTools({ store: f.store, client, skillVersion });
    assert.deepEqual(await tools.call('cuefluent_check_notes', { projectId: 'demo' }), expected);
    assert.equal(tools.tools.find(tool => tool.name === 'cuefluent_check_notes').annotations.readOnlyHint, true);
    const bridge = createControlBridge({ client, directNotes: tools, codexAdapter: { bindCommand: () => assert.fail('No native transcript reads') },
      executeInvocation: () => assert.fail('No native commands'), readInvocation: () => assert.fail('No native handle') });
    const protocol = bridge.protocol({ version: skillVersion });
    await protocol({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } });
    await protocol({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const call = async (id, args) => (await protocol({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cuefluent_check_notes', arguments: args,
      ...(client === 'codex' ? { _meta: { 'x-codex-turn-metadata': { session_id: 'native-session', thread_id: 'native-session', turn_id: `turn-${id}` } } } : {}) } })).result;
    const served = await call(2, { projectId: 'demo', target: 'note.md' });
    assert.equal(served.isError, false); assert.equal(served.structuredContent.state, 'checked');
    assert.deepEqual(served.structuredContent.notes.map(codes), [['content-hash', 'hidden-comment']]);
    const refused = await call(3, { projectId: 'demo', cursor: 'not-a-cursor' });
    assert.equal(refused.isError, true); assert.equal(JSON.parse(refused.content[0].text).error, 'DIRECT_NOTE_ARGUMENT');
    const absent = createDirectNoteTools({ store: null, client, skillVersion });
    assert.equal((await absent.call('cuefluent_check_notes', { projectId: 'demo' })).state, 'unconfigured');
  }
});

test('a Markdown-named entry that is not an ordinary file is reported unread, and a link or folder that is not entered makes coverage partial', async t => {
  const f = await fixture(t), tools = createDirectNoteTools({ store: f.store, client: 'claude', skillVersion });
  const note = await f.write('note.md', text('Topic', 'topic alias', comment));
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'inner.md'), text('Outside', 'outside alias', comment));
  await fs.link(path.join(outside, 'inner.md'), path.join(f.notes, 'hard.md'));
  // Links and names that are not portable cannot be made on every platform, so
  // the expectations follow what the folder really holds.
  await fs.symlink(path.join(outside, 'inner.md'), path.join(f.notes, 'linked.md')).catch(() => {});
  await fs.symlink(outside, path.join(f.notes, 'linked-folder'), 'junction').catch(() => {});
  await fs.writeFile(path.join(f.notes, 'what?.md'), text('Odd', 'odd alias', comment)).catch(() => {});
  await fs.mkdir(path.join(f.notes, 'trailing ')).then(() => fs.writeFile(path.join(f.notes, 'trailing ', 'inside.md'), text('Inside', 'inside alias', comment))).catch(() => {});
  const present = new Set(await fs.readdir(f.notes));
  const unread = [['hard.md', 'PATH_UNSAFE'], ['linked.md', 'PATH_UNSAFE'], ['what?.md', 'PATH_INVALID']].filter(([name]) => present.has(name));
  const reasons = [['trailing ', 'skipped-directory'], ['linked-folder', 'skipped-link']].filter(([name]) => present.has(name)).map(([, reason]) => reason);
  assert.ok(unread.length >= 1 && reasons.length >= 1, 'the platform made at least a hard link and a linked folder');

  const before = { notes: await tree(f.notes), outside: await tree(outside) }, report = await f.check();
  assert.deepEqual(names(f, report), [...unread.map(([name]) => name), 'note.md'].sort());
  for (const [name, reason] of unread) {
    const entry = report.notes[names(f, report).indexOf(name)];
    assert.equal(entry.metadata, 'unreadable'); assert.deepEqual(entry.findings, [{ code: 'note-unreadable', repair: 'blocked', count: 1, items: [{ reason }] }]);
  }
  assert.deepEqual({ ...report.coverage, reasons: [...report.coverage.reasons].sort() }, { complete: false, notes: unread.length + 1, directories: 1, reasons: reasons.sort() });
  assert.equal(report.totals.metadata.unreadable, unread.length); assert.equal(report.totals.aliases, 1, 'only the ordinary note was read');
  assert.equal((await f.check({ target: 'hard.md' })).notes[0].findings[0].code, 'note-unreadable');
  // The listing an assistant browses still names ordinary notes only.
  assert.deepEqual((await tools.call('cuefluent_list_notes', { projectId: 'demo' })).entries, [{ target: note, kind: 'note' }]);
  assert.deepEqual({ notes: await tree(f.notes), outside: await tree(outside) }, before);
});

test('a folder that differs from another only by case is left out and makes coverage partial', async t => {
  const f = await fixture(t);
  await f.write('Topics/first.md', text('First', 'first alias', comment));
  await fs.mkdir(path.join(f.notes, 'topics')).catch(() => {});
  if ((await fs.readdir(f.notes)).length !== 2) return t.skip('This filesystem does not keep names that differ only by case.');
  await f.write('topics/second.md', text('Second', 'second alias', comment));
  const report = await f.check();
  assert.deepEqual(report.coverage, { complete: false, notes: 1, directories: 2, reasons: ['skipped-directory'] });
  assert.deepEqual(names(f, report), ['Topics/first.md']);
});

test('a term or identity that many notes share names five of them and counts the rest', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 8; index++) await f.write(`note-${index}.md`, generated('same-identity', text(`Topic ${index}`, 'common alias')));
  const report = await f.check();
  assert.equal(report.notes.length, 8);
  for (const code of ['note-id-duplicate', 'alias-across-notes']) {
    const finding = report.notes[0].findings.find(entry => entry.code === code);
    assert.equal(finding.count, 1); assert.deepEqual(finding.items[0].notes, [1, 2, 3, 4, 5].map(index => `note-${index}.md`)); assert.equal(finding.items[0].moreNotes, 2);
  }
  assert.deepEqual(report.totals.findings['alias-across-notes'], { notes: 8, count: 8, bytes: 0 });
});

test('a page also stays within the number of values one response may hold', async t => {
  const f = await fixture(t), total = 6, pageNodes = 200;
  const remarks = Array.from({ length: 12 }, (_, index) => `\n<!-- remark ${index} -->\n`).join('');
  for (let index = 0; index < total; index++) await f.write(`note-${index}.md`, text(`Topic ${index}`, `alias ${index}`, remarks));
  const count = value => value === null || typeof value !== 'object' ? 1 : Object.values(value).reduce((sum, item) => sum + count(item), 1);
  const seen = []; let page = await f.check({}, { limits: { pageNodes } }), pages = 1;
  for (; pages <= total; pages++) {
    assert.ok(count(page) <= pageNodes, `${count(page)} values`); seen.push(...names(f, page));
    if (page.next === null) break;
    page = await f.check({ cursor: page.next }, { limits: { pageNodes } });
  }
  assert.ok(pages > 1); assert.equal(page.next, null);
  assert.deepEqual(seen, Array.from({ length: total }, (_, index) => `note-${index}.md`));
  assert.ok(DOCTOR_LIMITS.pageNodes < CONTROL_LIMITS.nodes);
  await assert.rejects(f.check({}, { limits: { pageNodes: 40 } }), { code: 'CONTROL_RESPONSE_LIMIT' });
});

test('run records that cannot be read do not lose the report, which names the code that status gives', async t => {
  const f = await fixture(t);
  await f.write('existing.md', text('Existing', 'existing alias', comment));
  const directory = await withProject(f.store, 'demo', context => context.directory);
  await writeJSON(f.store.pin, `${directory}/run.json`, { schemaVersion: 0 }, { expectedHash: null });
  const reason = await readProjectStatus(f.store, 'demo').then(() => assert.fail('status reads the same records'), error => error.code);
  const before = await tree(f.store.root), report = await f.check();
  assert.deepEqual(report.run, { state: 'unavailable', reason });
  assert.deepEqual(names(f, report), ['existing.md']); assert.deepEqual(await tree(f.store.root), before);
});
