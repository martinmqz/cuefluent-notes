import fs from 'node:fs/promises';
import path from 'node:path';
import { privacyIdentity, protectNewDirectory } from '../storage-platform.mjs';
import { verifyWorkflowStorage } from '../workflow-storage.mjs';

// Isolated reader/writer fixtures need private roots, not hook registration
// directories or repeated setup inheritance probes. Keep full production setup
// in the setup, ingress, native privacy and detached-package tests.
export async function coreStorageFixture(collection, options) {
  const identity = await privacyIdentity();
  for (const root of [collection.rawDir, collection.intakeStateDir, collection.notes.writerStateDir]) {
    await fs.mkdir(root, { mode: 0o700 }); // A fresh fixture only; never adopt a root.
    await protectNewDirectory(root, identity);
  }
  for (const root of [collection.intakeStateDir, collection.notes.writerStateDir]) {
    await fs.mkdir(path.join(root, 'metadata-stages'), { mode: 0o700 });
  }
  // Use the real verifier and opaque capability. Every read/write still performs
  // its production authorization and native permission checks.
  return verifyWorkflowStorage(options);
}
