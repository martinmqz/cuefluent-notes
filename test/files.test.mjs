import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createPrivateDirectory, pinDirectory, assertPrivatePlacement, canonicalSelection } from '../src/storage/paths.mjs';
import { hashBytes, readSnapshot, readJSON, writeAtomic, writeJSON } from '../src/storage/files.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-v2-files-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pin = await createPrivateDirectory(path.join(root, 'private'));
  return { root, pin };
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
