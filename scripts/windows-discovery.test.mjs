import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverWindowsSettings, windowsRootCreationSnapshot, discoveryBudget, inspectWindowsPath } from './windows-discovery.mjs';
import { preflightWindowsConfiguration } from './windows-setup-guards.mjs';
import { configureWorkflow, workflowStatus, prepareConfiguredStorage } from './workflow-settings.mjs';
import { workflowDefaults } from './workflow-paths.mjs';
import { readWorkflowSnapshot, validateWorkflowConfig } from './workflow-config.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-discovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = path.join(root, 'Local'), roaming = path.join(root, 'Roaming');
  await fs.mkdir(local); await fs.mkdir(roaming);
  const facts = { platform: 'win32', home: root, env: { LOCALAPPDATA: local, APPDATA: roaming } };
  const oldConfig = path.join(local, 'CuefluentNotes', 'workflow.json');
  const pkg = (name = 'Synthetic.Client_123') => path.join(local, 'Packages', name);
  const packageConfig = (name) => path.join(pkg(name), 'LocalCache', 'Local', 'CuefluentNotes', 'workflow.json');
  const config = name => validateWorkflowConfig({ format: 'cuefluent-workflow', schemaVersion: 1,
    collections: [{ id: 'test', rawDir: path.join(root, name, 'raw'), intakeStateDir: path.join(root, name, 'intake'),
      notes: { notesDir: path.join(root, name, 'notes'), writerStateDir: path.join(root, name, 'writer') } }],
    routes: [{ id: 'test', projectRoot: path.join(root, name, 'project'), clients: ['claude'], collectionId: 'test' }] });
  const put = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, local, roaming, facts, oldConfig, newConfig: path.join(root, '.cuefluent-notes', 'workflow.json'), pkg, packageConfig, config, put };
}
const absent = async file => assert.equal(await fs.lstat(file).then(() => false, e => e.code === 'ENOENT'), true);

// This same fixture runs natively on Windows; macOS/Linux exercise the bounded
// algorithms only, not package virtualization or native Windows permissions.
test('discovery is metadata-only, bounds its roots, and separates empty shadows from unresolved state', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.oldConfig), { recursive: true });
  await f.put(f.packageConfig(), 'not settings and must not be read by status inventory');
  const other = f.packageConfig('Other.Client_456');
  await f.put(path.join(path.dirname(other), 'unknown-state'), 'synthetic state');
  const opendir = fs.opendir.bind(fs);
  t.mock.method(fs, 'opendir', async (file, ...args) => { assert(file.startsWith(f.root + path.sep), 'enumeration escaped disposable fixture'); return opendir(file, ...args); });
  t.mock.method(fs, 'open', async file => { throw new Error(`Inventory must not read bytes: ${file}`); });
  const result = await discoverWindowsSettings(f.facts);
  assert.equal(result.complete, true);
  assert.deepEqual(result.candidates.map(c => c.kind).sort(), ['config', 'empty-shadow', 'unresolved-state']);
});

test('missing package trees are complete, while denied reads, links and exhausted budgets are incomplete', async t => {
  const f = await fixture(t);
  assert.equal((await discoverWindowsSettings(f.facts)).complete, true);
  const denied = Object.assign(new Error('private OS details'), { code: 'EACCES' });
  const opendir = fs.opendir.bind(fs);
  await fs.mkdir(f.pkg(), { recursive: true });
  t.mock.method(fs, 'opendir', async (file, ...args) => {
    if (file === path.join(f.local, 'Packages')) throw denied;
    return opendir(file, ...args);
  });
  const blocked = await discoverWindowsSettings(f.facts);
  assert.equal(blocked.complete, false); assert.equal(blocked.reason, 'WINDOWS_DISCOVERY_UNAVAILABLE');
  t.mock.restoreAll();
  const budget = await discoverWindowsSettings(f.facts, { check: () => { throw Object.assign(new Error(), { code: 'WINDOWS_DISCOVERY_TIMEOUT' }); } });
  assert.equal(budget.reason, 'WINDOWS_DISCOVERY_TIMEOUT');
  const link = path.join(f.local, 'Packages', 'Linked');
  await fs.symlink(f.pkg(), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await discoverWindowsSettings(f.facts)).complete, false);
});

