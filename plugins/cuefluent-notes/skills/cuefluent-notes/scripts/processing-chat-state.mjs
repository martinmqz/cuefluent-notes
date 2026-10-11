import fs from 'node:fs/promises';
import path from 'node:path';
import { workflowProcessingContext } from './workflow-storage.mjs';
import { canonicalWorkflowPath } from './workflow-paths.mjs';
import { readWorkflowSnapshot } from './workflow-config.mjs';
import { withStorageProbes } from './storage-platform.mjs';
import { openWorkflowIntake, intakePath, intakeSnapshot, intakeJSON, withIntakeLock, replaceIntakeJSON } from './intake-io.mjs';
import { lstatOrNull } from './file-io.mjs';
import { checkWorkflowBudget } from './workflow-budget.mjs';
import { validateProcessingSelection } from './processing-contract.mjs';
import { CLIENTS, canonicalJSON, digest, fail, keys, hash, nativeId, string, choice, integer, list, unique, object } from './workflow-values.mjs';

export const PROCESSING_CHAT_STATE_VERSION = 1;
export const MAX_PROCESSING_CHAT_BINDINGS = 64;
export const MAX_PROCESSING_CHAT_RUNS = 128;
const MAX_BYTES = 256 * 1024;
const MAX_DESCRIPTOR_BYTES = 8 * 1024;
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const generation = value => { integer(value); if (value < 1) fail('PROCESSING_CHAT_GENERATION_CHANGED'); return value; };
const expected = value => { if (value !== null) hash(value); };
const nativeToken = value => {
  string(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail('INVALID_PROCESSING_CHAT_NATIVE_ID');
  return value;
};
const nullableId = value => { if (value !== null) nativeId(value); };
const STATES = ['creating', 'idle', 'busy', 'awaiting-review', 'blocked'];
const BLOCKS = ['creation-outcome-unknown', 'dispatch-outcome-unknown', 'operation-outcome-unknown', 'host-unavailable', 'session-unavailable', 'binding-conflict', 'creation-not-dispatched', 'run-abandoned'];

function namespaceValue(value) {
  keys(value, ['configPath', 'collectionId', 'client', 'hostId', 'profileId']);
  string(value.configPath); if (!path.isAbsolute(value.configPath)) fail('INVALID_PROCESSING_CHAT_STATE');
  string(value.collectionId, 64); choice(value.client, CLIENTS); hash(value.hostId); hash(value.profileId);
}
function sessionValue(value, context) {
  keys(value, ['sessionId', 'sessionHash', 'descriptor', 'verification']); nativeId(value.sessionId); hash(value.sessionHash);
  choice(value.verification, ['reserved', 'verified']);
  // The host verifier owns the client-specific descriptor schema. Persist only a
  // bounded canonical JSON object; no caller-provided path becomes authority.
  if (!object(value.descriptor) || value.descriptor.sessionId !== value.sessionId ||
      value.descriptor.client !== context.client || value.descriptor.profileId !== context.profileId) fail('INVALID_PROCESSING_CHAT_STATE');
  const bytes = canonicalJSON(value.descriptor);
  if (Buffer.byteLength(bytes) > MAX_DESCRIPTOR_BYTES || digest(bytes) !== value.sessionHash) fail('INVALID_PROCESSING_CHAT_STATE');
}
function sameSession(a, b) {
  return a.sessionId === b.sessionId && a.sessionHash === b.sessionHash && equal(a.descriptor, b.descriptor);
}
function nativeRunValue(value, client) {
  keys(value, ['runId', 'inputId', 'unitIds'], ['terminal']); nativeToken(value.runId); nativeToken(value.inputId);
  if (value.terminal !== undefined) choice(value.terminal, ['completed', 'interrupted', 'failed']);
  list(value.unitIds, 16, { empty: client === 'claude' }).forEach(nativeId); unique(value.unitIds);
}
function requestValue(value) {
  keys(value, ['requestId', 'inputHash', 'operationId', 'worksetId', 'selection'], ['owner']);
  nativeId(value.requestId); hash(value.inputHash); nullableId(value.operationId); nullableId(value.worksetId);
  if (value.selection !== null) validateProcessingSelection(value.selection);
  if (value.owner !== undefined) {
    keys(value.owner, ['pid', 'controllerId', 'hostname', 'boot', 'processStart', 'platform']);
    integer(value.owner.pid); if (value.owner.pid < 1) fail('INVALID_PROCESSING_CHAT_STATE');
    nativeId(value.owner.controllerId); string(value.owner.hostname); string(value.owner.platform);
    if (value.owner.boot !== null) string(value.owner.boot);
    if (value.owner.processStart !== null) string(value.owner.processStart);
  }
}
const requestEqual = (a, b) => { const { owner: _a, ...left } = a, { owner: _b, ...right } = b; return equal(left, right); };
function runValue(run, client) {
  keys(run, ['request', 'native', 'outcome', 'reviewOperationId', 'reviewResolved'], ['diagnostics']);
  requestValue(run.request); nativeRunValue(run.native, client); choice(run.outcome, ['idle', 'awaiting-review', 'needs-inspection']);
  nullableId(run.reviewOperationId);
  if (typeof run.reviewResolved !== 'boolean' || (run.outcome !== 'idle') !== (run.reviewOperationId !== null) ||
    (run.outcome !== 'awaiting-review' && run.reviewResolved)) fail('INVALID_PROCESSING_CHAT_STATE');
  if (run.diagnostics !== undefined) list(run.diagnostics, 1).forEach(code => choice(code, ['PROCESSING_EXCLUSION_UNVERIFIED']));
}
function validateState(value, namespace, bindingHash) {
  try {
    keys(value, ['format', 'version', 'namespace', 'bindingHash', 'policyHash', 'generation', 'revision', 'state', 'creation', 'session', 'active', 'runs', 'block']);
    if (value.format !== 'cuefluent-processing-chat' || value.version !== PROCESSING_CHAT_STATE_VERSION) fail('INVALID_PROCESSING_CHAT_STATE');
    namespaceValue(value.namespace); hash(value.bindingHash); hash(value.policyHash); generation(value.generation); integer(value.revision);
    choice(value.state, STATES); keys(value.creation, ['requestId', 'requestHash'], ['owner']);
    if (value.creation.owner !== undefined) requestValue({ requestId: value.creation.requestId, inputHash: value.creation.requestHash, operationId: null, worksetId: null, selection: null, owner: value.creation.owner });
    nativeId(value.creation.requestId); hash(value.creation.requestHash);
    if (value.session !== null) {
      sessionValue(value.session, value.namespace);
      if (value.session.verification === 'reserved' && (value.namespace.client !== 'claude' || value.runs.length)) fail('INVALID_PROCESSING_CHAT_STATE');
    }
    if (value.active !== null) requestValue(value.active);
    list(value.runs, MAX_PROCESSING_CHAT_RUNS).forEach(run => runValue(run, value.namespace.client));
    unique(value.runs.map(run => run.request.requestId)); unique(value.runs.map(run => run.native.runId)); unique(value.runs.map(run => run.native.inputId));
    unique(value.runs.flatMap(run => run.native.unitIds));
    if (value.active !== null && value.runs.some(run => run.request.requestId === value.active.requestId)) fail('INVALID_PROCESSING_CHAT_STATE');
    if (value.block !== null) { keys(value.block, ['reason']); choice(value.block.reason, BLOCKS); }
    if ((value.state === 'blocked') !== (value.block !== null)) fail('INVALID_PROCESSING_CHAT_STATE');
    if (value.state === 'creating' && (value.session !== null || value.active !== null || value.runs.length)) fail('INVALID_PROCESSING_CHAT_STATE');
    if (['idle', 'busy', 'awaiting-review'].includes(value.state) && value.session === null) fail('INVALID_PROCESSING_CHAT_STATE');
    if ((value.state === 'busy') !== (value.active !== null && value.state !== 'blocked')) fail('INVALID_PROCESSING_CHAT_STATE');
    if (value.session === null && (value.active !== null || value.runs.length)) fail('INVALID_PROCESSING_CHAT_STATE');
    if (['creation-outcome-unknown', 'creation-not-dispatched'].includes(value.block?.reason) && value.session !== null) fail('INVALID_PROCESSING_CHAT_STATE');
    if (value.block?.reason === 'dispatch-outcome-unknown' && value.active === null) fail('INVALID_PROCESSING_CHAT_STATE');
    const uninspected = value.runs.filter(run => run.outcome === 'needs-inspection');
    if (uninspected.length > 1 || (uninspected.length && uninspected[0] !== value.runs.at(-1)) ||
      (uninspected.length > 0) !== (value.block?.reason === 'operation-outcome-unknown')) fail('INVALID_PROCESSING_CHAT_STATE');
    const unresolved = value.runs.filter(run => run.outcome === 'awaiting-review' && !run.reviewResolved);
    if (unresolved.length > 1 || (unresolved.length && unresolved[0] !== value.runs.at(-1)) ||
      (value.state === 'awaiting-review' && !unresolved.length) ||
      (unresolved.length && !['awaiting-review', 'blocked'].includes(value.state))) fail('INVALID_PROCESSING_CHAT_STATE');
  } catch (error) {
    if (error.code === 'INVALID_PROCESSING_CHAT_STATE') throw error;
    fail('INVALID_PROCESSING_CHAT_STATE');
  }
  if (!equal(value.namespace, namespace) || value.bindingHash !== bindingHash) fail('PROCESSING_CHAT_BINDING_CHANGED');
  return value;
}

/** Internal controller-only registry. Verifiers are host adapter functions, never
 * JSON flags supplied by an agent. Stored bindings/descriptors grant no exclusion,
 * capture, processing, approval or writer authority. No callback runs under a lock.
 *
 * verifySession(input) returns input's client/hostId/profileId/sessionId plus
 * descriptor, its canonical sessionHash, and verification (verified, or reserved only
 * for a controller-owned Claude UUID before first dispatch). A reserved UUID
 * does not establish native existence or collection exclusion. Completion must
 * freshly verify that same descriptor as native before releasing it for reuse.
 * verifyRun(input) returns
 * client/hostId/profileId/sessionId/requestId/inputHash plus nativeRun, all freshly
 * bound by the host. verifyReview(input) returns its request fields plus state:
 * completed, recoveryRequired:false and the authoritative engine outcome. Callers
 * must establish those proofs outside this registry.
 */
export async function createProcessingChatState(options) {
  keys(options, ['capability', 'configPath', 'client', 'hostId', 'profileId', 'verifySession', 'verifyRun', 'verifyReview'], ['verifyAbort', 'verifyAbandon', 'reuseHost']);
  let { capability, configPath, client, hostId, profileId, verifySession, verifyRun, verifyReview } = options;
  choice(client, CLIENTS); hash(hostId); hash(profileId);
  if ([verifySession, verifyRun, verifyReview].some(verify => typeof verify !== 'function')) fail('PROCESSING_CHAT_VERIFIER_REQUIRED');
  const initial = await withStorageProbes(() => workflowProcessingContext(capability));
  configPath = await canonicalWorkflowPath(configPath, { directory: false, allowMissing: false });
  if ((await readWorkflowSnapshot(configPath)).hash !== initial.configHash) fail('WORKFLOW_POLICY_CHANGED');
  const store = await withStorageProbes(() => openWorkflowIntake(capability));
  // Existing machine-local bindings survive a hostname change. Never choose
  // between two matching historical namespaces or silently hide either one.
  if (options.reuseHost) {
    const directory = path.dirname(await intakePath(store, 'state', 'processing-chats/probe.json'));
    const matches = []; let count = 0;
    if (await lstatOrNull(directory)) for await (const entry of await fs.opendir(directory)) {
      checkWorkflowBudget();
      if (++count > MAX_PROCESSING_CHAT_BINDINGS || !entry.isFile() || !/^[a-f0-9]{20}\.json$/.test(entry.name)) fail('INVALID_PROCESSING_CHAT_STATE');
      const saved = await intakeSnapshot(store, 'state', `processing-chats/${entry.name}`, { maxBytes: MAX_BYTES });
      const value = intakeJSON(saved), ns = value?.namespace;
      if (ns?.configPath !== configPath || ns.collectionId !== initial.collection.id || ns.client !== client || ns.profileId !== profileId) continue;
      validateState(value, ns, initial.hash);
      if (entry.name !== `${digest(canonicalJSON(ns)).slice(0, 20)}.json` || !saved.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('INVALID_PROCESSING_CHAT_STATE');
      matches.push(ns.hostId);
    }
    if (matches.length > 1) fail('PROCESSING_CHAT_BINDING_CHANGED');
    if (matches.length) [hostId] = matches;
  }
  const namespace = Object.freeze({ configPath, collectionId: initial.collection.id, client, hostId, profileId });
  const namespaceHash = digest(canonicalJSON(namespace)), name = `processing-chats/${namespaceHash.slice(0, 20)}.json`;
  const host = Object.freeze({ client, hostId, profileId });
  const archivePath = requestId => `processing-chat-history/${namespaceHash}/${nativeId(requestId)}.json`;
  const abandonedPath = requestId => `processing-chat-abandoned/${namespaceHash}/${nativeId(requestId)}.json`;
  const nativeArchivePath = token => `processing-chat-native-history/${namespaceHash}/${digest(token)}.json`;
  async function archived(requestId) {
    return withStorageProbes(async () => {
    const saved = await intakeSnapshot(store, 'state', archivePath(requestId), { maxBytes: 16 * 1024 });
    if (!saved.bytes) return null;
    const value = intakeJSON(saved);
    keys(value, ['namespaceHash', 'bindingHash', 'run']);
    if (value.namespaceHash !== namespaceHash || value.bindingHash !== initial.hash) fail('PROCESSING_CHAT_BINDING_CHANGED');
    runValue(value.run, client);
    if (value.run.request.requestId !== requestId || !saved.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('INVALID_PROCESSING_CHAT_STATE');
    return value.run;
    });
  }

  async function guard() {
    const context = await workflowProcessingContext(capability);
    if (context.hash !== initial.hash) fail('PROCESSING_CHAT_BINDING_CHANGED');
    if (await canonicalWorkflowPath(configPath, { directory: false, allowMissing: false }) !== namespace.configPath ||
      (await readWorkflowSnapshot(configPath)).hash !== context.configHash) fail('WORKFLOW_POLICY_CHANGED');
  }
  async function snapshot() {
    await guard();
    const saved = await intakeSnapshot(store, 'state', name, { maxBytes: MAX_BYTES });
    let value = null;
    if (saved.bytes !== null) {
      value = validateState(intakeJSON(saved), namespace, initial.hash);
      // Only helper-authored canonical bytes are accepted. This also rejects
      // duplicate JSON keys without accepting their last value as authority.
      if (!saved.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('INVALID_PROCESSING_CHAT_STATE');
    }
    await guard();
    return { hash: saved.hash, value };
  }
  function view(saved, action = 'inspect') {
    return { interfaceVersion: 1, namespaceHash, hash: saved.hash, state: saved.value?.state ?? 'missing',
      policyState: saved.value === null || saved.value.policyHash === initial.configHash ? 'current' : 'changed',
      policyHash: saved.value?.policyHash ?? null,
      generation: saved.value?.generation ?? null, action, registry: structuredClone(saved.value),
      limitation: 'Controller metadata only; no collection exclusion or processing approval is granted.' };
  }
  function existingAction(value) {
    if (!value.session) return 'reconcile-creation';
    if (value.state === 'idle') return 'reuse';
    if (value.state === 'busy') return 'reconcile-run';
    if (value.state === 'awaiting-review') return 'review-existing';
    return 'inspect-existing';
  }
  function current(saved, expectedHash, expectedGeneration) {
    expected(expectedHash);
    if (saved.hash !== expectedHash) fail('PROCESSING_CHAT_STATE_CHANGED');
    if (expectedGeneration !== undefined && saved.value?.generation !== generation(expectedGeneration)) fail('PROCESSING_CHAT_GENERATION_CHANGED');
    if (saved.value && saved.value.policyHash !== initial.configHash) fail('PROCESSING_CHAT_POLICY_CHANGED');
  }
  async function write(tx, saved, value, action) {
    value.revision++;
    validateState(value, namespace, initial.hash);
    if (Buffer.byteLength(canonicalJSON(value) + '\n') > MAX_BYTES) fail('PROCESSING_CHAT_CAPACITY');
    await guard();
    const hash = await replaceIntakeJSON(tx, name, value, saved.hash);
    return view({ hash, value }, action);
  }
  const locked = run => withStorageProbes(() => withIntakeLock(store, async tx => run(tx, await snapshot())));
  function matchSession(value, sessionId) {
    if (!object(value) || !equal({ client: value.client, hostId: value.hostId, profileId: value.profileId, sessionId: value.sessionId }, { ...host, sessionId })) fail('PROCESSING_CHAT_NATIVE_UNVERIFIED');
    keys(value, ['client', 'hostId', 'profileId', 'sessionId', 'sessionHash', 'descriptor', 'verification']);
    const session = { sessionId: value.sessionId, sessionHash: value.sessionHash, descriptor: structuredClone(value.descriptor), verification: value.verification };
    sessionValue(session, host);
    if (session.verification === 'reserved' && client !== 'claude') fail('PROCESSING_CHAT_NATIVE_UNVERIFIED');
    return session;
  }
  async function countBindings() {
    const parent = path.dirname(await intakePath(store, 'state', name));
    if (!await lstatOrNull(parent)) return;
    let count = 0;
    for await (const entry of await fs.opendir(parent)) {
      checkWorkflowBudget();
      if (!entry.isFile() || !/^[a-f0-9]{20}\.json$/.test(entry.name)) fail('INVALID_PROCESSING_CHAT_STATE');
      if (++count >= MAX_PROCESSING_CHAT_BINDINGS) fail('PROCESSING_CHAT_BINDINGS_FULL',
        'Processing chat binding capacity reached. Further bindings need reviewed registry maintenance; existing records were preserved.');
    }
  }

  async function archiveRuns(tx, runs) {
    for (const run of runs) {
      const old = await archived(run.request.requestId);
      if (old && !equal(old, run)) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
      if (!old) await replaceIntakeJSON(tx, archivePath(run.request.requestId), { namespaceHash, bindingHash: initial.hash, run }, null);
      for (const token of new Set([run.native.runId, run.native.inputId, ...run.native.unitIds])) {
        const name = nativeArchivePath(token), snapshot = await intakeSnapshot(store, 'state', name, { maxBytes: 1024 });
        const value = { namespaceHash, token, requestId: run.request.requestId };
        if (snapshot.bytes && !snapshot.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('PROCESSING_CHAT_NATIVE_CONFLICT');
        if (!snapshot.bytes) await replaceIntakeJSON(tx, name, value, null);
      }
    }
  }

  return Object.freeze({
    async read() { return withStorageProbes(async () => view(await snapshot())); },
    async findRequest(requestId) {
      nativeId(requestId);
      return withStorageProbes(async () => {
        if ((await intakeSnapshot(store, 'state', abandonedPath(requestId), { maxBytes: MAX_BYTES })).bytes) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
        const saved = await snapshot(), run = saved.value?.runs.find(row => row.request.requestId === requestId) ?? await archived(requestId);
        await guard(); return run === null ? null : structuredClone(run);
      });
    },
    async reauthorize(args) {
      keys(args, ['expectedHash', 'previousPolicyHash']); expected(args.expectedHash); hash(args.previousPolicyHash);
      return locked((tx, saved) => {
        if (!saved.value || saved.hash !== args.expectedHash) fail('PROCESSING_CHAT_STATE_CHANGED');
        if (saved.value.policyHash !== args.previousPolicyHash) fail('PROCESSING_CHAT_POLICY_CHANGED');
        if (saved.value.policyHash === initial.configHash) return view(saved);
        return write(tx, saved, { ...saved.value, policyHash: initial.configHash, generation: saved.value.generation + 1 }, 'inspect');
      });
    },
    async rollover(args) {
      keys(args, ['expectedHash']); expected(args.expectedHash);
      return locked(async (tx, saved) => {
        current(saved, args.expectedHash);
        if (!saved.value || saved.value.state !== 'idle' || saved.value.active ||
          saved.value.runs.some(run => run.outcome === 'awaiting-review' && !run.reviewResolved)) fail('PROCESSING_CHAT_BUSY');
        if (!saved.value.runs.length) return view(saved, 'reuse');
        // Publish immutable keyed history before removing it from the hot row.
        // A failed rollover leaves hot history intact; exact retry reuses bytes.
        await archiveRuns(tx, saved.value.runs);
        return write(tx, saved, { ...saved.value, runs: [], generation: saved.value.generation + 1 }, 'reuse');
      });
    },
    async abandon(args) {
      keys(args, ['expectedHash', 'requestId', 'offline']); hash(args.expectedHash); nativeId(args.requestId);
      if (args.offline !== true || typeof options.verifyAbandon !== 'function') fail('PROCESSING_CHAT_ABANDON_UNPROVEN');
      const before = await withStorageProbes(() => snapshot()); current(before, args.expectedHash);
      const value = before.value;
      if (!value || !['creating', 'busy', 'blocked'].includes(value.state) ||
          (value.state === 'blocked' && !['creation-outcome-unknown', 'dispatch-outcome-unknown'].includes(value.block.reason)) ||
          (value.active?.requestId ?? value.creation.requestId) !== args.requestId) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
      if (!await options.verifyAbandon(value.active?.owner ?? value.creation.owner)) fail('PROCESSING_CHAT_BUSY');
      return locked(async (tx, saved) => {
        current(saved, args.expectedHash);
        const name = abandonedPath(args.requestId), old = await intakeSnapshot(store, 'state', name, { maxBytes: MAX_BYTES });
        if (old.bytes && !old.bytes.equals(Buffer.from(canonicalJSON(value) + '\n'))) fail('PROCESSING_CHAT_STATE_CHANGED');
        if (!old.bytes) await replaceIntakeJSON(tx, name, value, null);
        await archiveRuns(tx, value.runs);
        // Retire only the controller binding. Claims, proposals, receipts and
        // native evidence remain untouched and must use their own recovery.
        return write(tx, saved, { ...value, state: 'blocked', block: { reason: 'run-abandoned' } }, 'inspect-existing');
      });
    },
    async abort(args) {
      keys(args, ['expectedHash', 'generation', 'requestId']); expected(args.expectedHash); generation(args.generation); nativeId(args.requestId);
      const before = await withStorageProbes(() => snapshot());
      current(before, args.expectedHash, args.generation);
      if (before.value?.state !== 'busy' || before.value.active?.requestId !== args.requestId ||
        typeof options.verifyAbort !== 'function' || await options.verifyAbort({ requestId: args.requestId }) !== true) fail('PROCESSING_CHAT_ABORT_UNPROVEN');
      return locked((tx, saved) => {
        current(saved, args.expectedHash, args.generation);
        return write(tx, saved, { ...saved.value, active: null, state: 'idle', block: null }, 'retry-not-dispatched');
      });
    },
    async reserve(args) {
      args = structuredClone(args);
      keys(args, ['expectedHash', 'requestId', 'requestHash'], ['owner']); expected(args.expectedHash); nativeId(args.requestId); hash(args.requestHash);
      return locked(async (tx, saved) => {
        if ((await intakeSnapshot(store, 'state', abandonedPath(args.requestId), { maxBytes: MAX_BYTES })).bytes) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
        const retryable = saved.value?.state === 'blocked' && ['creation-not-dispatched', 'run-abandoned'].includes(saved.value.block.reason);
        if (saved.value !== null && !retryable) {
          if (saved.value.policyHash !== initial.configHash) fail('PROCESSING_CHAT_POLICY_CHANGED');
          if (saved.value.creation.requestId === args.requestId) {
            if (saved.value.creation.requestHash !== args.requestHash) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
            return view(saved, existingAction(saved.value));
          }
          current(saved, args.expectedHash);
          return view(saved, existingAction(saved.value));
        }
        current(saved, args.expectedHash); if (!saved.value) await countBindings();
        return write(tx, saved, { format: 'cuefluent-processing-chat', version: PROCESSING_CHAT_STATE_VERSION,
          namespace: { ...namespace }, bindingHash: initial.hash, policyHash: initial.configHash, generation: (saved.value?.generation ?? 0) + 1, revision: saved.value?.revision ?? 0,
          state: 'creating', creation: { requestId: args.requestId, requestHash: args.requestHash, ...(args.owner ? { owner: args.owner } : {}) }, session: null, active: null, runs: [], block: null }, 'create');
      });
    },
    async bind(args) {
      args = structuredClone(args);
      keys(args, ['expectedHash', 'generation', 'requestId', 'sessionId']); expected(args.expectedHash); generation(args.generation); nativeId(args.requestId); nativeId(args.sessionId);
      const before = await withStorageProbes(() => snapshot());
      if (!before.value || before.value.creation.requestId !== args.requestId) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
      current(before, args.expectedHash, args.generation);
      if (before.value.session && before.value.session.sessionId !== args.sessionId) fail('PROCESSING_CHAT_NATIVE_CONFLICT');
      const session = matchSession(await verifySession({ ...host, sessionId: args.sessionId, generation: args.generation, requestId: args.requestId }), args.sessionId);
      return locked(async (tx, saved) => {
        current(saved, args.expectedHash, args.generation);
        if (saved.value.creation.requestId !== args.requestId) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
        if (saved.value.session !== null) {
          if (!equal(saved.value.session, session)) fail('PROCESSING_CHAT_NATIVE_CONFLICT');
          return view(saved, existingAction(saved.value));
        }
        if (saved.value.state !== 'creating' && !(saved.value.state === 'blocked' && saved.value.block.reason === 'creation-outcome-unknown')) fail('PROCESSING_CHAT_BLOCKED');
        return write(tx, saved, { ...saved.value, session, state: 'idle', block: null }, 'reuse');
      });
    },
    async begin(args) {
      args = structuredClone(args);
      keys(args, ['expectedHash', 'generation', 'requestId', 'inputHash'], ['operationId', 'worksetId', 'selection', 'owner']);
      expected(args.expectedHash); generation(args.generation);
      const request = { requestId: args.requestId, inputHash: args.inputHash, operationId: args.operationId ?? null,
        worksetId: args.worksetId ?? null, selection: args.selection ?? null, ...(args.owner ? { owner: args.owner } : {}) }; requestValue(request);
      const before = await withStorageProbes(() => snapshot());
      if (!before.value?.session) fail('PROCESSING_CHAT_NOT_BOUND');
      if (before.value.generation !== args.generation) fail('PROCESSING_CHAT_GENERATION_CHANGED');
      const prior = before.value.runs.find(run => run.request.requestId === args.requestId) ?? await archived(args.requestId);
      if (prior || before.value.active?.requestId === args.requestId) {
        if (!requestEqual(prior?.request ?? before.value.active, request)) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
        if (before.value.policyHash !== initial.configHash) fail('PROCESSING_CHAT_POLICY_CHANGED');
        return view(before, prior ? 'already-finished' : 'reconcile-run');
      }
      current(before, args.expectedHash, args.generation);
      if (before.value.state !== 'idle') return view(before, before.value.state === 'awaiting-review' ? 'review-existing' : 'inspect-existing');
      if (before.value.runs.length >= MAX_PROCESSING_CHAT_RUNS) fail('PROCESSING_CHAT_HISTORY_FULL',
        'Processing chat history capacity reached. Reviewed retention or rollover is required; no records were removed and no replacement chat was created.');
      const session = matchSession(await verifySession({ ...host, sessionId: before.value.session.sessionId, generation: args.generation, requestId: before.value.creation.requestId }), before.value.session.sessionId);
      if (!equal(session, before.value.session)) fail('PROCESSING_CHAT_NATIVE_CONFLICT');
      return locked(async (tx, saved) => {
        current(saved, args.expectedHash, args.generation);
        if (saved.value.state !== 'idle' || !equal(saved.value.session, session)) fail('PROCESSING_CHAT_STATE_CHANGED');
        return write(tx, saved, { ...saved.value, state: 'busy', active: request }, 'dispatch');
      });
    },
    async pinOperation(args) {
      args = structuredClone(args);
      keys(args, ['expectedHash', 'generation', 'requestId', 'operationId']); expected(args.expectedHash);
      generation(args.generation); nativeId(args.requestId); nativeId(args.operationId);
      return locked((tx, saved) => {
        current(saved, args.expectedHash, args.generation);
        if (saved.value.state !== 'busy' || saved.value.active?.requestId !== args.requestId) fail('PROCESSING_CHAT_STATE_CHANGED');
        if (saved.value.active.operationId !== null) {
          if (saved.value.active.operationId !== args.operationId) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
          return view(saved, 'dispatch');
        }
        return write(tx, saved, { ...saved.value, active: { ...saved.value.active, operationId: args.operationId } }, 'dispatch');
      });
    },
    async finish(args) {
      args = structuredClone(args);
      keys(args, ['expectedHash', 'generation', 'requestId', 'outcome', 'nativeRun'], ['operationId', 'diagnostics']);
      expected(args.expectedHash); generation(args.generation); nativeId(args.requestId); choice(args.outcome, ['idle', 'awaiting-review', 'needs-inspection']); nativeRunValue(args.nativeRun, client);
      if (args.operationId !== undefined) nativeId(args.operationId);
      if (args.diagnostics !== undefined) list(args.diagnostics, 1).forEach(code => choice(code, ['PROCESSING_EXCLUSION_UNVERIFIED']));
      const before = await withStorageProbes(() => snapshot());
      if (!before.value?.session) fail('PROCESSING_CHAT_NOT_BOUND');
      if (before.value.generation !== args.generation) fail('PROCESSING_CHAT_GENERATION_CHANGED');
      const prior = before.value.runs.find(run => run.request.requestId === args.requestId);
      if (prior) {
        if (prior.outcome !== args.outcome || !equal(prior.native, args.nativeRun) ||
          (args.operationId !== undefined && args.operationId !== prior.request.operationId)) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
        if (before.value.policyHash !== initial.configHash) fail('PROCESSING_CHAT_POLICY_CHANGED');
        return view(before, 'already-finished');
      }
      current(before, args.expectedHash, args.generation);
      if (before.value.active?.requestId !== args.requestId) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
      if (before.value.state !== 'busy' && !(before.value.state === 'blocked' && before.value.block.reason === 'dispatch-outcome-unknown')) fail('PROCESSING_CHAT_BLOCKED');
      const reviewOperationId = args.outcome !== 'idle' ? args.operationId ?? before.value.active.operationId : null;
      if (args.outcome !== 'idle' && reviewOperationId === null) fail('PROCESSING_CHAT_REVIEW_OPERATION_REQUIRED');
      if (reviewOperationId !== null && before.value.active.operationId !== null && reviewOperationId !== before.value.active.operationId) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
      const target = { ...host, sessionId: before.value.session.sessionId, requestId: args.requestId, inputHash: before.value.active.inputHash, nativeRun: structuredClone(args.nativeRun) };
      const session = matchSession(await verifySession({ ...host, sessionId: before.value.session.sessionId, generation: args.generation, requestId: before.value.creation.requestId }), before.value.session.sessionId);
      if (session.verification !== 'verified') fail('PROCESSING_CHAT_NATIVE_UNVERIFIED');
      if (!sameSession(session, before.value.session)) fail('PROCESSING_CHAT_NATIVE_CONFLICT');
      const verified = await verifyRun(structuredClone(target));
      if (!verified || !equal(verified, target)) fail('PROCESSING_CHAT_NATIVE_UNVERIFIED');
      return locked(async (tx, saved) => {
        current(saved, args.expectedHash, args.generation);
        const runs = saved.value.runs;
        for (const token of new Set([args.nativeRun.runId, args.nativeRun.inputId, ...args.nativeRun.unitIds])) {
          if ((await intakeSnapshot(store, 'state', nativeArchivePath(token), { maxBytes: 1024 })).bytes) fail('PROCESSING_CHAT_NATIVE_CONFLICT');
        }
        if (runs.some(run => run.native.runId === args.nativeRun.runId || run.native.inputId === args.nativeRun.inputId ||
          run.native.unitIds.some(id => args.nativeRun.unitIds.includes(id)))) fail('PROCESSING_CHAT_NATIVE_CONFLICT');
        return write(tx, saved, { ...saved.value, session, active: null,
          state: args.outcome === 'needs-inspection' ? 'blocked' : args.outcome,
          block: args.outcome === 'needs-inspection' ? { reason: 'operation-outcome-unknown' } : null,
          runs: [...runs, { request: { ...saved.value.active, ...(args.operationId ? { operationId: args.operationId } : {}) }, native: structuredClone(args.nativeRun), outcome: args.outcome,
            reviewOperationId, reviewResolved: false, ...(args.diagnostics ? { diagnostics: args.diagnostics } : {}) }] }, 'finished');
      });
    },
    async resolveTerminal(args) {
      keys(args, ['expectedHash', 'generation', 'requestId']); expected(args.expectedHash); generation(args.generation); nativeId(args.requestId);
      const before = await withStorageProbes(() => snapshot()); current(before, args.expectedHash, args.generation);
      const run = before.value?.runs.at(-1);
      if (before.value?.state !== 'blocked' || before.value.block.reason !== 'operation-outcome-unknown' ||
        run?.outcome !== 'needs-inspection' || run.request.requestId !== args.requestId) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
      const target = { collectionId: initial.collection.id, generation: args.generation, requestId: args.requestId, operationId: run.reviewOperationId };
      const verified = await verifyReview({ ...target });
      if (!verified) fail('PROCESSING_CHAT_REVIEW_UNRESOLVED');
      keys(verified, [...Object.keys(target), 'state', 'recoveryRequired', 'outcome']);
      const { state, recoveryRequired, outcome: _outcome, ...identity } = verified;
      if (!equal(identity, target) || recoveryRequired || !['unread', 'inspecting', 'partially-inspected', 'inspected', 'draft-staging', 'awaiting-review', 'completed'].includes(state)) fail('PROCESSING_CHAT_REVIEW_UNRESOLVED');
      return locked((tx, saved) => {
        current(saved, args.expectedHash, args.generation);
        const next = structuredClone(saved.value), completed = next.runs.at(-1);
        completed.outcome = state === 'awaiting-review' ? 'awaiting-review' : 'idle';
        completed.reviewOperationId = state === 'awaiting-review' ? completed.reviewOperationId : null;
        next.state = completed.outcome; next.block = null;
        return write(tx, saved, next, 'inspect');
      });
    },
    async acknowledgeReview(args) {
      args = structuredClone(args);
      keys(args, ['expectedHash', 'generation', 'requestId', 'operationId']); expected(args.expectedHash); generation(args.generation);
      nativeId(args.requestId); nativeId(args.operationId);
      const before = await withStorageProbes(() => snapshot());
      if (!before.value || before.value.generation !== args.generation) fail('PROCESSING_CHAT_GENERATION_CHANGED');
      const run = before.value.runs.find(run => run.request.requestId === args.requestId);
      if (!run || run.reviewOperationId !== args.operationId) fail('PROCESSING_CHAT_REQUEST_CONFLICT');
      if (run.reviewResolved) {
        if (before.value.policyHash !== initial.configHash) fail('PROCESSING_CHAT_POLICY_CHANGED');
        return view(before, 'already-acknowledged');
      }
      current(before, args.expectedHash, args.generation);
      if (before.value.state !== 'awaiting-review') fail('PROCESSING_CHAT_BLOCKED');
      const target = { collectionId: initial.collection.id, generation: args.generation, requestId: args.requestId, operationId: args.operationId };
      const verified = await verifyReview({ ...target });
      if (!verified) fail('PROCESSING_CHAT_REVIEW_UNRESOLVED');
      keys(verified, [...Object.keys(target), 'state', 'recoveryRequired', 'outcome']);
      const { state, recoveryRequired, outcome, ...identity } = verified;
      if (!equal(identity, target) || state !== 'completed' || recoveryRequired !== false || !['saved', 'unchanged', 'skipped', 'cancelled'].includes(outcome)) fail('PROCESSING_CHAT_REVIEW_UNRESOLVED');
      return locked((tx, saved) => {
        current(saved, args.expectedHash, args.generation);
        const next = structuredClone(saved.value);
        next.runs.find(run => run.request.requestId === args.requestId).reviewResolved = true;
        next.state = 'idle';
        return write(tx, saved, next, 'reuse');
      });
    },
    async block(args) {
      args = structuredClone(args);
      keys(args, ['expectedHash', 'generation', 'reason']); expected(args.expectedHash); generation(args.generation); choice(args.reason, BLOCKS);
      return locked((tx, saved) => {
        current(saved, args.expectedHash, args.generation);
        if (saved.value.state === 'blocked' && saved.value.block.reason === args.reason) return view(saved, 'inspect-existing');
        return write(tx, saved, { ...saved.value, state: 'blocked', block: { reason: args.reason } }, 'inspect-existing');
      });
    },
  });
}
