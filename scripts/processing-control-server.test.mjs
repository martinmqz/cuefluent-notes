import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { runProcessingControlServer } from './processing-control-server.mjs';
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

test('source adapter exposes explicit versioned tools without save, approval or arbitrary execution', async () => {
  const result = await server([initialize, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.equal(result.rows[0].result.serverInfo.name, 'cuefluent_control');
  const tools = result.rows[1].result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['processing_status', 'process_selected_captures', 'processing_review']);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tools[0].annotations.readOnlyHint, true); assert.equal(tools[1].annotations.readOnlyHint, false);
  assert.equal(tools[1].inputSchema.properties.selection.additionalProperties, false);
  assert.deepEqual(Object.keys(tools[2].inputSchema.properties), ['collectionId', 'retryToken']);
  assert.equal(result.calls.length, 0);
});

test('ownership refusal identifies only the exact Codex source, never a Claude fallback candidate', async () => {
  for (const client of ['codex', 'claude']) {
    const result = await server([initialize, tool('processing_status', {}, client === 'codex' ? codexMeta() : claudeMeta())], {
      client, env: { CLAUDE_CODE_SESSION_ID: sessionId },
      resolveSource: async () => { throw Object.assign(new Error('Private source detail'), { code: 'UNSUPPORTED_SESSION_OWNERSHIP' }); }
    });
    assert.deepEqual(result.rows[1].error, { code: -32600,
      message: client === 'codex' ? 'UNSUPPORTED_SESSION_OWNERSHIP' : 'PROCESSING_CONTROL_FAILED' });
    assert.equal(result.calls.length, 0); assert(!JSON.stringify(result.rows).includes('Private source detail'));
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
  assert.equal(refused.rows[1].error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  for (const args of [[], '', false, 0]) {
    const invalid = await server([initialize, tool('processing_status', args)]);
    assert.equal(invalid.rows[1].error.message, 'PROCESSING_CONTROL_INVALID_REQUEST');
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
    assert.equal(result.rows[1].error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(result.calls.length, 0);
  });
});

test('request schema rejects serialized authority, configuration, model and approval fields', async t => {
  for (const patch of [{ source: { sessionId } }, { _meta: codexMeta() }, { approved: true }, { model: 'model' }, { configPath: '/private' },
    { prompt: 'invent a new task' }, { selection: { client: 'codex', sessionId, cwd: path.resolve('fixture'), proven: true } },
    { selection: { client: 'codex', sessionId, cwd: 'relative' } }]) await t.test(Object.keys(patch)[0], async () => {
    const result = await server([initialize, tool('process_selected_captures', { collectionId: 'example', requestId: randomUUID(), ...patch })]);
    assert.equal(result.rows[1].error.message, 'PROCESSING_CONTROL_INVALID_REQUEST'); assert.equal(result.calls.length, 0);
  });
});

test('unverified source cannot dispatch and pure status never invokes processing', async () => {
  const refused = await server([initialize, tool('process_selected_captures', { collectionId: 'example', requestId: randomUUID() })], { resolveSource: async () => null });
  assert.equal(refused.rows[1].error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(refused.calls.length, 0);
  const status = await server([initialize, tool('processing_status', { collectionId: 'example' })]);
  assert.deepEqual(status.calls.map(call => call.type), ['resolve', 'status']);
});

test('result projection drops private evidence and callback prose and builds stable status text', async () => {
  const result = await server([initialize, tool('processing_status', { collectionId: 'example' })], {
    getStatus: async () => ({ status: 'awaiting-review', nextAction: 'review', chat: { client: 'claude', sessionId: chatId, evidence: 'secret' },
      evidence: 'secret', output: 'secret', statusText: 'secret', path: '/private/secret', diagnostics: ['PROCESSING_APPROVAL_REQUIRED'] })
  });
  assert.ok(!JSON.stringify(result.rows).includes('secret'));
  assert.equal(view(result.rows[1]).statusText, 'Cuefluent processing: awaiting-review. PROCESSING_APPROVAL_REQUIRED. Next action: review.');
});

test('known processing refusals preserve their safe actionable code', async t => {
  for (const code of ['PROCESSING_CHAT_REVIEW_UNRESOLVED', 'PROCESSING_CHAT_POLICY_CHANGED',
    'PROCESSING_CHAT_STATE_CHANGED', 'INTAKE_BLOCKED', 'PROCESSING_REVIEW_LIMIT']) await t.test(code, async () => {
    const result = await server([initialize, tool('processing_status', { collectionId: 'example' })], {
      getStatus: async () => { throw Object.assign(new Error('private detail'), { code }); }
    });
    assert.equal(result.rows[1].error.message, code);
    assert(!JSON.stringify(result.rows).includes('private detail'));
  });
});

test('unknown output status, diagnostics and malformed request IDs are fixed failures', async t => {
  for (const patch of [{ status: 'private content' }, { diagnostics: ['PRIVATE_CONTENT'] }, { requestId: 'not-a-native-id' }]) await t.test(Object.keys(patch)[0], async () => {
    const result = await server([initialize, tool('process_selected_captures', { collectionId: 'example', requestId: randomUUID() })], {
      requestProcessing: async args => ({ status: 'idle', nextAction: 'none', requestId: args.requestId, ...patch })
    });
    assert.equal(result.rows[1].error.message, 'PROCESSING_CONTROL_OUTPUT_INVALID');
    assert.ok(!JSON.stringify(result.rows).includes('private content'));
  });
});

test('callback errors never return private error text', async () => {
  const result = await server([initialize, tool('processing_status', { collectionId: 'example' })], { resolveSource: async () => { throw Object.assign(new Error('private source body'), { code: 'PRIVATE_BODY' }); } });
  assert.equal(result.rows[1].error.message, 'PROCESSING_CONTROL_FAILED');
  assert.ok(!JSON.stringify(result.rows).includes('private source body')); assert.ok(!JSON.stringify(result.rows).includes('PRIVATE_BODY'));
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
  assert.equal(result.rows[0].error.message, 'PROCESSING_CONTROL_PROTOCOL');
  assert.equal(result.rows[2].error.message, 'PROCESSING_CONTROL_METHOD_UNSUPPORTED'); assert.equal(result.calls.length, 0);
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
  for (const client of ['codex', 'claude']) await t.test(client, async t => {
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
    for (const semantics of ['Save writes the exact proposal', 'Skip handles these captures without saving',
      'Cancel releases the operation and keeps captures pending', 'Later keeps the proposal pending']) assert(description.includes(semantics));
    h.send({ ...tool('processing_status', { collectionId: 'example' }, client === 'claude' ? claudeMeta() : codexMeta()), id: 2 });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.some(call => call[0] === 'status'), false);
    h.send({ jsonrpc: '2.0', id: form.id, result: withReviewPreview(form, { action: 'accept', content: { decision: 'save' } }) });
    const result = await h.wait(row => row.id === 1);
    await h.wait(row => row.id === 2);
    assert.deepEqual(received, { action: 'accept', content: { decision: 'save' } });
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
    assert.deepEqual(received, response.action === 'accept' ? response : { action: response.action }); await h.end();
  });
});

test('missing or URL-only form capability leaves the proposal untouched', async t => {
  for (const capability of [{}, { elicitation: { url: {} } }]) await t.test(JSON.stringify(capability), async t => {
    const h = await duplexReview(t, { capability, review: async () => { throw new Error('must not review'); } });
    const result = await h.wait(row => row.id === 1);
    assert.deepEqual(view(result).diagnostics, ['PROCESSING_REVIEW_UNSUPPORTED']);
    assert.equal(view(result).status, 'idle');
    assert.equal(h.calls.some(call => call[0] === 'review'), false);
    assert.equal(h.rows.some(row => row.method === 'elicitation/create'), false); await h.end();
  });
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

test('host line-ending normalization preserves decisions while lost or changed text is refused', async t => {
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
      assert.deepEqual(received, { action: 'accept', content: { decision } }); await h.end();
    });
  }
  for (const changes of [preview.trim(), preview.replaceAll('\n', ' '), preview.replace('complete', 'changed')]) {
    await t.test(JSON.stringify(changes), async t => {
      let decided = false;
      const h = await duplexReview(t, { review: async ({ elicit }) => {
        await elicit({ message: preview }); decided = true; return { status: 'completed', nextAction: 'none' };
      } });
      const form = await h.wait(row => row.method === 'elicitation/create');
      h.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { decision: 'save', changes } } });
      assert.equal((await h.wait(row => row.id === 1)).error.message, 'PROCESSING_REVIEW_PREVIEW_CHANGED');
      assert.equal(decided, false); await h.end();
    });
  }
});