test('package and combined candidate limits fail closed', async t => {
  const f = await fixture(t);
  const packages = path.join(f.local, 'Packages'); await fs.mkdir(packages);
  for (let i = 0; i < 1025; i++) await fs.mkdir(path.join(packages, `p${i}`));
  assert.equal((await discoverWindowsSettings(f.facts, { check: () => {} })).reason, 'WINDOWS_DISCOVERY_CAPACITY');
  await fs.rm(packages, { recursive: true });
  await f.put(f.oldConfig, f.config('old'));
  for (let i = 0; i < 32; i++) await f.put(f.packageConfig(`p${i}`), f.config(`p${i}`));
  assert.equal((await discoverWindowsSettings(f.facts, { check: () => {} })).reason, 'WINDOWS_DISCOVERY_CAPACITY');
});

test('implicit setup refuses existing settings before writes; explicit disjoint setup preserves all existing bytes', async t => {
  const f = await fixture(t), old = f.config('old'), proposal = f.config('new');
  await f.put(f.packageConfig(), old);
  const state = path.join(f.root, 'old', 'intake', 'pending-claim.json');
  const note = path.join(f.root, 'old', 'notes', 'edited.md');
  await f.put(state, 'synthetic pending claim'); await f.put(note, 'user edits');
  const settingsBytes = await fs.readFile(f.packageConfig());
  await assert.rejects(configureWorkflow({ configPath: f.oldConfig, expectedHash: null, proposal },
    { explicitConfig: false, platformFacts: f.facts }), { code: 'WINDOWS_EXISTING_SETTINGS' });
  await absent(path.dirname(f.oldConfig));
  const selected = path.join(f.root, 'separate-settings', 'workflow.json');
  const saved = await configureWorkflow({ configPath: selected, expectedHash: null, proposal }, { platformFacts: f.facts });
  assert.equal(saved.status, 'initialized'); assert.equal(saved.requestedConfigPath, selected); assert.equal(saved.resolvedConfigPath, selected);
  assert.equal(saved.config.routes[0].collection.enabled, false); assert.equal(saved.config.routes[0].processing.mode, 'manual');
  assert((await fs.readFile(f.packageConfig())).equals(settingsBytes));
  assert.equal(await fs.readFile(state, 'utf8'), 'synthetic pending claim'); assert.equal(await fs.readFile(note, 'utf8'), 'user edits');
  await absent(proposal.collections[0].rawDir);
});

test('empty selected settings folder does not conflict with its own locked staging during first configure', async t => {
  const f = await fixture(t);
  // Native privacy is established by configure, so start with a missing parent.
  const saved = await configureWorkflow({ configPath: f.oldConfig, expectedHash: null, proposal: f.config('new') },
    { explicitConfig: false, platformFacts: f.facts });
  assert.equal(saved.status, 'initialized');
  assert.deepEqual(await fs.readdir(path.dirname(f.oldConfig)), ['workflow.json']);
});

