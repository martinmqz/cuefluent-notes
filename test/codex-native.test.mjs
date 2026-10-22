import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm, realpath, rename, readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createCodexNativeAdapter, CODEX_NATIVE_ARGUMENTS } from '../src/client/codex-native.mjs';
import { openTranscript } from '../src/client/source.mjs';

const id = 'synthetic-thread', turn = 'synthetic-turn';
const meta = { 'x-codex-turn-metadata': { session_id: id, thread_id: id, turn_id: turn } };
const selection = { name: 'notes', skillPath: path.resolve('synthetic-skill/SKILL.md') };
const user = (text = 'process') => ({ turnId: turn, item: { type: 'userMessage', id: 'item-1', content: [
  { type: 'skill', name: selection.name, path: selection.skillPath }, { type: 'text', text, text_elements: [] },
] } });
function fixture(options = {}) {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id, path: options.sourcePath ?? path.resolve('absent-native-source'), cwd: process.cwd(), turns: [], parentThreadId: null, ...options.thread } };
    if (method === 'thread/turns/list') return options.turns ? options.turns(params) : { data: [{ id: turn, items: [], itemsView: 'notLoaded', status: 'inProgress' }], nextCursor: null };
    assert.equal(method, 'thread/items/list');
    return options.items ? options.items(params) : { data: [user()], nextCursor: null };
  };
  return { adapter: createCodexNativeAdapter({ request, ...options.adapter }), calls };
}
async function temporary(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cuefluent-native-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function physical(directory, name, ordinal, threadId = id) {
  const file = path.join(directory, name);
  const bytes = Buffer.from(JSON.stringify({ type: 'session_meta', ordinal, payload: { id: threadId } }) + '\n');
  await writeFile(file, bytes, { mode: 0o600 });
  const source = await openTranscript(file), identity = source.identity; await source.close();
  return { path: file, identity, bytes };
}

test('binds only exact transport turn and selected native skill without opening transcript', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.bindCommand(meta, selection);
  assert.equal(result.status, 'ready'); assert.equal(result.binding.action, 'process');
  assert.equal(result.binding.sessionId, id); assert.equal(result.binding.promptId, turn);
  assert.deepEqual(calls.map(call => call.method), ['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/read', 'thread/turns/list']);
  assert.deepEqual(calls[1].params, { threadId: id, sortDirection: 'desc', limit: 1, itemsView: 'notLoaded' });
  assert.deepEqual(calls[2].params, { threadId: id, turnId: turn, sortDirection: 'asc', limit: 8, cursor: null });
  assert.equal(calls[0].params.includeTurns, false);
  await adapter.close(); await assert.rejects(adapter.bindCommand(meta, selection), { code: 'NATIVE_READER_CLOSED' });
});

test('unavailable or ambiguous exact user items stay pending', async () => {
  for (const [data, reason] of [[[], 'NATIVE_COMMAND_ITEMS_PENDING'], [[user(), { ...user(), item: { ...user().item, id: 'item-2' } }], 'NATIVE_COMMAND_AMBIGUOUS']]) {
    const { adapter } = fixture({ items: () => ({ data, nextCursor: null }) });
    assert.deepEqual(await adapter.bindCommand(meta, selection), { status: 'pending', reason }); await adapter.close();
  }
});

test('rejects mismatched transport, native thread/turn and skill selection', async () => {
  const cases = [
    { input: { ...meta, threadId: 'other' }, code: 'NATIVE_COMMAND_MISMATCH' },
    { input: { 'x-codex-turn-metadata': { session_id: 'root', thread_id: id, turn_id: turn } }, code: 'NATIVE_CONTEXT_UNSUPPORTED' },
    { thread: { id: 'other' }, code: 'NATIVE_SOURCE_IDENTITY_MISMATCH' },
    { items: () => ({ data: [{ ...user(), turnId: 'other' }], nextCursor: null }), code: 'NATIVE_COMMAND_MISMATCH' },
    { items: () => ({ data: [{ ...user(), item: { ...user().item, content: [{ type: 'text', text: '/notes process' }] } }], nextCursor: null }), code: 'NATIVE_COMMAND_MISMATCH' },
  ];
  for (const entry of cases) {
    const { adapter } = fixture(entry); await assert.rejects(adapter.bindCommand(entry.input ?? meta, selection), { code: entry.code }); await adapter.close();
  }
});

