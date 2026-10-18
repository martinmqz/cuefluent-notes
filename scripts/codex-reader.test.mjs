import test from './test-support/storage-test.mjs';
import { privateIntakeFixture } from './test-support/intake-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readCodexSelection, codexPublicationPlan, codexProgressPlan, codexRegistrationHeader } from './codex-reader.mjs';
import { readSessionRange, SESSION_LINE_LIMIT } from './session-jsonl.mjs';
import { newSelectionState, applySelectionControl, stableSourceIdentity, inspectSourceBoundary } from './capture-selection.mjs';
import { digest } from './workflow-values.mjs';
import { inspectIntakeStore, withIntakeLock, intakeSnapshot } from './intake-io.mjs';
import { controlSelection, publishCapture, readCaptureHead } from './intake-store.mjs';
import { serializeCapture, createCapture, captureRelativePath } from './capture-contract.mjs';
import { codexControlTurn, MENU_MENTION, framing, codexToolError } from './test-support/codex-control-turn.mjs';
import { processingControlStatusView, processingControlRefusalText } from './processing-control-server.mjs';

const S = '10000000-0000-4000-8000-000000000001';
const A = '20000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const C = '20000000-0000-4000-8000-000000000003';
const time = '2026-09-23T00:00:00.000Z';
const evt = (type, rest = {}) => ({ type: 'event_msg', payload: { type, ...rest } });
const start = turn_id => evt('task_started', { turn_id, root_turn_id: turn_id, started_at: Date.parse(time) / 1000 });
const end = (turn_id, rest = {}) => evt('task_complete', { turn_id, last_agent_message: 'This is a mirror, not another answer.', ...rest });
const item = (turn_id, type, content, id = randomUUID()) => evt('item_completed', { thread_id: S, turn_id, item: { type, id, content }, completed_at_ms: Date.parse(time) });
const user = (turn, text = 'Meeting: decide release scope.') => item(turn, 'UserMessage', [{ type: 'text', text }]);
const assistant = (turn, text = 'The rollout is pending.') => item(turn, 'AgentMessage', [{ type: 'Text', text }]);
const response = (turn, type, rest) => ({ type: 'response_item', payload: { type, id: randomUUID(), ...rest,
  internal_chat_message_metadata_passthrough: { turn_id: turn } } });
