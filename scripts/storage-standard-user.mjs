// CI-only entry point. This never creates accounts and is not shipped.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { privacyIdentity, windowsTools, systemCommand, probeEnvironment, createPrivateDirectory, verifyPrivateEntries, withStorageProbes } from './storage-platform.mjs';
import { assertPrivatePaths } from './workflow-storage.mjs';

// The account-creating parent checks the hosted CI environment. Its alternate-
// account child receives explicit arguments instead of relying on inherited flags.
const marker = process.argv[2] === '--ci-standard-user';
if (process.platform !== 'win32' || !marker || process.argv.length !== 6) {
  throw new Error(`Windows CI fixture only. windows=${process.platform === 'win32'}, marker=${marker}, argc=${process.argv.length}`);
}
const [work, expectedSID, programDataRoot] = process.argv.slice(3);
process.env.TEMP = process.env.TMP = work;
process.env.PSExecutionPolicyPreference = 'Restricted';
const probe = JSON.parse(await systemCommand(windowsTools().powershell, ['-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference='Stop'; $i=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=[Security.Principal.WindowsPrincipal]::new($i); $profile=Get-CimInstance Win32_UserProfile -Filter (\"SID='\"+$i.User.Value+\"'\"); @{sid=$i.User.Value; groups=@($i.Groups | ForEach-Object {$_.Value}); admin=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); policy=[string](Get-ExecutionPolicy -Scope Process); profile=$profile.LocalPath; loaded=$profile.Loaded; roaming=$profile.RoamingConfigured; roamingPreference=$profile.RoamingPreference; status=$profile.Status; home=[Environment]::GetFolderPath('UserProfile'); local=[Environment]::GetFolderPath('LocalApplicationData'); roamingPath=[Environment]::GetFolderPath('ApplicationData')} | ConvertTo-Json -Compress"], { env: probeEnvironment('') }));
assert.equal(probe.sid, expectedSID); assert.equal(probe.sid, await privacyIdentity());
assert.equal(probe.admin, false); assert.equal(probe.groups.includes('S-1-5-32-544'), false);
assert.equal(probe.policy, 'Restricted');
assert.equal(probe.loaded, true); assert.equal(probe.roaming, false); assert.equal(probe.status, 0);
assert([true, false, null].includes(probe.roamingPreference));
assert.equal(path.resolve(probe.profile).toLowerCase(), path.resolve(probe.home).toLowerCase());
for (const folder of [probe.local, probe.roamingPath]) {
  const relative = path.relative(probe.home, folder);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
// Alternate-token processes can inherit their parent's environment. Bind these
// tests to the loaded fixture profile proven above, never to the runner account.
for (const [key, value] of Object.entries({ HOME: probe.home, USERPROFILE: probe.home, LOCALAPPDATA: probe.local, APPDATA: probe.roamingPath })) {
  for (const alias of Object.keys(process.env)) if (alias.toUpperCase() === key) delete process.env[alias];
  process.env[key] = value;
}
const cleanup = [];
try {
  await withStorageProbes(async () => {
    const sid = await privacyIdentity();
    const profileRoot = path.join(probe.home, '.cuefluent-ci-' + randomUUID());
    for (const root of [profileRoot, programDataRoot]) {
      const started = performance.now(), stat = await createPrivateDirectory(root, sid);
      // The parent owns the ProgramData container and retains this one root for
      // its second standard-user denial check, then removes the entire fixture.
      if (root === profileRoot) cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
      await verifyPrivateEntries([{ path: root, stat, root: true }], sid);
      if (root === programDataRoot) await systemCommand(windowsTools().attrib, ['+I', root, '/L']);
      const nested = path.join(root, 'nested'); await fs.mkdir(nested);
      const stage = path.join(nested, 'stage.json'), published = path.join(nested, 'published.json');
      await fs.writeFile(stage, '{"synthetic":true}'); await fs.rename(stage, published);
      const entries = await Promise.all([nested, published].map(async file => ({ path: file, stat: await fs.lstat(file, { bigint: true }), root: false })));
      const attributes = await verifyPrivateEntries(entries, sid);
      for (const file of [nested, published]) assert(attributes.get(file) & 8192, 'NotContentIndexed must survive inheritance and rename');
      if (root === profileRoot) {
        await systemCommand(windowsTools().attrib, ['-I', published, '/L']);
        await assert.rejects(verifyPrivateEntries([
          { path: published, stat: await fs.lstat(published, { bigint: true }), root: false },
        ], sid), { code: 'PRIVATE_CONTENT_INDEXING_REQUIRED' });
        assert.equal(await fs.readFile(published, 'utf8'), '{"synthetic":true}');
      }
      console.log(JSON.stringify({ candidate: root === profileRoot ? 'profile' : 'ProgramData-controlled-parent', standardUser: true, milliseconds: Math.round(performance.now() - started), privateCreation: true, notContentIndexedBit: true }));
      // Exact same-process race/precreation outcome; no adoption or ACL repair.
      await assert.rejects(createPrivateDirectory(root, sid), { code: 'EEXIST' });
    }
    const foreign = programDataRoot + '-admin';
    const before = await systemCommand(windowsTools().icacls, [foreign]);
    await assert.rejects(createPrivateDirectory(foreign, sid), { code: 'EEXIST' });
    assert.equal(await systemCommand(windowsTools().icacls, [foreign]), before);
    console.log('Administrator-precreated directory refused without ACL changes. Administrator access to user-created state is allowed, not an isolation failure.');
  });
  const f = await storageFixture({ after: fn => cleanup.push(fn) });
  const file = path.join(f.collection.rawDir, 'standard-user-会議 & (data).json');
  await fs.writeFile(file, '{"fixture":true}', { mode: 0o600 });
  await assertPrivatePaths(f.capability, [file]);
  await systemCommand(windowsTools().icacls, [file, '/grant', '*S-1-1-0:R']);
  await assert.rejects(assertPrivatePaths(f.capability, [file]), { code: 'STORAGE_NOT_PRIVATE' });
  console.log('Verified actual standard-user SID and loaded local profile, non-admin token, Restricted policy, candidate creation, private inherited child ACLs, and broad-grant refusal. The parent checks a second standard-user token; Desktop virtualization remains separate.');
} finally { for (const fn of cleanup.reverse()) await fn(); }
