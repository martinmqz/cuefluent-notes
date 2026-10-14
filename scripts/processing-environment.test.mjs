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
import { canonicalJSON, digest } from './workflow-values.mjs';
import { runProcessingMcp } from './processing-mcp.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { claudeHarness, success } from './test-support/claude-client.mjs';
import { rpcClient } from './test-support/rpc-client.mjs';

async function withLaunchFixture(t, run, nativeRun = success, { insideClaude = true } = {}) {
  // One explicit lifetime owns jobs, mocks, environment and files. LIFO cleanup
  // drains RPC jobs first, including when an assertion throws after admission.
  const cleanups = [], defer = fn => cleanups.push(fn);
  try {
    const f = await processingFixture({ after: defer }, { client: 'claude' });
    const profile = path.join(f.root, 'claude-profile'); await fs.mkdir(profile);
    const environment = { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_SESSION_ID: f.identity.sessionId,
      CLAUDECODE: '1', 'CUEFLUENT_TEST(x86)': 'synthetic inherited value' };
    const clearedProviderKeys = ['CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_MODEL', 'AWS_PROFILE', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
      'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'ANTHROPIC_AUTH_TOKEN'];
    const previous = Object.fromEntries([...Object.keys(environment), ...clearedProviderKeys].map(key => [key, process.env[key]]));
    defer(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    for (const key of clearedProviderKeys) delete process.env[key];
    Object.assign(process.env, environment);
    if (!insideClaude) {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
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
      assert.equal(process.env.CLAUDECODE, insideClaude ? '1' : undefined);
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
    async resolveInvocation(_capability, context, invocation) { return { selection: f.selection, callId: context.toolCallId, nativeSkill: false, argsHash: digest(canonicalJSON(invocation.arguments)) }; }
  }));
}

async function writerSnapshot(f) {
  const root = f.collection.notes.writerStateDir;
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Promise.all(files.map(async file => [path.relative(root, file), await fs.readFile(file)]));
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
    model: 'synthetic-model', effortLevel: 'xhigh', modelSettings: { 'synthetic-model': { effortLevel: 'low' } },
    modelOverrides: { 'synthetic-model': 'synthetic-deployment' },
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
    disableAllHooks: true, model: 'synthetic-model', modelOverrides: { 'synthetic-model': 'synthetic-deployment' }, availableModels: ['synthetic-model'] });
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

test('missing Desktop host credential fails before a CLI native reservation and leaves status available', async t => withLaunchFixture(t, async f => {
  const original = await providerSettings(f);
  Object.assign(process.env, { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN',
    CLAUDE_CODE_USE_FOUNDRY: '', ANTHROPIC_BASE_URL: 'https://host.example.invalid' });
  const request = { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash,
    args: { client: 'claude' } };
  const before = await executeWorkflow('processing-chat-status', request, { configPath: f.options.configPath });
  await assert.rejects(executeWorkflow('processing-chat-run', { ...request, args: { ...request.args,
    requestId: randomUUID(), selection: f.selection, expectedChatHash: before.chatHash } }, { configPath: f.options.configPath }),
  { code: 'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE' });
  assert.deepEqual(await executeWorkflow('processing-chat-status', request, { configPath: f.options.configPath }), before);
  assert.equal(f.nativeCalls.length, 0);
  assert((await fs.readFile(original.file)).equals(original.bytes));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
}));

