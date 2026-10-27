import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clients, git, sha256, verifyMarketplaces } from './support/marketplace.mjs';

const repo = path.resolve(import.meta.dirname, '..');
// Add a pin only after independently checking the authorized release asset.
// Keep earlier pins: every retained snapshot is checked, including 0.15.1.
const published = {
  releases: {
    '0.16.0': 'a6a20b14680d2173cdf9aa79e77fe1309d76e2d528177d4561494744eb515da0',
    '0.17.0': '0790b8756f6e424e0cfb83e0dc0e67e68f1496528f88875e6099c51d5b2fddc1',
    '0.18.0': '8a3ab7cf0c034df52aa9e239ce37a2304b7616c12d7203861f1a66dabdda4072',
    '0.19.0': 'c0b69002aa48de4fe94b9ad84ec7c225ec8ec4fa337ea6098ee4086a7c58d1f9',
  },
  historical: { version: '0.15.1', sha256: 'fb68d21426e23546ec272a6969e8084bd21e4189dcfb22dfdb10a85d7bbd13a4' },
};
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

test('both catalogs and every retained package match pinned published bytes in Git', async () => {
  await verifyMarketplaces(repo, published);
});

async function fixture(t, versions = ['0.16.0']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-marketplace-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--quiet', '--template=', '--object-format=sha1']);
  const write = async (name, bytes) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  for (const name of ['.gitattributes', '.gitignore']) await write(name, await fs.readFile(path.join(repo, name)));
  const pins = { releases: {}, historical: { version: '0.15.1' } };
  async function snapshot(directory, version, client) {
    const files = [{ path: 'README.md', bytes: Buffer.from('Synthetic package\r\n') },
      { path: 'node_modules/synthetic/index.js', bytes: Buffer.from('export const synthetic = true;\r\n') }];
    const inventory = json({ client, version, files: files.map(item => ({ path: item.path, bytes: item.bytes.length, sha256: sha256(item.bytes) })) });
    for (const item of files) await write(`${directory}/${item.path}`, item.bytes);
    await write(`${directory}/package-inventory.json`, inventory);
    return { client, inventorySha256: sha256(inventory) };
  }
  for (const version of versions) {
    const packages = [];
    for (const { client, directory } of clients) packages.push(await snapshot(`${directory}/${version}/cuefluent-notes`, version, client));
    const receipt = json({ schema: 1, version, packages });
    await write(`packaging/releases/${version}/build.json`, receipt);
    pins.releases[version] = sha256(receipt);
  }
  const archives = [];
  for (const { client, catalog, directory } of clients) {
    archives.push({ ...await snapshot(`${directory}/cuefluent-notes`, '0.15.1', client), variant: 'hooks' });
    const source = `./${directory}/${versions.at(-1)}/cuefluent-notes`;
    await write(catalog, json({ plugins: [{ name: 'cuefluent-notes', source: client === 'codex' ? { source: 'local', path: source } : source }] }));
  }
  const historical = json({ version: '0.15.1', archives });
  pins.historical.sha256 = sha256(historical);
  await write('release.json', historical);
  await git(root, ['add', '-f', '--', '.gitattributes', '.gitignore', '.agents', '.claude-plugin', 'plugins', 'claude', 'packaging', 'release.json']);
  return { root, pins, write, stage: (...files) => git(root, ['add', '-f', '--', ...files]) };
}

test('untracked OS files are ignored while accidentally staged extras are rejected', async t => {
  const f = await fixture(t), root = 'claude/0.16.0/cuefluent-notes';
  for (const name of ['.DS_Store', 'node_modules/Thumbs.db', 'desktop.ini']) await f.write(`${root}/${name}`, 'Synthetic OS housekeeping');
  await verifyMarketplaces(f.root, f.pins);
  await f.stage(`${root}/.DS_Store`);
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Staged package file set differs/);
});

