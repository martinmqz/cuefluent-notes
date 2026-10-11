import fs from 'node:fs/promises';
import path from 'node:path';
import { isMain, readBoundedBytes, sameFileIdentity, compare, within, CONTROLS } from './file-io.mjs';
import { createNoteMarkdownParser, inspectNoteMetadata, registerNoteIdentity } from './note-metadata.mjs';
import { safeErrorCode } from './workflow-values.mjs';

export const GUIDE_VERSION = '2026-09-21.1';
export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 64;
const MAX_CASES = 200;
const MAX_DIAGNOSTICS = 100;
const MAX_COMPETING_COMPARISONS = 1_000_000;
const md = createNoteMarkdownParser();
const visibleHtml = content => content.replace(/<!--(?:-?>|[\s\S]*?(?:--!?>|$))/g, '');
const words = value => value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const normalize = value => words(value).join(' ');
const inlineText = tokens => (tokens ?? []).map(t => {
  if (['text', 'code_inline'].includes(t.type)) return t.content;
  if (['softbreak', 'hardbreak'].includes(t.type)) return ' ';
  return t.children ? inlineText(t.children) : '';
}).join('');
const allTokens = tokens => tokens.flatMap(t => [t, ...allTokens(t.children ?? [])]);

/** Fixed guidance only: never forward a proposed document's text or path. */
export function markdownFailureReason(checked) {
  return checked.metadata?.status === 'invalid'
    ? 'Markdown check: reserved <!-- cuefluent ... --> metadata is invalid. Use check-notes for bounded diagnostics. Existing malformed metadata blocks automatic updates: preserve it and report the block to the user. New metadata belongs before all other content; use prepare-note. Put ordinary <!-- source-review: ... --> comments after valid leading metadata, keeping material facts and limitations visible.'
    : 'A proposed document fails the bundled Markdown check; run check-notes for bounded diagnostics.';
}

