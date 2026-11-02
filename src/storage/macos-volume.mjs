import { createRequire } from 'node:module';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fail } from '../core/errors.mjs';

// Darwin sys/attr.h: volume UUID, independent of the mount-time st_dev value.
// getattrlist does not open a descriptor, which matters for SQLite POSIX locks.
const ATTRIBUTES = Buffer.alloc(24);
ATTRIBUTES.writeUInt16LE(5, 0); // ATTR_BIT_MAP_COUNT
ATTRIBUTES.writeUInt32LE(0x80040000, 8); // ATTR_VOL_INFO | ATTR_VOL_UUID
const require = createRequire(import.meta.url);
let library;
const unverified = cause => fail('GATE_IDENTITY_UNVERIFIED', 'The filesystem volume identity could not be verified.', cause);
const same = (left, right) => !left.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino;

/** Read the current volume UUID without opening or closing the gate file. */
export function readMacosVolumeUuid(file, stat) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) ||
      typeof file !== 'string' || !isAbsolute(file) || file.includes('\0') || Buffer.byteLength(file) > 32_768 ||
      typeof stat?.dev !== 'bigint' || typeof stat?.ino !== 'bigint') unverified();
  try {
    if (!same(lstatSync(file, { bigint: true }), stat)) unverified();
    library ??= require('node:ffi').dlopen('/usr/lib/libSystem.B.dylib', {
      getattrlist: { arguments: ['string', 'buffer', 'buffer', 'uint64', 'uint32'], return: 'int32' },
    });
    const output = Buffer.alloc(20);
    if (library.functions.getattrlist(file, ATTRIBUTES, output, BigInt(output.length), 1) !== 0 ||
        output.readUInt32LE(0) !== output.length || output.subarray(4).every(byte => byte === 0) ||
        !same(lstatSync(file, { bigint: true }), stat)) unverified();
    return output.subarray(4).toString('hex');
  } catch (cause) { unverified(cause); }
}
