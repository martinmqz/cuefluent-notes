import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProject, emptySettings } from '../src/core/settings.mjs';
import { describeFailure } from '../src/diagnostics.mjs';
import { initializeStore, openStore, readSettings, updateSettings, withProject, gateOptions } from '../src/storage/store.mjs';
import { createPrivateDirectory } from '../src/storage/paths.mjs';
import { tryAcquireExistingGate } from '../src/storage/gates.mjs';
import { interruptRemoval } from './fixtures/exact-removal-worker.mjs';
import { readSnapshot, writeJSON } from '../src/storage/files.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-store-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot);
  const project = createProject({ id: 'demo', root: projectRoot, destination: { kind: 'directory', path: path.join(root, 'notes') } });
  const privateRoot = path.join(root, 'private');
  return { root, privateRoot, project, settings: { schemaVersion: 1, projects: [project] } };
}

async function snapshots(root, files) {
  return Promise.all(files.map(async relative => {
    const file = path.join(root, relative), stat = await fs.lstat(file, { bigint: true });
    return { relative, device: stat.dev, inode: stat.ino, size: stat.size, modified: stat.mtimeNs,
      ...(relative.endsWith('.sqlite') ? {} : { bytes: await fs.readFile(file) }) };
  }));
}

// A filesystem clock need not advance for every namespace mutation. Control
// observations at acquisition so retry coverage does not depend on its precision.
function acquisitionEpoch(parent) {
  const observed = nativeFs.lstatSync(parent, { bigint: true });
  let epoch = 0n;
  return {
    advance() { epoch++; },
    observe(file, stat) {
      if (file === parent) {
        stat.ctimeNs = observed.ctimeNs + epoch;
        stat.mtimeNs = observed.mtimeNs + epoch;
      }
      return stat;
    },
  };
}

test('unconfigured status and invalid first setup make zero writes', async t => {
  const f = await fixture(t);
  assert.equal(await openStore(f.privateRoot), null);
  assert.deepEqual(await readSettings(null), { value: emptySettings(), hash: null });
  await assert.rejects(initializeStore(f.privateRoot, { schemaVersion: 99, projects: [] }), { code: 'SETTINGS_SCHEMA_UNSUPPORTED' });
  assert.deepEqual(await fs.readdir(f.root), ['project']);
});

test('fresh setup refuses unrelated root and scaffold entries without adding metadata', async t => {
  for (const relative of ['retained-store/pending.json', 'collections/note.md', 'config/unrelated.json', 'store/unrelated.json', 'store/locks/unrelated.sqlite']) {
    const f = await fixture(t), file = path.join(f.privateRoot, relative);
    await createPrivateDirectory(path.dirname(file));
    await fs.writeFile(file, 'Synthetic retained input.\n', { mode: 0o600 });
    const before = await snapshots(f.privateRoot, [relative]);
    const entries = await fs.readdir(f.privateRoot, { recursive: true });
    await assert.rejects(initializeStore(f.privateRoot), { code: 'STORE_ROOT_OCCUPIED' });
    assert.deepEqual(await snapshots(f.privateRoot, [relative]), before);
    assert.deepEqual(await fs.readdir(f.privateRoot, { recursive: true }), entries);
  }
});

test('setup tolerates sibling entry churn during fresh and interrupted initialization', async t => {
  for (const interrupted of [false, true]) await t.test(interrupted ? 'interrupted' : 'fresh', async t => {
    const f = await fixture(t);
    let gates;
    if (interrupted) {
      const store = await initializeStore(f.privateRoot);
      gates = [store.settingsGate, store.writerGate, store.syncGate];
      await fs.unlink(path.join(f.privateRoot, 'config/settings.json'));
    }
    const retained = path.join(f.root, 'retained-sibling.txt');
    await fs.writeFile(retained, 'Synthetic neighboring content.\n');
    const before = await snapshots(f.root, ['retained-sibling.txt']);
    const opendir = nativeFs.opendirSync; let churn = 0;
    const injection = t.mock.method(nativeFs, 'opendirSync', (...args) => {
      const stream = opendir(...args);
      if (args[0] !== f.privateRoot) return stream;
      return { closeSync: () => stream.closeSync(), close: () => stream.close(), read: async () => {
        const sibling = path.join(f.root, `neighbor-${churn++}`), renamed = `${sibling}-renamed`;
        await fs.writeFile(sibling, 'Synthetic unrelated write.\n');
        await fs.rename(sibling, renamed);
        await fs.unlink(renamed);
        return stream.read();
      } };
    });
    let store;
    try { store = await initializeStore(f.privateRoot, f.settings); }
    finally { injection.mock.restore(); }
    assert.ok(churn > 0, 'fixture must change the parent while its store is inspected');
    assert.deepEqual((await readSettings(store)).value, f.settings);
    if (gates) assert.deepEqual([store.settingsGate, store.writerGate, store.syncGate], gates);
    assert.deepEqual(await snapshots(f.root, ['retained-sibling.txt']), before);
  });
});

