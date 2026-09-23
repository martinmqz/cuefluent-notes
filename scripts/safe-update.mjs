import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { absolute, within, lstatOrNull as existsStat, isMain, readBoundedBytes, CONTROLS, compare } from './file-io.mjs';
import { GUIDE_VERSION, MAX_BYTES, inspectMarkdown, reviewVocabulary } from './check-notes.mjs';
import { PACKAGE_ROOT } from './runtime-paths.mjs';

const MAX_FILES = 100;
const MAX_SOURCES = 1000;
const HASH = /^[a-f0-9]{64}$/;
const STAGE_NAME = /^\.cuefluent-stage-[a-f0-9-]{36}\.tmp$/;
const LIMITATIONS = 'Atomic replacement preserves permission bits and ownership for existing notes, but not ACLs or extended attributes. Hard-linked replacements are refused. Per-file atomic replacement, not a collection transaction. The state-directory lock coordinates this helper only; an unrelated editor can still race the final hash check and rename. Markdown checks do not establish factual truth, app admission, rendering or ranking.';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const serialize = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const fail = message => { throw new Error(message); };
const validHash = (value, nullable = false) => (nullable && value === null) || (typeof value === 'string' && HASH.test(value));
const regularString = value => typeof value === 'string' && value.trim() && value.length <= 4096;
function privatePath(file) {
  if (within(PACKAGE_ROOT, file)) fail('User outputs and state must remain outside the public package directory.');
}

// Read exact bytes: TextDecoder validates UTF-8 but must not normalize a BOM for hashing.
async function readBytes(file) {
  return readBoundedBytes(file, { maxBytes: MAX_BYTES, missing: true });
}

export async function fingerprint(file) {
  if (!absolute(file)) fail('Fingerprint input must be an absolute file path.');
  const bytes = await readBytes(file);
  return bytes === null ? null : sha256(bytes);
}

async function jsonFile(file) {
  const bytes = await readBytes(file);
  if (bytes === null) return { value: null, hash: null };
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('Metadata or plan file must contain valid JSON.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Metadata or plan file must contain a JSON object.');
  return { value, hash: sha256(bytes) };
}

