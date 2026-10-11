import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceCollector } from './capture-evidence.mjs';

const row = (kind, text, callId, outcome = 'unknown') => ({ kind, value: {
  text, ...(kind.startsWith('tool-') ? { tool: 'synthetic', callId, ...(kind === 'tool-result' ? { outcome } : {}) } : {}) } });
function append(out, rows, start = 0) {
  rows.forEach(({ kind, value }, i) => out.add(kind, { id: `r${start + i}`, startByte: (start + i) * 10, endByte: (start + i + 1) * 10 }, value));
  return out;
}
const bytes = (out, kind) => out.evidence.filter(item => item.kind === kind).reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
const omittedBytes = out => out.omissions.reduce((sum, item) => sum + (item.bytes ?? 0), 0);

test('large calls cannot consume result allocation, and early documentation results leave later failure room', () => {
  const failure = 'Failure: unchanged caller crashes.';
  const calls = append(evidenceCollector(), [
    ...Array.from({ length: 8 }, (_, i) => row('tool-call', 'x'.repeat(32768), `c${i}`)),
    ...Array.from({ length: 8 }, (_, i) => row('tool-result', failure, `c${i}`))
  ]);
  assert.equal(bytes(calls, 'tool-call'), 65536);
  assert.equal(calls.evidence.filter(item => item.text === failure).length, 8);
  assert.equal(omittedBytes(calls), 8 * (32768 - 8192));
  const document = 'API definition\n'.repeat(3000);
  const docs = append(evidenceCollector(), [...Array.from({ length: 8 }, (_, i) => row('tool-result', document, `d${i}`)), row('tool-result', failure, 'later')]);
  assert.equal(bytes(docs, 'tool-result'), 8 * 16384 + Buffer.byteLength(failure));
  assert.equal(docs.evidence.at(-1).text, failure);
  assert(docs.evidence[0].text.startsWith('API definition'));
  assert.equal(omittedBytes(docs), 8 * (Buffer.byteLength(document) - 16384));
});

test('one call cannot consume the pool through repeated output fragments', () => {
  const out = append(evidenceCollector(), [...Array.from({ length: 4 }, () => row('tool-result', 'a'.repeat(8192), 'same')),
    row('tool-result', 'Independent failure.', 'next', 'failed')]);
  assert.deepEqual(out.evidence.slice(0, 4).map(item => item.text.length), [8192, 8192, 0, 0]);
  assert.equal(out.evidence.at(-1).text, 'Independent failure.');
  assert.equal(omittedBytes(out), 16384);
  assert.equal(out.omissions[0].reason, 'tool-result-call-limit');
});

test('exhausted text retains native failure descriptors and later human corrections within the envelope', () => {
  const out = append(evidenceCollector(), [...Array.from({ length: 12 }, (_, i) => row('tool-result', 'x'.repeat(16384), `c${i}`)),
    row('tool-result', 'Failure after saturation.', 'late', 'failed'), row('user', 'Correction: fix is unverified.')]);
  assert.equal(bytes(out, 'tool-result'), 196608);
  assert.deepEqual(out.evidence.at(-2), { kind: 'tool-result', recordId: 'r12', range: { startByte: 120, endByte: 130, recordIds: ['r12'] },
    tool: 'synthetic', callId: 'late', outcome: 'failed', text: '' });
  assert.equal(out.evidence.at(-1).text, 'Correction: fix is unverified.');
  assert.equal(out.omissions[0].reason, 'tool-result-budget-exhausted');
  assert.equal(out.omissions[0].bytes, Buffer.byteLength('Failure after saturation.'));
});

test('many small calls retain order, occurrence identity and complete ordinary text', () => {
  const rows = Array.from({ length: 100 }, (_, i) => [row('tool-call', 'Read relevant API docs', `c${i}`), row('tool-result', 'Same relevant text.', `c${i}`)]).flat();
  const out = append(evidenceCollector(), rows);
  assert.equal(out.evidence.length, 200); assert.equal(out.omissions.length, 0);
  assert.deepEqual(out.evidence.map(item => item.text), rows.map(item => item.value.text));
  assert.equal(new Set(out.evidence.map(item => item.recordId)).size, 200);
});

test('UTF-8 and JSON envelope clipping account for each omitted byte once', () => {
  const text = '🙂"\\\n'.repeat(10000);
  const out = append(evidenceCollector(), [row('user', 'x'.repeat(1040000)), row('tool-result', text, 'unicode')]);
  const kept = out.evidence.at(-1);
  assert.equal(kept.kind, 'tool-result'); assert(!kept.text.includes('\ufffd'));
  assert.equal(omittedBytes(out), Buffer.byteLength(text) - Buffer.byteLength(kept.text));
  assert(out.omissions.some(item => item.reason === 'tool-result-call-limit'));
  assert(out.omissions.some(item => item.reason === 'tool-evidence-serialized-limit'));
  assert(out.evidence.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) <= 1024 * 1024 - 2048);
});

test('record and serialized envelope exhaustion report distinct causes', () => {
  const records = append(evidenceCollector(), [...Array.from({ length: 2048 }, () => row('user', 'x')), row('tool-result', 'Failure.', 'late', 'failed')]);
  assert.equal(records.omissions.at(-1).reason, 'tool-evidence-record-limit');
  const full = append(evidenceCollector(), [row('user', 'x'.repeat(2 * 1024 * 1024)), row('tool-result', 'Failure.', 'late', 'failed')]);
  assert.equal(full.omissions.at(-1).reason, 'tool-evidence-serialized-limit');
  assert.equal(full.evidence.length, 1);
});

