import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMacosVolumeUuid, readMacosVolumeUuidFromFd } from '../src/storage/macos-volume.mjs';
import { macosNative } from '../src/storage/macos-native.mjs';

const macTest = process.platform === 'darwin' ? test : test.skip;
const stat = file => lstatSync(file, { bigint: true });
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cuefluent-volume-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "synthetic λ '$;.sqlite");
  writeFileSync(file, 'synthetic', { mode: 0o600 });
  return { root, file };
}

macTest('native volume lookup agrees for files and directories without depending on path spelling', t => {
  const { root, file } = fixture(t), identity = stat(file);
  const volume = readMacosVolumeUuid(file, identity);
  assert.match(volume, /^[a-f0-9]{32}$/); assert.notEqual(volume, '0'.repeat(32));
  assert.equal(readMacosVolumeUuid(root, stat(root)), volume);
  const renamed = join(root, 'renamed.sqlite'); renameSync(file, renamed);
  assert.equal(readMacosVolumeUuid(renamed, identity), volume);
});

macTest('native volume lookup rejects missing, replaced, linked and mismatched observations', t => {
  const { root, file } = fixture(t), identity = stat(file);
  assert.throws(() => readMacosVolumeUuid(file, { ...identity, dev: identity.dev + 1n }), { code: 'PATH_CHANGED' });
  renameSync(file, join(root, 'retained.sqlite'));
  assert.throws(() => readMacosVolumeUuid(file, identity), { code: 'ENOENT' });
  writeFileSync(file, 'replacement', { mode: 0o600 });
  assert.throws(() => readMacosVolumeUuid(file, identity), { code: 'PATH_CHANGED' });
  const linked = join(root, 'linked'); symlinkSync(file, linked);
  // The symlink's own inode matches, so only the explicit symlink guard refuses it.
  assert.throws(() => readMacosVolumeUuid(linked, stat(linked)), { code: 'PATH_CHANGED' });
});

macTest('unavailable native volume lookup refuses instead of reverting to the mount device number', t => {
  const { file } = fixture(t);
  const script = `import assert from 'node:assert/strict'; import {lstatSync} from 'node:fs';
    const {readMacosVolumeUuid} = await import(process.argv[1]);
    assert.throws(() => readMacosVolumeUuid(process.argv[2], lstatSync(process.argv[2], {bigint:true})), {code:'FILESYSTEM_IDENTITY_UNVERIFIED'});`;
  execFileSync(process.execPath, ['--no-experimental-ffi', '--input-type=module', '-e', script,
    new URL('../src/storage/macos-volume.mjs', import.meta.url).href, file], { stdio: 'pipe', timeout: 10_000 });
});

macTest('native volume lookup binds the UUID to the device in the same observation', t => {
  const { file } = fixture(t), identity = stat(file), api = macosNative(), original = api.getattrlist;
  t.mock.method(api, 'getattrlist', (...args) => {
    const result = original(...args);
    if (args[1].readUInt32LE(8)) args[2].writeUInt32LE(Number(identity.dev + 1n), 24);
    return result;
  });
  assert.throws(() => readMacosVolumeUuid(file, identity), { code: 'PATH_CHANGED' });
});

macTest('native volume failures and post-lookup removal retain their distinct causes', t => {
  const { file } = fixture(t), identity = stat(file), api = macosNative(), original = api.getattrlist;
  const call = t.mock.method(api, 'getattrlist', (...args) => {
    const result = original(...args);
    args[2].fill(0, 28);
    return result;
  });
  assert.throws(() => readMacosVolumeUuid(file, identity), error =>
    error.code === 'FILESYSTEM_IDENTITY_UNVERIFIED' && error.cause === undefined);
  call.mock.mockImplementation(() => -1);
  t.mock.method(api, 'errno', () => 5); // EIO: an unreadable UUID, not a vanished path.
  assert.throws(() => readMacosVolumeUuid(file, identity), error =>
    error.code === 'FILESYSTEM_IDENTITY_UNVERIFIED' && error.cause.code === 'EIO' && error.cause.cause === undefined);
  call.mock.mockImplementation((...args) => {
    const result = original(...args);
    unlinkSync(file);
    return result;
  });
  assert.throws(() => readMacosVolumeUuid(file, identity), { code: 'ENOENT' });
});

