// Command identities only: safe to load before runtime/storage dependencies.
export const ENTRY_COMMANDS = Object.freeze({
  hook: 'hook', mcp: 'mcp', setup: 'setup', settings: 'settings', status: 'status',
  syncSteward: 'sync-steward', syncCollect: 'sync-collect', commandWorker: 'command-worker',
});
const operations = new Set(Object.values(ENTRY_COMMANDS));
export const entryOperation = value => operations.has(value) ? value : undefined;
