import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { prepareWorkflowStorage, assertWorkflowStorage, assertPrivatePaths } from './workflow-storage.mjs';
import { ACL_PROBE, systemCommand, windowsTools, probeEnvironment, hidePrivateDirectory, protectNewDirectory, privacyIdentity } from './storage-platform.mjs';
import { sameFileIdentity } from './file-io.mjs';
import { prepareConfiguredStorage } from './workflow-settings.mjs';
import { digest } from './workflow-values.mjs';
import { inspectIntakeStore, withIntakeLock } from './intake-io.mjs';

async function attributes(paths) {
  const values = JSON.parse(await systemCommand(windowsTools().powershell,
    ['-NoProfile', '-NonInteractive', '-Command', ACL_PROBE], { env: probeEnvironment(JSON.stringify(paths)) }));
  assert.deepEqual(values.map(value => value.path), paths);
  return values.map(value => value.attributes);
}

test('dot-prefixed raw storage stays usable and repeated setup preserves existing captures and settings', async t => {
  const f = await storageFixture(t, { rawName: '.cuefluent-raw' });
  const file = path.join(f.collection.rawDir, 'a'.repeat(20) + '.json'), bytes = '{"evidence":"synthetic"}\n';
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const original = await fs.lstat(f.collection.rawDir, { bigint: true });
  const settings = await fs.readFile(f.options.configPath);
  await prepareWorkflowStorage(f.options);
  await assertWorkflowStorage(f.capability);
  await assertPrivatePaths(f.capability, [file]);
  assert.ok(sameFileIdentity(original, await fs.lstat(f.collection.rawDir, { bigint: true })));
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.deepEqual(await fs.readdir(f.collection.rawDir), [path.basename(file)]);
  assert.deepEqual(await fs.readFile(f.options.configPath), settings);
});

test('Windows setup hides only the raw root, supports custom names and restores its visibility attribute on retry',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await storageFixture(t, { rawName: 'raw Unicode-会議 & $(data)' });
    const file = path.join(f.collection.rawDir, 'capture.json');
    await fs.writeFile(file, '{}', { mode: 0o600 });
    const paths = [f.collection.rawDir, f.collection.intakeStateDir, f.collection.notes.writerStateDir, f.root, file];
    assert.deepEqual((await attributes(paths)).map(value => Boolean(value & 2)), [true, false, false, false, false]);
    const original = await fs.lstat(f.collection.rawDir, { bigint: true });
    const settings = await fs.readFile(f.options.configPath);
    await systemCommand(windowsTools().attrib, ['-H', f.collection.rawDir, '/L']);
    await assertWorkflowStorage(f.capability); // Visibility is not capture authorization.
    assert.equal((await attributes([f.collection.rawDir]))[0] & 2, 0);
    await prepareWorkflowStorage(f.options);
    assert.deepEqual((await attributes(paths)).map(value => Boolean(value & 2)), [true, false, false, false, false]);
    assert.ok(sameFileIdentity(original, await fs.lstat(f.collection.rawDir, { bigint: true })));
    assert.equal(await fs.readFile(file, 'utf8'), '{}');
    assert.deepEqual(await fs.readFile(f.options.configPath), settings);
  });

test('Windows setup validates every private root before changing raw visibility',
  { skip: process.platform !== 'win32' }, async t => {
    for (const target of ['raw', 'intake', 'writer']) {
      const f = await storageFixture(t);
      const root = { raw: f.collection.rawDir, intake: f.collection.intakeStateDir, writer: f.collection.notes.writerStateDir }[target];
      await systemCommand(windowsTools().attrib, ['-H', f.collection.rawDir, '/L']);
      await systemCommand(windowsTools().icacls, [root, '/grant', '*S-1-1-0:(OI)(CI)R']);
      await assert.rejects(prepareWorkflowStorage(f.options), { code: 'STORAGE_NOT_PRIVATE' });
      assert.equal((await attributes([f.collection.rawDir]))[0] & 2, 0);
    }
  });

test('reapplying hidden defaults cannot pair a missing raw root with existing intake history', async t => {
  const f = await storageFixture(t);
  const capture = path.join(f.collection.rawDir, 'capture.json'); await fs.writeFile(capture, '{}', { mode: 0o600 });
  const replacement = path.join(f.root, '.cuefluent-raw');
  f.config.collections[0].rawDir = replacement;
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  await assert.rejects(prepareWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) }), { code: 'PRIVATE_SETUP_CONFLICT' });
  await assert.rejects(fs.stat(replacement), { code: 'ENOENT' });
  assert.equal(await fs.readFile(capture, 'utf8'), '{}');
});

