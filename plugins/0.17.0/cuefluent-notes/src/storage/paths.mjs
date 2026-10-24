import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../core/errors.mjs';
import { readPathStat } from './stat.mjs';
import { assertLocalFilesystem, assertPrivateAccess, establishWindowsPrivacy } from './platform.mjs';

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONTROLS = /[\u0000-\u001f\u007f]/;

export function fileIdentity(stat) {
  if (typeof stat?.dev !== 'bigint' || typeof stat?.ino !== 'bigint') {
    fail('STAT_EXACT_REQUIRED', 'Filesystem identity comparisons require exact bigint observations.');
  }
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
}

export function sameIdentity(stat, expected) {
  const actual = fileIdentity(stat);
  return actual.device === expected.device && actual.inode === expected.inode;
}

export function assertAbsolute(file) {
  if (typeof file !== 'string' || CONTROLS.test(file) || !path.isAbsolute(file) || path.normalize(file) !== file) {
    fail('PATH_INVALID', 'Use a normalized absolute filesystem path.');
  }
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:\\/.test(file) || file.slice(3).split('\\').some(part =>
      /[:*?"<>|]|[. ]$/.test(part) || RESERVED.test(part))) {
      fail('PATH_INVALID', 'Use a local Windows drive path without aliases or alternate streams.');
    }
  }
  return file;
}

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export async function lstatOrNull(file) {
  try { return await readPathStat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function directory(stat) {
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('PATH_UNSAFE', 'A required path component is not a regular directory.');
}

/** Inspect every existing ancestor; no implicit realpath traversal of links. */
export async function inspectAncestors(file, { allowMissing = false } = {}) {
  assertAbsolute(file);
  const names = [];
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    names.unshift(cursor);
    if (path.dirname(cursor) === cursor) break;
  }
  const chain = [];
  let missing = false;
  for (const name of names) {
    const stat = missing ? null : await lstatOrNull(name);
    if (!stat) {
      if (!allowMissing) fail('PATH_MISSING', 'A required directory does not exist.');
      missing = true;
      continue;
    }
    directory(stat);
    chain.push(Object.freeze({ path: name, ...fileIdentity(stat) }));
  }
  return Object.freeze(chain);
}

export async function assertChain(chain) {
  for (const entry of chain) {
    const stat = await lstatOrNull(entry.path);
    directory(stat);
    if (!sameIdentity(stat, entry)) fail('PATH_CHANGED', 'A verified directory was replaced.');
  }
}

export async function pinDirectory(root, { private: privateDirectory = false } = {}) {
  const chain = await inspectAncestors(root);
  if (privateDirectory) assertPrivateAccess(root, await readPathStat(root));
  return Object.freeze({ root, private: privateDirectory, chain });
}

export async function assertDirectory(pin) {
  await assertChain(pin.chain);
  if (pin.private) assertPrivateAccess(pin.root, await readPathStat(pin.root));
}

export function relativePath(pin, relative) {
  if (typeof relative !== 'string' || !relative || CONTROLS.test(relative) || relative.includes('\\') ||
      relative.split('/').some(part => !part || part === '.' || part === '..' || /[:*?"<>|]|[. ]$/.test(part) || RESERVED.test(part))) {
    fail('PATH_INVALID', 'Use a portable relative path with ordinary file names.');
  }
  const file = path.join(pin.root, ...relative.split('/'));
  if (!isWithin(pin.root, file) || file === pin.root) fail('PATH_OUTSIDE_ROOT', 'The file is outside its verified root.');
  return file;
}

export async function inspectParent(pin, relative) {
  await assertDirectory(pin);
  const file = relativePath(pin, relative);
  const chain = await inspectAncestors(path.dirname(file));
  if (pin.private) {
    for (const entry of chain) {
      if (isWithin(pin.root, entry.path)) assertPrivateAccess(entry.path, await readPathStat(entry.path));
    }
  }
  await assertDirectory(pin);
  return Object.freeze({ file, chain });
}

export function assertRegularFile(file, stat, { private: privateFile = false } = {}) {
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail('PATH_UNSAFE', 'A stored file must be regular, unlinked, and have exactly one hard link.');
  }
  if (privateFile) assertPrivateAccess(file, stat);
}

/** Setup is the only creator; existing directories are inspected, never chmodded. */
export async function createPrivateDirectory(root) {
  const chain = [...await inspectAncestors(root, { allowMissing: true })];
  await assertChain(chain);
  const ancestor = chain.at(-1).path;
  const components = path.relative(ancestor, root).split(path.sep).filter(Boolean);
  let current = ancestor;
  for (const component of components) {
    await assertChain(chain);
    current = path.join(current, component);
    let created = false;
    try { await fs.mkdir(current, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (created) establishWindowsPrivacy(current);
    const stat = await readPathStat(current);
    directory(stat);
    assertPrivateAccess(current, stat);
    await assertChain(chain);
    chain.push(Object.freeze({ path: current, ...fileIdentity(stat) }));
  }
  const pin = await pinDirectory(root, { private: true });
  assertLocalFilesystem(await fs.statfs(root), root);
  return pin;
}

/** Resolve the existing selection once, then pin all future operations. */
export async function canonicalSelection(requested) {
  assertAbsolute(requested);
  const missing = [];
  let cursor = requested;
  for (;;) {
    const stat = await lstatOrNull(cursor);
    if (stat) {
      if (stat.isSymbolicLink()) fail('PATH_UNSAFE', 'The selected path must not be a symbolic link.');
      break;
    }
    missing.unshift(path.basename(cursor));
    if (path.dirname(cursor) === cursor) fail('PATH_MISSING', 'No existing filesystem ancestor was found.');
    cursor = path.dirname(cursor);
  }
  // System aliases such as macOS /tmp are canonicalized at selection. Subsequent
  // operations receive the canonical path and refuse any new linked components.
  const result = path.join(await fs.realpath(cursor), ...missing);
  await inspectAncestors(path.dirname(result), { allowMissing: true });
  return result;
}

export function assertPrivatePlacement(root, { projectRoots = [], noteDestinations = [] } = {}) {
  assertAbsolute(root);
  for (const other of [...projectRoots, ...noteDestinations.map(value => typeof value === 'string' ? value : value.path)]) {
    assertAbsolute(other);
    if (isWithin(root, other) || isWithin(other, root)) {
      fail('PRIVATE_LOCATION_OVERLAP', 'Private storage must be separate from projects and notes destinations.');
    }
  }
}
