import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkFiles } from './check-notes.mjs';
import { inspectNoteMetadata } from './note-metadata.mjs';
import { prepareNote } from './note-generation.mjs';
import { applyPlan, fingerprint } from './safe-update.mjs';

test('generated series members save independently and an earlier sprint accepts a later historical correction', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-generated-series-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'notes'), review = path.join(directory, 'review');
  await fs.mkdir(root); await fs.mkdir(review);
  const evidence = path.join(directory, 'evidence.md');
  await fs.writeFile(evidence, '# Synthetic evidence\n\nFirst sprint: review pending. Second sprint: prototype approved. Later clarification: approval concerned the prototype only.\n');
  const source = { type: 'document', ref: '../evidence.md' };
  const plan = { version: 1, mode: 'authored', root, stateDir: path.join(directory, 'writer') };
  const saved = [], values = [];
  const periods = [
    { start: '2026-09-21', end: '2026-10-02', timezone: 'America/Los_Angeles' },
    { start: '2026-10-05', end: '2026-10-16', timezone: 'America/Los_Angeles' }
  ];
  for (let i = 0; i < periods.length; i++) {
    const sprint = `20.${26 + i}`, name = `standups-${sprint}.md`;
    const prepared = prepareNote({ original: null,
      content: `# Synthetic sprint ${sprint}\n\n## Review status\n\n${i ? 'The prototype was approved.' : 'Review remained pending.'}\n\nSource: [selected evidence](../evidence.md).\n`,
      now: `${periods[i].start}T09:00:00-07:00`, skillVersion: '0.9.0', createSeries: i === 0,
      metadata: { series: i === 0 ? { label: 'Synthetic standups' } : values[0].series,
        sprint, period: periods[i], sources: [{ ...source, locator: `Sprint ${sprint}` }] } });
    const contentPath = path.join(review, name);
    await fs.writeFile(contentPath, prepared.content);
    await applyPlan({ ...plan, files: [{ path: name, expectedHash: null, contentPath,
      expectedContentHash: await fingerprint(contentPath), sources: [{ path: evidence, expectedHash: await fingerprint(evidence) }] }] });
    const target = path.join(root, name), content = await fs.readFile(target, 'utf8');
    assert.equal(content, prepared.content);
    const value = inspectNoteMetadata(content).value;
    assert.equal(value.sprint, sprint); assert.deepEqual(value.period, periods[i]);
    assert.deepEqual(value.sources, [{ ...source, locator: `Sprint ${sprint}` }]);
    saved.push({ target, content, contentPath, name }); values.push(value);
  }
  assert.notEqual(values[0].id, values[1].id); assert.deepEqual(values[0].series, values[1].series);
  const earlier = saved[0], correctionTime = '2026-10-20T09:00:00-07:00';
  const correctionSource = { ...source, locator: 'Later clarification' };
  const correction = prepareNote({ original: earlier.content,
    content: earlier.content + '\n## Historical clarification\n\nThe later approval concerned the prototype only; the first sprint still ended with review pending.\n\nSource: [clarification](../evidence.md).\n',
    now: correctionTime, skillVersion: '0.9.0', metadata: { sources: [correctionSource] } });
  await fs.writeFile(earlier.contentPath, correction.content);
  await applyPlan({ ...plan, files: [{ path: earlier.name, expectedHash: await fingerprint(earlier.target), contentPath: earlier.contentPath,
    expectedContentHash: await fingerprint(earlier.contentPath), sources: [{ path: evidence, expectedHash: await fingerprint(evidence) }] }] });
  const updated = await fs.readFile(earlier.target, 'utf8'), value = inspectNoteMetadata(updated).value;
  assert.equal(updated, correction.content); assert.equal(value.id, values[0].id);
  assert.deepEqual(value.series, values[0].series); assert.equal(value.created, values[0].created);
  assert.equal(value.updated, correctionTime); assert.equal(value.sprint, values[0].sprint);
  assert.deepEqual(value.period, values[0].period); assert.deepEqual(value.sources, [...values[0].sources, correctionSource]);
  assert.equal(await fs.readFile(saved[1].target, 'utf8'), saved[1].content);
  assert.equal((await checkFiles(saved.map(item => item.target))).errors, 0);
});

