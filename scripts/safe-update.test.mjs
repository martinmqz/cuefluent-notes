import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { abortUpdate, fingerprint, applyPlan, recover, inspectState } from './safe-update.mjs';
import { prepareNote } from './note-generation.mjs';
import MarkdownIt from 'markdown-it';

async function fixture(t, mode = 'authored') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-update-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'notes');
  const stateDir = path.join(directory, 'state');
  await fs.mkdir(root);
  const source = path.join(directory, 'source.md');
  await fs.writeFile(source, '# Evidence\n\n## Observed\n\nOn September 3, a synthetic test passed once.\n');
  const proposal = path.join(directory, 'proposal.md');
  await fs.writeFile(proposal, '# Topic\n\n## Finding\n\nOn September 3, a synthetic test passed once; live behavior remains untested.\n');
  const target = path.join(root, 'note.md');
  const plan = {
    version: 1, root, stateDir, mode,
    ...(mode === 'derived' ? { expectedManifestHash: null } : {}),
    files: [{ path: 'note.md', expectedHash: null, contentPath: proposal,
      sources: [{ path: source, expectedHash: await fingerprint(source) }],
      entries: [{ heading: 'Finding', sourcePaths: [source] }] }]
  };
  return { directory, root, stateDir, source, proposal, target, plan };
}
async function reinspect(plan) {
  for (const file of plan.files) file.expectedHash = await fingerprint(path.join(plan.root, file.path));
  if (plan.mode === 'derived') plan.expectedManifestHash = await fingerprint(path.join(plan.stateDir, 'manifest.json'));
}
test('nested portable note paths save successfully', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'nested café'));
  f.plan.files[0].path = 'nested café/decision.md';
  await applyPlan(f.plan);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'nested café', 'decision.md')), await fs.readFile(f.proposal));
});
test('Windows aliases, junctions and read-only notes cannot redirect or authorize replacement', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  for (const name of ['NUL.md', 'topic.md:stream.md', 'folder./note.md', 'COM1.md']) {
    await assert.rejects(applyPlan({ ...f.plan, files: [{ ...f.plan.files[0], path: name }] }), /relative/);
  }
  await assert.rejects(applyPlan({ ...f.plan, files: [f.plan.files[0], { ...f.plan.files[0], path: 'NOTE.md' }] }), /Duplicate/);
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.root, 'junction'), 'junction');
  await assert.rejects(applyPlan({ ...f.plan, files: [{ ...f.plan.files[0], path: 'junction/note.md' }] }), /symlink/);
  await applyPlan(f.plan);
  await reinspect(f.plan);
  await fs.appendFile(f.proposal, '\nReviewed update.\n');
  await assert.rejects(applyPlan({ ...f.plan, files: [{ ...f.plan.files[0], path: 'NOTE.md' }] }), /canonical/);
  const before = await fs.readFile(f.target);
  await fs.chmod(f.target, 0o444);
  t.after(() => fs.chmod(f.target, 0o666).catch(() => {}));
  await assert.rejects(applyPlan(f.plan), /read-only/);
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.equal((await fs.stat(f.target)).mode & 0o200, 0);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});
test('Windows Unicode case aliases are rejected before any output or journal is written', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const probe = path.join(f.directory, 'Ä-probe.md');
  await fs.writeFile(probe, 'case comparison probe');
  const first = await fs.stat(probe, { bigint: true });
  const alias = await fs.stat(path.join(f.directory, 'ä-probe.md'), { bigint: true });
  assert.equal(first.ino, alias.ino, 'Native filesystem must exercise the Unicode alias.');
  const secondProposal = path.join(f.directory, 'second.md');
  await fs.copyFile(f.proposal, secondProposal);
  const files = [{ ...f.plan.files[0], path: 'Ä.md' }, { ...f.plan.files[0], path: 'ä.md', contentPath: secondProposal }];
  await assert.rejects(applyPlan({ ...f.plan, files }), /Duplicate/);
  assert.deepEqual(await fs.readdir(f.root), []);
  await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
});
test('authored writes preserve bytes, support explicit updates and leave no-op mtime alone', async t => {
  const { plan, proposal, target, stateDir } = await fixture(t);
  assert.equal((await applyPlan(plan)).status, 'updated');
  assert.deepEqual(await fs.readFile(target), await fs.readFile(proposal));
  await assert.rejects(fs.stat(path.join(stateDir, 'manifest.json')), { code: 'ENOENT' });
  await reinspect(plan);
  const stat = await fs.stat(target, { bigint: true });
  assert.equal((await applyPlan(plan)).status, 'unchanged');
  assert.equal((await fs.stat(target, { bigint: true })).mtimeNs, stat.mtimeNs);
  await fs.appendFile(proposal, '\nCorrection recorded September 4: test was one invocation.\n');
  assert.equal((await applyPlan(plan)).status, 'updated');
  assert.match(await fs.readFile(target, 'utf8'), /Correction recorded September 4/);
});
test('native alias evidence informs collision guards without merging distinct Windows names', {
  skip: !['win32', 'darwin'].includes(process.platform),
}, async t => {
  for (const [first, second] of [['Note', 'note'], ['ı', 'i'], ['ſ', 's'], ['µ', 'μ'], ['é', 'e\u0301']]) {
    const f = await fixture(t);
    // Record actual native aliases separately from the conservative batch rule.
    const probe = path.join(f.directory, `${first}-probe.md`);
    await fs.writeFile(probe, 'synthetic comparison');
    const actual = await fs.stat(path.join(f.directory, `${second}-probe.md`), { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const aliases = actual?.ino === (await fs.stat(probe, { bigint: true })).ino;
    t.diagnostic(`${process.platform}: ${first}/${second} native aliases: ${aliases}`);
    await fs.unlink(probe);
    const collision = process.platform === 'darwin' || first.toLowerCase() === second.toLowerCase();
    assert.ok(!aliases || collision, 'Native aliases must be refused by the preflight rule.');
    const secondProposal = path.join(f.directory, 'second-proposal.md');
    await fs.copyFile(f.proposal, secondProposal);
    const files = [{ ...f.plan.files[0], path: `${first}.md` },
      { ...f.plan.files[0], path: `${second}.md`, contentPath: secondProposal }];
    if (collision) {
      await assert.rejects(applyPlan({ ...f.plan, files }), /Duplicate/);
      assert.deepEqual(await fs.readdir(f.root), []);
      await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
    } else {
      await applyPlan({ ...f.plan, files });
      assert.equal((await fs.readdir(f.root)).length, 2);
    }
  }
});
test('existing output aliases preserve the on-disk name and bytes', async t => {
  const f = await fixture(t);
  await applyPlan(f.plan);
  const actual = await fs.stat(path.join(f.root, 'NOTE.md')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!actual) { t.skip('Selected volume is case-sensitive.'); return; }
  await reinspect(f.plan);
  await fs.appendFile(f.proposal, '\nA reviewed update.\n');
  const before = await fs.readFile(f.target);
  await assert.rejects(applyPlan({ ...f.plan, files: [{ ...f.plan.files[0], path: 'NOTE.md' }] }), /canonical/);
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.deepEqual(await fs.readdir(f.root), ['note.md']);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});
test('inspected-state conflict and invalid proposed Markdown preserve original bytes', async t => {
  const { plan, proposal, target } = await fixture(t);
  await applyPlan(plan);
  await reinspect(plan);
  await fs.appendFile(target, '\nManual user detail.\n');
  const before = await fs.readFile(target);
  await assert.rejects(applyPlan(plan), /conflict|changed|match/i);
  assert.deepEqual(await fs.readFile(target), before);
  await reinspect(plan);
  await fs.writeFile(proposal, '# Invalid\n\nNo H2.\n');
  await assert.rejects(applyPlan(plan), /Markdown|compatib|validation|check/i);
  assert.deepEqual(await fs.readFile(target), before);
});
test('derived refresh tracks source drift and refuses fresh-snapshot overwrite of manual edits', async t => {
  const { plan, source, target, stateDir } = await fixture(t, 'derived');
  await applyPlan(plan);
  await reinspect(plan);
  const manifest = JSON.parse(await fs.readFile(path.join(stateDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.guideVersion);
  await fs.appendFile(source, '\nNew evidence.\n');
  assert.equal((await inspectState(stateDir)).sources.find(s => s.path === source).status, 'changed');
  await assert.rejects(applyPlan(plan), /source|evidence|changed|match/i);
  plan.files[0].sources[0].expectedHash = await fingerprint(source);
  await fs.appendFile(target, '\nHuman correction.\n');
  await reinspect(plan);
  const before = await fs.readFile(target);
  await assert.rejects(applyPlan(plan), /manual|generated|conflict/i);
  assert.deepEqual(await fs.readFile(target), before);
  await fs.unlink(source);
  assert.equal((await inspectState(stateDir)).sources.find(s => s.path === source).status, 'missing');
  assert.deepEqual(await fs.readFile(target), before);
});
test('derived initial generation cannot adopt an existing untracked output', async t => {
  const { plan, target } = await fixture(t, 'derived');
  await fs.writeFile(target, '# User note\n\n## Original\n\nUser content.');
  await reinspect(plan);
  await assert.rejects(applyPlan(plan), /untracked|existing|generated|fresh|conflict/i);
  assert.match(await fs.readFile(target, 'utf8'), /User content/);
});
test('a source change can refresh reviewed derived output; stale manifest plans fail', async t => {
  const { plan, source, proposal, stateDir, target } = await fixture(t, 'derived');
  await applyPlan(plan);
  await reinspect(plan);
  const stalePlan = structuredClone(plan);
  await fs.appendFile(source, '\nA second test occurred on September 4.');
  await fs.appendFile(proposal, '\nOn September 4 a second synthetic test ran.');
  plan.files[0].sources[0].expectedHash = await fingerprint(source);
  await applyPlan(plan);
  stalePlan.files[0].expectedHash = await fingerprint(target);
  stalePlan.files[0].sources[0].expectedHash = await fingerprint(source);
  await assert.rejects(applyPlan(stalePlan), /manifest|changed|conflict|match/i);
  assert.equal((await inspectState(stateDir)).outputs[0].status, 'unchanged');
});
test('path escape, duplicate output and symlink targets are refused', async t => {
  const { plan, root, source } = await fixture(t);
  const escaped = structuredClone(plan);
  escaped.files[0].path = '../escaped.md';
  await assert.rejects(applyPlan(escaped), /path|outside|relative|escape/i);
  const repeated = structuredClone(plan);
  repeated.files.push(structuredClone(repeated.files[0]));
  await assert.rejects(applyPlan(repeated), /duplicate|once/i);
  await fs.symlink(source, path.join(root, 'note.md'));
  await assert.rejects(applyPlan(plan), /symlink|symbolic/i);
});
test('multi-file interruption is reported and recovery safely rolls forward', async t => {
  const { plan, proposal, root, stateDir, target } = await fixture(t, 'derived');
  const secondProposal = path.join(path.dirname(proposal), 'second.md');
  await fs.writeFile(secondProposal, '# Second\n\n## Finding\n\nSeparate source-backed detail.\n');
  plan.files.push({ ...structuredClone(plan.files[0]), path: 'second.md', contentPath: secondProposal });
  await assert.rejects(applyPlan(plan, { afterReplace() { throw new Error('Simulated interruption'); } }), /Simulated|interrupt/i);
  assert.equal((await inspectState(stateDir)).recoveryPending, true);
  await assert.rejects(applyPlan(plan), /journal|pending|recover/i);
  await recover(stateDir);
  assert.deepEqual(await fs.readFile(target), await fs.readFile(proposal));
  assert.deepEqual(await fs.readFile(path.join(root, 'second.md')), await fs.readFile(secondProposal));
  assert.equal((await inspectState(stateDir)).recoveryPending, false);
  assert.ok(await fingerprint(path.join(stateDir, 'manifest.json')));
});
test('recovery stops before further writes when an interrupted output has a human edit', async t => {
  const { plan, root, stateDir, target, proposal } = await fixture(t);
  const otherProposal = path.join(path.dirname(proposal), 'other.md');
  await fs.copyFile(proposal, otherProposal);
  plan.files.push({ ...structuredClone(plan.files[0]), path: 'other.md', contentPath: otherProposal });
  await assert.rejects(applyPlan(plan, { afterReplace() { throw new Error('Interrupted'); } }));
  await fs.appendFile(target, '\nDo not lose this human edit.\n');
  await assert.rejects(recover(stateDir), /conflict|changed|match/i);
  assert.match(await fs.readFile(target, 'utf8'), /Do not lose this/);
  assert.equal(await fingerprint(path.join(root, 'other.md')), null);
});
test('a later-file conflict prevents any earlier-file mutation', async t => {
  const { plan, root, target, proposal } = await fixture(t);
  const otherProposal = path.join(path.dirname(proposal), 'other-proposal.md');
  await fs.copyFile(proposal, otherProposal);
  await fs.writeFile(path.join(root, 'other.md'), '# T\n\n## Existing\n\nUser work.');
  plan.files.push({ ...structuredClone(plan.files[0]), path: 'other.md', contentPath: otherProposal });
  await assert.rejects(applyPlan(plan), /conflict|changed|match|existing/i);
  assert.equal(await fingerprint(target), null);
});
test('derived no-op leaves output and manifest bytes and timestamps unchanged', async t => {
  const { plan, target, stateDir } = await fixture(t, 'derived');
  await applyPlan(plan);
  await reinspect(plan);
  const manifest = path.join(stateDir, 'manifest.json');
  const beforeHash = await fingerprint(manifest);
  const before = await Promise.all([target, manifest].map(file => fs.stat(file, { bigint: true })));
  assert.equal((await applyPlan(plan)).status, 'unchanged');
  assert.equal(await fingerprint(manifest), beforeHash);
  const after = await Promise.all([target, manifest].map(file => fs.stat(file, { bigint: true })));
  assert.deepEqual(after.map(s => s.mtimeNs), before.map(s => s.mtimeNs));
});
test('source drift after interruption blocks recovery without applying remaining files', async t => {
  const { plan, root, stateDir, source, proposal } = await fixture(t, 'derived');
  const otherProposal = path.join(path.dirname(proposal), 'other-proposal.md');
  await fs.copyFile(proposal, otherProposal);
  plan.files.push({ ...structuredClone(plan.files[0]), path: 'other.md', contentPath: otherProposal });
  await assert.rejects(applyPlan(plan, { afterReplace() { throw new Error('Interrupted'); } }));
  await fs.appendFile(source, '\nChanged evidence.\n');
  await assert.rejects(recover(stateDir), /source|changed|conflict|match/i);
  assert.equal(await fingerprint(path.join(root, 'other.md')), null);
  assert.equal(await fingerprint(path.join(stateDir, 'manifest.json')), null);
  assert.equal((await inspectState(stateDir)).recoveryPending, true);
});
test('source drift during a batch prevents the next replacement', async t => {
  const { plan, root, stateDir, source, proposal } = await fixture(t);
  const otherProposal = path.join(path.dirname(proposal), 'other-proposal.md');
  await fs.copyFile(proposal, otherProposal);
  plan.files.push({ ...structuredClone(plan.files[0]), path: 'other.md', contentPath: otherProposal });
  await assert.rejects(applyPlan(plan, { async afterReplace() { await fs.appendFile(source, '\nEvidence changed during apply.\n'); } }), /source|changed|conflict|match/i);
  assert.equal(await fingerprint(path.join(root, 'other.md')), null);
  assert.equal((await inspectState(stateDir)).recoveryPending, true);
});
test('symlinked parent and state directories cannot redirect writes', async t => {
  const { plan, root, directory, stateDir } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'linked'));
  const redirected = structuredClone(plan);
  redirected.files[0].path = 'linked/note.md';
  await assert.rejects(applyPlan(redirected), /symlink|symbolic|outside/i);
  assert.equal(await fingerprint(path.join(outside, 'note.md')), null);
  // A rejected plan may have initialized an empty state directory; use a new path.
  const linkedState = `${stateDir}-link`;
  await fs.symlink(outside, linkedState);
  await assert.rejects(applyPlan({ ...plan, stateDir: linkedState }), /symlink|symbolic/i);
  assert.equal(await fingerprint(path.join(outside, 'journal.json')), null);
});
test('lock refusal leaves another operation ownership and notes unchanged', async t => {
  const { plan, stateDir, target } = await fixture(t);
  const lock = path.join(stateDir, '.lock');
  await fs.mkdir(lock, { recursive: true });
  const owner = path.join(lock, 'owner.json');
  const metadata = JSON.stringify({ pid: process.pid, host: os.hostname(), purpose: 'another active operation' });
  await fs.writeFile(owner, metadata);
  await assert.rejects(applyPlan(plan), /lock/i);
  await assert.rejects(recover(stateDir), /lock/i);
  assert.equal(await fs.readFile(owner, 'utf8'), metadata);
  assert.equal(await fingerprint(target), null);
});
test('state nested under a prospective note fails before creating any directory there', async t => {
  const { plan, target } = await fixture(t);
  plan.stateDir = path.join(target, 'state');
  await assert.rejects(applyPlan(plan), /state|note target/i);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});
test('partial refresh reports stale mappings for a shared source', async t => {
  const { plan, source, proposal, stateDir } = await fixture(t, 'derived');
  plan.files[0].path = 'a.md';
  const secondProposal = path.join(path.dirname(proposal), 'second-proposal.md');
  await fs.copyFile(proposal, secondProposal);
  plan.files.push({ ...structuredClone(plan.files[0]), path: 'b.md', contentPath: secondProposal });
  await applyPlan(plan);
  await reinspect(plan);
  await fs.appendFile(source, '\nNew source observation.\n');
  plan.files = [plan.files[0]];
  plan.files[0].sources[0].expectedHash = await fingerprint(source);
  await fs.appendFile(proposal, '\nNew source observation.\n');
  await applyPlan(plan);
  const drift = (await inspectState(stateDir)).sources.find(s => s.path === source);
  assert.equal(drift.status, 'changed');
  assert.ok(drift.affectedOutputs.includes('b.md'));
  assert.ok(!drift.affectedOutputs.includes('a.md'));
});
test('present null recovery metadata is a failure, never a clean absent journal', async t => {
  const { stateDir } = await fixture(t);
  await fs.mkdir(stateDir);
  const journal = path.join(stateDir, 'journal.json');
  await fs.writeFile(journal, 'null\n');
  await assert.rejects(inspectState(stateDir), /journal|metadata|invalid/i);
  await assert.rejects(recover(stateDir), /journal|metadata|invalid/i);
  assert.equal(await fs.readFile(journal, 'utf8'), 'null\n');
});
test('inspection includes newly added outputs in an interrupted existing collection', async t => {
  const { plan, stateDir, proposal } = await fixture(t, 'derived');
  await applyPlan(plan);
  await reinspect(plan);
  const beforeManifest = await fingerprint(path.join(stateDir, 'manifest.json'));
  const pendingProposal = path.join(path.dirname(proposal), 'pending-proposal.md');
  await fs.copyFile(proposal, pendingProposal);
  plan.files = [
    { ...structuredClone(plan.files[0]), path: 'added.md', expectedHash: null },
    { ...structuredClone(plan.files[0]), path: 'pending.md', expectedHash: null, contentPath: pendingProposal }
  ];
  await assert.rejects(applyPlan(plan, { afterReplace() { throw new Error('Interrupted'); } }));
  const status = await inspectState(stateDir);
  assert.deepEqual(status.outputs.map(o => path.basename(o.path)).sort(), ['added.md', 'note.md', 'pending.md']);
  assert.equal(status.outputs.find(o => path.basename(o.path) === 'added.md').status, 'changed');
  assert.equal(status.outputs.find(o => path.basename(o.path) === 'pending.md').status, 'missing');
  assert.equal(await fingerprint(path.join(stateDir, 'manifest.json')), beforeManifest);
  await recover(stateDir);
  assert.notEqual(await fingerprint(path.join(stateDir, 'manifest.json')), beforeManifest);
});

async function abortPlan(stateDir) {
  const inspected = await inspectState(stateDir);
  return { version: 1, stateDir, expectedJournalHash: inspected.journalHash, expectedManifestHash: inspected.manifestHash,
    files: inspected.pendingOutputs.map(file => ({ path: file.path, expectedHash: file.hash })),
    stages: inspected.stages.map(file => ({ path: file.path, expectedHash: file.hash })) };
}
async function twoFiles(f) {
  const otherProposal = path.join(f.directory, 'other-proposal.md');
  await fs.copyFile(f.proposal, otherProposal);
  f.plan.files.push({ ...structuredClone(f.plan.files[0]), path: 'other.md', contentPath: otherProposal });
  return otherProposal;
}
test('reviewed abort after source drift retains completed writes and allows a fresh derived plan', async t => {
  const f = await fixture(t, 'derived');
  const otherProposal = await twoFiles(f);
  await applyPlan(f.plan);
  await reinspect(f.plan);
  await fs.appendFile(f.proposal, '\nReviewed first revision.\n');
  await fs.appendFile(otherProposal, '\nReviewed second revision.\n');
  const untouchedHash = await fingerprint(path.join(f.root, 'other.md'));
  await assert.rejects(applyPlan(f.plan, { afterReplace() { throw new Error('Interrupted'); } }));
  await fs.appendFile(f.source, '\nNew evidence after interruption.\n');
  await assert.rejects(recover(f.stateDir), /source changed/);
  const firstHash = await fingerprint(f.target);
  const plan = await abortPlan(f.stateDir);
  await assert.rejects(abortUpdate({ ...plan, expectedJournalHash: '0'.repeat(64) }), /journal changed/);
  assert.equal((await abortUpdate(plan)).status, 'aborted');
  assert.equal(await fingerprint(f.target), firstHash);
  assert.equal(await fingerprint(path.join(f.root, 'other.md')), untouchedHash);
  const inspection = await inspectState(f.stateDir);
  assert.equal(inspection.recoveryPending, false);
  assert.ok(inspection.outputs.every(file => file.status === 'unchanged'));
  assert.equal(inspection.sources[0].status, 'changed');
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.cuefluent-stage-')), false);
  await reinspect(f.plan);
  for (const file of f.plan.files) file.sources[0].expectedHash = await fingerprint(f.source);
  assert.equal((await applyPlan(f.plan)).status, 'updated');
});
test('abort rejects new output edits and stage drift since its explicit review', async t => {
  const f = await fixture(t);
  await twoFiles(f);
  await assert.rejects(applyPlan(f.plan, { afterReplace() { throw new Error('Interrupted'); } }));
  const plan = await abortPlan(f.stateDir);
  const remaining = plan.stages.find(file => file.expectedHash !== null);
  await fs.appendFile(remaining.path, '\nStage changed.\n');
  await assert.rejects(abortUpdate(plan), /stage changed/);
  const reviewed = await abortPlan(f.stateDir);
  await fs.appendFile(f.target, '\nHuman edit.\n');
  await assert.rejects(abortUpdate(reviewed), /output changed/);
  await assert.rejects(abortUpdate(await abortPlan(f.stateDir)), /old or new hash/);
  assert.match(await fs.readFile(f.target, 'utf8'), /Human edit/);
});
test('a kill during staging leaves an inspectable journal; abort handles missing and partial UTF-8 stages', async t => {
  const f = await fixture(t, 'derived');
  await twoFiles(f);
  const planPath = path.join(f.directory, 'plan.json');
  await fs.writeFile(planPath, JSON.stringify(f.plan));
  const program = `import fs from 'node:fs/promises'; import { applyPlan } from ${JSON.stringify(new URL('./safe-update.mjs', import.meta.url).href)}; await applyPlan(JSON.parse(await fs.readFile(process.argv[1], 'utf8')), { afterStage() { process.kill(process.pid, 'SIGKILL'); } });`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', program, planPath], { encoding: 'utf8', timeout: 10000 });
  if (process.platform === 'win32') assert.notEqual(killed.status, 0, killed.stderr);
  else assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const inspected = await inspectState(f.stateDir);
  assert.equal(inspected.locked, true);
  assert.equal(inspected.phase, 'staging');
  assert.equal(inspected.stages.length, 2);
  assert.equal(inspected.stages.filter(file => file.hash !== null).length, 1);
  assert.equal(await fingerprint(f.target), null);
  // The test child is confirmed dead. Only its fixture lock is removed.
  await fs.rm(path.join(f.stateDir, '.lock'), { recursive: true });
  const stage = inspected.stages.find(file => file.hash !== null);
  await fs.writeFile(stage.path, Buffer.from([0xc3]));
  await assert.rejects(recover(f.stateDir), /encoded data|missing or changed/);
  assert.equal((await abortUpdate(await abortPlan(f.stateDir))).status, 'aborted');
  assert.equal((await inspectState(f.stateDir)).recoveryPending, false);
  assert.deepEqual(await fs.readdir(f.root), []);
  await reinspect(f.plan);
  assert.equal((await applyPlan(f.plan)).status, 'updated');
});
test('recover completes an interrupted approved abort without stale source checks', async t => {
  const f = await fixture(t, 'derived');
  await twoFiles(f);
  await assert.rejects(applyPlan(f.plan, { afterReplace() { throw new Error('Interrupted'); } }));
  await fs.appendFile(f.source, '\nChanged evidence.\n');
  const plan = await abortPlan(f.stateDir);
  const unlink = fs.unlink;
  const mock = t.mock.method(fs, 'unlink', async file => {
    if (file.endsWith('journal.json')) throw new Error('Interrupted cleanup');
    return unlink(file);
  });
  await assert.rejects(abortUpdate(plan), /Interrupted cleanup/);
  mock.mock.restore();
  assert.equal((await inspectState(f.stateDir)).phase, 'aborting');
  assert.equal((await recover(f.stateDir)).status, 'aborted');
  assert.equal((await inspectState(f.stateDir)).recoveryPending, false);
  assert.equal(await fingerprint(path.join(f.root, 'other.md')), null);
  await reinspect(f.plan);
  for (const file of f.plan.files) file.sources[0].expectedHash = await fingerprint(f.source);
  assert.equal((await applyPlan(f.plan)).status, 'updated');
});
test('explicit retirement releases deleted outputs and leaves present note bytes untouched', async t => {
  const f = await fixture(t, 'derived');
  await twoFiles(f);
  await applyPlan(f.plan);
  await reinspect(f.plan);
  await fs.unlink(f.target);
  const kept = path.join(f.root, 'other.md');
  const bytes = await fs.readFile(kept);
  const plan = { ...f.plan, files: [], retire: [{ path: 'note.md', expectedHash: null }] };
  assert.deepEqual((await applyPlan(plan)).retired, ['note.md']);
  const status = await inspectState(f.stateDir);
  assert.deepEqual(status.outputs.map(file => path.basename(file.path)), ['other.md']);
  const present = { ...plan, expectedManifestHash: status.manifestHash, retire: [{ path: 'other.md', expectedHash: await fingerprint(kept) }] };
  assert.deepEqual((await applyPlan(present)).retired, ['other.md']);
  assert.deepEqual(await fs.readFile(kept), bytes);
  assert.deepEqual((await inspectState(f.stateDir)).outputs, []);
});
test('retirement rejects untracked paths, stale hashes, duplicate paths and update overlap', async t => {
  const f = await fixture(t, 'derived');
  await applyPlan(f.plan);
  await reinspect(f.plan);
  for (const retire of [[{ path: 'missing.md', expectedHash: null }], [{ path: 'note.md', expectedHash: null }],
    [{ path: 'note.md', expectedHash: f.plan.files[0].expectedHash }, { path: 'note.md', expectedHash: f.plan.files[0].expectedHash }]]) {
    await assert.rejects(applyPlan({ ...f.plan, files: [], retire }), /Retirement|retired|Duplicate/);
  }
  await assert.rejects(applyPlan({ ...f.plan, retire: [{ path: 'note.md', expectedHash: f.plan.files[0].expectedHash }] }), /updated and retired/);
  await fs.appendFile(f.target, '\nPreserve human edits.\n');
  await assert.rejects(applyPlan({ ...f.plan, files: [], retire: [{ path: 'note.md', expectedHash: await fingerprint(f.target) }] }), /last generated/);
  assert.match(await fs.readFile(f.target, 'utf8'), /Preserve human/);
});

test('retirement of a deleted folder can accompany a reviewed update to the remaining collection', async t => {
  const f = await fixture(t, 'derived');
  await twoFiles(f);
  await fs.mkdir(path.join(f.root, 'obsolete'));
  f.plan.files[1].path = 'obsolete/other.md';
  await applyPlan(f.plan);
  await reinspect(f.plan);
  await fs.rm(path.join(f.root, 'obsolete'), { recursive: true });
  f.plan.files = [f.plan.files[0]];
  f.plan.retire = [{ path: 'obsolete/other.md', expectedHash: null }];
  await fs.appendFile(f.proposal, '\nReviewed current observation.\n');
  const result = await applyPlan(f.plan);
  assert.deepEqual(result.updated, ['note.md']);
  assert.deepEqual(result.retired, ['obsolete/other.md']);
  assert.deepEqual((await inspectState(f.stateDir)).outputs.map(file => path.basename(file.path)), ['note.md']);
});

test('replacement preserves representable permission bits and ownership', async t => {
  const f = await fixture(t);
  await applyPlan(f.plan);
  assert.equal((await fs.stat(f.target)).mode & 0o7777, process.platform === 'win32' ? 0o666 : 0o600);
  await fs.chmod(f.target, 0o664);
  const owner = await fs.stat(f.target);
  await reinspect(f.plan);
  await fs.appendFile(f.proposal, '\nReviewed correction.\n');
  await applyPlan(f.plan);
  const changed = await fs.stat(f.target);
  assert.equal(changed.mode & 0o7777, owner.mode & 0o7777);
  assert.equal(changed.uid, owner.uid);
  assert.equal(changed.gid, owner.gid);
});
test('recovery preserves permissions and refuses metadata drift or hard-linked replacements', async t => {
  const f = await fixture(t);
  await applyPlan(f.plan);
  await fs.chmod(f.target, 0o640);
  await reinspect(f.plan);
  await fs.appendFile(f.proposal, '\nReviewed correction.\n');
  await assert.rejects(applyPlan(f.plan, { afterStage() { throw new Error('Interrupted staging'); } }));
  await fs.chmod(f.target, process.platform === 'win32' ? 0o444 : 0o644);
  await assert.rejects(recover(f.stateDir), /permissions or ownership changed|read-only/);
  await fs.chmod(f.target, 0o640);
  await recover(f.stateDir);
  assert.equal((await fs.stat(f.target)).mode & 0o7777, process.platform === 'win32' ? 0o666 : 0o640);
  const linked = path.join(f.directory, 'linked.md');
  await fs.link(f.target, linked);
  await reinspect(f.plan);
  assert.equal((await applyPlan(f.plan)).status, 'unchanged');
  await fs.appendFile(f.proposal, '\nAnother correction.\n');
  await assert.rejects(applyPlan(f.plan), /single hard link/);
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(linked));
});
test('lock cleanup failures preserve both successful output and the primary failure', async t => {
  for (const operationFails of [false, true]) {
    const f = await fixture(t);
    const owner = path.join(f.stateDir, '.lock', 'owner.json');
    const changeOwner = async () => {
      await fs.writeFile(owner, '{truncated');
      if (operationFails) throw new Error('Primary interrupted operation');
    };
    if (operationFails) {
      await assert.rejects(applyPlan(f.plan, { afterReplace: changeOwner }), error => {
        assert.equal(error.message, 'Primary interrupted operation');
        assert.match(error.cleanupWarnings[0], /Lock cleanup/);
        return true;
      });
    } else {
      await assert.rejects(applyPlan(f.plan, { afterReplace: changeOwner }), error => {
        assert.match(error.message, /lock ownership changed/i);
        assert.equal(error.cleanupWarnings.length, 1); return true;
      });
      assert(await fingerprint(path.join(f.stateDir, 'journal.json')));
    }
    assert.equal((await inspectState(f.stateDir)).locked, true);
    assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.proposal));
  }
});
test('missing owner metadata releases only the original empty lock, never replacement ownership', async t => {
  const f = await fixture(t);
  const lock = path.join(f.stateDir, '.lock');
  await assert.rejects(applyPlan(f.plan, { afterReplace: () => fs.unlink(path.join(lock, 'owner.json')) }), { code: 'ENOENT' });
  assert.equal((await inspectState(f.stateDir)).locked, false);
  await recover(f.stateDir);
  await reinspect(f.plan);
  await fs.appendFile(f.proposal, '\nReviewed second change.\n');
  await assert.rejects(applyPlan(f.plan, { async afterReplace() {
    await fs.rename(lock, path.join(f.stateDir, 'original-lock'));
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner.json'), '{"token":"another-owner"}');
  } }), error => { assert.match(error.message, /lock ownership changed/i); assert.match(error.cleanupWarnings[0], /ownership changed/); return true; });
  assert.equal(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'), '{"token":"another-owner"}');
});
test('a changed lock token is retained with a cleanup warning', async t => {
  const f = await fixture(t);
  const owner = path.join(f.stateDir, '.lock', 'owner.json');
  await assert.rejects(applyPlan(f.plan, { afterReplace: () => fs.writeFile(owner, '{"token":"different"}') }), error => {
    assert.match(error.message, /lock ownership changed/i); assert.match(error.cleanupWarnings[0], /token changed/); return true;
  });
  assert.equal((await inspectState(f.stateDir)).locked, true);
});
test('manifest hashes and no-op timestamps are stable across German and Swedish locales', async t => {
  const f = await fixture(t, 'derived');
  await twoFiles(f);
  f.plan.files[0].path = 'ärende.md';
  f.plan.files[1].path = 'zon.md';
  const planPath = path.join(f.directory, 'plan.json');
  const invoke = async locale => {
    await fs.writeFile(planPath, JSON.stringify(f.plan));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./safe-update.mjs', import.meta.url)), 'apply', planPath], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, LANG: locale, LC_ALL: locale } });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  await invoke('de_DE.UTF-8');
  await reinspect(f.plan);
  const manifest = path.join(f.stateDir, 'manifest.json');
  const before = await fs.stat(manifest, { bigint: true });
  assert.equal((await invoke('sv_SE.UTF-8')).status, 'unchanged');
  assert.equal(await fingerprint(manifest), f.plan.expectedManifestHash);
  assert.equal((await fs.stat(manifest, { bigint: true })).mtimeNs, before.mtimeNs);
});
test('whole-file read work scales with output count rather than repeated collection preflights', async t => {
  const open = fs.open;
  let reads = 0, sourceReads = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (typeof file === 'string' && typeof args[0] === 'number' && !(args[0] & 2)) {
      if (file.endsWith('.md') || path.basename(file).startsWith('.cuefluent-stage-')) reads++;
      if (path.basename(file) === 'source.md') sourceReads++;
    }
    return open(file, ...args);
  });
  const run = async count => {
    const f = await fixture(t, 'derived');
    const template = f.plan.files[0];
    f.plan.files = [];
    for (let i = 0; i < count; i++) {
      const proposal = path.join(f.directory, `proposal-${i}.md`);
      await fs.copyFile(f.proposal, proposal);
      f.plan.files.push({ ...structuredClone(template), path: `${i}.md`, contentPath: proposal });
    }
    reads = 0; sourceReads = 0;
    await applyPlan(f.plan);
    return { reads, sourceReads };
  };
  const small = await run(6);
  const large = await run(24);
  assert.ok(large.reads <= small.reads * 4.5, JSON.stringify({ small, large }));
  assert.equal(large.sourceReads, small.sourceReads);
});
test('changed source metadata invalidates the cached hash even for same-length bytes', async t => {
  const f = await fixture(t);
  await twoFiles(f);
  await assert.rejects(applyPlan(f.plan, { async afterReplace() {
    const source = await fs.readFile(f.source, 'utf8');
    await fs.writeFile(f.source, source.replace('passed', 'failed'));
  } }), /source changed/);
  assert.equal(await fingerprint(path.join(f.root, 'other.md')), null);
});

