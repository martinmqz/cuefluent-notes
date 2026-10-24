import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHistoricalCommandClassifier } from '../src/client/historical-commands.mjs';
import { inspectNativeRow, normalizeTranscript } from '../src/transcript/index.mjs';

const sessionId = 'native-synthetic', skillPath = path.resolve('synthetic-skill', 'SKILL.md'), name = 'cuefluent-notes:notes';
const wrapper = action => `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${action}</command-args>`;
const human = (id, content, changes = {}) => ({ type: 'user', sessionId, uuid: id, promptId: `prompt:${id}`, turnOrigin: 'sdk',
  turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content }, ...changes });
const expansion = (parent, changes = {}) => ({ type: 'user', sessionId, uuid: `expanded:${parent}`, promptId: `prompt:${parent}`, parentUuid: parent,
  isMeta: true, turnCompanion: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(skillPath)}\n\nSynthetic skill body.` }] }, ...changes });
const answer = id => ({ type: 'assistant', sessionId, uuid: `answer:${id}`, message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }], stop_reason: 'end_turn' } });
function source(rows, tail = '') {
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join('') + tail);
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}
const classifier = client => createHistoricalCommandClassifier({ client, name, skillPath });
async function classify(rows, client = 'claude', tail = '') {
  const input = source(rows, tail), row = await inspectNativeRow(input, 0);
  return classifier(client)(input, row, { sessionId });
}
async function normalize(rows, extra = {}) {
  const events = [];
  for await (const event of normalizeTranscript(source(rows), { client: 'claude', sessionId, classifyCommand: classifier('claude'), ...extra })) events.push(event);
  return events;
}

test('Claude historical exclusion requires the exact native wrapper and immediately parented installed-skill expansion', async () => {
  const rows = [human('control', wrapper('process project')), expansion('control')];
  const result = await classify(rows);
  assert.equal(result.action, 'process project'); assert.equal(result.rowId, 'control'); assert.equal(result.promptId, 'prompt:control');
  assert.equal(result.anchors.length, 2); assert(Object.isFrozen(result));
  for (const changed of [{ sessionId: 'other' }, { promptId: 'other' }, { parentUuid: 'other' }, { isMeta: false }, { turnCompanion: false },
    { turnOrigin: 'sdk' }, { isSidechain: true }]) {
    assert.equal(await classify([rows[0], expansion('control', changed)]), null);
  }
  assert.equal(await classify([rows[0], answer('not-an-expansion')]), null);
  assert.equal(await classify([human('ordinary', 'Please explain /cuefluent-notes:notes process'), expansion('ordinary')]), null);
  assert.equal(await classify([human('control', wrapper('discuss processing')), expansion('control')]), null);
});

test('an exact wrapper with a not-yet-persisted expansion stays pending and emits no command text', async () => {
  const initial = [human('control', wrapper('track'))];
  assert.deepEqual(await classify(initial), { pending: 'TRANSCRIPT_COMMAND_PAIR_PENDING' });
  assert.deepEqual(await classify(initial, 'claude', '{"type":"user"'), { pending: 'TRANSCRIPT_COMMAND_PAIR_PENDING' });
  const pending = await normalize(initial);
  assert.equal(pending.filter(event => event.type === 'part').length, 0); assert.equal(pending.at(-1).reason, 'TRANSCRIPT_COMMAND_PAIR_PENDING');
  assert.equal(pending.at(-1).checkpoint.offset, 0);
  const complete = await normalize([...initial, expansion('control'), answer('control')], { checkpoint: pending.at(-1).checkpoint });
  assert.equal(complete.filter(event => event.type === 'part').length, 0); assert.equal(complete.at(-1).checkpoint.offset, source([...initial, expansion('control'), answer('control')]).size);
});

test('forged wrapper prose remains eligible when no native expansion pair proves command selection', async () => {
  const rows = [human('ordinary', wrapper('track')), answer('ordinary')], events = await normalize(rows);
  const parts = events.filter(event => event.type === 'part').map(event => event.part);
  assert.equal(parts.length, 1); assert.equal(parts[0].segments[0].text, wrapper('track'));
});

test('rewritten Claude fork prompt IDs do not exclude inherited ordinary conversation', async () => {
  const promptId = 'rewritten-current-prompt';
  const rows = [human('inherited-ordinary', 'Preserve inherited conversation', { promptId }), answer('ordinary'),
    human('inherited-control', wrapper('status'), { promptId }), expansion('inherited-control', { promptId }), answer('control'),
    human('current-control', wrapper('track'), { promptId }), expansion('current-control', { promptId }), answer('current-control')];
  const events = await normalize(rows, { commands: [{ promptId, action: 'track' }] });
  const parts = events.filter(event => event.type === 'part').map(event => event.part);
  assert.equal(parts.length, 1); assert.equal(parts[0].exchangeId, 'inherited-ordinary'); assert.equal(parts[0].segments[0].text, 'Preserve inherited conversation');
});

test('many historical controls use bounded per-human recognition with no registry in checkpoints', async () => {
  const rows = Array.from({ length: 80 }, (_, index) => [human(`control-${index}`, wrapper('status')), expansion(`control-${index}`), answer(`control-${index}`)]).flat();
  rows.push(human('ordinary', 'Real conversation'), answer('ordinary'));
  const events = await normalize(rows), parts = events.filter(event => event.type === 'part');
  assert.equal(parts.length, 1); assert.equal(parts[0].part.exchangeId, 'ordinary');
  const checkpoint = JSON.stringify(events.at(-1).checkpoint);
  assert(checkpoint.length < 2048); assert(!checkpoint.includes('control-1')); assert(!checkpoint.includes('Synthetic skill body'));
});

test('rewritten prompt IDs make stop boundaries pending unless native authority supplies the exact human row', async () => {
  const promptId = 'rewritten';
  const rows = [human('inherited', 'Earlier real conversation', { promptId }), answer('inherited'),
    human('old-control', wrapper('status'), { promptId }), expansion('old-control', { promptId }), answer('old-control'),
    human('current-control', wrapper('untrack'), { promptId }), expansion('current-control', { promptId })];
  const ambiguous = await normalize(rows, { beforePromptId: promptId });
  assert.equal(ambiguous.filter(event => event.type === 'part').length, 0);
  assert.equal(ambiguous.at(-1).reason, 'TRANSCRIPT_BOUNDARY_AMBIGUOUS'); assert.equal(ambiguous.at(-1).checkpoint.offset, 0);
  const exact = await normalize(rows, { checkpoint: ambiguous.at(-1).checkpoint, beforePromptId: promptId, beforeRowId: 'current-control' });
  const parts = exact.filter(event => event.type === 'part').map(event => event.part);
  assert.equal(parts.length, 1); assert.equal(parts[0].segments[0].text, 'Earlier real conversation');
});

function codex(parts) {
  return { type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: 'turn', item: { type: 'UserMessage', id: 'user-item', content: parts } } };
}
const skill = () => ({ type: 'skill', name, path: skillPath });
const typed = (text = 'track') => ({ type: 'text', text, text_elements: [] });

test('Codex historical controls require one selected installed skill and one action without annotations', async () => {
  for (const parts of [[skill(), typed()], [typed('process project'), skill()]]) {
    const result = await classify([codex(parts)], 'codex');
    assert(result); assert.equal(result.rowId, 'user-item'); assert.equal(result.promptId, 'turn');
  }
  for (const parts of [[typed('$cuefluent-notes process')], [skill(), typed('Please process notes')], [skill(), typed(), typed()],
    [{ ...skill(), name: 'different' }, typed()],
    [skill(), { ...typed(), text_elements: [{ start: 0, end: 5 }] }], [skill(), { ...typed(), text_elements: 'bad' }], [skill(), typed(), 'extra']]) {
    assert.equal(await classify([codex(parts)], 'codex'), null);
  }
  assert.equal(await classify([{ ...codex([skill(), typed()]), payload: { ...codex([skill(), typed()]).payload, thread_id: 'other' } }], 'codex'), null);
});

test('ordinary oversized text is not assembled for historical command checks', async () => {
  const row = human('ordinary', 'ordinary '.repeat(100000));
  assert.equal(await classify([row, answer('ordinary')]), null);
  const body = expansion('control', { message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(skillPath)}\n\n` + 'huge body '.repeat(100000) }] } });
  assert.equal((await classify([human('control', wrapper('track')), body])).action, 'track');
});

