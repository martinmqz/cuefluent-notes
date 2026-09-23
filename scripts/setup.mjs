import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { absolute, lstatOrNull, isMain, readBoundedBytes } from './file-io.mjs';
import { PACKAGE_ROOT, SKILL_ROOT } from './runtime-paths.mjs';
import { CLIENTS, configurationPath, hookConfigurationSelection, readConfigSnapshot, configSchema, configHeader, configuredClient, assertCompatibleClients, captureSettings, canonicalSelectedPath, collectionRoot, assertPrivate, assertConfigurationStorage } from './capture-policy.mjs';
import { updateConfiguration } from './config-update.mjs';
import { hookCommand } from './hook-definition.mjs';
import { validatePluginManifest } from './plugin-manifest.mjs';

const fail = message => { throw new Error(message); };
const modes = new Set(['manual', 'suggest', 'automatic']);

async function hookPackaged(client) {
  const manifest = path.join(PACKAGE_ROOT, client === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json');
  const stat = await lstatOrNull(manifest);
  if (!stat) return false;
  if (!stat.isFile()) fail('The plugin manifest must be a regular file.');
  validatePluginManifest(JSON.parse(await readBoundedBytes(manifest)), client);
  const bytes = await readBoundedBytes(path.join(PACKAGE_ROOT, 'hooks/hooks.json'), { missing: true });
  if (bytes === null) return false;
  const hooks = JSON.parse(bytes)?.hooks;
  const command = hookCommand(client);
  const registered = groups => Array.isArray(groups) && groups.length > 0 && groups.every(group =>
    Array.isArray(group?.hooks) && group.hooks.length > 0 && group.hooks.every(handler =>
      handler?.type === 'command' && handler.command === command &&
      (handler.async === undefined || handler.async === false)));
  if (!registered(hooks?.SessionStart) || !hooks.SessionStart.some(group => group.matcher === 'startup') ||
    !registered(hooks?.UserPromptSubmit) || !registered(hooks?.Stop) || hooks.Stop.some(group => group.matcher !== undefined)) {
    fail('The package requires synchronous startup, prompt and Stop hooks invoking the bundled adapter for this client, with only the startup matcher.');
  }
  return true;
}

/** Read policy and route status only. Host enablement/trust cannot be inferred from a bundle. */
export async function setupStatus({ client, cwd, configPath } = {}) {
  if (!CLIENTS.has(client) || !absolute(cwd)) fail('Choose a supported client and supply an explicit absolute project directory (--cwd).');
  const file = configurationPath(configPath);
  const result = { configPath: file, client, ...hookConfigurationSelection(file), hookPackaged: false, hostTrust: 'not_checked' };
  try { result.hookPackaged = await hookPackaged(client); }
  catch { result.hookIssue = 'The plugin package could not be inspected safely. Repair or reinstall the plugin before relying on capture.'; }
  try {
    const { config, hash } = await readConfigSnapshot(file);
    result.configHash = hash;
    if (config === null) return { ...result, status: 'unconfigured' };
    if (!configuredClient(config, client)) return { ...result, status: 'client_not_configured' };
    configHeader(config);
    if (!config.enabled) return { ...result, status: 'disabled', mode: 'manual' };
    const settings = await captureSettings(client, cwd, config);
    if (!settings) return { ...result, status: 'inactive', reason: 'No enabled route applies to this project.' };
    const { skill, safeUpdate, completionHelper, automaticUpdates, ...route } = settings;
    return { ...result, status: 'configured', mode: automaticUpdates ? 'automatic' : 'suggest',
      completionCheck: config.version === 3 && config.completionCheck === true, ...route };
  } catch (error) {
    if (error.code === 'CONFIG_REQUIRES_UPGRADE') return { ...result, status: 'requires_upgrade', reason: error.message };
    if (error.code === 'DERIVED_STATE_CONFLICT') return { ...result, status: 'state_conflict', reason: error.message };
    if (error.code === 'STATE_RECOVERY_REQUIRED') return { ...result, status: 'recovery_required', reason: error.message };
    return { ...result, status: 'invalid', reason: 'Existing configuration or selected paths need repair; nothing was changed.' };
  }
}

/** First-use setup only: publish a complete private config without replacing any existing entry. */
export async function initialize({ client, mode, project, destination, notesDir, scope, stateDir, configPath, confirmCompatibleClients, completionCheck = false } = {}) {
  if (!CLIENTS.has(client) || !modes.has(mode)) fail('Choose a supported client and manual, suggest, or automatic mode.');
  if (typeof completionCheck !== 'boolean' || (mode === 'manual' && completionCheck)) fail('Completion checks require Suggestions or Automatic mode and explicit opt-in.');
  const requested = configurationPath(configPath);
  const selection = hookConfigurationSelection(requested);
  if (await lstatOrNull(requested)) fail('Configuration already exists. Inspect it with status; setup never resets existing settings.');
  const file = await canonicalSelectedPath(requested);
  assertPrivate(file, SKILL_ROOT);
  let config;
  if (mode === 'manual') {
    if ([project, destination, notesDir, scope, stateDir].some(value => value !== undefined)) fail('Manual mode needs no project, notes location, scope, or state directory.');
    config = { version: 1, enabled: false, clients: [client], automaticUpdates: false,
      scope: 'Manual use only; no automatic capture.' };
  } else {
    if (!absolute(project) || (destination !== undefined) === (notesDir !== undefined) ||
      !absolute(notesDir ?? destination)) fail('Choose an absolute project and exactly one Markdown file (--destination) or notes folder (--notes-dir).');
    const projectRoot = await fs.realpath(project);
    if (!(await fs.stat(projectRoot)).isDirectory()) fail('The selected project must be an existing directory.');
    const notesRoot = await collectionRoot({ notesDir, destination });
    const storage = notesDir !== undefined ? { notesDir: notesRoot }
      : { destination: path.join(notesRoot, path.basename(destination)) };
    const collection = createHash('sha256').update(notesRoot).digest('hex');
    const selectedState = stateDir ?? path.join(path.dirname(file), 'state', collection);
    config = { ...(completionCheck ? { version: 3, minimumPluginVersion: '0.6.0', completionCheck: true }
      : notesDir !== undefined ? { version: 2, minimumPluginVersion: '0.5.1' } : { version: 1 }),
      enabled: true, clients: [client], automaticUpdates: mode === 'automatic', scope,
      routes: [{ projectRoot, ...storage, stateDir: selectedState }] };
    configSchema(config);
    const settings = await captureSettings(client, projectRoot, config);
    assertConfigurationStorage(settings, file);
    config.routes[0].stateDir = settings.stateDir;
  }
  configSchema(config);
  assertCompatibleClients(config, undefined, confirmCompatibleClients);
  const parent = path.dirname(file);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent || await canonicalSelectedPath(requested) !== file) {
    fail('The configuration location changed; inspect it before trying again.');
  }
  const stage = path.join(parent, `.cuefluent-setup-${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await fs.open(stage, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Same-directory hard link publishes complete bytes atomically and refuses
    // concurrent creates, existing files, and dangling symlinks alike.
    try { await fs.link(stage, file); }
    catch (error) {
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) {
        fail('Configuration could not be published safely: this location must allow same-directory hard links. Check filesystem support and permissions. No configuration was published.');
      }
      throw error;
    }
  } catch (error) {
    if (error.code === 'EEXIST') fail('Configuration appeared during setup; it was preserved. Inspect it with status.');
    throw error;
  } finally {
    if (handle) await handle.close();
    if (created) await fs.unlink(stage).catch(() => {});
  }
  return { status: 'created', configPath: file, mode, client, ...selection };
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/setup.mjs status --client codex|claude --cwd /project [--config /private/config.json]\n       node scripts/setup.mjs init --client codex|claude --mode manual|suggest|automatic [--project /project (--notes-dir /notes | --destination /notes/topic.md) --scope "selected facts" --state-dir /private/state] [--config /private/config.json]\n       node scripts/setup.mjs update --client codex|claude --cwd /project --proposal /private/proposed-config.json --expected-hash SHA256 [--config /private/config.json]\nOptional --completion-check yes enables a private completion marker and one bounded Stop recovery in Suggestions/Automatic mode; requires schema 3 and every installed reader at 0.6.0+. First schema 3 publication also requires --confirm-compatible-clients yes.\nFolder init and version 1-to-2 updates require --confirm-compatible-clients yes after checking every installed reader, including unlisted clients, supports Cuefluent Notes 0.5.1+.\nFirst-use setup never overwrites configuration. Updates require inspected bytes and a validated proposal. Neither writes notes or trusts host hooks.\nA --config override applies only to this command. Packaged hooks use CUEFLUENT_NOTES_CONFIG from the host launch environment, or the default path.');
    return 0;
  }
  const [command, ...options] = args;
  const allowed = command === 'status' ? ['client', 'cwd', 'config'] : command === 'init'
    ? ['client', 'mode', 'project', 'destination', 'notes-dir', 'scope', 'state-dir', 'config', 'confirm-compatible-clients', 'completion-check'] : command === 'update'
    ? ['client', 'cwd', 'proposal', 'expected-hash', 'config', 'confirm-compatible-clients'] : [];
  if (!allowed.length || options.length % 2) fail('Use status, init, or update with named options; see --help.');
  const parsed = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i].slice(2);
    if (!options[i].startsWith('--') || !allowed.includes(key) || Object.hasOwn(parsed, key) || !options[i + 1]) fail('Unknown, repeated, or incomplete setup option.');
    parsed[key] = options[i + 1];
  }
  if (parsed['confirm-compatible-clients'] !== undefined && parsed['confirm-compatible-clients'] !== 'yes') fail('--confirm-compatible-clients accepts only yes after checking installed plugins.');
  if (parsed['completion-check'] !== undefined && parsed['completion-check'] !== 'yes') fail('--completion-check accepts only yes after the user enables completion checks.');
  const settings = { ...parsed, configPath: parsed.config, notesDir: parsed['notes-dir'], stateDir: parsed['state-dir'], expectedHash: parsed['expected-hash'], confirmCompatibleClients: parsed['confirm-compatible-clients'] === 'yes', completionCheck: parsed['completion-check'] === 'yes' };
  const result = await (command === 'status' ? setupStatus(settings) : command === 'init' ? initialize(settings) : updateConfiguration(settings));
  console.log(JSON.stringify(result, null, 2));
  return ['invalid', 'state_conflict', 'recovery_required', 'requires_upgrade'].includes(result.status) ? 2 : 0;
}

if (await isMain(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`Setup failed: ${String(error.message).slice(0, 400)}`); process.exitCode = 2; }
}
