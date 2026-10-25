import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { verifyBuildArchives, compareBuilds, ARTIFACT_NAMES } from '../tools/ci.mjs';
import { EXPECTED_CHECK_JOBS } from '../tools/release-candidate.mjs';
import { packageSource } from './fixtures/package-source.mjs';
import { createGitRunner } from '../tools/git.mjs';
import YAML from 'yaml';

const exec = promisify(execFile);
const checks = async () => YAML.parse(await fs.readFile(path.resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8'));

test('native shards and client smoke run in parallel after classification and retain required names', async () => {
  const workflow = await checks(), { plan, guidance, test: source, 'client-smoke': smoke, reproducibility } = workflow.jobs;
  const checkout = plan.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['fetch-depth'], 2);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(reproducibility.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
  for (const job of [plan, guidance, source, smoke]) assert.equal(job.permissions, undefined);
  for (const job of [plan, guidance]) assert.equal(job.needs, undefined);
  for (const job of [source, smoke]) assert.equal(job.needs, 'plan');
  for (const job of [source, smoke]) {
    assert.equal(job.strategy['fail-fast'], false);
    assert.equal(job.strategy['max-parallel'], undefined);
  }
  const rows = source.strategy.matrix.include, names = new Set([plan.name ?? 'plan', guidance.name ?? 'guidance', reproducibility.name]);
  for (const [platform, count] of [['ubuntu-24.04', 1], ['macos-14', 1], ['windows-2025', 4]]) {
    const selected = rows.filter(row => row.os === platform);
    assert.deepEqual(selected.map(row => row.shard).sort(), Array.from({ length: count }, (_, index) => `${index + 1}/${count}`));
    assert.equal(selected.filter(row => row.primary).length, 1);
    assert.equal(selected.find(row => row.primary).suffix, '');
    for (const row of selected) names.add(source.name.replace('${{ matrix.os }}', row.os).replace('${{ matrix.suffix }}', row.suffix));
  }
  assert.equal(rows.length, 6);
  for (const platform of smoke.strategy.matrix.os) names.add(smoke.name.replace('${{ matrix.os }}', platform));
  assert.deepEqual([...names].sort(), [...EXPECTED_CHECK_JOBS].sort(), 'Release evidence must require every workflow job.');
  for (const required of ['plan', 'guidance', 'test (ubuntu-24.04)', 'test (macos-14)', 'test (windows-2025)', 'client-smoke (macos-14)', 'client-smoke (windows-2025)', 'reproducibility']) assert(names.has(required), `Missing required context: ${required}`);
  assert.deepEqual(reproducibility.needs, ['plan', 'guidance', 'test', 'client-smoke']);
  for (const step of source.steps.filter(step => step.run === 'npm run check:examples' || step.run === 'node tools/ci.mjs build' || step.uses?.startsWith('actions/upload-artifact@'))) assert.equal(step.if, "needs.plan.outputs.mode == 'full' && matrix.primary");
  const upload = source.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.deepEqual(rows.filter(row => row.primary).map(row => upload.with.name.replace('${{ matrix.os }}', row.os)), ARTIFACT_NAMES);
  const download = reproducibility.steps.find(step => step.uses?.startsWith('actions/download-artifact@') && step.if === "needs.plan.outputs.mode == 'full'");
  assert.equal(download.with.pattern, 'candidate-*');
  assert(ARTIFACT_NAMES.every(name => name.startsWith(download.with.pattern.slice(0, -1))));
  assert.equal(download.with.path, reproducibility.steps.find(step => step.run === 'node tools/ci.mjs compare').env.CUEFLUENT_ARTIFACT_ROOT);
  assert(smoke.steps.some(step => step.run === 'node tools/client-smoke.mjs'));
  assert(!source.steps.some(step => /client-smoke/.test(step.run ?? '')));
});

test('draft PRs allocate no job runners and ready PRs retain parallel checks and the failure gate', async () => {
  const workflow = await checks();
  const admitted = (job, { event = 'pull_request', action, draft, cancelled = false } = {}) => {
    assert.match(job.if, /^\$\{\{[\s\S]*\}\}$/);
    return runInNewContext(job.if.slice(3, -2), {
      github: { event_name: event, event: { action, ...(draft === undefined ? {} : { pull_request: { draft } }) } },
      always: () => true,
      cancelled: () => cancelled,
      // The final gate must still run when an upstream check fails.
      success: () => false,
    });
  };
  for (const action of ['opened', 'synchronize', 'reopened', 'converted_to_draft']) {
    assert(workflow.on.pull_request.types.includes(action));
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.equal(admitted(job, { action, draft: true }), false, `${name} must not start for draft ${action}`);
    }
  }
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    assert(workflow.on.pull_request.types.includes(action));
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.equal(admitted(job, { action, draft: false }), true, `${name} must start for ready ${action}`);
    }
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(admitted(job, { event: 'workflow_dispatch' }), true, `${name} must allow explicit manual checks`);
  }
  assert.equal(admitted(workflow.jobs.reproducibility, { draft: false, cancelled: true }), false);
  // Redrafting enters the same concurrency group and cancels the active PR run.
  assert.equal(workflow.concurrency.group, 'checks-${{ github.event_name }}-${{ github.ref }}');
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('the final gate rejects failed, skipped or cancelled source shards and client smoke', async () => {
  const gate = (await checks()).jobs.reproducibility.steps.find(step => step.env?.TEST_RESULT);
  const script = /<<'NODE'\n([\s\S]*?)\nNODE\s*$/.exec(gate.run)?.[1]; assert.ok(script);
  const valid = { PLAN_RESULT: 'success', PLAN_MODE: 'full', TEST_RESULT: 'success', GUIDANCE_RESULT: 'success', CLIENT_SMOKE_RESULT: 'success' };
  await exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...valid } });
  await exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...valid, PLAN_MODE: 'distribution' } });
  for (const key of Object.keys(valid)) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...valid, [key]: result } }));
    }
  }
});

