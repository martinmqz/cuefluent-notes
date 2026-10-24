import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keep the preflight loadable on Node 18+. Earlier runtimes may fail in Node's
// own loader. No local static import may bypass this guarded bootstrap, and the
// SQLite/FFI runtime loads only after the version requirement has been checked.
async function launch(argv, context = {}) {
  context.stage = 'module-load';
  const { reportFailure, supportsNode } = await import('./diagnostics.mjs');
  context.reportFailure = reportFailure;
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
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

// This small last resort must remain self-contained: a damaged diagnostics
// module cannot provide its own report. Never inspect or print its exception.
function reportBootstrapFailure(context) {
  const diagnostics = { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, stage: 'module-load',
    executable: process.execPath.length <= 4096 ? process.execPath : '(path exceeds diagnostic limit)' };
  if (['mcp', 'hook', 'setup', 'settings', 'status', 'sync-steward', 'sync-collect', 'command-worker'].includes(context.operation)) diagnostics.operation = context.operation;
  if (['claude', 'codex'].includes(context.client)) diagnostics.client = context.client;
  const message = 'Cuefluent Notes [CUEFLUENT_BOOTSTRAP_FAILED]: Startup diagnostics could not be loaded.\n' +
    'Next step: Reinstall the plugin through its marketplace and use Node 26.12.1 or a later 26.x release, then restart the client.\n' +
    `Diagnostics: ${JSON.stringify(diagnostics)}`;
  const stream = context.operation === 'hook' ? process.stdout : process.stderr;
  const ignore = () => {};
  // The diagnostic destination may already be closed. Its failure cannot be
  // reported through that destination, and must never escape as a raw stack.
  stream.once('error', ignore);
  try { stream.write(context.operation === 'hook' ? JSON.stringify({ systemMessage: message }) + '\n' : message + '\n'); }
  catch { /* The host can no longer receive this diagnostic. */ }
}

if (isEntry()) {
  const context = { operation: process.argv[2], client: process.argv[3] };
  try { await launch(process.argv.slice(2), context); }
  catch (error) {
    if (context.reportFailure) context.reportFailure(error, context);
    else reportBootstrapFailure(context);
    if (process.argv[2] !== 'hook') process.exitCode = 1;
  }
}
