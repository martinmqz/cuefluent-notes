import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { assertPrivateAccess } from '../src/storage/platform.mjs';
import { assertMacosPrivateAccess } from '../src/storage/macos-acl.mjs';
import { createPrivateDirectory, pinDirectory } from '../src/storage/paths.mjs';
import { readSnapshot, writeAtomic } from '../src/storage/files.mjs';

const macTest = process.platform === 'darwin' ? test : test.skip;
const chmodAcl = (file, entry) => execFileSync('/bin/chmod', ['+a', entry, file], { stdio: ['ignore', 'pipe', 'pipe'] });
const acl = file => execFileSync('/bin/ls', ['-lnde', file], { encoding: 'utf8' }).split('\n').slice(1).join('\n');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-macos-acl-')));
  await fs.chmod(root, 0o755); // A traversable parent cannot hide an exposed leaf.
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

macTest('macOS private checks reject fresh explicit file and directory ACL grants without changing them', async t => {
  const root = await fixture(t);
  const file = path.join(root, "private λ [literal] '$;.tmp");
  await fs.writeFile(file, 'synthetic conversation', { mode: 0o600 });
  const before = await fs.lstat(file, { bigint: true });
  assertPrivateAccess(file, before);
  chmodAcl(file, 'everyone allow read');
  const fileAcl = acl(file);
  assert.equal((await fs.lstat(file)).mode & 0o777, 0o600);
  // Reusing the original stat must not cache the earlier permission decision.
  assert.throws(() => assertPrivateAccess(file, before), { code: 'PRIVATE_ACCESS_UNSAFE' });
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic conversation');
  assert.equal(acl(file), fileAcl);

  const directory = path.join(root, 'private'); await fs.mkdir(directory, { mode: 0o700 });
  chmodAcl(directory, 'everyone allow list,search');
  const directoryAcl = acl(directory);
  await assert.rejects(pinDirectory(directory, { private: true }), { code: 'PRIVATE_ACCESS_UNSAFE' });
  assert.equal((await fs.lstat(directory)).mode & 0o777, 0o700);
  assert.equal(acl(directory), directoryAcl);
});

macTest('macOS private directory creation rejects inherited and inheritance-only grants before storing content', async t => {
  const root = await fixture(t);
  for (const [index, entry] of [
    'everyone allow list,search,read,file_inherit,directory_inherit',
    'everyone allow read,file_inherit,directory_inherit,only_inherit',
  ].entries()) {
    const parent = path.join(root, `shared-${index}`); await fs.mkdir(parent, { mode: 0o755 });
    chmodAcl(parent, entry); const parentAcl = acl(parent);
    const destination = path.join(parent, 'private');
    await assert.rejects(createPrivateDirectory(destination), { code: 'PRIVATE_ACCESS_UNSAFE' });
    assert.equal((await fs.lstat(destination)).mode & 0o777, 0o700);
    assert.match(acl(destination), /inherited/);
    assert.deepEqual(await fs.readdir(destination), []);
    assert.equal(acl(parent), parentAcl);
  }
});

macTest('macOS private reads and atomic writes refuse ACL-exposed paths and preserve bytes', async t => {
  const root = await fixture(t), directory = path.join(root, 'private');
  const pin = await createPrivateDirectory(directory);
  await writeAtomic(pin, 'queue.jsonl', Buffer.from('synthetic queue'), { expectedHash: null });
  const original = await readSnapshot(pin, 'queue.jsonl');
  const file = path.join(directory, 'queue.jsonl'); chmodAcl(file, 'everyone allow read');
  await assert.rejects(readSnapshot(pin, 'queue.jsonl'), { code: 'PRIVATE_ACCESS_UNSAFE' });
  await assert.rejects(writeAtomic(pin, 'queue.jsonl', Buffer.from('replacement'), { expectedHash: original.hash }), { code: 'PRIVATE_ACCESS_UNSAFE' });
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic queue');
  // An ACL affecting only future files still makes their private parent unsafe.
  chmodAcl(directory, 'everyone allow read,file_inherit,only_inherit');
  await assert.rejects(writeAtomic(pin, 'draft.tmp', Buffer.from('synthetic draft'), { expectedHash: null }), { code: 'PRIVATE_ACCESS_UNSAFE' });
  assert.deepEqual(await fs.readdir(directory), ['queue.jsonl']);
});

macTest('macOS private ACL verification accepts owner-only grants and deny entries', async t => {
  const root = await fixture(t), file = path.join(root, 'private');
  await fs.writeFile(file, '', { mode: 0o600 });
  chmodAcl(file, `user:${os.userInfo().username} allow read,write`);
  chmodAcl(file, 'everyone deny execute');
  const before = acl(file);
  assertPrivateAccess(file, await fs.lstat(file, { bigint: true }));
  assert.equal(acl(file), before);
});

macTest('macOS native ACL lookup refuses missing, replaced and symbolic-link paths', async t => {
  const root = await fixture(t), file = path.join(root, 'private');
  await fs.writeFile(file, '', { mode: 0o600 });
  const before = await fs.lstat(file, { bigint: true });
  await fs.rename(file, `${file}.previous`);
  assert.throws(() => assertPrivateAccess(file, before), { code: 'PRIVATE_ACCESS_UNVERIFIED' });
  await fs.writeFile(file, '', { mode: 0o600 });
  assert.throws(() => assertPrivateAccess(file, before), { code: 'PRIVATE_ACCESS_UNVERIFIED' });
  const link = path.join(root, 'link'); await fs.symlink(file, link);
  assert.throws(() => assertMacosPrivateAccess(link, before));
});

macTest('macOS refuses private access when native FFI verification is disabled', async t => {
  const root = await fixture(t), file = path.join(root, 'private');
  await fs.writeFile(file, '', { mode: 0o600 });
  const program = `
    import fs from 'node:fs';
    const {assertPrivateAccess} = await import(process.argv[1]);
    try { assertPrivateAccess(process.argv[2], fs.lstatSync(process.argv[2], {bigint:true})); process.exitCode=1; }
    catch (error) { if(error.code!=='PRIVATE_ACCESS_UNVERIFIED') throw error; console.log(error.code); }
  `;
  const result = execFileSync(process.execPath, ['--no-experimental-ffi', '--input-type=module', '-e', program,
    new URL('../src/storage/platform.mjs', import.meta.url).href, file], { encoding: 'utf8' });
  assert.equal(result.trim(), 'PRIVATE_ACCESS_UNVERIFIED');
});
