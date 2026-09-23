import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPlan, inspectDirectories, fingerprint, inspectState, recover, abortUpdate, withLock } from './safe-update.mjs';
import { captureSettings } from './capture-policy.mjs';

async function fixture(t, names = ['meetings/topic.md']) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-categories-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'notes');
  const stateDir = path.join(temp, 'state');
  await fs.mkdir(root);
  const files = [];
  for (const [index, name] of names.entries()) {
    const contentPath = path.join(temp, `proposal-${index}.md`);
    await fs.writeFile(contentPath, `# Synthetic meeting\n\n## Finding ${index}\n\nKeep the tested decision.\n`);
    files.push({ path: name, expectedHash: null, contentPath });
  }
  const plan = { version: 2, mode: 'authored', confirmCompatibleReaders: true, stateDir, ...await inspectDirectories(root, names), files };
  return { temp, root, stateDir, plan };
}
const recheck = async f => {
  Object.assign(f.plan, await inspectDirectories(f.root, f.plan.files.map(file => file.path)));
  for (const file of f.plan.files) file.expectedHash = await fingerprint(path.join(f.root, file.path));
};
async function abortPlan(stateDir) {
  const inspected = await inspectState(stateDir);
  return { version: 1, stateDir, expectedJournalHash: inspected.journalHash, expectedManifestHash: inspected.manifestHash,
    files: inspected.pendingOutputs.map(file => ({ path: file.path, expectedHash: file.hash })),
    stages: inspected.stages.map(file => ({ path: file.path, expectedHash: file.hash })) };
}

test('inspection is read-only and approved category writes share state with root notes and no-op updates', async t => {
  const f = await fixture(t, ['meetings/topic.md', 'tasks/work.md', 'knowledge-base/cache.md', 'decisions/ttl.md', 'general.md']);
  assert.deepEqual(await fs.readdir(f.root), []);
  await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  const result = await applyPlan(f.plan);
  assert.deepEqual(result.createdDirectories, ['decisions', 'knowledge-base', 'meetings', 'tasks']);
  assert.deepEqual(result.updated, f.plan.files.map(file => file.path));
  for (const name of result.createdDirectories) assert.equal((await fs.stat(path.join(f.root, name))).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o700);
  const identities = (await inspectDirectories(f.root, f.plan.files.map(file => file.path))).directories;
  await recheck(f);
  const target = path.join(f.root, 'meetings/topic.md');
  const before = await fs.stat(target, { bigint: true });
  assert.equal((await applyPlan(f.plan)).status, 'unchanged');
  assert.equal((await fs.stat(target, { bigint: true })).mtimeNs, before.mtimeNs);
  await fs.appendFile(f.plan.files[0].contentPath, '\nA supported clarification.\n');
  assert.deepEqual((await applyPlan(f.plan)).updated, ['meetings/topic.md']);
  assert.deepEqual((await inspectDirectories(f.root, f.plan.files.map(file => file.path))).directories, identities);
  assert.equal((await inspectState(f.stateDir)).recoveryPending, false);
});

