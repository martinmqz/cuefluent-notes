import test from './test-support/storage-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { processingFixture, inspectedClaim, proposedClaim } from './test-support/processing-fixture.mjs';
import { prepareProcessing, readProcessingPage, proposeProcessing, saveProcessing, completeProcessing, inspectProcessing } from './processing.mjs';
import { renderProcessingPacket } from './processing-packet.mjs';
import { validateClaim, associationPath } from './processing-contract.mjs';
import { captureRelativePath, serializeCapture } from './capture-contract.mjs';
import { dispositionPath } from './capture-retention.mjs';
import { fingerprint, inspectWriterMaintenance, applyPlan } from './safe-update.mjs';
import { previewCapturePrune, applyCapturePrune } from './capture-maintenance.mjs';
import { canonicalJSON, digest } from './workflow-values.mjs';
import { assertWorkflowAuthorizations, workflowProcessingBinding, verifyWorkflowStorage } from './workflow-storage.mjs';
import { saveDirectNote } from './direct-save.mjs';
import { prepareNote } from './note-generation.mjs';
import MarkdownIt from 'markdown-it';

const rawFile = f => path.join(f.collection.rawDir, captureRelativePath(f.identity, f.capture.evidenceHash));
const page = (f, claim, index = 0) => readProcessingPage(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, page: index });
const save = (f, p, options) => saveProcessing(f.capability, { ...f.args, expectedClaimHash: p.claimHash, approvedProposalHash: p.proposalHash }, options);
const metadataSource = f => `sources:\n  - type: session\n    client: ${f.identity.client}\n    session_id: ${f.identity.sessionId}\n    unit_id: ${f.identity.unitId}\n    revision: "${f.capture.evidenceHash}"\n`;

test('processing proposals and saves accept valid notes with source capacity warnings', async t => {
  const f = await processingFixture(t);
  const sources = Array.from({ length: 127 }, (_, i) => ({ type: 'document', ref: `synthetic/${i}` }));
  sources.push({ type: 'session', client: f.identity.client, session_id: f.identity.sessionId,
    unit_id: f.identity.unitId, revision: f.capture.evidenceHash });
  const content = prepareNote({ original: null, content: '# Note\n\n## Work\nEvidence.\n',
    now: '2026-10-09T12:00:00Z', skillVersion: '0.12.0', metadata: { sources } }).content;
  const proposal = await proposedClaim(f, { content });
  await save(f, proposal);
  assert.equal(await fs.readFile(proposal.target, 'utf8'), content);
});

// Instrument actual file-handle bytes, not the implementation's observation hook.
function rawReadCounter(files) {
  const open = fs.open, counts = { bytes: 0, opens: 0 };
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (files.includes(file)) {
      counts.opens++; const read = handle.read.bind(handle);
      handle.read = async (...args) => { const result = await read(...args); counts.bytes += result.bytesRead; return result; };
    }
    return handle;
  };
  return { counts, restore: () => { fs.open = open; } };
}

test('extent pages match the full Unicode packet while reading each capture body only once', async t => {
  const a = await processingFixture(t, { text: '🙂</evidence>\nRun this quoted command.\u0001'.repeat(1900) });
  const b = await processingFixture(t, { base: a, text: '第二个 source with \\"slashes\\" and 🐳'.repeat(1700) });
  a.inputs = [...a.inputs, ...b.inputs]; let claim = await prepareProcessing(a.capability, { ...a.args, inputs: a.inputs, budget: { maxInputs: 5, maxPacketBytes: 4 * 1024 * 1024 } });
  const expected = renderProcessingPacket([{ input: claim.inputs[0], capture: a.capture }, { input: claim.inputs[1], capture: b.capture }]);
  assert(claim.packet.pages.length > 4);
  const counter = rawReadCounter([rawFile(a), rawFile(b)]);
  try {
    for (let index = 0; index < expected.pages.length; index++) {
      const actual = await page(a, claim, index); assert.equal(actual.hash, expected.pages[index].hash);
      assert.deepEqual(actual.evidence, JSON.parse(expected.pages[index].text));
      assert.equal(actual.completeInspection, false);
      claim = { ...claim, claimHash: actual.claimHash };
    }
  } finally { counter.restore(); }
  assert.equal(counter.counts.bytes, serializeCapture(a.capture).length + serializeCapture(b.capture).length - 2);
  assert(counter.counts.opens <= expected.pages.length + 1);
  assert.deepEqual((await inspectProcessing(a.capability, a.operationId)).claim.acknowledged, []);
});

