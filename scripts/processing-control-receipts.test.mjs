import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { privateIntakeFixture } from './test-support/intake-fixture.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { withIntakeLock, intakeSnapshot } from './intake-io.mjs';
import { controlSelection, readSelection, readCaptureHead, readReaderProgress, commitReaderProgress, publishCapture } from './intake-store.mjs';
import { readCodexSelection, codexProgressPlan, codexPublicationPlan } from './codex-reader.mjs';
import { readClaudeSelection, claudePublicationPlan } from './claude-reader.mjs';
import { processScope } from './collection-worker.mjs';
import { recordProcessingControlDispatch, createProcessingControlResolver } from './processing-control-receipts.mjs';
import { SKILL_ROOT } from './runtime-paths.mjs';
import { verifyProcessingExecution } from './processing-execution-proof.mjs';
import { processingControlCall } from './processing-control-proof.mjs';
import { codexControlTurn } from './test-support/codex-control-turn.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const unitId = '22222222-2222-4222-8222-222222222222';
const beforeId = '22222222-2222-4222-8222-222222222221', afterId = '22222222-2222-4222-8222-222222222223';
const stamp = '2026-10-10T12:00:00.000Z';
const authorize = async () => true;
const statusText = 'Processing request accepted. Open the existing processing chat.';
const args = { command: 'process', requestId: '33333333-3333-4333-8333-333333333333' };
const result = { content: [{ type: 'text', text: '{"status":"accepted"}' }] };
const evt = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
const item = (turn, value) => evt('item_completed', { thread_id: sessionId, turn_id: turn, item: value });
const response = (payload, kinds) => ({ type: 'response_item', payload: { ...payload,
  internal_chat_message_metadata_passthrough: { turn_id: unitId, ...(kinds ? { content_item_kinds: kinds } : {}) } } });
const ordinary = turn => [evt('task_started', { turn_id: turn, root_turn_id: turn }),
  item(turn, { type: 'UserMessage', id: `user-${turn}`, content: [{ type: 'text', text: `Genuine work ${turn}.` }] }),
  evt('task_complete', { turn_id: turn })];

