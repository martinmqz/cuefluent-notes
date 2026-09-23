import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkReleaseTag, checkMarketplaceAdvance } from './release-policy.mjs';

test('only a stable tag matching the built package can be released', () => {
  checkReleaseTag('0.5.0', 'v0.5.0');
  for (const [version, tag] of [['0.5.0', 'v0.6.0'], ['0.5.0', '0.5.0'], ['0.5.0-beta.1', 'v0.5.0-beta.1'], ['01.5.0', 'v01.5.0']]) {
    assert.throws(() => checkReleaseTag(version, tag));
  }
});

test('policy CLI validates source tags and both client manifest identities and versions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('./release-policy.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const pkg = path.join(root, 'package.json');
  await fs.writeFile(pkg, JSON.stringify({ version: '1.2.3' }));
  assert.equal(run(['check-tag', pkg, 'v1.2.3']).stdout.trim(), 'valid-tag');
  assert.equal(run(['check-tag', pkg, 'v1.2.4']).status, 2);
  await fs.writeFile(path.join(root, 'release.json'), JSON.stringify({ version: '1.2.3', archives: [] }));
  const manifests = [];
  const good = { name: 'cuefluent-notes', version: '1.2.3' };
  for (const [client, dir] of [['codex', 'plugins'], ['claude', 'claude']]) {
    const file = path.join(root, dir, 'cuefluent-notes', `.${client}-plugin/plugin.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(good));
    manifests.push(file);
  }
  assert.equal(run([root, 'v1.2.3']).stdout.trim(), 'new-version');
  assert.equal(run([root, 'v1.2.3', path.join(root, 'release.json')]).stdout.trim(), 'same-version');
  for (const file of manifests) {
    for (const bad of [{ ...good, name: 'other-plugin' }, { ...good, version: '1.2.4' }]) {
      await fs.writeFile(file, JSON.stringify(bad));
      const result = run([root, 'v1.2.3']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /identity\/version mismatch/);
    }
    await fs.rm(file);
    assert.equal(run([root, 'v1.2.3']).status, 2);
    await fs.writeFile(file, JSON.stringify(good));
  }
});
test('marketplace retries must preserve artifacts and older releases cannot roll back users', () => {
  const current = { version: '1.9.0', archives: [{ sha256: 'original' }] };
  checkMarketplaceAdvance(current, null);
  checkMarketplaceAdvance(structuredClone(current), current);
  checkMarketplaceAdvance({ version: '1.10.0' }, current);
  checkMarketplaceAdvance({ version: '2.0.0' }, current);
  checkMarketplaceAdvance({ version: '1.9.1' }, current);
  assert.throws(() => checkMarketplaceAdvance({ version: '1.8.9' }, current), /downgrade/);
  assert.throws(() => checkMarketplaceAdvance({ version: '0.99.99' }, current), /downgrade/);
  assert.throws(() => checkMarketplaceAdvance({ ...current, archives: [{ sha256: 'changed' }] }, current), /different release artifacts/);
  assert.throws(() => checkMarketplaceAdvance(current, { version: 'unknown' }), /version/);
});