test('overlap checks include disabled projects, folders/files, private roots and case-only names', async t => {
  const f = await fixture(t), old = f.config('old'); old.routes[0].excluded = true;
  await f.put(f.packageConfig(), old);
  const selected = path.join(f.root, 'new-settings', 'workflow.json');
  const overlapping = [
    c => { c.routes[0].projectRoot = old.routes[0].projectRoot; },
    c => { c.routes[0].projectRoot = path.join(old.routes[0].projectRoot, 'nested'); },
    c => { c.routes[0].projectRoot = path.dirname(old.routes[0].projectRoot); },
    c => { c.routes[0].projectRoot = old.routes[0].projectRoot.toUpperCase(); },
    c => { c.collections[0].notes.notesDir = old.collections[0].notes.notesDir; },
    c => { delete c.collections[0].notes.notesDir; c.collections[0].notes.destination = path.join(old.collections[0].notes.notesDir, 'specific.md'); },
    c => { c.collections[0].rawDir = old.collections[0].rawDir; },
    c => { c.routes[0].projectRoot = path.dirname(old.collections[0].rawDir); },
    c => { c.routes[0].projectRoot = path.dirname(f.packageConfig()); },
    c => { c.collections[0].rawDir = path.join(old.routes[0].projectRoot, '.private'); },
    c => { c.collections[0].intakeStateDir = old.routes[0].projectRoot; },
    c => { c.collections[0].notes.writerStateDir = path.dirname(old.routes[0].projectRoot); },
    c => { c.collections[0].notes.notesDir = old.collections[0].intakeStateDir; },
    c => { c.collections[0].notes.writerStateDir = old.collections[0].notes.notesDir; },
  ];
  for (const change of overlapping) {
    const proposed = f.config('new'); change(proposed);
    await assert.rejects(preflightWindowsConfiguration({ configPath: selected, proposed, explicit: true }, f.facts), { code: 'WINDOWS_SETTINGS_OVERLAP' });
  }
  const sibling = f.config('new'); sibling.routes[0].projectRoot = old.routes[0].projectRoot + '-other';
  await (await preflightWindowsConfiguration({ configPath: selected, proposed: sibling }, f.facts))();
  delete old.collections[0].notes.notesDir; delete old.collections[0].notes.organization; old.collections[0].notes.destination = path.join(f.root, 'shared-notes', 'first.md');
  await f.put(f.packageConfig(), old);
  const distinct = f.config('new'); delete distinct.collections[0].notes.notesDir; distinct.collections[0].notes.destination = path.join(f.root, 'shared-notes', 'second.md');
  await (await preflightWindowsConfiguration({ configPath: selected, proposed: distinct }, f.facts))();
});

test('old real default participates, identical-content copies are distinct, selected identity is not a competitor', async t => {
  const f = await fixture(t), proposed = f.config('old'); await f.put(f.oldConfig, proposed);
  const selected = path.join(f.root, 'settings', 'workflow.json');
  await assert.rejects(preflightWindowsConfiguration({ configPath: selected, proposed }, f.facts), { code: 'WINDOWS_SETTINGS_OVERLAP' });
  await (await preflightWindowsConfiguration({ configPath: f.oldConfig, proposed }, f.facts))();
  await f.put(f.packageConfig(), proposed);
  await assert.rejects(preflightWindowsConfiguration({ configPath: f.oldConfig, proposed }, f.facts), { code: 'WINDOWS_SETTINGS_OVERLAP' });
});

test('project aliases cannot bypass overlap and distinct selected path aliases deduplicate physical configs', async t => {
  const f = await fixture(t), proposed = f.config('old'); await fs.mkdir(proposed.routes[0].projectRoot, { recursive: true });
  await f.put(f.oldConfig, proposed);
  const alias = path.join(f.root, 'project-alias'); await fs.symlink(proposed.routes[0].projectRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const other = f.config('new'); other.routes[0].projectRoot = alias;
  await assert.rejects(preflightWindowsConfiguration({ configPath: path.join(f.root, 'separate.json'), proposed: other }, f.facts), { code: 'WINDOWS_SETTINGS_OVERLAP' });
  // Native virtualization may expose the same file from two ordinary paths.
  // Mock only that metadata mapping; no link is allowed for the settings leaf.
  const duplicate = f.packageConfig(); await f.put(duplicate, proposed);
  const lstat = fs.lstat.bind(fs), original = await lstat(f.oldConfig, { bigint: true });
  t.mock.method(fs, 'lstat', (file, options) => file === duplicate && options?.bigint ? Promise.resolve(original) : lstat(file, options));
  assert.equal((await discoverWindowsSettings(f.facts)).candidates.filter(c => c.kind === 'config').length, 1);
});

test('invalid and oversized competing configs and unresolved state block only ownership changes', async t => {
  const f = await fixture(t), proposed = f.config('new'), configPath = path.join(f.root, 'settings.json');
  for (const content of ['invalid JSON', JSON.stringify({ format: 'cuefluent-workflow', schemaVersion: 9000 }), ' '.repeat(1024 * 1024 + 1)]) {
    await f.put(f.packageConfig(), content);
    await assert.rejects(preflightWindowsConfiguration({ configPath, proposed }, f.facts), { code: content.length > 1024 * 1024 ? 'WINDOWS_SETTINGS_INSPECTION_LIMIT' : 'WINDOWS_SETTINGS_UNRESOLVED' });
  }
  const previous = f.config('new'); proposed.routes[0].processing.mode = 'prompted';
  assert.equal(await preflightWindowsConfiguration({ configPath, previous, proposed }, f.facts), null);
  assert.equal(await preflightWindowsConfiguration({ configPath, previous, proposed: { ...proposed, collections: [], routes: [] } }, f.facts), null);
  await fs.unlink(f.packageConfig()); await f.put(path.join(path.dirname(f.packageConfig()), 'state'), 'incomplete setup');
  await assert.rejects(preflightWindowsConfiguration({ configPath, proposed }, f.facts), { code: 'WINDOWS_SETTINGS_UNRESOLVED' });
});

test('aggregate settings bytes are bounded independently of per-file limits', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 9; i++) await f.put(f.packageConfig(`p${i}`), JSON.stringify(f.config(`p${i}`)).padEnd(1024 * 1024, ' '));
  await assert.rejects(preflightWindowsConfiguration({ configPath: path.join(f.root, 'settings.json'), proposed: f.config('new') }, f.facts), { code: 'WINDOWS_SETTINGS_INSPECTION_LIMIT' });
});