test('page extents reject changed bytes, truncation, short reads and linked capture bodies', async t => {
  const f = await processingFixture(t, { text: 'Z'.repeat(90000) }), claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs, budget: { maxInputs: 5, maxPacketBytes: 4 * 1024 * 1024 } });
  const file = rawFile(f), original = await fs.readFile(file), changed = Buffer.from(original); changed[changed.indexOf('ZZZZ')] = 89;
  await fs.writeFile(file, changed); await assert.rejects(page(f, claim), /PACKET_CHANGED/);
  await fs.writeFile(file, original.subarray(0, original.length - 1)); await assert.rejects(page(f, claim), /PACKET_CHANGED/);
  await fs.writeFile(file, original);
  const open = fs.open;
  fs.open = async (name, ...args) => { const handle = await open(name, ...args); if (name === file) handle.read = async () => ({ bytesRead: 0 }); return handle; };
  try { await assert.rejects(page(f, claim), /PACKET_CHANGED/); } finally { fs.open = open; }
  const link = file + '.external'; await fs.link(file, link);
  await assert.rejects(page(f, claim), /UNSAFE_PRIVATE_STORAGE/); await fs.unlink(link);
  assert.equal((await page(f, claim)).hash, claim.packet.pages[0]);
});

test('page metadata and policy changes reject before opening raw evidence', async t => {
  const f = await processingFixture(t), claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const stored = JSON.parse(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'claims', f.operationId + '.json')));
  const names = [
    [f.collection.intakeStateDir, `heads/${f.identity.client}/${f.identity.sessionId}/${f.identity.unitId}.json`],
    [f.collection.intakeStateDir, 'pending.json'], [f.collection.intakeStateDir, 'prune-pending.json'],
    [f.collection.intakeStateDir, `pruned/${f.identity.client}/${f.identity.sessionId}/${f.identity.unitId}.json`],
    [f.collection.notes.writerStateDir, associationPath(f.identity, stored.bindingHash)],
    [f.collection.notes.writerStateDir, dispositionPath(f.identity, f.inputs[0].headHash, stored.bindingHash)],
  ];
  const counter = rawReadCounter([rawFile(f)]);
  try {
    for (const [root, name] of names) {
      const file = path.join(root, name); let previous = null;
      try { previous = await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, '{}', { mode: 0o600 });
      await assert.rejects(page(f, claim));
      if (previous === null) await fs.unlink(file); else await fs.writeFile(file, previous);
    }
    f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config));
    await assert.rejects(page(f, claim), /WORKFLOW_POLICY_CHANGED/);
  } finally { counter.restore(); }
  assert.equal(counter.counts.opens, 0);
});

test('unread range corruption may leave a page valid but cannot pass full proposal validation', async t => {
  const f = await processingFixture(t, { text: 'K'.repeat(120000) }), claim = await inspectedClaim(f, { budget: { maxInputs: 5, maxPacketBytes: 4 * 1024 * 1024 } });
  const file = rawFile(f), original = await fs.readFile(file), changed = Buffer.from(original);
  changed[changed.indexOf('KKKK') + 80000] = 76; await fs.writeFile(file, changed);
  assert.equal((await page(f, claim)).hash, claim.packet.pages[0]);
  await assert.rejects(proposedClaim(f, { claim }), /HASH|CHANGED/);
});

test('invalid extent manifests cannot select arbitrary offsets or weaken page bounds', async t => {
  const f = await processingFixture(t), claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const saved = JSON.parse(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'claims', f.operationId + '.json')));
  for (const mutate of [p => { p.captureBytes[0]--; }, p => { p.captureBytes.push(1); }, p => { p.pageEnds[0]--; }, p => { p.path = '/unselected'; }]) {
    const changed = structuredClone(saved); mutate(changed.packet); assert.throws(() => validateClaim(changed));
  }
  assert(claim.packet.captureBytes[0] > 0);
});

