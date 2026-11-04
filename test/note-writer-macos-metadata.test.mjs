import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pinDirectory } from '../src/storage/paths.mjs';
import { hashBytes } from '../src/storage/files.mjs';
import { prepareNotePublication, publishNotePublication } from '../src/storage/note-writer.mjs';
import { readMacosAcl as acl, readMacosAttribute as attribute } from './support/macos-note-metadata.mjs';

const execute = promisify(execFile);
const before = Buffer.from('# Native metadata fixture\n\nOriginal synthetic content.\n');
const after = Buffer.from('# Native metadata fixture\n\nExact synthetic update.\n');
const macTest = (name, fn) => test(name, { skip: process.platform !== 'darwin', timeout: 30_000 }, fn);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-native-note-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = path.join(await fs.realpath(root), 'notes');
  await fs.mkdir(notes);
  const target = path.join(notes, 'note.md');
  await fs.writeFile(target, before);
  await fs.chmod(target, 0o640);
  const pin = await pinDirectory(notes);
  const prepare = (draft = after) => prepareNotePublication(pin, 'note.md', draft, {
    runId: randomUUID(), draftId: randomUUID(), expectedHash: hashBytes(before), hash: hashBytes(draft),
  });
  return { root, notes, target, pin, prepare };
}

async function save(f, options = {}) {
  const intent = await f.prepare();
  const result = await publishNotePublication(f.pin, intent, after, { persistIntent: async () => {}, ...options });
  assert.equal(result.changed, true);
  assert.deepEqual(await fs.readFile(f.target), after);
  assert.deepEqual(await fs.readdir(f.notes), ['note.md']);
}

async function saveWithCreationAttribute(f, name = 'com.apple.quarantine') {
  let tagged = false;
  await save(f, {
    persistIntent: async intent => {
      if (tagged) return;
      const stage = path.join(f.notes, `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`);
      assert.deepEqual(await fs.readFile(stage), Buffer.alloc(0));
      // Model an app tagging the just-created inode, before native cloning.
      // This is not an edit after the completed-stage publication fence.
      await execute('/usr/bin/xattr', ['-w', name, '0083;69000001;SyntheticHost;', stage]);
      tagged = true;
    },
  });
  assert.equal(tagged, true);
  assert.ok(!(await execute('/usr/bin/xattr', [f.target])).stdout.split('\n').includes(name));
}

macTest('macOS updates retain the exact original quarantine bytes', async t => {
  const f = await fixture(t), name = 'com.apple.quarantine';
  await execute('/usr/bin/xattr', ['-w', name, '0083;69000001;CuefluentFixture;', f.target]);
  const original = await attribute(f.target, name);
  assert.ok(original.length > 0);
  await save(f);
  assert.equal(await attribute(f.target, name), original);
});

macTest('macOS restores quarantine before reinstating an owner writeextattr deny ACL', async t => {
  const f = await fixture(t), name = 'com.apple.quarantine';
  await execute('/usr/bin/xattr', ['-w', name, '0083;69000001;Safari;', f.target]);
  await execute('/bin/chmod', ['+a', `user:${os.userInfo().username} deny writeextattr`, f.target]);
  const originalAttribute = await attribute(f.target, name), originalAcl = await acl(f.target);
  assert.ok(originalAttribute?.length > 0);
  assert.match(originalAcl, /deny writeextattr/);
  try { await save(f); }
  catch (error) {
    assert.deepEqual(await fs.readFile(f.target), before);
    assert.equal(await attribute(f.target, name), originalAttribute);
    assert.equal(await acl(f.target), originalAcl);
    throw error;
  }
  assert.equal(await attribute(f.target, name), originalAttribute);
  assert.equal(await acl(f.target), originalAcl);
});

for (const name of ['com.apple.quarantine', 'com.cuefluent.stage-creation']) {
  macTest(`macOS discards creation-time stage attribute ${name} absent from the original`, async t => {
    const f = await fixture(t), retained = 'com.cuefluent.original';
    await execute('/usr/bin/xattr', ['-wx', retained, '112233', f.target]);
    assert.ok(!(await execute('/usr/bin/xattr', [f.target])).stdout.split('\n').includes(name));
    await saveWithCreationAttribute(f, name);
    assert.equal(await attribute(f.target, retained), '112233');
  });
}

