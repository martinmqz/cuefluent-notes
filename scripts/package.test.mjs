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
    const relative = path.join(prefix, item.name);
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
        const resolved = path.relative(root, path.resolve(path.dirname(file), relative));
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
    await checkDocumentation(pkg.root, files);
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
    const setup = path.join(pkg.skillRoot, 'scripts/setup.mjs');
    const config = path.join(work, 'capture.json');
    const setupArgs = ['--client', pkg.client, '--config', config];
    const initial = run(setup, ['status', ...setupArgs, '--cwd', directory], directory);
    assert.equal(initial.status, 'unconfigured');
    assert.equal(initial.hookPackaged, false);
    assert.equal(run(setup, ['init', ...setupArgs, '--mode', 'manual'], directory).status, 'created');
    const manualStatus = run(setup, ['status', ...setupArgs, '--cwd', directory], directory);
    assert.equal(manualStatus.status, 'disabled');
    const policyProposal = path.join(work, 'proposed-config.json');
    await fs.writeFile(policyProposal, JSON.stringify({ version: 1, enabled: true, clients: [pkg.client],
      automaticUpdates: false, scope: 'Synthetic findings only.',
      routes: [{ projectRoot: directory, destination: path.join(notes, 'note.md'), stateDir: path.join(work, 'state') }] }));
    assert.equal(run(setup, ['update', ...setupArgs, '--cwd', directory, '--proposal', policyProposal,
      '--expected-hash', manualStatus.configHash], directory).status, 'updated');
    assert.equal(run(setup, ['status', ...setupArgs, '--cwd', directory], directory).mode, 'suggest');
    assert.deepEqual(await fs.readdir(notes), []);
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
test('opt-in bundles preserve literal shell characters through host preprocessing', async t => {
  const directory = await fixture(t);
  const result = await buildPackages({ outDir: path.join(directory, 'opt in $HOME packages'), withHooks: true });
  const configPath = path.join(directory, 'private-config.json');
  const destination = path.join(directory, 'knowledge.md');
  await fs.writeFile(configPath, JSON.stringify({ version: 1, enabled: true, clients: ['codex', 'claude'], automaticUpdates: true, scope: 'Synthetic facts only', defaultRoute: { destination, stateDir: path.join(directory, 'state') } }));
  for (const pkg of result.packages) {
    await checkDocumentation(pkg.root, await inventory(pkg.root));
    const config = JSON.parse(await fs.readFile(path.join(pkg.root, 'hooks/hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.hooks), ['SessionStart', 'UserPromptSubmit']);
    assert.equal(config.hooks.SessionStart[0].matcher, 'startup');
    const handler = config.hooks.UserPromptSubmit[0].hooks[0];
    assert.equal(handler.type, 'command');
    assert.deepEqual(config.hooks.SessionStart[0].hooks, [handler]);
    assert.ok(!handler.async);
    const setupStatus = run(path.join(pkg.skillRoot, 'scripts/setup.mjs'), ['status', '--client', pkg.client,
      '--config', configPath, '--cwd', directory], directory);
    assert.equal(setupStatus.hookPackaged, true);
    assert.equal(setupStatus.status, 'configured');
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'package-session', turn_id: 'package-turn', prompt_id: 'package-prompt', cwd: directory };
    const command = pkg.client === 'codex'
      ? handler.command.replaceAll('${PLUGIN_ROOT}', pkg.root).replaceAll('${CLAUDE_PLUGIN_ROOT}', pkg.root)
      : handler.command;
    const invoke = (input, selectedConfig = configPath) => spawnSync(command, { shell: true, input: JSON.stringify(input), encoding: 'utf8', cwd: directory,
      env: { ...process.env, PLUGIN_ROOT: pkg.root, CLAUDE_PLUGIN_ROOT: pkg.root, CUEFLUENT_NOTES_CONFIG: selectedConfig, NODE_PATH: '' } });
    const output = invoke(payload);
    assert.equal(output.status, 0, output.stderr);
    const response = JSON.parse(output.stdout);
    assert.equal(response.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(response.hookSpecificOutput.additionalContext.includes(path.join(pkg.skillRoot, 'SKILL.md')));
    assert.ok(!response.decision);
    const startup = { hook_event_name: 'SessionStart', source: 'startup', session_id: payload.session_id, cwd: directory };
    const configuredStart = invoke(startup);
    assert.equal(configuredStart.status, 0, configuredStart.stderr);
    assert.equal(configuredStart.stdout, '');
    const absentConfig = path.join(directory, `${pkg.client}-absent.json`);
    const firstStart = invoke(startup, absentConfig);
    assert.equal(firstStart.status, 0, firstStart.stderr);
    const notice = JSON.parse(firstStart.stdout);
    assert.deepEqual(Object.keys(notice), ['systemMessage']);
    assert.match(notice.systemMessage, /Set up Cuefluent Notes/);
    const unconfiguredPrompt = invoke(payload, absentConfig);
    assert.equal(unconfiguredPrompt.status, 0, unconfiguredPrompt.stderr);
    assert.equal(unconfiguredPrompt.stdout, '');
    const resume = invoke({ ...startup, source: 'resume' }, absentConfig);
    assert.equal(resume.status, 0, resume.stderr);
    assert.equal(resume.stdout, '');
    await assert.rejects(fs.stat(absentConfig), { code: 'ENOENT' });
    const manual = run(path.join(pkg.skillRoot, 'scripts/check-notes.mjs'), [path.join(pkg.skillRoot, 'examples/feature-behavior.md')], directory);
    assert.equal(manual.errors, 0);
  }
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(directory, 'state')), { code: 'ENOENT' });
});
