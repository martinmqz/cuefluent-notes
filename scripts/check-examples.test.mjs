import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exampleChecks } from './check-examples.mjs';

test('example check selection follows all manifest cases once per file and confines names to the examples directory', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-example-cases-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const casePath = path.join(directory, 'check-cases.json');
  const save = cases => fs.writeFile(casePath, JSON.stringify({ version: 1, cases }));
  await save([{ file: 'first.md' }, { file: 'first.md' }, { file: 'new-member.md' }]);
  assert.deepEqual(await exampleChecks(directory), { casePath, files: ['first.md', 'new-member.md'].map(name => path.join(directory, name)), caseCount: 3 });
  for (const file of ['../outside.md', '/outside.md', 'C:\\outside.md', 'nested/note.md', 'case.json', null]) {
    await save([{ file }]);
    await assert.rejects(exampleChecks(directory), /directly inside/);
  }
  await save([]); await assert.rejects(exampleChecks(directory), /1–200 cases/);
});