/** Advisory subset check, not the Cuefluent parser/sanitizer or ranking engine. */
export function inspectMarkdown(source, file = '<input>') {
  const tokens = md.parse(source.replace(/^\uFEFF/, ''), {});
  const metadata = inspectNoteMetadata(source, file, tokens);
  const sections = [];
  const diagnostics = [...metadata.diagnostics];
  const add = (severity, code, line, message) => diagnostics.push({ severity, code, file, line, message });
  let h1 = '';
  let current;
  const finish = () => {
    if (!current) return;
    const visible = allTokens(current.body).some(t =>
      (['text', 'code_inline', 'code_block', 'fence'].includes(t.type) && t.content.trim()) || t.type === 'image');
    const html = allTokens(current.body).some(t => ['html_inline', 'html_block'].includes(t.type) && /<(?![!\s])/.test(visibleHtml(t.content)));
    if (!visible && !html) add('error', 'empty-body', current.line, 'Section has no visible Markdown body.');
    if (!visible && html) add('warning', 'html-only-body', current.line, 'HTML-only visibility requires a separate sanitization review.');
    delete current.body;
    delete current.started;
    delete current.directiveCount;
  };
  let hasH1 = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const line = (token.map?.[0] ?? 0) + 1;
    if (token.type === 'heading_open' && token.level === 0 && ['h1', 'h2'].includes(token.tag)) {
      finish();
      current = undefined;
      const heading = inlineText(tokens[i + 1]?.children);
      if (!normalize(heading)) add('error', 'empty-heading', line, 'Heading needs a descriptive subject.');
      if (token.tag === 'h1') { h1 = heading; hasH1 = true; }
      else {
        current = { file, line, heading, h1, aliases: [], body: [], started: false, directiveCount: 0 };
        sections.push(current);
      }
      i += 2;
      continue;
    }
    if (token.type === 'footnote_block_open') break;
    const comment = token.type === 'html_block' && token.content.trim().startsWith('<!--');
    if (comment && /<!--\s*aliases\s*:/i.test(token.content)) {
      const match = /^<!-- aliases: ([^\r\n]*?) -->\s*$/.exec(token.content);
      if (!current || current.started || token.level !== 0 || ++current.directiveCount > 1) {
        add('error', 'alias-placement', line, 'Use one alias directive before section body content.');
      }
      if (!match || match[1].split(',').some(v => !normalize(v))) {
        add('error', 'alias-syntax', line, 'Use a single line: <!-- aliases: phrase, other phrase -->.');
      } else if (current) {
        current.aliases.push(...match[1].split(',').map(v => v.trim()));
      }
      continue;
    }
    for (const child of allTokens([token])) {
      if (child.type === 'html_inline' && /<!--\s*aliases\s*:/i.test(child.content)) {
        add('error', 'alias-placement', line, 'Alias directives must precede the section body.');
      }
      if (['html_inline', 'html_block'].includes(child.type) && /<(?![!\s])/.test(visibleHtml(child.content))) {
        add('warning', 'html-unchecked', line, 'Raw HTML sanitization and resulting content are not checked.');
      }
      if (child.type === 'image') {
        const src = child.attrGet('src') ?? '';
        const remote = /^https?:\/\//i.test(src);
        const unsupported = !remote && (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(src));
        if (unsupported) add('warning', 'image-path', line, 'Image is not a relative path or HTTP(S) URL.');
        add('warning', 'image-unchecked', line, 'Verify image target, static PNG/JPEG/WebP format and loading separately.');
      }
    }
    if (current) {
      current.body.push(token);
      if (!comment && token.nesting !== -1) current.started = true;
    } else if ((token.type === 'inline' && inlineText(token.children).trim()) ||
      (['fence', 'code_block'].includes(token.type) && token.content.trim())) {
      add('warning', 'outside-section', line, 'Content outside an H2 section is not an entry body.');
    }
  }
  finish();
  if (!hasH1) add('warning', 'missing-h1', 1, 'No root H1 topic context.');
  if (!sections.length) add('error', 'missing-h2', 1, 'No root H2 sections.');
  const identities = new Set();
  for (const section of sections) {
    const key = JSON.stringify([normalize(section.h1), normalize(section.heading)]);
    if (identities.has(key)) add('error', 'heading-collision', section.line, 'Normalized heading path repeats within this file.');
    identities.add(key);
    const aliases = section.aliases.map(normalize);
    if (new Set(aliases).size < aliases.length) add('warning', 'alias-duplicate', section.line, 'Normalized alias repeats within this section.');
  }
  return { sections, diagnostics, metadata };
}

