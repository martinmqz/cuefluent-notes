import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { runProcessingControlServer, processingControlStatusView, processingControlRefusalText, reviewPathLink,
  PROCESSING_STATUS_DETAILS, PROCESSING_REVIEW_OUTCOMES, PROCESSING_REFUSAL_CODES, PROCESSING_CAPTURE_OUTCOMES, COLLECTION_STOP_CODES } from './processing-control-server.mjs';
import { collectionHookOutput } from './collection-hooks.mjs';
import { PROCESSING_SCOPES } from './workflow-values.mjs';
import MarkdownIt from 'markdown-it';
import { withReviewPreview } from './test-support/processing-review.mjs';

const sessionId = randomUUID(), unitId = randomUUID(), chatId = randomUUID();
const codexMeta = () => ({ callId: 'call_fixture', itemId: 'fc_fixture', sessionId, threadId: sessionId,
  'x-codex-turn-metadata': { session_id: sessionId, thread_id: sessionId, turn_id: unitId, model: 'fixture' } });
const claudeMeta = () => ({ 'claudecode/toolUseId': 'toolu_fixture', progressToken: 2 });
const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
function tool(name, args, meta = codexMeta()) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: meta } };
}
async function server(messages, overrides = {}) {
  const calls = [], output = [];
  const source = Object.freeze({ syntheticOpaqueAuthority: true });
  const input = Readable.from(messages.map(value => typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`));
  await runProcessingControlServer({ client: 'codex', input,
    output: new Writable({ write(chunk, _encoding, done) { output.push(Buffer.from(chunk)); done(); } }), env: {},
    resolveSource: async (context, invocation) => { calls.push({ type: 'resolve', context, invocation }); return source; },
    getStatus: async args => { calls.push({ type: 'status', args }); return { status: 'idle', nextAction: 'inspect', chat: { client: 'codex', sessionId: chatId } }; },
    requestProcessing: async args => { calls.push({ type: 'request', args }); return { status: 'busy', nextAction: 'wait', requestId: args.requestId, chat: { client: 'codex', sessionId: chatId } }; },
    ...overrides });
  return { calls, source, rows: Buffer.concat(output).toString('utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value)) };
}
const view = row => JSON.parse(row.result.content[0].text);

test('bookkeeping that needs the written reply runs only after the write succeeded', async () => {
  for (const fails of [false, true]) {
    const order = [];
    let failed = false;
    // Only the server's write(bytes, done) is used; this one can fail the tool reply once.
    const output = { write(bytes, done) {
      const row = JSON.parse(bytes);
      if (fails && !failed && row.id === 1 && row.result) { failed = true; done?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); return false; }
      order.push(row.error ? 'error reply' : `reply ${row.id}`); done?.(); return true;
    } };
    await server([initialize, tool('processing_status', { collectionId: 'example' })], { output,
      afterResponse: async () => { order.push('checked'); }, afterDelivery: async () => { order.push('delivered'); } });
    assert.deepEqual(order, fails ? ['reply 0', 'checked', 'error reply'] : ['reply 0', 'checked', 'reply 1', 'delivered']);
  }
});

test('source adapter exposes explicit versioned tools without save, approval or arbitrary execution', async () => {
  const result = await server([initialize, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.equal(result.rows[0].result.serverInfo.name, 'cuefluent_control');
  const tools = result.rows[1].result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['processing_status', 'process_selected_captures', 'processing_resume', 'processing_cancel',
    'capture_turns', 'pause_capture', 'resume_capture', 'processing_review']);
  // The chat capture commands take no fields of their own.
  for (const tool of tools.slice(4, 7)) assert.deepEqual(Object.keys(tool.inputSchema.properties), ['collectionId', 'retryToken']);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tools[0].annotations.readOnlyHint, true); assert.equal(tools[1].annotations.readOnlyHint, false);
  assert.equal(tools[1].inputSchema.properties.selection.additionalProperties, false);
  assert.deepEqual(Object.keys(tools[2].inputSchema.properties), ['collectionId', 'retryToken']);
  assert.equal(result.calls.length, 0);
});

test('native source refusals identify only the exact Codex source, never a Claude fallback candidate', async () => {
  for (const client of ['codex', 'claude']) for (const code of ['UNSUPPORTED_SESSION_OWNERSHIP', 'UNSUPPORTED_CODEX_HISTORY', 'SOURCE_IDENTITY_MISMATCH']) {
    const result = await server([initialize, tool('processing_status', {}, client === 'codex' ? codexMeta() : claudeMeta())], {
      client, env: { CLAUDE_CODE_SESSION_ID: sessionId },
      resolveSource: async () => { throw Object.assign(new Error('Private source detail'), { code }); }
    });
    // Claude: the binding failed before any action, so the refusal says that
    // nothing was applied without attributing the failure to this chat.
    const expected = client === 'codex' ? code : 'PROCESSING_CONTROL_SOURCE_UNVERIFIED';
    assert.deepEqual(result.rows[1].error, { code: -32600, data: { code: expected },
      message: processingControlRefusalText(expected, { client, stage: 'binding' }) });
    assert.match(result.rows[1].error.message, /^Cuefluent: Nothing was applied: /);
    assert(!result.rows[1].error.message.includes(code));
    assert.equal(result.calls.length, 0); assert(!JSON.stringify(result.rows).includes('Private source detail'));
  }
});

test('refusals answer in plain text the chat can relay, with the code kept in error data', async () => {
  for (const client of ['codex', 'claude']) {
    const meta = client === 'codex' ? codexMeta : claudeMeta, prefix = client === 'codex' ? '$cuefluent-notes' : '/cuefluent-notes';
    // An unknown failure before the action: nothing applied, never the generic code.
    const binding = await server([initialize, tool('processing_review', {}, meta())], { client, env: { CLAUDE_CODE_SESSION_ID: sessionId },
      resolveSource: async () => { throw new Error('Private failure'); } });
    assert.equal(binding.rows[1].error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    assert.match(binding.rows[1].error.message, /^Cuefluent: Nothing was applied and nothing was saved: this command could not be confirmed in this chat's own record/);
    if (client === 'codex') assert.match(binding.rows[1].error.message, /Type \$, choose cuefluent-notes from the list, then the action/);
    // A failure once the action started never claims that nothing was saved.
    const action = await server([initialize, tool('processing_review', {}, meta())], { client, env: { CLAUDE_CODE_SESSION_ID: sessionId },
      resolveSource: async () => ({ collectionId: 'synthetic' }), requestReview: async () => { throw new Error('Private failure'); } });
    assert.equal(action.rows[1].error.data.code, 'PROCESSING_CONTROL_FAILED');
    assert.equal(action.rows[1].error.message, `Cuefluent: This command stopped before it finished, so it is not certain whether anything changed. Type ${prefix} status to see where things stand before trying again.`);
    // A refusal of a started action that names its cause says only that.
    const client2 = await server([initialize, tool('process_selected_captures', {}, meta())], { client, env: { CLAUDE_CODE_SESSION_ID: sessionId },
      resolveSource: async () => ({ collectionId: 'synthetic' }),
      requestProcessing: async () => { throw Object.assign(new Error('Private failure'), { code: 'PROCESSING_CLIENT_AUTHENTICATION_INVALID' }); } });
    assert.equal(client2.rows[1].error.data.code, 'PROCESSING_CLIENT_AUTHENTICATION_INVALID');
    assert.equal(client2.rows[1].error.message, `Cuefluent: This command was refused: the native client's sign-in or launch settings for processing need attention (see the processing setup in the Cuefluent Notes guide). Type ${prefix} status to see where things stand.`);
    for (const row of [binding.rows[1], action.rows[1], client2.rows[1]]) {
      assert(!/[A-Z]{3,}_[A-Z_]+/.test(row.error.message), row.error.message); assert(!row.error.message.includes('Private failure'));
    }
  }
});