test('POSIX read-only stages can finish after interrupted rename; Windows refuses read-only targets', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await applyPlan(f.plan);
  await fs.chmod(f.target, 0o440);
  await reinspect(f.plan);
  await fs.appendFile(f.proposal, '\nReviewed correction for a read-only note.\n');
  const rename = fs.rename;
  const replacement = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === await fs.realpath(f.target)) throw new Error('Interrupted rename');
    return rename(source, target);
  });
  await assert.rejects(applyPlan(f.plan), /Interrupted rename/);
  replacement.mock.restore();
  const stage = (await inspectState(f.stateDir)).stages[0];
  assert.equal((await fs.stat(stage.path)).mode & 0o7777, 0o440);
  assert.equal((await recover(f.stateDir)).status, 'updated');
  assert.equal((await fs.stat(f.target)).mode & 0o7777, 0o440);
});

test('metadata validation accepts valid and opaque blocks but preserves malformed existing notes on refusal', async t => {
  for (const schema of [1, 2]) {
    const f = await fixture(t);
    const metadata = `<!-- cuefluent\nschema_version: ${schema}\nid: note_writer\nextensions: {decimal: 1_000, hex: 0x1_0}\n-->\n\n`;
    f.plan.files[0].entries[0].heading = 'Evidence';
    await fs.writeFile(f.proposal, metadata + '# Note\n\n## Evidence\n\nSupported content.\n');
    assert.equal((await applyPlan(f.plan)).status, 'updated');
    assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.proposal));
    await reinspect(f.plan);
    await fs.appendFile(f.proposal, '\nAdditional supported content.\n');
    assert.equal((await applyPlan(f.plan)).status, 'updated');
    assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.proposal));
    const malformed = '# Note\n\n## Evidence\n\n<!-- cuefluent review pending -->\n\nPreserved human content.\n';
    await fs.writeFile(f.target, malformed);
    f.plan.files[0].expectedHash = await fingerprint(f.target);
    await fs.writeFile(f.proposal, malformed + '\nProposed addition.\n');
    await assert.rejects(applyPlan(f.plan), /Markdown check/);
    assert.equal(await fs.readFile(f.target, 'utf8'), malformed);
    assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
  }
});

