import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureWorkflow, workflowStatus, prepareConfiguredStorage } from './workflow-settings.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { digest } from './workflow-values.mjs';
import { storageFixture } from './test-support/storage-fixture.mjs';

async function settingsFixture(t) {
  const f = await storageFixture(t), configPath = path.join(f.root, 'settings', 'workflow.json');
  const initial = await configureWorkflow({ configPath, expectedHash: null, proposal: f.config });
  return { ...f, config: initial.config, options: { ...f.options, configPath, expectedConfigHash: initial.configHash } };
}

test('unconfigured status and rejected activation create no directories; setup remains disabled until verified activation', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-settings-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const configPath = path.join(root, 'config', 'workflow.json');
  assert.equal((await workflowStatus({ configPath })).configHash, null);
  assert.deepEqual(await fs.readdir(root), ['project']);
  const proposal = { format: 'cuefluent-workflow', schemaVersion: 1,
    collections: [{ id: 'test', rawDir: path.join(root, 'raw'), intakeStateDir: path.join(root, 'intake'), notes: { notesDir: path.join(root, 'notes'), writerStateDir: path.join(root, 'writer') } }],
    routes: [{ id: 'test', projectRoot: project, clients: ['codex'], collectionId: 'test', collection: { enabled: true, selection: { kind: 'project' } } }] };
  await assert.rejects(configureWorkflow({ configPath, expectedHash: null, proposal }));
  assert.deepEqual(await fs.readdir(root), ['project']);
  proposal.routes[0].collection.enabled = false;
  const initial = await configureWorkflow({ configPath, expectedHash: null, proposal });
  assert.equal(initial.config.routes[0].processing.mode, 'manual'); assert.equal(initial.config.collections[0].notes.organization, 'by-type');
  const options = { configPath, collectionId: 'test', expectedConfigHash: initial.configHash };
  assert.equal((await prepareConfiguredStorage(options)).status, 'storage-ready');
  assert.equal((await readWorkflowSnapshot(configPath)).hash, initial.configHash);
  proposal.routes[0].collection.enabled = true;
  const active = await configureWorkflow({ configPath, expectedHash: initial.configHash, proposal });
  assert.equal(active.config.routes[0].collection.enabled, true);
  assert.equal((await fs.readdir(path.join(root, 'config'))).some(name => name === '.lock'), false);
});

test('settings reject stale hashes, source aliases and conflicting writer roots', async t => {
  const f = await settingsFixture(t), before = await fs.readFile(f.options.configPath);
  await assert.rejects(configureWorkflow({ configPath: f.options.configPath, expectedHash: 'f'.repeat(64), proposal: f.config }), /POLICY_CHANGED/);
  const proposal = structuredClone(f.config); proposal.collections[0].rawDir = f.project;
  await assert.rejects(configureWorkflow({ configPath: f.options.configPath, expectedHash: digest(before), proposal }), /OVERLAP/);
  assert((await fs.readFile(f.options.configPath)).equals(before));
  assert.equal((await fs.readdir(path.dirname(f.options.configPath))).some(name => name.startsWith('.workflow') || name === '.lock'), false);
});

test('a concurrent config change survives staged settings and only the owned stage is cleaned', async t => {
  const f = await settingsFixture(t), changed = structuredClone(f.config); changed.routes[0].processing.mode = 'prompted';
  const external = JSON.stringify({ ...f.config, routes: [] });
  await assert.rejects(configureWorkflow({ configPath: f.options.configPath, expectedHash: f.options.expectedConfigHash, proposal: changed },
    { beforeCommit: () => fs.writeFile(f.options.configPath, external) }), /POLICY_CHANGED/);
  assert.equal(await fs.readFile(f.options.configPath, 'utf8'), external);
  assert.equal((await fs.readdir(path.dirname(f.options.configPath))).some(name => name.startsWith('.workflow') || name === '.lock'), false);
});

test('processing mode changes remain independent and an unfamiliar lock is retained', async t => {
  const f = await settingsFixture(t), proposal = structuredClone(f.config); proposal.routes[0].collection.enabled = false; proposal.routes[0].processing.mode = 'automatic';
  const result = await configureWorkflow({ configPath: f.options.configPath, expectedHash: f.options.expectedConfigHash, proposal });
  assert.equal(result.config.routes[0].collection.enabled, false); assert.equal(result.config.routes[0].processing.mode, 'automatic');
  const lock = path.join(path.dirname(f.options.configPath), '.lock'); await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'unknown'), 'keep');
  await assert.rejects(configureWorkflow({ configPath: f.options.configPath, expectedHash: result.configHash, proposal }));
  assert.equal(await fs.readFile(path.join(lock, 'unknown'), 'utf8'), 'keep');
});

