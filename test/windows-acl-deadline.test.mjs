import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import nativeWorkerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { queryWindowsAcl, withWindowsAclDeadline } from '../src/storage/windows-acl.mjs';

test('ACL deadlines expire before helper creation and nested scopes cannot extend them', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const startup = new Error('synthetic helper startup');
  const workers = t.mock.method(nativeWorkerThreads, 'Worker', function () { throw startup; });
  syncBuiltinESMExports();
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    workers.mock.restore(); syncBuiltinESMExports();
  });
  await withWindowsAclDeadline(async () => {
    await delay(15);
    assert.throws(() => queryWindowsAcl('C:\\synthetic\\absent', false), { code: 'WINDOWS_ACL_TIMEOUT' });
    assert.throws(() => withWindowsAclDeadline(() => queryWindowsAcl('C:\\synthetic\\absent', true), { timeoutMs: 5000 }), { code: 'WINDOWS_ACL_TIMEOUT' });
  }, { timeoutMs: 5 });
  assert.equal(workers.mock.callCount(), 0);
  // Outside the expired scope, the same request must reach the constructor spy.
  assert.throws(() => queryWindowsAcl('C:\\synthetic\\absent', false), error => error === startup);
  assert.equal(workers.mock.callCount(), 1);
});
