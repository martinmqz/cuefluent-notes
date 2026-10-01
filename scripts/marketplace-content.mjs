import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { archiveFiles, pluginZip } from './release-archives.mjs';
import { MARKETPLACE_PATHS, MARKETPLACE_PLUGINS, isMarketplaceFile } from './marketplace-layout.mjs';
import { checkReleaseTag } from './release-policy.mjs';
import { compare, isMain } from './file-io.mjs';

function git(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.toString());
  return result.stdout;
}

/** Read committed candidate bytes, including Git's staging conversions. */
export function marketplaceTreeFiles(root, tree) {
  const entries = git(root, ['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...MARKETPLACE_PATHS])
    .toString().split('\0').filter(Boolean).map(row => {
      const [meta, name] = row.split('\t');
      const [mode, type, oid] = meta.split(' ');
      if (!/^100(644|755)$/.test(mode) || type !== 'blob' || !isMarketplaceFile(name)) {
        throw new Error(`Nonportable marketplace entry: ${name}`);
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

export function verifyMarketplaceFiles(files, tag) {
  const byName = new Map(files.map(file => [file.name, file.bytes]));
  const read = name => {
    if (!byName.has(name)) throw new Error(`Missing marketplace file: ${name}`);
    return JSON.parse(byName.get(name).toString());
  };
  const release = read('release.json');
  checkReleaseTag(release.version, tag ?? `v${release.version}`);
  for (const { client, root, catalog } of MARKETPLACE_PLUGINS) {
    const manifest = read(`${root}/.${client}-plugin/plugin.json`);
    if (manifest.name !== 'cuefluent-notes' || manifest.version !== release.version) throw new Error('Marketplace plugin identity/version mismatch.');
    const listing = read(catalog);
    const entries = listing.plugins?.filter(plugin => plugin.name === 'cuefluent-notes');
    const expectedSource = `./${root}`;
    if (listing.name !== 'cuefluent' || entries?.length !== 1 ||
        (client === 'codex' ? entries[0].source?.source !== 'local' || entries[0].source?.path !== expectedSource : entries[0].source !== expectedSource)) {
      throw new Error(`Invalid ${client} marketplace source.`);
    }
    const pluginFiles = files.filter(file => file.name.startsWith(`${root}/`))
      .map(file => ({ ...file, name: file.name.slice(root.length + 1) }))
      .sort((a, b) => compare(a.name, b.name));
    const archives = release.archives?.filter(archive => archive.client === client && archive.variant === 'hooks');
    if (archives?.length !== 1 || createHash('sha256').update(pluginZip(pluginFiles)).digest('hex') !== archives[0].sha256) {
      throw new Error(`${client}: marketplace package does not match its published hooks-ZIP digest.`);
    }
  }
  return release;
}

export async function verifyMarketplaceSnapshot(root, tag) {
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
