import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const PACKAGE_LIMITS = Object.freeze({ files: 4096, fileBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, inventoryBytes: 2 * 1024 * 1024 });
export const REFERENCES = Object.freeze(['setup', 'notes', 'commands', 'limits']);
export const INVENTORY = 'package-inventory.json';
// The source package version names tags, archives and manifests: an exact SemVer
// core with an optional prerelease and no build metadata. Companion copies of
// this tool run without src/, so src/core/version.mjs keeps an identical copy.
export const PACKAGE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
// Exact dependency pins may additionally carry nonempty build identifiers;
// numeric build identifiers, unlike prerelease identifiers, may have leading zeros.
const VERSION = new RegExp(`${PACKAGE_VERSION.source.slice(0, -1)}(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requirePackage = (condition, code = 'PACKAGE_INVALID') => { if (!condition) { const error = new Error('The package source, locked dependency, archive, or inventory could not be verified.'); error.code = code; throw error; } };
const keys = (input, fields) => input && typeof input === 'object' && !Array.isArray(input) && equal(Object.keys(input).sort(compare), [...fields].sort(compare));
const inside = (root, target) => target === root || (!path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target)));

/** Mirror npm's platform defaults without reading configuration or credentials. */
export function defaultNpmCache({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return env.npm_config_cache ?? env.NPM_CONFIG_CACHE ?? (platform === 'win32'
    ? paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'npm-cache') : paths.join(home, '.npm'));
}

export function packagePath(name) {
  requirePackage(typeof name === 'string' && name.length <= 1024 && name.split('/').length <= 24 && name.split('/').every(part => part && part !== '.' && part !== '..' &&
    !/[\\\u0000-\u001f\u007f:*?"<>|]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'PACKAGE_PATH_INVALID');
  return name;
}

const stable = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
async function readFile(root, relative, maxBytes = PACKAGE_LIMITS.fileBytes) {
  packagePath(relative); const components = relative.split('/'); let current = root;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component); const stat = await fs.lstat(current);
    requirePackage(stat.isDirectory() && !stat.isSymbolicLink(), 'PACKAGE_SOURCE_UNSAFE');
  }
  const file = path.join(root, ...components), before = await fs.lstat(file, { bigint: true });
  requirePackage(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(maxBytes), 'PACKAGE_SOURCE_UNSAFE');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    requirePackage(stable(before, await handle.stat({ bigint: true })), 'PACKAGE_SOURCE_CHANGED');
    const bytes = await handle.readFile();
    requirePackage(bytes.length <= maxBytes && stable(before, await handle.stat({ bigint: true })) && stable(before, await fs.lstat(file, { bigint: true })), 'PACKAGE_SOURCE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

function filesValue(input) {
  requirePackage(Array.isArray(input) && input.length > 0 && input.length <= PACKAGE_LIMITS.files);
  const sorted = [...input].sort((a, b) => compare(a.path, b.path)), seen = new Set(); let total = 0;
  for (const file of sorted) {
    packagePath(file.path); requirePackage(Buffer.isBuffer(file.bytes) && file.bytes.length <= PACKAGE_LIMITS.fileBytes);
    const key = file.path.normalize('NFC').toLowerCase(); requirePackage(!seen.has(key)); seen.add(key);
    total += file.bytes.length; requirePackage(total <= PACKAGE_LIMITS.totalBytes, 'PACKAGE_SIZE_LIMIT');
  }
  for (const file of sorted) for (let parent = path.posix.dirname(file.path); parent !== '.'; parent = path.posix.dirname(parent)) requirePackage(!seen.has(parent.normalize('NFC').toLowerCase()), 'PACKAGE_PATH_INVALID');
  return sorted;
}

/** Bounded npm tar reader. Unsupported extensions, links and special files fail
 * closed; verified current runtime tarballs contain ordinary USTAR files only. */
export function readTar(bytes) {
  requirePackage(Buffer.isBuffer(bytes) && bytes.length <= PACKAGE_LIMITS.totalBytes);
  const files = []; let offset = 0, entries = 0, ended = false;
  const text = value => new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(0, value.indexOf(0) < 0 ? value.length : value.indexOf(0)));
  const octal = value => { const source = text(value).trim(); requirePackage(/^[0-7]+$/.test(source), 'PACKAGE_ARCHIVE_INVALID'); return Number.parseInt(source, 8); };
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) { requirePackage(bytes.subarray(offset).every(byte => byte === 0), 'PACKAGE_ARCHIVE_INVALID'); ended = true; break; }
    requirePackage(++entries <= PACKAGE_LIMITS.files * 2, 'PACKAGE_SIZE_LIMIT');
    const expected = octal(header.subarray(148, 156)); let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
    requirePackage(expected === sum, 'PACKAGE_ARCHIVE_INVALID');
    const size = octal(header.subarray(124, 136)), prefix = text(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`, type = header[156];
    requirePackage(size <= PACKAGE_LIMITS.fileBytes && offset + Math.ceil(size / 512) * 512 <= bytes.length, 'PACKAGE_SIZE_LIMIT');
    if (type === 53) { requirePackage(size === 0); packagePath(name.replace(/\/$/, '')); }
    else { requirePackage(type === 0 || type === 48, 'PACKAGE_ARCHIVE_UNSUPPORTED'); files.push({ path: packagePath(name), bytes: Buffer.from(bytes.subarray(offset, offset + size)) }); }
    offset += Math.ceil(size / 512) * 512;
  }
  requirePackage(ended, 'PACKAGE_ARCHIVE_INVALID'); return filesValue(files);
}

