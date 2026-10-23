import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createPrivateDirectory, pinDirectory, assertPrivatePlacement, canonicalSelection } from '../src/storage/paths.mjs';
import { hashBytes, readSnapshot, readJSON, writeAtomic, writeJSON, removeExact, removalContainerName, reclaimAtomicStages } from '../src/storage/files.mjs';

import { establishWindowsPrivacy } from '../src/storage/platform.mjs';
import { interruptRemoval } from './fixtures/exact-removal-worker.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-v2-files-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pin = await createPrivateDirectory(path.join(root, 'private'));
  return { root, pin };
}

async function privateFixtureFile(file, bytes) {
  await fs.writeFile(file, bytes, { mode: 0o600 });
  establishWindowsPrivacy(file);
}

test('read-only lookup does not create absent settings or directories', async t => {
  const { pin } = await fixture(t);
  assert.equal(await readJSON(pin, 'settings.json', { missing: true }), null);
  assert.deepEqual(await fs.readdir(pin.root), []);
});

test('hash checks preserve edits and unchanged publication preserves the timestamp', async t => {
  const { pin } = await fixture(t);
  const initial = Buffer.from('first\n');
  await writeAtomic(pin, 'note.md', initial, { expectedHash: null });
  const inspected = await readSnapshot(pin, 'note.md');
  const time = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(path.join(pin.root, 'note.md'), time, time);
  assert.deepEqual(await writeAtomic(pin, 'note.md', initial, { expectedHash: inspected.hash }), { changed: false, hash: inspected.hash });
  assert.equal((await fs.stat(path.join(pin.root, 'note.md'))).mtimeMs, time.getTime());
  await fs.writeFile(path.join(pin.root, 'note.md'), 'manual edit\n');
  await assert.rejects(writeAtomic(pin, 'note.md', Buffer.from('draft\n'), { expectedHash: inspected.hash }), { code: 'WRITE_CONFLICT' });
  assert.equal((await readSnapshot(pin, 'note.md')).bytes.toString(), 'manual edit\n');
  assert.deepEqual(await fs.readdir(pin.root), ['note.md']);
});

test('exact removal deletes the inspected file and preserves a replacement at its final namespace operation', async t => {
  const clean = await fixture(t), bytes = Buffer.from('Synthetic original.');
  await writeAtomic(clean.pin, 'state.json', bytes, { expectedHash: null });
  await removeExact(clean.pin, 'state.json', hashBytes(bytes));
  assert.equal(await readSnapshot(clean.pin, 'state.json', { missing: true }), null);
  assert.deepEqual(await fs.readdir(clean.pin.root), []);
  for (const replacement of [Buffer.from('Synthetic replacement.'), bytes]) {
    const { pin } = await fixture(t), target = path.join(pin.root, 'state.json'), archived = path.join(pin.root, 'original.json');
    await writeAtomic(pin, 'state.json', bytes, { expectedHash: null });
    const unlink = fs.unlink, rename = fs.rename; let replaced = false;
    const replace = async () => {
      if (replaced) return;
      replaced = true; await rename(target, archived); await privateFixtureFile(target, replacement);
    };
    const unlinkInjection = t.mock.method(fs, 'unlink', async (file, ...args) => { if (file === target) await replace(); return unlink(file, ...args); });
    const renameInjection = t.mock.method(fs, 'rename', async (from, to, ...args) => { if (from === target) await replace(); return rename(from, to, ...args); });
    try { await assert.rejects(removeExact(pin, 'state.json', hashBytes(bytes)), { code: 'WRITE_CONFLICT' }); }
    finally { unlinkInjection.mock.restore(); renameInjection.mock.restore(); }
    assert.equal(replaced, true); assert.deepEqual(await fs.readFile(target), replacement); assert.deepEqual(await fs.readFile(archived), bytes);
  }
});