test('candidate changes during staging preserve the selected config and clean only owned stage/lock', async t => {
  const f = await fixture(t), other = f.config('other'); await f.put(f.packageConfig(), other);
  const configPath = path.join(f.root, 'settings', 'workflow.json');
  const proposal = f.config('new');
  const initial = await configureWorkflow({ configPath, expectedHash: null, proposal }, { platformFacts: f.facts });
  proposal.routes[0].projectRoot += '-changed';
  await assert.rejects(configureWorkflow({ configPath, expectedHash: initial.configHash, proposal },
    { platformFacts: f.facts, beforeCommit: async () => { other.routes[0].processing.mode = 'prompted'; await f.put(f.packageConfig(), other); } }), { code: 'WINDOWS_SETTINGS_CHANGED' });
  assert.equal((await readWorkflowSnapshot(configPath)).hash, initial.configHash);
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['workflow.json']);
});

test('a competing first setup appearing after preflight prevents publication', async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'settings', 'workflow.json'), proposed = f.config('new');
  await assert.rejects(configureWorkflow({ configPath, expectedHash: null, proposal: proposed },
    { platformFacts: f.facts, beforeCommit: () => f.put(f.packageConfig(), proposed) }), { code: 'WINDOWS_SETTINGS_OVERLAP' });
  await absent(configPath); assert.deepEqual(await fs.readdir(path.dirname(configPath)), []);
});

test('package config freezes each missing root before any parent creation; prepared roots remain usable', async t => {
  const f = await fixture(t), configPath = f.packageConfig(), proposal = f.config('existing'); await f.put(configPath, proposal);
  const c = proposal.collections[0], roots = [c.rawDir, c.intakeStateDir, c.notes.writerStateDir];
  const options = { configPath, expectedConfigHash: (await readWorkflowSnapshot(configPath)).hash, collectionId: 'test' };
  await assert.rejects(prepareConfiguredStorage(options, { platformFacts: f.facts }), { code: 'WINDOWS_PACKAGE_STORE_FROZEN' });
  await absent(path.dirname(c.rawDir));
  for (const root of roots) await fs.mkdir(root, { recursive: true });
  assert.equal((await windowsRootCreationSnapshot({ configPath, roots }, f.facts)).roots.every(r => r.status === 'present'), true);
  for (const root of roots) {
    await fs.rmdir(root);
    await assert.rejects(windowsRootCreationSnapshot({ configPath, roots }, f.facts), { code: 'WINDOWS_PACKAGE_STORE_FROZEN' });
    await absent(root); await fs.mkdir(root);
  }
  const next = f.config('added'); proposal.collections.push({ ...next.collections[0], id: 'added' }); await f.put(configPath, proposal);
  await assert.rejects(prepareConfiguredStorage({ ...options, collectionId: 'added', expectedConfigHash: (await readWorkflowSnapshot(configPath)).hash }, { platformFacts: f.facts }), { code: 'WINDOWS_PACKAGE_STORE_FROZEN' });
  await absent(path.dirname(next.collections[0].rawDir));
  for (const root of roots) assert((await fs.stat(root)).isDirectory());
});