test('distribution mode tests marketplaces on all three OSes without suites, builds or native client downloads', async () => {
  const workflow = await checks(), source = workflow.jobs.test, smoke = workflow.jobs['client-smoke'];
  const enabled = (step, mode, matrix) => step.if === undefined || runInNewContext(step.if, { needs: { plan: { outputs: { mode } } }, matrix });
  for (const row of source.strategy.matrix.include) {
    const active = source.steps.filter(step => enabled(step, 'distribution', row));
    assert.equal(active.filter(step => step.run === 'node --test test/marketplace.test.mjs').length, row.primary ? 1 : 0);
    assert(!active.some(step => /tools\/(?:test|ci)\.mjs|npm ci/.test(step.run ?? '')));
    assert(!active.some(step => step.uses?.startsWith('actions/upload-artifact@')));
    const platform = runInNewContext(source['runs-on'].slice(3, -2), { needs: { plan: { outputs: { mode: 'distribution' } } }, matrix: row });
    assert.equal(platform, row.primary ? row.os : 'ubuntu-24.04');
    const full = source.steps.filter(step => enabled(step, 'full', row));
    assert(full.some(step => step.run?.includes('tools/test.mjs')));
    assert.equal(full.filter(step => step.run === 'node tools/ci.mjs build').length, row.primary ? 1 : 0);
  }
  assert(!smoke.steps.filter(step => enabled(step, 'distribution')).some(step => /tools\/client-smoke\.mjs|npm ci/.test(step.run ?? '')));
  assert(smoke.steps.filter(step => enabled(step, 'full')).some(step => step.run === 'node tools/client-smoke.mjs'));
  assert.equal(source.if, smoke.if, 'Both matrix jobs must expand for distribution PRs to report every required context.');
});

test('distribution gate rederives its class and requires digest-verified evidence for the actual PR base', async () => {
  const workflow = await checks(), gate = workflow.jobs.reproducibility;
  const steps = gate.steps, verifyClass = steps.findIndex(step => step.env?.CUEFLUENT_CI_ACTION === 'verify');
  const select = steps.findIndex(step => step.run === 'node tools/main-evidence.mjs select-base');
  const verify = steps.findIndex(step => step.run === 'node tools/main-evidence.mjs verify-base');
  assert(verifyClass >= 0 && select > verifyClass && verify > select);
  assert.equal(steps[verifyClass].env.CUEFLUENT_CI_MODE, '${{ needs.plan.outputs.mode }}');
  assert.equal(steps[verifyClass].run, workflow.jobs.plan.steps.find(step => step.env?.CUEFLUENT_CI_ACTION === 'plan').run);
  const download = steps.slice(select, verify).find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['artifact-ids'], '${{ steps.base.outputs.artifact_id }}');
  assert.equal(download.with['run-id'], '${{ steps.base.outputs.run_id }}');
  assert.equal(download.with['digest-mismatch'], 'error');
  for (const step of [steps[select], download, steps[verify]]) assert.equal(step.if, "needs.plan.outputs.mode == 'distribution'");
  assert.equal(steps.find(step => step.run === 'node tools/ci.mjs compare').if, "needs.plan.outputs.mode == 'full'");
  assert.equal(steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0);
});