for (const [label, draft] of [['nonempty', after], ['empty', Buffer.alloc(0)]]) {
  macTest(`macOS preserves a quarantine edit made after ${label} stage initialization as a conflict`, async t => {
    const f = await fixture(t), name = 'com.apple.quarantine', intent = await f.prepare(draft);
    const stage = path.join(f.notes, `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`);
    let tagged = false, journal = intent;
    const persistIntent = async value => { journal = value; };
    await assert.rejects(publishNotePublication(f.pin, intent, draft, {
      persistIntent,
      beforePublish: async () => {
        if (tagged) return;
        assert.deepEqual(await fs.readFile(stage), draft);
        await execute('/usr/bin/xattr', ['-wx', name, '112233', stage]);
        tagged = true;
      },
    }), { code: 'NOTE_PUBLICATION_CONFLICT' });
    assert.equal(tagged, true);
    assert.deepEqual(await fs.readFile(f.target), before);
    assert.deepEqual(await fs.readFile(stage), draft);
    assert.equal(await attribute(stage, name), '112233');
    assert.ok(!(await execute('/usr/bin/xattr', [f.target])).stdout.split('\n').includes(name));
    assert.ok(journal.stage);
    await assert.rejects(publishNotePublication(f.pin, journal, draft, { persistIntent }),
      { code: 'NOTE_PUBLICATION_CONFLICT' });
    assert.deepEqual(await fs.readFile(f.target), before);
    assert.deepEqual(await fs.readFile(stage), draft);
    assert.equal(await attribute(stage, name), '112233');
    assert.ok(!(await execute('/usr/bin/xattr', [f.target])).stdout.split('\n').includes(name));
  });
}

macTest('macOS retries an unchanged completed quarantined stage with an owner deny ACL', async t => {
  const f = await fixture(t), name = 'com.apple.quarantine';
  await execute('/usr/bin/xattr', ['-w', name, '0083;69000001;Safari;', f.target]);
  await execute('/bin/chmod', ['+a', `user:${os.userInfo().username} deny writeextattr`, f.target]);
  const originalAttribute = await attribute(f.target, name), originalAcl = await acl(f.target);
  assert.ok(originalAttribute?.length > 0);
  assert.match(originalAcl, /deny writeextattr/);
  const intent = await f.prepare(), interrupted = new Error('Synthetic interruption before publication');
  const stage = path.join(f.notes, `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`);
  let journal = intent;
  const persistIntent = async value => { journal = value; };
  await assert.rejects(publishNotePublication(f.pin, intent, after, {
    persistIntent,
    beforePublish: async () => { throw interrupted; },
  }), error => error === interrupted);
  assert.ok(journal.stage);
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.deepEqual(await fs.readFile(stage), after);
  assert.equal(await attribute(stage, name), originalAttribute);
  assert.equal(await acl(stage), originalAcl);
  const result = await publishNotePublication(f.pin, journal, after, { persistIntent });
  assert.equal(result.changed, true);
  assert.deepEqual(await fs.readFile(f.target), after);
  assert.equal(await attribute(f.target, name), originalAttribute);
  assert.equal(await acl(f.target), originalAcl);
  assert.deepEqual(await fs.readdir(f.notes), ['note.md']);
});

