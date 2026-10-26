import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFailure, NOTE_TOOL_NAMES, GUIDED_CODES } from '../src/diagnostics.mjs';
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
  assert.match(result.message, /private store/); assert.match(result.recovery, /ACLs/);
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
  assert.match(result.recovery, /normalized CUEFLUENT_HOME/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const cli = failureFrom(() => parseEntryArguments(['setup', '--config', `${secret}/setup.json`]), { stage: 'command', operation: 'setup' });
  assert.equal(cli.error, 'ENTRY_ARGUMENT_INVALID');
});

test('ordinary note refusals describe validation and inspection work rather than queued processing', () => {
  const context = { stage: 'tool', toolName: 'cuefluent_create_note' };
  const invalid = failureFrom(() => assertValidNote('# Synthetic topic\nNo answer sections.\n'), context);
  assert.equal(invalid.error, 'NOTE_INVALID');
  assert.match(invalid.recovery, /topic H1, visible H2 sections/);
  const project = { destination: { kind: 'directory', path: '/synthetic/notes' } };
  const target = failureFrom(() => assertOrdinaryTarget(project, '/synthetic/notes/topic.txt', { platform: 'linux' }), context);
  assert.equal(target.error, 'NOTE_TARGET_INVALID'); assert.match(target.recovery, /\.md/);
  const reserved = failureFrom(() => assertOrdinaryTarget(project, '/synthetic/notes/logs/topic.md', { platform: 'linux' }), context);
  assert.equal(reserved.error, 'NOTE_TARGET_RESERVED'); assert.match(reserved.recovery, /the log files/);
  const unread = describeFailure({ code: 'WORKSPACE_NOTE_UNREAD' }, context);
  assert.match(unread.recovery, /cuefluent_read_note/); assert.match(unread.recovery, /expectedHash/); assert.match(unread.recovery, /creation requires an absent target/);
  for (const result of [invalid, target, reserved, unread]) assert.doesNotMatch(result.recovery, /latest status|retrying setup|process request/);
});

test('project and conflict guidance is the same in every caller context while diagnostics keep the verified context', () => {
  const noteContext = { stage: 'tool', toolName: 'cuefluent_read_note', client: 'claude' };
  const project = describeFailure({ code: 'PROJECT_UNCONFIGURED' }, noteContext);
  assert.match(project.message, /project is not configured/);
  assert.match(project.recovery, /cuefluent_projects.*exact projectId/);
  assert.match(project.recovery, /only when that destination is not configured/);
  const note = describeFailure({ code: 'SETTINGS_CONFLICT' }, noteContext);
  assert.match(note.recovery, /cuefluent_projects for settings/); assert.match(note.recovery, /cuefluent_read_note for a note/);
  assert.match(note.recovery, /Never replace a hash/);
  assert.equal(note.diagnostics.toolName, 'cuefluent_read_note'); assert.equal(note.diagnostics.client, 'claude');
  const setup = describeFailure({ code: 'SETTINGS_CONFLICT' }, { stage: 'command', operation: 'setup' });
  assert.equal(setup.recovery, note.recovery); assert.equal(setup.message, note.message);
  assert.equal(setup.diagnostics.operation, 'setup'); assert.equal(setup.diagnostics.toolName, undefined);
  const unknown = describeFailure({ code: 'SETTINGS_CONFLICT' }, { stage: 'result', toolName: 'cuefluent_unknown_private_tool' });
  assert.equal(unknown.diagnostics.stage, 'result'); assert.equal(unknown.diagnostics.toolName, undefined);
  assert.equal(unknown.recovery, note.recovery);
});

