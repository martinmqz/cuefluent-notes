import './test-support/isolated-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { assertWorkflowStorage, assertPrivatePaths } from './workflow-storage.mjs';
import { withStorageProbes, systemCommand } from './storage-platform.mjs';
import { inspectIntakeStore, intakePath, guardStore, writeIntakeStage, withIntakeLock, replaceIntakeJSON } from './intake-io.mjs';
import { collectionGrantHash } from './collection-grant.mjs';
import { validateWorkflowConfig } from './workflow-config.mjs';

test('directory child churn retries privacy verification but repeated churn stays bounded', async t => withStorageProbes(async () => {
  const f = await storageFixture(t), root = f.collection.intakeStateDir, lstat = fs.lstat;
  for (const continuous of [false, true]) {
    let count = 0;
    fs.lstat = async (file, ...args) => {
      if (file === root && ++count >= 2 && (continuous || count === 2)) {
        const child = path.join(root, 'concurrent-child');
        await fs.mkdir(child, { mode: 0o700 }); await fs.rmdir(child);
      }
      return lstat(file, ...args);
    };
    try {
      if (continuous) await assert.rejects(assertWorkflowStorage(f.capability), /PRIVATE_STORAGE_CHANGED/);
      else await assertWorkflowStorage(f.capability);
      assert(count < 25, 'retry count is bounded');
    } finally { fs.lstat = lstat; }
  }
}));

test('privacy retries do not adopt permission changes or replaced roots', async t => withStorageProbes(async () => {
  const f = await storageFixture(t), root = f.collection.intakeStateDir, lstat = fs.lstat;
  let count = 0;
  fs.lstat = async (file, ...args) => {
    if (file === root && ++count === 2) {
      await fs.rename(root, root + '-original'); await fs.mkdir(root, { mode: 0o700 });
    }
    return lstat(file, ...args);
  };
  try { await assert.rejects(assertWorkflowStorage(f.capability), /PRIVATE_STORAGE_CHANGED/); }
  finally { fs.lstat = lstat; }
  await fs.rmdir(root); await fs.rename(root + '-original', root);
  if (process.platform !== 'win32') {
    count = 0;
    fs.lstat = async (file, ...args) => {
      if (file === root && ++count === 2) await fs.chmod(root, 0o750);
      return lstat(file, ...args);
    };
    try { await assert.rejects(assertWorkflowStorage(f.capability), /PRIVATE_STORAGE_CHANGED|STORAGE_NOT_PRIVATE/); }
    finally { fs.lstat = lstat; await fs.chmod(root, 0o700); }
  }
}));

