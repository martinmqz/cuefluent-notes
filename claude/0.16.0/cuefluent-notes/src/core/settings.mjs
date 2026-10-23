import path from 'node:path';

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_LIMITS = Object.freeze({ projects: 1024, pathBytes: 32768, idLength: 128, timezoneLength: 128 });

const PROJECT_FIELDS = ['id', 'root', 'destination', 'tracking', 'saving', 'activityLog'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function invalid(message) {
  fail('SETTINGS_INVALID', message);
}

function record(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object`);
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable) {
      invalid(`${label} contains an unsupported field`);
    }
  }
  for (const key of required) if (!Object.hasOwn(fields, key)) invalid(`${label}.${key} is required`);
}

function platformPaths(platform = process.platform) {
  if (platform === 'win32') return path.win32;
  if (['posix', 'darwin', 'linux', 'freebsd', 'openbsd', 'sunos', 'aix', 'android', 'netbsd'].includes(platform)) return path.posix;
  invalid('Unsupported path platform');
}

function projectId(value) {
  if (typeof value !== 'string' || value.length > SETTINGS_LIMITS.idLength || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    invalid('Project IDs must contain letters, numbers, underscores or hyphens and start with a letter or number');
  }
  return value;
}

// These are lexical checks only. Callers must establish real paths, filesystem
// identity, permissions and link safety before admitting or using settings.
function canonicalPath(value, paths, label) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > SETTINGS_LIMITS.pathBytes || /[\u0000-\u001f\u007f]/.test(value) ||
      !paths.isAbsolute(value) || paths.normalize(value) !== value ||
      (value.endsWith(paths.sep) && value !== paths.parse(value).root)) invalid(`${label} must be a canonical absolute path`);
  if (paths === path.win32) {
    if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(value) || /^\\\\[?.]\\/.test(value)) {
      invalid(`${label} must use an absolute drive or UNC path`);
    }
    const segments = value.replace(/^[A-Za-z]:\\/, '').split('\\').filter(Boolean);
    if (segments.some(segment => /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))) {
      invalid(`${label} contains a reserved Windows path segment`);
    }
  }
  return value;
}

function pathKey(value, paths) {
  return paths === path.win32 ? value.toLowerCase() : value;
}

function destination(value, paths) {
  record(value, ['kind', 'path'], ['kind', 'path'], 'destination');
  if (!['directory', 'file'].includes(value.kind)) invalid('destination.kind must be directory or file');
  const target = canonicalPath(value.path, paths, 'destination.path');
  if (value.kind === 'file' && paths.extname(target).toLowerCase() !== '.md') invalid('A file destination must name a Markdown .md file');
  return Object.freeze({ kind: value.kind, path: target });
}

function activityLog(value, target, paths, defaults) {
  record(value, ['enabled', 'timezone', 'path'], ['enabled'], 'activityLog');
  if (typeof value.enabled !== 'boolean') invalid('activityLog.enabled must be a boolean');
  if (!value.enabled) {
    if (Object.hasOwn(value, 'timezone') || Object.hasOwn(value, 'path')) invalid('Disabled activity logging cannot specify a timezone or path');
    return Object.freeze({ enabled: false });
  }
  if (typeof value.timezone !== 'string' || !value.timezone || value.timezone.length > SETTINGS_LIMITS.timezoneLength ||
      !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(value.timezone)) invalid('Enabled activity logging requires an IANA timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); }
  catch { invalid('Enabled activity logging requires an IANA timezone'); }
  if (target.kind !== 'directory') invalid('Activity logging requires a directory destination');
  const logPath = paths.join(target.path, 'logs');
  if ((!defaults || Object.hasOwn(value, 'path')) && value.path !== logPath) invalid('Activity logging must record its exact reserved logs path');
  return Object.freeze({ enabled: true, timezone: value.timezone, path: logPath });
}

function validateProject(input, paths, defaults = false) {
  record(input, PROJECT_FIELDS, defaults ? ['id', 'root', 'destination'] : PROJECT_FIELDS, 'project');
  const tracking = Object.hasOwn(input, 'tracking') ? input.tracking : 'manual';
  const saving = Object.hasOwn(input, 'saving') ? input.saving : 'review';
  if (!['manual', 'auto'].includes(tracking)) invalid('tracking must be manual or auto');
  if (!['review', 'auto'].includes(saving)) invalid('saving must be review or auto');
  const target = destination(input.destination, paths);
  const logging = activityLog(Object.hasOwn(input, 'activityLog') ? input.activityLog : { enabled: false }, target, paths, defaults);
  if (target.kind === 'file' && logging.enabled) invalid('Activity logging requires a directory destination');
  return Object.freeze({ id: projectId(input.id), root: canonicalPath(input.root, paths, 'project.root'),
    destination: target, tracking, saving, activityLog: logging });
}

/** Fresh settings enable no tracking, saving or logging. This function performs no I/O. */
export function emptySettings() {
  return Object.freeze({ schemaVersion: SETTINGS_SCHEMA_VERSION, projects: Object.freeze([]) });
}

/** Supply independent defaults only while explicitly creating a project. */
export function createProject(input, { platform } = {}) {
  return validateProject(input, platformPaths(platform), true);
}

/** Validate the complete schema and return a detached, deeply frozen snapshot. */
export function validateSettings(input, { platform } = {}) {
  record(input, ['schemaVersion', 'projects'], ['schemaVersion', 'projects'], 'settings');
  if (input.schemaVersion !== SETTINGS_SCHEMA_VERSION) fail('SETTINGS_SCHEMA_UNSUPPORTED', 'Unsupported settings schema version');
  if (!Array.isArray(input.projects) || input.projects.length > SETTINGS_LIMITS.projects) invalid('projects must be a bounded array');
  const fields = Object.getOwnPropertyDescriptors(input.projects);
  if (Reflect.ownKeys(fields).length !== input.projects.length + 1) invalid('projects must be a dense array without extra fields');
  const paths = platformPaths(platform), ids = new Set(), roots = new Set(), projects = [];
  for (let i = 0; i < input.projects.length; i++) {
    if (!Object.hasOwn(fields, i) || !Object.hasOwn(fields[i], 'value') || !fields[i].enumerable) invalid('projects must be a dense data array');
    const project = validateProject(fields[i].value, paths), root = pathKey(project.root, paths);
    if (ids.has(project.id)) invalid('Duplicate project ID');
    if (roots.has(root)) invalid('Duplicate project root');
    ids.add(project.id); roots.add(root); projects.push(project);
  }
  return Object.freeze({ schemaVersion: SETTINGS_SCHEMA_VERSION, projects: Object.freeze(projects) });
}

/** Only first bindings use cwd. A retained owner remains stable across nesting or cwd changes. */
export function chooseProject(settings, canonicalCwd, { existingOwnerId, platform } = {}) {
  const checked = validateSettings(settings, { platform }), paths = platformPaths(platform);
  const cwd = pathKey(canonicalPath(canonicalCwd, paths, 'cwd'), paths);
  if (existingOwnerId !== undefined) {
    const id = projectId(existingOwnerId), owner = checked.projects.find(project => project.id === id);
    if (!owner) fail('PROJECT_OWNER_MISSING', 'The retained project owner is no longer configured');
    return owner;
  }
  let nearest = null;
  for (const project of checked.projects) {
    const root = pathKey(project.root, paths), prefix = root.endsWith(paths.sep) ? root : `${root}${paths.sep}`;
    if ((cwd === root || cwd.startsWith(prefix)) && (!nearest || root.length > nearest.root.length)) nearest = project;
  }
  return nearest;
}

function retainedIds(value, label) {
  if (!Array.isArray(value) && !(value instanceof Set)) invalid(`${label} must be an array or Set of project IDs`);
  if (value.length > SETTINGS_LIMITS.projects || value.size > SETTINGS_LIMITS.projects) invalid(`${label} exceeds the project limit`);
  const ids = new Set();
  for (const entry of value) ids.add(projectId(entry));
  return ids;
}

/** Call under the settings/store mutation lock using current retained-work facts.
 * Pending runs pin destination/saving/logging; logging changes apply to later runs.
 * This validates policy only and does not publish settings or update chat state.
 */
export function assertSettingsChange(current, next, { retainedProjectIds = [], pendingRuns = [], platform } = {}) {
  const before = validateSettings(current, { platform }), after = validateSettings(next, { platform }), paths = platformPaths(platform);
  const retained = retainedIds(retainedProjectIds, 'retainedProjectIds'), pending = retainedIds(pendingRuns, 'pendingRuns');
  for (const id of pending) retained.add(id);
  const oldProjects = new Map(before.projects.map(project => [project.id, project]));
  const newProjects = new Map(after.projects.map(project => [project.id, project]));
  for (const id of retained) {
    const oldProject = oldProjects.get(id), newProject = newProjects.get(id);
    if (!oldProject) fail('PROJECT_OWNER_MISSING', 'Retained work refers to an unconfigured project');
    if (!newProject || pathKey(oldProject.root, paths) !== pathKey(newProject.root, paths)) {
      fail('SETTINGS_RETAINED_PROJECT', 'Settings cannot remove or reassign a project with retained work');
    }
    if (pending.has(id) && (oldProject.saving !== newProject.saving || oldProject.destination.kind !== newProject.destination.kind ||
        pathKey(oldProject.destination.path, paths) !== pathKey(newProject.destination.path, paths))) {
      fail('SETTINGS_PENDING_RUN', 'Settle the pending run before changing its destination or saving mode');
    }
  }
  return after;
}
