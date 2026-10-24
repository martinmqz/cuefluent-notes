import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

const SHA = /^[a-f0-9]{40}$/;
const LIMIT = 8 * 1024 * 1024;
const DISTRIBUTION_FILES = new Set([
  'release.json', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
  'test/marketplace.test.mjs', 'test/support/marketplace.mjs', 'AGENTS.md',
  '.github/copilot-instructions.md',
]);
const DISTRIBUTION_ROOTS = [
  'plugins/', 'claude/', 'packaging/releases/', '.agents/', '.cursor/rules/', '.github/instructions/',
];
const requirePlan = (condition, reason) => {
  if (!condition) {
    const error = new Error('CI plan verification failed.');
    error.code = 'CI_PLAN_INVALID'; error.reason = reason; throw error;
  }
};

function reader(repoRoot, git) {
  if (git) return git;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' });
  return args => {
    try { return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: repoRoot, env, maxBuffer: LIMIT, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { requirePlan(false, 'GIT_READ_FAILED'); }
  };
}

async function gitText(git, args) {
  const bytes = Buffer.from(await git(args));
  requirePlan(bytes.length <= LIMIT, 'GIT_RESPONSE_TOO_LARGE');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { requirePlan(false, 'GIT_RESPONSE_INVALID'); }
}

async function commitAt(git, revision) {
  requirePlan(typeof revision === 'string' && revision.length > 0 && !revision.includes('\0'), 'REVISION_INVALID');
  const commit = (await gitText(git, ['rev-parse', '--verify', '--end-of-options', revision + '^{commit}'])).trim();
  requirePlan(SHA.test(commit), 'COMMIT_INVALID'); return commit;
}

const portablePath = value => value.length > 0 && !/[\\:\u0000-\u001f\u007f]/u.test(value) &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const distributionPath = value => DISTRIBUTION_FILES.has(value) || DISTRIBUTION_ROOTS.some(root => value.startsWith(root));

/** Classify immutable tracked changes. A distribution result only selects the
 * focused marketplace checks; those checks must still validate published bytes. */
export async function classifyCIChanges({ repoRoot = process.cwd(), baselineRevision, revision = 'HEAD', git } = {}) {
  git = reader(repoRoot, git);
  const baseline = await commitAt(git, baselineRevision), commit = await commitAt(git, revision);
  // Disable rename detection so both the old and new path must be allowed. Raw
  // NUL records retain mode changes and cannot split a filename on whitespace.
  const raw = await gitText(git, ['diff', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', baseline, commit, '--']);
  if (!raw) return { mode: 'full', changedFiles: [], reason: 'EMPTY_DIFF' };
  const fields = raw.split('\0'); requirePlan(fields.pop() === '' && fields.length % 2 === 0, 'GIT_DIFF_INVALID');
  const files = [], seen = new Set(); let unsupported = false;
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([ADMT])$/.exec(fields[index]);
    const file = fields[index + 1]; requirePlan(match && !seen.has(file), 'GIT_DIFF_INVALID');
    seen.add(file); files.push(file);
    const [, before, after, beforeSha, afterSha, status] = match;
    const ordinary = mode => ['100644', '100755'].includes(mode);
    const absent = (mode, sha) => mode === '000000' && /^0+$/.test(sha);
    const present = (mode, sha) => ordinary(mode) && !/^0+$/.test(sha);
    const modes = status === 'A' ? absent(before, beforeSha) && present(after, afterSha)
      : status === 'D' ? present(before, beforeSha) && absent(after, afterSha)
        : status === 'M' && present(before, beforeSha) && present(after, afterSha);
    if (!portablePath(file) || !modes) unsupported = true;
  }
  const changedFiles = files.sort();
  if (unsupported) return { mode: 'full', changedFiles, reason: 'UNSUPPORTED_FILE_ENTRY' };
  if (!changedFiles.every(distributionPath)) return { mode: 'full', changedFiles, reason: 'FULL_CHECK_INPUT_CHANGED' };
  return { mode: 'distribution', changedFiles, reason: 'DISTRIBUTION_ONLY' };
}

async function readEvent(file) {
  requirePlan(typeof file === 'string' && file.length > 0, 'EVENT_PATH_MISSING');
  const stat = await fs.lstat(file);
  requirePlan(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'EVENT_FILE_INVALID');
  const bytes = await fs.readFile(file);
  requirePlan(bytes.length === stat.size && bytes.length <= 1024 * 1024, 'EVENT_FILE_INVALID');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { requirePlan(false, 'EVENT_FILE_INVALID'); }
}

async function eventPlan({ repoRoot = process.cwd(), env = process.env, git } = {}) {
  git = reader(repoRoot, git);
  const checkout = await commitAt(git, 'HEAD');
  requirePlan(SHA.test(env.GITHUB_SHA ?? '') && checkout === env.GITHUB_SHA, 'CHECKOUT_MISMATCH');
  requirePlan(['pull_request', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'EVENT_UNSUPPORTED');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') return { mode: 'full', changedFiles: [], reason: 'MANUAL_RUN' };
  const event = await readEvent(env.GITHUB_EVENT_PATH), pr = event?.pull_request;
  const number = event?.number;
  requirePlan(Number.isSafeInteger(number) && number > 0 && pr?.number === number &&
    env.GITHUB_REF === 'refs/pull/' + number + '/merge' && SHA.test(pr?.base?.sha ?? '') && SHA.test(pr?.head?.sha ?? ''), 'PR_CONTEXT_INVALID');
  const parents = (await gitText(git, ['show', '-s', '--format=%P', checkout])).trim().split(' ');
  // The event's base SHA can predate the base used for this tested merge. Its
  // first parent supplies that base; the exact checkout and PR head stay bound.
  requirePlan(parents.length === 2 && parents.every(parent => SHA.test(parent)) && parents[1] === pr.head.sha, 'PR_MERGE_MISMATCH');
  return classifyCIChanges({ repoRoot, baselineRevision: parents[0], revision: checkout, git });
}

export async function main(args, options = {}) {
  requirePlan(args.length === 1 && ['plan', 'verify'].includes(args[0]), 'COMMAND_INVALID');
  const env = options.env ?? process.env, result = await eventPlan(options);
  if (args[0] === 'verify') requirePlan(env.CUEFLUENT_CI_MODE === result.mode, 'PLAN_MODE_MISMATCH');
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, 'mode=' + result.mode + '\n');
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY,
    'CI mode: **' + result.mode + '** (' + result.reason + '; ' + result.changedFiles.length + ' changed files).\n');
  return result;
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    const reason = error?.code === 'CI_PLAN_INVALID' ? error.reason : 'UNEXPECTED_FAILURE';
    console.error('CI plan failed (CI_PLAN_INVALID; ' + reason + ').'); process.exitCode = 1;
  }
}
