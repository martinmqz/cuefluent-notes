import { inspectNoteMetadata, registerNoteIdentity } from './note-metadata.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureRelativePath, logicalCaptureIdentity } from './capture-contract.mjs';
import { unitKey } from './capture-retention.mjs';
import { inspectDirectories, inspectExistingDirectories, readRetainedOutputs } from './safe-update.mjs';
import { isNoteCategory } from './note-organization.mjs';
import { readBoundedBytes, windowsComponent } from './file-io.mjs';
import { inspectMarkdown } from './check-notes.mjs';
import { assertInspectedNoteTransition, assertProcessingNoteSources } from './note-generation.mjs';
import { processingSnapshot, writeProcessingBytes } from './processing-state.mjs';
import { intakeJSON } from './intake-io.mjs';
import { canonicalJSON, digest, fail, keys, list, hash, choice, unique } from './workflow-values.mjs';

const LIMIT = 900 * 1024;
export function outputPath(value) {
  if (typeof value !== 'string' || !/\.(md|markdown)$/i.test(value) || path.isAbsolute(value) ||
      value.includes('\\') || value.split('/').some(p => !windowsComponent(p) || p === '.' || p === '..')) fail('INVALID_PROCESSING_OUTPUT');
  return value;
}
export function validateMappings(mappings, inputs, files) {
  list(mappings, inputs.length, { empty: false });
  if (mappings.length !== inputs.length) fail('PROCESSING_ASSOCIATIONS_INCOMPLETE');
  unique(mappings.map(item => unitKey(item.identity)));
  for (const item of mappings) {
    keys(item, ['identity', 'paths']); logicalCaptureIdentity(item.identity);
    if (!inputs.some(input => unitKey(input.identity) === unitKey(item.identity))) fail('INVALID_PROCESSING_ASSOCIATION');
    list(item.paths, files.length, { empty: false }).forEach(outputPath); unique(item.paths);
    if (item.paths.some(name => !files.some(file => file.path === name))) fail('INVALID_PROCESSING_ASSOCIATION');
  }
  if (files.some(file => !mappings.some(item => item.paths.includes(file.path)))) fail('PROCESSING_ASSOCIATIONS_INCOMPLETE');
  return mappings;
}

/** Caller-inspected hashes never get refreshed here. Root/category identity is
 * added to the proposal that will subsequently be reviewed and approved. */
export async function buildProcessingProposal(ctx, claim, request) {
  keys(request, ['files', 'mappings'], ['mode', 'expectedManifestHash']);
  const mode = choice(request.mode ?? 'authored', ['authored', 'derived']);
  list(request.files, 100, { empty: false });
  const notes = ctx.collection.notes, root = notes.notesDir ?? path.dirname(notes.destination);
  const rootReal = await fs.realpath(root);
  if (rootReal !== root) fail('PROCESSING_NOTES_ROOT_CHANGED');
  unique(request.files.map(file => outputPath(file.path).normalize('NFC').toLowerCase()));
  validateMappings(request.mappings, claim.inputs, request.files);
  const copies = [], files = [], noteIdentities = new Set(); let total = 0;
  for (const [index, file] of request.files.entries()) {
    keys(file, ['path', 'expectedHash', 'contentPath', 'expectedContentHash']); outputPath(file.path);
    if (file.expectedHash !== null) hash(file.expectedHash); hash(file.expectedContentHash);
    if (typeof file.contentPath !== 'string' || !path.isAbsolute(file.contentPath)) fail('INVALID_PROCESSING_PROPOSAL');
    if (notes.destination && path.join(root, file.path) !== notes.destination) fail('PROCESSING_DESTINATION_MISMATCH');
    if (notes.organization === 'flat' && file.path.includes('/')) fail('PROCESSING_DESTINATION_MISMATCH');
    // No proposal/target alias, including symlink spellings and another output.
    const contentPath = await fs.realpath(file.contentPath);
    if (request.files.some(other => path.join(root, other.path) === contentPath)) fail('PROCESSING_PROPOSAL_OVERLAP');
    const bytes = await readBoundedBytes(file.contentPath, { maxBytes: LIMIT, noFollow: true });
    if (digest(bytes) !== file.expectedContentHash) fail('PROCESSING_PROPOSAL_CHANGED');
    total += bytes.length; if (total > LIMIT) fail('PROCESSING_PROPOSAL_CAPACITY');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const checked = inspectMarkdown(content, file.path);
    if (checked.diagnostics.some(item => item.severity === 'error')) fail('INVALID_PROCESSING_MARKDOWN');
    registerNoteIdentity(checked.metadata, noteIdentities);
    const currentBytes = await readBoundedBytes(path.join(root, file.path), { maxBytes: 2 * 1024 * 1024, missing: true, noFollow: true });
    if ((currentBytes === null ? null : digest(currentBytes)) !== file.expectedHash) fail('PROCESSING_OUTPUT_CHANGED');
    const current = currentBytes === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(currentBytes);
    const currentMetadata = current === null ? null : inspectNoteMetadata(current, file.path);
    if (currentMetadata?.status === 'invalid') {
      fail('INVALID_EXISTING_NOTE_METADATA');
    }
    assertInspectedNoteTransition(currentMetadata, checked.metadata);
    const mapped = claim.inputs.filter(input => request.mappings.some(item => unitKey(item.identity) === unitKey(input.identity) && item.paths.includes(file.path)));
    assertProcessingNoteSources(currentMetadata, checked.metadata, mapped);
    const ownedPath = `proposals/${claim.operationId}/${index}.md`;
    copies.push({ path: ownedPath, source: file.contentPath, hash: file.expectedContentHash });
    const sources = mapped.map(input => ({ path: path.join(ctx.collection.rawDir, captureRelativePath(input.identity, input.evidenceHash)), expectedHash: input.fileHash }));
    files.push({ path: file.path, expectedHash: file.expectedHash, contentPath: path.join(ctx.collection.notes.writerStateDir, ownedPath), expectedContentHash: file.expectedContentHash, sources });
  }
  const categoryPaths = files.every(file => { const parts = file.path.split('/'); return parts.length === 1 || (parts.length === 2 && isNoteCategory(parts[0])); });
  const categoryPlan = mode === 'authored' && categoryPaths && !notes.destination;
  const inspected = await (categoryPlan ? inspectDirectories : inspectExistingDirectories)(root, files.map(file => file.path));
  const plan = { version: categoryPlan ? 2 : 1, mode, root, stateDir: ctx.collection.notes.writerStateDir, files,
    ...(categoryPlan ? { directories: inspected.directories, createDirectories: inspected.createDirectories } : {}),
    ...(mode === 'derived' ? { expectedManifestHash: request.expectedManifestHash } : {}) };
  if (mode === 'derived') {
    if (request.expectedManifestHash !== null) hash(request.expectedManifestHash);
    const snapshot = await processingSnapshot(ctx, 'manifest.json');
    if (snapshot.hash !== request.expectedManifestHash) fail('PROCESSING_MANIFEST_CHANGED');
    for await (const { target, bytes } of readRetainedOutputs(plan, intakeJSON(snapshot))) {
      const metadata = inspectNoteMetadata(new TextDecoder('utf-8', { fatal: true }).decode(bytes), target);
      if (metadata.status === 'invalid') fail('INVALID_EXISTING_NOTE_METADATA');
      registerNoteIdentity(metadata, noteIdentities);
    }
  } else if (request.expectedManifestHash !== undefined) fail('INVALID_PROCESSING_PROPOSAL');
  return { format: 'cuefluent-processing-proposal', version: 1, operationId: claim.operationId, bindingHash: ctx.bindingHash,
    inputsHash: claim.inputsHash, plan, mappings: structuredClone(request.mappings), copies, directories: inspected.directories };
}

