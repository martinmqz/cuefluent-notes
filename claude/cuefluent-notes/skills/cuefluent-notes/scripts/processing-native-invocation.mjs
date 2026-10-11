import fs from 'node:fs/promises';
import { lstatOrNull } from './file-io.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import path from 'node:path';
import { openWorkflowIntake, intakePath, intakeSnapshot, intakeJSON } from './intake-io.mjs';
import { readSelection } from './intake-store.mjs';
import { assertWorkflowStorage, workflowProcessingContext } from './workflow-storage.mjs';
import { currentIntervals, inspectSourceBoundary } from './capture-selection.mjs';
import { processingSourceDirectory, processingSourcePath, validateProcessingSource } from './collection-ingress.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { verifyCodexHeader, codexRegistrationHeader } from './codex-reader.mjs';
import { claudeRegistrationHeader } from './claude-reader.mjs';
import { loadClaudeProcessingSkill, findClaudeProcessingControlInput } from './processing-control-proof.mjs';
import { canonicalJSON, digest, fail, object, isNativeId } from './workflow-values.mjs';

const MAX_PREFIX = 2 * 1024 * 1024;
const bindings = new WeakSet();
export const isProcessingInvocation = value => object(value) && bindings.has(value);

/** Bind native MCP metadata to the actual call in an already selected source.
 * No archive search, last-session heuristic, caller JSON proof or source write.
 * Pausing collection preserves this binding for independently authorized
 * processing; it does not reopen or extend any collection interval.
 */
async function resolveBoundInvocation(capability, context, invocation, { skillPath, skillCommand }) {
  const store = await openWorkflowIntake(capability);
  const identity = { client: context.client, sessionId: context.sessionId };
  const selected = await readSelection(store, identity);
  if (selected.state?.safetyStop) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  const intervals = selected.state ? currentIntervals(selected.state) : [];
  const interval = selected.state?.paused ? intervals.at(-1) : intervals.find(value => value.upper === null);
  let source = selected.state?.source, floor = interval ? (selected.state.paused ? interval.upper ?? interval.lower : interval.lower) : null;
  let processingBinding = null;
  if (!floor && selected.state?.explicitScopes.length) {
    floor = { eofByte: Math.min(...selected.state.explicitScopes.map(scope => scope.start.startByte)), startsMidRecord: false };
  }
  if (!floor) {
    const { configHash } = await workflowProcessingContext(capability);
    const name = processingSourcePath(identity, configHash), snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: 16384 });
    if (!snapshot.bytes) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    const value = validateProcessingSource(intakeJSON(snapshot), identity, configHash, snapshot.bytes);
    source = { ...identity, path: value.snapshot.path, fileIdentity: value.snapshot.fileIdentity, projectRoot: value.cwd };
    // Collection stays off. Only the explicit MCP request may inspect this
    // source, starting at the immutable metadata-only hook boundary.
    await assertWorkflowStorage(capability, { ...identity, cwd: source.projectRoot }, 'explicitProcess');
    const inspected = await inspectSourceBoundary({ ...identity, path: source.path, projectRoot: source.projectRoot }, {
      frozen: value.snapshot, verifyHeader: (context.client === 'codex' ? codexRegistrationHeader : claudeRegistrationHeader)(source) });
    if (inspected.status !== 'registered') fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    source = inspected.source; floor = inspected.boundary;
    processingBinding = { name, hash: snapshot.hash };
  }
  const selection = { client: context.client, sessionId: context.sessionId, cwd: source.projectRoot, unitId: null };
  await assertWorkflowStorage(capability, selection, 'explicitProcess');
  const endByte = Number((await fs.lstat(source.path, { bigint: true })).size);
  const from = Math.max(floor.eofByte, endByte - MAX_PREFIX);
  const read = await readSessionRange({ source, from, endByte,
    startsMidRecord: from === floor.eofByte ? floor.startsMidRecord : true,
    maxBytes: MAX_PREFIX, maxRecords: 4096,
    ...(context.client === 'codex' ? { verifyHeader: verifyCodexHeader }
      : { readHeader: claudeRegistrationHeader(source), verifyHeader: value => value }) });
  if (read.blocked || read.limited) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  const argsHash = digest(canonicalJSON(invocation.arguments));
  let call = null, unitId = context.unitId ?? null, nativeSkill = false;
  for (const record of read.records) {
    const row = record.value;
    if (context.client === 'codex') {
      const p = row.payload;
      if (row.type === 'event_msg' && p?.type === 'item_completed' && p.turn_id === unitId && p.item?.type === 'UserMessage') {
        const content = p.item.content;
        nativeSkill = Array.isArray(content) && content.length === 2 && content[0]?.type === 'skill' &&
          content[0].name === 'cuefluent-notes' && path.normalize(content[0].path ?? '') === path.normalize(skillPath) &&
          content[1]?.type === 'text' && content[1].text === (invocation.tool === 'processing_review' ? 'review' : 'process');
      }
      if (row.type !== 'response_item' || p?.type !== 'function_call' || p.call_id !== context.toolCallId) continue;
      if (call || p.internal_chat_message_metadata_passthrough?.turn_id !== unitId ||
          !/^mcp__[a-zA-Z0-9_-]*cuefluent_control$/.test(p.namespace ?? '') || p.name !== invocation.tool) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      let args; try { args = JSON.parse(p.arguments); } catch { fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED'); }
      if (digest(canonicalJSON(args)) !== argsHash) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      call = { tool: `${p.namespace}.${p.name}`, callId: p.call_id };
    } else {
      if (row.sessionId !== source.sessionId || row.type !== 'assistant' || row.isSidechain === true ||
          row.message?.role !== 'assistant' || !Array.isArray(row.message?.content)) continue;
      for (const block of row.message.content) {
        if (block?.type !== 'tool_use' || block.id !== context.toolCallId) continue;
        if (call || !/^mcp__[a-zA-Z0-9_-]*cuefluent_control__/.test(block.name ?? '') ||
            !block.name.endsWith(`__${invocation.tool}`) || digest(canonicalJSON(block.input)) !== argsHash) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
        call = { tool: block.name, callId: block.id };
        // Ordinary Claude assistant parentage is not prompt identity evidence.
        // This binding does not authorize excluding the parent user message.
      }
    }
  }
  if (!call) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  let controlInput = null;
  if (context.client === 'claude') {
    const skill = await loadClaudeProcessingSkill({ skillPath, skillCommand, control: invocation.tool === 'processing_review' ? 'review' : 'process' });
    controlInput = findClaudeProcessingControlInput(read.records, { source, ...call, argsHash, skill });
    if (controlInput) { nativeSkill = true; unitId = controlInput.unitId; }
  }
  await assertWorkflowStorage(capability, selection, 'explicitProcess');
  if ((await readSelection(store, identity)).hash !== selected.hash || (processingBinding &&
      (await intakeSnapshot(store, 'state', processingBinding.name, { maxBytes: 16384 })).hash !== processingBinding.hash)) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  const result = Object.freeze({ source: Object.freeze(structuredClone(source)), selection: Object.freeze(selection),
    selectionHash: selected.hash, captureActive: selected.state?.active === true && !selected.state.paused, nativeSkill, unitId, argsHash, ...call,
    ...(controlInput ? Object.fromEntries(['inputId', 'inputHash', 'companionId', 'companionHash', 'skillExpansionHash', 'skillCommand'].map(key => [key, controlInput[key]])) : {}) });
  bindings.add(result); return result;
}

