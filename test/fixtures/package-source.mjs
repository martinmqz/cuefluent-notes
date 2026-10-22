import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPackages, REFERENCES, defaultNpmCache } from '../../tools/packaging.mjs';

export const TEST_NPM_CACHE = process.env.CUEFLUENT_TEST_NPM_CACHE ?? defaultNpmCache();
export async function packageSource(t) {
  const repository = path.resolve(import.meta.dirname, '../..'), root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-copy-test-'))), source = path.join(root, 'source');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['src', 'references', 'tools']) await fs.mkdir(path.join(source, name), { recursive: true });
  await fs.cp(path.join(repository, 'packaging/v2'), path.join(source, 'packaging/v2'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'LICENSE.md']) await fs.copyFile(path.join(repository, name), path.join(source, name));
  for (const name of ['packaging.mjs', 'install.mjs']) await fs.copyFile(path.join(repository, 'tools', name), path.join(source, 'tools', name));
  await fs.writeFile(path.join(source, 'README.md'), '# Synthetic package\n\nDisposable copy fixture.\n');
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: cuefluent-notes\ndescription: Synthetic copy fixture.\n---\n\nUse explicit actions.\n');
  for (const name of REFERENCES) await fs.writeFile(path.join(source, `references/${name}.md`), `# Synthetic ${name}\n\nDisposable fixture.\n`);
  await fs.writeFile(path.join(source, 'src/cli.mjs'), "import {label} from './support.mjs'; console.log(label);\n");
  await fs.writeFile(path.join(source, 'src/support.mjs'), 'export const label = "synthetic";\n');
  await fs.writeFile(path.join(source, 'packaging/v2/source-files.json'), JSON.stringify(['src/cli.mjs', 'src/support.mjs']));
  const output = path.join(root, 'candidate'), built = await buildPackages({ repoRoot: source, outputRoot: output, cacheRoot: TEST_NPM_CACHE });
  return { root, source, output, built };
}
