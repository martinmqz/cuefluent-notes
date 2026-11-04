import test from 'node:test';
import { moduleMockDirectory, runModuleMockWorker } from './support/module-mock-worker.mjs';

const worker = new URL('./fixtures/reboot-recovery-worker.mjs', import.meta.url);
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
    const root = await moduleMockDirectory(t, 'cue-reboot-');
    for (const phase of ['prepare', 'resume']) {
      const allowedExit = phase === 'prepare' && ['layout', 'settings', 'removal', 'queue'].includes(scenario) ? 42 : null;
      await runModuleMockWorker(worker, [root, scenario, phase], { allowedExit });
    }
  });
}
