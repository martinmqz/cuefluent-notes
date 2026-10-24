import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { createRun, validateRun } from '../core/run.mjs';
import { validateResult } from '../core/result.mjs';
import { packageVersion } from '../core/version.mjs';
import { hashBytes, readJSON, writeJSON } from '../storage/files.mjs';
import { readSettings, withProject, gateOptions } from '../storage/store.mjs';
import { probeGate } from '../storage/gates.mjs';
import { ownDirectAttempt, withCurrentAttempt } from '../storage/attempts.mjs';
import { readDraftArtifact } from '../storage/draft-artifacts.mjs';
import { openNoteWorkspace, WORKSPACE_LIMITS } from '../processing/workspace.mjs';
import { NOTE_PROFILE } from '../notes/index.mjs';
import { inspectMetadata } from '../notes/metadata.mjs';
import { parseMarkdown } from '../notes/markdown.mjs';
import { persistDraftManifest, recoverDrafts } from '../processing/draft.mjs';
import { pinProcessingLogging } from '../processing/logging.mjs';
import { runProcessingWork } from '../processing/worker.mjs';

export const DIRECT_NOTE_BYTES = 64 * 1024;
const DIRECT_DRAFT_BYTES = DIRECT_NOTE_BYTES + NOTE_PROFILE.metadataBytes;
const UUID = '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const projectId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const runId = { type: 'string', pattern: UUID };
const target = { type: 'string', minLength: 1, maxLength: 32768 };
const expectedHash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const content = { type: 'string', minLength: 1, maxLength: DIRECT_NOTE_BYTES,
  description: 'Complete Markdown note content composed by the calling assistant. Maximum 64 KiB in UTF-8. Preserve useful existing content when updating; the writer retains existing metadata.' };
const summary = { type: 'string', minLength: 1, maxLength: 1024 };
const definition = (name, description, inputSchema, readOnlyHint = false) => Object.freeze({ name, description, inputSchema,
  annotations: { readOnlyHint, idempotentHint: true, openWorldHint: false } });

export const DIRECT_NOTE_TOOLS = Object.freeze([
  definition('cuefluent_projects', 'List configured note destinations and saving preferences. Choose the project requested by the user; ask if ambiguous. Does not inspect conversations or change settings.',
    schema({ cursor: { type: 'integer', minimum: 0, maximum: 1024 } }, []), true),
  definition('cuefluent_list_notes', 'Browse one directory in a configured note destination with bounded pagination. Check for a suitable existing note before creating a duplicate. Listing does not read note contents or authorize replacement. Logs are reserved.',
    schema({ projectId, directory: { type: 'string', minLength: 0, maxLength: 32768 }, cursor: { type: 'string', minLength: 0, maxLength: 32768 },
      limit: { type: 'integer', minimum: 1, maximum: WORKSPACE_LIMITS.listResults } }, ['projectId']), true),
  definition('cuefluent_read_note', 'Read a bounded UTF-8 range of an existing note and return its exact whole-file hash. Read the complete note before composing an update. For subsequent ranges, pass the returned hash as expectedHash; changed notes are refused. Does not create private state, enroll a chat, or process a queue.',
    schema({ projectId, target, start: { type: 'integer', minimum: 0, maximum: WORKSPACE_LIMITS.fileBytes },
      maxBytes: { type: 'integer', minimum: 1, maximum: WORKSPACE_LIMITS.readBytes }, expectedHash }, ['projectId', 'target']), true),
  definition('cuefluent_create_note', 'Create one new note from complete Markdown content you prepared for an explicit user request. Check for suitable existing notes first; use cuefluent_read_note and cuefluent_update_note to amend one. Use user-authorized context, supplied material, or task results. No tracked chat or queued input is needed. Supply a fresh UUID requestId for each request and reuse it with identical arguments on retries. In review mode, put the returned content-only preview in a temporary Markdown file and open it for user approval; auto mode saves it. The target must be absent. Content must have a topic H1 and useful H2 sections, without Cuefluent metadata.',
    schema({ projectId, requestId: runId, target, content, summary })),
  definition('cuefluent_update_note', 'Update an existing note from complete reconciled Markdown prepared for an explicit user request. First read the note using cuefluent_read_note and pass its exact whole-file expectedHash. Preserve useful existing content, aliases and facts; the writer retains metadata. A changed or missing original is a conflict, never a new note or a forced overwrite. Supply a fresh UUID requestId; reuse identical arguments on retries. In review mode, put the returned content-only preview in a temporary Markdown file and open it for user approval; auto mode saves it. No tracking, transcript read or queue processing is needed.',
    schema({ projectId, requestId: runId, target, expectedHash, content, summary })),
  definition('cuefluent_review_note', 'Read a content-only preview of the retained direct note draft or its latest outcome using the returned runId. Write the preview content unchanged to a temporary .md file for user approval. Cuefluent metadata and search-alias comments are omitted from the preview; hash identifies the complete private draft used for saving. No model, source synchronization, or save is started.', schema({ projectId, runId }), true),
  definition('cuefluent_save_note', 'Publish the exact direct note draft the user has reviewed and approved, or retry its interrupted save. Use its returned projectId and runId. Never use this to bypass review mode.', schema({ projectId, runId })),
  definition('cuefluent_skip_note', 'Discard the identified inactive direct note draft when the user asks. Preserve existing notes and every conversation queue. Use the returned projectId and runId.', schema({ projectId, runId })),
]);

