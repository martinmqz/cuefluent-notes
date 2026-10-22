import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeTranscript, inspectNativeRow, classifyNativeRow, extractNativeFields, validateCheckpoint } from '../../src/transcript/index.mjs';

const sessionId = 'synthetic-native-session';
const options = { client: 'claude', sessionId };
const human = (id = 'human-1', text = 'A synthetic prompt', changes = {}) => ({ type: 'user', sessionId, uuid: id, promptId: `prompt:${id}`,
  turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 }, isSidechain: false, message: { role: 'user', content: text }, ...changes });
const assistant = (id = 'assistant-1', text = 'A synthetic reply', changes = {}) => ({ type: 'assistant', sessionId, uuid: id, parentUuid: 'metadata-parent',
  isSidechain: false, message: { id: 'native-message-shared', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }, ...changes });
const toolCall = (input, id = 'tool-row') => assistant(id, '', { message: { id: 'native-message-shared', role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input }] } });
const result = (content, id = 'result-row') => ({ type: 'user', sessionId, uuid: id, parentUuid: 'tool-row', promptId: 'prompt:human-1', isSidechain: false,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content, is_error: false }] } });
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
function source(input, { trusted = false } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : encode(input);
  const reads = [];
  return { size: bytes.length, reads, read: async (offset, length) => { reads.push(length); return bytes.subarray(offset, offset + length); },
    ...(trusted ? { verify: async () => {} } : {}) };
}
async function collect(input, extra = {}) {
  const events = [];
  for await (const event of normalizeTranscript(input, { ...options, ...extra })) events.push(event);
  return { events, parts: events.filter(event => event.type === 'part').map(event => event.part), checkpoint: events.at(-1)?.checkpoint,
    pending: events.filter(event => event.type === 'pending').at(-1)?.reason };
}
const textFor = (parts, kind) => parts.flatMap(part => part.segments).filter(segment => segment.kind === kind).map(segment => segment.text).join('');

test('ordinary completed exchange is one part with exact text and bounded source reads', async () => {
  const prompt = 'Preserve \n quotes " \\ λ🧠 and \ud800 exactly', reply = 'Reply\twith\nordinary text 🧠';
  const input = source([human('human-1', prompt), assistant('assistant-1', reply)]);
  const observed = await collect(input, { limits: { readBytes: 3 } });
  assert.equal(observed.parts.length, 1); assert.equal(textFor(observed.parts, 'human'), prompt); assert.equal(textFor(observed.parts, 'assistant'), reply);
  assert.equal(observed.parts[0].partIndex, 0); assert.equal(observed.checkpoint.offset, input.size); assert.equal(observed.checkpoint.cursor, null);
  assert(input.reads.every(size => size <= 3)); assert(Object.isFrozen(observed.checkpoint)); assert(Object.isFrozen(observed.parts[0].segments[0]));
  assert(!JSON.stringify(observed.checkpoint).includes('Preserve'));
});

test('Claude row UUID preserves text and tool-use rows sharing one native message ID', async () => {
  const input = { command: 'printf "quoted\\n"', description: 'λ🧠', nested: [true, null, { untouched: '\ud800' }] };
  const observed = await collect(source([human(), assistant('text-row', 'Running.', { message: { id: 'native-message-shared', role: 'assistant',
    content: [{ type: 'text', text: 'Running.' }], stop_reason: 'tool_use' } }), toolCall(input), result('TOOL\nRESULT'), assistant()]));
  assert.equal(textFor(observed.parts, 'assistant'), 'Running.A synthetic reply');
  assert.deepEqual(JSON.parse(textFor(observed.parts, 'tool-call')), input);
  assert.equal(textFor(observed.parts, 'tool-result'), 'TOOL\nRESULT');
  assert.equal(observed.parts[0].segments.filter(segment => segment.kind === 'human').length, 1);
});

