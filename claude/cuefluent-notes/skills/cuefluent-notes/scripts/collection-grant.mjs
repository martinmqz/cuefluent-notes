import { randomUUID } from 'node:crypto';
import { canonicalWorkflowPath, inside } from './workflow-paths.mjs';
import { canonicalJSON, digest, fail, nativeId, choice } from './workflow-values.mjs';

async function descriptor(config, route) {
  const collection = config.collections.find(item => item.id === route.collectionId);
  const [projectRoot, rawDir, intakeStateDir] = await Promise.all([
    canonicalWorkflowPath(route.projectRoot), canonicalWorkflowPath(collection.rawDir), canonicalWorkflowPath(collection.intakeStateDir),
  ]);
  return { id: route.id, projectRoot, clients: [...route.clients].sort(), collectionId: collection.id,
    rawDir, intakeStateDir, excluded: route.excluded, enabled: route.collection.enabled,
    selection: route.collection.selection.kind === 'project' ? { kind: 'project' }
      : { kind: 'sessions', sessionIds: [...route.collection.selection.sessionIds].sort() } };
}
async function descriptors(config) {
  return new Map(await Promise.all((config?.routes ?? []).map(async route => [route.id, await descriptor(config, route)])));
}
const fixedBinding = ({ clients: _clients, selection: _selection, ...binding }) => binding;
const subset = (before, after) => before.every(value => after.includes(value));
const widens = (before, after) => after.kind === 'project' ||
  (before.kind === 'sessions' && after.kind === 'sessions' && subset(before.sessionIds, after.sessionIds));
function routingHazards(all, own, priorClients) {
  // Strict ancestors cannot shadow this route. Descendants can interrupt it
  // even when disabled or selecting no sessions; preserve denial round trips.
  return [...all.values()].filter(other => other.id !== own.id && inside(own.projectRoot, other.projectRoot) &&
    other.clients.some(client => priorClients.includes(client)))
    .map(other => ({ ...other, clients: other.clients.filter(client => priorClients.includes(client)) }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function preserves(before, after, routeId) {
  const old = before?.get(routeId), next = after.get(routeId);
  return old && canonicalJSON(fixedBinding(old)) === canonicalJSON(fixedBinding(next)) &&
    subset(old.clients, next.clients) && widens(old.selection, next.selection) &&
    canonicalJSON(routingHazards(before, old, old.clients)) === canonicalJSON(routingHazards(after, next, old.clients));
}

/** Configure owns generations. Widening does not retire existing members;
 * narrowing/binding changes cannot restore old grants through an A-B-A edit. */
export async function assignCollectionGenerations(previous, proposed) {
  // Removing a broken old binding must remain possible. Unknown old paths
  // cannot preserve any grant; the complete proposed placement is still checked.
  const [before, after] = await Promise.all([descriptors(previous).catch(() => null), descriptors(proposed)]);
  const result = structuredClone(proposed);
  for (const route of result.routes) {
    const old = previous?.routes.find(item => item.id === route.id);
    route.collection.generation = old?.collection.generation && preserves(before, after, route.id)
      ? old.collection.generation : randomUUID();
  }
  return result;
}

/** Relevant native membership, not the whole config or other members' IDs.
 * Fresh whole-config capability/CAS checks remain mandatory independently. */
export async function collectionGrantHash(config, routeId, { client, sessionId }) {
  choice(client, ['codex', 'claude']); nativeId(sessionId);
  const route = config.routes.find(item => item.id === routeId);
  if (!route?.collection.generation) fail('COLLECTION_GRANT_REQUIRES_SETUP');
  nativeId(route.collection.generation);
  const own = await descriptor(config, route);
  return digest(canonicalJSON({ generation: route.collection.generation, binding: fixedBinding(own), client, sessionId,
    clientAllowed: own.clients.includes(client), sessionAllowed: own.selection.kind === 'project' || own.selection.sessionIds.includes(sessionId) }));
}
