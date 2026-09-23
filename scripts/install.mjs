import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnCommand, resolveCommand } from './command.mjs';
import { buildPackages } from './package.mjs';
import { absolute, isMain, lstatOrNull, readBoundedBytes, sameFileIdentity } from './file-io.mjs';

const SOURCE = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const NAME = 'cuefluent-notes';
const MARKER = '.cuefluent-installer.json';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = message => { throw new Error(message); };

// Brief Windows sharing violations may clear after scanning finishes. Preserve
// both selected entries on every retry; never retry a conflict or steal a path.
export async function renameInstalledPath(source, destination, { replace = false, beforeRename = async () => {} } = {}) {
  const original = await fs.lstat(source, { bigint: true });
  const previous = await lstatOrNull(destination, { bigint: true });
  if (previous && !replace) fail('Installation destination appeared before rename; it was preserved.');
  for (let attempt = 0; ; attempt++) {
    await directories(path.dirname(source));
    await directories(path.dirname(destination));
    const current = await lstatOrNull(destination, { bigint: true });
    if (!sameFileIdentity(original, await lstatOrNull(source, { bigint: true })) ||
      (previous ? !sameFileIdentity(previous, current) : current !== null)) fail('Installation path changed during rename; preserve it and inspect before retrying.');
    await beforeRename();
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
      await delay(50 * 2 ** attempt);
    }
  }
}

// Resolve an explicitly selected home or reported location, including a missing
// suffix beneath an existing OS/dotfiles alias. Write targets below it still
// pass directories() and managedDestination(), which refuse linked targets.
async function canonicalDirectory(requested) {
  const missing = [];
  let ancestor = path.resolve(requested);
  while (!await lstatOrNull(ancestor)) {
    missing.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const canonical = await fs.realpath(ancestor);
  if (!(await fs.stat(canonical)).isDirectory()) fail(`Expected a directory: ${requested}`);
  return path.join(canonical, ...missing);
}

async function acquireInstallLock(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail(`Another install is running, or an interrupted install left ${directory}. Inspect ${path.join(directory, 'owner.json')} for its pid, hostname and start time. Remove the lock only after confirming that installer has stopped.`);
    throw error;
  }
  const identity = await fs.lstat(directory, { bigint: true });
  const ownerFile = path.join(directory, 'owner.json');
  const ownerBytes = Buffer.from(json({ pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), token: randomUUID() }));
  const sameDirectory = async () => {
    const current = await fs.lstat(directory, { bigint: true });
    return current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino && current.birthtimeNs === identity.birthtimeNs;
  };
  try { await fs.writeFile(ownerFile, ownerBytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    try { if (await sameDirectory()) await fs.rmdir(directory); } catch { /* Preserve unfamiliar or incomplete owner metadata. */ }
    error.message = `Could not record the installer lock owner at ${ownerFile}: ${error.message}. Inspect the lock before retrying.`;
    throw error;
  }
  return async () => {
    if (!await sameDirectory()) fail('Lock directory ownership changed; leave it for inspection.');
    const current = await readFile(ownerFile);
    if (current !== null) {
      if (!current.equals(ownerBytes)) fail('Lock owner metadata changed; leave it for inspection.');
      if (!await sameDirectory()) fail('Lock directory ownership changed; leave it for inspection.');
      await fs.unlink(ownerFile);
    }
    if (!await sameDirectory()) fail('Lock directory ownership changed; leave it for inspection.');
    await fs.rmdir(directory);
  };
}

