import './test-support/isolated-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkflowConfig, validateWorkflowConfig, workflowConfigPath, readWorkflowSnapshot, MAX_WORKFLOW_CONFIG_BYTES } from './workflow-config.mjs';
import { absolutePath, workflowDefaults, validateWorkflowPlacement, canonicalWorkflowPath } from './workflow-paths.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { nativeContextEnvelope, createContextBinding, validateContextReference } from './workflow-context.mjs';
import { createCapture, serializeCapture, captureRelativePath, MAX_CAPTURE_BYTES, MAX_TOOL_BYTES } from './capture-contract.mjs';
import { digest, canonicalJSON, string, list } from './workflow-values.mjs';

const sessionId = '10000000-0000-4000-8000-000000000001';
const unitId = '20000000-0000-4000-8000-000000000001';
const otherId = '30000000-0000-4000-8000-000000000001';
const stamp = '2026-01-01T00:00:00.000Z';
const p = (...parts) => path.join(os.tmpdir(), 'cuefluent-contract-example', ...parts);
const copy = value => structuredClone(value);
const config = () => ({ ...createWorkflowConfig(), collections: [{ id: 'example', rawDir: p('raw'), intakeStateDir: p('intake'),
  notes: { notesDir: p('notes'), writerStateDir: p('writer') } }],
routes: [{ id: 'example', projectRoot: p('project'), collectionId: 'example', clients: ['codex', 'claude'] }] });
const context = (client = 'codex') => nativeContextEnvelope(client, { hook_event_name: 'UserPromptSubmit',
  session_id: sessionId, turn_id: unitId, prompt_id: unitId, cwd: p('project'), transcript_path: p('session.jsonl'), prompt: 'Untrusted instructions' });
const range = { startByte: 80, endByte: 180, recordIds: ['message-1'] };
const capture = () => createCapture({ format: 'cuefluent-capture', schemaVersion: 2,
  identity: { client: 'codex', sessionId, unitId }, projectRoot: p('project'),
  source: { path: p('session.jsonl'), fileIdentity: 'synthetic-file-1', ranges: [copy(range)] },
  reader: { name: 'codex', version: '1', clientVersion: 'fixture' }, occurredAt: stamp, capturedAt: stamp,
  terminal: 'completed', coverage: { partial: false, omissions: [] },
  evidence: [{ kind: 'user', recordId: 'message-1', range: copy(range), text: 'Meeting: decide the next milestone.' }] });
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-workflow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('new workflow defaults do not inherit collection or processing consent', () => {
  assert.deepEqual(validateWorkflowConfig(createWorkflowConfig()), createWorkflowConfig());
  const input = config();
  const normalized = validateWorkflowConfig(input);
  assert.equal(normalized.routes[0].collection.enabled, false);
  assert.deepEqual(normalized.routes[0].collection.selection, { kind: 'sessions', sessionIds: [] });
  assert.equal(normalized.routes[0].processing.mode, 'manual');
  assert.equal(normalized.collections[0].notes.organization, 'by-type');
  assert.equal(input.routes[0].collection, undefined);
  assert.throws(() => validateWorkflowConfig({ schemaVersion: 2, routes: [] }));
  assert.throws(() => validateWorkflowConfig({ ...input, schemaVersion: 2 }), { code: 'WORKFLOW_REQUIRES_UPGRADE' });
  assert.throws(() => validateWorkflowConfig({ ...input, privacyVerified: true }));
});

