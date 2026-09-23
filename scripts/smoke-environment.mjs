import path from 'node:path';

/** Only process essentials cross into disposable client profiles. */
export function smokeEnvironment(root, inherited = process.env) {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'SYSTEMDRIVE', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS']);
  const env = {};
  for (const [key, value] of Object.entries(inherited).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const upper = key.toUpperCase();
    if (allowed.has(upper) && !Object.hasOwn(env, upper)) env[upper] = value;
  }
  const home = path.join(root, 'home café with spaces');
  return { ...env, HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    CUEFLUENT_NOTES_CONFIG: path.join(home, 'capture.json'),
    // One task-local cache for the CLI bootstrap and all default-runner installs.
    npm_config_cache: path.join(root, 'npm-cache'), npm_config_prefer_offline: 'true',
    npm_config_userconfig: path.join(root, 'empty-user.npmrc'),
    npm_config_globalconfig: path.join(root, 'empty-global.npmrc'),
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
