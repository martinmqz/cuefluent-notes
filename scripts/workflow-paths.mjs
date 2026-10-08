import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { windowsAbsolute, CONTROLS, lstatOrNull, sameFileIdentity } from './file-io.mjs';
import { PACKAGE_ROOT } from './runtime-paths.mjs';
import { fail, id, string } from './workflow-values.mjs';

export function absolutePath(value, platform = process.platform) {
  string(value);
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || CONTROLS.test(value) ||
      !(platform === 'win32' ? windowsAbsolute(value) : api.isAbsolute(value))) fail('INVALID_WORKFLOW_PATH');
  return api.resolve(value);
}
export function inside(parent, child, platform = process.platform, { caseInsensitive = false } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const relative = api.relative(caseInsensitive ? parent.toLowerCase() : parent, caseInsensitive ? child.toLowerCase() : child);
  return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative));
}
export const overlaps = (a, b, platform, options) => inside(a, b, platform, options) || inside(b, a, platform, options);

// Missing suffix spelling is not canonical on the default case-insensitive APFS.
// Conservatively reject case-only overlaps even on a case-sensitive macOS volume.
const placementOverlap = (a, b) => overlaps(process.platform === 'darwin' ? a.toLowerCase() : a,
  process.platform === 'darwin' ? b.toLowerCase() : b);

/** Shared path facts, without inventory, native subprocesses or writes. */
export function windowsDefaultLocations({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (!env.LOCALAPPDATA) fail('LOCAL_STATE_LOCATION_REQUIRED');
  const local = absolutePath(env.LOCALAPPDATA, platform), user = absolutePath(home, platform);
  if (platform === 'win32' && !/^[a-z]:\\/i.test(local)) fail('LOCAL_STATE_LOCATION_REQUIRED');
  return { local, home: user, oldConfig: api.join(local, 'CuefluentNotes', 'workflow.json'),
    newConfig: api.join(user, '.cuefluent-notes', 'workflow.json') };
}

async function defaultCandidate(file) {
  // Canonicalization also checks missing suffixes: broken aliases and access
  // errors cannot masquerade as the confirmed absence needed for fresh setup.
  try {
    await canonicalWorkflowPath(file, { directory: false });
    const stat = await lstatOrNull(file, { bigint: true });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('UNSAFE_WORKFLOW_PATH');
    const resolved = await fs.realpath(file), after = await fs.lstat(file, { bigint: true });
    if (!sameFileIdentity(stat, after)) fail('PRIVATE_STORAGE_CHANGED');
    return { resolved, stat: after };
  } catch (error) { throw Object.assign(new Error('Workflow default selection is unavailable.', { cause: error }), { code: 'WORKFLOW_CONFIG_UNAVAILABLE' }); }
}

/** Native metadata only. Separate path facts keep this shared by hooks and CLI. */
export async function resolveWindowsConfig({ oldConfig, newConfig }) {
  const old = await defaultCandidate(oldConfig);
  // A network profile is not a fresh storage candidate. Keep a healthy old
  // LocalAppData selection available without inspecting the network profile.
  if (newConfig.startsWith('\\\\')) {
    if (old) return oldConfig;
    fail('LOCAL_STATE_LOCATION_REQUIRED');
  }
  const current = await defaultCandidate(newConfig);
  if (old && current && !sameFileIdentity(old.stat, current.stat)) fail('WORKFLOW_CONFIG_SELECTION_REQUIRED');
  return current || !old ? newConfig : oldConfig;
}

export async function resolveWorkflowConfig({ platform = process.platform, home = os.homedir(), env = process.env, explicit } = {}) {
  const override = explicit ?? env.CUEFLUENT_WORKFLOW_CONFIG;
  const requestedConfigPath = override ?? (platform === 'win32'
    ? await resolveWindowsConfig(windowsDefaultLocations({ platform, home, env }))
    : path.posix.join(absolutePath(home, platform), '.config', 'cuefluent-notes', 'workflow.json'));
  return { configPath: absolutePath(requestedConfigPath, platform), requestedConfigPath, explicit: override !== undefined };
}

export async function workflowDefaults({ platform = process.platform, home = os.homedir(), env = process.env, collectionId, explicit } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const { configPath } = await resolveWorkflowConfig({ platform, home, env, explicit });
  if (collectionId === undefined) return { configPath };
  let base;
  if (platform === 'win32') {
    // Keep new suggestions with the selected settings, including aliases of an
    // old store and explicit custom configs. Never create orphan default state
    // elsewhere merely because the caller selected a different settings path.
    base = api.dirname(configPath);
  } else {
    const user = absolutePath(home, platform);
    base = platform === 'darwin' ? api.join(user, 'Library', 'Application Support', 'Cuefluent Notes')
      : api.join(env.XDG_STATE_HOME ? absolutePath(env.XDG_STATE_HOME, platform) : api.join(user, '.local', 'state'), 'cuefluent-notes');
  }
  const root = api.join(base, 'collections', id(collectionId));
  return { configPath, rawDir: api.join(root, '.cuefluent-raw'), intakeStateDir: api.join(root, 'state'), writerStateDir: api.join(root, 'writer') };
}

/** Resolve existing aliases, but never create a missing suffix. Leaf links are refused. */
export async function canonicalWorkflowPath(input, { directory = true, allowMissing = true } = {}) {
  const selected = absolutePath(input);
  const stat = await lstatOrNull(selected);
  if (stat) {
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
        (!directory && stat.nlink !== 1)) fail('UNSAFE_WORKFLOW_PATH');
    return fs.realpath(selected);
  }
  if (!allowMissing) fail('WORKFLOW_PATH_MISSING');
  const suffix = [path.basename(selected)];
  let parent = path.dirname(selected);
  for (;;) {
    const ancestor = await lstatOrNull(parent);
    if (ancestor) {
      const canonical = await fs.realpath(parent);
      if (!(await fs.stat(canonical)).isDirectory()) fail('UNSAFE_WORKFLOW_PATH');
      return path.join(canonical, ...suffix);
    }
    if (path.dirname(parent) === parent) fail('WORKFLOW_PATH_MISSING');
    suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
  }
}

