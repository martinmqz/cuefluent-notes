import { fail } from './workflow-values.mjs';
import { absolutePath, inside, canonicalWorkflowProject } from './workflow-paths.mjs';

// Fixed native registry facts: no process HOME/LOCALAPPDATA expansion and no WMI.
// The token's ProfileList entry establishes location before profile policy is needed.
export const PROFILE_FOLDERS_PROBE = String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$i=[Security.Principal.WindowsIdentity]::GetCurrent();
$key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$i.User.Value);
try { $profilePath=$key.GetValue('ProfileImagePath',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { if($key){$key.Dispose()} };
if($profilePath -isnot [string]){throw 'Profile location unavailable'};
$drive=[IO.Path]::GetPathRoot([Environment]::SystemDirectory).TrimEnd('\');
$profilePath=[regex]::Replace($profilePath,'(?i)%SystemDrive%',{param($match) $drive});
if($profilePath.Contains('%')){throw 'Unverified profile location'};
$local=$null;
$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders');
try { if($key){$local=$key.GetValue('Local AppData',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} } finally { if($key){$key.Dispose()} };
@{sid=$i.User.Value; home=$profilePath; local=$local} | ConvertTo-Json -Depth 3 -Compress`;

// Only private paths under the native profile outside LocalAppData need this
// policy. The caller caches it for one operation and fails closed for those paths.
export const PROFILE_PROBE = String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$i=[Security.Principal.WindowsIdentity]::GetCurrent();
$p=@(Get-CimInstance Win32_UserProfile -Filter ("SID='"+$i.User.Value+"'") -OperationTimeoutSec 5);
@{sid=$i.User.Value;
  profiles=@($p | ForEach-Object { @{sid=$_.SID; localPath=$_.LocalPath; loaded=$_.Loaded; special=$_.Special;
    roaming=$_.RoamingConfigured; preference=$_.RoamingPreference; status=$_.Status} })} | ConvertTo-Json -Depth 4 -Compress`;

/** Expand only from the native profile location, never caller environment values. */
export function nativeLocalPath(home, local) {
  home = absolutePath(home, 'win32');
  if (typeof local !== 'string') fail('PRIVATE_PROFILE_UNVERIFIED');
  const drive = /^[a-z]:/i.exec(home)?.[0];
  const values = { userprofile: home, homedrive: drive, homepath: drive ? home.slice(2) : undefined };
  const expanded = local.replace(/%([^%]+)%/g, (token, name) => Object.hasOwn(values, name.toLowerCase()) ? values[name.toLowerCase()] ?? token : token);
  if (expanded.includes('%')) fail('PRIVATE_PROFILE_UNVERIFIED');
  return absolutePath(expanded, 'win32');
}

export async function resolveNativeProfileFolders(value) {
  if (!value || typeof value.sid !== 'string') fail('PRIVATE_PROFILE_UNVERIFIED');
  const home = await canonicalWorkflowProject(value.home, { allowMissing: false });
  let local = null;
  try { local = await canonicalWorkflowProject(nativeLocalPath(value.home, value.local), { allowMissing: false }); }
  catch { /* Unusable LocalAppData cannot exempt a path inside the profile. */ }
  return { sid: value.sid, home, local };
}

export function profileIndexPaths(value, sid, files) {
  if (!value || value.sid !== sid) fail('PRIVATE_PROFILE_UNVERIFIED');
  let home;
  try { home = absolutePath(value.home, 'win32'); } catch { fail('PRIVATE_PROFILE_UNVERIFIED'); }
  const selected = files.filter(file => inside(home, absolutePath(file, 'win32'), 'win32'));
  if (!selected.length) return new Set();
  let local;
  try { local = absolutePath(value.local, 'win32'); } catch { fail('PRIVATE_PROFILE_UNVERIFIED'); }
  if (inside(local, home, 'win32')) fail('PRIVATE_PROFILE_UNVERIFIED');
  return new Set(selected.filter(file => !inside(local, file, 'win32')));
}

/** Native folder facts may themselves be directory aliases. Resolve their
 * targets, while private roots retain their stricter no-leaf-link rule. */
export async function resolveProfileFolders(value) {
  const resolve = file => canonicalWorkflowProject(file, { allowMissing: false });
  if (!value || !Array.isArray(value.profiles) || value.profiles.length !== 1) fail('PRIVATE_PROFILE_UNVERIFIED');
  return { ...value, home: await resolve(value.home), local: await resolve(value.local),
    profiles: [{ ...value.profiles[0], localPath: await resolve(value.profiles[0].localPath) }] };
}

/** Returns the paths needing inherited content-index suppression. Only private
 * paths are callers of this policy; user Markdown destinations are excluded. */
export function windowsProfilePolicy(value, sid, files) {
  const indexed = profileIndexPaths(value, sid, files);
  if (!indexed.size) return indexed;
  if (!Array.isArray(value.profiles) || value.profiles.length !== 1) fail('PRIVATE_PROFILE_UNVERIFIED');
  const p = value.profiles[0];
  let home, local, profile;
  try {
    home = absolutePath(value.home, 'win32'); local = absolutePath(value.local, 'win32'); profile = absolutePath(p.localPath, 'win32');
  } catch { fail('PRIVATE_PROFILE_UNVERIFIED'); }
  if (p.sid !== sid || home.toLowerCase() !== profile.toLowerCase() || p.loaded !== true || p.special !== false ||
      !Number.isInteger(p.status) || p.status < 0 || p.status > 15 || typeof p.roaming !== 'boolean' ||
      ![null, false, true].includes(p.preference) || inside(local, home, 'win32')) fail('PRIVATE_PROFILE_UNVERIFIED');
  // RoamingPreference defaults to true but has no effect without configured
  // roaming. Keep rejecting configured roaming and unsafe status independently.
  if (!/^[a-z]:\\/i.test(home) || p.roaming || p.status !== 0) fail('PRIVATE_PROFILE_UNSAFE');
  return indexed;
}