function resolveDependency(packages, from, name) {
  requirePackage(typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name));
  for (let cursor = from; ; cursor = cursor.includes('/node_modules/') ? cursor.slice(0, cursor.lastIndexOf('/node_modules/')) : '') {
    const candidate = `${cursor ? `${cursor}/` : ''}node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    requirePackage(cursor !== '', 'PACKAGE_DEPENDENCY_MISSING');
  }
}

export async function readProductionDependencies({ repoRoot, cacheRoot = defaultNpmCache() }) {
  repoRoot = await fs.realpath(repoRoot);
  try { cacheRoot = await fs.realpath(cacheRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; requirePackage(false, 'PACKAGE_CACHE_MISSING'); }
  const source = parse(await readFile(repoRoot, 'package.json')), lockBytes = await readFile(repoRoot, 'package-lock.json'), lock = parse(lockBytes);
  requirePackage(source.name === 'cuefluent-notes' && PACKAGE_VERSION.test(source.version) && source.type === 'module' && typeof source.license === 'string' && source.engines?.node &&
    lock.lockfileVersion === 3 && lock.name === source.name && lock.version === source.version && lock.packages?.[''] &&
    equal(lock.packages[''].dependencies, source.dependencies) && equal(lock.packages[''].engines, source.engines), 'PACKAGE_LOCK_INVALID');
  for (const value of Object.values(source.dependencies ?? {})) requirePackage(typeof value === 'string' && VERSION.test(value), 'PACKAGE_DEPENDENCY_UNPINNED');
  const pending = Object.keys(source.dependencies ?? {}).map(name => resolveDependency(lock.packages, '', name)), closure = new Map();
  while (pending.length) {
    const key = pending.shift(); if (closure.has(key)) continue;
    const item = lock.packages[key]; packagePath(key);
    requirePackage(item && !item.dev && !item.link && VERSION.test(item.version) && typeof item.license === 'string' &&
      typeof item.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity), 'PACKAGE_LOCK_INVALID');
    const url = new URL(item.resolved); requirePackage(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'PACKAGE_LOCK_INVALID');
    requirePackage(!Object.keys(item.optionalDependencies ?? {}).length && !Object.keys(item.peerDependencies ?? {}).length, 'PACKAGE_DEPENDENCY_UNSUPPORTED');
    closure.set(key, item);
    for (const name of Object.keys(item.dependencies ?? {})) pending.push(resolveDependency(lock.packages, key, name));
  }
  const files = [], dependencies = [], notices = ['# Third-party licenses', '', 'Runtime packages are included from the exact lockfile tarballs. Each archive is verified against its SHA-512 integrity before packaging.', ''];
  for (const [key, item] of [...closure].sort(([a], [b]) => compare(a, b))) {
    const sri = Buffer.from(item.integrity.slice(7), 'base64').toString('hex');
    let archive;
    try { archive = await readFile(cacheRoot, `_cacache/content-v2/sha512/${sri.slice(0, 2)}/${sri.slice(2, 4)}/${sri.slice(4)}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; requirePackage(false, 'PACKAGE_DEPENDENCY_TARBALL_MISSING'); }
    requirePackage(`sha512-${createHash('sha512').update(archive).digest('base64')}` === item.integrity, 'PACKAGE_DEPENDENCY_INTEGRITY');
    const unpacked = readTar(gunzipSync(archive, { maxOutputLength: PACKAGE_LIMITS.totalBytes }));
    requirePackage(unpacked.every(file => file.path.startsWith('package/')), 'PACKAGE_ARCHIVE_INVALID');
    const packageFiles = unpacked.map(file => ({ ...file, path: file.path.slice(8) }));
    const metadata = parse(packageFiles.find(file => file.path === 'package.json')?.bytes ?? Buffer.alloc(0));
    const name = key.slice(key.lastIndexOf('node_modules/') + 13);
    requirePackage(metadata.name === name && metadata.version === item.version && metadata.license === item.license && equal(metadata.dependencies ?? {}, item.dependencies ?? {}), 'PACKAGE_DEPENDENCY_MISMATCH');
    requirePackage(!Object.keys(metadata.optionalDependencies ?? {}).length && !Object.keys(metadata.peerDependencies ?? {}).length, 'PACKAGE_DEPENDENCY_UNSUPPORTED');
    const licenses = packageFiles.filter(file => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(path.posix.basename(file.path)));
    requirePackage(licenses.length > 0, 'PACKAGE_LICENSE_MISSING');
    notices.push(`## ${name} ${item.version}`, '', `License: ${item.license}`, '', `Integrity: ${item.integrity}`, '');
    for (const file of licenses) {
      requirePackage(file.bytes.length <= 256 * 1024, 'PACKAGE_SIZE_LIMIT');
      notices.push(`### ${key}/${file.path}`, '', new TextDecoder('utf-8', { fatal: true }).decode(file.bytes), '');
    }
    files.push(...packageFiles.map(file => ({ ...file, path: `${key}/${file.path}` })));
    dependencies.push({ name, version: item.version, path: key, license: item.license, integrity: item.integrity });
  }
  const runtime = { name: source.name, version: source.version, private: true, type: 'module', description: source.description, license: source.license, engines: source.engines, dependencies: source.dependencies };
  const productionLock = { name: source.name, version: source.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: source.name, version: source.version, license: source.license, dependencies: source.dependencies, engines: source.engines }, ...Object.fromEntries([...closure].sort(([a], [b]) => compare(a, b))) } };
  return { source, runtime, lock: productionLock, sourceLockSha256: digest(lockBytes), dependencies, files: filesValue(files), notices: Buffer.from(notices.join('\n')) };
}

