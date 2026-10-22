import fs from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { runClaimedInvocation, reportInvocationExit } from '../../src/control/invocations.mjs';

const [root, handle, mode] = process.argv.slice(2);
if (mode === 'before-ready') process.exit(1);
try {
  const store = await openStore(root);
  const result = await runClaimedInvocation(store, handle, { channel: process, execute: async () => {
    await fs.appendFile(path.join(root, 'executions'), 'one\n', { mode: 0o600 }); return { state: 'tracked' };
  } });
  await reportInvocationExit(process, handle, result);
} catch { process.exitCode = 1; }
