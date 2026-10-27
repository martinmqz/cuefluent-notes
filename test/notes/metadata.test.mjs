import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Document, parseDocument } from 'yaml';
import { NOTE_PROFILE } from '../../src/notes/profile.mjs';
import { createGeneratedNote, inspectMetadata, preserveMetadata, validateMetadata } from '../../src/notes/metadata.mjs';

const body = '# Synthetic topic\n\n## Decision\n\nUse the checked result.\n';
const options = { id: 'synthetic-note', now: '2026-10-22T01:00:00Z', skillVersion: '0.16.0-dev.0' };
const metadata = payload => `<!-- cuefluent\n${payload}\n-->\n${body}`;
const metadataDocument = bytes => parseDocument(inspectMetadata(bytes).raw.replace(/^<!-- cuefluent(?:\r\n|\r|\n)/, '').replace(/(?:\r\n|\r|\n)-->(?:\r\n|\r|\n)?$/, ''));

test('generated and updated metadata require valid SemVer identifiers and retain build metadata', () => {
  const original = createGeneratedNote(body, options), proposed = body.replace('checked', 'verified');
  for (const skillVersion of ['0.16.0-0', '0.16.0-01a', '0.16.0-rc.1+001.build-0', `0.16.0-${'x'.repeat(2041)}`]) {
    const created = inspectMetadata(createGeneratedNote(body, { ...options, skillVersion }));
    assert.equal(created.status, 'supported'); assert.equal(created.value.generation.skill_version, skillVersion);
    const updated = inspectMetadata(preserveMetadata(original, proposed, { skillVersion }).bytes);
    assert.equal(updated.status, 'supported'); assert.equal(updated.value.generation.skill_version, skillVersion);
  }
  for (const skillVersion of ['0.16.0-01', '0.16.0-.', '0.16.0-dev..1', '0.16.0+build..1', '01.16.0', `0.16.0-${'x'.repeat(2042)}`, ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map(end => `0.16.0-dev.0+001${end}`)]) {
    assert.throws(() => createGeneratedNote(body, { ...options, skillVersion }), { code: 'NOTE_METADATA_INVALID' });
    assert.throws(() => preserveMetadata(original, proposed, { skillVersion }), { code: 'NOTE_METADATA_INVALID' });
    const malformed = metadata(`schema_version: 1\nid: stable\ngeneration:\n  skill_version: "${skillVersion}"`);
    assert.equal(inspectMetadata(malformed).status, 'invalid');
    assert.equal(preserveMetadata(malformed, malformed).bytes.toString(), malformed);
    assert.throws(() => preserveMetadata(malformed, proposed), { code: 'NOTE_METADATA_INVALID' });
  }
});

test('new generated metadata uses quoted timestamps and supported document provenance', () => {
  const bytes = createGeneratedNote(body, { ...options, metadata: { sources: [{ type: 'document', ref: 'chat:synthetic', locator: 'exchange one', source_hash: `sha256:${'a'.repeat(64)}` }] } });
  const result = inspectMetadata(bytes);
  assert.equal(result.status, 'supported');
  assert.equal(result.value.id, 'synthetic-note');
  assert.match(result.raw, /created: "2026-10-22T01:00:00Z"/);
  assert.equal(result.value.sources[0].type, 'document');
});

test('metadata scanner ignores code examples but rejects misplaced and duplicate active blocks', () => {
  assert.equal(inspectMetadata(`${body}\n\`\`\`yaml\n<!-- cuefluent\nschema_version: 1\n-->\n\`\`\`\n`).status, 'absent');
  assert.equal(inspectMetadata(`${body}\n\`<!-- cuefluent -->\`\n`).status, 'absent');
  const note = createGeneratedNote(body, options).toString();
  assert.equal(inspectMetadata(`${body}\n${note}`).status, 'invalid');
  assert.equal(inspectMetadata(`${note}\n<!-- cuefluent\nschema_version: 2\n-->\n`).status, 'invalid');
});

test('YAML rejects directives, aliases, duplicate keys, tags, precision loss and unquoted timestamps', () => {
  for (const payload of [
    '%YAML 1.2\n---\nschema_version: 1\nid: demo',
    'schema_version: 1\nid: demo\nextra: &x [one]\ncopy: *x',
    'schema_version: 1\nid: one\nid: two',
    'schema_version: 1\nid: demo\nextra: !!str hello',
    'schema_version: 1\nid: demo\nextra: 9007199254740993',
    'schema_version: 1\nid: demo\ncreated: 2026-10-22T01:00:00Z',
    'schema_version: 1\nid: demo\n__proto__: x',
  ]) assert.equal(inspectMetadata(metadata(payload)).status, 'invalid', payload);
});

