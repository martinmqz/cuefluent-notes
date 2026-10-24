import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildPackages, verifyPackage, packagePath, PACKAGE_LIMITS, PACKAGE_VERSION } from './packaging.mjs';
import { installPackage } from './install.mjs';
import { createGitRunner } from './git.mjs';

const requireCI = condition => { if (!condition) { const error = new Error('Candidate build verification failed.'); error.code = 'CI_CANDIDATE_INVALID'; throw error; } };
export const ARTIFACT_NAMES = Object.freeze(['v2-candidate-ubuntu-24.04', 'v2-candidate-macos-14', 'v2-candidate-windows-2025']);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export async function bounded(file, limit) {
  const stat = await fs.lstat(file); requireCI(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit);
  const bytes = await fs.readFile(file); requireCI(bytes.length === stat.size && bytes.length <= limit); return bytes;
}

export async function verifyBuildArchives(root) {
  const bytes = await bounded(path.join(root, 'build.json'), 1024 * 1024), build = decode(bytes);
  requireCI(build.schema === 1 && PACKAGE_VERSION.test(build.version) && Array.isArray(build.packages) && build.packages.length === 2 &&
    build.packages[0].client === 'codex' && build.packages[1].client === 'claude' && Array.isArray(build.tools) && build.tools.length === 2);
  for (const item of [...build.packages, { client: 'tools', archives: build.tools }]) {
    requireCI(Array.isArray(item.archives) && item.archives.length === 2);
    requireCI(item.archives[0]?.path === `cuefluent-notes-${build.version}-${item.client}.tar.gz` &&
      item.archives[1]?.path === `cuefluent-notes-${build.version}-${item.client}.zip`);
  }
  const seen = new Set();
  for (const entry of [...build.packages.flatMap(item => item.archives), ...build.tools]) {
    packagePath(entry.path); requireCI(!entry.path.includes('/') && !seen.has(entry.path) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= PACKAGE_LIMITS.totalBytes && /^[a-f0-9]{64}$/.test(entry.sha256)); seen.add(entry.path);
    const archive = await bounded(path.join(root, entry.path), PACKAGE_LIMITS.totalBytes); requireCI(archive.length === entry.bytes && digest(archive) === entry.sha256);
  }
  requireCI(seen.size === 6); return { bytes, build };
}

export async function verifyDetachedBuild(root, { copy = true } = {}) {
  const { build } = await verifyBuildArchives(root);
  for (const item of build.packages) {
    requireCI(item.path === `${item.client}/cuefluent-notes` && /^[a-f0-9]{64}$/.test(item.inventorySha256));
    const packageRoot = path.join(root, ...item.path.split('/'));
    await verifyPackage(packageRoot, { expectedInventorySha256: item.inventorySha256 });
    const profile = path.join(os.tmpdir(), `cuefluent-detached-${randomUUID()}`);
    const output = execFileSync(process.execPath, [path.join(packageRoot, 'src/cli.mjs'), 'settings'], { cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 64 * 1024,
      env: { ...process.env, CUEFLUENT_V2_HOME: profile, NODE_PATH: '' } });
    const settings = JSON.parse(output); requireCI(settings.state === 'unconfigured' && settings.settingsHash === null && settings.settings.projects.length === 0);
    let absent = false; try { await fs.lstat(profile); } catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; } requireCI(absent);
    if (copy) await installPackage({ sourceRoot: packageRoot, destination: path.join(root, `copied-${item.client}`), expectedInventorySha256: item.inventorySha256, client: item.client });
  }
  return build;
}

export async function compareBuilds(root, { includeVerified = false } = {}) {
  const entries = (await fs.readdir(root)).sort(); requireCI(JSON.stringify(entries) === JSON.stringify([...ARTIFACT_NAMES].sort()));
  const verified = {};
  let expected;
  for (const name of ARTIFACT_NAMES) {
    const result = await verifyBuildArchives(path.join(root, name));
    if (expected) requireCI(expected.equals(result.bytes)); else expected = result.bytes;
    if (includeVerified) verified[name] = result;
  }
  return { platforms: ARTIFACT_NAMES.length, identical: true, ...(includeVerified ? { verified } : {}) };
}

/** Bind retained candidates to the checkout actually tested, including PR merge
 * commits. Keep run metadata out of the deterministic build receipt. */
export async function recordBuildSource(root, { repoRoot = process.cwd(), env = process.env } = {}) {
  // The build already verified its archives; bind only its bounded receipt here.
  // Reproducibility and release preparation independently verify the archives.
  const bytes = await bounded(path.join(root, 'build.json'), 1024 * 1024);
  const readGit = createGitRunner(repoRoot), git = args => readGit(args).toString('utf8').trim();
  const integer = value => /^[1-9][0-9]*$/.test(value ?? '') && Number.isSafeInteger(Number(value));
  const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  requireCI(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') &&
    ['GITHUB_REPOSITORY_ID', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'].every(key => integer(env[key])) &&
    ['pull_request', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) &&
    sha(env.GITHUB_SHA) && sha(env.CUEFLUENT_HEAD_SHA));
  const isPR = env.GITHUB_EVENT_NAME === 'pull_request';
  requireCI(!isPR || integer(env.CUEFLUENT_PULL_REQUEST));
  const checkoutCommit = git(['rev-parse', 'HEAD']), checkoutTree = git(['rev-parse', 'HEAD^{tree}']);
  requireCI(checkoutCommit === env.GITHUB_SHA);
  if (isPR) requireCI(git(['show', '-s', '--format=%P', 'HEAD']).split(' ')[1] === env.CUEFLUENT_HEAD_SHA);
  else requireCI(checkoutCommit === env.CUEFLUENT_HEAD_SHA);
  git(['diff', '--exit-code', 'HEAD', '--']);
  const source = { schema: 1, repository: env.GITHUB_REPOSITORY, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), event: env.GITHUB_EVENT_NAME,
    pullRequest: isPR ? Number(env.CUEFLUENT_PULL_REQUEST) : null, headSha: env.CUEFLUENT_HEAD_SHA,
    checkoutCommit, checkoutTree, receiptSha256: digest(bytes) };
  await fs.writeFile(path.join(root, 'source.json'), `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' });
  return source;
}

export async function main(args) {
  if (args.length !== 1) requireCI(false);
  if (args[0] === 'build') {
    requireCI(typeof process.env.CUEFLUENT_BUILD_ROOT === 'string' && path.isAbsolute(process.env.CUEFLUENT_BUILD_ROOT));
    await buildPackages({ outputRoot: process.env.CUEFLUENT_BUILD_ROOT }); console.log(JSON.stringify(await verifyDetachedBuild(process.env.CUEFLUENT_BUILD_ROOT)));
  } else if (args[0] === 'compare') {
    requireCI(typeof process.env.CUEFLUENT_ARTIFACT_ROOT === 'string' && path.isAbsolute(process.env.CUEFLUENT_ARTIFACT_ROOT));
    console.log(JSON.stringify(await compareBuilds(process.env.CUEFLUENT_ARTIFACT_ROOT)));
  } else if (args[0] === 'record-source') {
    requireCI(typeof process.env.CUEFLUENT_BUILD_ROOT === 'string' && path.isAbsolute(process.env.CUEFLUENT_BUILD_ROOT));
    console.log(JSON.stringify(await recordBuildSource(process.env.CUEFLUENT_BUILD_ROOT)));
  } else requireCI(false);
}
if (import.meta.main) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(`Candidate checks failed (${typeof error.code === 'string' ? error.code : 'CI_FAILED'}).`); process.exitCode = 1; }
}
