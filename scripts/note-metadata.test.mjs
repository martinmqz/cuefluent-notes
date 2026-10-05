import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { createNoteMarkdownParser, inspectNoteMetadata, validateNoteMetadata, isCalendarDate, isNoteTimestamp, MAX_METADATA_BYTES } from './note-metadata.mjs';
import { inspectMarkdown, checkFiles, reviewVocabulary } from './check-notes.mjs';

const body = '# Project\n\n## Work\n\n<!-- aliases: progress -->\n\nVisible evidence.\n';
const comment = payload => `<!-- cuefluent\n${payload}\n-->\n`;
const note = payload => comment(payload) + '\n' + body;
const minimal = 'schema_version: 1\nid: note_example';
const read = payload => inspectNoteMetadata(note(payload));

test('optional leading metadata preserves unknown fields, exact spans and visible vocabulary', () => {
  assert.equal(inspectNoteMetadata(body).status, 'absent');
  const source = '\uFEFF\r\n' + note(minimal + '\ncontext:\n  topics: [hidden-only]\nextension:\n  flag: true').replaceAll('\n', '\r\n');
  const result = inspectNoteMetadata(source);
  assert.equal(result.status, 'valid', JSON.stringify(result.diagnostics));
  assert.deepEqual(result.value.extension, { flag: true });
  assert.equal(source.slice(result.block.start, result.block.end), result.block.raw);
  const inspected = inspectMarkdown(source, '/note.md');
  assert.deepEqual(inspected.diagnostics, []);
  assert.deepEqual(inspected.sections.map(s => [s.h1, s.heading, s.aliases]), [['Project', 'Work', ['progress']]]);
  assert.equal(reviewVocabulary(inspected.sections, [{ file: '/note.md', heading: 'Work', query: 'hidden-only' }])[0].code, 'vocabulary-gap');
});

test('examples in fenced and indented code never become metadata', () => {
  for (const source of ['```markdown\n' + comment(minimal) + '```\n' + body,
    comment(minimal).split('\n').map(line => '    ' + line).join('\n') + '\n' + body]) {
    assert.equal(inspectNoteMetadata(source).status, 'absent');
  }
});

test('a BOM on the opening line is preserved outside the metadata span', () => {
  const source = '\uFEFF' + note(minimal);
  const result = inspectNoteMetadata(source);
  assert.equal(result.status, 'valid'); assert.equal(result.block.start, 1);
  assert.deepEqual(inspectMarkdown(source).diagnostics, []);
  assert.equal(source.slice(0, result.block.start), '\uFEFF');
});

test('only one leading root comment is active; inline, nested and later directives are rejected', () => {
  for (const source of [body + comment(minimal), '# Title\n' + note(minimal), '<!-- ordinary -->\n' + note(minimal),
    'text ' + note(minimal), comment(minimal).split('\n').map(line => '> ' + line).join('\n') + '\n' + body,
    comment(minimal) + note(minimal), comment(minimal) + comment(minimal).trimEnd() + '\n\n' + body]) {
    assert.equal(inspectNoteMetadata(source).status, 'invalid', source);
  }
});

test('raw HTML wrappers cannot conceal duplicate or misplaced metadata markers', () => {
  for (const tag of ['details', 'div', 'section', 'pre']) {
    const wrapped = `<${tag}>\n${comment(minimal)}</${tag}>\n\n`;
    assert.equal(inspectNoteMetadata(wrapped + body).status, 'invalid');
    const duplicate = inspectNoteMetadata(comment(minimal) + '\n' + wrapped + body);
    assert.ok(duplicate.diagnostics.some(item => item.code === 'metadata-duplicate'));
  }
});