for (const [label, draft, boundary, mode] of [
  ['nonempty', after, 'write', 0o440],
  ['empty', Buffer.alloc(0), 'write', 0o440],
  ['empty', Buffer.alloc(0), 'intent', 0o440],
  ['nonempty', after, 'write', 0o4640],
  ['original-prefix', before.subarray(0, before.length - 1), 'write', 0o440],
]) {
  macTest(`macOS retries an initial ${label} stage with mode ${mode.toString(8)} interrupted after ${boundary}`, async t => {
    const f = await fixture(t), name = 'com.apple.quarantine';
    await execute('/usr/bin/xattr', ['-w', name, '0083;69000001;Safari;', f.target]);
    await execute('/bin/chmod', ['+a', `user:${os.userInfo().username} deny writeextattr`, f.target]);
    await fs.chmod(f.target, mode);
    const originalAttribute = await attribute(f.target, name), originalAcl = await acl(f.target);
    assert.ok(originalAttribute?.length > 0);
    assert.match(originalAcl, /deny writeextattr/);
    const intent = await f.prepare(draft), interrupted = new Error('Synthetic initial staging interruption');
    const stage = path.join(f.notes, `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`);
    let journal = intent, writes = 0;
    const persistIntent = async value => { journal = value; };
    const nativeOpen = fs.open.bind(fs);
    const openMock = t.mock.method(fs, 'open', async (...args) => {
      const handle = await nativeOpen(...args);
      if (args[0] === stage && boundary === 'write') {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (...values) => {
          // Full draft bytes do not prove that permissions were restored yet.
          await write(...values);
          writes += 1;
          throw interrupted;
        });
      }
      return handle;
    });
    try {
      await assert.rejects(publishNotePublication(f.pin, intent, draft, {
        persistIntent: async value => {
          await persistIntent(value);
          // An empty draft also matches the newly recorded, unprepared stage.
          if (boundary === 'intent') throw interrupted;
        },
      }), error => error === interrupted);
    } finally { openMock.mock.restore(); }
    assert.equal(writes, boundary === 'write' ? 1 : 0);
    assert.ok(journal.stage);
    assert.deepEqual(await fs.readFile(stage), draft);
    const staged = await fs.stat(stage, { bigint: true });
    assert.deepEqual(await fs.readFile(f.target), before);
    assert.equal((await fs.stat(f.target)).mode & 0o7777, mode);
    assert.equal(await attribute(f.target, name), originalAttribute);
    assert.equal(await acl(f.target), originalAcl);
    const result = await publishNotePublication(f.pin, journal, draft, { persistIntent });
    assert.equal(result.changed, true);
    assert.deepEqual(await fs.readFile(f.target), draft);
    const saved = await fs.stat(f.target, { bigint: true });
    assert.equal(saved.dev, staged.dev);
    assert.equal(saved.ino, staged.ino);
    assert.equal(saved.mode & 0o7777n, BigInt(mode));
    assert.equal(await attribute(f.target, name), originalAttribute);
    assert.equal(await acl(f.target), originalAcl);
    assert.deepEqual(await fs.readdir(f.notes), ['note.md']);
  });
}

for (const [label, draft] of [['nonempty', after], ['empty', Buffer.alloc(0)]]) {
  macTest(`macOS preserves ${label} stage metadata edits when recording completion is interrupted`, async t => {
    const f = await fixture(t), name = 'com.apple.quarantine', intent = await f.prepare(draft);
    const stage = path.join(f.notes, `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`);
    const interrupted = new Error('Synthetic interruption after persisting completed staging');
    let journal = intent, completions = 0;
    const persistIntent = async value => { journal = value; };
    await assert.rejects(publishNotePublication(f.pin, intent, draft, {
      persistIntent: async value => {
        await persistIntent(value);
        if (value.capture) {
          // The journal replacement succeeded; its caller did not resume.
          completions += 1;
          throw interrupted;
        }
      },
    }), error => error === interrupted);
    assert.equal(completions, 1);
    assert.ok(journal.capture);
    assert.deepEqual(await fs.readFile(f.target), before);
    assert.deepEqual(await fs.readFile(stage), draft);
    const staged = await fs.stat(stage, { bigint: true });
    const names = (await fs.readdir(f.notes)).sort();
    await execute('/usr/bin/xattr', ['-wx', name, '112233', stage]);
    await assert.rejects(publishNotePublication(f.pin, journal, draft, { persistIntent }),
      { code: 'NOTE_PUBLICATION_CONFLICT' });
    assert.deepEqual(await fs.readFile(f.target), before);
    assert.deepEqual(await fs.readFile(stage), draft);
    assert.equal((await fs.stat(stage, { bigint: true })).ino, staged.ino);
    assert.equal(await attribute(stage, name), '112233');
    assert.ok(!(await execute('/usr/bin/xattr', [f.target])).stdout.split('\n').includes(name));
    assert.deepEqual((await fs.readdir(f.notes)).sort(), names);
  });
}

