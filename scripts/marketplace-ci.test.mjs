import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import YAML from 'yaml';
import { smokeEnvironment } from './smoke-environment.mjs';
import { buildRelease } from './release.mjs';
import { marketplaceTar } from './release-archives.mjs';
import { MARKETPLACE_PATHS } from './marketplace-layout.mjs';
import { marketplaceTreeFiles } from './marketplace-content.mjs';
import { packageOnlyChange, selectChecks, snapshotFiles, verifyCheckResults,
  verifyReleaseEvidence, verifyPublishedTree } from './marketplace-ci.mjs';

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
  const run = { head_sha: commit, head_branch: tag, path: '.github/workflows/release.yml',
    event: 'push', status: 'completed', conclusion: 'success' };
  const evidence = { release, runs: { workflow_runs: [run] }, tag, commit };
  verifyReleaseEvidence(evidence);
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.2.4' }, { published_at: null }]) {
    assert.throws(() => verifyReleaseEvidence({ ...evidence, release: { ...release, ...patch } }), /published stable/);
  }
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { path: '.github/workflows/other.yml' },
    { event: 'workflow_dispatch' }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    assert.throws(() => verifyReleaseEvidence({ ...evidence, runs: { workflow_runs: [{ ...run, ...patch }] } }), /No successful/);
  }
  assert.throws(() => verifyReleaseEvidence({ ...evidence, runs: { workflow_runs: [] } }), /No successful/);
});

const sumsFor = snapshot => Buffer.from(`${createHash('sha256').update(snapshot).digest('hex')}  cuefluent-notes-1.2.3-marketplace.tar.gz\n`);
test('snapshot checksum, entry ownership, duplicate and link checks happen before package execution', async () => {
  const valid = [{ name: 'README.md', bytes: Buffer.from('Archive only') },
    { name: 'release.json', bytes: Buffer.from('{}') }];
  const snapshot = await marketplaceTar(valid);
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
  const needs = (mode, scope = 'success', result = 'success') =>
    ({ scope: { result: scope, outputs: { mode } }, test: { result } });
  assert.equal(verifyCheckResults(needs('full')), 'full');
  assert.equal(verifyCheckResults(needs('packages')), 'packages');
  for (const mode of ['full', 'packages', '', 'unknown']) {
    for (const scope of ['failure', 'cancelled', 'skipped', '']) assert.throws(() => verifyCheckResults(needs(mode, scope)));
    for (const result of ['failure', 'cancelled', '']) assert.throws(() => verifyCheckResults(needs(mode, 'success', result)));
  }
  assert.throws(() => verifyCheckResults(needs('full', 'success', 'skipped')));
  assert.throws(() => verifyCheckResults(needs('packages', 'success', 'skipped')));
  assert.throws(() => verifyCheckResults({}));
});

test('workflow preserves required checks and gates short-path smokes on provenance', async () => {
  const workflow = YAML.parse(await fs.readFile(path.join(source, '.github/workflows/ci.yml'), 'utf8'));
  const jobs = workflow.jobs;
  assert.deepEqual(jobs.reproducibility.needs, ['scope', 'test']);
  assert.equal(jobs.reproducibility.if, '${{ always() }}');
  assert.ok(jobs.reproducibility.steps.some(step => step.run === 'node scripts/marketplace-ci.mjs gate' && step.env.CI_NEEDS === '${{ toJSON(needs) }}'));
  assert.equal(jobs.test.needs, 'scope'); assert.equal(jobs['client-smoke'].needs, 'scope');
  assert.equal(jobs.test.if, undefined, 'Required matrix context names must exist on both paths.');
  assert.equal(jobs.test.name, 'test (${{ matrix.os }})');
  assert.equal(jobs.test['runs-on'], '${{ matrix.os }}', 'Required platform checks must run on their named OS.');
  assert.match(jobs.test['timeout-minutes'], /^\$\{\{ needs.scope.outputs.mode == 'packages' && 5 \|\|/);
  const packageStep = jobs.test.steps.findIndex(step => step.run === 'node --test scripts/published-marketplace.test.mjs');
  assert.ok(packageStep > 0, 'The short path must run actual package tests, not an echo acknowledgement.');
  assert.equal(jobs.test.steps[packageStep].if, "needs.scope.outputs.mode == 'packages'");
  for (const step of jobs.test.steps.slice(0, packageStep)) assert.equal(step.if, undefined, 'Both paths need native setup.');
  for (const step of jobs.test.steps.slice(packageStep + 1)) assert.match(step.if, /^needs.scope.outputs.mode == 'full'/);
  assert.deepEqual(jobs.test.strategy.matrix.os, ['ubuntu-24.04', 'macos-14', 'windows-2025']);
  assert.deepEqual(jobs['client-smoke'].strategy.matrix.os, ['macos-14', 'windows-2025']);
  const select = jobs.scope.steps.find(step => step.id === 'select');
  assert.equal(select.run, 'node scripts/marketplace-ci.mjs select');
  assert.equal(select.env.CI_BASE_SHA, '${{ github.event.pull_request.base.sha || github.event.before }}');
  assert.equal(jobs.scope.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0);
  for (const step of jobs.reproducibility.steps.filter(step => step.uses?.startsWith('actions/download-artifact@') || step.run?.includes('diff -u'))) {
    assert.equal(step.if, "needs.scope.outputs.mode == 'full'");
  }
  assert.equal(jobs['client-smoke'].steps.at(-1).env.CI_CHECK_MODE, '${{ needs.scope.outputs.mode }}');
  const release = YAML.parse(await fs.readFile(path.join(source, '.github/workflows/release.yml'), 'utf8'));
  assert.equal(release.jobs.checks.permissions.actions, 'read', 'Reusable workflows cannot elevate caller token permissions.');
  assert.equal(jobs.scope.permissions.actions, 'read');
});