// Canonicalize the explicitly selected root (including OS aliases such as /tmp).
// All output components beneath that root are separately checked without following links.
async function directory(input, { create = false, allowMissing = false } = {}) {
  if (!absolute(input)) fail('Notes root and state directory must be absolute paths.');
  const requested = path.resolve(input);
  privatePath(requested);
  const missing = [];
  let base = requested;
  let stat = await existsStat(base);
  while (!stat) {
    if (!create && !allowMissing) fail('The selected directory must already exist.');
    missing.unshift(path.basename(base));
    const parent = path.dirname(base);
    if (parent === base) fail('Cannot resolve selected directory.');
    base = parent;
    stat = await existsStat(base);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Selected directories cannot be symlinks or non-directories.');
  let resolved = await fs.realpath(base);
  privatePath(resolved);
  for (const component of missing) {
    resolved = path.join(resolved, component);
    privatePath(resolved);
    if (create) {
      try { await fs.mkdir(resolved, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const made = await fs.lstat(resolved);
      if (!made.isDirectory() || made.isSymbolicLink()) fail('State directory components must be real directories.');
    }
  }
  return resolved;
}
function relativeNote(value) {
  if (!regularString(value) || path.isAbsolute(value) || CONTROLS.test(value) || value.includes('\\') ||
    path.normalize(value) !== value || value === '..' || value.startsWith(`..${path.sep}`) || !/\.(md|markdown)$/i.test(value)) {
    fail('Each output must be a normalized relative .md or .markdown path within the notes root.');
  }
  return value;
}
async function targetPath(root, relative, stateDir, { allowMissingParents = false } = {}) {
  relativeNote(relative);
  const rootStat = await existsStat(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) fail('The notes root changed or became a symlink.');
  const target = path.join(root, relative);
  privatePath(target);
  if (!within(root, target) || (stateDir && within(stateDir, target))) fail('Output must stay within the notes root and outside helper state.');
  let current = root;
  for (const component of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await existsStat(current);
    if (!stat && allowMissingParents) return target;
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail('Output parent directories must already exist and cannot be symlinks.');
  }
  const stat = await existsStat(target);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) fail('Output targets must be regular files, never symlinks.');
  return target;
}
async function stateFile(stateDir, name) {
  const directoryStat = await existsStat(stateDir);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || await fs.realpath(stateDir) !== stateDir) fail('The state directory changed or became a symlink.');
  const file = path.join(stateDir, name);
  const stat = await existsStat(file);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) fail('State metadata must be regular files, never symlinks.');
  return file;
}
async function syncDirectory(dir) {
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await handle.close(); }
}
async function writeExclusive(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) { await fs.rm(file, { force: true }); throw error; }
}
async function replacementMetadata(target) {
  const stat = await existsStat(target);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('Replacement requires a regular file with a single hard link.');
  return { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
}
async function checkReplacementMetadata(file, target, current) {
  if (file.oldHash === file.newHash) return;
  const actual = await replacementMetadata(target);
  if (current === null) {
    if (actual !== null) fail('Output appeared before replacement.');
    return;
  }
  // Legacy journals did not record metadata. Preserve the current target mode
  // on their remaining writes rather than assuming the former 0600 default.
  if (file.metadata === undefined) return;
  const expected = file.metadata;
  if (!actual || (expected ? actual.mode !== expected.mode || actual.uid !== expected.uid || actual.gid !== expected.gid : actual.mode !== 0o600)) fail('Output permissions or ownership changed; inspect before replacing.');
}
async function prepareStageMetadata(file, target) {
  const desired = file.metadata === undefined ? await replacementMetadata(target) : file.metadata;
  const handle = await fs.open(file.stagePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail('Stage must be a regular file with a single hard link.');
    if (desired && (stat.uid !== desired.uid || stat.gid !== desired.gid)) await handle.chown(desired.uid, desired.gid);
    // chown may clear set-ID bits; chmod last, just before replacement.
    await handle.chmod(desired?.mode ?? 0o600);
    await handle.sync();
  } finally { await handle.close(); }
}
async function writeMetadata(stateDir, name, value) {
  const bytes = serialize(value);
  if (bytes.length > MAX_BYTES) fail('State metadata exceeds 2 MiB.');
  const target = await stateFile(stateDir, name);
  const temp = path.join(stateDir, `.metadata-${randomUUID()}.tmp`);
  try {
    await writeExclusive(temp, bytes);
    await stateFile(stateDir, name);
    await fs.rename(temp, target);
    await syncDirectory(stateDir);
  } finally { await fs.rm(temp, { force: true }); }
}
async function lock(stateDir) {
  const lockDir = path.join(stateDir, '.lock');
  try { await fs.mkdir(lockDir, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('State directory is locked. Do not steal locks; inspect the owner and resolve an abandoned lock before retrying.'); throw error; }
  const owner = { pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), token: randomUUID() };
  const identity = await fs.lstat(lockDir, { bigint: true });
  const sameDirectory = async () => {
    const current = await fs.lstat(lockDir, { bigint: true });
    return current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev &&
      current.ino === identity.ino && current.birthtimeNs === identity.birthtimeNs;
  };
  try { await writeExclusive(path.join(lockDir, 'owner.json'), serialize(owner)); }
  catch (error) {
    try { if (await sameDirectory()) await fs.rmdir(lockDir); } catch { /* Keep unfamiliar contents and the primary error. */ }
    throw error;
  }
  return async () => {
    try {
      if (!await sameDirectory()) return 'Lock directory ownership changed; inspect it before retrying.';
      const ownerPath = path.join(lockDir, 'owner.json');
      const ownerStat = await existsStat(ownerPath);
      if (ownerStat) {
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return 'Lock owner metadata changed; inspect it before retrying.';
        const current = await jsonFile(ownerPath);
        if (current.value?.token !== owner.token) return 'Lock owner token changed; inspect it before retrying.';
        if (!await sameDirectory()) return 'Lock directory ownership changed; inspect it before retrying.';
        await fs.unlink(ownerPath);
      }
      // Never recursively remove unexpected contents. If owner.json disappeared,
      // the captured directory identity still proves ownership of an empty lock.
      if (!await sameDirectory()) return 'Lock directory ownership changed; inspect it before retrying.';
      await fs.rmdir(lockDir);
      return null;
    } catch { return 'Lock cleanup could not safely finish; inspect the lock before retrying.'; }
  };
}
async function withLock(stateDir, operation) {
  const unlock = await lock(stateDir);
  let output, failure, failed = false;
  try { output = await operation(); }
  catch (error) { failure = error; failed = true; }
  const warning = await unlock();
  if (failed) {
    if (warning) {
      if (failure instanceof Error && Object.isExtensible(failure)) failure.cleanupWarnings = [warning];
      else console.error(warning);
    }
    throw failure;
  }
  return warning ? { ...output, warnings: (output.warnings ?? 0) + 1, cleanupWarnings: [warning] } : output;
}

function sourcesSchema(sources, { required = false, stored = false } = {}) {
  if (sources === undefined && !required) return [];
  if (!Array.isArray(sources) || (required && !sources.length) || sources.length > MAX_SOURCES) fail('Sources must be an explicit bounded list; derived files require at least one source.');
  const seen = new Set();
  return sources.map(source => {
    if (!source || !absolute(source.path) || !validHash(source[stored ? 'hash' : 'expectedHash'])) fail('Each source requires an absolute path and a SHA-256 fingerprint.');
    const sourcePath = path.resolve(source.path);
    if (seen.has(sourcePath)) fail('A source is repeated within one output mapping.');
    seen.add(sourcePath);
    return { path: sourcePath, expectedHash: source[stored ? 'hash' : 'expectedHash'] };
  });
}
function entriesSchema(entries, sources, headings) {
  if (entries === undefined) return [];
  if (!Array.isArray(entries) || entries.length > 1000) fail('Entry mappings must be a bounded list.');
  const sourceSet = new Set(sources.map(source => source.path));
  const headingSet = headings ? new Set(headings) : null;
  return entries.map(entry => {
    if (!entry || !regularString(entry.heading) || !Array.isArray(entry.sourcePaths) || entry.sourcePaths.length > MAX_SOURCES) fail('Entry mappings need a heading and explicit sourcePaths.');
    if (headingSet && !headingSet.has(entry.heading)) fail('An entry mapping does not match a proposed H2 heading.');
    const sourcePaths = entry.sourcePaths.map(sourcePath => {
      if (!absolute(sourcePath) || !sourceSet.has(path.resolve(sourcePath))) fail('Entry mappings may reference only that output’s selected sources.');
      return path.resolve(sourcePath);
    });
    return { heading: entry.heading, sourcePaths: [...new Set(sourcePaths)] };
  });
}
function manifestSchema(value, root) {
  if (value === null) return null;
  if (!value || value.version !== 1 || value.mode !== 'derived' || value.root !== root || !regularString(value.guideVersion) ||
    !Array.isArray(value.files) || value.files.length > MAX_FILES) fail('Invalid or incompatible derived manifest.');
  const seen = new Set();
  for (const file of value.files) {
    if (!file || !validHash(file.hash)) fail('Invalid derived output fingerprint.');
    relativeNote(file.path);
    if (seen.has(file.path)) fail('Manifest contains duplicate output paths.');
    seen.add(file.path);
    const sources = sourcesSchema(file.sources, { required: true, stored: true });
    entriesSchema(file.entries, sources);
  }
  return value;
}
function retireSchema(value = []) {
  if (!Array.isArray(value) || value.length > MAX_FILES) fail('Retirements must be an explicit bounded list.');
  const seen = new Set();
  return value.map(file => {
    if (!file || !validHash(file.expectedHash, true)) fail('Retirement needs path and inspected expectedHash (null for absence).');
    relativeNote(file.path);
    if (seen.has(file.path)) fail('Duplicate retirement paths are not allowed.');
    seen.add(file.path);
    return { path: file.path, expectedHash: file.expectedHash };
  });
}
async function retirementChecks(files, root, stateDir) {
  for (const file of files) {
    const target = await targetPath(root, file.path, stateDir, { allowMissingParents: file.expectedHash === null });
    if (await fingerprint(target) !== file.expectedHash) fail('A retired output changed since inspection; review its current state.');
  }
}
const sourceStamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
async function sourceChecks(files, outputPaths, proposalPaths = new Set(), { cache = new Map(), forceHash = true } = {}) {
  const checked = new Map();
  for (const file of files) for (const source of file.sources) {
    if (checked.has(source.path)) {
      if (checked.get(source.path) !== source.expectedHash) fail('Selected source fingerprints disagree.');
      continue;
    }
    checked.set(source.path, source.expectedHash);
    let canonical;
    try { canonical = await fs.realpath(source.path); }
    catch (error) { if (error.code === 'ENOENT') fail('A selected source is missing; inspect current evidence before continuing.'); throw error; }
    if (outputPaths.has(canonical) || proposalPaths.has(canonical)) fail('Source, proposal, and output paths must not overlap.');
    const before = sourceStamp(await fs.stat(canonical, { bigint: true }));
    const cached = cache.get(source.path);
    if (forceHash || cached?.canonical !== canonical || cached?.stamp !== before || cached?.hash !== source.expectedHash) {
      if (await fingerprint(source.path) !== source.expectedHash || sourceStamp(await fs.stat(canonical, { bigint: true })) !== before) fail('A selected source changed; inspect current evidence before continuing.');
      cache.set(source.path, { canonical, stamp: before, hash: source.expectedHash });
    }
  }
}
async function manifestHash(stateDir) {
  return fingerprint(await stateFile(stateDir, 'manifest.json'));
}
async function expectedManifest(stateDir, expected, desired = undefined) {
  const actual = await manifestHash(stateDir);
  if (actual !== expected && actual !== desired) fail('Derived manifest changed since inspection; prepare a current plan.');
}
function result(updated, manifestChanged, diagnostics = []) {
  return { status: updated.length || manifestChanged ? 'updated' : 'unchanged', updated, manifestChanged,
    warnings: diagnostics.filter(item => item.severity === 'warning').length, diagnostics: diagnostics.slice(0, 100), limitations: LIMITATIONS };
}

export async function applyPlan(plan, options = {}) {
  if (!plan || plan.version !== 1 || !['authored', 'derived'].includes(plan.mode) || !Array.isArray(plan.files) || plan.files.length > MAX_FILES) fail('Plan requires version 1, authored/derived mode, and at most 100 explicit files.');
  const retire = retireSchema(plan.retire);
  if ((!plan.files.length && !retire.length) || plan.files.length + retire.length > MAX_FILES) fail('Select 1–100 updates or retirements.');
  if (retire.length && plan.mode !== 'derived') fail('Only derived plans can retire tracked outputs.');
  if (options.afterReplace !== undefined && typeof options.afterReplace !== 'function') fail('afterReplace must be a function.');
  if (options.afterStage !== undefined && typeof options.afterStage !== 'function') fail('afterStage must be a function.');
  if (plan.mode === 'derived' && !validHash(plan.expectedManifestHash, true)) fail('Derived plans require an explicit expectedManifestHash (null for the initial manifest).');
  const root = await directory(plan.root);
  const selectedState = await directory(plan.stateDir, { allowMissing: true });
  for (const file of [...plan.files, ...retire]) {
    const target = path.join(root, relativeNote(file?.path));
    if (within(target, selectedState)) fail('State directory cannot be inside a note target.');
  }
  const stateDir = await directory(selectedState, { create: true });
  if (root === stateDir) fail('Use a separate private state directory, not the notes root itself.');
  return withLock(stateDir, async () => {
    if (await existsStat(await stateFile(stateDir, 'journal.json'))) fail('An interrupted update needs recovery before applying another plan.');
    const old = await jsonFile(await stateFile(stateDir, 'manifest.json'));
    const manifest = manifestSchema(old.value, root);
    if (plan.mode === 'authored' && manifest) fail('This state directory owns derived outputs; use the derived workflow or a separate authored notes collection with its own state.');
    if (plan.mode === 'derived' && old.hash !== plan.expectedManifestHash) fail('Derived manifest changed since inspection; prepare a current plan.');
    const retiring = new Set(retire.map(file => file.path));
    for (const file of retire) {
      const tracked = manifest?.files.find(entry => entry.path === file.path);
      if (!tracked || (file.expectedHash !== null && file.expectedHash !== tracked.hash)) fail('Retirement requires a tracked output at its last generated hash or confirmed absence.');
      if (plan.files.some(entry => entry.path === file.path)) fail('An output cannot be updated and retired in the same plan.');
    }
    await retirementChecks(retire, root, stateDir);
    const prepared = [];
    const outputPaths = new Set();
    const proposalPaths = new Set();
    const diagnostics = [];
    const allSections = [];
    for (const file of plan.files) {
      if (!file || !validHash(file.expectedHash, true) || !absolute(file.contentPath)) fail('Each file needs path, expectedHash (null for new), and an absolute contentPath.');
      const target = await targetPath(root, file.path, stateDir);
      if (outputPaths.has(target)) fail('Duplicate output targets are not allowed.');
      outputPaths.add(target);
      let proposal;
      try { proposal = await fs.realpath(file.contentPath); }
      catch (error) { if (error.code === 'ENOENT') fail('A selected proposal is missing.'); throw error; }
      if (proposalPaths.has(proposal)) fail('Each output needs its own selected proposal file.');
      proposalPaths.add(proposal);
      const bytes = await readBytes(proposal);
      if (!bytes) fail('A selected proposal is missing.');
      const checked = inspectMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(bytes), target);
      if (checked.diagnostics.some(item => item.severity === 'error')) fail('A proposed document fails the bundled Markdown check; run check-notes for bounded diagnostics.');
      diagnostics.push(...checked.diagnostics);
      allSections.push(...checked.sections);
      const currentHash = await fingerprint(target);
      if (currentHash !== file.expectedHash) fail('An output changed since inspection; preserve current edits and prepare a new plan.');
      if (plan.mode === 'derived') {
        const tracked = manifest?.files.find(entry => entry.path === file.path);
        if (tracked ? currentHash !== tracked.hash : currentHash !== null) fail('Derived output has manual changes or is an existing untracked file; do not overwrite it.');
      }
      const sources = sourcesSchema(file.sources, { required: plan.mode === 'derived' });
      const entries = entriesSchema(file.entries, sources, checked.sections.map(section => section.heading));
      const newHash = sha256(bytes);
      const metadata = currentHash !== newHash ? await replacementMetadata(target) : null;
      prepared.push({ path: file.path, target, oldHash: currentHash, newHash, metadata, bytes, sources, entries, stagePath: null });
    }
    for (const tracked of manifest?.files ?? []) if (!outputPaths.has(path.join(root, tracked.path))) {
      const target = await targetPath(root, tracked.path, stateDir, { allowMissingParents: retiring.has(tracked.path) });
      outputPaths.add(target);
      if (retiring.has(tracked.path)) continue;
      const bytes = await readBytes(target);
      if (!bytes) fail('A tracked collection output is missing; review the collection before refreshing.');
      const checked = inspectMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(bytes), target);
      if (checked.diagnostics.some(item => item.severity === 'error')) fail('A tracked collection document fails the bundled Markdown check.');
      diagnostics.push(...checked.diagnostics);
      allSections.push(...checked.sections);
    }
    for (const target of outputPaths) if (proposalPaths.has(target)) fail('Source, proposal, and output paths must not overlap.');
    await sourceChecks(prepared, outputPaths, proposalPaths);
    diagnostics.push(...reviewVocabulary(allSections));
    let proposedManifest = null;
    if (plan.mode === 'derived') {
      const records = new Map((manifest?.files ?? []).map(file => [file.path, file]));
      for (const file of retire) records.delete(file.path);
      for (const file of prepared) records.set(file.path, { path: file.path, hash: file.newHash,
        sources: file.sources.map(source => ({ path: source.path, hash: source.expectedHash })), entries: file.entries });
      if (records.size > MAX_FILES) fail('A managed collection can contain at most 100 tracked files.');
      proposedManifest = { version: 1, mode: 'derived', root, guideVersion: GUIDE_VERSION, files: [...records.values()].sort((a, b) => compare(a.path, b.path)) };
    }
    const proposedManifestHash = proposedManifest ? sha256(serialize(proposedManifest)) : null;
    const manifestChanged = plan.mode === 'derived' && proposedManifestHash !== old.hash;
    if (prepared.every(file => file.oldHash === file.newHash) && !manifestChanged) return result([], false, diagnostics);
    for (const file of prepared) if (file.oldHash !== file.newHash) {
      file.stagePath = path.join(path.dirname(file.target), `.cuefluent-stage-${randomUUID()}.tmp`);
    }
    const journal = { version: 1, phase: 'staging', mode: plan.mode, root, stateDir, guideVersion: GUIDE_VERSION,
      expectedManifestHash: plan.mode === 'derived' ? old.hash : null, previousManifest: manifest, proposedManifest, retire,
      files: prepared.map(({ path: relative, oldHash, newHash, metadata, sources, entries, stagePath }) => ({ path: relative, oldHash, newHash, metadata, sources, entries, stagePath })) };
    if (serialize(journal).length > MAX_BYTES) fail('Recovery journal exceeds 2 MiB.');
    await validateJournal(journal, stateDir);
    await preflight(journal, stateDir, { staging: true });
    // Reserve all stage names durably before writing any note content.
    await writeMetadata(stateDir, 'journal.json', journal);
    for (const file of prepared) if (file.stagePath) {
      await targetPath(root, file.path, stateDir);
      await writeExclusive(file.stagePath, file.bytes);
      await syncDirectory(path.dirname(file.stagePath));
      if (options.afterStage) await options.afterStage({ path: file.path, stagePath: file.stagePath });
    }
    journal.phase = 'ready';
    await writeMetadata(stateDir, 'journal.json', journal);
    const applied = await finishJournal(journal, stateDir, options);
    return { ...applied, warnings: diagnostics.filter(item => item.severity === 'warning').length, diagnostics: diagnostics.slice(0, 100) };
  });
}

