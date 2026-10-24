import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail } from './core/errors.mjs';
import { reportFailure, supportsNode } from './diagnostics.mjs';

// Keep this entrypoint loadable by older Node versions. In particular, do not
// import the SQLite/FFI runtime until its version requirement has been checked.
async function launch(argv, stage = () => {}) {
  stage('runtime-check');
  if (!supportsNode(process.versions.node)) fail('NODE_VERSION_UNSUPPORTED', 'The Node runtime is unsupported.');
  stage('module-load');
  const runtime = await import('./runtime-entry.mjs');
  stage('command');
  return runtime.main(argv);
}

export function main(argv = process.argv.slice(2)) { return launch(argv); }

function isEntry() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  // Older Node releases have no import.meta.main. Resolve symlink-spelled
  // entrypoints as well, while imports remain free of command execution.
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isEntry()) {
  let stage = 'runtime-check';
  try { await launch(process.argv.slice(2), value => { stage = value; }); }
  catch (error) {
    reportFailure(error, { stage, operation: process.argv[2], client: process.argv[3] });
    if (process.argv[2] !== 'hook') process.exitCode = 1;
  }
}
