import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseUserSID, validateWindowsACL, rejectKnownSync, systemCommand, privacyIdentity, verifyPrivateEntries, privateMacMounts, withStorageProbes, windowsTools, probeEnvironment } from './storage-platform.mjs';
import { prepareWorkflowStorage, verifyWorkflowStorage, assertWorkflowStorage, assertPrivatePaths, auditWorkflowStorage } from './workflow-storage.mjs';

import { storageFixture } from './test-support/storage-fixture.mjs';

test('Windows probe preserves native dependencies and policies while overriding every search-path alias', () => {
  const native = { SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\untrusted', WINDIR: 'D:\\untrusted',
    SystemDrive: 'D:', Path: 'D:\\untrusted', PATH: 'D:\\untrusted', PSMODULEPATH: 'D:\\untrusted',
    PSModulePath: 'D:\\untrusted', cuefluent_privacy_paths: 'unselected',
    APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming', ProgramFiles: 'C:\\Program Files',
    PSExecutionPolicyPreference: 'Restricted', __PSLockdownPolicy: '4' };
  const payload = JSON.stringify(['C:\\fixture']), env = probeEnvironment(payload, native);
  for (const key of ['APPDATA', 'ProgramFiles', 'PSExecutionPolicyPreference', '__PSLockdownPolicy']) assert.equal(env[key], native[key]);
  const expected = { SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', SYSTEMDRIVE: 'C:',
    PATH: 'C:\\Windows\\System32', PSMODULEPATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules', CUEFLUENT_PRIVACY_PATHS: payload };
  for (const [name, value] of Object.entries(expected)) {
    const keys = Object.keys(env).filter(key => key.toUpperCase() === name);
    assert.equal(keys.length, 1); assert.equal(env[keys[0]], value);
  }
  assert.equal(native.PSMODULEPATH, 'D:\\untrusted');
});

test('numeric Windows ACL contract rejects broad, partial, unknown and inherited root permissions', () => {
  const sid = 'S-1-5-21-1-2-3-1000';
  const valid = { owner: sid, protected: true, daclPresent: true, attributes: 16, driveType: 3, driveFormat: 'NTFS',
    aces: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({ sid, type: 0, flags: 3, mask: 2032127 })) };
  validateWindowsACL(valid, sid, { directory: true, root: true });
  validateWindowsACL({ ...valid, owner: 'S-1-5-32-544' }, sid, { directory: true, root: true });
  for (const mutate of [v => v.aces.push({ ...v.aces[0], sid: 'S-1-1-0' }), v => v.aces.shift(),
    v => v.aces[0].flags = 11, v => v.aces[0].type = 5, v => v.aces[0].mask = 1179785,
    v => v.owner = 'S-1-1-0', v => v.protected = false, v => v.daclPresent = false,
    v => v.attributes |= 1024, v => v.driveType = 4, v => v.driveFormat = 'FAT32']) {
    const changed = structuredClone(valid); mutate(changed);
    assert.throws(() => validateWindowsACL(changed, sid, { directory: true, root: true }));
  }
  assert.equal(parseUserSID('"DOMAIN\\Comma, \\""Name","S-1-5-21-1-2-3-1000"\r\n'), sid);
  assert.throws(() => parseUserSID('User Name,SID\nname,S-1-5-21-1'));
  assert.throws(() => parseUserSID('"a","S-1-5-21-1"\n"b","S-1-5-21-2"\n'));
});

test('known synced and network paths are refused without guessing unknown locality', () => {
  for (const file of ['C:\\Users\\me\\OneDrive - Company\\private', '\\\\server\\share\\private', 'C:\\Users\\me\\CloudStorage\\private']) {
    assert.throws(() => rejectKnownSync(file, {}, 'win32'));
  }
  assert.throws(() => rejectKnownSync('/custom/sync/raw', { OneDrive: '/custom/sync' }, 'darwin'));
  for (const name of ['Desktop', 'Documents']) assert.throws(() => rejectKnownSync(path.posix.join(os.homedir(), name, 'private'), {}, 'darwin'));
  rejectKnownSync('/private/tmp/fixture', {}, 'darwin'); // real locality is separately probed
});

test('setup creates private roots; capabilities bind fresh policy, identity and operation', async t => {
  const f = await storageFixture(t);
  const selection = { client: 'codex', cwd: f.project, sessionId: '10000000-0000-4000-8000-000000000001' };
  assert.equal((await assertWorkflowStorage(f.capability, selection, 'collect')).id, 'fixture');
  await assert.rejects(assertWorkflowStorage(f.capability, selection, 'process'), { code: 'WORKFLOW_NOT_AUTHORIZED' });
  await assertWorkflowStorage(f.capability, selection, 'explicitProcess');
  assert.throws(() => JSON.stringify(f.capability), { code: 'STORAGE_CAPABILITY_NOT_SERIALIZABLE' });
  await assert.rejects(assertWorkflowStorage({ verified: true }), { code: 'STORAGE_CAPABILITY_REQUIRED' });
  await fs.appendFile(f.options.configPath, ' ');
  await assert.rejects(assertWorkflowStorage(f.capability), { code: 'WORKFLOW_POLICY_CHANGED' });
});

