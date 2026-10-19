import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyCodexProcessingControl, verifyClaudeProcessingControl, loadClaudeProcessingSkill, isProcessingControlProof,
  processingControlText, processingControlAction, processingControlMatches, processingControlCall, reviewControl, reviewControlFields,
  processingControlSuggestions, isProcessingControlSuggestion, PROCESSING_CONTROL_FORMS, PROCESSING_HELP, REVIEW_CODE_PLACEHOLDER,
  claudeSkillArguments, findClaudeSkillArguments } from './processing-control-proof.mjs';
import { randomUUID } from 'node:crypto';
import { stableSourceIdentity } from './capture-selection.mjs';
import { codexControlTurn } from './test-support/codex-control-turn.mjs';
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

// Claude mirrors typed fields in its call; Codex sends only a scope.
async function claudeFixture(t, mutate = () => {}, control = 'process') {
  const call = processingControlCall(control), callArgs = { ...args, ...call.fields }, toolName = call.tool;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-claude-control-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'native.jsonl'), skillPath = path.join(root, 'SKILL.md');
  const skillCommand = 'cuefluent-notes:cuefluent-notes', inputId = '33333333-3333-4333-8333-333333333333';
  const companionId = '44444444-4444-4444-8444-444444444444', callRecordId = '55555555-5555-4555-8555-555555555555';
  await fs.writeFile(skillPath, '---\nname: cuefluent-notes\n---\n\nSynthetic processing skill.\n');
  const expansion = `Base directory for this skill: ${root}\n\nSynthetic processing skill.\n\n\nARGUMENTS: ${control}`;
  const input = `<command-message>${skillCommand}</command-message>\n<command-name>/${skillCommand}</command-name>\n<command-args>${control}</command-args>`;
  const native = (type, uuid, content, extra = {}) => ({ type, uuid, timestamp: '2026-10-10T12:00:00.000Z', sessionId, cwd: root,
    version: '2.1.296', isSidechain: false, parentUuid: null, message: { role: type, content }, ...extra });
  const rows = [
    native('user', inputId, input, { promptId: unitId, turnOrigin: 'sdk' }),
    native('user', companionId, [{ type: 'text', text: expansion }], { promptId: unitId, parentUuid: inputId, isMeta: true, turnCompanion: true }),
    native('assistant', callRecordId, [{ type: 'tool_use', id: 'dispatch-call', name: `mcp__cuefluent_control__${toolName}`, input: callArgs }],
      { attributionSkill: skillCommand, attributionPlugin: 'cuefluent-notes' }),
    native('user', '66666666-6666-4666-8666-666666666666', [{ type: 'tool_result', tool_use_id: 'dispatch-call', content: result.content }],
      { promptId: unitId, sourceToolAssistantUUID: callRecordId, toolUseResult: result.content }),
    native('assistant', '77777777-7777-4777-8777-777777777777', [{ type: 'text', text: statusText }],
      { attributionSkill: skillCommand, attributionPlugin: 'cuefluent-notes', attributionMcpServer: 'cuefluent_control', attributionMcpTool: toolName }),
  ];
  rows.at(-1).message.stop_reason = 'end_turn'; mutate(rows);
  const lines = rows.map(row => JSON.stringify(row) + '\n'); await fs.writeFile(file, lines.join(''));
  const source = { client: 'claude', sessionId, projectRoot: root, path: file, fileIdentity: stableSourceIdentity(await fs.lstat(file, { bigint: true })) };
  const receipt = Object.freeze({ client: 'claude', sessionId, unitId, callId: 'dispatch-call', tool: `mcp__cuefluent_control__${toolName}`,
    argsHash: digest(canonicalJSON(callArgs)), sourcePath: file, sourceIdentity: source.fileIdentity,
    requestHash: 'a'.repeat(64), skillName: 'cuefluent-notes', skillPath, statusText, resultHash: digest(canonicalJSON(result.content)),
    inputId, inputHash: digest(input), companionId, companionHash: digest(lines[1]), skillCommand, skillExpansionHash: digest(expansion) });
  return { root, rows, lines, source, receipt, skillPath, trustedSkill: await loadClaudeProcessingSkill({ skillPath, control }), request: { source, unitId, fromByte: 0, endByte: Buffer.byteLength(lines.join('')) },
    resolveDispatch: async query => Object.entries(query).every(([key, value]) => receipt[key] === value) ? receipt : null };
}
async function fixture(t, mutate = () => {}, control = 'process') {
  const call = processingControlCall(control), callArgs = { ...args, ...(call.fields.scope ? { scope: call.fields.scope } : {}) };
  const toolName = call.tool === 'process_selected_captures' ? 'process' : call.tool;
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
      content: [{ type: 'input_text', text: control }], internal_chat_message_metadata_passthrough: metadata(['user.text']) } },
    item({ type: 'UserMessage', id: 'native-user-view', content: [
      { type: 'skill', name: 'cuefluent-notes', path: skillPath }, { type: 'text', text: control, text_elements: [] }] }),
    response({ type: 'function_call', id: 'native-call-item', call_id: 'dispatch-call', namespace: 'mcp__cuefluent',
      name: toolName, arguments: JSON.stringify(callArgs) }),
    item({ type: 'McpToolCall', id: 'dispatch-call', server: 'cuefluent', tool: toolName, arguments: callArgs,
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
    tool: `mcp__cuefluent.${toolName}`, argsHash: digest(canonicalJSON(callArgs)), sourcePath: file,
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

for (const control of PROCESSING_CONTROL_FORMS.map(form => form.map(word => word === REVIEW_CODE_PLACEHOLDER ? 't7xb88' : word).join(' '))) {
  test(`exact ${control} has bounded proof in both clients; mixed corrections remain evidence`, async t => {
    const codex = await fixture(t, () => {}, control);
    const claude = await claudeFixture(t, () => {}, control);
    assert.equal(isProcessingControlProof(await verifyCodexProcessingControl(codex.request, codex)), true);
    assert.equal(isProcessingControlProof(await verifyClaudeProcessingControl(claude.request, claude)), true);
    const mixedCodex = await fixture(t, rows => { rows[4].payload.content[0].text += '; correction: 20 minutes'; }, control);
    const mixedClaude = await claudeFixture(t, rows => { rows[0].message.content += '\nCorrection: 20 minutes'; }, control);
    assert.equal(await verifyCodexProcessingControl(mixedCodex.request, mixedCodex), null);
    assert.equal(await verifyClaudeProcessingControl(mixedClaude.request, mixedClaude), null);
  });
}

test('typed grammar accepts only the exact forms and maps each to one tool call', () => {
  const tool = name => `mcp__cuefluent_control__${name}`;
  // Each form, its exact tool and fields, and the action the tool call names.
  const table = [
    ['help', 'processing_status', { help: true }], ['status', 'processing_status', {}], ['status --verbose', 'processing_status', { verbose: true }],
    ['process', 'process_selected_captures', {}], ['process repo', 'process_selected_captures', { scope: 'repo' }],
    ['process chat', 'process_selected_captures', { scope: 'chat' }], ['process resume', 'processing_resume', {}], ['process cancel', 'processing_cancel', {}],
    ['review', 'processing_review', {}], ['review t7xb88', 'processing_review', { draft: 't7xb88' }],
    ['review cancel', 'processing_review', { decision: 'cancel' }], ['review cancel t7xb88', 'processing_review', { decision: 'cancel', draft: 't7xb88' }],
    ['save', 'processing_review', { decision: 'save' }], ['save t7xb88', 'processing_review', { decision: 'save', draft: 't7xb88' }],
    ['skip', 'processing_review', { decision: 'skip' }], ['skip t7xb88', 'processing_review', { decision: 'skip', draft: 't7xb88' }],
  ];
  assert.equal(table.length, PROCESSING_CONTROL_FORMS.length);
  for (const [text, name, fields] of table) {
    assert.equal(processingControlText(text), text);
    assert.deepEqual({ ...processingControlCall(text) }, { tool: name, fields });
    assert.equal(processingControlAction(tool(name), { collectionId: 'example', ...fields }), text);
    assert.deepEqual(reviewControlFields(text), name === 'processing_review' ? fields : null);
    if (name === 'processing_review') assert.equal(reviewControl(fields), text);
  }
  // Near misses stay ordinary input: case, spacing, ambiguous letters, length,
  // order, other words, the known word setup and the dropped spellings.
  for (const text of ['Review', 'review ', ' review t7xb88', 'review T7XB88', 'review t7xb8', 'review t7xb888', 'review t7xb81',
    'review t7xbl8', 'review t7xbo8', 'review t7xb88 2', 'review approve t7xb88', 'save t7xb88 2', 'review t7xb88 save',
    'save  t7xb88', 'save t7xb88\n', 'save later', 'save save', 'status -v', 'status verbose', 'help me', 'Help',
    'setup', 'resume', 'cancel', 'later', 'later t7xb88', 'review save t7xb88', 'review skip t7xb88', 'review later t7xb88',
    'review save', 'review skip', 'review later', 'process status', '']) assert.equal(processingControlText(text), null, text);
  for (const text of ['status', 'process repo', 'process cancel', 'help', 'setup']) assert.equal(reviewControlFields(text), null, text);
  assert.equal(reviewControl({ draft: 't7xb88', decision: 'approve' }), null); assert.equal(reviewControl({ draft: 'T7XB88' }), null);
  assert.equal(reviewControl({ decision: 'later' }), null);
  assert.equal(processingControlAction(tool('processing_review'), { decision: 'approve', draft: 't7xb88' }), null);
  for (const fields of [{ verbose: false }, { help: false }, { help: true, verbose: true }, { verbose: 'yes' }]) {
    assert.equal(processingControlAction(tool('processing_status'), fields), null, JSON.stringify(fields));
  }
});

test('Claude mirrors typed fields exactly; Codex binds typed text to a field-free review or status call', () => {
  const review = 'mcp__cuefluent_control__processing_review', status = 'mcp__cuefluent_control__processing_status';
  for (const client of ['claude', 'codex']) {
    assert.equal(processingControlMatches('save t7xb88', review, { decision: 'save', draft: 't7xb88' }, client), true);
    assert.equal(processingControlMatches('review cancel t7xb88', review, { decision: 'cancel', draft: 't7xb88' }, client), true);
    assert.equal(processingControlMatches('status --verbose', status, { verbose: true }, client), true);
    assert.equal(processingControlMatches('help', status, { help: true }, client), true);
    // A model cannot change the decision or draft, or turn a display into a decision.
    assert.equal(processingControlMatches('skip t7xb88', review, { decision: 'save', draft: 't7xb88' }, client), false);
    assert.equal(processingControlMatches('save t7xb88', review, { decision: 'save', draft: 'k2mn9p' }, client), false);
    assert.equal(processingControlMatches('review t7xb88', review, { decision: 'save', draft: 't7xb88' }, client), false);
    assert.equal(processingControlMatches('status', status, { verbose: true }, client), false);
    assert.equal(processingControlMatches('status', status, { help: true }, client), false);
    assert.equal(processingControlMatches('save t7xb88', status, {}, client), false);
    assert.equal(processingControlMatches('help', review, {}, client), false);
    assert.equal(processingControlMatches('save T7XB88', review, {}, client), false);
    assert.equal(processingControlMatches('review save t7xb88', review, { decision: 'save', draft: 't7xb88' }, client), false);
  }
  for (const typed of ['save t7xb88', 'skip', 'review cancel', 'review t7xb88']) {
    assert.equal(processingControlMatches(typed, review, {}, 'claude'), false);
    assert.equal(processingControlMatches(typed, review, {}, 'codex'), true);
  }
  for (const typed of ['status --verbose', 'help']) {
    assert.equal(processingControlMatches(typed, status, {}, 'claude'), false);
    assert.equal(processingControlMatches(typed, status, {}, 'codex'), true);
  }
  assert.equal(processingControlMatches('review', review, {}, 'codex'), true);
  assert.equal(processingControlMatches('process resume', status, {}, 'codex'), false);
});

test('the help list is derived from the grammar: every form appears once under its first word', () => {
  assert.deepEqual(PROCESSING_HELP.map(item => item.word), ['setup', 'status', 'process', 'review', 'save', 'skip', 'help']);
  const listed = PROCESSING_HELP.flatMap(item => [item.word, ...item.also]);
  const forms = [...PROCESSING_CONTROL_FORMS.map(form => form.join(' ')), 'setup'];
  assert.deepEqual([...listed].sort(), [...forms].sort());
  assert.deepEqual(PROCESSING_HELP.find(item => item.word === 'process').also, ['process repo', 'process chat', 'process resume', 'process cancel']);
  for (const item of PROCESSING_HELP) assert.match(item.summary, /^[a-z][^\n]{3,80}$/);
});

test('nearest-command suggestions cover every grammar form and its near misses', () => {
  const code = 't7xb88', exactText = form => form.map(word => word === REVIEW_CODE_PLACEHOLDER ? code : word).join(' ');
  const misspell = word => word.length > 4 ? word.slice(0, -2) + word.slice(-1) : word.slice(0, 1) + word.slice(2, 3) + word.slice(1, 2) + word.slice(3);
  let checked = 0;
  for (const form of PROCESSING_CONTROL_FORMS) {
    const exact = exactText(form), last = form.filter(word => word !== REVIEW_CODE_PLACEHOLDER).at(-1);
    assert.equal(processingControlText(exact), exact); assert.equal(isProcessingControlSuggestion(exact), true);
    const variants = {
      case: exact.toUpperCase(), spacing: ` ${form.map(word => word === REVIEW_CODE_PLACEHOLDER ? code : word).join('  ')} `,
      'trailing newline': `${exact}\n`, punctuation: `${exact}.`, 'extra words': `${exact} and keep the rest pending`,
      'second line': `${exact}\nAlso: the launch moved to Friday.`,
      misspelling: form.map(word => word === REVIEW_CODE_PLACEHOLDER ? code : word === last ? misspell(word) : word).join(' '),
      ...(['process', 'review'].includes(form[0]) && form.length > 1 ? { 'missing first word': exact.slice(form[0].length + 1) } : {}),
      ...(form.includes(REVIEW_CODE_PLACEHOLDER) ? { 'confusable code': form.map(word => word === REVIEW_CODE_PLACEHOLDER ? 't7xbo8' : word).join(' '),
        'short code': form.map(word => word === REVIEW_CODE_PLACEHOLDER ? 't7xb8' : word).join(' ') } : {}),
    };
    for (const [name, typed] of Object.entries(variants)) {
      // `cancel` alone could be either cancel; it is checked below.
      if (processingControlText(typed) !== null || typed === 'cancel') continue;
      // An unusable code is never repaired or guessed: the reply shows its place.
      const expected = name.endsWith('code') ? form.join(' ') : exact;
      assert.deepEqual(processingControlSuggestions(typed), [expected], `${exact} / ${name}: ${JSON.stringify(typed)}`);
      assert.equal(isProcessingControlSuggestion(expected), true); checked++;
    }
  }
  assert(checked > PROCESSING_CONTROL_FORMS.length * 7, `${checked} variants`);
  // Free text with no nearby command names help first; output is
  // deterministic, bounded and derived from the grammar.
  for (const typed of ['Remember that the launch moved to Friday.', 'what is that', '', '   ', '🦉'.repeat(50000)]) {
    assert.deepEqual(processingControlSuggestions(typed), ['help', 'review', 'status']);
  }
  assert.deepEqual(processingControlSuggestions('please process my notes from today'), ['process']);
  // A filler word inside a command keeps the narrower scope the person typed.
  assert.deepEqual(processingControlSuggestions('process my repo'), ['process repo']);
  assert.deepEqual(processingControlSuggestions('process this chat'), ['process chat']);
  assert.deepEqual(processingControlSuggestions('review the t7xb88 draft'), ['review t7xb88']);
  // Old spellings name the new forms.
  assert.deepEqual(processingControlSuggestions('resume'), ['process resume']);
  assert.deepEqual(processingControlSuggestions('resume my work'), ['process resume']);
  assert.deepEqual(processingControlSuggestions('cancel'), ['process cancel', 'review cancel']);
  assert.deepEqual(processingControlSuggestions('cancel t7xb88'), ['review cancel t7xb88']);
  assert.deepEqual(processingControlSuggestions('review save t7xb88'), ['save t7xb88']);
  assert.deepEqual(processingControlSuggestions('review skip t7xb88'), ['skip t7xb88']);
  assert.deepEqual(processingControlSuggestions('review later t7xb88'), ['review t7xb88']);
  assert.deepEqual(processingControlSuggestions('later'), ['help', 'review', 'status']);
  assert.deepEqual(processingControlSuggestions('review save t7xb88 or review skip k2mn9p'), ['save t7xb88', 'skip k2mn9p']);
  assert.deepEqual(processingControlSuggestions('ｒｅｖｉｅｗ ｃａｎｃｅｌ t7xb88'), ['review cancel t7xb88']);
  // Verbosity, help and the known word setup.
  assert.deepEqual(processingControlSuggestions('status verbose'), ['status --verbose']);
  assert.deepEqual(processingControlSuggestions('status -verbose'), ['status --verbose']);
  assert.deepEqual(processingControlSuggestions('hlep'), ['help']);
  assert.deepEqual(processingControlSuggestions('setp'), ['setup']);
  // `save` is also an everyday verb: a short near miss names the decision; a
  // plain-language request is never a decision (the skill routes it).
  assert.deepEqual(processingControlSuggestions('save t7xb8'), ['save <draft code>']);
  assert.deepEqual(processingControlSuggestions('Save t7xb88'), ['save t7xb88']);
  assert.deepEqual(processingControlSuggestions(`${'filler '.repeat(4000)}save t7xb88`), ['help', 'review', 'status']);
  const long = 'sav t7xb88 ' + 'x'.repeat(2 * 1024 * 1024);
  assert.deepEqual(processingControlSuggestions(long), ['save t7xb88']);
  assert(Object.isFrozen(processingControlSuggestions('stat')));
  for (const text of ['sav t7xb88', 'save T7XB88', 'review save t7xb88', 'resume', 'save <draft  code>', '<draft code>', 'Saved.']) {
    assert.equal(isProcessingControlSuggestion(text), false, text);
  }
  assert.equal(isProcessingControlSuggestion('setup'), true);
});

test('only the trusted skill command envelope yields typed arguments, including none', () => {
  const command = 'cuefluent-notes:cuefluent-notes', envelope = (args, name = command) =>
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`;
  const bare = (name = command) => `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`;
  for (const args of ['review sav t7xb88', '', ' review ', 'line one\nline two', 'a </command-args> b', '$& $1 $$']) {
    assert.equal(claudeSkillArguments(envelope(args)), args);
  }
  // Claude records nothing typed after the command without an arguments element.
  assert.equal(claudeSkillArguments(bare()), '');
  for (const text of [envelope('review', 'other-plugin:cuefluent-notes'), envelope('review', 'cuefluent-notes:other'),
    bare('cuefluent-notes:other'), `${bare()}\n`, `${bare()}\n<command-args>`, bare().replace('\n', '\r\n'), ` ${bare()}`,
    envelope('review').replace('\n', '\r\n'), `${envelope('review')}\n`, ` ${envelope('review')}`,
    `<command-name>/${command}</command-name>\n<command-message>${command}</command-message>\n<command-args>review</command-args>`,
    envelope('review').replace('</command-args>', ''), 'review', null]) {
    assert.equal(claudeSkillArguments(text), null, JSON.stringify(text));
  }
});

test('verified Claude typed arguments that are not an exact control are found for a reply, never as a control', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-claude-arguments-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillPath = path.join(root, 'SKILL.md'), command = 'cuefluent-notes:cuefluent-notes', source = { client: 'claude', sessionId };
  await fs.writeFile(skillPath, '---\nname: cuefluent-notes\n---\n\nSynthetic processing skill.\n');
  // Claude records nothing typed as the two-line envelope, and its expansion
  // then has no ARGUMENTS line.
  const build = (typed, { content, expansionArgs = typed, mutate = () => {} } = {}) => {
    const native = (type, uuid, body, extra = {}) => ({ type, uuid, timestamp: '2026-10-10T12:00:00.000Z', sessionId, cwd: root,
      version: '2.1.302', isSidechain: false, parentUuid: null, message: { role: type, content: body }, ...extra });
    const head = `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>`;
    const input = typed === '' ? head : `${head}\n<command-args>${typed}</command-args>`;
    const expansion = `Base directory for this skill: ${root}\n\nSynthetic processing skill.\n${expansionArgs === '' ? '' : `\n\nARGUMENTS: ${expansionArgs}`}`;
    const rows = [native('user', '33333333-3333-4333-8333-333333333333', content?.(input) ?? input, { promptId: unitId }),
      native('user', '44444444-4444-4444-8444-444444444444', [{ type: 'text', text: expansion }],
        { promptId: unitId, parentUuid: '33333333-3333-4333-8333-333333333333', isMeta: true, turnCompanion: true }),
      native('assistant', '55555555-5555-4555-8555-555555555555', [{ type: 'tool_use', id: 'call', name: 'mcp__cuefluent_control__processing_review', input: { decision: 'save', draft: 't7xb88' } }],
        { attributionSkill: command, attributionPlugin: 'cuefluent-notes' })];
    mutate(rows);
    return rows.map(value => ({ value, hash: digest(JSON.stringify(value) + '\n') }));
  };
  const find = records => findClaudeSkillArguments(records, { source, callId: 'call', tool: 'mcp__cuefluent_control__processing_review',
    argsHash: digest(canonicalJSON({ decision: 'save', draft: 't7xb88' })), skillPath, skillCommand: command });
  for (const typed of ['review sav t7xb88', 'save t7xb88 and tag it urgent', 'review save t7xb88', 'save this meeting note: the launch moved',
    'Review', 'Remember the launch moved.', '']) {
    const found = await find(build(typed));
    assert.deepEqual({ ...found }, { unitId, inputId: '33333333-3333-4333-8333-333333333333', arguments: typed, mixed: false });
  }
  // A control, or nothing typed, with other content is mixed, so not a control either.
  const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } };
  assert.equal((await find(build('save t7xb88', { content: input => [{ type: 'text', text: input }, image] }))).mixed, true);
  assert.equal((await find(build('', { content: input => [{ type: 'text', text: input }, image] }))).mixed, true);
  // Exact controls belong to the control proof; unverified input finds nothing,
  // including a bare invocation whose expansion carries an ARGUMENTS line.
  for (const records of [build('save t7xb88'), build('review sav t7xb88', { expansionArgs: 'review save t7xb88' }),
    build('', { expansionArgs: 'help' }),
    build('review sav t7xb88', { mutate: rows => { rows[0].promptSource = 'sdk'; } }),
    build('review sav t7xb88', { mutate: rows => { delete rows[2].attributionSkill; } }),
    build('review sav t7xb88', { mutate: rows => { rows[1].turnCompanion = false; } })]) assert.equal(await find(records), null);
});

// Codex CLI 0.163 control turns: the `$` list's mention plus its selection
// item, or the older skill part; the call in code mode (the verification
// handshake's two cells, optionally finished by `wait`) or direct.
async function turnFixture(t, options = {}, mutate = () => {}, receiptChange = receipt => receipt) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-codex-turn-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl'), skillPath = path.join(root, 'plugin', 'SKILL.md');
  const turn = codexControlTurn({ sessionId, unitId, skillPath, ...options });
  mutate(turn.rows, turn);
  const rows = [{ type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cli_version: '0.163.0', cwd: root, source: 'cli', history_mode: 'paginated' } },
    ...turn.rows];
  const lines = rows.map((row, ordinal) => JSON.stringify({ timestamp: '2026-10-17T12:00:00.000Z', ordinal, ...row }) + '\n');
  await fs.writeFile(file, lines.join(''), { mode: 0o600 });
  const source = { client: 'codex', sessionId, projectRoot: root, path: file, fileIdentity: stableSourceIdentity(await fs.lstat(file, { bigint: true })) };
  const receipt = Object.freeze(receiptChange({ client: 'codex', sessionId, unitId, sourcePath: file, sourceIdentity: source.fileIdentity,
    requestHash: 'a'.repeat(64), skillName: 'cuefluent-notes', ...turn.receipt }));
  return { source, receipt, turn, request: { source, fromByte: Buffer.byteLength(lines[0]), endByte: Buffer.byteLength(lines.join('')), unitId },
    resolveDispatch: async query => Object.entries(query).every(([key, value]) => receipt[key] === value) ? receipt : null };
}
const proven = async f => isProcessingControlProof(await verifyCodexProcessingControl(f.request, f));
const at = (rows, test) => rows.findIndex(test);
const isItem = type => row => row.payload?.item?.type === type;
const isPayload = (type, name) => row => row.type === 'response_item' && row.payload.type === type && (name === undefined || row.payload.name === name);

test('Codex 0.163 control turns prove in both message forms, in code mode with or without wait, and direct', async t => {
  for (const [name, options] of [
    ['menu, code mode', {}], ['menu, code mode finished by wait', { waits: 1 }], ['menu, code mode finished by three waits', { waits: 3 }],
    ['older skill part, code mode', { form: 'block' }], ['menu, direct call', { mode: 'direct' }],
    ['menu, first turn of a session', { firstTurn: true }],
    ['a reply of several Markdown blocks, relayed exactly', { statusText: 'Cuefluent: Draft t7xb88 is ready.\n\nReview folder: <file:///private/review/t7xb88/>' }],
  ]) await t.test(name, async t => {
    const f = await turnFixture(t, options), proof = await verifyCodexProcessingControl(f.request, f);
    assert.equal(isProcessingControlProof(proof), true);
    assert.equal(proof.callId, f.receipt.callId); assert.equal(proof.unitId, unitId);
  });
  for (const control of PROCESSING_CONTROL_FORMS.map(form => form.map(word => word === REVIEW_CODE_PLACEHOLDER ? 't7xb88' : word).join(' '))) {
    await t.test(control, async t => assert.equal(await proven(await turnFixture(t, { control })), true));
  }
});

test('Codex 0.163 control turns with anything outside the exact shape stay collectible', async t => {
  const command = { id: 'exec-command', type: 'CommandExecution', status: 'completed', exit_code: 0 };
  const changes = {
    'mention typed by hand': [{ form: 'typed' }],
    'selection of another install': [{}, rows => { rows[at(rows, row => row.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds?.[0] === 'skills.selected_skill_instructions')]
      .payload.content[0].text = '<skill>\n<name>cuefluent-notes:cuefluent-notes</name>\n<path>/other/SKILL.md</path>\n</skill>'; }],
    'second selection': [{}, rows => { const i = at(rows, row => row.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds?.[0] === 'skills.selected_skill_instructions');
      rows.splice(i, 0, structuredClone(rows[i])); }],
    'words around the mention': [{}, rows => { rows[at(rows, isItem('UserMessage'))].payload.item.content[0].text += ' and tag it urgent'; }],
    'mirror differs': [{}, rows => { rows[at(rows, row => row.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds?.[0] === 'user.text')].payload.content[0].text = 'review'; }],
    'a correction': [{}, rows => { rows.splice(-2, 0, { type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: unitId,
      item: { type: 'UserMessage', id: 'correction', content: [{ type: 'text', text: 'Correction: 20 minutes.' }] } } }); }],
    'the model reads SKILL.md': [{}, rows => { rows.splice(at(rows, isPayload('custom_tool_call')) + 1, 0, { type: 'event_msg', payload: { type: 'item_completed',
      thread_id: sessionId, turn_id: unitId, item: command } }); }],
    'a third cell': [{}, rows => { const i = at(rows, isPayload('custom_tool_call')); rows.splice(i, 0, { ...structuredClone(rows[i]),
      payload: { ...structuredClone(rows[i].payload), id: 'ctc_extra', call_id: 'call_extra' } }); }],
    'another tool in the turn': [{}, rows => { rows.splice(-3, 0, { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'work',
      arguments: '{"cmd":"git status"}', internal_chat_message_metadata_passthrough: { turn_id: unitId } } }); }],
    'notify output': [{}, rows => { const i = at(rows, isPayload('custom_tool_call_output')); rows.splice(i, 0, { ...structuredClone(rows[i]),
      payload: { ...structuredClone(rows[i].payload), output: 'A fact the cell printed.' } }); }],
    'cell printed more': [{}, rows => { rows[at(rows, isPayload('custom_tool_call_output'))].payload.output[1].text += '\nAlso: the SDK supports 605.'; }],
    'failed script': [{}, rows => { rows[at(rows, isPayload('custom_tool_call_output'))].payload.output[0].text = 'Script failed\nWall time 0.1 seconds\nOutput:\n'; }],
    'client-authored output': [{}, rows => { rows[at(rows, isPayload('custom_tool_call_output'))].metadata.client_authored = true; }],
    'retry without the token': [{}, rows => { const i = rows.findLastIndex(isItem('McpToolCall')); delete rows[i].payload.item.arguments.retryToken; }],
    'retry with another token': [{}, rows => { rows[rows.findLastIndex(isItem('McpToolCall'))].payload.item.arguments.retryToken = randomUUID(); }],
    'handshake not ours': [{}, rows => { rows[at(rows, isItem('McpToolCall'))].payload.item.result.content[0].text = '{"status":"accepted"}'; }],
    'nested call to another server': [{}, rows => { rows[rows.findLastIndex(isItem('McpToolCall'))].payload.item.server = 'imposter'; }],
    'unknown MCP item field': [{}, rows => { rows[rows.findLastIndex(isItem('McpToolCall'))].payload.item.progress = 'Working on it.'; }],
    'retry before the handshake output': [{}, rows => { const i = at(rows, isPayload('custom_tool_call_output')), j = rows.findLastIndex(isPayload('custom_tool_call'));
      const [cell] = rows.splice(j, 1); rows.splice(i, 0, cell); }],
    'wait on another cell': [{ waits: 1 }, rows => { const i = at(rows, isPayload('function_call', 'wait')); rows[i].payload.arguments = '{"cell_id":"5"}'; }],
    'wait with extra fields': [{ waits: 1 }, rows => { rows[at(rows, isPayload('function_call', 'wait'))].payload.arguments = '{"cell_id":"4","terminate":true}'; }],
    // Commentary is the assistant's own text, however short: it stays collectible.
    'a short commentary message': [{ commentary: ['I will run the Cuefluent Notes control.'] }],
    'commentary with a conclusion': [{ commentary: ['Diagnosis: the Cedar cache bug is the 25-minute TTL.'] }],
    'commentary in direct mode': [{ mode: 'direct', commentary: ['Diagnosis: the Cedar cache bug is the 25-minute TTL.'] }],
    'annotated reply': [{}, rows => { rows[rows.findLastIndex(row => row.payload?.role === 'assistant')].payload.content[0].annotations = [{ url: 'https://example.invalid' }]; }],
    'reply is not the status': [{}, rows => { for (const row of rows) if (row.payload?.item?.phase === 'final_answer') row.payload.item.content[0].text += ' Also 605.';
      rows[rows.findLastIndex(row => row.payload?.role === 'assistant')].payload.content[0].text += ' Also 605.'; }],
    // The proof stays byte-exact: a reply the model reformatted is not the
    // status text, so the turn is read under the reader rules instead, which
    // leave that relay out (codex-reader.mjs, codexReplyForm).
    'reformatted reply': [{ statusText: 'Cuefluent: Draft t7xb88 is ready.\n\nReview folder: <file:///private/review/t7xb88/>',
      reply: 'Cuefluent: Draft t7xb88 is ready.\n\nReview folder: [t7xb88](/private/review/t7xb88/)' }],
    'reply with a blank line added': [{ statusText: 'Cuefluent: Pending drafts:\n- t7xb88 "notes/a.md"', reply: 'Cuefluent: Pending drafts:\n\n- t7xb88 "notes/a.md"' }],
    'final reply before the result': [{}, rows => { const final = rows.splice(rows.findLastIndex(isItem('AgentMessage')), 2);
      rows.splice(at(rows, isPayload('custom_tool_call')), 0, ...final); }],
    'unknown record': [{}, rows => { rows.splice(-2, 0, { type: 'future-user-content', payload: { text: 'correction' } }); }],
    'an output of no call': [{}, rows => { rows.splice(-3, 0, { type: 'response_item', metadata: { client_authored: false }, payload: { type: 'custom_tool_call_output',
      call_id: 'call_other', output: 'Script completed\nWall time 0.1 seconds\nOutput:\n', internal_chat_message_metadata_passthrough: { turn_id: unitId } } }); }],
  };
  for (const [name, [options, mutate]] of Object.entries(changes)) await t.test(name, async t => {
    assert.equal(await proven(await turnFixture(t, options, mutate)), false);
  });
});

test('a Codex code-mode proof needs the receipt to name both cells and the retry call', async t => {
  for (const [name, change] of [
    ['no code-mode fields', ({ outerItemId, retryItemId, retryCallId, handshakeResultHash, ...rest }) => rest],
    ['other first cell', receipt => ({ ...receipt, outerItemId: 'ctc_other' })],
    ['other retry cell', receipt => ({ ...receipt, retryItemId: 'ctc_other' })],
    ['other retry call', receipt => ({ ...receipt, retryCallId: `exec-${randomUUID()}` })],
    ['other handshake result', receipt => ({ ...receipt, handshakeResultHash: 'b'.repeat(64) })],
    ['other result', receipt => ({ ...receipt, resultHash: 'b'.repeat(64) })],
    ['other skill path', receipt => ({ ...receipt, skillPath: '/other/SKILL.md' })],
  ]) await t.test(name, async t => assert.equal(await proven(await turnFixture(t, {}, () => {}, change)), false));
  // A direct call's receipt names no cells.
  const direct = await turnFixture(t, { mode: 'direct' }, () => {}, receipt => ({ ...receipt, outerItemId: 'ctc_first', retryItemId: 'ctc_second',
    retryCallId: `exec-${randomUUID()}`, handshakeResultHash: 'b'.repeat(64) }));
  assert.equal(await proven(direct), false);
});
