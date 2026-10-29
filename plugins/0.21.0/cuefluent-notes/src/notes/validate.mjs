import path from 'node:path';
import { isMarkdownPath } from '../core/note-path.mjs';
import { fail } from '../core/errors.mjs';
import { decodeNote, NOTE_PROFILE as P } from './profile.mjs';
import { inspectMetadata, isSourceAppend, lineStarts, noteContent } from './metadata.mjs';
import { decodeEntities, headingSlug, inlineText, normalizedText, parseMarkdown } from './markdown.mjs';

const safeTags = new Set('p br strong em del s code pre blockquote ul ol li hr table thead tbody tfoot tr th td a img h1 h2 h3 h4 h5 h6 div span sup sub kbd mark'.split(' '));
const voidTags = new Set(['br', 'hr', 'img']);
const dangerousTags = /<\s*\/?(?:script|style|iframe|object|embed|svg|math|form|input|button|select|textarea|title|noscript|template|link|meta|base|audio|video|source|track)\b/i;
const identifier = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const logMarker = new RegExp(`^<!-- note-log-entry event=${uuid} project=${identifier} -->$`);
export const isLogEntryMarker = value => typeof value === 'string' && logMarker.test(value.trim());
const aliasComment = /^ {0,3}<!--[ \t]*aliases:[ \t]*([^\r\n]*?)-->[ \t]*(?:\r?\n)?$/;

/** Content-only approval view: literal examples of metadata remain visible. */
export function reviewNoteContent(input) {
  const body = noteContent(input), starts = lineStarts(body), { tokens } = parseMarkdown(body);
  const aliases = tokens.filter(token => token.type === 'html_block' && token.level === 0 && token.map && aliasComment.test(token.content));
  let content = body;
  for (const token of aliases.reverse()) content = content.slice(0, starts[token.map[0]]) + content.slice(starts[token.map[1]] ?? body.length);
  return content;
}

export function assertOrdinaryTarget(project, target, { platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof target !== 'string' || !paths.isAbsolute(target) || paths.normalize(target) !== target || /[\u0000-\u001f]/.test(target)) fail('NOTE_TARGET_INVALID', 'A canonical absolute note target is required.');
  const normalize = value => platform === 'win32' ? value.toLowerCase() : value;
  const destination = normalize(project.destination.path), actual = normalize(target);
  if (project.destination.kind === 'file') {
    if (actual !== destination) fail('NOTE_TARGET_OUTSIDE', 'The target differs from the configured file destination.');
  } else {
    const relative = paths.relative(destination, actual);
    if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) fail('NOTE_TARGET_OUTSIDE', 'The target is outside the configured notes directory.');
    if (relative.split(paths.sep)[0].toLowerCase() === 'logs') fail('NOTE_TARGET_RESERVED', 'The logs directory is reserved for writer-managed activity logs.');
  }
  if (!isMarkdownPath(target, paths)) fail('NOTE_TARGET_INVALID', 'A note target must use the .md or .markdown file extension.');
  return target;
}

function destinationAllowed(value, image = false) {
  if (typeof value !== 'string' || /[\p{Cc}\\]/u.test(value)) return false;
  value = value.trim();
  if (value.startsWith('//')) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  return !scheme || (image ? ['http', 'https'] : ['http', 'https', 'mailto']).includes(scheme[1].toLowerCase());
}
function stableData(value) {
  if (Array.isArray(value)) return value.map(stableData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableData(value[key])]));
  return value;
}
const sameData = (left, right) => JSON.stringify(stableData(left)) === JSON.stringify(stableData(right));

function htmlParts(source) {
  const parts = []; let cursor = 0, index = 0;
  while ((index = source.indexOf('<', index)) !== -1) {
    if (!/^<(?:\/?[A-Za-z]|[!?])/.test(source.slice(index))) { index++; continue; }
    const name = /^<\/?[^\t\n\f\r />]+/.exec(source.slice(index));
    const parsed = name ? htmlAttributes(source, index + name[0].length) : null;
    const end = parsed?.end ?? (source.indexOf('>', index + 1) + 1);
    if (!end) break;
    if (cursor < index) parts.push({ text: source.slice(cursor, index) });
    parts.push({ tag: source.slice(index, end), attributes: parsed?.attributes ?? [] }); cursor = end; index = cursor;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor) });
  return parts;
}

