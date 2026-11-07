import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_LOCATOR_LENGTH, createGeneratedNote } from '../../src/notes/metadata.mjs';
import { DOCTOR_FINDINGS, DOCTOR_SOURCE_VOLUME, inspectNoteHealth, sharedAliases, repeatedIdentities } from '../../src/notes/doctor.mjs';

const options = { id: 'synthetic-note', now: '2026-10-22T01:00:00Z', skillVersion: '0.24.0' };
const body = '# Synthetic topic\n\n## Overview\n<!-- aliases: 123456, synthetic overview -->\nVisible overview.\n\n## Details\n<!-- aliases: 123456 paging -->\nVisible details.\n';
const generated = (metadata = {}, text = body) => createGeneratedNote(text, { ...options, metadata });
const finding = (health, code) => health.findings.find(item => item.code === code);
const codes = health => health.findings.map(item => item.code);
const document = (ref, extra = {}) => ({ type: 'document', ref, ...extra });

test('a clean generated note and a plain note have no findings, with their sections, aliases and sizes measured', () => {
  const clean = inspectNoteHealth(generated({ sources: [document('Supplied synthetic transcript', { locator: '00:48–04:58' })] }));
  assert.deepEqual(clean.findings, []); assert.equal(clean.status, 'supported'); assert.equal(clean.id, options.id);
  assert.equal(clean.sections, 2); assert.equal(clean.aliases.length, 3); assert.deepEqual(clean.sources, { document: 1, session: 0 });
  assert.ok(clean.headerBytes > 0 && clean.headerBytes < clean.bytes);
  assert.equal(clean.aliasBytes, Buffer.byteLength('<!-- aliases: 123456, synthetic overview -->\n<!-- aliases: 123456 paging -->\n'));
  const plain = inspectNoteHealth(body);
  assert.deepEqual(plain.findings, []); assert.equal(plain.status, 'absent'); assert.equal(plain.id, null); assert.equal(plain.headerBytes, 0);
  assert.equal(plain.bytes, Buffer.byteLength(body)); assert.equal(plain.aliasBytes, clean.aliasBytes);
});

test('header findings name what the header carries, how many and how each could be resolved', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const session = { type: 'session', client: 'codex', session_id: 'synthetic-chat', unit_id: 'unit-one', revision: 'b'.repeat(64) };
  const sources = [document('Hashed synthetic file', { source_hash: hash }), document('Stray hash', { hash: 'synthetic' }),
    document('Described source', { description: 'A retained explanation' }), document('/synthetic/private/capture.png'),
    document('Narrated source', { locator: 'x'.repeat(SOURCE_LOCATOR_LENGTH + 1) }), document('Concise source', { locator: 'x'.repeat(SOURCE_LOCATOR_LENGTH) }),
    session, { ...session, unit_id: 'unit-two', raw_ref: 'Synthetic meeting recording' }];
  const health = inspectNoteHealth(generated({ sources, type: 'meeting', context: { project: 'synthetic', topics: ['one'] }, sprint: '21.26',
    series: { id: 'synthetic-series' }, period: { start: '2026-10-01', end: '2026-10-31', timezone: 'UTC' }, generation: { content_hash: hash } }));
  assert.deepEqual(codes(health), ['content-hash', 'source-hash', 'source-session', 'descriptive-field', 'source-field', 'source-local-ref', 'source-long-locator']);
  assert.deepEqual(health.sources, { document: 6, session: 2 });
  for (const item of health.findings) assert.ok(DOCTOR_FINDINGS[item.code], item.code);
  assert.deepEqual(['content-hash', 'source-hash', 'source-session', 'descriptive-field'].map(code => DOCTOR_FINDINGS[code].repair), Array(4).fill('mechanical'));
  assert.deepEqual(['source-field', 'source-local-ref', 'source-long-locator'].map(code => DOCTOR_FINDINGS[code].repair), Array(3).fill('choice'));
  assert.deepEqual(finding(health, 'source-hash').items, [{ index: 0 }, { index: 1 }]); assert.equal(finding(health, 'source-hash').count, 2);
  assert.deepEqual(finding(health, 'source-session').items, [{ index: 6 }, { index: 7, reference: true }]);
  assert.deepEqual(finding(health, 'descriptive-field').items.map(item => item.field), ['type', 'context', 'series', 'sprint', 'period']);
  assert.deepEqual(finding(health, 'source-field').items, [{ index: 2, fields: ['description'] }]);
  assert.deepEqual(finding(health, 'source-local-ref').items, [{ index: 3 }]);
  assert.deepEqual(finding(health, 'source-long-locator').items, [{ index: 4, length: SOURCE_LOCATOR_LENGTH + 1 }]);
  for (const item of health.findings) assert.ok(item.bytes > 0, item.code);
  assert.ok(finding(health, 'source-hash').bytes >= Buffer.byteLength(hash));
});

