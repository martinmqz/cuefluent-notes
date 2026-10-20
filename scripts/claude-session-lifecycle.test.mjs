import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { storageChurn, onVerificationAttempt, directoryChurn } from './test-support/storage-churn.mjs';
import { runCollectionWorker } from './test-support/capture-workflow.mjs';
import { collectionIngress, registrationFloorPath } from './collection-ingress.mjs';
import { inspectIntakeStore, intakeSnapshot, intakeJSON, withIntakeLock } from './intake-io.mjs';
import { schedulerPath } from './collection-scheduler.mjs';
import { readSelection, readCaptureHead, controlSelection, readReaderProgress } from './intake-store.mjs';
import { resolveProcessingInvocation } from './processing-native-invocation.mjs';
import { readContinuedLink, readContinuesLink } from './claude-continuation.mjs';
import { captureChatTurns, excludeChatTurn, selectExplicitCapture, controlChatCapture } from './capture-controls.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { digest } from './workflow-values.mjs';

// Synthetic Claude CLI 2.1.299-shaped transcripts: root user/assistant rows
// plus metadata and large API request snapshots. All content is fictional.
const COMMAND = 'cuefluent-notes:cuefluent-notes';
const line = value => JSON.stringify(value) + '\n';
const CONTROLS = {
  status: { tool: 'processing_status', arguments: {} },
  review: { tool: 'processing_review', arguments: {} },
  help: { tool: 'processing_status', arguments: { help: true } },
  'status --verbose': { tool: 'processing_status', arguments: { verbose: true } },
  'save k2mn9p': { tool: 'processing_review', arguments: { decision: 'save', draft: 'k2mn9p' } },
  capture: { tool: 'capture_turns', arguments: {} },
};

