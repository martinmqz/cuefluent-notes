import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureSettings } from './capture-policy.mjs';
import { completionPolicyHash, completionStatus, recordCompletion, completionFailureMessages } from './capture-completion.mjs';
import { withLock } from './safe-update.mjs';
const status = (settings, client, input) => completionStatus(settings, client, { ...input, permission_mode: input.permissionMode });

async function fixture(t, client = 'codex') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-completion-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notesDir = path.join(root, 'notes');
  await fs.mkdir(notesDir);
  const stateDir = path.join(root, 'state');
  const configPath = path.join(root, 'config.json');
  const config = { version: 3, minimumPluginVersion: '0.6.0', completionCheck: true,
    enabled: true, clients: [client], automaticUpdates: false, scope: 'SCOPE_SENTINEL',
    routes: [{ projectRoot: root, notesDir, stateDir }] };
  await fs.writeFile(configPath, JSON.stringify(config));
  const settings = await captureSettings(client, root, config);
  const input = { client, permissionMode: 'default', session_id: 'SESSION_SENTINEL',
    [client === 'codex' ? 'turn_id' : 'prompt_id']: 'TURN_SENTINEL',
    cwd: root, configPath, policyHash: completionPolicyHash(settings, 'default'), outcome: 'no-change' };
  return { root, notesDir, stateDir, configPath, config, settings, input, client };
}

test('inspection is read-only; both native identities produce minimal private completion markers', async t => {
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, client);
    assert.equal(await status(f.settings, client, f.input), 'unverified');
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
    assert.equal((await recordCompletion(f.input)).status, 'recorded');
    assert.equal(await status(f.settings, client, f.input), 'complete');
    assert.equal((await recordCompletion(f.input)).status, 'unchanged');
    const dir = path.join(f.stateDir, 'capture-completion');
    const names = await fs.readdir(dir);
    assert.equal(names.length, 1);
    const marker = path.join(dir, names[0]);
    const bytes = await fs.readFile(marker, 'utf8');
    assert.doesNotMatch(bytes, /SENTINEL|notes|session|timestamp|cwd/);
    assert.equal((await fs.stat(marker)).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);
    assert.equal((await fs.stat(dir)).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o700);
    assert.deepEqual(await fs.readdir(f.notesDir), []);
    assert.deepEqual(await fs.readdir(f.stateDir), ['capture-completion']);
  }
});

test('outcomes settle the decision, and each session keeps only its latest turn', async t => {
  const f = await fixture(t);
  for (const outcome of ['saved', 'proposed', 'no-change', 'skipped', 'failed']) {
    await recordCompletion({ ...f.input, outcome });
    assert.equal(await status(f.settings, f.client, f.input), 'complete');
  }
  const next = { ...f.input, turn_id: 'another-turn' };
  assert.equal(await status(f.settings, f.client, next), 'missing');
  await recordCompletion(next);
  assert.equal(await status(f.settings, f.client, f.input), 'missing');
  assert.equal(await status(f.settings, f.client, next), 'complete');
  assert.equal((await fs.readdir(path.join(f.stateDir, 'capture-completion'))).length, 1);
  assert.equal(await status(f.settings, f.client, { ...next, session_id: 'other-session' }), 'unverified');
});

test('policy opt-in, identity and exact policy matching are required before creating state', async t => {
  const f = await fixture(t);
  for (const change of [{ completionCheck: false }, { enabled: false }, { scope: 'Changed' },
    { automaticUpdates: true }, { clients: ['claude'] }, { exclude: [f.root] }]) {
    await fs.writeFile(f.configPath, JSON.stringify({ ...f.config, ...change }));
    await assert.rejects(recordCompletion(f.input));
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  }
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  for (const change of [{ turn_id: '' }, { prompt_id: 'wrong-host' }, { session_id: 'bad\nidentity' },
    { outcome: 'arbitrary content' }, { policyHash: 'invalid' }, { extra: 'raw transcript' }]) {
    await assert.rejects(recordCompletion({ ...f.input, ...change }));
  }
  await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  await recordCompletion(f.input);
  assert.equal(await status({ ...f.settings, scope: 'Changed' }, f.client, f.input), 'unverified');
});

