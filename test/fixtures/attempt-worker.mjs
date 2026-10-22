import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { openStore } from '../../src/storage/store.mjs';
import { writeJSON } from '../../src/storage/files.mjs';
import { attachAttemptChild, launchOwnedAttempt, ownAttempt, withCurrentAttempt } from '../../src/storage/attempts.mjs';

const [mode, root, serialized] = process.argv.slice(2);
const options = JSON.parse(serialized);
const store = await openStore(path.join(root, 'private'));
async function marker(name, value) {
  const staged = path.join(root, `.${name}.${randomUUID()}.tmp`);
  await fs.writeFile(staged, JSON.stringify(value));
  await fs.rename(staged, path.join(root, name));
}
const outcome = value => marker('outcome.json', value);

if (mode === 'worker') {
  try {
    let retained;
    await ownAttempt(store, 'demo', options, async owner => {
      retained = owner;
      await marker('working.json', { attemptId: owner.attemptId });
      const deadline = Date.now() + 15_000;
      while (true) {
        try { await fs.stat(path.join(root, 'finish')); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (Date.now() > deadline) throw new Error('Fixture work was never released.');
        await delay(20);
      }
      const publication = withCurrentAttempt(owner, async ({ directory, run, hash }) => {
        if (options.unawaited) {
          await fs.writeFile(path.join(root, 'publishing'), '');
          await delay(200);
        }
        if (options.unawaitedFailure || options.handledFailure) throw Object.assign(new Error('Synthetic publication failure.'), { code: 'SYNTHETIC_PUBLICATION_FAILED' });
        await writeJSON(store.pin, `${directory}/run.json`, { ...run, warnings: ['synthetic worker finished'] }, { expectedHash: hash });
      });
      if (options.chainedUnawaited === 'then') publication.then(() => {});
      else if (options.chainedUnawaited === 'finally') publication.finally(() => {});
      else if (options.handledFailure) await publication.catch(() => {});
      else if (!options.unawaited && !options.unawaitedFailure) await publication;
    });
    if (options.postRelease) {
      await withCurrentAttempt(retained, () => { throw new Error('Released worker published.'); });
    }
    await outcome({ ok: true });
  } catch (error) {
    await outcome({ code: error.code ?? 'FIXTURE_FAILED', message: error.message });
    process.exitCode = 1;
  }
} else {
  const launch = async context => {
    const child = fork(fileURLToPath(import.meta.url), ['worker', root, JSON.stringify(context)], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const handshake = attachAttemptChild(child, context);
    if (mode === 'before-publication') {
      return { ...handshake, ready: handshake.ready.then(async () => {
        process.send({ stage: 'owned', workerPid: child.pid });
        await new Promise(() => {});
      }) };
    }
    if (mode === 'before-activation') {
      return { ...handshake, activate: async () => {
        process.send({ stage: 'published', workerPid: child.pid });
        await new Promise(() => {});
      } };
    }
    return handshake;
  };
  const result = await launchOwnedAttempt(store, 'demo', { runId: options.runId, launch });
  process.send({ stage: 'activated', result }, () => process.disconnect());
}
