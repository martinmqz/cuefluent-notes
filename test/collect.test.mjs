import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../src/core/settings.mjs';
import { stageChatPart, requestReconciliation } from '../src/core/chat.mjs';
import { initializeStore } from '../src/storage/store.mjs';
import { setChatTracking, readChat, updateChat, commitChatPart, selectChatQueue, queueRelative } from '../src/storage/chats.mjs';
import { appendQueueRecord, inspectQueue } from '../src/storage/queue.mjs';
import { normalizeTranscript } from '../src/transcript/index.mjs';
import { openTranscript } from '../src/client/source.mjs';
import { createHistoricalCommandClassifier } from '../src/client/historical-commands.mjs';
import { buildClaudeCommandContext } from '../src/client/history.mjs';
import { collectChat, transcriptPartRecord } from '../src/sync/collect.mjs';

const sessionId = 'synthetic-chat';
const human = (id, text = id) => ({ type: 'user', sessionId, uuid: id, promptId: id,
  turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: text } });
const assistant = (id, text = id) => ({ type: 'assistant', sessionId, uuid: id,
  message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
const bytes = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

async function fixture(t, rows = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-v2-collect-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const sourcePath = path.join(root, 'synthetic.jsonl'); await fs.writeFile(sourcePath, bytes(rows));
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [createProject({
    id: 'project', root: cwd, destination: { kind: 'directory', path: path.join(root, 'notes') },
  })] });
  const skillPath = path.join(root, 'plugin', 'skills', 'notes', 'SKILL.md');
  const classifyCommand = createHistoricalCommandClassifier({ client: 'claude', name: 'notes:notes', skillPath });
  const invocation = { client: 'claude', sessionId, promptId: 'track', action: 'track', cwd, sourcePath };
  const collect = extra => collectChat(store, { client: 'claude', sessionId, classifyCommand, ...extra });
  const selection = () => selectChatQueue(store, 'project', 'claude', sessionId);
  return { root, store, sourcePath, invocation, collect, selection, skillPath };
}

test('first track catches history; untrack catches only earlier data and later track resumes the paused interval', async t => {
  const f = await fixture(t, [human('before'), assistant('reply'), human('track')]);
  await setChatTracking(f.store, f.invocation);
  assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 1 });
  assert.equal((await f.selection())[0].data.exchangeId, 'before');
  // These are ordinary human messages mentioning command words; they remain
  // eligible because they lack native wrapper + expansion command provenance.
  await fs.appendFile(f.sourcePath, bytes([assistant('control-response'), human('between'), assistant('between-reply'), human('untrack'), assistant('untrack-reply'), human('later'), assistant('later-reply')]));
  await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'untrack' });
  assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 2 });
  assert.deepEqual((await f.selection()).map(record => record.data.exchangeId), ['before', 'track', 'between']);
  assert.deepEqual(await f.collect(), { status: 'untracked', parts: 0 });
  await fs.appendFile(f.sourcePath, bytes([human('retrack')]));
  await setChatTracking(f.store, { ...f.invocation, promptId: 'retrack' });
  assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 2 });
  assert.deepEqual((await f.selection()).map(record => record.data.exchangeId), ['before', 'track', 'between', 'untrack', 'later']);
});

test('untrack on a never-tracked chat never imports its history or creates a queue', async t => {
  const f = await fixture(t, [human('private-before'), assistant('private-answer'), human('untrack')]);
  const saved = await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'untrack' });
  assert.equal(saved.value.optOut, true); assert.equal(saved.value.pending, null);
  assert.deepEqual(await f.collect(), { status: 'untracked', parts: 0 });
  await assert.rejects(fs.stat(path.join(f.store.root, queueRelative('claude', sessionId))), { code: 'ENOENT' });
});

test('repeated untrack preserves the first final catch-up boundary and excludes later opted-out data', async t => {
  const f = await fixture(t, [human('before'), assistant('reply'), human('track')]);
  await setChatTracking(f.store, f.invocation); await f.collect();
  await fs.appendFile(f.sourcePath, bytes([assistant('track-answer'), human('while-tracked'), assistant('tracked-answer'), human('first-untrack')]));
  const first = await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'first-untrack' });
  await fs.appendFile(f.sourcePath, bytes([assistant('untrack-answer'), human('paused'), assistant('paused-answer'), human('second-untrack')]));
  const second = await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'second-untrack' });
  assert.deepEqual(second.value.pending, first.value.pending); await f.collect();
  const selected = await f.selection(); assert.equal(selected.some(item => item.data.exchangeId === 'paused'), false);
  await fs.appendFile(f.sourcePath, bytes([human('still-paused'), assistant('still-paused-answer'), human('third-untrack')]));
  const repeated = await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'third-untrack' });
  assert.equal(repeated.value.pending, null); assert.deepEqual(await f.collect(), { status: 'untracked', parts: 0 });
  assert.deepEqual(await f.selection(), selected);
});