test('setup retries transient sibling activity during root directory acquisition', async t => {
  const f = await fixture(t), opendir = nativeFs.opendirSync, lstat = nativeFs.lstatSync;
  const epoch = acquisitionEpoch(f.root);
  const observation = t.mock.method(nativeFs, 'lstatSync', (...args) => epoch.observe(args[0], lstat(...args)));
  let injected = false, rejectedClosed = false;
  const injection = t.mock.method(nativeFs, 'opendirSync', (...args) => {
    const stream = opendir(...args);
    if (args[0] !== f.privateRoot || injected) return stream;
    injected = true;
    const sibling = path.join(f.root, 'transient-sibling');
    nativeFs.writeFileSync(sibling, 'Synthetic neighbor.'); nativeFs.unlinkSync(sibling);
    epoch.advance();
    return { closeSync() { rejectedClosed = true; stream.closeSync(); } };
  });
  let store;
  try { store = await initializeStore(f.privateRoot, f.settings); }
  finally { injection.mock.restore(); observation.mock.restore(); }
  assert.equal(injected, true); assert.equal(rejectedClosed, true);
  assert.deepEqual((await readSettings(store)).value, f.settings);
});

test('sustained acquisition interference can retry after layout publication with the same gates', async t => {
  const f = await fixture(t), layoutFile = path.join(f.privateRoot, 'store/layout.json');
  const opendir = nativeFs.opendirSync, lstat = nativeFs.lstatSync; let churn = 0;
  const epoch = acquisitionEpoch(f.root);
  const observation = t.mock.method(nativeFs, 'lstatSync', (...args) => epoch.observe(args[0], lstat(...args)));
  const injection = t.mock.method(nativeFs, 'opendirSync', (...args) => {
    const stream = opendir(...args);
    if (args[0] === f.privateRoot && nativeFs.existsSync(layoutFile)) {
      const sibling = path.join(f.root, `interference-${churn++}`);
      nativeFs.writeFileSync(sibling, 'Synthetic neighbor.'); nativeFs.unlinkSync(sibling);
      epoch.advance();
    }
    return stream;
  });
  try { await assert.rejects(initializeStore(f.privateRoot), { code: 'STORE_SETUP_BUSY' }); }
  finally { injection.mock.restore(); observation.mock.restore(); }
  assert.ok(churn > 1 && churn <= 64);
  const before = await fs.readFile(layoutFile);
  await assert.rejects(fs.stat(path.join(f.privateRoot, 'config/settings.json')), { code: 'ENOENT' });
  const store = await initializeStore(f.privateRoot), layout = JSON.parse(before);
  assert.deepEqual(await fs.readFile(layoutFile), before);
  assert.deepEqual([store.settingsGate, store.writerGate, store.syncGate], [layout.settingsGate, layout.writerGate, layout.syncGate]);
  assert.deepEqual((await readSettings(store)).value, emptySettings());
});

