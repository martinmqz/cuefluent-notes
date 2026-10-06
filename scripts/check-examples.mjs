import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFiles, readBounded } from './check-notes.mjs';
import { isMain } from './file-io.mjs';

// Repository maintenance only. The package's explicit SOURCE_FILES allowlist
// remains the authority for what ships; the cases select what gets checked.
export async function exampleChecks(directory) {
  const casePath = path.join(directory, 'check-cases.json');
  const input = JSON.parse(await readBounded(casePath));
  if (input?.version !== 1 || !Array.isArray(input.cases) || !input.cases.length || input.cases.length > 200) throw new Error('Examples require version 1 and 1–200 cases.');
  const names = input.cases.map(item => item?.file);
  if (names.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*\.(md|markdown)$/i.test(name))) throw new Error('Example cases must name Markdown files directly inside the examples directory.');
  return { casePath, files: [...new Set(names)].map(name => path.join(directory, name)), caseCount: input.cases.length };
}

if (await isMain(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: node scripts/check-examples.mjs');
    const { files, casePath } = await exampleChecks(fileURLToPath(new URL('../examples/', import.meta.url)));
    const report = await checkFiles(files, casePath);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.errors ? 1 : 0;
  } catch (error) { console.error(`Example check failed: ${String(error.message).slice(0, 500)}`); process.exitCode = 2; }
}