for (const change of ['removed', 'replaced']) test(`a raw root ${change} after the initial check is never recreated or adopted`, async t => {
  const f = await storageFixture(t, { fullSetup: false });
  const raw = f.collection.rawDir, retained = raw + '-retained';
  await fs.writeFile(path.join(raw, 'capture.json'), '{}', { mode: 0o600 });
  await fs.writeFile(path.join(f.collection.intakeStateDir, 'history.json'), '{}', { mode: 0o600 });
  const lstat = fs.lstat, mkdir = fs.mkdir; let rawStats = 0, changed = false, creations = 0;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    const stat = await lstat(file, ...args);
    // Placement inspects raw first; the next snapshot decides whether setup
    // must check intake history. Change the path after that snapshot is read.
    if (file === raw && ++rawStats === 2) {
      await fs.rename(raw, retained); changed = true;
      if (change === 'replaced') {
        await mkdir(raw, { mode: 0o700 });
        await protectNewDirectory(raw, await privacyIdentity());
      }
    }
    return stat;
  });
  t.mock.method(fs, 'mkdir', (file, ...args) => { if (file === raw) creations++; return mkdir(file, ...args); });
  await assert.rejects(prepareConfiguredStorage(f.options), { code: 'PRIVATE_STORAGE_CHANGED' });
  assert.equal(changed, true);
  assert.equal(creations, 0);
  assert.equal(await fs.readFile(path.join(retained, 'capture.json'), 'utf8'), '{}');
  assert.equal(await fs.readFile(path.join(f.collection.intakeStateDir, 'history.json'), 'utf8'), '{}');
  if (change === 'removed') await assert.rejects(lstat(raw), { code: 'ENOENT' });
  else assert.deepEqual(await fs.readdir(raw), []);
});

test('a raw root introduced after the empty-intake check is not adopted', async t => {
  const f = await storageFixture(t, { fullSetup: false });
  const raw = f.collection.rawDir;
  await fs.rmdir(raw);
  await fs.rmdir(path.join(f.collection.intakeStateDir, 'metadata-stages'));
  const opendir = fs.opendir; let changed = false;
  t.mock.method(fs, 'opendir', async (file, ...args) => {
    const directory = await opendir(file, ...args);
    if (file === f.collection.intakeStateDir && !changed) {
      const close = directory.close;
      t.mock.method(directory, 'close', async (...values) => {
        await close.apply(directory, values);
        await fs.mkdir(raw, { mode: 0o700 });
        await protectNewDirectory(raw, await privacyIdentity());
        await fs.writeFile(path.join(raw, 'foreign.json'), '{}', { mode: 0o600 });
        changed = true;
      });
    }
    return directory;
  });
  await assert.rejects(prepareConfiguredStorage(f.options), { code: 'PRIVATE_STORAGE_CHANGED' });
  assert.equal(changed, true);
  assert.equal(await fs.readFile(path.join(raw, 'foreign.json'), 'utf8'), '{}');
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), []);
});

test('a raw root replaced after its setup probe cannot pass final verification', async t => {
  const f = await storageFixture(t, { fullSetup: false });
  const raw = f.collection.rawDir, retained = raw + '-retained';
  await fs.writeFile(path.join(raw, 'capture.json'), '{}', { mode: 0o600 });
  const rmdir = fs.rmdir; let changed = false;
  t.mock.method(fs, 'rmdir', async (file, ...args) => {
    await rmdir(file, ...args);
    if (!changed && path.dirname(file) === raw && path.basename(file).startsWith('.privacy-probe-')) {
      await fs.rename(raw, retained);
      await fs.mkdir(raw, { mode: 0o700 });
      await protectNewDirectory(raw, await privacyIdentity());
      changed = true;
    }
  });
  await assert.rejects(prepareConfiguredStorage(f.options), { code: 'PRIVATE_STORAGE_CHANGED' });
  assert.equal(changed, true);
  assert.equal(await fs.readFile(path.join(retained, 'capture.json'), 'utf8'), '{}');
  assert.deepEqual(await fs.readdir(raw), []);
});

