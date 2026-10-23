import { AssertionError } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_NAMES, bounded, decode } from './ci.mjs';
import { PACKAGE_VERSION } from './packaging.mjs';
import { createGitHubRequest, inspectChecksRun, verifyBuildSource } from './release-candidate.mjs';

const SHA = /^[a-f0-9]{40}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const versionTag = value => typeof value === 'string' && value.startsWith('v') && PACKAGE_VERSION.exec(value.slice(1))?.[0] === value.slice(1);
function requireEvidence(condition, reason) {
  if (!condition) {
    const error = new Error(`Main evidence could not be verified (${reason}).`);
    error.code = 'MAIN_EVIDENCE_INVALID'; error.reason = reason; throw error;
  }
}

function context({ env = process.env, git, request, fetchImpl, now = Date.now } = {}) {
  const { GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: repositoryText, GITHUB_SHA: commit,
    CUEFLUENT_MAIN_EVIDENCE_ROOT: root } = env;
  requireEvidence(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) && env.GITHUB_REF === 'refs/heads/main', 'MAIN_EVENT_REQUIRED');
  requireEvidence(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'REPOSITORY_INVALID');
  requireEvidence(typeof repositoryText === 'string' && /^[1-9][0-9]*$/.test(repositoryText) && positive(Number(repositoryText)), 'REPOSITORY_ID_INVALID');
  requireEvidence(SHA.test(commit ?? '') && typeof root === 'string' && path.isAbsolute(root), 'MAIN_CONTEXT_INVALID');
  git ??= args => execFileSync('git', args, { maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  request ??= createGitHubRequest({ token: env.GITHUB_TOKEN, fetchImpl });
  return { env, repository, repositoryId: Number(repositoryText), commit, root, git, request, now, api: `/repos/${repository}` };
}

function readTarget(c) {
  const text = args => Buffer.from(c.git(args)).toString('utf8').trim();
  const commit = text(['rev-parse', '--verify', 'HEAD']), tree = text(['rev-parse', '--verify', 'HEAD^{tree}']);
  requireEvidence(commit === c.commit && SHA.test(tree), 'MAIN_CHECKOUT_MISMATCH');
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
  const candidates = await runsFor(c, 'workflow_dispatch', target.commit, null);
  const pulls = await c.request(`${c.api}/commits/${target.commit}/pulls?per_page=100&page=1`);
  requireEvidence(Array.isArray(pulls) && pulls.length < 100, 'PR_SEARCH_LIMIT_OR_SHAPE');
  const matches = pulls.filter(pr => pr?.state === 'closed' && pr.merge_commit_sha === target.commit && pr.base?.ref === 'main' &&
    pr.base.repo?.id === c.repositoryId && pr.base.repo?.full_name === c.repository &&
    pr.head?.repo?.id === c.repositoryId && pr.head.repo?.full_name === c.repository);
  requireEvidence(matches.length <= 5, 'PR_SEARCH_LIMIT_OR_SHAPE');
  for (const pr of matches) {
    requireEvidence(positive(pr.number) && SHA.test(pr.head?.sha ?? ''), 'PR_SEARCH_BINDING');
    candidates.push(...await runsFor(c, 'pull_request', pr.head.sha, pr.number));
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

export async function selectMainEvidence(options = {}) {
  const c = context(options), target = readTarget(c), candidate = await latestRun(c, target);
  const run = await inspectChecksRun(selectedContext(c, candidate));
  requireEvidence(run.event === candidate.event && run.headSha === candidate.headSha && run.headBranch === candidate.headBranch, 'RUN_SELECTION_CHANGED');
  const artifact = run.artifacts.find(value => value.name === ARTIFACT_NAMES[0]);
  requireEvidence(positive(artifact?.id), 'PRIMARY_ARTIFACT_MISSING');
  const selected = { schema: 1, target, candidate, run, artifact };
  await fs.mkdir(c.root);
  await fs.writeFile(path.join(c.root, 'selection.json'), `${JSON.stringify(selected, null, 2)}\n`, { flag: 'wx' });
  if (c.env.GITHUB_OUTPUT) await fs.appendFile(c.env.GITHUB_OUTPUT, `artifact_id=${artifact.id}\nrun_id=${run.runId}\n`);
  return selected;
}

export async function verifyMainEvidence(options = {}) {
  const c = context(options), selected = decode(await bounded(path.join(c.root, 'selection.json'), 1024 * 1024));
  const target = readTarget(c);
  requireEvidence(selected?.schema === 1 && same(selected.target, target) && selected.run?.repository === c.repository &&
    selected.run.repositoryId === c.repositoryId && selected.run.runId === selected.candidate?.id && Array.isArray(selected.run.artifacts) &&
    selected.artifact?.name === ARTIFACT_NAMES[0] && same(selected.artifact, selected.run.artifacts?.find(value => value.name === ARTIFACT_NAMES[0])), 'SELECTION_BINDING_INVALID');
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
  const origin = await verifyBuildSource(runContext, source, receipt, target, selected.run);
  requireEvidence(same(target, readTarget(c)) && same(selected.candidate, await latestRun(c, target)) &&
    same(selected.run, await inspectChecksRun(runContext)), 'EVIDENCE_CHANGED');
  const evidence = { schema: 1, target, runId: selected.run.runId, artifactId: selected.artifact.id, source: origin };
  if (c.env.GITHUB_STEP_SUMMARY) await fs.appendFile(c.env.GITHUB_STEP_SUMMARY,
    `Main commit \`${target.commit}\` matches the tested tree from [Checks ${selected.run.runId}](https://github.com/${c.repository}/actions/runs/${selected.run.runId}). No platform checks were repeated.\n`);
  return evidence;
}

export function mainEvidenceErrorMessage(error) {
  const reason = /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.reason ?? '') ? error.reason :
    ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'CI_CANDIDATE_INVALID'].includes(error?.code) ? error.code : 'UNEXPECTED_FAILURE';
  return `Main evidence verification failed (MAIN_EVIDENCE_INVALID; ${reason}). Run Checks for this exact main commit, then rerun Main evidence.`;
}

export async function main(args, options = {}) {
  requireEvidence(args.length === 1 && ['select', 'verify'].includes(args[0]), 'COMMAND_INVALID');
  return args[0] === 'select' ? selectMainEvidence(options) : verifyMainEvidence(options);
}
if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(mainEvidenceErrorMessage(error)); process.exitCode = 1; }
}