test('source volume starts above its threshold and an activity log keeps its own descriptive fields', () => {
  const many = count => Array.from({ length: count }, (_, index) => document(`Synthetic source ${index}`));
  assert.equal(finding(inspectNoteHealth(generated({ sources: many(DOCTOR_SOURCE_VOLUME) })), 'source-volume'), undefined);
  const volume = finding(inspectNoteHealth(generated({ sources: many(DOCTOR_SOURCE_VOLUME + 1) })), 'source-volume');
  assert.equal(volume.count, DOCTOR_SOURCE_VOLUME + 1); assert.ok(volume.bytes > 0); assert.equal(DOCTOR_FINDINGS['source-volume'].repair, 'choice');
  const log = inspectNoteHealth(generated({ type: 'log', log_format_version: 1, series: { id: 'synthetic-series' }, period: { start: '2026-01-01', end: '2026-12-31', timezone: 'UTC' } }));
  assert.equal(finding(log, 'descriptive-field'), undefined);
});

test('hidden comments are counted where they are, apart from the header, alias directives, code and attribute text', () => {
  const text = `${body}\n<!-- Evidence: captured earlier -->\n\nVisible <!-- inline remark --> text.\n\n\`<!-- literal -->\`\n\n<span title="<!-- attribute text -->">Visible</span>\n`;
  const comments = finding(inspectNoteHealth(generated({}, text)), 'hidden-comment');
  assert.equal(comments.count, 2); assert.deepEqual(comments.items, [{ line: 14 }, { line: 16 }]);
  assert.equal(comments.bytes, Buffer.byteLength('<!-- Evidence: captured earlier --><!-- inline remark -->'));
  assert.equal(DOCTOR_FINDINGS['hidden-comment'].repair, 'content-update');
  assert.equal(finding(inspectNoteHealth(body), 'hidden-comment'), undefined);
});

test('an alias on several sections of one note counts once per section, and never within one section', () => {
  const repeated = '# Synthetic topic\n\n## Overview\n<!-- aliases: 123456, Synthetic Overview, synthetic-overview -->\nVisible.\n\n## Details\n<!-- aliases: 123456, details -->\nVisible.\n\n## History\n<!-- aliases: 123456 -->\nVisible.\n';
  const health = inspectNoteHealth(repeated), shared = finding(health, 'alias-in-note');
  assert.equal(shared.count, 3); assert.deepEqual(shared.items.map(item => [item.alias, item.heading, item.line]), [['123456', 'Overview', 3], ['123456', 'Details', 7], ['123456', 'History', 11]]);
  assert.equal(health.aliases.length, 5, 'a repeated spelling inside one section is one alias');
  assert.equal(finding(inspectNoteHealth(body), 'alias-in-note'), undefined);
});

test('files the writer cannot interpret are reported as blocked and never analysed further than is safe', () => {
  const malformed = inspectNoteHealth(`<!-- cuefluent\nschema_version: 1\nid: [bad\n-->\n${body}`);
  assert.equal(malformed.status, 'invalid'); assert.deepEqual(codes(malformed), ['metadata-invalid']); assert.equal(malformed.aliasBytes, 0); assert.equal(malformed.id, null);
  const future = inspectNoteHealth(`<!-- cuefluent\nschema_version: 99\nfuture: [one, two]\n-->\n${body}`);
  assert.equal(future.status, 'unsupported'); assert.deepEqual(codes(future), ['metadata-unsupported']); assert.equal(future.sections, 2);
  const binary = inspectNoteHealth(Buffer.from([0x23, 0x20, 0xff, 0xfe]));
  assert.equal(binary.status, 'unreadable'); assert.deepEqual(binary.findings, [{ code: 'note-unreadable', count: 1, bytes: 0, items: [{ reason: 'NOTE_UTF8_INVALID' }] }]);
  const shapeless = inspectNoteHealth('# Only a title\n\nNo section here.\n');
  assert.deepEqual(finding(shapeless, 'note-invalid').items, [{ reason: 'no-answer-sections' }]);
  for (const health of [malformed, future, binary, shapeless]) for (const item of health.findings) assert.equal(DOCTOR_FINDINGS[item.code].repair, 'blocked');
});

test('an alias shared by notes counts every occurrence in every note that has it, and one confined to a single note is not shared', () => {
  const alias = (key, heading, line) => ({ key, alias: key, heading, line });
  const shared = sharedAliases([
    ['a.md', [alias('123456', 'Overview', 3), alias('123456', 'History', 9), alias('only here', 'Overview', 3), alias('only here', 'History', 9)]],
    ['b.md', [alias('123456', 'Summary', 3), alias('billing', 'Summary', 3)]],
    ['c.md', [alias('billing', 'Invoices', 5)]],
    ['d.md', [alias('unshared', 'Other', 3)]],
  ]);
  assert.deepEqual([...shared.keys()].sort(), ['a.md', 'b.md', 'c.md']);
  assert.deepEqual(shared.get('a.md').map(item => [item.alias, item.heading, item.notes]), [['123456', 'Overview', ['b.md']], ['123456', 'History', ['b.md']]]);
  assert.deepEqual(shared.get('b.md').map(item => [item.alias, item.notes]), [['123456', ['a.md']], ['billing', ['c.md']]]);
  assert.deepEqual(shared.get('c.md').map(item => [item.alias, item.notes]), [['billing', ['b.md']]]);
});

