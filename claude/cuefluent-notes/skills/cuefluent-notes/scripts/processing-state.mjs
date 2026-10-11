import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertWorkflowStorage, assertPrivatePaths } from './workflow-storage.mjs';
import { openProcessingIntake, inspectIntakeStore, withIntakeLock, guardStore, intakePath, intakeSnapshot, intakeJSON, writeIntakeStage } from './intake-io.mjs';
import { withWorkflowWriterLocks } from './capture-maintenance.mjs';
import { lstatOrNull, removeOwnedStage, syncDirectory, isOwnedStage } from './file-io.mjs';
import { canonicalJSON, fail, isNativeId } from './workflow-values.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';

export async function readProcessingState(capability, selection, operation) {
  const { collection, store, configHash, binding, hash } = await openProcessingIntake(capability, selection, operation);
  const metadataStore = await inspectIntakeStore(collection);
  const writer = await inspectIntakeStore({ rawDir: collection.rawDir, intakeStateDir: collection.notes.writerStateDir });
  return { capability, collection, policyHash: configHash, binding, bindingHash: hash,
    store, metadataStore, writer, selection, operation, guard: () => assertWorkflowStorage(capability, selection, operation) };
}
export async function withProcessingState(capability, selection, operation, run) {
  const ctx = await readProcessingState(capability, selection, operation);
  return withIntakeLock(ctx.store, tx => withWorkflowWriterLocks(tx, [ctx.collection.notes.writerStateDir], async (owned, held) => {
    const guard = async (privatePaths = []) => {
      await owned(); await assertWorkflowStorage(capability, selection, operation);
      if (privatePaths.length) await assertPrivatePaths(capability, privatePaths);
    };
    Object.assign(ctx, { tx, guard, owned, writerGuard: held.get(ctx.collection.notes.writerStateDir) });
    // Mutations authorize before publication. A later policy change must not
    // turn a committed result into a failed command. Evidence delivery checks
    // its authorization explicitly at the return boundary.
    await guard(); return run(ctx);
  }));
}
export async function processingSnapshot(ctx, name) {
  // Policy is checked at entry, mutations and evidence delivery. Each metadata read still
  // verifies current private permissions and pinned paths before opening bytes.
  const file = await intakePath(ctx.writer, 'state', name);
  await assertPrivatePaths(ctx.capability, [file]);
  return intakeSnapshot(ctx.writer, 'state', name);
}
export const processingJSON = async (ctx, name) => intakeJSON(await processingSnapshot(ctx, name));

export async function writeProcessingJSON(ctx, name, value, expectedHash, options) {
  return writeProcessingBytes(ctx, name, Buffer.from(canonicalJSON(value) + '\n'), expectedHash, options);
}
export async function writeProcessingBytes(ctx, name, bytes, expectedHash, { beforePublish } = {}) {
  const before = await processingSnapshot(ctx, name);
  if (before.hash !== expectedHash) fail('PROCESSING_STATE_CHANGED');
  if (!Buffer.isBuffer(bytes)) fail('INVALID_PROCESSING_BYTES');
  if (bytes.length > 1024 * 1024) fail('PROCESSING_METADATA_LIMIT');
  const target = await intakePath(ctx.writer, 'state', name, { createParents: true });
  const stageName = `processing-stages/.processing-${randomUUID()}.tmp`;
  const stageGuard = async () => {
    await ctx.guard();
    await assertPrivatePaths(ctx.capability, [await intakePath(ctx.writer, 'state', stageName)]);
  };
  const stage = await writeIntakeStage(ctx.writer, 'state', stageName, bytes, stageGuard);
  try {
    await ctx.guard();
    if ((await processingSnapshot(ctx, name)).hash !== expectedHash || !await isOwnedStage(stage.file, stage.identity, bytes, { guard: stageGuard })) fail('PROCESSING_STATE_CHANGED');
    await guardStore(ctx.writer, [stage.file, target]);
    // Synchronous admission boundary, immediately before durable publication.
    beforePublish?.();
    await fs.rename(stage.file, target); await syncDirectory(path.dirname(target));
  } finally { await removeOwnedStage(stage.file, stage.identity, bytes, { guard: stageGuard }); }
  return processingSnapshot(ctx, name);
}
export async function removeProcessingJSON(ctx, name, expectedHash) {
  const snapshot = await processingSnapshot(ctx, name);
  if (snapshot.hash === null) return;
  if (snapshot.hash !== expectedHash) fail('PROCESSING_STATE_CHANGED');
  const file = await intakePath(ctx.writer, 'state', name);
  const guard = async () => { await ctx.guard(); await guardStore(ctx.writer, [file]); };
  if (!await removeOwnedStage(file, snapshot.identity, snapshot.bytes, { guard })) fail('PROCESSING_STATE_CHANGED');
  await syncDirectory(path.dirname(file));
}
export async function processingNames(ctx, directory, limit = 100) {
  const target = await intakePath(ctx.writer, 'state', `${directory}/.list`), parent = path.dirname(target);
  await assertPrivatePaths(ctx.capability, [parent]);
  if (!await lstatOrNull(parent)) return [];
  const names = [];
  for await (const entry of await fs.opendir(parent)) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !isNativeId(entry.name.slice(0, -5))) fail('UNKNOWN_PROCESSING_STATE');
    names.push(`${directory}/${entry.name}`);
    if (names.length > limit) fail('PROCESSING_CAPACITY');
  }
  return names.sort();
}

/** Lexical metadata pagination. The bounded scan fails rather than pretending
 * an unvisited directory suffix is a complete page. */
export async function processingNamePage(ctx, directory, { limit, afterId }) {
  const target = await intakePath(ctx.writer, 'state', `${directory}/.list`), parent = path.dirname(target);
  await assertPrivatePaths(ctx.capability, [parent]);
  return nativeNamePage(parent, { limit, afterId });
}
export async function nativeNamePage(parent, { limit, afterId, invalidCode = 'UNKNOWN_PROCESSING_STATE', capacityCode = 'PROCESSING_INVENTORY_CAPACITY' }) {
  if (!await lstatOrNull(parent)) return { ids: [], incomplete: false, nextCursor: null };
  const ids = []; let scanned = 0;
  for await (const entry of await fs.opendir(parent)) {
    checkWorkflowBudget();
    if (++scanned > 65536) fail(capacityCode);
    if (!entry.isFile() || !entry.name.endsWith('.json') || !isNativeId(entry.name.slice(0, -5))) fail(invalidCode);
    const id = entry.name.slice(0, -5);
    if (afterId !== null && id <= afterId) continue;
    ids.push(id); ids.sort(); if (ids.length > limit + 1) ids.pop();
  }
  const incomplete = ids.length > limit; if (incomplete) ids.pop();
  return { ids, incomplete, nextCursor: incomplete ? ids.at(-1) : null };
}
