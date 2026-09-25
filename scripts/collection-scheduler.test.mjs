import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { openWorkflowIntake, inspectIntakeStore } from './intake-io.mjs';
import { registrationPath, registrationShard } from './collection-ingress.mjs';
import { collectionJobs, readCollectionScheduler, reserveCollectionAttempt } from './collection-scheduler.mjs';
import { withWorkflowBudget } from './workflow-budget.mjs';
import { runCollectionWorker } from './test-support/capture-workflow.mjs';

async function fixture(t) { const f = await storageFixture(t); return { ...f, store: await inspectIntakeStore(f.collection) }; }
async function register(f, sessionId, body = '{}') {
  const file = path.join(f.collection.intakeStateDir, registrationPath({ client: 'codex', sessionId }));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, body, { mode: 0o600 });
}
async function scan(f, cursor = null) {
  const pending = [], jobs = [];
  for await (const job of collectionJobs(f.store, cursor, pending)) jobs.push(job);
  return { jobs, pending };
}

test('sharded registry retains more than 2048 registrations independent of directory order', async t => {
  const f = await fixture(t), ids = Array.from({ length: 2055 }, () => randomUUID());
  for (const id of ids) await register(f, id);
  const first = await scan(f); assert.equal(first.jobs.length, ids.length); assert.deepEqual(first.pending, []);
  const open = fs.opendir;
  fs.opendir = async (...args) => {
    const rows = []; for await (const entry of await open(...args)) rows.push(entry);
    return { async *[Symbol.asyncIterator]() { yield* rows.reverse(); } };
  };
  try {
    assert.deepEqual((await scan(f)).jobs, first.jobs);
    const middle = first.jobs[1027]; const resumed = (await scan(f, middle.cursor)).jobs;
    assert.deepEqual(resumed.map(j => j.sessionId), [...first.jobs.slice(1028), ...first.jobs.slice(0, 1028)].map(j => j.sessionId));
    const inserted = randomUUID(); await register(f, inserted);
    assert((await scan(f, middle.cursor)).jobs.some(j => j.sessionId === inserted));
  } finally { fs.opendir = open; }
});

test('one-attempt passes do not pin malformed registrations or reserve an unprocessed page', async t => {
  const f = await fixture(t), ids = Array.from({ length: 7 }, () => randomUUID());
  for (const id of ids) await register(f, id, '{ malformed');
  const expected = (await scan(f)).jobs.map(j => j.file), actual = [];
  for (let index = 0; index < ids.length; index++) {
    const result = await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id, maxJobs: 1 });
    actual.push(result.lastRegistration); assert(result.pending.includes('INVALID_INTAKE_METADATA'));
  }
  assert.deepEqual(actual, expected);
});

test('a hot trigger alternates the first slot with background work under one-job budgets', async t => {
  const f = await fixture(t), ids = Array.from({ length: 4 }, () => randomUUID());
  for (const id of ids) await register(f, id, '{ malformed');
  const expected = (await scan(f)).jobs.map(j => j.file), trigger = { client: 'codex', sessionId: ids.at(-1) };
  const actual = [];
  for (let index = 0; index < ids.length * 2; index++) {
    actual.push((await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id, maxJobs: 1, trigger })).lastRegistration);
  }
  assert.deepEqual(actual.filter((_, index) => index % 2 === 0), Array(4).fill(registrationPath(trigger)));
  assert.deepEqual(actual.filter((_, index) => index % 2 === 1), expected);
});

test('a stale scheduler reservation fails rather than advancing a newer worker cursor', async t => {
  const f = await fixture(t), store = await openWorkflowIntake(f.capability), before = await readCollectionScheduler(store);
  const id = randomUUID(), value = { version: 1, triggerFirst: false, cursor: { client: 'codex', shard: registrationShard(id), sessionId: id } };
  await reserveCollectionAttempt(f.capability, store, before, value);
  await assert.rejects(reserveCollectionAttempt(f.capability, store, before, { ...value, triggerFirst: true }), /COLLECTION_SCHEDULER_CHANGED/);
  assert.deepEqual((await readCollectionScheduler(store)).value, value);
});

test('an unfinished shard scan never advances the persisted cursor', async t => {
  const f = await fixture(t); for (let index = 0; index < 5; index++) await register(f, randomUUID());
  const store = await openWorkflowIntake(f.capability), before = await readCollectionScheduler(store);
  let now = 0;
  await assert.rejects(withWorkflowBudget({ milliseconds: 5, now: () => ++now }, async () => {
    for await (const _ of collectionJobs(f.store, null, [])) assert.fail('partial scan must not emit a job');
  }), /WORKER_TIME_BUDGET/);
  assert.deepEqual(await readCollectionScheduler(store), before);
});

