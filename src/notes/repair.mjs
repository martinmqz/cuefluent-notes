import { isDeepStrictEqual } from 'node:util';
import { isMap, isSeq } from 'yaml';
import { fail } from '../core/errors.mjs';
import { decodeNote, NOTE_PROFILE as P } from './profile.mjs';
import { editMetadata, inspectMetadata, lineStarts, serializeSources, validateDocumentSources, validateMetadata } from './metadata.mjs';
import { inlineText, normalizedText, parseMarkdown } from './markdown.mjs';
import { validateNote } from './validate.mjs';

/** Metadata repair changes a note's header and its alias comments, and nothing
 * else. Every operation is one of the typed forms below; none accepts note
 * content or a free-form metadata patch. The candidate is a pure function of the
 * original bytes and the operations, so a preview and the repair that follows it
 * construct the same bytes. */
export const REPAIR_LIMITS = Object.freeze({ operations: 256, aliasLength: 256 });
/** Header fields a repair may remove when each is named. */
export const REPAIR_FIELDS = Object.freeze(['type', 'context', 'series', 'sprint', 'period']);
const HASH_KEYS = ['source_hash', 'hash'];
const OPERATIONS = Object.freeze({
  'remove-content-hash': [], 'strip-source-hashes': [], 'remove-session-sources': [],
  'remove-fields': ['fields'], 'remove-sources': ['sources'], 'replace-sources': ['sources', 'with'],
  'replace-alias': ['line', 'alias', 'with'], 'remove-alias': ['line', 'alias'],
});
// The line of an alias comment, in whichever line-ending convention the note has.
const aliasLine = /^( {0,3}<!--[ \t]*aliases:)([^\r\n]*?)(-->[ \t]*(?:\r\n|\r|\n)?)$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const argument = () => fail('REPAIR_ARGUMENT', 'Use only the advertised repair operations with valid values.');
const inapplicable = message => fail('REPAIR_OPERATION_INVALID', message);
const same = (left, right) => serializeSources(left) === serializeSources(right);
/** Whether `stripped` is the document source `item` without its hash keys. */
const withoutHashes = (item, stripped) => item.type === 'document' && HASH_KEYS.some(key => Object.hasOwn(item, key)) &&
  same(Object.fromEntries(Object.entries(item).filter(([key]) => !HASH_KEYS.includes(key))), stripped);

function list(value, max) {
  if (!Array.isArray(value) || !value.length || value.length > max || Object.keys(value).length !== value.length) argument();
  return value;
}
function aliasText(value, replacement = false) {
  if (typeof value !== 'string' || !value || value.length > REPAIR_LIMITS.aliasLength || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) argument();
  // A stored alias reads back as it was given: no comma, markup or comment delimiter.
  if (replacement && (/,|<!--|-->|--!>/.test(value) || inlineText(value).trim() !== value || !normalizedText(value))) argument();
  return value;
}

const checked = new WeakSet();
/** Closed, bounded and canonical: the same request always has the same form. */
export function validateRepairOperations(input) {
  if (checked.has(input)) return input;
  const result = list(input, REPAIR_LIMITS.operations).map(item => {
    if (!plain(item) || typeof item.op !== 'string' || !Object.hasOwn(OPERATIONS, item.op)) argument();
    const keys = OPERATIONS[item.op];
    if (Object.keys(item).length !== keys.length + 1 || keys.some(key => !Object.hasOwn(item, key))) argument();
    const operation = { op: item.op };
    if (keys.includes('fields')) {
      operation.fields = [...list(item.fields, REPAIR_FIELDS.length)];
      if (operation.fields.some(field => !REPAIR_FIELDS.includes(field)) || new Set(operation.fields).size !== operation.fields.length) argument();
    }
    if (keys.includes('sources')) {
      operation.sources = [...list(item.sources, P.metadataItems)];
      if (operation.sources.some(index => !Number.isSafeInteger(index) || index < 0 || index >= P.metadataItems) || new Set(operation.sources).size !== operation.sources.length) argument();
    }
    if (item.op === 'replace-sources') {
      // The replacement is held to what a newly supplied source may be.
      const descriptors = validateDocumentSources([item.with]);
      if (descriptors.length !== 1) argument();
      operation.with = descriptors[0];
    }
    if (keys.includes('line')) {
      if (!Number.isSafeInteger(item.line) || item.line < 1) argument();
      operation.line = item.line; operation.alias = aliasText(item.alias);
      if (item.op === 'replace-alias') {
        operation.with = aliasText(item.with, true);
        if (operation.with === operation.alias) argument();
      }
    }
    return Object.freeze(operation);
  });
  Object.freeze(result); checked.add(result); return result;
}