function htmlAttributes(tag, start) {
  const whitespace = character => /[\t\n\f\r ]/.test(character);
  const attributes = []; let cursor = start;
  while (cursor < tag.length) {
    // HTML re-enters the before-attribute state after a stray self-closing
    // slash, and accepts a new name directly after a quoted value.
    while (cursor < tag.length && (whitespace(tag[cursor]) || tag[cursor] === '/')) cursor++;
    if (cursor === tag.length || tag[cursor] === '>') return { attributes, end: tag[cursor] === '>' ? cursor + 1 : 0 };
    const begin = cursor++;
    while (cursor < tag.length && !whitespace(tag[cursor]) && !['/', '>', '='].includes(tag[cursor])) cursor++;
    const name = tag.slice(begin, cursor).toLowerCase();
    while (cursor < tag.length && whitespace(tag[cursor])) cursor++;
    let value = '';
    if (tag[cursor] === '=') {
      cursor++;
      while (cursor < tag.length && whitespace(tag[cursor])) cursor++;
      const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor++] : null;
      const begin = cursor;
      if (quote) {
        while (cursor < tag.length && tag[cursor] !== quote) cursor++;
        value = tag.slice(begin, cursor); if (cursor < tag.length) cursor++;
      } else {
        while (cursor < tag.length && !whitespace(tag[cursor]) && tag[cursor] !== '>') cursor++;
        value = tag.slice(begin, cursor);
      }
    }
    attributes.push({ name, value });
  }
  return { attributes, end: 0 };
}

function metric() { return { nodes: 0, bytes: 0, depth: 0, visible: false }; }
function add(target, source) {
  target.nodes += source.nodes; target.bytes += source.bytes;
  target.depth = Math.max(target.depth, source.depth); target.visible ||= source.visible;
}

/** Conservative count of the portable Markdown expansion. Extra bookkeeping
 * nodes are charged before sanitization, including inert comments/footnotes. */
function measure(tokens, issues, initialDepth = 0) {
  const result = metric(); let depth = initialDepth;
  const htmlStack = [];
  const charge = (nodes, content = '', meaningful = false) => {
    result.nodes += nodes; result.bytes += nodes * 140 + Buffer.byteLength(JSON.stringify(content));
    result.depth = Math.max(result.depth, depth + 1); result.visible ||= meaningful;
  };
  for (const token of tokens) {
    const line = (token.map?.[0] ?? 0) + 1;
    if (token.nesting < 0) { depth--; continue; }
    if (token.type === 'inline') { add(result, measure(token.children ?? [], issues, depth + htmlStack.length)); continue; }
    if (token.type === 'html_inline' || token.type === 'html_block') {
      const html = token.content;
      if (/^\s*<!--[\s\S]*?-->\s*$/.test(html) && !html.replace(/<!--[\s\S]*?-->/g, '').trim()) {
        charge([...html.matchAll(/<!--/g)].length);
        if (/<!--\s*aliases\b/i.test(html)) issues.push({ code: 'alias-outside-metadata', severity: 'error', line });
        if (!isLogEntryMarker(html)) issues.push({ code: 'html-comment', severity: 'warning', line });
        continue;
      }
      issues.push({ code: dangerousTags.test(html) ? 'unsafe-html' : 'raw-html', severity: dangerousTags.test(html) ? 'error' : 'warning', line });
      if ([...html.matchAll(/<!--/g)].length !== [...html.matchAll(/-->/g)].length) issues.push({ code: 'unclosed-html-block', severity: 'error', line });
      const cleaned = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
      for (const part of htmlParts(cleaned)) {
        if (part.text !== undefined) {
          const visible = decodeEntities(part.text);
          if (visible.length) charge(1, visible, Boolean(visible.trim()));
          continue;
        }
        const match = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)\b/i.exec(part.tag);
        if (!match) { charge(1, part.tag); continue; }
        const name = match[2].toLowerCase();
        if (!safeTags.has(name)) issues.push({ code: 'unsupported-html', severity: 'error', line });
        if (!match[1]) {
          charge(1, part.tag, ['img', 'hr'].includes(name));
          // HTML ignores a self-closing slash on non-void elements.
          if (!voidTags.has(name)) htmlStack.push(name);
          result.depth = Math.max(result.depth, depth + htmlStack.length);
        } else if (!voidTags.has(name)) {
          if (htmlStack.pop() !== name) issues.push({ code: 'unbalanced-html', severity: 'error', line });
        }
        for (const { name, value } of part.attributes) {
          if (/^on[a-z]+$/.test(name) || name === 'style') issues.push({ code: 'unsafe-html', severity: 'error', line });
          if (['href', 'src'].includes(name) && !destinationAllowed(decodeEntities(value), name === 'src')) issues.push({ code: 'unsafe-destination', severity: 'error', line });
        }
      }
      continue;
    }
    if (token.nesting > 0) {
      if (!token.hidden) charge(1, token.attrs ?? ''); depth++; result.depth = Math.max(result.depth, depth);
      if (token.type === 'link_open' && !destinationAllowed(token.attrGet('href'))) issues.push({ code: 'unsafe-destination', severity: 'error', line });
      continue;
    }
    if (['fence', 'code_block'].includes(token.type)) charge(2 + (token.content.length ? 1 : 0), token.content, Boolean(token.content.trim()));
    else if (token.type === 'code_inline') charge(2, token.content, Boolean(token.content.trim()));
    else if (token.type === 'image') {
      charge(1, [token.attrs, token.content], true);
      if (!destinationAllowed(token.attrGet('src'), true)) issues.push({ code: 'unsafe-destination', severity: 'error', line });
    } else if (token.type === 'hr') charge(1, '', true);
    else if (token.type === 'footnote_ref') charge(3);
    else if (token.type === 'footnote_anchor') charge(2);
    else if (['softbreak', 'hardbreak'].includes(token.type)) charge(1);
    else if (token.content) charge(1 + (/^\[[ xX]\](?:\s|$)/.test(token.content) ? 1 : 0), token.content, Boolean(token.content.trim()));
  }
  if (htmlStack.length) issues.push({ code: 'unclosed-html-block', severity: 'error', line: 1 });
  return result;
}

