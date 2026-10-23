import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_VERSION, verifyPackage } from '../tools/packaging.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const readJSON = async file => JSON.parse(await fs.readFile(path.join(repo, file), 'utf8'));
const catalogs = [
  { client: 'codex', file: '.agents/plugins/marketplace.json', directory: 'plugins' },
  { client: 'claude', file: '.claude-plugin/marketplace.json', directory: 'claude' },
];

for (const { client, file, directory } of catalogs) {
  test(`${client} marketplace resolves a complete package bound to its published receipt`, async () => {
    const catalog = await readJSON(file);
    const entries = catalog.plugins.filter(entry => entry.name === 'cuefluent-notes');
    assert.equal(entries.length, 1);
    const entry = entries[0];
    if (client === 'codex') assert.equal(entry.source.source, 'local');
    const source = client === 'codex' ? entry.source.path : entry.source;
    const match = new RegExp(`^\\./${directory}/([^/]+)/cuefluent-notes$`).exec(source);
    assert.ok(match, 'Catalog must select an immutable versioned package folder');
    const version = match[1];
    assert.ok(PACKAGE_VERSION.test(version));
    const receipt = await readJSON(`packaging/releases/${version}/build.json`);
    assert.equal(receipt.schema, 1);
    assert.equal(receipt.version, version);
    const packages = receipt.packages.filter(item => item.client === client);
    assert.equal(packages.length, 1);
    const verified = await verifyPackage(path.join(repo, source), { expectedInventorySha256: packages[0].inventorySha256 });
    assert.equal(verified.client, client);
    assert.equal(verified.version, version);
    assert.equal(verified.trustedInventoryVerified, true);
    const manifest = await readJSON(`${source}/.${client}-plugin/plugin.json`);
    assert.equal(entry.name, manifest.name);
  });
}
