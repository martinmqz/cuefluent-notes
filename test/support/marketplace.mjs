import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INVENTORY, PACKAGE_VERSION, packagePath } from '../../tools/packaging.mjs';
import { createGitRunner } from '../../tools/git.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const clients = [
  { client: 'codex', catalog: '.agents/plugins/marketplace.json', directory: 'plugins' },
  { client: 'claude', catalog: '.claude-plugin/marketplace.json', directory: 'claude' },
];

export async function git(repo, args) {
  return createGitRunner(repo)(args);
}

/** Check staged package bytes without executing distributed code.
 * Untracked files never enter the snapshot; tracked bytes must match the index. */
export async function verifyMarketplaces(repo, pins) {
  const targets = [...clients.map(item => item.catalog), 'plugins', 'claude', 'packaging/releases', 'release.json'];
  const index = new Map();
  for (const record of (await git(repo, ['ls-files', '--stage', '-z', '--', ...targets])).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/.exec(record);
    assert.ok(match, 'Marketplace files must be ordinary, non-executable, unconflicted Git entries');
    const name = packagePath(match[3]);
    assert.ok(!index.has(name), `Duplicate Git entry: ${name}`);
    index.set(name, match[2]);
  }
  const objectFormat = (await git(repo, ['rev-parse', '--show-object-format'])).toString('utf8').trim();
  assert.ok(['sha1', 'sha256'].includes(objectFormat));
  const directories = new Set();
  async function read(name) {
    assert.ok(index.has(name), `Not staged in Git: ${name}`);
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (directories.has(parent)) continue;
      const stat = await fs.lstat(path.join(repo, parent));
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Unsafe directory: ${parent}`);
      directories.add(parent);
    }
    const file = path.join(repo, name), stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024, `Unsafe file: ${name}`);
    const bytes = await fs.readFile(file);
    const blob = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(blob, index.get(name), `Working bytes differ from Git index: ${name}`);
    return bytes;
  }
  async function pinnedJSON(name, digest) {
    const bytes = await read(name);
    assert.equal(sha256(bytes), digest, `Published receipt changed: ${name}`);
    return JSON.parse(bytes);
  }
  const roots = [];
  async function snapshot(root, digest, client, version) {
    const inventoryBytes = await read(`${root}/${INVENTORY}`);
    assert.equal(sha256(inventoryBytes), digest, `Published inventory changed: ${root}`);
    const inventory = JSON.parse(inventoryBytes);
    assert.equal(inventory.client, client);
    assert.equal(inventory.version, version);
    const expected = [INVENTORY, ...inventory.files.map(item => packagePath(item.path))].sort();
    const actual = [...index.keys()].filter(name => name.startsWith(`${root}/`)).map(name => name.slice(root.length + 1)).sort();
    assert.deepEqual(actual, expected, `Staged package file set differs: ${root}`);
    for (const item of inventory.files) {
      const bytes = await read(`${root}/${item.path}`);
      assert.equal(bytes.length, item.bytes, `Published size changed: ${root}/${item.path}`);
      assert.equal(sha256(bytes), item.sha256, `Published file changed: ${root}/${item.path}`);
    }
    roots.push(root);
  }

  const selected = [];
  for (const { client, catalog, directory } of clients) {
    const entries = JSON.parse(await read(catalog)).plugins.filter(entry => entry.name === 'cuefluent-notes');
    assert.equal(entries.length, 1);
    if (client === 'codex') assert.equal(entries[0].source.source, 'local');
    const source = client === 'codex' ? entries[0].source.path : entries[0].source;
    const match = new RegExp(`^\\./${directory}/([^/]+)/cuefluent-notes$`).exec(source);
    assert.ok(match && PACKAGE_VERSION.test(match[1]), 'Catalog must select a versioned package folder');
    selected.push(match[1]);
  }
  assert.equal(selected[0], selected[1], 'Catalog versions differ');
  assert.ok(Object.hasOwn(pins.releases, selected[0]), 'Selected release needs a published receipt pin');
  const receiptPaths = Object.keys(pins.releases).map(version => `packaging/releases/${version}/build.json`).sort();
  assert.deepEqual([...index.keys()].filter(name => name.startsWith('packaging/releases/')).sort(), receiptPaths,
    'Every retained release receipt must have a published digest pin');
  for (const [version, digest] of Object.entries(pins.releases)) {
    assert.ok(PACKAGE_VERSION.test(version));
    const receipt = await pinnedJSON(`packaging/releases/${version}/build.json`, digest);
    assert.equal(receipt.schema, 1);
    assert.equal(receipt.version, version);
    for (const { client, directory } of clients) {
      const packages = receipt.packages.filter(item => item.client === client);
      assert.equal(packages.length, 1);
      await snapshot(`${directory}/${version}/cuefluent-notes`, packages[0].inventorySha256, client, version);
    }
  }
  const historical = await pinnedJSON('release.json', pins.historical.sha256);
  assert.equal(historical.version, pins.historical.version);
  for (const { client, directory } of clients) {
    const packages = historical.archives.filter(item => item.client === client && item.variant === 'hooks');
    assert.equal(packages.length, 1);
    await snapshot(`${directory}/cuefluent-notes`, packages[0].inventorySha256, client, historical.version);
  }
  assert.ok([...index.keys()].filter(name => /^(?:plugins|claude)\//.test(name))
    .every(name => roots.some(root => name.startsWith(`${root}/`))), 'Unverified package folder in Git');
}
