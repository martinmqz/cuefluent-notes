import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProject, emptySettings } from '../src/core/settings.mjs';
import { initializeStore, openStore, readSettings, updateSettings, withProject, gateOptions } from '../src/storage/store.mjs';
import { tryAcquireExistingGate } from '../src/storage/gates.mjs';
import { writeJSON } from '../src/storage/files.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-v2-store-')));
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

test('unconfigured status and invalid first setup make zero writes', async t => {
  const f = await fixture(t);
  assert.equal(await openStore(f.privateRoot), null);
  assert.deepEqual(await readSettings(null), { value: emptySettings(), hash: null });
  await assert.rejects(initializeStore(f.privateRoot, { schemaVersion: 99, projects: [] }), { code: 'SETTINGS_SCHEMA_UNSUPPORTED' });
  assert.deepEqual(await fs.readdir(f.root), ['project']);
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