test('nested and unfinished inline reserved openers cannot bypass checker discovery', () => {
  for (const fragment of ['Text <!-- cuefluent\nschema_version: 1\nid: second\n',
    '<!-- ordinary\n<!-- cuefluent\nschema_version: 1\nid: second\n-->\n',
    'Text <!-- ordinary\n<!-- cuefluent\nschema_version: 1\nid: second\n-->\n']) {
    for (const prefix of ['', comment(minimal) + '\n']) {
      const source = prefix + body + '\n' + fragment;
      assert.equal(inspectNoteMetadata(source).status, 'invalid', source);
      assert.ok(inspectMarkdown(source).diagnostics.some(item => item.severity === 'error'));
    }
  }
  for (const literal of ['`<!-- cuefluent`', '``<!-- cuefluent\nid: example``',
    '&lt;!-- cuefluent', '\\<!-- cuefluent', '```markdown\nText <!-- cuefluent\n```',
    '    Text <!-- cuefluent']) {
    const source = comment(minimal) + '\n' + body + '\n' + literal + '\n';
    assert.equal(inspectNoteMetadata(source).status, 'valid', source);
    assert.deepEqual(inspectMarkdown(source).diagnostics, []);
  }
});

test('metadata cannot hide another comment, close early, remain unterminated or occupy one line', () => {
  for (const source of ['<!-- cuefluent ' + minimal + ' -->\n' + body,
    '<!-- cuefluent\n' + minimal + '\n' + body,
    note(minimal + '\nx: "<!-- aliases: secret -->"'),
    note(minimal + '\nx: "--!>"'), note(minimal + '\nx: "\\u002d\\u002d>"')]) {
    assert.equal(inspectNoteMetadata(source).status, 'invalid', source);
  }
});

test('YAML features cannot expand aliases, resolve tags, merge maps or clobber keys', () => {
  for (const payload of [minimal + '\nid: other', minimal + '\nx: &anchor foo', minimal + '\nx: *missing',
    minimal + '\nx: !!str value', minimal + '\nx: !custom value', minimal + '\n<<: {id: other}',
    minimal + '\n__proto__: {polluted: true}', minimal + '\nx: {constructor: bad}',
    minimal + '\n? [a, b]\n: value', minimal + '\nx: .nan', '---\n' + minimal,
    '%YAML 1.1\n---\n' + minimal, minimal + '\n---\n' + minimal]) {
    assert.equal(read(payload).status, 'invalid', payload);
  }
  assert.equal({}.polluted, undefined);
});

test('bounded metadata rejects excessive bytes, depth, collections and scalar length', () => {
  for (const payload of [minimal + '\nx: "' + 'a'.repeat(MAX_METADATA_BYTES) + '"',
    minimal + '\nx: ' + '['.repeat(20) + '0' + ']'.repeat(20),
    minimal + '\nx: [' + Array.from({ length: 129 }, () => '0').join(', ') + ']',
    minimal + '\nx: "' + 'a'.repeat(2049) + '"']) assert.equal(read(payload).status, 'invalid');
});

test('future schemas are opaque, preserved and diagnosed without private values', () => {
  const source = note('schema_version: 2\nprivate: SECRET_VALUE');
  const result = inspectNoteMetadata(source);
  assert.equal(result.status, 'unsupported'); assert.equal(result.value, null);
  assert.equal(source.slice(result.block.start, result.block.end), result.block.raw);
  assert.equal(result.diagnostics[0].severity, 'warning');
  for (const input of ['schema_version: 1\nid: "SECRET_VALUE with spaces"', 'schema_version: 1\nx: [SECRET_VALUE']) {
    assert.ok(!JSON.stringify(read(input).diagnostics).includes('SECRET_VALUE'));
  }
});

test('all schemas reject decoded C1 controls in scalar values without exposing them', () => {
  const escapes = ['\\N', '\\x85', '\u0085', ...Array.from({ length: 32 }, (_, index) => '\\u00' + (0x80 + index).toString(16))];
  for (const schema of [1, 2]) for (const escape of escapes) {
    for (const field of [`extension: {nested: ["PRIVATE_${escape}_VALUE"]}`, `context: {entities: ["PRIVATE_${escape}_VALUE"]}`]) {
      const source = note(`schema_version: ${schema}\nid: note_controls\n${field}`);
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, 'invalid', field);
        assert.equal(result.value, null);
        assert.equal(result.diagnostics[0].code, 'metadata-invalid');
        assert.ok(!JSON.stringify(result.diagnostics).includes('PRIVATE_'));
      }
    }
  }
  for (const schema of [1, 2]) {
    const source = note(`schema_version: ${schema}\nid: note_controls\nextension: "a\\tb\\nc\\rd\\u00a0é文😀"`);
    for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
      assert.equal(result.status, schema === 1 ? 'valid' : 'unsupported');
      assert.equal(result.block.raw, source.slice(0, result.block.end));
    }
  }
});

