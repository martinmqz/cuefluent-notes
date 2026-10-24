import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, chmod, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDraftingSession } from '../../../src/processing/clients/index.mjs';
import { establishWindowsPrivacy } from '../../../src/storage/platform.mjs';

const fixture = fileURLToPath(new URL('./native.fixture.mjs', import.meta.url));
async function setup(t, client, mode = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cuefluent-adapter-test-')), cwd = await mkdtemp(path.join(root, 'empty-')), trace = path.join(root, 'trace.jsonl');
  establishWindowsPrivacy(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { client, version: '0.16.0-dev.0', executable: process.execPath, cwd, prompt: 'Trusted drafting instructions.', input: 'SOURCE_SENTINEL untrusted data', mcp: { name: 'cuefluent', command: process.execPath, args: [fixture], env: { CUEFLUENT_DRAFT_BRIDGE_TOKEN: 'SYNTHETIC_SECRET' }, tools: ['notes_read', 'draft_write'] } };
  const launches = [];
  const dependencies = { spawn: (_command, args, launch) => {
    launches.push({ args, nativeHomePreserved: launch.env?.CODEX_HOME === process.env.CODEX_HOME });
    return spawn(process.execPath, [fixture, ...args], { ...launch, env: { ...process.env, ...launch.env, FIXTURE_CLIENT: client, FIXTURE_MODE: mode, FIXTURE_TRACE: trace } });
  } };
  return { options, dependencies, launches, trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('Claude verifies effective policy, exact tools and context before source delivery; secrets stay out of arguments', async t => {
  const fixture = await setup(t, 'claude'); let started = false;
  fixture.options.onStarted = async info => { assert.equal(info.ephemeral, true); assert.equal((await fixture.trace()).some(value => value.sourceReceived), false); started = true; };
  const result = await runDraftingSession(fixture.options, fixture.dependencies), trace = await fixture.trace();
  assert.equal(started, true); assert.equal(result.model, 'claude-opus-5-5'); assert.equal(result.finalText, 'COMPLETE');
  const methods = trace.filter(value => value.method).map(value => value.method);
  assert.deepEqual(methods, ['initialize', 'get_settings', 'mcp_status', 'get_context_usage']);
  const launch = trace.find(value => value.arguments);
  assert.equal(launch.tokenPresent, true); assert.equal(JSON.stringify(launch.arguments).includes('SYNTHETIC_SECRET'), false);
  assert.ok(launch.arguments.includes('--no-session-persistence')); assert.ok(launch.arguments.includes('--restricted'));
});

for (const mode of ['hooks', 'managed', 'extra-tool', 'memory']) test(`Claude rejects ${mode} before delivering untrusted data`, async t => {
  const fixture = await setup(t, 'claude', mode);
  await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code: 'PROCESSING_ISOLATION_UNSUPPORTED' });
  assert.equal((await fixture.trace()).some(value => value.sourceReceived), false);
});

test('Claude waits for pending MCP startup without delivering source or imposing a completion cutoff', async t => {
  const fixture = await setup(t, 'claude', 'pending');
  assert.equal((await runDraftingSession(fixture.options, fixture.dependencies)).status, 'completed');
  assert.equal((await fixture.trace()).filter(value => value.method === 'mcp_status').length, 2);
});

test('Codex retains the native provider and deployment while verifying ephemeral isolation before source delivery', async t => {
  const fixture = await setup(t, 'codex'); let started;
  fixture.options.onStarted = async info => {
    assert.equal((await fixture.trace()).some(value => value.sourceReceived), false);
    started = info;
  };
  const result = await runDraftingSession(fixture.options, fixture.dependencies), trace = await fixture.trace();
  assert.equal(result.model, 'team-production-deployment'); assert.equal(result.finalText, 'COMPLETE');
  assert.deepEqual(started, { client: 'codex', sessionId: 'synthetic-codex', model: 'team-production-deployment', ephemeral: true });
  assert.equal(fixture.launches.length, 1); assert.equal(fixture.launches[0].nativeHomePreserved, true);
  const launch = trace.find(value => value.arguments), start = trace.find(value => value.method === 'thread/start').params;
  assert.equal(launch.arguments[0], 'app-server'); assert.ok(launch.arguments.includes('--strict-config'));
  assert.ok(launch.arguments.includes('model_reasoning_effort="high"'));
  assert.equal(launch.arguments.includes('--ignore-user-config'), false);
  assert.equal(launch.arguments.some(value => /^(?:model|model_provider|model_providers|cli_auth_credentials_store)=/.test(value)), false);
  if (process.platform === 'win32') assert.ok(launch.arguments.includes('windows.sandbox="mxc"'));
  assert.equal(Object.hasOwn(start, 'model'), false); assert.equal(Object.hasOwn(start, 'modelProvider'), false);
  assert.equal(start.ephemeral, true); assert.equal(start.baseInstructions, fixture.options.prompt);
  assert.equal(start.developerInstructions, ''); assert.deepEqual(start.selectedCapabilityRoots, []);
  assert.deepEqual(start.environments, []); assert.deepEqual(start.runtimeWorkspaceRoots, []);
  assert.equal(start.config['features.hooks'], false); assert.equal(start.config['features.synthetic_future_tool'], false);
  assert.equal(Object.hasOwn(start.config, 'features.secret_auth_storage'), false);
  assert.equal(Object.hasOwn(start.config, 'features.respect_system_proxy'), false);
  assert.equal(start.config['features.skip_host_skill_discovery'], true);
  assert.equal(start.config['features.unified_exec'], true);
  for (const value of ['otel.log_user_prompt=false', 'otel.exporter="none"', 'otel.trace_exporter="none"', 'otel.metrics_exporter="none"']) assert.ok(launch.arguments.includes(value));
  const servers = start.config.mcp_servers, serverName = Object.keys(servers).find(name => name.startsWith('cuefluent_'));
  assert.deepEqual(servers.existing_toolbox, { enabled: false }); assert.deepEqual(servers.cuefluent, { enabled: false });
  assert.match(serverName, /^cuefluent_[a-f0-9]{20}$/); assert.match(start.permissions, /^cuefluent_processing_[a-f0-9]{20}$/);
  assert.deepEqual(servers[serverName].enabled_tools, ['notes_read', 'draft_write']);
  assert.deepEqual(servers[serverName].env_vars, ['CUEFLUENT_DRAFT_BRIDGE_TOKEN']);
  assert.equal(Object.hasOwn(servers[serverName], 'env'), false);
  assert.ok(launch.arguments.includes(`permissions.${start.permissions}.network.enabled=false`));
  const filesystem = launch.arguments.find(value => value.startsWith(`permissions.${start.permissions}.filesystem=`));
  assert.ok(filesystem.includes('":slash_tmp"="deny"')); assert.ok(filesystem.includes('":tmpdir"="deny"'));
  const probes = trace.filter(value => value.method === 'command/exec');
  assert.ok(probes.length > 0); assert.ok(probes.every(value => value.params.permissionProfile === start.permissions));
  const sourceIndex = trace.findIndex(value => value.sourceReceived);
  assert.ok(trace.findIndex(value => value.method === 'command/exec') < sourceIndex);
  assert.ok(trace.findIndex(value => value.method === 'mcpServerStatus/list') < sourceIndex);
  assert.ok(trace.findIndex(value => value.method === 'experimentalFeature/list' && value.params.threadId) < sourceIndex);
  assert.equal(trace.some(value => /config\/(?:value|batchWrite|write)/.test(value.method ?? '')), false);
  const wire = JSON.stringify(trace);
  for (const secret of ['SYNTHETIC_SECRET', 'SYNTHETIC_PROVIDER_CREDENTIAL', 'synthetic-native-auth-helper', 'synthetic-provider.invalid']) assert.equal(wire.includes(secret), false);
  assert.equal(launch.tokenPresent, true);
  assert.equal(trace.filter(value => value.method === 'experimentalFeature/list' && value.params.threadId).length, 2);
  assert.equal(trace.filter(value => value.method === 'mcpServerStatus/list').length, 2);
});

test('Codex accepts an explicit deployment name without overriding its native provider', async t => {
  const fixture = await setup(t, 'codex'); fixture.options.model = 'team-special-deployment';
  const result = await runDraftingSession(fixture.options, fixture.dependencies), trace = await fixture.trace();
  assert.equal(result.model, 'team-special-deployment');
  const start = trace.find(value => value.method === 'thread/start').params;
  assert.equal(start.model, 'team-special-deployment'); assert.equal(Object.hasOwn(start, 'modelProvider'), false);
  assert.equal(JSON.stringify(start.config).includes('model_provider'), false);
});

test('Codex uses fresh permission and MCP names for separate native sessions', async t => {
  const names = [];
  for (let index = 0; index < 2; index++) {
    const fixture = await setup(t, 'codex'); await runDraftingSession(fixture.options, fixture.dependencies);
    const start = (await fixture.trace()).find(value => value.method === 'thread/start').params;
    names.push({ profile: start.permissions, server: Object.keys(start.config.mcp_servers).find(name => name.startsWith('cuefluent_')) });
  }
  assert.notEqual(names[0].profile, names[1].profile); assert.notEqual(names[0].server, names[1].server);
});

test('Codex accepts explicitly selected xhigh without changing the high default', async t => {
  const fixture = await setup(t, 'codex'); fixture.options.effort = 'xhigh';
  await runDraftingSession(fixture.options, fixture.dependencies);
  assert.ok((await fixture.trace()).find(value => value.arguments).arguments.includes('model_reasoning_effort="xhigh"'));
});

for (const mode of ['managed', 'canary', 'config-warning', 'hooks', 'future-tool', 'inherited-active', 'extra-tool', 'extra-mcp', 'mcp-resource', 'project-guidance', 'persistent', 'wrong-session', 'wrong-provider', 'wrong-profile',
  'telemetry-prompts', 'telemetry-exporter', 'telemetry-trace_exporter', 'telemetry-metrics_exporter', 'during-policy-feature']) test(`Codex refuses ${mode} before delivering source`, async t => {
  const fixture = await setup(t, 'codex', mode);
  await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code: 'PROCESSING_ISOLATION_UNSUPPORTED' });
  assert.equal((await fixture.trace()).some(value => value.sourceReceived || value.method === 'turn/start'), false);
});

