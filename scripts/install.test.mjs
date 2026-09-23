import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPlugin, main } from './install.mjs';

async function fixture(t, client = 'codex') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-install-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'user space $cash');
  await fs.mkdir(homeDirectory);
  const calls = [];
  const options = { client, homeDirectory, codexDirectory: path.join(homeDirectory, '.codex'),
    checkoutLockDirectory: path.join(root, 'checkout', '.install-lock'),
    claudeDirectory: path.join(homeDirectory, '.claude'), log: () => {}, warn: () => {},
    run: async (exe, args, flags) => {
      calls.push({ exe, args, flags });
      if (args.join(' ') === 'plugin list --json') return JSON.stringify(client === 'codex' ? { installed: [] } : []);
      return '';
    } };
  const catalog = path.join(homeDirectory, '.agents/plugins/marketplace.json');
  const destination = path.join(homeDirectory, client === 'codex' ? 'plugins' : '.claude/skills', 'cuefluent-notes');
  return { root, options, calls, catalog, destination };
}
async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const absent = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
function helper(root, script, args) {
  const result = spawnSync(process.execPath, [path.join(root, 'skills/cuefluent-notes/scripts', script), ...args], {
    encoding: 'utf8', cwd: root, env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const client of ['codex', 'claude']) {
  test(`${client}: fresh install contains a working runtime, and repeating switches variants without losing settings`, async t => {
    const f = await fixture(t, client);
    const settings = path.join(f.options.homeDirectory, '.config/cuefluent-notes/config.json');
    await writeJSON(settings, { synthetic: 'must not be read or changed by installer' });
    const before = await fs.readFile(settings);
    const result = await installPlugin(f.options);
    assert.equal(result.destination, f.destination);
    assert.equal(result.backup, null);
    assert.equal(result.identity, `cuefluent-notes@${client === 'codex' ? 'personal' : 'skills-dir'}`);
    const statusArgs = ['status', '--client', client, '--cwd', f.root, '--config', path.join(f.root, 'absent-policy.json')];
    const status = helper(f.destination, 'setup.mjs', statusArgs);
    assert.equal(status.status, 'unconfigured');
    assert.equal(status.hookPackaged, true);
    assert.equal(helper(f.destination, 'check-notes.mjs', [path.join(f.destination, 'skills/cuefluent-notes/examples/decision.md')]).errors, 0);
    const manifestFile = path.join(f.destination, `.${client}-plugin/plugin.json`);
    const firstVersion = (await readJSON(manifestFile)).version;
    await fs.writeFile(path.join(f.destination, 'local-extra.txt'), 'preserve this in the backup');
    const updated = await installPlugin({ ...f.options, withHooks: false });
    assert.equal(await fs.readFile(path.join(updated.backup, 'local-extra.txt'), 'utf8'), 'preserve this in the backup');
    await fs.stat(path.join(updated.backup, 'hooks/hooks.json'));
    await absent(path.join(f.destination, 'hooks'));
    assert.equal(helper(f.destination, 'setup.mjs', statusArgs).hookPackaged, false);
    assert.deepEqual(await fs.readFile(settings), before);
    await absent(path.join(f.root, 'absent-policy.json'));
    assert.equal(f.calls.filter(call => call.exe === 'npm').length, 2);
    assert.deepEqual(f.calls.find(call => call.exe === 'npm').args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    if (client === 'codex') {
      assert.notEqual((await readJSON(manifestFile)).version, firstVersion);
      const catalog = await readJSON(f.catalog);
      assert.equal(catalog.plugins.length, 1);
      assert.equal(catalog.plugins[0].source.path, './plugins/cuefluent-notes');
      assert.equal(f.calls.filter(call => call.args[1] === 'add').length, 2);
      assert.ok(f.calls.every(call => !call.args.includes('marketplace')));
    } else {
      await absent(f.catalog);
      assert.equal(f.calls.filter(call => call.args[1] === 'validate').length, 2);
      assert.ok(!updated.backup.startsWith(path.dirname(f.destination) + path.sep));
    }
  });
}

test('Codex preserves the personal catalog name, metadata, entry order, and unrelated plugins', async t => {
  const f = await fixture(t);
  const original = { name: 'my-personal', interface: { displayName: 'My Plugins' }, extra: { keep: true },
    plugins: [{ name: 'other', source: { source: 'local', path: './plugins/other' } }] };
  await writeJSON(f.catalog, original);
  await fs.chmod(f.catalog, 0o640);
  const result = await installPlugin(f.options);
  const catalog = await readJSON(f.catalog);
  assert.deepEqual({ ...catalog, plugins: catalog.plugins.slice(0, 1) }, original);
  assert.equal(result.identity, 'cuefluent-notes@my-personal');
  assert.equal((await fs.stat(f.catalog)).mode & 0o777, 0o640);
  const bytes = await fs.readFile(f.catalog);
  await installPlugin(f.options);
  assert.deepEqual(await fs.readFile(f.catalog), bytes);
});

test('Codex refuses invalid, duplicate, conflicting, or linked catalog files before installing dependencies', async t => {
  const f = await fixture(t);
  const original = { name: 'personal', plugins: [{ name: 'cuefluent-notes', source: { source: 'local', path: './somewhere-else' } }] };
  for (const catalog of [{ name: 123, plugins: [] }, { name: 'bad@name', plugins: [] }, { name: 'personal', plugins: [{ name: 'same' }, { name: 'same' }] }, original]) {
    await writeJSON(f.catalog, catalog);
    const bytes = await fs.readFile(f.catalog);
    await assert.rejects(installPlugin(f.options), /marketplace|different source/);
    assert.deepEqual(await fs.readFile(f.catalog), bytes);
  }
  await fs.rm(f.catalog);
  const external = path.join(f.root, 'external.json');
  await writeJSON(external, { name: 'personal', plugins: [] });
  await fs.symlink(external, f.catalog);
  await assert.rejects(installPlugin(f.options), /unlinked file/);
  await fs.rm(f.catalog);
  await fs.link(external, f.catalog);
  await assert.rejects(installPlugin(f.options), /unlinked file/);
  assert.equal(f.calls.length, 0);
  await absent(f.destination);
});

test('Existing packages, plain skills, and linked parents are left untouched', async t => {
  const f = await fixture(t, 'claude');
  await fs.mkdir(f.destination, { recursive: true });
  const file = path.join(f.destination, 'SKILL.md');
  await fs.writeFile(file, '# Existing skill');
  await assert.rejects(installPlugin(f.options), /not managed/);
  assert.equal(await fs.readFile(file, 'utf8'), '# Existing skill');
  await fs.rm(f.destination, { recursive: true });
  await fs.rmdir(path.dirname(f.destination));
  await fs.symlink(f.root, path.dirname(f.destination));
  await assert.rejects(installPlugin(f.options), /not a link/);
  assert.equal(f.calls.length, 0);
  const codex = await fixture(t);
  const plainSkill = path.join(codex.options.homeDirectory, '.agents/skills/cuefluent-notes');
  await fs.mkdir(plainSkill, { recursive: true });
  await assert.rejects(installPlugin(codex.options), /standalone/);
  assert.ok(codex.calls.every(call => call.exe !== 'npm'));
});

test('Other client plugin identities and unsupported list responses fail before publication', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, client);
    const conflict = client === 'codex' ? { installed: [{ pluginId: 'cuefluent-notes@elsewhere' }] } : [{ id: 'cuefluent-notes@elsewhere' }];
    await assert.rejects(installPlugin({ ...f.options, run: () => JSON.stringify(conflict) }), /another location/);
    await assert.rejects(installPlugin({ ...f.options, run: () => '{}' }), /Unsupported/);
    await assert.rejects(installPlugin({ ...f.options, run: () => 'not JSON' }), /Cannot read/);
    await absent(f.destination);
  }
});

