import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyBuildArchives, compareBuilds } from '../tools/ci.mjs';
import { packageSource } from './fixtures/package-source.mjs';
import YAML from 'yaml';

test('manual release candidate authorization requires confirmation on the main dispatch ref', async () => {
  const workflow = YAML.parse(await fs.readFile(path.resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.prepare.if, "${{ inputs.confirm && github.ref == 'refs/heads/main' }}");
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

test('candidate comparison verifies every archive and requires identical three-platform receipts', async t => {
  const f = await packageSource(t), artifacts = path.join(f.root, 'artifacts'); await fs.mkdir(artifacts);
  const files = ['build.json', ...f.built.packages.flatMap(item => item.archives.map(archive => archive.path)), ...f.built.tools.map(archive => archive.path)];
  for (const platform of ['ubuntu-24.04', 'macos-14', 'windows-2025']) {
    const root = path.join(artifacts, `v2-candidate-${platform}`); await fs.mkdir(root);
    for (const file of files) await fs.copyFile(path.join(f.output, file), path.join(root, file));
  }
  assert.deepEqual(await compareBuilds(artifacts), { platforms: 3, identical: true });
  const windows = path.join(artifacts, 'v2-candidate-windows-2025'), receipt = path.join(windows, 'build.json'), original = await fs.readFile(receipt);
  await fs.appendFile(receipt, '\n');
  await assert.rejects(compareBuilds(artifacts), { code: 'CI_CANDIDATE_INVALID' });
  await fs.writeFile(receipt, original);
  await fs.appendFile(path.join(windows, f.built.tools[0].path), 'corruption');
  await assert.rejects(compareBuilds(artifacts), { code: 'CI_CANDIDATE_INVALID' });
});

test('candidate receipt cannot substitute another archive type or client', async t => {
  const f = await packageSource(t);
  assert.equal((await verifyBuildArchives(f.output)).build.version, f.built.version);
  const receipt = structuredClone(f.built); receipt.packages[0].archives = [receipt.packages[0].archives[0], receipt.packages[1].archives[1]];
  await fs.writeFile(path.join(f.output, 'build.json'), JSON.stringify(receipt));
  await assert.rejects(verifyBuildArchives(f.output), { code: 'CI_CANDIDATE_INVALID' });
});