export function reviewVocabulary(sections, cases = [], { onDiagnostic } = {}) {
  const diagnostics = [];
  const add = onDiagnostic ?? (diagnostic => diagnostics.push(diagnostic));
  const aliases = new Map();
  for (const section of sections) {
    for (const alias of new Set(section.aliases.map(normalize))) {
      if (aliases.has(alias)) add({ severity: 'warning', code: 'shared-alias', file: section.file, line: section.line, message: 'An alias is shared by multiple sections; review whether the overlap is useful.' });
      aliases.set(alias, section);
    }
  }
  // Many sections share an H1; retain its word set once instead of once per H2.
  const vocabularies = new WeakMap(), contexts = new Map();
  const vocabularyFor = section => {
    if (!contexts.has(section.h1)) contexts.set(section.h1, new Set(words(section.h1)));
    if (!vocabularies.has(section)) vocabularies.set(section, new Set(words([section.heading, ...section.aliases].join(' '))));
    return vocabularies.get(section);
  };
  const targetsByFile = new Map();
  if (cases.length) for (const section of sections) {
    let headings = targetsByFile.get(section.file);
    if (!headings) targetsByFile.set(section.file, headings = new Map());
    let match = headings.get(section.heading);
    if (!match) headings.set(section.heading, match = { first: section, count: 0, contexts: new Map() });
    match.count++;
    const context = match.contexts.get(section.h1);
    if (context) context.count++;
    else match.contexts.set(section.h1, { first: section, count: 1 });
  }
  let comparisons = 0, limited = false;
  for (const [index, item] of cases.entries()) {
    const heading = targetsByFile.get(item.file)?.get(item.heading);
    const match = item.h1 === undefined ? heading : heading?.contexts.get(item.h1);
    const base = { severity: 'error', file: item.file, line: match?.first.line ?? 1 };
    if (match?.count !== 1) {
      add({ ...base, code: 'case-target', message: `Case ${index + 1}: expected exactly one matching file and H1/H2 heading path.` });
      continue;
    }
    const target = match.first, vocabulary = vocabularyFor(target);
    const queryWords = [...new Set(words(item.query))];
    if (!queryWords.every(word => contexts.get(target.h1).has(word) || vocabulary.has(word))) add({ ...base, code: 'vocabulary-gap', message: `Case ${index + 1}: query words missing from heading context or aliases.` });
    if (limited || !queryWords.length) continue;
    competitors: for (const section of sections) {
      if (section === target) continue;
      const other = vocabularyFor(section);
      for (const word of queryWords) {
        if (comparisons === MAX_COMPETING_COMPARISONS) {
          limited = true;
          add({ ...base, severity: 'warning', code: 'competing-query-limit', caseNumber: index + 1,
            message: `Case ${index + 1}: competing-query review reached its word-comparison limit; further competition checks were omitted. Target and coverage checks continue.` });
          break competitors;
        }
        comparisons++;
        if (!contexts.get(section.h1).has(word) && !other.has(word)) continue competitors;
      }
      add({ ...base, severity: 'warning', code: 'competing-query', relatedFile: section.file, relatedLine: section.line,
        message: `Case ${index + 1}: the related section also covers every query word in its H1/H2/aliases; review whether this overlap is useful.` });
    }
  }
  return diagnostics;
}

export async function readBounded(file, { noFollow = false } = {}) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBytes(file, { maxBytes: MAX_BYTES, noFollow }));
  } catch (error) {
    const reason = error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? 'Invalid UTF-8 encoded data.'
      : error.code === 'FILE_IDENTITY_CHANGED' ? 'File identity changed during checking.'
      : 'Cannot read a stable regular UTF-8 file within the 2 MiB limit.';
    throw new Error(`Input ${displayPath(file)}: ${reason}${errorCode(error)}`);
  }
}

const displayPath = file => {
  const value = String(file);
  return JSON.stringify(value.length <= 180 ? value : `${value.slice(0, 80)}…${value.slice(-90)}`);
};
const markdownPath = file => /\.(md|markdown)$/i.test(file);
const errorCode = error => { const code = safeErrorCode(error); return code ? ` (${code})` : ''; };
const overlap = (left, right) => { throw new Error(`Select each input once; overlapping selections ${displayPath(left)} and ${displayPath(right)}.`); };
async function selectedPath(file, operation) {
  try { return await operation(); }
  catch (error) {
    if (error.code) throw new Error(`Cannot inspect selected input ${displayPath(file)}.${errorCode(error)}`);
    throw error;
  }
}
async function checkAncestry(ancestry) {
  for (const entry of ancestry) {
    const stat = await fs.lstat(entry.file, { bigint: true });
    if (!stat.isDirectory() || !sameFileIdentity(stat, entry.stat) || await fs.realpath(entry.file) !== entry.file)
      throw new Error(`Folder changed during checking: ${displayPath(entry.file)}.`);
  }
}