test('Standalone Codex skill detection follows the configured client home', async t => {
  const f = await fixture(t);
  const codexDirectory = path.join(f.root, 'custom Codex config');
  const skill = path.join(codexDirectory, 'skills/cuefluent-notes');
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), '# Existing standalone skill');
  await assert.rejects(installPlugin({ ...f.options, codexDirectory }), error => {
    assert.match(error.message, /standalone/);
    assert.ok(error.message.includes(skill));
    return true;
  });
  assert.ok(f.calls.every(call => call.exe !== 'npm'));
  assert.equal(await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8'), '# Existing standalone skill');
  await absent(f.destination);
  await absent(f.catalog);
});

test('Dependency or validation failure preserves the active package and releases locks for retry', async t => {
  const f = await fixture(t, 'claude');
  await installPlugin(f.options);
  const manifestPath = path.join(f.destination, '.claude-plugin/plugin.json');
  const before = await fs.readFile(manifestPath);
  for (const failing of ['npm', 'validate']) {
    const run = async (exe, args, flags) => {
      if (exe === failing || args[1] === failing) throw new Error('synthetic command failure');
      return f.options.run(exe, args, flags);
    };
    await assert.rejects(installPlugin({ ...f.options, run }), /synthetic/);
    assert.deepEqual(await fs.readFile(manifestPath), before);
  }
  await installPlugin(f.options);
});