test('schema1 session provenance requires actual unit/revision shape and deduplicates sources', () => {
  const source = { type: 'session', client: 'codex', session_id: 'synthetic-chat', unit_id: 'unit-one', revision: 'a'.repeat(64) };
  assert.equal(validateMetadata({ schema_version: 1, id: 'note', sources: [source] }).sources.length, 1);
  assert.throws(() => validateMetadata({ schema_version: 1, id: 'note', sources: [{ type: 'session', client: 'codex', session_id: 'synthetic-chat' }] }), { code: 'NOTE_METADATA_INVALID' });
  assert.throws(() => validateMetadata({ schema_version: 1, id: 'note', sources: [source, source] }), { code: 'NOTE_METADATA_INVALID' });
});

test('plain notes stay plain and metadata-only proposals preserve all original bytes', () => {
  assert.equal(preserveMetadata(body, createGeneratedNote(body, options)).changed, false);
  const changed = preserveMetadata(body, createGeneratedNote(body.replace('checked', 'verified'), options));
  assert.equal(changed.bytes.toString(), body.replace('checked', 'verified'));
  assert.equal(inspectMetadata(changed.bytes).status, 'absent');
  const original = createGeneratedNote(body, options);
  const proposed = createGeneratedNote(body, { ...options, now: '2026-10-23T01:00:00Z' });
  assert.ok(preserveMetadata(original, proposed).bytes.equals(original));
});

