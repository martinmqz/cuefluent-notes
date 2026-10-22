import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createProject } from '../src/core/settings.mjs';
import { initializeStore } from '../src/storage/store.mjs';
import { readChat, selectChatQueue } from '../src/storage/chats.mjs';
import { handleNativeHook } from '../src/client/hooks.mjs';
import { createSyncRuntime } from '../src/sync/runtime.mjs';
import { launchSyncAttempt } from '../src/sync/ingress.mjs';

const sessionId = 'synthetic-unfinished', promptId = 'native-prompt';
const human = { type: 'user', sessionId, uuid: 'human', promptId, turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: 'Exact ordinary prompt.' } };
const tool = { type: 'assistant', sessionId, uuid: 'tool', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { exact: 'argument λ🙂' } }] } };
const output = (uuid, text) => ({ type: 'user', sessionId, uuid, promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: text }] } });
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-hook-completion-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const sourcePath = path.join(root, 'synthetic.jsonl'); await fs.writeFile(sourcePath, encode([human, tool, output('result', 'Exact partial tool output.')]));
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [createProject({ id: 'project', root: cwd,
    destination: { kind: 'directory', path: path.join(root, 'notes') }, tracking: 'auto' })] });
  const identity = { session_id: sessionId, cwd, transcript_path: sourcePath };
  const options = { clientContract: { name: 'notes:notes', skillPath: path.join(root, 'plugin', 'SKILL.md') }, schedule: async () => {} };
  const hook = input => handleNativeHook(store, 'claude', { ...identity, ...input }, options);
  await hook({ hook_event_name: 'SessionStart', source: 'startup' });
  const runtime = createSyncRuntime({ store }); t.after(() => runtime.close());
  const collect = () => runtime.collect({ client: 'claude', sessionId });
  const queue = () => selectChatQueue(store, 'project', 'claude', sessionId);
  return { root, store, sourcePath, hook, collect, queue };
}

test('production SessionEnd publishes only the exact observed unfinished prompt and retains late supplements without another human', async t => {
  const f = await fixture(t);
  assert.equal((await f.collect()).status, 'pending'); assert.equal((await f.queue()).length, 0);
  await f.hook({ hook_event_name: 'SessionEnd', prompt_id: 'another-prompt', reason: 'other' });
  assert.equal((await f.collect()).status, 'pending'); assert.equal((await f.queue()).length, 0);
  await f.hook({ hook_event_name: 'SessionEnd', prompt_id: promptId, reason: 'other' });
  assert.equal((await f.collect()).status, 'caught-up');
  let queue = await f.queue(); assert.equal(queue.length, 1); assert.equal(queue[0].data.outcome, 'observed');
  assert.equal(queue[0].data.segments.filter(segment => segment.kind === 'human').map(segment => segment.text).join(''), 'Exact ordinary prompt.');
  assert.equal(queue[0].data.segments.filter(segment => segment.kind === 'tool-result').map(segment => segment.text).join(''), 'Exact partial tool output.');
  await fs.appendFile(f.sourcePath, encode([output('late-result', 'Late supplement.')]));
  assert.equal((await f.collect()).status, 'caught-up'); queue = await f.queue();
  assert.equal(queue.length, 2); assert.equal(queue[1].data.supplement, true); assert.equal(queue[1].data.partIndex, 1);
  assert.equal(queue[1].data.segments.map(segment => segment.text).join(''), 'Late supplement.');
});

test('production SessionEnd retains stronger Stop final-text proof and StopFailure needs no native end_turn', async t => {
  const f = await fixture(t), finalText = 'Persisted final answer.';
  await f.hook({ hook_event_name: 'Stop', prompt_id: promptId, last_assistant_message: finalText });
  await f.hook({ hook_event_name: 'SessionEnd', prompt_id: promptId, reason: 'other' });
  const saved = await readChat(f.store, 'claude', sessionId);
  assert.equal(saved.value.pending.completion.kind, 'completed'); assert.equal(saved.value.pending.completion.finalTextHash, createHash('sha256').update(finalText).digest('hex'));
  assert.equal((await f.collect()).status, 'pending'); assert.equal((await f.queue()).length, 0);
  await fs.appendFile(f.sourcePath, encode([{ type: 'assistant', sessionId, uuid: 'final', message: { role: 'assistant', content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn' } }]));
  assert.equal((await f.collect()).status, 'caught-up');
  const failed = await fixture(t);
  await failed.hook({ hook_event_name: 'StopFailure', prompt_id: promptId, error: 'server_error', last_assistant_message: 'API error is not assistant output' });
  assert.equal((await failed.collect()).status, 'caught-up');
  const queue = await failed.queue(); assert.equal(queue.length, 1); assert.equal(queue[0].data.outcome, 'failed'); assert(!JSON.stringify(queue).includes('API error is not assistant output'));
});

test('collector IPC preserves bounded progress metadata and rejects a malformed progress flag', async () => {
  const options = { entry: path.resolve('entry.mjs'), storeRoot: path.resolve('private'), client: 'claude', sessionId };
  const spawn = progress => () => {
    const child = new EventEmitter(); child.kill = () => child.emit('close', 1);
    queueMicrotask(() => { child.emit('message', { status: 'pending', reason: 'TRANSCRIPT_SCAN_PENDING', parts: 0, progress }); if (progress === true) child.emit('close', 0); });
    return child;
  };
  assert.deepEqual(await launchSyncAttempt(options, { spawn: spawn(true) }), { status: 'pending', reason: 'TRANSCRIPT_SCAN_PENDING', parts: 0, progress: true });
  assert.deepEqual(await launchSyncAttempt(options, { spawn: spawn('true') }), { status: 'pending', reason: 'SYNC_COLLECTOR_FAILED', parts: 0 });
});
