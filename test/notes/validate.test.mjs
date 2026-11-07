import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_PROFILE } from '../../src/notes/profile.mjs';
import { SOURCE_LOCATOR_LENGTH, createGeneratedNote, preserveMetadata } from '../../src/notes/metadata.mjs';
import { assertOrdinaryTarget, assertValidNote, isLogEntryMarker, validateNote } from '../../src/notes/validate.mjs';

const marker = '<!-- note-log-entry event=12345678-1234-4123-8123-123456789abc project=synthetic -->';
const has = (result, code) => result.diagnostics.some(issue => issue.code === code);

test('plain notes and generated notes have visible H2 bodies', () => {
  const plain = '# Topic\n\n## Answer\n\nUseful content.\n';
  assert.equal(validateNote(plain).valid, true);
  assert.equal(validateNote(createGeneratedNote(plain, { now: '2026-10-22T01:00:00Z', skillVersion: '0.16.0' }), { generated: true }).valid, true);
  assert.equal(has(validateNote('# Topic\n\nOnly introduction.'), 'no-answer-sections'), true);
  assert.equal(has(validateNote('# Topic\n\n## Answer\n\n<!-- comment -->\n'), 'empty-body'), true);
  assert.equal(validateNote('## Existing plain section\n\nBody.').valid, true);
});

test('existing note validation permits only appended document sources while every prior source stays exactly as it was', () => {
  const body = '# Topic\n\n## Answer\nUseful content.\n';
  const options = { id: 'source-note', now: '2026-10-22T01:00:00Z', skillVersion: '0.20.0' };
  const first = { type: 'document', ref: 'Existing design', description: 'Retain this explanation' };
  const second = { type: 'document', ref: 'Existing meeting' }, addition = { type: 'document', ref: 'New supplied source' };
  const existing = createGeneratedNote(body, { ...options, metadata: { sources: [first, second], custom: 'keep' } });
  const candidate = (sources, custom = 'keep') => createGeneratedNote(body, { ...options, metadata: { sources, custom } });
  assert.equal(validateNote(candidate([first, second, addition]), { existing }).valid, true);
  const recited = preserveMetadata(existing, body.replace('Useful content.', 'Corrected useful content.'), { sources: [{ type: first.type, ref: first.ref }] }).bytes;
  assert.equal(validateNote(recited, { existing }).valid, true);
  for (const sources of [[first], [second, first], [{ ...first, description: 'Changed' }, second], [{ ...first, category: 'reference' }, second],
    [{ type: first.type, ref: first.ref }, second], [{ ...first, raw_ref: 'Invented native reference' }, second],
    [first, second, { type: 'session', client: 'codex', session_id: 'invented', unit_id: 'unit', revision: 'a'.repeat(64) }],
    [first, second, { ...addition, source_hash: `sha256:${'a'.repeat(64)}` }], [first, second, { ...addition, locator: 'x'.repeat(SOURCE_LOCATOR_LENGTH + 1) }],
    [first, second, { type: 'document', ref: '/synthetic/local/path.md' }]]) {
    assert.equal(has(validateNote(candidate(sources), { existing }), 'metadata-sources-changed'), true);
  }
  const hashed = digit => ({ type: 'document', ref: 'Synthetic file', source_hash: `sha256:${digit.repeat(64)}` });
  const historical = createGeneratedNote(body, { ...options, metadata: { sources: [hashed('a'), hashed('b')] } });
  const cited = preserveMetadata(historical, body, { sources: [{ type: 'document', ref: 'Synthetic file' }] }).bytes;
  assert.equal(validateNote(cited, { existing: historical }).valid, true);
  assert.equal(has(validateNote(candidate([first, second, addition], 'changed'), { existing }), 'metadata-descriptions-changed'), true);
  const signedZero = '<!-- cuefluent\nschema_version: 1\nid: source-note\nsources:\n  - type: document\n    ref: Existing design\n    offset: -0\n-->\n' + body;
  assert.equal(validateNote(signedZero, { existing: signedZero }).valid, true);
  assert.equal(has(validateNote(signedZero.replace('offset: -0', 'offset: 0'), { existing: signedZero }), 'metadata-sources-changed'), true);
});

