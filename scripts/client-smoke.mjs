// Real CLI registration checks, with no authentication, model calls or hook trust.
// Run explicitly: node scripts/client-smoke.mjs (downloads pinned client CLIs).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnCommand } from './command.mjs';
import { smokeEnvironment } from './smoke-environment.mjs';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-clients-')));
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const env = smokeEnvironment(root);
  const home = env.HOME;
  const tools = path.join(root, 'clients');
  const checkout = path.join(root, 'checkout');
  await fs.mkdir(home);
  await fs.mkdir(env.TMPDIR);
  await fs.writeFile(env.npm_config_userconfig, '');
  await fs.writeFile(env.npm_config_globalconfig, '');
  await fs.mkdir(env.CODEX_HOME);
  await fs.mkdir(env.CLAUDE_CONFIG_DIR);
  const run = (command, args, options = {}) => {
    const result = spawnCommand(command, args, { env, cwd: options.cwd ?? home,
      encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `${command}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  await fs.cp(path.join(source, 'scripts/client-fixture'), tools, { recursive: true });
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tools });
  // Build in a disposable checkout, never mutate the developer's dependencies.
  for (const name of ['scripts', 'packaging', 'references', 'examples', 'SKILL.md', 'README.md', 'package.json', 'package-lock.json']) {
    await fs.cp(path.join(source, name), path.join(checkout, name), {
      recursive: true, filter: file => path.basename(file) !== 'node_modules',
    });
  }
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
    run(process.execPath, args);
    const second = run(process.execPath, args);
    assert.match(second, /Previous package preserved at/, 'Repeat installation must retain the previous package.');
    assert.equal(list().length, 1, 'Repeat installation must keep one registration.');
    const destination = path.join(home, client === 'codex' ? 'plugins' : '.claude/skills', 'cuefluent-notes');
    const skill = path.join(destination, 'skills/cuefluent-notes');
    const checker = JSON.parse(run(process.execPath, [path.join(skill, 'scripts/check-notes.mjs'), path.join(skill, 'examples/decision.md')]));
    assert.equal(checker.errors, 0);
    const status = JSON.parse(run(process.execPath, [path.join(skill, 'scripts/workflow.mjs'), 'status']));
    assert.equal(status.configHash, null);
    assert.equal(status.runtime.hookRegistration, 'packaged');
    await assert.rejects(fs.stat(env.CUEFLUENT_WORKFLOW_CONFIG), { code: 'ENOENT' });
    console.log(JSON.stringify({ platform: process.platform, client, version, freshInstall: true,
      repeatUpdate: true, registrations: 1, capture: 'unconfigured', liveModel: false }));
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