for (const timing of ['existing', 'replaced after placement']) test(`${timing} intake links are rejected before directory enumeration`, async t => {
  const f = await storageFixture(t, { fullSetup: false });
  await fs.rmdir(f.collection.rawDir);
  const intake = f.collection.intakeStateDir, retained = intake + '-retained';
  const marker = path.join(intake, 'keep.json'); await fs.writeFile(marker, '{}', { mode: 0o600 });
  const substitute = async () => {
    await fs.rename(intake, retained);
    await fs.symlink(retained, intake, process.platform === 'win32' ? 'junction' : 'dir');
  };
  if (timing === 'existing') await substitute();
  else {
    const realpath = fs.realpath; let replaced = false;
    t.mock.method(fs, 'realpath', async (file, ...args) => {
      const result = await realpath(file, ...args);
      if (file === intake && !replaced) { replaced = true; await substitute(); }
      return result;
    });
  }
  const opendir = fs.opendir; let opens = 0;
  t.mock.method(fs, 'opendir', (file, ...args) => { if (file === intake || file === retained) opens++; return opendir(file, ...args); });
  await assert.rejects(prepareWorkflowStorage(f.options), {
    code: timing === 'existing' ? 'UNSAFE_WORKFLOW_PATH' : 'UNSAFE_PRIVATE_STORAGE',
  });
  assert.equal(opens, 0);
  assert.equal(await fs.readFile(path.join(retained, 'keep.json'), 'utf8'), '{}');
  await assert.rejects(fs.stat(f.collection.rawDir), { code: 'ENOENT' });
});

test('setup holds the normal intake lock while creating a raw root and never steals an existing owner', async t => {
  const f = await storageFixture(t, { fullSetup: false });
  await fs.rmdir(f.collection.rawDir);
  await fs.rmdir(path.join(f.collection.intakeStateDir, 'metadata-stages'));
  const mkdir = fs.mkdir; let blocked = false;
  t.mock.method(fs, 'mkdir', async (file, ...args) => {
    const result = await mkdir(file, ...args);
    if (file === f.collection.rawDir) {
      const store = await inspectIntakeStore(f.collection);
      await assert.rejects(withIntakeLock(store, () => assert.fail('collector entered during setup')), { code: 'INTAKE_BLOCKED' });
      blocked = true;
    }
    return result;
  });
  await prepareWorkflowStorage(f.options);
  assert.equal(blocked, true);
  const store = await inspectIntakeStore(f.collection);
  await withIntakeLock(store, async () => {
    const owner = path.join(f.collection.intakeStateDir, '.intake-lock', 'owner.json');
    const bytes = await fs.readFile(owner);
    await assert.rejects(prepareWorkflowStorage(f.options), { code: 'INTAKE_BLOCKED' });
    assert.deepEqual(await fs.readFile(owner), bytes);
  });
});

for (const timing of ['after empty read', 'after close', 'during raw creation']) for (const change of ['content', 'replacement'])
  test(`intake ${change} ${timing} cannot be paired with a new raw root`, async t => {
    const f = await storageFixture(t, { fullSetup: false });
    const intake = f.collection.intakeStateDir;
    await fs.rmdir(f.collection.rawDir);
    await fs.rmdir(path.join(intake, 'metadata-stages'));
    let changed = false;
    const changeIntake = async () => {
      if (changed) return;
      changed = true;
      if (change === 'replacement') {
        await fs.rename(intake, intake + '-retained');
        await fs.mkdir(intake, { mode: 0o700 });
        await protectNewDirectory(intake, await privacyIdentity());
      }
      await fs.writeFile(path.join(intake, 'history.json'), '{}', { mode: 0o600 });
    };
    if (timing === 'during raw creation') {
      const mkdir = fs.mkdir;
      t.mock.method(fs, 'mkdir', async (file, ...args) => {
        const result = await mkdir(file, ...args);
        if (file === f.collection.rawDir) await changeIntake();
        return result;
      });
    } else {
      const opendir = fs.opendir;
      t.mock.method(fs, 'opendir', async (file, ...args) => {
        const directory = await opendir(file, ...args);
        if (file === intake && !changed) {
          if (timing === 'after empty read') {
            const read = directory.read;
            t.mock.method(directory, 'read', async (...values) => {
              const entry = await read.apply(directory, values);
              if (!entry) await changeIntake();
              return entry;
            });
          } else {
            const close = directory.close;
            t.mock.method(directory, 'close', async (...values) => { await close.apply(directory, values); await changeIntake(); });
          }
        }
        return directory;
      });
    }
    await assert.rejects(prepareConfiguredStorage(f.options), { code: 'PRIVATE_STORAGE_CHANGED' });
    assert.equal(changed, true);
    assert.equal(await fs.readFile(path.join(intake, 'history.json'), 'utf8'), '{}');
    await assert.rejects(fs.stat(f.collection.rawDir), { code: 'ENOENT' });
  });

