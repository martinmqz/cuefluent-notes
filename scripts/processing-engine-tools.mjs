import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyWorkflowStorage, assertWorkflowStorage } from './workflow-storage.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { normalizeWorkflowSelection, selectionIncludesIdentity } from './workflow-selection.mjs';
import { pendingProcessing } from './processing-inventory.mjs';
import { inspectProcessingWorkset, prepareWorksetBatch, worksetOperationId } from './processing-workset.mjs';
import { prepareProcessing, readProcessingPage, acknowledgeProcessingPages, inspectProcessing, proposeProcessing, completeProcessing } from './processing.mjs';
import { withProcessingState, processingSnapshot, writeProcessingBytes, removeProcessingJSON } from './processing-state.mjs';
import { validateClaim, claimPath, PROCESSING_INTERFACE_VERSION } from './processing-contract.mjs';
import { outputPath, validateMappings } from './processing-proposal.mjs';
import { intakeJSON } from './intake-io.mjs';
import { inspectDirectories, inspectExistingDirectories } from './safe-update.mjs';
import { isNoteCategory } from './note-organization.mjs';
import { prepareNote } from './note-generation.mjs';
import { isNoteSkillVersion } from './note-metadata.mjs';
import { PROCESSING_GUIDES } from './processing-tool-contracts.mjs';
import { SKILL_ROOT } from './runtime-paths.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { openGuarded, sameFileIdentity, compare, readBoundedBytes } from './file-io.mjs';
import { keys, list, string, hash, nativeId, integer, digest, canonicalJSON, fail } from './workflow-values.mjs';

const DRAFT_LIMIT = 900 * 1024;
const NOTE_LIMIT = 2 * 1024 * 1024;
const GUIDE_LIMIT = 64 * 1024;
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const schemas = Object.freeze({
  guidance_read: { required: ['guide'] },
  processing_pending: { required: [], optional: ['limit', 'afterUnitId'] },
  processing_status: { required: ['operationId'] },
  processing_prepare: { required: ['operationId', 'inputs'] },
  processing_page: { required: ['operationId', 'expectedClaimHash', 'page'] },
  processing_ack: { required: ['operationId', 'expectedClaimHash', 'pages'] },
  processing_propose: { required: ['operationId', 'expectedClaimHash'], optional: ['proposal'] },
  processing_complete: { required: ['operationId', 'expectedClaimHash'] },
  note_list: { required: [], optional: ['directory', 'limit', 'afterPath'] },
  note_read: { required: ['path'] },
  prepare_note: { required: ['original', 'content'], optional: ['metadata', 'enrich', 'contentHash', 'createSeries'] },
});

async function recordingContext() {
  const pkg = JSON.parse(await readBoundedBytes(path.join(SKILL_ROOT, 'package.json'), { maxBytes: 16 * 1024, noFollow: true }));
  if (pkg.name !== 'cuefluent-notes' || !isNoteSkillVersion(pkg.version)) fail('PROCESSING_GUIDANCE_INVALID');
  return { now: new Date().toISOString(), skillVersion: pkg.version,
    meaning: 'Recording time only. Source occurrence dates come from inspected evidence; unknown dates remain unknown.' };
}

async function readGuidance(guide) {
  if (typeof guide !== 'string' || !Object.hasOwn(PROCESSING_GUIDES, guide)) fail('PROCESSING_GUIDANCE_NOT_ALLOWED');
  const relative = PROCESSING_GUIDES[guide], file = path.join(SKILL_ROOT, relative);
  // The caller selects only a fixed guide name. Never follow a replacement
  // reference directory to arbitrary files outside the shipped skill.
  if (await fs.realpath(path.dirname(file)) !== path.dirname(file)) fail('PROCESSING_GUIDANCE_INVALID');
  const bytes = await readBoundedBytes(file, { maxBytes: GUIDE_LIMIT, noFollow: true });
  return { guide, source: relative, content: bytes.toString('utf8'), bytes: bytes.length, hash: digest(bytes),
    recordingContext: await recordingContext() };
}

