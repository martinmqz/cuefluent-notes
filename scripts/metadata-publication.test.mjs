import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { inspectIntakeStore, withIntakeLock, replaceIntakeJSON, intakeSnapshot } from './intake-io.mjs';
import { publishWriterReceipt } from './writer-protocol.mjs';
import { publishIngressMetadata } from './collection-ingress.mjs';
import { readProcessingState, processingSnapshot } from './processing-state.mjs';
import { validatePluginManifest } from './plugin-manifest.mjs';
import { evidenceCollector } from './capture-evidence.mjs';

const coordination = f => ({ binding: { operationId: randomUUID(), proposalHash: 'a'.repeat(64), inputsHash: 'b'.repeat(64),
  collectionHash: 'c'.repeat(64), root: path.join(f.root, 'notes'), stateDir: f.collection.notes.writerStateDir }, transactionHash: 'd'.repeat(64) });

test('partial writer receipt failures retain their original error and incomplete bytes', async t => {
  const f = await storageFixture(t, { fullSetup: false }), open = fs.open, error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  let partial;
  fs.open = async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (flags === 'wx' && path.basename(file) === 'record.json' && path.basename(path.dirname(file)).startsWith('.write-')) {
      partial = file; const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { await write(bytes.subarray(0, 7)); throw error; };
    }
    return handle;
  };
  try { await assert.rejects(publishWriterReceipt(coordination(f), [{ path: 'note.md', hash: 'e'.repeat(64) }], null, async () => {}, async () => {}), actual => actual === error); }
  finally { fs.open = open; }
  assert.equal((await fs.readFile(partial)).length, 7);
  assert.match(error.cleanupWarnings.join('\n'), /Writer receipt stage retained/);
});

for (const code of ['EMFILE', 'ENOSPC']) {
  test(`writer receipt ${code} open failure removes its empty owned stage`, async t => {
    const f = await storageFixture(t, { fullSetup: false }), open = fs.open, error = Object.assign(new Error('open failed'), { code });
    let stage;
    fs.open = async (file, flags, ...args) => {
      if (flags === 'wx' && path.basename(file) === 'record.json' && path.basename(path.dirname(file)).startsWith('.write-')) {
        stage = path.dirname(file); throw error;
      }
      return open(file, flags, ...args);
    };
    try { await assert.rejects(publishWriterReceipt(coordination(f), [{ path: 'note.md', hash: 'e'.repeat(64) }], null, async () => {}, async () => {}), actual => actual === error); }
    finally { fs.open = open; }
    assert(stage); await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
    assert.equal(error.cleanupWarnings, undefined);
  });
}

for (const reason of ['guard', 'unfamiliar', 'replaced']) {
  test(`writer receipt reports a retained empty-open stage after ${reason} changes`, async t => {
    const f = await storageFixture(t, { fullSetup: false }), open = fs.open, error = Object.assign(new Error('open failed'), { code: 'EMFILE' });
    let stage;
    fs.open = async (file, flags, ...args) => {
      if (flags === 'wx' && path.basename(file) === 'record.json' && path.basename(path.dirname(file)).startsWith('.write-')) {
        stage = path.dirname(file);
        if (reason === 'unfamiliar') await fs.writeFile(path.join(stage, 'other.json'), 'preserve me', { mode: 0o600 });
        throw error;
      }
      return open(file, flags, ...args);
    };
    const guard = async () => {
      if (!stage) return;
      if (reason === 'guard') throw new Error('permission changed');
      if (reason === 'replaced') { await fs.rename(stage, stage + '.original'); await fs.mkdir(stage, { mode: 0o700 }); }
    };
    try { await assert.rejects(publishWriterReceipt(coordination(f), [{ path: 'note.md', hash: 'e'.repeat(64) }], null, guard, async () => {}), actual => actual === error); }
    finally { fs.open = open; }
    assert((await fs.lstat(stage)).isDirectory());
    assert.match(error.cleanupWarnings.join('\n'), /Writer receipt stage retained/);
    if (reason === 'unfamiliar') assert.equal(await fs.readFile(path.join(stage, 'other.json'), 'utf8'), 'preserve me');
  });
}

test('exclusive ingress preserves an unfamiliar stage without masking an existing registration', async t => {
  const f = await storageFixture(t), store = await inspectIntakeStore(f.collection);
  const destination = 'ingress/registrations/codex/aa/example/record.json';
  await publishIngressMetadata(store, destination, { existing: true }, { exclusive: true });
  const lstat = fs.lstat, readdir = fs.readdir; let altered;
  fs.lstat = async (file, ...args) => {
    if (!altered && file === path.dirname(path.join(f.collection.intakeStateDir, destination))) {
      const names = await readdir(path.join(f.collection.intakeStateDir, 'ingress/stages'));
      if (names.length) { altered = path.join(f.collection.intakeStateDir, 'ingress/stages', names[0], 'record.json'); await fs.writeFile(altered, 'unfamiliar'); }
    }
    return lstat(file, ...args);
  };
  try { assert.equal(await publishIngressMetadata(store, destination, { new: true }, { exclusive: true }), false); }
  finally { fs.lstat = lstat; }
  assert.equal(await fs.readFile(altered, 'utf8'), 'unfamiliar');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.collection.intakeStateDir, destination))), { existing: true });
});