test('descriptive metadata fields reject C1 controls through direct validation', () => {
  for (let code = 0x80; code <= 0x9f; code++) {
    const value = 'a' + String.fromCodePoint(code) + 'b';
    for (const fields of [{ context: { topics: [value] } }, { context: { entities: [value] } },
      { series: { id: 'series_one', label: value } }, { sprint: value }, { sources: [{ type: 'document', ref: value }] }]) {
      assert.throws(() => validateNoteMetadata({ schema_version: 1, id: 'note_controls', ...fields }), /Invalid note metadata/);
    }
  }
  const value = { schema_version: 1, id: 'note_unicode', context: { entities: ['a\u00a0é文😀b'] } };
  assert.equal(validateNoteMetadata(value), value);
});

test('IDs, optional fields, date order and quoted sprint labels have explicit types', () => {
  for (const suffix of ['\nid: 12', '\ncreated: yesterday', '\ntype: Meeting', '\nsprint: 20.26',
    '\ncontext: {topics: [one, one]}', '\nseries: {label: standups}',
    '\nperiod: {start: 2026-09-21, end: 2026-09-20, timezone: UTC}',
    '\nperiod: {start: 2026-09-21, end: 2026-10-02, timezone: Mars/Olympus}',
    '\ncreated: "2026-10-01T07:42:00-07:00"\nupdated: "2026-10-01T07:41:00-07:00"',
    '\ngeneration: {content_hash: abc}']) assert.equal(read(minimal + suffix).status, 'invalid', suffix);
  assert.equal(read(minimal + '\nsprint: "20.26"\nseries: {id: series_standups}\nperiod: {start: 2026-09-21, end: 2026-10-02, timezone: America/Los_Angeles}').status, 'valid');
  assert.equal(isCalendarDate('2024-02-29'), true); assert.equal(isCalendarDate('2026-02-29'), false);
  for (const date of ['2026-02-30T12:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T12:00:00', '2026-10-01T12:00:00+25:00']) assert.equal(isNoteTimestamp(date), false);
  assert.equal(isNoteTimestamp('2026-10-01T07:42:00.123-07:00'), true);
});

test('schema-1 timestamps require quoted scalars before YAML style is discarded', () => {
  const stamp = '2026-10-01T07:42:00.123-07:00';
  for (const field of ['created', 'updated']) for (const version of ['1', '1.0', '0x1', '1e0', '2']) {
    for (const [raw, quoted] of [[stamp, false], [`|-\n  ${stamp}`, false], [`>-\n  ${stamp}`, false],
      [`"${stamp}"`, true], [`'${stamp}'`, true]]) {
      const payload = `schema_version: ${version}\nid: note_timestamp\n${field}: ${raw}`;
      const source = note(payload);
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, version === '2' ? 'unsupported' : quoted ? 'valid' : 'invalid', payload);
        assert.equal(result.block.raw, comment(payload));
        if (result.status === 'valid') assert.equal(result.value[field], stamp);
        assert.ok(!JSON.stringify(result.diagnostics).includes(stamp));
      }
    }
    for (const raw of [stamp, `"${stamp}"`]) {
      const source = note(`{schema_version: ${version}, id: note_timestamp, "${field}": ${raw}}`);
      assert.equal(inspectNoteMetadata(source).status, version === '2' ? 'unsupported' : raw.startsWith('"') ? 'valid' : 'invalid');
    }
  }
  const extension = read(minimal + `\ncreated.history: ${stamp}\nextension: {created: ${stamp}, updated: ${stamp}}`);
  assert.equal(extension.status, 'valid');
  assert.equal(extension.value.extension.created, stamp);
  assert.equal(extension.value['created.history'], stamp);
});

test('selected sources retain exact revisions and allow multiple captures or document locators', () => {
  const session = `  - type: session\n    client: codex\n    session_id: session_1\n    unit_id: turn_1\n    revision: "${'a'.repeat(64)}"`;
  const source = minimal + '\nsources:\n' + session + '\n  - type: document\n    ref: notes/source.md\n    locator: Decision 7';
  assert.equal(read(source).status, 'valid');
  assert.equal(read(minimal + '\nsources:\n' + session + '\n' + session).status, 'invalid');
  assert.equal(read(source.replace('a'.repeat(64), 'a'.repeat(20))).status, 'invalid');
  assert.equal(read(source.replace('    unit_id: turn_1\n', '')).status, 'invalid');
  assert.equal(read(source.replace('client: codex', 'client: unknown')).status, 'invalid');
});

