import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeStore, openStore, openStoreOrScaffold, isInitializationScaffold, readSettings, gateOptions } from '../src/storage/store.mjs';
import { emptySettings } from '../src/core/settings.mjs';
import { createPrivateDirectory } from '../src/storage/paths.mjs';
import { initializeGate } from '../src/storage/gates.mjs';
import { establishWindowsPrivacy } from '../src/storage/platform.mjs';

const worker = fileURLToPath(new URL('./fixtures/store-initializer.mjs', import.meta.url));
const waitMs = process.platform === 'win32' ? 60_000 : 15_000;
const gateIds = ['settings', 'writer', 'sync'];

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-store-initialization-')));
  const children = [];
  t.after(async () => {
    try {
      for (const item of children) {
        if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
        await item.closed;
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  return { root, storeRoot: path.join(root, 'private'), children };
}

function launch(f, relative, boundary) {
  const child = fork(worker, [f.storeRoot, relative, boundary], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8192); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  f.children.push({ child, closed });
  return { child, closed, stderr: () => stderr };
}

async function stopAt(f, relative, boundary) {
  const { child, closed, stderr } = launch(f, relative, boundary);
  let timer;
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Initialization child missed ${relative} ${boundary}: ${stderr()}`)), waitMs);
    child.once('error', reject);
    child.once('message', message => {
      if (message?.type === 'stage') resolve(message);
      else reject(new Error(`Initialization child did not pause: ${JSON.stringify(message)} ${stderr()}`));
    });
    child.once('close', (code, signal) => reject(new Error(`Initialization child exited before pause (${code}, ${signal}): ${stderr()}`)));
  });
  try { return { child, closed, message: await ready }; }
  finally { clearTimeout(timer); }
}

async function stageSnapshot(file) {
  const stat = await fs.lstat(file, { bigint: true });
  return { device: stat.dev, inode: stat.ino, size: stat.size, modified: stat.mtimeNs, bytes: await fs.readFile(file) };
}

// Never read, hash or open gates outside the gate module: lstat is sufficient
// to prove that retry retains the original persistent rendezvous files.
async function gateSnapshots(root, ids = gateIds) {
  return Promise.all(ids.map(async id => {
    const stat = await fs.lstat(path.join(root, `store/locks/${id}.sqlite`), { bigint: true });
    return { id, device: stat.dev, inode: stat.ino, size: stat.size, modified: stat.mtimeNs, links: stat.nlink };
  }));
}

async function killedGate(t, id) {
  const f = await fixture(t), running = launch(f, `store/locks/${id}.sqlite`, 'linked');
  let timer, exit;
  try {
    exit = await Promise.race([running.closed, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Initialization child missed ${id} gate publication: ${running.stderr()}`)), waitMs);
      running.child.once('error', reject);
    })]);
  } finally { clearTimeout(timer); }
  assert.notEqual(exit.code, 0, running.stderr());
  if (process.platform !== 'win32') assert.equal(exit.signal, 'SIGKILL', running.stderr());
  const locks = path.join(f.storeRoot, 'store/locks'), entries = await fs.readdir(locks);
  const stages = entries.filter(name => name.startsWith(`.${id}.sqlite.`) && name.endsWith('.tmp'));
  assert.equal(stages.length, 1);
  const stage = path.join(locks, stages[0]), gate = path.join(locks, `${id}.sqlite`);
  const [staged, published] = await Promise.all([fs.lstat(stage, { bigint: true }), fs.lstat(gate, { bigint: true })]);
  assert.equal(staged.isFile(), true); assert.equal(published.isFile(), true);
  assert.equal(staged.nlink, 2n); assert.equal(published.nlink, 2n);
  assert.equal(staged.dev, published.dev); assert.equal(staged.ino, published.ino);
  const gates = await gateSnapshots(f.storeRoot, gateIds.filter(name => entries.includes(`${name}.sqlite`)));
  return { f, stage, gates, locks };
}

