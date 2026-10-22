import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';

/** Dedicated test pipe: production startup IPC deliberately closes on activation.
 * This hang guard applies only to synthetic filesystem workers, never a model. */
export function waitForReplacement(child, target, exited) {
  const pipe = child.stdio[4];
  let settle, buffer = '';
  const boundary = new Promise((resolve, reject) => {
    settle = error => {
      clearTimeout(timer); pipe.off('data', onData);
      if (error) reject(error); else resolve();
    };
  });
  let finished = false;
  const finish = error => { if (!finished) { finished = true; settle(error); } };
  const onData = chunk => {
    buffer += chunk;
    if (buffer.length > 8192) { finish(new Error('Synthetic publication boundary exceeded its message limit.')); return; }
    if (!buffer.includes('\n')) return;
    try {
      const message = JSON.parse(buffer.trim());
      if (message.type !== 'publication-replaced' || message.target !== target) throw new Error('Unexpected synthetic publication boundary.');
      finish();
    } catch (error) { finish(error); }
  };
  const timer = setTimeout(() => finish(new Error(`Synthetic worker did not report replacement of ${target} within 120s; still running=${child.exitCode === null}.`)), 120_000);
  pipe.on('data', onData);
  exited.then(exit => finish(new Error(`Synthetic worker exited before replacement: ${JSON.stringify(exit)}`)));
  boundary.catch(() => {}); // Startup can fail before the caller awaits this.
  return boundary;
}

/** Pause when the writer first inspects the replaced target, before its receipt.
 * This observes the publication inode for both rename and native ReplaceFileW. */
export async function stopAfterReplacement(target, marker) {
  const original = await fs.stat(target, { bigint: true }), open = fs.open;
  fs.open = async (file, ...options) => {
    const handle = await open(file, ...options);
    if (file === target) {
      const current = await handle.stat({ bigint: true });
      if (current.dev !== original.dev || current.ino !== original.ino) {
        await fs.writeFile(marker, 'Published replacement inode observed before receipt.');
        writeSync(4, JSON.stringify({ type: 'publication-replaced', target }) + '\n');
        await new Promise(() => {});
      }
    }
    return handle;
  };
}