test('overfull and misplaced shards cannot block an exact hint or unrelated shards', async t => {
  const f = await fixture(t), target = randomUUID(), shard = registrationShard(target), root = path.join(f.collection.intakeStateDir, 'ingress/registrations/codex', shard);
  await register(f, target, '{ malformed');
  // Every dirent counts, including invalid ones. There is no unbounded invalid-entry scan.
  for (let index = 0; index < 2048; index++) await fs.mkdir(path.join(root, `invalid-${index}`));
  let healthy = randomUUID(); while (registrationShard(healthy) === shard) healthy = randomUUID();
  await register(f, healthy, '{ malformed');
  const result = await scan(f);
  assert(result.jobs.some(j => j.diagnostic === 'REGISTRATION_SHARD_CAPACITY'));
  assert(result.jobs.some(j => j.sessionId === healthy));
  const hinted = await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id, trigger: { client: 'codex', sessionId: target }, maxJobs: 1 });
  assert.equal(hinted.lastRegistration, registrationPath({ client: 'codex', sessionId: target }));
  assert(hinted.pending.includes('INVALID_INTAKE_METADATA'));
});

test('wrong-shard identities and linked registrations stay excluded; invalid cursor state is retained', async t => {
  const f = await fixture(t), proper = randomUUID(), wrong = randomUUID(); await register(f, proper);
  const shard = registrationShard(proper); let misplaced = wrong;
  while (registrationShard(misplaced) === shard) misplaced = randomUUID();
  const root = path.dirname(path.dirname(path.join(f.collection.intakeStateDir, registrationPath({ client: 'codex', sessionId: proper }))));
  await fs.mkdir(path.join(root, misplaced));
  const linkId = randomUUID(), link = path.dirname(path.join(f.collection.intakeStateDir, registrationPath({ client: 'codex', sessionId: linkId })));
  await fs.mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
  await fs.symlink(f.project, link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await scan(f); assert(result.pending.includes('INVALID_REGISTRATION'));
  assert.deepEqual(result.jobs.filter(j => !j.maintenance).map(j => j.sessionId), [proper]);
  const scheduler = path.join(f.collection.intakeStateDir, 'ingress/scheduler/record.json');
  await fs.writeFile(scheduler, '{"version":2}', { mode: 0o600 });
  const failed = await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id });
  assert(failed.pending.length > 0); assert.equal(await fs.readFile(scheduler, 'utf8'), '{"version":2}');
});

test('an unreadable shard reserves a diagnostic attempt without starving other shards or hints', async t => {
  const f = await fixture(t), broken = randomUUID(); let healthy = randomUUID();
  while (registrationShard(healthy) === registrationShard(broken)) healthy = randomUUID();
  await register(f, broken, '{ malformed'); await register(f, healthy, '{ malformed');
  const root = path.dirname(path.dirname(path.join(f.collection.intakeStateDir, registrationPath({ client: 'codex', sessionId: broken }))));
  const open = fs.opendir, results = [], cursors = [];
  fs.opendir = async (file, ...args) => {
    if (file === root) throw Object.assign(new Error('Synthetic directory access failure'), { code: 'EACCES' });
    return open(file, ...args);
  };
  try {
    for (let i = 0; i < 8; i++) {
      results.push(await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id, maxJobs: 1, trigger: { client: 'codex', sessionId: healthy } }));
      cursors.push((await readCollectionScheduler(f.store)).value.cursor);
    }
  } finally { fs.opendir = open; }
  assert(results.some(result => result.pending.includes('REGISTRATION_SHARD_UNAVAILABLE')));
  assert(cursors.some(cursor => cursor?.shard === registrationShard(broken) && cursor.sessionId === null));
  assert(cursors.some(cursor => cursor?.sessionId === healthy), 'background advances through the healthy shard');
  assert(results.filter((_, i) => i % 2 === 0).every(result => result.lastRegistration === registrationPath({ client: 'codex', sessionId: healthy })));
});

test('a batch ending exactly at the limit including a duplicate hint has no false backlog', async t => {
  const f = await fixture(t), sessionId = randomUUID(); await register(f, sessionId, '{ malformed');
  const result = await runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id, maxJobs: 2, trigger: { client: 'codex', sessionId } });
  assert.deepEqual(result.pending, ['INVALID_INTAKE_METADATA']);
});
