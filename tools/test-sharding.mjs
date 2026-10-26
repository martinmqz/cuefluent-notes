// Repository-only scheduling hints. Discovery, never this data, owns coverage.
export function testWeights(files, timings, platform) {
  const samples = timings?.version === 1 && timings.platforms?.[platform];
  const valid = samples && typeof samples === 'object' && !Array.isArray(samples) &&
    Object.entries(samples).every(([name, value]) => name.endsWith('.test.mjs') &&
      value && Number.isFinite(value.ms) && value.ms >= 0 && Number.isFinite(value.bytes) && value.bytes > 0);
  const rates = valid ? Object.values(samples).map(value => value.ms / value.bytes).sort((a, b) => a - b) : [];
  // New files still run. Their source-size estimate uses the median native rate;
  // missing/invalid platform measurements revert to the previous byte weights.
  const rate = rates.length ? rates[Math.floor(rates.length / 2)] : 1;
  return new Map(files.map(({ name, bytes }) => [name,
    Math.max(1, valid && Object.hasOwn(samples, name) ? samples[name].ms : bytes * rate)]));
}

export function testShard(files, spec, weights) {
  if (!spec) return files; // Unsharded local/Linux discovery keeps its order.
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(spec);
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count || count > 1024)
    throw new Error(`Invalid CUEFLUENT_TEST_SHARD: ${spec}`);
  const ordered = [...files].sort((a, b) => weights.get(b) - weights.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  const loads = Array.from({ length: count }, () => ({ cost: 0, files: [] }));
  for (const name of ordered) {
    const owner = loads.reduce((best, load, i) => load.cost < loads[best].cost ||
      (load.cost === loads[best].cost && load.files.length < loads[best].files.length) ? i : best, 0);
    loads[owner].cost += weights.get(name); loads[owner].files.push(name);
  }
  // Weights decide only which shard a file lands in. Node runs an explicit file
  // list in alphabetical order, so the order returned here carries no meaning.
  return loads[index - 1].files;
}
