import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { SEMVER_VERSION_PATTERN } from '../core/version.mjs';
import { createProject, emptySettings, validateSettings } from '../core/settings.mjs';
import { validateNotePublication } from '../core/note-publication.mjs';
import { checkStorePlacement, initializeStore, openStore, readSettings, updateSettings, withWriter, gateOptions } from '../storage/store.mjs';
import { withShortGate } from '../storage/gates.mjs';
import { readJSON, writeJSON, removeExact, syncDirectory } from '../storage/files.mjs';
import { assertAbsolute, assertChain, inspectAncestors, lstatOrNull, pinDirectory } from '../storage/paths.mjs';
import { establishActivityLogSeries, inspectActivityLogSeries, logYear } from '../logs/storage.mjs';
import { logDiagnostic } from '../logs/index.mjs';

const JOURNAL = 'config/setup.json';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const requireSetup = (condition, code = 'SETUP_INTENT_INVALID') => { if (!condition) fail(code, 'The setup intent does not match the exact inspected project, settings, or paths.'); };
const settingsWith = (settings, project) => validateSettings({ schemaVersion: settings.schemaVersion, projects: settings.projects.some(item => item.id === project.id)
  ? settings.projects.map(item => item.id === project.id ? project : item) : [...settings.projects, project] });
const notesRoot = project => project.destination.kind === 'directory' ? project.destination.path : path.dirname(project.destination.path);
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'LOG_INSPECTION_FAILED';

function chainValue(value, root) {
  requireSetup(Array.isArray(value) && value.length > 0 && value.length <= 128);
  let last;
  return Object.freeze(value.map((item, index) => {
    requireSetup(item && equal(Object.keys(item).sort(), ['device', 'inode', 'path']) && typeof item.path === 'string' && !/[\u0000-\u001f\u007f]/.test(item.path) && path.isAbsolute(item.path) &&
      path.normalize(item.path) === item.path && typeof item.device === 'string' && /^\d{1,30}$/.test(item.device) && typeof item.inode === 'string' && /^\d{1,30}$/.test(item.inode));
    requireSetup(index === 0 ? item.path === path.parse(root).root : path.dirname(item.path) === last);
    const relative = path.relative(item.path, root); requireSetup(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    last = item.path; return Object.freeze({ path: item.path, device: item.device, inode: item.inode });
  }));
}

function logReport(input, request) {
  const expectedPath = request.destination.kind === 'directory' ? path.join(request.destination.path, 'logs') : null;
  requireSetup(input && input.path === expectedPath && typeof input.status === 'string');
  const fields = input.status === 'valid' ? ['path', 'seriesId', 'status', 'timezone', 'unrelatedEntries', 'years'] : input.status === 'problem' ? [...(Object.hasOwn(input, 'location') ? ['location'] : []), 'path', 'status', 'warning'] : ['path', 'status'];
  requireSetup(equal(Object.keys(input).sort(), fields));
  requireSetup(request.destination.kind === 'file' ? input.status === 'not-applicable' : ['absent', 'empty', 'valid', 'problem'].includes(input.status));
  if (input.status === 'problem') requireSetup(typeof input.warning === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(input.warning));
  if (Object.hasOwn(input, 'location')) requireSetup(input.location && equal(input.location, logDiagnostic({ code: input.warning, ...input.location })));
  if (input.status === 'valid') {
    requireSetup(Number.isSafeInteger(input.unrelatedEntries) && input.unrelatedEntries >= 0 && input.unrelatedEntries <= 4096 &&
      typeof input.seriesId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.seriesId) &&
      typeof input.timezone === 'string' && input.timezone.length <= 128 && input.timezone.trim() === input.timezone && !/^[+-]|\p{Cc}/u.test(input.timezone) &&
      Array.isArray(input.years) && input.years.length > 0 && input.years.length <= 256 && input.years.every((year, index) => Number.isInteger(year) && year >= 1000 && year <= 9999 && (index === 0 || year > input.years[index - 1])));
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { requireSetup(false); }
  }
  return Object.freeze({ ...input, ...(input.status === 'valid' ? { years: Object.freeze([...input.years]) } : {}) });
}

