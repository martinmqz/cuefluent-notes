import { assertIntakeTransaction, intakeSnapshot, intakeJSON, replaceIntakeJSON,
  openWorkflowIntake, withIntakeLock } from './intake-io.mjs';
import { assertWorkflowStorage } from './workflow-storage.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { locateProcessingExecutionSource, resolveClaudeProcessingUnit, verifyProcessingExecution,
  verifyInterruptedProcessingExecution, verifyFailedProcessingExecution, isProcessingExecutionProof } from './processing-execution-proof.mjs';
import { readSessionRange } from './session-jsonl.mjs';
import { verifyCodexHeader } from './codex-reader.mjs';
import { processingToolDeclarations } from './processing-tool-contracts.mjs';
import { absolutePath } from './workflow-paths.mjs';
import { canonicalJSON, digest, fail, keys, nativeId, hash, integer, choice, CLIENTS } from './workflow-values.mjs';

const MAX_BYTES = 32 * 1024;
const FORMAT = 'cuefluent-processing-execution';
const filename = ({ client, sessionId, unitId }) => {
  choice(client, CLIENTS); nativeId(sessionId); nativeId(unitId);
  return `processing-executions/${client}/${sessionId}/${unitId}.json`;
};
const requestFilename = ({ client, sessionId, requestId }) => {
  choice(client, CLIENTS); nativeId(sessionId); nativeId(requestId);
  return `processing-execution-requests/${client}/${sessionId}/${requestId}.json`;
};
function validate(value) {
  keys(value, ['format', 'version', 'client', 'sessionId', 'unitId', 'requestId', 'inputId', 'inputHash',
    'sourcePath', 'sourceIdentity', 'profileId', 'toolContractHash', 'allowedTools', 'completed', 'policyVerified',
    'fromByte', 'endByte', 'recordsHash', 'terminal']);
  if (value.format !== FORMAT || value.version !== 1 || value.completed !== true || value.policyVerified !== true) fail('INVALID_PROCESSING_EXECUTION');
  filename(value); nativeId(value.requestId); nativeId(value.inputId); absolutePath(value.sourcePath);
  choice(value.terminal, ['completed', 'interrupted', 'failed']);
  if (value.terminal !== 'completed' && value.client !== 'codex') fail('INVALID_PROCESSING_EXECUTION');
  for (const key of ['inputHash', 'sourceIdentity', 'profileId', 'toolContractHash', 'recordsHash']) hash(value[key]);
  integer(value.fromByte); integer(value.endByte);
  if (value.endByte <= value.fromByte || value.endByte - value.fromByte > 16 * 1024 * 1024) fail('INVALID_PROCESSING_EXECUTION');
  const prefix = value.client === 'codex' ? 'cuefluent_' : 'mcp__cuefluent_engine__';
  const allowed = new Set(processingToolDeclarations(prefix).map(tool => tool.name));
  if (!Array.isArray(value.allowedTools) || value.allowedTools.length !== allowed.size ||
      new Set(value.allowedTools).size !== allowed.size || value.allowedTools.some(name => !allowed.has(name))) fail('INVALID_PROCESSING_EXECUTION');
  return value;
}
function parse(snapshot) {
  if (snapshot.bytes === null) return null;
  const value = validate(intakeJSON(snapshot));
  if (!snapshot.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('INVALID_PROCESSING_EXECUTION');
  return value;
}

/** Bounded controller recovery lookup in one already-bound native session.
 * Never searches transcript archives or infers the newest operation. */
export async function findCompletedProcessingExecution(transaction, { session, requestId, inputHash, authorize }) {
  nativeId(requestId); hash(inputHash); hash(session.profileId); hash(session.toolContractHash);
  choice(session.client, CLIENTS); nativeId(session.sessionId);
  if (typeof authorize !== 'function' || await authorize() !== true) fail('INTAKE_NOT_AUTHORIZED');
  const store = await assertIntakeTransaction(transaction);
  const requestName = requestFilename({ ...session, requestId });
  const indexed = parse(await intakeSnapshot(store, 'state', requestName, { maxBytes: MAX_BYTES }));
  if (indexed) {
    if (requestFilename(indexed) !== requestName || indexed.inputHash !== inputHash || indexed.inputId !== requestId ||
        indexed.profileId !== session.profileId || indexed.toolContractHash !== session.toolContractHash ||
        (session.client === 'codex' && indexed.sourcePath !== session.sourcePath)) fail('PROCESSING_EXECUTION_CONFLICT');
    const unit = parse(await intakeSnapshot(store, 'state', filename(indexed), { maxBytes: MAX_BYTES }));
    if (unit && canonicalJSON(unit) !== canonicalJSON(indexed)) fail('PROCESSING_EXECUTION_CONFLICT');
    // The proof-sealed request record is published first. If publication stopped
    // before its identical unit projection, recovery still has the exact bytes;
    // collection simply has no unit receipt to use until an authorized retry.
    if (await authorize() !== true) fail('INTAKE_NOT_AUTHORIZED');
    await assertIntakeTransaction(transaction);
    return Object.freeze({ ...indexed, allowedTools: Object.freeze([...indexed.allowedTools]) });
  }
  // Missing current request authority grants no recovery. Unit projections
  // are not searched or promoted into request records.
  if (await authorize() !== true) fail('INTAKE_NOT_AUTHORIZED');
  await assertIntakeTransaction(transaction);
  return null;
}

/** Internal completed-client callback only. Serialized CLI requests cannot mint
 * this authority. A receipt also requires the opaque native byte-level proof. */
export async function recordProcessingExecution(transaction, receipt, proof) {
  if (!isProcessingExecutionProof(proof)) fail('PROCESSING_EXECUTION_UNVERIFIED');
  const value = validate({ format: FORMAT, version: 1, ...structuredClone(receipt),
    fromByte: proof.fromByte, endByte: proof.endByte, recordsHash: proof.recordsHash, terminal: proof.terminal });
  for (const key of ['client', 'sessionId', 'unitId', 'requestId', 'inputId', 'inputHash', 'sourcePath', 'sourceIdentity', 'profileId', 'toolContractHash']) {
    if (value[key] !== proof[key]) fail('PROCESSING_EXECUTION_UNVERIFIED');
  }
  const store = await assertIntakeTransaction(transaction), name = filename(value), requestName = requestFilename(value);
  const snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: MAX_BYTES }), previous = parse(snapshot);
  const requestSnapshot = await intakeSnapshot(store, 'state', requestName, { maxBytes: MAX_BYTES }), indexed = parse(requestSnapshot);
  // Current publication writes the request first. A unit-only record cannot
  // result from that write order and must not be migrated by a retry.
  if ((previous && (!indexed || canonicalJSON(previous) !== canonicalJSON(value))) ||
      (indexed && canonicalJSON(indexed) !== canonicalJSON(value))) fail('PROCESSING_EXECUTION_CONFLICT');
  if (!indexed) await replaceIntakeJSON(transaction, requestName, value, null);
  if (previous) return snapshot.hash;
  return replaceIntakeJSON(transaction, name, value, null);
}

