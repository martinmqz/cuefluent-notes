import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

// Source checkouts use the skill root. Distributed skills protect the entire
// containing plugin, including its manifest and sibling runtime resources.
async function packageRoot() {
  const skillsDirectory = path.dirname(SKILL_ROOT);
  if (path.basename(skillsDirectory) !== 'skills') return SKILL_ROOT;
  const candidate = path.dirname(skillsDirectory);
  for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    try {
      if ((await fs.stat(path.join(candidate, manifest))).isFile()) return fs.realpath(candidate);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return SKILL_ROOT;
}

export const PACKAGE_ROOT = await packageRoot();