test('macOS scopes reuse unchanged ACLs while locality, changed ACLs and later scopes remain fresh', { skip: process.platform !== 'darwin' }, async t => {
  const f = await storageFixture(t), file = path.join(f.collection.rawDir, 'capture.json');
  await fs.writeFile(file, '{}', { mode: 0o600 });
  const spawn = childProcess.spawn; let acl = 0, mount = 0, denyMount = false;
  childProcess.spawn = function (executable, ...args) {
    if (executable === '/bin/ls') acl++;
    if (executable === '/sbin/mount') {
      mount++;
      if (denyMount) return spawn.call(this, process.execPath, ['-e', 'process.stdout.write(process.env.CUEFLUENT_TEST_MOUNT)'],
        { env: { ...process.env, CUEFLUENT_TEST_MOUNT: `synthetic on ${f.root} (apfs, local, noowners)\n` } });
    }
    return spawn.call(this, executable, ...args);
  };
  syncBuiltinESMExports();
  try {
    await withStorageProbes(async () => {
      await assertPrivatePaths(f.capability, [file]);
      assert.equal(acl, 1); assert.equal(mount, 1);
      await withStorageProbes(async () => {
        await assertPrivatePaths(f.capability, [file]);
        await assertPrivatePaths(f.capability, [file]);
      });
      assert.equal(acl, 1); assert.equal(mount, 3);
      await systemCommand('/bin/chmod', ['+a', 'everyone allow read', file]);
      await assert.rejects(assertPrivatePaths(f.capability, [file]), /STORAGE_NOT_PRIVATE/);
      assert.equal(acl, 2);
      await systemCommand('/bin/chmod', ['-N', file]);
      await assertPrivatePaths(f.capability, [file]); assert.equal(acl, 3);
      denyMount = true;
      await assert.rejects(assertPrivatePaths(f.capability, [file]), /STORAGE_LOCALITY_UNVERIFIED/);
      assert.equal(acl, 3); denyMount = false;
    });
    await withStorageProbes(() => assertPrivatePaths(f.capability, [file]));
    assert.equal(acl, 4); assert.equal(mount, 7);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
});

test('same-config note alias retargets are rejected by the final fresh placement check', async t => withStorageProbes(async () => {
  const f = await storageFixture(t), parent = path.join(f.root, 'note-parent'), other = path.join(f.root, 'other-parent'), alias = path.join(f.root, 'alias');
  await fs.mkdir(parent); await fs.mkdir(other);
  await fs.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.config.collections[0].notes.notesDir = path.join(alias, 'notes');
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  const { digest } = await import('./workflow-values.mjs'), { verifyWorkflowStorage } = await import('./workflow-storage.mjs');
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  const lstat = fs.lstat; let switched = false;
  fs.lstat = async (file, ...args) => {
    if (!switched && file === f.collection.rawDir) {
      switched = true; await fs.unlink(alias);
      await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return lstat(file, ...args);
  };
  try { await assert.rejects(assertWorkflowStorage(capability), /PRIVATE_STORAGE_CHANGED/); }
  finally { fs.lstat = lstat; }
}));

test('grant calculation resolves only the selected descriptor without changing its hash', async t => withStorageProbes(async () => {
  const f = await storageFixture(t), realpath = fs.realpath, selection = { client: 'codex', sessionId: '10000000-0000-4000-8000-000000000001' };
  let calls = 0;
  fs.realpath = async (...args) => { calls++; return realpath(...args); };
  try {
    const first = await collectionGrantHash(validateWorkflowConfig(f.config), 'fixture', selection), one = calls;
    calls = 0;
    const config = validateWorkflowConfig({ ...f.config, routes: [...f.config.routes,
      ...Array.from({ length: 99 }, (_, i) => ({ ...f.config.routes[0], id: 'other-' + i, projectRoot: path.join(f.root, 'missing-' + i) }))] });
    assert.equal(await collectionGrantHash(config, 'fixture', selection), first);
    assert.equal(calls, one); assert.equal(calls, 3);
  } finally { fs.realpath = realpath; }
}));

test('intake traversal scales with touched paths and still rejects a replaced pinned parent', async t => withStorageProbes(async () => {
  const f = await storageFixture(t), lstat = fs.lstat;
  const counts = [];
  for (const size of [16, 32]) {
    const store = await inspectIntakeStore(f.collection); let count = 0;
    fs.lstat = async (...args) => { count++; return lstat(...args); };
    try {
      for (let i = 0; i < size; i++) await intakePath(store, 'state', `scale${size}/s${i}/record.json`, { createParents: true });
    } finally { fs.lstat = lstat; }
    counts.push(count);
    const old = path.join(f.collection.intakeStateDir, `scale${size}/s0`);
    await fs.rename(old, old + '-old'); await fs.mkdir(old, { mode: 0o700 });
    // An unrelated old pin is deferred until its path is touched.
    await intakePath(store, 'state', `scale${size}/s1/record.json`);
    await assert.rejects(intakePath(store, 'state', `scale${size}/s0/record.json`), /INTAKE_ROOT_CHANGED/);
    await assert.rejects(guardStore(store, [path.join(f.project, 'outside')]), /UNSAFE_INTAKE_PATH/);
  }
  assert(counts[1] < counts[0] * 2.2, JSON.stringify(counts));
}));

test('stage cleanup preserves bytes when its pinned parent is replaced after the handle closes', async t => withStorageProbes(async () => {
  const f = await storageFixture(t), store = await inspectIntakeStore(f.collection);
  const parent = path.join(f.collection.intakeStateDir, 'stage-parent'), file = path.join(parent, 'owned.tmp');
  const open = fs.open, failure = Object.assign(new Error('synthetic write failure'), { code: 'ENOSPC' });
  let changed = false;
  fs.open = async (name, ...args) => {
    const handle = await open(name, ...args);
    if (name === file && args[0] === 'wx') {
      handle.writeFile = async () => { throw failure; };
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        // Windows forbids moving a directory with an open child handle. Inject
        // the replacement after close, before the same guarded cleanup boundary.
        await fs.rename(parent, parent + '-old'); await fs.mkdir(parent, { mode: 0o700 });
        await fs.writeFile(file, 'foreign', { mode: 0o600 }); changed = true;
      };
    }
    return handle;
  };
  try { await assert.rejects(writeIntakeStage(store, 'state', 'stage-parent/owned.tmp', Buffer.from('private evidence'), async () => {}), error => error === failure); }
  finally { fs.open = open; }
  assert(changed); assert(failure.cleanupWarnings?.length);
  await assert.rejects(guardStore(store, [file]), /INTAKE_ROOT_CHANGED/);
  assert.equal(await fs.readFile(file, 'utf8'), 'foreign');
  assert.equal(await fs.readFile(path.join(parent + '-old', 'owned.tmp'), 'utf8'), '', 'source bytes were never written outside guarded storage');
}));

test('metadata rename rechecks the destination chain after inspecting stage ownership', async t => withStorageProbes(async () => {
  const f = await storageFixture(t), store = await inspectIntakeStore(f.collection), original = fs.open;
  const parent = path.join(f.collection.intakeStateDir, 'destination');
  await intakePath(store, 'state', 'destination/record.json', { createParents: true });
  let changed = false;
  fs.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (!changed && path.basename(file).startsWith('.metadata-') && args[0] !== 'wx') {
      changed = true; await fs.rename(parent, parent + '-old'); await fs.mkdir(parent, { mode: 0o700 });
      await fs.writeFile(path.join(parent, 'record.json'), 'foreign', { mode: 0o600 });
    }
    return handle;
  };
  try {
    await assert.rejects(withIntakeLock(store, tx => replaceIntakeJSON(tx, 'destination/record.json', { value: 'ours' }, null)), /INTAKE_ROOT_CHANGED/);
  } finally { fs.open = original; }
  assert.equal(changed, true);
  assert.equal(await fs.readFile(path.join(parent, 'record.json'), 'utf8'), 'foreign');
}));


