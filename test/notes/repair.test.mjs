import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { REPAIR_LIMITS, assertRepairScope, constructRepair, createGeneratedNote, describeRepair, inspectMetadata, inspectNoteHealth, serializeRepair, summarizeRepair,
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

// Four entries in one expanded header, each in its own style: block with plain keys, a trailing comment and a
// quoted locator; flow with a single-quoted version; block with double-quoted keys and values; block and plain.
const styled = ['schema_version: 1', `id: ${id}`, 'sources:', '  - type: document', '    ref: /tmp/old.png # pasted', '    locator: "Old: position" # where', `    source_hash: "${sha('b')}"`,
  "  - {type: document, ref: https://x, version: 'v 1'}", '  - "type": "document"', '    "ref": "quoted keys"', '  - type: document', '    ref: kept'];
const replaced = (note, operations) => { const repaired = constructRepair(note, operations); assert.equal(validateNote(repaired.bytes).valid, true); return repaired.bytes; };

test('a replaced source keeps its entry\'s layout: collection style, key order and spelling, and the spelling and comments of its values', () => {
  const descriptors = [{ locator: 'New: position', ref: 'Screenshot pasted into Codex', type: 'document' }, { type: 'document', ref: 'left: right', version: 'v2' }, { type: 'document', ref: 'r2', locator: 'L' }];
  for (const newline of ['\n', '\r\n']) {
    const note = handwritten(styled.join('\n'), body, newline);
    const bytes = replaced(note, descriptors.map((descriptor, index) => ({ op: 'replace-sources', sources: [index], with: descriptor })));
    // Keys stay in the entry's order whatever order the descriptor gave them, a dropped hash leaves no trace, a value
    // that changes is double-quoted and keeps the comment of the one it replaces, a value that stays keeps its own
    // spelling, and a new key is spelled like the entry's first.
    assert.equal(bytes.toString(), handwritten(['schema_version: 1', `id: ${id}`, 'sources:', '  - type: document', '    ref: "Screenshot pasted into Codex" # pasted', '    locator: "New: position" # where',
      '  - {type: document, ref: "left: right", version: "v2"}', '  - "type": "document"', '    "ref": "r2"', '    "locator": "L"', '  - type: document', '    ref: kept'].join('\n'), body, newline).toString());
    assert.deepEqual(value(bytes).sources, [{ type: 'document', ref: 'Screenshot pasted into Codex', locator: 'New: position' }, descriptors[1], descriptors[2], { type: 'document', ref: 'kept' }]);
  }
  // The request's key order plays no part, and a value that stays is not rewritten.
  const note = handwritten(styled.join('\n'));
  const once = replaced(note, [{ op: 'replace-sources', sources: [3], with: { type: 'document', ref: 'kept', locator: 'true' } }]);
  assert.equal(header(once), header(handwritten([...styled, '    locator: "true"'].join('\n'))));
  assert.equal(replaced(note, [{ op: 'replace-sources', sources: [3], with: { locator: 'true', ref: 'kept', type: 'document' } }]).equals(once), true);
  // Strings a YAML 1.1 or 1.2 reader could take for a boolean, a number or a comment read back as given.
  const unsafe = replaced(note, [{ op: 'replace-sources', sources: [3], with: { type: 'document', ref: 'yes', locator: '12:30 #1' } }]);
  assert.equal(header(unsafe), header(handwritten([...styled.slice(0, -1), '    ref: "yes"', '    locator: "12:30 #1"'].join('\n'))));
  assert.deepEqual(value(unsafe).sources[3], { type: 'document', ref: 'yes', locator: '12:30 #1' });
  assert.deepEqual(parseDocument(inspectMetadata(unsafe).raw.split(/\r?\n/).slice(1, -2).join('\n'), { version: '1.1' }).toJS().sources[3], { type: 'document', ref: 'yes', locator: '12:30 #1' });
  // A comment that went with a dropped key would be lost, so the repair is refused; the same descriptor with the key keeps it.
  refused('NOTE_REPAIR_LAYOUT', () => constructRepair(note, [{ op: 'replace-sources', sources: [0], with: { type: 'document', ref: 'no locator' } }]));
  assert.equal(header(replaced(note, [{ op: 'replace-sources', sources: [0], with: { type: 'document', ref: 'no locator', locator: 'kept comment' } }])),
    header(handwritten(['schema_version: 1', `id: ${id}`, 'sources:', '  - type: document', '    ref: "no locator" # pasted', '    locator: "kept comment" # where', ...styled.slice(7)].join('\n'))));
});

test('a merge takes the layout of the earliest selected entry, in an expanded header and in a compact one', () => {
  const note = handwritten(styled.join('\n'));
  assert.equal(header(replaced(note, [{ op: 'replace-sources', sources: [2, 0], with: { type: 'document', ref: 'merged', locator: 'first' } }])),
    header(handwritten(['schema_version: 1', `id: ${id}`, 'sources:', '  - type: document', '    ref: "merged" # pasted', '    locator: "first" # where', styled[7], '  - type: document', '    ref: kept'].join('\n'))));
  assert.equal(header(replaced(note, [{ op: 'replace-sources', sources: [3, 2], with: { type: 'document', ref: 'merged', version: '1' } }])),
    header(handwritten([...styled.slice(0, 8), '  - "type": "document"', '    "ref": "merged"', '    "version": "1"'].join('\n'))));
  const compact = sources => `{schema_version: 1, id: ${id}, sources: [${sources.join(', ')}]}`;
  const flow = handwritten(compact(['{type: document, ref: one, locator: first}', '{type: document, ref: two}', '{"type": "document", "ref": "three"}']));
  assert.equal(header(replaced(flow, [{ op: 'replace-sources', sources: [2, 0], with: { locator: 'primero', ref: 'uno', type: 'document' } }])),
    header(handwritten(compact(['{type: document, ref: "uno", locator: "primero"}', '{type: document, ref: two}']))));
  assert.equal(header(replaced(flow, [{ op: 'replace-sources', sources: [1, 2], with: { type: 'document', ref: 'dos', version: 'v' } }])),
    header(handwritten(compact(['{type: document, ref: one, locator: first}', '{type: document, ref: "dos", version: "v"}']))));
  assert.equal(header(replaced(flow, [{ op: 'replace-sources', sources: [2], with: { type: 'document', ref: 'tres', version: 'v' } }])),
    header(handwritten(compact(['{type: document, ref: one, locator: first}', '{type: document, ref: two}', '{"type": "document", "ref": "tres", "version": "v"}']))));
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

test('an alias is selected as the check identifies it, so every spelling of it at that section goes with it', () => {
  const text = '# Topic\n\n## First\n<!-- aliases: Alpha, beta -->\nOne.\n\n## Second\n<!-- aliases: ALPHA, Álpha, gamma -->\nTwo.\n', note = Buffer.from(text);
  // A section holds an alias once, so the check counts the two sections.
  assert.deepEqual(inspectNoteHealth(note).findings.map(item => [item.code, item.count]), [['alias-in-note', 2]]);
  const removed = constructRepair(note, [{ op: 'remove-alias', line: 7, alias: 'alpha' }]).bytes;
  assert.equal(removed.toString(), text.replace('<!-- aliases: ALPHA, Álpha, gamma -->', '<!-- aliases: gamma -->'));
  assert.deepEqual(inspectNoteHealth(removed).findings, []);
  const replaced = constructRepair(note, [{ op: 'replace-alias', line: 7, alias: 'alpha', with: 'Alpha release' }]).bytes;
  assert.equal(replaced.toString(), text.replace('<!-- aliases: ALPHA, Álpha, gamma -->', '<!-- aliases: Alpha release, gamma -->'));
  // A respelling keeps the identity; a replacement the section already has in another spelling is refused.
  assert.equal(constructRepair(note, [{ op: 'replace-alias', line: 3, alias: 'alpha', with: 'ALPHA' }]).bytes.toString(), text.replace('Alpha, beta', 'ALPHA, beta'));
  refused('REPAIR_OPERATION_INVALID', () => constructRepair(note, [{ op: 'replace-alias', line: 3, alias: 'beta', with: 'álpha' }]));
  assert.deepEqual(describeRepair(note, removed).aliases, [{ line: 7, before: ['ALPHA', 'Álpha', 'gamma'], after: ['gamma'] }]);
});

test('an alias is selected by the text the check reported, which is not parsed as Markdown a second time', () => {
  const text = '# Topic\n\n## First\n<!-- aliases: \\[issue\\](tracker), [issue](tracker), R&amp;amp;D -->\nOne.\n';
  const note = Buffer.from(text), reported = inspectNoteHealth(note).aliases.map(item => item.alias);
  assert.deepEqual(reported, ['[issue](tracker)', 'issue', 'R&amp;D']);
  assert.equal(constructRepair(note, [{ op: 'remove-alias', line: 3, alias: '[issue](tracker)' }]).bytes.toString(), text.replace('\\[issue\\](tracker), ', ''));
  assert.equal(constructRepair(note, [{ op: 'remove-alias', line: 3, alias: 'issue' }]).bytes.toString(), text.replace(', [issue](tracker)', ''));
  assert.equal(constructRepair(note, [{ op: 'remove-alias', line: 3, alias: 'R&amp;D' }]).bytes.toString(), text.replace(', R&amp;amp;D', ''));
  refused('REPAIR_OPERATION_INVALID', () => constructRepair(note, [{ op: 'remove-alias', line: 3, alias: 'R&D' }]));
});

test('a note with carriage-return line endings takes an alias repair and keeps every ending', () => {
  for (const newline of ['\r', '\r\n', '\n']) {
    const note = handwritten(`schema_version: 1\nid: ${id}`, body, newline), expected = body.replace('<!-- aliases: alpha, beta , gamma -->', '<!-- aliases: alpha, gamma -->').replace(/\n/g, newline);
    const repaired = constructRepair(note, [{ op: 'remove-alias', line: 7, alias: 'beta' }]).bytes.toString();
    assert.equal(repaired, note.toString().slice(0, note.toString().indexOf('# Topic')) + expected, JSON.stringify(newline));
    assert.equal(constructRepair(Buffer.from(body.replace(/\n/g, newline)), [{ op: 'remove-alias', line: 7, alias: 'beta' }]).bytes.toString(), body.replace('<!-- aliases: beta -->\n', '').replace(/\n/g, newline));
  }
});

test('operations are a closed, bounded set, and anything else is an argument error', () => {
  const many = Array.from({ length: REPAIR_LIMITS.operations + 1 }, () => ({ op: 'remove-content-hash' }));
  for (const operations of [[], many, 'remove-content-hash', [null], [{ op: 'rewrite' }], [{ op: 'remove-content-hash', extra: 1 }], [{ op: 'remove-fields' }], [{ op: 'remove-fields', fields: [] }],
    [{ op: 'remove-fields', fields: ['id'] }], [{ op: 'remove-fields', fields: ['type', 'type'] }], [{ op: 'remove-sources', sources: [-1] }], [{ op: 'remove-sources', sources: [1, 1] }],
    [{ op: 'remove-sources', sources: [1.5] }], [{ op: 'replace-sources', sources: [0] }], [{ op: 'replace-alias', line: 0, alias: 'a', with: 'b' }],
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

test('an alias directive cannot swallow trailing text, another comment, or a nested opener', () => {
  for (const line of ['<!-- aliases: foo, bar --> <!-- legal hold: keep until Q3 -->',
    '<!-- aliases: alpha --> <img src=x onerror=alert(1)> Pay to account 123 -->',
    '<!-- aliases: Topic <!-- content_hash=hidden -->']) {
    const note = `# Topic\n\n## Section\n${line}\nVisible body.\n`;
    assert.equal(validateNote(note).valid, false, line);
    refused('REPAIR_NOTE_BLOCKED', () => constructRepair(note, [{ op: 'remove-alias', line: 3, alias: 'bar -->' }]));
  }
});

test('source matching preserves later historical sources and describes a replacement that deduplicates a later citation', () => {
  for (const extra of [{ source_hash: sha('b') }, { description: 'Historical details', source_hash: sha('c') }, { locator: 'x'.repeat(300) }]) {
    const old = generated(false, { sources: [{ type: 'document', ref: 'file' }, { type: 'document', ref: 'repo', ...extra }] });
    const candidate = constructRepair(old, [{ op: 'replace-sources', sources: [0], with: { type: 'document', ref: 'repo' } }]).bytes;
    assert.deepEqual(value(candidate).sources, [{ type: 'document', ref: 'repo' }, { type: 'document', ref: 'repo', ...extra }]);
    assert.deepEqual(describeRepair(old, candidate).sources, { removed: [{ index: 0, source: { type: 'document', ref: 'file' } }], added: [{ index: 0, source: { type: 'document', ref: 'repo' } }] });
  }
  const old = generated(false, { sources: ['a', 'b', 'other', 'repo'].map(ref => ({ type: 'document', ref })) });
  const candidate = constructRepair(old, [{ op: 'replace-sources', sources: [0, 1], with: { type: 'document', ref: 'repo' } }]).bytes;
  assert.deepEqual(describeRepair(old, candidate).sources, { removed: [0, 1].map(index => ({ index, source: value(old).sources[index] })) });
});

test('markup-only alias changes appear in the complete change list and summary', () => {
  const old = '# Topic\n\n## Section\n<!-- aliases: *Release plan*, [Roadmap](https://example.test) -->\nBody.\n';
  const candidate = constructRepair(old, [{ op: 'replace-alias', line: 3, alias: 'Release plan', with: 'Release plan' },
    { op: 'replace-alias', line: 3, alias: 'Roadmap', with: 'Roadmap' }]).bytes;
  const changes = describeRepair(old, candidate);
  assert.deepEqual(changes.aliases, [{ line: 3, before: ['Release plan', 'Roadmap'], after: ['Release plan', 'Roadmap'],
    beforeMarkup: ['*Release plan*', '[Roadmap](https://example.test)'], afterMarkup: ['Release plan', 'Roadmap'] }]);
  assert.match(summarizeRepair(changes), /aliases changed/);
});

test('reported aliases longer than replacement bounds or containing whitespace remain selectable', () => {
  for (const alias of ['long '.repeat(80).trim(), 'Alpha\tBeta', 'Alpha\u2028Beta']) {
    const old = `# Topic\n\n## Section\n<!-- aliases: ${alias}, kept -->\nBody.\n`;
    const reported = validateNote(old).sections[0].aliases[0];
    assert.equal(validateNote(old).valid, true);
    const candidate = constructRepair(old, [{ op: 'remove-alias', line: 3, alias: reported }]).bytes.toString();
    assert.equal(candidate, '# Topic\n\n## Section\n<!-- aliases: kept -->\nBody.\n');
  }
});


test('alias selectors name the inspected note, never an alias another operation writes, and name each alias once', () => {
  const single = '# Topic\n\n## Section\n<!-- aliases: alpha -->\nBody.\n', replace = { op: 'replace-alias', line: 3, alias: 'alpha', with: 'beta' };
  for (const operations of [[replace, { op: 'remove-alias', line: 3, alias: 'beta' }], [replace, { op: 'replace-alias', line: 3, alias: 'beta', with: 'gamma' }],
    [replace, { op: 'remove-alias', line: 3, alias: 'Alpha' }]]) refused('REPAIR_OPERATION_INVALID', () => constructRepair(single, operations));
  // Operations on the inspected aliases give one result in any order.
  const pair = '# Topic\n\n## Section\n<!-- aliases: alpha, beta -->\nBody.\n', remove = { op: 'remove-alias', line: 3, alias: 'beta' };
  for (const operations of [[remove, replace], [replace, remove]]) assert.equal(constructRepair(pair, operations).bytes.toString(), '# Topic\n\n## Section\n<!-- aliases: beta -->\nBody.\n');
  refused('REPAIR_OPERATION_INVALID', () => constructRepair(pair, [replace]));
});

test('the scope check finds retained historical sources in order after stripped hashes merge a later duplicate', () => {
  const hashed = { type: 'document', ref: 'Design', description: 'Specification', source_hash: sha('a') }, kept = { type: 'document', ref: 'Design', description: 'Specification' };
  const old = generated(false, { sources: [hashed, session('one'), kept] }), repaired = constructRepair(old, [{ op: 'strip-source-hashes' }]);
  assert.deepEqual(value(repaired.bytes).sources, [kept, session('one')]);
  assert.doesNotThrow(() => assertRepairScope(old, repaired.bytes));
  // Historical sources that change their order are still outside a repair.
  const ordered = generated(false, { sources: [session('one'), session('two')] }), swapped = generated(false, { sources: [session('two'), session('one')] });
  refused('REPAIR_SCOPE_VIOLATION', () => assertRepairScope(ordered, swapped));
});

test('a change list keeps a stored signed zero', () => {
  const old = handwritten(`schema_version: 1\nid: ${id}\nsources:\n  - type: document\n    ref: Measured\n    reading: -0\n  - type: document\n    ref: Kept`);
  const repaired = constructRepair(old, [{ op: 'remove-sources', sources: [0] }]), listed = JSON.parse(serializeRepair(repaired.description));
  assert.deepEqual(listed.sources, { removed: [{ index: 0, source: { type: 'document', ref: 'Measured', reading: -0 } }] });
  assert.ok(Object.is(listed.sources.removed[0].source.reading, -0));
});

test('alias markup remains visible when the same section also changes another alias', () => {
  const old = '# Topic\n\n## Section\n<!-- aliases: *Alpha*, Beta -->\nBody.\n';
  const repaired = constructRepair(old, [{ op: 'replace-alias', line: 3, alias: 'Alpha', with: 'Alpha' }, { op: 'replace-alias', line: 3, alias: 'Beta', with: 'Gamma' }]);
  assert.deepEqual(repaired.description.aliases, [{ line: 3, before: ['Alpha', 'Beta'], after: ['Alpha', 'Gamma'], beforeMarkup: ['*Alpha*', 'Beta'], afterMarkup: ['Alpha', 'Gamma'] }]);
});

test('an earlier replacement can deduplicate a later citation without displacing retained historical-only sources', () => {
  for (const legacy of [{ type: 'document', ref: 'Historical', description: 'Retained details' }, session('one', { raw_ref: 'Retained capture reference' })]) {
    const old = generated(false, { sources: [{ type: 'document', ref: 'file' }, legacy, { type: 'document', ref: 'repo' }] });
    const repaired = constructRepair(old, [{ op: 'replace-sources', sources: [0], with: { type: 'document', ref: 'repo' } }]);
    assert.deepEqual(value(repaired.bytes).sources, [{ type: 'document', ref: 'repo' }, legacy]);
    assert.deepEqual(repaired.description.sources, { removed: [{ index: 0, source: { type: 'document', ref: 'file' } }] });
  }
});