/** The alias comment of each section, by the line of its H2 heading. */
function aliasComments(source) {
  const starts = lineStarts(source), found = []; let section = null;
  for (const token of parseMarkdown(source).tokens) {
    if (token.type === 'footnote_block_open') break;
    if (token.type === 'heading_open' && token.level === 0 && ['h1', 'h2'].includes(token.tag)) { section = token.tag === 'h2' ? token.map[0] + 1 : null; continue; }
    if (token.type !== 'html_block' || token.level !== 0 || !token.map || section === null) continue;
    const start = starts[token.map[0]], end = starts[token.map[1]] ?? source.length, parts = aliasLine.exec(source.slice(start, end));
    if (parts) found.push({ line: section, start, end, parts });
  }
  return found;
}
const aliasValues = text => text.split(',').map(value => inlineText(value).trim());
/** A stored alias as the check identifies it: its Markdown read as text, then
 * case, accents, width and punctuation folded, so every spelling of it at a
 * section is one alias. A requested alias is the text the check reported, so it
 * is folded as it is and never read as Markdown again. */
const aliasKey = segment => normalizedText(inlineText(segment).trim());

function planSources(operations, sources) {
  const actions = new Map(); let hashes = false, sessions = false;
  const claim = (index, action) => {
    if (index >= sources.length) inapplicable('A source index is beyond the note\'s sources.');
    if (actions.has(index)) inapplicable('Two operations name the same source.');
    actions.set(index, action);
  };
  for (const operation of operations) {
    if (operation.op === 'strip-source-hashes') hashes = true;
    else if (operation.op === 'remove-session-sources') sessions = true;
    else if (operation.op === 'remove-sources') for (const index of operation.sources) claim(index, { remove: true });
    else if (operation.op === 'replace-sources') {
      const first = Math.min(...operation.sources);
      for (const index of operation.sources) claim(index, index === first ? { with: operation.with } : { remove: true });
    }
  }
  // Each slot is a kept source, with the hash keys to drop from it, or a replacement.
  const slots = [];
  sources.forEach((source, index) => {
    const action = actions.get(index);
    if (action?.remove) return;
    let slot;
    if (action) slot = { index, value: action.with, replacement: true };
    else if (sessions && source.type === 'session' && !Object.hasOwn(source, 'raw_ref')) return;
    else {
      const drop = hashes && source.type === 'document' ? HASH_KEYS.filter(key => Object.hasOwn(source, key)) : [];
      slot = { index, drop, value: drop.length ? Object.fromEntries(Object.entries(source).filter(([key]) => !drop.includes(key))) : source };
    }
    // Exact duplicates collapse onto the first; the same reference with other
    // details is two claims, which only a selected operation can settle.
    if (!slots.some(item => same(item.value, slot.value))) slots.push(slot);
  });
  return slots;
}

function repairHeader(metadata, operations) {
  const value = metadata.value, expected = { ...value };
  const fields = operations.filter(item => item.op === 'remove-fields').flatMap(item => item.fields).filter(field => Object.hasOwn(value, field));
  const contentHash = operations.some(item => item.op === 'remove-content-hash') && value.generation?.content_hash !== undefined;
  for (const field of fields) delete expected[field];
  if (contentHash) {
    const { content_hash: _removed, ...rest } = value.generation;
    if (Object.keys(rest).length) expected.generation = rest; else delete expected.generation;
  }
  const sources = value.sources ?? [], slots = planSources(operations, sources);
  // An untouched source list stays exactly as it is, an empty one included.
  const resourced = slots.length !== sources.length || slots.some((slot, index) => slot.value !== sources[index]);
  if (resourced) { if (slots.length) expected.sources = slots.map(slot => slot.value); else delete expected.sources; }
  if (isDeepStrictEqual(expected, value)) return metadata.raw;
  try { validateMetadata(expected); }
  catch (error) {
    if (error.code !== 'NOTE_METADATA_INVALID') throw error;
    fail('REPAIR_SOURCE_CONFLICT', 'The remaining sources would share one identity with different details. Select which to keep, replace or remove.');
  }
  return editMetadata(metadata.raw, (document, sourceNode) => {
    for (const field of fields) document.delete(field);
    if (contentHash) { document.deleteIn(['generation', 'content_hash']); if (!Object.hasOwn(expected, 'generation')) document.delete('generation'); }
    const sequence = document.get('sources', true);
    if (resourced && isSeq(sequence)) {
      const items = sequence.items;
      sequence.items = slots.map(slot => {
        const item = items[slot.index];
        if (!slot.replacement) { for (const key of slot.drop) if (isMap(item)) item.delete(key); return item; }
        // A replacement takes the layout of the earliest entry it replaces.
        return sourceNode(slot.value, item);
      });
      if (!slots.length) document.delete('sources');
    }
    return expected;
  });
}

