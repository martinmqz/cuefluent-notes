import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { saveProcessing } from './processing.mjs';
import { storageFixture } from './test-support/storage-fixture.mjs';
import { processingFixture, inspectedClaim, proposedClaim } from './test-support/processing-fixture.mjs';
import { executeWorkflow, workflowErrorReport } from './workflow.mjs';
import { prepareNote } from './note-generation.mjs';
import { windowsDefaultLocations } from './workflow-paths.mjs';
import { fingerprint, inspectDirectories } from './safe-update.mjs';
import { digest, canonicalJSON } from './workflow-values.mjs';
const cli = fileURLToPath(new URL('./workflow.mjs', import.meta.url));
async function invoke(args, nodeArgs = [], env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, cli, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const envelope = (f, args) => ({ collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash, args });
test('capabilities require no settings and cannot accept caller-supplied provenance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-capabilities-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.json');
  await fs.writeFile(config, 'not settings');
  for (const configPath of [config, path.join(root, 'absent', 'config.json')]) {
    const result = await invoke(['processing-capabilities', '--config', configPath], [], { ...process.env, SystemRoot: '' });
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.interfaceVersion, 1);
    assert.equal(value.generatedOutput.verified, false);
    assert.equal(value.generatedOutput.collectionExclusions, false);
    assert.equal(value.generatedOutput.processingExclusions, false);
    assert.equal(value.generatedOutput.reason, 'HELPER_INVOCATION_BINDING_UNAVAILABLE');
    assert.equal(value.automaticProcessing, false); assert.equal(value.modelRunner, false);
  }
  assert.deepEqual(await fs.readdir(root), ['config.json']);
  assert.equal(await fs.readFile(config, 'utf8'), 'not settings');
  // Even well-shaped public identifiers are not a helper attestation.
  for (const field of ['contextRef', 'operationId', 'artifactHash', 'nativeProof', 'enabled']) {
    await assert.rejects(executeWorkflow('processing-capabilities', { [field]: 'a'.repeat(64) }), { code: 'INVALID_WORKFLOW' });
  }
  for (const method of ['readFile', 'realpath', 'lstat', 'readdir', 'mkdir']) {
    t.mock.method(fs, method, () => { throw new Error('capability query must not access storage'); });
  }
  assert.equal((await executeWorkflow('processing-capabilities', {}, { configPath: config })).generatedOutput.verified, false);
  t.mock.restoreAll();
});
test('status and operation diagnostics preserve the same non-authoritative capability contract', async t => {
  const f = await processingFixture(t);
  const capabilities = await executeWorkflow('processing-capabilities', {});
  const status = await executeWorkflow('status', {}, f.options);
  assert.deepEqual(status.transport.generatedOutput, capabilities.generatedOutput);
  const prepared = await inspectedClaim(f);
  assert.equal(prepared.operationContext.authoritative, false);
  assert.equal(prepared.operationContext.generatedOutputAttribution, 'unverified');
});
test('CLI capacity errors expose only approved numeric measurements', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-capacity-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = path.join(root, 'request.json');
  for (const kind of ['sources', 'bytes']) {
    const sources = Array.from({ length: kind === 'sources' ? 129 : 40 }, (_, i) =>
      ({ type: 'document', ref: `PRIVATE-${i}-` + (kind === 'bytes' ? '界'.repeat(700) : '') }));
    await fs.writeFile(request, JSON.stringify({ original: null, content: '# Note\n\n## Work\nEvidence.\n',
      now: '2026-10-09T12:00:00Z', skillVersion: '0.12.0', metadata: { sources } }));
    const result = await invoke(['prepare-note', '--request', request]);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert(!result.stderr.includes('PRIVATE'));
    const report = JSON.parse(result.stderr);
    assert.equal(report.error, kind === 'sources' ? 'NOTE_METADATA_SOURCE_CAPACITY' : 'NOTE_METADATA_BYTE_CAPACITY');
    assert.equal(report.details.current, 0); assert(report.details.proposed > report.details.limit);
  }
  const details = { current: 1, proposed: 'PRIVATE', limit: Infinity, extra: 'PRIVATE' };
  Object.defineProperty(details, 'hidden', { get() { throw new Error('must not invoke'); } });
  assert.deepEqual(workflowErrorReport({ code: 'NOTE_METADATA_SOURCE_CAPACITY', details }),
    { error: 'NOTE_METADATA_SOURCE_CAPACITY', details: { current: 1 } });
  assert.deepEqual(workflowErrorReport({ code: 'NOTE_METADATA_INVALID', details: { current: 1 } }), { error: 'NOTE_METADATA_INVALID' });
  for (const code of ['private-value', 'A'.repeat(82), 'PRIVATE\nCONTENT', { toString() { throw new Error('must not coerce'); } }]) {
    assert.deepEqual(workflowErrorReport({ code }), { error: 'WORKFLOW_OPERATION_FAILED' });
  }
  assert.deepEqual(workflowErrorReport(Object.defineProperty({}, 'code', { get() { throw new Error('must not read'); } })),
    { error: 'WORKFLOW_OPERATION_FAILED' });
});
test('CLI reports source capacity when the merged session sources exceed the structural budget', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-capacity-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = i => ({ type: 'session', client: 'claude', session_id: 'synthetic', unit_id: `unit_${i}`, revision: 'a'.repeat(64) });
  const base = { original: null, content: '# Topic\n## Decision\nEvidence.\n', now: '2026-10-09T12:00:00Z', skillVersion: '0.12.0' };
  const original = prepareNote({ ...base, metadata: { sources: Array.from({ length: 128 }, (_, i) => session(i)) } }).content;
  const request = path.join(root, 'request.json');
  await fs.writeFile(request, JSON.stringify({ ...base, original, content: original,
    metadata: { sources: Array.from({ length: 250 }, (_, i) => session(i + 128)) } }));
  const result = await invoke(['prepare-note', '--request', request]);
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { error: 'NOTE_METADATA_SOURCE_CAPACITY', details: { current: 128, proposed: 250, limit: 128 } });
});

