import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { REPAIR_LIMITS, assertRepairScope, constructRepair, createGeneratedNote, describeRepair, inspectMetadata, serializeRepair, summarizeRepair,
  validateNote, validateRepairOperations } from '../../src/notes/index.mjs';

const sha = character => `sha256:${character.repeat(64)}`;
const id = '9dd25a37-780e-4490-9738-40c601c5b6f5';
const body = '# Topic\n\n## Overview\n<!-- aliases: alpha, beta , gamma -->\nVisible overview.\n\n## Second\n<!-- aliases: beta -->\nMore text.  \n\n<!-- Evidence: kept -->\n';
const session = (unit, extra = {}) => ({ type: 'session', client: 'claude', session_id: 'session-1', unit_id: unit, revision: 'd'.repeat(64), ...extra });
const metadata = { type: 'meeting', context: { project: 'demo' }, custom: { keep: 'me' }, generation: { content_hash: sha('a'), tool: 'other' }, sources: [
  { type: 'document', ref: 'repository', source_hash: sha('b') }, { type: 'document', ref: 'repository', source_hash: sha('c') },
  session('unit-1'), session('unit-2', { raw_ref: 'A meaningful reference' }), { type: 'document', ref: '/Users/someone/file.md', locator: 'Line 1' }] };
const generated = (expandedMetadata, value = metadata, text = body) => createGeneratedNote(text, { id, now: '2026-10-22T01:00:00Z', skillVersion: '0.19.0', metadata: value, expandedMetadata });
const header = note => { const inspected = inspectMetadata(note); return note.toString().slice(0, inspected.end); };
const value = note => inspectMetadata(note).value;
/** Whether the header's root mapping and its source list are written in flow style. */
const layout = note => { const root = parseDocument(inspectMetadata(note).raw.split(/\r?\n/).slice(1, -2).join('\n')).contents; return [root.flow === true, root.get('sources', true).flow === true]; };
const refused = (code, work) => assert.throws(work, error => error.code === code, `expected ${code}`);
const mechanical = [{ op: 'remove-content-hash' }, { op: 'strip-source-hashes' }, { op: 'remove-session-sources' }, { op: 'remove-fields', fields: ['type', 'period'] }];
/** A note whose header is written by hand, so that its layout is the test's own. */
const handwritten = (payload, text = body, newline = '\n') => Buffer.from(`<!-- cuefluent\n${payload}\n-->\n${text}`.replace(/\n/g, newline));

test('mechanical operations remove what they name in either layout, keep identity and times, and change no other byte', () => {
  for (const expanded of [false, true]) {
    const note = generated(expanded), repaired = constructRepair(note, mechanical), before = value(note), after = value(repaired.bytes);
    assert.equal(repaired.changed, true); assert.equal(validateNote(repaired.bytes).valid, true);
    assert.deepEqual(after, { context: before.context, custom: before.custom, generation: { skill_version: '0.19.0', tool: 'other' },
      sources: [{ type: 'document', ref: 'repository' }, before.sources[3], before.sources[4]], schema_version: 1, id, created: before.created, updated: before.updated });
    assert.equal(repaired.bytes.toString().slice(inspectMetadata(repaired.bytes).end), body);
    // The layout is the note's own: a compact header stays in flow style and an expanded one in blocks.
    assert.deepEqual(layout(repaired.bytes), expanded ? [false, false] : [true, true]); assert.deepEqual(layout(repaired.bytes), layout(note));
    assert.equal(constructRepair(repaired.bytes, mechanical).changed, false);
    assert.equal(constructRepair(repaired.bytes, mechanical).bytes.equals(repaired.bytes), true);
  }
});

