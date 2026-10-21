import './test-support/isolated-settings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testWeights, testShard } from './test-sharding.mjs';

// Expand test files in Node, independently of PowerShell/cmd/POSIX glob rules.
const directory = path.dirname(fileURLToPath(import.meta.url));
const all = (await fs.readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort();
if (!all.length) throw new Error('No test files found.');
// Every shard discovers the same files. Timing samples only influence placement.
let timings;
try { timings = JSON.parse(await fs.readFile(new URL('./test-support/ci-test-timings.json', import.meta.url), 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  console.error('Test timing samples unavailable; using deterministic file-size weights.');
}
const discovered = await Promise.all(all.map(async name => ({ name, bytes: (await fs.stat(path.join(directory, name))).size })));
const files = testShard(all, process.env.CUEFLUENT_TEST_SHARD, testWeights(discovered, timings, process.platform));
const forwarded = process.argv.slice(2), timingRoot = process.env.CUEFLUENT_TEST_TIMINGS;
let timingDirectory;
if (timingRoot) {
  if (forwarded.some(arg => /^--test-reporter(?:=|-destination(?:=|$)|$)/.test(arg)))
    throw new Error('CUEFLUENT_TEST_TIMINGS supplies its own reporters; do not also pass reporter options.');
  await fs.mkdir(path.resolve(timingRoot), { recursive: true });
  timingDirectory = await fs.mkdtemp(path.join(path.resolve(timingRoot), 'run-'));
}
// Real-clock hook/worker checks must not compete with filesystem stress fixtures
// on Windows. Preserve their production deadlines and run every test once.
const timed = new Set(['collection-hooks.test.mjs', 'collection-package.test.mjs', 'windows-discovery.test.mjs', 'windows-acl-probe.test.mjs']);
const phases = process.platform === 'win32'
  ? [{ files: files.filter(file => timed.has(file)), serial: true },
    { files: files.filter(file => !timed.has(file)), serial: false }]
  : [{ files, serial: false }];
for (const phase of phases) {
  if (!phase.files.length) continue; // Empty argv would make Node rediscover every test.
  const result = spawnSync(process.execPath,
    ['--test', ...forwarded, ...(phase.serial ? ['--test-concurrency=1'] : []),
      ...(timingDirectory ? ['--test-reporter=tap', '--test-reporter-destination=stdout',
        `--test-reporter=${pathToFileURL(path.join(directory, 'test-timing-reporter.mjs')).href}`,
        `--test-reporter-destination=${path.join(timingDirectory, phase.serial ? 'serial.jsonl' : 'parallel.jsonl')}`] : []),
      ...phase.files.map(file => path.join(directory, file))], { stdio: 'inherit',
      env: { ...process.env, CUEFLUENT_TEST_TIMING_PHASE: phase.serial ? 'serial' : 'parallel' } });
  if (result.error) console.error(result.error);
  if (result.error || result.status !== 0) process.exitCode ||= result.error ? 1 : result.status ?? 1;
}