async function validateJournal(value, stateDir) {
  if (!value || value.version !== 1 || !['authored', 'derived'].includes(value.mode) || value.stateDir !== stateDir ||
    !Array.isArray(value.files) || value.files.length > MAX_FILES || !validHash(value.expectedManifestHash, true) ||
    (value.phase !== undefined && !['staging', 'ready', 'aborting'].includes(value.phase))) fail('Invalid recovery journal.');
  const retire = retireSchema(value.retire);
  if ((!value.files.length && !retire.length) || value.files.length + retire.length > MAX_FILES) fail('Invalid recovery operation count.');
  const root = await directory(value.root);
  if (root !== value.root || root === stateDir) fail('Recovery root does not match its canonical directory.');
  const paths = new Set();
  for (const file of value.files) {
    if (!file || !validHash(file.oldHash, true) || !validHash(file.newHash)) fail('Invalid recovery fingerprints.');
    if (file.metadata !== undefined && file.metadata !== null && (!Number.isInteger(file.metadata.mode) || file.metadata.mode < 0 || file.metadata.mode > 0o7777 ||
      !Number.isSafeInteger(file.metadata.uid) || file.metadata.uid < 0 || !Number.isSafeInteger(file.metadata.gid) || file.metadata.gid < 0)) fail('Invalid recovery permission metadata.');
    const target = await targetPath(root, file.path, stateDir);
    if (paths.has(target)) fail('Recovery journal repeats an output.');
    paths.add(target);
    if (file.oldHash === file.newHash) {
      if (file.stagePath !== null) fail('Unchanged recovery entries must not contain staged files.');
    } else if (!absolute(file.stagePath) || path.dirname(file.stagePath) !== path.dirname(target) || !STAGE_NAME.test(path.basename(file.stagePath))) fail('Invalid staged file location.');
    const sources = sourcesSchema(file.sources, { required: value.mode === 'derived' });
    entriesSchema(file.entries, sources);
  }
  for (const file of retire) {
    const target = await targetPath(root, file.path, stateDir, { allowMissingParents: file.expectedHash === null });
    if (paths.has(target)) fail('Recovery cannot both retire and update an output.');
    paths.add(target);
  }
  if (value.previousManifest !== undefined) {
    manifestSchema(value.previousManifest, root);
  }
  if (value.mode === 'derived') {
    const manifest = manifestSchema(value.proposedManifest, root);
    if (!manifest) fail('Derived recovery needs a proposed manifest.');
    if (retire.some(file => manifest.files.some(entry => entry.path === file.path))) fail('Retired output remains in the proposed manifest.');
    for (const file of value.files) {
      const tracked = manifest.files.find(entry => entry.path === file.path);
      if (!tracked || tracked.hash !== file.newHash || JSON.stringify(tracked.sources) !== JSON.stringify(file.sources.map(source => ({ path: source.path, hash: source.expectedHash })))) fail('Recovery mappings do not agree with the proposed manifest.');
    }
  } else if (value.proposedManifest !== null || value.expectedManifestHash !== null || retire.length || value.previousManifest) fail('Authored recovery must not contain a derived manifest.');
  if (value.phase === 'aborting') validateAbort(value);
  return value;
}
function journalOutputPaths(journal) {
  return new Set([...journal.files, ...(journal.retire ?? []), ...(journal.previousManifest?.files ?? []),
    ...(journal.proposedManifest?.files ?? [])].map(file => path.join(journal.root, file.path)));
}
async function preflightFile(journal, file, stateDir, { staging = false } = {}) {
  const target = await targetPath(journal.root, file.path, stateDir);
  const current = await fingerprint(target);
  if (current !== file.oldHash && current !== file.newHash) fail('Recovery conflict: an output contains newer edits; preserve them and resolve the conflict.');
  await checkReplacementMetadata(file, target, current);
  if (file.stagePath && !staging) {
    const stat = await existsStat(file.stagePath);
    if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)) fail('Staged recovery content must be a regular file with a single hard link.');
    const stagedHash = stat ? await fingerprint(file.stagePath) : null;
    if ((current !== file.newHash && stagedHash === null) || (stagedHash !== null && stagedHash !== file.newHash)) fail('Recovery content is missing or changed; inspect the stages and use a reviewed abort before preparing a new plan.');
  }
  return { target, current };
}
async function preflight(journal, stateDir, { staging = false, cache } = {}) {
  await retirementChecks(journal.retire ?? [], journal.root, stateDir);
  await sourceChecks(journal.files, journalOutputPaths(journal), new Set(), { cache });
  if (journal.mode === 'derived') await expectedManifest(stateDir, journal.expectedManifestHash, sha256(serialize(journal.proposedManifest)));
  else if (await manifestHash(stateDir) !== null) fail('Authored recovery conflicts with derived state.');
  for (const file of journal.files) await preflightFile(journal, file, stateDir, { staging });
}
async function finishJournal(journal, stateDir, options) {
  // Recheck every file before resuming: a conflict later in the batch must not
  // permit an earlier untouched file to be replaced first.
  const cache = new Map();
  const paths = journalOutputPaths(journal);
  await preflight(journal, stateDir, { cache });
  const updated = [];
  for (const file of journal.files) {
    // Only this output and its evidence need checking here. Stable source
    // identities/timestamps reuse a hash from the full preflight; any metadata
    // change forces another bounded read. The final full pass hashes anew.
    await sourceChecks([file], paths, new Set(), { cache, forceHash: false });
    const { target, current } = await preflightFile(journal, file, stateDir);
    if (current === file.newHash) continue;
    await prepareStageMetadata(file, target);
    if (await fingerprint(file.stagePath) !== file.newHash) fail('Staged recovery content changed before replacement.');
    // Preserve the final output check adjacent to rename after metadata work.
    if (await fingerprint(target) !== file.oldHash) fail('Output changed before replacement.');
    await checkReplacementMetadata(file, target, file.oldHash);
    await fs.rename(file.stagePath, target);
    await syncDirectory(path.dirname(target));
    updated.push(file.path);
    if (options.afterReplace) await options.afterReplace({ path: file.path, target, index: updated.length - 1 });
  }
  await preflight(journal, stateDir);
  for (const file of journal.files) {
    const target = await targetPath(journal.root, file.path, stateDir);
    if (await fingerprint(target) !== file.newHash) fail('Final output changed after replacement; preserve the recovery journal and resolve the conflict.');
  }
  let manifestChanged = false;
  if (journal.mode === 'derived') {
    const desired = sha256(serialize(journal.proposedManifest));
    if (await manifestHash(stateDir) !== desired) {
      await expectedManifest(stateDir, journal.expectedManifestHash);
      await writeMetadata(stateDir, 'manifest.json', journal.proposedManifest);
      manifestChanged = true;
    }
  }
  for (const file of journal.files) if (file.stagePath && await existsStat(file.stagePath)) {
    if (await fingerprint(file.stagePath) !== file.newHash) fail('A remaining stage changed; inspect it before cleanup.');
    await fs.unlink(file.stagePath);
  }
  await fs.unlink(await stateFile(stateDir, 'journal.json'));
  await syncDirectory(stateDir);
  return { ...result(updated, manifestChanged), retired: (journal.retire ?? []).map(file => file.path) };
}

