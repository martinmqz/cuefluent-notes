import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mapNativeHook, handleNativeHook, NATIVE_HOOK_LIMITS } from '../src/client/hooks.mjs';
import { buildClaudeCommandContext } from '../src/client/history.mjs';
import { createProject } from '../src/core/settings.mjs';
import { initializeStore } from '../src/storage/store.mjs';
import { readChat } from '../src/storage/chats.mjs';

const cwd = path.resolve('synthetic-project'), sourcePath = path.resolve('missing-synthetic-transcript.jsonl');
const identity = { session_id: 'synthetic-session', cwd, transcript_path: sourcePath };
const claudeCommand = { name: 'notes:notes', source: 'plugin' };
const expansion = () => ({ ...identity, hook_event_name: 'UserPromptExpansion', prompt_id: 'prompt',
  expansion_type: 'slash_command', command_name: 'notes:notes', command_source: 'plugin',
  command_args: 'track', prompt: '/notes:notes track' });

test('native start sources distinguish new identity from resume/compact without inspecting a transcript', () => {
  for (const client of ['claude', 'codex']) for (const source of ['startup', 'fork', 'clear', 'resume', 'compact']) {
    const { event, command } = mapNativeHook(client, { ...identity, hook_event_name: 'SessionStart', source });
    assert.equal(command, null); assert.equal(event.kind, 'start'); assert.equal(event.startSource, source);
    assert.equal(event.newSession, ['startup', 'fork', 'clear'].includes(source));
    assert.deepEqual(event.source, { path: sourcePath, identity: null }); assert.equal(event.history, null);
    assert(Object.isFrozen(event)); assert(Object.isFrozen(event.source));
  }
  assert.equal(mapNativeHook('codex', { ...identity, transcript_path: null, hook_event_name: 'SessionStart', source: 'startup' }).event.source, null);
  assert.throws(() => mapNativeHook('claude', { ...identity, hook_event_name: 'SessionStart', source: 'unknown' }), { code: 'NATIVE_HOOK_UNSUPPORTED' });
});

test('Stop pins exact native prompt and UTF8 final-message hash; end/compact do not invent outcomes', () => {
  const text = 'Exact final\n雪🙂';
  for (const client of ['claude', 'codex']) {
    const { event } = mapNativeHook(client, { ...identity, hook_event_name: 'Stop', prompt_id: 'claude-prompt', turn_id: 'codex-turn', last_assistant_message: text });
    assert.deepEqual(event.completion, { promptId: client === 'claude' ? 'claude-prompt' : 'codex-turn', kind: 'completed',
      finalTextHash: createHash('sha256').update(text).digest('hex') });
    assert(!JSON.stringify(event).includes(text));
    const ended = mapNativeHook(client, { ...identity, hook_event_name: 'SessionEnd', prompt_id: 'ignored', reason: 'other' }).event;
    assert.equal(ended.kind, 'end'); assert.deepEqual(ended.completion, client === 'claude' ? { promptId: 'ignored', kind: 'observed', finalTextHash: null } : null);
  }
  assert.equal(mapNativeHook('claude', { ...identity, hook_event_name: 'PostCompact', compact_summary: 'never copied' }).event.completion, null);
  assert.deepEqual(mapNativeHook('codex', { ...identity, hook_event_name: 'Interrupt', turn_id: 'exact-interrupted-turn' }).event.completion,
    { promptId: 'exact-interrupted-turn', kind: 'interrupted', finalTextHash: null });
  const failed = mapNativeHook('claude', { ...identity, hook_event_name: 'StopFailure', prompt_id: 'failed-prompt', error: 'rate_limit',
    last_assistant_message: 'Rendered API error is not conversation', error_details: 'Not retained' }).event;
  assert.equal(failed.kind, 'failed'); assert.deepEqual(failed.completion, { promptId: 'failed-prompt', kind: 'failed', finalTextHash: null });
  assert(!JSON.stringify(failed).includes('Rendered')); assert(!JSON.stringify(failed).includes('Not retained'));
  assert.equal(mapNativeHook('claude', { ...identity, hook_event_name: 'StopFailure', error: 'rate_limit' }).event.completion, null);
  for (const hook_event_name of ['UserPromptSubmit', 'PreCompact', 'UnknownHook']) {
    assert.deepEqual(mapNativeHook('claude', { ...identity, hook_event_name, prompt: '/notes:notes track' }), { event: null, command: null });
  }
});