for (const id of gateIds) {
  test(`SIGKILL after initial ${id} gate publication retains its pair and permits setup retry`, { timeout: waitMs * 2 }, async t => {
    const { f, gates, locks } = await killedGate(t, id);
    await assert.rejects(fs.access(path.join(f.storeRoot, 'store/layout.json')), { code: 'ENOENT' });
    const recovered = await initializeStore(f.storeRoot);
    assert.deepEqual((await readSettings(recovered)).value, emptySettings());
    assert.deepEqual((await readSettings(await openStore(f.storeRoot))).value, emptySettings());
    assert.deepEqual(await gateSnapshots(f.storeRoot, gates.map(gate => gate.id)), gates.map(gate => ({ ...gate, links: 1n })));
    assert.deepEqual((await fs.readdir(locks)).sort(), gateIds.map(name => `${name}.sqlite`).sort());
    assert.deepEqual((await fs.readdir(f.storeRoot, { recursive: true })).filter(name => name.endsWith('.tmp')), []);
  });
}

for (const relative of ['store/layout.json', 'config/settings.json']) {
  for (const boundary of ['open', 'partial', 'complete']) {
    test(`SIGKILL during initial ${relative} ${boundary} publication retains gates and permits setup retry`, { timeout: waitMs * 2 }, async t => {
      const f = await fixture(t), running = await stopAt(f, relative, boundary);
      const stage = running.message.stage, target = path.join(f.storeRoot, ...relative.split('/'));
      assert.equal(path.dirname(stage), path.dirname(target));
      assert.ok(path.basename(stage).startsWith(`.${path.basename(target)}.`));
      assert.ok(stage.endsWith('.tmp'));
      await assert.rejects(fs.access(target), { code: 'ENOENT' });
      const before = await stageSnapshot(stage), gates = await gateSnapshots(f.storeRoot);
      if (boundary === 'open') assert.equal(before.bytes.length, 0);
      else if (boundary === 'partial') {
        assert.ok(before.bytes.length > 0 && before.bytes.length < running.message.totalBytes);
        assert.throws(() => JSON.parse(before.bytes.toString('utf8')), SyntaxError);
      } else assert.ok(JSON.parse(before.bytes.toString('utf8')));
      const layout = relative === 'config/settings.json' ? await stageSnapshot(path.join(f.storeRoot, 'store/layout.json')) : null;

      let liveRefusal;
      await assert.rejects(initializeStore(f.storeRoot), error => { liveRefusal = error; return true; });
      assert.deepEqual(await stageSnapshot(stage), before);
      assert.deepEqual(await gateSnapshots(f.storeRoot), gates);
      if (layout) assert.deepEqual(await stageSnapshot(path.join(f.storeRoot, 'store/layout.json')), layout);

      assert.equal(running.child.kill('SIGKILL'), true);
      const exit = await running.closed;
      assert.notEqual(exit.code, 0);
      const recovered = await initializeStore(f.storeRoot);
      const published = await fs.lstat(target, { bigint: true });
      assert.equal(published.dev, before.device); assert.equal(published.ino, before.inode);
      assert.equal(liveRefusal.code, 'GATE_BUSY');
      assert.deepEqual((await readSettings(recovered)).value, emptySettings());
      assert.deepEqual((await readSettings(await openStore(f.storeRoot))).value, emptySettings());
      assert.deepEqual(await gateSnapshots(f.storeRoot), gates);
      if (layout) assert.deepEqual(await stageSnapshot(path.join(f.storeRoot, 'store/layout.json')), layout);
      for (const parent of ['config', 'store']) assert.deepEqual((await fs.readdir(path.join(f.storeRoot, parent))).filter(name => name.endsWith('.tmp')), []);
    });
  }
}