for (const boundary of ['capture', 'restore-link']) {
  test(`exact removal recovery is read-only after process exit at ${boundary} and an exact writer resumes`, async t => {
    const { pin } = await fixture(t), bytes = Buffer.from('Synthetic pending run.'), next = Buffer.from('Synthetic next attempt.');
    await writeAtomic(pin, 'run.json', bytes, { expectedHash: null });
    await interruptRemoval({ root: pin.root, relative: 'run.json', expectedHash: hashBytes(bytes) });
    if (boundary === 'restore-link') await interruptRemoval({ root: pin.root, relative: 'run.json', expectedHash: hashBytes(bytes), operation: 'write', boundary, options: { bytes: next.toString('base64') } });
    const before = await fs.readdir(pin.root);
    const mutations = ['writeFile', 'mkdir', 'rmdir', 'rename', 'unlink', 'link'].map(method => t.mock.method(fs, method, () => assert.fail('Read-only recovery must never write.')));
    try {
      const snapshot = await readSnapshot(pin, 'run.json');
      assert.deepEqual(snapshot.bytes, bytes);
      assert.deepEqual(await fs.readdir(pin.root), before);
      const publicPin = await pinDirectory(pin.root);
      if (boundary === 'capture') assert.equal(await readSnapshot(publicPin, 'run.json', { missing: true }), null);
      else await assert.rejects(readSnapshot(publicPin, 'run.json'), { code: 'PATH_UNSAFE' });
    } finally { for (const mocked of mutations) mocked.mock.restore(); }
    await assert.rejects(writeAtomic(pin, 'run.json', next, { expectedHash: null }), { code: 'WRITE_CONFLICT' });
    await writeAtomic(pin, 'run.json', next, { expectedHash: hashBytes(bytes) });
    assert.deepEqual((await readSnapshot(pin, 'run.json')).bytes, next);
    assert.deepEqual(await fs.readdir(pin.root), ['run.json']);
    assert.equal((await fs.lstat(path.join(pin.root, 'run.json'))).nlink, 1);
  });
}

test('captured metadata resumes removal and an empty post-unlink container does not hide absence', async t => {
  for (const boundary of ['capture', 'unlink']) {
    const { pin } = await fixture(t), bytes = Buffer.from('Synthetic exact metadata.');
    await writeAtomic(pin, 'state.json', bytes, { expectedHash: null });
    await interruptRemoval({ root: pin.root, relative: 'state.json', expectedHash: hashBytes(bytes), boundary });
    if (boundary === 'capture') {
      assert.deepEqual((await readSnapshot(pin, 'state.json')).bytes, bytes);
      await removeExact(pin, 'state.json', hashBytes(bytes));
    } else {
      assert.equal(await readSnapshot(pin, 'state.json', { missing: true }), null);
      await writeAtomic(pin, 'state.json', bytes, { expectedHash: null });
      await removeExact(pin, 'state.json', hashBytes(bytes));
    }
    assert.deepEqual(await fs.readdir(pin.root), []);
  }
});

test('removal recovery preserves foreign inodes, changed bytes, extra artifacts and canonical collisions', async t => {
  for (const change of ['inode', 'bytes', 'extra', 'canonical']) {
    const { pin } = await fixture(t), bytes = Buffer.from('Synthetic original.');
    await writeAtomic(pin, 'state.json', bytes, { expectedHash: null });
    await interruptRemoval({ root: pin.root, relative: 'state.json', expectedHash: hashBytes(bytes) });
    const directory = path.join(pin.root, removalContainerName('state.json')), capture = path.join(directory, (await fs.readdir(directory))[0]);
    if (change === 'inode') { await fs.rename(capture, path.join(pin.root, 'retained.json')); await privateFixtureFile(capture, bytes); }
    if (change === 'bytes') await fs.writeFile(capture, 'Synthetic changed.');
    if (change === 'extra') await privateFixtureFile(path.join(directory, 'unknown'), 'Synthetic unknown.');
    if (change === 'canonical') await privateFixtureFile(path.join(pin.root, 'state.json'), bytes);
    const before = await fs.readFile(capture), entries = await fs.readdir(directory);
    for (const operation of [() => readSnapshot(pin, 'state.json', { missing: true }), () => removeExact(pin, 'state.json', hashBytes(bytes)), () => writeAtomic(pin, 'state.json', bytes, { expectedHash: hashBytes(bytes) })]) {
      await assert.rejects(operation(), { code: change === 'canonical' ? 'WRITE_CONFLICT' : 'REMOVAL_CONFLICT' });
    }
    assert.deepEqual(await fs.readFile(capture), before); assert.deepEqual(await fs.readdir(directory), entries);
    if (change === 'canonical') assert.deepEqual(await fs.readFile(path.join(pin.root, 'state.json')), bytes);
  }
});

