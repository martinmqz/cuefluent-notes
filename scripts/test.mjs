import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Expand test files in Node, independently of PowerShell/cmd/POSIX glob rules.
const directory = path.dirname(fileURLToPath(import.meta.url));
const files = (await fs.readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort();
if (!files.length) throw new Error('No test files found.');
const result = spawnSync(process.execPath,
  ['--test', ...process.argv.slice(2), ...files.map(file => path.join(directory, file))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
