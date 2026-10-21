import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compare, isMain, readBoundedBytes, sameFileIdentity, windowsComponent } from './file-io.mjs';
import { validatePluginManifest } from './plugin-manifest.mjs';

export const INVENTORY_FILE = 'package-inventory.json';
const MAX_FILES = 4096, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = message => { throw new Error(message); };
const housekeeping = name => ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(path.posix.basename(name));

export function packagePath(name) {
  if (typeof name !== 'string' || name.length > 1024 || name.split('/').length > 20 ||
      name.split('/').some(part => !windowsComponent(part))) fail('Invalid portable package path.');
  return name;
}

function inventoryValue(files, { client, version, variant }) {
  return { format: 'cuefluent-package', schemaVersion: 1, name: 'cuefluent-notes', version, client, variant,
    files: files.map(({ name, bytes }) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) })).sort((a, b) => compare(a.path, b.path)) };
}

function validateInventory(value) {
  if (!keys(value, ['format', 'schemaVersion', 'name', 'version', 'client', 'variant', 'files']) ||
      value.format !== 'cuefluent-package' || value.schemaVersion !== 1 || value.name !== 'cuefluent-notes' ||
      typeof value.version !== 'string' || !['codex', 'claude'].includes(value.client) || !['hooks', 'manual'].includes(value.variant) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length >= MAX_FILES) fail('Unsupported package inventory.');
  let total = 0, previous = '';
  const names = new Set();
  for (const entry of value.files) {
    if (!keys(entry, ['path', 'bytes', 'sha256']) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || !digest(entry.sha256)) fail('Invalid package inventory entry.');
    packagePath(entry.path);
    const folded = entry.path.normalize('NFC').toLowerCase();
    if (entry.path === INVENTORY_FILE || entry.path.split('/')[0] === '.in_use' || housekeeping(entry.path) ||
        compare(previous, entry.path) >= 0 || names.has(folded)) fail('Duplicate, reserved or unordered inventory path.');
    names.add(folded); previous = entry.path; total += entry.bytes;
  }
  if (total > MAX_TOTAL_BYTES) fail('Package exceeds the verification size limit.');
  const paths = new Set(value.files.map(entry => entry.path));
  for (const name of paths) {
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (names.has(parent.normalize('NFC').toLowerCase())) fail('Conflicting inventory paths.');
    }
  }
  for (const required of ['README.md', `.${value.client}-plugin/plugin.json`, 'skills/cuefluent-notes/SKILL.md', 'skills/cuefluent-notes/package.json']) {
    if (!paths.has(required)) fail('Package inventory is missing a required entry.');
  }
  if (paths.has('hooks/hooks.json') !== (value.variant === 'hooks') ||
      (value.variant === 'manual' && [...paths].some(name => name.startsWith('hooks/')))) fail('Package variant differs from inventory.');
  return value;
}

