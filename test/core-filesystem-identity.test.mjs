import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createChat, validateChat } from '../src/core/chat.mjs';
import { LIVE_DEVICE } from '../src/core/filesystem-identity.mjs';
import { fileIdentity, sameIdentity } from '../src/storage/paths.mjs';

const volume = '1'.repeat(32);
const observation = () => ({ dev: 11n, ino: 23n, volume });
const chat = identity => createChat({ client: 'claude', sessionId: 'synthetic-identity', projectId: 'synthetic',
  source: { path: path.join(tmpdir(), 'synthetic-identity.jsonl'), identity } });

test('identity copies retain their live observation while durable JSON contains only stable fields', () => {
  const identity = fileIdentity(observation());
  const copied = { ...identity };
  const durable = JSON.parse(JSON.stringify(identity));
  assert.equal(copied[LIVE_DEVICE], '11');
  assert.equal(sameIdentity(observation(), copied), true);
  assert.deepEqual(Reflect.ownKeys(durable), ['device', 'inode']);
  assert.deepEqual(durable, { device: process.platform === 'darwin' ? `volume:${volume}` : '11', inode: '23' });
  assert.equal(sameIdentity(observation(), durable), true);
  assert.equal(sameIdentity({ ...observation(), ino: 24n }, durable), false);
  assert.equal(chat(identity).source.identity[LIVE_DEVICE], '11');
  assert.equal(chat(durable).source.identity[LIVE_DEVICE], undefined);
});

test('a resumed macOS identity survives device renumbering while an active observation stays pinned', { skip: process.platform !== 'darwin' }, () => {
  const live = fileIdentity(observation());
  const retained = JSON.parse(JSON.stringify(live));
  const afterRestart = { ...observation(), dev: 12n };
  assert.equal(sameIdentity(afterRestart, live), false);
  assert.equal(sameIdentity(afterRestart, { ...live }), false);
  assert.equal(sameIdentity(afterRestart, retained), true);
  assert.equal(sameIdentity({ ...afterRestart, volume: '2'.repeat(32) }, retained), false);
  assert.equal(sameIdentity({ ...afterRestart, ino: 24n }, retained), false);
});

test('identity validation refuses unknown symbols and non-data live observations without evaluating accessors', () => {
  const durable = JSON.parse(JSON.stringify(fileIdentity(observation())));
  assert.throws(() => chat({ ...durable, [Symbol('unknown')]: '11' }), { code: 'CHAT_INVALID' });
  for (const descriptor of [
    { value: '11', enumerable: false },
    { value: 11, enumerable: true },
    { value: 'volume:invalid', enumerable: true },
  ]) {
    const identity = Object.defineProperty({ ...durable }, LIVE_DEVICE, descriptor);
    assert.throws(() => chat(identity), { code: 'CHAT_INVALID' });
  }
  let calls = 0;
  const accessor = Object.defineProperty({ ...durable }, LIVE_DEVICE, {
    enumerable: true, get() { calls++; return '11'; },
  });
  assert.throws(() => chat(accessor), { code: 'CHAT_INVALID' });
  assert.equal(calls, 0);
});

test('live observation symbols do not exempt non-identity chat objects or arrays from exact validation', () => {
  const current = chat(JSON.parse(JSON.stringify(fileIdentity(observation()))));
  const misplaced = { ...current, [LIVE_DEVICE]: '11' };
  assert.throws(() => validateChat({ ...current, source: { ...current.source, [LIVE_DEVICE]: '11' } }), { code: 'CHAT_INVALID' });
  // Validate the full outer record and a history array directly: neither is an
  // identity observation, even though its children may carry live identities.
  assert.throws(() => validateChat(misplaced), { code: 'CHAT_INVALID' });
  const historySources = Object.assign([], { [LIVE_DEVICE]: '11' });
  assert.throws(() => validateChat({ ...current, historySources }), { code: 'CHAT_HISTORY_INVALID' });
});