test('linked, nonregular, corrupt and oversized marker entries are preserved and refused', async t => {
  const f = await fixture(t);
  await recordCompletion(f.input);
  const dir = path.join(f.stateDir, 'capture-completion');
  const file = path.join(dir, (await fs.readdir(dir))[0]);
  for (const content of ['{', JSON.stringify({ version: 99 }), 'x'.repeat(1025)]) {
    await fs.writeFile(file, content);
    await assert.rejects(completionStatus(f.settings, f.client, f.input));
    await assert.rejects(recordCompletion(f.input));
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
  await fs.unlink(file);
  await fs.symlink(f.configPath, file);
  await assert.rejects(completionStatus(f.settings, f.client, f.input));
  await assert.rejects(recordCompletion(f.input));
  await fs.unlink(file);
  await fs.link(f.configPath, file);
  await assert.rejects(completionStatus(f.settings, f.client, f.input));
  await assert.rejects(recordCompletion(f.input));
  await fs.unlink(file);
  if (process.platform === 'win32') await fs.mkdir(file);
  else {
    const fifo = spawnSync('mkfifo', [file]);
    assert.equal(fifo.status, 0, fifo.stderr?.toString());
  }
  await assert.rejects(completionStatus(f.settings, f.client, f.input));
  await assert.rejects(recordCompletion(f.input));
});

test('completion directory links cannot redirect state writes', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.stateDir);
  await fs.symlink(f.notesDir, path.join(f.stateDir, 'capture-completion'));
  await assert.rejects(completionStatus(f.settings, f.client, f.input));
  await assert.rejects(recordCompletion(f.input));
  assert.deepEqual(await fs.readdir(f.notesDir), []);
});

test('completion shares the safe-writer lock and never overwrites pending or derived state', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.stateDir);
  await withLock(f.stateDir, async () => {
    await assert.rejects(completionStatus(f.settings, f.client, f.input));
    await assert.rejects(recordCompletion(f.input), /locked/);
    return {};
  });
  assert.deepEqual(await fs.readdir(f.stateDir), []);
  for (const [name, body] of [['journal.json', '{}'], ['manifest.json', '{}']]) {
    await fs.writeFile(path.join(f.stateDir, name), body);
    await assert.rejects(recordCompletion(f.input));
    assert.deepEqual(await fs.readdir(f.stateDir), [name]);
    await fs.unlink(path.join(f.stateDir, name));
  }
});

function afterStageClosed(t, mutate) {
  const open = fs.open.bind(fs);
  return t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (path.basename(String(file)).startsWith('.completion-') && args[0] === 'wx') {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); await mutate(file); };
    }
    return handle;
  });
}

test('changed staging files are never promoted or removed as owned state', async t => {
  for (const kind of ['symlink', 'replacement', 'hardlink', 'edited']) {
    const f = await fixture(t);
    let stage;
    const mutation = afterStageClosed(t, async file => {
      stage = file;
      if (kind !== 'edited') await fs.unlink(file);
      if (kind === 'symlink') await fs.symlink(f.configPath, file);
      else if (kind === 'hardlink') await fs.link(f.configPath, file);
      else await fs.writeFile(file, 'UNFAMILIAR_STAGE');
    });
    try { await assert.rejects(recordCompletion(f.input)); }
    finally { mutation.mock.restore(); }
    const dir = path.dirname(stage);
    assert.deepEqual(await fs.readdir(dir), [path.basename(stage)]);
    if (kind === 'symlink') assert.equal(await fs.readlink(stage), f.configPath);
    else if (kind === 'hardlink') assert.equal((await fs.stat(stage)).nlink, 2);
    else assert.equal(await fs.readFile(stage, 'utf8'), 'UNFAMILIAR_STAGE');
    assert.deepEqual(await fs.readdir(f.notesDir), []);
    assert.equal(await status(f.settings, f.client, f.input), 'unverified');
  }
});

test('cleanup preserves unfamiliar files when staging parents are moved or replaced', async t => {
  for (const kind of ['symlink', 'directory']) {
    const f = await fixture(t);
    let stage, moved;
    const mutation = afterStageClosed(t, async file => {
      stage = file;
      const dir = path.dirname(file);
      moved = `${dir}-moved`;
      await fs.rename(dir, moved);
      if (kind === 'symlink') await fs.symlink(f.notesDir, dir);
      else await fs.mkdir(dir);
      await fs.writeFile(file, 'UNFAMILIAR_FILE');
    });
    try { await assert.rejects(recordCompletion(f.input)); }
    finally { mutation.mock.restore(); }
    assert.equal(await fs.readFile(stage, 'utf8'), 'UNFAMILIAR_FILE');
    assert.deepEqual(await fs.readdir(moved), [path.basename(stage)]);
    assert.deepEqual(await fs.readdir(path.dirname(stage)), [path.basename(stage)]);
  }
});

