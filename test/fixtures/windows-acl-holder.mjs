import { execFileSync } from 'node:child_process';
import { assertPrivateAccess } from '../../src/storage/platform.mjs';

assertPrivateAccess(process.argv[2]);
const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid}" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress`;
const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
process.send({ helpers: JSON.parse(output.trim()) });
process.on('message', () => process.exit(0));
