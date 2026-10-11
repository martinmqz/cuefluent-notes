import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { processingFixture } from './test-support/processing-fixture.mjs';
import { executeWorkflow } from './workflow.mjs';
import { runProcessingMcp } from './processing-mcp.mjs';
import { claudeHarness, success } from './test-support/claude-client.mjs';
import { rpcClient } from './test-support/rpc-client.mjs';

async function withLaunchFixture(t, run, nativeRun = success) {
  // One explicit lifetime owns jobs, mocks, environment and files. LIFO cleanup
  // drains RPC jobs first, including when an assertion throws after admission.
  const cleanups = [], defer = fn => cleanups.push(fn);
  try {
    const f = await processingFixture({ after: defer }, { client: 'claude' });
    const profile = path.join(f.root, 'claude-profile'); await fs.mkdir(profile);
    const environment = { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_SESSION_ID: f.identity.sessionId,
      CLAUDECODE: '1', 'CUEFLUENT_TEST(x86)': 'synthetic inherited value' };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    defer(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    Object.assign(process.env, environment);
    const h = claudeHarness(nativeRun), nativeSpawn = childProcess.spawn;
    const intercepted = t.mock.method(childProcess, 'spawn', (executable, args, options) => {
      if (executable !== 'claude') return nativeSpawn(executable, args, options);
      return h.spawn(executable, args, options);
    });
    syncBuiltinESMExports();
    defer(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });
    const assertLaunch = () => {
      assert.equal(h.calls.length, 1);
      const { args, options } = h.calls[0];
      assert.equal(options.shell, false);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, profile);
      assert.equal(options.env['CUEFLUENT_TEST(x86)'], environment['CUEFLUENT_TEST(x86)']);
      assert.equal(Object.hasOwn(options.env, 'CLAUDECODE'), false);
      assert.equal(process.env.CLAUDECODE, '1');
      assert.ok(options.env.CUEFLUENT_ENGINE_TOKEN);
      assert.equal(args.some(argument => argument.includes(options.env.CUEFLUENT_ENGINE_TOKEN)), false);
    };
    return await run({ ...f, defer, assertLaunch, intercepted });
  } finally {
    const errors = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Launch fixture cleanup failed');
  }
}

function processingRpc(f, environment = {}) {
  return rpcClient(streams => runProcessingMcp({ client: 'claude', configPath: f.options.configPath, ...streams, ...environment }, {
    // Native source binding has separate coverage; retain the actual controller
    // and native transport while supplying only a synthetic source identity.
    async resolveInvocation() { return { selection: f.selection, callId: 'synthetic-environment-call', nativeSkill: false }; }
  }));
}

async function admit(rpc, f) {
  const initialized = await rpc.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
  assert.ok(initialized.result);
  const admitted = await rpc.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'process_selected_captures', arguments: { collectionId: f.collection.id },
    _meta: { 'claudecode/toolUseId': 'synthetic-environment-call' } } });
  assert.equal(admitted.error, undefined);
  assert.equal(JSON.parse(admitted.result.content[0].text).status, 'busy');
}

test('CLI processing dispatches Claude with the default process environment', async t => withLaunchFixture(t, async f => {
  const request = { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash,
    args: { client: 'claude', requestId: randomUUID(), selection: f.selection, expectedChatHash: null } };
  const result = await executeWorkflow('processing-chat-run', request, { configPath: f.options.configPath });
  assert.equal(result.state, 'idle'); assert.equal(result.nativeStatus, 'completed');
  // This fixture emits protocol frames, not a native session file or exclusion proof.
  assert.deepEqual(result.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
  f.assertLaunch();
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
}));

for (const copied of [false, true]) test(`MCP processing dispatches Claude with ${copied ? 'a copied' : 'its default'} host environment`, async t => withLaunchFixture(t, async f => {
  const rpc = processingRpc(f, copied ? { env: { ...process.env, EXTRA_HOST_VALUE: 'synthetic' } } : {});
  f.defer(() => rpc.close());
  await admit(rpc, f);
  await rpc.close();
  f.assertLaunch();
  const status = await executeWorkflow('processing-chat-status', {
    collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash, args: { client: 'claude' }
  }, { configPath: f.options.configPath });
  assert.equal(status.state, 'idle'); assert.equal(status.nativeStatus, 'completed');
  assert.deepEqual(status.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
}));

test('failure after MCP admission drains the job before restoring spawn, environment or storage', async t => {
  const failure = new Error('synthetic assertion after admission');
  let held = true, finish = null, fixture, observed;
  const originalSpawn = childProcess.spawn, originalProfile = process.env.CLAUDE_CONFIG_DIR;
  await assert.rejects(withLaunchFixture(t, async f => {
    fixture = f;
    const rpc = processingRpc(f);
    f.defer(async () => { held = false; finish?.(); await rpc.close(); });
    await admit(rpc, f);
    throw failure;
  }, frame => {
    const complete = () => {
      observed = { mocked: childProcess.spawn === fixture.intercepted,
        profile: process.env.CLAUDE_CONFIG_DIR, rootExists: existsSync(fixture.root) };
      success(frame);
    };
    if (held) finish = complete; else complete();
  }), error => error === failure);
  assert.deepEqual(observed, { mocked: true, profile: path.join(fixture.root, 'claude-profile'), rootExists: true });
  assert.equal(childProcess.spawn, originalSpawn);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, originalProfile);
  assert.equal(existsSync(fixture.root), false);
});

test('test RPC requests reject on server failure, early exit and missing response', async () => {
  const request = { jsonrpc: '2.0', id: 1, method: 'initialize' };
  const failure = new Error('synthetic server failure');
  const failed = rpcClient(async () => { throw failure; });
  await assert.rejects(failed.send(request), error => error === failure);
  await assert.rejects(failed.close(), error => error === failure);
  const exited = rpcClient(async () => {});
  await assert.rejects(exited.send(request), /server exited before responding/);
  await assert.rejects(exited.send(request), /server already exited/);
  await exited.close();
  const silent = rpcClient(async ({ input }) => { for await (const _ of input) { /* no response */ } }, { timeoutMs: 20 });
  try { await assert.rejects(silent.send(request), /response timed out: initialize/); }
  finally { await silent.close(); }
});
