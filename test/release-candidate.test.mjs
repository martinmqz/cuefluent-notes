import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { selectReleaseCandidate, verifyReleaseCandidate } from '../tools/release-candidate.mjs';

const sha = digit => digit.repeat(40), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repository = 'example/cuefluent-notes', repositoryId = 12, runId = 42;
const tagCommit = sha('1'), tree = sha('2'), headSha = sha('3'), checkoutCommit = sha('4'), baseSha = sha('5');
const platforms = ['ubuntu-24.04', 'macos-14', 'windows-2025'];
const jobs = ['guidance', 'test (ubuntu-24.04)', 'test (macos-14)', 'test (windows-2025)',
  'test (windows-2025, 2/4)', 'test (windows-2025, 3/4)', 'test (windows-2025, 4/4)',
  'client-smoke (macos-14)', 'client-smoke (windows-2025)', 'reproducibility'];
const invalid = { code: 'RELEASE_EVIDENCE_INVALID' };

async function fixture(t, event = 'pull_request') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-release-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, 'release'), lock = Buffer.from('{"synthetic":"lock"}\n');
  const metadata = { name: 'cuefluent-notes', version: '0.16.0' }, repo = { id: repositoryId, full_name: repository };
  const run = { id: runId, workflow_id: 8, path: '.github/workflows/ci.yml', repository: repo, head_repository: repo,
    status: 'completed', conclusion: 'success', run_attempt: 2, head_sha: event === 'pull_request' ? headSha : tagCommit,
    event, head_branch: event === 'pull_request' ? 'feat/change' : 'main' };
  const artifacts = platforms.map((platform, index) => ({ id: 100 + index, name: `v2-candidate-${platform}`, expired: false,
    size_in_bytes: 1234, digest: `sha256:${String(index + 1).repeat(64)}`, expires_at: '2099-01-01T00:00:00Z',
    workflow_run: { id: runId, repository_id: repositoryId, head_repository_id: repositoryId, head_sha: run.head_sha, head_branch: run.head_branch } }));
  const jobValues = jobs.map((name, index) => ({ id: 200 + index, name, run_id: runId, run_attempt: 1, status: 'completed', conclusion: 'success' }));
  // A failed-only rerun need not return duplicated records for successful jobs.
  const failedWindows = jobValues.find(job => job.name === 'test (windows-2025)'); failedWindows.conclusion = 'failure';
  jobValues.push({ ...failedWindows, id: 300, run_attempt: 2, conclusion: 'success' });
  const commits = new Map([
    [checkoutCommit, { sha: checkoutCommit, tree: { sha: tree }, parents: [{ sha: baseSha }, { sha: headSha }] }],
    [headSha, { sha: headSha, tree: { sha: tree }, parents: [{ sha: baseSha }] }],
    [tagCommit, { sha: tagCommit, tree: { sha: tree }, parents: [{ sha: baseSha }] }],
  ]);
  const pr = { number: 9, merged: true, state: 'closed', base: { ref: 'main', repo }, head: { sha: headSha, repo }, merge_commit_sha: tagCommit };
  const reference = { ref: 'refs/tags/v0.16.0', object: { type: 'commit', sha: tagCommit } }, tagObjects = new Map();
  const calls = [], gitCalls = [];
  const git = args => {
    gitCalls.push(args);
    if (args[0] === 'rev-parse') return Buffer.from(args[2].endsWith('^{tree}') ? tree : tagCommit);
    if (args[0] === 'merge-base') return Buffer.alloc(0);
    if (args[0] === 'show' && args[1].endsWith(':package.json')) return Buffer.from(JSON.stringify(metadata));
    if (args[0] === 'show' && args[1].endsWith(':package-lock.json')) return lock;
    assert.fail(`Unexpected git arguments: ${JSON.stringify(args)}`);
  };
  const request = async route => {
    calls.push(route); const suffix = route.slice(`/repos/${repository}`.length);
    if (suffix === '/git/ref/tags/v0.16.0') return structuredClone(reference);
    if (suffix.startsWith('/git/tags/')) return structuredClone(tagObjects.get(suffix.slice('/git/tags/'.length)));
    if (suffix === '/actions/workflows/ci.yml') return { id: 8, path: '.github/workflows/ci.yml' };
    if (suffix === `/actions/runs/${runId}`) return structuredClone(run);
    if (suffix.startsWith(`/actions/runs/${runId}/jobs?`)) {
      assert(suffix.includes('filter=all')); return { total_count: jobValues.length, jobs: structuredClone(jobValues) };
    }
    if (suffix.startsWith(`/actions/runs/${runId}/artifacts?`)) return { total_count: artifacts.length, artifacts: structuredClone(artifacts) };
    if (suffix.startsWith('/git/commits/')) return structuredClone(commits.get(suffix.slice('/git/commits/'.length)));
    if (suffix === '/pulls/9') return structuredClone(pr);
    assert.fail(`Unexpected API request: ${route}`);
  };
  const env = { RELEASE_TAG: 'v0.16.0', CHECKS_RUN_ID: String(runId), GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: String(repositoryId), CUEFLUENT_RELEASE_ROOT: releaseRoot, GITHUB_OUTPUT: path.join(root, 'outputs') };
  const options = { env, git, request }, archives = new Map();
  const entries = client => ['tar.gz', 'zip'].map(extension => {
    const name = `cuefluent-notes-0.16.0-${client}.${extension}`, bytes = Buffer.from(`Synthetic ${client} ${extension} archive\n`);
    archives.set(name, bytes); return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  const receipt = { schema: 1, version: '0.16.0', sourceLockSha256: hash(lock),
    packages: ['codex', 'claude'].map(client => ({ client, path: `${client}/cuefluent-notes`, inventorySha256: 'a'.repeat(64), archives: entries(client) })), tools: entries('tools') };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const source = { schema: 1, repository, repositoryId, runId, runAttempt: 1, event,
    pullRequest: event === 'pull_request' ? 9 : null, headSha: run.head_sha,
    checkoutCommit: event === 'pull_request' ? checkoutCommit : tagCommit, checkoutTree: tree, receiptSha256: hash(receiptBytes) };
  const populate = async () => {
    for (let index = 0; index < artifacts.length; index++) {
      const dir = path.join(releaseRoot, 'artifacts', artifacts[index].name); await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'build.json'), receiptBytes);
      await fs.writeFile(path.join(dir, 'source.json'), JSON.stringify({ ...source, runAttempt: index === 2 ? 2 : 1 }));
      for (const [name, bytes] of archives) await fs.writeFile(path.join(dir, name), bytes);
    }
  };
  const editSource = async changes => {
    const file = path.join(releaseRoot, 'artifacts', artifacts[0].name, 'source.json');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...changes }));
  };
  return { root, releaseRoot, options, run, artifacts, jobValues, commits, pr, metadata, calls, gitCalls, source,
    receipt, receiptBytes, archives, populate, editSource, reference, tagObjects };
}

