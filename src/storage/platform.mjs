import { execFileSync } from 'node:child_process';
import { queryWindowsAcl } from './windows-acl.mjs';
import { fail } from '../core/errors.mjs';

function windowsAcl(file, create, { allowAdministratorsOwner = false } = {}) {
  let value;
  try {
    value = queryWindowsAcl(file, create);
  } catch (cause) {
    if (cause.code === 'WINDOWS_ACL_TIMEOUT') fail('PRIVATE_ACCESS_TIMEOUT', 'Windows private storage verification exceeded the operation deadline.', cause);
    fail('PRIVATE_ACCESS_UNVERIFIED', 'Windows private storage permissions could not be verified.', cause);
  }
  // SYSTEM and local administrators can administer the machine in any event.
  const allowed = new Set([value.user, 'S-1-5-18', 'S-1-5-32-544']);
  if (!['Fixed', 'Removable'].includes(value.driveType) || !['NTFS', 'ReFS'].includes(value.format)) {
    fail('PRIVATE_FILESYSTEM_UNSUPPORTED', 'Windows private storage requires a local NTFS or ReFS volume.');
  }
  if ((value.owner !== value.user && !(allowAdministratorsOwner && value.owner === 'S-1-5-32-544')) || !Array.isArray(value.rules) ||
      !value.rules.some(rule => rule.sid === value.user && rule.type === 'Allow' && (rule.rights & 0x1f01ff) === 0x1f01ff) ||
      value.rules.some(rule => rule.type === 'Allow' && !allowed.has(rule.sid))) {
    fail('PRIVATE_ACCESS_UNSAFE', 'Private storage must be owned by and restricted to the current user.');
  }
}

/** Set permissions only on a path this operation has just created. */
export function establishWindowsPrivacy(file) {
  if (process.platform === 'win32') windowsAcl(file, true);
}

export function assertPrivateAccess(file, stat) {
  if (process.platform === 'win32') {
    windowsAcl(file, false);
  } else if (Number(stat.uid) !== process.getuid() || (Number(stat.mode) & 0o077) !== 0) {
    fail('PRIVATE_ACCESS_UNSAFE', 'Private storage must be owned by and restricted to the current user.');
  }
}

/** Only for a deterministic current-run reservation before ownership/content is
 * journaled. Elevated Windows creation can initially assign Administrators as
 * owner. It still needs a private DACL, no content and no other link. Callers
 * must independently pin the reservation's parent and recheck its exact inode. */
export function assertEmptyPrivateReservation(file, stat) {
  if (!stat?.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1 || Number(stat.size) !== 0) {
    fail('PRIVATE_ACCESS_UNSAFE', 'An unowned private reservation must be an empty single-link regular file.');
  }
  if (process.platform === 'win32') windowsAcl(file, false, { allowAdministratorsOwner: true });
  else assertPrivateAccess(file, stat);
}

export function assertLocalFilesystem(statfs, root) {
  if (process.platform === 'win32') return; // Verified by the ACL/DriveInfo probe.
  if (process.platform === 'darwin') {
    let type;
    try {
      const result = JSON.parse(execFileSync('/bin/df', ['--libxo', 'json', '-Y', root], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      }));
      const volumes = result['storage-system-information']?.filesystem;
      if (volumes?.length === 1) type = volumes[0].type;
    } catch (cause) {
      fail('PRIVATE_FILESYSTEM_UNVERIFIED', 'The private filesystem type could not be verified.', cause);
    }
    if (['apfs', 'hfs'].includes(type)) return;
  } else if (process.platform === 'linux') {
    // Supported durable local filesystems. Unknown/FUSE/network types fail closed.
    const local = new Set([0xef53, 0x58465342, 0x9123683e, 0x2fc12fc1, 0x794c7630, 0xf2f52010, 0xca451a4e]);
    if (local.has(Number(statfs.type) >>> 0)) return;
  }
  fail('PRIVATE_FILESYSTEM_UNSUPPORTED', 'Private storage requires a supported durable local filesystem.');
}