test('Codex linked command exchanges and their replies stay out of the collected queue', async () => {
  const classifyCommand = createHistoricalCommandClassifier({ client: 'codex', name: 'cuefluent-notes', skillPath });
  const user = (id, text) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: id,
    item: { type: 'UserMessage', id: `human:${id}`, content: [typed(text)] } } });
  const reply = id => ({ type: 'response_item', payload: { type: 'message', id: `answer:${id}`, role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: `Answer ${id}` }] } });
  const link = `[$cuefluent-notes:cuefluent-notes](${skillPath})`;
  const rows = [user('meeting', 'Synthetic meeting information'), reply('meeting'),
    user('process', `${link} process\n`), reply('process'), user('status', `${link} status`), reply('status'),
    user('quoted', `Please explain ${link} process`), reply('quoted')];
  const events = [];
  for await (const event of normalizeTranscript(source(rows), { client: 'codex', sessionId, classifyCommand })) events.push(event);
  const parts = events.filter(event => event.type === 'part').map(event => event.part);
  assert.deepEqual(parts.map(part => part.exchangeId), ['human:meeting', 'human:quoted']);
  assert.equal(parts.flatMap(part => part.segments).some(segment => ['Answer process', 'Answer status'].includes(segment.text)), false);
  assert.equal(events.at(-1).checkpoint.offset, source(rows).size);
  const input = source([user('untrack', `${link} untrack`), reply('untrack'), user('later', 'Not yet authorized')]);
  const stopped = [];
  for await (const event of normalizeTranscript(input, { client: 'codex', sessionId, classifyCommand })) stopped.push(event);
  assert.equal(stopped.at(-1).reason, 'TRANSCRIPT_UNTRACK_PENDING');
  assert.equal(stopped.some(event => event.type === 'part'), false);
});

