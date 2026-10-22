import fs from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { ownAttempt, withCurrentAttempt } from '../../src/storage/attempts.mjs';
import { writeJSON } from '../../src/storage/files.mjs';
import { beginSaving } from '../../src/core/run.mjs';
import { saveRunNotes } from '../../src/processing/save.mjs';
import { cleanupRun } from '../../src/processing/cleanup.mjs';
import { stopAfterReplacement } from './publication-boundary.mjs';

const [root, serialized] = process.argv.slice(2), options = JSON.parse(serialized);
const store = await openStore(path.join(root, 'private'));
if (options.stopAfterNote) {
  await stopAfterReplacement(path.join(root, 'notes', 'design.md'), path.join(root, 'saved-boundary'));
}
try {
  await ownAttempt(store, 'project', options, async owner => {
    await withCurrentAttempt(owner, async ({ run, hash, directory }) => {
      if (run.phase === 'review') await writeJSON(store.pin, `${directory}/run.json`, beginSaving(run, owner.attemptId), { expectedHash: hash });
    });
    await saveRunNotes(store, owner);
    await fs.writeFile(path.join(root, 'outcome.json'), JSON.stringify(await cleanupRun(store, owner)));
  });
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code, message: error.message }) + '\n');
  await fs.writeFile(path.join(root, 'error.json'), JSON.stringify({ code: error.code, message: error.message }));
  process.exitCode = 1;
}