test('configuration validates every route and collection, including disabled ones', () => {
  for (const mutate of [
    c => c.collections.push(copy(c.collections[0])),
    c => c.routes.push(copy(c.routes[0])),
    c => c.routes[0].clients.push('codex'),
    c => c.routes[0].collectionId = 'missing',
    c => c.routes[0].collection = { enabled: false, selection: { kind: 'sessions', sessionIds: ['latest'] } },
    c => c.routes[0].processing = { mode: 'suggestions' },
    c => c.collections[0].notes.destination = p('both.md'),
    c => c.collections[0].notes = { destination: p('notes.txt'), writerStateDir: p('writer') },
    c => c.collections[0].notes = { destination: p('notes.md'), writerStateDir: p('writer'), organization: 'flat' },
    c => c.collections[0].intakeStateDir = 'relative',
    c => c.routes[0].collection = null,
    c => c.routes[0].collection = { selection: null },
    c => c.routes[0].processing = null,
    c => c.routes[0].processing = { mode: null },
    c => c.collections[0].notes.organization = null,
  ]) {
    const input = config(); mutate(input); assert.throws(() => validateWorkflowConfig(input));
  }
  const input = config();
  input.collections[0].notes = { destination: p('specific.md'), writerStateDir: p('writer') };
  assert.deepEqual(validateWorkflowConfig(input).collections[0].notes, input.collections[0].notes);
});

test('platform defaults keep all private roots together and preserve override precedence', async () => {
  const options = { platform: 'win32', home: 'C:\\Users\\Example',
    env: { LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local' }, collectionId: 'example',
    explicit: 'C:\\Users\\Example\\.cuefluent-notes\\workflow.json' };
  const windows = await workflowDefaults(options);
  const root = 'C:\\Users\\Example\\.cuefluent-notes\\collections\\example';
  assert.equal(windows.intakeStateDir, root + '\\state');
  assert.equal(windows.rawDir, root + '\\.cuefluent-raw');
  assert.equal(windows.writerStateDir, root + '\\writer');
  const old = await workflowDefaults({ ...options, explicit: options.env.LOCALAPPDATA + '\\CuefluentNotes\\workflow.json' });
  assert.equal(old.intakeStateDir, options.env.LOCALAPPDATA + '\\CuefluentNotes\\collections\\example\\state');
  await assert.rejects(workflowDefaults({ platform: 'win32', env: {} }), { code: 'LOCAL_STATE_LOCATION_REQUIRED' });
  await assert.rejects(workflowDefaults({ platform: 'win32', home: options.home, env: { LOCALAPPDATA: '\\\\server\\share' } }), { code: 'LOCAL_STATE_LOCATION_REQUIRED' });
  const mac = await workflowDefaults({ platform: 'darwin', home: '/Users/example', env: {}, collectionId: 'example' });
  assert.equal(mac.intakeStateDir, '/Users/example/Library/Application Support/Cuefluent Notes/collections/example/state');
  assert.equal(mac.rawDir, '/Users/example/Library/Application Support/Cuefluent Notes/collections/example/.cuefluent-raw');
  assert.equal(mac.writerStateDir, '/Users/example/Library/Application Support/Cuefluent Notes/collections/example/writer');
  const linux = await workflowDefaults({ platform: 'linux', home: '/home/example', env: { XDG_STATE_HOME: '/local/state' }, collectionId: 'example' });
  assert.equal(linux.rawDir, '/local/state/cuefluent-notes/collections/example/.cuefluent-raw');
  assert.equal(await workflowConfigPath({ platform: 'linux', home: '/home/example', env: { CUEFLUENT_NOTES_CONFIG: '/legacy.json' } }), '/home/example/.config/cuefluent-notes/workflow.json');
  assert.equal(await workflowConfigPath({ platform: 'linux', env: { CUEFLUENT_WORKFLOW_CONFIG: '/new.json' } }), '/new.json');
  assert.equal(absolutePath('C:\\資料\\notes', 'win32'), 'C:\\資料\\notes');
  assert.throws(() => absolutePath('C:\\notes\\file:stream', 'win32'));
});

test('snapshot is bounded, hashes exact bytes, and missing setup creates nothing', async t => {
  const dir = await temporary(t), file = path.join(dir, 'missing', 'workflow.json');
  assert.deepEqual(await readWorkflowSnapshot(file), { config: null, hash: null });
  assert.deepEqual(await fs.readdir(dir), []);
  const existing = path.join(dir, 'workflow.json'), bytes = JSON.stringify(config(), null, 2) + '\n';
  await fs.writeFile(existing, bytes);
  assert.equal((await readWorkflowSnapshot(existing)).hash, digest(bytes));
  await fs.writeFile(existing, Buffer.alloc(MAX_WORKFLOW_CONFIG_BYTES + 1));
  await assert.rejects(readWorkflowSnapshot(existing), { code: 'WORKFLOW_CONFIG_UNAVAILABLE' });
  await fs.writeFile(existing, Buffer.from([0xff]));
  await assert.rejects(readWorkflowSnapshot(existing), { code: 'INVALID_WORKFLOW' });
  await assert.rejects(readWorkflowSnapshot(dir), { code: 'WORKFLOW_CONFIG_UNAVAILABLE' });
  await assert.rejects(readWorkflowSnapshot(path.join(dir, 'package', 'workflow.json'), { packageRoot: path.join(dir, 'package') }), { code: 'WORKFLOW_STORAGE_OVERLAP' });
});

test('selected links are refused but missing descendants of directory aliases resolve', async t => {
  const dir = await temporary(t), real = path.join(dir, 'real'), alias = path.join(dir, 'alias');
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await canonicalWorkflowPath(path.join(alias, 'missing', 'notes')), path.join(await fs.realpath(real), 'missing', 'notes'));
  await assert.rejects(canonicalWorkflowPath(alias), { code: 'UNSAFE_WORKFLOW_PATH' });
  const original = path.join(real, 'workflow.json'), linked = path.join(dir, 'linked.json');
  await fs.writeFile(original, JSON.stringify(config()));
  // Hard links are available without symlink privileges on Windows too.
  await fs.link(original, linked);
  await assert.rejects(readWorkflowSnapshot(linked), { code: 'WORKFLOW_CONFIG_UNAVAILABLE' });
});

