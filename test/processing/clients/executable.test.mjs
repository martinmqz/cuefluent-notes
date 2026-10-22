import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executablePath } from '../../../src/processing/clients/protocol.mjs';

test('Windows prefers a native exe and resolves recognized npm native packages without executing shell wrappers', { skip: process.platform !== 'win32' ? 'Native Windows executable resolution.' : false }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-executable-'))), prior = process.env.PATH;
  t.after(async () => { process.env.PATH = prior; await fs.rm(root, { recursive: true, force: true }); }); process.env.PATH = root;
  await fs.writeFile(path.join(root, 'claude'), 'This shell wrapper must never execute.');
  const native = path.join(root, 'claude.exe'); await fs.writeFile(native, 'Synthetic native fixture.');
  assert.equal(await executablePath('claude'), native); await fs.unlink(native);
  await assert.rejects(executablePath('claude'), { code: 'PROCESSING_CLIENT_MISSING' });
  const packageRoot = path.join(root, 'node_modules/@anthropic-ai/claude-code'); await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.307' }));
  const packaged = path.join(packageRoot, 'bin/claude.exe'); await fs.writeFile(packaged, 'Synthetic native fixture.');
  assert.equal(await executablePath('claude'), packaged);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'unrecognized', version: '2.1.307' }));
  await assert.rejects(executablePath('claude'), { code: 'PROCESSING_CLIENT_MISSING' });
});


test('POSIX ignores empty, dot and relative PATH components and rejects relative commands', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-executable-path-'))), prior = process.env.PATH, cwd = process.cwd();
  t.after(async () => { process.chdir(cwd); if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'bin')); await fs.mkdir(path.join(root, 'trusted'));
  for (const name of ['codex', 'bin/codex', 'trusted/codex']) await fs.writeFile(path.join(root, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  process.chdir(root); process.env.PATH = ':.:bin';
  await assert.rejects(executablePath('codex'), { code: 'PROCESSING_CLIENT_MISSING' });
  process.env.PATH += `:${path.join(root, 'trusted')}`;
  assert.equal(await executablePath('codex'), path.join(root, 'trusted', 'codex'));
  await assert.rejects(executablePath('./codex'), { code: 'PROCESSING_CLIENT_MISSING' });
});
