import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProject } from '../src/core/settings.mjs';
import { initializeStore, readSettings, updateSettings, gateOptions } from '../src/storage/store.mjs';
import { readChat, setChatTracking, selectChatQueue } from '../src/storage/chats.mjs';
import { handleNativeHook } from '../src/client/hooks.mjs';
import { collectChat } from '../src/sync/collect.mjs';
import { openTranscript } from '../src/client/source.mjs';
import { tryAcquireExistingGate } from '../src/storage/gates.mjs';
import { readProjectStatus } from '../src/control/status.mjs';
import { describeFailure } from '../src/diagnostics.mjs';

const sessionId = 'existing-synthetic-chat';
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
async function fixture(t, client, tracking = 'auto') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-auto-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const sourcePath = path.join(root, 'native.jsonl'); let ordinal = 1;
  const human = id => client === 'claude' ? { type: 'user', sessionId, uuid: `human:${id}`, promptId: id,
    message: { role: 'user', content: `Prompt ${id}` } } : { type: 'event_msg', ordinal: ordinal++, payload: {
      type: 'item_completed', thread_id: sessionId, turn_id: id, item: { type: 'UserMessage', id: `human:${id}`,
        content: [{ type: 'text', text: `Prompt ${id}`, text_elements: [] }] } } };
  const answer = id => client === 'claude' ? [{ type: 'assistant', sessionId, uuid: `answer:${id}`,
    message: { role: 'assistant', content: [{ type: 'text', text: `Answer ${id}` }], stop_reason: 'end_turn' } }] : [
    { type: 'response_item', ordinal: ordinal++, payload: { type: 'message', id: `answer:${id}`, role: 'assistant',
      phase: 'final_answer', content: [{ type: 'output_text', text: `Answer ${id}` }] } },
    { type: 'event_msg', ordinal: ordinal++, payload: { type: 'task_complete' } }];
  const header = client === 'codex' ? [{ type: 'session_meta', ordinal: 0, payload: { id: sessionId, history_mode: 'paginated' } }] : [];
  // The conversation exists before project setup, including completed history.
  await fs.writeFile(sourcePath, encode([...header, human('old'), ...answer('old')]));
  const project = createProject({ id: 'project', root: cwd, destination: { kind: 'directory', path: path.join(root, 'notes') }, tracking });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  let scheduled = 0;
  const hook = input => handleNativeHook(store, client, { session_id: sessionId, cwd, transcript_path: sourcePath, ...input }, { schedule: async () => { scheduled++; } });
  const prompt = id => hook({ hook_event_name: 'UserPromptSubmit', prompt_id: id, turn_id: id, prompt: 'Never store the hook prompt text.' });
  const stop = id => hook({ hook_event_name: 'Stop', prompt_id: id, turn_id: id, last_assistant_message: `Answer ${id}` });
  const append = rows => fs.appendFile(sourcePath, encode(rows));
  const collect = (limits, options = {}) => collectChat(store, { client, sessionId, classifyCommand: () => null, limits, ...options });
  const queue = () => selectChatQueue(store, project.id, client, sessionId);
  const setAuto = async () => { const settings = await readSettings(store); await updateSettings(store,
    { ...settings.value, projects: [{ ...project, tracking: 'auto' }] }, { expectedHash: settings.hash }); };
  const untrack = id => setChatTracking(store, { client, sessionId, cwd, sourcePath, action: 'untrack', promptId: id });
  return { root, cwd, store, sourcePath, human, answer, hook, prompt, stop, append, collect, queue, setAuto, untrack, scheduled: () => scheduled };
}
const humanText = records => records.flatMap(record => record.data.segments).filter(segment => segment.kind === 'human').map(segment => segment.text);