test('read-only selected-file checks detect duplicate note identity without printing metadata', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-metadata-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = [path.join(directory, 'a.md'), path.join(directory, 'b.md')];
  const source = note(minimal + '\nprivate: SECRET_VALUE');
  await Promise.all(files.map(file => fs.writeFile(file, source)));
  const report = await checkFiles(files);
  assert.equal(report.errors, 1); assert.ok(report.diagnostics.some(item => item.code === 'metadata-id-collision'));
  assert.equal(report.diagnostics.find(item => item.code === 'metadata-id-collision').relatedFile, await fs.realpath(files[0]));
  assert.ok(!JSON.stringify(report).includes('SECRET_VALUE'));
  assert.equal(await fs.readFile(files[0], 'utf8'), source);
  await fs.writeFile(files[1], note(minimal.replace('note_example', 'note_other')));
  assert.equal((await checkFiles(files)).errors, 0);
});

test('nesting-limit truncation cannot conceal metadata in blockquotes or lists', () => {
  for (const prefix of ['>'.repeat(99), '>'.repeat(100), '>'.repeat(500), '- '.repeat(60)]) {
    for (const leading of ['', comment(minimal) + '\n']) {
      const source = leading + body + '\n' + prefix + ' <!-- cuefluent\nid: concealed\n-->\n';
      assert.equal(inspectNoteMetadata(source).status, 'invalid');
      assert.equal(inspectMarkdown(source).metadata.status, 'invalid');
    }
  }
  const deeplyNested = body + '\n' + '>'.repeat(500) + ' ordinary text\n';
  assert.equal(inspectNoteMetadata(deeplyNested).status, 'absent');
});

test('CR, LF and CRLF preserve exact metadata spans and diagnostic line numbers', () => {
  for (const newline of ['\r', '\n', '\r\n']) {
    const source = ('\uFEFF\n\n' + note(minimal)).replaceAll('\n', newline);
    const result = inspectNoteMetadata(source);
    assert.equal(result.status, 'valid'); assert.equal(result.block.line, 3);
    assert.equal(source.slice(result.block.start, result.block.end), result.block.raw);
    assert.deepEqual(inspectMarkdown(source).diagnostics, []);
    const misplaced = (body + '\n' + comment(minimal)).replaceAll('\n', newline);
    assert.equal(inspectNoteMetadata(misplaced).diagnostics[0].line, body.split('\n').length + 1);
  }
});

test('near-miss reserved openers are diagnosed but literal examples stay inert', () => {
  for (const opener of ['<!--cuefluent', '<!-- Cuefluent', '<!-- cuefluent:', '<!--\ncuefluent']) {
    const source = note(minimal).replace('<!-- cuefluent', opener);
    assert.ok(inspectNoteMetadata(source).diagnostics.some(item => item.code === 'metadata-syntax'));
    assert.equal(inspectMarkdown(source).metadata.status, 'invalid');
    assert.equal(inspectNoteMetadata('```markdown\n' + source + '\n```').status, 'absent');
  }
  assert.equal(inspectNoteMetadata('<!-- cuefluently ordinary -->\n' + body).status, 'absent');
});

test('punctuation terminates the reserved marker without reserving longer names', () => {
  for (const suffix of ['?', '!', '.', ',', ';', '/', '=', '+', '-', '—']) {
    const fragment = `<!-- cuefluent${suffix} -->`;
    for (const prefix of ['', comment(minimal) + '\n']) {
      const source = prefix + body + '\n' + fragment + '\n';
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, 'invalid', fragment);
        if (prefix) assert.ok(result.diagnostics.some(item => item.code === 'metadata-duplicate'));
      }
    }
    for (const literal of ['`' + fragment + '`', '\\' + fragment, fragment.replace('<', '&lt;'),
      '```markdown\n' + fragment + '\n```', '    ' + fragment]) {
      const source = comment(minimal) + '\n' + body + '\n' + literal + '\n';
      assert.equal(inspectNoteMetadata(source).status, 'valid', literal);
      assert.equal(inspectMarkdown(source).metadata.status, 'valid', literal);
    }
  }
  for (const name of ['cuefluently', 'cuefluent2', 'cuefluent_extension']) {
    assert.equal(inspectNoteMetadata(`<!-- ${name} -->\n` + body).status, 'absent', name);
  }
});

