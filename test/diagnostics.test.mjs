import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, supportsNode } from '../src/diagnostics.mjs';

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
  assert.match(result.message, /could not complete/); assert.match(result.recovery, /latest status/);
  assert.equal(result.diagnostics.stage, 'tool');
  assert.equal(describeFailure({ code: 'secret\ntext', message: 'private' }).error, 'CUEFLUENT_FAILED');
});
