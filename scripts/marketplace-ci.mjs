// Repository CI only; never shipped in a plugin.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isMain } from './file-io.mjs';
import { isMarketplaceFile, isMarketplaceSnapshotFile } from './marketplace-layout.mjs';
import { repositoryCommand } from './repository-command.mjs';
import { checkMarketplaceAdvance, stableVersionParts } from './release-policy.mjs';

const MAX_BYTES = 128 * 1024 * 1024;
const command = (cwd, name, args) => repositoryCommand(cwd, name, args).stdout;
const git = (cwd, args) => command(cwd, 'git', args);
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
const isAncestor = (cwd, ancestor, descendant) => repositoryCommand(cwd, 'git',
  ['merge-base', '--is-ancestor', ancestor, descendant], { allowedStatuses: [0, 1] }).status === 0;

function eligibleEvent(env) {
  return ((env.GITHUB_EVENT_NAME === 'pull_request' && env.CI_BASE_REF === 'main') ||
    (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main')) &&
    sha(env.CI_BASE_SHA) && !/^0+$/.test(env.CI_BASE_SHA);
}

function packageOnlyDiff(cwd, base) {
  const names = git(cwd, ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--'])
    .split('\0').filter(Boolean);
  return names.length > 0 && names.every(isMarketplaceFile);
}

/** Cheap selection only: two complete trees suffice; no npm dependencies or
 * release API calls. A candidate is not permission to omit any checks. */
export function classifyChecks(cwd, env) {
  if (!eligibleEvent(env)) return 'full';
  git(cwd, ['fetch', '--no-tags', '--depth=1', 'origin', env.CI_BASE_SHA]);
  return packageOnlyDiff(cwd, env.CI_BASE_SHA) ? 'candidate' : 'full';
}

/** Only candidates need commit ancestry. Fetch the two selected tips, without
 * unrelated refs/tags; keep the checked-out HEAD. */
export function fetchCheckHistory(cwd, env) {
  if (!eligibleEvent(env)) throw new Error('Cannot fetch CI history for an ineligible event.');
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  const shallow = git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  git(cwd, ['fetch', '--no-tags', ...(shallow ? ['--unshallow'] : []), 'origin', env.CI_BASE_SHA, head]);
}

/** Compare the complete checked-out merge/push tree, including deletions and both
 * sides of renames. Branch names, labels and changed-file API pagination confer
 * no fast-path authority. Tags and manual runs always build/test from source. */
export function packageOnlyChange(cwd, env) {
  if (!eligibleEvent(env)) return false;
  // Exit 1 is a valid negative ancestry result, not a Git failure. Rewritten
  // main history must take full CI; missing objects and command errors still fail.
  return isAncestor(cwd, env.CI_BASE_SHA, 'HEAD') && packageOnlyDiff(cwd, env.CI_BASE_SHA);
}

export function verifyReleaseEvidence({ release, runs, tag, commit }) {
  if (release?.tag_name !== tag || release.draft !== false || release.prerelease !== false || !release.published_at) {
    throw new Error('A published stable release is required.');
  }
  if (!sha(commit) || !runs?.workflow_runs?.some(run => run.head_sha === commit && run.head_branch === tag &&
      run.path === '.github/workflows/release.yml' && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success')) {
    throw new Error('No successful Prepare release run for the exact tag commit.');
  }
}

/** Read a bounded, checksum-verified tar in memory. Never extract release paths
 * to disk or follow archive links. The archive README is intentionally not
 * committed by the marketplace publisher. */
export async function snapshotFiles(snapshot, sums, version) {
  stableVersionParts(version);
  if (snapshot.length > MAX_BYTES || sums.length > 65536) throw new Error('Release assets exceed CI bounds.');
  const name = `cuefluent-notes-${version}-marketplace.tar.gz`;
  const entries = sums.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^([a-f0-9]{64})  ([^/\\\s]+)$/.exec(line);
    if (!match) throw new Error('Invalid published checksum entry.');
    return { digest: match[1], name: match[2] };
  });
  const matches = entries.filter(entry => entry.name === name);
  if (matches.length !== 1 || matches[0].digest !== createHash('sha256').update(snapshot).digest('hex')) {
    throw new Error('Published snapshot checksum mismatch.');
  }
  const bytes = gunzipSync(snapshot, { maxOutputLength: MAX_BYTES });
  const { default: tar } = await import('tar-stream');
  const files = [], seen = new Set();
  const extract = tar.extract();
  await new Promise((resolve, reject) => {
    extract.on('error', reject);
    extract.on('finish', resolve);
    extract.on('entry', (header, stream, next) => {
      stream.on('error', reject);
      const parts = header.name.split('/');
      if (header.type !== 'file' || header.mode !== 0o644 || seen.has(header.name) || seen.size >= 16384 ||
          parts.some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f\x7f]/.test(header.name) ||
          !isMarketplaceSnapshotFile(header.name)) {
        stream.resume(); extract.destroy(new Error('Unsafe or unexpected published snapshot entry.')); return;
      }
      seen.add(header.name);
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => { files.push({ name: header.name, bytes: Buffer.concat(chunks) }); next(); });
    });
    extract.end(bytes);
  });
  return files.filter(file => file.name !== 'README.md');
}

