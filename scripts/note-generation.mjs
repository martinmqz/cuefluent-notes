import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Document, Scalar } from 'yaml';
import { inspectNoteMetadata, isNoteTimestamp, isNoteSkillVersion, validateNoteMetadataValue,
  validateNoteMetadata, noteSourceIdentity, MAX_NOTE_BYTES } from './note-metadata.mjs';
import { digest, fail, keys } from './workflow-values.mjs';

const known = { schema_version: true, id: true, type: true, created: true, updated: true, sources: true,
  context: { project: true, topics: true, entities: true }, series: { id: true, label: true }, sprint: true,
  period: { start: true, end: true, timezone: true }, generation: { skill_version: true, content_hash: true } };
const same = isDeepStrictEqual;
const bodyOf = (content, inspected) => inspected.block
  ? content.slice(0, inspected.block.start) + content.slice(inspected.block.end) : content;
const validText = content => {
  if (typeof content !== 'string' || /[\uD800-\uDFFF]/u.test(content) || Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) fail('NOTE_CONTENT_LIMIT');
  return content;
};
const inspect = content => {
  const result = inspectNoteMetadata(validText(content));
  if (result.status === 'invalid') fail('NOTE_METADATA_INVALID');
  return result;
};
const metadataCheck = operation => {
  try { return operation(); } catch { fail('NOTE_METADATA_INVALID'); }
};

function preserveUnknown(before, after, fields) {
  for (const [key, value] of Object.entries(before)) {
    if (!Object.hasOwn(fields, key)) {
      if (!Object.hasOwn(after, key) || !same(value, after[key])) fail('NOTE_METADATA_UNKNOWN_CHANGED');
    } else if (fields[key] !== true) preserveUnknown(value, after[key] ?? {}, fields[key]);
  }
}

/** Validate an inspected transition without changing either version's bytes. */
export function assertNoteTransition(original, content) {
  const after = inspect(content), before = original === null ? null : inspect(original);
  return assertInspectedNoteTransition(before, after);
}

/** Internal callers reuse inspections of their exact hashed bytes. Never accept
 * inspection objects from workflow requests as validation or write authority. */
export function assertInspectedNoteTransition(before, after) {
  if (before?.status === 'invalid' || after.status === 'invalid') fail('NOTE_METADATA_INVALID');
  if (before?.status === 'unsupported') {
    if (after.status !== 'unsupported' || after.block.raw !== before.block.raw) fail('NOTE_METADATA_OPAQUE_CHANGED');
  } else if (before?.status === 'valid') {
    if (after.status !== 'valid' || after.value.id !== before.value.id ||
        before.value.created !== after.value.created ||
        (before.value.series && before.value.series.id !== after.value.series?.id)) fail('NOTE_METADATA_IDENTITY_CHANGED');
    if (before.value.updated && (!after.value.updated || Date.parse(after.value.updated) < Date.parse(before.value.updated))) fail('NOTE_METADATA_TIME_REVERSED');
    preserveUnknown(before.value, after.value, known);
    for (const source of before.value.sources ?? []) {
      if (!(after.value.sources ?? []).some(item => same(item, source))) fail('NOTE_METADATA_SOURCE_LOST');
    }
  }
  return { before, after };
}

function patchMetadata(current, patch) {
  metadataCheck(() => keys(patch, [], ['type', 'context', 'sources', 'series', 'sprint', 'period']));
  const result = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'sources') {
      if (!Array.isArray(value)) fail('NOTE_METADATA_INVALID');
      result.sources ??= [];
      for (const item of value) {
        const identity = metadataCheck(() => noteSourceIdentity(item));
        const existing = result.sources.find(source => noteSourceIdentity(source) === identity);
        if (existing && !same(existing, item)) fail('NOTE_METADATA_SOURCE_CHANGED');
        if (!existing) result.sources.push(structuredClone(item));
      }
    } else if (['context', 'series', 'period'].includes(key)) {
      metadataCheck(() => keys(value, [], Object.keys(known[key])));
      result[key] = { ...result[key], ...structuredClone(value) };
    } else result[key] = value;
  }
  return result;
}
function insertBlock(body, block, position) {
  // Keep blank lines/BOM, but never borrow indentation from the first content
  // line: four spaces would turn the inserted comment into visible code.
  const start = position ?? /^(?:\uFEFF)?(?:[ \t]*(?:\r\n|\r|\n))*/.exec(body)[0].length;
  return body.slice(0, start) + block + body.slice(start);
}

/** Pure preparation of a complete proposal. No reads, writes, source discovery,
 * authorization or prose reconciliation happen here. Save these exact bytes. */
