import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { archiveFiles, pluginZip } from './release-archives.mjs';
import { INVENTORY_FILE, verifyPackage, withPackageInventory } from './package-integrity.mjs';
import { verifyMarketplaceFiles, verifyBuiltMarketplace } from './marketplace-content.mjs';
import { smokeEnvironment } from './smoke-environment.mjs';
import { buildRelease } from './release.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let capturedRelease;
async function releaseFixture() {
  capturedRelease ??= (async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-consistency-')));
    after(() => fs.rm(root, { recursive: true, force: true }));
    const built = await buildRelease({ outDir: path.join(root, 'output') });
    return { version: built.version, files: await archiveFiles(built.outDir, { exclude: ['artifacts'] }) };
  })();
  const { version, files } = await capturedRelease;
  // Every mutation test gets independent objects and buffers from one built snapshot.
  return { version, files: files.map(file => ({ name: file.name, bytes: Buffer.from(file.bytes) })) };
}
async function fixture(t, copy = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-build-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  if (copy) for (const name of ['package.json', 'package-lock.json', 'SKILL.md', 'README.md', 'scripts', 'packaging', 'references', 'examples', 'node_modules']) {
    await fs.cp(path.join(sourceRoot, name), path.join(source, name), { recursive: true });
  }
  return { root, source };
}

test('both clients use captured inputs even when source changes after the first client is written', async t => {
  const { root, source } = await fixture(t);
  const { buildPackages } = await import(pathToFileURL(path.join(source, 'scripts/package.mjs')));
  const initial = await fs.readFile(path.join(source, 'SKILL.md'));
  let injected = false;
  // Observe actual file publication, supporting the former copy-based builder too.
  const mutate = async destination => {
    if (!injected && String(destination).endsWith(path.join('codex', 'cuefluent-notes', 'skills', 'cuefluent-notes', 'SKILL.md'))) {
      injected = true;
      await fs.appendFile(path.join(source, 'SKILL.md'), '\nSynthetic source edit during packaging.\n');
    }
  };
  const write = fs.writeFile, copy = fs.copyFile;
  t.mock.method(fs, 'writeFile', async (destination, ...args) => { const result = await write(destination, ...args); await mutate(destination); return result; });
  t.mock.method(fs, 'copyFile', async (from, destination, ...args) => { const result = await copy(from, destination, ...args); await mutate(destination); return result; });
  const built = await buildPackages({ outDir: path.join(root, 'output') });
  assert.equal(injected, true);
  for (const pkg of built.packages) {
    assert.deepEqual(await fs.readFile(path.join(pkg.skillRoot, 'SKILL.md')), initial);
    assert.equal((await verifyPackage(pkg.root)).integrityVerified, true);
  }
});

test('package exclusions remove seeded unwanted files while retaining runtime files and licenses', async t => {
  const { root, source } = await fixture(t);
  const unwanted = ['private-review.md', 'node_modules/yaml/test/private.js', 'node_modules/yaml/.DS_Store', 'node_modules/yaml/seed.test.js'];
  for (const name of unwanted) { await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true }); await fs.writeFile(path.join(source, name), 'SYNTHETIC_EXCLUDED_SENTINEL'); }
  // A dependency's own paths/URLs can coincidentally contain the checkout spelling.
  const dependency = path.join(source, 'node_modules/yaml/package.json');
  const metadata = JSON.parse(await fs.readFile(dependency)); metadata.syntheticPath = source;
  await fs.writeFile(dependency, JSON.stringify(metadata));
  await fs.writeFile(path.join(source, 'node_modules/yaml/synthetic-path.js'), `// dependency path: ${source}\n`);
  const { buildPackages, readPortableSource } = await import(pathToFileURL(path.join(source, 'scripts/package.mjs')));
  const built = await buildPackages({ outDir: path.join(root, 'output') });
  for (const pkg of built.packages) {
    const files = await archiveFiles(pkg.root);
    assert(!files.some(f => f.bytes.includes('SYNTHETIC_EXCLUDED_SENTINEL')));
    assert(files.some(f => f.name.endsWith('/yaml/LICENSE')));
    assert(files.some(f => f.name.endsWith('/yaml/dist/index.js')));
    assert(files.some(f => f.name.endsWith('/yaml/synthetic-path.js') && f.bytes.includes(source)));
  }
  await fs.appendFile(path.join(source, 'README.md'), source);
  await assert.rejects(readPortableSource('README.md'), /absolute checkout path/);
});