async function claudeFixture(t, { partial = false, control = 'process', installedSkill = false, schemaLoad = null } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-claude-receipt-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = { client: 'claude', sessionId, projectRoot: root, path: path.join(root, 'native.jsonl'), fileIdentity: '' };
  const skillPath = path.join(installedSkill ? SKILL_ROOT : root, 'SKILL.md'), command = 'cuefluent-notes:cuefluent-notes';
  if (!installedSkill) await fs.writeFile(skillPath, '---\nname: cuefluent-notes\n---\nSynthetic $ARGUMENTS\n');
  const skillContent = await fs.readFile(skillPath, 'utf8');
  const skillBody = skillContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimStart();
  const expansion = `Base directory for this skill: ${path.dirname(skillPath)}\n\n${skillBody.includes('$ARGUMENTS') ? skillBody.replaceAll('$ARGUMENTS', control) : `${skillBody}\n\nARGUMENTS: ${control}`}`;
  const row = (type, content, extra = {}) => ({ type, uuid: randomUUID(), timestamp: stamp, cwd: root, sessionId, version: '2.1.296',
    isSidechain: false, parentUuid: null, message: { role: type, content }, ...extra });
  const before = row('user', 'Before selection.', { promptId: beforeId }), prefix = JSON.stringify(before) + '\n', floor = Buffer.byteLength(prefix);
  const input = row('user', `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${control}</command-args>`, { promptId: unitId, parentUuid: before.uuid });
  const companion = row('user', [{ type: 'text', text: expansion }],
    { promptId: unitId, isMeta: true, turnCompanion: true, parentUuid: input.uuid });
  // Claude mirrors the typed fields in its call.
  const mapped = processingControlCall(control), tool = mapped.tool, callArgs = { ...args, ...mapped.fields };
  const call = row('assistant', [{ type: 'tool_use', id: 'dispatch-call', name: `mcp__cuefluent_control__${tool}`, input: callArgs }],
    { attributionSkill: command, attributionPlugin: 'cuefluent-notes', parentUuid: companion.uuid });
  const output = row('user', [{ type: 'tool_result', tool_use_id: 'dispatch-call', content: result.content }],
    { promptId: unitId, sourceToolAssistantUUID: call.uuid, toolUseResult: result.content, parentUuid: call.uuid });
  const final = row('assistant', [{ type: 'text', text: statusText }], { attributionSkill: command, attributionPlugin: 'cuefluent-notes',
    attributionMcpServer: 'cuefluent_control', attributionMcpTool: tool, parentUuid: output.uuid }); final.message.stop_reason = 'end_turn';
  // Claude CLI 2.1.299 can load a deferred MCP schema with its built-in ToolSearch first.
  const loaded = [];
  if (schemaLoad) {
    const name = `mcp__cuefluent_control__${tool}`, query = schemaLoad.query ?? `select:${name}`;
    const loader = row('assistant', [{ type: 'tool_use', id: 'loader-call', name: 'ToolSearch', input: { query, max_results: 1 }, caller: { type: 'direct' } }],
      { attributionSkill: command, attributionPlugin: 'cuefluent-notes', parentUuid: companion.uuid });
    const loadedResult = row('user', [{ type: 'tool_result', tool_use_id: 'loader-call', content: (schemaLoad.matches ?? [name]).map(tool_name => ({ type: 'tool_reference', tool_name })) }],
      { promptId: unitId, sourceToolAssistantUUID: loader.uuid, toolUseResult: { matches: schemaLoad.matches ?? [name], query, total_deferred_tools: 35 }, parentUuid: loader.uuid });
    loaded.push(loader, loadedResult);
  }
  const all = schemaLoad?.after ? [input, companion, call, output, ...loaded, final] : [input, companion, ...loaded, call, output, final];
  const lines = all.map(row => JSON.stringify(row) + '\n');
  await fs.writeFile(source.path, prefix + (partial ? lines[0] : lines.join('')));
  source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
  const store = await privateIntakeFixture(t, source);
  const boundary = { sourceIdentity: source.fileIdentity, eofByte: floor, startsMidRecord: false, unitId: beforeId,
    record: { id: before.uuid, startByte: 0, endByte: floor, hash: digest(prefix) } };
  const selection = await withIntakeLock(store, tx => controlSelection(tx, { source, expectedHash: null, authorize,
    boundary, request: { id: randomUUID(), client: 'claude', sessionId, expectedRevision: 0, operation: 'start', unitId: beforeId } }));
  const scopeId = selection.state.intervals[0].id;
  const dispatch = { client: 'claude', sessionId, unitId, callId: 'dispatch-call', tool: `mcp__cuefluent_control__${tool}`,
    argsHash: digest(canonicalJSON(callArgs)), sourceIdentity: source.fileIdentity, sourcePath: source.path,
    requestHash: 'a'.repeat(64), skillName: 'cuefluent-notes', skillPath, statusText, resultHash: digest(canonicalJSON(result.content)),
    inputId: input.uuid, inputHash: digest(input.message.content), companionId: companion.uuid, companionHash: digest(lines[1]),
    skillExpansionHash: digest(companion.message.content[0].text), skillCommand: command };
  const resolve = tx => createProcessingControlResolver(tx, { state: selection.state, selectionHash: selection.hash, authorize });
  return { root, source, store, scopeId, selection, input, companion, call, output, final, row, all, lines, dispatch, floor,
    record: tx => recordProcessingControlDispatch(tx, { source, selectionHash: selection.hash, dispatch }, { authorize }),
    read: (tx, extra = {}) => readClaudeSelection({ state: selection.state, scopeId, capturedAt: stamp, processingSkillPath: skillPath,
      loadHead: id => readCaptureHead(store, { client: 'claude', sessionId, unitId: id }), resolveProcessingDispatch: resolve(tx), ...extra }) };
}

test('Claude formal process, review, help and decision inputs advance without raw captures and remain excluded on checkpoint replay', async t => {
  for (const control of ['process', 'review', 'help', 'status --verbose', 'save k2mn9p']) await t.test(control, async t => {
    const f = await claudeFixture(t, { control });
    await withIntakeLock(f.store, async tx => {
      await f.record(tx); const read = await f.read(tx), plan = claudePublicationPlan(read);
      assert.deepEqual(read.pending, []); assert.deepEqual(read.candidates, []); assert.equal(read.processingControls.length, 1);
      assert.equal(plan.heldReason, null); assert.equal(plan.scan.to.offset, f.floor + Buffer.byteLength(f.lines.join('')));
      assert.equal(plan.checkpoint.records.find(record => record.id === f.input.uuid).kind, 'human-empty');
      const replay = await f.read(tx, { cursor: plan.scan.to, checkpoint: plan.checkpoint });
      assert.deepEqual(replay.candidates, []); assert.deepEqual(replay.pending, []);
      const correction = f.row('user', 'Correction: use SDK 606.', { promptId: unitId, parentUuid: f.final.uuid });
      await fs.appendFile(f.source.path, JSON.stringify(correction) + '\n');
      const later = await f.read(tx, { cursor: plan.scan.to, checkpoint: plan.checkpoint });
      assert.deepEqual(later.pending, []); assert.equal(later.candidates.length, 1);
      assert.deepEqual(later.candidates[0].capture.evidence.map(item => item.text), ['Correction: use SDK 606.']);
    });
  });
});

