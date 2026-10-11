import './test-support/isolated-settings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Expand test files in Node, independently of PowerShell/cmd/POSIX glob rules.
const directory = path.dirname(fileURLToPath(import.meta.url));
const files = (await fs.readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort();
if (!files.length) throw new Error('No test files found.');
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
