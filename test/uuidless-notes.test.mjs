import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { macosNative } from '../src/storage/macos-native.mjs';
import { readPathStat } from '../src/storage/stat.mjs';
import { fileIdentity, sameIdentity } from '../src/storage/paths.mjs';
import { createProject } from '../src/core/settings.mjs';
import { initializeStore, openStore } from '../src/storage/store.mjs';
import { createDirectNoteTools } from '../src/control/direct-notes.mjs';

// Simulate an explicit missing UUID capability on real files. Native identity,
// ordinary file IO and the private store remain real. This is not a mounted
// SMB/NFS/FUSE integration test.
test('UUID-less public notes retain review/save/update and exact identity checks', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-uuidless-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = path.join(root, 'notes'), cwd = path.join(root, 'project');
  await fs.mkdir(notes); await fs.mkdir(cwd);
  const api = macosNative(), fds = new Set();
  let absent = true, pathChecks = 0, fdChecks = 0;
  const inside = file => typeof file === 'string' && (file === notes || file.startsWith(notes + path.sep));
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (inside(args[0])) {
      fds.add(handle.fd);
      const close = handle.close.bind(handle), fd = handle.fd;
      handle.close = async () => { try { return await close(); } finally { fds.delete(fd); } };
    }
    return handle;
  });
  for (const method of ['getattrlist', 'fgetattrlist']) {
    const original = api[method];
    t.mock.method(api, method, (target, attributes, output, ...args) => {
      const result = original(target, attributes, output, ...args);
      const selected = method === 'getattrlist' ? inside(target) : fds.has(target);
      if (absent && selected && result === 0 && (attributes.readUInt32LE(8) & 0x40000)) {
        assert.equal(output.readUInt32LE(0), 44, 'capability request must include returned attributes');
        output.writeUInt32LE(output.readUInt32LE(8) & ~0x40000, 8);
        output.fill(0, 28, 44);
        if (method === 'getattrlist') pathChecks++; else fdChecks++;
      }
      return result;
    });
  }
  const project = createProject({ id: 'synthetic', root: cwd, destination: { kind: 'directory', path: notes }, activityLog: { enabled: false } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const tools = createDirectNoteTools({ store, client: 'codex', skillVersion: '0.22.0' });
  const content = '# Synthetic share note\n\n## Result\nReviewed content.\n';
  const draft = await tools.call('cuefluent_create_note', { projectId: project.id, requestId: randomUUID(), target: 'note.md', content, summary: 'Synthetic UUID-less destination.' });
  assert.equal(draft.state, 'review');
  const reopened = createDirectNoteTools({ store: await openStore(store.root), client: 'codex', skillVersion: '0.22.0' });
  const ref = { projectId: project.id, runId: draft.runId };
  const review = await reopened.call('cuefluent_review_note', ref);
  assert.equal(review.drafts[0].content, content);
  assert.equal((await reopened.call('cuefluent_save_note', { ...ref, revision: review.revision })).state, 'saved');
  const note = path.join(notes, 'note.md'), inspected = await reopened.call('cuefluent_read_note', { projectId: project.id, target: 'note.md' });
  const updated = await reopened.call('cuefluent_update_note', { projectId: project.id, requestId: randomUUID(), target: 'note.md', expectedHash: inspected.hash,
    content: content.replace('Reviewed content.', 'Reviewed update.'), summary: 'Synthetic update.' });
  assert.equal(updated.state, 'review');
  assert.equal((await reopened.call('cuefluent_save_note', { projectId: project.id, runId: updated.runId, revision: updated.revision })).state, 'saved');
  assert.match(await fs.readFile(note, 'utf8'), /Reviewed update\./);
  assert.ok(pathChecks > 0 && fdChecks > 0, 'both path and handle observations must use the no-UUID capability');
  const raw = await readPathStat(note), identity = JSON.parse(JSON.stringify(fileIdentity(raw)));
  assert.match(identity.device, /^\d+$/);
  assert.equal(sameIdentity({ ...raw, dev: raw.dev + 1n }, identity), false);
  const before = await fs.readFile(note);
  await fs.rename(note, path.join(notes, 'original.md'));
  await fs.writeFile(note, before);
  assert.equal(sameIdentity(await readPathStat(note), identity), false);
  absent = false;
  const uuidBound = JSON.parse(JSON.stringify(fileIdentity(await readPathStat(note))));
  assert.match(uuidBound.device, /^volume:/);
  absent = true;
  assert.equal(sameIdentity(await readPathStat(note), uuidBound), false, 'a retained UUID must not silently downgrade');
});
