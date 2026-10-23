import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { recordBuildSource } from '../tools/ci.mjs';
import { packageSource } from './fixtures/package-source.mjs';

async function fixture(t) {
  const f = await packageSource(t);
  const git = args => execFileSync('git', args, { cwd: f.source, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(f.root, 'absent-config'),
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['add', '.']); git(['commit', '-m', 'Synthetic source']);
  const commit = git(['rev-parse', 'HEAD']);
  const env = { GITHUB_REPOSITORY: 'example/notes', GITHUB_REPOSITORY_ID: '12', GITHUB_RUN_ID: '34', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: commit, CUEFLUENT_HEAD_SHA: commit };
  return { ...f, git, env };
}

test('source evidence records the actual checkout and binds its exact build receipt', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.output, 'build.json'));
  const reads = [], readFile = fs.readFile;
  const read = t.mock.method(fs, 'readFile', async (...args) => { reads.push(args[0]); return readFile(...args); });
  const result = await recordBuildSource(f.output, { repoRoot: f.source, env: f.env });
  read.mock.restore();
  assert.deepEqual(reads, [path.join(f.output, 'build.json')]);
  assert.equal(result.checkoutCommit, f.env.GITHUB_SHA);
  assert.equal(result.checkoutTree, f.git(['rev-parse', 'HEAD^{tree}']));
  assert.equal(result.receiptSha256, createHash('sha256').update(before).digest('hex'));
  assert.equal(result.runId, 34); assert.equal(result.runAttempt, 1); assert.equal(result.pullRequest, null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.output, 'source.json'), 'utf8')), result);
  assert.deepEqual(await fs.readFile(path.join(f.output, 'build.json')), before);
  await assert.rejects(recordBuildSource(f.output, { repoRoot: f.source, env: f.env }), { code: 'EEXIST' });
});

test('source evidence rejects dirty tracked files and substituted checkout or run identity', async t => {
  const f = await fixture(t);
  for (const patch of [{ GITHUB_SHA: 'a'.repeat(40) }, { CUEFLUENT_HEAD_SHA: 'b'.repeat(40) },
    { GITHUB_RUN_ID: '01' }, { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_REPOSITORY: 'not/a/repo' },
    { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_EVENT_NAME: 'push' }]) {
    await assert.rejects(recordBuildSource(f.output, { repoRoot: f.source, env: { ...f.env, ...patch } }), { code: 'CI_CANDIDATE_INVALID' });
  }
  await fs.appendFile(path.join(f.source, 'README.md'), '\nChanged after checkout.\n');
  await assert.rejects(recordBuildSource(f.output, { repoRoot: f.source, env: f.env }));
  await assert.rejects(fs.stat(path.join(f.output, 'source.json')), { code: 'ENOENT' });
});

test('PR evidence records the synthetic merge tree and refuses a different PR head', async t => {
  const f = await fixture(t), base = f.env.GITHUB_SHA;
  f.git(['checkout', '-b', 'feature']);
  await fs.writeFile(path.join(f.source, 'test-only.txt'), 'Synthetic PR change.\n');
  f.git(['add', '.']); f.git(['commit', '-m', 'Synthetic PR']);
  const head = f.git(['rev-parse', 'HEAD']);
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', 'feature', '-m', 'Synthetic merge']);
  const merge = f.git(['rev-parse', 'HEAD']); assert.notEqual(merge, head);
  const env = { ...f.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: merge, CUEFLUENT_HEAD_SHA: head, CUEFLUENT_PULL_REQUEST: '7' };
  for (const number of [undefined, '', '0', '-1', '01', '1.5', '7x', '9007199254740992']) {
    await assert.rejects(recordBuildSource(f.output, { repoRoot: f.source, env: { ...env, CUEFLUENT_PULL_REQUEST: number } }), { code: 'CI_CANDIDATE_INVALID' });
    await assert.rejects(fs.stat(path.join(f.output, 'source.json')), { code: 'ENOENT' });
  }
  await assert.rejects(recordBuildSource(f.output, { repoRoot: f.source, env: { ...env, CUEFLUENT_HEAD_SHA: base } }), { code: 'CI_CANDIDATE_INVALID' });
  const result = await recordBuildSource(f.output, { repoRoot: f.source, env });
  assert.equal(result.checkoutCommit, merge); assert.equal(result.headSha, head); assert.equal(result.pullRequest, 7);
  assert.equal(result.checkoutTree, f.git(['rev-parse', `${head}^{tree}`]));
});

test('PR evidence refuses a single-parent checkout and a shallow checkout without parent evidence', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'test-only.txt'), 'Synthetic single-parent change.\n');
  f.git(['add', '.']); f.git(['commit', '-m', 'Synthetic single-parent commit']);
  const commit = f.git(['rev-parse', 'HEAD']);
  assert.equal(f.git(['show', '-s', '--format=%P', 'HEAD']).split(' ').length, 1);
  const env = { ...f.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: commit, CUEFLUENT_HEAD_SHA: commit, CUEFLUENT_PULL_REQUEST: '7' };
  await assert.rejects(recordBuildSource(f.output, { repoRoot: f.source, env }), { code: 'CI_CANDIDATE_INVALID' });
  await assert.rejects(fs.stat(path.join(f.output, 'source.json')), { code: 'ENOENT' });

  await fs.writeFile(path.join(f.source, '.git/shallow'), `${commit}\n`);
  assert.equal(f.git(['show', '-s', '--format=%P', 'HEAD']), '');
  await assert.rejects(recordBuildSource(f.output, { repoRoot: f.source, env }), { code: 'CI_CANDIDATE_INVALID' });
  await assert.rejects(fs.stat(path.join(f.output, 'source.json')), { code: 'ENOENT' });
});
