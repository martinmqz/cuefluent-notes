import './test-support/isolated-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { windowsProfilePolicy, resolveProfileFolders, nativeLocalPath, PROFILE_FOLDERS_PROBE, resolveNativeProfileFolders } from './windows-profile.mjs';
import { withStorageProbes, privateProfilePaths, privacyIdentity, systemCommand, windowsTools, probeEnvironment, verifyPrivateEntries } from './storage-platform.mjs';
import { storageFixture } from './test-support/storage-fixture.mjs';
const sid = 'S-1-5-21-1-2-3-1001';
const home = 'C:\\Users\\Example', local = home + '\\AppData\\Local', privateFile = home + '\\.cuefluent-notes\\workflow.json';
const facts = () => ({ sid, home, local, profiles: [{ sid, localPath: home, loaded: true, special: false, roaming: false, preference: true, status: 0 }] });

test('private profile policy requires content-index protection only inside native profile outside LocalAppData', () => {
  const paths = [privateFile, local + '\\CuefluentNotes\\workflow.json', 'D:\\Private\\state'];
  assert.deepEqual([...windowsProfilePolicy(facts(), sid, paths)], [privateFile]);
  const roaming = facts(); roaming.profiles[0].roaming = true; roaming.profiles[0].status = 2;
  assert.deepEqual([...windowsProfilePolicy(roaming, sid, paths.slice(1))], []);
  assert.throws(() => windowsProfilePolicy(roaming, sid, paths), { code: 'PRIVATE_PROFILE_UNSAFE' });
});

test('profile policy refuses missing, conflicting, temporary and mandatory native facts', () => {
  for (const mutate of [v => v.sid = 'other', v => v.profiles = [], v => v.profiles.push(v.profiles[0]),
    v => v.profiles[0].loaded = false, v => v.profiles[0].special = true,
    v => v.profiles[0].localPath = 'C:\\Users\\Other', v => v.local = 'C:\\', v => v.profiles[0].roaming = null,
    v => v.profiles[0].preference = 'true']) {
    const value = facts(); mutate(value);
    assert.throws(() => windowsProfilePolicy(value, sid, [privateFile]), { code: 'PRIVATE_PROFILE_UNVERIFIED' });
  }
  for (const status of [1, 2, 4, 8]) {
    const value = facts(); value.profiles[0].status = status;
    assert.throws(() => windowsProfilePolicy(value, sid, [privateFile]), { code: 'PRIVATE_PROFILE_UNSAFE' });
    assert.deepEqual([...windowsProfilePolicy(value, sid, [local + '\\state'])], []);
  }
});

test('a local profile accepts the default roaming preference without allowing configured roaming', () => {
  for (const preference of [true, false, null]) {
    const value = facts(); value.profiles[0].preference = preference;
    assert.deepEqual([...windowsProfilePolicy(value, sid, [privateFile])], [privateFile]);
    // Keep the conservative configured-roaming exclusion even when preference
    // currently disables roaming. A preference alone is not configuration.
    value.profiles[0].roaming = true;
    assert.throws(() => windowsProfilePolicy(value, sid, [privateFile]), { code: 'PRIVATE_PROFILE_UNSAFE' });
  }
});

test('outside-profile stores do not require WMI or valid LocalAppData policy facts', () => {
  assert.deepEqual([...windowsProfilePolicy({ sid, home, local: null }, sid, ['D:\\Private\\state'])], []);
  assert.deepEqual([...windowsProfilePolicy({ sid, home, local }, sid, [local + '\\state'])], []);
  assert.throws(() => windowsProfilePolicy({ sid, home, local: null }, sid, [privateFile]), { code: 'PRIVATE_PROFILE_UNVERIFIED' });
  assert.throws(() => windowsProfilePolicy({ sid, home, local }, sid, [privateFile]), { code: 'PRIVATE_PROFILE_UNVERIFIED' });
  for (const value of ['%USERPROFILE%\\AppData\\Local', '%HOMEDRIVE%%HOMEPATH%\\AppData\\Local'])
    assert.equal(nativeLocalPath(home, value), local);
  assert.throws(() => nativeLocalPath(home, '%UNTRUSTED%\\Local'), { code: 'PRIVATE_PROFILE_UNVERIFIED' });
});