const ordinary = () => [start(A), user(A), assistant(A), end(A)];
async function fixture(t, entries = ordinary(), { mode = 'paginated', prefix = '', future = false, missingLower = false, headerChanges = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-codex-reader-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const source = { client: 'codex', sessionId: S, path: path.join(root, 'session.jsonl'), projectRoot: root, fileIdentity: '' };
  const header = { type: 'session_meta', payload: { id: S, session_id: S, cwd: root, cli_version: '0.156.1', source: 'cli', history_mode: mode, ...headerChanges } };
  const rows = [header, ...(future ? [start(C)] : []), ...entries].map((value, ordinal) => ({ timestamp: time, ...(mode === 'paginated' ? { ordinal } : {}), ...value,
    ...(value.type === 'session_meta' ? { payload: { ...header.payload, ...value.payload } } : {}) }));
  let bytes = Buffer.from(JSON.stringify(rows[0]) + '\n' + prefix), offset = bytes.length;
  const anchors = [];
  for (const row of rows.slice(1)) {
    const next = Buffer.from(JSON.stringify(row) + '\n');
    anchors.push({ id: mode === 'paginated' ? `codex:ordinal:${row.ordinal}` : `codex:byte:${offset}:${digest(next).slice(0, 20)}`,
      startByte: offset, endByte: offset + next.length, hash: digest(next) });
    bytes = Buffer.concat([bytes, next]); offset += next.length;
  }
  await fs.writeFile(source.path, bytes); source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
  const controlAnchor = future ? anchors.shift() : null;
  const initial = newSelectionState(source), scopeId = randomUUID();
  const request = { id: scopeId, client: 'codex', sessionId: S, expectedRevision: 0,
    ...(future ? { operation: 'start', unitId: C } : { operation: 'capture-historical', scope: { unitIds: [A, B, C], start: anchors[0], end: anchors.at(-1) } }) };
  const boundary = future ? { sourceIdentity: source.fileIdentity, eofByte: anchors[0].startByte, startsMidRecord: Boolean(prefix && !prefix.endsWith('\n')),
    unitId: C, record: missingLower ? null : controlAnchor } : undefined;
  const state = applySelectionControl(initial, request, boundary);
  return { root, source, entries: rows, anchors, state, request, boundary,
    scopeId: future ? state.intervals[0].id : scopeId, bytes, args: { state, scopeId: future ? state.intervals[0].id : scopeId, capturedAt: time } };
}

test('paginated extraction is attributed, mirrored once and publishable through intake', async t => {
  const f = await fixture(t, [start(A), user(A),
    response(A, 'message', { role: 'user', content: [{ type: 'input_text', text: 'INJECTED CONTEXT' }] }),
    assistant(A), response(A, 'message', { role: 'assistant', content: [{ type: 'output_text', text: 'The rollout is pending.' }] }), end(A)]);
  const result = await readCodexSelection(f.args), [{ capture }] = result.candidates;
  assert.deepEqual(capture.evidence.map(item => item.text), ['Meeting: decide release scope.', 'The rollout is pending.']);
  assert.equal(capture.terminal, 'completed'); assert.equal(capture.coverage.partial, false);
  const store = await privateIntakeFixture(t, f.source);
  const selection = await withIntakeLock(store, tx => controlSelection(tx, { source: f.source, request: f.request, expectedHash: null, authorize: async () => true }));
  const published = await withIntakeLock(store, tx => publishCapture(tx, { ...result.candidates[0], selectionHash: selection.hash,
    cursorHash: null, scan: codexPublicationPlan(result, A).scan, authorize: async () => true }));
  assert.equal(published.cursor.offset, f.bytes.length);
});

test('legacy mode uses native user events and raw assistant messages; identical actual messages survive', async t => {
  const f = await fixture(t, [start(A), evt('user_message', { message: 'Meeting summary from user.', images: [], local_images: [] }),
    response(A, 'message', { role: 'user', content: [{ type: 'input_text', text: 'Do not save: this is injected context.' }] }),
    response(A, 'message', { role: 'assistant', content: [{ type: 'output_text', text: 'Same text.' }] }),
    evt('agent_message', { message: 'Same text.' }),
    response(A, 'message', { role: 'assistant', content: [{ type: 'output_text', text: 'Same text.' }] }), end(A)], { mode: 'legacy' });
  const result = await readCodexSelection(f.args);
  assert.deepEqual(result.candidates[0].capture.evidence.map(item => item.text), ['Meeting summary from user.', 'Same text.', 'Same text.']);
});

test('native item IDs deduplicate mirrors without deduplicating repeated text', async t => {
  const one = user(A, 'Repeated source text'), two = user(A, 'Repeated source text');
  const repeated = structuredClone(one); repeated.payload.completed_at_ms++;
  const f = await fixture(t, [start(A), one, repeated, two, end(A)]);
  assert.equal((await readCodexSelection(f.args)).candidates[0].capture.evidence.length, 2);
  const bad = structuredClone(one); bad.payload.item.content[0].text = 'Changed';
  const other = await fixture(t, [start(A), one, bad, end(A)]);
  assert.equal((await readCodexSelection(other.args)).pending[0].reason, 'CONFLICTING_CODEX_MIRROR');
});

test('processing markers and identical output never exclude unproven native records or mixed work', async t => {
  const echo = JSON.stringify({ format: 'cuefluent-evidence-page', operationId: A,
    artifactHash: digest('retained evidence'), contextRef: 'a'.repeat(64), generated: true,
    text: '# Existing draft\n\nVerified real work mentioning Cuefluent.' });
  const mixed = echo + '\nIndependent test outcome: regression still reproduces.';
  const correction = 'Correction: the earlier passing result used a recompiled caller.';
  const f = await fixture(t, [start(A), user(A),
    response(A, 'function_call', { name: 'exec_command', call_id: 'processing-call', arguments: '{"cmd":"node workflow.mjs processing-page"}' }),
    response(A, 'function_call_output', { call_id: 'processing-call', output: mixed }),
    response(A, 'function_call', { name: 'processing-page', call_id: 'different-call', arguments: '{}' }),
    response(A, 'function_call_output', { call_id: 'different-call', output: mixed }),
    user(A, correction), end(A)]);
  const first = await readCodexSelection(f.args), capture = first.candidates[0].capture;
  const outputs = capture.evidence.filter(item => item.kind === 'tool-result');
  assert.deepEqual(outputs.map(item => item.text), [mixed, mixed]);
  assert.notEqual(outputs[0].recordId, outputs[1].recordId);
  assert(capture.evidence.some(item => item.kind === 'user' && item.text === correction));
  assert.equal(capture.coverage.partial, false);
  assert.equal(digest(serializeCapture((await readCodexSelection(f.args)).candidates[0].capture)), digest(serializeCapture(capture)));
  assert.deepEqual(await fs.readFile(f.source.path), f.bytes);
});

test('tool outputs keep unknown status unless a structured native result corroborates it', async t => {
  const f = await fixture(t, [start(A), user(A),
    response(A, 'function_call', { name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"test"}' }),
    response(A, 'function_call_output', { call_id: 'call-1', output: 'Exit code: 0 (untrusted prose)' }),
    response(A, 'custom_tool_call', { name: 'apply_patch', call_id: 'call-2', input: 'patch' }),
    response(A, 'custom_tool_call_output', { call_id: 'call-2', output: [{ type: 'input_text', text: 'Observed failure' }] }),
    evt('item_completed', { thread_id: S, turn_id: A, item: { type: 'CommandExecution', id: 'call-2', status: 'failed', exit_code: 1 } }), end(A)]);
  const outputs = (await readCodexSelection(f.args)).candidates[0].capture.evidence.filter(item => item.kind === 'tool-result');
  assert.deepEqual(outputs.map(item => item.outcome), ['unknown', 'failed']);
});

test('attachments retain actual links, inline and opaque sources have omissions, never binary leakage', async t => {
  const f = await fixture(t, [start(A), item(A, 'UserMessage', [
    { type: 'image', image_url: 'data:image/png;base64,PRIVATEBINARY' }, { type: 'image', file_id: 'file-abc' },
    { type: 'local_image', path: '/supplied/screenshot.png' }, { type: 'image', image_url: 'https://example.com/screenshot.png' }]), end(A)]);
  const capture = (await readCodexSelection(f.args)).candidates[0].capture;
  assert.equal(capture.evidence.length, 2); assert.equal(capture.coverage.omissions.length, 2);
  assert.ok(!serializeCapture(capture).toString().includes('PRIVATEBINARY'));
  const onlyInline = await fixture(t, [start(A), item(A, 'UserMessage', [{ type: 'image', image_url: 'data:image/png;base64,AAA' }]), end(A)]);
  const omitted = (await readCodexSelection(onlyInline.args)).candidates[0].capture;
  assert.deepEqual(omitted.evidence, []); assert.equal(omitted.coverage.partial, true);
});

test('structural reasoning, compaction and child messages are excluded without filtering user prose', async t => {
  const f = await fixture(t, [start(A), user(A, 'Meeting summary: <hook_prompt>quoted evidence</hook_prompt>'),
    response(A, 'reasoning', { summary: [{ text: 'PRIVATE THOUGHT' }], encrypted_content: 'SECRET' }),
    { type: 'compacted', payload: { message: 'DERIVED SUMMARY', replacement_history: [] } },
    item(A, 'HookPrompt', []), item(A, 'SubAgentActivity', []),
    response(A, 'agent_message', { author: '/root/child', recipient: '/root', content: [{ text: 'CHILD CONTENT' }] }), end(A)]);
  const capture = (await readCodexSelection(f.args)).candidates[0].capture;
  assert.equal(capture.evidence.length, 1); assert.match(capture.evidence[0].text, /quoted evidence/);
  assert.doesNotMatch(serializeCapture(capture).toString(), /PRIVATE THOUGHT|DERIVED SUMMARY|CHILD CONTENT/);
});

test('interrupted and failed turns require persisted matching terminal records', async t => {
  for (const [terminal, ending] of [['interrupted', evt('turn_aborted', { turn_id: A, reason: 'interrupted' })], ['failed', end(A, { error: { message: 'failure' } })]]) {
    const f = await fixture(t, [start(A), user(A), assistant(A, 'Partial work'), ending]);
    const capture = (await readCodexSelection(f.args)).candidates[0].capture;
    assert.equal(capture.terminal, terminal); assert.equal(capture.coverage.partial, true);
  }
  const pending = await fixture(t, [start(A), user(A), assistant(A, 'Final answer alone proves nothing')]);
  const result = await readCodexSelection(pending.args);
  assert.equal(result.candidates.length, 0); assert.equal(result.pending[0].reason, 'terminal-not-persisted');
  const anonymous = await fixture(t, [start(A), user(A), evt('turn_aborted', { reason: 'interrupted' })]);
  assert.equal((await readCodexSelection(anonymous.args)).blocked.code, 'UNSUPPORTED_NATIVE_IDENTITY');
});

test('late evidence or conflicting terminal records prevent publication', async t => {
  const f = await fixture(t, [start(A), user(A), end(A), assistant(A, 'late')]);
  assert.equal((await readCodexSelection(f.args)).pending[0].reason, 'EVIDENCE_AFTER_CODEX_TERMINAL');
  const other = await fixture(t, [start(A), user(A), end(A), end(A, { error: { message: 'different terminal' } })]);
  assert.equal((await readCodexSelection(other.args)).pending[0].reason, 'CONFLICTING_CODEX_TERMINAL');
});

test('interleaved units keep a low-water cursor and require exact published hashes for advancement', async t => {
  const f = await fixture(t, [start(A), user(A), start(B), user(B), assistant(B), end(B), assistant(A), end(A)]);
  const result = await readCodexSelection(f.args);
  const bScan = codexPublicationPlan(result, B).scan;
  assert.equal(bScan.to.offset, bScan.from.offset);
  const aScan = codexPublicationPlan(result, A, new Map([[B, { fileHash: 'a'.repeat(64), evidenceHash: 'b'.repeat(64) }]])).scan;
  assert.equal(aScan.to.offset, f.bytes.length); assert.ok(aScan.accounted.some(item => item.kind === 'published'));
  for (const { capture } of result.candidates) {
    const texts = capture.evidence.map(item => item.text); assert.equal(texts.length, 2);
    for (let i = 1; i < capture.source.ranges.length; i++) assert.ok(capture.source.ranges[i].startByte >= capture.source.ranges[i - 1].endByte);
  }
});

test('ambiguous untagged records are never assigned to the latest-started turn', async t => {
  const f = await fixture(t, [start(A), start(B), evt('user_message', { message: 'ambiguous' }), end(A), end(B)], { mode: 'legacy' });
  assert.equal((await readCodexSelection(f.args)).blocked.code, 'UNSUPPORTED_CODEX_ORDER');
});

test('future boundary resolves only from matching native evidence after the floor', async t => {
  const f = await fixture(t, [end(C), start(A), user(A), end(A)], { future: true, missingLower: true });
  const result = await readCodexSelection(f.args);
  assert.equal(result.anchorUpdates.length, 1); assert.equal(result.candidates.length, 1);
  const absent = await fixture(t, ordinary(), { future: true, missingLower: true });
  const unresolved = await readCodexSelection(absent.args);
  assert.equal(unresolved.candidates.length, 0); assert.equal(unresolved.pending[0].reason, 'anchor-unresolved');
});

test('future reads seek past a 50 MiB prefix and ignore a partial first record', async t => {
  const f = await fixture(t, [end(C), start(A), user(A), end(A)], { future: true, missingLower: true });
  const originalHeader = f.bytes.subarray(0, f.anchors[0].startByte), prefixSize = 50 * 1024 * 1024;
  const suffix = Buffer.concat([Buffer.from('suffix of a split record\n'), f.bytes.subarray(f.anchors[0].startByte)]);
  await fs.writeFile(f.source.path, originalHeader); await fs.truncate(f.source.path, prefixSize);
  const handle = await fs.open(f.source.path, 'r+'); await handle.write(suffix, 0, suffix.length, prefixSize); await handle.close();
  f.state.intervals[0].lower.eofByte = prefixSize; f.state.intervals[0].lower.startsMidRecord = true;
  const reads = [], result = await readCodexSelection({ ...f.args, observeRead: item => reads.push(item) });
  assert.equal(result.candidates.length, 1);
  assert.ok(reads.filter(item => item.purpose === 'range').every(item => item.offset >= prefixSize));
  assert.ok(reads.filter(item => item.purpose === 'header').reduce((sum, item) => sum + item.bytes, 0) <= 64 * 1024);
});

test('pause excludes its command turn while retaining earlier eligible evidence persisted later', async t => {
  const f = await fixture(t, [end(C), start(A), user(A), start(B), user(B), assistant(A), end(A), end(B)], { future: true, missingLower: true });
  const paused = applySelectionControl(f.state, { id: randomUUID(), client: 'codex', sessionId: S, operation: 'pause', unitId: B, expectedRevision: f.state.revision },
    { sourceIdentity: f.source.fileIdentity, eofByte: f.anchors[2].endByte, unitId: B, record: null, startsMidRecord: false });
  const result = await readCodexSelection({ ...f.args, state: paused });
  assert.deepEqual(result.candidates.map(item => item.capture.identity.unitId), [A]);
});

test('partial tails remain pending and fixed EOF excludes concurrent appends', async t => {
  const f = await fixture(t, [start(A), user(A), end(A)]);
  await fs.truncate(f.source.path, f.bytes.length - 2);
  const pending = await readCodexSelection(f.args);
  assert.equal(pending.candidates.length, 0); assert.equal(pending.diagnostics.pendingTail, true);
  await fs.writeFile(f.source.path, f.bytes);
  let appended = false;
  const result = await readCodexSelection(f.args);
  const from = f.anchors[0].startByte;
  const range = await readSessionRange({ source: f.source, from, verifyHeader: async () => {
    await fs.appendFile(f.source.path, JSON.stringify({ timestamp: time, ordinal: 99, ...start(B) }) + '\n'); appended = true; return {};
  } });
  assert.ok(appended); assert.equal(range.snapshotEnd, f.bytes.length); assert.equal(range.records.length, 3);
  assert.equal(result.candidates.length, 1);
});

test('compatible Codex formats register and extract across client release and prerelease versions', async t => {
  for (const version of ['0.146.0', '0.155.0-alpha.16.4', '0.156.2', '999.0.0+fixture', 'development-build']) {
    for (const mode of ['legacy', 'paginated']) {
      const text = 'Meeting: selected source.';
      const entries = [start(A), mode === 'legacy' ? evt('user_message', { message: text }) : user(A, text), end(A)];
      const f = await fixture(t, entries, { mode, headerChanges: { cli_version: version } });
      const { fileIdentity: _identity, ...selected } = f.source;
      const registration = await inspectSourceBoundary(selected, { currentUnitId: A, verifyHeader: codexRegistrationHeader(selected) });
      assert.equal(registration.status, 'registered');
      const result = await readCodexSelection(f.args);
      assert.equal(result.blocked, null); assert.deepEqual(result.pending, []); assert.equal(result.candidates.length, 1);
      const { capture } = result.candidates[0];
      assert.equal(capture.reader.headerClientVersion, version);
      assert.deepEqual(capture.evidence.map(item => item.text), [text]);
      assert.equal(capture.terminal, 'completed');
    }
  }
});

test('Codex requires bounded version metadata at registration and extraction', async t => {
  for (const cli_version of [undefined, null, 1, {}, '', ' ', 'v'.repeat(129), '\u0000', '\ud800']) {
    const f = await fixture(t, ordinary(), { headerChanges: { cli_version } });
    const { fileIdentity: _identity, ...selected } = f.source;
    await assert.rejects(inspectSourceBoundary(selected, { verifyHeader: codexRegistrationHeader(selected) }), { code: 'INVALID_SESSION_CLIENT_VERSION' });
    await assert.rejects(readCodexSelection(f.args), { code: 'INVALID_SESSION_CLIENT_VERSION' });
  }
});

test('independent agent-created roots register and read both native history shapes', async t => {
  for (const mode of ['legacy', 'paginated']) for (const source of ['cli', 'vscode', 'exec', 'mcp']) {
    const input = id => mode === 'legacy' ? evt('user_message', { message: 'Retained decision' }) : user(id, 'Retained decision');
    const f = await fixture(t, [start(A), input(A), end(A),
      { type: 'session_meta', payload: { cli_version: '0.200.0' } }, start(B), input(B), end(B)],
    { mode, headerChanges: { source, thread_source: 'agent_created_thread' } });
    const { fileIdentity: _, ...selected } = f.source;
    await inspectSourceBoundary(selected, { verifyHeader: codexRegistrationHeader(selected) });
    const result = await readCodexSelection(f.args);
    assert.equal(result.blocked, null);
    assert.deepEqual(result.candidates.map(item => item.capture.identity.unitId), [A, B]);
    assert(result.candidates.every(item => item.capture.evidence[0].text === 'Retained decision'));
  }
});

test('agent-created labels never override child, inherited or malformed ownership at registration or resume', async t => {
  const changes = [
    { id: C }, { session_id: C }, { parent_thread_id: C }, { agent_path: '/child' },
    { subagent_history_start_ordinal: 0 }, { history_base: {} }, { forked_from_id: C }, { forked_from_ordinal_exclusive: 0 },
    { source: { subagent: { thread_spawn: { parent_thread_id: C } } } },
    ...['subagent', 'agent_forked_thread', 'automation', '', 1, {}, ['agent_created_thread']].map(thread_source => ({ thread_source })),
  ];
  for (const change of changes) {
    const headerChanges = { thread_source: 'agent_created_thread', ...change };
    const f = await fixture(t, ordinary(), { headerChanges });
    const { fileIdentity: _, ...selected } = f.source;
    await assert.rejects(inspectSourceBoundary(selected, { verifyHeader: codexRegistrationHeader(selected) }), { code: 'UNSUPPORTED_SESSION_OWNERSHIP' });
    await assert.rejects(readCodexSelection(f.args), { code: 'UNSUPPORTED_SESSION_OWNERSHIP' });
    const resumed = await fixture(t, [...ordinary(), { type: 'session_meta', payload: change }, start(B), user(B), end(B)],
      { headerChanges: { thread_source: 'agent_created_thread' } });
    const result = await readCodexSelection(resumed.args);
    assert.deepEqual(result.candidates.map(item => item.capture.identity.unitId), [A]);
    assert.equal(result.blocked.code, 'UNSUPPORTED_SESSION_OWNERSHIP');
    assert.equal(result.blocked.offset, resumed.anchors[4].startByte);
  }
});

test('resumed Codex sessions accept version changes but block history-mode or identity drift', async t => {
  for (const mode of ['legacy', 'paginated']) {
    const input = (id, text) => mode === 'legacy' ? evt('user_message', { message: text }) : user(id, text);
    for (const [metadata, code] of [
      [{ history_mode: mode }, null],
      [{ history_mode: mode === 'legacy' ? 'paginated' : 'legacy' }, 'UNSUPPORTED_CODEX_HISTORY'],
      [{ session_id: C }, 'UNSUPPORTED_SESSION_OWNERSHIP'],
      [{ cli_version: null }, 'INVALID_SESSION_CLIENT_VERSION'],
    ]) {
      const f = await fixture(t, [start(A), input(A, 'Before update'), end(A),
        { type: 'session_meta', ordinal: metadata.history_mode === 'legacy' ? undefined : 4,
          payload: { cli_version: '0.200.0', ...metadata } },
        start(B), input(B, 'After update'), end(B)], { mode });
      const result = await readCodexSelection(f.args);
      assert.deepEqual(result.candidates.map(item => item.capture.identity.unitId), code ? [A] : [A, B]);
      if (code) {
        assert.deepEqual(result.blocked, { code, offset: f.anchors[3].startByte });
        assert.equal(codexPublicationPlan(result, A).heldReason, null);
      } else {
        assert.equal(result.blocked, null);
        assert.deepEqual(result.candidates.map(item => item.capture.evidence[0].text), ['Before update', 'After update']);
        for (const { capture } of result.candidates) {
          assert.equal(capture.reader.headerClientVersion, '0.156.1');
          assert.equal(Object.hasOwn(capture.reader, 'clientVersion'), false);
        }
      }
    }
  }
});

test('unsupported modes, roots and child sessions remain explicit diagnostics on another client version', async t => {
  for (const [changes, code] of [[{ history_mode: 'future-mode' }, 'UNSUPPORTED_CODEX_HISTORY'],
    ...[{ parent_thread_id: B }, { source: { subagent: 'review' } }, { session_id: B }, { forked_from_id: B }].map(item => [item, 'UNSUPPORTED_SESSION_OWNERSHIP'])]) {
    const f = await fixture(t, ordinary(), { headerChanges: { cli_version: '999.0.0', ...changes } });
    await assert.rejects(readCodexSelection(f.args), { code });
  }
  const f = await fixture(t, [start(A), { type: 'future-record', payload: {} }, end(A)], { headerChanges: { cli_version: '999.0.0' } });
  assert.equal((await readCodexSelection(f.args)).blocked.code, 'UNSUPPORTED_CODEX_RECORD');
});

test('ordinary legacy tool events and ordinal-free roots normalize and publish', async t => {
  const f = await fixture(t, [start(A), evt('user_message', { message: 'Do the work' }),
    response(A, 'custom_tool_call', { name: 'apply_patch', call_id: 'patch', input: 'patch' }),
    response(A, 'custom_tool_call_output', { call_id: 'patch', output: 'patch output' }),
    evt('patch_apply_end', { turn_id: A, call_id: 'patch', success: true, status: 'completed' }),
    response(A, 'function_call', { name: 'read', namespace: 'mcp', call_id: 'mcp', arguments: '{}' }),
    response(A, 'function_call_output', { call_id: 'mcp', output: 'failure' }),
    evt('mcp_tool_call_end', { turn_id: A, call_id: 'mcp', result: { Ok: { isError: true } } }),
    evt('web_search_end', { call_id: 'web', query: 'query' }), evt('image_generation_end', { call_id: 'image', result: 'binary-not-copied' }),
    evt('exited_review_mode', { review_output: { findings: [] } }), end(A)], { mode: 'legacy' });
  assert.ok(f.entries.every(row => row.ordinal === undefined));
  const result = await readCodexSelection(f.args), capture = result.candidates[0].capture;
  assert.equal(result.blocked, null); assert.deepEqual(capture.evidence.filter(item => item.kind === 'tool-result').map(item => item.outcome), ['succeeded', 'failed']);
  assert.ok(capture.evidence.some(item => item.tool === 'mcp.read')); assert.equal(capture.coverage.partial, true);
  const store = await privateIntakeFixture(t, f.source);
  const selection = await withIntakeLock(store, tx => controlSelection(tx, { source: f.source, request: f.request, expectedHash: null, authorize: async () => true }));
  const published = await withIntakeLock(store, tx => publishCapture(tx, { ...result.candidates[0], selectionHash: selection.hash,
    cursorHash: null, scan: codexPublicationPlan(result, A).scan, authorize: async () => true }));
  assert.equal(published.cursor.offset, f.bytes.length);
});

test('malformed and unsupported later records retain earlier completed candidates', async t => {
  const f = await fixture(t, [...ordinary(), { type: 'future-record', payload: {} }, start(B), user(B), end(B)]);
  const result = await readCodexSelection(f.args);
  assert.deepEqual(result.candidates.map(item => item.capture.identity.unitId), [A]);
  assert.equal(result.blocked.offset, f.anchors[4].startByte);
  const h = await fs.open(f.source.path, 'r+'); await h.write(Buffer.from('{bad}\n'), 0, 6, f.anchors[4].startByte); await h.close();
  const broken = await readCodexSelection(f.args);
  assert.equal(broken.candidates.length, 1); assert.equal(broken.blocked.code, 'INVALID_SESSION_RECORD');
  assert.equal(codexPublicationPlan(broken, A).heldReason, null);
});

test('per-unit faults and large final records do not discard other units', async t => {
  const f = await fixture(t, [...ordinary(), start(B), user(B), end(B, { last_agent_message: 'x'.repeat(70000) })]);
  const result = await readCodexSelection(f.args);
  assert.equal(result.candidates.length, 1); assert.equal(result.pending[0].reason, 'SOURCE_ANCHOR_LIMIT');
  const faulty = await fixture(t, [start(A), item(A, 'UserMessage', [{ type: 'future-content' }]), end(A), start(B), user(B), end(B)]);
  const later = await readCodexSelection(faulty.args);
  assert.deepEqual(later.candidates.map(item => item.capture.identity.unitId), [B]);
  assert.equal(later.pending[0].reason, 'UNSUPPORTED_CODEX_CONTENT');
  assert.equal(codexPublicationPlan(later, B).heldReason, 'UNSUPPORTED_CODEX_CONTENT');
});

test('empty completed units do not block later captures and accounting compacts long turns', async t => {
  const many = Array.from({ length: 1200 }, (_, i) => i % 2 ? { type: 'turn_context', payload: {} } : assistant(B, `Statement ${i}`));
  const f = await fixture(t, [start(A), { type: 'compacted', payload: { message: 'derived' } }, item(A, 'ContextCompaction', []), end(A), start(B), user(B), ...many, end(B)]);
  const result = await readCodexSelection(f.args), plan = codexPublicationPlan(result, B);
  assert.deepEqual(result.noEvidence, [A]); assert.equal(plan.heldReason, null);
  assert.equal(plan.scan.to.offset, f.bytes.length); assert.ok(plan.scan.accounted.length < 10);
});

test('NUL, escaping and many tool calls stay bounded with combined omissions', async t => {
  const calls = Array.from({ length: 1100 }, (_, i) => [
    response(A, 'function_call', { name: 'tool', call_id: `call-${i}`, arguments: '{}' }),
    response(A, 'function_call_output', { call_id: `call-${i}`, output: 'file\0name\u001b'.repeat(100) }),
    evt('token_count', {})]).flat();
  const f = await fixture(t, [start(A), user(A, '\u001b'.repeat(200000)), ...calls, end(A)]);
  const result = await readCodexSelection(f.args), capture = result.candidates[0].capture;
  assert.equal(result.pending.length, 0); assert.ok(serializeCapture(capture).length <= 2 * 1024 * 1024);
  assert.ok(capture.coverage.omissions.some(item => item.reason === 'control-characters-replaced'));
  assert.ok(capture.coverage.omissions.length < 10);
  assert.equal(codexPublicationPlan(result, A).heldReason, null);
});

test('late excluded child items stay structural and collaboration output never becomes evidence', async t => {
  const f = await fixture(t, [start(A), user(A),
    response(A, 'function_call', { name: 'wait', namespace: 'collaboration', call_id: 'child', arguments: '{}' }),
    response(A, 'function_call_output', { call_id: 'child', output: 'PRIVATE CHILD RESULT' }), end(A),
    evt('item_completed', { thread_id: B, turn_id: A, item: { type: 'SubAgentActivity', id: 'child' } }),
    evt('item_completed', { thread_id: S, turn_id: A, item: { type: 'CollabAgentToolCall', id: 'child' } })]);
  const result = await readCodexSelection(f.args);
  assert.equal(result.blocked, null); assert.equal(result.pending.length, 0);
  assert.doesNotMatch(serializeCapture(result.candidates[0].capture).toString(), /PRIVATE CHILD RESULT/);
  assert.ok(result.candidates[0].capture.coverage.omissions.some(item => item.reason === 'child-agent-output-excluded'));
});

test('mid-turn legacy activation excludes earlier untagged records and resolves a real boundary', async t => {
  const f = await fixture(t, [evt('user_message', { message: 'excluded steering' }), end(C), start(A), evt('user_message', { message: 'selected' }), end(A)],
    { mode: 'legacy', future: true, missingLower: true });
  const result = await readCodexSelection(f.args);
  assert.equal(result.blocked, null); assert.equal(result.candidates[0].capture.evidence[0].text, 'selected');
  assert.equal(result.anchorUpdates.length, 1);
});

test('stored anchors and persisted cursors resume without rereading the consumed prefix', async t => {
  for (const mode of ['legacy', 'paginated']) {
    const message = turn => mode === 'legacy' ? evt('user_message', { message: 'source' }) : user(turn);
    const f = await fixture(t, [end(C), start(A), message(A), end(A), start(B), message(B), end(B)], { mode, future: true });
    const first = await readCodexSelection(f.args), cursor = codexPublicationPlan(first, A).scan.to, reads = [];
    const resumed = await readCodexSelection({ ...f.args, state: first.selection, cursor, observeRead: item => reads.push(item) });
    assert.deepEqual(resumed.candidates.map(item => item.capture.identity.unitId), [B]);
    assert.ok(reads.filter(item => item.purpose === 'range').every(item => item.offset >= cursor.offset));
  }
});

test('native registration shares its header parser and historical reads cannot backfill future anchors', async t => {
  const f = await fixture(t, [start(C), user(C), end(C), start(A), user(A), end(A)]);
  const selected = { client: 'codex', sessionId: S, path: f.source.path, projectRoot: f.root };
  const registered = await inspectSourceBoundary(selected, { currentUnitId: A, verifyHeader: codexRegistrationHeader(selected) });
  assert.equal(registered.source.fileIdentity, f.source.fileIdentity);
  const state = applySelectionControl(f.state, { id: randomUUID(), client: 'codex', sessionId: S, operation: 'start', unitId: C, expectedRevision: f.state.revision },
    { sourceIdentity: f.source.fileIdentity, eofByte: f.anchors[0].startByte, unitId: C, startsMidRecord: false, record: null });
  const result = await readCodexSelection({ ...f.args, state });
  assert.deepEqual(result.anchorUpdates, []); assert.equal(result.selection.intervals[0].lower.record, null);
});

test('a discarded oversized suffix uses bounded chunks and a deadline returns an explicit limit', async t => {
  const f = await fixture(t);
  const offset = f.bytes.length; await fs.appendFile(f.source.path, 'x'.repeat(SESSION_LINE_LIMIT + 2) + '\n');
  const scan = await readSessionRange({ source: f.source, from: offset, startsMidRecord: true, verifyHeader: async () => ({}) });
  assert.equal(scan.blocked, null); assert.equal(scan.discarded[0].endByte, offset + SESSION_LINE_LIMIT + 3);
  let clock = 0;
  const deadline = await readSessionRange({ source: f.source, from: offset, verifyHeader: async () => {
    clock = 11; return {};
  }, deadline: 10, now: () => clock });
  assert.equal(deadline.blocked.code, 'SESSION_READ_BUDGET'); assert.equal(deadline.limited, true);
});

test('malformed JSON/UTF-8, changed sources, and bounded line/byte budgets fail conservatively', async t => {
  for (const bytes of [Buffer.from('{bad}\n'), Buffer.from([0xff, 0x0a])]) {
    const f = await fixture(t); const h = await fs.open(f.source.path, 'r+'); await h.write(bytes, 0, bytes.length, f.anchors[0].startByte); await h.close();
    assert.equal((await readCodexSelection(f.args)).blocked.code, 'INVALID_SESSION_RECORD');
  }
  const f = await fixture(t);
  await fs.rename(f.source.path, f.source.path + '.old'); await fs.writeFile(f.source.path, f.bytes);
  await assert.rejects(readCodexSelection(f.args), { code: 'SOURCE_CHANGED' });
  const limit = await fixture(t);
  const limited = await readCodexSelection({ ...limit.args, maxBytes: 10 });
  assert.equal(limited.candidates.length, 0); assert.ok(limited.diagnostics.limited || limited.diagnostics.pendingTail);
  await fs.appendFile(limit.source.path, 'x'.repeat(SESSION_LINE_LIMIT + 1));
  assert.equal((await readSessionRange({ source: limit.source, from: limit.bytes.length, verifyHeader: async () => ({}) })).blocked.code, 'SESSION_RECORD_LIMIT');
});

test('fair tool budgets retain later native failures identically after a bounded retry', async t => {
  const calls = Array.from({ length: 8 }, (_, i) => response(A, 'function_call', {
    name: 'exec_command', call_id: `call-${i}`, arguments: 'arguments '.repeat(5000) }));
  const docs = Array.from({ length: 8 }, (_, i) => response(A, 'function_call_output', {
    call_id: `call-${i}`, output: 'Relevant API documentation '.repeat(2000) }));
  const f = await fixture(t, [start(A), user(A), ...calls, ...docs,
    response(A, 'function_call', { name: 'exec_command', call_id: 'late', arguments: '{"cmd":"test unchanged caller"}' }),
    response(A, 'function_call_output', { call_id: 'late', output: 'Failure: unchanged caller crashes.' }),
    evt('item_completed', { thread_id: S, turn_id: A, item: { id: 'late', type: 'CommandExecution', status: 'failed', exit_code: 1 } }),
    user(A, 'Correction: passing rebuilt callers did not prove binary compatibility.'), end(A)]);
  const limited = await readCodexSelection({ ...f.args, maxBytes: 100000 });
  assert.equal(limited.candidates.length, 0);
  const cursor = codexProgressPlan(limited).scan.to;
  assert.equal(cursor.offset, limited.from.offset);
  const resumed = await readCodexSelection({ ...f.args, cursor });
  const full = await readCodexSelection(f.args), capture = resumed.candidates[0].capture;
  assert.deepEqual(serializeCapture(capture), serializeCapture(full.candidates[0].capture));
  assert.equal(capture.reader.version, '4'); // Version 4 keeps the version 2 tool allocation.
  const result = capture.evidence.find(item => item.kind === 'tool-result' && item.callId === 'late');
  assert.equal(result.text, 'Failure: unchanged caller crashes.'); assert.equal(result.outcome, 'failed');
  assert(capture.evidence.some(item => item.kind === 'user' && item.text.startsWith('Correction:')));
  assert(capture.coverage.partial);
  assert(capture.coverage.omissions.some(item => item.reason === 'tool-call-call-limit'));
  assert(capture.coverage.omissions.some(item => item.reason === 'tool-result-call-limit'));
});

test('changed reader allocation cannot replace a finalized v1 capture', async t => {
  const output = 'x'.repeat(32768);
  const f = await fixture(t, [start(A), user(A),
    response(A, 'function_call', { name: 'exec_command', call_id: 'call', arguments: '{}' }),
    response(A, 'function_call_output', { call_id: 'call', output }), end(A)]);
  const result = await readCodexSelection(f.args), candidate = result.candidates[0];
  const old = createCapture({ ...candidate.capture, reader: { ...candidate.capture.reader, version: '1' },
    coverage: { partial: false, omissions: [] }, evidence: candidate.capture.evidence.map(item => item.kind === 'tool-result' ? { ...item, text: output } : item) });
  const store = await privateIntakeFixture(t, f.source);
  const selected = await withIntakeLock(store, tx => controlSelection(tx, { source: f.source, request: f.request, expectedHash: null, authorize: async () => true }));
  const args = { ...candidate, selectionHash: selected.hash, cursorHash: null,
    scan: codexPublicationPlan(result, A).scan, authorize: async () => true };
  const published = await withIntakeLock(store, tx => publishCapture(tx, { ...args, capture: old }));
  await assert.rejects(withIntakeLock(store, tx => publishCapture(tx, { ...args, expectedHeadHash: published.headHash })), { code: 'FINAL_CAPTURE_CONFLICT' });
  assert.equal((await readCaptureHead(store, old.identity)).hash, published.headHash);
  assert.deepEqual((await intakeSnapshot(store, 'raw', captureRelativePath(old.identity, old.evidenceHash))).bytes, serializeCapture(old));
});

test('tool truncation is UTF-8-safe, disclosed, and keeps the entire envelope bounded', async t => {
  const f = await fixture(t, [start(A), user(A), response(A, 'function_call', { name: 'tool', call_id: 'c', arguments: '{}' }),
    response(A, 'function_call_output', { call_id: 'c', output: '🦉'.repeat(16000) }), end(A)]);
  const capture = (await readCodexSelection(f.args)).candidates[0].capture;
  assert.ok(capture.coverage.omissions.some(item => item.reason === 'tool-result-call-limit'));
  assert.ok(Buffer.byteLength(capture.evidence.at(-1).text) <= 32768);
  assert.ok(!capture.evidence.at(-1).text.includes('\ufffd')); assert.ok(serializeCapture(capture).length <= 2 * 1024 * 1024);
});


test('Codex reader versions have explicit historical tool-allocation mappings', async t => {
  const { CODEX_READER_VERSION, CODEX_TOOL_RULES } = await import('./codex-reader.mjs');
  assert.equal(CODEX_TOOL_RULES['1'], '1'); assert.equal(CODEX_TOOL_RULES['2'], '2');
  assert(['1', '2'].includes(CODEX_TOOL_RULES[CODEX_READER_VERSION]), 'a reader bump must choose an independently supported tool rule set');
  const f = await fixture(t, ordinary());
  const current = (await readCodexSelection(f.args)).candidates[0].capture;
  for (const version of ['1', '2']) {
    const prior = { ...current, reader: { ...current.reader, version } };
    const read = await readCodexSelection({ ...f.args, loadHead: async () => ({ capture: prior }) });
    assert.equal(read.candidates[0].capture.reader.version, version);
  }
  const unknown = { ...current, reader: { ...current.reader, version: 'future' } };
  const refused = await readCodexSelection({ ...f.args, loadHead: async () => ({ capture: unknown }) });
  assert.equal(refused.candidates.length, 0); assert.equal(refused.pending[0].reason, 'INVALID_WORKFLOW');
});


test('malformed tool arguments after envelope exhaustion hold the unit with a workflow diagnostic', async t => {
  const f = await fixture(t, [start(A), ...Array.from({ length: 2048 }, () => user(A, 'Retained synthetic evidence.')),
    response(A, 'function_call', { name: 'exec_command', call_id: 'missing-arguments' }), end(A)]);
  const result = await readCodexSelection(f.args);
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.pending, [{ unitId: A, reason: 'INVALID_WORKFLOW' }]);
});

// This plugin's skill selection and control server, by native identity. The
// skill path is any install's (never this reader's own location): the rule
// must not depend on where the plugin is installed.
const skillPath = path.resolve('synthetic-plugin', 'skills', 'cuefluent-notes', 'SKILL.md');
const skillUser = (turn, text, { path: selected = skillPath, name = 'cuefluent-notes', fields = {}, extra = [] } = {}) =>
  item(turn, 'UserMessage', [{ type: 'skill', name, path: selected, ...fields }, { type: 'text', text, text_elements: [] }, ...extra]);
const controlExchange = (turn, id, { namespace = 'mcp__cuefluent_control', server = 'cuefluent_control', tool = 'processing_review', native = true } = {}) => [
  response(turn, 'function_call', { namespace, name: 'processing_review', call_id: id, arguments: '{}' }),
  ...(native ? [evt('item_completed', { thread_id: S, turn_id: turn, item: { type: 'McpToolCall', id, server, tool, arguments: {}, status: 'completed',
    result: { content: [{ type: 'text', text: '{"statusText":"Cuefluent: Draft t7xb88 is ready. Review folder: /private/review/t7xb88"}' }] } } })] : []),
  response(turn, 'function_call_output', { call_id: id, output: '{"statusText":"Cuefluent: Draft t7xb88 is ready. Review folder: /private/review/t7xb88"}' })];
const otherWork = turn => [response(turn, 'function_call', { name: 'exec_command', call_id: 'work', arguments: '{"cmd":"git status"}' }),
  response(turn, 'function_call_output', { call_id: 'work', output: 'Working tree clean.' })];

test('a Codex unit started with this skill keeps what the person typed and leaves out only its control exchange', async t => {
  for (const typed of ['review sav t7xb88', 'review save t7xb88\nAlso tag it urgent.', 'Please process my notes.']) await t.test(JSON.stringify(typed), async t => {
    const f = await fixture(t, [start(A), skillUser(A, typed), ...controlExchange(A, 'cue-1'), ...otherWork(A),
      assistant(A, 'Nothing was applied.'), end(A)]);
    const capture = (await readCodexSelection(f.args)).candidates[0].capture;
    assert.equal(capture.reader.version, '4');
    assert.deepEqual(capture.evidence.map(item => [item.kind, item.callId ?? null, item.text]), [
      ['user', null, typed], ['tool-call', 'work', '{"cmd":"git status"}'], ['tool-result', 'work', 'Working tree clean.'],
      ['assistant', null, 'Nothing was applied.']]);
    // The skill block is command markup, not an omission: coverage is complete.
    assert.deepEqual(capture.coverage, { partial: false, omissions: [] });
    assert.doesNotMatch(serializeCapture(capture).toString(), /Review folder|cuefluent_control/);
  });
  // A result persisted only as its native output item is left out the same way.
  const [call, native] = controlExchange(A, 'cue-2');
  const itemOnly = await fixture(t, [start(A), skillUser(A, 'review sav t7xb88'), call, native,
    evt('item_completed', { thread_id: S, turn_id: A, item: { type: 'FunctionCallOutput', id: 'cue-2', output: 'Cuefluent: Review folder: /private/review/t7xb88' } }), end(A)]);
  const kept = (await readCodexSelection(itemOnly.args)).candidates[0].capture;
  assert.deepEqual(kept.evidence.map(item => [item.kind, item.text]), [['user', 'review sav t7xb88']]);
  // A control mixed with a second message in the same unit keeps both.
  const mixed = await fixture(t, [start(A), skillUser(A, 'review save t7xb88'), user(A, 'Also: tag it urgent.'), ...controlExchange(A, 'cue-1'), end(A)]);
  assert.deepEqual((await readCodexSelection(mixed.args)).candidates[0].capture.evidence
    .filter(item => item.kind === 'user').map(item => item.text), ['review save t7xb88', 'Also: tag it urgent.']);
});

test('Codex control exchanges are left out in every unit by native identity alone, never by a name or text', async t => {
  const exchanged = capture => capture.evidence.filter(item => item.callId === 'cue-1').map(item => item.kind);
  // Without this skill (none, another skill, another block shape) the person's
  // words stay and so does a skill block that is not this plugin's markup; the
  // control exchange is left out all the same.
  for (const [name, typed, { omission = false } = {}] of [
    ['no skill block', user(A, 'review save t7xb88')],
    ['another skill name', skillUser(A, 'review sav t7xb88', { name: 'other-notes' }), { omission: true }],
    ['another block shape', skillUser(A, 'review sav t7xb88', { fields: { version: '1' } }), { omission: true }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, [start(A), typed, ...controlExchange(A, 'cue-1'), end(A)]), capture = (await readCodexSelection(f.args)).candidates[0].capture;
    assert.deepEqual(exchanged(capture), []);
    assert.deepEqual(capture.evidence.map(item => item.kind), ['user']);
    assert.equal(capture.coverage.omissions.some(item => item.reason === 'unsupported-content-block'), omission);
    // Version 3 left such an exchange in: a published v3 head replays unchanged.
    const v3 = { ...capture, reader: { ...capture.reader, version: '3' } };
    const replayed = (await readCodexSelection({ ...f.args, loadHead: async () => ({ capture: v3 }) })).candidates[0].capture;
    assert.deepEqual(exchanged(replayed), ['tool-call', 'tool-result']);
    const again = (await readCodexSelection({ ...f.args, loadHead: async () => ({ capture: replayed }) })).candidates[0].capture;
    assert.equal(again.evidenceHash, replayed.evidenceHash);
  });
  // Anything short of the exact native identity stays, with or without the skill.
  for (const [name, options] of [['another namespace', { namespace: 'mcp__other_control' }], ['another server', { server: 'other_control' }],
    ['another native tool', { tool: 'processing_status' }], ['no native MCP item', { native: false }]]) {
    for (const [form, typed] of [['skill', skillUser(A, 'review sav t7xb88')], ['no skill', user(A, 'Please review the draft.')]]) await t.test(`${name}, ${form}`, async t => {
      const f = await fixture(t, [start(A), typed, ...controlExchange(A, 'cue-1', options), end(A)]), capture = (await readCodexSelection(f.args)).candidates[0].capture;
      assert.deepEqual(exchanged(capture), ['tool-call', 'tool-result']);
    });
  }
});

// Codex CLI 0.163 attaches a skill picked from the `$` list as a separate user
// context item and records the mention as text; tool calls run in code mode.
const turn = options => codexControlTurn({ sessionId: S, unitId: A, skillPath, ...options });
const kept = capture => capture.evidence.map(entry => [entry.kind, entry.text]);
test('Codex 0.163: a skill picked from the list is markup, and its code-mode control cells are left out', async t => {
  for (const [name, options, typed] of [
    ['not an exact command', { control: 'sav t7xb88' }, 'sav t7xb88'],
    ['a control with more words', { control: 'save t7xb88 and tag it urgent' }, 'save t7xb88 and tag it urgent'],
    ['finished by wait', { control: 'sav t7xb88', waits: 2 }, 'sav t7xb88'],
    ['direct call', { control: 'sav t7xb88', mode: 'direct' }, 'sav t7xb88'],
  ]) await t.test(name, async t => {
    const { rows } = turn(options), f = await fixture(t, rows);
    const capture = (await readCodexSelection(f.args)).candidates[0].capture;
    assert.equal(capture.reader.version, '4');
    // The typed words stay; the mention, the selection item, the cells, their
    // nested calls and outputs and any wait are left out, and so is the
    // assistant's repetition of this plugin's reply.
    assert.deepEqual(kept(capture), [['user', typed]]);
    assert.deepEqual(capture.coverage, { partial: false, omissions: [] });
    assert.doesNotMatch(serializeCapture(capture).toString(), /SYNTHETIC SKILL INSTRUCTIONS|cuefluent_control|tools\.mcp|verification-required|\$cuefluent-notes/);
  });
  // Exactly one action with the skill picked is only the command; with the
  // plugin's reply and its cells left out, the turn holds no evidence.
  await t.test('an exact control without its receipt', async t => {
    const read = await readCodexSelection((await fixture(t, turn({ control: 'review' }).rows)).args);
    assert.deepEqual(read.candidates, []); assert.deepEqual(read.noEvidence, [A]);
  });
  // The assistant's own words in the turn always stay, commentary included.
  await t.test('commentary stays evidence', async t => {
    const capture = (await readCodexSelection((await fixture(t, turn({ control: 'review',
      commentary: ['Diagnosis: the Cedar cache bug is the 25-minute TTL.'] }).rows)).args)).candidates[0].capture;
    assert.deepEqual(kept(capture), [['assistant', 'Diagnosis: the Cedar cache bug is the 25-minute TTL.']]);
  });
  await t.test('a reply that adds to the plugin reply stays', async t => {
    const rows = turn({ control: 'review' }).rows;
    for (const row of rows) {
      if (row.payload?.item?.phase === 'final_answer') row.payload.item.content[0].text += ' Note: the audit ends Friday.';
      if (row.type === 'response_item' && row.payload.role === 'assistant' && row.payload.phase === 'final_answer') row.payload.content[0].text += ' Note: the audit ends Friday.';
    }
    const capture = (await readCodexSelection((await fixture(t, rows)).args)).candidates[0].capture;
    assert.deepEqual(kept(capture), [['assistant', 'Cuefluent: Draft t7xb88 is ready. Review folder: /private/review/t7xb88 Note: the audit ends Friday.']]);
  });
  // Markup belongs only to the message the selection was made for: a later
  // message in the same turn that starts with the mention keeps it.
  await t.test('a later message keeps its mention', async t => {
    const rows = turn({ control: 'review' }).rows, later = '$cuefluent-notes is the command documented in our onboarding guide.';
    rows.splice(rows.findIndex(row => row.payload?.item?.phase === 'final_answer'), 0, evt('item_completed', { thread_id: S, turn_id: A,
      item: { type: 'UserMessage', id: 'later-message', content: [{ type: 'text', text: later, text_elements: [] }] } }));
    const capture = (await readCodexSelection((await fixture(t, rows)).args)).candidates[0].capture;
    assert.deepEqual(kept(capture), [['user', later]]);
    assert.deepEqual(capture.coverage, { partial: false, omissions: [] });
  });
  // The mention alone (the command list) leaves no typed words.
  const alone = await fixture(t, turn({ control: 'help' }).rows.map(row => row.payload?.item?.type === 'UserMessage'
    ? { ...row, payload: { ...row.payload, item: { ...row.payload.item, content: [{ ...row.payload.item.content[0], text: MENU_MENTION }] } } } : row));
  assert.deepEqual((await readCodexSelection(alone.args)).candidates, []);
});

test('Codex 0.163: a code-mode cell stays evidence when anything else could have happened in it', async t => {
  const nestedItem = value => evt('item_completed', { thread_id: S, turn_id: A, item: value });
  const command = () => nestedItem({ type: 'CommandExecution', id: `exec-${randomUUID()}`, status: 'completed', exit_code: 0 });
  const insertAfter = (rows, test, ...added) => { rows.splice(rows.findIndex(test) + 1, 0, ...added); return rows; };
  const firstCell = row => row.payload?.type === 'custom_tool_call';
  const firstOutput = rows => rows.find(row => row.payload?.type === 'custom_tool_call_output');
  for (const [name, mutate, keptCells] of [
    // The other cell, which only made its control call, is still left out.
    ['a nested command in the cell (reading SKILL.md)', rows => insertAfter(rows, firstCell, command()), ['call_cell_1']],
    ['a nested call to another server', rows => insertAfter(rows, firstCell, nestedItem({ type: 'McpToolCall', id: `exec-${randomUUID()}`,
      server: 'other_server', tool: 'write', arguments: {}, status: 'completed', result: { content: [] } })), ['call_cell_1']],
    ['the cell printed something else', rows => { firstOutput(rows).payload.output[1].text += '\nA computed fact.'; return rows; }, ['call_cell_1']],
    ['a notify output', rows => insertAfter(rows, firstCell, response(A, 'custom_tool_call_output', { call_id: 'call_cell_1', output: 'A fact the cell announced.' })), ['call_cell_1']],
    ['a running cell printed something', rows => { firstOutput(rows).payload.output[0].text = framing('Script running with cell ID 3'); return rows; }, ['call_cell_1']],
    // A nested item no single cell owns keeps every cell.
    ['a nested item after every cell', rows => insertAfter(rows, row => row.payload?.item?.phase === 'final_answer', command()), ['call_cell_1', 'call_cell_2']],
    ['two cells open at once', rows => { const second = rows.findIndex((row, i) => firstCell(row) && i > rows.findIndex(firstCell));
      const [cell] = rows.splice(second, 1); rows.splice(rows.findIndex(firstCell) + 1, 0, cell); return rows; }, ['call_cell_1', 'call_cell_2']],
    ['a child agent ran', rows => insertAfter(rows, firstCell, nestedItem({ type: 'CollabAgentToolCall', id: 'collab-1' })), ['call_cell_1', 'call_cell_2']],
  ]) for (const [form, control] of [['menu', 'sav t7xb88'], ['plain', 'Please save the draft.']]) await t.test(`${name} (${form})`, async t => {
    // The same per-cell rule applies whether or not the skill was picked.
    const f = await fixture(t, mutate(turn({ form, control }).rows)), capture = (await readCodexSelection(f.args)).candidates[0].capture;
    assert.deepEqual(capture.evidence.filter(entry => entry.kind === 'tool-call').map(entry => entry.callId), keptCells);
    assert.deepEqual(capture.evidence.filter(entry => entry.kind === 'user').map(entry => entry.text), [control]);
  });
});

test('Codex 0.163: a mention typed by hand is kept as typed while its control exchanges are left out', async t => {
  for (const mode of ['code', 'direct']) await t.test(mode, async t => {
    const f = await fixture(t, turn({ form: 'typed', control: 'save t7xb88', mode }).rows), capture = (await readCodexSelection(f.args)).candidates[0].capture;
    // Codex attached no skill, so nothing is markup: the whole message stays.
    assert.deepEqual(kept(capture)[0], ['user', '$cuefluent-notes save t7xb88']);
    assert.equal(capture.evidence.filter(entry => entry.kind.startsWith('tool-')).length, 0);
    assert.deepEqual(capture.coverage, { partial: false, omissions: [] });
  });
  // As in the attended run: the assistant first reads SKILL.md in a cell of its
  // own, and the control call it then makes is refused. The reading cell stays;
  // the refused control cell is left out.
  const rows = turn({ form: 'typed', control: 'review', commentary: [] }).rows;
  const first = rows.findIndex(row => row.payload?.type === 'custom_tool_call');
  rows.splice(first, 0, response(A, 'custom_tool_call', { call_id: 'call_read', name: 'exec', input: 'text(await tools.exec_command({cmd: "cat SKILL.md"}))' }),
    evt('item_completed', { thread_id: S, turn_id: A, item: { type: 'CommandExecution', id: `exec-${randomUUID()}`, status: 'completed', exit_code: 0 } }),
    { type: 'response_item', metadata: { client_authored: false }, payload: { type: 'custom_tool_call_output', call_id: 'call_read', output: [
      { type: 'input_text', text: framing() }, { type: 'input_text', text: 'SYNTHETIC SKILL TEXT' }], internal_chat_message_metadata_passthrough: { turn_id: A } } });
  const refusal = rows.find(row => row.payload?.item?.type === 'McpToolCall').payload.item, message = codexToolError(refusal.tool, 'Synthetic refusal: not a command.');
  Object.assign(refusal, { status: 'failed', error: { message } }); delete refusal.result;
  rows.find(row => row.payload?.call_id === 'call_cell_1' && row.payload.type === 'custom_tool_call_output').payload.output[1].text =
    JSON.stringify({ content: [{ type: 'text', text: message }], isError: true });
  const read = (await readCodexSelection((await fixture(t, rows)).args)).candidates[0].capture;
  assert.deepEqual(read.evidence.filter(entry => entry.kind.startsWith('tool-')).map(entry => [entry.kind, entry.callId]),
    [['tool-call', 'call_read'], ['tool-result', 'call_read']]);
  assert.doesNotMatch(serializeCapture(read).toString(), /Synthetic refusal|cuefluent_control/);
  // Text that merely names the plugin elsewhere is the person's own words and
  // stays as typed; the control exchange is left out as in every unit.
  const later = turn({ form: 'typed', control: 'sav t7xb88', mode: 'direct' }).rows.map(row => row.payload?.item?.type === 'UserMessage'
    ? { ...row, payload: { ...row.payload, item: { ...row.payload.item, content: [{ type: 'text', text: 'Please run $cuefluent-notes status.', text_elements: [] }] } } } : row);
  const ordinaryUnit = (await readCodexSelection((await fixture(t, later)).args)).candidates[0].capture;
  assert.deepEqual(kept(ordinaryUnit), [['user', 'Please run $cuefluent-notes status.']]);
});

// A Codex unit with no skill picked and no mention, such as a request in the
// person's own words that the model answers by calling this plugin's control.
const commandPrefix = '$cuefluent-notes';
const helpReply = processingControlStatusView({ status: 'idle', nextAction: 'none', commandPrefix, help: true }, { collectionId: 'example' }).statusText;
const notCommandReply = processingControlStatusView({ status: 'idle', nextAction: 'none', commandPrefix, command: 'not-a-command', suggestions: ['save'] },
  { collectionId: 'example' }).statusText;
// What a chat with nothing set up gets (processing-mcp.mjs unboundStatus).
const unboundReply = processingControlStatusView({ status: 'missing', statusDetail: 'unbound', nextAction: 'none',
  diagnostics: ['PROCESSING_CONTROL_SOURCE_UNVERIFIED'], help: true, commandPrefix }, { collectionId: null }).statusText;
const refusalReply = processingControlRefusalText('PROCESSING_CONTROL_SOURCE_UNVERIFIED', { client: 'codex', stage: 'binding', tool: 'processing_status' });
// The control call is refused: its native item fails with the error as Codex
// records it (`recorded`, by default its framing around the refusal), which
// the cell prints as Codex shows a failed call, and the assistant relays
// `relay` (by default the plain refusal, as it is told to).
function refused(rows, message, mode, { recorded, relay = message } = {}) {
  const calls = rows.filter(row => row.payload?.item?.type === 'McpToolCall'), call = calls.at(-1).payload.item;
  const error = recorded ?? codexToolError(call.tool, message);
  Object.assign(call, { status: 'failed', error: { message: error } }); delete call.result;
  const output = rows.findLast(row => row.payload?.call_id === (mode === 'direct' ? 'dispatch-call' : 'call_cell_2') && row.payload.type.endsWith('_output')).payload;
  if (mode === 'direct') output.output = error;
  else output.output[1].text = JSON.stringify({ content: [{ type: 'text', text: error }], isError: true });
  for (const row of rows) {
    if (row.payload?.item?.phase === 'final_answer') row.payload.item.content[0].text = relay;
    if (row.type === 'response_item' && row.payload.role === 'assistant' && row.payload.phase === 'final_answer') row.payload.content[0].text = relay;
    if (row.payload?.type === 'task_complete') row.payload.last_agent_message = relay;
  }
  return rows;
}
test('Codex: a plain-language request keeps its words while this plugin\'s control traffic and repeated replies are left out', async t => {
  const typed = 'Please process my notes.', plain = options => turn({ form: 'plain', control: typed, calledTool: 'process_selected_captures', ...options });
  for (const [name, rows] of [
    ['code mode', plain().rows], ['code mode finished by wait', plain({ waits: 2 }).rows], ['direct call', plain({ mode: 'direct' }).rows],
    ['a first turn', plain({ firstTurn: true }).rows],
    ['the command list', plain({ statusText: helpReply, calledTool: 'processing_status' }).rows],
    ['a not-a-command reply', plain({ statusText: notCommandReply, calledTool: 'processing_status', mode: 'direct' }).rows],
    ['the reply before setup', plain({ statusText: unboundReply, calledTool: 'processing_status' }).rows],
    ['a refusal in code mode', refused(plain({ calledTool: 'processing_status' }).rows, refusalReply, 'code')],
    ['a refusal, direct', refused(plain({ calledTool: 'processing_status', mode: 'direct' }).rows, refusalReply, 'direct')],
    ['a refusal relayed with Codex\'s framing', refused(plain({ calledTool: 'processing_status' }).rows, refusalReply, 'code',
      { relay: codexToolError('processing_status', refusalReply) })],
    ['a refusal of several lines', refused(plain({ calledTool: 'processing_status' }).rows, `${refusalReply}\n\nType $cuefluent-notes status.`, 'code')],
  ]) await t.test(name, async t => {
    const capture = (await readCodexSelection((await fixture(t, rows)).args)).candidates[0].capture;
    assert.equal(capture.reader.version, '4');
    // The person's words stay exactly as typed; the cells, calls, outputs,
    // nested items, waits and the assistant's repetition of the reply do not.
    assert.deepEqual(kept(capture), [['user', typed]]);
    assert.deepEqual(capture.coverage, { partial: false, omissions: [] });
    assert.doesNotMatch(serializeCapture(capture).toString(), /cuefluent_control|tools\.mcp|verification-required|statusText|Cuefluent:|Cuefluent processing/);
  });
  // Only Codex's exact framing yields the plain refusal: any other framing keeps
  // the relay, while the call itself is still left out by native identity.
  for (const [name, recorded, relay = refusalReply] of [
    ['another tool in the framing', codexToolError('processing_review', refusalReply)],
    ['another server in the framing', codexToolError('processing_status', refusalReply, { server: 'other_control' })],
    ['no error data', codexToolError('processing_status', refusalReply, { data: null })],
    ['other error data', codexToolError('processing_status', refusalReply, { data: { code: 'X', detail: 'y' } })],
    // Four other characters where the indent belongs: stripping them would yield the relay.
    ['a line not indented', codexToolError('processing_status', `${refusalReply}\nmore`).replace('\n    more', '\nXXXXmore'), `${refusalReply}\nmore`],
    ['several causes', codexToolError('processing_status', refusalReply).replace('Caused by:\n    ', 'Caused by:\n    0: transport\n    1: ')],
    ['no code', codexToolError('processing_status', refusalReply).replace('-32600: ', '')],
  ]) for (const mode of ['code', 'direct']) await t.test(`${name} keeps the relay (${mode})`, async t => {
    const rows = refused(plain({ calledTool: 'processing_status', mode }).rows, refusalReply, mode, { recorded, relay });
    const capture = (await readCodexSelection((await fixture(t, rows)).args)).candidates[0].capture;
    assert.deepEqual(kept(capture), [['user', typed], ['assistant', relay]]);
    assert.doesNotMatch(serializeCapture(capture).toString(), /cuefluent_control|tool call error/);
  });
  // Text alone never identifies anything: an exact action typed without the
  // skill is the person's own words and stays.
  await t.test('an exact action typed without the skill', async t => {
    const capture = (await readCodexSelection((await fixture(t, turn({ form: 'plain', control: 'review' }).rows)).args)).candidates[0].capture;
    assert.deepEqual(kept(capture), [['user', 'review']]);
  });
  await t.test('commentary and a reply with added words stay', async t => {
    const rows = plain({ commentary: ['Diagnosis: the Cedar cache bug is the 25-minute TTL.'] }).rows;
    for (const row of rows) {
      if (row.payload?.item?.phase === 'final_answer') row.payload.item.content[0].text += ' The audit ends Friday.';
      if (row.type === 'response_item' && row.payload.role === 'assistant' && row.payload.phase === 'final_answer') row.payload.content[0].text += ' The audit ends Friday.';
    }
    const capture = (await readCodexSelection((await fixture(t, rows)).args)).candidates[0].capture;
    assert.deepEqual(kept(capture), [['user', typed], ['assistant', 'Diagnosis: the Cedar cache bug is the 25-minute TTL.'],
      ['assistant', 'Cuefluent: Draft t7xb88 is ready. Review folder: /private/review/t7xb88 The audit ends Friday.']]);
  });
  // Only the assistant can repeat a reply: the person pasting it is their input.
  await t.test('the person pasting the reply keeps it', async t => {
    const rows = plain().rows, pasted = 'Cuefluent: Draft t7xb88 is ready. Review folder: /private/review/t7xb88';
    rows.splice(rows.findIndex(row => row.payload?.item?.phase === 'final_answer'), 0, evt('item_completed', { thread_id: S, turn_id: A,
      item: { type: 'UserMessage', id: 'pasted-message', content: [{ type: 'text', text: pasted, text_elements: [] }] } }));
    const capture = (await readCodexSelection((await fixture(t, rows)).args)).candidates[0].capture;
    assert.deepEqual(kept(capture), [['user', typed], ['user', pasted]]);
  });
  // A reply is the reply of a control call in its own unit: the same words in
  // another unit, with no control call there, are that unit's assistant text.
  await t.test('the same words in another unit stay', async t => {
    const echo = 'Cuefluent: Draft t7xb88 is ready. Review folder: /private/review/t7xb88';
    const capture = (await readCodexSelection((await fixture(t, [...plain().rows, start(B), user(B, 'What did it say?'), assistant(B, echo), end(B)])).args))
      .candidates.find(entry => entry.capture.identity.unitId === B).capture;
    assert.deepEqual(kept(capture), [['user', 'What did it say?'], ['assistant', echo]]);
  });
  // Published version 1-3 heads keep their rules: the cells and the relayed
  // reply stay, and every replay reproduces the same bytes.
  for (const mode of ['code', 'direct']) for (const version of ['1', '2', '3']) await t.test(`a published v${version} head replays unchanged (${mode})`, async t => {
    const f = await fixture(t, plain({ mode, statusText: helpReply, calledTool: 'processing_status' }).rows);
    const current = (await readCodexSelection(f.args)).candidates[0].capture;
    const replayed = (await readCodexSelection({ ...f.args, loadHead: async () => ({ capture: { ...current, reader: { ...current.reader, version } } }) })).candidates[0].capture;
    assert.equal(replayed.reader.version, version);
    assert.deepEqual(replayed.evidence.filter(entry => entry.kind === 'tool-call').map(entry => entry.callId), mode === 'code' ? ['call_cell_1', 'call_cell_2'] : ['dispatch-call']);
    assert.deepEqual(replayed.evidence.filter(entry => entry.kind !== 'tool-call' && entry.kind !== 'tool-result').map(entry => [entry.kind, entry.text]),
      [['user', typed], ['assistant', helpReply]]);
    const again = (await readCodexSelection({ ...f.args, loadHead: async () => ({ capture: replayed }) })).candidates[0].capture;
    assert.equal(again.evidenceHash, replayed.evidenceHash); assert.deepEqual(serializeCapture(again), serializeCapture(replayed));
  });
});

test('reader version 3 replays a published 0.163 unit unchanged: its mention and code-mode cells stay', async t => {
  const { rows } = turn({ control: 'sav t7xb88' }), f = await fixture(t, rows);
  const current = (await readCodexSelection(f.args)).candidates[0].capture;
  const prior = { ...current, reader: { ...current.reader, version: '3' } };
  const replayed = (await readCodexSelection({ ...f.args, loadHead: async () => ({ capture: prior }) })).candidates[0].capture;
  assert.equal(replayed.reader.version, '3');
  assert.deepEqual(replayed.evidence.find(entry => entry.kind === 'user').text, `${MENU_MENTION} sav t7xb88`);
  assert.deepEqual(replayed.evidence.filter(entry => entry.kind === 'tool-call').map(entry => entry.callId), ['call_cell_1', 'call_cell_2']);
  assert.notEqual(replayed.evidenceHash, current.evidenceHash);
  // Version 3 never applied the code-mode rule, even with the older skill part.
  const block = await fixture(t, turn({ form: 'block', control: 'sav t7xb88' }).rows);
  const blockNow = (await readCodexSelection(block.args)).candidates[0].capture;
  assert.deepEqual(blockNow.evidence.filter(entry => entry.kind === 'tool-call'), []);
  const blockV3 = (await readCodexSelection({ ...block.args, loadHead: async () => ({ capture: { ...blockNow, reader: { ...blockNow.reader, version: '3' } } }) })).candidates[0].capture;
  assert.deepEqual(blockV3.evidence.filter(entry => entry.kind === 'tool-call').map(entry => entry.callId), ['call_cell_1', 'call_cell_2']);
  // Same rules, same bytes on every later replay of either version.
  for (const capture of [replayed, current]) {
    const again = (await readCodexSelection({ ...f.args, loadHead: async () => ({ capture }) })).candidates[0].capture;
    assert.equal(again.evidenceHash, capture.evidenceHash);
  }
});

test('the version 3 and 4 skill rules ignore the install path, so a published unit replays unchanged after an upgrade', async t => {
  // Each plugin version installs at its own path and a transcript keeps the
  // path of the version that ran; neither is this reader's location.
  const installs = ['0.15.1', '0.16.0'].map(version => path.resolve('plugins', 'cache', 'cuefluent-notes', version, 'SKILL.md'));
  for (const ran of installs) for (const version of ['3', '4']) await t.test(`${path.basename(path.dirname(ran))} v${version}`, async t => {
    const f = await fixture(t, [start(A), skillUser(A, 'review sav t7xb88', { path: ran }), ...controlExchange(A, 'cue-1'), assistant(A, 'Nothing was applied.'), end(A)]);
    const read = (await readCodexSelection(f.args)).candidates[0].capture;
    const published = { ...read, reader: { ...read.reader, version } };
    assert.deepEqual(published.evidence.map(item => [item.kind, item.text]), [['user', 'review sav t7xb88'], ['assistant', 'Nothing was applied.']]);
    assert.deepEqual(published.coverage, { partial: false, omissions: [] });
    // Replaying the published head reproduces its exact evidence.
    const replayed = (await readCodexSelection({ ...f.args, loadHead: async () => ({ capture: published }) })).candidates[0].capture;
    assert.equal(replayed.reader.version, version); assert.equal(replayed.evidenceHash, published.evidenceHash);
    assert.deepEqual(replayed.evidence, published.evidence); assert.deepEqual(replayed.coverage, published.coverage);
  });
});

test('published version 2 Codex captures keep their skill-block omission and control exchange on replay', async t => {
  const { CODEX_SKILL_RULES, CODEX_READER_VERSION } = await import('./codex-reader.mjs');
  assert.equal(CODEX_SKILL_RULES[CODEX_READER_VERSION], 'mention'); assert.equal(CODEX_SKILL_RULES['3'], 'markup');
  const f = await fixture(t, [start(A), skillUser(A, 'review sav t7xb88'), ...controlExchange(A, 'cue-1'), end(A)]);
  const args = f.args, current = (await readCodexSelection(args)).candidates[0].capture;
  for (const version of ['1', '2']) {
    const prior = { ...current, reader: { ...current.reader, version } };
    const replayed = (await readCodexSelection({ ...args, loadHead: async () => ({ capture: prior }) })).candidates[0].capture;
    assert.equal(replayed.reader.version, version);
    assert.deepEqual(replayed.coverage.omissions.map(item => item.reason), ['unsupported-content-block']);
    assert.deepEqual(replayed.evidence.filter(item => item.callId === 'cue-1').map(item => item.kind), ['tool-call', 'tool-result']);
    // Same rules, same bytes: re-reading a published v2 unit cannot replace it.
    const again = (await readCodexSelection({ ...args, loadHead: async () => ({ capture: replayed }) })).candidates[0].capture;
    assert.equal(again.evidenceHash, replayed.evidenceHash);
  }
});
