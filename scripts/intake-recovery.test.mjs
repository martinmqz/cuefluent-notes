import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { linuxStartTicks, macBootIdentity, ownerIsGone, probeProcess } from './process-identity.mjs';
import { inspectIntakeRecovery, applyIntakeRecovery } from './intake-recovery.mjs';

const offline = { entrypointsSuspended: true, clientsClosed: true, workersStopped: true, soleRecoveryProcess: true };
const absent = async () => ({ state: 'absent', hostname: os.hostname(), boot: 'fixture-boot', processStart: null, platform: process.platform });
async function fixture(t) {
  const f = await storageFixture(t), lock = path.join(f.collection.intakeStateDir, '.intake-lock');
  const owner = { version: 1, pid: 12345, hostname: os.hostname(), createdAt: '2026-09-24T00:00:00.000Z', nonce: randomUUID(), processStart: '123', boot: 'fixture-boot' };
  await fs.mkdir(lock, { mode: 0o700 }); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  return { ...f, lock, owner };
}
test('process parsers preserve exact fingerprints and do not guess from clock values', () => {
  const fields = ['S', ...Array(18).fill('0'), '12345678901234567890'];
  assert.equal(linuxStartTicks(`123 (a process ) with parens) ${fields.join(' ')}`, 123), '12345678901234567890');
  assert.equal(macBootIdentity('{ sec = 100, usec = 123 } Wed Sep 24'), '100:123');
  assert.throws(() => macBootIdentity('{ sec = 100, usec = 1000000 }'));
  const owner = { hostname: 'fixture', boot: 'boot', processStart: 'old' };
  assert(ownerIsGone(owner, { hostname: 'fixture', state: 'absent', boot: 'boot' }));
  for (const current of [{ state: 'unknown' }, { hostname: 'other', state: 'absent' }, { state: 'present', processStart: 'old' },
    { state: 'present', processStart: 'new', platform: 'darwin' }, { state: 'present', processStart: 'new', platform: 'win32' }]) {
    assert.equal(ownerIsGone(owner, { hostname: 'fixture', boot: 'boot', ...current }), false);
  }
  assert.equal(ownerIsGone({ ...owner, processStart: null }, { hostname: 'fixture', boot: 'boot', state: 'present', processStart: 'new', platform: 'linux' }), false);
});
test('native self probe cannot authorize recovery of its live process', async t => {
  const value = await probeProcess(process.pid);
  assert.equal(ownerIsGone({ hostname: os.hostname(), boot: value.boot, processStart: value.processStart }, value), false);
  if (value.state === 'present') { assert(value.processStart); assert(value.boot); }
  else { assert.equal(value.state, 'unknown'); t.diagnostic('Native process probes unavailable in this environment; recovery remains blocked.'); }
});
test('offline recovery quarantines only the exact proven-dead intake lock', async t => {
  const f = await fixture(t);
  const source = path.join(f.collection.rawDir, 'preserve.json'); await fs.writeFile(source, '{}', { mode: 0o600 });
  const preview = await inspectIntakeRecovery(f.capability, { probe: absent });
  assert.equal(preview.status, 'dead-owner-offline-recovery-required');
  await assert.rejects(applyIntakeRecovery(f.capability, preview.plan, { offline: { ...offline, clientsClosed: false }, probe: absent }), { code: 'OFFLINE_EXCLUSIVITY_REQUIRED' });
  assert.equal((await applyIntakeRecovery(f.capability, preview.plan, { offline, probe: absent })).status, 'quarantined');
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.collection.intakeStateDir, 'recovered-locks', preview.plan.id, 'owner.json'))), f.owner);
  assert.equal(await fs.readFile(source, 'utf8'), '{}');
  await assert.rejects(fs.stat(path.join(f.collection.intakeStateDir, '.intake-maintenance')), { code: 'ENOENT' });
});
test('changed, live, unknown, and overlapping recovery owners are preserved', async t => {
  for (const variant of ['changed', 'live', 'unknown', 'maintenance']) {
    const f = await fixture(t), preview = await inspectIntakeRecovery(f.capability, { probe: absent });
    if (variant === 'changed') await fs.appendFile(path.join(f.lock, 'owner.json'), ' ');
    if (variant === 'maintenance') await fs.mkdir(path.join(f.collection.intakeStateDir, '.intake-maintenance'), { mode: 0o700 });
    const probe = variant === 'live' ? async () => ({ state: 'present', hostname: os.hostname(), boot: f.owner.boot, processStart: f.owner.processStart, platform: process.platform })
      : variant === 'unknown' ? async () => ({ state: 'unknown', hostname: os.hostname(), boot: null, processStart: null }) : absent;
    await assert.rejects(applyIntakeRecovery(f.capability, preview.plan, { offline, probe }));
    assert((await fs.stat(f.lock)).isDirectory());
  }
});
