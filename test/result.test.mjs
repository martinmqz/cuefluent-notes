import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { completedResult } from '../src/core/result.mjs';

test('completed outcomes report only notes that actually changed', () => {
  const original = path.join(os.tmpdir(), 'unchanged.md'), updated = path.join(os.tmpdir(), 'changed.md');
  const run = { id: '12345678-1234-4123-8123-123456789abc', projectId: 'synthetic', selection: [{}], warnings: [], saved: [{ target: original, changed: false }] };
  const nothing = completedResult(run, { remaining: 0 });
  assert.equal(nothing.status, 'nothing-useful'); assert.deepEqual(nothing.paths, []);
  assert.deepEqual(nothing.counts, { handled: 1, saved: 0, remaining: 0 });
  run.saved.push({ target: updated, changed: true });
  const mixed = completedResult(run, { remaining: 2 });
  assert.equal(mixed.status, 'saved'); assert.deepEqual(mixed.paths, [updated]); assert.equal(mixed.counts.saved, 1);
  const skipped = completedResult(run, { skipped: true });
  assert.equal(skipped.status, 'skipped'); assert.deepEqual(skipped.paths, [updated]); assert.equal(skipped.counts.handled, 0);
});