test('aliases must be single-line, nonempty and first in the section', () => {
  assert.equal(validateNote('# Topic\n\n## Answer\n\n<!-- aliases: first, second -->\n\nBody.').valid, true);
  for (const text of [
    '# Topic\n<!-- aliases: wrong -->\n\n## Answer\nBody.',
    '# Topic\n## Answer\nBody.\n\n<!-- aliases: late -->',
    '# Topic\n## Answer\n<!-- ordinary -->\n\n<!-- aliases: late -->\n\nBody.',
    '# Topic\n## Answer\n<!-- aliases: one, -->\n\nBody.',
    '# Topic\n## Answer\n<!-- aliases:\none -->\n\nBody.',
  ]) assert.equal(validateNote(text).valid, false, text);
});

test('valid activity markers are inert and receive no raw-comment advisory exemption for invalid lookalikes', () => {
  assert.equal(isLogEntryMarker(marker), true);
  assert.equal(isLogEntryMarker('<!-- note-log-entry event=bad project=synthetic -->'), false);
  const result = validateNote(`# Activity\n\n## About this log\n\nSave times; partial coverage; gaps possible.\n\n## October\n\nChanged a [note](../knowledge-base/topic.md). ${marker}\n`, { kind: 'log' });
  assert.equal(result.valid, true);
  assert.equal(has(result, 'html-comment'), false);
  assert.equal(has(validateNote(`# Topic\n\n## Answer\n\n${marker}`), 'empty-body'), true);
  assert.equal(has(validateNote('# Topic\n\n## Answer\n\nBody <!-- note-log-entry malformed -->'), 'html-comment'), true);
});

test('a newly authored note carries no hidden comment, while aliases and literal examples stay available', () => {
  const generated = text => validateNote(createGeneratedNote(text, { now: '2026-10-22T01:00:00Z', skillVersion: '0.24.0' }), { generated: true });
  for (const text of [
    '# Topic\n\n## Answer\n\nBody.\n\n<!-- Evidence: captured earlier -->\n',
    '# Topic\n\n<!-- between the title and the first section -->\n\n## Answer\n\nBody.\n',
    '# Topic\n\n## Answer\n\nBody <!-- inline remark --> continues.\n',
    '# Topic\n\n## Answer\n\n<div>\n<!-- nested in raw HTML -->\nVisible\n</div>\n',
    '# Topic\n\n## Answer\n<!-- aliases: first --> <!-- trailing prose -->\nBody.\n',
    '# Topic\n\nIntroduction <!-- aliases hidden prose --> continues.\n\n## Answer\n\nBody.\n',
    '# Topic <!-- aliases: hidden -->\n\n## Answer\n\nBody.\n',
    '# Topic\n\n## Answer\n\nBody.\n\n[^unused]: Unreferenced\n\n    <!-- aliases: hidden prose -->\n',
    `# Topic\n\n## Answer\n\nBody. ${marker}\n`,
    '# Topic\n\n## Answer\n\nBody.[^a]\n\n[^a]: Definition <!-- in a footnote -->\n',
    '# Topic\n\n## Answer\n\nBody.\n\n[^unused]: Unreferenced <!-- in an unused footnote -->\n',
    '# Topic\n\n## Answer\n\nBody.\n\n<!-- never closed\n',
    '# Topic\n\n## Answer\n\nVisible <!--> text.\n',
    '# Topic\n\n## Answer\n\n<span title="<!-- literal -->">Visible</span> <!-- real remark -->\n',
  ]) {
    const result = generated(text);
    assert.equal(has(result, 'html-comment-added'), true, text); assert.equal(result.valid, false, text);
  }
  for (const text of [
    '# Topic\n\n## Answer\n<!-- aliases: first, second -->\nBody.\n',
    '# Topic\n\n## Answer\n\n```html\n<!-- literal example -->\n```\n',
    '# Topic\n\n## Answer\n\nWrite `<!-- like this -->` to hide text.\n',
    '# Topic\n\n## Answer\n\n    <!-- indented code -->\n\nBody.\n',
    '# Topic\n\n## Answer\n\nAn escaped \\<!-- marker --> is text.\n',
    '# Topic\n\n## Answer\n\n<span title="Show <!-- marker --> syntax">Visible</span>\n',
    "# Topic\n\n## Answer\n\n<div title='<!-- literal -->'>\nVisible\n</div>\n",
  ]) {
    const result = generated(text);
    assert.equal(has(result, 'html-comment-added'), false, text); assert.equal(result.valid, true, text);
  }
  const commented = createGeneratedNote('# Topic\n\n## Answer\n\nBody.\n\n<!-- Evidence: captured earlier -->\n', { now: '2026-10-22T01:00:00Z', skillVersion: '0.24.0' });
  assert.throws(() => assertValidNote(commented, { generated: true }), { code: 'NOTE_COMMENT_ADDED' });
  const unsafe = createGeneratedNote('# Topic\n\n## Answer\n\n<script>bad()</script>\n\n<!-- Evidence -->\n', { now: '2026-10-22T01:00:00Z', skillVersion: '0.24.0' });
  assert.throws(() => assertValidNote(unsafe, { generated: true }), { code: 'NOTE_INVALID' });
});

