import { probeGate, tryAcquireExistingGate } from '../../src/storage/gates.mjs';
import { assertPrivateAccess } from '../../src/storage/platform.mjs';

const identity = JSON.parse(process.argv[2]);
const operation = process.argv[3] ?? 'hold';
const options = process.platform === 'win32' ? { guardPath: (file, { stat }) => assertPrivateAccess(file, stat) } : {};
try {
  if (operation === 'probe') {
    process.send?.({ type: 'probe', result: probeGate(identity, options) }, () => process.disconnect());
  } else {
    const result = tryAcquireExistingGate(identity, options);
    if (!result.acquired) throw new Error('Gate holder found a busy gate.');
    process.send?.({ type: 'ready' });
    process.on('message', (message) => {
      if (message === 'release') {
        result.acquired.release();
        process.send?.({ type: 'released' }, () => process.disconnect());
      }
    });
    process.on('disconnect', () => { result.acquired.release(); });
  }
} catch (error) {
  process.send?.({ type: 'error', code: error.code, message: error.message }, () => process.disconnect());
  process.exitCode = 1;
}