async function selectFiles(files, folders) {
  if (files.length > MAX_FILES || folders.length > MAX_ENTRIES) throw new Error('Selection exceeds 256 files or 4096 folder entries.');
  if (files.some(f => !markdownPath(f))) throw new Error('Inputs must use .md or .markdown extensions.');
  const selected = [], roots = [];
  for (const file of files) {
    const canonical = await selectedPath(file, () => fs.realpath(file));
    if (selected.some(item => item.file === canonical)) overlap(file, canonical);
    selected.push({ file: canonical, ancestry: [] });
  }
  for (const folder of folders) {
    const requested = path.resolve(folder);
    const stat = await selectedPath(folder, () => fs.lstat(requested, { bigint: true }));
    // Only the final component must be a real directory; OS/selected parent aliases are allowed.
    if (stat.isSymbolicLink()) throw new Error(`Selected folder must not be a link: ${displayPath(folder)}.`);
    if (!stat.isDirectory()) throw new Error(`Selected folder must be a directory: ${displayPath(folder)}.`);
    const file = await selectedPath(folder, () => fs.realpath(requested));
    for (const root of roots) if (within(root.file, file) || within(file, root.file)) overlap(root.file, file);
    for (const item of selected) if (within(file, item.file)) overlap(file, item.file);
    roots.push({ file, stat });
  }
  let visitedEntries = roots.length, skippedLinks = 0;
  const walk = async (entry, ancestry, depth) => selectedPath(entry.file, async () => {
    if (depth > MAX_DEPTH) throw new Error(`Folder depth exceeds 64 levels: ${displayPath(entry.file)}.`);
    // Retain root authority and this directory's identity. realpath on the latter
    // also detects redirected intermediate parents without O(entries * depth) probes.
    const parents = ancestry.length ? [ancestry[0], entry] : [entry];
    await checkAncestry(parents);
    const children = [];
    for await (const child of await fs.opendir(entry.file)) {
      if (++visitedEntries > MAX_ENTRIES) throw new Error(`Folder traversal exceeds 4096 visited entries at ${displayPath(entry.file)}; selection incomplete.`);
      children.push(child.name);
    }
    await checkAncestry(parents);
    for (const name of children.sort(compare)) {
      const file = path.join(entry.file, name);
      await checkAncestry(parents);
      const stat = await selectedPath(file, () => fs.lstat(file, { bigint: true }));
      if (stat.isSymbolicLink()) { skippedLinks++; continue; }
      if (stat.isDirectory()) await walk({ file, stat }, parents, depth + 1);
      else if (markdownPath(file)) {
        if (!stat.isFile()) throw new Error(`Markdown input is not a regular file: ${displayPath(file)}.`);
        if (selected.length === MAX_FILES) throw new Error('Select at most 256 Markdown files; selection incomplete.');
        selected.push({ file, ancestry: parents });
      }
    }
  });
  for (const root of roots.sort((a, b) => compare(a.file, b.file))) await walk(root, [], 0);
  if (!selected.length) throw new Error('Select 1–256 Markdown files explicitly or through --folder.');
  return { selected: selected.sort((a, b) => compare(a.file, b.file)), visitedEntries, skippedLinks };
}

