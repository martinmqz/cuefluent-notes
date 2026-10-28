import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { createRun } from '../core/run.mjs';
import { packageVersion } from '../core/version.mjs';
import { hashBytes, writeJSON } from '../storage/files.mjs';
import { readSettings, withProject } from '../storage/store.mjs';
import { ownDirectAttempt } from '../storage/attempts.mjs';
import { openNoteWorkspace, NOTE_WORKSPACE_TOOLS } from '../processing/workspace.mjs';
import { NOTE_PROFILE, decodeNote, validateDocumentSources } from '../notes/index.mjs';
import { fields, freezeData, CONTROL_LIMITS } from '../client/control-server.mjs';
import { readRunSnapshot } from './status.mjs';
import { readPendingSetup } from './setup.mjs';
import { reviewRun, decideRun, completedOutcome } from './review.mjs';
import { persistDraftManifest, recoverDrafts } from '../processing/draft.mjs';
import { pinProcessingLogging } from '../processing/logging.mjs';
import { runProcessingWork } from '../processing/worker.mjs';

export const DIRECT_NOTE_BYTES = 64 * 1024;
/** A whole-note read is returned in one result while its serialized projection
 * stays within this bound, well inside the control response limit; larger
 * projections and larger notes are read in bounded ranges. */
export const DIRECT_READ_BYTES = Math.min(128 * 1024, CONTROL_LIMITS.responseBytes / 2);
const DIRECT_DRAFT_BYTES = DIRECT_NOTE_BYTES + NOTE_PROFILE.metadataBytes;
const UUID = '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const workspaceSchema = name => NOTE_WORKSPACE_TOOLS.find(tool => tool.name === name).inputSchema.properties;
const projectId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const runId = { type: 'string', pattern: UUID };
const target = workspaceSchema('read_note').target;
const expectedHash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const revision = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'The revision returned by the review the user decided on. A changed draft set is refused.' };
const content = { type: 'string', minLength: 1, maxLength: DIRECT_NOTE_BYTES,
  description: 'Complete visible Markdown subject content composed by the calling assistant. Keep source references and citation locators out of the body; supply them separately with sources. Maximum 64 KiB in UTF-8. Preserve useful existing content when updating; the writer retains existing metadata.' };
const summary = workspaceSchema('draft_note').summary;
const sources = workspaceSchema('draft_note').sources;
const definition = (name, description, inputSchema, readOnlyHint = false) => ({ name, description, inputSchema,
  annotations: { readOnlyHint, idempotentHint: true, openWorldHint: false } });
const REVIEW_FLOW = 'In review mode, show the returned content-only preview (a temporary Markdown file opened in the client, or rendered inline), name the destination, ask the user to choose from the returned choices, then relay the answer with cuefluent_save_note or cuefluent_skip_note and the returned revision. Auto mode saves immediately.';

