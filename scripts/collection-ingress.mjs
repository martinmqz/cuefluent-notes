import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectIntakeStore, intakePath, intakeSnapshot, intakeJSON, writeIntakeStage, guardStore } from './intake-io.mjs';
import { removeOwnedStage, syncDirectory, sameFileIdentity, lstatOrNull } from './file-io.mjs';
import { collectionGrantHash } from './collection-grant.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { CLAUDE_READER_RULES_REVISION } from './claude-reader.mjs';
import { readSelection } from './intake-store.mjs';
import { canonicalWorkflowProject, canonicalWorkflowPath } from './workflow-paths.mjs';
import { nativeContextEnvelope } from './workflow-context.mjs';
import { readWorkflowSnapshot, workflowConfigPath } from './workflow-config.mjs';
import { resolveWorkflowRoute } from './workflow-routes.mjs';
import { canonicalJSON, digest, fail, keys, nativeId, hash, integer, choice, timestamp, id, string } from './workflow-values.mjs';

export const collectionStatusPath = 'ingress/status/record.json';
export const registrationShard = sessionId => digest(nativeId(sessionId)).slice(0, 2);
export const registrationPath = identity => `ingress/registrations/${choice(identity.client, ['codex', 'claude'])}/${registrationShard(identity.sessionId)}/${nativeId(identity.sessionId)}/record.json`;
export const wakePath = identity => `ingress/wake/${choice(identity.client, ['codex', 'claude'])}/${nativeId(identity.sessionId)}.json`;
export const suspendedPath = identity => `ingress/suspended/${choice(identity.client, ['codex', 'claude'])}/${nativeId(identity.sessionId)}.json`;
export const drainedPath = identity => `ingress/drained/${choice(identity.client, ['codex', 'claude'])}/${nativeId(identity.sessionId)}.json`;
export const registrationFloorPath = identity => `registration-floors/${choice(identity.client, ['codex', 'claude'])}/${nativeId(identity.sessionId)}.json`;
export const processingSourceDirectory = client => `ingress/processing-sources/${choice(client, ['codex', 'claude'])}`;
export const processingSourcePath = (identity, policyHash) => `${processingSourceDirectory(identity.client)}/${nativeId(identity.sessionId)}/${hash(policyHash)}/record.json`;
// Shape version only; reader-owned rules revisions invalidate cached results.
export const READER_SUSPENSION_VERSION = 2;

/** Hook-only boundary: filesystem metadata, no open/read of transcript bytes. */
export async function snapshotSourceMetadata(file) {
  if (file === null) return null;
  const canonical = await canonicalWorkflowPath(file, { directory: false });
  const stat = await lstatOrNull(canonical, { bigint: true });
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1n) fail('UNSAFE_SESSION_SOURCE');
  const after = await fs.lstat(canonical, { bigint: true });
  if (!sameFileIdentity(stat, after) || after.size < stat.size || after.nlink !== 1n) fail('SOURCE_CHANGED');
  return { path: canonical, fileIdentity: stableSourceIdentity(stat), eofByte: integer(Number(stat.size)) };
}

