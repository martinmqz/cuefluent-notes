import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { ARTIFACT_NAMES, digest } from '../tools/ci.mjs';
import { EXPECTED_CHECK_JOBS } from '../tools/release-candidate.mjs';
import { main, mainEvidenceErrorMessage, selectMainEvidence, verifyMainEvidence } from '../tools/main-evidence.mjs';

const sha = value => value.repeat(40), hash = value => value.repeat(64);
const target = sha('a'), tree = sha('b'), head = sha('c'), checkout = sha('d'), base = sha('e');
const repository = { id: 17, full_name: 'example/cuefluent-notes' }, api = `/repos/${repository.full_name}`;
const reason = expected => error => error.reason === expected;

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-main-evidence-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'evidence');
  const run = { id: 42, workflow_id: 9, path: '.github/workflows/ci.yml', repository, head_repository: repository,
    status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: head, head_branch: 'feature',
    event: 'pull_request', created_at: '2026-10-22T10:00:00Z' };
  const pr = { number: 7, merged: true, state: 'closed', merge_commit_sha: target,
    base: { ref: 'main', repo: repository }, head: { sha: head, repo: repository } };
  const receipt = Buffer.from('{"synthetic":"receipt"}\n');
  const source = { schema: 1, repository: repository.full_name, repositoryId: repository.id,
    runId: run.id, runAttempt: 1, event: run.event, headSha: head, checkoutCommit: checkout,
    checkoutTree: tree, receiptSha256: digest(receipt), pullRequest: pr.number };
  const jobs = EXPECTED_CHECK_JOBS.map((name, index) => ({ id: 100 + index, name, run_id: run.id, run_attempt: 1,
    status: 'completed', conclusion: 'success' }));
  const artifacts = ARTIFACT_NAMES.map((name, index) => ({ id: 50 + index, name, expired: false, size_in_bytes: 1024,
    digest: `sha256:${hash(String(index + 1))}`, expires_at: '2026-11-22T10:00:00Z', workflow_run: {
      id: run.id, repository_id: repository.id, head_repository_id: repository.id, head_sha: head, head_branch: run.head_branch } }));
  const state = { run, pr, receipt, source, jobs, artifacts, pulls: [pr], manualRuns: [], prRuns: [run],
    checkedOut: target, checkoutTree: tree, mainAncestor: true, listCount: undefined,
    distributions: new Map(), newWorkflow: false, mergeParents: null,
    commits: { [checkout]: { sha: checkout, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] },
      [head]: { sha: head, tree: { sha: tree }, parents: [{ sha: base }] },
      [target]: { sha: target, tree: { sha: tree }, parents: [{ sha: base }] } } };
  const unexpected = [], requests = [];
  t.after(() => assert.deepEqual(unexpected, [], 'no unexpected API or git calls were swallowed'));
  const unexpectedCall = text => { unexpected.push(text); assert.fail(text); };
  const request = async route => {
    requests.push(route);
    if (route === `${api}/actions/workflows/ci.yml`) return { id: 9, path: '.github/workflows/ci.yml' };
    for (const entry of state.distributions.values()) {
      if (route === `${api}/commits/${entry.commit}/pulls?per_page=100&page=1`) return structuredClone([entry.pr]);
      if (route === `${api}/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=${entry.commit}&per_page=100&page=1`) return { total_count: 0, workflow_runs: [] };
      if (route === `${api}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${entry.head}&per_page=100&page=1`) return structuredClone({ total_count: entry.runs.length, workflow_runs: entry.runs });
      if (route === `${api}/actions/runs/${entry.run.id}/jobs?filter=all&per_page=100&page=1`) return structuredClone({ total_count: entry.jobs.length, jobs: entry.jobs });
      if (route === `${api}/actions/runs/${entry.run.id}/artifacts?per_page=100&page=1`) return structuredClone({ total_count: entry.artifacts.length, artifacts: entry.artifacts });
      if (route === `${api}/pulls/${entry.pr.number}`) return structuredClone(entry.pr);
    }
    if (route === `${api}/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=${target}&per_page=100&page=1`)
      return structuredClone({ total_count: state.manualRuns.length, workflow_runs: state.manualRuns });
    if (route === `${api}/commits/${target}/pulls?per_page=100&page=1`) return structuredClone(state.pulls);
    if (route === `${api}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100&page=1`)
      return structuredClone({ total_count: state.listCount ?? state.prRuns.length, workflow_runs: state.prRuns });
    const runMatch = route.match(new RegExp(`^${api}/actions/runs/([0-9]+)$`));
    if (runMatch) {
      const value = [...state.manualRuns, ...state.prRuns, ...[...state.distributions.values()].flatMap(entry => entry.runs)].find(item => item.id === Number(runMatch[1]));
      if (value) return structuredClone(value);
    }
    if (route === `${api}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=1`)
      return structuredClone({ total_count: state.jobs.length, jobs: state.jobs });
    if (route === `${api}/actions/runs/${run.id}/artifacts?per_page=100&page=1`)
      return structuredClone({ total_count: state.artifacts.length, artifacts: state.artifacts });
    if (route === `${api}/pulls/${pr.number}`) return structuredClone(state.pr);
    const commit = route.slice(`${api}/git/commits/`.length);
    if (route.startsWith(`${api}/git/commits/`) && state.commits[commit]) return structuredClone(state.commits[commit]);
    return unexpectedCall(`Unexpected API route: ${route}`);
  };
  const git = args => {
    if (args.join(' ') === 'rev-parse --verify HEAD') return state.checkedOut;
    if (args.join(' ') === 'rev-parse --verify HEAD^{tree}') return state.checkoutTree;
    if (sameArgs(args, ['show', '-s', '--format=%P', 'HEAD']) && state.mergeParents) return state.mergeParents.join(' ');
    if (args[0] === 'show' && args[1]?.endsWith(':.github/workflows/ci.yml')) return state.newWorkflow || state.distributions.has(args[1].split(':')[0]) ? 'jobs:\n  plan:\n    run: node tools/ci-plan.mjs plan\n' : 'jobs:\n  test: {}\n';
    for (const entry of state.distributions.values()) {
      if (sameArgs(args, ['rev-parse', '--verify', `${entry.commit}^1`])) return entry.parent;
      if (sameArgs(args, ['rev-parse', '--verify', `${entry.commit}^{tree}`])) return entry.tree;
      if (sameArgs(args, ['merge-base', '--is-ancestor', entry.commit, 'origin/main'])) return '';
    }
    if (sameArgs(args, ['rev-parse', '--verify', `${target}^1`])) return base;
    if (sameArgs(args, ['rev-parse', '--verify', `${target}^{tree}`])) return tree;
    if (sameArgs(args, ['merge-base', '--is-ancestor', target, 'origin/main'])) {
      if (!state.mainAncestor) throw new Error('Synthetic non-ancestor');
      return '';
    }
    if (sameArgs(args, ['merge-base', '--is-ancestor', target, target])) return '';
    return unexpectedCall(`Unexpected git arguments: ${JSON.stringify(args)}`);
  };
  const env = { GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id),
    GITHUB_SHA: target, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push',
    CUEFLUENT_MAIN_EVIDENCE_ROOT: root, GITHUB_OUTPUT: path.join(temporary, 'outputs'), GITHUB_STEP_SUMMARY: path.join(temporary, 'summary') };
  const options = { env, git, request, now: () => Date.parse('2026-10-23T00:00:00Z'), classify: async ({ baselineRevision, revision }) => {
    const entry = state.distributions.get(revision);
    if (!entry) return { mode: 'full', changedFiles: ['src/example.mjs'], reason: 'FULL' };
    assert.equal(baselineRevision, entry.parent);
    return { mode: entry.mode, changedFiles: ['plugins/0.16.0/README.md'], reason: 'DISTRIBUTION' };
  } };
  const download = async () => {
    await fs.mkdir(path.join(root, 'artifact'));
    await fs.writeFile(path.join(root, 'artifact', 'build.json'), state.receipt);
    await fs.writeFile(path.join(root, 'artifact', 'source.json'), JSON.stringify(state.source));
    await fs.writeFile(path.join(root, 'artifact', 'candidate.mjs'), 'throw new Error("Candidate code must never execute");\n');
  };
  const manual = (branch = 'main') => {
    Object.assign(run, { event: 'workflow_dispatch', head_sha: target, head_branch: branch });
    Object.assign(source, { event: run.event, headSha: target, checkoutCommit: target, pullRequest: null });
    for (const artifact of artifacts) Object.assign(artifact.workflow_run, { head_sha: target, head_branch: branch });
    state.manualRuns = [run]; state.prRuns = []; state.pulls = [];
  };
  const distribute = count => {
    const id = n => n.toString(16).padStart(40, '0'); let parent = target;
    for (let index = 0; index < count; index++) {
      const commit = id(1000 + index), head = id(2000 + index), tree = id(3000 + index);
      const distributedRun = { ...run, id: 1000 + index, head_sha: head, head_branch: 'distribution', created_at: '2026-10-23T00:00:00Z' };
      const pr = { number: 100 + index, merged: true, state: 'closed', merge_commit_sha: commit,
        base: { ref: 'main', repo: repository }, head: { sha: head, repo: repository } };
      const entry = { commit, head, tree, parent, pr, run: distributedRun, runs: [distributedRun], artifacts: [], mode: 'distribution',
        jobs: ['plan', ...EXPECTED_CHECK_JOBS].map((name, i) => ({ id: 10000 + index * 20 + i, name, run_id: distributedRun.id,
          run_attempt: 1, status: 'completed', conclusion: 'success' })) };
      state.distributions.set(commit, entry); state.commits[head] = { sha: head, tree: { sha: tree } };
      parent = commit;
    }
    const last = state.distributions.get(parent); state.checkedOut = last.commit; state.checkoutTree = last.tree; env.GITHUB_SHA = last.commit;
    return last;
  };
  return { options, state, root, requests, download, manual, distribute };
}
const sameArgs = (left, right) => JSON.stringify(left) === JSON.stringify(right);

