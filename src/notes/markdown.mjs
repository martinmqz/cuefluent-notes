import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

/** Inspection only: unsafe destinations must become tokens so validation can
 * report them. This parser never renders HTML or fetches a linked resource. */
const parser = new MarkdownIt({ html: true, linkify: true, maxNesting: 128 }).use(footnote);
parser.validateLink = () => true;
parser.core.ruler.before('footnote_tail', 'retain_source_tokens', state => {
  state.env.sourceTokens = [...state.tokens];
});
export function parseMarkdown(source) {
  const env = {};
  return { tokens: parser.parse(source, env), env };
}
function withoutRawText(input) {
  const opening = /<(script|style|textarea|title)\b/gi;
  let output = '', cursor = 0, match;
  while ((match = opening.exec(input))) {
    const tagEnd = input.indexOf('>', opening.lastIndex);
    if (tagEnd === -1) break;
    const closing = new RegExp(`</${match[1]}\\s*>`, 'gi'); closing.lastIndex = tagEnd + 1;
    const end = closing.exec(input);
    // Raw-text content is not visible heading text, including an unclosed tail.
    output += input.slice(cursor, match.index) + ' ';
    cursor = end ? closing.lastIndex : input.length;
    opening.lastIndex = cursor;
  }
  return output + input.slice(cursor);
}

function plainFragment(input) {
  const source = withoutRawText(htmlParts(input).map(part => part.comment !== undefined ? ' ' : part.tag ?? part.text).join(''))
    .replace(/!\[[^\]]*\]\((?:\\.|[^)])*\)/g, ' ')
    .replace(/<(?:https?:\/\/|mailto:)[^>\s]+>/gi, ' ');
  let output = '';
  for (let i = 0; i < source.length;) {
    if (source[i] !== '<' || !/^<(?:\/?[A-Za-z]|[!?])/.test(source.slice(i))) { output += source[i++]; continue; }
    let quote = null, end = i + 1;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === source.length) { output += source.slice(i); break; }
    output += ' '; i = end + 1;
  }
  return output;
}

export function inlineText(source) {
  const children = parser.parseInline(plainFragment(source), {})[0]?.children ?? [];
  return children.map(token => ['text', 'code_inline'].includes(token.type) ? plainFragment(token.content) : '').join('');
}
export const normalizedText = value => value.normalize('NFKD').toLocaleLowerCase('en').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const headingSlug = value => normalizedText(value).replace(/ /g, '-');

export const decodeEntities = value => parser.utils.unescapeAll(value);

/** Split raw HTML into its comments, its tags and the text between them, the
 * way an HTML reader does: a comment marker inside a tag, such as in a quoted
 * attribute, is part of that tag and neither opens nor closes a comment. */
export function htmlParts(source) {
  const parts = []; let cursor = 0, index = 0;
  const push = (part, end) => {
    if (cursor < index) parts.push({ text: source.slice(cursor, index) });
    parts.push({ ...part, offset: index }); cursor = end; index = end;
  };
  while ((index = source.indexOf('<', index)) !== -1) {
    if (source.startsWith('<!--', index)) {
      // A comment may close on its own opening dashes: <!--> and <!--->.
      const closing = /--!?>/g; closing.lastIndex = index + 2;
      const match = closing.exec(source), end = match ? closing.lastIndex : source.length;
      push({ comment: source.slice(index, end), closed: Boolean(match) }, end); continue;
    }
    if (!/^<(?:\/?[A-Za-z]|[!?])/.test(source.slice(index))) { index++; continue; }
    const name = /^<\/?[^\t\n\f\r />]+/.exec(source.slice(index));
    const parsed = name ? htmlAttributes(source, index + name[0].length) : null;
    const end = parsed?.end ?? (source.indexOf('>', index + 1) + 1);
    if (!end) break;
    push({ tag: source.slice(index, end), attributes: parsed?.attributes ?? [] }, end);
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

/** Exactly one standalone alias directive. A second closer, nested opener or
 * suffix is ordinary content, never part of an alias a repair may remove. */
export const matchAliasComment = source => /^( {0,3}<!--[ \t]*aliases:)((?:(?!-->|--!>|<!--)[^\r\n])*)(-->[ \t]*(?:\r\n|\r|\n)?)$/.exec(source);

/** Read stored alias segments once, retaining their exact spelling for edits.
 * Selectors already reported to a caller are plain text: normalize them directly
 * instead of parsing them as Markdown again. */
export const parseAliasValues = text => text.split(',').map(raw => {
  const value = inlineText(raw).trim();
  return { raw, value, key: normalizedText(value) };
});
