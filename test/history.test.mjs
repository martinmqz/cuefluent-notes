import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveNativeHistory, reanchorNativeCheckpoint, buildClaudeCommandContext, resolveClaudeCommandBoundary } from '../src/client/history.mjs';
import { createHistoricalCommandClassifier } from '../src/client/historical-commands.mjs';
import { normalizeTranscript, inspectNativeRow } from '../src/transcript/index.mjs';

const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function physical(id, rows) {
  const bytes = encode(rows); let closed = 0;
  return { size: bytes.length, identity: Object.freeze({ path: `synthetic:${id}` }), bytes, get closed() { return closed; },
    read: async (offset, length) => { assert(length <= 65536); assert.equal(closed, 0); return bytes.subarray(offset, offset + length); },
    verify: async () => { assert.equal(closed, 0); }, close: async () => { closed++; } };
}
const header = (id, ordinal = 0, base = null) => ({ type: 'session_meta', ordinal, payload: { id, history_mode: 'paginated',
  ...(base ? { history_base: base, forked_from_id: base.thread_id, forked_from_ordinal_exclusive: base.end_ordinal_exclusive } : {}) } });
const human = (id, rowId, ordinal, text) => ({ type: 'event_msg', ordinal, payload: { type: 'item_completed', thread_id: id, turn_id: `turn:${rowId}`,
  item: { type: 'UserMessage', id: rowId, content: [{ type: 'text', text }] } } });
