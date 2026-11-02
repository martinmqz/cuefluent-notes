import { fstatSync, lstatSync } from 'node:fs';
import { fail } from '../core/errors.mjs';
import { readMacosAttributes } from './macos-native.mjs';

// Darwin sys/attr.h: observe the volume UUID and its current device together.
// FILEID cannot be requested with volume attributes, so check the inode after
// the lookup without opening or closing any additional descriptor.
const ATTRIBUTES = Buffer.alloc(24);
ATTRIBUTES.writeUInt16LE(5, 0); // ATTR_BIT_MAP_COUNT
ATTRIBUTES.writeUInt32LE(0x00000002, 4); // ATTR_CMN_DEVID
ATTRIBUTES.writeUInt32LE(0x80040000, 8); // ATTR_VOL_INFO | ATTR_VOL_UUID
// APFS volume groups can project a shared st_dev for separate physical volumes.
const FILE_ATTRIBUTES = Buffer.alloc(24);
FILE_ATTRIBUTES.writeUInt16LE(5, 0);
FILE_ATTRIBUTES.writeUInt32LE(0x02000002, 4); // ATTR_CMN_DEVID | ATTR_CMN_FILEID
FILE_ATTRIBUTES.writeUInt32LE(0x00000040, 20); // ATTR_CMNEXT_REALDEVID
const unverified = cause => fail('FILESYSTEM_IDENTITY_UNVERIFIED', 'The filesystem volume identity could not be verified.', cause);
const changed = () => fail('PATH_CHANGED', 'The filesystem object changed during volume identity verification.');

function attributes(target, request, size, options = 0) {
  const output = Buffer.alloc(size);
  try { readMacosAttributes(target, request, output, options); }
  catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR' || cause.code === 'EBADF') throw cause;
    unverified(cause);
  }
  if (output.readUInt32LE(0) !== output.length) unverified();
  return output;
}

function read(target, stat, inspect) {
  const output = attributes(target, ATTRIBUTES, 24), device = output.readUInt32LE(4);
  if (BigInt(device) !== stat.dev) {
    // Tie the physical volume back to this exact projected device/inode; do not
    // treat any mismatch as a volume-group exception without this observation.
    const file = attributes(target, FILE_ATTRIBUTES, 20, 0x20); // FSOPT_ATTR_CMN_EXTENDED
    if (BigInt(file.readUInt32LE(4)) !== stat.dev || file.readBigUInt64LE(8) !== BigInt.asUintN(64, stat.ino) ||
        file.readUInt32LE(16) !== device) changed();
  }
  const current = inspect();
  if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) changed();
  const uuid = output.subarray(8);
  if (uuid.every(byte => byte === 0)) unverified();
  return uuid.toString('hex');
}

/** Fresh lookup for an already inspected path; never opens a file descriptor. */
export function readMacosVolumeUuid(file, stat) {
  return read(file, stat, () => lstatSync(file, { bigint: true }));
}

/** Use the caller's open descriptor, including after a rename or unlink. */
export function readMacosVolumeUuidFromFd(fd, stat) {
  return read(fd, stat, () => fstatSync(fd, { bigint: true }));
}
