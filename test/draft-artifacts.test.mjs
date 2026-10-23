import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createPrivateDirectory, inspectParent, pinDirectory } from '../src/storage/paths.mjs';
import { hashBytes } from '../src/storage/files.mjs';
import { establishWindowsPrivacy } from '../src/storage/platform.mjs';
import { validateDraftArtifactPointer, validateDraftArtifactManifest } from '../src/core/draft-artifacts.mjs';
import { prepareDraftArtifacts, writeDraftArtifact, completeDraftArtifacts, inspectDraftArtifacts, readDraftArtifact, discardDraftArtifacts } from '../src/storage/draft-artifacts.mjs';

async function fixture(t, count = 2) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-draft-artifacts-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pin = await createPrivateDirectory(path.join(root, 'private')); await createPrivateDirectory(path.join(pin.root, 'runs'));
  const notes = path.join(root, 'notes'); await fs.mkdir(notes); const notePin = await pinDirectory(notes);
  const runId = randomUUID(), drafts = [], bodies = [];
  for (let index = 0; index < count; index++) {
    const bytes = Buffer.from(`Synthetic private completed draft ${index}.\n`), relative = `note-${index}.md`, parent = await inspectParent(notePin, relative);
    bodies.push(bytes);
    drafts.push({ id: randomUUID(), target: path.join(notes, relative), expectedHash: null, hash: hashBytes(bytes), summary: `Summary ${index}`, heading: null,
      byteLength: bytes.length, binding: { root: notes, parent: parent.chain } });
  }
  const manifest = { runId, outcome: count ? 'drafted' : 'nothing-useful', drafts }, relative = `runs/${runId}`;
  const config = path.join(root, 'config.json'), pointerFile = path.join(root, 'pointer.json');
  await fs.writeFile(config, JSON.stringify({ manifest, bodies: bodies.map(bytes => bytes.toString('base64')), relative }), { mode: 0o600 });
  return { root, pin, notes, manifest, relative, bodies, config, pointerFile };
}

async function prepared(fx, options = {}) {
  let captured;
  const pointer = await prepareDraftArtifacts(fx.pin, fx.relative, fx.manifest, { persistIntent: async value => {
    captured = value; await fs.writeFile(fx.pointerFile, JSON.stringify(value), { mode: 0o600 });
  }, ...options });
  assert.deepEqual(pointer, captured); return pointer;
}

async function completed(fx) {
  const pointer = await prepared(fx);
  for (let index = 0; index < fx.bodies.length; index++) await writeDraftArtifact(fx.pin, pointer, fx.manifest.drafts[index].id, fx.bodies[index]);
  await completeDraftArtifacts(fx.pin, pointer); return pointer;
}

test('inspection is no-create and pure pointers reject extra fields and accessors', async t => {
  const fx = await fixture(t), pointer = { schema: 1, runId: fx.manifest.runId, relative: fx.relative,
    directory: { device: '1', inode: '1' }, journal: { device: '1', inode: '2' }, manifestHash: 'a'.repeat(64) };
  assert.deepEqual(await inspectDraftArtifacts(fx.pin, pointer), { status: 'missing', manifest: null, drafts: [] });
  assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
  assert.throws(() => validateDraftArtifactPointer({ ...pointer, modelInput: 'unsupported' }), { code: 'DRAFT_ARTIFACT_INVALID' });
  let evaluated = false;
  const accessor = { ...pointer }; Object.defineProperty(accessor, 'relative', { enumerable: true, get() { evaluated = true; throw new Error('getter'); } });
  assert.throws(() => validateDraftArtifactPointer(accessor), { code: 'DRAFT_ARTIFACT_INVALID' }); assert.equal(evaluated, false);
});

test('the immutable completed manifest is separate from bounded exact draft payloads', async t => {
  const fx = await fixture(t), pointer = await prepared(fx), directory = path.join(fx.pin.root, fx.relative);
  assert.deepEqual(await fs.readdir(directory), ['journal.jsonl']);
  const journal = await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8');
  assert.ok(!journal.includes(fx.bodies[0].toString().trim()));
  assert.deepEqual((await inspectDraftArtifacts(fx.pin, pointer)).manifest, fx.manifest);
  await assert.rejects(completeDraftArtifacts(fx.pin, pointer), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  for (let index = 0; index < fx.bodies.length; index++) assert.deepEqual(await writeDraftArtifact(fx.pin, pointer, fx.manifest.drafts[index].id, fx.bodies[index]), { complete: true });
  assert.deepEqual(await completeDraftArtifacts(fx.pin, pointer), fx.manifest);
  assert.equal((await inspectDraftArtifacts(fx.pin, pointer)).status, 'ready');
  for (let index = 0; index < fx.bodies.length; index++) {
    const id = fx.manifest.drafts[index].id;
    assert.deepEqual(await readDraftArtifact(fx.pin, pointer, id), fx.bodies[index]);
    assert.deepEqual(await writeDraftArtifact(fx.pin, pointer, id), { complete: true });
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, `${id}.draft`))).mode & 0o777, 0o600);
  }
  await assert.rejects(prepareDraftArtifacts(fx.pin, fx.relative, fx.manifest, { persistIntent() {} }), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  assert.deepEqual(await prepared(fx, { existingPointer: pointer }), pointer);
});

