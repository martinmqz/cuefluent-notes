import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsCanaryCommand } from '../../../src/processing/clients/canary.mjs';

test('Windows native canary binds hostile-looking paths as literal environment values with delayed expansion off', () => {
  const file = String.raw`C:\Users\Synthetic & User!\Temp\note %PATH% $value 'quote' ` + "`tick`.txt";
  for (const operation of ['read', 'write']) {
    const value = windowsCanaryCommand(String.raw`C:\Windows`, operation, file);
    assert.deepEqual(value.env, { CUEFLUENT_CANARY_FILE: `"${file}"` });
    assert.equal(value.command[0], String.raw`C:\Windows\System32\cmd.exe`);
    assert.ok(value.command.includes('/v:off'));
    assert.equal(value.command.some(argument => argument.includes(file)), false);
    assert.equal(value.command.at(-1), operation === 'read' ? 'type %CUEFLUENT_CANARY_FILE%' : 'echo CUEFLUENT_CANARY_WRITE > %CUEFLUENT_CANARY_FILE%');
  }
  for (const unsafe of ['relative.txt', 'C:\\bad"quote.txt', 'C:\\line\nbreak.txt']) assert.throws(() => windowsCanaryCommand('C:\\Windows', 'write', unsafe), { code: 'PROCESSING_ISOLATION_UNSUPPORTED' });
});
