import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processingFixture, proposedClaim } from './test-support/processing-fixture.mjs';
import { openProcessingController } from './processing-controller.mjs';
import { createProcessingWorkset, inspectProcessingWorkset } from './processing-workset.mjs';
import { prepareProcessing, completeProcessing, inspectProcessing, saveProcessing, recoverProcessing } from './processing.mjs';
import { pendingProcessing } from './processing-inventory.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { createCapture } from './capture-contract.mjs';
import { controlSelection, readSelection, publishCapture } from './intake-store.mjs';
import { withIntakeLock } from './intake-io.mjs';
import { registryJSON, harness, unchanged, assertRetiredPeerBlocked, completeBound } from './test-support/processing-controller.mjs';

async function retiredTerminalClaim(t, client = 'codex') {
  const f = await processingFixture(t, { client }), h = await harness(t, f, client);
  h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
  const done = await h.controller.run(await h.request());
  await h.controller.rollover({ expectedChatHash: done.chatHash });
  h.script = async call => { await call('processing_status', { operationId: f.operationId }); throw new Error('synthetic lost terminal'); };
  await assert.rejects(h.controller.run(await h.request({ resumeOperationId: f.operationId })));
  const failed = await h.controller.status();
  await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  return { f, h, claim: await inspectProcessing(f.capability, f.operationId) };
}