test('changed manifests or draft bytes cannot refresh an inspected artifact set', async t => {
  const fx = await fixture(t), pointer = await prepared(fx), journal = path.join(fx.pin.root, fx.relative, 'journal.jsonl');
  const before = await fs.readFile(journal);
  const changed = structuredClone(fx.manifest); changed.drafts[0].summary = 'Different';
  await assert.rejects(prepareDraftArtifacts(fx.pin, fx.relative, changed, { existingPointer: pointer, persistIntent() {} }), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  await assert.rejects(writeDraftArtifact(fx.pin, pointer, fx.manifest.drafts[0].id, Buffer.from('different')), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  assert.deepEqual(await fs.readFile(journal), before);
  assert.deepEqual(await fs.readdir(path.dirname(journal)), ['journal.jsonl']);
});

test('nothing-useful is a completed empty artifact set and cleanup removes its run directory', async t => {
  const fx = await fixture(t, 0), pointer = await prepared(fx);
  await completeDraftArtifacts(fx.pin, pointer);
  assert.equal((await inspectDraftArtifacts(fx.pin, pointer)).status, 'ready');
  assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: true, remaining: 0 });
  assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: true, remaining: 0 });
  assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
});

test('cleanup uses a bounded durable cursor and leaves selected queues unchanged', async t => {
  const fx = await fixture(t, 4), pointer = await completed(fx), selected = path.join(fx.pin.root, 'selected.queue');
  await fs.writeFile(selected, 'selected input remains', { mode: 0o600 });
  const originalOpen = fs.open; let payloadReads = 0;
  fs.open = async function(file, ...rest) { if (typeof file === 'string' && file.endsWith('.draft')) payloadReads++; return originalOpen.call(this, file, ...rest); };
  try { assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer, { limit: 1 }), { removed: false, remaining: 3 }); }
  finally { fs.open = originalOpen; }
  assert.equal(payloadReads, 1);
  assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: false, remaining: 2 });
  assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: false, remaining: 1 });
  assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: true, remaining: 0 });
  assert.equal(await fs.readFile(selected, 'utf8'), 'selected input remains');
  assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
});

