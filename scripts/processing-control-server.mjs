import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CLIENTS, PROCESSING_SCOPES, canonicalJSON, digest, choice, fail, hash, id, keys, list, nativeId, object, string, unique, integer } from './workflow-values.mjs';
import { DISPLAY_CONTROLS, displayEscape, displayScalar } from './file-io.mjs';
import { REVIEW_CODE, REVIEW_COMMANDS, REVIEW_DECISIONS, REVIEW_CODE_PLACEHOLDER, REVIEW_CODE_EXCLUDED, PROCESSING_HELP, reviewControl,
  isProcessingControlSuggestion } from './processing-control-proof.mjs';

const INPUT_BYTES = 64 * 1024, OUTPUT_BYTES = 16 * 1024;
const FORM_BYTES = 256 * 1024, QUEUED_REQUESTS = 16;
// The review contract requires string defaults. Offer this supported revision
// even when a client's initial preference is older; hosts confirm support by
// continuing initialization with the offered revision.
const PROTOCOL_VERSION = '2025-11-25';
// Hosts can encode one character as six ASCII bytes (\\uXXXX), including each
// UTF-16 surrogate. This fixed framing bound also admits a delayed echo after
// its form closes. Ordinary requests retain INPUT_BYTES after classification.
const FRAME_BYTES = 6 * FORM_BYTES;
const STATES = ['missing', 'creating', 'busy', 'idle', 'awaiting-review', 'blocked', 'completed'];
const ACTIONS = ['inspect', 'process', 'resume', 'review', 'cancel', 'wait', 'none'];
// The optional detail distinguishes a request outcome from a state snapshot.
// Absence retains the original projection for immutable response receipts.
// A text names commands through `cmd`, which spells them for the client.
const STATUS_DETAILS = Object.freeze({
  accepted: { states: ['busy'], text: () => 'Processing request accepted.' },
  'already-processing': { states: ['creating', 'busy'], text: () => 'Already processing; no additional run was started.' },
  processing: { states: ['busy'], text: () => 'Processing is in progress.' },
  preparing: { states: ['creating'], text: () => 'Preparing the processing session.' },
  'draft-ready': { states: ['awaiting-review'], text: () => 'Draft ready for review.' },
  unfinished: { states: ['idle'], text: () => 'Processing stopped with unfinished work.' },
  inactive: { states: ['idle'], text: () => 'No processing run is active.' },
  missing: { states: ['missing'], text: () => 'No processing session has been started.' },
  'selection-limit': { states: ['blocked'], text: cmd => `The saved selection reached its continuation limit. Cancel it with ${cmd('process cancel')}, then use ${cmd('process')} for remaining captures.` },
  blocked: { states: ['blocked'], text: () => 'Processing needs attention.' },
  completed: { states: ['completed'], text: () => 'Processing operation completed.' },
  'selection-complete': { states: ['missing', 'idle', 'completed'], text: () => 'Selected captures have been handled.' },
  pending: { states: ['missing', 'idle'], text: cmd => `Pending captures are available. Use ${cmd('process')} to draft notes.` },
  'inventory-incomplete': { states: ['missing', 'idle'], text: cmd => `The bounded inventory is incomplete. Use ${cmd('process')} to continue through pending captures.` },
  'nothing-pending': { states: ['missing', 'idle', 'completed'], text: () => 'No pending captures in the selected scope.' },
  'nothing-to-resume': { states: ['missing', 'idle', 'completed'], text: () => 'No unfinished processing selection to resume.' },
  discovery: { states: ['missing', 'idle'], text: cmd => `Inventory paused; ${cmd('process resume')} continues from its saved position.` },
  continuation: { states: ['idle'], text: cmd => `Selected evidence remains. Use ${cmd('process resume')} to continue.` },
  cancelled: { states: ['idle', 'completed', 'missing'], text: () => 'Processing cancelled; unhandled captures remain pending.' },
  // No verified source binding (for example before setup); only the command list.
  unbound: { states: ['missing'], text: cmd => `Nothing was applied: this chat has no verified Cuefluent Notes source yet. To set up Cuefluent Notes, type ${cmd('setup')}.` },
});
// A review result is separate from draft state: a pending draft does not show
// that a form opened. Pending outcomes describe only what the host returned.
// Texts take the named draft ("draft k2mn9p ("notes/a.md")") when one is known.
const REVIEW_OUTCOMES = Object.freeze({
  saved: { pending: false, text: name => name ? `Review completed: the exact reviewed proposal of ${name} was saved.` : 'Review completed: the exact reviewed proposal was saved.' },
  skipped: { pending: false, text: name => name ? `Review completed: the captures of ${name} were skipped without saving.` : 'Review completed: these captures were skipped without saving.' },
  cancelled: { pending: false, text: name => `Review completed: the operation${name ? ` for ${name}` : ''} was cancelled; its captures remain pending.` },
  deferred: { pending: true, text: name => `Review deferred with Later. ${capital(name ?? 'the draft')} remains pending; nothing was saved.` },
  declined: { pending: true, text: name => `Review not completed: the client declined or closed the review form, which may not have been displayed. ${capital(name ?? 'the draft')} remains pending; nothing was saved.` },
  'display-altered': { pending: true, text: name => `Review not completed: the client changed the preview text, so the complete proposal may not have been readable. Nothing was saved, skipped or cancelled; ${name ?? 'the draft'} remains pending.` },
  unavailable: { pending: true, text: () => 'Review unavailable: this client did not report review form support. The draft remains pending; nothing was saved.' },
  // Review folder and typed decisions. Their text is built from bounded fields.
  presented: { pending: true, text: null },
  'not-shown': { pending: null, text: null },
  unverified: { pending: null, text: null },
  changed: { pending: null, text: null },
  unresolved: { pending: null, text: null },
});
const REVIEW_FILES_SHOWN = 5, REVIEW_DRAFTS_SHOWN = 4, REVIEW_PATH_BYTES = 160, REVIEW_FOLDER_BYTES = 1024, REVIEW_NOTE_PATH_BYTES = 512;
/** A note path bounded for a review reply, which must fit the transport and its
 * receipt. Display only: summary.txt in the review folder keeps every full path. */