// Inspect each component before creating directories or writing through them.
async function directories(directory, create = false) {
  const parent = path.dirname(directory);
  if (parent !== directory) await directories(parent, create);
  const stat = await lstatOrNull(directory);
  if (stat && !stat.isDirectory()) fail(`Expected an ordinary directory, not a link or file: ${directory}`);
  if (!stat && create) {
    try { await fs.mkdir(directory); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await directories(directory);
    }
  }
}
async function readFile(file) {
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1) fail(`Expected an ordinary, unlinked file: ${file}`);
  return readBoundedBytes(file);
}
async function unchanged(file, expected) {
  const actual = await readFile(file);
  if (actual === null ? expected !== null : expected === null || !actual.equals(expected)) {
    fail(`File changed during installation; retry after other edits finish: ${file}`);
  }
}
async function catalogAt(file) {
  const bytes = await readFile(file);
  let catalog;
  try { catalog = bytes === null ? { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] } : JSON.parse(bytes); }
  catch { fail(`Invalid personal marketplace JSON; repair it before installing: ${file}`); }
  if (!catalog || typeof catalog.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(catalog.name) || !Array.isArray(catalog.plugins) ||
    catalog.plugins.some(entry => !entry || typeof entry.name !== 'string') ||
    new Set(catalog.plugins.map(entry => entry.name)).size !== catalog.plugins.length) {
    fail(`Invalid personal marketplace; repair it before installing: ${file}`);
  }
  const existing = catalog.plugins.find(entry => entry.name === NAME);
  if (existing && (existing.source?.source !== 'local' || existing.source.path !== `./plugins/${NAME}`)) {
    fail(`Cuefluent Notes already has a different source in ${file}; update that installation instead.`);
  }
  if (!existing) catalog.plugins.push({ name: NAME, source: { source: 'local', path: `./plugins/${NAME}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
  const mode = bytes === null ? 0o600 : (await fs.lstat(file)).mode & 0o777;
  if (!existing && process.platform === 'win32' && !(mode & 0o200)) fail('The personal marketplace is read-only; review its permissions before installing. No package was moved.');
  return { bytes, catalog, changed: !existing, mode };
}
async function managedDestination(destination, client) {
  const stat = await lstatOrNull(destination);
  if (!stat) return false;
  if (!stat.isDirectory()) fail(`Installation destination is a link or file: ${destination}`);
  const marker = await readFile(path.join(destination, MARKER));
  let owner;
  try { owner = marker && JSON.parse(marker); } catch { /* Report the same actionable conflict. */ }
  if (owner?.schema !== 1 || owner.name !== NAME || owner.client !== client) {
    fail(`An existing installation is not managed by this installer: ${destination}. Keep or move it aside before installing; do not install a duplicate.`);
  }
  return true;
}
function command(executable, args, { capture = false, cwd = SOURCE } = {}) {
  const result = spawnCommand(executable, args, { cwd, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxBuffer: 8 * 1024 * 1024 });
  if (result.error?.code === 'ENOENT') fail(`Cannot find ${executable}. Install the current client/Node.js CLI, or select the client executable with --cli /absolute/path.`);
  if (result.error || result.status !== 0) fail(`${executable} ${args.join(' ')} failed${result.status === null ? '' : ` (exit ${result.status})`}. ${result.error?.message ?? (result.stdout?.trim().slice(0, 1000) || 'See the command output above.')}`);
  return result.stdout ?? '';
}
function installedPlugins(output, client) {
  let list;
  try { const parsed = JSON.parse(output); list = client === 'codex' ? parsed.installed : parsed; }
  catch { fail('Cannot read the client plugin list. Update the client and retry.'); }
  if (!Array.isArray(list) || list.some(entry => !entry || typeof (client === 'codex' ? entry.pluginId : entry.id) !== 'string')) {
    fail('Unsupported client plugin list. Update the client and retry.');
  }
  return list;
}

/** Source-checkout installer. Injectable paths/runner let tests use disposable homes without changing HOME. */
export async function installPlugin({ client, withHooks = true, cli = client, homeDirectory = os.homedir(),
  codexDirectory = process.env.CODEX_HOME, claudeDirectory = process.env.CLAUDE_CONFIG_DIR,
  checkoutLockDirectory = path.join(SOURCE, 'dist', '.install-lock'),
  run = command, log = console.log, warn = console.error } = {}) {
  if (!['codex', 'claude'].includes(client) || typeof withHooks !== 'boolean' || typeof cli !== 'string' || !cli.trim()) fail('Choose --client codex or --client claude.');
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Node.js 22 or later is required.');
  if (codexDirectory === '') codexDirectory = undefined;
  if (claudeDirectory === '') claudeDirectory = undefined;
  if (cli.includes(path.sep) || (process.platform === 'win32' && cli.includes('/'))) cli = path.resolve(cli);
  if (run === command) {
    try { cli = resolveCommand(cli); }
    catch (error) {
      if (error.code === 'ENOENT') fail(`Cannot find ${cli}. Install the current client/Node.js CLI, or select the client executable with --cli /absolute/path.`);
      throw error;
    }
  }
  const configuredDirectory = client === 'codex' ? codexDirectory : claudeDirectory;
  if (!absolute(homeDirectory) || (configuredDirectory !== undefined && !absolute(configuredDirectory))) fail('Client home directories must be absolute paths.');
  if (!absolute(checkoutLockDirectory)) fail('The checkout lock directory must be an absolute path.');
  const userDirectory = await fs.realpath(homeDirectory);
  const claudeRoot = client === 'claude' ? await canonicalDirectory(claudeDirectory ?? path.join(userDirectory, '.claude')) : null;
  const parent = client === 'codex' ? path.join(userDirectory, 'plugins') : path.join(claudeRoot, 'skills');
  const destination = path.join(parent, NAME);
  const catalogFile = path.join(userDirectory, '.agents/plugins/marketplace.json');
  const workspace = path.join(client === 'codex' ? parent : claudeRoot, '.cuefluent-installer');
  await directories(parent);
  await directories(workspace);
  if (client === 'codex') await directories(path.dirname(catalogFile));
  const catalog = client === 'codex' ? await catalogAt(catalogFile) : null;
  const updating = await managedDestination(destination, client);
  const identity = `${NAME}@${catalog?.catalog.name ?? 'skills-dir'}`;
  const installed = installedPlugins(await run(cli, ['plugin', 'list', '--json'], { capture: true, cwd: userDirectory }), client);
  for (const entry of installed) {
    const id = client === 'codex' ? entry.pluginId : entry.id;
    if (id.split('@')[0] !== NAME) continue;
    const source = client === 'codex' ? entry.source?.path : entry.installPath;
    if (source && !absolute(source)) fail('The client reported an invalid plugin location. Update the client and retry.');
    if (id !== identity || (source && await canonicalDirectory(source) !== destination)) fail(`Cuefluent Notes is already installed as ${id} from another location. Update or uninstall that copy before using this installer.`);
  }
  if (client === 'codex') {
    for (const root of [path.join(userDirectory, '.agents'), codexDirectory ?? path.join(userDirectory, '.codex')]) {
      const skill = path.join(root, 'skills', NAME);
      if (await lstatOrNull(skill)) fail(`A standalone Cuefluent Notes skill already exists at ${skill}. Move it aside before installing the full plugin.`);
    }
  }

  // One lock per checkout protects npm ci and package building as well as publication.
  const lock = checkoutLockDirectory;
  await directories(path.dirname(lock), true);
  const releaseCheckoutLock = await acquireInstallLock(lock);
  let work;
  let backup;
  let result;
  let failure;
  let failed = false;
  const cleanupWarnings = [];
  const cleanup = async (file, remove) => {
    try { await remove(); }
    catch (error) {
      cleanupWarnings.push(`Cleanup could not remove ${file} (${String(error?.code ?? error?.message ?? error).slice(0, 200)}). Inspect this leftover before retrying; remove a lock only when no installer is running.`);
    }
  };
  try {
    // Different checkouts can target the same user installation.
    await directories(workspace, true);
    const userLock = path.join(workspace, 'lock');
    const releaseUserLock = await acquireInstallLock(userLock);
    try {
      log('Installing locked build dependencies…');
      await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
      work = await fs.mkdtemp(path.join(workspace, 'install-'));
      log(`Building the ${client === 'codex' ? 'Codex' : 'Claude Code'} plugin…`);
      const built = await buildPackages({ outDir: path.join(work, 'packages'), withHooks, clients: [client] });
      const selected = built.packages.find(pkg => pkg.client === client);
      if (client === 'codex') {
        const manifestPath = path.join(selected.root, '.codex-plugin/plugin.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        manifest.version = `${manifest.version.split('+')[0]}+codex.${Date.now()}.${randomUUID().replaceAll('-', '')}`;
        await fs.writeFile(manifestPath, json(manifest));
      } else {
        await run(cli, ['plugin', 'validate', '--strict', '--json', selected.root], { capture: true });
      }
      await fs.writeFile(path.join(selected.root, MARKER), json({ schema: 1, name: NAME, client }), { flag: 'wx' });
      await directories(parent, true);
      if (catalog) {
        await directories(path.dirname(catalogFile), true);
        await unchanged(catalogFile, catalog.bytes);
        await catalogAt(catalogFile); // Recheck read-only status before moving the package.
      }
      if (await managedDestination(destination, client) !== updating) fail('Installation destination changed; retry after other changes finish.');
      if (updating) {
        backup = path.join(work, 'previous');
        log(`Preserving the previous package at ${backup}…`);
        await renameInstalledPath(destination, backup);
      }
      try { await renameInstalledPath(selected.root, destination); }
      catch (error) {
        if (backup) {
          try { await renameInstalledPath(backup, destination); backup = undefined; }
          catch (restoreError) {
            error.backupPath = backup;
            error.rollbackError = restoreError;
            warn(`Could not restore the previous package: ${restoreError.message}. The backup remains at ${backup}. Inspect it and ${destination} before retrying.`);
          }
        }
        throw error;
      }
      if (catalog?.changed) {
        const stagedCatalog = path.join(path.dirname(catalogFile), `.cuefluent-${randomUUID()}.json`);
        try {
          await fs.writeFile(stagedCatalog, json(catalog.catalog), { flag: 'wx', mode: catalog.mode });
          await fs.chmod(stagedCatalog, catalog.mode);
          await unchanged(catalogFile, catalog.bytes);
          if (catalog.bytes === null) await fs.link(stagedCatalog, catalogFile);
          else await renameInstalledPath(stagedCatalog, catalogFile, { replace: true, beforeRename: () => unchanged(catalogFile, catalog.bytes) });
        } finally { await cleanup(stagedCatalog, () => fs.rm(stagedCatalog, { force: true })); }
      }
      if (client === 'codex') {
        log(`Registering ${identity}…`);
        try { await run(cli, ['plugin', 'add', identity]); }
        catch (error) { fail(`Package prepared at ${destination}, but Codex registration failed. Rerun the same installer to retry. ${error.message}`); }
      }
      log(`Installed ${identity} at ${destination}.`);
      if (backup) log(`Previous package preserved at ${backup}.`);
      log(withHooks ? 'Start a new session, review the plugin hooks in your client, and say: Set up Cuefluent Notes.'
        : 'Start a new session and say: Set up Cuefluent Notes. This package contains no hooks.');
      log('Capture settings were not changed. Without a saved capture choice, automatic capture stays off.');
      result = { client, destination, identity, backup: backup ?? null, withHooks };
    } finally { await cleanup(userLock, releaseUserLock); }
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    if (work) {
      const packages = path.join(work, 'packages');
      await cleanup(packages, () => fs.rm(packages, { recursive: true, force: true }));
      if (!backup) await cleanup(work, () => fs.rmdir(work));
    }
    await cleanup(lock, releaseCheckoutLock);
  }
  for (const warning of cleanupWarnings) warn(`Warning: ${warning}`);
  if (failed) {
    if (cleanupWarnings.length && failure instanceof Error && Object.isExtensible(failure)) failure.cleanupWarnings = cleanupWarnings;
    throw failure;
  }
  return cleanupWarnings.length ? { ...result, cleanupWarnings } : result;
}

export async function main(args) {
  if ((args.length === 1 && args[0] === '--help') ||
    (args.length === 3 && args[0] === '--client' && ['codex', 'claude'].includes(args[1]) && args[2] === '--help')) {
    console.log('Usage: node scripts/install.mjs --client codex|claude [--manual] [--cli executable]\nInstalls locked dependencies, builds, and installs for the current user. Defaults to hooks. --manual omits hooks. Repeat runs update installer-managed packages and keep the previous package. No hook trust or capture settings are changed.');
    return 0;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manual' && options.withHooks === undefined) options.withHooks = false;
    else if (['--client', '--cli'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const key = args[i].slice(2);
      if (options[key] !== undefined) fail('Repeated option; use --help.');
      options[key] = args[++i];
    } else fail('Unknown or incomplete option; use --help.');
  }
  await installPlugin(options);
  return 0;
}
if (await isMain(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`Installation failed: ${String(error.message).slice(0, 1500)}`); process.exitCode = 2; }
}