test('CLI unconfigured status writes nothing and rejects malformed, oversized, unknown or proof-bearing requests', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-cli-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'missing', 'workflow.json'), request = path.join(root, 'request.json');
  const before = await fs.readdir(root), status = await invoke(['status', '--config', config]);
  assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).configHash, null); assert.deepEqual(await fs.readdir(root), before);
  const spelled = `${root}${path.sep}.${path.sep}missing${path.sep}workflow.json`;
  const aliasStatus = await invoke(['status', '--config', spelled]);
  assert.equal(aliasStatus.code, 0, aliasStatus.stderr);
  const paths = JSON.parse(aliasStatus.stdout);
  assert.equal(paths.configPath, config); assert.equal(paths.requestedConfigPath, spelled); assert.equal(paths.resolvedConfigPath, config);
  for (const [body, args] of [['{ PRIVATE_SYNTAX', ['configure']], ['x'.repeat(2 * 1024 * 1024 + 1), ['configure']], ['{}', ['unknown']],
    [JSON.stringify({ collectionId: 'x', expectedConfigHash: '0'.repeat(64), args: { selection: {}, proof: {} } }), ['capture-run']]]) {
    await fs.writeFile(request, body);
    const result = await invoke([...args, '--config', config, '--request', request]);
    assert.equal(result.code, 1); assert(result.stderr.length < 160); assert(!result.stderr.includes('PRIVATE_SYNTAX'));
    assert.equal((await fs.readdir(root)).includes('missing'), false);
  }
  assert.equal((await invoke(['status', '--config', config, '--config', config])).code, 1);
});
test('CLI note preparation requires no configuration and writes neither notes nor workflow state', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-prepare-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = path.join(root, 'request.json'), config = path.join(root, 'missing', 'workflow.json');
  const content = '# Synthetic\n\n## Decision\n\nRetain the supplied prose.\n';
  await fs.writeFile(request, JSON.stringify({ original: null, content, now: '2026-10-01T12:00:00Z', skillVersion: '0.9.0' }));
  const before = await fs.readdir(root), result = await invoke(['prepare-note', '--config', config, '--request', request]);
  assert.equal(result.code, 0, result.stderr); const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.metadataStatus, 'valid'); assert(prepared.content.endsWith(content));
  assert.deepEqual(await fs.readdir(root), before);
});
test('CLI preparation accommodates two large Markdown fields including JSON escaping', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-large-prepare-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = path.join(root, 'request.json'), content = '# Synthetic\n\n## Decision\n\n' + '\u0000'.repeat(1100 * 1024);
  await fs.writeFile(request, JSON.stringify({ original: content, content, now: '2026-10-01T12:00:00Z', skillVersion: '0.9.0' }));
  assert((await fs.stat(request)).size > 12 * 1024 * 1024);
  const result = await invoke(['prepare-note', '--request', request]);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).content, content);
});
test('pure preparation bypasses configuration and native storage probes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-pure-prepare-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = path.join(root, 'request.json'), preload = path.join(root, 'probe-guard.mjs');
  const value = { original: null, content: '# Note\n\n## Work\n\nEvidence.\n', now: '2026-10-05T12:00:00Z', skillVersion: '0.9.0' };
  await fs.writeFile(request, JSON.stringify(value));
  await fs.writeFile(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
process.env.CUEFLUENT_WORKFLOW_CONFIG = 'relative-invalid-config';
childProcess.spawn = () => { throw new Error('Unexpected storage subprocess'); };
syncBuiltinESMExports();
`);
  const result = await invoke(['prepare-note', '--request', request], ['--import', pathToFileURL(preload).href]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).metadataStatus, 'valid');
  const before = process.env.CUEFLUENT_WORKFLOW_CONFIG;
  try {
    process.env.CUEFLUENT_WORKFLOW_CONFIG = 'relative-invalid-config';
    assert.equal((await executeWorkflow('prepare-note', value)).metadataStatus, 'valid');
  } finally {
    if (before === undefined) delete process.env.CUEFLUENT_WORKFLOW_CONFIG;
    else process.env.CUEFLUENT_WORKFLOW_CONFIG = before;
  }
});
test('CLI processing supports exact paged inspection, Skip and durable status without new capture setup', async t => {
  const f = await processingFixture(t);
  const call = (command, args) => executeWorkflow(command, envelope(f, args), { configPath: f.options.configPath });
  assert.equal((await call('processing-pending', { selection: f.selection })).pending.length, 1);
  let claim = await call('processing-prepare', { ...f.args, inputs: f.inputs });
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const issued = await call('processing-page', { ...f.args, expectedClaimHash: claim.claimHash, page });
    claim = await call('processing-ack', { ...f.args, expectedClaimHash: issued.claimHash, pages: [{ index: page, hash: issued.hash }] });
  }
  const done = await call('processing-complete', { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' });
  assert.equal(done.status, 'skipped');
  assert.equal((await call('processing-pending', { selection: f.selection })).pending.length, 0);
});

test('CLI exposes the collision code without disclosing note identity or content', async t => {
  const f = await processingFixture(t), claim = await inspectedClaim(f), files = [];
  const content = `<!-- cuefluent\nschema_version: 1\nid: note_PRIVATE_ID\nsources:\n  - type: session\n    client: ${f.identity.client}\n    session_id: ${f.identity.sessionId}\n    unit_id: ${f.identity.unitId}\n    revision: "${f.capture.evidenceHash}"\n-->\n\n# Meeting\n\n## Decision\n\nPRIVATE_BODY\n`;
  for (const name of ['first.md', 'second.md']) {
    const contentPath = path.join(f.root, 'proposal-' + name); await fs.writeFile(contentPath, content);
    files.push({ path: name, expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) });
  }
  const proposal = { files, mappings: [{ identity: f.identity, paths: files.map(file => file.path) }] };
  const plan = { version: 1, mode: 'authored', root: f.collection.notes.notesDir, stateDir: f.collection.notes.writerStateDir, files };
  for (const [command, value] of [
    ['processing-propose', envelope(f, { ...f.args, expectedClaimHash: claim.claimHash, proposal })],
    ['direct-save', { plan, approvedPlanHash: digest(canonicalJSON(plan)) }],
  ]) {
    const request = path.join(f.root, 'request.json'); await fs.writeFile(request, JSON.stringify(value));
    const result = await invoke([command, '--config', f.options.configPath, '--request', request]);
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: 'NOTE_METADATA_ID_COLLISION' });
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  }
});
test('CLI reports retained metadata cleanup without exposing the underlying exception text', async t => {
  const f = await storageFixture(t); await fs.mkdir(f.collection.notes.notesDir);
  const contentPath = path.join(f.root, 'selected.md'); await fs.writeFile(contentPath, '# Planning meeting\n\n## Decision\n\nKeep the rollout paused.\n');
  const plan = { version: 1, mode: 'authored', root: f.collection.notes.notesDir, stateDir: f.collection.notes.writerStateDir,
    files: [{ path: 'planning.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) }] };
  const request = path.join(f.root, 'request.json'), preload = path.join(f.root, 'failure.mjs');
  await fs.writeFile(request, JSON.stringify({ plan, approvedPlanHash: digest(canonicalJSON(plan)) }));
  await fs.writeFile(preload, `import fs from 'node:fs/promises';
import path from 'node:path';
const rename = fs.rename, unlink = fs.unlink;
fs.rename = async (from, ...args) => {
  if (path.basename(from).startsWith('.metadata-')) throw Object.assign(new Error('PRIVATE_DETAIL'), { code: 'ENOSPC' });
  return rename(from, ...args);
};
fs.unlink = async (file, ...args) => {
  if (path.basename(file).startsWith('.metadata-')) throw Object.assign(new Error('PRIVATE_CLEANUP_DETAIL'), { code: 'EACCES' });
  return unlink(file, ...args);
};
`);
  const result = await invoke(['direct-save', '--config', path.join(f.root, 'missing.json'), '--request', request], ['--import', pathToFileURL(preload).href]);
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr); assert.equal(error.error, 'ENOSPC');
  assert.equal(error.cleanupWarnings.length, 1); assert.match(error.cleanupWarnings[0], /retained state/);
  assert(!result.stderr.includes('PRIVATE_')); assert(result.stderr.length < 200);
  const stages = await fs.readdir(path.join(plan.stateDir, 'metadata-stages')); assert.equal(stages.length, 1);
  assert((await fs.readFile(path.join(plan.stateDir, 'metadata-stages', stages[0]))).length > 0);
  assert.equal(await fingerprint(path.join(plan.root, 'planning.md')), null);
});
test('direct save uses inspected note/content/parent hashes without native identity or setup', async t => {
  const f = await storageFixture(t); await fs.mkdir(f.collection.notes.notesDir);
  const intakeBefore = await fs.readdir(f.collection.intakeStateDir);
  const contentPath = path.join(f.root, 'selected.md'); await fs.writeFile(contentPath, '# Planning meeting\n\n## Decision\n\nKeep the rollout paused.\n');
  const inspected = await inspectDirectories(f.collection.notes.notesDir, ['meetings/planning.md']);
  const plan = { version: 2, mode: 'authored', root: inspected.root, stateDir: f.collection.notes.writerStateDir,
    directories: inspected.directories, createDirectories: inspected.createDirectories,
    files: [{ path: 'meetings/planning.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) }] };
  const request = { plan, approvedPlanHash: digest(canonicalJSON(plan)) };
  await fs.appendFile(contentPath, '\nUnreviewed change.\n');
  await assert.rejects(executeWorkflow('direct-save', request), /content changed/);
  assert.equal((await fs.readdir(f.collection.notes.notesDir)).length, 0);
  plan.files[0].expectedContentHash = await fingerprint(contentPath); request.approvedPlanHash = digest(canonicalJSON(plan));
  await executeWorkflow('direct-save', request);
  assert.equal(await fingerprint(path.join(plan.root, plan.files[0].path)), plan.files[0].expectedContentHash);
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), intakeBefore);
});
async function manualCommandsWithUnavailableConfig(f, code) {
  const root = f.collection.notes.notesDir, stateDir = f.collection.notes.writerStateDir;
  await fs.mkdir(root);
  const contentPath = path.join(f.root, 'manual.md'), content = '# Manual note\n\n## Decision\n\nKeep the selected scope.\n';
  await fs.writeFile(contentPath, content);
  const before = await fs.readdir(f.collection.intakeStateDir);
  const files = (await executeWorkflow('fingerprint', { paths: [contentPath] })).files;
  assert.deepEqual(files, [{ path: contentPath, hash: digest(content) }]);
  const inspected = await executeWorkflow('inspect-notes', { root, paths: ['manual.md'] });
  assert.equal((await executeWorkflow('writer-status', { stateDir })).recoveryPending, false);
  // Recovery still enforces its own inspected journal hash, even with unusable settings.
  await assert.rejects(executeWorkflow('writer-recover', { stateDir, expectedJournalHash: '0'.repeat(64) }), /Inspected recovery journal changed/);
  const plan = { version: 2, mode: 'authored', root: inspected.root, stateDir,
    directories: inspected.directories, createDirectories: inspected.createDirectories,
    files: [{ path: 'manual.md', expectedHash: null, contentPath, expectedContentHash: files[0].hash }] };
  const request = { plan, approvedPlanHash: digest(canonicalJSON(plan)) };
  await assert.rejects(executeWorkflow('status', {}), { code });
  await assert.rejects(executeWorkflow('direct-save', { ...request, collectionId: f.collection.id,
    expectedConfigHash: f.options.expectedConfigHash }), { code });
  assert.deepEqual(await fs.readdir(root), []);
  await executeWorkflow('direct-save', request);
  assert.equal(await fs.readFile(path.join(root, 'manual.md'), 'utf8'), content);
  assert.deepEqual(await fs.readdir(f.collection.intakeStateDir), before);
}
test('manual commands remain available when the configured settings path is invalid', async t => {
  const f = await storageFixture(t), previous = process.env.CUEFLUENT_WORKFLOW_CONFIG;
  t.after(() => {
    if (previous === undefined) delete process.env.CUEFLUENT_WORKFLOW_CONFIG;
    else process.env.CUEFLUENT_WORKFLOW_CONFIG = previous;
  });
  process.env.CUEFLUENT_WORKFLOW_CONFIG = 'relative-invalid-config';
  await manualCommandsWithUnavailableConfig(f, 'INVALID_WORKFLOW_PATH');
});
test('manual commands remain available when Windows default settings are ambiguous', { skip: process.platform !== 'win32' }, async t => {
  const f = await storageFixture(t), { oldConfig, newConfig } = windowsDefaultLocations();
  for (const file of [oldConfig, newConfig]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{}', { flag: 'wx' });
    t.after(() => fs.unlink(file));
  }
  await manualCommandsWithUnavailableConfig(f, 'WORKFLOW_CONFIG_SELECTION_REQUIRED');
});
test('direct saves cannot change configured destinations or bypass pending processing transactions', async t => {
  const f = await processingFixture(t), proposed = await proposedClaim(f);
  const plan = proposed.plan;
  const request = { plan, approvedPlanHash: digest(canonicalJSON(plan)), collectionId: f.collection.id, expectedConfigHash: f.options.expectedConfigHash };
  for (const collectionId of ['', null, false, 0]) {
    await assert.rejects(executeWorkflow('direct-save', { ...request, collectionId }, { configPath: f.options.configPath }), { code: 'INVALID_WORKFLOW' });
  }
  for (const field of ['collectionId', 'expectedConfigHash']) {
    const missing = { ...request }; delete missing[field];
    await assert.rejects(executeWorkflow('direct-save', missing, { configPath: f.options.configPath }), { code: 'INVALID_WORKFLOW' });
  }
  assert.equal((await fs.readdir(f.collection.notes.notesDir)).length, 0);
  const wrong = { ...plan, stateDir: path.join(f.root, 'alternate-writer') };
  await assert.rejects(executeWorkflow('direct-save', { ...request, plan: wrong, approvedPlanHash: digest(canonicalJSON(wrong)) }, { configPath: f.options.configPath }), /DESTINATION_MISMATCH/);
  await assert.rejects(saveProcessing(f.capability, { ...f.args, expectedClaimHash: proposed.claimHash, approvedProposalHash: proposed.proposalHash },
    { fault: at => { if (at === 'write-intent') throw new Error('crash'); } }), /crash/);
  await assert.rejects(executeWorkflow('direct-save', request, { configPath: f.options.configPath }), /pending|transaction|processing/i);
});
