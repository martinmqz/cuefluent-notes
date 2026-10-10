import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkFiles, inspectMarkdown, reviewVocabulary, MAX_BYTES } from './check-notes.mjs';
import { prepareNote } from './note-generation.mjs';

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
test('competing queries use normalized H1/H2/alias words and retain both locations without private text', () => {
  const a = inspectMarkdown('# Atlas\n## Retry\n<!-- aliases: manual retry -->\nEvidence.\n## Manual retry\nEvidence.', '/a.md');
  const b = inspectMarkdown('# ＡＴＬＡＳ\n## Procedure\n<!-- aliases: manual, retry -->\nEvidence.', '/b.md');
  const body = inspectMarkdown('# Other\n## Body\nAtlas manual retry.', '/body.md');
  const sections = [...a.sections, ...b.sections, ...body.sections];
  const query = 'ATLAS manual-retry manual', expected = 'Private expected evidence marker';
  const report = reviewVocabulary(sections, [{ file: '/a.md', heading: 'Retry', query, expected }]);
  assert.equal(report.length, 2);
  assert.deepEqual(report.map(d => [d.code, d.severity, d.file, d.line, d.relatedFile, d.relatedLine]), [
    ['competing-query', 'warning', '/a.md', 2, '/a.md', 5],
    ['competing-query', 'warning', '/a.md', 2, '/b.md', 2]
  ]);
  assert.ok(report.every(d => d.message.startsWith('Case 1:')));
  assert.ok(!JSON.stringify(report).includes(query));
  assert.ok(!JSON.stringify(report).includes(expected));
  assert.deepEqual(reviewVocabulary(sections), []);
});
test('competition respects unique case targets and H1 context, even when target vocabulary is missing', () => {
  const { sections } = inspectMarkdown('# Payments\n## Setup\nEvidence.\n# Refunds\n## Setup\nEvidence.\n## Return\n<!-- aliases: refund request -->\nEvidence.', '/a.md');
  const item = { file: '/a.md', heading: 'Setup', query: 'payments setup' };
  assert.deepEqual(reviewVocabulary(sections, [{ ...item, h1: 'Payments' }]), []);
  for (const value of [item, { ...item, heading: 'Missing' }]) {
    assert.deepEqual(reviewVocabulary(sections, [value]).map(d => d.code), ['case-target']);
  }
  const result = reviewVocabulary(sections, [{ ...item, h1: 'Refunds', query: 'refund request' }]);
  assert.deepEqual(result.map(d => d.code), ['vocabulary-gap', 'competing-query']);
  assert.equal(result[1].relatedLine, 7);
});
test('case targets are indexed once instead of rescanning every section for every case', () => {
  let fileReads = 0;
  const sections = Array.from({ length: 5000 }, (_, i) => ({
    get file() { fileReads++; return '/note.md'; },
    heading: i === 0 ? 'Unique' : `Section ${i}`, h1: 'Topic', aliases: [], line: i + 1
  }));
  const cases = Array.from({ length: 200 }, () => ({ file: '/note.md', heading: 'Unique', query: 'unique' }));
  assert.deepEqual(reviewVocabulary(sections, cases), []);
  assert.ok(fileReads < sections.length * 4, `target lookup file reads: ${fileReads}`);
});
test('HTML visibility and all images remain explicitly unverified', () => {
  assert.ok(codes(inspectMarkdown('# T\n## S\n<div>Text</div>')).includes('html-only-body'));
  const image = inspectMarkdown('# T\n## S\n![example](file:///private/example.png)');
  assert.ok(codes(image).includes('image-path'));
  assert.ok(codes(image).includes('image-unchecked'));
  assert.ok(!codes(image).includes('empty-body'));
});
test('abrupt and alternate comment endings preserve adjacent visible HTML diagnostics', () => {
  for (const comment of ['<!-->', '<!--->', '<!-- c --!>', '<!-- c -->', '<!-- c --->']) {
    for (const html of ['<b>visible</b>', '<img src=x onerror=alert(1)>']) {
      const source = '# Topic\n\n## Result\n\n' + comment + ' ' + html + '\n';
      const report = codes(inspectMarkdown(source));
      assert(report.includes('html-unchecked'), source);
      assert(report.includes('html-only-body'), source);
      assert(!report.includes('empty-body'), source);
    }
    assert(codes(inspectMarkdown('# Topic\n\n## Result\n\n' + comment)).includes('empty-body'));
  }
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
test('competition diagnostics stream into capped reports with complete severity totals', async t => {
  const { directory, file } = await fixture(t);
  await fs.writeFile(file, '# Topic\n' + Array.from({ length: 150 }, (_, i) => `## S${i}\nEvidence.\n`).join(''));
  const cases = path.join(directory, 'cases.json');
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: [{ file: 'note.md', heading: 'S0', query: 'topic', expected: 'Evidence.' }] }));
  const report = await checkFiles([file], cases);
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 149);
  assert.equal(report.diagnostics.length, 100);
  assert.equal(report.omittedDiagnostics, 49);
  assert.ok(report.diagnostics.every(d => d.code === 'competing-query'));
  assert.deepEqual(report.competingQueries, { complete: true, comparisonLimit: 1_000_000 });
  assert.ok(!Object.hasOwn(await checkFiles([file]), 'competingQueries'));
});
test('competition budget distinguishes exactly complete work from an incomplete review and preserves later case checks', async t => {
  const { directory, file } = await fixture(t);
  const document = count => '# Topic\n' + Array.from({ length: count }, (_, i) => `## S${i}\nEvidence.\n`).join('');
  await fs.writeFile(file, document(5001));
  const cases = path.join(directory, 'cases.json');
  const items = Array.from({ length: 200 }, () => ({ file: 'note.md', heading: 'S0', query: 'topic', expected: 'Evidence.' }));
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: items }));
  const exact = await checkFiles([file], cases);
  assert.equal(exact.competingQueries.complete, true);
  assert.equal(exact.warnings, 1_000_000);
  assert.equal(exact.omittedDiagnostics, 999_900);
  await fs.writeFile(file, document(6001));
  items[198].heading = 'Missing';
  items[199].query = 'bodyonly';
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: items }));
  const limited = await checkFiles([file], cases);
  assert.equal(limited.competingQueries.complete, false);
  assert.equal(limited.competingQueries.firstIncompleteCase, 167);
  assert.equal(limited.warnings, 1_000_001);
  assert.equal(limited.errors, 2); // Later case-target and vocabulary-gap still checked.
  assert.equal(limited.diagnostics.length, 100);
  assert.equal(limited.omittedDiagnostics, 999_903);
  // The completeness flag remains visible when the limit warning itself is omitted.
  assert.deepEqual(limited.diagnostics.slice(0, 2).map(d => d.code), ['case-target', 'vocabulary-gap']);
  assert.ok(limited.diagnostics.slice(2).every(d => d.code === 'competing-query'));
});
test('late note ID collisions remain displayed after competing-query warnings fill the report', async t => {
  const { directory, file } = await fixture(t);
  const other = path.join(directory, 'other.md');
  const content = '# Topic\n' + Array.from({ length: 110 }, (_, i) => `## S${i}\nEvidence.\n`).join('');
  const note = prepareNote({ original: null, content, now: '2026-10-09T12:00:00Z', skillVersion: '0.12.0' }).content;
  await fs.writeFile(file, note);
  await fs.writeFile(other, note);
  const cases = path.join(directory, 'cases.json');
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: [{ file: 'note.md', heading: 'S0', query: 'topic', expected: 'Evidence.' }] }));
  const report = await checkFiles([file, other], cases);
  assert.equal(report.errors, 1);
  assert.equal(report.warnings, 219);
  assert.equal(report.diagnostics.length, 100);
  assert.equal(report.omittedDiagnostics, 120);
  assert.equal(report.diagnostics[0].code, 'metadata-id-collision');
  assert.equal(report.diagnostics[0].file, await fs.realpath(other));
  assert.equal(report.diagnostics[0].relatedFile, await fs.realpath(file));
});
test('competition shares long H1 vocabulary across many sections within a bounded heap', async t => {
  const { directory, file } = await fixture(t);
  const heading = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ');
  await fs.writeFile(file, `# ${heading}\n` + Array.from({ length: 2000 }, (_, i) => `## S${i}\nEvidence.\n`).join(''));
  const cases = path.join(directory, 'cases.json');
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: [{ file: 'note.md', heading: 'S0', query: 'word0', expected: 'Evidence.' }] }));
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', fileURLToPath(new URL('./check-notes.mjs', import.meta.url)), '--cases', cases, file],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 512 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 1999);
  assert.equal(report.omittedDiagnostics, 1899);
  assert.equal(report.competingQueries.complete, true);
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