test('Codex coalesces new policy notifications while still checking after completion', async t => {
  const fixture = await setup(t, 'codex', 'midturn-burst');
  assert.equal((await runDraftingSession(fixture.options, fixture.dependencies)).status, 'completed');
  const trace = await fixture.trace();
  assert.equal(trace.filter(value => value.method === 'experimentalFeature/list' && value.params.threadId).length, 3);
  assert.equal(trace.filter(value => value.method === 'mcpServerStatus/list').length, 3);
});

test('Codex permits native global guidance while keeping project guidance excluded', async t => {
  const fixture = await setup(t, 'codex', 'global-guidance');
  assert.equal((await runDraftingSession(fixture.options, fixture.dependencies)).status, 'completed');
});

test('Codex waits through a retryable native transport error to terminal completion', async t => {
  const fixture = await setup(t, 'codex', 'retry');
  assert.equal((await runDraftingSession(fixture.options, fixture.dependencies)).finalText, 'COMPLETE');
  assert.equal((await fixture.trace()).filter(value => value.method === 'turn/start').length, 1);
});

test('Codex accepts an unchanged native settings update with sandboxPolicy and effort fields', async t => {
  const fixture = await setup(t, 'codex', 'settings-unchanged');
  assert.equal((await runDraftingSession(fixture.options, fixture.dependencies)).status, 'completed');
});