test('main pushes verify one digest-bound primary artifact and reuse the successful PR tree', async t => {
  const f = await fixture(t); f.state.run.path = '.github/workflows/ci.yml@refs/pull/7/merge';
  const selected = await selectMainEvidence(f.options);
  assert.equal(selected.artifact.id, 50);
  assert.equal(await fs.readFile(f.options.env.GITHUB_OUTPUT, 'utf8'), 'artifact_id=50\nrun_id=42\n');
  await f.download();
  const evidence = await verifyMainEvidence(f.options);
  assert.equal(evidence.target.commit, target);
  assert.equal(evidence.source.checkoutCommit, checkout);
  assert.match(await fs.readFile(f.options.env.GITHUB_STEP_SUMMARY, 'utf8'), /No platform checks were repeated/);
  assert.ok(f.requests.every(route => !route.includes('/dispatches')));
});

for (const branch of ['main', 'v0.16.0', 'v0.16.0-rc.1']) {
  test(`an explicit successful Checks dispatch on ${branch} recovers exact main evidence`, async t => {
    const f = await fixture(t); f.manual(branch); f.options.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    await selectMainEvidence(f.options); await f.download();
    assert.equal((await verifyMainEvidence(f.options)).source.checkoutCommit, target);
  });
}

test('a direct push with no source evidence fails visibly instead of launching a matrix', async t => {
  const f = await fixture(t); f.state.pulls = []; f.state.prRuns = [];
  await assert.rejects(selectMainEvidence(f.options), reason('CHECKS_EVIDENCE_MISSING'));
  assert.equal(f.requests.length, 2);
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
});

