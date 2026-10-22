import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from '../core/errors.mjs';
import { hashBytes } from './files.mjs';
import { assertChain, assertDirectory, fileIdentity, inspectParent, lstatOrNull, relativePath, sameIdentity } from './paths.mjs';
import { readHandleStat, readPathStat } from './stat.mjs';

import { MAX_NOTE_BYTES, validateNotePublication } from '../core/note-publication.mjs';
export { MAX_NOTE_BYTES, validateNotePublication } from '../core/note-publication.mjs';
const METADATA_BYTES = 256 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const execute = promisify(execFile);
const HASH = /^[0-9a-f]{64}$/;
const conflict = message => fail('NOTE_PUBLICATION_CONFLICT', message);
const invalid = message => fail('NOTE_PUBLICATION_INVALID', message);

function exactBytes(bytes, hash, length) {
  if (typeof hash !== 'string' || !HASH.test(hash)) invalid('Publication requires an exact SHA-256 draft hash.');
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) invalid('Publication requires exact draft bytes.');
  const copy = Buffer.from(bytes);
  if (copy.length > MAX_NOTE_BYTES || (length !== undefined && copy.length !== length) || hashBytes(copy) !== hash) invalid('Draft bytes do not match the exact bounded publication hash and size.');
  return copy;
}

async function command(file, args, { maxBuffer = METADATA_BYTES, env } = {}) {
  try {
    const result = await execute(file, args, { encoding: 'buffer', timeout: 15000, maxBuffer, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...env } });
    if (result.stderr.length) fail('NOTE_METADATA_UNSUPPORTED', 'The native metadata helper reported a diagnostic; the original note was preserved.');
    return result.stdout;
  } catch (cause) {
    if (cause.code === 'NOTE_METADATA_UNSUPPORTED') throw cause;
    // execFile errors retain stdout, which can contain a bounded tar inventory
    // including note bytes. Keep those bytes out of diagnostic error chains.
    const detail = new Error('A native metadata helper failed.');
    detail.code = typeof cause.code === 'string' || typeof cause.code === 'number' ? cause.code : 'NATIVE_FAILURE';
    fail('NOTE_METADATA_UNSUPPORTED', 'Native metadata preservation could not be verified; the original note was preserved.', detail);
  }
}

// Linux uses GNU tar's PAX metadata inventory to verify ACLs and every xattr
// namespace, including binary values. The archive is bounded by the note profile;
// no archive is extracted and no note bytes enter the publication intent.
function linuxMetadata(archive) {
  const metadata = [], ignored = new Set(['path', 'linkpath', 'size', 'uid', 'gid', 'uname', 'gname', 'mtime', 'atime', 'ctime']);
  let offset = 0, records = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) break;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim();
    if (!/^[0-7]+$/.test(sizeText)) fail('NOTE_METADATA_UNSUPPORTED', 'Unsupported metadata archive size.');
    const size = Number.parseInt(sizeText, 8), type = header[156];
    if (!Number.isSafeInteger(size) || offset + size > archive.length) fail('NOTE_METADATA_UNSUPPORTED', 'Truncated metadata archive.');
    if (type === 120 || type === 103) {
      const pax = archive.subarray(offset, offset + size);
      if (pax.length > METADATA_BYTES) fail('NOTE_METADATA_UNSUPPORTED', 'Note metadata exceeds the supported profile.');
      let cursor = 0;
      while (cursor < pax.length) {
        const space = pax.indexOf(32, cursor);
        const lengthText = pax.subarray(cursor, space).toString('ascii');
        if (space < 0 || !/^[1-9][0-9]{0,6}$/.test(lengthText)) fail('NOTE_METADATA_UNSUPPORTED', 'Invalid PAX metadata record.');
        const length = Number(lengthText), end = cursor + length, equal = pax.indexOf(61, space + 1);
        if (length < 5 || end > pax.length || pax[end - 1] !== 10 || equal < 0 || equal >= end - 1) fail('NOTE_METADATA_UNSUPPORTED', 'Invalid PAX metadata record.');
        const key = pax.subarray(space + 1, equal).toString('utf8');
        if (!ignored.has(key)) {
          if (!/^(?:SCHILY\.(?:xattr\.|acl\.)|RHT\.security\.)/.test(key)) fail('NOTE_METADATA_UNSUPPORTED', 'Unsupported extended note metadata.');
          metadata.push([key, pax.subarray(equal + 1, end - 1).toString('hex')]);
        }
        cursor = end;
      }
    } else if (type === 0 || type === 48) { records++; }
    else fail('NOTE_METADATA_UNSUPPORTED', 'The native metadata inventory did not contain one regular note.');
    offset += Math.ceil(size / 512) * 512;
  }
  if (records !== 1) fail('NOTE_METADATA_UNSUPPORTED', 'The native metadata inventory did not contain one regular note.');
  return metadata.sort(([a], [b]) => a.localeCompare(b, 'en'));
}