test('does not evaluate transport accessors and refuses subagents and hydrated history', async () => {
  let accessed = false;
  const { adapter } = fixture();
  await assert.rejects(adapter.bindCommand(Object.defineProperty({}, 'x-codex-turn-metadata', { get() { accessed = true; } }), selection), { code: 'NATIVE_CONTEXT_INVALID' });
  assert.equal(accessed, false); await adapter.close();
  const subagent = fixture({ thread: { parentThreadId: 'parent' } });
  assert.equal((await subagent.adapter.bindCommand(meta, selection)).reason, 'NATIVE_SUBAGENT_UNSUPPORTED'); assert.equal(subagent.calls.length, 1); await subagent.adapter.close();
  const hydrated = fixture({ thread: { turns: [{}] } });
  await assert.rejects(hydrated.adapter.bindCommand(meta, selection), { code: 'NATIVE_RESPONSE_INVALID' }); await hydrated.adapter.close();
});

test('exact turn pagination is bounded and rejects repeated cursors', async () => {
  let sequence = 0;
  const bounded = fixture({ items: () => ({ data: [], nextCursor: `page-${++sequence}` }), adapter: { itemPages: 2 } });
  assert.equal((await bounded.adapter.bindCommand(meta, selection)).reason, 'NATIVE_COMMAND_PAGE_LIMIT');
  assert.equal(bounded.calls.length, 4); await bounded.adapter.close();
  const repeated = fixture({ items: () => ({ data: [], nextCursor: 'same' }) });
  await assert.rejects(repeated.adapter.bindCommand(meta, selection), { code: 'NATIVE_RESPONSE_INVALID' }); await repeated.adapter.close();
});

test('native metadata changing during item resolution stays pending', async () => {
  let reads = 0;
  const adapter = createCodexNativeAdapter({ request: async method => method === 'thread/read'
    ? { thread: { id, path: path.resolve(`source-${++reads}`), cwd: process.cwd(), turns: [] } }
    : method === 'thread/turns/list' ? { data: [{ id: turn, items: [], itemsView: 'notLoaded', status: 'inProgress' }] }
    : { data: [user()], nextCursor: null } });
  assert.equal((await adapter.bindCommand(meta, selection)).reason, 'NATIVE_COMMAND_SOURCE_CHANGED'); await adapter.close();
});

test('stored earlier commands fail current-turn check without reading their items', async () => {
  const { adapter, calls } = fixture({ turns: () => ({ data: [{ id: 'newer-turn', items: [], itemsView: 'notLoaded', status: 'completed' }] }) });
  assert.deepEqual(await adapter.bindCommand(meta, selection), { status: 'pending', reason: 'NATIVE_COMMAND_NOT_CURRENT' });
  assert.equal(calls.length, 2); await adapter.close();
});

test('missing or unsupported latest-turn metadata stays pending, never infers UUID order', async () => {
  for (const turns of [() => ({ data: [] }), () => { throw Object.assign(new Error('not available'), { code: 'NATIVE_RPC_UNAVAILABLE' }); }]) {
    const { adapter } = fixture({ turns }); assert.deepEqual(await adapter.bindCommand(meta, selection), { status: 'pending', reason: 'NATIVE_COMMAND_CURRENT_PENDING' }); await adapter.close();
  }
});

test('a turn advancing during exact item lookup fails final current-turn recheck', async () => {
  let reads = 0;
  const { adapter } = fixture({ turns: () => ({ data: [{ id: ++reads === 1 ? turn : 'newer-turn', items: [], itemsView: 'notLoaded', status: 'inProgress' }] }) });
  assert.equal((await adapter.bindCommand(meta, selection)).reason, 'NATIVE_COMMAND_NOT_CURRENT'); await adapter.close();
});

