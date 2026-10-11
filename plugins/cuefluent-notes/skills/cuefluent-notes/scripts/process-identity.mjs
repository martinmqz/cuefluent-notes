import fs from 'node:fs/promises';
import os from 'node:os';
import { systemCommand, windowsTools } from './storage-platform.mjs';
import { fail } from './workflow-values.mjs';

export function linuxStartTicks(text, pid) {
  const end = text.lastIndexOf(')'), prefix = `${pid} (`;
  if (!text.startsWith(prefix) || end < prefix.length) fail('PROCESS_IDENTITY_UNAVAILABLE');
  const fields = text.slice(end + 1).trim().split(/\s+/), value = fields[19];
  if (!/^\d+$/.test(value ?? '')) fail('PROCESS_IDENTITY_UNAVAILABLE');
  return value;
}
export function macBootIdentity(text) {
  const value = /^\{ sec = (\d+), usec = (\d+) \}/.exec(text.trim());
  if (!value || Number(value[2]) >= 1000000) fail('PROCESS_IDENTITY_UNAVAILABLE');
  return `${value[1]}:${value[2]}`;
}

/** Explicit absence is distinct from a denied or failed native probe. */
export async function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('INVALID_PROCESS_ID');
  let state;
  try { process.kill(pid, 0); state = 'present'; }
  catch (error) { state = error.code === 'ESRCH' ? 'absent' : 'unknown'; }
  try {
    let boot, processStart = null;
    if (process.platform === 'linux') {
      boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot)) fail('PROCESS_IDENTITY_UNAVAILABLE');
      if (state === 'present') processStart = linuxStartTicks(await fs.readFile(`/proc/${pid}/stat`, 'utf8'), pid);
    } else if (process.platform === 'darwin') {
      boot = macBootIdentity(await systemCommand('/usr/sbin/sysctl', ['-n', 'kern.boottime']));
      if (state === 'present') {
        processStart = (await systemCommand('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).trim();
        if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(processStart)) fail('PROCESS_IDENTITY_UNAVAILABLE');
      }
    } else if (process.platform === 'win32') {
      // Fixed program; validated PID enters as environment data. No wmic or policy override.
      const script = "$ErrorActionPreference='Stop'; $b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks.ToString(); $p=Get-Process -Id ([int]$env:CUEFLUENT_PROBE_PID) -ErrorAction SilentlyContinue; $s=$null; if($p){$s=$p.StartTime.ToUniversalTime().Ticks.ToString()}; @{boot=$b; processStart=$s} | ConvertTo-Json -Compress";
      const value = JSON.parse(await systemCommand(windowsTools().powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, CUEFLUENT_PROBE_PID: String(pid) } }));
      if (!/^\d+$/.test(value.boot) || (value.processStart !== null && !/^\d+$/.test(value.processStart))) fail('PROCESS_IDENTITY_UNAVAILABLE');
      boot = value.boot; processStart = value.processStart;
      if (state === 'present' && processStart === null) state = 'unknown';
    } else fail('PROCESS_IDENTITY_UNAVAILABLE');
    return { state, hostname: os.hostname(), processStart, boot, platform: process.platform };
  } catch {
    return { state: 'unknown', hostname: os.hostname(), processStart: null, boot: null, platform: process.platform };
  }
}

let own;
export async function ownProcessIdentity() {
  own ??= probeProcess(process.pid);
  return own;
}

/** No clock-derived inference. Reused live PIDs require recorded start evidence. */
export function ownerIsGone(owner, current) {
  if (owner.hostname !== current.hostname || current.state === 'unknown' || !owner.boot || !current.boot) return false;
  if (current.state === 'absent') return true;
  return owner.boot === current.boot && typeof owner.processStart === 'string' &&
    typeof current.processStart === 'string' && owner.processStart !== current.processStart && current.platform === 'linux';
  // macOS/Windows start and boot times are wall-clock derived: mismatches alone
  // are diagnostic. Equal values or a possibly live owner never permit recovery.
}
