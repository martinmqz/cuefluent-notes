import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { absolute, within, lstatOrNull as lstat, readBoundedBytes, CONTROLS } from './file-io.mjs';
import { PACKAGE_ROOT, SKILL_ROOT } from './runtime-paths.mjs';
import pkg from '../package.json' with { type: 'json' };

export const CLIENTS = new Set(['codex', 'claude']);
// The schema's required minimum is separate from this reader's capabilities.
const READER_VERSION = pkg.version.split(/[.+-]/).slice(0, 3).map(Number);
export const completionEnabled = config => config?.version === 3 && config.completionCheck === true;
export const completionPermissionMode = (client, mode) =>
  ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions', ...(client === 'claude' ? ['auto'] : [])].includes(mode);
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ROUTES = 100;
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !CONTROLS.test(value);
const invalid = () => { throw new Error('Invalid capture configuration.'); };
const onlyKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const requiresUpgrade = () => {
  throw Object.assign(new Error('This configuration requires a newer Cuefluent Notes plugin. Upgrade this client before using or changing capture settings.'), { code: 'CONFIG_REQUIRES_UPGRADE' });
};

function routeSchema(route, project = false, version = 1) {
  const keys = project ? ['projectRoot', 'destination', 'notesDir', 'stateDir', 'automaticUpdates', 'scope', 'enabled'] : ['destination', 'notesDir', 'stateDir'];
  if (!onlyKeys(route, keys) || !absolute(route.stateDir) ||
    Object.hasOwn(route, 'destination') === Object.hasOwn(route, 'notesDir')) invalid();
  if (version === 1 && Object.hasOwn(route, 'notesDir')) invalid();
  if (Object.hasOwn(route, 'notesDir') ? !absolute(route.notesDir) :
    !absolute(route.destination) || !/\.(?:md|markdown)$/i.test(route.destination)) invalid();
  if (project && (!absolute(route.projectRoot) ||
    (route.automaticUpdates !== undefined && typeof route.automaticUpdates !== 'boolean') ||
    (route.enabled !== undefined && typeof route.enabled !== 'boolean') ||
    (route.scope !== undefined && !text(route.scope, 2000)))) invalid();
}

/** Read membership before interpreting version-specific fields for another client. */
export function configuredClient(config, client) {
  if (!object(config) || !Array.isArray(config.clients) || config.clients.length > MAX_ROUTES ||
    config.clients.some(value => !text(value, 64)) || new Set(config.clients).size !== config.clients.length) invalid();
  return config.clients.includes(client);
}

/** Common routing envelope; route contents are checked only after selection on reads. */
export function configHeader(config) {
  if (!object(config) || !Number.isSafeInteger(config.version) || config.version < 1) invalid();
  if (config.version > 3) requiresUpgrade();
  const minimum = config.version === 3 ? '0.6.0' : '0.5.1';
  if (config.version >= 2 && config.minimumPluginVersion !== minimum) {
    if (typeof config.minimumPluginVersion === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(config.minimumPluginVersion)) {
      const requested = config.minimumPluginVersion.split('.').map(Number);
      const difference = requested.findIndex((part, index) => part !== READER_VERSION[index]);
      if (difference !== -1 && requested[difference] > READER_VERSION[difference]) requiresUpgrade();
    }
    invalid();
  }
  const keys = ['version', 'enabled', 'clients', 'automaticUpdates', 'scope', 'defaultRoute', 'routes', 'exclude'];
  if (config.version >= 2) keys.push('minimumPluginVersion');
  if (config.version === 3) keys.push('completionCheck');
  if (!onlyKeys(config, keys) ||
    (config.version === 3 && typeof config.completionCheck !== 'boolean') ||
    typeof config.enabled !== 'boolean' || typeof config.automaticUpdates !== 'boolean' ||
    !text(config.scope, 2000) || !Array.isArray(config.clients) || config.clients.length > CLIENTS.size ||
    config.clients.some(client => !CLIENTS.has(client)) || new Set(config.clients).size !== config.clients.length) invalid();
  if (config.routes !== undefined) {
    if (!Array.isArray(config.routes) || config.routes.length > MAX_ROUTES) invalid();
    // Every project selector affects routing, including disabled/excluded routes.
    for (const route of config.routes) {
      if (!object(route) || !absolute(route.projectRoot) ||
        (route.enabled !== undefined && typeof route.enabled !== 'boolean')) invalid();
    }
  }
  if (config.exclude !== undefined && (!Array.isArray(config.exclude) || config.exclude.length > MAX_ROUTES || config.exclude.some(item => !absolute(item)))) invalid();
}