const answer = (rowId, ordinal, text) => ({ type: 'response_item', ordinal, payload: { type: 'message', id: `answer:${rowId}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } });
const done = ordinal => ({ type: 'event_msg', ordinal, payload: { type: 'task_complete' } });
const setting = ordinal => ({ type: 'event_msg', ordinal, payload: { type: 'thread_settings_applied' } });
const parentRows = () => [header('parent'), human('parent', 'inherited-human', 1, 'Inherited first prompt'), answer('inherited-human', 2, 'Inherited first reply'), done(3)];
function forkFixture() {
  const inherited = parentRows(), cutoff = encode(inherited).length;
  const parent = physical('parent-active', [...inherited, human('parent', 'future-parent', 4, 'Excluded future parent'), answer('future-parent', 5, 'Excluded future reply')]);
  const base = { thread_id: 'parent', end_ordinal_exclusive: 4, end_byte_offset: cutoff };
  const childRows = [header('child', 4, base), human('child', 'child-human', 5, 'New child prompt'), answer('child-human', 6, 'New child reply'), done(7)];
  return { parent, child: physical('child-active', childRows), cutoff, base };
}
async function normalized(source, sessionId, checkpoint = null) {
  const events = [];
  for await (const event of normalizeTranscript(source, { client: 'codex', sessionId, checkpoint })) events.push(event);
  return { events, parts: events.filter(event => event.type === 'part').map(event => event.part), checkpoint: events.at(-1)?.checkpoint };
}
const text = parts => parts.flatMap(part => part.segments).map(segment => segment.text).join('');

test('manual Codex fork resolves only the exact native parent prefix and preserves original native provenance', async () => {
  const fixture = forkFixture(), requests = [];
  const result = await resolveNativeHistory(fixture.child, { client: 'codex', sessionId: 'child', startSource: 'fork', resolveSource: async request => {
    requests.push(request); assert.equal(request.sessionId, 'parent'); assert.deepEqual(request.before, { ordinalExclusive: 4, byteOffset: fixture.cutoff });
    assert.equal(request.excludeIdentity.path, 'synthetic:child-active'); return fixture.parent;
  } });
  assert.equal(result.status, 'ready'); assert.equal(requests.length, 1); assert.equal(result.history.sources, 2);
  const observed = await normalized(result.source, 'child');
  assert.equal(observed.parts.length, 2); assert(text(observed.parts).includes('Inherited first prompt')); assert(!text(observed.parts).includes('Excluded future parent'));
  assert(observed.parts.every(part => part.sessionId === 'child'));
  assert.equal(observed.parts[0].segments[0].source.nativeSessionId, 'parent'); assert.equal(observed.parts[1].segments[0].source.nativeSessionId, 'child');
  await result.source.verify(observed.checkpoint.anchor); await result.source.close();
  assert.equal(fixture.parent.closed, 1); assert.equal(fixture.child.closed, 0);
});

test('automatic Codex fork omits the explicitly inherited prefix without opening its parent', async () => {
  const fixture = forkFixture();
  const result = await resolveNativeHistory(fixture.child, { client: 'codex', sessionId: 'child', mode: 'automatic', startSource: 'fork',
    resolveSource: () => { throw new Error('The omitted inherited source must not be opened'); } });
  assert.equal(result.status, 'ready'); assert.equal(result.history.omittedInheritedBytes, fixture.cutoff);
  const observed = await normalized(result.source, 'child');
  assert.equal(observed.parts.length, 1); assert.equal(observed.parts[0].exchangeId, 'child-human'); assert(!text(observed.parts).includes('Inherited first'));
  await result.source.close();
});

test('same-ID Codex revert resolves its prior physical prefix instead of reading an old excluded EOF', async () => {
  const parent = physical('parent', parentRows()), first = { thread_id: 'parent', end_ordinal_exclusive: 4, end_byte_offset: parent.size };
  const retained = [header('child', 4, first), setting(5), setting(6)], cutoff = encode(retained).length;
  const old = physical('old-child', [...retained, human('child', 'reverted-human', 7, 'REVERTED PROMPT'), answer('reverted-human', 8, 'REVERTED REPLY'), done(9)]);
  const base = { thread_id: 'child', end_ordinal_exclusive: 7, end_byte_offset: cutoff };
  const currentHeader = header('child', 7, base); currentHeader.payload.forked_from_id = 'parent'; currentHeader.payload.forked_from_ordinal_exclusive = 4;
  const current = physical('new-child-path', [currentHeader, setting(8), human('child', 'current-human', 9, 'Current new prompt'), answer('current-human', 10, 'Current new reply')]);
  const requests = [], result = await resolveNativeHistory(current, { client: 'codex', sessionId: 'child', startSource: 'resume', resolveSource: async request => {
    requests.push(request); return request.sessionId === 'child' ? old : parent;
  } });
  assert.equal(result.status, 'ready'); assert.deepEqual(requests.map(request => request.sessionId), ['child', 'parent']);
  assert.deepEqual(requests[0].before, { ordinalExclusive: 7, byteOffset: cutoff });
  const observed = await normalized(result.source, 'child');
  assert.equal(observed.parts.length, 2); assert(!text(observed.parts).includes('REVERTED')); assert(text(observed.parts).includes('Current new prompt'));
  await result.source.close(); assert.equal(old.closed, 1); assert.equal(parent.closed, 1); assert.equal(current.closed, 0);
});

test('native resolver rejects identity, ordinal, byte-boundary and cycle conflicts without falling back', async () => {
  for (const change of ['identity', 'ordinal', 'bytes', 'unavailable']) {
    const fixture = forkFixture();
    if (change === 'ordinal') fixture.child = physical('bad-child', [header('child', 5, { ...fixture.base, end_ordinal_exclusive: 5 })]);
    if (change === 'bytes') fixture.child = physical('bad-child', [header('child', 4, { ...fixture.base, end_byte_offset: fixture.cutoff - 1 })]);
    const selected = change === 'identity' ? physical('wrong', [header('other')]) : fixture.parent;
    const result = await resolveNativeHistory(fixture.child, { client: 'codex', sessionId: 'child', resolveSource: async () => change === 'unavailable' ? null : selected });
    assert.equal(result.status, 'pending'); assert.equal(fixture.child.closed, 0);
    if (change !== 'unavailable') assert.equal(selected.closed, 1);
  }
  const circular = physical('circular', [header('circular', 1, { thread_id: 'circular', end_ordinal_exclusive: 1, end_byte_offset: 1 })]);
  const result = await resolveNativeHistory(circular, { client: 'codex', sessionId: 'circular', resolveSource: async () => circular });
  assert.deepEqual(result, { status: 'pending', reason: 'HISTORY_CYCLE' }); assert.equal(circular.closed, 0);
});

test('history source chain depth is bounded and acquired sources are released on failure', async () => {
  const sources = [physical('level-0', [header('level-0')])];
  for (let i = 1; i <= 33; i++) sources.push(physical(`level-${i}`, [header(`level-${i}`, i, {
    thread_id: `level-${i - 1}`, end_ordinal_exclusive: i, end_byte_offset: sources[i - 1].size })]));
  const result = await resolveNativeHistory(sources[33], { client: 'codex', sessionId: 'level-33', resolveSource: async request => sources[Number(request.sessionId.slice(6))] });
  assert.equal(result.status, 'pending'); assert.equal(sources[33].closed, 0);
  assert(sources.slice(1, 33).some(source => source.closed === 1));
});

test('empty native inherited prefix is explicit and needs no historical source lookup', async () => {
  const input = physical('empty-fork', [header('child', 0, { thread_id: 'parent', end_ordinal_exclusive: 0, end_byte_offset: 0 })]);
  const result = await resolveNativeHistory(input, { client: 'codex', sessionId: 'child', resolveSource: () => { throw new Error('Unexpected source lookup'); } });
  assert.equal(result.status, 'ready'); await result.source.close();
});

function claudeRows() {
  const user = (id, body) => ({ type: 'user', sessionId: 'claude-child', uuid: id, promptId: `prompt:${id}`, turnOrigin: 'sdk',
    turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: body } });
  const reply = id => ({ type: 'assistant', sessionId: 'claude-child', uuid: `answer:${id}`, message: { role: 'assistant',
    content: [{ type: 'text', text: `Reply ${id}` }], stop_reason: 'end_turn' } });
  return [user('copied', 'Copied inherited prompt'), reply('copied'), user('new', 'Actual new prompt'), reply('new')];
}

test('Claude explicit manual fork retains copied selected conversation while automatic unknown boundary stays pending', async () => {
  const input = physical('claude-fork', claudeRows());
  const unknown = await resolveNativeHistory(input, { client: 'claude', sessionId: 'claude-child', mode: 'automatic', startSource: 'fork' });
  assert.deepEqual(unknown, { status: 'pending', reason: 'HISTORY_INHERITED_BOUNDARY_UNKNOWN' });
  const manual = await resolveNativeHistory(input, { client: 'claude', sessionId: 'claude-child', mode: 'manual', startSource: 'fork' });
  assert.equal(manual.status, 'ready');
  const parts = [];
  for await (const event of normalizeTranscript(manual.source, { client: 'claude', sessionId: 'claude-child' })) if (event.type === 'part') parts.push(event.part);
  assert.equal(parts.length, 2); assert(text(parts).includes('Copied inherited prompt')); await manual.source.close();
});

test('Claude automatic fork can use a separately trusted exact inherited prefix and native anchor', async () => {
  const rows = claudeRows(), input = physical('claude-fork', rows), prefix = encode(rows.slice(0, 2));
  const first = await inspectNativeRow(input, 0), last = await inspectNativeRow(input, first.end);
  const inheritedBoundary = { endByteOffset: prefix.length, hash: hash(prefix), anchor: { start: last.start, end: last.end, hash: last.hash, rowId: 'answer:copied' } };
  const result = await resolveNativeHistory(input, { client: 'claude', sessionId: 'claude-child', mode: 'automatic', startSource: 'fork', inheritedBoundary });
  assert.equal(result.status, 'ready'); assert.equal(result.history.omittedInheritedBytes, prefix.length);
  const parts = [];
  for await (const event of normalizeTranscript(result.source, { client: 'claude', sessionId: 'claude-child' })) if (event.type === 'part') parts.push(event.part);
  assert.equal(parts.length, 1); assert.equal(parts[0].exchangeId, 'new'); await result.source.close();
  const conflict = await resolveNativeHistory(input, { client: 'claude', sessionId: 'claude-child', mode: 'automatic', startSource: 'fork',
    inheritedBoundary: { ...inheritedBoundary, hash: 'a'.repeat(64) } });
  assert.equal(conflict.status, 'pending'); assert.equal(conflict.reason, 'HISTORY_BOUNDARY_INVALID');
});

test('Claude same-ID compaction preserves original rows and excludes only native summary bookkeeping', async () => {
  const rows = claudeRows().slice(0, 2);
  rows.push({ type: 'system', subtype: 'compact_boundary', sessionId: 'claude-child', uuid: 'compact', parentUuid: null, logicalParentUuid: 'answer:copied' },
    { ...claudeRows()[2], uuid: 'summary', isCompactSummary: true, isVisibleInTranscriptOnly: true, parentUuid: 'compact' }, ...claudeRows().slice(2));
  const input = physical('compacted', rows), result = await resolveNativeHistory(input, { client: 'claude', sessionId: 'claude-child', startSource: 'compact' });
  assert.equal(result.status, 'ready'); const parts = [];
  for await (const event of normalizeTranscript(result.source, { client: 'claude', sessionId: 'claude-child' })) if (event.type === 'part') parts.push(event.part);
  assert.equal(parts.length, 2); assert.equal(parts.flatMap(part => part.segments).filter(segment => segment.kind === 'human').length, 2);
  await result.source.close();
});

test('completed native bookmarks re-anchor only at identical record identity and exact inspected hash', async () => {
  const old = physical('old', parentRows()), observed = await normalized(old, 'parent');
  assert.equal(observed.checkpoint.anchor.rowId, 'ordinal:3');
  const base = { thread_id: 'parent', end_ordinal_exclusive: 4, end_byte_offset: old.size };
  const current = physical('replacement-path', [header('parent', 4, base), human('parent', 'later', 5, 'Later prompt'), answer('later', 6, 'Later reply')]);
  const result = await resolveNativeHistory(current, { client: 'codex', sessionId: 'parent', resolveSource: async () => old });
  assert.equal(result.status, 'ready');
  const anchored = await reanchorNativeCheckpoint(result.source, observed.checkpoint, { client: 'codex', sessionId: 'parent' });
  assert.equal(anchored.status, 'ready'); assert.equal(anchored.checkpoint.anchor.hash, observed.checkpoint.anchor.hash);
  assert.equal(anchored.checkpoint.exchange.nextPart, observed.checkpoint.exchange.nextPart);
  const later = await normalized(result.source, 'parent', anchored.checkpoint);
  assert.equal(later.parts.length, 1); assert.equal(later.parts[0].exchangeId, 'later'); assert(!text(later.parts).includes('Inherited first'));
  const missing = await reanchorNativeCheckpoint(physical('missing', [header('parent')]), observed.checkpoint, { client: 'codex', sessionId: 'parent' });
  assert.deepEqual(missing, { status: 'pending', reason: 'HISTORY_ANCHOR_MISSING' });
  await result.source.close();
});

const commandSession = 'fork-child', commandPrompt = 'rewritten-current-prompt', commandName = 'cuefluent-notes:notes';
const commandSkill = path.resolve('synthetic-skill', 'SKILL.md'), nonce = 'fedcba98-7654-4321-8abc-0123456789ab';
const oldNonce = '12345678-90ab-4cde-9f01-23456789abcd';
const classifyCommand = createHistoricalCommandClassifier({ client: 'claude', name: commandName, skillPath: commandSkill });
function command(id, action = 'track', invocationNonce = nonce) {
  return [
    { type: 'user', sessionId: commandSession, uuid: id, promptId: commandPrompt, turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 },
      message: { role: 'user', content: `<command-message>${commandName}</command-message>\n<command-name>/${commandName}</command-name>\n<command-args>${action}</command-args>` } },
    { type: 'user', sessionId: commandSession, uuid: `expanded:${id}`, promptId: commandPrompt, parentUuid: id, isMeta: true, turnCompanion: true,
      message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(commandSkill)}\n\nSynthetic body.` }] } },
    { type: 'attachment', sessionId: commandSession, uuid: `context:${id}`, parentUuid: `expanded:${id}`, isSidechain: false,
      attachment: { type: 'hook_additional_context', hookName: 'UserPromptExpansion', hookEvent: 'UserPromptExpansion', content: [buildClaudeCommandContext(invocationNonce)] } },
  ];
}
const boundary = (input, changes = {}) => resolveClaudeCommandBoundary(input, { sessionId: commandSession, promptId: commandPrompt, nonce, classifyCommand, ...changes });