for (const [status, conclusion] of [['completed', 'failure'], ['in_progress', null], ['completed', 'cancelled']]) {
  test(`a newer ${conclusion ?? status} Checks run cannot hide behind an older successful run`, async t => {
    const f = await fixture(t);
    f.state.prRuns.push({ ...f.state.run, id: 43, created_at: '2026-10-22T11:00:00Z', status, conclusion });
    await assert.rejects(selectMainEvidence(f.options), reason('CHECKS_RUN_INVALID'));
    assert.ok(f.requests.includes(`${api}/actions/runs/43`));
    assert.ok(!f.requests.includes(`${api}/actions/runs/42`));
  });
}

test('a skipped required job cannot supply evidence for a bypass merge', async t => {
  const f = await fixture(t); f.state.jobs[0].conclusion = 'skipped';
  await assert.rejects(selectMainEvidence(f.options), error => error.releaseStage === 'jobs');
});

test('unrelated manual branch runs are not evidence for main', async t => {
  const f = await fixture(t); f.manual('feature');
  await assert.rejects(selectMainEvidence(f.options), reason('CHECKS_EVIDENCE_MISSING'));
});

test('PR discovery cannot substitute an unrelated merge or a foreign repository', async t => {
  for (const change of [pr => { pr.merge_commit_sha = base; }, pr => { pr.head.repo = { ...repository, id: 18 }; }]) {
    const f = await fixture(t); change(f.state.pr);
    await assert.rejects(selectMainEvidence(f.options), reason('CHECKS_EVIDENCE_MISSING'));
  }
});

test('a PR run from another tested tree is rejected even when every check passed', async t => {
  const f = await fixture(t); await selectMainEvidence(f.options);
  f.state.commits[checkout].tree.sha = sha('f'); await f.download();
  await assert.rejects(verifyMainEvidence(f.options), reason('EVIDENCE_MISMATCH'));
});

