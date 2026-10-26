import path from 'node:path';
import { fail } from '../core/errors.mjs';
import { packageVersion } from '../core/version.mjs';
import { SETTINGS_LIMITS } from '../core/settings.mjs';
import { readSettings } from '../storage/store.mjs';
import { assertAbsolute } from '../storage/paths.mjs';
import { fields, freezeData } from '../client/control-server.mjs';
import { setupProject, readPendingSetup } from './setup.mjs';
import { readProjectStatus } from './status.mjs';

const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$';
const PROJECT_ID = new RegExp(ID_PATTERN);
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const definition = (name, description, inputSchema, readOnlyHint = false) => ({ name, description, inputSchema,
  annotations: { readOnlyHint, idempotentHint: true, openWorldHint: false } });
const pathRule = description => ({ type: 'string', minLength: 1, maxLength: SETTINGS_LIMITS.pathBytes, description });

export const PROJECT_TOOLS = freezeData([
  definition('cuefluent_setup', 'Set up or change one Cuefluent Notes project: its project root, note destination, tracking, saving and activity logging. ' +
    'Call cuefluent_projects first, and agree every choice with the user before calling; installation, hook trust, discussing setup or reading notes is not consent. ' +
    'A new project needs root (the absolute project folder) and destination ({ kind: "directory" | "file", path }, absolute; a file is a Markdown .md file). ' +
    'Without id, a new project takes an id derived from the root folder name. For a new project, omitted tracking is manual, saving is review, and activityLog is on with the system timezone for a directory destination and off for a file destination. ' +
    'An existing project is selected by id or by its exact root, and only the supplied fields change; omitted fields keep their current values, including a logging opt-out and an established timezone. ' +
    'activityLog is { enabled, timezone? }, and a timezone needs enabled true. A pending run pins its destination and saving mode, and a project with retained chats or work cannot move to another root. ' +
    'Creates the private store on first use. Changes no hook, client authentication or chat tracking.',
    schema({
      id: { type: 'string', pattern: ID_PATTERN, description: 'Existing project id to change, or the id for a new project. Omit to derive it from the root folder name.' },
      root: pathRule('Absolute, normalized project root. Selects an existing project by exact match; required for a new project.'),
      destination: { ...schema({ kind: { type: 'string', enum: ['directory', 'file'] }, path: pathRule('Absolute, normalized notes folder, or an absolute .md file for kind file.') }),
        description: 'The note destination. Required for a new project.' },
      tracking: { type: 'string', enum: ['manual', 'auto'] },
      saving: { type: 'string', enum: ['review', 'auto'] },
      activityLog: { ...schema({ enabled: { type: 'boolean' }, timezone: { type: 'string', minLength: 1, maxLength: SETTINGS_LIMITS.timezoneLength, description: 'IANA timezone; only with enabled true. An established log series keeps its recorded timezone.' } }, ['enabled']),
        description: 'Activity logging, directory destinations only. Its reserved logs path is derived from the destination.' },
    }, [])),
  definition('cuefluent_status', 'Read the status of one configured project: its settings, tracking and queue counts, pending run and latest result. Read-only; it creates nothing and reports unconfigured when no project is set up.',
    schema({ projectId: { type: 'string', pattern: ID_PATTERN } }), true),
]);

const invalid = () => fail('SETUP_TOOL_ARGUMENT', 'Use only the advertised setup arguments with valid values.');
const sameRoot = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const systemTimezone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

function absolutePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > SETTINGS_LIMITS.pathBytes || /[\u0000-\u001f\u007f]/.test(value) ||
      !path.isAbsolute(value) || path.normalize(value) !== value) invalid();
  return value;
}

function setupArguments(args) {
  const input = fields(args, [], ['id', 'root', 'destination', 'tracking', 'saving', 'activityLog'], invalid), result = {};
  if (Object.hasOwn(input, 'id')) { if (typeof input.id !== 'string' || !PROJECT_ID.test(input.id)) invalid(); result.id = input.id; }
  if (Object.hasOwn(input, 'root')) result.root = absolutePath(input.root);
  if (Object.hasOwn(input, 'destination')) {
    const destination = fields(input.destination, ['kind', 'path'], [], invalid);
    if (!['directory', 'file'].includes(destination.kind)) invalid();
    result.destination = Object.freeze({ kind: destination.kind, path: absolutePath(destination.path) });
  }
  if (Object.hasOwn(input, 'tracking')) { if (!['manual', 'auto'].includes(input.tracking)) invalid(); result.tracking = input.tracking; }
  if (Object.hasOwn(input, 'saving')) { if (!['review', 'auto'].includes(input.saving)) invalid(); result.saving = input.saving; }
  if (Object.hasOwn(input, 'activityLog')) {
    const log = fields(input.activityLog, ['enabled'], ['timezone'], invalid);
    if (typeof log.enabled !== 'boolean') invalid();
    if (Object.hasOwn(log, 'timezone') && (!log.enabled || typeof log.timezone !== 'string' || !log.timezone || log.timezone.length > SETTINGS_LIMITS.timezoneLength)) invalid();
    result.activityLog = Object.freeze(log.enabled ? { enabled: true, ...(Object.hasOwn(log, 'timezone') ? { timezone: log.timezone } : {}) } : { enabled: false });
  }
  return Object.freeze(result);
}

