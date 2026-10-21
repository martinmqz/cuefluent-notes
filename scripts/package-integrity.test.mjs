import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INVENTORY_FILE, withPackageInventory, verifyPackage, verifyPackageFiles, packagePath } from './package-integrity.mjs';
import { verifyMarketplaceSnapshot } from './marketplace-content.mjs';
import { archiveFiles } from './release-archives.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const manifest = JSON.parse(await fs.readFile(new URL('../packaging/claude/plugin.json', import.meta.url)));
const base = () => [
  { name: 'README.md', bytes: Buffer.from('Synthetic plugin.') },
  { name: '.claude-plugin/plugin.json', bytes: encode({ ...manifest, version: '1.2.3' }) },
  { name: 'skills/cuefluent-notes/SKILL.md', bytes: Buffer.from('Synthetic skill.') },
  { name: 'skills/cuefluent-notes/package.json', bytes: encode({ name: 'cuefluent-notes', version: '1.2.3' }) },
  { name: 'skills/cuefluent-notes/scripts/example.mjs', bytes: Buffer.from('export const example = true;') },
];
const packaged = () => withPackageInventory(base(), { client: 'claude', version: '1.2.3', withHooks: false });
const expected = files => hash(files.find(f => f.name === INVENTORY_FILE).bytes);
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-integrity-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, files) {
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file.name)), { recursive: true }); await fs.writeFile(path.join(root, file.name), file.bytes); }
}

test('integrity distinguishes internal consistency, trusted identity and coherent inventory replacement', async t => {
  const root = await fixture(t), files = packaged(), trusted = expected(files);
  await write(root, files);
  assert.equal((await verifyPackage(root)).integrityVerified, true);
  assert.equal((await verifyPackage(root)).trustedReleaseVerified, false);
  assert.equal((await verifyPackage(root, { expectedInventorySha256: trusted })).trustedReleaseVerified, true);
  assert.equal((await verifyPackage(root, { expectedInventorySha256: '0'.repeat(64) })).trustedReleaseVerified, false);
  const revised = base(); revised.find(f => f.name.endsWith('example.mjs')).bytes = Buffer.from('export const example = false;');
  await write(root, withPackageInventory(revised, { client: 'claude', version: '1.2.3', withHooks: false }));
  const result = await verifyPackage(root, { expectedInventorySha256: trusted });
  assert.equal(result.integrityVerified, true);
  assert.equal(result.trustedInventoryMatches, false);
  assert.equal(result.trustedReleaseVerified, false);
});

test('coherent inventories cannot authorize manifests missing current required fields', async () => {
  for (const client of ['claude', 'codex']) {
    const template = JSON.parse(await fs.readFile(new URL(`../packaging/${client}/plugin.json`, import.meta.url)));
    const manifestPath = `.${client}-plugin/plugin.json`;
    const current = base().map(file => file.name === '.claude-plugin/plugin.json'
      ? { name: manifestPath, bytes: encode({ ...template, version: '1.2.3' }) } : file);
    for (const missing of [['mcpServers'], ['license'], ['mcpServers', 'license']]) {
      const files = withPackageInventory(current.map(file => ({ name: file.name, bytes: Buffer.from(file.bytes) })),
        { client, version: '1.2.3', withHooks: false });
      const file = files.find(file => file.name === manifestPath), value = JSON.parse(file.bytes);
      for (const field of missing) delete value[field];
      file.bytes = encode(value);
      const inventoryFile = files.find(file => file.name === INVENTORY_FILE), inventory = JSON.parse(inventoryFile.bytes);
      const entry = inventory.files.find(entry => entry.path === manifestPath);
      entry.bytes = file.bytes.length; entry.sha256 = hash(file.bytes);
      inventoryFile.bytes = encode(inventory);
      const result = verifyPackageFiles(files, { expectedInventorySha256: expected(files) });
      assert.deepEqual(result.counts, { missing: 0, changed: 0, unexpected: 0 });
      assert.equal(result.identityMatches, false);
      assert.equal(result.integrityVerified, false);
      assert.equal(result.trustedReleaseVerified, false);
      assert.throws(() => withPackageInventory(files, { client, version: '1.2.3', withHooks: false }), /identity differs/);
    }
  }
});

test('verification reports missing, changed and unexpected files without writing', async t => {
  const root = await fixture(t), files = packaged(); await write(root, files);
  await fs.rm(path.join(root, 'README.md'));
  await fs.appendFile(path.join(root, 'skills/cuefluent-notes/SKILL.md'), ' changed');
  await fs.writeFile(path.join(root, 'unexpected.txt'), 'Unexpected.');
  const before = await archiveFiles(root);
  const result = await verifyPackage(root);
  assert.deepEqual(result.counts, { missing: 1, changed: 1, unexpected: 1 });
  assert.deepEqual(result.missing, ['README.md']);
  assert.deepEqual(result.changed, ['skills/cuefluent-notes/SKILL.md']);
  assert.deepEqual(result.unexpected, ['unexpected.txt']);
  assert.equal(result.integrityVerified, false);
  assert.deepEqual(await archiveFiles(root), before);
});

