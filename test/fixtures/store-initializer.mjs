import fs from 'node:fs/promises';
import path from 'node:path';
import nativeFs, { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { initializeStore } from '../../src/storage/store.mjs';

const [root, relative, boundary] = process.argv.slice(2);
const metadataBoundary = ['store/layout.json', 'config/settings.json'].includes(relative) && ['open', 'partial', 'complete'].includes(boundary);
const gateBoundary = ['settings', 'writer', 'sync'].some(id => relative === `store/locks/${id}.sqlite`) && boundary === 'linked';
if (!metadataBoundary && !gateBoundary) {
  throw new Error('Invalid synthetic initialization boundary.');
}
const target = path.join(root, ...relative.split('/'));
const isStage = file => typeof file === 'string' && path.dirname(file) === path.dirname(target) &&
  path.basename(file).startsWith(`.${path.basename(target)}.`) && file.endsWith('.tmp');
let stopped = false;
async function pause(stage, totalBytes = null) {
  if (stopped) throw new Error('Duplicate synthetic initialization boundary.');
  stopped = true;
  // A real process kill must bypass the publisher's catch/finally cleanup.
  // The interval retains the process even after the notification is delivered.
  setInterval(() => {}, 1000);
  await new Promise((resolve, reject) => process.send({ type: 'stage', stage, boundary, totalBytes }, error => error ? reject(error) : resolve()));
  await new Promise(() => {});
}

const open = fs.open, rename = fs.rename;
fs.open = async (file, flags, ...args) => {
  const handle = await open(file, flags, ...args);
  if (!isStage(file) || typeof flags !== 'number' || !(flags & constants.O_CREAT)) return handle;
  if (boundary === 'open') await pause(file);
  if (boundary === 'partial') {
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = async bytes => {
      bytes = Buffer.from(bytes);
      await writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      await handle.sync();
      await pause(file, bytes.length);
    };
  }
  return handle;
};
fs.rename = async (from, to) => {
  if (boundary === 'complete' && to === target && isStage(from)) await pause(from);
  return rename(from, to);
};
const linkSync = nativeFs.linkSync;
nativeFs.linkSync = (from, to, ...args) => {
  const result = linkSync(from, to, ...args);
  if (gateBoundary && to === target && isStage(from)) {
    // Die inside the synchronous publisher before it can unlink the stage.
    // The parent inspects the surviving pair after exit; no IPC delivery is needed.
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
syncBuiltinESMExports();

try {
  await initializeStore(root);
  await new Promise((resolve, reject) => process.send({ type: 'unexpected-completion' }, error => error ? reject(error) : resolve()));
  process.exitCode = 1;
} catch (error) {
  if (process.connected) await new Promise(resolve => process.send({ type: 'error', code: error.code ?? 'SYNTHETIC_INITIALIZATION_FAILED' }, () => resolve()));
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
