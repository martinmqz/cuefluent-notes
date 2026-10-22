import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createChat, validateChat, validateChatHistory, validateClientContract, retainChatClientContract, changeTracking, requestReconciliation, advanceChat, rebindChatSource } from '../src/core/chat.mjs';

const fresh = () => createChat({ client: 'claude', sessionId: 'native-session', projectId: 'project',
  source: { path: path.join(path.parse(process.cwd()).root, 'native.jsonl'), identity: { device: '1', inode: '9007199254740993' } } });

test('retained installed command contracts are strict frozen bounded identities and never silently dropped', () => {
  const identity = { name: 'notes:notes', skillPath: path.resolve('plugin/SKILL.md') };
  const chat = retainChatClientContract(fresh(), identity); identity.name = 'mutated';
  assert.equal(chat.clientContracts[0].name, 'notes:notes'); assert(Object.isFrozen(chat.clientContracts[0])); assert(Object.isFrozen(chat.clientContracts));
  assert.deepEqual(retainChatClientContract(chat, chat.clientContracts[0]), chat);
  assert.throws(() => validateClientContract({ ...chat.clientContracts[0], content: 'private' }), { code: 'CHAT_INVALID' });
  assert.throws(() => validateClientContract({ name: 'notes', skillPath: path.resolve('other.md') }), { code: 'CLIENT_CONTRACT_INVALID' });
  const long = { name: 'notes', skillPath: path.resolve('x'.repeat(4097), 'SKILL.md') };
  assert.throws(() => validateClientContract(long), { code: 'CLIENT_CONTRACT_PATH_LIMIT' });
  assert.equal(retainChatClientContract(chat, long).clientContractOverflow, true);
  assert.throws(() => validateChat({ ...chat, clientContracts: [chat.clientContracts[0], chat.clientContracts[0]] }), { code: 'CLIENT_CONTRACT_INVALID' });
});

test('Claude opaque result handles remain exact native command boundary nonces', () => {
  const handle = Buffer.alloc(64, 255).toString('base64url');
  assert.equal(changeTracking(fresh(), 'track', 'prompt', { commandNonce: handle }).pending.commandNonce, handle);
  assert.throws(() => changeTracking(fresh(), 'track', 'prompt', { commandNonce: handle.slice(0, -1) + 'B' }), { code: 'CHAT_INVALID' });
});

test('untrack fences a collector immediately, retains its bookmark and queues a final bounded catch-up', () => {
  const tracked = changeTracking(fresh(), 'track', 'track-prompt');
  const stopped = changeTracking(tracked, 'untrack', 'untrack-prompt');
  assert.equal(stopped.tracked, false); assert.equal(stopped.optOut, true);
  assert.equal(stopped.pending.beforePromptId, 'untrack-prompt');
  assert.deepEqual(stopped.checkpoint, tracked.checkpoint);
  assert.throws(() => advanceChat(stopped, { generation: tracked.generation, checkpoint: tracked.checkpoint }), { code: 'CHAT_GENERATION_CHANGED' });
  assert.deepEqual(requestReconciliation(stopped, { promptId: 'later', kind: 'completed', finalTextHash: null }), stopped);
  const resumed = changeTracking(stopped, 'track', 'retrack-prompt');
  assert.deepEqual(resumed.checkpoint, tracked.checkpoint);
  assert.equal(resumed.optOut, false); assert.equal(resumed.projectId, tracked.projectId);
});

test('a collector finishing an older request preserves a newer native completion request', () => {
  const tracking = changeTracking(fresh(), 'track', 'command');
  const caughtUp = advanceChat(tracking, { generation: tracking.generation, checkpoint: tracking.checkpoint, requestId: tracking.pending.id, complete: true });
  const old = requestReconciliation(caughtUp, { promptId: 'earlier', kind: 'completed', finalTextHash: null });
  const next = requestReconciliation(old, { promptId: 'latest', kind: 'completed', finalTextHash: 'a'.repeat(64) });
  const result = advanceChat(next, { generation: old.generation, checkpoint: old.checkpoint, requestId: old.pending.id, complete: true });
  assert.equal(result.pending.id, next.pending.id);
  assert.equal(advanceChat(result, { generation: result.generation, checkpoint: result.checkpoint, requestId: result.pending.id, complete: true }).pending, null);
});

