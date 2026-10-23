import fs from 'node:fs/promises';
import path from 'node:path';
import { AssertionError } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { compareBuilds, verifyBuildArchives, ARTIFACT_NAMES as ARTIFACTS, digest, decode as parse, bounded } from './ci.mjs';
import { PACKAGE_VERSION } from './packaging.mjs';

export const EXPECTED_CHECK_JOBS = Object.freeze(['guidance', 'test (ubuntu-24.04)', 'test (macos-14)', 'test (windows-2025)',
  'test (windows-2025, 2/4)', 'test (windows-2025, 3/4)', 'test (windows-2025, 4/4)',
  'client-smoke (macos-14)', 'client-smoke (windows-2025)', 'reproducibility']);
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const positive = value => Number.isSafeInteger(value) && value > 0;
function requireRelease(condition, reason = 'EVIDENCE_MISMATCH') {
  if (!condition) {
    const error = new Error(`Release candidate evidence could not be verified (${reason}).`);
    error.code = 'RELEASE_EVIDENCE_INVALID'; error.reason = reason; throw error;
  }
}
function reasonFor(error) {
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(error?.reason ?? '')) return error.reason;
  if (['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'CI_CANDIDATE_INVALID'].includes(error?.code)) return error.code;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'REQUEST_TIMEOUT';
  if (error instanceof SyntaxError) return 'INVALID_JSON';
  if (error instanceof TypeError) return 'INVALID_DATA_OR_CONNECTION';
  return 'UNEXPECTED_FAILURE';
}
async function checked(stage, operation) {
  try { return await operation(); }
  catch (cause) {
    if (cause instanceof AssertionError) throw cause;
    if (cause?.releaseStage) throw cause;
    const error = new Error(`Release candidate ${stage} verification failed.`, { cause });
    error.code = 'RELEASE_EVIDENCE_INVALID'; error.releaseStage = stage; error.reason = reasonFor(cause); throw error;
  }
}
const readBounded = file => bounded(file, 1024 * 1024);
export function releaseErrorMessage(error) {
  const stages = ['selection', 'tag', 'run', 'jobs', 'artifacts', 'source', 'api'];
  const stage = stages.includes(error?.releaseStage) ? error.releaseStage : 'selection';
  return `Release candidate ${stage} verification failed (RELEASE_EVIDENCE_INVALID; ${reasonFor(error)}).`;
}

export function createGitHubRequest({ token, fetchImpl = fetch } = {}) {
  requireRelease(typeof token === 'string' && token.length > 0, 'GITHUB_TOKEN_MISSING');
  return route => checked('api', async () => {
    requireRelease(typeof route === 'string' && route.startsWith('/repos/'), 'API_ROUTE_INVALID');
    const response = await fetchImpl(`https://api.github.com${route}`, {
      // This supported representation retains merge_commit_sha, required to
      // bind merged PR evidence to main ancestry; 2026-03-10 omits that field.
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    requireRelease(response.ok, Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? `HTTP_${response.status}` : 'HTTP_INVALID_STATUS');
    const declared = response.headers.get('content-length');
    requireRelease(declared === null || (/^[0-9]+$/.test(declared) && Number(declared) <= 4 * 1024 * 1024), 'API_RESPONSE_TOO_LARGE');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; requireRelease(size <= 4 * 1024 * 1024, 'API_RESPONSE_TOO_LARGE'); chunks.push(chunk);
    }
    return parse(Buffer.concat(chunks));
  });
}

function context({ env = process.env, git, request, fetchImpl, now = Date.now } = {}) {
  const { RELEASE_TAG: tag, CHECKS_RUN_ID: runText, GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: repositoryText, CUEFLUENT_RELEASE_ROOT: root } = env;
  requireRelease(typeof tag === 'string' && tag.startsWith('v') && PACKAGE_VERSION.exec(tag.slice(1))?.[0] === tag.slice(1), 'TAG_INVALID');
  requireRelease(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository));
  requireRelease(typeof runText === 'string' && /^[1-9][0-9]*$/.test(runText) && positive(Number(runText)));
  requireRelease(typeof repositoryText === 'string' && /^[1-9][0-9]*$/.test(repositoryText) && positive(Number(repositoryText)));
  requireRelease(typeof root === 'string' && path.isAbsolute(root));
  const runId = Number(runText), repositoryId = Number(repositoryText);
  git ??= args => execFileSync('git', args, { maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  request ??= createGitHubRequest({ token: env.GITHUB_TOKEN, fetchImpl });
  return { env, tag, repository, repositoryId, root, runId, git, request, now, api: `/repos/${repository}` };
}

async function readTag(c) {
  return checked('tag', async () => {
    const gitText = args => Buffer.from(c.git(args)).toString('utf8').trim();
    const commit = gitText(['rev-parse', '--verify', `refs/tags/${c.tag}^{commit}`]);
    const tree = gitText(['rev-parse', '--verify', `${commit}^{tree}`]);
    requireRelease(SHA.test(commit) && SHA.test(tree));
    try { c.git(['merge-base', '--is-ancestor', commit, 'origin/main']); }
    catch (cause) {
      if (cause instanceof AssertionError) throw cause;
      const error = new Error('Release tag must belong to main history.', { cause }); error.reason = 'TAG_NOT_ON_MAIN'; throw error;
    }
    const metadata = parse(Buffer.from(c.git(['show', `${commit}:package.json`])));
    requireRelease(metadata.name === 'cuefluent-notes' && metadata.version === c.tag.slice(1));
    const lockSha256 = digest(Buffer.from(c.git(['show', `${commit}:package-lock.json`])));
    const reference = await c.request(`${c.api}/git/ref/tags/${encodeURIComponent(c.tag)}`);
    requireRelease(reference?.ref === `refs/tags/${c.tag}` && SHA.test(reference.object?.sha));
    let object = reference.object; const seen = new Set();
    while (object.type === 'tag') {
      requireRelease(SHA.test(object.sha) && !seen.has(object.sha) && seen.size < 8); seen.add(object.sha);
      const annotated = await c.request(`${c.api}/git/tags/${object.sha}`);
      requireRelease(annotated?.sha === object.sha && SHA.test(annotated.object?.sha)); object = annotated.object;
    }
    requireRelease(object.type === 'commit' && object.sha === commit);
    return { name: c.tag, refSha: reference.object.sha, commit, tree, version: metadata.version, lockSha256 };
  });
}

async function list(c, route, key) {
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const value = await c.request(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    requireRelease(Array.isArray(value[key]) && value[key].length <= 100 && Number.isSafeInteger(value.total_count) && value.total_count >= 0 && value.total_count <= 2000);
    found.push(...value[key]);
    if (found.length >= value.total_count) { requireRelease(found.length === value.total_count); return found; }
    requireRelease(value[key].length > 0);
  }
  requireRelease(false);
}

export async function inspectChecksRun(c) {
  return checked('run', async () => {
    const workflow = await c.request(`${c.api}/actions/workflows/ci.yml`);
    requireRelease(positive(workflow.id) && workflow.path === '.github/workflows/ci.yml');
    const run = await c.request(`${c.api}/actions/runs/${c.runId}`);
    // Run paths may include an @ref suffix; workflow metadata paths do not.
    const runPath = typeof run.path === 'string' ? run.path.split('@', 1)[0] : null;
    requireRelease(run.id === c.runId && run.workflow_id === workflow.id && runPath === workflow.path &&
      run.repository?.id === c.repositoryId && run.repository?.full_name === c.repository &&
      run.head_repository?.id === c.repositoryId && run.head_repository?.full_name === c.repository &&
      run.status === 'completed' && run.conclusion === 'success' && positive(run.run_attempt) && SHA.test(run.head_sha) &&
      ['pull_request', 'workflow_dispatch'].includes(run.event), 'CHECKS_RUN_INVALID');
    if (run.event !== 'pull_request') requireRelease(run.head_branch === 'main' || (c.tag && run.head_branch === c.tag), 'CHECKS_REF_INVALID');
    const jobs = await checked('jobs', async () => {
      const history = await list(c, `${c.api}/actions/runs/${c.runId}/jobs?filter=all`, 'jobs');
      requireRelease(new Set(history.map(job => job.id)).size === history.length);
      for (const job of history) requireRelease(positive(job.id) && job.run_id === c.runId && EXPECTED_CHECK_JOBS.includes(job.name) &&
        positive(job.run_attempt) && job.run_attempt <= run.run_attempt);
      return EXPECTED_CHECK_JOBS.map(name => {
        const matches = history.filter(job => job.name === name).sort((a, b) => b.run_attempt - a.run_attempt);
        requireRelease(matches.length > 0 && new Set(matches.map(job => job.run_attempt)).size === matches.length);
        const latest = matches[0]; requireRelease(latest.status === 'completed' && latest.conclusion === 'success');
        return { id: latest.id, name, runAttempt: latest.run_attempt };
      });
    });
    const artifacts = await checked('artifacts', async () => {
      const values = await list(c, `${c.api}/actions/runs/${c.runId}/artifacts`, 'artifacts');
      requireRelease(values.length === ARTIFACTS.length && new Set(values.map(item => item.name)).size === ARTIFACTS.length);
      const selected = ARTIFACTS.map(name => {
        const item = values.find(value => value.name === name), source = item?.workflow_run;
        requireRelease(positive(item?.id) && item.expired === false && positive(item.size_in_bytes) &&
          typeof item.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(item.digest) &&
          Number.isFinite(Date.parse(item.expires_at)) && Date.parse(item.expires_at) > c.now() &&
          source?.id === c.runId && source.repository_id === c.repositoryId && source.head_repository_id === c.repositoryId &&
          source.head_sha === run.head_sha && source.head_branch === run.head_branch);
        return { id: item.id, name, digest: item.digest, bytes: item.size_in_bytes, expiresAt: item.expires_at };
      });
      requireRelease(new Set(selected.map(item => item.id)).size === ARTIFACTS.length);
      return selected;
    });
    return { repository: c.repository, repositoryId: c.repositoryId, workflowId: workflow.id, runId: c.runId,
      runAttempt: run.run_attempt, event: run.event, headSha: run.head_sha, headBranch: run.head_branch, jobs, artifacts };
  });
}

export async function selectReleaseCandidate(options = {}) {
  return checked('selection', async () => {
    const c = context(options), tag = await readTag(c), run = await inspectChecksRun(c);
    if (run.event !== 'pull_request') requireRelease(run.headSha === tag.commit, 'CHECKS_COMMIT_MISMATCH');
    await fs.mkdir(c.root);
    const snapshot = { schema: 1, tag, run };
    await fs.writeFile(path.join(c.root, 'selection.json'), json(snapshot), { flag: 'wx' });
    if (c.env.GITHUB_OUTPUT) await fs.appendFile(c.env.GITHUB_OUTPUT,
      `artifact_ids=${run.artifacts.map(item => item.id).join(',')}\nrun_id=${run.runId}\n`);
    return snapshot;
  });
}

export async function verifyBuildSource(c, source, receiptBytes, tag, run, cache = new Map()) {
  requireRelease(source?.schema === 1 && source.repository === c.repository && source.repositoryId === c.repositoryId &&
    source.runId === c.runId && positive(source.runAttempt) && source.runAttempt <= run.runAttempt && source.event === run.event &&
    source.headSha === run.headSha && SHA.test(source.checkoutCommit) && source.checkoutTree === tag.tree &&
    HASH.test(source.receiptSha256) && source.receiptSha256 === digest(receiptBytes), 'SOURCE_BINDING_INVALID');
  const commit = async sha => {
    if (!cache.has(sha)) cache.set(sha, await c.request(`${c.api}/git/commits/${sha}`));
    const value = cache.get(sha); requireRelease(value?.sha === sha && SHA.test(value.tree?.sha)); return value;
  };
  const checkout = await commit(source.checkoutCommit);
  requireRelease(checkout.tree.sha === tag.tree);
  if (run.event === 'pull_request') {
    requireRelease(positive(source.pullRequest) && checkout.parents?.length === 2 && checkout.parents[1]?.sha === run.headSha);
    const head = await commit(run.headSha); requireRelease(head.tree.sha === tag.tree);
    const key = `pr:${source.pullRequest}`;
    if (!cache.has(key)) cache.set(key, await c.request(`${c.api}/pulls/${source.pullRequest}`));
    const pr = cache.get(key);
    requireRelease(pr?.number === source.pullRequest && pr.merged === true && pr.state === 'closed' &&
      pr.base?.ref === 'main' && pr.base.repo?.id === c.repositoryId && pr.base.repo?.full_name === c.repository &&
      pr.head?.sha === run.headSha && pr.head.repo?.id === c.repositoryId && pr.head.repo?.full_name === c.repository, 'PR_IDENTITY_INVALID');
    requireRelease(SHA.test(pr.merge_commit_sha), 'PR_MERGE_SHA_MISSING');
    try { c.git(['merge-base', '--is-ancestor', pr.merge_commit_sha, tag.commit]); }
    catch (cause) {
      if (cause instanceof AssertionError) throw cause;
      const error = new Error('Merged PR must belong to release history.', { cause }); error.reason = 'PR_NOT_IN_RELEASE_HISTORY'; throw error;
    }
  } else requireRelease(source.pullRequest === null && source.checkoutCommit === tag.commit && run.headSha === tag.commit, 'SOURCE_COMMIT_MISMATCH');
  return { pullRequest: source.pullRequest, checkoutCommit: source.checkoutCommit, checkoutTree: source.checkoutTree, headSha: source.headSha };
}

export async function verifyReleaseCandidate(options = {}) {
  return checked('source', async () => {
    const c = context(options), selected = parse(await readBounded(path.join(c.root, 'selection.json')));
    requireRelease(selected.schema === 1 && selected.tag?.name === c.tag && selected.run?.runId === c.runId &&
      selected.run?.repository === c.repository && selected.run.repositoryId === c.repositoryId, 'SELECTION_BINDING_INVALID');
    const { tag, run } = selected;
    requireRelease(SHA.test(tag.refSha) && SHA.test(tag.commit) && SHA.test(tag.tree) &&
      tag.version === c.tag.slice(1) && HASH.test(tag.lockSha256) && SHA.test(run.headSha) &&
      positive(run.runAttempt) && positive(run.workflowId) && ['pull_request', 'workflow_dispatch'].includes(run.event), 'SELECTION_IDENTITY_INVALID');
    if (run.event === 'workflow_dispatch') requireRelease((run.headBranch === 'main' || run.headBranch === c.tag) &&
      run.headSha === tag.commit, 'SELECTION_COMMIT_INVALID');
    // Consume the captured selection, then revalidate it once immediately before
    // output. Artifact names come from the fixed allowlist, never the selection.
    requireRelease(Array.isArray(run.artifacts) && run.artifacts.length === ARTIFACTS.length &&
      ARTIFACTS.every((name, index) => run.artifacts[index]?.name === name && positive(run.artifacts[index].id)), 'SELECTION_ARTIFACTS_INVALID');
    const artifactsRoot = path.join(c.root, 'artifacts');
    for (const directory of [artifactsRoot, ...ARTIFACTS.map(name => path.join(artifactsRoot, name))]) {
      const stat = await fs.lstat(directory); requireRelease(stat.isDirectory() && !stat.isSymbolicLink());
    }
    const { verified } = await compareBuilds(artifactsRoot, { includeVerified: true });
    let origin; const cache = new Map(), attempts = [];
    for (const artifact of run.artifacts) {
      const artifactRoot = path.join(artifactsRoot, artifact.name);
      const { build, bytes } = verified[artifact.name];
      requireRelease(build.version === tag.version && build.sourceLockSha256 === tag.lockSha256, 'BUILD_IDENTITY_MISMATCH');
      const source = parse(await readBounded(path.join(artifactRoot, 'source.json')));
      const verifiedSource = await verifyBuildSource(c, source, bytes, tag, run, cache);
      if (origin) requireRelease(same(origin, verifiedSource), 'PLATFORM_SOURCE_MISMATCH'); else origin = verifiedSource;
      attempts.push({ artifactId: artifact.id, runAttempt: source.runAttempt });
    }
    // Revalidate immediately before making a candidate available: reruns, tag moves,
    // artifact replacement or expiration require a new explicit selection.
    requireRelease(same(tag, await readTag(c)) && same(run, await inspectChecksRun(c)), 'EVIDENCE_CHANGED');
    const primary = path.join(artifactsRoot, ARTIFACTS[0]), { build, bytes } = verified[ARTIFACTS[0]];
    const output = path.join(c.root, 'candidate'); await fs.mkdir(output);
    for (const file of ['build.json', ...build.packages.flatMap(item => item.archives.map(archive => archive.path)), ...build.tools.map(archive => archive.path)]) {
      await fs.copyFile(path.join(primary, file), path.join(output, file), fs.constants.COPYFILE_EXCL);
    }
    const copied = await verifyBuildArchives(output);
    requireRelease(copied.bytes.equals(bytes), 'OUTPUT_RECEIPT_CHANGED');
    const evidence = { schema: 1, tag, run, source: origin, artifactAttempts: attempts, receiptSha256: digest(bytes) };
    await fs.writeFile(path.join(output, 'release-evidence.json'), json(evidence), { flag: 'wx' });
    return evidence;
  });
}

export async function main(args, options = {}) {
  requireRelease(args.length === 1 && ['select', 'verify'].includes(args[0]));
  return args[0] === 'select' ? selectReleaseCandidate(options) : verifyReleaseCandidate(options);
}
if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(releaseErrorMessage(error));
    process.exitCode = 1;
  }
}
