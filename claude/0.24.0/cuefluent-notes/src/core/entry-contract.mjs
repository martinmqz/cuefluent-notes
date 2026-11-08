// Command identities and the argument shapes that the entry point and the
// runtime both check: safe to load before runtime/storage dependencies.
export const ENTRY_COMMANDS = Object.freeze({
  hook: 'hook', mcp: 'mcp', setup: 'setup', settings: 'settings', status: 'status', check: 'check', previewRepair: 'preview-repair',
  syncSteward: 'sync-steward', syncCollect: 'sync-collect', commandWorker: 'command-worker',
});
const operations = new Set(Object.values(ENTRY_COMMANDS));
export const entryOperation = value => operations.has(value) ? value : undefined;
/** A note check's page cursor: the checked notes' identity and the position of
 * the next reported note. A first page takes no cursor. */
export const CHECK_CURSOR_PATTERN = '^[a-f0-9]{64}:[1-9][0-9]{0,3}$';
/** A repair preview's page cursor: the proposal it continues, the position of
 * the next note and the byte offset into that note's change list. */
export const REPAIR_CURSOR_PATTERN = '^[a-f0-9]{64}:(?:0|[1-9][0-9]{0,2}):(?:0|[1-9][0-9]{0,7})$';
