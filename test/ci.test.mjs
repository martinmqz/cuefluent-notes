import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { verifyBuildArchives, compareBuilds } from '../tools/ci.mjs';
import { EXPECTED_CHECK_JOBS } from '../tools/release-candidate.mjs';
import { packageSource } from './fixtures/package-source.mjs';
import YAML from 'yaml';

const exec = promisify(execFile);
const checks = async () => YAML.parse(await fs.readFile(path.resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8'));

test('native shards and client smoke start independently and retain the required check names', async () => {
  const workflow = await checks(), { guidance, test: source, 'client-smoke': smoke, reproducibility } = workflow.jobs;
  for (const job of [guidance, source, smoke]) assert.equal(job.needs, undefined);
  for (const job of [source, smoke]) {
    assert.equal(job.strategy['fail-fast'], false);
    assert.equal(job.strategy['max-parallel'], undefined);
  }
  const rows = source.strategy.matrix.include, names = new Set(['guidance', reproducibility.name]);
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
  for (const required of ['guidance', 'test (ubuntu-24.04)', 'test (macos-14)', 'test (windows-2025)', 'client-smoke (macos-14)', 'client-smoke (windows-2025)', 'reproducibility']) assert(names.has(required), `Missing required context: ${required}`);
  assert.deepEqual(reproducibility.needs, ['guidance', 'test', 'client-smoke']);
  for (const step of source.steps.filter(step => step.run === 'npm run check:examples' || step.run === 'node tools/ci.mjs build' || step.uses?.startsWith('actions/upload-artifact@'))) assert.equal(step.if, 'matrix.primary');
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
  assert.equal(workflow.concurrency.group, 'checks-v2-${{ github.event_name }}-${{ github.ref }}');
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('the final gate rejects failed, skipped or cancelled source shards and client smoke', async () => {
  const gate = (await checks()).jobs.reproducibility.steps.find(step => step.env?.TEST_RESULT);
  const script = /<<'NODE'\n([\s\S]*?)\nNODE\s*$/.exec(gate.run)?.[1]; assert.ok(script);
  const valid = { TEST_RESULT: 'success', GUIDANCE_RESULT: 'success', CLIENT_SMOKE_RESULT: 'success' };
  await exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...valid } });
  for (const key of Object.keys(valid)) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...valid, [key]: result } }));
    }
  }
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
  for (const platform of ['ubuntu-24.04', 'macos-14', 'windows-2025']) {
    const root = path.join(artifacts, `v2-candidate-${platform}`); await fs.mkdir(root);
    for (const file of files) await fs.copyFile(path.join(f.output, file), path.join(root, file));
  }
  assert.deepEqual(await compareBuilds(artifacts), { platforms: 3, identical: true });
  const windows = path.join(artifacts, 'v2-candidate-windows-2025'), receipt = path.join(windows, 'build.json'), original = await fs.readFile(receipt);
  await fs.appendFile(receipt, '\n');
  await assert.rejects(compareBuilds(artifacts), { code: 'CI_CANDIDATE_INVALID' });
  await fs.writeFile(receipt, original);
  await fs.appendFile(path.join(windows, f.built.tools[0].path), 'corruption');
  await assert.rejects(compareBuilds(artifacts), { code: 'CI_CANDIDATE_INVALID' });
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
  assert.equal(steps[record].if, 'matrix.primary');
  const upload = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert(upload > record);
  assert.match(steps[upload].with.path, /source\.json/);
  assert.equal(steps[upload].with['retention-days'], 30);
});