export function prepareNote(request) {
  keys(request, ['original', 'content', 'now', 'skillVersion'], ['metadata', 'enrich', 'contentHash', 'createSeries']);
  if (!isNoteTimestamp(request.now)) fail('NOTE_METADATA_INVALID');
  if (!isNoteSkillVersion(request.skillVersion)) fail('NOTE_METADATA_INVALID');
  for (const key of ['enrich', 'contentHash', 'createSeries']) if (request[key] !== undefined && typeof request[key] !== 'boolean') fail('NOTE_METADATA_INVALID');
  const original = request.original, proposed = inspect(request.content);
  const previous = original === null ? null : inspect(original);
  const patch = Object.hasOwn(request, 'metadata') ? request.metadata : {};
  metadataCheck(() => validateNoteMetadataValue(patch));
  const result = (content, inspected) => ({ content, changed: content !== original, metadataStatus: inspected.status });
  if (previous?.status === 'unsupported') {
    if (Object.keys(patch).length || request.enrich || request.contentHash || request.createSeries) fail('NOTE_METADATA_OPAQUE_CHANGED');
    assertInspectedNoteTransition(previous, proposed);
    return result(request.content, proposed);
  }
  if (proposed.status !== 'absent' && (!previous?.block || proposed.block.raw !== previous.block.raw)) fail('NOTE_METADATA_PROPOSAL_CHANGED');
  if (previous?.status === 'absent' && !request.enrich) {
    if (Object.keys(patch).length || request.contentHash || request.createSeries || proposed.status !== 'absent') fail('NOTE_METADATA_ENRICHMENT_REQUIRED');
    return result(request.content, proposed);
  }
  const body = bodyOf(request.content, proposed);
  // Prepending an HTML comment would disable another tool's leading frontmatter.
  if (!previous?.block && /^(?:\uFEFF)?[ \t\r\n]*(?:---|\+\+\+)[ \t]*(?:\r\n|\r|\n|$)/.test(body)) fail('NOTE_FRONTMATTER_CONFLICT');
  const value = patchMetadata(previous?.value ?? { schema_version: 1, id: `note_${randomUUID()}`,
    ...(original === null ? { created: request.now } : {}) }, patch);
  if (request.createSeries) {
    // Creation is explicit: a missing ID must never silently split an existing
    // series, and a supplied ID must never be replaced by a generated one.
    if (previous?.value?.series || Object.hasOwn(value.series ?? {}, 'id')) fail('NOTE_METADATA_SERIES_CONFLICT');
    value.series = { ...value.series, id: `series_${randomUUID()}` };
  }
  const hashed = request.contentHash || Boolean(previous?.value?.generation?.content_hash);
  const unchanged = previous?.status === 'valid' && body === bodyOf(original, previous) && same(value, previous.value) &&
    (!request.contentHash || previous.value.generation?.content_hash !== undefined);
  if (unchanged) return result(original, previous);
  value.updated = request.now;
  value.generation = { ...value.generation, skill_version: request.skillVersion,
    ...(hashed ? { content_hash: `sha256:${digest(body)}` } : {}) };
  metadataCheck(() => { validateNoteMetadataValue(value); validateNoteMetadata(value); });
  const document = new Document(value);
  for (const key of ['created', 'updated']) if (document.has(key)) document.get(key, true).type = Scalar.QUOTE_DOUBLE;
  if (value.period) for (const key of ['start', 'end']) document.getIn(['period', key], true).type = Scalar.QUOTE_DOUBLE;
  const newline = /\r\n|\r|\n/.exec(previous?.block?.raw ?? body)?.[0] ?? '\n';
  const block = ('<!-- cuefluent\n' + document.toString({ lineWidth: 0 }) + '-->\n').replace(/\n/g, newline);
  // Retain the supplied block's location. For a metadata-free proposal, reuse
  // the original prefix when it still exists so trailing blanks do not migrate.
  const prefix = previous?.block ? original.slice(0, previous.block.start) : null;
  const position = proposed.block?.start ?? (prefix !== null && body.startsWith(prefix) &&
    (prefix || !body.startsWith('\uFEFF')) ? prefix.length : undefined);
  const content = insertBlock(body, block, position), after = inspect(content);
  if (after.status !== 'valid' || after.block.raw !== block || !same(after.value, value) || bodyOf(content, after) !== body) fail('NOTE_METADATA_INVALID');
  assertInspectedNoteTransition(previous, after);
  return result(content, after);
}

/** A claim proves selected immutable capture identities, not the truth of prose.
 * Keep prior descriptors; new session descriptors must come from mapped inputs. */
export function assertProcessingNoteSources(before, after, inputs) {
  if (after.status !== 'valid') return;
  const oldSources = before?.value?.sources ?? [], sources = after.value.sources ?? [];
  const matches = (source, input) => source.type === 'session' && source.client === input.identity.client &&
    source.session_id === input.identity.sessionId && source.unit_id === input.identity.unitId && source.revision === input.evidenceHash;
  if (inputs.some(input => !sources.some(source => matches(source, input)))) fail('NOTE_METADATA_INPUT_MISSING');
  for (const source of sources.filter(item => item.type === 'session')) {
    if (oldSources.some(old => same(old, source))) continue;
    const input = inputs.find(item => matches(source, item));
    if (!input || (source.source_hash !== undefined && source.source_hash !== `sha256:${input.fileHash}`)) fail('NOTE_METADATA_INPUT_MISMATCH');
  }
}
