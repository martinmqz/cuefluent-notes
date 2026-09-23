import { CLIENTS, object } from './capture-policy.mjs';

const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(text);
const fields = (value, names) => object(value) && Object.keys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name));

/** Validate the manifest subset emitted by this package, not the full host schema. */
export function validatePluginManifest(manifest, client) {
  const common = ['name', 'version', 'description', 'author'];
  const validCommon = CLIENTS.has(client) && fields(manifest, client === 'codex' ? [...common, 'skills', 'interface'] : common) &&
    manifest.name === 'cuefluent-notes' && text(manifest.version) && manifest.version === manifest.version.trim() && semver.test(manifest.version) &&
    text(manifest.description) && fields(manifest.author, ['name']) && text(manifest.author.name);
  let validInterface = true;
  if (validCommon && client === 'codex') {
    const labels = ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category'];
    const metadata = manifest.interface;
    validInterface = manifest.skills === './skills/' && fields(metadata, [...labels, 'capabilities', 'defaultPrompt']) &&
      labels.every(name => text(metadata[name])) && strings(metadata.capabilities) && strings(metadata.defaultPrompt);
  }
  if (!validCommon || !validInterface) throw new Error('Invalid Cuefluent Notes plugin manifest metadata.');
}
