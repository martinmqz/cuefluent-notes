// Public diagnostics use fixed explanations, never exception messages, stacks,
// tool arguments, environment values, or paths taken from a caught exception.
import { entryOperation } from './core/entry-contract.mjs';
import { NODE_REQUIREMENT } from './core/runtime.mjs';

const GUIDANCE = {
  NODE_VERSION_UNSUPPORTED: [`This Node.js version cannot run Cuefluent Notes. ${NODE_REQUIREMENT} is required.`,
    'Install a supported Node version and make the client use it for both the connector and hooks, then restart the client. A terminal may use a different Node executable.'],
  ERR_MODULE_NOT_FOUND: ['A required plugin module or dependency could not be loaded.', 'Reinstall the plugin through its marketplace. Check the installed package path and the Node runtime shown below.'],
  MODULE_NOT_FOUND: ['A required plugin module or dependency could not be loaded.', 'Reinstall the plugin through its marketplace. Check the installed package path and the Node runtime shown below.'],
  ERR_UNKNOWN_BUILTIN_MODULE: ['This Node runtime is missing a built-in module required by the plugin.', `Use ${NODE_REQUIREMENT} and restart the client.`],
  PACKAGE_INVALID: ['The installed plugin has an invalid package identity or version.', 'Reinstall the plugin through its marketplace; do not edit its version or published files manually.'],
  CLIENT_PACKAGE_INVALID: ['The installed plugin package is incomplete or could not be verified safely.', 'Reinstall the plugin through its marketplace and restart the client. Preserve private storage and notes; do not edit installed package files to bypass verification.'],
  CLIENT_PACKAGE_CHANGED: ['The installed plugin package changed while it was being verified.', 'Finish any plugin upgrade and restart the client. If verification still fails, reinstall through the marketplace; preserve private storage and notes.'],
  ENOENT: ['A resource required for this operation could not be found.', 'Check that the required files and directories still exist and are accessible. Preserve pending work and report this diagnostic if the missing resource is unclear.'],
  EACCES: ['The operating system denied access to a required resource.', 'Check access to the configured paths under your account. Preserve existing permissions and share this diagnostic if the cause is unclear.'],
  EPERM: ['The operating system refused a required operation.', 'Check the client sandbox and access to the configured paths. Preserve security protections and share this diagnostic if the cause is unclear.'],
  PRIVATE_ACCESS_UNVERIFIED: ['Cuefluent could not verify that its private storage is accessible only to your account.', 'Use supported local storage and a supported Node runtime. On macOS, check that Node FFI is available and permitted; do not remove ACLs to bypass verification.'],
  GATE_UNSUPPORTED_RUNTIME: ['The runtime lacks the locking support required for safe note operations.', `Use ${NODE_REQUIREMENT} and restart the client.`],
  SETTINGS_CONFLICT: ['Cuefluent settings changed after they were inspected.', 'Read the current settings and reconcile the intended operation before retrying. Preserve pending work and its recorded destination.'],
  PROJECT_UNCONFIGURED: ['The requested project ID is not in the current Cuefluent configuration.', 'Read the configured projects and use the exact existing project ID for the intended destination. Set up a project only if that destination is not configured.'],
  SETUP_ARGUMENT: ['The setup proposal has missing or invalid fields.', 'Check the setup reference and provide the complete agreed project settings plus the inspected settingsHash as expectedHash. Use null only for fresh settings; preserve existing settings and pending work.'],
  EXPECTED_HASH_REQUIRED: ['This operation requires the exact inspected file hash.', 'Read the current target and retain its returned hash for the intended change. Use null only for an inspected absent target when the operation permits creation; reconcile the proposal rather than replacing its hash alone.'],
  COMMAND_INVALID: ['Cuefluent received an invalid tracking or processing command.', 'Select the skill and send one supported action: track, untrack, process, process project, save, skip, or status. Use direct note tools for supplied content.'],
  ENTRY_ARGUMENT_INVALID: ['The plugin entrypoint received unsupported arguments.', 'Use the installed skill or the documented CLI syntax; check the connector command and arguments if startup keeps failing.'],
  ENTRY_STORE_ROOT_INVALID: ['CUEFLUENT_V2_HOME is not a valid explicit private-store location.', 'Correct CUEFLUENT_V2_HOME in the client launch environment to the intended normalized absolute path, with no trailing separator. Use the same location for connector and hooks; do not switch stores to bypass pending work.'],
  ENTRY_LOCATION_INVALID: ['An operating-system home or data-directory location is invalid.', 'Check the home and data-directory locations supplied to the client by its operating-system environment. Preserve the intended private-store location when correcting them.'],
  ENTRY_PLATFORM_UNSUPPORTED: ['This operating system has no supported Cuefluent private-store location.', 'Use a supported macOS, Linux, or Windows environment with supported local storage. Preserve existing notes and private state.'],
  CONTROL_ARGUMENT_INVALID: ['The tool arguments do not match the supported operation.', 'Use only the arguments in the advertised tool schema; do not supply chat identities or transcript paths.'],
  DIRECT_NOTE_ARGUMENT: ['The direct note request has invalid arguments.', 'Check the advertised tool schema, destination, fresh request UUID, and complete Markdown content before resubmitting.'],
  WORKSPACE_ARGUMENT: ['The note browsing or drafting arguments are invalid.', 'Use the advertised note tool schema and its bounded ranges. Preserve the complete note content when correcting the request.'],
  WORKSPACE_NOTE_UNREAD: ['The target already exists and has not been inspected for this replacement.', 'Read the complete existing note and reconcile the proposed update before drafting it. Preserve its content and exact inspected hash.'],
  WORKSPACE_RANGE_INVALID: ['The requested read range cannot contain complete UTF-8 text at that offset.', 'Restart the note read at byte zero with the default chunk size and follow the returned next offsets. Keep the first whole-file hash for later chunks and read the complete note before updating it.'],
  WORKSPACE_LIST_CHANGED: ['The notes directory changed while it was being listed.', 'Restart the bounded directory listing and inspect any selected note before preparing an update. Preserve existing notes and pending drafts.'],
  WORKSPACE_TARGET_ALIAS: ['Two target spellings identify the same portable note name.', 'Use one canonical target spelling for the intended change, retaining any existing note\'s exact spelling. Do not create a second spelling to bypass an existing note.'],
  NOTE_INVALID: ['The proposed note does not satisfy the supported Markdown output profile.', 'Check the note structure, metadata, and size limits in the note guidance before preparing a complete compatible draft. Preserve existing content; do not truncate it or remove metadata to bypass validation.'],
  NOTE_TARGET_INVALID: ['The note target is not a valid canonical Markdown path.', 'Correct the target spelling to a Markdown (.md) path within the agreed destination. Honor an explicit file destination and preserve any existing note.'],
  NOTE_TARGET_OUTSIDE: ['The note target does not match the configured destination.', 'Check the selected project and intended target. Use the exact configured file for a file destination, or a path within the configured notes directory; a destination change needs explicit setup agreement.'],
  NOTE_TARGET_RESERVED: ['The logs directory is reserved for writer-managed activity logs.', 'Preserve the log files. Ordinary notes need an agreed target outside logs/ within the configured destination; do not move an existing note to bypass this refusal.'],
  NOTE_METADATA_INVALID: ['The note has malformed metadata that cannot be changed safely.', 'Preserve the original note and its metadata. Report the metadata problem for review instead of silently repairing or removing it.'],
  NOTE_ALIASES_CHANGED: ['The proposed update would remove an existing note\'s search aliases.', 'Reconcile the complete update with the inspected note and retain its useful search aliases before proposing the draft again.'],
  NOTE_FILE_LIMIT: ['The note exceeds the supported file size limit.', 'Preserve the complete note and report the size limit. Do not shorten it, split it, or raise safety limits to force this operation.'],
  NOTE_UTF8_INVALID: ['The note is not valid UTF-8 text.', 'Preserve the original bytes and report the encoding problem. Do not replace unread content with a partial or lossy conversion.'],
  DIRECT_NOTE_CONFLICT: ['The note or its destination changed since it was inspected.', 'Read the current note completely and reconcile the proposed change. Review the revised draft; do not replace the hash just to force a save.'],
  DIRECT_NOTE_READ_INCOMPLETE: ['The existing note has not been read completely for this update.', 'Read every returned chunk in the same chat or connection, retaining the first whole-file hash, before preparing the replacement.'],
  DIRECT_NOTE_CONTEXT_UNAVAILABLE: ['The client did not provide the chat context needed to bind this note operation.', 'Use a supported client connection that supplies current-chat context. Preserve the existing note; do not invent a chat identity.'],
  DIRECT_NOTE_UPDATE_LIMIT: ['The existing note exceeds the supported direct-update size limit.', 'Preserve the original note. Do not shorten it or submit a partial replacement to fit the limit.'],
  DIRECT_NOTE_REQUEST_CHANGED: ['This request ID was already used with different note content or arguments.', 'Inspect the original draft or outcome with cuefluent_review_note and the original projectId/runId. To revise a pending draft, first discard it through cuefluent_skip_note with user authorization and successful client confirmation, then submit the revision with a fresh UUID. A completed request also needs a fresh UUID for a new proposal. Reuse the original ID only with identical arguments.'],
  DIRECT_NOTE_RUN_CHANGED: ['The identified direct-note draft changed or is no longer the pending draft or latest outcome.', 'Check the original projectId/runId and the most recent result before acting. Review the retained draft again if it is still available; do not substitute another run ID or reuse earlier approval.'],
  DIRECT_NOTE_RUN_REQUIRED: ['This operation requires a direct-note run.', 'Use the projectId and runId returned by the direct note tools. Queued processing uses its native command workflow; do not substitute an unrelated run.'],
  DIRECT_NOTE_CONTENT_REQUIRED: ['The interrupted direct-note submission needs its original content to finish drafting.', 'Retry the original requestId with the exact original arguments. Preserve the pending draft; a changed proposal requires an explicitly approved discard before a fresh request.'],
  DIRECT_NOTE_DRAFT_LIMIT: ['The complete direct-note draft exceeds the supported review size limit.', 'Preserve the original note, submitted content, and any retained draft. Report the limit instead of shortening content or removing metadata to force the save.'],
  NATIVE_COMMAND_MISMATCH: ['Cuefluent could not match this tracking or processing action to the current chat command.', 'Select the Cuefluent skill and send exactly one tracking or processing action. To create or update a note from supplied content, use the direct note tools instead.'],
  PROCESSING_ISOLATION_UNSUPPORTED: ['Cuefluent could not verify the restricted environment required for queued processing.', 'Check the installed client version and its sandbox capabilities. Keep queued input and pending drafts; do not weaken isolation to retry.'],
  PROCESSING_CLIENT_FAILED: ['The separate drafting client failed to complete its request.', 'Check that client\'s sign-in, provider/model availability, and diagnostic logs. Inspect the retained run before retrying; do not discard queued input.'],
  DIRECT_NOTE_APPROVAL_UNSUPPORTED: ['This client cannot display the confirmation required to save or discard a review draft.', 'Use a client that supports MCP form confirmation, then review the retained draft again. The draft remains pending.'],
  DIRECT_NOTE_APPROVAL_UNAVAILABLE: ['The client could not display the review confirmation.', 'Reconnect the client and review the retained draft again before retrying confirmation.'],
  DIRECT_NOTE_APPROVAL_TIMEOUT: ['The review confirmation was not completed within the available time.', 'Review the retained draft and request confirmation again when ready.'],
  DIRECT_NOTE_APPROVAL_CANCELLED: ['The review request or its connection was cancelled.', 'Inspect the retained draft and latest result before deciding whether to retry.'],
  DIRECT_NOTE_APPROVAL_DECLINED: ['The review confirmation was declined.', 'Keep or revise the draft as requested; do not retry saving without the user\'s approval.'],
  DIRECT_NOTE_APPROVAL_INVALID: ['The client returned an unsupported confirmation response.', 'Leave the draft pending and check the client\'s MCP form-confirmation support.'],
  MCP_FRAME_INVALID: ['The connector received a message that is not valid UTF-8 JSON.', 'Restart the connection. If it recurs, report this code and client version without including note or conversation content.'],
  MCP_FRAME_LIMIT: ['A connector message or its pending request queue exceeded the transport limit and closed the connection.', 'Reconnect the client with smaller requests or fewer concurrent calls. After reconnecting, inspect retained work and the latest outcome before retrying a mutation.'],
  MCP_FRAME_INCOMPLETE: ['The connector connection ended partway through a message.', 'Reconnect the client and inspect the latest result before retrying a save or processing request.'],
  CONTROL_REQUEST_LIMIT: ['The connector received too many pending requests and closed the connection.', 'Reconnect the client and send fewer concurrent requests. After reconnecting, inspect retained work and the latest outcome before retrying a mutation.'],
};
const DEFAULT = ['Cuefluent could not complete this operation.', 'Keep existing notes and pending work unchanged. Report the error code and diagnostic details to investigate the failure before retrying.'];
export const NOTE_TOOL_NAMES = Object.freeze(['cuefluent_projects', 'cuefluent_list_notes', 'cuefluent_read_note', 'cuefluent_create_note',
  'cuefluent_update_note', 'cuefluent_review_note', 'cuefluent_save_note', 'cuefluent_skip_note']);
