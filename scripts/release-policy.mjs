import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMain } from './file-io.mjs';
import { MARKETPLACE_PATHS, MARKETPLACE_PLUGINS } from './marketplace-layout.mjs';

export function stableVersionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('A stable major.minor.patch version is required.');
  }
  return version.split('.').map(BigInt);
}
export function checkReleaseTag(version, tag) {
  stableVersionParts(version);
  if (tag !== `v${version}`) throw new Error('Release tag must be v followed by the package version.');
}
export function checkMarketplaceAdvance(next, previous) {
  const proposed = stableVersionParts(next.version);
  if (!previous) return 'new-version';
  const current = stableVersionParts(previous.version);
  for (let i = 0; i < proposed.length; i++) {
    if (proposed[i] > current[i]) return 'new-version';
    if (proposed[i] < current[i]) throw new Error('Refusing to downgrade the marketplace; publish a newer version.');
  }
  if (!isDeepStrictEqual(next, previous)) throw new Error('Refusing to replace an existing version with different release artifacts.');
  return 'same-version';
}
export async function main(args) {
  if (args.length === 1 && args[0] === 'paths') return MARKETPLACE_PATHS.join('\n');
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  if (args[0] === 'check-tag' && args.length === 3) {
    checkReleaseTag((await read(args[1])).version, args[2]);
    return 'valid-tag';
  }
  if (args[0] === 'check-tag' || args.length < 2 || args.length > 3) {
    throw new Error('Usage: node scripts/release-policy.mjs check-tag package.json tag | release-directory tag [previous-release.json]');
  }
  const next = await read(path.join(args[0], 'release.json'));
  checkReleaseTag(next.version, args[1]);
  for (const { client, root } of MARKETPLACE_PLUGINS) {
    const manifest = await read(path.join(args[0], root, `.${client}-plugin/plugin.json`));
    if (manifest.name !== 'cuefluent-notes' || manifest.version !== next.version) throw new Error('Marketplace plugin identity/version mismatch.');
  }
  return checkMarketplaceAdvance(next, args[2] ? await read(args[2]) : null);
}
if (await isMain(import.meta.url)) {
  try { console.log(await main(process.argv.slice(2))); }
  catch (error) { console.error(`Release check failed: ${error.message}`); process.exitCode = 2; }
}