test('native per-invocation context selects exact fork track/untrack boundary despite copied prompt IDs and identical older commands', async () => {
  assert.equal(buildClaudeCommandContext(nonce), `Cuefluent Notes invocation: ${nonce}`);
  for (const invalid of [null, nonce.toUpperCase(), 'known-word', nonce.replace('-4321-', '-1321-')]) {
    assert.throws(() => buildClaudeCommandContext(invalid), { code: 'HISTORY_CONTEXT_INVALID' });
  }
  for (const action of ['track', 'untrack']) {
    const ordinary = { type: 'user', sessionId: commandSession, uuid: 'ordinary', promptId: commandPrompt, turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 },
      message: { role: 'user', content: 'Preserve earlier ordinary conversation' } };
    const reply = { type: 'assistant', sessionId: commandSession, uuid: 'reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Useful earlier answer' }], stop_reason: 'end_turn' } };
    const input = physical(`fork-${action}`, [ordinary, reply, ...command('inherited', action, oldNonce), ...command('current', action)]);
    const result = await boundary(input);
    assert.equal(result.status, 'ready'); assert.equal(result.action, action); assert.equal(result.beforeRowId, 'current'); assert.equal(result.anchors.length, 3);
    const parts = [];
    for await (const event of normalizeTranscript(input, { client: 'claude', sessionId: commandSession, beforePromptId: result.beforePromptId,
      beforeRowId: result.beforeRowId, classifyCommand })) if (event.type === 'part') parts.push(event.part);
    assert.equal(parts.length, 1); assert.equal(parts[0].segments[0].text, ordinary.message.content);
    assert(!JSON.stringify(parts).includes(nonce)); assert(Object.isFrozen(result.anchors[0]));
  }
});

