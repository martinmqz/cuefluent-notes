import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { processingFixture } from './test-support/processing-fixture.mjs';
import { executeWorkflow } from './workflow.mjs';
import { runProcessingMcp } from './processing-mcp.mjs';
import { createClaudeProcessingClient } from './processing-client-claude.mjs';

async function launchFixture(t) {
  const f = await processingFixture(t, { client: 'claude' });
  const profile = path.join(f.root, 'claude-profile'); await fs.mkdir(profile);
  const environment = { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_SESSION_ID: f.identity.sessionId,
    CLAUDECODE: '1', 'CUEFLUENT_TEST(x86)': 'synthetic inherited value' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const calls = [], nativeSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    if (executable !== 'claude') return nativeSpawn(executable, args, options);
    calls.push({ args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const chunks = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
    child.stdin.on('finish', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const send = row => child.stdout.write(`${JSON.stringify(row)}\n`);
      send({ type: 'system', subtype: 'init', session_id: input.session_id,
        tools: args[args.indexOf('--allowedTools') + 1].split(','),
        mcp_servers: [{ name: 'cuefluent_engine', status: 'connected' }],
        permissionMode: 'dontAsk', slash_commands: [], skills: [], model: 'synthetic-model', claude_code_version: 'fixture' });
      send({ ...input, isReplay: true });
      send({ type: 'result', session_id: input.session_id, subtype: 'success', is_error: false,
        permission_denials: [], result: 'Synthetic processing finished.' });
      child.emit('close', 0, null);
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const assertLaunch = () => {
    assert.equal(calls.length, 1);
    const { args, options } = calls[0];
    assert.equal(options.shell, false);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, profile);
    assert.equal(options.env['CUEFLUENT_TEST(x86)'], environment['CUEFLUENT_TEST(x86)']);
    assert.equal(Object.hasOwn(options.env, 'CLAUDECODE'), false);
    assert.equal(process.env.CLAUDECODE, '1');
    assert.ok(options.env.CUEFLUENT_ENGINE_TOKEN);
    assert.equal(args.some(argument => argument.includes(options.env.CUEFLUENT_ENGINE_TOKEN)), false);
  };
  return { ...f, calls, assertLaunch };
}

test('CLI processing dispatches Claude with the default process environment', async t => {
  const f = await launchFixture(t);
  const request = { collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash,
    args: { client: 'claude', requestId: randomUUID(), selection: f.selection, expectedChatHash: null } };
  const result = await executeWorkflow('processing-chat-run', request, { configPath: f.options.configPath });
  assert.equal(result.state, 'idle'); assert.equal(result.nativeStatus, 'completed');
  // This fixture emits protocol frames, not a native session file or exclusion proof.
  assert.deepEqual(result.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
  f.assertLaunch();
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('MCP processing dispatches Claude with its default environment and completes its owned job', async t => {
  const f = await launchFixture(t), input = new PassThrough(), waiters = new Map();
  const output = new Writable({ write(chunk, _encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const row = JSON.parse(line); waiters.get(row.id)?.(row); waiters.delete(row.id);
    }
    done();
  } });
  const server = runProcessingMcp({ client: 'claude', configPath: f.options.configPath, input, output }, {
    // Native source binding is covered separately; this test retains the actual
    // MCP -> controller -> transport path and its default process.env throughout.
    async resolveInvocation() { return { selection: f.selection, callId: 'synthetic-environment-call', nativeSkill: false }; }
  });
  server.catch(() => {});
  t.after(async () => { input.end(); await server; });
  const send = row => {
    const response = new Promise(resolve => waiters.set(row.id, resolve));
    input.write(`${JSON.stringify(row)}\n`); return response;
  };
  const initialized = await send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
  assert.ok(initialized.result);
  const admitted = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'process_selected_captures', arguments: { collectionId: f.collection.id },
    _meta: { 'claudecode/toolUseId': 'synthetic-environment-call' } } });
  assert.equal(admitted.error, undefined);
  assert.equal(JSON.parse(admitted.result.content[0].text).status, 'busy');
  input.end(); await server;
  f.assertLaunch();
  const status = await executeWorkflow('processing-chat-status', {
    collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash, args: { client: 'claude' }
  }, { configPath: f.options.configPath });
  assert.equal(status.state, 'idle'); assert.equal(status.nativeStatus, 'completed');
  assert.deepEqual(status.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('custom Claude environments still require bounded plain string maps', () => {
  const options = { executable: 'claude', cwd: path.resolve('synthetic'), engine: { command: process.execPath, args: [] },
    allowedTools: ['mcp__cuefluent_engine__processing_pending'] };
  for (const env of [null, [], Object.create({ inherited: 'value' }), { INVALID: 1 }, { 'INVALID-NAME': 'value' },
    { LARGE: 'x'.repeat(32769) }, Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`KEY_${i}`, 'value']))]) {
    assert.throws(() => createClaudeProcessingClient({ ...options, env }));
  }
});