test('a hand-written header keeps its key order, collection styles, scalar styles, comments and line endings', () => {
  const payload = ['schema_version: 1', `id: ${id}`, 'created: "2026-01-01T12:00:00.000Z"', "updated: '2026-01-02T12:00:00.000Z'", '# a comment that stays',
    `generation: {skill_version: 0.19.0, content_hash: "${sha('a')}"}`, 'sources:', `  - {type: document, ref: "a b", source_hash: "${sha('b')}"}`, '  - type: document', '    ref: plain reference',
    'count: 1.50', 'custom: {keep: me}'].join('\n');
  const expected = ['schema_version: 1', `id: ${id}`, 'created: "2026-01-01T12:00:00.000Z"', "updated: '2026-01-02T12:00:00.000Z'", '# a comment that stays',
    'generation: {skill_version: 0.19.0}', 'sources:', '  - {type: document, ref: "a b"}', '  - type: document', '    ref: plain reference', 'count: 1.50', 'custom: {keep: me}'].join('\n');
  for (const newline of ['\n', '\r\n']) {
    const note = handwritten(payload, body, newline), repaired = constructRepair(note, mechanical);
    assert.equal(repaired.bytes.toString(), handwritten(expected, body, newline).toString());
  }
  // An indented wrapper and a note that opens with a blank line keep both.
  const indented = Buffer.from(`\n  <!-- cuefluent\n${payload}\n  -->  \n${body}`), repaired = constructRepair(indented, mechanical).bytes.toString();
  assert.equal(repaired, `\n  <!-- cuefluent\n${expected}\n  -->  \n${body}`);
});

test('a repair that would drop a YAML comment or cannot be read back is refused instead of rewritten another way', () => {
  const payload = ['schema_version: 1', `id: ${id}`, 'sources:', '  - {type: document, ref: kept}', '  # why this source matters', `  - {type: session, client: claude, session_id: s, unit_id: u, revision: "${'d'.repeat(64)}"}`].join('\n');
  refused('NOTE_REPAIR_LAYOUT', () => constructRepair(handwritten(payload), [{ op: 'remove-session-sources' }]));
  assert.equal(constructRepair(handwritten(payload), [{ op: 'remove-content-hash' }]).changed, false);
});

test('stripped hashes collapse exact duplicates, and sources that then differ only in detail wait for a selection', () => {
  const sources = [{ type: 'document', ref: 'one', source_hash: sha('a') }, { type: 'document', ref: 'one', source_hash: sha('b'), description: 'Second reading' }, { type: 'document', ref: 'two', hash: 'x' }];
  const note = generated(false, { sources });
  refused('REPAIR_SOURCE_CONFLICT', () => constructRepair(note, [{ op: 'strip-source-hashes' }]));
  assert.deepEqual(value(constructRepair(note, [{ op: 'strip-source-hashes' }, { op: 'remove-sources', sources: [1] }]).bytes).sources, [{ type: 'document', ref: 'one' }, { type: 'document', ref: 'two' }]);
  assert.deepEqual(value(constructRepair(note, [{ op: 'strip-source-hashes' }, { op: 'remove-sources', sources: [0] }]).bytes).sources, [{ type: 'document', ref: 'one', description: 'Second reading' }, { type: 'document', ref: 'two' }]);
});

test('selected sources are removed or replaced by a descriptor that a new note could be given', () => {
  const note = generated(true), descriptor = { type: 'document', ref: 'Design notes', locator: 'Line 1' };
  const replaced = constructRepair(note, [{ op: 'replace-sources', sources: [4, 1], with: descriptor }, { op: 'remove-sources', sources: [3] }]).bytes;
  assert.deepEqual(value(replaced).sources, [metadata.sources[0], descriptor, metadata.sources[2]]);
  // A replacement the note already cites collapses onto it, and a note left without sources has no sources field.
  assert.deepEqual(value(constructRepair(note, [{ op: 'strip-source-hashes' }, { op: 'replace-sources', sources: [4], with: { type: 'document', ref: 'repository' } }]).bytes).sources.length, 3);
  assert.equal(Object.hasOwn(value(constructRepair(note, [{ op: 'remove-sources', sources: [0, 1, 2, 3, 4] }]).bytes), 'sources'), false);
  for (const [code, replacement] of [['NOTE_SOURCE_REFERENCE', { type: 'document', ref: '/tmp/file.md' }], ['NOTE_SOURCE_FIELD', { type: 'document', ref: 'x', source_hash: sha('a') }],
    ['NOTE_SOURCE_LOCATOR', { type: 'document', ref: 'x', locator: 'l'.repeat(121) }], ['NOTE_SOURCE_ARGUMENT', { type: 'session', ref: 'x' }]]) {
    refused(code, () => constructRepair(note, [{ op: 'replace-sources', sources: [4], with: replacement }]));
  }
  refused('REPAIR_OPERATION_INVALID', () => constructRepair(note, [{ op: 'remove-sources', sources: [5] }]));
  refused('REPAIR_OPERATION_INVALID', () => constructRepair(note, [{ op: 'remove-sources', sources: [1] }, { op: 'replace-sources', sources: [1, 2], with: descriptor }]));
  refused('REPAIR_OPERATION_INVALID', () => constructRepair(Buffer.from(body), [{ op: 'remove-sources', sources: [0] }]));
});