const WINDOWS_NATIVE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = ConvertFrom-Json $env:CUEFLUENT_NOTE_NATIVE
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class CuefluentNoteNative {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CopyFileExW(string a,string b,IntPtr c,IntPtr d,ref bool cancel,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool ReplaceFileW(string a,string b,string backup,uint flags,IntPtr x,IntPtr y);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 public static byte[] ReadAlternate(string path,long expected) {
  if(expected<0 || expected>262144) throw new IOException("Alternate stream exceeds supported metadata profile");
  using(var handle=CreateFileW(path,0x80000000,7,IntPtr.Zero,3,0x80,IntPtr.Zero)) {
   if(handle.IsInvalid) throw new IOException("Unable to open alternate stream: "+Marshal.GetLastWin32Error());
   using(var stream=new FileStream(handle,FileAccess.Read)) {
    if(stream.Length!=expected) throw new IOException("Alternate stream changed");
    var bytes=new byte[(int)expected]; int offset=0;
    while(offset<bytes.Length) { int count=stream.Read(bytes,offset,bytes.Length-offset); if(count==0) throw new IOException("Alternate stream shortened"); offset+=count; }
    if(stream.ReadByte()!=-1) throw new IOException("Alternate stream grew"); return bytes;
   }
  }
 }
 [StructLayout(LayoutKind.Sequential)] public struct IOSB { public IntPtr Status; public UIntPtr Information; }
 [DllImport("ntdll.dll")] static extern int NtQueryEaFile(SafeFileHandle file,out IOSB io,byte[] buffer,uint length,bool single,IntPtr list,uint listLength,IntPtr index,bool restart);
 public static byte[] Eas(string path) {
  using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
   var buffer=new byte[262144]; IOSB io; int status=NtQueryEaFile(stream.SafeFileHandle,out io,buffer,(uint)buffer.Length,false,IntPtr.Zero,0,IntPtr.Zero,true);
   if(unchecked((uint)status)==0xC0000052) return new byte[0];
   if(status<0) throw new IOException("Unable to verify extended attributes: "+status);
   Array.Resize(ref buffer,checked((int)io.Information.ToUInt64())); return buffer;
  }
 }
}
'@
if ($p.op -eq 'clone') {
 $cancel=$false
 if(-not [CuefluentNoteNative]::CopyFileExW($p.source,$p.stage,[IntPtr]::Zero,[IntPtr]::Zero,[ref]$cancel,0)) { throw ('CopyFileEx failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
 Set-Acl -LiteralPath $p.stage -AclObject (Get-Acl -LiteralPath $p.source -Audit)
} elseif ($p.op -eq 'writable') {
 $attrs=[IO.File]::GetAttributes($p.source)
 [IO.File]::SetAttributes($p.source,($attrs -band (-bnot (1 -bor 2 -bor 4))))
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl=New-Object Security.AccessControl.FileSecurity
 $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
 Set-Acl -LiteralPath $p.source -AclObject $acl
} elseif ($p.op -eq 'attributes') {
 [IO.File]::SetAttributes($p.stage,[IO.File]::GetAttributes($p.source))
} elseif ($p.op -eq 'restore-archive') {
 $attrs=([int][IO.File]::GetAttributes($p.source)) -band (-bnot 32)
 if($attrs -eq 0){$attrs=128}
 [IO.File]::SetAttributes($p.source,$attrs)
} elseif ($p.op -eq 'replace') {
 if(-not [CuefluentNoteNative]::ReplaceFileW($p.source,$p.stage,$p.backup,0,[IntPtr]::Zero,[IntPtr]::Zero)) { throw ('ReplaceFile failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
} elseif ($p.op -eq 'empty') {
 $acl=Get-Acl -LiteralPath $p.source
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 # An administrator token may create public files with its token owner group.
 # Private storage uses a separately established user-only ACL; this check is
 # solely for an otherwise unmodified, inherited-ACL empty public stage.
 if(($owner -ne $identity.User.Value -and $owner -ne $identity.Owner.Value) -or
    $acl.AreAccessRulesProtected -or @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])).Count -ne 0 -or
    @((Get-Item -LiteralPath $p.source -Stream *) | Where-Object Stream -ne ':$DATA').Count -ne 0 -or
    [CuefluentNoteNative]::Eas($p.source).Length -ne 0 -or
    (([int](Get-Item -LiteralPath $p.source -Force).Attributes) -band (-bnot (32 -bor 128))) -ne 0) { throw 'Unjournaled empty stage metadata is not safe to adopt' }
} elseif ($p.op -eq 'metadata') {
 $item=Get-Item -LiteralPath $p.source -Force
 $streams=@(); $total=0
 foreach($stream in @(Get-Item -LiteralPath $p.source -Stream * | Sort-Object Stream)) {
  if($stream.Stream -eq ':$DATA') { continue }
  $total += $stream.Length
  if($total -gt 262144) { throw 'Alternate stream metadata exceeds the supported profile' }
  $bytes=[CuefluentNoteNative]::ReadAlternate($p.source+':'+$stream.Stream,$stream.Length)
  if($bytes.Length -ne $stream.Length) { throw 'Alternate stream changed' }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $digest=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  $streams+=@{name=$stream.Stream;length=$stream.Length;hash=$digest}
 }
 $ea=[CuefluentNoteNative]::Eas($p.source); $eas=@(); $offset=0
 while($offset -lt $ea.Length) {
  if($offset+8 -gt $ea.Length) { throw 'Invalid extended attributes' }
  $next=[BitConverter]::ToUInt32($ea,$offset); $nameLength=[int]$ea[$offset+5]; $valueLength=[BitConverter]::ToUInt16($ea,$offset+6)
  if($offset+9+$nameLength+$valueLength -gt $ea.Length) { throw 'Invalid extended attributes' }
  if($nameLength -eq 0 -or $eas.Count -ge 128) { throw 'Unsupported extended attributes' }
  $eaName=New-Object byte[] $nameLength; $eaValue=New-Object byte[] $valueLength
  [Array]::Copy($ea,$offset+8,$eaName,0,$nameLength); [Array]::Copy($ea,$offset+9+$nameLength,$eaValue,0,$valueLength)
  $eas+=@{name=[Convert]::ToBase64String($eaName);flags=[int]$ea[$offset+4];value=[Convert]::ToBase64String($eaValue)}
  if($next -eq 0) { break }; if($next -lt 8 -or $offset+$next -gt $ea.Length) { throw 'Invalid extended attributes' }; $offset+=$next
 }
 # Reading audit rules requires SeSecurityPrivilege. Do not silently discard
 # an unverified SACL by falling back to the ordinary DACL-only Get-Acl call.
 @{acl=(Get-Acl -LiteralPath $p.source -Audit).Sddl;attributes=[int]$item.Attributes;streams=@($streams);eas=@($eas | Sort-Object name)} | ConvertTo-Json -Depth 8 -Compress
} else { throw 'Unsupported native note operation' }
`;

async function windows(op, source, stage, backup) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot)) fail('NOTE_METADATA_UNSUPPORTED', 'Windows system PowerShell could not be located.');
  return command(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_NATIVE, 'utf16le').toString('base64')],
    { env: { CUEFLUENT_NOTE_NATIVE: JSON.stringify({ op, source, stage, backup }) } });
}

async function linuxInventory(file) {
  const archive = await command('/bin/tar', ['--create', '--format=pax', '--xattrs', '--acls', '--selinux', '--numeric-owner', '--file=-', '--directory', path.dirname(file), '--', path.basename(file)], { maxBuffer: MAX_NOTE_BYTES + 2 * METADATA_BYTES });
  return linuxMetadata(archive);
}

async function safeEmptyStage(file, stat) {
  regular(stat);
  if (stat.size !== 0 || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== (0o666 & ~process.umask())))) conflict('An unjournaled stage must have the exact empty-file owner and default permissions.');
  if (process.platform === 'darwin') {
    const attrs = (await command('/usr/bin/xattr', [file])).toString('utf8').split('\n').filter(Boolean);
    const acl = (await command('/bin/ls', ['-lde', file])).toString('utf8').split('\n').slice(1).filter(Boolean);
    const flags = (await command('/usr/bin/stat', ['-f', '%f', file])).toString('ascii').trim();
    // macOS attaches provenance even to a newly created, empty Node file. It is
    // not a permission grant; arbitrary user attributes remain a conflict.
    if (attrs.some(name => name !== 'com.apple.provenance') || flags !== '0' || acl.some(line => !/^\s+[0-9]+: .* inherited /.test(line))) conflict('Unjournaled empty-stage metadata is not safe to adopt.');
  } else if (process.platform === 'linux') {
    for (const [key, value] of await linuxInventory(file)) {
      if (key !== 'SCHILY.acl.access' || !/^user::[rwx-]{3},group::[rwx-]{3},other::[rwx-]{3}$/.test(Buffer.from(value, 'hex').toString('utf8'))) conflict('Unjournaled empty-stage metadata is not safe to adopt.');
    }
  } else if (process.platform === 'win32') await windows('empty', file);
  else fail('NOTE_METADATA_UNSUPPORTED', 'Safe empty-stage recovery is unavailable on this platform.');
}

async function metadataEvidence(file) {
  const before = await readPathStat(file), exact = fileIdentity(before);
  let extra;
  if (process.platform === 'darwin') {
    const names = (await command('/usr/bin/xattr', [file])).toString('utf8').split('\n').filter(Boolean).sort();
    if (names.length > 128 || names.some(name => name.length > 1024 || /[\u0000-\u001f\u007f]/.test(name))) fail('NOTE_METADATA_UNSUPPORTED', 'Note extended attributes exceed the supported profile.');
    const attrs = []; let total = 0;
    for (const name of names) {
      const value = (await command('/usr/bin/xattr', ['-px', name, file])).toString('ascii').replace(/\s/g, '').toLowerCase();
      if (!/^(?:[0-9a-f]{2})*$/.test(value) || (total += value.length / 2) > METADATA_BYTES) fail('NOTE_METADATA_UNSUPPORTED', 'Note extended attributes exceed the supported profile.');
      attrs.push([name, value]);
    }
    const acl = (await command('/bin/ls', ['-lde', file])).toString('utf8').split('\n').slice(1).filter(Boolean);
    if (acl.some(line => !/^\s+[0-9]+: /.test(line))) fail('NOTE_METADATA_UNSUPPORTED', 'The note ACL could not be verified.');
    const flags = (await command('/usr/bin/stat', ['-f', '%f', file])).toString('ascii').trim();
    if (!/^[0-9]+$/.test(flags)) fail('NOTE_METADATA_UNSUPPORTED', 'The note flags could not be verified.');
    extra = { attrs, acl, flags };
  } else if (process.platform === 'linux') {
    extra = await linuxInventory(file);
  } else if (process.platform === 'win32') {
    try { extra = JSON.parse((await windows('metadata', file)).toString('utf8').replace(/^\uFEFF/, '')); }
    catch (cause) { fail('NOTE_METADATA_UNSUPPORTED', 'Windows note metadata could not be verified.', cause); }
  } else fail('NOTE_METADATA_UNSUPPORTED', 'Native note metadata preservation is unavailable on this platform.');
  const after = await readPathStat(file);
  if (!sameIdentity(after, exact) || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size || before.mode !== after.mode) conflict('The note metadata changed while it was inspected.');
  // PowerShell hashtable serialization order can vary between processes.
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const value = { mode: before.mode, uid: before.uid, gid: before.gid, extra };
  const fingerprint = input => hashBytes(Buffer.from(JSON.stringify(stable(input))));
  // Rename/replacement can set Archive on both Windows inodes. This second
  // fingerprint is only evidence for that one exact intermediate state, never
  // the ordinary metadata comparison or permission to change a public original.
  const withoutArchive = process.platform === 'win32' && (extra.attributes & 32)
    ? fingerprint({ ...value, extra: { ...extra, attributes: (extra.attributes & ~32) || 128 } }) : null;
  return { hash: fingerprint(value), withoutArchive };
}

const metadata = async file => (await metadataEvidence(file)).hash;

async function publishedMetadata(file, intent) {
  const evidence = await metadataEvidence(file);
  if (evidence.hash === intent.original.metadata) return false;
  if (evidence.withoutArchive === intent.original.metadata) return true;
  conflict('The exact publication metadata changed beyond the native Archive transition.');
}

async function cloneOriginal(source, stage) {
  if (process.platform === 'darwin') await command('/bin/cp', ['-p', source, stage]);
  else if (process.platform === 'linux') await command('/bin/cp', ['--preserve=mode,ownership,timestamps,xattr', '--', source, stage]);
  else if (process.platform === 'win32') await windows('clone', source, stage);
  else fail('NOTE_METADATA_UNSUPPORTED', 'Native note metadata preservation is unavailable on this platform.');
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
  catch (error) { if (!(process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code))) throw error; }
  finally { await handle?.close(); }
}

function regular(stat, links = 1) {
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== links) conflict('A publication path must be a regular file with exactly its expected hard links.');
  if (stat.size > MAX_NOTE_BYTES) conflict('A publication file exceeds the supported note profile.');
}

async function snapshot(file, { links = 1, missing = false } = {}) {
  const before = await lstatOrNull(file);
  if (!before) { if (missing) return null; conflict('A publication file is missing.'); }
  regular(before, links);
  const exact = fileIdentity(before), handle = await fs.open(file, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await readHandleStat(handle); regular(opened, links);
    if (!sameIdentity(opened, exact)) conflict('A publication file changed while opening.');
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) conflict('A publication file was shortened.'); offset += read.bytesRead; }
    const after = await readHandleStat(handle), current = await lstatOrNull(file);
    if (!current || !sameIdentity(current, exact) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) conflict('A publication file changed during inspection.');
    regular(current, links);
    return { bytes, hash: hashBytes(bytes), identity: exact, stat: current };
  } finally { await handle.close(); }
}

async function location(pin, intent) {
  if (!pin || pin.private !== false || pin.root !== intent.root) invalid('Use the exact pinned public note root.');
  await assertDirectory(pin);
  for (const entry of pin.chain) {
    const saved = intent.parent.find(parent => parent.path === entry.path);
    if (!saved || entry.device !== saved.device || entry.inode !== saved.inode) conflict('The current run has a different note root pin.');
  }
  await assertChain(intent.parent);
  const target = relativePath(pin, intent.relative), directory = path.dirname(target);
  return { target, directory, stage: path.join(directory, `.cuefluent-note.${intent.runId}.${intent.draftId}.tmp`), backup: path.join(directory, `.cuefluent-note.${intent.runId}.${intent.draftId}.backup.tmp`) };
}

async function originalMatches(file, intent, links = 1) {
  const current = await snapshot(file, { missing: true, links });
  if (intent.expectedHash === null) { if (current) conflict('A new note destination appeared after inspection.'); return null; }
  if (!current || current.hash !== intent.expectedHash || !sameIdentity(current.stat, intent.original) || await metadata(file) !== intent.original.metadata) conflict('The exact inspected original note or its metadata changed.');
  return current;
}

/** Read-only preparation. The caller persists this intent in the current run. */
export async function prepareNotePublication(pin, relative, bytes, { runId, draftId, expectedHash, hash, maxBytes = MAX_NOTE_BYTES, expectedParentChain } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_NOTE_BYTES) invalid('Invalid note size profile.');
  const draft = exactBytes(bytes, hash);
  if (draft.length > maxBytes) fail('NOTE_LIMIT_EXCEEDED', 'The note exceeds its supported size profile.');
  const parent = await inspectParent(pin, relative);
  if (expectedParentChain !== undefined) {
    const bound = validateNotePublication({ schema: 1, runId, draftId, root: pin.root, relative, parent: expectedParentChain,
      expectedHash: null, hash, bytes: draft.length, original: null, stage: null });
    if (JSON.stringify(bound.parent) !== JSON.stringify(parent.chain)) conflict('The draft target parent differs from its frozen inspected binding.');
    await assertChain(bound.parent);
  }
  const current = await snapshot(parent.file, { missing: true });
  if ((expectedHash === null && current) || (expectedHash !== null && (!current || current.hash !== expectedHash))) conflict('The note differs from the exact inspected original or absence.');
  const original = current ? { ...current.identity, metadata: await metadata(parent.file) } : null;
  const intent = validateNotePublication({ schema: 1, runId, draftId, root: pin.root, relative, parent: parent.chain,
    expectedHash, hash, bytes: draft.length, original, stage: null });
  await location(pin, intent);
  await originalMatches(parent.file, intent);
  return intent;
}

async function outcome(pin, intent, { windowsRecovery = false } = {}) {
  const names = await location(pin, intent);
  const stat = await lstatOrNull(names.target), stageStat = await lstatOrNull(names.stage), backupStat = await lstatOrNull(names.backup);
  if (backupStat && (!intent.original || !sameIdentity(backupStat, intent.original))) conflict('The publication backup is not the exact inspected original inode.');
  if (stat && intent.stage && sameIdentity(stat, intent.stage)) {
    const links = stageStat ? 2 : 1;
    if (stageStat && !sameIdentity(stageStat, intent.stage)) conflict('The staging name was replaced after publication.');
    const current = await snapshot(names.target, { links });
    if (current.hash !== intent.hash || current.bytes.length !== intent.bytes) conflict('The published note differs from its exact draft.');
    let targetArchive = false, backupArchive = false;
    if (windowsRecovery && process.platform === 'win32' && intent.original && backupStat) {
      const backup = await snapshot(names.backup);
      if (!sameIdentity(backup.stat, intent.original) || backup.hash !== intent.expectedHash) conflict('The exact publication backup changed.');
      // Both exact inodes and both exact contents are necessary. An unrelated
      // metadata edit, an absent backup, or a still-public original cannot enter
      // this recovery path; every metadata field participates in either hash.
      backupArchive = await publishedMetadata(names.backup, intent);
      targetArchive = await publishedMetadata(names.target, intent);
    } else {
      if (intent.original && await metadata(names.target) !== intent.original.metadata) conflict('The published note differs from its preserved metadata.');
      if (backupStat) await originalMatches(names.backup, intent);
    }
    if (stageStat) regular(stageStat, 2);
    await assertChain(intent.parent); await assertDirectory(pin);
    return { status: targetArchive || backupArchive ? 'metadata-pending' : 'applied', targetArchive, backupArchive, ...names };
  }
  if (stat) {
    const links = backupStat ? 2 : 1;
    await originalMatches(names.target, intent, links);
    if (backupStat) await originalMatches(names.backup, intent, links);
  } else if (intent.original) {
    if (!backupStat) conflict('The inspected original note disappeared.');
    await originalMatches(names.backup, intent);
  } else if (backupStat) conflict('An absent-note publication cannot have a backup.');
  if (stageStat) {
    regular(stageStat);
    if (intent.stage && !sameIdentity(stageStat, intent.stage)) conflict('The recorded staging inode was replaced.');
    if (!intent.stage) await safeEmptyStage(names.stage, stageStat);
  }
  await assertChain(intent.parent); await assertDirectory(pin);
  return { status: intent.expectedHash === intent.hash ? 'existing' : 'unapplied', ...names };
}

/** Does not write or complete an interrupted publication. Conflicts are returned
 * so skip can preserve manual edits while retaining the current-run journal. */
export async function inspectPublicationOutcome(pin, input) {
  const intent = validateNotePublication(input);
  try { const current = await outcome(pin, intent); return Object.freeze({ status: current.status }); }
  catch (error) { if (['NOTE_PUBLICATION_CONFLICT', 'PATH_CHANGED', 'PATH_UNSAFE'].includes(error.code)) return Object.freeze({ status: 'conflict', code: error.code }); throw error; }
}

/** Reconstruct a pending log proposal only from its exact original bytes, or
 * finish an already-applied exact publication. Never refresh an expectation. */
export async function readPublicationSource(pin, input) {
  const intent = validateNotePublication(input), current = await outcome(pin, intent, { windowsRecovery: true });
  if (current.status === 'metadata-pending') {
    const original = await snapshot(current.backup);
    if (!sameIdentity(original.stat, intent.original) || original.hash !== intent.expectedHash) conflict('The exact publication backup changed.');
    return Object.freeze({ status: 'pending', bytes: original.bytes });
  }
  if (current.status === 'applied') return Object.freeze({ status: 'applied', bytes: (await snapshot(current.target, { links: await lstatOrNull(current.stage) ? 2 : 1 })).bytes });
  if (intent.expectedHash === null) return Object.freeze({ status: current.status, bytes: null });
  const source = await lstatOrNull(current.target) ? current.target : current.backup;
  const original = await originalMatches(source, intent, await lstatOrNull(current.target) && await lstatOrNull(current.backup) ? 2 : 1);
  return Object.freeze({ status: current.status, bytes: original.bytes });
}

async function unlinkExact(file, expected, links = 1) {
  const stat = await lstatOrNull(file);
  if (!stat) return;
  regular(stat, links);
  if (!sameIdentity(stat, expected)) conflict('A transient publication inode was replaced.');
  await fs.unlink(file);
}

async function finish(pin, intent, names) {
  let current = await outcome(pin, intent, { windowsRecovery: true });
  if (!['applied', 'metadata-pending'].includes(current.status)) conflict('The expected publication did not reach the target.');
  // Windows FlushFileBuffers needs write access even when this handle only
  // confirms already-written bytes. Keep the exact published-inode check.
  const handle = await fs.open(names.target, (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | NO_FOLLOW);
  try { if (!sameIdentity(await readHandleStat(handle), intent.stage)) conflict('The saved note changed before durability was confirmed.'); await handle.sync(); }
  finally { await handle.close(); }
  current = await outcome(pin, intent, { windowsRecovery: true });
  if (current.targetArchive) {
    await windows('restore-archive', names.target);
    current = await outcome(pin, intent, { windowsRecovery: true });
  }
  if (current.backupArchive) await windows('restore-archive', names.backup);
  // Keep the original backup until both inodes have their exact original
  // metadata. A crash between restorations is retryable with the same proof.
  if ((await outcome(pin, intent)).status !== 'applied') conflict('The exact publication metadata was not restored.');
  if (await lstatOrNull(names.stage)) await unlinkExact(names.stage, intent.stage, 2);
  if (await lstatOrNull(names.backup)) {
    await originalMatches(names.backup, intent);
    await unlinkExact(names.backup, intent.original);
  }
  await syncDirectory(names.directory); await assertChain(intent.parent); await assertDirectory(pin);
  return Object.freeze({ draftId: intent.draftId, target: names.target, hash: intent.hash, changed: true });
}

async function reconcileOriginalBackup(pin, intent, names, { restore = false } = {}) {
  if (!await lstatOrNull(names.backup)) return;
  let target = await lstatOrNull(names.target);
  if (!target) {
    if (!restore) return;
    await originalMatches(names.backup, intent);
    try { await fs.link(names.backup, names.target); }
    catch (cause) { if (cause.code === 'EEXIST') conflict('A destination appeared while restoring the inspected original.'); throw cause; }
    target = await readPathStat(names.target);
  }
  if (!intent.original || !sameIdentity(target, intent.original)) conflict('The original backup cannot be reconciled with this destination.');
  await originalMatches(names.target, intent, 2);
  await originalMatches(names.backup, intent, 2);
  await assertChain(intent.parent); await assertDirectory(pin);
  await unlinkExact(names.backup, intent.original, 2);
  await syncDirectory(names.directory); await assertChain(intent.parent);
}

/** Caller holds current-attempt/project/writer fencing. persistIntent must durably
 * replace the current-run intent before resolving. No independent lock or store.
 */
export async function publishNotePublication(pin, input, bytes, { persistIntent } = {}) {
  let intent = validateNotePublication(input);
  const draft = exactBytes(bytes, intent.hash, intent.bytes);
  let current = await outcome(pin, intent, { windowsRecovery: true });
  if (current.status === 'existing') return Object.freeze({ draftId: intent.draftId, target: current.target, hash: intent.hash, changed: false });
  if (['applied', 'metadata-pending'].includes(current.status)) return finish(pin, intent, current);
  if (intent.stage && !await lstatOrNull(current.stage)) conflict('The recorded staging inode disappeared without publication.');
  if (await lstatOrNull(current.target) && await lstatOrNull(current.backup)) {
    await reconcileOriginalBackup(pin, intent, current);
    current = await outcome(pin, intent);
  }
  if (!intent.stage) {
    if (typeof persistIntent !== 'function') invalid('A durable current-run persistIntent callback is required before staging.');
    let handle;
    try { handle = await fs.open(current.stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o666); }
    catch (error) { if (error.code !== 'EEXIST') throw error; handle = await fs.open(current.stage, constants.O_RDWR | NO_FOLLOW); }
    try {
      const stat = await readHandleStat(handle); regular(stat);
      if (stat.size !== 0 || (process.platform !== 'win32' && stat.uid !== process.getuid())) conflict('An unjournaled stage must be empty and owned by this user.');
      const named = await readPathStat(current.stage);
      if (!sameIdentity(named, fileIdentity(stat))) conflict('The empty stage changed during creation.');
      await handle.sync();
      intent = validateNotePublication({ ...intent, stage: fileIdentity(stat) });
    } finally { await handle.close(); }
    await syncDirectory(current.directory); await assertChain(intent.parent);
    await persistIntent(intent);
    current = await outcome(pin, intent);
  }
  const source = (await lstatOrNull(current.target)) ? current.target : current.backup;
  const original = intent.original ? await originalMatches(source, intent) : null;
  const staged = await snapshot(current.stage);
  if (!sameIdentity(staged.stat, intent.stage) || !(draft.subarray(0, staged.bytes.length).equals(staged.bytes) ||
      (original && original.bytes.subarray(0, staged.bytes.length).equals(staged.bytes)))) conflict('The staged content is not an exact draft or original prefix.');
  // A cloned read-only source must remain read-only when published. Open the
  // owned stage while writable, then clone metadata and write through that fd.
  if (process.platform !== 'win32') {
    const permissions = await fs.open(current.stage, constants.O_RDONLY | NO_FOLLOW);
    try {
      const observed = await readHandleStat(permissions); regular(observed);
      if (!sameIdentity(observed, intent.stage)) conflict('The staged inode changed before restoring writable permissions.');
      await permissions.chmod(0o600);
    } finally { await permissions.close(); }
  }
  else if (original) await windows('writable', current.stage);
  const handle = await fs.open(current.stage, constants.O_RDWR | NO_FOLLOW);
  try {
    if (!sameIdentity(await readHandleStat(handle), intent.stage)) conflict('The staged inode changed before writing.');
    if (original) await cloneOriginal(source, current.stage);
    if (!sameIdentity(await readPathStat(current.stage), intent.stage)) conflict('The native helper replaced the staged inode.');
    await assertChain(intent.parent); await assertDirectory(pin);
    if (original) await originalMatches(source, intent);
    await handle.truncate(0); await handle.writeFile(draft);
    if (process.platform !== 'win32') await handle.chmod(original ? original.stat.mode & 0o7777 : 0o666 & ~process.umask());
    // Writing a Linux default stream can clear capability/set-id metadata.
    if (original && process.platform === 'linux') await command('/bin/cp', ['--attributes-only', '--preserve=mode,ownership,xattr', '--', source, current.stage]);
    await handle.sync();
  } finally { await handle.close(); }
  // Windows can set Archive when the last data-writing handle closes, even
  // after SetFileAttributes cleared it. Restore the exact inspected attributes
  // only after flushing and closing that handle; the full fingerprint below
  // still verifies ACLs, audit rules, streams, EAs, and every attribute bit.
  if (original && process.platform === 'win32') await windows('attributes', source, current.stage);
  await assertChain(intent.parent); await assertDirectory(pin);
  if (original) await originalMatches(source, intent); else await originalMatches(current.target, intent);
  const complete = await snapshot(current.stage);
  if (!sameIdentity(complete.stat, intent.stage) || complete.hash !== intent.hash || (intent.original && await metadata(current.stage) !== intent.original.metadata)) conflict('Staging did not preserve the exact bytes and original metadata.');
  if (!original || source === current.backup) {
    try { await fs.link(current.stage, current.target); }
    catch (cause) { if (cause.code === 'EEXIST') conflict('A destination appeared before no-overwrite publication.'); throw cause; }
  } else if (process.platform === 'win32') {
    if (await lstatOrNull(current.backup)) conflict('An unexpected backup path prevents publication.');
    await windows('replace', current.target, current.stage, current.backup);
  } else await fs.rename(current.stage, current.target);
  return finish(pin, intent, current);
}

/** Skip may remove only this run's recorded staging inode. A completed public
 * note is never removed. A Windows recovery backup is restored by exact inode
 * without overwriting an arrival if it is the sole inspected original.
 */
export async function discardNoteStage(pin, input, { persistIntent } = {}) {
  let intent = validateNotePublication(input);
  const current = await outcome(pin, intent, { windowsRecovery: true });
  if (!intent.stage) {
    const empty = await lstatOrNull(current.stage);
    if (!empty) return Object.freeze({ discarded: false });
    await safeEmptyStage(current.stage, empty);
    if (typeof persistIntent !== 'function') invalid('Persist the exact empty-stage inode before discarding an unjournaled stage.');
    intent = validateNotePublication({ ...intent, stage: fileIdentity(empty) });
    await persistIntent(intent);
  }
  if (['applied', 'metadata-pending'].includes(current.status)) { await finish(pin, intent, current); return Object.freeze({ discarded: true, applied: true }); }
  if (await lstatOrNull(current.backup)) await reconcileOriginalBackup(pin, intent, current, { restore: true });
  if (!await lstatOrNull(current.stage)) return Object.freeze({ discarded: false, applied: false });
  await unlinkExact(current.stage, intent.stage);
  await syncDirectory(current.directory); await assertChain(intent.parent); await assertDirectory(pin);
  return Object.freeze({ discarded: true, applied: false });
}

/** Explicit abandonment fallback after ordinary reconciliation fails. A changed public
 * target is preserved; only the exact journaled staging link may be removed.
 * A backup is preserved and reported if ordinary recovery could not reconcile it. */
export async function discardRecordedNoteStage(pin, input, { persistIntent } = {}) {
  let intent = validateNotePublication(input);
  const names = await location(pin, intent), stage = await lstatOrNull(names.stage);
  if (stage) {
    if (!intent.stage) {
      await safeEmptyStage(names.stage, stage);
      if (typeof persistIntent !== 'function') invalid('Persist the exact staging identity before discarding it.');
      intent = validateNotePublication({ ...intent, stage: fileIdentity(stage) }); await persistIntent(intent);
    }
    if (!sameIdentity(stage, intent.stage) || ![1, 2].includes(stage.nlink)) conflict('The staging path is not the exact owned inode.');
    if (stage.nlink === 2) {
      const target = await lstatOrNull(names.target);
      if (!target || !sameIdentity(target, intent.stage)) conflict('An unexpected staging alias must be preserved.');
    }
    await unlinkExact(names.stage, intent.stage, stage.nlink); await syncDirectory(names.directory);
  }
  await assertChain(intent.parent); await assertDirectory(pin);
  return Object.freeze({ discarded: Boolean(stage), backupPreserved: Boolean(await lstatOrNull(names.backup)) });
}
