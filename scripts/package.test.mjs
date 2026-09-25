import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPackages } from './package.mjs';
import MarkdownIt from 'markdown-it';

const sourceVersion = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-package-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function run(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
async function inventory(root, prefix = '') {
  const files = [];
  for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), `Nonportable symlink: ${item.name}`);
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) files.push(...await inventory(root, relative));
    else files.push(relative);
  }
  return files;
}
async function checkDocumentation(root, files) {
  const parser = new MarkdownIt();
  const visit = (tokens, file) => {
    for (const token of tokens) {
      const target = token.type === 'link_open' ? token.attrGet('href') : token.type === 'image' ? token.attrGet('src') : null;
      if (target && !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) {
        const relative = decodeURIComponent(target.split(/[?#]/)[0]);
        const resolved = path.relative(root, path.resolve(path.dirname(file), relative)).split(path.sep).join('/');
        assert.ok(files.includes(resolved), `Missing packaged documentation target: ${resolved}`);
      }
      if (token.children) visit(token.children, file);
    }
  };
  for (const file of files.filter(f => f.endsWith('.md') && !f.includes('node_modules/'))) {
    visit(parser.parse(await fs.readFile(path.join(root, file), 'utf8'), {}), path.join(root, file));
  }
}
test('selected-client builds publish only that complete runtime and reject invalid client selections', async t => {
  const directory = await fixture(t);
  for (const client of ['codex', 'claude']) {
    const output = path.join(directory, client);
    const built = await buildPackages({ outDir: output, clients: [client], withHooks: true });
    assert.deepEqual(await fs.readdir(output), [client]);
    assert.equal(built.packages.length, 1);
    const pkg = built.packages[0];
    assert.equal(pkg.client, client);
    await fs.stat(path.join(pkg.root, `.${client}-plugin/plugin.json`));
    await fs.stat(path.join(pkg.root, 'hooks/hooks.json'));
    assert.equal(run(path.join(pkg.skillRoot, 'scripts/check-notes.mjs'), [path.join(pkg.skillRoot, 'examples/decision.md')], directory).errors, 0);
  }
  const invalid = path.join(directory, 'invalid');
  for (const clients of [[], ['codex', 'codex'], ['other'], 'codex', null]) {
    await assert.rejects(buildPackages({ outDir: invalid, clients }), /supported clients/);
    await assert.rejects(fs.stat(invalid), { code: 'ENOENT' });
  }
});
test('manual bundles run checker and guarded writes from isolated directories without app or source imports', async t => {
  const directory = await fixture(t);
  const result = await buildPackages({ outDir: path.join(directory, 'manual packages') });
  assert.equal(result.packages.length, 2);
  for (const pkg of result.packages) {
    const expectedManifest = pkg.client === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json';
    const manifest = JSON.parse(await fs.readFile(path.join(pkg.root, expectedManifest), 'utf8'));
    assert.equal(manifest.name, 'cuefluent-notes');
    assert.equal(manifest.version, sourceVersion);
    await assert.rejects(fs.stat(path.join(pkg.root, 'hooks')), { code: 'ENOENT' });
    const files = await inventory(pkg.root);
    for (const obsolete of ['setup', 'hooks', 'hook-definition', 'capture-policy', 'config-update', 'capture-completion']) assert(!files.includes(`skills/cuefluent-notes/scripts/${obsolete}.mjs`));
    assert(!files.some(file => /AGENTS\.md|references\/completion\.md|examples\/hook-config\.json/.test(file)));
    await checkDocumentation(pkg.root, files);
    const workflow = path.join(pkg.skillRoot, 'scripts/workflow.mjs');
    assert(run(workflow, ['--help'], directory).commands.includes('processing-prepare'));
    const emptyWorkflow = run(workflow, ['status', '--config', path.join(directory, `${pkg.client}-workflow.json`)], directory);
    assert.equal(emptyWorkflow.configHash, null);
    assert.equal(emptyWorkflow.transport.automaticProcessing, false);
    assert.ok(files.some(f => f.endsWith('node_modules/markdown-it/LICENSE')));
    assert.ok(!files.some(f => /(?:^|\/)\.git(?:\/|$)|\.test\.mjs$|(?:^|\/)journal\.json$|(?:^|\/)manifest\.json$/.test(f)));
    const checker = path.join(pkg.skillRoot, 'scripts/check-notes.mjs');
    const examples = path.join(pkg.skillRoot, 'examples');
    const report = run(checker, ['--cases', path.join(examples, 'check-cases.json'),
      ...['feature-behavior', 'decision', 'standup', 'meeting-summary', 'task-summary', 'knowledge-base'].map(name => path.join(examples, `${name}.md`))], directory);
    assert.equal(report.errors, 0);
    assert.equal(report.cases, 14);
    const work = path.join(directory, `private-${pkg.client}`);
    const notes = path.join(work, 'notes');
    await fs.mkdir(notes, { recursive: true });
    const proposal = path.join(work, 'proposal.md');
    await fs.writeFile(proposal, '# Synthetic\n\n## Portable write\n\nVerified from an isolated package.\n');
    const planFile = path.join(work, 'plan.json');
    const plan = { version: 1, mode: 'authored', root: notes, stateDir: path.join(work, 'state'), files: [{ path: 'note.md', expectedHash: null, contentPath: proposal }] };
    await fs.writeFile(planFile, JSON.stringify(plan));
    const writer = path.join(pkg.skillRoot, 'scripts/safe-update.mjs');
    assert.equal(run(writer, ['apply', planFile], directory).status, 'updated');
    const note = path.join(notes, 'note.md');
    plan.files[0].expectedHash = run(writer, ['fingerprint', note], directory).files[0].hash;
    await fs.writeFile(planFile, JSON.stringify(plan));
    assert.equal(run(writer, ['apply', planFile], directory).status, 'unchanged');
    assert.deepEqual(await fs.readFile(note), await fs.readFile(proposal));
    // The entire plugin is public/distributable, including outside its nested skill.
    plan.root = pkg.root;
    plan.files[0].expectedHash = null;
    await fs.writeFile(planFile, JSON.stringify(plan));
    const blocked = spawnSync(process.execPath, [writer, 'apply', planFile], { cwd: directory, encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    await assert.rejects(fs.stat(path.join(pkg.root, 'note.md')), { code: 'ENOENT' });
  }
  await assert.rejects(buildPackages({ outDir: result.outDir }), /exist|fresh|overwrite/i);
});