function repairAliases(source, operations) {
  const requested = operations.filter(item => item.op === 'replace-alias' || item.op === 'remove-alias');
  if (!requested.length) return [];
  const comments = aliasComments(source), edits = [];
  for (const line of new Set(requested.map(item => item.line))) {
    const comment = comments.find(item => item.line === line);
    if (!comment) inapplicable('No section with aliases has its heading on that line.');
    const [, open, text, close] = comment.parts, lead = /^[ \t]*/.exec(text)[0], trail = /[ \t]*$/.exec(text.slice(lead.length))[0];
    let segments = text.slice(lead.length, text.length - trail.length).split(',');
    for (const operation of requested.filter(item => item.line === line)) {
      const key = normalizedText(operation.alias), matches = segments.map((segment, index) => aliasKey(segment) === key ? index : -1).filter(index => index >= 0);
      if (!matches.length) inapplicable('The section does not have that alias.');
      if (operation.op === 'replace-alias') {
        // An alias the section already has is removed, not written a second time.
        const replacement = normalizedText(operation.with);
        if (segments.some((segment, index) => !matches.includes(index) && aliasKey(segment) === replacement)) inapplicable('The section already has the replacement alias; remove the other one instead.');
        const [, before, after] = /^([ \t]*)[\s\S]*?([ \t]*)$/.exec(segments[matches[0]]);
        segments[matches[0]] = before + operation.with + after; matches.shift();
      }
      segments = segments.filter((_segment, index) => !matches.includes(index));
    }
    if (segments.length) { segments[0] = segments[0].trimStart(); segments[segments.length - 1] = segments.at(-1).trimEnd(); }
    edits.push({ start: comment.start, end: comment.end, text: segments.length ? open + lead + segments.join(',') + trail + close : '' });
  }
  return edits;
}

/** Build the exact candidate for one note. `changed` is false when the
 * operations leave every byte as it is, which is how a repaired note answers
 * the same mechanical request again. */
export function constructRepair(input, operationsInput) {
  const operations = validateRepairOperations(operationsInput), source = decodeNote(input);
  const validation = validateNote(source), metadata = validation.metadata;
  if (!validation.valid || !metadata) fail('REPAIR_NOTE_BLOCKED', 'The note does not satisfy the note profile, so it is reported and left unchanged.');
  const header = operations.some(item => !['replace-alias', 'remove-alias'].includes(item.op));
  if (header && metadata.status === 'unsupported') fail('REPAIR_NOTE_BLOCKED', 'The metadata uses a schema version that is not interpreted here. It stays unchanged.');
  if (metadata.status === 'supported' && metadata.value.type === 'log') fail('REPAIR_NOTE_BLOCKED', 'Activity logs are outside metadata repair.');
  let candidate = source;
  for (const edit of repairAliases(source, operations).sort((left, right) => right.start - left.start)) candidate = candidate.slice(0, edit.start) + edit.text + candidate.slice(edit.end);
  if (metadata.status === 'supported') {
    const raw = repairHeader(metadata, operations);
    if (raw !== metadata.raw) candidate = candidate.slice(0, metadata.start) + raw + candidate.slice(metadata.end);
  } else if (operations.some(item => ['remove-sources', 'replace-sources'].includes(item.op))) inapplicable('The note has no sources to select.');
  if (candidate === source) return Object.freeze({ changed: false, bytes: Buffer.from(source) });
  assertRepairScope(source, candidate);
  return Object.freeze({ changed: true, bytes: Buffer.from(candidate) });
}

function parts(source) {
  const metadata = inspectMetadata(source), body = metadata.raw === null ? source : source.slice(metadata.end);
  const comments = aliasComments(body); let text = '', cursor = 0;
  // Where each alias comment sits among the bytes that a repair may not touch.
  const offsets = comments.map(comment => { text += body.slice(cursor, comment.start); cursor = comment.end; return text.length; });
  return { metadata, prefix: metadata.raw === null ? '' : source.slice(0, metadata.start), protectedText: text + body.slice(cursor), offsets, comments, body };
}

/** The contract of a repair, checked on the two versions alone: every byte
 * outside the header and the alias comments is identical, an alias comment
 * stays at its section, identity and timestamps stay, no field is added, and a
 * source is one the note had, that source without its hashes, or a descriptor
 * a new note could be given. */
