import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/storage/store.mjs';
import { collectChat } from '../../src/sync/collect.mjs';
import { launchSyncAttempt, runSyncSteward } from '../../src/sync/ingress.mjs';

const [mode, root, client, sessionId] = process.argv.slice(2), store = await openStore(root);
const fixtureRoot = path.dirname(root), entry = fileURLToPath(import.meta.url);
async function marker(name, data) {
  const staged = path.join(fixtureRoot, `.${name}.${process.pid}.tmp`);
  await fs.writeFile(staged, JSON.stringify(data)); await fs.rename(staged, path.join(fixtureRoot, name));
}
if (mode === 'sync-steward') {
  const controller = new AbortController(); process.on('SIGTERM', () => controller.abort());
  const result = await runSyncSteward(store, { signal: controller.signal, retryDelayMs: 25, maxRetryDelayMs: 100, idleDelayMs: 50,
    attempt: input => launchSyncAttempt({ ...input, entry }) });
  await marker('steward-finished.json', result);
} else if (mode === 'sync-collect') {
  await marker('collector-started.json', { pid: process.pid });
  try { await fs.unlink(path.join(fixtureRoot, 'crash-next-collector')); await marker('collector-crashed.json', { pid: process.pid }); process.exit(23); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = await collectChat(store, { client, sessionId, classifyCommand: async () => null });
  process.send(result, () => process.disconnect());
} else throw new Error('Unsupported synthetic worker mode');
