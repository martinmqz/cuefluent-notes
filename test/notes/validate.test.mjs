import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_PROFILE } from '../../src/notes/profile.mjs';
import { createGeneratedNote } from '../../src/notes/metadata.mjs';
import { assertOrdinaryTarget, isLogEntryMarker, validateNote } from '../../src/notes/validate.mjs';

const marker = '<!-- note-log-entry event=12345678-1234-4123-8123-123456789abc project=synthetic -->';
const has = (result, code) => result.diagnostics.some(issue => issue.code === code);

test('plain notes and generated notes have visible H2 bodies', () => {
  const plain = '# Topic\n\n## Answer\n\nUseful content.\n';
  assert.equal(validateNote(plain).valid, true);
  assert.equal(validateNote(createGeneratedNote(plain, { now: '2026-10-22T01:00:00Z', skillVersion: '2.0.0' }), { generated: true }).valid, true);
  assert.equal(has(validateNote('# Topic\n\nOnly introduction.'), 'no-answer-sections'), true);
  assert.equal(has(validateNote('# Topic\n\n## Answer\n\n<!-- comment -->\n'), 'empty-body'), true);
  assert.equal(validateNote('## Existing plain section\n\nBody.').valid, true);
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
  const original = createGeneratedNote('# T\n\n## A\n\nBody.', { id: 'original', now: '2026-10-22T01:00:00Z', skillVersion: '2.0.0', metadata: { custom: 'keep' } });
  const replacement = createGeneratedNote('# T\n\n## A\n\nChanged body.', { id: 'replacement', now: '2026-10-22T01:00:00Z', skillVersion: '2.0.0' });
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
