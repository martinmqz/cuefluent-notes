import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { readBoundedBytes, lstatOrNull, sameFileIdentity } from './file-io.mjs';
import { fail, object, string } from './workflow-values.mjs';

const MAX_BYTES = 256 * 1024, MAX_NODES = 8192, MAX_DEPTH = 32;
// Only native provider, credential, deployment and connection configuration.
// Never restore PATH, NODE_OPTIONS, engine authority, hooks or plugin controls
// from a settings file. Credential values travel solely in process environment.
const ENVIRONMENT = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_AUTHORITY_HOST',
  'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_FEDERATED_TOKEN_FILE',
  'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_REGION_PREFIX',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_SKIP_MANTLE_AUTH', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME', 'AWS_WEB_IDENTITY_TOKEN_FILE',
  'CLAUDE_CODE_SKIP_AWS_CRED_CACHE', 'CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS',
  'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS'
]);
const permitted = name => ENVIRONMENT.has(name) || /^VERTEX_REGION_CLAUDE_[A-Z0-9_]{1,64}$/.test(name);
const enabled = input => ['1', 'true', 'yes', 'on'].includes(input.toLowerCase().trim());
const environmentKey = (env, name, platform) => platform === 'win32'
  ? Object.keys(env).sort().find(key => key.toUpperCase() === name) : Object.hasOwn(env, name) ? name : undefined;
const value = input => {
  try { return string(input, 32768, { empty: true }); }
  catch { fail('PROCESSING_CLIENT_SETTINGS_INVALID'); }
};

function boundedStructure(settings) {
  const queue = [[settings, 0]];
  for (let at = 0; at < queue.length; at++) {
    const [node, depth] = queue[at];
    if (depth > MAX_DEPTH || queue.length > MAX_NODES) fail('PROCESSING_CLIENT_SETTINGS_LIMIT');
    if (node !== null && typeof node === 'object') {
      for (const child of Object.values(node)) {
        if (queue.length === MAX_NODES) fail('PROCESSING_CLIENT_SETTINGS_LIMIT');
        queue.push([child, depth + 1]);
      }
    }
  }
}

export function validateClaudeRestrictedSettings(settings) {
  if (!object(settings) || settings.disableAllHooks !== true ||
      Object.keys(settings).some(key => !['disableAllHooks', 'model', 'modelOverrides', 'availableModels'].includes(key))) {
    fail('PROCESSING_CLIENT_SETTINGS_INVALID');
  }
  const result = { disableAllHooks: true };
  if (settings.model !== undefined) {
    result.model = value(settings.model);
    if (!result.model.trim()) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
  }
  if (settings.modelOverrides !== undefined) {
    if (!object(settings.modelOverrides) || Object.keys(settings.modelOverrides).length > 128) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
    const pairs = Object.entries(settings.modelOverrides).map(([key, entry]) => [value(key), value(entry)]);
    if (pairs.some(([key, entry]) => !key.trim() || !entry.trim())) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
    result.modelOverrides = Object.fromEntries(pairs);
  }
  if (settings.availableModels !== undefined) {
    if (!Array.isArray(settings.availableModels) || settings.availableModels.length > 128) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
    result.availableModels = settings.availableModels.map(entry => value(entry));
    if (result.availableModels.some(entry => !entry.trim())) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) fail('PROCESSING_CLIENT_SETTINGS_LIMIT');
  return result;
}

/** Read the selected native user profile only. No project discovery, configured
 * helper execution, credential-store reads, provider choice or authentication writes.
 * Resolve afresh for each eligible dispatch; status/review never call this.
 */
