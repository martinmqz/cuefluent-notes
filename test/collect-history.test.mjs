import test from 'node:test';
import { readProjectStatus } from '../src/control/status.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProject } from '../src/core/settings.mjs';
import { initializeStore } from '../src/storage/store.mjs';
import { readChat, setChatTracking, selectChatQueue, updateChat } from '../src/storage/chats.mjs';
import { openTranscript } from '../src/client/source.mjs';
import { createHistoricalCommandClassifier } from '../src/client/historical-commands.mjs';
import { collectChat } from '../src/sync/collect.mjs';
import { inspectNativeRow } from '../src/transcript/index.mjs';
import { createCodexNativeAdapter } from '../src/client/codex-native.mjs';

const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const history = mode => ({ mode, startSource: 'fork', inheritedBoundary: null });
const header = (id, ordinal = 0, base = null) => ({ type: 'session_meta', ordinal, payload: { id, history_mode: 'paginated', ...(base ? {
  history_base: base, ...(base.thread_id !== id ? { forked_from_id: base.thread_id, forked_from_ordinal_exclusive: base.end_ordinal_exclusive } : {}),
} : {}) } });
const human = (sessionId, id, ordinal, text = id) => ({ type: 'event_msg', ordinal, payload: { type: 'item_completed', thread_id: sessionId, turn_id: id,
  item: { type: 'UserMessage', id: `human:${id}`, content: [{ type: 'text', text, text_elements: [] }] } } });