test('Claude deferred-schema ToolSearch for the exact control tool does not block exclusion; other searches do', async t => {
  for (const [name, schemaLoad, excluded] of [
    ['exact schema load', {}, true],
    ['different tool', { query: 'select:mcp__other__tool', matches: ['mcp__other__tool'] }, false],
    ['extra match', { matches: ['mcp__cuefluent_control__processing_review', 'mcp__other__tool'] }, false],
    ['after the control call', { after: true }, false],
  ]) await t.test(name, async t => {
    const f = await claudeFixture(t, { control: 'review', schemaLoad });
    await withIntakeLock(f.store, async tx => {
      await f.record(tx); const read = await f.read(tx);
      assert.equal(read.processingControls.length, excluded ? 1 : 0);
      assert.equal(read.candidates.length, excluded ? 0 : 1);
    });
  });
});

test('Claude worker persists no raw capture for a proven formal control and retains later human input', async t => {
  const f = await claudeFixture(t, { installedSkill: true });
  await withIntakeLock(f.store, async tx => {
    await f.record(tx);
    const first = await processScope(tx, f.store, f.selection, f.scopeId, authorize);
    assert.equal(first.saved, 0); assert.equal(first.pending, null);
    assert.equal((await readCaptureHead(f.store, { client: 'claude', sessionId, unitId })).head, null);
    assert.deepEqual(await fs.readdir(f.store.rawDir), []);
    const correction = f.row('user', 'Confirmed SDK 606 support.', { promptId: afterId, parentUuid: f.final.uuid });
    await fs.appendFile(f.source.path, JSON.stringify(correction) + '\n');
    const next = await processScope(tx, f.store, f.selection, f.scopeId, authorize);
    assert.equal(next.saved, 1); assert.equal(next.pending, null);
    const saved = await readCaptureHead(f.store, { client: 'claude', sessionId, unitId: afterId });
    assert.deepEqual(saved.capture.evidence.map(item => item.text), ['Confirmed SDK 606 support.']);
  });
});

test('Claude command-only scan defers without consuming input, then proven dispatch clears it', async t => {
  const f = await claudeFixture(t, { partial: true });
  await withIntakeLock(f.store, async tx => {
    const first = await f.read(tx), plan = claudePublicationPlan(first);
    assert.deepEqual(first.candidates, []); assert.equal(first.pending[0].reason, 'PROCESSING_CONTROL_PROVENANCE_PENDING');
    assert.equal(plan.scan.to.offset, f.floor); assert.deepEqual(plan.scan.accounted, []);
    await fs.appendFile(f.source.path, f.lines.slice(1).join('')); await f.record(tx);
    const next = await f.read(tx); assert.deepEqual(next.pending, []); assert.deepEqual(next.candidates, []);
    assert.equal(next.processingControls.length, 1); assert.equal(claudePublicationPlan(next).heldReason, null);
  });
});

test('Claude formal control is accounted as soon as the actual result arrives, before final narration', async t => {
  const f = await claudeFixture(t, { partial: true });
  await withIntakeLock(f.store, async tx => {
    await fs.appendFile(f.source.path, f.lines.slice(1, 4).join('')); await f.record(tx);
    const read = await f.read(tx), plan = claudePublicationPlan(read);
    assert.deepEqual(read.pending, []); assert.deepEqual(read.candidates, []); assert.equal(read.processingControls.length, 1);
    await fs.appendFile(f.source.path, f.lines[4]);
    const replay = await f.read(tx, { cursor: plan.scan.to, checkpoint: plan.checkpoint });
    assert.deepEqual(replay.pending, []); assert.deepEqual(replay.candidates, []);
  });
});