test('useful edits preserve unknown metadata and stable identity while updating explicit generation fields', () => {
  const original = metadata('schema_version: 1\nid: stable\ncreated: "2026-10-21T00:00:00Z"\nupdated: "2026-10-21T00:00:00Z" # keep timestamp explanation\ncustom:\n  owner: synthetic\ngeneration:\n  skill_version: 1.0.0 # keep generation explanation\n  other: keep');
  const proposed = createGeneratedNote(body.replace('checked', 'verified'), options);
  const changed = preserveMetadata(original, proposed, { updated: options.now, skillVersion: options.skillVersion });
  const inspected = inspectMetadata(changed.bytes);
  assert.equal(inspected.value.id, 'stable');
  assert.equal(inspected.value.created, '2026-10-21T00:00:00Z');
  assert.equal(inspected.value.custom.owner, 'synthetic');
  assert.equal(inspected.value.generation.other, 'keep');
  assert.equal(inspected.value.updated, options.now);
  assert.match(changed.bytes.toString(), /# keep timestamp explanation/);
  assert.match(changed.bytes.toString(), /# keep generation explanation/);
});

test('body edits maintain an existing content hash over exact bytes outside the metadata block', () => {
  const hash = content => `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const prefix = '\uFEFF\r\n', originalBody = body.replaceAll('\n', '\r\n');
  const proposed = originalBody.replace('checked', 'verified');
  const original = prefix + `<!-- cuefluent\r\nschema_version: 1\r\nid: stable\r\ngeneration:\r\n  content_hash: "${hash(prefix + originalBody)}" # Retain digest explanation\r\n  extra: retained\r\n-->\r\n` + originalBody;
  for (const update of [{}, { updated: options.now, skillVersion: options.skillVersion }]) {
    const result = preserveMetadata(original, proposed, update), inspection = inspectMetadata(result.bytes);
    assert.equal(result.changed, true);
    assert.equal(inspection.value.generation.content_hash, hash(prefix + proposed));
    assert.equal(inspection.value.id, 'stable');
    assert.equal(inspection.value.generation.extra, 'retained');
    assert.ok(result.bytes.toString().startsWith(prefix));
    assert.ok(result.bytes.toString().endsWith(proposed));
    assert.match(result.bytes.toString(), /# Retain digest explanation/);
  }
});

test('content hash maintenance does not enrich metadata or rewrite unchanged notes', () => {
  const proposed = body.replace('checked', 'verified');
  const original = metadata(`schema_version: 1\nid: stable\ngeneration:\n  content_hash: "sha256:${'a'.repeat(64)}"`);
  for (const result of [preserveMetadata(original, original), preserveMetadata(original, body),
    preserveMetadata(original, proposed, { usefulChange: false, updated: options.now })]) {
    assert.equal(result.changed, false); assert.equal(result.bytes.toString(), original);
  }
  for (const original of [body, createGeneratedNote(body, options)]) {
    const result = preserveMetadata(original, proposed, { updated: options.now, skillVersion: options.skillVersion });
    assert.equal(inspectMetadata(result.bytes).value?.generation?.content_hash, undefined);
  }
  const future = metadata(`schema_version: 2\ngeneration:\n  content_hash: "sha256:${'a'.repeat(64)}"`);
  const result = preserveMetadata(future, proposed, { updated: options.now, skillVersion: options.skillVersion });
  assert.equal(inspectMetadata(result.bytes).raw, inspectMetadata(future).raw);
});

test('unsupported metadata including BOM and CRLF is preserved exactly; malformed edits are refused', () => {
  const raw = '\uFEFF\r\n<!-- cuefluent\r\nschema_version: 99\r\nfuture: [one, two]\r\n-->\r\n';
  const original = raw + body;
  const updated = preserveMetadata(original, body.replace('checked', 'verified'));
  assert.ok(updated.bytes.toString().startsWith(raw));
  assert.equal(inspectMetadata(updated.bytes).status, 'unsupported');
  const malformed = metadata('schema_version: 1\nid: [bad');
  assert.equal(preserveMetadata(malformed, malformed).changed, false);
  assert.deepEqual(preserveMetadata(malformed, malformed).diagnostics, ['metadata-invalid']);
  assert.throws(() => preserveMetadata(malformed, body), { code: 'NOTE_METADATA_INVALID' });
});

test('bounded data validation rejects getters without executing them', () => {
  let executed = false;
  const metadata = { schema_version: 1, id: 'demo' };
  Object.defineProperty(metadata, 'custom', { enumerable: true, get() { executed = true; return 'unsafe'; } });
  assert.throws(() => validateMetadata(metadata), { code: 'NOTE_METADATA_INVALID' });
  assert.equal(executed, false);
});

test('backticks in YAML or reference attributes cannot hide a second metadata marker', () => {
  const text = '<!-- cuefluent\nschema_version: 1\nid: demo\ncustom: "`"\n-->\n# T\n\n## A\n\nBody.\n\n[x]: https://example.test "<!-- cuefluent `"\n';
  assert.equal(inspectMetadata(text).status, 'invalid');
  assert.equal(inspectMetadata(metadata('schema_version: 1\nid: demo\ncustom: 0x10')).status, 'supported');
});

test('schema-1 notes without optional generation metadata accept useful edits', () => {
  const original = metadata('schema_version: 1\nid: stable\ncreated: "2026-10-21T00:00:00Z"\ncustom: retained # Preserve explanation');
  const updated = preserveMetadata(original, body.replace('checked', 'verified'), { updated: options.now, skillVersion: options.skillVersion });
  const result = inspectMetadata(updated.bytes);
  assert.equal(result.status, 'supported'); assert.equal(result.value.id, 'stable');
  assert.equal(result.value.created, '2026-10-21T00:00:00Z'); assert.equal(result.value.generation.skill_version, options.skillVersion);
  assert.equal(metadataDocument(updated.bytes).contents.flow, true);
  assert.match(updated.bytes.toString(), /custom: retained, # Preserve explanation/);
});

test('similarly named body comments do not claim the cuefluent metadata marker', () => {
  for (const comment of ['<!-- cuefluent-notes: synced -->', '<!-- cuefluent: unrelated -->', '<!-- cuefluent_extra -->']) {
    const original = `${body}\n${comment}\n`;
    assert.equal(inspectMetadata(original).status, 'absent');
    assert.equal(preserveMetadata(original, original.replace('checked', 'verified')).bytes.toString(), original.replace('checked', 'verified'));
  }
  assert.equal(inspectMetadata(`${body}\n<!-- cuefluent\nschema_version: 1\nid: misplaced\n-->`).status, 'invalid');
});


test('metadata is compact by default and expanded only by explicit opt-in, with identical values', () => {
  const extra = { context: { project: 'synthetic', topics: ['café', '日本語'] }, custom: { text: 'first\nsecond', quoted: 'a: [b], "c"', zero: -0 } };
  const compact = createGeneratedNote(body, { ...options, metadata: extra });
  const expanded = createGeneratedNote(body, { ...options, metadata: extra, expandedMetadata: true });
  const a = inspectMetadata(compact), b = inspectMetadata(expanded);
  assert.equal(a.status, 'supported'); assert.equal(b.status, 'supported');
  assert.equal(metadataDocument(compact).contents.flow, true);
  assert.notEqual(metadataDocument(expanded).contents.flow, true);
  assert.equal(a.raw.trim().split('\n').length, 3);
  assert.ok(b.raw.trim().split('\n').length > 3);
  assert.deepEqual(a.value, b.value);
  assert.equal(compact.toString().slice(a.end), body);
  assert.equal(expanded.toString().slice(b.end), body);
  for (const expandedMetadata of [null, 'false', 0]) {
    assert.throws(() => createGeneratedNote(body, { ...options, expandedMetadata }), { code: 'NOTE_METADATA_INVALID' });
  }
});

test('useful note edits honor compact or expanded formatting; no-op edits retain exact original bytes', () => {
  const original = createGeneratedNote(body, { ...options, expandedMetadata: true });
  const next = body.replace('checked', 'verified');
  for (const expandedMetadata of [false, true]) {
    const changed = preserveMetadata(original, next, { updated: '2026-10-27T01:00:00Z', expandedMetadata });
    const m = inspectMetadata(changed.bytes);
    assert.equal(metadataDocument(changed.bytes).contents.flow === true, !expandedMetadata);
    assert.equal(m.value.id, options.id); assert.equal(m.value.created, options.now);
    assert.equal(m.value.updated, '2026-10-27T01:00:00Z');
    assert.equal(changed.bytes.toString().slice(m.end), next);
    assert.deepEqual(preserveMetadata(original, body, { expandedMetadata }).bytes, original);
  }
});


test('compact updates preserve blank null entries at every position, including single-item lists', () => {
  for (const reviewers of [' - sam\n -\n - kim', ' - sam\n -', ' -']) {
    const original = metadata(`schema_version: 1\nid: stable\nreviewers:\n${reviewers}`);
    const before = inspectMetadata(original); assert.equal(before.status, 'supported');
    const result = preserveMetadata(original, body.replace('checked', 'verified'));
    const after = inspectMetadata(result.bytes); assert.equal(after.status, 'supported');
    assert.deepEqual(after.value, before.value);
    assert.equal(metadataDocument(result.bytes).contents.flow, true);
  }
});

test('compact to expanded updates preserve multiline strings with whitespace-only lines', () => {
  const original = metadata('schema_version: 1\nid: stable\nsummary: |-\n  First line of a handwritten summary here\n   \n  Third');
  const compact = preserveMetadata(original, body.replace('checked', 'verified')).bytes;
  const expanded = preserveMetadata(compact, body.replace('checked', 'rechecked'), { expandedMetadata: true }).bytes;
  assert.deepEqual(inspectMetadata(expanded).value, inspectMetadata(original).value);
  assert.equal(metadataDocument(compact).contents.flow, true);
  assert.notEqual(metadataDocument(expanded).contents.flow, true);
});

test('compact overflow preserves existing metadata layout and values without increasing the limit', () => {
  const line = 'C:\\Work\\Folder\\ "quoted" value '.repeat(43);
  const payload = 'schema_version: 1\nid: stable\n' + Array.from({ length: 45 }, (_, i) => `custom${i}: |-\n  ${line}\n  Tail`).join('\n');
  const original = metadata(payload), before = inspectMetadata(original);
  assert.equal(before.status, 'supported'); assert.ok(Buffer.byteLength(before.raw) < NOTE_PROFILE.metadataBytes);
  const updated = '2026-10-27T01:00:00Z';
  const result = preserveMetadata(original, body.replace('checked', 'verified'), { updated });
  const after = inspectMetadata(result.bytes); assert.equal(after.status, 'supported');
  assert.deepEqual(after.value, { ...before.value, updated });
  assert.ok(Buffer.byteLength(after.raw) <= NOTE_PROFILE.metadataBytes);
  assert.notEqual(metadataDocument(result.bytes).contents.flow, true);
  assert.ok(result.bytes.toString().endsWith(body.replace('checked', 'verified')));
  assert.throws(() => createGeneratedNote(body, { ...options, metadata: before.value }), { code: 'NOTE_METADATA_INVALID' });
});

test('expanded overflow preserves a valid compact layout and metadata values within the same limit', () => {
  const value = { schema_version: 1, id: 'stable', entries: Array.from({ length: 100 }, () =>
    ({ a: { b: { c: { d: { values: Array.from({ length: 16 }, () => 'x'.repeat(29)) } } } } })) };
  const original = metadata(JSON.stringify(value)), before = inspectMetadata(original);
  assert.equal(before.status, 'supported'); assert.ok(Buffer.byteLength(before.raw) < NOTE_PROFILE.metadataBytes);
  const updated = '2026-10-27T01:00:00Z', proposed = body.replace('checked', 'verified');
  const result = preserveMetadata(original, proposed, { updated, expandedMetadata: true });
  const after = inspectMetadata(result.bytes); assert.equal(after.status, 'supported');
  assert.deepEqual(after.value, { ...before.value, updated });
  assert.ok(Buffer.byteLength(after.raw) <= NOTE_PROFILE.metadataBytes);
  assert.equal(metadataDocument(result.bytes).contents.flow, true);
  assert.equal(result.bytes.toString().slice(after.end), proposed);
  assert.throws(() => createGeneratedNote(body, { ...options, metadata: value, expandedMetadata: true }), { code: 'NOTE_METADATA_INVALID' });
});

test('metadata serialization rejects a valid-looking YAML result whose values changed', t => {
  const original = createGeneratedNote(body, options);
  const stringify = Document.prototype.toString;
  t.mock.method(Document.prototype, 'toString', function (...args) {
    return stringify.apply(this, args).replace('synthetic-note', 'different-note');
  });
  assert.throws(() => createGeneratedNote(body, options), { code: 'NOTE_METADATA_INVALID' });
  assert.throws(() => preserveMetadata(original, body.replace('checked', 'verified')), { code: 'NOTE_METADATA_INVALID' });
});

test('new and edited notes keep LF, CRLF and CR line endings in both metadata formats', () => {
  for (const newline of ['\n', '\r\n', '\r']) for (const expandedMetadata of [false, true]) {
    const originalBody = body.replaceAll('\n', newline), proposed = originalBody.replace('checked', 'verified');
    const original = createGeneratedNote(originalBody, { ...options, expandedMetadata });
    const created = inspectMetadata(original); assert.equal(created.status, 'supported');
    assert.ok(created.raw.match(/\r\n|\r|\n/g).every(value => value === newline));
    const result = preserveMetadata(original, proposed, { expandedMetadata: !expandedMetadata, updated: '2026-10-27T01:00:00Z' });
    const changed = inspectMetadata(result.bytes); assert.equal(changed.status, 'supported');
    assert.ok(changed.raw.match(/\r\n|\r|\n/g).every(value => value === newline));
    assert.equal(metadataDocument(result.bytes).contents.flow === true, expandedMetadata);
    assert.equal(result.bytes.toString().slice(changed.end), proposed);
  }
});


test('metadata round-trip verification distinguishes negative zero from zero', t => {
  const settings = { ...options, metadata: { custom: { zero: -0 } } };
  const original = createGeneratedNote(body, settings), stringify = Document.prototype.toString;
  t.mock.method(Document.prototype, 'toString', function (...args) {
    return stringify.apply(this, args).replace('zero: -0', 'zero: 0');
  });
  assert.throws(() => createGeneratedNote(body, settings), { code: 'NOTE_METADATA_INVALID' });
  assert.throws(() => preserveMetadata(original, body.replace('checked', 'verified')), { code: 'NOTE_METADATA_INVALID' });
});

test('an expanded preference converts existing flow collections while preserving their values and comments', () => {
  const original = metadata('schema_version: 1\nid: stable\ncontext: {topics: [first, second]} # Preserve topics\ntags: []');
  const result = preserveMetadata(original, body.replace('checked', 'verified'), { expandedMetadata: true });
  const parsed = metadataDocument(result.bytes);
  assert.notEqual(parsed.contents.flow, true);
  assert.notEqual(parsed.get('context', true).flow, true);
  assert.notEqual(parsed.getIn(['context', 'topics'], true).flow, true);
  assert.deepEqual(inspectMetadata(result.bytes).value, inspectMetadata(original).value);
  assert.match(result.bytes.toString(), /# Preserve topics/);
});
