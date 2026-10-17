import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { openWorkflowIntake, openExplicitCaptureIntake, withIntakeLock } from './intake-io.mjs';
import { controlSelection, readSelection } from './intake-store.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { resolveProcessingInvocation, isProcessingInvocation } from './processing-native-invocation.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { collectionIngress, processingSourcePath } from './collection-ingress.mjs';

const stamp = '2026-10-10T12:00:00.000Z';
const line = value => JSON.stringify(value) + '\n';
const unavailable = { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' };
async function fixture(t, client = 'codex', { register = true, midRecord = false, collection = true, mode = 'manual', headerChanges = {} } = {}) {
  const f = await storageFixture(t, { fullSetup: false });
  if (!collection || mode !== 'manual') {
    f.config.routes[0].collection.enabled = collection; f.config.routes[0].processing.mode = mode;
    await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
    f.options.expectedConfigHash = digest(JSON.stringify(f.config));
    f.capability = await verifyWorkflowStorage(f.options);
  }
  const sessionId = randomUUID(), unitId = randomUUID(), previous = randomUUID();
  const source = { client, sessionId, path: path.join(f.project, 'native-session.jsonl'), projectRoot: f.project };
  const context = { client, sessionId, unitId: client === 'codex' ? unitId : null, toolCallId: 'call_synthetic_current' };
  const invocation = { tool: 'process', arguments: { collectionId: f.collection.id, requestId: randomUUID() } };
  const skillPath = path.join(f.root, 'synthetic-plugin', 'SKILL.md');
  const header = client === 'codex'
    ? { timestamp: stamp, ordinal: 0, type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: f.project,
      cli_version: '0.156.1', source: 'cli', history_mode: 'paginated', ...headerChanges } }
    : { type: 'system', subtype: 'init', uuid: randomUUID(), timestamp: stamp, sessionId,
      version: '2.1.280', cwd: f.project, isSidechain: false, parentUuid: null, message: { role: 'system', content: '' } };
  const preBoundary = client === 'codex'
    ? { timestamp: stamp, ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: previous, root_turn_id: previous } }
    : { type: 'user', uuid: randomUUID(), timestamp: stamp, sessionId, version: '2.1.280', cwd: f.project,
      isSidechain: false, parentUuid: header.uuid, promptId: previous, message: { role: 'user', content: 'Before selection' } };
  const prefix = line(header) + line(preBoundary) + (midRecord ? '{"unselectedPartial":' : '');
  await fs.writeFile(source.path, prefix);
  source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
  const store = await openWorkflowIntake(f.capability, { client, sessionId, cwd: f.project, unitId: null }, collection ? 'collect' : 'explicitProcess');
  const boundary = { sourceIdentity: source.fileIdentity, eofByte: Buffer.byteLength(prefix), startsMidRecord: midRecord,
    unitId: previous, record: { id: client === 'codex' ? 'codex:ordinal:1' : preBoundary.uuid,
      startByte: Buffer.byteLength(line(header)), endByte: Buffer.byteLength(line(header) + line(preBoundary)), hash: digest(line(preBoundary)) } };
  let selected = null;
  if (register) selected = await withIntakeLock(store, tx => controlSelection(tx, { source, boundary, expectedHash: null,
    request: { id: randomUUID(), operation: 'start', client, sessionId, unitId: previous, expectedRevision: 0 }, authorize: async () => true }));
  const nativeSkill = () => ({ timestamp: stamp, ordinal: 3, type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId,
    turn_id: unitId, item: { type: 'UserMessage', id: randomUUID(), content: [
      { type: 'skill', name: 'cuefluent-notes', path: skillPath }, { type: 'text', text: 'process' }] } } });
  const nativeCall = () => client === 'codex'
    ? { timestamp: stamp, ordinal: 4, type: 'response_item', payload: { type: 'function_call', id: randomUUID(),
      namespace: 'mcp__cuefluent_control', name: invocation.tool, arguments: JSON.stringify(invocation.arguments), call_id: context.toolCallId,
      internal_chat_message_metadata_passthrough: { turn_id: unitId } } }
    : { type: 'assistant', uuid: randomUUID(), timestamp: stamp, sessionId, version: '2.1.280', cwd: f.project,
      isSidechain: false, parentUuid: preBoundary.uuid, message: { role: 'assistant', content: [
        { type: 'tool_use', id: context.toolCallId, name: `mcp__cuefluent_control__${invocation.tool}`, input: structuredClone(invocation.arguments) }] } };
  const spacer = () => client === 'codex'
    ? { timestamp: stamp, ordinal: 2, type: 'event_msg', payload: { type: 'task_started', turn_id: unitId, root_turn_id: unitId } }
    : { type: 'user', uuid: randomUUID(), timestamp: stamp, sessionId, version: '2.1.280', cwd: f.project,
      isSidechain: false, parentUuid: preBoundary.uuid, promptId: unitId, message: { role: 'user', content: '/cuefluent-notes process' } };
  return { ...f, source, context, invocation, skillPath, boundary, selected, store, nativeSkill, nativeCall, spacer,
    append: rows => fs.appendFile(source.path, rows.map(line).join('')),
    resolve: (ctx = context, call = invocation) => resolveProcessingInvocation(f.capability, ctx, call, { skillPath, settleMs: 0 }) };
}

test('Codex typed native invocation binds the selected call and exact native skill input without writes', async t => {
  const f = await fixture(t); await f.append([f.spacer(), f.nativeSkill(), f.nativeCall()]);
  const config = await fs.readFile(f.options.configPath), source = await fs.readFile(f.source.path);
  const identity = { client: f.context.client, sessionId: f.context.sessionId };
  const selection = await readSelection(f.store, identity), directories = await fs.readdir(f.collection.intakeStateDir);
  const result = await f.resolve();
  assert.equal(isProcessingInvocation(result), true); assert.equal(isProcessingInvocation({ ...result }), false);
  assert.equal(isProcessingInvocation({ verified: true }), false);
  assert.equal(result.nativeSkill, true); assert.equal(result.unitId, f.context.unitId);
  assert.equal(result.callId, f.context.toolCallId); assert.equal(result.tool, 'mcp__cuefluent_control.process');
  assert.equal(result.argsHash, digest(canonicalJSON(f.invocation.arguments)));
  assert.deepEqual(result.selection, { client: 'codex', sessionId: f.context.sessionId, cwd: f.project, unitId: null });
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.source)); assert(Object.isFrozen(result.selection));
  assert.deepEqual(await fs.readFile(f.options.configPath), config); assert.deepEqual(await fs.readFile(f.source.path), source);
  assert.equal((await readSelection(f.store, identity)).hash, selection.hash);
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), directories);
});

