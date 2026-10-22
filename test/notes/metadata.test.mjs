import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeneratedNote, inspectMetadata, preserveMetadata, validateMetadata } from '../../src/notes/metadata.mjs';

const body = '# Synthetic topic\n\n## Decision\n\nUse the checked result.\n';
const options = { id: 'synthetic-note', now: '2026-10-22T01:00:00Z', skillVersion: '2.0.0-dev.0' };
const metadata = payload => `<!-- cuefluent\n${payload}\n-->\n${body}`;

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
  assert.match(updated.bytes.toString(), /custom: retained # Preserve explanation/);
});

test('similarly named body comments do not claim the cuefluent metadata marker', () => {
  for (const comment of ['<!-- cuefluent-notes: synced -->', '<!-- cuefluent: unrelated -->', '<!-- cuefluent_extra -->']) {
    const original = `${body}\n${comment}\n`;
    assert.equal(inspectMetadata(original).status, 'absent');
    assert.equal(preserveMetadata(original, original.replace('checked', 'verified')).bytes.toString(), original.replace('checked', 'verified'));
  }
  assert.equal(inspectMetadata(`${body}\n<!-- cuefluent\nschema_version: 1\nid: misplaced\n-->`).status, 'invalid');
});
