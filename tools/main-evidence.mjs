import { AssertionError } from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_NAMES, bounded, decode } from './ci.mjs';
import { PACKAGE_VERSION } from './packaging.mjs';
import { createGitHubRequest, inspectChecksRun, verifyBuildSource, checksRequirePlan } from './release-candidate.mjs';
import { classifyCIChanges } from './ci-plan.mjs';
import { createGitRunner } from './git.mjs';

const SHA = /^[a-f0-9]{40}$/;
const MAX_DISTRIBUTION_HOPS = 10;
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const versionTag = value => typeof value === 'string' && value.startsWith('v') && PACKAGE_VERSION.exec(value.slice(1))?.[0] === value.slice(1);
function requireEvidence(condition, reason) {
  if (!condition) {
    const error = new Error(`Main evidence could not be verified (${reason}).`);
    error.code = 'MAIN_EVIDENCE_INVALID'; error.reason = reason; throw error;
  }
}

function context({ env = process.env, git, request, fetchImpl, now = Date.now, repoRoot = process.cwd(), classify = classifyCIChanges, base = false } = {}) {
  const { GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: repositoryText, GITHUB_SHA: commit,
    CUEFLUENT_MAIN_EVIDENCE_ROOT: root } = env;
  requireEvidence(base ? env.GITHUB_EVENT_NAME === 'pull_request' && /^refs\/pull\/[1-9][0-9]*\/merge$/.test(env.GITHUB_REF ?? '') :
    ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) && env.GITHUB_REF === 'refs/heads/main', base ? 'PR_EVENT_REQUIRED' : 'MAIN_EVENT_REQUIRED');
  requireEvidence(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'REPOSITORY_INVALID');
  requireEvidence(typeof repositoryText === 'string' && /^[1-9][0-9]*$/.test(repositoryText) && positive(Number(repositoryText)), 'REPOSITORY_ID_INVALID');
  requireEvidence(SHA.test(commit ?? '') && typeof root === 'string' && path.isAbsolute(root), 'MAIN_CONTEXT_INVALID');
  git ??= createGitRunner(repoRoot);
  request ??= createGitHubRequest({ token: env.GITHUB_TOKEN, fetchImpl });
  return { env, repository, repositoryId: Number(repositoryText), commit, root, git, request, now, repoRoot, classify, base, api: `/repos/${repository}` };
}

function readTarget(c) {
  const text = args => Buffer.from(c.git(args)).toString('utf8').trim();
  let commit = text(['rev-parse', '--verify', 'HEAD']), tree = text(['rev-parse', '--verify', 'HEAD^{tree}']);
  requireEvidence(commit === c.commit && SHA.test(tree), 'MAIN_CHECKOUT_MISMATCH');
  if (c.base) {
    const parents = text(['show', '-s', '--format=%P', 'HEAD']).split(' ');
    requireEvidence(parents.length === 2 && parents.every(parent => SHA.test(parent)), 'PR_MERGE_CHECKOUT_REQUIRED');
    commit = parents[0]; tree = text(['rev-parse', '--verify', `${commit}^{tree}`]);
    requireEvidence(SHA.test(tree), 'BASE_TREE_INVALID');
  }
  try { c.git(['merge-base', '--is-ancestor', commit, 'origin/main']); }
  catch (cause) {
    if (cause instanceof AssertionError) throw cause;
    const error = new Error('The inspected commit must belong to main history.', { cause });
    error.reason = 'COMMIT_NOT_ON_MAIN'; throw error;
  }
  return { commit, tree };
}

async function runsFor(c, event, headSha, pullRequest) {
  // Do not filter by success: a newer failed, pending or skipped run must not be
  // hidden by a historical green run of the same revision.
  const page = await c.request(`${c.api}/actions/workflows/ci.yml/runs?event=${event}&head_sha=${headSha}&per_page=100&page=1`);
  requireEvidence(Array.isArray(page?.workflow_runs) && Number.isSafeInteger(page.total_count) &&
    page.total_count >= 0 && page.total_count <= 100 && page.workflow_runs.length === page.total_count, 'RUN_SEARCH_LIMIT_OR_SHAPE');
  return page.workflow_runs.flatMap(run => {
    requireEvidence(positive(run?.id) && run.event === event && run.head_sha === headSha && Number.isFinite(Date.parse(run.created_at)), 'RUN_SEARCH_BINDING');
    if (event === 'workflow_dispatch' && run.head_branch !== 'main' && !versionTag(run.head_branch)) return [];
    requireEvidence(typeof run.head_branch === 'string', 'RUN_BRANCH_INVALID');
    return [{ id: run.id, event, headSha, headBranch: run.head_branch, pullRequest, createdAt: run.created_at }];
  });
}