export const DIRECT_NOTE_TOOLS = freezeData([
  definition('cuefluent_projects', 'List configured note destinations and saving preferences. Choose the project requested by the user; ask if ambiguous. Does not inspect conversations or change settings.',
    schema({ cursor: { type: 'integer', minimum: 0, maximum: 1024 } }, []), true),
  definition('cuefluent_list_notes', 'Browse one directory in a configured note destination with bounded pagination. Check for a suitable existing note before creating a duplicate. Listing does not read note contents or authorize replacement. Logs are reserved.',
    schema({ projectId, ...workspaceSchema('list_notes') }, ['projectId']), true),
  definition('cuefluent_read_note', 'Read an existing note and return its exact whole-file hash. A note within 64 KiB comes back whole in one call; a larger note, or one whose escaped projection is too large for one result, comes back in bounded UTF-8 ranges: follow next with start and pass the returned hash as expectedHash, and a changed note is refused. Does not create private state, enroll a chat, or process a queue.',
    schema({ projectId, ...workspaceSchema('read_note'), expectedHash }, ['projectId', 'target']), true),
  definition('cuefluent_create_note', `Create one new note from complete Markdown content you prepared for an explicit user request. Check for suitable existing notes first; use cuefluent_read_note and cuefluent_update_note to amend one. Use user-authorized context, supplied material, or task results. No tracked chat or queued input is needed. Supply a fresh UUID requestId for each request and reuse it with identical arguments on retries. ${REVIEW_FLOW} The target must be absent. Content must have a topic H1 and useful H2 sections, without Cuefluent metadata.`,
    schema({ projectId, requestId: runId, target, content, summary, sources }, ['projectId', 'requestId', 'target', 'content', 'summary'])),
  definition('cuefluent_update_note', `Update an existing note from complete reconciled Markdown prepared for an explicit user request. Read the note with cuefluent_read_note first and pass the exact whole-file hash it returned as expectedHash; a changed original is refused. Originals larger than 64 KiB are refused; never shorten them to fit. Preserve useful existing content, aliases and facts; the writer retains metadata. A changed or missing original is a conflict, never a new note or a forced overwrite. Supply a fresh UUID requestId; reuse identical arguments on retries. ${REVIEW_FLOW} No tracking, transcript read or queue processing is needed.`,
    schema({ projectId, requestId: runId, target, expectedHash, content, summary, sources }, ['projectId', 'requestId', 'target', 'expectedHash', 'content', 'summary'])),
  definition('cuefluent_review_note', 'Read the content-only preview of a pending direct or queued draft set, or the latest outcome, by projectId and runId. Returns the immutable revision a decision must cite, the destination of every draft, the exact choices to offer, and bounded pages: follow next.draft and next.start until next is null, concatenating pieces of one draft in order. Show the complete set before asking. Cuefluent metadata and search-alias comments are omitted from previews; hash identifies the complete private draft used for saving. No model, source synchronization, or save is started.',
    schema({ projectId, runId, draft: { type: 'integer', minimum: 0, maximum: 1023 }, start: { type: 'integer', minimum: 0, maximum: NOTE_PROFILE.fileBytes } }, ['projectId', 'runId']), true),
  definition('cuefluent_save_note', 'Publish the exact reviewed draft set after the user chose Save in this chat, or retry its interrupted save. Pass the projectId, runId and revision from the review; a changed revision is refused. A direct draft saves in this call; a queued set starts its save and status reports progress. Never call this without the user\'s decision or to bypass review mode.',
    schema({ projectId, runId, revision })),
  definition('cuefluent_skip_note', 'Relay the user\'s decision not to save the reviewed draft set. A direct draft is discarded (its unused private draft is cleared); a queued set is skipped while its queued input stays available. Pass the projectId, runId and revision from the review. Existing notes and every conversation queue are preserved.',
    schema({ projectId, runId, revision })),
]);

function argumentsFor(name, input) {
  const selected = DIRECT_NOTE_TOOLS.find(item => item.name === name);
  if (!selected) fail('CONTROL_TOOL_UNKNOWN', 'This note tool is unavailable.');
  const invalid = () => fail('DIRECT_NOTE_ARGUMENT', 'Use only the advertised direct note arguments.');
  const { properties, required } = selected.inputSchema;
  const result = fields(input, required, Object.keys(properties).filter(key => !required.includes(key)), invalid);
  for (const [key, value] of Object.entries(result)) {
    const rule = properties[key];
    if (key === 'sources') { result.sources = validateDocumentSources(value); continue; }
    // Content over the byte cap is a size refusal whatever its character count,
    // so its guidance says to preserve the note rather than to fix the arguments.
    if (key === 'content' && typeof value === 'string' && Buffer.byteLength(value) > DIRECT_NOTE_BYTES) fail('DIRECT_NOTE_CONTENT_LIMIT', 'The submitted content exceeds the direct note size limit.');
    if (rule.type === 'integer') {
      if (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum) invalid();
    } else if (typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? 128) ||
        (rule.pattern && new RegExp(rule.pattern).exec(value)?.[0] !== value)) invalid();
  }
  if (name === 'cuefluent_read_note' && result.start > 0 && result.expectedHash === undefined) invalid();
  return Object.freeze(result);
}

const busy = run => ({ state: 'busy', projectId: run.projectId });
const snapshot = readRunSnapshot;

