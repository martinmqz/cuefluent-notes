import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPlan, inspectDirectories, inspectState, fingerprint, recover, abortUpdate } from './safe-update.mjs';

async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-folder-review-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'notes');
  const stateDir = path.join(temp, 'state');
  await fs.mkdir(root);
  const contentPath = path.join(temp, 'proposal.md');
  await fs.writeFile(contentPath, '# Meeting\n\n## Decision\n\nA synthetic decision.\n');
  const plan = { version: 2, mode: 'authored', stateDir,
    ...await inspectDirectories(root, ['meetings/topic.md']), files: [{ path: 'meetings/topic.md', expectedHash: null, contentPath }] };
  const interrupt = async () => {
    await assert.rejects(applyPlan(plan, { afterStage() { throw new Error('Interrupted'); } }), /Interrupted/);
    const inspected = await inspectState(stateDir);
    return { version: 1, stateDir, expectedJournalHash: inspected.journalHash, expectedManifestHash: inspected.manifestHash, preserveStages: true };
  };
  return { temp, root, stateDir, plan, interrupt };
}

test('malformed v2 file entries report a path error before creating state or categories', async t => {
  const f = await fixture(t);
  for (const file of [null, undefined, false, 2, 'topic.md', [], {}, { path: null }]) {
    await assert.rejects(applyPlan({ ...f.plan, files: [file] }), error => !(error instanceof TypeError) && /normalized relative/.test(error.message));
    assert.deepEqual(await fs.readdir(f.root), []);
    await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  }
});

test('existing capitalized category paths are reusable; new categories keep lowercase defaults', async t => {
  const f = await fixture(t);
  for (const name of ['Meetings', 'Tasks', 'Knowledge-Base', 'Decisions']) {
    const relative = `${name}/topic.md`;
    await assert.rejects(inspectDirectories(f.root, [relative]), /explicit category creations/);
    await fs.mkdir(path.join(f.root, name));
    const selected = await inspectDirectories(f.root, [relative]);
    assert.deepEqual(selected.createDirectories, []);
    const plan = { ...f.plan, ...selected, files: [{ ...f.plan.files[0], path: relative }] };
    assert.deepEqual((await applyPlan(plan)).updated, [relative]);
    assert.equal(await fs.readFile(path.join(f.root, relative), 'utf8'), await fs.readFile(plan.files[0].contentPath, 'utf8'));
  }
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['Decisions', 'Knowledge-Base', 'Meetings', 'Tasks']);
});

test('changed directories remain inspectable and reviewed preservation aborts touch no notes or stages', async t => {
  for (const kind of ['category', 'root', 'missing-root', 'link', 'device']) {
    const f = await fixture(t);
    const abort = await f.interrupt();
    const journalPath = path.join(f.stateDir, 'journal.json');
    const journalBytes = await fs.readFile(journalPath);
    const journal = JSON.parse(journalBytes);
    const stage = journal.files[0].stagePath;
    const stageBytes = await fs.readFile(stage);
    let retainedStage = stage;
    let deviceSpy;
    if (kind === 'category' || kind === 'link') {
      const moved = path.join(f.temp, 'old-category');
      await fs.rename(path.dirname(stage), moved);
      retainedStage = path.join(moved, path.basename(stage));
      if (kind === 'link') await fs.symlink(moved, path.dirname(stage), process.platform === 'win32' ? 'junction' : 'dir');
      else { await fs.mkdir(path.dirname(stage)); await fs.writeFile(stage, 'unfamiliar stage'); }
    } else if (kind === 'root' || kind === 'missing-root') {
      const moved = path.join(f.temp, 'old-root');
      await fs.rename(f.root, moved);
      retainedStage = path.join(moved, path.relative(f.root, stage));
      if (kind === 'root') await fs.mkdir(f.root);
    } else {
      const lstat = fs.lstat.bind(fs);
      deviceSpy = t.mock.method(fs, 'lstat', async (file, ...args) => {
        const stat = await lstat(file, ...args);
        if (file === f.root) stat.dev += typeof stat.dev === 'bigint' ? 1n : 1;
        return stat;
      });
    }
    const open = fs.open.bind(fs);
    let noteReads = 0;
    const readSpy = t.mock.method(fs, 'open', async (file, ...args) => {
      if (typeof file === 'string' && (file === f.root || file.startsWith(f.root + path.sep))) noteReads++;
      return open(file, ...args);
    });
    const inspected = await inspectState(f.stateDir);
    assert.equal(inspected.recoveryPending, true);
    assert.equal(inspected.journalHash, abort.expectedJournalHash);
    assert.equal(typeof inspected.directoryConflict, 'string');
    assert.equal(inspected.stages[0].hash, undefined);
    assert.equal(inspected.pendingOutputs[0].hash, undefined);
    await assert.rejects(recover(f.stateDir));
    await assert.rejects(abortUpdate({ ...abort, expectedJournalHash: '0'.repeat(64) }), /changed since inspection/);
    const result = await abortUpdate(abort);
    assert.equal(result.status, 'aborted');
    assert.equal(result.preservedStages, true);
    assert.equal(noteReads, 0);
    assert.deepEqual(await fs.readFile(result.archivedJournal), journalBytes);
    assert.equal(await fingerprint(journalPath), null);
    assert.equal((await inspectState(f.stateDir)).recoveryPending, false);
    readSpy.mock.restore();
    deviceSpy?.mock.restore();
    assert.deepEqual(await fs.readFile(retainedStage), stageBytes);
    if (kind === 'category') assert.equal(await fs.readFile(stage, 'utf8'), 'unfamiliar stage');
  }
});

