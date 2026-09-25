import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { coreStorageFixture } from './core-storage.mjs';
import { openWorkflowIntake } from '../intake-io.mjs';
import { digest } from '../workflow-values.mjs';
const fixtureCapabilities = new WeakMap();

export async function privateIntakeFixture(t, source) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-private-intake-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const collection = { id: 'fixture', rawDir: path.join(root, 'raw'), intakeStateDir: path.join(root, 'state'),
    notes: { notesDir: path.join(root, 'notes'), writerStateDir: path.join(root, 'writer') } };
  const config = { format: 'cuefluent-workflow', schemaVersion: 1, collections: [collection], routes: [
    { id: 'fixture', projectRoot: source.projectRoot, collectionId: 'fixture', clients: [source.client],
      collection: { enabled: true, selection: { kind: 'project' } } }] };
  const configPath = path.join(root, 'workflow.json'), bytes = JSON.stringify(config);
  await fs.writeFile(configPath, bytes, { mode: 0o600 });
  const capability = await coreStorageFixture(collection, { configPath, expectedConfigHash: digest(bytes), collectionId: collection.id });
  const store = await openWorkflowIntake(capability, { client: source.client, sessionId: source.sessionId, cwd: source.projectRoot }, 'collect');
  fixtureCapabilities.set(store, capability); return store;
}

export function rebindIntakeFixture(store, source) {
  return openWorkflowIntake(fixtureCapabilities.get(store), { client: source.client, sessionId: source.sessionId, cwd: source.projectRoot }, 'collect');
}
