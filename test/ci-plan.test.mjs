import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyCIChanges, main } from '../tools/ci-plan.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-ci-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo'); await fs.mkdir(repoRoot);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (args, options = {}) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: repoRoot, env, input: options.input, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const text = args => git(args).toString('utf8').trim();
  git(['init', '--initial-branch=main', '--template=']);
  git(['config', 'user.name', 'Synthetic Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']); git(['config', 'core.filemode', 'true']);
  async function write(files) {
    for (const [file, contents] of Object.entries(files)) {
      const destination = path.join(repoRoot, file);
      if (contents === null) await fs.rm(destination, { force: true });
      else { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, contents); }
    }
  }
  async function commit(files = {}) {
    await write(files); git(['add', '--all']); git(['commit', '-m', 'Synthetic change']); return text(['rev-parse', 'HEAD']);
  }
  const initial = await commit({ 'src/runtime.mjs': 'export const value = 1;\n', 'README.md': 'Read me.\n',
    '.agents/publishing.md': 'Publish with verified receipts.\n', 'plugins/0.16.0/fixture.txt': 'retained bytes\n' });
  return { root, repoRoot, git, text, write, commit, initial };
}

const classify = (f, baselineRevision = f.initial, revision = 'HEAD') => classifyCIChanges({ repoRoot: f.repoRoot, baselineRevision, revision });
const planError = reason => error => error.code === 'CI_PLAN_INVALID' && error.reason === reason;

async function mergeFixture(t, changedFiles = { '.agents/publishing.md': 'Updated release instructions.\n' }) {
  const f = await fixture(t);
  f.git(['switch', '-c', 'feature']); const head = await f.commit(changedFiles);
  f.git(['switch', 'main']); const base = await f.commit({ 'src/runtime.mjs': 'export const value = 2;\n' });
  f.git(['merge', '--no-ff', 'feature', '-m', 'Synthetic merge']);
  const merge = f.text(['rev-parse', 'HEAD']), event = {
    number: 43, pull_request: { number: 43, base: { ref: 'main', sha: base }, head: { sha: head } },
  };
  const eventFile = path.join(f.root, 'event.json'); await fs.writeFile(eventFile, JSON.stringify(event));
  const env = { GITHUB_SHA: merge, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/43/merge', GITHUB_EVENT_PATH: eventFile,
    GITHUB_OUTPUT: path.join(f.root, 'output'), GITHUB_STEP_SUMMARY: path.join(f.root, 'summary') };
  return { ...f, base, head, merge, event, eventFile, env };
}

test('only the explicit distribution and development guidance paths receive focused checks', async t => {
  const f = await fixture(t);
  const files = [
    'plugins/0.17.0/cuefluent-notes/src/cli.mjs', 'claude/0.17.0/cuefluent-notes/src/cli.mjs',
    'packaging/releases/0.17.0/build.json', 'release.json', '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json', 'test/marketplace.test.mjs', 'test/support/marketplace.mjs',
    '.agents/rules/distribution.md', '.agents/config.yaml', 'AGENTS.md', '.cursor/rules/distribution.mdc',
    '.github/instructions/distribution.instructions.md', '.github/copilot-instructions.md',
  ];
  await f.commit(Object.fromEntries(files.map(file => [file, 'synthetic distribution bytes\n'])));
  assert.deepEqual(await classify(f), { mode: 'distribution', changedFiles: [...files].sort(), reason: 'DISTRIBUTION_ONLY' });
});

test('source, tooling, tests, versions, installed prose and checkout settings always run full checks', async t => {
  const files = [
    'src/runtime.mjs', 'tools/ci-plan.mjs', 'test/ci-plan.test.mjs', 'test/support/other.mjs',
    'package.json', 'package-lock.json', '.node-version', 'SKILL.md', 'README.md', 'LICENSE.md',
    'references/distribution.md', 'templates/note.md', 'hooks/hooks.json', 'packaging/v2/source-files.json',
    '.github/workflows/ci.yml', '.gitattributes', '.gitignore', 'plugins-extra/file',
  ];
  const f = await fixture(t); let before = f.initial;
  for (const file of files) await t.test(file, async () => {
    const after = await f.commit({ [file]: 'changed full-check input\n' });
    assert.deepEqual(await classify(f, before, after), { mode: 'full', changedFiles: [file], reason: 'FULL_CHECK_INPUT_CHANGED' });
    before = after;
  });
});

