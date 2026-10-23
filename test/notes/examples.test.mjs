import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
test('example checker applies generated rules to BOM and indented metadata openers', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cue-example-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'tools')); await fs.mkdir(path.join(root, 'examples'));
  // Exercise the actual tool against disposable examples; retain the real
  // parser import so no copied dependency tree or user example is modified.
  const tool = (await fs.readFile(new URL('../../tools/check-examples.mjs', import.meta.url), 'utf8'))
    .replace("'../src/notes/index.mjs'", JSON.stringify(new URL('../../src/notes/index.mjs', import.meta.url).href));
  const executable = path.join(root, 'tools/check-examples.mjs'); await fs.writeFile(executable, tool);
  for (const [name, prefix] of [['bom', '\uFEFF'], ['indent', '  ']]) {
    await fs.writeFile(path.join(root, `examples/${name}.md`), `${prefix}<!-- cuefluent\nschema_version: 1\nid: synthetic\n-->\n# Topic\n\n## Answer\n\nBody.\n`);
  }
  await assert.rejects(execute(process.execPath, [executable]), error => error.code === 1 && /bom.md:.*generated-metadata-incomplete/.test(error.stderr) && /indent.md:.*generated-metadata-incomplete/.test(error.stderr));
});
