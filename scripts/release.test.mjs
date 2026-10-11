import { SOURCE_CHECKOUT_INPUTS } from './package-inputs.mjs';
import './test-support/isolated-settings.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildRelease } from './release.mjs';
import { archiveFiles, pluginZip, marketplaceTar } from './release-archives.mjs';
import { INVENTORY_FILE } from './package-integrity.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-release-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('release catalogs resolve complete client packages and all four archives work after extraction', async t => {
  const root = await fixture(t);
  const license = await fs.readFile(path.join(sourceRoot, 'LICENSE.md'));
  const devDependencies = Object.keys((await readJSON(path.join(sourceRoot, 'package.json'))).devDependencies ?? {});
  const built = await buildRelease({ outDir: path.join(root, 'release with spaces $value') });
  assert.equal(built.archives.length, 4);
  assert.deepEqual(await readJSON(path.join(built.outDir, 'release.json')), { version: built.version, archives: built.archives });
  const codex = await readJSON(path.join(built.outDir, '.agents/plugins/marketplace.json'));
  const claude = await readJSON(path.join(built.outDir, '.claude-plugin/marketplace.json'));
  assert.equal(codex.name, 'cuefluent');
  assert.equal(claude.name, 'cuefluent');
  for (const [client, relative] of [['codex', codex.plugins[0].source.path], ['claude', claude.plugins[0].source]]) {
    const plugin = path.join(built.outDir, relative);
    const manifest = await readJSON(path.join(plugin, `.${client}-plugin/plugin.json`));
    assert.equal(manifest.version, built.version);
    assert.equal(manifest.name, 'cuefluent-notes');
    await fs.stat(path.join(plugin, 'hooks/hooks.json'));
  }
  const sums = await fs.readFile(path.join(built.outDir, 'artifacts/SHA256SUMS'), 'utf8');
  const snapshot = path.join(built.outDir, 'artifacts', built.marketplaceArchive);
  const snapshotHash = createHash('sha256').update(await fs.readFile(snapshot)).digest('hex');
  assert.ok(sums.includes(`${snapshotHash}  ${built.marketplaceArchive}\n`));
  const restored = path.join(root, 'restored-marketplace');
  await fs.mkdir(restored);
  run('tar', ['-xzf', snapshot, '-C', restored]);
  assert.deepEqual((await fs.readdir(restored)).sort(), ['.agents', '.claude-plugin', 'README.md', 'claude', 'plugins', 'release.json']);
  assert.deepEqual(await readJSON(path.join(restored, 'release.json')), { version: built.version, archives: built.archives });
  assert.deepEqual(await readJSON(path.join(restored, '.agents/plugins/marketplace.json')), codex);
  assert.deepEqual(await readJSON(path.join(restored, '.claude-plugin/marketplace.json')), claude);
  for (const archive of built.archives) {
    const zip = path.join(built.outDir, 'artifacts', archive.name);
    const hash = createHash('sha256').update(await fs.readFile(zip)).digest('hex');
    assert.equal(hash, archive.sha256);
    assert.ok(sums.includes(`${hash}  ${archive.name}\n`));
    const listing = run('unzip', ['-Z1', zip]);
    assert.ok(!listing.split('\n').some(name => name && (!name.startsWith('cuefluent-notes/') || name.split('/').includes('..'))));
    assert.ok(!/\.test\.mjs|\/\.git\/|\/\.local\/|scripts\/install\.mjs/.test(listing));
    const extracted = path.join(root, `${archive.client}-${archive.variant}`);
    run('unzip', ['-q', zip, '-d', extracted]);
    const plugin = path.join(extracted, 'cuefluent-notes');
    await fs.stat(path.join(plugin, `.${archive.client}-plugin/plugin.json`));
    const skill = path.join(plugin, 'skills/cuefluent-notes');
    assert.deepEqual(await fs.readFile(path.join(plugin, 'LICENSE.md')), license);
    assert.deepEqual(await fs.readFile(path.join(skill, 'LICENSE.md')), license);
    assert.equal((await readJSON(path.join(skill, 'package.json'))).license, 'SEE LICENSE IN LICENSE.md');
    assert.equal((await readJSON(path.join(skill, 'package-lock.json'))).packages[''].license, 'SEE LICENSE IN LICENSE.md');
    const integrity = JSON.parse(run(process.execPath, [path.join(skill, 'scripts/package-integrity.mjs'), plugin,
      '--expected-inventory-sha256', archive.inventorySha256], { cwd: root, env: { ...process.env, NODE_PATH: '' } }));
    assert.equal(integrity.trustedReleaseVerified, true);
    assert.equal(integrity.variant, archive.variant);
    await fs.stat(path.join(skill, 'node_modules/markdown-it/LICENSE'));
    for (const dependency of devDependencies) {
      await assert.rejects(fs.stat(path.join(skill, 'node_modules', dependency)), { code: 'ENOENT' });
    }
    assert.equal((await readJSON(path.join(skill, 'package.json'))).devDependencies, undefined);
    assert.ok(Object.values((await readJSON(path.join(skill, 'package-lock.json'))).packages).every(pkg => !pkg.dev));
    const report = JSON.parse(run(process.execPath, [path.join(skill, 'scripts/check-notes.mjs'), path.join(skill, 'examples/decision.md')], { cwd: root, env: { ...process.env, NODE_PATH: '' } }));
    assert.equal(report.errors, 0);
    const config = path.join(root, 'missing-private-config.json');
    const status = JSON.parse(run(process.execPath, [path.join(skill, 'scripts/workflow.mjs'), 'status', '--config', config], { cwd: root }));
    assert.equal(status.configHash, null);
    assert.equal(status.runtime.hookRegistration, archive.variant === 'hooks' ? 'packaged' : 'absent');
    await assert.rejects(fs.stat(config), { code: 'ENOENT' });
    if (archive.variant === 'manual') {
      const hooks = await archiveFiles(path.join(root, `${archive.client}-hooks/cuefluent-notes`));
      const manual = await archiveFiles(plugin);
      assert.deepEqual(manual.filter(file => !['README.md', INVENTORY_FILE].includes(file.name)),
        hooks.filter(file => !['README.md', INVENTORY_FILE].includes(file.name) && !file.name.startsWith('hooks/')));
      assert.match(await fs.readFile(path.join(plugin, 'README.md'), 'utf8'), /manual package[\s\S]*no hook registration/);
    }
  }
  await assert.rejects(fs.stat(path.join(built.outDir, '.manual')), { code: 'ENOENT' });
  await assert.rejects(buildRelease({ outDir: built.outDir }), /already exists/);
  assert.equal((await readJSON(path.join(built.outDir, 'release.json'))).version, built.version);
  await assert.rejects(buildRelease({ outDir: path.join(sourceRoot, 'scripts/unsafe-release') }), /outside package source/);
});