test('a dependency present on disk but missing from Git is rejected', async t => {
  const f = await fixture(t), dependency = 'plugins/0.16.0/cuefluent-notes/node_modules/synthetic/index.js';
  await git(f.root, ['rm', '--cached', '--', dependency]);
  assert.ok((await fs.stat(path.join(f.root, dependency))).isFile());
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Staged package file set differs/);
});

test('rewritten package, inventory and receipt cannot replace a published receipt pin', async t => {
  const f = await fixture(t), root = 'claude/0.16.0/cuefluent-notes';
  const bytes = Buffer.from('Changed package\n');
  await f.write(`${root}/README.md`, bytes);
  const inventory = JSON.parse(await fs.readFile(path.join(f.root, root, 'package-inventory.json')));
  Object.assign(inventory.files.find(item => item.path === 'README.md'), { bytes: bytes.length, sha256: sha256(bytes) });
  const inventoryBytes = json(inventory); await f.write(`${root}/package-inventory.json`, inventoryBytes);
  const receiptPath = 'packaging/releases/0.16.0/build.json', receipt = JSON.parse(await fs.readFile(path.join(f.root, receiptPath)));
  receipt.packages.find(item => item.client === 'claude').inventorySha256 = sha256(inventoryBytes);
  await f.write(receiptPath, json(receipt)); await f.stage(root, receiptPath);
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Published receipt changed/);
});

test('all retained versions are checked after both catalogs advance', async t => {
  const f = await fixture(t, ['0.16.0', '0.17.0']);
  await verifyMarketplaces(f.root, f.pins);
  const old = 'plugins/0.16.0/cuefluent-notes/README.md';
  await f.write(old, 'Changed retained package\n'); await f.stage(old);
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Published (?:size|file) changed/);
});

test('historical package changes and missing files cannot hide behind the current catalog', async t => {
  const f = await fixture(t), old = 'claude/cuefluent-notes/README.md';
  await f.write(old, 'Changed historical package\n');
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Working bytes differ from Git index/);
  await f.stage(old);
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Published (?:size|file) changed/);
  await git(f.root, ['rm', '--cached', '--', old]);
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Staged package file set differs/);
});

test('the historical release record remains byte-exact', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.root, 'release.json'), '\n'); await f.stage('release.json');
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Published receipt changed/);
});

test('catalogs must advance together even when both releases are valid', async t => {
  const f = await fixture(t, ['0.16.0', '0.17.0']), catalog = '.claude-plugin/marketplace.json';
  await f.write(catalog, json({ plugins: [{ name: 'cuefluent-notes', source: './claude/0.16.0/cuefluent-notes' }] }));
  await f.stage(catalog);
  await assert.rejects(verifyMarketplaces(f.root, f.pins), /Catalog versions differ/);
});

test('future snapshot directories preserve CRLF and force-stage ignored dependencies', async t => {
  const f = await fixture(t, ['0.17.0']);
  await git(f.root, ['config', 'core.autocrlf', 'true']);
  for (const { directory } of clients) {
    const name = `${directory}/0.17.0/cuefluent-notes/node_modules/synthetic/index.js`;
    await git(f.root, ['rm', '--cached', '--', name]);
    await git(f.root, ['check-ignore', '--', name]);
    await git(f.root, ['add', '--', `${directory}/0.17.0/cuefluent-notes`]).catch(error => assert.equal(error.status, 1));
    await assert.rejects(verifyMarketplaces(f.root, f.pins), /Staged package file set differs/);
    await f.stage(`${directory}/0.17.0/cuefluent-notes`);
    const blob = await git(f.root, ['show', `:${name}`]);
    assert.deepEqual(blob, await fs.readFile(path.join(f.root, name)));
    await fs.unlink(path.join(f.root, name));
    await git(f.root, ['checkout-index', '--', name]);
    assert.deepEqual(await fs.readFile(path.join(f.root, name)), blob);
  }
  await verifyMarketplaces(f.root, f.pins);
});
