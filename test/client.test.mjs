import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bindClaudeCommand, bindCodexCommand, parseAction } from '../src/client/commands.mjs';
import { openTranscript, SOURCE_READ_BYTES } from '../src/client/source.mjs';
import { hashBytes } from '../src/storage/files.mjs';

const root = path.parse(process.cwd()).root;
const file = path.join(root, 'native', 'session.jsonl');
const cwd = path.join(root, 'project');
const skillPath = path.join(root, 'plugin', 'SKILL.md');
const expected = { name: 'cuefluent-notes:notes', source: 'plugin' };
const claude = () => ({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
  command_name: expected.name, command_source: 'plugin', command_args: 'track',
  prompt: '/cuefluent-notes:notes track', session_id: 'session-1', prompt_id: 'prompt-1', cwd, transcript_path: file });
const meta = { 'x-codex-turn-metadata': { session_id: 'session-1', thread_id: 'session-1', turn_id: 'turn-1' } };
const codex = () => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'session-1', turn_id: 'turn-1',
  item: { type: 'UserMessage', id: 'item-1', content: [{ type: 'skill', name: 'cuefluent-notes', path: skillPath },
    { type: 'text', text: 'process project', text_elements: [] }] } } });
const codexExpected = { name: 'cuefluent-notes', skillPath, cwd, sourcePath: file };

test('Claude binds only the exact native installed command expansion', () => {
  assert.deepEqual(bindClaudeCommand(claude(), expected), { client: 'claude', sessionId: 'session-1', promptId: 'prompt-1', action: 'track', cwd, sourcePath: file });
  assert.equal(bindClaudeCommand({ ...claude(), hook_event_name: 'UserPromptSubmit' }, expected), null);
  assert.equal(bindClaudeCommand({ ...claude(), command_source: 'projectSettings' }, expected), null);
  assert.equal(bindClaudeCommand({ ...claude(), command_name: 'another:notes' }, expected), null);
  assert.throws(() => bindClaudeCommand({ ...claude(), prompt: 'Please explain /cuefluent-notes:notes track' }, expected), { code: 'NATIVE_COMMAND_MISMATCH' });
  assert.equal(bindClaudeCommand({ ...claude(), transcript_path: null }, expected).sourcePath, null);
});

test('Codex matches transport identity and exact selected skill, never plain command prose', () => {
  assert.equal(bindCodexCommand(meta, codex(), codexExpected).action, 'process project');
  const wrongTurn = codex(); wrongTurn.payload.turn_id = 'turn-2';
  assert.throws(() => bindCodexCommand(meta, wrongTurn, codexExpected), { code: 'NATIVE_COMMAND_MISMATCH' });
  const mention = codex(); mention.payload.item.content = [{ type: 'text', text: '$cuefluent-notes process project' }];
  assert.throws(() => bindCodexCommand(meta, mention, codexExpected), { code: 'NATIVE_COMMAND_MISMATCH' });
  const otherPath = codex(); otherPath.payload.item.content[0].path = path.join(root, 'other', 'SKILL.md');
  assert.throws(() => bindCodexCommand(meta, otherPath, codexExpected), { code: 'NATIVE_COMMAND_MISMATCH' });
  assert.throws(() => bindCodexCommand({}, codex(), codexExpected), { code: 'NATIVE_CONTEXT_INVALID' });
  assert.throws(() => parseAction('process all'), { code: 'COMMAND_INVALID' });
});

async function fixture(t, content = 'first\n') {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-v2-source-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceFile = path.join(directory, 'native.jsonl');
  await fs.writeFile(sourceFile, content, { mode: 0o600 });
  return { directory, sourceFile };
}

test('source snapshot permits late appends without reading past its observed prefix', async t => {
  const { sourceFile } = await fixture(t);
  const source = await openTranscript(sourceFile); t.after(() => source.close());
  await fs.appendFile(sourceFile, 'late\n');
  assert.equal((await source.read(0, source.size)).toString(), 'first\n');
  assert.equal((await source.verify({ start: 0, end: 6, hash: hashBytes('first\n') })).hash, hashBytes('first\n'));
  await assert.rejects(source.read(source.size, 1), { code: 'SOURCE_RANGE_INVALID' });
  await source.close();
  const next = await openTranscript(sourceFile, { identity: source.identity }); t.after(() => next.close());
  assert.equal((await next.read(0, next.size)).toString(), 'first\nlate\n');
});

test('source rewrite plus append cannot masquerade as an append-only change', async t => {
  const { sourceFile } = await fixture(t);
  const source = await openTranscript(sourceFile); t.after(() => source.close());
  await fs.writeFile(sourceFile, 'other\nlate\n');
  await assert.rejects(source.verify(), { code: 'SOURCE_CHANGED' });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), 'other\nlate\n');
});

test('source growth rechecks the inspected prefix even when filesystem timestamps do not advance', async t => {
  const { sourceFile } = await fixture(t), originalOpen = fs.open, originalLstat = fs.lstat;
  const sameTick = stat => { stat.mtimeNs = 0n; stat.ctimeNs = 0n; return stat; };
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    const stat = await originalLstat(file, ...args); return file === sourceFile ? sameTick(stat) : stat;
  });
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (file === sourceFile) {
      const stat = handle.stat.bind(handle);
      t.mock.method(handle, 'stat', async (...options) => sameTick(await stat(...options)));
    }
    return handle;
  });
  const source = await openTranscript(sourceFile); t.after(() => source.close());
  await fs.writeFile(sourceFile, 'other\nlate\n');
  await assert.rejects(source.verify(), { code: 'SOURCE_CHANGED' });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), 'other\nlate\n');
});

test('source replacement and changed bookmark anchor fail without resetting identity', async t => {
  const { sourceFile, directory } = await fixture(t);
  const source = await openTranscript(sourceFile); t.after(() => source.close());
  await assert.rejects(source.verify({ start: 0, end: 6, hash: hashBytes('other\n') }), { code: 'SOURCE_ANCHOR_CHANGED' });
  await fs.rename(sourceFile, path.join(directory, 'old.jsonl'));
  await fs.writeFile(sourceFile, 'first\n', { mode: 0o600 });
  await assert.rejects(source.verify(), { code: 'SOURCE_CHANGED' });
  await assert.rejects(openTranscript(sourceFile, { identity: source.identity }), { code: 'SOURCE_IDENTITY_CHANGED' });
});

test('source opens are no-create and reject links and oversized read requests', async t => {
  const { sourceFile, directory } = await fixture(t, Buffer.alloc(SOURCE_READ_BYTES * 2, 65));
  assert.equal(await openTranscript(path.join(directory, 'absent.jsonl')), null);
  const source = await openTranscript(sourceFile); t.after(() => source.close());
  await assert.rejects(source.read(0, SOURCE_READ_BYTES + 1), { code: 'SOURCE_RANGE_INVALID' });
  await fs.link(sourceFile, path.join(directory, 'hard.jsonl'));
  await assert.rejects(openTranscript(sourceFile), { code: 'PATH_UNSAFE' });
  if (process.platform !== 'win32') {
    await fs.symlink(sourceFile, path.join(directory, 'link.jsonl'));
    await assert.rejects(openTranscript(path.join(directory, 'link.jsonl')), { code: 'PATH_UNSAFE' });
  }
  assert.ok(!(await fs.readdir(directory)).includes('absent.jsonl'));
});