for (const timing of ['before protection', 'during rollback'])
  test(`unsafe raw rollback ${timing} retains the lock and blocks retries without deleting content`, async t => {
    const f = await storageFixture(t, { fullSetup: false });
    const raw = f.collection.rawDir, intake = f.collection.intakeStateDir;
    await fs.rmdir(raw);
    await fs.rmdir(path.join(intake, 'metadata-stages'));
    const mkdir = fs.mkdir; let injected = false;
    t.mock.method(fs, 'mkdir', async (file, ...args) => {
      const result = await mkdir(file, ...args);
      if (file === raw) {
        await fs.writeFile(path.join(intake, 'history.json'), '{}', { mode: 0o600 });
        if (timing === 'before protection') {
          await fs.writeFile(path.join(raw, 'keep.json'), '{}', { mode: 0o600 });
          injected = true;
        }
      }
      return result;
    });
    const rmdir = fs.rmdir;
    t.mock.method(fs, 'rmdir', async (file, ...args) => {
      if (file === raw && timing === 'during rollback') {
        await fs.writeFile(path.join(raw, 'keep.json'), '{}', { mode: 0o600 });
        injected = true;
      }
      return rmdir(file, ...args);
    });
    await assert.rejects(prepareWorkflowStorage(f.options), error =>
      error.code === (timing === 'before protection' ? 'PRIVATE_SETUP_CONFLICT' : 'PRIVATE_STORAGE_CHANGED') && error.cleanupWarnings?.length === 2);
    assert.equal(injected, true);
    const owner = path.join(intake, '.intake-lock', 'owner.json'), bytes = await fs.readFile(owner);
    await assert.rejects(prepareWorkflowStorage(f.options), { code: 'INTAKE_BLOCKED' });
    assert.deepEqual(await fs.readFile(owner), bytes);
    assert.equal(await fs.readFile(path.join(raw, 'keep.json'), 'utf8'), '{}');
    assert.equal(await fs.readFile(path.join(intake, 'history.json'), 'utf8'), '{}');
  });

test('an unchanged empty intake root can be prepared with a new raw root', async t => {
  const f = await storageFixture(t, { fullSetup: false });
  await fs.rmdir(f.collection.rawDir);
  await fs.rmdir(path.join(f.collection.intakeStateDir, 'metadata-stages'));
  const original = await fs.lstat(f.collection.intakeStateDir, { bigint: true });
  const capability = await prepareWorkflowStorage(f.options);
  await assertWorkflowStorage(capability);
  assert.ok(sameFileIdentity(original, await fs.lstat(f.collection.intakeStateDir, { bigint: true })));
  assert.deepEqual(await fs.readdir(f.collection.rawDir), []);
});