test('Codex completes drafting after native context compaction and a display plan in the same turn', async t => {
  const fixture = await setup(t, 'codex', 'long-turn-lifecycle');
  const result = await runDraftingSession(fixture.options, fixture.dependencies);
  assert.equal(result.status, 'completed'); assert.equal(result.finalText, 'COMPLETE');
  assert.equal((await fixture.trace()).filter(value => value.method === 'turn/start').length, 1);
});

for (const [mode, code] of [['terminal-error', 'PROCESSING_CLIENT_FAILED'], ['failed-turn', 'PROCESSING_CLIENT_FAILED'], ['oversized-plan', 'PROCESSING_PROTOCOL_LIMIT'],
  ...['wrong-thread-event', 'wrong-turn-event', 'shell-event', 'unknown-item', 'foreign-tool', 'interactive-request', 'settings-drift', 'postflight-feature', 'midturn-policy'].map(mode => [mode, 'PROCESSING_ISOLATION_UNSUPPORTED'])]) test(`Codex refuses ${mode} without reporting completion`, async t => {
  const fixture = await setup(t, 'codex', mode);
  await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code });
  assert.equal((await fixture.trace()).filter(value => value.method === 'turn/start').length, 1);
});

test('an explicit abort ends a waiting Codex turn', async t => {
  const fixture = await setup(t, 'codex', 'slow'), controller = new AbortController();
  fixture.options.signal = controller.signal;
  const original = fixture.dependencies.spawn;
  fixture.dependencies.spawn = (...args) => {
    const child = original(...args); let pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk.toString(); let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const value = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        if (value.method === 'turn/started') setImmediate(() => controller.abort());
      }
    });
    return child;
  };
  await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code: 'PROCESSING_ABORTED' });
  assert.equal((await fixture.trace()).some(value => value.sourceReceived), true);
});