test('fork nonce proof waits for complete native attachment and refuses ordinary text, snapshots and structural mismatches', async () => {
  const rows = command('current');
  const unrelated = { type: 'api-request-blob', sessionId: commandSession, message: { role: 'system', content: [{ type: 'text', text: buildClaudeCommandContext(nonce) }] } };
  for (const input of [physical('missing', rows.slice(0, 2)), physical('snapshot', [...rows.slice(0, 2), unrelated]),
    physical('text', [{ ...rows[0], message: { role: 'user', content: buildClaudeCommandContext(nonce) } }])]) {
    assert.deepEqual(await boundary(input), { status: 'pending', reason: 'HISTORY_COMMAND_BOUNDARY_PENDING' });
  }
  for (const changes of [{ type: 'user' }, { isSidechain: true }, { sessionId: 'another' },
    { attachment: { ...rows[2].attachment, type: 'other' } }, { attachment: { ...rows[2].attachment, hookName: 'UserPromptSubmit' } },
    { attachment: { ...rows[2].attachment, hookEvent: 'Stop' } }, { attachment: { ...rows[2].attachment, content: [buildClaudeCommandContext(nonce), 'extra'] } }]) {
    assert.equal((await boundary(physical('mismatch', [...rows.slice(0, 2), { ...rows[2], ...changes }]))).status, 'pending');
  }
  for (const changes of [{ parentUuid: 'another' }, { isMeta: false }, { promptId: 'another' }]) {
    assert.deepEqual(await boundary(physical('bad-link', [rows[0], { ...rows[1], ...changes }, rows[2]])), { status: 'pending', reason: 'HISTORY_COMMAND_PROOF_PENDING' });
  }
  const complete = encode(rows), partial = complete.subarray(0, complete.length - 4);
  assert.equal((await boundary({ size: partial.length, read: async (offset, length) => partial.subarray(offset, offset + length) })).status, 'pending');
  assert.deepEqual(await boundary(physical('duplicate', [...rows, ...command('duplicate')])), { status: 'pending', reason: 'HISTORY_COMMAND_BOUNDARY_AMBIGUOUS' });
});

