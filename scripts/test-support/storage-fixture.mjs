import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareWorkflowStorage, verifyPrivateDirectories } from '../workflow-storage.mjs';
import { privacyIdentity, protectNewDirectory } from '../storage-platform.mjs';
import { digest } from '../workflow-values.mjs';
import { coreStorageFixture } from './core-storage.mjs';

export async function storageFixture(t, { privateConfig = false, fullSetup = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-private-')));
  // Detached native children can briefly retain their cwd after publication.
  // Retry only owned-fixture teardown; assertion failures still propagate.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const collection = { id: 'fixture', rawDir: path.join(root, 'raw'), intakeStateDir: path.join(root, 'state'),
    notes: { notesDir: path.join(root, 'notes'), writerStateDir: path.join(root, 'writer') } };
  const config = { format: 'cuefluent-workflow', schemaVersion: 1, collections: [collection],
    routes: [{ id: 'fixture', projectRoot: project, clients: ['codex', 'claude'], collectionId: 'fixture',
      collection: { enabled: true, selection: { kind: 'project' }, generation: randomUUID() }, processing: { mode: 'manual' } }] };
  const configDir = privateConfig ? path.join(root, 'config') : root;
  if (privateConfig) {
    // Settings updates require a protected parent, not Windows' inherited temp ACL.
    // Only protect this new empty fixture directory, never an existing directory.
    await fs.mkdir(configDir, { mode: 0o700 });
    await protectNewDirectory(configDir, await privacyIdentity());
    await verifyPrivateDirectories([configDir]);
  }
  const configPath = path.join(configDir, 'workflow.json'), bytes = JSON.stringify(config);
  await fs.writeFile(configPath, bytes, { mode: 0o600 });
  const options = { configPath, expectedConfigHash: digest(bytes), collectionId: collection.id };
  return { root, project, collection, config, options, capability: await (fullSetup ? prepareWorkflowStorage(options) : coreStorageFixture(collection, options)) };
}
