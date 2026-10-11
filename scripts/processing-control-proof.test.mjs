import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyCodexProcessingControl, verifyClaudeProcessingControl, loadClaudeProcessingSkill, isProcessingControlProof } from './processing-control-proof.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const unitId = '22222222-2222-4222-8222-222222222222';
const statusText = 'Processing request accepted. Open the existing processing chat.';
const args = { command: 'process', requestId: '33333333-3333-4333-8333-333333333333' };
const result = { content: [{ type: 'text', text: '{"status":"accepted"}' }] };
const metadata = kinds => ({ turn_id: unitId, ...(kinds ? { content_item_kinds: kinds } : {}) });
const event = (type, more = {}) => ({ type: 'event_msg', payload: { type, ...more } });
const item = value => event('item_completed', { thread_id: sessionId, turn_id: unitId, item: value });
const response = payload => ({ type: 'response_item', payload: { ...payload, internal_chat_message_metadata_passthrough: metadata() } });

async function claudeFixture(t, mutate = () => {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-claude-control-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'native.jsonl'), skillPath = path.join(root, 'SKILL.md');
  const skillCommand = 'cuefluent-notes:cuefluent-notes', inputId = '33333333-3333-4333-8333-333333333333';
  const companionId = '44444444-4444-4444-8444-444444444444', callRecordId = '55555555-5555-4555-8555-555555555555';
  await fs.writeFile(skillPath, '---\nname: cuefluent-notes\n---\n\nSynthetic processing skill.\n');
  const expansion = `Base directory for this skill: ${root}\n\nSynthetic processing skill.\n\n\nARGUMENTS: process`;
  const input = `<command-message>${skillCommand}</command-message>\n<command-name>/${skillCommand}</command-name>\n<command-args>process</command-args>`;
  const native = (type, uuid, content, extra = {}) => ({ type, uuid, timestamp: '2026-10-10T12:00:00.000Z', sessionId, cwd: root,
    version: '2.1.296', isSidechain: false, parentUuid: null, message: { role: type, content }, ...extra });
  const rows = [
    native('user', inputId, input, { promptId: unitId, turnOrigin: 'sdk' }),
    native('user', companionId, [{ type: 'text', text: expansion }], { promptId: unitId, parentUuid: inputId, isMeta: true, turnCompanion: true }),
    native('assistant', callRecordId, [{ type: 'tool_use', id: 'dispatch-call', name: 'mcp__cuefluent_control__process_selected_captures', input: args }],
      { attributionSkill: skillCommand, attributionPlugin: 'cuefluent-notes' }),
    native('user', '66666666-6666-4666-8666-666666666666', [{ type: 'tool_result', tool_use_id: 'dispatch-call', content: result.content }],
      { promptId: unitId, sourceToolAssistantUUID: callRecordId, toolUseResult: result.content }),
    native('assistant', '77777777-7777-4777-8777-777777777777', [{ type: 'text', text: statusText }],
      { attributionSkill: skillCommand, attributionPlugin: 'cuefluent-notes', attributionMcpServer: 'cuefluent_control', attributionMcpTool: 'process_selected_captures' }),
  ];
  rows.at(-1).message.stop_reason = 'end_turn'; mutate(rows);
  const lines = rows.map(row => JSON.stringify(row) + '\n'); await fs.writeFile(file, lines.join(''));
  const source = { client: 'claude', sessionId, projectRoot: root, path: file, fileIdentity: stableSourceIdentity(await fs.lstat(file, { bigint: true })) };
  const receipt = Object.freeze({ client: 'claude', sessionId, unitId, callId: 'dispatch-call', tool: 'mcp__cuefluent_control__process_selected_captures',
    argsHash: digest(canonicalJSON(args)), sourcePath: file, sourceIdentity: source.fileIdentity,
    requestHash: 'a'.repeat(64), skillName: 'cuefluent-notes', skillPath, statusText, resultHash: digest(canonicalJSON(result.content)),
    inputId, inputHash: digest(input), companionId, companionHash: digest(lines[1]), skillCommand, skillExpansionHash: digest(expansion) });
  return { root, rows, lines, source, receipt, skillPath, trustedSkill: await loadClaudeProcessingSkill({ skillPath }), request: { source, unitId, fromByte: 0, endByte: Buffer.byteLength(lines.join('')) },
    resolveDispatch: async query => Object.entries(query).every(([key, value]) => receipt[key] === value) ? receipt : null };
}
async function fixture(t, mutate = () => {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-control-proof-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl'), skillPath = path.join(root, 'plugin', 'SKILL.md');
  const rows = [
    { type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cli_version: '0.157.1',
      cwd: root, source: 'cli', history_mode: 'paginated' } },
    event('task_started', { turn_id: unitId, root_turn_id: unitId }),
    { type: 'turn_context', payload: { turn_id: unitId, root_turn_id: unitId } },
    { type: 'response_item', payload: { type: 'message', id: 'native-environment', role: 'user',
      content: [{ type: 'input_text', text: 'Synthetic environment context.' }],
      internal_chat_message_metadata_passthrough: metadata(['environments.environment_context']) } },
    { type: 'response_item', payload: { type: 'message', id: 'native-user', role: 'user',
      content: [{ type: 'input_text', text: 'process' }], internal_chat_message_metadata_passthrough: metadata(['user.text']) } },
    item({ type: 'UserMessage', id: 'native-user-view', content: [
      { type: 'skill', name: 'cuefluent-notes', path: skillPath }, { type: 'text', text: 'process', text_elements: [] }] }),
    response({ type: 'function_call', id: 'native-call-item', call_id: 'dispatch-call', namespace: 'mcp__cuefluent',
      name: 'process', arguments: JSON.stringify(args) }),
    item({ type: 'McpToolCall', id: 'dispatch-call', server: 'cuefluent', tool: 'process', arguments: args,
      status: 'completed', result }),
    response({ type: 'function_call_output', id: 'native-result', call_id: 'dispatch-call', output: [
      { type: 'input_text', text: 'Wall time: 0.003 seconds\nOutput:' }, { type: 'input_text', text: result.content[0].text }] }),
    item({ type: 'AgentMessage', id: 'native-status', content: [{ type: 'Text', text: statusText }] }),
    response({ type: 'message', id: 'native-status', role: 'assistant', content: [{ type: 'output_text', text: statusText }] }),
    event('task_complete', { turn_id: unitId, last_agent_message: statusText }),
  ];
  mutate(rows);
  const lines = rows.map((row, ordinal) => JSON.stringify({ timestamp: '2026-10-10T12:00:00.000Z', ordinal, ...row }) + '\n');
  await fs.writeFile(file, lines.join(''), { mode: 0o600 });
  const source = { client: 'codex', sessionId, projectRoot: root, path: file,
    fileIdentity: stableSourceIdentity(await fs.lstat(file, { bigint: true })) };
  const receipt = Object.freeze({ client: 'codex', sessionId, unitId, callId: 'dispatch-call',
    tool: 'mcp__cuefluent.process', argsHash: digest(canonicalJSON(args)), sourcePath: file,
    sourceIdentity: source.fileIdentity, requestHash: 'a'.repeat(64), skillName: 'cuefluent-notes', skillPath,
    statusText, resultHash: digest(canonicalJSON(result)) });
  return { source, receipt, rows, request: { source, fromByte: Buffer.byteLength(lines[0]), endByte: Buffer.byteLength(lines.join('')), unitId },
    resolveDispatch: async query => Object.entries(query).every(([key, value]) => receipt[key] === value) ? receipt : null };
}