test('unpublished processing stages do not block fresh preparation, direct save or prune', async t => {
  const f = await processingFixture(t), stageRoot = path.join(f.collection.notes.writerStateDir, 'processing-stages');
  const rename = fs.rename, unlink = fs.unlink; let abandoned;
  fs.rename = async (from, to) => {
    if (path.dirname(from) === stageRoot) { abandoned = from; throw new Error('simulated interruption before metadata publication'); }
    return rename(from, to);
  };
  fs.unlink = async file => { if (file === abandoned) throw Object.assign(new Error('simulated cleanup failure'), { code: 'EACCES' }); return unlink(file); };
  try { await assert.rejects(prepareProcessing(f.capability, { ...f.args, inputs: f.inputs })); }
  finally { fs.rename = rename; fs.unlink = unlink; }
  assert(abandoned); const original = await fs.readFile(abandoned);
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' });
  await inspectWriterMaintenance(f.collection.notes.writerStateDir);
  const contentPath = path.join(f.root, 'direct.md'); await fs.writeFile(contentPath, '# Direct note\n\n## Decision\n\nKeep this.\n');
  const plan = { version: 1, mode: 'authored', root: f.collection.notes.notesDir, stateDir: f.collection.notes.writerStateDir,
    files: [{ path: 'direct.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) }] };
  await saveDirectNote({ plan, approvedPlanHash: digest(canonicalJSON(plan)) }, f.capability);
  const prune = await previewCapturePrune(f.capability, { identities: [f.identity] }); await applyCapturePrune(f.capability, prune);
  assert.deepEqual(await fs.readFile(abandoned), original);
  const unfamiliar = path.join(f.collection.notes.writerStateDir, 'claims', '.unknown.tmp'); await fs.writeFile(unfamiliar, 'unfamiliar', { mode: 0o600 });
  await assert.rejects(inspectWriterMaintenance(f.collection.notes.writerStateDir), /pending/);
});

test('revoked metadata cleanup warns and leaves an inert stage that does not block pruning', async t => {
  const f = await processingFixture(t), open = fs.open, config = await fs.readFile(f.options.configPath);
  const contentPath = path.join(f.root, 'direct.md'); await fs.writeFile(contentPath, '# Direct note\n\n## Decision\n\nKeep this.\n');
  const plan = { version: 1, mode: 'authored', root: f.collection.notes.notesDir, stateDir: f.collection.notes.writerStateDir,
    files: [{ path: 'direct.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) }] };
  let stage;
  fs.open = async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (flags === 'wx' && path.dirname(file) === path.join(plan.stateDir, 'metadata-stages')) {
      stage = file; const close = handle.close.bind(handle);
      handle.close = async () => { await close(); f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config)); };
    }
    return handle;
  };
  try {
    await assert.rejects(saveDirectNote({ plan, approvedPlanHash: digest(canonicalJSON(plan)) }, f.capability), error => {
      assert.match(error.message, /WORKFLOW_POLICY_CHANGED/);
      assert.match(error.cleanupWarnings.join('\n'), /Metadata stage retained/); return true;
    });
  } finally { fs.open = open; }
  assert(stage); const original = await fs.readFile(stage);
  assert(original.length > 0); assert.equal(await fingerprint(path.join(plan.root, 'direct.md')), null);
  await fs.writeFile(f.options.configPath, config);
  await inspectWriterMaintenance(plan.stateDir);
  const claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  await completeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, outcome: 'skipped' });
  const prune = await previewCapturePrune(f.capability, { identities: [f.identity] }); await applyCapturePrune(f.capability, prune);
  assert.deepEqual(await fs.readFile(stage), original);
});

for (const name of ['processing-stages', 'metadata-stages']) {
  test(`maintenance refuses a linked ${name} namespace`, async t => {
    const f = await processingFixture(t), stageRoot = path.join(f.collection.notes.writerStateDir, name);
    if (name === 'metadata-stages') await fs.rmdir(stageRoot);
    await fs.symlink(f.project, stageRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectWriterMaintenance(f.collection.notes.writerStateDir), /Unsafe (processing|metadata) stage/);
  });
}

test('a completed save remains successful when policy changes after its final mutation', async t => {
  const f = await processingFixture(t), p = await proposedClaim(f), rmdir = fs.rmdir;
  const proposalDir = path.join(f.collection.notes.writerStateDir, 'proposals', f.operationId); let changed = false;
  fs.rmdir = async (file, ...args) => {
    const result = await rmdir(file, ...args);
    if (file === proposalDir) { changed = true; f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config)); }
    return result;
  };
  let result;
  try { result = await save(f, p); } finally { fs.rmdir = rmdir; }
  assert(changed); assert.equal(result.status, 'saved'); assert.equal(result.operationId, f.operationId);
  assert.equal(await fingerprint(p.target), p.plan.files[0].expectedContentHash);
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'processed/operations', f.operationId + '.json')), result.receiptHash);
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'claims', f.operationId + '.json')), null);
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'transactions', f.operationId + '.json')), null);
});