test('planning and the gate execute base policy even when the PR replaces its classifier', async t => {
  const workflow = await checks(), step = workflow.jobs.plan.steps.find(step => step.env?.CUEFLUENT_CI_ACTION === 'plan');
  const script = /<<'NODE'\n([\s\S]*?)\nNODE\s*$/.exec(step.run)?.[1]; assert.ok(script);
  for (const baseHasPolicy of [true, false]) await t.test(baseHasPolicy ? 'base policy' : 'bootstrap full checks', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-policy-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo'); await fs.mkdir(path.join(repo, 'tools'), { recursive: true });
    const readGit = createGitRunner(repo), git = args => readGit(args).toString().trim();
    git(['init', '-b', 'main', '--template=']); git(['config', 'user.name', 'Synthetic Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(path.join(repo, 'README.md'), 'Synthetic base\n');
    if (baseHasPolicy) for (const file of ['ci-plan.mjs', 'git.mjs', 'packaging.mjs']) {
      await fs.copyFile(new URL(`../tools/${file}`, import.meta.url), path.join(repo, 'tools', file));
    }
    git(['add', '.']); git(['commit', '-m', 'Synthetic base']); const base = git(['rev-parse', 'HEAD']);
    git(['switch', '-c', 'feature']);
    await fs.writeFile(path.join(repo, 'tools', 'ci-plan.mjs'), "import fs from 'node:fs'; fs.writeFileSync(process.env.CUEFLUENT_POLICY_MARKER, 'PR policy ran'); fs.appendFileSync(process.env.GITHUB_OUTPUT, 'mode=distribution\\n');\n");
    git(['add', '.']); git(['commit', '-m', 'Synthetic classifier replacement']); const head = git(['rev-parse', 'HEAD']);
    git(['switch', 'main']); git(['merge', '--no-ff', 'feature', '-m', 'Synthetic merge']);
    const event = path.join(root, 'event.json');
    await fs.writeFile(event, JSON.stringify({ number: 43, pull_request: { number: 43, base: { ref: 'main', sha: base }, head: { sha: head } } }));
    const env = { ...process.env, GITHUB_SHA: git(['rev-parse', 'HEAD']), GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main',
      GITHUB_REF: 'refs/pull/43/merge', GITHUB_EVENT_PATH: event, RUNNER_TEMP: root,
      GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_STEP_SUMMARY: path.join(root, 'summary'), CUEFLUENT_POLICY_MARKER: path.join(root, 'marker') };
    const run = patch => exec(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env: { ...env, ...patch } });
    await run({ CUEFLUENT_CI_ACTION: 'plan' });
    assert.equal(await fs.readFile(env.GITHUB_OUTPUT, 'utf8'), 'mode=full\n');
    await run({ CUEFLUENT_CI_ACTION: 'verify', CUEFLUENT_CI_MODE: 'full' });
    await assert.rejects(run({ CUEFLUENT_CI_ACTION: 'verify', CUEFLUENT_CI_MODE: 'distribution' }));
    await assert.rejects(fs.stat(env.CUEFLUENT_POLICY_MARKER), { code: 'ENOENT' });
  });
});