/** Writes validate the complete policy, including currently inactive routes. */
export function configSchema(config) {
  configHeader(config);
  if (config.defaultRoute !== undefined) routeSchema(config.defaultRoute, false, config.version);
  for (const route of config.routes ?? []) routeSchema(route, true, config.version);
}

/** Older installed readers cannot learn the new schema retroactively. */
export function assertCompatibleClients(config, previous, confirmed) {
  if (config.version === 3 && previous?.version !== 3 && confirmed !== true) {
    throw Object.assign(new Error('Completion checks require Cuefluent Notes 0.6.0+ in every installed client reading this policy, including clients absent from its clients list. Inspect installations before passing --confirm-compatible-clients yes. Otherwise retain the existing schema without completion checks.'), { code: 'CLIENT_UPGRADE_REQUIRED' });
  }
  if (config.version === 2 && previous?.version !== 2 && confirmed !== true) {
    throw Object.assign(new Error('Folder policies require Cuefluent Notes 0.5.1+ in every installed client reading this policy, including clients absent from its clients list. Inspect Codex and Claude installations before passing --confirm-compatible-clients yes. Otherwise retain version 1 with explicit files.'), { code: 'CLIENT_UPGRADE_REQUIRED' });
  }
}

async function existingDirectory(input) {
  if (!absolute(input)) invalid();
  const canonical = await fs.realpath(input);
  if (!(await fs.stat(canonical)).isDirectory()) invalid();
  return canonical;
}

// A nonexistent/non-directory root cannot contain the existing session cwd.
// For permission failures, ignore it only when its readable ancestor proves
// it lies outside this session. Otherwise fail closed, including exclusions
// and disabled routes, rather than falling through to an enabled fallback.
async function matchingRoot(input, cwd) {
  let candidate = path.resolve(input);
  let unavailable = false;
  for (;;) {
    try {
      const canonical = await fs.realpath(candidate);
      if (!(await fs.stat(canonical)).isDirectory()) return null;
      if (!within(canonical, cwd)) return null;
      if (unavailable) invalid();
      return canonical;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) invalid();
      candidate = parent;
      unavailable = true;
    }
  }
}

// Resolve only the selected path's existing ancestor; do not create or search for storage.
export async function canonicalSelectedPath(input) {
  if (!absolute(input)) invalid();
  let ancestor = path.resolve(input);
  const suffix = [];
  let stat = await lstat(ancestor);
  while (stat === null) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) invalid();
    ancestor = parent;
    stat = await lstat(ancestor);
  }
  // Resolve a linked ancestor consistently whether or not its selected child
  // exists yet. A selected state-directory symlink itself remains unsupported.
  if (stat.isSymbolicLink() && suffix.length === 0) invalid();
  const canonical = await fs.realpath(ancestor);
  if (!(await fs.stat(canonical)).isDirectory()) invalid();
  return path.join(canonical, ...suffix);
}

/** One canonical collection identity for setup defaults and shared writer locks. */
export async function collectionRoot(route, { allowUnavailable = false } = {}) {
  const folder = route.notesDir ?? path.dirname(route.destination);
  try { return await existingDirectory(folder); }
  catch (error) {
    // Retained unrelated routes may be offline. Still resolve ancestor aliases.
    if (!allowUnavailable || error.code !== 'ENOENT') throw error;
    return canonicalSelectedPath(folder);
  }
}

async function assertAuthoredState(stateDir) {
  // Metadata only: never read a derived manifest's sources or note contents.
  // Any manifest entry, including a broken link, reserves this state for derived outputs.
  const derivedConflict = () => {
    throw Object.assign(new Error('Capture needs an authored notes collection. This state owns derived outputs; keep its state and outputs together and select a separate notes collection for capture.'), { code: 'DERIVED_STATE_CONFLICT' });
  };
  if (await lstat(path.join(stateDir, 'manifest.json'))) derivedConflict();
  const bytes = await readBoundedBytes(path.join(stateDir, 'journal.json'), { missing: true, noFollow: true });
  if (bytes !== null) {
    const journal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    // Classify ownership only; full recovery validation would traverse referenced
    // storage. Any other pending journal still prevents authored capture.
    if (object(journal) && journal.version === 1 && journal.mode === 'derived') derivedConflict();
    throw Object.assign(new Error('The writer state has an interrupted update. Inspect and resolve its recovery journal before using capture; no recovery was attempted.'), { code: 'STATE_RECOVERY_REQUIRED' });
  }
}