test('moving a captured file to another parent cannot authorize recovery there', async t => {
  const { pin } = await fixture(t), bytes = Buffer.from('Synthetic parent-bound metadata.');
  await writeAtomic(pin, 'state.json', bytes, { expectedHash: null });
  await interruptRemoval({ root: pin.root, relative: 'state.json', expectedHash: hashBytes(bytes) });
  const other = await createPrivateDirectory(path.join(pin.root, 'other'));
  const source = path.join(pin.root, removalContainerName('state.json')), moved = path.join(other.root, removalContainerName('state.json'));
  await fs.rename(source, moved);
  await assert.rejects(readSnapshot(other, 'state.json', { missing: true }), { code: 'REMOVAL_CONFLICT' });
  await assert.rejects(writeAtomic(other, 'state.json', bytes, { expectedHash: hashBytes(bytes) }), { code: 'REMOVAL_CONFLICT' });
  assert.deepEqual(await fs.readFile(path.join(moved, (await fs.readdir(moved))[0])), bytes);
});

test('retargeting a captured container within its parent cannot authorize another filename', async t => {
  const { pin } = await fixture(t), bytes = Buffer.from('Synthetic target-bound metadata.');
  await writeAtomic(pin, 'run.json', bytes, { expectedHash: null });
  await interruptRemoval({ root: pin.root, relative: 'run.json', expectedHash: hashBytes(bytes) });
  const source = path.join(pin.root, removalContainerName('run.json')), moved = path.join(pin.root, removalContainerName('other.json'));
  await fs.rename(source, moved);
  for (const operation of [() => readSnapshot(pin, 'other.json', { missing: true }), () => writeAtomic(pin, 'other.json', bytes, { expectedHash: hashBytes(bytes) }), () => removeExact(pin, 'other.json', hashBytes(bytes))]) {
    await assert.rejects(operation(), { code: 'REMOVAL_CONFLICT' });
  }
  assert.deepEqual(await fs.readFile(path.join(moved, (await fs.readdir(moved))[0])), bytes);
  await assert.rejects(fs.lstat(path.join(pin.root, 'other.json')), { code: 'ENOENT' });
});

test('a replacement during capture is restored without overwrite and restoration errors retain both conflicts', async t => {
  for (const collision of [false, true]) {
    const { pin } = await fixture(t), original = Buffer.from('Synthetic original.'), foreign = Buffer.from('Synthetic foreign.');
    await writeAtomic(pin, 'state.json', original, { expectedHash: null });
    const target = path.join(pin.root, 'state.json'), rename = fs.rename, link = fs.link;
    const renamed = t.mock.method(fs, 'rename', async (from, to) => {
      if (from === target) { await rename(target, path.join(pin.root, 'retained.json')); await privateFixtureFile(target, foreign); }
      return rename(from, to);
    });
    const restored = t.mock.method(fs, 'link', async (from, to) => {
      if (to === target) {
        if (collision) { await privateFixtureFile(target, 'Synthetic newer replacement.'); return link(from, to); }
        throw Object.assign(new Error('Synthetic restore refusal'), { code: 'EACCES' });
      }
      return link(from, to);
    });
    try { await assert.rejects(removeExact(pin, 'state.json', hashBytes(original)), error => error.code === 'WRITE_CONFLICT' && error.recoveryError.code === (collision ? 'EEXIST' : 'EACCES')); }
    finally { renamed.mock.restore(); restored.mock.restore(); }
    const directory = path.join(pin.root, removalContainerName('state.json'));
    assert.deepEqual(await fs.readFile(path.join(directory, (await fs.readdir(directory))[0])), foreign);
    assert.deepEqual(await fs.readFile(path.join(pin.root, 'retained.json')), original);
    if (collision) assert.equal(await fs.readFile(target, 'utf8'), 'Synthetic newer replacement.');
  }
});

