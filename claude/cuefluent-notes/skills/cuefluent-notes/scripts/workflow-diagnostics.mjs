import path from 'node:path';
import { readBoundedBytes } from './file-io.mjs';
import { PACKAGE_ROOT } from './runtime-paths.mjs';
import { collectionHookConfiguration } from './collection-hook-definition.mjs';
import { validatePluginManifest } from './plugin-manifest.mjs';
import { canonicalJSON } from './workflow-values.mjs';

/** Package inspection is not proof of client loading, hook trust or launch PATH.
 * No client profiles, credentials, transcripts or mutable workflow state are read. */
export async function workflowDiagnostics(root = PACKAGE_ROOT) {
  let hookRegistration = 'absent', manifest = 'absent', client = null;
  const read = async name => {
    const bytes = await readBoundedBytes(path.join(root, name), { maxBytes: 64 * 1024, missing: true, noFollow: true, utf8: false });
    return bytes === null ? null : { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  };
  try {
    for (const selected of ['codex', 'claude']) {
      const value = await read(`.${selected}-plugin/plugin.json`);
      if (value !== null) {
        validatePluginManifest(value.value, selected);
        if (client) throw new Error('Ambiguous package');
        client = selected; manifest = 'valid';
      }
    }
  } catch { manifest = 'invalid'; client = null; }
  try {
    const actual = await read('hooks/hooks.json');
    if (actual !== null) hookRegistration = manifest === 'valid' &&
      canonicalJSON(actual.value) === canonicalJSON(collectionHookConfiguration(client)) ? 'packaged' : 'invalid';
  } catch { hookRegistration = 'invalid'; }
  return { nodeVersion: process.versions.node, manifest, hookRegistration, client,
    hostTrust: 'unknown', hostHookSettings: 'unknown', hostNodePath: 'unknown' };
}