export async function recover(stateDirInput, options = {}) {
  if (options.afterReplace !== undefined && typeof options.afterReplace !== 'function') fail('afterReplace must be a function.');
  const stateDir = await directory(stateDirInput);
  return withLock(stateDir, async () => {
    const journal = await jsonFile(await stateFile(stateDir, 'journal.json'));
    if (journal.value === null) return result([], false);
    await validateJournal(journal.value, stateDir);
    return journal.value.phase === 'aborting' ? await finishAbort(journal.value, stateDir) : await finishJournal(journal.value, stateDir, options);
  });
}

// Partial stages can end in an incomplete UTF-8 sequence. Hash their exact
// bounded bytes for review/cleanup; never parse or promote them to a note.
async function stageHash(file) {
  const stat = await existsStat(file);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) fail('Stage must be a regular file.');
  const bytes = await readBoundedBytes(file, { missing: true, utf8: false });
  return bytes === null ? null : sha256(bytes);
}
function reviewedSet(items, paths, label) {
  if (!Array.isArray(items) || items.length !== paths.size) fail(`Abort must explicitly review every ${label}.`);
  const seen = new Set();
  for (const item of items) {
    if (!item || !paths.has(item.path) || seen.has(item.path) || !validHash(item.expectedHash, true)) fail(`Invalid reviewed abort ${label}.`);
    seen.add(item.path);
  }
}
function validateAbort(journal) {
  const abort = journal.abort;
  if (!abort || !validHash(abort.expectedManifestHash, true)) fail('Invalid abort journal.');
  reviewedSet(abort.files, new Set(journal.files.map(file => file.path)), 'output');
  reviewedSet(abort.stages, new Set(journal.files.flatMap(file => file.stagePath ? [file.stagePath] : [])), 'stage');
  for (const file of journal.files) {
    const reviewed = abort.files.find(item => item.path === file.path);
    if (reviewed.expectedHash !== file.oldHash && reviewed.expectedHash !== file.newHash) fail('Abort requires an output at its recorded old or new hash.');
  }
  if (journal.mode === 'derived') {
    if (!manifestSchema(abort.manifest, journal.root)) fail('Derived abort requires a reconciled manifest.');
  } else if (abort.manifest !== null || abort.expectedManifestHash !== null) fail('Authored abort must not contain a manifest.');
}
async function abortChecks(journal, stateDir) {
  for (const file of journal.abort.files) {
    const target = await targetPath(journal.root, file.path, stateDir);
    if (await fingerprint(target) !== file.expectedHash) fail('Abort output changed since review; preserve it and inspect again.');
  }
  for (const stage of journal.abort.stages) {
    const actual = await stageHash(stage.path);
    // A prior cleanup attempt may already have removed an approved stage.
    if (actual !== null && actual !== stage.expectedHash) fail('Abort stage changed since review; preserve it and inspect again.');
  }
  const desired = journal.abort.manifest ? sha256(serialize(journal.abort.manifest)) : null;
  await expectedManifest(stateDir, journal.abort.expectedManifestHash, desired);
}
async function finishAbort(journal, stateDir) {
  await abortChecks(journal, stateDir);
  let manifestChanged = false;
  if (journal.abort.manifest && await manifestHash(stateDir) !== sha256(serialize(journal.abort.manifest))) {
    await writeMetadata(stateDir, 'manifest.json', journal.abort.manifest);
    manifestChanged = true;
  }
  for (const stage of journal.abort.stages) {
    const current = await stageHash(stage.path);
    if (current === null) continue;
    if (current !== stage.expectedHash) fail('Abort stage changed before cleanup; preserve it and inspect again.');
    await fs.unlink(stage.path);
    await syncDirectory(path.dirname(stage.path));
  }
  await abortChecks(journal, stateDir);
  await fs.unlink(await stateFile(stateDir, 'journal.json'));
  await syncDirectory(stateDir);
  return { ...result([], manifestChanged), status: 'aborted', preserved: journal.abort.files.map(file => file.path) };
}

