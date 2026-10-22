import fs from 'node:fs/promises';
import { fail } from '../core/errors.mjs';

const NUMBER_FIELDS = ['size', 'mode', 'uid', 'gid', 'nlink'];
const EXACT_FIELDS = ['dev', 'ino', 'atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs'];
const PREDICATES = ['isFile', 'isDirectory', 'isSymbolicLink', 'isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket'];

/** Normalize one bigint observation without ever rounding identities or times. */
export function normalizeStat(raw) {
  const value = {};
  for (const field of EXACT_FIELDS) {
    if (typeof raw?.[field] !== 'bigint') fail('STAT_EXACT_REQUIRED', 'Storage observations require bigint identities and nanosecond timestamps.');
    value[field] = raw[field];
  }
  if (value.dev < 0n || value.ino < 0n) fail('STAT_EXACT_REQUIRED', 'Storage observations require nonnegative filesystem identities.');
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