test('aliases change only at their section, and the rest of the body and an untouched header keep every byte', () => {
  const note = generated(false), lines = header(note).split('\n').length - 1, first = lines + 3, second = lines + 7;
  const repaired = constructRepair(note, [{ op: 'remove-alias', line: first, alias: 'beta' }, { op: 'replace-alias', line: first, alias: 'gamma', with: 'gamma ray' }, { op: 'remove-alias', line: second, alias: 'beta' }]).bytes.toString();
  assert.equal(repaired, header(note) + body.replace('<!-- aliases: alpha, beta , gamma -->', '<!-- aliases: alpha, gamma ray -->').replace('<!-- aliases: beta -->\n', ''));
  assert.equal(constructRepair(note, [{ op: 'remove-alias', line: first, alias: 'alpha' }]).bytes.toString().includes('<!-- aliases: beta , gamma -->'), true);
  // A plain note has aliases too, and a header the repair cannot interpret is left exactly as it is.
  assert.equal(constructRepair(Buffer.from(body), [{ op: 'remove-alias', line: 3, alias: 'gamma' }]).bytes.toString(), body.replace('alpha, beta , gamma', 'alpha, beta'));
  const future = handwritten(`schema_version: 2\nid: ${id}`);
  assert.equal(constructRepair(future, [{ op: 'remove-alias', line: 11, alias: 'beta' }]).bytes.toString(), future.toString().replace('<!-- aliases: beta -->\n', ''));
  for (const operation of [{ op: 'remove-alias', line: first, alias: 'delta' }, { op: 'remove-alias', line: first + 1, alias: 'alpha' }, { op: 'remove-alias', line: lines + 1, alias: 'alpha' },
    { op: 'replace-alias', line: first, alias: 'alpha', with: 'Beta' }]) refused('REPAIR_OPERATION_INVALID', () => constructRepair(note, [operation]));
});

test('operations are a closed, bounded set, and anything else is an argument error', () => {
  const many = Array.from({ length: REPAIR_LIMITS.operations + 1 }, () => ({ op: 'remove-content-hash' }));
  for (const operations of [[], many, 'remove-content-hash', [null], [{ op: 'rewrite' }], [{ op: 'remove-content-hash', extra: 1 }], [{ op: 'remove-fields' }], [{ op: 'remove-fields', fields: [] }],
    [{ op: 'remove-fields', fields: ['id'] }], [{ op: 'remove-fields', fields: ['type', 'type'] }], [{ op: 'remove-sources', sources: [-1] }], [{ op: 'remove-sources', sources: [1, 1] }],
    [{ op: 'remove-sources', sources: [1.5] }], [{ op: 'replace-sources', sources: [0] }], [{ op: 'replace-alias', line: 0, alias: 'a', with: 'b' }], [{ op: 'replace-alias', line: 3, alias: 'a', with: 'a' }],
    [{ op: 'replace-alias', line: 3, alias: 'a', with: 'b, c' }], [{ op: 'replace-alias', line: 3, alias: 'a', with: 'b -->' }], [{ op: 'replace-alias', line: 3, alias: 'a', with: '*b*' }],
    [{ op: 'replace-alias', line: 3, alias: 'a', with: ' b' }], [{ op: 'replace-alias', line: 3, alias: 'a', with: '...' }], [{ op: 'remove-alias', line: 3, alias: 'a\nb' }], [{ op: 'remove-alias', line: 3 }]]) {
    refused('REPAIR_ARGUMENT', () => validateRepairOperations(operations));
  }
  const checked = validateRepairOperations([{ with: { ref: 'x', type: 'document' }, sources: [2], op: 'replace-sources' }]);
  assert.equal(JSON.stringify(checked), '[{"op":"replace-sources","sources":[2],"with":{"ref":"x","type":"document"}}]');
});