test('Claude thinking and redacted-thinking envelopes are omitted while canonical text and tool arguments remain exact', async () => {
  const omitted = 'SYNTHETIC_REASONING_NOT_CONVERSATION'.repeat(5000), signature = 'opaque-signature', data = 'opaque-redacted-data';
  const args = { exact: 'ordinary input λ🙂', nested: [true, null] };
  const rows = [human(), assistant('reasoning-only', '', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: omitted, signature }], stop_reason: 'end_turn' } }),
    { type: 'mode', mode: 'plan', sessionId },
    assistant('mixed-tool', '', { message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: '', signature }, { type: 'redacted_thinking', data }, { type: 'text', text: 'Canonical progress.' },
      { type: 'tool_use', id: 'call-1', name: 'Read', input: args }] } }), result('Exact tool output.'), assistant('final', 'Canonical answer.')];
  const observed = await collect(source(rows), { limits: { readBytes: 31 } });
  assert.equal(observed.pending, undefined); assert.equal(textFor(observed.parts, 'assistant'), 'Canonical progress.Canonical answer.');
  assert.deepEqual(JSON.parse(textFor(observed.parts, 'tool-call')), args); assert.equal(textFor(observed.parts, 'tool-result'), 'Exact tool output.');
  const output = JSON.stringify(observed); for (const forbidden of ['SYNTHETIC_REASONING_NOT_CONVERSATION', signature, data]) assert(!output.includes(forbidden));
  const pending = await collect(source(rows.slice(0, 3))); assert.equal(pending.parts.length, 0); assert.equal(pending.pending, 'TRANSCRIPT_COMPLETION_PENDING');
});

test('Claude API request shapes are bookkeeping and never become conversation or completion', async () => {
  const bookkeeping = { type: 'api-request-shape', sessionId, shapeHash: 'synthetic-shape',
    timestamp: '2026-10-22T00:00:00Z', version: 'synthetic', shape: { system: 'SYNTHETIC_API_SHAPE_ONLY'.repeat(5000) } };
  const observed = await collect(source([human(), bookkeeping, assistant()]));
  assert.equal(observed.pending, undefined); assert.equal(observed.parts.length, 1);
  assert.equal(textFor(observed.parts, 'human'), 'A synthetic prompt');
  assert.equal(textFor(observed.parts, 'assistant'), 'A synthetic reply');
  assert(!JSON.stringify(observed).includes('SYNTHETIC_API_SHAPE_ONLY'));
  const unfinished = await collect(source([human(), bookkeeping]));
  assert.equal(unfinished.parts.length, 0); assert.equal(unfinished.pending, 'TRANSCRIPT_COMPLETION_PENDING');
  const missingIdentity = await collect(source([human(), { ...bookkeeping, sessionId: undefined }, assistant()]));
  assert.equal(missingIdentity.pending, 'TRANSCRIPT_NATIVE_UNSUPPORTED');
});

test('malformed Claude reasoning envelopes and mode rows stay explicit unsupported gaps', async () => {
  for (const block of [{ type: 'thinking', thinking: 'synthetic-without-signature' }, { type: 'redacted_thinking', data: {} }]) {
    const observed = await collect(source([human(), assistant('bad-reasoning', '', { message: { role: 'assistant', content: [block], stop_reason: 'end_turn' } })]));
    assert.equal(observed.parts.length, 0); assert.equal(observed.pending, 'TRANSCRIPT_NATIVE_UNSUPPORTED');
  }
  const bad = await collect(source([human(), { type: 'mode', mode: {}, sessionId }, assistant()]));
  assert.equal(bad.pending, 'TRANSCRIPT_NATIVE_UNSUPPORTED');
});

test('only tool output is clipped, with explicit accurate byte omission notices', async () => {
  const ordinary = 'λ🧠'.repeat(800), input = { exact: ordinary };
  const output = 'λ🧠'.repeat(100);
  const observed = await collect(source([human('human-1', ordinary), toolCall(input), result(output), assistant('final', ordinary)]), { limits: { toolOutputBytes: 13 } });
  assert.equal(textFor(observed.parts, 'human'), ordinary); assert.equal(textFor(observed.parts, 'assistant'), ordinary);
  assert.deepEqual(JSON.parse(textFor(observed.parts, 'tool-call')), input);
  assert.equal(textFor(observed.parts, 'tool-result'), 'λ🧠λ🧠');
  const notice = observed.parts.flatMap(part => part.notices)[0];
  assert.equal(notice.originalBytes, Buffer.byteLength(output)); assert.equal(notice.retainedBytes, 12); assert.equal(notice.omittedBytes, Buffer.byteLength(output) - 12);
});