test('release reuses a checked PR tree after squash merge, retaining older successful shard artifacts', async t => {
  const f = await fixture(t), selection = await selectReleaseCandidate(f.options); await f.populate();
  assert.equal(selection.tag.commit, tagCommit); assert.notEqual(tagCommit, checkoutCommit);
  assert.equal(await fs.readFile(f.options.env.GITHUB_OUTPUT, 'utf8'), 'artifact_ids=100,101,102\nrun_id=42\n');
  const evidence = await verifyReleaseCandidate(f.options), candidate = path.join(f.releaseRoot, 'candidate');
  assert.equal(evidence.source.checkoutTree, tree);
  assert.deepEqual(evidence.artifactAttempts.map(value => value.runAttempt), [1, 1, 2]);
  assert.equal(evidence.run.jobs.find(job => job.name === 'guidance').runAttempt, 1);
  assert.equal(evidence.run.jobs.find(job => job.name === 'test (windows-2025)').runAttempt, 2);
  assert.deepEqual((await fs.readdir(candidate)).sort(), ['build.json', 'release-evidence.json', ...f.archives.keys()].sort());
  for (const [name, bytes] of f.archives) assert.deepEqual(await fs.readFile(path.join(candidate, name)), bytes);
  assert(f.gitCalls.some(args => sameArgs(args, ['merge-base', '--is-ancestor', tagCommit, 'origin/main'])));
  assert(f.calls.some(route => route.endsWith(`/git/commits/${checkoutCommit}`)));
  assert(f.calls.some(route => route.endsWith(`/git/commits/${headSha}`)));
});
const sameArgs = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('manual and push Checks runs must be for the exact main tag commit', async t => {
  for (const event of ['push', 'workflow_dispatch']) {
    await t.test(event, async t => {
      const f = await fixture(t, event); await selectReleaseCandidate(f.options); await f.populate();
      assert.equal((await verifyReleaseCandidate(f.options)).source.checkoutCommit, tagCommit);
      assert(!f.calls.some(route => route.includes('/pulls/')));
    });
  }
  const f = await fixture(t, 'push'); f.run.head_sha = headSha;
  for (const artifact of f.artifacts) artifact.workflow_run.head_sha = headSha;
  await assert.rejects(selectReleaseCandidate(f.options), invalid);
});