test('archive failure removes only its own partial release and reports the original error', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'failed');
  const original = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (String(file).endsWith('.zip')) throw new Error('Synthetic archive write failure');
    return original(file, ...args);
  });
  await assert.rejects(buildRelease({ outDir: output }), /Synthetic archive write failure/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('release artifacts reproduce across output paths, timezones and umasks', async t => {
  const root = await fixture(t);
  for (const [name, timezone, umask] of [['first', 'America/Los_Angeles', '022'], ['second', 'Asia/Tokyo', '077']]) {
    run(process.execPath, ['--input-type=module', '-e',
      "import { buildRelease } from './scripts/release.mjs'; process.umask(process.argv[2]); await buildRelease({ outDir: process.argv[1] });",
      path.join(root, name), umask], { cwd: sourceRoot, env: { ...process.env, TZ: timezone } });
  }
  for (const name of await fs.readdir(path.join(root, 'first/artifacts'))) {
    assert.deepEqual(await fs.readFile(path.join(root, 'first/artifacts', name)),
      await fs.readFile(path.join(root, 'second/artifacts', name)), name);
  }
  assert.deepEqual(await readJSON(path.join(root, 'first/release.json')), await readJSON(path.join(root, 'second/release.json')));
});

test('archives normalize input order, file timestamps and permissions', async t => {
  const root = await fixture(t);
  const names = ['z.md', '.hidden/file.md', `long/${'a'.repeat(110)}/日本語.md`];
  const archives = [];
  for (const [index, order] of [names, [...names].reverse()].entries()) {
    const directory = path.join(root, String(index));
    for (const name of order) {
      const file = path.join(directory, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `Synthetic content: ${name}\n`, { mode: index ? 0o600 : 0o755 });
      await fs.utimes(file, index + 1, index + 1);
    }
    const files = await archiveFiles(directory);
    archives.push([pluginZip(files), await marketplaceTar(files)]);
  }
  assert.deepEqual(archives[0], archives[1]);
  const snapshot = path.join(root, 'long-paths.tar.gz');
  const restored = path.join(root, 'restored');
  await fs.mkdir(restored);
  await fs.writeFile(snapshot, archives[0][1]);
  run('tar', ['-xzf', snapshot, '-C', restored]);
  for (const name of names) assert.equal(await fs.readFile(path.join(restored, name), 'utf8'), `Synthetic content: ${name}\n`);
  await fs.symlink(path.join(root, process.platform === 'win32' ? '0' : '0/z.md'),
    path.join(restored, 'linked.md'), process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(archiveFiles(restored), /Nonportable archive input/);
});

test('release templates reject outside symlinks and checkout paths before producing output', async t => {
  const root = await fixture(t);
  const checkout = path.join(root, 'source');
  await fs.mkdir(checkout);
  for (const relative of [...SOURCE_CHECKOUT_INPUTS, 'node_modules']) {
    await fs.cp(path.join(sourceRoot, relative), path.join(checkout, relative), { recursive: true });
  }
  const privateFile = path.join(root, 'private.txt');
  const privateBytes = 'Synthetic private content must not enter a release.\n';
  await fs.writeFile(privateFile, privateBytes);
  const output = path.join(root, 'output');
  const attempt = () => spawnSync(process.execPath, [path.join(checkout, 'scripts/release.mjs'), '--out', output], {
    cwd: checkout, encoding: 'utf8',
  });
  for (const relative of ['packaging/codex/marketplace.json', 'packaging/claude/marketplace.json', 'packaging/marketplace-readme.md']) {
    const file = path.join(checkout, relative);
    const original = await fs.readFile(file);
    await fs.rm(file);
    await fs.symlink(process.platform === 'win32' ? root : privateFile, file,
      process.platform === 'win32' ? 'junction' : 'file');
    const linked = attempt();
    assert.equal(linked.status, 2, `Linked ${relative} must be refused before publication.`);
    assert.match(linked.stderr, /nonportable package input/);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    await fs.rm(file);
    await fs.writeFile(file, `${original}\n${checkout}\n`);
    const absolute = attempt();
    assert.equal(absolute.status, 2, `Checkout path in ${relative} must be refused.`);
    assert.match(absolute.stderr, /absolute checkout path/);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    await fs.writeFile(file, original);
  }
  assert.equal(await fs.readFile(privateFile, 'utf8'), privateBytes);
});