test('previously issued evidence pages still check policy after reading and before returning bytes', async t => {
  const f = await processingFixture(t), claim = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs });
  const issued = await page(f, claim), open = fs.open; let changed = false;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === rawFile(f)) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); changed = true; f.config.routes[0].excluded = true; await fs.writeFile(f.options.configPath, JSON.stringify(f.config)); };
    }
    return handle;
  };
  try { await assert.rejects(page(f, issued), /WORKFLOW_POLICY_CHANGED/); } finally { fs.open = open; }
  assert(changed);
});

for (const mutation of ['policy', 'head', 'association', 'disposition', 'pending', 'private-path']) {
  test(`writer boundary retains a conflict when ${mutation} changes after note staging`, async t => {
    const f = await processingFixture(t), p = await proposedClaim(f), binding = await workflowProcessingBinding(f.capability);
    let changed = false;
    await assert.rejects(save(f, p, { fault: async at => {
      if (at !== 'afterStage' || changed) return; changed = true;
      let file;
      if (mutation === 'policy') { f.config.routes[0].excluded = true; file = f.options.configPath; }
      else if (mutation === 'head') file = path.join(f.collection.intakeStateDir, `heads/${f.identity.client}/${f.identity.sessionId}/${f.identity.unitId}.json`);
      else if (mutation === 'association') file = path.join(f.collection.notes.writerStateDir, associationPath(f.identity, binding.hash));
      else if (mutation === 'disposition') file = path.join(f.collection.notes.writerStateDir, dispositionPath(f.identity, f.inputs[0].headHash, binding.hash));
      else if (mutation === 'pending') file = path.join(f.collection.intakeStateDir, 'pending.json');
      else {
        file = path.join(f.collection.intakeStateDir, 'pending.json');
        await fs.unlink(file); await fs.link(f.source.path, file); return;
      }
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, mutation === 'policy' ? JSON.stringify(f.config) : '{}', { mode: 0o600 });
    } }));
    assert(changed); assert.equal(await fingerprint(p.target), null);
    assert(await fingerprint(path.join(f.collection.notes.writerStateDir, 'transactions', f.operationId + '.json')));
    assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'processed/writes', f.operationId, 'record.json')), null);
  });
}

test('batch authorization requires Automatic on every input and fresh configuration', async t => {
  const f = await processingFixture(t), subdir = path.join(f.project, 'manual'); await fs.mkdir(subdir);
  f.config.routes[0].processing.mode = 'automatic';
  f.config.routes.push({ ...structuredClone(f.config.routes[0]), id: 'manual', projectRoot: subdir, processing: { mode: 'manual' } });
  const bytes = JSON.stringify(f.config); await fs.writeFile(f.options.configPath, bytes);
  f.capability = await verifyWorkflowStorage({ ...f.options, expectedConfigHash: digest(bytes) });
  const request = selection => ({ selection, operation: 'explicitProcess', automatic: true });
  await assertWorkflowAuthorizations(f.capability, [request(f.selection)]);
  await assert.rejects(assertWorkflowAuthorizations(f.capability, [request(f.selection), request({ ...f.selection, cwd: subdir })]), /APPROVAL_REQUIRED/);
  await fs.appendFile(f.options.configPath, '\n'); await assert.rejects(assertWorkflowAuthorizations(f.capability, []), /POLICY_CHANGED/);
});

test('an existing processing-stage directory must be private before any staged bytes are written', async t => {
  const f = await processingFixture(t), stageRoot = path.join(f.collection.notes.writerStateDir, 'processing-stages');
  await fs.mkdir(stageRoot, { mode: 0o700 });
  if (process.platform === 'win32') {
    const { systemCommand, windowsTools } = await import('./storage-platform.mjs');
    await systemCommand(windowsTools().icacls, [stageRoot, '/grant', '*S-1-1-0:(OI)(CI)F']);
  } else await fs.chmod(stageRoot, 0o755);
  await assert.rejects(prepareProcessing(f.capability, { ...f.args, inputs: f.inputs }), /STORAGE_NOT_PRIVATE/);
  assert.deepEqual(await fs.readdir(stageRoot), []);
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'claims', f.operationId + '.json')), null);
});

