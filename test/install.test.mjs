import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installPackage } from '../tools/install.mjs';
import { verifyPackage } from '../tools/packaging.mjs';
import { packageSource } from './fixtures/package-source.mjs';

const execute = promisify(execFile);
const options = (fixture, item, name) => ({ sourceRoot: path.join(fixture.output, item.path), destination: path.join(fixture.root, name), expectedInventorySha256: item.inventorySha256 });

test('symlink-spelled companion entry points run verification, copying and invalid-command checks', { skip: process.platform === 'win32' ? 'POSIX symlink primitive; entry guards use native import.meta.main on every platform.' : false }, async t => {
  const f = await packageSource(t), item = f.built.packages[0], alias = path.join(f.root, 'alias');
  for (const name of ['ci.mjs', 'git.mjs']) {
    await fs.copyFile(path.resolve(import.meta.dirname, '../tools', name), path.join(f.source, 'tools', name));
  }
  await fs.symlink(f.source, alias, 'dir');
  const packageRoot = path.join(f.output, item.path), verifier = path.join(alias, 'tools/packaging.mjs');
  await assert.rejects(execute(process.execPath, [verifier, 'verify', packageRoot, '--expected-inventory-sha256', '0'.repeat(64)]), error => error.code === 1 && /PACKAGE_TRUSTED_DIGEST_MISMATCH/.test(error.stderr));
  const verified = await execute(process.execPath, [verifier, 'verify', packageRoot, '--expected-inventory-sha256', item.inventorySha256]);
  assert.equal(JSON.parse(verified.stdout).trustedInventoryVerified, true);
  const destination = path.join(f.root, 'alias-copy');
  const copied = await execute(process.execPath, [path.join(alias, 'tools/install.mjs'), packageRoot, destination, '--expected-inventory-sha256', item.inventorySha256]);
  assert.equal(JSON.parse(copied.stdout).state, 'copied'); await verifyPackage(destination, { expectedInventorySha256: item.inventorySha256 });
  await assert.rejects(execute(process.execPath, [path.join(alias, 'tools/ci.mjs'), 'unrecognized']), error => error.code === 1 && /CI_CANDIDATE_INVALID/.test(error.stderr));
});

test('verified explicit fresh copy retains complete source bytes for both clients without native registration', async t => {
  const f = await packageSource(t);
  for (const item of f.built.packages) {
    const input = options(f, item, `copied-${item.client}`), result = await installPackage({ ...input, client: item.client });
    assert.equal(result.state, 'copied'); assert.equal(result.destination, input.destination); assert.equal(result.client, item.client);
    assert.equal((await verifyPackage(result.destination, { expectedInventorySha256: item.inventorySha256 })).integrityVerified, true);
    assert.equal((await verifyPackage(input.sourceRoot, { expectedInventorySha256: item.inventorySha256 })).integrityVerified, true);
    assert.match(result.registration, /native client workflow/);
  }
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['candidate', 'copied-claude', 'copied-codex', 'source']);
});

test('existing targets, wrong client/checksum, overlap and missing parents cause no destination writes', async t => {
  const f = await packageSource(t), item = f.built.packages[0], input = options(f, item, 'fresh');
  await assert.rejects(installPackage({ ...input, expectedInventorySha256: undefined }), { code: 'INSTALL_TRUSTED_DIGEST_REQUIRED' });
  await assert.rejects(installPackage({ ...input, expectedInventorySha256: '0'.repeat(64) }), { code: 'PACKAGE_TRUSTED_DIGEST_MISMATCH' });
  await assert.rejects(installPackage({ ...input, client: 'claude' }), { code: 'INSTALL_CLIENT_MISMATCH' });
  await assert.rejects(fs.stat(input.destination), { code: 'ENOENT' });
  await fs.mkdir(input.destination); await fs.writeFile(path.join(input.destination, 'keep.txt'), 'Preserve existing.');
  await assert.rejects(installPackage(input), { code: 'INSTALL_DESTINATION_EXISTS' });
  assert.equal(await fs.readFile(path.join(input.destination, 'keep.txt'), 'utf8'), 'Preserve existing.');
  await assert.rejects(installPackage({ ...input, destination: path.join(input.sourceRoot, 'new-copy') }), { code: 'INSTALL_SOURCE_OVERLAP' });
  await assert.rejects(installPackage({ ...input, destination: path.join(f.root, 'missing', 'copy') }), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.root, 'missing')), { code: 'ENOENT' });
});