test('routing selects the longest canonical project and never grants a storage capability', async () => {
  const input = config();
  input.routes[0].collection = { enabled: true, selection: { kind: 'project' } };
  input.routes[0].processing = { mode: 'automatic' };
  const native = { client: 'codex', sessionId, cwd: p('project', 'nested') };
  const options = { canonicalize: async value => value };
  const selected = await resolveWorkflowRoute(input, native, options);
  assert.deepEqual(selected.intended, { collect: true, process: true, explicitProcess: true, explicitCollect: true });
  assert.deepEqual(selected.runtime, { collect: false, process: false, reason: 'STORAGE_NOT_VERIFIED' });
  input.routes.push({ ...input.routes[0], id: 'excluded', projectRoot: native.cwd, excluded: true });
  const excluded = await resolveWorkflowRoute(input, native, options);
  assert.equal(excluded.status, 'excluded');
  assert.deepEqual(excluded.intended, { collect: false, process: false, explicitProcess: false, explicitCollect: false });
  input.routes[1].projectRoot = p('project');
  await assert.rejects(resolveWorkflowRoute(input, native, options), { code: 'AMBIGUOUS_WORKFLOW_ROUTE' });
});

test('processing remains independent of ongoing collection and native session selection', async () => {
  const input = config(), native = { client: 'claude', sessionId, cwd: p('project') };
  input.routes[0].collection = { enabled: true, selection: { kind: 'sessions', sessionIds: [otherId] } };
  input.routes[0].processing = { mode: 'prompted' };
  const selected = await resolveWorkflowRoute(input, native, { canonicalize: async value => value });
  assert.deepEqual(selected.intended, { collect: false, process: true, explicitProcess: true, explicitCollect: true });
  input.routes[0].collection.enabled = false;
  input.routes[0].processing.mode = 'manual';
  assert.deepEqual((await resolveWorkflowRoute(input, native, { canonicalize: async value => value })).intended,
    { collect: false, process: false, explicitProcess: true, explicitCollect: true });
  let reads = 0;
  assert.equal((await resolveWorkflowRoute(null, native, { canonicalize: async () => { reads++; } })).status, 'unconfigured');
  assert.equal(reads, 0);
});

