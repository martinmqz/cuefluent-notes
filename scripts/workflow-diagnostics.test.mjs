import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPackages } from './package.mjs';
import { workflowDiagnostics } from './workflow-diagnostics.mjs';

test('read-only package diagnostics validate manifests without inferring host trust', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-manifest-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { packages } = await buildPackages({ outDir: path.join(root, 'packages'), withHooks: true });
  for (const pkg of packages) {
    const file = path.join(pkg.root, `.${pkg.client}-plugin`, 'plugin.json');
    const original = JSON.parse(await fs.readFile(file));
    const configPath = path.join(root, `private-${pkg.client}`, 'config.json');
    const run = () => workflowDiagnostics(pkg.root);
    assert.equal((await run()).hookRegistration, 'packaged');
    await fs.writeFile(file, JSON.stringify({ ...original, version: `${original.version}+codex.20260922000000` }));
    assert.equal((await run()).hookRegistration, 'packaged', 'valid install cachebusters remain supported');

    const corruptions = [
      ['wrong identity', manifest => { manifest.name = 'another-plugin'; }],
      ...['name', 'version', 'description', 'author'].map(field =>
        [`missing ${field}`, manifest => { delete manifest[field]; }]),
      ...[3, '', 'v0.5.0', '0.05.0', '0.5.0-01', '0.5.0+', '0.5.0\n'].map(version =>
        [`invalid version ${version}`, manifest => { manifest.version = version; }]),
      ['invalid description', manifest => { manifest.description = {}; }],
      ['blank description', manifest => { manifest.description = ' '; }],
      ['invalid author', manifest => { manifest.author = []; }],
      ['missing author name', manifest => { manifest.author = {}; }],
      ['invalid author name', manifest => { manifest.author.name = 3; }],
      ['unsupported metadata', manifest => { manifest.hooks = false; }],
    ];
    if (pkg.client === 'codex') corruptions.push(
      ['missing skills', manifest => { delete manifest.skills; }],
      ['wrong skills path', manifest => { manifest.skills = './missing/'; }],
      ['invalid skills path', manifest => { manifest.skills = []; }],
      ['missing interface', manifest => { delete manifest.interface; }],
      ['invalid interface', manifest => { manifest.interface = []; }],
      ...['displayName', 'shortDescription', 'longDescription', 'developerName', 'category'].flatMap(field => [
        [`missing interface ${field}`, manifest => { delete manifest.interface[field]; }],
        [`invalid interface ${field}`, manifest => { manifest.interface[field] = {}; }],
      ]),
      ...['capabilities', 'defaultPrompt'].flatMap(field => [
        [`missing interface ${field}`, manifest => { delete manifest.interface[field]; }],
        [`invalid interface ${field}`, manifest => { manifest.interface[field] = 'wrong'; }],
        [`invalid interface ${field} entry`, manifest => { manifest.interface[field] = [3]; }],
      ]),
    );
    const invalid = [
      ['malformed JSON', '{"synthetic-private-detail":'],
      ['null manifest', 'null'], ['array manifest', '[]'], ['string manifest', '"text"'],
      ['invalid UTF-8', Buffer.from([0xff])],
      ['oversized manifest', Buffer.alloc(2 * 1024 * 1024 + 1, ' ')],
      ...corruptions.map(([label, corrupt]) => {
        const manifest = structuredClone(original);
        corrupt(manifest);
        return [label, JSON.stringify(manifest)];
      }),
    ];
    for (const [label, bytes] of invalid) {
      await fs.writeFile(file, bytes);
      const status = await run();
      assert.equal(status.hookRegistration, 'invalid', `${pkg.client}: ${label}`);
      assert.equal(status.manifest, 'invalid'); assert.equal(status.hostTrust, 'unknown');
      assert.ok(!JSON.stringify(status).includes('synthetic-private-detail'));
      await assert.rejects(fs.stat(path.dirname(configPath)), { code: 'ENOENT' });
    }
    await fs.writeFile(file, JSON.stringify(original));
    const repaired = await run();
    assert.equal(repaired.hookRegistration, 'packaged');
    assert.equal(repaired.manifest, 'valid');
    await fs.writeFile(path.join(pkg.root, 'hooks/hooks.json'), '{}');
    assert.equal((await run()).hookRegistration, 'invalid');
    await fs.unlink(path.join(pkg.root, 'hooks/hooks.json'));
    assert.equal((await run()).hookRegistration, 'absent');
    assert.equal((await run()).hostNodePath, 'unknown');
  }
});
