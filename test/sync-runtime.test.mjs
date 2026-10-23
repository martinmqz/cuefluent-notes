import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncRuntime } from '../src/sync/runtime.mjs';
import { createCodexNativeAdapter } from '../src/client/codex-native.mjs';
import { createProject } from '../src/core/settings.mjs';
import { initializeStore } from '../src/storage/store.mjs';
import { setChatTracking, selectChatQueue, readChat, retainChatContract, updateChat } from '../src/storage/chats.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-sync-runtime-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [createProject({ id: 'project', root: cwd,
    destination: { kind: 'directory', path: path.join(root, 'notes') } })] });
  return { root, cwd, store, skillPath: path.join(root, 'plugin', 'skills', 'notes', 'SKILL.md'), entry: path.join(root, 'entry.mjs') };
}

test('runtime never substitutes a package classifier when stored client identity is missing', async t => {
  const f = await fixture(t);
  let opened = false;
  await setChatTracking(f.store, { client: 'codex', sessionId: 'synthetic', promptId: 'track', action: 'track', cwd: f.cwd, sourcePath: null });
  const runtime = createSyncRuntime({ ...f, clients: { codex: { name: 'current-executable', skillPath: f.skillPath } }, createCodexAdapter: () => { opened = true; assert.fail('Unexpected native reader'); } });
  assert.deepEqual(await runtime.collect({ client: 'codex', sessionId: 'synthetic' }), { status: 'pending', reason: 'CLIENT_CONTRACT_UNAVAILABLE', parts: 0 });
  assert.equal(opened, false); await runtime.close();
  await assert.rejects(runtime.collect({ client: 'claude', sessionId: 'synthetic' }), { code: 'SYNC_RUNTIME_CLOSED' });
});

test('runtime wires exact installed classifier and active-first Codex provider, closing each owned reader', async t => {
  const f = await fixture(t), file = path.join(f.root, 'native.jsonl'), id = 'synthetic', calls = [];
  const human = (turn, content, ordinal) => ({ type: 'event_msg', ordinal, payload: { type: 'item_completed', thread_id: id, turn_id: turn,
    item: { type: 'UserMessage', id: `human:${turn}`, content } } });
  const rows = [ { type: 'session_meta', ordinal: 0, payload: { id } }, human('ordinary', [{ type: 'text', text: 'Useful input', text_elements: [] }], 1),
    { type: 'response_item', ordinal: 2, payload: { type: 'message', id: 'answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Useful reply' }] } },
    { type: 'event_msg', ordinal: 3, payload: { type: 'task_complete' } },
    human('track', [{ type: 'skill', name: 'notes', path: f.skillPath }, { type: 'text', text: 'track', text_elements: [] }], 4) ];
  await fs.writeFile(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  await setChatTracking(f.store, { client: 'codex', sessionId: id, promptId: 'track', action: 'track', cwd: f.cwd, sourcePath: file,
    clientContract: { name: 'notes', skillPath: f.skillPath } });
  let opened = 0, closed = 0;
  // This executable belongs to the other installed package. Its identity must
  // never substitute for the selected Codex chat's retained installed identity.
  const runtime = createSyncRuntime({ ...f, clients: { claude: { name: 'notes:notes', skillPath: path.join(f.root, 'other-package', 'SKILL.md') } }, createCodexAdapter: () => {
    opened++;
    const adapter = createCodexNativeAdapter({ request: async (method, params) => { calls.push({ method, params });
      if (method === 'thread/turns/list') return { data: [{ id: 'track', itemsView: 'notLoaded', items: [], status: 'completed' }] };
      assert.equal(method, 'thread/read');
      return { thread: { id, path: file, cwd: f.cwd, turns: [], parentThreadId: null } }; } });
    return { resolveNativeSource: input => adapter.resolveNativeSource(input), close: async () => { closed++; await adapter.close(); } };
  } });
  assert.deepEqual(await runtime.collect({ client: 'codex', sessionId: id }), { status: 'caught-up', parts: 1 });
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(calls[0].method, 'thread/read'); assert.equal(calls[0].params.includeTurns, false);
  const queue = await selectChatQueue(f.store, 'project', 'codex', id); assert.equal(queue.length, 1); assert.equal(queue[0].data.exchangeId, 'human:ordinary');
  await runtime.collect({ client: 'codex', sessionId: id }); assert.equal(opened, 2); assert.equal(closed, 2);
  await runtime.close();
});

