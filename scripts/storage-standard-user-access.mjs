// CI-only second token check. Accounts and fixtures belong to the guarded parent.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { windowsTools, systemCommand, probeEnvironment } from './storage-platform.mjs';

if (process.platform !== 'win32' || process.argv[2] !== '--ci-standard-user-access' || process.argv.length !== 5) {
  throw new Error('Windows CI second-user fixture only.');
}
const [expectedSID, root] = process.argv.slice(3);
const token = JSON.parse(await systemCommand(windowsTools().powershell, ['-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference='Stop'; $i=[Security.Principal.WindowsIdentity]::GetCurrent(); @{sid=$i.User.Value; groups=@($i.Groups | ForEach-Object {$_.Value})} | ConvertTo-Json -Compress"], { env: probeEnvironment('') }));
assert.equal(token.sid, expectedSID);
assert.equal(token.groups.includes('S-1-5-32-544'), false);
const parent = path.dirname(root);
await fs.readdir(parent);
await fs.mkdir(path.join(parent, 'second-user-control'));
console.log('Second standard user can enumerate and create a directory in the shared parent.');
const denied = error => ['EACCES', 'EPERM'].includes(error.code);
await assert.rejects(async () => {
  const handle = await fs.open(path.join(root, 'nested', 'published.json'), 'r');
  await handle.close();
}, denied, 'Another standard user must not read private output.');
console.log('Second standard user was denied reading the first user private output.');
await assert.rejects(async () => {
  const handle = await fs.open(path.join(root, 'foreign.json'), 'wx');
  await handle.close();
}, denied, 'Another standard user must not create private output.');
console.log('Second standard user was denied creating private output.');