test('unknown files, changed completed contents, and replacement inodes are preserved', async t => {
  const fx = await fixture(t, 1), pointer = await completed(fx), directory = path.join(fx.pin.root, fx.relative), id = fx.manifest.drafts[0].id;
  await fs.writeFile(path.join(directory, 'unexpected.bin'), 'preserve', { mode: 0o600 });
  const before = await fs.readFile(path.join(directory, 'journal.jsonl'));
  await assert.rejects(discardDraftArtifacts(fx.pin, pointer), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  assert.deepEqual(await fs.readFile(path.join(directory, 'journal.jsonl')), before);
  assert.equal(await fs.readFile(path.join(directory, 'unexpected.bin'), 'utf8'), 'preserve');
  await fs.unlink(path.join(directory, 'unexpected.bin'));
  await fs.writeFile(path.join(directory, `${id}.draft`), 'unexpected edit');
  await assert.rejects(readDraftArtifact(fx.pin, pointer, id), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  await assert.rejects(discardDraftArtifacts(fx.pin, pointer), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  assert.equal(await fs.readFile(path.join(directory, `${id}.draft`), 'utf8'), 'unexpected edit');
  await fs.rename(path.join(directory, 'journal.jsonl'), path.join(fx.root, 'old-journal'));
  await fs.writeFile(path.join(directory, 'journal.jsonl'), await fs.readFile(path.join(fx.root, 'old-journal')), { mode: 0o600 });
  establishWindowsPrivacy(path.join(directory, 'journal.jsonl'));
  await assert.rejects(inspectDraftArtifacts(fx.pin, pointer), { code: 'DRAFT_ARTIFACT_CONFLICT' });
});

test('malformed newline-complete and unknown torn metadata are never silently removed', async t => {
  const fx = await fixture(t, 1), pointer = await prepared(fx), journal = path.join(fx.pin.root, fx.relative, 'journal.jsonl');
  await fs.appendFile(journal, '{malformed}\n'); const malformed = await fs.readFile(journal);
  await assert.rejects(discardDraftArtifacts(fx.pin, pointer), { code: 'DRAFT_ARTIFACT_INVALID' });
  assert.deepEqual(await fs.readFile(journal), malformed);
  await fs.writeFile(journal, malformed.subarray(0, malformed.length - Buffer.byteLength('{malformed}\n')));
  await fs.appendFile(journal, '{unknown tail'); const unknown = await fs.readFile(journal);
  await assert.rejects(discardDraftArtifacts(fx.pin, pointer), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  assert.deepEqual(await fs.readFile(journal), unknown);
});

test('bounded schemas reject extra model data, sparse lists, aliases and oversized draft sets', async t => {
  const fx = await fixture(t, 1);
  assert.throws(() => validateDraftArtifactManifest({ ...fx.manifest, warnings: [] }), { code: 'DRAFT_ARTIFACT_INVALID' });
  assert.throws(() => validateDraftArtifactManifest({ ...fx.manifest, outcome: 'nothing-useful' }), { code: 'DRAFT_ARTIFACT_INVALID' });
  const sparse = structuredClone(fx.manifest); delete sparse.drafts[0];
  assert.throws(() => validateDraftArtifactManifest(sparse), { code: 'DRAFT_ARTIFACT_INVALID' });
  const tooMany = { ...fx.manifest, drafts: Array.from({ length: 65 }, () => fx.manifest.drafts[0]) };
  await assert.rejects(prepareDraftArtifacts(fx.pin, fx.relative, tooMany, { persistIntent() {} }), { code: 'DRAFT_ARTIFACT_INVALID' });
  assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
});

test('multi-megabyte drafts use bounded chunks and remain exactly readable', async t => {
  const fx = await fixture(t, 1), bytes = Buffer.alloc(3 * 1024 * 1024, 120), draft = fx.manifest.drafts[0];
  draft.hash = hashBytes(bytes); draft.byteLength = bytes.length;
  const pointer = await prepared(fx), originalOpen = fs.open, writes = [];
  fs.open = async function(file, flags, ...rest) {
    const handle = await originalOpen.call(this, file, flags, ...rest);
    if (typeof file === 'string' && file.endsWith('.tmp') && typeof flags === 'number' && (flags & 2)) {
      const write = handle.write.bind(handle);
      handle.write = async function(buffer, offset, length, position) { writes.push(length); return write(buffer, offset, length, position); };
    }
    return handle;
  };
  try { await writeDraftArtifact(fx.pin, pointer, draft.id, bytes); } finally { fs.open = originalOpen; }
  assert.ok(writes.length > 1); assert.ok(writes.every(size => size <= 256 * 1024));
  await completeDraftArtifacts(fx.pin, pointer);
  assert.deepEqual(await readDraftArtifact(fx.pin, pointer, draft.id), bytes);
});

test('redrafting after explicit discard cannot reuse the old artifact pointer', async t => {
  const fx = await fixture(t, 1), old = await prepared(fx);
  assert.deepEqual(await discardDraftArtifacts(fx.pin, old), { removed: true, remaining: 0 });
  fx.manifest.drafts[0].id = randomUUID(); fx.manifest.drafts[0].summary = 'New completed model output';
  const fresh = await prepared(fx);
  await assert.rejects(discardDraftArtifacts(fx.pin, old), { code: 'DRAFT_ARTIFACT_CONFLICT' });
  assert.equal((await inspectDraftArtifacts(fx.pin, fresh)).status, 'partial');
});

test('malformed UTF-8 metadata cannot alias the expected replacement character', async t => {
  const fx = await fixture(t, 1); fx.manifest.drafts[0].summary = 'Replacement \uFFFD marker';
  const pointer = await prepared(fx), journal = path.join(fx.pin.root, fx.relative, 'journal.jsonl'), original = await fs.readFile(journal);
  const offset = original.indexOf(Buffer.from('\uFFFD')); assert.ok(offset >= 0);
  const corrupt = Buffer.concat([original.subarray(0, offset), Buffer.from([255]), original.subarray(offset + 3)]);
  await fs.writeFile(journal, corrupt);
  await assert.rejects(inspectDraftArtifacts(fx.pin, pointer), { code: 'DRAFT_ARTIFACT_INVALID' });
  assert.deepEqual(await fs.readFile(journal), corrupt);
});

const CHILD = String.raw`
import fs from 'node:fs/promises'; import {constants} from 'node:fs';
const [root,configFile,pointerFile,phase,action,moduleURL,pathsURL]=process.argv.slice(1);
const api=await import(moduleURL), {pinDirectory}=await import(pathsURL), config=JSON.parse(await fs.readFile(configFile,'utf8'));
const pin=await pinDirectory(root,{private:true}), boundary=async()=>{setInterval(()=>{},1000);process.send('boundary');await new Promise(()=>{});};
const open=fs.open;
fs.open=async function(file,flags,...rest) {
 const handle=await open.call(this,file,flags,...rest), name=String(file);
 if(name.endsWith('/journal.jsonl') || name.endsWith('\\journal.jsonl')) {
  if(phase==='unrecorded' && typeof flags==='number' && (flags & constants.O_EXCL)) await boundary();
  const write=handle.write.bind(handle), sync=handle.sync.bind(handle); let lastType;
  handle.write=async function(buffer,offset,length,position) {
   let parsed; try {parsed=JSON.parse(buffer.subarray(offset,offset+length).toString('utf8'));}catch{}
   if((phase==='manifest'&&parsed?.type==='manifest') || (phase==='torn-complete'&&parsed?.type==='complete')) {
    await write(buffer,offset,Math.min(length,21),position);await boundary();
   }
   const result=await write(buffer,offset,length,position);lastType=parsed?.type;return result;
  };
  handle.sync=async function(){await sync();if((phase==='own'&&lastType==='own')||(phase==='complete'&&lastType==='complete'))await boundary();};
 }
 if(name.endsWith('.tmp') && phase==='unowned' && typeof flags==='number' && (flags & constants.O_EXCL)) await boundary();
 if(name.endsWith('.tmp') && typeof flags==='number' && (flags & constants.O_RDWR)) {
  const write=handle.write.bind(handle);
  handle.write=async function(buffer,offset,length,position){if(phase==='write'){await write(buffer,offset,Math.min(length,7),position);await boundary();}return write(buffer,offset,length,position);};
 }
 return handle;
};
const link=fs.link;fs.link=async function(...args){const result=await link.apply(this,args);if(phase==='link')await boundary();return result;};
const unlink=fs.unlink;fs.unlink=async function(file,...rest){const result=await unlink.call(this,file,...rest);if((phase==='delete'&&String(file).endsWith('.draft'))||(phase==='delete-journal'&&String(file).endsWith('journal.jsonl')))await boundary();return result;};
const persistIntent=async pointer=>{const handle=await open(pointerFile,'w',0o600);try{await handle.writeFile(JSON.stringify(pointer));await handle.sync();}finally{await handle.close();}if(phase==='callback')await boundary();};
if(action==='prepare') await api.prepareDraftArtifacts(pin,config.relative,config.manifest,{persistIntent});
else {const pointer=JSON.parse(await fs.readFile(pointerFile,'utf8'));if(action==='discard')await api.discardDraftArtifacts(pin,pointer);else {const index=config.draftIndex??0;await api.writeDraftArtifact(pin,pointer,config.manifest.drafts[index].id,Buffer.from(config.bodies[index],'base64'));}}
process.send('unexpected completion');
`;

async function killed(t, fx, phase, action = 'write') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, fx.pin.root, fx.config, fx.pointerFile, phase, action,
    new URL('../src/storage/draft-artifacts.mjs', import.meta.url).href, new URL('../src/storage/paths.mjs', import.meta.url).href], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Artifact process did not reach ${phase}`)), 15000);
    child.once('message', message => { clearTimeout(timer); message === 'boundary' ? resolve() : reject(new Error(message)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Artifact process exited: ${code}/${signal}`)); });
  });
  child.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');
  try { return JSON.parse(await fs.readFile(fx.pointerFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

for (const phase of ['callback', 'manifest']) {
  test(`process death at initial ${phase} leaves exact owned partial metadata discardable`, async t => {
    const fx = await fixture(t, 1), pointer = await killed(t, fx, phase, 'prepare');
    assert.ok(pointer); assert.equal((await inspectDraftArtifacts(fx.pin, pointer)).status, 'partial');
    assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: true, remaining: 0 });
    assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
  });
}

test('the earliest pre-pointer crash cleans only its empty reserved journal and directory', async t => {
  const fx = await fixture(t, 1); assert.equal(await killed(t, fx, 'unrecorded', 'prepare'), null);
  assert.deepEqual(await discardDraftArtifacts(fx.pin, fx.relative, { runId: fx.manifest.runId }), { removed: true, remaining: 0 });
  assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
});

test('the exact initial torn manifest can be reconstructed without changing its pointer', async t => {
  const fx = await fixture(t, 1), pointer = await killed(t, fx, 'manifest', 'prepare');
  assert.deepEqual(await prepared(fx, { existingPointer: pointer }), pointer);
  assert.deepEqual((await inspectDraftArtifacts(fx.pin, pointer)).manifest, fx.manifest);
  await writeDraftArtifact(fx.pin, pointer, fx.manifest.drafts[0].id, fx.bodies[0]);
  await completeDraftArtifacts(fx.pin, pointer);
  assert.deepEqual(await readDraftArtifact(fx.pin, pointer, fx.manifest.drafts[0].id), fx.bodies[0]);
});

for (const phase of ['unowned', 'own', 'write', 'link', 'complete', 'torn-complete']) {
  test(`process death at draft ${phase} recovers completed hashes or permits explicit partial discard`, async t => {
    const fx = await fixture(t, 1), pointer = await prepared(fx), id = fx.manifest.drafts[0].id;
    await killed(t, fx, phase);
    const recovery = await writeDraftArtifact(fx.pin, pointer, id);
    if (['unowned', 'own', 'write'].includes(phase)) {
      assert.deepEqual(recovery, { complete: false, partial: true });
      assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: true, remaining: 0 });
    } else {
      assert.deepEqual(recovery, { complete: true });
      await completeDraftArtifacts(fx.pin, pointer);
      assert.deepEqual(await readDraftArtifact(fx.pin, pointer, id), fx.bodies[0]);
      assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: true, remaining: 0 });
    }
    assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
  });
}