test('shared writer preserves generated identities and unknown metadata, rejects stale edits and leaves no-op bytes alone', async t => {
  const f = await fixture(t), body = await fs.readFile(f.proposal, 'utf8');
  const original = prepareNote({ original: null, content: body, now: '2026-10-01T12:00:00Z', skillVersion: '0.9.0' }).content
    .replace('schema_version: 1', 'custom: {retain: true}\nschema_version: 1');
  await fs.writeFile(f.proposal, original); await applyPlan(f.plan); await reinspect(f.plan);
  const before = await fs.stat(f.target, { bigint: true });
  assert.equal((await applyPlan(f.plan)).status, 'unchanged');
  assert.equal((await fs.stat(f.target, { bigint: true })).mtimeNs, before.mtimeNs);
  for (const invalid of [original.replace(/id: note_[^\n]+/, 'id: replacement'), original.replace('custom: {retain: true}\n', ''), body]) {
    await fs.writeFile(f.proposal, invalid);
    await assert.rejects(applyPlan(f.plan), /NOTE_METADATA_/);
    assert.equal(await fs.readFile(f.target, 'utf8'), original);
    assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
  }
  const update = prepareNote({ original, content: original + '\nReviewed addition.\n', now: '2026-10-02T12:00:00Z', skillVersion: '0.9.0' }).content;
  await fs.writeFile(f.proposal, update); await fs.appendFile(f.target, '\nConcurrent human correction.\n');
  await assert.rejects(applyPlan(f.plan), /changed since inspection/);
  assert.match(await fs.readFile(f.target, 'utf8'), /Concurrent human correction/);
});

