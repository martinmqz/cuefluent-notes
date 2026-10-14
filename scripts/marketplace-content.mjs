import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { archiveFiles, pluginZip } from './release-archives.mjs';
import { MARKETPLACE_PATHS, MARKETPLACE_PLUGINS, isMarketplaceFile } from './marketplace-layout.mjs';
import { checkReleaseTag, stableVersionParts } from './release-policy.mjs';
import { compare, isMain } from './file-io.mjs';
import { INVENTORY_FILE, verifyPackageFiles } from './package-integrity.mjs';
import { validateManifestPair } from './plugin-manifest.mjs';

function git(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.toString());
  return result.stdout;
}

/** Read committed candidate bytes, including Git's staging conversions. Archive
 * digests normalize modes, so enforce ordinary 0644 files in the Git tree too. */
export function marketplaceTreeFiles(root, tree) {
  const entries = git(root, ['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...MARKETPLACE_PATHS])
    .toString().split('\0').filter(Boolean).map(row => {
      const separator = row.indexOf('\t');
      const meta = row.slice(0, separator), name = row.slice(separator + 1);
      const [mode, type, oid] = meta.split(' ');
      if (mode !== '100644' || type !== 'blob' || !isMarketplaceFile(name) || /[\\\x00-\x1f\x7f\ufffd]/.test(name)) {
        throw new Error('Nonportable marketplace Git entry.');
      }
      return { name, oid };
    });
  const bytes = git(root, ['cat-file', '--batch'], entries.map(entry => `${entry.oid}\n`).join(''));
  let offset = 0;
  return entries.map(entry => {
    const end = bytes.indexOf(10, offset);
    const [oid, type, sizeText] = bytes.subarray(offset, end).toString().split(' ');
    const size = Number(sizeText);
    if (end < 0 || oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || end + size + 2 > bytes.length) {
      throw new Error('Invalid Git blob response.');
    }
    offset = end + size + 2;
    return { name: entry.name, bytes: bytes.subarray(end + 1, offset - 1) };
  });
}

/** Ignore untracked Finder/Explorer files while still detecting tracked edits. */
export async function trackedMarketplaceFiles(root) {
  const names = git(root, ['ls-files', '-z', '--', ...MARKETPLACE_PATHS]).toString().split('\0').filter(Boolean);
  return Promise.all(names.map(async name => {
    const file = path.join(root, name);
    if (!(await fs.lstat(file)).isFile()) throw new Error(`Nonportable marketplace entry: ${name}`);
    return { name, bytes: await fs.readFile(file) };
  }));
}

function verifyMarketplace(files, tag, archiveMatches) {
  const byName = new Map(files.map(file => [file.name, file.bytes]));
  if (byName.size !== files.length) throw new Error('Duplicate marketplace file.');
  const read = name => {
    if (!byName.has(name)) throw new Error(`Missing marketplace file: ${name}`);
    return JSON.parse(byName.get(name).toString());
  };
  const release = read('release.json');
  checkReleaseTag(release.version, tag ?? `v${release.version}`);
  const [major, minor] = stableVersionParts(release.version);
  const inventoryRequired = major > 0n || minor >= 11n; // Introduced in 0.11.0.
  const packages = [];
  for (const { client, root, catalog } of MARKETPLACE_PLUGINS) {
    const manifest = read(`${root}/.${client}-plugin/plugin.json`);
    if (manifest.name !== 'cuefluent-notes' || manifest.version !== release.version) throw new Error('Marketplace plugin identity/version mismatch.');
    const listing = read(catalog);
    const entries = Array.isArray(listing.plugins) ? listing.plugins.filter(plugin => plugin?.name === 'cuefluent-notes') : [];
    const expectedSource = `./${root}`;
    if (listing.name !== 'cuefluent' || entries?.length !== 1 ||
        (client === 'codex' ? entries[0].source?.source !== 'local' || entries[0].source?.path !== expectedSource : entries[0].source !== expectedSource)) {
      throw new Error(`Invalid ${client} marketplace source.`);
    }
    const pluginFiles = files.filter(file => file.name.startsWith(`${root}/`))
      .map(file => ({ ...file, name: file.name.slice(root.length + 1) }))
      .sort((a, b) => compare(a.name, b.name));
    const archives = release.archives?.filter(archive => archive.client === client && archive.variant === 'hooks');
    if (archives?.length !== 1 || !archiveMatches(client, pluginFiles, archives[0].sha256)) {
      throw new Error(`${client}: marketplace package does not match its published hooks-ZIP digest.`);
    }
    const inventory = pluginFiles.find(file => file.name === INVENTORY_FILE);
    if (inventoryRequired || inventory || archives[0].inventorySha256 !== undefined) {
      if (!inventory || typeof archives[0].inventorySha256 !== 'string') throw new Error(`${client}: invalid package inventory.`);
      const verified = verifyPackageFiles(pluginFiles, { expectedInventorySha256: archives[0].inventorySha256 });
      if (!verified.trustedReleaseVerified) throw new Error(`${client}: invalid package inventory.`);
      if (verified.client !== client || verified.version !== release.version || verified.variant !== 'hooks') throw new Error(`${client}: package inventory identity differs from marketplace release.`);
      if (client === 'claude' && entries[0].description !== manifest.description) throw new Error('Claude catalog description differs from plugin manifest.');
      if (client === 'claude' && entries[0].license !== manifest.license) throw new Error('Claude catalog license differs from plugin manifest.');
    }
    packages.push({ manifest, files: pluginFiles, inventory: Boolean(inventory) });
  }
  // Releases before 0.11.0 without inventories keep their original digest contract.
  // Do not reconstruct old releases using today's source-file selection policy.
  if (packages.some(pkg => pkg.inventory)) {
    if (!packages.every(pkg => pkg.inventory)) throw new Error('Both client packages must include inventories.');
    validateManifestPair(packages[0].manifest, packages[1].manifest);
    const shared = pkg => pkg.files.filter(file => file.name.startsWith('skills/cuefluent-notes/'));
    const left = shared(packages[0]), right = shared(packages[1]);
    if (left.length !== right.length || left.some((file, index) => file.name !== right[index].name || !file.bytes.equals(right[index].bytes))) throw new Error('Shared client package contents differ.');
  }
  return release;
}

/** Independently verify an existing release, including its original ZIP digests. */
export function verifyMarketplaceFiles(files, tag) {
  return verifyMarketplace(files, tag, (_client, payload, digest) => createHash('sha256').update(pluginZip(payload)).digest('hex') === digest);
}

/** The builder retains the exact sorted inputs and digest of each ZIP it emitted.
 * Compare the final snapshot to those bytes instead of compressing them again.
 * Existing/untrusted releases must use verifyMarketplaceFiles, not build receipts. */
export function verifyBuiltMarketplace(files, tag, capturedPackages) {
  return verifyMarketplace(files, tag, (client, payload, digest) => {
    const captured = capturedPackages.get(client);
    return captured?.sha256 === digest && captured.files.length === payload.length &&
      payload.every((file, index) => file.name === captured.files[index].name && file.bytes.equals(captured.files[index].bytes));
  });
}

export async function verifyMarketplaceSnapshot(root, tag) {
  root = path.resolve(root);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Nonportable marketplace snapshot root.');
  async function checkEntries(relative = '') {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const allowed = isMarketplaceFile(name) || name === 'README.md' || MARKETPLACE_PATHS.some(owned => owned.startsWith(`${name}/`));
      if (!allowed) throw new Error(`Unexpected marketplace snapshot entry: ${name}`);
      if (entry.isDirectory()) await checkEntries(name);
      else if (!entry.isFile()) throw new Error(`Nonportable marketplace snapshot entry: ${name}`);
    }
  }
  await checkEntries();
  const files = await archiveFiles(root);
  for (const { name } of files) {
    if (name !== 'README.md' && !isMarketplaceFile(name)) throw new Error(`Unexpected marketplace snapshot entry: ${name}`);
  }
  return verifyMarketplaceFiles(files, tag);
}

if (await isMain(import.meta.url)) {
  try {
    const [mode, target, tag] = process.argv.slice(2);
    if (mode === 'snapshot') await verifyMarketplaceSnapshot(target, tag);
    else if (mode === 'tree') verifyMarketplaceFiles(marketplaceTreeFiles(process.cwd(), target), tag);
    else throw new Error('Usage: node scripts/marketplace-content.mjs snapshot directory [tag] | tree git-tree [tag]');
    console.log('Marketplace content verified.');
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
