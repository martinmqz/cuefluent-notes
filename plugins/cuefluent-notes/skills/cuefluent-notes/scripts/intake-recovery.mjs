import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertWorkflowStorage } from './workflow-storage.mjs';
import { openWorkflowIntake, inspectIntakeStore, intakeSnapshot, intakeJSON, guardStore, intakePath } from './intake-io.mjs';
import { stableSourceIdentity } from './capture-selection.mjs';
import { lstatOrNull, sameFileIdentity, readBoundedBytes, syncDirectory } from './file-io.mjs';
import { publishIngressMetadata } from './collection-ingress.mjs';
import { probeProcess, ownerIsGone } from './process-identity.mjs';
import { keys, nativeId, integer, timestamp, canonicalJSON, digest, fail } from './workflow-values.mjs';

const OFFLINE = ['entrypointsSuspended', 'clientsClosed', 'workersStopped', 'soleRecoveryProcess'];
const confirmOffline = value => {
  keys(value, OFFLINE);
  if (OFFLINE.some(key => value[key] !== true)) fail('OFFLINE_EXCLUSIVITY_REQUIRED');
};
function ownerShape(owner) {
  keys(owner, ['version', 'pid', 'hostname', 'createdAt', 'nonce', 'processStart', 'boot']);
  if (owner.version !== 1 || typeof owner.hostname !== 'string' || !owner.hostname || owner.hostname.length > 255) fail('INVALID_INTAKE_OWNER');
  integer(owner.pid); if (owner.pid === 0) fail('INVALID_INTAKE_OWNER');
  nativeId(owner.nonce); timestamp(owner.createdAt);
  for (const field of ['processStart', 'boot']) if (owner[field] !== null && (typeof owner[field] !== 'string' || owner[field].length > 256)) fail('INVALID_INTAKE_OWNER');
  return owner;
}

/** Read-only. Proof of a dead owner is necessary, never proof of offline exclusivity. */
export async function inspectIntakeRecovery(capability, { probe = probeProcess } = {}) {
  const collection = await assertWorkflowStorage(capability), store = await openWorkflowIntake(capability);
  const lock = path.join(store.intakeStateDir, '.intake-lock'), stat = await lstatOrNull(lock, { bigint: true });
  if (!stat) return { status: 'unlocked' };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_INTAKE_LOCK');
  const snapshot = await intakeSnapshot(store, 'state', '.intake-lock/owner.json', { maxBytes: 16384 });
  if (!snapshot.bytes) fail('INVALID_INTAKE_OWNER');
  const owner = ownerShape(intakeJSON(snapshot));
  if (!sameFileIdentity(stat, await fs.lstat(lock, { bigint: true })) || (await fs.readdir(lock)).join() !== 'owner.json') fail('INTAKE_LOCK_CHANGED');
  const current = await probe(owner.pid);
  return { status: ownerIsGone(owner, current) ? 'dead-owner-offline-recovery-required' : 'owner-live-or-unverified',
    plan: { format: 'cuefluent-intake-recovery', version: 1, id: randomUUID(), collectionId: collection.id,
      stateRoot: store.intakeStateDir, stateIdentity: stableSourceIdentity(await fs.lstat(store.intakeStateDir, { bigint: true })),
      lockIdentity: stableSourceIdentity(stat), ownerHash: snapshot.hash, owner },
    proof: { state: current.state, sameHost: owner.hostname === current.hostname, gone: ownerIsGone(owner, current) },
    prerequisite: 'Suspend all collection entrypoints, close affected clients, stop detached workers and other maintenance, and run exactly one recovery process. PID checks do not establish this offline window.' };
}

/** Explicit offline-only action. The caller must establish the operational
 * prerequisite outside this helper; confirmations do not create OS exclusivity.
 */