test('Codex invocation rechecks resumed metadata in its selected tail', async t => {
  for (const [change, code] of [
    [{ cli_version: '0.200.0', thread_source: 'agent_created_thread' }, null],
    [{ parent_thread_id: randomUUID() }, 'UNSUPPORTED_SESSION_OWNERSHIP'],
    [{ history_mode: 'legacy' }, 'UNSUPPORTED_CODEX_HISTORY'],
  ]) {
    const f = await fixture(t, 'codex', { headerChanges: { thread_source: 'agent_created_thread' } });
    const first = JSON.parse((await fs.readFile(f.source.path, 'utf8')).split('\n')[0]);
    await f.append([{ ...first, ordinal: 2, payload: { ...first.payload, ...change } }, { ...f.spacer(), ordinal: 3 }, f.nativeCall()]);
    if (code) await assert.rejects(f.resolve(), { code });
    else assert.equal((await f.resolve()).callId, f.context.toolCallId);
  }
});

test('Claude maps formal shortcut controls through trusted companion and native skill attribution', async t => {
  for (const control of ['process', 'process repo', 'process chat', 'resume', 'status', 'review', 'cancel']) await t.test(control, async t => {
    const f = await fixture(t, 'claude');
    f.invocation.tool = control.startsWith('process') ? 'process_selected_captures' : `processing_${control}`;
    if (control.startsWith('process ')) f.invocation.arguments.scope = control.split(' ')[1];
    await fs.mkdir(path.dirname(f.skillPath), { recursive: true });
    await fs.writeFile(f.skillPath, '---\nname: cuefluent-notes\n---\n\nSynthetic control $ARGUMENTS\n');
    const skillCommand = 'cuefluent-notes:cuefluent-notes', input = f.spacer();
    input.message.content = `<command-message>${skillCommand}</command-message>\n<command-name>/${skillCommand}</command-name>\n<command-args>${control}</command-args>`;
    const companion = { ...input, uuid: randomUUID(), parentUuid: input.uuid, isMeta: true, turnCompanion: true,
      message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(f.skillPath)}\n\nSynthetic control ${control}\n` }] } };
    const call = f.nativeCall(); call.attributionSkill = skillCommand; call.attributionPlugin = 'cuefluent-notes';
    await f.append([input, companion, call]);
    const bound = await f.resolve();
    assert.equal(bound.nativeSkill, true); assert.equal(bound.unitId, input.promptId);
    assert.equal(bound.inputId, input.uuid); assert.equal(bound.companionId, companion.uuid);
    assert.equal(bound.companionHash, digest(line(companion)));
    assert.equal(bound.inputHash, digest(input.message.content));
    assert.equal(bound.skillExpansionHash, digest(companion.message.content[0].text));
  });
});

test('pasted Claude markup, unknown expansions and missing attribution never become native controls', async t => {
  const mutations = {
    pasted: (input) => { input.promptSource = 'sdk'; },
    companion: (_, companion) => { companion.turnCompanion = false; },
    body: (_, companion) => { companion.message.content[0].text += ' altered'; },
    attribution: (_, __, call) => { delete call.attributionSkill; },
    correction: input => { input.message.content += '\nCorrection: 606'; },
  };
  for (const [name, change] of Object.entries(mutations)) await t.test(name, async t => {
    const f = await fixture(t, 'claude'); await fs.mkdir(path.dirname(f.skillPath), { recursive: true });
    await fs.writeFile(f.skillPath, '---\nname: cuefluent-notes\n---\nSynthetic $ARGUMENTS\n');
    const input = f.spacer(), command = 'cuefluent-notes:cuefluent-notes';
    input.message.content = `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>process</command-args>`;
    const companion = { ...input, uuid: randomUUID(), parentUuid: input.uuid, isMeta: true, turnCompanion: true,
      message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(f.skillPath)}\n\nSynthetic process\n` }] } };
    const call = f.nativeCall(); call.attributionSkill = command; call.attributionPlugin = 'cuefluent-notes';
    change(input, companion, call); await f.append([input, companion, call]);
    const bound = await f.resolve(); assert.equal(bound.nativeSkill, false); assert.equal(bound.unitId, null);
  });
});

test('native call alone conveys no human approval or skill authorization; mixed corrections remain ordinary input', async t => {
  const f = await fixture(t), mixed = f.nativeSkill();
  mixed.payload.item.content[1].text = 'process; correction: the earlier rollout failed';
  await f.append([f.spacer(), mixed, f.nativeCall()]);
  const result = await f.resolve();
  assert.equal(result.nativeSkill, false); assert.equal(isProcessingInvocation(result), true);
  assert.equal(Object.hasOwn(result, 'approved'), false); assert.equal(Object.hasOwn(result, 'captureAuthorized'), false);
});

test('complete first records at the authorized boundary are preserved for both clients', async t => {
  const codex = await fixture(t); await codex.append([codex.nativeSkill(), codex.nativeCall()]);
  assert.equal((await codex.resolve()).nativeSkill, true);
  const claude = await fixture(t, 'claude'); await claude.append([claude.nativeCall()]);
  const result = await claude.resolve();
  assert.equal(isProcessingInvocation(result), true); assert.equal(result.nativeSkill, false); assert.equal(result.unitId, null);
});

test('Claude native assistant tool use binds the exact arguments without inferring prompt identity', async t => {
  const f = await fixture(t, 'claude'); await f.append([f.spacer(), f.nativeCall()]);
  const result = await f.resolve();
  assert.equal(result.tool, 'mcp__cuefluent_control__process'); assert.equal(result.unitId, null); assert.equal(result.nativeSkill, false);
  await assert.rejects(f.resolve({ ...f.context, toolCallId: 'toolu_forged' }), unavailable);
  await assert.rejects(f.resolve(f.context, { ...f.invocation, arguments: { ...f.invocation.arguments, collectionId: 'other' } }), unavailable);
});

