import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readBoundedBytes, windowsAbsolute, syncDirectory } from './file-io.mjs';

test('Windows paths require an explicit drive or share and ordinary filenames', () => {
  for (const value of ['C:\\Users\\café\\Notes', 'c:/Notes/topic.md', '\\\\server\\share\\folder\\note.md']) assert.equal(windowsAbsolute(value), true, value);
  for (const value of ['C:notes', '\\notes', '/notes', '\\\\?\\C:\\notes', '\\\\.\\pipe\\notes',
    'C:\\notes\\NUL.md', 'C:\\notes\\COM¹.md', 'C:\\notes\\note.md:stream', 'C:\\notes.\\note.md',
    'C:\\notes \\note.md', '\\\\server', '\\\\server\\share\\a?.md']) assert.equal(windowsAbsolute(value), false, value);
});
test('guarded reads refuse links and replacement between inspection and open', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'selected.md');
  const other = path.join(root, 'other.md');
  await fs.writeFile(file, 'selected');
  await fs.writeFile(other, 'unselected');
  const link = path.join(root, 'linked.md');
  await fs.symlink(other, link);
  await assert.rejects(readBoundedBytes(link, { noFollow: true }), /regular/);
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === file) await fs.rename(other, file);
    return open(...args);
  });
  await assert.rejects(readBoundedBytes(file, { noFollow: true }), /identity changed/);
});
test('directory sync accepts real directories and preserves missing-path errors', async t => {
  const root = await fixture(t);
  await syncDirectory(root);
  await assert.rejects(syncDirectory(path.join(root, 'missing')), { code: 'ENOENT' });
});
test('missing guarded reads tolerate unlink after open and always close the handle', async t => {
  const file = path.join(await fixture(t), 'journal.json');
  const open = fs.open;
  let closed = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === file) {
      const close = handle.close.bind(handle);
      handle.close = async () => { closed++; await close(); };
      await fs.unlink(file);
    }
    return handle;
  });
  await fs.writeFile(file, '{}');
  assert.equal(await readBoundedBytes(file, { missing: true, noFollow: true }), null);
  assert.equal(closed, 1);
  await fs.writeFile(file, '{}');
  await assert.rejects(readBoundedBytes(file, { noFollow: true }), { code: 'ENOENT' });
  assert.equal(closed, 2);
});

const scripts = path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  // Retain OS aliases (such as /var or /tmp); canonicalizing fixtures hid a CLI bug.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-io-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
test('all CLI entry points execute through symlinked directories and main-file links', async t => {
  const directory = await fixture(t);
  const linked = path.join(directory, 'linked-scripts');
  await fs.symlink(scripts, linked, 'dir');
  for (const name of ['check-notes', 'safe-update', 'package', 'workflow', 'collection-hooks']) {
    const fileLink = path.join(directory, `${name}.mjs`);
    await fs.symlink(path.join(scripts, `${name}.mjs`), fileLink);
    for (const entry of [fileLink, path.join(linked, `${name}.mjs`)]) {
      const run = spawnSync(process.execPath, [entry, name === 'collection-hooks' ? 'codex' : '--help'], { input: '{broken', encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 0, run.stderr);
      if (name === 'collection-hooks') { assert.equal(run.stdout, ''); assert.match(run.stderr, /collection unavailable/); }
      else assert.match(run.stdout, name === 'workflow' ? /commands/ : /Usage:/);
    }
  }
});
test('bounded reads keep exact BOM bytes and allocate according to actual small-file size', async t => {
  const file = path.join(await fixture(t), 'small.md');
  const original = Buffer.from('\ufeff# Topic\n## Subject\nEvidence.\n');
  await fs.writeFile(file, original);
  const bytes = await readBoundedBytes(file);
  assert.deepEqual(bytes, original);
  assert.ok(bytes.buffer.byteLength < 4096);
  await fs.writeFile(file, Buffer.from([0xff]));
  await assert.rejects(readBoundedBytes(file), /encoded data/);
  await fs.writeFile(file, '123456');
  await assert.rejects(readBoundedBytes(file, { maxBytes: 5 }), /at most/);
  await fs.unlink(file);
  assert.equal(await readBoundedBytes(file, { missing: true }), null);
  await assert.rejects(readBoundedBytes(file), { code: 'ENOENT' });
});
test('growth after the opened-file stat is read completely or rejected at the byte limit', async t => {
  const file = path.join(await fixture(t), 'growing.md');
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalStat = handle.stat.bind(handle);
    handle.stat = async () => {
      const before = await originalStat();
      await fs.appendFile(file, 'additional text');
      return before;
    };
    return handle;
  });
  await fs.writeFile(file, 'x');
  assert.equal((await readBoundedBytes(file)).toString(), 'xadditional text');
  await fs.writeFile(file, 'x');
  await assert.rejects(readBoundedBytes(file, { maxBytes: 4 }), /exceeds/);
});
test('checker rejects FIFO notes and FIFO cases without waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const directory = await fixture(t);
  const fifo = path.join(directory, 'pipe.md');
  const note = path.join(directory, 'note.md');
  await fs.writeFile(note, '# T\n## S\nEvidence.\n');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  for (const args of [[fifo], ['--cases', fifo, note]]) {
    const run = spawnSync(process.execPath, [path.join(scripts, 'check-notes.mjs'), ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 2, String(run.error ?? run.stderr));
    assert.match(run.stderr, /regular/);
  }
});