const NOTE_TOOLS = new Set(NOTE_TOOL_NAMES);
const TOOL_NAMES = new Set(['cuefluent_control', 'cuefluent_invocation', ...NOTE_TOOLS]);
const data = (value, key) => value !== null && (typeof value === 'object' || typeof value === 'function') ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const codeOf = value => { const code = data(value, 'code'); return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : null; };

function guidance(code, { stage, operation, toolName }) {
  const base = Object.prototype.hasOwnProperty.call(GUIDANCE, code) ? GUIDANCE[code] : DEFAULT;
  if (operation === 'setup') {
    if (code === 'SETTINGS_CONFLICT') return [base[0], 'Read the current settings and reconcile the original setup proposal before retrying with its inspected settingsHash. Preserve pending work; do not refresh the hash merely to force the old proposal.'];
    if (code === 'EXPECTED_HASH_REQUIRED') return [base[0], 'Read settings and supply the returned settingsHash as expectedHash, using null only for fresh settings. Reconcile the complete agreed setup proposal with those settings before retrying.'];
    if (code === 'ENOENT') return ['The setup configuration or a required directory could not be found.', 'Check that the setup configuration file and its required parent directories still exist. Confirm the agreed project and destination paths before retrying setup.'];
  }
  if (NOTE_TOOLS.has(toolName)) {
    if (code === 'PROJECT_UNCONFIGURED') return [base[0], 'Call cuefluent_projects and use the exact projectId returned for the intended destination. Set up a project only if that destination is not configured.'];
    if (code === 'SETTINGS_CONFLICT') return ['The configured note destination or preferences changed during this operation.', 'Call cuefluent_projects to inspect the current destination and saving preferences. Restart note inspection and reconcile the intended proposal before retrying; preserve any pending draft and its recorded destination.'];
    if (code === 'EXPECTED_HASH_REQUIRED') return [base[0], 'Read the complete original with cuefluent_read_note, retaining the first whole-file hash for later chunks and the update. Reconcile the proposed content with that original; do not replace a hash merely to force an older draft.'];
    if (code === 'WORKSPACE_NOTE_UNREAD') return [base[0], 'Read the complete existing note with cuefluent_read_note, reconcile the requested change, then use cuefluent_update_note with its exact expectedHash. Preserve the existing note; creation requires an absent target.'];
    if (code === 'ENOENT') return ['A file needed for the selected note operation could not be found.',
      ['cuefluent_list_notes', 'cuefluent_read_note'].includes(toolName)
        ? 'Confirm the destination with cuefluent_projects and list the notes again. If the target exists, restart its read at byte zero before preparing an update. Preserve pending drafts and do not recreate a missing original automatically.'
        : 'Confirm the destination with cuefluent_projects and inspect the retained draft or latest outcome using the original identifiers before retrying. Recheck current note files; a missing original does not authorize a replacement.'];
  }
  if (code === 'ENOENT' && stage === 'module-load') return ['A required plugin file could not be found.', 'Check the installed plugin package and reinstall it through the marketplace if files are missing. Preserve private storage and notes.'];
  return base;
}

export function describeFailure(error, { fallback = 'CUEFLUENT_FAILED', stage, operation, toolName, client, version } = {}) {
  const code = codeOf(error) ?? codeOf({ code: fallback }) ?? 'CUEFLUENT_FAILED';
  const diagnostics = { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch };
  if (['runtime-check', 'module-load', 'command', 'transport', 'tool', 'result'].includes(stage)) diagnostics.stage = stage;
  if (entryOperation(operation)) diagnostics.operation = operation;
  if (TOOL_NAMES.has(toolName)) diagnostics.toolName = toolName;
  const [message, recovery] = guidance(code, diagnostics);
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
