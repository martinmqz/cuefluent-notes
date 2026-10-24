import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { queryWindowsAcl, withWindowsAclDeadline } from '../src/storage/windows-acl.mjs';

test('ACL deadlines expire before helper creation and nested scopes cannot extend them', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const registry = Symbol.for('cuefluent.notes.windows-acl');
  assert.equal(globalThis[registry], undefined);
  await withWindowsAclDeadline(async () => {
    await delay(15);
    assert.throws(() => queryWindowsAcl('C:\\synthetic\\absent', false), { code: 'WINDOWS_ACL_TIMEOUT' });
    assert.throws(() => withWindowsAclDeadline(() => queryWindowsAcl('C:\\synthetic\\absent', true), { timeoutMs: 5000 }), { code: 'WINDOWS_ACL_TIMEOUT' });
  }, { timeoutMs: 5 });
  assert.equal(globalThis[registry], undefined);
});