const reply = (id, ordinal) => ({ type: 'response_item', ordinal, payload: { type: 'message', id: `answer:${id}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `Reply ${id}` }] } });
const done = ordinal => ({ type: 'event_msg', ordinal, payload: { type: 'task_complete' } });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-history-collect-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [createProject({ id: 'project', root: cwd,
    destination: { kind: 'directory', path: path.join(root, 'notes') } })] });
  const skillPath = path.join(root, 'plugin', 'skills', 'notes', 'SKILL.md');
  const classifyCommand = createHistoricalCommandClassifier({ client: 'codex', name: 'notes', skillPath });
  const control = (sessionId, id, ordinal, action) => {
    const row = human(sessionId, id, ordinal, action); row.payload.item.content.push({ type: 'skill', name: 'notes', path: skillPath }); return row;
  };
  const invoke = (sessionId, sourcePath, action = 'track', promptId = 'track') => ({ client: 'codex', sessionId, cwd, sourcePath, action, promptId });
  const selection = sessionId => selectChatQueue(store, 'project', 'codex', sessionId);
  const collect = (sessionId, options = {}) => collectChat(store, { client: 'codex', sessionId, classifyCommand, ...options });
  return { root, cwd, store, control, invoke, selection, collect };
}

test('manual Codex fork collects the exact parent prefix through a trusted active-first native source provider', async t => {
  const f = await fixture(t), parentFile = path.join(f.root, 'parent.jsonl'), childFile = path.join(f.root, 'child.jsonl');
  const inherited = [header('parent'), human('parent', 'inherited', 1), reply('inherited', 2), done(3)], cutoff = Buffer.byteLength(encode(inherited));
  await fs.writeFile(parentFile, encode([...inherited, human('parent', 'EXCLUDED-parent-future', 4), reply('future', 5)]));
  await fs.writeFile(childFile, encode([header('child', 4, { thread_id: 'parent', end_ordinal_exclusive: 4, end_byte_offset: cutoff }),
    human('child', 'new-child', 5), reply('new-child', 6), done(7), f.control('child', 'track', 8, 'track')]));
  await setChatTracking(f.store, f.invoke('child', childFile), { history: history('manual') });
  assert.deepEqual(await f.collect('child'), { status: 'pending', reason: 'HISTORY_SOURCE_UNAVAILABLE', parts: 0 });
  const requests = [], resolveNativeSource = async request => {
    requests.push(request); const file = request.sessionId === 'parent' ? parentFile : childFile;
    return { path: file, source: await openTranscript(file) };
  };
  assert.deepEqual(await f.collect('child', { resolveNativeSource }), { status: 'caught-up', parts: 2 });
  assert.equal(requests[0].before, null); assert.equal(requests[0].sessionId, 'child');
  assert.deepEqual(requests[1].before, { ordinalExclusive: 4, byteOffset: cutoff }); assert.equal(requests[1].sessionId, 'parent');
  assert.deepEqual((await f.selection('child')).map(record => record.data.exchangeId), ['human:inherited', 'human:new-child']);
  const saved = await readChat(f.store, 'codex', 'child'); assert.equal(saved.value.history.startSource, 'fork'); assert.equal(saved.value.checkpoint.boundary, null);
});

test('automatic fork omission remains stable across resume and explicit untrack/retrack without opening the parent', async t => {
  const f = await fixture(t), file = path.join(f.root, 'child.jsonl');
  const inherited = [header('parent'), human('parent', 'NEVER-import-parent', 1), reply('inherited', 2), done(3)];
  const base = { thread_id: 'parent', end_ordinal_exclusive: 4, end_byte_offset: Buffer.byteLength(encode(inherited)) };
  await fs.writeFile(file, encode([header('child', 4, base), human('child', 'first-child', 5), reply('first-child', 6), done(7), f.control('child', 'track', 8, 'track')]));
  await setChatTracking(f.store, f.invoke('child', file), { history: history('automatic') });
  const resolveNativeSource = async request => { assert.equal(request.before, null); assert.equal(request.sessionId, 'child'); return { path: file, source: await openTranscript(file) }; };
  assert.deepEqual(await f.collect('child', { resolveNativeSource }), { status: 'caught-up', parts: 1 });
  await fs.appendFile(file, encode([human('child', 'resumed-child', 9), reply('resumed-child', 10), done(11)]));
  assert.deepEqual(await f.collect('child', { resolveNativeSource }), { status: 'caught-up', parts: 1 });
  await fs.appendFile(file, encode([f.control('child', 'untrack', 12, 'untrack'), human('child', 'paused-child', 13), reply('paused-child', 14), done(15)]));
  await setChatTracking(f.store, f.invoke('child', file, 'untrack', 'untrack')); await f.collect('child', { resolveNativeSource });
  await fs.appendFile(file, encode([f.control('child', 'track-again', 16, 'track')]));
  await setChatTracking(f.store, f.invoke('child', file, 'track', 'track-again'), { history: history('manual') });
  assert.deepEqual(await f.collect('child', { resolveNativeSource }), { status: 'caught-up', parts: 1 });
  const saved = await readChat(f.store, 'codex', 'child'); assert.equal(saved.value.history.mode, 'automatic');
  assert.deepEqual((await f.selection('child')).map(record => record.data.exchangeId), ['human:first-child', 'human:resumed-child', 'human:paused-child']);
  await assert.rejects(updateChat(f.store, 'project', 'codex', 'child', { expectedHash: saved.hash, change: chat => ({ ...chat, history: history('manual') }) }), { code: 'CHAT_HISTORY_CHANGED' });
});

test('native replacement preserves immediate opt-out, blocks old-source collection, and reanchors an exact retained prefix', async t => {
  const f = await fixture(t), oldFile = path.join(f.root, 'old-active.jsonl'), activeFile = path.join(f.root, 'new-active.jsonl');
  const prefix = [header('same'), human('same', 'before', 1), reply('before', 2), done(3)], cutoff = Buffer.byteLength(encode(prefix));
  await fs.writeFile(oldFile, encode([...prefix, f.control('same', 'track', 4, 'track'), human('same', 'REVERTED', 5), reply('REVERTED', 6), done(7)]));
  await setChatTracking(f.store, f.invoke('same', oldFile)); await f.collect('same');
  const before = await readChat(f.store, 'codex', 'same');
  await fs.writeFile(activeFile, encode([header('same', 4, { thread_id: 'same', end_ordinal_exclusive: 4, end_byte_offset: cutoff }),
    human('same', 'new-active', 5), reply('new-active', 6), done(7), f.control('same', 'untrack', 8, 'untrack')]));
  const stopped = await setChatTracking(f.store, f.invoke('same', activeFile, 'untrack', 'untrack'));
  assert.equal(stopped.value.optOut, true); assert.equal(stopped.value.source.path, oldFile); assert.equal(stopped.value.sourceCandidate.path, activeFile);
  assert.deepEqual(await f.collect('same'), { status: 'pending', reason: 'SOURCE_TRANSITION_PENDING', parts: 0 });
  assert.equal((await readChat(f.store, 'codex', 'same')).hash, stopped.hash);
  const requests = [], resolveNativeSource = async request => {
    requests.push(request); const file = request.before ? oldFile : activeFile; return { path: file, source: await openTranscript(file) };
  };
  assert.deepEqual(await f.collect('same', { resolveNativeSource }), { status: 'caught-up', parts: 1 });
  assert.equal(requests[0].before, null); assert.equal(requests[0].candidate.path, activeFile); assert.equal(requests[1].before.byteOffset, cutoff);
  const after = await readChat(f.store, 'codex', 'same');
  assert.equal(after.value.source.path, activeFile); assert.equal(after.value.sourceCandidate, null); assert.equal(after.value.optOut, true); assert.equal(after.value.pending, null);
  assert.equal(after.value.history.mode, before.value.history.mode);
  assert.deepEqual((await f.selection('same')).map(record => record.data.exchangeId), ['human:before', 'human:new-active']);
});

test('missing retained native anchor preserves bookmark, source binding and existing committed input', async t => {
  const f = await fixture(t), oldFile = path.join(f.root, 'old.jsonl'), replaced = path.join(f.root, 'replacement.jsonl');
  await fs.writeFile(oldFile, encode([header('same'), human('same', 'before', 1), reply('before', 2), done(3), f.control('same', 'track', 4, 'track')]));
  await setChatTracking(f.store, f.invoke('same', oldFile)); await f.collect('same');
  const before = await readChat(f.store, 'codex', 'same');
  await fs.writeFile(replaced, encode([header('same'), human('same', 'different', 1), reply('different', 2)]));
  assert.deepEqual(await f.collect('same', { resolveNativeSource: async () => ({ path: replaced, source: await openTranscript(replaced) }) }), { status: 'pending', reason: 'HISTORY_ANCHOR_MISSING', parts: 0 });
  const after = await readChat(f.store, 'codex', 'same'); assert.equal(after.hash, before.hash); assert.deepEqual(after.value.checkpoint, before.value.checkpoint);
  assert.equal((await f.selection('same')).length, 1);
});

test('same-ID revert remains collectable by fresh production adapters and pins the inherited prefix hash', async t => {
  const f = await fixture(t), old = path.join(f.root, 'old.jsonl'), active = path.join(f.root, 'reverted.jsonl');
  const prefix = [header('same'), human('same', 'before', 1), reply('before', 2), done(3)], cutoff = Buffer.byteLength(encode(prefix));
  await fs.writeFile(old, encode([...prefix, f.control('same', 'track', 4, 'track')]));
  await setChatTracking(f.store, f.invoke('same', old)); await f.collect('same');
  await fs.writeFile(active, encode([header('same', 4, { thread_id: 'same', end_ordinal_exclusive: 4, end_byte_offset: cutoff }), human('same', 'after-revert', 5), reply('after-revert', 6), done(7)]));
  const collect = async () => {
    const adapter = createCodexNativeAdapter({ request: async (method, params) => {
      assert.equal(params.threadId, 'same');
      if (method === 'thread/turns/list') return { data: [{ id: 'later', status: 'completed', itemsView: 'notLoaded', items: [] }] };
      assert.equal(method, 'thread/read');
      return { thread: { id: 'same', cwd: f.cwd, path: active, turns: [] } };
    } });
    try { return await f.collect('same', { resolveNativeSource: input => adapter.resolveNativeSource(input) }); } finally { await adapter.close(); }
  };
  assert.deepEqual(await collect(), { status: 'caught-up', parts: 1 });
  let saved = await readChat(f.store, 'codex', 'same'); assert.equal(saved.value.source.path, active); assert.equal(saved.value.historySources[0].source.path, old);
  await fs.appendFile(active, encode([human('same', 'later', 8), reply('later', 9), done(10)]));
  assert.deepEqual(await collect(), { status: 'caught-up', parts: 1 });
  assert.deepEqual((await f.selection('same')).map(item => item.data.exchangeId), ['human:before', 'human:after-revert', 'human:later']);
  saved = await readChat(f.store, 'codex', 'same');
  await fs.writeFile(old, (await fs.readFile(old, 'utf8')).replace('Reply before', 'WRONG before'));
  assert.equal((await collect()).reason, 'HISTORY_SOURCE_CHANGED'); assert.equal((await readChat(f.store, 'codex', 'same')).hash, saved.hash);
});

test('native failed/interrupted Codex status closes the latest unfinished exchange and late output becomes a supplement', async t => {
  for (const kind of ['failed', 'interrupted']) {
    const f = await fixture(t), file = path.join(f.root, `${kind}.jsonl`), sessionId = `chat-${kind}`;
    await fs.writeFile(file, encode([header(sessionId), f.control(sessionId, 'track', 1, 'track')]));
    await setChatTracking(f.store, f.invoke(sessionId, file)); await f.collect(sessionId);
    await fs.appendFile(file, encode([human(sessionId, 'unfinished', 2), { type: 'response_item', ordinal: 3,
      payload: { type: 'function_call', id: 'tool-row', call_id: 'tool-call', name: 'synthetic', arguments: '{"query":"retained"}' } }]));
    const collect = async () => {
      const adapter = createCodexNativeAdapter({ request: async method => method === 'thread/read'
        ? { thread: { id: sessionId, cwd: f.cwd, path: file, turns: [] } }
        : { data: [{ id: 'unfinished', status: kind, itemsView: 'notLoaded', items: [] }] } });
      try { return await f.collect(sessionId, { resolveNativeSource: input => adapter.resolveNativeSource(input) }); } finally { await adapter.close(); }
    };
    const result = await collect(); assert.equal(result.status, 'caught-up'); assert.ok(result.parts > 0);
    let selected = await f.selection(sessionId); assert.equal(selected.at(-1).data.exchangeId, 'human:unfinished');
    assert.match(JSON.stringify(selected), /retained/);
    await fs.appendFile(file, encode([{ type: 'response_item', ordinal: 4, payload: { type: 'function_call_output', id: 'tool-result-row', call_id: 'tool-call', output: 'late synthetic result' } }]));
    const supplement = await collect(); assert.equal(supplement.status, 'caught-up', JSON.stringify(supplement)); selected = await f.selection(sessionId);
    assert.match(JSON.stringify(selected.at(-1).data), /late synthetic result/); assert.equal(selected.at(-1).data.supplement, true);
  }
});

test('Claude automatic fork with unknown inherited boundary stays pending across manual retrack', async t => {
  const f = await fixture(t), file = path.join(f.root, 'claude.jsonl'), sessionId = 'claude-fork';
  await fs.writeFile(file, encode([{ type: 'user', sessionId, uuid: 'inherited', promptId: 'rewritten', turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: 'Inherited ordinary text' } }]));
  const invocation = { client: 'claude', sessionId, sourcePath: file, cwd: f.cwd, action: 'track', promptId: 'rewritten' };
  await setChatTracking(f.store, invocation, { history: history('automatic') });
  const classifyCommand = createHistoricalCommandClassifier({ client: 'claude', name: 'notes:notes', skillPath: path.join(f.root, 'plugin', 'SKILL.md') });
  assert.deepEqual(await collectChat(f.store, { client: 'claude', sessionId, classifyCommand }), { status: 'pending', reason: 'HISTORY_INHERITED_BOUNDARY_UNKNOWN', parts: 0 });
  await setChatTracking(f.store, invocation, { history: history('manual') });
  assert.equal((await readChat(f.store, 'claude', sessionId)).value.history.mode, 'automatic');
  const before = (await readChat(f.store, 'claude', sessionId)).hash;
  const status = await readProjectStatus(f.store, 'project', { chat: { client: 'claude', sessionId } });
  assert.ok(status.warnings.includes('HISTORY_INHERITED_BOUNDARY_UNKNOWN'));
  assert.equal((await readChat(f.store, 'claude', sessionId)).hash, before);
  assert.equal((await selectChatQueue(f.store, 'project', 'claude', sessionId)).length, 0);
});

test('verified Claude automatic inherited prefix stays excluded on resumed collection and later explicit track', async t => {
  const f = await fixture(t), file = path.join(f.root, 'known-claude-fork.jsonl'), sessionId = 'known-claude-fork';
  const user = id => ({ type: 'user', sessionId, uuid: id, promptId: id, turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: `Prompt ${id}` } });
  const answer = id => ({ type: 'assistant', sessionId, uuid: `answer:${id}`, message: { role: 'assistant', content: [{ type: 'text', text: `Answer ${id}` }], stop_reason: 'end_turn' } });
  const inherited = [user('inherited'), answer('inherited')], prefix = Buffer.from(encode(inherited));
  await fs.writeFile(file, encode([...inherited, user('new-child'), answer('new-child'), user('track')]));
  const physical = await openTranscript(file), first = await inspectNativeRow(physical, 0), last = await inspectNativeRow(physical, first.end); await physical.close();
  const policy = { ...history('automatic'), inheritedBoundary: { endByteOffset: prefix.length, hash: createHash('sha256').update(prefix).digest('hex'),
    anchor: { start: last.start, end: last.end, hash: last.hash, rowId: 'answer:inherited' } } };
  const invocation = { client: 'claude', sessionId, sourcePath: file, cwd: f.cwd, action: 'track', promptId: 'track' };
  await setChatTracking(f.store, invocation, { history: policy });
  const classifyCommand = createHistoricalCommandClassifier({ client: 'claude', name: 'notes:notes', skillPath: path.join(f.root, 'plugin', 'SKILL.md') });
  const collect = () => collectChat(f.store, { client: 'claude', sessionId, classifyCommand });
  assert.deepEqual(await collect(), { status: 'caught-up', parts: 1 });
  await fs.appendFile(file, encode([answer('track'), user('later-child'), answer('later-child'), user('track-again')]));
  await setChatTracking(f.store, { ...invocation, promptId: 'track-again' }, { history: history('manual') });
  assert.deepEqual(await collect(), { status: 'caught-up', parts: 2 });
  const selected = await selectChatQueue(f.store, 'project', 'claude', sessionId);
  assert.deepEqual(selected.map(item => item.data.exchangeId), ['new-child', 'track', 'later-child']);
  assert.deepEqual((await readChat(f.store, 'claude', sessionId)).value.history, policy);
});

test('trusted automatic fork inheritance may settle once at the untouched bookmark after exact source-prefix verification', async t => {
  const f = await fixture(t), file = path.join(f.root, 'late-proof.jsonl'), sessionId = 'late-proof';
  const user = id => ({ type: 'user', sessionId, uuid: id, promptId: id, turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: id } });
  const answer = id => ({ type: 'assistant', sessionId, uuid: `answer:${id}`, message: { role: 'assistant', content: [{ type: 'text', text: id }], stop_reason: 'end_turn' } });
  const prefix = Buffer.from(encode([user('inherited'), answer('inherited')]));
  await fs.writeFile(file, Buffer.concat([prefix, Buffer.from(encode([user('child'), answer('child'), user('track')]))]));
  await setChatTracking(f.store, { client: 'claude', sessionId, cwd: f.cwd, sourcePath: file, action: 'track', promptId: 'track' }, { history: history('automatic') });
  const classifyCommand = createHistoricalCommandClassifier({ client: 'claude', name: 'notes:notes', skillPath: path.join(f.root, 'plugin', 'SKILL.md') });
  const collect = options => collectChat(f.store, { client: 'claude', sessionId, classifyCommand, ...options });
  assert.equal((await collect()).reason, 'HISTORY_INHERITED_BOUNDARY_UNKNOWN');
  const physical = await openTranscript(file), first = await inspectNativeRow(physical, 0), last = await inspectNativeRow(physical, first.end); await physical.close();
  const inheritedBoundary = { endByteOffset: prefix.length, hash: createHash('sha256').update(prefix).digest('hex'), anchor: { start: last.start, end: last.end, hash: last.hash, rowId: 'answer:inherited' } };
  const before = await readChat(f.store, 'claude', sessionId);
  assert.equal((await collect({ resolveNativeSource: async () => ({ path: file, source: await openTranscript(file), inheritedBoundary: { ...inheritedBoundary, hash: 'a'.repeat(64) } }) })).reason, 'HISTORY_BOUNDARY_INVALID');
  assert.equal((await readChat(f.store, 'claude', sessionId)).hash, before.hash);
  assert.deepEqual(await collect({ resolveNativeSource: async () => ({ path: file, source: await openTranscript(file), inheritedBoundary }) }), { status: 'caught-up', parts: 1 });
  const settled = await readChat(f.store, 'claude', sessionId); assert.deepEqual(settled.value.history.inheritedBoundary, inheritedBoundary);
  assert.deepEqual((await selectChatQueue(f.store, 'project', 'claude', sessionId)).map(record => record.data.exchangeId), ['child']);
  assert.equal((await collect({ resolveNativeSource: async () => ({ path: file, source: await openTranscript(file), inheritedBoundary: { ...inheritedBoundary, hash: 'b'.repeat(64) } }) })).reason, 'CHAT_HISTORY_CHANGED');
  assert.equal((await readChat(f.store, 'claude', sessionId)).hash, settled.hash);
});