test('durable append without bookmark is ineligible, then exact replay deduplicates and commits it', async t => {
  const f = await fixture(t, [human('before'), assistant('reply'), human('track')]);
  const source = await openTranscript(f.sourcePath); t.after(() => source.close());
  let saved = await setChatTracking(f.store, f.invocation, { source: { path: f.sourcePath, identity: source.identity } });
  let part;
  for await (const event of normalizeTranscript(source, { client: 'claude', sessionId, beforePromptId: 'track' })) {
    if (event.type === 'part') { part = event; break; }
  }
  const record = transcriptPartRecord(part.part), generation = saved.value.generation;
  saved = await updateChat(f.store, 'project', 'claude', sessionId, { expectedHash: saved.hash,
    change: chat => stageChatPart(chat, { generation, recordId: record.id, hash: record.hash, checkpoint: part.checkpoint }) });
  await appendQueueRecord(f.store.pin, queueRelative('claude', sessionId), record);
  assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', sessionId))).records, 1);
  assert.deepEqual(await f.selection(), []);
  const done = await f.collect();
  assert.deepEqual(done, { status: 'caught-up', parts: 1 });
  assert.equal((await f.selection()).length, 1);
  assert.equal((await readChat(f.store, 'claude', sessionId)).value.uncommitted, null);
  assert.deepEqual(await f.collect(), { status: 'pending', reason: 'TRANSCRIPT_COMPLETION_PENDING', parts: 0, progress: true });
  assert.deepEqual(await f.collect(), { status: 'pending', reason: 'TRANSCRIPT_COMPLETION_PENDING', parts: 0 });
  await assert.rejects(commitChatPart(f.store, 'project', 'claude', sessionId, {
    expectedHash: saved.hash, generation, checkpoint: part.checkpoint, record,
  }), { code: 'CHAT_CHANGED' });
});

test('missing source leaves committed input available and explicit opt-out intact', async t => {
  const f = await fixture(t, [human('before'), assistant('reply'), human('track')]);
  await setChatTracking(f.store, f.invocation); await f.collect();
  const stopped = await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'missing-command' });
  await fs.unlink(f.sourcePath);
  assert.deepEqual(await f.collect(), { status: 'pending', reason: 'SOURCE_UNAVAILABLE', parts: 0 });
  assert.equal((await f.selection()).length, 1);
  assert.equal((await readChat(f.store, 'claude', sessionId)).hash, stopped.hash);
});

test('native completion waits for persisted final reply without treating EOF as completion', async t => {
  const f = await fixture(t, [human('track')]);
  await setChatTracking(f.store, f.invocation); await f.collect();
  await fs.appendFile(f.sourcePath, bytes([assistant('track-reply'), human('work')]));
  let saved = await readChat(f.store, 'claude', sessionId);
  saved = await updateChat(f.store, 'project', 'claude', sessionId, { expectedHash: saved.hash,
    change: chat => requestReconciliation(chat, { promptId: 'work', kind: 'completed', finalTextHash: null }) });
  assert.equal((await f.collect()).reason, 'TRANSCRIPT_COMPLETION_PENDING');
  assert((await readChat(f.store, 'claude', sessionId)).value.pending);
  await fs.appendFile(f.sourcePath, bytes([assistant('final')]));
  assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 1 });
  assert.equal((await readChat(f.store, 'claude', sessionId)).value.pending, null);
});