test('a mixed change is full and neither dirty nor untracked worktree files influence classification', async t => {
  const f = await fixture(t);
  const distribution = await f.commit({ '.agents/publishing.md': 'distribution change\n' });
  await f.write({ 'src/runtime.mjs': 'dirty runtime\n', 'tools/untracked.mjs': 'untracked runtime\n' });
  assert.equal((await classify(f)).mode, 'distribution');
  f.git(['add', 'src/runtime.mjs']); assert.equal((await classify(f)).mode, 'distribution');
  await f.commit();
  assert.equal((await classify(f)).mode, 'full');
  assert.equal((await classify(f, distribution)).mode, 'full');
});

test('empty diffs and commits that only change metadata remain full', async t => {
  const f = await fixture(t);
  assert.deepEqual(await classify(f), { mode: 'full', changedFiles: [], reason: 'EMPTY_DIFF' });
  f.git(['commit', '--allow-empty', '-m', 'Synthetic empty commit']);
  assert.equal((await classify(f)).mode, 'full');
});

test('renames check both paths and distribution deletions still go through marketplace validation', async t => {
  const f = await fixture(t);
  f.git(['mv', '.agents/publishing.md', '.agents/renamed.md']); const renamed = await f.commit();
  assert.deepEqual(await classify(f), { mode: 'distribution', changedFiles: ['.agents/publishing.md', '.agents/renamed.md'], reason: 'DISTRIBUTION_ONLY' });
  const deleted = await f.commit({ 'plugins/0.16.0/fixture.txt': null });
  assert.deepEqual(await classify(f, renamed), { mode: 'distribution', changedFiles: ['plugins/0.16.0/fixture.txt'], reason: 'DISTRIBUTION_ONLY' });
  f.git(['mv', 'src/runtime.mjs', '.agents/moved.mjs']); await f.commit();
  assert.deepEqual((await classify(f, deleted)).changedFiles, ['.agents/moved.mjs', 'src/runtime.mjs']);
  assert.equal((await classify(f, deleted)).mode, 'full');
});

test('regular mode changes are tracked but links and submodules never select focused checks', async t => {
  const f = await fixture(t);
  f.git(['update-index', '--chmod=+x', '.agents/publishing.md']); f.git(['commit', '-m', 'Synthetic mode']);
  assert.equal((await classify(f)).mode, 'distribution');
  const beforeLink = f.text(['rev-parse', 'HEAD']);
  const blob = f.git(['hash-object', '-w', '--stdin'], { input: Buffer.from('../outside') }).toString('utf8').trim();
  f.git(['update-index', '--add', '--cacheinfo', '120000,' + blob + ',.agents/link']); f.git(['commit', '-m', 'Synthetic link']);
  assert.equal((await classify(f, beforeLink)).reason, 'UNSUPPORTED_FILE_ENTRY');
  const beforeModule = f.text(['rev-parse', 'HEAD']);
  f.git(['update-index', '--add', '--cacheinfo', '160000,' + f.initial + ',plugins/submodule']); f.git(['commit', '-m', 'Synthetic module']);
  assert.equal((await classify(f, beforeModule)).reason, 'UNSUPPORTED_FILE_ENTRY');
});