function archiveNames(files, prefix) { packagePath(prefix); requirePackage(!prefix.includes('/')); return filesValue(files.map(file => ({ ...file, path: `${prefix}/${file.path}` }))); }
const octalField = (header, start, length, value) => { const text = value.toString(8); requirePackage(text.length < length, 'PACKAGE_ARCHIVE_INVALID'); header.write(text.padStart(length - 1, '0') + '\0', start, length, 'ascii'); };
export function tarArchive(files, { prefix = 'cuefluent-notes' } = {}) {
  const chunks = [];
  for (const file of archiveNames(files, prefix)) {
    const header = Buffer.alloc(512); let name = file.path, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const parts = name.split('/'); name = parts.pop(); prefix = parts.join('/');
      requirePackage(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155, 'PACKAGE_ARCHIVE_UNSUPPORTED');
    }
    header.write(name, 0, 100); header.write(prefix, 345, 155); octalField(header, 100, 8, 0o644); octalField(header, 108, 8, 0); octalField(header, 116, 8, 0);
    octalField(header, 124, 12, file.bytes.length); octalField(header, 136, 12, 0); header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6); header.write('00', 263, 2); const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii'); chunks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); const compressed = gzipSync(Buffer.concat(chunks), { level: 9 }); compressed[9] = 255; return compressed;
}
const CRC = Array.from({ length: 256 }, (_, index) => { let value = index; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = CRC[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
export function zipArchive(files, { prefix = 'cuefluent-notes' } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const file of archiveNames(files, prefix)) {
    const name = Buffer.from(file.path), crc = crc32(file.bytes), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.length, 18); local.writeUInt32LE(file.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(file.bytes.length, 20); record.writeUInt32LE(file.bytes.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    locals.push(local, name, file.bytes); central.push(record, name); offset += local.length + name.length + file.bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = locals.length / 3;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function withInventory(files, metadata) {
  files = filesValue(files); requirePackage(!files.some(file => file.path === INVENTORY));
  const inventory = { format: 'cuefluent-notes-package', schema: 1, ...metadata, files: files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) })) };
  const bytes = json(inventory); requirePackage(bytes.length <= PACKAGE_LIMITS.inventoryBytes, 'PACKAGE_SIZE_LIMIT');
  return filesValue([...files, { path: INVENTORY, bytes }]);
}

function validateDetachedClosure(byName, inventory) {
  const runtime = parse(byName.get('package.json') ?? Buffer.alloc(0)), lock = parse(byName.get('package-lock.json') ?? Buffer.alloc(0));
  requirePackage(runtime.name === 'cuefluent-notes' && runtime.version === inventory.version && runtime.type === 'module' && runtime.engines?.node === inventory.node && !runtime.devDependencies && !runtime.scripts &&
    lock.lockfileVersion === 3 && lock.name === runtime.name && lock.version === runtime.version && equal(lock.packages?.[''].dependencies, runtime.dependencies), 'PACKAGE_IDENTITY_MISMATCH');
  const pending = Object.keys(runtime.dependencies ?? {}).map(name => resolveDependency(lock.packages, '', name)), seen = new Set(), expected = [];
  while (pending.length) {
    const key = pending.shift(); if (seen.has(key)) continue; seen.add(key);
    const item = lock.packages[key], metadata = parse(byName.get(`${key}/package.json`) ?? Buffer.alloc(0));
    const name = key.slice(key.lastIndexOf('node_modules/') + 13);
    requirePackage(!item.dev && VERSION.test(item.version) && /^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity) && typeof item.license === 'string' && metadata.name === name && metadata.version === item.version &&
      metadata.license === item.license && equal(metadata.dependencies ?? {}, item.dependencies ?? {}), 'PACKAGE_DEPENDENCY_MISMATCH');
    requirePackage([...byName.keys()].some(file => file.startsWith(`${key}/`) && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(path.posix.basename(file))), 'PACKAGE_LICENSE_MISSING');
    expected.push({ name, version: item.version, path: key, license: item.license, integrity: item.integrity });
    for (const dependency of Object.keys(item.dependencies ?? {})) pending.push(resolveDependency(lock.packages, key, dependency));
  }
  expected.sort((a, b) => compare(a.path, b.path));
  requirePackage(equal(expected, inventory.dependencies) && Object.keys(lock.packages).length === expected.length + 1 && byName.has('THIRD_PARTY_NOTICES.md'), 'PACKAGE_DEPENDENCY_MISMATCH');
  for (const required of ['src/cli.mjs', 'LICENSE.md', 'README.md', '.mcp.json', 'hooks/hooks.json', 'skills/cuefluent-notes/SKILL.md', ...REFERENCES.map(name => `skills/cuefluent-notes/references/${name}.md`)]) requirePackage(byName.has(required), 'PACKAGE_CONTENT_MISMATCH');
}