test('Unicode continuations remain distinct comment names across discovery paths', () => {
  for (const suffix of ['é', '文', '١', 'Ⅳ', '\u0301', '𐐀', '𝟙']) {
    const ordinary = `<!-- cuefluent${suffix} -->`;
    for (const fragment of [ordinary, 'Text ' + ordinary, `<div>\n${ordinary}\n</div>`,
      `[x](url "${ordinary}")`, `![x](image.png "${ordinary}")`,
      `[x]: url "${ordinary}"\n\n[x]`, '>'.repeat(100) + ' ' + ordinary]) {
      for (const prefix of ['', comment(minimal) + '\n']) {
        const source = prefix + body + '\n' + fragment + '\n';
        for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
          assert.equal(result.status, prefix ? 'valid' : 'absent', fragment);
        }
      }
    }
    assert.equal(inspectNoteMetadata(body + '\n' + ordinary + '\n<!-- cuefluent? -->\n').status, 'invalid');
  }
});

test('inline comments, image labels and footnotes report their actual source lines', () => {
  for (const fragment of ['one\ntwo\nthree <!-- x <!-- cuefluent -->',
    'one\n![first\nsecond <!-- cuefluent -->](relative.png)',
    'one\n^[first\nsecond <!-- cuefluent -->]',
    'one\n\n[^f]: first\n    second <!-- cuefluent -->\n\nsee [^f]']) {
    for (const newline of ['\n', '\r', '\r\n']) {
      const source = (body + '\n' + fragment + '\n').replaceAll('\n', newline);
      const expected = source.slice(0, source.indexOf('<!-- cuefluent')).split(/\r\n|\r|\n/).length;
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, 'invalid', fragment);
        assert.ok(result.diagnostics.every(item => item.line === expected), JSON.stringify(result.diagnostics));
      }
    }
  }
});

test('numeric values are either returned without decimal loss or rejected', () => {
  for (const literal of ['12345678901234567890', '9007199254740993', '0.12345678901234567890', '1e-99999']) {
    const result = read(minimal + '\nx: ' + literal);
    assert.equal(result.status, 'invalid', literal); assert.equal(result.value, null);
  }
  for (const literal of ['9007199254740992', '1e100', '0x10', '0o10', '1.25', '-0.0']) {
    assert.equal(read(minimal + '\nx: ' + literal).status, 'valid', literal);
  }
  assert.ok(Object.is(read(minimal + '\nx: -0.0').value.x, -0));
});

test('YAML core preserves underscore spellings as extension strings', () => {
  for (const literal of ['1_000', '0x1_0', '0o1_0', '1_000.25', '1_0e2']) {
    const source = note(minimal + '\nx: ' + literal);
    for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
      assert.equal(result.status, 'valid', literal);
      assert.equal(result.value.x, literal);
      assert.equal(result.block.raw, comment(minimal + '\nx: ' + literal));
    }
  }
});

test('byte and node limits fail independently of scalar, depth and collection bounds', () => {
  const strings = count => minimal + '\nx: [' + Array.from({ length: count }, () => 'a'.repeat(2000)).join(', ') + ']';
  assert.equal(read(strings(32)).status, 'valid');
  assert.equal(read(strings(34)).diagnostics[0].code, 'metadata-size');
  const nodes = count => minimal + '\nx: [' + Array.from({ length: count }, () => '[' + '0,'.repeat(127) + '0]').join(',') + ']';
  assert.equal(read(nodes(31)).status, 'valid');
  assert.equal(read(nodes(32)).status, 'invalid');
});

