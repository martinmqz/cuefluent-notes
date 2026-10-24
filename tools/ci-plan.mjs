import fs from 'node:fs/promises';
import { createGitRunner } from './git.mjs';
import { packagePath } from './packaging.mjs';

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
  const read = createGitRunner(repoRoot);
  return args => {
    try { return read(args); }
    catch { requirePlan(false, 'GIT_READ_FAILED'); }
  };
}

async function gitBytes(git, args) {
  const bytes = Buffer.from(await git(args));
  requirePlan(bytes.length <= LIMIT, 'GIT_RESPONSE_TOO_LARGE');
  return bytes;
}

async function gitText(git, args) {
  const bytes = await gitBytes(git, args);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { requirePlan(false, 'GIT_RESPONSE_INVALID'); }
}

async function commitAt(git, revision) {
  requirePlan(typeof revision === 'string' && revision.length > 0 && !revision.includes('\0'), 'REVISION_INVALID');
  const commit = (await gitText(git, ['rev-parse', '--verify', '--end-of-options', revision + '^{commit}'])).trim();
  requirePlan(SHA.test(commit), 'COMMIT_INVALID'); return commit;
}

const portablePath = value => {
  try { packagePath(value); return true; }
  catch (error) { if (error.code !== 'PACKAGE_PATH_INVALID') throw error; return false; }
};
const distributionPath = value => DISTRIBUTION_FILES.has(value) || DISTRIBUTION_ROOTS.some(root => value.startsWith(root));

/** Classify immutable tracked changes. A distribution result only selects the
 * focused marketplace checks; those checks must still validate published bytes. */
export async function classifyCIChanges({ repoRoot = process.cwd(), baselineRevision, revision = 'HEAD', git } = {}) {
  git = reader(repoRoot, git);
  const baseline = await commitAt(git, baselineRevision), commit = await commitAt(git, revision);
  // Disable rename detection so both the old and new path must be allowed. Raw
  // NUL records retain mode changes and cannot split a filename on whitespace.
  const raw = await gitBytes(git, ['diff', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', baseline, commit, '--']);
  if (!raw.length) return { mode: 'full', changedFiles: [], reason: 'EMPTY_DIFF' };
  const fields = [];
  for (let start = 0; start < raw.length;) {
    const end = raw.indexOf(0, start); requirePlan(end >= 0, 'GIT_DIFF_INVALID');
    fields.push(raw.subarray(start, end)); start = end + 1;
  }
  requirePlan(fields.length % 2 === 0, 'GIT_DIFF_INVALID');
  const files = [], seen = new Set(); let unsupported = false;
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([ADMT])$/.exec(fields[index].toString('utf8'));
    const name = fields[index + 1], identity = name.toString('hex');
    requirePlan(match && name.length > 0 && !seen.has(identity), 'GIT_DIFF_INVALID');
    let file;
    try { file = new TextDecoder('utf-8', { fatal: true }).decode(name); }
    catch { file = name.toString('utf8'); unsupported = true; }
    seen.add(identity); files.push(file);
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
    env.GITHUB_REF === 'refs/pull/' + number + '/merge' && typeof pr?.base?.ref === 'string' && pr.base.ref.length > 0 &&
    SHA.test(pr.base.sha ?? '') && SHA.test(pr?.head?.sha ?? ''), 'PR_CONTEXT_INVALID');
  const parents = (await gitText(git, ['show', '-s', '--format=%P', checkout])).trim().split(' ');
  // The event's base SHA can predate the base used for this tested merge. Its
  // first parent supplies that base; the exact checkout and PR head stay bound.
  requirePlan(parents.length === 2 && parents.every(parent => SHA.test(parent)) && parents[1] === pr.head.sha, 'PR_MERGE_MISMATCH');
  const result = await classifyCIChanges({ repoRoot, baselineRevision: parents[0], revision: checkout, git });
  // Reduced checks reuse verified main history; other targets need full checks.
  return pr.base.ref === 'main' ? result : { ...result, mode: 'full', reason: 'NON_MAIN_TARGET' };
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