/** Current collection authorization remains with the locked reader. Missing or
 * mismatched receipts grant no exclusion, even for a chat with the right title. */
export function createProcessingExecutionResolver(transaction, { source, authorize }) {
  return async query => {
    keys(query, ['client', 'sessionId', 'unitId']);
    if (query.client !== source.client || query.sessionId !== source.sessionId) return null;
    if (typeof authorize !== 'function' || await authorize() !== true) fail('INTAKE_NOT_AUTHORIZED');
    const store = await assertIntakeTransaction(transaction);
    const value = parse(await intakeSnapshot(store, 'state', filename(query), { maxBytes: MAX_BYTES }));
    if (!value || value.sourcePath !== source.path || value.sourceIdentity !== source.fileIdentity ||
        Object.entries(query).some(([key, item]) => value[key] !== item)) return null;
    const indexed = parse(await intakeSnapshot(store, 'state', requestFilename(value), { maxBytes: MAX_BYTES }));
    if (!indexed) return null;
    if (canonicalJSON(indexed) !== canonicalJSON(value)) fail('PROCESSING_EXECUTION_CONFLICT');
    if (await authorize() !== true) fail('INTAKE_NOT_AUTHORIZED');
    return Object.freeze({ ...value, allowedTools: Object.freeze([...value.allowedTools]) });
  };
}

/** The restricted clients disable inherited hooks before accepting model input.
 * This seals completed ranges for later explicitly selected/replayed collection;
 * it never registers a processing chat or changes collection policy. */