test('only installed Claude native expansion binds a command; nonce is trusted dispatcher output', () => {
  const clientContract = { name: 'notes:notes', skillPath: path.resolve('claude-package/skills/notes/SKILL.md') };
  const mapped = mapNativeHook('claude', { ...expansion(), clientContract: { name: 'untrusted-payload', skillPath: '/untrusted/SKILL.md' } }, { claudeCommand, clientContract });
  assert.equal(mapped.event, null); assert.equal(mapped.command.action, 'track'); assert.equal(mapped.command.promptId, 'prompt');
  assert.deepEqual(mapped.command.clientContract, clientContract); assert(Object.isFrozen(mapped.command.clientContract));
  assert.deepEqual(mapNativeHook('claude', { ...identity, hook_event_name: 'SessionStart', source: 'startup' }, { clientContract }).event.clientContract, clientContract);
  const nonce = randomUUID(), invocation = { ...mapped.command, commandNonce: nonce };
  assert.equal(buildClaudeCommandContext(invocation.commandNonce), `Cuefluent Notes invocation: ${nonce}`);
  for (const input of [{ ...expansion(), command_source: 'projectSettings' }, { ...expansion(), command_name: 'else:notes' },
    { ...expansion(), hook_event_name: 'UserPromptSubmit' }]) assert.equal(mapNativeHook('claude', input, { claudeCommand }).command, null);
  assert.equal(mapNativeHook('codex', expansion(), { claudeCommand }).command, null);
  assert.throws(() => mapNativeHook('claude', { ...expansion(), prompt: 'Explain /notes:notes track' }, { claudeCommand }), { code: 'NATIVE_COMMAND_MISMATCH' });
});

test('malformed identities, accessors and overprofile expectations fail without copying input', () => {
  let accessed = false;
  assert.throws(() => mapNativeHook('claude', Object.defineProperty({}, 'hook_event_name', { enumerable: true, get() { accessed = true; } })), { code: 'NATIVE_HOOK_INVALID' });
  assert.equal(accessed, false);
  assert.throws(() => mapNativeHook('claude', { ...identity, cwd: 'relative', hook_event_name: 'SessionStart', source: 'startup' }));
  for (const last_assistant_message of ['\ud800', 'x'.repeat(NATIVE_HOOK_LIMITS.finalTextUnits + 1), {}]) {
    assert.throws(() => mapNativeHook('claude', { ...identity, hook_event_name: 'Stop', prompt_id: 'prompt', last_assistant_message }), { code: 'NATIVE_HOOK_INVALID' });
  }
  assert.throws(() => mapNativeHook('codex', { ...identity, hook_event_name: 'Stop', prompt_id: 'not-a-turn', last_assistant_message: 'answer' }));
});

test('hook ingress preserves zero-write manual policy and returns commands without executing or scanning', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-hooks-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'); await fs.mkdir(projectRoot);
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [createProject({ id: 'project', root: projectRoot,
    destination: { kind: 'directory', path: path.join(root, 'notes') } })] });
  const envelope = { ...identity, cwd: projectRoot, hook_event_name: 'SessionStart', source: 'startup' };
  const before = await fs.readdir(path.join(store.root, 'store/projects'));
  const result = await handleNativeHook(store, 'claude', envelope, { schedule: () => assert.fail('Manual hook scheduled') });
  assert.deepEqual(result.ingress, { status: 'ineligible' }); assert.equal(await readChat(store, 'claude', identity.session_id), null);
  assert.deepEqual(await fs.readdir(path.join(store.root, 'store/projects')), before);
  const command = await handleNativeHook(store, 'claude', { ...expansion(), cwd: projectRoot }, { claudeCommand, schedule: () => assert.fail('Command executed inline') });
  assert.equal(command.ingress.status, 'command'); assert.equal(command.command.action, 'track');
  assert.equal(await readChat(store, 'claude', identity.session_id), null);
  const excluded = await handleNativeHook(store, 'claude', expansion(), { claudeCommand, verifyProcessingSession: async () => true });
  assert.equal(excluded.command, null); assert.equal(excluded.ingress.status, 'excluded');
  const unknown = await handleNativeHook(store, 'claude', expansion(), { claudeCommand, launchMarker: randomUUID() });
  assert.equal(unknown.command, null); assert.equal(unknown.ingress.reason, 'PROCESSING_IDENTITY_UNVERIFIED');
});
