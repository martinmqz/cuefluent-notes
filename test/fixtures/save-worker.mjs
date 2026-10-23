import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { openStore, withProject } from '../../src/storage/store.mjs';
import { ownAttempt, withCurrentAttempt } from '../../src/storage/attempts.mjs';
import { writeJSON, readJSON } from '../../src/storage/files.mjs';
import { beginSaving, replaceAttempt } from '../../src/core/run.mjs';
import { saveRunNotes, readPrivateDraft } from '../../src/processing/save.mjs';
import { cleanupRun } from '../../src/processing/cleanup.mjs';
import { stopAfterReplacement } from './publication-boundary.mjs';

const [root, serialized] = process.argv.slice(2), options = JSON.parse(serialized);
const store = await openStore(path.join(root, 'private'));
if (options.supersedeBeforePublish) {
  const open = fs.open; let superseded = false;
  fs.open = async function(file, ...args) {
    const handle = await open.call(this, file, ...args);
    if (path.basename(file).startsWith('.cuefluent-note.')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        const result = await write(...values);
        if (!superseded) {
          superseded = true;
          await withProject(store, 'project', async ({ directory }) => {
            const saved = await readJSON(store.pin, `${directory}/run.json`);
            await writeJSON(store.pin, `${directory}/run.json`, replaceAttempt(saved.value, randomUUID()), { expectedHash: saved.hash });
          });
        }
        return result;
      };
    }
    return handle;
  };
}
if (options.stopAfterNote) {
  await stopAfterReplacement(path.join(root, 'notes', 'design.md'), path.join(root, 'saved-boundary'));
}
try {
  await ownAttempt(store, 'project', options, async owner => {
    await withCurrentAttempt(owner, async ({ run, hash, directory }) => {
      if (run.phase === 'review') await writeJSON(store.pin, `${directory}/run.json`, beginSaving(run, owner.attemptId), { expectedHash: hash });
    });
    await saveRunNotes(store, owner, { readDraft: async (...args) => {
      if (options.holdDraft) {
        await fs.writeFile(path.join(root, 'draft-reading'), '');
        const deadline = Date.now() + 10000;
        while (true) {
          try { await fs.stat(path.join(root, 'continue-draft')); break; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (Date.now() >= deadline) throw new Error('Draft fixture was not released.');
          await delay(10);
        }
      }
      return readPrivateDraft(...args);
    } });
    await fs.writeFile(path.join(root, 'outcome.json'), JSON.stringify(await cleanupRun(store, owner)));
  });
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code, message: error.message }) + '\n');
  await fs.writeFile(path.join(root, 'error.json'), JSON.stringify({ code: error.code, message: error.message }));
  process.exitCode = 1;
}
