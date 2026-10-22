import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProject, chooseProject } from '../src/core/settings.mjs';
import { initializeStore } from '../src/storage/store.mjs';

test('macOS setup refuses a miscased root before writes and preserves case-sensitive matching', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-project-case-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const canonical = path.join(root, 'ProjectCase'), other = path.join(root, 'projectcase'); await fs.mkdir(canonical);
  const project = createProject({ id: 'project', root: other, destination: { kind: 'directory', path: path.join(root, 'notes') } });
  const settings = { schemaVersion: 1, projects: [project] };
  let insensitive = true; try { await fs.stat(other); } catch (error) { if (error.code === 'ENOENT') insensitive = false; else throw error; }
  if (insensitive) {
    await assert.rejects(initializeStore(path.join(root, 'private'), settings), { code: 'PROJECT_ROOT_NONCANONICAL' });
    assert.deepEqual(await fs.readdir(root), ['ProjectCase']);
  } else {
    await fs.mkdir(other);
    await initializeStore(path.join(root, 'private'), settings);
  }
  const exact = { schemaVersion: 1, projects: [{ ...project, root: canonical }] };
  await initializeStore(path.join(root, 'exact-private'), exact);
  assert.equal(chooseProject(exact, canonical).id, 'project');
  assert.equal(chooseProject(exact, other), null);
});