test('preservation abort keeps its archive across interruption and refuses altered archives or mixed cleanup requests', async t => {
  const f = await fixture(t);
  const plan = await f.interrupt();
  const journal = path.join(f.stateDir, 'journal.json');
  const before = await fs.readFile(journal);
  const archive = path.join(f.stateDir, `aborted-journal-${plan.expectedJournalHash}.json`);
  await assert.rejects(abortUpdate({ ...plan, files: [] }), /omit file and stage/);
  await fs.writeFile(archive, 'preserve unrelated data');
  await assert.rejects(abortUpdate(plan), /different bytes/);
  assert.deepEqual(await fs.readFile(journal), before);
  await fs.unlink(archive); // Disposable conflicting fixture, not a recovery procedure.
  const unlink = fs.unlink.bind(fs);
  const spy = t.mock.method(fs, 'unlink', async file => {
    if (file === journal) throw new Error('Interrupted before release');
    return unlink(file);
  });
  await assert.rejects(abortUpdate(plan), /Interrupted before release/);
  assert.deepEqual(await fs.readFile(archive), before);
  assert.deepEqual(await fs.readFile(journal), before);
  spy.mock.restore();
  assert.equal((await abortUpdate(plan)).archivedJournal, archive);
  assert.equal(await fingerprint(journal), null);
});

test('a source change between category creations stops the batch before creating the next folder', async t => {
  const f = await fixture(t);
  const source = path.join(f.temp, 'source.md');
  await fs.writeFile(source, 'Original evidence.');
  const second = path.join(f.temp, 'second.md');
  await fs.copyFile(f.plan.files[0].contentPath, second);
  f.plan.files.push({ ...f.plan.files[0], path: 'tasks/topic.md', contentPath: second });
  Object.assign(f.plan, await inspectDirectories(f.root, f.plan.files.map(file => file.path)));
  f.plan.files[0].sources = [{ path: source, expectedHash: await fingerprint(source) }];
  const mkdir = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (file, ...args) => {
    const value = await mkdir(file, ...args);
    if (file === path.join(f.root, 'meetings')) await fs.writeFile(source, 'Changed evidence.');
    return value;
  });
  await assert.rejects(applyPlan(f.plan), /source changed/);
  assert.deepEqual(await fs.readdir(f.root), ['meetings']);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});

test('preservation abort rejects malformed or legacy journals without altering evidence', async t => {
  const f = await fixture(t);
  const plan = await f.interrupt();
  const journalPath = path.join(f.stateDir, 'journal.json');
  const original = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const stageBytes = await fs.readFile(original.files[0].stagePath);
  const stateBefore = await fs.readdir(f.stateDir);
  for (const mutate of [
    journal => { journal.version = 1; delete journal.directories; },
    journal => { journal.root = 'relative'; },
    journal => { journal.root = f.stateDir; },
    journal => { journal.directories[0].identity = null; },
    journal => { journal.files[0].path = '../outside.md'; },
    journal => { journal.files[0].stagePath = path.join(f.temp, 'unrelated.tmp'); },
    journal => { journal.files[0] = null; },
  ]) {
    const journal = structuredClone(original);
    mutate(journal);
    const bytes = Buffer.from(JSON.stringify(journal));
    await fs.writeFile(journalPath, bytes);
    const expectedJournalHash = await fingerprint(journalPath);
    await assert.rejects(abortUpdate({ ...plan, expectedJournalHash }));
    assert.deepEqual(await fs.readFile(journalPath), bytes);
    assert.deepEqual(await fs.readFile(original.files[0].stagePath), stageBytes);
    assert.deepEqual(await fs.readdir(f.stateDir), stateBefore);
  }
});

test('preservation abort retains the active journal if state changes during archival', async t => {
  for (const kind of ['journal', 'manifest']) {
    const f = await fixture(t);
    const plan = await f.interrupt();
    const journalPath = path.join(f.stateDir, 'journal.json');
    const original = await fs.readFile(journalPath);
    const open = fs.open.bind(fs);
    let archivePath;
    const spy = t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (typeof file === 'string' && path.basename(file).startsWith('aborted-journal-') && args[0] === 'wx') {
        archivePath = file;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          await fs.writeFile(path.join(f.stateDir, `${kind}.json`), kind === 'journal' ? Buffer.concat([original, Buffer.from('\n')]) : '{}');
        };
      }
      return handle;
    });
    await assert.rejects(abortUpdate(plan), /state changed/);
    spy.mock.restore();
    assert.deepEqual(await fs.readFile(archivePath), original);
    assert.deepEqual(await fs.readFile(journalPath), kind === 'journal' ? Buffer.concat([original, Buffer.from('\n')]) : original);
    if (kind === 'manifest') assert.equal(await fs.readFile(path.join(f.stateDir, 'manifest.json'), 'utf8'), '{}');
  }
});

test('metadata stage cleanup never overrides the shared ownership check', async t => {
  for (const failWrite of [true, false]) {
    const f = await fixture(t);
    const open = fs.open.bind(fs);
    let changedStage;
    const spy = t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (typeof file === 'string' && path.basename(file).startsWith('.metadata-') && args[0] === 'wx') {
        changedStage = file;
        if (failWrite) handle.writeFile = async () => { throw new Error('Synthetic metadata failure'); };
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          await fs.writeFile(file, 'Unfamiliar edited metadata');
        };
      }
      return handle;
    });
    await assert.rejects(applyPlan(f.plan), failWrite ? /Synthetic metadata failure/ : /Metadata stage ownership changed/);
    spy.mock.restore();
    assert.equal(await fs.readFile(changedStage, 'utf8'), 'Unfamiliar edited metadata');
    assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'meetings')), []);
  }
});