test('new stage-file permissions are verified before writing even when its parent is private', async t => {
  const f = await processingFixture(t), stageRoot = path.join(f.collection.notes.writerStateDir, 'processing-stages'), open = fs.open;
  let staged;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (path.dirname(file) === stageRoot && args[0] === 'wx') {
      staged = file;
      if (process.platform === 'win32') {
        const { systemCommand, windowsTools } = await import('./storage-platform.mjs');
        await systemCommand(windowsTools().icacls, [file, '/grant', '*S-1-1-0:F']);
      } else await handle.chmod(0o644);
    }
    return handle;
  };
  try { await assert.rejects(prepareProcessing(f.capability, { ...f.args, inputs: f.inputs }), /STORAGE_NOT_PRIVATE/); }
  finally { fs.open = open; }
  assert(staged); assert.equal((await fs.stat(staged)).size, 0);
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'claims', f.operationId + '.json')), null);
});

for (const kind of ['foreign-coordination', 'incomplete-directory']) {
  test(`a ${kind} receipt cannot bypass writer-boundary authorization`, async t => {
    const f = await processingFixture(t), p = await proposedClaim(f); let injected = false;
    await assert.rejects(save(f, p, { fault: async at => {
      if (at !== 'afterStage' || injected) return; injected = true;
      const parent = path.join(f.collection.notes.writerStateDir, 'processed/writes', f.operationId);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      if (kind === 'incomplete-directory') return;
      const tx = JSON.parse(await fs.readFile(path.join(f.collection.notes.writerStateDir, 'transactions', f.operationId + '.json')));
      const receipt = { format: 'cuefluent-writer-receipt', version: 1,
        coordination: { binding: tx.writerBinding, transactionHash: 'f'.repeat(64) },
        outputs: p.plan.files.map(file => ({ path: file.path, hash: file.expectedContentHash })), manifestHash: null, committedAt: new Date().toISOString() };
      await fs.writeFile(path.join(parent, 'record.json'), canonicalJSON(receipt) + '\n', { mode: 0o600 });
    } }), kind === 'incomplete-directory' ? /WRITER_RECEIPT_INCOMPLETE/ : /PROCESSING_RECEIPT_CHANGED/);
    assert(injected); assert.equal(await fingerprint(p.target), null);
  });
}

test('processing proposal metadata rejection preserves existing authored bytes and accepts opaque schemas', async t => {
  for (const schema of [1, 2]) {
    const f = await processingFixture(t);
    const sources = schema === 1 ? metadataSource(f) : '';
    const content = `<!-- cuefluent\nschema_version: ${schema}\nid: note_processing\n${sources}-->\n\n# Meeting\n\n## Decision\n\nKeep rollout paused.\n`;
    const proposed = await proposedClaim(f, { name: 'meeting.md', content });
    assert.equal(await fs.readFile(proposed.plan.files[0].contentPath, 'utf8'), content);
  }
  const f = await processingFixture(t), target = path.join(f.collection.notes.notesDir, 'meeting.md');
  const malformed = '<!-- cuefluent\nschema_version: 1\nid: note_processing\ncreated: yesterday\n-->\n\n# Meeting\n\n## Decision\n\nHuman correction.\n';
  await fs.writeFile(target, malformed);
  await assert.rejects(proposedClaim(f, { name: 'meeting.md', content: malformed + '\nProposed addition.\n' }), /INVALID_PROCESSING_MARKDOWN/);
  assert.equal(await fs.readFile(target, 'utf8'), malformed);
});

test('processing proposal binds every metadata capture source to its mapped immutable input', async t => {
  const f = await processingFixture(t), second = await processingFixture(t, { base: f });
  f.inputs.push(...second.inputs);
  const claim = await inspectedClaim(f), contentPath = path.join(f.root, 'metadata-proposal.md');
  const source = input => ({ type: 'session', client: input.identity.client, session_id: input.identity.sessionId,
    unit_id: input.identity.unitId, revision: input.evidenceHash, source_hash: `sha256:${input.fileHash}` });
  const sources = claim.inputs.map(source), body = '# Meeting\n\n## Decision\n\nKeep rollout paused.\n';
  const propose = async selected => {
    const content = prepareNote({ original: null, content: body, now: '2026-10-01T12:00:00Z', skillVersion: '0.9.0', metadata: { sources: selected } }).content;
    await fs.writeFile(contentPath, content);
    const proposal = { files: [{ path: 'meeting.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) }],
      mappings: claim.inputs.map(input => ({ identity: input.identity, paths: ['meeting.md'] })) };
    return proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, proposal });
  };
  await assert.rejects(propose(sources.slice(0, 1)), /NOTE_METADATA_INPUT_MISSING/);
  await assert.rejects(propose([...sources, { ...sources[0], revision: 'f'.repeat(64) }]), /NOTE_METADATA_INPUT_MISMATCH/);
  await assert.rejects(propose([{ ...sources[0], source_hash: 'sha256:' + 'f'.repeat(64) }, sources[1]]), /NOTE_METADATA_INPUT_MISMATCH/);
  assert.equal(await fingerprint(path.join(f.collection.notes.notesDir, 'meeting.md')), null);
  const proposed = await propose(sources), approved = await fs.readFile(contentPath, 'utf8');
  assert.equal((await save(f, proposed)).status, 'saved');
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'meeting.md'), 'utf8'), approved);
});

