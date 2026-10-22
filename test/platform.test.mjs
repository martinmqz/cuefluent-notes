import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertEmptyPrivateReservation, assertPrivateAccess, establishWindowsPrivacy } from '../src/storage/platform.mjs';
import { queryWindowsAcl } from '../src/storage/windows-acl.mjs';

const windowsTest = process.platform === 'win32' ? test : test.skip;
const powershell = (script, env = {}) => execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue'; " + script, 'utf16le').toString('base64')],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024, env: { ...process.env, ...env } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-acl-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "private λ [literal] '$;.tmp"); await fs.writeFile(file, 'synthetic'); establishWindowsPrivacy(file);
  return file;
}

test('ACL helper rejects invalid requests before launching native work', () => {
  for (const file of ['relative', '\\\\server\\share\\private', 'C:\\bad\npath']) assert.throws(() => queryWindowsAcl(file, false));
});

windowsTest('persistent helper verifies fresh ACLs and can repair only an explicitly created path', async t => {
  const file = await fixture(t);
  for (let i = 0; i < 20; i++) assertPrivateAccess(file);
  powershell(String.raw`$ErrorActionPreference='Stop'; $p=$env:CUEFLUENT_TEST_PATH; $acl=Get-Acl -LiteralPath $p; $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`, { CUEFLUENT_TEST_PATH: file });
  assert.throws(() => assertPrivateAccess(file), { code: 'PRIVATE_ACCESS_UNSAFE' });
  establishWindowsPrivacy(file); assertPrivateAccess(file);
  await fs.unlink(file);
  assert.throws(() => assertPrivateAccess(file), { code: 'PRIVATE_ACCESS_UNVERIFIED' });
});

windowsTest('ACL native helper exits after its owning Node process is killed', async t => {
  const file = await fixture(t);
  const cwd = path.join(path.dirname(file), 'child-cwd'); await fs.mkdir(cwd);
  const child = fork(fileURLToPath(new URL('./fixtures/windows-acl-holder.mjs', import.meta.url)), [file], { cwd, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('ACL holder exited before readiness.'); })]);
  const helpers = Array.isArray(message.helpers) ? message.helpers : [message.helpers];
  assert.equal(helpers.length, 1); assert(Number.isInteger(helpers[0]));
  const exited = once(child, 'exit'); child.kill(); await exited;
  await fs.rmdir(cwd); // The still-shutting-down helper cannot hold this folder.
  for (let i = 0; ; i++) {
    const alive = powershell(`@(Get-Process -Id ${helpers[0]} -ErrorAction SilentlyContinue).Count`).trim();
    if (alive === '0') break;
    assert(i < 10, 'Native ACL helper survived parent death.'); await delay(100);
  }
});

windowsTest('pre-initialization reservations need an empty exact single-link file and private DACL', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-acl-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); establishWindowsPrivacy(root);
  const file = path.join(root, 'reserved.tmp'); await fs.writeFile(file, '');
  assertEmptyPrivateReservation(file, await fs.lstat(file));
  await fs.writeFile(file, 'unexpected');
  let stat = await fs.lstat(file);
  assert.throws(() => assertEmptyPrivateReservation(file, stat), { code: 'PRIVATE_ACCESS_UNSAFE' });
  await fs.truncate(file, 0);
  const alias = path.join(root, 'other.tmp'); await fs.link(file, alias);
  stat = await fs.lstat(file);
  assert.throws(() => assertEmptyPrivateReservation(file, stat), { code: 'PRIVATE_ACCESS_UNSAFE' }); await fs.unlink(alias);
  powershell(String.raw`$ErrorActionPreference='Stop'; $p=$env:CUEFLUENT_TEST_PATH; $acl=Get-Acl -LiteralPath $p; $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`, { CUEFLUENT_TEST_PATH: file });
  stat = await fs.lstat(file);
  assert.throws(() => assertEmptyPrivateReservation(file, stat), { code: 'PRIVATE_ACCESS_UNSAFE' });
});
