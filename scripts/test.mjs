import './test-support/isolated-settings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Expand test files in Node, independently of PowerShell/cmd/POSIX glob rules.
const directory = path.dirname(fileURLToPath(import.meta.url));
const all = (await fs.readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort();
if (!all.length) throw new Error('No test files found.');
// CI can run the suite as parallel jobs: CUEFLUENT_TEST_SHARD=i/n runs the i-th
// of n disjoint shards. Files are balanced by size, largest first, onto the
// shard with the fewest bytes, then the fewest files, so jobs of one checkout
// run every file in exactly one shard.
async function shardOf(files, spec) {
  if (!spec) return files;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(spec);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`Invalid CUEFLUENT_TEST_SHARD: ${spec}`);
  const [index, count] = [Number(match[1]), Number(match[2])];
  const sizes = new Map(await Promise.all(files.map(async file => [file, (await fs.stat(path.join(directory, file))).size])));
  const loads = Array.from({ length: count }, () => ({ bytes: 0, files: 0 })), owners = new Map();
  for (const file of [...files].sort((a, b) => sizes.get(b) - sizes.get(a) || (a < b ? -1 : 1))) {
    const shard = loads.reduce((best, load, index) => load.bytes < loads[best].bytes ||
      (load.bytes === loads[best].bytes && load.files < loads[best].files) ? index : best, 0);
    loads[shard].bytes += sizes.get(file); loads[shard].files++; owners.set(file, shard + 1);
  }
  return files.filter(file => owners.get(file) === index);
}
const files = await shardOf(all, process.env.CUEFLUENT_TEST_SHARD);
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
    ['--test', ...process.argv.slice(2), ...(phase.serial ? ['--test-concurrency=1'] : []),
      ...phase.files.map(file => path.join(directory, file))], { stdio: 'inherit' });
  if (result.error) console.error(result.error);
  if (result.error || result.status !== 0) process.exitCode ||= result.error ? 1 : result.status ?? 1;
}