test('metadata survives interrupted writes and duplicate IDs fail before note staging', async t => {
  const f = await fixture(t), body = await fs.readFile(f.proposal, 'utf8');
  const content = prepareNote({ original: null, content: body, now: '2026-10-01T12:00:00Z', skillVersion: '0.9.0', contentHash: true }).content;
  await fs.writeFile(f.proposal, content);
  const second = path.join(f.directory, 'second.md'); await fs.writeFile(second, content);
  const duplicate = { ...f.plan, files: [...f.plan.files, { ...f.plan.files[0], path: 'second.md', contentPath: second }] };
  await assert.rejects(applyPlan(duplicate), /NOTE_METADATA_ID_COLLISION/);
  assert.equal(await fingerprint(f.target), null);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
  await assert.rejects(applyPlan(f.plan, { afterStage() { throw new Error('synthetic interruption'); } }), /synthetic interruption/);
  await recover(f.stateDir);
  assert.equal(await fs.readFile(f.target, 'utf8'), content);
});

test('writer reuses metadata inspections and refuses creation-date backfills before staging', async t => {
  const f = await fixture(t), body = await fs.readFile(f.proposal, 'utf8');
  const original = prepareNote({ original: body, content: body, enrich: true, now: '2026-10-05T12:00:00Z', skillVersion: '0.9.0' }).content;
  await fs.writeFile(f.target, original); await reinspect(f.plan);
  await fs.writeFile(f.proposal, original.replace('schema_version: 1', 'schema_version: 1\ncreated: "2001-01-01T00:00:00Z"'));
  await assert.rejects(applyPlan(f.plan), { code: 'NOTE_METADATA_IDENTITY_CHANGED' });
  assert.equal(await fs.readFile(f.target, 'utf8'), original);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);

  const plain = body + '\n```markdown\n<!-- cuefluent PARSE_SENTINEL -->\n```\n';
  await fs.writeFile(f.target, plain); await reinspect(f.plan);
  await fs.writeFile(f.proposal, plain + '\nAddition.\n');
  const parse = MarkdownIt.prototype.parse; let count = 0;
  const mocked = t.mock.method(MarkdownIt.prototype, 'parse', function (source, ...args) {
    if (source.includes('PARSE_SENTINEL')) count++;
    return parse.call(this, source, ...args);
  });
  await applyPlan(f.plan); mocked.mock.restore();
  assert.equal(count, 2, 'inspect each proposed/current note once, without transition reparsing');
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.proposal));
});