test('serialized review outcomes and free text are rejected before source or engine access', async t => {
  for (const patch of [{ action: 'save' }, { approved: true }, { decision: 'save' }, { correction: 'new fact' }, { proposalHash: 'a'.repeat(64) }]) await t.test(Object.keys(patch)[0], async () => {
    const result = await server([initialize, tool('processing_review', { collectionId: 'example', ...patch })]);
    assert.equal(result.rows[1].error.message, 'PROCESSING_CONTROL_INVALID_REQUEST'); assert.equal(result.calls.length, 0);
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
    assert.equal((await h.wait(row => row.id === 1)).error.message, 'PROCESSING_REVIEW_INTERRUPTED');
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
    if (action === 'disconnect') assert.equal((await h.wait(row => row.id === 1)).error.message, 'PROCESSING_REVIEW_INTERRUPTED');
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
  assert.equal(result.error.message, 'PROCESSING_REVIEW_TOO_LARGE');
  assert.equal(h.rows.some(row => row.method === 'elicitation/create'), false); await h.end();
});

test('edited or missing preview cannot accompany a native decision', async t => {
  for (const changes of [undefined, '', 'Changed preview']) await t.test(String(changes), async t => {
    let decisions = 0;
    const h = await duplexReview(t, { review: async ({ elicit }) => {
      await elicit({ message: 'Exact synthetic proposal' }); decisions++; return { status: 'completed', nextAction: 'none' };
    } });
    const form = await h.wait(row => row.method === 'elicitation/create');
    h.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { changes, decision: 'save' } } });
    assert.equal((await h.wait(row => row.id === 1)).error.message,
      changes === undefined ? 'PROCESSING_REVIEW_INTERRUPTED' : 'PROCESSING_REVIEW_PREVIEW_CHANGED');
    assert.equal(decisions, 0); await h.end();
  });
});

