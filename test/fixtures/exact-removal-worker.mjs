import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pinDirectory } from '../../src/storage/paths.mjs';
import { removeExact, removalContainerName, writeAtomic } from '../../src/storage/files.mjs';
import { cleanupQueueStep, removeEmptyQueue } from '../../src/storage/queue.mjs';
import { setupProject } from '../../src/control/setup.mjs';

// Exit inside the successful filesystem call: no catch/finally in the runtime
// gets an opportunity to repair the persisted boundary before the parent reads.
export async function interruptRemoval(options) {
  const child = fork(fileURLToPath(import.meta.url), [JSON.stringify(options)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8192); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), process.platform === 'win32' ? 60_000 : 15_000);
  let result;
  try { result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); }
  finally { clearTimeout(timeout); }
  assert.equal(result.code, 42, `Removal child missed ${options.boundary ?? 'capture'}: ${stderr}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { root, relative, expectedHash, operation = 'remove', options, boundary = 'capture' } = JSON.parse(process.argv[2]);
  const target = path.join(root, ...relative.split('/'));
  const directory = path.join(path.dirname(target), removalContainerName(path.basename(target)));
  const rename = fs.rename, link = fs.link, unlink = fs.unlink;
  fs.rename = async (from, to) => {
    const result = await rename(from, to);
    if (boundary === 'capture' && from === target && path.dirname(to) === directory) process.exit(42);
    return result;
  };
  fs.link = async (from, to) => {
    const result = await link(from, to);
    if (boundary === 'restore-link' && to === target && path.dirname(from) === directory) process.exit(42);
    return result;
  };
  fs.unlink = async file => {
    const result = await unlink(file);
    if (boundary === 'unlink' && path.dirname(file) === directory) process.exit(42);
    return result;
  };
  const pin = operation === 'setup' ? null : await pinDirectory(root, { private: true });
  if (operation === 'remove') await removeExact(pin, relative, expectedHash);
  else if (operation === 'write') await writeAtomic(pin, relative, Buffer.from(options.bytes, 'base64'), { expectedHash });
  else if (operation === 'cleanup') await cleanupQueueStep(pin, options.queue, options.request);
  else if (operation === 'prune') await removeEmptyQueue(pin, options.queue, { queueId: options.queueId });
  else if (operation === 'setup') await setupProject(options);
  else throw new Error('Unknown synthetic removal operation.');
}
