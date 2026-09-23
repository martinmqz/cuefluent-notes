import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { absolute, within, lstatOrNull, readBoundedBytes } from './file-io.mjs';
import { CLIENTS, configurationPath, hookConfigurationSelection, configSchema, assertCompatibleClients, captureSettings, canonicalSelectedPath, collectionRoot, assertPrivate, assertConfigurationStorage, readConfig } from './capture-policy.mjs';
import { SKILL_ROOT } from './runtime-paths.mjs';

const fail = message => { throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const bytesAt = file => readBoundedBytes(file, { maxBytes: 1024 * 1024 });

async function validateCollectionState(config) {
  const collections = [];
  const routes = [...(config.routes ?? []), ...(config.defaultRoute ? [config.defaultRoute] : [])];
  for (const route of routes) {
    const root = await collectionRoot(route, { allowUnavailable: true });
    const stateDir = await canonicalSelectedPath(route.stateDir);
    for (const existing of collections) {
      if ((within(existing.root, root) || within(root, existing.root)) && existing.stateDir !== stateDir) {
        fail('Routes in the same notes collection or overlapping notes folders must share one state directory.');
      }
    }
    collections.push({ root, stateDir });
  }
}

async function validateChanges(config, previous, client, cwd, file) {
  configSchema(config);
  // Check all routes before activation or storage edits, including defaults and
  // disabled routes. Stopping an existing policy must not require repairing it.
  if (config.enabled || !isDeepStrictEqual(config.routes, previous?.routes) ||
    !isDeepStrictEqual(config.defaultRoute, previous?.defaultRoute)) await validateCollectionState(config);
  const check = async (route, project) => {
    const settings = await captureSettings(client, project ?? cwd, {
      version: config.version, ...(config.version >= 2 ? { minimumPluginVersion: config.minimumPluginVersion } : {}),
      ...(config.version === 3 ? { completionCheck: config.completionCheck } : {}),
      enabled: true, clients: [client], automaticUpdates: false, scope: config.scope,
      ...(project ? { routes: [{ ...route, enabled: true }] } : { defaultRoute: route }),
    });
    assertConfigurationStorage(settings, file);
  };
  if (config.defaultRoute && !isDeepStrictEqual(config.defaultRoute, previous?.defaultRoute)) {
    await check(config.defaultRoute);
  }
  const retained = [...(previous?.routes ?? [])];
  for (const route of config.routes ?? []) {
    // Each old occurrence accounts for one retained route; added copies must
    // undergo the same storage and ambiguity checks as any other new route.
    const index = retained.findIndex(old => isDeepStrictEqual(old, route));
    if (index !== -1) { retained.splice(index, 1); continue; }
    await check(route, route.projectRoot);
    // Detect newly introduced canonical-root ambiguity even outside the caller's
    // project; exclusions and disabled routes must not hide that ambiguity.
    await captureSettings(client, route.projectRoot, { ...config, enabled: true, clients: [client], exclude: [] });
  }
  await captureSettings(client, cwd, config);
}

/** Apply an explicitly reviewed complete policy against its inspected bytes. */
export async function updateConfiguration({ client, cwd, configPath, proposal, expectedHash, confirmCompatibleClients } = {}) {
  if (!CLIENTS.has(client) || !absolute(cwd) || !absolute(proposal) || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) {
    fail('Update requires a supported client, absolute project and proposal paths, and the inspected SHA-256 configuration hash.');
  }
  const requested = configurationPath(configPath);
  const selection = hookConfigurationSelection(requested);
  const file = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  assertPrivate(file, SKILL_ROOT);
  const current = await lstatOrNull(file);
  if (!current?.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    fail('Update requires an existing regular configuration with one hard link; preserve symlinks and inspect them separately.');
  }
  if (await fs.realpath(proposal) === file) fail('Prepare the proposal in a separate private file.');
  const original = await bytesAt(file);
  if (hash(original) !== expectedHash) fail('Configuration changed since inspection; read it again before preparing another update.');
  let previous;
  try { previous = JSON.parse(original); configSchema(previous); }
  catch (error) {
    // Never downgrade a newer policy as though it were malformed old settings.
    if (error.code === 'CONFIG_REQUIRES_UPGRADE') throw error;
    previous = undefined; // A requested repair still requires the exact inspected hash.
  }
  const config = await readConfig(proposal);
  await validateChanges(config, previous, client, cwd, file);
  assertCompatibleClients(config, previous, confirmCompatibleClients);
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  if (bytes.length > 1024 * 1024) fail('Configuration exceeds its supported size.');
  const lockPath = path.join(path.dirname(file), `.${path.basename(file)}.cuefluent-lock`);
  const stage = path.join(path.dirname(file), `.cuefluent-config-${randomUUID()}.tmp`);
  let lock;
  let lockStat;
  let staged = false;
  const unchanged = async () => {
    const now = await lstatOrNull(file);
    if (!sameFile(current, now) || !now.isFile() || now.nlink !== 1 ||
      now.mtimeMs !== current.mtimeMs || now.ctimeMs !== current.ctimeMs ||
      await fs.realpath(requested) !== file || hash(await bytesAt(file)) !== expectedHash) {
      fail('Configuration changed since inspection; it was preserved.');
    }
    if (!sameFile(lockStat, await lstatOrNull(lockPath))) fail('Configuration lock changed; the update was stopped.');
  };
  try {
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') fail('Another configuration update or an interrupted lock needs attention; no settings were changed.');
      throw error;
    }
    lockStat = await lock.stat();
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, expectedHash })}\n`);
    await lock.sync();
    await unchanged();
    if (bytes.equals(original)) return { status: 'unchanged', configPath: file, configHash: expectedHash, ...selection };
    const handle = await fs.open(stage, 'wx', 0o600);
    staged = true;
    try {
      await handle.writeFile(bytes);
      const metadata = await handle.stat();
      if (metadata.uid !== current.uid || metadata.gid !== current.gid) await handle.chown(current.uid, current.gid);
      await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    await unchanged();
    await fs.rename(stage, file);
    staged = false;
    const parent = await fs.open(path.dirname(file), 'r');
    try { await parent.sync(); }
    catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
    finally { await parent.close(); }
    return { status: 'updated', configPath: file, configHash: hash(bytes), ...selection };
  } finally {
    if (staged) await fs.unlink(stage).catch(() => {});
    if (lock) {
      await lock.close();
      if (sameFile(lockStat, await lstatOrNull(lockPath))) await fs.unlink(lockPath);
    }
  }
}