/** Claude may keep its MCP process across /clear. The launch UUID is a hint;
 * a fallback binds only the exact native tool-use ID in already registered,
 * authorized sources. No client archive discovery, cwd/latest guess or new grant.
 */
export async function resolveProcessingInvocation(capability, context, invocation, options) {
  try { return await resolveBoundInvocation(capability, context, invocation, options); }
  catch (error) { if (context.client !== 'claude' || error.code !== 'PROCESSING_CONTROL_SOURCE_UNVERIFIED') throw error; }
  const store = await openWorkflowIntake(capability);
  const matches = [], seen = new Set([context.sessionId]); let entries = 0, inspected = 0;
  for (const [name, directories] of [['sessions/claude', false], [processingSourceDirectory('claude'), true]]) {
    const directory = path.dirname(await intakePath(store, 'state', `${name}/.list`));
    if (!await lstatOrNull(directory)) continue;
    for await (const entry of await fs.opendir(directory)) {
      checkWorkflowBudget();
      if (++entries > 128) fail('PROCESSING_SOURCE_DISCOVERY_LIMIT');
      const sessionId = directories ? entry.name : entry.name.endsWith('.json') ? entry.name.slice(0, -5) : null;
      if (!isNativeId(sessionId)) continue; // Unrelated files cannot supply a candidate.
      if (directories ? !entry.isDirectory() : !entry.isFile()) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      if (++inspected > 32) fail('PROCESSING_SOURCE_DISCOVERY_LIMIT');
      try { matches.push(await resolveBoundInvocation(capability, { ...context, sessionId }, invocation, options)); }
      catch (error) {
        if (!['PROCESSING_CONTROL_SOURCE_UNVERIFIED', 'WORKFLOW_NOT_AUTHORIZED', 'ENOENT'].includes(error.code)) throw error;
      }
    }
  }
  if (matches.length !== 1) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  return matches[0];
}
