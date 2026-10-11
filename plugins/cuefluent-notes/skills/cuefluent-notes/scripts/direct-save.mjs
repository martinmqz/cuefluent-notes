import path from 'node:path';
import { applyPlan } from './safe-update.mjs';
import { assertWorkflowStorage, assertPrivatePaths } from './workflow-storage.mjs';
import { outputPath } from './processing-proposal.mjs';
import { canonicalJSON, digest, fail, keys, hash, list } from './workflow-values.mjs';

/** Direct user-selected material does not need session capture, native identity,
 * a processing disposition or setup. It still uses the collection's one writer. */
export async function saveDirectNote({ plan, approvedPlanHash }, capability = null) {
  hash(approvedPlanHash);
  if (digest(canonicalJSON(plan)) !== approvedPlanHash) fail('DIRECT_PROPOSAL_CHANGED');
  keys(plan, ['version', 'mode', 'root', 'stateDir', 'files'],
    ['directories', 'createDirectories', 'expectedManifestHash']);
  list(plan.files, 100, { empty: false });
  for (const file of plan.files) {
    keys(file, ['path', 'expectedHash', 'contentPath', 'expectedContentHash'], ['sources', 'entries']);
    outputPath(file.path); hash(file.expectedContentHash); if (file.expectedHash !== null) hash(file.expectedHash);
  }
  const authorize = async (privatePaths = []) => {
    if (!capability) return;
    const { notes } = await assertWorkflowStorage(capability);
    if (privatePaths.length) await assertPrivatePaths(capability, privatePaths);
    if (plan.root !== (notes.notesDir ?? path.dirname(notes.destination)) || plan.stateDir !== notes.writerStateDir ||
        plan.files.some(file => (notes.destination && path.join(plan.root, file.path) !== notes.destination) ||
          (notes.organization === 'flat' && file.path.includes('/')))) fail('DIRECT_DESTINATION_MISMATCH');
  };
  await authorize();
  return applyPlan(plan, { authorize });
}