test('manual evidence must have tested the inspected main commit itself', async t => {
  const f = await fixture(t); f.manual(); await selectMainEvidence(f.options);
  f.state.source.checkoutCommit = checkout; await f.download();
  await assert.rejects(verifyMainEvidence(f.options), reason('SOURCE_COMMIT_MISMATCH'));
});

test('source receipt hashes and PR numbers remain bound to the selected run', async t => {
  for (const [change, expected] of [
    [source => { source.receiptSha256 = hash('f'); }, 'SOURCE_BINDING_INVALID'],
    [source => { source.pullRequest = 8; }, 'SOURCE_PR_MISMATCH'],
    [source => { source.runId = 43; }, 'SOURCE_BINDING_INVALID'],
  ]) {
    const f = await fixture(t); await selectMainEvidence(f.options); change(f.state.source); await f.download();
    await assert.rejects(verifyMainEvidence(f.options), reason(expected));
  }
});

test('a new run or replaced artifact between selection and verification invalidates the snapshot', async t => {
  for (const change of [
    state => { state.prRuns.push({ ...state.run, id: 43, created_at: '2026-10-22T11:00:00Z' }); },
    state => { state.artifacts[0].digest = `sha256:${hash('f')}`; },
  ]) {
    const f = await fixture(t); await selectMainEvidence(f.options); await f.download(); change(f.state);
    await assert.rejects(verifyMainEvidence(f.options), reason('EVIDENCE_CHANGED'));
  }
});

test('expired artifacts and excessive search results fail closed', async t => {
  const expired = await fixture(t); expired.state.artifacts[0].expired = true;
  await assert.rejects(selectMainEvidence(expired.options), error => error.releaseStage === 'artifacts');
  const excess = await fixture(t); excess.state.listCount = 101;
  await assert.rejects(selectMainEvidence(excess.options), reason('RUN_SEARCH_LIMIT_OR_SHAPE'));
});

test('the event and checked-out commit must identify main exactly', async t => {
  for (const [change, expected] of [
    [f => { f.options.env.GITHUB_EVENT_NAME = 'pull_request'; }, 'MAIN_EVENT_REQUIRED'],
    [f => { f.options.env.GITHUB_REF = 'refs/heads/feature'; }, 'MAIN_EVENT_REQUIRED'],
    [f => { f.state.checkedOut = head; }, 'MAIN_CHECKOUT_MISMATCH'],
    [f => { f.state.mainAncestor = false; }, 'COMMIT_NOT_ON_MAIN'],
  ]) {
    const f = await fixture(t); change(f);
    await assert.rejects(selectMainEvidence(f.options), reason(expected));
  }
});

test('safe diagnostics retain the reason without exposing raw response or error text', async () => {
  const message = mainEvidenceErrorMessage(Object.assign(new Error('private server body'), { reason: 'HTTP_403' }));
  assert.match(message, /HTTP_403/); assert.match(message, /Run Checks for this exact main commit/);
  assert.doesNotMatch(message, /private server body/);
  assert.doesNotMatch(mainEvidenceErrorMessage({ reason: 'injected\ntext', message: 'private' }), /injected|private/);
  await assert.rejects(main(['dispatch']), reason('COMMAND_INVALID'));
});

test('distribution-only main commits retain their focused checks and walk to exact full source evidence', async t => {
  const f = await fixture(t), entry = f.distribute(2);
  const selected = await selectMainEvidence(f.options);
  assert.equal(selected.target.commit, entry.commit);
  assert.equal(selected.fullTarget.commit, target);
  assert.equal(selected.distribution.length, 2);
  assert.equal(selected.run.runId, 42);
  await f.download();
  const evidence = await verifyMainEvidence(f.options);
  assert.equal(evidence.source.checkoutCommit, checkout);
  assert.match(await fs.readFile(f.options.env.GITHUB_STEP_SUMMARY, 'utf8'), /runtime unchanged since.*2 distribution-only commits/);
});

test('the distribution ancestry walk accepts ten hops and refuses an eleventh', async t => {
  const accepted = await fixture(t); accepted.distribute(10);
  assert.equal((await selectMainEvidence(accepted.options)).distribution.length, 10);
  const rejected = await fixture(t); rejected.distribute(11);
  await assert.rejects(selectMainEvidence(rejected.options), reason('DISTRIBUTION_ANCESTRY_LIMIT'));
});

