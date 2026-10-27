import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pinDirectory } from '../../src/storage/paths.mjs';
import { hashBytes } from '../../src/storage/files.mjs';
import { prepareNotePublication, publishNotePublication, readPublicationSource, discardNoteStage, discardRecordedNoteStage } from '../../src/storage/note-writer.mjs';
import { establishActivityLogSeries, inspectActivityLogSeries, readActivityLog, logCandidate, logPin, logYear } from '../../src/logs/storage.mjs';
import { inspectAnnualLog } from '../../src/logs/index.mjs';

const setupOptions = () => ({ year: 2026, seriesId: 'synthetic-series', noteId: randomUUID(), timezone: 'America/Los_Angeles',
  createdAt: '2026-10-22T01:00:00.000Z', skillVersion: '0.16.0', expandedMetadata: false, runId: randomUUID() });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-log-storage-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = path.join(root, 'notes'); await fs.mkdir(notes);
  return { root, notes, pin: await pinDirectory(notes), destination: { kind: 'directory', path: notes } };
}
const event = (overrides = {}) => ({ eventId: randomUUID(), projectId: 'synthetic', savedAt: '2026-10-22T01:00:00.000Z', action: 'created', target: 'topic.markdown', summary: 'Synthetic saved choice.', ...overrides });
const stagePath = note => path.join(note.root, path.dirname(note.relative), `.cuefluent-note.${note.runId}.${note.draftId}.tmp`);

test('explicit setup journals publication and reuses existing authoritative shared series', async t => {
  const f = await fixture(t), options = setupOptions(), journal = [];
  const binding = await establishActivityLogSeries(f.pin, { ...options, persistIntent: async note => journal.push(note) });
  assert.equal(journal.length, 2); assert.equal(journal[0].stage, null); assert.ok(journal[1].stage);
  const before = await fs.readFile(path.join(f.notes, 'logs/2026.md'));
  const reused = await establishActivityLogSeries(f.pin, { ...setupOptions(), year: 2027, seriesId: 'different', timezone: 'UTC', persistIntent: async () => assert.fail('Must not publish a second setup file.') });
  assert.deepEqual(reused, binding);
  assert.deepEqual(await fs.readdir(path.join(f.notes, 'logs')), ['2026.md']);
  assert.deepEqual(await fs.readFile(path.join(f.notes, 'logs/2026.md')), before);
  assert.deepEqual((await inspectActivityLogSeries(f.destination)).years, [2026]);
  assert.equal((await logPin(binding)).root, f.notes);
});

test('setup resumes the same exact intent and malformed or unrecognized preexisting logs remain unchanged', async t => {
  const f = await fixture(t), options = setupOptions(); let intent;
  await assert.rejects(establishActivityLogSeries(f.pin, { ...options, persistIntent: async note => { intent = note; throw Object.assign(new Error(), { code: 'SYNTHETIC_STOP' }); } }), { code: 'SYNTHETIC_STOP' });
  const binding = await establishActivityLogSeries(f.pin, { ...options, publication: intent, persistIntent: async note => { intent = note; } });
  assert.equal(binding.seriesId, options.seriesId);
  for (const name of ['2027.md']) {
    const target = path.join(f.notes, 'logs', name), bytes = Buffer.from('# Existing manual file\n'); await fs.writeFile(target, bytes);
    await assert.rejects(establishActivityLogSeries(f.pin, { ...setupOptions(), persistIntent: async () => assert.fail('Must preserve existing content.') }), error => error.code.startsWith('LOG_'));
    assert.deepEqual(await fs.readFile(target), bytes); await fs.unlink(target);
  }
});

