import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPlan, fingerprint, recover, inspectState } from './safe-update.mjs';
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-directory-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notesDir = path.join(root, 'notes'); await fs.mkdir(notesDir);
  return { root, notesDir };
}
test('one folder route supports separate subjects and guarded updates without changing other notes', async t => {
  const f = await fixture(t);
  const routed = { notesDir: f.notesDir, stateDir: path.join(f.root, 'writer') };
  const filenames = ['orchid-release-1.0.md', 'cache-expiry-decisions.md'];
  const bodies = ['# Orchid\n\n## Release 1.0\n\nThe fictional release passed validation.\n',
    '# Orchid\n\n## Cache expiry decision\n\nThe prototype uses a 30-minute TTL.\n'];
  const plan = { version: 1, mode: 'authored', root: routed.notesDir, stateDir: routed.stateDir, files: [] };
  for (let i = 0; i < filenames.length; i++) {
    const contentPath = path.join(f.root, `proposal-${i}.md`);
    await fs.writeFile(contentPath, bodies[i]);
    plan.files.push({ path: filenames[i], contentPath, expectedHash: null });
  }
  await applyPlan(plan);
  assert.deepEqual(await fs.readdir(f.notesDir), [...filenames].sort());
  const target = path.join(f.notesDir, filenames[0]);
  const expectedHash = await fingerprint(target);
  await fs.writeFile(plan.files[0].contentPath, bodies[0] + '\nUser-approved correction.\n');
  await applyPlan({ ...plan, files: [{ ...plan.files[0], expectedHash }] });
  assert.equal(await fs.readFile(path.join(f.notesDir, filenames[1]), 'utf8'), bodies[1]);
  assert.match(await fs.readFile(target, 'utf8'), /User-approved correction/);
  await assert.rejects(applyPlan({ ...plan, files: [{ ...plan.files[0], expectedHash }] }), /changed|match|conflict/);
});


for (const mode of ['derived', 'authored']) test(`pending ${mode} journals preserve writer ownership until recovery`, async t => {
  const f = await fixture(t), stateDir = path.join(f.root, 'writer');
  const source = path.join(f.root, 'source.md'), contentPath = path.join(f.root, 'proposal.md');
  await fs.writeFile(source, '# Evidence\n\n## Finding\n\nSynthetic source.\n');
  await fs.writeFile(contentPath, '# Summary\n\n## Finding\n\nSynthetic finding.\n');
  const plan = { version: 1, mode, root: f.notesDir, stateDir, ...(mode === 'derived' ? { expectedManifestHash: null } : {}),
    files: [{ path: 'summary.md', expectedHash: null, contentPath, sources: [{ path: source, expectedHash: await fingerprint(source) }], entries: [{ heading: 'Finding', sourcePaths: [source] }] }] };
  await assert.rejects(applyPlan(plan, { afterStage() { throw new Error('interrupted'); } }), /interrupted/);
  const before = await fingerprint(path.join(stateDir, 'journal.json'));
  assert.equal((await inspectState(stateDir)).recoveryPending, true);
  await assert.rejects(applyPlan(plan), /recover|pending|journal/i);
  assert.equal(await fingerprint(path.join(stateDir, 'journal.json')), before);
  await recover(stateDir);
  assert.equal((await inspectState(stateDir)).recoveryPending, false);
  if (mode === 'derived') await assert.rejects(applyPlan({ ...plan, mode: 'authored', files: [{ ...plan.files[0], expectedHash: await fingerprint(path.join(f.notesDir, 'summary.md')) }] }), /derived|manifest|authored/i);
});

test('writer status refuses malformed and linked journals without changing them', async t => {
  const f = await fixture(t), state = path.join(f.root, 'state'); await fs.mkdir(state);
  const journal = path.join(state, 'journal.json');
  for (const bytes of [Buffer.from('{broken'), Buffer.from([0xff]), Buffer.alloc(2 * 1024 * 1024 + 1, 32)]) {
    await fs.writeFile(journal, bytes); await assert.rejects(inspectState(state)); assert.deepEqual(await fs.readFile(journal), bytes);
  }
  await fs.unlink(journal); const target = path.join(f.root, 'other.json'); await fs.writeFile(target, '{}');
  await fs.symlink(target, journal); await assert.rejects(inspectState(state)); await fs.unlink(target);
  await assert.rejects(inspectState(state)); assert.equal(await fs.readlink(journal), target);
});
