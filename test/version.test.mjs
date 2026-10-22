import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PACKAGE_NAME, PACKAGE_VERSION_PATTERN, packageVersion, packageIdentity } from '../src/core/version.mjs';
import { PACKAGE_VERSION } from '../tools/packaging.mjs';

test('the source manifest and lockfile agree on one public package identity', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, PACKAGE_NAME); assert.equal(packageIdentity(manifest), manifest.version);
  assert.equal(lock.name, manifest.name); assert.equal(lock.version, manifest.version); assert.equal(lock.packages[''].version, manifest.version);
  // The companion packaging tool runs without src/, so it carries the same rule.
  assert.equal(PACKAGE_VERSION.source, PACKAGE_VERSION_PATTERN.source); assert.equal(PACKAGE_VERSION.flags, PACKAGE_VERSION_PATTERN.flags);
});

test('package versions are exact SemVer cores with an optional prerelease; malformed values and foreign names are refused', () => {
  for (const version of ['0.16.0-dev.0', '0.16.0', '2.0.0', '10.4.1-rc.2', '0.0.1']) { assert.equal(packageVersion(version), version); assert.match(version, PACKAGE_VERSION_PATTERN); }
  for (const version of ['0.16', 'v0.16.0', '0.16.0+build.1', '01.16.0', '0.16.0-', ' 0.16.0', '0.16.0\n', '', `0.16.0-${'x'.repeat(64)}`, 1, null, undefined]) {
    assert.throws(() => packageVersion(version), { code: 'PACKAGE_INVALID' });
  }
  assert.throws(() => packageIdentity({ name: 'other-package', version: '0.16.0' }), { code: 'PACKAGE_INVALID' });
  assert.throws(() => packageIdentity({ name: 'cuefluent-notes', version: 'v0.16.0' }), { code: 'PACKAGE_INVALID' });
  assert.throws(() => packageIdentity(null), { code: 'PACKAGE_INVALID' });
});