test('extension keys, future safety bounds and YAML numeric versions follow the contract', () => {
  const extension = read(minimal + '\ncontext.project: /Users/example/checkout\nperiod.start: impossible\nseries.id: "extension value"');
  assert.equal(extension.status, 'valid'); assert.equal(extension.value.context, undefined);
  assert.equal(extension.value['period.start'], 'impossible');
  for (const version of ['1.0', '0x1', '1e0']) assert.equal(read(minimal.replace('version: 1', 'version: ' + version)).status, 'valid');
  for (const suffix of ['\nx: ' + '['.repeat(9) + '0' + ']'.repeat(9), '\nx: ' + 'a'.repeat(3000), '\n9key: value']) {
    assert.equal(read('schema_version: 2' + suffix).status, 'invalid');
  }
});

test('recognized timezone names and aliases survive runtime canonicalization differences', () => {
  const withZone = zone => read(minimal + `\nperiod: {start: 2026-09-21, end: 2026-10-02, timezone: ${zone}}`);
  for (const zone of ['Mars/Olympus', '"+01:00"', '"-05:00"', '" UTC"']) assert.equal(withZone(zone).status, 'invalid', zone);
  for (const zone of ['America/Los_Angeles', 'UTC', 'Etc/GMT+5', 'Asia/Kolkata', 'Asia/Calcutta',
    'Europe/Kyiv', 'Europe/Kiev', 'Asia/Ho_Chi_Minh', 'Asia/Saigon', 'Asia/Kathmandu', 'Asia/Katmandu',
    'America/Argentina/Buenos_Aires', 'America/Buenos_Aires', 'america/los_angeles', 'EST', 'US/Eastern']) {
    const result = withZone(zone);
    assert.equal(result.status, 'valid', zone);
    assert.equal(result.value.period.timezone, zone);
  }
});

test('container prefixes between comment opener and reserved name cannot disable discovery', () => {
  for (const fragment of ['> <!--\n> cuefluent\n> id: hidden\n> -->',
    '> > <!--\n> > CUEFLUENT\n> > -->', '- <!--\n  cuefluent\n  -->',
    '[^unused]:\n    > <!--\n    > cuefluent\n    > -->']) {
    for (const prefix of ['', comment(minimal) + '\n']) {
      const source = prefix + body + '\n' + fragment + '\n';
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, 'invalid', fragment);
        assert.equal(result.diagnostics.some(item => item.code === 'metadata-duplicate'), Boolean(prefix), fragment);
      }
    }
    for (const literal of ['```md\n' + fragment + '\n```', fragment.split('\n').map(line => '    ' + line).join('\n')]) {
      assert.equal(inspectNoteMetadata(body + '\n' + literal).status, 'absent', literal);
    }
  }
  const limited = body + '\n' + '>'.repeat(100) + ' <!--\n' + '>'.repeat(100) + ' cuefluent\n';
  assert.ok(inspectNoteMetadata(limited).diagnostics.some(item => item.code === 'metadata-nesting-limit'));
});

test('existing-note metadata inspection avoids body parsing only when no further marker is possible', t => {
  const parse = MarkdownIt.prototype.parse, sizes = [];
  t.mock.method(MarkdownIt.prototype, 'parse', function (source, ...args) {
    sizes.push(source.length); return parse.call(this, source, ...args);
  });
  const prefix = '\uFEFF\r\n' + comment(minimal).replaceAll('\n', '\r\n');
  const source = prefix + '\n' + body + '\n[^n]: Ordinary evidence.\n'.repeat(70000);
  const result = inspectNoteMetadata(source);
  assert.equal(result.status, 'valid'); assert.equal(result.block.line, 2);
  assert(sizes.length > 0 && sizes.every(size => size <= prefix.length));
  for (const fragment of ['> <!--\n> cuefluent\n> -->', 'Text <!-- cuefluent -->', '[^unused]: <!-- cuefluent -->']) {
    const next = note(minimal) + '\n' + fragment;
    assert.equal(inspectNoteMetadata(next).status, 'invalid');
    assert.equal(sizes.at(-1), next.length);
  }
});

test('source identities reject repeated session revisions but distinguish document versions', () => {
  const session = `  - {type: session, client: codex, session_id: s, unit_id: u, revision: "${'a'.repeat(64)}", raw_ref: first}`;
  assert.equal(read(minimal + '\nsources:\n' + session + '\n' + session.replace('raw_ref: first', 'raw_ref: second')).status, 'invalid');
  const document = `  - {type: document, ref: input.md, source_hash: "sha256:${'a'.repeat(64)}"}`;
  assert.equal(read(minimal + '\nsources:\n' + document + '\n' + document.replace('a'.repeat(64), 'b'.repeat(64))).status, 'valid');
});

