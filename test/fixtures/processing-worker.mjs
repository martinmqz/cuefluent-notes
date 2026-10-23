import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../../src/storage/store.mjs';
import { ownAttempt } from '../../src/storage/attempts.mjs';
import { runProcessingWork } from '../../src/processing/worker.mjs';
import { readFrames, writeFrame } from '../../src/processing/draft-protocol.mjs';

const [root, serialized] = process.argv.slice(2), options = JSON.parse(serialized);
const store = await openStore(path.join(root, 'private'));
async function syntheticModel({ mcp }) {
  if (options.rejectModel) throw Object.assign(new Error('Fixture rejects another model call.'), { code: 'SYNTHETIC_MODEL_FAILURE' });
  await fs.writeFile(path.join(root, 'model-started'), 'ready');
  if (options.waitForRelease) {
    for (;;) {
      try { await fs.access(path.join(root, 'release-model')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(20);
    }
  }
  const child = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const pending = new Map(); let id = 0;
  readFrames(child.stdout, message => { const resolve = pending.get(message.id); pending.delete(message.id); resolve?.(message); }, () => child.kill());
  const call = (method, params) => new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, resolve); writeFrame(child.stdin, { jsonrpc: '2.0', id: next, method, params }).catch(reject);
  });
  const tool = async (name, args) => {
    const response = await call('tools/call', { name, arguments: args });
    if (response.error || response.result?.isError) throw new Error(`Synthetic ${name} failed: ${JSON.stringify(response)}`);
    return response.result;
  };
  try {
    await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1' } });
    await writeFrame(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
    for (const target of options.targets ?? ['decisions/retry.md']) {
      if (options.readExisting) await tool('read_note', { target });
      await tool('draft_note', { target, content: '# Retry decision\n\n## Design\nUse exact original hashes.\n', summary: 'Record the retry design.', heading: 'Design' });
    }
    await tool('finish_drafting', { outcome: options.targets?.length === 0 ? 'nothing-useful' : 'drafted' });
    return { status: 'completed' };
  } finally { child.stdin.end(); await exited; }
}
if (options.stopAtCleanup) {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    const value = path.basename(to) === 'run.json' ? JSON.parse(await fs.readFile(from, 'utf8')) : null;
    const result = await rename(from, to);
    if (value?.phase === 'cleanup') {
      await fs.writeFile(path.join(root, 'cleanup-ready'), 'durable'); await new Promise(() => {});
    }
    return result;
  };
}
try {
  const result = await ownAttempt(store, 'project', options, owner => runProcessingWork(store, owner,
    { ...options, client: 'codex', skillVersion: '0.16.0-dev.0', runClient: syntheticModel }));
  await fs.writeFile(path.join(root, `outcome-${options.attemptId}.json`), JSON.stringify(result));
} catch (error) {
  await fs.writeFile(path.join(root, `error-${options.attemptId}.json`), JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1;
}
