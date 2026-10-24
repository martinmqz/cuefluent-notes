import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { createRun } from '../core/run.mjs';
import { packageVersion } from '../core/version.mjs';
import { hashBytes, writeJSON } from '../storage/files.mjs';
import { readSettings, withProject } from '../storage/store.mjs';
import { ownDirectAttempt } from '../storage/attempts.mjs';
import { openNoteWorkspace, NOTE_WORKSPACE_TOOLS } from '../processing/workspace.mjs';
import { NOTE_PROFILE } from '../notes/index.mjs';
import { reviewNoteContent } from '../notes/validate.mjs';
import { readPrivateDraft } from '../processing/save.mjs';
import { fields, freezeData } from '../client/control-server.mjs';
import { readRunSnapshot } from './status.mjs';
import { persistDraftManifest, recoverDrafts } from '../processing/draft.mjs';
import { pinProcessingLogging } from '../processing/logging.mjs';
import { runProcessingWork } from '../processing/worker.mjs';

export const DIRECT_NOTE_BYTES = 64 * 1024;
const DIRECT_DRAFT_BYTES = DIRECT_NOTE_BYTES + NOTE_PROFILE.metadataBytes;
const UUID = '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const workspaceSchema = name => NOTE_WORKSPACE_TOOLS.find(tool => tool.name === name).inputSchema.properties;
const projectId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const runId = { type: 'string', pattern: UUID };
const target = workspaceSchema('read_note').target;
const expectedHash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const content = { type: 'string', minLength: 1, maxLength: DIRECT_NOTE_BYTES,
  description: 'Complete Markdown note content composed by the calling assistant. Maximum 64 KiB in UTF-8. Preserve useful existing content when updating; the writer retains existing metadata.' };
const summary = workspaceSchema('draft_note').summary;
const definition = (name, description, inputSchema, readOnlyHint = false) => ({ name, description, inputSchema,
  annotations: { readOnlyHint, idempotentHint: true, openWorldHint: false } });

export const DIRECT_NOTE_TOOLS = freezeData([
  definition('cuefluent_projects', 'List configured note destinations and saving preferences. Choose the project requested by the user; ask if ambiguous. Does not inspect conversations or change settings.',
    schema({ cursor: { type: 'integer', minimum: 0, maximum: 1024 } }, []), true),
  definition('cuefluent_list_notes', 'Browse one directory in a configured note destination with bounded pagination. Check for a suitable existing note before creating a duplicate. Listing does not read note contents or authorize replacement. Logs are reserved.',
    schema({ projectId, ...workspaceSchema('list_notes') }, ['projectId']), true),
  definition('cuefluent_read_note', 'Read a bounded UTF-8 range of an existing note and return its exact whole-file hash. Read the complete note before composing an update. For subsequent ranges, pass the returned hash as expectedHash; changed notes are refused. Does not create private state, enroll a chat, or process a queue.',
    schema({ projectId, ...workspaceSchema('read_note'), expectedHash }, ['projectId', 'target']), true),
  definition('cuefluent_create_note', 'Create one new note from complete Markdown content you prepared for an explicit user request. Check for suitable existing notes first; use cuefluent_read_note and cuefluent_update_note to amend one. Use user-authorized context, supplied material, or task results. No tracked chat or queued input is needed. Supply a fresh UUID requestId for each request and reuse it with identical arguments on retries. In review mode, put the returned content-only preview in a temporary Markdown file and open it for user approval; auto mode saves it. The target must be absent. Content must have a topic H1 and useful H2 sections, without Cuefluent metadata.',
    schema({ projectId, requestId: runId, target, content, summary })),
  definition('cuefluent_update_note', 'Update an existing note from complete reconciled Markdown prepared for an explicit user request. First read every range of the note using cuefluent_read_note in this chat and pass its exact whole-file expectedHash. Originals larger than 64 KiB are refused; never shorten them to fit. Preserve useful existing content, aliases and facts; the writer retains metadata. A changed or missing original is a conflict, never a new note or a forced overwrite. Supply a fresh UUID requestId; reuse identical arguments on retries. In review mode, put the returned content-only preview in a temporary Markdown file and open it for user approval; auto mode saves it. No tracking, transcript read or queue processing is needed.',
    schema({ projectId, requestId: runId, target, expectedHash, content, summary })),
  definition('cuefluent_review_note', 'Read a content-only preview of the retained direct note draft or its latest outcome using the returned runId. Write the preview content unchanged to a temporary .md file for user approval. Cuefluent metadata and search-alias comments are omitted from the preview; hash identifies the complete private draft used for saving. No model, source synchronization, or save is started.', schema({ projectId, runId }), true),
  definition('cuefluent_save_note', 'Request host user confirmation and publish the exact reviewed direct note draft, or retry its interrupted save. Requires a client supporting MCP form elicitation. Use its returned projectId and runId. Never use this to bypass review mode.', schema({ projectId, runId })),
  definition('cuefluent_skip_note', 'Request host user confirmation to discard the identified inactive direct note draft. Requires MCP form elicitation. Preserve existing notes and every conversation queue. Use the returned projectId and runId.', schema({ projectId, runId })),
]);