test('large ordinary fields make ordered resumable progress without clipped or refreshed input', async () => {
  const prompt = 'λ🧠"\\\n'.repeat(3000), reply = 'LONG_REPLY '.repeat(1800), input = source([human('human-1', prompt), assistant('final', reply)], { trusted: true });
  let retained = null, parts = [];
  for (let attempts = 0; attempts < 100; attempts++) {
    const observed = await collect(input, { checkpoint: retained, limits: { parts: 1, partBytes: 8192 } });
    parts.push(...observed.parts); retained = observed.checkpoint;
    assert(retained); assert(!observed.pending);
    if (retained.offset === input.size && retained.cursor === null) break;
    assert(attempts < 99);
  }
  assert(parts.length > 10); assert.equal(textFor(parts, 'human'), prompt); assert.equal(textFor(parts, 'assistant'), reply);
  assert(parts.every((part, index) => part.partIndex === index && !part.supplement && part.notices.length === 0));
  assert(parts.every(part => Buffer.byteLength(JSON.stringify(part)) <= 8192));
  const ranges = parts.flatMap(part => part.segments).filter(segment => segment.kind === 'human');
  assert.equal(ranges[0].range.start, 0);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].range.start, ranges[i - 1].range.end);
  assert.equal(ranges.at(-1).range.end, prompt.length);
});

test('a completed exchange stays eligible for late supplementary rows after earlier parts are discarded', async () => {
  const initial = [human(), assistant()], first = await collect(source(initial));
  const late = await collect(source([...initial, result('LATE_TOOL')]), { checkpoint: first.checkpoint });
  assert.equal(late.parts.length, 1); assert.equal(late.parts[0].exchangeId, 'human-1'); assert.equal(late.parts[0].partIndex, 1);
  assert.equal(late.parts[0].supplement, true); assert.equal(textFor(late.parts, 'human'), ''); assert.equal(textFor(late.parts, 'tool-result'), 'LATE_TOOL');
  const again = await collect(source([...initial, result('LATE_TOOL')]), { checkpoint: late.checkpoint });
  assert.equal(again.parts.length, 0);
});

test('oversized structured tool arguments resume losslessly and clipped output is noticed once', async () => {
  const args = { command: 'quotes " \\ newline\nλ🧠'.repeat(1200), nested: [{ flag: true, missing: null }] }, output = 'λ🧠'.repeat(10000);
  const input = source([human(), toolCall(args), result(output), assistant()], { trusted: true });
  let retained = null, parts = [];
  for (let tries = 0; tries < 100; tries++) {
    const observed = await collect(input, { checkpoint: retained, limits: { parts: 1, partBytes: 8192, toolOutputBytes: 2000 } });
    retained = observed.checkpoint; parts.push(...observed.parts); assert(!observed.pending);
    if (retained.offset === input.size && retained.cursor === null) break;
    assert(tries < 99);
  }
  assert.deepEqual(JSON.parse(textFor(parts, 'tool-call')), args);
  assert(Buffer.byteLength(textFor(parts, 'tool-result')) <= 2000);
  const notices = parts.flatMap(part => part.notices);
  assert.equal(notices.length, 1); assert.equal(notices[0].retainedBytes, Buffer.byteLength(textFor(parts, 'tool-result')));
  assert.equal(notices[0].omittedBytes, Buffer.byteLength(output) - notices[0].retainedBytes);
});

test('late main rows after a newer actual human group chronologically regardless of old tool reference', async () => {
  const initial = [human(), assistant(), human('human-2', 'New chronological prompt'), assistant('assistant-2', 'New reply')];
  const first = await collect(source(initial)), observed = await collect(source([...initial, result('Late result for call-1')]), { checkpoint: first.checkpoint });
  assert.equal(observed.parts[0].exchangeId, 'human-2'); assert.equal(observed.parts[0].segments[0].callId, 'call-1');
  assert.equal(observed.parts[0].supplement, true);
});

test('Stop expectation remains pending until exact terminal assistant content is durable', async () => {
  const initial = [human(), toolCall({ command: 'synthetic' }), result('Observed result')];
  const signal = { promptId: 'prompt:human-1', kind: 'completed', finalTextHash: createHash('sha256').update('EXPECTED').digest('hex') };
  const before = await collect(source(initial), { completion: signal });
  assert.equal(before.parts.length, 0); assert.equal(before.pending, 'TRANSCRIPT_COMPLETION_PENDING');
  const wrong = await collect(source([...initial, assistant('wrong', 'WRONG')]), { checkpoint: before.checkpoint, completion: signal });
  assert.equal(wrong.parts.length, 0); assert.equal(wrong.pending, 'TRANSCRIPT_FINAL_TEXT_PENDING');
  const correct = await collect(source([...initial, assistant('right', 'EXPECTED')]), { checkpoint: before.checkpoint, completion: signal });
  assert.equal(correct.parts.length, 1); assert.equal(textFor(correct.parts, 'tool-result'), 'Observed result');
  const laterCorrect = await collect(source([...initial, assistant('wrong', 'WRONG'), assistant('right', 'EXPECTED')]), { checkpoint: wrong.checkpoint, completion: signal });
  assert.equal(laterCorrect.parts.length, 1); assert.equal(textFor(laterCorrect.parts, 'assistant'), 'WRONGEXPECTED');
});