/** A readable folder-name id: lowercase, hyphenated, starting with a letter or
 * digit, at most 128 characters, made unique among the configured ids. */
export function deriveProjectId(root, taken) {
  const fit = (text, limit) => text.slice(0, limit).replace(/-+$/, '');
  const base = fit(path.basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').replace(/-+$/, ''), SETTINGS_LIMITS.idLength) || 'project';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`, candidate = `${fit(base, SETTINGS_LIMITS.idLength - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function selectProject(projects, input) {
  const byId = input.id === undefined ? null : projects.find(project => project.id === input.id) ?? null;
  const byRoot = input.root === undefined ? null : projects.find(project => sameRoot(project.root, input.root)) ?? null;
  const mismatch = () => fail('SETUP_PROJECT_MISMATCH', 'The project id and root belong to different configured projects.');
  if (byId) { if (input.root !== undefined && byRoot !== byId) mismatch(); return byId; }
  if (byRoot && input.id !== undefined) mismatch();
  return byRoot;
}

function mergedLogging(existing, supplied) {
  if (supplied) return supplied.enabled
    ? { enabled: true, timezone: supplied.timezone ?? (existing?.activityLog.enabled ? existing.activityLog.timezone : systemTimezone()) }
    : { enabled: false };
  // The loaded path is derived from the destination; setup recomputes it.
  return existing?.activityLog.enabled ? { enabled: true, timezone: existing.activityLog.timezone } : existing ? { enabled: false } : undefined;
}

function proposal(projects, existing, input) {
  if (existing) return { id: existing.id, root: existing.root, destination: input.destination ?? existing.destination,
    tracking: input.tracking ?? existing.tracking, saving: input.saving ?? existing.saving, activityLog: mergedLogging(existing, input.activityLog) };
  if (input.root === undefined || input.destination === undefined) invalid();
  const activityLog = mergedLogging(null, input.activityLog);
  return { id: input.id ?? deriveProjectId(input.root, new Set(projects.map(project => project.id))), root: input.root, destination: input.destination,
    ...(input.tracking === undefined ? {} : { tracking: input.tracking }), ...(input.saving === undefined ? {} : { saving: input.saving }),
    ...(activityLog === undefined ? {} : { activityLog }) };
}

/** Explicit, user-agreed project setup and the read-only project status as MCP
 * tools. Setup applies through setupProject under the whole-settings hash read
 * just before it; that hash is never exposed or accepted. */
export function createProjectTools({ storeRoot, store, skillVersion }) {
  assertAbsolute(storeRoot); packageVersion(skillVersion);
  return Object.freeze({ tools: PROJECT_TOOLS, async call(name, args) {
    if (name === 'cuefluent_status') {
      const input = fields(args, ['projectId']);
      if (typeof input.projectId !== 'string' || !PROJECT_ID.test(input.projectId)) fail('CONTROL_ARGUMENT_INVALID', 'Use only the advertised control arguments.');
      return readProjectStatus(store, input.projectId);
    }
    if (name !== 'cuefluent_setup') fail('CONTROL_TOOL_UNKNOWN', 'This project tool is unavailable.');
    const input = setupArguments(args), { value, hash } = await currentSettings(store);
    const existing = selectProject(value.projects, input), proposed = proposal(value.projects, existing, input);
    let result;
    try { result = await setupProject({ storeRoot, project: proposed, expectedHash: hash, skillVersion }); }
    catch (error) {
      // A setup of this same project whose settings are already published is
      // completed with its own recorded request, which the journal check
      // requires verbatim; a request rebuilt from the published settings (an
      // adopted log timezone, say) is not that request. Completion then only
      // removes the journal. An unpublished intent, or a journal for another
      // project, stays a refusal: its public writes are never performed for a
      // different proposal.
      const pending = error?.code === 'SETUP_PENDING' && store ? await readPendingSetup(store) : null;
      if (!pending?.published || pending.request.id !== proposed.id || !sameRoot(pending.request.root, proposed.root)) throw error;
      await setupProject({ storeRoot, project: pending.request, expectedHash: (await currentSettings(store)).hash, skillVersion });
      // Then the caller's own choices apply to the completed configuration.
      const current = await currentSettings(store), selected = selectProject(current.value.projects, input);
      result = await setupProject({ storeRoot, project: proposal(current.value.projects, selected, input), expectedHash: current.hash, skillVersion });
    }
    return { state: 'configured', created: !existing, project: result.project, logs: result.logs };
  } });
}

/** A store whose first initialization stopped before its settings file exists
 * has no settings yet; setup resumes that initialization with a null hash. */
async function currentSettings(store) {
  try { return await readSettings(store); }
  catch (error) { if (error?.code !== 'FILE_MISSING') throw error; return readSettings(null); }
}
