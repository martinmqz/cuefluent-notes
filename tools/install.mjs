import fs from 'node:fs/promises';
import path from 'node:path';
import { readVerifiedPackage, verifyPackage } from './packaging.mjs';

const fail = code => { const error = new Error('The verified package could not be copied to the explicit fresh destination.'); error.code = code; throw error; };
const requireInstall = (condition, code) => { if (!condition) fail(code); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function ancestors(directory) {
  const paths = [];
  for (let current = directory; ; current = path.dirname(current)) { paths.unshift(current); if (path.dirname(current) === current) break; }
  const chain = [];
  for (const file of paths) { const stat = await fs.lstat(file, { bigint: true }); requireInstall(stat.isDirectory() && !stat.isSymbolicLink(), 'INSTALL_PARENT_UNSAFE'); chain.push({ file, stat }); }
  return chain;
}
async function assertChain(chain) {
  for (const item of chain) { const stat = await fs.lstat(item.file, { bigint: true }); requireInstall(stat.isDirectory() && !stat.isSymbolicLink() && same(item.stat, stat), 'INSTALL_PARENT_CHANGED'); }
}

/** Explicit verified copy only. No native folder discovery, registration, hook
 * trust, settings/auth changes, overwrite, upgrade, or cleanup of old versions. */
export async function installPackage({ sourceRoot, destination, expectedInventorySha256, client } = {}) {
  requireInstall(typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot) && typeof destination === 'string' && path.isAbsolute(destination) &&
    path.normalize(destination) === destination && !/[\u0000-\u001f\u007f]/.test(destination) && destination !== path.parse(destination).root, 'INSTALL_ARGUMENT');
  requireInstall(typeof expectedInventorySha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedInventorySha256), 'INSTALL_TRUSTED_DIGEST_REQUIRED');
  requireInstall(client === undefined || ['codex', 'claude'].includes(client), 'INSTALL_ARGUMENT');
  const captured = await readVerifiedPackage(sourceRoot, { expectedInventorySha256 });
  requireInstall(client === undefined || captured.verification.client === client, 'INSTALL_CLIENT_MISMATCH');
  const source = await fs.realpath(sourceRoot), parent = await fs.realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination)), relative = path.relative(source, target);
  requireInstall(relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), 'INSTALL_SOURCE_OVERLAP');
  const chain = await ancestors(parent); await assertChain(chain);
  try { await fs.mkdir(target, { mode: 0o755 }); }
  catch (error) { if (error.code === 'EEXIST') fail('INSTALL_DESTINATION_EXISTS'); throw error; }
  const targetChain = await ancestors(target); await assertChain(chain);
  try {
    for (const file of captured.files) {
      await assertChain(targetChain);
      const final = path.join(target, ...file.path.split('/')), directory = path.dirname(final);
      await fs.mkdir(directory, { recursive: true, mode: 0o755 }); const nested = await ancestors(directory); await assertChain(targetChain);
      const handle = await fs.open(final, 'wx', 0o644);
      try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
      await assertChain(nested); await assertChain(targetChain);
    }
    const verification = await verifyPackage(target, { expectedInventorySha256 }); await assertChain(targetChain);
    return Object.freeze({ state: 'copied', destination: target, client: verification.client, version: verification.version, inventorySha256: verification.inventorySha256,
      registration: 'Use the native client workflow to register this folder and separately review hook trust. Project setup remains explicit.' });
  } catch (cause) {
    // A partial destination is never treated as installed or deleted/reset by
    // retry. Keep it inspectable and choose a fresh destination after a failure.
    const error = new Error('Package copy stopped; the partial destination was preserved.'); error.code = 'INSTALL_COPY_INCOMPLETE'; error.cause = cause; throw error;
  }
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node install.mjs /absolute/verified-package /absolute/FRESH-destination --expected-inventory-sha256 SHA256 [--client codex|claude]\nCopies verified bytes only. Native registration, hook trust and project setup remain explicit.'); return;
  }
  requireInstall((args.length === 4 || args.length === 6) && args[2] === '--expected-inventory-sha256' && (args.length === 4 || args[4] === '--client'), 'INSTALL_ARGUMENT');
  console.log(JSON.stringify(await installPackage({ sourceRoot: args[0], destination: args[1], expectedInventorySha256: args[3], client: args[5] }), null, 2));
}
if (import.meta.main) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(`Package copy failed (${typeof error.code === 'string' ? error.code : 'INSTALL_FAILED'}).`); process.exitCode = 1; }
}
