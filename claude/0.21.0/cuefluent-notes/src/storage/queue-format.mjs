import { fail } from '../core/errors.mjs';
import { hashBytes } from './files.mjs';

export const MAX_QUEUE_RECORD_BYTES = 256 * 1024;
export const MAX_QUEUE_SELECTION_RECORDS = 1024;
export const MAX_QUEUE_SELECTION_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function assertId(id) {
  if (typeof id !== 'string' || !ID.test(id)) fail('QUEUE_ID_INVALID', 'Queue record identity is invalid.');
}

export function assertHash(hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) fail('QUEUE_HASH_INVALID', 'An exact queue record SHA-256 is required.');
}

function parseData(bytes) {
  if (bytes.includes(10) || bytes.includes(13)) fail('QUEUE_DATA_INVALID', 'Queue data must be single-line serialized JSON.');
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { fail('QUEUE_DATA_INVALID', 'Queue data must contain valid UTF-8 JSON.'); }
}

/** The adapter supplies exact serialized JSON bytes; their whitespace is hashed. */
export function encodeQueueRecord(id, dataBytes) {
  assertId(id);
  if (!(dataBytes instanceof Uint8Array)) fail('QUEUE_BYTES_REQUIRED', 'Provide exact serialized queue data bytes.');
  if (dataBytes.byteLength > MAX_QUEUE_RECORD_BYTES) fail('QUEUE_RECORD_TOO_LARGE', 'Split source data into bounded queue parts.');
  dataBytes = Buffer.from(dataBytes);
  const data = parseData(dataBytes);
  const hash = hashBytes(dataBytes);
  const prefix = Buffer.from(`{"id":${JSON.stringify(id)},"hash":"${hash}","data":`);
  const bytes = Buffer.concat([prefix, dataBytes, Buffer.from('}\n')]);
  if (bytes.length > MAX_QUEUE_RECORD_BYTES) fail('QUEUE_RECORD_TOO_LARGE', 'Split source data into bounded queue parts.');
  return Object.freeze({ id, hash, data, dataBytes, bytes });
}

export function inputRecord(value) {
  if (!value || typeof value !== 'object') fail('QUEUE_RECORD_INVALID', 'An encoded queue record is required.');
  const encoded = encodeQueueRecord(value.id, value.dataBytes);
  if (value.hash !== undefined && value.hash !== encoded.hash) fail('QUEUE_HASH_MISMATCH', 'Queue data does not match its supplied hash.');
  return encoded;
}

export function decodeRecord(bytes, offset) {
  if (bytes.length > MAX_QUEUE_RECORD_BYTES) fail('QUEUE_RECORD_TOO_LARGE', 'A record segment exceeds its bounded size.');
  if (bytes[bytes.length - 1] !== 10 || bytes.indexOf(10) !== bytes.length - 1) {
    fail('QUEUE_RECORD_INVALID', 'A record segment must contain exactly one complete JSONL line.');
  }
  let value;
  try { value = JSON.parse(decoder.decode(bytes.subarray(0, -1))); }
  catch { fail('QUEUE_RECORD_INVALID', 'A complete queue line is malformed and has been preserved.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('QUEUE_RECORD_INVALID', 'A complete queue line has an invalid envelope.');
  assertId(value.id);
  assertHash(value.hash);
  const prefix = Buffer.from(`{"id":${JSON.stringify(value.id)},"hash":"${value.hash}","data":`);
  if (!bytes.subarray(0, prefix.length).equals(prefix) || bytes[bytes.length - 2] !== 125) {
    fail('QUEUE_RECORD_INVALID', 'A complete queue line has a noncanonical envelope.');
  }
  const dataBytes = Buffer.from(bytes.subarray(prefix.length, -2));
  const data = parseData(dataBytes);
  if (hashBytes(dataBytes) !== value.hash) fail('QUEUE_HASH_MISMATCH', 'A queue record hash does not match its exact serialized data.');
  return Object.freeze({ id: value.id, hash: value.hash, data, dataBytes, bytes, offset, endOffset: offset + bytes.length });
}
