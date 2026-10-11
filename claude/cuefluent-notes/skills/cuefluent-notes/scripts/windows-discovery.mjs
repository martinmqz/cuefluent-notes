import fs from 'node:fs/promises';
import path from 'node:path';
import { absolutePath, canonicalWorkflowPath, canonicalWorkflowProject, windowsDefaultLocations, inside } from './workflow-paths.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { lstatOrNull, sameFileIdentity } from './file-io.mjs';
import { fail, canonicalJSON } from './workflow-values.mjs';

const MAX_PACKAGES = 1024, MAX_CANDIDATES = 32, INSPECTION_MS = 30000;
export const windowsContains = (parent, child) => inside(parent, child, process.platform, { caseInsensitive: true });
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });

/** Facts come from the host environment (or an owned test fixture), never a request body. */
export function windowsStorageLocations({ env = process.env, home } = {}) {
  const locations = windowsDefaultLocations({ env, home });
  const { local } = locations;
  const roaming = env.APPDATA ? absolutePath(env.APPDATA) : null;
  return { ...locations, roaming, packages: path.join(local, 'Packages') };
}

export function discoveryBudget({ now = () => performance.now() } = {}) {
  const started = now();
  return () => {
    checkWorkflowBudget();
    if (now() - started > INSPECTION_MS) fail('WINDOWS_DISCOVERY_TIMEOUT');
  };
}

/** Metadata only. Resolve ordinary aliases, but refuse links anywhere below the
 * selected base. Pin every existing component and never count errors as absence. */
export async function inspectWindowsPath(input, { base, check = () => {}, directory = true, bases } = {}) {
  const requested = absolutePath(input);
  let selected, start;
  if (base !== undefined) {
    const requestedBase = absolutePath(base);
    if (!windowsContains(requestedBase, requested)) fail('UNSAFE_WORKFLOW_PATH');
    // An alias above the inspection boundary is permitted, like the existing
    // workflow canonicalizer. Links beneath the boundary are still refused.
    let pinned = bases?.get(requestedBase);
    if (pinned) {
      // Cache resolution only within this inspection pass. Recheck the requested
      // alias's target identity on every use; never reuse an ACL or changed base.
      if (!sameFileIdentity(pinned.stat, await fs.stat(requestedBase, { bigint: true }))) fail('WINDOWS_DISCOVERY_CHANGED');
      start = pinned.resolved;
    } else {
      start = await canonicalWorkflowProject(requestedBase);
      const stat = await lstatOrNull(start, { bigint: true });
      if (stat) {
        if (!sameFileIdentity(stat, await fs.stat(requestedBase, { bigint: true }))) fail('WINDOWS_DISCOVERY_CHANGED');
        bases?.set(requestedBase, { resolved: start, stat });
      }
    }
    selected = path.join(start, path.relative(requestedBase, requested));
  } else {
    selected = await canonicalWorkflowPath(requested, { directory });
    start = path.parse(selected).root;
  }
  check();
  let current = start;
  const components = path.relative(start, selected).split(path.sep).filter(Boolean), pins = [];
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = path.join(current, components[i]);
    check();
    const before = await lstatOrNull(current, { bigint: true });
    if (!before) {
      const resolved = await canonicalWorkflowPath(requested, { directory }); check();
      if (!windowsContains(selected, resolved) || !windowsContains(resolved, selected)) fail('WINDOWS_DISCOVERY_CHANGED');
      return { path: requested, resolved, status: 'missing', pins };
    }
    const leaf = i === components.length - 1;
    if (before.isSymbolicLink() || !(leaf && !directory ? before.isFile() && before.nlink === 1n : before.isDirectory())) fail('UNSAFE_WORKFLOW_PATH');
    const resolved = await fs.realpath(current), after = await fs.lstat(current, { bigint: true }); check();
    if (!sameFileIdentity(before, after)) fail('WINDOWS_DISCOVERY_CHANGED');
    pins.push({ path: current, resolved, identity: identity(after) });
    if (leaf) {
      const final = await canonicalWorkflowPath(requested, { directory }); check();
      if (!windowsContains(final, resolved) || !windowsContains(resolved, final)) fail('WINDOWS_DISCOVERY_CHANGED');
      return { path: requested, resolved, status: 'present', identity: identity(after), pins,
        ...(!directory ? { byteLength: Number(after.size) } : {}) };
    }
  }
  fail('UNSAFE_WORKFLOW_PATH');
}