test('an update keeps or removes existing hidden comments but cannot add, repeat or reword one', () => {
  const options = { id: 'commented-note', now: '2026-10-22T01:00:00Z', skillVersion: '0.24.0' };
  const comments = '<!-- Evidence: first\n     capture -->\n\n<!-- Second remark -->\n';
  const original = createGeneratedNote(`# Topic\n\n## Answer\n\nBody.\n\n${comments}`, options);
  const update = text => validateNote(preserveMetadata(original, text).bytes, { existing: original });
  const kept = `# Topic\n\n## Answer\n\nRevised body.\n\n${comments}`;
  assert.equal(update(kept).valid, true); assert.equal(has(update(kept), 'html-comment'), true);
  assert.equal(update(kept.replace('first\n     capture', 'first capture')).valid, true);
  assert.equal(update(`# Topic\n\n## Answer\n\n<!-- Second remark -->\n\nRevised body.\n\n## Evidence\n\n<!-- Evidence: first capture -->\n\nMoved with its section.\n`).valid, true);
  assert.equal(update('# Topic\n\n## Answer\n\nRevised body. The first capture is described here.\n').valid, true);
  for (const text of [`${kept}\n<!-- Third remark -->\n`, `${kept}\n<!-- Second remark -->\n`, kept.replace('Second remark', 'Second remark, reworded'),
    kept.replace('Revised body.', 'Revised body <!-- inline remark -->.'), kept.replace('Revised body.', `Revised body. ${marker}`)]) {
    const result = update(text);
    assert.equal(has(result, 'html-comment-added'), true, text); assert.equal(result.valid, false, text);
    assert.throws(() => assertValidNote(preserveMetadata(original, text).bytes, { existing: original }), { code: 'NOTE_COMMENT_ADDED' });
  }
  const plain = '# Topic\n\n## Answer\n\nBody.\n';
  assert.equal(has(validateNote(`${plain}\n<!-- new remark -->\n`, { existing: plain }), 'html-comment-added'), true);
  // A comment marker in an attribute is text of that tag: keeping it adds nothing,
  // and it never stands in for a real comment with the same words.
  const literal = '# Topic\n\n## Answer\n\n<span title="Show <!-- marker --> syntax">Visible</span>\n';
  assert.equal(validateNote(literal.replace('Visible', 'Still visible'), { existing: literal }).valid, true);
  const swapped = validateNote('# Topic\n\n## Answer\n\n<span title="Show syntax">Visible</span> <!-- marker -->\n', { existing: literal });
  assert.equal(has(swapped, 'html-comment-added'), true); assert.equal(swapped.valid, false);
  assert.equal(validateNote(`${kept}\n<!-- Third remark -->\n`).valid, true);
});

test('activity logs keep their entry markers and existing hand-written comments outside the authoring rule', () => {
  const log = `# Activity\n\n## About this log\n\nSave times; partial coverage; gaps possible.\n\n<!-- hand-written remark -->\n\n## October\n\n- Changed a [note](../knowledge-base/topic.md). ${marker}\n`;
  const next = marker.replace('12345678', '87654321');
  const appended = validateNote(`${log}- Changed [another](../tasks/topic.md). ${next}\n`, { existing: log, kind: 'log' });
  assert.equal(appended.valid, true); assert.equal(has(appended, 'html-comment-added'), false);
});

test('comment markers inside attribute values neither hide a tag\'s other attributes nor count as comments', () => {
  const note = html => `# Topic\n\n## Answer\n\n${html}\n`;
  const hidden = validateNote(note('See <a title="<!--" href="javascript:alert(1)" data-note="-->">link</a>.'));
  assert.equal(has(hidden, 'unsafe-destination'), true); assert.equal(hidden.valid, false);
  const handler = validateNote(note('<span title="<!--" onclick="bad()" data-note="-->">text</span>'));
  assert.equal(has(handler, 'unsafe-html'), true); assert.equal(handler.valid, false);
  for (const html of ['<span title="Show <!-- marker">Visible</span>', '<span title="Show --> marker">Visible</span>', '<a title="<!-- literal -->" href="https://example.test/page">link</a>']) {
    const result = validateNote(note(html));
    assert.equal(result.valid, true, html); assert.equal(has(result, 'html-comment'), false, html);
  }
  const unclosed = validateNote(note('<div>\n<!-- never closed\n</div>'));
  assert.equal(has(unclosed, 'unclosed-html-block'), true); assert.equal(unclosed.valid, false);
  const mixed = validateNote(note('<div>Visible <!-- remark --> text</div>'));
  assert.equal(mixed.valid, true); assert.equal(has(mixed, 'raw-html'), true);
});

