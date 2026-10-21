import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validatePluginManifest, validateManifestPair, validateProcessingMcp } from './plugin-manifest.mjs';

const fixtures = Object.fromEntries(await Promise.all(['codex', 'claude'].map(async client => [client, {
  plugin: JSON.parse(await fs.readFile(new URL(`../packaging/${client}/plugin.json`, import.meta.url))),
  mcp: JSON.parse(await fs.readFile(new URL(`../packaging/${client}/mcp.json`, import.meta.url))),
}])));

test('source manifests bind both clients to their explicit bundled controller', () => {
  validateManifestPair(fixtures.codex.plugin, fixtures.claude.plugin);
  for (const [client, value] of Object.entries(fixtures)) {
    assert.equal(value.plugin.mcpServers, './.mcp.json');
    validateProcessingMcp(value.mcp, client);
    assert.throws(() => validateProcessingMcp(value.mcp, client === 'codex' ? 'claude' : 'codex'));
    for (const mcpServers of ['/outside/mcp.json', '../mcp.json', {}, ['./.mcp.json']]) {
      assert.throws(() => validatePluginManifest({ ...value.plugin, mcpServers }, client));
    }
  }
});

test('MCP templates cannot introduce arbitrary commands, servers, environment or client arguments', () => {
  for (const [client, { mcp }] of Object.entries(fixtures)) {
    for (const mutate of [
      value => { value.mcpServers.extra = value.mcpServers.cuefluent_control; },
      value => { value.mcpServers.cuefluent_control.command = 'sh'; },
      value => { value.mcpServers.cuefluent_control.args.push('--config', '/private/settings.json'); },
      value => { value.mcpServers.cuefluent_control.args[0] = '/absolute/processing-mcp.mjs'; },
      value => { value.mcpServers.cuefluent_control.env = { HOME: '/different/profile' }; },
      value => { value.mcpServers.cuefluent_control.cwd = '..'; },
    ]) {
      const altered = structuredClone(mcp); mutate(altered);
      assert.throws(() => validateProcessingMcp(altered, client), /MCP configuration/);
    }
  }
  const codex = structuredClone(fixtures.codex.mcp); delete codex.mcpServers.cuefluent_control.cwd;
  assert.throws(() => validateProcessingMcp(codex, 'codex'), /MCP configuration/);
});

test('license metadata is validated and both current manifest fields are required', () => {
  for (const [client, { plugin }] of Object.entries(fixtures)) {
    assert.equal(plugin.license, 'SUL-1.0');
    for (const license of [null, {}, [], '', '   ', ' MIT ']) {
      assert.throws(() => validatePluginManifest({ ...plugin, license }, client), /manifest metadata/);
    }
  }
  for (const missing of [['mcpServers'], ['license'], ['mcpServers', 'license']]) {
    const altered = Object.fromEntries(Object.entries(fixtures).map(([client, { plugin }]) => {
      const manifest = { ...plugin };
      for (const field of missing) delete manifest[field];
      assert.throws(() => validatePluginManifest(manifest, client), /manifest metadata/);
      return [client, manifest];
    }));
    assert.throws(() => validateManifestPair(altered.codex, altered.claude), /manifest metadata/);
    assert.throws(() => validateManifestPair(fixtures.codex.plugin, altered.claude), /manifest metadata/);
  }
  assert.throws(() => validateManifestPair(fixtures.codex.plugin, { ...fixtures.claude.plugin, license: 'MIT' }), /metadata differs/);
});
