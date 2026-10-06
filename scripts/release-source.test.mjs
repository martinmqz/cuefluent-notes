import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { smokeEnvironment } from './smoke-environment.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
test('shallow release checks fetch main ancestry only and reject tags outside main', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-ancestry-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote');
  const env = { ...smokeEnvironment(root), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig') };
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, '');
  await fs.mkdir(remote);
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git(remote, 'init', '--initial-branch=main');
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  git(remote, 'config', 'user.name', 'Synthetic Release');
  git(remote, 'config', 'user.email', 'release@example.invalid');
  await fs.mkdir(path.join(remote, 'scripts'));
  for (const file of ['check-release-source.sh', 'release-policy.mjs', 'marketplace-layout.mjs', 'file-io.mjs']) {
    await fs.copyFile(path.join(source, file), path.join(remote, 'scripts', file));
  }
  await fs.writeFile(path.join(remote, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  git(remote, 'add', '.');
  git(remote, 'commit', '-m', 'Synthetic source tag');
  git(remote, 'tag', 'v1.0.0');
  const sourceTag = git(remote, 'rev-parse', 'HEAD');
  for (let i = 0; i < 2; i++) {
    await fs.writeFile(path.join(remote, 'later.txt'), String(i));
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'Later main change');
  }
  const laterBlob = git(remote, 'rev-parse', 'main:later.txt');
  git(remote, 'switch', '-c', 'unmerged', sourceTag);
  await fs.writeFile(path.join(remote, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  git(remote, 'add', '.');
  git(remote, 'commit', '-m', 'Unmerged change');
  git(remote, 'tag', 'v2.0.0');
  const unmerged = git(remote, 'rev-parse', 'HEAD');
  git(remote, 'switch', '--orphan', 'marketplace');
  await fs.writeFile(path.join(remote, 'snapshot.txt'), 'Synthetic generated branch.');
  git(remote, 'add', '.');
  git(remote, 'commit', '-m', 'Generated snapshot');
  const marketplace = git(remote, 'rev-parse', 'HEAD');
  git(remote, 'switch', 'main');

  for (const [tag, accepted] of [['v1.0.0', true], ['v2.0.0', false]]) {
    const checkout = path.join(root, tag);
    // file:// uses the Git transport so --depth really takes effect.
    git(root, 'clone', '--no-tags', '--branch', tag, '--depth=1', pathToFileURL(remote).href, checkout);
    assert.equal(git(checkout, 'rev-list', '--count', 'HEAD'), '1');
    const head = git(checkout, 'rev-parse', 'HEAD');
    const checked = spawnSync('bash', ['scripts/check-release-source.sh'], {
      cwd: checkout, encoding: 'utf8', env: { ...env, RELEASE_TAG: tag },
    });
    assert.equal(checked.status, accepted ? 0 : 1, checked.stderr || checked.stdout);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
    assert.equal(git(checkout, 'rev-parse', 'origin/main'), git(remote, 'rev-parse', 'main'));
    for (const absent of accepted ? [marketplace, unmerged, laterBlob] : [marketplace, laterBlob]) {
      assert.notEqual(spawnSync('git', ['-c', 'remote.origin.promisor=false', 'cat-file', '-e', absent], { cwd: checkout, env: { ...env, GIT_NO_LAZY_FETCH: '1' } }).status, 0);
    }
    assert.equal(git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), 'refs/remotes/origin/main');
  }
});