test('missing roots anywhere inside Packages freeze; Local and Roaming shadows block custom roots without a config', async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'settings.json'); await f.put(configPath, f.config('ordinary'));
  await assert.rejects(windowsRootCreationSnapshot({ configPath, roots: [path.join(f.pkg(), 'OtherPrivateArea', 'raw')] }, f.facts), { code: 'WINDOWS_PACKAGE_STORE_FROZEN' });
  for (const [base, kind] of [[f.local, 'Local'], [f.roaming, 'Roaming']]) {
    const root = path.join(base, 'CustomStore', 'nested', 'raw');
    const shadow = path.join(f.pkg(), 'LocalCache', kind, 'CustomStore'); await fs.mkdir(shadow, { recursive: true });
    await assert.rejects(windowsRootCreationSnapshot({ configPath, roots: [root] }, f.facts), { code: 'WINDOWS_STORAGE_SHADOW_CONFLICT' });
    await absent(path.join(base, 'CustomStore'));
    await fs.rm(shadow, { recursive: true });
    const clean = await windowsRootCreationSnapshot({ configPath, roots: [root] }, f.facts);
    assert.equal(clean.roots[0].status, 'missing');
  }
});

test('unavailable unrelated Roaming AppData does not block custom local storage preparation', async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'settings', 'workflow.json'), proposal = f.config('custom');
  const saved = await configureWorkflow({ configPath, expectedHash: null, proposal }, { platformFacts: f.facts });
  const before = await fs.readFile(configPath), realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', (file, ...args) => {
    if (file === f.roaming) throw Object.assign(new Error('synthetic unavailable redirected folder'), { code: 'EACCES' });
    return realpath(file, ...args);
  });
  const result = await prepareConfiguredStorage({ configPath, expectedConfigHash: saved.configHash, collectionId: 'test' }, { platformFacts: f.facts });
  assert.equal(result.status, 'storage-ready');
  const c = proposal.collections[0];
  for (const root of [c.rawDir, c.intakeStateDir, c.notes.writerStateDir]) assert((await fs.stat(root)).isDirectory());
  assert((await fs.readFile(configPath)).equals(before));
});

test('a relevant unavailable AppData base still refuses missing roots', async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'settings.json'); await f.put(configPath, f.config('custom'));
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', (file, ...args) => {
    if (file === f.roaming) throw Object.assign(new Error('synthetic unavailable folder'), { code: 'EACCES' });
    return realpath(file, ...args);
  });
  await assert.rejects(windowsRootCreationSnapshot({ configPath, roots: [path.join(f.roaming, 'Custom', 'raw')] }, f.facts), { code: 'EACCES' });
  await absent(path.join(f.roaming, 'Custom'));
});

test('unrelated network AppData is not resolved for missing local roots', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'settings.json'); await f.put(configPath, f.config('custom'));
  const unavailable = '\\\\synthetic-unavailable-server\\profile\\Roaming';
  const facts = { ...f.facts, env: { ...f.facts.env, APPDATA: unavailable } }, realpath = fs.realpath.bind(fs);
  let probes = 0;
  t.mock.method(fs, 'realpath', (file, ...args) => {
    if (file === unavailable) { probes++; throw Object.assign(new Error('synthetic network unavailable'), { code: 'ENETUNREACH' }); }
    return realpath(file, ...args);
  });
  const result = await windowsRootCreationSnapshot({ configPath, roots: [path.join(f.root, 'custom', 'raw')] }, facts);
  assert.equal(result.roots[0].status, 'missing'); assert.equal(probes, 0);
});