test('the Windows workflow weighted runner discovers each file once and propagates a shard failure', async t => {
  const workflow = await checks(), rows = workflow.jobs.test.strategy.matrix.include.filter(row => row.os === 'windows-2025');
  const step = workflow.jobs.test.steps.find(step => step.run?.includes('tools/test.mjs'));
  assert.equal(step.env.CUEFLUENT_TEST_SHARD, '${{ matrix.shard }}');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-ci-shards-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'test', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools'));
  for (const file of ['test.mjs', 'test-sharding.mjs']) await fs.copyFile(path.resolve(import.meta.dirname, '../tools', file), path.join(root, 'tools', file));
  const samples = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`test/nested/${index}.test.mjs`, { ms: (8 - index) * 100, bytes: 100 }]));
  await fs.writeFile(path.join(root, 'tools', 'ci-test-timings.json'), JSON.stringify({ version: 1, platforms: { win32: samples, darwin: samples, linux: samples } }));
  for (let index = 0; index < 8; index++) await fs.writeFile(path.join(root, 'test', 'nested', `${index}.test.mjs`), `import fs from 'node:fs';\nfs.appendFileSync(process.env.CUEFLUENT_SHARD_MARKER, '${index}\\n');\nif (process.env.CUEFLUENT_FAIL_FILE === '${index}') throw new Error('synthetic failure');\n`);
  for (const failedFile of ['', '7']) {
    const outputs = await Promise.all(rows.map(async row => {
      const marker = path.join(root, `${failedFile || 'pass'}-${row.shard.replace('/', '-')}.txt`);
      const command = step.run.replace("${{ runner.os == 'Windows' && '--test-concurrency=1' || '' }}", '--test-concurrency=1');
      assert(!command.includes('${{'));
      const [node, ...args] = command.trim().split(/\s+/).map(word => word.replace(/^"(.*)"$/, '$1')); assert.equal(node, 'node');
      assert.deepEqual(args, ['tools/test.mjs', '--test-concurrency=1']);
      const env = { ...process.env, CUEFLUENT_SHARD_MARKER: marker, CUEFLUENT_FAIL_FILE: failedFile,
        CUEFLUENT_TEST_SHARD: step.env.CUEFLUENT_TEST_SHARD.replace('${{ matrix.shard }}', row.shard) };
      delete env.NODE_TEST_CONTEXT;
      const result = await exec(process.execPath, args, { cwd: root, env, timeout: 30_000, maxBuffer: 64 * 1024 }).then(() => 0, error => error.code);
      return { result, files: (await fs.readFile(marker, 'utf8')).trim().split('\n') };
    }));
    assert.deepEqual(outputs.flatMap(output => output.files).sort(), Array.from({ length: 8 }, (_, index) => String(index)));
    assert.deepEqual(outputs.map(output => output.files.filter(file => Number(file) < 4).length), [1, 1, 1, 1]);
    assert.equal(outputs.filter(output => output.result === 1).length, failedFile ? 1 : 0);
    assert(outputs.every(output => output.result === 0 || output.result === 1));
  }
});

test('manual release candidate authorization requires confirmation on the main dispatch ref', async () => {
  const workflow = YAML.parse(await fs.readFile(path.resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.prepare.if, "${{ inputs.confirm && github.ref == 'refs/heads/main' }}");
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
  assert.equal(workflow.on.workflow_dispatch.inputs.checks_run_id.required, true);
  assert.equal(workflow.jobs.prepare.uses, undefined);
  assert.equal(workflow.jobs.prepare.strategy, undefined);
  assert.equal(workflow.concurrency.group, 'prepare-${{ inputs.tag }}');
  const steps = workflow.jobs.prepare.steps;
  assert.deepEqual(steps.filter(step => step.run).map(step => step.run), ['node tools/release-candidate.mjs select', 'node tools/release-candidate.mjs verify']);
  const download = steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['artifact-ids'], '${{ steps.source.outputs.artifact_ids }}');
  assert.equal(download.with['digest-mismatch'], 'error');
  for (const value of Object.values(workflow.jobs.prepare.env)) assert.doesNotMatch(value, /\brunner\./, 'Runner context is unavailable in job env.');
  const select = steps.find(step => step.run === 'node tools/release-candidate.mjs select');
  const verify = steps.find(step => step.run === 'node tools/release-candidate.mjs verify');
  assert.equal(select.env.CUEFLUENT_RELEASE_ROOT, '${{ runner.temp }}/${{ env.CUEFLUENT_RELEASE_NAME }}');
  assert.equal(verify.env.CUEFLUENT_RELEASE_ROOT, select.env.CUEFLUENT_RELEASE_ROOT);
  assert.equal(download.with.path, `${select.env.CUEFLUENT_RELEASE_ROOT}/artifacts`);
  assert.equal(steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).with.path, `${select.env.CUEFLUENT_RELEASE_ROOT}/candidate`);
});

