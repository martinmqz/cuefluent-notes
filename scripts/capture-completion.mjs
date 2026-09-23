import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { absolute, isMain, lstatOrNull, readBoundedBytes, readInputJSON, syncDirectory, sameFileIdentity } from './file-io.mjs';
import { CLIENTS, object, text, canonicalSelectedPath, captureSettings, configurationPath, readConfig, assertConfigurationStorage, completionEnabled, completionPermissionMode } from './capture-policy.mjs';

const outcomes = new Set(['saved', 'proposed', 'no-change', 'skipped', 'failed']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const stateError = () => Object.assign(new Error('Completion marker state is busy, unsafe, unreadable, or changed. Preserve it and finish without retrying.'), { code: 'COMPLETION_STATE_UNAVAILABLE' });
const fail = () => { throw stateError(); };

async function unchangedDirectories(entries) {
  for (const [file, identity] of entries) {
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(identity, stat) ||
      await fs.realpath(file) !== file) return false;
  }
  return true;
}

function identity(client, payload) {
  const native = payload?.[client === 'codex' ? 'turn_id' : 'prompt_id'];
  if (!CLIENTS.has(client) || !text(payload?.session_id, 256) || !text(native, 256)) fail();
  return { session: digest([client, payload.session_id]), turn: digest([client, payload.session_id, native]) };
}

// Bind a decision to its selected collection, scope and consent mode, without
// persisting paths, scope text, native identifiers or note content.
export function completionPolicyHash(settings, permissionMode) {
  return digest([settings.notesDir ?? null, settings.destination ?? null,
    settings.stateDir, settings.scope, settings.automaticUpdates, permissionMode ?? null]);
}

async function directory(input, create = false) {
  if (!absolute(input) || await canonicalSelectedPath(input) !== input) fail();
  let stat = await lstatOrNull(input);
  if (!stat && create) {
    await fs.mkdir(input, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(input);
  }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(input) !== input)) fail();
  return stat;
}

async function markerPath(settings, ids, create = false) {
  if (!await directory(settings.stateDir, create)) return null;
  const root = path.join(settings.stateDir, 'capture-completion');
  if (!await directory(root, create)) return null;
  const file = path.join(root, `${ids.session}.json`);
  const stat = await lstatOrNull(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) fail();
  return file;
}

async function readMarker(file) {
  const bytes = await readBoundedBytes(file, { maxBytes: 1024, missing: true, noFollow: true });
  if (!bytes) return null;
  const value = JSON.parse(bytes);
  if (!object(value) || Object.keys(value).sort().join(',') !== 'outcome,policyHash,turn,version' ||
    value.version !== 1 || !sha256(value.turn) || !sha256(value.policyHash) || !outcomes.has(value.outcome)) fail();
  return value;
}

/** Read-only Stop inspection. Missing state is normal; unsafe/busy state is not. */
export async function completionStatus(settings, client, payload) {
  try {
    const ids = identity(client, payload);
    const file = await markerPath(settings, ids);
    if (await lstatOrNull(path.join(settings.stateDir, '.lock'))) fail();
    const marker = file ? await readMarker(file) : null;
    // Recheck after asynchronous reads: a writer may have started meanwhile.
    if (await lstatOrNull(path.join(settings.stateDir, '.lock'))) fail();
    // An earlier successful helper call in this session and permission mode is
    // the only available evidence of agent access. Hook process access is not proof.
    if (!marker || marker.policyHash !== completionPolicyHash(settings, payload.permission_mode)) return 'unverified';
    return marker.turn === ids.turn ? 'complete' : 'missing';
  } catch { throw stateError(); }
}

