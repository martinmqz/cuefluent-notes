import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { prepareNote, assertNoteTransition, assertProcessingNoteSources } from './note-generation.mjs';
import { inspectNoteMetadata } from './note-metadata.mjs';
import { digest } from './workflow-values.mjs';

const body = '\uFEFF\r\n# Synthetic\r\n\r\n## Decision\r\n\r\nKeep the human correction.\r\n';
const now = '2026-10-01T07:42:00-07:00';
const prepare = request => prepareNote({ original: null, content: body, now, skillVersion: '0.9.0', ...request });
const parsed = content => inspectNoteMetadata(content);
const without = content => { const { block } = parsed(content); return content.slice(0, block.start) + content.slice(block.end); };
const document = { type: 'document', ref: 'selected/design.md', locator: 'Decision 1' };

test('new generated proposals retain visible bytes and receive independent stable IDs, timestamps and optional body hash', () => {
  const first = prepare({ metadata: { sources: [document] }, contentHash: true });
  const second = prepare({});
  const value = parsed(first.content).value;
  assert.match(value.id, /^note_[a-f0-9-]{36}$/); assert.notEqual(value.id, parsed(second.content).value.id);
  assert.equal(value.created, now); assert.equal(value.updated, now);
  assert.match(first.content, /created: "2026-10-01T07:42:00-07:00"/);
  assert.match(first.content, /updated: "2026-10-01T07:42:00-07:00"/);
  assert.equal(value.generation.content_hash, `sha256:${digest(body)}`);
  assert.equal(without(first.content), body); assert.deepEqual(value.sources, [document]);
  assert.equal(first.changed, true);
});

test('leading content indentation cannot make generated metadata render as code', () => {
  for (const content of ['    indented code\n\n# Note\n\n## Decision\n\nVisible text.\n', '\uFEFF\tindented code\n']) {
    const prepared = prepare({ content });
    assert.equal(prepared.metadataStatus, 'valid');
    assert.equal(without(prepared.content), content);
  }
});