test('256 selected files check identities, aliases and cases across the former 100-file boundary', async t => {
  const { directory } = await fixture(t);
  const files = Array.from({ length: 256 }, (_, i) => path.join(directory, `${String(i).padStart(3, '0')}.md`));
  const note = prepareNote({ original: null, content: '# Topic\n## Shared\n<!-- aliases: collision -->\nEvidence.\n',
    now: '2026-10-09T12:00:00Z', skillVersion: '0.12.0' }).content;
  await Promise.all(files.map((file, i) => fs.writeFile(file, i === 0 || i === 255 ? note : '# Topic\n## Unique\nEvidence.\n')));
  const cases = path.join(directory, 'cases.json');
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: [{ file: '255.md', heading: 'Shared', query: 'collision', expected: 'Evidence.' }] }));
  const report = await checkFiles(files, cases);
  assert.equal(report.files, 256); assert.equal(report.cases, 1);
  assert(codes(report).includes('metadata-id-collision')); assert(codes(report).includes('shared-alias'));
  await assert.rejects(checkFiles([...files, path.join(directory, 'note.md')]), /256/);
});

test('folder mode is recursive, deterministic and rejects every overlap with path boundaries', async t => {
  const { directory, file } = await fixture(t);
  const sub = path.join(directory, '.hidden'); await fs.mkdir(sub);
  await fs.writeFile(path.join(sub, 'B.MARKDOWN'), '# Topic\n## Empty\n');
  await fs.writeFile(path.join(directory, 'a.md'), '# Topic\n## Empty\n');
  await fs.writeFile(path.join(directory, 'ignored.txt'), 'not markdown');
  const report = await checkFiles([], undefined, { folders: [directory] });
  assert.equal(report.files, 3); assert.equal(report.scan.visitedEntries, 6); assert.equal(report.scan.skippedLinks, 0);
  assert.deepEqual(report.diagnostics.map(d => path.basename(d.file)), ['B.MARKDOWN', 'a.md']);
  for (const folders of [[directory, directory], [directory, sub], [sub, directory]])
    await assert.rejects(checkFiles([], undefined, { folders }), /overlapping selections/);
  await assert.rejects(checkFiles([file], undefined, { folders: [directory] }), error =>
    error.message.includes('overlapping') && error.message.includes('note.md'));
  await assert.rejects(checkFiles([], undefined, { folders: [file] }), /must be a directory/);
  const sibling = directory + '-sibling'; await fs.mkdir(sibling); t.after(() => fs.rm(sibling, { recursive: true, force: true }));
  await fs.writeFile(path.join(sibling, 'other.md'), '# T\n## S\nEvidence.\n');
  assert.equal((await checkFiles([], undefined, { folders: [directory, sibling] })).files, 4);
});

