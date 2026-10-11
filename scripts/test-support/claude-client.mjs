import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

export const CLAUDE_TEST_TOOLS = Object.freeze(['mcp__cuefluent_engine__inspect', 'mcp__cuefluent_engine__propose']);

export function initialization(sessionId, patch = {}) {
  return { type: 'system', subtype: 'init', session_id: sessionId,
    tools: [...CLAUDE_TEST_TOOLS],
    mcp_servers: [{ name: 'cuefluent_engine', status: 'connected' }],
    permissionMode: 'dontAsk', slash_commands: [], skills: [], model: 'synthetic-model', claude_code_version: 'fixture', ...patch };
}

export function completed(sessionId, patch = {}) {
  return { type: 'result', session_id: sessionId, subtype: 'success', is_error: false,
    permission_denials: [], result: 'Synthetic status.', ...patch };
}

export function success({ child, args, input }) {
  child.send(initialization(input.session_id, { tools: args[args.indexOf('--allowedTools') + 1].split(',') }));
  child.send({ ...input, isReplay: true });
  child.send(completed(input.session_id)); child.emit('close', 0, null);
}

export function claudeHarness(run = success) {
  const calls = [], children = [];
  const spawn = (executable, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const chunks = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('close', null, signal)); return true; };
    child.send = row => child.stdout.write(`${JSON.stringify(row)}\n`);
    child.stdin.on('finish', () => run({ child, input: JSON.parse(Buffer.concat(chunks).toString('utf8')), args, options }));
    calls.push({ executable, args, options }); children.push(child);
    queueMicrotask(() => child.emit('spawn')); return child;
  };
  return { calls, children, spawn };
}
