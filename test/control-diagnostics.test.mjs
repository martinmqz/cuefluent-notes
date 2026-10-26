import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createControlBridge, presentControlResult, CONTROL_LIMITS } from '../src/client/control-server.mjs';
import { createProject } from '../src/core/settings.mjs';
import { createRun, replaceAttempt, publishDrafts, readyForReview } from '../src/core/run.mjs';
import { validateResult } from '../src/core/result.mjs';

async function protocol(bridge) {
  const call = bridge.protocol({ version: '0.17.1' });
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } });
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return call;
}
const message = (name, args = {}) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });

test('both command transports explain retained failures and flag the failed command', async () => {
  const retained = Object.freeze({ state: 'failed', reason: 'PROCESSING_CLIENT_FAILED', handle: 'a'.repeat(86) });
  const claude = createControlBridge({ client: 'claude', readInvocation: async () => retained });
  const codex = createControlBridge({ client: 'codex', codexAdapter: { bindCommand: async () => ({ status: 'ready', binding: { client: 'codex', action: 'process' } }) }, executeInvocation: async () => retained });
  for (const [bridge, name, args] of [[claude, 'cuefluent_invocation', { handle: retained.handle }], [codex, 'cuefluent_control', { action: 'process' }]]) {
    const call = await protocol(bridge), response = await call(message(name, args));
    assert.equal(response.result.isError, true);
    const value = response.result.structuredContent;
    assert.equal(value.state, 'failed'); assert.equal(value.reason, retained.reason);
    assert.equal(value.error, retained.reason); assert.match(value.message, /drafting client/); assert.match(value.recovery, /retry with process/);
    assert.equal(value.diagnostics.pluginVersion, '0.17.1'); assert.equal(value.diagnostics.stage, 'result');
    assert.equal(value.diagnostics.toolName, name);
    assert.deepEqual(JSON.parse(response.result.content[0].text), value);
    assert.deepEqual(Object.keys(retained), ['state', 'reason', 'handle']);
  }
});

test('status explains warnings by the slot they belong to, so a completed run\'s warning is not a new error', async () => {
  const retained = { state: 'idle', warnings: [], latest: { status: 'saved', warnings: ['PROCESSING_CLIENT_FAILED'] }, run: null };
  const call = await protocol(createControlBridge({ client: 'claude', readInvocation: async () => retained }));
  const response = await call(message('cuefluent_invocation', { handle: 'a'.repeat(86) }));
  assert.equal(response.result.isError, false);
  const value = response.result.structuredContent;
  assert.equal(value.state, 'idle'); assert.equal(value.error, undefined);
  assert.deepEqual(value.latest, retained.latest); assert.equal(retained.warningDetails, undefined);
  assert.deepEqual(Object.keys(value.warningDetails[0]), ['scope', 'error', 'message', 'recovery']);
  assert.equal(value.warningDetails[0].scope, 'latest'); assert.equal(value.warningDetails[0].error, 'PROCESSING_CLIENT_FAILED');
  assert.match(value.warningDetails[0].recovery, /needs no retry/);
  assert.equal(value.warningDetailsTruncated, false);
  const current = presentControlResult({ state: 'idle', warnings: [], run: { phase: 'drafting', warnings: ['PROCESSING_ISOLATION_UNSUPPORTED'] } });
  assert.equal(current.warningDetails[0].scope, 'run'); assert.match(current.warningDetails[0].recovery, /Do not weaken isolation/);
  assert.equal(current.error, undefined);
});

test('completed outcomes advise no retry while a newer pending run keeps its own recovery', async () => {
  for (const status of ['saved', 'nothing-useful', 'skipped', 'empty']) {
    const warnings = ['PROCESSING_CLIENT_FAILED', 'PROCESSING_ISOLATION_UNSUPPORTED'];
    const outcome = validateResult({ schemaVersion: 1, runId: randomUUID(), projectId: 'synthetic', status,
      paths: status === 'saved' ? [path.join(os.tmpdir(), 'synthetic-note.md')] : [],
      counts: { handled: 1, saved: status === 'saved' ? 1 : 0, remaining: 3 }, warnings });
    const current = { warnings: ['PROCESSING_CLIENT_FAILED'], phase: 'drafting' };
    const snapshots = [
      [{ state: status, result: outcome }, 'result'],
      [{ state: 'idle', run: current, latest: outcome }, 'latest'],
    ];
    for (const [retained, scope] of snapshots) {
      const before = JSON.stringify(retained);
      const bridges = [
        [createControlBridge({ client: 'claude', readInvocation: async () => retained }), 'cuefluent_invocation', { handle: 'a'.repeat(86) }],
        [createControlBridge({ client: 'codex', codexAdapter: { bindCommand: async () => ({ status: 'ready', binding: { client: 'codex', action: 'status' } }) },
          executeInvocation: async () => retained }), 'cuefluent_control', { action: 'status' }],
      ];
      for (const [bridge, name, args] of bridges) {
        const response = await (await protocol(bridge))(message(name, args));
        assert.equal(response.result.isError, false);
        const value = response.result.structuredContent;
        const completed = value.warningDetails.filter(detail => detail.scope === scope);
        assert.equal(completed.length, warnings.length);
        for (const detail of completed) {
          assert.deepEqual(Object.keys(detail), ['scope', 'error', 'message', 'recovery']);
          assert.match(detail.recovery, /recorded by a run that has finished; it needs no retry/);
          assert.doesNotMatch(detail.recovery, /retry with process|sign-in|isolation/);
        }
        if (scope === 'latest') {
          const pending = value.warningDetails.find(detail => detail.scope === 'run');
          assert.match(pending.recovery, /retry with process/);
        }
        assert.deepEqual(JSON.parse(response.result.content[0].text), value);
        assert.equal(JSON.stringify(retained), before);
      }
    }
  }
});