async function killedStage(t, relative = 'store/layout.json') {
  const f = await fixture(t), running = await stopAt(f, relative, 'partial');
  assert.equal(running.child.kill('SIGKILL'), true);
  assert.notEqual((await running.closed).code, 0);
  return { f, stage: running.message.stage, relative };
}

async function retainedTree(root) {
  const files = ['', ...(await fs.readdir(root, { recursive: true })).sort()];
  return Promise.all(files.map(async relative => {
    const file = path.join(root, relative), stat = await fs.lstat(file, { bigint: true });
    const gate = relative.endsWith('.sqlite') || /\.sqlite\.[^/\\]+\.tmp$/.test(relative);
    return { relative, device: stat.dev, inode: stat.ino, size: stat.size, links: stat.nlink, mode: stat.mode, modified: stat.mtimeNs,
      ...(stat.isSymbolicLink() ? { link: await fs.readlink(file) } : stat.isFile() && !gate ? { bytes: await fs.readFile(file) } : {}) };
  }));
}

async function refusesUnchanged(f, codes = ['STORE_ROOT_OCCUPIED']) {
  const before = await retainedTree(f.root);
  await assert.rejects(initializeStore(f.storeRoot), error => {
    assert.ok(codes.includes(error.code), `Unexpected initialization refusal: ${error.code}`);
    return true;
  });
  assert.deepEqual(await retainedTree(f.root), before);
  await assert.rejects(fs.access(path.join(f.storeRoot, 'config/settings.json')), { code: 'ENOENT' });
}

test('an unrelated root entry prevents recovery without consuming a published gate pair', { timeout: waitMs * 2 }, async t => {
  const { f } = await killedGate(t, 'sync');
  await fs.writeFile(path.join(f.storeRoot, 'unrelated.json'), 'Synthetic unrelated state.\n', { mode: 0o600 });
  await refusesUnchanged(f);
});

test('a later unrelated lock entry prevents recovery after a genuine gate pair is admitted', { timeout: waitMs * 2 }, async t => {
  const { f, stage, locks } = await killedGate(t, 'sync'), open = fs.opendir;
  const stageName = path.basename(stage), unrelatedName = 'unrelated.json';
  await fs.writeFile(path.join(locks, unrelatedName), 'Synthetic unrelated lock-directory state.\n', { mode: 0o600 });
  let admitted = 0;
  const injection = t.mock.method(fs, 'opendir', async (directory, ...args) => {
    const stream = await open(directory, ...args);
    if (directory !== locks) return stream;
    const entries = [];
    for (let entry; (entry = await stream.read());) entries.push(entry);
    entries.sort((left, right) => Number(right.name === stageName) - Number(left.name === stageName));
    let index = 0, candidateSeen = false;
    stream.read = async () => {
      const entry = entries[index++] ?? null;
      if (entry?.name === stageName) candidateSeen = true;
      if (entry?.name === unrelatedName) {
        assert.equal(candidateSeen, true);
        // Reaching the next entry proves the candidate passed admission; its
        // initialized inode must still have both names until the scan succeeds.
        assert.equal((await fs.lstat(stage, { bigint: true })).nlink, 2n);
        admitted++;
      }
      return entry;
    };
    return stream;
  });
  try { await refusesUnchanged(f); }
  finally { injection.mock.restore(); }
  assert.equal(admitted, 1);
});

test('an invalid gate stage name cannot authorize recovery of a published pair', { timeout: waitMs * 2 }, async t => {
  const { f, stage, locks } = await killedGate(t, 'sync');
  await fs.rename(stage, path.join(locks, '.sync.sqlite.not-a-uuid.tmp'));
  await refusesUnchanged(f);
});

test('a killed stage with another initializer context in its name is preserved and refused', { timeout: waitMs * 2 }, async t => {
  const first = await killedStage(t), second = await killedStage(t);
  const renamed = path.join(path.dirname(first.stage), path.basename(second.stage));
  assert.notEqual(renamed, first.stage);
  await fs.rename(first.stage, renamed);
  await refusesUnchanged(first.f);
});

