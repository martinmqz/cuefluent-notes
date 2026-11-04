import test from 'node:test';
import { moduleMockDirectory, runModuleMockWorker } from './support/module-mock-worker.mjs';

const worker = new URL('./fixtures/note-writer-provenance.mjs', import.meta.url);
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
    const root = await moduleMockDirectory(t, 'cue-provenance-');
    await runModuleMockWorker(worker, [root, scenario]);
  });
}
