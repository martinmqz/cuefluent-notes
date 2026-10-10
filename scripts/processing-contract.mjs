import path from 'node:path';
import { logicalCaptureIdentity } from './capture-contract.mjs';
import { validatePacketManifest } from './processing-packet.mjs';
import { keys, hash, nativeId, timestamp, list, integer, unique, choice, canonicalJSON, digest, fail } from './workflow-values.mjs';

export const claimPath = id => `claims/${nativeId(id)}.json`;
export const proposalPath = id => `proposals/${nativeId(id)}/record.json`;
export const transactionPath = id => `transactions/${nativeId(id)}.json`;
export const operationPath = id => `processed/operations/${nativeId(id)}.json`;
// Public read-model version; independent of persisted claim/capture schemas.
export const PROCESSING_INTERFACE_VERSION = 1;
export function inspectionProgress(claim) {
  const totalPages = claim.packet.pages.length;
  const embeddedCaptureBytes = claim.packet.captureBytes.reduce((sum, bytes) => sum + bytes, 0);
  const acknowledged = new Set(claim.acknowledged);
  const nextPage = claim.packet.pages.findIndex((_, index) => !acknowledged.has(index));
  return { state: nextPage === -1 ? 'inspected' : acknowledged.size ? 'inspecting' : 'unread',
    totalPages, issuedPages: claim.issued.length, acknowledgedPages: acknowledged.size,
    nextPage: nextPage === -1 ? null : nextPage, packetBytes: claim.packet.bytes,
    sourceCompleteness: 'unknown',
    projection: { rules: 'full-capture-v1', exclusions: 'disabled-unverified',
      capturedFileBytes: embeddedCaptureBytes + claim.packet.captureBytes.length,
      embeddedCaptureBytes, provenCopyExcludedBytes: 0, collectionAvoidedBytes: null,
      packetBytes: claim.packet.bytes } };
}
export const associationPath = (identity, bindingHash) => {
  hash(bindingHash); const i = logicalCaptureIdentity(identity);
  return `processed/associations/${bindingHash.slice(0, 20)}/${i.client}/${i.sessionId}/${i.unitId}.json`;
};
export function validateProcessingSelection(value) {
  keys(value, ['client', 'sessionId', 'cwd', 'unitId']);
  choice(value.client, ['codex', 'claude']); nativeId(value.sessionId);
  if (value.unitId !== null) nativeId(value.unitId);
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) fail('INVALID_PROCESSING_SELECTION');
  return value;
}
export function validateProcessingInput(value) {
  keys(value, ['identity', 'projectRoot', 'headHash', 'evidenceHash', 'fileHash', 'associationHash', 'dispositionHash']);
  logicalCaptureIdentity(value.identity);
  for (const name of ['headHash', 'evidenceHash', 'fileHash']) hash(value[name]);
  for (const name of ['associationHash', 'dispositionHash']) if (value[name] !== null) hash(value[name]);
  if (typeof value.projectRoot !== 'string' || !path.isAbsolute(value.projectRoot)) fail('INVALID_PROCESSING_INPUT');
  return value;
}
export function validateClaim(value) {
  keys(value, ['format', 'version', 'operationId', 'bindingHash', 'binding', 'selection', 'policyHash', 'createdAt', 'inputs', 'inputsHash', 'packet', 'issued', 'acknowledged', 'proposalIntent']);
  if (value.format !== 'cuefluent-processing-claim' || value.version !== 1) fail('INVALID_PROCESSING_CLAIM');
  nativeId(value.operationId); hash(value.bindingHash); hash(value.policyHash); timestamp(value.createdAt); validateProcessingSelection(value.selection);
  if (digest(canonicalJSON(value.binding)) !== value.bindingHash) fail('INVALID_PROCESSING_BINDING');
  list(value.inputs, 20, { empty: false }).forEach(validateProcessingInput);
  unique(value.inputs.map(input => canonicalJSON(input.identity)));
  if (digest(canonicalJSON(value.inputs)) !== value.inputsHash) fail('INVALID_PROCESSING_INPUTS');
  validatePacketManifest(value.packet, value.inputs);
  for (const field of ['issued', 'acknowledged']) {
    list(value[field], value.packet.pages.length).forEach(page => { integer(page); if (page >= value.packet.pages.length) fail('INVALID_PROCESSING_PAGE'); });
    unique(value[field]);
  }
  if (value.acknowledged.some(page => !value.issued.includes(page))) fail('UNISSUED_PROCESSING_PAGE');
  if (value.proposalIntent !== null) {
    keys(value.proposalIntent, ['hash', 'value']);
    if (digest(canonicalJSON(value.proposalIntent.value)) !== value.proposalIntent.hash) fail('PROCESSING_PROPOSAL_CHANGED');
  }
  return value;
}
export function validateAssociation(value, identity, bindingHash) {
  keys(value, ['format', 'version', 'bindingHash', 'identity', 'headHash', 'operationId', 'outputs']);
  if (value.format !== 'cuefluent-note-association' || value.version !== 1 || value.bindingHash !== bindingHash ||
      canonicalJSON(value.identity) !== canonicalJSON(identity)) fail('INVALID_NOTE_ASSOCIATION');
  hash(value.headHash); nativeId(value.operationId);
  list(value.outputs, 100).forEach(output => {
    keys(output, ['path', 'hash']); hash(output.hash);
    if (typeof output.path !== 'string' || !output.path || path.isAbsolute(output.path) || output.path.includes('\\') || output.path.split('/').some(p => ['', '.', '..'].includes(p))) fail('INVALID_NOTE_ASSOCIATION');
  });
  unique(value.outputs.map(output => output.path)); return value;
}
export function operationContext(claim) {
  return { operationId: claim.operationId, role: 'processing', selection: claim.selection, authoritative: false,
    generatedOutputAttribution: 'unverified',
    limit: 'Native processing-turn exclusion and mixed-turn record tagging require a verified native binding; this descriptor supplies neither.' };
}