test('unsafe links and active HTML are reported without rendering or fetching', () => {
  assert.equal(validateNote('# Topic\n\n## Answer\n\n[other](other.md)').valid, true);
  for (const body of ['[bad](javascript:alert(1))', '![bad](data:image/png;base64,AAAA)', '<script>bad()</script>', '<span onclick="bad()">text</span>']) {
    assert.equal(validateNote(`# Topic\n\n## Answer\n\n${body}`).valid, false, body);
  }
  assert.equal(validateNote('# Topic\n\n## Answer\n\n<span>Visible text</span>').valid, true);
  assert.equal(has(validateNote('# Topic\n\n## Answer\n\n```text\nnot closed'), 'unclosed-fence'), true);
  assert.equal(validateNote('# Topic\n\n## Answer\n\n```text\nclosed\n```').valid, true);
});

test('body node budgets reject the audited oversized log without truncating input', () => {
  const prefix = '# Activity\n\n## About this log\n\nSave times; partial coverage; gaps possible.\n\n## October\n\n';
  const line = `- Updated [synthetic](../topic.md) — heading — summary. ${marker}\n`;
  assert.equal(validateNote(prefix + line.repeat(1000), { kind: 'log' }).valid, true);
  const oversized = prefix + line.repeat(5000);
  assert.equal(has(validateNote(oversized, { kind: 'log' }), 'section-body-limit'), true);
  assert.equal(oversized.endsWith(line), true);
  assert.equal(has(validateNote('# Topic\n\n## Answer\n\n' + 'x'.repeat(NOTE_PROFILE.lineBytes + 1)), 'source-line-limit'), true);
});

test('each referencing section is charged for its expanded footnote body', () => {
  const definition = Array.from({ length: 180 }, (_, i) => `word${i}`).join(' ');
  const result = validateNote(`# Topic\n\n## One\n\nFirst.[^a]\n\n## Two\n\nSecond.[^a]\n\n[^a]: ${definition}\n`);
  assert.equal(result.valid, true);
  assert.ok(result.sections.every(section => section.nodes > 10));
});

test('ordinary targets respect file routes and reserve the whole logs directory on both platforms', () => {
  const project = { destination: { kind: 'directory', path: '/notes' } };
  assert.equal(assertOrdinaryTarget(project, '/notes/knowledge-base/topic.md', { platform: 'linux' }), '/notes/knowledge-base/topic.md');
  assert.throws(() => assertOrdinaryTarget(project, '/notes/logs/topic.md', { platform: 'linux' }), { code: 'NOTE_TARGET_RESERVED' });
  assert.throws(() => assertOrdinaryTarget(project, '/elsewhere/topic.md', { platform: 'linux' }), { code: 'NOTE_TARGET_OUTSIDE' });
  assert.throws(() => assertOrdinaryTarget({ destination: { kind: 'directory', path: 'C:\\Notes' } }, 'C:\\Notes\\LOGS\\topic.md', { platform: 'win32' }), { code: 'NOTE_TARGET_RESERVED' });
  assert.throws(() => assertOrdinaryTarget({ destination: { kind: 'file', path: '/notes/topic.md' } }, '/notes/other.md', { platform: 'linux' }), { code: 'NOTE_TARGET_OUTSIDE' });
});

test('raw HTML nesting and inline/nested aliases retain structural checks', () => {
  assert.equal(has(validateNote('# T\n\n## A\n\n' + '<div>'.repeat(33) + 'text' + '</div>'.repeat(33)), 'section-body-limit'), true);
  assert.equal(validateNote('# T\n\n## A\n\ntext <!-- aliases: hidden -->').valid, false);
  assert.equal(validateNote('# T\n\n## A\n\n> <!-- aliases: nested -->\n\nBody.').valid, false);
  assert.throws(() => assertOrdinaryTarget({ destination: { kind: 'directory', path: '/notes' } }, '/notes/Logs/topic.md', { platform: 'darwin' }), { code: 'NOTE_TARGET_RESERVED' });
});