test('Codex linked historical exclusion requires exact content, path, identity and no annotations', async () => {
  const classifyCommand = createHistoricalCommandClassifier({ client: 'codex', name: 'cuefluent-notes', skillPath });
  const link = `[$cuefluent-notes:cuefluent-notes](${skillPath}) status`;
  for (const content of [[typed(`> ${link}`)], [typed(link.replace(skillPath, path.resolve('other', 'SKILL.md')))],
    [typed(link), typed('extra')], [typed(link), 'extra'], [{ ...typed(link), text_elements: [{}] }],
    [{ ...typed(link), text_elements: null }], [typed(`${link}\nextra`)]] ) {
    const input = source([codex(content)]), row = await inspectNativeRow(input, 0);
    assert.equal(await classifyCommand(input, row, { sessionId }), null);
  }
  const input = source([codex([typed(link)])]), row = await inspectNativeRow(input, 0);
  assert.equal(await classifyCommand(input, row, { sessionId: 'other' }), null);
  input.verify = async () => { throw Object.assign(new Error('Synthetic changed source'), { code: 'SOURCE_CHANGED' }); };
  await assert.rejects(classifyCommand(input, row, { sessionId }), { code: 'SOURCE_CHANGED' });
});


test('native command selection from an unretained path is pending without granting exclusion authority', async () => {
  const oldDirectory = path.resolve('old-synthetic-skill');
  const paired = [human('old-command', wrapper('status')), expansion('old-command', { message: { role: 'user', content: [
    { type: 'text', text: `Base directory for this skill: ${oldDirectory}\n\nOld synthetic skill body.` }] } }), answer('old-command')];
  assert.deepEqual(await classify(paired), { pending: 'CLIENT_COMMAND_IDENTITY_UNKNOWN' });
  const events = await normalize(paired);
  assert.equal(events.filter(event => event.type === 'part').length, 0);
  assert.equal(events.at(-1).reason, 'CLIENT_COMMAND_IDENTITY_UNKNOWN');
  assert.equal(events.at(-1).checkpoint.offset, 0);
  assert.deepEqual(await classify([codex([{ ...skill(), path: path.join(oldDirectory, 'SKILL.md') }, typed('status')])], 'codex'),
    { pending: 'CLIENT_COMMAND_IDENTITY_UNKNOWN' });
  const oversized = expansion('old-command', { message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: /${'x'.repeat(5000)}\n\nBody` }] } });
  assert.deepEqual(await classify([paired[0], oversized]), { pending: 'CLIENT_CONTRACT_PATH_LIMIT' });
  // Text alone has no native selected skill/companion proof.
  assert.equal(await classify([paired[0], answer('ordinary')]), null);
});

test('Codex periodic collection stops at selected native untrack before subsequent ordinary rows', async () => {
  const ordinary = id => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: sessionId, turn_id: id,
    item: { type: 'UserMessage', id: `human:${id}`, content: [typed(`Ordinary ${id}`)] } } });
  const reply = id => ({ type: 'response_item', payload: { type: 'message', id: `answer:${id}`, role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: `Answer ${id}` }] } });
  const control = codex([skill(), typed('untrack')]);
  const rows = [ordinary('before'), reply('before'), control, reply('control'), ordinary('after'), reply('after')];
  const events = [];
  for await (const event of normalizeTranscript(source(rows), { client: 'codex', sessionId, classifyCommand: classifier('codex') })) events.push(event);
  assert.equal(events.at(-1).reason, 'TRANSCRIPT_UNTRACK_PENDING');
  assert.deepEqual(events.filter(event => event.type === 'part').map(event => event.part.exchangeId), ['human:before']);
  const later = { ...codex([skill(), typed('track')]), payload: { ...codex([skill(), typed('track')]).payload, turn_id: 'later-track',
    item: { ...codex([skill(), typed('track')]).payload.item, id: 'later-track-row' } } };
  const resumed = [];
  for await (const event of normalizeTranscript(source([...rows, later]), { client: 'codex', sessionId,
    checkpoint: events.at(-1).checkpoint, beforePromptId: 'later-track', classifyCommand: classifier('codex') })) resumed.push(event);
  assert.deepEqual(resumed.filter(event => event.type === 'part').map(event => event.part.exchangeId), ['human:after']);
});