for (const change of ['link', 'replacement', 'restored replacement', 'permissions']) test(`intake ${change} at directory open is rejected before reading entries`, async t => {
  const f = await storageFixture(t, { fullSetup: false });
  await fs.rmdir(f.collection.rawDir);
  const intake = f.collection.intakeStateDir, retained = intake + '-retained';
  await fs.writeFile(path.join(intake, 'keep.json'), '{}', { mode: 0o600 });
  const opendir = fs.opendir; let opens = 0, reads = 0, closes = 0;
  t.mock.method(fs, 'opendir', async (file, ...args) => {
    if (file !== intake) return opendir(file, ...args);
    opens++;
    if (change === 'permissions') {
      if (process.platform === 'win32') await systemCommand(windowsTools().icacls, [intake, '/grant', '*S-1-1-0:(OI)(CI)R']);
      else await fs.chmod(intake, 0o750);
    } else {
      await fs.rename(intake, retained);
      if (change === 'link') await fs.symlink(retained, intake, process.platform === 'win32' ? 'junction' : 'dir');
      else {
        const substitute = change === 'restored replacement' ? intake + '-substitute' : intake;
        await fs.mkdir(substitute, { mode: 0o700 });
        await protectNewDirectory(substitute, await privacyIdentity());
        await fs.writeFile(path.join(substitute, 'unrelated.json'), '{}', { mode: 0o600 });
        if (change === 'restored replacement') await fs.symlink(substitute, intake, process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    const directory = await opendir(file, ...args), read = directory.read, close = directory.close;
    if (change === 'restored replacement') {
      try {
        // Keep the opened target at its own path; Windows need not rename an
        // open directory to reproduce a temporary redirection during opendir.
        await fs.unlink(intake);
        await fs.rename(retained, intake);
      } catch (error) { await directory.close(); throw error; }
    }
    t.mock.method(directory, 'read', (...values) => { reads++; return read.apply(directory, values); });
    t.mock.method(directory, 'close', (...values) => { closes++; return close.apply(directory, values); });
    return directory;
  });
  await assert.rejects(prepareWorkflowStorage(f.options), { code: {
    link: 'UNSAFE_PRIVATE_STORAGE', replacement: 'PRIVATE_STORAGE_CHANGED',
    'restored replacement': 'PRIVATE_STORAGE_CHANGED', permissions: 'STORAGE_NOT_PRIVATE',
  }[change] });
  assert.equal(opens, 1);
  assert.equal(reads, 0);
  assert.equal(closes, 1);
  const original = ['permissions', 'restored replacement'].includes(change) ? intake : retained;
  assert.equal(await fs.readFile(path.join(original, 'keep.json'), 'utf8'), '{}');
  await assert.rejects(fs.stat(f.collection.rawDir), { code: 'ENOENT' });
});

for (const unsafe of ['permissions', 'sync']) test(`intake ${unsafe} validation precedes the nonempty-directory check`, async t => {
  const f = await storageFixture(t, { fullSetup: false });
  await fs.rmdir(f.collection.rawDir);
  let intake = f.collection.intakeStateDir, options = f.options;
  if (unsafe === 'permissions') {
    if (process.platform === 'win32') await systemCommand(windowsTools().icacls, [intake, '/grant', '*S-1-1-0:(OI)(CI)R']);
    else await fs.chmod(intake, 0o750);
  } else {
    intake = path.join(f.root, 'OneDrive', 'state'); await fs.mkdir(intake, { recursive: true, mode: 0o700 });
    f.config.collections[0].intakeStateDir = intake;
    const bytes = JSON.stringify(f.config); await fs.writeFile(options.configPath, bytes);
    options = { ...options, expectedConfigHash: digest(bytes) };
  }
  const marker = path.join(intake, 'keep.json'); await fs.writeFile(marker, '{}', { mode: 0o600 });
  const opendir = fs.opendir; let opens = 0;
  t.mock.method(fs, 'opendir', (file, ...args) => { if (file === intake) opens++; return opendir(file, ...args); });
  await assert.rejects(prepareWorkflowStorage(options), { code: unsafe === 'permissions' ? 'STORAGE_NOT_PRIVATE' : 'SYNCED_WORKFLOW_STORAGE' });
  assert.equal(opens, 0);
  assert.equal(await fs.readFile(marker, 'utf8'), '{}');
  await assert.rejects(fs.stat(f.collection.rawDir), { code: 'ENOENT' });
});

test('POSIX setup does not enter the Windows visibility path', { skip: process.platform === 'win32' }, async t => {
  const f = await storageFixture(t);
  await prepareWorkflowStorage(f.options, { visibility: () => assert.fail('Windows visibility was invoked') });
  await assert.rejects(hidePrivateDirectory({}, null, () => {}), { code: 'PRIVACY_PLATFORM_UNSUPPORTED' });
});

test('Windows repeated setup skips attrib when its verified raw root is already hidden',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await storageFixture(t); let invoked = false, commands = 0;
    await prepareWorkflowStorage(f.options, { visibility: async (entry, identity, guard) => {
      invoked = true;
      const before = await fs.lstat(entry.path, { bigint: true });
      const result = await hidePrivateDirectory(entry, identity, guard, { command: async () => { commands++; } });
      assert.equal((await fs.lstat(entry.path, { bigint: true })).ctimeNs, before.ctimeNs);
      return result;
    } });
    assert.equal(invoked, true);
    assert.equal(commands, 0);
  });

test('Windows hiding refusal is a setup warning while privacy failures remain fatal',
  { skip: process.platform !== 'win32' }, async t => {
    for (const outcome of ['blocked', 'unchanged', 'unsafe']) {
      const f = await storageFixture(t); let calls = 0;
      await systemCommand(windowsTools().attrib, ['-H', f.collection.rawDir, '/L']);
      const prepare = () => prepareConfiguredStorage(f.options, { visibility: (entry, identity, guard) =>
        hidePrivateDirectory(entry, identity, guard, { command: async () => {
          calls++;
          if (outcome === 'blocked') throw new Error('blocked attrib');
          if (outcome === 'unsafe') await systemCommand(windowsTools().icacls, [entry.path, '/grant', '*S-1-1-0:(OI)(CI)R']);
        } }) });
      if (outcome === 'unsafe') await assert.rejects(prepare(), { code: 'STORAGE_NOT_PRIVATE' });
      else {
        const result = await prepare();
        assert.equal(result.status, 'storage-ready');
        assert.deepEqual(result.warnings, ['STORAGE_VISIBILITY_FAILED']);
        await assertWorkflowStorage(f.capability);
      }
      assert.equal(calls, 1);
      assert.equal((await attributes([f.collection.rawDir]))[0] & 2, 0);
    }
  });

for (const scenario of ['newly hidden becomes visible', 'already hidden becomes visible', 'failed hide becomes hidden'])
  test(`Windows setup uses final visibility when ${scenario}`, { skip: process.platform !== 'win32' }, async t => {
    const f = await storageFixture(t, { fullSetup: false });
    if (scenario === 'already hidden becomes visible') await systemCommand(windowsTools().attrib, ['+H', f.collection.rawDir, '/L']);
    const finalHidden = scenario === 'failed hide becomes hidden';
    let calls = 0;
    const result = await prepareConfiguredStorage(f.options, { visibility: async (entry, identity, guard) => {
      const warning = await hidePrivateDirectory(entry, identity, guard, { command: async (executable, args) => {
        calls++;
        if (!finalHidden) await systemCommand(executable, args);
      } });
      assert.equal(warning, finalHidden ? 'STORAGE_VISIBILITY_FAILED' : undefined);
      await systemCommand(windowsTools().attrib, [finalHidden ? '+H' : '-H', entry.path, '/L']);
      return warning;
    } });
    assert.equal(calls, scenario === 'already hidden becomes visible' ? 0 : 1);
    assert.equal(result.status, 'storage-ready');
    assert.deepEqual(result.warnings, finalHidden ? undefined : ['STORAGE_VISIBILITY_FAILED']);
    assert.equal(Boolean((await attributes([f.collection.rawDir]))[0] & 2), finalHidden);
  });

test('Windows policy changes after verification prevent attrib from touching the stale root',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await storageFixture(t); let calls = 0;
    await systemCommand(windowsTools().attrib, ['-H', f.collection.rawDir, '/L']);
    await assert.rejects(prepareWorkflowStorage(f.options, { visibility: async (entry, identity, guard) => {
      await fs.appendFile(f.options.configPath, ' ');
      return hidePrivateDirectory(entry, identity, guard, { command: async () => { calls++; } });
    } }), { code: 'WORKFLOW_POLICY_CHANGED' });
    assert.equal(calls, 0);
    assert.equal((await attributes([f.collection.rawDir]))[0] & 2, 0);
  });

for (const target of ['intake', 'writer']) for (const change of ['permissions', 'replacement'])
  test(`Windows setup rejects ${target} ${change} changes during raw hiding`,
    { skip: process.platform !== 'win32' }, async t => {
      const f = await storageFixture(t, { fullSetup: false });
      const root = target === 'intake' ? f.collection.intakeStateDir : f.collection.notes.writerStateDir;
      const marker = path.join(root, 'keep.json'); await fs.writeFile(marker, '{}', { mode: 0o600 });
      let calls = 0;
      await assert.rejects(prepareConfiguredStorage(f.options, { visibility: (entry, identity, guard) =>
        hidePrivateDirectory(entry, identity, guard, { command: async (executable, args) => {
          await systemCommand(executable, args);
          if (change === 'permissions') await systemCommand(windowsTools().icacls, [root, '/grant', '*S-1-1-0:(OI)(CI)R']);
          else {
            await fs.rename(root, root + '-retained');
            await fs.mkdir(root, { mode: 0o700 });
            await protectNewDirectory(root, identity);
          }
          calls++;
        } }) }), { code: change === 'permissions' ? 'STORAGE_NOT_PRIVATE' : 'PRIVATE_STORAGE_CHANGED' });
      assert.equal(calls, 1);
      assert.equal(await fs.readFile(change === 'replacement' ? path.join(root + '-retained', 'keep.json') : marker, 'utf8'), '{}');
    });
