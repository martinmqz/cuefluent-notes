import test from './test-support/storage-test.mjs';
import { privateIntakeFixture } from './test-support/intake-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readCodexSelection, codexPublicationPlan, codexRegistrationHeader } from './codex-reader.mjs';
import { readSessionRange, SESSION_LINE_LIMIT } from './session-jsonl.mjs';
import { newSelectionState, applySelectionControl, stableSourceIdentity, inspectSourceBoundary } from './capture-selection.mjs';
import { digest } from './workflow-values.mjs';
import { inspectIntakeStore, withIntakeLock } from './intake-io.mjs';
import { controlSelection, publishCapture } from './intake-store.mjs';
import { serializeCapture } from './capture-contract.mjs';

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

test('tool truncation is UTF-8-safe, disclosed, and keeps the entire envelope bounded', async t => {
  const f = await fixture(t, [start(A), user(A), response(A, 'function_call', { name: 'tool', call_id: 'c', arguments: '{}' }),
    response(A, 'function_call_output', { call_id: 'c', output: '🦉'.repeat(16000) }), end(A)]);
  const capture = (await readCodexSelection(f.args)).candidates[0].capture;
  assert.ok(capture.coverage.omissions.some(item => item.reason === 'tool-excerpt-truncated'));
  assert.ok(Buffer.byteLength(capture.evidence.at(-1).text) <= 32768);
  assert.ok(!capture.evidence.at(-1).text.includes('\ufffd')); assert.ok(serializeCapture(capture).length <= 2 * 1024 * 1024);
});
