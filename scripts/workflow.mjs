import path from 'node:path';
import { isMain, readBoundedBytes } from './file-io.mjs';
import { workflowDefaults, resolveWorkflowConfig } from './workflow-paths.mjs';
import { workflowStatus, configureWorkflow, prepareConfiguredStorage } from './workflow-settings.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { captureSelectionStatus, controlCapture, restrictCapture, previewExplicitCapture, selectExplicitCapture, runSelectedCapture } from './capture-controls.mjs';
import { PROCESSING_INTERFACE_VERSION } from './processing-contract.mjs';
import { createProcessingWorkset, prepareWorksetBatch, inspectProcessingWorkset, listProcessingWorksets } from './processing-workset.mjs';
import { pendingProcessing } from './processing-inventory.mjs';
import { prepareProcessing, readProcessingPage, acknowledgeProcessingPages, proposeProcessing, saveProcessing,
  completeProcessing, inspectProcessing, recoverProcessing } from './processing.mjs';
import { captureStorageStatus, previewCapturePrune, applyCapturePrune, recoverCapturePrune, abandonCapturePrune } from './capture-maintenance.mjs';
import { inspectIntakeRecovery, applyIntakeRecovery } from './intake-recovery.mjs';
import { fingerprint, inspectDirectories, inspectExistingDirectories, inspectState, recover } from './safe-update.mjs';
import { saveDirectNote } from './direct-save.mjs';
import { prepareNote } from './note-generation.mjs';
import { keys, id, hash, list, fail, canonicalJSON, safeErrorCode } from './workflow-values.mjs';