async function latestRun(c, target) {
  const [candidates, pulls] = await Promise.all([
    runsFor(c, 'workflow_dispatch', target.commit, null),
    c.request(`${c.api}/commits/${target.commit}/pulls?per_page=100&page=1`),
  ]);
  requireEvidence(Array.isArray(pulls) && pulls.length < 100, 'PR_SEARCH_LIMIT_OR_SHAPE');
  const matches = pulls.filter(pr => pr?.state === 'closed' && pr.merge_commit_sha === target.commit && pr.base?.ref === 'main' &&
    pr.base.repo?.id === c.repositoryId && pr.base.repo?.full_name === c.repository &&
    pr.head?.repo?.id === c.repositoryId && pr.head.repo?.full_name === c.repository);
  requireEvidence(matches.length <= 5, 'PR_SEARCH_LIMIT_OR_SHAPE');
  for (const pr of matches) requireEvidence(positive(pr.number) && SHA.test(pr.head?.sha ?? ''), 'PR_SEARCH_BINDING');
  const matchedRuns = await Promise.all(matches.map(pr => runsFor(c, 'pull_request', pr.head.sha, pr.number)));
  for (const runs of matchedRuns) {
    candidates.push(...runs);
  }
  requireEvidence(candidates.length > 0, 'CHECKS_EVIDENCE_MISSING');
  requireEvidence(new Set(candidates.map(run => run.id)).size === candidates.length, 'RUN_SEARCH_AMBIGUOUS');
  candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id);
  return candidates[0];
}

function selectedContext(c, candidate) {
  requireEvidence(positive(candidate?.id), 'SELECTION_RUN_INVALID');
  return { ...c, runId: candidate.id, tag: versionTag(candidate.headBranch) ? candidate.headBranch : undefined };
}

async function distributionParent(c, target, candidate) {
  const [pr, head] = await Promise.all([
    c.request(`${c.api}/pulls/${candidate.pullRequest}`), c.request(`${c.api}/git/commits/${candidate.headSha}`),
  ]);
  requireEvidence(pr?.number === candidate.pullRequest && pr.merged === true && pr.state === 'closed' && pr.merge_commit_sha === target.commit &&
    pr.base?.ref === 'main' && pr.base.repo?.id === c.repositoryId && pr.base.repo?.full_name === c.repository &&
    pr.head?.sha === candidate.headSha && pr.head.repo?.id === c.repositoryId && pr.head.repo?.full_name === c.repository, 'DISTRIBUTION_PR_INVALID');
  requireEvidence(head?.sha === candidate.headSha && head.tree?.sha === target.tree, 'DISTRIBUTION_TREE_MISMATCH');
  const parentCommit = Buffer.from(c.git(['rev-parse', '--verify', `${target.commit}^1`])).toString('utf8').trim();
  const parentTree = Buffer.from(c.git(['rev-parse', '--verify', `${parentCommit}^{tree}`])).toString('utf8').trim();
  requireEvidence(SHA.test(parentCommit) && SHA.test(parentTree), 'DISTRIBUTION_PARENT_INVALID');
  return { commit: parentCommit, tree: parentTree };
}

async function traceEvidence(c, target, expectedSelection) {
  // Cache only within this trace. Verification fetches mutable run/PR facts anew.
  const request = c.request, workflowRoute = `${c.api}/actions/workflows/ci.yml`;
  let workflow;
  c = { ...c, request: route => route === workflowRoute ? (workflow ??= request(route)) : request(route) };
  const distribution = []; let cursor = target;
  for (;;) {
    const candidate = await latestRun(c, cursor), runContext = selectedContext(c, candidate);
    if (expectedSelection) {
      const expected = expectedSelection.distribution.find(hop => hop.target.commit === cursor.commit) ??
        (expectedSelection.fullTarget.commit === cursor.commit ? expectedSelection : null);
      requireEvidence(expected && same(candidate, expected.candidate), 'EVIDENCE_CHANGED');
    }
    const requirePlan = checksRequirePlan(c, cursor.commit);
    const allowDistribution = requirePlan && candidate.event === 'pull_request';
    const run = await inspectChecksRun(runContext, { mode: allowDistribution ? 'auto' : 'full', requirePlan });
    requireEvidence(run.event === candidate.event && run.headSha === candidate.headSha && run.headBranch === candidate.headBranch, 'RUN_SELECTION_CHANGED');
    // Full artifacts remain exact-tree evidence even when the last commit of a
    // rebase-merged PR looks distribution-only. Classify only artifact-free runs.
    if (run.artifacts.length > 0) {
      const artifact = run.artifacts.find(value => value.name === ARTIFACT_NAMES[0]);
      requireEvidence(positive(artifact?.id), 'PRIMARY_ARTIFACT_MISSING');
      return { fullTarget: cursor, candidate, run, artifact, distribution };
    }
    // A PR base must leave room for the distribution commit about to be merged.
    requireEvidence(distribution.length + Number(c.base) < MAX_DISTRIBUTION_HOPS, 'DISTRIBUTION_ANCESTRY_LIMIT');
    const parent = await distributionParent(c, cursor, candidate);
    const changes = await c.classify({ repoRoot: c.repoRoot, baselineRevision: parent.commit, revision: cursor.commit, git: c.git });
    requireEvidence(changes?.mode === 'distribution' && Array.isArray(changes.changedFiles) && changes.changedFiles.length > 0,
      'DISTRIBUTION_CLASSIFICATION_INVALID');
    distribution.push({ target: cursor, parent, candidate, run, changedFileCount: changes.changedFiles.length });
    cursor = parent;
  }
}