test('established series preserves unrelated sibling files and stages while malformed annual paths still refuse', async t => {
  const f = await fixture(t), options = setupOptions();
  const binding = await establishActivityLogSeries(f.pin, { ...options, persistIntent: async () => {} });
  const logs = path.join(f.notes, 'logs'), siblings = ['.DS_Store', 'README.md', '.cuefluent-note.other-run.tmp', 'editor.swp'];
  for (const name of siblings) await fs.writeFile(path.join(logs, name), `Unrelated ${name}`);
  const existing = await fs.readFile(path.join(logs, '2026.md'));
  assert.deepEqual((await inspectActivityLogSeries(f.destination)).binding, binding);
  assert.equal((await readActivityLog(f.destination, { year: 2026 })).entries.length, 0);
  const bytes = logCandidate(binding, event(), existing, { skillVersion: '0.16.0', expandedMetadata: false }).bytes;
  await fs.writeFile(path.join(logs, '2026.md'), bytes);
  assert.equal((await readActivityLog(f.destination, { year: 2026 })).entries.length, 1);
  assert.deepEqual(await establishActivityLogSeries(f.pin, { ...setupOptions(), persistIntent: async () => assert.fail('Do not replace series.') }), binding);
  for (const name of siblings) assert.equal(await fs.readFile(path.join(logs, name), 'utf8'), `Unrelated ${name}`);
  await fs.mkdir(path.join(logs, '2027.md'));
  await assert.rejects(inspectActivityLogSeries(f.destination), { code: 'LOG_LAYOUT_UNRECOGNIZED' });
});

test('unrelated-only logs directory is preserved and never adopted as a new series', async t => {
  const f = await fixture(t), logs = path.join(f.notes, 'logs'); await fs.mkdir(logs);
  await fs.writeFile(path.join(logs, 'README.md'), 'Existing notes.');
  await assert.rejects(establishActivityLogSeries(f.pin, { ...setupOptions(), persistIntent: async () => assert.fail('No publication authorized.') }), { code: 'LOG_LAYOUT_UNRECOGNIZED' });
  assert.deepEqual(await fs.readdir(logs), ['README.md']);
});

test('read-only bounded queries follow current targets, reject changed cursors, and create no artifacts', async t => {
  const f = await fixture(t), options = setupOptions();
  const binding = await establishActivityLogSeries(f.pin, { ...options, persistIntent: async () => {} });
  const target = path.join(f.notes, 'logs/2026.md'), first = event(), second = event({ savedAt: '2026-10-23T01:00:00.000Z' });
  let bytes = await fs.readFile(target);
  bytes = logCandidate(binding, first, bytes, { skillVersion: '0.16.0', expandedMetadata: false }).bytes;
  bytes = logCandidate(binding, second, bytes, { skillVersion: '0.16.0', expandedMetadata: false }).bytes; await fs.writeFile(target, bytes);
  const result = await readActivityLog(f.destination, { year: 2026, binding, limit: 1, projectId: 'synthetic', target: 'topic.markdown' });
  assert.equal(result.entries[0].eventId, second.eventId); assert.ok(result.nextCursor);
  assert.equal((await readActivityLog(f.destination, { year: 2026, binding, limit: 1, projectId: 'synthetic', target: 'topic.markdown', cursor: result.nextCursor })).entries[0].eventId, first.eventId);
  assert.deepEqual(await fs.readFile(target), bytes); assert.deepEqual(await fs.readdir(path.dirname(target)), ['2026.md']);
  await fs.appendFile(target, '\nManual addition.\n');
  await assert.rejects(readActivityLog(f.destination, { year: 2026, binding, limit: 1, projectId: 'synthetic', target: 'topic.markdown', cursor: result.nextCursor }), { code: 'LOG_CURSOR_CHANGED' });
  await assert.rejects(readActivityLog({ kind: 'directory', path: path.join(f.root, 'absent') }, { year: 2026 }), error => Boolean(error.code));
  await assert.rejects(fs.stat(path.join(f.root, 'absent')), { code: 'ENOENT' });
});