export function validateProcessingSource(value, identity, policyHash, bytes) {
  keys(value, ['format', 'version', 'client', 'sessionId', 'policyHash', 'cwd', 'snapshot']);
  if (value.format !== 'cuefluent-processing-source' || value.version !== 1 || value.client !== identity.client ||
      value.sessionId !== identity.sessionId || value.policyHash !== policyHash) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  processingSourcePath(value, value.policyHash);
  keys(value.snapshot, ['path', 'fileIdentity', 'eofByte']);
  hash(value.snapshot.fileIdentity); integer(value.snapshot.eofByte);
  for (const file of [value.cwd, value.snapshot.path]) if (!path.isAbsolute(string(file))) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  if (!bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
  return value;
}

// A locator and future read floor only: no collection registration, interval,
// wake or transcript read. The immutable floor is scoped to the exact policy.
async function registerProcessingSource(store, envelope, snapshot, configPath) {
  if (envelope.sourcePath === null) return;
  const source = await snapshotSourceMetadata(envelope.sourcePath);
  if (!source) return;
  const name = processingSourcePath(envelope, snapshot.hash);
  const previous = await intakeSnapshot(store, 'state', name, { maxBytes: 16384 });
  if (previous.bytes !== null) {
    const old = validateProcessingSource(intakeJSON(previous), envelope, snapshot.hash, previous.bytes);
    if (old.snapshot.path !== source.path || old.snapshot.fileIdentity !== source.fileIdentity ||
        source.eofByte < old.snapshot.eofByte || old.cwd !== envelope.cwd) fail('PROCESSING_CONTROL_SOURCE_UNVERIFIED');
    return;
  }
  if ((await readWorkflowSnapshot(configPath)).hash !== snapshot.hash) fail('WORKFLOW_POLICY_CHANGED');
  await publishIngressMetadata(store, name, { format: 'cuefluent-processing-source', version: 1,
    client: envelope.client, sessionId: envelope.sessionId, policyHash: snapshot.hash,
    cwd: envelope.cwd, snapshot: source }, { exclusive: true });
}

/** Atomic bounded metadata; no intake lock, source content, model, or note writes.
 * Explicit setup prepared these roots. This structural view is NOT a privacy
 * capability and cannot publish captures; the worker obtains a fresh capability.
 */
export async function publishIngressMetadata(store, name, value, { exclusive = false } = {}) {
  const bytes = Buffer.from(canonicalJSON(value) + '\n');
  if (bytes.length > 16384) fail('INGRESS_METADATA_LIMIT');
  const guard = () => guardStore(store), temporary = `ingress/stages/.ingress-${randomUUID()}`;
  const stageName = exclusive ? `${temporary}/record.json` : `${temporary}.tmp`;
  const stageStore = exclusive ? await inspectIntakeStore(store) : store;
  const stage = await writeIntakeStage(stageStore, 'state', stageName, bytes, guard);
  const stageGuard = () => guardStore(stageStore, [stage.file]);
  let moved = false, failure;
  try {
    const destination = await intakePath(store, 'state', name, { createParents: !exclusive });
    await guard();
    if (exclusive) {
      // Publish a nonempty directory atomically. Competing registrations cannot
      // overwrite each other's nonempty directory or expose a partial JSON file.
      await intakePath(store, 'state', `${path.posix.dirname(path.posix.dirname(name))}/.parent`, { createParents: true });
      const directory = path.dirname(destination);
      if (await lstatOrNull(directory)) return false;
      await stageGuard(); await guardStore(store, [directory]);
      try { await fs.rename(path.dirname(stage.file), directory); moved = true; }
      catch (error) { if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) && await lstatOrNull(directory)) return false; throw error; }
      await syncDirectory(path.dirname(directory));
    } else {
      await intakeSnapshot(store, 'state', name, { maxBytes: 16384 });
      await guardStore(store, [stage.file, destination]);
      await fs.rename(stage.file, destination); moved = true;
    }
    await syncDirectory(path.dirname(destination)); return true;
  } catch (error) { failure = error; throw error; } finally {
    try {
      if (!moved) {
        const removed = await removeOwnedStage(stage.file, stage.identity, bytes, { guard: stageGuard });
        if (exclusive && removed) {
          await stageGuard();
          try { await fs.rmdir(path.dirname(stage.file)); }
          catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
        }
      }
    } catch (error) {
      if (!failure) throw error;
      if (Object.isExtensible(failure)) failure.cleanupWarnings = [...(failure.cleanupWarnings ?? []), 'Ingress stage retained; cleanup could not be verified.'];
    }
  }
}