export async function applyIntakeRecovery(capability, reviewed, { offline, probe = probeProcess } = {}) {
  confirmOffline(offline);
  keys(reviewed, ['format', 'version', 'id', 'collectionId', 'stateRoot', 'stateIdentity', 'lockIdentity', 'ownerHash', 'owner']);
  if (reviewed.format !== 'cuefluent-intake-recovery' || reviewed.version !== 1) fail('INVALID_INTAKE_RECOVERY');
  nativeId(reviewed.id); ownerShape(reviewed.owner);
  const plan = structuredClone(reviewed), collection = await assertWorkflowStorage(capability);
  const store = await inspectIntakeStore(collection); // Pins roots, not the directory we will move.
  if (plan.collectionId !== collection.id || plan.stateRoot !== store.intakeStateDir ||
      plan.stateIdentity !== stableSourceIdentity(await fs.lstat(store.intakeStateDir, { bigint: true }))) fail('INTAKE_RECOVERY_CHANGED');
  const marker = path.join(store.intakeStateDir, '.intake-maintenance'), bytes = Buffer.from(canonicalJSON({ version: 1, id: plan.id, planHash: digest(canonicalJSON(plan)) }) + '\n');
  try { await fs.mkdir(marker, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('MAINTENANCE_ALREADY_ACTIVE'); throw error; }
  const markerIdentity = await fs.lstat(marker, { bigint: true });
  let markerWritten = false;
  try {
    const ownerFile = await fs.open(path.join(marker, 'owner.json'), 'wx', 0o600);
    try { await ownerFile.writeFile(bytes); await ownerFile.sync(); markerWritten = true; }
    finally { await ownerFile.close(); }
    await syncDirectory(marker); await syncDirectory(store.intakeStateDir);
    const fresh = await inspectIntakeRecovery(capability, { probe });
    if (!fresh.plan) fail('INTAKE_RECOVERY_CHANGED');
    const { id: _id, ...freshPlan } = fresh.plan, { id: _oldId, ...expected } = plan;
    if (canonicalJSON(freshPlan) !== canonicalJSON(expected)) fail('INTAKE_RECOVERY_CHANGED');
    if (!fresh.proof.gone) fail('INTAKE_OWNER_NOT_PROVEN_DEAD');
    const destination = await intakePath(store, 'state', `recovered-locks/${plan.id}`, { createParents: true });
    if (await lstatOrNull(destination)) fail('INTAKE_RECOVERY_CHANGED');
    await publishIngressMetadata(store, `recovery-records/${plan.id}/record.json`, plan, { exclusive: true });
    const lock = path.join(store.intakeStateDir, '.intake-lock');
    await guardStore(store);
    if (stableSourceIdentity(await fs.lstat(lock, { bigint: true })) !== plan.lockIdentity ||
        digest(await readBoundedBytes(path.join(lock, 'owner.json'), { noFollow: true, maxBytes: 16384 })) !== plan.ownerHash ||
        !ownerIsGone(plan.owner, await probe(plan.owner.pid))) fail('INTAKE_RECOVERY_CHANGED');
    await guardStore(store, [destination]);
    if (stableSourceIdentity(await fs.lstat(lock, { bigint: true })) !== plan.lockIdentity) fail('INTAKE_RECOVERY_CHANGED');
    await fs.rename(lock, destination); await syncDirectory(path.dirname(destination)); await syncDirectory(store.intakeStateDir);
    return { status: 'quarantined', recoveryId: plan.id };
  } finally {
    await guardStore(store);
    const current = await lstatOrNull(marker, { bigint: true });
    if (!sameFileIdentity(markerIdentity, current)) fail('MAINTENANCE_OWNERSHIP_CHANGED');
    if (markerWritten) {
      const file = path.join(marker, 'owner.json');
      if (!(await readBoundedBytes(file, { noFollow: true, maxBytes: 4096 })).equals(bytes)) fail('MAINTENANCE_OWNERSHIP_CHANGED');
      await fs.unlink(file);
    }
    await fs.rmdir(marker); await syncDirectory(store.intakeStateDir);
  }
}