test('fork boundary proof verifies exact source anchors before publishing the native row identity', async () => {
  const input = physical('changed', command('current')), changed = Object.assign(new Error('Synthetic replacement'), { code: 'TRANSCRIPT_SOURCE_CHANGED' });
  await assert.rejects(boundary({ ...input, verify: async () => { throw changed; } }), { code: 'TRANSCRIPT_SOURCE_CHANGED' });
  assert.equal(input.closed, 0);
});

test('verified composite histories make bounded read progress across many parts without hashing inherited prefix per part', async () => {
  let readBytes = 0, largestRead = 0, verifications = 0;
  const instrument = source => ({ ...source, read: async (offset, length) => {
    readBytes += length; largestRead = Math.max(largestRead, length); return source.read(offset, length);
  }, verify: async () => { verifications++; await source.verify(); } });
  const rootHeader = header('parent'); rootHeader.payload.syntheticPadding = 'x'.repeat(128 * 1024);
  const parent = instrument(physical('large-parent', [rootHeader, ...parentRows().slice(1)]));
  const base = { thread_id: 'parent', end_ordinal_exclusive: 4, end_byte_offset: parent.size };
  const rows = [header('child', 4, base)];
  for (let index = 0; index < 48; index++) rows.push(human('child', `human-${index}`, 5 + index * 2, `Prompt ${index}`), answer(`human-${index}`, 6 + index * 2, `Reply ${index}`));
  const active = instrument(physical('many-exchanges', rows));
  const result = await resolveNativeHistory(active, { client: 'codex', sessionId: 'child', resolveSource: async () => parent });
  assert.equal(result.status, 'ready'); readBytes = 0;
  const observed = await normalized(result.source, 'child');
  assert.equal(observed.parts.length, 49); assert(verifications > 100); assert(largestRead <= 65536);
  assert(readBytes < result.source.size * 12, `Repeated prefix hashing amplified ${readBytes} bytes over source size ${result.source.size}`);
  const anchor = observed.checkpoint.anchor, beforeCached = readBytes;
  for (let index = 0; index < 20; index++) await result.source.verify(anchor);
  assert.equal(readBytes, beforeCached);
  await result.source.close();
});

test('composite verification falls back to exact prefix hashing without physical verification and rejects changed bytes', async () => {
  const original = physical('unverified', claudeRows()); let current = Buffer.from(original.bytes), readBytes = 0;
  const unverified = { size: current.length, read: async (offset, length) => { readBytes += length; return current.subarray(offset, offset + length); } };
  const result = await resolveNativeHistory(unverified, { client: 'claude', sessionId: 'claude-child' });
  assert.equal(result.status, 'ready'); readBytes = 0;
  await result.source.verify(); assert.equal(readBytes, result.source.size);
  current = Buffer.from(current); current[current.indexOf('Copied')] = 'c'.charCodeAt(0);
  await assert.rejects(result.source.verify(), { code: 'TRANSCRIPT_SOURCE_CHANGED' });
  await result.source.close();
});