test('directory package file modes are normalized despite a restrictive umask', { skip: process.platform === 'win32' }, async t => {
  const { root } = await fixture(t, false), output = path.join(root, 'output');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { buildPackages } from "./scripts/package.mjs"; process.umask(0o077); await buildPackages({ outDir: process.argv[1] });', output],
  { cwd: sourceRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const file of await archiveFiles(output)) assert.equal((await fs.stat(path.join(output, file.name))).mode & 0o777, 0o644, file.name);
});

test('builds reject stale shared metadata and stale catalog text with no published output', async t => {
  const { root, source } = await fixture(t);
  const output = path.join(root, 'output');
  const run = () => spawnSync(process.execPath, [path.join(source, 'scripts/release.mjs'), '--out', output], { encoding: 'utf8' });
  for (const [relative, change] of [
    ['packaging/claude/plugin.json', value => value.description += ' stale'],
    ['packaging/codex/plugin.json', value => value.author.name += ' stale'],
    ['packaging/codex/plugin.json', value => value.interface.shortDescription += ' stale'],
    ['packaging/claude/marketplace.json', value => value.plugins[0].description += ' stale'],
  ]) {
    const file = path.join(source, relative), original = await fs.readFile(file), value = JSON.parse(original);
    change(value); await fs.writeFile(file, JSON.stringify(value));
    const result = run(); assert.equal(result.status, 2); assert.match(result.stderr, /metadata differs|description differs/);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    await fs.writeFile(file, original);
  }
});

test('marketplace verification rejects coherently rehashed divergence between client payloads', async () => {
  let { version, files } = await releaseFixture();
  const prefix = 'claude/cuefluent-notes/';
  const changed = files.filter(f => f.name.startsWith(prefix)).map(f => ({ name: f.name.slice(prefix.length), bytes: f.bytes }));
  changed.find(f => f.name === 'skills/cuefluent-notes/SKILL.md').bytes = Buffer.from('Synthetic divergent skill.');
  const payload = withPackageInventory(changed, { client: 'claude', version, withHooks: true });
  files = [...files.filter(f => !f.name.startsWith(prefix)), ...payload.map(f => ({ ...f, name: prefix + f.name }))];
  const record = files.find(f => f.name === 'release.json'), release = JSON.parse(record.bytes);
  const archive = release.archives.find(a => a.client === 'claude' && a.variant === 'hooks');
  archive.sha256 = hash(pluginZip(payload)); archive.inventorySha256 = hash(payload.find(f => f.name === INVENTORY_FILE).bytes);
  record.bytes = Buffer.from(JSON.stringify(release));
  assert.throws(() => verifyMarketplaceFiles(files), /Shared client package contents differ/);
});

test('only releases before 0.11.0 may omit package inventories', async () => {
  const { files: original } = await releaseFixture();
  for (const version of ['0.10.99', '0.11.0', '0.12.0', '1.0.0']) {
    const files = original.filter(f => !f.name.endsWith(`/${INVENTORY_FILE}`)).map(f => ({ ...f }));
    const record = files.find(f => f.name === 'release.json'), release = JSON.parse(record.bytes);
    release.version = version;
    for (const [client, prefix] of [['codex', 'plugins/cuefluent-notes/'], ['claude', 'claude/cuefluent-notes/']]) {
      for (const relative of [`.${client}-plugin/plugin.json`, 'skills/cuefluent-notes/package.json']) {
        const file = files.find(f => f.name === prefix + relative), value = JSON.parse(file.bytes);
        value.version = version; file.bytes = Buffer.from(JSON.stringify(value));
      }
      if (client === 'claude') files.find(f => f.name === prefix + 'skills/cuefluent-notes/SKILL.md').bytes = Buffer.from('Synthetic divergent legacy skill.');
      const archive = release.archives.find(a => a.client === client && a.variant === 'hooks');
      archive.sha256 = hash(pluginZip(files.filter(f => f.name.startsWith(prefix)).map(f => ({ ...f, name: f.name.slice(prefix.length) }))));
      delete archive.inventorySha256;
    }
    record.bytes = Buffer.from(JSON.stringify(release));
    if (version === '0.10.99') assert.equal(verifyMarketplaceFiles(files).version, version);
    else assert.throws(() => verifyMarketplaceFiles(files), /invalid package inventory/);
  }
});

