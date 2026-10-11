import './test-support/isolated-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ACL_PROBE, systemCommand, windowsTools, probeEnvironment, privacyIdentity,
  protectNewDirectory, validateWindowsACL } from './storage-platform.mjs';

// Independent reference for the previous provider-based query. Compare complete
// security descriptors, not just the permission checks that happen to pass.
const reference = String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$paths=ConvertFrom-Json $env:CUEFLUENT_PRIVACY_PATHS;
$result=@(foreach($p in $paths) {
  $item=Get-Item -Force -LiteralPath $p;
  $acl=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $p;
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);
  $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($p));
  $aces=@(foreach($ace in $raw.DiscretionaryAcl) {
    @{type=[int]$ace.AceType; flags=[int]$ace.AceFlags; mask=[int]$ace.AccessMask; sid=$ace.SecurityIdentifier.Value}
  });
  @{path=$p; owner=$raw.Owner.Value; protected=$acl.AreAccessRulesProtected;
    daclPresent=($null -ne $raw.DiscretionaryAcl); aces=$aces; attributes=[int]$item.Attributes;
    driveType=[int]$drive.DriveType; driveFormat=$drive.DriveFormat}
}); ConvertTo-Json -Depth 6 -Compress -InputObject $result`;

function runQuery(script, paths) {
  return spawnSync(windowsTools().powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: probeEnvironment(JSON.stringify(paths)), encoding: 'utf8', timeout: 30000, windowsHide: true });
}
async function query(script, paths) {
  const result = runQuery(script, paths);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function runQueryWithFailureDetails(script, paths) {
  // Preserve nonzero status, but expose invariant PowerShell error identifiers
  // so an unrelated failure cannot pass as the provider's long-path refusal.
  return runQuery(`try { & {${script}} } catch {
    [Console]::Error.WriteLine((@{category=$_.CategoryInfo.Category.ToString();
      errorId=$_.FullyQualifiedErrorId; exceptionType=$_.Exception.GetType().FullName} | ConvertTo-Json -Compress));
    exit 1
  }`, paths);
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cf-acl-')));
  const beforeRemove = [];
  t.after(async () => {
    for (const cleanup of beforeRemove) await cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });
  const sid = await privacyIdentity();
  await protectNewDirectory(root, sid);
  return { root, sid, beforeRemove };
}

test('native .NET ACL queries match provider snapshots and observe later permission changes', { skip: process.platform !== 'win32' }, async t => {
  const { root, sid, beforeRemove } = await fixture(t), directory = path.join(root, 'comma, 会議 & $(literal) [brackets]');
  await fs.mkdir(directory);
  const file = path.join(directory, 'private.json'), broad = path.join(root, 'broad.json'), denied = path.join(root, 'denied.json');
  for (const leaf of [file, broad, denied]) await fs.writeFile(leaf, '{}');
  await systemCommand(windowsTools().icacls, [broad, '/grant', '*S-1-1-0:R']);
  // Restore only this synthetic denial before Node's teardown touches attributes.
  // Register first so cleanup also handles a partially successful native command.
  beforeRemove.push(() => systemCommand(windowsTools().icacls, [denied, '/remove:d', '*S-1-1-0']));
  await systemCommand(windowsTools().icacls, [denied, '/deny', '*S-1-1-0:W']);
  await systemCommand(windowsTools().attrib, ['+H', '+I', '+R', file]);
  const link = path.join(root, 'junction'); await fs.symlink(directory, link, 'junction');
  const paths = [root, directory, file, broad, denied, link];
  const expected = await query(reference, paths), actual = await query(ACL_PROBE, paths);
  assert.deepEqual(actual, expected);
  validateWindowsACL(actual[0], sid, { directory: true, root: true });
  validateWindowsACL(actual[1], sid, { directory: true, root: false });
  validateWindowsACL(actual[2], sid, { directory: false, root: false });
  for (const index of [3, 4, 5]) assert.throws(() => validateWindowsACL(actual[index], sid,
    { directory: index === 5, root: false }), { code: 'STORAGE_NOT_PRIVATE' });
  await systemCommand(windowsTools().icacls, [file, '/grant', '*S-1-1-0:R']);
  const changed = await query(ACL_PROBE, [file]);
  assert.deepEqual(changed, await query(reference, [file]));
  assert.notDeepEqual(changed[0].aces, actual[2].aces);
  assert.throws(() => validateWindowsACL(changed[0], sid, { directory: false, root: false }), { code: 'STORAGE_NOT_PRIVATE' });
  await systemCommand(windowsTools().attrib, ['-R', file]);
  await fs.unlink(file);
  for (const script of [reference, ACL_PROBE]) await assert.rejects(systemCommand(windowsTools().powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: probeEnvironment(JSON.stringify([file])) }), { code: 'PRIVACY_PROBE_FAILED' });
});

test('native ACL probes retain the provider long-path behavior', { skip: process.platform !== 'win32' }, async t => {
  const { root } = await fixture(t);
  const directory = path.join(root, ...Array.from({ length: 6 }, (_, i) => `segment-${i}-${'x'.repeat(32)}`));
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'capture.json'); await fs.writeFile(file, '{}');
  assert.ok(file.length > 260);
  // Also force a refusal on hosts whose provider accepts existing long paths.
  for (const missing of [false, true]) {
    if (missing) await fs.unlink(file);
    const paths = missing ? [file] : [directory, file];
    const before = runQueryWithFailureDetails(reference, paths);
    const after = runQueryWithFailureDetails(ACL_PROBE, paths);
    assert.equal(before.error, undefined); assert.equal(after.error, undefined);
    assert.equal(before.signal, null); assert.equal(after.signal, null);
    if (missing) assert.equal(before.status, 1, 'the reference must refuse a missing long path');
    assert.equal(after.status, before.status, after.stderr);
    if (before.status === 0) assert.deepEqual(JSON.parse(after.stdout), JSON.parse(before.stdout));
    else {
      const expected = JSON.parse(before.stderr), actual = JSON.parse(after.stderr);
      for (const key of ['category', 'errorId', 'exceptionType']) assert.ok(typeof expected[key] === 'string' && expected[key].length > 0);
      assert.deepEqual(actual, expected, 'long-path refusal must have the same error category, identity and exception type');
      t.diagnostic(`Matching ${missing ? 'missing' : 'existing'} long-path refusal (${expected.category}, ${expected.exceptionType}).`);
    }
  }
});

test('native ACL probes report comparable warm-query timings', { skip: process.platform !== 'win32' }, async t => {
  const { root } = await fixture(t), directory = path.join(root, 'child'), file = path.join(directory, 'capture.json');
  await fs.mkdir(directory); await fs.writeFile(file, '{}');
  assert.ok(file.length < 248, 'benchmark exercises the direct query path');
  const script = `function Read-Reference {${reference}}; function Read-Current {${ACL_PROBE}};
    $before=Read-Reference; $after=Read-Current;
    $samples=@(foreach($round in 1..3) {
      foreach($name in $(if($round -eq 2){@('Read-Current','Read-Reference')}else{@('Read-Reference','Read-Current')})) {
        $watch=[Diagnostics.Stopwatch]::StartNew();
        for($i=0;$i -lt 10;$i++){ $null=& $name };
        $watch.Stop(); @{probe=$name; milliseconds=$watch.Elapsed.TotalMilliseconds; queries=10}
      }
    }); @{before=$before; after=$after; samples=$samples} | ConvertTo-Json -Depth 10 -Compress`;
  const result = await query(script, [root, directory, file]);
  assert.deepEqual(JSON.parse(result.after), JSON.parse(result.before));
  assert.equal(result.samples.length, 6);
  t.diagnostic(JSON.stringify({ nativeACLTiming: result.samples }));
  // Timings are evidence, not a flaky pass/fail threshold on shared CI runners.
});
