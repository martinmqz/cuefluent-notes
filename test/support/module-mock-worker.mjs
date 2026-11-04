import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

export async function moduleMockDirectory(t, prefix) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  // The parent owns cleanup even when a worker is killed or canonicalization fails.
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return fs.realpath(temporary);
}

export async function runModuleMockWorker(worker, args, { allowedExit = null } = {}) {
  let result;
  try {
    result = await execute(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(worker), ...args],
      { timeout: 25_000, maxBuffer: 256 * 1024 });
  } catch (error) {
    if (allowedExit !== null && error.code === allowedExit) return;
    assert.fail(`${path.basename(fileURLToPath(worker))} ${args.slice(1).join(' ')} failed (${error.code ?? 'unknown'}): ${error.stderr ?? error.message}`);
  }
  assert.match(result.stdout, /"verified":true/);
}