test('completion hooks retain an unfinished explicit tracking boundary and its nonce', () => {
  const nonce = '10000000-0000-4000-8000-000000000001';
  const pending = changeTracking(fresh(), 'track', 'command', { commandNonce: nonce });
  assert.equal(requestReconciliation(pending, { promptId: 'latest', kind: 'completed', finalTextHash: null }).pending.commandNonce, nonce);
  assert.equal(requestReconciliation(pending).pending.id, pending.pending.id);
});

test('loaded chat state rejects content, unsupported schemas and mismatched checkpoint identity', () => {
  const chat = fresh();
  assert.throws(() => validateChat({ ...chat, transcript: 'private text' }), { code: 'CHAT_INVALID' });
  assert.throws(() => validateChat({ ...chat, schemaVersion: 2 }), { code: 'CHAT_SCHEMA_UNSUPPORTED' });
  assert.throws(() => validateChat({ ...chat, tracked: true, optOut: true }), { code: 'CHAT_INVALID' });
  assert.throws(() => validateChat({ ...chat, checkpoint: { ...chat.checkpoint, sessionId: 'other' } }), { code: 'TRANSCRIPT_IDENTITY_MISMATCH' });
  assert.throws(() => validateChat({ ...chat, source: { ...chat.source, identity: { device: 1, inode: 2 } } }), { code: 'CHAT_INVALID' });
  assert.equal(chat.source.identity.inode, '9007199254740993');
});

test('initial automatic inherited-history policy is frozen and retained through explicit untrack/retrack', () => {
  const history = { mode: 'automatic', startSource: 'fork', inheritedBoundary: { endByteOffset: 40, hash: 'a'.repeat(64), anchor: { start: 0, end: 40, hash: 'b'.repeat(64), rowId: 'native-last' } } };
  const chat = createChat({ ...fresh(), history }); history.inheritedBoundary.anchor.rowId = 'mutated';
  const tracked = changeTracking(chat, 'track', 'track'), stopped = changeTracking(tracked, 'untrack', 'stop'), resumed = changeTracking(stopped, 'track', 'again');
  assert.equal(resumed.history.inheritedBoundary.anchor.rowId, 'native-last'); assert(Object.isFrozen(resumed.history.inheritedBoundary.anchor));
  assert.deepEqual(resumed.history, chat.history);
  assert.throws(() => validateChatHistory({ ...chat.history, transcript: 'private content' }, { client: 'claude' }), { code: 'CHAT_INVALID' });
  assert.throws(() => validateChatHistory(chat.history, { client: 'codex' }), { code: 'CHAT_HISTORY_INVALID' });
  assert.throws(() => validateChatHistory({ ...chat.history, inheritedBoundary: { ...chat.history.inheritedBoundary, anchor: { ...chat.history.inheritedBoundary.anchor, end: 39 } } }, { client: 'claude' }), { code: 'CHAT_HISTORY_INVALID' });
});

test('native source rebind preserves checkpoint meaning and rejects changes to exact anchor identity/hash', () => {
  const chat = fresh(), nextSource = { ...chat.source, identity: { device: '1', inode: '9007199254740995' } };
  const rebound = rebindChatSource(chat, { generation: chat.generation, source: nextSource, checkpoint: chat.checkpoint });
  assert.equal(rebound.source.identity.inode, nextSource.identity.inode); assert.equal(rebound.generation, chat.generation); assert.deepEqual(rebound.history, chat.history);
  const advanced = validateChat({ ...chat, checkpoint: { ...chat.checkpoint, offset: 20, scanOffset: 20, anchor: { start: 0, end: 20, hash: 'a'.repeat(64), rowId: 'native-row' } } });
  assert.throws(() => rebindChatSource(advanced, { generation: advanced.generation, source: nextSource,
    checkpoint: { ...advanced.checkpoint, anchor: { ...advanced.checkpoint.anchor, hash: 'b'.repeat(64) } } }), { code: 'CHAT_SOURCE_TRANSITION_INVALID' });
});