test('interrupted native completion permits observed assistant/tool data without invented end_turn', async () => {
  const rows = [human(), toolCall({ command: 'sleep 20' }), result('Tool rejected'), { type: 'user', sessionId, uuid: 'native-interruption',
    promptId: 'prompt:human-1', message: { role: 'user', content: [{ type: 'text', text: '[Synthetic native interruption notice]' }] } }];
  const observed = await collect(source(rows), { completion: { promptId: 'prompt:human-1', kind: 'interrupted' } });
  assert.equal(observed.parts[0].outcome, 'interrupted'); assert.equal(textFor(observed.parts, 'tool-result'), 'Tool rejected');
  assert.equal(observed.parts[0].segments.filter(segment => segment.kind === 'human').length, 1);
});

test('first track handles historical interrupted work at the next actual-human boundary without saved signals', async () => {
  const interruption = { type: 'user', sessionId, uuid: 'native-interruption', promptId: 'prompt:human-1',
    message: { role: 'user', content: [{ type: 'text', text: '[Native interruption notice]' }] } };
  const rows = [human(), toolCall({ command: 'sleep 20' }), result('Tool interrupted'), interruption,
    human('next', '[Native interruption notice]'), assistant('next-final', 'Later completed answer')];
  const observed = await collect(source(rows));
  assert.equal(observed.parts.length, 2); assert.equal(observed.parts[0].outcome, 'observed'); assert.equal(observed.parts[1].outcome, 'completed');
  assert.equal(textFor([observed.parts[0]], 'tool-result'), 'Tool interrupted');
  assert.equal(textFor([observed.parts[1]], 'human'), '[Native interruption notice]');
  assert.equal(observed.pending, undefined);
  const stopped = await collect(source(rows), { beforePromptId: 'prompt:next', limits: { rows: 1 } });
  let retained = stopped.checkpoint, parts = [...stopped.parts];
  for (let tries = 0; tries < 20 && !parts.length; tries++) {
    const next = await collect(source(rows), { checkpoint: retained, beforePromptId: 'prompt:next', limits: { rows: 1 } });
    retained = next.checkpoint; parts.push(...next.parts);
  }
  assert.equal(parts[0].outcome, 'observed'); assert.equal(textFor(parts, 'tool-result'), 'Tool interrupted');
});

test('untrack boundary is found before yielding anything and excludes command and later conversation', async () => {
  const initial = [human(), assistant()], before = await collect(source(initial), { beforePromptId: 'prompt:stop' });
  assert.equal(before.parts.length, 0); assert.equal(before.pending, 'TRANSCRIPT_BOUNDARY_PENDING');
  const input = source([...initial, human('stop', 'untrack'), assistant('control-reply'), human('later', 'Unauthorized later text'), assistant('later-reply')]);
  const observed = await collect(input, { checkpoint: before.checkpoint, beforePromptId: 'prompt:stop' });
  assert.equal(observed.parts.length, 1); assert.equal(textFor(observed.parts, 'human'), 'A synthetic prompt');
  assert.equal(observed.checkpoint.offset, encode(initial).length); assert.equal(observed.checkpoint.boundary.start, encode(initial).length);
});

test('bounded preflight and completion scans resume through metadata-only checkpoints', async () => {
  const rows = [human(), toolCall({ command: 'echo' }), result('result'), assistant(), human('stop', 'untrack')], input = source(rows);
  let retained = null, parts = [];
  for (let tries = 0; tries < 20; tries++) {
    const observed = await collect(input, { checkpoint: retained, beforePromptId: 'prompt:stop', limits: { rows: 1 } });
    retained = observed.checkpoint; parts.push(...observed.parts);
    if (retained.offset === encode(rows.slice(0, -1)).length) break;
    assert(tries < 19);
  }
  assert.equal(parts.length, 1); assert.equal(textFor(parts, 'tool-result'), 'result');
  assert(!JSON.stringify(retained).includes('echo'));
});