export async function selectMainEvidence(options = {}) {
  const c = context(options), target = readTarget(c), traced = await traceEvidence(c, target);
  const selected = { schema: 1, scope: c.base ? 'base' : 'main', target, ...traced }, { artifact, run } = traced;
  await fs.mkdir(c.root);
  await fs.writeFile(path.join(c.root, 'selection.json'), `${JSON.stringify(selected, null, 2)}\n`, { flag: 'wx' });
  if (c.env.GITHUB_OUTPUT) await fs.appendFile(c.env.GITHUB_OUTPUT, `artifact_id=${artifact.id}\nrun_id=${run.runId}\n`);
  return selected;
}

export async function verifyMainEvidence(options = {}) {
  const c = context(options), selected = decode(await bounded(path.join(c.root, 'selection.json'), 1024 * 1024));
  const target = readTarget(c);
  requireEvidence(selected?.schema === 1 && selected.scope === (c.base ? 'base' : 'main') && same(selected.target, target) && selected.run?.repository === c.repository &&
    selected.run.repositoryId === c.repositoryId && selected.run.runId === selected.candidate?.id && Array.isArray(selected.run.artifacts) &&
    selected.artifact?.name === ARTIFACT_NAMES[0] && same(selected.artifact, selected.run.artifacts?.find(value => value.name === ARTIFACT_NAMES[0])) &&
    SHA.test(selected.fullTarget?.commit ?? '') && SHA.test(selected.fullTarget?.tree ?? '') && Array.isArray(selected.distribution) &&
    selected.distribution.length + Number(c.base) <= MAX_DISTRIBUTION_HOPS, 'SELECTION_BINDING_INVALID');
  const artifactRoot = path.join(c.root, 'artifact');
  for (const directory of [c.root, artifactRoot]) {
    const stat = await fs.lstat(directory);
    requireEvidence(stat.isDirectory() && !stat.isSymbolicLink(), 'EVIDENCE_DIRECTORY_INVALID');
  }
  // The pinned download action checked this immutable artifact's GitHub digest.
  // Successful reproducibility already verified all archive bytes; this job only
  // verifies the recorded source and receipt binding, never executes candidates.
  const receipt = await bounded(path.join(artifactRoot, 'build.json'), 1024 * 1024);
  const source = decode(await bounded(path.join(artifactRoot, 'source.json'), 1024 * 1024));
  requireEvidence(source?.pullRequest === selected.candidate.pullRequest, 'SOURCE_PR_MISMATCH');
  const runContext = selectedContext(c, selected.candidate);
  const origin = await verifyBuildSource(runContext, source, receipt, selected.fullTarget, selected.run);
  const { schema, scope, target: selectedTarget, ...traced } = selected;
  requireEvidence(same(target, readTarget(c)) && same(await traceEvidence(c, target, selected), traced), 'EVIDENCE_CHANGED');
  const evidence = { schema: 1, target, fullTarget: selected.fullTarget, distribution: selected.distribution,
    runId: selected.run.runId, artifactId: selected.artifact.id, source: origin };
  if (c.env.GITHUB_STEP_SUMMARY) await fs.appendFile(c.env.GITHUB_STEP_SUMMARY,
    selected.distribution.length
      ? `${c.base ? 'PR base' : 'Main'} commit \`${target.commit}\`: runtime unchanged since \`${selected.fullTarget.commit}\` (${selected.distribution.length} distribution-only commits, ${selected.distribution.reduce((count, hop) => count + hop.changedFileCount, 0)} changed files). Full evidence: [Checks ${selected.run.runId}](https://github.com/${c.repository}/actions/runs/${selected.run.runId}).\n`
      : `${c.base ? 'PR base' : 'Main'} commit \`${target.commit}\` matches the tested tree from [Checks ${selected.run.runId}](https://github.com/${c.repository}/actions/runs/${selected.run.runId}). No platform checks were repeated.\n`);
  return evidence;
}

export function mainEvidenceErrorMessage(error, { base = false } = {}) {
  const reason = /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.reason ?? '') ? error.reason :
    ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'CI_CANDIDATE_INVALID'].includes(error?.code) ? error.code : 'UNEXPECTED_FAILURE';
  const recovery = base
    ? "Refresh full Checks evidence on main for this PR's base; update the PR to that tested base if main has advanced, then rerun this PR's failed Checks job."
    : 'Run Checks for this exact main commit, then rerun Main evidence.';
  return `${base ? 'PR base' : 'Main'} evidence verification failed (MAIN_EVIDENCE_INVALID; ${reason}). ${recovery}`;
}

export async function main(args, options = {}) {
  requireEvidence(args.length === 1 && ['select', 'verify', 'select-base', 'verify-base'].includes(args[0]), 'COMMAND_INVALID');
  const selectedOptions = { ...options, base: args[0].endsWith('-base') };
  return args[0].startsWith('select') ? selectMainEvidence(selectedOptions) : verifyMainEvidence(selectedOptions);
}
if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(mainEvidenceErrorMessage(error, { base: process.argv[2]?.endsWith('-base') })); process.exitCode = 1; }
}