// Exercise the shipped examples as separate authored members through the real
// writer; this does not test agent destination choice or app series retrieval.
test('related sprint notes retain separate identity, history and sources through guarded updates', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-series-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'notes'), review = path.join(directory, 'review'), references = path.join(directory, 'references');
  await fs.mkdir(root); await fs.mkdir(review); await fs.mkdir(references);
  const evidence = path.join(references, 'evidence.md');
  await fs.copyFile(new URL('../references/evidence.md', import.meta.url), evidence);
  const names = ['standups-sprint-20-26.md', 'standups-sprint-20-27.md'];
  const files = [];
  for (const name of names) {
    const contentPath = path.join(review, name);
    await fs.copyFile(new URL(`../examples/${name}`, import.meta.url), contentPath);
    files.push({ path: name, expectedHash: null, contentPath, expectedContentHash: await fingerprint(contentPath),
      sources: [{ path: evidence, expectedHash: await fingerprint(evidence) }] });
  }
  const plan = { version: 1, mode: 'authored', root, stateDir: path.join(directory, 'writer'), files };
  await applyPlan(plan);
  const targets = names.map(name => path.join(root, name));
  const original = await Promise.all(targets.map(file => fs.readFile(file, 'utf8')));
  const [earlier, later] = original.map(content => inspectNoteMetadata(content).value);
  assert.equal(earlier.series.id, later.series.id); assert.notEqual(earlier.id, later.id);
  assert.notDeepEqual(earlier.period, later.period);
  assert.equal((await checkFiles(targets)).errors, 0);
  const correction = path.join(references, 'correction.md');
  await fs.writeFile(correction, 'Fictional October 7 clarification: the reported run did not establish a charge outcome.\n');
  const addition = '\n## October 7 charge-outcome clarification\n\nThe fictional clarification states that the reported run did not establish a charge outcome.\n\nSource: [supplied correction](../references/correction.md).\n';
  const update = prepareNote({ original: original[1], content: original[1] + addition,
    now: '2026-10-07T09:15:00-07:00', skillVersion: '0.9.0',
    metadata: { sources: [{ type: 'document', ref: '../references/correction.md' }] } });
  const second = { ...files[1], expectedHash: await fingerprint(targets[1]),
    sources: [...files[1].sources, { path: correction, expectedHash: await fingerprint(correction) }] };
  await fs.writeFile(second.contentPath, update.content); second.expectedContentHash = await fingerprint(second.contentPath);
  await applyPlan({ ...plan, files: [second] });
  assert.equal(await fs.readFile(targets[0], 'utf8'), original[0]);
  const saved = await fs.readFile(targets[1], 'utf8'), changed = inspectNoteMetadata(saved).value;
  assert.equal(saved, update.content); assert.equal(changed.id, later.id);
  assert.equal(changed.series.id, earlier.series.id); assert.deepEqual(changed.period, later.period);
  assert.deepEqual(changed.sources.slice(0, later.sources.length), later.sources);
  assert.equal(changed.sources.length, later.sources.length + 1);
  const noOp = prepareNote({ original: saved, content: saved, now: '2026-10-08T09:15:00-07:00', skillVersion: '0.9.0' });
  assert.equal(noOp.changed, false); assert.equal(noOp.content, saved);
  const duplicatePath = path.join(review, 'duplicate.md'); await fs.writeFile(duplicatePath, saved);
  second.expectedHash = await fingerprint(targets[1]);
  await assert.rejects(applyPlan({ ...plan, files: [second,
    { ...second, path: 'unintended-copy.md', expectedHash: null, contentPath: duplicatePath }] }), /NOTE_METADATA_ID_COLLISION/);
  assert.equal(await fingerprint(path.join(root, 'unintended-copy.md')), null);
  assert.equal(await fs.readFile(targets[1], 'utf8'), saved);
});