function validateIntent(input) {
  requireSetup(input && equal(Object.keys(input).sort(), ['createdAt', 'expectedHash', 'id', 'logParent', 'logs', 'noteId', 'notesParent', 'proposed', 'publication', 'request', 'schema', 'seriesId', 'skillVersion'].sort()));
  requireSetup(input.schema === 1 && UUID.test(input.id) && UUID.test(input.noteId) && UUID.test(input.seriesId) && HASH.test(input.expectedHash) &&
    typeof input.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.createdAt) && Number.isFinite(Date.parse(input.createdAt)) && new Date(input.createdAt).toISOString() === input.createdAt &&
    typeof input.skillVersion === 'string' && input.skillVersion.length <= 256 && SEMVER_VERSION_PATTERN.test(input.skillVersion));
  const request = validateSettings({ schemaVersion: 1, projects: [input.request] }).projects[0], proposed = validateSettings(input.proposed), configured = proposed.projects.find(item => item.id === request.id);
  requireSetup(configured && configured.activityLog.enabled === request.activityLog.enabled && equal({ ...configured, activityLog: request.activityLog }, request));
  const root = notesRoot(request), notesParent = chainValue(input.notesParent, root);
  const logParent = input.logParent === null ? null : chainValue(input.logParent, path.join(root, 'logs'));
  requireSetup(logParent === null || (request.destination.kind === 'directory' && logParent.at(-1).path === path.join(root, 'logs')));
  if (logParent) requireSetup(notesParent.at(-1).path === root && logParent.length === notesParent.length + 1 && notesParent.every((item, index) => equal(item, logParent[index])));
  const publication = input.publication === null ? null : validateNotePublication(input.publication);
  if (publication) requireSetup(request.activityLog.enabled && publication.root === root && publication.runId === input.id && publication.draftId === input.noteId && publication.expectedHash === null &&
    publication.relative === `logs/${logYear(input.createdAt, request.activityLog.timezone)}.md` && equal(publication.parent, logParent));
  const logs = input.logs === null ? null : logReport(input.logs, request);
  if (logs && request.activityLog.enabled) requireSetup(logs.status === 'valid' && logs.timezone === configured.activityLog.timezone && logParent);
  return Object.freeze({ ...input, request, proposed, notesParent, logParent, publication, logs });
}

