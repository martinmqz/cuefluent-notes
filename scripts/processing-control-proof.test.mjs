import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyCodexProcessingControl, verifyClaudeProcessingControl, loadClaudeProcessingSkill, isProcessingControlProof,
  processingControlText, processingControlAction, processingControlMatches, reviewControl, reviewControlFields,
  processingControlSuggestions, isProcessingControlSuggestion, PROCESSING_CONTROL_FORMS, REVIEW_CODE_PLACEHOLDER,
  claudeSkillArguments, findClaudeSkillArguments } from './processing-control-proof.mjs';
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

// Claude mirrors typed review fields in its call; Codex sends none.
const reviewFields = control => control.startsWith('review') ? reviewControlFields(control) : null;
async function claudeFixture(t, mutate = () => {}, control = 'process') {
  const callArgs = { ...args, ...(control.startsWith('process ') ? { scope: control.split(' ')[1] } : {}), ...reviewFields(control) };
  const toolName = control.startsWith('process') ? 'process_selected_captures' : reviewFields(control) ? 'processing_review' : `processing_${control}`;
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
  const callArgs = { ...args, ...(control.startsWith('process ') ? { scope: control.split(' ')[1] } : {}) };
  const toolName = control.startsWith('process') ? 'process' : reviewFields(control) ? 'processing_review' : `processing_${control}`;
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

for (const control of ['process', 'process repo', 'process chat', 'resume', 'status', 'review', 'cancel',
  'review t7xb88', 'review save t7xb88', 'review skip t7xb88', 'review cancel t7xb88', 'review later t7xb88', 'review save', 'review later']) {
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

test('typed review grammar accepts only exact canonical review actions', () => {
  for (const text of ['review', 'review t7xb88', 'review save t7xb88', 'review skip t7xb88', 'review cancel t7xb88',
    'review later t7xb88', 'review save', 'review skip', 'review cancel', 'review later', 'process', 'cancel']) assert.equal(processingControlText(text), text);
  // Near misses stay ordinary input: case, spacing, ambiguous letters, length,
  // order, other words and pages (removed with the paged prototype).
  for (const text of ['Review', 'review ', ' review t7xb88', 'review T7XB88', 'review t7xb8', 'review t7xb888', 'review t7xb81',
    'review t7xbl8', 'review t7xbo8', 'review t7xb88 2', 'review approve t7xb88', 'review save t7xb88 2', 'review t7xb88 save',
    'review  save t7xb88', 'review save t7xb88\n', 'save t7xb88', 'save', 'review save later', 'review save save']) assert.equal(processingControlText(text), null, text);
  assert.deepEqual(reviewControlFields('review'), {}); assert.deepEqual(reviewControlFields('review t7xb88'), { draft: 't7xb88' });
  assert.deepEqual(reviewControlFields('review later'), { decision: 'later' });
  assert.deepEqual(reviewControlFields('review skip t7xb88'), { decision: 'skip', draft: 't7xb88' });
  assert.equal(reviewControlFields('status'), null); assert.equal(reviewControlFields('review T7XB88'), null);
  assert.equal(reviewControl({ draft: 't7xb88', decision: 'approve' }), null); assert.equal(reviewControl({ draft: 'T7XB88' }), null);
  assert.equal(processingControlAction('mcp__cuefluent_control__processing_review', { collectionId: 'example' }), 'review');
  assert.equal(processingControlAction('mcp__cuefluent_control__processing_review', { decision: 'skip', draft: 't7xb88' }), 'review skip t7xb88');
  assert.equal(processingControlAction('mcp__cuefluent_control__processing_review', { decision: 'approve', draft: 't7xb88' }), null);
});

test('Claude mirrors typed review fields exactly; Codex binds typed review text to a field-free review call', () => {
  const review = 'mcp__cuefluent_control__processing_review', status = 'mcp__cuefluent_control__processing_status';
  for (const client of ['claude', 'codex']) {
    assert.equal(processingControlMatches('review save t7xb88', review, { decision: 'save', draft: 't7xb88' }, client), true);
    // A model cannot change the decision or draft, or turn a display into a decision.
    assert.equal(processingControlMatches('review later t7xb88', review, { decision: 'save', draft: 't7xb88' }, client), false);
    assert.equal(processingControlMatches('review save t7xb88', review, { decision: 'save', draft: 'k2mn9p' }, client), false);
    assert.equal(processingControlMatches('review t7xb88', review, { decision: 'save', draft: 't7xb88' }, client), false);
    assert.equal(processingControlMatches('review save t7xb88', status, {}, client), false);
    assert.equal(processingControlMatches('review save T7XB88', review, {}, client), false);
  }
  assert.equal(processingControlMatches('review save t7xb88', review, {}, 'claude'), false);
  assert.equal(processingControlMatches('review save t7xb88', review, {}, 'codex'), true);
  assert.equal(processingControlMatches('review', review, {}, 'codex'), true);
});

test('nearest-command suggestions cover every grammar form and its near misses', () => {
  const code = 't7xb88', exactText = form => form.map(word => word === REVIEW_CODE_PLACEHOLDER ? code : word).join(' ');
  const misspell = word => word.slice(0, -2) + word.slice(-1);
  let checked = 0;
  for (const form of PROCESSING_CONTROL_FORMS) {
    const exact = exactText(form), last = form.filter(word => word !== REVIEW_CODE_PLACEHOLDER).at(-1);
    assert.equal(processingControlText(exact), exact); assert.equal(isProcessingControlSuggestion(exact), true);
    const variants = {
      case: exact.toUpperCase(), spacing: ` ${form.map(word => word === REVIEW_CODE_PLACEHOLDER ? code : word).join('  ')} `,
      'trailing newline': `${exact}\n`, punctuation: `${exact}.`, 'extra words': `${exact} and keep the rest pending`,
      'second line': `${exact}\nAlso: the launch moved to Friday.`,
      misspelling: form.map(word => word === REVIEW_CODE_PLACEHOLDER ? code : word === last ? misspell(word) : word).join(' '),
      ...(form[0] === 'review' && form.length > 1 ? { 'missing review': exact.slice('review '.length) } : {}),
      ...(form.includes(REVIEW_CODE_PLACEHOLDER) ? { 'confusable code': form.map(word => word === REVIEW_CODE_PLACEHOLDER ? 't7xbo8' : word).join(' '),
        'short code': form.map(word => word === REVIEW_CODE_PLACEHOLDER ? 't7xb8' : word).join(' ') } : {}),
    };
    for (const [name, typed] of Object.entries(variants)) {
      if (processingControlText(typed) !== null) continue; // `cancel` without `review` is itself an exact command.
      // An unusable code is never repaired or guessed: the reply shows its place.
      const expected = name.endsWith('code') ? form.join(' ') : exact;
      assert.deepEqual(processingControlSuggestions(typed), [expected], `${exact} / ${name}: ${JSON.stringify(typed)}`);
      assert.equal(isProcessingControlSuggestion(expected), true); checked++;
    }
  }
  assert(checked > PROCESSING_CONTROL_FORMS.length * 7, `${checked} variants`);
  // Free text with no nearby command names the general commands; output is
  // deterministic, bounded and derived from the grammar.
  for (const typed of ['Remember that the launch moved to Friday.', 'what is that', '', '🦉'.repeat(50000)]) {
    assert.deepEqual(processingControlSuggestions(typed), ['review', 'status', 'process']);
  }
  assert.deepEqual(processingControlSuggestions('please process my notes from today'), ['process']);
  // A filler word inside a command keeps the narrower scope the person typed.
  assert.deepEqual(processingControlSuggestions('process my repo'), ['process repo']);
  assert.deepEqual(processingControlSuggestions('process this chat'), ['process chat']);
  assert.deepEqual(processingControlSuggestions('review the t7xb88 draft'), ['review t7xb88']);
  assert.deepEqual(processingControlSuggestions('resume my work'), ['resume']);
  assert.deepEqual(processingControlSuggestions('review save t7xb88 or review skip k2mn9p'), ['review save t7xb88', 'review skip k2mn9p']);
  assert.deepEqual(processingControlSuggestions('ｒｅｖｉｅｗ ｓａｖｅ t7xb88'), ['review save t7xb88']);
  assert.deepEqual(processingControlSuggestions(`${'filler '.repeat(4000)}review save t7xb88`), ['review', 'status', 'process']);
  const long = 'review sav t7xb88 ' + 'x'.repeat(2 * 1024 * 1024);
  assert.deepEqual(processingControlSuggestions(long), ['review save t7xb88']);
  assert(Object.isFrozen(processingControlSuggestions('stat')));
  for (const text of ['review sav t7xb88', 'review save T7XB88', 'save t7xb88', 'review save <draft  code>', '<draft code>', 'Saved.']) {
    assert.equal(isProcessingControlSuggestion(text), false, text);
  }
});

test('only the trusted skill command envelope yields typed arguments', () => {
  const command = 'cuefluent-notes:cuefluent-notes', envelope = (args, name = command) =>
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`;
  for (const args of ['review sav t7xb88', '', ' review ', 'line one\nline two', 'a </command-args> b', '$& $1 $$']) {
    assert.equal(claudeSkillArguments(envelope(args)), args);
  }
  for (const text of [envelope('review', 'other-plugin:cuefluent-notes'), envelope('review', 'cuefluent-notes:other'),
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
  const build = (typed, { content, expansionArgs = typed, mutate = () => {} } = {}) => {
    const native = (type, uuid, body, extra = {}) => ({ type, uuid, timestamp: '2026-10-10T12:00:00.000Z', sessionId, cwd: root,
      version: '2.1.296', isSidechain: false, parentUuid: null, message: { role: type, content: body }, ...extra });
    const input = `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${typed}</command-args>`;
    const rows = [native('user', '33333333-3333-4333-8333-333333333333', content?.(input) ?? input, { promptId: unitId }),
      native('user', '44444444-4444-4444-8444-444444444444', [{ type: 'text', text: `Base directory for this skill: ${root}\n\nSynthetic processing skill.\n\n\nARGUMENTS: ${expansionArgs}` }],
        { promptId: unitId, parentUuid: '33333333-3333-4333-8333-333333333333', isMeta: true, turnCompanion: true }),
      native('assistant', '55555555-5555-4555-8555-555555555555', [{ type: 'tool_use', id: 'call', name: 'mcp__cuefluent_control__processing_review', input: { decision: 'save', draft: 't7xb88' } }],
        { attributionSkill: command, attributionPlugin: 'cuefluent-notes' })];
    mutate(rows);
    return rows.map(value => ({ value, hash: digest(JSON.stringify(value) + '\n') }));
  };
  const find = records => findClaudeSkillArguments(records, { source, callId: 'call', tool: 'mcp__cuefluent_control__processing_review',
    argsHash: digest(canonicalJSON({ decision: 'save', draft: 't7xb88' })), skillPath, skillCommand: command });
  for (const typed of ['review sav t7xb88', 'review save t7xb88 and tag it urgent', 'save t7xb88', 'Review', 'Remember the launch moved.']) {
    const found = await find(build(typed));
    assert.deepEqual({ ...found }, { unitId, inputId: '33333333-3333-4333-8333-333333333333', arguments: typed, mixed: false });
  }
  // A control with other content is mixed, so not a control either.
  const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } };
  assert.equal((await find(build('review save t7xb88', { content: input => [{ type: 'text', text: input }, image] }))).mixed, true);
  // Exact controls belong to the control proof; unverified input finds nothing.
  for (const records of [build('review save t7xb88'), build('review sav t7xb88', { expansionArgs: 'review save t7xb88' }),
    build('review sav t7xb88', { mutate: rows => { rows[0].promptSource = 'sdk'; } }),
    build('review sav t7xb88', { mutate: rows => { delete rows[2].attributionSkill; } }),
    build('review sav t7xb88', { mutate: rows => { rows[1].turnCompanion = false; } })]) assert.equal(await find(records), null);
});
