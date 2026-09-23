import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkFiles, inspectMarkdown, reviewVocabulary, MAX_BYTES } from './check-notes.mjs';

const codes = report => report.diagnostics.map(d => d.code);
test('root ATX/Setext headings retain tables, code, lists, quotes and deeper headings', () => {
  const doc = `Topic\n=====\n\nSection\n-------\n\n<!-- aliases: alternate -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n1. First\n   - nested\n\n> ## Quoted, not an entry\n\n### Detail\n\n\`\`\`md\n## In code\n<!-- aliases: literal -->\n\`\`\`\n`;
  const result = inspectMarkdown(doc);
  assert.deepEqual(result.sections.map(s => [s.h1, s.heading, s.aliases]), [['Topic', 'Section', ['alternate']]]);
  assert.deepEqual(result.diagnostics, []);
});
test('comments, metadata, reference and unused footnote definitions do not supply body content', () => {
  for (const body of ['', '<!-- comment -->', '<!-- aliases: foo -->', '[link]: https://example.com', '[^n]: Just a definition']) {
    assert.ok(codes(inspectMarkdown(`# Topic\n\n## Empty\n\n${body}\n`)).includes('empty-body'), body);
  }
});
test('missing H1 warns, missing root H2 fails, H1 ends preceding body', () => {
  assert.ok(codes(inspectMarkdown('## Section\nContent')).includes('missing-h1'));
  assert.ok(codes(inspectMarkdown('# Topic\n> ## Nested\n> Text')).includes('missing-h2'));
  assert.ok(codes(inspectMarkdown('# A\n## Empty\n# B\nContent outside a section')).includes('empty-body'));
});
test('code before H2 is reported as omitted entry content', () => {
  for (const body of ['```sh\nimportant instruction\n```', '    important instruction']) {
    assert.ok(codes(inspectMarkdown(`# T\n\n${body}\n\n## S\nBody`)).includes('outside-section'));
  }
});
test('alias errors retain locations and normalized collisions are detected', () => {
  const result = inspectMarkdown('# Topic\n## A\n<!-- aliases: auth, AUTH -->\nText\n<!-- aliases: later -->\n## a\nText');
  for (const code of ['alias-duplicate', 'alias-placement', 'heading-collision']) assert.ok(codes(result).includes(code));
  assert.equal(result.diagnostics.find(d => d.code === 'alias-placement').line, 5);
  for (const directive of ['<!-- aliases: -->', '<!-- aliases: , x -->', '<!-- aliases: x\ny -->', '<!-- aliases: missing']) {
    assert.ok(codes(inspectMarkdown(`# T\n## S\n${directive}\n`)).includes('alias-syntax'));
  }
});
test('body-only vocabulary fails while H1, H2, aliases cover useful queries', () => {
  const { sections } = inspectMarkdown('# Atlas\n## Retry decision\n<!-- aliases: manual retry -->\nLantern is in the body.', '/note.md');
  assert.equal(reviewVocabulary(sections, [{ query: 'ATLAS manual-retry', file: '/note.md', heading: 'Retry decision' }]).length, 0);
  assert.equal(reviewVocabulary(sections, [{ query: 'Lantern', file: '/note.md', heading: 'Retry decision' }])[0].code, 'vocabulary-gap');
  assert.equal(reviewVocabulary(sections, [{ query: 'x', file: '/note.md', heading: 'Missing' }])[0].code, 'case-target');
});
test('cross-file alias overlap warns without declaring an app ranking', () => {
  const a = inspectMarkdown('# T\n## A\n<!-- aliases: overlap -->\nText', '/a.md');
  const b = inspectMarkdown('# T\n## B\n<!-- aliases: OVERLAP -->\nText', '/b.md');
  assert.equal(reviewVocabulary([...a.sections, ...b.sections])[0].code, 'shared-alias');
});
test('HTML visibility and all images remain explicitly unverified', () => {
  assert.ok(codes(inspectMarkdown('# T\n## S\n<div>Text</div>')).includes('html-only-body'));
  const image = inspectMarkdown('# T\n## S\n![example](file:///private/example.png)');
  assert.ok(codes(image).includes('image-path'));
  assert.ok(codes(image).includes('image-unchecked'));
  assert.ok(!codes(image).includes('empty-body'));
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-check-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'note.md');
  await fs.writeFile(file, '# Topic\n\n## Useful subject\n\nEvidence.\n');
  return { directory, file };
}
test('read-only file checks, relative cases, duplicate inputs and invalid cases', async t => {
  const { directory, file } = await fixture(t);
  const before = await fs.readFile(file);
  const cases = path.join(directory, 'cases.json');
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: [{ file: 'note.md', query: 'useful topic', heading: 'Useful subject', expected: 'Evidence remains a manual check.' }] }));
  const result = await checkFiles([file], cases);
  assert.equal(result.errors, 0);
  assert.equal(result.cases, 1);
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(checkFiles([file, file]), /once/);
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: [{ file: 'note.md', query: 'topic', heading: 'Useful subject' }] }));
  await assert.rejects(checkFiles([file], cases), /expected information/);
  await fs.writeFile(cases, '{"query":private-project-secret}');
  await assert.rejects(checkFiles([file], cases), error => error.message === 'Cases file must contain valid JSON.');
});
test('invalid UTF-8 and oversized inputs fail and diagnostic limits retain severity totals', async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, Buffer.from([0xc3, 0x28]));
  await assert.rejects(checkFiles([file]), /encoded data/);
  await fs.writeFile(file, Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(checkFiles([file]), /2 MiB/);
  await fs.writeFile(file, '# T\n' + Array.from({ length: 120 }, (_, i) => `## ${i}\n`).join(''));
  const result = await checkFiles([file]);
  assert.equal(result.errors, 120);
  assert.equal(result.diagnostics.length, 100);
  assert.equal(result.omittedDiagnostics, 20);
});

test('cases can select repeated H2 headings by their H1 context', async t => {
  const { directory, file } = await fixture(t);
  await fs.writeFile(file, '# Payments\n## Setup\nPayment evidence.\n# Refunds\n## Setup\nRefund evidence.\n');
  const cases = path.join(directory, 'cases.json');
  const item = { file: 'note.md', query: 'refunds setup', heading: 'Setup', expected: 'Refund evidence.' };
  const check = async value => {
    await fs.writeFile(cases, JSON.stringify({ version: 1, cases: [value] }));
    return checkFiles([file], cases);
  };
  assert.ok(codes(await check(item)).includes('case-target'));
  assert.equal((await check({ ...item, h1: 'Refunds' })).errors, 0);
  assert.ok(codes(await check({ ...item, h1: 'Missing' })).includes('case-target'));
  await assert.rejects(check({ ...item, h1: 3 }), /h1/);
});
