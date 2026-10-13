import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CLIENTS, canonicalJSON, digest, choice, fail, id, keys, list, nativeId, object, string, unique } from './workflow-values.mjs';

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
const ACTIONS = ['inspect', 'resume', 'review', 'wait', 'none'];
const DIAGNOSTICS = Object.freeze(['PROCESSING_CONTROL_SOURCE_UNVERIFIED', 'PROCESSING_CONTROL_FAILED',
  'PROCESSING_CHAT_BUSY', 'PROCESSING_CHAT_BLOCKED', 'PROCESSING_CHAT_MISSING', 'PROCESSING_CHAT_BINDING_CHANGED',
  'PROCESSING_CHAT_HOST_UNAVAILABLE', 'PROCESSING_CHAT_SESSION_UNAVAILABLE', 'PROCESSING_CHAT_OUTCOME_UNKNOWN',
  'PROCESSING_CHAT_CONFLICT', 'PROCESSING_RECOVERY_REQUIRED', 'WRITER_RECOVERY_REQUIRED',
  'WORKFLOW_POLICY_CHANGED', 'PROCESSING_APPROVAL_REQUIRED', 'PROCESSING_SELECTION_CHANGED',
  'PROCESSING_REVIEW_UNSUPPORTED', 'PROCESSING_REVIEW_TOO_LARGE', 'PROCESSING_REVIEW_LIMIT', 'PROCESSING_REVIEW_INTERRUPTED', 'PROCESSING_REVIEW_PREVIEW_CHANGED',
  'PROCESSING_CHAT_REVIEW_UNRESOLVED', 'PROCESSING_CHAT_POLICY_CHANGED', 'PROCESSING_CHAT_STATE_CHANGED',
  'PROCESSING_EXCLUSION_UNVERIFIED', 'PROCESSING_OPERATION_OUTCOME_UNKNOWN',
  'PROCESSING_CLIENT_FAILED', 'PROCESSING_CLIENT_INTERRUPTED', 'PROCESSING_CLIENT_UNAVAILABLE',
  'PROCESSING_CLIENT_SETTINGS_INVALID', 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE',
  'PROCESSING_CLIENT_SETTINGS_LIMIT', 'PROCESSING_CLIENT_SETTINGS_UNSUPPORTED', 'INTAKE_BLOCKED']);
