import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnualLog, inspectAnnualLog, inspectLogSeries, appendLogEntry, queryLogEntries } from '../../src/logs/index.mjs';
import { inspectMetadata, validateNote } from '../../src/notes/index.mjs';

const options = { year: 2026, seriesId: 'synthetic-series', timezone: 'America/Los_Angeles' };
const eventId = index => `12345678-1234-4123-8123-${String(index).padStart(12, '0')}`;
const create = (overrides = {}) => createAnnualLog({ ...options, noteId: `synthetic-${overrides.year ?? options.year}`, createdAt: '2026-01-01T00:00:00Z', skillVersion: '0.16.0', ...overrides });
const event = (index = 1, overrides = {}) => ({ eventId: eventId(index), projectId: 'synthetic', savedAt: '2026-10-22T01:00:00Z', action: 'created', target: 'knowledge-base/topic.md', summary: 'Synthetic topic added', ...overrides });
const append = (bytes, index = 1, overrides = {}, opts = options) => appendLogEntry(bytes, event(index, overrides), opts).bytes;

test('creation is a useful valid annual note with authoritative portable metadata and no empty month', () => {
  const bytes = create(), metadata = inspectMetadata(bytes).value;
  assert.equal(validateNote(bytes, { generated: true, kind: 'log' }).valid, true);
  assert.equal(metadata.type, 'log'); assert.equal(metadata.log_format_version, 1);
  assert.deepEqual(metadata.period, { start: '2026-01-01', end: '2026-12-31', timezone: options.timezone });
  assert.equal(metadata.series.id, options.seriesId);
  assert.match(bytes.toString(), /## About this log\n\nDates are note save times/);
  assert.doesNotMatch(bytes.toString(), /## October|aliases:/);
  assert.equal(inspectAnnualLog(bytes, options).entryCount, 0);
});

test('series setup refuses missing/conflicting metadata, duplicate identities and years; empty never guesses', () => {
  const first = create(), second = create({ year: 2027 });
  assert.deepEqual(inspectLogSeries([{ year: 2027, bytes: second }, { year: 2026, bytes: first }]), { seriesId: options.seriesId, timezone: options.timezone, years: [2026, 2027] });
  assert.equal(inspectLogSeries([], options), null);
  for (const bad of [first.toString().replace('log_format_version: 1', 'log_format_version: 2'), first.toString().replace('  id: synthetic-series\n', ''), first.toString().replace('2026-12-31', '2026-12-30'), '# Note activity — 2026\n\n## About this log\n\nPlain text.']) {
    assert.throws(() => inspectAnnualLog(bad, options), error => error.code.startsWith('LOG_'));
  }
  assert.throws(() => inspectLogSeries([{ year: 2026, bytes: first }, { year: 2027, bytes: create({ year: 2027, timezone: 'UTC' }) }]), { code: 'LOG_SERIES_CONFLICT' });
  assert.throws(() => inspectLogSeries([{ year: 2026, bytes: first }, { year: 2026, bytes: first }]), { code: 'LOG_SERIES_CONFLICT' });
  assert.throws(() => inspectLogSeries([{ year: 2026, bytes: first }, { year: 2027, bytes: create({ year: 2027, noteId: 'synthetic-2026' }) }]), { code: 'LOG_SERIES_CONFLICT' });
});

test('timestamp uses fixed series timezone including DST and year boundary, rejects normalized impossible dates', () => {
  const october = queryLogEntries(append(create()), options).entries[0];
  assert.equal(october.savedAt, '2026-10-21T18:00:00-07:00');
  const winter = queryLogEntries(append(create(), 1, { savedAt: '2026-12-22T01:02:03.456Z' }), options).entries[0];
  assert.equal(winter.savedAt, '2026-12-21T17:02:03.456-08:00');
  const edge = queryLogEntries(append(create(), 1, { savedAt: '2027-01-01T01:00:00Z' }), options).entries[0];
  assert.equal(edge.savedAt, '2026-12-31T17:00:00-08:00');
  for (const savedAt of ['2026-02-30T01:00:00Z', '2026-01-01', '2026-10-22T24:00:00Z', '2026-10-22T01:00:60Z']) assert.throws(() => append(create(), 1, { savedAt }), { code: 'LOG_ARGUMENT' });
  assert.throws(() => append(create(), 1, { savedAt: '2027-02-01T01:00:00Z' }), { code: 'LOG_YEAR_MISMATCH' });
});

test('complete existing entry IDs acknowledge retries despite visible hand edits without rewriting bytes', () => {
  const once = append(create());
  const retry = appendLogEntry(once, event(), options);
  assert.equal(retry.changed, false); assert.deepEqual(retry.bytes, once);
  for (const change of [{ summary: 'Different change' }, { action: 'updated' }, { heading: 'Heading' }, { target: 'other.md' }, { savedAt: '2026-10-22T02:00:00Z' }]) {
    assert.deepEqual(appendLogEntry(once, event(1, change), options).bytes, once);
  }
  assert.throws(() => appendLogEntry(once, event(1, { projectId: 'other' }), options), { code: 'LOG_EVENT_CONFLICT' });
  const edited = Buffer.from(once.toString().replace('Synthetic topic added', "A human's revised summary, with punctuation.").replace('](../knowledge-base/topic.md)', '](../knowledge-base/renamed.md)'));
  assert.deepEqual(appendLogEntry(edited, event(), options).bytes, edited);
  assert.deepEqual(queryLogEntries(edited, options).entries[0].summary, "A human's revised summary, with punctuation.");
  assert.equal(queryLogEntries(edited, options).entries[0].target, 'knowledge-base/renamed.md');
  const added = append(edited, 2); assert.ok(added.toString().includes(edited.toString().slice(edited.toString().indexOf('- 2026-')).trim()));
  assert.equal(queryLogEntries(added, options).entries.length, 2);
});

test('reviewed visible summary and heading padding is preserved safely in the log', () => {
  const summary = '  Summary with outer spaces.  ', heading = ' Heading ';
  const result = queryLogEntries(append(create(), 1, { summary, heading }), options).entries[0];
  assert.equal(result.summary, summary); assert.equal(result.heading, heading);
  for (const change of [{ summary: '   ' }, { heading: '  ' }, { summary: 'x\n ' }]) assert.throws(() => append(create(), 1, change), { code: 'LOG_ARGUMENT' });
});

test('delayed entries insert into the correct month without rewriting metadata, manual text, CRLF or other months', () => {
  let bytes = Buffer.from(create().toString().replace(/\n/g, '\r\n').replace('type: log', 'type: log # Keep this metadata comment'));
  const metadata = inspectMetadata(bytes).raw;
  bytes = append(bytes, 1, { savedAt: '2026-10-10T15:00:00Z' });
  bytes = Buffer.from(bytes.toString() + '\r\nPersonal addition: keep exactly.\r\n');
  const october = bytes.toString().slice(bytes.toString().indexOf('## October'));
  bytes = append(bytes, 2, { savedAt: '2026-08-10T15:00:00Z' });
  assert.ok(bytes.toString().endsWith(october));
  assert.equal(inspectMetadata(bytes).raw, metadata);
  assert.doesNotMatch(bytes.toString(), /(?<!\r)\n/);
  bytes = append(bytes, 3, { savedAt: '2026-10-12T15:00:00Z' });
  assert.equal(bytes.toString().split('## October').length, 2);
  assert.match(bytes.toString(), /Personal addition: keep exactly\.\r\n/);
  assert.equal(queryLogEntries(bytes, options).entries.length, 3);
});

test('untrusted fields remain one inert line with an encoded relative current-file link', () => {
  const heading = '<script>do()</script> | [heading](javascript:bad) <!-- cuefluent -->';
  const summary = 'Mention `code`, *emphasis*, & HTML <b> and <!-- note-log-entry event=bad -->';
  const target = 'knowledge-base/a ](x) #?%.md';
  const bytes = append(create(), 1, { heading, summary, target });
  const result = queryLogEntries(bytes, options);
  assert.equal(validateNote(bytes, { kind: 'log' }).valid, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].heading, heading); assert.equal(result.entries[0].summary, summary); assert.equal(result.entries[0].target, target);
  assert.match(bytes.toString(), /\]\(\.\.\/knowledge-base\/a%20%5D%28x%29%20%23%3F%25\.md\)/);
  for (const change of [{ target: '../outside.md' }, { target: '/root.md' }, { target: 'logs/2026.md' }, { target: 'Logs/2026.md' }, { target: 'C:\\notes.md' }, { summary: 'line\nbreak' }, { heading: 'line\u2028break' }, { projectId: undefined }, { eventId: 'invalid' }, { summary: 'x'.repeat(2049) }]) {
    assert.throws(() => append(create(), 1, change), { code: 'LOG_ARGUMENT' });
  }
});

