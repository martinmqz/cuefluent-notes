import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNote } from '../src/notes/index.mjs';

const directory = fileURLToPath(new URL('../examples/', import.meta.url));
const files = (await fs.readdir(directory)).filter(file => file.endsWith('.md')).sort();
if (!files.length) throw new Error('No synthetic note examples were found.');
for (const file of files) {
  const source = await fs.readFile(path.join(directory, file));
  const result = validateNote(source, { generated: source.subarray(0, 14).toString().startsWith('<!-- cuefluent') });
  if (!result.valid) { process.stderr.write(`${file}: ${JSON.stringify(result.diagnostics)}\n`); process.exitCode = 1; }
}
if (!process.exitCode) process.stdout.write(`Validated ${files.length} synthetic note examples.\n`);