test('fork command nonce collects ordinary inherited data while excluding copied controls with the same rewritten prompt ID', async t => {
  const f = await fixture(t), nonce = '10000000-0000-4000-8000-000000000001', oldNonce = '20000000-0000-4000-8000-000000000002';
  const command = (id, token) => [
    { ...human(id, '<command-message>notes:notes</command-message>\n<command-name>/notes:notes</command-name>\n<command-args>track</command-args>'), promptId: 'rewritten' },
    { type: 'user', sessionId, uuid: `expansion:${id}`, promptId: 'rewritten', parentUuid: id, isMeta: true, turnCompanion: true,
      message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(f.skillPath)}\n\nSynthetic instruction.` }] } },
    { type: 'attachment', sessionId, uuid: `context:${id}`, parentUuid: `expansion:${id}`, isSidechain: false,
      attachment: { type: 'hook_additional_context', hookName: 'UserPromptExpansion', hookEvent: 'UserPromptExpansion', content: [buildClaudeCommandContext(token)] } },
  ];
  const rows = [{ ...human('ordinary', 'Keep copied ordinary text'), promptId: 'rewritten' }, assistant('answer'), ...command('old-command', oldNonce), ...command('current-command', nonce)];
  await fs.writeFile(f.sourcePath, bytes(rows));
  await setChatTracking(f.store, { ...f.invocation, promptId: 'rewritten', commandNonce: nonce });
  assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 1 });
  const selected = await f.selection();
  assert.equal(selected.length, 1); assert.equal(selected[0].data.exchangeId, 'ordinary');
  assert(!JSON.stringify(selected).includes(nonce));
});

test('a bound control already passed by collection settles without rewinding or importing later bytes', async t => {
  for (const action of ['track']) {
    const f = await fixture(t, [human('first-track')]);
    await setChatTracking(f.store, { ...f.invocation, promptId: 'first-track' }); await f.collect();
    const wrapper = { ...human(`control-${action}`, `<command-message>notes:notes</command-message>\n<command-name>/notes:notes</command-name>\n<command-args>${action}</command-args>`) };
    const expansion = { type: 'user', sessionId, uuid: `expansion-${action}`, promptId: wrapper.promptId, parentUuid: wrapper.uuid,
      isMeta: true, turnCompanion: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(f.skillPath)}\n\nSynthetic instruction.` }] } };
    await fs.appendFile(f.sourcePath, bytes([assistant('first-answer'), human('work'), assistant('work-answer'), wrapper, expansion, assistant('control-answer')]));
    assert.equal((await f.collect()).status, 'caught-up');
    const prior = (await readChat(f.store, 'claude', sessionId)).value.checkpoint;
    const selected = await f.selection(); assert.equal(selected.some(item => item.data.exchangeId === wrapper.uuid), false);
    await setChatTracking(f.store, { ...f.invocation, action, promptId: wrapper.promptId });
    await fs.appendFile(f.sourcePath, bytes([human('after-control'), assistant('after-answer')]));
    assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 0 });
    const current = (await readChat(f.store, 'claude', sessionId)).value;
    assert.equal(current.pending, null); assert.equal(current.tracked, action === 'track');
    assert.equal(current.checkpoint.offset, prior.offset); assert.equal(current.checkpoint.exchange.id, prior.exchange.id);
    assert.deepEqual(current.checkpoint.anchor, prior.anchor);
    assert.deepEqual(await f.selection(), selected);
    if (action === 'track') { assert.equal((await f.collect()).status, 'caught-up'); assert.equal((await f.selection()).at(-1).data.exchangeId, 'after-control'); }
    else assert.deepEqual(await f.collect(), { status: 'untracked', parts: 0 });
  }
});


