import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { processingFixture } from './test-support/processing-fixture.mjs';
import { executeWorkflow } from './workflow.mjs';
import { runProcessingMcp } from './processing-mcp.mjs';
import { openProcessingController } from './processing-controller.mjs';
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
    const clearedProviderKeys = ['CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_MODEL', 'AWS_PROFILE', 'ANTHROPIC_BASE_URL'];
    const previous = Object.fromEntries([...Object.keys(environment), ...clearedProviderKeys].map(key => [key, process.env[key]]));
    defer(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    for (const key of clearedProviderKeys) delete process.env[key];
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
    return await run({ ...f, defer, assertLaunch, intercepted, profile, nativeCalls: h.calls });
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

async function providerSettings(f) {
  const settings = { env: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'synthetic-resource',
    ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-profile-credential', PATH: 'synthetic-forbidden-path',
    NODE_OPTIONS: '--require synthetic-forbidden-loader', CUEFLUENT_ENGINE_TOKEN: 'synthetic-forbidden-authority' },
    model: 'synthetic-model', effortLevel: 'xhigh', modelOverrides: { 'synthetic-model': 'synthetic-deployment' },
    availableModels: ['synthetic-model'],
    hooks: { SessionStart: 'synthetic-forbidden-hook' }, enabledPlugins: { 'synthetic@plugin': true } };
  const file = path.join(f.profile, 'settings.json');
  const bytes = Buffer.from(JSON.stringify(settings)); await fs.writeFile(file, bytes);
  return { file, bytes, settings };
}

function assertProviderLaunch(f, index = 0) {
  const { args, options } = f.nativeCalls[index];
  assert.equal(options.env.CLAUDE_CODE_USE_FOUNDRY, '1');
  assert.equal(options.env.ANTHROPIC_FOUNDRY_RESOURCE, 'synthetic-resource');
  assert.equal(options.env.ANTHROPIC_FOUNDRY_API_KEY, 'synthetic-profile-credential');
  assert.equal(Object.hasOwn(options.env, 'ANTHROPIC_MODEL'), false);
  assert.notEqual(options.env.PATH, 'synthetic-forbidden-path');
  assert.notEqual(options.env.NODE_OPTIONS, '--require synthetic-forbidden-loader');
  assert.notEqual(options.env.CUEFLUENT_ENGINE_TOKEN, 'synthetic-forbidden-authority');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), {
    disableAllHooks: true, model: 'synthetic-model', modelOverrides: { 'synthetic-model': 'synthetic-deployment' }, availableModels: ['synthetic-model'], effortLevel: 'xhigh' });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome']) assert(args.includes(flag));
  assert(!JSON.stringify(args).includes('synthetic-profile-credential'));
}

test('CLI restricted processing retains profile provider/authentication without enabling unrelated settings', async t => withLaunchFixture(t, async f => {
  const original = await providerSettings(f);
  const result = await executeWorkflow('processing-chat-run', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { client: 'claude', requestId: randomUUID(),
      selection: f.selection, expectedChatHash: null } }, { configPath: f.options.configPath });
  assert.equal(result.state, 'idle'); f.assertLaunch(); assertProviderLaunch(f);
  assert(!JSON.stringify(result).includes('synthetic-profile-credential'));
  assert((await fs.readFile(original.file)).equals(original.bytes));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
}));

for (const copied of [false, true]) test(`MCP profile provider settings survive ${copied ? 'copied' : 'default'} host env`, async t => withLaunchFixture(t, async f => {
  const original = await providerSettings(f);
  const rpc = processingRpc(f, copied ? { env: { ...process.env } } : {}); f.defer(() => rpc.close());
  await admit(rpc, f); await rpc.close(); f.assertLaunch(); assertProviderLaunch(f);
  assert((await fs.readFile(original.file)).equals(original.bytes));
}));

test('reused Claude processing chat refreshes provider credentials without changing native identity', async t => withLaunchFixture(t, async f => {
  const original = await providerSettings(f);
  const controller = await openProcessingController({ ...f.options, client: 'claude' }); f.defer(() => controller.close());
  const first = await controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null });
  assert.equal(first.state, 'idle'); assertProviderLaunch(f);
  original.settings.env.ANTHROPIC_FOUNDRY_API_KEY = 'synthetic-rotated-profile-credential';
  await fs.writeFile(original.file, JSON.stringify(original.settings));
  const second = await controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: first.chatHash });
  assert.equal(second.state, 'idle'); assert.equal(second.chat.sessionId, first.chat.sessionId);
  assert.equal(f.nativeCalls.length, 2);
  assert.equal(f.nativeCalls[1].options.env.ANTHROPIC_FOUNDRY_API_KEY, 'synthetic-rotated-profile-credential');
  assert.equal(f.nativeCalls[1].args.at(-2), '--resume');
  assert(!JSON.stringify(f.nativeCalls[1].args).includes('synthetic-rotated-profile-credential'));
}));

