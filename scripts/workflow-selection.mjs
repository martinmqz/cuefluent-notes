import { validateProcessingSelection } from './processing-contract.mjs';
import { canonicalWorkflowProject } from './workflow-paths.mjs';

/** Resolve user spelling once without requiring an already-bound workspace to
 * still exist. This does not grant permission or establish native identity. */
export async function normalizeWorkflowSelection(value) {
  const selection = validateProcessingSelection({ ...value, unitId: value?.unitId ?? null });
  return { ...selection, cwd: await canonicalWorkflowProject(selection.cwd) };
}

/** Match source membership without treating cwd or selection as authorization. */
export const selectionIncludesIdentity = (selection, identity) => identity.client === selection.client &&
  identity.sessionId === selection.sessionId && (!selection.unitId || identity.unitId === selection.unitId);
