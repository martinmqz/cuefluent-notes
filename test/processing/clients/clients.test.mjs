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
  const options = { client, executable: process.execPath, cwd, prompt: 'Trusted drafting instructions.', input: 'SOURCE_SENTINEL untrusted data', mcp: { name: 'cuefluent', command: process.execPath, args: [fixture], env: { CUEFLUENT_DRAFT_BRIDGE_TOKEN: 'SYNTHETIC_SECRET' }, tools: ['notes_read', 'draft_write'] } };
  const dependencies = { spawn: (_command, args, launch) => spawn(process.execPath, [fixture, ...args], { ...launch, env: { ...process.env, ...launch.env, FIXTURE_CLIENT: client, FIXTURE_MODE: mode, FIXTURE_TRACE: trace } }) };
  return { options, dependencies, trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse) };
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

test('Codex verifies OS canary before exec and pins current model, high effort, exact MCP and ephemeral isolation', async t => {
  const fixture = await setup(t, 'codex'), result = await runDraftingSession(fixture.options, fixture.dependencies), trace = await fixture.trace();
  assert.equal(result.model, 'gpt-6.1-sol'); assert.equal(result.finalText, 'COMPLETE');
  const launch = trace.find(value => value.arguments?.[0] === 'exec'), canary = trace.findIndex(value => value.method === 'command/exec');
  assert.ok(canary >= 0 && canary < trace.findIndex(value => value.sourceReceived));
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config']) assert.ok(launch.arguments.includes(flag));
  assert.ok(launch.arguments.includes('gpt-6.1-sol')); assert.ok(launch.arguments.includes('model_reasoning_effort="high"'));
  assert.ok(launch.arguments.includes('permissions.cuefluent_processing.network.enabled=false'));
  if (process.platform === 'win32') assert.ok(launch.arguments.includes('windows.sandbox="mxc"'));
  assert.ok(launch.arguments.includes('mcp_servers.cuefluent.enabled_tools=["notes_read","draft_write"]'));
  assert.equal(JSON.stringify(launch.arguments).includes('SYNTHETIC_SECRET'), false); assert.equal(launch.tokenPresent, true);
  assert.equal(trace.some(value => value.method === 'config/read' || value.method === 'thread/start'), false);
});

test('Codex accepts an explicitly selected available model without changing its default or isolation', async t => {
  const fixture = await setup(t, 'codex'); fixture.options.model = 'gpt-6-luna';
  const result = await runDraftingSession(fixture.options, fixture.dependencies), trace = await fixture.trace();
  assert.equal(result.model, 'gpt-6-luna');
  const launch = trace.find(value => value.arguments?.[0] === 'exec');
  assert.ok(launch.arguments.includes('gpt-6-luna')); assert.ok(launch.arguments.includes('model_reasoning_effort="high"'));
  assert.ok(launch.arguments.includes('permissions.cuefluent_processing.network.enabled=false'));
  assert.ok(trace.findIndex(value => value.method === 'command/exec') < trace.findIndex(value => value.sourceReceived));
});

test('Codex accepts explicitly selected xhigh without changing the high default', async t => {
  const fixture = await setup(t, 'codex'); fixture.options.effort = 'xhigh';
  await runDraftingSession(fixture.options, fixture.dependencies);
  assert.ok((await fixture.trace()).find(value => value.arguments?.[0] === 'exec').arguments.includes('model_reasoning_effort="xhigh"'));
});

for (const mode of ['managed', 'canary']) test(`Codex refuses ${mode} before starting exec or delivering source`, async t => {
  const fixture = await setup(t, 'codex', mode);
  await assert.rejects(runDraftingSession(fixture.options, fixture.dependencies), { code: 'PROCESSING_ISOLATION_UNSUPPORTED' });
  const trace = await fixture.trace(); assert.equal(trace.some(value => value.sourceReceived || value.arguments?.[0] === 'exec'), false);
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