test('hidden comment payloads do not warn as visible HTML, while adjacent HTML still does', () => {
  for (const suffix of ['\nx: "a<b"', '\nsources: [{type: document, ref: "<https://example.test/source>"}]']) {
    assert.deepEqual(inspectMarkdown(note(minimal + suffix)).diagnostics, []);
  }
  assert.ok(inspectMarkdown(note(minimal + '\nx: "a<b"') + '\n<div>Visible</div>\n').diagnostics.some(item => item.code === 'html-unchecked'));
  assert.deepEqual(inspectMarkdown(body + '\n<!-- ordinary a<b -->\n').diagnostics, []);
});

test('raw markers in consumed link metadata are rejected without decoding literal examples', () => {
  for (const fragment of ['Text <a title="<!-- cuefluent">x</a>', '[x](url "<!-- cuefluent")', '![x](image.png "<!-- cuefluent")',
    '[x](url "first\n<!-- cuefluent")', '[x]: url "<!-- cuefluent"\n\n[x]',
    '[x]: url "first\n<!-- cuefluent"\n\n[x]', '[x]: url "<!-- cuefluent"',
    '[x<!-- cuefluent]: url\n\n[x<!-- cuefluent]']) {
    for (const prefix of ['', comment(minimal) + '\n']) {
      const source = prefix + body + '\n' + fragment + '\n';
      const expected = source.slice(0, source.lastIndexOf('<!-- cuefluent')).split('\n').length;
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, 'invalid', fragment);
        assert.ok(result.diagnostics.some(item => item.line === expected), JSON.stringify(result.diagnostics));
      }
    }
  }
  for (const fragment of ['[x](url "&lt;!-- cuefluent")', '![x](image.png "&lt;!-- cuefluent")',
    '[x]: url "&lt;!-- cuefluent"\n\n[x]', '[x](url "\\<!-- cuefluent")',
    '[x]: url "\\<!-- cuefluent"\n\n[x]', '`[x](url "<!-- cuefluent")`',
    '```markdown\n[x]: url "<!-- cuefluent"\n```']) {
    const source = comment(minimal) + '\n' + body + '\n' + fragment + '\n';
    assert.equal(inspectNoteMetadata(source).status, 'valid', fragment);
    assert.equal(inspectMarkdown(source).metadata.status, 'valid', fragment);
  }
});

test('named footnote labels cannot conceal reserved markers, including unused definitions', () => {
  for (const fragment of ['[^<!--cuefluent]: text',
    'See [^<!--cuefluent]\n\n[^<!--cuefluent]: text',
    'See ![image [^<!--cuefluent]](image.png)\n\n[^<!--cuefluent]: text',
    '> [^<!--cuefluent]: text', '- [^<!--cuefluent]: text',
    'Paragraph\n[^<!--cuefluent]: text', '[^ordinary]: [^<!--cuefluent]: text',
    '[^<!--cuefluent?]: text', '[^<!--cuefluent<!--cuefluent]: text',
    '[^\\\\<!--cuefluent]: text']) {
    for (const prefix of ['', comment(minimal) + '\n']) for (const newline of ['\n', '\r', '\r\n']) {
      const source = (prefix + body + '\n' + fragment + '\n').replaceAll('\n', newline);
      const lines = source.split(/\r\n|\r|\n/).flatMap((line, index) => line.includes('<!--cuefluent') ? [index + 1] : []);
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, 'invalid', fragment);
        assert.ok(result.diagnostics.some(item => lines.includes(item.line)), JSON.stringify(result.diagnostics));
        if (prefix || fragment.match(/<!--cuefluent/g).length > 1) {
          assert.ok(result.diagnostics.some(item => item.code === 'metadata-duplicate'), fragment);
        } else {
          assert.ok(result.diagnostics.every(item => item.line === lines[0]), JSON.stringify(result.diagnostics));
          assert.ok(!result.diagnostics.some(item => item.code === 'metadata-duplicate'), fragment);
        }
      }
    }
  }
});