test('Claude controlled execution excludes only its sealed input and preserves later same-prompt correction', async t => {
  const f = await claudeFixture(t, { partial: true });
  const text = 'Process selected evidence in the private engine.', input = { ...f.input, promptSource: 'sdk', turnOrigin: 'sdk', message: { role: 'user', content: text } };
  const inputBytes = JSON.stringify(input) + '\n';
  const prefix = (await fs.readFile(f.source.path)).subarray(0, f.floor);
  await fs.writeFile(f.source.path, Buffer.concat([prefix, Buffer.from(inputBytes)]));
  let receipt = Object.freeze({ client: 'claude', sessionId, unitId, requestId: randomUUID(), inputId: input.uuid,
    inputHash: digest(text), sourcePath: f.source.path, sourceIdentity: f.source.fileIdentity,
    profileId: 'b'.repeat(64), toolContractHash: 'c'.repeat(64), allowedTools: ['mcp__cuefluent_engine__processing_inspect'],
    completed: true, policyVerified: true });
  const range = { source: f.source, unitId, fromByte: f.floor, endByte: f.floor + Buffer.byteLength(inputBytes) };
  const proof = await verifyProcessingExecution(range, { resolveExecution: async () => receipt });
  assert(proof); receipt = Object.freeze({ ...receipt, fromByte: proof.fromByte, endByte: proof.endByte, recordsHash: proof.recordsHash });
  await withIntakeLock(f.store, async tx => {
    const options = { resolveProcessingExecution: async () => receipt }, read = await f.read(tx, options), plan = claudePublicationPlan(read);
    assert.deepEqual(read.pending, []); assert.deepEqual(read.candidates, []); assert.equal(read.processingControls.length, 1);
    const correction = f.row('user', 'Correction: the supported SDK is 606.', { promptId: unitId, parentUuid: input.uuid });
    await fs.appendFile(f.source.path, JSON.stringify(correction) + '\n');
    const replay = await f.read(tx, { ...options, cursor: plan.scan.to, checkpoint: plan.checkpoint });
    assert.deepEqual(replay.pending, []); assert.equal(replay.candidates.length, 1);
    assert.deepEqual(replay.candidates[0].capture.evidence.map(item => item.text), ['Correction: the supported SDK is 606.']);
  });
});

test('unsupported native markup cannot stall later human work or become an exclusion', async t => {
  const f = await claudeFixture(t, { partial: true });
  await withIntakeLock(f.store, async tx => {
    assert.equal((await f.read(tx)).pending[0].reason, 'PROCESSING_CONTROL_PROVENANCE_PENDING');
    const later = f.row('user', 'A genuine new SDK finding.', { promptId: afterId, parentUuid: f.input.uuid });
    await fs.appendFile(f.source.path, JSON.stringify(later) + '\n');
    const read = await f.read(tx);
    assert.deepEqual(read.pending, []); assert.equal(read.processingControls.length, 0); assert.equal(read.candidates.length, 2);
    assert(read.candidates.some(candidate => candidate.capture.evidence.some(item => item.text === 'A genuine new SDK finding.')));
    // Deferral was never exclusion: the unproven control is captured as what was typed, without markup.
    const control = read.candidates.find(candidate => candidate.capture.identity.unitId === unitId).capture;
    assert.deepEqual(control.evidence.map(item => [item.recordId, item.text]), [[f.input.uuid, 'process']]);
  });
});