test('selection refuses failed, skipped, foreign, missing, duplicate, expired and digestless evidence', async t => {
  const cases = [
    f => { f.run.conclusion = 'failure'; },
    f => { f.run.status = 'in_progress'; },
    f => { f.run.repository = { id: 99, full_name: repository }; },
    f => { f.run.head_repository = { id: 99, full_name: repository }; },
    f => { f.run.workflow_id = 99; },
    f => { f.run.path = '.github/workflows/other.yml'; },
    f => { f.run.event = 'workflow_run'; },
    f => { f.jobValues.at(-1).conclusion = 'skipped'; },
    f => { f.jobValues[0].conclusion = 'failure'; },
    f => { f.jobValues.shift(); },
    f => { f.jobValues.push({ ...f.jobValues[0], id: 900 }); },
    f => { f.jobValues[0].run_attempt = 3; },
    f => { f.artifacts.pop(); },
    f => { f.artifacts[1].name = f.artifacts[0].name; },
    f => { f.artifacts[1].id = f.artifacts[0].id; },
    f => { f.artifacts[0].expired = true; },
    f => { f.artifacts[0].expires_at = '2000-01-01T00:00:00Z'; },
    f => { delete f.artifacts[0].digest; },
    f => { f.artifacts[0].workflow_run.head_sha = baseSha; },
    f => { f.artifacts[0].workflow_run.id = 99; },
  ];
  for (let index = 0; index < cases.length; index++) await t.test(`invalid evidence ${index + 1}`, async t => {
    const f = await fixture(t); cases[index](f); await assert.rejects(selectReleaseCandidate(f.options), invalid);
    await assert.rejects(fs.stat(f.releaseRoot), { code: 'ENOENT' });
  });
});

test('tag input, package agreement and main ancestry are checked before artifact selection', async t => {
  for (const tag of ['v0.16', 'v0.16.0\n', 'v0.16.0+build.1', '--option']) {
    const f = await fixture(t); f.options.env.RELEASE_TAG = tag;
    await assert.rejects(selectReleaseCandidate(f.options), invalid); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t); f.metadata.version = '0.17.0';
  await assert.rejects(selectReleaseCandidate(f.options), invalid); assert.equal(f.calls.length, 0);
  const g = await fixture(t), original = g.options.git;
  g.options.git = args => { if (args[0] === 'merge-base') throw new Error('Synthetic non-ancestor'); return original(args); };
  await assert.rejects(selectReleaseCandidate(g.options), { ...invalid, releaseStage: 'tag' }); assert.equal(g.calls.length, 0);
});

test('release verification rejects forged source bindings and invalid selective rerun attempts', async t => {
  const cases = [
    { repository: 'other/repository' }, { repositoryId: 99 }, { runId: 99 }, { runAttempt: 0 }, { runAttempt: 3 },
    { event: 'push' }, { headSha: baseSha }, { checkoutTree: baseSha }, { receiptSha256: '0'.repeat(64) },
    { checkoutCommit: headSha }, { pullRequest: null },
  ];
  for (let index = 0; index < cases.length; index++) await t.test(`invalid binding ${index + 1}`, async t => {
    const f = await fixture(t); await selectReleaseCandidate(f.options); await f.populate(); await f.editSource(cases[index]);
    await assert.rejects(verifyReleaseCandidate(f.options), invalid);
    await assert.rejects(fs.stat(path.join(f.releaseRoot, 'candidate')), { code: 'ENOENT' });
  });
});

