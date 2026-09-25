import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { windowsAbsolute, CONTROLS, lstatOrNull } from './file-io.mjs';
import { PACKAGE_ROOT } from './runtime-paths.mjs';
import { fail, id, string } from './workflow-values.mjs';

export function absolutePath(value, platform = process.platform) {
  string(value);
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || CONTROLS.test(value) ||
      !(platform === 'win32' ? windowsAbsolute(value) : api.isAbsolute(value))) fail('INVALID_WORKFLOW_PATH');
  return api.resolve(value);
}
export function inside(parent, child, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const relative = api.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative));
}
export const overlaps = (a, b, platform) => inside(a, b, platform) || inside(b, a, platform);

// Missing suffix spelling is not canonical on the default case-insensitive APFS.
// Conservatively reject case-only overlaps even on a case-sensitive macOS volume.
const placementOverlap = (a, b) => overlaps(process.platform === 'darwin' ? a.toLowerCase() : a,
  process.platform === 'darwin' ? b.toLowerCase() : b);

export function workflowDefaults({ platform = process.platform, home = os.homedir(), env = process.env, collectionId } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  let base, configPath;
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) fail('LOCAL_STATE_LOCATION_REQUIRED');
    const local = absolutePath(env.LOCALAPPDATA, platform);
    if (!/^[a-z]:\\/i.test(local)) fail('LOCAL_STATE_LOCATION_REQUIRED');
    base = api.join(local, 'CuefluentNotes');
    configPath = api.join(base, 'workflow.json');
  } else {
    const user = absolutePath(home, platform);
    configPath = api.join(user, '.config', 'cuefluent-notes', 'workflow.json');
    base = platform === 'darwin' ? api.join(user, 'Library', 'Application Support', 'Cuefluent Notes')
      : api.join(env.XDG_STATE_HOME ? absolutePath(env.XDG_STATE_HOME, platform) : api.join(user, '.local', 'state'), 'cuefluent-notes');
  }
  if (collectionId === undefined) return { configPath };
  const root = api.join(base, 'collections', id(collectionId));
  return { configPath, rawDir: api.join(root, '.cuefluent-raw'), intakeStateDir: api.join(root, 'state') };
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
  configPath = workflowDefaults().configPath, canonicalize = canonicalWorkflowPath } = {}) {
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
