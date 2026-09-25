import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildPackages } from './package.mjs';
import { canonicalJSON } from './workflow-values.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = '2026-09-24T00:00:00.000Z';
const row = (type, payload) => JSON.stringify({ timestamp: stamp, type, payload }) + '\n';

for (const withHooks of [false, true]) test(`detached ${withHooks ? 'hook' : 'manual'} packages complete selected capture, processing and guarded category writes`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-complete-package-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { packages } = await buildPackages({ outDir: path.join(root, 'packages'), withHooks });
  for (const pkg of packages) {
    const work = path.join(root, `${pkg.client}-private`), project = path.join(work, 'project'), notes = path.join(work, 'notes');
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(notes);
    const configPath = path.join(work, 'settings/workflow.json'), requestFile = path.join(work, 'request.json');
    const collection = { id: 'test', rawDir: path.join(work, 'raw'), intakeStateDir: path.join(work, 'intake'),
      notes: { notesDir: notes, writerStateDir: path.join(work, 'writer') } };
    const proposal = { format: 'cuefluent-workflow', schemaVersion: 1, collections: [collection],
      routes: [{ id: 'test', projectRoot: project, clients: [pkg.client], collectionId: 'test' }] };
    const run = async (command, request = {}, expected = 0) => {
      await fs.writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
      const result = spawnSync(process.execPath, [path.join(pkg.skillRoot, 'scripts/workflow.mjs'), command, '--config', configPath, '--request', requestFile],
        { cwd: work, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, expected, `${pkg.client}/${command}: ${result.stderr || result.stdout}`);
      return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
    };
    const initial = await run('configure', { expectedHash: null, proposal });
    assert.equal(initial.config.collections[0].notes.organization, 'by-type');
    let configHash = initial.configHash;
    const envelope = args => ({ collectionId: 'test', expectedConfigHash: configHash, args });
    await run('storage-prepare', { collectionId: 'test', expectedConfigHash: configHash });
    const next = structuredClone(initial.config); next.routes[0].processing.mode = 'prompted';
    configHash = (await run('configure', { expectedHash: configHash, proposal: next })).configHash;
    const configured = await run('status');
    assert.equal(configured.runtime.hookRegistration, withHooks ? 'packaged' : 'absent');
    assert.equal(configured.runtime.hostTrust, 'unknown'); assert.equal(configured.transport.automaticProcessing, false);
    assert.equal(configured.config.routes[0].collection.enabled, false);
    const sessionId = randomUUID(), unitId = randomUUID(), sourcePath = path.join(project, 'selected.jsonl');
    let prefix = '', body;
    if (pkg.client === 'codex') {
      prefix = row('session_meta', { id: sessionId, session_id: sessionId, cwd: project, cli_version: '0.156.1', source: 'cli', history_mode: 'legacy' });
      body = row('event_msg', { type: 'task_started', turn_id: unitId }) + row('event_msg', { type: 'user_message', message: 'Meeting: keep the rollout paused.' }) + row('event_msg', { type: 'task_complete', turn_id: unitId });
    } else body = JSON.stringify({ type: 'user', uuid: randomUUID(), timestamp: stamp, sessionId, version: '2.1.280', isSidechain: false,
      parentUuid: null, cwd: project, promptId: unitId, message: { role: 'user', content: 'Meeting: keep the rollout paused.' } }) + '\n';
    await fs.writeFile(sourcePath, prefix + body);
    const selection = { client: pkg.client, sessionId, cwd: project, unitId: null };
    const source = (await run('capture-status', envelope({ selection, sourcePath }))).source;
    const control = { selection, sourcePath, expectedSourceIdentity: source.fileIdentity, expectedSelectionHash: null,
      operationId: randomUUID(), kind: 'historical', unitIds: [unitId], readRange: { fromByte: Buffer.byteLength(prefix), endByte: source.eofByte } };
    assert.equal((await run('capture-preview', envelope(control))).status, 'selection-verified');
    const selected = await run('capture-select', envelope(control));
    assert.equal((await run('capture-run', envelope({ selection, scopeId: control.operationId, expectedSelectionHash: selected.hash, unitIds: [unitId] }))).saved, 1);
    const pending = await run('processing-pending', envelope({ selection })); assert.equal(pending.pending.length, 1);
    const args = { selection, operationId: randomUUID() }, identity = { client: pkg.client, sessionId, unitId };
    let claim = await run('processing-prepare', envelope({ ...args, inputs: pending.pending.map(({ identity, headHash }) => ({ identity, headHash })) }));
    for (let page = 0; page < claim.packet.pages.length; page++) {
      const issued = await run('processing-page', envelope({ ...args, expectedClaimHash: claim.claimHash, page }));
      assert.match(JSON.stringify(issued.evidence), /rollout paused/);
      claim = await run('processing-ack', envelope({ ...args, expectedClaimHash: issued.claimHash, pages: [{ index: page, hash: issued.hash }] }));
    }
    const contentPath = path.join(work, 'proposal.md'), content = '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n';
    await fs.writeFile(contentPath, content);
    const proposed = await run('processing-propose', envelope({ ...args, expectedClaimHash: claim.claimHash,
      proposal: { files: [{ path: 'meetings/rollout.md', expectedHash: null, contentPath, expectedContentHash: hash(content) }], mappings: [{ identity, paths: ['meetings/rollout.md'] }] } }));
    assert.deepEqual(await fs.readdir(notes), []); // Prompted means proposal only until exact approval.
    assert.equal((await run('processing-save', envelope({ ...args, expectedClaimHash: proposed.claimHash, approvedProposalHash: proposed.proposalHash, trigger: 'approved' }))).status, 'saved');
    assert.equal(await fs.readFile(path.join(notes, 'meetings/rollout.md'), 'utf8'), content);
    const operation = await run('processing-status', envelope({ operationId: args.operationId }));
    assert.equal((await run('processing-recover', envelope({ operationId: args.operationId, expectedRecoveryHash: operation.recoveryHash }))).status, 'saved');
    assert.equal((await run('processing-pending', envelope({ selection }))).pending.length, 0);
    const names = ['overview.md', 'tasks/windows.md', 'knowledge-base/cache.md', 'decisions/ttl.md'];
    const inspect = () => run('inspect-notes', { root: notes, paths: names });
    const inspected = await inspect();
    const files = [];
    for (const [index, name] of names.entries()) {
      const selectedContent = path.join(work, `direct-${index}.md`); await fs.writeFile(selectedContent, content);
      files.push({ path: name, expectedHash: null, contentPath: selectedContent, expectedContentHash: hash(content) });
    }
    const save = (parents, expected = 0) => { const plan = { version: 2, mode: 'authored', ...parents, stateDir: collection.notes.writerStateDir, files };
      return run('direct-save', { collectionId: 'test', expectedConfigHash: configHash, plan, approvedPlanHash: hash(canonicalJSON(plan)) }, expected); };
    await fs.mkdir(path.join(notes, 'tasks'));
    assert.match(await save(inspected, 1), /directory changed/);
    assert.deepEqual((await save(await inspect())).updated, names);
    const preserved = await fs.readFile(path.join(notes, 'meetings/rollout.md'));
    files.forEach(file => file.expectedHash = hash(content));
    assert.equal((await save(await inspect())).status, 'unchanged');
    assert.deepEqual(await fs.readFile(path.join(notes, 'meetings/rollout.md')), preserved);
    assert.equal((await run('writer-status', { stateDir: collection.notes.writerStateDir })).recoveryPending, false);
    assert.equal((await run('status')).configHash, configHash);
  }
});