test('copy uses its trusted captured snapshot even if the source changes before destination creation', async t => {
  const f = await packageSource(t), item = f.built.packages[0], input = options(f, item, 'snapshot'), original = fs.mkdir;
  fs.mkdir = async (directory, ...rest) => {
    if (directory === input.destination) await fs.writeFile(path.join(input.sourceRoot, 'src/support.mjs'), 'A later source replacement.');
    return original(directory, ...rest);
  };
  try { await installPackage(input); } finally { fs.mkdir = original; }
  assert.equal(await fs.readFile(path.join(input.destination, 'src/support.mjs'), 'utf8'), 'export const label = "synthetic";\n');
  assert.equal((await verifyPackage(input.destination, { expectedInventorySha256: item.inventorySha256 })).integrityVerified, true);
  await assert.rejects(verifyPackage(input.sourceRoot), { code: 'PACKAGE_CONTENT_MISMATCH' });
});

test('an interrupted copy preserves its incomplete directory and refuses destructive retry', async t => {
  const f = await packageSource(t), item = f.built.packages[0], input = options(f, item, 'incomplete'), original = fs.open; let count = 0;
  fs.open = async (file, flags, ...rest) => {
    if (flags === 'wx' && file.startsWith(input.destination + path.sep) && ++count === 2) throw Object.assign(new Error('Synthetic copy interruption.'), { code: 'EIO' });
    return original(file, flags, ...rest);
  };
  try { await assert.rejects(installPackage(input), { code: 'INSTALL_COPY_INCOMPLETE' }); } finally { fs.open = original; }
  assert.ok((await fs.readdir(input.destination)).length > 0);
  await assert.rejects(installPackage(input), { code: 'INSTALL_DESTINATION_EXISTS' });
});

test('standalone companion archive verifies and copies with Node built-ins outside the source repository', async t => {
  const f = await packageSource(t), item = f.built.packages[1], archive = f.built.tools.find(file => file.path.endsWith('.zip')), extraction = path.join(f.root, 'companion'); await fs.mkdir(extraction);
  await execute('unzip', ['-q', path.join(f.output, archive.path), '-d', extraction]);
  const tools = path.join(extraction, 'cuefluent-notes-tools'), source = path.join(f.output, item.path), destination = path.join(f.root, 'standalone');
  const check = await execute(process.execPath, [path.join(tools, 'packaging.mjs'), 'verify', source, '--expected-inventory-sha256', item.inventorySha256], { cwd: extraction, env: { ...process.env, NODE_PATH: '' } });
  assert.equal(JSON.parse(check.stdout).trustedInventoryVerified, true);
  const copy = await execute(process.execPath, [path.join(tools, 'install.mjs'), source, destination, '--expected-inventory-sha256', item.inventorySha256, '--client', 'claude'], { cwd: extraction, env: { ...process.env, NODE_PATH: '' } });
  assert.equal(JSON.parse(copy.stdout).state, 'copied'); assert.equal((await verifyPackage(destination)).client, 'claude');
});


test('Windows explicit absolute copy accepts forward-slash spelling', { skip: process.platform !== 'win32' }, async t => {
  const f = await packageSource(t), item = f.built.packages[0], input = options(f, item, 'forward-slash');
  const result = await installPackage({ ...input, destination: input.destination.replaceAll('\\', '/') });
  assert.equal(result.destination, input.destination);
  assert.equal((await verifyPackage(result.destination, { expectedInventorySha256: item.inventorySha256 })).integrityVerified, true);
});