async function linkOrSkip(t, target, link, type) {
  try { await fs.symlink(target, link, type); return true; }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Native link creation unavailable'); return false; } throw error; }
}
test('folder links/junctions are counted, root links rejected, and linked parents allowed', async t => {
  const { directory } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-check-target-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const child = path.join(outside, 'child'); await fs.mkdir(child);
  await fs.writeFile(path.join(child, 'note.md'), '# T\n## S\nEvidence.\n');
  const link = path.join(directory, 'linked');
  if (!await linkOrSkip(t, outside, link, process.platform === 'win32' ? 'junction' : 'dir')) return;
  const report = await checkFiles([], undefined, { folders: [directory] });
  assert.equal(report.files, 1); assert.equal(report.scan.skippedLinks, 1); assert.equal(report.scan.visitedEntries, 3);
  await assert.rejects(checkFiles([], undefined, { folders: [link] }), /must not be a link/);
  assert.equal((await checkFiles([], undefined, { folders: [path.join(link, 'child')] })).files, 1);
  await assert.rejects(checkFiles([], undefined, { folders: [child, path.join(link, 'child')] }), /overlapping/);
});
test('discovered file links are excluded while explicitly selected file links resolve normally', async t => {
  const { directory, file } = await fixture(t), link = path.join(directory, 'alias.md');
  if (!await linkOrSkip(t, file, link, 'file')) return;
  assert.equal((await checkFiles([], undefined, { folders: [directory] })).scan.skippedLinks, 1);
  assert.equal((await checkFiles([link])).files, 1);
  await assert.rejects(checkFiles([file, link]), /once/);
  await assert.rejects(checkFiles([link], undefined, { folders: [directory] }), /overlapping/);
});

