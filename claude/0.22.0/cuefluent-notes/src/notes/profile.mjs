import { fail } from '../core/errors.mjs';

/** Portable output contract audited against Cuefluent 6dbde00ad7c9. These are
 * consumer safety limits, not a queue quota or a guarantee of corpus admission. */
export const NOTE_PROFILE = Object.freeze({
  id: 'cuefluent-schema1-2026-10-21', schemaVersion: 1,
  fileBytes: 10 * 1024 * 1024, lineBytes: 64 * 1024,
  sectionNodes: 20_000, documentNodes: 100_000, corpusNodes: 250_000,
  depth: 32, bodyBytes: 32 * 1024 * 1024, sections: 10_000, documents: 256,
  metadataBytes: 64 * 1024, metadataSourceBytes: 2 * 1024 * 1024,
  metadataNodes: 4096, metadataDepth: 8, metadataItems: 128, metadataString: 2048,
});

export function decodeNote(input) {
  if (typeof input === 'string') {
    if (!input.isWellFormed()) fail('NOTE_UTF8_INVALID', 'Note text contains an unpaired surrogate.');
    if (Buffer.byteLength(input) > NOTE_PROFILE.fileBytes) fail('NOTE_FILE_LIMIT', 'Note exceeds the supported file-byte limit.');
    return input;
  }
  if (!(input instanceof Uint8Array)) fail('NOTE_BYTES_REQUIRED', 'Provide exact UTF-8 note bytes or text.');
  if (input.byteLength > NOTE_PROFILE.fileBytes) fail('NOTE_FILE_LIMIT', 'Note exceeds the supported file-byte limit.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
  catch (cause) { fail('NOTE_UTF8_INVALID', 'Note bytes are not valid UTF-8.', cause); }
}

/** Use the note's existing line-ending convention for inserted text. */
export function noteNewline(source) {
  return source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';
}