test('setup refuses a root entry arriving during inspection before creating its scaffold', async t => {
  const f = await fixture(t); await createPrivateDirectory(f.privateRoot);
  const opendir = nativeFs.opendirSync; let injected = false;
  const injection = t.mock.method(nativeFs, 'opendirSync', (...args) => {
    const stream = opendir(...args);
    if (args[0] === f.privateRoot && !injected) {
      injected = true;
      nativeFs.writeFileSync(path.join(f.privateRoot, 'retained'), 'Synthetic retained input.\n', { mode: 0o600 });
    }
    return stream;
  });
  try { await assert.rejects(initializeStore(f.privateRoot), { code: 'STORE_INCOMPLETE' }); }
  finally { injection.mock.restore(); }
  assert.equal(injected, true);
  assert.deepEqual(await fs.readdir(f.privateRoot), ['retained']);
  assert.equal(await fs.readFile(path.join(f.privateRoot, 'retained'), 'utf8'), 'Synthetic retained input.\n');
});

test('root replacement and restoration cannot hide retained work during acquisition', async t => {
  for (const mode of ['once', 'repeated', 'replaced']) await t.test(mode === 'repeated' ? 'repeated distinct observations' : mode, async t => {
    const f = await fixture(t); await createPrivateDirectory(f.privateRoot);
    await fs.writeFile(path.join(f.privateRoot, 'retained'), 'Synthetic retained input.\n', { mode: 0o600 });
    const moved = path.join(f.root, 'original-private'), replacement = path.join(f.root, 'replacement');
    await createPrivateDirectory(replacement);
    const opendir = nativeFs.opendirSync, lstat = fs.lstat, lstatSync = nativeFs.lstatSync;
    const observed = await lstat(f.privateRoot, { bigint: true }), epoch = acquisitionEpoch(f.root);
    let opens = 0, closed = 0;
    const stableTimes = (file, stat) => {
      if (file === f.privateRoot) { stat.ctimeNs = observed.ctimeNs; stat.mtimeNs = observed.mtimeNs; }
      return epoch.observe(file, stat);
    };
    const statInjection = t.mock.method(fs, 'lstat', async (...args) => stableTimes(args[0], await lstat(...args)));
    const syncStatInjection = t.mock.method(nativeFs, 'lstatSync', (...args) => stableTimes(args[0], lstatSync(...args)));
    const injection = t.mock.method(nativeFs, 'opendirSync', (...args) => {
      if (args[0] !== f.privateRoot || (opens && mode === 'once')) return opendir(...args);
      opens++;
      // Exercise actual substitution once. Repeated acquisition interference
      // supplies the other directory's stream without repeated OS rename stress.
      if (mode !== 'repeated') {
        nativeFs.renameSync(f.privateRoot, moved); nativeFs.renameSync(replacement, f.privateRoot);
      }
      const stream = opendir(mode === 'repeated' ? replacement : args[0], ...args.slice(1));
      const empty = stream.readSync(); stream.closeSync();
      if (mode === 'once') {
        nativeFs.renameSync(f.privateRoot, replacement); nativeFs.renameSync(moved, f.privateRoot);
      }
      epoch.advance();
      return { read: async () => empty, close: async () => {}, closeSync() { closed++; } };
    });
    const expected = { once: 'STORE_ROOT_OCCUPIED', repeated: 'STORE_SETUP_BUSY', replaced: 'STORE_INCOMPLETE' }[mode];
    try {
      await assert.rejects(initializeStore(f.privateRoot), error => {
        assert.equal(error.code, expected, error.stack);
        if (mode === 'repeated') assert.match(describeFailure(error).recovery, /retry the same setup/i);
        return true;
      });
    } finally { injection.mock.restore(); syncStatInjection.mock.restore(); statInjection.mock.restore(); }
    assert.ok(opens > 0 && opens <= 64); assert.equal(closed, opens);
    const retainedRoot = mode === 'replaced' ? moved : f.privateRoot;
    assert.deepEqual(await fs.readdir(retainedRoot), ['retained']);
    assert.equal(await fs.readFile(path.join(retainedRoot, 'retained'), 'utf8'), 'Synthetic retained input.\n');
    if (mode === 'replaced') assert.deepEqual(await fs.readdir(f.privateRoot), []);
  });
});