function argumentsFor(name, input) {
  const selected = DIRECT_NOTE_TOOLS.find(item => item.name === name);
  if (!selected) fail('CONTROL_TOOL_UNKNOWN', 'This note tool is unavailable.');
  const invalid = () => fail('DIRECT_NOTE_ARGUMENT', 'Use only the advertised direct note arguments.');
  const { properties, required } = selected.inputSchema;
  const result = fields(input, required, Object.keys(properties).filter(key => !required.includes(key)), invalid);
  for (const [key, value] of Object.entries(result)) {
    const rule = properties[key];
    if (rule.type === 'integer') {
      if (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum) invalid();
    } else if (typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? 128) ||
        (rule.pattern && new RegExp(rule.pattern).exec(value)?.[0] !== value)) invalid();
  }
  if (result.content !== undefined && Buffer.byteLength(result.content) > DIRECT_NOTE_BYTES) invalid();
  if (name === 'cuefluent_read_note' && result.start > 0 && result.expectedHash === undefined) invalid();
  return Object.freeze(result);
}

const outcome = result => ({ state: result.status, projectId: result.projectId, runId: result.runId, result });
const busy = run => ({ state: 'busy', projectId: run.projectId });
const snapshot = readRunSnapshot;
function locate({ run, latest, active }, runId) {
  if (latest?.runId === runId && run?.id !== runId) {
    if (!latest.requestHash) fail('DIRECT_NOTE_RUN_REQUIRED', 'This operation only accepts direct notes.');
    return { result: outcome(latest) };
  }
  if (!run || run.id !== runId) fail('DIRECT_NOTE_RUN_CHANGED', 'The requested direct note is no longer pending or the latest outcome.');
  if (run.scope.kind !== 'direct') fail('DIRECT_NOTE_RUN_REQUIRED', 'This operation only accepts direct notes.');
  return active ? { result: { state: 'running', projectId: run.projectId, runId: run.id } } : { run };
}
const approvalHash = run => hashBytes(JSON.stringify([run.id, run.scope, run.settings, run.phase, run.artifacts, run.drafts, run.saved]));
async function confirm(approve, action, run) {
  if (typeof approve !== 'function') fail('DIRECT_NOTE_APPROVAL_UNSUPPORTED', 'This host cannot confirm direct note actions.');
  const targets = run.drafts.map(draft => `${draft.target}\n${draft.summary}`).join('\n');
  const verb = action === 'save' ? 'Save the exact reviewed draft' : action === 'skip' ? 'Discard the unsaved draft' : 'Open the pending draft in this chat';
  if (await approve(Object.freeze({ title: `${verb}?`, message: `${verb} for project ${run.projectId}?${targets ? `\n${targets}` : ''}\nDraft reference: ${approvalHash(run).slice(0, 12)}`,
    action, projectId: run.projectId, runId: run.id, draftHash: approvalHash(run) })) !== true) fail('DIRECT_NOTE_APPROVAL_DECLINED', 'The requested action was not approved.');
}

async function review(store, input) {
  return withProject(store, input.projectId, async context => {
    const { run, result } = locate(await snapshot(store, context), input.runId);
    if (result) return result;
    const drafts = [];
    if (['review', 'saving'].includes(run.phase)) {
      for (const draft of run.drafts) {
        if (draft.byteLength > DIRECT_DRAFT_BYTES || drafts.length) fail('DIRECT_NOTE_DRAFT_LIMIT', 'The direct note preview exceeds its bound.');
        const bytes = await readPrivateDraft(store, context.directory, run, draft);
        drafts.push({ target: draft.target, summary: draft.summary, expectedHash: draft.expectedHash, hash: draft.hash, content: reviewNoteContent(bytes) });
      }
    }
    return { state: run.phase === 'review' ? 'review' : 'interrupted', projectId: run.projectId, runId: run.id,
      phase: run.phase, reviewId: approvalHash(run).slice(0, 12), drafts, warnings: run.warnings };
  });
}

