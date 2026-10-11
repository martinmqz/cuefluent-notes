import fs from 'node:fs/promises';
import path from 'node:path';
import { readWorkflowSnapshot, MAX_WORKFLOW_CONFIG_BYTES } from './workflow-config.mjs';
import { canonicalWorkflowPath, canonicalWorkflowProject, overlaps } from './workflow-paths.mjs';
import { sameFileIdentity } from './file-io.mjs';
import { canonicalJSON, fail } from './workflow-values.mjs';
import { discoverWindowsSettings, discoveryBudget, discoverySummary, inspectWindowsPath,
  windowsContains, windowsRootCreationSnapshot, packageStorageOrigin } from './windows-discovery.mjs';

const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const overlap = (a, b) => overlaps(a, b, process.platform, { caseInsensitive: true });
const sameIdentity = (a, b) => a && b && canonicalJSON(a) === canonicalJSON(b);
const collectionBinding = c => [c.rawDir, c.intakeStateDir, c.notes.writerStateDir, c.notes.notesDir ?? null, c.notes.destination ?? null];
const samePath = (a, b) => windowsContains(a, b) && windowsContains(b, a);

/** Policy-only edits and removals do not depend on unrelated package health. */
export function ownershipChanged(previous, proposed) {
  if (!previous) return true;
  return proposed.collections.some(c => {
    const old = previous.collections.find(o => o.id === c.id);
    return !old || canonicalJSON(collectionBinding(old)) !== canonicalJSON(collectionBinding(c));
  }) || proposed.routes.some(r => {
    const old = previous.routes.find(o => o.id === r.id);
    return !old || old.projectRoot !== r.projectRoot || old.collectionId !== r.collectionId;
  });
}

async function bindings(config, configPath, check) {
  const known = new Map();
  const resolve = async (file, kind) => {
    const key = `${kind}:${file}`;
    if (!known.has(key)) {
      check();
      const resolved = kind === 'project' ? await canonicalWorkflowProject(file) : await canonicalWorkflowPath(file, { directory: kind !== 'file' });
      check(); known.set(key, { requested: path.resolve(file), resolved, directory: kind !== 'file' });
    }
    return known.get(key);
  };
  const projects = [], notes = [], privatePaths = [await resolve(configPath, 'file')];
  for (const r of config.routes) projects.push(await resolve(r.projectRoot, 'project'));
  for (const c of config.collections) {
    notes.push(await resolve(c.notes.notesDir ?? c.notes.destination, c.notes.notesDir ? 'directory' : 'file'));
    for (const file of [c.rawDir, c.intakeStateDir, c.notes.writerStateDir]) privatePaths.push(await resolve(file, 'directory'));
  }
  return { projects, notes, privatePaths };
}
const intersects = (a, b) => ['requested', 'resolved'].some(left => ['requested', 'resolved'].some(right => {
  const x = a[left], y = b[right];
  if (!a.directory && !b.directory) return x.toLowerCase() === y.toLowerCase();
  if (!a.directory) return windowsContains(y, x);
  if (!b.directory) return windowsContains(x, y);
  return overlap(x, y);
}));
function conflict(left, right) {
  const any = (a, b) => a.some(x => b.some(y => intersects(x, y)));
  return any(left.projects, right.projects) || any(left.notes, right.notes) ||
    any(left.projects, right.privatePaths) || any(left.privatePaths, right.projects) ||
    any(left.privatePaths, [...right.privatePaths, ...right.notes]) || any(left.notes, right.privatePaths);
}

/** Resolve an otherwise unexplained default directory only from the inspected
 * PREVIOUS config. Walk metadata along known ancestors; private roots are opaque
 * leaves. Unknown siblings remain unresolved, never read or adopted. */
async function selectedStorage(item, previous, selected, ownedSettings, check) {
  if (!previous || selected.status !== 'present') return null;
  const targets = previous.privatePaths, pins = [];
  let count = 0;
  async function visit(file) {
    check(); if (++count > 4096) fail('WINDOWS_SETTINGS_INSPECTION_LIMIT');
    const stat = await fs.lstat(file, { bigint: true });
    const state = await inspectWindowsPath(file, { base: item.path, directory: stat.isDirectory(), check });
    if (state.status !== 'present') return false;
    const target = targets.find(t => samePath(t.resolved, state.resolved));
    if (target) {
      if (target.directory !== stat.isDirectory() || (!target.directory && !sameIdentity(state.identity, selected.identity))) return false;
      pins.push(state); return true;
    }
    if (!stat.isDirectory() || !targets.some(t => windowsContains(state.resolved, t.resolved))) return false;
    pins.push(state);
    const ignore = ownedSettings && sameFileIdentity(ownedSettings.stat, await fs.lstat(file, { bigint: true })) ? new Set(ownedSettings.entries) : new Set();
    for await (const entry of await fs.opendir(file, { bufferSize: 1 })) {
      check();
      if (ignore.delete(entry.name)) continue;
      if (!await visit(path.join(file, entry.name))) return false;
    }
    return true;
  }
  if (!await visit(item.path)) return null;
  return pins.sort((a, b) => a.resolved.localeCompare(b.resolved));
}

