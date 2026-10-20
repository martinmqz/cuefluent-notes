import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { zipSync } from 'fflate';
import YAML from 'yaml';
import { smokeEnvironment } from './smoke-environment.mjs';
import { buildRelease } from './release.mjs';
import { marketplaceTar } from './release-archives.mjs';
import { MARKETPLACE_PATHS, isMarketplaceSnapshotFile } from './marketplace-layout.mjs';
import { repositoryCommand } from './repository-command.mjs';
import { marketplaceTreeFiles } from './marketplace-content.mjs';
import { packageOnlyChange, selectChecks, snapshotFiles, verifyCheckResults,
  verifyReleaseEvidence, verifyPublishedTree, releaseAssets, releaseRunArtifact,
  verifyRunArtifactSums } from './marketplace-ci.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-ci-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  const env = { ...smokeEnvironment(root), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig') };
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, '');
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = async (name, bytes = 'Synthetic content.\n') => {
    await fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await fs.writeFile(path.join(cwd, name), bytes);
  };
  const commit = () => { git('add', '-A'); git('commit', '--allow-empty', '-m', 'test: synthetic changes'); return git('rev-parse', 'HEAD'); };
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Synthetic CI'); git('config', 'user.email', 'ci@example.invalid');
  await write('README.md');
  const base = commit();
  const event = { GITHUB_EVENT_NAME: 'pull_request', CI_BASE_REF: 'main', CI_BASE_SHA: base };
  return { root, cwd, env, git, write, commit, base, event };
}

async function isolatedCiTools(f) {
  const directory = path.join(f.root, 'ci-tools');
  await fs.mkdir(directory);
  for (const name of ['marketplace-ci.mjs', 'marketplace-layout.mjs', 'release-policy.mjs',
    'file-io.mjs', 'command.mjs', 'repository-command.mjs']) {
    await fs.copyFile(path.join(source, 'scripts', name), path.join(directory, name));
  }
  return path.join(directory, 'marketplace-ci.mjs');
}

test('workflow boundary forces full CI without executing changed selectors, helpers or dependencies', async t => {
  const f = await fixture(t);
  const workflow = YAML.parse(await fs.readFile(path.join(source, '.github/workflows/ci.yml'), 'utf8'));
  const step = workflow.jobs.scope.steps.find(step => step.id === 'classify');
  const script = /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\n?$/.exec(step.run)?.[1];
  assert.ok(script, 'The workflow must classify independently of checked-out modules.');
  const marker = path.join(f.root, 'selector-executed'), output = path.join(f.root, 'boundary-output');
  const poison = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'mode=packages\\n');`;
  await f.write('scripts/marketplace-ci.mjs', poison);
  const base = f.commit();
  f.git('remote', 'add', 'origin', pathToFileURL(f.cwd).href);
  const run = async (event = f.event) => {
    await fs.rm(output, { force: true });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { cwd: f.cwd, env: { ...f.env, ...event, CI_BASE_SHA: base, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'No checkout code may execute at the boundary.');
    return fs.readFile(output, 'utf8');
  };
  assert.equal(await run(), 'mode=full\n', 'An empty diff must run full CI.');
  for (const name of MARKETPLACE_PATHS) {
    f.git('reset', '--hard', base);
    const file = name.endsWith('.json') ? name : `${name}/fixture.md`;
    await f.write(file); f.commit();
    assert.equal(await run(), 'mode=candidate\n', file);
  }
  const packages = f.git('rev-parse', 'HEAD');
  for (const name of ['scripts/marketplace-ci.mjs', 'scripts/marketplace-layout.mjs', 'scripts/repository-command.mjs',
    'scripts/file-io.mjs', 'package.json', 'package-lock.json', '.npmrc', '.github/workflows/ci.yml',
    '.agents/plugins/other.json', 'plugins/cuefluent-notes-other/file.md']) {
    f.git('reset', '--hard', packages);
    await f.write(name, `${poison}\n// Changed source\n`); f.commit();
    assert.equal(await run(), 'mode=full\n', name);
  }
  f.git('reset', '--hard', packages);
  await fs.mkdir(path.join(f.cwd, 'plugins/cuefluent-notes'), { recursive: true });
  f.git('mv', 'README.md', 'plugins/cuefluent-notes/moved.md'); f.commit();
  assert.equal(await run(), 'mode=full\n', 'Renaming source into generated files still changes source.');
  f.git('reset', '--hard', packages);
  f.git('rm', 'scripts/marketplace-ci.mjs'); f.commit();
  assert.equal(await run(), 'mode=full\n', 'Deleting a selector must not prevent full-mode classification.');
  f.git('reset', '--hard', packages);
  for (const event of [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { ...f.event, CI_BASE_REF: 'other' }]) {
    assert.equal(await run(event), 'mode=full\n');
  }
  assert.equal(await run({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }), 'mode=candidate\n');
});