/** Build both self-contained candidates into an absent directory. This tool
 * never installs plugins, writes client config, or updates published artifacts. */
export async function buildPackages({ repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outputRoot, cacheRoot } = {}) {
  repoRoot = await fs.realpath(repoRoot); requirePackage(typeof outputRoot === 'string' && path.isAbsolute(outputRoot), 'PACKAGE_OUTPUT_INVALID');
  outputRoot = path.resolve(outputRoot);
  const parent = await fs.realpath(path.dirname(outputRoot)); outputRoot = path.join(parent, path.basename(outputRoot));
  requirePackage(!inside(repoRoot, outputRoot), 'PACKAGE_OUTPUT_INVALID');
  const repositoryIdentity = await fs.stat(repoRoot, { bigint: true });
  for (let current = parent; ; current = path.dirname(current)) {
    const identity = await fs.stat(current, { bigint: true });
    requirePackage(identity.dev !== repositoryIdentity.dev || identity.ino !== repositoryIdentity.ino, 'PACKAGE_OUTPUT_INVALID');
    if (current === path.dirname(current)) break;
  }
  try { await fs.lstat(outputRoot); requirePackage(false, 'PACKAGE_OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const dependencies = await readProductionDependencies({ repoRoot, cacheRoot });
  const sources = parse(await readFile(repoRoot, 'packaging/plugin/source-files.json'));
  requirePackage(Array.isArray(sources) && sources.includes('src/cli.mjs') && sources.length <= 1024 && sources.every(name => typeof name === 'string' && /^src\/.+\.mjs$/.test(name)) && new Set(sources).size === sources.length, 'PACKAGE_SOURCE_INVENTORY');
  const shared = [{ path: 'package.json', bytes: json(dependencies.runtime) }, { path: 'package-lock.json', bytes: json(dependencies.lock) },
    { path: 'THIRD_PARTY_NOTICES.md', bytes: dependencies.notices }, ...dependencies.files];
  for (const name of [...sources, 'LICENSE.md', 'README.md', 'SKILL.md', ...REFERENCES.map(name => `references/${name}.md`)]) {
    let bytes = await readFile(repoRoot, name);
    // The root README stays in place while its linked references move with the skill.
    if (name === 'README.md') bytes = Buffer.from(bytes.toString('utf8').replaceAll('](references/', '](skills/cuefluent-notes/references/'));
    const target = name === 'SKILL.md' || name.startsWith('references/') ? `skills/cuefluent-notes/${name}` : name;
    shared.push({ path: target, bytes });
  }
  const sourceNames = new Set(sources), direct = new Set(Object.keys(dependencies.runtime.dependencies));
  for (const file of shared.filter(file => file.path.startsWith('src/'))) {
    const source = file.bytes.toString('utf8');
    // Match module declarations, rather than ordinary object keys or prose such
    // as ['from', 'to']. Dynamic imports retain a separate import(...) form.
    for (const match of source.matchAll(/(?:^\s*(?:import\s+(?:[\w*$\s{},]+\s+from\s*)?|export\s+[\w*$\s{},]+\s+from\s*)|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]; if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) requirePackage(sourceNames.has(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier))), 'PACKAGE_SOURCE_CLOSURE');
      else requirePackage(direct.has(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]), 'PACKAGE_SOURCE_CLOSURE');
    }
    for (const match of source.matchAll(/new URL\(\s*['"]([^'"]+\.mjs)['"]\s*,\s*import\.meta\.url\s*\)/g)) requirePackage(sourceNames.has(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]))), 'PACKAGE_SOURCE_CLOSURE');
  }
  const candidates = [];
  for (const client of ['codex', 'claude']) {
    const manifest = parse(await readFile(repoRoot, `packaging/plugin/${client}/plugin.json`));
    requirePackage(manifest.name === 'cuefluent-notes' && manifest.version === '__SOURCE_VERSION__', 'PACKAGE_MANIFEST_INVALID'); manifest.version = dependencies.source.version;
    const files = withInventory([...shared, { path: `.${client}-plugin/plugin.json`, bytes: json(manifest) },
      { path: '.mcp.json', bytes: await readFile(repoRoot, `packaging/plugin/${client}/mcp.json`) }, { path: 'hooks/hooks.json', bytes: await readFile(repoRoot, `packaging/plugin/${client}/hooks.json`) }],
    { client, version: dependencies.source.version, node: dependencies.runtime.engines.node, sourceLockSha256: dependencies.sourceLockSha256, dependencies: dependencies.dependencies });
    const archives = [ { extension: 'tar.gz', bytes: tarArchive(files) }, { extension: 'zip', bytes: zipArchive(files) } ];
    candidates.push({ client, files, archives });
  }
  const companionFiles = [{ path: 'install.mjs', bytes: await readFile(repoRoot, 'tools/install.mjs') }, { path: 'packaging.mjs', bytes: await readFile(repoRoot, 'tools/packaging.mjs') },
    { path: 'README.md', bytes: Buffer.from('# Cuefluent Notes copy and verification tools\n\nThese tools require Node 26.12.1 or a newer Node 26 patch and only built-in Node modules. Obtain the package inventory SHA-256 from an independently trusted build receipt. Run `node packaging.mjs verify /absolute/package --expected-inventory-sha256 SHA256` to verify, then `node install.mjs /absolute/package /absolute/FRESH-destination --expected-inventory-sha256 SHA256` to copy. Existing destinations are refused. Native plugin registration, hook trust and project setup are separate explicit actions.\n') }];
  const companionArchives = [{ extension: 'tar.gz', bytes: tarArchive(companionFiles, { prefix: 'cuefluent-notes-tools' }) }, { extension: 'zip', bytes: zipArchive(companionFiles, { prefix: 'cuefluent-notes-tools' }) }];
  await fs.mkdir(outputRoot); const summary = { schema: 1, version: dependencies.source.version, sourceLockSha256: dependencies.sourceLockSha256, packages: [], tools: [] };
  for (const candidate of candidates) {
    const relative = `${candidate.client}/cuefluent-notes`, root = path.join(outputRoot, ...relative.split('/')); await fs.mkdir(root, { recursive: true });
    for (const file of candidate.files) { const target = path.join(root, ...file.path.split('/')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.bytes, { flag: 'wx', mode: 0o644 }); }
    const archiveResults = [];
    for (const archive of candidate.archives) {
      const name = `cuefluent-notes-${dependencies.source.version}-${candidate.client}.${archive.extension}`;
      await fs.writeFile(path.join(outputRoot, name), archive.bytes, { flag: 'wx', mode: 0o644 }); archiveResults.push({ path: name, bytes: archive.bytes.length, sha256: digest(archive.bytes) });
    }
    summary.packages.push({ client: candidate.client, path: relative, inventorySha256: digest(candidate.files.find(file => file.path === INVENTORY).bytes), archives: archiveResults });
  }
  for (const archive of companionArchives) {
    const name = `cuefluent-notes-${dependencies.source.version}-tools.${archive.extension}`;
    await fs.writeFile(path.join(outputRoot, name), archive.bytes, { flag: 'wx', mode: 0o644 }); summary.tools.push({ path: name, bytes: archive.bytes.length, sha256: digest(archive.bytes) });
  }
  await fs.writeFile(path.join(outputRoot, 'build.json'), json(summary), { flag: 'wx', mode: 0o644 }); return summary;
}