test('metadata transition checks do not reject a plain UTF-8 note containing NUL', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.proposal, '\nLiteral NUL: \u0000\n');
  await applyPlan(f.plan); await reinspect(f.plan);
  await fs.appendFile(f.proposal, '\nReviewed addition.\n'); await applyPlan(f.plan);
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.proposal));
});

test('shared writer preserves exact unknown numbers when a rounded replacement disguises a change', async t => {
  const f = await fixture(t), body = await fs.readFile(f.proposal, 'utf8');
  const original = '<!-- cuefluent\nschema_version: 1\nid: note_numeric\nunknown: 9007199254740992\n-->\n' + body;
  await fs.writeFile(f.target, original); await reinspect(f.plan);
  await fs.writeFile(f.proposal, original.replace('9007199254740992', '9007199254740993'));
  await assert.rejects(applyPlan(f.plan), /Markdown check/);
  assert.equal(await fs.readFile(f.target, 'utf8'), original);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});

test('replacement proposals cannot remove or repair malformed existing metadata', async t => {
  for (const mode of ['authored', 'derived']) for (const replacement of ['remove', 'repair']) {
    const f = await fixture(t, mode);
    const body = await fs.readFile(f.proposal, 'utf8');
    if (mode === 'derived') await applyPlan(f.plan);
    const malformed = '<!-- cuefluent\nschema_version: 1\nid: note_existing\ncreated: yesterday\n-->\n\n' + body;
    await fs.writeFile(f.target, malformed);
    if (mode === 'derived') {
      // Model a legacy generated note whose malformed bytes are already tracked.
      const file = path.join(f.stateDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.files[0].hash = await fingerprint(f.target);
      await fs.writeFile(file, JSON.stringify(manifest));
    }
    await reinspect(f.plan);
    const manifestHash = await fingerprint(path.join(f.stateDir, 'manifest.json'));
    const next = replacement === 'remove' ? body : '<!-- cuefluent\nschema_version: 1\nid: note_existing\n-->\n\n' + body;
    await fs.writeFile(f.proposal, next);
    await assert.rejects(applyPlan(f.plan), /existing.*metadata/i, `${mode}: ${replacement}`);
    assert.equal(await fs.readFile(f.target, 'utf8'), malformed);
    assert.equal(await fingerprint(path.join(f.stateDir, 'manifest.json')), manifestHash);
    assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
    assert.deepEqual(await fs.readdir(f.root), ['note.md']);
  }
});

test('metadata preflight still permits repair of ordinary Markdown structure', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.target, 'An existing note without headings.\n');
  await reinspect(f.plan);
  assert.equal((await applyPlan(f.plan)).status, 'updated');
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.proposal));
});

