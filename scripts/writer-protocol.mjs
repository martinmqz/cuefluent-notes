import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstatOrNull, readBoundedBytes, sameFileIdentity, syncDirectory } from './file-io.mjs';
import { keys, nativeId, hash, timestamp, canonicalJSON, digest, fail, list } from './workflow-values.mjs';

const LIMIT = 2 * 1024 * 1024;
export const PROCESSING_REINSPECTION_FILE = 'reinspection.json';
export const hasProcessingReinspection = async stateDir => Boolean(await lstatOrNull(path.join(stateDir, PROCESSING_REINSPECTION_FILE)));
export async function assertNoProcessingReinspection(stateDir) {
  if (await hasProcessingReinspection(stateDir)) fail('PROCESSING_REINSPECTION_REQUIRED');
}
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
export function validateWriterBinding(value) {
  keys(value, ['operationId', 'proposalHash', 'inputsHash', 'collectionHash', 'root', 'stateDir']);
  nativeId(value.operationId);
  for (const field of ['proposalHash', 'inputsHash', 'collectionHash']) hash(value[field]);
  for (const field of ['root', 'stateDir']) if (typeof value[field] !== 'string' || !path.isAbsolute(value[field])) fail('INVALID_WRITER_BINDING');
  return value;
}
export function validateWriterCoordination(value) {
  keys(value, ['binding', 'transactionHash']); validateWriterBinding(value.binding); hash(value.transactionHash); return value;
}
async function directory(root, name, { create = false } = {}, guard = async () => {}) {
  let current = root;
  for (const part of name.split('/')) {
    await guard(); current = path.join(current, part);
    let stat = await lstatOrNull(current);
    if (!stat && create) { try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } stat = await fs.lstat(current); }
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) fail('UNSAFE_PROCESSING_STATE');
  }
  return current;
}
async function readJSON(file) {
  const before = await lstatOrNull(file, { bigint: true });
  if (!before) return null;
  if (!before.isFile() || before.nlink !== 1n) fail('UNSAFE_WRITER_METADATA');
  const bytes = await readBoundedBytes(file, { maxBytes: LIMIT, missing: true, noFollow: true });
  const after = await lstatOrNull(file, { bigint: true });
  if (bytes === null || !sameFileIdentity(before, after) || after.nlink !== 1n) fail('WRITER_METADATA_CHANGED');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_WRITER_METADATA');
  return { value, hash: digest(bytes) };
}

/** A pending processing transaction reserves the entire writer until reconciled. */
export async function assertWriterAccess(stateDir, coordination = null) {
  await assertNoProcessingReinspection(stateDir);
  if (coordination) { validateWriterCoordination(coordination); if (coordination.binding.stateDir !== stateDir) fail('WRITER_BINDING_MISMATCH'); }
  const transactions = await directory(stateDir, 'transactions');
  const names = [];
  if (transactions) for await (const entry of await fs.opendir(transactions)) {
    names.push(entry.name); if (names.length > 1) fail('PROCESSING_RECOVERY_REQUIRED');
  }
  if (names.length > 1 || (names.length && (!coordination || names[0] !== `${coordination.binding.operationId}.json`))) fail('PROCESSING_RECOVERY_REQUIRED');
  let transaction = null;
  if (coordination) {
    if (names.length !== 1) fail('PROCESSING_TRANSACTION_MISSING');
    const record = await readJSON(path.join(transactions, names[0]));
    if (record?.hash !== coordination.transactionHash || !equal(record.value.writerBinding, coordination.binding)) fail('PROCESSING_TRANSACTION_CHANGED');
    transaction = record.value;
  }
  const journal = await readJSON(path.join(stateDir, 'journal.json'));
  if (journal?.value.processing && (!coordination || !equal(journal.value.processing, coordination))) fail('PROCESSING_RECOVERY_REQUIRED');
  return transaction;
}

