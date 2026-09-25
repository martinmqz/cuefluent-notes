import { readBoundedBytes } from './file-io.mjs';
import { absolutePath, workflowDefaults, canonicalWorkflowPath, overlaps } from './workflow-paths.mjs';
import { PACKAGE_ROOT } from './runtime-paths.mjs';
import { keys, choice, list, id, nativeId, unique, fail, digest, string } from './workflow-values.mjs';

export const MAX_WORKFLOW_CONFIG_BYTES = 1024 * 1024;
export const createWorkflowConfig = () => ({ format: 'cuefluent-workflow', schemaVersion: 1, collections: [], routes: [] });

/** Complete validation; returns a fresh normalized value without I/O or consent changes. */
export function validateWorkflowConfig(value, { platform = process.platform } = {}) {
  if (value?.format === 'cuefluent-workflow' && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > 1) fail('WORKFLOW_REQUIRES_UPGRADE');
  keys(value, ['format', 'schemaVersion', 'collections', 'routes']);
  if (value.format !== 'cuefluent-workflow' || value.schemaVersion !== 1) fail('INVALID_WORKFLOW');
  const p = input => absolutePath(input, platform);
  const collections = list(value.collections).map(item => {
    keys(item, ['id', 'rawDir', 'intakeStateDir', 'notes']);
    const n = item.notes;
    keys(n, ['writerStateDir'], ['notesDir', 'destination', 'organization']);
    if (Object.hasOwn(n, 'notesDir') === Object.hasOwn(n, 'destination')) fail('INVALID_WORKFLOW');
    if (n.destination !== undefined && (!/\.(md|markdown)$/i.test(n.destination) || n.organization !== undefined)) fail('INVALID_WORKFLOW');
    return { id: id(item.id), rawDir: p(item.rawDir), intakeStateDir: p(item.intakeStateDir), notes: {
      writerStateDir: p(n.writerStateDir), ...(n.notesDir !== undefined
        ? { notesDir: p(n.notesDir), organization: choice(n.organization === undefined ? 'by-type' : n.organization, ['flat', 'by-type']) }
        : { destination: p(n.destination) }),
    } };
  });
  unique(collections.map(item => item.id));
  const routes = list(value.routes).map(item => {
    keys(item, ['id', 'projectRoot', 'clients', 'collectionId'], ['collection', 'processing', 'excluded']);
    const clients = list(item.clients, 2, { empty: false }).map(client => choice(client, ['codex', 'claude']));
    unique(clients);
    if (!collections.some(collection => collection.id === item.collectionId)) fail('INVALID_WORKFLOW');
    const collect = item.collection === undefined ? {} : item.collection;
    keys(collect, [], ['enabled', 'selection', 'generation']);
    if (collect.generation !== undefined) nativeId(collect.generation);
    if (collect.enabled !== undefined && typeof collect.enabled !== 'boolean') fail('INVALID_WORKFLOW');
    // Session selection is never widened by an absent selector.
    const selection = collect.selection === undefined ? { kind: 'sessions', sessionIds: [] } : collect.selection;
    choice(selection?.kind, ['project', 'sessions']);
    keys(selection, selection.kind === 'project' ? ['kind'] : ['kind', 'sessionIds']);
    if (selection.kind === 'sessions') {
      list(selection.sessionIds).forEach(nativeId); unique(selection.sessionIds);
    }
    const processing = item.processing === undefined ? {} : item.processing;
    keys(processing, [], ['mode', 'scope']);
    if (processing.scope !== undefined) string(processing.scope, 2000);
    if (item.excluded !== undefined && typeof item.excluded !== 'boolean') fail('INVALID_WORKFLOW');
    return { id: id(item.id), projectRoot: p(item.projectRoot), clients, collectionId: id(item.collectionId),
      excluded: item.excluded ?? false,
      collection: { enabled: collect.enabled ?? false, selection: structuredClone(selection),
        ...(collect.generation !== undefined ? { generation: collect.generation } : {}) },
      processing: { mode: choice(processing.mode === undefined ? 'manual' : processing.mode, ['manual', 'prompted', 'automatic']),
        ...(processing.scope !== undefined ? { scope: processing.scope } : {}) },
    };
  });
  unique(routes.map(item => item.id));
  return { format: value.format, schemaVersion: 1, collections, routes };
}

export function workflowConfigPath({ explicit, env = process.env, ...options } = {}) {
  return absolutePath(explicit ?? env.CUEFLUENT_WORKFLOW_CONFIG ?? workflowDefaults({ ...options, env }).configPath, options.platform);
}

/** No legacy lookup, directory creation, or state/source reads. Hash exact inspected bytes. */
export async function readWorkflowSnapshot(file, { packageRoot = PACKAGE_ROOT } = {}) {
  const selected = absolutePath(file);
  let bytes;
  try {
    const canonical = await canonicalWorkflowPath(selected, { directory: false });
    if (overlaps(await canonicalWorkflowPath(packageRoot), canonical)) fail('WORKFLOW_STORAGE_OVERLAP');
    bytes = await readBoundedBytes(selected, { maxBytes: MAX_WORKFLOW_CONFIG_BYTES, missing: true, noFollow: true, utf8: false });
  } catch (error) {
    if (error.code === 'WORKFLOW_STORAGE_OVERLAP') throw error;
    throw Object.assign(new Error('Workflow configuration is unavailable or unsafe.', { cause: error }), { code: 'WORKFLOW_CONFIG_UNAVAILABLE' });
  }
  if (bytes === null) return { config: null, hash: null };
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('INVALID_WORKFLOW'); }
  return { config: validateWorkflowConfig(parsed), hash: digest(bytes) };
}