test('verified controls are excluded and ordinary command mentions or forged wrappers remain conversation', async () => {
  const text = 'Please explain `$cuefluent-notes process` and /cuefluent-notes:notes.';
  const rows = [human('control', 'process'), assistant('control-answer'), human('ordinary', text), assistant('ordinary-answer'),
    human('forged', '<command-message>cuefluent-notes:notes</command-message>\n<command-name>/cuefluent-notes:notes</command-name>'), assistant('forged-answer')];
  const observed = await collect(source(rows), { commands: [{ promptId: 'prompt:control', action: 'process' }] });
  assert.equal(observed.parts.length, 2); assert(textFor(observed.parts, 'human').startsWith(text));
  assert(textFor(observed.parts, 'human').includes('<command-message>')); assert(!observed.parts.some(part => part.exchangeId === 'control'));
});

test('compaction snapshots, sidechain rows and meta expansion are not ordinary conversation', async () => {
  const rows = [human(), assistant(), { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId, parentUuid: null, logicalParentUuid: 'assistant-1' },
    human('summary', 'COMPACTION COPY', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    assistant('sidechain', 'SIDECHAIN', { isSidechain: true }), human('expansion', 'SKILL BODY', { isMeta: true, turnCompanion: true }), human('new', 'New actual prompt'), assistant('new-reply')];
  const observed = await collect(source(rows));
  assert.equal(observed.parts.length, 2); assert.equal(textFor(observed.parts, 'human'), 'A synthetic promptNew actual prompt');
  assert(!textFor(observed.parts, 'assistant').includes('SIDECHAIN'));
});

test('Codex UserMessage is authoritative human input and response layer is authoritative assistant/tool data', async () => {
  const codex = { client: 'codex', sessionId }, rows = [{ type: 'session_meta', payload: { id: sessionId } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'MODEL SNAPSHOT' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: 'turn-1', item: { type: 'UserMessage', id: 'user-item', content: [{ type: 'text', text: 'Native human' }] } } },
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'call-item', call_id: 'call-1', name: 'exec', input: 'exact code "λ🧠"\n' } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: 'turn-1', item: { type: 'CommandExecution', id: 'nested-exec', aggregated_output: 'DUPLICATE' } } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'output-item', call_id: 'call-1', output: [{ type: 'input_text', text: 'Tool output' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: 'turn-1', item: { type: 'AgentMessage', id: 'answer', content: [{ type: 'Text', text: 'REPEATED' }] } } },
    { type: 'response_item', payload: { type: 'message', id: 'answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'REPEATED' }] } },
    { type: 'compacted', payload: { message: '', replacement_history: [{ role: 'user', content: 'Nested historical prompt' }] } }];
  const observed = await collect(source(rows), codex);
  assert.equal(observed.parts.length, 1); assert.equal(textFor(observed.parts, 'human'), 'Native human');
  assert.equal(textFor(observed.parts, 'assistant'), 'REPEATED'); assert.equal(textFor(observed.parts, 'tool-result'), 'Tool output');
  assert.equal(textFor(observed.parts, 'tool-call'), 'exact code "λ🧠"\n');
});

test('unknown inherited history and ambiguous human shapes stay pending without import', async () => {
  const unknown = await collect(source([{ type: 'session_meta', payload: { id: sessionId, history_base: { thread_id: 'parent', end_ordinal_exclusive: 26, end_byte_offset: 1000 } } }]), { client: 'codex' });
  assert.equal(unknown.parts.length, 0); assert.equal(unknown.pending, 'TRANSCRIPT_HISTORY_REQUIRED'); assert.equal(unknown.checkpoint.offset, 0);
  const ambiguous = human(); delete ambiguous.turnOrigin; delete ambiguous.turnPosition;
  const observed = await collect(source([ambiguous, assistant()]));
  assert.equal(observed.parts.length, 0); assert.equal(observed.pending, 'TRANSCRIPT_NATIVE_UNSUPPORTED');
});

