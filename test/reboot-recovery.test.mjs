import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/reboot-recovery-worker.mjs', import.meta.url));
const cases = [
  ['direct', 'retained direct draft can be reviewed, saved and cleaned after device renumbering'],
  ['direct-replaced', 'retained direct draft still refuses a replaced payload after device renumbering'],
  ['source', 'tracked Claude collection resumes its exact checkpoint after device renumbering'],
  ['layout', 'interrupted initial layout publication resumes after device renumbering'],
  ['settings', 'interrupted initial settings publication resumes after device renumbering'],
  ['setup', 'interrupted project setup resumes after device renumbering'],
  ['removal', 'exact-removal capture remains readable and removable after device renumbering'],
  ['queue', 'interrupted empty queue pruning resumes after device renumbering'],
];

// A separate process for each phase drops all in-memory pins. The fixture shifts
// the normalized live device only after native UUID verification, while retaining
// the same real volume and inodes. This proves simulated renumbering recovery,
// not that this test rebooted the operating system.
for (const [scenario, title] of cases) {
  test(title, { skip: process.platform !== 'darwin', timeout: 60_000 }, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-reboot-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const phase of ['prepare', 'resume']) {
      let result;
      try {
        result = await execute(process.execPath, ['--experimental-test-module-mocks', worker, root, scenario, phase], { timeout: 25_000, maxBuffer: 256 * 1024 });
      } catch (error) {
        if (phase === 'prepare' && ['layout', 'settings', 'removal', 'queue'].includes(scenario) && error.code === 42) continue;
        assert.fail(`${scenario} ${phase} failed (${error.code ?? 'unknown'}): ${error.stderr ?? error.message}`);
      }
      assert.match(result.stdout, /"verified":true/);
    }
  });
}
