import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, NOTE_TOOL_NAMES } from '../src/diagnostics.mjs';
import { supportsNode } from '../src/core/runtime.mjs';
import { ENTRY_COMMANDS } from '../src/core/entry-contract.mjs';
import { DIRECT_NOTE_TOOLS } from '../src/control/direct-notes.mjs';
import { selectStoreRoot, parseEntryArguments } from '../src/client/entry-options.mjs';
import { assertValidNote, assertOrdinaryTarget } from '../src/notes/validate.mjs';

function failureFrom(fn, context) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught, 'fixture must reach its refusal');
  return describeFailure(caught, context);
}

test('runtime preflight accepts only the supported Node range', () => {
  for (const version of ['26.12.1', '26.12.2', '26.13.0']) assert.equal(supportsNode(version), true, version);
  for (const version of ['22.22.0', '24.22.1', '26.2.0', '26.12.0', '27.0.0', '26.12.1-rc.1', '', null]) assert.equal(supportsNode(version), false, String(version));
});

test('diagnostics retain bounded cause codes but omit private messages, paths, and request properties', () => {
  const secret = 'synthetic-private-note-and-token';
  const cause = Object.assign(new Error(secret), { code: 'EACCES', path: secret, environment: secret });
  cause.cause = cause;
  const error = Object.assign(new Error(secret, { cause }), { code: 'PRIVATE_ACCESS_UNVERIFIED', content: secret, stack: secret });
  const result = describeFailure(error, { stage: 'command', operation: 'settings', client: 'codex', version: '0.17.0', args: [secret], path: secret });
  assert.equal(result.error, 'PRIVATE_ACCESS_UNVERIFIED');
  assert.match(result.message, /private storage/); assert.match(result.recovery, /FFI/);
  assert.deepEqual(result.diagnostics.causeCodes, ['EACCES']);
  assert.equal(result.diagnostics.nodeVersion, process.versions.node);
  assert.equal(result.diagnostics.pluginVersion, '0.17.0');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('unknown failures have a safe explanation without evaluating exception accessors', () => {
  let reads = 0;
  const error = Object.defineProperties({}, Object.fromEntries(['code', 'cause', 'message', 'stack'].map(key => [key, { get() { reads++; throw new Error('must not execute'); } }])));
  const result = describeFailure(error, { fallback: 'CONTROL_TOOL_FAILED', stage: 'tool' });
  assert.equal(reads, 0); assert.equal(result.error, 'CONTROL_TOOL_FAILED');
  assert.match(result.message, /could not complete/); assert.match(result.recovery, /Keep existing notes and pending work unchanged/);
  assert.doesNotMatch(result.recovery, /setup|status|save|process|skip|delete/i);
  assert.equal(result.diagnostics.stage, 'tool');
  assert.equal(describeFailure({ code: 'secret\ntext', message: 'private' }).error, 'CUEFLUENT_FAILED');
  const untrustedContext = { fallback: 'secret\ntext', stage: 'secret-stage', operation: 'secret-operation', toolName: 'secret-tool', client: 'secret-client', version: 'secret-version' };
  const bounded = describeFailure({}, untrustedContext);
  assert.equal(bounded.error, 'CUEFLUENT_FAILED');
  assert.equal(JSON.stringify(bounded).includes('secret'), false);
});

test('malformed store overrides identify the environment setting without disclosing its value or changing CLI errors', () => {
  const secret = 'synthetic-private-store-value';
  const result = failureFrom(() => selectStoreRoot({ env: { CUEFLUENT_HOME: `${secret}/../private` }, platform: 'linux', homedir: '/home/synthetic' }),
    { stage: 'command', operation: 'mcp', client: 'codex' });
  assert.equal(result.error, 'ENTRY_STORE_ROOT_INVALID');
  assert.match(result.recovery, /CUEFLUENT_HOME/);
  assert.match(result.recovery, /normalized absolute path/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const cli = failureFrom(() => parseEntryArguments(['setup', '--config', `${secret}/setup.json`]), { stage: 'command', operation: 'setup' });
  assert.equal(cli.error, 'ENTRY_ARGUMENT_INVALID');
});

test('ordinary note refusals describe validation and inspection work rather than queued processing', () => {
  const context = { stage: 'tool', toolName: 'cuefluent_create_note' };
  const invalid = failureFrom(() => assertValidNote('# Synthetic topic\nNo answer sections.\n'), context);
  assert.equal(invalid.error, 'NOTE_INVALID');
  assert.match(invalid.recovery, /note structure, metadata, and size limits/);
  const project = { destination: { kind: 'directory', path: '/synthetic/notes' } };
  const target = failureFrom(() => assertOrdinaryTarget(project, '/synthetic/notes/topic.txt', { platform: 'linux' }), context);
  assert.equal(target.error, 'NOTE_TARGET_INVALID'); assert.match(target.recovery, /\.md/);
  const reserved = failureFrom(() => assertOrdinaryTarget(project, '/synthetic/notes/logs/topic.md', { platform: 'linux' }), context);
  assert.equal(reserved.error, 'NOTE_TARGET_RESERVED'); assert.match(reserved.recovery, /Preserve the log files/);
  const unread = describeFailure({ code: 'WORKSPACE_NOTE_UNREAD' }, context);
  assert.match(unread.recovery, /cuefluent_read_note/); assert.match(unread.recovery, /cuefluent_update_note/); assert.match(unread.recovery, /exact expectedHash/);
  for (const result of [invalid, target, reserved, unread]) assert.doesNotMatch(result.recovery, /latest status|retrying setup|process request/);
});

test('project and settings errors use the verified caller context and keep existing destinations', () => {
  const noteContext = { stage: 'tool', toolName: 'cuefluent_read_note', client: 'claude' };
  const project = describeFailure({ code: 'PROJECT_UNCONFIGURED' }, noteContext);
  assert.match(project.message, /project ID/);
  assert.match(project.recovery, /cuefluent_projects.*exact projectId/);
  assert.match(project.recovery, /only if that destination is not configured/);
  const note = describeFailure({ code: 'SETTINGS_CONFLICT' }, noteContext);
  assert.match(note.recovery, /cuefluent_projects/); assert.match(note.recovery, /Restart note inspection/);
  assert.doesNotMatch(note.recovery, /setup/);
  assert.equal(note.diagnostics.toolName, 'cuefluent_read_note');
  const setup = describeFailure({ code: 'SETTINGS_CONFLICT' }, { stage: 'command', operation: 'setup' });
  assert.match(setup.recovery, /original setup proposal/); assert.match(setup.recovery, /settingsHash/);
  assert.equal(setup.diagnostics.operation, 'setup'); assert.equal(setup.diagnostics.toolName, undefined);
  const unknown = describeFailure({ code: 'SETTINGS_CONFLICT' }, { stage: 'result', toolName: 'cuefluent_unknown_private_tool' });
  assert.equal(unknown.diagnostics.stage, 'result'); assert.equal(unknown.diagnostics.toolName, undefined);
  assert.doesNotMatch(unknown.recovery, /setup|cuefluent_projects/);
});

test('hash and setup refusals distinguish settings inspection from complete note inspection', () => {
  const setup = describeFailure({ code: 'EXPECTED_HASH_REQUIRED' }, { stage: 'command', operation: 'setup' });
  assert.match(setup.recovery, /settingsHash as expectedHash/);
  const note = describeFailure({ code: 'EXPECTED_HASH_REQUIRED' }, { stage: 'tool', toolName: 'cuefluent_update_note' });
  assert.match(note.recovery, /complete original with cuefluent_read_note/);
  assert.match(note.recovery, /first whole-file hash/); assert.doesNotMatch(note.recovery, /settingsHash|setup/);
  const proposal = describeFailure({ code: 'SETUP_ARGUMENT' }, { stage: 'command', operation: 'setup' });
  assert.match(proposal.recovery, /complete agreed project settings/);
  assert.doesNotMatch(proposal.recovery, /latest status/);
});

test('revising a pending request requires approved discard before a new identity', () => {
  const result = describeFailure({ code: 'DIRECT_NOTE_REQUEST_CHANGED' }, { stage: 'tool', toolName: 'cuefluent_create_note' });
  assert.match(result.recovery, /cuefluent_review_note/);
  assert.match(result.recovery, /cuefluent_skip_note with user authorization and successful client confirmation/);
  assert.ok(result.recovery.indexOf('cuefluent_skip_note') < result.recovery.indexOf('fresh UUID'));
  assert.match(result.recovery, /completed request/); assert.match(result.recovery, /identical arguments/);
});

test('fatal transport limits require a new connection before mutation recovery', () => {
  for (const code of ['MCP_FRAME_LIMIT', 'CONTROL_REQUEST_LIMIT']) {
    const result = describeFailure({ code }, { stage: 'transport', operation: 'mcp' });
    assert.match(result.message, /closed the connection/);
    assert.match(result.recovery, /^Reconnect/);
    assert.match(result.recovery, /After reconnecting, inspect retained work/);
    assert.doesNotMatch(result.recovery, /wait|finish/);
  }
});

test('missing files use note-read, setup, or module-load recovery without guessing an exception path', () => {
  const privatePath = '/synthetic-private-missing-note/topic.md';
  const error = Object.assign(new Error(privatePath), { code: 'ENOENT', path: privatePath });
  const note = describeFailure(error, { stage: 'tool', toolName: 'cuefluent_read_note' });
  assert.match(note.recovery, /cuefluent_projects.*list the notes again/);
  assert.match(note.recovery, /restart its read at byte zero/);
  assert.doesNotMatch(note.recovery, /executable|working directory|installed plugin|connector settings/);
  const setup = describeFailure(error, { stage: 'command', operation: 'setup' });
  assert.match(setup.recovery, /setup configuration file/);
  const startup = describeFailure(error, { stage: 'module-load' });
  assert.match(startup.recovery, /installed plugin package/);
  const unknown = describeFailure(error);
  assert.doesNotMatch(unknown.recovery, /executable|working directory|installed plugin/);
  for (const value of [note, setup, startup, unknown]) assert.equal(JSON.stringify(value).includes(privatePath), false);
});

test('verified package refusals guide package repair while preserving user state', () => {
  for (const code of ['CLIENT_PACKAGE_INVALID', 'CLIENT_PACKAGE_CHANGED']) {
    const result = describeFailure({ code }, { stage: 'command', operation: 'mcp' });
    assert.match(result.recovery, /marketplace/); assert.match(result.recovery, /[Pp]reserve private storage and notes/);
    assert.doesNotMatch(result.recovery, /latest status|retrying setup/);
  }
});

test('every advertised direct-note tool gets direct-note recovery and a safe tool identity', () => {
  assert.deepEqual([...NOTE_TOOL_NAMES].sort(), DIRECT_NOTE_TOOLS.map(({ name }) => name).sort());
  for (const { name } of DIRECT_NOTE_TOOLS) {
    const result = describeFailure({ code: 'PROJECT_UNCONFIGURED' }, { stage: 'tool', toolName: name });
    assert.equal(result.diagnostics.toolName, name);
    assert.match(result.recovery, /Call cuefluent_projects/);
  }
  assert.equal(describeFailure({}, { toolName: 'cuefluent_unknown_note' }).diagnostics.toolName, undefined);
});

test('diagnostic operations follow the same command identities as the entry grammar', () => {
  const root = '/synthetic/private', handle = Buffer.alloc(64, 1).toString('base64url');
  const argumentsByCommand = {
    hook: ['claude'], mcp: ['codex'], setup: ['--config', '/synthetic/setup.json'], settings: [],
    status: ['--project', 'demo'], 'sync-steward': [root], 'sync-collect': [root, 'codex', 'native'],
    'command-worker': [root, handle],
  };
  assert.deepEqual(Object.keys(argumentsByCommand).sort(), Object.values(ENTRY_COMMANDS).sort());
  for (const command of Object.values(ENTRY_COMMANDS)) {
    assert.equal(parseEntryArguments([command, ...argumentsByCommand[command]], { platform: 'linux' }).command, command);
    assert.equal(describeFailure({}, { operation: command }).diagnostics.operation, command);
  }
});
