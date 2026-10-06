import path from 'node:path';
import { isMain, readBoundedBytes } from './file-io.mjs';
import { workflowConfigPath } from './workflow-config.mjs';
import { workflowDefaults } from './workflow-paths.mjs';
import { workflowStatus, configureWorkflow, prepareConfiguredStorage } from './workflow-settings.mjs';
import { verifyWorkflowStorage } from './workflow-storage.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { captureSelectionStatus, controlCapture, restrictCapture, previewExplicitCapture, selectExplicitCapture, runSelectedCapture } from './capture-controls.mjs';
import { pendingProcessing } from './processing-inventory.mjs';
import { prepareProcessing, readProcessingPage, acknowledgeProcessingPages, proposeProcessing, saveProcessing,
  completeProcessing, inspectProcessing, recoverProcessing } from './processing.mjs';
import { captureStorageStatus, previewCapturePrune, applyCapturePrune, recoverCapturePrune, abandonCapturePrune } from './capture-maintenance.mjs';
import { inspectIntakeRecovery, applyIntakeRecovery } from './intake-recovery.mjs';
import { fingerprint, inspectDirectories, inspectExistingDirectories, inspectState, recover } from './safe-update.mjs';
import { saveDirectNote } from './direct-save.mjs';
import { prepareNote } from './note-generation.mjs';
import { keys, id, hash, list, fail, canonicalJSON } from './workflow-values.mjs';

// Public request schemas expose selections and inspected hashes, never native
// reader proofs, lock capabilities, callback code or hook-context authority.
const commands = {
  'capture-status': { required: ['selection'], optional: ['sourcePath'], run: captureSelectionStatus },
  'capture-control': { required: ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'operation'], run: controlCapture },
  'capture-preview': { required: ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'kind', 'unitIds', 'readRange'], run: previewExplicitCapture },
  'capture-select': { required: ['selection', 'sourcePath', 'expectedSourceIdentity', 'expectedSelectionHash', 'operationId', 'kind', 'unitIds', 'readRange'], run: selectExplicitCapture },
  'capture-run': { required: ['selection', 'scopeId', 'expectedSelectionHash'], optional: ['unitIds'], run: runSelectedCapture },
  'processing-pending': { required: ['selection'], optional: ['limit', 'afterUnitId'], run: pendingProcessing },
  'processing-prepare': { required: ['selection', 'operationId', 'inputs'], optional: ['reconsider'], run: prepareProcessing },
  'processing-page': { required: ['selection', 'operationId', 'expectedClaimHash', 'page'], run: readProcessingPage },
  'processing-ack': { required: ['selection', 'operationId', 'expectedClaimHash', 'pages'], run: acknowledgeProcessingPages },
  'processing-propose': { required: ['selection', 'operationId', 'expectedClaimHash', 'proposal'], run: proposeProcessing },
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
  return { usage: 'node scripts/workflow.mjs <command> [--config <absolute-path>] --request <absolute-json-file>',
    commands: [...extra, ...Object.keys(commands)], request: 'Collection operations use {collectionId, expectedConfigHash, args}. See references/workflow-cli.md.',
    transport: 'No verified current-turn contextRef. Select native sessions explicitly; never choose the latest session by cwd.' };
}
async function capability(configPath, request) {
  id(request.collectionId); hash(request.expectedConfigHash);
  return verifyWorkflowStorage({ configPath, collectionId: request.collectionId, expectedConfigHash: request.expectedConfigHash });
}
export async function executeWorkflow(command, request, { configPath } = {}) {
  if (command === 'prepare-note') return prepareNote(request);
  if (configPath === undefined) configPath = workflowConfigPath();
  if (command === 'status') { keys(request, [], ['selection']); return workflowStatus({ configPath, ...request }); }
  if (command === 'defaults') {
    keys(request, [], ['collectionId']);
    const value = workflowDefaults(request);
    return value.rawDir ? { ...value, writerStateDir: path.join(path.dirname(value.rawDir), 'writer') } : value;
  }
  if (command === 'configure') { keys(request, ['expectedHash', 'proposal']); return configureWorkflow({ configPath, ...request }); }
  if (command === 'storage-prepare') { keys(request, ['collectionId', 'expectedConfigHash']); return prepareConfiguredStorage({ configPath, ...request }); }
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
    return saveDirectNote(request, Object.hasOwn(request, 'collectionId') ? await capability(configPath, request) : null);
  }
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
  return withStorageProbes(() => executeWorkflow(command, request, { configPath: workflowConfigPath({ explicit: options['--config'] }) }));
}
if (await isMain(import.meta.url)) main(process.argv.slice(2)).then(result => process.stdout.write(canonicalJSON(result) + '\n')).catch(error => {
  // Parser/OS exceptions never echo source bodies. Writer-authored diagnostics
  // are fixed guidance (occasionally with a selected path), bounded separately.
  process.stderr.write(JSON.stringify({ error: /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code ?? '') ? error.code : 'WORKFLOW_OPERATION_FAILED',
    ...(error.code === 'SAFE_UPDATE_REJECTED' && typeof error.safeMessage === 'string'
      ? { reason: error.safeMessage.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) } : {}),
    ...(Array.isArray(error.cleanupWarnings) && error.cleanupWarnings.length
      ? { cleanupWarnings: ['Cleanup could not be verified; retained state requires inspection.'] } : {}) }) + '\n');
  process.exitCode = 1;
});