async function claudeFixture(t, { collect = true, processing = 'prompted' } = {}) {
  const f = await storageFixture(t, { privateConfig: true });
  if (!collect) {
    // Collection off: hooks record only the session start, with any processing mode.
    f.config.routes[0].collection.enabled = false; f.config.routes[0].processing.mode = processing;
    const bytes = JSON.stringify(f.config);
    await fs.writeFile(f.options.configPath, bytes, { mode: 0o600 });
    f.options.expectedConfigHash = digest(bytes);
    f.capability = await verifyWorkflowStorage(f.options);
  }
  const transcripts = path.join(f.root, 'claude-projects', 'synthetic-project');
  await fs.mkdir(transcripts, { recursive: true });
  const skillPath = path.join(f.root, 'synthetic-plugin', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, '---\nname: cuefluent-notes\n---\n\nSynthetic control $ARGUMENTS\n');
  const store = await inspectIntakeStore(f.collection);
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 16, 12, 0, 0, clock++)).toISOString();
  const session = (sessionId = randomUUID(), { kind = null } = {}) => {
    const file = path.join(transcripts, `${sessionId}.jsonl`);
    let parent = null;
    const s = {
      sessionId, file, rows: [],
      root(type, extra = {}) {
        const row = { parentUuid: parent, isSidechain: false, userType: 'external', cwd: f.project, sessionId, version: '2.1.299',
          gitBranch: 'main', ...(kind ? { sessionKind: kind } : {}), type, uuid: randomUUID(), timestamp: stamp(), ...extra };
        parent = row.uuid; return row;
      },
      meta: (type, extra = {}) => ({ type, sessionId, ...extra }),
      snapshot: () => ({ type: 'api-request', sessionId, requestId: randomUUID(), body: 'synthetic request snapshot '.repeat(800) }),
      prompt: (text, promptId = randomUUID()) => s.root('user', { promptId, message: { role: 'user', content: text } }),
      control(control, promptId = randomUUID()) {
        const input = s.root('user', { promptId, message: { role: 'user',
          content: `<command-message>${COMMAND}</command-message>\n<command-name>/${COMMAND}</command-name>\n<command-args>${control}</command-args>` } });
        const companion = s.root('user', { promptId, isMeta: true, turnCompanion: true, message: { role: 'user',
          content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(skillPath)}\n\nSynthetic control ${control}\n` }] } });
        return [input, companion];
      },
      call(control, callId = `toolu_${randomUUID().replaceAll('-', '')}`) {
        const { tool, arguments: input } = CONTROLS[control];
        return s.root('assistant', { attributionSkill: COMMAND, attributionPlugin: 'cuefluent-notes', message: { role: 'assistant',
          content: [{ type: 'tool_use', id: callId, name: `mcp__plugin_cuefluent-notes_cuefluent_control__${tool}`, input: structuredClone(input) }] } });
      },
      reply: text => s.root('assistant', { message: { role: 'assistant', content: [{ type: 'text', text }] } }),
      async append(rows) { s.rows.push(...rows); await fs.appendFile(file, rows.map(line).join('')); },
      hook: (event, promptId = null, extra = {}) => collectionIngress('claude', { session_id: sessionId, cwd: f.project, transcript_path: file,
        hook_event_name: event, ...(promptId ? { prompt_id: promptId, prompt: 'Not persisted by ingress' } : { source: 'startup' }), ...extra },
      { configPath: f.options.configPath, launch: async () => {} }),
      resolve: (callRow, capability = f.capability) => {
        const block = callRow.message.content[0];
        return resolveProcessingInvocation(capability, { client: 'claude', sessionId, toolCallId: block.id },
          { tool: block.name.split('__').at(-1), arguments: structuredClone(block.input) }, { skillPath, settleMs: 0 });
      },
      head: unitId => readCaptureHead(store, { client: 'claude', sessionId, unitId }),
      selection: () => readSelection(store, { client: 'claude', sessionId }),
    };
    return s;
  };
  const run = extra => runCollectionWorker({ configPath: f.options.configPath, collectionId: f.collection.id, ...extra });
  return { ...f, transcripts, skillPath, store, session, run };
}
// Every private state file with its bytes: a binding must write nothing.
async function stateFiles(root) {
  const out = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else out[path.relative(root, file)] = digest(await fs.readFile(file));
    }
  }
  await walk(root); return out;
}
const sessionCodes = (result, sessionId) => result.diagnostics.filter(item => item.sessionId === sessionId).map(item => item.code);

test('a typed control as the first prompt of a fresh registered Claude session binds without a warm-up prompt', async t => {
  for (const control of Object.keys(CONTROLS)) await t.test(control, async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    // The CLI persists the prompt and large request snapshots before the hook
    // that registers the session freezes its floor past them.
    await A.append([A.meta('mode', { mode: 'normal' }), A.meta('permission-mode', { permissionMode: 'default' }),
      ...A.control(control, P1), A.snapshot(), A.snapshot()]);
    assert.equal((await A.hook('UserPromptSubmit', P1)).status, 'queued');
    assert.deepEqual(sessionCodes(await f.run(), A.sessionId), ['NATIVE_BOUNDARY_PENDING']);
    const call = A.call(control); await A.append([call]);
    const before = await stateFiles(f.collection.intakeStateDir), transcript = await fs.readFile(A.file);
    const bound = await A.resolve(call);
    assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, P1); assert.equal(bound.typedControl, control);
    assert.equal(bound.captureActive, false); assert.equal(bound.selectionHash, null); assert.equal(bound.chatLineage, undefined);
    assert.deepEqual(bound.selection, { client: 'claude', sessionId: A.sessionId, cwd: f.project, unitId: null });
    // Binding creates no selection and writes no state; the source is untouched.
    assert.equal((await A.selection()).state, null);
    assert.deepEqual(await stateFiles(f.collection.intakeStateDir), before);
    assert.deepEqual(await fs.readFile(A.file), transcript);
  });
});

test('a SessionStart registration binds the first prompt through the floor the worker froze from its first wake', async t => {
  const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
  assert.equal((await A.hook('SessionStart')).status, 'pending-source');
  await A.append([A.meta('mode', { mode: 'normal' }), ...A.control('review', P1), A.snapshot()]);
  await A.hook('UserPromptSubmit', P1); await f.run();
  const call = A.call('review'); await A.append([call]);
  const bound = await A.resolve(call);
  assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, P1);
  // A floor saved for a different registration never pins this source.
  const floor = path.join(f.collection.intakeStateDir, registrationFloorPath({ client: 'claude', sessionId: A.sessionId }));
  const saved = JSON.parse(await fs.readFile(floor, 'utf8'));
  await fs.writeFile(floor, JSON.stringify({ ...saved, registrationId: randomUUID() }) + '\n', { mode: 0o600 });
  await assert.rejects(A.resolve(call), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' });
});

test('the floor still governs collection after a first-prompt control: the next prompt is the excluded boundary', async t => {
  const f = await claudeFixture(t), A = f.session(), [P1, P2, P3] = [randomUUID(), randomUUID(), randomUUID()];
  await A.append([A.meta('mode', { mode: 'normal' }), ...A.control('review', P1), A.snapshot()]);
  await A.hook('UserPromptSubmit', P1); await f.run();
  const call = A.call('review'); await A.append([call, A.reply('Draft folder written.')]);
  assert.equal((await A.resolve(call)).nativeSkill, true);
  await A.append([A.prompt('Boundary after the first control', P2)]);
  await A.hook('UserPromptSubmit', P2);
  const armed = await f.run();
  assert.deepEqual(armed.boundaryExcluded, [{ client: 'claude', sessionId: A.sessionId, unitId: P2 }]); assert.equal(armed.saved, 0);
  await A.append([A.reply('Noted.'), A.prompt('Synthetic decision: keep the pilot paused', P3)]);
  await A.hook('UserPromptSubmit', P3);
  assert.equal((await f.run()).saved, 1);
  assert.equal((await A.head(P1)).head, null); assert.equal((await A.head(P2)).head, null);
  assert.deepEqual((await A.head(P3)).capture.evidence.map(item => item.text), ['Synthetic decision: keep the pilot paused']);
  assert.equal((await A.selection()).state.intervals[0].lower.unitId, P2);
});

test('stale, replaced or out-of-scope registrations and later or older prompts never verify a selection-less binding', async t => {
  await t.test('a renewed collection grant', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.append([...A.control('status', P1), A.snapshot()]); await A.hook('UserPromptSubmit', P1); await f.run();
    const call = A.call('status'); await A.append([call]);
    f.config.routes[0].collection.generation = randomUUID();
    const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes, { mode: 0o600 });
    const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
    await assert.rejects(A.resolve(call, capability), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' });
  });
  await t.test('collection turned off', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.append([...A.control('status', P1), A.snapshot()]); await A.hook('UserPromptSubmit', P1); await f.run();
    const call = A.call('status'); await A.append([call]);
    f.config.routes[0].collection.enabled = false;
    const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes, { mode: 0o600 });
    const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
    await assert.rejects(A.resolve(call, capability), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' });
  });
  await t.test('a replaced transcript', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.append([...A.control('status', P1), A.snapshot()]); await A.hook('UserPromptSubmit', P1); await f.run();
    const call = A.call('status'); await A.append([call]);
    const bytes = await fs.readFile(A.file); await fs.rm(A.file); await fs.writeFile(A.file, bytes);
    await assert.rejects(A.resolve(call), { code: 'SOURCE_CHANGED' });
  });
  await t.test('the first prompt after the floor binds before arming; a later one waits for the armed selection', async t => {
    const f = await claudeFixture(t), A = f.session(), [P1, P2, P3] = [randomUUID(), randomUUID(), randomUUID()];
    await A.append([A.prompt('Opening context', P1), A.snapshot()]); await A.hook('UserPromptSubmit', P1);
    const [input, companion] = A.control('status', P2), call = A.call('status');
    await A.append([input, companion, call]);
    // Not armed yet, but this prompt is the boundary the worker will exclude,
    // so it can never be collected: it binds without a receipt.
    const early = await A.resolve(call);
    assert.equal(early.nativeSkill, true); assert.equal(early.unitId, P2); assert.equal(early.captureActive, false);
    // A second post-floor control before arming would be collected later; it waits.
    const [input3, companion3] = A.control('review', P3), call3 = A.call('review');
    await A.append([input3, companion3, call3]);
    await assert.rejects(A.resolve(call3), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' });
    await A.hook('UserPromptSubmit', P2); await f.run();
    const bound = await A.resolve(call);
    assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, P2); assert.equal(bound.captureActive, true);
    assert.equal((await A.resolve(call3)).unitId, P3);
  });
  await t.test('a post-floor control beyond the bounded window waits too: an earlier prompt could hide outside it', async t => {
    const f = await claudeFixture(t), A = f.session(), [P1, P2, P3] = [randomUUID(), randomUUID(), randomUUID()];
    await A.append([A.prompt('Opening context', P1), A.snapshot()]); await A.hook('UserPromptSubmit', P1);
    // An earlier post-floor prompt, then more request snapshots than the 2 MiB
    // binding window holds, then a typed control. The window no longer reaches
    // the floor, so nothing shows the control to be the excluded boundary.
    await A.append([A.prompt('Earlier prompt after the floor', P2), A.reply('Noted.'), ...Array.from({ length: 110 }, () => A.snapshot())]);
    const [input, companion] = A.control('status', P3), call = A.call('status');
    await A.append([input, companion, call]);
    assert((await fs.stat(A.file)).size > 2 * 1024 * 1024 + 256 * 1024);
    await assert.rejects(A.resolve(call), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' });
    // Armed, the earlier prompt is the excluded boundary and the control binds
    // inside the collected interval, where its exclusion receipt applies.
    await A.hook('UserPromptSubmit', P2);
    const armed = await f.run();
    assert.deepEqual(armed.boundaryExcluded, [{ client: 'claude', sessionId: A.sessionId, unitId: P2 }]);
    const bound = await A.resolve(call);
    assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, P3); assert.equal(bound.captureActive, true);
  });
  await t.test('an older prompt before the floor', async t => {
    const f = await claudeFixture(t), A = f.session(), [P0, P1] = [randomUUID(), randomUUID()];
    await A.append([A.prompt('Earlier history', P0), A.reply('Earlier reply'), ...A.control('status', P1), A.snapshot()]);
    await A.hook('UserPromptSubmit', P1); await f.run();
    const call = A.call('status'); await A.append([call]);
    // Not a fresh session: only the floor-bounded tail is read, so the call
    // binds as model-chosen and the earlier prompt is never consulted.
    const bound = await A.resolve(call);
    assert.equal(bound.nativeSkill, false); assert.equal(bound.typedControl, undefined); assert.equal(bound.unitId, null);
  });
});

test('a processing-only route also verifies a first-prompt control before its hook boundary', async t => {
  const f = await claudeFixture(t, { collect: false }), A = f.session(), P1 = randomUUID();
  await A.append([...A.control('review', P1), A.snapshot()]);
  assert.equal((await A.hook('UserPromptSubmit', P1)).status, 'processing-only');
  const call = A.call('review'); await A.append([call]);
  const bound = await A.resolve(call);
  assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, P1); assert.equal(bound.captureActive, false);
});

test('typed capture in a Manual Claude chat captures its turns since the last capture, never a command turn', async t => {
  const f = await claudeFixture(t, { collect: false, processing: 'manual' }), A = f.session();
  const [P1, P2, C1, P3, C2] = Array.from({ length: 5 }, () => randomUUID());
  await A.append([A.meta('mode', { mode: 'normal' })]);
  assert.equal((await A.hook('SessionStart')).status, 'manual');
  const typedCapture = async (rows, promptId) => {
    const call = A.call('capture'); await A.append([...rows, ...A.control('capture', promptId), call]);
    const bound = await A.resolve(call);
    assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, promptId);
    const chat = { selection: bound.selection, source: bound.source };
    const captured = await captureChatTurns(f.capability, { ...chat, floor: bound.captureFloor, commandUnitId: bound.unitId });
    await excludeChatTurn(f.capability, { ...chat, unitId: bound.unitId });
    return captured;
  };
  assert.deepEqual(await typedCapture([A.prompt('Decision: ship on Friday.', P1), A.reply('Noted.'),
    A.prompt('Owner: Dana.', P2), A.reply('Noted.')], C1), { turns: 2, more: false, leftOut: 0 });
  assert((await A.head(P1)).head); assert((await A.head(P2)).head); assert.equal((await A.head(C1)).head, null);
  assert.deepEqual(await typedCapture([A.reply('Captured.'), A.prompt('Correction: ship on Monday.', P3), A.reply('Noted.')], C2), { turns: 1, more: false, leftOut: 0 });
  assert.match((await A.head(P3)).capture.evidence[0].text, /ship on Monday/);
  for (const unitId of [C1, C2]) assert.equal((await A.head(unitId)).head, null);
  assert.deepEqual((await A.selection()).state.exclusions, [C1, C2]);
});

test('capture never rereads a finished window and stops on cancellation before reading', async t => {
  const f = await claudeFixture(t, { collect: false, processing: 'manual' }), A = f.session();
  const [P1, C1, C2, C3] = Array.from({ length: 4 }, () => randomUUID());
  await A.append([A.meta('mode', { mode: 'normal' })]); await A.hook('SessionStart');
  const bind = async promptId => {
    const call = A.call('capture'); await A.append([...A.control('capture', promptId), call]);
    const bound = await A.resolve(call);
    return { selection: bound.selection, source: bound.source, floor: bound.captureFloor, commandUnitId: bound.unitId };
  };
  await A.append([A.prompt('Decision: ship on Friday.', P1), A.reply('Noted.')]);
  const first = await bind(C1);
  assert.equal((await captureChatTurns(f.capability, first)).turns, 1);
  await excludeChatTurn(f.capability, { selection: first.selection, source: first.source, unitId: C1 });
  // A later capture reads only past the finished window.
  const scope = (await A.selection()).state.explicitScopes.at(-1), reads = [];
  await A.append([A.reply('Captured.')]);
  assert.deepEqual(await captureChatTurns(f.capability, await bind(C2), { observeRead: read => reads.push(read) }), { turns: 0, more: false, leftOut: 0 });
  const ranges = reads.filter(read => read.purpose === 'range');
  assert(ranges.length && ranges.every(read => read.offset >= scope.end.endByte), JSON.stringify(ranges));
  // A cancelled command stops before reading or selecting anything.
  const controller = new AbortController(); controller.abort();
  const before = await A.selection(), cancelled = await bind(C3), late = [];
  await assert.rejects(captureChatTurns(f.capability, cancelled, { signal: controller.signal, observeRead: read => late.push(read) }), { name: 'AbortError' });
  assert.equal((await A.selection()).hash, before.hash); assert.deepEqual(late, []);
});

test('a turn larger than one capture can read is passed over later captures, never restarted', async t => {
  const f = await claudeFixture(t, { collect: false, processing: 'manual' }), A = f.session();
  const [P1, P2, P3, C1, C2, C3] = Array.from({ length: 6 }, () => randomUUID());
  await A.append([A.meta('mode', { mode: 'normal' })]); await A.hook('SessionStart');
  // P2's reply is longer than one 8 MiB read; each capture here may read only one.
  await A.append([A.prompt('Before the long reply.', P1), A.reply('Noted.'), A.prompt('Paste the whole log.', P2),
    ...Array.from({ length: 9 }, (_, index) => A.reply(`${index}`.repeat(1024 * 1024))), A.prompt('After the long reply.', P3), A.reply('Noted.')]);
  const capture = async promptId => {
    const call = A.call('capture'); await A.append([...A.control('capture', promptId), call]);
    const bound = await A.resolve(call), chat = { selection: bound.selection, source: bound.source };
    const result = await captureChatTurns(f.capability, { ...chat, floor: bound.captureFloor, commandUnitId: bound.unitId }, { scanWindows: 1 });
    await excludeChatTurn(f.capability, { ...chat, unitId: bound.unitId });
    return result;
  };
  assert.deepEqual(await capture(C1), { turns: 1, more: true, leftOut: 0 });
  // This capture's one read ends inside P2: P2 is left out and the next one resumes there.
  assert.deepEqual(await capture(C2), { turns: 0, more: true, leftOut: 1 });
  assert.deepEqual(await capture(C3), { turns: 1, more: false, leftOut: 0 });
  assert((await A.head(P1)).head); assert.equal((await A.head(P2)).head, null); assert((await A.head(P3)).head);
});

test('a stored scan position is dropped when the transcript changed under it', async t => {
  const f = await claudeFixture(t, { collect: false, processing: 'manual' }), A = f.session();
  const [P1, P2, C1, C2, C3] = Array.from({ length: 5 }, () => randomUUID());
  await A.append([A.meta('mode', { mode: 'normal' })]); await A.hook('SessionStart');
  await A.append([A.prompt('Paste the whole log.', P1), ...Array.from({ length: 9 }, (_, index) => A.reply(`${index}`.repeat(1024 * 1024))),
    A.prompt('After the long reply.', P2), A.reply('Noted.')]);
  const reads = [];
  const capture = async promptId => {
    const call = A.call('capture'); await A.append([...A.control('capture', promptId), call]);
    const bound = await A.resolve(call), chat = { selection: bound.selection, source: bound.source };
    reads.length = 0;
    // Two reads per capture: up to the long turn, then into it.
    const result = await captureChatTurns(f.capability, { ...chat, floor: bound.captureFloor, commandUnitId: bound.unitId }, { scanWindows: 2, observeRead: read => reads.push(read) });
    await excludeChatTurn(f.capability, { ...chat, unitId: bound.unitId });
    return result;
  };
  assert.deepEqual(await capture(C1), { turns: 0, more: true, leftOut: 1 });
  const saved = JSON.parse(await fs.readFile(path.join(f.collection.intakeStateDir, 'chat-capture', 'claude', `${A.sessionId}.json`), 'utf8'));
  // Rewrite one byte just before the saved position, in place: same file, other contents.
  const handle = await fs.open(A.file, 'r+');
  try { await handle.write(Buffer.from('#'), 0, 1, saved.offset - 10); } finally { await handle.close(); }
  // The position is not trusted: this capture reads from the chat's start again.
  assert.deepEqual(await capture(C2), { turns: 0, more: true, leftOut: 0 });
  assert(reads.some(read => read.purpose === 'range' && read.offset < saved.offset), JSON.stringify(reads.slice(0, 3)));
  assert.deepEqual(await capture(C3), { turns: 1, more: false, leftOut: 0 });
  assert((await A.head(P2)).head);
});

test('capture does not trust where an earlier capture ended once the transcript was cut back and regrown', async t => {
  const f = await claudeFixture(t, { collect: false, processing: 'manual' });
  const bind = async (A, promptId) => {
    const call = A.call('capture'); await A.append([...A.control('capture', promptId), call]);
    const bound = await A.resolve(call);
    return { selection: bound.selection, source: bound.source, floor: bound.captureFloor, commandUnitId: bound.unitId };
  };
  // Cut the transcript back in place to `size`, then grow it past `end` with a replacement turn.
  const regrow = async (A, size, end, P) => {
    await fs.truncate(A.file, size);
    await A.append([A.prompt('Replacement: ship on Monday.', P), A.reply('Noted. '.repeat(64))]);
    assert((await fs.stat(A.file)).size > end);
  };
  await t.test('a finished capture', async () => {
    const A = f.session(), [P1, P2, C1, C2] = Array.from({ length: 4 }, () => randomUUID());
    await A.append([A.meta('mode', { mode: 'normal' })]); await A.hook('SessionStart');
    const size = (await fs.stat(A.file)).size;
    await A.append([A.prompt('Decision: ship on Friday.', P1), A.reply('Noted.')]);
    const first = await bind(A, C1);
    assert.deepEqual(await captureChatTurns(f.capability, first), { turns: 1, more: false, leftOut: 0 });
    await excludeChatTurn(f.capability, { selection: first.selection, source: first.source, unitId: C1 });
    await regrow(A, size, (await A.selection()).state.explicitScopes.at(-1).end.endByte, P2);
    assert.deepEqual(await captureChatTurns(f.capability, await bind(A, C2)), { turns: 1, more: false, leftOut: 0 });
    assert.match((await A.head(P2)).capture.evidence[0].text, /ship on Monday/);
  });
  await t.test('an unfinished capture', async () => {
    const A = f.session(), [P1, P2, C1, C2] = Array.from({ length: 4 }, () => randomUUID());
    await A.append([A.meta('mode', { mode: 'normal' })]); await A.hook('SessionStart');
    const size = (await fs.stat(A.file)).size;
    await A.append([A.prompt('Decision: ship on Friday.', P1), A.reply('Noted.')]);
    const end = (await fs.stat(A.file)).size, first = await bind(A, C1);
    // A window selected but never run, as when a capture runs out of time.
    await selectExplicitCapture(f.capability, { selection: first.selection, sourcePath: first.source.path,
      expectedSourceIdentity: first.source.fileIdentity, expectedSelectionHash: (await A.selection()).hash,
      operationId: randomUUID(), kind: 'historical', unitIds: [P1], readRange: { fromByte: size, endByte: end } });
    await regrow(A, size, end, P2);
    assert.deepEqual(await captureChatTurns(f.capability, await bind(A, C2)), { turns: 1, more: false, leftOut: 0 });
    assert.equal((await A.head(P1)).head, null);
    assert.match((await A.head(P2)).capture.evidence[0].text, /ship on Monday/);
  });
});

test('capture finishes the latest unfinished capture of either kind before reading further', async t => {
  const f = await claudeFixture(t, { collect: false, processing: 'manual' }), A = f.session();
  const [P1, C1, C2] = Array.from({ length: 3 }, () => randomUUID());
  await A.append([A.meta('mode', { mode: 'normal' })]); await A.hook('SessionStart');
  const size = (await fs.stat(A.file)).size;
  await A.append([A.prompt('Decision: ship on Friday.', P1), A.reply('Noted.')]);
  const end = (await fs.stat(A.file)).size;
  const bind = async promptId => {
    const call = A.call('capture'); await A.append([...A.control('capture', promptId), call]);
    const bound = await A.resolve(call);
    return { selection: bound.selection, source: bound.source, floor: bound.captureFloor, commandUnitId: bound.unitId };
  };
  // A capture of the current turn selected by another route, never run.
  const first = await bind(C1);
  await selectExplicitCapture(f.capability, { selection: { ...first.selection, unitId: P1 }, sourcePath: first.source.path,
    expectedSourceIdentity: first.source.fileIdentity, expectedSelectionHash: (await A.selection()).hash,
    operationId: randomUUID(), kind: 'current', unitIds: [P1], readRange: { fromByte: size, endByte: end } });
  await excludeChatTurn(f.capability, { selection: first.selection, source: first.source, unitId: C1 });
  assert.deepEqual(await captureChatTurns(f.capability, await bind(C2)), { turns: 1, more: false, leftOut: 0 });
  assert.match((await A.head(P1)).capture.evidence[0].text, /ship on Friday/);
});

test('capture does not trust a pause once the transcript was cut back and regrown', async t => {
  const paused = async (t, { anchored }) => {
    const f = await claudeFixture(t), A = f.session(), [P1, P2, P3, X1, P4, C1] = Array.from({ length: 6 }, () => randomUUID());
    await A.append([A.meta('mode', { mode: 'normal' }), A.prompt('Kickoff context', P1), A.snapshot()]);
    await A.hook('UserPromptSubmit', P1); await f.run();
    await A.append([A.reply('Ready.'), A.prompt('Boundary prompt', P2)]); await A.hook('UserPromptSubmit', P2); await f.run();
    await A.append([A.reply('Okay.'), A.prompt('Synthetic decision', P3), A.reply('Recorded.')]); await A.hook('UserPromptSubmit', P3);
    assert.equal((await f.run()).saved, 1);
    const size = (await fs.stat(A.file)).size;
    // The chat is paused at a typed command; the worker may read up to the
    // pause and anchor its turn.
    await A.hook('UserPromptSubmit', X1);
    const pause = A.call('status'); await A.append([...A.control('status', X1), pause]);
    const bound = await A.resolve(pause);
    await controlChatCapture(f.capability, { selection: bound.selection, source: bound.source, unitId: X1, operation: 'pause' });
    if (anchored) await f.run();
    const upper = (await A.selection()).state.intervals.at(-1).upper;
    assert.equal(upper.unitId, X1); assert.equal(upper.record !== null, anchored);
    // Cut back in place to before the pause, then grown past it and past the
    // binding window, which never reads from before a stale floor.
    await fs.truncate(A.file, size);
    await A.append([A.prompt('Replacement: ship on Monday.', P4),
      ...Array.from({ length: 3 }, (_, index) => A.reply(`${index}`.repeat(1024 * 1024))), A.reply('Noted.')]);
    assert((await fs.stat(A.file)).size > upper.eofByte);
    await A.hook('UserPromptSubmit', C1);
    const call = A.call('capture'); await A.append([...A.control('capture', C1), call]);
    const command = await A.resolve(call);
    await captureChatTurns(f.capability, { selection: command.selection, source: command.source, floor: command.captureFloor, commandUnitId: command.unitId });
    assert.match((await A.head(P4)).capture.evidence[0].text, /ship on Monday/);
    // The boundary turn Automatic capture left out stays out.
    assert.equal((await A.head(P2)).head, null);
  };
  await t.test('before the worker anchored the pause', t => paused(t, { anchored: false }));
  await t.test('after the worker anchored the pause', t => paused(t, { anchored: true }));
});

// A command clock that jumps forward on every transcript read, as if each
// read ran long; storage budgets keep the real clock.
function slowReads(t) {
  const clock = performance.now.bind(performance), state = { skew: 0, jump: 0 };
  t.mock.method(performance, 'now', () => clock() + state.skew);
  return { clock, state, observeRead: () => { state.skew = state.jump; } };
}

test('a capture whose read ran long still selects its window, so the next capture runs it first', async t => {
  const f = await claudeFixture(t, { collect: false, processing: 'manual' }), A = f.session();
  const [P1, P2, C1, C2] = Array.from({ length: 4 }, () => randomUUID());
  await A.append([A.meta('mode', { mode: 'normal' })]); await A.hook('SessionStart');
  await A.append([A.prompt('Decision: ship on Friday.', P1), A.reply('Noted.'), A.prompt('Owner: Dana.', P2), A.reply('Noted.')]);
  const bind = async promptId => {
    const call = A.call('capture'); await A.append([...A.control('capture', promptId), call]);
    const bound = await A.resolve(call);
    return { selection: bound.selection, source: bound.source, floor: bound.captureFloor, commandUnitId: bound.unitId };
  };
  const first = await bind(C1), slow = slowReads(t);
  // The read takes 32 of the command's 50 seconds: enough left to select the
  // window, not to run it.
  slow.state.jump = 32_000;
  assert.deepEqual(await captureChatTurns(f.capability, first, { now: slow.clock, observeRead: slow.observeRead }), { turns: 0, more: true, leftOut: 0 });
  assert.deepEqual((await A.selection()).state.explicitScopes.map(scope => scope.unitIds), [[P1, P2]]);
  slow.state.skew = slow.state.jump = 0;
  await excludeChatTurn(f.capability, { selection: first.selection, source: first.source, unitId: C1 });
  assert.deepEqual(await captureChatTurns(f.capability, await bind(C2), { now: slow.clock }), { turns: 2, more: false, leftOut: 0 });
  assert((await A.head(P1)).head); assert((await A.head(P2)).head);
});

test('a capture records the turns it left out before it moves past them', async t => {
  const f = await claudeFixture(t, { collect: false, processing: 'manual' }), A = f.session();
  const [P1, P2, C1, C2, C3] = Array.from({ length: 5 }, () => randomUUID());
  await A.append([A.meta('mode', { mode: 'normal' })]); await A.hook('SessionStart');
  await A.append([A.prompt('Paste the whole log.', P1), ...Array.from({ length: 9 }, (_, index) => A.reply(`${index}`.repeat(1024 * 1024))),
    A.prompt('After the long reply.', P2), A.reply('Noted.')]);
  const slow = slowReads(t);
  const capture = async promptId => {
    const call = A.call('capture'); await A.append([...A.control('capture', promptId), call]);
    const bound = await A.resolve(call), chat = { selection: bound.selection, source: bound.source };
    // Two reads per capture: up to the long turn, then into it.
    const result = await captureChatTurns(f.capability, { ...chat, floor: bound.captureFloor, commandUnitId: bound.unitId },
      { scanWindows: 2, now: slow.clock, observeRead: slow.observeRead });
    slow.state.skew = slow.state.jump = 0;
    await excludeChatTurn(f.capability, { ...chat, unitId: bound.unitId });
    return result;
  };
  // The reads take 45 of the command's 50 seconds: no time is left to record
  // the long turn as left out, so the scan position stays where it was.
  slow.state.jump = 45_000;
  assert.deepEqual(await capture(C1), { turns: 0, more: true, leftOut: 0 });
  assert(!(await A.selection()).state?.exclusions.includes(P1));
  assert.deepEqual(await capture(C2), { turns: 0, more: true, leftOut: 1 });
  assert((await A.selection()).state.exclusions.includes(P1));
  assert.deepEqual(await capture(C3), { turns: 1, more: false, leftOut: 0 });
  assert.equal((await A.head(P1)).head, null); assert((await A.head(P2)).head);
});

test('capture does not trust Automatic progress once the transcript changed under it', async t => {
  const f = await claudeFixture(t), A = f.session(), [P1, P2, P3, C1] = Array.from({ length: 4 }, () => randomUUID());
  await A.append([A.meta('mode', { mode: 'normal' }), A.prompt('Kickoff context', P1), A.snapshot()]);
  await A.hook('UserPromptSubmit', P1); await f.run();
  await A.append([A.reply('Ready.'), A.prompt('Boundary prompt', P2)]); await A.hook('UserPromptSubmit', P2); await f.run();
  await A.append([A.reply('Okay.'), A.prompt('Synthetic decision', P3), A.reply('Recorded.')]); await A.hook('UserPromptSubmit', P3);
  assert.equal((await f.run()).saved, 1);
  const state = (await A.selection()).state, interval = state.intervals.at(-1);
  const { cursor } = await readReaderProgress(f.store, { client: 'claude', sessionId: A.sessionId }, interval.id, state.source.fileIdentity, { metadataOnly: true });
  // The project switches to Manual; then bytes under the worker's progress change in place.
  f.config.routes[0].collection.enabled = false; f.config.routes[0].processing.mode = 'manual';
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes, { mode: 0o600 });
  f.options.expectedConfigHash = digest(bytes); f.capability = await verifyWorkflowStorage(f.options);
  const handle = await fs.open(A.file, 'r+'), at = cursor.anchor.startByte;
  try {
    const anchored = Buffer.alloc(cursor.anchor.endByte - cursor.anchor.startByte);
    await handle.read(anchored, 0, anchored.length, cursor.anchor.startByte);
    const text = anchored.toString('utf8'), index = text.indexOf('Recorded.');
    assert(index >= 0, text.slice(0, 200));
    await handle.write(Buffer.from('X'), 0, 1, at + Buffer.byteLength(text.slice(0, index)));
  } finally { await handle.close(); }
  await A.hook('UserPromptSubmit', C1);
  const call = A.call('capture'); await A.append([...A.control('capture', C1), call]);
  const bound = await A.resolve(call, f.capability), reads = [];
  await captureChatTurns(f.capability, { selection: bound.selection, source: bound.source, floor: bound.captureFloor, commandUnitId: bound.unitId },
    { observeRead: read => reads.push(read) });
  // It read from where Automatic capture began, not from the stale progress.
  assert(reads.some(read => read.purpose === 'range' && read.offset < cursor.offset), JSON.stringify(reads.slice(0, 3)));
  // The boundary turn Automatic capture left out stays out.
  assert.equal((await A.head(P2)).head, null);
});

// A session the CLI moved into a background session: the origin ends with
// `continued-in`, the successor re-homes every root record under its own ID
// with sessionKind "bg" (Claude CLI's background-session stamp).
async function continued(t, { rehome = rows => rows, successorKind = 'bg', register = true, sibling = true, arm = false } = {}) {
  const f = await claudeFixture(t), A = f.session(), [P1, P2, P3] = [randomUUID(), randomUUID(), randomUUID()];
  await A.append([A.meta('mode', { mode: 'normal' }), A.prompt('Kickoff context', P1), A.snapshot()]);
  await A.hook('UserPromptSubmit', P1); await f.run();
  await A.append([A.reply('Ready.'), A.prompt('Boundary prompt', P2)]); await A.hook('UserPromptSubmit', P2); await f.run();
  await A.append([A.reply('Okay.'), A.prompt('Synthetic decision before the move', P3), A.reply('Recorded.')]);
  await A.hook('UserPromptSubmit', P3);
  assert.equal((await f.run()).saved, 1);
  const B = f.session(randomUUID(), { kind: successorKind });
  if (!sibling) B.file = path.join(f.root, `${B.sessionId}.jsonl`);
  await B.append([B.meta('ai-title', { aiTitle: 'Synthetic title' }), B.meta('agent-name', { agentName: 'synthetic' }),
    B.meta('mode', { mode: 'normal' }), B.meta('permission-mode', { permissionMode: 'default' })]);
  // Registered while only metadata exists: its floor precedes the re-homed history.
  if (register) await B.hook('SessionStart', null, { source: 'resume' });
  const copies = rehome(A.rows.filter(row => ['user', 'assistant', 'system', 'attachment'].includes(row.type))
    .map(row => ({ ...row, sessionId: B.sessionId, ...(successorKind ? { sessionKind: successorKind } : {}) })));
  await fs.appendFile(B.file, copies.map(line).join(''));
  if (arm) {
    // Collected before the origin's marker exists: nothing can link it later.
    const Q0 = randomUUID(); await B.append([B.prompt('Successor prompt before the marker', Q0)]);
    await B.hook('UserPromptSubmit', Q0); await f.run();
  }
  const marker = { type: 'continued-in', timestamp: new Date(Date.UTC(2026, 9, 16, 13)).toISOString(), sessionId: A.sessionId, continuedInSessionId: B.sessionId };
  await fs.appendFile(A.file, line(marker));
  return { f, A, B, P: [P1, P2, P3], copies };
}

test('a verified continuation ends the origin at its marker, never recollects re-homed history and binds controls in the successor', async t => {
  const { f, A, B, P: [P1, P2, P3] } = await continued(t);
  // The worker may visit the successor before the origin links it; the second
  // pass sees both sides settled.
  await f.run();
  const settled = await f.run();
  assert.deepEqual(sessionCodes(settled, A.sessionId), []);
  assert(!JSON.stringify(settled.diagnostics).includes('CLAUDE_HISTORY_REQUIRES_REVIEW'));
  // The link is recorded once, from both registered transcripts.
  const link = (await readContinuedLink(f.store, A.sessionId)).value, pointer = await readContinuesLink(f.store, B.sessionId);
  assert.equal(link.to.sessionId, B.sessionId); assert.equal(link.lineage, A.sessionId); assert.deepEqual(link.to.sessionKinds, ['bg']);
  assert.equal(pointer.link.lineage, A.sessionId);
  const bBytes = await fs.readFile(B.file, 'utf8'), copyOfP3 = bBytes.split('\n').findIndex(text => text.includes(`"promptId":"${P3}"`));
  assert.equal(link.to.prefix.endByte, Buffer.byteLength(bBytes.split('\n').slice(0, copyOfP3 + 1).join('\n') + '\n'));
  // The successor's first own prompt, a typed control, is its excluded boundary.
  const Q1 = randomUUID(), [input, companion] = B.control('status', Q1), call = B.call('status');
  await B.append([input, companion]); await B.hook('UserPromptSubmit', Q1);
  const armed = await f.run();
  assert.deepEqual(armed.boundaryExcluded.filter(item => item.sessionId === B.sessionId), [{ client: 'claude', sessionId: B.sessionId, unitId: Q1 }]);
  await B.append([call]);
  const bound = await B.resolve(call);
  assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, Q1); assert.equal(bound.captureActive, true);
  assert.deepEqual(bound.chatLineage, { client: 'claude', sessionId: A.sessionId });
  // Later successor prompts are collected under the successor's own identity.
  const Q2 = randomUUID();
  await B.append([B.reply('Status shown.'), B.prompt('Synthetic decision after the move', Q2)]); await B.hook('UserPromptSubmit', Q2);
  const later = await f.run();
  assert.equal(later.saved, 1); assert.deepEqual(sessionCodes(later, B.sessionId), []);
  assert.deepEqual((await B.head(Q2)).capture.evidence.map(item => item.text), ['Synthetic decision after the move']);
  // Re-homed units are neither captured twice nor captured from before the floor.
  for (const unitId of [P1, P2, P3]) assert.equal((await B.head(unitId)).head, null);
  assert.equal((await A.head(P1)).head, null); assert.equal((await A.head(P2)).head, null);
  assert.deepEqual((await A.head(P3)).capture.evidence.map(item => item.text), ['Synthetic decision before the move']);
  // Bytes after the terminal marker are not read; they keep the origin in review.
  await A.append([A.prompt('Late origin prompt', randomUUID())]);
  const late = await f.run();
  assert.deepEqual(sessionCodes(late, A.sessionId), ['CLAUDE_HISTORY_REQUIRES_REVIEW']);
  assert.equal((await readContinuedLink(f.store, A.sessionId)).value.linkedAt, link.linkedAt);
});

// Claude CLI writes a background successor's transcript, re-homed history
// first, only at its first prompt. That history holds prompts under the
// successor's own ID; only its own first prompt may satisfy the floor the
// worker freezes.
test('a successor\'s re-homed history alone never satisfies the floor the worker freezes', async t => {
  const { f, B } = await continued(t, { register: false });
  const Q1 = randomUUID(), staged = `${B.file}.staged`;
  // The hook runs before the transcript exists; then only the history is there.
  await fs.rename(B.file, staged); await B.hook('UserPromptSubmit', Q1); await fs.rename(staged, B.file);
  await f.run(); await f.run();
  assert(await readContinuesLink(f.store, B.sessionId));
  await assert.rejects(floorOf(f, B), { code: 'ENOENT' });
  // The prompt lands: the floor holds it, and its typed control binds.
  await B.append([...B.control('review', Q1), B.snapshot()]);
  await f.run();
  assert.equal((await floorOf(f, B)).snapshot.eofByte, (await fs.stat(B.file)).size);
  const call = B.call('review'); await B.append([call]);
  assert.equal((await B.resolve(call)).unitId, Q1);
});

test('the origin of a verified continuation refuses a command typed in it again', async t => {
  const { f, A } = await continued(t);
  await f.run(); await f.run();
  assert(await readContinuedLink(f.store, A.sessionId));
  // The origin resumed after the move: its own typed command binds nothing.
  const R = randomUUID(), call = A.call('save k2mn9p');
  await A.append([...A.control('save k2mn9p', R), call]);
  await assert.rejects(A.resolve(call), { code: 'PROCESSING_CHAT_CONTINUED' });
});

test('the successor reader refuses a re-homed prefix rewritten in place after the link', async t => {
  const { f, A, B } = await continued(t);
  await f.run(); await f.run();
  const link = (await readContinuedLink(f.store, A.sessionId)).value;
  // Same file identity, same length, different bytes inside the boundary record.
  const bytes = await fs.readFile(B.file), at = bytes.indexOf('before the move', link.to.prefix.startByte);
  assert(at > link.to.prefix.startByte && at < link.to.prefix.endByte);
  const handle = await fs.open(B.file, 'r+');
  try { await handle.write(Buffer.from('before the mova'), 0, 15, at); } finally { await handle.close(); }
  assert.deepEqual(sessionCodes(await f.run(), B.sessionId), ['SOURCE_CHANGED']);
  assert.equal((await B.selection()).state, null);
});

test('a successor registered at its first prompt binds that control through the floor past it', async t => {
  const { f, A, B } = await continued(t, { register: false });
  const Q1 = randomUUID();
  await B.append([...B.control('review', Q1), B.snapshot()]);
  await B.hook('UserPromptSubmit', Q1);
  await f.run(); await f.run();
  assert(await readContinuesLink(f.store, B.sessionId));
  const call = B.call('review'); await B.append([call]);
  const bound = await B.resolve(call);
  assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, Q1); assert.equal(bound.captureActive, false);
  assert.deepEqual(bound.chatLineage, { client: 'claude', sessionId: A.sessionId });
});

test('a re-homed prefix rewritten in place behind the floor neither binds in the lineage nor collects', async t => {
  const { f, A, B } = await continued(t, { register: false });
  const Q1 = randomUUID();
  await B.append([...B.control('review', Q1), B.snapshot()]);
  await B.hook('UserPromptSubmit', Q1);
  await f.run(); await f.run();
  const link = (await readContinuedLink(f.store, A.sessionId)).value;
  const call = B.call('review'); await B.append([call]);
  assert.deepEqual((await B.resolve(call)).chatLineage, { client: 'claude', sessionId: A.sessionId });
  // Same file identity and length, different bytes inside the boundary record.
  // The floor and the binding window both start past it, so only the pinned
  // record itself can show the change.
  const bytes = await fs.readFile(B.file), at = bytes.indexOf('before the move', link.to.prefix.startByte);
  assert(at > link.to.prefix.startByte && at < link.to.prefix.endByte);
  const handle = await fs.open(B.file, 'r+');
  try { await handle.write(Buffer.from('before the mova'), 0, 15, at); } finally { await handle.close(); }
  await assert.rejects(B.resolve(call), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(sessionCodes(await f.run(), B.sessionId), ['SOURCE_CHANGED']);
  assert.equal((await B.selection()).state, null);
  assert.equal((await readContinuedLink(f.store, A.sessionId)).value.linkedAt, link.linkedAt);
});

test('an excluded route refuses a linked, armed successor before any transcript read', async t => {
  const { f, A, B } = await continued(t);
  await f.run(); await f.run();
  const Q1 = randomUUID(), [input, companion] = B.control('status', Q1), call = B.call('status');
  await B.append([input, companion]); await B.hook('UserPromptSubmit', Q1); await f.run();
  await B.append([call]);
  assert.deepEqual((await B.resolve(call)).chatLineage, { client: 'claude', sessionId: A.sessionId });
  // Policy changes after the link and the arming. With the transcript gone, a
  // read of its header or pinned prefix record before the authorization check
  // would surface as a file error instead of the refusal.
  f.config.routes[0].excluded = true;
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes, { mode: 0o600 });
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  await fs.rm(B.file);
  await assert.rejects(B.resolve(call, capability), { code: 'WORKFLOW_NOT_AUTHORIZED' });
});

test('a fresh session continued right after its first-prompt control still links and its successor decides in the same lineage', async t => {
  const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
  await A.append([A.meta('mode', { mode: 'normal' }), ...A.control('review', P1), A.snapshot()]);
  await A.hook('UserPromptSubmit', P1); await f.run();
  const call = A.call('review'); await A.append([call]);
  assert.equal((await A.resolve(call)).nativeSkill, true);
  // Moved to a background session before any second prompt: the origin was never armed.
  const B = f.session(randomUUID(), { kind: 'bg' });
  await B.append([B.meta('agent-name', { agentName: 'synthetic' })]);
  await B.hook('SessionStart', null, { source: 'resume' });
  await fs.appendFile(B.file, A.rows.filter(row => ['user', 'assistant'].includes(row.type))
    .map(row => line({ ...row, sessionId: B.sessionId, sessionKind: 'bg' })).join(''));
  await fs.appendFile(A.file, line({ type: 'continued-in', timestamp: new Date(Date.UTC(2026, 9, 16, 13)).toISOString(), sessionId: A.sessionId, continuedInSessionId: B.sessionId }));
  await f.run();
  const settled = await f.run();
  assert.equal((await readContinuesLink(f.store, B.sessionId)).link.lineage, A.sessionId);
  assert.deepEqual(sessionCodes(settled, A.sessionId), []);
  assert.equal((await A.selection()).state, null);
  const Q1 = randomUUID(), [input, companion] = B.control('save k2mn9p', Q1), decision = B.call('save k2mn9p');
  await B.append([input, companion]); await B.hook('UserPromptSubmit', Q1); await f.run();
  await B.append([decision]);
  const bound = await B.resolve(decision);
  assert.equal(bound.nativeSkill, true); assert.equal(bound.typedControl, 'save k2mn9p');
  assert.deepEqual(bound.chatLineage, { client: 'claude', sessionId: A.sessionId });
  assert.equal((await B.head(P1)).head, null);
});

test('a marker alone, an unregistered, agent, sidechain, other-kind or mismatched successor never joins a lineage', async t => {
  const cases = {
    'no registered successor': { register: false },
    'changed re-homed input': { rehome: rows => rows.map(row => row.message?.content === 'Synthetic decision before the move'
      ? { ...row, message: { ...row.message, content: 'Altered decision' } } : row) },
    'missing re-homed input': { rehome: rows => rows.filter(row => row.message?.content !== 'Synthetic decision before the move') },
    'agent rows': { rehome: rows => rows.map(row => ({ ...row, agentId: 'a1b2c3' })) },
    'sidechain rows': { rehome: rows => rows.map(row => ({ ...row, isSidechain: true })) },
    'daemon session kind': { successorKind: 'daemon' },
    'not the sibling transcript': { sibling: false },
  };
  for (const [name, options] of Object.entries(cases)) await t.test(name, async t => {
    const { f, A, B } = await continued(t, options);
    await f.run(); await f.run();
    assert.equal(await readContinuedLink(f.store, A.sessionId), null);
    assert.equal(await readContinuesLink(f.store, B.sessionId), null);
    // The origin keeps its marker diagnostic and nothing after the marker.
    assert.deepEqual(sessionCodes(await f.run(), A.sessionId), ['CLAUDE_HISTORY_REQUIRES_REVIEW']);
    if (options.register === false) return; // An unregistered transcript is never read.
    // The successor stays unarmed, and a control typed there is not bound.
    const Q1 = randomUUID(), [input, companion] = B.control('status', Q1), call = B.call('status');
    await B.append([input, companion, call]); await B.hook('UserPromptSubmit', Q1); await f.run();
    assert.equal((await B.selection()).state, null);
    await assert.rejects(B.resolve(call));
  });
});

test('a successor collected on its own before any link is never joined afterwards', async t => {
  const { f, A, B } = await continued(t, { successorKind: null, arm: true });
  assert((await B.selection()).state);
  await f.run(); await f.run();
  assert.equal(await readContinuedLink(f.store, A.sessionId), null);
  assert.equal(await readContinuesLink(f.store, B.sessionId), null);
  assert.deepEqual(sessionCodes(await f.run(), A.sessionId), ['CLAUDE_HISTORY_REQUIRES_REVIEW']);
});

// Claude CLI 2.1.302 creates a fresh session's transcript only after the hooks
// of its first prompt ran: neither the registration nor that prompt's wake
// holds a floor, and only the worker can freeze one.
const floorOf = async (f, s) => JSON.parse(await fs.readFile(path.join(f.collection.intakeStateDir,
  registrationFloorPath({ client: 'claude', sessionId: s.sessionId })), 'utf8'));
test('a fresh session whose transcript is born after its prompt hook binds its first typed control', async t => {
  for (const control of ['review', 'save k2mn9p']) await t.test(control, async t => {
    const f = await claudeFixture(t), A = f.session(), [P1, P2, P3] = [randomUUID(), randomUUID(), randomUUID()];
    assert.equal((await A.hook('SessionStart')).status, 'pending-source');
    assert.equal((await A.hook('UserPromptSubmit', P1)).status, 'pending-source');
    await A.append([A.meta('mode', { mode: 'normal' }), ...A.control(control, P1), A.snapshot()]);
    assert.deepEqual(sessionCodes(await f.run(), A.sessionId), ['NATIVE_BOUNDARY_PENDING']);
    // The worker froze the floor itself, past the persisted first prompt.
    assert.equal((await floorOf(f, A)).snapshot.eofByte, (await fs.stat(A.file)).size);
    const call = A.call(control); await A.append([call]);
    const bound = await A.resolve(call);
    assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, P1); assert.equal(bound.typedControl, control);
    assert.equal(bound.captureActive, false); assert.equal((await A.selection()).state, null);
    // Later is never wider: the next prompt is the excluded boundary and only
    // the one after it is collected.
    await A.append([A.reply('Shown.'), A.prompt('Boundary after the first control', P2)]); await A.hook('UserPromptSubmit', P2);
    assert.deepEqual((await f.run()).boundaryExcluded, [{ client: 'claude', sessionId: A.sessionId, unitId: P2 }]);
    await A.append([A.reply('Noted.'), A.prompt('Synthetic decision: ship the cedar cache change', P3)]); await A.hook('UserPromptSubmit', P3);
    assert.equal((await f.run()).saved, 1);
    assert.equal((await A.head(P1)).head, null); assert.equal((await A.head(P2)).head, null);
    assert.deepEqual((await A.head(P3)).capture.evidence.map(item => item.text), ['Synthetic decision: ship the cedar cache change']);
  });
});

test('only a prompt wake lets the worker freeze a floor; it waits briefly for a transcript still missing', async t => {
  await t.test('a SessionStart wake alone freezes nothing', async t => {
    const f = await claudeFixture(t), A = f.session();
    await A.hook('SessionStart'); await A.append([A.meta('mode', { mode: 'normal' })]);
    assert.deepEqual(sessionCodes(await f.run(), A.sessionId), ['SOURCE_BOUNDARY_PENDING']);
    await assert.rejects(floorOf(f, A), { code: 'ENOENT' });
  });
  await t.test('a worker woken before the file exists', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.hook('SessionStart'); await A.hook('UserPromptSubmit', P1);
    // The transcript appears, complete, while the worker is already waiting
    // (past its storage checks, within its bounded wait).
    const rows = [A.meta('mode', { mode: 'normal' }), ...A.control('review', P1)], staged = `${A.file}.staged`;
    await fs.writeFile(staged, rows.map(line).join(''));
    const timer = setTimeout(() => { void fs.rename(staged, A.file); }, 600);
    t.after(() => clearTimeout(timer));
    assert.deepEqual(sessionCodes(await f.run({ trigger: { client: 'claude', sessionId: A.sessionId } }), A.sessionId), ['NATIVE_BOUNDARY_PENDING']);
    assert.equal((await floorOf(f, A)).snapshot.eofByte, (await fs.stat(A.file)).size);
    const call = A.call('review'); await A.append([call]);
    assert.equal((await A.resolve(call)).unitId, P1);
  });
  await t.test('a transcript that holds only bookkeeping when the worker first looks', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.hook('SessionStart'); await A.hook('UserPromptSubmit', P1);
    // Claude creates the file with bookkeeping first; the rows that identify
    // the session, with the prompt, follow while the worker is still waiting.
    await A.append([A.meta('mode', { mode: 'normal' })]);
    const rows = A.control('review', P1), timer = setTimeout(() => { void fs.appendFile(A.file, rows.map(line).join('')); }, 300);
    t.after(() => clearTimeout(timer));
    assert.deepEqual(sessionCodes(await f.run({ trigger: { client: 'claude', sessionId: A.sessionId } }), A.sessionId), ['NATIVE_BOUNDARY_PENDING']);
    assert.equal((await floorOf(f, A)).snapshot.eofByte, (await fs.stat(A.file)).size);
    const call = A.call('review'); await A.append([call]);
    assert.equal((await A.resolve(call)).unitId, P1);
  });
  // The CI interleaving, made deterministic: the identifying rows and the prompt
  // land after the worker froze the floor at the bookkeeping, before it reads
  // the header. The header must lie within the floor it freezes, so that pass
  // retries and the first prompt stays before the floor.
  await t.test('the identifying rows land between freezing the floor and reading the header', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.hook('SessionStart'); await A.hook('UserPromptSubmit', P1);
    await A.append([A.meta('mode', { mode: 'normal' })]);
    const rows = A.control('review', P1), open = fs.open;
    let landed = false;
    t.mock.method(fs, 'open', async function (file, ...args) {
      if (!landed && path.basename(String(file)) === path.basename(A.file)) {
        landed = true; await fs.appendFile(A.file, rows.map(line).join(''));
      }
      return open.call(this, file, ...args);
    });
    assert.deepEqual(sessionCodes(await f.run({ trigger: { client: 'claude', sessionId: A.sessionId } }), A.sessionId), ['NATIVE_BOUNDARY_PENDING']);
    assert(landed);
    t.mock.restoreAll();
    assert.equal((await floorOf(f, A)).snapshot.eofByte, (await fs.stat(A.file)).size);
    const call = A.call('review'); await A.append([call]);
    assert.equal((await A.resolve(call)).unitId, P1);
  });
  // A root attachment row can identify the session before its first prompt
  // is written; the floor must still hold that prompt.
  await t.test('the first prompt lands after an identifying attachment row and the frozen floor', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.hook('SessionStart'); await A.hook('UserPromptSubmit', P1);
    await A.append([A.meta('mode', { mode: 'normal' }), A.root('attachment', { attachment: { type: 'hook_additional_context', content: ['Synthetic context'] } })]);
    const rows = A.control('review', P1), open = fs.open;
    let landed = false;
    t.mock.method(fs, 'open', async function (file, ...args) {
      if (!landed && path.basename(String(file)) === path.basename(A.file)) {
        landed = true; await fs.appendFile(A.file, rows.map(line).join(''));
      }
      return open.call(this, file, ...args);
    });
    assert.deepEqual(sessionCodes(await f.run({ trigger: { client: 'claude', sessionId: A.sessionId } }), A.sessionId), ['NATIVE_BOUNDARY_PENDING']);
    assert(landed);
    t.mock.restoreAll();
    assert.equal((await floorOf(f, A)).snapshot.eofByte, (await fs.stat(A.file)).size);
    const call = A.call('review'); await A.append([call]);
    assert.equal((await A.resolve(call)).unitId, P1);
  });
  // Claude CLI 2.1.303 writes its API request snapshots before the first
  // identity row: far more than a 64 KiB header window.
  await t.test('a first-prompt control after a large request-snapshot prefix', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.hook('SessionStart'); await A.hook('UserPromptSubmit', P1);
    await A.append([A.meta('mode', { mode: 'normal' }), ...Array.from({ length: 8 }, () => A.snapshot()), ...A.control('review', P1)]);
    assert((await fs.stat(A.file)).size > 160 * 1024);
    assert.deepEqual(sessionCodes(await f.run({ trigger: { client: 'claude', sessionId: A.sessionId } }), A.sessionId), ['NATIVE_BOUNDARY_PENDING']);
    const call = A.call('review'); await A.append([call]);
    assert.equal((await A.resolve(call)).unitId, P1);
  });
  await t.test('only the session whose hook launched the worker waits for its file', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.hook('SessionStart'); await A.hook('UserPromptSubmit', P1);
    // Each run counts its looks at the missing transcript, not wall-clock
    // time, which a cold runner skews.
    const { lstat } = fs;
    const timed = async extra => {
      let looks = 0;
      const mock = t.mock.method(fs, 'lstat', async (file, ...args) => { if (String(file) === A.file) looks++; return lstat(file, ...args); });
      const started = performance.now();
      try { const result = await f.run(extra); return { result, looks, ms: performance.now() - started }; }
      finally { mock.mock.restore(); }
    };
    const background = await timed(), triggered = await timed({ trigger: { client: 'claude', sessionId: A.sessionId } });
    for (const { result } of [background, triggered]) assert.deepEqual(sessionCodes(result, A.sessionId), ['SOURCE_BOUNDARY_PENDING']);
    // The transcript never appears: the triggered visit polled it for its
    // bounded second; the background visit did not wait for it.
    assert(triggered.ms >= 1000, `${triggered.ms} ms`);
    assert(triggered.looks >= background.looks + 3, `${triggered.looks} vs ${background.looks} looks`);
    await assert.rejects(floorOf(f, A), { code: 'ENOENT' });
  });
  await t.test('a binding settles while the worker freezes the floor', async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.hook('SessionStart'); await A.hook('UserPromptSubmit', P1);
    await A.append([A.meta('mode', { mode: 'normal' }), ...A.control('review', P1)]);
    const call = A.call('review'); await A.append([call]);
    await assert.rejects(A.resolve(call), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' });
    const block = call.message.content[0];
    // Order, not timing: the worker runs up to saving the floor and saves it
    // once the binding has looked for it and missed; the binding's retries then
    // overlap the rest of the worker's pass and its writes.
    const floor = path.join(f.collection.intakeStateDir, registrationFloorPath({ client: 'claude', sessionId: A.sessionId }));
    let reached, release, binding = false, misses = 0;
    const atFloor = new Promise(resolve => { reached = resolve; }), released = new Promise(resolve => { release = resolve; });
    const { rename, lstat } = fs;
    t.mock.method(fs, 'rename', async (from, to, ...args) => {
      if (to === floor) { reached(); await released; }
      return rename(from, to, ...args);
    });
    t.mock.method(fs, 'lstat', async (file, ...args) => {
      try { return await lstat(file, ...args); }
      catch (error) { if (binding && file === floor && error.code === 'ENOENT' && ++misses === 2) release(); throw error; }
    });
    const worker = f.run();
    try {
      await Promise.race([atFloor, worker.then(() => assert.fail('the worker finished without saving the floor'))]);
      binding = true;
      const bound = await resolveProcessingInvocation(f.capability, { client: 'claude', sessionId: A.sessionId, toolCallId: block.id },
        { tool: 'processing_review', arguments: {} }, { skillPath: f.skillPath, settleMs: 1000 });
      assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, P1);
      assert(misses >= 2, 'the binding looked for the floor before the worker saved it');
    } finally { release(); await worker; }
    assert.equal((await floorOf(f, A)).snapshot.eofByte, (await fs.stat(A.file)).size);
  });
});

// A worker's writes can keep a private directory changing for longer than one
// storage check's own attempts. The churn source stands in for that writer
// deterministically: one directory change per verification attempt, so a
// check exhausts its attempts exactly when three in a row are churned.
const bindable = {
  'a fresh registered session': async t => {
    const f = await claudeFixture(t), A = f.session(), P1 = randomUUID();
    await A.hook('SessionStart'); await A.hook('UserPromptSubmit', P1);
    await A.append([A.meta('mode', { mode: 'normal' }), ...A.control('review', P1)]);
    assert.deepEqual(sessionCodes(await f.run(), A.sessionId), ['NATIVE_BOUNDARY_PENDING']);
    return { f, A, P1 };
  },
  'a processing-only session': async t => {
    const f = await claudeFixture(t, { collect: false }), A = f.session(), P1 = randomUUID();
    await A.append([...A.control('review', P1), A.snapshot()]);
    assert.equal((await A.hook('UserPromptSubmit', P1)).status, 'processing-only');
    return { f, A, P1 };
  },
};
async function churnBinding(t, kind = 'a fresh registered session') {
  const { f, A, P1 } = await bindable[kind](t);
  const call = A.call('review'); await A.append([call]);
  const block = call.message.content[0];
  const bind = (settleMs = 1000) => resolveProcessingInvocation(f.capability, { client: 'claude', sessionId: A.sessionId, toolCallId: block.id },
    { tool: 'processing_review', arguments: {} }, { skillPath: f.skillPath, settleMs });
  return { f, A, P1, bind, root: f.collection.intakeStateDir };
}
// Every transcript open, to show a settled storage check reads no more of it.
function transcriptOpens(t, file) {
  const open = fs.open; let count = 0;
  t.mock.method(fs, 'open', async (target, ...args) => { if (target === file) count++; return open(target, ...args); });
  return { get count() { return count; } };
}
test('storage churn from a concurrent writer settles within the binding window', async t => {
  for (const kind of Object.keys(bindable)) await t.test(`at every storage check of ${kind}`, async t => {
    const { A, P1, bind, root } = await churnBinding(t, kind);
    // Every check walks the intake root once per attempt.
    const clean = storageChurn(t, root, { attempts: 0 }), reads = transcriptOpens(t, A.file);
    assert.equal((await bind()).unitId, P1);
    const checks = clean.attempts, opened = reads.count;
    assert(checks > 10, `${checks} storage checks`);
    t.diagnostic(`${checks} storage checks, ${opened} transcript opens per binding`);
    t.mock.restoreAll();
    for (let from = 1; from <= checks; from++) {
      // Check `from` exhausts its three attempts; its repeat is churned once more.
      const churn = storageChurn(t, root, { from, attempts: 4 }), during = transcriptOpens(t, A.file);
      const bound = await bind();
      assert.equal(bound.unitId, P1, `check ${from}`); assert.equal(bound.nativeSkill, true);
      assert.equal(churn.churned, 4, `check ${from}`); assert.equal(during.count, opened, `check ${from}`);
      t.mock.restoreAll();
    }
  });
  await t.test('churn the window cannot absorb refuses with the storage code', async t => {
    const { P1, bind, root } = await churnBinding(t);
    // No window: the first check's exhausted churn is the refusal, unrepeated.
    let churn = storageChurn(t, root, { attempts: 4 });
    await assert.rejects(bind(0), { code: 'PRIVATE_STORAGE_CHANGED' });
    assert.equal(churn.attempts, 3);
    t.mock.restoreAll();
    // Endless churn: each repeat exhausts as well, within the step's attempts.
    churn = storageChurn(t, root);
    await assert.rejects(bind(), { code: 'PRIVATE_STORAGE_CHANGED' });
    assert(churn.attempts > 3 && churn.attempts <= 15, `${churn.attempts} attempts`);
    t.mock.restoreAll();
    assert.equal((await bind()).unitId, P1);
  });
});

test('a real storage change during the binding window fails closed at once, even when undone at once', async t => {
  const link = (target, file) => fs.symlink(target, file, process.platform === 'win32' ? 'junction' : 'dir');
  const replace = async ({ root }) => { await fs.rename(root, `${root}-original`); await fs.mkdir(root, { mode: 0o700 }); };
  const restore = async ({ root }) => { await fs.rmdir(root); await fs.rename(`${root}-original`, root); };
  // `during`: after the attempt's walk pinned the root; otherwise just before it.
  const changes = {
    'an intake root replaced between attempts': { change: replace, undo: restore, code: 'PRIVATE_STORAGE_CHANGED' },
    // On Windows the replacement lacks the private ACL, which that attempt's
    // permission check refuses before it compares identities.
    'an intake root replaced during an attempt': { during: true, change: replace, undo: restore,
      code: process.platform === 'win32' ? 'STORAGE_NOT_PRIVATE' : 'PRIVATE_STORAGE_CHANGED' },
    'a symlinked intake root': { during: true, code: 'UNSAFE_PRIVATE_STORAGE',
      change: async ({ root }) => { await fs.rename(root, `${root}-moved`); await link(`${root}-moved`, root); },
      undo: async ({ root }) => { await fs.unlink(root); await fs.rename(`${root}-moved`, root); } },
    'a relocated storage folder': { during: true, code: 'UNSAFE_PRIVATE_STORAGE',
      change: async ({ f }) => { await fs.rename(f.root, `${f.root}-moved`); await link(`${f.root}-moved`, f.root); },
      undo: async ({ f }) => { await fs.unlink(f.root); await fs.rename(`${f.root}-moved`, f.root); } },
    // POSIX modes; Windows ACLs are queried afresh on every attempt.
    ...(process.platform === 'win32' ? {} : { 'a mode change on the intake root': { during: true, code: 'PRIVATE_STORAGE_CHANGED',
      change: ({ root }) => fs.chmod(root, 0o750), undo: ({ root }) => fs.chmod(root, 0o700) } }),
  };
  for (const [name, { during = false, change, undo, code }] of Object.entries(changes)) await t.test(name, async t => {
    const context = await churnBinding(t), { P1, bind, root } = context;
    // The first check exhausts its churn, so the change lands in its repeat.
    // Only a further attempt undoes it first, and that attempt would bind.
    const churn = directoryChurn(root);
    let changed = false, undone = false;
    const seen = onVerificationAttempt(t, root, {
      before: async n => {
        if (n === 4 && !during) { await change(context); changed = true; }
        if (n === 5) { await undo(context); undone = true; }
      },
      after: async n => {
        if (n <= 3) await churn();
        if (n === 4 && during) { await change(context); changed = true; }
      },
    });
    try { await assert.rejects(bind(), { code }); }
    finally { if (changed && !undone) await undo(context); }
    assert.equal(seen.attempts, 4);
    t.mock.restoreAll();
    assert.equal((await bind()).unitId, P1);
  });
  // A replacement that keeps churning is still a replacement: the capability's
  // pinned root is compared on every attempt, so the repeat that meets it fails
  // closed and never reaches the next repeat, after the original is restored.
  await t.test('an intake root replaced while churning, restored before the next repeat', async t => {
    const context = await churnBinding(t), { P1, bind, root } = context;
    const churn = directoryChurn(root);
    let replaced = false, restored = false;
    const seen = onVerificationAttempt(t, root, {
      before: async n => {
        if (n === 4) { await replace(context); replaced = true; }
        if (n === 7) { await restore(context); restored = true; }
      },
      after: async n => { if (n <= 6) await churn(); },
    });
    try { await assert.rejects(bind(), { code: 'PRIVATE_STORAGE_CHANGED' }); }
    finally { if (replaced && !restored) await restore(context); }
    assert.equal(seen.attempts, 4); assert.equal(restored, false);
    t.mock.restoreAll();
    assert.equal((await bind()).unitId, P1);
  });
});

// Claude CLI 2.1.302 `/bg`: the origin's marker is followed by session
// bookkeeping, and the successor's file holds only metadata until its first
// prompt, which writes the re-homed history (rows also naming the origin in an
// extra `session_id`) and that prompt together.
async function moved(t, { tail = (A, B) => [A.meta('cost-state', { totalCostUSD: 0 }), { type: 'file-history-snapshot', messageId: randomUUID(), snapshot: {}, isSnapshotUpdate: false },
  A.meta('last-prompt', { lastPrompt: 'Synthetic last prompt', leafUuid: randomUUID() }), A.meta('cost-state', { totalCostUSD: 0 })] } = {}) {
  const f = await claudeFixture(t), A = f.session(), [P1, P2, P3] = [randomUUID(), randomUUID(), randomUUID()];
  await A.append([A.meta('mode', { mode: 'normal' }), A.prompt('Kickoff context', P1), A.snapshot()]);
  await A.hook('UserPromptSubmit', P1); await f.run();
  await A.append([A.reply('Ready.'), A.prompt('Boundary prompt', P2)]); await A.hook('UserPromptSubmit', P2); await f.run();
  await A.append([A.reply('Okay.'), A.prompt('Synthetic decision before the move', P3), A.reply('Recorded.')]);
  await A.hook('UserPromptSubmit', P3); assert.equal((await f.run()).saved, 1);
  const B = f.session(randomUUID(), { kind: 'bg' });
  await B.append([B.meta('ai-title', { aiTitle: 'Synthetic title' }), B.meta('agent-name', { agentName: 'synthetic' })]);
  await B.hook('SessionStart', null, { source: 'startup' });
  await A.append([{ type: 'continued-in', timestamp: new Date(Date.UTC(2026, 9, 16, 13)).toISOString(), sessionId: A.sessionId, continuedInSessionId: B.sessionId },
    ...tail(A, B)]);
  return { f, A, B, P: [P1, P2, P3] };
}
const firstPromptAfterMove = async ({ f, A, B }, control) => {
  const Q1 = randomUUID();
  await B.append([B.meta('mode', { mode: 'normal' }), ...A.rows.filter(row => ['user', 'assistant', 'system', 'attachment'].includes(row.type))
    .map((row, i) => ({ ...row, sessionId: B.sessionId, sessionKind: 'bg', ...(i % 2 ? { session_id: A.sessionId } : {}) })), ...B.control(control, Q1)]);
  await B.hook('UserPromptSubmit', Q1);
  return Q1;
};
const triggerFirst = async f => intakeJSON(await intakeSnapshot(f.store, 'state', schedulerPath))?.triggerFirst ?? true;

test('a 2.1.302 continuation links past the bookkeeping after its marker and a first typed save in the background session binds', async t => {
  const m = await moved(t), { f, A, B } = m;
  // Make this pass visit the successor first: it must still link and arm.
  if (!await triggerFirst(f)) await f.run();
  const Q1 = await firstPromptAfterMove(m, 'save k2mn9p');
  const pass = await f.run({ trigger: { client: 'claude', sessionId: B.sessionId } });
  assert.deepEqual(sessionCodes(pass, A.sessionId), []); assert.deepEqual(sessionCodes(pass, B.sessionId), []);
  assert.deepEqual(pass.boundaryExcluded.filter(item => item.sessionId === B.sessionId), [{ client: 'claude', sessionId: B.sessionId, unitId: Q1 }]);
  assert.equal((await readContinuesLink(f.store, B.sessionId)).link.lineage, A.sessionId);
  const call = B.call('save k2mn9p'); await B.append([call]);
  const bound = await B.resolve(call);
  assert.equal(bound.nativeSkill, true); assert.equal(bound.typedControl, 'save k2mn9p'); assert.equal(bound.unitId, Q1);
  assert.deepEqual(bound.chatLineage, { client: 'claude', sessionId: A.sessionId });
  // The origin stays terminal and clean under more bookkeeping; a root row after
  // the marker still keeps it in review.
  await A.append([A.meta('cost-state', { totalCostUSD: 0 })]);
  assert.deepEqual(sessionCodes(await f.run(), A.sessionId), []);
  await A.append([A.prompt('Late origin prompt', randomUUID())]);
  assert.deepEqual(sessionCodes(await f.run(), A.sessionId), ['CLAUDE_HISTORY_REQUIRES_REVIEW']);
});

test('only bookkeeping of the origin may follow its marker; anything else never links', async t => {
  const cases = {
    'a root row': (A, B) => [A.meta('cost-state', {}), A.prompt('Typed after the move', randomUUID())],
    'a rewound last prompt': A => [A.meta('last-prompt', { leafUuid: randomUUID(), rewound: true })],
    'a queued prompt': A => [A.meta('queue-operation', { operation: 'enqueue', content: 'Queued after the move' })],
    'an API request snapshot': A => [A.snapshot()],
    'another discontinuity': A => [A.meta('bridge-session', { bridgeSessionId: 'cse_synthetic', lastSequenceNum: 0 })],
    'another session\'s row': (A, B) => [B.meta('cost-state', {})],
    'an unknown record type': A => [A.meta('future-bookkeeping', {})],
  };
  for (const [name, tail] of Object.entries(cases)) await t.test(name, async t => {
    const m = await moved(t, { tail }), { f, A, B } = m;
    await firstPromptAfterMove(m, 'status');
    await f.run(); const settled = await f.run();
    assert.equal(await readContinuesLink(f.store, B.sessionId), null);
    assert.deepEqual(sessionCodes(settled, A.sessionId), ['CLAUDE_HISTORY_REQUIRES_REVIEW']);
  });
  await t.test('a record still being written waits', async t => {
    const m = await moved(t, { tail: () => [] }), { f, A, B } = m;
    await fs.appendFile(A.file, '{"type":"cost-state","sessionId"');
    await firstPromptAfterMove(m, 'status');
    await f.run(); await f.run();
    assert.equal(await readContinuesLink(f.store, B.sessionId), null);
    await fs.appendFile(A.file, `:"${A.sessionId}"}\n`);
    await f.run(); const settled = await f.run();
    assert(await readContinuesLink(f.store, B.sessionId));
    assert.deepEqual(sessionCodes(settled, A.sessionId), []);
  });
});

test('a paused origin links only when nothing lies past its saved EOF', async t => {
  for (const later of [false, true]) await t.test(later ? 'bookkeeping after the pause' : 'nothing after the pause', async t => {
    const m = await moved(t), { f, A, B, P: [, , P3] } = m;
    const selected = await A.selection(), eofByte = (await fs.stat(A.file)).size;
    await withIntakeLock(f.store, tx => controlSelection(tx, { source: selected.state.source, expectedHash: selected.hash, authorize: async () => true,
      request: { id: randomUUID(), client: 'claude', sessionId: A.sessionId, operation: 'pause', unitId: P3, expectedRevision: selected.state.revision },
      boundary: { sourceIdentity: selected.state.source.fileIdentity, eofByte, startsMidRecord: false, unitId: P3, record: null } }));
    if (later) await A.append([A.meta('cost-state', { totalCostUSD: 0 })]);
    await firstPromptAfterMove(m, 'status');
    await f.run(); await f.run();
    // Bytes past the saved EOF are never read, so they cannot show that the
    // marker ends the origin.
    assert.equal(Boolean(await readContinuesLink(f.store, B.sessionId)), !later);
  });
  await t.test('growth between the marker read and its tail read', async t => {
    const m = await moved(t), { f, A, B, P: [, , P3] } = m;
    const selected = await A.selection(), eofByte = (await fs.stat(A.file)).size;
    await withIntakeLock(f.store, tx => controlSelection(tx, { source: selected.state.source, expectedHash: selected.hash, authorize: async () => true,
      request: { id: randomUUID(), client: 'claude', sessionId: A.sessionId, operation: 'pause', unitId: P3, expectedRevision: selected.state.revision },
      boundary: { sourceIdentity: selected.state.source.fileIdentity, eofByte, startsMidRecord: false, unitId: P3, record: null } }));
    await firstPromptAfterMove(m, 'status');
    // Claude appends a record right after the worker has read the marker.
    const bytes = await fs.readFile(A.file), at = bytes.indexOf('{"type":"continued-in"'), end = bytes.indexOf(10, at) + 1;
    let appended = false; const tailEnds = [];
    const observeRead = ({ offset, bytes: length, purpose }) => {
      if (purpose !== 'range') return;
      if (!appended && offset === at && length === end - at) { appended = true; appendFileSync(A.file, line(A.meta('cost-state', { totalCostUSD: 0 }))); }
      else if (offset === end) tailEnds.push(offset + length);
    };
    await f.run({ observeRead }); await f.run();
    assert.equal(appended, true); assert(tailEnds.length > 0);
    // No read reached past the saved EOF, and the marker stays unproven.
    assert(tailEnds.every(value => value <= eofByte), `tail reads ended at ${tailEnds}, past the saved EOF ${eofByte}`);
    assert.equal(await readContinuesLink(f.store, B.sessionId), null);
  });
});
