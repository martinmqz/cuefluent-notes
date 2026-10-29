import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isScalar, isSeq, parseDocument, Scalar, visit as visitYaml } from 'yaml';
import { fail } from '../core/errors.mjs';
import { SEMVER_VERSION_PATTERN } from '../core/version.mjs';
import { decodeNote, noteNewline, NOTE_PROFILE as P } from './profile.mjs';
import { parseMarkdown } from './markdown.mjs';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const marker = /<!--[\t \r\n]*cuefluent(?=[\t \r\n]|-->|$)/giu;
const block = /^(?:\uFEFF)?[ \t\r\n]*?( {0,3}<!-- cuefluent[ \t]*(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n) {0,3}-->[ \t]*(?:(?:\r\n|\r|\n)|$))/;
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keyAllowed = key => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/\p{Cc}/u.test(value);
const requireValue = condition => { if (!condition) fail('NOTE_METADATA_INVALID', 'Invalid note metadata; preserve the existing bytes.'); };

export function isNoteTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  if (!calendarDate(value.slice(0, 10)) || +value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59) return false;
  const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
  return (!offset || (+offset[1] <= 23 && +offset[2] <= 59)) && Number.isFinite(Date.parse(value));
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function timezone(value) {
  if (!text(value, 128) || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

/** Clone only bounded inert data, rejecting accessors, aliases and unsafe keys. */
function dataValue(input, canonical = false, capacityCode = 'NOTE_METADATA_INVALID') {
  let nodes = 0;
  const capacity = condition => { if (!condition) fail(capacityCode, 'The metadata exceeds its supported structural capacity. Preserve the input and existing note.'); };
  function visit(value, depth) {
    capacity(++nodes <= P.metadataNodes && depth <= P.metadataDepth);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { requireValue(Number.isFinite(value)); return value; }
    if (typeof value === 'string') {
      capacity(value.length <= P.metadataString);
      requireValue(!/(?![\t\n\r])[\p{Cc}\p{Cs}]/u.test(value) && !/<!--|-->|--!>/.test(value));
      if (canonical) requireValue(!/[\uFFFE\uFFFF]/u.test(value));
      return value;
    }
    requireValue(Array.isArray(value) ? Object.getPrototypeOf(value) === Array.prototype : plain(value));
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      capacity(value.length <= P.metadataItems); requireValue(keys.length === value.length + 1);
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[index]; requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        return visit(descriptor.value, depth + 1);
      }));
    }
    capacity(keys.length <= P.metadataItems); requireValue(keys.every(key => typeof key === 'string' && keyAllowed(key)));
    return Object.freeze(Object.fromEntries((canonical ? keys.sort() : keys).map(key => {
      const descriptor = descriptors[key]; requireValue(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
      visit(key, depth + 1); return [key, visit(descriptor.value, depth + 1)];
    })));
  }
  requireValue(plain(input)); return visit(input, 0);
}

/** Provenance describes a source; it never grants access to that source. */
export function noteSourceIdentity(source) {
  return sourceIdentity(dataValue(source));
}
function sourceIdentity(source) {
  let identity;
  if (source.type === 'session') {
    requireValue(['claude', 'codex'].includes(source.client) && typeof source.session_id === 'string' && idPattern.test(source.session_id) && typeof source.unit_id === 'string' && idPattern.test(source.unit_id) && typeof source.revision === 'string' && /^[a-f0-9]{64}$/.test(source.revision));
    identity = ['session', source.client, source.session_id, source.unit_id, source.revision];
    if (Object.hasOwn(source, 'raw_ref')) requireValue(text(source.raw_ref, 2048));
  } else {
    requireValue(source.type === 'document' && text(source.ref, 2048));
    if (Object.hasOwn(source, 'locator')) requireValue(text(source.locator, 2048));
    if (Object.hasOwn(source, 'version')) requireValue(text(source.version));
    identity = ['document', source.ref, source.locator ?? null, source.version ?? null, source.source_hash ?? null];
  }
  if (Object.hasOwn(source, 'source_hash')) requireValue(typeof source.source_hash === 'string' && hashPattern.test(source.source_hash));
  return JSON.stringify(identity);
}