test('current-turn metadata refuses hydrated content and malformed bounds', async () => {
  for (const data of [[{ id: turn, items: [user().item], itemsView: 'full', status: 'inProgress' }], [{ id: turn, items: [], itemsView: 'notLoaded', status: 'inProgress' }, { id: 'other' }]]) {
    const { adapter } = fixture({ turns: () => ({ data }) });
    await assert.rejects(adapter.bindCommand(meta, selection), { code: 'NATIVE_RESPONSE_INVALID' }); await adapter.close();
  }
});

test('active native path wins; exact previous inode remains available for same-ID revert', async t => {
  const directory = await temporary(t), old = await physical(directory, 'old.jsonl', 1), active = await physical(directory, 'active.jsonl', 5);
  const { adapter } = fixture({ sourcePath: active.path });
  const current = await adapter.resolveNativeSource({ client: 'codex', sessionId: id, previous: old, before: null, excludeIdentity: null });
  assert.equal(current.path, active.path);
  const history = await adapter.resolveNativeSource({ client: 'codex', sessionId: id, before: { ordinalExclusive: 5, byteOffset: old.bytes.length }, excludeIdentity: current.source.identity });
  assert.equal(history.path, old.path); assert.deepEqual(history.source.identity, old.identity);
  await history.source.close(); await current.source.close(); await adapter.close();
});

test('unknown historical source is pending; explicit retained capability is sufficient', async t => {
  const directory = await temporary(t), old = await physical(directory, 'old.jsonl', 1), active = await physical(directory, 'active.jsonl', 5);
  const input = { client: 'codex', sessionId: id, before: { ordinalExclusive: 5, byteOffset: old.bytes.length }, excludeIdentity: active.identity };
  const unknown = fixture({ sourcePath: active.path }); assert.equal(await unknown.adapter.resolveNativeSource(input), null); await unknown.adapter.close();
  const known = fixture({ sourcePath: active.path, adapter: { knownSources: [{ sessionId: id, ...old }] } });
  const found = await known.adapter.resolveNativeSource(input); assert.equal(found.path, old.path); await found.source.close(); await known.adapter.close();
});

test('wrong physical header cannot acquire native source authority', async t => {
  const directory = await temporary(t), other = await physical(directory, 'wrong.jsonl', 1, 'other');
  const { adapter } = fixture({ sourcePath: other.path });
  await assert.rejects(adapter.resolveNativeSource({ client: 'codex', sessionId: id, before: null, previous: null }), { code: 'NATIVE_SOURCE_IDENTITY_MISMATCH' }); await adapter.close();
});

test('retained historical path replacement fails exact inode verification', async t => {
  const directory = await temporary(t), old = await physical(directory, 'old.jsonl', 1), active = await physical(directory, 'active.jsonl', 5);
  await rename(old.path, path.join(directory, 'saved.jsonl')); await physical(directory, 'old.jsonl', 1);
  const { adapter } = fixture({ sourcePath: active.path, adapter: { knownSources: [{ sessionId: id, ...old }] } });
  await assert.rejects(adapter.resolveNativeSource({ client: 'codex', sessionId: id, before: { ordinalExclusive: 5, byteOffset: old.bytes.length }, excludeIdentity: active.identity }), { code: 'SOURCE_IDENTITY_CHANGED' });
  await adapter.close();
});

async function subprocess(t, mode = 'normal', overrides = {}) {
  const directory = await temporary(t), script = path.join(directory, 'server.mjs');
  await writeFile(script, `import readline from 'node:readline';
const mode=${JSON.stringify(mode)};let initialized=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);if(!x.id)return;
 if(mode==='timeout')return;
 if(mode==='request'){console.log(JSON.stringify({id:999,method:'command/exec',params:{command:'NEVER'}}));return;}
 if(mode==='oversize'){console.log('x'.repeat(4096));return;}
 if(mode==='invalid'){console.log('{private native content');return;}
 if(mode==='init-error'&&x.method==='initialize'){console.log(JSON.stringify({id:x.id,error:{code:-32000,message:'Synthetic startup unavailable'}}));return;}
 if(x.method==='initialize'){initialized=true;console.log(JSON.stringify({id:x.id,result:{}}));return;}
 if(!initialized||!['thread/read','thread/items/list','thread/turns/list'].includes(x.method))process.exit(7);
 const result=x.method==='thread/read'?{thread:{id:${JSON.stringify(id)},path:${JSON.stringify(path.join(directory, 'absent.jsonl'))},cwd:${JSON.stringify(directory)},turns:[]}}:x.method==='thread/turns/list'?{data:[{id:${JSON.stringify(turn)},items:[],itemsView:'notLoaded',status:'inProgress'}]}:{data:[${JSON.stringify(user())}],nextCursor:null};
 console.log(JSON.stringify({id:x.id,result}));
});`);
  let args, child;
  const adapter = createCodexNativeAdapter({ command: process.execPath, spawn(command, argv, options) { args = argv; child = spawn(process.execPath, [script], options); return child; }, ...overrides });
  t.after(() => adapter.close());
  return { adapter, script, args: () => args, child: () => child };
}

