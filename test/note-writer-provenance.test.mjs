import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/note-writer-provenance.mjs', import.meta.url));
const cases = [
  ['save', 'macOS provenance differences permit exact publication without losing other metadata'],
  ['capture', 'captured originals recover despite changed macOS provenance'],
  ['recover', 'published notes recover and clean up despite changed macOS provenance'],
  ['absent', 'a note without provenance can be replaced by a stage with OS provenance'],
  ['stage-xattr', 'a user xattr changed only on the stage prevents publication'],
  ['stage-quarantine', 'quarantine added only to the stage prevents publication'],
  ['mode', 'provenance tolerance still refuses and preserves concurrent mode changes'],
  ['xattr', 'provenance tolerance still refuses and preserves concurrent user xattr changes'],
  ['quarantine', 'provenance tolerance still refuses and preserves concurrent quarantine changes'],
  ['acl', 'provenance tolerance still refuses and preserves concurrent ACL changes'],
];

for (const [scenario, title] of cases) {
  test(title, { skip: process.platform !== 'darwin', timeout: 30_000 }, async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-provenance-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const root = await fs.realpath(temporary);
    let result;
    try {
      result = await execute(process.execPath, ['--experimental-test-module-mocks', worker, root, scenario],
        { timeout: 25_000, maxBuffer: 256 * 1024 });
    } catch (error) {
      assert.fail(`${scenario} failed (${error.code ?? 'unknown'}): ${error.stderr ?? error.message}`);
    }
    assert.match(result.stdout, /"verified":true/);
  });
}
