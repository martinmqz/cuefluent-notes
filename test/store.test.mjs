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
