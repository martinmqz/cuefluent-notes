import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One environment per test process, including focused runs and spawned CLIs.
// Keep native tools/token inputs intact; these paths do not simulate SID/profile
// policy. The separate native standard-user fixture deliberately omits this file.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-test-')));
if (process.platform === 'win32') {
  // Protect only this newly created empty synthetic parent. A real Windows Temp
  // directory can grant other principals write access; production setup rightly
  // refuses to create private stores under such a parent.
  const { protectNewDirectory, privacyIdentity } = await import('../storage-platform.mjs');
  await protectNewDirectory(root, await privacyIdentity());
}
const home = path.join(root, 'home');
export const isolatedSettingsEnvironment = {
  HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  APPDATA: path.join(home, 'AppData', 'Roaming'), PROGRAMDATA: path.join(root, 'ProgramData'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
  CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  ...(process.platform === 'win32' ? { TEMP: root, TMP: root, TMPDIR: root } : {}),
};
const cleared = new Set([...Object.keys(isolatedSettingsEnvironment), 'CUEFLUENT_WORKFLOW_CONFIG']);
for (const key of Object.keys(process.env)) if (cleared.has(key.toUpperCase())) delete process.env[key];
Object.assign(process.env, isolatedSettingsEnvironment);
for (const file of [home, process.env.LOCALAPPDATA, process.env.APPDATA, process.env.PROGRAMDATA]) fs.mkdirSync(file, { recursive: true });
process.once('exit', () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
