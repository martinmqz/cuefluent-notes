// Real CLI registration checks, with no authentication, model calls or hook trust.
// Run explicitly: node scripts/client-smoke.mjs (downloads pinned client CLIs).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnCommand } from './command.mjs';
import { smokeEnvironment } from './smoke-environment.mjs';
import { MARKETPLACE_PATHS } from './marketplace-layout.mjs';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-clients-')));
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function profile(directory, pinnedPath) {
  const env = smokeEnvironment(directory);
  if (pinnedPath) env.PATH = pinnedPath;
  for (const dir of [env.HOME, env.TMPDIR, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(directory, 'empty.gitconfig');
  for (const file of [env.npm_config_userconfig, env.npm_config_globalconfig, env.GIT_CONFIG_GLOBAL]) await fs.writeFile(file, '');
  return env;
}
try {
  const marketplacePaths = [];
  for (const relative of MARKETPLACE_PATHS) {
    try { await fs.lstat(path.join(source, relative)); marketplacePaths.push(relative); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(marketplacePaths.length === 0 || marketplacePaths.length === MARKETPLACE_PATHS.length,
    'A published marketplace must contain every managed path.');
  const hasMarketplace = marketplacePaths.length !== 0;
  let env = await profile(root);
  const home = env.HOME;
  const tools = path.join(root, 'clients');
  const checkout = path.join(root, 'checkout');
  const run = (command, args, options = {}) => {
    const result = spawnCommand(command, args, { env, cwd: options.cwd ?? env.HOME,
      encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `${command}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  await fs.cp(path.join(source, 'scripts/client-fixture'), tools, { recursive: true });
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tools });
  // Build in a disposable checkout, never mutate the developer's dependencies.
  for (const name of ['scripts', 'packaging', 'references', 'examples', 'SKILL.md', 'README.md', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes']) {
    await fs.cp(path.join(source, name), path.join(checkout, name), {
      recursive: true, filter: file => path.basename(file) !== 'node_modules',
    });
  }
  // Include released catalogs and packages when this checkout publishes them.
  for (const relative of marketplacePaths) {
    await fs.cp(path.join(source, relative), path.join(checkout, relative), { recursive: true });
  }
  const git = args => run('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: checkout });
  git(['init', '--initial-branch=main']);
  git(['add', '.']);
  if (hasMarketplace) git(['add', '-f', '--', ...marketplacePaths]);
  git(['-c', 'user.name=Client Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'test: seed complete source checkout']);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout });
  // Claude's npm entry is a placeholder until postinstall copies this locked
  // optional binary. Select that binary directly without executing postinstall.
  const libc = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : '';
  const claudeBin = path.join(tools, `node_modules/@anthropic-ai/claude-code-${process.platform}-${process.arch}${libc}`);
  env.PATH = [claudeBin, path.join(tools, 'node_modules/.bin'), env.PATH ?? ''].join(path.delimiter);
  for (const client of ['codex', 'claude']) {
    const cli = client === 'claude' ? path.join(claudeBin, `claude${process.platform === 'win32' ? '.exe' : ''}`)
      : path.join(tools, 'node_modules/.bin', `codex${process.platform === 'win32' ? '.cmd' : ''}`);
    const version = run(cli, ['--version']).trim();
    const list = () => {
      const value = JSON.parse(run(cli, ['plugin', 'list', '--json']));
      return client === 'codex' ? value.installed : value;
    };
    assert.deepEqual(list(), [], 'Disposable client profile must start empty.');
    // Use the public CLI and default runner, including bare-command pinning.
    const args = [path.join(checkout, 'scripts/install.mjs'), '--client', client];
    run(process.execPath, args, { cwd: checkout });
    const second = run(process.execPath, args, { cwd: checkout });
    assert.match(second, /Previous package preserved at/, 'Repeat installation must retain the previous package.');
    assert.equal(list().length, 1, 'Repeat installation must keep one registration.');
    const destination = path.join(home, client === 'codex' ? 'plugins' : '.claude/skills', 'cuefluent-notes');
    const verifyHelpers = async plugin => {
      const skill = path.join(plugin, 'skills/cuefluent-notes');
      const checker = JSON.parse(run(process.execPath, [path.join(skill, 'scripts/check-notes.mjs'), path.join(skill, 'examples/decision.md')]));
      assert.equal(checker.errors, 0);
      const status = JSON.parse(run(process.execPath, [path.join(skill, 'scripts/workflow.mjs'), 'status']));
      assert.equal(status.configHash, null);
      assert.equal(status.runtime.hookRegistration, 'packaged');
      await assert.rejects(fs.stat(env.CUEFLUENT_WORKFLOW_CONFIG), { code: 'ENOENT' });
    };
    const sourceEntry = list()[0];
    assert.equal(client === 'codex' ? sourceEntry.pluginId : sourceEntry.id,
      `cuefluent-notes@${client === 'codex' ? 'personal' : 'skills-dir'}`);
    await verifyHelpers(destination);
    console.log(JSON.stringify({ platform: process.platform, client, version, freshInstall: true,
      repeatUpdate: true, registrations: 1, capture: 'unconfigured', liveModel: false }));

    if (!hasMarketplace) {
      console.log(JSON.stringify({ platform: process.platform, client,
        marketplaceInstall: 'skipped', reason: 'No published marketplace package in this source checkout.' }));
      continue;
    }

    // A separate profile exercises the committed main catalog and the one-time
    // remove/re-add migration. Never alter the source-installer registration.
    const installerEnv = env;
    env = await profile(path.join(root, `marketplace-${client}`), installerEnv.PATH);
    const marketplace = path.join(root, `catalog-${client}`);
    for (const relative of MARKETPLACE_PATHS) {
      await fs.cp(path.join(source, relative), path.join(marketplace, relative), { recursive: true });
    }
    const release = JSON.parse(await fs.readFile(path.join(marketplace, 'release.json'), 'utf8'));
    const verifyMarketplaceInstall = async () => {
      const installed = list();
      assert.equal(installed.length, 1, 'Marketplace registration must identify exactly one plugin.');
      const entry = installed[0];
      assert.equal(client === 'codex' ? entry.pluginId : entry.id, 'cuefluent-notes@cuefluent');
      assert.equal(entry.version, release.version);
      assert.equal(entry.enabled, true);
      // Codex's pinned CLI reports the source path, not its cached install path.
      const installedRoot = client === 'codex'
        ? path.join(env.CODEX_HOME, 'plugins/cache/cuefluent/cuefluent-notes', entry.version)
        : entry.installPath;
      const manifest = JSON.parse(await fs.readFile(path.join(installedRoot, `.${client}-plugin/plugin.json`), 'utf8'));
      assert.equal(manifest.name, 'cuefluent-notes'); assert.equal(manifest.version, release.version);
      await verifyHelpers(installedRoot);
    };
    const addCatalog = () => run(cli, ['plugin', 'marketplace', 'add', marketplace,
      ...(client === 'claude' ? ['--scope', 'user'] : [])]);
    const addPlugin = () => run(cli, ['plugin', client === 'codex' ? 'add' : 'install',
      'cuefluent-notes@cuefluent', ...(client === 'claude' ? ['--scope', 'user'] : [])]);
    assert.deepEqual(list(), []);
    addCatalog();
    addPlugin();
    await verifyMarketplaceInstall();
    run(cli, ['plugin', 'marketplace', 'remove', 'cuefluent',
      ...(client === 'claude' ? ['--scope', 'user'] : [])]);
    addCatalog();
    addPlugin();
    await verifyMarketplaceInstall();
    console.log(JSON.stringify({ platform: process.platform, client, marketplaceInstall: true,
      marketplaceReregistration: true, capture: 'unconfigured', liveModel: false }));
    env = installerEnv;
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