test('rollover uses fixed series zone and reproducible annual identity and rejects impossible dates', async t => {
  const f = await fixture(t), binding = await establishActivityLogSeries(f.pin, { ...setupOptions(), persistIntent: async () => {} });
  const input = event({ savedAt: '2027-01-01T09:00:00.000Z' }), first = logCandidate(binding, input, null, { skillVersion: '0.16.0', expandedMetadata: false });
  assert.equal(first.relative, 'logs/2027.md');
  assert.deepEqual(first.bytes, logCandidate(binding, input, null, { skillVersion: '0.16.0', expandedMetadata: false }).bytes);
  const annual = inspectAnnualLog(first.bytes, { year: 2027 });
  assert.equal(annual.seriesId, binding.seriesId); assert.equal(annual.timezone, binding.timezone);
  assert.equal(logYear('2027-01-01T01:00:00.000Z', binding.timezone), 2026);
  assert.throws(() => logYear('2026-02-30T01:00:00.000Z', 'UTC'), { code: 'LOG_ARGUMENT' });
  assert.throws(() => logCandidate(binding, input, null), { code: 'LOG_ARGUMENT' });
});

test('explicit abandonment removes only the exact owned stage despite a manually edited public note', async t => {
  const f = await fixture(t), target = path.join(f.notes, 'ordinary.md'), original = Buffer.from('Original user bytes.\n'), candidate = Buffer.from('Proposed exact bytes.\n');
  await fs.writeFile(target, original);
  let note = await prepareNotePublication(f.pin, 'ordinary.md', candidate, { runId: randomUUID(), draftId: randomUUID(), expectedHash: hashBytes(original), hash: hashBytes(candidate) });
  assert.deepEqual((await readPublicationSource(f.pin, note)).bytes, original);
  await assert.rejects(publishNotePublication(f.pin, note, candidate, { persistIntent: async next => { note = next; throw Object.assign(new Error(), { code: 'SYNTHETIC_STOP' }); } }), { code: 'SYNTHETIC_STOP' });
  const stage = stagePath(note); await fs.access(stage); await fs.writeFile(target, 'Human changed the original.\n');
  await assert.rejects(discardNoteStage(f.pin, note), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.deepEqual(await discardRecordedNoteStage(f.pin, note), { discarded: true, backupPreserved: false });
  assert.equal(await fs.readFile(target, 'utf8'), 'Human changed the original.\n'); await assert.rejects(fs.stat(stage), { code: 'ENOENT' });
  const other = Buffer.from('Other bytes.');
  note = await prepareNotePublication(f.pin, 'other.md', other, { runId: randomUUID(), draftId: randomUUID(), expectedHash: null, hash: hashBytes(other) });
  await assert.rejects(publishNotePublication(f.pin, note, other, { persistIntent: async next => { note = next; throw Object.assign(new Error(), { code: 'SYNTHETIC_STOP' }); } }));
  const recorded = stagePath(note); await fs.rename(recorded, `${recorded}.owned`); await fs.writeFile(recorded, 'Unrelated replacement.');
  await assert.rejects(discardRecordedNoteStage(f.pin, note), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.equal(await fs.readFile(recorded, 'utf8'), 'Unrelated replacement.');
});

test('desktop metadata alone does not claim a log series and is preserved during explicit setup', async t => {
  const f = await fixture(t), logs = path.join(f.notes, 'logs'); await fs.mkdir(logs);
  const desktop = path.join(logs, '.DS_Store'); await fs.writeFile(desktop, 'Synthetic Finder metadata');
  const binding = await establishActivityLogSeries(f.pin, { ...setupOptions(), persistIntent: async () => {} });
  assert.equal(binding.seriesId, 'synthetic-series');
  assert.equal(await fs.readFile(desktop, 'utf8'), 'Synthetic Finder metadata');
  assert.equal((await inspectActivityLogSeries(f.destination)).years[0], 2026);
});


test('internal log construction rejects an omitted or non-boolean format before writing', async t => {
  const f = await fixture(t), options = setupOptions();
  const binding = { seriesId: options.seriesId, timezone: options.timezone };
  for (const expandedMetadata of [undefined, null, 0, 'false']) {
    await assert.rejects(establishActivityLogSeries(f.pin, { ...options, expandedMetadata,
      persistIntent: async () => assert.fail('Invalid options must not publish intent.') }), { code: 'LOG_ARGUMENT' });
    assert.throws(() => logCandidate(binding, event(), null, { skillVersion: options.skillVersion, expandedMetadata }), { code: 'LOG_ARGUMENT' });
    assert.deepEqual(await fs.readdir(f.notes), []);
  }
});