test('malformed profile settings fail before native reservation while status stays available', async t => withLaunchFixture(t, async f => {
  const file = path.join(f.profile, 'settings.json'), bytes = Buffer.from('{"env":{"ANTHROPIC_API_KEY":"synthetic-private');
  await fs.writeFile(file, bytes);
  const controller = await openProcessingController({ ...f.options, client: 'claude' }); f.defer(() => controller.close());
  const before = await controller.status(); assert.equal(before.state, 'missing');
  await assert.rejects(controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: before.chatHash }),
    { code: 'PROCESSING_CLIENT_SETTINGS_INVALID' });
  assert.deepEqual(await controller.status(), before); assert.equal(f.nativeCalls.length, 0);
  assert((await fs.readFile(file)).equals(bytes));
}));

test('retargeted native profile alias cannot dispatch in the old processing namespace', { skip: process.platform === 'win32' }, async t => withLaunchFixture(t, async f => {
  const alias = path.join(f.root, 'profile-alias'), replacement = path.join(f.root, 'other-profile');
  await fs.mkdir(replacement); await fs.symlink(f.profile, alias, 'dir');
  process.env.CLAUDE_CONFIG_DIR = alias;
  const controller = await openProcessingController({ ...f.options, client: 'claude' }); f.defer(() => controller.close());
  const before = await controller.status();
  await fs.unlink(alias); await fs.symlink(replacement, alias, 'dir');
  await assert.rejects(controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: before.chatHash }),
    { code: 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' });
  assert.deepEqual(await controller.status(), before); assert.equal(f.nativeCalls.length, 0);
}));

test('CLI dispatch preserves an unset locator for the native default credential namespace', async t => withLaunchFixture(t, async f => {
  const home = path.join(f.root, 'synthetic-default-home'), profile = path.join(home, '.claude');
  await fs.mkdir(profile, { recursive: true }); await fs.writeFile(path.join(profile, 'settings.json'), '{}');
  t.mock.method(os, 'homedir', () => home); delete process.env.CLAUDE_CONFIG_DIR;
  const result = await executeWorkflow('processing-chat-run', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { client: 'claude', requestId: randomUUID(), selection: f.selection, expectedChatHash: null } },
    { configPath: f.options.configPath });
  assert.equal(result.state, 'idle'); assert.equal(f.nativeCalls.length, 1);
  assert.equal(Object.hasOwn(f.nativeCalls[0].options.env, 'CLAUDE_CONFIG_DIR'), false);
}));

test('MCP dispatch preserves project host account, endpoint and model over user-profile defaults', async t => withLaunchFixture(t, async f => {
  const source = { AWS_PROFILE: 'synthetic-project-account', ANTHROPIC_BASE_URL: 'https://project.example.invalid', ANTHROPIC_MODEL: 'synthetic-project-model' };
  await fs.writeFile(path.join(f.profile, 'settings.json'), JSON.stringify({ env: { AWS_PROFILE: 'synthetic-user-account',
    ANTHROPIC_BASE_URL: 'https://user.example.invalid', ANTHROPIC_MODEL: 'synthetic-user-model', CLAUDE_CODE_SKIP_VERTEX_AUTH: '1' } }));
  const rpc = processingRpc(f, { env: { ...process.env, ...source } }); f.defer(() => rpc.close());
  await admit(rpc, f); await rpc.close(); f.assertLaunch();
  for (const [key, value] of Object.entries(source)) assert.equal(f.nativeCalls[0].options.env[key], value);
  assert.equal(f.nativeCalls[0].options.env.CLAUDE_CODE_SKIP_VERTEX_AUTH, '1');
}));

test('MCP exposes a safe profile-settings refusal without dispatch or lost state', async t => withLaunchFixture(t, async f => {
  await fs.writeFile(path.join(f.profile, 'settings.json'), '{"apiKeyHelper":"synthetic-private-command"}');
  const rpc = processingRpc(f); f.defer(() => rpc.close());
  await rpc.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25',
    capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
  const refused = await rpc.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'process_selected_captures', arguments: { collectionId: f.collection.id },
    _meta: { 'claudecode/toolUseId': 'synthetic-environment-call' } } });
  assert.equal(refused.error.message, 'PROCESSING_CLIENT_SETTINGS_UNSUPPORTED');
  assert(!JSON.stringify(refused).includes('synthetic-private-command'));
  await rpc.close(); assert.equal(f.nativeCalls.length, 0);
  const status = await executeWorkflow('processing-chat-status', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { client: 'claude' } }, { configPath: f.options.configPath });
  assert.equal(status.state, 'missing');
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