test('NUL parsing supports spaces and Unicode and refuses nonportable path records', async t => {
  const f = await fixture(t);
  await f.commit({ '.agents/space ü.md': 'synthetic guidance\n' });
  assert.deepEqual((await classify(f)).changedFiles, ['.agents/space ü.md']);
  const before = f.text(['rev-parse', 'HEAD']), blob = f.text(['rev-parse', 'HEAD:.agents/space ü.md']);
  // Build Git objects directly: Windows rejects this name in an index, but a
  // commit authored on another OS can still contain it.
  const tree = entry => f.git(['mktree', '-z'], { input: Buffer.from(entry) }).toString('utf8').trim();
  const nested = tree('100644 blob ' + blob + '\tline\nbreak.md\0');
  const root = tree('040000 tree ' + nested + '\t.agents\0');
  const unusual = f.text(['commit-tree', root, '-p', before, '-m', 'Synthetic unusual path']);
  assert.equal((await classify(f, before, unusual)).reason, 'UNSUPPORTED_FILE_ENTRY');
});

test('Git callback can be asynchronous and malformed or oversized responses fail closed', async t => {
  const f = await fixture(t); await f.commit({ '.agents/publishing.md': 'updated\n' });
  assert.equal((await classifyCIChanges({ repoRoot: f.repoRoot, baselineRevision: f.initial, git: async args => f.git(args) })).mode, 'distribution');
  for (const raw of ['not a raw diff\0file\0', ':100644 100644 ' + 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' M\0.agents/file', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    await assert.rejects(classifyCIChanges({ baselineRevision: 'base', git: async args => args[0] === 'diff' ? raw : 'a'.repeat(40) + '\n' }),
      error => error.code === 'CI_PLAN_INVALID');
  }
  await assert.rejects(classifyCIChanges({ repoRoot: f.repoRoot }), planError('REVISION_INVALID'));
});

test('plan binds the exact merge checkout, first parent base and second parent PR head', async t => {
  const f = await mergeFixture(t);
  assert.deepEqual(await main(['plan'], { repoRoot: f.repoRoot, env: f.env }), {
    mode: 'distribution', changedFiles: ['.agents/publishing.md'], reason: 'DISTRIBUTION_ONLY',
  });
  assert.equal(await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8'), 'mode=distribution\n');
  assert.match(await fs.readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /distribution.*1 changed files/);
  // The base advanced after the feature branch fork; its runtime edit is not
  // part of this PR's effect, despite appearing in a branch-to-base diff.
  assert.equal((await classify(f, f.initial, f.merge)).mode, 'full');
  // fetch-depth: 2 retains the merge's immediate parents as shallow boundaries.
  await fs.writeFile(path.join(f.repoRoot, '.git', 'shallow'), f.base + '\n' + f.head + '\n');
  assert.equal((await main(['plan'], { repoRoot: f.repoRoot, env: f.env })).mode, 'distribution');
  await assert.rejects(main(['plan'], { repoRoot: f.repoRoot, env: { ...f.env, GITHUB_SHA: f.head } }), planError('CHECKOUT_MISMATCH'));
  await assert.rejects(main(['plan'], { repoRoot: f.repoRoot, env: { ...f.env, GITHUB_REF: 'refs/heads/feature' } }), planError('PR_CONTEXT_INVALID'));
});

test('plan and verify use the tested merge parent when the event base SHA is stale', async t => {
  const f = await mergeFixture(t);
  const event = { ...f.event, pull_request: { ...f.event.pull_request, base: { ...f.event.pull_request.base, sha: f.initial } } };
  await fs.writeFile(f.eventFile, JSON.stringify(event));
  // The merge includes a newer runtime change from main. Only this PR's
  // guidance change belongs in its diff, even with a stale event snapshot.
  assert.notEqual(f.base, event.pull_request.base.sha);
  await fs.writeFile(path.join(f.repoRoot, '.git', 'shallow'), f.base + '\n' + f.head + '\n');
  for (const command of ['plan', 'verify']) {
    assert.deepEqual(await main([command], { repoRoot: f.repoRoot, env: { ...f.env, CUEFLUENT_CI_MODE: 'distribution' } }), {
      mode: 'distribution', changedFiles: ['.agents/publishing.md'], reason: 'DISTRIBUTION_ONLY',
    });
  }
});

test('PRs targeting another branch run full checks even for distribution-only changes', async t => {
  const f = await mergeFixture(t);
  f.event.pull_request.base.ref = 'release/next';
  await fs.writeFile(f.eventFile, JSON.stringify(f.event));
  for (const command of ['plan', 'verify']) {
    assert.deepEqual(await main([command], { repoRoot: f.repoRoot, env: { ...f.env, CUEFLUENT_CI_MODE: 'full' } }), {
      mode: 'full', changedFiles: ['.agents/publishing.md'], reason: 'NON_MAIN_TARGET',
    });
  }
  await assert.rejects(main(['verify'], { repoRoot: f.repoRoot, env: { ...f.env, CUEFLUENT_CI_MODE: 'distribution' } }), planError('PLAN_MODE_MISMATCH'));
});

test('missing PR identity, mismatched parents and nonmerge checkouts cannot claim distribution', async t => {
  const f = await mergeFixture(t);
  for (const event of [
    { ...f.event, number: null },
    { ...f.event, pull_request: { ...f.event.pull_request, number: 44 } },
    { ...f.event, pull_request: { ...f.event.pull_request, base: { sha: 'invalid' } } },
    { ...f.event, pull_request: { ...f.event.pull_request, base: { sha: f.base } } },
    { ...f.event, pull_request: { ...f.event.pull_request, head: { sha: f.base } } },
  ]) {
    await fs.writeFile(f.eventFile, JSON.stringify(event));
    await assert.rejects(main(['plan'], { repoRoot: f.repoRoot, env: f.env }), error => error.code === 'CI_PLAN_INVALID');
  }
  await fs.writeFile(f.eventFile, JSON.stringify(f.event)); f.git(['checkout', '--detach', f.head]);
  await assert.rejects(main(['plan'], { repoRoot: f.repoRoot, env: { ...f.env, GITHUB_SHA: f.head } }), planError('PR_MERGE_MISMATCH'));
});

test('verify rederives classification and refuses stale or tampered mode outputs', async t => {
  const f = await mergeFixture(t);
  assert.equal((await main(['verify'], { repoRoot: f.repoRoot, env: { ...f.env, CUEFLUENT_CI_MODE: 'distribution' } })).mode, 'distribution');
  for (const mode of [undefined, '', 'reuse', 'full']) {
    await assert.rejects(main(['verify'], { repoRoot: f.repoRoot, env: { ...f.env, CUEFLUENT_CI_MODE: mode } }), planError('PLAN_MODE_MISMATCH'));
  }
  const full = await mergeFixture(t, { 'tools/changed.mjs': 'changed CI implementation\n' });
  assert.equal((await main(['plan'], { repoRoot: full.repoRoot, env: full.env })).mode, 'full');
  await assert.rejects(main(['verify'], { repoRoot: full.repoRoot, env: { ...full.env, CUEFLUENT_CI_MODE: 'distribution' } }), planError('PLAN_MODE_MISMATCH'));
});

test('manual runs are full and unsupported events, bad event files and commands fail closed', async t => {
  const f = await mergeFixture(t);
  const manual = { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: undefined };
  assert.deepEqual(await main(['plan'], { repoRoot: f.repoRoot, env: manual }), { mode: 'full', changedFiles: [], reason: 'MANUAL_RUN' });
  await assert.rejects(main(['plan'], { repoRoot: f.repoRoot, env: { ...manual, GITHUB_SHA: f.base } }), planError('CHECKOUT_MISMATCH'));
  await assert.rejects(main(['plan'], { repoRoot: f.repoRoot, env: { ...f.env, GITHUB_EVENT_NAME: 'push' } }), planError('EVENT_UNSUPPORTED'));
  await assert.rejects(main(['unknown'], { repoRoot: f.repoRoot, env: f.env }), planError('COMMAND_INVALID'));
  await fs.writeFile(f.eventFile, '{invalid JSON');
  await assert.rejects(main(['plan'], { repoRoot: f.repoRoot, env: f.env }), planError('EVENT_FILE_INVALID'));
  await fs.writeFile(f.eventFile, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(main(['plan'], { repoRoot: f.repoRoot, env: f.env }), planError('EVENT_FILE_INVALID'));
});