test('root-only v2 works; v1 missing parents and derived directory intents are refused', async t => {
  const rootOnly = await fixture(t, ['general.md']);
  assert.deepEqual((await applyPlan(rootOnly.plan)).createdDirectories, []);
  const f = await fixture(t);
  const { directories, createDirectories, ...old } = f.plan;
  await assert.rejects(applyPlan({ ...old, version: 1 }), /parent directories must already exist/);
  await assert.rejects(applyPlan({ ...f.plan, version: 1 }), /Directory intents/);
  await assert.rejects(applyPlan({ ...f.plan, mode: 'derived', expectedManifestHash: null }), /authored mode/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('invalid directory intents and overlapping state cannot create categories', async t => {
  const f = await fixture(t);
  const bad = [
    { createDirectories: ['meetings', 'meetings'] }, { createDirectories: ['tasks'] }, { createDirectories: [] },
    { createDirectories: ['../meetings'] }, { createDirectories: ['meetings/child'] },
    { directories: f.plan.directories.slice(1) }, { directories: [...f.plan.directories, f.plan.directories[0]] },
    { directories: f.plan.directories.map(item => ({ ...item, identity: 'invalid' })) },
    { files: [{ ...f.plan.files[0], path: 'meetings/deeper/topic.md' }] },
    { files: [{ ...f.plan.files[0], path: 'other/topic.md' }] },
    { stateDir: path.join(f.root, 'meetings/state') }, { stateDir: f.root }, { stateDir: f.temp },
  ];
  for (const change of bad) {
    await assert.rejects(applyPlan({ ...f.plan, ...change }));
    assert.deepEqual(await fs.readdir(f.root), []);
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  }
});

test('full batch content, output hashes and source checks precede any category creation', async t => {
  for (const fault of ['bad content', 'bad later hash', 'missing source', 'duplicate proposal']) {
    const f = await fixture(t, ['meetings/first.md', 'tasks/second.md']);
    const later = f.plan.files[1];
    if (fault === 'bad content') await fs.writeFile(later.contentPath, '# No searchable sections\n');
    if (fault === 'bad later hash') later.expectedHash = '0'.repeat(64);
    if (fault === 'missing source') later.sources = [{ path: path.join(f.temp, 'missing.md'), expectedHash: '0'.repeat(64) }];
    if (fault === 'duplicate proposal') later.contentPath = f.plan.files[0].contentPath;
    await assert.rejects(applyPlan(f.plan));
    assert.deepEqual(await fs.readdir(f.root), []);
    assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
  }
  const f = await fixture(t, Array.from({ length: 70 }, (_, i) => `meetings/note-${i}.md`));
  for (const [i, file] of f.plan.files.entries()) file.entries = Array.from({ length: 1000 }, () => ({ heading: `Finding ${i}`, sourcePaths: [] }));
  await assert.rejects(applyPlan(f.plan), /journal exceeds/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('appearing folders, occupied names, links and replaced roots/parents invalidate the inspected selection', async t => {
  for (const kind of ['appeared', 'file', 'link', 'root', 'parent']) {
    const f = await fixture(t);
    const selected = path.join(f.root, 'meetings');
    if (kind === 'appeared') await fs.mkdir(selected);
    if (kind === 'file') await fs.writeFile(selected, 'keep');
    if (kind === 'link') await fs.symlink(f.temp, selected, process.platform === 'win32' ? 'junction' : 'dir');
    if (kind === 'root') { await fs.rename(f.root, path.join(f.temp, 'old-notes')); await fs.mkdir(f.root); }
    if (kind === 'parent') {
      await fs.mkdir(selected); await recheck(f);
      await fs.rename(selected, path.join(f.temp, 'old-parent')); await fs.mkdir(selected);
    }
    await assert.rejects(applyPlan(f.plan), /directory|root/i);
    assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  }
});

test('existing category aliases must use canonical spelling on aliasing filesystems', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'Meetings'));
  const alias = await fs.stat(path.join(f.root, 'meetings')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!alias) { t.skip('Selected filesystem distinguishes category case.'); return; }
  await assert.rejects(inspectDirectories(f.root, ['meetings/topic.md']), /canonically/);
  await assert.rejects(applyPlan(f.plan));
  assert.deepEqual(await fs.readdir(f.root), ['Meetings']);
});

test('folder creation failure reports preserved directories and does not stage notes', async t => {
  const f = await fixture(t, ['meetings/first.md', 'tasks/second.md']);
  const mkdir = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (file, ...args) => {
    if (file === path.join(f.root, 'tasks')) throw Object.assign(new Error('Synthetic mkdir denied'), { code: 'EACCES' });
    return mkdir(file, ...args);
  });
  await assert.rejects(applyPlan(f.plan), error => {
    assert.deepEqual(error.createdDirectories, ['meetings']);
    return /mkdir denied/.test(error.message);
  });
  assert.deepEqual(await fs.readdir(f.root), ['meetings']);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'meetings')), []);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});

test('mkdir never adopts a folder that appears after the last absence check', async t => {
  const f = await fixture(t);
  const mkdir = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (file, ...args) => {
    if (file === path.join(f.root, 'meetings')) {
      await mkdir(file); await fs.writeFile(path.join(file, 'user.txt'), 'preserve');
    }
    return mkdir(file, ...args);
  });
  await assert.rejects(applyPlan(f.plan), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(path.join(f.root, 'meetings')), ['user.txt']);
});

