import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { testWeights, testShard } from './test-sharding.mjs';

const sourceRoot = path.resolve(import.meta.dirname, '..');

/** Discovery owns coverage. Native timing samples influence placement only. */
export async function planTests(root = sourceRoot, { shard, platform = process.platform } = {}) {
  const discovered = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) discovered.push({
        name: path.relative(root, file).split(path.sep).join('/'), bytes: (await fs.stat(file)).size,
      });
    }
  }
  await visit(path.join(root, 'test'));
  discovered.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (!discovered.length) throw new Error('No test files found.');
  let timings;
  try { timings = JSON.parse(await fs.readFile(path.join(root, 'tools', 'ci-test-timings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const all = discovered.map(file => file.name);
  return { all, files: testShard(all, shard, testWeights(discovered, timings, platform)) };
}

export async function main(args = process.argv.slice(2)) {
  const plan = await planTests(sourceRoot, { shard: process.env.CUEFLUENT_TEST_SHARD });
  // Empty argv would make Node rediscover the full suite, violating the shard.
  if (!plan.files.length) return;
  const result = spawnSync(process.execPath, ['--test', ...args, ...plan.files.map(file => path.join(sourceRoot, ...file.split('/')))],
    { cwd: sourceRoot, stdio: 'inherit', env: process.env });
  if (result.error) { console.error(result.error); process.exitCode = 1; }
  else if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
