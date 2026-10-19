import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// The bounded metadata walk that starts every private-storage verification
// attempt; its lstat of a directory happens exactly once per attempt. Callers
// assert the counts, so a renamed walk fails them rather than passing vacuously.
const inWalk = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  try { return new Error().stack.includes('privateStorageEntries'); }
  finally { Error.stackTraceLimit = limit; }
};

/** Hooks each verification attempt that inspects `directory`, counted from 1:
 * `before(n)` runs before the walk reads its metadata; `after(n)` runs once the
 * walk pinned it, so a change made there is seen by that same attempt. */
export function onVerificationAttempt(t, directory, { before = () => {}, after = () => {} } = {}) {
  const lstat = fs.lstat;
  let attempts = 0;
  t.mock.method(fs, 'lstat', async function (file, ...args) {
    if (file !== directory || !inWalk()) return lstat.call(this, file, ...args);
    const n = ++attempts;
    await before(n);
    const stat = await lstat.call(this, file, ...args);
    await after(n);
    return stat;
  });
  return { get attempts() { return attempts; } };
}

/** A deterministic stand-in for a concurrent writer: a child of `directory` is
 * created and removed. A create/remove pair need not change a directory's
 * timestamps on every filesystem, so its version also moves forward explicitly
 * (never backwards: that can move birthtime on APFS). */
export function directoryChurn(directory) {
  let time = Date.now() + 60_000;
  return async () => {
    const child = path.join(directory, `.churn-${randomUUID()}`);
    await fs.mkdir(child, { mode: 0o700 }); await fs.rmdir(child);
    const changed = new Date(time += 1000);
    await fs.utimes(directory, changed, changed);
  };
}

/** Churns `directory` on verification attempts `from` .. `from + attempts - 1`. */
export function storageChurn(t, directory, { from = 1, attempts = Infinity } = {}) {
  const churn = directoryChurn(directory);
  let churned = 0;
  const seen = onVerificationAttempt(t, directory, { after: async n => {
    if (n >= from && n < from + attempts) { churned++; await churn(); }
  } });
  return { get attempts() { return seen.attempts; }, get churned() { return churned; } };
}