for (const relative of ['store/layout.json', 'config/settings.json']) {
  test(`non-prefix bytes in a genuine killed ${relative} stage are preserved and refused`, { timeout: waitMs * 2 }, async t => {
    const { f, stage } = await killedStage(t, relative);
    await fs.writeFile(stage, 'Unrelated synthetic retained bytes.\n');
    await refusesUnchanged(f);
  });
}

test('an unbound temporary filename cannot authorize recovery of a killed stage', { timeout: waitMs * 2 }, async t => {
  const { f, stage } = await killedStage(t);
  await fs.rename(stage, path.join(path.dirname(stage), '.layout.json.11111111-1111-4111-8111-111111111111.tmp'));
  await refusesUnchanged(f);
});

test('an extra stage candidate prevents recovery without consuming either candidate', { timeout: waitMs * 2 }, async t => {
  const first = await killedStage(t), second = await killedStage(t);
  const extra = path.join(path.dirname(first.stage), path.basename(second.stage));
  assert.notEqual(extra, first.stage);
  await fs.copyFile(first.stage, extra);
  await refusesUnchanged(first.f);
});

test('an unrelated root entry prevents recovery without consuming a genuine killed stage', { timeout: waitMs * 2 }, async t => {
  const { f } = await killedStage(t);
  await fs.writeFile(path.join(f.storeRoot, 'unrelated.json'), 'Synthetic unrelated state.\n', { mode: 0o600 });
  await refusesUnchanged(f);
});

test('a hardlinked killed stage remains untouched on refusal', { timeout: waitMs * 2 }, async t => {
  const { f, stage } = await killedStage(t);
  await fs.link(stage, path.join(f.root, 'retained-stage.bin'));
  await refusesUnchanged(f, ['PATH_UNSAFE']);
});

test('a symlink replacing a killed stage and its original bytes remain untouched', { timeout: waitMs * 2, skip: process.platform === 'win32' }, async t => {
  const { f, stage } = await killedStage(t), retained = path.join(f.root, 'retained-stage.bin');
  await fs.rename(stage, retained); await fs.symlink(retained, stage);
  await refusesUnchanged(f, ['STORE_ROOT_OCCUPIED']);
});

for (const id of ['settings', 'writer', 'sync']) for (const replaced of [false, true]) {
  test(`a ${replaced ? 'replaced' : 'missing'} ${id} gate cannot be recreated or adopted to recover a killed stage`, { timeout: waitMs * 2 }, async t => {
    const { f } = await killedStage(t), gate = path.join(f.storeRoot, `store/locks/${id}.sqlite`);
    await fs.rename(gate, path.join(f.root, `retained-${id}.sqlite`));
    if (replaced) initializeGate(gate, id, gateOptions);
    await refusesUnchanged(f, replaced ? ['STORE_ROOT_OCCUPIED', 'GATE_REPLACED'] : ['STORE_INCOMPLETE', 'GATE_STORAGE_ERROR']);
  });
}

test('replacing the settings parent directory cannot rebind its killed stage', { timeout: waitMs * 2 }, async t => {
  const { f, stage } = await killedStage(t, 'config/settings.json');
  const parent = path.dirname(stage), retained = path.join(f.root, 'retained-config');
  await fs.rename(parent, retained); await createPrivateDirectory(parent);
  await fs.rename(path.join(retained, path.basename(stage)), stage);
  await refusesUnchanged(f);
});

