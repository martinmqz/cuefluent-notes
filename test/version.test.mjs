import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PACKAGE_NAME, PACKAGE_VERSION_PATTERN, SEMVER_VERSION_PATTERN, packageVersion, packageIdentity } from '../src/core/version.mjs';
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

test('prerelease identifiers are nonempty and numeric identifiers have no leading zeros', () => {
  for (const version of ['0.16.0-0', '0.16.0-1.10', '0.16.0-dev.0', '0.16.0-01a', '0.16.0-01-a', '0.16.0-x-y-z.--']) {
    assert.equal(packageVersion(version), version); assert.match(version, PACKAGE_VERSION_PATTERN); assert.match(version, PACKAGE_VERSION);
  }
  for (const version of ['0.16.0-01', '0.16.0-00', '0.16.0-dev.01', '0.16.0-.', '0.16.0-.dev', '0.16.0-dev.', '0.16.0-dev..1', '0.16.0-dev_1']) {
    assert.throws(() => packageVersion(version), { code: 'PACKAGE_INVALID' });
    assert.doesNotMatch(version, PACKAGE_VERSION_PATTERN); assert.doesNotMatch(version, PACKAGE_VERSION);
  }
});

test('package and descriptive SemVer shapes reject final line terminators', () => {
  for (const end of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const base of ['0.16.0', '0.16.0-dev.0']) {
      const version = base + end;
      assert.throws(() => packageVersion(version), { code: 'PACKAGE_INVALID' });
      assert.doesNotMatch(version, PACKAGE_VERSION_PATTERN); assert.doesNotMatch(version, PACKAGE_VERSION);
      assert.doesNotMatch(version, SEMVER_VERSION_PATTERN);
    }
    assert.doesNotMatch(`0.16.0-dev.0+001${end}`, SEMVER_VERSION_PATTERN);
  }
});