test('periodic collection stops at a verified untrack before its detached action commits', async t => {
  const f = await fixture(t, [human('first-track')]);
  await setChatTracking(f.store, { ...f.invocation, promptId: 'first-track' }); await f.collect();
  const command = human('untrack', '<command-message>notes:notes</command-message>\n<command-name>/notes:notes</command-name>\n<command-args>untrack</command-args>');
  const expansion = { type: 'user', sessionId, uuid: 'untrack-expansion', promptId: command.promptId, parentUuid: command.uuid,
    isMeta: true, turnCompanion: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(f.skillPath)}\n\nSynthetic instruction.` }] } };
  await fs.appendFile(f.sourcePath, bytes([assistant('first-answer'), human('work'), assistant('work-answer'), command, expansion,
    assistant('untrack-answer'), human('after-untrack'), assistant('after-answer')]));
  assert.equal((await f.collect()).reason, 'TRANSCRIPT_UNTRACK_PENDING');
  const selected = await f.selection(); assert.deepEqual(selected.map(item => item.data.exchangeId), ['first-track', 'work']);
  const checkpoint = (await readChat(f.store, 'claude', sessionId)).value.checkpoint;
  assert.equal((await f.collect()).reason, 'TRANSCRIPT_UNTRACK_PENDING');
  await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'untrack' });
  assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 0 });
  const chat = (await readChat(f.store, 'claude', sessionId)).value;
  assert.equal(chat.tracked, false); assert.equal(chat.pending, null); assert.equal(chat.checkpoint.offset, checkpoint.offset);
  assert.deepEqual(await f.selection(), selected);
  // A later explicit track authorizes the paused interval, while the old
  // untrack command and its response remain excluded.
  await fs.appendFile(f.sourcePath, bytes([human('track-again')]));
  await setChatTracking(f.store, { ...f.invocation, promptId: 'track-again' });
  assert.equal((await f.collect()).status, 'caught-up');
  assert.equal((await f.selection()).at(-1).data.exchangeId, 'after-untrack');
});

test('tracking change recovers the exact earlier append intent without abandoning selected input', async t => {
  const f = await fixture(t, [human('before'), assistant('reply'), human('track')]);
  const source = await openTranscript(f.sourcePath); t.after(() => source.close());
  let saved = await setChatTracking(f.store, f.invocation, { source: { path: f.sourcePath, identity: source.identity } });
  let part;
  for await (const event of normalizeTranscript(source, { client: 'claude', sessionId, beforePromptId: 'track' })) {
    if (event.type === 'part') { part = event; break; }
  }
  const record = transcriptPartRecord(part.part);
  await updateChat(f.store, 'project', 'claude', sessionId, { expectedHash: saved.hash,
    change: chat => stageChatPart(chat, { generation: chat.generation, recordId: record.id, hash: record.hash, checkpoint: part.checkpoint }) });
  await appendQueueRecord(f.store.pin, queueRelative('claude', sessionId), record);
  await fs.appendFile(f.sourcePath, bytes([assistant('track-answer'), human('untrack')]));
  await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'untrack' });
  assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 2 });
  saved = await readChat(f.store, 'claude', sessionId);
  assert.equal(saved.value.uncommitted, null); assert.equal(saved.value.pending, null); assert.equal(saved.value.tracked, false);
  assert.deepEqual((await f.selection()).map(item => item.data.exchangeId), ['before', 'track']);
  assert.equal((await inspectQueue(f.store.pin, queueRelative('claude', sessionId))).records, 2);
});

test('late repeated track preserves a streaming cursor and resumes exact selected text afterward', async t => {
  const f = await fixture(t, [human('initial-track')]);
  await setChatTracking(f.store, { ...f.invocation, promptId: 'initial-track' }); await f.collect();
  const control = human('repeat-track', '<command-message>notes:notes</command-message>\n<command-name>/notes:notes</command-name>\n<command-args>track</command-args>');
  const expansion = { type: 'user', sessionId, uuid: 'expanded-repeat', promptId: control.promptId, parentUuid: control.uuid,
    isMeta: true, turnCompanion: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(f.skillPath)}\n\nSynthetic instruction.` }] } };
  const content = 'Retain exact large ordinary text 🐢. '.repeat(6000);
  await fs.appendFile(f.sourcePath, bytes([assistant('initial-answer'), control, expansion, assistant('control-answer'), human('large', content), assistant('large-answer')]));
  assert.equal((await f.collect({ limits: { parts: 1 } })).parts, 1); // initial ordinary exchange
  assert.equal((await f.collect({ limits: { parts: 1 } })).parts, 1); // first large fragment
  const before = await readChat(f.store, 'claude', sessionId); assert.ok(before.value.checkpoint.cursor);
  const selected = await f.selection();
  await setChatTracking(f.store, { ...f.invocation, promptId: control.promptId });
  assert.deepEqual(await f.collect(), { status: 'caught-up', parts: 0 });
  assert.deepEqual((await readChat(f.store, 'claude', sessionId)).value.checkpoint.cursor, before.value.checkpoint.cursor);
  assert.deepEqual(await f.selection(), selected);
  assert.equal((await f.collect()).status, 'caught-up');
  const result = await f.selection();
  const restored = result.flatMap(item => item.data.exchangeId === 'large' ? item.data.segments.filter(segment => segment.kind === 'human').map(segment => segment.text) : []).join('');
  assert.equal(restored, content);
});
