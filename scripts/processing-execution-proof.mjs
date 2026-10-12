import fs from 'node:fs/promises';
import path from 'node:path';
import { snapshotSourceMetadata } from './collection-ingress.mjs';
import { sameFileIdentity } from './file-io.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { verifyCodexHeader } from './codex-reader.mjs';
import { claudeRegistrationHeader } from './claude-reader.mjs';
import { absolutePath } from './workflow-paths.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { canonicalJSON, digest, fail, integer, isNativeId, object } from './workflow-values.mjs';

const MAX_BYTES = 16 * 1024 * 1024, MAX_RECORDS = 16384, MAX_PROJECTS = 16384;
const proofs = new WeakSet();
const hashLike = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bound = (payload, unitId) => payload?.internal_chat_message_metadata_passthrough?.turn_id === unitId;
const text = (blocks, type) => Array.isArray(blocks) && blocks.length &&
  blocks.every(block => object(block) && block.type === type && typeof block.text === 'string' &&
    Object.keys(block).every(key => ['type', 'text', 'annotations'].includes(key)))
  ? blocks.map(block => block.text).join('') : null;

async function directory(file) {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(file) !== file) fail('PROCESSING_SOURCE_UNAVAILABLE');
  return stat;
}
async function unchangedDirectory(file, stat) {
  const after = await directory(file);
  if (!sameFileIdentity(stat, after)) fail('PROCESSING_SOURCE_CHANGED');
}

/** Only an already-owned native UUID may reach this locator. It reads metadata
 * in one selected client profile, never session contents or archive directories.
 * The caller performs current collection/processing authorization separately. */
