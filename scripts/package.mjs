import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { within, lstatOrNull as statOrNull, isMain, compare, CONTROLS, readBoundedBytes, sameFileIdentity } from './file-io.mjs';
import { collectionHookConfiguration } from './collection-hook-definition.mjs';
import { validatePluginManifest, validateManifestPair, validateProcessingMcp } from './plugin-manifest.mjs';
import { SOURCE_FILES } from './package-inputs.mjs';
import { withPackageInventory, packagePath } from './package-integrity.mjs';

const SOURCE_ROOT = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', '.github', '.hg', '.svn', 'test', 'tests', '__tests__', '__mocks__', 'coverage', 'benchmark', 'benchmarks', 'scripts']);
const EXCLUDED_FILES = /^(?:\.DS_Store|\.npmignore|\.gitignore|\.travis\.yml|Makefile|(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)|(?:tsconfig(?:\.[^.]+)?\.json)|(?:(?:rollup|webpack|vite|eslint|jest|vitest|babel)\.config\..+)|\.(?:eslint|babel|prettier|nyc|mocha)rc(?:\..+)?)$/;
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sortedEntries = value => Object.entries(value ?? {}).sort(([a], [b]) => compare(a, b));
const equalMap = (left, right) => JSON.stringify(sortedEntries(left)) === JSON.stringify(sortedEntries(right));
const asJSON = value => `${JSON.stringify(value, null, 2)}\n`;

