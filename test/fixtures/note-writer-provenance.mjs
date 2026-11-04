import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as child from 'node:child_process';
import { promisify } from 'node:util';
import { mock } from 'node:test';
import { readMacosAttribute, readMacosAcl } from '../support/macos-note-metadata.mjs';

const root = await fs.realpath(process.argv[2]);
const scenario = process.argv[3];
assert.ok(['save', 'capture', 'recover', 'absent', 'stage-xattr', 'stage-quarantine', 'mode', 'xattr', 'quarantine', 'acl'].includes(scenario));
const execute = promisify(child.execFile);
const target = path.join(root, 'note.md');
const before = Buffer.from('# Synthetic original\n\nKeep this content unless publication succeeds.\n');
const after = Buffer.from('# Synthetic update\n\nPublish these exact reviewed bytes.\n');
const attribute = 'com.cuefluent.synthetic';
const quarantine = 'com.apple.quarantine';
const provenance = 'com.apple.provenance';

try {
  await fs.writeFile(target, before);
  await fs.chmod(target, 0o640);
  await execute('/usr/bin/xattr', ['-wx', attribute, '00ff102030', target]);
  await execute('/bin/chmod', ['+a', `user:${os.userInfo().username} allow read`, target]);
  const originalInode = (await fs.stat(target, { bigint: true })).ino;
  const observed = new Set();
  const execFile = (...args) => child.execFile(...args);
  // The OS controls provenance, so vary only its native observation. The copy,
  // content, metadata, rename, hard-link and cleanup operations all remain real.
  execFile[promisify.custom] = async (command, args, options) => {
    if (command === '/usr/bin/xattr') {
      if (args.length === 1) {
        const result = await execute(command, args, options);
        const names = result.stdout.toString('utf8').split('\n').filter(name => name && name !== provenance);
        const inode = (await fs.stat(args[0], { bigint: true })).ino;
        if (scenario !== 'absent' || inode !== originalInode) names.push(provenance);
        observed.add(inode === originalInode ? 'original' : 'stage');
        return { stdout: Buffer.from(names.join('\n') + '\n'), stderr: Buffer.alloc(0) };
      }
      const readArgs = args.filter(arg => arg !== '--');
      if (readArgs[0] === '-px' && readArgs[1] === provenance) {
        const original = (await fs.stat(readArgs[2], { bigint: true })).ino === originalInode;
        assert.ok(scenario !== 'absent' || !original, 'An absent provenance attribute must not be read.');
        const value = original ? '0102001111111111111111' : '0102002222222222222222';
        return { stdout: Buffer.from(value + '\n'), stderr: Buffer.alloc(0) };
      }
    }
    return execute(command, args, options);
  };
  mock.module('node:child_process', { exports: { ...child, execFile } });
  const { pinDirectory } = await import('../../src/storage/paths.mjs');
  const { hashBytes } = await import('../../src/storage/files.mjs');
  const { prepareNotePublication, publishNotePublication, inspectPublicationOutcome } = await import('../../src/storage/note-writer.mjs');
  const pin = await pinDirectory(root);
  const intent = await prepareNotePublication(pin, 'note.md', after, {
    runId: randomUUID(), draftId: randomUUID(), expectedHash: hashBytes(before), hash: hashBytes(after),
  });
  let journal = intent;
  const persistIntent = value => { journal = value; };
  const initial = { attribute: await readMacosAttribute(target, attribute), acl: await readMacosAcl(target) };

  if (['save', 'capture', 'recover', 'absent'].includes(scenario)) {
    if (['capture', 'recover'].includes(scenario)) {
      const operation = scenario === 'capture' ? 'rename' : 'link', native = fs[operation];
      let interrupted = false;
      const boundary = new Error(`Synthetic interruption after ${operation}.`);
      const patch = mock.method(fs, operation, async (from, to) => {
        await native(from, to);
        if (scenario === 'capture' ? from === target : to === target) { interrupted = true; throw boundary; }
      });
      await assert.rejects(publishNotePublication(pin, intent, after, { persistIntent }), error => error === boundary);
      patch.mock.restore();
      assert.equal(interrupted, true);
      if (scenario === 'capture') await assert.rejects(fs.access(target), { code: 'ENOENT' });
      else assert.deepEqual(await fs.readFile(target), after);
      assert.ok((await fs.readdir(root)).length > 1, 'Interrupted publication retains cleanup work.');
      assert.deepEqual(await inspectPublicationOutcome(pin, journal), { status: scenario === 'capture' ? 'unapplied' : 'applied' });
    }
    const receipt = await publishNotePublication(pin, journal, after, { persistIntent });
    assert.equal(receipt.changed, true);
    assert.deepEqual(await fs.readFile(target), after);
    assert.equal((await fs.stat(target)).mode & 0o7777, 0o640);
    assert.equal(await readMacosAttribute(target, attribute), initial.attribute);
    assert.equal(await readMacosAcl(target), initial.acl);
    assert.deepEqual(await fs.readdir(root), ['note.md']);
    assert.deepEqual(observed, new Set(['original', 'stage']));
  } else {
    let mutation;
    const beforePublish = async () => {
      if (mutation) return;
      if (scenario.startsWith('stage-')) {
        const stages = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.tmp'));
        assert.equal(stages.length, 1);
        const stage = path.join(root, stages[0].name);
        const name = scenario === 'stage-xattr' ? attribute : quarantine;
        await execute('/usr/bin/xattr', ['-wx', name, '11223344', stage]);
        mutation = { stage, name, value: await readMacosAttribute(stage, name) };
        assert.equal(mutation.value, '11223344');
        return;
      }
      if (scenario === 'mode') await fs.chmod(target, 0o600);
      else if (scenario === 'xattr') await execute('/usr/bin/xattr', ['-wx', attribute, '11223344', target]);
      else if (scenario === 'quarantine') await execute('/usr/bin/xattr', ['-w', quarantine, '0083;69000001;ConcurrentEdit;', target]);
      else if (scenario === 'acl') await execute('/bin/chmod', ['+a', `user:${os.userInfo().username} allow write`, target]);
      mutation = { bytes: await fs.readFile(target), mode: (await fs.stat(target)).mode & 0o7777,
        attribute: await readMacosAttribute(target, attribute), quarantine: await readMacosAttribute(target, quarantine), acl: await readMacosAcl(target) };
    };
    await assert.rejects(publishNotePublication(pin, intent, after, { persistIntent, beforePublish }), error => {
      assert.equal(error.code, 'NOTE_PUBLICATION_CONFLICT');
      if (scenario.startsWith('stage-')) assert.match(error.message, /Staging did not preserve/);
      return true;
    });
    assert.ok(mutation, 'The concurrent mutation must happen before the refusal.');
    if (scenario.startsWith('stage-')) {
      assert.equal(await readMacosAttribute(mutation.stage, mutation.name), mutation.value);
      assert.deepEqual(await fs.readFile(target), before);
      assert.equal((await fs.stat(target, { bigint: true })).ino, originalInode);
      assert.equal(await readMacosAttribute(target, attribute), initial.attribute);
      assert.equal(await readMacosAttribute(target, quarantine), null);
      assert.equal(await readMacosAcl(target), initial.acl);
    } else {
      assert.deepEqual(await fs.readFile(target), mutation.bytes);
      assert.equal((await fs.stat(target, { bigint: true })).ino, originalInode);
      assert.equal((await fs.stat(target)).mode & 0o7777, mutation.mode);
      assert.equal(await readMacosAttribute(target, attribute), mutation.attribute);
      assert.equal(await readMacosAttribute(target, quarantine), mutation.quarantine);
      assert.equal(await readMacosAcl(target), mutation.acl);
      assert.deepEqual(await fs.readFile(target), before);
    }
  }
  process.stdout.write(JSON.stringify({ verified: true, scenario }) + '\n');
} finally {
  mock.restoreAll();
}
