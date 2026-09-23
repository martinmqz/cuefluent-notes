import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { absolute, within, lstatOrNull as lstat, readBoundedBytes, CONTROLS } from './file-io.mjs';
import { PACKAGE_ROOT, SKILL_ROOT } from './runtime-paths.mjs';

export const CLIENTS = new Set(['codex', 'claude']);
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ROUTES = 100;
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !CONTROLS.test(value);
const invalid = () => { throw new Error('Invalid capture configuration.'); };
const onlyKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

function routeSchema(route, project = false) {
  const keys = project ? ['projectRoot', 'destination', 'stateDir', 'automaticUpdates', 'scope', 'enabled'] : ['destination', 'stateDir'];
  if (!onlyKeys(route, keys) || !absolute(route.destination) || !absolute(route.stateDir) ||
    !/\.(?:md|markdown)$/i.test(route.destination)) invalid();
  if (project && (!absolute(route.projectRoot) ||
    (route.automaticUpdates !== undefined && typeof route.automaticUpdates !== 'boolean') ||
    (route.enabled !== undefined && typeof route.enabled !== 'boolean') ||
    (route.scope !== undefined && !text(route.scope, 2000)))) invalid();
}

export function configSchema(config) {
  if (!onlyKeys(config, ['version', 'enabled', 'clients', 'automaticUpdates', 'scope', 'defaultRoute', 'routes', 'exclude']) ||
    config.version !== 1 || typeof config.enabled !== 'boolean' || typeof config.automaticUpdates !== 'boolean' ||
    !text(config.scope, 2000) || !Array.isArray(config.clients) || config.clients.length > CLIENTS.size ||
    config.clients.some(client => !CLIENTS.has(client)) || new Set(config.clients).size !== config.clients.length) invalid();
  if (config.defaultRoute !== undefined) routeSchema(config.defaultRoute);
  if (config.routes !== undefined) {
    if (!Array.isArray(config.routes) || config.routes.length > MAX_ROUTES) invalid();
    for (const route of config.routes) routeSchema(route, true);
  }
  if (config.exclude !== undefined && (!Array.isArray(config.exclude) || config.exclude.length > MAX_ROUTES || config.exclude.some(item => !absolute(item)))) invalid();
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

/** Resolve policy for a directory without manufacturing a hook event or identity. */
export async function captureSettings(client, directory, config, { skillRoot = SKILL_ROOT } = {}) {
  if (!CLIENTS.has(client)) invalid();
  if (config === null || config === undefined || config.enabled === false) return null;
  configSchema(config);
  if (!config.clients.includes(client)) return null;
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
  if (!route) return null;
  if (route.enabled === false) return null;
  const installedRoot = await existingDirectory(skillRoot);
  const destination = await selectedDestination(route.destination);
  const stateDir = await canonicalSelectedPath(route.stateDir);
  assertPrivate(destination, installedRoot);
  assertPrivate(stateDir, installedRoot);
  if (within(stateDir, destination) || within(destination, stateDir)) invalid();
  const automaticUpdates = route.automaticUpdates ?? config.automaticUpdates;
  return { skill: path.join(installedRoot, 'SKILL.md'),
    safeUpdate: path.join(installedRoot, 'scripts', 'safe-update.mjs'),
    destination, stateDir, scope: route.scope ?? config.scope, automaticUpdates };
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