for (const locator of [undefined, 'ANTHROPIC_AUTH_TOKEN']) test(`MCP rejects incomplete host handoff before workset/control mutation: ${locator ?? 'no locator'}`, async t => withLaunchFixture(t, async f => {
  const original = await providerSettings(f);
  const rpc = processingRpc(f, { env: { ...process.env, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    ...(locator ? { CLAUDE_CODE_HOST_AUTH_ENV_VAR: locator } : {}), CLAUDE_CODE_USE_FOUNDRY: '', ANTHROPIC_BASE_URL: 'https://host.example.invalid' } });
  f.defer(() => rpc.close());
  await rpc.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
  const response = await rpc.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'process_selected_captures', arguments: { collectionId: f.collection.id },
    _meta: { 'claudecode/toolUseId': 'synthetic-environment-call' } } });
  assert.equal(response.error?.message, 'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE');
  assert.equal(response.result, undefined);
  for (const relative of ['processed/shortcut-controls', 'processed/shortcuts', 'processed/worksets']) {
    assert.equal(existsSync(path.join(f.collection.notes.writerStateDir, relative)), false);
  }
  await rpc.close();
  const status = await executeWorkflow('processing-chat-status', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { client: 'claude' } }, { configPath: f.options.configPath });
  assert.equal(status.state, 'missing'); assert.equal(status.chatHash, null);
  assert.equal(f.nativeCalls.length, 0);
  assert((await fs.readFile(original.file)).equals(original.bytes));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
}));

test('a complete MCP host handoff launches with its credential and no profile provider fallback', async t => withLaunchFixture(t, async f => {
  const original = await providerSettings(f);
  const source = { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN',
    ANTHROPIC_AUTH_TOKEN: 'synthetic-host-token', CLAUDE_CODE_USE_FOUNDRY: '', ANTHROPIC_BASE_URL: 'https://host.example.invalid' };
  const rpc = processingRpc(f, { env: { ...process.env, ...source } }); f.defer(() => rpc.close());
  await admit(rpc, f); await rpc.close(); f.assertLaunch();
  const { args, options } = f.nativeCalls[0];
  for (const [key, value] of Object.entries(source)) assert.equal(options.env[key], value);
  assert.equal(Object.hasOwn(options.env, 'ANTHROPIC_FOUNDRY_API_KEY'), false);
  assert.equal(Object.hasOwn(options.env, 'ANTHROPIC_FOUNDRY_RESOURCE'), false);
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true,
    model: original.settings.model, modelOverrides: original.settings.modelOverrides, availableModels: original.settings.availableModels });
  assert(!JSON.stringify(args).includes('synthetic-host-token'));
  assert((await fs.readFile(original.file)).equals(original.bytes));
}));

for (const tool of ['process_selected_captures', 'processing_resume']) for (const collect of [true, false]) {
  test(`MCP replays ${tool} without host credentials or capture receipts, collection ${collect ? 'on' : 'off'}`, async t => withLaunchFixture(t, async f => {
    if (!collect) {
      f.config.routes[0].collection.enabled = false;
      await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
    }
    const env = { ...process.env, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN', ANTHROPIC_AUTH_TOKEN: 'synthetic-host-token' };
    const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } };
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: tool, arguments: { collectionId: f.collection.id },
      _meta: { 'claudecode/toolUseId': 'synthetic-environment-call' } } };
    const original = processingRpc(f, { env }); f.defer(() => original.close());
    await original.send(initialize);
    const first = await original.send(request);
    assert.equal(first.error, undefined); assert.ok(first.result);
    await original.close();
    const launches = f.nativeCalls.length;
    assert.equal(launches, tool === 'process_selected_captures' ? 1 : 0);
    const before = await writerSnapshot(f);
    assert(before.some(([name]) => name.startsWith(`processed${path.sep}shortcut-controls${path.sep}`)));
    delete env.ANTHROPIC_AUTH_TOKEN;
    const reconnected = processingRpc(f, { env }); f.defer(() => reconnected.close());
    await reconnected.send(initialize);
    assert.deepEqual((await reconnected.send(request)).result, first.result);
    const changed = await reconnected.send({ ...request, id: 2, params: {
      ...request.params, arguments: {} } });
    assert.equal(changed.error?.message, 'PROCESSING_CONTROL_RECEIPT_CONFLICT');
    const fresh = await reconnected.send({ ...request, id: 3, params: {
      ...request.params, _meta: { 'claudecode/toolUseId': 'synthetic-new-call' } } });
    assert.equal(fresh.error?.message, 'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE');
    await reconnected.close();
    assert.equal(f.nativeCalls.length, launches);
    assert.deepEqual(await writerSnapshot(f), before);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  }));
}