test('routing rejects ambiguous aliases, unreadable narrower roots, and file cwd', async t => {
  const input = config(), native = { client: 'codex', sessionId, cwd: p('project') };
  input.routes.push({ ...input.routes[0], id: 'second', projectRoot: p('alias') });
  await assert.rejects(resolveWorkflowRoute(input, native, { canonicalize: async () => p('project') }), { code: 'AMBIGUOUS_WORKFLOW_ROUTE' });
  await assert.rejects(resolveWorkflowRoute(input, native, { canonicalize: async value => {
    if (value === p('alias')) throw Object.assign(new Error(), { code: 'EACCES' }); return value;
  } }), { code: 'WORKFLOW_ROUTE_UNAVAILABLE' });
  const dir = await temporary(t), file = path.join(dir, 'file'); await fs.writeFile(file, '');
  await assert.rejects(resolveWorkflowRoute(config(), { ...native, cwd: file }), { code: 'WORKFLOW_ROUTE_UNAVAILABLE' });
});

test('placement prohibits private/notes/project overlaps and protects shared writer identity', async () => {
  const input = validateWorkflowConfig(config()), options = { canonicalize: async value => value, packageRoot: p('package') };
  assert.equal((await validateWorkflowPlacement(input, options)).privacy, 'unverified');
  for (const mutate of [
    c => c.collections[0].rawDir = p('project', 'captures'),
    c => c.collections[0].intakeStateDir = p('notes', 'state'),
    c => c.collections[0].notes.notesDir = p('package', 'notes'),
    c => c.collections[0].rawDir = p('intake', 'raw'),
  ]) {
    const changed = copy(input); mutate(changed);
    await assert.rejects(validateWorkflowPlacement(changed, options), { code: 'WORKFLOW_STORAGE_OVERLAP' });
  }
  const second = { id: 'second', rawDir: p('raw-second'), intakeStateDir: p('intake-second'),
    notes: { destination: p('notes', 'specific.md'), writerStateDir: p('writer-other') } };
  input.collections.push(second);
  await assert.rejects(validateWorkflowPlacement(input, options), { code: 'WORKFLOW_WRITER_CONFLICT' });
  second.notes.writerStateDir = p('writer');
  assert.equal((await validateWorkflowPlacement(input, options)).collections.length, 2);
});

test('explicit files use their parent collection for writer sharing', async () => {
  const input = validateWorkflowConfig(config()), options = { canonicalize: async value => value, packageRoot: p('package') };
  input.collections[0].notes = { destination: p('notes', 'first.md'), writerStateDir: p('writer') };
  for (const destination of [{ destination: p('notes', 'second.md') }, { notesDir: p('notes', 'meetings'), organization: 'by-type' }]) {
    input.collections[1] = { id: 'second', rawDir: p('raw-second'), intakeStateDir: p('intake-second'), notes: { ...destination, writerStateDir: p('writer-other') } };
    await assert.rejects(validateWorkflowPlacement(input, options), { code: 'WORKFLOW_WRITER_CONFLICT' });
    input.collections[1].notes.writerStateDir = p('writer');
    await validateWorkflowPlacement(input, options);
  }
});

test('home-level explicit notes allow sibling private state but reject actual note overlap', async () => {
  const input = validateWorkflowConfig(config()), options = { canonicalize: async value => value,
    packageRoot: p('home', 'plugins', 'cuefluent'), configPath: p('home', '.config', 'workflow.json') };
  const c = input.collections[0];
  c.rawDir = p('home', '.local', 'raw'); c.intakeStateDir = p('home', '.local', 'intake');
  c.notes = { destination: p('home', 'notes.md'), writerStateDir: p('home', '.local', 'writer') };
  await validateWorkflowPlacement(input, options);
  for (const destination of [options.configPath, p('home', '.local', 'raw', 'notes.md'), p('home', 'plugins', 'cuefluent', 'notes.md')]) {
    const changed = copy(input); changed.collections[0].notes.destination = destination;
    await assert.rejects(validateWorkflowPlacement(changed, options), { code: 'WORKFLOW_STORAGE_OVERLAP' });
  }
  c.notes = { notesDir: p('home'), writerStateDir: c.notes.writerStateDir };
  await assert.rejects(validateWorkflowPlacement(input, options), { code: 'WORKFLOW_STORAGE_OVERLAP' });
});

