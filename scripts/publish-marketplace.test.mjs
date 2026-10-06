import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildRelease } from './release.mjs';
import { archiveFiles, pluginZip } from './release-archives.mjs';
import { MARKETPLACE_PLUGINS } from './marketplace-layout.mjs';
import { marketplaceTreeFiles, verifyMarketplaceFiles } from './marketplace-content.mjs';
import { smokeEnvironment } from './smoke-environment.mjs';
import { INVENTORY_FILE, withPackageInventory } from './package-integrity.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
test('publication branches preserve new main source, reject unexpected or transformed bytes, and never force concurrent changes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-publish-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const remote = path.join(root, 'remote.git');
  const temp = path.join(root, 'runner');
  await fs.mkdir(checkout); await fs.mkdir(temp);
  const env = { ...smokeEnvironment(root), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig') };
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, '');
  const run = (cmd, args, options = {}) => {
    const result = spawnSync(cmd, args, { cwd: checkout, env, encoding: 'utf8', ...options });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const git = (...args) => run('git', ['-c', 'commit.gpgsign=false', ...args]);
  const remoteGit = (...args) => git('--git-dir', remote, ...args);
  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Synthetic Publisher');
  git('config', 'user.email', 'publisher@example.invalid');
  const preserved = new Map([
    ['source-only.txt', 'Keep development source.'], ['README.md', 'Keep source documentation.'],
    ['.agents/plugins/other.json', 'Keep other catalogs.'], ['plugins/other/README.md', 'Keep other plugins.'],
  ]);
  for (const [name, bytes] of preserved) {
    await fs.mkdir(path.dirname(path.join(checkout, name)), { recursive: true });
    await fs.writeFile(path.join(checkout, name), bytes);
  }
  await fs.mkdir(path.join(checkout, 'scripts'));
  for (const file of ['release-policy.mjs', 'marketplace-layout.mjs', 'marketplace-content.mjs',
    'release-archives.mjs', 'file-io.mjs', 'publish-marketplace.sh', 'package-integrity.mjs', 'plugin-manifest.mjs', 'workflow-values.mjs']) {
    await fs.copyFile(path.join(source, file), path.join(checkout, 'scripts', file));
  }
  await fs.writeFile(path.join(checkout, '.gitignore'), 'node_modules/\ndist/\n');
  git('add', '.'); git('commit', '-m', 'chore: seed synthetic source');
  // The publisher uses locked build libraries, like its CI job; no CLI downloads.
  await fs.cp(path.join(source, '../node_modules'), path.join(checkout, 'node_modules'), { recursive: true });
  git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  const initial = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(checkout, 'source-only.txt'), 'Staged local edit.');
  git('add', 'source-only.txt');
  await fs.appendFile(path.join(checkout, 'source-only.txt'), ' Unstaged local edit.');
  const indexBefore = git('diff', '--cached'), workBefore = git('diff');
  const built = await buildRelease({ outDir: path.join(root, 'built') });
  const snapshot = path.join(checkout, 'dist/published-marketplace');
  await fs.mkdir(snapshot, { recursive: true });
  run('tar', ['-xzf', path.join(built.outDir, 'artifacts', built.marketplaceArchive), '-C', snapshot]);
  const options = version => ({ env: { ...env, GITHUB_WORKSPACE: checkout, RUNNER_TEMP: temp, GITHUB_OUTPUT: path.join(temp, 'outputs'), RELEASE_TAG: `v${version}` } });
  const publish = version => run('bash', ['scripts/publish-marketplace.sh'], options(version));
  const reject = (version, pattern) => {
    const result = spawnSync('bash', ['scripts/publish-marketplace.sh'], { cwd: checkout, encoding: 'utf8', ...options(version) });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, pattern);
  };
  const checkPreserved = ref => {
    for (const [name, bytes] of preserved) assert.equal(remoteGit('show', `${ref}:${name}`), bytes);
  };
  const branch = version => `chore/publish-v${version}`;
  const changeSource = (parent, name, bytes) => {
    const changedEnv = { ...env, GIT_INDEX_FILE: path.join(temp, 'source.index') };
    const g = (...args) => run('git', ['-c', 'commit.gpgsign=false', ...args], { env: changedEnv });
    g('read-tree', parent);
    const blob = run('git', ['hash-object', '-w', '--stdin'], { env: changedEnv, input: bytes });
    g('update-index', '--add', '--cacheinfo', `100644,${blob},${name}`);
    return g('commit-tree', g('write-tree'), '-p', parent, '-m', 'fix: change source on main');
  };
  for (const name of ['LICENSE', 'other-package/plugin.json']) {
    const file = path.join(snapshot, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'Unexpected release content.');
    reject(built.version, /Unexpected marketplace snapshot entry/);
    await fs.rm(file);
    if (name.includes('/')) await fs.rmdir(path.dirname(file));
  }
  const damaged = path.join(snapshot, 'plugins/cuefluent-notes/README.md');
  const original = await fs.readFile(damaged);
  await fs.appendFile(damaged, '\nModified package.');
  reject(built.version, /does not match.*digest/);
  await fs.writeFile(damaged, original);
  publish(built.version);
  const first = remoteGit('rev-parse', branch(built.version));
  assert.equal(await fs.readFile(path.join(temp, 'outputs'), 'utf8'),
    `changed=true\nbranch=${branch(built.version)}\ncommit=${first}\n`);
  assert.equal(remoteGit('rev-parse', 'main'), initial, 'Publication must only prepare a PR branch.');
  assert.equal(remoteGit('rev-parse', `${branch(built.version)}^`), initial);
  checkPreserved(branch(built.version));
  verifyMarketplaceFiles(marketplaceTreeFiles(checkout, first));
  publish(built.version);
  assert.equal(remoteGit('rev-parse', branch(built.version)), first, 'Identical retry reuses its existing review branch.');
  const reviewEdit = changeSource(first, 'review-only.txt', 'An edit made during review.');
  git('push', 'origin', `${reviewEdit}:refs/heads/${branch(built.version)}`);
  reject(built.version, /Publication branch differs/);
  assert.equal(remoteGit('rev-parse', branch(built.version)), reviewEdit);
  remoteGit('update-ref', `refs/heads/${branch(built.version)}`, first, reviewEdit);
  // Simulate the separately authorized merge in this disposable remote.
  remoteGit('update-ref', 'refs/heads/main', first, initial);
  assert.match(publish(built.version), /already published/);
  const catalog = path.join(snapshot, '.agents/plugins/marketplace.json');
  const catalogBytes = await fs.readFile(catalog);
  await fs.appendFile(catalog, '\n'); reject(built.version, /same version/);
  await fs.writeFile(catalog, catalogBytes);

  const intervening = changeSource(first, 'source-only.txt', 'A real main edit after the release tag.');
  preserved.set('source-only.txt', 'A real main edit after the release tag.');
  git('push', 'origin', `${intervening}:refs/heads/main`);
  assert.match(publish(built.version), /already published/, 'Stale HEAD staging must not undo intervening main edits.');
  checkPreserved('main');
  const release = JSON.parse(await fs.readFile(path.join(snapshot, 'release.json'), 'utf8'));
  const originalRelease = structuredClone(release);
  const setVersion = async version => {
    release.version = version;
    for (const { client, root: plugin } of MARKETPLACE_PLUGINS) {
      const file = path.join(snapshot, plugin, `.${client}-plugin/plugin.json`);
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.version = version; await fs.writeFile(file, JSON.stringify(manifest));
      const runtimePath = path.join(snapshot, plugin, 'skills/cuefluent-notes/package.json');
      const runtime = JSON.parse(await fs.readFile(runtimePath)); runtime.version = version;
      await fs.writeFile(runtimePath, JSON.stringify(runtime));
      const files = withPackageInventory(await archiveFiles(path.join(snapshot, plugin)), { client, version, withHooks: true });
      const inventory = files.find(f => f.name === INVENTORY_FILE).bytes;
      await fs.writeFile(path.join(snapshot, plugin, INVENTORY_FILE), inventory);
      const record = release.archives.find(a => a.client === client && a.variant === 'hooks');
      record.sha256 = createHash('sha256').update(pluginZip(files)).digest('hex');
      record.inventorySha256 = createHash('sha256').update(inventory).digest('hex');
    }
    await fs.writeFile(path.join(snapshot, 'release.json'), JSON.stringify(release));
  };
  const stale = 'plugins/cuefluent-notes/skills/cuefluent-notes/examples/decision.md';
  await fs.rm(path.join(snapshot, stale));
  await fs.rm(path.join(snapshot, stale.replace('plugins/', 'claude/')));
  await setVersion('999.0.0');
  const concurrent = changeSource(intervening, 'later-source.txt', 'A second real source change.');
  // A different push endpoint advertises a conflicting branch BEFORE push.
  // --force would overwrite it and make this test fail; no hooks or chmod needed.
  const pushRemote = path.join(root, 'push.git');
  git('clone', '--bare', remote, pushRemote);
  git('push', pushRemote, `${concurrent}:refs/heads/${branch(release.version)}`);
  git('config', 'remote.origin.pushurl', pushRemote);
  reject(release.version, /rejected/);
  assert.equal(git('--git-dir', pushRemote, 'rev-parse', branch(release.version)), concurrent);
  assert.equal(remoteGit('rev-parse', 'main'), intervening);
  git('config', '--unset-all', 'remote.origin.pushurl');
  git('push', 'origin', `${concurrent}:refs/heads/main`);
  preserved.set('later-source.txt', 'A second real source change.');
  publish(release.version);
  const upgraded = remoteGit('rev-parse', branch(release.version));
  assert.equal(remoteGit('rev-parse', `${branch(release.version)}^`), concurrent);
  checkPreserved(branch(release.version));
  assert.equal(remoteGit('ls-tree', '-r', '--name-only', branch(release.version), '--', stale), '');
  remoteGit('update-ref', 'refs/heads/main', upgraded, concurrent);
  // Check actual staged bytes, not just the intact snapshot before Git filters.
  const attributes = changeSource(upgraded, '.gitattributes', 'plugins/** text eol=lf\n');
  git('push', 'origin', `${attributes}:refs/heads/main`);
  await fs.writeFile(path.join(snapshot, 'plugins/cuefluent-notes/crlf.txt'), 'one\r\ntwo\r\n');
  await setVersion('1000.0.0');
  reject(release.version, /does not match.*digest/);
  assert.equal(remoteGit('rev-parse', 'main'), attributes);
  await fs.rm(path.join(snapshot, 'plugins/cuefluent-notes/crlf.txt'));
  await setVersion(originalRelease.version);
  reject(originalRelease.version, /downgrade/);
  assert.equal(git('rev-parse', 'HEAD'), initial);
  assert.equal(git('diff', '--cached'), indexBefore); assert.equal(git('diff'), workBefore);
  assert.deepEqual((await fs.readdir(temp)).filter(name => name.startsWith('marketplace-index.')), []);
});