export async function checkFiles(files, casePath, { folders = [] } = {}) {
  let selection;
  try { selection = await selectFiles(files, folders); }
  catch (error) { throw new Error(`selection incomplete: ${error.message}`); }
  const { selected, visitedEntries, skippedLinks } = selection;
  const canonical = selected.map(item => item.file);
  const results = [];
  for (const { file, ancestry } of selected) {
    try {
      await selectedPath(file, () => checkAncestry(ancestry));
      const source = await readBounded(file, { noFollow: ancestry.length > 0 });
      await selectedPath(file, () => checkAncestry(ancestry));
      results.push(inspectMarkdown(source, file));
    } catch (error) { throw new Error(`selection incomplete: ${error.message}`); }
  }
  let cases = [];
  if (casePath) {
    const serialized = await readBounded(casePath);
    let input;
    try { input = JSON.parse(serialized); }
    catch { throw new Error('Cases file must contain valid JSON.'); }
    if (input?.version !== 1 || !Array.isArray(input.cases) || !input.cases.length || input.cases.length > MAX_CASES) throw new Error('Cases require version 1 and 1–200 cases.');
    for (const [i, item] of input.cases.entries()) {
      if (!item || ['query', 'file', 'heading', 'expected'].some(k => typeof item[k] !== 'string' || !item[k].trim()) || !words(item.query).length) throw new Error(`Case ${i + 1} requires query, file, heading and expected information.`);
      if (item.h1 !== undefined && (typeof item.h1 !== 'string' || !item.h1.trim())) throw new Error(`Case ${i + 1}: optional h1 must be nonempty visible H1 text.`);
      const file = await fs.realpath(path.resolve(path.dirname(casePath), item.file));
      if (!canonical.includes(file)) throw new Error(`Case ${i + 1} references an unselected input.`);
      cases.push({ ...item, file });
    }
  }
  const sections = results.flatMap(r => r.sections);
  const diagnostics = [];
  let errors = 0, warnings = 0, firstIncompleteCase;
  const add = diagnostic => {
    if (diagnostic.severity === 'error') errors++; else warnings++;
    if (diagnostic.code === 'competing-query-limit') firstIncompleteCase = diagnostic.caseNumber;
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
    else if (diagnostic.severity === 'error') {
      // Retain the earliest errors even when a broad query filled the report with warnings.
      const lastWarning = diagnostics.findLastIndex(d => d.severity !== 'error');
      if (lastWarning !== -1) { diagnostics.splice(lastWarning, 1); diagnostics.push(diagnostic); }
    }
  };
  for (const result of results) for (const diagnostic of result.diagnostics) add(diagnostic);
  reviewVocabulary(sections, cases, { onDiagnostic: add });
  const noteIds = new Set(), identityFiles = new Map();
  for (const [index, result] of results.entries()) {
    try {
      const id = registerNoteIdentity(result.metadata, noteIds);
      if (id !== undefined) identityFiles.set(id, canonical[index]);
    } catch (error) {
      if (error.code !== 'NOTE_METADATA_ID_COLLISION') throw error;
      add({ severity: 'error', code: 'metadata-id-collision', file: canonical[index],
        line: result.metadata.block.line, relatedFile: identityFiles.get(result.metadata.value.id),
        message: 'This note shares its ID with the related selected file; resolve identity without merging their content.' });
    }
  }
  diagnostics.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  return {
    guideVersion: GUIDE_VERSION, files: canonical.length, sections: sections.length, cases: cases.length,
    ...(folders.length ? { scan: { roots: folders.length, visitedEntries, skippedLinks,
      coverage: 'Only regular Markdown files beneath the selected folders; symlink and junction targets are excluded. This is not a whole-library inventory.' } } : {}),
    ...(cases.length ? { competingQueries: { complete: firstIncompleteCase === undefined, comparisonLimit: MAX_COMPETING_COMPARISONS,
      ...(firstIncompleteCase === undefined ? {} : { firstIncompleteCase }) } } : {}),
    errors, warnings, diagnostics, omittedDiagnostics: errors + warnings - diagnostics.length,
    limits: 'Advisory Markdown subset and vocabulary coverage only. Expected information requires human/agent evidence review. No app rendering, admission, sanitization, image loading, ranking or factual verification.'
  };
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/check-notes.mjs [--cases cases.json] [--folder directory ...] [note.md ...]\nSelect 1–256 Markdown files. Repeat --folder for multiple roots. Read-only JSON report; exit 0 no errors, 1 check errors, 2 input/usage failure (selection incomplete).');
    return 0;
  }
  let casePath;
  const files = [], folders = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cases' && !casePath && args[i + 1] && !args[i + 1].startsWith('--')) casePath = args[++i];
    else if (args[i] === '--folder' && args[i + 1] && !args[i + 1].startsWith('-')) folders.push(args[++i]);
    else if (args[i].startsWith('-')) throw new Error('Unknown or incomplete option; use --help.');
    else files.push(args[i]);
  }
  const report = await checkFiles(files, casePath, { folders });
  console.log(JSON.stringify(report, null, 2));
  return report.errors ? 1 : 0;
}
if (await isMain(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`Check failed: ${String(error.message).replace(new RegExp(CONTROLS.source, 'g'), ' ').slice(0, 500)}`); process.exitCode = 2; }
}