async function regularSource(relative) {
  packagePath(relative);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) fail('Invalid package source path.');
  let current = SOURCE_ROOT;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await statOrNull(current);
    if (!stat || stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail(`Missing or nonportable package input: ${relative}`);
  }
  return current;
}
/** Read bounded package inputs without links; check first-party files for checkout leaks. */
export async function readPortableSource(relative) {
  const file = await regularSource(relative);
  const before = await fs.lstat(file, { bigint: true });
  const bytes = await readBoundedBytes(file, { noFollow: true, utf8: false, maxBytes: 16 * 1024 * 1024 });
  await regularSource(relative);
  const after = await fs.lstat(file, { bigint: true });
  if (!sameFileIdentity(before, after) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('Package input changed during read.');
  // Dependencies may legitimately contain strings such as /src or /app that
  // coincide with a short checkout path. The leak scan is first-party only.
  if (!relative.startsWith('node_modules/') && bytes.toString('utf8').includes(SOURCE_ROOT)) fail(`Portable source input contains an absolute checkout path: ${relative}`);
  return bytes;
}
async function readJSON(relative, read = readPortableSource) {
  let value;
  try { value = JSON.parse(await read(relative)); }
  catch { fail(`Invalid package JSON: ${relative}`); }
  if (!object(value)) fail(`Package JSON must contain an object: ${relative}`);
  return value;
}
function modulePath(value) {
  return /^(?:node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(value) && !value.split('/').some(part => ['.', '..'].includes(part));
}
function resolveDependency(packages, parent, name) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) fail('Unsupported dependency name in the lockfile.');
  let directory = parent;
  for (;;) {
    if (path.posix.basename(directory) !== 'node_modules') {
      const candidate = `${directory ? `${directory}/` : ''}node_modules/${name}`;
      if (packages[candidate]) return candidate;
    }
    if (!directory) break;
    directory = path.posix.dirname(directory);
    if (directory === '.') directory = '';
  }
  fail('The lockfile does not contain the complete runtime dependency closure.');
}
async function runtimeDependencies(pkg, lock, read) {
  if (lock.lockfileVersion !== 3 || !object(lock.packages) || !object(lock.packages['']) ||
    lock.name !== pkg.name || lock.version !== pkg.version || lock.packages[''].version !== pkg.version || lock.packages[''].license !== pkg.license ||
    !equalMap(pkg.dependencies, lock.packages[''].dependencies)) fail('Package metadata and lockfile disagree; refresh the source dependencies before building.');
  if (!object(pkg.dependencies) || !Object.keys(pkg.dependencies).length ||
    Object.values(pkg.dependencies).some(version => !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))) fail('Top-level runtime dependencies must use exact pinned versions.');
  const selected = new Map();
  const queue = Object.entries(pkg.dependencies).map(([name, version]) => ({ key: resolveDependency(lock.packages, '', name), name, directVersion: version }));
  while (queue.length) {
    const { key, name, directVersion } = queue.shift();
    if (selected.has(key)) continue;
    const record = lock.packages[key];
    if (!modulePath(key) || !object(record) || record.link || record.dev || record.optional ||
      typeof record.version !== 'string' || typeof record.integrity !== 'string' ||
      !record.resolved?.startsWith('https://') || (directVersion && directVersion !== record.version)) fail('The runtime lock contains an unsupported, unpinned or linked dependency.');
    const installed = await readJSON(`${key}/package.json`, read);
    if (installed.name !== name || installed.version !== record.version || !equalMap(installed.dependencies, record.dependencies) ||
      Object.keys(installed.optionalDependencies ?? {}).length || Object.keys(installed.peerDependencies ?? {}).length) fail(`Installed dependency does not match the supported locked runtime: ${name}`);
    selected.set(key, record);
    for (const dependency of Object.keys(record.dependencies ?? {})) queue.push({ key: resolveDependency(lock.packages, key, dependency), name: dependency });
  }
  return [...selected.entries()].sort(([a], [b]) => compare(a, b));
}
async function dependencyFiles(relativeRoot) {
  const files = [];
  let licenses = 0;
  async function visit(relative) {
    const absolute = path.join(SOURCE_ROOT, relative);
    for (const entry of (await fs.readdir(absolute, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`Runtime dependencies must not contain symlinks: ${relativeRoot}`);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(child);
      } else if (entry.isFile()) {
        if (EXCLUDED_FILES.test(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
        if (/^(?:LICEN[CS]E|COPYING|NOTICE)(?:[.-]|$)/i.test(entry.name)) licenses++;
        files.push(child);
      } else fail(`Runtime dependency contains a nonportable file: ${relativeRoot}`);
    }
  }
  await visit(relativeRoot);
  if (!licenses) fail(`Runtime dependency is missing its license notice: ${relativeRoot}`);
  return files;
}
async function writeNew(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o644 });
  await fs.chmod(file, 0o644);
}
function outputPlacement(output) {
  if (within(output, SOURCE_ROOT) || ['node_modules', 'scripts', 'references', 'examples', 'packaging', '.git'].some(part => within(path.join(SOURCE_ROOT, part), output))) fail('Choose a fresh output directory outside package source inputs.');
}
async function canonicalOutput(requested) {
  const missing = [];
  let ancestor = path.dirname(requested);
  while (!await statOrNull(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('Cannot resolve output parent.');
    ancestor = parent;
  }
  const canonical = await fs.realpath(ancestor);
  if (!(await fs.stat(canonical)).isDirectory()) fail('Output parent must resolve to a directory.');
  return path.join(canonical, ...missing, path.basename(requested));
}
export function packageReadme(client, version, withHooks) {
  return `# Cuefluent Notes ${version}\n\n${client === 'codex' ? 'Codex' : 'Claude Code'} plugin, ${withHooks ? 'optional hook-enabled' : 'manual'} package. Requires Node.js 22 or later on the host PATH. Runtime dependencies and their license notices are included.\n\nSource-available under the [Sustainable Use License 1.0](LICENSE.md). See the [licensing summary](skills/cuefluent-notes/README.md#license) for permitted use and the scope of the license.\n\nFor a fresh installation or an upgrade from v0.7.1 or earlier, start a fresh task and ask **Set up Cuefluent Notes** to choose collection and processing separately. Existing workflow users must follow the [coordinated upgrade steps](skills/cuefluent-notes/references/setup.md#existing-settings) before updating clients that share storage; preserve existing settings and paths. Read the [setup guide](skills/cuefluent-notes/references/setup.md), [usage guide](skills/cuefluent-notes/README.md), and [distribution instructions](skills/cuefluent-notes/references/distribution.md). Building or copying this package does not install or trust it. ${withHooks ? 'Session collection remains disabled without a separate private configuration and client trust.' : 'This package has no hook registration.'}\n`;
}

/** Build local, fresh plugin directories. Never installs, registers or trusts a plugin. */
export async function buildPackages({ outDir, withHooks = false, clients = ['codex', 'claude'] } = {}) {
  if (typeof withHooks !== 'boolean' || (outDir !== undefined && (typeof outDir !== 'string' || !outDir.trim() || CONTROLS.test(outDir)))) fail('Use a valid output directory and boolean withHooks.');
  if (!Array.isArray(clients) || !clients.length || clients.some(client => !['codex', 'claude'].includes(client)) || new Set(clients).size !== clients.length) fail('Choose one or both distinct supported clients: codex, claude.');
  clients = [...clients];
  const requested = path.resolve(outDir ?? path.join(SOURCE_ROOT, 'dist', withHooks ? 'hooks' : 'manual'));
  if (await statOrNull(requested)) fail('Output directory already exists; choose a fresh --out directory.');
  outputPlacement(requested);
  const output = await canonicalOutput(requested);
  outputPlacement(output);
  if (await statOrNull(output)) fail('Output directory already exists; choose a fresh --out directory.');
  // Capture each input once: validation and both clients consume the same bytes.
  const inputs = new Map();
  let inputBytes = 0;
  const read = async relative => {
    if (!inputs.has(relative)) {
      const bytes = await readPortableSource(relative);
      inputBytes += bytes.length;
      if (inputBytes > 128 * 1024 * 1024 || inputs.size >= 4096) fail('Package inputs exceed the build size limit.');
      inputs.set(relative, bytes);
    }
    return inputs.get(relative);
  };
  const pkg = await readJSON('package.json', read);
  const lock = await readJSON('package-lock.json', read);
  if (pkg.name !== 'cuefluent-notes' || pkg.private !== true || pkg.type !== 'module' || pkg.engines?.node !== '>=22') fail('Unexpected package identity or runtime requirements.');
  if (pkg.license !== 'SEE LICENSE IN LICENSE.md') fail('Package license must reference LICENSE.md.');
  const license = await read('LICENSE.md');
  const dependencies = await runtimeDependencies(pkg, lock, read);
  const dependencyInputs = [];
  for (const [key] of dependencies) dependencyInputs.push(...await dependencyFiles(key));
  for (const source of [...SOURCE_FILES, ...dependencyInputs]) await read(source);
  const manifests = new Map();
  const mcpConfigurations = new Map();
  for (const client of ['codex', 'claude']) {
    const manifest = await readJSON(`packaging/${client}/plugin.json`, read);
    validatePluginManifest(manifest, client);
    if (manifest.license !== 'LicenseRef-Sustainable-Use-1.0') fail('Plugin templates must declare the Sustainable Use license.');
    if (manifest.version !== pkg.version) fail('Plugin templates must match the package version.');
    if (manifest.mcpServers !== './.mcp.json') fail('Plugin templates must declare the bundled processing controller.');
    manifests.set(client, manifest);
    const mcp = await readJSON(`packaging/${client}/mcp.json`, read);
    validateProcessingMcp(mcp, client);
    mcpConfigurations.set(client, mcp);
  }
  validateManifestPair(manifests.get('codex'), manifests.get('claude'));
  const runtimePackage = { name: pkg.name, version: pkg.version, private: true, type: 'module', license: pkg.license, description: pkg.description, engines: pkg.engines, dependencies: pkg.dependencies };
  const runtimeLock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: pkg.name, version: pkg.version, license: pkg.license, dependencies: pkg.dependencies, engines: pkg.engines }, ...Object.fromEntries(dependencies) } };
  const canonicalParent = path.dirname(output);
  await fs.mkdir(canonicalParent, { recursive: true });
  if (await fs.realpath(canonicalParent) !== canonicalParent) fail('Output parent changed while preparing the build.');
  if (await statOrNull(output)) fail('Output directory already exists; choose a fresh --out directory.');
  const staging = await fs.mkdtemp(path.join(canonicalParent, '.cuefluent-package-'));
  let claimedOutput = false;
  try {
    for (const client of clients) {
      const root = path.join(staging, client, pkg.name);
      const skillRoot = `skills/${pkg.name}`;
      const files = [...SOURCE_FILES, ...dependencyInputs].map(source => ({ name: `${skillRoot}/${source}`, bytes: inputs.get(source) }));
      const add = (name, bytes) => files.push({ name, bytes: Buffer.from(bytes) });
      add(`${skillRoot}/package.json`, asJSON(runtimePackage));
      add(`${skillRoot}/package-lock.json`, asJSON(runtimeLock));
      add(`.${client}-plugin/plugin.json`, asJSON(manifests.get(client)));
      add('.mcp.json', asJSON(mcpConfigurations.get(client)));
      add('LICENSE.md', license);
      if (withHooks) add('hooks/hooks.json', asJSON(collectionHookConfiguration(client)));
      add('README.md', packageReadme(client, pkg.version, withHooks));
      for (const file of withPackageInventory(files, { client, version: pkg.version, withHooks })) await writeNew(path.join(root, file.name), file.bytes);
    }
    // Exclusive reservation prevents two builders from publishing over an existing result.
    try { await fs.mkdir(output); claimedOutput = true; }
    catch (error) { if (error.code === 'EEXIST') fail('Output directory already exists; choose a fresh --out directory.'); throw error; }
    for (const client of clients) await fs.rename(path.join(staging, client), path.join(output, client));
    return { outDir: output, packages: clients.map(client => {
      const root = path.join(output, client, pkg.name);
      return { client, root, skillRoot: path.join(root, 'skills', pkg.name), withHooks };
    }) };
  } catch (error) {
    if (claimedOutput) await fs.rm(output, { recursive: true, force: true });
    throw error;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/package.mjs [--hooks] [--out fresh-directory]\nBuilds Codex and Claude plugin directories from an explicit source allowlist and installed pinned runtime dependencies. No network, installation, trust or publishing.');
    return 0;
  }
  let withHooks = false;
  let outDir;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--hooks' && !withHooks) withHooks = true;
    else if (args[index] === '--out' && outDir === undefined && args[index + 1] && !args[index + 1].startsWith('--')) outDir = args[++index];
    else fail('Unknown or incomplete option; use --help.');
  }
  console.log(JSON.stringify(await buildPackages({ outDir, withHooks }), null, 2));
  return 0;
}
if (await isMain(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`Package build failed: ${String(error.message).slice(0, 500)}`); process.exitCode = 2; }
}
