import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProject } from '../src/core/settings.mjs';
import { initializeStore } from '../src/storage/store.mjs';
import { claimInvocation, runClaimedInvocation, readInvocation, launchInvocationChild } from '../src/control/invocations.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-invocation-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), notes = path.join(root, 'notes'); await fs.mkdir(cwd); await fs.mkdir(notes);
  const project = createProject({ id: 'project', root: cwd, destination: { kind: 'directory', path: notes } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const binding = { client: 'claude', sessionId: 'chat', promptId: 'prompt', action: 'track', cwd, sourcePath: null, commandNonce: '10000000-0000-4000-8000-000000000000', clientContract: null };
  return { root, cwd, store, binding };
}
test('current invocation retries share one opaque handle and execute only once', async t => {
  const f = await fixture(t); let executions = 0;
  const first = await claimInvocation(f.store, f.binding), retry = await claimInvocation(f.store, { ...f.binding, commandNonce: '20000000-0000-4000-8000-000000000000' });
  assert.equal(first.ticket, retry.ticket); assert.equal(retry.binding.commandNonce, f.binding.commandNonce);
  assert.equal((await readInvocation(f.store, first.ticket)).state, 'interrupted');
  const execute = async binding => { executions++; assert.deepEqual(binding, f.binding); return { state: 'tracked' }; };
  assert.equal((await runClaimedInvocation(f.store, first.ticket, { execute })).state, 'tracked');
  assert.equal((await runClaimedInvocation(f.store, first.ticket, { execute })).state, 'tracked'); assert.equal(executions, 1);
  assert.equal((await readInvocation(f.store, `${first.ticket.slice(0, -2)}aa`)).state, 'expired');
  await assert.rejects(claimInvocation(f.store, { ...f.binding, action: 'untrack' }), { code: 'INVOCATION_CHANGED' });
  const next = await claimInvocation(f.store, { ...f.binding, promptId: 'second', action: 'untrack' });
  assert.notEqual(next.ticket, first.ticket); assert.equal((await readInvocation(f.store, first.ticket)).state, 'expired');
  assert.equal((await fs.readdir(path.join(f.store.root, 'store/invocations'))).filter(file => file.endsWith('.json')).length, 1);
});
test('a concurrent command cannot replace an executing claim or acquire its gate', async t => {
  const f = await fixture(t), first = await claimInvocation(f.store, f.binding);
  let release, entered;
  const entering = new Promise(resolve => { entered = resolve; });
  const block = new Promise(resolve => { release = resolve; });
  const work = runClaimedInvocation(f.store, first.ticket, { execute: async () => { entered(); await block; return { state: 'tracked' }; } });
  await entering;
  const next = await claimInvocation(f.store, { ...f.binding, promptId: 'second', action: 'untrack' }); assert.equal(next.ticket, null); assert.equal(next.result.state, 'busy'); assert.equal(next.result.handle, undefined);
  const retry = await runClaimedInvocation(f.store, first.ticket, { execute: () => assert.fail('Competing execution') }); assert.equal(retry.state, 'running');
  release(); await work;
  const repeated = await claimInvocation(f.store, { ...f.binding, promptId: 'second', action: 'untrack' });
  assert.equal(repeated.ticket, null); assert.equal(repeated.result.state, 'not-executed');
  const explicit = await claimInvocation(f.store, { ...f.binding, promptId: 'third', action: 'untrack' }); assert.ok(explicit.ticket);
});

test('a fresh prompt replaces an ownerless pending claim and invalidates late startup', async t => {
  const f = await fixture(t), first = await claimInvocation(f.store, f.binding);
  const next = await claimInvocation(f.store, { ...f.binding, promptId: 'second', action: 'untrack' });
  assert.ok(next.ticket); assert.notEqual(next.ticket, first.ticket);
  assert.equal((await readInvocation(f.store, first.ticket)).state, 'expired');
  assert.equal((await runClaimedInvocation(f.store, first.ticket, { execute: () => assert.fail('Cancelled startup executed') })).state, 'expired');
  assert.equal((await claimInvocation(f.store, { ...f.binding, promptId: 'second', action: 'untrack' })).ticket, next.ticket);
  assert.equal((await runClaimedInvocation(f.store, next.ticket, { execute: async () => ({ state: 'untracked' }) })).state, 'untracked');
});

test('polling returns a running status snapshot without mistaking it for a launch receipt', async t => {
  const f = await fixture(t), claim = await claimInvocation(f.store, f.binding);
  const snapshot = { state: 'running', run: { id: 'synthetic-run' }, counts: { queued: 1 }, latest: null };
  await runClaimedInvocation(f.store, claim.ticket, { execute: async () => snapshot });
  assert.deepEqual(await readInvocation(f.store, claim.ticket), { ...snapshot, handle: claim.ticket });
});

function worker(f, ticket, mode = 'normal') {
  return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/invocation-worker.mjs', import.meta.url)), f.store.root, ticket, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}
test('a command worker confirms activation and a repeated delivery never executes twice', async t => {
  const f = await fixture(t), first = await claimInvocation(f.store, f.binding);
  const child = worker(f, first.ticket), exited = new Promise(resolve => child.once('exit', resolve));
  assert.deepEqual(await launchInvocationChild(child, { handle: first.ticket }), { started: true }); await exited;
  const duplicate = worker(f, first.ticket), done = new Promise(resolve => duplicate.once('exit', resolve));
  assert.equal((await launchInvocationChild(duplicate, { handle: first.ticket })).started, false); await done;
  assert.equal(await fs.readFile(path.join(f.store.root, 'executions'), 'utf8'), 'one\n');
});

test('parent loss before activation cannot execute and polling reports startup interruption', async t => {
  const f = await fixture(t), first = await claimInvocation(f.store, f.binding), child = worker(f, first.ticket);
  const exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => child.on('message', value => { if (value.type === 'cuefluent-command:ready') resolve(); }));
  child.disconnect(); await exited;
  await assert.rejects(fs.stat(path.join(f.store.root, 'executions')), { code: 'ENOENT' });
  assert.equal((await readInvocation(f.store, first.ticket)).reason, 'COMMAND_STARTUP_INTERRUPTED');
});

test('a child dying before ready leaves a truthful retryable startup interruption', async t => {
  const f = await fixture(t), first = await claimInvocation(f.store, f.binding), child = worker(f, first.ticket, 'before-ready');
  await assert.rejects(launchInvocationChild(child, { handle: first.ticket }), { code: 'COMMAND_STARTUP_FAILED' });
  assert.equal((await readInvocation(f.store, first.ticket)).state, 'interrupted');
  assert.equal((await claimInvocation(f.store, f.binding)).ticket, first.ticket);
});
test('unconfigured claims and absent polling write nothing; failed delivery does not implicitly rerun', async t => {
  const f = await fixture(t), before = await fs.readdir(path.join(f.store.root, 'store'));
  const unconfigured = await claimInvocation(f.store, { ...f.binding, cwd: f.root }); assert.equal(unconfigured.result.state, 'unconfigured');
  assert.deepEqual(await fs.readdir(path.join(f.store.root, 'store')), before);
  assert.equal((await readInvocation(f.store, 'missing')).state, 'expired');
  const first = await claimInvocation(f.store, f.binding);
  const failed = await runClaimedInvocation(f.store, first.ticket, { execute: () => { throw new Error('Sensitive native contents'); } });
  assert.equal(failed.reason, 'COMMAND_FAILED'); assert.ok(!JSON.stringify(failed).includes('Sensitive'));
  const repeat = await runClaimedInvocation(f.store, first.ticket, { execute: () => assert.fail('Repeated failed command') });
  assert.equal(repeat.state, 'failed');
});


test('polling rereads a result published between status inspection and idle gate observation', async t => {
  const f = await fixture(t), claim = await claimInvocation(f.store, f.binding);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const work = runClaimedInvocation(f.store, claim.ticket, { execute: async () => { entered(); await blocked; return { state: 'tracked' }; } });
  await ready;
  const original = fs.lstat; let raced = false;
  fs.lstat = async (file, ...args) => {
    if (!raced && String(file).includes(`${path.sep}chats${path.sep}`) && String(file).endsWith('.json')) {
      raced = true; release(); await work;
    }
    return original(file, ...args);
  };
  try { assert.equal((await readInvocation(f.store, claim.ticket)).state, 'tracked'); assert.equal(raced, true); }
  finally { fs.lstat = original; release(); await work; }
});