async function nativeFolders() {
  return resolveNativeProfileFolders(JSON.parse(await systemCommand(windowsTools().powershell,
    ['-NoProfile', '-NonInteractive', '-Command', PROFILE_FOLDERS_PROBE], { env: probeEnvironment('') })));
}
test('native profile policy is lazy, sampled once per operation and fresh on the next', { skip: process.platform !== 'win32' }, async () => {
  const folders = await nativeFolders();
  const spawn = childProcess.spawn; let queries = 0, locationQueries = 0;
  childProcess.spawn = function (...args) {
    const child = spawn.apply(this, args);
    if (args[0].toLowerCase().endsWith('powershell.exe') && child.stdin) {
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (data, ...rest) => { if (data === 'profile\n') queries++; if (data === 'folders\n') locationQueries++; return write(data, ...rest); };
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    for (let operation = 1; operation <= 2; operation++) {
      await withStorageProbes(async () => {
        const identity = await privacyIdentity();
        await privateProfilePaths([], identity);
        assert.equal(locationQueries, operation - 1);
        await privateProfilePaths([folders.local], identity);
        assert.equal(queries, operation - 1);
        // Classification only: never create or inspect this hypothetical file.
        const files = [path.join(folders.home, '.cuefluent-policy-probe.json')];
        await privateProfilePaths(files, identity);
        await withStorageProbes(() => privateProfilePaths(files, identity));
        assert.equal(queries, operation); assert.equal(locationQueries, operation);
      });
    }
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
});

test('a failed WMI policy query leaves unrelated LocalAppData ACL verification usable', { skip: process.platform !== 'win32' }, async t => {
  const f = await storageFixture(t), folders = await nativeFolders(), spawn = childProcess.spawn;
  childProcess.spawn = function (exe, args, ...rest) {
    if (exe.toLowerCase().endsWith('powershell.exe')) {
      args = [...args]; const at = args.indexOf('-Command');
      if (at >= 0) args[at + 1] = "function Get-CimInstance { throw 'Synthetic WMI failure' }; " + args[at + 1];
    }
    return spawn.call(this, exe, args, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await withStorageProbes(async () => {
      const identity = await privacyIdentity();
      assert.deepEqual([...await privateProfilePaths([f.root], identity)], []);
      await assert.rejects(privateProfilePaths([path.join(folders.home, '.cuefluent-policy-probe.json')], identity), { code: 'PRIVATE_PROFILE_UNVERIFIED' });
      await verifyPrivateEntries([{ path: f.collection.rawDir, stat: await fs.lstat(f.collection.rawDir, { bigint: true }), root: true }], identity);
    });
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
});

test('native folder facts resolve junctions but refuse missing and non-directory targets', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cf-profile-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'profile'), local = path.join(root, 'local'), homeAlias = path.join(root, 'home-alias'), localAlias = path.join(root, 'local-alias');
  await fs.mkdir(home); await fs.mkdir(local);
  for (const [target, alias] of [[home, homeAlias], [local, localAlias]]) await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const value = { ...facts(), home: homeAlias, local: localAlias, profiles: [{ ...facts().profiles[0], localPath: home }] };
  const resolved = await resolveProfileFolders(value);
  assert.equal(resolved.home, home); assert.equal(resolved.local, local); assert.equal(resolved.profiles[0].localPath, home);
  await assert.rejects(resolveProfileFolders({ ...value, local: path.join(root, 'missing') }));
  const file = path.join(root, 'file'); await fs.writeFile(file, 'synthetic');
  await assert.rejects(resolveProfileFolders({ ...value, local: file }), { code: 'UNSAFE_WORKFLOW_PATH' });
  assert.equal(value.home, homeAlias, 'input facts are not rewritten');
});
