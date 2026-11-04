import { constants } from 'node:fs';
import { access, lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../core/errors.mjs';

// Shared by the read-only native adapter and processing launches. Never execute
// a shell shim or search the project working directory through relative PATH.
async function executableFile(candidate) {
  try {
    await access(candidate, constants.X_OK); const canonical = await realpath(candidate);
    if ((await lstat(canonical)).isFile()) return canonical;
  } catch { /* No executable at this exact candidate. */ }
  return null;
}

async function windowsExecutable(command) {
  const absolute = path.isAbsolute(command), name = path.parse(command).name.toLowerCase();
  const directories = absolute ? [path.dirname(command)] : String(process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory));
  if (!absolute && path.basename(command) !== command) return null;
  for (const directory of directories) {
    const candidate = path.join(directory, path.extname(command).toLowerCase() === '.exe' ? path.basename(command) : `${path.basename(command)}.exe`);
    const found = await executableFile(candidate); if (found) return found;
  }
  if (!['codex', 'claude'].includes(name) || !['x64', 'arm64'].includes(process.arch)) return null;
  // npm's .cmd/.ps1/extensionless launchers are shell text, not executables.
  // Resolve only the known adjacent package's native binary; never evaluate a
  // wrapper, read client config, or discover any authentication file.
  const architecture = process.arch, triple = architecture === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
  for (const directory of directories) {
    let wrapper = false;
    for (const suffix of ['', '.cmd', '.ps1']) if (await executableFile(path.join(directory, name + suffix))) { wrapper = true; break; }
    if (!wrapper) continue;
    const packages = name === 'codex' ? [
      ['@openai/codex', '@openai/codex'], [`@openai/codex-win32-${architecture}`, '@openai/codex'],
      [`@openai/codex/node_modules/@openai/codex-win32-${architecture}`, '@openai/codex'],
    ] : [['@anthropic-ai/claude-code', '@anthropic-ai/claude-code'], [`@anthropic-ai/claude-code-win32-${architecture}`, `@anthropic-ai/claude-code-win32-${architecture}`]];
    for (const [relative, identity] of packages) {
      const root = path.join(directory, 'node_modules', ...relative.split('/')), manifest = path.join(root, 'package.json');
      try {
        const stat = await lstat(manifest); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) continue;
        const bytes = await readFile(manifest); if (bytes.length > 64 * 1024) continue;
        const metadata = JSON.parse(bytes); if (metadata.name !== identity || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.version)) continue;
        const candidates = name === 'codex' ? [`vendor/${triple}/bin/codex.exe`, `vendor/${triple}/codex/codex.exe`] : ['bin/claude.exe', 'claude.exe'];
        for (const relative of candidates) { const found = await executableFile(path.join(root, ...relative.split('/'))); if (found) return found; }
      } catch { /* Missing or unsupported public program package. */ }
    }
  }
  return null;
}

export async function executablePath(command) {
  if (typeof command !== 'string' || !command || Buffer.byteLength(command) > 4096 || /\u0000|\p{Cs}/u.test(command)) fail('PROCESSING_ARGUMENT', 'A supported native executable name is required.');
  if (process.platform === 'win32') { const found = await windowsExecutable(command); if (found) return found; fail('PROCESSING_CLIENT_MISSING', 'A supported native processing executable is unavailable.'); }
  if (!path.isAbsolute(command) && path.basename(command) !== command) fail('PROCESSING_CLIENT_MISSING', 'Relative native executable paths are unsupported.');
  const candidates = path.isAbsolute(command) ? [command] : String(process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    const found = await executableFile(candidate); if (found) return found;
  }
  fail('PROCESSING_CLIENT_MISSING', 'The selected native processing client is unavailable.');
}