for (const phase of ['delete', 'delete-journal']) {
  test(`process death after ${phase} resumes cleanup without a UUID directory leak`, async t => {
    const fx = await fixture(t, 1), pointer = await completed(fx);
    await killed(t, fx, phase, 'discard');
    assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: true, remaining: 0 });
    assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
  });
}

test('explicit discard handles a known torn completion event without model bytes', async t => {
  const fx = await fixture(t, 1), pointer = await prepared(fx);
  await killed(t, fx, 'torn-complete');
  assert.deepEqual(await discardDraftArtifacts(fx.pin, pointer), { removed: true, remaining: 0 });
  assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
});

for (const phase of ['own', 'write', 'link']) {
  test(`recovery passes completed earlier drafts after second draft ${phase} process death`, async t => {
    const fx = await fixture(t, 2), pointer = await prepared(fx);
    await writeDraftArtifact(fx.pin, pointer, fx.manifest.drafts[0].id, fx.bodies[0]);
    const config = JSON.parse(await fs.readFile(fx.config, 'utf8')); config.draftIndex = 1;
    await fs.writeFile(fx.config, JSON.stringify(config));
    await killed(t, fx, phase);
    assert.deepEqual(await writeDraftArtifact(fx.pin, pointer, fx.manifest.drafts[0].id), { complete: true });
    const second = await writeDraftArtifact(fx.pin, pointer, fx.manifest.drafts[1].id);
    if (phase === 'link') {
      assert.deepEqual(second, { complete: true }); await completeDraftArtifacts(fx.pin, pointer);
      assert.deepEqual(await readDraftArtifact(fx.pin, pointer, fx.manifest.drafts[1].id), fx.bodies[1]);
    } else assert.equal(second.complete, false);
    while (!(await discardDraftArtifacts(fx.pin, pointer)).removed) {}
    assert.deepEqual(await fs.readdir(path.join(fx.pin.root, 'runs')), []);
  });
}

test('POSIX destination ancestors may contain characters reserved only on Windows', async t => {
  if (process.platform === 'win32') return t.skip('POSIX filesystem name fixture');
  const fx = await fixture(t, 1), notes = path.join(fx.root, 'Notes:Work'); await fs.mkdir(notes);
  const pin = await pinDirectory(notes), parent = await inspectParent(pin, 'topic.md');
  fx.manifest.drafts[0] = { ...fx.manifest.drafts[0], target: path.join(notes, 'topic.md'), binding: { root: notes, parent: parent.chain } };
  const pointer = await completed(fx);
  assert.equal((await inspectDraftArtifacts(fx.pin, pointer)).manifest.drafts[0].target, path.join(notes, 'topic.md'));
});
