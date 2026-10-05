import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { Scalar, isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';

export const NOTE_METADATA_SCHEMA = 1;
export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const marker = /<!--[ \t\r\n]*cuefluent(?![\p{L}\p{N}\p{M}_])/iu;
const containerMarker = /<!--[ \t]*(?:[\r\n][ \t>]*)*cuefluent(?![\p{L}\p{N}\p{M}_])/iu;
const markerAt = new RegExp(marker.source, marker.flags + 'y');
const markers = value => value.matchAll(new RegExp(marker.source, marker.flags + 'g'));
// Containers may separate the opener from its name in raw Markdown. This is
// deliberately conservative; token discovery decides whether it is active.
const mayContainMarker = value => value.includes('<!--') && /cuefluent(?![\p{L}\p{N}\p{M}_])/iu.test(value);
const blockPattern = /^ {0,3}<!-- cuefluent[ \t]*(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n) {0,3}-->[ \t]*(?:(?:\r\n|\r|\n)|$)/;
const inlineLine = Symbol('cuefluentInlineLine');
const enabled = Symbol('cuefluentEnabled');
const consumedMarkers = Symbol('cuefluentConsumedMarkers');
const footnoteMarkers = Symbol('cuefluentFootnoteMarkers');
const attributeStart = Symbol('cuefluentAttributeStart');
const escapedAt = (source, offset) => {
  let slashes = 0;
  while (offset > 0 && source[--offset] === '\\') slashes++;
  return slashes % 2 === 1;
};
const markerTokens = new WeakMap();
const breaks = value => (value.match(/\r\n|\r|\n/g) ?? []).length;
const normalizedMarkdown = value => value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');

function markerCandidates(tokens) {
  const candidates = [];
  const visit = (items, parentLine = 1) => {
    for (const token of items) {
      if (candidates.length >= 2) return;
      const line = token[inlineLine] ?? (token.map ? token.map[0] + 1 : parentLine);
      if (token.type === 'inline') { visit(token.children ?? [], line); continue; }
      if (token.type === 'cuefluent_marker' || token.type === 'cuefluent_limit') {
        candidates.push({ line, root: false, limited: token.type === 'cuefluent_limit' });
      }
      if (token.type === 'html_block' || token.type === 'html_inline') {
        for (const match of markers(token.content)) {
          candidates.push({ line: line + breaks(token.content.slice(0, match.index)),
            root: token.type === 'html_block' && token.level === 0 });
          if (candidates.length >= 2) break;
        }
      }
      if (token.children) visit(token.children, line);
    }
  };
  visit(tokens);
  return candidates;
}

/** Install the same bounded marker discovery in standalone and checker parsing. */
function noteMetadataPlugin(md) {
  const bases = new WeakMap(), active = [];
  md.core.ruler.after('normalize', 'cuefluent_presence', state => {
    state.env[enabled] = mayContainMarker(state.src); state.env[consumedMarkers] = 0; state.env[footnoteMarkers] = [];
  });
  md.core.ruler.before('inline', 'cuefluent_inline_bases', state => {
    if (state.env[enabled]) for (const token of state.tokens) if (token.type === 'inline') {
      bases.set(token.children, (token.map?.[0] ?? 0) + 1);
    }
  });
  md.core.ruler.before('strip_references', 'cuefluent_reference_markers', state => {
    if (!state.env[enabled]) return;
    const lines = state.src.split('\n'), extra = [];
    for (const token of state.tokens) {
      if (state.env[consumedMarkers] >= 2) break;
      if (token.type !== 'reference_definition') continue;
      const source = lines.slice(token.map[0], token.map[1]).join('\n');
      for (const match of markers(source)) {
        if (escapedAt(source, match.index)) continue;
        const item = new token.constructor('cuefluent_marker', '', 0);
        item.map = [token.map[0] + breaks(source.slice(0, match.index)), token.map[1]];
        item.hidden = true; extra.push(item);
        if (++state.env[consumedMarkers] >= 2) break;
      }
    }
    state.tokens.push(...extra);
  });
  // The footnote plugin consumes raw labels and removes unused definitions.
  // Retain label markers outside that token stream so neither path hides them.
  const { fn: footnoteDef, alt: footnoteAlternates } = md.block.ruler.__rules__.find(item => item.name === 'footnote_def');
  md.block.ruler.at('footnote_def', (state, start, end, silent) => {
    const firstToken = state.tokens.length;
    const matched = footnoteDef(state, start, end, silent);
    if (!matched || silent || !state.env[enabled] || state.env[consumedMarkers] >= 2) return matched;
    const label = state.tokens[firstToken].meta.label;
    for (const match of markers(label)) {
      if (escapedAt(label, match.index)) continue;
      const token = new state.Token('cuefluent_marker', '', 0);
      token.map = [start, start + 1]; token.hidden = true;
      state.env[footnoteMarkers].push(token);
      if (++state.env[consumedMarkers] >= 2) break;
    }
    return matched;
  }, { alt: footnoteAlternates });
  const footnoteTail = md.core.ruler.__rules__.find(item => item.name === 'footnote_tail').fn;
  md.core.ruler.at('footnote_tail', state => {
    const before = state.tokens;
    footnoteTail(state);
    if (!state.env[enabled] || state.tokens === before) return;
    // Used bodies retain their token objects. Inspect only discarded bodies,
    // including overwritten definitions, with the same code-aware traversal.
    const retained = new Set(state.tokens);
    for (const candidate of markerCandidates(before.filter(token => !retained.has(token)))) {
      const token = new state.Token(candidate.limited ? 'cuefluent_limit' : 'cuefluent_marker', '', 0);
      token.map = [candidate.line - 1, candidate.line]; token.hidden = true;
      state.tokens.push(token);
    }
  });
  md.core.ruler.after('footnote_tail', 'cuefluent_footnote_markers', state => state.tokens.push(...state.env[footnoteMarkers]));
  const InlineState = md.inline.State;
  md.inline.State = class extends InlineState {
    sourceLine(pos) {
      this.noteLineStarts ??= [0, ...Array.from(this.src.matchAll(/\n/g), match => match.index + 1)];
      let low = 0, high = this.noteLineStarts.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.noteLineStarts[middle] <= pos) low = middle + 1; else high = middle;
      }
      return (bases.get(this.tokens) ?? 1) + low - 1;
    }
    push(type, tag, nesting) {
      const token = super.push(type, tag, nesting);
      if (this.env[enabled] && type === 'link_open') token[attributeStart] = this.posMax + 1;
      if (this.env[enabled] && ['html_inline', 'cuefluent_marker', 'cuefluent_limit'].includes(type)) token[inlineLine] = this.sourceLine(this.pos);
      return token;
    }
  };
  const inlineParse = md.inline.parse;
  md.inline.parse = function (source, parser, env, tokens) {
    const parent = active.at(-1);
    if (env[enabled] && parent) {
      // The shared configuration reparses labels only for images and inline
      // footnotes. Their label starts immediately after ![ or ^[.
      const label = /^(?:!|\^)\[/.test(parent.src.slice(parent.pos, parent.pos + 2));
      bases.set(tokens, parent.sourceLine(parent.pos + (label ? 2 : 0)));
    }
    return inlineParse.call(this, source, parser, env, tokens);
  };
  md.inline.ruler.before('html_inline', 'cuefluent_marker', (state, silent) => {
    if (!state.env[enabled] || state.src[state.pos] !== '<') return false;
    markerAt.lastIndex = state.pos;
    const match = markerAt.exec(state.src);
    if (!match) return false;
    if (!silent) state.push('cuefluent_marker', '', 0);
    state.pos += match[0].length;
    return true;
  });
  // Inspect successfully consumed raw attributes and named footnote labels,
  // never decoded entity values or generated footnote anchors.
  for (const name of ['link', 'image', 'footnote_ref']) {
    const rule = md.inline.ruler.__rules__.find(item => item.name === name).fn;
    md.inline.ruler.at(name, (state, silent) => {
      const start = state.pos, firstToken = state.tokens.length;
      const matched = rule(state, silent);
      if (!matched || silent || !state.env[enabled] || state.env[consumedMarkers] >= 2) return matched;
      const token = state.tokens.slice(firstToken).find(item => item.type === (name === 'link' ? 'link_open' : name));
      if (!token) return matched;
      const from = name === 'link' ? token[attributeStart] : name === 'footnote_ref' ? start + 2 : start + 3 + token.content.length;
      if (from === undefined || from >= state.pos) return matched;
      const raw = state.src.slice(from, state.pos);
      for (const match of markers(raw)) {
        const offset = from + match.index;
        if (escapedAt(state.src, offset)) continue;
        const item = state.push('cuefluent_marker', '', 0);
        item[inlineLine] = state.sourceLine(offset);
        if (++state.env[consumedMarkers] >= 2) break;
      }
      return matched;
    });
  }
  // Markdown stops parsing at its nesting limit. Surface an uninspected marker
  // there as a conflict instead of treating an omitted subtree as marker-free.
  const blockTokenize = md.block.tokenize;
  md.block.tokenize = function (state, start, end) {
    if (state.env[enabled] && start < end && state.level >= md.options.maxNesting) {
      const offset = state.bMarks[start], fragment = state.src.slice(offset, state.bMarks[end] ?? state.src.length);
      const match = containerMarker.exec(fragment);
      if (match) {
        const token = state.push('cuefluent_limit', '', 0);
        token.map = [start + breaks(fragment.slice(0, match.index)), end];
      }
    }
    return blockTokenize.call(this, state, start, end);
  };
  const inlineTokenize = md.inline.tokenize;
  md.inline.tokenize = function (state) {
    if (!state.env[enabled]) return inlineTokenize.call(this, state);
    if (state.level >= md.options.maxNesting) {
      const match = marker.exec(state.src.slice(state.pos, state.posMax));
      if (match) {
        const token = state.push('cuefluent_limit', '', 0);
        token[inlineLine] = state.sourceLine(state.pos + match.index);
      }
    }
    active.push(state);
    try { return inlineTokenize.call(this, state); } finally { active.pop(); }
  };
  md.core.ruler.push('cuefluent_tokens', state => markerTokens.set(state.tokens, state.src));
}