test('Claude sidechain and non-assistant message roles cannot establish a root invocation', async t => {
  for (const mutate of [row => { row.isSidechain = true; }, row => { row.message.role = 'user'; }]) {
    const f = await fixture(t, 'claude'), call = f.nativeCall(); mutate(call);
    await f.append([f.spacer(), call]);
    await assert.rejects(f.resolve(), unavailable);
  }
});

test('forged call identity, tool name, namespace, arguments and turn binding are rejected', async t => {
  for (const mutate of [
    row => { row.payload.call_id = 'another-call'; },
    row => { row.payload.namespace = 'mcp__unrelated'; },
    row => { row.payload.name = 'save'; },
    row => { row.payload.arguments = '{broken'; },
    row => { row.payload.arguments = JSON.stringify({ forged: true }); },
    row => { row.payload.internal_chat_message_metadata_passthrough.turn_id = randomUUID(); }
  ]) {
    const f = await fixture(t), call = f.nativeCall(); mutate(call);
    await f.append([f.spacer(), f.nativeSkill(), call]);
    await assert.rejects(f.resolve(), unavailable);
  }
});

test('duplicate matching native call IDs fail closed while unrelated calls do not acquire authority', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, client), first = f.nativeCall(), second = f.nativeCall();
    await f.append([f.spacer(), first, second]);
    await assert.rejects(f.resolve(), unavailable);
  }
  const f = await fixture(t), unrelated = f.nativeCall(); unrelated.payload.call_id = 'unrelated';
  await f.append([f.spacer(), unrelated, f.nativeCall()]);
  assert.equal((await f.resolve()).callId, f.context.toolCallId);
});

test('unregistered sources cannot supply an implicit current-chat binding', async t => {
  const absent = await fixture(t, 'codex', { register: false });
  await absent.append([absent.spacer(), absent.nativeCall()]); await assert.rejects(absent.resolve(), unavailable);
});

test('paused collection retains bounded native processing, status and review bindings without resuming capture', async t => {
  for (const client of ['codex', 'claude']) await t.test(client, async t => {
    const f = await fixture(t, client);
    const paused = await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, expectedHash: f.selected.hash,
      request: { id: randomUUID(), operation: 'pause', client, sessionId: f.context.sessionId,
        unitId: f.boundary.unitId, expectedRevision: f.selected.state.revision },
      boundary: f.boundary, authorize: async () => true }));
    const config = await fs.readFile(f.options.configPath);
    for (const tool of ['processing_status', 'process_selected_captures', 'processing_review']) {
      f.invocation.tool = tool; f.context.toolCallId = `call_${tool}`;
      await f.append([f.spacer(), f.nativeCall()]);
      const bound = await f.resolve();
      assert.equal(isProcessingInvocation(bound), true); assert.equal(bound.tool.endsWith(tool), true);
      assert.equal(bound.captureActive, false); assert.equal(bound.selectionHash, paused.hash);
      assert.equal((await readSelection(f.store, { client, sessionId: f.context.sessionId })).hash, paused.hash);
    }
    assert.deepEqual(await fs.readFile(f.options.configPath), config);
    assert.equal(paused.state.active, false); assert.equal(paused.state.paused, true);
    assert.equal(paused.state.intervals.at(-1).upper.eofByte, f.boundary.eofByte);
  });
});

test('fresh policy and a selection change during source verification invalidate the binding', async t => {
  const f = await fixture(t); await f.append([f.spacer(), f.nativeCall()]);
  const original = fs.open; let changed = false;
  const mocked = t.mock.method(fs, 'open', async function(file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (file === f.source.path && !changed) {
      changed = true;
      await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, expectedHash: f.selected.hash,
        request: { id: randomUUID(), operation: 'exclude', client: 'codex', sessionId: f.context.sessionId, unitId: randomUUID(), expectedRevision: f.selected.state.revision },
        authorize: async () => true }));
    }
    return handle;
  });
  await assert.rejects(f.resolve(), unavailable); mocked.mock.restore();
  f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
  await assert.rejects(f.resolve(), { code: 'WORKFLOW_POLICY_CHANGED' });
});

test('an incomplete tool call is not accepted and a pre-boundary partial record is skipped', async t => {
  const incomplete = await fixture(t); await incomplete.append([incomplete.spacer(), incomplete.nativeSkill()]);
  await fs.appendFile(incomplete.source.path, JSON.stringify(incomplete.nativeCall()));
  await assert.rejects(incomplete.resolve(), unavailable);
  const partial = await fixture(t, 'claude', { midRecord: true });
  await fs.appendFile(partial.source.path, '"untrusted suffix"}\n');
  await partial.append([partial.nativeCall()]);
  assert.equal((await partial.resolve()).callId, partial.context.toolCallId);
});

test('a complete call may bind before an unrelated partial tail without authorizing any exclusion', async t => {
  const f = await fixture(t); await f.append([f.spacer(), f.nativeCall()]);
  await fs.appendFile(f.source.path, '{"type":"response_item","payload":');
  const result = await f.resolve();
  assert.equal(result.callId, f.context.toolCallId); assert.equal(result.nativeSkill, false);
  assert.equal(Object.hasOwn(result, 'exclusions'), false);
});

test('replacing the selected native source cannot bind an otherwise identical call', async t => {
  const f = await fixture(t); await f.append([f.spacer(), f.nativeCall()]);
  const bytes = await fs.readFile(f.source.path), replacement = path.join(f.project, 'replacement.jsonl');
  await fs.writeFile(replacement, bytes); await fs.rename(replacement, f.source.path);
  await assert.rejects(f.resolve(), { code: 'SOURCE_CHANGED' });
});

test('bounded recent inspection never inherits native skill authorization from an older prefix', async t => {
  const f = await fixture(t);
  const filler = { timestamp: stamp, type: 'response_item', payload: { type: 'function_call_output',
    call_id: 'unrelated', output: 'x'.repeat(120 * 1024) } };
  await f.append([f.spacer(), f.nativeSkill(), ...Array.from({ length: 20 }, () => filler), f.nativeCall()]);
  const result = await f.resolve();
  assert.equal(result.callId, f.context.toolCallId); assert.equal(result.nativeSkill, false);
});