test('status reports requested/resolved paths and package origin without reading other configs or writing', async t => {
  const f = await fixture(t), configPath = f.packageConfig(); await f.put(configPath, f.config('existing'));
  await f.put(f.packageConfig('Other'), 'not valid; ordinary status never reads this');
  const open = fs.open.bind(fs), readFile = fs.readFile.bind(fs), writes = [];
  t.mock.method(fs, 'open', async (file, flags, ...args) => {
    if (typeof flags === 'string' && /[wa+]/.test(flags)) writes.push(file);
    if (file === f.packageConfig('Other')) assert.fail('status read another config');
    return open(file, flags, ...args);
  });
  t.mock.method(fs, 'readFile', async (file, ...args) => { if (file === f.packageConfig('Other')) assert.fail('status read another config'); return readFile(file, ...args); });
  const result = await workflowStatus({ configPath, diagnostics: true }, f.facts);
  assert.equal(result.configPath, configPath); assert.equal(result.requestedConfigPath, configPath); assert.equal(result.resolvedConfigPath, configPath);
  assert.equal(result.windowsStorage.status, 'package-owned'); assert.match(result.windowsStorage.warning, /roots depend on the host/);
  assert.equal(result.windowsStorage.collections[0].roots.length, 4); assert.deepEqual(writes, []);
});

test('external or adjacent settings can extend their own default storage without reading private contents', async t => {
  for (const adjacent of [false, true]) {
    const f = await fixture(t), proposal = f.config('selected');
    const base = path.join(f.local, 'CuefluentNotes'), store = path.join(base, 'collections', 'test');
    Object.assign(proposal.collections[0], { rawDir: path.join(store, 'raw'), intakeStateDir: path.join(store, 'intake') });
    proposal.collections[0].notes.writerStateDir = path.join(store, 'writer');
    const configPath = adjacent ? path.join(base, 'settings.json') : path.join(f.root, 'settings', 'workflow.json');
    const initial = await configureWorkflow({ configPath, expectedHash: null, proposal }, { platformFacts: f.facts });
    await prepareConfiguredStorage({ configPath, collectionId: 'test', expectedConfigHash: initial.configHash }, { platformFacts: f.facts });
    const raw = path.join(store, 'raw', 'evidence.json'); await fs.writeFile(raw, 'synthetic immutable evidence');
    const open = fs.open.bind(fs);
    t.mock.method(fs, 'open', async (file, ...args) => { assert.notEqual(file, raw, 'private contents must remain opaque'); return open(file, ...args); });
    const changed = structuredClone(initial.config); changed.routes.push({ ...changed.routes[0], id: 'another', projectRoot: path.join(f.root, 'another-project') });
    const saved = await configureWorkflow({ configPath, expectedHash: initial.configHash, proposal: changed }, { platformFacts: f.facts });
    assert.equal(saved.status, 'updated');
    t.mock.restoreAll();
    assert.equal(await fs.readFile(raw, 'utf8'), 'synthetic immutable evidence');
    await f.put(path.join(base, 'collections', 'unknown', 'state.json'), 'unknown state');
    changed.routes.push({ ...changed.routes[0], id: 'third', projectRoot: path.join(f.root, 'third-project') });
    await assert.rejects(configureWorkflow({ configPath, expectedHash: saved.configHash, proposal: changed }, { platformFacts: f.facts }), { code: 'WINDOWS_SETTINGS_UNRESOLVED' });
    assert.equal((await readWorkflowSnapshot(configPath)).hash, saved.configHash);
  }
});

test('case-varied first setup owns its stage by physical parent identity', { skip: process.platform === 'linux' }, async t => {
  const f = await fixture(t), configPath = path.join(f.local, 'cuefluentnotes', 'workflow.json');
  const result = await configureWorkflow({ configPath, expectedHash: null, proposal: f.config('new') }, { platformFacts: f.facts });
  assert.equal(result.status, 'initialized'); assert.deepEqual(await fs.readdir(path.dirname(f.oldConfig)), ['workflow.json']);
});