test('result guidance stays bounded and expands only code-only warnings in known metadata slots', () => {
  const warnings = Array.from({ length: 30 }, (_, index) => `SYNTHETIC_${index}`);
  const value = presentControlResult({ state: 'idle', warnings, nested: { warnings: ['SYNTHETIC_PRIVATE'] } });
  assert.equal(value.warningDetails.length, 16); assert.equal(value.warningDetailsTruncated, true);
  assert.deepEqual(value.warnings, warnings);
  assert.equal(value.warningDetails.some(item => item.error === 'SYNTHETIC_PRIVATE'), false);
  const plain = { state: 'idle', warnings: ['Preserved explanatory warning.'] };
  assert.deepEqual(presentControlResult(plain), plain);
  const nearLimit = { state: 'idle', warnings: ['PROCESSING_CLIENT_FAILED'], padding: '' };
  nearLimit.padding = 'x'.repeat(CONTROL_LIMITS.responseBytes - Buffer.byteLength(JSON.stringify(nearLimit)) - 1);
  assert.deepEqual(presentControlResult(nearLimit), nearLimit);
});

test('trusted CLI and hook status retain valid large review snapshots while MCP keeps its response bound', () => {
  const options = { platform: 'posix' };
  const project = createProject({ id: 'work', root: '/projects/work', destination: { kind: 'directory', path: '/notes' }, activityLog: { enabled: false } }, options);
  const active = replaceAttempt(createRun(project, [{ client: 'codex', sessionId: 'native-session', recordId: 'exchange:part-1', hash: 'a'.repeat(64) }], options), randomUUID(), options);
  const drafts = Array.from({ length: 300 }, (_, index) => ({ id: randomUUID(), target: `/notes/note-${index}.md`, expectedHash: null, hash: 'b'.repeat(64),
    summary: 's'.repeat(1024), heading: 'Topic', byteLength: 100,
    binding: { root: '/notes', parent: [{ path: '/', device: '1', inode: '1' }, { path: '/notes', device: '1', inode: '2' }] } }));
  const run = readyForReview(publishDrafts(active, active.attempt.id, drafts, options), active.attempt.id, options);
  const retained = { projectId: project.id, state: 'review', settings: project,
    counts: { chats: 0, tracked: 0, optedOut: 0, queued: 0, pendingSources: 0, incomplete: false }, warnings: [], latest: null,
    run: { id: run.id, scope: run.scope, phase: run.phase, active: false, selected: run.selection.length, saved: 0,
      drafts: run.drafts.map(item => ({ target: item.target, summary: item.summary, heading: item.heading })), savedPaths: [], warnings: run.warnings } };
  assert.ok(Buffer.byteLength(JSON.stringify(run)) < 2 * 1024 * 1024);
  const original = JSON.stringify(retained);
  assert.ok(Buffer.byteLength(original) > CONTROL_LIMITS.responseBytes);
  assert.throws(() => presentControlResult(retained), { code: 'CONTROL_RESPONSE_LIMIT' });
  for (const operation of ['status', 'hook']) {
    assert.deepEqual(presentControlResult(retained, { operation }, { bounded: false }), retained);
    const withWarning = { ...retained, warnings: ['PROCESSING_CLIENT_FAILED'] };
    const { warningDetails, warningDetailsTruncated, ...presented } = presentControlResult(withWarning, { operation }, { bounded: false });
    assert.deepEqual(presented, withWarning);
    assert.equal(warningDetails[0].error, 'PROCESSING_CLIENT_FAILED');
    assert.equal(warningDetailsTruncated, false);
  }
  assert.equal(JSON.stringify(retained), original);
});

test('tool recovery uses the actual tool context without echoing supplied arguments', async () => {
  const bridge = createControlBridge({ client: 'claude', readInvocation: async () => ({ state: 'idle' }), directNotes: {
    tools: [{ name: 'cuefluent_read_note', inputSchema: { type: 'object' } }],
    call: async () => { throw Object.assign(new Error('synthetic-secret'), { code: 'ENOENT', path: 'synthetic-secret' }); },
  } });
  const call = await protocol(bridge), response = await call(message('cuefluent_read_note', { target: 'synthetic-secret' }));
  assert.equal(response.result.isError, true); assert.match(response.result.structuredContent.recovery, /configured paths exist/);
  assert.equal(response.result.structuredContent.diagnostics.toolName, 'cuefluent_read_note');
  assert.equal(JSON.stringify(response).includes('synthetic-secret'), false);
});

test('a closed diagnostic pipe cannot abort an in-flight publication or transport cleanup', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-diagnostic-pipe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/control-diagnostic-worker.mjs', import.meta.url)), root], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let output = '', stderr = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const signal = expected => new Promise((resolve, reject) => {
    const received = value => { if (value === expected) { child.off('message', received); child.off('exit', ended); resolve(); } };
    const ended = code => { child.off('message', received); reject(new Error(`Child exited before ${expected}: ${code}; ${stderr}`)); };
    child.on('message', received); child.once('exit', ended);
  });
  const started = signal('started');
  for (const frame of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    message('cuefluent_create_note'),
  ]) child.stdin.write(JSON.stringify(frame) + '\n');
  await started;
  child.stderr.destroy();
  const failure = signal('failure-observed');
  child.stdin.write('{invalid\n');
  await failure;
  child.send('finish');
  assert.equal(await exited, 1);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), '# Synthetic note\n');
  assert.equal(await fs.readFile(path.join(root, 'resources-closed'), 'utf8'), 'closed');
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.find(item => item.id === 2).result.structuredContent.state, 'saved');
});