export function reviewNotePath(value) {
  if (Buffer.byteLength(value) <= REVIEW_NOTE_PATH_BYTES) return value;
  let text = '';
  for (const char of value) { if (Buffer.byteLength(text + char + '…') > REVIEW_NOTE_PATH_BYTES) break; text += char; }
  return `${text}…`;
}
const notePath = value => { string(value, REVIEW_NOTE_PATH_BYTES); if (Buffer.byteLength(value) > REVIEW_NOTE_PATH_BYTES) fail('PROCESSING_CONTROL_OUTPUT_INVALID'); return value; };
// Untrusted note paths are quoted, escaped and bounded; the folder is a private
// path the person opens, so only its controls are escaped.
function displayPath(value) {
  let text = '';
  for (const char of value) {
    if (Buffer.byteLength(displayScalar(text + char)) > REVIEW_PATH_BYTES) return `${displayScalar(text).slice(0, -1)}…"`;
    text += char;
  }
  return displayScalar(text);
}
const displayFolder = value => value.replace(DISPLAY_CONTROLS, displayEscape);
const reviewCode = value => { if (typeof value !== 'string' || !REVIEW_CODE.test(value)) fail('PROCESSING_CONTROL_OUTPUT_INVALID'); return value; };
const fileCount = value => { integer(value); if (value < 1 || value > 100) fail('PROCESSING_CONTROL_OUTPUT_INVALID'); return value; };
// A draft in a reply: its code alone, its code with its first note path (named),
// or its review folder with the files shown.
function reviewDraft(value) {
  keys(value, ['code'], ['path', 'folder', 'files', 'fileCount']);
  const result = { code: reviewCode(value.code) };
  if (Object.keys(value).length === 1) return result;
  if (value.folder === undefined) {
    keys(value, ['code', 'path', 'fileCount']);
    return { ...result, path: notePath(value.path), fileCount: fileCount(value.fileCount) };
  }
  keys(value, ['code', 'folder', 'files', 'fileCount']);
  string(value.folder, REVIEW_FOLDER_BYTES);
  if (!path.isAbsolute(value.folder) || Buffer.byteLength(displayFolder(value.folder)) > REVIEW_FOLDER_BYTES) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
  fileCount(value.fileCount);
  list(value.files, REVIEW_FILES_SHOWN, { empty: false });
  if (value.files.length !== Math.min(value.fileCount, REVIEW_FILES_SHOWN)) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
  return { ...result, folder: value.folder, fileCount: value.fileCount, files: value.files.map(file => {
    keys(file, ['path', 'bytes', 'change']); integer(file.bytes);
    return { path: notePath(file.path), bytes: file.bytes, change: choice(file.change, ['create', 'update']) };
  }) };
}
// A listing of pending drafts; with `status --verbose` each also names its exact revision.
const REVISION = ['operationId', 'proposalHash', 'claimHash'];
function reviewDrafts(value, { revisions = false } = {}) {
  list(value, REVIEW_DRAFTS_SHOWN); unique(value.map(item => item?.code));
  return value.map(item => {
    keys(item, ['code', 'path', 'fileCount', ...(revisions ? REVISION : [])]);
    const listed = { code: reviewCode(item.code), path: notePath(item.path), fileCount: fileCount(item.fileCount) };
    if (revisions) { nativeId(item.operationId); hash(item.proposalHash); hash(item.claimHash); }
    return revisions ? { ...listed, operationId: item.operationId, proposalHash: item.proposalHash, claimHash: item.claimHash } : listed;
  });
}
const capital = text => text[0].toUpperCase() + text.slice(1);
const moreFiles = count => count > 1 ? ` and ${count - 1} more file${count > 2 ? 's' : ''}` : '';
// "draft k2mn9p ("notes/a.md")": every line about a draft names its note path when it is known.
const draftName = draft => {
  const first = draft?.path ?? draft?.files?.[0]?.path;
  return draft === undefined ? undefined : `draft ${draft.code}${first === undefined ? '' : ` (${displayPath(first)}${moreFiles(draft.fileCount)})`}`;
};
// One pending draft per line: its code, two spaces and its first note path.
const listingLine = item => `${item.code}  ${displayPath(item.path)}${item.fileCount > 1 ? ` (+${item.fileCount - 1} more)` : ''}`;
const listingLines = (title, drafts) => [title, ...drafts.map(listingLine)];
// One short paragraph for the person: where to read the draft and what to
// type. Hashes, operation IDs and diagnostics stay in the private files.
function reviewText(review, { draft, drafts, commandPrefix: command }) {
  const code = draft?.code, name = draftName(draft), cmd = words => `${command} ${words}`;
  const choices = `To decide, type ${cmd(`save ${code}`)} or ${cmd(`skip ${code}`)}.`;
  const lines = [];
  if (review === 'presented') {
    lines.push(`${capital(name)} is ready for review; nothing has been saved.`, `Review folder: ${displayFolder(draft.folder)}`,
      ...draft.files.map(file => `- ${displayPath(file.path)} (${file.change === 'create' ? 'new note' : 'update'}, ${file.bytes} bytes)`));
    if (draft.fileCount > draft.files.length) lines.push(`- and ${draft.fileCount - draft.files.length} more files listed in summary.txt`);
    lines.push(choices);
    if (drafts?.length) lines.push(...listingLines('Other drafts:', drafts));
  } else if (review === 'not-shown') {
    lines.push(`Nothing was applied: ${name} has not been shown in this chat by a typed review. Read it first with ${cmd(`review ${code}`)}.`);
  } else if (review === 'unverified') {
    lines.push(`Nothing was applied${name ? ` to ${name}` : ''}: a review decision counts only when you type the exact command yourself, for example ${cmd(`save ${code ?? REVIEW_CODE_PLACEHOLDER}`)}.`);
  } else if (review === 'changed') {
    lines.push(`Nothing was applied: ${name ?? 'that draft'} changed, its destination changed, or it is no longer pending. Review the current draft with ${cmd('review')} before deciding; if a note changed, restore it or process again.`);
    if (drafts?.length) lines.push(...listingLines('Pending drafts:', drafts));
  } else if (review === 'unresolved') {
    lines.push(`Nothing was applied: name the draft to decide on, as in ${cmd(`save ${REVIEW_CODE_PLACEHOLDER}`)}, after reading it with ${cmd(`review ${REVIEW_CODE_PLACEHOLDER}`)}.`,
      ...(drafts.length ? listingLines('Pending drafts:', drafts) : ['No drafts are pending.']));
  } else {
    lines.push(REVIEW_OUTCOMES[review].text(name));
    if (draft?.folder) lines.push(`Review folder: ${displayFolder(draft.folder)}`, choices);
  }
  return `Cuefluent: ${lines.join('\n')}`;
}
// A typed skill invocation that was not one exact action: nothing was applied.
// The suggestions come from the grammar; any code in them is a valid draft code.
function notACommandText({ suggestions, commandPrefix: command }) {
  const typed = suggestions.map(text => `${command} ${text}`);
  const choices = typed.length === 1 ? typed[0] : `${typed.slice(0, -1).join(', ')} or ${typed.at(-1)}`;
  const lines = [`Nothing was applied: that was not an exact command. Type the command yourself, exactly as written, for example ${choices}.`];
  if (suggestions.some(text => text.includes(REVIEW_CODE_PLACEHOLDER))) {
    lines.push(`A draft code has six characters and never contains ${REVIEW_CODE_EXCLUDED.join(', ')}; ${command} review shows the current draft and its code.`);
  }
  return `Cuefluent: ${lines.join('\n')}`;
}
// The command list, from the grammar: each first word on its own line with
// what it does and its other forms. It applies nothing.
function helpText({ commandPrefix: command, statusDetail }) {
  const intro = statusDetail === 'unbound' ? `${STATUS_DETAILS.unbound.text(words => `${command} ${words}`)} The commands, typed exactly as written:`
    : 'Nothing was applied. Type one of these yourself, exactly as written:';
  return [`Cuefluent: ${intro}`,
    ...PROCESSING_HELP.map(item => `${command} ${item.word}: ${item.summary}${item.also.length ? ` (also: ${item.also.join(', ')})` : ''}.`)].join('\n');
}
// Every detail the plain reply leaves out, for `status --verbose`.
function verboseText(result) {
  const counts = (label, value, names) => `${label}${value.incomplete ? ' (partial)' : ''}: ${names.map(([key, text]) => `${value[key]} ${text}`).join(', ')}.`;
  const lines = [result.statusText, `Status: ${result.status}; next action: ${result.nextAction}.`,
    `Diagnostics: ${result.diagnostics.length ? result.diagnostics.join(', ') : 'none'}.`];
  if (result.requestId !== null) lines.push(`Request: ${result.requestId}.`);
  if (result.chat) lines.push(`Processing chat: ${result.chat.client} session ${result.chat.sessionId}.`);
  if (result.scope) lines.push(`Scope: ${result.scope}.`);
  if (result.inventory) lines.push(counts('Inventory', result.inventory, [['pending', 'pending'], ['claimed', 'claimed'], ['blockedByClaim', 'blocked by a claim'],
    ['inspected', 'inspected'], ['handled', 'handled'], ['unfinishedOperations', 'unfinished operations'], ['awaitingReview', 'awaiting review']]));
  if (result.progress) lines.push(counts('Progress', result.progress, [['selected', 'selected'], ['unattempted', 'unattempted'], ['handled', 'handled'],
    ['unavailable', 'unavailable'], ['cancelled', 'cancelled'], ['unfinishedOperations', 'unfinished operations'], ['awaitingReview', 'awaiting review']]));
  if (result.drafts?.length) {
    lines.push('Drafts awaiting review:');
    for (const item of result.drafts) lines.push(listingLine(item), `  operation ${item.operationId}; proposal ${item.proposalHash}; claim ${item.claimHash}`);
  }
  return lines.join('\n');
}
// Which review fields each outcome carries: a draft with its folder, a draft
// code with or without its note path, or either ('?' marks an optional
// draft); a listing of drafts.
const REVIEW_FIELDS = Object.freeze({ presented: { draft: 'folder', drafts: true }, 'not-shown': { draft: 'code' },
  unverified: { draft: 'code?' }, changed: { draft: 'code?', drafts: true }, unresolved: { drafts: 'required' },
  saved: { draft: 'code?' }, skipped: { draft: 'code?' }, cancelled: { draft: 'code?' },
  deferred: { draft: 'any?' }, declined: { draft: 'any?' }, 'display-altered': { draft: 'any?' } });
