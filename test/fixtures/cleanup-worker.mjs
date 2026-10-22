import fs from 'node:fs/promises';
import path from 'node:path';
import { publishDrafts } from '../../src/core/run.mjs';
import { openStore } from '../../src/storage/store.mjs';
import { ownAttempt, withCurrentAttempt } from '../../src/storage/attempts.mjs';
import { writeJSON } from '../../src/storage/files.mjs';
import { cleanupRun } from '../../src/processing/cleanup.mjs';

const [root, serialized] = process.argv.slice(2), options = JSON.parse(serialized);
const store = await openStore(path.join(root, 'private'));
if (options.stopAfterProgress) {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    const run = path.basename(to) === 'run.json' ? JSON.parse(await fs.readFile(from, 'utf8')) : null;
    const result = await rename(from, to);
    if (run?.cleanup.next === 1 && run.cleanup.ack) {
      await fs.writeFile(path.join(root, 'progress'), 'durable'); await new Promise(() => {});
    }
    return result;
  };
}
try {
  const result = await ownAttempt(store, 'project', options, async owner => {
    await withCurrentAttempt(owner, async ({ run, hash, directory }) => {
      if (run.phase === 'drafting') await writeJSON(store.pin, `${directory}/run.json`, publishDrafts(run, owner.attemptId, []), { expectedHash: hash });
    });
    return cleanupRun(store, owner);
  });
  await fs.writeFile(path.join(root, 'outcome.json'), JSON.stringify(result));
} catch (error) {
  await fs.writeFile(path.join(root, 'error.json'), JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1;
}