async function selectedDestination(input) {
  // The safe writer uses the note basename as a relative path and rejects
  // backslashes even on systems where they are valid filename characters.
  if (path.basename(input).includes('\\')) invalid();
  const parent = await existingDirectory(path.dirname(input));
  const destination = path.join(parent, path.basename(input));
  const stat = await lstat(destination);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) invalid();
  return destination;
}

export function assertPrivate(file, skillRoot) {
  if (within(PACKAGE_ROOT, file) || within(skillRoot, file)) invalid();
}

export function assertConfigurationStorage(settings, file) {
  if (within(settings.stateDir, file) || within(file, settings.stateDir) ||
    within(settings.notesDir ?? settings.destination, file)) {
    throw new Error('Keep the configuration separate from the notes collection and writer state.');
  }
}

/** Resolve policy for a directory without manufacturing a hook event or identity. */
export async function captureSettings(client, directory, config, { skillRoot = SKILL_ROOT } = {}) {
  if (!CLIENTS.has(client)) invalid();
  if (config === null || config === undefined || config.enabled === false) return null;
  if (!configuredClient(config, client)) return null;
  configHeader(config);
  const cwd = await existingDirectory(directory);
  for (const excluded of config.exclude ?? []) {
    if (await matchingRoot(excluded, cwd)) return null;
  }
  const matches = [];
  for (const route of config.routes ?? []) {
    const projectRoot = await matchingRoot(route.projectRoot, cwd);
    if (projectRoot) matches.push({ ...route, projectRoot });
  }
  matches.sort((left, right) => right.projectRoot.length - left.projectRoot.length);
  if (matches.length > 1 && matches[0].projectRoot === matches[1].projectRoot) {
    throw Object.assign(new Error('Ambiguous capture route.'), { code: 'AMBIGUOUS_ROUTE' });
  }
  const route = matches[0] ?? config.defaultRoute;
  if (route === undefined) return null;
  if (matches.length > 0 && route.enabled === false) return null;
  routeSchema(route, matches.length > 0, config.version);
  const installedRoot = await existingDirectory(skillRoot);
  const storage = route.notesDir !== undefined
    ? { notesDir: await existingDirectory(route.notesDir) }
    : { destination: await selectedDestination(route.destination) };
  const selected = storage.notesDir ?? storage.destination;
  const stateDir = await canonicalSelectedPath(route.stateDir);
  assertPrivate(selected, installedRoot);
  assertPrivate(stateDir, installedRoot);
  if (within(stateDir, selected) || within(selected, stateDir)) invalid();
  await assertAuthoredState(stateDir);
  const automaticUpdates = route.automaticUpdates ?? config.automaticUpdates;
  return { skill: path.join(installedRoot, 'SKILL.md'),
    safeUpdate: path.join(installedRoot, 'scripts', 'safe-update.mjs'),
    ...(completionEnabled(config) ? { completionHelper: path.join(installedRoot, 'scripts', 'capture-completion.mjs') } : {}),
    ...storage, stateDir, scope: route.scope ?? config.scope, automaticUpdates };
}

export function configurationPath(explicit) {
  const file = explicit ?? process.env.CUEFLUENT_NOTES_CONFIG ?? path.join(os.homedir(), '.config', 'cuefluent-notes', 'config.json');
  if (!absolute(file)) invalid();
  return path.resolve(file);
}

/** Compare path selections in this process; the host's environment is not inspected. */
export function hookConfigurationSelection(selected) {
  let hookConfigPath;
  try { hookConfigPath = configurationPath(); }
  catch {
    return { hookConfigPath: null, hookConfigMatches: false,
      hookConfigIssue: 'CUEFLUENT_NOTES_CONFIG must be an absolute path in the host launch environment before packaged hooks can use this configuration.' };
  }
  const hookConfigMatches = selected === hookConfigPath;
  return { hookConfigPath, hookConfigMatches, ...(!hookConfigMatches ? {
    hookConfigIssue: 'The --config override applies only to this command; packaged hooks select another path in this environment. Set CUEFLUENT_NOTES_CONFIG in the host launch environment to use this configuration, then verify in a fresh task.',
  } : {}) };
}

export async function readConfigSnapshot(file) {
  if (!absolute(file)) invalid();
  let canonical;
  try { canonical = await fs.realpath(file); }
  catch (error) {
    if (error.code === 'ENOENT' && await lstat(file) === null) return { config: null, hash: null };
    throw error;
  }
  assertPrivate(canonical, PACKAGE_ROOT);
  const bytes = await readBoundedBytes(canonical, { maxBytes: MAX_INPUT_BYTES });
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!object(config)) invalid();
  return { config, hash: createHash('sha256').update(bytes).digest('hex') };
}

export async function readConfig(file) {
  return (await readConfigSnapshot(file)).config;
}