test('classification fetches only selected trees; candidates alone need ancestry and a release tag', async t => {
  const f = await fixture(t);
  const cli = await isolatedCiTools(f);
  f.git('config', 'uploadpack.allowFilter', 'true');
  f.git('switch', '--orphan', 'unrelated');
  await f.write('unrelated.txt', 'Unrelated history.'); const unrelated = f.commit();
  f.git('tag', 'v1.2.3'); f.git('tag', 'unrelated-tag');
  f.git('switch', 'main');
  await f.write('release.json', JSON.stringify({ version: '1.2.3' }));
  f.commit();
  const checkout = path.join(f.root, 'shallow');
  f.git('clone', '--no-tags', '--depth=1', '--branch=main', pathToFileURL(f.cwd).href, checkout);
  const env = { ...f.env, ...f.event, GITHUB_REPOSITORY: 'synthetic/example', GITHUB_OUTPUT: path.join(f.root, 'output') };
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: checkout, env, encoding: 'utf8' });
  const localGit = (...args) => {
    const result = spawnSync('git', args, { cwd: checkout, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const head = localGit('rev-parse', 'HEAD');
  assert.equal(run(['classify']).status, 0);
  assert.equal(await fs.readFile(env.GITHUB_OUTPUT, 'utf8'), 'mode=candidate\n');
  assert.equal(localGit('rev-list', '--count', 'HEAD'), '1', 'classification must not deepen source history');
  assert.equal(localGit('tag', '--list'), '');
  const history = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {fetchCheckHistory,packageOnlyChange} from ${JSON.stringify(pathToFileURL(cli).href)};
     fetchCheckHistory(process.cwd(), process.env);
     if (!packageOnlyChange(process.cwd(), process.env)) process.exit(1);`], { cwd: checkout, env, encoding: 'utf8' });
  assert.equal(history.status, 0, history.stderr);
  assert.equal(localGit('rev-parse', 'HEAD'), head);
  assert.equal(localGit('rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(localGit('tag', '--list'), '');
  assert.notEqual(spawnSync('git', ['-c', 'remote.origin.promisor=false', 'cat-file', '-e', unrelated],
    { cwd: checkout, env: { ...f.env, GIT_NO_LAZY_FETCH: '1' } }).status, 0);
  const selected = run(['select', '--fetch']);
  assert.equal(selected.status, 1);
  assert.match(selected.stderr, /Release provenance refused: the tag commit is not in the CI base history/);
  assert.equal(localGit('tag', '--list'), 'v1.2.3', 'fetch only the selected release tag');
  assert.equal(await fs.readFile(env.GITHUB_OUTPUT, 'utf8'), 'mode=candidate\n', 'failed verification cannot emit packages');
  assert.equal(localGit('rev-parse', 'HEAD'), head);

  // An ordinary source diff needs the base tree but neither ancestry nor npm.
  await f.write('source.mjs', 'export const synthetic = true;'); f.commit();
  const fullCheckout = path.join(f.root, 'source-shallow');
  f.git('clone', '--no-tags', '--depth=1', '--branch=main', pathToFileURL(f.cwd).href, fullCheckout);
  const full = spawnSync(process.execPath, [cli, 'classify'],
    { cwd: fullCheckout, env: { ...env, GITHUB_OUTPUT: path.join(f.root, 'full-output') }, encoding: 'utf8' });
  assert.equal(full.status, 0, full.stderr);
  assert.equal(await fs.readFile(path.join(f.root, 'full-output'), 'utf8'), 'mode=full\n');
  assert.equal(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: fullCheckout, env: f.env, encoding: 'utf8' }).stdout.trim(), '1');
});

test('gate and ineligible-event classification work without npm dependencies or a Git checkout', async t => {
  const f = await fixture(t), cli = await isolatedCiTools(f);
  const directory = path.dirname(cli);
  const needs = { scope: { result: 'success', outputs: { mode: 'packages' } },
    test: { result: 'success' }, 'client-smoke': { result: 'success' } };
  const run = (args, event) => spawnSync(process.execPath, [cli, ...args],
    { cwd: directory, env: { ...f.env, ...event }, encoding: 'utf8' });
  assert.equal(run(['gate'], { CI_NEEDS: JSON.stringify(needs) }).status, 0);
  needs['client-smoke'].result = 'failure';
  assert.match(run(['gate'], { CI_NEEDS: JSON.stringify(needs) }).stderr, /client registration/);
  for (const event of [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }]) {
    const classified = run(['classify'], event);
    assert.equal(classified.status, 0, classified.stderr);
    assert.match(classified.stdout, /Full source checks required/);
  }
});

test('maintenance command transport preserves binary input and enforces status and output bounds', () => {
  const bytes = Buffer.from([0, 128, 255, 10]);
  assert.deepEqual(repositoryCommand(source, process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'],
    { input: bytes, encoding: null }).stdout, bytes);
  assert.equal(repositoryCommand(source, process.execPath, ['-e', 'process.exit(1)'], { allowedStatuses: [0, 1] }).status, 1);
  assert.throws(() => repositoryCommand(source, process.execPath, ['-e', 'process.exit(1)']), /exit status 1/);
  assert.throws(() => repositoryCommand(source, process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(65536))'],
    { encoding: null, maxBuffer: 1024 }), /ENOBUFS/);
});

test('release asset preflight rejects missing, duplicate, incomplete and oversized metadata', () => {
  const release = { assets: [
    { id: 1, name: 'cuefluent-notes-1.2.3-marketplace.tar.gz', size: 4096, state: 'uploaded' },
    { id: 2, name: 'SHA256SUMS', size: 256, state: 'uploaded' },
  ] };
  assert.deepEqual(releaseAssets(release, '1.2.3').map(asset => asset.id), [1, 2]);
  for (const assets of [[], release.assets.slice(1), [...release.assets, release.assets[0]], null]) {
    assert.throws(() => releaseAssets({ assets }, '1.2.3'), /published asset/);
  }
  for (const index of [0, 1]) for (const patch of [{ size: -1 }, { size: 0 }, { size: 1.5 },
    { size: index === 0 ? 128 * 1024 * 1024 + 1 : 65537 }, { state: 'new' }, { id: '../escape' }, { id: 0 }]) {
    const invalid = structuredClone(release); Object.assign(invalid.assets[index], patch);
    assert.throws(() => releaseAssets(invalid, '1.2.3'), /published asset/);
  }
});

test('release-run artifact selection requires bounded retained evidence from the exact run', () => {
  const run = { id: 123, head_sha: 'a'.repeat(40), head_branch: 'v1.2.3' };
  const artifact = { id: 456, name: 'release-preview-ubuntu-24.04', size_in_bytes: 4096,
    digest: `sha256:${'b'.repeat(64)}`, expired: false, workflow_run: run };
  const list = { total_count: 1, artifacts: [artifact] };
  assert.equal(releaseRunArtifact(list, run), artifact);
  for (const invalid of [null, {}, { ...list, total_count: 2 }, { total_count: 0, artifacts: [] },
    { total_count: 2, artifacts: [artifact, artifact] }, { total_count: 101, artifacts: Array(101).fill(artifact) }]) {
    assert.throws(() => releaseRunArtifact(invalid, run), /artifact evidence|retained release artifact/);
  }
  for (const patch of [{ expired: true }, { id: 0 }, { id: '../escape' }, { size_in_bytes: 0 },
    { size_in_bytes: 128 * 1024 * 1024 + 1 }, { digest: null }, { digest: 'sha256:invalid' },
    { name: 'release-preview-windows-2025' }, { workflow_run: { ...run, id: 999 } },
    { workflow_run: { ...run, head_sha: 'c'.repeat(40) } }, { workflow_run: { ...run, head_branch: 'main' } }]) {
    assert.throws(() => releaseRunArtifact({ ...list, artifacts: [{ ...artifact, ...patch }] }, run), /retained release artifact/);
  }
});

test('published checksums must match the digest-verified run artifact, even after consistent asset replacement', async () => {
  const original = Buffer.from('original release snapshot'), replacement = Buffer.from('replacement snapshot');
  const sums = sumsFor(original), changedSums = sumsFor(replacement);
  const zip = entries => Buffer.from(zipSync(entries));
  const archive = zip({ SHA256SUMS: sums, 'ignored-package.zip': Buffer.alloc(1024 * 1024) });
  const metadata = bytes => ({ size_in_bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  await verifyRunArtifactSums(archive, metadata(archive), sums);
  await assert.rejects(verifyRunArtifactSums(archive, metadata(archive), changedSums), /Published checksums differ/);
  const changedArchive = zip({ SHA256SUMS: changedSums });
  await assert.rejects(verifyRunArtifactSums(changedArchive, metadata(archive), changedSums), /size or digest mismatch/);
  await assert.rejects(verifyRunArtifactSums(archive, { ...metadata(archive), digest: `sha256:${'0'.repeat(64)}` }, sums), /size or digest mismatch/);
  for (const entries of [{}, { 'nested/SHA256SUMS': sums }, { SHA256SUMS: Buffer.alloc(65537) }]) {
    const invalid = zip(entries);
    await assert.rejects(verifyRunArtifactSums(invalid, metadata(invalid), sums), /checksum/);
  }
  const duplicate = zip({ SHA256SUMS: sums, SHA256SUMX: sums });
  for (let index = duplicate.indexOf('SHA256SUMX'); index !== -1; index = duplicate.indexOf('SHA256SUMX')) {
    duplicate.write('SHA256SUMS', index);
  }
  await assert.rejects(verifyRunArtifactSums(duplicate, metadata(duplicate), sums), /Invalid release-run checksum entry/);
});

test('complete Git diff classification is conservative across events, deletions and renames', async t => {
  const f = await fixture(t);
  const eligible = event => packageOnlyChange(f.cwd, event ?? f.event);
  assert.equal(eligible(), false, 'Empty PR must not skip tests.');
  for (const name of ['release.json', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
    'plugins/cuefluent-notes/file.md', 'claude/cuefluent-notes/file.md']) await f.write(name);
  f.commit();
  assert.equal(eligible(), true);
  assert.equal(eligible({ ...f.event, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }), true);
  for (const event of [
    { ...f.event, CI_BASE_REF: 'other' }, { ...f.event, CI_BASE_SHA: '0'.repeat(40) },
    { ...f.event, CI_BASE_SHA: 'HEAD^' }, { ...f.event, GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { ...f.event, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.0.0' },
    { ...f.event, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/other' },
  ]) assert.equal(eligible(event), false);
  const packages = f.git('rev-parse', 'HEAD');
  for (const name of ['scripts/runtime.mjs', 'package-lock.json', '.github/workflows/ci.yml',
    'README.md', '.agents/plugins/other.json', 'plugins/cuefluent-notes-other/file.md']) {
    f.git('reset', '--hard', packages);
    await f.write(name, 'Source edit.'); f.commit();
    assert.equal(eligible(), false, name);
  }
  f.git('reset', '--hard', packages);
  f.git('mv', 'README.md', 'plugins/cuefluent-notes/moved.md'); f.commit();
  assert.equal(eligible(), false, 'A source deletion hidden in a rename must require full CI.');
  f.git('reset', '--hard', packages);
  f.git('rm', 'README.md'); f.commit();
  assert.equal(eligible(), false);
  f.git('reset', '--hard', packages);
  f.git('rm', 'plugins/cuefluent-notes/file.md'); f.commit();
  assert.equal(eligible(), true, 'Package deletions still require exact release verification.');
  assert.throws(() => eligible({ ...f.event, CI_BASE_SHA: 'f'.repeat(40) }), /git failed/);
});

test('a rewritten push base selects full checks without reading release evidence', async t => {
  const f = await fixture(t);
  await f.write('plugins/cuefluent-notes/file.md', 'Before rewrite.');
  const previous = f.commit();
  f.git('reset', '--hard', f.base);
  await f.write('plugins/cuefluent-notes/file.md', 'After rewrite.');
  f.commit();
  const event = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', CI_BASE_SHA: previous };
  const unexpectedRead = async () => assert.fail('Full checks must not need release evidence.');
  assert.equal(packageOnlyChange(f.cwd, event), false);
  assert.equal(await selectChecks(f.cwd, event, unexpectedRead), 'full');
  await f.write('scripts/runtime.mjs', 'Source change after rewrite.'); f.commit();
  assert.equal(await selectChecks(f.cwd, event, unexpectedRead), 'full');
  const output = path.join(f.root, 'github-output');
  const selected = spawnSync(process.execPath, [path.join(source, 'scripts/marketplace-ci.mjs'), 'select'],
    { cwd: f.cwd, env: { ...f.env, ...event, GITHUB_OUTPUT: output }, encoding: 'utf8' });
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), 'mode=full\n');
});

test('package path compares exact published files, never a self-asserted inventory', async t => {
  const f = await fixture(t);
  const built = await buildRelease({ outDir: path.join(f.root, 'release') });
  for (const name of MARKETPLACE_PATHS) {
    await fs.mkdir(path.dirname(path.join(f.cwd, name)), { recursive: true });
    await fs.cp(path.join(built.outDir, name), path.join(f.cwd, name), { recursive: true });
  }
  const candidate = f.commit();
  const assets = { version: built.version,
    snapshot: await fs.readFile(path.join(built.outDir, 'artifacts', built.marketplaceArchive)),
    sums: await fs.readFile(path.join(built.outDir, 'artifacts/SHA256SUMS')) };
  let reads = 0;
  const load = async (_cwd, _env, version) => { reads++; assert.equal(version, built.version); return assets; };
  assert.equal(await selectChecks(f.cwd, f.event, load), 'packages');
  assert.equal(reads, 1);
  assert.equal(await selectChecks(f.cwd, { ...f.event, GITHUB_EVENT_NAME: 'workflow_dispatch' }, load), 'full');
  assert.equal(reads, 1, 'Full CI should not require release/network access.');
  await assert.rejects(selectChecks(f.cwd, f.event, async () => { throw new Error('Release unavailable'); }), /Release unavailable/);
  for (const name of ['.agents/plugins/marketplace.json', 'release.json',
    'plugins/cuefluent-notes/package-inventory.json', 'claude/cuefluent-notes/README.md']) {
    f.git('reset', '--hard', candidate);
    await fs.appendFile(path.join(f.cwd, name), '\n'); f.commit();
    await assert.rejects(verifyPublishedTree(f.cwd, assets), /differs from the published release/);
  }
  f.git('reset', '--hard', candidate);
  await f.write('plugins/cuefluent-notes/unexpected.md'); f.commit();
  await assert.rejects(verifyPublishedTree(f.cwd, assets), /differs/);
  f.git('reset', '--hard', candidate);
  f.git('rm', 'claude/cuefluent-notes/README.md'); f.commit();
  await assert.rejects(verifyPublishedTree(f.cwd, assets), /differs/);
  for (const mode of ['100755', '120000']) {
    f.git('reset', '--hard', candidate);
    const name = 'plugins/cuefluent-notes/README.md';
    const blob = f.git('rev-parse', `${candidate}:${name}`);
    f.git('update-index', '--cacheinfo', `${mode},${blob},${name}`);
    f.git('commit', '-m', 'test: nonportable mode');
    await assert.rejects(verifyPublishedTree(f.cwd, assets), /Nonportable marketplace/);
  }
  f.git('reset', '--hard', candidate);
  const tabbed = 'plugins/cuefluent-notes/README.md';
  const blob = f.git('rev-parse', `${candidate}:${tabbed}`);
  f.git('update-index', '--force-remove', tabbed);
  // Build the malicious tree only in Git's index; no illegal Windows filename
  // is ever created in the filesystem.
  f.git('-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},${tabbed}\thidden`);
  f.git('commit', '-m', 'test: tab in tracked package path');
  assert.throws(() => marketplaceTreeFiles(f.cwd, 'HEAD'), /Nonportable marketplace/,
    'The complete tabbed filename must be rejected, not truncated to a published name.');
  assert.throws(() => marketplaceTreeFiles(f.cwd, 'HEAD'), error =>
    error.message.includes(JSON.stringify(`${tabbed}\thidden`)) && !error.message.includes('\t'),
  'Report the offending path with controls escaped.');
  await assert.rejects(verifyPublishedTree(f.cwd, assets), /Nonportable marketplace/);
  f.git('read-tree', candidate); // Drop the deliberately uncheckoutable entry.
  f.git('reset', '--hard', candidate);
  await fs.appendFile(path.join(f.cwd, 'plugins/cuefluent-notes/README.md'), '\n'); f.commit();
  const policyEvent = { ...f.event, CI_BASE_SHA: candidate };
  const policyRefusal = async pattern => {
    const before = reads;
    await assert.rejects(selectChecks(f.cwd, policyEvent, load), pattern);
    assert.equal(reads, before, 'Policy refusal must precede release downloads.');
    const output = path.join(f.root, 'refused-output');
    const selected = spawnSync(process.execPath, [path.join(source, 'scripts/marketplace-ci.mjs'), 'select'],
      { cwd: f.cwd, env: { ...f.env, ...policyEvent, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    assert.equal(selected.status, 1);
    assert.match(selected.stderr, pattern);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' }, 'A refusal must not emit a passing CI mode.');
  };
  await policyRefusal(/Marketplace release policy:.*immutable.*newer published version/);
  f.git('reset', '--hard', candidate);
  const replaced = JSON.parse(await fs.readFile(path.join(f.cwd, 'release.json'), 'utf8'));
  replaced.archives[0].sha256 = '0'.repeat(64);
  await f.write('release.json', JSON.stringify(replaced)); f.commit();
  await policyRefusal(/Marketplace release policy:.*replace an existing version/);
  f.git('reset', '--hard', candidate);
  const older = JSON.parse(await fs.readFile(path.join(f.cwd, 'release.json'), 'utf8'));
  older.version = '0.0.0'; await f.write('release.json', JSON.stringify(older)); f.commit();
  await policyRefusal(/Marketplace release policy:.*downgrade/);
});

test('published stable identity and exact successful tag run are mandatory', () => {
  const commit = 'a'.repeat(40), tag = 'v1.2.3';
  const release = { tag_name: tag, draft: false, prerelease: false, published_at: '2020-01-01T00:00:00Z' };
  const run = { id: 123, head_sha: commit, head_branch: tag, path: '.github/workflows/release.yml',
    event: 'push', status: 'completed', conclusion: 'success' };
  const evidence = { release, runs: { workflow_runs: [run] }, tag, commit };
  const workflowPaths = [run.path, `${run.path}@main`, `${run.path}@${tag}`,
    `${run.path}@refs/tags/${tag}`, `${run.path}@${commit}`];
  for (const workflowPath of workflowPaths) {
    verifyReleaseEvidence({ ...evidence, runs: { workflow_runs: [{ ...run, path: workflowPath }] } });
    for (const patch of [{ id: 0 }, { id: undefined }, { head_sha: 'b'.repeat(40) }, { head_branch: 'main' },
      { event: 'workflow_dispatch' }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
      assert.throws(() => verifyReleaseEvidence({ ...evidence,
        runs: { workflow_runs: [{ ...run, path: workflowPath, ...patch }] } }), /No successful/);
    }
  }
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.2.4' }, { published_at: null }]) {
    assert.throws(() => verifyReleaseEvidence({ ...evidence, release: { ...release, ...patch } }), /published stable/);
  }
  for (const workflowPath of ['.github/workflows/other.yml', '.github/workflows/other.yml@main',
    `${run.path}.bak@main`, `other/repository/${run.path}@main`, `other.yml@${run.path}`,
    '', undefined, null, 42]) {
    assert.throws(() => verifyReleaseEvidence({ ...evidence,
      runs: { workflow_runs: [{ ...run, path: workflowPath }] } }), /No successful/);
  }
  assert.throws(() => verifyReleaseEvidence({ ...evidence, runs: { workflow_runs: [] } }), /No successful/);
});

const sumsFor = snapshot => Buffer.from(`${createHash('sha256').update(snapshot).digest('hex')}  cuefluent-notes-1.2.3-marketplace.tar.gz\n`);
test('snapshot checksum, entry ownership, duplicate and link checks happen before package execution', async () => {
  const valid = [{ name: 'README.md', bytes: Buffer.from('Archive only') },
    { name: 'release.json', bytes: Buffer.from('{}') }];
  const snapshot = await marketplaceTar(valid);
  for (const file of valid) assert.equal(isMarketplaceSnapshotFile(file.name), true);
  assert.equal(isMarketplaceSnapshotFile('.github/workflows/ci.yml'), false);
  assert.deepEqual(await snapshotFiles(snapshot, sumsFor(snapshot), '1.2.3'), valid.slice(1));
  for (const sums of [Buffer.alloc(0), Buffer.concat([sumsFor(snapshot), sumsFor(snapshot)]),
    Buffer.from(`${'0'.repeat(64)}  cuefluent-notes-1.2.3-marketplace.tar.gz\n`), Buffer.from('Invalid\n')]) {
    await assert.rejects(snapshotFiles(snapshot, sums, '1.2.3'), /checksum/);
  }
  for (const name of ['../escape', 'plugins/cuefluent-notes/../../escape', '.github/workflows/ci.yml',
    '/absolute', 'plugins/cuefluent-notes/linked\\name', 'release.json']) {
    const bytes = await marketplaceTar([...valid, { name, bytes: Buffer.from('extra') }]);
    await assert.rejects(snapshotFiles(bytes, sumsFor(bytes), '1.2.3'), /Unsafe or unexpected/);
  }
  const pack = tar.pack(), chunks = [];
  const finished = new Promise((resolve, reject) => { pack.on('data', chunk => chunks.push(chunk)); pack.on('end', resolve); pack.on('error', reject); });
  pack.entry({ name: 'plugins/cuefluent-notes/link', type: 'symlink', linkname: '/outside' }); pack.finalize();
  await finished;
  const linked = gzipSync(Buffer.concat(chunks));
  await assert.rejects(snapshotFiles(linked, sumsFor(linked), '1.2.3'), /Unsafe or unexpected/);
});

test('required result gate refuses failure, cancellation, missing modes and unjustified skips', () => {
  const needs = (mode, scope = 'success', result = 'success', smoke = 'success') =>
    ({ scope: { result: scope, outputs: { mode } }, test: { result }, 'client-smoke': { result: smoke } });
  assert.equal(verifyCheckResults(needs('full')), 'full');
  assert.equal(verifyCheckResults(needs('packages')), 'packages');
  for (const mode of ['full', 'packages', '', 'unknown']) {
    for (const scope of ['failure', 'cancelled', 'skipped', '']) assert.throws(() => verifyCheckResults(needs(mode, scope)));
    for (const result of ['failure', 'cancelled', '']) assert.throws(() => verifyCheckResults(needs(mode, 'success', result)));
  }
  assert.throws(() => verifyCheckResults(needs('full', 'success', 'skipped')));
  assert.throws(() => verifyCheckResults(needs('packages', 'success', 'skipped')));
  for (const mode of ['full', 'packages']) for (const smoke of ['failure', 'cancelled', 'skipped', '']) {
    assert.throws(() => verifyCheckResults(needs(mode, 'success', 'success', smoke)), /client registration/);
  }
  assert.equal(verifyCheckResults(needs('full', 'success', 'success', 'skipped'), 'refs/tags/v1.2.3'), 'full');
  assert.throws(() => verifyCheckResults(needs('packages', 'success', 'success', 'skipped'), 'refs/tags/v1.2.3'));
  assert.throws(() => verifyCheckResults(needs('full', 'success', 'success', 'failure'), 'refs/tags/v1.2.3'));
  assert.throws(() => verifyCheckResults({}));
});

test('workflow preserves required checks and gates short-path smokes on provenance', async () => {
  const workflow = YAML.parse(await fs.readFile(path.join(source, '.github/workflows/ci.yml'), 'utf8'));
  const jobs = workflow.jobs;
  assert.deepEqual(jobs.reproducibility.needs, ['scope', 'test', 'client-smoke']);
  assert.equal(jobs.reproducibility.if, '${{ always() }}');
  assert.ok(jobs.reproducibility.steps.some(step => step.run === 'node scripts/marketplace-ci.mjs gate' && step.env.CI_NEEDS === '${{ toJSON(needs) }}'));
  assert.equal(jobs.test.needs, 'scope'); assert.equal(jobs['client-smoke'].needs, 'scope');
  assert.equal(jobs.test.if, undefined, 'Required matrix context names must exist on both paths.');
  assert.equal(jobs.test.name, "test (${{ matrix.os }}${{ matrix.shard == '2/2' && ', 2/2' || '' }})");
  // macOS and Windows run as two halves; the first keeps the required context name.
  const legs = jobs.test.strategy.matrix.include;
  assert.deepEqual(legs, [{ os: 'ubuntu-24.04', shard: '' }, { os: 'macos-14', shard: '1/2' }, { os: 'macos-14', shard: '2/2' },
    { os: 'windows-2025', shard: '1/2' }, { os: 'windows-2025', shard: '2/2' }]);
  assert.deepEqual(legs.map(leg => `test (${leg.os}${leg.shard === '2/2' ? ', 2/2' : ''})`),
    ['test (ubuntu-24.04)', 'test (macos-14)', 'test (macos-14, 2/2)', 'test (windows-2025)', 'test (windows-2025, 2/2)']);
  for (const name of ['Run tests', 'Run Windows tests']) assert.equal(jobs.test.steps.find(step => step.name === name).env.CUEFLUENT_TEST_SHARD, '${{ matrix.shard }}');
  // Only the first half builds and uploads the Windows release preview.
  for (const step of jobs.test.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@') || step.run === 'npm run release:build')) {
    assert.match(step.if, / && matrix.shard != '2\/2'$/);
  }
  assert.equal(jobs.test['runs-on'], '${{ matrix.os }}', 'Required platform checks must run on their named OS.');
  assert.match(jobs.test['timeout-minutes'], /^\$\{\{ needs.scope.outputs.mode == 'packages' && 10 \|\|/);
  const packageStep = jobs.test.steps.findIndex(step => step.run === 'node --test scripts/published-marketplace.test.mjs');
  assert.ok(packageStep > 0, 'The short path must run actual package tests, not an echo acknowledgement.');
  assert.equal(jobs.test.steps[packageStep].if, "needs.scope.outputs.mode == 'packages' && matrix.shard != '2/2'");
  for (const step of jobs.test.steps.slice(0, packageStep)) assert.equal(step.if, undefined, 'Both paths need native setup.');
  for (const step of jobs.test.steps.slice(packageStep + 1)) assert.match(step.if, /^needs.scope.outputs.mode == 'full'/);
  assert.deepEqual(jobs['client-smoke'].strategy.matrix.os, ['macos-14', 'windows-2025']);
  const select = jobs.scope.steps.find(step => step.id === 'select');
  assert.equal(select.run, 'node scripts/marketplace-ci.mjs select --fetch');
  assert.equal(select.if, "steps.classify.outputs.mode == 'candidate'");
  assert.equal(jobs.scope.env.CI_BASE_SHA, '${{ github.event.pull_request.base.sha || github.event.before }}');
  assert.equal(jobs.scope.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 1);
  assert.equal(jobs.scope.steps.find(step => step.run === 'npm ci --ignore-scripts').if, "steps.classify.outputs.mode == 'candidate'");
  assert.equal(jobs.scope.outputs.mode, '${{ steps.select.outputs.mode || steps.classify.outputs.mode }}');
  assert.ok(!jobs.reproducibility.steps.some(step => step.run?.includes('npm ')), 'The gate needs no npm dependencies.');
  for (const step of jobs.reproducibility.steps.filter(step => step.uses?.startsWith('actions/download-artifact@') || step.run?.includes('diff -u'))) {
    assert.equal(step.if, "needs.scope.outputs.mode == 'full'");
  }
  assert.equal(jobs['client-smoke'].steps.at(-1).env.CI_CHECK_MODE, '${{ needs.scope.outputs.mode }}');
  const release = YAML.parse(await fs.readFile(path.join(source, '.github/workflows/release.yml'), 'utf8'));
  assert.equal(release.jobs.checks.permissions.actions, 'read', 'Reusable workflows cannot elevate caller token permissions.');
  assert.equal(jobs.scope.permissions.actions, 'read');
});