// Public request schemas expose selections and inspected hashes, never native
// reader proofs, lock capabilities, callback code or hook-context authority.
const commands = {
  'capture-status': { required: ['selection'], optional: ['sourcePath', 'scopeId', 'includeReaderAllocation'], run: captureSelectionStatus },
  'capture-control': { required: ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'operation'], run: controlCapture },
  'capture-preview': { required: ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'kind', 'unitIds', 'readRange'], run: previewExplicitCapture },
  'capture-select': { required: ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'kind', 'unitIds', 'readRange'], run: selectExplicitCapture },
  'capture-run': { required: ['selection', 'scopeId', 'expectedSelectionHash'], optional: ['unitIds'], run: runSelectedCapture },
  'processing-pending': { required: ['selection'], optional: ['limit', 'afterUnitId'], run: pendingProcessing },
  'processing-worksets': { required: [], optional: ['selection', 'limit', 'afterWorksetId'], run: listProcessingWorksets },
  'processing-workset-create': { required: ['selection', 'worksetId', 'inputs'], optional: ['runBudget', 'unscannedRemainder'], run: createProcessingWorkset },
  'processing-workset-status': { required: ['worksetId'], run: inspectProcessingWorkset },
  'processing-workset-prepare': { required: ['worksetId', 'expectedWorksetHash', 'indexes'], optional: ['batchBudget', 'parallelism'], run: prepareWorksetBatch },
  'processing-prepare': { required: ['selection', 'operationId', 'inputs'], optional: ['reconsider', 'budget', 'parallelism'], run: prepareProcessing },
  'processing-page': { required: ['selection', 'operationId', 'expectedClaimHash', 'page'], run: readProcessingPage },
  'processing-ack': { required: ['selection', 'operationId', 'expectedClaimHash', 'pages'], run: acknowledgeProcessingPages },
  'processing-propose': { required: ['selection', 'operationId', 'expectedClaimHash'], optional: ['proposal'], run: proposeProcessing },
  'processing-save': { required: ['selection', 'operationId', 'expectedClaimHash', 'approvedProposalHash', 'trigger'], run: saveProcessing },
  'processing-complete': { required: ['selection', 'operationId', 'expectedClaimHash', 'outcome'], optional: ['expectedRecoveryHash'], run: completeProcessing },
  'processing-status': { required: ['operationId'], run: (cap, args) => inspectProcessing(cap, args.operationId) },
  'processing-recover': { required: ['operationId', 'expectedRecoveryHash'], run: recoverProcessing },
  'storage-status': { required: [], run: cap => captureStorageStatus(cap) },
  'prune-preview': { required: ['identities'], optional: ['before'], run: previewCapturePrune },
  'prune-apply': { required: ['reviewed'], run: (cap, args) => applyCapturePrune(cap, args.reviewed) },
  'prune-recover': { required: ['expectedPlanHash'], run: (cap, args) => recoverCapturePrune(cap, args.expectedPlanHash) },
  'prune-abandon': { required: ['expectedPlanHash'], run: (cap, args) => abandonCapturePrune(cap, args.expectedPlanHash) },
  'intake-recovery-status': { required: [], run: cap => inspectIntakeRecovery(cap) },
  'intake-recover': { required: ['reviewed', 'offline'], run: (cap, args) => applyIntakeRecovery(cap, args.reviewed, { offline: args.offline }) },
};
const extra = ['status', 'defaults', 'configure', 'storage-prepare', 'fingerprint', 'inspect-notes', 'prepare-note', 'direct-save', 'writer-status', 'writer-recover'];
export function workflowHelp() {
  return { interfaceVersion: PROCESSING_INTERFACE_VERSION, usage: 'node scripts/workflow.mjs <command> [--config <absolute-path>] --request <absolute-json-file>',
    commands: [...extra, ...Object.keys(commands)], request: 'Collection operations use {collectionId, expectedConfigHash, args}. See references/workflow-cli.md.',
    transport: 'No verified current-turn contextRef. Select native sessions explicitly; never choose the latest session by cwd.' };
}
async function capability(configPath, request) {
  id(request.collectionId); hash(request.expectedConfigHash);
  return verifyWorkflowStorage({ configPath, collectionId: request.collectionId, expectedConfigHash: request.expectedConfigHash });
}
export async function executeWorkflow(command, request, { configPath } = {}) {
  if (command === 'prepare-note') return prepareNote(request);
  if (command === 'defaults') {
    keys(request, [], ['collectionId']);
    return workflowDefaults({ ...request, explicit: configPath });
  }
  if (command === 'fingerprint') {
    keys(request, ['paths']); list(request.paths, 100, { empty: false });
    if (request.paths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) fail('ABSOLUTE_PATH_REQUIRED');
    return { files: await Promise.all(request.paths.map(async file => ({ path: file, hash: await fingerprint(file) }))) };
  }
  if (command === 'inspect-notes') {
    keys(request, ['root', 'paths'], ['existing']);
    if (request.existing !== undefined && typeof request.existing !== 'boolean') fail('INVALID_WORKFLOW');
    return (request.existing ? inspectExistingDirectories : inspectDirectories)(request.root, request.paths);
  }
  if (command === 'writer-status') { keys(request, ['stateDir']); return inspectState(request.stateDir); }
  if (command === 'writer-recover') {
    keys(request, ['stateDir', 'expectedJournalHash']); hash(request.expectedJournalHash);
    return recover(request.stateDir, { expectedJournalHash: request.expectedJournalHash });
  }
  if (command === 'direct-save') {
    keys(request, ['plan', 'approvedPlanHash'], ['collectionId', 'expectedConfigHash']);
    if (Object.hasOwn(request, 'collectionId') !== Object.hasOwn(request, 'expectedConfigHash')) fail('INVALID_WORKFLOW');
    if (!Object.hasOwn(request, 'collectionId')) return saveDirectNote(request, null);
  }
  // Manual operations above use only their inspected paths and plans. Resolve
  // settings only for work that actually depends on a selected configuration.
  const selection = await resolveWorkflowConfig({ explicit: configPath });
  const { requestedConfigPath, explicit: explicitConfig } = selection;
  configPath = selection.configPath;
  if (command === 'status') { keys(request, [], ['selection', 'diagnostics']); return workflowStatus({ configPath, requestedConfigPath, ...request }); }
  if (command === 'configure') { keys(request, ['expectedHash', 'proposal']); return configureWorkflow({ configPath, ...request }, { explicitConfig, requestedConfigPath }); }
  if (command === 'storage-prepare') { keys(request, ['collectionId', 'expectedConfigHash']); return prepareConfiguredStorage({ configPath, ...request }); }
  if (command === 'direct-save') return saveDirectNote(request, await capability(configPath, request));
  const definition = commands[command];
  if (!definition || !Object.hasOwn(commands, command)) fail('UNKNOWN_WORKFLOW_COMMAND');
  keys(request, ['collectionId', 'expectedConfigHash', 'args']);
  keys(request.args, definition.required, definition.optional ?? []);
  if (command === 'capture-control' && ['pause', 'exclude'].includes(request.args.operation)) {
    id(request.collectionId); hash(request.expectedConfigHash);
    return restrictCapture({ configPath, collectionId: request.collectionId, expectedConfigHash: request.expectedConfigHash }, request.args);
  }
  return definition.run(await capability(configPath, request), request.args);
}
export async function main(args) {
  const [command, ...rest] = args;
  if (command === '--help' && !rest.length) return workflowHelp();
  if (!extra.includes(command) && !Object.hasOwn(commands, command)) fail('UNKNOWN_WORKFLOW_COMMAND');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i], value = rest[i + 1];
    if (!['--config', '--request'].includes(name) || !value || !path.isAbsolute(value) || Object.hasOwn(options, name)) fail('INVALID_WORKFLOW_ARGUMENTS');
    options[name] = value;
  }
  if (!options['--request'] && !['status', 'defaults'].includes(command)) fail('WORKFLOW_REQUEST_REQUIRED');
  let request = {};
  if (options['--request']) {
    // Two bounded Markdown strings can require six JSON bytes per character.
    const maxBytes = (command === 'prepare-note' ? 25 : 2) * 1024 * 1024;
    const bytes = await readBoundedBytes(options['--request'], { maxBytes, noFollow: true });
    try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_WORKFLOW_REQUEST_JSON'); }
  }
  if (command === 'prepare-note') return prepareNote(request);
  return withStorageProbes(() => executeWorkflow(command, request, { configPath: options['--config'] }));
}
/** Only known numeric capacity measurements may cross the CLI error boundary. */
export function workflowErrorReport(error) {
  const details = {}, code = safeErrorCode(error, 'WORKFLOW_OPERATION_FAILED');
  if (['NOTE_METADATA_SOURCE_CAPACITY', 'NOTE_METADATA_BYTE_CAPACITY', 'PROCESSING_BATCH_BUDGET', 'PROCESSING_PROPOSAL_QUEUE_FULL', 'PROCESSING_RESUME_REQUIRED'].includes(code)) {
    for (const key of ['current', 'proposed', 'limit', 'inputs', 'maxInputs', 'packetBytes', 'maxPacketBytes']) {
      const value = Object.getOwnPropertyDescriptor(error.details ?? {}, key)?.value;
      if (Number.isSafeInteger(value) && value >= 0) details[key] = value;
    }
  }
  if (['PROCESSING_RESUME_REQUIRED', 'PROCESSING_PROPOSAL_QUEUE_FULL'].includes(code)) {
    const ids = Object.getOwnPropertyDescriptor(error.details ?? {}, 'operationIds')?.value;
    if (Array.isArray(ids) && ids.length <= 100 && ids.every(value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))) details.operationIds = [...ids];
  }
  if (code === 'PROCESSING_BATCH_BUDGET') {
    const sizes = Object.getOwnPropertyDescriptor(error.details ?? {}, 'inputSizes')?.value;
    if (Array.isArray(sizes) && sizes.length <= 20 && sizes.every(item => item && Number.isSafeInteger(item.index) && item.index >= 0 && item.index < 20 && Number.isSafeInteger(item.packetBytes) && item.packetBytes > 0 && item.packetBytes <= 4194304)) details.inputSizes = sizes.map(({ index, packetBytes }) => ({ index, packetBytes }));
  }
  // Parser/OS exceptions never echo source bodies. Writer-authored diagnostics
  // are fixed guidance (occasionally with a selected path), bounded separately.
  const operationId = Object.getOwnPropertyDescriptor(error ?? {}, 'operationId')?.value;
  const worksetId = Object.getOwnPropertyDescriptor(error ?? {}, 'worksetId')?.value;
  return { error: code,
    ...(typeof worksetId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(worksetId) ? { worksetId } : {}),
    ...(typeof operationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId) ? { operationId } : {}),
    ...(Object.keys(details).length ? { details } : {}),
    ...(code === 'SAFE_UPDATE_REJECTED' && typeof error.safeMessage === 'string'
      ? { reason: error.safeMessage.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) } : {}),
    ...(Array.isArray(error?.cleanupWarnings) && error.cleanupWarnings.length
      ? { cleanupWarnings: ['Cleanup could not be verified; retained state requires inspection.'] } : {}) };
}
if (await isMain(import.meta.url)) main(process.argv.slice(2)).then(result => process.stdout.write(canonicalJSON(result) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify(workflowErrorReport(error)) + '\n');
  process.exitCode = 1;
});