test('relocated Claude package retains historic command exclusion and missing/overflow proof stays pending', async t => {
  const f = await fixture(t), sessionId = 'claude-synthetic', file = path.join(f.root, 'claude.jsonl');
  const first = { name: 'notes:notes', skillPath: f.skillPath }, second = { ...first, skillPath: path.join(f.root, 'relocated', 'SKILL.md') };
  const human = id => ({ type: 'user', sessionId, uuid: id, promptId: id, turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: id } });
  const reply = id => ({ type: 'assistant', sessionId, uuid: `answer:${id}`, message: { role: 'assistant', content: [{ type: 'text', text: `reply:${id}` }], stop_reason: 'end_turn' } });
  const pair = (id, contract) => [{ ...human(id), message: { role: 'user', content: `<command-message>${contract.name}</command-message>\n<command-name>/${contract.name}</command-name>\n<command-args>status</command-args>` } },
    { type: 'user', sessionId, uuid: `expanded:${id}`, promptId: id, parentUuid: id, isMeta: true, turnCompanion: true,
      message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(contract.skillPath)}\n\nInstalled instructions` }] } }];
  await fs.writeFile(file, [human('useful'), reply('useful'), ...pair('old-command', first), reply('old-command'),
    ...pair('new-command', second), reply('new-command'), human('track-current')].map(row => JSON.stringify(row) + '\n').join(''));
  const invocation = { client: 'claude', sessionId, promptId: 'initial', action: 'track', cwd: f.cwd, sourcePath: file, clientContract: first };
  await setChatTracking(f.store, invocation);
  await retainChatContract(f.store, { ...invocation, action: 'process project', clientContract: second });
  await setChatTracking(f.store, { ...invocation, promptId: 'track-current', clientContract: second });
  const runtime = createSyncRuntime({ ...f, clients: { codex: { name: 'wrong-package', skillPath: path.join(f.root, 'wrong', 'SKILL.md') } } });
  assert.deepEqual(await runtime.collect({ client: 'claude', sessionId }), { status: 'caught-up', parts: 1 });
  assert.deepEqual((await selectChatQueue(f.store, 'project', 'claude', sessionId)).map(row => row.data.exchangeId), ['useful']);
  let saved = await readChat(f.store, 'claude', sessionId); assert.deepEqual(saved.value.clientContracts, [first, second]);
  const unchanged = await retainChatContract(f.store, { ...invocation, action: 'status', clientContract: { ...first, skillPath: path.join(f.root, 'status', 'SKILL.md') } });
  assert.equal(unchanged, null); assert.equal((await readChat(f.store, 'claude', sessionId)).hash, saved.hash);
  await assert.rejects(updateChat(f.store, 'project', 'claude', sessionId, { expectedHash: saved.hash, change: chat => ({ ...chat, clientContracts: [] }) }), { code: 'CLIENT_CONTRACT_CHANGED' });
  for (let index = 2; index < 8; index++) await retainChatContract(f.store, { ...invocation, action: 'process', clientContract: { ...first, skillPath: path.join(f.root, `package-${index}`, 'SKILL.md') } });
  saved = await setChatTracking(f.store, { ...invocation, action: 'untrack', promptId: 'stop', clientContract: { ...first, skillPath: path.join(f.root, 'ninth', 'SKILL.md') } });
  assert.equal(saved.value.optOut, true); assert.equal(saved.value.tracked, false); assert.equal(saved.value.clientContracts.length, 8); assert.equal(saved.value.clientContractOverflow, true);
  assert.deepEqual(await runtime.collect({ client: 'claude', sessionId }), { status: 'pending', reason: 'CLIENT_CONTRACT_LIMIT', parts: 0 });
  await runtime.close();
});

test('runtime schedules only detached Node steward and routes collector attempts separately', async t => {
  const f = await fixture(t), calls = [], controller = new AbortController();
  const runtime = createSyncRuntime({ ...f, signal: controller.signal,
    launchSteward: async input => { calls.push(input); return { status: 'launched' }; },
    launchAttempt: async input => { calls.push(input); assert.fail('No tracked chat may launch collection'); } });
  assert.deepEqual(await runtime.schedule(), { status: 'launched' }); assert.deepEqual(calls, [{ entry: f.entry, storeRoot: f.store.root }]);
  assert.deepEqual(await runtime.steward(), { status: 'settled' }); assert.equal(calls.length, 1); await runtime.close();
});
