import path from 'node:path';

// Repository-only telemetry. Never include test names, output or fixture paths.
// Each runner phase has its own destination; a completed phase ends in a total.
export default async function* testTimingReporter(events) {
  yield JSON.stringify({ version: 1, type: 'start', platform: process.platform, node: process.version,
    shard: process.env.CUEFLUENT_TEST_SHARD || null, phase: process.env.CUEFLUENT_TEST_TIMING_PHASE || null,
    revision: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null }) + '\n';
  for await (const { type, data } of events) {
    if (type !== 'test:summary') continue;
    yield JSON.stringify({ version: 1, type: data.file ? 'file' : 'total',
      ...(data.file ? { file: path.basename(data.file) } : {}),
      duration_ms: data.duration_ms, success: data.success, counts: data.counts }) + '\n';
  }
}