async function fixture(t, { mixed = false, ending = 'completed', mutate = () => {}, turn = null } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-control-receipt-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = { client: 'codex', sessionId, projectRoot: root, path: path.join(root, 'native.jsonl'), fileIdentity: '' };
  const skillPath = path.join(root, 'SKILL.md');
  // A Codex 0.163 turn (test-support/codex-control-turn.mjs) replaces the older one.
  const built = turn ? codexControlTurn({ sessionId, unitId, skillPath, ...turn }) : null;
  const controls = built ? built.rows : [evt('task_started', { turn_id: unitId, root_turn_id: unitId }),
    { type: 'turn_context', payload: { turn_id: unitId, root_turn_id: unitId } },
    response({ type: 'message', id: 'native-user', role: 'user', content: [{ type: 'input_text', text: 'process' }] }, ['user.text']),
    item(unitId, { type: 'UserMessage', id: 'user', content: [{ type: 'skill', name: 'cuefluent-notes', path: skillPath },
      { type: 'text', text: 'process', text_elements: [] }] }),
    response({ type: 'function_call', id: 'native-call', call_id: 'dispatch-call', namespace: 'mcp__cuefluent', name: 'process', arguments: JSON.stringify(args) }),
    item(unitId, { type: 'McpToolCall', id: 'dispatch-call', server: 'cuefluent', tool: 'process', arguments: args, status: 'completed', result }),
    response({ type: 'function_call_output', id: 'native-result', call_id: 'dispatch-call', output: result.content[0].text }),
    item(unitId, { type: 'AgentMessage', id: 'native-status', content: [{ type: 'Text', text: statusText }] }),
    response({ type: 'message', id: 'native-status', role: 'assistant', content: [{ type: 'output_text', text: statusText }] }),
    ...(ending === 'completed' ? [evt('task_complete', { turn_id: unitId, last_agent_message: statusText })]
      : ending === 'interrupted' ? [evt('turn_aborted', { turn_id: unitId, reason: 'interrupted' })] : []),
  ];
  mutate(controls);
  const rows = [{ type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: root,
    cli_version: '0.157.1', source: 'cli', history_mode: 'paginated' } },
  ...(mixed ? ordinary(beforeId) : []), ...controls, ...(mixed ? ordinary(afterId) : [])];
  let offset = 0;
  const anchors = [], lines = rows.map((row, ordinal) => {
    const line = JSON.stringify({ timestamp: stamp, ordinal, ...row }) + '\n', bytes = Buffer.from(line);
    anchors.push({ id: `codex:ordinal:${ordinal}`, startByte: offset, endByte: offset + bytes.length, hash: digest(bytes) });
    offset += bytes.length; return line;
  });
  await fs.writeFile(source.path, lines.join(''), { mode: 0o600 });
  source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
  const store = await privateIntakeFixture(t, source), scopeId = randomUUID();
  const selection = await withIntakeLock(store, tx => controlSelection(tx, { source, expectedHash: null, authorize,
    request: { id: scopeId, client: 'codex', sessionId, expectedRevision: 0, operation: 'capture-historical',
      scope: { unitIds: mixed ? [beforeId, unitId, afterId] : [unitId], start: anchors[1], end: anchors.at(-1) } } }));
  const dispatch = { client: 'codex', sessionId, unitId, callId: 'dispatch-call', tool: 'mcp__cuefluent.process',
    argsHash: digest(canonicalJSON(args)), sourceIdentity: source.fileIdentity, sourcePath: source.path,
    requestHash: 'a'.repeat(64), skillName: 'cuefluent-notes', skillPath, statusText, resultHash: digest(canonicalJSON(result)), ...built?.receipt };
  const name = `control-dispatch/codex/${sessionId}/${digest(dispatch.callId).slice(0, 24)}.json`;
  const query = Object.fromEntries(['client', 'sessionId', 'unitId', 'callId', 'tool', 'argsHash'].map(k => [k, dispatch[k]]));
  const record = (tx, d = dispatch, hash = selection.hash, auth = authorize) =>
    recordProcessingControlDispatch(tx, { source, selectionHash: hash, dispatch: d }, { authorize: auth });
  const resolve = tx => createProcessingControlResolver(tx, { state: selection.state, selectionHash: selection.hash, authorize });
  const read = (tx, options = {}) => readCodexSelection({ state: selection.state, scopeId, capturedAt: stamp,
    loadHead: id => readCaptureHead(store, { client: 'codex', sessionId, unitId: id }), resolveProcessingDispatch: resolve(tx), ...options });
  return { source, store, scopeId, selection, dispatch, query, record, resolve, read, name, byteLength: offset };
}

test('dispatch receipts are bounded, immutable, metadata-only and read only under a current intake transaction', async t => {
  const f = await fixture(t); let escaped;
  await withIntakeLock(f.store, async tx => {
    assert.equal(await f.resolve(tx)(f.query), null);
    const first = await f.record(tx), again = await f.record(tx);
    assert.equal(first.status, 'recorded'); assert.deepEqual(again, { status: 'already-recorded', receiptHash: first.receiptHash });
    const receipt = await f.resolve(tx)(f.query);
    assert.deepEqual(receipt, f.dispatch); assert.equal(Object.isFrozen(receipt), true);
    assert.equal(await f.resolve(tx)({ ...f.query, argsHash: 'b'.repeat(64) }), null);
    const bytes = (await intakeSnapshot(f.store, 'state', f.name)).bytes.toString();
    assert.doesNotMatch(bytes, /"arguments"|"content"|"evidence"/);
    await assert.rejects(f.record(tx, { ...f.dispatch, statusText: 'Different status' }), { code: 'PROCESSING_CONTROL_RECEIPT_CONFLICT' });
    escaped = f.resolve(tx);
  });
  await assert.rejects(escaped(f.query), { code: 'INTAKE_LOCK_REQUIRED' });
  await assert.rejects(f.record(Object.freeze({})), { code: 'INTAKE_LOCK_REQUIRED' });
});

