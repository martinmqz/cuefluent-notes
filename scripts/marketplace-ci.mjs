// Repository CI only; never shipped in a plugin.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { isMain } from './file-io.mjs';
import { isMarketplaceFile } from './marketplace-layout.mjs';
import { marketplaceTreeFiles, verifyMarketplaceFiles } from './marketplace-content.mjs';
import { checkMarketplaceAdvance, stableVersionParts } from './release-policy.mjs';

const MAX_BYTES = 128 * 1024 * 1024;
function command(cwd, name, args) {
  const result = spawnSync(name, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: MAX_BYTES });
  if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
const git = (cwd, args) => command(cwd, 'git', args);
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');

/** Compare the complete checked-out merge/push tree, including deletions and both
 * sides of renames. Branch names, labels and changed-file API pagination confer
 * no fast-path authority. Tags and manual runs always build/test from source. */
export function packageOnlyChange(cwd, env) {
  const eligible = (env.GITHUB_EVENT_NAME === 'pull_request' && env.CI_BASE_REF === 'main') ||
    (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main');
  if (!eligible || !sha(env.CI_BASE_SHA) || /^0+$/.test(env.CI_BASE_SHA)) return false;
  git(cwd, ['merge-base', '--is-ancestor', env.CI_BASE_SHA, 'HEAD']);
  const names = git(cwd, ['diff', '--no-renames', '--name-only', '-z', env.CI_BASE_SHA, 'HEAD', '--'])
    .split('\0').filter(Boolean);
  return names.length > 0 && names.every(isMarketplaceFile);
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
          !(header.name === 'README.md' || isMarketplaceFile(header.name))) {
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
  const published = await snapshotFiles(snapshot, sums, version);
  verifyMarketplaceFiles(published, `v${version}`);
  const candidate = marketplaceTreeFiles(cwd, 'HEAD');
  const expected = new Map(published.map(file => [file.name, file.bytes]));
  if (candidate.length !== expected.size || candidate.some(file => !expected.get(file.name)?.equals(file.bytes))) {
    throw new Error('Committed marketplace differs from the published release.');
  }
  // Archive digests normalize permissions. Also reject executable-bit edits,
  // symlinks and submodules in the committed tree before any client loads it.
  const modes = git(cwd, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).split('\0').filter(Boolean);
  for (const row of modes) {
    const separator = row.indexOf('\t');
    const metadata = row.slice(0, separator), name = row.slice(separator + 1);
    if (isMarketplaceFile(name) && (!metadata.startsWith('100644 blob ') || /[\\\x00-\x1f\x7f\ufffd]/.test(name))) {
      throw new Error('Nonportable marketplace Git entry.');
    }
  }
}

async function readPublished(cwd, env, version) {
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Missing CI repository identity.');
  const tag = `v${version}`;
  const commit = git(cwd, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
  // A release created from an unrelated branch is not source CI evidence.
  git(cwd, ['merge-base', '--is-ancestor', commit, env.CI_BASE_SHA]);
  const api = endpoint => JSON.parse(command(cwd, 'gh', ['api', `repos/${repository}/${endpoint}`]));
  const release = api(`releases/tags/${tag}`);
  const runs = api(`actions/workflows/release.yml/runs?event=push&status=success&head_sha=${commit}&per_page=100`);
  verifyReleaseEvidence({ release, runs, tag, commit });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-release-ci-'));
  try {
    const name = `cuefluent-notes-${version}-marketplace.tar.gz`;
    command(cwd, 'gh', ['release', 'download', tag, '--repo', repository, '--pattern', name, '--pattern', 'SHA256SUMS', '--dir', directory]);
    for (const name of await fs.readdir(directory)) {
      if ((await fs.stat(path.join(directory, name))).size > MAX_BYTES) throw new Error('Release asset exceeds CI bounds.');
    }
    return { snapshot: await fs.readFile(path.join(directory, name)), sums: await fs.readFile(path.join(directory, 'SHA256SUMS')), version };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export async function selectChecks(cwd, env, loadPublished = readPublished) {
  if (!packageOnlyChange(cwd, env)) return 'full';
  const next = JSON.parse(git(cwd, ['show', 'HEAD:release.json']));
  stableVersionParts(next.version);
  const hasPrevious = git(cwd, ['ls-tree', env.CI_BASE_SHA, '--', 'release.json']).trim();
  const previous = hasPrevious ? JSON.parse(git(cwd, ['show', `${env.CI_BASE_SHA}:release.json`])) : null;
  if (checkMarketplaceAdvance(next, previous) !== 'new-version') throw new Error('Package-only CI requires a new published version.');
  await verifyPublishedTree(cwd, await loadPublished(cwd, env, next.version));
  return 'packages';
}

/** This stays behind the existing required "reproducibility" context. Native
 * suites can be omitted only after published-release verification succeeded. */
export function verifyCheckResults(needs) {
  const scope = needs?.scope;
  const mode = scope?.outputs?.mode;
  if (scope?.result !== 'success' || !['full', 'packages'].includes(mode) ||
      needs?.test?.result !== 'success') {
    throw new Error('CI selection or required test jobs did not complete successfully.');
  }
  return mode;
}

if (await isMain(import.meta.url)) {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    if (rest.length || !['select', 'gate'].includes(mode)) throw new Error('Usage: node scripts/marketplace-ci.mjs select | gate');
    if (mode === 'gate') {
      console.log(`Verified CI path: ${verifyCheckResults(JSON.parse(process.env.CI_NEEDS))}.`);
    } else {
      const selected = await selectChecks(process.cwd(), process.env);
      if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `mode=${selected}\n`);
      console.log(selected === 'packages' ? 'Published package bytes verified; native source suites are not repeated.' : 'Full source checks required.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
