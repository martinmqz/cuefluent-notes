import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPackages } from './package.mjs';
import { initialize } from './setup.mjs';

test('status validates each client manifest without hiding or changing configuration', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-manifest-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { packages } = await buildPackages({ outDir: path.join(root, 'packages'), withHooks: true });
  for (const pkg of packages) {
    const file = path.join(pkg.root, `.${pkg.client}-plugin`, 'plugin.json');
    const original = JSON.parse(await fs.readFile(file));
    const configPath = path.join(root, `private-${pkg.client}`, 'config.json');
    const run = () => {
      const result = spawnSync(process.execPath, [path.join(pkg.skillRoot, 'scripts/setup.mjs'),
        'status', '--client', pkg.client, '--cwd', root, '--config', configPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    };
    assert.equal(run().hookPackaged, true);
    await fs.writeFile(file, JSON.stringify({ ...original, version: `${original.version}+codex.20260922000000` }));
    assert.equal(run().hookPackaged, true, 'valid install cachebusters remain supported');

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
      const status = run();
      assert.equal(status.status, 'unconfigured');
      assert.equal(status.hookPackaged, false, `${pkg.client}: ${label}`);
      assert.match(status.hookIssue, /Repair or reinstall/);
      assert.ok(status.hookIssue.length < 200);
      assert.ok(!status.hookIssue.includes('synthetic-private-detail'));
      await assert.rejects(fs.stat(path.dirname(configPath)), { code: 'ENOENT' });
    }
    await initialize({ client: pkg.client, mode: 'manual', configPath });
    const config = await fs.readFile(configPath);
    const disabled = run();
    assert.equal(disabled.status, 'disabled');
    assert.equal(disabled.hookPackaged, false);
    assert.deepEqual(await fs.readFile(configPath), config);
    await fs.writeFile(file, JSON.stringify(original));
    const repaired = run();
    assert.equal(repaired.hookPackaged, true);
    assert.equal(repaired.hookIssue, undefined);
    assert.equal(repaired.status, 'disabled');
  }
});