async function configurationInspection({ configPath, previous, proposed, explicit, ownedSettings }, facts) {
  const check = discoveryBudget();
  const inventory = await discoverWindowsSettings(facts, { check, ownedSettings });
  if (!inventory.complete) fail('WINDOWS_SETTINGS_DISCOVERY_INCOMPLETE');
  const selected = await inspectWindowsPath(configPath, { directory: false, check });
  const proposedBindings = await bindings(proposed, configPath, check);
  let previousBindings;
  const candidates = [];
  let totalBytes = 0;
  for (const item of inventory.candidates) {
    if (item.kind === 'empty-shadow') continue;
    if (item.kind !== 'config') {
      if (previous && !previousBindings) previousBindings = await bindings(previous, configPath, check);
      const owned = await selectedStorage(item, previousBindings, selected, ownedSettings, check);
      if (!owned) fail('WINDOWS_SETTINGS_UNRESOLVED');
      candidates.push({ kind: 'selected-storage', path: item.path, owned });
      continue;
    }
    if (sameIdentity(item.identity, selected.identity)) continue;
    if (!explicit && selected.status === 'missing') fail('WINDOWS_EXISTING_SETTINGS');
    if (item.byteLength > MAX_WORKFLOW_CONFIG_BYTES || item.byteLength > MAX_TOTAL_BYTES - totalBytes) fail('WINDOWS_SETTINGS_INSPECTION_LIMIT');
    check();
    let snapshot, after, other;
    try {
      snapshot = await readWorkflowSnapshot(item.path, { maxBytes: Math.min(MAX_WORKFLOW_CONFIG_BYTES, MAX_TOTAL_BYTES - totalBytes) });
      after = await inspectWindowsPath(item.path, { directory: false, check });
      if (snapshot.config) other = await bindings(snapshot.config, item.path, check);
    } catch (cause) {
      throw Object.assign(new Error('Another discovered settings file could not be validated.', { cause }), { code: 'WINDOWS_SETTINGS_UNRESOLVED' });
    }
    if (!snapshot.config) fail('WINDOWS_SETTINGS_CHANGED');
    if (!sameIdentity(item.identity, after.identity) || after.byteLength !== item.byteLength || after.resolved !== item.resolved) fail('WINDOWS_SETTINGS_CHANGED');
    totalBytes += after.byteLength;
    if (conflict(proposedBindings, other)) fail('WINDOWS_SETTINGS_OVERLAP');
    candidates.push({ path: item.path, resolved: item.resolved, identity: item.identity, hash: snapshot.hash, bindings: other });
  }
  check();
  // Empty shadows elsewhere are still pinned: appearing/disappearing candidates
  // conflict, while the selected settings parent's owned lock/stage is excluded.
  const shadows = inventory.candidates.filter(c => c.kind === 'empty-shadow' &&
    !samePath(c.resolved, path.dirname(selected.resolved)));
  return { candidates, shadows, proposedBindings };
}

/** At most two bounded passes. Exact hashes/identities are never refreshed to
 * make a conflict disappear, and the comparison grants no capture consent. */
export async function preflightWindowsConfiguration({ configPath, previous, proposed, explicit = true }, facts = {}) {
  if ((facts.platform ?? process.platform) !== 'win32' || !ownershipChanged(previous, proposed)) return null;
  const before = await configurationInspection({ configPath, previous, proposed, explicit }, facts);
  let rechecked = false;
  return async ownedSettings => {
    if (rechecked) fail('WINDOWS_SETTINGS_CHANGED');
    rechecked = true;
    const after = await configurationInspection({ configPath, previous, proposed, explicit, ownedSettings }, facts);
    if (canonicalJSON(before) !== canonicalJSON(after)) fail('WINDOWS_SETTINGS_CHANGED');
  };
}

/** Freeze only creation of missing roots, not normal verification of prepared
 * collections. Do not enumerate unrelated packages for non-AppData roots. */
export async function preflightWindowsStorage(selection, facts = {}) {
  if ((facts.platform ?? process.platform) !== 'win32') return null;
  const before = await windowsRootCreationSnapshot(selection, facts);
  let rechecked = false;
  return async () => {
    if (rechecked) fail('WINDOWS_SETTINGS_CHANGED');
    rechecked = true;
    const after = await windowsRootCreationSnapshot(selection, facts);
    if (canonicalJSON(before) !== canonicalJSON(after)) fail('WINDOWS_SETTINGS_CHANGED');
  };
}

export async function windowsSettingsDiagnostics(configPath, config, { details = false, ...facts } = {}) {
  if ((facts.platform ?? process.platform) !== 'win32') return {};
  let inventory;
  try { if (details) inventory = await discoverWindowsSettings(facts); }
  catch { return { windowsStorage: { status: 'unverified', discovery: {
    complete: false, reason: 'WINDOWS_DISCOVERY_UNAVAILABLE', candidates: [],
  } } }; }
  let origin;
  try { origin = await packageStorageOrigin(configPath, facts); }
  catch { return { windowsStorage: { status: 'unverified', discovery: inventory ? discoverySummary(inventory)
    : { complete: false, reason: 'WINDOWS_DISCOVERY_UNAVAILABLE', candidates: [] } } }; }
  const value = { status: origin.packageOwned ? 'package-owned' : 'ordinary', ...(inventory ? { discovery: discoverySummary(inventory) } : {}),
    ...(origin.packageOwned ? { warning: 'Config in package storage; roots depend on the host. Additions needing missing roots are frozen pending separate migration.' } : {}) };
  if (details && config) {
    const check = discoveryBudget();
    value.collections = [];
    for (const c of config.collections) {
      try { check(); } catch { value.detailsComplete = false; break; }
      const roots = [];
      for (const [kind, file, directory] of [['raw', c.rawDir, true], ['intake', c.intakeStateDir, true],
        ['writer', c.notes.writerStateDir, true], ['notes', c.notes.notesDir ?? c.notes.destination, !!c.notes.notesDir]]) {
        try {
          const state = await inspectWindowsPath(file, { directory, check });
          roots.push({ kind, requestedPath: file, resolvedPath: state.resolved, status: state.status, ...(state.identity ? { identity: state.identity } : {}) });
        } catch { roots.push({ kind, requestedPath: file, status: 'unavailable' }); }
      }
      value.collections.push({ id: c.id, roots });
    }
  }
  return { windowsStorage: value };
}
