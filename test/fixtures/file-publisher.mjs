import fs from 'node:fs/promises';
import { pinDirectory } from '../../src/storage/paths.mjs';
import { writeJSON } from '../../src/storage/files.mjs';
process.on('message', () => {}); // Keep the IPC fixture alive until SIGKILL.

// Freeze immediately after whichever publication syscall the helper uses. The
// parent kills us there, before any staging cleanup or successful return.
for (const method of ['link', 'rename']) {
  const original = fs[method];
  fs[method] = async (...args) => {
    await original(...args);
    process.send({ published: true });
    await new Promise(() => {});
  };
}
const pin = await pinDirectory(process.argv[2], { private: true });
await writeJSON(pin, 'pending.json', { pending: 'synthetic' }, { expectedHash: null });