const ERRORS = new Set([...DIAGNOSTICS, 'PROCESSING_CONTROL_PROTOCOL', 'PROCESSING_CONTROL_INPUT_LIMIT',
  'PROCESSING_CONTROL_OUTPUT_INVALID', 'PROCESSING_CONTROL_METHOD_UNSUPPORTED', 'PROCESSING_CONTROL_INVALID_REQUEST',
  'PROCESSING_CONTROL_SELECTION_MISMATCH', 'PROCESSING_REVIEW_REQUIRED', 'PROCESSING_OUTPUT_CHANGED',
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
const TOOLS = [
  { name: 'processing_status', description: 'Read bounded processing-chat status for the selected collection. Returns no evidence or drafts.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { collectionId: collectionSchema, retryToken: retrySchema } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'process_selected_captures', description: 'Request the existing Cuefluent Notes skill processing workflow in its reusable excluded chat. Requires verified native source context and existing consent. Returns only status; never approves or saves a proposal.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { collectionId: collectionSchema, retryToken: retrySchema, requestId: uuidSchema, selection: selectionSchema } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'processing_review', description: 'Open native review controls for the exact outstanding proposal. Drafts stay in the host form; only a native host response can save, skip, or cancel. Tool arguments never authorize an outcome.',
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

function argumentsFor(name, args) {
  try {
    if (['processing_status', 'processing_review'].includes(name)) keys(args, [], ['collectionId', 'retryToken']);
    else if (name === 'process_selected_captures') keys(args, [], ['requestId', 'collectionId', 'selection', 'retryToken']);
    else fail('PROCESSING_CONTROL_METHOD_UNSUPPORTED');
    if (args.collectionId !== undefined) id(args.collectionId);
    if (args.requestId !== undefined) nativeId(args.requestId);
    if (args.retryToken !== undefined) nativeId(args.retryToken);
    const result = args.collectionId === undefined ? {} : { collectionId: args.collectionId };
    if (args.requestId !== undefined) result.requestId = args.requestId;
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
 * private paths or future implementation fields into a captured source chat. */
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
    if (result.diagnostics.length) result.statusText += ` ${result.diagnostics.join(', ')}. Next action: ${result.nextAction}.`;
    return result;
  } catch { fail('PROCESSING_CONTROL_OUTPUT_INVALID'); }
}

/** The host launches this adapter on a native MCP stdio connection. Metadata is
 * an identity candidate, not proof. resolveSource must bind it to existing
 * registration and the current native invocation, independently verifying actual
 * skill/control provenance for a dispatch. Its opaque result is never accepted
 * from JSON or returned to the model. No transcript discovery exists here. */
export async function runProcessingControlServer({ client, input = process.stdin, output = process.stdout,
  env = process.env, resolveSource, getStatus, requestProcessing, requestReview, beforeResponse } = {}) {
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
        keys(row.result.content, ['changes', 'decision']);
        if (typeof row.result.content.changes !== 'string') fail('PROCESSING_REVIEW_INTERRUPTED');
        const changes = row.result.content.changes.replace(/\r\n?/g, '\n');
        if (Buffer.byteLength(changes) > FORM_BYTES) fail('PROCESSING_REVIEW_TOO_LARGE');
        if (changes !== form.preview.replace(/\r\n?/g, '\n')) fail('PROCESSING_REVIEW_PREVIEW_CHANGED');
        choice(row.result.content.decision, ['save', 'skip', 'cancel', 'later']);
        form.resolve(Object.freeze({ action: 'accept', content: Object.freeze({ decision: row.result.content.decision }) }));
      } else {
        if (row.result.content !== undefined && row.result.content !== null) fail('PROCESSING_CONTROL_PROTOCOL');
        form.resolve(Object.freeze({ action: row.result.action }));
      }
    } catch (error) {
      const code = ['PROCESSING_REVIEW_PREVIEW_CHANGED', 'PROCESSING_REVIEW_TOO_LARGE'].includes(error.code) ? error.code : 'PROCESSING_REVIEW_INTERRUPTED';
      form.reject(Object.assign(new Error(code), { code }));
    }
  };
  const processRequest = async (row, request) => {
    const rpcId = row.id;
    const signal = request.controller.signal;
    const commitResponse = () => { signal.throwIfAborted(); request.complete = true; };
    try {
      if (request.cancelled) fail('PROCESSING_REVIEW_INTERRUPTED');
      let result;
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
        else if (row.method === 'tools/list') result = { tools: TOOLS };
        else if (row.method === 'tools/call') {
          keys(row.params, ['name'], ['arguments', '_meta']);
          const args = argumentsFor(row.params.name, row.params.arguments ?? {});
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
          const source = await resolveSource(prior?.context ?? context, invocation, { signal, requireCompleted: Boolean(prior) });
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
          let elicited = false;
          const elicit = async proposal => {
            keys(proposal, ['message']); string(proposal.message, FORM_BYTES);
            if (!formSupported) fail('PROCESSING_REVIEW_UNSUPPORTED');
            if (closed || request.cancelled || request.complete || requests.get(rpcId) !== request) fail('PROCESSING_REVIEW_INTERRUPTED');
            if (elicited) fail('PROCESSING_CONTROL_PROTOCOL');
            elicited = true;
            const formId = `cuefluent-review-${randomUUID()}`;
            // Desktop renders message/description in a fixed header. Keep them
            // short; the full preview belongs in its scrollable text control.
            // "changes" sorts before "decision" in the canonical wire JSON.
            const message = { jsonrpc: '2.0', id: formId, method: 'elicitation/create', params: { mode: 'form',
              message: 'Review the proposed notes, then choose a proposal action. Closing this form or using its own Skip button leaves the proposal pending.',
              requestedSchema: { type: 'object', properties: {
                changes: { type: 'string', title: 'Proposed changes',
                  description: 'Read the full preview, then go to the next field. For corrections, choose Later and provide them in your work chat; do not edit this preview.',
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
            forms.set(formId, { requestId: rpcId, preview: proposal.message, resolve, reject });
            try { await reply(message, FORM_BYTES); return await response; }
            finally { forms.delete(formId); }
          };
          let response;
          if (row.params.name === 'processing_review') {
            if (!formSupported || typeof requestReview !== 'function') {
              const current = await getStatus({ source, context, ...resolvedArgs });
              response = { ...current, diagnostics: [...new Set(['PROCESSING_REVIEW_UNSUPPORTED', ...(current.diagnostics ?? [])])].slice(0, 8) };
            }
            else response = await requestReview({ source, context, ...resolvedArgs, clientCapabilities, elicit, signal, commitResponse });
          } else response = await (row.params.name === 'processing_status' ? getStatus : requestProcessing)({ source, context, ...resolvedArgs, signal });
          signal.throwIfAborted();
          const view = processingControlStatusView(response, resolvedArgs);
          result = { content: [{ type: 'text', text: canonicalJSON(view) }], isError: false };
          const replacement = await beforeResponse?.({ source, context, invocation, view, result: structuredClone(result), signal, commitResponse });
          // A trusted controller may report unproven exclusion or preserve a
          // committed review. Reproject the bounded result without attempting
          // another receipt; the attempted receipt cannot prove this new result.
          if (replacement !== undefined) result = { content: [{ type: 'text', text: canonicalJSON(processingControlStatusView(replacement, resolvedArgs)) }], isError: false };
        } else fail('PROCESSING_CONTROL_METHOD_UNSUPPORTED');
      }
      commitResponse();
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
