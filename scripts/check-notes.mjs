import fs from 'node:fs/promises';
import path from 'node:path';
import { isMain, readBoundedBytes } from './file-io.mjs';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

export const GUIDE_VERSION = '2026-09-21.1';
export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_CASES = 200;
const MAX_DIAGNOSTICS = 100;
const md = new MarkdownIt({ html: true }).use(footnote);
// Parse destinations for inspection only. No rendering, execution or resource loading.
md.validateLink = () => true;
const words = value => value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const normalize = value => words(value).join(' ');
const inlineText = tokens => (tokens ?? []).map(t => {
  if (['text', 'code_inline'].includes(t.type)) return t.content;
  if (['softbreak', 'hardbreak'].includes(t.type)) return ' ';
  return t.children ? inlineText(t.children) : '';
}).join('');
const allTokens = tokens => tokens.flatMap(t => [t, ...allTokens(t.children ?? [])]);

/** Advisory subset check, not the Cuefluent parser/sanitizer or ranking engine. */
export function inspectMarkdown(source, file = '<input>') {
  const tokens = md.parse(source, {});
  const sections = [];
  const diagnostics = [];
  const add = (severity, code, line, message) => diagnostics.push({ severity, code, file, line, message });
  let h1 = '';
  let current;
  const finish = () => {
    if (!current) return;
    const visible = allTokens(current.body).some(t =>
      (['text', 'code_inline', 'code_block', 'fence'].includes(t.type) && t.content.trim()) || t.type === 'image');
    const html = allTokens(current.body).some(t => ['html_inline', 'html_block'].includes(t.type) && /<(?![!\s])/.test(t.content));
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
      if (['html_inline', 'html_block'].includes(child.type) && /<(?![!\s])/.test(child.content)) {
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
  return { sections, diagnostics };
}

export function reviewVocabulary(sections, cases = []) {
  const diagnostics = [];
  const aliases = new Map();
  for (const section of sections) {
    for (const alias of new Set(section.aliases.map(normalize))) {
      if (aliases.has(alias)) diagnostics.push({ severity: 'warning', code: 'shared-alias', file: section.file, line: section.line, message: 'An alias is shared by multiple sections; review whether the overlap is useful.' });
      aliases.set(alias, section);
    }
  }
  for (const [index, item] of cases.entries()) {
    const targets = sections.filter(s => s.file === item.file && s.heading === item.heading && (item.h1 === undefined || s.h1 === item.h1));
    const base = { severity: 'error', file: item.file, line: targets[0]?.line ?? 1 };
    if (targets.length !== 1) {
      diagnostics.push({ ...base, code: 'case-target', message: `Case ${index + 1}: expected exactly one matching file and H1/H2 heading path.` });
      continue;
    }
    const vocabulary = new Set(words([targets[0].h1, targets[0].heading, ...targets[0].aliases].join(' ')));
    if (!words(item.query).every(word => vocabulary.has(word))) diagnostics.push({ ...base, code: 'vocabulary-gap', message: `Case ${index + 1}: query words missing from heading context or aliases.` });
  }
  return diagnostics;
}

export async function readBounded(file) {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBytes(file, { maxBytes: MAX_BYTES }));
}

export async function checkFiles(files, casePath) {
  if (!files.length || files.length > MAX_FILES) throw new Error('Select 1–100 Markdown files explicitly.');
  const canonical = await Promise.all(files.map(f => fs.realpath(f)));
  if (new Set(canonical).size !== canonical.length) throw new Error('Select each file once, including symlink aliases.');
  if (files.some(f => !/\.(md|markdown)$/i.test(f))) throw new Error('Inputs must use .md or .markdown extensions.');
  const results = [];
  for (const file of canonical) results.push(inspectMarkdown(await readBounded(file), file));
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
  const diagnostics = [...results.flatMap(r => r.diagnostics), ...reviewVocabulary(sections, cases)];
  const errors = diagnostics.filter(d => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  return {
    guideVersion: GUIDE_VERSION, files: canonical.length, sections: sections.length, cases: cases.length,
    errors, warnings, diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS), omittedDiagnostics: Math.max(0, diagnostics.length - MAX_DIAGNOSTICS),
    limits: 'Advisory Markdown subset and vocabulary coverage only. Expected information requires human/agent evidence review. No app rendering, admission, sanitization, image loading, ranking or factual verification.'
  };
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/check-notes.mjs [--cases cases.json] <note.md ...>\nRead-only JSON report; exit 0 no errors, 1 check errors, 2 input/usage failure.');
    return 0;
  }
  let casePath;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cases' && !casePath && args[i + 1] && !args[i + 1].startsWith('--')) casePath = args[++i];
    else if (args[i].startsWith('-')) throw new Error('Unknown or incomplete option; use --help.');
    else files.push(args[i]);
  }
  const report = await checkFiles(files, casePath);
  console.log(JSON.stringify(report, null, 2));
  return report.errors ? 1 : 0;
}
if (await isMain(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`Check failed: ${String(error.message).slice(0, 500)}`); process.exitCode = 2; }
}