test('new journals recover partial replacements and block capture while pending', async t => {
  const f = await fixture(t, ['meetings/first.md', 'tasks/second.md']);
  await assert.rejects(applyPlan(f.plan, { afterReplace() { throw new Error('Interrupted'); } }), /Interrupted/);
  const journal = JSON.parse(await fs.readFile(path.join(f.stateDir, 'journal.json')));
  assert.equal(journal.version, 2);
  assert.ok(journal.directories.every(item => typeof item.identity === 'string'));
  await assert.rejects(captureSettings('codex', f.temp, { version: 4, minimumPluginVersion: '0.7.0', completionCheck: false,
    enabled: true, clients: ['codex'], automaticUpdates: false, scope: 'Synthetic.',
    routes: [{ projectRoot: f.temp, notesDir: f.root, stateDir: f.stateDir, organization: 'by-type' }] }), { code: 'STATE_RECOVERY_REQUIRED' });
  assert.deepEqual((await recover(f.stateDir)).updated, ['tasks/second.md']);
  assert.equal((await inspectState(f.stateDir)).recoveryPending, false);
});

test('staging abort preserves created folders and unrelated contents', async t => {
  const f = await fixture(t, ['meetings/first.md', 'tasks/second.md']);
  await assert.rejects(applyPlan(f.plan, { afterStage() { throw new Error('Interrupted staging'); } }), /Interrupted/);
  const user = path.join(f.root, 'meetings/user.txt');
  await fs.writeFile(user, 'user content');
  await assert.rejects(recover(f.stateDir), /missing or changed/);
  assert.equal((await abortUpdate(await abortPlan(f.stateDir))).status, 'aborted');
  assert.deepEqual(await fs.readdir(f.root), ['meetings', 'tasks']);
  assert.equal(await fs.readFile(user, 'utf8'), 'user content');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'tasks')), []);
});

test('recovery and abort reject a replaced real parent even if copied stage bytes match', async t => {
  const f = await fixture(t);
  await assert.rejects(applyPlan(f.plan, { afterStage() { throw new Error('Interrupted'); } }));
  const abort = await abortPlan(f.stateDir);
  const original = path.join(f.root, 'meetings');
  const moved = path.join(f.temp, 'old-meetings');
  await fs.rename(original, moved);
  await fs.cp(moved, original, { recursive: true });
  const entries = await fs.readdir(original);
  await assert.rejects(recover(f.stateDir), /directory changed/);
  await assert.rejects(abortUpdate(abort), /directory changed/);
  assert.deepEqual(await fs.readdir(original), entries);
  assert.deepEqual(await fs.readdir(moved), entries);
  assert.notEqual(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});

test('failed stage write never removes an unfamiliar replacement parent entry', async t => {
  const f = await fixture(t);
  const open = fs.open.bind(fs);
  let replacement;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (path.basename(String(file)).startsWith('.cuefluent-stage-') && args[0] === 'wx') {
      handle.writeFile = async () => { throw new Error('Synthetic stage failure'); };
      const close = handle.close.bind(handle);
      handle.close = async () => {
        // Windows refuses moving a directory containing an open stage. Swap
        // after close but before error-path cleanup on every platform.
        await close();
        const parent = path.dirname(file);
        await fs.rename(parent, path.join(f.temp, 'moved-parent'));
        await fs.mkdir(parent);
        replacement = file;
        await fs.writeFile(file, 'unfamiliar file');
      };
    }
    return handle;
  });
  await assert.rejects(applyPlan(f.plan), error => /Synthetic stage failure/.test(error.message) && error.cleanupWarnings?.length === 1);
  assert.equal(await fs.readFile(replacement, 'utf8'), 'unfamiliar file');
  assert.notEqual(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});

test('category creation observes the existing collection lock', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.stateDir);
  await withLock(f.stateDir, async () => {
    await assert.rejects(applyPlan(f.plan), /locked/);
    assert.deepEqual(await fs.readdir(f.root), []);
    return {};
  });
});