test('repeated nested intake metadata replacement leaves intake root timestamps stable', async t => {
  const f = await storageFixture(t, { fullSetup: false }), store = await inspectIntakeStore(f.collection);
  await withIntakeLock(store, async tx => {
    let hash = await replaceIntakeJSON(tx, 'sample/value.json', { number: 0 }, null);
    const before = await fs.lstat(store.intakeStateDir, { bigint: true });
    for (let number = 1; number <= 4; number++) hash = await replaceIntakeJSON(tx, 'sample/value.json', { number }, hash);
    const after = await fs.lstat(store.intakeStateDir, { bigint: true });
    for (const key of ['ctimeNs', 'mtimeNs', 'nlink']) assert.equal(after[key], before[key]);
    assert.deepEqual(await fs.readdir(path.join(store.intakeStateDir, 'metadata-stages')), []);
  });
});

test('processing metadata reads retain privacy checks without repeating policy loading', async t => {
  const f = await storageFixture(t, { fullSetup: false }), open = fs.open; let reads = 0;
  fs.open = async (file, ...args) => { if (file === f.options.configPath) reads++; return open(file, ...args); };
  try {
    const ctx = await readProcessingState(f.capability, null, 'maintenance');
    assert.equal(reads, 2, 'one initial snapshot and one final placement verification');
    reads = 0;
    await processingSnapshot(ctx, 'absent.json'); await processingSnapshot(ctx, 'other.json');
    assert.equal(reads, 0);
    if (process.platform !== 'win32') {
      const file = path.join(f.collection.notes.writerStateDir, 'unprivate.json'); await fs.writeFile(file, '{}', { mode: 0o644 });
      await assert.rejects(processingSnapshot(ctx, 'unprivate.json'), /STORAGE_NOT_PRIVATE/);
    }
    await fs.writeFile(f.options.configPath, JSON.stringify({ ...f.config, routes: [] }));
    await assert.rejects(ctx.guard(), /WORKFLOW_POLICY_CHANGED/);
  } finally { fs.open = open; }
});

test('manifest objects reject nonplain prototypes while JSON manifests remain valid', () => {
  const value = { name: 'cuefluent-notes', version: '1.0.0', description: 'Knowledge notes', author: { name: 'Example' } };
  validatePluginManifest(value, 'claude');
  assert.throws(() => validatePluginManifest(Object.assign(Object.create({ inherited: true }), value), 'claude'));
  assert.throws(() => validatePluginManifest({ ...value, author: Object.assign(Object.create({}), value.author) }, 'claude'));
});

test('reusable and omitted attachment captions share Unicode clipping and NUL handling', () => {
  const record = { id: 'row', startByte: 0, endByte: 100 }, caption = '\0' + '會'.repeat(300);
  const retained = evidenceCollector(), omitted = evidenceCollector();
  retained.add('attachment', record, { reference: 'image.png', caption });
  omitted.add('attachment', record, { reference: 'data:image/png;base64,AA', caption });
  const note = omitted.omissions.find(item => item.reason === 'inline-attachment-not-copied');
  assert.equal(retained.evidence[0].caption, note.caption);
  assert(Buffer.byteLength(note.caption) <= 512); assert(!note.caption.includes('\0'));
  assert.deepEqual(retained.omissions, omitted.omissions.filter(item => item.reason !== 'inline-attachment-not-copied'));
});

test('configured direct saves reject changed staging permissions before writing private metadata', { skip: process.platform === 'win32' }, async t => {
  const f = await storageFixture(t, { fullSetup: false }), { saveDirectNote } = await import('./direct-save.mjs'), { digest, canonicalJSON } = await import('./workflow-values.mjs');
  await fs.mkdir(f.collection.notes.notesDir);
  const contentPath = path.join(f.root, 'proposal.md'), bytes = '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n';
  await fs.writeFile(contentPath, bytes);
  const plan = { version: 1, mode: 'authored', root: f.collection.notes.notesDir, stateDir: f.collection.notes.writerStateDir,
    files: [{ path: 'meeting.md', expectedHash: null, contentPath, expectedContentHash: digest(bytes) }] };
  await fs.chmod(path.join(plan.stateDir, 'metadata-stages'), 0o755);
  await assert.rejects(saveDirectNote({ plan, approvedPlanHash: digest(canonicalJSON(plan)) }, f.capability), /STORAGE_NOT_PRIVATE/);
  assert.deepEqual(await fs.readdir(path.join(plan.stateDir, 'metadata-stages')), []);
  await assert.rejects(fs.stat(path.join(plan.root, 'meeting.md')), { code: 'ENOENT' });
});

test('a state replacement waits out another reader\'s brief open and refuses a long one unchanged', async t => {
  const f = await storageFixture(t), store = await inspectIntakeStore(f.collection), name = 'review-state/held-open.json';
  const target = path.join(f.collection.intakeStateDir, ...name.split('/')), stages = path.join(f.collection.intakeStateDir, 'metadata-stages');
  const replace = async version => withIntakeLock(store, async tx =>
    replaceIntakeJSON(tx, name, { version }, (await intakeSnapshot(store, 'state', name)).hash));
  await replace(1);
  // Another process reads the file without the lock. Windows refuses to
  // replace it while that read is open; elsewhere the replacement goes ahead.
  const holdFor = async ms => { const handle = await fs.open(target, 'r'); return new Promise(resolve => setTimeout(() => handle.close().then(resolve), ms)); };
  let closed = holdFor(100);
  await replace(2); await closed;
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { version: 2 });
  // A long open lasts until the replacement has given up, however slowly
  // the runner reaches it: the bounded retry cannot outwait it.
  const held = await fs.open(target, 'r');
  try {
    if (process.platform === 'win32') {
      await assert.rejects(replace(3), { code: 'EPERM' });
      assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { version: 2 });
    } else await replace(3);
  } finally { await held.close(); }
  assert.deepEqual(await fs.readdir(stages), []);
});
