import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fail } from '../core/errors.mjs';
import { pinDirectory, assertDirectory } from '../storage/paths.mjs';
import { draftProtocol, DRAFT_TOOL_NAMES, readFrames, writeFrame } from './draft-protocol.mjs';

/** A private, ephemeral transport only. The endpoint stores no conversation and
 * authorizes no public writes. The worker retains every actual capability. */
export async function serveDraftTools(workspace, { definitions, version, signal } = {}) {
  const token = randomBytes(32).toString('hex'), secret = Buffer.from(token, 'hex');
  let directory = null, pin = null;
  let endpoint = `\\\\.\\pipe\\cuefluent-drafts-${randomUUID()}`;
  if (process.platform !== 'win32') {
    let base = await fs.realpath(os.tmpdir());
    if (Buffer.byteLength(path.join(base, 'cue-draft-XXXXXX', 'ipc')) > 100) base = await fs.realpath('/tmp');
    directory = await fs.mkdtemp(path.join(base, 'cue-draft-'));
    await fs.chmod(directory, 0o700);
    pin = await pinDirectory(directory, { private: true }); endpoint = path.join(directory, 'ipc');
    if (Buffer.byteLength(endpoint) > 100) fail('DRAFT_ENDPOINT_LIMIT', 'The temporary IPC path is too long.');
  }
  const connections = new Set();
  let closed = false, operations = Promise.resolve();
  // A single global sequence prevents two restarted MCP children from racing a
  // draft edit and finish. Protocol initialization remains connection-local.
  const serialize = callback => {
    const next = operations.then(callback); operations = next.catch(() => {}); return next;
  };
  const server = net.createServer(socket => {
    if (closed || connections.size >= 4) { socket.destroy(); return; }
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    let authenticated = false;
    const protocol = draftProtocol(workspace, definitions, { version });
    readFrames(socket, async message => {
      if (!authenticated) {
        if (!message || typeof message !== 'object' || Object.keys(message).length !== 1 ||
            typeof message.token !== 'string' || !/^[a-f0-9]{64}$/.test(message.token) ||
            !timingSafeEqual(secret, Buffer.from(message.token, 'hex'))) throw new Error('Invalid capability.');
        authenticated = true; await writeFrame(socket, { ready: true }); return;
      }
      const response = await serialize(() => closed ? null : protocol(message));
      if (response && !socket.destroyed) await writeFrame(socket, response);
    }, () => socket.destroy());
  });
  async function close() {
    if (closed) return;
    closed = true; signal?.removeEventListener('abort', onAbort);
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await operations;
    if (directory) { await assertDirectory(pin); await fs.rmdir(directory); }
  }
  const onAbort = () => { close().catch(() => {}); };
  try {
    // Validate the tool surface before listening, even if no client connects.
    draftProtocol(workspace, definitions, { version });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    if (pin) { await assertDirectory(pin); await fs.chmod(endpoint, 0o600); }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) await close();
  } catch (error) { await close().catch(() => {}); throw error; }
  return Object.freeze({ descriptor: Object.freeze({ name: 'cuefluent_drafts', command: process.execPath,
    args: Object.freeze([fileURLToPath(new URL('./draft-bridge.mjs', import.meta.url)), endpoint]),
    env: Object.freeze({ CUEFLUENT_DRAFT_BRIDGE_TOKEN: token }), tools: DRAFT_TOOL_NAMES }), close });
}
