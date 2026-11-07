import { REPAIR_FIELDS, REPAIR_HASH_FIELDS } from './repair.mjs';
import { decodeNote } from './profile.mjs';
import { SOURCE_LOCATOR_LENGTH, inspectMetadata, isLocalSourceReference, noteContent } from './metadata.mjs';
import { hiddenComments, reviewNoteContent, validateNote } from './validate.mjs';
import { normalizedText, parseMarkdown } from './markdown.mjs';

/** What each finding means and how it could be resolved. A finding describes a
 * note; it is not a defect by itself, and nothing in this module changes a file.
 * mechanical: a fixed transformation would remove it. choice: someone supplies a
 * replacement or picks one. content-update: an ordinary note update resolves it.
 * blocked: it is reported and nothing is proposed. */
const finding = (repair, message) => Object.freeze({ repair, message });
export const DOCTOR_FINDINGS = Object.freeze({
  'note-unreadable': finding('blocked', 'The file is not an ordinary file of bounded UTF-8 Markdown or could not be opened, so it was not read as a note.'),
  'note-invalid': finding('blocked', 'The note does not satisfy the supported note profile, so the writer cannot change it.'),
  'metadata-invalid': finding('blocked', 'The Cuefluent metadata block is malformed. It is reported, never repaired.'),
  'metadata-unsupported': finding('blocked', 'The metadata block uses a schema version that is not interpreted here. It stays unchanged.'),
  'note-id-duplicate': finding('blocked', 'Another note declares the same note ID. Identities are reported, never reassigned.'),
  'content-hash': finding('mechanical', 'The header carries an embedded content hash that the writer neither computes nor checks.'),
  'source-hash': finding('mechanical', 'Document sources carry embedded hashes that nothing verifies.'),
  'source-session': finding('mechanical', 'Sources name sessions of a capture system instead of documents.'),
  'descriptive-field': finding('mechanical', 'The header carries descriptive fields that the writer adds to no note.'),
  'source-field': finding('choice', 'Document sources carry fields outside the supplied-source contract, such as a description.'),
  'source-local-ref': finding('choice', 'Document sources name a local path or file URL instead of a portable reference.'),
  'source-long-locator': finding('choice', 'Document sources have a locator longer than the limit for a newly supplied one.'),
  'source-volume': finding('choice', 'The note cites many separate document sources.'),
  'hidden-comment': finding('content-update', 'The body contains hidden HTML comments.'),
  'alias-in-note': finding('choice', 'An alias belongs to more than one section of this note.'),
  'alias-across-notes': finding('choice', 'An alias also belongs to sections of other notes.'),
});
/** Document sources above this count are reported as volume. */
export const DOCTOR_SOURCE_VOLUME = 20;

const SUBMITTED = new Set(['type', 'ref', 'locator', 'version']);
const HASHES = new Set(REPAIR_HASH_FIELDS);
const size = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
// The stored form varies with the header layout, so a field is measured on its
// JSON form: an estimate of what removing it would save, not an exact count.
const fieldBytes = (record, keys) => keys.reduce((total, key) => total + size(key) + size(JSON.stringify(record[key])), 0);

/** A file refused before decoding has the same record as undecodable bytes. */
export const unreadableNoteHealth = (reason, bytes = 0) => ({ status: 'unreadable', bytes, id: null, headerBytes: 0, aliasBytes: 0, sections: 0, aliases: [],
  sources: { document: 0, session: 0 }, findings: [{ code: 'note-unreadable', count: 1, bytes: 0, items: [{ reason }] }] });

/** One note's metadata state, alias occurrences and findings that need no other
 * note. Reads the given bytes only. */
