// Bounded repository-maintenance commands; not part of the installed runtime.
import { spawnCommand } from './command.mjs';

export function repositoryCommand(cwd, name, args, {
  input, encoding = 'utf8', maxBuffer = 128 * 1024 * 1024,
  timeout = 180000, allowedStatuses = [0],
} = {}) {
  const result = spawnCommand(name, args, { cwd, input, encoding, timeout, maxBuffer });
  if (result.error || !allowedStatuses.includes(result.status)) {
    const detail = result.error?.message || result.stderr?.toString().trim() || `exit status ${result.status}`;
    throw new Error(`${name} failed: ${detail}`);
  }
  return result;
}