test('MCP no-launch checks return an active job without host credentials or new control writes', async t => {
  const entered = Promise.withResolvers(); let released = false, finishNative;
  await withLaunchFixture(t, async f => {
    const env = { ...process.env, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN', ANTHROPIC_AUTH_TOKEN: 'synthetic-host-token' };
    const rpc = processingRpc(f, { env });
    f.defer(async () => { released = true; finishNative?.(); await rpc.close(); });
    await admit(rpc, f); await entered.promise;
    const before = await writerSnapshot(f);
    delete env.ANTHROPIC_AUTH_TOKEN;
    for (const [index, tool] of ['process_selected_captures', 'processing_resume'].entries()) {
      const response = await rpc.send({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: {
        name: tool, arguments: { collectionId: f.collection.id },
        _meta: { 'claudecode/toolUseId': `synthetic-active-${index}` } } });
      assert.equal(response.error, undefined);
      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.status, 'busy'); assert.equal(result.statusDetail, 'already-processing');
      assert.deepEqual(result.diagnostics, ['PROCESSING_CHAT_BUSY']);
      assert.equal(f.nativeCalls.length, 1);
      assert.deepEqual(await writerSnapshot(f), before);
    }
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  }, context => { finishNative = () => success(context); entered.resolve(); if (released) finishNative(); });
});

for (const peer of [false, true]) for (const state of ['busy', 'blocked']) {
  test(`MCP no-launch checks preserve ${peer ? 'competing' : 'own'} stored ${state} without host credentials`, async t => {
    const entered = Promise.withResolvers(); let released = false, finishNative;
    await withLaunchFixture(t, async f => {
      const owner = await openProcessingController({ ...f.options, client: 'claude' });
      f.defer(() => owner.close());
      const active = owner.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null });
      active.catch(() => {});
      f.defer(async () => { released = true; finishNative?.(); await active.catch(() => {}); });
      if (state === 'blocked') await assert.rejects(active, error => error.processingChat?.state === 'blocked');
      else await entered.promise;
      const status = await owner.status(); assert.equal(status.state, state);
      const env = { ...process.env, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' };
      if (peer) { env.CLAUDE_CONFIG_DIR = path.join(f.root, 'other-profile'); await fs.mkdir(env.CLAUDE_CONFIG_DIR); }
      const rpc = processingRpc(f, { env }); f.defer(() => rpc.close());
      await rpc.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
      const before = await writerSnapshot(f);
      for (const [index, tool] of ['process_selected_captures', 'processing_resume'].entries()) {
        const response = await rpc.send({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: {
          name: tool, arguments: { collectionId: f.collection.id },
          _meta: { 'claudecode/toolUseId': `synthetic-stored-${index}` } } });
        assert.equal(response.error, undefined);
        const result = JSON.parse(response.result.content[0].text);
        assert.equal(result.status, state);
        assert.equal(result.statusDetail, state === 'busy' ? 'already-processing' : 'blocked');
        assert(result.diagnostics.includes(peer ? 'PROCESSING_COLLECTION_BUSY' : 'PROCESSING_CHAT_BUSY'));
        assert.equal(result.chat.sessionId, status.chat.sessionId);
        assert.deepEqual(await owner.status(), status);
        assert.deepEqual(await writerSnapshot(f), before);
        assert.equal(f.nativeCalls.length, 1);
      }
      assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
    }, context => {
      if (state === 'blocked') { context.child.emit('close', 1, null); return; }
      finishNative = () => success(context); entered.resolve(); if (released) finishNative();
    });
  });
}

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

