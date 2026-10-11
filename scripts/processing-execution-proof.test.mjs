import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { stableSourceIdentity } from './capture-selection.mjs';
import { digest } from './workflow-values.mjs';
import { locateProcessingExecutionSource, resolveClaudeProcessingUnit,
  verifyProcessingExecution, verifyInterruptedProcessingExecution, isProcessingExecutionProof } from './processing-execution-proof.mjs';

const sid = '11111111-1111-4111-8111-111111111111', uid = '22222222-2222-4222-8222-222222222222';
const iid = '33333333-3333-4333-8333-333333333333', other = '44444444-4444-4444-8444-444444444444';
const prompt = 'Process the exact frozen workset using only the engine tools.';
const event = (type, more = {}) => ({ type: 'event_msg', payload: { type, ...more } });
const item = value => event('item_completed', { thread_id: sid, turn_id: uid, item: value });
const response = value => ({ type: 'response_item', payload: { ...value,
  internal_chat_message_metadata_passthrough: { turn_id: uid, ...(value.role === 'user' ? { content_item_kinds: ['user.text'] } : {}) } } });

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-execution-proof-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
async function fixture(t, client, mutate = () => {}) {
  const root = await temporary(t), file = path.join(root, `${sid}.jsonl`);
  const rows = client === 'codex' ? [
    { type: 'session_meta', payload: { id: sid, session_id: sid, cli_version: '0.157.1', cwd: root, source: 'cli', history_mode: 'paginated' } },
    event('task_started', { turn_id: uid, root_turn_id: uid }),
    response({ type: 'message', role: 'user', id: 'input', content: [{ type: 'input_text', text: prompt }] }),
    item({ type: 'UserMessage', id: 'input-view', content: [{ type: 'text', text: prompt, text_elements: [] }] }),
    response({ type: 'function_call', name: 'cuefluent_pending', call_id: 'call', arguments: '{}' }),
    item({ type: 'DynamicToolCall', tool: 'cuefluent_pending', id: 'call', namespace: null, status: 'completed', arguments: {}, success: true }),
    response({ type: 'function_call_output', call_id: 'call', output: '{"pending":1}' }),
    item({ type: 'AgentMessage', id: 'answer', content: [{ type: 'Text', text: 'Processing evidence and a generated draft.' }] }),
    response({ type: 'message', role: 'assistant', id: 'answer', content: [{ type: 'output_text', text: 'Processing evidence and a generated draft.' }] }),
    event('task_complete', { turn_id: uid, last_agent_message: 'Processing evidence and a generated draft.' }),
  ] : [
    { type: 'user', uuid: iid, parentUuid: null, sessionId: sid, promptId: uid,
      promptSource: 'sdk', turnOrigin: 'sdk', isSidechain: false, cwd: root, version: '2.1.296',
      message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: other, parentUuid: iid, sessionId: sid, isSidechain: false, cwd: root, version: '2.1.296',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Generated draft, not independent evidence.' }] } },
    { type: 'last-prompt', lastPrompt: prompt, leafUuid: iid, sessionId: sid },
  ];
  mutate(rows);
  const lines = rows.map((row, ordinal) => JSON.stringify({ timestamp: '2026-10-10T12:00:00.000Z', ...(client === 'codex' ? { ordinal } : {}), ...row }) + '\n');
  await fs.writeFile(file, lines.join(''), { mode: 0o600 });
  const source = { client, sessionId: sid, projectRoot: root, path: file,
    fileIdentity: stableSourceIdentity(await fs.lstat(file, { bigint: true })) };
  const request = { source, fromByte: client === 'codex' ? Buffer.byteLength(lines[0]) : 0, endByte: Buffer.byteLength(lines.join('')), unitId: uid };
  const receipt = Object.freeze({ client, sessionId: sid, unitId: uid, requestId: iid, inputId: iid, inputHash: digest(prompt),
    sourcePath: file, sourceIdentity: source.fileIdentity, profileId: 'a'.repeat(64), toolContractHash: 'b'.repeat(64),
    allowedTools: [client === 'codex' ? 'cuefluent_pending' : 'mcp__cuefluent_engine__pending'], completed: true, policyVerified: true });
  return { root, source, request, receipt, rows, lines,
    resolveExecution: async query => Object.entries(query).every(([key, value]) => receipt[key] === value) ? receipt : null };
}

test('Codex binds a completed restricted execution to exact user bytes and native unit', async t => {
  const f = await fixture(t, 'codex'), proof = await verifyProcessingExecution(f.request, f);
  assert.equal(isProcessingExecutionProof(proof), true); assert.equal(proof.evidenceScope, 'unit');
  assert.equal(proof.inputHash, digest(prompt)); assert.equal(proof.unitId, uid);
  assert.equal(proof.recordIds.length, f.rows.length - 1);
  assert.equal(isProcessingExecutionProof(structuredClone(proof)), false);
  assert.equal(isProcessingExecutionProof(Object.freeze({ ...proof })), false);
  assert.throws(() => proof.recordIds.push('forged'));
});

test('a completed native engine refusal remains attributed while unfinished or contradictory calls do not', async t => {
  const refused = rows => {
    rows[5].payload.item.status = 'failed'; rows[5].payload.item.success = false;
    rows[6].payload.output = '{"error":"PROCESSING_CLAIM_CHANGED"}';
  };
  const f = await fixture(t, 'codex', refused);
  assert.equal(isProcessingExecutionProof(await verifyProcessingExecution(f.request, f)), true);
  for (const mutate of [rows => { rows[5].payload.item.success = true; },
    rows => { rows[5].payload.item.status = 'inProgress'; }, rows => { rows.splice(6, 1); }]) {
    const altered = await fixture(t, 'codex', rows => { refused(rows); mutate(rows); });
    assert.equal(await verifyProcessingExecution(altered.request, altered), null);
  }
});

test('a native interrupted terminal is recovery-only and incomplete tools or mixed input remain unproven', async t => {
  const interruption = rows => {
    rows.at(-1).payload = { type: 'turn_aborted', turn_id: uid, reason: 'interrupted' };
    rows.splice(-1, 0, { type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>' }],
      internal_chat_message_metadata_passthrough: { turn_id: uid, content_item_kinds: ['generic.turn_aborted'] } } });
  };
  const f = await fixture(t, 'codex', interruption);
  const options = { resolveExecution: async () => Object.freeze({ ...f.receipt, terminal: 'interrupted' }) };
  assert.equal(isProcessingExecutionProof(await verifyInterruptedProcessingExecution(f.request, options)), true);
  assert.equal(await verifyProcessingExecution(f.request, options), null);
  assert.equal(await verifyInterruptedProcessingExecution(f.request, f), null);
  for (const [name, mutate] of Object.entries({
    'missing result': rows => { rows.splice(6, 1); },
    'unfinished native call': rows => { rows[5].payload.item.status = 'inProgress'; },
    'human correction': rows => { rows.splice(-2, 0, response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A correction.' }] })); },
    'wrong reason': rows => { rows.at(-1).payload.reason = 'shutdown'; },
    'unbound abort text': rows => { rows.at(-2).payload.internal_chat_message_metadata_passthrough.content_item_kinds = ['user.text']; },
  })) await t.test(name, async t => {
    const f = await fixture(t, 'codex', rows => { interruption(rows); mutate(rows); });
    assert.equal(await verifyInterruptedProcessingExecution(f.request, {
      resolveExecution: async () => Object.freeze({ ...f.receipt, terminal: 'interrupted' }),
    }), null);
  });
});

test('Codex retains mixed input, outside tools, unknown rows and incomplete execution', async t => {
  const mutations = {
    correction: rows => { rows[2].payload.content[0].text += ' Actually the deadline is Friday.'; },
    attachment: rows => { rows[3].payload.item.content.push({ type: 'image', url: 'synthetic.png' }); },
    'extra prompt': rows => { rows.splice(4, 0, structuredClone(rows[2])); },
    'outside tool': rows => { rows[4].payload.name = 'exec_command'; },
    'outside native tool': rows => { rows[5].payload.item.type = 'CommandExecution'; },
    'unmatched tool': rows => { rows[5].payload.item.id = 'other-call'; },
    'extra output': rows => { rows.splice(7, 0, structuredClone(rows[6])); },
    'foreign turn': rows => { rows[8].payload.internal_chat_message_metadata_passthrough.turn_id = other; },
    'unknown record': rows => { rows.splice(8, 0, { type: 'future_record', payload: { text: 'a correction' } }); },
    'compacted replacement history': rows => { rows.splice(8, 0, { type: 'compacted', payload: { message: 'Generated summary', replacement_history: [] } }); },
    'context compacted event': rows => { rows.splice(8, 0, event('context_compacted', { turn_id: uid })); },
    interrupted: rows => { rows.at(-1).payload.type = 'turn_aborted'; },
    'missing terminal': rows => { rows.pop(); },
  };
  for (const [name, change] of Object.entries(mutations)) await t.test(name, async t => {
    const f = await fixture(t, 'codex', change); assert.equal(await verifyProcessingExecution(f.request, f), null);
  });
});

test('a native identity or serialized receipt without trusted completed lookup is insufficient', async t => {
  const f = await fixture(t, 'codex');
  assert.equal(await verifyProcessingExecution(f.request, { resolveExecution: async () => null }), null);
  for (const change of [{ completed: false }, { policyVerified: false }, { sourceIdentity: 'different' },
    { sourcePath: path.join(f.root, 'other.jsonl') }, { inputHash: 'c'.repeat(64) }, { allowedTools: ['exec_command'] }]) {
    assert.equal(await verifyProcessingExecution(f.request, { resolveExecution: async () => Object.freeze({ ...f.receipt, ...change }) }), null);
  }
  assert.equal(await verifyProcessingExecution(f.request, { resolveExecution: async () => structuredClone(f.receipt) }), null);
});

test('persisted execution ranges reject changed generated bytes and widened ranges', async t => {
  const f = await fixture(t, 'codex'), first = await verifyProcessingExecution(f.request, f);
  const receipt = Object.freeze({ ...f.receipt, fromByte: first.fromByte, endByte: first.endByte, recordsHash: first.recordsHash });
  const resolveExecution = async () => receipt;
  assert.equal(isProcessingExecutionProof(await verifyProcessingExecution(f.request, { resolveExecution })), true);
  assert.equal(await verifyProcessingExecution({ ...f.request, endByte: f.request.endByte + 1 }, { resolveExecution }), null);
  const bytes = await fs.readFile(f.source.path, 'utf8');
  await fs.writeFile(f.source.path, bytes.replaceAll('generated draft', 'corrected draft'));
  assert.equal(await verifyProcessingExecution(f.request, { resolveExecution }), null);
});

test('Claude maps input UUID to its distinct native promptId and covers only exact input', async t => {
  const f = await fixture(t, 'claude');
  const mapping = await resolveClaudeProcessingUnit({ ...f.request, inputId: iid, inputHash: digest(prompt) });
  assert.equal(mapping.inputId, iid); assert.equal(mapping.unitId, uid); assert.notEqual(mapping.inputId, mapping.unitId);
  assert.equal(mapping.recordId, iid); assert.equal(mapping.endByte, Buffer.byteLength(f.lines[0]));
  const proof = await verifyProcessingExecution(f.request, f);
  assert.equal(isProcessingExecutionProof(proof), true); assert.equal(proof.evidenceScope, 'controller-input');
  assert.deepEqual(proof.recordIds, [iid]); assert.equal(proof.inputRange.hash, mapping.recordHash);
  assert.equal(proof.recordIds.includes(other), false);
});

test('Claude never treats assistant parent links as independent ownership', async t => {
  const f = await fixture(t, 'claude', rows => { rows[1].parentUuid = randomUUID(); });
  const proof = await verifyProcessingExecution(f.request, f);
  assert.deepEqual(proof.recordIds, [iid]); assert.equal(proof.evidenceScope, 'controller-input');
});

test('Claude keeps original corrections and attachments in the same native prompt', async t => {
  for (const content of ['Correction: the deadline is Friday.', [{ type: 'image', source: { type: 'base64', data: 'synthetic' } }]]) await t.test(JSON.stringify(content), async t => {
    const f = await fixture(t, 'claude', rows => { rows.push({ ...rows[0], uuid: randomUUID(), message: { role: 'user', content } }); });
    assert.equal(await verifyProcessingExecution(f.request, f), null);
  });
});

test('later human input and correction in a reused chat never inherit exclusion', async t => {
  for (const client of ['codex', 'claude']) await t.test(client, async t => {
    const f = await fixture(t, client), originalEnd = f.request.endByte;
    const extra = client === 'claude' ? [{ ...f.rows[0], uuid: randomUUID(), promptId: other, promptSource: 'prompt',
      message: { role: 'user', content: 'A genuine fix: use SDK 605.' } },
    { ...f.rows[0], uuid: randomUUID(), promptId: randomUUID(), promptSource: 'prompt', message: { role: 'user', content: 'Correction: 606.' } }]
      : [event('task_started', { turn_id: other, root_turn_id: other }),
        response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A genuine fix: use SDK 605.' }] }),
        event('task_complete', { turn_id: other })];
    await fs.appendFile(f.source.path, extra.map(row => JSON.stringify(row) + '\n').join(''));
    assert.equal(isProcessingExecutionProof(await verifyProcessingExecution(f.request, f)), true);
    const endByte = Number((await fs.stat(f.source.path)).size);
    assert.equal(await verifyProcessingExecution({ ...f.request, fromByte: originalEnd, endByte, unitId: other }, f), null);
    const sourceBytes = await fs.readFile(f.source.path, 'utf8'); assert.match(sourceBytes, /genuine fix/);
    assert.match(sourceBytes, /605/);
  });
});

test('mapping rejects duplicate UUID, altered bytes, non-SDK and unbounded/partial input', async t => {
  for (const [name, mutate] of Object.entries({
    duplicate: rows => { rows.push(structuredClone(rows[0])); },
    edited: rows => { rows[0].message.content += ' Correction'; },
    interactive: rows => { rows[0].promptSource = 'prompt'; },
    synthetic: rows => { rows[0].isMeta = true; },
  })) await t.test(name, async t => {
    const f = await fixture(t, 'claude', mutate);
    assert.equal(await resolveClaudeProcessingUnit({ ...f.request, inputId: iid, inputHash: digest(prompt) }), null);
  });
  const f = await fixture(t, 'claude');
  assert.equal(await resolveClaudeProcessingUnit({ ...f.request, endByte: 17 * 1024 * 1024, inputId: iid, inputHash: digest(prompt) }), null);
  await fs.appendFile(f.source.path, '{');
  assert.equal(await resolveClaudeProcessingUnit({ ...f.request, endByte: f.request.endByte + 1, inputId: iid, inputHash: digest(prompt) }), null);
});

test('exact owned Claude source lookup reads no unrelated session content or archives', async t => {
  const root = await temporary(t), profile = path.join(root, 'profile'), project = path.join(profile, 'projects', 'native-encoded-project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'unrelated.jsonl'), 'not JSON; must never be read');
  const session = { client: 'claude', sessionId: sid, cwd: root };
  assert.equal(await locateProcessingExecutionSource(session, { claudeConfigDir: profile }), null);
  const archive = path.join(profile, 'projects', 'archives'); await fs.mkdir(archive);
  await fs.writeFile(path.join(archive, `${sid}.jsonl`), 'never read archives');
  assert.equal(await locateProcessingExecutionSource(session, { claudeConfigDir: profile }), null);
  const file = path.join(project, `${sid}.jsonl`); await fs.writeFile(file, 'metadata only');
  const source = await locateProcessingExecutionSource(session, { claudeConfigDir: profile });
  assert.equal(source.path, file); assert.equal(source.eofByte, 13); assert.equal(source.projectRoot, root);
  await fs.mkdir(path.join(profile, 'projects', 'second'));
  await fs.writeFile(path.join(profile, 'projects', 'second', `${sid}.jsonl`), 'metadata only');
  await assert.rejects(locateProcessingExecutionSource(session, { claudeConfigDir: profile }), { code: 'PROCESSING_SOURCE_AMBIGUOUS' });
});

test('Codex lookup uses only the exact native descriptor path', async t => {
  const f = await fixture(t, 'codex');
  const source = await locateProcessingExecutionSource({ client: 'codex', sessionId: sid, cwd: f.root, sourcePath: f.source.path });
  assert.equal(source.fileIdentity, f.source.fileIdentity); assert.equal(source.path, f.source.path);
});

test('lookup supports large profiles while refusing project links and linked source files', async t => {
  const root = await temporary(t), profile = path.join(root, 'profile'), projects = path.join(profile, 'projects');
  await fs.mkdir(projects, { recursive: true });
  const args = [{ client: 'claude', sessionId: sid, cwd: root }, { claudeConfigDir: profile }];
  await Promise.all(Array.from({ length: 600 }, (_, index) => fs.mkdir(path.join(projects, `project-${index}`))));
  assert.equal(await locateProcessingExecutionSource(...args), null);
  await fs.rm(projects, { recursive: true }); await fs.mkdir(projects);
  const target = path.join(root, 'target'); await fs.mkdir(target);
  await fs.symlink(target, path.join(projects, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(locateProcessingExecutionSource(...args), { code: 'PROCESSING_SOURCE_UNAVAILABLE' });
  await fs.rm(path.join(projects, 'linked-project')); await fs.mkdir(path.join(projects, 'project'));
  const original = path.join(root, 'original.jsonl'); await fs.writeFile(original, 'synthetic');
  await fs.link(original, path.join(projects, 'project', `${sid}.jsonl`));
  await assert.rejects(locateProcessingExecutionSource(...args), { code: 'UNSAFE_WORKFLOW_PATH' });
});

test('unrelated project timestamp churn does not invalidate exact source discovery, but replacement does', async t => {
  const root = await temporary(t), profile = path.join(root, 'profile'), projects = path.join(profile, 'projects');
  const child = path.join(projects, 'project'); await fs.mkdir(child, { recursive: true });
  const file = path.join(child, `${sid}.jsonl`); await fs.writeFile(file, 'synthetic');
  const args = [{ client: 'claude', sessionId: sid, cwd: root }, { claudeConfigDir: profile }];
  const lstat = fs.lstat; let seen = 0, replace = false;
  t.mock.method(fs, 'lstat', async (name, ...options) => {
    const stat = await lstat(name, ...options);
    if (name !== child) return stat;
    seen++;
    return Object.assign(Object.create(stat), { mtimeNs: stat.mtimeNs + BigInt(seen), ctimeNs: stat.ctimeNs + BigInt(seen),
      ...(replace && seen > 1 ? { ino: stat.ino + 1n } : {}) });
  });
  assert.equal((await locateProcessingExecutionSource(...args)).path, file);
  seen = 0; replace = true;
  await assert.rejects(locateProcessingExecutionSource(...args), { code: 'PROCESSING_SOURCE_CHANGED' });
});