test('Claude stale launch UUID rebinds only an exact native call in an already registered session', async t => {
  const f = await fixture(t, 'claude'); await f.append([f.spacer(), f.nativeCall()]);
  const actual = f.context.sessionId;
  f.context.sessionId = randomUUID();
  const bound = await f.resolve(); assert.equal(bound.selection.sessionId, actual);
  f.context.toolCallId = 'toolu_unknown'; await assert.rejects(f.resolve(), unavailable);
});

for (const client of ['codex', 'claude']) {
  test(`${client} processing-only hook binding supports all controls without collection`, async t => {
    const f = await fixture(t, client, { register: false, collection: false, mode: 'prompted' });
    const hook = () => collectionIngress(client, { session_id: f.context.sessionId, cwd: f.project,
      transcript_path: f.source.path, hook_event_name: 'UserPromptSubmit',
      [client === 'codex' ? 'turn_id' : 'prompt_id']: f.boundary.unitId }, {
      configPath: f.options.configPath, launch: () => assert.fail('processing-only ingress must not launch a worker') });
    const config = await fs.readFile(f.options.configPath), raw = await fs.readdir(f.collection.rawDir);
    // Metadata-only registration must not open the transcript, even to read its header.
    const original = fs.open;
    const mocked = t.mock.method(fs, 'open', async function(file, ...args) {
      assert.notEqual(file, f.source.path); return original.call(this, file, ...args);
    });
    assert.equal((await hook()).status, 'processing-only'); mocked.mock.restore();
    const record = path.join(f.collection.intakeStateDir, processingSourcePath(f.context, f.options.expectedConfigHash));
    const binding = await fs.readFile(record);
    for (const tool of ['processing_status', 'process_selected_captures', 'processing_review']) {
      f.invocation.tool = tool; f.context.toolCallId = `call_${tool}`;
      // The first complete record at the floor may itself be the invocation.
      await f.append([f.nativeCall()]);
      await hook(); // Repeated ingress must not move the floor past the call.
      const bound = await f.resolve();
      assert.equal(bound.captureActive, false); assert.equal(bound.selectionHash, null);
      assert.equal(bound.callId, f.context.toolCallId);
      assert.equal((await readSelection(f.store, { client, sessionId: f.context.sessionId })).state, null);
    }
    assert.deepEqual(await fs.readFile(record), binding); assert.deepEqual(await fs.readFile(f.options.configPath), config);
    assert.deepEqual(await fs.readdir(f.collection.rawDir), raw);
    for (const name of ['sessions', 'ingress/registrations', 'ingress/wake']) {
      await assert.rejects(fs.lstat(path.join(f.collection.intakeStateDir, name)), { code: 'ENOENT' });
    }
    if (client === 'claude') {
      const actual = f.context.sessionId; f.context.sessionId = randomUUID();
      assert.equal((await f.resolve()).selection.sessionId, actual);
      f.context.sessionId = actual;
    }
    // A changed source identity cannot inherit the processing floor.
    const old = JSON.parse(binding); old.snapshot.fileIdentity = digest('other source');
    await fs.writeFile(record, canonicalJSON(old) + '\n');
    await assert.rejects(f.resolve(), { code: 'SOURCE_CHANGED' });
  });

  test(`${client} manual explicit scopes allow native controls without an automatic interval`, async t => {
    const f = await fixture(t, client, { register: false, collection: false });
    const requestId = randomUUID();
    const explicit = await openExplicitCaptureIntake(f.capability, { client, sessionId: f.context.sessionId, cwd: f.project },
      { scopeId: requestId, unitIds: [f.boundary.unitId] });
    const selected = await withIntakeLock(explicit, tx => controlSelection(tx, { source: f.source, expectedHash: null,
      request: { id: requestId, operation: 'capture-current', client, sessionId: f.context.sessionId,
        unitId: f.boundary.unitId, expectedRevision: 0, scope: { unitIds: [f.boundary.unitId], start: f.boundary.record, end: null } },
      authorize: async () => true }));
    for (const tool of ['processing_status', 'process_selected_captures', 'processing_review']) {
      f.invocation.tool = tool; f.context.toolCallId = `call_${tool}`;
      await f.append([f.nativeCall()]); const bound = await f.resolve();
      assert.equal(bound.captureActive, false); assert.equal(bound.selectionHash, selected.hash);
    }
    assert.equal((await readSelection(f.store, { client, sessionId: f.context.sessionId })).hash, selected.hash);
    assert.equal(selected.state.active, false); assert.equal(selected.state.paused, false); assert.deepEqual(selected.state.intervals, []);
  });
}

test('Claude discovery ignores unrelated entries but rejects unsafe native candidates', async t => {
  const f = await fixture(t, 'claude'); await f.append([f.nativeCall()]);
  const directory = path.join(f.collection.intakeStateDir, 'sessions', 'claude');
  await fs.writeFile(path.join(directory, 'README.txt'), 'Unrelated metadata');
  await fs.mkdir(path.join(directory, '.stage'));
  const actual = f.context.sessionId; f.context.sessionId = randomUUID();
  assert.equal((await f.resolve()).selection.sessionId, actual);
  await fs.mkdir(path.join(directory, `${randomUUID()}.json`));
  await assert.rejects(f.resolve(), unavailable);
});

test('selection mutation during Claude skill loading invalidates the final binding', async t => {
  const f = await fixture(t, 'claude'); await fs.mkdir(path.dirname(f.skillPath), { recursive: true });
  await fs.writeFile(f.skillPath, '---\nname: cuefluent-notes\n---\nSynthetic $ARGUMENTS\n');
  await f.append([f.nativeCall()]);
  const original = fs.open; let changed = false;
  t.mock.method(fs, 'open', async function(file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (file === f.skillPath && !changed) {
      changed = true;
      await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, expectedHash: f.selected.hash,
        request: { id: randomUUID(), operation: 'exclude', client: 'claude', sessionId: f.context.sessionId,
          unitId: randomUUID(), expectedRevision: f.selected.state.revision }, authorize: async () => true }));
    }
    return handle;
  });
  await assert.rejects(f.resolve(), unavailable); assert.equal(changed, true);
});