for (const insideClaude of [true, false]) test(`CLI dispatch ${insideClaude ? 'inside Claude keeps host settings' : 'outside Claude applies user settings over shell values'}`,
  async t => withLaunchFixture(t, async f => {
  const inherited = { AWS_PROFILE: 'synthetic-host-account', ANTHROPIC_BASE_URL: 'https://host.example.invalid',
    ANTHROPIC_MODEL: 'synthetic-host-model', ANTHROPIC_API_KEY: 'synthetic-host-key' };
  const profile = { AWS_PROFILE: 'synthetic-user-account', ANTHROPIC_BASE_URL: 'https://user.example.invalid',
    ANTHROPIC_MODEL: 'synthetic-user-model', ANTHROPIC_API_KEY: 'synthetic-user-key' };
  Object.assign(process.env, inherited);
  if (!insideClaude) {
    assert.equal(Object.hasOwn(process.env, 'CLAUDECODE'), false);
    assert.equal(Object.hasOwn(process.env, 'CLAUDE_CODE_SESSION_ID'), false);
  }
  const file = path.join(f.profile, 'settings.json'), bytes = Buffer.from(JSON.stringify({ env: profile }));
  await fs.writeFile(file, bytes);
  const result = await executeWorkflow('processing-chat-run', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { client: 'claude', requestId: randomUUID(),
      selection: f.selection, expectedChatHash: null } }, { configPath: f.options.configPath });
  assert.equal(result.state, 'idle'); f.assertLaunch();
  for (const [key, value] of Object.entries(insideClaude ? inherited : profile)) assert.equal(f.nativeCalls[0].options.env[key], value);
  for (const [key, value] of Object.entries(inherited)) assert.equal(process.env[key], value);
  assert(!JSON.stringify(f.nativeCalls[0].args).includes('synthetic-user-key'));
  assert(!JSON.stringify(f.nativeCalls[0].args).includes('synthetic-host-key'));
  assert((await fs.readFile(file)).equals(bytes));
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
}, success, { insideClaude }));

test('verified host-mode reuse keeps inherited credentials after profile rotation until its host env is refreshed', async t => withLaunchFixture(t, async f => {
  const file = path.join(f.profile, 'settings.json');
  await fs.writeFile(file, JSON.stringify({ env: { ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-original-key' } }));
  const env = { ...process.env, ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-original-key' };
  const controller = await openProcessingController({ ...f.options, client: 'claude' }, { env, preferHostEnvironment: true });
  f.defer(() => controller.close());
  const first = await controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null });
  await fs.writeFile(file, JSON.stringify({ env: { ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-rotated-key' } }));
  const second = await controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: first.chatHash });
  assert.equal(second.chat.sessionId, first.chat.sessionId);
  assert.equal(f.nativeCalls[1].options.env.ANTHROPIC_FOUNDRY_API_KEY, 'synthetic-original-key');
  env.ANTHROPIC_FOUNDRY_API_KEY = 'synthetic-rotated-key';
  await controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: second.chatHash });
  assert.equal(f.nativeCalls[2].options.env.ANTHROPIC_FOUNDRY_API_KEY, 'synthetic-rotated-key');
}));

test('missing native profile returns safe CLI and MCP diagnostics without replacing the processing registry', async t => withLaunchFixture(t, async f => {
  const initial = await executeWorkflow('processing-chat-run', { collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash, args: { client: 'claude', requestId: randomUUID(),
      selection: f.selection, expectedChatHash: null } }, { configPath: f.options.configPath });
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const filenames = await fs.readdir(directory), before = await fs.readFile(path.join(directory, filenames[0]));
  await fs.rm(f.profile, { recursive: true });
  for (const [command, args] of [
    ['processing-chat-status', { client: 'claude' }],
    ['processing-chat-run', { client: 'claude', requestId: randomUUID(), selection: f.selection, expectedChatHash: initial.chatHash }],
  ]) await assert.rejects(executeWorkflow(command, { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash, args },
    { configPath: f.options.configPath }), error => error.code === 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' &&
    error.message === error.code && error.cause === undefined);
  const rpc = processingRpc(f); f.defer(() => rpc.close());
  await rpc.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25',
    capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
  const refused = await rpc.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'processing_status',
    arguments: { collectionId: f.collection.id }, _meta: { 'claudecode/toolUseId': 'synthetic-environment-call' } } });
  assert.equal(refused.error.message, 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE');
  assert((await fs.readFile(path.join(directory, filenames[0]))).equals(before));
  assert.equal(f.nativeCalls.length, 1); assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
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