async function manifestFor(project, input, { skillVersion }) {
  const workspace = await openNoteWorkspace({ project, runId: input.requestId, skillVersion });
  if (input.expectedHash !== undefined) {
    // The snapshot retained here owns both the exact bytes and filesystem binding
    // used by drafting and saving. Its hash is the guard: the inspected original
    // must still be the one being replaced. Never refresh it to make a stale
    // request pass.
    const original = await workspace.original({ target: input.target });
    if (!original.exists || original.hash !== input.expectedHash) fail('DIRECT_NOTE_CONFLICT', 'The existing note changed or disappeared after inspection. Re-read it and reconcile the requested update.');
    if (original.totalBytes > DIRECT_NOTE_BYTES) fail('DIRECT_NOTE_UPDATE_LIMIT', 'The existing note exceeds the complete-content update bound. It cannot be shortened to fit.');
  }
  await workspace.draft_note({ target: input.target, content: input.content, summary: input.summary, ...(input.sources?.length ? { sources: input.sources } : {}) });
  await workspace.finish_drafting({ outcome: 'drafted' });
  const manifest = await workspace.manifest();
  if (manifest.drafts.some(draft => draft.bytes.length > DIRECT_DRAFT_BYTES)) fail('DIRECT_NOTE_DRAFT_LIMIT', 'The complete direct note exceeds the bounded review size.');
  return manifest;
}

async function create(store, input, options) {
  // Keep the create identity stable for installed pending runs and retries.
  const payload = [input.target, input.content, input.summary];
  if (input.sources?.length) payload.push(['sources', input.sources]);
  const requestHash = hashBytes(JSON.stringify(input.expectedHash === undefined ? payload : ['update', ...payload, input.expectedHash]));
  const read = context => snapshot(store, context).then(value => ({ ...value, project: context.project }));
  const initial = await withProject(store, input.projectId, read);
  if (initial.run && initial.run.id !== input.requestId) return busy(initial.run);
  const replay = latest => {
    if (latest.requestHash !== requestHash) fail('DIRECT_NOTE_REQUEST_CHANGED', 'Reuse a requestId only with its exact original note.');
    return completedOutcome(latest);
  };
  if (!initial.run && initial.latest?.runId === input.requestId) return replay(initial.latest);
  if (initial.run && (initial.run.scope.kind !== 'direct' || initial.run.scope.requestHash !== requestHash)) fail('DIRECT_NOTE_REQUEST_CHANGED', 'Reuse a requestId only with its exact original note.');
  let manifest;
  if (!initial.run) manifest = await manifestFor(initial.project, input, options);
  const reserved = await withProject(store, input.projectId, async context => {
    const current = await snapshot(store, context);
    if (current.run) {
      if (current.run.id !== input.requestId) return { result: busy(current.run) };
      if (current.run.scope.kind !== 'direct' || current.run.scope.requestHash !== requestHash) fail('DIRECT_NOTE_REQUEST_CHANGED', 'Reuse a requestId only with its exact original note.');
      return { run: current.run, active: current.active };
    }
    if (current.latest?.runId === input.requestId) return { result: replay(current.latest) };
    if (initial.run) fail('DIRECT_NOTE_RUN_CHANGED', 'Pending work changed while retrying.');
    if (JSON.stringify(context.project) !== JSON.stringify(initial.project)) fail('SETTINGS_CONFLICT', 'The selected destination or preferences changed.');
    const run = createRun(context.project, [], { id: input.requestId, scope: { kind: 'direct', requestHash } });
    await writeJSON(store.pin, `${context.directory}/run.json`, run, { expectedHash: null });
    return { run, active: false, fresh: true };
  });
  if (reserved.result) return reserved.result;
  // Another retry may have reserved this request with different preferences.
  // Only our fresh reservation can use the manifest built before the gate.
  if (!reserved.fresh) manifest = undefined;
  const reference = { projectId: input.projectId, runId: input.requestId };
  if (reserved.active || reserved.run.phase === 'review' || reserved.run.settings.saving === 'review' && reserved.run.phase === 'saving') return reviewRun(store, reference);
  const result = await ownDirectAttempt(store, input.projectId, input.requestId, async (owner, current) => {
    if (current.phase === 'drafting') {
      if (reserved.fresh || !await recoverDrafts(store, owner)) {
        manifest ??= await manifestFor(current.settings, input, options);
        await pinProcessingLogging(store, owner);
        await persistDraftManifest(store, owner, manifest);
      }
    }
    return runProcessingWork(store, owner, { client: options.client, skillVersion: options.skillVersion, action: 'process' });
  });
  return result.state === 'review' ? reviewRun(store, reference) : completedOutcome(result);
}