test('stale selection, authorization, malformed identities and replaced source cannot create receipts', async t => {
  const f = await fixture(t);
  await withIntakeLock(f.store, async tx => {
    await assert.rejects(f.record(tx, f.dispatch, 'b'.repeat(64)), { code: 'STALE_SELECTION' });
    await assert.rejects(f.record(tx, f.dispatch, f.selection.hash, async () => false), { code: 'INTAKE_NOT_AUTHORIZED' });
    await assert.rejects(f.record(tx, { ...f.dispatch, statusText: 'a'.repeat(4097) }));
    await assert.rejects(f.record(tx, { ...f.dispatch, sourceIdentity: 'b'.repeat(64) }), { code: 'INVALID_PROCESSING_CONTROL_RECEIPT' });
    assert.equal((await intakeSnapshot(f.store, 'state', f.name)).bytes, null);
    const bytes = await fs.readFile(f.source.path); await fs.rename(f.source.path, `${f.source.path}.old`);
    await fs.writeFile(f.source.path, bytes);
    await assert.rejects(f.record(tx), { code: 'SOURCE_CHANGED' });
    assert.equal((await intakeSnapshot(f.store, 'state', f.name)).bytes, null);
  });
});

test('unfamiliar duplicate-key receipt bytes are preserved and cannot authorize exclusion', async t => {
  const f = await fixture(t);
  await withIntakeLock(f.store, async tx => {
    await f.record(tx);
    const receipt = (await intakeSnapshot(f.store, 'state', f.name)).bytes;
    const altered = Buffer.from(receipt.toString().replace('{', '{"version":1,'));
    await fs.writeFile(path.join(f.store.intakeStateDir, ...f.name.split('/')), altered);
    await assert.rejects(f.resolve(tx)(f.query), { code: 'INVALID_PROCESSING_CONTROL_RECEIPT' });
    const read = await f.read(tx);
    assert.equal(read.processingControls.length, 0); assert.equal(read.candidates.length, 0);
    assert.equal(read.pending[0].reason, 'INVALID_PROCESSING_CONTROL_RECEIPT');
    assert.equal(codexProgressPlan(read).scan.to.offset, read.from.offset);
    assert.deepEqual((await intakeSnapshot(f.store, 'state', f.name)).bytes, altered);
  });
});

test('proven control-only input advances persisted progress without creating raw evidence, including replay', async t => {
  const f = await fixture(t);
  await withIntakeLock(f.store, async tx => {
    await f.record(tx);
    const result = await f.read(tx);
    assert.equal(result.candidates.length, 0); assert.deepEqual(result.pending, []);
    assert.equal(result.processingControls.length, 1); assert.deepEqual(result.noEvidence, []);
    const plan = codexProgressPlan(result);
    assert.equal(plan.scan.to.offset, f.byteLength);
    await commitReaderProgress(tx, { identity: { client: 'codex', sessionId }, scopeId: f.scopeId, selectionHash: f.selection.hash,
      cursorHash: null, ...plan, authorize });
    const current = await readReaderProgress(f.store, { client: 'codex', sessionId }, f.scopeId, f.source.fileIdentity);
    const replay = await f.read(tx, { cursor: current.cursor });
    assert.equal(replay.candidates.length, 0); assert.equal(replay.processingControls.length, 0);
    assert.equal(codexProgressPlan(replay).scan.to.offset, f.byteLength);
    assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId })).head, null);
    assert.deepEqual(await fs.readdir(f.store.rawDir), []);
  });
});

test('neighboring genuine work remains publishable across a proven control-only unit', async t => {
  const f = await fixture(t, { mixed: true });
  await withIntakeLock(f.store, async tx => {
    await f.record(tx); const result = await f.read(tx);
    assert.deepEqual(result.candidates.map(c => c.capture.identity.unitId), [beforeId, afterId]);
    assert.equal(result.processingControls.length, 1);
    const published = new Map(); let cursorHash = null;
    // Publishing one unit advances the cursor, so re-read from the committed
    // point just as the worker does instead of refreshing a stale scan.
    let current = result;
    for (const id of [beforeId, afterId]) {
      const candidate = current.candidates.find(c => c.capture.identity.unitId === id), plan = codexPublicationPlan(current, id, published);
      const saved = await publishCapture(tx, { ...candidate, selectionHash: f.selection.hash, cursorHash, scan: plan.scan, authorize });
      published.set(id, { evidenceHash: saved.evidenceHash, fileHash: saved.fileHash }); cursorHash = saved.cursorHash;
      current = await f.read(tx, { cursor: saved.cursor });
    }
    assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId })).head, null);
    for (const id of [beforeId, afterId]) assert.match((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId: id })).capture.evidence[0].text, /Genuine work/);
  });
});