test('privacy rechecks replaced roots and never silently repairs existing permissions', async t => {
  const f = await storageFixture(t);
  const old = f.collection.rawDir + '-old';
  await fs.rename(f.collection.rawDir, old); await fs.mkdir(f.collection.rawDir, { mode: 0o700 });
  // On Windows new inheritance may fail first; neither result grants authority.
  await assert.rejects(assertWorkflowStorage(f.capability));
  await fs.rmdir(f.collection.rawDir); await fs.rename(old, f.collection.rawDir);
  if (process.platform !== 'win32') {
    await fs.chmod(f.collection.rawDir, 0o750);
    await assert.rejects(prepareWorkflowStorage(f.options), { code: 'STORAGE_NOT_PRIVATE' });
    assert.equal((await fs.stat(f.collection.rawDir)).mode & 0o777, 0o750);
    await fs.chmod(f.collection.rawDir, 0o700);
    await fs.writeFile(path.join(f.collection.rawDir, 'private.json'), '{}', { mode: 0o644 });
    await verifyWorkflowStorage(f.options); // unrelated history does not gate an operation
    await assert.rejects(assertPrivatePaths(f.capability, [path.join(f.collection.rawDir, 'private.json')]), { code: 'STORAGE_NOT_PRIVATE' });
  }
});

test('privacy refuses linked children and macOS extended grants even with mode 0700', async t => {
  const f = await storageFixture(t), file = path.join(f.collection.rawDir, 'private.json');
  await fs.writeFile(file, '{}', { mode: 0o600 }); await fs.link(file, file + '.linked');
  await assert.rejects(assertPrivatePaths(f.capability, [file]), { code: 'UNSAFE_PRIVATE_STORAGE' });
  await fs.unlink(file + '.linked');
  if (process.platform === 'darwin') {
    await systemCommand('/bin/chmod', ['+a', 'everyone allow read', file]);
    await assert.rejects(assertPrivatePaths(f.capability, [file]), { code: 'STORAGE_NOT_PRIVATE' });
    await systemCommand('/bin/chmod', ['-N', file]);
    await assertPrivatePaths(f.capability, [file]);
  }
});

test('native Windows root and child DACLs survive Restricted policy and reject broad explicit grants', { skip: process.platform !== 'win32' }, async t => {
  const previous = process.env.PSExecutionPolicyPreference;
  process.env.PSExecutionPolicyPreference = 'Restricted';
  t.after(() => { if (previous === undefined) delete process.env.PSExecutionPolicyPreference; else process.env.PSExecutionPolicyPreference = previous; });
  const f = await storageFixture(t), identity = await privacyIdentity();
  const { windowsTools } = await import('./storage-platform.mjs');
  const child = path.join(f.collection.rawDir, 'comma, Unicode-会議 & $(data)');
  await fs.mkdir(child);
  await verifyPrivateEntries([{ path: child, stat: await fs.lstat(child, { bigint: true }), root: false }], identity);
  await systemCommand(windowsTools().icacls, [child, '/grant', '*S-1-1-0:(OI)(CI)R']);
  await assert.rejects(assertPrivatePaths(f.capability, [child]), { code: 'STORAGE_NOT_PRIVATE' });
  // Setup refuses this existing child; it must not repair user-managed ACLs.
  await assert.rejects(prepareWorkflowStorage(f.options), { code: 'STORAGE_NOT_PRIVATE' });
});

test('publication hard links require both private stage/target aliases; external aliases fail', async t => {
  const f = await storageFixture(t), raw = path.join(f.collection.rawDir, 'a'.repeat(20) + '.json');
  const stage = path.join(f.collection.rawDir, '.stage-' + 'b'.repeat(20) + '-20000000-0000-4000-8000-000000000001.tmp');
  await fs.writeFile(stage, '{}', { mode: 0o600 }); await fs.link(stage, raw);
  await assertPrivatePaths(f.capability, [raw]);
  const outside = path.join(f.root, 'external.json');
  await fs.rename(stage, outside);
  await assert.rejects(assertPrivatePaths(f.capability, [raw]), { code: 'UNSAFE_PRIVATE_STORAGE' });
});

test('macOS ignore-ownership and network mounts are never privacy evidence', () => {
  assert.deepEqual(privateMacMounts('/dev/disk1 on /Volumes/Local (apfs, local, journaled)\n/dev/disk2 on /Volumes/Unsafe (apfs, local, noowners)\nserver on /Volumes/Share (smbfs, nodev)\nfuse on /Volumes/Fuse (macfuse, local)\n/dev/disk3 on /Volumes/With (parentheses) (hfs, local, journaled)'), ['/Volumes/Local', '/Volumes/With (parentheses)']);
});

test('explicit audit capacity reports incompleteness without blocking scoped operations', async t => {
  const f = await storageFixture(t);
  for (let i = 0; i < 12; i++) await fs.writeFile(path.join(f.collection.rawDir, `fixture-${i}.json`), '{}', { mode: 0o600 });
  assert.deepEqual(await auditWorkflowStorage(f.capability, { limit: 5 }), { complete: false, reason: 'PRIVACY_INSPECTION_CAPACITY' });
  await assertWorkflowStorage(f.capability);
  await assertPrivatePaths(f.capability, [path.join(f.collection.rawDir, 'fixture-0.json')]);
});

test('a Windows worker probe rereads changed ACLs within the same process', { skip: process.platform !== 'win32' }, async t => {
  const f = await storageFixture(t), file = path.join(f.collection.rawDir, 'Unicode-会議 & $(data).json');
  await fs.writeFile(file, '{}');
  await withStorageProbes(async () => {
    await withStorageProbes(async () => {
      for (let i = 0; i < 3; i++) await assertPrivatePaths(f.capability, [file]);
    });
    await systemCommand(windowsTools().icacls, [file, '/grant', '*S-1-1-0:R']);
    await assert.rejects(withStorageProbes(() => assertPrivatePaths(f.capability, [file])), { code: 'STORAGE_NOT_PRIVATE' });
  });
});
