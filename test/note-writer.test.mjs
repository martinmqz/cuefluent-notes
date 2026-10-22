import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pinDirectory } from '../src/storage/paths.mjs';
import { hashBytes } from '../src/storage/files.mjs';
import { MAX_NOTE_BYTES, validateNotePublication, prepareNotePublication, publishNotePublication,
  inspectPublicationOutcome, readPublicationSource, discardNoteStage } from '../src/storage/note-writer.mjs';
import { validateNotePublication as validatePurePublication } from '../src/core/note-publication.mjs';

const execute = promisify(execFile);
const body = Buffer.from('# Synthetic note\n\nUpdated exact bytes.\n');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-note-writer-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = path.join(root, 'notes'); await fs.mkdir(notes);
  return { root, notes, pin: await pinDirectory(notes) };
}

async function prepare(pin, relative = 'note.md', bytes = body, expectedHash = null, options = {}) {
  return prepareNotePublication(pin, relative, bytes, { runId: randomUUID(), draftId: randomUUID(), expectedHash, hash: hashBytes(bytes), ...options });
}

async function publish(pin, intent, bytes = body) {
  let saved = intent;
  const receipt = await publishNotePublication(pin, intent, bytes, { persistIntent: async value => { saved = value; } });
  return { intent: saved, receipt };
}

const stagePath = intent => path.join(path.dirname(path.join(intent.root, intent.relative)), `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`);

