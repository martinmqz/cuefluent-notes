import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPackages, readPortableSource, packageReadme } from './package.mjs';
import { isMain } from './file-io.mjs';
import { stableVersionParts } from './release-policy.mjs';
import { archiveFiles, pluginZip, marketplaceTar } from './release-archives.mjs';
import { INVENTORY_FILE, withPackageInventory } from './package-integrity.mjs';
import { verifyBuiltMarketplace } from './marketplace-content.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

/** Prepare a fresh marketplace and archives. Does not install or publish. */
export async function buildRelease({ outDir = path.join(sourceRoot, 'dist/release') } = {}) {
  // Inspect all release-only inputs before creating output, then publish those
  // exact bytes. These files have the same portability rules as packaged guides.
  const inputs = new Map(await Promise.all([
    'packaging/codex/marketplace.json', 'packaging/claude/marketplace.json', 'packaging/marketplace-readme.md',
  ].map(async relative => [relative, await readPortableSource(relative)])));
  // Reuse the package builder's fresh-output reservation and source-path guards.
  const built = await buildPackages({ outDir, withHooks: true });
  const output = built.outDir;
  try {
    await fs.rename(path.join(output, 'codex'), path.join(output, 'plugins'));
    const manifest = JSON.parse(await fs.readFile(path.join(output, 'plugins/cuefluent-notes/.codex-plugin/plugin.json'), 'utf8'));
    // Stable version tags are the only supported public release channel.
    stableVersionParts(manifest.version);
    const version = manifest.version;
    for (const [client, destination] of [['codex', '.agents/plugins'], ['claude', '.claude-plugin']]) {
      await fs.mkdir(path.join(output, destination), { recursive: true });
      await fs.writeFile(path.join(output, destination, 'marketplace.json'), inputs.get(`packaging/${client}/marketplace.json`), { flag: 'wx' });
    }
    await fs.writeFile(path.join(output, 'README.md'), inputs.get('packaging/marketplace-readme.md'), { flag: 'wx' });
    const artifacts = path.join(output, 'artifacts');
    await fs.mkdir(artifacts);
    const archives = [], capturedPackages = new Map();
    for (const client of ['codex', 'claude']) {
      const plugin = path.join(output, client === 'codex' ? 'plugins' : 'claude', 'cuefluent-notes');
      const hookFiles = await archiveFiles(plugin);
      for (const variant of ['hooks', 'manual']) {
        const files = variant === 'hooks' ? hookFiles : withPackageInventory(hookFiles
          .filter(file => !file.name.startsWith('hooks/'))
          .map(file => file.name === 'README.md' ? { ...file, bytes: Buffer.from(packageReadme(client, version, false)) } : file),
        { client, version, withHooks: false });
        const name = `cuefluent-notes-${version}-${client}-${variant}.zip`;
        const bytes = pluginZip(files);
        await fs.writeFile(path.join(artifacts, name), bytes, { flag: 'wx' });
        archives.push({ name, client, variant, sha256: createHash('sha256').update(bytes).digest('hex'),
          inventorySha256: createHash('sha256').update(files.find(file => file.name === INVENTORY_FILE).bytes).digest('hex') });
        if (variant === 'hooks') capturedPackages.set(client, { files: hookFiles, sha256: archives.at(-1).sha256 });
      }
    }
    await fs.writeFile(path.join(output, 'release.json'), json({ version, archives }), { flag: 'wx' });
    const marketplaceArchive = `cuefluent-notes-${version}-marketplace.tar.gz`;
    const snapshotFiles = await archiveFiles(output, { exclude: ['artifacts'] });
    verifyBuiltMarketplace(snapshotFiles, `v${version}`, capturedPackages);
    const snapshot = await marketplaceTar(snapshotFiles);
    await fs.writeFile(path.join(artifacts, marketplaceArchive), snapshot, { flag: 'wx' });
    const marketplaceHash = createHash('sha256').update(snapshot).digest('hex');
    await fs.writeFile(path.join(artifacts, 'SHA256SUMS'),
      archives.map(a => `${a.sha256}  ${a.name}\n`).join('') + `${marketplaceHash}  ${marketplaceArchive}\n`, { flag: 'wx' });
    return { outDir: output, version, archives, marketplaceArchive };
  } catch (error) {
    // Only remove the directory successfully reserved by this invocation.
    await fs.rm(output, { recursive: true, force: true }).catch(cleanup => {
      console.error(`Release cleanup failed at ${output}: ${cleanup.message}`);
    });
    throw error;
  }
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/release.mjs [--out fresh-directory]\nBuild both marketplaces, hook/manual ZIPs, a marketplace snapshot, and SHA-256 checksums. Never installs or publishes.');
    return 0;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1] || args[1].startsWith('--'))) {
    throw new Error('Unknown or incomplete option; use --help.');
  }
  console.log(json(await buildRelease({ outDir: args[1] })));
  return 0;
}
if (await isMain(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`Release build failed: ${String(error.message).slice(0, 500)}`); process.exitCode = 2; }
}