export async function locateProcessingExecutionSource(session, { claudeConfigDir } = {}) {
  if (!object(session) || !isNativeId(session.sessionId) || !['codex', 'claude'].includes(session.client)) fail('INVALID_PROCESSING_EXECUTION');
  const projectRoot = await fs.realpath(absolutePath(session.cwd));
  let selected;
  if (session.client === 'codex') selected = absolutePath(session.sourcePath);
  else {
    const profile = absolutePath(claudeConfigDir), profileStat = await directory(profile);
    const projects = path.join(profile, 'projects');
    let projectsStat;
    try { projectsStat = await directory(projects); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const matches = [], children = [];
    // opendir bounds allocation as well as iteration. No directory-slug algorithm
    // or client-version assumption is needed to locate the exact owned UUID.
    const handle = await fs.opendir(projects);
    for await (const entry of handle) {
      checkWorkflowBudget();
      if (children.length >= MAX_PROJECTS) fail('PROCESSING_SOURCE_DISCOVERY_LIMIT');
      const child = path.join(projects, entry.name), stat = await fs.lstat(child, { bigint: true });
      if (stat.isSymbolicLink()) fail('PROCESSING_SOURCE_UNAVAILABLE');
      children.push({ child, stat });
      if (!stat.isDirectory()) continue;
      // These are not project entries, and must never become a historical lookup.
      if (['archive', 'archives', 'archived_sessions'].includes(entry.name)) continue;
      const candidate = path.join(child, `${session.sessionId}.jsonl`);
      const snapshot = await snapshotSourceMetadata(candidate);
      if (snapshot) matches.push(snapshot.path);
    }
    for (const { child, stat } of children) if (stat.isDirectory()) { checkWorkflowBudget(); await unchangedDirectory(child, stat); }
    await unchangedDirectory(projects, projectsStat); await unchangedDirectory(profile, profileStat);
    if (matches.length > 1) fail('PROCESSING_SOURCE_AMBIGUOUS');
    if (!matches.length) return null;
    [selected] = matches;
  }
  const snapshot = await snapshotSourceMetadata(selected);
  return snapshot && { client: session.client, sessionId: session.sessionId, projectRoot, ...snapshot };
}

async function nativeRange({ source, fromByte, endByte }) {
  integer(fromByte); integer(endByte);
  if (!object(source) || !isNativeId(source.sessionId) || !['codex', 'claude'].includes(source.client) ||
      endByte <= fromByte || endByte - fromByte > MAX_BYTES) return null;
  const claude = source.client === 'claude';
  const read = await readSessionRange({ source, from: fromByte, endByte,
    ...(claude ? { readHeader: claudeRegistrationHeader(source), verifyHeader: value => value } : { verifyHeader: verifyCodexHeader }),
    maxBytes: MAX_BYTES, maxRecords: MAX_RECORDS });
  if ((!claude && read.metadata.historyMode !== 'paginated') || read.blocked || read.limited || read.pendingTail ||
      read.discarded.length || read.readEnd !== endByte || !read.records.length) return null;
  return read;
}

function claudeInput(record, source) {
  const row = record.value;
  if (row?.type !== 'user' || row.message?.role !== 'user' || row.sessionId !== source.sessionId ||
      row.isSidechain !== false || row.agentId != null || row.forkedFrom != null || row.foreignToBridgeSession != null ||
      row.sessionKind != null || row.isMeta === true || row.isVirtual === true || row.isVisibleInTranscriptOnly === true ||
      row.isCompactSummary === true || row.interruptedMessageId !== undefined || row.interruptedByShutdown === true ||
      (row.origin !== undefined && row.origin?.kind !== 'human') || !isNativeId(row.uuid) || !isNativeId(row.promptId)) return null;
  const content = typeof row.message.content === 'string' ? row.message.content : text(row.message.content, 'text');
  return content === null ? null : { inputId: row.uuid, unitId: row.promptId, inputHash: digest(content) };
}

/** Claude's stream replay UUID is not its native promptId. Map the exact
 * controller input in a bounded post-dispatch range instead of inventing one.
 * Mapping alone is not an exclusion proof or an authorization. */
export async function resolveClaudeProcessingUnit(request) {
  if (request.source?.client !== 'claude' || !isNativeId(request.inputId) || !hashLike(request.inputHash)) return null;
  const read = await nativeRange(request);
  if (!read) return null;
  const matches = read.records.filter(record => record.value?.uuid === request.inputId);
  if (matches.length !== 1) return null;
  const record = matches[0], input = claudeInput(record, request.source);
  if (!input || input.inputHash !== request.inputHash || record.value.promptSource !== 'sdk' || record.value.turnOrigin !== 'sdk') return null;
  return { ...input, fromByte: record.startByte, endByte: record.endByte,
    recordId: input.inputId, recordHash: record.hash };
}

function receiptMatches(receipt, query, source) {
  const pattern = source.client === 'codex' ? /^cuefluent_[a-z][a-z0-9_]{0,63}$/ : /^mcp__cuefluent_engine__[a-z][a-z0-9_]{0,63}$/;
  return object(receipt) && Object.isFrozen(receipt) && receipt.completed === true && receipt.policyVerified === true &&
    Object.entries(query).every(([key, value]) => receipt[key] === value) &&
    receipt.sourcePath === source.path && receipt.sourceIdentity === source.fileIdentity &&
    isNativeId(receipt.requestId) && isNativeId(receipt.inputId) && hashLike(receipt.inputHash) &&
    hashLike(receipt.profileId) && hashLike(receipt.toolContractHash) && Array.isArray(receipt.allowedTools) &&
    receipt.allowedTools.length > 0 && receipt.allowedTools.length <= 64 &&
    new Set(receipt.allowedTools).size === receipt.allowedTools.length && receipt.allowedTools.every(name => pattern.test(name));
}

function codexUnit(read, source, unitId, receipt, terminal) {
  // This proves attribution of every retained record, not whether the client
  // reached a protocol terminal. Unknown compaction/replacement shapes keep
  // exclusion disabled; controller completion must be evaluated separately.
  const records = read.records, rows = records.map(record => record.value);
  if (rows.some((row, index) => !object(row) || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 ||
      (index && row.ordinal !== rows[index - 1].ordinal + 1))) return null;
  const first = rows[0], last = rows.at(-1);
  if (first.type !== 'event_msg' || first.payload?.type !== 'task_started' || first.payload.turn_id !== unitId ||
      first.payload.root_turn_id !== unitId || last.type !== 'event_msg' ||
      last.payload?.type !== (terminal === 'interrupted' ? 'turn_aborted' : 'task_complete') ||
      last.payload.turn_id !== unitId || last.payload.error != null ||
      (terminal === 'interrupted' && last.payload.reason !== 'interrupted')) return null;
  let user = null, nativeUser = null;
  const calls = new Map(), nativeCalls = new Map(), outputs = new Set(), allowed = new Set(receipt.allowedTools);
  const cells = new Map(), cellIds = new Set(), nestedCalls = new Set();
  let activeCell = null;
  for (const row of rows.slice(1, -1)) {
    const p = row.payload;
    if (!object(p)) return null;
    if (row.type === 'world_state') {
      if (typeof p.full !== 'boolean' || !object(p.state)) return null;
      continue;
    }
    if (row.type === 'turn_context') {
      if (p.turn_id !== unitId || p.root_turn_id !== unitId) return null;
      continue;
    }
    if (row.type === 'token_usage_record') {
      if (p.thread_id !== source.sessionId || p.session_id !== source.sessionId || p.turn_id !== unitId || p.root_turn_id !== unitId) return null;
      continue;
    }
    if (row.type === 'event_msg') {
      if (p.type === 'token_count') continue;
      if (['agent_reasoning', 'agent_reasoning_raw_content'].includes(p.type) && p.turn_id === unitId) continue;
      if (p.type !== 'item_completed' || p.thread_id !== source.sessionId || p.turn_id !== unitId || !object(p.item)) return null;
      const item = p.item;
      if (item.type === 'Reasoning') continue;
      if (item.type === 'UserMessage') {
        if (nativeUser !== null || !Array.isArray(item.content) || item.content.length !== 1) return null;
        const [input] = item.content;
        if (input?.type !== 'text' || typeof input.text !== 'string' || !Array.isArray(input.text_elements) || input.text_elements.length ||
            Object.keys(input).some(key => !['type', 'text', 'text_elements'].includes(key))) return null;
        nativeUser = input.text; continue;
      }
      if (item.type === 'AgentMessage') {
        if (text(item.content, 'Text') === null) return null;
        continue;
      }
      if (item.type === 'DynamicToolCall') {
        const terminalCall = (item.status === 'completed' && item.success === true) ||
          (item.status === 'failed' && item.success === false);
        if (item.namespace != null || !allowed.has(item.tool) || !terminalCall || typeof item.id !== 'string' || nativeCalls.has(item.id) || cells.has(item.id)) return null;
        if (activeCell !== null) {
          if (!item.id.startsWith('exec-') || !isNativeId(item.id.slice(5))) return null;
          nestedCalls.add(item.id);
        }
        nativeCalls.set(item.id, item.tool);
        continue;
      }
      return null;
    }
    if (row.type !== 'response_item' || !bound(p, unitId)) return null;
    if (p.type === 'reasoning') continue;
    if (p.type === 'message') {
      if (p.role === 'assistant') { if (text(p.content, 'output_text') === null) return null; continue; }
      if (p.role === 'developer') { if (text(p.content, 'input_text') === null) return null; continue; }
      if (p.role !== 'user') return null;
      const kinds = p.internal_chat_message_metadata_passthrough.content_item_kinds;
      if (!Array.isArray(kinds) || kinds.length !== p.content?.length) return null;
      if (terminal === 'interrupted' && kinds.length === 1 && kinds[0] === 'generic.turn_aborted') {
        if (text(p.content, 'input_text') !== '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>') return null;
        continue;
      }
      if (kinds.length && kinds.every(kind => ['agents_md.instructions', 'environments.environment_context', 'skills.instructions'].includes(kind))) {
        if (text(p.content, 'input_text') === null) return null;
        continue;
      }
      if (user !== null || kinds.length !== 1 || kinds[0] !== 'user.text') return null;
      user = text(p.content, 'input_text'); if (user === null) return null;
      continue;
    }
    // The native client may wrap dynamic engine calls in code-mode exec cells.
    // Restriction receipts and typed inner events establish provenance; the JS
    // source is retained as generated content, never parsed as authorization.
    if (p.type === 'custom_tool_call') {
      if (activeCell !== null || p.name !== 'exec' || p.namespace != null || typeof p.input !== 'string' ||
          typeof p.id !== 'string' || !p.id || cellIds.has(p.id) || typeof p.call_id !== 'string' || !p.call_id ||
          cells.has(p.call_id) || calls.has(p.call_id) || nativeCalls.has(p.call_id)) return null;
      cellIds.add(p.id); cells.set(p.call_id, false); activeCell = p.call_id; continue;
    }
    if (p.type === 'custom_tool_call_output') {
      if (activeCell === null || activeCell !== p.call_id || row.metadata?.client_authored !== false ||
          (typeof p.output !== 'string' && text(p.output, 'input_text') === null)) return null;
      cells.set(activeCell, true); activeCell = null; continue;
    }
    if (p.type === 'function_call') {
      if (activeCell !== null || cells.has(p.call_id) || p.namespace != null || !allowed.has(p.name) || typeof p.call_id !== 'string' || calls.has(p.call_id)) return null;
      calls.set(p.call_id, p.name); continue;
    }
    if (p.type === 'function_call_output') {
      if (activeCell !== null || !calls.has(p.call_id) || outputs.has(p.call_id) ||
          (typeof p.output !== 'string' && text(p.output, 'input_text') === null)) return null;
      outputs.add(p.call_id); continue;
    }
    return null;
  }
  if (user === null || nativeUser !== user || digest(user) !== receipt.inputHash || calls.size !== outputs.size ||
      activeCell !== null || [...cells.values()].some(complete => !complete) ||
      nativeCalls.size !== calls.size + nestedCalls.size ||
      [...nativeCalls].some(([id, name]) => !nestedCalls.has(id) && calls.get(id) !== name)) return null;
  return { evidenceScope: 'unit', recordIds: records.map(record => `codex:ordinal:${record.value.ordinal}`) };
}

function claudeUnit(read, source, unitId, receipt) {
  const matches = read.records.filter(record => record.value?.uuid === receipt.inputId);
  if (matches.length !== 1) return null;
  const record = matches[0], input = claudeInput(record, source);
  if (!input || input.unitId !== unitId || input.inputHash !== receipt.inputHash ||
      record.value.promptSource !== 'sdk' || record.value.turnOrigin !== 'sdk') return null;
  for (const other of read.records) {
    const row = other.value;
    if (!object(row) || (row.sessionId !== undefined && row.sessionId !== source.sessionId)) return null;
    if (other === record || row.type !== 'user' || row.message?.role !== 'user' || row.promptId !== unitId) continue;
    // Tool results and native meta are not human evidence. A second original
    // input (including an image, correction or later same-prompt update) is.
    if (row.isMeta === true || row.isVirtual === true || row.isCompactSummary === true ||
        (Array.isArray(row.message.content) && row.message.content.every(block => block.type === 'tool_result'))) continue;
    return null;
  }
  // Claude assistant parentage is not prompt attribution. This proof covers
  // only the exact controller input, never ordinary assistant/tool/attachment rows.
  return { evidenceScope: 'controller-input', recordIds: [receipt.inputId],
    inputRange: { fromByte: record.startByte, endByte: record.endByte, hash: record.hash } };
}

export const isProcessingExecutionProof = value => object(value) && proofs.has(value);

/** Internal receipt lookup only. A session role, claimed JSON proof, model text,
 * input UUID alone, or partial native result never authorizes exclusion. */
async function verifyExecution(request, { resolveExecution }, terminal) {
  const { source, unitId } = request;
  if (!isNativeId(unitId) || !object(source) || typeof resolveExecution !== 'function') return null;
  const query = { client: source.client, sessionId: source.sessionId, unitId };
  const resolved = await resolveExecution(query);
  if (!receiptMatches(resolved, query, source)) return null;
  if ((resolved.terminal ?? 'completed') !== terminal || (terminal !== 'completed' && source.client !== 'codex')) return null;
  const receipt = { ...resolved, allowedTools: [...resolved.allowedTools] };
  const pinned = ['fromByte', 'endByte', 'recordsHash'].some(key => Object.hasOwn(receipt, key));
  if (pinned && (receipt.fromByte !== request.fromByte || receipt.endByte !== request.endByte || !hashLike(receipt.recordsHash))) return null;
  const read = await nativeRange(request);
  if (!read) return null;
  const recordsHash = digest(canonicalJSON(read.records.map(record => ({ startByte: record.startByte, endByte: record.endByte, hash: record.hash }))));
  // First sealing occurs only inside the completed native callback. Persisted
  // receipts pin this range hash so a later rewrite cannot inherit exclusion.
  if (pinned && receipt.recordsHash !== recordsHash) return null;
  const scope = source.client === 'codex' ? codexUnit(read, source, unitId, receipt, terminal) : claudeUnit(read, source, unitId, receipt);
  if (!scope) return null;
  const proof = Object.freeze({ ...query, sourcePath: source.path, sourceIdentity: source.fileIdentity,
    requestId: receipt.requestId, inputId: receipt.inputId, inputHash: receipt.inputHash,
    profileId: receipt.profileId, toolContractHash: receipt.toolContractHash,
    fromByte: request.fromByte, endByte: request.endByte,
    recordsHash, terminal,
    ...scope, recordIds: Object.freeze(scope.recordIds), ...(scope.inputRange ? { inputRange: Object.freeze(scope.inputRange) } : {}) });
  proofs.add(proof); return proof;
}

export const verifyProcessingExecution = (request, options) => verifyExecution(request, options, 'completed');

/** Recovery-only proof. Collectors must never use it to exclude interrupted work. */
export const verifyInterruptedProcessingExecution = (request, options) => verifyExecution(request, options, 'interrupted');

/** Recovery-only proof; failed work is not a completed-output exclusion. */
export const verifyFailedProcessingExecution = (request, options) => verifyExecution(request, options, 'failed');
