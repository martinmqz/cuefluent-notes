import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JsonProcess, sameNames, token, object } from '../../../src/processing/clients/protocol.mjs';

test('shared protocol predicates preserve token bounds and exact name multiplicity without mutating inventories', () => {
  const actual = Object.freeze(['b', 'a', 'a']), expected = Object.freeze(['a', 'b', 'a']);
  assert.equal(sameNames(actual, expected), true);
  assert.equal(sameNames(actual, ['a', 'b', 'b']), false);
  assert.equal(sameNames(null, expected), false);
  assert.equal(sameNames(actual, null), false);
  for (const value of ['', 'x'.repeat(257), 'a b', 'a\nb', '\0', '\ud800']) assert.equal(token(value), false);
  assert.equal(token('provider/deployment:1.2-rc'), true);
  for (const value of [null, [], 'text']) assert.equal(object(value), false);
  assert.equal(object({}), true);
});

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let closed = false, kills = 0;
  function close(code = 0, signal = null) {
    if (closed) return;
    closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
  }
  // A client can handle termination and still exit zero. Its protocol failure
  // must survive that exit status.
  child.kill = () => { kills++; queueMicrotask(close); return true; };
  const transport = new JsonProcess('synthetic-native-client', [], { spawn: () => child });
  t.after(() => transport.dispose());
  return { child, transport, close, kills: () => kills };
}

test('native JSON transport preserves multibyte text split at every byte boundary', async t => {
  const { child, transport, close } = fixture(t);
  const value = { type: 'result', text: 'Snow: 雪; smile: 🙂; replacement: \uFFFD' };
  for (const byte of Buffer.from(JSON.stringify(value) + '\n')) child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await transport.next(), value);
  const finished = transport.finish(); close();
  assert.deepEqual(await finished, { code: 0, signal: null });
  await assert.rejects(transport.next(), { code: 'PROCESSING_CLIENT_EXITED' });
});

test('malformed UTF-8 rejects pending native requests instead of substituting text', async t => {
  const { child, transport, kills } = fixture(t);
  const response = transport.request('initialize', {});
  const rejected = assert.rejects(response, { code: 'PROCESSING_PROTOCOL' });
  child.stdout.write(Buffer.concat([Buffer.from('{"id":"cuefluent-1","result":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
  await rejected;
  await assert.rejects(transport.finish(), { code: 'PROCESSING_PROTOCOL' });
  assert.equal(kills(), 1);
});

test('invalid UTF-8 continuation across chunks is rejected', async t => {
  const { child, transport } = fixture(t);
  const rejected = assert.rejects(transport.next(), { code: 'PROCESSING_PROTOCOL' });
  child.stdout.write(Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xe9])]));
  child.stdout.write(Buffer.from([0x28]));
  await rejected;
  await assert.rejects(transport.finish(), { code: 'PROCESSING_PROTOCOL' });
});

for (const [label, tail] of [
  ['partial JSON', Buffer.from('{"unfinished":')],
  ['missing newline', Buffer.from('{"type":"late"}')],
  ['partial UTF-8', Buffer.from([0xf0, 0x9f])],
]) test(`native success does not hide ${label} at EOF`, async t => {
  const { child, transport, close } = fixture(t);
  const result = { type: 'result', ok: true };
  child.stdout.write(JSON.stringify(result) + '\n');
  assert.deepEqual(await transport.next(), result);
  child.stdout.write(tail); close();
  await assert.rejects(transport.finish(), { code: 'PROCESSING_PROTOCOL' });
  await transport.dispose(); // Cleanup must not replace the original failure.
});

test('a complete malformed frame after native success remains fatal even with exit zero', async t => {
  const { child, transport } = fixture(t);
  child.stdout.write('{"type":"result","ok":true}\n');
  assert.equal((await transport.next()).ok, true);
  child.stdout.write('{malformed}\n');
  await assert.rejects(transport.finish(), { code: 'PROCESSING_PROTOCOL' });
});

test('a prior native policy failure survives finish and clean disposal', async t => {
  const { transport } = fixture(t);
  transport.reject('PROCESSING_ISOLATION_UNSUPPORTED');
  await assert.rejects(transport.finish(), { code: 'PROCESSING_ISOLATION_UNSUPPORTED' });
  await transport.dispose();
});

test('clean EOF rejects unfinished readers while preserving the native exit result', async t => {
  const { transport, close } = fixture(t);
  const rejected = assert.rejects(transport.next(), { code: 'PROCESSING_CLIENT_EXITED' });
  close(7);
  await rejected;
  assert.deepEqual(await transport.finish(), { code: 7, signal: null });
});
