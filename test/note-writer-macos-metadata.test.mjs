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
  const prepare = () => prepareNotePublication(pin, 'note.md', after, {
    runId: randomUUID(), draftId: randomUUID(), expectedHash: hashBytes(before), hash: hashBytes(after),
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

macTest('macOS preserves a quarantine edit made after stage initialization as a conflict', async t => {
  const f = await fixture(t), name = 'com.apple.quarantine', intent = await f.prepare();
  const stage = path.join(f.notes, `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`);
  let tagged = false, journal = intent;
  const persistIntent = async value => { journal = value; };
  await assert.rejects(publishNotePublication(f.pin, intent, after, {
    persistIntent,
    beforePublish: async () => {
      if (tagged) return;
      assert.deepEqual(await fs.readFile(stage), after);
      await execute('/usr/bin/xattr', ['-wx', name, '112233', stage]);
      tagged = true;
    },
  }), error => error.code === 'NOTE_PUBLICATION_CONFLICT' && /Staging did not preserve/.test(error.message));
  assert.equal(tagged, true);
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.deepEqual(await fs.readFile(stage), after);
  assert.equal(await attribute(stage, name), '112233');
  assert.ok(!(await execute('/usr/bin/xattr', [f.target])).stdout.split('\n').includes(name));
  assert.ok(journal.stage);
  await assert.rejects(publishNotePublication(f.pin, journal, after, { persistIntent }),
    error => error.code === 'NOTE_PUBLICATION_CONFLICT' && /completed stage metadata changed before retry/.test(error.message));
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.deepEqual(await fs.readFile(stage), after);
  assert.equal(await attribute(stage, name), '112233');
  assert.ok(!(await execute('/usr/bin/xattr', [f.target])).stdout.split('\n').includes(name));
});

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
