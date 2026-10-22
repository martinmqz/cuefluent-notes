import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openStore } from '../../src/storage/store.mjs';
import { ownAttempt } from '../../src/storage/attempts.mjs';
import { prepareRunDrafts } from '../../src/processing/draft.mjs';
import { readFrames, writeFrame } from '../../src/processing/draft-protocol.mjs';

const [root, serialized] = process.argv.slice(2), options = JSON.parse(serialized);
const store = await openStore(path.join(root, 'private'));
async function syntheticModel({ mcp }) {
  if (options.rejectModel) throw new Error('A recovered complete set must not call a model.');
  await fs.writeFile(path.join(root, 'model-called'), 'yes');
  const child = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const pending = new Map(); let id = 0;
  readFrames(child.stdout, message => pending.get(message.id)?.(message), () => child.kill());
  const call = (method, params) => new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, resolve); writeFrame(child.stdin, { jsonrpc: '2.0', id: next, method, params }).catch(reject);
  });
  try {
    await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1' } });
    await writeFrame(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const drafted = await call('tools/call', { name: 'draft_note', arguments: { target: 'decisions/retry.md', content: '# Retry decision\n\n## Design\nUse exact original hashes.\n', summary: 'Record the retry design.', heading: 'Design' } });
    if (drafted.result?.isError) throw new Error('Synthetic draft failed.');
    if (!options.unfinished) {
      const done = await call('tools/call', { name: 'finish_drafting', arguments: { outcome: 'drafted' } });
      if (done.result?.isError) throw new Error('Synthetic finish failed.');
    }
    return { status: 'completed' };
  } finally { child.stdin.end(); await exited; }
}
if (options.stopAfterReady) {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (path.basename(to) === 'run.json') {
      const proposed = JSON.parse(await fs.readFile(from, 'utf8'));
      if (proposed.phase === 'review') {
        await fs.writeFile(path.join(root, 'drafts-ready'), 'durable'); await new Promise(() => {});
      }
    }
    return rename(from, to);
  };
}
try {
  await ownAttempt(store, 'project', options, async owner => {
    const run = await prepareRunDrafts(store, owner, { client: 'codex', skillVersion: '2.0.0-dev.0', runClient: syntheticModel });
    await fs.writeFile(path.join(root, 'draft-outcome.json'), JSON.stringify({ phase: run.phase, drafts: run.drafts.length }));
  });
} catch (error) {
  await fs.writeFile(path.join(root, 'error.json'), JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1;
}