test('release checks both GitHub commit trees, merge parents and merged PR identity', async t => {
  const cases = [
    f => { f.commits.get(checkoutCommit).tree.sha = baseSha; },
    f => { f.commits.get(headSha).tree.sha = baseSha; },
    f => { f.commits.get(checkoutCommit).parents.reverse(); },
    f => { f.pr.merged = false; },
    f => { f.pr.base.ref = 'other'; },
    f => { f.pr.head.sha = baseSha; },
    f => { f.pr.head.repo = { id: 99, full_name: repository }; },
  ];
  for (let index = 0; index < cases.length; index++) await t.test(`invalid merge evidence ${index + 1}`, async t => {
    const f = await fixture(t); await selectReleaseCandidate(f.options); await f.populate(); cases[index](f);
    await assert.rejects(verifyReleaseCandidate(f.options), invalid);
  });
});

test('metadata changes after selection, missing provenance, lock mismatches and corrupt archives fail closed', async t => {
  for (const change of ['rerun', 'artifact', 'missing-source', 'lock', 'archive']) await t.test(change, async t => {
    const f = await fixture(t); await selectReleaseCandidate(f.options); await f.populate();
    const dir = path.join(f.releaseRoot, 'artifacts', f.artifacts[0].name);
    if (change === 'rerun') f.run.run_attempt++;
    if (change === 'artifact') f.artifacts[0].digest = `sha256:${'a'.repeat(64)}`;
    if (change === 'missing-source') await fs.unlink(path.join(dir, 'source.json'));
    if (change === 'archive') await fs.appendFile(path.join(dir, f.archives.keys().next().value), 'corruption');
    if (change === 'lock') {
      for (const artifact of f.artifacts) {
        const root = path.join(f.releaseRoot, 'artifacts', artifact.name), bytes = Buffer.from(JSON.stringify({ ...f.receipt, sourceLockSha256: '0'.repeat(64) }));
        await fs.writeFile(path.join(root, 'build.json'), bytes);
        await fs.writeFile(path.join(root, 'source.json'), JSON.stringify({ ...f.source, receiptSha256: hash(bytes) }));
      }
    }
    await assert.rejects(verifyReleaseCandidate(f.options));
    await assert.rejects(fs.stat(path.join(f.releaseRoot, 'candidate')), { code: 'ENOENT' });
  });
});

test('remote tag verification peels annotated tags and rejects moved, replaced or deleted refs', async t => {
  const f = await fixture(t), annotation = sha('6');
  f.reference.object = { type: 'tag', sha: annotation };
  f.tagObjects.set(annotation, { sha: annotation, object: { type: 'commit', sha: tagCommit } });
  const selected = await selectReleaseCandidate(f.options); await f.populate();
  assert.equal(selected.tag.refSha, annotation);
  assert.equal((await verifyReleaseCandidate(f.options)).tag.commit, tagCommit);
  for (const mode of ['moved-before-selection', 'moved-after-selection', 'replaced-annotation', 'deleted', 'cycle', 'moved-at-final-check']) {
    await t.test(mode, async t => {
      const g = await fixture(t);
      if (mode !== 'moved-before-selection') { await selectReleaseCandidate(g.options); await g.populate(); }
      if (mode === 'moved-before-selection' || mode === 'moved-after-selection') g.reference.object.sha = baseSha;
      if (mode === 'replaced-annotation') {
        g.reference.object = { type: 'tag', sha: annotation };
        g.tagObjects.set(annotation, { sha: annotation, object: { type: 'commit', sha: tagCommit } });
      }
      if (mode === 'cycle') {
        g.reference.object = { type: 'tag', sha: annotation };
        g.tagObjects.set(annotation, { sha: annotation, object: { type: 'tag', sha: annotation } });
      }
      if (mode === 'deleted' || mode === 'moved-at-final-check') {
        const original = g.options.request; let reads = 0;
        g.options.request = async route => {
          if (route.includes('/git/ref/tags/')) {
            if (mode === 'deleted') throw new Error('Synthetic missing ref');
            if (++reads === 2) g.reference.object.sha = baseSha;
          }
          return original(route);
        };
      }
      await assert.rejects(mode === 'moved-before-selection' ? selectReleaseCandidate(g.options) : verifyReleaseCandidate(g.options));
      await assert.rejects(fs.stat(path.join(g.releaseRoot, 'candidate')), { code: 'ENOENT' });
    });
  }
});