test('processing hook floors exclude earlier calls and stale policy bindings cannot be reused', async t => {
  const f = await fixture(t, 'codex', { register: false, collection: false, mode: 'prompted' });
  await f.append([f.nativeCall()]);
  const payload = { session_id: f.context.sessionId, turn_id: f.boundary.unitId, cwd: f.project,
    transcript_path: f.source.path, hook_event_name: 'UserPromptSubmit' };
  await collectionIngress('codex', payload, { configPath: f.options.configPath, launch: () => assert.fail('no collection') });
  await assert.rejects(f.resolve(), unavailable);
  f.context.toolCallId = 'call_after_boundary'; await f.append([f.nativeCall()]);
  assert.equal((await f.resolve()).callId, 'call_after_boundary');
  const file = path.join(f.collection.intakeStateDir, processingSourcePath(f.context, f.options.expectedConfigHash));
  const bytes = await fs.readFile(file), value = JSON.parse(bytes);
  await fs.writeFile(file, bytes.toString().replace('"version":1', '"version":0,"version":1'));
  await assert.rejects(f.resolve(), unavailable);
  await fs.writeFile(file, bytes);
  f.config.routes[0].collection.generation = randomUUID();
  const config = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, config);
  const capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(config) });
  await assert.rejects(resolveProcessingInvocation(capability, f.context, f.invocation, { skillPath: f.skillPath }), unavailable);
  assert.equal(value.snapshot.eofByte, Buffer.byteLength(await fs.readFile(f.source.path)) - Buffer.byteLength(line(f.nativeCall())));
});

test('delayed Claude native persistence can settle without granting authority to a missing call', async t => {
  const f = await fixture(t, 'claude'); await f.append([f.spacer()]);
  const before = await fs.readFile(f.options.configPath);
  let appended;
  const timer = setTimeout(() => { appended = f.append([f.nativeCall()]); }, 80);
  t.after(() => clearTimeout(timer));
  const result = await resolveProcessingInvocation(f.capability, f.context, f.invocation, { skillPath: f.skillPath });
  await appended;
  assert.equal(isProcessingInvocation(result), true);
  assert.deepEqual(await fs.readFile(f.options.configPath), before);
  await assert.rejects(resolveProcessingInvocation(f.capability, { ...f.context, toolCallId: 'missing' }, f.invocation,
    { skillPath: f.skillPath, settleMs: 30 }), unavailable);
});
test('native persistence waits are cancelled before dispatch and keep invalid calls refused', async t => {
  const f = await fixture(t, 'claude'); await f.append([f.spacer()]);
  const abort = new AbortController();
  const pending = resolveProcessingInvocation(f.capability, f.context, f.invocation, { skillPath: f.skillPath, signal: abort.signal });
  abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  const call = f.nativeCall(); call.message.content[0].input = { altered: true }; await f.append([call]);
  await assert.rejects(resolveProcessingInvocation(f.capability, f.context, f.invocation, { skillPath: f.skillPath }), unavailable);
});

function nestedRows(f, result) {
  f.context.toolCallId = `exec-${randomUUID()}`; f.context.itemId = `ctc_${randomUUID()}`;
  const outer = { timestamp: stamp, ordinal: 4, type: 'response_item', payload: { type: 'custom_tool_call',
    id: f.context.itemId, call_id: 'outer', name: 'exec', input: 'Model-written code is not parsed for authority.',
    internal_chat_message_metadata_passthrough: { turn_id: f.context.unitId } } };
  const call = { timestamp: stamp, ordinal: 5, type: 'event_msg', payload: { type: 'item_completed',
    thread_id: f.context.sessionId, turn_id: f.context.unitId, item: { type: 'McpToolCall', id: f.context.toolCallId,
      server: 'cuefluent_control', tool: f.invocation.tool, arguments: f.invocation.arguments, status: 'completed', result } } };
  const output = { timestamp: stamp, ordinal: 6, type: 'response_item', metadata: { client_authored: false }, payload: {
    type: 'custom_tool_call_output', call_id: 'outer', output: 'Synthetic wrapper output', internal_chat_message_metadata_passthrough: { turn_id: f.context.unitId } } };
  return { outer, call, output };
}
test('Codex outer exec can request a handshake but only a completed exact inner call proves invocation', async t => {
  const f = await fixture(t), result = { content: [{ type: 'text', text: 'Synthetic challenge' }], isError: false };
  const rows = nestedRows(f, result); await f.append([f.spacer(), f.nativeSkill(), rows.outer]);
  const pending = await f.resolve(); assert.equal(pending.pending, true); assert.equal(isProcessingInvocation(pending), false);
  await f.append([rows.call, rows.output]);
  const bound = await f.resolve(); assert.equal(isProcessingInvocation(bound), true);
  assert.equal(bound.handshakeResultHash, digest(canonicalJSON(result))); assert.equal(bound.nativeSkill, false);
  assert.equal(bound.controlExclusionUnsupported, true);
});
test('Codex nested binding rejects forged metadata, arguments, duplicate calls and incomplete native results', async t => {
  for (const [name, change] of Object.entries({
    arguments: r => { r.call.payload.item.arguments = {}; },
    server: r => { r.call.payload.item.server = 'other'; },
    thread: r => { r.call.payload.thread_id = randomUUID(); },
    turn: r => { r.call.payload.turn_id = randomUUID(); },
    failure: r => { r.call.payload.item.status = 'failed'; },
    output: r => { r.output.metadata.client_authored = true; },
  })) await t.test(name, async t => {
    const f = await fixture(t), rows = nestedRows(f, { content: [], isError: false }); change(rows);
    await f.append([f.spacer(), rows.outer, rows.call, rows.output]); await assert.rejects(f.resolve(), unavailable);
  });
});

