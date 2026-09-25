import { canonicalJSON, digest, fail, integer, keys, hash, list } from './workflow-values.mjs';
import { serializeCapture, MAX_CAPTURE_BYTES } from './capture-contract.mjs';

export const PROCESSING_PAGE_BYTES = 64 * 1024;
export const PROCESSING_PACKET_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 30 * 1024;

export function renderEvidencePage(value) {
  const text = canonicalJSON({ format: 'cuefluent-evidence-page', version: 1, untrusted: true, ...value }) + '\n';
  const size = Buffer.byteLength(text);
  if (size > PROCESSING_PAGE_BYTES) fail('PROCESSING_PAGE_CAPACITY');
  return { text, hash: digest(text), bytes: size, estimatedTokens: Math.ceil(size / 4), estimator: 'UTF-8 bytes divided by four; not measured model tokens' };
}

/** JSON encodes source delimiters and instructions as untrusted evidence data.
 * Pages must be reassembled/acknowledged in full; none is a completion receipt.
 */
export function renderProcessingPacket(sources) {
  const bytes = Buffer.from(canonicalJSON({ format: 'cuefluent-evidence-packet', version: 1, untrusted: true, sources }));
  if (bytes.length > PROCESSING_PACKET_BYTES) fail('PROCESSING_PACKET_CAPACITY');
  const packetHash = digest(bytes), chunks = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(bytes.length, offset + CHUNK_BYTES);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push({ startByte: offset, endByte: end, text: bytes.subarray(offset, end).toString('utf8') }); offset = end;
  }
  const pages = chunks.map((chunk, page) => renderEvidencePage({ packetHash, page, totalPages: chunks.length, totalBytes: bytes.length, ...chunk }));
  return { hash: packetHash, bytes: bytes.length, pages, pageEnds: chunks.map(chunk => chunk.endByte) };
}
export function validatePageIndex(page, pages) {
  integer(page); if (page >= pages.length) fail('INVALID_PROCESSING_PAGE'); return page;
}

/** Metadata-only layout: canonical framing plus extents in immutable captures.
 * No caller-provided path or copied source body is persisted in this manifest.
 */
export function packetSegments(inputs, captureBytes) {
  const segments = []; let offset = 0;
  const literal = text => { const bytes = Buffer.from(text); segments.push({ start: offset, end: offset + bytes.length, bytes }); offset += bytes.length; };
  literal('{"format":"cuefluent-evidence-packet","sources":[');
  inputs.forEach((input, index) => {
    literal((index ? ',' : '') + '{"capture":');
    segments.push({ start: offset, end: offset + captureBytes[index], inputIndex: index }); offset += captureBytes[index];
    literal(',"input":' + canonicalJSON(input) + '}');
  });
  literal('],"untrusted":true,"version":1}');
  return segments;
}
export function validatePacketManifest(packet, inputs) {
  keys(packet, ['hash', 'bytes', 'pages', 'captureBytes', 'pageEnds']); hash(packet.hash); integer(packet.bytes);
  if (packet.bytes < 1 || packet.bytes > PROCESSING_PACKET_BYTES) fail('PROCESSING_PACKET_CAPACITY');
  list(packet.pages, 160, { empty: false }).forEach(hash);
  list(packet.captureBytes, inputs.length, { empty: false }).forEach(size => {
    integer(size); if (size < 1 || size >= MAX_CAPTURE_BYTES) fail('INVALID_PROCESSING_EXTENTS');
  });
  list(packet.pageEnds, packet.pages.length, { empty: false });
  if (packet.captureBytes.length !== inputs.length || packet.pageEnds.length !== packet.pages.length) fail('INVALID_PROCESSING_EXTENTS');
  let offset = 0;
  packet.pageEnds.forEach((end, index) => {
    integer(end); const span = end - offset;
    if (span < 1 || span > CHUNK_BYTES || (index < packet.pageEnds.length - 1 && span < CHUNK_BYTES - 3)) fail('INVALID_PROCESSING_EXTENTS');
    offset = end;
  });
  if (offset !== packet.bytes || packetSegments(inputs, packet.captureBytes).at(-1).end !== packet.bytes) fail('INVALID_PROCESSING_EXTENTS');
  return packet;
}
export function packetManifest(sources, packet) {
  const captureBytes = sources.map(({ input, capture }) => {
    const bytes = serializeCapture(capture);
    if (digest(bytes) !== input.fileHash) fail('NONCANONICAL_PROCESSING_CAPTURE');
    return bytes.length - 1;
  });
  return validatePacketManifest({ hash: packet.hash, bytes: packet.bytes, pages: packet.pages.map(page => page.hash), captureBytes, pageEnds: packet.pageEnds }, sources.map(source => source.input));
}