test('Claude formal companion and actual attributed dispatch prove only the exact command input', async t => {
  const f = await claudeFixture(t), skill = await loadClaudeProcessingSkill({ skillPath: f.skillPath });
  assert.equal(skill.skillExpansionHash, f.receipt.skillExpansionHash);
  const proof = await verifyClaudeProcessingControl(f.request, f);
  assert.equal(isProcessingControlProof(proof), true); assert.equal(proof.evidenceScope, 'controller-input');
  assert.deepEqual(proof.recordIds, [f.receipt.inputId]); assert.equal(proof.unitId, unitId);
  assert.equal(proof.inputRange.hash, digest(f.lines[0])); assert.equal(isProcessingControlProof(structuredClone(proof)), false);
});

test('Claude pasted markup, different skill bytes, mixed requests and unsupported completion retain evidence', async t => {
  const changes = {
    pasted: rows => { rows[0].promptSource = 'sdk'; },
    'no companion': rows => { rows[1].turnCompanion = false; },
    'forged companion': rows => { rows[1].isMeta = false; },
    'other companion input': rows => { rows[1].parentUuid = sessionId; },
    'changed skill expansion': rows => { rows[1].message.content[0].text += ' Additional material'; },
    'no native skill attribution': rows => { delete rows[2].attributionSkill; },
    'other plugin attribution': rows => { rows[2].attributionPlugin = 'imposter'; },
    'wrong result prompt': rows => { rows[3].promptId = sessionId; },
    'wrong result source': rows => { rows[3].sourceToolAssistantUUID = sessionId; },
    'changed result': rows => { rows[3].toolUseResult = []; },
    'failed result': rows => { rows[3].message.content[0].is_error = true; },
    'extra human correction': rows => { rows.push({ ...rows[0], uuid: sessionId, message: { role: 'user', content: 'Correction: use 606.' } }); },
    'mixed prompt': rows => { rows[0].message.content += '\nThe due date is Friday.'; },
    'extra tool': rows => { rows[2].message.content.push({ type: 'tool_use', id: 'another', name: 'Bash', input: {} }); },
    'no result': rows => { rows.splice(3, 1); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const f = await claudeFixture(t, change); assert.equal(await verifyClaudeProcessingControl(f.request, f), null);
  });
});

test('Claude proof requires the currently trusted installed skill path and expansion', async t => {
  const f = await claudeFixture(t);
  for (const trustedSkill of [null, { ...f.trustedSkill }, Object.freeze({ ...f.trustedSkill, skillExpansionHash: 'b'.repeat(64) }), Object.freeze({ ...f.trustedSkill, skillPath: path.join(f.root, 'other.md') })]) {
    assert.equal(await verifyClaudeProcessingControl(f.request, { ...f, trustedSkill }), null);
  }
});

