import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageFixture } from './storage-fixture.mjs';
import { openWorkflowIntake, withIntakeLock } from '../intake-io.mjs';
import { stableSourceIdentity } from '../capture-selection.mjs';
import { controlSelection, publishCapture } from '../intake-store.mjs';
import { createCapture } from '../capture-contract.mjs';
import { digest } from '../workflow-values.mjs';
import { fingerprint } from '../safe-update.mjs';
import { prepareProcessing, readProcessingPage, acknowledgeProcessingPages, proposeProcessing } from '../processing.mjs';
import { privacyIdentity, protectNewDirectory } from '../storage-platform.mjs';

/** Replace a synthetic storage root while retaining its private ACL contract.
 * fs.cp does not copy Windows ACLs; protect the empty replacement before copying. */
export async function replaceProcessingStorage(root, suffix = '-original') {
  await fs.rename(root, `${root}${suffix}`);
  await fs.mkdir(root, { mode: 0o700 });
  if (process.platform === 'win32') await protectNewDirectory(root, await privacyIdentity());
  await fs.cp(`${root}${suffix}`, root, { recursive: true, preserveTimestamps: true });
}

export async function processingFixture(t, { base, client = 'codex', terminal = client === 'claude' ? 'unconfirmed' : 'completed', omissions = [], text = 'Synthetic meeting: keep the rollout paused.', evidence, nativeIdentity } = {}) {
  const f = base ?? await storageFixture(t, { fullSetup: false });
  await fs.mkdir(f.collection.notes.notesDir, { recursive: true });
  const sessionId = nativeIdentity?.sessionId ?? randomUUID(), unitId = nativeIdentity?.unitId ?? randomUUID(), identity = { client, sessionId, unitId };
  const selection = { client, sessionId, cwd: f.project, unitId: null };
  const store = await openWorkflowIntake(f.capability, selection, 'collect');
  const source = { client, sessionId, projectRoot: f.project, path: path.join(f.project, `${sessionId}.jsonl`) };
  await fs.writeFile(source.path, 'x'.repeat(300)); source.fileIdentity = stableSourceIdentity(await fs.lstat(source.path, { bigint: true }));
  const proof = { ...identity, sourceIdentity: source.fileIdentity,
    start: { id: 'start', startByte: 200, endByte: 220, hash: digest('x'.repeat(20)) },
    end: { id: 'end', startByte: 280, endByte: 300, hash: digest('x'.repeat(20)) }, nativeOrder: null };
  const request = { id: randomUUID(), operation: 'capture-current', ...identity, expectedRevision: 0,
    scope: { unitIds: [unitId], start: proof.start, end: null, contentHash: proof.start.hash } };
  const authorize = async () => true;
  const state = await withIntakeLock(store, tx => controlSelection(tx, { source, request, expectedHash: null, authorize }));
  const range = { startByte: 220, endByte: 280, recordIds: ['message'] };
  const capture = createCapture({ format: 'cuefluent-capture', schemaVersion: 2, identity, projectRoot: f.project,
    source: { path: source.path, fileIdentity: source.fileIdentity, ranges: [range] }, reader: { name: 'fixture', version: '1', headerClientVersion: 'fixture' },
    occurredAt: '2026-01-01T00:00:00.000Z', capturedAt: '2026-01-01T00:00:00.000Z', terminal,
    coverage: { partial: terminal !== 'completed' || omissions.length > 0, omissions }, evidence: evidence ?? [{ kind: 'user', recordId: 'message', range, text }] });
  const scan = { from: { sourceIdentity: source.fileIdentity, offset: 200, anchor: null },
    to: { sourceIdentity: source.fileIdentity, offset: 300, anchor: { startByte: 280, endByte: 300, hash: proof.end.hash } },
    accounted: [{ kind: 'captured', unitId, startByte: 200, endByte: 300 }] };
  // Processing fixtures use synthetic native bytes; real-reader coverage lives
  // in the reader suites. Claude publication still requires its cursor contract.
  const checkpoint = client === 'claude' ? { format: 'cuefluent-reader-checkpoint', version: 1, reader: 'fixture', client, sessionId,
    scopeId: request.id, sourceIdentity: source.fileIdentity, offset: 300, records: [], units: [] } : null;
  const publishArgs = { capture, proof, scopeId: request.id, selectionHash: state.hash, cursorHash: null, scan, checkpoint, authorize };
  const published = await withIntakeLock(store, tx => publishCapture(tx, publishArgs));
  const operationId = randomUUID(), inputs = [{ identity, headHash: published.headHash }];
  const args = { selection, operationId };
  return { ...f, store, source, capture, identity, selection, operationId, args, inputs, published, publishArgs };
}
export async function inspectedClaim(f, extra = {}) {
  let claimed = await prepareProcessing(f.capability, { ...f.args, inputs: f.inputs, ...extra });
  for (let page = 0; page < claimed.packet.pages.length; page++) {
    const issued = await readProcessingPage(f.capability, { ...f.args, expectedClaimHash: claimed.claimHash, page });
    claimed = await acknowledgeProcessingPages(f.capability, { ...f.args, expectedClaimHash: issued.claimHash, pages: [{ index: page, hash: issued.hash }] });
  }
  return claimed;
}
export async function proposedClaim(f, { name = 'meetings/rollout.md', content = '# Rollout meeting\n\n## Decision\n\nKeep the rollout paused.\n', claim } = {}) {
  claim ??= await inspectedClaim(f);
  const contentPath = path.join(f.root, `${randomUUID()}.md`); await fs.writeFile(contentPath, content, { mode: 0o600 });
  const proposal = { files: [{ path: name, expectedHash: await fingerprint(path.join(f.collection.notes.notesDir, name)), contentPath, expectedContentHash: await fingerprint(contentPath) }],
    mappings: [{ identity: f.identity, paths: [name] }] };
  const proposed = await proposeProcessing(f.capability, { ...f.args, expectedClaimHash: claim.claimHash, proposal });
  return { ...proposed, request: proposal, contentPath, target: path.join(f.collection.notes.notesDir, name) };
}
