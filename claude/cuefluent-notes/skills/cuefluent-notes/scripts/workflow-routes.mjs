import { validateWorkflowConfig } from './workflow-config.mjs';
import { absolutePath, inside, canonicalWorkflowProject } from './workflow-paths.mjs';
import { choice, nativeId, fail } from './workflow-values.mjs';

async function canonicalDirectory(file) {
  try { return await canonicalWorkflowProject(file); }
  catch (error) { if (error.code === 'UNSAFE_WORKFLOW_PATH') fail('WORKFLOW_ROUTE_UNAVAILABLE'); throw error; }
}

/** Select routing only. Never inspect capture state, writer journals, or transcripts. */
export async function resolveWorkflowRoute(config, { client, cwd, sessionId }, { canonicalize = canonicalDirectory } = {}) {
  choice(client, ['codex', 'claude']); nativeId(sessionId); absolutePath(cwd);
  if (config === null) return { status: 'unconfigured', route: null };
  const validated = validateWorkflowConfig(config);
  const applicable = validated.routes.filter(route => route.clients.includes(client));
  if (!applicable.length) return { status: 'unconfigured', route: null };
  const directory = await canonicalize(cwd);
  const matches = [];
  for (const route of applicable) {
    let root;
    try { root = await canonicalize(route.projectRoot); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      // Unknown root aliases could hide a narrower denial. Do not fall through.
      fail('WORKFLOW_ROUTE_UNAVAILABLE');
    }
    // A missing suffix has no canonical case on default macOS volumes. Do not
    // let an ambiguously spelled narrow denial fall through to its ancestor.
    if (process.platform === 'darwin' && inside(root.toLowerCase(), directory.toLowerCase()) && !inside(root, directory)) fail('WORKFLOW_ROUTE_UNAVAILABLE');
    if (inside(root, directory)) matches.push({ ...route, projectRoot: root });
  }
  matches.sort((a, b) => b.projectRoot.length - a.projectRoot.length);
  if (matches.length > 1 && inside(matches[0].projectRoot, matches[1].projectRoot) &&
      inside(matches[1].projectRoot, matches[0].projectRoot)) fail('AMBIGUOUS_WORKFLOW_ROUTE');
  const route = matches[0];
  if (!route) return { status: 'unconfigured', route: null };
  const selection = route.collection.selection;
  return { status: route.excluded ? 'excluded' : 'selected', route,
    collection: validated.collections.find(item => item.id === route.collectionId),
    intended: {
      collect: !route.excluded && route.collection.enabled &&
        (selection.kind === 'project' || selection.sessionIds.includes(sessionId)),
      process: !route.excluded && route.processing.mode !== 'manual',
      explicitProcess: !route.excluded,
      explicitCollect: !route.excluded,
    },
    // Slice 1 grants no runtime storage capability, even for an enabled policy.
    runtime: { collect: false, process: false, reason: 'STORAGE_NOT_VERIFIED' },
  };
}
