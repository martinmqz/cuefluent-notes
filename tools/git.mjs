import { execFileSync } from 'node:child_process';

/** Local Git operations must not inherit redirection, replacements or user hooks. */
export function gitEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^GIT_/i.test(key)));
  // Git for Windows accepts /dev/null, but rejects Node's \\.\nul device path.
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

export function createGitRunner(repoRoot, { env = process.env } = {}) {
  const environment = gitEnvironment(env);
  return (args, { input } = {}) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repoRoot, env: environment, input, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