test('incomplete tail, complete malformed row and changed anchor never advance over missing content', async () => {
  const initial = await collect(source([human(), assistant()]));
  const incomplete = Buffer.concat([encode([human(), assistant()]), Buffer.from('{"type":"assistant"')]);
  const tail = await collect(source(incomplete), { checkpoint: initial.checkpoint });
  assert.equal(tail.parts.length, 0); assert.equal(tail.pending, 'TRANSCRIPT_TAIL_PENDING'); assert.equal(tail.checkpoint.offset, initial.checkpoint.offset);
  const malformed = await collect(source(Buffer.concat([encode([human(), assistant()]), Buffer.from('{bad}\n')])), { checkpoint: initial.checkpoint });
  assert.equal(malformed.pending, 'TRANSCRIPT_JSON_INVALID'); assert.equal(malformed.checkpoint.offset, initial.checkpoint.offset);
  await assert.rejects(() => collect(source([human(), assistant('assistant-1', 'CHANGED')]), { checkpoint: initial.checkpoint }), { code: 'TRANSCRIPT_SOURCE_CHANGED' });
  const completeButNoNewline = await collect(source(encode([human(), assistant()]).subarray(0, -1)));
  assert.equal(completeButNoNewline.parts.length, 0);
});

test('JSON syntax, duplicate keys and metadata/depth bounds are enforced with no whole-value assembly', async () => {
  for (const bytes of [Buffer.from('{"type":"user","type":"assistant"}\n'), Buffer.from('[]\n'), Buffer.from('{"x":'+ '['.repeat(10)+'0'+ ']'.repeat(10)+'}\n')]) {
    await assert.rejects(() => inspectNativeRow(source(bytes), 0, { limits: { depth: 8 } }));
  }
  await assert.rejects(() => inspectNativeRow(source([{ type: 'user', uuid: 'x'.repeat(100) }]), 0, { limits: { metadataBytes: 20 } }), { code: 'TRANSCRIPT_METADATA_LIMIT' });
  await assert.rejects(() => inspectNativeRow(source(Buffer.from('{"'+ 'x'.repeat(30)+'":0}\n')), 0, { limits: { keyBytes: 20 } }), { code: 'TRANSCRIPT_METADATA_LIMIT' });
  const raw = source(Buffer.from('{"type":"assistant","uuid":"r","sessionId":"synthetic-native-session","message":{"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"Bash","input":{"number":1.2300e+40,"string":"exact"}}],"stop_reason":"tool_use"}}\n'));
  const row = await inspectNativeRow(raw, 0), classified = classifyNativeRow(row, options); let text = '';
  for await (const item of extractNativeFields(raw, row, classified.fields)) if (item.type === 'text') text += item.text;
  assert.equal(text, '{"number":1.2300e+40,"string":"exact"}');
});

test('checkpoint validator accepts null and rejects future schemas, content and unbound cursors', () => {
  const fresh = validateCheckpoint(null, options);
  assert.equal(fresh.offset, 0); assert(Object.isFrozen(fresh));
  assert.throws(() => validateCheckpoint({ ...fresh, schemaVersion: 2 }, options), { code: 'TRANSCRIPT_SCHEMA_UNSUPPORTED' });
  assert.throws(() => validateCheckpoint({ ...fresh, promptText: 'forbidden' }, options), { code: 'TRANSCRIPT_CHECKPOINT_INVALID' });
  assert.throws(() => validateCheckpoint({ ...fresh, sessionId: 'other' }, options), { code: 'TRANSCRIPT_IDENTITY_MISMATCH' });
  assert.throws(() => validateCheckpoint({ ...fresh, cursor: { until: 10, rowStart: 0, fieldIndex: 0, textOffset: 0, supplement: false } }, options));
});

test('native metadata discovers identity after a row larger than a constrained heap', async () => {
  const result = await promisify(execFile)(process.execPath, ['--max-old-space-size=48', fileURLToPath(new URL('./large-row-probe.mjs', import.meta.url))],
    { timeout: 30000, maxBuffer: 65536 });
  const observed = JSON.parse(result.stdout.trim());
  assert(observed.bytes > 48 * 1024 * 1024); assert(observed.metadataBytes < 4096); assert.equal(observed.maxRead, 4096);
});