async function manifestFor(project, input, { skillVersion, inspections }) {
  const workspace = await openNoteWorkspace({ project, runId: input.requestId, skillVersion });
  if (input.expectedHash !== undefined) {
    // The snapshot retained here owns both the exact bytes and filesystem binding
    // used by drafting and saving. Never refresh it to make a stale request pass.
    const original = await workspace.read_note({ target: input.target, maxBytes: 4 });
    if (!original.exists || original.hash !== input.expectedHash) fail('DIRECT_NOTE_CONFLICT', 'The existing note changed or disappeared after inspection. Re-read it and reconcile the requested update.');
    if (original.totalBytes > DIRECT_NOTE_BYTES) fail('DIRECT_NOTE_UPDATE_LIMIT', 'The existing note exceeds the complete-content update bound. It cannot be shortened to fit.');
    const inspected = inspections.get(JSON.stringify([input.projectId, original.target]));
    if (!inspected || inspected.hash !== original.hash || inspected.end !== original.totalBytes) fail('DIRECT_NOTE_READ_INCOMPLETE', 'Read the complete current note before preparing an update.');
  }
  await workspace.draft_note({ target: input.target, content: input.content, summary: input.summary });
  await workspace.finish_drafting({ outcome: 'drafted' });
  const manifest = await workspace.manifest();
  if (manifest.drafts.some(draft => draft.bytes.length > DIRECT_DRAFT_BYTES)) fail('DIRECT_NOTE_DRAFT_LIMIT', 'The complete direct note exceeds the bounded review size.');
  return manifest;
}

async function create(store, input, options) {
  // Keep the create identity stable for installed pending runs and retries.
  const payload = [input.target, input.content, input.summary];
  const requestHash = hashBytes(JSON.stringify(input.expectedHash === undefined ? payload : ['update', ...payload, input.expectedHash]));
  const read = context => snapshot(store, context).then(value => ({ ...value, project: context.project }));
  const initial = await withProject(store, input.projectId, read);
  if (initial.run && initial.run.id !== input.requestId) return busy(initial.run);
  const replay = latest => {
    if (latest.requestHash !== requestHash) fail('DIRECT_NOTE_REQUEST_CHANGED', 'Reuse a requestId only with its exact original note.');
    return outcome(latest);
  };
  if (!initial.run && initial.latest?.runId === input.requestId) return replay(initial.latest);
  if (initial.run) {
    if (initial.run.scope.kind !== 'direct' || initial.run.scope.requestHash !== requestHash) fail('DIRECT_NOTE_REQUEST_CHANGED', 'Reuse a requestId only with its exact original note.');
    await options.claim(initial.run);
  }
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
    options.remember(run);
    return { run, active: false, fresh: true };
  });
  if (reserved.result) return reserved.result;
  const reference = { projectId: input.projectId, runId: input.requestId };
  if (reserved.active || reserved.run.phase === 'review' || reserved.run.settings.saving === 'review' && reserved.run.phase === 'saving') return review(store, reference);
  const result = await ownDirectAttempt(store, input.projectId, input.requestId, async (owner, current) => {
    if (current.phase === 'drafting') {
      if (reserved.fresh || !await recoverDrafts(store, owner)) {
        manifest ??= await manifestFor(current.settings, input, options);
        await pinProcessingLogging(store, owner);
        await persistDraftManifest(store, owner, manifest);
      }
    }
    return runProcessingWork(store, owner, { ...options, action: 'process' });
  });
  return result.state === 'review' ? review(store, reference) : outcome(result);
}

async function inspectNotes(store, name, input, skillVersion, inspections) {
  const before = await readSettings(store), project = before.value.projects.find(item => item.id === input.projectId);
  if (!project) fail('PROJECT_UNCONFIGURED', 'The project is not configured.');
  const workspace = await openNoteWorkspace({ project, runId: randomUUID(), skillVersion });
  const { projectId: selected, expectedHash: inspectedHash, ...args } = input;
  const result = name === 'cuefluent_list_notes' ? await workspace.list_notes(args) : await workspace.read_note(args);
  if (inspectedHash !== undefined && result.hash !== inspectedHash) fail('DIRECT_NOTE_CONFLICT', 'The note changed between inspected ranges. Restart the read and reconcile its current contents.');
  if ((await readSettings(store)).hash !== before.hash) fail('SETTINGS_CONFLICT', 'The configured note destination changed during inspection.');
  if (name === 'cuefluent_read_note' && result.exists) {
    const key = JSON.stringify([selected, result.target]), previous = inspections.get(key);
    const end = previous?.hash === result.hash && result.start <= previous.end ? Math.max(previous.end, result.end) : result.start === 0 ? result.end : null;
    if (end !== null) {
      if (inspections.size >= 32 && !inspections.has(key)) inspections.delete(inspections.keys().next().value);
      inspections.set(key, { hash: result.hash, end });
    }
  }
  return { state: name === 'cuefluent_list_notes' ? 'listed' : result.exists ? 'read' : 'absent', projectId: selected, ...result };
}

