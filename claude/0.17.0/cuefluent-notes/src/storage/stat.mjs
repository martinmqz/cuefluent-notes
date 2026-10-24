import fs from 'node:fs/promises';
import { fail } from '../core/errors.mjs';

const NUMBER_FIELDS = ['size', 'mode', 'uid', 'gid', 'nlink'];
const EXACT_FIELDS = ['dev', 'ino', 'atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs'];
const MIN_SIGNED_ID = -(1n << 63n);
const MAX_UNSIGNED_ID = (1n << 64n) - 1n;
const PREDICATES = ['isFile', 'isDirectory', 'isSymbolicLink', 'isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket'];

export function normalizeFilesystemId(value) {
  // Node's signed BigInt64Array can expose high-bit uint64 IDs as negative.
  // Check the range before converting so malformed IDs cannot wrap and alias.
  if (typeof value !== 'bigint' || value < MIN_SIGNED_ID || value > MAX_UNSIGNED_ID) {
    fail('STAT_EXACT_REQUIRED', 'Storage observations require exact 64-bit filesystem identities.');
  }
  return BigInt.asUintN(64, value);
}

/** Normalize one bigint observation without ever rounding identities or times. */
export function normalizeStat(raw) {
  const value = {};
  for (const field of EXACT_FIELDS) {
    if (typeof raw?.[field] !== 'bigint') fail('STAT_EXACT_REQUIRED', 'Storage observations require bigint identities and nanosecond timestamps.');
    value[field] = raw[field];
  }
  for (const field of ['dev', 'ino']) {
    value[field] = normalizeFilesystemId(value[field]);
  }
  for (const field of NUMBER_FIELDS) {
    const integer = raw[field];
    if (typeof integer !== 'bigint' || integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail('STAT_FIELD_UNSUPPORTED', 'A filesystem metadata field exceeds its exact numeric interface.');
    }
    value[field] = Number(integer);
  }
  // Bind once to the same frozen observation. Node's BigIntStats predicates
  // expect its bigint mode; invoking them against the numeric view is unsafe.
  Object.freeze(raw);
  for (const method of PREDICATES) {
    if (typeof raw[method] !== 'function') fail('STAT_EXACT_REQUIRED', 'Storage observations require filesystem type predicates.');
    value[method] = raw[method].bind(raw);
  }
  return Object.freeze(value);
}

export async function readPathStat(file) {
  return normalizeStat(await fs.lstat(file, { bigint: true }));
}

export async function readHandleStat(handle) {
  return normalizeStat(await handle.stat({ bigint: true }));
}