export function inspectNoteHealth(input) {
  const findings = [];
  const add = (code, count, bytes, items) => { if (count) findings.push({ code, count, bytes, items }); };
  const empty = { id: null, headerBytes: 0, aliasBytes: 0, sections: 0, aliases: [], sources: { document: 0, session: 0 } };
  let source;
  try { source = decodeNote(input); }
  catch (error) {
    return unreadableNoteHealth(error.code, input?.byteLength ?? 0);
  }
  const syntax = parseMarkdown(source), validation = validateNote(source, { syntax }), metadata = validation.metadata ?? inspectMetadata(source, syntax);
  const errors = [...new Set(validation.diagnostics.filter(item => item.severity === 'error' && item.code !== 'metadata-invalid').map(item => item.code))];
  add('note-invalid', errors.length, 0, errors.map(reason => ({ reason })));
  if (metadata.status === 'invalid') add('metadata-invalid', 1, 0, metadata.diagnostics.map(reason => ({ reason })));
  if (metadata.status === 'unsupported') add('metadata-unsupported', 1, size(metadata.raw), []);
  const result = { status: metadata.status, bytes: size(source), ...empty, sources: { document: 0, session: 0 }, findings };
  if (metadata.raw !== null) result.headerBytes = size(metadata.raw);
  if (metadata.status !== 'invalid') result.aliasBytes = size(noteContent(source, metadata)) - size(reviewNoteContent(source, metadata, syntax));

  if (metadata.status === 'supported') {
    const value = metadata.value, sources = value.sources ?? [];
    result.id = value.id;
    const tally = () => ({ count: 0, bytes: 0, items: [] });
    const hashes = tally(), sessions = tally(), fields = tally(), local = tally(), locators = tally();
    let documentBytes = 0;
    sources.forEach((item, index) => {
      if (item.type === 'session') {
        result.sources.session++; sessions.count++; sessions.bytes += size(item);
        sessions.items.push(Object.hasOwn(item, 'raw_ref') ? { index, reference: true } : { index }); return;
      }
      result.sources.document++; documentBytes += size(item);
      const keys = Object.keys(item), hashed = keys.filter(key => HASHES.has(key)), extra = keys.filter(key => !SUBMITTED.has(key) && !HASHES.has(key));
      if (hashed.length) { hashes.count++; hashes.bytes += fieldBytes(item, hashed); hashes.items.push({ index }); }
      if (extra.length) { fields.count++; fields.bytes += fieldBytes(item, extra); fields.items.push({ index, fields: extra.slice(0, 8) }); }
      if (isLocalSourceReference(item.ref)) { local.count++; local.bytes += size(item.ref); local.items.push({ index }); }
      if (typeof item.locator === 'string' && item.locator.length > SOURCE_LOCATOR_LENGTH) {
        locators.count++; locators.bytes += size(item.locator); locators.items.push({ index, length: item.locator.length });
      }
    });
    if (value.generation?.content_hash !== undefined) add('content-hash', 1, fieldBytes(value.generation, ['content_hash']), []);
    add('source-hash', hashes.count, hashes.bytes, hashes.items);
    add('source-session', sessions.count, sessions.bytes, sessions.items);
    if (value.type !== 'log') {
      const present = REPAIR_FIELDS.filter(key => value[key] !== undefined);
      add('descriptive-field', present.length, fieldBytes(value, present), present.map(field => ({ field })));
    }
    add('source-field', fields.count, fields.bytes, fields.items);
    add('source-local-ref', local.count, local.bytes, local.items);
    add('source-long-locator', locators.count, locators.bytes, locators.items);
    if (result.sources.document > DOCTOR_SOURCE_VOLUME) add('source-volume', result.sources.document, documentBytes, []);
  }

  const comments = hiddenComments(source, syntax);
  add('hidden-comment', comments.length, comments.reduce((total, item) => total + item.bytes, 0), comments.map(({ line }) => ({ line })));

  // One occurrence per section that carries the alias; a section never repeats
  // one. An alias on several sections of this note counts once per section.
  result.sections = validation.sections.length;
  for (const section of validation.sections) {
    for (const alias of section.aliases) result.aliases.push({ key: normalizedText(alias), alias, heading: section.heading, line: section.line });
  }
  const repeated = [...grouped(result.aliases.map(item => [item.key, item])).values()].filter(items => items.length > 1).flat();
  add('alias-in-note', repeated.length, 0, repeated.map(({ alias, heading, line }) => ({ alias, heading, line })));
  return result;
}

function grouped(pairs) {
  const groups = new Map();
  for (const [key, item] of pairs) {
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  return groups;
}
/** The other notes of a group: at most `related` are named and the rest are
 * counted, so a term or identity that most notes share stays small. */
function others(names, self, related) {
  const notes = names.slice(0, related + 1).filter(name => name !== self).slice(0, related), more = names.length - 1 - notes.length;
  return { notes, ...(more ? { moreNotes: more } : {}) };
}

/** Aliases that sections of more than one note share. Every occurrence of such an
 * alias counts, in every note that has it, including repeats within one note.
 * `notes` yields a note name with its alias occurrences; the result maps each
 * affected name to its occurrences, each with the other notes that share it. */
export function sharedAliases(notes, related = Infinity) {
  const byKey = new Map();
  for (const [name, aliases] of notes) {
    for (const item of aliases) {
      if (!byKey.has(item.key)) byKey.set(item.key, new Map());
      const holders = byKey.get(item.key);
      if (holders.has(name)) holders.get(name).push(item); else holders.set(name, [item]);
    }
  }
  const shared = new Map();
  for (const holders of byKey.values()) {
    if (holders.size < 2) continue;
    const names = [...holders.keys()];
    for (const [name, items] of holders) {
      if (!shared.has(name)) shared.set(name, []);
      const other = others(names, name, related);
      for (const { alias, heading, line } of items) shared.get(name).push({ alias, heading, line, ...other });
    }
  }
  return shared;
}

/** Notes that declare an identity another note declares too. `notes` yields a
 * note name with its identity, or null; the result maps each affected name to
 * the other notes with the same identity. */
export function repeatedIdentities(notes, related = Infinity) {
  const repeated = new Map();
  for (const names of grouped([...notes].filter(([, id]) => id !== null).map(([name, id]) => [id, name])).values()) {
    if (names.length > 1) for (const name of names) repeated.set(name, others(names, name, related));
  }
  return repeated;
}