/** These are user-requested content submissions to an explicitly chosen configured
 * destination, not native chat commands. They claim no session provenance and
 * never inspect/enroll a chat or select/consume queue records. */
export function createDirectNoteTools({ store, client, skillVersion }) {
  packageVersion(skillVersion);
  if (!['claude', 'codex'].includes(client)) fail('DIRECT_NOTE_CLIENT_INVALID', 'A supported host client is required.');
  const localSession = Object.freeze({}), sessions = new Map(), owners = new Map();
  const sessionReads = session => {
    if (!sessions.has(session)) { if (sessions.size >= 16) sessions.delete(sessions.keys().next().value); sessions.set(session, new Map()); }
    return sessions.get(session);
  };
  return Object.freeze({ tools: DIRECT_NOTE_TOOLS, async call(name, args, request = { session: localSession }) {
    const input = argumentsFor(name, args);
    const { session = null, canResume = true, canInspect = true, approve, assertActive = () => {} } = request;
    const remember = run => {
      if (!session || !canResume) return;
      if (owners.size >= 128 && !owners.has(run.id)) owners.delete(owners.keys().next().value);
      owners.set(run.id, session);
    };
    const claim = async run => {
      if (session && canResume && owners.get(run.id) === session) return;
      const inspected = approvalHash(run);
      await confirm(approve, 'review', run);
      await withProject(store, run.projectId, async context => {
        const current = await snapshot(store, context);
        if (!current.run || approvalHash(current.run) !== inspected || current.active) fail('DIRECT_NOTE_RUN_CHANGED', 'The pending draft changed during confirmation.');
      });
      remember(run);
    };
    const options = { client, skillVersion, inspections: canInspect ? sessionReads(session) : new Map(), claim, remember };
    if (name === 'cuefluent_projects') {
      const { value } = await readSettings(store), start = input.cursor ?? 0, projects = [];
      let bytes = 0, cursor = start;
      while (cursor < value.projects.length && projects.length < 20) {
        const { id, root, destination, saving } = value.projects[cursor], entry = { id, root, destination, saving };
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (projects.length && bytes + size > 128 * 1024) break;
        projects.push(entry); bytes += size; cursor++;
      }
      return { state: store ? 'configured' : 'unconfigured', projects, nextCursor: cursor < value.projects.length ? cursor : null };
    }
    if (!store) return { state: 'unconfigured', message: 'Set up a note destination first.' };
    if (['cuefluent_list_notes', 'cuefluent_read_note'].includes(name)) return inspectNotes(store, name, input, skillVersion, options.inspections);
    if (['cuefluent_create_note', 'cuefluent_update_note'].includes(name)) {
      if (name === 'cuefluent_update_note' && !canInspect) fail('DIRECT_NOTE_CONTEXT_UNAVAILABLE', 'This host did not provide a current chat context for the complete note inspection.');
      return create(store, input, options);
    }
    if (!['cuefluent_review_note', 'cuefluent_save_note', 'cuefluent_skip_note'].includes(name)) fail('CONTROL_TOOL_UNKNOWN', 'This note tool is unavailable.');
    const current = await withProject(store, input.projectId, context => snapshot(store, context));
    const located = locate(current, input.runId);
    if (located.result) return located.result;
    if (name === 'cuefluent_review_note') { await claim(located.run); return review(store, input); }
    const action = name === 'cuefluent_skip_note' ? 'skip' : 'save';
    // Recover a complete retained manifest before asking approval of its bytes.
    // In review mode this only restores the preview; the next save confirms it.
    if (action === 'save' && located.run.phase === 'drafting' && located.run.settings.saving === 'review') {
      await claim(located.run);
      const recovered = await ownDirectAttempt(store, input.projectId, input.runId, owner => runProcessingWork(store, owner, { ...options, action: 'process' }));
      return recovered.state === 'review' ? review(store, input) : outcome(recovered);
    }
    const inspected = approvalHash(located.run);
    await confirm(approve, action, located.run);
    const result = await ownDirectAttempt(store, input.projectId, input.runId, async (owner, run) => {
      assertActive();
      if (approvalHash(run) !== inspected) fail('DIRECT_NOTE_RUN_CHANGED', 'The draft changed after user confirmation.');
      return runProcessingWork(store, owner, { ...options, action: action === 'skip' ? 'skip' : run.settings.saving === 'auto' ? 'process' : 'save' });
    });
    remember(located.run);
    return result.state === 'review' ? review(store, input) : outcome(result);
  } });
}
