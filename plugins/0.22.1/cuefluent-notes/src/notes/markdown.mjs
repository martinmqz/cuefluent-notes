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
  const source = withoutRawText(input.replace(/<!--[\s\S]*?(?:-->|$)/g, ' '))
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