export async function resolveClaudeLaunchSettings(env = process.env, { platform = process.platform, expectedProfile, preferHostEnvironment = false } = {}) {
  if (typeof preferHostEnvironment !== 'boolean') fail('PROCESSING_CLIENT_SETTINGS_INVALID');
  let file, bytes, profile;
  try {
    const requested = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    string(requested, 4096);
    if (!path.isAbsolute(requested)) fail('PROCESSING_CLIENT_SETTINGS_UNAVAILABLE');
    profile = await fs.realpath(requested);
    if (expectedProfile !== undefined && profile !== expectedProfile) fail('PROCESSING_CLIENT_SETTINGS_UNAVAILABLE');
    const profileBefore = await fs.lstat(profile, { bigint: true });
    if (!profileBefore.isDirectory() || profileBefore.isSymbolicLink()) fail('PROCESSING_CLIENT_SETTINGS_UNAVAILABLE');
    const entry = path.join(profile, 'settings.json');
    const entryBefore = await lstatOrNull(entry, { bigint: true });
    if (!entryBefore) {
      if (await fs.realpath(requested) !== profile || !sameFileIdentity(profileBefore, await fs.lstat(profile, { bigint: true })) ||
          await lstatOrNull(entry)) fail('PROCESSING_CLIENT_SETTINGS_UNAVAILABLE');
      return { env: { ...env }, settings: { disableAllHooks: true } };
    }
    // User-selected settings links are ordinary native configuration, not an
    // evidence-storage capability. Read only their exact canonical regular file.
    file = await fs.realpath(entry);
    const before = await fs.lstat(file, { bigint: true });
    bytes = await readBoundedBytes(file, { maxBytes: MAX_BYTES, noFollow: true, utf8: false });
    if (await fs.realpath(entry) !== file || await fs.realpath(requested) !== profile) fail('PROCESSING_CLIENT_SETTINGS_UNAVAILABLE');
    const after = await fs.lstat(file, { bigint: true });
    if (!sameFileIdentity(before, after) || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size ||
        !sameFileIdentity(entryBefore, await fs.lstat(entry, { bigint: true })) ||
        !sameFileIdentity(profileBefore, await fs.lstat(profile, { bigint: true }))) fail('PROCESSING_CLIENT_SETTINGS_UNAVAILABLE');
  } catch (error) {
    if (error.code === 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE') throw error;
    if (error.code === 'FILE_SIZE_LIMIT_EXCEEDED') fail('PROCESSING_CLIENT_SETTINGS_LIMIT');
    fail('PROCESSING_CLIENT_SETTINGS_UNAVAILABLE');
  }
  let source, text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); source = JSON.parse(text); }
  catch { fail('PROCESSING_CLIENT_SETTINGS_INVALID'); }
  if (!object(source)) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
  boundedStructure(source);
  // Native settings are JSON. The second bounded parse checks duplicate keys;
  // none of its diagnostics or parsed values are exposed or executed.
  if (parseDocument(text, { schema: 'json', uniqueKeys: true, strict: true }).errors.length) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
  for (const helper of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh']) {
    if (source[helper] !== undefined && source[helper] !== null && source[helper] !== '') fail('PROCESSING_CLIENT_SETTINGS_UNSUPPORTED');
  }
  // Preserve the native locator exactly: its presence and spelling affect
  // global configuration and credential-store names, even for the same folder.
  const selected = { ...env };
  if (source.env !== undefined) {
    if (!object(source.env) || Object.keys(source.env).length > 256) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
    const seen = new Set();
    for (const [name, entry] of Object.entries(source.env)) {
      const checked = value(entry);
      const canonical = platform === 'win32' ? name.toUpperCase() : name;
      if (permitted(canonical) && seen.has(canonical)) fail('PROCESSING_CLIENT_SETTINGS_INVALID');
      seen.add(canonical);
      if (/^CLAUDE_CODE_USE_/.test(canonical) && !permitted(canonical) && enabled(checked)) {
        fail('PROCESSING_CLIENT_SETTINGS_UNSUPPORTED');
      }
      if (permitted(canonical)) {
        // Verified native handoff keeps the source host's effective project
        // environment. Bare CLI launches use native user-over-shell precedence.
        if (preferHostEnvironment && environmentKey(env, canonical, platform) !== undefined) continue;
        if (platform === 'win32') for (const old of Object.keys(selected)) if (old.toUpperCase() === canonical) delete selected[old];
        selected[canonical] = checked;
      }
    }
  }
  // Keep a profile model as a settings preference, not an environment override
  // that would outrank managed policy. Native precedence resolves the result.
  // A user-level effortLevel has legacy model-specific semantics that differ
  // from launch-level settings. Do not promote it or restore structured effort
  // preferences; explicit CLAUDE_CODE_EFFORT_LEVEL remains native environment.
  const settings = validateClaudeRestrictedSettings({ disableAllHooks: true,
    ...(source.model !== undefined ? { model: source.model } : {}),
    ...(source.modelOverrides !== undefined ? { modelOverrides: source.modelOverrides } : {}),
    ...(source.availableModels !== undefined ? { availableModels: source.availableModels } : {}) });
  return { env: selected, settings };
}