for (const mutation of ['bytes', 'inode']) {
  test(`a killed stage whose ${mutation} change at resumed open is preserved and its writer handle closes once`, { timeout: waitMs * 2 }, async t => {
    const { f, stage } = await killedStage(t), original = await stageSnapshot(stage), gates = await gateSnapshots(f.storeRoot);
    const retained = path.join(f.root, 'original-stage.bin'), open = fs.open;
    let injected = false, closes = 0, changed, preserved;
    const injection = t.mock.method(fs, 'open', async (file, flags, ...args) => {
      const resumed = file === stage && typeof flags === 'number' && (flags & constants.O_WRONLY) !== 0 && (flags & constants.O_CREAT) === 0;
      if (resumed && !injected) {
        injected = true;
        if (mutation === 'bytes') {
          await fs.copyFile(stage, retained);
          const bytes = Buffer.from(original.bytes); bytes[0] ^= 0xff;
          await fs.writeFile(stage, bytes);
        } else {
          await fs.rename(stage, retained); await fs.copyFile(retained, stage);
          establishWindowsPrivacy(stage); // Only the replacement just created by this fixture.
        }
        changed = await stageSnapshot(stage); preserved = await stageSnapshot(retained);
      }
      const handle = await open(file, flags, ...args);
      if (resumed) {
        const close = handle.close.bind(handle);
        handle.close = async () => { closes++; return close(); };
      }
      return handle;
    });
    try { await assert.rejects(initializeStore(f.storeRoot), { code: 'FILE_CHANGED' }); }
    finally { injection.mock.restore(); }
    assert.equal(injected, true); assert.equal(closes, 1);
    assert.equal(changed.inode === original.inode, mutation === 'bytes');
    assert.equal(changed.bytes.equals(original.bytes), mutation === 'inode');
    assert.deepEqual(await stageSnapshot(stage), changed);
    assert.deepEqual(await stageSnapshot(retained), preserved); assert.deepEqual(preserved.bytes, original.bytes);
    assert.deepEqual(await gateSnapshots(f.storeRoot), gates);
    await assert.rejects(fs.access(path.join(f.storeRoot, 'store/layout.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.storeRoot, 'config/settings.json')), { code: 'ENOENT' });
  });
}

test('a location holding only the initializer\'s resumable scaffold, including a retained layout stage and its gate files, reads as no store; retained state does not', { timeout: waitMs * 2 }, async t => {
  const f = await fixture(t), running = await stopAt(f, 'store/layout.json', 'partial');
  const stage = running.message.stage;
  assert.ok(path.basename(stage).startsWith('.layout.json.initialize.') && stage.endsWith('.tmp'));
  assert.ok((await fs.readdir(path.join(f.storeRoot, 'store/locks'))).length > 0);
  // The connector's read-only open reports no store here, so explicit setup can resume it.
  assert.equal(await isInitializationScaffold(f.storeRoot), true);
  assert.equal(await openStoreOrScaffold(f.storeRoot), null);
  await assert.rejects(openStore(f.storeRoot), { code: 'FILE_MISSING' });
  // Anything beyond that scaffold is retained state, and the read fails as it did.
  await fs.writeFile(path.join(f.storeRoot, 'store/projects', 'demo.json'), '{}');
  assert.equal(await isInitializationScaffold(f.storeRoot), false);
  await assert.rejects(openStoreOrScaffold(f.storeRoot), { code: 'FILE_MISSING' });
  await fs.rm(path.join(f.storeRoot, 'store/projects', 'demo.json'));
  await fs.writeFile(path.join(f.storeRoot, 'config', 'setup.json'), '{}');
  assert.equal(await isInitializationScaffold(f.storeRoot), false);
  await fs.rm(path.join(f.storeRoot, 'config', 'setup.json'));
  await fs.writeFile(path.join(f.storeRoot, 'unrelated.txt'), 'x');
  assert.equal(await isInitializationScaffold(f.storeRoot), false);
  await fs.rm(path.join(f.storeRoot, 'unrelated.txt'));
  assert.equal(running.child.kill('SIGKILL'), true); await running.closed;
  // The retained stage is still the initializer's to resume.
  const recovered = await initializeStore(f.storeRoot);
  assert.ok(recovered); assert.ok(await openStore(f.storeRoot));
  assert.equal(await isInitializationScaffold(f.storeRoot), false);
});