test('seeded collection matches uninterrupted quotas and never mutates retained evidence', () => {
  const rows = [...Array.from({ length: 10 }, (_, i) => row('tool-call', 'x'.repeat(12000), `c${i}`)),
    ...Array.from({ length: 15 }, (_, i) => row('tool-result', '🙂'.repeat(7000), `c${i % 10}`))];
  const all = append(evidenceCollector(), rows);
  for (const boundary of [1, 8, 12, 20]) {
    const first = append(evidenceCollector(), rows.slice(0, boundary));
    const saved = structuredClone({ evidence: first.evidence, omissions: first.omissions });
    const resumed = append(evidenceCollector(first), rows.slice(boundary), boundary);
    assert.deepEqual(resumed.evidence, all.evidence); assert.deepEqual(resumed.omissions, all.omissions);
    assert.deepEqual({ evidence: first.evidence, omissions: first.omissions }, saved);
  }
});

test('old larger per-kind allocations remain intact without allowing new text above the global limit', () => {
  const evidence = Array.from({ length: 8 }, (_, i) => ({ kind: i < 4 ? 'tool-call' : 'tool-result', callId: `old${i}`,
    tool: 'synthetic', text: 'x'.repeat(32768), ...(i >= 4 ? { outcome: 'unknown' } : {}), recordId: `old${i}`,
    range: { startByte: i * 10, endByte: i * 10 + 10, recordIds: [`old${i}`] } }));
  const out = append(evidenceCollector({ evidence, omissions: [] }), [row('tool-result', 'new result', 'new', 'unknown')], 8);
  assert.deepEqual(out.evidence.slice(0, 8), evidence);
  assert.equal(bytes(out, 'tool-call') + bytes(out, 'tool-result'), 262144);
  assert.equal(out.evidence.at(-1).text, '');
  assert.equal(out.omissions[0].reason, 'tool-budget-exhausted');
});

test('ordinary nested API text is bounded, not semantically filtered or advertised as available elsewhere', () => {
  const text = JSON.stringify({ documentation: 'API details '.repeat(2000), decisive: 'late failure' });
  const out = append(evidenceCollector(), [row('tool-result', text, 'api')]);
  assert(out.evidence[0].text.startsWith('{"documentation":'));
  assert(!out.evidence[0].text.includes('late failure'));
  assert.equal(out.evidence[0].outcome, 'unknown');
  assert.equal(omittedBytes(out), Buffer.byteLength(text) - Buffer.byteLength(out.evidence[0].text));
  assert(!JSON.stringify(out.evidence).includes('artifactRef'));
});

test('each retained clipped-to-empty result is marked separately from genuine empty output', () => {
  const out = append(evidenceCollector(), [...Array.from({ length: 12 }, (_, i) => row('tool-result', 'x'.repeat(16384), `c${i}`)),
    row('tool-result', 'omitted one', 'one', 'succeeded'), row('tool-result', 'omitted two', 'two'), row('tool-result', '', 'empty', 'succeeded')]);
  assert.deepEqual(out.evidence.slice(-3).map(item => item.text), ['', '', '']);
  assert.deepEqual(out.omissions.filter(item => item.reason === 'tool-text-omitted').map(item => item.recordId), ['r12', 'r13']);
  assert.equal(omittedBytes(out), Buffer.byteLength('omitted oneomitted two'));
});

test('a descriptor that cannot fit does not count the same serialized loss twice', () => {
  const seed = { kind: 'user', recordId: 'old', range: { startByte: 0, endByte: 10, recordIds: ['old'] }, text: '' };
  seed.text = 'x'.repeat(1024 * 1024 - 2048 - 10 - Buffer.byteLength(JSON.stringify(seed)));
  const out = append(evidenceCollector({ evidence: [seed], omissions: [] }), [row('tool-result', 'lost', 'one'), row('tool-result', 'also', 'two')], 1);
  assert.equal(out.evidence.length, 1);
  assert.deepEqual(out.omissions, [{ reason: 'tool-evidence-serialized-limit', recordId: 'r1', bytes: 8, count: 2 }]);
});

test('empty descriptors are capped so saturated tool traffic cannot fill all record slots', () => {
  const rows = Array.from({ length: 1100 }, (_, i) => [row('tool-call', 'x'.repeat(1000), `c${i}`), row('tool-result', 'x'.repeat(32768), `c${i}`)]).flat();
  const out = append(evidenceCollector(), [...rows, row('user', 'Late human correction.'), row('assistant', 'Qualification remains unresolved.')]);
  assert.equal(out.omissions.filter(item => item.reason === 'tool-text-omitted').length, 32);
  assert.deepEqual(out.evidence.slice(-2).map(item => item.text), ['Late human correction.', 'Qualification remains unresolved.']);
  assert(out.omissions.some(item => item.reason === 'tool-descriptor-budget-exhausted'));
});

test('per-call boundaries step back inside multibyte characters', () => {
  const out = append(evidenceCollector(), [row('tool-call', '界'.repeat(10000), 'unicode'), row('tool-result', '界'.repeat(10000), 'unicode')]);
  assert.deepEqual(out.evidence.map(item => Buffer.byteLength(item.text)), [8190, 16383]);
  assert(out.evidence.every(item => !item.text.includes('\ufffd')));
  assert.equal(omittedBytes(out), 60000 - 8190 - 16383);
});


for (const full of ['records', 'bytes']) test(`invalid tool text stays a coded error after ${full} exhaustion`, () => {
  const out = full === 'records' ? append(evidenceCollector(), Array.from({ length: 2048 }, () => row('user', 'x')))
    : append(evidenceCollector(), [row('user', 'x'.repeat(2 * 1024 * 1024))]);
  for (const text of [undefined, null, 3, {}, '\ud800']) {
    assert.throws(() => append(out, [row('tool-call', text, 'malformed')], 5000), { code: 'INVALID_WORKFLOW' });
  }
});