for (const mode of [0o640, 0o440]) {
  macTest(`macOS completed-stage retries leave mode ${mode.toString(8)} and metadata untouched across interruptions`, async t => {
    const f = await fixture(t), name = 'com.apple.quarantine';
    await execute('/usr/bin/xattr', ['-w', name, '0083;69000001;Safari;', f.target]);
    await execute('/bin/chmod', ['+a', `user:${os.userInfo().username} deny writeextattr`, f.target]);
    await fs.chmod(f.target, mode);
    const intent = await f.prepare(), firstFence = new Error('First synthetic publication interruption');
    const secondFence = new Error('Second synthetic publication interruption');
    const mutatedStage = new Error('A completed stage was chmodded before the retry fence');
    const stage = path.join(f.notes, `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`);
    let journal = intent;
    const persistIntent = async value => { journal = value; };
    await assert.rejects(publishNotePublication(f.pin, intent, after, {
      persistIntent, beforePublish: async () => { throw firstFence; },
    }), error => error === firstFence);
    assert.ok(journal.stage);
    const inspectStage = async () => {
      const bytes = await fs.readFile(stage), entries = await acl(stage), value = await attribute(stage, name);
      const stat = await fs.stat(stage, { bigint: true });
      return { bytes, entries, attribute: value, dev: stat.dev, ino: stat.ino, mode: stat.mode,
        uid: stat.uid, gid: stat.gid, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs };
    };
    const completed = await inspectStage();
    assert.deepEqual(completed.bytes, after);
    assert.equal(completed.mode & 0o777n, BigInt(mode));
    assert.ok(completed.attribute?.length > 0);
    assert.match(completed.entries, /deny writeextattr/);
    const nativeOpen = fs.open.bind(fs);
    let chmodCalls = 0, syncCalls = 0, fences = 0;
    const openMock = t.mock.method(fs, 'open', async (...args) => {
      const handle = await nativeOpen(...args);
      if (args[0] === stage) {
        const chmod = handle.chmod.bind(handle), sync = handle.sync.bind(handle);
        t.mock.method(handle, 'sync', async () => {
          await sync();
          syncCalls += 1;
        });
        t.mock.method(handle, 'chmod', async value => {
          await chmod(value);
          chmodCalls += 1;
          throw mutatedStage;
        });
      }
      return handle;
    });
    try {
      await assert.rejects(publishNotePublication(f.pin, journal, after, {
        persistIntent, beforePublish: async () => {
          assert.equal(syncCalls, 1);
          fences += 1;
          throw secondFence;
        },
      }), error => error === secondFence);
    } finally { openMock.mock.restore(); }
    assert.equal(chmodCalls, 0);
    assert.equal(syncCalls, 1);
    assert.equal(fences, 1);
    assert.deepEqual(await inspectStage(), completed);
    assert.deepEqual(await fs.readFile(f.target), before);
    const result = await publishNotePublication(f.pin, journal, after, { persistIntent });
    assert.equal(result.changed, true);
    assert.deepEqual(await fs.readFile(f.target), after);
    const saved = await fs.stat(f.target, { bigint: true });
    assert.equal(saved.ino, completed.ino);
    assert.equal(saved.mode, completed.mode);
    assert.equal(await attribute(f.target, name), completed.attribute);
    assert.equal(await acl(f.target), completed.entries);
    assert.deepEqual(await fs.readdir(f.notes), ['note.md']);
  });
}

macTest('macOS updates preserve a moved note inherited ACL and mixed entry order', async t => {
  const f = await fixture(t), source = path.join(f.root, 'source');
  await fs.mkdir(source);
  await execute('/bin/chmod', ['+a', 'group:staff allow read,file_inherit', source]);
  const moved = path.join(source, 'moved.md');
  await fs.writeFile(moved, before);
  await fs.chmod(moved, 0o640);
  await execute('/bin/chmod', ['+a#', '1', `user:${os.userInfo().username} allow write`, moved]);
  await fs.rename(moved, f.target);
  const original = await acl(f.target);
  assert.match(original, /0: group:staff inherited allow read/);
  assert.match(original, /1: user:.* allow write/);
  await save(f);
  assert.equal(await acl(f.target), original);
});

macTest('macOS updates do not add a parent ACL that the original note did not inherit', async t => {
  const f = await fixture(t), original = await acl(f.target);
  assert.equal(original.trim(), '');
  await execute('/bin/chmod', ['+a', 'group:staff allow read,file_inherit', f.notes]);
  await save(f);
  assert.equal(await acl(f.target), original);
});

macTest('macOS refuses an unpreservable note group before staging', async t => {
  const f = await fixture(t);
  const foreignRoot = await fs.mkdtemp('/private/tmp/cue-foreign-note-group-');
  t.after(() => fs.rm(foreignRoot, { recursive: true, force: true }));
  const foreign = path.join(foreignRoot, 'foreign.md');
  await fs.writeFile(foreign, before);
  const original = await fs.stat(foreign), destination = await fs.stat(f.notes);
  if (process.getuid() === 0 || process.getgroups().includes(original.gid) || original.gid === destination.gid) {
    t.skip('This host has no non-member inherited group in /private/tmp.'); return;
  }
  await fs.rename(foreign, f.target);
  await assert.rejects(f.prepare(), error => error.code === 'NOTE_METADATA_UNSUPPORTED' && /group/i.test(error.message));
  assert.deepEqual(await fs.readdir(f.notes), ['note.md']);
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.equal((await fs.stat(f.target)).gid, original.gid);
});

