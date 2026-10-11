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
async function fixture(t, client = 'codex', { register = true, midRecord = false, collection = true, mode = 'manual' } = {}) {
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
      cli_version: '0.156.1', source: 'cli', history_mode: 'paginated' } }
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
    resolve: (ctx = context, call = invocation) => resolveProcessingInvocation(f.capability, ctx, call, { skillPath }) };
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

test('Claude maps formal process and review controls through trusted companion and native skill attribution', async t => {
  for (const control of ['process', 'review']) await t.test(control, async t => {
    const f = await fixture(t, 'claude');
    f.invocation.tool = control === 'review' ? 'processing_review' : 'process_selected_captures';
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