test('Registration failure retains a retryable package without claiming success or duplicating the catalog entry', async t => {
  const f = await fixture(t);
  const messages = [];
  const run = (exe, args, flags) => {
    if (args[1] === 'add') throw new Error('synthetic registration failure');
    return f.options.run(exe, args, flags);
  };
  await assert.rejects(installPlugin({ ...f.options, run, log: line => messages.push(line) }), /Package prepared.*registration failed/);
  assert.ok(messages.every(line => !line.startsWith('Installed ')));
  await fs.stat(path.join(f.destination, '.cuefluent-installer.json'));
  await installPlugin(f.options);
  assert.equal((await readJSON(f.catalog)).plugins.length, 1);
});

test('Cleanup failures preserve successful installations and primary errors while releasing the other locks', async t => {
  for (const site of ['user-lock', 'packages', 'checkout-lock', 'all']) {
    for (const failRegistration of [false, true]) {
      const f = await fixture(t);
      const checkoutLock = f.options.checkoutLockDirectory;
      const userLock = path.join(f.options.homeDirectory, 'plugins/.cuefluent-installer/lock');
      const warnings = [];
      const hit = new Set();
      const originals = { rmdir: fs.rmdir, rm: fs.rm };
      const faultAt = (method, file) => {
        const kind = file === userLock ? 'user-lock' : file === checkoutLock ? 'checkout-lock' :
          method === 'rm' && path.basename(file) === 'packages' ? 'packages' : null;
        if (kind && (site === 'all' || site === kind) && !hit.has(kind)) {
          hit.add(kind);
          throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
        }
      };
      const run = (exe, args, flags) => {
        if (failRegistration && args[1] === 'add') throw new Error('primary registration failure');
        return f.options.run(exe, args, flags);
      };
      let result, failure;
      try {
        fs.rmdir = async (file, ...args) => { faultAt('rmdir', file); return originals.rmdir(file, ...args); };
        fs.rm = async (file, ...args) => { faultAt('rm', file); return originals.rm(file, ...args); };
        try { result = await installPlugin({ ...f.options, run, warn: warning => warnings.push(warning) }); }
        catch (error) { failure = error; }
      } finally {
        Object.assign(fs, originals);
        // A simulated failed removal leaves only the lock created by this call.
        if (hit.has('checkout-lock')) await fs.rmdir(checkoutLock);
      }
      assert.ok(hit.size > 0, `Fault did not run: ${site}`);
      await fs.stat(path.join(f.destination, '.codex-plugin/plugin.json'));
      if (failRegistration) {
        assert.match(failure?.message ?? '', /registration failed.*primary registration failure/);
        assert.ok(failure.cleanupWarnings.length > 0);
        assert.equal(result, undefined);
      } else {
        assert.equal(failure, undefined);
        assert.equal(result.destination, f.destination);
        assert.ok(result.cleanupWarnings.length > 0);
      }
      assert.ok(warnings.some(warning => warning.includes('Cleanup could not remove') && warning.includes('EACCES')));
      await absent(checkoutLock);
      if (hit.has('user-lock')) {
        assert.ok(warnings.some(warning => warning.includes(userLock)));
        await fs.rmdir(userLock);
      } else await absent(userLock);
      // Retry remains possible once the explicitly reported leftover lock is removed.
      await installPlugin(f.options);
    }
  }
});

test('Catalog cleanup does not replace the publication error', async t => {
  const f = await fixture(t);
  const originals = { link: fs.link, rm: fs.rm };
  let stagedFile;
  try {
    fs.link = async (from, to) => {
      if (to === f.catalog) throw Object.assign(new Error('primary catalog publication failure'), { code: 'EOPNOTSUPP' });
      return originals.link(from, to);
    };
    fs.rm = async (file, ...args) => {
      if (path.dirname(file) === path.dirname(f.catalog) && path.basename(file).startsWith('.cuefluent-')) {
        stagedFile = file;
        throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
      }
      return originals.rm(file, ...args);
    };
    await assert.rejects(installPlugin(f.options), error => {
      assert.match(error.message, /primary catalog publication failure/);
      assert.ok(error.cleanupWarnings.some(warning => warning.includes(stagedFile)));
      return true;
    });
  } finally { Object.assign(fs, originals); }
  await fs.stat(stagedFile);
  await absent(f.catalog);
  await absent(path.join(f.options.homeDirectory, 'plugins/.cuefluent-installer/lock'));
});