test('MCP handshake verifies native bytes end to end and refuses source replacement between calls', async t => {
  const { PassThrough, Writable } = await import('node:stream');
  const { runProcessingControlServer } = await import('./processing-control-server.mjs');
  for (const variant of ['verified retry', 'agent-created retry', 'replaced source', 'late pair', 'late output', 'never persisted']) await t.test(variant, async t => {
    const altered = variant === 'replaced source';
    const f = await fixture(t, 'codex', { headerChanges: variant === 'agent-created retry' ? { thread_source: 'agent_created_thread' } : {} }), r = nestedRows(f, null);
    await f.append([f.spacer(), r.outer]);
    const input = new PassThrough(), received = new Map(), waiting = new Map(); let calls = 0;
    const output = new Writable({ write(bytes, _e, done) {
      for (const line of bytes.toString().trim().split('\n')) {
        const row = JSON.parse(line); received.set(row.id, row); waiting.get(row.id)?.(row);
      }
      done();
    } });
    const send = (id, params, method = 'tools/call') => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const wait = id => received.get(id) ?? new Promise(resolve => waiting.set(id, resolve));
    const metadata = { callId: f.context.toolCallId, itemId: f.context.itemId,
      'x-codex-turn-metadata': { thread_id: f.context.sessionId, session_id: f.context.sessionId, turn_id: f.context.unitId } };
    // Use an actual exposed tool, with the real native resolver and storage guard.
    f.invocation.tool = 'process_selected_captures'; r.call.payload.item.tool = f.invocation.tool;
    const server = runProcessingControlServer({ client: 'codex', input, output,
      resolveSource: async (context, invocation, { signal, requireCompleted }) => ({ ...await resolveProcessingInvocation(f.capability, context, invocation,
        { skillPath: f.skillPath, signal, requireCompleted, settleMs: variant.startsWith('late') ? 1000 : 0 }), collectionId: f.collection.id }),
      getStatus: async () => { throw new Error('Unexpected status'); },
      requestProcessing: async () => { calls++; return { status: 'busy', nextAction: 'wait' }; }
    });
    send(0, { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } }, 'initialize'); await wait(0);
    send(1, { name: f.invocation.tool, arguments: f.invocation.arguments, _meta: metadata });
    const first = await wait(1); assert.equal(calls, 0);
    const retryToken = JSON.parse(first.result.content[0].text).retryToken;
    r.call.payload.item.result = first.result;
    if (variant === 'late output') await f.append([r.call]);
    else if (!variant.startsWith('late') && variant !== 'never persisted') await f.append([r.call, r.output]);
    if (variant.startsWith('late')) observeNativeReads(t, [f.source], async (_file, count) => {
      if (count === 1) await f.append(variant === 'late pair' ? [r.call, r.output] : [r.output]);
    });
    if (altered) {
      const bytes = await fs.readFile(f.source.path); await fs.rename(f.source.path, f.source.path + '.preserved');
      await fs.writeFile(f.source.path, bytes);
    }
    send(2, { name: f.invocation.tool, arguments: { ...f.invocation.arguments, retryToken },
      _meta: { ...metadata, callId: `exec-${randomUUID()}`, itemId: 'ctc_second' } });
    const second = await wait(2);
    assert.equal(calls, altered || variant === 'never persisted' ? 0 : 1);
    if (!altered && variant !== 'never persisted') assert.equal(JSON.parse(second.result.content[0].text).status, 'busy');
    else assert.ok(second.error);
    input.end(); await server;
  });
});

// More than a full tail per source reproduces cumulative-budget exhaustion.
const largeClaudeTail = () => Array.from({ length: 17 }, () => line({ type: 'system', content: 'x'.repeat(128 * 1024) })).join('');
async function registeredClaudeCandidates(f, count, { matchLast = false, tail = largeClaudeTail } = {}) {
  const first = (await fs.readFile(f.source.path, 'utf8')).split('\n').slice(0, 2).map(JSON.parse);
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const sessionId = randomUUID(), rows = first.map(row => ({ ...row, sessionId }));
    const prefix = rows.map(line).join(''), source = { ...f.source, sessionId, path: path.join(f.project, `${sessionId}.jsonl`) };
    const call = f.nativeCall(); call.sessionId = sessionId;
    await fs.writeFile(source.path, prefix + tail() + (matchLast && i === count - 1 ? line(call) : ''));
    source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
    const boundary = { ...f.boundary, sourceIdentity: source.fileIdentity, eofByte: Buffer.byteLength(prefix),
      record: { id: rows[1].uuid, startByte: Buffer.byteLength(line(rows[0])), endByte: Buffer.byteLength(prefix), hash: digest(line(rows[1])) } };
    candidates.push({ source, boundary });
  }
  for (const { source, boundary } of candidates) {
    const store = await openWorkflowIntake(f.capability, { client: 'claude', sessionId: source.sessionId, cwd: f.project }, 'collect');
    await withIntakeLock(store, tx => controlSelection(tx, { source, boundary, expectedHash: null,
      request: { id: randomUUID(), operation: 'start', client: 'claude', sessionId: source.sessionId,
        unitId: boundary.unitId, expectedRevision: 0 }, authorize: async () => true }));
  }
  return candidates.map(item => item.source);
}

// Append only after the native reader closes its first fixed snapshot. This
// deterministically exercises a missing record without wall-clock races.
function observeNativeReads(t, sources, afterRead = async () => {}) {
  const original = fs.open, reads = new Map(sources.map(source => [source.path, 0]));
  t.mock.method(fs, 'open', async function(file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (reads.has(file) && typeof args[0] === 'number') {
      reads.set(file, reads.get(file) + 1);
      const close = handle.close.bind(handle), count = reads.get(file);
      handle.close = async () => { await close(); await afterRead(file, count); };
    }
    return handle;
  });
  return reads;
}

test('Claude settles the primary tail without opening or scanning registered fallback sources', async t => {
  const f = await fixture(t, 'claude'); await fs.appendFile(f.source.path, largeClaudeTail());
  const candidates = await registeredClaudeCandidates(f, 20);
  const reads = observeNativeReads(t, [f.source, ...candidates], async (file, count) => {
    if (file === f.source.path && count === 1) await f.append([f.nativeCall()]);
  });
  t.mock.method(fs, 'opendir', async () => assert.fail('primary settling must not scan fallback directories'));
  const result = await resolveProcessingInvocation(f.capability, f.context, f.invocation, { skillPath: f.skillPath });
  assert.equal(result.callId, f.context.toolCallId); assert.equal(reads.get(f.source.path), 2);
  for (const candidate of candidates) assert.equal(reads.get(candidate.path), 0);
});

