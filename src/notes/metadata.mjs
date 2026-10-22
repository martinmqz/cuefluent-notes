import { randomUUID } from 'node:crypto';
import { isAlias, isMap, isScalar, isSeq, parseDocument, Scalar } from 'yaml';
import { fail } from '../core/errors.mjs';
import { decodeNote, NOTE_PROFILE as P } from './profile.mjs';
import { parseMarkdown } from './markdown.mjs';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
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
function dataValue(input) {
  let nodes = 0;
  function visit(value, depth) {
    requireValue(++nodes <= P.metadataNodes && depth <= P.metadataDepth);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { requireValue(Number.isFinite(value)); return value; }
    if (typeof value === 'string') {
      requireValue(value.length <= P.metadataString && !/(?![\t\n\r])[\p{Cc}\p{Cs}]/u.test(value) && !/<!--|-->|--!>/.test(value));
      return value;
    }
    requireValue(Array.isArray(value) ? Object.getPrototypeOf(value) === Array.prototype : plain(value));
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      requireValue(value.length <= P.metadataItems && keys.length === value.length + 1);
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[index]; requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        return visit(descriptor.value, depth + 1);
      }));
    }
    requireValue(keys.length <= P.metadataItems && keys.every(key => typeof key === 'string' && keyAllowed(key)));
    return Object.freeze(Object.fromEntries(keys.map(key => {
      const descriptor = descriptors[key]; requireValue(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
      visit(key, depth + 1); return [key, visit(descriptor.value, depth + 1)];
    })));
  }
  requireValue(plain(input)); return visit(input, 0);
}

/** Provenance describes a source; it never grants access to that source. */
export function noteSourceIdentity(source) {
  source = dataValue(source);
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

export function validateMetadata(input) {
  const value = dataValue(input);
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
    requireValue(Array.isArray(value.sources)); const identities = value.sources.map(noteSourceIdentity);
    requireValue(new Set(identities).size === identities.length);
  }
  if (Object.hasOwn(value, 'series')) {
    requireValue(plain(value.series) && typeof value.series.id === 'string' && idPattern.test(value.series.id));
    optional(value.series, 'label', item => text(item));
  }
  optional(value, 'sprint', item => text(item, 128));
  if (Object.hasOwn(value, 'period')) requireValue(plain(value.period) && calendarDate(value.period.start) && calendarDate(value.period.end) && value.period.start <= value.period.end && timezone(value.period.timezone));
  if (Object.hasOwn(value, 'generation')) {
    requireValue(plain(value.generation)); optional(value.generation, 'skill_version', item => typeof item === 'string' && versionPattern.test(item));
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
function activeMarkers(source, tokens) {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
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
function quoted(value) { const scalar = new Scalar(value); scalar.type = Scalar.QUOTE_DOUBLE; return scalar; }

/** Existing metadata owns identity/descriptions. Agent-supplied replacements do
 * not overwrite it. Timestamp/version changes occur only for a useful body edit. */
export function preserveMetadata(originalInput, proposedInput, { usefulChange, updated, skillVersion } = {}) {
  const original = decodeNote(originalInput), proposed = decodeNote(proposedInput);
  const before = inspectMetadata(original), after = inspectMetadata(proposed);
  const unchanged = () => ({ bytes: Buffer.from(original), changed: false, diagnostics: before.diagnostics });
  if (original === proposed || usefulChange === false) return unchanged();
  if (before.status === 'invalid' || after.status === 'invalid') fail('NOTE_METADATA_INVALID', 'Malformed metadata cannot be repaired by a note update.');
  const oldBody = withoutMetadata(original, before), newBody = withoutMetadata(proposed, after);
  if (oldBody === newBody) return unchanged();
  let raw = before.raw ?? '';
  if (before.status === 'supported' && (updated !== undefined || skillVersion !== undefined)) {
    const matched = block.exec(raw), { document } = parseYaml(matched[2]);
    if (updated !== undefined) {
      requireValue(isNoteTimestamp(updated));
      const current = document.get('updated', true);
      if (isScalar(current)) current.value = updated;
      else document.set('updated', quoted(updated));
    }
    if (skillVersion !== undefined) {
      requireValue(typeof skillVersion === 'string' && versionPattern.test(skillVersion));
      if (!document.has('generation')) document.set('generation', document.createNode({}));
      const current = document.getIn(['generation', 'skill_version'], true);
      if (isScalar(current)) current.value = skillVersion;
      else document.setIn(['generation', 'skill_version'], skillVersion);
    }
    validateMetadata(document.toJS({ maxAliasCount: 0 }));
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    raw = `<!-- cuefluent\n${document.toString({ lineWidth: 0 })}-->\n`.replace(/\n/g, newline);
    requireValue(Buffer.byteLength(raw) <= P.metadataBytes);
  }
  const prefix = before.raw === null ? '' : original.slice(0, before.start);
  const bytes = Buffer.from(prefix + raw + newBody);
  return { bytes, changed: !bytes.equals(Buffer.from(original)), diagnostics: before.diagnostics };
}

export function createGeneratedNote(bodyInput, { id = randomUUID(), now, skillVersion, metadata = {} } = {}) {
  const body = decodeNote(bodyInput);
  metadata = dataValue(metadata);
  requireValue(inspectMetadata(body).status === 'absent' && isNoteTimestamp(now));
  const value = validateMetadata({ ...metadata, schema_version: 1, id, created: now, updated: now, generation: { ...metadata.generation, skill_version: skillVersion } });
  const document = parseDocument(''); document.contents = document.createNode(value);
  document.set('created', quoted(now)); document.set('updated', quoted(now));
  const result = Buffer.from(`<!-- cuefluent\n${document.toString({ lineWidth: 0 })}-->\n${body}`);
  requireValue(inspectMetadata(result).status === 'supported'); return result;
}
