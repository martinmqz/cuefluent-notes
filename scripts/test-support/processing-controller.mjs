import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProcessingController } from '../processing-controller.mjs';
import { inspectProcessing } from '../processing.mjs';
import { canonicalJSON, digest } from '../workflow-values.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
async function registryJSON(f) {
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  return JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'));
}
async function harness(t, f, client = 'codex', env = {}) {
  const profileRoot = path.join(f.root, 'synthetic-profile'); await fs.mkdir(profileRoot);
  const h = { creates: 0, resumes: 0, dispatches: [], closes: 0, bridgeCloses: 0, events: [],
    script: async call => call('processing_pending', {}), resultStatus: 'completed', failCreate: false,
    env: { CLAUDE_CONFIG_DIR: profileRoot, ...env }, profileId: digest('synthetic-codex-profile') };
  const dependencies = { env: h.env, ...(client === 'codex' ? { profileId: h.profileId } : {}), hostId: digest('synthetic-controller-host'),
    async beforeExecution(event) {
      const state = await registryJSON(f);
      assert.equal(state.state, 'busy'); assert.equal(state.active.requestId, event.requestId);
      assert.equal(state.session.sessionId, event.session.sessionId);
      if (client === 'claude' && h.dispatches.length === 0) assert.equal(state.session.verification, 'reserved');
      h.events.push('before-execution'); await h.beforeExecution?.(event);
    },
    async guardExecution(event) { h.events.push('guard'); await h.guardExecution?.(event); },
    async onNativeBoundary(event) { h.events.push(event.phase); },
    async afterExecution(event) { h.events.push('after-execution'); await h.afterExecution?.(event); },
    async afterInterruptedExecution(event) {
      if (!h.afterInterruptedExecution) throw Object.assign(new Error('unverified interruption'), { code: 'PROCESSING_CLIENT_INTERRUPTED' });
      await h.afterInterruptedExecution(event);
    },
    async reconcileExecution(context) { return h.reconcileExecution ? h.reconcileExecution(context) : null; },
    async inspectOperation(operationId) { return h.inspectOperation ? h.inspectOperation(operationId) : inspectProcessing(f.capability, operationId); },
    async openCodex(options) {
      const call = (name, args) => options.onEngineTool({ tool: `cuefluent_${name}`, arguments: args });
      return {
        profileId: h.profileId,
        async create() {
          h.creates++;
          if (h.createError) throw h.createError;
          if (h.failCreate) throw Object.assign(new Error('synthetic create interrupted'), { code: 'PROCESSING_CLIENT_OUTCOME_UNKNOWN' });
          const sessionId = randomUUID();
          return { client, sessionId, sourcePath: path.join(f.root, `${sessionId}.jsonl`), cwd: options.cwd,
            profileId: h.profileId, transport: 'codex-app-server', desktopVerified: false,
            toolContractHash: digest(canonicalJSON(options.tools)) };
        },
        async resume(session) {
          h.resumes++;
          assert.equal((await registryJSON(f)).state, 'busy', 'registry ownership precedes native resume');
          await h.onResume?.(); return structuredClone(session);
        },
        async startTurn(request) {
          if (h.preDispatchError) throw h.preDispatchError;
          const unitId = randomUUID();
          await request.roleGuard({ ...request.session, unitId: null, phase: 'before-input' });
          h.dispatches.push({ sessionId: request.session.sessionId, unitId, input: request.input });
          await request.roleGuard({ ...request.session, unitId, phase: 'started' });
          await h.script(call, request);
          await h.afterNativeResult?.({ unitId, request });
          return { ...request.session, unitId, status: h.resultStatus, model: 'synthetic-model' };
        },
        async close() { h.closes++; }
      };
    },
    async openBridge(options) {
      h.bridgeCall = options.call;
      return { engine: { command: 'synthetic-engine-no-process', args: [] },
        allowedTools: options.toolNames.map(name => `mcp__cuefluent_engine__${name}`),
        async close() { h.bridgeCloses++; } };
    },
    createClaude() {
      return { async run(request) {
        if (h.preDispatchError) throw h.preDispatchError;
        await request.beforeDispatch({ client, sessionId: request.sessionId, inputId: request.inputId, resume: request.resume });
        const saved = await registryJSON(f);
        assert.equal(saved.state, 'busy'); assert.equal(saved.session.sessionId, request.sessionId);
        assert.equal(saved.active.requestId, request.inputId);
        h.dispatches.push({ sessionId: request.sessionId, inputId: request.inputId, resume: request.resume, input: request.prompt });
        await h.script(h.bridgeCall, request);
        return { client, sessionId: request.sessionId, inputId: request.inputId, status: 'completed', model: 'synthetic-model' };
      } };
    }
  };
  h.dependencies = dependencies;
  h.open = async () => {
    const controller = await openProcessingController({ ...f.options, client }, dependencies);
    t.after(() => controller.close());
    return controller;
  };
  h.controller = await h.open();
  h.request = async (extra = {}) => ({ requestId: randomUUID(), selection: f.selection,
    expectedChatHash: (await h.controller.status()).chatHash, ...extra });
  return h;
}
async function inspectAll(call, f) {
  let claim = await call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await call('processing_page', { operationId: f.operationId, expectedClaimHash: claim.claimHash, page });
    claim = await call('processing_ack', { operationId: f.operationId, expectedClaimHash: read.claimHash,
      pages: [{ index: page, hash: read.hash }] });
  }
  return claim;
}
const unchanged = f => async call => {
  await call('processing_pending', {});
  const claim = await inspectAll(call, f);
  await call('processing_complete', { operationId: f.operationId, expectedClaimHash: claim.claimHash });
};
const propose = (f, inspected = null) => async call => {
  const claim = inspected ?? await inspectAll(call, f);
  return call('processing_propose', { operationId: f.operationId, expectedClaimHash: claim.claimHash,
    proposal: { files: [{ path: 'meetings/rollout.md', expectedHash: null,
      content: '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n' }],
    mappings: [{ identity: f.identity, paths: ['meetings/rollout.md'] }] } });
};