/** Cancel remaining replacements after explicit review, retaining completed bytes. */
export async function abortUpdate(plan) {
  if (!plan || plan.version !== 1 || !validHash(plan.expectedJournalHash) || !validHash(plan.expectedManifestHash, true)) fail('Abort needs version 1 and inspected journal and manifest hashes.');
  const stateDir = await directory(plan.stateDir);
  return withLock(stateDir, async () => {
    const pending = await jsonFile(await stateFile(stateDir, 'journal.json'));
    if (pending.hash !== plan.expectedJournalHash) fail('Recovery journal changed since inspection.');
    const journal = await validateJournal(pending.value, stateDir);
    if (journal.phase === 'aborting') fail('An approved abort is pending; use recover to finish it.');
    const current = await jsonFile(await stateFile(stateDir, 'manifest.json'));
    if (current.hash !== plan.expectedManifestHash) fail('Manifest changed since abort inspection.');
    await expectedManifest(stateDir, journal.expectedManifestHash, journal.proposedManifest ? sha256(serialize(journal.proposedManifest)) : null);
    reviewedSet(plan.files, new Set(journal.files.map(file => file.path)), 'output');
    reviewedSet(plan.stages, new Set(journal.files.flatMap(file => file.stagePath ? [file.stagePath] : [])), 'stage');
    const previous = journal.previousManifest ?? (current.hash === journal.expectedManifestHash ? current.value : null);
    let manifest = null;
    if (journal.mode === 'derived') {
      const records = new Map((previous?.files ?? []).map(file => [file.path, file]));
      for (const file of journal.files) {
        const reviewed = plan.files?.find(item => item.path === file.path);
        if (reviewed?.expectedHash === file.newHash) records.set(file.path, journal.proposedManifest.files.find(item => item.path === file.path));
        else if (previous === null && file.oldHash !== null) fail('The previous manifest is unavailable for this legacy journal; preserve it for manual reconciliation.');
      }
      manifest = { version: 1, mode: 'derived', root: journal.root, guideVersion: GUIDE_VERSION, files: [...records.values()].sort((a, b) => compare(a.path, b.path)) };
    }
    journal.phase = 'aborting';
    journal.abort = { files: plan.files, stages: plan.stages, expectedManifestHash: current.hash, manifest };
    validateAbort(journal);
    await abortChecks(journal, stateDir);
    // Persist the reviewed cleanup and reconciliation before any mutation;
    // recover resumes this phase without reusing stale source evidence.
    await writeMetadata(stateDir, 'journal.json', journal);
    return await finishAbort(journal, stateDir);
  });
}

