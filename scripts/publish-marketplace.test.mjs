import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRelease } from './release.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
test('publisher creates only the snapshot branch, retries without a commit, and removes stale files on advance', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-publish-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const remote = path.join(root, 'remote.git');
  const temp = path.join(root, 'runner');
  await fs.mkdir(checkout);
  await fs.mkdir(temp);
  const run = (cmd, args, options = {}) => {
    const result = spawnSync(cmd, args, { cwd: checkout, encoding: 'utf8', ...options });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const git = (...args) => run('git', ['-c', 'commit.gpgsign=false', ...args]);
  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Synthetic Publisher');
  git('config', 'user.email', 'publisher@example.invalid');
  await fs.writeFile(path.join(checkout, 'source-only.txt'), 'Never publish source in the marketplace.');
  await fs.mkdir(path.join(checkout, 'scripts'));
  for (const file of ['release-policy.mjs', 'file-io.mjs', 'publish-marketplace.sh']) await fs.copyFile(path.join(source, file), path.join(checkout, 'scripts', file));
  git('add', '.');
  git('commit', '-m', 'Synthetic source');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  const initial = git('rev-parse', 'HEAD');
  const built = await buildRelease({ outDir: path.join(root, 'built') });
  const snapshot = path.join(checkout, 'dist/published-marketplace');
  await fs.mkdir(snapshot, { recursive: true });
  run('tar', ['-xzf', path.join(built.outDir, 'artifacts', built.marketplaceArchive), '-C', snapshot]);
  // Future top-level additions must be published without editing the publisher.
  await fs.writeFile(path.join(snapshot, 'NOTICE'), 'Synthetic notice.');
  const publishOptions = version => ({
    cwd: checkout, encoding: 'utf8',
    env: { ...process.env, GITHUB_WORKSPACE: checkout, RUNNER_TEMP: temp, RELEASE_TAG: `v${version}` },
  });
  const publish = version => run('bash', ['scripts/publish-marketplace.sh'], publishOptions(version));
  publish(built.version);
  const first = git('--git-dir', remote, 'rev-parse', 'marketplace');
  const entries = git('--git-dir', remote, 'ls-tree', '--name-only', 'marketplace').split('\n');
  assert.deepEqual(entries, (await fs.readdir(snapshot)).sort());
  assert.match(publish(built.version), /already published/);
  assert.equal(git('--git-dir', remote, 'rev-parse', 'marketplace'), first);
  // The installed tree must be immutable even if ZIP metadata is unchanged.
  for (const relative of ['plugins/cuefluent-notes/skills/cuefluent-notes/scripts/check-notes.mjs', '.agents/plugins/marketplace.json', 'NOTICE']) {
    const file = path.join(snapshot, relative);
    const original = await fs.readFile(file);
    await fs.appendFile(file, '\n');
    const rejected = spawnSync('bash', ['scripts/publish-marketplace.sh'], publishOptions(built.version));
    assert.notEqual(rejected.status, 0, 'Changed same-version snapshot must be refused.');
    assert.match(rejected.stderr, /same version|same-version/);
    assert.equal(git('--git-dir', remote, 'rev-parse', 'marketplace'), first);
    await fs.writeFile(file, original);
  }
  assert.match(publish(built.version), /already published/);
  // Exercise an update using a new version and one removed runtime file.
  const release = JSON.parse(await fs.readFile(path.join(snapshot, 'release.json'), 'utf8'));
  const originalRelease = structuredClone(release);
  release.version = '999.0.0';
  await fs.writeFile(path.join(snapshot, 'release.json'), JSON.stringify(release));
  for (const [client, dir] of [['codex', 'plugins'], ['claude', 'claude']]) {
    const manifestPath = path.join(snapshot, dir, 'cuefluent-notes', `.${client}-plugin/plugin.json`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.version = release.version;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
  }
  await fs.rm(path.join(snapshot, 'plugins/cuefluent-notes/skills/cuefluent-notes/examples/decision.md'));
  publish(release.version);
  assert.equal(git('--git-dir', remote, 'rev-parse', 'marketplace^'), first);
  assert.equal(git('--git-dir', remote, 'ls-tree', '-r', '--name-only', 'marketplace', '--', 'plugins/cuefluent-notes/skills/cuefluent-notes/examples/decision.md'), '');
  const upgraded = git('--git-dir', remote, 'rev-parse', 'marketplace');
  await fs.writeFile(path.join(snapshot, 'release.json'), JSON.stringify(originalRelease));
  for (const [client, dir] of [['codex', 'plugins'], ['claude', 'claude']]) {
    const manifestPath = path.join(snapshot, dir, 'cuefluent-notes', `.${client}-plugin/plugin.json`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.version = built.version;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
  }
  const downgrade = spawnSync('bash', ['scripts/publish-marketplace.sh'], publishOptions(built.version));
  assert.notEqual(downgrade.status, 0);
  assert.match(downgrade.stderr, /downgrade/);
  assert.equal(git('--git-dir', remote, 'rev-parse', 'marketplace'), upgraded);
  assert.equal(git('rev-list', '--count', 'FETCH_HEAD'), '1', 'Only the marketplace tip should be fetched.');
  assert.equal(git('rev-parse', 'HEAD'), initial);
  assert.equal(git('diff', '--cached', '--name-only'), '');
  assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), initial);
});
