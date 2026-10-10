import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkflowSnapshot, validateWorkflowConfig, MAX_WORKFLOW_CONFIG_BYTES } from './workflow-config.mjs';
import { canonicalWorkflowPath, validateWorkflowPlacement, resolveWorkflowConfig } from './workflow-paths.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { prepareWorkflowStorage, verifyPrivateDirectories } from './workflow-storage.mjs';
import { privacyIdentity, createPrivateDirectory, verifyPrivateEntries, rejectKnownSync, withStorageProbes } from './storage-platform.mjs';
import { lstatOrNull, sameFileIdentity, isOwnedStage, removeOwnedStage, syncDirectory } from './file-io.mjs';
import { withLock } from './safe-update.mjs';
import { workflowDiagnostics } from './workflow-diagnostics.mjs';
import { canonicalJSON, digest, fail, hash } from './workflow-values.mjs';
import { assignCollectionGenerations } from './collection-grant.mjs';
import { preflightWindowsConfiguration, windowsSettingsDiagnostics } from './windows-setup-guards.mjs';
import { generatedOutputCapabilities } from './workflow-context.mjs';

export async function workflowStatus({ configPath, requestedConfigPath, selection, diagnostics = false } = {}, platformFacts = {}) {
  const selected = await resolveWorkflowConfig({ explicit: configPath });
  configPath = selected.configPath; requestedConfigPath ??= selected.requestedConfigPath;
  if (typeof diagnostics !== 'boolean') fail('INVALID_WORKFLOW');
  const snapshot = await readWorkflowSnapshot(configPath);
  return { runtime: await workflowDiagnostics(), configPath, configHash: snapshot.hash, config: snapshot.config,
    requestedConfigPath, resolvedConfigPath: await canonicalWorkflowPath(configPath, { directory: false }),
    ...await windowsSettingsDiagnostics(configPath, snapshot.config, { ...platformFacts, details: diagnostics }),
    ...(selection ? { route: await resolveWorkflowRoute(snapshot.config, selection) } : {}),
    transport: { verified: false, automaticProcessing: false, generatedOutput: generatedOutputCapabilities(),
      reason: 'Explicit client/session/unit selection is required; current-turn transport is unverified.' } };
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
    await createPrivateDirectory(parent, identity);
    await syncDirectory(ancestor);
  }
  await verifyPrivateDirectories([parent]);
}
async function readyCollections(config, placement) {
  const roots = [];
  for (const collection of placement.collections) {
    const active = config.routes.some(route => route.collectionId === collection.id && !route.excluded &&
      (route.collection.enabled || route.processing.mode !== 'manual'));
    if (active) roots.push(...await verifyPrivateDirectories([collection.rawDir, collection.intakeStateDir, collection.notes.writerStateDir]));
  }
  return roots;
}

/** Reviewed whole-configuration CAS. Never imports legacy settings, repairs
 * existing permissions, or publishes active routes before private storage exists. */
