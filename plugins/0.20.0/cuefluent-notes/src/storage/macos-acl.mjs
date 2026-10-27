import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fail } from '../core/errors.mjs';

// Public Darwin ABI: sys/attr.h (getattrlist) and sys/kauth.h (kauth_filesec).
// Both supported macOS Node architectures use little-endian fields and 4-byte
// attribute packing. One native observation includes identity, mode, owner and
// ACL, and never opens/closes a gate descriptor or resolves a symlink leaf.
const ATTRIBUTES = Buffer.alloc(24);
ATTRIBUTES.writeUInt16LE(5, 0); // ATTR_BIT_MAP_COUNT
ATTRIBUTES.writeUInt32LE(0x0242800a, 4); // DEVID, OBJTYPE, OWNERID, ACCESSMASK, EXTENDED_SECURITY, FILEID
const FIXED_BYTES = 36, ACL_HEADER_BYTES = 44, ACE_BYTES = 24, MAX_ENTRIES = 128;
const MAX_BYTES = FIXED_BYTES + ACL_HEADER_BYTES + ACE_BYTES * MAX_ENTRIES;
const require = createRequire(import.meta.url);
let library;

function unverified(cause) {
  fail('PRIVATE_ACCESS_UNVERIFIED', 'macOS private storage permissions could not be verified.', cause);
}

function native() {
  // Cache bindings only. Every permission decision reads current filesystem
  // metadata; disabled/unavailable FFI is a refusal, not a mode-only fallback.
  if (!library) library = require('node:ffi').dlopen('/usr/lib/libSystem.B.dylib', {
    getattrlist: { arguments: ['string', 'buffer', 'buffer', 'uint64', 'uint32'], return: 'int32' },
    mbr_uid_to_uuid: { arguments: ['uint32', 'buffer'], return: 'int32' },
  });
  return library.functions;
}

/** Fresh read-only ACL admission for an already inspected private path. */
export function assertMacosPrivateAccess(file, stat) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) ||
      typeof file !== 'string' || !isAbsolute(file) || file.includes('\0') || Buffer.byteLength(file) > 32_768 ||
      !stat || !['bigint', 'number'].includes(typeof stat.dev) || !['bigint', 'number'].includes(typeof stat.ino)) unverified();
  let api, output;
  try {
    api = native(); output = Buffer.alloc(MAX_BYTES);
    // FSOPT_NOFOLLOW. A failed lookup is distinct from a successful empty ACL.
    if (api.getattrlist(file, ATTRIBUTES, output, BigInt(output.length), 1) !== 0) unverified();
  } catch (cause) { unverified(cause); }
  const size = output.readUInt32LE(0);
  if (size < FIXED_BYTES || size > output.length) unverified();
  const kind = output.readUInt32LE(8), owner = output.readUInt32LE(12), mode = output.readUInt32LE(16);
  if (BigInt(output.readUInt32LE(4)) !== BigInt(stat.dev) || output.readBigUInt64LE(28) !== BigInt(stat.ino)) unverified();
  if (![1, 2].includes(kind) || owner !== process.getuid() || (mode & 0o077) !== 0) {
    fail('PRIVATE_ACCESS_UNSAFE', 'Private storage must be owned by and restricted to the current user.');
  }
  const start = 20 + output.readInt32LE(20), length = output.readUInt32LE(24);
  if (start !== FIXED_BYTES || start + length !== size) unverified();
  if (length === 0) return;
  if (length < ACL_HEADER_BYTES || output.readUInt32LE(start) !== 0x012cc16d) unverified();
  const count = output.readUInt32LE(start + 36), flags = output.readUInt32LE(start + 40);
  // Only NO_INHERIT is understood here. Deferred or unknown ACL semantics must
  // not establish privacy, even when the current list contains no grants.
  if ((flags & ~0x20000) !== 0 || count > MAX_ENTRIES || length !== ACL_HEADER_BYTES + count * ACE_BYTES) unverified();
  let user;
  for (let index = 0; index < count; index++) {
    const offset = start + ACL_HEADER_BYTES + index * ACE_BYTES;
    const entryFlags = output.readUInt32LE(offset + 16), tag = entryFlags & 0xf;
    if (![1, 2].includes(tag) || (entryFlags & ~0x1ff) !== 0) unverified();
    if (tag === 2 || output.readUInt32LE(offset + 20) === 0) continue;
    if (!user) {
      user = Buffer.alloc(16);
      try { if (api.mbr_uid_to_uuid(process.getuid(), user) !== 0 || user.every(byte => byte === 0)) unverified(); }
      catch (cause) { unverified(cause); }
    }
    // Include inheritance-only grants: they can expose newly created children.
    // Do not try to cancel grants against ordered deny entries or group members.
    if (!output.subarray(offset, offset + 16).equals(user)) {
      fail('PRIVATE_ACCESS_UNSAFE', 'Private storage ACLs must not grant access to other users or groups.');
    }
  }
}