test('ordinary ancestor aliases remain usable for selected config and Local/Roaming discovery', async t => {
  const f = await fixture(t), real = path.join(f.root, 'actual'); await fs.mkdir(real);
  const alias = path.join(f.root, 'alias'); await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const configPath = path.join(alias, 'settings', 'workflow.json');
  const initial = await configureWorkflow({ configPath, expectedHash: null, proposal: f.config('new') }, { platformFacts: f.facts });
  assert.equal(initial.status, 'initialized'); assert.equal(initial.resolvedConfigPath, path.join(real, 'settings', 'workflow.json'));
  await prepareConfiguredStorage({ configPath, expectedConfigHash: initial.configHash, collectionId: 'test' }, { platformFacts: f.facts });
  // Simulate an 8.3/ancestor alias without pretending this is MSIX virtualization.
  const envAlias = path.join(f.root, 'environment'); await fs.symlink(f.root, envAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const facts = { ...f.facts, env: { LOCALAPPDATA: path.join(envAlias, 'Local'), APPDATA: path.join(envAlias, 'Roaming') } };
  await f.put(f.packageConfig(), f.config('other'));
  assert.equal((await discoverWindowsSettings(facts)).complete, true);
  for (const [base, kind] of [[f.local, 'Local'], [f.roaming, 'Roaming']]) {
    await fs.mkdir(path.join(f.pkg(), 'LocalCache', kind, 'Custom'), { recursive: true });
    await assert.rejects(windowsRootCreationSnapshot({ configPath, roots: [path.join(base, 'Custom', 'raw')] }, facts), { code: 'WINDOWS_STORAGE_SHADOW_CONFLICT' });
    await absent(path.join(base, 'Custom'));
  }
});

test('invalid competing settings use a discovery-specific error; explicit status tolerates unavailable AppData facts', async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'settings.json'), proposed = f.config('new');
  await f.put(configPath, proposed); await f.put(f.packageConfig(), '{invalid');
  await assert.rejects(preflightWindowsConfiguration({ configPath, proposed }, f.facts), { code: 'WINDOWS_SETTINGS_UNRESOLVED' });
  for (const env of [{}, { LOCALAPPDATA: 'relative' }]) {
    const status = await workflowStatus({ configPath }, { platform: 'win32', env });
    assert.equal(status.config.routes[0].id, 'test'); assert.equal(status.windowsStorage.status, 'unverified');
    assert.equal(status.windowsStorage.discovery.reason, 'WINDOWS_DISCOVERY_UNAVAILABLE');
  }
});

test('new profile default joins the bounded overlap set alongside the old real default', async t => {
  const f = await fixture(t), selected = path.join(f.root, 'explicit', 'workflow.json');
  await f.put(f.newConfig, f.config('new'));
  const inspect = proposal => preflightWindowsConfiguration({ configPath: selected, previous: null, proposed: proposal }, f.facts);
  await assert.rejects(inspect(f.config('new')), { code: 'WINDOWS_SETTINGS_OVERLAP' });
  await inspect(f.config('disjoint'));
  await f.put(f.oldConfig, f.config('old'));
  await assert.rejects(inspect(f.config('old')), { code: 'WINDOWS_SETTINGS_OVERLAP' });
  await assert.rejects(inspect(f.config('new')), { code: 'WINDOWS_SETTINGS_OVERLAP' });
  await inspect(f.config('disjoint'));
  assert.equal((await discoverWindowsSettings(f.facts)).candidates.filter(c => c.kind === 'config').length, 2);
});

test('routine Windows status does not enumerate packages; requested diagnostics report incomplete inventory', async t => {
  const f = await fixture(t); await f.put(f.oldConfig, f.config('existing')); await fs.mkdir(f.pkg(), { recursive: true });
  const opendir = fs.opendir.bind(fs); let scans = 0;
  t.mock.method(fs, 'opendir', (file, ...args) => {
    if (file === path.join(f.local, 'Packages')) { scans++; throw Object.assign(new Error('synthetic denied inventory'), { code: 'EACCES' }); }
    return opendir(file, ...args);
  });
  const status = await workflowStatus({ configPath: f.oldConfig }, f.facts);
  assert.equal(status.windowsStorage.status, 'ordinary'); assert.equal(scans, 0);
  assert.equal(status.windowsStorage.discovery, undefined);
  const detailed = await workflowStatus({ configPath: f.oldConfig, diagnostics: true }, f.facts);
  assert.equal(scans, 1); assert.equal(detailed.windowsStorage.discovery.complete, false);
});

