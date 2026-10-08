import './test-support/isolated-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWindowsConfig, workflowDefaults, windowsDefaultLocations, resolveWorkflowConfig, canonicalWorkflowPath } from './workflow-paths.mjs';
import { workflowConfigPath } from './workflow-config.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cf-default-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const locations = windowsDefaultLocations({ home: root, env: { LOCALAPPDATA: path.join(root, 'Local') } });
  const put = async file => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'metadata only'); };
  return { root, ...locations, put };
}

test('Windows default selects existing settings by identity and refuses two distinct copies', async t => {
  const f = await fixture(t);
  assert.equal(await resolveWindowsConfig(f), f.newConfig);
  assert.deepEqual(await fs.readdir(f.root), []);
  await f.put(f.oldConfig);
  assert.equal(await resolveWindowsConfig(f), f.oldConfig);
  await f.put(f.newConfig);
  await assert.rejects(resolveWindowsConfig(f), { code: 'WORKFLOW_CONFIG_SELECTION_REQUIRED' });
  await fs.unlink(f.oldConfig);
  assert.equal(await resolveWindowsConfig(f), f.newConfig);
  t.mock.method(fs, 'readFile', () => { throw new Error('default resolution may not read settings bodies'); });
  assert.equal(await resolveWindowsConfig(f), f.newConfig);
});

test('Windows default aliases are one identity but links, denied metadata and invalid files are not absence', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias');
  await f.put(f.newConfig);
  await fs.symlink(path.dirname(f.newConfig), alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await resolveWindowsConfig({ ...f, oldConfig: path.join(alias, 'workflow.json') }), f.newConfig);
  await fs.unlink(f.newConfig); await fs.mkdir(f.newConfig);
  await assert.rejects(resolveWindowsConfig(f), { code: 'WORKFLOW_CONFIG_UNAVAILABLE' });
  await fs.rmdir(f.newConfig);
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', (file, ...args) => {
    if (file === f.oldConfig) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return lstat(file, ...args);
  });
  await assert.rejects(resolveWindowsConfig(f), { code: 'WORKFLOW_CONFIG_UNAVAILABLE' });
});

test('explicit config precedence performs no default discovery', async t => {
  const f = await fixture(t);
  t.mock.method(fs, 'lstat', () => { throw new Error('explicit path must bypass default inspection'); });
  assert.equal(await workflowConfigPath({ explicit: f.oldConfig, env: { CUEFLUENT_WORKFLOW_CONFIG: f.newConfig } }), f.oldConfig);
  assert.equal(await workflowConfigPath({ env: { CUEFLUENT_WORKFLOW_CONFIG: f.newConfig } }), f.newConfig);
  const win = await workflowDefaults({ platform: 'win32', home: 'C:\\Users\\Example',
    env: { LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local', CUEFLUENT_WORKFLOW_CONFIG: 'C:\\settings\\workflow.json' }, collectionId: 'example' });
  assert.equal(win.configPath, 'C:\\settings\\workflow.json');
  assert.equal(win.writerStateDir, 'C:\\settings\\collections\\example\\writer');
});

test('a network profile never replaces an existing local setup or becomes a fresh default', async t => {
  const f = await fixture(t), locations = { oldConfig: f.oldConfig, newConfig: '\\\\server\\profile\\.cuefluent-notes\\workflow.json' };
  await assert.rejects(resolveWindowsConfig(locations), { code: 'LOCAL_STATE_LOCATION_REQUIRED' });
  await f.put(f.oldConfig);
  assert.equal(await resolveWindowsConfig(locations), f.oldConfig);
});

test('shared resolver preserves override provenance and refuses empty overrides consistently', async t => {
  const f = await fixture(t);
  const selected = await resolveWorkflowConfig({ explicit: f.newConfig, env: { CUEFLUENT_WORKFLOW_CONFIG: f.oldConfig } });
  assert.deepEqual(selected, { configPath: f.newConfig, requestedConfigPath: f.newConfig, explicit: true });
  for (const options of [{ env: { CUEFLUENT_WORKFLOW_CONFIG: '' } }, { explicit: '', env: {} }]) {
    await assert.rejects(resolveWorkflowConfig(options), { code: 'INVALID_WORKFLOW' });
    await assert.rejects(workflowConfigPath(options), { code: 'INVALID_WORKFLOW' });
    await assert.rejects(workflowDefaults(options), { code: 'INVALID_WORKFLOW' });
  }
});

test('old Windows settings selected through a directory alias keep their physical collection base', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await f.put(f.oldConfig);
  const alias = path.join(f.root, 'old-alias'); await fs.symlink(path.dirname(f.oldConfig), alias, 'junction');
  const result = await workflowDefaults({ home: f.root, env: { LOCALAPPDATA: path.join(f.root, 'Local') },
    explicit: path.join(alias, 'workflow.json'), collectionId: 'test' });
  assert.equal(await canonicalWorkflowPath(result.rawDir), path.join(path.dirname(f.oldConfig), 'collections', 'test', '.cuefluent-raw'));
});