test('stage or parent replacement during the awaited byte read cannot publish or delete unfamiliar files', async t => {
  for (const kind of ['stage', 'parent']) {
    const f = await fixture(t);
    const open = fs.open.bind(fs);
    let stage;
    const mutation = t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (!stage && path.basename(String(file)).startsWith('.completion-') && typeof args[0] === 'number') {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          stage = file;
          if (kind === 'stage') await fs.unlink(file);
          else {
            const dir = path.dirname(file);
            await fs.rename(dir, `${dir}-moved`);
            await fs.mkdir(dir);
          }
          await fs.writeFile(file, 'UNFAMILIAR_AFTER_READ');
        };
      }
      return handle;
    });
    try { await assert.rejects(recordCompletion(f.input), { code: 'COMPLETION_STATE_UNAVAILABLE' }); }
    finally { mutation.mock.restore(); }
    assert.equal(await fs.readFile(stage, 'utf8'), 'UNFAMILIAR_AFTER_READ');
    assert.deepEqual(await fs.readdir(path.dirname(stage)), [path.basename(stage)]);
    assert.deepEqual(await fs.readdir(f.notesDir), []);
  }
});

test('ordinary post-staging failure removes only the helper-owned stage', async t => {
  const f = await fixture(t);
  const mutation = afterStageClosed(t, async () => {
    await fs.writeFile(f.configPath, JSON.stringify({ ...f.config, completionCheck: false }));
  });
  try { await assert.rejects(recordCompletion(f.input)); }
  finally { mutation.mock.restore(); }
  assert.deepEqual(await fs.readdir(path.join(f.stateDir, 'capture-completion')), []);
  assert.deepEqual(await fs.readdir(f.notesDir), []);
});

test('partial writes and failed fsync remove only the unchanged helper-owned stage', async t => {
  for (const failure of ['write', 'sync']) {
    const f = await fixture(t);
    const open = fs.open.bind(fs);
    const mutation = t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (path.basename(String(file)).startsWith('.completion-') && args[0] === 'wx') {
        if (failure === 'write') {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async bytes => {
            await write(bytes.subarray(0, 20));
            throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
          };
        } else handle.sync = async () => { throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' }); };
      }
      return handle;
    });
    try { await assert.rejects(recordCompletion(f.input), { code: failure === 'write' ? 'ENOSPC' : 'EIO' }); }
    finally { mutation.mock.restore(); }
    assert.deepEqual(await fs.readdir(path.join(f.stateDir, 'capture-completion')), []);
    assert.deepEqual(await fs.readdir(f.stateDir), ['capture-completion']);
  }
});

test('failed completion preserves and reports a lock that cleanup could not release', async t => {
  const f = await fixture(t);
  const mutation = afterStageClosed(t, async () => {
    await fs.writeFile(f.configPath, JSON.stringify({ ...f.config, completionCheck: false }));
    const owner = path.join(f.stateDir, '.lock/owner.json');
    const value = JSON.parse(await fs.readFile(owner));
    await fs.writeFile(owner, JSON.stringify({ ...value, token: 'unfamiliar-owner' }));
  });
  let error;
  try { await recordCompletion(f.input); } catch (caught) { error = caught; }
  finally { mutation.mock.restore(); }
  assert.equal(error.code, 'COMPLETION_POLICY_CHANGED');
  const messages = completionFailureMessages(error).join('\n');
  assert.match(messages, /policy changed or is inactive/);
  assert.match(messages, /Lock cleanup needs attention: Lock owner token changed/);
  assert.ok(await fs.stat(path.join(f.stateDir, '.lock')));
  assert.doesNotMatch(completionFailureMessages(new Error('PRIVATE_RAW_INPUT')).join('\n'), /PRIVATE_RAW_INPUT/);
});

test('detached CLI input is bounded and malformed input has no storage side effects', async t => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('./capture-completion.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [script], { input, encoding: 'utf8', cwd: f.root, timeout: 5000 });
  for (const input of ['{', ' '.repeat(16 * 1024 + 1), Buffer.from([0xff])]) {
    const result = run(input);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  }
  const result = run(JSON.stringify(f.input));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'recorded' });
});