test('two new-target publications cannot overwrite each other', async t => {
  const { pin: privatePin } = await fixture(t);
  const pin = await pinDirectory(privatePin.root);
  const proposals = [Buffer.from('one'), Buffer.from('two')];
  const results = await Promise.allSettled(proposals.map(bytes => writeAtomic(pin, 'new.md', bytes, { expectedHash: null })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  // A competitor can observe the winning publisher's temporary second hard
  // link. Refusing that still-linked inode is as safe as an ordinary conflict.
  assert.ok(['WRITE_CONFLICT', 'PATH_UNSAFE'].includes(results.find(result => result.status === 'rejected').reason.code));
  const winner = results.findIndex(result => result.status === 'fulfilled');
  const saved = await readSnapshot(pin, 'new.md');
  assert.deepEqual(saved.bytes, proposals[winner]);
  assert.equal(saved.hash, results[winner].value.hash);
  assert.equal((await fs.lstat(path.join(pin.root, 'new.md'))).nlink, 1);
  assert.deepEqual(await fs.readdir(pin.root), ['new.md']);
});

test('a competing publisher refuses a target while its exact publication stage is still linked', async t => {
  const { pin: privatePin } = await fixture(t);
  const pin = await pinDirectory(privatePin.root);
  const target = path.join(pin.root, 'new.md');
  const originalLink = fs.link;
  const linked = Promise.withResolvers(), resume = Promise.withResolvers();
  t.mock.method(fs, 'link', async (...args) => {
    await originalLink(...args);
    if (args[1] === target) { linked.resolve(); await resume.promise; }
  });
  const bytes = Buffer.from('winning publication');
  const publication = writeAtomic(pin, 'new.md', bytes, { expectedHash: null });
  try {
    await Promise.race([linked.promise, publication.then(() => assert.fail('Publication bypassed the held link boundary.'))]);
    assert.equal((await fs.lstat(target)).nlink, 2);
    await assert.rejects(writeAtomic(pin, 'new.md', Buffer.from('competing publication'), { expectedHash: null }), { code: 'PATH_UNSAFE' });
    assert.deepEqual(await fs.readFile(target), bytes);
  } finally {
    resume.resolve();
    await publication;
  }
  const saved = await readSnapshot(pin, 'new.md');
  assert.deepEqual(saved.bytes, bytes);
  assert.equal(saved.hash, hashBytes(bytes));
  assert.equal((await fs.lstat(target)).nlink, 1);
  assert.deepEqual(await fs.readdir(pin.root), ['new.md']);
});

test('public notes retain their permission bits and new notes inherit the process umask', { skip: process.platform === 'win32' }, async t => {
  const { pin: privatePin } = await fixture(t);
  const pin = await pinDirectory(privatePin.root);
  const target = path.join(pin.root, 'existing.md');
  await fs.writeFile(target, 'before', { mode: 0o640 });
  const original = await readSnapshot(pin, 'existing.md');
  await writeAtomic(pin, 'existing.md', Buffer.from('after'), { expectedHash: original.hash });
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  await writeAtomic(pin, 'new.md', Buffer.from('new'), { expectedHash: null });
  assert.equal((await fs.stat(path.join(pin.root, 'new.md'))).mode & 0o777, 0o666 & ~process.umask());
});

test('a killed private publisher leaves readable metadata immediately after publication', async t => {
  const { pin } = await fixture(t);
  const child = fork(new URL('./fixtures/file-publisher.mjs', import.meta.url), [pin.root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Publisher did not reach its crash boundary.')), 7000);
    child.once('message', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(child.kill('SIGKILL'), true);
  assert.equal((await exited).signal, 'SIGKILL');
  assert.deepEqual((await readJSON(pin, 'pending.json')).value, { pending: 'synthetic' });
  assert.equal((await fs.stat(path.join(pin.root, 'pending.json'))).nlink, 1);
  assert.deepEqual(await fs.readdir(pin.root), ['pending.json']);
});

test('bounded reads reject over-limit and malformed JSON without modifying it', async t => {
  const { pin } = await fixture(t);
  await writeAtomic(pin, 'bad.json', Buffer.from('{bad'), { expectedHash: null });
  await assert.rejects(readSnapshot(pin, 'bad.json', { maxBytes: 2 }), { code: 'READ_LIMIT_EXCEEDED' });
  await assert.rejects(readJSON(pin, 'bad.json'), { code: 'JSON_INVALID' });
  assert.equal((await readSnapshot(pin, 'bad.json')).hash, hashBytes('{bad'));
});

test('replacement of a pinned directory is detected before a write', async t => {
  const { root, pin } = await fixture(t);
  await fs.rename(pin.root, path.join(root, 'old'));
  await fs.mkdir(pin.root, { mode: 0o700 });
  await assert.rejects(writeJSON(pin, 'settings.json', {}, { expectedHash: null }), { code: 'PATH_CHANGED' });
  assert.deepEqual(await fs.readdir(pin.root), []);
});

test('links and traversal never redirect private reads or writes', async t => {
  const { root, pin } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, 'outside', { mode: 0o600 });
  await fs.link(outside, path.join(pin.root, 'hard.json'));
  await assert.rejects(readSnapshot(pin, 'hard.json'), { code: 'PATH_UNSAFE' });
  await assert.rejects(writeJSON(pin, '../outside', {}, { expectedHash: null }), { code: 'PATH_INVALID' });
  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(pin.root, 'soft.json'));
    await assert.rejects(readSnapshot(pin, 'soft.json'), { code: 'PATH_UNSAFE' });
    await fs.symlink(root, path.join(pin.root, 'linked'));
    await assert.rejects(readSnapshot(pin, 'linked/outside'), { code: 'PATH_UNSAFE' });
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

test('existing public private storage is refused instead of silently chmodded', { skip: process.platform === 'win32' }, async t => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'public');
  await fs.mkdir(directory, { mode: 0o755 });
  await assert.rejects(createPrivateDirectory(directory), { code: 'PRIVATE_ACCESS_UNSAFE' });
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o755);
  await pinDirectory(directory); // Notes need path integrity, not private permissions.
});

test('private placement refuses projects, notes and their ancestors', async t => {
  const { root } = await fixture(t);
  assert.throws(() => assertPrivatePlacement(path.join(root, 'repo', 'private'), { projectRoots: [path.join(root, 'repo')] }), { code: 'PRIVATE_LOCATION_OVERLAP' });
  assert.throws(() => assertPrivatePlacement(root, { noteDestinations: [{ path: path.join(root, 'notes') }] }), { code: 'PRIVATE_LOCATION_OVERLAP' });
  assert.doesNotThrow(() => assertPrivatePlacement(path.join(root, 'private'), { projectRoots: [path.join(root, 'repo')], noteDestinations: [path.join(root, 'notes')] }));
  assert.equal(await canonicalSelection(path.join(root, 'new', 'deep')), path.join(root, 'new', 'deep'));
});


test('atomic cleanup preserves the primary conflict when stage unlink fails', async t => {
  const { pin } = await fixture(t);
  await writeJSON(pin, 'state.json', { before: true }, { expectedHash: null });
  const original = await readSnapshot(pin, 'state.json');
  const unlink = fs.unlink, open = fs.open; let changed = false;
  t.mock.method(fs, 'open', async function(file, ...args) {
    const handle = await open.call(this, file, ...args);
    if (!changed && path.basename(file).startsWith('.state.json.')) {
      changed = true; await fs.writeFile(path.join(pin.root, 'state.json'), 'manual change');
    }
    return handle;
  });
  t.mock.method(fs, 'unlink', async function(file, ...args) {
    if (path.basename(file).startsWith('.state.json.')) throw Object.assign(new Error('Synthetic cleanup denial'), { code: 'EPERM' });
    return unlink.call(this, file, ...args);
  });
  await assert.rejects(writeJSON(pin, 'state.json', { after: true }, { expectedHash: original.hash }), error => error.code === 'WRITE_CONFLICT' && error.cleanupError?.code === 'EPERM');
  assert.equal(await fs.readFile(path.join(pin.root, 'state.json'), 'utf8'), 'manual change');
});


test('explicit atomic stage cleanup removes only exact authoritative bytes', async t => {
  const { pin } = await fixture(t);
  const bytes = Buffer.from('{"authoritative":true}');
  await writeAtomic(pin, 'state.json', bytes, { expectedHash: null });
  const same = '.state.json.10000000-0000-4000-8000-000000000001.tmp';
  const different = '.state.json.10000000-0000-4000-8000-000000000002.tmp';
  const foreign = '.foreign.json.10000000-0000-4000-8000-000000000003.tmp';
  for (const [name, value] of [[same, bytes], [different, Buffer.from('unproven fragment')], [foreign, bytes]]) await writeAtomic(pin, name, value, { expectedHash: null });
  assert.deepEqual(await reclaimAtomicStages(pin, '', { matchesTarget: name => name === 'state.json' }), { removed: 1, incomplete: false });
  assert.deepEqual((await fs.readdir(pin.root)).sort(), [different, foreign, 'state.json'].sort());
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(pin.root, 'state.json'), path.join(pin.root, same));
    assert.equal((await reclaimAtomicStages(pin, '', { matchesTarget: name => name === 'state.json' })).removed, 0);
    assert.equal((await fs.lstat(path.join(pin.root, same))).isSymbolicLink(), true);
  }
});