/** Working-agent helper only. Never called by a hook; no note writes. */
export async function recordCompletion(input) {
  const keys = ['client', 'session_id', 'turn_id', 'prompt_id', 'cwd', 'configPath', 'policyHash', 'outcome', 'permissionMode'];
  if (!object(input) || Object.keys(input).some(key => !keys.includes(key)) ||
    !absolute(input.cwd) || !sha256(input.policyHash) || !outcomes.has(input.outcome) ||
    !completionPermissionMode(input.client, input.permissionMode) ||
    (input.client === 'codex' ? Object.hasOwn(input, 'prompt_id') : Object.hasOwn(input, 'turn_id'))) fail();
  const ids = identity(input.client, input);
  const configPath = configurationPath(input.configPath);
  const selected = async () => {
    const config = await readConfig(configPath);
    const settings = await captureSettings(input.client, input.cwd, config);
    if (!settings || !completionEnabled(config) ||
      completionPolicyHash(settings, input.permissionMode) !== input.policyHash) {
      throw Object.assign(new Error('The selected completion policy changed or is inactive. Preserve it and finish without retrying.'), { code: 'COMPLETION_POLICY_CHANGED' });
    }
    assertConfigurationStorage(settings, configPath);
    return settings;
  };
  const settings = await selected();
  // No state is created until the configured opt-in and inspected policy match.
  await directory(settings.stateDir, true);
  const stateIdentity = await fs.lstat(settings.stateDir, { bigint: true });
  const { withLock } = await import('./safe-update.mjs');
  return withLock(settings.stateDir, async () => {
    await selected();
    const parents = [[settings.stateDir, stateIdentity]];
    if (!await unchangedDirectories(parents)) fail();
    const file = await markerPath(settings, ids, true);
    const parentPath = path.dirname(file);
    parents.push([parentPath, await fs.lstat(parentPath, { bigint: true })]);
    const old = await readMarker(file); // Preserve malformed entries for inspection.
    const value = { version: 1, turn: ids.turn, policyHash: input.policyHash, outcome: input.outcome };
    if (JSON.stringify(old) === JSON.stringify(value)) return { status: 'unchanged' };
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const stage = path.join(parentPath, `.completion-${randomUUID()}.tmp`);
    let stageIdentity;
    let partialStage = false;
    const unchangedStage = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
      sameFileIdentity(stageIdentity, stat) && stat.ctimeNs === stageIdentity.ctimeNs &&
      stat.mtimeNs === stageIdentity.mtimeNs;
    const ownedStage = async () => {
      try {
        if (!stageIdentity || !await unchangedDirectories(parents)) return false;
        if (!unchangedStage(await fs.lstat(stage, { bigint: true }))) return false;
        const actual = await readBoundedBytes(stage, { maxBytes: 1024, noFollow: true });
        const expected = partialStage ? bytes.subarray(0, actual.length) : bytes;
        // The read awaits filesystem operations: its descriptor can retain our
        // bytes while another process replaces the stage pathname or parent.
        return actual.equals(expected) && await unchangedDirectories(parents) &&
          unchangedStage(await fs.lstat(stage, { bigint: true }));
      } catch { return false; }
    };
    let created = false;
    try {
      if (!await unchangedDirectories(parents)) fail();
      const handle = await fs.open(stage, 'wx', 0o600);
      created = true;
      try {
        stageIdentity = await handle.stat({ bigint: true });
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        partialStage = true;
        throw error;
      } finally {
        // Keep the descriptor's identity even after a partial write or failed
        // fsync. Cleanup may remove only unchanged bytes that we attempted to write.
        try { stageIdentity = await handle.stat({ bigint: true }); } catch { /* Preserve unverifiable stages. */ }
        await handle.close();
      }
      await selected();
      if (await markerPath(settings, ids) !== file ||
        JSON.stringify(await readMarker(file)) !== JSON.stringify(old) || !await ownedStage()) fail();
      await fs.rename(stage, file);
      created = false;
      await syncDirectory(path.dirname(file));
      return { status: 'recorded' };
    } finally {
      // Validation may have detected a replaced parent or stage. Never follow
      // that path during cleanup or remove an unfamiliar replacement by name.
      if (created && await ownedStage()) await fs.unlink(stage).catch(() => {});
    }
  });
}

export async function main(args, stream = process.stdin) {
  if (args.length) throw new Error('Supply completion JSON on stdin; see references/completion.md.');
  return recordCompletion(await readInputJSON(stream, 16 * 1024));
}

export function completionFailureMessages(error) {
  const detail = {
    COMPLETION_STATE_UNAVAILABLE: 'Completion marker state is busy, unsafe, unreadable, or changed.',
    COMPLETION_POLICY_CHANGED: 'The selected completion policy changed or is inactive.',
    EACCES: 'Permission denied for completion state.', EPERM: 'Permission denied for completion state.',
    ENOSPC: 'Completion state storage is full.', EIO: 'Completion state storage reported an I/O failure.',
  }[error?.code] ?? 'Completion input or state could not be handled safely.';
  const warnings = Array.isArray(error?.cleanupWarnings) ? error.cleanupWarnings.slice(0, 4) : [];
  return [`Completion was not confirmed. ${detail} Preserve state and finish without retrying.`,
    ...warnings.map(warning => `Lock cleanup needs attention: ${String(warning).replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 500)}`)];
}

if (await isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { for (const message of completionFailureMessages(error)) console.error(message); process.exitCode = 2; }
}