test('Catalog changes while dependencies install are not overwritten', async t => {
  const f = await fixture(t);
  const concurrent = { name: 'personal', plugins: [{ name: 'concurrent' }] };
  const run = async (exe, args, flags) => {
    if (exe === 'npm') await writeJSON(f.catalog, concurrent);
    return f.options.run(exe, args, flags);
  };
  await assert.rejects(installPlugin({ ...f.options, run }), /File changed/);
  assert.deepEqual(await readJSON(f.catalog), concurrent);
  await absent(f.destination);
});

test('Custom Claude configuration directory and explicit client executable are honored', async t => {
  const f = await fixture(t, 'claude');
  const claudeDirectory = path.join(f.root, 'custom Claude config');
  const result = await installPlugin({ ...f.options, claudeDirectory, cli: '/synthetic/bin/claude' });
  assert.equal(result.destination, path.join(claudeDirectory, 'skills/cuefluent-notes'));
  assert.equal(f.calls[0].exe, '/synthetic/bin/claude');
  await absent(f.destination);
});

test('Updates recognize client-reported home aliases, including a missing package after interruption', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, client);
    const alias = path.join(f.root, 'home-alias');
    await fs.symlink(f.options.homeDirectory, alias);
    const options = { ...f.options, homeDirectory: alias };
    await installPlugin(options);
    const source = path.join(alias, client === 'codex' ? 'plugins' : '.claude/skills', 'cuefluent-notes');
    const listed = client === 'codex' ? { installed: [{ pluginId: 'cuefluent-notes@personal', source: { path: source } }] }
      : [{ id: 'cuefluent-notes@skills-dir', installPath: source }];
    const run = (exe, args, flags) => args[1] === 'list' ? JSON.stringify(listed) : f.options.run(exe, args, flags);
    const updated = await installPlugin({ ...options, run });
    assert.equal(updated.destination, f.destination);
    assert.ok(updated.backup);
    await fs.rename(f.destination, path.join(f.root, 'saved-package'));
    const repaired = await installPlugin({ ...options, run });
    assert.equal(repaired.destination, f.destination);
    assert.equal(repaired.backup, null);
  }
});

test('Configured Claude homes accept OS and dotfiles aliases with missing descendants', async t => {
  const f = await fixture(t, 'claude');
  const alias = path.join(f.root, 'dotfiles-alias');
  await fs.symlink(f.root, alias);
  const osAlias = await fs.mkdtemp('/tmp/cuefluent-config-alias-');
  t.after(() => fs.rm(osAlias, { recursive: true, force: true }));
  for (const [requested, canonical] of [[alias, f.root], [osAlias, await fs.realpath(osAlias)]]) {
    const result = await installPlugin({ ...f.options, claudeDirectory: path.join(requested, 'settings/new-claude') });
    assert.equal(result.destination, path.join(canonical, 'settings/new-claude/skills/cuefluent-notes'));
  }
});

test('Empty client-home overrides use the default user directories', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, client);
    const result = await installPlugin({ ...f.options, codexDirectory: '', claudeDirectory: '' });
    assert.equal(result.destination, f.destination);
  }
});