test('series creation generates an independent ID only on explicit request and preserves it on reuse', () => {
  const first = prepare({ createSeries: true, metadata: { series: { label: 'Synthetic standups' } } });
  const series = parsed(first.content).value.series;
  assert.match(series.id, /^series_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(series.label, 'Synthetic standups');
  assert.notEqual(parsed(prepare({ createSeries: true }).content).value.series.id, series.id);
  assert.deepEqual(parsed(prepare({ metadata: { series } }).content).value.series, series);
  assert.equal(prepare({ original: first.content, content: first.content, createSeries: false }).content, first.content);
  assert.throws(() => prepare({ metadata: { series: { label: series.label } } }), { code: 'NOTE_METADATA_INVALID' });
  for (const original of [null, first.content]) assert.throws(() => prepare({ original, content: original ?? body,
    createSeries: true, metadata: { series } }), { code: 'NOTE_METADATA_SERIES_CONFLICT' });
  assert.throws(() => prepare({ original: first.content, content: first.content, createSeries: true }), { code: 'NOTE_METADATA_SERIES_CONFLICT' });
  assert.throws(() => prepare({ createSeries: 'true' }), { code: 'NOTE_METADATA_INVALID' });
});

test('creating a series respects plain-note enrichment and opaque metadata boundaries', () => {
  assert.throws(() => prepare({ original: body, createSeries: true }), { code: 'NOTE_METADATA_ENRICHMENT_REQUIRED' });
  const enriched = parsed(prepare({ original: body, enrich: true, createSeries: true }).content).value;
  assert(enriched.series.id); assert.equal(enriched.created, undefined);
  const original = prepare({}).content;
  const joined = parsed(prepare({ original, content: original, createSeries: true }).content).value;
  assert(joined.series.id); assert.equal(joined.id, parsed(original).value.id);
  const future = '<!-- cuefluent\nschema_version: 2\n-->\n# Note\n';
  assert.throws(() => prepare({ original: future, content: future, createSeries: true }), { code: 'NOTE_METADATA_OPAQUE_CHANGED' });
  assert.equal(prepare({ original: future, content: future, createSeries: false }).content, future);
});

test('generated period dates stay strings in both YAML versions while existing unquoted dates remain supported', () => {
  const period = { start: '2026-10-05', end: '2026-10-16', timezone: 'America/Los_Angeles' };
  const generated = prepare({ metadata: { period } }).content;
  for (const version of ['1.1', '1.2']) {
    const raw = parsed(generated).block.raw;
    const value = parse(raw.slice(raw.indexOf('\n') + 1, raw.lastIndexOf('-->')), { version });
    assert.deepEqual(value.period, period);
  }
  const original = generated.replace('start: "2026-10-05"', 'start: 2026-10-05').replace('end: "2026-10-16"', 'end: 2026-10-16');
  assert.equal(prepare({ original, content: original }).content, original);
  assert.deepEqual(parsed(prepare({ original, content: original + '\r\nCorrection.' }).content).value.period, period);
});

test('generation preserves CR, LF and CRLF bodies and refuses frontmatter before enrichment', () => {
  for (const newline of ['\r', '\n', '\r\n']) {
    const content = '\uFEFF' + newline + '# Note\n\n## Work\n\nEvidence.\n'.replaceAll('\n', newline);
    const generated = prepare({ content }).content;
    assert(generated.startsWith('\uFEFF' + newline + '<!-- cuefluent' + newline));
    assert(generated.match(/\r\n|\r|\n/g).every(value => value === newline));
    assert.equal(without(generated), content);
    const original = generated;
    assert.equal(prepare({ original, content: original }).content, original);
    const updated = prepare({ original, content: without(original) + newline + 'Addition.', now: '2026-10-02T12:00:00Z' }).content;
    assert.equal(without(updated), without(original) + newline + 'Addition.');
    assert(updated.match(/\r\n|\r|\n/g).every(value => value === newline));
    const frontmatter = '\uFEFF' + newline + '---\ntitle: Existing\n---\n'.replaceAll('\n', newline) + content.slice(1);
    assert.throws(() => prepare({ original: frontmatter, content: frontmatter, enrich: true }), /NOTE_FRONTMATTER_CONFLICT/);
  }
});

test('a meaningful no-op returns exact original formatting without changing timestamps or generator version', () => {
  const first = prepare({ contentHash: true });
  const original = first.content.replace('schema_version: 1', 'schema_version: 1 # retained on no-op');
  for (const content of [original, without(original)]) {
    const next = prepare({ original, content, now: '2026-10-02T12:00:00Z', skillVersion: '0.10.0' });
    assert.equal(next.content, original); assert.equal(next.changed, false);
  }
});

test('updates preserve identity, creation, human content, prior sources and unknown nested fields', () => {
  const first = prepare({ metadata: { sources: [document], context: { project: 'synthetic' }, series: { id: 'series_synthetic' } }, contentHash: true });
  const original = first.content.replace('context:\r\n', 'extension: {flag: true}\r\ncontext:\r\n  custom: [one, two]\r\n');
  const content = without(original) + '\r\nNew evidence, with the original correction retained.\r\n';
  const next = prepare({ original, content, now: '2026-10-02T12:00:00Z', metadata: { context: { topics: ['progress'] }, sources: [document, { type: 'document', ref: 'selected/second.md' }] } });
  const previous = parsed(original).value, value = parsed(next.content).value;
  assert.equal(value.id, previous.id); assert.equal(value.created, previous.created);
  assert.equal(value.updated, '2026-10-02T12:00:00Z');
  assert.deepEqual(value.extension, previous.extension); assert.deepEqual(value.context.custom, ['one', 'two']);
  assert.equal(value.sources.length, 2); assert.equal(without(next.content), content);
  assert.equal(value.generation.content_hash, `sha256:${digest(content)}`);
  assert.throws(() => prepare({ original: next.content, content: content + 'Later', now }), /TIME_REVERSED/);
});

test('plain notes require explicit enrichment and do not acquire invented creation dates', () => {
  assert.deepEqual(prepare({ original: body, content: body }), { content: body, changed: false, metadataStatus: 'absent' });
  assert.throws(() => prepare({ original: body, metadata: { type: 'meeting' } }), /ENRICHMENT_REQUIRED/);
  const enriched = prepare({ original: body, enrich: true, metadata: { type: 'meeting' } });
  assert.equal(parsed(enriched.content).value.created, undefined);
  assert.throws(() => assertNoteTransition(enriched.content,
    enriched.content.replace('schema_version: 1', 'schema_version: 1\ncreated: "2001-01-01T00:00:00Z"')), { code: 'NOTE_METADATA_IDENTITY_CHANGED' });
  assert.equal(without(enriched.content), body);
  assert.throws(() => prepare({ content: '---\ntitle: selected\n---\n' + body }), /FRONTMATTER_CONFLICT/);
});

test('metadata inputs reject comment injection before serialization and preserve allowed multiline extensions', () => {
  for (const field of ['type', 'sprint']) for (const delimiter of ['-->', '--!>', '<!--']) {
    assert.throws(() => prepare({ metadata: { [field]: `x\n${delimiter}\n# Injected` } }), { code: 'NOTE_METADATA_INVALID' });
  }
  for (const field of ['type', 'sprint']) assert.throws(() => prepare({ metadata: { [field]: 'x\nVisible' } }), { code: 'NOTE_METADATA_INVALID' });
  const original = '<!-- cuefluent\nschema_version: 1\nid: extension\nunknown: |\n  First line\n  Second line\n-->\n\n# Note\n';
  const updated = prepare({ original, content: original + '\nNew body.' });
  assert.equal(parsed(updated.content).value.unknown, parsed(original).value.unknown);
  assert.equal(without(updated.content), without(original) + '\nNew body.');
});

test('malformed metadata inputs have a bounded error for new, plain and future-schema notes', () => {
  const future = '<!-- cuefluent\nschema_version: 2\n-->\n# Note\n';
  const cycle = {}; cycle.self = cycle;
  for (const original of [null, body, future]) {
    for (const metadata of [5, '', [], true, null, NaN, Infinity, new Date(), new (class Metadata {})(),
      { context: { topics: new Array(2) } }, { sprint: NaN }, cycle,
      Object.defineProperty({}, 'sprint', { enumerable: true, get() { throw new Error('must not run'); } })]) {
      assert.throws(() => prepare({ original, content: original ?? body, metadata }), { code: 'NOTE_METADATA_INVALID' });
    }
  }
});

test('malformed source descriptors fail consistently before deduplication', () => {
  const existing = prepare({ metadata: { sources: [document] } }).content;
  for (const original of [null, existing]) for (const source of [null, {}, { type: 'session' }, { type: 'document' },
    { ...document, source_hash: 'not-a-hash' }, { type: 'other', ref: 'selected/doc.md' }]) {
    assert.throws(() => prepare({ original, content: original ?? body, metadata: { sources: [source] } }), { code: 'NOTE_METADATA_INVALID' });
  }
  const next = prepare({ original: existing, content: existing, metadata: { sources: [document] } });
  assert.equal(next.changed, false);
});

test('frontmatter variants stay intact when creation or enrichment is refused', () => {
  for (const newline of ['\r', '\n', '\r\n']) for (const delimiter of ['---', '+++']) for (const suffix of ['', ' ', '\t']) {
    const content = delimiter + suffix + newline + 'title: x' + newline + delimiter + newline + '# Note';
    for (const original of [null, content]) assert.throws(() => prepare({ original, content, enrich: true }), { code: 'NOTE_FRONTMATTER_CONFLICT' });
    assert.equal(prepare({ original: content, content }).content, content);
  }
});

test('regeneration keeps the metadata position and blanks on their original side of the block', () => {
  for (const newline of ['\r', '\n', '\r\n']) for (const prefix of ['', '\uFEFF', '\uFEFF' + newline + newline]) {
    const original = prefix + '<!-- cuefluent\nschema_version: 1\nid: position\n-->\n\n# Note\n'.replaceAll('\n', newline);
    for (const content of [original, without(original)]) {
      const updated = prepare({ original, content: content + newline + 'Addition.' }).content;
      assert.equal(parsed(updated).block.start, parsed(original).block.start);
      assert.equal(updated.slice(0, parsed(updated).block.start), prefix);
      assert(updated.slice(parsed(updated).block.end).startsWith(newline + '# Note'));
      assert.equal(without(updated), without(original) + newline + 'Addition.');
    }
  }
});

test('malformed metadata is refused and future schemas permit only identical opaque blocks', () => {
  const future = '<!-- cuefluent\nschema_version: 2\nfuture: [keep, exactly]\n-->\n' + body.replace('\uFEFF', '');
  assert.equal(prepare({ original: future, content: future + '\nAddition.' }).content, future + '\nAddition.');
  for (const content of [body, future.replace('exactly', 'changed')]) assert.throws(() => prepare({ original: future, content }), /OPAQUE_CHANGED/);
  assert.throws(() => prepare({ original: future, content: future, metadata: { type: 'meeting' } }), /OPAQUE_CHANGED/);
  assert.throws(() => prepare({ original: future.replace('schema_version: 2', 'schema_version: 1'), content: body }), /METADATA_INVALID/);
});

test('transition validation rejects identity loss, source loss, unknown field loss and timestamp reversal', () => {
  const original = prepare({ metadata: { sources: [document], series: { id: 'series_same' } } }).content.replace('schema_version: 1', 'extension: {keep: true}\nschema_version: 1');
  for (const content of [body, original.replace(/id: note_[^\n]+/, 'id: replacement'), original.replace('series_same', 'other_series'),
    original.replace('extension: {keep: true}\n', ''), original.replace('created: "2026-10-01', 'created: "2026-09-30'),
    original.replace('updated: "2026-10-01', 'updated: "2026-09-30'), original.replace('selected/design.md', 'selected/different.md')]) {
    assert.throws(() => assertNoteTransition(original, content));
  }
});

test('unknown numeric values cannot silently round during metadata replacement', () => {
  for (const number of ['12345678901234567890', '1.234567890123456789', '1e-400', '0x20000000000001']) {
    const original = `<!-- cuefluent\nschema_version: 1\nid: numeric\nextension: {number: ${number}}\n-->\n` + body.replace('\uFEFF', '');
    assert.throws(() => prepare({ original, content: original }), /NOTE_METADATA_INVALID/);
    assert.throws(() => assertNoteTransition(original, original + '\nVisible addition.\n'), /NOTE_METADATA_INVALID/);
    assert.throws(() => prepare({ original, content: original + '\nAddition.\n' }), /NOTE_METADATA_INVALID/);
    assert.throws(() => assertNoteTransition(original, original.replace('extension:', 'other:')), /NOTE_METADATA_INVALID/);
  }
  for (const number of ['0.1', '1e20', '0xff', '0o10', '-0.0', '1.5000', '2.5e-200']) {
    const original = `<!-- cuefluent\nschema_version: 1\nid: numeric\nx: ${number}\n-->\n` + body.replace('\uFEFF', '');
    assert.equal(prepare({ original, content: original + '\nAddition.\n' }).metadataStatus, 'valid');
  }
});

test('transition checks retain the writer UTF-8 body contract, including NUL characters', () => {
  const content = body + '\u0000\n';
  assert.doesNotThrow(() => assertNoteTransition(content, content + 'Addition.'));
  assert.equal(prepare({ original: content, content }).content, content);
  assert.throws(() => prepare({ content: body + '\uD800' }), /NOTE_CONTENT_LIMIT/);
});

test('a replacement cannot disguise a changed unknown number behind identical rounded values', () => {
  for (const [from, to] of [['9007199254740992', '9007199254740993'], ['1.2345678901234567', '1.23456789012345671']]) {
    const original = `<!-- cuefluent\nschema_version: 1\nid: numeric\nunknown: ${from}\n-->\n` + body.replace('\uFEFF', '');
    assert.throws(() => assertNoteTransition(original, original.replace(from, to)), /NOTE_METADATA_INVALID/);
  }
});

test('untrusted metadata additions have bounded types and cannot override managed fields or inject delimiters', () => {
  const cyclic = {}; cyclic.loop = cyclic;
  for (const metadata of [null, { id: 'override' }, { context: { unexpected: true } }, { sources: [null] },
    { type: 'meeting', sprint: '<!-- secret -->' }, { context: { topics: ['x'.repeat(2049)] } }, cyclic,
    JSON.parse('{"__proto__":{"flag":true}}')]) assert.throws(() => prepare({ metadata }));
  assert.equal({}.flag, undefined);
});

test('processing requires exact mapped session revisions and rejects new unrelated or falsely hashed sources', () => {
  const input = { identity: { client: 'codex', sessionId: 'session_1', unitId: 'turn_1' }, evidenceHash: 'a'.repeat(64), fileHash: 'b'.repeat(64) };
  const source = { type: 'session', client: 'codex', session_id: 'session_1', unit_id: 'turn_1', revision: input.evidenceHash, source_hash: `sha256:${input.fileHash}` };
  const after = parsed(prepare({ metadata: { sources: [source] } }).content);
  assert.doesNotThrow(() => assertProcessingNoteSources(null, after, [input]));
  assert.throws(() => assertProcessingNoteSources(null, after, []), /INPUT_MISMATCH/);
  assert.throws(() => assertProcessingNoteSources(null, after, [{ ...input, evidenceHash: 'c'.repeat(64) }]), /INPUT_MISSING/);
  assert.throws(() => assertProcessingNoteSources(null, after, [{ ...input, fileHash: 'c'.repeat(64) }]), /INPUT_MISMATCH/);
  assert.doesNotThrow(() => assertProcessingNoteSources(after, after, []));
});
