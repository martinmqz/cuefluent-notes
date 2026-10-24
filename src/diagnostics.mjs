// Public diagnostics use fixed explanations, never exception messages, stacks,
// tool arguments, environment values, or paths taken from a caught exception.
const GUIDANCE = {
  NODE_VERSION_UNSUPPORTED: ['This Node.js version cannot run Cuefluent Notes. Node 26.12.1 or a later 26.x release is required.',
    'Install a supported Node version and make the client use it for both the connector and hooks, then restart the client. A terminal may use a different Node executable.'],
  ERR_MODULE_NOT_FOUND: ['A required plugin module or dependency could not be loaded.', 'Reinstall the plugin through its marketplace. Check the installed package path and the Node runtime shown below.'],
  MODULE_NOT_FOUND: ['A required plugin module or dependency could not be loaded.', 'Reinstall the plugin through its marketplace. Check the installed package path and the Node runtime shown below.'],
  ERR_UNKNOWN_BUILTIN_MODULE: ['This Node runtime is missing a built-in module required by the plugin.', 'Use a supported Node 26.12.1 or later 26.x installation and restart the client.'],
  PACKAGE_INVALID: ['The installed plugin has an invalid package identity or version.', 'Reinstall the plugin through its marketplace; do not edit its version or published files manually.'],
  ENOENT: ['A required file, directory, or executable could not be found.', 'Check the configured executable, installed plugin path, and working directory. This error alone does not identify which path is missing.'],
  EACCES: ['The operating system denied access to a required resource.', 'Check access to the configured paths under your account. Preserve existing permissions and share this diagnostic if the cause is unclear.'],
  EPERM: ['The operating system refused a required operation.', 'Check the client sandbox and access to the configured paths. Preserve security protections and share this diagnostic if the cause is unclear.'],
  PRIVATE_ACCESS_UNVERIFIED: ['Cuefluent could not verify that its private storage is accessible only to your account.', 'Use supported local storage and a supported Node runtime. On macOS, check that Node FFI is available and permitted; do not remove ACLs to bypass verification.'],
  GATE_UNSUPPORTED_RUNTIME: ['The runtime lacks the locking support required for safe note operations.', 'Use a supported Node 26.12.1 or later 26.x installation and restart the client.'],
  SETTINGS_CONFLICT: ['Cuefluent settings changed after they were inspected.', 'Read the current settings and reconcile the intended changes before retrying setup.'],
  PROJECT_UNCONFIGURED: ['The selected project has no configured notes destination.', 'Choose the project root, notes destination, and saving preferences before submitting a note.'],
  COMMAND_INVALID: ['Cuefluent received an invalid tracking or processing command.', 'Select the skill and send one supported action: track, untrack, process, process project, save, skip, or status. Use direct note tools for supplied content.'],
  ENTRY_ARGUMENT_INVALID: ['The plugin entrypoint received unsupported arguments.', 'Use the installed skill or the documented CLI syntax; check the connector command and arguments if startup keeps failing.'],
  CONTROL_ARGUMENT_INVALID: ['The tool arguments do not match the supported operation.', 'Use only the arguments in the advertised tool schema; do not supply chat identities or transcript paths.'],
  DIRECT_NOTE_ARGUMENT: ['The direct note request has invalid arguments.', 'Check the advertised tool schema, destination, fresh request UUID, and complete Markdown content before resubmitting.'],
  DIRECT_NOTE_CONFLICT: ['The note or its destination changed since it was inspected.', 'Read the current note completely and reconcile the proposed change. Review the revised draft; do not replace the hash just to force a save.'],
  DIRECT_NOTE_READ_INCOMPLETE: ['The existing note has not been read completely for this update.', 'Read every returned chunk in the same chat or connection, retaining the first whole-file hash, before preparing the replacement.'],
  DIRECT_NOTE_CONTEXT_UNAVAILABLE: ['The client did not provide the chat context needed to bind this note operation.', 'Use a supported client connection that supplies current-chat context. Preserve the existing note; do not invent a chat identity.'],
  DIRECT_NOTE_UPDATE_LIMIT: ['The existing note exceeds the supported direct-update size limit.', 'Preserve the original note. Do not shorten it or submit a partial replacement to fit the limit.'],
  DIRECT_NOTE_REQUEST_CHANGED: ['This request ID was already used with different note content or arguments.', 'Use a fresh UUID for a new proposal. Reuse an ID only when retrying the exact same request.'],
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
  MCP_FRAME_LIMIT: ['A connector message or its pending request queue exceeded the transport limit.', 'Reduce the request size or wait for pending requests to finish; inspect the latest result before retrying a mutation.'],
  MCP_FRAME_INCOMPLETE: ['The connector connection ended partway through a message.', 'Reconnect the client and inspect the latest result before retrying a save or processing request.'],
  CONTROL_REQUEST_LIMIT: ['The connector received more pending requests than it can safely handle.', 'Let outstanding requests finish or reconnect the client; inspect pending work before retrying mutations.'],
};
const DEFAULT = ['Cuefluent could not complete this operation.', 'Inspect the latest status before retrying a save or process request. Report the error code and diagnostic details if the problem continues.'];
const data = (value, key) => value !== null && (typeof value === 'object' || typeof value === 'function') ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const codeOf = value => { const code = data(value, 'code'); return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : null; };

export function supportsNode(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major === 26 && (minor > 12 || minor === 12 && patch >= 1);
}

export function describeFailure(error, { fallback = 'CUEFLUENT_FAILED', stage, operation, client, version } = {}) {
  const code = codeOf(error) ?? fallback;
  const [message, recovery] = Object.prototype.hasOwnProperty.call(GUIDANCE, code) ? GUIDANCE[code] : DEFAULT;
  const diagnostics = { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch };
  if (['runtime-check', 'module-load', 'command', 'transport', 'tool'].includes(stage)) diagnostics.stage = stage;
  if (['mcp', 'hook', 'setup', 'settings', 'status', 'sync-steward', 'sync-collect', 'command-worker'].includes(operation)) diagnostics.operation = operation;
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

export function reportFailure(error, context = {}) {
  const result = describeFailure(error, context);
  // Only the actual runtime executable is included, never an exception's path.
  // JSON escaping keeps unusual filenames from injecting diagnostic lines.
  const executable = process.execPath.length <= 4096 ? process.execPath : '(path exceeds diagnostic limit)';
  const message = `Cuefluent Notes [${result.error}]: ${result.message}\nNext step: ${result.recovery}\nDiagnostics: ${JSON.stringify({ ...result.diagnostics, executable })}`;
  if (context.operation === 'hook') process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
  else process.stderr.write(message + '\n');
}