export function assertRepairScope(originalInput, candidateInput) {
  const violation = () => fail('REPAIR_SCOPE_VIOLATION', 'The candidate changes more than a metadata repair may change.');
  const original = decodeNote(originalInput), candidate = decodeNote(candidateInput), before = parts(original), after = parts(candidate);
  if (!validateNote(candidate).valid || before.prefix !== after.prefix || before.protectedText !== after.protectedText) violation();
  if (after.offsets.some(offset => !before.offsets.includes(offset)) || new Set(after.offsets).size !== after.offsets.length) violation();
  if (before.metadata.status !== after.metadata.status) violation();
  if (before.metadata.status !== 'supported') { if (before.metadata.raw !== after.metadata.raw) violation(); return; }
  const old = before.metadata.value, next = after.metadata.value;
  for (const key of Object.keys(next)) if (!Object.hasOwn(old, key)) violation();
  for (const key of Object.keys(old)) {
    if (key === 'sources' || key === 'generation') continue;
    if (Object.hasOwn(next, key) ? !isDeepStrictEqual(next[key], old[key]) : !REPAIR_FIELDS.includes(key)) violation();
  }
  const { content_hash: _hash, ...generation } = old.generation ?? {};
  if (!isDeepStrictEqual(next.generation ?? {}, generation) && !isDeepStrictEqual(next.generation, old.generation)) violation();
  let cursor = 0; const sources = old.sources ?? [];
  for (const source of next.sources ?? []) {
    const at = sources.findIndex((item, index) => index >= cursor && (same(item, source) || withoutHashes(item, source)));
    if (at >= 0) { cursor = at + 1; continue; }
    try { if (validateDocumentSources([source]).length !== 1) violation(); } catch { violation(); }
  }
}

/** What a repair changes, read from the two versions alone. It names every
 * header field and alias list that differs, with both values, so it cannot say
 * less or more than the candidate holds. */
export function describeRepair(originalInput, candidateInput) {
  const original = decodeNote(originalInput), candidate = decodeNote(candidateInput), before = parts(original), after = parts(candidate);
  const header = [], sources = { removed: [], stripped: [], added: [] }, aliases = [];
  if (before.metadata.status === 'supported' && after.metadata.status === 'supported') {
    const old = before.metadata.value, next = after.metadata.value;
    const field = (name, was, now) => { if (!isDeepStrictEqual(was, now)) header.push({ field: name, before: was ?? null, after: now ?? null }); };
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (key === 'sources') continue;
      if (key === 'generation') for (const inner of new Set([...Object.keys(old.generation ?? {}), ...Object.keys(next.generation ?? {})])) field(`generation.${inner}`, old.generation?.[inner], next.generation?.[inner]);
      else field(key, old[key], next[key]);
    }
    const kept = new Set(), was = old.sources ?? []; let cursor = 0;
    for (const [index, source] of (next.sources ?? []).entries()) {
      const at = was.findIndex((item, position) => position >= cursor && (same(item, source) || withoutHashes(item, source)));
      if (at < 0) { sources.added.push({ index, source }); continue; }
      kept.add(at); cursor = at + 1;
      if (!same(was[at], source)) sources.stripped.push({ index: at, fields: Object.fromEntries(HASH_KEYS.filter(key => Object.hasOwn(was[at], key)).map(key => [key, was[at][key]])) });
    }
    was.forEach((source, index) => { if (!kept.has(index)) sources.removed.push({ index, source }); });
  }
  const values = comment => aliasValues(comment.parts[2]);
  before.comments.forEach((comment, index) => {
    const now = after.comments[after.offsets.indexOf(before.offsets[index])], was = values(comment), next = now ? values(now) : [];
    if (!isDeepStrictEqual(was, next)) aliases.push({ line: lineStarts(original.slice(0, original.length - before.body.length)).length - 1 + comment.line, before: was, after: next });
  });
  const listed = Object.fromEntries(Object.entries(sources).filter(([, items]) => items.length));
  return { bytes: { before: Buffer.byteLength(original), after: Buffer.byteLength(candidate) }, ...(header.length ? { header } : {}),
    ...(Object.keys(listed).length ? { sources: listed } : {}), ...(aliases.length ? { aliases } : {}) };
}

/** The change list as text, so that a bounded page can carry any part of it. */
export const serializeRepair = description => `${JSON.stringify(description, null, 1)}\n`;

/** One line for a draft descriptor and a result: what kind of change, never a value. */
export function summarizeRepair(description) {
  const said = [], plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (description.header?.length) said.push(`${description.header.map(item => item.field).join(', ')} removed`);
  const { removed = [], stripped = [], added = [] } = description.sources ?? {};
  if (stripped.length) said.push(`hashes removed from ${plural(stripped.length, 'source')}`);
  if (removed.length) said.push(`${plural(removed.length, 'source')} removed`);
  if (added.length) said.push(`${plural(added.length, 'source')} supplied`);
  if (description.aliases?.length) said.push(`aliases changed in ${plural(description.aliases.length, 'section')}`);
  return `Metadata repair: ${said.join('; ')} (${description.bytes.before} to ${description.bytes.after} bytes).`.slice(0, 1024);
}