test('discovery reuses pinned base resolution but detects an alias replacement', async t => {
  const f = await fixture(t), packages = path.join(f.local, 'Packages'), count = 150;
  for (let i = 0; i < count; i++) await fs.mkdir(f.pkg(`p${i}`), { recursive: true });
  const realpath = fs.realpath.bind(fs), lstat = fs.lstat.bind(fs); let baseResolutions = 0, metadataMillis = 0;
  const latency = t.mock.method(fs, 'lstat', (...args) => { metadataMillis += 2; return lstat(...args); });
  const spy = t.mock.method(fs, 'realpath', (file, ...args) => { if (file === packages) baseResolutions++; return realpath(file, ...args); });
  const inventory = await discoverWindowsSettings(f.facts, { check: discoveryBudget({ now: () => metadataMillis }) });
  assert.equal(inventory.complete, true, inventory.reason);
  assert(metadataMillis > 2000, 'exercise ordinary metadata work beyond the former two-second deadline');
  assert(baseResolutions <= count + 8, `repeated base resolution: ${baseResolutions}`);
  spy.mock.restore(); latency.mock.restore();
  const alias = path.join(f.root, 'alias'), other = path.join(f.root, 'other'); await fs.mkdir(other);
  await fs.symlink(packages, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const bases = new Map();
  await inspectWindowsPath(path.join(alias, 'p0'), { base: alias, bases });
  await fs.unlink(alias); await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectWindowsPath(path.join(alias, 'p0'), { base: alias, bases }), { code: 'WINDOWS_DISCOVERY_CHANGED' });
});

test('explicit discovery tolerates more than two seconds but retains a finite deadline', () => {
  let elapsed = 0; const check = discoveryBudget({ now: () => elapsed });
  elapsed = 2500; assert.doesNotThrow(check);
  elapsed = 30001; assert.throws(check, { code: 'WINDOWS_DISCOVERY_TIMEOUT' });
});

test('an unexplained stage in an uninitialized settings folder is not an owned setup exemption', async t => {
  const f = await fixture(t), stage = path.join(path.dirname(f.oldConfig), '.workflow-unknown.tmp');
  await f.put(stage, 'unknown state');
  await assert.rejects(configureWorkflow({ configPath: f.oldConfig, expectedHash: null, proposal: f.config('new') },
    { platformFacts: f.facts }), { code: 'WINDOWS_SETTINGS_UNRESOLVED' });
  assert.equal(await fs.readFile(stage, 'utf8'), 'unknown state');
});

test('custom Windows defaults do not strand storage in an unselected implicit settings location', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'custom', 'workflow.json');
  const proposal = f.config('new'), c = proposal.collections[0];
  const defaults = await workflowDefaults({ ...f.facts, explicit: configPath, collectionId: c.id });
  c.rawDir = defaults.rawDir; c.intakeStateDir = defaults.intakeStateDir; c.notes.writerStateDir = defaults.writerStateDir;
  assert(defaults.rawDir.startsWith(path.dirname(configPath) + path.sep));
  const saved = await configureWorkflow({ configPath, expectedHash: null, proposal }, { platformFacts: f.facts });
  await prepareConfiguredStorage({ configPath, expectedConfigHash: saved.configHash, collectionId: c.id }, { platformFacts: f.facts });
  const removed = await configureWorkflow({ configPath, expectedHash: saved.configHash,
    proposal: { ...proposal, collections: [], routes: [] } }, { platformFacts: f.facts });
  const added = await configureWorkflow({ configPath, expectedHash: removed.configHash, proposal: f.config('other') }, { platformFacts: f.facts });
  assert.equal(added.status, 'updated'); assert((await fs.stat(c.rawDir)).isDirectory());
  await absent(path.dirname(f.newConfig));
});