function checkReviewFields(fields, draft, drafts) {
  const need = fields.draft;
  if (draft === undefined ? need === 'folder' || need === 'code'
    : need === undefined || (need === 'folder' && draft.folder === undefined) || (['code', 'code?'].includes(need) && draft.folder !== undefined)) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
  if (drafts === undefined ? fields.drafts === 'required' : !fields.drafts) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
}
const DIAGNOSTICS = Object.freeze(['PROCESSING_CONTROL_SOURCE_UNVERIFIED', 'PROCESSING_CONTROL_FAILED',
  'PROCESSING_INVENTORY_CHANGED', 'PROCESSING_OPERATION_OWNER_UNVERIFIED', 'PROCESSING_CHAT_HISTORY_FULL', 'PROCESSING_CHAT_BUSY', 'PROCESSING_CHAT_BLOCKED', 'PROCESSING_CHAT_MISSING', 'PROCESSING_CHAT_BINDING_CHANGED',
  'PROCESSING_CHAT_HOST_UNAVAILABLE', 'PROCESSING_CHAT_SESSION_UNAVAILABLE', 'PROCESSING_CHAT_OUTCOME_UNKNOWN',
  'WORKSET_OUTCOME_UNKNOWN', 'PROCESSING_SHORTCUT_CHANGED', 'PROCESSING_SHORTCUT_SCOPE_CONFLICT', 'PROCESSING_CANCEL_UNVERIFIED',
  'PROCESSING_CANCELLATION_PENDING', 'PROCESSING_SHORTCUT_CAPACITY', 'PROCESSING_REPOSITORY_UNVERIFIED', 'PROCESSING_INVENTORY_INCOMPLETE',
  'PROCESSING_REINSPECTION_REQUIRED', 'PROCESSING_BINDING_CHANGED', 'PROCESSING_INPUT_BUDGET', 'PROCESSING_COLLECTION_BUSY', 'PROCESSING_CHAT_CONFLICT', 'PROCESSING_RECOVERY_REQUIRED', 'WRITER_RECOVERY_REQUIRED',
  'WORKFLOW_POLICY_CHANGED', 'PROCESSING_APPROVAL_REQUIRED', 'PROCESSING_SELECTION_CHANGED',
  'PROCESSING_REVIEW_UNSUPPORTED', 'PROCESSING_REVIEW_TOO_LARGE', 'PROCESSING_REVIEW_LIMIT', 'PROCESSING_REVIEW_INTERRUPTED', 'PROCESSING_REVIEW_PREVIEW_CHANGED',
  'PROCESSING_CHAT_REVIEW_UNRESOLVED', 'PROCESSING_CHAT_POLICY_CHANGED', 'PROCESSING_CHAT_STATE_CHANGED',
  'PROCESSING_EXCLUSION_UNVERIFIED', 'PROCESSING_OPERATION_OUTCOME_UNKNOWN', 'PROCESSING_OPERATION_CONFLICT',
  'PROCESSING_CLIENT_FAILED', 'PROCESSING_CLIENT_INTERRUPTED', 'PROCESSING_CLIENT_UNAVAILABLE',
  'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE', 'PROCESSING_CLIENT_AUTHENTICATION_INVALID', 'PROCESSING_CLIENT_IDENTITY_CHANGED',
  'PROCESSING_CLIENT_SETTINGS_INVALID', 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE',
  'PROCESSING_CLIENT_SETTINGS_LIMIT', 'PROCESSING_CLIENT_SETTINGS_UNSUPPORTED', 'INTAKE_BLOCKED']);