macTest('macOS updates preserve another group the current user belongs to', async t => {
  const f = await fixture(t), original = await fs.stat(f.target);
  const group = process.getgroups().find(gid => gid !== original.gid && gid === 80);
  if (group === undefined) { t.skip('The current user is not in the alternate admin group.'); return; }
  await fs.chown(f.target, process.getuid(), group);
  await save(f);
  assert.equal((await fs.stat(f.target)).gid, group);
});

for (const name of ['com.apple.provenance\n', 'com.apple.provenance\ncom.apple.provenance', '\n', 'ordinary\nother']) {
  macTest(`macOS refuses and preserves a newline xattr name ${JSON.stringify(name)}`, async t => {
    const f = await fixture(t), intent = await f.prepare();
    let changed = false;
    await assert.rejects(publishNotePublication(f.pin, intent, after, {
      persistIntent: async () => {},
      beforePublish: async () => {
        if (changed) return;
        await execute('/usr/bin/xattr', ['-wx', name, '112233', f.target]);
        changed = true;
      },
    }), { code: 'NOTE_METADATA_UNSUPPORTED' });
    assert.equal(changed, true);
    assert.deepEqual(await fs.readFile(f.target), before);
    // A newline name cannot be located by xattr's line-delimited name listing.
    assert.equal((await execute('/usr/bin/xattr', ['-px', '--', name, f.target])).stdout.replace(/\s/g, '').toLowerCase(), '112233');
    await assert.rejects(f.prepare(), { code: 'NOTE_METADATA_UNSUPPORTED' });
  });
}

macTest('macOS preserves 256 KiB metadata when stage creation adds quarantine', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(256 * 1024, 0xab);
  await fs.writeFile(`${f.target}/..namedfork/rsrc`, bytes);
  await saveWithCreationAttribute(f);
  assert.deepEqual(await fs.readFile(`${f.target}/..namedfork/rsrc`), bytes);
});

macTest('macOS refuses metadata above 256 KiB before staging', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(256 * 1024 + 1, 0xab);
  await fs.writeFile(`${f.target}/..namedfork/rsrc`, bytes);
  await assert.rejects(f.prepare(), { code: 'NOTE_METADATA_UNSUPPORTED' });
  assert.deepEqual(await fs.readdir(f.notes), ['note.md']);
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.deepEqual(await fs.readFile(`${f.target}/..namedfork/rsrc`), bytes);
});

macTest('macOS provenance does not consume one of the 128 user attribute slots', async t => {
  const f = await fixture(t), names = Array.from({ length: 128 }, (_, i) => `com.cuefluent.fixture.${i}`);
  for (const name of names) await execute('/usr/bin/xattr', ['-wx', name, '01', f.target]);
  const listed = (await execute('/usr/bin/xattr', [f.target])).stdout.split('\n');
  if (!listed.includes('com.apple.provenance')) { t.skip('This filesystem did not attach native provenance.'); return; }
  await save(f);
  for (const name of names) assert.equal(await attribute(f.target, name), '01');
});

macTest('macOS preserves 128 attributes when stage creation adds quarantine', async t => {
  const f = await fixture(t), names = Array.from({ length: 128 }, (_, i) => `com.cuefluent.fixture.${i}`);
  for (const name of names) await execute('/usr/bin/xattr', ['-wx', name, '01', f.target]);
  await saveWithCreationAttribute(f);
  for (const name of names) assert.equal(await attribute(f.target, name), '01');
});

macTest('macOS refuses a 129th user attribute before staging', async t => {
  const f = await fixture(t), names = Array.from({ length: 129 }, (_, i) => `com.cuefluent.fixture.${i}`);
  for (const name of names) await execute('/usr/bin/xattr', ['-wx', name, '01', f.target]);
  await assert.rejects(f.prepare(), { code: 'NOTE_METADATA_UNSUPPORTED' });
  assert.deepEqual(await fs.readdir(f.notes), ['note.md']);
  assert.deepEqual(await fs.readFile(f.target), before);
});

macTest('macOS preserves an extended attribute whose name starts with a dash', async t => {
  const f = await fixture(t), name = '-cuefluent-fixture';
  await execute('/usr/bin/xattr', ['-wx', '--', name, '112233', f.target]);
  await save(f);
  assert.equal(await attribute(f.target, name), '112233');
});
