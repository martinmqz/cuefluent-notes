import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sameFileIdentity, readBoundedBytes, syncDirectory, removeOwnedStage } from './file-io.mjs';
import { canonicalJSON, fail } from './workflow-values.mjs';
import { ownProcessIdentity } from './process-identity.mjs';

function cleanupWarning(error, warning) {
  if (error instanceof Error && Object.isExtensible(error)) error.cleanupWarnings = [...(error.cleanupWarnings ?? []), warning];
  else console.error(warning);
}

/** No stealing, including incomplete owners. */
export async function withIntakeDirectoryLock(intakeStateDir, guardRoot, operation, {
  probeOwner = ownProcessIdentity, preserveOnError = () => false,
} = {}) {
  await guardRoot();
  const evidence = await probeOwner(process.pid);
  const owner = { version: 1, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(),
    nonce: randomUUID(), processStart: evidence.processStart ?? null, boot: evidence.boot ?? null };
  const bytes = Buffer.from(canonicalJSON(owner) + '\n');
  if (bytes.length > 16 * 1024) fail('INVALID_INTAKE_OWNER');
  const lock = path.join(intakeStateDir, '.intake-lock');
  await guardRoot();
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('INTAKE_BLOCKED'); throw error; }
  const identity = await fs.lstat(lock, { bigint: true });
  const ownerPath = path.join(lock, 'owner.json');
  const guardDirectory = async () => {
    await guardRoot();
    const stat = await fs.lstat(lock, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(identity, stat)) fail('INTAKE_LOCK_CHANGED');
  };
  let ownerIdentity;
  try {
    const handle = await fs.open(ownerPath, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally {
      try { ownerIdentity = await handle.stat({ bigint: true }); } catch { ownerIdentity = undefined; }
      await handle.close();
    }
    await syncDirectory(lock); await syncDirectory(intakeStateDir);
  } catch (error) {
    try {
      await guardDirectory();
      if (ownerIdentity && !await removeOwnedStage(ownerPath, ownerIdentity, bytes, { partial: true, guard: guardDirectory })) throw new Error();
      await guardDirectory(); await fs.rmdir(lock); await syncDirectory(intakeStateDir);
    } catch { cleanupWarning(error, 'Incomplete intake lock cleanup was unsafe; preserve it for inspection.'); }
    throw error;
  }
  const guard = async () => {
    await guardDirectory();
    const ownerStat = await fs.lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.nlink !== 1 || !(await readBoundedBytes(ownerPath, { noFollow: true, maxBytes: 16 * 1024 })).equals(bytes)) fail('INTAKE_LOCK_CHANGED');
  };
  let output, failure, failed = false, warning;
  try { await guard(); output = await operation(guard); }
  catch (error) { failed = true; failure = error; }
  if (failed && preserveOnError(failure)) {
    cleanupWarning(failure, 'Intake lock retained after unsafe setup rollback; inspect before explicit recovery.');
    throw failure;
  }
  let ownerRemoved = false, lockRemoved = false;
  try {
    await guard();
    const entries = await fs.readdir(lock);
    if (entries.length !== 1 || entries[0] !== 'owner.json') fail('INTAKE_LOCK_CHANGED');
    await fs.unlink(ownerPath); ownerRemoved = true;
    const current = await fs.lstat(lock, { bigint: true });
    if (!sameFileIdentity(identity, current)) fail('INTAKE_LOCK_CHANGED');
    await fs.rmdir(lock); lockRemoved = true;
    await syncDirectory(intakeStateDir);
  } catch (error) {
    let restored = false;
    if (ownerRemoved && !lockRemoved) {
      try {
        // Only restore inside the original directory, and never overwrite a
        // competing owner. Keep the original identity bytes for offline recovery.
        await guardDirectory();
        const handle = await fs.open(ownerPath, 'wx', 0o600);
        try { await guardDirectory(); await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        await guard(); await syncDirectory(lock); await syncDirectory(intakeStateDir);
        restored = true;
      } catch { /* Preserve uncertain files and report restoration failure. */ }
    }
    warning = lockRemoved
      ? `Intake lock was removed but directory sync failed (${error.code ?? 'filesystem error'}); inspect storage durability before retrying.`
      : `Intake lock cleanup failed (${error.code ?? 'filesystem error'}); ${ownerRemoved && !restored ? 'owner restoration was unsafe or failed; preserve all remaining files for inspection.' : 'preserve its owner metadata and inspect before retrying.'}`;
  }
  if (failed) { if (warning) cleanupWarning(failure, warning); throw failure; }
  return warning ? { ...output, warnings: (output?.warnings ?? 0) + 1, cleanupWarnings: [...(output?.cleanupWarnings ?? []), warning] } : output;
}