test('Claude fallback can read every full-sized candidate once after the bounded primary wait', async t => {
  const f = await fixture(t, 'claude'); await fs.appendFile(f.source.path, largeClaudeTail());
  const candidates = await registeredClaudeCandidates(f, 32, { matchLast: true });
  const reads = observeNativeReads(t, [f.source, ...candidates]);
  const result = await resolveProcessingInvocation(f.capability, f.context, f.invocation, { skillPath: f.skillPath });
  assert.equal(result.selection.sessionId, candidates.at(-1).sessionId);
  assert.ok(reads.get(f.source.path) >= 1 && reads.get(f.source.path) <= 5);
  for (const candidate of candidates) assert.equal(reads.get(candidate.path), 1);
});

test('a definitive Claude mismatch is not retried or hidden by a fallback match', async t => {
  const f = await fixture(t, 'claude');
  const bad = f.nativeCall(); bad.message.content[0].input = { changed: true }; await f.append([bad]);
  const candidates = await registeredClaudeCandidates(f, 1, { matchLast: true });
  const reads = observeNativeReads(t, [f.source, ...candidates]);
  t.mock.method(fs, 'opendir', async () => assert.fail('definitive refusal must not scan'));
  await assert.rejects(resolveProcessingInvocation(f.capability, f.context, f.invocation, { skillPath: f.skillPath }), unavailable);
  assert.equal(reads.get(f.source.path), 1); assert.equal(reads.get(candidates[0].path), 0);
});

for (const location of ['primary', 'fallback']) test(`Claude /clear skips an unavailable ${location} source`, async t => {
  for (const reason of ['safety stop', 'record limit', 'selection change']) await t.test(reason, async t => {
    const f = await fixture(t, 'claude');
    const candidates = await registeredClaudeCandidates(f, location === 'primary' ? 1 : 2, { matchLast: true, tail: () => '' });
    const rejected = location === 'primary' ? f.source : candidates[0], matching = candidates.at(-1);
    const selectionPath = path.join(f.collection.intakeStateDir, 'sessions', 'claude', `${rejected.sessionId}.json`);
    if (reason === 'safety stop') {
      const state = JSON.parse(await fs.readFile(selectionPath, 'utf8'));
      state.safetyStop = { reason: 'capacity', unitId: randomUUID() };
      await fs.writeFile(selectionPath, line(state));
    } else if (reason === 'record limit') {
      await fs.appendFile(rejected.path, line({ type: 'system', content: 'Synthetic record' }).repeat(4097));
    } else {
      const call = f.nativeCall(); call.sessionId = rejected.sessionId;
      await fs.appendFile(rejected.path, line(call));
    }
    let changedSelection;
    const rejectedBytes = await fs.readFile(rejected.path), beforeSelection = await fs.readFile(selectionPath);
    const reads = observeNativeReads(t, [f.source, ...candidates], async (file, count) => {
      if (reason !== 'selection change' || file !== rejected.path || count !== 1) return;
      const before = await readSelection(f.store, { client: 'claude', sessionId: rejected.sessionId });
      await withIntakeLock(f.store, tx => controlSelection(tx, { source: rejected, expectedHash: before.hash,
        request: { id: randomUUID(), operation: 'exclude', client: 'claude', sessionId: rejected.sessionId,
          unitId: randomUUID(), expectedRevision: before.state.revision }, authorize: async () => true }));
      changedSelection = await fs.readFile(selectionPath);
    });
    const bound = await f.resolve();
    assert.equal(isProcessingInvocation(bound), true);
    assert.equal(bound.selection.sessionId, matching.sessionId);
    assert.equal(bound.callId, f.context.toolCallId);
    assert.equal(reads.get(rejected.path), reason === 'safety stop' ? 0 : 1);
    assert.equal(reads.get(matching.path), 1);
    if (reason === 'selection change') assert.ok(changedSelection);
    assert.deepEqual(await fs.readFile(selectionPath), changedSelection ?? beforeSelection);
    assert.deepEqual(await fs.readFile(rejected.path), rejectedBytes);
  });
});

test('Claude fallback does not hide an invalid matching call behind a valid candidate', async t => {
  for (const rejection of ['arguments', 'tool', 'duplicate']) await t.test(rejection, async t => {
    const f = await fixture(t, 'claude');
    const [rejected] = await registeredClaudeCandidates(f, 2, { matchLast: true, tail: () => '' });
    const call = f.nativeCall(); call.sessionId = rejected.sessionId;
    if (rejection === 'arguments') call.message.content[0].input = { changed: true };
    if (rejection === 'tool') call.message.content[0].name = 'mcp__cuefluent_control__processing_review';
    await fs.appendFile(rejected.path, line(call).repeat(rejection === 'duplicate' ? 2 : 1));
    await assert.rejects(f.resolve(), unavailable);
  });
});

test('Claude cannot skip a replaced source to bind a different registered session', async t => {
  for (const location of ['primary', 'fallback']) await t.test(location, async t => {
    const f = await fixture(t, 'claude');
    const candidates = await registeredClaudeCandidates(f, location === 'primary' ? 1 : 2, { matchLast: true, tail: () => '' });
    const rejected = location === 'primary' ? f.source : candidates[0];
    const bytes = await fs.readFile(rejected.path);
    await fs.rename(rejected.path, rejected.path + '.preserved');
    await fs.writeFile(rejected.path, bytes);
    await assert.rejects(f.resolve(), { code: 'SOURCE_CHANGED' });
  });
});

test('native persistence wait preserves the initially inspected selection', async t => {
  const f = await fixture(t, 'claude'); await f.append([f.spacer()]);
  const reads = observeNativeReads(t, [f.source], async (_file, count) => {
    if (count !== 1) return;
    await f.append([f.nativeCall()]);
    await withIntakeLock(f.store, tx => controlSelection(tx, { source: f.source, expectedHash: f.selected.hash,
      request: { id: randomUUID(), operation: 'exclude', client: 'claude', sessionId: f.context.sessionId,
        unitId: randomUUID(), expectedRevision: f.selected.state.revision }, authorize: async () => true }));
  });
  await assert.rejects(resolveProcessingInvocation(f.capability, f.context, f.invocation, { skillPath: f.skillPath }), unavailable);
  assert.equal(reads.get(f.source.path), 1);
});

