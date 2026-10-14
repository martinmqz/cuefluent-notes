// Canonical publication boundary. Keep development files outside these paths.
export const MARKETPLACE_PLUGINS = [
  { client: 'codex', root: 'plugins/cuefluent-notes', catalog: '.agents/plugins/marketplace.json' },
  { client: 'claude', root: 'claude/cuefluent-notes', catalog: '.claude-plugin/marketplace.json' },
];
export const MARKETPLACE_PATHS = [
  ...MARKETPLACE_PLUGINS.map(plugin => plugin.catalog),
  ...MARKETPLACE_PLUGINS.map(plugin => plugin.root),
  'release.json',
];
export function isMarketplaceFile(name) {
  return MARKETPLACE_PATHS.includes(name) || MARKETPLACE_PLUGINS.some(plugin => name.startsWith(`${plugin.root}/`));
}
export function isMarketplaceSnapshotFile(name) {
  return name === 'README.md' || isMarketplaceFile(name);
}