export function validateNote(input, { existing, generated = false, kind = 'note' } = {}) {
  const issues = [];
  const issue = (code, line = 1, severity = 'error') => issues.push({ code, line, severity });
  let source;
  try { source = decodeNote(input); }
  catch (error) { return Object.freeze({ valid: false, profile: P.id, diagnostics: [{ code: error.code, line: 1, severity: 'error' }], sections: [], nodes: 0 }); }
  const lines = source.split(/\r\n|\r|\n/);
  lines.forEach((line, index) => { if (Buffer.byteLength(line) > P.lineBytes) issue('source-line-limit', index + 1); });
  if (issues.length) return Object.freeze({ valid: false, profile: P.id, diagnostics: Object.freeze(issues), sections: [], nodes: 0 });
  const metadata = inspectMetadata(source);
  if (metadata.status === 'invalid') issue('metadata-invalid');
  if (metadata.status === 'unsupported') issue('metadata-unsupported', 1, 'warning');
  if (generated && metadata.status !== 'supported') issue('generated-metadata-required');
  if (existing !== undefined) {
    const old = inspectMetadata(existing);
    if (old.status === 'unsupported' && old.raw !== metadata.raw) issue('unsupported-metadata-changed');
    if (old.status === 'invalid' && decodeNote(existing) !== source) issue('invalid-metadata-changed');
    if (old.status === 'supported') {
      if (metadata.status !== 'supported' || metadata.value.id !== old.value.id || metadata.value.created !== old.value.created) issue('metadata-identity-changed');
      const retained = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['updated', 'generation', 'sources'].includes(key)));
      if (metadata.status === 'supported' && !sameData(retained(metadata.value), retained(old.value))) issue('metadata-descriptions-changed');
      if (metadata.status === 'supported') {
        if (!isSourceAppend(old.value.sources ?? [], metadata.value.sources ?? [])) issue('metadata-sources-changed');
        const unfamiliar = value => Object.fromEntries(Object.entries(value.generation ?? {}).filter(([key]) => !['skill_version', 'content_hash'].includes(key)));
        if (!sameData(unfamiliar(old.value), unfamiliar(metadata.value))) issue('metadata-generation-changed');
      }
    }
    if (old.status === 'absent' && metadata.status !== 'absent') issue('plain-note-enriched-without-preservation');
  }
  if (generated && metadata.status === 'supported' && (!metadata.value.created || !metadata.value.updated || !metadata.value.generation?.skill_version)) issue('generated-metadata-incomplete');
  const { tokens, env } = parseMarkdown(source);
  const sourceMeasure = measure(env.sourceTokens ?? tokens, []);
  sourceMeasure.nodes += [...source.matchAll(/^ {0,3}\[[^\]\r\n]+\]:/gm)].length;
  if (sourceMeasure.nodes > P.documentNodes || sourceMeasure.depth > P.depth) issue('document-source-limit');
  const sections = []; let topic = '', section = null, h1 = 0;
  const slugs = new Set(), aliases = new Map(), definitions = new Map();
  // Footnotes are expanded in every referencing section by the consumer.
  for (let i = 0; i < tokens.length; i++) if (tokens[i].type === 'footnote_open') {
    const start = i, id = tokens[i].meta.id;
    while (i < tokens.length && tokens[i].type !== 'footnote_close') i++;
    definitions.set(id, measure(tokens.slice(start, i + 1), []));
  }
  function finish() {
    if (!section) return;
    const body = measure(section.tokens, issues);
    const references = new Map();
    const visit = list => { for (const token of list) { if (token.type === 'footnote_ref') references.set(token.meta.id, (references.get(token.meta.id) ?? 0) + 1); if (token.children) visit(token.children); } };
    visit(section.tokens);
    for (const [id, count] of references) {
      const definition = definitions.get(id);
      if (!definition) { issue('footnote-unresolved', section.line); continue; }
      add(body, definition); body.nodes += 5 + count * 3; body.bytes += (5 + count * 3) * 140;
    }
    body.nodes += 3; body.bytes += 420; // Native section/parent anchors.
    if (!body.visible) issue('empty-body', section.line);
    if (body.nodes > P.sectionNodes || body.depth > P.depth || body.bytes > P.bodyBytes) issue('section-body-limit', section.line);
    sections.push({ heading: section.heading, line: section.line, aliases: section.aliases, nodes: body.nodes, estimatedBodyBytes: body.bytes });
    section = null;
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], line = (token.map?.[0] ?? 0) + 1;
    if (token.type === 'footnote_block_open') break;
    if (token.type === 'fence') {
      const last = lines[(token.map?.[1] ?? lines.length) - 1] ?? '';
      const close = new RegExp(`^[ \\t>]*${token.markup[0] === '`' ? '`' : '~'}{${token.markup.length},}[ \\t]*$`);
      if (!close.test(last)) issue('unclosed-fence', line);
    }
    if (token.type === 'heading_open' && token.level === 0 && ['h1', 'h2'].includes(token.tag)) {
      finish(); const heading = inlineText(tokens[i + 1]?.content ?? '');
      if (!headingSlug(heading)) issue('empty-heading-id', line);
      if (token.tag === 'h1') { topic = heading; h1++; }
      else {
        const slug = [topic, heading].filter(Boolean).map(headingSlug).join('/');
        if (slugs.has(slug)) issue('duplicate-section-id', line); slugs.add(slug);
        if (!topic) issue('parentless-section', line, generated ? 'error' : 'warning');
        section = { heading, line, aliases: [], tokens: [], started: false, aliasSeen: false };
      }
      i += 2; continue;
    }
    if (token.type === 'html_block' && /<!--\s*aliases\b/i.test(token.content)) {
      const match = aliasComment.exec(token.content);
      if (!section || token.level !== 0) { issue('alias-outside-section', line); continue; }
      if (!match) { issue('malformed-alias', line); continue; }
      if (section.aliasSeen) issue('repeated-alias', line);
      if (section.started) issue('alias-outside-metadata', line);
      if (kind === 'log') issue('log-alias', line);
      section.aliasSeen = true;
      const values = match[1].split(',').map(value => inlineText(value).trim());
      if (values.some(value => !normalizedText(value))) issue('malformed-alias', line);
      const seen = new Set();
      for (const value of values) {
        const key = normalizedText(value);
        if (seen.has(key)) issue('duplicate-alias', line, 'warning');
        else { seen.add(key); section.aliases.push(value); }
        if (aliases.has(key) && aliases.get(key) !== section) issue('ambiguous-alias', line, 'warning');
        aliases.set(key, section);
      }
      continue;
    }
    if (section) { section.started = true; section.tokens.push(token); }
  }
  finish();
  if (!sections.length) issue('no-answer-sections');
  if (generated && !h1) issue('topic-h1-required');
  if (generated && h1 > 1) issue('topic-h1-count');
  if (sections.length > P.sections) issue('section-limit');
  const nodes = sections.reduce((count, item) => count + item.nodes, 0);
  if (nodes > P.documentNodes || sections.reduce((count, item) => count + item.estimatedBodyBytes, 0) > P.bodyBytes) issue('document-body-limit');
  return Object.freeze({ valid: !issues.some(item => item.severity === 'error'), profile: P.id, diagnostics: Object.freeze(issues), metadata, sections: Object.freeze(sections), nodes });
}

export function assertValidNote(input, options) {
  const result = validateNote(input, options);
  if (!result.valid) {
    const error = new Error('The note does not satisfy the supported output profile.');
    error.code = 'NOTE_INVALID'; error.diagnostics = result.diagnostics; throw error;
  }
  return result;
}
