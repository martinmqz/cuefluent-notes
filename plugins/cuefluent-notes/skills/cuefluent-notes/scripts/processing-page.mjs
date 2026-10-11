import fs from 'node:fs/promises';
import { intakePath } from './intake-io.mjs';
import { captureRelativePath, MAX_CAPTURE_BYTES } from './capture-contract.mjs';
import { packetSegments, validatePageIndex, renderEvidencePage } from './processing-packet.mjs';
import { openGuarded, sameFileIdentity } from './file-io.mjs';
import { fail } from './workflow-values.mjs';

export function processingPageLayout(claim, page) {
  validatePageIndex(page, claim.packet.pages);
  const start = page === 0 ? 0 : claim.packet.pageEnds[page - 1], end = claim.packet.pageEnds[page];
  const segments = packetSegments(claim.inputs, claim.packet.captureBytes).filter(segment => segment.start < end && segment.end > start);
  return { start, end, segments };
}
export async function processingPagePaths(store, claim, layout) {
  const paths = [];
  for (const segment of layout.segments) if (segment.inputIndex !== undefined) {
    const input = claim.inputs[segment.inputIndex];
    paths.push(await intakePath(store, 'raw', captureRelativePath(input.identity, input.evidenceHash)));
  }
  return paths;
}

/** Caller checks current policy and all touched private paths first. Read only
 * intersecting ranges; the prepared page hash authenticates their exact bytes.
 * Full capture/lineage validation still precedes proposal and save.
 */
export async function readProcessingExtent(store, claim, page, layout) {
  const chunks = [];
  for (const segment of layout.segments) {
    const start = Math.max(segment.start, layout.start) - segment.start;
    const end = Math.min(segment.end, layout.end) - segment.start;
    if (segment.bytes) { chunks.push(segment.bytes.subarray(start, end)); continue; }
    const input = claim.inputs[segment.inputIndex], name = captureRelativePath(input.identity, input.evidenceHash);
    const file = await intakePath(store, 'raw', name), { handle, stat } = await openGuarded(file, { singleLink: true, maxBytes: MAX_CAPTURE_BYTES });
    try {
      if (stat.size !== BigInt(claim.packet.captureBytes[segment.inputIndex] + 1)) fail('PROCESSING_PACKET_CHANGED');
      const bytes = Buffer.alloc(end - start); let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, start + offset);
        if (!read.bytesRead) fail('PROCESSING_PACKET_CHANGED'); offset += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), current = await fs.lstat(await intakePath(store, 'raw', name), { bigint: true });
      for (const value of [after, current]) if (!sameFileIdentity(stat, value) || value.size !== stat.size || value.mtimeNs !== stat.mtimeNs ||
          value.ctimeNs !== stat.ctimeNs || value.nlink !== 1n) fail('PROCESSING_PACKET_CHANGED');
      chunks.push(bytes);
    } finally { await handle.close(); }
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== layout.end - layout.start) fail('PROCESSING_PACKET_CHANGED');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const result = renderEvidencePage({ packetHash: claim.packet.hash, page, totalPages: claim.packet.pages.length, totalBytes: claim.packet.bytes,
    startByte: layout.start, endByte: layout.end, text });
  if (result.hash !== claim.packet.pages[page]) fail('PROCESSING_PACKET_CHANGED');
  return result;
}