const ERRORS = new Set([...DIAGNOSTICS, 'PROCESSING_CONTROL_PROTOCOL', 'PROCESSING_CONTROL_INPUT_LIMIT',
  'PROCESSING_CONTROL_OUTPUT_INVALID', 'PROCESSING_CONTROL_METHOD_UNSUPPORTED', 'PROCESSING_CONTROL_INVALID_REQUEST',
  'PROCESSING_CONTROL_SELECTION_MISMATCH', 'PROCESSING_REVIEW_REQUIRED', 'PROCESSING_OUTPUT_CHANGED',
  'PROCESSING_REVIEW_STATE_INVALID', 'PROCESSING_REVIEW_CODE_CONFLICT', 'PROCESSING_REVIEW_FILES_CHANGED',
  'PROCESSING_PROPOSAL_CHANGED', 'PROCESSING_CLAIM_CHANGED', 'STALE_SELECTION', 'PROCESSING_CHAT_REQUEST_CONFLICT',
  'PROCESSING_SOURCE_DISCOVERY_LIMIT', 'PROCESSING_SOURCE_CHANGED', 'PROCESSING_SOURCE_UNAVAILABLE',
  'PROCESSING_SOURCE_AMBIGUOUS', 'PROCESSING_CLIENT_UNAVAILABLE', 'PROCESSING_CLIENT_OUTCOME_UNKNOWN',
  'PROCESSING_CLIENT_POLICY_CHANGED', 'PROCESSING_CHAT_HISTORY_FULL', 'PROCESSING_CHAT_BINDINGS_FULL',
  'PROCESSING_CONTROL_RECEIPT_CONFLICT', 'WORKFLOW_NOT_AUTHORIZED', 'PROCESSING_OPERATION_COMPLETE',
  'PROCESSING_STATE_CHANGED', 'PROCESSING_CONTROL_SOURCE_DISCOVERY_INCOMPLETE',
  'PROCESSING_CONTROL_REGISTRATION_UNVERIFIED', 'REGISTRATION_REQUIRES_REVIEW',
  'UNSAFE_INTAKE_PATH', 'UNSAFE_PRIVATE_STORAGE', 'STORAGE_NOT_PRIVATE', 'INTAKE_ROOT_CHANGED', 'PRIVATE_STORAGE_CHANGED',
  'UNSUPPORTED_SESSION_OWNERSHIP', 'UNSUPPORTED_CODEX_HISTORY', 'SOURCE_IDENTITY_MISMATCH']);