macTest('descriptor volume lookup stays bound to the open file after path replacement', t => {
  const { file } = fixture(t), fd = openSync(file, 'r');
  t.after(() => closeSync(fd));
  const identity = fstatSync(fd, { bigint: true }), volume = readMacosVolumeUuidFromFd(fd, identity);
  assert.equal(volume, readMacosVolumeUuid(file, identity));
  assert.throws(() => readMacosVolumeUuidFromFd(fd, { ...identity, dev: identity.dev + 1n }), { code: 'PATH_CHANGED' });
  renameSync(file, `${file}.retained`); writeFileSync(file, 'replacement', { mode: 0o600 });
  assert.equal(readMacosVolumeUuidFromFd(fd, identity), volume);
  assert.throws(() => readMacosVolumeUuidFromFd(fd, stat(file)), { code: 'PATH_CHANGED' });
  unlinkSync(`${file}.retained`);
  assert.equal(readMacosVolumeUuidFromFd(fd, identity), volume);
});

macTest('ACL and volume lookups share one libSystem binding', t => {
  const { file } = fixture(t);
  const script = `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import {lstatSync} from 'node:fs';
    const ffi = createRequire(import.meta.url)('node:ffi'), original = ffi.dlopen;
    let loads = 0; ffi.dlopen = (...args) => { loads++; return original(...args); };
    const {assertMacosPrivateAccess} = await import(process.argv[1]);
    const {readMacosVolumeUuid} = await import(process.argv[2]);
    const file = process.argv[3], stat = lstatSync(file, {bigint:true});
    assertMacosPrivateAccess(file, stat);
    const volume = readMacosVolumeUuid(file, stat);
    assert.equal(readMacosVolumeUuid(file, stat), volume);
    assertMacosPrivateAccess(file, stat);
    assert.equal(loads, 1);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script,
    new URL('../src/storage/macos-acl.mjs', import.meta.url).href,
    new URL('../src/storage/macos-volume.mjs', import.meta.url).href, file], { stdio: 'pipe', timeout: 10_000 });
});

macTest('volume lookup binds system and data volume ancestors despite projected device numbers', t => {
  for (const file of ['/', '/System', '/System/Volumes', '/System/Volumes/Data', '/private', '/private/tmp']) {
    const identity = stat(file), volume = readMacosVolumeUuid(file, identity), fd = openSync(file, 'r');
    try {
      assert.match(volume, /^[a-f0-9]{32}$/);
      assert.equal(readMacosVolumeUuidFromFd(fd, fstatSync(fd, { bigint: true })), volume);
      assert.throws(() => readMacosVolumeUuid(file, { ...identity, ino: identity.ino + 1n }), { code: 'PATH_CHANGED' });
    } finally { closeSync(fd); }
  }
});

macTest('volume-group projection preserves signed high-bit inode observations', t => {
  const { file } = fixture(t), observed = stat(file), api = macosNative(), native = api.getattrlist;
  const expected = readMacosVolumeUuid(file, observed), inode = -(1n << 63n) + 23n;
  const signed = Object.assign(Object.create(Object.getPrototypeOf(observed)), observed, { ino: inode });
  const originalStat = nativeFs.lstatSync;
  t.mock.method(nativeFs, 'lstatSync', (target, options) => target === file ? signed : originalStat(target, options));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(api, 'getattrlist', (target, attributes, output, ...rest) => {
    const result = native(target, attributes, output, ...rest);
    if (attributes.readUInt32LE(8)) output.writeUInt32LE(Number(observed.dev + 1n), 24);
    else {
      output.writeBigUInt64LE(BigInt.asUintN(64, inode), 8);
      output.writeUInt32LE(Number(observed.dev + 1n), 16);
    }
    return result;
  });
  assert.equal(readMacosVolumeUuid(file, signed), expected);
});


macTest('an explicit unsupported UUID capability preserves required and identity guards for paths and descriptors', t => {
  const { file } = fixture(t), identity = stat(file), fd = openSync(file, 'r');
  t.after(() => closeSync(fd));
  // devfs rejects this request with EINVAL on some macOS releases. Model only
  // the explicit absent capability bit; keep the native device and file checks.
  const api = macosNative();
  for (const name of ['getattrlist', 'fgetattrlist']) {
    const native = api[name];
    t.mock.method(api, name, (...args) => {
      const result = native(...args);
      if (result === 0 && args[1].readUInt32LE(8)) {
        args[2].writeUInt32LE(0, 8); // ATTR_VOL_UUID was not returned.
        args[2].fill(0, 28); // PACK_INVAL_ATTRS reserves the absent UUID bytes.
      }
      return result;
    });
  }
  assert.equal(readMacosVolumeUuid(file, identity, { required: false }), null);
  assert.equal(readMacosVolumeUuidFromFd(fd, fstatSync(fd, { bigint: true }), { required: false }), null);
  assert.throws(() => readMacosVolumeUuid(file, identity), { code: 'FILESYSTEM_IDENTITY_UNVERIFIED' });
  assert.throws(() => readMacosVolumeUuidFromFd(fd, identity), { code: 'FILESYSTEM_IDENTITY_UNVERIFIED' });
  assert.throws(() => readMacosVolumeUuid(file, { ...identity, ino: identity.ino + 1n }, { required: false }), { code: 'PATH_CHANGED' });
  assert.throws(() => readMacosVolumeUuidFromFd(fd, { ...identity, ino: identity.ino + 1n }, { required: false }), { code: 'PATH_CHANGED' });
});

macTest('optional UUID lookup never treats missing paths, native errors or malformed returned data as unsupported', t => {
  const { file } = fixture(t), identity = stat(file), api = macosNative(), original = api.getattrlist;
  const call = t.mock.method(api, 'getattrlist', (...args) => original(...args));
  const errno = t.mock.method(api, 'errno', () => 5);
  for (const [number, code] of [[5, 'EIO'], [13, 'EACCES'], [22, 'EINVAL'], [45, 'ENOTSUP']]) {
    call.mock.mockImplementation(() => -1); errno.mock.mockImplementation(() => number);
    assert.throws(() => readMacosVolumeUuid(file, identity, { required: false }), error =>
      error.code === 'FILESYSTEM_IDENTITY_UNVERIFIED' && error.cause.code === code);
  }
  for (const alter of [
    output => output.fill(0, 28), // UUID reported present but null.
    output => output.writeUInt32LE(0, 4), // Required returned DEVID absent.
    output => output.writeUInt32LE(40, 0), // Truncated native payload.
    output => output.writeUInt32LE(1, 12), // Unrequested directory attributes.
  ]) {
    call.mock.mockImplementation((...args) => { const result = original(...args); alter(args[2]); return result; });
    assert.throws(() => readMacosVolumeUuid(file, identity, { required: false }), { code: 'FILESYSTEM_IDENTITY_UNVERIFIED' });
  }
  call.mock.mockImplementation((...args) => original(...args));
  errno.mock.restore();
  unlinkSync(file);
  assert.throws(() => readMacosVolumeUuid(file, identity, { required: false }), { code: 'ENOENT' });
});


macTest('optional descriptor UUID lookup keeps native failure and returned-data guards', t => {
  const { file } = fixture(t), fd = openSync(file, 'r'); t.after(() => closeSync(fd));
  const identity = fstatSync(fd, { bigint: true }), api = macosNative(), original = api.fgetattrlist;
  const call = t.mock.method(api, 'fgetattrlist', (...args) => original(...args));
  const errno = t.mock.method(api, 'errno', () => 5);
  call.mock.mockImplementation(() => -1);
  assert.throws(() => readMacosVolumeUuidFromFd(fd, identity, { required: false }), error =>
    error.code === 'FILESYSTEM_IDENTITY_UNVERIFIED' && error.cause.code === 'EIO');
  errno.mock.restore();
  for (const alter of [output => output.fill(0, 28), output => output.writeUInt32LE(0, 4)]) {
    call.mock.mockImplementation((...args) => { const result = original(...args); alter(args[2]); return result; });
    assert.throws(() => readMacosVolumeUuidFromFd(fd, identity, { required: false }), { code: 'FILESYSTEM_IDENTITY_UNVERIFIED' });
  }
});
