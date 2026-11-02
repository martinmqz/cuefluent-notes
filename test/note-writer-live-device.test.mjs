import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('publication pins nested parent devices through the save while durable retries survive renumbering', { skip: process.platform !== 'darwin', timeout: 15_000 }, () => {
  const statUrl = new URL('../src/storage/stat.mjs', import.meta.url).href;
  const pathsUrl = new URL('../src/storage/paths.mjs', import.meta.url).href;
  const writerUrl = new URL('../src/storage/note-writer.mjs', import.meta.url).href;
  const storageUrl = new URL('../src/storage/', import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import os from 'node:os';
    import { registerHooks } from 'node:module';
    import { randomUUID, createHash } from 'node:crypto';
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-nested-device-')));
    try {
      const notes = path.join(root, 'notes'), nested = path.join(notes, 'nested');
      await fs.mkdir(nested, { recursive: true });
      // Model a consistent new native device beneath the configured notes root.
      // The real native helpers still verify actual paths before the observation
      // is projected; UUIDs and inodes remain unchanged, as on a same-volume mount.
      const source = [
        'import * as real from ' + JSON.stringify(${JSON.stringify(statUrl)}) + ';',
        'export * from ' + JSON.stringify(${JSON.stringify(statUrl)}) + ';',
        'export let generation = 0n;',
        'export function advance() { generation++; }',
        'export async function readPathStat(file) {',
        '  const stat = await real.readPathStat(file);',
        '  return file === ' + JSON.stringify(nested) + ' || file.startsWith(' + JSON.stringify(nested + path.sep) + ') ? Object.freeze({...stat, dev:stat.dev+generation}) : stat;',
        '}',
        'export async function readHandleStat(handle) {',
        '  const stat = await real.readHandleStat(handle);',
        '  return Object.freeze({...stat, dev:stat.dev+generation});',
        '}',
      ].join('\n');
      const adapterUrl = 'data:text/javascript,' + encodeURIComponent(source);
      const hook = registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === './stat.mjs' && context.parentURL?.startsWith(${JSON.stringify(storageUrl)})) return { url: adapterUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      } });
      const { pinDirectory } = await import(${JSON.stringify(pathsUrl)});
      const { prepareNotePublication, publishNotePublication } = await import(${JSON.stringify(writerUrl)});
      const adapter = await import(adapterUrl);
      hook.deregister();
      const pin = await pinDirectory(notes), body = Buffer.from('# Synthetic note\n\nNested mount pin.\n');
      const hash = createHash('sha256').update(body).digest('hex');
      const prepared = await prepareNotePublication(pin, 'nested/note.md', body,
        { runId: randomUUID(), draftId: randomUUID(), expectedHash: null, hash });
      const durable = JSON.parse(JSON.stringify(prepared)), retained = JSON.stringify(durable);
      let saved;
      // A different device before entering a new operation is allowed; capture
      // that current device and reject another change during this publication.
      adapter.advance();
      await assert.rejects(publishNotePublication(pin, durable, body, {
        persistIntent: async intent => { saved = JSON.parse(JSON.stringify(intent)); },
        beforePublish: async () => adapter.advance(),
      }), { code: 'PATH_CHANGED' });
      assert.equal(JSON.stringify(durable), retained, 'the retained intent and expectations stay unchanged');
      await assert.rejects(fs.lstat(path.join(nested, 'note.md')), { code: 'ENOENT' });
      assert.ok(saved?.stage, 'the failure happened after staging and before publication');
      const stages = await fs.readdir(nested);
      assert.equal(stages.length, 1);
      assert.ok(stages[0].endsWith('.tmp'));
      assert.deepEqual(await fs.readFile(path.join(nested, stages[0])), body);
      // A later operation can safely resume the same durable stage using its
      // unchanged volume/inode, after pinning the new native parent device.
      const receipt = await publishNotePublication(pin, saved, body);
      assert.equal(receipt.changed, true);
      assert.deepEqual(await fs.readFile(path.join(nested, 'note.md')), body);
      assert.deepEqual(await fs.readdir(nested), ['note.md']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 12_000, stdio: 'pipe' }));
});