test('worker scope wiring excludes only proven parent controls and a completed replay reads no source', async t => {
  for (const mixed of [false, true]) await t.test(mixed ? 'mixed session' : 'control only', async t => {
    const f = await fixture(t, { mixed });
    await withIntakeLock(f.store, async tx => {
      await f.record(tx);
      const first = await processScope(tx, f.store, f.selection, f.scopeId, authorize);
      assert.deepEqual(first, { saved: mixed ? 2 : 0, pending: null, incomplete: false, drained: true });
      assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId })).head, null);
      if (mixed) for (const id of [beforeId, afterId])
        assert.match((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId: id })).capture.evidence[0].text, /Genuine work/);
      let reads = 0;
      const replay = await processScope(tx, f.store, f.selection, f.scopeId, authorize, () => reads++);
      assert.deepEqual(replay, { saved: 0, pending: null, incomplete: false, drained: true }); assert.equal(reads, 0);
      if (!mixed) assert.deepEqual(await fs.readdir(f.store.rawDir), []);
    });
  });
});

test('missing proof, ordinary correction, incomplete and interrupted turns never become control exclusions', async t => {
  for (const variant of ['missing', 'correction', 'incomplete', 'interrupted']) await t.test(variant, async t => {
    const f = await fixture(t, { ending: ['incomplete', 'interrupted'].includes(variant) ? variant : 'completed',
      mutate: rows => { if (variant === 'correction') rows.splice(-1, 0,
        item(unitId, { type: 'UserMessage', id: 'correction', content: [{ type: 'text', text: 'Correction: use build 605.' }] })); } });
    await withIntakeLock(f.store, async tx => {
      if (variant !== 'missing') await f.record(tx);
      const read = await f.read(tx); assert.deepEqual(read.processingControls, []);
      if (variant === 'incomplete') {
        assert.equal(read.candidates.length, 0); assert.equal(read.pending[0].reason, 'terminal-not-persisted');
        assert.equal(codexProgressPlan(read).scan.to.offset, read.from.offset);
      } else {
        assert.equal(read.candidates.length, 1);
        if (variant === 'correction') assert(read.candidates[0].capture.evidence.some(e => e.text === 'Correction: use build 605.'));
        if (variant === 'interrupted') assert.equal(read.candidates[0].capture.terminal, 'interrupted');
      }
    });
  });
});

test('a receipt added after publication preserves the existing capture and its exact evidence hash', async t => {
  const f = await fixture(t);
  await withIntakeLock(f.store, async tx => {
    const first = await f.read(tx), candidate = first.candidates[0];
    await publishCapture(tx, { ...candidate, selectionHash: f.selection.hash, cursorHash: null,
      scan: codexPublicationPlan(first, unitId).scan, authorize });
    await f.record(tx);
    const after = await f.read(tx);
    assert.equal(after.processingControls.length, 0); assert.equal(after.candidates.length, 1);
    assert.equal(after.candidates[0].capture.evidenceHash, candidate.capture.evidenceHash);
    assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId })).capture.evidenceHash, candidate.capture.evidenceHash);
    const metadataHead = await f.read(tx, { loadHead: id => readCaptureHead(f.store, { client: 'codex', sessionId, unitId: id }, { metadataOnly: true }) });
    assert.equal(metadataHead.processingControls.length, 0);
  });
});

test('receipt resolution rechecks the exact active selection and does not outlive a restrictive change', async t => {
  const f = await fixture(t);
  await withIntakeLock(f.store, async tx => {
    await f.record(tx); const resolve = f.resolve(tx);
    const selected = await readSelection(f.store, { client: 'codex', sessionId });
    await controlSelection(tx, { source: f.source, expectedHash: selected.hash, authorize,
      request: { id: randomUUID(), client: 'codex', sessionId, expectedRevision: selected.state.revision, operation: 'exclude', unitId } });
    await assert.rejects(resolve(f.query), { code: 'STALE_SELECTION' });
  });
});