test('folder entry/depth bounds are exact and aggregate entries across selected roots', async t => {
  const { directory } = await fixture(t);
  // Root plus note.md plus 4094 non-Markdown entries exactly fills the shared budget.
  for (let i = 0; i < 4094; i++) await fs.writeFile(path.join(directory, `ignored-${i}.txt`), '');
  assert.equal((await checkFiles([], undefined, { folders: [directory] })).scan.visitedEntries, 4096);
  const other = await fixture(t);
  await assert.rejects(checkFiles([], undefined, { folders: [directory, other.directory] }), /4096/);
  await fs.writeFile(path.join(directory, 'overflow.txt'), '');
  await assert.rejects(checkFiles([], undefined, { folders: [directory] }), /4096/);
  let leaf = other.directory;
  for (let i = 0; i < 64; i++) { leaf = path.join(leaf, 'd'); await fs.mkdir(leaf); }
  await fs.writeFile(path.join(leaf, 'deep.md'), '# T\n## S\nEvidence.\n');
  assert.equal((await checkFiles([], undefined, { folders: [other.directory] })).files, 2);
  await fs.mkdir(path.join(leaf, 'overflow'));
  await assert.rejects(checkFiles([], undefined, { folders: [other.directory] }), /64 levels/);
});

test('folder overflow and bad selected inputs fail with exit 2 and no partial report', async t => {
  const { directory, file } = await fixture(t);
  const cli = fileURLToPath(new URL('./check-notes.mjs', import.meta.url));
  const invoke = () => spawnSync(process.execPath, [cli, '--folder', directory], { encoding: 'utf8' });
  for (const data of [Buffer.from([0xc3, 0x28]), Buffer.alloc(MAX_BYTES + 1)]) {
    await fs.writeFile(file, data);
    const result = invoke(); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /selection incomplete/); assert.match(result.stderr, /note.md/);
  }
  await fs.writeFile(file, '# T\n## S\nEvidence.\n');
  const open = fs.open;
  t.mock.method(fs, 'open', async function (target, ...args) {
    if (target === await fs.realpath(file)) throw Object.assign(new Error('private OS details'), { code: 'EACCES' });
    return open.call(this, target, ...args);
  });
  await assert.rejects(checkFiles([], undefined, { folders: [directory] }), error => /note.md/.test(error.message) &&
    error.message.includes('EACCES') && !error.message.includes('private OS details'));
  t.mock.restoreAll();
  for (let i = 0; i < 256; i++) await fs.writeFile(path.join(directory, `${i}.md`), '# T\n## S\nEvidence.\n');
  const result = invoke(); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /256/);
});

test('usage and cases errors are not mislabeled as incomplete file selection', async t => {
  const { directory, file } = await fixture(t);
  const cli = fileURLToPath(new URL('./check-notes.mjs', import.meta.url));
  const cases = path.join(directory, 'cases.json');
  const assertFailure = (args, reason) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, reason); assert.doesNotMatch(result.stderr, /selection incomplete/i);
  };
  assertFailure(['--case', cases, file], /Unknown or incomplete option/);
  await fs.writeFile(cases, '{');
  assertFailure(['--cases', cases, file], /Cases file must contain valid JSON/);
  await fs.writeFile(cases, JSON.stringify({ version: 1, cases: [{}] }));
  assertFailure(['--cases', cases, file], /requires query, file, heading and expected/);
});

test('guarded identity failures use their code regardless of internal error wording', async t => {
  const { directory, file } = await fixture(t), canonical = await fs.realpath(file);
  const open = fs.open;
  t.mock.method(fs, 'open', async function (target, ...args) {
    if (target === canonical) throw Object.assign(new Error('Different private implementation details'), { code: 'FILE_IDENTITY_CHANGED' });
    return open.call(this, target, ...args);
  });
  await assert.rejects(checkFiles([], undefined, { folders: [directory] }), error =>
    error.message.includes('File identity changed during checking.') &&
    error.message.includes('FILE_IDENTITY_CHANGED') && !error.message.includes('private implementation'));
});

test('loaded deep folders keep filesystem probes proportional to entries', async t => {
  const { directory } = await fixture(t); let leaf = directory;
  for (let i = 0; i < 63; i++) { leaf = path.join(leaf, 'd'); await fs.mkdir(leaf); }
  for (let i = 0; i < 1024; i++) await fs.mkdir(path.join(leaf, `e${i}`));
  let probes = 0;
  for (const method of ['lstat', 'realpath']) {
    const original = fs[method];
    t.mock.method(fs, method, async (...args) => { probes++; return original(...args); });
  }
  const report = await checkFiles([], undefined, { folders: [directory] });
  assert.equal(report.scan.visitedEntries, 1089);
  assert(probes < 20000, `bounded filesystem probes: ${probes}`);
});

test('folder mode refuses FIFO Markdown without blocking or partial output', { skip: process.platform === 'win32' }, async t => {
  const { directory } = await fixture(t);
  assert.equal(spawnSync('mkfifo', [path.join(directory, 'pipe.md')]).status, 0);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-notes.mjs', import.meta.url)), '--folder', directory],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2, String(result.error ?? result.stderr));
  assert.equal(result.stdout, ''); assert.match(result.stderr, /regular/);
});