/** Project identity can be reached through a directory alias. This does not
 * relax the no-link rules for settings, private roots, or native source files. */
export async function canonicalWorkflowProject(input, { allowMissing = true } = {}) {
  const selected = absolutePath(input);
  let resolved;
  try { resolved = await fs.realpath(selected); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return canonicalWorkflowPath(selected, { allowMissing });
  }
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_WORKFLOW_PATH');
  return resolved;
}

/** Input must already pass validateWorkflowConfig. This is not an ACL/locality grant. */
export async function validateWorkflowPlacement(config, { packageRoot = PACKAGE_ROOT,
  configPath, canonicalize = canonicalWorkflowPath } = {}) {
  configPath ??= (await workflowDefaults()).configPath;
  const projects = await Promise.all(config.routes.map(route => canonicalize(route.projectRoot)));
  const installedRoot = await canonicalize(packageRoot);
  const protectedRoots = [installedRoot, ...projects];
  const settings = await canonicalize(configPath, { directory: false });
  const collections = await Promise.all(config.collections.map(async collection => ({ ...collection,
    rawDir: await canonicalize(collection.rawDir), intakeStateDir: await canonicalize(collection.intakeStateDir),
    notes: { ...collection.notes,
      ...(collection.notes.notesDir ? { notesDir: await canonicalize(collection.notes.notesDir) }
        : { destination: await canonicalize(collection.notes.destination, { directory: false }) }),
      writerStateDir: await canonicalize(collection.notes.writerStateDir) },
  })));
  const privatePaths = collections.flatMap(item => [item.rawDir, item.intakeStateDir, item.notes.writerStateDir]);
  // An explicit file owns only that file for placement, while its writer still
  // coordinates the parent directory with other file/folder collections.
  const noteRoot = item => item.notes.notesDir ?? path.dirname(item.notes.destination);
  const notes = collections.map(item => item.notes.notesDir ?? item.notes.destination);
  for (const entry of [...privatePaths, settings]) {
    if (protectedRoots.some(root => placementOverlap(root, entry))) fail('WORKFLOW_STORAGE_OVERLAP');
  }
  if (notes.some(note => placementOverlap(installedRoot, note))) fail('WORKFLOW_STORAGE_OVERLAP');
  for (const entry of [...privatePaths, settings]) if (notes.some(note => placementOverlap(note, entry))) fail('WORKFLOW_STORAGE_OVERLAP');
  if (privatePaths.some(entry => placementOverlap(settings, entry))) fail('WORKFLOW_STORAGE_OVERLAP');
  for (let i = 0; i < collections.length; i++) {
    const left = collections[i];
    if (placementOverlap(left.rawDir, left.intakeStateDir) || placementOverlap(left.rawDir, left.notes.writerStateDir) ||
        placementOverlap(left.intakeStateDir, left.notes.writerStateDir)) fail('WORKFLOW_STORAGE_OVERLAP');
    for (const right of collections.slice(i + 1)) {
      if ([left.rawDir, left.intakeStateDir].some(a => [right.rawDir, right.intakeStateDir, right.notes.writerStateDir].some(b => placementOverlap(a, b))) ||
          [right.rawDir, right.intakeStateDir].some(a => placementOverlap(a, left.notes.writerStateDir))) fail('WORKFLOW_STORAGE_OVERLAP');
      const sameWriter = inside(left.notes.writerStateDir, right.notes.writerStateDir) && inside(right.notes.writerStateDir, left.notes.writerStateDir);
      const noteOverlap = placementOverlap(noteRoot(left), noteRoot(right));
      const conflictingOrganization = left.notes.notesDir && right.notes.notesDir && left.notes.organization !== right.notes.organization;
      if ((noteOverlap && (!sameWriter || conflictingOrganization)) ||
          (!sameWriter && placementOverlap(left.notes.writerStateDir, right.notes.writerStateDir))) fail('WORKFLOW_WRITER_CONFLICT');
    }
  }
  return { collections, privacy: 'unverified' };
}