test('candidate comparison verifies every archive and requires identical three-platform receipts', async t => {
  const f = await packageSource(t), artifacts = path.join(f.root, 'artifacts'); await fs.mkdir(artifacts);
  const files = ['build.json', ...f.built.packages.flatMap(item => item.archives.map(archive => archive.path)), ...f.built.tools.map(archive => archive.path)];
  for (const name of ARTIFACT_NAMES) {
    const root = path.join(artifacts, name); await fs.mkdir(root);
    for (const file of files) await fs.copyFile(path.join(f.output, file), path.join(root, file));
  }
  assert.deepEqual(await compareBuilds(artifacts), { platforms: 3, identical: true });
  const comparison = await compareBuilds(artifacts, { includeVerified: true });
  assert.deepEqual(Object.keys(comparison.verified), ARTIFACT_NAMES);
  for (const result of Object.values(comparison.verified)) {
    assert.deepEqual(result.build, f.built);
    assert.deepEqual(result.bytes, await fs.readFile(path.join(f.output, 'build.json')));
  }
  const altered = path.join(artifacts, ARTIFACT_NAMES.at(-1)), receipt = path.join(altered, 'build.json'), original = await fs.readFile(receipt);
  await fs.appendFile(receipt, '\n');
  await assert.rejects(compareBuilds(artifacts), { code: 'CI_CANDIDATE_INVALID' });
  await fs.writeFile(receipt, original);
  await fs.appendFile(path.join(altered, f.built.tools[0].path), 'corruption');
  await assert.rejects(compareBuilds(artifacts), { code: 'CI_CANDIDATE_INVALID' });
});

test('candidate comparison rejects non-current artifact directories before reading their contents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-candidate-names-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ARTIFACT_NAMES) await fs.mkdir(path.join(root, name === ARTIFACT_NAMES.at(-1) ? `unexpected-${name}` : name));
  await assert.rejects(compareBuilds(root), { code: 'CI_CANDIDATE_INVALID' });
});

test('candidate receipt cannot substitute another archive type or client', async t => {
  const f = await packageSource(t);
  assert.equal((await verifyBuildArchives(f.output)).build.version, f.built.version);
  const receipt = structuredClone(f.built); receipt.packages[0].archives = [receipt.packages[0].archives[0], receipt.packages[1].archives[1]];
  await fs.writeFile(path.join(f.output, 'build.json'), JSON.stringify(receipt));
  await assert.rejects(verifyBuildArchives(f.output), { code: 'CI_CANDIDATE_INVALID' });
});

test('candidate receipts carry the public version line and reject malformed or mismatched versions', async t => {
  const f = await packageSource(t);
  assert.equal(f.built.version, JSON.parse(await fs.readFile(path.join(f.source, 'package.json'), 'utf8')).version);
  assert.ok([...f.built.packages.flatMap(item => item.archives), ...f.built.tools].every(archive => archive.path.includes(`-${f.built.version}-`)));
  for (const version of ['0.16', 'v0.16.0', '0.16.0+build.1', '01.16.0', 1, '0.17.0-dev.0']) {
    const receipt = structuredClone(f.built); receipt.version = version;
    await fs.writeFile(path.join(f.output, 'build.json'), JSON.stringify(receipt));
    await assert.rejects(verifyBuildArchives(f.output), { code: 'CI_CANDIDATE_INVALID' });
  }
});

test('checks support PR readiness, manual recovery and retained source evidence without merge duplicates', async () => {
  const workflow = await checks();
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.pull_request.types, ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']);
  const steps = workflow.jobs.test.steps;
  const record = steps.findIndex(step => step.run === 'node tools/ci.mjs record-source');
  assert(record > steps.findIndex(step => step.run === 'node tools/ci.mjs build'));
  assert.equal(steps[record].if, "needs.plan.outputs.mode == 'full' && matrix.primary");
  const upload = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert(upload > record);
  assert.match(steps[upload].with.path, /source\.json/);
  assert.equal(steps[upload].with['retention-days'], 30);
});