test('a layout arriving after an absent observation cannot authorize gate creation', async t => {
  for (const schemaVersion of [1, 2, 3]) {
    const f = await fixture(t); await createPrivateDirectory(path.join(f.privateRoot, 'store'));
    const file = path.join(f.privateRoot, 'store/layout.json'), lstat = fs.lstat;
    const gate = id => ({ path: path.join(f.privateRoot, `store/locks/${id}.sqlite`), id, device: '1', inode: '2' });
    const layout = { schemaVersion, id: '11111111-1111-1111-1111-111111111111', settingsGate: gate('settings'), writerGate: gate('writer'), syncGate: gate('sync'), projects: {} };
    let injected = false;
    const injection = t.mock.method(fs, 'lstat', async (...args) => {
      try { return await lstat(...args); }
      catch (error) {
        if (args[0] === file && error.code === 'ENOENT' && !injected) {
          injected = true;
          await fs.writeFile(file, JSON.stringify(layout) + '\n', { mode: 0o600 });
        }
        throw error;
      }
    });
    try { await assert.rejects(initializeStore(f.privateRoot), { code: schemaVersion === 2 ? 'STORE_INCOMPLETE' : 'STORE_SCHEMA_UNSUPPORTED' }); }
    finally { injection.mock.restore(); }
    assert.equal(injected, true);
    assert.deepEqual(await fs.readdir(f.privateRoot), ['store']);
    assert.deepEqual(await fs.readdir(path.join(f.privateRoot, 'store')), ['layout.json']);
    assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(layout) + '\n');
  }
});

test('unsupported store schemas refuse before inspecting retained run or queue data', async t => {
  for (const schemaVersion of [1, 3]) {
    const f = await fixture(t), store = await initializeStore(f.privateRoot, f.settings);
    const retained = await withProject(store, 'demo', async ({ directory }) => {
      const files = [`${directory}/run.json`, 'store/chats/retained.queue'];
      // Deliberately unreadable as current state: store admission must reject
      // the schema before either a pending cleanup receipt or queue is parsed.
      for (const relative of files) await fs.writeFile(path.join(store.root, relative), 'Synthetic incompatible cleanup receipt.\n', { mode: 0o600 });
      return files;
    });
    const layoutFile = path.join(store.root, 'store/layout.json');
    const layout = JSON.parse(await fs.readFile(layoutFile, 'utf8'));
    assert.equal(layout.schemaVersion, 2);
    await fs.writeFile(layoutFile, JSON.stringify({ ...layout, schemaVersion }) + '\n');
    const files = [...retained, 'store/layout.json', 'config/settings.json', 'store/locks/settings.sqlite', 'store/locks/writer.sqlite', 'store/locks/sync.sqlite'];
    const before = await snapshots(store.root, files);
    await assert.rejects(openStore(store.root), { code: 'STORE_SCHEMA_UNSUPPORTED' });
    await assert.rejects(initializeStore(store.root), { code: 'STORE_SCHEMA_UNSUPPORTED' });
    assert.deepEqual(await snapshots(store.root, files), before);
  }
});