export async function inspectState(stateDirInput) {
  const stateDir = await directory(stateDirInput, { allowMissing: true });
  if (!await existsStat(stateDir)) return { manifestHash: null, journalHash: null, recoveryPending: false, locked: false, outputs: [], sources: [], stages: [], pendingOutputs: [], limitations: LIMITATIONS };
  const manifestData = await jsonFile(await stateFile(stateDir, 'manifest.json'));
  const journalData = await jsonFile(await stateFile(stateDir, 'journal.json'));
  const journal = journalData.value ? await validateJournal(journalData.value, stateDir) : null;
  const manifest = manifestData.value ? manifestSchema(manifestData.value, await directory(manifestData.value.root)) : null;
  if (manifest && journal && manifest.root !== journal.root) fail('Manifest and recovery journal roots disagree.');
  const root = manifest?.root ?? journal?.root;
  const records = new Map((manifest?.files ?? []).map(file => [file.path,
    { path: file.path, expectedHash: file.hash, sources: sourcesSchema(file.sources, { stored: true, required: true }) }]));
  for (const file of journal?.files ?? []) records.set(file.path,
    { path: file.path, expectedHash: file.oldHash, sources: file.sources });
  const outputs = [];
  const sources = [];
  const sourceExpectations = new Map();
  for (const file of records.values()) {
    const target = path.join(root, file.path);
    try {
      await targetPath(root, file.path, stateDir);
      const current = await fingerprint(target);
      outputs.push({ path: target, hash: current, status: current === null ? 'missing' : current === file.expectedHash ? 'unchanged' : 'changed' });
    } catch { outputs.push({ path: target, status: 'changed', issue: 'Output is not a readable regular file within the selected root.' }); }
    for (const source of file.sources) {
      if (!sourceExpectations.has(source.path)) sourceExpectations.set(source.path, []);
      sourceExpectations.get(source.path).push({ hash: source.expectedHash, output: file.path });
    }
  }
  for (const [sourcePath, expectations] of sourceExpectations) {
    try {
      const current = await fingerprint(sourcePath);
      const affectedOutputs = [...new Set(expectations.filter(item => item.hash !== current).map(item => item.output))];
      sources.push({ path: sourcePath, status: current === null ? 'missing' : affectedOutputs.length ? 'changed' : 'unchanged', affectedOutputs });
    } catch {
      sources.push({ path: sourcePath, status: 'changed', affectedOutputs: [...new Set(expectations.map(item => item.output))], issue: 'Source is not a readable regular UTF-8 file.' });
    }
  }
  const lockDir = path.join(stateDir, '.lock');
  const lockStat = await existsStat(lockDir);
  let owner;
  if (lockStat?.isDirectory() && !lockStat.isSymbolicLink()) {
    try {
      const value = (await jsonFile(path.join(lockDir, 'owner.json'))).value;
      if (value && Number.isSafeInteger(value.pid) && regularString(value.hostname) && regularString(value.createdAt)) owner = { pid: value.pid, hostname: value.hostname, createdAt: value.createdAt };
    } catch { /* A lock remains held even when its owner metadata cannot be read. */ }
  }
  const stages = [];
  for (const file of journal?.files ?? []) if (file.stagePath) {
    try { stages.push({ path: file.stagePath, hash: await stageHash(file.stagePath) }); }
    catch { stages.push({ path: file.stagePath, issue: 'Stage is not a readable bounded regular file.' }); }
  }
  const pendingOutputs = [];
  for (const file of journal?.files ?? []) {
    const output = outputs.find(item => item.path === path.join(root, file.path));
    pendingOutputs.push({ path: file.path, hash: output.hash, oldHash: file.oldHash, newHash: file.newHash, ...(output.issue ? { issue: output.issue } : {}) });
  }
  return { manifestHash: manifestData.hash, journalHash: journalData.hash, phase: journal?.phase ?? (journal ? 'ready' : null), stages, pendingOutputs, recoveryPending: Boolean(journal), locked: Boolean(lockStat), ...(owner ? { owner } : {}), outputs, sources, limitations: LIMITATIONS };
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/safe-update.mjs apply plan.json | abort abort-plan.json | recover stateDir | inspect stateDir | fingerprint file...\nLocal reviewed proposals only. Private state and output directories required. Retirement removes tracking only; abort preserves note bytes.');
    return 0;
  }
  const [command, ...inputs] = args;
  let output;
  if (command === 'fingerprint' && inputs.length && inputs.length <= MAX_SOURCES) {
    output = { files: [] };
    for (const input of inputs) { const file = path.resolve(input); output.files.push({ path: file, hash: await fingerprint(file) }); }
  } else if (command === 'apply' && inputs.length === 1) {
    const plan = await jsonFile(path.resolve(inputs[0]));
    if (plan.value === null) fail('Plan file is missing.');
    output = await applyPlan(plan.value);
  } else if (command === 'abort' && inputs.length === 1) {
    const plan = await jsonFile(path.resolve(inputs[0]));
    output = await abortUpdate(plan.value);
  } else if (command === 'recover' && inputs.length === 1) output = await recover(path.resolve(inputs[0]));
  else if (command === 'inspect' && inputs.length === 1) output = await inspectState(path.resolve(inputs[0]));
  else fail('Unknown or incomplete operation; use --help.');
  console.log(JSON.stringify(output, null, 2));
  return 0;
}
if (await isMain(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    console.error(`Safe update failed: ${String(error.message).slice(0, 500)}`);
    for (const warning of error.cleanupWarnings ?? []) console.error(warning);
    process.exitCode = 2;
  }
}