test('a note that cannot be interpreted is blocked, and a plain note answers a mechanical request unchanged', () => {
  const plain = Buffer.from(body), unsupported = handwritten(`schema_version: 2\nid: ${id}`);
  assert.equal(constructRepair(plain, mechanical).changed, false);
  for (const note of [Buffer.from('# Only a topic\n'), handwritten('schema_version: 1\nid: [broken'), unsupported, handwritten(`schema_version: 1\nid: ${id}\ntype: log`), Buffer.from([0xff, 0xfe])]) {
    assert.throws(() => constructRepair(note, mechanical), error => ['REPAIR_NOTE_BLOCKED', 'NOTE_UTF8_INVALID'].includes(error.code));
  }
});

test('the scope check accepts a repair and refuses every other difference between two versions', () => {
  const note = generated(false), text = note.toString(), repaired = constructRepair(note, mechanical).bytes;
  assert.doesNotThrow(() => assertRepairScope(note, repaired));
  const candidates = {
    'body text': text.replace('Visible overview.', 'Visible overview!'),
    'body whitespace': text.replace('More text.  \n', 'More text.\n'),
    'another comment': text.replace('<!-- Evidence: kept -->', '<!-- Evidence: changed -->'),
    'moved alias comment': text.replace('<!-- aliases: beta -->\n', '').replace('More text.  \n', 'More text.  \n<!-- aliases: beta -->\n'),
    'added alias comment': Buffer.from(body.replace('<!-- aliases: beta -->\n', '')).toString().replace('## Second\n', '## Second\n<!-- aliases: new -->\n'),
    'update time': text.replace('updated: "2026-10-22T01:00:00Z"', 'updated: "2026-10-23T01:00:00Z"'),
    'identity': text.replace(id, id.replace('9', '8')),
    'unselected field': text.replace('keep: me', 'keep: you'),
    'writer version': text.replace('skill_version: 0.19.0', 'skill_version: 0.24.0'),
    'added field': text.replace('schema_version: 1', 'schema_version: 1, sprint: later'),
    'source with other fields': text.replace('"ref": "/Users/someone/file.md"', '"ref": "portable", "description": "invented"'),
    'reordered sources': text.replace(`{"type": "document", "ref": "repository", "source_hash": "${sha('b')}"}, {"type": "document", "ref": "repository", "source_hash": "${sha('c')}"}`,
      `{"type": "document", "ref": "repository", "source_hash": "${sha('c')}"}, {"type": "document", "ref": "repository", "source_hash": "${sha('b')}"}`),
  };
  for (const [name, candidate] of Object.entries(candidates)) {
    const original = name === 'added alias comment' ? Buffer.from(body.replace('<!-- aliases: beta -->\n', '')) : note;
    assert.notEqual(candidate, original.toString(), name);
    assert.throws(() => assertRepairScope(original, candidate), error => error.code === 'REPAIR_SCOPE_VIOLATION', name);
  }
});

test('the change list names every difference with both values, and its summary is one bounded line', () => {
  const note = generated(false), lines = header(note).split('\n').length - 1;
  const repaired = constructRepair(note, [...mechanical, { op: 'replace-sources', sources: [4], with: { type: 'document', ref: 'Design notes' } }, { op: 'remove-alias', line: lines + 7, alias: 'beta' }]).bytes;
  const description = describeRepair(note, repaired);
  assert.deepEqual(description, { bytes: { before: note.length, after: repaired.length },
    header: [{ field: 'type', before: 'meeting', after: null }, { field: 'generation.content_hash', before: sha('a'), after: null }],
    sources: { removed: [{ index: 1, source: metadata.sources[1] }, { index: 2, source: metadata.sources[2] }, { index: 4, source: metadata.sources[4] }],
      stripped: [{ index: 0, fields: { source_hash: sha('b') } }], added: [{ index: 2, source: { type: 'document', ref: 'Design notes' } }] },
    aliases: [{ line: lines + 7, before: ['beta'], after: [] }] });
  assert.deepEqual(JSON.parse(serializeRepair(description)), description);
  const summary = summarizeRepair(description);
  assert.match(summary, /^Metadata repair: type, generation\.content_hash removed; hashes removed from 1 source; 3 sources removed; 1 source supplied; aliases changed in 1 section \(\d+ to \d+ bytes\)\.$/);
  assert.equal(summary.length <= 1024 && !/[\r\n]/.test(summary), true);
  // Nothing that stayed is listed, and an alias-only repair says nothing of the header.
  assert.deepEqual(Object.keys(describeRepair(note, constructRepair(note, [{ op: 'remove-alias', line: lines + 3, alias: 'alpha' }]).bytes)), ['bytes', 'aliases']);
});