function argumentsFor(name, input) {
  const selected = DIRECT_NOTE_TOOLS.find(item => item.name === name);
  if (!selected) fail('CONTROL_TOOL_UNKNOWN', 'This note tool is unavailable.');
  const invalid = () => fail('DIRECT_NOTE_ARGUMENT', 'Use only the advertised direct note arguments.');
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), { properties, required } = selected.inputSchema;
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !Object.hasOwn(properties, key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) ||
      required.some(key => !Object.hasOwn(descriptors, key))) invalid();
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const value = descriptor.value, rule = properties[key];
    if (rule.type === 'integer' ? !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum :
      typeof value !== 'string' || value.length < (rule.minLength ?? 1) || value.length > (rule.maxLength ?? 128) || rule.pattern && new RegExp(rule.pattern).exec(value)?.[0] !== value) invalid();
    result[key] = value;
  }
  if (result.content !== undefined && Buffer.byteLength(result.content) > DIRECT_NOTE_BYTES) invalid();
  if (name === 'cuefluent_read_note' && result.start > 0 && result.expectedHash === undefined) invalid();
  return Object.freeze(result);
}

const outcome = result => ({ state: result.status, projectId: result.projectId, runId: result.runId, result });
const busy = run => ({ state: 'busy', runId: run.id, projectId: run.projectId, scope: run.scope.kind, phase: run.phase });

async function snapshot(store, context) {
  const pending = await readJSON(store.pin, `${context.directory}/run.json`, { missing: true });
  const previous = await readJSON(store.pin, `${context.directory}/result.json`, { missing: true });
  const run = pending ? validateRun(pending.value) : null, latest = previous ? validateResult(previous.value) : null;
  if (run && run.projectId !== context.project.id || latest && latest.projectId !== context.project.id) fail('DIRECT_NOTE_RUN_CHANGED', 'Stored work belongs to a different project.');
  return { run, latest, active: Boolean(probeGate(context.gates.workerGate, gateOptions).busy) };
}