async function additionalSelectedCapture(f) {
  // Sort after the pinned input so a one-head inventory page cannot discover
  // this claim by accident. Operation discovery must cover the whole selection.
  const identity = { ...f.identity, unitId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
  const scopeId = randomUUID(), previous = await readSelection(f.store, identity);
  const proof = { ...f.publishArgs.proof, ...identity };
  const selected = await withIntakeLock(f.store, tx => controlSelection(tx, {
    source: f.source, expectedHash: previous.hash, authorize: async () => true,
    request: { id: scopeId, operation: 'capture-current', ...identity, expectedRevision: previous.state.revision,
      scope: { unitIds: [identity.unitId], start: proof.start, end: null, contentHash: proof.start.hash } }
  }));
  const capture = createCapture({ ...f.capture, identity });
  const published = await withIntakeLock(f.store, tx => publishCapture(tx, {
    ...f.publishArgs, capture, proof, scopeId, selectionHash: selected.hash,
    scan: { ...f.publishArgs.scan, accounted: f.publishArgs.scan.accounted.map(item => ({ ...item, unitId: identity.unitId })) },
    checkpoint: f.publishArgs.checkpoint ? { ...f.publishArgs.checkpoint, scopeId } : null
  }));
  return { selection: f.selection, operationId: randomUUID(), inputs: [{ identity, headHash: published.headHash }] };
}

for (const client of ['codex', 'claude']) for (const completedPin of [false, true]) for (const duringStartup of [false, true]) {
  test(`${client} retired pin does not hide a second selected claim with ${completedPin ? 'completed' : 'terminal-owned'} pin ${duringStartup ? 'during startup' : 'before admission'}`, async t => {
    const { f, h, claim: initialClaim } = await retiredTerminalClaim(t, client);
    // A completed pinned claim no longer occupies the synthesis slot, but the
    // retired native binding still points to it when another claim is prepared.
    if (completedPin) await completeProcessing(f.capability, { ...f.args, expectedClaimHash: initialClaim.claimHash, outcome: 'cancelled' });
    const claim = await inspectProcessing(f.capability, f.operationId);
    const additional = await additionalSelectedCapture(f), retired = await h.controller.status();
    assert.equal(retired.state, 'idle'); assert.equal(retired.operationId, f.operationId);
    assert.equal(await h.controller.canResumeOperation(f.operationId), true);
    const stored = await registryJSON(f), creates = h.creates, dispatches = h.dispatches.length;
    let extraClaim, opens = 0;
    const prepare = async () => { extraClaim = await prepareProcessing(f.capability, { ...additional, parallelism: 2 }); };
    await h.controller.close();
    const opener = client === 'codex' ? 'openCodex' : 'openBridge', open = h.dependencies[opener];
    h.dependencies[opener] = async (...args) => { opens++; if (duringStartup) await prepare(); return open(...args); };
    h.controller = await h.open();
    if (!duringStartup) await prepare();
    const blocked = await h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: retired.chatHash });
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.operationId, additional.operationId);
    assert.deepEqual(blocked.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    assert.equal(blocked.resumeSupported, false); assert.equal(blocked.chatHash, retired.chatHash);
    assert.deepEqual(await h.controller.status(), blocked);
    await assertRetiredPeerBlocked(t, f, h);
    assert.deepEqual(await registryJSON(f), stored);
    assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
    assert.equal((await inspectProcessing(f.capability, additional.operationId)).claimHash, extraClaim.claimHash);
    assert.equal(opens, duringStartup ? 1 : 0); assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
    await completeProcessing(f.capability, { selection: f.selection, operationId: additional.operationId,
      expectedClaimHash: extraClaim.claimHash, outcome: 'cancelled' });
    assert.equal((await h.controller.status()).state, 'idle');
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const client of ['codex', 'claude']) for (const duringStartup of [false, true]) {
  test(`${client} pinned retired claim preserves head conflict ${duringStartup ? 'during startup' : 'before admission'}`, async t => {
    const { f, h, claim } = await retiredTerminalClaim(t, client);
    const retired = await h.controller.status(), stored = await registryJSON(f);
    const creates = h.creates, dispatches = h.dispatches.length;
    const file = path.join(f.collection.intakeStateDir, 'heads', client, f.identity.sessionId, `${f.identity.unitId}.json`);
    const headBytes = await fs.readFile(file), head = JSON.parse(headBytes);
    const changed = canonicalJSON({ ...head, generation: head.generation + 1, previousHash: digest(headBytes) }) + '\n';
    const publish = () => fs.writeFile(file, changed);
    await h.controller.close();
    const opener = client === 'codex' ? 'openCodex' : 'openBridge', open = h.dependencies[opener];
    let opens = 0;
    h.dependencies[opener] = async (...args) => { opens++; if (duringStartup) await publish(); return open(...args); };
    h.controller = await h.open();
    if (!duringStartup) await publish();
    const blocked = await h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: retired.chatHash });
    assert.equal(blocked.state, 'blocked'); assert.deepEqual(blocked.diagnostics, ['PROCESSING_OPERATION_CONFLICT']);
    assert.equal(blocked.chatHash, retired.chatHash); assert.equal(blocked.operationId, f.operationId);
    assert.equal(blocked.operationState, 'conflicted'); assert.equal(blocked.resumeSupported, false);
    assert.deepEqual(await h.controller.status(), blocked);
    const pending = await inspectProcessing(f.capability, f.operationId);
    assert.equal(pending.conflict, 'PROCESSING_HEAD_CHANGED'); assert.equal(pending.recoveryRequired, false);
    assert.deepEqual(pending.blockers, []); assert.equal(pending.claimHash, claim.claimHash);
    await assertRetiredPeerBlocked(t, f, h);
    assert.deepEqual(await registryJSON(f), stored); assert.equal(await fs.readFile(file, 'utf8'), changed);
    assert.equal(opens, duringStartup ? 1 : 0); assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
    // Explicit disposition, rather than refreshing the inspected input, releases the claim.
    await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
    h.dependencies[opener] = open; await h.controller.close(); h.controller = await h.open();
    h.script = async call => call('processing_pending', {});
    assert.equal((await h.controller.run(await h.request())).state, 'idle');
    assert.equal(h.dispatches.length, dispatches + 1);
    assert.equal(await fs.readFile(file, 'utf8'), changed);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const client of ['codex', 'claude']) for (const foreign of [false, true]) for (const duringStartup of [false, true]) {
  test(`${client} pinned retired claim blocks ${foreign ? 'foreign' : 'own'} reservation ${duringStartup ? 'during startup' : 'before admission'}`, async t => {
    const { f, h, claim } = await retiredTerminalClaim(t, client);
    const retired = await h.controller.status(), stored = await registryJSON(f);
    const creates = h.creates, dispatches = h.dispatches.length;
    const reservation = path.join(f.collection.notes.writerStateDir, 'reinspection.json');
    const { binding } = JSON.parse(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'claims', `${f.operationId}.json`), 'utf8'));
    const bytes = canonicalJSON({ preview: { binding: foreign ? { ...binding, collectionId: 'other' } : binding } }) + '\n';
    const code = foreign ? 'PROCESSING_RECOVERY_REQUIRED' : 'PROCESSING_REINSPECTION_REQUIRED';
    const publish = () => fs.writeFile(reservation, bytes, { mode: 0o600 });
    await h.controller.close();
    const opener = client === 'codex' ? 'openCodex' : 'openBridge', open = h.dependencies[opener];
    let opens = 0;
    h.dependencies[opener] = async (...args) => { opens++; if (duringStartup) await publish(); return open(...args); };
    h.controller = await h.open();
    if (!duringStartup) await publish();
    const blocked = await h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: retired.chatHash });
    assert.equal(blocked.state, 'blocked'); assert.deepEqual(blocked.diagnostics, [code]);
    assert.equal(blocked.chatHash, retired.chatHash); assert.equal(blocked.operationId, f.operationId);
    assert.deepEqual(await h.controller.status(), blocked);
    const pending = await inspectProcessing(f.capability, f.operationId);
    assert.equal(pending.recoveryRequired, false); assert.equal(pending.claimHash, claim.claimHash);
    assert.deepEqual(pending.blockers, [foreign ? 'writer-reserved-by-another-collection' : code]);
    await assertRetiredPeerBlocked(t, f, h);
    assert.deepEqual(await registryJSON(f), stored); assert.equal(await fs.readFile(reservation, 'utf8'), bytes);
    assert.equal(opens, duringStartup ? 1 : 0); assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
    await fs.unlink(reservation); h.dependencies[opener] = open;
    await h.controller.close(); h.controller = await h.open();
    h.script = async call => call('processing_status', { operationId: f.operationId });
    assert.equal((await h.controller.run(await h.request())).state, 'idle');
    assert.equal(h.dispatches.length, dispatches + 1);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const client of ['codex', 'claude']) for (const history of ['workset', 'resume']) {
  test(`${client} retired plain run preserves null bindings after terminal ${history} history`, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    const worksetId = randomUUID();
    if (history === 'workset') {
      await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
      h.script = async call => completeBound(call, (await call('processing_pending', {})).nextPreparation);
      await h.controller.run(await h.request({ worksetId }));
    } else {
      h.script = async call => call('processing_prepare', { operationId: f.operationId, inputs: f.inputs });
      await h.controller.run(await h.request());
      h.script = async call => call('processing_status', { operationId: f.operationId });
      await h.controller.run(await h.request({ resumeOperationId: f.operationId }));
      const claim = await inspectProcessing(f.capability, f.operationId);
      await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
    }
    const other = await processingFixture(t, { base: f, client });
    let pinFailed = false;
    h.script = async call => {
      const rename = fs.rename;
      const mock = t.mock.method(fs, 'rename', async (from, to) => {
        if (path.dirname(to) === path.join(f.collection.intakeStateDir, 'processing-chats')) {
          const next = JSON.parse(await fs.readFile(from, 'utf8'));
          if (next.state === 'busy' && next.active.operationId === other.operationId) {
            pinFailed = true; mock.mock.restore();
            throw Object.assign(new Error('synthetic loss before plain operation pin'), { code: 'EIO' });
          }
        }
        return rename(from, to);
      });
      await call('processing_prepare', { operationId: other.operationId, inputs: other.inputs });
    };
    await assert.rejects(h.controller.run(await h.request({ selection: other.selection })));
    assert.equal(pinFailed, true);
    const failed = await h.controller.status();
    const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
    assert.equal(retired.worksetId, null); assert.equal(retired.resumeOperationId, null);
    assert.equal(retired.state, 'blocked'); assert.equal(retired.operationId, other.operationId);
    assert.deepEqual(retired.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
    const stored = await registryJSON(f), claim = await inspectProcessing(f.capability, other.operationId);
    const creates = h.creates, dispatches = h.dispatches.length;
    assert.deepEqual(await h.controller.run(await h.request({ selection: other.selection })), retired);
    assert.deepEqual(await registryJSON(f), stored);
    assert.deepEqual(await inspectProcessing(f.capability, other.operationId), claim);
    assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

for (const client of ['codex', 'claude']) for (const kind of ['plain', 'workset']) {
  for (const peer of [false, true]) for (const duringStartup of [false, true]) {
    test(`${client} retired ${kind} preserves claim-released recovery for ${peer ? 'peer' : 'own'} admission ${duringStartup ? 'during startup' : 'before admission'}`, async t => {
      const f = await processingFixture(t, { client }), other = await processingFixture(t, { base: f, client });
      const h = await harness(t, f, client), worksetId = kind === 'workset' ? randomUUID() : null;
      const binding = worksetId ? { worksetId } : {};
      if (worksetId) await createProcessingWorkset(f.capability, { selection: f.selection, worksetId, inputs: f.inputs });
      h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
      await assert.rejects(h.controller.run(await h.request(binding)));
      const failed = await h.controller.status();
      const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
      const stored = await registryJSON(f), creates = h.creates, dispatches = h.dispatches.length;
      assert.equal(stored.active.operationId, null);
      await h.controller.close();
      const transaction = path.join(f.collection.notes.writerStateDir, 'transactions', `${other.operationId}.json`);
      let target, noteBytes, transactionBytes;
      const interruptSave = async () => {
        const proposal = await proposedClaim(other); target = proposal.target;
        await assert.rejects(saveProcessing(other.capability, { ...other.args,
          expectedClaimHash: proposal.claimHash, approvedProposalHash: proposal.proposalHash }, {
          fault: phase => { if (phase === 'claim-release') throw new Error('synthetic claim-release crash'); }
        }), /synthetic claim-release crash/);
        assert.deepEqual(await fs.readdir(path.join(f.collection.notes.writerStateDir, 'claims')), []);
        transactionBytes = await fs.readFile(transaction); noteBytes = await fs.readFile(target);
        const inventory = await pendingProcessing(f.capability, { selection: f.selection, limit: 1 });
        assert.deepEqual(inventory.operations, []);
        assert.deepEqual(inventory.blockers, ['PROCESSING_RECOVERY_REQUIRED']);
      };
      const opener = client === 'codex' ? 'openCodex' : 'openBridge', open = h.dependencies[opener];
      let opens = 0;
      const controller = await openProcessingController({ ...f.options, client }, {
        ...h.dependencies, ...(peer ? { hostId: digest('synthetic-recovery-peer') } : {}),
        async [opener](...args) { opens++; if (duringStartup) await interruptSave(); return open(...args); }
      });
      t.after(() => controller.close());
      if (!duringStartup) await interruptSave();
      const request = { requestId: randomUUID(), selection: f.selection, expectedChatHash: peer ? null : retired.chatHash,
        ...(!peer ? binding : {}) };
      h.script = async call => call('processing_pending', {});
      if (peer) {
        await assert.rejects(controller.run(request), { code: 'PROCESSING_COLLECTION_BUSY' });
        const activity = await controller.collectionActivity();
        assert.equal(activity.length, 1); assert.equal(activity[0].state, 'blocked'); assert.equal(activity[0].own, false);
        assert.equal((await controller.status()).state, 'missing');
      } else {
        const blocked = await controller.run(request);
        assert.equal(blocked.state, 'blocked'); assert.equal(blocked.chatHash, retired.chatHash);
        assert.deepEqual(blocked.diagnostics, ['PROCESSING_RECOVERY_REQUIRED']); assert.equal(blocked.resumeSupported, false);
        assert.deepEqual(await controller.status(), blocked);
      }
      assert.equal(opens, duringStartup ? 1 : 0); assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
      assert.deepEqual(await registryJSON(f), stored);
      assert.deepEqual(await fs.readFile(transaction), transactionBytes); assert.deepEqual(await fs.readFile(target), noteBytes);
      if (worksetId) {
        const workset = await inspectProcessingWorkset(f.capability, { worksetId });
        assert.deepEqual(workset.operations, []); assert.deepEqual(workset.blockers, ['PROCESSING_RECOVERY_REQUIRED']);
        assert.equal(workset.chargedBatches, 0); assert.deepEqual(workset.inputs, f.inputs);
      }
      // Complete the actual synthetic transaction, rather than deleting its intent.
      const recovery = await inspectProcessing(other.capability, other.operationId);
      assert.equal((await recoverProcessing(other.capability, { operationId: other.operationId,
        expectedRecoveryHash: recovery.recoveryHash })).status, 'saved');
      assert.deepEqual(await controller.collectionActivity(), []);
      const clear = await controller.status();
      assert.equal(clear.state, peer ? 'missing' : 'idle'); assert.deepEqual(clear.diagnostics, []);
      assert.deepEqual(await registryJSON(f), stored); assert.deepEqual(await fs.readFile(target), noteBytes);
      await assert.rejects(fs.readFile(transaction), { code: 'ENOENT' });
    });
  }
}

for (const client of ['codex', 'claude']) for (const blocker of ['claim', 'reservation']) {
  test(`${client} same-namespace ${blocker} appearing during startup prevents retired binding replacement`, async t => {
    const f = await processingFixture(t, { client }), h = await harness(t, f, client);
    h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
    await assert.rejects(h.controller.run(await h.request()));
    const failed = await h.controller.status();
    const retired = await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
    const stored = await registryJSON(f), creates = h.creates, dispatches = h.dispatches.length;
    await h.controller.close();
    const opener = client === 'codex' ? 'openCodex' : 'openBridge', open = h.dependencies[opener];
    const reservation = path.join(f.collection.notes.writerStateDir, 'reinspection.json');
    const reservationBytes = canonicalJSON({ preview: { binding: { collectionId: 'other' } } }) + '\n';
    let opens = 0, claim;
    h.dependencies[opener] = async (...args) => {
      opens++;
      if (blocker === 'claim') claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
      else await fs.writeFile(reservation, reservationBytes, { mode: 0o600 });
      return open(...args);
    };
    h.controller = await h.open();
    h.script = async call => call('processing_pending', {});
    const request = await h.request();
    if (blocker === 'reservation') {
      await assert.rejects(h.controller.run(request), { code: 'PROCESSING_RECOVERY_REQUIRED' });
      assert.equal(await fs.readFile(reservation, 'utf8'), reservationBytes);
    } else {
      const result = await h.controller.run(request);
      assert.equal(result.state, 'blocked'); assert.equal(result.chatHash, retired.chatHash);
      assert.deepEqual(result.diagnostics, ['PROCESSING_OPERATION_OWNER_UNVERIFIED']);
      assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
    }
    assert.equal(opens, 1); assert.equal(h.creates, creates); assert.equal(h.dispatches.length, dispatches);
    assert.deepEqual(await registryJSON(f), stored);
    // Resolve only this synthetic blocker, then retry the unchanged retired row.
    if (blocker === 'claim') await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
    else await fs.unlink(reservation);
    h.dependencies[opener] = open;
    await h.controller.close(); h.controller = await h.open();
    assert.equal((await h.controller.run(await h.request())).state, 'idle');
    assert.equal(h.dispatches.length, dispatches + 1);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  });
}

test('peer claim appearing during native startup is rechecked before reserving a replacement', async t => {
  const f = await processingFixture(t), h = await harness(t, f);
  h.script = async () => { throw new Error('synthetic lost terminal before preparation'); };
  await assert.rejects(h.controller.run(await h.request()));
  const failed = await h.controller.status();
  await h.controller.abandon({ expectedChatHash: failed.chatHash, requestId: failed.requestId, offline: true });
  const stored = await registryJSON(f), profileId = digest('synthetic-racing-peer');
  let opens = 0, claim;
  const peer = await openProcessingController({ ...f.options, client: 'codex' }, {
    ...h.dependencies, profileId,
    async openCodex() {
      opens++; claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
      return { profileId, async create() { assert.fail('late peer claim must block native creation'); }, async close() {} };
    }
  });
  t.after(() => peer.close());
  assert.deepEqual(await peer.collectionActivity(), []);
  await assert.rejects(peer.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null }),
    { code: 'PROCESSING_COLLECTION_BUSY' });
  assert.equal(opens, 1); assert.equal((await peer.status()).state, 'missing');
  assert.deepEqual(await registryJSON(f), stored);
  assert.equal((await inspectProcessing(f.capability, f.operationId)).claimHash, claim.claimHash);
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'cancelled' });
  assert.deepEqual(await peer.collectionActivity(), []);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
});