function parseInventory(bytes) {
  if (bytes.length > MAX_INVENTORY_BYTES) fail('Package inventory exceeds the size limit.');
  const value = validateInventory(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  // Inventories are generated records; canonical encoding also rejects duplicate JSON keys.
  if (!json(value).equals(bytes)) fail('Package inventory is not canonically encoded.');
  return value;
}

function packageIdentityMatches(byName, inventory) {
  try {
    const manifest = JSON.parse(byName.get(`.${inventory.client}-plugin/plugin.json`));
    validatePluginManifest(manifest, inventory.client);
    const runtime = JSON.parse(byName.get('skills/cuefluent-notes/package.json'));
    return manifest.version === inventory.version && runtime.name === inventory.name && runtime.version === inventory.version;
  } catch { return false; }
}

/** Add a fresh inventory to exact package bytes, including manual-variant conversions. */
export function withPackageInventory(files, { client, version, withHooks }) {
  const payload = files.filter(file => file.name !== INVENTORY_FILE);
  const value = validateInventory(inventoryValue(payload, { client, version, variant: withHooks ? 'hooks' : 'manual' }));
  const inventory = { name: INVENTORY_FILE, bytes: json(value) };
  if (payload.reduce((total, file) => total + file.bytes.length, inventory.bytes.length) > MAX_TOTAL_BYTES) fail('Package exceeds the verification size limit.');
  if (inventory.bytes.length > MAX_INVENTORY_BYTES) fail('Package inventory exceeds the size limit.');
  if (!packageIdentityMatches(new Map(payload.map(file => [file.name, file.bytes])), value)) fail('Generated package identity differs from inventory.');
  return [...payload, inventory].sort((a, b) => compare(a.name, b.name));
}

/** Verify an inventory against already captured bytes; does not fetch trust material. */
export function verifyPackageFiles(files, { expectedInventorySha256 } = {}) {
  if (expectedInventorySha256 !== undefined && !digest(expectedInventorySha256)) fail('Expected inventory SHA-256 must be 64 lowercase hexadecimal characters.');
  const byName = new Map();
  for (const file of files) {
    packagePath(file.name);
    if (byName.has(file.name)) fail('Duplicate package file.');
    byName.set(file.name, file.bytes);
  }
  if (!byName.has(INVENTORY_FILE)) fail('Package inventory is missing.');
  const bytes = byName.get(INVENTORY_FILE), inventory = parseInventory(bytes), inventorySha256 = sha(bytes);
  const missing = [], changed = [], unexpected = [];
  const expected = new Set(inventory.files.map(entry => entry.path));
  for (const entry of inventory.files) {
    const actual = byName.get(entry.path);
    if (!actual) missing.push(entry.path);
    else if (actual.length !== entry.bytes || sha(actual) !== entry.sha256) changed.push(entry.path);
  }
  for (const name of byName.keys()) if (name !== INVENTORY_FILE && !expected.has(name)) unexpected.push(name);
  const identityMatches = packageIdentityMatches(byName, inventory);
  const integrityVerified = identityMatches && !missing.length && !changed.length && !unexpected.length;
  const trustedInventoryMatches = expectedInventorySha256 === undefined ? null : inventorySha256 === expectedInventorySha256;
  return { client: inventory.client, version: inventory.version, variant: inventory.variant, inventorySha256,
    integrityVerified, trustedReleaseVerified: integrityVerified && trustedInventoryMatches === true, trustedInventoryMatches, identityMatches,
    counts: { missing: missing.length, changed: changed.length, unexpected: unexpected.length },
    missing: missing.slice(0, 100), changed: changed.slice(0, 100), unexpected: unexpected.sort(compare).slice(0, 100) };
}

/** Read a selected package only. Links and special files are rejected before exclusions. */
export async function readPackageFiles(root, { ignoreHostFiles = false } = {}) {
  const absolute = path.resolve(root), files = [], ignored = [], inspected = [];
  let entries = 0, total = 0;
  const stable = (a, b) => sameFileIdentity(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  async function visit(relative = '') {
    const directory = path.join(absolute, relative), before = await fs.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) fail('Nonportable package directory or root.');
    inspected.push([directory, before]);
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (++entries > MAX_FILES * 2) fail('Package exceeds the entry limit.');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      packagePath(name);
      const file = path.join(absolute, name), stat = await fs.lstat(file, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('Nonportable package entry.');
      if (stat.isDirectory()) {
        await visit(name);
      } else if (ignoreHostFiles && (housekeeping(name) || /^\.in_use\/[1-9][0-9]*$/.test(name))) {
        if (stat.size > BigInt(housekeeping(name) ? MAX_FILE_BYTES : 4096)) fail('Host marker exceeds the size limit.');
        ignored.push(name);
      } else {
        const bytes = await readBoundedBytes(file, { maxBytes: MAX_FILE_BYTES, noFollow: true, utf8: false });
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES || files.length >= MAX_FILES) fail('Package exceeds the verification size limit.');
        if (!stable(stat, await fs.lstat(file, { bigint: true }))) fail('Package file changed during verification.');
        inspected.push([file, stat]);
        files.push({ name, bytes });
      }
    }
    if (!stable(before, await fs.lstat(directory, { bigint: true }))) fail('Package directory changed during verification.');
  }
  await visit();
  for (const [file, before] of inspected) if (!stable(before, await fs.lstat(file, { bigint: true }))) fail('Package changed during verification.');
  return { files: files.sort((a, b) => compare(a.name, b.name)), ignored: ignored.sort(compare) };
}

export async function verifyPackage(root, options = {}) {
  root = path.resolve(root);
  if (options.expectedInventorySha256 !== undefined && !digest(options.expectedInventorySha256)) fail('Expected inventory SHA-256 must be 64 lowercase hexadecimal characters.');
  const before = await fs.lstat(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) fail('Nonportable package directory or root.');
  // Validate the bounded record before enumerating a mistakenly selected notes,
  // settings or other non-package directory. No inventory means no payload reads.
  const inventory = await readBoundedBytes(path.join(root, INVENTORY_FILE), { missing: true, maxBytes: MAX_INVENTORY_BYTES, noFollow: true, utf8: false });
  if (inventory === null) fail('Package inventory is missing.');
  parseInventory(inventory);
  const { files, ignored } = await readPackageFiles(root, { ignoreHostFiles: true });
  const after = await fs.lstat(root, { bigint: true });
  if (!sameFileIdentity(before, after) || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs ||
      !files.find(file => file.name === INVENTORY_FILE)?.bytes.equals(inventory)) fail('Package changed during verification.');
  return { ...verifyPackageFiles(files, options), ignoredCount: ignored.length, ignored: ignored.slice(0, 100) };
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/package-integrity.mjs /absolute/plugin-root [--expected-inventory-sha256 trusted-hash]\nRead-only package verification. Obtain the optional inventory digest from the matching archive entry in a separately trusted release.json. Never installs or repairs.');
    return 0;
  }
  if (![1, 3].includes(args.length) || !path.isAbsolute(args[0]) || (args.length === 3 && args[1] !== '--expected-inventory-sha256')) fail('Use --help for package verification arguments.');
  const result = await verifyPackage(args[0], { expectedInventorySha256: args[2] });
  console.log(JSON.stringify(result, null, 2));
  return result.integrityVerified && result.trustedInventoryMatches !== false ? 0 : 1;
}
if (await isMain(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`Package verification failed: ${String(error.message).slice(0, 300)}`); process.exitCode = 2; }
}