export function processingExecutionCallbacks({ capability, claudeConfigDir }) {
  let active = null;
  const guard = async () => {
    if (!active) fail('PROCESSING_EXECUTION_UNVERIFIED');
    return withStorageProbes(() => assertWorkflowStorage(capability, active.selection, 'explicitProcess'));
  };
  async function seal(context, terminal) {
      await guard();
      if (context.requestId !== active.requestId || context.inputHash !== active.inputHash ||
          context.session.sessionId !== active.session.sessionId) fail('PROCESSING_EXECUTION_UNVERIFIED');
      const snapshot = await locateProcessingExecutionSource(context.session, { claudeConfigDir });
      if (!snapshot || (active.before && (snapshot.path !== active.before.path || snapshot.fileIdentity !== active.before.fileIdentity))) fail('PROCESSING_EXECUTION_UNVERIFIED');
      const { eofByte, ...source } = snapshot;
      let endByte = eofByte, fromByte = active.before?.eofByte ?? 0, unitId = context.result.unitId;
      if (source.client === 'codex') {
        const read = await readSessionRange({ source, from: fromByte, endByte, verifyHeader: verifyCodexHeader,
          maxBytes: 16 * 1024 * 1024, maxRecords: 16384 });
        if (read.blocked || read.limited || read.pendingTail || read.discarded.length) fail('PROCESSING_EXECUTION_UNVERIFIED');
        const starts = read.records.filter(record => record.value.type === 'event_msg' &&
          record.value.payload?.type === 'task_started' && record.value.payload.turn_id === unitId);
        if (starts.length !== 1) fail('PROCESSING_EXECUTION_UNVERIFIED');
        fromByte = starts[0].startByte;
        const ends = read.records.filter(record => record.startByte >= fromByte && record.value.type === 'event_msg' &&
          record.value.payload?.type === (terminal === 'interrupted' ? 'turn_aborted' : 'task_complete') && record.value.payload.turn_id === unitId);
        if (ends.length !== 1) fail('PROCESSING_EXECUTION_UNVERIFIED');
        endByte = ends[0].endByte;
      } else {
        const unit = await resolveClaudeProcessingUnit({ source, fromByte, endByte, inputId: context.inputId, inputHash: context.inputHash });
        if (!unit) fail('PROCESSING_EXECUTION_UNVERIFIED');
        unitId = unit.unitId;
      }
      const receipt = Object.freeze({ client: source.client, sessionId: source.sessionId, unitId,
        requestId: context.requestId, inputId: context.inputId, inputHash: context.inputHash,
        sourcePath: source.path, sourceIdentity: source.fileIdentity, profileId: context.session.profileId,
        toolContractHash: context.session.toolContractHash, completed: true, policyVerified: true, terminal,
        allowedTools: processingToolDeclarations(source.client === 'codex' ? 'cuefluent_' : 'mcp__cuefluent_engine__').map(tool => tool.name) });
      const verifier = terminal === 'interrupted' ? verifyInterruptedProcessingExecution
        : terminal === 'failed' ? verifyFailedProcessingExecution : verifyProcessingExecution;
      const proof = await verifier({ source, fromByte, endByte, unitId }, { resolveExecution: async () => receipt });
      if (!proof) fail('PROCESSING_EXECUTION_UNVERIFIED');
      await guard();
      await withStorageProbes(async () => {
        const store = await openWorkflowIntake(capability, active.selection, 'explicitProcess');
        await withIntakeLock(store, async transaction => {
          await guard(); await recordProcessingExecution(transaction, receipt, proof);
        });
      });
      return proof;
  }
  return {
    async beforeExecution(context) {
      active = structuredClone(context);
      await guard();
      active.before = await locateProcessingExecutionSource(context.session, { claudeConfigDir });
      await guard();
    },
    async guardExecution(context) {
      if (!active || active.requestId !== context.requestId || active.session.sessionId !== context.session.sessionId ||
          active.inputHash !== context.inputHash) fail('PROCESSING_EXECUTION_UNVERIFIED');
      await guard();
    },
    afterExecution(context) {
      const terminal = context.result?.status ?? 'completed';
      if (!['completed', 'failed'].includes(terminal) || (terminal === 'failed' && context.client !== 'codex')) fail('PROCESSING_EXECUTION_UNVERIFIED');
      return seal(context, terminal);
    },
    async afterInterruptedExecution(context) {
      if (context.client !== 'codex' || context.result?.status !== 'interrupted') fail('PROCESSING_EXECUTION_UNVERIFIED');
      return seal(context, 'interrupted');
    },
  };
}