test('a missing hash and a changed original share the inspect-again guidance, and setup arguments name the setup tool', () => {
  const setup = describeFailure({ code: 'EXPECTED_HASH_REQUIRED' }, { stage: 'command', operation: 'setup' });
  const note = describeFailure({ code: 'EXPECTED_HASH_REQUIRED' }, { stage: 'tool', toolName: 'cuefluent_update_note' });
  assert.equal(setup.recovery, note.recovery);
  assert.match(note.recovery, /cuefluent_read_note for a note, keeping the hash it returns as expectedHash/);
  assert.equal(describeFailure({ code: 'DIRECT_NOTE_CONFLICT' }).recovery, note.recovery);
  const proposal = describeFailure({ code: 'SETUP_ARGUMENT' }, { stage: 'command', operation: 'setup' });
  assert.match(proposal.message, /setup proposal/); assert.match(proposal.recovery, /cuefluent_setup fields/);
  assert.doesNotMatch(proposal.recovery, /latest status/);
});

test('path, placement, alias and size refusals name their situation rather than the generic entry', () => {
  const generic = describeFailure({}).recovery;
  for (const code of ['PATH_MISSING', 'PATH_INVALID', 'PATH_UNSAFE']) {
    const result = describeFailure({ code }, { stage: 'tool', toolName: 'cuefluent_list_notes' });
    assert.match(result.message, /path is missing, escapes its destination/); assert.match(result.recovery, /missing original never authorizes a replacement/);
    assert.notEqual(result.recovery, generic);
  }
  for (const code of ['PRIVATE_LOCATION_OVERLAP', 'PRIVATE_LOCATION_REPOSITORY']) assert.match(describeFailure({ code }).message, /separate locations outside repositories/);
  assert.match(describeFailure({ code: 'FILE_MISSING' }).message, /missing/);
  const aliases = describeFailure({ code: 'NOTE_ALIASES_CHANGED' });
  assert.match(aliases.message, /drops existing aliases/); assert.doesNotMatch(aliases.message, /changed after/);
  const size = describeFailure({ code: 'DIRECT_NOTE_CONTENT_LIMIT' }, { stage: 'tool', toolName: 'cuefluent_create_note' });
  assert.match(size.message, /size limit/); assert.match(size.recovery, /Do not shorten, split/);
  const conflict = describeFailure({ code: 'NOTE_PUBLICATION_CONFLICT' }, { stage: 'tool', toolName: 'cuefluent_save_note' });
  assert.match(conflict.message, /changed after they were inspected or reviewed/); assert.match(conflict.recovery, /relay Discard or Skip to release it/);
  assert.equal(describeFailure({ code: 'DRAFT_CHANGED' }).recovery, conflict.recovery);
  const pending = describeFailure({ code: 'SETUP_PENDING' }, { stage: 'tool', toolName: 'cuefluent_setup' });
  assert.match(pending.recovery, /cuefluent_projects: its pendingSetup names the interrupted project/); assert.match(pending.recovery, /only that project's id or exact root/);
});

test('a retained project is refused for its root without implying a pending run', () => {
  const retained = describeFailure({ code: 'SETTINGS_RETAINED_PROJECT' }, { stage: 'command', operation: 'setup' });
  assert.match(retained.message, /root cannot change/); assert.match(retained.recovery, /Keep the project's root/);
  assert.match(retained.recovery, /opted-out/); assert.doesNotMatch(retained.recovery, /cuefluent_review_note|pending run|saving mode/);
  const pending = describeFailure({ code: 'SETTINGS_PENDING_RUN' }, { stage: 'tool', toolName: 'cuefluent_setup' });
  assert.match(pending.message, /pending run pins/); assert.doesNotMatch(pending.message, /retained|root/);
  assert.notEqual(pending.recovery, retained.recovery);
});

test('revising a pending request requires the user\'s relayed discard before a new identity, and stale decisions ask for a fresh review', () => {
  const result = describeFailure({ code: 'DIRECT_NOTE_REQUEST_CHANGED' }, { stage: 'tool', toolName: 'cuefluent_create_note' });
  assert.match(result.recovery, /cuefluent_review_note/);
  assert.match(result.recovery, /Discard with cuefluent_skip_note and the reviewed revision/);
  assert.ok(result.recovery.indexOf('cuefluent_skip_note') < result.recovery.indexOf('fresh UUID'));
  assert.match(result.recovery, /identical arguments/);
  const stale = describeFailure({ code: 'REVIEW_REVISION_STALE' }, { stage: 'tool', toolName: 'cuefluent_save_note' });
  assert.match(stale.recovery, /cuefluent_review_note again/); assert.match(stale.recovery, /Do not reuse an earlier answer/);
  const replaced = describeFailure({ code: 'REVIEW_RUN_CHANGED' }, { stage: 'tool', toolName: 'cuefluent_skip_note' });
  assert.match(replaced.recovery, /^Read status/); assert.match(replaced.recovery, /relay their new decision/);
});

test('fatal transport limits require a new connection before mutation recovery', () => {
  for (const code of ['MCP_FRAME_LIMIT', 'CONTROL_REQUEST_LIMIT']) {
    const result = describeFailure({ code }, { stage: 'transport', operation: 'mcp' });
    assert.match(result.message, /transport limit/);
    assert.match(result.recovery, /^Reconnect/);
    assert.match(result.recovery, /read status and the latest outcome before repeating a mutation/);
    assert.doesNotMatch(result.recovery, /wait/);
  }
});

test('missing files get one filesystem recovery without guessing an exception path', () => {
  const privatePath = '/synthetic-private-missing-note/topic.md';
  const error = Object.assign(new Error(privatePath), { code: 'ENOENT', path: privatePath });
  const note = describeFailure(error, { stage: 'tool', toolName: 'cuefluent_read_note' });
  assert.match(note.message, /missing/); assert.match(note.recovery, /configured paths exist/); assert.match(note.recovery, /cuefluent_projects/);
  assert.match(note.recovery, /missing original never authorizes a replacement/);
  assert.doesNotMatch(note.recovery, /executable|working directory|installed plugin|connector settings/);
  const setup = describeFailure(error, { stage: 'command', operation: 'setup' });
  const startup = describeFailure(error, { stage: 'module-load' });
  const unknown = describeFailure(error);
  for (const value of [setup, startup, unknown]) { assert.equal(value.recovery, note.recovery); assert.equal(value.message, note.message); }
  assert.equal(setup.diagnostics.operation, 'setup'); assert.equal(startup.diagnostics.stage, 'module-load');
  for (const value of [note, setup, startup, unknown]) assert.equal(JSON.stringify(value).includes(privatePath), false);
});

test('every failure code raised in the source resolves to a table entry or the generic entry, and every table code is raised', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url)), raised = new Set();
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      // A code literal in argument position of any error helper, or the preflight's
      // plain `{ code }` object, which runs before any module loads. The table itself is excluded.
      else if (entry.name.endsWith('.mjs') && file !== path.join(root, 'diagnostics.mjs')) {
        for (const match of (await fs.readFile(file, 'utf8')).matchAll(/(?:[(,]\s*|code\s*[:=]\s*)'([A-Z][A-Z0-9_]{5,})'(?=\s*[,);}\]])/g)) raised.add(match[1]);
      }
    }
  }
  await visit(root);
  assert.ok(raised.size > 100, `expected many raised codes, found ${raised.size}`);
  const generic = describeFailure({});
  for (const code of raised) {
    const result = describeFailure({ code });
    assert.equal(result.error, code);
    assert.ok(result.message.length > 20 && result.recovery.length > 40, code);
  }
  // Runtime and operating-system codes are raised by Node itself.
  const runtime = new Set(['ENOENT', 'EACCES', 'EPERM', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNKNOWN_BUILTIN_MODULE']);
  for (const code of GUIDED_CODES) assert.ok(raised.has(code) || runtime.has(code), `${code} is in the guidance table but nothing raises it`);
  const entries = new Set(GUIDED_CODES.map(code => describeFailure({ code }).message));
  assert.ok(entries.size <= 24, `the guidance table has ${entries.size} entries`);
  for (const code of GUIDED_CODES) assert.notEqual(describeFailure({ code }).recovery, generic.recovery, code);
  // Internal codes resolve to the generic entry without a per-code sentence.
  assert.equal(describeFailure({ code: 'RUN_MISSING' }).recovery, generic.recovery);
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