test('the other notes of a widely shared alias or identity are named up to a bound and the rest are counted', () => {
  const names = Array.from({ length: 9 }, (_, index) => `note-${index}.md`);
  const shared = sharedAliases(names.map(name => [name, [{ key: 'common', alias: 'Common', heading: 'Overview', line: 3 }]]), 3);
  assert.deepEqual(shared.get('note-0.md'), [{ alias: 'Common', heading: 'Overview', line: 3, notes: ['note-1.md', 'note-2.md', 'note-3.md'], moreNotes: 5 }]);
  assert.deepEqual(shared.get('note-2.md')[0].notes, ['note-0.md', 'note-1.md', 'note-3.md']);
  assert.deepEqual(shared.get('note-8.md')[0], { alias: 'Common', heading: 'Overview', line: 3, notes: ['note-0.md', 'note-1.md', 'note-2.md'], moreNotes: 5 });
  const exact = sharedAliases(names.slice(0, 4).map(name => [name, [{ key: 'common', alias: 'Common', heading: 'Overview', line: 3 }]]), 3);
  assert.deepEqual(exact.get('note-3.md')[0].notes, ['note-0.md', 'note-1.md', 'note-2.md']); assert.equal(Object.hasOwn(exact.get('note-3.md')[0], 'moreNotes'), false);

  const repeated = repeatedIdentities([['a.md', 'one'], ['b.md', 'two'], ['c.md', 'one'], ['d.md', null], ['e.md', null], ['f.md', 'one'], ['g.md', 'three']]);
  assert.deepEqual([...repeated], [['a.md', { notes: ['c.md', 'f.md'] }], ['c.md', { notes: ['a.md', 'f.md'] }], ['f.md', { notes: ['a.md', 'c.md'] }]]);
  assert.deepEqual(repeatedIdentities([['a.md', 'one'], ['c.md', 'one'], ['f.md', 'one']], 1).get('f.md'), { notes: ['a.md'], moreNotes: 1 });
});

test('sections, alias terms and collision counts follow the consumer rule for case, punctuation, accents, width and markup', () => {
  // Expected counts are the ones the Cuefluent app produced for these same notes
  // with its own parser and corpus assembly (audited at 6dbde00ad7c9): its
  // per-document warnings for inNote and its corpus warnings for across.
  const corpus = [
    ['a.md', '# Billing\n\n## Overview\n<!-- aliases: 123456, Billing Overview -->\nVisible.\n\n## History\n<!-- aliases: 123456, billing-overview -->\nVisible.\n', { sections: 2, aliases: 4, inNote: 4, across: 4 }],
    ['b.md', '# Notes\n\n## Summary\n<!-- aliases: 123456, Café Notes, ＡＢＣ -->\nVisible.\n\n## Details\n<!-- aliases: cafe notes -->\nVisible.\n', { sections: 2, aliases: 4, inNote: 2, across: 2 }],
    ['c.md', '# Invoices\n\n## Invoices\n<!-- aliases: billing overview, abc, unique term -->\nVisible.\n', { sections: 1, aliases: 3, inNote: 0, across: 3 }],
    ['d.md', '# Repeats\n\n## Section\n<!-- aliases: x, X, x -->\nVisible.\n\n## Other\n<!-- aliases: lone -->\nVisible.\n', { sections: 2, aliases: 2, inNote: 0, across: 0 }],
    ['e.md', '# Markup\n\n## Section\n<!-- aliases: `code alias`, *emphasis alias* -->\nVisible.\n', { sections: 1, aliases: 2, inNote: 0, across: 2 }],
    ['f.md', '# Plain\n\n## Section\n<!-- aliases: code alias, 123456 paging -->\nVisible.\n', { sections: 1, aliases: 2, inNote: 0, across: 1 }],
    ['g.md', '<!-- cuefluent\n{schema_version: 1, id: synthetic-g, created: "2026-01-01T12:00:00.000Z", updated: "2026-01-01T12:00:00.000Z"}\n-->\n# Header\n\n## Section\n<!-- aliases: Unique Term, emphasis alias -->\nVisible.\n\n## No aliases\nVisible.\n', { sections: 2, aliases: 2, inNote: 0, across: 2 }],
  ];
  const health = corpus.map(([name, text]) => [name, inspectNoteHealth(text)]);
  const shared = sharedAliases(health.map(([name, item]) => [name, item.aliases]));
  for (const [index, [name, item]] of health.entries()) {
    assert.deepEqual({ sections: item.sections, aliases: item.aliases.length, inNote: finding(item, 'alias-in-note')?.count ?? 0, across: shared.get(name)?.length ?? 0 }, corpus[index][2], name);
  }
});
