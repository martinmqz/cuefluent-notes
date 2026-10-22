import { fail } from '../core/errors.mjs';
import { createCodexNativeAdapter } from '../client/codex-native.mjs';
import { collectChat } from './collect.mjs';
import { createSyncLaunchGuard, ensureSyncSteward, launchDetachedSyncSteward, launchSyncAttempt, runSyncSteward } from './ingress.mjs';

/** Installed client identities and native providers are trusted host capabilities,
 * never model arguments or source text. Constructing this runtime opens nothing.
 * Collection creates a native reader only in its independent worker process.
 */
export function createSyncRuntime({ store, entry, clients = {}, signal,
  createCodexAdapter = createCodexNativeAdapter, launchSteward = launchDetachedSyncSteward,
  launchAttempt = launchSyncAttempt } = {}) {
  if (typeof createCodexAdapter !== 'function' || typeof launchSteward !== 'function' || typeof launchAttempt !== 'function') fail('SYNC_RUNTIME_INVALID', 'Sync workers require trusted native and Node launch capabilities.');
  let closed = false;
  const contracts = new Map();
  for (const client of ['claude', 'codex']) {
    const value = clients[client];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.resolveNativeSource !== undefined && typeof value.resolveNativeSource !== 'function') fail('SYNC_RUNTIME_INVALID', 'An installed client contract is invalid.');
    if (value.nativeAdapter !== undefined && (typeof value.nativeAdapter?.resolveNativeSource !== 'function' || typeof value.nativeAdapter?.close !== 'function')) fail('SYNC_RUNTIME_INVALID', 'A native provider requires source verification and close capabilities.');
    contracts.set(client, Object.freeze({ resolveNativeSource: value.resolveNativeSource ?? null, nativeAdapter: value.nativeAdapter ?? null }));
  }
  function available() { if (closed) fail('SYNC_RUNTIME_CLOSED', 'The synchronization runtime is closed.'); }
  return Object.freeze({
    async collect({ client, sessionId, limits } = {}) {
      available();
      if (!['claude', 'codex'].includes(client)) fail('SYNC_RUNTIME_INVALID', 'Unsupported collection client.');
      if (!store) return { status: 'unconfigured', parts: 0 };
      const contract = contracts.get(client) ?? { resolveNativeSource: null, nativeAdapter: null };
      let adapter = contract.nativeAdapter, owned = false;
      try {
        const resolveNativeSource = contract.resolveNativeSource ?? (client === 'codex' || adapter ? async input => {
          if (!adapter) { adapter = createCodexAdapter(); owned = true; }
          return adapter.resolveNativeSource(input);
        } : null);
        return await collectChat(store, { client, sessionId, limits,
          resolveNativeSource });
      } finally { if (owned) await adapter?.close(); }
    },
    async schedule() {
      available();
      return ensureSyncSteward(store, { launch: input => launchSteward({ entry, ...input }) });
    },
    async steward(options = {}) {
      available();
      return runSyncSteward(store, { launchAvailable: createSyncLaunchGuard(entry), ...options, signal,
        attempt: input => launchAttempt({ entry, ...input }) });
    },
    async close() { closed = true; },
  });
}