/** This is an engine adapter, not a native-session credential. Only a controller
 * that has separately verified its host identity may hand these tools to an agent.
 * The agent never receives collection/configuration setters or approval authority.
 */
export async function createProcessingEngineTools(context, { runBudget = null } = {}) {
  keys(context, ['configPath', 'collectionId', 'expectedConfigHash', 'selection'], ['worksetId', 'resumeOperationId']);
  if (context.worksetId !== undefined) nativeId(context.worksetId);
  if (context.resumeOperationId !== undefined) nativeId(context.resumeOperationId);
  if (context.worksetId !== undefined && context.resumeOperationId !== undefined) fail('PROCESSING_SELECTION_CHANGED');
  if (typeof context.configPath !== 'string' || !path.isAbsolute(context.configPath)) fail('ABSOLUTE_PATH_REQUIRED');
  const bound = structuredClone(context);
  bound.selection = await normalizeWorkflowSelection(bound.selection);
  const selection = Object.freeze(bound.selection);
  const options = Object.freeze({ configPath: bound.configPath, collectionId: bound.collectionId, expectedConfigHash: bound.expectedConfigHash });
  let notesIdentity;
  const startedAt = performance.now(), admitted = new Map(), inputSizes = new Map();
  if (runBudget !== null) {
    keys(runBudget, ['maxOperations', 'maxPacketBytes', 'maxElapsedMs']);
    for (const value of Object.values(runBudget)) { integer(value); if (value < 1) fail('INVALID_PROCESSING_BUDGET'); }
    runBudget = Object.freeze({ ...runBudget });
  }
  const remainingRunBytes = () => runBudget === null ? 4 * 1024 * 1024
    : Math.max(0, runBudget.maxPacketBytes - [...admitted.values()].reduce((sum, bytes) => sum + bytes, 0));
  const runStopped = () => runBudget !== null && (admitted.size >= runBudget.maxOperations ||
    remainingRunBytes() === 0 || performance.now() - startedAt >= runBudget.maxElapsedMs);
  function nextIndexes(workset, limit) {
    const indexes = [], maxBytes = Math.min(workset.remainingPacketBytes, remainingRunBytes());
    let bytes = 0;
    for (const item of workset.items.filter(item => item.state === 'unattempted').slice(0, limit)) {
      const size = inputSizes.get(item.index);
      if (size !== undefined && bytes + size > maxBytes) break;
      indexes.push(item.index); bytes += size ?? 0;
    }
    return indexes;
  }

  async function authorized() {
    const capability = await verifyWorkflowStorage(options);
    const collection = await assertWorkflowStorage(capability, selection, 'explicitProcess');
    if (notesIdentity !== undefined) {
      const root = collection.notes.notesDir ?? path.dirname(collection.notes.destination);
      if ((await inspectDirectories(root, ['.cuefluent-list.md'])).directories.find(item => item.path === '.').identity !== notesIdentity) fail('PROCESSING_NOTES_ROOT_CHANGED');
    }
    return { capability, collection };
  }
  function checkedPath(notes, relative) {
    string(relative, 4096); outputPath(relative);
    const root = notes.notesDir ?? path.dirname(notes.destination);
    if (notes.destination && path.join(root, relative) !== notes.destination) fail('PROCESSING_DESTINATION_MISMATCH');
    return { root, target: path.join(root, relative) };
  }
  async function noteParents(collection, relative) {
    const { root } = checkedPath(collection.notes, relative), parts = relative.split('/');
    const simple = parts.length === 1 || (parts.length === 2 && isNoteCategory(parts[0]));
    const inspected = await (simple ? inspectDirectories : inspectExistingDirectories)(root, [relative]);
    if (notesIdentity !== undefined && inspected.directories.find(item => item.path === '.').identity !== notesIdentity) fail('PROCESSING_NOTES_ROOT_CHANGED');
    return inspected;
  }
  async function readNote(capability, collection, args) {
    const { target } = checkedPath(collection.notes, args.path);
    const before = await noteParents(collection, args.path);
    const opened = await openGuarded(target, { maxBytes: NOTE_LIMIT, singleLink: true, missing: true });
    let bytes = null;
    if (opened) {
      try {
        bytes = Buffer.alloc(Number(opened.stat.size));
        let offset = 0;
        while (offset < bytes.length) {
          const part = await opened.handle.read(bytes, offset, bytes.length - offset, offset);
          if (!part.bytesRead) fail('PROCESSING_NOTE_CHANGED');
          offset += part.bytesRead;
        }
        const after = await opened.handle.stat({ bigint: true }), current = await fs.lstat(target, { bigint: true });
        if ([after, current].some(stat => !sameFileIdentity(opened.stat, stat) || stat.size !== opened.stat.size ||
          stat.mtimeNs !== opened.stat.mtimeNs || stat.ctimeNs !== opened.stat.ctimeNs || stat.nlink !== 1n)) fail('PROCESSING_NOTE_CHANGED');
      } finally { await opened.handle.close(); }
    }
    if (!equal(before, await noteParents(collection, args.path))) fail('PROCESSING_NOTES_ROOT_CHANGED');
    await assertWorkflowStorage(capability, selection, 'explicitProcess');
    return { path: args.path, hash: bytes === null ? null : digest(bytes), bytes: bytes?.length ?? 0,
      content: bytes === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  }
  async function listNotes(capability, collection, args) {
    const directory = args.directory ?? '', limit = args.limit ?? 100, afterPath = args.afterPath ?? null;
    string(directory, 4096, { empty: true }); integer(limit);
    if (limit < 1 || limit > 100) fail('PROCESSING_NOTE_LIST_LIMIT');
    if (afterPath !== null) string(afterPath, 4096);
    if (collection.notes.destination) {
      if (directory) fail('PROCESSING_DESTINATION_MISMATCH');
      const name = path.basename(collection.notes.destination);
      const note = await readNote(capability, collection, { path: name });
      return { entries: note.hash === null || (afterPath !== null && name <= afterPath) ? [] : [{ path: name, kind: 'note' }], incomplete: false, nextCursor: null };
    }
    const probe = directory ? `${directory}/.cuefluent-list.md` : '.cuefluent-list.md';
    outputPath(probe);
    const before = await noteParents(collection, probe), root = before.root;
    if (before.createDirectories.length) {
      await assertWorkflowStorage(capability, selection, 'explicitProcess');
      return { entries: [], incomplete: false, nextCursor: null };
    }
    const entries = []; let scanned = 0;
    for await (const entry of await fs.opendir(path.join(root, directory))) {
      checkWorkflowBudget();
      if (++scanned > 4096) fail('PROCESSING_NOTE_LIST_CAPACITY');
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (afterPath !== null && name <= afterPath) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        try { outputPath(`${name}/.cuefluent-list.md`); } catch { continue; }
        entries.push({ path: name, kind: 'directory' });
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        try { outputPath(name); } catch { continue; }
        entries.push({ path: name, kind: 'note' });
      }
      entries.sort((a, b) => compare(a.path, b.path));
      if (entries.length > limit + 1) entries.pop();
    }
    if (!equal(before, await noteParents(collection, probe))) fail('PROCESSING_NOTES_ROOT_CHANGED');
    await assertWorkflowStorage(capability, selection, 'explicitProcess');
    const incomplete = entries.length > limit;
    if (incomplete) entries.pop();
    return { entries, incomplete, nextCursor: incomplete ? entries.at(-1).path : null };
  }
  async function inlineProposal(capability, collection, args, operationSelection = selection) {
    nativeId(args.operationId); hash(args.expectedClaimHash);
    if (args.proposal === undefined) return proposeProcessing(capability, { ...args, selection: operationSelection });
    keys(args.proposal, ['files', 'mappings']); list(args.proposal.files, 100, { empty: false });
    let total = 0;
    const files = args.proposal.files.map((file, index) => {
      keys(file, ['path', 'expectedHash', 'content']); checkedPath(collection.notes, file.path);
      if (file.expectedHash !== null) hash(file.expectedHash);
      string(file.content, DRAFT_LIMIT, { empty: true });
      const bytes = Buffer.from(file.content);
      total += bytes.length; if (total > DRAFT_LIMIT) fail('PROCESSING_PROPOSAL_CAPACITY');
      return { path: file.path, expectedHash: file.expectedHash, bytes, expectedContentHash: digest(bytes),
        stage: `processing-stages/adapter-${args.operationId}-${index}.md` };
    });
    // The same guarded writer state owns temporary draft bytes and the durable
    // proposal. Fixed per-operation slots bound interrupted staging and preserve
    // any immutable proposal intent's exact content on retry.
    await withProcessingState(capability, operationSelection, 'explicitProcess', async ctx => {
      const snapshot = await processingSnapshot(ctx, claimPath(args.operationId));
      if (snapshot.hash !== args.expectedClaimHash) fail('PROCESSING_CLAIM_CHANGED');
      const claim = validateClaim(intakeJSON(snapshot));
      if (!equal(claim.selection, operationSelection) || claim.bindingHash !== ctx.bindingHash ||
        (!bound.worksetId && !bound.resumeOperationId && claim.inputs.some(input => !selectionIncludesIdentity(selection, input.identity)))) fail('PROCESSING_SELECTION_CHANGED');
      validateMappings(args.proposal.mappings, claim.inputs, files);
      if (claim.acknowledged.length !== claim.packet.pages.length) fail('PROCESSING_INSPECTION_INCOMPLETE');
      if (claim.proposalIntent && (claim.proposalIntent.value.copies.length !== files.length || files.some((file, index) =>
        claim.proposalIntent.value.copies[index].hash !== file.expectedContentHash))) fail('PROCESSING_PROPOSAL_CHANGED');
      for (const file of files) {
        const old = await processingSnapshot(ctx, file.stage);
        if (old.hash !== file.expectedContentHash) await writeProcessingBytes(ctx, file.stage, file.bytes, old.hash);
      }
    });
    const request = { files: files.map(file => ({ path: file.path, expectedHash: file.expectedHash,
      contentPath: path.join(collection.notes.writerStateDir, file.stage), expectedContentHash: file.expectedContentHash })), mappings: args.proposal.mappings };
    const result = await proposeProcessing(capability, { selection: operationSelection, operationId: args.operationId, expectedClaimHash: args.expectedClaimHash, proposal: request });
    try {
      await withProcessingState(capability, operationSelection, 'explicitProcess', async ctx => {
        for (const file of files) await removeProcessingJSON(ctx, file.stage, file.expectedContentHash);
      });
    } catch {
      // Publication already succeeded. Inert draft cleanup cannot turn it into a
      // failed proposal or discard another call's replacement bytes.
      result.cleanupWarnings = ['Inline draft cleanup could not be verified; retained staging is inert.'];
    }
    return result;
  }
  async function boundWorkset(capability) {
    const workset = await inspectProcessingWorkset(capability, { worksetId: bound.worksetId });
    if (workset.policyState !== 'current') fail('WORKFLOW_POLICY_CHANGED');
    await assertWorkflowStorage(capability, workset.selection, 'explicitProcess');
    return workset;
  }
  async function compatible(operation, capability) {
    if (bound.worksetId) {
      const workset = await boundWorkset(capability);
      // The workset inspector verifies exact admission hashes, packet and inputs.
      return workset.operations.some(item => item.operationId === operation.operationId && !item.admissionPending);
    }
    if (bound.resumeOperationId) return operation.operationId === bound.resumeOperationId && operation.selection !== null;

    const old = operation.selection;
    return old && old.client === selection.client && old.sessionId === selection.sessionId && old.cwd === selection.cwd &&
      (selection.unitId === null || old.unitId === selection.unitId) &&
      operation.inputs.every(input => selectionIncludesIdentity(selection, input.identity));
  }
  await withStorageProbes(async () => {
    const { collection } = await authorized();
    const root = collection.notes.notesDir ?? path.dirname(collection.notes.destination);
    notesIdentity = (await inspectDirectories(root, ['.cuefluent-list.md'])).directories.find(item => item.path === '.').identity;
  });

  return Object.freeze({
    interfaceVersion: PROCESSING_INTERFACE_VERSION,
    toolNames: Object.freeze(Object.keys(schemas)),
    async call(name, input = {}) {
      if (!Object.hasOwn(schemas, name)) fail('PROCESSING_TOOL_NOT_ALLOWED');
      const args = structuredClone(input), schema = schemas[name];
      keys(args, schema.required, schema.optional ?? []);
      return withStorageProbes(async () => {
        const { capability, collection } = await authorized();
        if (name === 'guidance_read') {
          const result = await readGuidance(args.guide);
          await assertWorkflowStorage(capability, selection, 'explicitProcess');
          return result;
        }
        if (name === 'note_read') return readNote(capability, collection, args);
        if (name === 'note_list') return listNotes(capability, collection, args);
        if (name === 'prepare_note') {
          const { now, skillVersion } = await recordingContext();
          await assertWorkflowStorage(capability, selection, 'explicitProcess');
          return prepareNote({ ...args, now, skillVersion });
        }
        if (name === 'processing_pending') {
          if (args.limit !== undefined) { integer(args.limit); if (args.limit < 1 || args.limit > 100) fail('INVALID_PENDING_LIMIT'); }
          if (args.afterUnitId !== undefined) nativeId(args.afterUnitId);
        }
        if (name === 'processing_pending' && bound.worksetId) {
          if (args.afterUnitId !== undefined) fail('PROCESSING_WORKSET_CURSOR_UNSUPPORTED');
          const workset = await boundWorkset(capability);
          const remaining = workset.items.filter(item => item.state === 'unattempted');
          const indexes = nextIndexes(workset, Math.min(args.limit ?? 5, 5));
          const unfinished = workset.operations.filter(item => !item.outcome || item.recoveryRequired);
          const retry = unfinished.length === 1 && unfinished[0].admissionPending && !unfinished[0].conflict
            ? unfinished[0] : null;
          const firstBytes = inputSizes.get(remaining[0]?.index);
          const runBytesStop = !indexes.length && firstBytes <= workset.remainingPacketBytes && firstBytes > remainingRunBytes();
          return { interfaceVersion: PROCESSING_INTERFACE_VERSION, workset,
            pending: remaining.map(item => workset.inputs[item.index]), operations: unfinished.map(item => ({ ...item, resumeSupported: true })),
            reason: !unfinished.length && (runStopped() || runBytesStop) ? 'run-budget' : !unfinished.length && remaining.length && !indexes.length ? 'input-budget' : null,
            nextPreparation: retry ? { operationId: retry.operationId, inputs: retry.indexes.map(index => workset.inputs[index]) }
              : !unfinished.length && !runStopped() && !workset.budgetExhausted && indexes.length
                ? { operationId: worksetOperationId(bound.worksetId, indexes), inputs: indexes.map(index => workset.inputs[index]) } : null };
        }
        if (name === 'processing_pending' && bound.resumeOperationId) {
          const operation = await inspectProcessing(capability, bound.resumeOperationId);
          if (operation.selection === null) fail('PROCESSING_CLAIM_MISSING');
          await assertWorkflowStorage(capability, operation.selection, 'explicitProcess');
          return { interfaceVersion: PROCESSING_INTERFACE_VERSION, pending: [],
            operations: operation.outcome && !operation.recoveryRequired ? [] : [{ ...operation, resumeSupported: true }], nextPreparation: null };
        }
        if (name === 'processing_pending') {
          const result = await pendingProcessing(capability, { ...args, selection });
          return { ...result, operations: await Promise.all(result.operations.map(async operation => await compatible(operation, capability)
            ? { ...operation, resumeSupported: true }
            : { operationId: operation.operationId, state: operation.state, resumeSupported: false,
              diagnostic: 'PROCESSING_SELECTION_CHANGED', nextAction: 'inspect-with-original-selection' })) };
        }
        let operationSelection = selection;
        if (args.operationId && name !== 'processing_prepare') {
          const result = await inspectProcessing(capability, args.operationId);
          if (result.state === 'missing' && name === 'processing_status') return result;
          if (!await compatible(result, capability)) fail('PROCESSING_SELECTION_CHANGED');
          operationSelection = result.selection;
          // Count resumed operations once as well as new admissions. Finishing
          // an already claimed operation remains possible after the run cutoff.
          if (bound.worksetId && !result.outcome && !admitted.has(args.operationId)) admitted.set(args.operationId, result.claim?.packet.bytes ?? 0);
          if (name === 'processing_status') return result;
          if (name === 'processing_complete' && result.proposalHash !== null) fail('PROCESSING_REVIEW_REQUIRED');
        }
        if (name === 'processing_prepare') {
          list(args.inputs, 20, { empty: false });
          if (bound.resumeOperationId) fail('PROCESSING_RESUME_REQUIRED');
          if (bound.worksetId) {
            const workset = await boundWorkset(capability);
            const indexes = args.inputs.map(input => {
              const index = workset.inputs.findIndex(candidate => equal(candidate, input));
              if (index < 0) fail('PROCESSING_SELECTION_CHANGED');
              return index;
            }).sort((a, b) => a - b);
            if (args.operationId !== worksetOperationId(bound.worksetId, indexes)) fail('PROCESSING_OPERATION_CONFLICT');
            const attempt = workset.operations.find(item => item.operationId === args.operationId);
            if (!attempt && workset.operations.some(item => !item.outcome || item.recoveryRequired)) fail('PROCESSING_RESUME_REQUIRED');
            if (!attempt && runStopped()) fail('PROCESSING_RUN_BUDGET');
            if (!attempt && workset.budgetExhausted) fail('PROCESSING_WORKSET_BUDGET');
            try {
              const result = await prepareWorksetBatch(capability, { worksetId: bound.worksetId, expectedWorksetHash: workset.worksetHash, indexes,
                // An existing admission retains its exact charged cost on retry.
                ...(!attempt ? { batchBudget: { maxInputs: 5, maxPacketBytes: Math.min(4 * 1024 * 1024, workset.remainingPacketBytes, remainingRunBytes()) } } : {}) });
              admitted.set(args.operationId, result.packet.bytes);
              return result;
            } catch (error) {
              // No admission was written on this refusal. Retain measured
              // per-input costs so the next pending call offers a fitting prefix.
              // A single-input packet includes framing, making the sum conservative.
              if (!attempt && error.code === 'PROCESSING_BATCH_BUDGET' && error.details?.inputSizes) {
                for (const item of error.details.inputSizes) inputSizes.set(item.index, item.packetBytes);
              }
              throw error;
            }
          }
          if (args.inputs.some(input => !selectionIncludesIdentity(selection, input.identity))) fail('PROCESSING_SELECTION_CHANGED');
          return prepareProcessing(capability, { ...args, selection });
        }
        if (name === 'processing_page') return readProcessingPage(capability, { ...args, selection: operationSelection });
        if (name === 'processing_ack') return acknowledgeProcessingPages(capability, { ...args, selection: operationSelection });
        if (name === 'processing_propose') return inlineProposal(capability, collection, args, operationSelection);
        if (name === 'processing_complete') return completeProcessing(capability, { ...args, selection: operationSelection, outcome: 'unchanged' });
        fail('PROCESSING_TOOL_NOT_ALLOWED');
      });
    },
  });
}