async function packageDirectories(locations, check, bases) {
  const root = await inspectWindowsPath(locations.packages, { check });
  if (root.status === 'missing') return { root, entries: [] };
  const entries = [], stream = await fs.opendir(locations.packages, { bufferSize: 1 });
  try {
    for (let entry = await stream.read(); entry; entry = await stream.read()) {
      check(); if (entries.length >= MAX_PACKAGES) fail('WINDOWS_DISCOVERY_CAPACITY');
      const file = path.join(locations.packages, entry.name);
      const state = await inspectWindowsPath(file, { base: locations.packages, check, bases });
      // A disappearing or unexpected package entry is incomplete enumeration.
      if (state.status !== 'present') fail('WINDOWS_DISCOVERY_CHANGED');
      entries.push(state);
    }
  } finally { await stream.close(); }
  const after = await inspectWindowsPath(locations.packages, { check });
  if (canonicalJSON(root) !== canonicalJSON(after)) fail('WINDOWS_DISCOVERY_CHANGED');
  return { root, entries };
}

async function candidateAt(file, base, check, ownedSettings, bases) {
  const selected = await inspectWindowsPath(file, { base, directory: false, check, bases });
  if (selected.status === 'present') return { kind: 'config', ...selected };
  const parent = await inspectWindowsPath(path.dirname(file), { base, check, bases });
  if (parent.status === 'missing') return null;
  const stream = await fs.opendir(parent.path, { bufferSize: 1 });
  let first;
  try {
    check(); first = await stream.read(); check();
    if (ownedSettings && sameFileIdentity(ownedSettings.stat, await fs.lstat(parent.path, { bigint: true }))) {
      // The only ignored entries are this configure operation's exact lock and
      // stage names under its pinned parent. Unknown entries remain unresolved.
      let entry = first;
      const allowed = new Set(ownedSettings.entries);
      while (entry && allowed.delete(entry.name)) { check(); entry = await stream.read(); }
      if (!entry) first = null;
    }
  }
  finally { await stream.close(); }
  const after = await inspectWindowsPath(parent.path, { base, check, bases });
  if (canonicalJSON(parent) !== canonicalJSON(after)) fail('WINDOWS_DISCOVERY_CHANGED');
  return { kind: first ? 'unresolved-state' : 'empty-shadow', ...parent };
}

/** Shallow, bounded inventory of known config locations. No config bodies or
 * directory contents beyond the single entry needed to establish nonemptiness. */
export async function discoverWindowsSettings(facts = {}, { check = discoveryBudget(), ownedSettings } = {}) {
  const locations = windowsStorageLocations(facts), candidates = [], seen = new Set();
  const bases = new Map();
  let packages = { entries: [] }, failure = null;
  const add = value => {
    if (!value) return;
    const key = value.identity ? canonicalJSON(value.identity) : value.path.toLowerCase();
    if (seen.has(key)) return;
    if (candidates.length >= MAX_CANDIDATES) fail('WINDOWS_DISCOVERY_CAPACITY');
    seen.add(key); candidates.push(value);
  };
  try {
    add(await candidateAt(locations.oldConfig, locations.local, check, ownedSettings, bases));
    add(await candidateAt(locations.newConfig, locations.home, check, ownedSettings, bases));
    packages = await packageDirectories(locations, check, bases);
    for (const pkg of packages.entries) {
      check();
      add(await candidateAt(path.join(pkg.path, 'LocalCache', 'Local', 'CuefluentNotes', 'workflow.json'), pkg.path, check, ownedSettings, bases));
    }
    check();
  } catch (error) {
    // Public diagnostics reveal only a bounded fixed code, never OS exception text.
    failure = ['WINDOWS_DISCOVERY_TIMEOUT', 'WINDOWS_DISCOVERY_CAPACITY', 'WINDOWS_DISCOVERY_CHANGED'].includes(error.code)
      ? error.code : 'WINDOWS_DISCOVERY_UNAVAILABLE';
  }
  candidates.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return { complete: failure === null, reason: failure, candidates, locations, packages };
}