test('invalid Codex deployment selections fail before native startup', async t => {
  const fixture = await setup(t, 'codex');
  for (const model of ['', 'deployment name', 'deployment\nname', 'x'.repeat(257)]) await assert.rejects(runDraftingSession({ ...fixture.options, model }, fixture.dependencies), { code: 'PROCESSING_ARGUMENT' });
  assert.equal(fixture.launches.length, 0);
});

test('only explicit abort ends an active waiting Claude transport', async t => {
  const fixture = await setup(t, 'claude', 'slow'), controller = new AbortController();
  fixture.options.signal = controller.signal; fixture.options.onStarted = () => setImmediate(() => controller.abort());
  await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code: 'PROCESSING_ABORTED' });
});

test('invalid models, auth environment overrides and nonprivate cwd fail before client startup', async t => {
  const fixture = await setup(t, 'claude');
  await assert.rejects(runDraftingSession({ ...fixture.options, model: 'default' }, fixture.dependencies), { code: 'PROCESSING_ARGUMENT' });
  await assert.rejects(runDraftingSession({ ...fixture.options, mcp: { ...fixture.options.mcp, env: { CODEX_HOME: 'synthetic' } } }, fixture.dependencies), { code: 'PROCESSING_ARGUMENT' });
  if (process.platform !== 'win32') {
    await chmod(fixture.options.cwd, 0o755);
    await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code: 'PRIVATE_ACCESS_UNSAFE' });
  }
});

test('a private but project-configured cwd is refused before native startup', async t => {
  const fixture = await setup(t, 'claude');
  await mkdir(path.join(path.dirname(fixture.options.cwd), '.git'));
  await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code: 'PROCESSING_ISOLATION_UNSUPPORTED' });
});


for (const mode of ['updated', 'builtin']) test(`Claude accepts ${mode} only after verifying effective capabilities`, async t => {
  const fixture = await setup(t, 'claude', mode);
  assert.equal((await runDraftingSession(fixture.options, fixture.dependencies)).status, 'completed');
  const launch = (await fixture.trace()).find(value => value.arguments);
  const settings = JSON.parse(launch.arguments[launch.arguments.indexOf('--settings') + 1]);
  assert.equal(settings.enabledPlugins['cc-plugin-mermaid@builtin'], false);
});
for (const [mode, code] of [['old-version', 'PROCESSING_CLIENT_VERSION_UNSUPPORTED'], ['new-major', 'PROCESSING_CLIENT_VERSION_UNSUPPORTED'], ['effort-cap', 'PROCESSING_EFFORT_UNAVAILABLE'], ['builtin-tool', 'PROCESSING_ISOLATION_UNSUPPORTED']]) test(`Claude refuses ${mode} before delivering source`, async t => {
  const fixture = await setup(t, 'claude', mode);
  await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code });
  assert.equal((await fixture.trace()).some(value => value.sourceReceived), false);
});
test('Claude clears inherited effort without mutating the parent environment', async t => {
  const prior = process.env.CLAUDE_CODE_EFFORT_LEVEL; process.env.CLAUDE_CODE_EFFORT_LEVEL = 'medium';
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL; else process.env.CLAUDE_CODE_EFFORT_LEVEL = prior; });
  const fixture = await setup(t, 'claude');
  // Avoid reintroducing a deliberately absent inherited override in the mock.
  const original = fixture.dependencies.spawn;
  fixture.dependencies.spawn = (command, args, launch) => {
    const ambient = process.env.CLAUDE_CODE_EFFORT_LEVEL; delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    try { return original(command, args, launch); } finally { process.env.CLAUDE_CODE_EFFORT_LEVEL = ambient; }
  };
  await runDraftingSession(fixture.options, fixture.dependencies);
  assert.equal((await fixture.trace())[0].effortOverride, null); assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
});

test('Codex preflight identifies this package version and malformed versions are refused before any launch', async t => {
  const fixture = await setup(t, 'codex');
  assert.equal((await runDraftingSession(fixture.options, fixture.dependencies)).status, 'completed');
  assert.equal((await fixture.trace()).find(value => value.method === 'initialize').clientVersion, '0.16.0-dev.0');
  for (const version of [undefined, '2.0', 'v0.16.0', '0.16.0+build.1']) await assert.rejects(runDraftingSession({ ...fixture.options, version }, fixture.dependencies), { code: 'PROCESSING_ARGUMENT' });
});
