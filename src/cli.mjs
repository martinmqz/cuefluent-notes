import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep the preflight loadable on Node 18+. Earlier runtimes may fail in Node's
// own loader. No local static import may bypass this guarded bootstrap, and the
// SQLite/FFI runtime loads only after the version requirement has been checked.
async function launch(argv, context = {}) {
  context.stage = 'module-load';
  const { entryOperation } = await import('./core/entry-contract.mjs');
  context.operation = entryOperation(argv[0]);
  const { reportFailure } = await import('./diagnostics.mjs');
  context.reportFailure = reportFailure;
  const { supportsNode } = await import('./core/runtime.mjs');
  context.stage = 'runtime-check';
  if (!supportsNode(process.versions.node)) throw Object.assign(new Error('The Node runtime is unsupported.'), { code: 'NODE_VERSION_UNSUPPORTED' });
  context.stage = 'module-load';
  const runtime = await import('./runtime-entry.mjs');
  context.stage = 'command';
  return runtime.main(argv, { onVersion: version => { context.version = version; } });
}

export function main(argv = process.argv.slice(2)) { return launch(argv); }

function isEntry() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  // Older Node releases have no import.meta.main. Resolve symlink-spelled
  // entrypoints as well, while imports remain free of command execution.
  // URL normalization folds UNC host casing without folding case-sensitive
  // path components. Node's module URL may already have lowercased the host.
  try { return pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href; }
  catch { return false; }
}

// This small last resort must remain self-contained: a damaged diagnostics
// module cannot provide its own report. Never inspect or print its exception.
function reportBootstrapFailure(context) {
  const diagnostics = { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, stage: 'module-load',
    executable: process.execPath.length <= 4096 ? process.execPath : '(path exceeds diagnostic limit)' };
  // Only launch's successfully loaded command contract sets this field. If it
  // is missing too, omit the operation instead of echoing untrusted argv.
  if (context.operation) diagnostics.operation = context.operation;
  if (['claude', 'codex'].includes(context.client)) diagnostics.client = context.client;
  const message = 'Cuefluent Notes [CUEFLUENT_BOOTSTRAP_FAILED]: Startup diagnostics could not be loaded.\n' +
    'Next step: Reinstall the plugin through its marketplace and use Node 26.12.1 or a later 26.x release, then restart the client.\n' +
    `Diagnostics: ${JSON.stringify(diagnostics)}`;
  const stream = context.hook ? process.stdout : process.stderr;
  const ignore = () => {};
  // The diagnostic destination may already be closed. Its failure cannot be
  // reported through that destination, and must never escape as a raw stack.
  stream.once('error', ignore);
  try { stream.write(context.hook ? JSON.stringify({ systemMessage: message }) + '\n' : message + '\n'); }
  catch { /* The host can no longer receive this diagnostic. */ }
}

if (isEntry()) {
  const context = { hook: process.argv[2] === 'hook', client: process.argv[3] };
  try { await launch(process.argv.slice(2), context); }
  catch (error) {
    if (context.reportFailure) context.reportFailure(error, context);
    else reportBootstrapFailure(context);
    if (!context.hook) process.exitCode = 1;
  }
}