test('collection generations survive semantic no-ops but never an off/on or overlap round trip', async t => {
  const f = await settingsFixture(t);
  let current = await readWorkflowSnapshot(f.options.configPath);
  const update = async change => {
    const proposal = structuredClone(current.config); change(proposal);
    const saved = await configureWorkflow({ configPath: f.options.configPath, expectedHash: current.hash, proposal });
    current = { config: saved.config, hash: saved.configHash }; return current.config.routes.find(r => r.id === 'fixture')?.collection.generation;
  };
  const first = current.config.routes[0].collection.generation;
  assert.equal(await update(c => { c.routes[0].processing.mode = 'prompted'; c.routes[0].clients.reverse(); }), first);
  const unrelated = path.join(f.root, 'unrelated'); await fs.mkdir(unrelated);
  assert.equal(await update(c => c.routes.push({ ...structuredClone(c.routes[0]), id: 'other', projectRoot: unrelated })), first);
  assert.equal(await update(c => c.routes.reverse()), first);
  const disabled = await update(c => { c.routes.find(r => r.id === 'fixture').collection.enabled = false; });
  assert.notEqual(disabled, first);
  const enabled = await update(c => { const r = c.routes.find(r => r.id === 'fixture'); r.collection.enabled = true; r.collection.generation = first; });
  assert.notEqual(enabled, first); assert.notEqual(enabled, disabled);
  const nested = path.join(f.project, 'nested'); await fs.mkdir(nested);
  const restricted = await update(c => c.routes.push({ ...structuredClone(c.routes.find(r => r.id === 'fixture')), id: 'nested', projectRoot: nested, excluded: true }));
  assert.notEqual(restricted, enabled);
  const restored = await update(c => { c.routes = c.routes.filter(r => r.id !== 'nested'); });
  assert.notEqual(restored, enabled); assert.notEqual(restored, restricted);
  await update(c => { c.routes = c.routes.filter(r => r.id !== 'fixture'); });
  const readded = await update(c => c.routes.push({ ...structuredClone(f.config.routes[0]), collection: { ...f.config.routes[0].collection, generation: first } }));
  assert.notEqual(readded, first);
});

test('configure can remove an unusable old storage binding without touching its replacement', async t => {
  const f = await settingsFixture(t);
  await fs.rmdir(f.collection.rawDir); await fs.writeFile(f.collection.rawDir, 'unrelated replacement');
  const result = await configureWorkflow({ configPath: f.options.configPath, expectedHash: f.options.expectedConfigHash,
    proposal: { format: 'cuefluent-workflow', schemaVersion: 1, collections: [], routes: [] } });
  assert.deepEqual(result.config.routes, []);
  assert.equal(await fs.readFile(f.collection.rawDir, 'utf8'), 'unrelated replacement');
});

test('pure membership widening and broader parents preserve existing native grants', async t => {
  const { collectionGrantHash } = await import('./collection-grant.mjs');
  const { randomUUID } = await import('node:crypto');
  const f = await settingsFixture(t), sessionId = randomUUID(), otherId = randomUUID();
  const nested = path.join(f.project, 'nested'), descendant = path.join(nested, 'child'); await fs.mkdir(descendant, { recursive: true });
  let current = await readWorkflowSnapshot(f.options.configPath);
  const update = async change => {
    const proposal = structuredClone(current.config); change(proposal);
    const saved = await configureWorkflow({ configPath: f.options.configPath, expectedHash: current.hash, proposal });
    current = { config: saved.config, hash: saved.configHash }; return saved.config;
  };
  await update(c => { c.routes[0].projectRoot = nested; c.routes[0].clients = ['codex']; c.routes[0].collection.selection = { kind: 'sessions', sessionIds: [sessionId] };
    c.routes.push({ ...structuredClone(c.routes[0]), id: 'claude-child', clients: ['claude'], projectRoot: descendant }); });
  const selection = { client: 'codex', sessionId }, first = await collectionGrantHash(current.config, 'fixture', selection);
  const notMember = await collectionGrantHash(current.config, 'fixture', { client: 'codex', sessionId: otherId });
  await update(c => { c.routes[0].clients.push('claude'); c.routes[0].collection.selection.sessionIds.push(otherId); });
  assert.equal(await collectionGrantHash(current.config, 'fixture', selection), first);
  assert.notEqual(await collectionGrantHash(current.config, 'fixture', { client: 'codex', sessionId: otherId }), notMember);
  await update(c => { c.routes[0].collection.selection = { kind: 'project' }; });
  assert.equal(await collectionGrantHash(current.config, 'fixture', selection), first);
  await update(c => c.routes.push({ ...structuredClone(c.routes[0]), id: 'parent', projectRoot: f.project }));
  assert.equal(await collectionGrantHash(current.config, 'fixture', selection), first);
  await update(c => { c.routes = c.routes.filter(r => r.id !== 'parent'); });
  assert.equal(await collectionGrantHash(current.config, 'fixture', selection), first);
  const originalGeneration = current.config.routes[0].collection.generation;
  await update(c => { c.routes[0].collection.selection = { kind: 'sessions', sessionIds: [otherId] }; });
  await update(c => { c.routes[0].collection.selection.sessionIds.push(sessionId); c.routes[0].collection.generation = originalGeneration; });
  assert.notEqual(await collectionGrantHash(current.config, 'fixture', selection), first);
});
