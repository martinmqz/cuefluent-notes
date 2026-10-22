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
