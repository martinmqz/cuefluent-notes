import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectNativeRow } from '../../src/transcript/index.mjs';

// A virtual source avoids constructing the very value whose bounded parsing is
// being tested. Its decoded text is larger than this child process's heap cap.
const text = 'abcdefghλ🧠'.repeat(4096), chunk = Buffer.from(JSON.stringify(text).slice(1, -1)), repeats = 1024;
const prefix = Buffer.from('{"type":"user","sessionId":"synthetic","promptId":"prompt","turnOrigin":"sdk","message":{"role":"user","content":"');
const suffix = Buffer.from('"},"uuid":"identity-after-huge-content"}\n');
const size = prefix.length + repeats * chunk.length + suffix.length;
let maxRead = 0;
const source = { size, async read(offset, length) {
  maxRead = Math.max(maxRead, length);
  const output = Buffer.alloc(length); let copied = 0;
  while (copied < length) {
    const at = offset + copied;
    const part = at < prefix.length ? prefix.subarray(at) : at < prefix.length + repeats * chunk.length ?
      chunk.subarray((at - prefix.length) % chunk.length) : suffix.subarray(at - prefix.length - repeats * chunk.length);
    const count = Math.min(part.length, length - copied); output.set(part.subarray(0, count), copied); copied += count;
  }
  return output;
} };
const expected = createHash('sha256'); for (let i = 0; i < repeats; i++) expected.update(text);
const row = await inspectNativeRow(source, 0, { limits: { readBytes: 4096 } });
assert.equal(row.values['["uuid"]'], 'identity-after-huge-content');
assert.equal(row.strings['["message","content"]'].hash, expected.digest('hex'));
assert.equal(row.strings['["message","content"]'].units, text.length * repeats);
assert(maxRead <= 4096); assert(size > 48 * 1024 * 1024);
console.log(JSON.stringify({ bytes: size, decodedUnits: text.length * repeats, maxRead, metadataBytes: Buffer.byteLength(JSON.stringify(row)) }));