export function discoverySummary(value) {
  return { complete: value.complete, reason: value.reason,
    candidates: value.candidates.map(({ kind, path: requestedPath, resolved }) => ({ kind, requestedPath, resolvedPath: resolved })) };
}

/** Config leaves expose package redirection even where directory realpath keeps
 * an ordinary spelling. Also retain physical package-base aliases. */
export async function packageStorageOrigin(file, facts = {}, { directory = false, check = () => {} } = {}) {
  const locations = windowsStorageLocations(facts);
  const state = await inspectWindowsPath(file, { directory, check });
  const packages = await inspectWindowsPath(locations.packages, { check });
  return { ...state, packageOwned: [locations.packages, packages.resolved].some(root =>
    windowsContains(root, state.path) || windowsContains(root, state.resolved)) };
}

/** Inspect only counterpart metadata. Any shadow ancestor under Local/Roaming
 * can hide a missing ordinary root, including a completely empty shadow. */
export async function windowsRootCreationSnapshot({ configPath, roots }, facts = {}) {
  const check = discoveryBudget(), locations = windowsStorageLocations(facts);
  const config = await inspectWindowsPath(configPath, { directory: false, check });
  const inspected = [];
  for (const file of roots) inspected.push(await inspectWindowsPath(file, { check }));
  const missing = inspected.filter(item => item.status === 'missing');
  // Prepared collections need no unrelated package inventory to keep working.
  if (!missing.length) return { config, roots: inspected };
  const packageBase = await inspectWindowsPath(locations.packages, { check });
  const packageOwned = item => [locations.packages, packageBase.resolved].some(base =>
    windowsContains(base, item.path) || windowsContains(base, item.resolved));
  if (packageOwned(config) || missing.some(packageOwned)) fail('WINDOWS_PACKAGE_STORE_FROZEN');
  const bases = [];
  for (const [requested, kind] of [[locations.local, 'Local'], [locations.roaming, 'Roaming']]) {
    if (!requested) continue;
    const relevant = missing.some(root => windowsContains(requested, root.path) || windowsContains(requested, root.resolved));
    // Local roots cannot be redirected beneath an unrelated UNC shell folder.
    // Do not contact that server merely to prepare local private storage.
    if (!relevant && requested.startsWith('\\\\') && missing.every(root =>
      /^[a-z]:\\/i.test(root.path) && /^[a-z]:\\/i.test(root.resolved))) continue;
    let resolved;
    try { resolved = await canonicalWorkflowProject(requested); }
    catch (error) {
      if (relevant) throw error;
      // Available aliases still participate below. An unavailable unrelated
      // shell-folder mapping is not authority over the inspected local roots.
      check(); continue;
    }
    check();
    for (const base of new Set([requested, resolved])) bases.push([base, kind]);
  }
  const ordinary = missing.flatMap(root => bases
    .filter(([base]) => windowsContains(base, root.path) || windowsContains(base, root.resolved))
    .map(([base, kind]) => ({ root, base, kind })));
  if (ordinary.length) {
    const bases = new Map(), packages = await packageDirectories(locations, check, bases);
    for (const { root, base, kind } of ordinary) {
      const selected = windowsContains(base, root.path) ? root.path : root.resolved;
      const suffix = path.relative(base, selected).split(path.sep).filter(Boolean);
      for (const pkg of packages.entries) {
        const anchor = path.join(pkg.path, 'LocalCache', kind);
        // LocalCache/Local itself is shared by many apps: only shadow ancestors
        // below it correspond to the requested ordinary AppData child.
        if (suffix.length) {
          const counterpart = path.join(anchor, suffix[0]);
          const state = await inspectWindowsPath(counterpart, { base: pkg.path, check, bases });
          if (state.status === 'present') fail('WINDOWS_STORAGE_SHADOW_CONFLICT');
          // No descendant can exist under this absent first component.
        }
        if (!suffix.length) fail('WINDOWS_STORAGE_SHADOW_CONFLICT');
      }
    }
  }
  check();
  return { config, roots: inspected };
}