export function validateProcessingProposal(value, claim) {
  keys(value, ['format', 'version', 'operationId', 'bindingHash', 'inputsHash', 'plan', 'mappings', 'copies', 'directories']);
  if (value.format !== 'cuefluent-processing-proposal' || value.version !== 1 || value.operationId !== claim.operationId ||
      value.bindingHash !== claim.bindingHash || value.inputsHash !== claim.inputsHash) fail('PROCESSING_PROPOSAL_CHANGED');
  const notes = claim.binding.notes, root = notes.notesDir ?? path.dirname(notes.destination), plan = value.plan;
  if (plan.root !== root || plan.stateDir !== notes.writerStateDir || ![1, 2].includes(plan.version) || !['authored', 'derived'].includes(plan.mode)) fail('PROCESSING_PROPOSAL_CHANGED');
  list(plan.files, 100, { empty: false }); list(value.copies, plan.files.length, { empty: false });
  if (value.copies.length !== plan.files.length) fail('PROCESSING_PROPOSAL_CHANGED');
  validateMappings(value.mappings, claim.inputs, plan.files);
  for (const [index, file] of plan.files.entries()) {
    outputPath(file.path); hash(file.expectedContentHash); if (file.expectedHash !== null) hash(file.expectedHash);
    const copy = value.copies[index]; keys(copy, ['path', 'source', 'hash']);
    if (copy.path !== `proposals/${claim.operationId}/${index}.md` || copy.hash !== file.expectedContentHash || file.contentPath !== path.join(notes.writerStateDir, copy.path)) fail('PROCESSING_PROPOSAL_CHANGED');
  }
  return value;
}

export async function copyProcessingProposal(ctx, proposal) {
  for (const copy of proposal.copies) {
    const existing = await processingSnapshot(ctx, copy.path);
    if (existing.hash === copy.hash) continue;
    if (existing.hash !== null) fail('PROCESSING_PROPOSAL_CHANGED');
    const bytes = await readBoundedBytes(copy.source, { noFollow: true, maxBytes: LIMIT });
    if (digest(bytes) !== copy.hash) fail('PROCESSING_PROPOSAL_CHANGED');
    await writeProcessingBytes(ctx, copy.path, bytes, null);
  }
}
export async function verifyProcessingProposal(ctx, proposal) {
  for (const copy of proposal.copies) if ((await processingSnapshot(ctx, copy.path)).hash !== copy.hash) fail('PROCESSING_PROPOSAL_CHANGED');
}

export async function verifyExistingProposalParents(proposal) {
  if (proposal.plan.version === 1 && canonicalJSON((await inspectExistingDirectories(proposal.plan.root, proposal.plan.files.map(file => file.path))).directories) !== canonicalJSON(proposal.directories)) fail('PROCESSING_NOTES_ROOT_CHANGED');
}

export const proposalHash = value => digest(canonicalJSON(value));