test('code examples never acknowledge an event, and active malformed/duplicate markers fail without repair', () => {
  const base = create().toString(), marker = `<!-- note-log-entry event=${eventId(1)} project=synthetic -->`;
  const examples = base + `\n\x60\x60\x60text\n${marker}\n\x60\x60\x60\n\nInline \x60${marker}\x60.\n`;
  assert.equal(inspectAnnualLog(examples, options).entryCount, 0);
  const bytes = append(examples); assert.equal(queryLogEntries(bytes, options).entries.length, 1);
  const once = append(create()), text = once.toString();
  for (const bad of [text.replace(`event=${eventId(1)}`, 'event=invalid'), text.replace('note-log-entry', 'NOTE-LOG-ENTRY'), text + text.slice(text.indexOf('- 2026-')), text.replace('## October 2026', '## October 2026\n\n## October 2026'), text.replace('## October 2026', '## Not a month')]) {
    assert.throws(() => append(bad, 2), error => error.code.startsWith('LOG_'));
  }
  const edited = text.replace(' | created | ', ' | manually changed | ');
  assert.equal(inspectAnnualLog(edited, options).unrecognizedEntries, 1);
  assert.throws(() => inspectLogSeries([{ year: 2026, bytes: edited }]), { code: 'LOG_ENTRY_INVALID' });
  assert.throws(() => append(edited, 2), { code: 'LOG_INVALID' });
});