export function createNoteMarkdownParser() {
  const md = new MarkdownIt({ html: true }).use(footnote).use(noteMetadataPlugin);
  // Inspection only: never render or fetch a destination.
  md.validateLink = () => true;
  return md;
}
let parser;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256 = /^sha256:[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const reject = () => { throw new Error('Invalid note metadata.'); };
const requireValue = condition => { if (!condition) reject(); };
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit &&
  value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const id = value => typeof value === 'string' && identifier.test(value);
const optional = (value, key, predicate) => { if (own(value, key)) requireValue(predicate(value[key])); };
const stringList = value => Array.isArray(value) && value.length <= 128 && value.every(item => text(item)) && new Set(value).size === value.length;

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function isNoteTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !isCalendarDate(value.slice(0, 10))) return false;
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return false;
  const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
  return (!offset || (Number(offset[1]) <= 23 && Number(offset[2]) <= 59)) && Number.isFinite(Date.parse(value));
}
const timezone = value => {
  if (!text(value, 128) || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
};

/** Checks only descriptive structure, never source existence, truth or permission. */
export function validateNoteMetadata(value) {
  requireValue(object(value) && value.schema_version === NOTE_METADATA_SCHEMA && id(value.id));
  optional(value, 'type', item => typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item));
  optional(value, 'created', isNoteTimestamp); optional(value, 'updated', isNoteTimestamp);
  if (value.created && value.updated) requireValue(Date.parse(value.updated) >= Date.parse(value.created));
  if (own(value, 'context')) {
    requireValue(object(value.context));
    optional(value.context, 'project', id);
    optional(value.context, 'topics', stringList); optional(value.context, 'entities', stringList);
  }
  if (own(value, 'sources')) {
    requireValue(Array.isArray(value.sources) && value.sources.length <= 128);
    const identities = new Set();
    for (const source of value.sources) {
      requireValue(object(source));
      let identity;
      if (source.type === 'session') {
        requireValue(['codex', 'claude'].includes(source.client) && id(source.session_id) && id(source.unit_id) &&
          typeof source.revision === 'string' && /^[a-f0-9]{64}$/.test(source.revision));
        identity = JSON.stringify([source.type, source.client, source.session_id, source.unit_id, source.revision]);
        optional(source, 'raw_ref', item => text(item, 2048));
      } else {
        requireValue(source.type === 'document' && text(source.ref, 2048));
        optional(source, 'locator', item => text(item, 2048));
        optional(source, 'version', item => text(item));
        identity = JSON.stringify([source.type, source.ref, source.locator ?? null, source.version ?? null, source.source_hash ?? null]);
      }
      optional(source, 'source_hash', item => typeof item === 'string' && sha256.test(item));
      requireValue(!identities.has(identity)); identities.add(identity);
    }
  }
  if (own(value, 'series')) {
    requireValue(object(value.series) && id(value.series.id));
    optional(value.series, 'label', item => text(item));
  }
  optional(value, 'sprint', item => text(item, 128));
  if (own(value, 'period')) {
    requireValue(object(value.period) && isCalendarDate(value.period.start) && isCalendarDate(value.period.end) &&
      value.period.start <= value.period.end && timezone(value.period.timezone));
  }
  if (own(value, 'generation')) {
    requireValue(object(value.generation));
    optional(value.generation, 'skill_version', item => typeof item === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(item));
    optional(value.generation, 'content_hash', item => typeof item === 'string' && sha256.test(item));
  }
  return value;
}

