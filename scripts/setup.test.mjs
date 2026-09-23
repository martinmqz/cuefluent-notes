import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, setupStatus } from './setup.mjs';
import { hookResponse } from './hooks.mjs';

const script = fileURLToPath(new URL('./setup.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-setup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const notes = path.join(root, 'notes');
  await fs.mkdir(project); await fs.mkdir(notes);
  return { root, project, notes, client: 'codex', mode: 'automatic', scope: 'Fictional lab decisions only.',
    destination: path.join(notes, 'project.md'), configPath: path.join(root, 'private', 'config.json') };
}
test('unconfigured status is read-only and a manual choice persists without note locations', async t => {
  const f = await fixture(t);
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'unconfigured');
  await assert.rejects(fs.stat(path.dirname(f.configPath)), { code: 'ENOENT' });
  await initialize({ client: f.client, mode: 'manual', configPath: f.configPath });
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'disabled');
  assert.equal((await fs.stat(f.configPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(f.configPath))).mode & 0o777, 0o700);
  const config = JSON.parse(await fs.readFile(f.configPath));
  assert.equal(await hookResponse('codex', { hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', cwd: f.project }, config), null);
  assert.deepEqual(await fs.readdir(f.notes), []);
});
test('automatic and suggest setup produce policy consumed by the real hook without touching notes', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.destination, '# Existing note\n\n## User edits\n\nKeep this.\n');
  const before = await fs.stat(f.destination, { bigint: true });
  for (const mode of ['automatic', 'suggest']) {
    const configPath = path.join(f.root, 'private', `${mode}.json`);
    await initialize({ ...f, mode, configPath });
    const status = await setupStatus({ ...f, cwd: f.project, configPath });
    assert.equal(status.status, 'configured'); assert.equal(status.mode, mode);
    assert.equal(status.destination, f.destination); assert.equal(status.hostTrust, 'not_checked');
    await assert.rejects(fs.stat(status.stateDir), { code: 'ENOENT' });
    const config = JSON.parse(await fs.readFile(configPath));
    const output = await hookResponse('codex', { hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', cwd: f.project }, config);
    assert.ok(output.hookSpecificOutput.additionalContext.includes(f.destination));
    assert.equal(config.automaticUpdates, mode === 'automatic');
    assert.equal((await setupStatus({ ...f, cwd: f.root, configPath })).status, 'inactive');
    assert.equal((await setupStatus({ ...f, client: 'claude', cwd: f.project, configPath })).status, 'client_not_configured');
  }
  assert.equal((await fs.stat(f.destination, { bigint: true })).mtimeNs, before.mtimeNs);
  const auto = JSON.parse(await fs.readFile(path.join(f.root, 'private/automatic.json')));
  const suggest = JSON.parse(await fs.readFile(path.join(f.root, 'private/suggest.json')));
  assert.equal(auto.routes[0].stateDir, suggest.routes[0].stateDir);
});
test('existing and malformed configurations survive initialization attempts unchanged', async t => {
  const f = await fixture(t);
  await initialize(f);
  for (const bytes of [await fs.readFile(f.configPath), Buffer.from('{broken'), Buffer.from('null')]) {
    await fs.writeFile(f.configPath, bytes);
    const before = await fs.stat(f.configPath, { bigint: true });
    await assert.rejects(initialize(f), /already exists/);
    assert.deepEqual(await fs.readFile(f.configPath), bytes);
    assert.equal((await fs.stat(f.configPath, { bigint: true })).mtimeNs, before.mtimeNs);
  }
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'invalid');
});
test('concurrent initializations publish one complete config without overwriting', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([initialize(f), initialize({ ...f, mode: 'suggest' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const status = await setupStatus({ ...f, cwd: f.project });
  assert.equal(status.status, 'configured');
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), ['config.json']);
});
test('initialization rejects unsafe paths, incomplete choices, and storage overlap before publishing', async t => {
  const f = await fixture(t);
  const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
  const attempts = [
    { destination: path.join(sourceRoot, 'do-not-write.md') },
    { configPath: path.join(sourceRoot, 'do-not-create-config.json') },
    { stateDir: f.destination },
    { stateDir: path.dirname(f.configPath) },
    { destination: f.configPath.replace(/json$/, 'md'), configPath: f.configPath.replace(/json$/, 'md') },
    { scope: '' }, { scope: 'two\nlines' }, { client: 'other' },
    { destination: path.join(f.root, 'missing/note.md') },
    { project: path.join(f.root, 'absent') }, { mode: 'manual' },
  ];
  for (const extra of attempts) await assert.rejects(initialize({ ...f, ...extra }));
  await assert.rejects(fs.stat(path.dirname(f.configPath)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.notes), []);
});
test('configuration cannot create a directory at the prospective note destination', async t => {
  const f = await fixture(t);
  for (const mode of ['automatic', 'suggest']) {
    await assert.rejects(initialize({ ...f, mode,
      configPath: path.join(f.destination, 'config.json'), stateDir: path.join(f.root, 'writer-state'),
    }), /configuration separate/);
  }
  assert.deepEqual(await fs.readdir(f.notes), []);
  await assert.rejects(fs.stat(path.join(f.root, 'writer-state')), { code: 'ENOENT' });
});
test('setup refuses filenames that cannot be used by the safe writer', async t => {
  const f = await fixture(t);
  for (const mode of ['automatic', 'suggest']) {
    await assert.rejects(initialize({ ...f, mode, destination: path.join(f.notes, 'topic\\\\finding.md') }), /Invalid capture configuration/);
  }
  await assert.rejects(fs.stat(path.dirname(f.configPath)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.notes), []);
});
test('dangling symlinks and linked note destinations are refused', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.configPath));
  const target = path.join(f.root, 'not-created');
  await fs.symlink(target, f.configPath);
  await assert.rejects(initialize(f), /already exists/);
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'invalid');
  await fs.unlink(f.configPath);
  await fs.symlink(target, f.destination);
  await assert.rejects(initialize(f));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), []);
});
test('setup and status reject notes with multiple hard links without changing their content', async t => {
  const f = await fixture(t);
  const alias = path.join(f.notes, 'linked-note.md');
  const content = '# Synthetic note\n\n## Existing finding\n\nPreserve this finding.\n';
  await fs.writeFile(f.destination, content);
  await fs.link(f.destination, alias);
  for (const mode of ['automatic', 'suggest']) await assert.rejects(initialize({ ...f, mode }), /Invalid capture configuration/);
  await assert.rejects(fs.stat(path.dirname(f.configPath)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(alias, 'utf8'), content);

  await fs.unlink(alias);
  await initialize(f);
  const configBytes = await fs.readFile(f.configPath);
  const config = JSON.parse(configBytes);
  const stateDir = config.routes[0].stateDir;
  await fs.link(f.destination, alias);
  assert.equal((await setupStatus({ ...f, cwd: f.project })).status, 'invalid');
  const response = await hookResponse('codex', { hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', cwd: f.project }, config);
  assert.match(response.hookSpecificOutput.additionalContext, /capture is skipped/);
  assert.deepEqual(await fs.readFile(f.configPath), configBytes);
  assert.equal(await fs.readFile(f.destination, 'utf8'), content);
  assert.equal(await fs.readFile(alias, 'utf8'), content);
  assert.equal((await fs.stat(f.destination)).nlink, 2);
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});
test('status uses real routing, including exclusions, disabled routes, and ambiguous roots', async t => {
  const f = await fixture(t); await initialize(f);
  const base = JSON.parse(await fs.readFile(f.configPath));
  for (const [config, expected] of [
    [{ ...base, exclude: [f.project] }, 'inactive'],
    [{ ...base, routes: [{ ...base.routes[0], enabled: false }] }, 'inactive'],
    [{ ...base, routes: [base.routes[0], base.routes[0]] }, 'invalid'],
  ]) {
    await fs.writeFile(f.configPath, JSON.stringify(config));
    assert.equal((await setupStatus({ ...f, cwd: f.project })).status, expected);
  }
});
test('CLI follows explicit and environment configuration, rejects duplicate options, and keeps status read-only', async t => {
  const f = await fixture(t);
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8',
    env: { ...process.env, CUEFLUENT_NOTES_CONFIG: f.configPath } });
  const initial = run(['status', '--client', 'codex', '--cwd', f.project]);
  assert.equal(initial.status, 0); assert.equal(JSON.parse(initial.stdout).status, 'unconfigured');
  assert.equal(run(['init', '--client', 'codex', '--mode', 'manual', '--mode', 'automatic']).status, 2);
  assert.equal(run(['init', '--client', 'codex', '--mode', 'manual', '--config', 'relative.json']).status, 2);
  assert.equal(run(['init', '--client', 'codex', '--mode', 'manual']).status, 0);
  const absent = run(['status', '--client', 'codex', '--cwd', f.project, '--config', path.join(f.root, 'elsewhere.json')]);
  assert.equal(JSON.parse(absent.stdout).status, 'unconfigured');
});
test('first-use configuration and state paths resolve through symlinked ancestors', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'linked-private');
  const real = path.join(f.root, 'real-private');
  await fs.mkdir(real);
  await fs.symlink(real, alias);
  const configPath = path.join(alias, 'first-use', 'config.json');
  const stateDir = path.join(alias, 'writer-state');
  await initialize({ ...f, configPath, stateDir });
  const status = await setupStatus({ ...f, cwd: f.project, configPath });
  assert.equal(status.status, 'configured');
  assert.equal(status.stateDir, path.join(real, 'writer-state'));
  assert.deepEqual(await fs.readdir(f.notes), []);
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
  const directState = path.join(f.root, 'direct-state-link');
  await fs.symlink(real, directState);
  await assert.rejects(initialize({ ...f, configPath: path.join(real, 'second.json'), stateDir: directState }));
});