test('recent/date/note/project queries are bounded, stable, read-only and hash-bound across manual edits', () => {
  let bytes = create();
  for (let index = 1; index <= 5; index++) bytes = append(bytes, index, { savedAt: `2026-10-${String(index + 10).padStart(2, '0')}T15:00:00Z`, ...(index % 2 ? {} : { projectId: 'other', target: 'other.md' }) });
  const original = Buffer.from(bytes), first = queryLogEntries(bytes, { ...options, limit: 2 });
  assert.deepEqual(first.entries.map(entry => entry.eventId), [eventId(5), eventId(4)]);
  const second = queryLogEntries(bytes, { ...options, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map(entry => entry.eventId), [eventId(3), eventId(2)]);
  assert.equal(queryLogEntries(bytes, { ...options, limit: 2, cursor: second.nextCursor }).nextCursor, null);
  assert.equal(queryLogEntries(bytes, { ...options, from: '2026-10-12T00:00:00Z', to: '2026-10-14T23:59:59Z', target: 'other.md', projectId: 'other' }).entries.length, 2);
  assert.deepEqual(bytes, original);
  assert.throws(() => queryLogEntries(Buffer.from(bytes.toString() + '\nManual text.\n'), { ...options, cursor: first.nextCursor }), { code: 'LOG_CURSOR_CHANGED' });
  assert.throws(() => queryLogEntries(bytes, { ...options, projectId: 'other', cursor: first.nextCursor }), { code: 'LOG_CURSOR_CHANGED' });
  for (const limit of [0, 101, Infinity]) assert.throws(() => queryLogEntries(bytes, { ...options, limit }), { code: 'LOG_ARGUMENT' });
  assert.throws(() => queryLogEntries(bytes, { ...options, from: '2026-02-30T00:00:00Z' }), { code: 'LOG_ARGUMENT' });
});

test('query byte ceiling paginates long untrusted fields without truncating an entry', () => {
  let bytes = create();
  const summary = '📘'.repeat(900);
  for (let index = 1; index <= 20; index++) bytes = append(bytes, index, { summary });
  const first = queryLogEntries(bytes, { ...options, limit: 100 });
  assert.ok(first.entries.length > 0 && first.entries.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify(first.entries)) <= 64 * 1024);
  const second = queryLogEntries(bytes, { ...options, limit: 100, cursor: first.nextCursor });
  assert.equal(first.entries.length + second.entries.length, 20);
  assert.ok([...first.entries, ...second.entries].every(entry => entry.summary === summary));
  assert.equal(second.nextCursor, null);
});

test('whole-note limits are checked before returning an addition; oversized input is never truncated', () => {
  const once = append(create()), text = once.toString();
  const full = Buffer.from(text + '\n' + Array.from({ length: 6661 }, () => '- Existing manual body node.').join('\n') + '\n');
  assert.equal(validateNote(full, { kind: 'log' }).valid, true);
  const original = Buffer.from(full);
  assert.throws(() => append(full, 2, { summary: '*'.repeat(2048) }), error => error.code === 'LOG_NOTE_INVALID' || error.code === 'LOG_INVALID');
  assert.deepEqual(full, original);
});

test('manual sections, removed markers and summary pipes preserve annual log usability and exact text', () => {
  const initial = append(create()), original = initial.toString();
  const withoutMarker = original.replace(/ <!-- note-log-entry[^\n]+/, '');
  const manual = `${withoutMarker}\n## Personal context\n\nKeep this manually authored section.\n`;
  assert.equal(inspectAnnualLog(manual, options).entryCount, 0);
  const restored = append(manual, 2);
  assert.ok(restored.toString().includes('## Personal context\n\nKeep this manually authored section.'));
  assert.ok(restored.toString().includes(withoutMarker.slice(withoutMarker.indexOf('- 2026-')).trim()));
  assert.equal(queryLogEntries(restored, options).entries.length, 1);
  const withPipes = original.replace('Synthetic topic added', 'Manual summary | with pipes | retained');
  assert.equal(queryLogEntries(withPipes, options).entries[0].summary, 'Manual summary | with pipes | retained');
  assert.deepEqual(appendLogEntry(withPipes, event(), options).bytes, Buffer.from(withPipes));
});

test('invalid annual structures report their annual filename and concrete source line', () => {
  const bad = append(create()).toString().replace('## October 2026', '## Other');
  assert.throws(() => inspectAnnualLog(bad, options), error => error.code === 'LOG_INVALID' && error.file === '2026.md' && error.line > 1 && error.message.includes(`2026.md:${error.line}`));
  const malformed = append(create()).toString().replace(' | created | ', ' | unsupported | ');
  assert.throws(() => inspectLogSeries([{ year: 2026, bytes: malformed }]), error => error.code === 'LOG_ENTRY_INVALID' && error.line > 1 && error.message.includes(`2026.md:${error.line}`));
});