test('Codex 0.163 code-mode receipts name both cells and the retry call, and exclude exactly the proven turn', async t => {
  for (const [name, turn] of [['code mode', {}], ['code mode finished by wait', { waits: 1 }], ['older skill part, code mode', { form: 'block' }],
    ['direct call', { mode: 'direct' }]]) await t.test(name, async t => {
    for (const mixed of [false, true]) {
      const f = await fixture(t, { mixed, turn: { control: 'save t7xb88', ...turn } });
      await withIntakeLock(f.store, async tx => {
        assert.equal((await f.record(tx)).status, 'recorded');
        assert.deepEqual(await f.resolve(tx)(f.query), f.dispatch);
        const first = await processScope(tx, f.store, f.selection, f.scopeId, authorize);
        assert.deepEqual(first, { saved: mixed ? 2 : 0, pending: null, incomplete: false, drained: true });
        assert.equal((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId })).head, null);
        if (mixed) for (const id of [beforeId, afterId])
          assert.match((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId: id })).capture.evidence[0].text, /Genuine work/);
      });
    }
  });
  // Without its receipt the turn is not excluded, yet the exact command, the
  // cells and the assistant's repetition of the plugin's reply are never
  // evidence: nothing is captured.
  const f = await fixture(t, { turn: { control: 'save t7xb88' } });
  await withIntakeLock(f.store, async tx => {
    const read = await f.read(tx);
    assert.equal(read.processingControls.length, 0); assert.deepEqual(read.candidates, []); assert.deepEqual(read.noEvidence, [unitId]);
  });
  // With its receipt, commentary keeps the turn collectible: the assistant's
  // own words are captured, never the command or the plugin's reply.
  for (const mode of ['code', 'direct']) await t.test(`commentary in a receipted turn (${mode})`, async t => {
    const g = await fixture(t, { turn: { control: 'save t7xb88', mode, commentary: ['Diagnosis: the Cedar cache bug is the 25-minute TTL.'] } });
    await withIntakeLock(g.store, async tx => {
      assert.equal((await g.record(tx)).status, 'recorded');
      const read = await g.read(tx);
      assert.equal(read.processingControls.length, 0);
      assert.deepEqual(read.candidates.map(candidate => candidate.capture.evidence.map(item => [item.kind, item.text])),
        [[['assistant', 'Diagnosis: the Cedar cache bug is the 25-minute TTL.']]]);
    });
  });
});

test('a plain-language Codex request is captured as typed, without this plugin\'s control traffic or the relayed reply', async t => {
  // No skill picked, no mention: no receipt exists and none is looked for, yet
  // the worker publishes only the person's words, beside genuine work.
  const typed = 'Please process my notes.';
  for (const mode of ['code', 'direct']) await t.test(mode, async t => {
    const f = await fixture(t, { mixed: true, turn: { form: 'plain', control: typed, calledTool: 'process_selected_captures', mode } });
    await withIntakeLock(f.store, async tx => {
      assert.equal(await f.resolve(tx)(f.query), null);
      assert.deepEqual(await processScope(tx, f.store, f.selection, f.scopeId, authorize), { saved: 3, pending: null, incomplete: false, drained: true });
      const capture = (await readCaptureHead(f.store, { client: 'codex', sessionId, unitId })).capture;
      assert.deepEqual(capture.evidence.map(item => [item.kind, item.text]), [['user', typed]]);
      assert.doesNotMatch(JSON.stringify(capture), /cuefluent_control|Review folder|statusText/);
      for (const id of [beforeId, afterId])
        assert.match((await readCaptureHead(f.store, { client: 'codex', sessionId, unitId: id })).capture.evidence[0].text, /Genuine work/);
    });
  });
});

test('Codex code-mode receipt fields come all together, only for Codex, and name distinct cells and calls', async t => {
  const f = await fixture(t, { turn: {} });
  await withIntakeLock(f.store, async tx => {
    const { outerItemId, retryItemId, retryCallId, handshakeResultHash, ...direct } = f.dispatch;
    // Some fields without the others, or the same cell or call twice.
    for (const dispatch of [{ ...direct, outerItemId }, { ...direct, outerItemId, retryItemId, retryCallId },
      { ...f.dispatch, retryItemId: outerItemId }, { ...f.dispatch, retryCallId: f.dispatch.callId }]) {
      await assert.rejects(f.record(tx, dispatch), { code: 'INVALID_PROCESSING_CONTROL_RECEIPT' });
    }
    for (const dispatch of [{ ...f.dispatch, outerItemId: 'ctc first' }, { ...f.dispatch, handshakeResultHash: 'not-a-hash' }]) {
      await assert.rejects(f.record(tx, dispatch), { code: /INVALID_PROCESSING_CONTROL_RECEIPT|INVALID_WORKFLOW/ });
    }
    assert.equal((await intakeSnapshot(f.store, 'state', f.name)).bytes, null);
    void handshakeResultHash; void retryCallId; void retryItemId;
  });
});