export function configureWorkflow(request, options = {}) {
  return withStorageProbes(() => configure(request, options));
}
async function configure({ configPath, expectedHash, proposal }, options) {
  const selection = await resolveWorkflowConfig({ explicit: configPath });
  const explicit = options.explicitConfig ?? selection.explicit;
  configPath = selection.configPath;
  if (expectedHash !== null) hash(expectedHash);
  const current = await readWorkflowSnapshot(configPath);
  if (current.hash !== expectedHash) fail('WORKFLOW_POLICY_CHANGED');
  const file = await canonicalWorkflowPath(configPath, { directory: false }), parent = path.dirname(file);
  const originalStat = await lstatOrNull(file, { bigint: true });
  const config = await assignCollectionGenerations(current.config, validateWorkflowConfig(proposal));
  const placement = await validateWorkflowPlacement(config, { configPath });
  const readyRoots = await readyCollections(config, placement);
  const recheck = await preflightWindowsConfiguration({ configPath, previous: current.config, proposed: config, explicit }, options.platformFacts);
  rejectKnownSync(file); const identity = await privacyIdentity();
  const bytes = Buffer.from(canonicalJSON(config) + '\n');
  if (bytes.length > MAX_WORKFLOW_CONFIG_BYTES) fail('WORKFLOW_CONFIG_LIMIT');
  await privateParent(parent, identity);
  const parentStat = await fs.lstat(parent, { bigint: true });
  const paths = { configPath: file, requestedConfigPath: options.requestedConfigPath ?? selection.requestedConfigPath, resolvedConfigPath: file };
  return withLock(parent, async held => {
    const guard = async () => {
      await held(); await verifyPrivateDirectories([parent]);
      if (await canonicalWorkflowPath(configPath, { directory: false }) !== file || (await readWorkflowSnapshot(file)).hash !== expectedHash) fail('WORKFLOW_POLICY_CHANGED');
      const stat = await lstatOrNull(file, { bigint: true });
      if (originalStat ? !sameFileIdentity(originalStat, stat) : stat !== null) fail('WORKFLOW_POLICY_CHANGED');
      if (stat) await verifyPrivateEntries([{ path: file, stat, root: false }], identity);
    };
    await guard();
    if (digest(bytes) === expectedHash) return { status: 'unchanged', ...paths, configHash: expectedHash, config };
    const stage = path.join(parent, `.workflow-${randomUUID()}.tmp`); let stageIdentity;
    try {
      const handle = await fs.open(stage, 'wx', 0o600);
      try {
        // Desktop can expose a redirected file even when its directory keeps the
        // requested realpath. Detect that before writing settings bytes.
        if (await fs.realpath(stage) !== stage) fail('PRIVATE_STORAGE_REDIRECTED');
        await verifyPrivateEntries([{ path: stage, stat: await handle.stat({ bigint: true }), root: false }], identity);
        await handle.writeFile(bytes); await handle.sync();
      } finally { try { stageIdentity = await handle.stat({ bigint: true }); } finally { await handle.close(); } }
      await verifyPrivateEntries([{ path: stage, stat: stageIdentity, root: false }], identity);
      await options.beforeCommit?.(); await guard();
      // Revalidate active storage and placement after proposal staging.
      const currentPlacement = await validateWorkflowPlacement(config, { configPath: file });
      if (canonicalJSON(currentPlacement) !== canonicalJSON(placement)) fail('PRIVATE_STORAGE_REDIRECTED');
      const currentRoots = await readyCollections(config, currentPlacement);
      if (readyRoots.some((root, i) => root.path !== currentRoots[i]?.path ||
          !sameFileIdentity(root.stat, currentRoots[i]?.stat))) fail('PRIVATE_STORAGE_CHANGED');
      await recheck?.({ path: parent, stat: parentStat, entries: ['.lock', path.basename(stage)] });
      if (!await isOwnedStage(stage, stageIdentity, bytes, { guard })) fail('WORKFLOW_CONFIG_STAGE_CHANGED');
      await fs.rename(stage, file); await syncDirectory(parent);
    } finally {
      if (stageIdentity) await removeOwnedStage(stage, stageIdentity, bytes, { partial: true, guard: held });
    }
    if ((await readWorkflowSnapshot(file)).hash !== digest(bytes)) fail('WORKFLOW_POLICY_CHANGED');
    return { status: current.hash === null ? 'initialized' : 'updated', ...paths, configHash: digest(bytes), config };
  });
}

/** Explicit setup step after disabled/manual settings are saved. Returns only
 * serializable status, never an opaque capability or implicit enablement. */
export async function prepareConfiguredStorage(options, preparation = {}) {
  const warnings = [];
  await prepareWorkflowStorage(options, { ...preparation, onWarning: code => warnings.push(code) });
  return { status: 'storage-ready', collectionId: options.collectionId, configHash: options.expectedConfigHash,
    ...(warnings.length ? { warnings } : {}) };
}