// Compare decimal meaning before returning JSON-compatible numbers. Keep
// exponents as integers, never allocate an exponent-sized decimal string.
function numericKey(source) {
  if (/^0[xo]/i.test(source)) source = BigInt(source).toString();
  const [, sign, whole, fraction = '', exponent = '0'] = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return sign === '-' ? '-0' : '0';
  const trimmed = digits.replace(/0+$/, '');
  return `${sign === '-' ? '-' : ''}${trimmed}e${BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - trimmed.length)}`;
}

// Inspect the bounded AST before converting it. No aliases, anchors, custom tags,
// complex keys or merge keys can reach consumers, including in unknown fields.
function plainDocument(payload) {
  const doc = parseDocument(payload.replace(/\r\n?/g, '\n'), { version: '1.2', schema: 'core', uniqueKeys: true, strict: true, prettyErrors: false });
  requireValue(!doc.errors.length && !doc.warnings.length && isMap(doc.contents));
  requireValue(!doc.directives.yaml.explicit && !doc.directives.docStart && !doc.directives.docEnd);
  const queue = [[doc.contents, 0]]; let count = 0;
  while (queue.length) {
    const [node, depth] = queue.pop();
    requireValue(++count <= 4096 && depth <= 8);
    if (node === null) continue;
    requireValue(!isAlias(node) && !node.anchor && !node.tag);
    if (isMap(node)) {
      requireValue(node.items.length <= 128);
      for (const pair of node.items) {
        requireValue(isScalar(pair.key) && typeof pair.key.value === 'string' &&
          /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(pair.key.value) &&
          !['__proto__', 'constructor', 'prototype'].includes(pair.key.value));
        queue.push([pair.key, depth + 1], [pair.value, depth + 1]);
      }
    } else if (isSeq(node)) {
      requireValue(node.items.length <= 128);
      queue.push(...node.items.map(item => [item, depth + 1]));
    } else {
      requireValue(isScalar(node));
      const value = node.value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        const printed = Object.is(value, -0) ? '-0' : String(value);
        requireValue(numericKey(node.source) === numericKey(printed));
      }
      requireValue(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) && !/<!--|-->|--!>/.test(value)));
    }
  }
  // Core YAML resolves plain timestamps to strings, but other YAML consumers
  // may resolve them as dates. Enforce schema-1 quoting before losing AST style.
  if (doc.get('schema_version') === NOTE_METADATA_SCHEMA) for (const key of ['created', 'updated']) {
    if (!doc.has(key)) continue;
    const node = doc.get(key, true);
    requireValue(isScalar(node) && [Scalar.QUOTE_SINGLE, Scalar.QUOTE_DOUBLE].includes(node.type));
  }
  return doc.toJS({ maxAliasCount: 0 });
}

