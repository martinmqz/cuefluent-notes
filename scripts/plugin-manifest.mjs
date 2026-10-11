import { object, CLIENTS } from './workflow-values.mjs';

const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(text);
const fields = (value, names) => object(value) && Object.keys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name));

/** Validate the manifest subset emitted by this package, not the full host schema. */
export function validatePluginManifest(manifest, client) {
  // Older published packages legitimately lack the controller. Validate their
  // inventories without making them claim the new capability.
  const hasMcp = object(manifest) && Object.hasOwn(manifest, 'mcpServers');
  const common = ['name', 'version', 'description', 'author', ...(hasMcp ? ['mcpServers'] : [])];
  const validCommon = CLIENTS.includes(client) && fields(manifest, client === 'codex' ? [...common, 'skills', 'interface'] : common) &&
    manifest.name === 'cuefluent-notes' && text(manifest.version) && manifest.version === manifest.version.trim() && semver.test(manifest.version) &&
    text(manifest.description) && fields(manifest.author, ['name']) && text(manifest.author.name) &&
    (!hasMcp || manifest.mcpServers === './.mcp.json');
  let validInterface = true;
  if (validCommon && client === 'codex') {
    const labels = ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category'];
    const metadata = manifest.interface;
    validInterface = manifest.skills === './skills/' && fields(metadata, [...labels, 'capabilities', 'defaultPrompt']) &&
      labels.every(name => text(metadata[name])) && strings(metadata.capabilities) && strings(metadata.defaultPrompt);
  }
  if (!validCommon || !validInterface) throw new Error('Invalid Cuefluent Notes plugin manifest metadata.');
}

/** Only the bundled processing controller is an intended package capability. */
export function validateProcessingMcp(manifest, client) {
  const server = manifest?.mcpServers?.cuefluent_control;
  const expectedArgs = client === 'codex'
    ? ['./skills/cuefluent-notes/scripts/processing-mcp.mjs', '--client', 'codex']
    : ['${CLAUDE_PLUGIN_ROOT}/skills/cuefluent-notes/scripts/processing-mcp.mjs', '--client', 'claude'];
  if (!CLIENTS.includes(client) || !fields(manifest, ['mcpServers']) ||
      !fields(manifest.mcpServers, ['cuefluent_control']) ||
      !fields(server, client === 'codex' ? ['command', 'args', 'cwd'] : ['command', 'args']) ||
      server.command !== 'node' || JSON.stringify(server.args) !== JSON.stringify(expectedArgs) ||
      (client === 'codex' && server.cwd !== '.')) throw new Error('Invalid Cuefluent Notes processing MCP configuration.');
}

/** Fields deliberately shared by the two source templates, not every interface label. */
export function validateManifestPair(codex, claude) {
  validatePluginManifest(codex, 'codex');
  validatePluginManifest(claude, 'claude');
  if (['name', 'version', 'description', 'mcpServers'].some(key => codex[key] !== claude[key]) ||
      codex.author.name !== claude.author.name || codex.interface.shortDescription !== codex.description ||
      codex.interface.developerName !== codex.author.name) throw new Error('Shared plugin manifest metadata differs.');
}