test('retired status retries one concurrent registry change and reads operation metadata once per attempt', async t => {
  const { f, h, claim } = await retiredTerminalClaim(t);
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const file = path.join(directory, (await fs.readdir(directory))[0]);
  let reads = 0;
  h.inspectOperation = async () => {
    if (++reads === 1) {
      const value = await registryJSON(f); value.generation++;
      await fs.writeFile(file, canonicalJSON(value) + '\n');
    }
    return claim;
  };
  const status = await h.controller.status();
  assert.equal(status.state, 'idle'); assert.equal(status.operationState, claim.state);
  assert.equal(reads, 2);
  assert.equal(status.chatHash, digest(await fs.readFile(file)));
  reads = 0; h.inspectOperation = async () => { reads++; return claim; };
  assert.deepEqual(await h.controller.status(), status);
  assert.equal(reads, 1); assert.equal(h.dispatches.length, 2);
});

test('retired run preserves collection-busy activity without a fallible second projection', async t => {
  const { f, h, claim } = await retiredTerminalClaim(t);
  const before = await h.controller.status(), stored = await registryJSON(f);
  const directory = path.join(f.collection.intakeStateDir, 'processing-chats');
  const file = path.join(directory, (await fs.readdir(directory))[0]);
  const profileId = digest('competing synthetic profile');
  const peer = await openProcessingController({ ...f.options, client: 'codex' }, {
    ...h.dependencies, profileId,
    async openCodex() { return { profileId,
      async create() { throw new Error('synthetic creation outcome unknown'); }, async close() {} }; }
  });
  t.after(() => peer.close());
  await assert.rejects(peer.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: null }));
  const activity = (await h.controller.collectionActivity()).filter(item => !item.own);
  assert.equal(activity.length, 1);
  let reads = 0;
  h.inspectOperation = async () => {
    if (++reads > 1) await fs.writeFile(file, 'synthetic concurrent invalid registry');
    return claim;
  };
  await assert.rejects(h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: before.chatHash }), error => {
    assert.equal(error.code, 'PROCESSING_COLLECTION_BUSY');
    assert.deepEqual(error.activity, activity);
    assert.equal(error.processingChat.state, 'blocked');
    assert.equal(error.processingChat.resumeSupported, false);
    return true;
  });
  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), stored);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal(h.dispatches.length, 2);
});