test('notes may live in a selected or excluded project; private data and config cannot', async () => {
  const input = validateWorkflowConfig(config()), options = { canonicalize: async value => value, packageRoot: p('package'), configPath: p('settings', 'workflow.json') };
  input.collections[0].notes.notesDir = p('project', 'docs');
  await validateWorkflowPlacement(input, options);
  input.routes[0].excluded = true;
  await validateWorkflowPlacement(input, options);
  for (const configPath of [p('project', 'workflow.json'), p('project', 'docs', 'workflow.json'), p('intake', 'workflow.json'), p('package', 'workflow.json')]) {
    await assert.rejects(validateWorkflowPlacement(input, { ...options, configPath }), { code: 'WORKFLOW_STORAGE_OVERLAP' });
  }
});

test('macOS placement rejects case-only missing suffix overlaps', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await temporary(t), input = validateWorkflowConfig(config());
  input.collections[0].rawDir = path.join(dir, 'Archive');
  input.collections[0].intakeStateDir = path.join(dir, 'archive', 'state');
  await assert.rejects(validateWorkflowPlacement(input), { code: 'WORKFLOW_STORAGE_OVERLAP' });
});

test('native adapters discard source prose and refuse missing or child identities', () => {
  for (const client of ['codex', 'claude']) {
    const envelope = context(client);
    assert.equal(envelope.unitId, unitId);
    assert.equal(envelope.prompt, undefined);
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: p('project'), turn_id: unitId, prompt_id: unitId };
    assert.throws(() => nativeContextEnvelope(client, { ...payload, agent_id: 'child' }), { code: 'UNSUPPORTED_NATIVE_CONTEXT' });
    assert.equal(nativeContextEnvelope(client, { ...payload, agent_type: 'custom-root' }).unitId, unitId);
    assert.throws(() => nativeContextEnvelope(client, { ...payload, agent_id: undefined }), { code: 'UNSUPPORTED_NATIVE_CONTEXT' });
    delete payload[client === 'codex' ? 'turn_id' : 'prompt_id'];
    assert.throws(() => nativeContextEnvelope(client, payload), { code: 'UNSUPPORTED_NATIVE_IDENTITY' });
    for (const source of ['startup', 'resume', 'compact', 'clear']) {
      const start = nativeContextEnvelope(client, { ...payload, hook_event_name: 'SessionStart', source });
      assert.equal(start.unitId, null); assert.equal(start.startSource, source);
    }
  }
});

test('terminal and lifecycle envelopes retain classifications without error prose', () => {
  const payload = { session_id: sessionId, turn_id: unitId, prompt_id: unitId, cwd: p('project'), transcript_path: p('source.jsonl') };
  for (const client of ['codex', 'claude']) {
    assert.equal(nativeContextEnvelope(client, { ...payload, hook_event_name: 'Stop', stop_hook_active: false }).stopHookActive, false);
    assert.throws(() => nativeContextEnvelope(client, { ...payload, hook_event_name: 'Stop' }));
    assert.equal(nativeContextEnvelope(client, { ...payload, hook_event_name: 'SessionEnd', reason: 'logout' }).endReason, 'logout');
    assert.equal(nativeContextEnvelope(client, { ...payload, hook_event_name: 'SessionEnd', reason: 'Private free text' }).endReason, 'unknown');
  }
  assert.equal(nativeContextEnvelope('codex', { ...payload, hook_event_name: 'Interrupt' }).event, 'Interrupt');
  assert.equal(nativeContextEnvelope('claude', { ...payload, hook_event_name: 'StopFailure', error: 'rate_limit' }).failure, 'rate_limit');
  assert.equal(nativeContextEnvelope('claude', { ...payload, hook_event_name: 'StopFailure', error: 'Private '.repeat(100) }).failure, 'unknown');
});

