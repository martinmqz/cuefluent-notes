import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import reporter from './test-timing-reporter.mjs';

async function rows(events) {
  let text = '';
  for await (const chunk of reporter(events)) text += chunk;
  return text.trim().split('\n').map(line => JSON.parse(line));
}

test('timing reporter records isolated file summaries and a completion total without test or fixture text', async () => {
  const counts = { tests: 3, topLevel: 1, passed: 2, failed: 1, skipped: 0, cancelled: 0, suites: 0, todo: 0 };
  const output = await rows([
    { type: 'test:stdout', data: { message: 'PRIVATE FIXTURE CONTENT' } },
    { type: 'test:pass', data: { name: 'PRIVATE TEST NAME', nesting: 1, details: { duration_ms: 20 } } },
    { type: 'test:summary', data: { file: path.join(os.tmpdir(), 'private-fixture', 'one.test.mjs'), duration_ms: 30, success: false, counts } },
    { type: 'test:summary', data: { duration_ms: 31, success: false, counts } },
  ]);
  assert.equal(output.length, 3); assert.equal(output[0].type, 'start');
  assert.deepEqual(output[1], { version: 1, type: 'file', file: 'one.test.mjs', duration_ms: 30, success: false, counts });
  assert.deepEqual(output[2], { version: 1, type: 'total', duration_ms: 31, success: false, counts });
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|private-fixture/);
  assert.deepEqual((await rows([])).map(row => row.type), ['start'], 'interrupted streams must not invent a completed total');
});

test('real tiny two-phase run preserves both timing files, console failures and second-phase execution', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-timing-# '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'test-support'));
  await fs.writeFile(path.join(root, 'test-support', 'isolated-settings.mjs'), '// Orchestration-only synthetic environment.\n');
  for (const file of ['test.mjs', 'test-sharding.mjs', 'test-timing-reporter.mjs'])
    await fs.copyFile(new URL(file, import.meta.url), path.join(root, file));
  await fs.writeFile(path.join(root, 'collection-hooks.test.mjs'), "import test from 'node:test'; test('first phase failure', () => { throw new Error('expected fixture failure'); });\n");
  await fs.writeFile(path.join(root, 'ordinary.test.mjs'), "import test from 'node:test'; test('second phase success', () => {});\n");
  // Only the parent orchestration sees Windows. Each child runs actual local
  // Node tests with no spoofed ACL, filesystem, client or platform assertions.
  await fs.writeFile(path.join(root, 'preload.mjs'), "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
  const destination = path.join(root, 'timings');
  const env = { ...process.env, CUEFLUENT_TEST_SHARD: '', CUEFLUENT_TEST_TIMINGS: destination };
  delete env.NODE_TEST_CONTEXT; // This fixture starts a separate real runner.
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'preload.mjs')).href, path.join(root, 'test.mjs')],
    { encoding: 'utf8', env });
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /first phase failure/); assert.match(result.stdout, /second phase success/);
  const runFolders = await fs.readdir(destination); assert.equal(runFolders.length, 1);
  const phaseRoot = path.join(destination, runFolders[0]);
  assert.deepEqual((await fs.readdir(phaseRoot)).sort(), ['parallel.jsonl', 'serial.jsonl']);
  for (const [phase, file, success] of [['serial', 'collection-hooks.test.mjs', false], ['parallel', 'ordinary.test.mjs', true]]) {
    const entries = (await fs.readFile(path.join(phaseRoot, `${phase}.jsonl`), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
    assert.equal(entries[0].phase, phase); assert.equal(entries[0].type, 'start');
    const summaries = entries.filter(row => row.type === 'file');
    assert.equal(summaries.length, 1); assert.equal(summaries[0].file, file); assert.equal(summaries[0].success, success);
    assert(summaries[0].duration_ms >= 0); assert.equal(summaries[0].counts.tests, 1);
    assert.equal(entries.at(-1).type, 'total'); assert.equal(entries.at(-1).success, success);
  }
});