test('a missing-parent lookup rechecks ancestors traversed before the miss', async t => withStorageProbes(async () => {
  const f = await storageFixture(t), store = await inspectIntakeStore(f.collection), parent = path.join(f.collection.intakeStateDir, 'parent');
  await intakePath(store, 'state', 'parent/.list', { createParents: true });
  const lstat = fs.lstat; let replaced = false;
  fs.lstat = async (file, ...args) => {
    if (!replaced && file === path.join(parent, 'missing')) {
      replaced = true; await fs.rename(parent, parent + '-old'); await fs.mkdir(parent, { mode: 0o700 });
    }
    return lstat(file, ...args);
  };
  try { await assert.rejects(intakePath(store, 'state', 'parent/missing/record.json'), /INTAKE_ROOT_CHANGED/); }
  finally { fs.lstat = lstat; }
  assert(replaced);
}));


test('exclusive ingress publication preserves a replaced registration parent', async t => withStorageProbes(async () => {
  const { publishIngressMetadata } = await import('./collection-ingress.mjs');
  const f = await storageFixture(t), store = await inspectIntakeStore(f.collection);
  const parent = path.join(f.collection.intakeStateDir, 'ingress/registrations/codex/aa');
  const destination = path.join(parent, 'session'), lstat = fs.lstat; let changed = false;
  fs.lstat = async (file, ...args) => {
    if (!changed && file === destination && await lstat(parent).then(() => true, () => false)) {
      changed = true; await fs.rename(parent, parent + '-old'); await fs.mkdir(parent, { mode: 0o700 });
      await fs.writeFile(path.join(parent, 'foreign'), 'preserved', { mode: 0o600 });
    }
    return lstat(file, ...args);
  };
  try {
    await assert.rejects(publishIngressMetadata(store, 'ingress/registrations/codex/aa/session/record.json', { value: 'ours' }, { exclusive: true }), /INTAKE_ROOT_CHANGED/);
  } finally { fs.lstat = lstat; }
  assert(changed); assert.equal(await fs.readFile(path.join(parent, 'foreign'), 'utf8'), 'preserved');
  assert.equal(await fs.lstat(destination).catch(e => e.code), 'ENOENT');
  assert.deepEqual(await fs.readdir(path.join(f.collection.intakeStateDir, 'ingress/stages')), []);
}));
