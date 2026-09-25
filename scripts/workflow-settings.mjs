import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkflowSnapshot, validateWorkflowConfig, workflowConfigPath, MAX_WORKFLOW_CONFIG_BYTES } from './workflow-config.mjs';
import { canonicalWorkflowPath, validateWorkflowPlacement } from './workflow-paths.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { prepareWorkflowStorage, verifyPrivateDirectories } from './workflow-storage.mjs';
import { privacyIdentity, protectNewDirectory, verifyPrivateEntries, rejectKnownSync } from './storage-platform.mjs';
import { lstatOrNull, sameFileIdentity, isOwnedStage, removeOwnedStage, syncDirectory } from './file-io.mjs';
import { withLock } from './safe-update.mjs';
import { workflowDiagnostics } from './workflow-diagnostics.mjs';
import { canonicalJSON, digest, fail, hash } from './workflow-values.mjs';
import { assignCollectionGenerations } from './collection-grant.mjs';

export async function workflowStatus({ configPath = workflowConfigPath(), selection } = {}) {
  const snapshot = await readWorkflowSnapshot(configPath);
  return { runtime: await workflowDiagnostics(), configPath, configHash: snapshot.hash, config: snapshot.config,
    ...(selection ? { route: await resolveWorkflowRoute(snapshot.config, selection) } : {}),
    transport: { verified: false, automaticProcessing: false, reason: 'Explicit client/session/unit selection is required; current-turn transport is unverified.' } };
}

async function privateParent(parent, identity) {
  const existing = await lstatOrNull(parent);
  if (!existing) {
    const ancestor = path.dirname(parent);
    if (ancestor === parent) fail('WORKFLOW_PATH_MISSING');
    // Ancestors are traversed to create a dedicated private settings directory;
    // existing ancestors receive no permission edits.
    if (!await lstatOrNull(ancestor)) await privateParent(ancestor, identity);
    const canonical = await canonicalWorkflowPath(parent);
    if (canonical !== parent) fail('WORKFLOW_CONFIG_PATH_CHANGED');
    await fs.mkdir(parent, { mode: 0o700 });
    const before = await fs.lstat(parent, { bigint: true });
    await protectNewDirectory(parent, identity);
    if (!sameFileIdentity(before, await fs.lstat(parent, { bigint: true }))) fail('PRIVATE_STORAGE_CHANGED');
    await syncDirectory(ancestor);
  }
  await verifyPrivateDirectories([parent]);
}
async function readyCollections(config, placement) {
  for (const collection of placement.collections) {
    const active = config.routes.some(route => route.collectionId === collection.id && !route.excluded &&
      (route.collection.enabled || route.processing.mode !== 'manual'));
    if (active) await verifyPrivateDirectories([collection.rawDir, collection.intakeStateDir, collection.notes.writerStateDir]);
  }
}

/** Reviewed whole-configuration CAS. Never imports legacy settings, repairs
 * existing permissions, or publishes active routes before private storage exists. */
export async function configureWorkflow({ configPath = workflowConfigPath(), expectedHash, proposal }, options = {}) {
  if (expectedHash !== null) hash(expectedHash);
  const current = await readWorkflowSnapshot(configPath);
  if (current.hash !== expectedHash) fail('WORKFLOW_POLICY_CHANGED');
  const file = await canonicalWorkflowPath(configPath, { directory: false }), parent = path.dirname(file);
  const originalStat = await lstatOrNull(file, { bigint: true });
  const config = await assignCollectionGenerations(current.config, validateWorkflowConfig(proposal));
  const placement = await validateWorkflowPlacement(config, { configPath });
  await readyCollections(config, placement);
  rejectKnownSync(file); const identity = await privacyIdentity();
  const bytes = Buffer.from(canonicalJSON(config) + '\n');
  if (bytes.length > MAX_WORKFLOW_CONFIG_BYTES) fail('WORKFLOW_CONFIG_LIMIT');
  await privateParent(parent, identity);
  return withLock(parent, async held => {
    const guard = async () => {
      await held(); await verifyPrivateDirectories([parent]);
      if (await canonicalWorkflowPath(configPath, { directory: false }) !== file || (await readWorkflowSnapshot(file)).hash !== expectedHash) fail('WORKFLOW_POLICY_CHANGED');
      const stat = await lstatOrNull(file, { bigint: true });
      if (originalStat ? !sameFileIdentity(originalStat, stat) : stat !== null) fail('WORKFLOW_POLICY_CHANGED');
      if (stat) await verifyPrivateEntries([{ path: file, stat, root: false }], identity);
    };
    await guard();
    if (digest(bytes) === expectedHash) return { status: 'unchanged', configPath: file, configHash: expectedHash, config };
    const stage = path.join(parent, `.workflow-${randomUUID()}.tmp`); let stageIdentity;
    try {
      const handle = await fs.open(stage, 'wx', 0o600);
      try {
        await handle.writeFile(bytes); await handle.sync();
      } finally { try { stageIdentity = await handle.stat({ bigint: true }); } finally { await handle.close(); } }
      await verifyPrivateEntries([{ path: stage, stat: stageIdentity, root: false }], identity);
      await options.beforeCommit?.(); await guard();
      // Revalidate active storage and placement after proposal staging.
      await readyCollections(config, await validateWorkflowPlacement(config, { configPath: file }));
      if (!await isOwnedStage(stage, stageIdentity, bytes, { guard })) fail('WORKFLOW_CONFIG_STAGE_CHANGED');
      await fs.rename(stage, file); await syncDirectory(parent);
    } finally {
      if (stageIdentity) await removeOwnedStage(stage, stageIdentity, bytes, { partial: true, guard: held });
    }
    if ((await readWorkflowSnapshot(file)).hash !== digest(bytes)) fail('WORKFLOW_POLICY_CHANGED');
    return { status: current.hash === null ? 'initialized' : 'updated', configPath: file, configHash: digest(bytes), config };
  });
}

/** Explicit setup step after disabled/manual settings are saved. Returns only
 * serializable status, never an opaque capability or implicit enablement. */
export async function prepareConfiguredStorage(options) {
  await prepareWorkflowStorage(options);
  return { status: 'storage-ready', collectionId: options.collectionId, configHash: options.expectedConfigHash };
}