for (const invalid of ['corrupt', 'binding']) test(`retired status preserves ${invalid} archive failure without masking run refusal`, async t => {
  const { f, h, claim } = await retiredTerminalClaim(t);
  const registry = await registryJSON(f), namespaceHash = digest(canonicalJSON(registry.namespace));
  const file = path.join(f.collection.intakeStateDir, 'processing-chat-operation-history', namespaceHash, `${f.operationId}.json`);
  const before = await h.controller.status();
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (invalid === 'binding') value.bindingHash = digest('different synthetic collection');
  else value.operationId = randomUUID();
  await fs.writeFile(file, canonicalJSON(value) + '\n');
  const code = invalid === 'binding' ? 'PROCESSING_CHAT_BINDING_CHANGED' : 'INVALID_PROCESSING_CHAT_STATE';
  await assert.rejects(h.controller.status(), { code });
  await assert.rejects(h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: before.chatHash }), { code });
  // A separate earlier refusal must survive even if status projection is broken.
  await assert.rejects(h.controller.run({ requestId: randomUUID(), selection: f.selection, expectedChatHash: 'f'.repeat(64) }),
    { code: 'PROCESSING_CHAT_STATE_CHANGED' });
  assert.deepEqual(await registryJSON(f), registry);
  assert.deepEqual(await inspectProcessing(f.capability, f.operationId), claim);
  assert.equal(h.dispatches.length, 2);
});