test('distribution evidence cannot waive changed runtime input, missing jobs, unrelated PRs or a failed baseline', async t => {
  const cases = [
    f => { f.entry.mode = 'full'; },
    f => { f.entry.jobs = f.entry.jobs.filter(job => job.name !== 'plan'); },
    f => { f.entry.jobs[1].conclusion = 'skipped'; },
    f => { f.entry.run.conclusion = 'failure'; },
    f => { f.entry.artifacts.push({ id: 999 }); },
    f => { f.entry.pr.merged = false; },
    f => { f.entry.pr.head.repo = { ...repository, id: 18 }; },
    f => { f.state.commits[f.entry.head].tree.sha = sha('f'); },
    f => { f.state.run.conclusion = 'failure'; },
  ];
  for (let index = 0; index < cases.length; index++) await t.test(`invalid distribution ${index + 1}`, async t => {
    const f = await fixture(t); f.entry = f.distribute(1); cases[index](f);
    await assert.rejects(selectMainEvidence(f.options));
    await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
  });
});

test('an updated distribution run invalidates a previously selected chain', async t => {
  const f = await fixture(t), entry = f.distribute(1); await selectMainEvidence(f.options); await f.download();
  entry.runs.push({ ...entry.run, id: 9000, created_at: '2026-10-23T01:00:00Z' });
  await assert.rejects(verifyMainEvidence(f.options), reason('EVIDENCE_CHANGED'));
});

test('new full workflows cannot omit their plan job while legacy full runs remain eligible', async t => {
  const f = await fixture(t); f.state.newWorkflow = true;
  await assert.rejects(selectMainEvidence(f.options), error => error.releaseStage === 'jobs');
  f.state.jobs.push({ id: 500, name: 'plan', run_id: 42, run_attempt: 1, status: 'completed', conclusion: 'success' });
  await selectMainEvidence(f.options); await f.download();
  assert.equal((await verifyMainEvidence(f.options)).distribution.length, 0);
});

test('a distribution gate proves its actual PR first parent without impersonating a main push', async t => {
  const f = await fixture(t), entry = f.distribute(1), merge = sha('8'), mergeTree = sha('9'), currentHead = sha('7');
  Object.assign(f.options.env, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/91/merge', GITHUB_SHA: merge });
  Object.assign(f.state, { checkedOut: merge, checkoutTree: mergeTree, mergeParents: [entry.commit, currentHead] });
  const selected = await main(['select-base'], f.options);
  assert.equal(selected.scope, 'base'); assert.equal(selected.target.commit, entry.commit);
  assert.equal(selected.fullTarget.commit, target);
  await f.download(); assert.equal((await main(['verify-base'], f.options)).runId, 42);
  assert.equal(f.options.env.GITHUB_EVENT_NAME, 'pull_request');
  assert.ok(!f.requests.some(route => route.includes(currentHead) || route.includes(merge)));
  assert.match(await fs.readFile(f.options.env.GITHUB_STEP_SUMMARY, 'utf8'), /PR base commit/);
});

test('PR base evidence rejects ordinary heads and failed or absent full baseline checks', async t => {
  for (const mode of ['head-ref', 'one-parent', 'failed-baseline', 'missing-baseline']) {
    const f = await fixture(t), merge = sha('8');
    Object.assign(f.options.env, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: mode === 'head-ref' ? 'refs/pull/91/head' : 'refs/pull/91/merge', GITHUB_SHA: merge });
    Object.assign(f.state, { checkedOut: merge, mergeParents: mode === 'one-parent' ? [target] : [target, sha('7')] });
    if (mode === 'failed-baseline') f.state.run.conclusion = 'failure';
    if (mode === 'missing-baseline') { f.state.pulls = []; f.state.prRuns = []; }
    await assert.rejects(main(['select-base'], f.options));
  }
});

test('Main evidence is one read-only main-push job with no draft trigger or matrix', async () => {
  const workflow = YAML.parse(await fs.readFile(new URL('../.github/workflows/main-evidence.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['evidence']);
  const job = workflow.jobs.evidence;
  assert.equal(job.strategy, undefined); assert.equal(job.needs, undefined);
  const download = job.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['artifact-ids'], '${{ steps.source.outputs.artifact_id }}');
  assert.equal(download.with['run-id'], '${{ steps.source.outputs.run_id }}');
  assert.equal(download.with['digest-mismatch'], 'error');
  assert.equal(download.with.path, '${{ runner.temp }}/${{ env.CUEFLUENT_MAIN_EVIDENCE_NAME }}/artifact');
  assert.deepEqual(job.steps.flatMap(step => step.run ? [step.run] : []), ['node tools/main-evidence.mjs select', 'node tools/main-evidence.mjs verify']);
});