async function assertRetiredPeerBlocked(t, f, h, expectedState = 'blocked') {
  const stored = await registryJSON(f);
  for (const client of ['codex', 'claude']) {
    const profileRoot = path.join(f.root, `peer-profile-${randomUUID()}`); await fs.mkdir(profileRoot);
    const peer = await openProcessingController({ ...f.options, client }, {
      ...h.dependencies, profileId: digest(profileRoot), env: { CLAUDE_CONFIG_DIR: profileRoot },
      async openCodex() { assert.fail('a retired peer claim must block before native startup'); },
      createClaude() { assert.fail('a retired peer claim must block before native startup'); }
    });
    t.after(() => peer.close());
    const activity = await peer.collectionActivity();
    assert.equal(activity.length, 1); assert.equal(activity[0].own, false); assert.equal(activity[0].state, expectedState);
    await assert.rejects(peer.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null }),
      { code: 'PROCESSING_COLLECTION_BUSY' });
    assert.deepEqual(await registryJSON(f), stored);
    await peer.close();
  }
}

async function completeBound(call, preparation) {
  let claim = await call('processing_prepare', preparation);
  const operationId = claim.operationId;
  for (let page = 0; page < claim.packet.pages.length; page++) {
    const read = await call('processing_page', { operationId, expectedClaimHash: claim.claimHash, page });
    claim = await call('processing_ack', { operationId, expectedClaimHash: read.claimHash, pages: [{ index: page, hash: read.hash }] });
  }
  return call('processing_complete', { operationId, expectedClaimHash: claim.claimHash });
}

export { deferred, registryJSON, harness, inspectAll, unchanged, propose, assertRetiredPeerBlocked, completeBound };