test('literal footnote examples and distinct labels remain inert', () => {
  const rendered = createNoteMarkdownParser().render('See [^ordinary]\n[^ordinary]: text\n');
  assert.match(rendered, /class="footnote-ref"/);
  assert.match(rendered, /class="footnote-item"/);
  for (const fragment of ['[^\\<!--cuefluent]: text\n\nSee [^\\<!--cuefluent]',
    '[^&lt;!--cuefluent]: text\n\nSee [^&lt;!--cuefluent]',
    '[^<!--cuefluenté]: text\n\nSee [^<!--cuefluenté]',
    '`[^<!--cuefluent]: text`', '```markdown\n[^<!--cuefluent]: text\n\nSee [^<!--cuefluent]\n```',
    '    [^<!--cuefluent]: text\n\n    See [^<!--cuefluent]']) {
    for (const prefix of ['', comment(minimal) + '\n']) {
      const source = prefix + body + '\n' + fragment + '\n';
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, prefix ? 'valid' : 'absent', fragment);
      }
    }
  }
});

test('discarded footnote bodies retain marker diagnostics without duplicating retained bodies', () => {
  for (const fragment of ['[^f]: text <!-- cuefluent -->',
    '[^f]: first\n    second <!-- cuefluent -->',
    '[^f]: <!-- cuefluent\n    schema_version: 1\n    id: hidden\n    -->',
    '[^f]: [link](url "<!-- cuefluent")', '[^f]: ![image](image.png "<!-- cuefluent")',
    '[^f]: ![label <!-- cuefluent -->](image.png)',
    '[^f]: ^[inline <!-- cuefluent -->]',
    '[^f]: first\n\n    [x]: url "<!-- cuefluent"',
    '[^outer]: [^f]: text <!-- cuefluent -->',
    '> [^f]: text <!-- cuefluent -->', '- [^f]: text <!-- cuefluent -->',
    '[^f]: text <!-- cuefluent -->\n\n[^f]: replacement']) {
    for (const referenced of [false, true]) for (const prefix of ['', comment(minimal) + '\n']) {
      for (const newline of ['\n', '\r', '\r\n']) {
        const source = (prefix + body + '\n' + fragment + (referenced ? '\n\nSee [^f]\n' : '\n')).replaceAll('\n', newline);
        const expected = source.slice(0, source.lastIndexOf('<!-- cuefluent')).split(/\r\n|\r|\n/).length;
        for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
          assert.equal(result.status, 'invalid', fragment);
          assert.ok(result.diagnostics.some(item => item.line === expected), JSON.stringify(result.diagnostics));
          assert.equal(result.diagnostics.some(item => item.code === 'metadata-duplicate'), Boolean(prefix), fragment);
        }
      }
    }
  }
  const source = body + '\n[^f]: first <!-- cuefluent --> and second <!-- cuefluent -->\n';
  assert.ok(inspectNoteMetadata(source).diagnostics.some(item => item.code === 'metadata-duplicate'));
  const limited = body + '\n[^f]: ' + '>'.repeat(100) + ' <!-- cuefluent -->\n';
  for (const result of [inspectNoteMetadata(limited), inspectMarkdown(limited).metadata]) {
    assert.ok(result.diagnostics.some(item => item.code === 'metadata-nesting-limit'));
  }
});

test('discarded footnote bodies keep code and escaped marker examples inert', () => {
  for (const fragment of ['[^f]: `<!-- cuefluent -->`', '[^f]: \\<!-- cuefluent -->',
    '[^f]: &lt;!-- cuefluent -->', '[^f]: <!-- cuefluent文 -->',
    '[^f]: [link](url "\\<!-- cuefluent")', '[^f]: [link](url "&lt;!-- cuefluent")',
    '[^f]: example\n\n    ```markdown\n    <!-- cuefluent -->\n    ```',
    '[^f]: example\n\n        <!-- cuefluent -->']) {
    for (const prefix of ['', comment(minimal) + '\n']) for (const referenced of [false, true]) {
      const source = prefix + body + '\n' + fragment + (referenced ? '\n\nSee [^f]\n' : '\n');
      for (const result of [inspectNoteMetadata(source), inspectMarkdown(source).metadata]) {
        assert.equal(result.status, prefix ? 'valid' : 'absent', fragment);
      }
    }
  }
});
