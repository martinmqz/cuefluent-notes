import './test-support/isolated-settings.mjs';
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

test('Finder metadata beside the review root does not weaken private storage checks', async t => {
  const f = await storageFixture(t), finderFile = path.join(f.collection.intakeStateDir, '.DS_Store');
  await fs.writeFile(finderFile, 'synthetic Finder metadata', { mode: 0o644 });
  await fs.chmod(finderFile, 0o644);
  await prepareWorkflowStorage(f.options);
  assert.deepEqual(await auditWorkflowStorage(f.capability), { complete: true });
  assert.equal(await fs.readFile(finderFile, 'utf8'), 'synthetic Finder metadata');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(finderFile)).mode & 0o777, 0o644);
    // The exception is for an unconsumed Finder entry, not an explicit data path.
    await assert.rejects(assertPrivatePaths(f.capability, [finderFile]), { code: 'STORAGE_NOT_PRIVATE' });
    for (const file of [path.join(f.collection.intakeStateDir, 'private.json'),
      path.join(f.collection.rawDir, '.DS_Store'), path.join(f.collection.notes.writerStateDir, '.DS_Store')]) {
      await fs.writeFile(file, 'synthetic private data', { mode: 0o644 }); await fs.chmod(file, 0o644);
      await assert.rejects(prepareWorkflowStorage(f.options), { code: 'STORAGE_NOT_PRIVATE' });
      await fs.unlink(file);
    }
    await fs.unlink(finderFile);
    await fs.symlink(path.join(f.root, 'missing'), finderFile);
    await assert.rejects(prepareWorkflowStorage(f.options), { code: 'UNSAFE_PRIVATE_STORAGE' });
    await fs.unlink(finderFile);
  } else await fs.unlink(finderFile);
  // A directory with Finder's name is still inspected, never silently skipped.
  await fs.mkdir(finderFile, { mode: 0o700 });
  const invalid = path.join(finderFile, 'invalid.json');
  await fs.writeFile(invalid, 'synthetic', { mode: 0o600 });
  await fs.link(invalid, path.join(f.root, 'outside-link'));
  await assert.rejects(prepareWorkflowStorage(f.options), { code: 'UNSAFE_PRIVATE_STORAGE' });
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

test('exclusive private creation refuses existing objects without changing their contents or permissions', async t => {
  const { createPrivateDirectory } = await import('./storage-platform.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-exclusive-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (process.platform === 'win32') await systemCommand(windowsTools().icacls, [root, '/grant', '*S-1-5-32-545:(OI)(CI)RX']);
  await withStorageProbes(async () => {
    const identity = await privacyIdentity(), directory = path.join(root, '会議 & $(literal)');
    const first = await createPrivateDirectory(directory, identity);
    await verifyPrivateEntries([{ path: directory, stat: first, root: true }], identity);
    const file = path.join(directory, 'keep.json'); await fs.writeFile(file, '{"keep":true}', { mode: 0o600 });
    const before = await fs.lstat(directory, { bigint: true });
    await assert.rejects(createPrivateDirectory(directory, identity), { code: 'EEXIST' });
    const after = await fs.lstat(directory, { bigint: true });
    assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode); assert.equal(after.ctimeNs, before.ctimeNs);
    assert.equal(await fs.readFile(file, 'utf8'), '{"keep":true}');
  });
});

test('native Windows refuses a shared writable creation parent without changing it', { skip: process.platform !== 'win32' }, async t => {
  const { createPrivateDirectory } = await import('./storage-platform.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-parent-acl-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await systemCommand(windowsTools().icacls, [root, '/grant', '*S-1-1-0:(OI)(CI)M']);
  const before = await systemCommand(windowsTools().icacls, [root]);
  await withStorageProbes(async () => {
    await assert.rejects(createPrivateDirectory(path.join(root, 'private'), await privacyIdentity()), { code: 'PRIVATE_PARENT_UNSAFE' });
  });
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await systemCommand(windowsTools().icacls, [root]), before);
});

test('creation parent validation rejects untrusted write grants, ownership and unsupported ACL forms', async () => {
  const { validateWindowsCreationParent } = await import('./storage-platform.mjs');
  const sid = 'S-1-5-21-1-2-3-1000';
  const valid = { owner: sid, protected: false, daclPresent: true, attributes: 16, driveType: 3, driveFormat: 'NTFS',
    aces: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({ sid, type: 0, flags: 3, mask: 2032127 })) };
  valid.aces.push({ sid: 'S-1-5-32-545', type: 0, flags: 3, mask: 1179817 });
  valid.aces.push({ sid: 'S-1-3-0', type: 0, flags: 11, mask: 2032127 });
  validateWindowsCreationParent(valid, sid);
  for (const mutate of [v => v.aces[3].mask |= 2, v => v.aces[3].mask |= 64,
    v => v.aces[4].flags = 3, v => v.aces[0].type = 5, v => v.owner = 'S-1-1-0',
    v => v.attributes |= 1024, v => v.daclPresent = false, v => v.driveType = 4]) {
    const changed = structuredClone(valid); mutate(changed);
    assert.throws(() => validateWindowsCreationParent(changed, sid), { code: 'PRIVATE_PARENT_UNSAFE' });
  }
});