test('processing cannot propose removal or repair of malformed existing metadata', async t => {
  for (const replacement of ['remove', 'repair']) {
    const f = await processingFixture(t), claim = await inspectedClaim(f);
    const body = '# Meeting\n\n## Decision\n\nHuman correction.\n';
    const metadata = '<!-- cuefluent\nschema_version: 1\nid: note_processing\n';
    const malformed = metadata + 'created: yesterday\n-->\n\n' + body;
    const target = path.join(f.collection.notes.notesDir, 'meeting.md');
    await fs.writeFile(target, malformed);
    const content = replacement === 'remove' ? body : metadata + '-->\n\n' + body;
    await assert.rejects(proposedClaim(f, { name: 'meeting.md', content, claim }), /INVALID_EXISTING_NOTE_METADATA/);
    assert.equal(await fs.readFile(target, 'utf8'), malformed);
    const stateDir = f.collection.notes.writerStateDir;
    assert.equal(await fingerprint(path.join(stateDir, 'proposals', f.operationId, 'record.json')), null);
    assert.equal(await fingerprint(path.join(stateDir, 'proposals', f.operationId, '0.md')), null);
    assert.equal(await fingerprint(path.join(stateDir, 'claims', f.operationId + '.json')), claim.claimHash);
    assert.equal(await fingerprint(path.join(stateDir, 'journal.json')), null);
  }
});

test('processing preserves opaque metadata before recording a replacement proposal', async t => {
  const f = await processingFixture(t), claim = await inspectedClaim(f);
  const block = '<!-- cuefluent\r\nschema_version: 2\r\nid: note_future\r\nextension: "keep me"\r\n-->\r\n';
  const body = '# Meeting\n\n## Decision\n\nHuman correction.\n';
  const original = block + '\n' + body, target = path.join(f.collection.notes.notesDir, 'meeting.md');
  await fs.writeFile(target, original);
  for (const next of ['', block.replace('2', '1'), block.replace('keep me', 'changed'),
    block.replace('"keep me"', "'keep me'"), block.replaceAll('\r\n', '\n')]) {
    await assert.rejects(proposedClaim(f, { name: 'meeting.md', content: next + '\n' + body, claim }), { code: 'NOTE_METADATA_OPAQUE_CHANGED' });
    assert.equal(await fs.readFile(target, 'utf8'), original);
    const stateDir = f.collection.notes.writerStateDir;
    assert.equal(await fingerprint(path.join(stateDir, 'proposals', f.operationId, 'record.json')), null);
    assert.equal(await fingerprint(path.join(stateDir, 'proposals', f.operationId, '0.md')), null);
    assert.equal(await fingerprint(path.join(stateDir, 'claims', f.operationId + '.json')), claim.claimHash);
  }
  const content = original + '\nSupported addition.\n';
  const proposed = await proposedClaim(f, { name: 'meeting.md', content, claim });
  assert.equal(await fs.readFile(proposed.plan.files[0].contentPath, 'utf8'), content);
  assert.equal(await fs.readFile(target, 'utf8'), original);
});

