// Public diagnostics use fixed explanations, never exception messages, stacks,
// tool arguments, environment values, or paths taken from a caught exception.
import { entryOperation } from './core/entry-contract.mjs';
import { NODE_REQUIREMENT } from './core/runtime.mjs';

/** One short table of user-facing failures. Each entry names the codes it
 * explains; every other code, including internal ones, gets the generic entry.
 * Recovery names the next step and what to preserve; it never depends on which
 * tool or command failed, so a maintainer can read the whole table at once. */
const TABLE = [
  [['NODE_VERSION_UNSUPPORTED', 'ERR_UNKNOWN_BUILTIN_MODULE', 'GATE_UNSUPPORTED_RUNTIME'],
    `This Node.js runtime cannot run Cuefluent Notes; ${NODE_REQUIREMENT} is required.`,
    'Install a supported Node version, make the client use it for both the connector and hooks, and restart the client. A terminal may use a different Node executable.'],
  [['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'PACKAGE_INVALID', 'CLIENT_PACKAGE_INVALID', 'CLIENT_PACKAGE_CHANGED'],
    'The installed plugin package is incomplete, changed while it was verified, or could not be verified.',
    'Reinstall the plugin through its marketplace once any plugin upgrade has finished, then restart the client. Preserve private storage and notes; do not edit installed package files.'],
  [['PRIVATE_ACCESS_UNVERIFIED', 'STORE_ROOT_OCCUPIED', 'STORE_INCOMPLETE', 'ENTRY_STORE_ROOT_INVALID', 'ENTRY_LOCATION_INVALID', 'ENTRY_PLATFORM_UNSUPPORTED'],
    'The private store location cannot be used safely.',
    'Use a supported local location whose access is limited to your account, with the same normalized CUEFLUENT_HOME for the connector and hooks. Preserve every file there; do not clear state, remove ACLs or switch stores to bypass pending work.'],
  [['STORE_SCHEMA_UNSUPPORTED'],
    'The private store uses an unsupported state schema.',
    'Preserve the store in place. Do not copy, move or edit its files, or run another store against the same notes.'],
  [['ENOENT', 'EACCES', 'EPERM', 'FILE_MISSING'],
    'A required file or directory is missing, or the operating system denied access to it.',
    'Check that the configured paths exist and are accessible under your account, then confirm the destination with cuefluent_projects and read the current notes again. A missing original never authorizes a replacement; preserve pending work and share this diagnostic if the cause is unclear.'],
  [['PROJECT_UNCONFIGURED'],
    'The project is not configured.',
    'Call cuefluent_projects and use the exact projectId of the intended destination. Set up a project only when that destination is not configured.'],
  [['SETTINGS_CONFLICT', 'EXPECTED_HASH_REQUIRED', 'DIRECT_NOTE_CONFLICT', 'WORKSPACE_NOTE_UNREAD', 'WORKSPACE_LIST_CHANGED', 'NOTE_PUBLICATION_CONFLICT', 'DRAFT_CHANGED', 'PATH_CHANGED'],
    'The settings, note or directory changed after they were inspected or reviewed, or the inspected hash is missing.',
    'Read the current state again: cuefluent_projects for settings, cuefluent_read_note for a note, keeping the hash it returns as expectedHash, and reconcile the request with it before retrying. For a reviewed draft set, relay Discard or Skip to release it, then submit a fresh draft; notes already saved stay. Never replace a hash to force an older proposal; creation requires an absent target.'],
  [['PATH_MISSING', 'PATH_INVALID', 'PATH_UNSAFE'],
    'A path is missing, escapes its destination, or is not a plain file or directory.',
    'Use absolute normalized paths inside the configured destination, or an existing project root for setup, with no parent segments or symbolic links. A read creates nothing, and a missing original never authorizes a replacement; preserve existing files and pending work.'],
  [['PRIVATE_LOCATION_OVERLAP', 'PRIVATE_LOCATION_REPOSITORY'],
    'The private store must lie outside repositories, project roots and note destinations, and no project root or notes destination may lie inside it.',
    'Choose a notes destination and project root outside the private store, and a store location outside repositories and note destinations. Nothing was changed; preserve existing files and pending work.'],
  [['SETUP_ARGUMENT', 'SETUP_TOOL_ARGUMENT', 'SETUP_PROJECT_MISMATCH', 'SETTINGS_INVALID', 'PROJECT_ROOT_NONCANONICAL'],
    'The setup proposal is incomplete or invalid.',
    'Nothing was changed. Use the advertised cuefluent_setup fields with absolute normalized paths, a directory or a Markdown file destination, activity logging only for a directory, and an id and root that belong to the same project as cuefluent_projects lists it. Agree any changed choice with the user before repeating the call.'],
  [['SETUP_PENDING'],
    'An interrupted setup is waiting to be completed.',
    'Call cuefluent_projects: its pendingSetup names the interrupted project. Repeat cuefluent_setup with only that project\'s id or exact root to complete it as recorded, or with exactly its original choices; other setup changes wait until then. Do not delete private state to bypass this.'],
  [['SETTINGS_PENDING_RUN'],
    'A pending run pins this project\'s destination and saving mode.',
    'Settle the pending run first: show it with cuefluent_review_note and relay the user\'s decision, or wait for a running worker and read cuefluent_status. Then repeat the change. Tracking and logging preferences can change meanwhile; never delete private state to bypass this.'],
  [['SETTINGS_RETAINED_PROJECT'],
    'This project has retained chats or work, so its root cannot change and the project cannot be removed.',
    'Keep the project\'s root and change only its destination or preferences. Retained chats, including opted-out ones, stay with their project; do not delete private state to bypass this refusal.'],
  [['ATTEMPT_ACTIVE', 'STORE_SETUP_BUSY'],
    'Another Cuefluent operation is working on this project or store.',
    'Wait briefly for it to finish, then read status and retry the same request if it is still wanted. Do not start a second worker, clear state or choose another store.'],
  [['NOTE_SOURCE_ARGUMENT', 'COMMAND_INVALID', 'ENTRY_ARGUMENT_INVALID', 'CONTROL_ARGUMENT_INVALID', 'DIRECT_NOTE_ARGUMENT', 'WORKSPACE_ARGUMENT', 'WORKSPACE_RANGE_INVALID', 'REVIEW_ARGUMENT', 'NATIVE_COMMAND_MISMATCH'],
    'The request does not match the supported arguments or the current chat command.',
    'Nothing was changed. Use only the advertised tool schema, or exactly one typed action: track, untrack, process, process project, save, skip or status; to save supplied content, use the direct note tools. Never supply chat identities, transcript paths or transport metadata; a note read restarts from its start and follows the returned next offsets.'],
  [['NOTE_INVALID', 'NOTE_TARGET_INVALID', 'NOTE_TARGET_OUTSIDE', 'NOTE_TARGET_RESERVED', 'NOTE_METADATA_INVALID', 'NOTE_UTF8_INVALID', 'NOTE_ALIASES_CHANGED', 'NOTE_SOURCE_CONFLICT', 'NOTE_SOURCES_UNSUPPORTED', 'WORKSPACE_TARGET_ALIAS'],
    'The note, source metadata or target does not satisfy the supported note profile, or the proposal drops existing aliases.',
    'Use one Markdown (.md or .markdown) target inside the destination and outside logs/, with a topic H1, visible H2 sections and no Cuefluent metadata block. Preserve existing metadata, aliases, encoding and the log files; report malformed notes instead of repairing them. Supply sources separately: reconcile conflicting descriptions without changing their identity to bypass a conflict. Source additions require a supported header; do not enrich plain notes, replace unsupported metadata or move references into the body.'],
  [['NOTE_SOURCE_LIMIT', 'NOTE_FILE_LIMIT', 'DIRECT_NOTE_CONTENT_LIMIT', 'DIRECT_NOTE_UPDATE_LIMIT', 'DIRECT_NOTE_DRAFT_LIMIT', 'CONTROL_RESPONSE_LIMIT'],
    'The note, draft or result exceeds a supported size limit.',
    'Preserve the complete note, the submitted content and any retained draft, and report the limit. Do not shorten, split or strip metadata to fit it.'],
  [['DIRECT_NOTE_REQUEST_CHANGED', 'DIRECT_NOTE_CONTENT_REQUIRED', 'DIRECT_NOTE_RUN_REQUIRED'],
    'This request identity was used before with different arguments, or needs its original arguments and run.',
    'Reuse a requestId only with identical arguments. Inspect the retained draft or outcome with cuefluent_review_note and the original projectId and runId; to revise a pending draft, relay the user\'s Discard with cuefluent_skip_note and the reviewed revision first, then submit the revision with a fresh UUID.'],
  [['REVIEW_REVISION_STALE', 'REVIEW_RUN_CHANGED', 'DIRECT_NOTE_RUN_CHANGED', 'RUN_PHASE_INVALID'],
    'The run or its reviewed draft set is not in the state this decision expects.',
    'Read status, call cuefluent_review_note again, show the current draft set to the user and relay their new decision with the returned revision and the choices that page offers. Do not reuse an earlier answer or substitute another run id.'],
  [['DIRECT_NOTE_CLIENT_INVALID'],
    'This client is not supported.',
    'Use the plugin from Claude Code or Codex with a supported Node runtime. Preserve existing notes and private state.'],
  [['PROCESSING_CLIENT_FAILED', 'PROCESSING_ISOLATION_UNSUPPORTED'],
    'Queued processing could not run or finish in its separate drafting client.',
    'Check that client\'s sign-in, model availability, sandbox support and logs, then read status; the run keeps its input and drafts for a retry with the command that started it (process project for a project run, process from the same chat for a chat run). Do not weaken isolation or discard queued input.'],
  [['TRANSCRIPT_BOUNDARY_PENDING'],
    'The native prompt boundary needed for collection has not finished synchronizing.',
    'Allow the current turn and background synchronization to finish, then read status again. If it remains pending, report the code and preserve the transcript and queued work; do not reset tracking to bypass it.'],
  [['TRANSCRIPT_BOUNDARY_AMBIGUOUS', 'HISTORY_INHERITED_BOUNDARY_UNKNOWN'],
    'The native transcript does not establish a unique safe collection boundary.',
    'Keep this chat and its queued work intact. Use a new chat without forking for future tracking, or explicitly ask to save selected content as a direct note. Do not reset tracking or guess a history boundary.'],
  [['MCP_FRAME_INVALID', 'MCP_FRAME_LIMIT', 'MCP_FRAME_INCOMPLETE', 'CONTROL_REQUEST_LIMIT', 'CONTROL_CONNECTION_CLOSED', 'CONTROL_REQUEST_CANCELLED'],
    'The connector connection ended, was cancelled or exceeded a transport limit before this request completed.',
    'Reconnect the client with fewer or smaller requests, then read status and the latest outcome before repeating a mutation. Nothing was changed by a request that had not started; a running one finishes on its own.'],
];
const DEFAULT = ['Cuefluent could not complete this operation.', 'Keep existing notes and pending work unchanged. Read the latest outcome and report the error code and diagnostics to investigate the failure before retrying.'];
const GUIDANCE = new Map(TABLE.flatMap(([codes, message, recovery]) => codes.map(code => [code, [message, recovery]])));
/** The codes the table explains, for the check that each is still raised. */
export const GUIDED_CODES = Object.freeze([...GUIDANCE.keys()]);
export const NOTE_TOOL_NAMES = Object.freeze(['cuefluent_projects', 'cuefluent_list_notes', 'cuefluent_read_note', 'cuefluent_create_note',
  'cuefluent_update_note', 'cuefluent_review_note', 'cuefluent_save_note', 'cuefluent_skip_note']);
const TOOL_NAMES = new Set(['cuefluent_control', 'cuefluent_invocation', 'cuefluent_setup', 'cuefluent_status', ...NOTE_TOOL_NAMES]);
const data = (value, key) => value !== null && (typeof value === 'object' || typeof value === 'function') ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const codeOf = value => { const code = data(value, 'code'); return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : null; };

export function describeFailure(error, { fallback = 'CUEFLUENT_FAILED', stage, operation, toolName, client, version } = {}) {
  const code = codeOf(error) ?? codeOf({ code: fallback }) ?? 'CUEFLUENT_FAILED';
  const diagnostics = { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch };
  if (['runtime-check', 'module-load', 'command', 'transport', 'tool', 'result'].includes(stage)) diagnostics.stage = stage;
  if (entryOperation(operation)) diagnostics.operation = operation;
  if (TOOL_NAMES.has(toolName)) diagnostics.toolName = toolName;
  if (['claude', 'codex'].includes(client)) diagnostics.client = client;
  if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) && version.length <= 256) diagnostics.pluginVersion = version;
  const causeCodes = [], seen = new Set([error]);
  let cause = data(error, 'cause');
  for (let depth = 0; cause && depth < 4 && !seen.has(cause); depth++) {
    seen.add(cause);
    const causeCode = codeOf(cause);
    if (causeCode && !causeCodes.includes(causeCode)) causeCodes.push(causeCode);
    cause = data(cause, 'cause');
  }
  if (causeCodes.length) diagnostics.causeCodes = causeCodes;
  const [message, recovery] = GUIDANCE.get(code) ?? DEFAULT;
  return { error: code, message, recovery, diagnostics };
}

const diagnosticStreams = new WeakSet();
function writeDiagnostic(stream, text) {
  // A diagnostic is best effort. A closed host pipe must not interrupt an
  // active publication or the resource cleanup following a transport failure.
  try {
    if (stream.destroyed || !stream.writable) return;
    if (!diagnosticStreams.has(stream)) {
      stream.on('error', () => {});
      diagnosticStreams.add(stream);
    }
    stream.write(text, () => {});
  } catch { /* Diagnostic delivery cannot change the operation's outcome. */ }
}

export function reportFailure(error, context = {}) {
  const result = describeFailure(error, context);
  // Only the actual runtime executable is included, never an exception's path.
  // JSON escaping keeps unusual filenames from injecting diagnostic lines.
  const executable = process.execPath.length <= 4096 ? process.execPath : '(path exceeds diagnostic limit)';
  const message = `Cuefluent Notes [${result.error}]: ${result.message}\nNext step: ${result.recovery}\nDiagnostics: ${JSON.stringify({ ...result.diagnostics, executable })}`;
  if (context.operation === 'hook') writeDiagnostic(process.stdout, JSON.stringify({ systemMessage: message }) + '\n');
  else writeDiagnostic(process.stderr, message + '\n');
}
