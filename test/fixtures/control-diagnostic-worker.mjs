import fs from 'node:fs/promises';
import path from 'node:path';
import { createControlBridge, serveControl } from '../../src/client/control-server.mjs';
import { reportFailure } from '../../src/diagnostics.mjs';

const root = process.argv[2];
let release, ended;
const publication = new Promise(resolve => { release = resolve; });
const failed = new Promise(resolve => { ended = resolve; });
process.on('message', message => { if (message === 'finish') release(); });
const bridge = createControlBridge({ client: 'claude', readInvocation: async () => ({ state: 'idle' }), directNotes: {
  tools: [{ name: 'cuefluent_create_note', inputSchema: { type: 'object' } }],
  async call() {
    await fs.writeFile(path.join(root, 'note.tmp'), '# Synthetic note\n');
    process.send('started');
    await publication;
    await fs.rename(path.join(root, 'note.tmp'), path.join(root, 'note.md'));
    return { state: 'saved' };
  },
} });
const transport = serveControl(bridge, { version: '0.17.1', onFailure(error) {
  reportFailure(error, { stage: 'transport', operation: 'mcp', client: 'claude', version: '0.17.1' });
  process.exitCode = 1;
  process.stdin.destroy();
  ended();
  // Give the closed OS pipe's asynchronous error a chance to arrive before
  // completing the publication. No fixture error handler masks that failure.
  setTimeout(() => process.send('failure-observed'), 50);
} });
await failed;
await transport.idle();
await fs.writeFile(path.join(root, 'resources-closed'), 'closed');
process.disconnect();