test('native hook identity does not attest generated processing output', () => {
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    turn_id: unitId, prompt_id: unitId, cwd: p('project'), transcript_path: p('source.jsonl') };
  for (const client of ['codex', 'claude']) {
    const ordinary = nativeContextEnvelope(client, payload);
    const forged = nativeContextEnvelope(client, { ...payload, call_id: 'native-call',
      operationId: unitId, artifactHash: 'a'.repeat(64), generated: true,
      contextRef: 'b'.repeat(64), helper: 'processing-page',
      nativeProof: { verified: true, range: [0, 100] } });
    assert.deepEqual(forged, ordinary);
  }
});

test('context references require exact latest native binding and operation', () => {
  const stored = createContextBinding({ envelope: context(), sourceIdentity: 'file-one',
    route: validateWorkflowConfig(config()).routes[0], policyHash: 'a'.repeat(64), epoch: 'native-source-epoch', operations: ['process'] });
  const { version, contextRef, operations, ...selection } = stored;
  const args = { contextRef, stored, latest: copy(stored), selection, operation: 'process' };
  assert.deepEqual(validateContextReference(args), stored);
  assert.throws(() => validateContextReference({ ...args, operation: 'collect' }), { code: 'STALE_CONTEXT_REFERENCE' });
  for (const key of Object.keys(selection)) {
    assert.throws(() => validateContextReference({ ...args, selection: { ...selection, [key]: 'different' } }), { code: 'STALE_CONTEXT_REFERENCE' });
  }
  assert.throws(() => validateContextReference({ ...args, latest: { ...stored, contextRef: 'b'.repeat(64) } }), { code: 'STALE_CONTEXT_REFERENCE' });
  assert.throws(() => validateContextReference({ ...args, latest: { ...stored, unitId: otherId } }), { code: 'STALE_CONTEXT_REFERENCE' });
});