test('a status request in a chat with nothing set up gets the command list; other tools, codes, failed bindings and retries still refuse', async () => {
  const unverified = () => Object.assign(new Error('no binding'), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED', noSource: true });
  for (const client of ['codex', 'claude']) {
    const meta = client === 'codex' ? codexMeta : claudeMeta, prefix = client === 'codex' ? '$cuefluent-notes' : '/cuefluent-notes';
    let hooks = 0;
    const result = await server([initialize, tool('processing_status', client === 'claude' ? { help: true } : {}, meta()),
      { ...tool('processing_review', {}, meta()), id: 2 }], {
      client, env: { CLAUDE_CODE_SESSION_ID: sessionId }, resolveSource: async () => { throw unverified(); },
      unboundStatus: () => ({ status: 'missing', statusDetail: 'unbound', nextAction: 'none', diagnostics: ['PROCESSING_CONTROL_SOURCE_UNVERIFIED'], help: true, commandPrefix: prefix }),
      beforeResponse: async () => { hooks++; }, afterResponse: async () => { hooks++; } });
    const helpRow = result.rows.find(row => row.id === 1), reviewRow = result.rows.find(row => row.id === 2);
    const reply = view(helpRow);
    assert.equal(reply.help, true); assert.equal(reply.statusDetail, 'unbound'); assert.equal(reply.collectionId, null);
    // Help applies nothing, so it does not say so.
    assert(reply.statusText.startsWith(`Cuefluent: This chat has no verified Cuefluent Notes source yet. To set up Cuefluent Notes, type ${prefix} setup.`));
    assert(!reply.statusText.includes('Nothing was applied'));
    assert.deepEqual(reviewRow.error, { code: -32600, data: { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' },
      message: processingControlRefusalText('PROCESSING_CONTROL_SOURCE_UNVERIFIED', { client, stage: 'binding', tool: 'processing_review' }) });
    assert.match(reviewRow.error.message, /^Cuefluent: Nothing was applied and nothing was saved: /);
    assert.equal(result.calls.length, 0); assert.equal(hooks, 0);
  }
  // Another refusal keeps its own code, and without the callback nothing changes.
  const other = await server([initialize, tool('processing_status', {})], {
    resolveSource: async () => { throw Object.assign(new Error('x'), { code: 'PROCESSING_CONTROL_REGISTRATION_UNVERIFIED' }); },
    unboundStatus: () => assert.fail('only an unverified source gets the list') });
  assert.equal(other.rows[1].error.data.code, 'PROCESSING_CONTROL_REGISTRATION_UNVERIFIED');
  const bare = await server([initialize, tool('processing_status', {})], { resolveSource: async () => { throw unverified(); } });
  assert.equal(bare.rows[1].error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  // A failed binding of a source that exists stays visible as its refusal.
  const failed = await server([initialize, tool('processing_status', {})], {
    resolveSource: async () => { throw Object.assign(new Error('x'), { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' }); },
    unboundStatus: () => assert.fail('a failed binding is never answered with the list') });
  assert.equal(failed.rows[1].error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  // A verification retry that cannot bind stays a refusal: the token comes from
  // the same running server, and the retry is a new native call.
  const input = new PassThrough(), waiting = [];
  const output = new Writable({ write(chunk, _encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) waiting.shift()?.(JSON.parse(line));
    done();
  } });
  const next = message => { const row = new Promise(resolve => waiting.push(resolve)); input.write(`${JSON.stringify(message)}\n`); return row; };
  let resolved = 0;
  const running = runProcessingControlServer({ client: 'codex', input, output, env: {},
    resolveSource: async () => { if (resolved++ === 0) return { pending: true }; throw unverified(); },
    getStatus: async () => assert.fail('no status without a source'), requestProcessing: async () => assert.fail('no dispatch'),
    unboundStatus: () => assert.fail('a retry is never answered with the list') });
  await next(initialize);
  const pending = JSON.parse((await next(tool('processing_status', {}))).result.content[0].text);
  assert.equal(pending.status, 'verification-required');
  const retry = tool('processing_status', { retryToken: pending.retryToken }, { ...codexMeta(), callId: 'call_retry', itemId: 'fc_retry' });
  const refused = await next({ ...retry, id: 2 });
  assert.equal(refused.error.code, -32600); assert.equal(refused.error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.equal(resolved, 2);
  input.end(); await running;
});

test('a completed decision keeps its outcome and still says when something needs attention', () => {
  const prefix = '/cuefluent-notes', draft = { code: 't7xb88', path: 'meetings/rollout.md', fileCount: 1 };
  for (const review of ['saved', 'skipped', 'cancelled']) {
    const base = { status: 'completed', statusDetail: 'completed', nextAction: 'inspect', review, commandPrefix: prefix };
    for (const named of [{ draft }, {}]) {
      const flagged = processingControlStatusView({ ...base, ...named, diagnostics: ['PROCESSING_CHAT_CONFLICT'] }, { collectionId: 'example' });
      assert(flagged.statusText.startsWith('Cuefluent: Review completed:'), review);
      if (named.draft) assert(flagged.statusText.includes('draft t7xb88 ("meetings/rollout.md")'), review);
      assert(flagged.statusText.endsWith(`\nSomething needs attention; for details, type ${prefix} status --verbose.`), review);
      assert.doesNotMatch(flagged.statusText, /PROCESSING_/);
      const clean = processingControlStatusView({ ...base, ...named, nextAction: 'none', diagnostics: [] }, { collectionId: 'example' });
      assert(!clean.statusText.includes('needs attention') && !clean.statusText.includes('status --verbose'), review);
    }
  }
});

test('Codex native identity is separate from explicit evidence selection', async () => {
  const requestId = randomUUID(), selected = { client: 'claude', sessionId: randomUUID(), cwd: path.resolve('other-project'), unitId: randomUUID() };
  const result = await server([initialize, tool('process_selected_captures', { collectionId: 'example', requestId, selection: selected })]);
  assert.deepEqual(result.calls[0].context, { client: 'codex', sessionId, unitId, toolCallId: 'call_fixture', itemId: 'fc_fixture' });
  assert.equal(result.calls[1].args.source, result.source);
  assert.deepEqual(result.calls[1].args.selection, selected);
  assert.equal(result.calls[1].args.context.sessionId, sessionId);
  assert.deepEqual(view(result.rows[1]), { interfaceVersion: 1, collectionId: 'example', requestId,
    status: 'busy', chat: { client: 'codex', sessionId: chatId }, nextAction: 'wait', diagnostics: [], statusText: 'Cuefluent processing: busy.' });
});

test('empty tool arguments may be omitted or null without bypassing native source verification', async t => {
  for (const client of ['codex', 'claude']) for (const name of ['processing_status', 'processing_review', 'process_selected_captures']) {
    for (const args of [undefined, null, {}]) await t.test(`${client}/${name}/${JSON.stringify(args)}`, async () => {
      let invocation, reviewed = false;
      const result = await server([{ ...initialize, params: { ...initialize.params, capabilities: { elicitation: { form: {} } } } },
        tool(name, args, client === 'codex' ? codexMeta() : claudeMeta())], {
        client, env: { CLAUDE_CODE_SESSION_ID: sessionId },
        resolveSource: async (_context, value) => { invocation = value; return { collectionId: 'example' }; },
        requestReview: async () => { reviewed = true; return { status: 'awaiting-review', nextAction: 'review' }; }
      });
      assert.deepEqual(invocation.arguments, {});
      assert.equal(view(result.rows[1]).collectionId, 'example');
      assert.equal(reviewed, name === 'processing_review');
    });
  }
  const refused = await server([initialize, tool('processing_status', undefined)], { resolveSource: async () => null });
  assert.equal(refused.rows[1].error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  for (const args of [[], '', false, 0]) {
    const invalid = await server([initialize, tool('processing_status', args)]);
    assert.equal(invalid.rows[1].error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST');
    assert.equal(invalid.calls.length, 0);
  }
});

test('Claude native launch identity combines with tool metadata and never uses argument identity', async () => {
  const result = await server([initialize, tool('processing_status', { collectionId: 'example' }, claudeMeta())],
    { client: 'claude', env: { CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.deepEqual(result.calls[0].context, { client: 'claude', sessionId, toolCallId: 'toolu_fixture' });
  assert.equal(result.calls[1].type, 'status'); assert.equal(view(result.rows[1]).status, 'idle');
});

test('missing or inconsistent native identities refuse callbacks', async t => {
  const wrongId = randomUUID();
  for (const [name, client, env, meta] of [
    ['no metadata', 'codex', {}, null],
    ['no native turn metadata', 'codex', {}, { callId: 'call', itemId: 'item' }],
    ['thread mismatch', 'codex', {}, { ...codexMeta(), threadId: wrongId }],
    ['nested thread mismatch', 'codex', {}, { ...codexMeta(), 'x-codex-turn-metadata': { session_id: sessionId, thread_id: wrongId, turn_id: unitId } }],
    ['no item', 'codex', {}, { ...codexMeta(), itemId: undefined }],
    ['mixed client metadata', 'codex', {}, { ...codexMeta(), ...claudeMeta() }],
    ['no launch identity', 'claude', {}, claudeMeta()],
    ['invalid launch identity', 'claude', { CLAUDE_CODE_SESSION_ID: 'latest' }, claudeMeta()],
    ['foreign metadata', 'claude', { CLAUDE_CODE_SESSION_ID: sessionId }, codexMeta()]
  ]) await t.test(name, async () => {
    const result = await server([initialize, tool('processing_status', { collectionId: 'example' }, meta)], { client, env });
    assert.equal(result.rows[1].error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(result.calls.length, 0);
  });
});

test('request schema rejects serialized authority, configuration, model and approval fields', async t => {
  for (const patch of [{ source: { sessionId } }, { _meta: codexMeta() }, { approved: true }, { model: 'model' }, { configPath: '/private' },
    { prompt: 'invent a new task' }, { selection: { client: 'codex', sessionId, cwd: path.resolve('fixture'), proven: true } },
    { selection: { client: 'codex', sessionId, cwd: 'relative' } }]) await t.test(Object.keys(patch)[0], async () => {
    const result = await server([initialize, tool('process_selected_captures', { collectionId: 'example', requestId: randomUUID(), ...patch })]);
    assert.equal(result.rows[1].error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST'); assert.equal(result.calls.length, 0);
  });
});

test('Claude mirrors a typed status --verbose or help in status arguments; Codex refuses those fields', async () => {
  const listed = await server([initialize, { jsonrpc: '2.0', id: 1, method: 'tools/list' }], { client: 'claude', env: { CLAUDE_CODE_SESSION_ID: sessionId } });
  assert.deepEqual(Object.keys(listed.rows[1].result.tools[0].inputSchema.properties).sort(), ['collectionId', 'help', 'retryToken', 'verbose']);
  assert.deepEqual(listed.rows[1].result.tools.find(item => item.name === 'processing_review').inputSchema.properties.decision.enum, ['save', 'skip', 'cancel']);
  const codexListed = await server([initialize, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.deepEqual(Object.keys(codexListed.rows[1].result.tools[0].inputSchema.properties), ['collectionId', 'retryToken']);
  for (const args of [{ verbose: true }, { help: true }]) {
    const claude = await server([initialize, tool('processing_status', { collectionId: 'example', ...args }, claudeMeta())], { client: 'claude', env: { CLAUDE_CODE_SESSION_ID: sessionId } });
    assert.deepEqual(claude.calls[1].args.verbose ?? claude.calls[1].args.help, true); assert.equal(claude.rows[1].error, undefined);
    assert.deepEqual(claude.calls[0].invocation.arguments, { collectionId: 'example', ...args });
    const codex = await server([initialize, tool('processing_status', { collectionId: 'example', ...args })]);
    assert.equal(codex.rows[1].error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST'); assert.equal(codex.calls.length, 0);
  }
  for (const args of [{ verbose: false }, { help: false }, { verbose: true, help: true }, { verbose: 'yes' }, { decision: 'later' }]) {
    const name = args.decision ? 'processing_review' : 'processing_status';
    const refused = await server([initialize, tool(name, { collectionId: 'example', ...args }, claudeMeta())], { client: 'claude', env: { CLAUDE_CODE_SESSION_ID: sessionId } });
    assert.equal(refused.rows[1].error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST', JSON.stringify(args)); assert.equal(refused.calls.length, 0);
  }
});

test('unverified source cannot dispatch and pure status never invokes processing', async () => {
  const refused = await server([initialize, tool('process_selected_captures', { collectionId: 'example', requestId: randomUUID() })], { resolveSource: async () => null });
  assert.equal(refused.rows[1].error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(refused.calls.length, 0);
  const status = await server([initialize, tool('processing_status', { collectionId: 'example' })]);
  assert.deepEqual(status.calls.map(call => call.type), ['resolve', 'status']);
});

test('result projection drops private evidence and callback prose and builds stable status text', async () => {
  const result = await server([initialize, tool('processing_status', { collectionId: 'example' })], {
    getStatus: async () => ({ status: 'awaiting-review', nextAction: 'review', chat: { client: 'claude', sessionId: chatId, evidence: 'secret' },
      evidence: 'secret', output: 'secret', statusText: 'secret', path: '/private/secret', diagnostics: ['PROCESSING_APPROVAL_REQUIRED'] })
  });
  assert.ok(!JSON.stringify(result.rows).includes('secret'));
  // Codes stay in the fields; the visible text says where to see them.
  assert.equal(view(result.rows[1]).statusText, 'Cuefluent processing: awaiting-review.\n\nFor details, type status --verbose.');
  assert.deepEqual(view(result.rows[1]).diagnostics, ['PROCESSING_APPROVAL_REQUIRED']);
});

test('review outcomes are projected separately from draft state and replay unchanged', () => {
  const pending = { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' }, command = '/cuefluent-notes';
  const named = { code: 't7xb88', path: 'notes/launch.md', fileCount: 2 };
  for (const [value, text] of [
    [{ ...pending, review: 'deferred' }, 'Cuefluent: Review deferred with Later. The draft remains pending; nothing was saved.'],
    [{ ...pending, review: 'declined' }, 'Cuefluent: Review not completed: the client declined or closed the review form, which may not have been displayed. The draft remains pending; nothing was saved.'],
    [{ ...pending, review: 'display-altered' }, 'Cuefluent: Review not completed: the form did not return its preview unchanged (it may have been empty, shortened or edited), so the complete proposal may not have been readable. Nothing was saved, skipped or cancelled; the draft remains pending.'],
    [{ ...pending, review: 'unavailable', diagnostics: ['PROCESSING_REVIEW_UNSUPPORTED'] }, 'Cuefluent: Review unavailable: this client did not report review form support. The draft remains pending; nothing was saved.\n\nFor details, type status --verbose.'],
    [{ status: 'idle', statusDetail: 'inactive', nextAction: 'none', review: 'saved' }, 'Cuefluent: Review completed: the exact reviewed proposal was saved. No processing run is active.'],
    // A code-mode decision's exclusion notice alone needs no attention.
    [{ status: 'idle', statusDetail: 'inactive', nextAction: 'none', review: 'saved', diagnostics: ['PROCESSING_EXCLUSION_UNVERIFIED'] },
      'Cuefluent: Review completed: the exact reviewed proposal was saved. No processing run is active.'],
    [{ status: 'idle', statusDetail: 'inactive', nextAction: 'none', review: 'saved', diagnostics: ['PROCESSING_EXCLUSION_UNVERIFIED', 'PROCESSING_CHAT_CONFLICT'] },
      'Cuefluent: Review completed: the exact reviewed proposal was saved. No processing run is active.\n\nSomething needs attention; for details, type status --verbose.'],
    // A completed review can leave another draft pending; say both.
    [{ ...pending, review: 'skipped' }, 'Cuefluent: Review completed: these captured turns were skipped without saving. Draft ready for review.'],
    [{ status: 'completed', statusDetail: 'completed', nextAction: 'inspect', diagnostics: ['PROCESSING_CHAT_CONFLICT'], review: 'cancelled' },
      'Cuefluent: Review completed: the operation was cancelled; its captured turns remain pending. Processing operation completed.\n\nSomething needs attention; for details, type status --verbose.'],
    // A decided draft is named by its code and note path.
    [{ status: 'idle', statusDetail: 'inactive', nextAction: 'none', review: 'saved', commandPrefix: command, draft: named },
      'Cuefluent: Review completed: the exact reviewed proposal of draft t7xb88 ("notes/launch.md" and 1 more file) was saved. No processing run is active.'],
    [{ ...pending, review: 'skipped', commandPrefix: '$cuefluent-notes', draft: { ...named, fileCount: 1 } },
      'Cuefluent: Review completed: the captured turns of draft t7xb88 ("notes/launch.md") were skipped without saving. Draft ready for review.'],
    // A named draft never hides that something else needs attention.
    [{ status: 'completed', statusDetail: 'completed', nextAction: 'inspect', diagnostics: ['PROCESSING_CHAT_CONFLICT'], review: 'cancelled', commandPrefix: command, draft: { code: 't7xb88' } },
      'Cuefluent: Review completed: the operation for draft t7xb88 was cancelled; its captured turns remain pending. Processing operation completed.\n\nSomething needs attention; for details, type /cuefluent-notes status --verbose.'],
  ]) {
    const projected = processingControlStatusView(value, { collectionId: 'example' });
    assert.equal(projected.statusText, text); assert.equal(projected.review, value.review);
    // Response receipts require a canonical, idempotent projection.
    assert.deepEqual(processingControlStatusView(projected, { collectionId: 'example' }), projected);
  }
  assert.equal(processingControlStatusView(pending, { collectionId: 'example' }).statusText, 'Cuefluent: Draft ready for review.');
});

test('review folder replies are bounded, escaped, canonical and omit diagnostic codes', () => {
  const pending = { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review', diagnostics: ['PROCESSING_EXCLUSION_UNVERIFIED'] };
  const folder = path.resolve('private-state', 'review', 't7xb88'), command = '/cuefluent-notes';
  const draft = { code: 't7xb88', folder, fileCount: 7, files: Array.from({ length: 5 }, (_, index) => ({
    path: `meetings/${index ? 'note' : 'forged Saved.‮'}${index}.md`, bytes: 12 + index, change: index ? 'create' : 'update' })) };
  const drafts = [{ code: 'k2mn9p', path: 'meetings/other.md', fileCount: 2 }, { code: 'm3np4q', path: 'meetings/third.md', fileCount: 1 }];
  const presented = processingControlStatusView({ ...pending, review: 'presented', commandPrefix: command, draft, drafts }, { collectionId: 'example' });
  const url = file => pathToFileURL(file).href, folderUrl = `${url(folder)}/`;
  // Markdown blocks, the folder as a one-click file link.
  assert.equal(presented.statusText, ['Cuefluent: Draft t7xb88 ("meetings/forged\\u2028Saved.\\u202e0.md" and 6 more files) is ready for review; nothing has been saved.',
    `Review folder: <${folderUrl}>`,
    ['- "meetings/forged\\u2028Saved.\\u202e0.md" (update, 12 bytes)', ...[1, 2, 3, 4].map(index => `- "meetings/note${index}.md" (new note, ${12 + index} bytes)`),
      '- and 2 more files listed in summary.txt'].join('\n'),
    `To decide, type ${command} save t7xb88 or ${command} skip t7xb88.`,
    ['Other drafts:', '', '- k2mn9p "meetings/other.md" (+1 more)', '- m3np4q "meetings/third.md"'].join('\n')].join('\n\n'));
  assert.deepEqual(presented.diagnostics, ['PROCESSING_EXCLUSION_UNVERIFIED']);
  assert.deepEqual(processingControlStatusView(presented, { collectionId: 'example' }), presented);
  // Each file with its copy in the folder links to that copy as well.
  const linked = processingControlStatusView({ ...pending, review: 'presented', commandPrefix: command,
    draft: { ...draft, files: draft.files.map((file, index) => ({ ...file, review: `${index + 1}-proposed.md` })) } }, { collectionId: 'example' });
  assert(linked.statusText.includes(`- "meetings/note1.md" (new note, 13 bytes): <${url(path.join(folder, '2-proposed.md'))}>`));
  assert.deepEqual(processingControlStatusView(linked, { collectionId: 'example' }), linked);
  // A folder whose links would not fit falls back to the plain path, still bounded.
  // Long folders start at the filesystem root, so their length never depends on the checkout's.
  const rooted = (...parts) => path.join(path.parse(process.cwd()).root, ...parts);
  const deep = rooted('private-state', ...Array.from({ length: 12 }, () => '\u00e9'.repeat(30)), 'review', 't7xb88');
  const fallback = processingControlStatusView({ ...pending, review: 'presented', commandPrefix: command,
    draft: { ...draft, folder: deep, files: draft.files.map((file, index) => ({ ...file, review: `${index + 1}-proposed.md` })) } }, { collectionId: 'example' });
  assert(fallback.statusText.includes(`Review folder: <${url(deep)}/>`)); assert(!fallback.statusText.includes('-proposed.md>'));
  assert(Buffer.byteLength(fallback.statusText) <= 4096);
  const deeper = rooted('private-state', 'é'.repeat(250), 'é'.repeat(200), 'review', 't7xb88');
  const long = Array.from({ length: 4 }, (_, index) => ({ code: `k2mn9${index + 2}`, path: `notes/${'é'.repeat(150)}.md`, fileCount: 1 }));
  const plainPath = processingControlStatusView({ ...pending, review: 'presented', commandPrefix: command,
    draft: { ...draft, folder: deeper, files: draft.files.map((file, index) => ({ ...file, review: `${index + 1}-proposed.md` })) }, drafts: long }, { collectionId: 'example' });
  assert(plainPath.statusText.includes(`Review folder: \`${deeper}\`\n`)); assert(!plainPath.statusText.includes('file://'));
  assert(Buffer.byteLength(plainPath.statusText) <= 4096);
  // A link percent-encodes spaces and angle brackets, so it cannot end early.
  const odd = path.resolve('private state', 'a>b', 't7xb88');
  const spaced = processingControlStatusView({ ...pending, review: 'presented', commandPrefix: command, draft: { ...draft, folder: odd } }, { collectionId: 'example' });
  assert(spaced.statusText.includes(`<${url(odd)}/>`)); assert(!/<file:[^>]* /.test(spaced.statusText));
  const named = { code: 't7xb88', path: 'meetings/launch.md', fileCount: 1 };
  for (const [value, text] of [
    [{ ...pending, review: 'not-shown', commandPrefix: command, draft: { code: 't7xb88' } },
      `Cuefluent: Nothing was applied: draft t7xb88 has not been shown in this chat by a typed review. Read it first with ${command} review t7xb88.`],
    [{ ...pending, review: 'not-shown', commandPrefix: command, draft: named },
      `Cuefluent: Nothing was applied: draft t7xb88 ("meetings/launch.md") has not been shown in this chat by a typed review. Read it first with ${command} review t7xb88.`],
    [{ ...pending, review: 'unverified', commandPrefix: command, draft: named },
      `Cuefluent: Nothing was applied to draft t7xb88 ("meetings/launch.md"): a review decision counts only when you type the exact command yourself, for example ${command} save t7xb88.`],
    // Codex says how to type a command that counts: pick the skill from its list.
    [{ ...pending, review: 'unverified', commandPrefix: '$cuefluent-notes' },
      'Cuefluent: Nothing was applied: a review decision counts only when you type the exact command yourself, for example $cuefluent-notes save <draft code>. In Codex, type $ and choose cuefluent-notes from the list, then the action; the mention typed out by hand is not a command.'],
    // A refusal names the cause that applied, with its next step.
    [{ ...pending, review: 'changed', reason: 'changed', commandPrefix: command, draft: named, drafts },
      [`Cuefluent: Nothing was applied: draft t7xb88 ("meetings/launch.md") changed after this chat was shown it. Review the current draft with ${command} review before deciding.`,
        ['Pending drafts:', '', '- k2mn9p "meetings/other.md" (+1 more)', '- m3np4q "meetings/third.md"'].join('\n')].join('\n\n')],
    [{ ...pending, review: 'changed', reason: 'destination', commandPrefix: command, draft: named },
      `Cuefluent: Nothing was applied: a note at the destination of draft t7xb88 ("meetings/launch.md") changed after the draft was prepared. Restore that note, or process again for a new draft, then review it with ${command} review.`],
    [{ ...pending, review: 'changed', reason: 'not-pending', commandPrefix: command, draft: { code: 't7xb88' }, drafts },
      [`Cuefluent: Nothing was applied: draft t7xb88 is not pending. Review the current draft with ${command} review before deciding.`,
        ['Pending drafts:', '', '- k2mn9p "meetings/other.md" (+1 more)', '- m3np4q "meetings/third.md"'].join('\n')].join('\n\n')],
    [{ status: 'idle', nextAction: 'none', review: 'changed', reason: 'not-pending', commandPrefix: command, draft: { code: 't7xb88' } },
      'Cuefluent: Nothing was applied: draft t7xb88 is not pending.'],
    [{ ...pending, review: 'changed', reason: 'stale', commandPrefix: '$cuefluent-notes', draft: named },
      'Cuefluent: Nothing was applied: draft t7xb88 ("meetings/launch.md") needs a fresh review in this chat. Read it again with $cuefluent-notes review t7xb88.'],
    // A stored reply without a cause keeps its wording.
    [{ ...pending, review: 'changed', commandPrefix: command, draft: named },
      `Cuefluent: Nothing was applied: draft t7xb88 ("meetings/launch.md") changed, its destination changed, or it is no longer pending. Review the current draft with ${command} review before deciding. If a note changed, restore it or process again.`],
    [{ status: 'idle', nextAction: 'none', review: 'unresolved', commandPrefix: '$cuefluent-notes', drafts: [] },
      'Cuefluent: Nothing was applied: name the draft to decide on, as in $cuefluent-notes save <draft code>, after reading it with $cuefluent-notes review <draft code>.\n\nNo drafts are pending.'],
    [{ ...pending, review: 'unresolved', commandPrefix: command, drafts },
      [`Cuefluent: Nothing was applied: name the draft to decide on, as in ${command} save <draft code>, after reading it with ${command} review <draft code>.`,
        ['Pending drafts:', '', '- k2mn9p "meetings/other.md" (+1 more)', '- m3np4q "meetings/third.md"'].join('\n')].join('\n\n')],
    [{ ...pending, review: 'deferred', commandPrefix: command, draft: { code: 't7xb88' } }, 'Cuefluent: Review deferred with Later. Draft t7xb88 remains pending; nothing was saved.'],
    // Codex links the folder the way its model writes a local link.
    [{ ...pending, review: 'declined', commandPrefix: '$cuefluent-notes', draft },
      ['Cuefluent: Review not completed: the client declined or closed the review form, which may not have been displayed. Draft t7xb88 ("meetings/forged\\u2028Saved.\\u202e0.md" and 6 more files) remains pending; nothing was saved.',
        // A path Codex cannot link, such as a Windows path, is a code span.
        `Review folder: ${reviewPathLink('$cuefluent-notes', folder, { folder: true }) ?? `\`${folder}\``}`, 'To decide, type $cuefluent-notes save t7xb88 or $cuefluent-notes skip t7xb88.'].join('\n\n')],
  ]) {
    const projected = processingControlStatusView(value, { collectionId: 'example' });
    assert.equal(projected.statusText, text); assert.deepEqual(processingControlStatusView(projected, { collectionId: 'example' }), projected);
  }
  // Each outcome carries exactly its own fields, with a known command spelling.
  for (const value of [{ ...pending, review: 'presented', commandPrefix: command, draft: { code: 't7xb88' } },
    { ...pending, review: 'presented', commandPrefix: command, draft: named },
    { ...pending, review: 'presented', draft }, { ...pending, review: 'presented', commandPrefix: '/cuefluent-notes:cuefluent-notes', draft },
    { ...pending, review: 'not-shown', commandPrefix: command, draft },
    { ...pending, review: 'unresolved', commandPrefix: command },
    { ...pending, review: 'saved', commandPrefix: command, draft },
    { ...pending, review: 'deferred', draft: { code: 't7xb88' } },
    { ...pending, review: 'changed', commandPrefix: command, draft: { code: 'T7XB88' } },
    { ...pending, review: 'not-shown', commandPrefix: command, draft: { ...named, fileCount: 0 } },
    { ...pending, review: 'not-shown', commandPrefix: command, draft: { code: 't7xb88', path: 'a.md' } },
    { ...pending, review: 'presented', commandPrefix: command, draft: { ...draft, files: draft.files.slice(0, 4) } },
    { ...pending, review: 'presented', commandPrefix: command, draft: { ...draft, folder: 'relative/review' } },
    { ...pending, review: 'presented', commandPrefix: command, draft: { ...draft, files: [{ ...draft.files[0], path: 'é'.repeat(300) }, ...draft.files.slice(1)] } },
    { ...pending, review: 'unresolved', commandPrefix: command, drafts: Array.from({ length: 5 }, (_, index) => ({ code: `k2mn9${index + 2}`, path: 'a.md', fileCount: 1 })) },
    { ...pending, review: 'unresolved', commandPrefix: command, drafts: [{ ...drafts[0], operationId: randomUUID(), proposalHash: 'a'.repeat(64), claimHash: 'b'.repeat(64) }] },
    { ...pending, review: 'saved', commandPrefix: command, verbose: true },
    { ...pending, review: 'changed', reason: 'gone', commandPrefix: command, draft: named },
    { ...pending, review: 'not-shown', reason: 'changed', commandPrefix: command, draft: named },
    { ...pending, review: 'presented', commandPrefix: command, draft: { ...draft, files: [{ ...draft.files[0], review: '../summary.txt' }, ...draft.files.slice(1)] } },
    { ...pending, review: 'presented', commandPrefix: command, draft: { ...draft, files: [{ ...draft.files[0], review: 'current.md' }, ...draft.files.slice(1)] } },
  ]) assert.throws(() => processingControlStatusView(value, { collectionId: 'example' }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
});

test('Codex replies link local paths the way its model writes them; Claude keeps one-click file URLs', () => {
  const codex = '$cuefluent-notes', claude = '/cuefluent-notes', md = new MarkdownIt();
  // What CommonMark (markdown-it) reads as links in a text: [label, decoded destination].
  const links = text => md.parse(text, {}).filter(token => token.type === 'inline').flatMap(token => token.children)
    .flatMap((token, index, all) => token.type === 'link_open' ? [[all[index + 1].content, decodeURIComponent(token.attrGet('href'))]] : []);
  // `[name](/abs/path)` with the last segment as its name, a folder with its
  // trailing slash, angle brackets around a path with spaces or parentheses.
  // Lexical, so the same on every platform.
  for (const [target, folder, link] of [
    ['/private/state/review/t7xb88', true, '[t7xb88](/private/state/review/t7xb88/)'],
    ['/private/state/review/t7xb88/', true, '[t7xb88](/private/state/review/t7xb88/)'],
    ['/private/state/review/t7xb88/proposed.md', false, '[proposed.md](/private/state/review/t7xb88/proposed.md)'],
    ['/private/state/review/t7xb88/2-proposed.md', false, '[2-proposed.md](/private/state/review/t7xb88/2-proposed.md)'],
    ['/Users/zo\u00eb/state/review/t7xb88', true, '[t7xb88](/Users/zo\u00eb/state/review/t7xb88/)'],
    ['/Users/x/Library/Application Support/Cuefluent Notes/review/t7xb88', true,
      '[t7xb88](</Users/x/Library/Application Support/Cuefluent Notes/review/t7xb88/>)'],
    ['/srv/state (copy)/review/t7xb88/proposed.md', false, '[proposed.md](</srv/state (copy)/review/t7xb88/proposed.md>)'],
    ['/srv/state)/review/t7xb88', true, '[t7xb88](</srv/state)/review/t7xb88/>)'],
  ]) {
    const destination = folder ? target.replace(/\/?$/, '/') : target;
    assert.equal(reviewPathLink(codex, target, { folder }), link, target);
    assert.deepEqual(links(`Review folder: ${link}`), [[destination.split('/').filter(Boolean).at(-1), destination]], target);
  }
  // A path CommonMark would end, escape or decode, or that is not a POSIX
  // absolute path (a Windows path has backslashes), is shown without a link.
  for (const target of ['C:\\Users\\x\\review\\t7xb88', '\\\\server\\share\\review\\t7xb88', 'relative/review/t7xb88', '//server/review/t7xb88',
    '/a/b<c/review/t7xb88', '/a/b>c/review/t7xb88', '/a/b\\c/review/t7xb88', '/a/b&amp;c/review/t7xb88', '/a/b%20c/review/t7xb88', '/a/b`c/review/t7xb88',
    '/a/b\tc/review/t7xb88', '/a/b\nc/review/t7xb88', '/a/b\u00a0c/review/t7xb88', '/a/b\u2028c/review/t7xb88', '/a/b\u202ec/review/t7xb88', '/a/b\u0085c/review/t7xb88',
    '/', '/a/review/t7 xb88', '/a/review/[x]', '/a/review/..']) {
    assert.equal(reviewPathLink(codex, target, { folder: true }), null, JSON.stringify(target));
  }
  // Claude: a percent-encoded file URL autolink, which cannot end early.
  const native = path.resolve(path.sep, 'private state', 'a>b', 't7xb88');
  assert.equal(reviewPathLink(claude, native, { folder: true }), `<${pathToFileURL(native).href}/>`);
  assert.equal(reviewPathLink(claude, path.join(native, 'proposed.md')), `<${pathToFileURL(path.join(native, 'proposed.md')).href}>`);

  // Codex replies: the folder and each file's proposed copy in that form, a
  // blank line before every list and `code path` listings. A file path is
  // joined natively, so on Windows only the folder is linked here.
  const pending = { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' };
  const folder = '/private/state/review/t7xb88', spaced = '/Users/x/Library/Application Support/Cuefluent Notes/review/t7xb88';
  const fileLink = (dir, name) => path.sep === '/' ? `: ${reviewPathLink(codex, `${dir}/${name}`)}` : '';
  const draft = dir => ({ code: 't7xb88', folder: dir, fileCount: 2, files: [{ path: 'meetings/rollout.md', bytes: 120, change: 'create', review: '1-proposed.md' },
    { path: 'decisions/cache.md', bytes: 80, change: 'update', review: '2-proposed.md' }] });
  const drafts = [{ code: 'k2mn9p', path: 'meetings/other.md', fileCount: 1 }, { code: 'm3np4q', path: 'meetings/third.md', fileCount: 3 }];
  const view = value => processingControlStatusView(value, { collectionId: 'example' });
  for (const [value, text] of [
    [{ ...pending, review: 'presented', commandPrefix: codex, draft: draft(folder), drafts }, [
      'Cuefluent: Draft t7xb88 ("meetings/rollout.md" and 1 more file) is ready for review; nothing has been saved.',
      'Review folder: [t7xb88](/private/state/review/t7xb88/)',
      [`- "meetings/rollout.md" (new note, 120 bytes)${fileLink(folder, '1-proposed.md')}`, `- "decisions/cache.md" (update, 80 bytes)${fileLink(folder, '2-proposed.md')}`].join('\n'),
      'To decide, type $cuefluent-notes save t7xb88 or $cuefluent-notes skip t7xb88.',
      'Other drafts:\n\n- k2mn9p "meetings/other.md"\n- m3np4q "meetings/third.md" (+2 more)'].join('\n\n')],
    // Later, with the default macOS state folder: its spaces need angle brackets.
    [{ ...pending, review: 'deferred', commandPrefix: codex, draft: { ...draft(spaced), fileCount: 1, files: draft(spaced).files.slice(0, 1) } }, [
      'Cuefluent: Review deferred with Later. Draft t7xb88 ("meetings/rollout.md") remains pending; nothing was saved.',
      'Review folder: [t7xb88](</Users/x/Library/Application Support/Cuefluent Notes/review/t7xb88/>)',
      'To decide, type $cuefluent-notes save t7xb88 or $cuefluent-notes skip t7xb88.'].join('\n\n')],
    [{ ...pending, review: 'changed', reason: 'not-pending', commandPrefix: codex, draft: { code: 'a42ksb' }, drafts: drafts.slice(0, 1) },
      'Cuefluent: Nothing was applied: draft a42ksb is not pending. Review the current draft with $cuefluent-notes review before deciding.\n\nPending drafts:\n\n- k2mn9p "meetings/other.md"'],
    [{ ...pending, commandPrefix: codex, drafts },
      'Cuefluent: Draft ready for review.\n\nDrafts awaiting review:\n\n- k2mn9p "meetings/other.md"\n- m3np4q "meetings/third.md" (+2 more)\n\nRead one with $cuefluent-notes review <draft code>.'],
    // A folder Markdown cannot carry is shown as the plain path, and its files without links.
    [{ ...pending, review: 'presented', commandPrefix: codex, draft: draft('/private/a>b/review/t7xb88') }, [
      'Cuefluent: Draft t7xb88 ("meetings/rollout.md" and 1 more file) is ready for review; nothing has been saved.',
      'Review folder: `/private/a>b/review/t7xb88`',
      '- "meetings/rollout.md" (new note, 120 bytes)\n- "decisions/cache.md" (update, 80 bytes)',
      'To decide, type $cuefluent-notes save t7xb88 or $cuefluent-notes skip t7xb88.'].join('\n\n')],
  ]) {
    const projected = view(value);
    assert.equal(projected.statusText, text);
    assert.deepEqual(view(projected), projected);
    // The structured fields keep the native path; only the text changed form.
    if (value.draft?.folder) assert.equal(projected.draft.folder, value.draft.folder);
    assert(!projected.statusText.includes('file://'));
  }
  // The same reply for Claude keeps its file URLs.
  const claudeShown = view({ ...pending, review: 'presented', commandPrefix: claude, draft: draft(folder) }).statusText;
  assert(claudeShown.includes(`Review folder: <${pathToFileURL(folder).href}/>`), claudeShown);
  assert(!claudeShown.includes('](/'));
  // The bound still holds with the longest folder: the file links go first.
  const deep = `/private/${'\u00e9'.repeat(250)}/${'\u00e9'.repeat(200)}/review/t7xb88`;
  const files = Array.from({ length: 5 }, (_, index) => ({ path: `notes/${'\u00e9'.repeat(70)}${index}.md`, bytes: 10, change: 'create', review: `${index + 1}-proposed.md` }));
  const long = view({ ...pending, review: 'presented', commandPrefix: codex, draft: { code: 't7xb88', folder: deep, fileCount: 5, files },
    drafts: Array.from({ length: 4 }, (_, index) => ({ code: `k2mn9${index + 2}`, path: `notes/${'\u00e9'.repeat(150)}.md`, fileCount: 1 })) });
  assert(long.statusText.includes(`Review folder: [t7xb88](${deep}/)\n`)); assert(!long.statusText.includes('-proposed.md)'));
  assert(Buffer.byteLength(long.statusText) <= 4096);
});

test('a folder shown without a link and every note path render in Markdown exactly as written', () => {
  const md = new MarkdownIt(), codex = '$cuefluent-notes', claude = '/cuefluent-notes';
  // The rendered text of one line, and the inline markup CommonMark found in it.
  const rendered = line => {
    const children = md.parseInline(line, {})[0].children;
    return { text: children.map(token => token.type === 'softbreak' ? '\n' : token.content).join(''),
      markup: children.filter(token => !['text', 'code_inline', 'softbreak'].includes(token.type)).map(token => token.type) };
  };
  const lineOf = (text, start) => text.split('\n').find(line => line.startsWith(start));
  const pending = { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' };
  const view = value => processingControlStatusView(value, { collectionId: 'example' });
  // A folder Codex cannot link is a code span: backslashes before punctuation,
  // a Windows path and backticks inside or at either end stay as written.
  // The server takes only a native absolute folder, so a Windows path is shown on Windows.
  const windows = path.sep === '\\' ? ['C:\\Users\\x\\_drafts\\*copy*\\review\\t7xb88'] : [];
  for (const folder of [...windows, '/private/a\\_b/review/t7xb88', '/private/x\\_drafts\\*copy*/review/t7xb88', '/private/a`b/review/t7xb88',
    '/private/a``b`/review/t7xb88', '/private/review/t7xb88`', '/private/a>b/[x](y)/review/t7xb88', '/private/&amp;/review/t7xb88']) {
    const text = view({ ...pending, review: 'deferred', commandPrefix: codex, draft: { code: 't7xb88', folder, fileCount: 1, files: [{ path: 'a.md', bytes: 1, change: 'create' }] } }).statusText;
    const line = lineOf(text, 'Review folder: '), shown = rendered(line);
    assert.equal(shown.text, `Review folder: ${folder}`, line);
    assert.deepEqual(shown.markup, [], line);
  }
  // So is the folder in a reply too long for links (Claude's percent-encoded
  // file URLs reach that bound first; Codex links the raw path).
  const deeper = path.join(path.parse(process.cwd()).root, 'private_state', '\u00e9'.repeat(250), '*\u00e9*'.repeat(60), 'review', 't7xb88');
  const long = Array.from({ length: 4 }, (_, index) => ({ code: `k2mn9${index + 2}`, path: `notes/${'\u00e9'.repeat(150)}.md`, fileCount: 1 }));
  const files = Array.from({ length: 5 }, (_, index) => ({ path: `notes/${'\u00e9'.repeat(70)}${index}.md`, bytes: 10, change: 'create', review: `${index + 1}-proposed.md` }));
  const tooLong = view({ ...pending, review: 'presented', commandPrefix: claude, draft: { code: 't7xb88', folder: deeper, fileCount: 5, files }, drafts: long }).statusText;
  assert(Buffer.byteLength(tooLong) <= 4096); assert(!tooLong.includes('file://'));
  const shownLong = rendered(lineOf(tooLong, 'Review folder: '));
  assert.equal(shownLong.text, `Review folder: ${deeper}`); assert.deepEqual(shownLong.markup, []);
  // The folder's shown form, fences included, stays within its bound.
  const atBound = `/${'a'.repeat(1021)}`;
  assert.equal(view({ ...pending, review: 'deferred', commandPrefix: claude, draft: { code: 't7xb88', folder: atBound, fileCount: 1, files: [{ path: 'a.md', bytes: 1, change: 'create' }] } }).draft.folder, atBound);
  assert.throws(() => view({ ...pending, review: 'deferred', commandPrefix: claude,
    draft: { code: 't7xb88', folder: `${atBound}a`, fileCount: 1, files: [{ path: 'a.md', bytes: 1, change: 'create' }] } }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
  // A quoted note path renders as written: no emphasis, code, link, image, raw
  // HTML, entity or strikethrough, in every place a reply names a note.
  const notes = ['notes/*b*.md', 'notes/_a_ and __b__.md', 'notes/`c`.md', 'notes/[x](https://example.invalid).md', 'notes/![i](y).md',
    'notes/<b>x</b>.md', 'notes/&amp;.md', 'notes/~~s~~.md', 'notes/a\\_b\\*.md', 'notes/"q".md', 'meetings/juniper-rollout.md'];
  for (const note of notes) {
    for (const commandPrefix of [claude, codex]) {
      const value = view({ ...pending, review: 'presented', commandPrefix,
        draft: { code: 't7xb88', folder: '/private/state/review/t7xb88', fileCount: 1, files: [{ path: note, bytes: 1, change: 'create' }] },
        drafts: [{ code: 'k2mn9p', path: note, fileCount: 1 }] });
      for (const start of ['Cuefluent: Draft t7xb88 (', '- "', '- k2mn9p ']) {
        const shown = rendered(lineOf(value.statusText, start));
        assert(shown.text.includes(`"${note}"`), `${start}: ${shown.text}`);
        assert.deepEqual(shown.markup, [], `${start}: ${note}`);
      }
    }
  }
  // An ordinary path keeps its plain quoted form.
  assert(view({ ...pending, review: 'presented', commandPrefix: codex, draft: { code: 't7xb88', folder: '/private/state/review/t7xb88', fileCount: 1,
    files: [{ path: 'meetings/juniper-rollout.md', bytes: 1, change: 'create' }] } }).statusText.includes('("meetings/juniper-rollout.md")'));
});

test('a typed non-command reply applies nothing, names grammar commands only and carries only its own text', () => {
  const pending = { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review', diagnostics: ['PROCESSING_EXCLUSION_UNVERIFIED'],
    scope: 'repo', inventory: { pending: 3, claimed: 1, blockedByClaim: 0, inspected: 2, handled: 0, incomplete: false, unfinishedOperations: 1, awaitingReview: 1, sourceCompleteness: 'unknown' },
    drafts: [{ code: 'k2mn9p', path: 'a.md', fileCount: 1 }] };
  const claude = '/cuefluent-notes', codex = '$cuefluent-notes';
  for (const [value, text] of [
    [{ ...pending, command: 'not-a-command', suggestions: ['save t7xb88'], commandPrefix: claude },
      `Cuefluent: Nothing was applied: that was not an exact command. Type the command yourself, exactly as written, for example ${claude} save t7xb88.`],
    [{ status: 'idle', nextAction: 'none', command: 'not-a-command', suggestions: ['status', 'review'], commandPrefix: codex },
      `Cuefluent: Nothing was applied: that was not an exact command. Type the command yourself, exactly as written, for example ${codex} status or ${codex} review.`],
    [{ status: 'idle', nextAction: 'none', command: 'not-a-command', suggestions: ['help', 'review', 'status'], commandPrefix: claude },
      `Cuefluent: Nothing was applied: that was not an exact command. Type the command yourself, exactly as written, for example ${claude} help, ${claude} review or ${claude} status.`],
    [{ status: 'idle', nextAction: 'none', command: 'not-a-command', suggestions: ['save <draft code>', 'review', 'setup'], commandPrefix: claude },
      `Cuefluent: Nothing was applied: that was not an exact command. Type the command yourself, exactly as written, for example ${claude} save <draft code>, ${claude} review or ${claude} setup.\n\n` +
      `A draft code has six characters and never contains i, l, o, u, 0, 1; ${claude} review shows the current draft and its code.`],
  ]) {
    const projected = processingControlStatusView(value, { collectionId: 'example' });
    assert.equal(projected.statusText, text); assert.equal(projected.command, 'not-a-command');
    assert.deepEqual(processingControlStatusView(projected, { collectionId: 'example' }), projected);
  }
  // A Codex mention typed out by hand says how to attach the skill, in Codex only.
  const unattached = processingControlStatusView({ ...pending, command: 'skill-not-attached', suggestions: ['save'], commandPrefix: codex }, { collectionId: 'example' });
  assert.equal(unattached.statusText, 'Cuefluent: Nothing was applied: Codex did not attach the Cuefluent Notes skill to that message, so it was not a command. ' +
    `Type $, choose cuefluent-notes from the list, then the action, for example ${codex} save.`);
  assert.deepEqual(processingControlStatusView(unattached, { collectionId: 'example' }), unattached);
  assert.throws(() => processingControlStatusView({ ...pending, command: 'skill-not-attached', suggestions: ['save'], commandPrefix: claude }, { collectionId: 'example' }),
    { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
  // Only grammar commands, code templates or known words, a known spelling, and never a review outcome.
  for (const value of [{ ...pending, command: 'not-a-command', suggestions: ['sav t7xb88'], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: ['save T7XB88'], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: ['review save t7xb88'], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: ['resume'], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: ['Forged: saved.'], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: [], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: ['status', 'status'], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: ['status', 'review', 'process', 'help'], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: ['status'] },
    { ...pending, command: 'not-a-command', suggestions: ['status'], commandPrefix: '/cuefluent-notes:cuefluent-notes' },
    { ...pending, command: 'applied', suggestions: ['status'], commandPrefix: claude },
    { ...pending, command: 'not-a-command', suggestions: ['status'], commandPrefix: claude, review: 'deferred' },
    { ...pending, command: 'not-a-command', suggestions: ['status'], commandPrefix: claude, help: true },
  ]) assert.throws(() => processingControlStatusView(value, { collectionId: 'example' }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
});

test('the command list is built from the grammar in the client spelling and carries only its own text', () => {
  const base = { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review', diagnostics: ['PROCESSING_EXCLUSION_UNVERIFIED'],
    requestId: randomUUID(), chat: { client: 'claude', sessionId: chatId }, scope: 'repo', drafts: [{ code: 'k2mn9p', path: 'a.md', fileCount: 1 }] };
  for (const command of ['/cuefluent-notes', '$cuefluent-notes']) {
    const projected = processingControlStatusView({ ...base, help: true, commandPrefix: command }, { collectionId: 'example' });
    // One Markdown list item per command after a blank line; Codex also says how to attach the skill.
    assert.equal(projected.statusText, [command === '$cuefluent-notes'
      ? 'Cuefluent: Type one of these yourself, exactly as written; for the first word, type $ and choose cuefluent-notes from the list:'
      : 'Cuefluent: Type one of these yourself, exactly as written:', '',
      `- ${command} setup: choose the capture and processing modes.`,
      `- ${command} status: show processing, captured turns and drafts (also: status --verbose).`,
      `- ${command} capture: capture this chat's finished turns since the last capture.`,
      `- ${command} pause chat: stop Automatic capture of this chat from now on.`,
      `- ${command} resume chat: restart Automatic capture of this chat.`,
      `- ${command} process: draft notes from captured turns (also: process repo, process chat, process resume, process cancel).`,
      `- ${command} review: write a pending draft to a private review folder (also: review <draft code>, review cancel, review cancel <draft code>).`,
      `- ${command} save: save the draft your last typed review showed, exactly as shown (also: save <draft code>).`,
      `- ${command} skip: handle that draft's captured turns without saving (also: skip <draft code>).`,
      `- ${command} help: show this list.`].join('\n'));
    assert.equal(projected.help, true);
    assert.deepEqual(processingControlStatusView(projected, { collectionId: 'example' }), projected);
  }
  for (const value of [{ ...base, help: true }, { ...base, help: false, commandPrefix: '/cuefluent-notes' }, { ...base, help: true, verbose: true, commandPrefix: '/cuefluent-notes' },
    { ...base, help: true, review: 'deferred', commandPrefix: '/cuefluent-notes' }]) {
    assert.throws(() => processingControlStatusView(value, { collectionId: 'example' }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
  }
});

test('plain status lists drafts as code and path; status --verbose adds every detail', () => {
  const requestId = randomUUID(), operationId = randomUUID(), command = '/cuefluent-notes';
  const inventory = { pending: 3, claimed: 1, blockedByClaim: 0, inspected: 2, handled: 4, incomplete: true, unfinishedOperations: 1, awaitingReview: 2, sourceCompleteness: 'unknown' };
  const base = { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review', diagnostics: ['PROCESSING_EXCLUSION_UNVERIFIED'],
    requestId, chat: { client: 'codex', sessionId: chatId }, scope: 'repo', inventory, commandPrefix: command };
  const drafts = [{ code: 'k2mn9p', path: 'notes/a.md', fileCount: 1 }, { code: 'm3np4q', path: 'notes/"b" .md', fileCount: 3 }];
  const plain = processingControlStatusView({ ...base, drafts }, { collectionId: 'example' });
  assert.equal(plain.statusText, ['Cuefluent: Draft ready for review. Scope: this repository. Inventory (partial): 3 pending, 1 claimed, 2 drafts awaiting review.',
    ['Drafts awaiting review:', '', '- k2mn9p "notes/a.md"', '- m3np4q "notes/\\"b\\"\\u2028.md" (+2 more)'].join('\n'),
    `Read one with ${command} review <draft code>.`, `For details, type ${command} status --verbose.`].join('\n\n'));
  // One draft is counted in the singular.
  assert.match(processingControlStatusView({ ...base, inventory: { ...inventory, awaitingReview: 1 } }, { collectionId: 'example' }).statusText, / 1 draft awaiting review\./);
  assert.deepEqual(processingControlStatusView(plain, { collectionId: 'example' }), plain);
  const revisions = drafts.map((item, index) => ({ ...item, operationId: index ? randomUUID() : operationId, proposalHash: `${index}`.repeat(64), claimHash: `${index + 2}`.repeat(64) }));
  const verbose = processingControlStatusView({ ...base, verbose: true, drafts: revisions,
    progress: { selected: 2, unattempted: 0, handled: 1, unavailable: 0, cancelled: 0, unfinishedOperations: 1, awaitingReview: 2, incomplete: false } }, { collectionId: 'example' });
  const lines = verbose.statusText.split('\n');
  // Every detail is its own list item; counts are singular where they are one.
  assert.deepEqual(lines.slice(0, 9), ['Cuefluent: Draft ready for review.', '', '- Status: awaiting-review; next action: review.',
    '- Diagnostics: PROCESSING_EXCLUSION_UNVERIFIED.', `- Request: ${requestId}.`, `- Processing chat: codex session ${chatId}.`, '- Scope: this repository.',
    '- Inventory (partial): 3 pending, 1 claimed, 0 blocked by a claim, 2 inspected, 4 handled, 1 unfinished operation, 2 awaiting review.',
    '- Progress: 2 selected, 0 unattempted, 1 handled, 0 unavailable, 0 cancelled, 1 unfinished operation, 2 awaiting review.']);
  assert.deepEqual(lines.slice(9, 13), ['', 'Drafts awaiting review:', '',
    `- k2mn9p "notes/a.md": operation ${operationId}; proposal ${'0'.repeat(64)}; claim ${'2'.repeat(64)}`]);
  assert.equal(verbose.verbose, true); assert.deepEqual(processingControlStatusView(verbose, { collectionId: 'example' }), verbose);
  // Without a detail the first line is the bare status, once.
  assert(processingControlStatusView({ status: 'idle', nextAction: 'none', verbose: true }, { collectionId: 'example' }).statusText
    .startsWith('Cuefluent processing: idle.\n\n- Status: idle; next action: none.\n'));
  // A stopped collection is named in plain words, and by its code only when verbose.
  const stopped = processingControlStatusView({ ...base, collection: { state: 'stopped', code: 'CLAUDE_HISTORY_REQUIRES_REVIEW' } }, { collectionId: 'example' });
  assert(stopped.statusText.includes('\n\nAutomatic capture has stopped for this chat: ')); assert(!stopped.statusText.includes('CLAUDE_HISTORY'));
  assert(processingControlStatusView({ ...base, verbose: true, collection: stopped.collection }, { collectionId: 'example' }).statusText
    .includes('\n- Automatic capture: stopped for this chat (CLAUDE_HISTORY_REQUIRES_REVIEW).'));
  for (const collection of [{ state: 'stopped', code: 'SOURCE_BOUNDARY_PENDING' }, { state: 'paused', code: 'CLAUDE_HISTORY_REQUIRES_REVIEW' },
    { state: 'stopped', code: 'CLAUDE_HISTORY_REQUIRES_REVIEW', path: '/private' }]) {
    assert.throws(() => processingControlStatusView({ ...base, collection }, { collectionId: 'example' }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
  }
  assert.throws(() => processingControlStatusView({ ...base, help: true, collection: stopped.collection }, { collectionId: 'example' }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
  // A capture stopped at a record names the reason, which only that reply carries.
  const blocked = processingControlStatusView({ ...base, capture: 'blocked', reason: 'INVALID_SESSION_RECORD' }, { collectionId: 'example' });
  assert.equal(blocked.reason, 'INVALID_SESSION_RECORD'); assert(!blocked.statusText.includes('INVALID_SESSION'));
  const after = processingControlStatusView({ ...base, capture: 'captured', turns: 1, more: false, reason: 'EVIDENCE_AFTER_CODEX_TERMINAL' }, { collectionId: 'example' });
  assert.match(after.statusText, /^Cuefluent: Captured 1 turn of this chat\. Capture stopped at a record of this chat: .+, so typing \/cuefluent-notes capture cannot capture its later turns\. Type /);
  for (const value of [{ capture: 'blocked' }, { capture: 'blocked', reason: 'SOURCE_BOUNDARY_PENDING' }, { capture: 'stopped', reason: 'INVALID_SESSION_RECORD' },
    { capture: 'captured', turns: 1, more: true, reason: 'INVALID_SESSION_RECORD' }, { capture: 'nothing-new', reason: 'INVALID_SESSION_RECORD' }]) {
    assert.throws(() => processingControlStatusView({ ...base, ...value }, { collectionId: 'example' }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
  }
  // Revisions belong to the verbose reply only, and the verbose reply stays bounded.
  assert.throws(() => processingControlStatusView({ ...base, drafts: revisions }, { collectionId: 'example' }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
  assert.throws(() => processingControlStatusView({ ...base, verbose: true, drafts }, { collectionId: 'example' }), { code: 'PROCESSING_CONTROL_OUTPUT_INVALID' });
  const worst = processingControlStatusView({ ...base, verbose: true, diagnostics: ['PROCESSING_CLIENT_SETTINGS_UNSUPPORTED', 'PROCESSING_CLIENT_AUTHENTICATION_INVALID',
    'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE', 'PROCESSING_OPERATION_OUTCOME_UNKNOWN', 'PROCESSING_CONTROL_SOURCE_UNVERIFIED', 'PROCESSING_CHAT_SESSION_UNAVAILABLE',
    'PROCESSING_REINSPECTION_REQUIRED', 'PROCESSING_CHAT_HOST_UNAVAILABLE'],
    drafts: Array.from({ length: 4 }, (_, index) => ({ code: `k2mn9${index + 2}`, path: '‮'.repeat(170), fileCount: 100, operationId: randomUUID(), proposalHash: 'a'.repeat(64), claimHash: 'b'.repeat(64) })) }, { collectionId: 'example' });
  assert(Buffer.byteLength(worst.statusText) <= 4096);
});

test('visible reply text carries no hash, UUID or diagnostic code outside status --verbose', () => {
  const command = '/cuefluent-notes', folder = path.resolve('private-state', 'review', 't7xb88');
  const ids = { requestId: randomUUID(), chat: { client: 'codex', sessionId: chatId } };
  const diagnostics = ['PROCESSING_EXCLUSION_UNVERIFIED', 'PROCESSING_CHAT_CONFLICT'];
  const inventory = { pending: 3, claimed: 1, blockedByClaim: 0, inspected: 2, handled: 4, incomplete: false, unfinishedOperations: 1, awaitingReview: 1, sourceCompleteness: 'unknown' };
  const draft = { code: 't7xb88', folder, fileCount: 1, files: [{ path: 'notes/a.md', bytes: 5, change: 'create' }] };
  const named = { code: 't7xb88', path: 'notes/a.md', fileCount: 1 }, drafts = [{ code: 'k2mn9p', path: 'notes/b.md', fileCount: 1 }];
  const review = { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review', ...ids, diagnostics, commandPrefix: command };
  const values = [
    { status: 'blocked', statusDetail: 'blocked', nextAction: 'inspect', ...ids, diagnostics, inventory, scope: 'chat', commandPrefix: command },
    { status: 'idle', statusDetail: 'continuation', nextAction: 'resume', ...ids, diagnostics },
    { ...review, drafts, inventory },
    ...['presented', 'declined', 'display-altered', 'deferred'].map(outcome => ({ ...review, review: outcome, draft, ...(outcome === 'presented' ? { drafts } : {}) })),
    ...['not-shown', 'unverified', 'changed'].map(outcome => ({ ...review, review: outcome, draft: named })),
    { ...review, review: 'unresolved', drafts },
    ...['saved', 'skipped', 'cancelled'].map(outcome => ({ status: 'completed', statusDetail: 'completed', nextAction: 'inspect', ...ids, diagnostics, commandPrefix: command, review: outcome, draft: named })),
    ...['saved', 'skipped', 'cancelled'].map(outcome => ({ status: 'completed', statusDetail: 'completed', nextAction: 'inspect', ...ids, diagnostics, review: outcome })),
    { ...review, review: 'unavailable' },
    { ...review, command: 'not-a-command', suggestions: ['help', 'review', 'status'] },
    { ...review, help: true },
  ];
  for (const value of values) {
    const text = processingControlStatusView(value, { collectionId: 'example' }).statusText;
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-|[a-f0-9]{64}|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, `${value.review ?? value.command ?? value.statusDetail}: ${text}`);
  }
});

test('a failing after-commit hook replaces the committed reply with its error', async () => {
  let calls = 0;
  const result = await server([initialize, tool('processing_status', { collectionId: 'example' }), { ...tool('processing_status', { collectionId: 'example' }), id: 2 }], {
    afterResponse: async ({ invocation }) => { if (++calls === 1) throw Object.assign(new Error('private detail'), { code: 'INTAKE_BLOCKED' }); assert.equal(invocation.tool, 'processing_status'); }
  });
  assert.equal(result.rows[1].error.data.code, 'INTAKE_BLOCKED'); assert.equal(result.rows[2].error, undefined);
  assert.equal(view(result.rows[2]).status, 'idle'); assert.equal(calls, 2);
  assert(!JSON.stringify(result.rows).includes('private detail'));
});

test('known processing refusals preserve their safe actionable code', async t => {
  for (const code of ['PROCESSING_CHAT_REVIEW_UNRESOLVED', 'PROCESSING_CHAT_POLICY_CHANGED',
    'PROCESSING_CHAT_STATE_CHANGED', 'INTAKE_BLOCKED', 'PROCESSING_REVIEW_LIMIT']) await t.test(code, async () => {
    const result = await server([initialize, tool('processing_status', { collectionId: 'example' })], {
      getStatus: async () => { throw Object.assign(new Error('private detail'), { code }); }
    });
    assert.equal(result.rows[1].error.data.code, code);
    assert(!JSON.stringify(result.rows).includes('private detail'));
  });
});

test('retired conflict statuses survive MCP projection and transport validation', async t => {
  const { processingStatusView } = await import('./processing-mcp.mjs');
  const status = processingStatusView({ state: 'blocked', chat: null, requestId: null,
    operationState: 'conflicted', diagnostics: ['PROCESSING_OPERATION_CONFLICT'] }, {});
  for (const client of ['codex', 'claude']) for (const name of ['processing_status', 'process_selected_captures', 'processing_resume']) {
    await t.test(`${client}/${name}`, async () => {
      const result = await server([initialize, tool(name, { collectionId: 'example' }, client === 'codex' ? codexMeta() : claudeMeta())], {
        client, env: { CLAUDE_CODE_SESSION_ID: sessionId },
        getStatus: async () => status, requestProcessing: async () => status, requestResume: async () => status,
      });
      assert.equal(result.rows[1].error, undefined); assert.equal(result.rows[1].result.isError, false);
      const response = view(result.rows[1]);
      assert.equal(response.status, 'blocked'); assert.equal(response.nextAction, 'inspect');
      assert.deepEqual(response.diagnostics, ['PROCESSING_OPERATION_CONFLICT']);
      assert.equal(response.statusText, 'Cuefluent: Processing needs attention.\n\nFor details, type status --verbose.');
    });
  }
});

test('unknown output status, diagnostics and malformed request IDs are fixed failures', async t => {
  for (const patch of [{ status: 'private content' }, { diagnostics: ['PRIVATE_CONTENT'] }, { requestId: 'not-a-native-id' },
    { statusDetail: 'private content' }, { statusDetail: 'accepted' }, { review: 'private content' },
    // A pending review outcome cannot describe a draft that no longer awaits review.
    { review: 'deferred' }, { review: 'declined' }]) await t.test(`${Object.keys(patch)[0]}: ${JSON.stringify(Object.values(patch)[0])}`, async () => {
    const result = await server([initialize, tool('process_selected_captures', { collectionId: 'example', requestId: randomUUID() })], {
      requestProcessing: async args => ({ status: 'idle', nextAction: 'none', requestId: args.requestId, ...patch })
    });
    assert.equal(result.rows[1].error.data.code, 'PROCESSING_CONTROL_OUTPUT_INVALID');
    assert.ok(!JSON.stringify(result.rows).includes('private content'));
  });
});

test('callback errors never return private error text', async () => {
  // An unknown binding failure refuses before any action; one in an action is unknown.
  const result = await server([initialize, tool('processing_status', { collectionId: 'example' })], { resolveSource: async () => { throw Object.assign(new Error('private source body'), { code: 'PRIVATE_BODY' }); } });
  assert.equal(result.rows[1].error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.ok(!JSON.stringify(result.rows).includes('private source body')); assert.ok(!JSON.stringify(result.rows).includes('PRIVATE_BODY'));
  const action = await server([initialize, tool('processing_status', { collectionId: 'example' })], { getStatus: async () => { throw Object.assign(new Error('private source body'), { code: 'PRIVATE_BODY' }); } });
  assert.equal(action.rows[1].error.data.code, 'PROCESSING_CONTROL_FAILED');
  assert.ok(!JSON.stringify(action.rows).includes('private source body')); assert.ok(!JSON.stringify(action.rows).includes('PRIVATE_BODY'));
});

test('framing remains bounded, fails truncated input and handles split UTF-8 data', async () => {
  for (const ending of ['', '\n']) await assert.rejects(server(['x'.repeat(6 * 256 * 1024 + 1) + ending]), { code: 'PROCESSING_CONTROL_INPUT_LIMIT' });
  await assert.rejects(server(['{"jsonrpc":']), { code: 'PROCESSING_CONTROL_PROTOCOL' });
  const greeting = { ...initialize, params: { ...initialize.params, clientInfo: { name: 'synthetic café', version: '1' } } };
  const bytes = Buffer.from(`${JSON.stringify(greeting)}\n${JSON.stringify(tool('processing_status', { collectionId: 'example' }))}\n`);
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  const result = await server([bytes.subarray(0, split), bytes.subarray(split)]);
  assert.equal(view(result.rows[1]).status, 'idle');
});

test('unknown methods and pre-initialize tools cannot reach controller callbacks', async () => {
  const result = await server([tool('processing_status', { collectionId: 'example' }), initialize,
    tool('processing_save', { collectionId: 'example' })]);
  assert.equal(result.rows[0].error.data.code, 'PROCESSING_CONTROL_PROTOCOL');
  assert.equal(result.rows[2].error.data.code, 'PROCESSING_CONTROL_METHOD_UNSUPPORTED'); assert.equal(result.calls.length, 0);
});

async function duplexReview(t, { capability = { elicitation: { form: {} } }, protocolVersion = '2025-11-25', review, client = 'codex', meta, ...overrides } = {}) {
  const input = new PassThrough(), rows = [], calls = [], waiters = [];
  let ended = false;
  const onRow = row => { rows.push(row); for (const waiter of [...waiters]) if (waiter.match(row)) {
    waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(row);
  } };
  const source = Object.freeze({ fixture: true });
  const running = runProcessingControlServer({ client, input, env: { CLAUDE_CODE_SESSION_ID: sessionId },
    output: new Writable({ write(chunk, _encoding, done) {
      for (const line of chunk.toString().trim().split('\n')) onRow(JSON.parse(line)); done();
    } }),
    resolveSource: async (context, invocation) => { calls.push(['resolve', invocation.tool]); return source; },
    getStatus: async () => { calls.push(['status']); return { status: 'idle', nextAction: 'none' }; },
    requestProcessing: async () => { throw new Error('unexpected processing'); },
    requestReview: async context => { calls.push(['review']); return review(context); }, ...overrides });
  running.catch(() => {});
  const wait = match => { const row = rows.find(match); return row ? Promise.resolve(row) : new Promise(resolve => waiters.push({ match, resolve })); };
  const send = value => input.write(`${JSON.stringify(value)}\n`);
  const end = () => { if (!ended) { ended = true; input.end(); } return running; };
  t.after(async () => { await end().catch(() => {}); });
  send({ ...initialize, params: { ...initialize.params, protocolVersion, capabilities: capability } });
  await wait(row => row.id === 0);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send(tool('processing_review', { collectionId: 'example' }, meta ?? (client === 'claude' ? claudeMeta() : codexMeta())));
  return { calls, rows, send, sendRaw: bytes => input.write(bytes), wait, end, running };
}

test('native review form isolates exact proposal bytes and serializes later tools while accepting a correlated host result', async t => {
  for (const client of ['codex']) await t.test(client, async t => {
    let received;
    const h = await duplexReview(t, { client, review: async ({ elicit, clientCapabilities }) => {
      assert.deepEqual(clientCapabilities.elicitation, { form: {} });
      received = await elicit({ message: '# PRIVATE-PROPOSAL\n\nExact synthetic draft.' });
      return { status: 'completed', nextAction: 'none', draft: 'PRIVATE-PROPOSAL' };
    } });
    const form = await h.wait(row => row.method === 'elicitation/create');
    assert.equal(form.params.mode, 'form'); assert(!form.params.message.includes('PRIVATE-PROPOSAL'));
    assert(form.params.requestedSchema.properties.changes.default.includes('PRIVATE-PROPOSAL'));
    assert.deepEqual(Object.keys(form.params.requestedSchema.properties), ['changes', 'decision']);
    assert(!Object.hasOwn(form.params.requestedSchema.properties.decision, 'default'));
    assert.equal(form.params.requestedSchema.properties.decision.enumNames.length, 4);
    assert.deepEqual(form.params.requestedSchema.properties.decision.enum, ['save', 'skip', 'cancel', 'later']);
    // Hosts may show only enum values, without the optional legacy titles.
    const description = form.params.requestedSchema.properties.decision.description;
    for (const semantics of ['Save writes the exact proposal', 'Skip handles these captured turns without saving',
      'Cancel releases the operation and keeps its captured turns pending', 'Later keeps the proposal pending']) assert(description.includes(semantics));
    // People read the whole form: its words are capture words too.
    assert.doesNotMatch(JSON.stringify(form.params), /collect|captures/i);
    h.send({ ...tool('processing_status', { collectionId: 'example' }, client === 'claude' ? claudeMeta() : codexMeta()), id: 2 });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.some(call => call[0] === 'status'), false);
    h.send({ jsonrpc: '2.0', id: form.id, result: withReviewPreview(form, { action: 'accept', content: { decision: 'save' } }) });
    const result = await h.wait(row => row.id === 1);
    await h.wait(row => row.id === 2);
    assert.deepEqual(received, { action: 'accept', content: { decision: 'save' }, preview: 'intact' });
    assert.equal(view(result).status, 'completed'); assert(!JSON.stringify(result).includes('PRIVATE-PROPOSAL'));
    assert.deepEqual(h.calls.map(x => x[0]), ['resolve', 'review', 'resolve', 'status']);
    await h.end();
  });
});

test('host decisions are exact and accept does not imply save', async t => {
  for (const response of [{ action: 'accept', content: { decision: 'skip' } }, { action: 'accept', content: { decision: 'cancel' } },
    { action: 'accept', content: { decision: 'later' } }, { action: 'decline' }, { action: 'cancel', content: null }]) await t.test(JSON.stringify(response), async t => {
    let received;
    const h = await duplexReview(t, { capability: { elicitation: {} }, review: async ({ elicit }) => {
      received = await elicit({ message: 'Exact synthetic proposal' }); return { status: 'awaiting-review', nextAction: 'review' };
    } });
    const form = await h.wait(row => row.method === 'elicitation/create');
    h.send({ jsonrpc: '2.0', id: form.id, result: withReviewPreview(form, response) }); await h.wait(row => row.id === 1);
    assert.deepEqual(received, response.action === 'accept' ? { ...response, preview: 'intact' } : { action: response.action }); await h.end();
  });
});

test('Claude and form-less Codex review without a host form; only form-capable Codex gets one', async t => {
  for (const [client, capability] of [['claude', { elicitation: { form: {} } }], ['claude', {}], ['codex', {}], ['codex', { elicitation: { url: {} } }]]) {
    await t.test(`${client}/${JSON.stringify(capability)}`, async t => {
      let received;
      const h = await duplexReview(t, { client, capability, review: async context => {
        received = context; return { status: 'awaiting-review', statusDetail: 'draft-ready', nextAction: 'review' };
      } });
      const result = view(await h.wait(row => row.id === 1));
      assert.equal(received.elicit, undefined); assert.equal(result.status, 'awaiting-review');
      assert.equal(h.rows.some(row => row.method === 'elicitation/create'), false); await h.end();
    });
  }
});

test('without a review callback, a pending draft is reported as unreviewable and untouched', async t => {
  for (const capability of [{}, { elicitation: { url: {} } }]) for (const status of ['idle', 'awaiting-review']) {
    await t.test(`${JSON.stringify(capability)}/${status}`, async t => {
      const h = await duplexReview(t, { capability, requestReview: undefined,
        getStatus: async () => ({ status, statusDetail: status === 'idle' ? 'inactive' : 'draft-ready', nextAction: status === 'idle' ? 'none' : 'review' }) });
      const result = view(await h.wait(row => row.id === 1));
      assert.deepEqual(result.diagnostics, ['PROCESSING_REVIEW_UNSUPPORTED']);
      assert.equal(result.status, status);
      // Only an actual pending draft is described as unreviewable here.
      assert.equal(result.review, status === 'idle' ? undefined : 'unavailable');
      if (status === 'awaiting-review') {
        assert.match(result.statusText, /^Cuefluent: Review unavailable: this client did not report review form support\. The draft remains pending; nothing was saved\./);
        assert(!result.statusText.includes('Draft ready'));
      }
      assert.equal(h.calls.some(call => call[0] === 'review'), false);
      assert.equal(h.rows.some(row => row.method === 'elicitation/create'), false); await h.end();
    });
  }
});

test('clients offering an older protocol can accept the supported revision and review', async t => {
  for (const protocolVersion of ['2025-06-18', '2024-11-05']) for (const elicitation of [{}, { form: {} }]) {
    await t.test(`${protocolVersion}/${JSON.stringify(elicitation)}`, async t => {
      let decisions = 0;
      const h = await duplexReview(t, { protocolVersion, capability: { elicitation },
        getStatus: async () => ({ status: 'awaiting-review', nextAction: 'review' }),
        review: async ({ elicit }) => {
          const result = await elicit({ message: 'Exact synthetic proposal' });
          assert.equal(result.content.decision, 'later'); decisions++;
          return { status: 'awaiting-review', nextAction: 'review' };
        } });
      assert.equal(h.rows[0].result.protocolVersion, '2025-11-25');
      const form = await h.wait(row => row.method === 'elicitation/create');
      h.send({ jsonrpc: '2.0', id: form.id, result: withReviewPreview(form, { action: 'accept', content: { decision: 'later' } }) });
      const result = view(await h.wait(row => row.id === 1));
      assert.equal(result.status, 'awaiting-review'); assert.deepEqual(result.diagnostics, []); assert.equal(decisions, 1);
      h.send({ ...tool('processing_status', { collectionId: 'example' }), id: 2 });
      assert.equal(view(await h.wait(row => row.id === 2)).status, 'awaiting-review'); await h.end();
    });
  }
});

test('a client declining the supported protocol can disconnect without starting work', async () => {
  const h = await server([{ ...initialize, params: { ...initialize.params, protocolVersion: '2024-11-05' } }]);
  assert.equal(h.rows.length, 1); assert.equal(h.rows[0].result.protocolVersion, '2025-11-25');
  assert.equal(h.calls.length, 0);
});

test('host line-ending normalization keeps the display intact while lost or changed text is reported as altered', async t => {
  const preview = '# Synthetic preview\n\nA complete line.\n';
  for (const decision of ['save', 'skip', 'cancel', 'later']) for (const ending of ['\r\n', '\r']) {
    await t.test(`${decision}/${JSON.stringify(ending)}`, async t => {
      let received;
      const h = await duplexReview(t, { review: async ({ elicit }) => {
        received = await elicit({ message: preview }); return { status: 'awaiting-review', nextAction: 'review' };
      } });
      const form = await h.wait(row => row.method === 'elicitation/create');
      h.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { decision, changes: preview.replaceAll('\n', ending) } } });
      assert.equal((await h.wait(row => row.id === 1)).error, undefined);
      assert.deepEqual(received, { action: 'accept', content: { decision }, preview: 'intact' }); await h.end();
    });
  }
  // Includes the Claude CLI 2.1.294 and 2.1.299 string-default sanitizer, which
  // replaces LF/CR/U+2028/U+2029 with U+FFFD before the person sees the field.
  for (const changes of [preview.trim(), preview.replaceAll('\n', ' '), preview.replace('complete', 'changed'),
    preview.replace(/[\n\r\u2028\u2029]/g, '\uFFFD'), '', undefined, 42]) for (const decision of ['save', 'later']) for (const client of ['codex']) {
    await t.test(`${client}/${JSON.stringify(changes)}/${decision}`, async t => {
      let received;
      const h = await duplexReview(t, { client, review: async ({ elicit }) => {
        received = await elicit({ message: preview }); return { status: 'awaiting-review', nextAction: 'review' };
      } });
      const form = await h.wait(row => row.method === 'elicitation/create');
      h.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { decision, changes } } });
      // The decision reaches review only with an altered display marker; the
      // transport no longer turns a display problem into a proposal error.
      assert.equal((await h.wait(row => row.id === 1)).error, undefined);
      assert.deepEqual(received, { action: 'accept', content: { decision }, preview: 'altered' }); await h.end();
    });
  }
});

test('serialized review outcomes and free text are rejected before source or engine access', async t => {
  for (const patch of [{ action: 'save' }, { approved: true }, { decision: 'save' }, { correction: 'new fact' }, { proposalHash: 'a'.repeat(64) }]) await t.test(Object.keys(patch)[0], async () => {
    const result = await server([initialize, tool('processing_review', { collectionId: 'example', ...patch })]);
    assert.equal(result.rows[1].error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST'); assert.equal(result.calls.length, 0);
  });
});

test('malformed native form results never return an approval to the engine', async t => {
  for (const result of [{ action: 'accept' }, { action: 'accept', content: { decision: 'save', correction: 'body' } },
    { action: 'approve', content: { decision: 'save' } }, { action: 'accept', content: { decision: 'unknown' } },
    { action: 'cancel', content: { decision: 'save' } }]) await t.test(JSON.stringify(result), async t => {
    let completed = false;
    const h = await duplexReview(t, { review: async ({ elicit }) => {
      await elicit({ message: 'Exact synthetic proposal' }); completed = true; return { status: 'completed', nextAction: 'none' };
    } });
    const form = await h.wait(row => row.method === 'elicitation/create');
    h.send({ jsonrpc: '2.0', id: form.id, result: withReviewPreview(form, result) });
    assert.equal((await h.wait(row => row.id === 1)).error.data.code, 'PROCESSING_REVIEW_INTERRUPTED');
    assert.equal(completed, false); await h.end();
  });
});

test('disconnect and native request cancellation interrupt pending review without a default decision', async t => {
  for (const action of ['disconnect', 'cancel']) await t.test(action, async t => {
    let completed = false;
    const h = await duplexReview(t, { review: async ({ elicit }) => {
      await elicit({ message: 'Exact synthetic proposal' }); completed = true; return { status: 'completed', nextAction: 'none' };
    } });
    await h.wait(row => row.method === 'elicitation/create');
    if (action === 'disconnect') await h.end();
    else h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    if (action === 'disconnect') assert.equal((await h.wait(row => row.id === 1)).error.data.code, 'PROCESSING_REVIEW_INTERRUPTED');
    else {
      h.send({ jsonrpc: '2.0', id: 2, method: 'ping' }); await h.wait(row => row.id === 2);
      assert(!h.rows.some(row => row.id === 1), 'a cancelled request receives no response');
    }
    assert.equal(completed, false); await h.end();
  });
});

test('oversize exact previews are refused rather than truncated or sent as ordinary tool output', async t => {
  const h = await duplexReview(t, { review: async ({ elicit }) => {
    await elicit({ message: 'x'.repeat(256 * 1024) }); return { status: 'completed', nextAction: 'none' };
  } });
  const result = await h.wait(row => row.id === 1);
  assert.equal(result.error.data.code, 'PROCESSING_REVIEW_TOO_LARGE');
  assert.equal(h.rows.some(row => row.method === 'elicitation/create'), false); await h.end();
});

test('large UTF-8 preview echoes are bounded separately from ordinary requests', async t => {
  const preview = '# Synthetic review\n' + 'café 🌳\n'.repeat(8000);
  assert(Buffer.byteLength(preview) > 64 * 1024);
  for (const kind of ['host response', 'ordinary method', 'oversized host response']) await t.test(kind, async t => {
    let received;
    const h = await duplexReview(t, { review: async ({ elicit }) => {
      received = await elicit({ message: preview });
      return { status: 'awaiting-review', nextAction: 'review' };
    } });
    const form = await h.wait(row => row.method === 'elicitation/create');
    assert.equal(form.params.requestedSchema.properties.changes.default, preview);
    const result = withReviewPreview(form, { action: 'accept', content: { decision: 'skip' } });
    if (kind === 'oversized host response') result.content.changes = 'x'.repeat(256 * 1024 + 1);
    h.send(kind === 'ordinary method'
      ? { jsonrpc: '2.0', id: 2, method: 'ping', params: { text: preview } }
      : { jsonrpc: '2.0', id: form.id, result });
    if (kind === 'host response') {
      assert.equal((await h.wait(row => row.id === 1)).error, undefined);
      assert.deepEqual(received, { action: 'accept', content: { decision: 'skip' }, preview: 'intact' });
    } else if (kind === 'oversized host response') {
      // An oversized echo cannot match the bounded preview; it applies nothing.
      assert.equal((await h.wait(row => row.id === 1)).error, undefined);
      assert.deepEqual(received, { action: 'accept', content: { decision: 'skip' }, preview: 'altered' });
      h.send({ jsonrpc: '2.0', id: 90, method: 'ping' }); assert.deepEqual((await h.wait(row => row.id === 90)).result, {});
    } else {
      await assert.rejects(h.running, { code: 'PROCESSING_CONTROL_INPUT_LIMIT' }); assert.equal(received, undefined); return;
    }
    await h.end();
  });
});

test('large late and unknown form echoes are ignored without killing the server or authorizing work', async t => {
  for (const state of ['cancelled', 'answered', 'unknown']) await t.test(state, async t => {
    let decisions = 0;
    const h = await duplexReview(t, { review: async ({ elicit }) => {
      await elicit({ message: '# Synthetic review\n' + 'x'.repeat(100 * 1024) });
      decisions++; return { status: 'completed', nextAction: 'none' };
    } });
    const form = await h.wait(row => row.method === 'elicitation/create');
    const echo = { jsonrpc: '2.0', id: form.id, result: withReviewPreview(form, { action: 'accept', content: { decision: 'save' } }) };
    if (state === 'answered') { h.send(echo); await h.wait(row => row.id === 1); }
    else h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    h.send({ jsonrpc: '2.0', id: 80, method: 'ping' }); await h.wait(row => row.id === 80);
    const bytes = Buffer.from(JSON.stringify({ ...echo, id: state === 'unknown' ? 'unknown-form' : form.id }) + '\n');
    h.sendRaw(bytes.subarray(0, 70 * 1024)); h.sendRaw(bytes.subarray(70 * 1024));
    h.send({ jsonrpc: '2.0', id: 90, method: 'ping' }); assert.deepEqual((await h.wait(row => row.id === 90)).result, {});
    assert.equal(decisions, state === 'answered' ? 1 : 0); await h.end();
  });
});

test('host Unicode escaping and CRLF expansion fit the bounded reply envelope', async t => {
  for (const preview of ['漢'.repeat(60000) + '🌳'.repeat(6000), 'x'.repeat(220 * 1024), '# Newlines\n' + '\n'.repeat(120000)]) {
    await t.test(preview.startsWith('漢') ? 'Unicode' : preview.startsWith('x') ? 'escaped ASCII' : 'CRLF', async t => {
      let decisions = 0;
      const h = await duplexReview(t, { review: async ({ elicit }) => {
        await elicit({ message: preview }); decisions++; return { status: 'completed', nextAction: 'none' };
      } });
      const form = await h.wait(row => row.method === 'elicitation/create');
      const result = withReviewPreview(form, { action: 'accept', content: { decision: 'save', changes: preview.replaceAll('\n', '\r\n') } });
      const line = JSON.stringify({ jsonrpc: '2.0', id: form.id, result }).replace(/[x\u007f-\uffff]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
      assert(Buffer.byteLength(line) > 256 * 1024);
      for (let offset = 0; offset < line.length; offset += 8192) h.sendRaw(line.slice(offset, offset + 8192));
      assert.equal(view(await h.wait(row => row.id === 1)).status, 'completed'); assert.equal(decisions, 1); await h.end();
    });
  }
});

test('collection omission uses only the verified source binding, preserving exact original arguments', async t => {
  for (const name of ['processing_status', 'process_selected_captures', 'processing_review']) await t.test(name, async () => {
    const args = name === 'process_selected_captures' ? { requestId: randomUUID() } : {};
    let observed;
    const result = await server([initialize, tool(name, args)], { resolveSource: async (_context, invocation) => {
      observed = invocation.arguments; return Object.freeze({ collectionId: 'verified-collection' });
    } });
    assert.deepEqual(observed, args); assert.equal(view(result.rows[1]).collectionId, 'verified-collection');
    if (name !== 'processing_review') assert.equal(result.calls[0].args.collectionId, 'verified-collection');
  });
  for (const source of [{}, { collectionId: 'invalid collection' }, { collectionId: 'another' }]) {
    const args = source.collectionId === 'another' ? { collectionId: 'explicit' } : {};
    const result = await server([initialize, tool('processing_status', args)], { resolveSource: async () => source });
    assert.equal(result.rows[1].error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(result.calls.length, 0);
  }
});

test('a response for another or already completed form cannot supply an approval', async t => {
  for (const attack of ['unknown', 'replay']) await t.test(attack, async t => {
    let decisions = 0;
    const h = await duplexReview(t, { review: async ({ elicit }) => {
      await elicit({ message: 'Exact synthetic proposal' }); decisions++; return { status: 'completed', nextAction: 'none' };
    } });
    const form = await h.wait(row => row.method === 'elicitation/create');
    if (attack === 'replay') {
      h.send({ jsonrpc: '2.0', id: form.id, result: withReviewPreview(form, { action: 'accept', content: { decision: 'save' } }) });
      await h.wait(row => row.id === 1);
    }
    h.send({ jsonrpc: '2.0', id: attack === 'unknown' ? 'guessed-review-id' : form.id,
      result: withReviewPreview(form, { action: 'accept', content: { decision: 'save' } }) });
    if (attack === 'unknown') h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    h.send({ jsonrpc: '2.0', id: 90, method: 'ping' }); await h.wait(row => row.id === 90);
    assert.equal(decisions, attack === 'replay' ? 1 : 0); await h.end();
  });
});

test('review capability expires with its exact tool request and cannot send a later unsolicited form', async t => {
  let elicit;
  const h = await duplexReview(t, { review: async context => { elicit = context.elicit; return { status: 'awaiting-review', nextAction: 'review' }; } });
  await h.wait(row => row.id === 1);
  await assert.rejects(elicit({ message: 'Late proposal' }), { code: 'PROCESSING_REVIEW_INTERRUPTED' });
  assert.equal(h.rows.some(row => row.method === 'elicitation/create'), false); await h.end();
});


test('unknown notifications and malformed frames leave later requests usable', async () => {
  const result = await server([initialize, { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
    'invalid json\n', { jsonrpc: '2.0', id: 'late', result: {} }, { jsonrpc: '2.0', id: 40, method: 'ping' }]);
  assert.deepEqual(result.rows.find(row => row.id === 40).result, {});
  assert.equal(result.calls.length, 0);
});

test('actionable engine errors survive the control boundary without private error text', async t => {
  for (const code of ['PROCESSING_OUTPUT_CHANGED', 'PROCESSING_REVIEW_REQUIRED', 'PROCESSING_PROPOSAL_CHANGED',
    'STALE_SELECTION', 'PROCESSING_CHAT_REQUEST_CONFLICT', 'PROCESSING_SOURCE_DISCOVERY_LIMIT',
    'WORKFLOW_NOT_AUTHORIZED', 'PROCESSING_REINSPECTION_REQUIRED', 'PROCESSING_RECOVERY_REQUIRED']) await t.test(code, async () => {
    const result = await server([initialize, tool('process_selected_captures', { collectionId: 'example' })], {
      requestProcessing: async () => { throw Object.assign(new Error('private source bytes'), { code }); }
    });
    assert.equal(result.rows[1].error.data.code, code); assert(!JSON.stringify(result.rows).includes('private source'));
  });
});

test('Codex verification handshake performs no work until the original native call and response match', async t => {
  for (const attack of [null, 'arguments', 'turn', 'same cell', 'response', 'selection', 'policy', 'source', 'replay', 'pending', 'unknown']) await t.test(attack ?? 'valid', async () => {
    const input = new PassThrough(), rows = [], resolvers = new Map();
    const firstContext = { ...codexMeta(), callId: `exec-${randomUUID()}`, itemId: 'ctc_first' };
    const nextContext = { ...firstContext, callId: `exec-${randomUUID()}`, itemId: 'ctc_next' };
    const original = { pending: true, collectionId: 'example', selectionHash: 'selection', configHash: 'policy', outerRecordHash: 'outer',
      source: { fileIdentity: 'identity' }, selection: { sessionId } };
    let dispatches = 0, resolutions = 0, challenge;
    const output = new Writable({ write(bytes, _enc, done) {
      for (const line of bytes.toString().trim().split('\n')) { const row = JSON.parse(line); rows.push(row); resolvers.get(row.id)?.(row); }
      done();
    } });
    const send = row => input.write(JSON.stringify(row) + '\n');
    const wait = id => rows.find(row => row.id === id) ?? new Promise(resolve => resolvers.set(id, resolve));
    const running = runProcessingControlServer({ client: 'codex', input, output,
      resolveSource: async (context, invocation, { requireCompleted }) => {
        resolutions++;
        assert.equal(requireCompleted, resolutions > 1);
        assert.equal(context.toolCallId, firstContext.callId);
        assert.deepEqual(invocation.arguments, { collectionId: 'example' });
        if (resolutions === 1) return original;
        const resolved = { ...original, pending: false, handshakeResultHash: digest(canonicalJSON(challenge.result)) };
        if (attack === 'response') resolved.handshakeResultHash = 'forged';
        if (attack === 'selection') resolved.selectionHash = 'changed';
        if (attack === 'policy') resolved.configHash = 'changed';
        if (attack === 'source') resolved.source = { fileIdentity: 'replaced' };
        if (attack === 'pending') resolved.pending = true;
        return resolved;
      },
      getStatus: async () => { dispatches++; return { status: 'idle', nextAction: 'none' }; },
      requestProcessing: async () => { dispatches++; return { status: 'busy', nextAction: 'wait' }; }
    });
    send(initialize); await wait(0);
    send(tool('process_selected_captures', { collectionId: 'example' }, firstContext));
    challenge = await wait(1); assert.equal(dispatches, 0);
    const value = view(challenge); assert.equal(value.status, 'verification-required');
    const args = { collectionId: 'example', retryToken: value.retryToken };
    if (attack === 'arguments') args.collectionId = 'other';
    if (attack === 'turn') nextContext['x-codex-turn-metadata'] = { ...nextContext['x-codex-turn-metadata'], turn_id: randomUUID() };
    if (attack === 'same cell') nextContext.itemId = firstContext.itemId;
    if (attack === 'unknown') args.retryToken = randomUUID();
    send({ ...tool('process_selected_captures', args, nextContext), id: 2 });
    const result = await wait(2);
    if (!attack || attack === 'replay') { assert.equal(view(result).status, 'busy'); assert.equal(dispatches, 1); }
    else { assert.equal(result.error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(dispatches, 0); }
    if (attack === 'replay' || attack === 'pending') {
      send({ ...tool('process_selected_captures', args, { ...nextContext, itemId: 'ctc_later', callId: `exec-${randomUUID()}` }), id: 3 });
      assert.equal((await wait(3)).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(dispatches, attack === 'replay' ? 1 : 0);
    }
    input.end(); await running;
  });
});

async function handshakeHarness(t, { onComplete = () => {} } = {}) {
  const input = new PassThrough(), rows = [], waits = new Map(), pending = { pending: true, collectionId: 'example', source: { fileIdentity: 'synthetic' }, selection: { sessionId } };
  let resolutions = 0, dispatches = 0;
  const output = new Writable({ write(bytes, _encoding, done) {
    for (const line of bytes.toString().trim().split('\n')) { const row = JSON.parse(line); rows.push(row); waits.get(row.id)?.(row); }
    done();
  } });
  const running = runProcessingControlServer({ client: 'codex', input, output,
    resolveSource: async (context, _invocation, { requireCompleted }) => {
      resolutions++;
      if (!requireCompleted) return pending;
      onComplete();
      const original = rows.find(row => row.id === Number(context.itemId.slice(4)));
      return { ...pending, pending: false, handshakeResultHash: digest(canonicalJSON(original.result)) };
    },
    getStatus: async () => { dispatches++; return { status: 'idle', nextAction: 'none' }; },
    requestProcessing: async () => { dispatches++; return { status: 'busy', nextAction: 'wait' }; }
  });
  t.after(async () => { input.end(); await running; });
  const send = async row => {
    input.write(JSON.stringify(row) + '\n');
    return rows.find(value => value.id === row.id) ?? new Promise(resolve => waits.set(row.id, resolve));
  };
  await send(initialize);
  return { call: (id, args = {}) => send({ ...tool('process_selected_captures', { collectionId: 'example', ...args },
    { ...codexMeta(), itemId: `ctc_${id}`, callId: `exec-${randomUUID()}` }), id }),
    counts: () => ({ resolutions, dispatches }) };
}

test('handshake expiry refuses the exact boundary without dispatch or native re-resolution', async t => {
  for (const age of [59_999, 60_000, 60_001]) await t.test(`age ${age}`, async t => {
    let now = 100;
    t.mock.method(performance, 'now', () => now);
    const h = await handshakeHarness(t), token = view(await h.call(1)).retryToken;
    now += age;
    const result = await h.call(2, { retryToken: token });
    if (age < 60_000) {
      assert.equal(view(result).status, 'busy'); assert.deepEqual(h.counts(), { resolutions: 2, dispatches: 1 });
    } else {
      assert.equal(result.error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      assert.deepEqual(h.counts(), { resolutions: 1, dispatches: 0 });
    }
  });
});

test('handshake capacity is bounded and expired entries release capacity without admitting old tokens', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const h = await handshakeHarness(t), tokens = [];
  for (let id = 1; id <= 16; id++) tokens.push(view(await h.call(id)).retryToken);
  assert.equal(new Set(tokens).size, 16);
  assert.equal((await h.call(17)).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.equal(h.counts().dispatches, 0);
  now += 60_000;
  assert.equal(view(await h.call(18)).status, 'verification-required');
  const before = h.counts();
  assert.equal((await h.call(19, { retryToken: tokens[0] })).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.deepEqual(h.counts(), before); assert.equal(before.dispatches, 0);
});

test('invalid native settle options retain their request error through MCP', async () => {
  const { resolveProcessingInvocation } = await import('./processing-native-invocation.mjs');
  for (const settleMs of [-1, 1500, 0.5, '100', NaN]) {
    const result = await server([initialize, tool('processing_status', {})], {
      resolveSource: (context, invocation) => resolveProcessingInvocation(null, context, invocation, { settleMs })
    });
    assert.equal(result.rows[1].error.data.code, 'PROCESSING_CONTROL_INVALID_REQUEST');
    assert.deepEqual(result.calls, []);
  }
});

test('a token expiring while native records settle cannot dispatch', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const h = await handshakeHarness(t, { onComplete: () => { now += 1; } });
  const token = view(await h.call(1)).retryToken; now += 59_999;
  assert.equal((await h.call(2, { retryToken: token })).error.data.code, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.deepEqual(h.counts(), { resolutions: 2, dispatches: 0 });
});

// People see capture words only: "collection" stays in settings, codes and
// fields. Every reply a status, review, help or refusal can produce is checked.
test('replies people read never say collection', () => {
  const states = ['missing', 'creating', 'busy', 'idle', 'awaiting-review', 'blocked', 'completed'];
  const texts = [], view = value => { try { return processingControlStatusView(value, { collectionId: 'example' }); } catch { return null; } };
  for (const commandPrefix of ['/cuefluent-notes', '$cuefluent-notes']) {
    const base = { nextAction: 'none', commandPrefix };
    for (const statusDetail of PROCESSING_STATUS_DETAILS) {
      const shown = states.flatMap(status => PROCESSING_SCOPES.flatMap(scope => [false, true].map(verbose =>
        view({ ...base, status, statusDetail, scope, ...(verbose ? { verbose } : {}) })))).filter(Boolean);
      assert(shown.length, statusDetail); texts.push(...shown.map(item => item.statusText));
    }
    // Each outcome with the draft fields it may carry; every outcome must build.
    const folder = path.resolve('private-state', 'review', 't7xb88');
    const named = [{}, { draft: { code: 't7xb88' } }, { draft: { code: 't7xb88', path: 'notes/a.md', fileCount: 2 } },
      { draft: { code: 't7xb88', folder, fileCount: 1, files: [{ path: 'notes/a.md', bytes: 12, change: 'create' }] } }];
    const listed = [{}, { drafts: [{ code: 'k2mn9p', path: 'notes/b.md', fileCount: 1 }] }];
    for (const review of PROCESSING_REVIEW_OUTCOMES) {
      const shown = states.flatMap(status => named.flatMap(draft => listed.flatMap(drafts => [false, true].map(untyped =>
        view({ ...base, status, review, ...draft, ...drafts, ...(untyped ? { untyped } : {}) }))))).filter(Boolean);
      assert(shown.length, review); texts.push(...shown.map(item => item.statusText));
    }
    for (const code of COLLECTION_STOP_CODES) for (const verbose of [false, true]) {
      const shown = view({ ...base, status: 'idle', collection: { state: 'stopped', code }, ...(verbose ? { verbose } : {}) });
      assert(shown, code); texts.push(shown.statusText);
    }
    texts.push(view({ ...base, status: 'missing', help: true }).statusText);
    for (const capture of PROCESSING_CAPTURE_OUTCOMES) {
      const counts = capture === 'captured' ? { turns: 2, more: true } : capture === 'nothing-new' ? { more: true } : capture === 'blocked' ? { reason: 'INVALID_SESSION_RECORD' } : {};
      const shown = view({ ...base, status: 'idle', capture, ...counts });
      assert(shown, capture); texts.push(shown.statusText);
    }
  }
  for (const code of PROCESSING_REFUSAL_CODES) for (const client of ['claude', 'codex']) for (const stage of ['binding', 'action']) {
    for (const tool of ['processing_status', 'process_selected_captures', 'processing_review']) texts.push(processingControlRefusalText(code, { client, stage, tool }));
  }
  const identity = { client: 'codex', sessionId: randomUUID(), unitId: randomUUID() };
  for (const status of ['queued', 'paused', 'processing-only', 'intake-blocked']) {
    const output = collectionHookOutput({ status, selection: identity, notice: { diagnostics: [], pending: ['WORKER_READ_BUDGET'],
      boundaryExcluded: [{ client: 'codex', sessionId: identity.sessionId, unitId: identity.unitId }] } }, 'UserPromptSubmit');
    texts.push(output.hookSpecificOutput.additionalContext);
  }
  assert(texts.length > 400, `${texts.length} texts`);
  for (const text of texts) assert.doesNotMatch(text, /collect/i, text);
});
