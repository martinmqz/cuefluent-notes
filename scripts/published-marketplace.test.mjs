import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { smokeEnvironment } from './smoke-environment.mjs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { trackedMarketplaceFiles, verifyMarketplaceFiles } from './marketplace-content.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('tracked main catalogs resolve to complete packages matching published release digests', async () => {
  // Source versions may target the next release. Check tracked package files,
  // including edits, but exclude untracked Finder/Explorer housekeeping files.
  verifyMarketplaceFiles(await trackedMarketplaceFiles(root));
});

test('tracked verification ignores OS housekeeping files but reads tracked edits', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-tracked-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const env = { ...smokeEnvironment(fixture), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: fixture, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const folder = path.join(fixture, 'plugins/cuefluent-notes');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, 'tracked.txt');
  await fs.writeFile(file, 'Original.');
  git('init', '--initial-branch=main'); git('add', '.');
  for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) await fs.writeFile(path.join(folder, name), 'Ignored housekeeping.');
  await fs.writeFile(file, 'Tracked edit.');
  const files = await trackedMarketplaceFiles(fixture);
  assert.deepEqual(files.map(entry => entry.name), ['plugins/cuefluent-notes/tracked.txt']);
  assert.equal(files[0].bytes.toString(), 'Tracked edit.');
});