test('marketplace inventories must describe the enclosing client and hooks variant', async () => {
  const { version, files: original } = await releaseFixture(), prefix = 'plugins/cuefluent-notes/';
  for (const variant of ['manual', 'wrong-client']) {
    let payload = original.filter(f => f.name.startsWith(prefix)).map(f => ({ ...f, name: f.name.slice(prefix.length) }));
    if (variant === 'manual') payload = payload.filter(f => !f.name.startsWith('hooks/'));
    else payload.push({ name: '.claude-plugin/plugin.json', bytes: original.find(f => f.name === 'claude/cuefluent-notes/.claude-plugin/plugin.json').bytes });
    payload = withPackageInventory(payload, { client: variant === 'manual' ? 'codex' : 'claude', version, withHooks: variant !== 'manual' });
    const files = [...original.filter(f => !f.name.startsWith(prefix)).map(f => ({ ...f })), ...payload.map(f => ({ ...f, name: prefix + f.name }))];
    const record = files.find(f => f.name === 'release.json'), release = JSON.parse(record.bytes);
    const archive = release.archives.find(a => a.client === 'codex' && a.variant === 'hooks');
    archive.sha256 = hash(pluginZip(payload)); archive.inventorySha256 = hash(payload.find(f => f.name === INVENTORY_FILE).bytes);
    record.bytes = Buffer.from(JSON.stringify(release));
    assert.throws(() => verifyMarketplaceFiles(files), /package inventory identity/);
  }
});

test('build verification binds the final snapshot to emitted ZIP inputs and digests', async () => {
  const { version, files } = await releaseFixture(), release = JSON.parse(files.find(f => f.name === 'release.json').bytes);
  const captured = new Map(['codex', 'claude'].map(client => {
    const prefix = `${client === 'codex' ? 'plugins' : 'claude'}/cuefluent-notes/`;
    return [client, { sha256: release.archives.find(a => a.client === client && a.variant === 'hooks').sha256,
      files: files.filter(f => f.name.startsWith(prefix)).map(f => ({ ...f, name: f.name.slice(prefix.length) })) }];
  }));
  assert.equal(verifyBuiltMarketplace(files, `v${version}`, captured).version, version);
  for (const change of ['contents', 'missing', 'extra', 'digest']) {
    const { files: changed } = await releaseFixture();
    const index = changed.findIndex(f => f.name === 'plugins/cuefluent-notes/README.md');
    if (change === 'contents') changed[index].bytes = Buffer.from('Synthetic changed package.');
    if (change === 'missing') changed.splice(index, 1);
    if (change === 'extra') changed.push({ name: 'plugins/cuefluent-notes/unexpected.txt', bytes: Buffer.from('Synthetic extra file.') });
    if (change === 'digest') {
      const record = changed.find(f => f.name === 'release.json'), value = JSON.parse(record.bytes);
      value.archives.find(a => a.client === 'codex' && a.variant === 'hooks').sha256 = '0'.repeat(64);
      record.bytes = Buffer.from(JSON.stringify(value));
    }
    assert.throws(() => verifyBuiltMarketplace(changed, `v${version}`, captured), /hooks-ZIP digest/);
  }
});

test('release-source fixtures ignore inherited Git repository and configuration overrides', async t => {
  const { root } = await fixture(t, false);
  const env = { ...smokeEnvironment(root), GIT_DIR: path.join(root, 'not-a-repository'), GIT_WORK_TREE: root,
    GIT_INDEX_FILE: path.join(root, 'foreign-index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(root, 'foreign-hooks') };
  await fs.mkdir(env.TMPDIR);
  const result = spawnSync(process.execPath, ['--test', path.join(sourceRoot, 'scripts/release-source.test.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await assert.rejects(fs.stat(env.GIT_INDEX_FILE), { code: 'ENOENT' });
  await assert.rejects(fs.stat(env.GIT_DIR), { code: 'ENOENT' });
});
