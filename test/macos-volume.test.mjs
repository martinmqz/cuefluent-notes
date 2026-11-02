import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMacosVolumeUuid } from '../src/storage/macos-volume.mjs';

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
  assert.throws(() => readMacosVolumeUuid(file, { ...identity, dev: identity.dev + 1n }), { code: 'GATE_IDENTITY_UNVERIFIED' });
  renameSync(file, join(root, 'retained.sqlite'));
  assert.throws(() => readMacosVolumeUuid(file, identity), { code: 'GATE_IDENTITY_UNVERIFIED' });
  writeFileSync(file, 'replacement', { mode: 0o600 });
  assert.throws(() => readMacosVolumeUuid(file, identity), { code: 'GATE_IDENTITY_UNVERIFIED' });
  const linked = join(root, 'linked'); symlinkSync(file, linked);
  assert.throws(() => readMacosVolumeUuid(linked, stat(file)), { code: 'GATE_IDENTITY_UNVERIFIED' });
});

macTest('unavailable native volume lookup refuses instead of reverting to the mount device number', t => {
  const { file } = fixture(t);
  const script = `import assert from 'node:assert/strict'; import {lstatSync} from 'node:fs';
    const {readMacosVolumeUuid} = await import(process.argv[1]);
    assert.throws(() => readMacosVolumeUuid(process.argv[2], lstatSync(process.argv[2], {bigint:true})), {code:'GATE_IDENTITY_UNVERIFIED'});`;
  execFileSync(process.execPath, ['--no-experimental-ffi', '--input-type=module', '-e', script,
    new URL('../src/storage/macos-volume.mjs', import.meta.url).href, file], { stdio: 'pipe', timeout: 10_000 });
});