for (const client of ['claude', 'codex']) {
  test(`${client}: existing chat enrolls at its first post-setup prompt and never collects older history`, async t => {
    const f = await fixture(t, client);
    for (const source of ['startup', 'resume', 'compact', ...(client === 'codex' ? ['fork'] : [])]) {
      assert.equal((await f.hook({ hook_event_name: 'SessionStart', source })).ingress.status, 'ineligible');
    }
    assert.equal((await f.stop('old')).ingress.status, 'ineligible');
    assert.equal(await readChat(f.store, client, sessionId), null);
    assert.equal((await f.prompt('first')).ingress.status, 'enrolled');
    let chat = await readChat(f.store, client, sessionId);
    assert.equal(chat.value.history.startPromptId, 'first');
    assert(!JSON.stringify(chat).includes('Never store'));
    assert.equal((await f.collect()).reason, 'TRANSCRIPT_BOUNDARY_PENDING');
    const waiting = await readProjectStatus(f.store, 'project');
    assert(waiting.warnings.includes('TRANSCRIPT_BOUNDARY_PENDING'));
    assert.match(describeFailure({ code: 'TRANSCRIPT_BOUNDARY_PENDING' }).recovery, /background synchronization/);
    assert.deepEqual(await f.queue(), []);
    await f.append([f.human('first')]);
    assert.equal((await f.collect()).status, 'pending');
    assert.deepEqual(await f.queue(), []);
    await f.stop('first');
    await f.append(f.answer('first'));
    assert.equal((await f.collect()).status, 'caught-up');
    assert.deepEqual(humanText(await f.queue()), ['Prompt first']);
    assert.deepEqual((await f.queue()).flatMap(record => record.data.segments.map(segment => segment.text)), ['Prompt first', 'Answer first']);
    await f.prompt('second'); await f.append([f.human('second'), ...f.answer('second')]); await f.stop('second');
    assert.equal((await f.collect()).status, 'caught-up');
    assert.deepEqual(humanText(await f.queue()), ['Prompt first', 'Prompt second']);
    chat = await readChat(f.store, client, sessionId); assert.equal(chat.value.history.startPromptId, 'first');
  });

  test(`${client}: a new chat waits for its first prompt and late source persistence`, async t => {
    const f = await fixture(t, client);
    await fs.writeFile(f.sourcePath, '');
    await f.hook({ hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(await readChat(f.store, client, sessionId), null);
    await f.prompt('first'); assert.equal((await f.collect()).status, 'pending');
    assert.deepEqual(await f.queue(), []);
    const header = client === 'codex' ? [{ type: 'session_meta', ordinal: 0, payload: { id: sessionId, history_mode: 'paginated' } }] : [];
    await f.append([...header, f.human('first'), ...f.answer('first')]);
    assert.equal((await f.collect()).status, 'caught-up');
    assert.deepEqual(humanText(await f.queue()), ['Prompt first']);
  });

  test(`${client}: enabling auto during a turn excludes that turn and starts on the following prompt`, async t => {
    const f = await fixture(t, client, 'manual');
    assert.equal((await f.prompt('setup-turn')).ingress.status, 'ineligible');
    await f.append([f.human('setup-turn')]); await f.setAuto();
    await f.append(f.answer('setup-turn')); assert.equal((await f.stop('setup-turn')).ingress.status, 'ineligible');
    assert.equal(await readChat(f.store, client, sessionId), null);
    await f.prompt('after-setup'); await f.append([f.human('after-setup'), ...f.answer('after-setup')]);
    assert.equal((await f.collect()).status, 'caught-up');
    assert.deepEqual(humanText(await f.queue()), ['Prompt after-setup']);
  });

  test(`${client}: bounded delayed boundary resolution excludes old messages and survives later prompt hooks`, async t => {
    const f = await fixture(t, client);
    for (let i = 0; i < 8; i++) await f.append([f.human(`old-${i}`), ...f.answer(`old-${i}`)]);
    await f.prompt('first');
    for (let i = 0; i < 3; i++) { assert.equal((await f.collect({ rows: 2 })).status, 'pending'); assert.deepEqual(await f.queue(), []); }
    await f.prompt('later');
    const line = encode([f.human('first')]);
    await fs.appendFile(f.sourcePath, line.slice(0, -2));
    for (let i = 0; i < 30; i++) { await f.collect({ rows: 2 }); assert.deepEqual(await f.queue(), []); }
    await fs.appendFile(f.sourcePath, line.slice(-2));
    await f.append([...f.answer('first'), f.human('later'), ...f.answer('later')]); await f.stop('later');
    let result;
    for (let i = 0; i < 100; i++) { result = await f.collect({ rows: 2 }); if (result.status === 'caught-up') break; }
    assert.equal(result.status, 'caught-up'); assert.deepEqual(humanText(await f.queue()), ['Prompt first', 'Prompt later']);
  });

  test(`${client}: untrack before first collection preserves the lower boundary and stays opted out`, async t => {
    const f = await fixture(t, client);
    await f.prompt('first'); await f.append([f.human('first'), ...f.answer('first'), f.human('untrack')]);
    await f.untrack('untrack');
    await f.append([...f.answer('untrack'), f.human('excluded'), ...f.answer('excluded')]);
    assert.equal((await f.prompt('excluded')).ingress.status, 'untracked');
    assert.equal((await f.collect()).status, 'caught-up');
    assert.deepEqual(humanText(await f.queue()), ['Prompt first']);
    await f.setAuto(); assert.equal((await f.prompt('still-excluded')).ingress.status, 'untracked');
    const chat = await readChat(f.store, client, sessionId);
    assert.equal(chat.value.optOut, true); assert.equal(chat.value.tracked, false);
    assert.equal((await f.collect()).status, 'untracked');
  });

  test(`${client}: idle tracked prompts write and schedule nothing even while the settings gate is held`, async t => {
    const f = await fixture(t, client);
    await f.prompt('first'); await f.append([f.human('first'), ...f.answer('first')]);
    assert.equal((await f.collect()).status, 'caught-up');
    const before = await readChat(f.store, client, sessionId), scheduled = f.scheduled();
    const held = tryAcquireExistingGate(f.store.settingsGate, gateOptions).acquired; assert.ok(held);
    try { assert.equal((await f.prompt('second')).ingress.status, 'tracked'); }
    finally { held.release(); }
    assert.equal((await readChat(f.store, client, sessionId)).hash, before.hash);
    assert.equal(f.scheduled(), scheduled);
    await f.append([f.human('second'), ...f.answer('second')]); await f.stop('second');
    assert.equal((await f.collect()).status, 'caught-up');
    assert.deepEqual(humanText(await f.queue()), ['Prompt first', 'Prompt second']);
  });

  test(`${client}: a retained enrollment seek resumes after an authoritative source relocation`, async t => {
    const f = await fixture(t, client);
    await f.prompt('first'); await f.append([f.human('first'), ...f.answer('first')]);
    const interrupted = await f.collect(undefined, { classifyCommand: () => ({ pending: 'HISTORY_COMMAND_BOUNDARY_PENDING' }) });
    assert.equal(interrupted.reason, 'HISTORY_COMMAND_BOUNDARY_PENDING');
    const point = (await readChat(f.store, client, sessionId)).value.checkpoint;
    assert.equal(point.offset, point.anchor.start); assert.equal(point.exchange, null);
    const relocated = path.join(f.root, 'relocated.jsonl'); await fs.copyFile(f.sourcePath, relocated);
    await f.hook({ hook_event_name: 'SessionStart', source: 'resume', transcript_path: relocated });
    const result = await f.collect(undefined, { resolveNativeSource: async () => ({ path: relocated, source: await openTranscript(relocated) }) });
    assert.equal(result.status, 'caught-up');
    assert.deepEqual(humanText(await f.queue()), ['Prompt first']);
    assert.equal((await readChat(f.store, client, sessionId)).value.source.path, relocated);
  });

  test(`${client}: ambiguous enrollment prompt stays pending without importing any history`, async t => {
    const f = await fixture(t, client); await f.prompt('duplicate');
    await f.append([f.human('duplicate'), ...f.answer('duplicate'), f.human('between'), ...f.answer('between'), f.human('duplicate'), ...f.answer('duplicate')]);
    assert.equal((await f.collect()).reason, 'TRANSCRIPT_BOUNDARY_AMBIGUOUS');
    assert.deepEqual(await f.queue(), []);
    const status = await readProjectStatus(f.store, 'project');
    assert(status.warnings.includes('TRANSCRIPT_BOUNDARY_AMBIGUOUS'));
    const guidance = describeFailure({ code: status.warnings.find(code => code === 'TRANSCRIPT_BOUNDARY_AMBIGUOUS') });
    assert.match(guidance.recovery, /new chat/);
  });
}

for (const explicitOrigin of [true, false]) test(`Claude forks retain unknown inheritance when copied rows reuse the current prompt ID (origin ${explicitOrigin})`, async t => {
  const f = await fixture(t, 'claude');
  const row = (id, index) => ({ ...f.human(id), promptId: 'rewritten', ...(explicitOrigin ? { turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: index } } : {}) });
  await fs.writeFile(f.sourcePath, encode([row('inherited', 0), ...f.answer('inherited'), row('current', 1), ...f.answer('current')]));
  await f.hook({ hook_event_name: 'SessionStart', source: 'fork' }); await f.prompt('rewritten');
  await f.hook({ hook_event_name: 'Stop', prompt_id: 'rewritten', last_assistant_message: 'Answer current' });
  assert.equal((await f.collect()).reason, 'HISTORY_INHERITED_BOUNDARY_UNKNOWN');
  const chat = (await readChat(f.store, 'claude', sessionId)).value;
  assert.equal(chat.history.startSource, 'fork'); assert.deepEqual(await f.queue(), []);
  const status = await readProjectStatus(f.store, 'project');
  assert(status.warnings.includes('HISTORY_INHERITED_BOUNDARY_UNKNOWN'));
  assert.match(describeFailure({ code: 'HISTORY_INHERITED_BOUNDARY_UNKNOWN' }).recovery, /new chat/);
});

test('Codex forks omit referenced parent history and earlier child prompts', async t => {
  const f = await fixture(t, 'codex');
  const base = { thread_id: 'synthetic-parent', end_ordinal_exclusive: 4, end_byte_offset: 1000 };
  const header = { type: 'session_meta', ordinal: 4, payload: { id: sessionId, history_mode: 'paginated',
    history_base: base, forked_from_id: base.thread_id, forked_from_ordinal_exclusive: 4 } };
  const olderChild = [f.human('older-child'), ...f.answer('older-child')].map((row, index) => ({ ...row, ordinal: index + 5 }));
  await fs.writeFile(f.sourcePath, encode([header, ...olderChild]));
  await f.hook({ hook_event_name: 'SessionStart', source: 'fork' }); await f.prompt('first');
  await f.append([f.human('first'), ...f.answer('first')].map((row, index) => ({ ...row, ordinal: index + 8 })));
  assert.equal((await f.collect()).status, 'caught-up');
  assert.deepEqual((await f.queue()).flatMap(record => record.data.segments.map(segment => segment.text)), ['Prompt first', 'Answer first']);
});


test('a zero-offset enrollment seek does not restart while a bounded untrack scan is pending', async t => {
  const f = await fixture(t, 'claude'); await fs.writeFile(f.sourcePath, '');
  await f.prompt('first');
  await f.append([f.human('first'), ...f.answer('first'), f.human('second'), ...f.answer('second'), f.human('untrack')]);
  await f.untrack('untrack'); let result;
  for (let i = 0; i < 20; i++) { result = await f.collect({ rows: 2 }); if (result.status === 'caught-up') break; }
  assert.equal(result.status, 'caught-up');
  assert.deepEqual(humanText(await f.queue()), ['Prompt first', 'Prompt second']);
});
