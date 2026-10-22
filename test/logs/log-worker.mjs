import fs from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { ownAttempt } from '../../src/storage/attempts.mjs';
import { flushRunLogs } from '../../src/processing/logging.mjs';
import { stopAfterReplacement } from '../fixtures/publication-boundary.mjs';

const [root, serialized] = process.argv.slice(2), options = JSON.parse(serialized);
const store = await openStore(path.join(root, 'private'));
if (options.stopAfterReplace) {
  await stopAfterReplacement(path.join(root, 'notes', 'logs', '2026.md'), path.join(root, 'log-replaced'));
}
try {
  await ownAttempt(store, 'synthetic', options, async owner => {
    const result = await flushRunLogs(store, owner, { skillVersion: '2.0.0' });
    await fs.writeFile(path.join(root, 'log-result.json'), JSON.stringify(result));
  });
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code, message: error.message }) + '\n');
  await fs.writeFile(path.join(root, 'log-error.json'), JSON.stringify({ code: error.code }));
  process.exitCode = 1;
}