export async function readVerifiedPackage(root, { expectedInventorySha256 } = {}) {
  const selected = await fs.lstat(root); requirePackage(selected.isDirectory() && !selected.isSymbolicLink(), 'PACKAGE_SOURCE_UNSAFE');
  root = await fs.realpath(root); const bytes = await readFile(root, INVENTORY, PACKAGE_LIMITS.inventoryBytes), inventory = parse(bytes);
  requirePackage(keys(inventory, ['format', 'schema', 'client', 'version', 'node', 'sourceLockSha256', 'dependencies', 'files']) && inventory.format === 'cuefluent-notes-package' && inventory.schema === 1 &&
    ['codex', 'claude'].includes(inventory.client) && PACKAGE_VERSION.test(inventory.version) && /^[a-f0-9]{64}$/.test(inventory.sourceLockSha256) && Array.isArray(inventory.dependencies) && Array.isArray(inventory.files) && inventory.files.length > 0 && inventory.files.length < PACKAGE_LIMITS.files && json(inventory).equals(bytes), 'PACKAGE_INVENTORY_INVALID');
  if (expectedInventorySha256 !== undefined) requirePackage(typeof expectedInventorySha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedInventorySha256) && digest(bytes) === expectedInventorySha256, 'PACKAGE_TRUSTED_DIGEST_MISMATCH');
  const files = [], inspected = []; let entries = 0;
  async function visit(relative = '') {
    const directory = path.join(root, ...relative.split('/').filter(Boolean)), before = await fs.lstat(directory, { bigint: true }); requirePackage(before.isDirectory() && !before.isSymbolicLink(), 'PACKAGE_SOURCE_UNSAFE'); inspected.push([directory, before]);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      requirePackage(++entries <= PACKAGE_LIMITS.files * 2, 'PACKAGE_SIZE_LIMIT'); const name = packagePath(`${relative ? `${relative}/` : ''}${entry.name}`);
      if (entry.isDirectory()) await visit(name); else {
        requirePackage(entry.isFile() && !entry.isSymbolicLink(), 'PACKAGE_SOURCE_UNSAFE');
        const file = path.join(root, ...name.split('/')), beforeFile = await fs.lstat(file, { bigint: true });
        files.push({ path: name, bytes: await readFile(root, name) }); requirePackage(stable(beforeFile, await fs.lstat(file, { bigint: true })), 'PACKAGE_SOURCE_CHANGED'); inspected.push([file, beforeFile]);
      }
    }
    requirePackage(stable(before, await fs.lstat(directory, { bigint: true })), 'PACKAGE_SOURCE_CHANGED');
  }
  await visit(); const payload = filesValue(files.filter(file => file.path !== INVENTORY));
  for (const [file, before] of inspected) requirePackage(stable(before, await fs.lstat(file, { bigint: true })), 'PACKAGE_SOURCE_CHANGED');
  requirePackage(files.find(file => file.path === INVENTORY)?.bytes.equals(bytes), 'PACKAGE_SOURCE_CHANGED');
  requirePackage(equal(payload.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) })), inventory.files), 'PACKAGE_CONTENT_MISMATCH');
  const byName = new Map(payload.map(file => [file.path, file.bytes]));
  const manifest = parse(byName.get(`.${inventory.client}-plugin/plugin.json`) ?? Buffer.alloc(0)), runtime = parse(byName.get('package.json') ?? Buffer.alloc(0));
  requirePackage(manifest.name === 'cuefluent-notes' && manifest.version === inventory.version && runtime.name === manifest.name && runtime.version === inventory.version && !runtime.devDependencies && !runtime.scripts, 'PACKAGE_IDENTITY_MISMATCH');
  validateDetachedClosure(byName, inventory);
  return Object.freeze({ verification: Object.freeze({ client: inventory.client, version: inventory.version, files: payload.length, inventorySha256: digest(bytes), integrityVerified: true, trustedInventoryVerified: expectedInventorySha256 !== undefined }), files: Object.freeze(filesValue(files)) });
}

export async function verifyPackage(root, options = {}) { return (await readVerifiedPackage(root, options)).verification; }

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log('node tools/packaging.mjs build /absolute/fresh-output [--cache-root /absolute/npm-cache]\nnode tools/packaging.mjs verify /absolute/package [--expected-inventory-sha256 SHA256]'); return; }
  if (args[0] === 'build' && (args.length === 2 || (args.length === 4 && args[2] === '--cache-root'))) console.log(JSON.stringify(await buildPackages({ outputRoot: args[1], cacheRoot: args[3] }), null, 2));
  else if (args[0] === 'verify' && (args.length === 2 || (args.length === 4 && args[2] === '--expected-inventory-sha256'))) console.log(JSON.stringify(await verifyPackage(args[1], { expectedInventorySha256: args[3] }), null, 2));
  else requirePackage(false, 'PACKAGE_ARGUMENT');
}
if (import.meta.main) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(`Packaging failed (${typeof error.code === 'string' ? error.code : 'PACKAGE_FAILED'}).`); process.exitCode = 1; }
}