test('processing reuses inspections and rejects creation backfills before proposal intent', async t => {
  const f = await processingFixture(t), claim = await inspectedClaim(f);
  const target = path.join(f.collection.notes.notesDir, 'meeting.md');
  const body = '# Meeting\n\n## Decision\n\nEvidence.\n';
  const original = `<!-- cuefluent\nschema_version: 1\nid: no_creation\n${metadataSource(f)}-->\n` + body;
  await fs.writeFile(target, original);
  const changed = original.replace('schema_version: 1', 'schema_version: 1\ncreated: "2001-01-01T00:00:00Z"');
  await assert.rejects(proposedClaim(f, { name: 'meeting.md', content: changed, claim }), { code: 'NOTE_METADATA_IDENTITY_CHANGED' });
  assert.equal(await fs.readFile(target, 'utf8'), original);
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'claims', f.operationId + '.json')), claim.claimHash);
  assert.equal(await fingerprint(path.join(f.collection.notes.writerStateDir, 'proposals', f.operationId, 'record.json')), null);

  const plain = body + '\n```markdown\n<!-- cuefluent PARSE_SENTINEL -->\n```\n';
  await fs.writeFile(target, plain);
  const parse = MarkdownIt.prototype.parse; let count = 0;
  const mocked = t.mock.method(MarkdownIt.prototype, 'parse', function (source, ...args) {
    if (source.includes('PARSE_SENTINEL')) count++;
    return parse.call(this, source, ...args);
  });
  const proposed = await proposedClaim(f, { name: 'meeting.md', content: plain + '\nAddition.\n', claim });
  mocked.mock.restore();
  assert.equal(count, 2, 'one proposed and one current inspection, without transition reparsing');
  assert.equal(await fs.readFile(proposed.plan.files[0].contentPath, 'utf8'), plain + '\nAddition.\n');
});

test('processing rejects unused footnote body markers before recording a proposal', async t => {
  const f = await processingFixture(t), claim = await inspectedClaim(f);
  const body = '# Meeting\n\n## Decision\n\nVisible evidence.\n';
  for (const fragment of ['[^unused]: text <!-- cuefluent -->', '[^unused]: [link](url "<!-- cuefluent")']) {
    await assert.rejects(proposedClaim(f, { name: 'meeting.md', content: body + '\n' + fragment + '\n', claim }), { code: 'INVALID_PROCESSING_MARKDOWN' });
    const stateDir = f.collection.notes.writerStateDir;
    assert.equal(await fingerprint(path.join(stateDir, 'proposals', f.operationId, 'record.json')), null);
    assert.equal(await fingerprint(path.join(stateDir, 'proposals', f.operationId, '0.md')), null);
    assert.equal(await fingerprint(path.join(stateDir, 'claims', f.operationId + '.json')), claim.claimHash);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  }
});

test('processing rejects C1 metadata controls before recording a proposal', async t => {
  const f = await processingFixture(t), claim = await inspectedClaim(f);
  for (const schema of [1, 2]) {
    const content = `<!-- cuefluent\nschema_version: ${schema}\nid: note_controls\nextension: "\\N"\n-->\n\n# Meeting\n\n## Decision\n\nVisible evidence.\n`;
    await assert.rejects(proposedClaim(f, { name: 'meeting.md', content, claim }), { code: 'INVALID_PROCESSING_MARKDOWN' });
    const stateDir = f.collection.notes.writerStateDir;
    assert.equal(await fingerprint(path.join(stateDir, 'proposals', f.operationId, 'record.json')), null);
    assert.equal(await fingerprint(path.join(stateDir, 'proposals', f.operationId, '0.md')), null);
    assert.equal(await fingerprint(path.join(stateDir, 'claims', f.operationId + '.json')), claim.claimHash);
    assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  }
});

test('processing rejects unquoted timestamps before recording intent and preserves existing bytes', async t => {
  const f = await processingFixture(t), claim = await inspectedClaim(f), stateDir = f.collection.notes.writerStateDir;
  const body = '# Meeting\n\n## Decision\n\nVisible evidence.\n', stamp = '2026-10-01T07:42:00Z';
  const target = path.join(f.collection.notes.notesDir, 'meeting.md'); await fs.writeFile(target, body);
  for (const field of ['created', 'updated']) for (const value of [stamp, `|-\n  ${stamp}`, `>-\n  ${stamp}`]) {
    const content = `<!-- cuefluent\nschema_version: 1\nid: note_timestamp\n${field}: ${value}\n-->\n\n` + body;
    await assert.rejects(proposedClaim(f, { name: 'meeting.md', content, claim }), { code: 'INVALID_PROCESSING_MARKDOWN' });
    assert.equal(await fs.readFile(target, 'utf8'), body);
    for (const name of [`proposals/${f.operationId}/record.json`, `proposals/${f.operationId}/0.md`, 'journal.json']) {
      assert.equal(await fingerprint(path.join(stateDir, name)), null, name);
    }
    assert.equal(await fingerprint(path.join(stateDir, 'claims', f.operationId + '.json')), claim.claimHash);
  }
  const quoted = `<!-- cuefluent\nschema_version: 1\nid: note_timestamp\ncreated: "${stamp}"\nupdated: '${stamp}'\n${metadataSource(f)}-->\n\n` + body;
  const approved = await proposedClaim(f, { name: 'meeting.md', content: quoted, claim });
  assert.equal((await save(f, approved)).status, 'saved');
  assert.equal(await fs.readFile(target, 'utf8'), quoted);
});