async function ensureDirectory(root, inspected, persistChain) {
  await assertChain(inspected);
  let chain = inspected;
  const remaining = path.relative(chain.at(-1).path, root).split(path.sep).filter(Boolean);
  for (const segment of remaining) {
    const parent = chain.at(-1).path, next = path.join(parent, segment);
    await assertChain(chain);
    try { await fs.mkdir(next, { mode: 0o777 }); await syncDirectory(parent); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const nextChain = await inspectAncestors(next); await assertChain(chain);
    requireSetup(chain.every((item, index) => equal(item, nextChain[index])), 'SETUP_PATH_CHANGED');
    chain = nextChain; await persistChain(chain);
  }
  await assertChain(chain); requireSetup(chain.at(-1).path === root, 'SETUP_PATH_CHANGED');
  return pinDirectory(root);
}

async function inspectLogs(project) {
  const root = notesRoot(project), logPath = path.join(root, 'logs');
  if (project.destination.kind === 'file') return Object.freeze({ path: null, status: 'not-applicable' });
  if (!await lstatOrNull(logPath)) return Object.freeze({ path: logPath, status: 'absent' });
  try {
    const result = await inspectActivityLogSeries(project.destination);
    return Object.freeze({ path: logPath, status: 'valid', seriesId: result.binding.seriesId, timezone: result.binding.timezone, years: result.years, unrelatedEntries: result.unrelatedEntries });
  } catch (error) {
    if (error.code === 'LOG_SERIES_MISSING') return Object.freeze({ path: logPath, status: 'empty' });
    const location = logDiagnostic(error);
    return Object.freeze({ path: logPath, status: 'problem', warning: codeOf(error), ...(location ? { location } : {}) });
  }
}

/** The exact request of an interrupted setup, if its journal is retained,
 * whether its settings are already published (so only the journal removal
 * remains), and the settings hash observed with it. A caller that repeats the
 * request under that same hash completes that setup; a concurrent change in
 * between is a conflict, never a replay. Nothing else is disclosed. */
export async function readPendingSetup(store) {
  return withShortGate(store.settingsGate, gateOptions, async () => {
    const pending = await readJSON(store.pin, JOURNAL, { missing: true });
    if (!pending) return null;
    const intent = validateIntent(pending.value), current = await readSettings(store);
    return Object.freeze({ request: intent.request, published: equal(current.value, intent.proposed) && intent.logs !== null, settingsHash: current.hash });
  });
}

/** Explicit setup only. expectedHash is the complete settings hash inspected by
 * the caller, or null for an absent store. This function configures no hooks,
 * native clients, authentication, or conversation collection. */
export async function setupProject({ storeRoot, project: input, expectedHash, skillVersion, now = new Date().toISOString() } = {}) {
  assertAbsolute(storeRoot);
  requireSetup(expectedHash === null || (typeof expectedHash === 'string' && HASH.test(expectedHash)), 'EXPECTED_HASH_REQUIRED');
  requireSetup(typeof skillVersion === 'string' && skillVersion.length <= 256 && SEMVER_VERSION_PATTERN.test(skillVersion) && typeof now === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now) && Number.isFinite(Date.parse(now)) && new Date(now).toISOString() === now, 'SETUP_ARGUMENT');
  const request = createProject(input);
  // Validate overlap, repositories, and every existing ancestor before even the
  // fresh private store is created. No enabled project is published by init.
  await checkStorePlacement(storeRoot, settingsWith(emptySettings(), request));
  // Missing metadata may resume only the initializer's verified empty scaffold.
  // A retained store never authorizes recreating its layout or settings.
  const initializing = !await lstatOrNull(path.join(storeRoot, 'store/layout.json')) || !await lstatOrNull(path.join(storeRoot, 'config/settings.json'));
  if (initializing) requireSetup(expectedHash === null, 'SETTINGS_CONFLICT');
  const store = initializing ? await initializeStore(storeRoot) : await openStore(storeRoot);
  const inspected = await readSettings(store);
  if (!initializing) {
    // A crash after settings publication may leave only its private setup
    // journal. Equality proves completion; it never refreshes a stale CAS.
    const completed = await withShortGate(store.settingsGate, gateOptions, async () => {
      const pending = await readJSON(store.pin, JOURNAL, { missing: true }); if (!pending) return null;
      const intent = validateIntent(pending.value), current = await readSettings(store);
      requireSetup(equal(intent.request, request), 'SETUP_PENDING');
      if (!equal(current.value, intent.proposed) || intent.logs === null) return null;
      await removeExact(store.pin, JOURNAL, pending.hash);
      return Object.freeze({ status: 'configured', project: current.value.projects.find(item => item.id === request.id), settingsHash: current.hash, logs: intent.logs, recovered: true });
    });
    if (completed) return completed;
  }
  const comparedHash = initializing ? inspected.hash : expectedHash;
  requireSetup(inspected.hash === comparedHash, 'SETTINGS_CONFLICT');
  const proposed = settingsWith(inspected.value, request);
  await checkStorePlacement(storeRoot, proposed);
  let intent, intentHash, resultProject, logs;
  const saveIntent = async next => {
    const checked = validateIntent(next), written = await writeJSON(store.pin, JOURNAL, checked, { expectedHash: intentHash });
    intent = checked; intentHash = written.hash; return checked;
  };
  const result = await updateSettings(store, proposed, { expectedHash: comparedHash, beforePublish: async context => withWriter(store, async () => {
    const pending = await readJSON(store.pin, JOURNAL, { missing: true });
    if (pending) {
      intent = validateIntent(pending.value); intentHash = pending.hash;
      requireSetup(equal(intent.request, request) && intent.expectedHash === context.hash &&
        equal(settingsWith(intent.proposed, request), context.next), 'SETUP_PENDING');
    } else {
      // A normal inspection rejection owns no public stage and needs no retry
      // journal. A previously interrupted exact journal is never reset here.
      logs = await inspectLogs(request);
      if (request.activityLog.enabled && logs.status === 'problem') fail(logs.warning, 'The existing activity log was preserved; repair its reported series/layout problem before enabling logging.');
      intentHash = null;
      await saveIntent({ schema: 1, id: randomUUID(), expectedHash: context.hash, request, proposed: context.next, createdAt: now, skillVersion,
        seriesId: randomUUID(), noteId: randomUUID(), notesParent: await inspectAncestors(notesRoot(request), { allowMissing: true }), logParent: null, publication: null, logs: null });
    }
    const pin = await ensureDirectory(notesRoot(request), intent.notesParent, notesParent => saveIntent({ ...intent, notesParent }));
    if (intent.logParent) await assertChain(intent.logParent);
    if (!intent.publication && !logs) {
      logs = await inspectLogs(request);
      if (request.activityLog.enabled && logs.status === 'problem') fail(logs.warning, 'The existing activity log was preserved; repair its reported series/layout problem before enabling logging.');
    }
    resultProject = request;
    if (request.activityLog.enabled) {
      const binding = await establishActivityLogSeries(pin, { year: logYear(intent.createdAt, request.activityLog.timezone), timezone: request.activityLog.timezone,
        seriesId: intent.seriesId, noteId: intent.noteId, createdAt: intent.createdAt, skillVersion: intent.skillVersion, expandedMetadata: request.expandedMetadata, runId: intent.id, publication: intent.publication,
        persistIntent: publication => saveIntent({ ...intent, logParent: publication.parent, publication }) });
      resultProject = createProject({ ...request, activityLog: { ...request.activityLog, timezone: binding.timezone } });
      const inspected = await inspectActivityLogSeries(request.destination);
      logs = Object.freeze({ path: request.activityLog.path, status: 'valid', seriesId: binding.seriesId, timezone: binding.timezone,
        years: inspected.years, unrelatedEntries: inspected.unrelatedEntries });
      await saveIntent({ ...intent, logParent: binding.parent, proposed: settingsWith(context.next, resultProject), logs });
    } else await saveIntent({ ...intent, logs });
    return intent.proposed;
  }) });
  // The successful exact settings receipt authorizes removing only this exact
  // setup journal. A crash here is completed by the equality path above.
  await withShortGate(store.settingsGate, gateOptions, () => removeExact(store.pin, JOURNAL, intentHash));
  return Object.freeze({ status: 'configured', project: resultProject, settingsHash: result.hash, logs, recovered: false });
}