/** A whole note within the direct cap is one result when its serialized
 * projection fits; otherwise the read falls back to the processor's bounded
 * ranges, whose budgets stay as they are. */
async function readWhole(workspace, target) {
  const whole = await workspace.original({ target });
  if (!whole.exists) return { target: whole.target, exists: false, hash: null, totalBytes: 0, start: 0, end: 0, next: null, content: '' };
  if (whole.totalBytes <= DIRECT_NOTE_BYTES) {
    const result = { target: whole.target, exists: true, hash: whole.hash, totalBytes: whole.totalBytes, start: 0, end: whole.totalBytes, next: null, content: decodeNote(whole.bytes) };
    if (Buffer.byteLength(JSON.stringify(result)) <= DIRECT_READ_BYTES) return result;
  }
  return workspace.read_note({ target });
}

async function inspectNotes(store, name, input, skillVersion) {
  const before = await readSettings(store), project = before.value.projects.find(item => item.id === input.projectId);
  if (!project) fail('PROJECT_UNCONFIGURED', 'The project is not configured.');
  const workspace = await openNoteWorkspace({ project, runId: randomUUID(), skillVersion });
  const { projectId: selected, expectedHash: inspectedHash, ...args } = input;
  const result = name === 'cuefluent_list_notes' ? await workspace.list_notes(args)
    : args.start === undefined && args.maxBytes === undefined ? await readWhole(workspace, args.target) : await workspace.read_note(args);
  if (inspectedHash !== undefined && result.hash !== inspectedHash) fail('DIRECT_NOTE_CONFLICT', 'The note changed between inspected ranges. Restart the read and reconcile its current contents.');
  if ((await readSettings(store)).hash !== before.hash) fail('SETTINGS_CONFLICT', 'The configured note destination changed during inspection.');
  return { state: name === 'cuefluent_list_notes' ? 'listed' : result.exists ? 'read' : 'absent', projectId: selected, ...result };
}

/** These are user-requested content submissions to an explicitly chosen configured
 * destination, not native chat commands. They claim no session provenance and
 * never inspect/enroll a chat or select/consume queue records. An update is
 * guarded by the inspected original's hash alone. The review and
 * decision tools also serve queued draft sets; a decision cites the reviewed
 * revision and the assistant is responsible for having asked the user. */
export function createDirectNoteTools({ store, client, skillVersion, launchProcessing }) {
  packageVersion(skillVersion);
  if (!['claude', 'codex'].includes(client)) fail('DIRECT_NOTE_CLIENT_INVALID', 'A supported host client is required.');
  return Object.freeze({ tools: DIRECT_NOTE_TOOLS, async call(name, args) {
    const input = argumentsFor(name, args), options = { client, skillVersion };
    if (name === 'cuefluent_projects') {
      const { value } = await readSettings(store), start = input.cursor ?? 0, projects = [];
      let bytes = 0, cursor = start;
      while (cursor < value.projects.length && projects.length < 20) {
        const { id, root, destination, saving } = value.projects[cursor], entry = { id, root, destination, saving };
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (projects.length && bytes + size > 128 * 1024) break;
        projects.push(entry); bytes += size; cursor++;
      }
      // An interrupted setup is named by project so it can be completed; its
      // choices stay private to the journal.
      const pending = store ? await readPendingSetup(store) : null;
      return { state: store ? 'configured' : 'unconfigured', projects, nextCursor: cursor < value.projects.length ? cursor : null,
        pendingSetup: pending ? { id: pending.request.id, root: pending.request.root } : null };
    }
    if (!store) return { state: 'unconfigured', message: 'Set up a note destination first.' };
    if (['cuefluent_list_notes', 'cuefluent_read_note'].includes(name)) return inspectNotes(store, name, input, skillVersion);
    if (['cuefluent_create_note', 'cuefluent_update_note'].includes(name)) return create(store, input, options);
    if (name === 'cuefluent_review_note') return reviewRun(store, input);
    if (!['cuefluent_save_note', 'cuefluent_skip_note'].includes(name)) fail('CONTROL_TOOL_UNKNOWN', 'This note tool is unavailable.');
    return decideRun(store, { ...input, action: name === 'cuefluent_skip_note' ? 'skip' : 'save' }, { client, skillVersion, launchProcessing });
  } });
}