const codexSourceErrors = new Set(['UNSUPPORTED_SESSION_OWNERSHIP', 'UNSUPPORTED_CODEX_HISTORY', 'SOURCE_IDENTITY_MISMATCH']);
const uuidSchema = { type: 'string', pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' };
const retrySchema = { ...uuidSchema, description: 'Opaque token returned for native verification. End the current exec, then repeat the same tool and arguments with this token. Never invent one.' };
const collectionSchema = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' };
const selectionSchema = { type: 'object', additionalProperties: false, required: ['client', 'sessionId', 'cwd'],
  properties: { client: { type: 'string', enum: CLIENTS }, sessionId: uuidSchema,
    cwd: { type: 'string', minLength: 1, maxLength: 4096 }, unitId: uuidSchema } };
const scopeSchema = { type: 'string', enum: PROCESSING_SCOPES, description: 'Pending retained evidence scope; defaults to the existing collection.' };
const toolsFor = client => [
  client === 'claude'
    ? { name: 'processing_status', description: 'Read bounded processing-chat status for the selected collection, or the command list. Returns no evidence or drafts. Set verbose or help only when the user typed status --verbose or help.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { collectionId: collectionSchema, retryToken: retrySchema,
        verbose: { type: 'boolean', description: 'true when the user typed status --verbose; otherwise omit.' },
        help: { type: 'boolean', description: 'true when the user typed help; otherwise omit.' } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
    : { name: 'processing_status', description: 'Read bounded processing-chat status for the selected collection, or the command list. Returns no evidence or drafts. The user\'s typed text selects status --verbose or help; tool arguments never do.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { collectionId: collectionSchema, retryToken: retrySchema } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'process_selected_captures', description: 'Request the existing Cuefluent Notes skill processing workflow in its reusable excluded chat. Requires verified native source context and existing consent. Returns only status; never approves or saves a proposal.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { collectionId: collectionSchema, retryToken: retrySchema, requestId: uuidSchema, selection: selectionSchema, scope: scopeSchema } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ...[
    ['processing_resume', 'Resume the saved unfinished evidence selection without adding new captures. Never saves notes.'],
    ['processing_cancel', 'Stop the owned processing run and release unapplied operations after verified termination. Keeps captures pending and settings unchanged.']
  ].map(([name, description]) => ({ name, description,
    inputSchema: { type: 'object', additionalProperties: false, properties: { collectionId: collectionSchema, retryToken: retrySchema } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } })),
  client === 'claude'
    ? { name: 'processing_review', description: 'Write the exact outstanding proposal to a private review folder and return its path. A save, skip or cancel applies only when the user typed that exact command. Copy draft and decision from the typed command; never add or change them yourself.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { collectionId: collectionSchema, retryToken: retrySchema,
        draft: { type: 'string', pattern: REVIEW_CODE.source, description: 'The draft code from the user\'s typed review command, if any.' },
        decision: { type: 'string', enum: REVIEW_DECISIONS, description: 'save or skip from the user\'s typed save or skip command, or cancel from a typed review cancel, if any. Never infer it.' } } },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
    : { name: 'processing_review', description: 'Write the exact outstanding proposal to a private review folder and open native review controls. Only a native host response or the user\'s exact typed command can save, skip or cancel. Tool arguments never authorize an outcome.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { collectionId: collectionSchema, retryToken: retrySchema } },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
];

const token = value => {
  string(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  return value;
};
function nativeContext(client, meta, env) {
  try {
    if (!object(meta)) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    if (client === 'codex') {
      if (Object.hasOwn(meta, 'claudecode/toolUseId')) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      const turn = meta['x-codex-turn-metadata'];
      if (!object(turn)) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      nativeId(turn.session_id); nativeId(turn.thread_id); nativeId(turn.turn_id);
      if (turn.session_id !== turn.thread_id) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      for (const key of ['sessionId', 'threadId']) {
        if (Object.hasOwn(meta, key) && meta[key] !== turn.session_id) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      }
      return Object.freeze({ client, sessionId: turn.session_id, unitId: turn.turn_id,
        toolCallId: token(meta.callId), itemId: token(meta.itemId) });
    }
    if (Object.hasOwn(meta, 'x-codex-turn-metadata') || Object.hasOwn(meta, 'sessionId') || Object.hasOwn(meta, 'threadId')) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    return Object.freeze({ client, sessionId: nativeId(env.CLAUDE_CODE_SESSION_ID), toolCallId: token(meta['claudecode/toolUseId']) });
  } catch { fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED'); }
}

function argumentsFor(name, args, client) {
  try {
    // Claude copies a typed action's fields; Codex refuses them because its
    // verified typed text alone names the draft, decision, verbosity or help.
    if (name === 'processing_review' && client === 'claude') keys(args, [], ['collectionId', 'retryToken', 'draft', 'decision']);
    else if (name === 'processing_status' && client === 'claude') keys(args, [], ['collectionId', 'retryToken', 'verbose', 'help']);
    else if (['processing_status', 'processing_review', 'processing_resume', 'processing_cancel'].includes(name)) keys(args, [], ['collectionId', 'retryToken']);
    else if (name === 'process_selected_captures') keys(args, [], ['requestId', 'collectionId', 'selection', 'retryToken', 'scope']);
    else fail('PROCESSING_CONTROL_METHOD_UNSUPPORTED');
    if (args.collectionId !== undefined) id(args.collectionId);
    if (args.requestId !== undefined) nativeId(args.requestId);
    if (args.retryToken !== undefined) nativeId(args.retryToken);
    const result = args.collectionId === undefined ? {} : { collectionId: args.collectionId };
    if (args.requestId !== undefined) result.requestId = args.requestId;
    if (args.scope !== undefined) result.scope = choice(args.scope, PROCESSING_SCOPES);
    // Only `true`, and never both: each names one typed status form.
    if (args.verbose !== undefined || args.help !== undefined) {
      if (![args.verbose, args.help].includes(true) || [args.verbose, args.help].some(item => item !== undefined && item !== true) ||
          (args.verbose !== undefined && args.help !== undefined)) fail('PROCESSING_CONTROL_INVALID_REQUEST');
      if (args.verbose) result.verbose = true;
      if (args.help) result.help = true;
    }
    if (args.draft !== undefined || args.decision !== undefined) {
      if (reviewControl({ draft: args.draft, decision: args.decision }) === null) fail('PROCESSING_CONTROL_INVALID_REQUEST');
      if (args.draft !== undefined) result.draft = args.draft;
      if (args.decision !== undefined) result.decision = args.decision;
    }
    if (args.selection !== undefined) {
      keys(args.selection, ['client', 'sessionId', 'cwd'], ['unitId']);
      choice(args.selection.client, CLIENTS); nativeId(args.selection.sessionId); string(args.selection.cwd);
      if (!path.isAbsolute(args.selection.cwd)) fail('PROCESSING_CONTROL_INVALID_REQUEST');
      if (args.selection.unitId !== undefined) nativeId(args.selection.unitId);
      result.selection = Object.freeze({ ...args.selection });
    }
    return Object.freeze(result);
  } catch (error) {
    if (error.code === 'PROCESSING_CONTROL_METHOD_UNSUPPORTED') throw error;
    fail('PROCESSING_CONTROL_INVALID_REQUEST');
  }
}

/** Project a callback result without copying callback prose, evidence, proposals,
 * private paths or future implementation fields into a captured source chat.
 * Visible text never carries hashes, identifiers or diagnostic codes, with two
 * exceptions: review replies name the private review folder the person opens
 * and the bounded, escaped note paths and sizes of drafts (never note content),
 * and the reply to `status --verbose` lists the diagnostics, identifiers and
 * exact draft revisions the plain reply leaves out. */
export function processingControlStatusView(value, args) {
  try {
    if (!object(value)) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
    choice(value.status, STATES); choice(value.nextAction, ACTIONS);
    const result = { interfaceVersion: 1, collectionId: args.collectionId, status: value.status,
      requestId: value.requestId ?? null, chat: null, nextAction: value.nextAction,
      diagnostics: [], statusText: `Cuefluent processing: ${value.status}.` };
    if (result.requestId !== null) nativeId(result.requestId);
    if (value.chat !== undefined && value.chat !== null) {
      choice(value.chat.client, CLIENTS); nativeId(value.chat.sessionId);
      result.chat = { client: value.chat.client, sessionId: value.chat.sessionId };
    }
    list(value.diagnostics ?? [], 8); unique(value.diagnostics ?? []);
    for (const diagnostic of value.diagnostics ?? []) {
      choice(diagnostic, DIAGNOSTICS); result.diagnostics.push(diagnostic);
    }
    // Commands in visible text use the client's spelling when it is known.
    if (value.commandPrefix !== undefined) result.commandPrefix = choice(value.commandPrefix, Object.values(REVIEW_COMMANDS));
    const cmd = words => result.commandPrefix === undefined ? words : `${result.commandPrefix} ${words}`;
    if (value.statusDetail !== undefined) {
      choice(value.statusDetail, Object.keys(STATUS_DETAILS));
      const detail = STATUS_DETAILS[value.statusDetail];
      choice(result.status, detail.states);
      result.statusDetail = value.statusDetail;
      result.statusText = `Cuefluent: ${detail.text(cmd)}`;
    }
    // A reply of its own: a review outcome, a typed non-command, the command
    // list, or every detail; at most one of them.
    const kinds = ['review', 'command', 'help', 'verbose'].filter(key => value[key] !== undefined);
    if (kinds.length > 1 || (value.help !== undefined && value.help !== true) || (value.verbose !== undefined && value.verbose !== true)) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
    let reviewReply = false, ownReply = false;
    if (value.review !== undefined) {
      choice(value.review, Object.keys(REVIEW_OUTCOMES));
      const outcome = REVIEW_OUTCOMES[value.review], fields = REVIEW_FIELDS[value.review] ?? {};
      if (outcome.pending && result.status !== 'awaiting-review') fail('PROCESSING_CONTROL_OUTPUT_INVALID');
      result.review = value.review;
      const draft = value.draft === undefined ? undefined : reviewDraft(value.draft);
      const drafts = value.drafts === undefined ? undefined : reviewDrafts(value.drafts);
      checkReviewFields(fields, draft, drafts);
      // Every reply built from these fields names its command spelling.
      reviewReply = outcome.text === null || draft !== undefined;
      if (reviewReply && result.commandPrefix === undefined) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
      // A completed review can leave another draft pending; say both.
      const after = outcome.pending === false && result.statusDetail ? ` ${STATUS_DETAILS[result.statusDetail].text(cmd)}` : '';
      if (reviewReply) {
        if (draft) result.draft = draft;
        if (drafts) result.drafts = drafts;
        result.statusText = reviewText(value.review, result) + after;
      } else result.statusText = `Cuefluent: ${outcome.text()}${after}`;
    }
    if (value.command !== undefined) {
      if (value.command !== 'not-a-command') fail('PROCESSING_CONTROL_OUTPUT_INVALID');
      list(value.suggestions, 3, { empty: false }); unique(value.suggestions);
      if (value.suggestions.some(text => typeof text !== 'string' || !isProcessingControlSuggestion(text))) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
      if (result.commandPrefix === undefined) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
      result.command = value.command; result.suggestions = [...value.suggestions];
      result.statusText = notACommandText(result); ownReply = true;
    }
    if (value.help !== undefined) {
      if (result.commandPrefix === undefined) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
      result.help = true; result.statusText = helpText(result); ownReply = true;
    }
    if (value.verbose !== undefined) result.verbose = true;
    // A listing of drafts awaiting review belongs to a status reply.
    if (value.review === undefined && value.drafts !== undefined && !ownReply) result.drafts = reviewDrafts(value.drafts, { revisions: result.verbose === true });
    if (value.scope !== undefined) result.scope = choice(value.scope, PROCESSING_SCOPES);
    if (value.progress !== undefined) {
      keys(value.progress, ['selected', 'unattempted', 'handled', 'unavailable', 'cancelled', 'unfinishedOperations', 'awaitingReview', 'incomplete']);
      const { incomplete, ...counts } = value.progress;
      for (const count of Object.values(counts)) { integer(count); if (count > 10000) fail('PROCESSING_CONTROL_OUTPUT_INVALID'); }
      if (typeof incomplete !== 'boolean') fail('PROCESSING_CONTROL_OUTPUT_INVALID');
      result.progress = { ...counts, incomplete };
    }
    if (value.inventory !== undefined) {
      keys(value.inventory, ['pending', 'claimed', 'blockedByClaim', 'inspected', 'handled', 'incomplete', 'unfinishedOperations', 'awaitingReview', 'sourceCompleteness']);
      const { incomplete, sourceCompleteness, ...counts } = value.inventory;
      for (const count of Object.values(counts)) { integer(count); if (count > 10000) fail('PROCESSING_CONTROL_OUTPUT_INVALID'); }
      if (typeof incomplete !== 'boolean' || sourceCompleteness !== 'unknown') fail('PROCESSING_CONTROL_OUTPUT_INVALID');
      result.inventory = { ...counts, incomplete, sourceCompleteness };
    }
    // A reply of its own carries only its own text: no counts, scope or listing.
    if (result.verbose && !ownReply) result.statusText = verboseText(result);
    else if (!ownReply) {
      if (result.scope) result.statusText += ` Scope: ${result.scope}.`;
      if (result.inventory) {
        const { incomplete, pending, claimed, awaitingReview } = result.inventory;
        result.statusText += ` Inventory${incomplete ? ' (partial)' : ''}: ${pending} pending, ${claimed} claimed, ${awaitingReview} drafts awaiting review.`;
      }
      if (result.drafts?.length && !reviewReply) result.statusText += `\n${[...listingLines('Drafts awaiting review:', result.drafts), `Read one with ${cmd(`review ${REVIEW_CODE_PLACEHOLDER}`)}.`].join('\n')}`;
      // Codes stay in the fields; the plain reply says where to see them. A
      // completed decision keeps its outcome and still says when something
      // else needs attention.
      const completed = value.review !== undefined && REVIEW_OUTCOMES[value.review].pending === false;
      if (result.diagnostics.length && (completed || !reviewReply)) {
        result.statusText += `\n${completed ? 'Something needs attention; for details' : 'For details'}, type ${cmd('status --verbose')}.`;
      }
    }
    if (Buffer.byteLength(result.statusText) > 4096) fail('PROCESSING_CONTROL_OUTPUT_INVALID');
    return result;
  } catch { fail('PROCESSING_CONTROL_OUTPUT_INVALID'); }
}

/** The host launches this adapter on a native MCP stdio connection. Metadata is
 * an identity candidate, not proof. resolveSource must bind it to existing
 * registration and the current native invocation, independently verifying actual
 * skill/control provenance for a dispatch. Its opaque result is never accepted
 * from JSON or returned to the model. No transcript discovery exists here. */
export async function runProcessingControlServer({ client, input = process.stdin, output = process.stdout,
  env = process.env, resolveSource, getStatus, requestProcessing, requestResume, requestCancel, requestReview, beforeResponse, afterResponse,
  unboundStatus } = {}) {
  choice(client, CLIENTS);
  if ([resolveSource, getStatus, requestProcessing].some(value => typeof value !== 'function')) fail('PROCESSING_CONTROL_INVALID_REQUEST');
  const launchEnv = { CLAUDE_CODE_SESSION_ID: env.CLAUDE_CODE_SESSION_ID };
  let initialized = false, pending = Buffer.alloc(0), queue = Promise.resolve(), queued = 0, closed = false;
  let formSupported = false, clientCapabilities = Object.freeze({});
  const requests = new Map(), forms = new Map(), handshakes = new Map();
  const reply = async (value, limit = OUTPUT_BYTES) => {
    const bytes = Buffer.from(`${canonicalJSON(value)}\n`);
    if (bytes.length > limit) fail(limit === FORM_BYTES ? 'PROCESSING_REVIEW_TOO_LARGE' : 'PROCESSING_CONTROL_OUTPUT_INVALID');
    if (!output.write(bytes)) await once(output, 'drain');
  };
  const rejectForms = (code, requestId) => {
    for (const [formId, form] of forms) if (requestId === undefined || form.requestId === requestId) {
      forms.delete(formId); form.reject(Object.assign(new Error(code), { code }));
    }
  };
  const validRpcId = value => (typeof value === 'string' && value.length <= 128) || Number.isSafeInteger(value);
  const hostResponse = row => {
    keys(row, ['jsonrpc', 'id'], ['result', 'error']);
    if (row.jsonrpc !== '2.0' || !validRpcId(row.id) || Object.hasOwn(row, 'result') === Object.hasOwn(row, 'error')) fail('PROCESSING_CONTROL_PROTOCOL');
    const form = forms.get(row.id);
    if (!form) return; // Late/unknown host responses grant no authority and do not close the server.
    forms.delete(row.id);
    try {
      if (Object.hasOwn(row, 'error')) fail('PROCESSING_REVIEW_INTERRUPTED');
      keys(row.result, ['action'], ['content']);
      choice(row.result.action, ['accept', 'decline', 'cancel']);
      if (row.result.action === 'accept') {
        if (form.kind === 'selection') {
          keys(row.result.content, ['operationId']); nativeId(row.result.content.operationId);
          if (!form.ids.includes(row.result.content.operationId)) fail('PROCESSING_REVIEW_INTERRUPTED');
          form.resolve(Object.freeze({ action: 'accept', content: Object.freeze({ operationId: row.result.content.operationId }) }));
          return;
        }
        keys(row.result.content, ['decision'], ['changes']);
        choice(row.result.content.decision, ['save', 'skip', 'cancel', 'later']);
        // The preview field only displays the proposal; the decision enum is the
        // host answer. Hosts can collapse, truncate or omit the text (and people
        // can edit it), so report the display state instead of failing the
        // response. Review applies a decision only for an intact display.
        const { changes } = row.result.content;
        const intact = typeof changes === 'string' && changes.replace(/\r\n?/g, '\n') === form.preview.replace(/\r\n?/g, '\n');
        form.resolve(Object.freeze({ action: 'accept', content: Object.freeze({ decision: row.result.content.decision }),
          preview: intact ? 'intact' : 'altered' }));
      } else {
        if (row.result.content !== undefined && row.result.content !== null) fail('PROCESSING_CONTROL_PROTOCOL');
        form.resolve(Object.freeze({ action: row.result.action }));
      }
    } catch {
      form.reject(Object.assign(new Error('PROCESSING_REVIEW_INTERRUPTED'), { code: 'PROCESSING_REVIEW_INTERRUPTED' }));
    }
  };
  const processRequest = async (row, request) => {
    const rpcId = row.id;
    const signal = request.controller.signal;
    const commitResponse = () => { signal.throwIfAborted(); request.complete = true; };
    try {
      if (request.cancelled) fail('PROCESSING_REVIEW_INTERRUPTED');
      let result, afterCommit = null;
      if (row.method === 'initialize') {
        if (initialized || !object(row.params) || (row.params.capabilities !== undefined && !object(row.params.capabilities))) fail('PROCESSING_CONTROL_PROTOCOL');
        const caps = row.params.capabilities ?? {};
        if (Buffer.byteLength(canonicalJSON(caps)) > 4096) fail('PROCESSING_CONTROL_PROTOCOL');
        clientCapabilities = Object.freeze(structuredClone(caps));
        const elicitation = caps.elicitation;
        formSupported = object(elicitation) && (Object.keys(elicitation).length === 0 || object(elicitation.form));
        initialized = true;
        result = { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'cuefluent_control', version: '1.0.0' } };
      } else {
        if (!initialized) fail('PROCESSING_CONTROL_PROTOCOL');
        if (row.method === 'ping') result = {};
        else if (row.method === 'tools/list') result = { tools: toolsFor(client) };
        else if (row.method === 'tools/call') {
          keys(row.params, ['name'], ['arguments', '_meta']);
          const args = argumentsFor(row.params.name, row.params.arguments ?? {}, client);
          const context = nativeContext(client, row.params._meta, launchEnv);
          const invocation = Object.freeze({ tool: row.params.name, arguments: args });
          const retryToken = row.params.arguments?.retryToken;
          // Tokens are connection-local challenges, never authority. A retry must
          // verify the *original* completed native call and its exact response.
          // Each challenge is single-use, short-lived and bound to this turn.
          for (const [token, pending] of handshakes) if (pending.expires <= performance.now()) handshakes.delete(token);
          let prior;
          if (retryToken !== undefined) {
            prior = handshakes.get(retryToken); handshakes.delete(retryToken);
            if (!prior || context.client !== prior.context.client || context.sessionId !== prior.context.sessionId ||
                context.unitId !== prior.context.unitId || context.toolCallId === prior.context.toolCallId ||
                context.itemId === prior.context.itemId || canonicalJSON(invocation) !== canonicalJSON(prior.invocation)) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
          }
          let source;
          try { source = await resolveSource(prior?.context ?? context, invocation, { signal, requireCompleted: Boolean(prior) }); }
          catch (error) {
            // Help needs no source. A status request in a chat with nothing set
            // up (for example before setup) gets the command list and the way to
            // set up: no callback, receipt, storage or dispatch. A failed binding
            // of an existing source stays its refusal.
            if (row.params.name !== 'processing_status' || prior || typeof unboundStatus !== 'function' ||
                error?.code !== 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' || error.noSource !== true || signal.aborted) throw error;
            const unbound = { content: [{ type: 'text', text: canonicalJSON(processingControlStatusView(unboundStatus(), { collectionId: null })) }], isError: false };
            commitResponse(); await reply({ jsonrpc: '2.0', id: rpcId, result: unbound }); return;
          }
          signal.throwIfAborted();
          if (source?.pending === true) {
            if (prior || handshakes.size >= QUEUED_REQUESTS) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
            const retryToken = randomUUID();
            const pendingResult = { content: [{ type: 'text', text: canonicalJSON({ interfaceVersion: 1,
              status: 'verification-required', retryToken,
              instruction: 'No processing or review has started. End this exec/tool call. In a new exec/tool call, repeat the same tool and arguments with retryToken. Do not retry inside this exec.' }) }], isError: false };
            handshakes.set(retryToken, { context, invocation, source, resultHash: digest(canonicalJSON(pendingResult)), expires: performance.now() + 60_000 });
            commitResponse(); await reply({ jsonrpc: '2.0', id: rpcId, result: pendingResult }); return;
          }
          if (prior && (prior.expires <= performance.now() || !source || source.handshakeResultHash !== prior.resultHash ||
              source.configHash !== prior.source.configHash || source.outerRecordHash !== prior.source.outerRecordHash ||
              source.selectionHash !== prior.source.selectionHash || source.collectionId !== prior.source.collectionId ||
              canonicalJSON(source.source) !== canonicalJSON(prior.source.source) ||
              canonicalJSON(source.selection) !== canonicalJSON(prior.source.selection))) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
          signal.throwIfAborted();
          if (!source || typeof source !== 'object') fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
          const collectionId = args.collectionId ?? source.collectionId;
          try { id(collectionId); } catch { fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED'); }
          if (source.collectionId !== undefined && source.collectionId !== collectionId) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
          const resolvedArgs = Object.freeze({ ...args, collectionId });
          let elicited = 0, selectedForm = false;
          const elicit = async proposal => {
            const selecting = proposal.choices !== undefined;
            keys(proposal, selecting ? ['choices'] : ['message'], selecting ? [] : ['folder']);
            if (selecting) {
              list(proposal.choices, 5, { empty: false }).forEach(item => { keys(item, ['operationId', 'label']); nativeId(item.operationId); string(item.label, 256); });
              unique(proposal.choices.map(item => item.operationId));
            } else {
              string(proposal.message, FORM_BYTES);
              if (proposal.folder !== undefined && (string(proposal.folder, REVIEW_FOLDER_BYTES), !path.isAbsolute(proposal.folder))) fail('PROCESSING_CONTROL_PROTOCOL');
            }
            if (!formSupported) fail('PROCESSING_REVIEW_UNSUPPORTED');
            if (closed || request.cancelled || request.complete || requests.get(rpcId) !== request) fail('PROCESSING_REVIEW_INTERRUPTED');
            if (elicited >= 2 || (elicited === 1 && (!selectedForm || selecting))) fail('PROCESSING_CONTROL_PROTOCOL');
            elicited++; if (selecting) selectedForm = true;
            const formId = `cuefluent-review-${randomUUID()}`;
            // Desktop renders message/description in a fixed header. Keep them
            // short; the full preview belongs in its scrollable text control.
            // "changes" sorts before "decision" in the canonical wire JSON.
            const message = selecting ? { jsonrpc: '2.0', id: formId, method: 'elicitation/create', params: { mode: 'form',
              message: 'Choose a draft to preview. This choice does not save, skip or cancel it.',
              requestedSchema: { type: 'object', properties: { operationId: { type: 'string', title: 'Draft to review',
                oneOf: proposal.choices.map(item => ({ const: item.operationId, title: item.label })) } }, required: ['operationId'] } } }
              : { jsonrpc: '2.0', id: formId, method: 'elicitation/create', params: { mode: 'form',
              message: 'Review the proposed notes, then choose a proposal action. Closing this form or using its own Skip button leaves the proposal pending.' +
                (proposal.folder === undefined ? '' : ` The same proposal is in the private review folder ${displayFolder(proposal.folder)}`),
              requestedSchema: { type: 'object', properties: {
                changes: { type: 'string', title: 'Proposed changes',
                  description: 'Read the full preview, then go to the next field. For corrections, choose Later and provide them in your work chat; do not edit this preview. If the preview looks collapsed or incomplete, close this form and leave the draft pending.',
                  default: proposal.message },
                decision: { type: 'string', title: 'Proposal action',
                  description: 'Save writes the exact proposal. Skip handles these captures without saving. Cancel releases the operation and keeps captures pending. Later keeps the proposal pending.',
                  enum: ['save', 'skip', 'cancel', 'later'],
                  enumNames: ['Save exact proposal', 'Skip these captures without saving', 'Cancel operation; keep captures pending', 'Later; keep proposal pending'] }
              }, required: ['changes', 'decision'] } } };
            if (Buffer.byteLength(canonicalJSON(message)) + 1 > FORM_BYTES) fail('PROCESSING_REVIEW_TOO_LARGE');
            let resolve, reject;
            const response = new Promise((a, b) => { resolve = a; reject = b; });
            response.catch(() => {});
            forms.set(formId, { requestId: rpcId, kind: selecting ? 'selection' : 'preview',
              ids: selecting ? proposal.choices.map(item => item.operationId) : null, preview: proposal.message, resolve, reject });
            try { await reply(message, FORM_BYTES); return await response; }
            finally { forms.delete(formId); }
          };
          let response;
          if (row.params.name === 'processing_review') {
            if (typeof requestReview !== 'function') {
              const current = await getStatus({ source, context, ...resolvedArgs });
              response = { ...current, ...(current.status === 'awaiting-review' ? { review: 'unavailable' } : {}),
                diagnostics: [...new Set(['PROCESSING_REVIEW_UNSUPPORTED', ...(current.diagnostics ?? [])])].slice(0, 8) };
            }
            // Tested Claude hosts cannot show a complete form (Desktop declines
            // every form; the CLI clips its text), so Claude reviews through the
            // private review folder and typed decisions. Codex keeps its form
            // when the host supports one.
            else response = await requestReview({ source, context, ...resolvedArgs, clientCapabilities,
              elicit: client === 'codex' && formSupported ? elicit : undefined, signal, commitResponse });
          } else {
            const action = { processing_status: getStatus, process_selected_captures: requestProcessing,
              processing_resume: requestResume, processing_cancel: requestCancel }[row.params.name];
            if (typeof action !== 'function') fail('PROCESSING_CONTROL_METHOD_UNSUPPORTED');
            response = await action({ source, context, ...resolvedArgs, signal });
          }
          signal.throwIfAborted();
          const view = processingControlStatusView(response, resolvedArgs);
          result = { content: [{ type: 'text', text: canonicalJSON(view) }], isError: false };
          const replacement = await beforeResponse?.({ source, context, invocation, view, result: structuredClone(result), signal, commitResponse });
          // A trusted controller may report unproven exclusion or preserve a
          // committed review. Reproject the bounded result without attempting
          // another receipt; the attempted receipt cannot prove this new result.
          if (replacement !== undefined) result = { content: [{ type: 'text', text: canonicalJSON(processingControlStatusView(replacement, resolvedArgs)) }], isError: false };
          if (typeof afterResponse === 'function') afterCommit = () => afterResponse({ source, context, invocation, signal });
        } else fail('PROCESSING_CONTROL_METHOD_UNSUPPORTED');
      }
      commitResponse();
      // Bookkeeping that must follow the commit: a review presentation counts
      // only once its reply is committed. Cancellation can no longer affect the
      // request, but a failure here turns the reply into that error, so the
      // chat is never told a draft was presented when it cannot be decided on.
      if (afterCommit) await afterCommit();
      await reply({ jsonrpc: '2.0', id: rpcId, result });
    } catch (error) {
      request.complete = true;
      if (request.cancelled) return;
      // Claude may have rejected an unrelated registered source during /clear
      // fallback. Preserve its existing generic refusal instead of attributing
      // that ownership failure to the invoking chat. Codex binds the exact ID.
      const code = ERRORS.has(error?.code) && !(client === 'claude' && codexSourceErrors.has(error.code))
        ? error.code : 'PROCESSING_CONTROL_FAILED';
      await reply({ jsonrpc: '2.0', id: rpcId, error: { code: code === 'PROCESSING_CONTROL_METHOD_UNSUPPORTED' ? -32601 : -32600, message: code } });
    } finally { requests.delete(rpcId); rejectForms('PROCESSING_REVIEW_INTERRUPTED', rpcId); }
  };
  const processLine = async line => {
    let row;
    try { row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { fail('PROCESSING_CONTROL_PROTOCOL'); }
    if (!object(row)) fail('PROCESSING_CONTROL_PROTOCOL');
    // Host responses may echo a preview even after cancellation or completion.
    // Unknown IDs are ignored; only a live form can return a decision.
    if (line.length > INPUT_BYTES && Object.hasOwn(row, 'method')) fail('PROCESSING_CONTROL_INPUT_LIMIT');
    if (!Object.hasOwn(row, 'method')) { hostResponse(row); return; }
    keys(row, ['jsonrpc', 'method'], ['id', 'params']);
    if (row.jsonrpc !== '2.0' || typeof row.method !== 'string') fail('PROCESSING_CONTROL_PROTOCOL');
    if (!Object.hasOwn(row, 'id')) {
      if (row.method === 'notifications/initialized') return;
      if (row.method === 'notifications/cancelled') {
        keys(row.params, ['requestId'], ['reason']);
        if (!validRpcId(row.params.requestId)) fail('PROCESSING_CONTROL_PROTOCOL');
        const request = requests.get(row.params.requestId);
        if (request && !request.complete && request.method !== 'initialize') {
          request.cancelled = true;
          request.controller.abort(Object.assign(new Error('PROCESSING_CONTROL_CANCELLED'), { code: 'PROCESSING_CONTROL_CANCELLED' }));
          rejectForms('PROCESSING_REVIEW_INTERRUPTED', row.params.requestId);
        }
        return;
      }
      return; // Unknown notifications require no response (and grant no authority).
    }
    if (!validRpcId(row.id)) fail('PROCESSING_CONTROL_PROTOCOL');
    if (requests.has(row.id) || queued >= QUEUED_REQUESTS) {
      await reply({ jsonrpc: '2.0', id: row.id, error: { code: -32600, message: 'PROCESSING_CONTROL_PROTOCOL' } }); return;
    }
    const request = { cancelled: false, method: row.method, controller: new AbortController() }; requests.set(row.id, request); queued++;
    // Read the transport while a review awaits its native host response. Keep
    // every tool request serialized, so a queued request cannot mutate the
    // selected proposal while the current review is open.
    queue = queue.then(() => processRequest(row, request)).finally(() => { queued--; });
    queue.catch(() => {});
  };
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk); let start = 0, end;
      while ((end = bytes.indexOf(10, start)) >= 0) {
        if (pending.length + end - start > FRAME_BYTES) fail('PROCESSING_CONTROL_INPUT_LIMIT');
        const line = Buffer.concat([pending, bytes.subarray(start, end)]); pending = Buffer.alloc(0); start = end + 1;
        if (line.length) {
          try { await processLine(line); }
          catch (error) {
            if (error.code !== 'PROCESSING_CONTROL_PROTOCOL' && error.code !== 'INVALID_WORKFLOW') throw error;
            await reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'PROCESSING_CONTROL_PROTOCOL' } });
          }
        }
      }
      if (pending.length + bytes.length - start > FRAME_BYTES) fail('PROCESSING_CONTROL_INPUT_LIMIT');
      pending = Buffer.concat([pending, bytes.subarray(start)]);
    }
    if (pending.length) fail('PROCESSING_CONTROL_PROTOCOL');
  } finally {
    closed = true; rejectForms('PROCESSING_REVIEW_INTERRUPTED');
    try { await queue; } finally { handshakes.clear(); }
  }
}