export async function verifyPublishedTree(cwd, { snapshot, sums, version }) {
  const { marketplaceTreeFiles, verifyMarketplaceFiles } = await import('./marketplace-content.mjs');
  const published = await snapshotFiles(snapshot, sums, version);
  verifyMarketplaceFiles(published, `v${version}`);
  const candidate = marketplaceTreeFiles(cwd, 'HEAD');
  const expected = new Map(published.map(file => [file.name, file.bytes]));
  if (candidate.length !== expected.size || candidate.some(file => !expected.get(file.name)?.equals(file.bytes))) {
    throw new Error('Committed marketplace differs from the published release.');
  }
}

export function releaseAssets(release, version) {
  stableVersionParts(version);
  return [`cuefluent-notes-${version}-marketplace.tar.gz`, 'SHA256SUMS'].map((name, index) => {
    const matches = Array.isArray(release.assets) ? release.assets.filter(asset => asset?.name === name) : [];
    const limit = index === 0 ? MAX_BYTES : 65536;
    const asset = matches?.[0];
    if (matches?.length !== 1 || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.id) || asset.id <= 0 ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit) {
      throw new Error(`Missing, invalid or oversized published asset: ${name}`);
    }
    return { id: asset.id, name, size: asset.size, limit };
  });
}

async function readPublished(cwd, env, version, fetchTag = false) {
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Missing CI repository identity.');
  const tag = `v${version}`;
  if (fetchTag) git(cwd, ['fetch', '--no-tags', '--depth=1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  const commit = git(cwd, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
  // A release created from an unrelated branch is not source CI evidence.
  if (!isAncestor(cwd, commit, env.CI_BASE_SHA)) throw new Error('Release provenance refused: the tag commit is not in the CI base history.');
  const api = endpoint => JSON.parse(command(cwd, 'gh', ['api', `repos/${repository}/${endpoint}`]));
  const release = api(`releases/tags/${tag}`);
  const runs = api(`actions/workflows/release.yml/runs?event=push&status=success&head_sha=${commit}&per_page=100`);
  verifyReleaseEvidence({ release, runs, tag, commit });
  // Validate both sizes before fetching either body. Download by validated asset
  // ID into bounded buffers, not an unbounded temporary file on the runner.
  const [snapshot, sums] = releaseAssets(release, version).map(asset => {
    const bytes = repositoryCommand(cwd, 'gh', ['api', `repos/${repository}/releases/assets/${asset.id}`,
      '--header', 'Accept: application/octet-stream'], { encoding: null, maxBuffer: asset.size }).stdout;
    if (bytes.length !== asset.size) throw new Error(`Published asset size changed: ${asset.name}`);
    return bytes;
  });
  return { snapshot, sums, version };
}

export async function selectChecks(cwd, env, loadPublished = readPublished) {
  if (!packageOnlyChange(cwd, env)) return 'full';
  const next = JSON.parse(git(cwd, ['show', 'HEAD:release.json']));
  stableVersionParts(next.version);
  const hasPrevious = git(cwd, ['ls-tree', env.CI_BASE_SHA, '--', 'release.json']).trim();
  const previous = hasPrevious ? JSON.parse(git(cwd, ['show', `${env.CI_BASE_SHA}:release.json`])) : null;
  try {
    if (checkMarketplaceAdvance(next, previous) !== 'new-version') {
      throw new Error('Published marketplace files are immutable; package-only changes require a newer published version.');
    }
  } catch (error) { throw new Error(`Marketplace release policy: ${error.message}`, { cause: error }); }
  await verifyPublishedTree(cwd, await loadPublished(cwd, env, next.version));
  return 'packages';
}

/** This stays behind the existing required "reproducibility" context. Native
 * suites can be omitted only after published-release verification succeeded. */
export function verifyCheckResults(needs, ref = '') {
  const scope = needs?.scope;
  const mode = scope?.outputs?.mode;
  if (scope?.result !== 'success' || !['full', 'packages'].includes(mode) ||
      needs?.test?.result !== 'success') {
    throw new Error('CI selection or required test jobs did not complete successfully.');
  }
  const smoke = needs?.['client-smoke']?.result;
  if (smoke !== 'success' && !(mode === 'full' && ref.startsWith('refs/tags/') && smoke === 'skipped')) {
    throw new Error('Required client registration checks did not complete successfully.');
  }
  return mode;
}

if (await isMain(import.meta.url)) {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    const fetchHistory = mode === 'select' && rest.length === 1 && rest[0] === '--fetch';
    if ((rest.length && !fetchHistory) || !['classify', 'select', 'gate'].includes(mode)) {
      throw new Error('Usage: node scripts/marketplace-ci.mjs classify | select [--fetch] | gate');
    }
    if (mode === 'gate') {
      console.log(`Verified CI path: ${verifyCheckResults(JSON.parse(process.env.CI_NEEDS), process.env.GITHUB_REF)}.`);
    } else {
      if (fetchHistory) fetchCheckHistory(process.cwd(), process.env);
      const selected = mode === 'classify' ? classifyChecks(process.cwd(), process.env) :
        await selectChecks(process.cwd(), process.env, (cwd, env, version) => readPublished(cwd, env, version, fetchHistory));
      if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `mode=${selected}\n`);
      console.log(selected === 'packages' ? 'Published package bytes verified; native source suites are not repeated.' :
        selected === 'candidate' ? 'Package-only candidate; release verification is still required.' : 'Full source checks required.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