test('large UTF-8 preview echoes are bounded separately from ordinary requests', async t => {
  const preview = '# Synthetic review\n' + 'café 🌳\n'.repeat(8000);
  assert(Buffer.byteLength(preview) > 64 * 1024);
  for (const kind of ['host response', 'ordinary method', 'oversized host response']) await t.test(kind, async t => {
    let decisions = 0;
    const h = await duplexReview(t, { review: async ({ elicit }) => {
      const result = await elicit({ message: preview });
      assert.deepEqual(result, { action: 'accept', content: { decision: 'skip' } });
      decisions++; return { status: 'completed', nextAction: 'none' };
    } });
    const form = await h.wait(row => row.method === 'elicitation/create');
    assert.equal(form.params.requestedSchema.properties.changes.default, preview);
    const result = withReviewPreview(form, { action: 'accept', content: { decision: 'skip' } });
    if (kind === 'oversized host response') result.content.changes = 'x'.repeat(256 * 1024 + 1);
    h.send(kind === 'ordinary method'
      ? { jsonrpc: '2.0', id: 2, method: 'ping', params: { text: preview } }
      : { jsonrpc: '2.0', id: form.id, result });
    if (kind === 'host response') {
      assert.equal(view(await h.wait(row => row.id === 1)).status, 'completed'); assert.equal(decisions, 1);
    } else if (kind === 'oversized host response') {
      assert.equal((await h.wait(row => row.id === 1)).error.message, 'PROCESSING_REVIEW_TOO_LARGE');
      assert.equal(decisions, 0);
      h.send({ jsonrpc: '2.0', id: 90, method: 'ping' }); assert.deepEqual((await h.wait(row => row.id === 90)).result, {});
    } else {
      await assert.rejects(h.running, { code: 'PROCESSING_CONTROL_INPUT_LIMIT' }); assert.equal(decisions, 0); return;
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
    assert.equal(result.rows[1].error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(result.calls.length, 0);
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
    'STALE_SELECTION', 'PROCESSING_CHAT_REQUEST_CONFLICT', 'PROCESSING_SOURCE_DISCOVERY_LIMIT']) await t.test(code, async () => {
    const result = await server([initialize, tool('process_selected_captures', { collectionId: 'example' })], {
      requestProcessing: async () => { throw Object.assign(new Error('private source bytes'), { code }); }
    });
    assert.equal(result.rows[1].error.message, code); assert(!JSON.stringify(result.rows).includes('private source'));
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
    else { assert.equal(result.error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(dispatches, 0); }
    if (attack === 'replay' || attack === 'pending') {
      send({ ...tool('process_selected_captures', args, { ...nextContext, itemId: 'ctc_later', callId: `exec-${randomUUID()}` }), id: 3 });
      assert.equal((await wait(3)).error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED'); assert.equal(dispatches, attack === 'replay' ? 1 : 0);
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
      assert.equal(result.error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
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
  assert.equal((await h.call(17)).error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.equal(h.counts().dispatches, 0);
  now += 60_000;
  assert.equal(view(await h.call(18)).status, 'verification-required');
  const before = h.counts();
  assert.equal((await h.call(19, { retryToken: tokens[0] })).error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.deepEqual(h.counts(), before); assert.equal(before.dispatches, 0);
});

test('invalid native settle options retain their request error through MCP', async () => {
  const { resolveProcessingInvocation } = await import('./processing-native-invocation.mjs');
  for (const settleMs of [-1, 1500, 0.5, '100', NaN]) {
    const result = await server([initialize, tool('processing_status', {})], {
      resolveSource: (context, invocation) => resolveProcessingInvocation(null, context, invocation, { settleMs })
    });
    assert.equal(result.rows[1].error.message, 'PROCESSING_CONTROL_INVALID_REQUEST');
    assert.deepEqual(result.calls, []);
  }
});

test('a token expiring while native records settle cannot dispatch', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const h = await handshakeHarness(t, { onComplete: () => { now += 1; } });
  const token = view(await h.call(1)).retryToken; now += 59_999;
  assert.equal((await h.call(2, { retryToken: token })).error.message, 'PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  assert.deepEqual(h.counts(), { resolutions: 2, dispatches: 0 });
});