test('unsafe ancestor modes are refused before setup creates any private directories', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const shared = path.join(f.root, 'shared');
  await fs.mkdir(shared, { mode: 0o770 });
  await fs.chmod(shared, 0o770);
  await assert.rejects(initializeStore(path.join(shared, 'private'), f.settings), { code: 'GATE_UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(shared), []);
});

test('explicit setup writes private settings and gates without creating notes', async t => {
  const f = await fixture(t);
  const store = await initializeStore(f.privateRoot, f.settings);
  assert.deepEqual((await readSettings(await openStore(f.privateRoot))).value, f.settings);
  await assert.rejects(fs.stat(path.join(f.root, 'notes')), { code: 'ENOENT' });
  await initializeStore(f.privateRoot, f.settings);
  assert.equal((await readSettings(store)).value.projects[0].tracking, 'manual');
});

test('initialization refuses missing metadata in a retained store without recreating files or gates', async t => {
  for (const missing of [['config/settings.json'], ['store/layout.json'], ['config/settings.json', 'store/layout.json']]) {
    const f = await fixture(t), store = await initializeStore(f.privateRoot, f.settings);
    const retained = await withProject(store, 'demo', async ({ directory, gates }) => {
      const files = [`${directory}/chats/synthetic.json`, `${directory}/run.json`, 'store/chats/synthetic.queue'];
      for (const relative of files) await writeJSON(store.pin, relative, { synthetic: `Retain ${relative}` }, { expectedHash: null });
      return [...files, ...Object.values(gates).map(gate => path.relative(store.root, gate.path))];
    });
    for (const relative of missing) await fs.unlink(path.join(store.root, relative));
    const files = [...retained, ...['config/settings.json', 'store/layout.json'].filter(relative => !missing.includes(relative)),
      'store/locks/settings.sqlite', 'store/locks/writer.sqlite', 'store/locks/sync.sqlite'];
    const before = await snapshots(store.root, files);
    await assert.rejects(initializeStore(store.root), { code: 'STORE_INCOMPLETE' });
    assert.deepEqual(await snapshots(store.root, files), before);
    for (const relative of missing) await assert.rejects(fs.stat(path.join(store.root, relative)), { code: 'ENOENT' });
  }
});

test('initialization refuses settings without a layout and a layout without settings when queued work remains', async t => {
  for (const queued of [false, true]) {
    const f = await fixture(t), store = await initializeStore(f.privateRoot);
    if (queued) await writeJSON(store.pin, 'store/chats/synthetic.queue', { synthetic: 'Retained queue' }, { expectedHash: null });
    const missing = queued ? 'config/settings.json' : 'store/layout.json'; await fs.unlink(path.join(store.root, missing));
    const files = [queued ? 'store/layout.json' : 'config/settings.json', ...(queued ? ['store/chats/synthetic.queue'] : [])];
    const before = await snapshots(store.root, files);
    await assert.rejects(initializeStore(store.root), { code: 'STORE_INCOMPLETE' });
    assert.deepEqual(await snapshots(store.root, files), before);
    await assert.rejects(fs.stat(path.join(store.root, missing)), { code: 'ENOENT' });
  }
});

test('initialization never recreates a gate owned by a published layout', async t => {
  for (const missing of ['settings', 'writer', 'sync']) {
    const f = await fixture(t), store = await initializeStore(f.privateRoot), relative = `store/locks/${missing}.sqlite`;
    await fs.unlink(path.join(store.root, relative));
    const files = ['store/layout.json', 'config/settings.json', ...['settings', 'writer', 'sync'].filter(name => name !== missing).map(name => `store/locks/${name}.sqlite`)];
    const before = await snapshots(store.root, files);
    await assert.rejects(initializeStore(store.root), error => error.code === 'GATE_STORAGE_ERROR' && error.cause?.code === 'ENOENT');
    assert.deepEqual(await snapshots(store.root, files), before);
    await assert.rejects(fs.stat(path.join(store.root, relative)), { code: 'ENOENT' });
  }
});

test('empty-directory replacement and restoration cannot hide retained work even without child ctime changes', async t => {
  for (const restoredBeforeReturn of [false, true]) {
    const f = await fixture(t), store = await initializeStore(f.privateRoot), directory = path.join(store.root, 'store/projects');
    await fs.writeFile(path.join(directory, 'retained'), 'Synthetic retained work.', { mode: 0o600 });
    await fs.unlink(path.join(store.root, 'config/settings.json'));
    const original = path.join(f.root, 'original-projects'), opendir = fs.opendir, lstat = fs.lstat;
    const originalCtime = (await lstat(directory, { bigint: true })).ctimeNs; let injected = false;
    const statInjection = t.mock.method(fs, 'lstat', async (...args) => {
      const stat = await lstat(...args);
      if (restoredBeforeReturn && injected && args[0] === directory && typeof stat.ctimeNs === 'bigint') stat.ctimeNs = originalCtime;
      return stat;
    });
    const injection = t.mock.method(fs, 'opendir', async (...args) => {
      if (args[0] !== directory || injected) return opendir(...args);
      injected = true; await fs.rename(directory, original); await fs.mkdir(directory, { mode: 0o700 });
      const stream = await opendir(...args); let closed = false;
      const restore = async () => {
        if (!closed) { await stream.close(); closed = true; }
        await fs.rmdir(directory); await fs.rename(original, directory);
      };
      if (restoredBeforeReturn) {
        const empty = await stream.read(); await restore();
        return { read: async () => empty, close: async () => {} };
      }
      return { read: () => stream.read(), close: restore };
    });
    try { await assert.rejects(initializeStore(store.root), { code: 'STORE_INCOMPLETE' }); }
    finally { injection.mock.restore(); statInjection.mock.restore(); }
    assert.equal(injected, true); assert.equal(await fs.readFile(path.join(directory, 'retained'), 'utf8'), 'Synthetic retained work.');
    await assert.rejects(fs.stat(path.join(store.root, 'config/settings.json')), { code: 'ENOENT' });
  }
});

test('an interrupted first initialization retries with the same gates before or after layout publication', async t => {
  for (const target of ['store/layout.json', 'config/settings.json']) {
    const f = await fixture(t), rename = fs.rename;
    const injection = t.mock.method(fs, 'rename', async (from, to) => {
      if (to === path.join(f.privateRoot, target)) throw Object.assign(new Error('Synthetic initialization interruption.'), { code: 'SYNTHETIC_INITIALIZATION_INTERRUPTED' });
      return rename(from, to);
    });
    try { await assert.rejects(initializeStore(f.privateRoot, f.settings), { code: 'SYNTHETIC_INITIALIZATION_INTERRUPTED' }); }
    finally { injection.mock.restore(); }
    const gates = ['store/locks/settings.sqlite', 'store/locks/writer.sqlite', 'store/locks/sync.sqlite'], before = await snapshots(f.privateRoot, gates);
    const layout = target === 'config/settings.json' ? JSON.parse(await fs.readFile(path.join(f.privateRoot, 'store/layout.json'), 'utf8')) : null;
    const store = await initializeStore(f.privateRoot, f.settings);
    assert.deepEqual((await readSettings(store)).value, f.settings); assert.deepEqual(await snapshots(store.root, gates), before);
    if (layout) assert.equal(JSON.parse(await fs.readFile(path.join(store.root, 'store/layout.json'), 'utf8')).id, layout.id);
  }
});

test('settings CAS preserves a concurrent update and refuses newer schemas without writes', async t => {
  const f = await fixture(t);
  const store = await initializeStore(f.privateRoot, f.settings);
  const inspected = await readSettings(store);
  const next = { schemaVersion: 1, projects: [{ ...f.project, tracking: 'auto' }] };
  await updateSettings(store, next, { expectedHash: inspected.hash });
  await assert.rejects(updateSettings(store, f.settings, { expectedHash: inspected.hash }), { code: 'SETTINGS_CONFLICT' });
  const changed = await readSettings(store);
  await assert.rejects(updateSettings(store, { ...next, schemaVersion: 2 }, { expectedHash: changed.hash }), { code: 'SETTINGS_SCHEMA_UNSUPPORTED' });
  assert.equal((await readSettings(store)).hash, changed.hash);
});

test('retained chats and pending runs guard removal, roots, destination and saving', async t => {
  const f = await fixture(t);
  const store = await initializeStore(f.privateRoot, f.settings);
  await withProject(store, 'demo', async ({ directory }) => {
    await writeJSON(store.pin, `${directory}/chats/synthetic.json`, { optOut: true, bookmark: 7 }, { expectedHash: null });
  });
  let current = await readSettings(store);
  await assert.rejects(updateSettings(store, emptySettings(), { expectedHash: current.hash }), { code: 'SETTINGS_RETAINED_PROJECT' });
  await withProject(store, 'demo', async ({ directory }) => {
    await writeJSON(store.pin, `${directory}/run.json`, { synthetic: 'pending' }, { expectedHash: null });
  });
  await assert.rejects(updateSettings(store, { schemaVersion: 1, projects: [{ ...f.project, saving: 'auto' }] }, { expectedHash: current.hash }), { code: 'SETTINGS_PENDING_RUN' });
  await updateSettings(store, { schemaVersion: 1, projects: [{ ...f.project, tracking: 'auto' }] }, { expectedHash: current.hash });
  assert.equal((await readSettings(store)).value.projects[0].tracking, 'auto');
});

test('captured-only pending run still refuses settings removal and destination or saving changes', async t => {
  const f = await fixture(t), store = await initializeStore(f.privateRoot, f.settings);
  const retained = await withProject(store, 'demo', async ({ directory }) => {
    const relative = `${directory}/run.json`;
    await writeJSON(store.pin, relative, { synthetic: 'Retain this pending run.' }, { expectedHash: null });
    return { relative, snapshot: await readSnapshot(store.pin, relative) };
  });
  await interruptRemoval({ root: store.root, relative: retained.relative, expectedHash: retained.snapshot.hash });
  const current = await readSettings(store);
  await assert.rejects(updateSettings(store, emptySettings(), { expectedHash: current.hash }), { code: 'SETTINGS_RETAINED_PROJECT' });
  const destination = { kind: 'directory', path: path.join(f.root, 'elsewhere') };
  for (const change of [{ saving: 'auto' }, { destination, activityLog: { ...f.project.activityLog, path: path.join(destination.path, 'logs') } }]) {
    await assert.rejects(updateSettings(store, { schemaVersion: 1, projects: [{ ...f.project, ...change }] }, { expectedHash: current.hash }), { code: 'SETTINGS_PENDING_RUN' });
  }
  assert.equal((await readSettings(store)).hash, current.hash);
  assert.deepEqual((await readSnapshot(store.pin, retained.relative)).bytes, retained.snapshot.bytes);
  await assert.rejects(fs.lstat(path.join(store.root, retained.relative)), { code: 'ENOENT' });
});

test('long worker ownership does not block a short project mutation', async t => {
  const f = await fixture(t);
  const store = await initializeStore(f.privateRoot, f.settings);
  const gates = await withProject(store, 'demo', ({ gates }) => gates);
  const worker = tryAcquireExistingGate(gates.workerGate, gateOptions).acquired;
  assert.ok(worker);
  try {
    await withProject(store, 'demo', async ({ directory }) => {
      await writeJSON(store.pin, `${directory}/result.json`, { status: 'running' }, { expectedHash: null });
    });
  } finally { worker.release(); }
});

test('setup persists one independent sync gate and its lifetime does not block processing ownership or short mutations', async t => {
  const f = await fixture(t), store = await initializeStore(f.privateRoot, f.settings), reopened = await openStore(f.privateRoot);
  assert.deepEqual(reopened.syncGate, store.syncGate);
  const steward = tryAcquireExistingGate(store.syncGate, gateOptions).acquired;
  assert(steward); assert.equal(tryAcquireExistingGate(store.syncGate, gateOptions).busy, true);
  try {
    const gates = await withProject(store, 'demo', ({ gates }) => gates), processing = tryAcquireExistingGate(gates.workerGate, gateOptions).acquired;
    assert(processing);
    try { await withProject(store, 'demo', async ({ directory }) => writeJSON(store.pin, `${directory}/result.json`, { status: 'running' }, { expectedHash: null })); }
    finally { processing.release(); }
  } finally { steward.release(); }
  const next = tryAcquireExistingGate(reopened.syncGate, gateOptions).acquired; assert(next); next.release();
});

test('private setup refuses any source repository and configured note overlap', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project.root, '.git'));
  await assert.rejects(initializeStore(path.join(f.project.root, 'private')), { code: 'PRIVATE_LOCATION_REPOSITORY' });
  await assert.rejects(initializeStore(f.project.destination.path, f.settings), { code: 'PRIVATE_LOCATION_OVERLAP' });
  assert.deepEqual(await fs.readdir(f.project.root), ['.git']);
});


test('a corrupt layout missing a prototype-named project reports the layout error', async t => {
  const f = await fixture(t), project = { ...f.project, id: 'constructor' };
  const store = await initializeStore(f.privateRoot, { schemaVersion: 1, projects: [project] });
  const filename = path.join(store.root, 'store/layout.json');
  const layout = JSON.parse(await fs.readFile(filename, 'utf8')); delete layout.projects.constructor;
  await fs.writeFile(filename, JSON.stringify(layout));
  await assert.rejects(withProject(store, 'constructor', () => assert.fail('Missing project gates were accepted.')), { code: 'STORE_LAYOUT_INVALID' });
});
