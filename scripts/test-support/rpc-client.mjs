import { PassThrough, Writable } from 'node:stream';

// Always await close before releasing a server's filesystem/environment fixtures.
// A failed or exited server rejects outstanding requests with its actual cause.
export function rpcClient(start, { timeoutMs = 30_000 } = {}) {
  const input = new PassThrough(), waiters = new Map();
  let buffer = '', ended = false, failure = null;
  const output = new Writable({ write(chunk, _encoding, done) {
    try {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const row = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        waiters.get(row.id)?.resolve(row);
      }
      done();
    } catch (error) { done(error); }
  } });
  const complete = error => {
    ended = true; failure = error;
    for (const waiter of waiters.values()) waiter.reject(error ?? new Error('RPC server exited before responding'));
  };
  const server = Promise.resolve().then(() => start({ input, output })).then(() => complete(null), complete);
  return {
    send(row) {
      if (ended) return Promise.reject(failure ?? new Error('RPC server already exited'));
      if (waiters.has(row.id)) return Promise.reject(new Error('Duplicate test request ID'));
      return new Promise((resolve, reject) => {
        const finish = (fn, value) => { clearTimeout(timer); waiters.delete(row.id); fn(value); };
        const timer = setTimeout(() => finish(reject, new Error(`RPC response timed out: ${row.method}`)), timeoutMs);
        waiters.set(row.id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
        input.write(`${JSON.stringify(row)}\n`);
      });
    },
    async close() {
      input.end(); await server;
      if (failure) throw failure;
    }
  };
}