test('A relative client executable is the same binary for inventory and registration', async t => {
  const f = await fixture(t);
  const executable = path.join(f.root, 'test-client.mjs');
  await fs.writeFile(executable, '#!/usr/bin/env node\nif (process.argv[3] === "list") console.log(JSON.stringify({installed:[]})); else if (process.argv[3] !== "add") process.exit(42);\n', { mode: 0o755 });
  const calls = [];
  const run = (exe, args, flags = {}) => {
    if (exe === 'npm') return '';
    calls.push(exe);
    const result = spawnSync(exe, args, { cwd: flags.cwd ?? process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  await installPlugin({ ...f.options, cli: path.relative(process.cwd(), executable), run });
  assert.deepEqual(calls, [executable, executable]);
});

test('Interrupted installers leave identifiable owners in disposable checkout and user locks', async t => {
  const f = await fixture(t);
  const harness = path.join(f.root, 'interrupted.mjs');
  await fs.writeFile(harness, `import { installPlugin } from ${JSON.stringify(new URL('./install.mjs', import.meta.url).href)};
await installPlugin({ ...${JSON.stringify(f.options)}, log: () => {}, run: async (exe) => {
  if (exe === 'npm') process.kill(process.pid, 'SIGKILL');
  return JSON.stringify({ installed: [] });
} });\n`);
  const interrupted = spawnSync(process.execPath, [harness], { encoding: 'utf8' });
  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
  const locks = [f.options.checkoutLockDirectory, path.join(f.options.homeDirectory, 'plugins/.cuefluent-installer/lock')];
  for (const lock of locks) {
    const owner = await readJSON(path.join(lock, 'owner.json'));
    assert.equal(owner.pid, interrupted.pid);
    assert.equal(owner.hostname, os.hostname());
    assert.ok(Number.isFinite(Date.parse(owner.createdAt)));
    assert.match(owner.token, /^[0-9a-f-]{36}$/);
  }
  await assert.rejects(installPlugin(f.options), /Another install.*owner.json/);
  for (const lock of locks) await fs.stat(path.join(lock, 'owner.json'));
});

test('Lock cleanup retains a changed owner instead of removing another installer lock', async t => {
  const f = await fixture(t);
  const userLock = path.join(f.options.homeDirectory, 'plugins/.cuefluent-installer/lock');
  const ownerPath = path.join(userLock, 'owner.json');
  const run = async (exe, args, flags) => {
    if (args[1] === 'add') {
      const owner = await readJSON(ownerPath);
      await writeJSON(ownerPath, { ...owner, token: 'synthetic-other-owner' });
    }
    return f.options.run(exe, args, flags);
  };
  const result = await installPlugin({ ...f.options, run });
  assert.ok(result.cleanupWarnings.some(warning => warning.includes('ownership') || warning.includes('owner metadata')));
  assert.equal((await readJSON(ownerPath)).token, 'synthetic-other-owner');
  await absent(f.options.checkoutLockDirectory);
});

test('Failed rollback preserves the original publication error and the recoverable previous package', async t => {
  const f = await fixture(t);
  await installPlugin(f.options);
  const before = await fs.readFile(path.join(f.destination, '.codex-plugin/plugin.json'));
  const originalRename = fs.rename;
  const publicationError = Object.assign(new Error('primary publication failure'), { code: 'EACCES' });
  const restoreError = Object.assign(new Error('restore failure'), { code: 'ENOTEMPTY' });
  const warnings = [];
  let retained;
  try {
    fs.rename = async (from, to) => {
      if (to === f.destination) throw path.basename(from) === 'previous' ? restoreError : publicationError;
      return originalRename(from, to);
    };
    await assert.rejects(installPlugin({ ...f.options, warn: message => warnings.push(message) }), error => {
      assert.equal(error, publicationError);
      assert.equal(error.rollbackError, restoreError);
      retained = error.backupPath;
      assert.ok(warnings.some(warning => warning.includes(retained)));
      return true;
    });
  } finally { fs.rename = originalRename; }
  assert.deepEqual(await fs.readFile(path.join(retained, '.codex-plugin/plugin.json')), before);
  await absent(f.destination);
  await absent(f.options.checkoutLockDirectory);
});

test('CLI rejects ambiguous, repeated, and incomplete options', async () => {
  for (const args of [[], ['--client', 'other'], ['--client'], ['--client', 'codex', '--client', 'claude'], ['--manual', '--manual'], ['--surprise']]) {
    await assert.rejects(main(args), /Choose|option/);
  }
});

test('Concurrent installers stop before rebuilding or publishing, and release locks after completion', async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const run = async (exe, args, flags) => {
    if (exe === 'npm') { entered(); await held; }
    return f.options.run(exe, args, flags);
  };
  const first = installPlugin({ ...f.options, run });
  await started;
  try { await assert.rejects(installPlugin(f.options), /Another install/); }
  finally { release(); }
  await first;
  await installPlugin(f.options);
});

test('Help works through both documented npm scripts without starting installation', () => {
  for (const client of ['codex', 'claude']) {
    const result = spawnSync('npm', ['run', `install:${client}`, '--', '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: node scripts\/install.mjs/);
    assert.ok(!result.stdout.includes('Installing locked'));
  }
});