test('default subprocess initializes and performs only stored reads with fixed flags', async t => {
  const probe = await subprocess(t); assert.equal((await probe.adapter.bindCommand(meta, selection)).status, 'ready');
  assert.deepEqual(probe.args(), CODEX_NATIVE_ARGUMENTS); await probe.adapter.close(); assert.notEqual(probe.child().exitCode, undefined);
});

for (const [mode, code, overrides] of [['request', 'NATIVE_UNEXPECTED_REQUEST', {}], ['invalid', 'NATIVE_RESPONSE_INVALID', {}], ['oversize', 'NATIVE_RESPONSE_LIMIT', { responseBytes: 1024 }], ['timeout', 'NATIVE_READER_TIMEOUT', { timeoutMs: 100 }]]) {
  test(`subprocess rejects ${mode} without leaking native output or granting requests`, async t => {
    const { adapter } = await subprocess(t, mode, overrides);
    await assert.rejects(adapter.bindCommand(meta, selection), error => error.code === code && !error.message.includes('private native content'));
    await adapter.close();
  });
}


test('a failed app-server is retired and the next command gets a fresh reader', async t => {
  const probe = await subprocess(t, 'invalid');
  await assert.rejects(probe.adapter.bindCommand(meta, selection), { code: 'NATIVE_RESPONSE_INVALID' });
  const old = probe.child();
  await writeFile(probe.script, (await readFile(probe.script, 'utf8')).replace('const mode="invalid"', 'const mode="normal"'));
  const results = await Promise.all([probe.adapter.bindCommand(meta, selection), probe.adapter.bindCommand(meta, selection)]);
  assert.ok(results.every(result => result.status === 'ready')); assert.notEqual(probe.child(), old);
  assert.ok(old.exitCode !== null || old.signalCode !== null);
  await probe.adapter.close();
  await assert.rejects(probe.adapter.bindCommand(meta, selection), { code: 'NATIVE_READER_CLOSED' });
});

test('Windows metadata reader resolves the npm vendor executable before spawning', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporary(t), wrapper = path.join(directory, 'codex.cmd');
  await writeFile(wrapper, 'This shim must never execute.');
  const arch = process.arch, triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
  const pkg = path.join(directory, 'node_modules', '@openai', `codex-win32-${arch}`);
  const executable = path.join(pkg, 'vendor', triple, 'codex', 'codex.exe');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.163.0' }));
  await writeFile(executable, 'Synthetic executable file; spawn is intercepted.');
  const { executablePath } = await import('../src/client/executable.mjs');
  assert.equal(await executablePath(wrapper), executable);
  const probe = await subprocess(t, 'normal', { command: wrapper });
  assert.equal((await probe.adapter.bindCommand(meta, selection)).status, 'ready');
});


test('an initialization RPC rejection retires the reader before the next command', async t => {
  const probe = await subprocess(t, 'init-error');
  await assert.rejects(probe.adapter.bindCommand(meta, selection), { code: 'NATIVE_RPC_UNAVAILABLE' });
  const old = probe.child();
  await writeFile(probe.script, (await readFile(probe.script, 'utf8')).replace('const mode="init-error"', 'const mode="normal"'));
  assert.equal((await probe.adapter.bindCommand(meta, selection)).status, 'ready');
  assert.notEqual(probe.child(), old);
});