async function windowsMetadata(target, attributes) {
  const script = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$p=ConvertFrom-Json $env:CUEFLUENT_NOTE_FIXTURE
if($null -ne $p.attributes){[IO.File]::SetAttributes($p.path,[int]$p.attributes)}
@{attributes=[int][IO.File]::GetAttributes($p.path);acl=(Get-Acl -LiteralPath $p.path -Audit).Sddl} | ConvertTo-Json -Compress
`;
  const { stdout } = await execute(path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, CUEFLUENT_NOTE_FIXTURE: JSON.stringify({ path: target, attributes }) } });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

test('the pure core publication validator supports explicit Windows path semantics', () => {
  assert.equal(validatePurePublication, validateNotePublication);
  const value = { schema: 1, runId: randomUUID(), draftId: randomUUID(), root: 'C:\\Notes', relative: 'nested/note.md',
    parent: [{ path: 'C:\\', device: '1', inode: '1' }, { path: 'C:\\Notes', device: '1', inode: '2' },
      { path: 'C:\\Notes\\nested', device: '1', inode: '3' }], expectedHash: null, hash: hashBytes(body), bytes: body.length, original: null, stage: null };
  assert.deepEqual(validatePurePublication(value, { platform: 'win32' }), value);
  assert.throws(() => validatePurePublication({ ...value, root: '\\\\server\\notes' }, { platform: 'win32' }), { code: 'NOTE_PUBLICATION_INVALID' });
  assert.throws(() => validatePurePublication({ ...value, relative: 'nested/../note.md' }, { platform: 'win32' }), { code: 'NOTE_PUBLICATION_INVALID' });
});

test('preparation is read-only and a saved note is recoverable by exact stage identity', async t => {
  const { notes, pin } = await fixture(t);
  const intent = await prepare(pin);
  assert.equal(intent.stage, null);
  assert.deepEqual(await fs.readdir(notes), []);
  assert.deepEqual(await inspectPublicationOutcome(pin, intent), { status: 'unapplied' });
  const saved = await publish(pin, intent);
  assert.equal(saved.receipt.changed, true);
  assert.equal(saved.receipt.hash, hashBytes(body));
  assert.deepEqual(await fs.readFile(path.join(notes, 'note.md')), body);
  assert.deepEqual(await fs.readdir(notes), ['note.md']);
  assert.deepEqual(await inspectPublicationOutcome(pin, saved.intent), { status: 'applied' });
  assert.deepEqual(await publishNotePublication(pin, saved.intent, body), saved.receipt);
  assert.equal((await fs.stat(saved.receipt.target)).nlink, 1);
});

test('unchanged publication preserves bytes and timestamps without staging', async t => {
  const { notes, pin } = await fixture(t);
  const target = path.join(notes, 'note.md'); await fs.writeFile(target, body);
  const time = new Date('2001-01-01T00:00:00Z'); await fs.utimes(target, time, time);
  const intent = await prepare(pin, 'note.md', body, hashBytes(body));
  assert.deepEqual(await inspectPublicationOutcome(pin, intent), { status: 'existing' });
  const receipt = await publishNotePublication(pin, intent, body);
  assert.equal(receipt.changed, false);
  assert.equal((await fs.stat(target)).mtimeMs, time.getTime());
  assert.deepEqual(await fs.readdir(notes), ['note.md']);
});

test('existing notes retain exact permissions, ACLs, and extended attributes', async t => {
  const { notes, pin } = await fixture(t);
  const target = path.join(notes, "note with ' spaces.md"), before = Buffer.from('original\n');
  await fs.writeFile(target, before, { mode: 0o640 });
  let acl;
  if (process.platform === 'darwin') {
    await execute('/usr/bin/xattr', ['-wx', 'com.cuefluent.synthetic', '00ff102030', target]);
    await execute('/bin/chmod', ['+a', `user:${os.userInfo().username} allow read`, target]);
    acl = (await execute('/bin/ls', ['-lde', target])).stdout.split('\n').slice(1).join('\n');
  } else if (process.platform === 'win32') {
    await fs.writeFile(`${target}:cuefluent-synthetic`, Buffer.from([0, 255, 16, 32, 48]));
  }
  const intent = await prepare(pin, path.basename(target), body, hashBytes(before));
  const saved = await publish(pin, intent);
  assert.equal(saved.receipt.changed, true);
  assert.deepEqual(await fs.readFile(target), body);
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o7777, 0o640);
  if (process.platform === 'darwin') {
    const value = (await execute('/usr/bin/xattr', ['-px', 'com.cuefluent.synthetic', target])).stdout.replace(/\s/g, '').toLowerCase();
    assert.equal(value, '00ff102030');
    assert.equal((await execute('/bin/ls', ['-lde', target])).stdout.split('\n').slice(1).join('\n'), acl);
  } else if (process.platform === 'win32') {
    assert.deepEqual(await fs.readFile(`${target}:cuefluent-synthetic`), Buffer.from([0, 255, 16, 32, 48]));
  }
});

test('Windows publication preserves non-Archive attributes after data handles close', { skip: process.platform !== 'win32' }, async t => {
  const { notes, pin } = await fixture(t);
  for (const attributes of [128, 8192]) { // Normal, NotContentIndexed; neither includes Archive.
    const relative = `attributes-${attributes}.md`, target = path.join(notes, relative), before = Buffer.from('original\n');
    await fs.writeFile(target, before);
    const stream = Buffer.from([0, 255, 16, 32, 48]);
    await fs.writeFile(`${target}:cuefluent-synthetic`, stream);
    const original = await windowsMetadata(target, attributes);
    assert.equal(original.attributes, attributes);
    const intent = await prepare(pin, relative, body, hashBytes(before));
    const saved = await publish(pin, intent);
    assert.equal(saved.receipt.changed, true);
    assert.deepEqual(await fs.readFile(target), body);
    assert.deepEqual(await fs.readFile(`${target}:cuefluent-synthetic`), stream);
    assert.deepEqual(await windowsMetadata(target), original);
    assert.deepEqual(await inspectPublicationOutcome(pin, saved.intent), { status: 'applied' });
    assert.deepEqual(await publishNotePublication(pin, saved.intent, body), saved.receipt);
    assert.deepEqual(await windowsMetadata(target), original);
  }
  assert.deepEqual((await fs.readdir(notes)).sort(), ['attributes-128.md', 'attributes-8192.md']);
});

test('manual edits and same-byte replacement inodes preserve the current public note', async t => {
  const { notes, pin } = await fixture(t);
  const target = path.join(notes, 'note.md'), before = Buffer.from('original'); await fs.writeFile(target, before);
  const intent = await prepare(pin, 'note.md', body, hashBytes(before));
  await fs.writeFile(target, 'manual edit');
  assert.deepEqual(await inspectPublicationOutcome(pin, intent), { status: 'conflict', code: 'NOTE_PUBLICATION_CONFLICT' });
  await assert.rejects(publishNotePublication(pin, intent, body, { persistIntent() {} }), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'manual edit');
  await fs.rename(target, path.join(notes, 'saved-manual.md')); await fs.writeFile(target, before);
  await assert.rejects(publishNotePublication(pin, intent, body, { persistIntent() {} }), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.deepEqual(await fs.readFile(target), before);
  assert.ok(!(await fs.readdir(notes)).some(name => name.endsWith('.tmp')));
});

test('a new target created concurrently is never overwritten even with the desired bytes', async t => {
  const { notes, pin } = await fixture(t), intent = await prepare(pin);
  await fs.writeFile(path.join(notes, 'note.md'), body);
  await assert.rejects(publishNotePublication(pin, intent, body, { persistIntent() {} }), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.deepEqual(await fs.readFile(path.join(notes, 'note.md')), body);
  assert.deepEqual(await fs.readdir(notes), ['note.md']);
});

test('the current-run callback is durable before any note bytes enter its stage', async t => {
  const { notes, pin } = await fixture(t), intent = await prepare(pin);
  let journal;
  await assert.rejects(publishNotePublication(pin, intent, body, { persistIntent: async value => {
    journal = value;
    assert.equal((await fs.stat(stagePath(value))).size, 0);
    assert.equal((await fs.readdir(notes)).length, 1);
    throw new Error('journal unavailable');
  } }), /journal unavailable/);
  assert.equal((await fs.stat(stagePath(journal))).size, 0);
  assert.deepEqual(await inspectPublicationOutcome(pin, intent), { status: 'unapplied' });
  const saved = await publish(pin, intent);
  assert.deepEqual(saved.intent.stage, journal.stage);
  assert.equal(saved.receipt.changed, true);
});

test('unknown nonempty stages, hardlinks, and replaced stage inodes fail closed', async t => {
  const { root, notes, pin } = await fixture(t), intent = await prepare(pin);
  await fs.writeFile(stagePath(intent), 'unrelated data');
  await assert.rejects(publish(pin, intent), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.equal(await fs.readFile(stagePath(intent), 'utf8'), 'unrelated data');
  await fs.unlink(stagePath(intent));
  let journal;
  await assert.rejects(publishNotePublication(pin, intent, body, { persistIntent: value => { journal = value; throw new Error('pause'); } }), /pause/);
  await fs.rename(stagePath(journal), path.join(root, 'old-stage'));
  await fs.writeFile(stagePath(journal), 'replacement');
  await assert.rejects(discardNoteStage(pin, journal), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.equal(await fs.readFile(stagePath(journal), 'utf8'), 'replacement');
  await fs.unlink(stagePath(journal)); await fs.link(path.join(root, 'old-stage'), stagePath(journal));
  await assert.rejects(publish(pin, journal), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.equal((await fs.stat(stagePath(journal))).nlink, 2);
  assert.deepEqual((await fs.readdir(notes)).filter(name => name.endsWith('.md')), []);
});

test('skip discards only an exact recorded stage and never removes a saved note', async t => {
  const { notes, pin } = await fixture(t), intent = await prepare(pin);
  let journal;
  await assert.rejects(publishNotePublication(pin, intent, body, { persistIntent: value => { journal = value; throw new Error('pause'); } }), /pause/);
  assert.deepEqual(await discardNoteStage(pin, journal), { discarded: true, applied: false });
  assert.deepEqual(await discardNoteStage(pin, journal), { discarded: false, applied: false });
  assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: 'unapplied' });
  assert.deepEqual(await fs.readdir(notes), []);
  const saved = await publish(pin, intent);
  assert.deepEqual(await discardNoteStage(pin, saved.intent), { discarded: true, applied: true });
  assert.deepEqual(await fs.readFile(path.join(notes, 'note.md')), body);
});

test('skip journals a safely adoptable empty stage before discarding it', async t => {
  const { root, notes, pin } = await fixture(t), intent = await prepare(pin);
  const journal = await killedPublication(t, root, pin, intent, 'empty');
  await assert.rejects(discardNoteStage(pin, journal), { code: 'NOTE_PUBLICATION_INVALID' });
  let recorded;
  assert.deepEqual(await discardNoteStage(pin, journal, { persistIntent: async value => {
    recorded = value; assert.equal((await fs.stat(stagePath(value))).size, 0);
  } }), { discarded: true, applied: false });
  assert.ok(recorded.stage);
  assert.deepEqual(await fs.readdir(notes), []);
  assert.deepEqual(await discardNoteStage(pin, recorded), { discarded: false, applied: false });
});

test('pinned root and nested parent replacement are refused before staging', async t => {
  const { root, notes, pin } = await fixture(t);
  await fs.mkdir(path.join(notes, 'nested'));
  const intent = await prepare(pin, 'nested/note.md');
  await fs.rename(path.join(notes, 'nested'), path.join(notes, 'old-nested')); await fs.mkdir(path.join(notes, 'nested'));
  await assert.rejects(prepare(pin, 'nested/note.md', body, null, { expectedParentChain: intent.parent }), { code: 'NOTE_PUBLICATION_CONFLICT' });
  await assert.rejects(publish(pin, intent), { code: 'PATH_CHANGED' });
  await fs.rename(notes, path.join(root, 'old-notes')); await fs.mkdir(notes);
  await assert.rejects(publish(pin, intent), { code: 'PATH_CHANGED' });
  assert.deepEqual(await fs.readdir(notes), []);
});

test('intent schemas reject extras, accessors, sparse pins, and oversized drafts before writes', async t => {
  const { notes, pin } = await fixture(t), intent = await prepare(pin);
  assert.throws(() => validateNotePublication({ ...intent, conversation: 'unsupported' }), { code: 'NOTE_PUBLICATION_INVALID' });
  let evaluated = false;
  const accessor = { ...intent }; Object.defineProperty(accessor, 'hash', { enumerable: true, get() { evaluated = true; throw new Error('getter ran'); } });
  assert.throws(() => validateNotePublication(accessor), { code: 'NOTE_PUBLICATION_INVALID' }); assert.equal(evaluated, false);
  const badParent = [...intent.parent]; delete badParent[0];
  assert.throws(() => validateNotePublication({ ...intent, parent: badParent }), { code: 'NOTE_PUBLICATION_INVALID' });
  const tooLarge = Buffer.alloc(MAX_NOTE_BYTES + 1);
  await assert.rejects(prepare(pin, 'big.md', tooLarge), { code: 'NOTE_PUBLICATION_INVALID' });
  await assert.rejects(publishNotePublication(pin, intent, Buffer.from('wrong bytes')), { code: 'NOTE_PUBLICATION_INVALID' });
  await assert.rejects(publishNotePublication(pin, intent, body), { code: 'NOTE_PUBLICATION_INVALID' });
  assert.deepEqual(await fs.readdir(notes), []);
});

test('valid plain notes larger than 2 MiB remain within the 10 MiB profile', async t => {
  const { notes, pin } = await fixture(t), bytes = Buffer.alloc(3 * 1024 * 1024, 97);
  await fs.writeFile(path.join(notes, 'large.md'), bytes);
  bytes[bytes.length - 1] = 98;
  const original = Buffer.alloc(bytes.length, 97);
  const intent = await prepare(pin, 'large.md', bytes, hashBytes(original));
  const result = await publish(pin, intent, bytes);
  assert.equal(result.receipt.hash, hashBytes(bytes));
  assert.deepEqual(await fs.readFile(path.join(notes, 'large.md')), bytes);
});

const CHILD = String.raw`
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
const [root,journal,phase,writerURL,pathsURL] = process.argv.slice(1);
const bytes=Buffer.from('# Synthetic note\n\nUpdated exact bytes.\n');
const boundary=async()=>{setInterval(()=>{},1000);process.send('boundary');await new Promise(()=>{});};
if(phase==='restored-target') {
 const execute=childProcess.execFile;
 const wrapped=(...args)=>execute(...args);
 wrapped[promisify.custom]=(...args)=>new Promise((resolve,reject)=>execute(...args,async(error,stdout,stderr)=>{
  if(error){reject(error);return;}
  try {
   const native=JSON.parse(args[2]?.env?.CUEFLUENT_NOTE_NATIVE ?? 'null');
   if(native?.op==='restore-archive' && native.source===path.join(root,'note.md')) await boundary();
   resolve({stdout,stderr});
  } catch(cause){reject(cause);}
 }));
 childProcess.execFile=wrapped;syncBuiltinESMExports();
}
const {pinDirectory}=await import(pathsURL);
const {publishNotePublication}=await import(writerURL);
const open=fs.open;
fs.open=async function(file,flags,...rest) {
 const handle=await open.call(this,file,flags,...rest);
 if(phase==='published' && file===path.join(root,'note.md') && typeof flags==='number' && (flags & constants.O_RDWR)) await boundary();
 if(typeof file==='string' && file.endsWith('.tmp') && !file.endsWith('.backup.tmp')) {
  if(phase==='empty' && typeof flags==='number' && (flags & constants.O_EXCL)) await boundary();
  if(phase==='write' && typeof flags==='number' && (flags & constants.O_RDWR)) {
   const write=handle.writeFile;
   handle.writeFile=async function(value) {await this.write(value.subarray(0,7));await boundary();return write.call(this,value);};
  }
 }
 return handle;
};
for(const method of ['link','rename']) {
 const original=fs[method];
 fs[method]=async function(...args) {const result=await original.apply(this,args);if(phase===method) await boundary();return result;};
}
const pin=await pinDirectory(root), intent=JSON.parse(await fs.readFile(journal,'utf8'));
await publishNotePublication(pin,intent,bytes,{persistIntent:async value=>{
 const handle=await open(journal,'w',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 if(phase==='journal') await boundary();
}});
process.send('unexpected completion');
`;

async function killedPublication(t, root, pin, intent, phase) {
  const journal = path.join(root, `intent-${phase}.json`); await fs.writeFile(journal, JSON.stringify(intent), { mode: 0o600 });
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, pin.root, journal, phase,
    new URL('../src/storage/note-writer.mjs', import.meta.url).href, new URL('../src/storage/paths.mjs', import.meta.url).href], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Writer did not reach ${phase}`)), 15000);
    child.once('message', message => { clearTimeout(timer); message === 'boundary' ? resolve() : reject(new Error(message)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Writer exited before boundary: ${code}/${signal}`)); });
  });
  child.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');
  return JSON.parse(await fs.readFile(journal, 'utf8'));
}

for (const [phase, action] of [['published', 'retry'], ['restored-target', 'retry'], ['published', 'skip']]) {
  test(`Windows Archive restoration survives death at ${phase} before ${action}`, { skip: process.platform !== 'win32' }, async t => {
    const { root, notes, pin } = await fixture(t), target = path.join(notes, 'note.md'), before = Buffer.from('original\n');
    await fs.writeFile(target, before);
    const original = await windowsMetadata(target, 128);
    const intent = await prepare(pin, 'note.md', body, hashBytes(before));
    const journal = await killedPublication(t, root, pin, intent, phase), backup = stagePath(journal).replace(/\.tmp$/, '.backup.tmp');
    assert.deepEqual(await fs.readFile(target), body);
    assert.deepEqual(await fs.readFile(backup), before);
    assert.equal((await fs.stat(target, { bigint: true })).ino.toString(), journal.stage.inode);
    assert.equal((await fs.stat(backup, { bigint: true })).ino.toString(), journal.original.inode);
    assert.equal((await windowsMetadata(target)).attributes, phase === 'published' ? 32 : 128);
    assert.equal((await windowsMetadata(backup)).attributes, 32);
    assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: 'conflict', code: 'NOTE_PUBLICATION_CONFLICT' });
    assert.deepEqual(await readPublicationSource(pin, journal), { status: 'pending', bytes: before });
    assert.equal((await windowsMetadata(backup)).attributes, 32); // Read-only inspection did not finish restoration.
    if (action === 'skip') assert.deepEqual(await discardNoteStage(pin, journal), { discarded: true, applied: true });
    else assert.equal((await publish(pin, journal)).receipt.changed, true);
    assert.deepEqual(await windowsMetadata(target), original);
    assert.deepEqual(await fs.readFile(target), body);
    assert.deepEqual(await fs.readdir(notes), ['note.md']);
    assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: 'applied' });
  });
}

for (const changed of ['target', 'target-stream', 'backup', 'missing-backup', 'public-original']) {
  test(`Windows Archive recovery refuses ${changed} metadata without changing it`, { skip: process.platform !== 'win32' }, async t => {
    const { root, notes, pin } = await fixture(t), target = path.join(notes, 'note.md'), before = Buffer.from('original\n');
    await fs.writeFile(target, before); await windowsMetadata(target, 128);
    let intent = await prepare(pin, 'note.md', body, hashBytes(before));
    if (changed !== 'public-original') intent = await killedPublication(t, root, pin, intent, 'published');
    const backup = stagePath(intent).replace(/\.tmp$/, '.backup.tmp');
    const selected = changed === 'backup' ? backup : target;
    if (changed === 'missing-backup') await fs.rename(backup, path.join(notes, 'preserved-original.md'));
    else if (changed === 'target-stream') await fs.writeFile(`${target}:manual-edit`, 'preserve this metadata');
    else await windowsMetadata(selected, changed === 'public-original' ? 32 : 8224); // Otherwise add NotContentIndexed + Archive.
    const metadata = await windowsMetadata(selected), names = (await fs.readdir(notes)).sort(), bytes = await fs.readFile(selected);
    await assert.rejects(publish(pin, intent), { code: 'NOTE_PUBLICATION_CONFLICT' });
    assert.deepEqual(await inspectPublicationOutcome(pin, intent), { status: 'conflict', code: 'NOTE_PUBLICATION_CONFLICT' });
    await assert.rejects(readPublicationSource(pin, intent), { code: 'NOTE_PUBLICATION_CONFLICT' });
    await assert.rejects(discardNoteStage(pin, intent), { code: 'NOTE_PUBLICATION_CONFLICT' });
    assert.deepEqual(await windowsMetadata(selected), metadata);
    assert.deepEqual(await fs.readFile(selected), bytes);
    assert.deepEqual((await fs.readdir(notes)).sort(), names);
    if (changed === 'target-stream') assert.equal(await fs.readFile(`${target}:manual-edit`, 'utf8'), 'preserve this metadata');
  });
}

for (const phase of ['empty', 'journal', 'write', 'link']) {
  test(`process death at ${phase} recovers the same run/draft without orphan staging`, async t => {
    const { root, notes, pin } = await fixture(t), intent = await prepare(pin);
    const journal = await killedPublication(t, root, pin, intent, phase);
    if (phase === 'link') {
      assert.equal((await fs.stat(path.join(notes, 'note.md'))).nlink, 2);
      assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: 'applied' });
    }
    const result = await publish(pin, journal);
    assert.equal(result.receipt.changed, true);
    assert.deepEqual(await fs.readFile(path.join(notes, 'note.md')), body);
    assert.equal((await fs.stat(path.join(notes, 'note.md'))).nlink, 1);
    assert.deepEqual(await fs.readdir(notes), ['note.md']);
  });
}

test('process death after replacement is recognized without refreshing the expected original', { skip: process.platform === 'win32' }, async t => {
  const { root, notes, pin } = await fixture(t), before = Buffer.from('original');
  await fs.writeFile(path.join(notes, 'note.md'), before);
  const intent = await prepare(pin, 'note.md', body, hashBytes(before));
  const journal = await killedPublication(t, root, pin, intent, 'rename');
  assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: 'applied' });
  assert.equal((await publish(pin, journal)).receipt.changed, true);
  assert.deepEqual(await fs.readFile(path.join(notes, 'note.md')), body);
});

test('a torn existing-note stage resumes with its original metadata intact', async t => {
  const { root, notes, pin } = await fixture(t), before = Buffer.from('original note bytes');
  const target = path.join(notes, 'note.md'); await fs.writeFile(target, before, { mode: 0o640 });
  if (process.platform === 'darwin') await execute('/usr/bin/xattr', ['-w', 'com.cuefluent.synthetic', 'preserved', target]);
  const intent = await prepare(pin, 'note.md', body, hashBytes(before));
  const journal = await killedPublication(t, root, pin, intent, 'write');
  assert.deepEqual(await fs.readFile(target), before);
  assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: 'unapplied' });
  await publish(pin, journal);
  assert.deepEqual(await fs.readFile(target), body);
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  if (process.platform === 'darwin') assert.equal((await execute('/usr/bin/xattr', ['-p', 'com.cuefluent.synthetic', target])).stdout.trim(), 'preserved');
});

for (const action of ['resume', 'skip', 'skip-linked']) {
  test(`a Windows-style partial replacement with its exact original backup can ${action}`, async t => {
    const { root, notes, pin } = await fixture(t), before = Buffer.from('original note bytes');
    const target = path.join(notes, 'note.md'); await fs.writeFile(target, before);
    const intent = await prepare(pin, 'note.md', body, hashBytes(before));
    const journal = await killedPublication(t, root, pin, intent, 'journal');
    const backup = stagePath(journal).replace(/\.tmp$/, '.backup.tmp');
    await fs.rename(target, backup);
    assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: 'unapplied' });
    if (action === 'resume') {
      await publish(pin, journal); assert.deepEqual(await fs.readFile(target), body);
    } else {
      // Also exercise a crash after no-overwrite restoration, before removing
      // the original's backup link. This is exact two-inode-name recovery.
      if (action === 'skip-linked') {
        await fs.link(backup, target);
        assert.equal((await fs.stat(target)).nlink, 2);
        assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: 'unapplied' });
      }
      await discardNoteStage(pin, journal); assert.deepEqual(await fs.readFile(target), before);
      assert.equal((await fs.stat(target)).nlink, 1);
    }
    assert.deepEqual(await fs.readdir(notes), ['note.md']);
  });
}

test('an unknown empty-stage extended attribute is preserved instead of adopted', { skip: process.platform !== 'darwin' }, async t => {
  const { notes, pin } = await fixture(t), intent = await prepare(pin);
  await fs.writeFile(stagePath(intent), '');
  await execute('/usr/bin/xattr', ['-w', 'com.cuefluent.unexpected', 'preserve', stagePath(intent)]);
  await assert.rejects(publish(pin, intent), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.equal((await execute('/usr/bin/xattr', ['-p', 'com.cuefluent.unexpected', stagePath(intent)])).stdout.trim(), 'preserve');
  assert.deepEqual((await fs.readdir(notes)).filter(name => name.endsWith('.md')), []);
});

test('a third hardlink after interrupted absent publication is preserved and reported', async t => {
  const { root, notes, pin } = await fixture(t), intent = await prepare(pin);
  const journal = await killedPublication(t, root, pin, intent, 'link');
  await fs.link(stagePath(journal), path.join(root, 'unrelated-hardlink'));
  await assert.rejects(publish(pin, journal), { code: 'NOTE_PUBLICATION_CONFLICT' });
  assert.equal((await fs.stat(path.join(notes, 'note.md'))).nlink, 3);
  assert.equal((await fs.stat(stagePath(journal))).nlink, 3);
  assert.deepEqual(await fs.readFile(path.join(root, 'unrelated-hardlink')), body);
});