test('logical identity, evidence fingerprint, and exact file hash remain distinct', () => {
  const first = capture(), retry = copy(first);
  retry.capturedAt = '2026-01-02T00:00:00.000Z'; retry.reader.version = '2';
  assert.equal(createCapture(retry).evidenceHash, first.evidenceHash);
  assert.notEqual(digest(serializeCapture(first)), digest(serializeCapture(retry)));
  assert.equal(captureRelativePath(first.identity, first.evidenceHash), `codex/${sessionId}/${unitId}/${first.evidenceHash.slice(0, 20)}.json`);
  retry.terminal = 'interrupted'; retry.coverage.partial = true;
  assert.notEqual(createCapture(retry).evidenceHash, first.evidenceHash);
  const forged = copy(first); forged.evidence[0].text = 'changed';
  assert.throws(() => serializeCapture(forged), { code: 'CAPTURE_HASH_MISMATCH' });
  assert.throws(() => captureRelativePath({ ...first.identity, unitId: '../escape' }));
  assert.equal(canonicalJSON({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
});

test('header version provenance preserves existing capture bytes and rejects malformed or ambiguous labels', () => {
  const previous = capture(), current = copy(previous);
  const originalBytes = serializeCapture(previous);
  current.reader = { name: previous.reader.name, version: previous.reader.version,
    headerClientVersion: previous.reader.clientVersion };
  assert.equal(createCapture(current).evidenceHash, previous.evidenceHash);
  assert.deepEqual(serializeCapture(previous), originalBytes);
  assert.notDeepEqual(serializeCapture(current), originalBytes);
  for (const field of ['clientVersion', 'headerClientVersion']) {
    for (const value of [undefined, null, 1, {}, '', ' ', 'v'.repeat(129), '\u0000', '\ud800']) {
      assert.throws(() => createCapture({ ...current, reader: { name: 'fixture', version: '1', [field]: value } }),
        { code: 'INVALID_SESSION_CLIENT_VERSION' });
    }
  }
  assert.throws(() => createCapture({ ...current, reader: { ...current.reader, clientVersion: 'other' } }), { code: 'INVALID_CAPTURE_READER' });
  assert.throws(() => createCapture({ ...current, reader: { name: 'fixture', version: '1' } }), { code: 'INVALID_CAPTURE_READER' });
});

test('capture validates ordered provenance, partial coverage and binary exclusions', () => {
  for (const mutate of [
    c => c.evidence[0].range.startByte = 0,
    c => c.source.ranges.push(copy(range)),
    c => c.evidence[0].range.recordIds = ['wrong-record'],
    c => c.terminal = 'failed',
    c => c.coverage.omissions = [{ reason: 'attachment-unavailable' }],
    c => c.evidence.push({ kind: 'system', recordId: 'message-1', range, text: 'instruction' }),
    c => c.evidence[0] = { kind: 'attachment', recordId: 'message-1', range, reference: 'data:image/png;base64,private' },
    c => c.evidence[0].text = '\ud800',
  ]) {
    const input = capture(); mutate(input); assert.throws(() => createCapture(input));
  }
  const input = capture(); input.terminal = 'failed'; input.coverage = { partial: true, omissions: [{ reason: 'inline-image', mimeType: 'image/png', caption: 'Supplied diagram' }] };
  assert.equal(createCapture(input).coverage.partial, true);
  assert.equal(string('Meeting 📌'), 'Meeting 📌');
  assert.throws(() => list(new Array(2)));
  for (const reference of ['java\tscript:alert(1)', 'da\nta:image/png;base64,private', '\u0001javascript:alert(1)']) {
    const source = capture(); source.evidence[0] = { kind: 'attachment', recordId: 'message-1', range, reference };
    assert.throws(() => createCapture(source), { code: 'UNSUPPORTED_ATTACHMENT' });
  }
});

test('capture limits include multibyte tools and complete serialized metadata', () => {
  const input = capture();
  input.evidence[0] = { kind: 'tool-result', recordId: 'message-1', range, tool: 'test', callId: 'call-1', outcome: 'failed', text: 'é'.repeat(MAX_TOOL_BYTES / 2) };
  createCapture(input);
  input.evidence[0].text += 'é';
  assert.throws(() => createCapture(input), { code: 'CAPTURE_TOOL_LIMIT' });
  input.evidence[0].text = 'a'.repeat(MAX_TOOL_BYTES);
  input.evidence = Array.from({ length: 8 }, () => copy(input.evidence[0]));
  createCapture(input);
  input.evidence.push({ ...copy(input.evidence[0]), text: 'a' });
  assert.throws(() => createCapture(input), { code: 'CAPTURE_TOOL_LIMIT' });
  const huge = capture(); huge.evidence[0].text = 'a'.repeat(MAX_CAPTURE_BYTES);
  assert.throws(() => createCapture(huge), { code: 'CAPTURE_SIZE_LIMIT' });
});

test('published synthetic configuration example satisfies the contract', async () => {
  const example = JSON.parse(await fs.readFile(new URL('../examples/workflow.json', import.meta.url), 'utf8'));
  const normalized = validateWorkflowConfig(example, { platform: 'linux' });
  assert.equal(normalized.routes[0].collection.enabled, false);
  assert.equal(normalized.routes[0].processing.mode, 'manual');
});

test('missing narrow project roots still shadow an enabled ancestor route', async t => {
  const root = await fs.realpath(await temporary(t)), deleted = path.join(root, 'deleted'), input = config();
  input.routes[0].projectRoot = root;
  input.routes[0].collection = { enabled: true, selection: { kind: 'project' } };
  input.routes.push({ ...input.routes[0], id: 'excluded', projectRoot: deleted, excluded: true });
  const selected = await resolveWorkflowRoute(input, { client: 'codex', sessionId, cwd: path.join(deleted, 'nested') });
  assert.equal(selected.status, 'excluded');
  assert.equal(selected.intended.collect, false);
});

test('missing case-only project spellings cannot bypass a narrow macOS denial', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.realpath(await temporary(t)), input = config();
  input.routes[0].projectRoot = root;
  input.routes[0].collection = { enabled: true, selection: { kind: 'project' } };
  input.routes.push({ ...input.routes[0], id: 'excluded', projectRoot: path.join(root, 'secret'), excluded: true });
  await assert.rejects(resolveWorkflowRoute(input, { client: 'codex', sessionId, cwd: path.join(root, 'Secret') }), /WORKFLOW_ROUTE_UNAVAILABLE/);
});
