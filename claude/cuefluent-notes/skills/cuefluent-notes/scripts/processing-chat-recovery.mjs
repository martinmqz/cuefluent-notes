import { assertWorkflowStorage } from './workflow-storage.mjs';
import { openWorkflowIntake, withIntakeLock } from './intake-io.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { findCompletedProcessingExecution } from './processing-execution-receipts.mjs';
import { locateProcessingExecutionSource, verifyProcessingExecution, verifyInterruptedProcessingExecution, verifyFailedProcessingExecution, isProcessingExecutionProof } from './processing-execution-proof.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { verifyCodexHeader } from './codex-reader.mjs';
import { canonicalJSON, fail, object } from './workflow-values.mjs';

async function settingsTail(source, receipt, eofByte, proof) {
  if (eofByte === receipt.endByte) return true;
  if (eofByte < receipt.endByte || eofByte - receipt.endByte > 64 * 1024) return false;
  const tail = await readSessionRange({ source, from: receipt.endByte, endByte: eofByte,
    verifyHeader: verifyCodexHeader, maxBytes: 64 * 1024, maxRecords: 32 });
  if (tail.blocked || tail.limited || tail.pendingTail || tail.discarded.length || tail.readEnd !== eofByte) return false;
  let ordinal = Number(proof.recordIds.at(-1).split(':').at(-1));
  return tail.records.every(record => {
    const row = record.value, payload = row.payload;
    return row.ordinal === ++ordinal && row.type === 'event_msg' && object(payload) &&
      payload.type === 'thread_settings_applied' && payload.thread_id === source.sessionId && object(payload.thread_settings) &&
      Object.keys(payload).every(key => ['type', 'thread_id', 'thread_settings'].includes(key));
  });
}

/** Recover only a native execution that already reached the private sealing
 * callback. Native interruptions without a sealed terminal remain unresolved.
 * No client dispatch, claim disposal, note write or receipt creation occurs here. */
export async function reconcileCompletedProcessingExecution({ capability, session, request, claudeConfigDir }) {
  // Codex has a verified full-unit terminal; Claude's input-only proof does not
  // currently demonstrate that a crashed native execution is no longer active.
  if (session.client !== 'codex' || !request.selection) return null;
  const guard = async () => { await assertWorkflowStorage(capability, request.selection, 'explicitProcess'); return true; };
  return withStorageProbes(async () => {
    await guard();
    const store = await openWorkflowIntake(capability, request.selection, 'explicitProcess');
    const receipt = await withIntakeLock(store, tx => findCompletedProcessingExecution(tx, {
      session, requestId: request.requestId, inputHash: request.inputHash, authorize: guard,
    }));
    if (!receipt) return null;
    const before = await locateProcessingExecutionSource(session, { claudeConfigDir });
    // Later native work or a still-growing tail must never inherit the old
    // completion. Explicit recovery does not scan ahead and guess its meaning.
    if (!before || before.eofByte < receipt.endByte || before.path !== receipt.sourcePath || before.fileIdentity !== receipt.sourceIdentity) return null;
    const { eofByte, ...source } = before;
    const verifier = receipt.terminal === 'interrupted' ? verifyInterruptedProcessingExecution
      : receipt.terminal === 'failed' ? verifyFailedProcessingExecution : verifyProcessingExecution;
    const proof = await verifier({ source, unitId: receipt.unitId,
      fromByte: receipt.fromByte, endByte: receipt.endByte }, { resolveExecution: async () => receipt });
    if (!isProcessingExecutionProof(proof) || proof.evidenceScope !== 'unit') return null;
    // Native resume records its newly verified restrictions without starting a
    // task. No other tail, including a new task_started, is safe to release.
    if (!await settingsTail(source, receipt, eofByte, proof)) return null;
    const after = await locateProcessingExecutionSource(session, { claudeConfigDir });
    if (canonicalJSON(after) !== canonicalJSON(before)) fail('PROCESSING_EXECUTION_CHANGED');
    await guard();
    return { proof, nativeRun: { runId: receipt.unitId, inputId: receipt.inputId, unitIds: [receipt.unitId],
      ...(receipt.terminal !== 'completed' ? { terminal: receipt.terminal } : {}) } };
  });
}