test('invalid UTF-8 and corrupt streaming cursors preserve their source position', async () => {
  const invalid = Buffer.concat([Buffer.from('{"type":"user","message":{"content":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]);
  const observed = await collect(source(invalid));
  assert.equal(observed.parts.length, 0); assert.equal(observed.pending, 'TRANSCRIPT_UTF8_INVALID'); assert.equal(observed.checkpoint.offset, 0);
  const input = source([human('human-1', 'large '.repeat(2000)), assistant()], { trusted: true });
  const first = await collect(input, { limits: { parts: 1, partBytes: 8192 } });
  assert(first.checkpoint.cursor);
  await assert.rejects(() => collect(input, { checkpoint: { ...first.checkpoint, cursor: { ...first.checkpoint.cursor, textOffset: 999999 } } }), { code: 'TRANSCRIPT_CHECKPOINT_INVALID' });
});

test('producer bookkeeping rows do not stall Claude collection, including large repeated schema keys', async () => {
  const kinds = ['custom-title', 'ai-title', 'agent-name', 'agent-color', 'agent-setting', 'bridge-session', 'pr-link', 'permission-mode', 'file-history-delta', 'tag', 'worktree-state', 'isolation-latch', 'attribution-snapshot'];
  const shape = Array.from({ length: 1500 }, () => ({ ['schema-key-'.repeat(9)]: 'SYNTHETIC_BOOKKEEPING_ONLY' }));
  const rows = [human(), ...kinds.map(type => ({ type, sessionId })), { type: 'api-request-shape', sessionId, shape }, assistant()];
  const observed = await collect(source(rows));
  assert.equal(observed.pending, undefined); assert.equal(observed.parts.length, 1);
  assert.equal(textFor(observed.parts, 'human'), 'A synthetic prompt'); assert.equal(textFor(observed.parts, 'assistant'), 'A synthetic reply');
  assert(!JSON.stringify(observed).includes('SYNTHETIC_BOOKKEEPING_ONLY'));
  const unknown = await collect(source([human(), { type: 'unknown-conversation-shape', sessionId, text: 'Do not silently discard' }, assistant()]));
  assert.equal(unknown.pending, 'TRANSCRIPT_NATIVE_UNSUPPORTED'); assert.equal(unknown.parts.length, 0);
  const foreign = await collect(source([human(), { type: 'custom-title', sessionId: 'another-session' }, assistant()])).catch(error => error);
  assert.equal(foreign.code, 'TRANSCRIPT_IDENTITY_MISMATCH');
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${i}-${'x'.repeat(900)}`, 0]));
  await assert.rejects(inspectNativeRow(source([{ type: 'api-request-shape', sessionId, shape: wide }]), 0), { code: 'TRANSCRIPT_METADATA_LIMIT' });
});

test('known Codex reasoning, compaction, tool definitions and inter-agent envelopes are excluded from canonical conversation', async () => {
  const rows = [{ type: 'session_meta', payload: { id: sessionId } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: 'turn-1', item: { type: 'UserMessage', id: 'human', content: [{ type: 'text', text: 'Keep human' }] } } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONING_ONLY' }], encrypted_content: 'OPAQUE_REASONING' } },
    { type: 'response_item', payload: { type: 'compaction', encrypted_content: 'OPAQUE_COMPACTION' } },
    { type: 'response_item', payload: { type: 'additional_tools', role: 'developer', tools: [{ name: 'TOOL_DEFINITION_ONLY' }] } },
    { type: 'response_item', payload: { type: 'agent_message', author: 'worker', recipient: 'parent', content: [{ type: 'input_text', text: 'AGENT_ONLY' }] } },
    { type: 'inter_agent_communication_metadata', payload: { trigger_turn: false } },
    { type: 'response_item', payload: { type: 'message', id: 'answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Keep answer' }] } }];
  const observed = await collect(source(rows), { client: 'codex' });
  assert.equal(observed.pending, undefined); assert.equal(observed.parts.length, 1);
  assert.equal(textFor(observed.parts, 'human'), 'Keep human'); assert.equal(textFor(observed.parts, 'assistant'), 'Keep answer');
  for (const text of ['REASONING_ONLY', 'OPAQUE_REASONING', 'OPAQUE_COMPACTION', 'TOOL_DEFINITION_ONLY', 'AGENT_ONLY']) assert(!JSON.stringify(observed).includes(text));
  for (const payload of [{ type: 'reasoning', summary: {} }, { type: 'compaction', encrypted_content: {} }, { type: 'additional_tools', role: 'developer', tools: {} }, { type: 'agent_message', content: [] }, { type: 'future_assistant', text: 'Unclassified' }]) {
    const gap = await collect(source([...rows.slice(0, 2), { type: 'response_item', payload }, rows.at(-1)]), { client: 'codex' });
    assert.equal(gap.pending, 'TRANSCRIPT_NATIVE_UNSUPPORTED'); assert.equal(gap.parts.length, 0);
  }
});

test('Claude image prompts and mixed tool results preserve text with explicit ordered non-text notices', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'OPAQUE_IMAGE'.repeat(10000) } };
  const rows = [human('human-1', [{ type: 'text', text: 'Before image' }, image, { type: 'text', text: 'After image' }]), toolCall({ command: 'synthetic' }),
    result([{ type: 'text', text: 'Before result' }, image, { type: 'tool_reference', tool_name: 'SyntheticTool' }, { type: 'text', text: 'After result' }]), assistant()];
  const observed = await collect(source(rows));
  assert.equal(observed.pending, undefined); assert.equal(textFor(observed.parts, 'human'), 'Before imageAfter image');
  assert.equal(textFor(observed.parts, 'tool-result'), 'Before resultAfter result');
  assert(!JSON.stringify(observed).includes('OPAQUE_IMAGE'));
  const notices = observed.parts.flatMap(part => part.notices);
  assert.deepEqual(notices.map(item => item.contentType), ['image', 'image', 'tool_reference']);
  assert(notices.every(item => item.kind === 'non-text-content-omitted'));
  const onlyImage = await collect(source([human('image-only', [image]), assistant()]));
  assert.equal(onlyImage.parts.length, 1); assert.equal(onlyImage.parts[0].notices.length, 1);
  const interrupted = await collect(source([human(), { type: 'user', sessionId, uuid: 'originless-missing-prompt', message: { role: 'user', content: 'Ambiguous input' } }, assistant()]));
  assert.equal(interrupted.pending, 'TRANSCRIPT_NATIVE_UNSUPPORTED'); assert.equal(interrupted.parts.length, 0);
});

test('non-text notices survive streaming retries once without hiding text output or bypassing output clipping', async () => {
  const text = 'Visible output λ🙂'.repeat(2000), input = source([human(), toolCall({}), result([{ type: 'image', source: { data: 'opaque' } }, { type: 'text', text }]), assistant()], { trusted: true });
  let checkpoint = null; const parts = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const observed = await collect(input, { checkpoint, limits: { parts: 1, partBytes: 8192, toolOutputBytes: 10000 } });
    assert.equal(observed.pending, undefined); parts.push(...observed.parts); checkpoint = observed.checkpoint;
    if (checkpoint.offset === input.size && !checkpoint.cursor) break;
    assert(attempt < 99);
  }
  assert.equal(parts.flatMap(part => part.notices).filter(item => item.kind === 'non-text-content-omitted').length, 1);
  const clips = parts.flatMap(part => part.notices).filter(item => item.kind === 'tool-output-clipped');
  assert.equal(clips.length, 1); assert.equal(clips[0].retainedBytes, Buffer.byteLength(textFor(parts, 'tool-result')));
  assert(text.startsWith(textFor(parts, 'tool-result'))); assert.equal(textFor(parts, 'assistant'), 'A synthetic reply');
});

test('Codex multimodal tool-output variants preserve their textual siblings and disclose omitted blocks', async () => {
  const rows = [{ type: 'session_meta', payload: { id: sessionId } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: 'turn', item: { type: 'UserMessage', id: 'human', content: [{ type: 'text', text: 'Human' }] } } },
    { type: 'response_item', payload: { type: 'function_call_output', id: 'result', call_id: 'call', output: [
      { type: 'input_text', text: 'Tool text' }, { type: 'input_image', image_url: 'OPAQUE_IMAGE' }, { type: 'input_audio', audio_url: 'OPAQUE_AUDIO' }, { type: 'encrypted_content', encrypted_content: 'OPAQUE_ENCRYPTED' }] } },
    { type: 'response_item', payload: { type: 'message', id: 'answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Answer' }] } }];
  const observed = await collect(source(rows), { client: 'codex' });
  assert.equal(observed.pending, undefined); assert.equal(textFor(observed.parts, 'tool-result'), 'Tool text');
  assert.deepEqual(observed.parts.flatMap(part => part.notices).map(item => item.contentType), ['input_image', 'input_audio', 'encrypted_content']);
  assert(!JSON.stringify(observed).includes('OPAQUE_'));
});