test('processing rejects duplicate proposed identities and deeply hidden markers before proposal publication', async t => {
  const f = await processingFixture(t), claim = await inspectedClaim(f);
  const metadata = `<!-- cuefluent\nschema_version: 1\nid: note_duplicate\nsources:\n  - type: session\n    client: ${f.identity.client}\n    session_id: ${f.identity.sessionId}\n    unit_id: ${f.identity.unitId}\n    revision: ${f.capture.evidenceHash}\n-->\n\n`;
  const content = metadata + '# Meeting\n\n## Decision\n\nKeep rollout paused.\n';
  const files = [];
  for (const name of ['first.md', 'second.md']) {
    const contentPath = path.join(f.root, 'proposal-' + name); await fs.writeFile(contentPath, content);
    files.push({ path: name, expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) });
  }
  const proposal = { files, mappings: [{ identity: f.identity, paths: files.map(file => file.path) }] };
  await assert.rejects(proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, proposal }), /NOTE_METADATA_ID_COLLISION/);
  assert.deepEqual(await fs.readdir(f.collection.notes.notesDir), []);
  for (const malformed of ['>'.repeat(100) + ' <!-- cuefluent\nid: hidden\n-->\n', '<!-- cuefluent? -->\n']) {
    const separate = await processingFixture(t);
    await assert.rejects(proposedClaim(separate, { content: content + '\n' + malformed }), /INVALID_PROCESSING_MARKDOWN/);
    assert.deepEqual(await fs.readdir(separate.collection.notes.notesDir), []);
  }
});

test('derived processing rejects retained identity collisions before recording proposal intent', async t => {
  const f = await processingFixture(t), stateDir = f.collection.notes.writerStateDir;
  const content = `<!-- cuefluent\nschema_version: 1\nid: note_retained\n${metadataSource(f)}-->\n\n# Meeting\n\n## Decision\n\nVisible evidence.\n`;
  const seed = path.join(f.root, 'seed.md'); await fs.writeFile(seed, content);
  await applyPlan({ version: 1, mode: 'derived', root: f.collection.notes.notesDir, stateDir, expectedManifestHash: null,
    files: [{ path: 'a.md', expectedHash: null, contentPath: seed, sources: [{ path: f.source.path, expectedHash: await fingerprint(f.source.path) }] }] });
  const manifestHash = await fingerprint(path.join(stateDir, 'manifest.json'));
  const claim = await inspectedClaim(f), contentPath = path.join(f.root, 'next.md');
  await fs.writeFile(contentPath, content + '\nNew evidence.\n');
  const file = { path: 'b.md', expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath) };
  const proposal = { mode: 'derived', expectedManifestHash: manifestHash, files: [file], mappings: [{ identity: f.identity, paths: ['b.md'] }] };
  await assert.rejects(proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, proposal }), { code: 'NOTE_METADATA_ID_COLLISION' });
  for (const name of [`proposals/${f.operationId}/record.json`, `proposals/${f.operationId}/0.md`, `transactions/${f.operationId}.json`, 'journal.json']) {
    assert.equal(await fingerprint(path.join(stateDir, name)), null, name);
  }
  assert.equal(await fingerprint(path.join(stateDir, 'claims', f.operationId + '.json')), claim.claimHash);
  assert.equal(await fingerprint(path.join(stateDir, 'manifest.json')), manifestHash);
  assert.equal(await fs.readFile(path.join(f.collection.notes.notesDir, 'a.md'), 'utf8'), content);
  assert.equal(await fingerprint(path.join(f.collection.notes.notesDir, 'b.md')), null);
  // Replacing the tracked note retains its ID without colliding with itself.
  file.path = 'a.md'; file.expectedHash = await fingerprint(path.join(f.collection.notes.notesDir, 'a.md'));
  proposal.mappings[0].paths = ['a.md'];
  const approved = await proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, proposal });
  assert.equal((await save(f, approved)).status, 'saved');
});