test('only bounded ordinary host marker files are ignored; links and special files are rejected', async t => {
  const root = await fixture(t); await write(root, packaged());
  await fs.mkdir(path.join(root, '.in_use'));
  for (const name of ['.DS_Store', 'Thumbs.db', '.in_use/123']) await fs.writeFile(path.join(root, name), 'marker');
  assert.deepEqual((await verifyPackage(root)).ignored, ['.DS_Store', '.in_use/123', 'Thumbs.db']);
  await fs.writeFile(path.join(root, '.in_use/unexpected'), 'not a marker');
  assert.deepEqual((await verifyPackage(root)).unexpected, ['.in_use/unexpected']);
  await fs.rm(path.join(root, '.DS_Store'));
  await fs.symlink(path.join(root, process.platform === 'win32' ? 'skills' : 'README.md'),
    path.join(root, '.DS_Store'), process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(verifyPackage(root), /Nonportable/);
  await fs.rm(path.join(root, '.DS_Store'));
  if (process.platform !== 'win32') {
    const fifo = path.join(root, '.DS_Store');
    const made = spawnSync('mkfifo', [fifo]); assert.equal(made.status, 0);
    await assert.rejects(verifyPackage(root), /Nonportable/);
  }
});

test('package and snapshot verification reject a symlink root before reading its children', async t => {
  const root = await fixture(t), actual = path.join(root, 'actual'), link = path.join(root, 'linked');
  await write(actual, packaged());
  await fs.symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  const open = fs.open; let opened = 0;
  t.mock.method(fs, 'open', async (...args) => { opened++; return open(...args); });
  for (const selected of [link, link + path.sep, link + path.sep + path.sep]) {
    await assert.rejects(verifyPackage(selected), /Nonportable/);
    await assert.rejects(verifyMarketplaceSnapshot(selected), /snapshot root/);
    await assert.rejects(archiveFiles(selected), /archive root/);
  }
  assert.equal(opened, 0, 'a rejected root must not read the inventory or any payload');
});

test('inventory parsing rejects unsupported, duplicate, unsafe, over-budget and inconsistent records', () => {
  for (const name of ['../escape', '/absolute', 'a\\b', 'a:b', 'a//b', 'a/./b', 'a/..', 'nul.txt', 'a.', 'a\u0000b',
    'COM¹.txt', 'lpt²', 'a\u0085b']) assert.throws(() => packagePath(name), /path/);
  const files = packaged();
  for (const mutate of [
    value => value.schemaVersion++,
    value => value.files.push(value.files[0]),
    value => value.files[0].path = '../escape',
    value => value.files[0].bytes = 17 * 1024 * 1024,
    value => value.variant = 'hooks',
    value => value.files = value.files.filter(f => !f.path.endsWith('SKILL.md')),
  ]) {
    const changed = files.map(f => ({ ...f }));
    const entry = changed.find(f => f.name === INVENTORY_FILE), value = JSON.parse(entry.bytes);
    mutate(value); entry.bytes = encode(value);
    assert.throws(() => verifyPackageFiles(changed));
  }
  const duplicate = files.map(f => f.name === INVENTORY_FILE ? { ...f, bytes: Buffer.from(f.bytes.toString().replace('"schemaVersion": 1,', '"schemaVersion": 2,\n  "schemaVersion": 1,')) } : f);
  assert.throws(() => verifyPackageFiles(duplicate), /canonical/);
  assert.throws(() => verifyPackageFiles(files, { expectedInventorySha256: '../invalid' }), /SHA-256/);
  assert.throws(() => withPackageInventory(base().map(f => f.name === '.claude-plugin/plugin.json' ? { ...f, bytes: encode({ ...manifest, version: '9.0.0' }) } : f),
    { client: 'claude', version: '1.2.3', withHooks: false }), /identity/);
});

test('verification refuses missing inventories and oversized files', async t => {
  const root = await fixture(t); await write(root, base());
  await assert.rejects(verifyPackage(root), /Package inventory is missing/);
  await write(root, packaged());
  const file = await fs.open(path.join(root, 'too-large.bin'), 'w');
  try { await file.truncate(17 * 1024 * 1024); } finally { await file.close(); }
  await assert.rejects(verifyPackage(root), /size limit/);
});

test('verification refuses an earlier file changed while later package files are being inspected', async t => {
  const root = await fixture(t); await write(root, packaged());
  const original = fs.open;
  let injected = false, earlier;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (path.basename(String(file)) !== INVENTORY_FILE) {
      if (earlier && !injected) {
        injected = true;
        await fs.appendFile(earlier, ' ');
      }
      earlier = file;
    }
    return original(file, ...args);
  });
  await assert.rejects(verifyPackage(root), /changed during verification/);
  assert.equal(injected, true);
});

test('invalid or missing inventories prevent reads of files in a mistakenly selected directory', async t => {
  const root = await fixture(t), privateFile = path.join(root, 'synthetic-note.txt');
  await fs.writeFile(privateFile, 'Synthetic private content.');
  const original = fs.open; let opened = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === privateFile) opened++;
    return original(file, ...args);
  });
  await assert.rejects(verifyPackage(root), /inventory is missing/);
  await fs.writeFile(path.join(root, INVENTORY_FILE), '{"schemaVersion":999}');
  await assert.rejects(verifyPackage(root), /Unsupported/);
  assert.equal(opened, 0);
});

test('CLI distinguishes verified, mismatching and unsupported inputs', async t => {
  const root = await fixture(t), files = packaged(); await write(root, files);
  const cli = new URL('./package-integrity.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, [fileURLToPath(cli), ...args], { encoding: 'utf8' });
  assert.equal(run([root]).status, 0);
  assert.equal(run([root, '--expected-inventory-sha256', expected(files)]).status, 0);
  assert.equal(run([root, '--expected-inventory-sha256', '0'.repeat(64)]).status, 1);
  await fs.rm(path.join(root, 'README.md')); assert.equal(run([root]).status, 1);
  assert.equal(run(['relative/path']).status, 2);
  assert.equal(run(['--help']).status, 0);
});