test('Codex incomplete nested pairs remain pending and never prove a call', async t => {
  for (const present of ['inner', 'outer output', 'neither']) await t.test(present, async t => {
    const f = await fixture(t), rows = nestedRows(f, { content: [], isError: false });
    await f.append([f.spacer(), rows.outer, ...(present === 'inner' ? [rows.call] : present === 'outer output' ? [rows.output] : [])]);
    const pending = await f.resolve(); assert.equal(pending.pending, true); assert.equal(isProcessingInvocation(pending), false);
    await assert.rejects(resolveProcessingInvocation(f.capability, f.context, f.invocation,
      { skillPath: f.skillPath, settleMs: 0, requireCompleted: true }), unavailable);
  });
});

test('exact Codex shortcut scope cannot be broadened by the model tool arguments', async t => {
  const f = await fixture(t), input = f.nativeSkill();
  input.payload.item.content[1].text = 'process chat';
  f.invocation.tool = 'process_selected_captures';
  await f.append([f.spacer(), input, f.nativeCall()]);
  await assert.rejects(f.resolve(), { code: 'PROCESSING_CONTROL_SELECTION_MISMATCH' });
});

test('exact Claude shortcut scope cannot be broadened despite a valid native tool identity', async t => {
  const f = await fixture(t, 'claude'), command = 'cuefluent-notes:cuefluent-notes';
  f.invocation.tool = 'process_selected_captures';
  await fs.mkdir(path.dirname(f.skillPath), { recursive: true });
  await fs.writeFile(f.skillPath, '---\nname: cuefluent-notes\n---\nSynthetic $ARGUMENTS\n');
  const input = f.spacer();
  input.message.content = `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>process chat</command-args>`;
  const companion = { ...input, uuid: randomUUID(), parentUuid: input.uuid, isMeta: true, turnCompanion: true,
    message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(f.skillPath)}\n\nSynthetic process chat\n` }] } };
  const call = f.nativeCall(); call.attributionSkill = command; call.attributionPlugin = 'cuefluent-notes';
  await f.append([input, companion, call]);
  await assert.rejects(f.resolve(), { code: 'PROCESSING_CONTROL_SELECTION_MISMATCH' });
});

test('Claude typed review actions bind exact draft and decision arguments and report the typed action', async t => {
  const command = 'cuefluent-notes:cuefluent-notes';
  for (const [typed, args, expected] of [
    ['review save t7xb88', { decision: 'save', draft: 't7xb88' }, true],
    ['review later t7xb88', { decision: 'later', draft: 't7xb88' }, true],
    ['review t7xb88', { draft: 't7xb88' }, true],
    ['review save', { decision: 'save' }, true],
    ['review', {}, true],
    // A model cannot turn a typed display request into a decision, change the
    // decision, retarget the draft code or drop the code from a typed decision.
    ['review t7xb88', { decision: 'save', draft: 't7xb88' }, 'PROCESSING_CONTROL_SELECTION_MISMATCH'],
    ['review later t7xb88', { decision: 'save', draft: 't7xb88' }, 'PROCESSING_CONTROL_SELECTION_MISMATCH'],
    ['review save t7xb88', { decision: 'save', draft: 'k2mn9p' }, 'PROCESSING_CONTROL_SELECTION_MISMATCH'],
    ['review save t7xb88', { decision: 'save' }, 'PROCESSING_CONTROL_SELECTION_MISMATCH'],
    // Near misses and plain text stay ordinary input; they never verify a decision.
    ['review save T7XB88', { decision: 'save', draft: 't7xb88' }, false],
    ['review  save t7xb88', { decision: 'save', draft: 't7xb88' }, false],
    ['review save t7xb81', { decision: 'save', draft: 't7xb88' }, false],
  ]) await t.test(`${typed} -> ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t, 'claude');
    f.invocation.tool = 'processing_review'; f.invocation.arguments = { collectionId: f.collection.id, ...args };
    await fs.mkdir(path.dirname(f.skillPath), { recursive: true });
    await fs.writeFile(f.skillPath, '---\nname: cuefluent-notes\n---\n\nSynthetic control $ARGUMENTS\n');
    const input = f.spacer();
    input.message.content = `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${typed}</command-args>`;
    const companion = { ...input, uuid: randomUUID(), parentUuid: input.uuid, isMeta: true, turnCompanion: true,
      message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(f.skillPath)}\n\nSynthetic control ${typed}\n` }] } };
    const call = f.nativeCall(); call.attributionSkill = command; call.attributionPlugin = 'cuefluent-notes';
    await f.append([input, companion, call]);
    if (typeof expected === 'string') return assert.rejects(f.resolve(), { code: expected });
    const bound = await f.resolve();
    assert.equal(bound.nativeSkill, expected);
    assert.equal(bound.typedControl, expected ? typed : undefined);
    if (expected) assert.equal(bound.inputHash, digest(input.message.content));
  });
});

test('Codex typed review actions bind from the verified typed text to a call without review fields', async t => {
  for (const [typed, tool, expected] of [
    ['review save t7xb88', 'processing_review', true], ['review later', 'processing_review', true],
    ['review t7xb88', 'processing_review', true], ['review', 'processing_review', true],
    // Exact text only; a mismatched tool is refused rather than reinterpreted.
    ['review save T7XB88', 'processing_review', false], ['please review save t7xb88', 'processing_review', false],
    ['review save t7xb88', 'processing_status', 'PROCESSING_CONTROL_SELECTION_MISMATCH'],
  ]) await t.test(`${typed} -> ${tool}`, async t => {
    const f = await fixture(t);
    f.invocation.tool = tool; f.invocation.arguments = { collectionId: f.collection.id };
    const user = f.nativeSkill(); user.payload.item.content[1].text = typed;
    await f.append([f.spacer(), user, f.nativeCall()]);
    if (typeof expected === 'string') return assert.rejects(f.resolve(), { code: expected });
    const bound = await f.resolve();
    assert.equal(bound.nativeSkill, expected);
    assert.equal(bound.typedControl, expected ? typed : undefined);
  });
  // Without the typed skill input, a model-initiated review call is display only.
  const f = await fixture(t);
  f.invocation.tool = 'processing_review'; f.invocation.arguments = { collectionId: f.collection.id };
  await f.append([f.spacer(), f.nativeCall()]);
  const bound = await f.resolve();
  assert.equal(bound.nativeSkill, false); assert.equal(Object.hasOwn(bound, 'typedControl'), false);
});