const nativeSourceKeys = new Set(['client', 'session_id', 'unit_id', 'revision', 'raw_ref']);
const checkedSources = new WeakSet();
function sourceFields(existing, supplied) {
  const fields = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (Object.hasOwn(existing, key)) {
      if (!isDeepStrictEqual(existing[key], value)) fail('NOTE_SOURCE_CONFLICT', 'A source identity already has different descriptive metadata. Preserve it and reconcile the source descriptions.');
    } else fields[key] = value;
  }
  return fields;
}
function sourceChanges(existing, supplied) {
  const additions = [], amendments = new Map();
  const identities = new Map(existing.map((value, index) => [sourceIdentity(value), { value, index }]));
  for (const source of supplied) {
    const identity = sourceIdentity(source), prior = identities.get(identity);
    if (prior) {
      const fields = sourceFields(prior.value, source);
      if (!Object.keys(fields).length) continue;
      if (Object.keys(prior.value).length + Object.keys(fields).length > P.metadataItems) fail('NOTE_SOURCE_LIMIT', 'The combined source descriptor exceeds its field limit. Preserve the existing source and supplied data.');
      prior.value = Object.freeze(Object.fromEntries(Object.entries({ ...prior.value, ...fields }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
      if (prior.index < existing.length) amendments.set(prior.index, { ...amendments.get(prior.index), ...fields });
      else additions[prior.index - existing.length] = prior.value;
    } else {
      if (existing.length + additions.length === P.metadataItems) fail('NOTE_SOURCE_LIMIT', 'The note source limit is reached. Preserve the existing note and supplied sources; do not prune provenance or split the note to fit.');
      identities.set(identity, { value: source, index: existing.length + additions.length }); additions.push(source);
    }
  }
  return { additions, amendments };
}

/** Shared writer/validator policy: retain source order, identities and all old
 * values, admitting only document additions and nonconflicting descriptive keys. */
export function isSourceAppend(previous, current) {
  try {
    if (!Array.isArray(previous) || !Array.isArray(current) || current.length < previous.length || current.length > P.metadataItems) return false;
    for (let index = 0; index < previous.length; index++) {
      const before = previous[index], after = current[index];
      if (sourceIdentity(before) !== sourceIdentity(after)) return false;
      const extra = sourceFields(before, after);
      if (Object.keys(before).some(key => !Object.hasOwn(after, key))) return false;
      if (before.type !== 'document' && Object.keys(extra).length) return false;
      if (Object.keys(extra).some(key => nativeSourceKeys.has(key))) return false;
      if (Object.keys(extra).length) {
        const identity = Object.fromEntries(['type', 'ref', 'locator', 'version', 'source_hash'].filter(key => Object.hasOwn(after, key)).map(key => [key, after[key]]));
        validateDocumentSources([{ ...identity, ...extra }]);
      }
    }
    const added = current.slice(previous.length);
    return validateDocumentSources(added).length === added.length;
  } catch { return false; }
}

/** Assistant-provided provenance is bounded descriptive document data, never
 * native session authority or replacement of writer-owned note metadata. */
export function validateDocumentSources(input) {
  if (checkedSources.has(input)) return input;
  if (Array.isArray(input) && input.length > P.metadataItems) fail('NOTE_SOURCE_LIMIT', 'Too many supplied sources. Preserve the input and use the supported source bound.');
  try {
    const sources = dataValue({ sources: input }, true).sources;
    requireValue(Array.isArray(sources));
    for (const source of sources) requireValue(plain(source) && source.type === 'document' && !Object.keys(source).some(key => nativeSourceKeys.has(key)));
    const result = Object.freeze(sourceChanges([], sources).additions);
    checkedSources.add(result); return result;
  } catch (error) {
    if (error.code === 'NOTE_METADATA_INVALID') fail('NOTE_SOURCE_ARGUMENT', 'Invalid supplied source descriptor. Use bounded document fields without native session identities, control characters, surrounding whitespace or comment delimiters.');
    throw error;
  }
}

/** Stable JSON for already-validated source data. Preserve signed zero as well
 * as object-key independence for request identity and exact metadata previews. */
export function serializeSources(value) {
  if (Object.is(value, -0)) return '-0';
  if (Array.isArray(value)) return `[${value.map(serializeSources).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${serializeSources(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateMetadata(input, capacityCode = 'NOTE_METADATA_INVALID') {
  const value = dataValue(input, false, capacityCode);
  requireValue(value.schema_version === 1 && typeof value.id === 'string' && idPattern.test(value.id));
  const optional = (record, key, check) => { if (Object.hasOwn(record, key)) requireValue(check(record[key])); };
  optional(value, 'type', item => typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item));
  optional(value, 'created', isNoteTimestamp); optional(value, 'updated', isNoteTimestamp);
  if (value.created && value.updated) requireValue(Date.parse(value.updated) >= Date.parse(value.created));
  if (Object.hasOwn(value, 'context')) {
    requireValue(plain(value.context)); optional(value.context, 'project', item => typeof item === 'string' && idPattern.test(item));
    for (const key of ['topics', 'entities']) optional(value.context, key, list => Array.isArray(list) && list.every(item => text(item)) && new Set(list).size === list.length);
  }
  if (Object.hasOwn(value, 'sources')) {
    requireValue(Array.isArray(value.sources)); const identities = value.sources.map(sourceIdentity);
    requireValue(new Set(identities).size === identities.length);
  }
  if (Object.hasOwn(value, 'series')) {
    requireValue(plain(value.series) && typeof value.series.id === 'string' && idPattern.test(value.series.id));
    optional(value.series, 'label', item => text(item));
  }
  optional(value, 'sprint', item => text(item, 128));
  if (Object.hasOwn(value, 'period')) requireValue(plain(value.period) && calendarDate(value.period.start) && calendarDate(value.period.end) && value.period.start <= value.period.end && timezone(value.period.timezone));
  if (Object.hasOwn(value, 'generation')) {
    requireValue(plain(value.generation)); optional(value.generation, 'skill_version', item => typeof item === 'string' && SEMVER_VERSION_PATTERN.test(item));
    optional(value.generation, 'content_hash', item => typeof item === 'string' && hashPattern.test(item));
  }
  return value;
}

function decimal(value) {
  if (/^[+-]?0[xo]/i.test(value)) {
    const sign = value.startsWith('-') ? -1n : 1n; return decimal(String(sign * BigInt(value.replace(/^[+-]/, ''))));
  }
  const parts = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  requireValue(parts); const digits = (parts[2] + (parts[3] ?? '')).replace(/^0+/, '');
  if (!digits) return parts[1] === '-' ? '-0' : '0';
  const significant = digits.replace(/0+$/, '');
  return `${parts[1] === '-' ? '-' : ''}${significant}e${BigInt(parts[4] ?? 0) - BigInt((parts[3] ?? '').length) + BigInt(digits.length - significant.length)}`;
}

function parseYaml(payload) {
  requireValue(Buffer.byteLength(payload) <= P.metadataBytes);
  const document = parseDocument(payload.replace(/\r\n?/g, '\n'), { version: '1.2', schema: 'core', uniqueKeys: true, strict: true, prettyErrors: false });
  requireValue(!document.errors.length && !document.warnings.length && isMap(document.contents) && !document.directives?.yaml.explicit && !document.directives?.docStart && !document.directives?.docEnd);
  const queue = [[document.contents, 0]]; let nodes = 0;
  while (queue.length) {
    const [node, depth] = queue.pop(); requireValue(++nodes <= P.metadataNodes && depth <= P.metadataDepth);
    if (node === null) continue;
    requireValue(!isAlias(node) && !node.anchor && !node.tag);
    if (isMap(node)) {
      requireValue(node.items.length <= P.metadataItems);
      for (const pair of node.items) { requireValue(isScalar(pair.key) && typeof pair.key.value === 'string' && keyAllowed(pair.key.value)); queue.push([pair.key, depth + 1], [pair.value, depth + 1]); }
    } else if (isSeq(node)) {
      requireValue(node.items.length <= P.metadataItems); for (const item of node.items) queue.push([item, depth + 1]);
    } else {
      requireValue(isScalar(node));
      if (typeof node.value === 'number') requireValue(Number.isFinite(node.value) && decimal(node.source) === decimal(Object.is(node.value, -0) ? '-0' : String(node.value)));
    }
  }
  const value = dataValue(document.toJS({ maxAliasCount: 0 }));
  if (value.schema_version === 1) for (const key of ['created', 'updated']) {
    if (document.has(key)) requireValue([Scalar.QUOTE_SINGLE, Scalar.QUOTE_DOUBLE].includes(document.get(key, true)?.type));
  }
  return { value, document };
}

/** Mask actual block code and paired inline code; raw HTML comments remain raw. */
export function lineStarts(source) {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}
function activeMarkers(source, tokens) {
  const starts = lineStarts(source);
  const ranges = [];
  for (const token of tokens) if (['fence', 'code_block'].includes(token.type) && token.map) ranges.push([starts[token.map[0]], starts[token.map[1]] ?? source.length]);
  let masked = source.split('');
  for (const [from, to] of ranges) for (let i = from; i < to; i++) if (!/[\r\n]/.test(masked[i])) masked[i] = ' ';
  // Only parser-confirmed inline code can hide a marker. Backticks inside
  // HTML/YAML, link destinations and reference titles are not code delimiters.
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.map) continue;
    const from = starts[token.map[0]], to = starts[token.map[1]] ?? source.length;
    const raw = source.slice(from, to); let cursor = 0;
    const code = [];
    const visit = items => { for (const item of items) { if (item.type === 'code_inline') code.push(item); if (item.children) visit(item.children); } };
    visit(token.children ?? []);
    for (const item of code) {
      const delimiter = item.markup; let opening = cursor, found = false;
      while ((opening = raw.indexOf(delimiter, opening)) !== -1) {
        if (raw[opening - 1] === '`' || raw[opening + delimiter.length] === '`') { opening += delimiter.length; continue; }
        let close = opening + delimiter.length;
        while ((close = raw.indexOf(delimiter, close)) !== -1) {
          if (raw[close - 1] !== '`' && raw[close + delimiter.length] !== '`') break;
          close += delimiter.length;
        }
        if (close === -1) break;
        let content = raw.slice(opening + delimiter.length, close).replace(/\r\n|\r|\n/g, ' ');
        if (/^ .* $/.test(content) && /[^ ]/.test(content)) content = content.slice(1, -1);
        if (content === item.content) {
          for (let n = from + opening; n < from + close + delimiter.length; n++) if (!/[\r\n]/.test(masked[n])) masked[n] = ' ';
          cursor = close + delimiter.length; found = true; break;
        }
        opening = close + delimiter.length;
      }
      if (!found) break; // Unlocated code is conservatively left inspectable.
    }
  }
  const text = masked.join('');
  const matches = [...text.matchAll(marker)].filter(match => {
    let slashes = 0; for (let i = match.index - 1; source[i] === '\\'; i--) slashes++;
    return slashes % 2 === 0;
  });
  let htmlCount = 0;
  const visit = items => { for (const token of items) { if (['html_block', 'html_inline'].includes(token.type)) htmlCount += [...token.content.matchAll(marker)].length; if (token.children) visit(token.children); } };
  visit(tokens);
  return { matches, count: Math.max(matches.length, htmlCount) };
}

export function inspectMetadata(input) {
  const source = decodeNote(input), absent = { status: 'absent', value: null, raw: null, start: null, end: null, diagnostics: [] };
  if (!/cuefluent/i.test(source) || !source.includes('<!--')) return Object.freeze(absent);
  const { tokens } = parseMarkdown(source), active = activeMarkers(source, tokens);
  if (!active.count) return Object.freeze(absent);
  const invalid = reason => Object.freeze({ ...absent, status: 'invalid', diagnostics: [reason] });
  if (Buffer.byteLength(source) > P.metadataSourceBytes) return invalid('metadata-input-limit');
  const matched = block.exec(source);
  if (active.count !== 1 || !matched) return invalid(active.count > 1 ? 'metadata-duplicate' : 'metadata-placement-or-syntax');
  const raw = matched[1], start = matched[0].length - raw.length, end = matched[0].length;
  if (Buffer.byteLength(raw) > P.metadataBytes || /<!--|-->|--!>/.test(matched[2])) return invalid('metadata-size-or-delimiter');
  try {
    const { value } = parseYaml(matched[2]);
    requireValue(Number.isSafeInteger(value.schema_version) && value.schema_version >= 1);
    if (value.schema_version !== 1) return Object.freeze({ status: 'unsupported', value: null, raw, start, end, diagnostics: ['metadata-version'] });
    return Object.freeze({ status: 'supported', value: validateMetadata(value), raw, start, end, diagnostics: [] });
  } catch { return invalid('metadata-invalid'); }
}

function withoutMetadata(source, inspection) {
  return inspection.raw === null ? source : source.slice(inspection.end);
}
/** Visible authored content, retaining any prefix and exact newline style. */
export function noteContent(input) {
  const source = decodeNote(input), inspection = inspectMetadata(source);
  if (inspection.status === 'invalid') fail('NOTE_METADATA_INVALID', 'Malformed metadata cannot be hidden in a review.');
  return (inspection.raw === null ? '' : source.slice(0, inspection.start)) + withoutMetadata(source, inspection);
}
function quoted(value) { const scalar = new Scalar(value); scalar.type = Scalar.QUOTE_DOUBLE; return scalar; }
function quoteSourceStrings(node) {
  visitYaml(node, { Scalar(_key, value) { if (typeof value.value === 'string') value.type = Scalar.QUOTE_DOUBLE; } });
  return node;
}

function renderMetadata(document, expandedMetadata, newline, preserveLayoutOnOverflow = false, sourceUpdate = false) {
  requireValue(typeof expandedMetadata === 'boolean');
  const expected = validateMetadata(document.toJS({ maxAliasCount: 0 }), sourceUpdate ? 'NOTE_SOURCE_LIMIT' : 'NOTE_METADATA_INVALID'), candidate = document.clone();
  // Flow style must spell out blank sequence items and escape multiline strings.
  // Preserve comments even when they need additional lines in compact output.
  if (!expandedMetadata) visitYaml(candidate, { Scalar(_key, node) {
    if (node.value === null) node.source = undefined;
    if (typeof node.value === 'string' && /[\r\n]/.test(node.value)) node.type = Scalar.QUOTE_DOUBLE;
  } });
  const serialize = (value, collectionStyle) => {
    const payload = value.toString({ lineWidth: 0, collectionStyle, flowCollectionPadding: false, doubleQuotedAsJSON: true });
    return `<!-- cuefluent\n${payload}-->\n`.replace(/\n/g, newline);
  };
  let raw = serialize(candidate, expandedMetadata ? 'block' : 'flow');
  // Escaping or indentation can exceed the fixed metadata limit in either
  // format. A formatting preference must not prevent an otherwise valid edit.
  if (preserveLayoutOnOverflow && Buffer.byteLength(raw) > P.metadataBytes) raw = serialize(document, 'any');
  if (sourceUpdate && Buffer.byteLength(raw) > P.metadataBytes) fail('NOTE_SOURCE_LIMIT', 'The resulting source metadata exceeds its byte limit. Preserve the note and supplied sources; do not truncate metadata to fit.');
  const rendered = inspectMetadata(raw);
  requireValue(rendered.status === 'supported' && isDeepStrictEqual(rendered.value, expected));
  return raw;
}

/** Existing metadata owns identity/descriptions. Agent-supplied replacements do
 * not overwrite it; explicit document sources append without losing information. */
export function preserveMetadata(originalInput, proposedInput, { usefulChange, updated, skillVersion, expandedMetadata = false, sources = [] } = {}) {
  const original = decodeNote(originalInput), proposed = decodeNote(proposedInput);
  const before = inspectMetadata(original), after = inspectMetadata(proposed);
  const additions = validateDocumentSources(sources);
  if (additions.length && before.status !== 'supported') {
    if (before.status === 'invalid') fail('NOTE_METADATA_INVALID', 'Malformed metadata cannot be repaired by a note update.');
    fail('NOTE_SOURCES_UNSUPPORTED', 'New sources require existing supported Cuefluent metadata. Preserve this note without enriching or replacing its metadata.');
  }
  const changes = additions.length ? sourceChanges(before.value.sources ?? [], additions) : { additions: [], amendments: new Map() };
  const sourcesChanged = changes.additions.length > 0 || changes.amendments.size > 0;
  if (sourcesChanged && usefulChange === false) fail('NOTE_SOURCE_ARGUMENT', 'New source metadata is a change; do not declare a source addition unchanged.');
  const unchanged = () => ({ bytes: Buffer.from(original), changed: false, diagnostics: before.diagnostics });
  if (!sourcesChanged && (original === proposed || usefulChange === false)) return unchanged();
  if (before.status === 'invalid' || after.status === 'invalid') fail('NOTE_METADATA_INVALID', 'Malformed metadata cannot be repaired by a note update.');
  const oldBody = withoutMetadata(original, before), newBody = withoutMetadata(proposed, after);
  if (oldBody === newBody && !sourcesChanged) return unchanged();
  const prefix = before.raw === null ? '' : original.slice(0, before.start);
  let raw = before.raw ?? '';
  if (before.status === 'supported') {
    const matched = block.exec(raw), { document } = parseYaml(matched[2]);
    if (sourcesChanged) {
      if (!document.has('sources')) document.set('sources', document.createNode([]));
      const sequence = document.get('sources', true);
      for (const [index, fields] of changes.amendments) {
        const node = sequence.items[index];
        const additions = quoteSourceStrings(document.createNode(fields));
        for (const pair of additions.items) node.add(pair);
      }
      // A sequence-end comment belongs with the original source set, not a
      // newly appended source. Keep it before the first addition.
      for (const source of changes.additions) {
        const node = quoteSourceStrings(document.createNode(source));
        if (sequence.comment) { node.commentBefore = sequence.comment; sequence.comment = null; }
        sequence.add(node);
      }
    }
    if (updated !== undefined) {
      requireValue(isNoteTimestamp(updated));
      const current = document.get('updated', true);
      if (isScalar(current)) current.value = updated;
      else document.set('updated', quoted(updated));
    }
    if (skillVersion !== undefined) {
      requireValue(typeof skillVersion === 'string' && SEMVER_VERSION_PATTERN.test(skillVersion));
      if (!document.has('generation')) document.set('generation', document.createNode({}));
      const current = document.getIn(['generation', 'skill_version'], true);
      if (isScalar(current)) current.value = skillVersion;
      else document.setIn(['generation', 'skill_version'], skillVersion);
    }
    if (oldBody !== newBody && before.value.generation?.content_hash !== undefined) {
      // The optional digest covers the exact note bytes outside its metadata block.
      const value = `sha256:${createHash('sha256').update(prefix + newBody).digest('hex')}`;
      document.getIn(['generation', 'content_hash'], true).value = value;
    }
    raw = renderMetadata(document, expandedMetadata, noteNewline(raw), true, sourcesChanged);
  }
  const bytes = Buffer.from(prefix + raw + newBody);
  return { bytes, changed: !bytes.equals(Buffer.from(original)), diagnostics: before.diagnostics };
}

export function createGeneratedNote(bodyInput, { id = randomUUID(), now, skillVersion, metadata = {}, expandedMetadata = false } = {}) {
  const body = decodeNote(bodyInput);
  metadata = dataValue(metadata);
  requireValue(inspectMetadata(body).status === 'absent' && isNoteTimestamp(now));
  const value = validateMetadata({ ...metadata, schema_version: 1, id, created: now, updated: now, generation: { ...metadata.generation, skill_version: skillVersion } }, metadata.sources?.length ? 'NOTE_SOURCE_LIMIT' : 'NOTE_METADATA_INVALID');
  const document = parseDocument(''); document.contents = document.createNode(value);
  document.set('created', quoted(now)); document.set('updated', quoted(now));
  if (document.has('sources')) quoteSourceStrings(document.get('sources', true));
  const result = Buffer.from(renderMetadata(document, expandedMetadata, noteNewline(body), false, Boolean(value.sources?.length)) + body);
  requireValue(inspectMetadata(result).status === 'supported'); return result;
}
