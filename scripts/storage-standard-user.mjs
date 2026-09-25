// CI-only entry point. This never creates accounts and is not shipped.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { privacyIdentity, windowsTools, systemCommand } from './storage-platform.mjs';
import { assertPrivatePaths } from './workflow-storage.mjs';

// The account-creating parent checks the hosted CI environment. Its alternate-
// account child receives explicit arguments instead of relying on inherited flags.
const marker = process.argv[2] === '--ci-standard-user';
if (process.platform !== 'win32' || !marker || process.argv.length !== 5) {
  throw new Error(`Windows CI fixture only. windows=${process.platform === 'win32'}, marker=${marker}, argc=${process.argv.length}`);
}
const [work, expectedSID] = process.argv.slice(3);
process.env.TEMP = process.env.TMP = work;
process.env.PSExecutionPolicyPreference = 'Restricted';
const probe = JSON.parse(await systemCommand(windowsTools().powershell, ['-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference='Stop'; $i=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=[Security.Principal.WindowsPrincipal]::new($i); @{sid=$i.User.Value; groups=@($i.Groups | ForEach-Object {$_.Value}); admin=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); policy=[string](Get-ExecutionPolicy -Scope Process)} | ConvertTo-Json -Compress"]));
assert.equal(probe.sid, expectedSID); assert.equal(probe.sid, await privacyIdentity());
assert.equal(probe.admin, false); assert.equal(probe.groups.includes('S-1-5-32-544'), false);
assert.equal(probe.policy, 'Restricted');
const cleanup = [];
try {
  const f = await storageFixture({ after: fn => cleanup.push(fn) });
  const file = path.join(f.collection.rawDir, 'standard-user-会議 & (data).json');
  await fs.writeFile(file, '{"fixture":true}', { mode: 0o600 });
  await assertPrivatePaths(f.capability, [file]);
  await systemCommand(windowsTools().icacls, [file, '/grant', '*S-1-1-0:R']);
  await assert.rejects(assertPrivatePaths(f.capability, [file]), { code: 'STORAGE_NOT_PRIVATE' });
  console.log('Verified actual standard-user SID, non-admin token, Restricted policy, private inherited child ACLs, and broad-grant refusal.');
} finally { for (const fn of cleanup.reverse()) await fn(); }