test('existing metadata identity and unfamiliar values cannot bypass preservation helpers', () => {
  const original = createGeneratedNote('# T\n\n## A\n\nBody.', { id: 'original', now: '2026-10-22T01:00:00Z', skillVersion: '0.16.0', metadata: { custom: 'keep' } });
  const replacement = createGeneratedNote('# T\n\n## A\n\nChanged body.', { id: 'replacement', now: '2026-10-22T01:00:00Z', skillVersion: '0.16.0' });
  const result = validateNote(replacement, { existing: original });
  assert.equal(result.valid, false);
  assert.equal(has(result, 'metadata-identity-changed'), true);
  assert.equal(has(result, 'metadata-descriptions-changed'), true);
});

test('image-only and autolink-only headings cannot produce an empty consumer section ID', () => {
  for (const heading of ['![label](image.png)', '<https://example.test>', '`![label](image.png)`', '<span title=">not a title"></span>']) {
    assert.equal(has(validateNote(`# Topic\n\n## ${heading}\n\nBody.`), 'empty-heading-id'), true, heading);
  }
});

test('raw HTML budgets count each text child and quoted attributes are not visible body', () => {
  assert.equal(has(validateNote('# T\n\n## A\n\n<div>\n' + '<span>text</span>\n'.repeat(10000) + '</div>'), 'section-body-limit'), true);
  assert.equal(has(validateNote('# T\n\n## A\n\n<div title=">attribute text"></div>'), 'empty-body'), true);
  assert.equal(has(validateNote('# T\n\n## A\n\n' + '<div/>'.repeat(33) + 'text'), 'section-body-limit'), true);
});

test('HTML destinations reject decoded leading whitespace and active attributes only inside tags', () => {
  for (const destination of [' javascript:alert(1)', '&#32;javascript:alert(1)', '&#x20;data:text/html,bad', ' //example.test']) {
    const result = validateNote(`# Topic\n\n## Answer\n\n<a href="${destination}">text</a>`);
    assert.equal(has(result, 'unsafe-destination'), true, destination);
  }
  for (const body of ['<div>font style = bold</div>', '<span title="style = bold">text</span>', '<div>onclick=example is text</div>']) {
    assert.equal(validateNote(`# Topic\n\n## Answer\n\n${body}`).valid, true, body);
  }
  for (const body of ['<div style="font-weight: bold">text</div>', '<span onclick="bad()">text</span>']) {
    assert.equal(has(validateNote(`# Topic\n\n## Answer\n\n${body}`), 'unsafe-html'), true);
  }
});

test('new generated notes require exactly one topic H1 while existing multi-topic structure stays valid', () => {
  const body = '# First\n\n## Answer\n\nOne.\n\n# Second\n\n## Answer\n\nTwo.\n';
  assert.equal(validateNote(body).valid, true);
  assert.equal(has(validateNote(createGeneratedNote(body, { now: '2026-10-22T01:00:00Z', skillVersion: '0.16.0' }), { generated: true }), 'topic-h1-count'), true);
});

test('overlong adversarial headings stop at the source-line bound before Markdown inspection', () => {
  const source = `# Topic\n\n## ${'<script>'.repeat(NOTE_PROFILE.lineBytes)}\n\nBody.`;
  const result = validateNote(source);
  assert.deepEqual(result.diagnostics, [{ code: 'source-line-limit', line: 3, severity: 'error' }]);
  assert.deepEqual(result.sections, []);
});

test('HTML attribute scanning handles stray slashes and adjacent quoted attributes without reading values as names', () => {
  const note = html => `# Topic\n\n## Answer\n\n<div>\n${html}\n</div>`;
  for (const html of ['<a/href="javascript:alert(1)">link</a>', '<a title="safe"href="javascript:alert(1)">link</a>', '<img/src="&#32;javascript:alert(1)">']) {
    const result = validateNote(note(html));
    assert.equal(result.valid, false, html); assert.equal(has(result, 'unsafe-destination'), true, html);
  }
  for (const html of ['<div/style="color:red">text</div>', '<img/onerror="alert(1)" src="https://example.test/x.png">', '<span title="safe"onclick="bad()">text</span>', '<div/ /style="color:red">text</div>', '<img src=x" onerror=alert(1)>', '<img src=x=" onerror=alert(1)>']) {
    const result = validateNote(note(html));
    assert.equal(result.valid, false, html); assert.equal(has(result, 'unsafe-html'), true, html);
  }
  for (const html of ['<span title="/onerror=bad href=javascript:bad style = bold">text</span>', '<span title=x/onerror=bad>text</span>', '<div>font style = bold</div>', '<a/href="&#32;https://example.test">link</a>']) {
    assert.equal(validateNote(note(html)).valid, true, html);
  }
});
