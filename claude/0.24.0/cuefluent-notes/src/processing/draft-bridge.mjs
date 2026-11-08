import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { readFrames, writeFrame } from './draft-protocol.mjs';

/** The stdio child holds no note or run writer. All requests are sent back to
 * its owning worker, whose capability disappears when that worker exits. */
export async function runDraftBridge({ endpoint, token, input = process.stdin, output = process.stdout }) {
  if (typeof endpoint !== 'string' || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid draft bridge capability.');
  const socket = net.createConnection(endpoint);
  let stopped = false, authenticated = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true; socket.destroy(); input.pause(); input.unref?.();
    input.removeListener('end', stop); resolveDone();
  };
  input.pause();
  const stdin = readFrames(input, async message => { if (authenticated) await writeFrame(socket, message); }, stop);
  readFrames(socket, async message => {
    if (!authenticated) {
      if (message?.ready !== true || Object.keys(message).length !== 1) throw new Error('Draft bridge authentication failed.');
      authenticated = true; input.resume(); return;
    }
    await writeFrame(output, message);
  }, stop);
  socket.on('connect', () => { writeFrame(socket, { token }).catch(stop); });
  socket.on('close', stop); output.on('error', stop);
  input.on('end', async () => { await stdin.idle(); stop(); });
  await done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.CUEFLUENT_DRAFT_BRIDGE_TOKEN;
  delete process.env.CUEFLUENT_DRAFT_BRIDGE_TOKEN;
  await runDraftBridge({ endpoint: process.argv[2], token }).catch(() => { process.exitCode = 1; });
}