test('C1 metadata controls block writer replacements without changing notes or manifests', async t => {
  for (const mode of ['authored', 'derived']) {
    const f = await fixture(t, mode), body = await fs.readFile(f.proposal, 'utf8');
    await applyPlan(f.plan); await reinspect(f.plan);
    const manifestHash = await fingerprint(path.join(f.stateDir, 'manifest.json'));
    for (const schema of [1, 2]) {
      await fs.writeFile(f.proposal, `<!-- cuefluent\nschema_version: ${schema}\nid: note_controls\nextension: "\\N"\n-->\n\n` + body);
      await assert.rejects(applyPlan(f.plan), /Markdown check/);
      assert.equal(await fs.readFile(f.target, 'utf8'), body);
      assert.equal(await fingerprint(path.join(f.stateDir, 'manifest.json')), manifestHash);
      assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
      assert.deepEqual(await fs.readdir(f.root), ['note.md']);
    }
  }
});

test('unquoted timestamp proposals cannot replace authored or derived notes', async t => {
  const stamp = '2026-10-01T07:42:00Z';
  for (const mode of ['authored', 'derived']) {
    const f = await fixture(t, mode), body = await fs.readFile(f.proposal, 'utf8');
    await applyPlan(f.plan); await reinspect(f.plan);
    const manifestHash = await fingerprint(path.join(f.stateDir, 'manifest.json'));
    for (const field of ['created', 'updated']) for (const value of [stamp, `|-\n  ${stamp}`, `>-\n  ${stamp}`]) {
      await fs.writeFile(f.proposal, `<!-- cuefluent\nschema_version: 1\nid: note_timestamp\n${field}: ${value}\n-->\n\n` + body);
      await assert.rejects(applyPlan(f.plan), /Markdown check/);
      assert.equal(await fs.readFile(f.target, 'utf8'), body);
      assert.equal(await fingerprint(path.join(f.stateDir, 'manifest.json')), manifestHash);
      assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
      assert.deepEqual(await fs.readdir(f.root), ['note.md']);
    }
    const quoted = `<!-- cuefluent\nschema_version: 1\nid: note_timestamp\ncreated: "${stamp}"\nupdated: '${stamp}'\n-->\n\n` + body;
    await fs.writeFile(f.proposal, quoted);
    assert.equal((await applyPlan(f.plan)).status, 'updated');
    assert.equal(await fs.readFile(f.target, 'utf8'), quoted);
  }
});