export function validateWriterReceipt(value) {
  keys(value, ['format', 'version', 'coordination', 'outputs', 'manifestHash', 'committedAt']);
  if (value.format !== 'cuefluent-writer-receipt' || value.version !== 1) fail('INVALID_WRITER_RECEIPT');
  validateWriterCoordination(value.coordination); timestamp(value.committedAt);
  list(value.outputs, 100, { empty: false });
  const seen = new Set();
  for (const output of value.outputs) {
    keys(output, ['path', 'hash']); hash(output.hash);
    if (typeof output.path !== 'string' || !output.path || path.isAbsolute(output.path) || output.path.includes('\\') || output.path.split('/').some(p => ['.', '..', ''].includes(p)) || seen.has(output.path)) fail('INVALID_WRITER_RECEIPT');
    seen.add(output.path);
  }
  if (value.manifestHash !== null) hash(value.manifestHash);
  return value;
}
export async function readWriterReceipt(stateDir, operationId) {
  nativeId(operationId);
  const parent = await directory(stateDir, `processed/writes/${operationId}`);
  if (!parent) return null;
  const record = await readJSON(path.join(parent, 'record.json'));
  if (!record) fail('WRITER_RECEIPT_INCOMPLETE');
  validateWriterReceipt(record.value);
  if (record.value.coordination.binding.stateDir !== stateDir || record.value.coordination.binding.operationId !== operationId) fail('WRITER_BINDING_MISMATCH');
  return record;
}

/** Nonempty-directory publication never overwrites another receipt. */
export async function publishWriterReceipt(coordination, outputs, manifestHash, guard, beforePublish) {
  validateWriterCoordination(coordination);
  const { stateDir, operationId } = coordination.binding;
  const desired = { format: 'cuefluent-writer-receipt', version: 1, coordination, outputs, manifestHash };
  const old = await readWriterReceipt(stateDir, operationId);
  if (old) {
    const { committedAt: _time, ...saved } = old.value;
    if (!equal(saved, desired)) fail('WRITER_RECEIPT_CONFLICT');
    return old;
  }
  const value = validateWriterReceipt({ ...desired, committedAt: new Date().toISOString() }), bytes = Buffer.from(canonicalJSON(value) + '\n');
  if (bytes.length > LIMIT) fail('WRITER_RECEIPT_LIMIT');
  const parent = await directory(stateDir, 'processed/writes', { create: true }, guard);
  const stage = path.join(parent, `.write-${randomUUID()}`), target = path.join(parent, operationId);
  await guard(); await fs.mkdir(stage, { mode: 0o700 });
  const identity = await fs.lstat(stage, { bigint: true });
  const file = path.join(stage, 'record.json'); let written = false, failure;
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); written = true; } finally { await handle.close(); }
    await syncDirectory(stage); await guard(); await beforePublish();
    if (!sameFileIdentity(identity, await fs.lstat(stage, { bigint: true })) || !(await readBoundedBytes(file, { noFollow: true, maxBytes: LIMIT })).equals(bytes)) fail('WRITER_RECEIPT_STAGE_CHANGED');
    if (await lstatOrNull(target)) fail('WRITER_RECEIPT_CONFLICT');
    await fs.rename(stage, target); await syncDirectory(parent);
    return { value, hash: digest(bytes) };
  } catch (error) { failure = error; throw error; } finally {
    try {
      if (await lstatOrNull(stage, { bigint: true })) {
        await guard();
        const current = await lstatOrNull(stage, { bigint: true });
        if (!current?.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(identity, current)) fail('WRITER_RECEIPT_STAGE_CHANGED');
        if (written) {
          if (!(await readBoundedBytes(file, { noFollow: true, maxBytes: LIMIT })).equals(bytes)) fail('WRITER_RECEIPT_STAGE_CHANGED');
          await fs.unlink(file);
        }
        // An open failure can leave an empty owned directory. rmdir removes
        // only that empty stage; partial or unfamiliar contents stay intact
        // and its failure attaches the cleanup warning to the original error.
        await fs.rmdir(stage);
      }
    } catch (error) {
      if (!failure) throw error;
      if (Object.isExtensible(failure)) failure.cleanupWarnings = [...(failure.cleanupWarnings ?? []), 'Writer receipt stage retained; cleanup could not be verified.'];
    }
  }
}