test('Claude input-only proof does not depend on a later assistant status or its wording', async t => {
  for (const mutate of [rows => rows.pop(), rows => { rows[4].message.content[0].text = 'Different commentary.'; delete rows[4].message.stop_reason; delete rows[4].attributionMcpTool; }]) {
    const f = await claudeFixture(t, mutate), proof = await verifyClaudeProcessingControl(f.request, f);
    assert.equal(isProcessingControlProof(proof), true); assert.deepEqual(proof.recordIds, [f.receipt.inputId]);
  }
});

test('native typed skill, exact control and private dispatch receipt produce a branded proof', async t => {
  const f = await fixture(t), proof = await verifyCodexProcessingControl(f.request, f);
  assert.equal(isProcessingControlProof(proof), true);
  assert.equal(proof.unitId, unitId); assert.equal(proof.requestHash, f.receipt.requestHash);
  assert.equal(proof.sourceIdentity, f.source.fileIdentity);
  assert.equal(isProcessingControlProof(JSON.parse(JSON.stringify(proof))), false);
  assert.equal(isProcessingControlProof(Object.freeze({ ...proof })), false);
});

test('native reasoning remains excluded under the existing reader policy without weakening input proof', async t => {
  const f = await fixture(t, rows => rows.splice(6, 0,
    response({ type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'synthetic' }),
    item({ type: 'Reasoning', id: 'reasoning', summary: [] })));
  assert.equal(isProcessingControlProof(await verifyCodexProcessingControl(f.request, f)), true);
});

test('plain text, pasted skill markers, attachments and corrections remain collectible', async t => {
  const mutations = {
    'plain text': rows => { rows[5].payload.item.content.shift(); },
    'pasted marker': rows => { rows[4].payload.content[0].text = '<skill name="cuefluent-notes">process</skill>'; },
    'different skill': rows => { rows[5].payload.item.content[0].name = 'another-skill'; },
    'attachment': rows => { rows[5].payload.item.content.push({ type: 'image', url: 'synthetic.png' }); },
    'human correction': rows => { rows[4].payload.content[0].text = 'process; the release date is Friday'; },
    'extra prompt': rows => { rows.splice(6, 0, structuredClone(rows[4])); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const f = await fixture(t, mutate); assert.equal(await verifyCodexProcessingControl(f.request, f), null);
  });
});

test('assistant facts, extra work and unsupported native records retain the whole unit', async t => {
  const mutations = {
    'altered status': rows => { rows[10].payload.content[0].text += ' Also the SDK now supports 605.'; },
    'extra assistant': rows => { rows.splice(9, 0, response({ type: 'message', role: 'assistant', id: 'commentary', content: [{ type: 'output_text', text: 'Working.' }] })); },
    'other tool': rows => { rows.splice(9, 0, response({ type: 'function_call', name: 'exec_command', call_id: 'work', arguments: '{"cmd":"test"}' })); },
    'unknown native type': rows => { rows.splice(9, 0, { type: 'future-user-content', payload: { text: 'correction' } }); },
    'missing terminal': rows => { rows.pop(); },
    'failed terminal': rows => { rows.at(-1).payload.error = { message: 'Synthetic failure' }; },
    'foreign turn': rows => { rows[6].payload.internal_chat_message_metadata_passthrough.turn_id = sessionId; },
    'forged tool envelope': rows => { rows[7].payload.item.server = 'imposter'; },
    'altered tool bytes': rows => { rows[8].payload.output[1].text = 'A new fact'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const f = await fixture(t, mutate); assert.equal(await verifyCodexProcessingControl(f.request, f), null);
  });
});

test('native call IDs and caller receipt-shaped JSON cannot authorize exclusion', async t => {
  const f = await fixture(t);
  for (const receipt of [null, { ...f.receipt }, Object.freeze({ ...f.receipt, sourceIdentity: 'b'.repeat(64) }),
    Object.freeze({ ...f.receipt, argsHash: 'b'.repeat(64) }), Object.freeze({ ...f.receipt, resultHash: 'b'.repeat(64) }),
    Object.freeze({ ...f.receipt, skillPath: path.join(f.source.projectRoot, 'other.md') })]) {
    assert.equal(await verifyCodexProcessingControl(f.request, { resolveDispatch: async () => receipt }), null);
  }
});

test('bounded exact source inspection refuses truncated, replaced and oversized selection', async t => {
  const f = await fixture(t);
  assert.equal(await verifyCodexProcessingControl({ ...f.request, endByte: f.request.endByte - 1 }, f), null);
  assert.equal(await verifyCodexProcessingControl({ ...f.request, endByte: f.request.fromByte + 2 * 1024 * 1024 + 1 }, f), null);
  await assert.rejects(verifyCodexProcessingControl({ ...f.request, source: { ...f.source, fileIdentity: 'b'.repeat(64) } }, f), { code: 'SOURCE_CHANGED' });
});