test('writers preserve opaque metadata bytes while allowing body-only updates', async t => {
  for (const mode of ['authored', 'derived']) {
    const f = await fixture(t, mode), body = await fs.readFile(f.proposal, 'utf8');
    const block = '<!-- cuefluent\r\nschema_version: 2\r\nid: note_future\r\nextension: "keep me"\r\n-->\r\n';
    const original = '\uFEFF' + block + '\r\n' + body;
    await fs.writeFile(f.proposal, original); await applyPlan(f.plan); await reinspect(f.plan);
    const manifestHash = await fingerprint(path.join(f.stateDir, 'manifest.json'));
    for (const next of ['', block.replace('2', '1'), block.replace('keep me', 'changed'),
      block.replace('"keep me"', "'keep me'"), block.replaceAll('\r\n', '\n')]) {
      await fs.writeFile(f.proposal, '\uFEFF' + next + '\n' + body + '\nUpdated body.\n');
      await assert.rejects(applyPlan(f.plan), { code: 'NOTE_METADATA_OPAQUE_CHANGED' });
      assert.equal(await fs.readFile(f.target, 'utf8'), original);
      assert.equal(await fingerprint(path.join(f.stateDir, 'manifest.json')), manifestHash);
      assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
      assert.deepEqual(await fs.readdir(f.root), ['note.md']);
    }
    const updated = original + '\nUpdated body.\n';
    await fs.writeFile(f.proposal, updated);
    assert.equal((await applyPlan(f.plan)).status, 'updated');
    assert.equal(await fs.readFile(f.target, 'utf8'), updated);
  }
});