function discoverySource(source) {
  // A leading root comment is independent of the body. If no other marker can
  // occur, parse only that prefix; do not reparse a large body under writer locks.
  // No cached bytes or filesystem authority are reused between inspections.
  const start = /^(?:\uFEFF)?(?:[ \t]*(?:\r\n|\r|\n))*/.exec(source)[0].length;
  const leading = blockPattern.exec(source.slice(start));
  const end = start + (leading?.[0].length ?? 0);
  return leading && Buffer.byteLength(leading[0], 'utf8') <= MAX_METADATA_BYTES && !mayContainMarker(source.slice(end))
    ? source.slice(0, end) : source;
}

/** Read-only: preserve exact original bytes/spans even when interpretation fails.
 * Markdown tokens keep fenced/indented examples from becoming active metadata. */
export function inspectNoteMetadata(source, file = '<input>', tokens) {
  const diagnostics = [];
  const issue = (code, line, message, severity = 'error') => diagnostics.push({ severity, code, file, line, message });
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_NOTE_BYTES) {
    issue('metadata-input-limit', 1, 'Metadata inspection requires at most 2 MiB of Markdown.');
    return { status: 'invalid', value: null, block: null, diagnostics };
  }
  if (!mayContainMarker(source)) return { status: 'absent', value: null, block: null, diagnostics };
  const candidates = markerCandidates(tokens && markerTokens.get(tokens) === normalizedMarkdown(source) ? tokens :
    (parser ??= createNoteMarkdownParser()).parse(discoverySource(source).replace(/^\uFEFF/, ''), {}));
  if (!candidates.length) return { status: 'absent', value: null, block: null, diagnostics };
  const candidate = candidates[0];
  if (candidates.length !== 1) issue('metadata-duplicate', candidates[1].line, 'Use one Cuefluent metadata block per note.');
  if (candidates.some(item => item.limited)) issue('metadata-nesting-limit', candidates.find(item => item.limited).line,
    'A metadata marker exceeds the Markdown nesting limit; its context cannot be safely inspected.');
  const lineStarts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) lineStarts.push(match.index + match[0].length);
  const start = lineStarts[candidate.line - 1] + (candidate.line === 1 && source.startsWith('\uFEFF') ? 1 : 0);
  const matched = blockPattern.exec(source.slice(start));
  if (!candidate.root || source.slice(0, start).trim()) issue('metadata-placement', candidate.line, 'Place note metadata before all visible content and other comments.');
  if (!matched || /<!--|-->|--!>/.test(matched[1])) issue('metadata-syntax', candidate.line, 'Use a terminated Cuefluent comment with opening and closing markers on separate lines.');
  const block = matched ? { start, end: start + matched[0].length, line: candidate.line, raw: matched[0] } : null;
  if (matched && Buffer.byteLength(matched[0], 'utf8') > MAX_METADATA_BYTES) issue('metadata-size', candidate.line, 'Note metadata exceeds 64 KiB.');
  if (diagnostics.length) return { status: 'invalid', value: null, block, diagnostics };
  try {
    const value = plainDocument(matched[1]);
    requireValue(Number.isSafeInteger(value.schema_version) && value.schema_version >= 1);
    if (value.schema_version !== NOTE_METADATA_SCHEMA) {
      issue('metadata-version', candidate.line, 'Unsupported note metadata schema; preserve the block without interpreting it.', 'warning');
      return { status: 'unsupported', value: null, block, diagnostics };
    }
    validateNoteMetadata(value);
    return { status: 'valid', value, block, diagnostics };
  } catch {
    issue('metadata-invalid', candidate.line, 'Invalid or unsupported metadata structure or field value.');
    return { status: 'invalid', value: null, block, diagnostics };
  }
}

/** Check only selected outputs, never discover or merge other notes. */
export function registerNoteIdentity(inspected, identities) {
  if (inspected.status !== 'valid') return;
  if (identities.has(inspected.value.id)) throw Object.assign(new Error('NOTE_METADATA_ID_COLLISION'), { code: 'NOTE_METADATA_ID_COLLISION' });
  identities.add(inspected.value.id);
  return inspected.value.id;
}