export function validateRegistration(value) {
  keys(value, ['format', 'version', 'id', 'client', 'sessionId', 'sourcePath', 'cwd', 'projectRoot', 'routeId', 'collectionId', 'grantHash', 'registeredAt', 'event', 'unitId', 'startSource', 'snapshot']);
  if (value.format !== 'cuefluent-registration' || value.version !== 1) fail('INVALID_REGISTRATION');
  nativeId(value.id); registrationPath(value); hash(value.grantHash); timestamp(value.registeredAt);
  id(value.routeId); id(value.collectionId);
  if (value.startSource !== null) choice(value.startSource, ['startup', 'resume', 'compact', 'clear']);
  if (value.unitId !== null) nativeId(value.unitId);
  choice(value.event, ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt', 'StopFailure', 'SessionEnd']);
  if (value.snapshot !== null) {
    keys(value.snapshot, ['path', 'fileIdentity', 'eofByte']); hash(value.snapshot.fileIdentity); integer(value.snapshot.eofByte);
  }
  // The worker revalidates the native locator and current relevant collection grant.
  for (const key of ['sourcePath', 'cwd', 'projectRoot']) if (!path.isAbsolute(string(value[key]))) fail('INVALID_REGISTRATION');
  if (value.snapshot && value.snapshot.path !== value.sourcePath) fail('INVALID_REGISTRATION');
  return value;
}

/** Exact bounded metadata only; a registration is never source-read authority. */
export async function readRegistration(store, identity, { mismatchCode = 'INVALID_REGISTRATION' } = {}) {
  const snapshot = await intakeSnapshot(store, 'state', registrationPath(identity), { maxBytes: 16384 });
  const registration = snapshot.bytes === null ? null : validateRegistration(intakeJSON(snapshot));
  if (registration && (registration.client !== identity.client || registration.sessionId !== identity.sessionId)) fail(mismatchCode);
  return { snapshot, registration };
}

/** Registrations keep their original locator and floor. A reviewed selection
 * may bind a fresh grant atomically, but can never change the native source. */
export async function assertRegistrationGrant(store, registration, state, grantHash, route) {
  const rebound = state?.currentGrantHash != null;
  if ((rebound ? state.currentGrantHash : registration.grantHash) !== grantHash ||
      (!rebound && state?.intervals.length)) fail('REGISTRATION_REQUIRES_REVIEW');
  if (registration.collectionId !== route.collection.id) fail('REGISTRATION_REQUIRES_REVIEW');
  if (!rebound && (registration.routeId !== route.route.id ||
      await canonicalWorkflowPath(registration.projectRoot) !== await canonicalWorkflowPath(route.route.projectRoot))) fail('REGISTRATION_REQUIRES_REVIEW');
  if (state) {
    if (state.source.path !== registration.sourcePath || state.source.projectRoot !==
        await canonicalWorkflowProject(registration.cwd)) fail('SOURCE_IDENTITY_MISMATCH');
    let floor = registration.snapshot;
    if (floor === null) {
      const saved = intakeJSON(await intakeSnapshot(store, 'state',
        `registration-floors/${registration.client}/${registration.sessionId}.json`, { maxBytes: 16384 }));
      if (saved) {
        keys(saved, ['registrationId', 'snapshot']);
        if (saved.registrationId !== registration.id) fail('REGISTRATION_REQUIRES_REVIEW');
        floor = saved.snapshot;
      }
    }
    // A pending registration has never pinned a file. An explicit start, or
    // a never-armed manual/exclusion state, can corroborate identity via metadata.
    // Automatic arming still freezes its floor from the durable wake separately.
    if (!floor && (rebound || state.intervals.length === 0)) floor = await snapshotSourceMetadata(registration.sourcePath);
    if (!floor) fail('SOURCE_IDENTITY_MISMATCH');
    keys(floor, ['path', 'fileIdentity', 'eofByte']); hash(floor.fileIdentity); integer(floor.eofByte);
    if (floor.path !== state.source.path || floor.fileIdentity !== state.source.fileIdentity) fail('SOURCE_IDENTITY_MISMATCH');
  }
}

export function launchCollectionWorker({ configPath, collectionId, trigger = null }) {
  if (trigger !== null) { keys(trigger, ['client', 'sessionId']); choice(trigger.client, ['codex', 'claude']); nativeId(trigger.sessionId); }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./collection-worker.mjs', import.meta.url)), '--config', configPath, '--collection', collectionId,
      ...(trigger ? ['--client', trigger.client, '--session', trigger.sessionId] : [])],
      { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Returns metadata only. A hook envelope is not a current-turn control token. */
export async function collectionIngress(client, payload, { configPath, launch = launchCollectionWorker } = {}) {
  configPath ??= await workflowConfigPath();
  const envelope = nativeContextEnvelope(client, payload), snapshot = await readWorkflowSnapshot(configPath);
  const route = await resolveWorkflowRoute(snapshot.config, envelope);
  if (!route.intended?.collect && !route.intended?.process) return { status: route.status === 'selected' ? 'disabled' : route.status, context: null };
  const store = await inspectIntakeStore(route.collection);
  if (await lstatOrNull(await intakePath(store, 'state', '.intake-maintenance'))) return { status: 'offline-maintenance', context: null };
  const notice = intakeJSON(await intakeSnapshot(store, 'state', collectionStatusPath, { maxBytes: 16384 }));
  const blocked = Boolean(await lstatOrNull(await intakePath(store, 'state', '.intake-lock')));
  if (!route.intended.collect) {
    await registerProcessingSource(store, envelope, snapshot, configPath);
    return { status: 'processing-only', intakeBlocked: blocked, context: null, notice, selection: envelope };
  }
  const selected = await readSelection(store, { client, sessionId: envelope.sessionId });
  const paused = selected.state?.paused === true;
  if (paused) {
    let drained = null, suspended = null, pendingFree = false;
    try {
      pendingFree = intakeJSON(await intakeSnapshot(store, 'state', 'pending.json', { maxBytes: 16384 })) === null;
      drained = intakeJSON(await intakeSnapshot(store, 'state', drainedPath(envelope), { maxBytes: 16384 }));
      if (drained) { keys(drained, ['version', 'selectionHash']); hash(drained.selectionHash); }
      suspended = intakeJSON(await intakeSnapshot(store, 'state', suspendedPath(envelope), { maxBytes: 16384 }));
      if (suspended) { keys(suspended, ['version', 'selectionHash'], ['readerRulesRevision']); hash(suspended.selectionHash); }
    } catch { drained = suspended = null; } // Large pending intents and damaged hints never suppress work.
    if (pendingFree && ((selected.state.intervals.length === 0 && selected.state.explicitScopes.length === 0) ||
        (drained?.version === 1 && drained.selectionHash === selected.hash) ||
        (suspended?.version === READER_SUSPENSION_VERSION && suspended.readerRulesRevision === CLAUDE_READER_RULES_REVISION && suspended.selectionHash === selected.hash))) {
      return { status: 'paused', intakeBlocked: blocked, context: null, notice, selection: envelope };
    }
  }
  // A pending new source must not prevent this SessionStart from waking older registrations.
  let status = 'pending-source';
  if (envelope.sourcePath !== null && (!paused || selected.state.intervals.length)) {
    const source = await snapshotSourceMetadata(envelope.sourcePath);
    const sourcePath = source?.path ?? await canonicalWorkflowPath(envelope.sourcePath, { directory: false });
    const registration = { format: 'cuefluent-registration', version: 1, id: randomUUID(), client, sessionId: envelope.sessionId,
      sourcePath, cwd: envelope.cwd, projectRoot: route.route.projectRoot, routeId: route.route.id, collectionId: route.collection.id,
      grantHash: await collectionGrantHash(snapshot.config, route.route.id, envelope), registeredAt: new Date().toISOString(), event: envelope.event, unitId: envelope.unitId,
      startSource: envelope.startSource ?? null, snapshot: source };
    const name = registrationPath(envelope), { registration: old } = await readRegistration(store, envelope);
    if (old !== null) {
      await assertRegistrationGrant(store, old, selected.state, registration.grantHash, route);
      if (old.sourcePath !== sourcePath ||
          (old.snapshot && source && old.snapshot.fileIdentity !== source.fileIdentity) ||
          (selected.state && source && selected.state.source.fileIdentity !== source.fileIdentity)) fail('REGISTRATION_REQUIRES_REVIEW');
    } else await publishIngressMetadata(store, name, registration, { exclusive: true });
    await publishIngressMetadata(store, wakePath(envelope), { version: 1, id: randomUUID(), registration: name,
      policyHash: snapshot.hash, event: envelope.event, unitId: envelope.unitId, snapshot: source });
    status = source ? 'queued' : 'pending-source';
  }
  if (blocked) return { status: paused ? 'paused' : 'intake-blocked', intakeBlocked: true, context: null, notice, selection: envelope };
  try { await launch({ configPath, collectionId: route.collection.id, trigger: { client, sessionId: envelope.sessionId } }); }
  catch { return { status: 'worker-launch-failed', context: null, notice }; }
  return { status: paused ? 'paused' : status, context: null, notice, selection: envelope };
}