test('writers reject duplicate note IDs across proposed and retained outputs before publication', async t => {
  for (const mode of ['authored', 'derived']) {
    const f = await fixture(t, mode);
    const content = '<!-- cuefluent\nschema_version: 1\nid: note_shared\n-->\n\n' + await fs.readFile(f.proposal, 'utf8');
    await fs.writeFile(f.proposal, content);
    const other = path.join(f.directory, 'other-proposal.md'); await fs.writeFile(other, content);
    const extra = { ...f.plan.files[0], path: 'other.md', contentPath: other };
    await assert.rejects(applyPlan({ ...f.plan, files: [f.plan.files[0], extra] }), /NOTE_METADATA_ID_COLLISION/);
    assert.deepEqual(await fs.readdir(f.root), []);
    assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
    if (mode === 'derived') {
      await applyPlan(f.plan); await reinspect(f.plan);
      const manifest = await fs.readFile(path.join(f.stateDir, 'manifest.json'));
      await assert.rejects(applyPlan({ ...f.plan, files: [extra] }), /NOTE_METADATA_ID_COLLISION/);
      assert.equal(await fs.readFile(f.target, 'utf8'), content);
      assert.deepEqual(await fs.readFile(path.join(f.stateDir, 'manifest.json')), manifest);
      assert.equal(await fingerprint(path.join(f.root, 'other.md')), null);
    }
  }
});

test('a marker beyond Markdown nesting limits cannot pass shared-writer checks', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.proposal, '\n' + '>'.repeat(100) + ' <!-- cuefluent\nschema_version: 1\nid: hidden\n-->\n');
  await assert.rejects(applyPlan(f.plan), /Markdown check/);
  assert.equal(await fingerprint(f.target), null);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});

test('malformed marker punctuation blocks a writer save before publication', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.proposal, '\n<!-- cuefluent? -->\n');
  await assert.rejects(applyPlan(f.plan), /Markdown check/);
  assert.equal(await fingerprint(f.target), null);
  assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
});

test('named footnote markers block writer publication without changing existing notes', async t => {
  for (const mode of ['authored', 'derived']) {
    const f = await fixture(t, mode), body = await fs.readFile(f.proposal, 'utf8');
    await applyPlan(f.plan); await reinspect(f.plan);
    const manifestHash = await fingerprint(path.join(f.stateDir, 'manifest.json'));
    for (const fragment of ['[^<!--cuefluent]: text', 'See [^<!--cuefluent]\n\n[^<!--cuefluent]: text',
      '[^unused]: text <!-- cuefluent -->', '[^unused]: [link](url "<!-- cuefluent")']) {
      await fs.writeFile(f.proposal, body + '\n' + fragment + '\n');
      await assert.rejects(applyPlan(f.plan), /Markdown check/);
      assert.equal(await fs.readFile(f.target, 'utf8'), body);
      assert.equal(await fingerprint(path.join(f.stateDir, 'manifest.json')), manifestHash);
      assert.equal(await fingerprint(path.join(f.stateDir, 'journal.json')), null);
      assert.deepEqual(await fs.readdir(f.root), ['note.md']);
    }
  }
});

test('Unicode comment names survive writer creation and replacement', async t => {
  for (const mode of ['authored', 'derived']) for (const metadata of ['', '<!-- cuefluent\nschema_version: 1\nid: note_unicode\n-->\n\n']) {
    const f = await fixture(t, mode);
    const body = await fs.readFile(f.proposal, 'utf8');
    const comments = ['é', '文', '١', '\u0301', '𐐀'].map(suffix => `<!-- cuefluent${suffix} -->`).join('\n');
    await fs.writeFile(f.proposal, metadata + body + '\n' + comments + '\n');
    assert.equal((await applyPlan(f.plan)).status, 'updated');
    assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.proposal));
    await reinspect(f.plan);
    await fs.appendFile(f.proposal, '\nA reviewed addition.\n');
    assert.equal((await applyPlan(f.plan)).status, 'updated');
    assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.proposal));
  }
});