function reviewContent(bytes) {
  const source = bytes.toString('utf8'), metadata = inspectMetadata(source);
  if (metadata.status === 'invalid') fail('NOTE_METADATA_INVALID', 'Malformed draft metadata cannot be hidden in a review.');
  const body = metadata.raw === null ? source : source.slice(0, metadata.start) + source.slice(metadata.end);
  const starts = [0];
  for (const match of body.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  const { tokens } = parseMarkdown(body);
  // Remove only real alias metadata, retaining literal examples inside code.
  const aliases = tokens.filter(token => token.type === 'html_block' && token.level === 0 && token.map &&
    /^ {0,3}<!--[ \t]*aliases:[ \t]*[^\r\n]*?-->[ \t]*(?:\r?\n)?$/.test(token.content));
  let content = body;
  for (const token of aliases.reverse()) {
    content = content.slice(0, starts[token.map[0]]) + content.slice(starts[token.map[1]] ?? body.length);
  }
  return content;
}

async function review(store, input) {
  return withProject(store, input.projectId, async context => {
    const { run, latest, active } = await snapshot(store, context);
    if (latest?.runId === input.runId && run?.id !== input.runId) return outcome(latest);
    if (!run || run.id !== input.runId) fail('DIRECT_NOTE_RUN_CHANGED', 'The requested direct note is no longer pending or the latest outcome.');
    if (run.scope.kind !== 'direct') fail('DIRECT_NOTE_RUN_REQUIRED', 'This operation only accepts direct notes.');
    if (active) return { state: 'running', projectId: run.projectId, runId: run.id };
    const drafts = [];
    if (['review', 'saving'].includes(run.phase)) {
      for (const draft of run.drafts) {
        if (draft.byteLength > DIRECT_DRAFT_BYTES || drafts.length) fail('DIRECT_NOTE_DRAFT_LIMIT', 'The direct note preview exceeds its bound.');
        const bytes = await readDraftArtifact(store.pin, run.artifacts, draft.id);
        if (hashBytes(bytes) !== draft.hash) fail('DIRECT_NOTE_DRAFT_CHANGED', 'The retained draft changed.');
        drafts.push({ target: draft.target, summary: draft.summary, expectedHash: draft.expectedHash, hash: draft.hash, content: reviewContent(bytes) });
      }
    }
    return { state: run.phase === 'review' ? 'review' : 'interrupted', projectId: run.projectId, runId: run.id,
      phase: run.phase, drafts, warnings: run.warnings };
  });
}

async function manifestFor(project, input, skillVersion) {
  const workspace = await openNoteWorkspace({ project, runId: input.requestId, skillVersion });
  if (input.expectedHash !== undefined) {
    // The snapshot retained here owns both the exact bytes and filesystem binding
    // used by drafting and saving. Never refresh it to make a stale request pass.
    const original = await workspace.read_note({ target: input.target, maxBytes: 4 });
    if (!original.exists || original.hash !== input.expectedHash) fail('DIRECT_NOTE_CONFLICT', 'The existing note changed or disappeared after inspection. Re-read it and reconcile the requested update.');
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
  if (!initial.run && initial.latest?.runId === input.requestId) return outcome(initial.latest);
  let manifest;
  if (!initial.run) manifest = await manifestFor(initial.project, input, options.skillVersion);
  const reserved = await withProject(store, input.projectId, async context => {
    const current = await snapshot(store, context);
    if (current.run) {
      if (current.run.id !== input.requestId) return { result: busy(current.run) };
      if (current.run.scope.kind !== 'direct' || current.run.scope.requestHash !== requestHash) fail('DIRECT_NOTE_REQUEST_CHANGED', 'Reuse a requestId only with its exact original note.');
      return { run: current.run, active: current.active };
    }
    if (current.latest?.runId === input.requestId) return { result: outcome(current.latest) };
    if (initial.run) fail('DIRECT_NOTE_RUN_CHANGED', 'Pending work changed while retrying.');
    if (JSON.stringify(context.project) !== JSON.stringify(initial.project)) fail('SETTINGS_CONFLICT', 'The selected destination or preferences changed.');
    const run = createRun(context.project, [], { id: input.requestId, scope: { kind: 'direct', requestHash } });
    await writeJSON(store.pin, `${context.directory}/run.json`, run, { expectedHash: null });
    return { run, active: false };
  });
  if (reserved.result) return reserved.result;
  const reference = { projectId: input.projectId, runId: input.requestId };
  if (reserved.active || reserved.run.phase === 'review' || reserved.run.settings.saving === 'review' && reserved.run.phase === 'saving') return review(store, reference);
  const result = await ownDirectAttempt(store, input.projectId, input.requestId, async owner => {
    const current = await withCurrentAttempt(owner, ({ run }) => run);
    if (current.phase === 'drafting') {
      if (!await recoverDrafts(store, owner)) {
        manifest ??= await manifestFor(current.settings, input, options.skillVersion);
        await pinProcessingLogging(store, owner);
        await persistDraftManifest(store, owner, manifest);
      }
    }
    return runProcessingWork(store, owner, { ...options, action: 'process' });
  });
  return result.state === 'review' ? review(store, reference) : outcome(result);
}

async function inspectNotes(store, name, input, skillVersion) {
  const before = await readSettings(store), project = before.value.projects.find(item => item.id === input.projectId);
  if (!project) fail('PROJECT_UNCONFIGURED', 'The project is not configured.');
  const workspace = await openNoteWorkspace({ project, runId: randomUUID(), skillVersion });
  const { projectId: selected, expectedHash: inspectedHash, ...args } = input;
  const result = name === 'cuefluent_list_notes' ? await workspace.list_notes(args) : await workspace.read_note(args);
  if (inspectedHash !== undefined && result.hash !== inspectedHash) fail('DIRECT_NOTE_CONFLICT', 'The note changed between inspected ranges. Restart the read and reconcile its current contents.');
  if ((await readSettings(store)).hash !== before.hash) fail('SETTINGS_CONFLICT', 'The configured note destination changed during inspection.');
  return { projectId: selected, ...result };
}

/** These are user-requested content submissions to an explicitly chosen configured
 * destination, not native chat commands. They claim no session provenance and
 * never inspect/enroll a chat or select/consume queue records. */
export function createDirectNoteTools({ store, client, skillVersion }) {
  packageVersion(skillVersion);
  if (!['claude', 'codex'].includes(client)) fail('DIRECT_NOTE_CLIENT_INVALID', 'A supported host client is required.');
  const options = { client, skillVersion };
  return Object.freeze({ tools: DIRECT_NOTE_TOOLS, async call(name, args) {
    const input = argumentsFor(name, args);
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
    if (['cuefluent_list_notes', 'cuefluent_read_note'].includes(name)) return inspectNotes(store, name, input, skillVersion);
    if (['cuefluent_create_note', 'cuefluent_update_note'].includes(name)) return create(store, input, options);
    if (name === 'cuefluent_review_note') return review(store, input);
    const current = await withProject(store, input.projectId, context => snapshot(store, context));
    if (current.latest?.runId === input.runId && current.run?.id !== input.runId) return outcome(current.latest);
    if (!current.run || current.run.id !== input.runId) fail('DIRECT_NOTE_RUN_CHANGED', 'The requested direct note is no longer pending.');
    if (current.run.scope.kind !== 'direct') fail('DIRECT_NOTE_RUN_REQUIRED', 'This operation only accepts direct notes.');
    if (current.active) return { state: 'running', ...input };
    const result = await ownDirectAttempt(store, input.projectId, input.runId, owner => runProcessingWork(store, owner,
      { ...options, action: name === 'cuefluent_skip_note' ? 'skip' : current.run.settings.saving === 'auto' ? 'process' : 'save' }));
    return outcome(result);
  } });
}
