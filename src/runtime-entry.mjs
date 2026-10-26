import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail } from './core/errors.mjs';
import { withWindowsAclDeadline } from './storage/windows-acl.mjs';
import { openStore, openStoreOrScaffold, readSettings } from './storage/store.mjs';
import { pinDirectory } from './storage/paths.mjs';
import { readJSON } from './storage/files.mjs';
import { parseEntryArguments, selectStoreRoot, loadClientContract } from './client/entry-options.mjs';
import { handleNativeHook } from './client/hooks.mjs';
import { isClaudeCommandExpansion } from './client/commands.mjs';
import { buildClaudeCommandContext } from './client/history.mjs';
import { createCodexNativeAdapter } from './client/codex-native.mjs';
import { createControlBridge, serveControl, presentControlResult } from './client/control-server.mjs';
import { claimInvocation, runClaimedInvocation, readInvocation, launchInvocationChild, reportInvocationExit } from './control/invocations.mjs';
import { executeControl } from './control/execute.mjs';
import { createDirectNoteTools } from './control/direct-notes.mjs';
import { createProjectTools, PROJECT_TOOLS } from './control/project-tools.mjs';
import { readProjectStatus } from './control/status.mjs';
import { setupProject } from './control/setup.mjs';
import { createSyncRuntime } from './sync/runtime.mjs';
import { packageIdentity } from './core/version.mjs';
import { processingLauncher } from './processing/worker.mjs';
import { reportFailure } from './diagnostics.mjs';

const ENTRY = fileURLToPath(new URL('./cli.mjs', import.meta.url)), PACKAGE = path.dirname(path.dirname(ENTRY));
async function version() {
  const file = await readJSON(await pinDirectory(PACKAGE), 'package.json', { maxBytes: 64 * 1024 });
  return packageIdentity(file.value);
}
async function inputJSON(stream, maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
    if (bytes > maxBytes) fail('INPUT_LIMIT', 'The native request exceeds its bounded input profile.');
    chunks.push(buffer);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail('INPUT_INVALID', 'The request must be valid UTF-8 JSON.'); }
}
function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
async function launchCommand(store, handle) {
  const child = spawn(process.execPath, [ENTRY, 'command-worker', store.root, handle], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  return launchInvocationChild(child, { handle });
}
function commandExecutor(store, runtime, skillVersion) {
  return async invocation => {
    const result = await executeControl(store, invocation, { reconcileChat: chat => runtime.collect(chat),
      launchProcessing: processingLauncher({ client: invocation.client, skillVersion }) });
    if (['track', 'untrack'].includes(invocation.action) && ['tracked', 'untracked'].includes(result.state)) await runtime.schedule();
    return result;
  };
}
function clientContract(contract, client) {
  return { name: client === 'claude' ? contract.claude.name : contract.codex.name, skillPath: contract.codex.skillPath };
}
async function submitCommand(store, invocation) {
  const claimed = await claimInvocation(store, invocation);
  if (!claimed.ticket) return claimed.result;
  if (claimed.pending) await launchCommand(store, claimed.ticket);
  return readInvocation(store, claimed.ticket);
}

export async function main(argv = process.argv.slice(2), { onVersion = () => {} } = {}) {
  const args = parseEntryArguments(argv), skillVersion = await version();
  onVersion(skillVersion);
  const storeRoot = args.storeRoot ?? selectStoreRoot();
  if (args.command === 'hook') {
    const envelope = await inputJSON(process.stdin, 64 * 1024 * 1024);
    const limit = args.client === 'codex' && ['SessionEnd', 'Interrupt'].includes(envelope?.hook_event_name) ? 3000 : 10000;
    // performance.now() starts at process startup, so imports and preflight use
    // this same budget. Reserve time for the Codex wrapper and a coded reply;
    // host scheduling and wrapper startup remain outside this child's clock.
    return withWindowsAclDeadline(() => runEntry(args, skillVersion, storeRoot, envelope),
      { timeoutMs: Math.max(0, Math.floor(limit - performance.now() - 500)) });
  }
  return runEntry(args, skillVersion, storeRoot);
}

async function runEntry(args, skillVersion, storeRoot, envelope) {
  if (args.command === 'setup') {
    const request = await readJSON(await pinDirectory(path.dirname(args.configPath)), path.basename(args.configPath), { maxBytes: 1024 * 1024 });
    if (!request.value || typeof request.value !== 'object' || Array.isArray(request.value) ||
        Object.keys(request.value).some(key => !['storeRoot', 'expectedHash', 'project'].includes(key)) || !Object.hasOwn(request.value, 'expectedHash')) fail('SETUP_ARGUMENT', 'Setup needs project settings and the inspected settings hash (null for a fresh store).');
    output(await setupProject({ ...request.value, storeRoot: request.value.storeRoot ?? storeRoot, skillVersion })); return;
  }
  // The connector and the read-only commands start on a location that holds
  // at most the resumable scaffold of a first initialization, so explicit
  // setup can create or resume the store there; a mutation keeps failing on it.
  let store = ['mcp', 'settings', 'status'].includes(args.command) ? await openStoreOrScaffold(storeRoot) : await openStore(storeRoot);
  if (args.command === 'settings') {
    const settings = await readSettings(store); output({ state: store ? 'configured' : 'unconfigured', storeRoot, settingsHash: settings.hash, settings: settings.value }); return;
  }
  if (args.command === 'status') {
    output(presentControlResult(await readProjectStatus(store, args.projectId), { stage: 'result', operation: args.command, client: args.client, version: skillVersion }, { bounded: false })); return;
  }
  let runtime = createSyncRuntime({ store, entry: ENTRY, version: skillVersion });
  let execute = commandExecutor(store, runtime, skillVersion);
  try {
    if (args.command === 'sync-steward') { if (store) await runtime.steward(); return; }
    if (args.command === 'sync-collect') {
      const result = await runtime.collect({ client: args.client, sessionId: args.sessionId });
      if (process.send && process.connected) {
        await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()));
        process.disconnect();
      } else output(result);
      return;
    }
    if (args.command === 'command-worker') {
      const result = await runClaimedInvocation(store, args.handle, { execute, channel: process.send && process.connected ? process : null });
      await reportInvocationExit(process, args.handle, result); return;
    }
    const contract = await loadClientContract(PACKAGE);
    if (args.command === 'hook') {
      const mapped = await handleNativeHook(store, args.client, envelope, { claudeCommand: contract.claude,
        clientContract: clientContract(contract, args.client), schedule: () => runtime.schedule() });
      if (!mapped.command) {
        if (args.client === 'claude' && isClaudeCommandExpansion(envelope, contract.claude)) {
          output({ hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext:
            'Cuefluent Notes did not execute a tracking or processing command. No tracking or processing state was changed. Natural-language note requests may use the direct note tools. If the user intended a tracking or processing action, explain that it did not run and ask for one exact action: track, untrack, process, process project, save, skip, or status.' } });
        }
        return; // Ordinary lifecycle hooks inject no context.
      }
      const result = presentControlResult(mapped.command.action === 'status' ? await execute(mapped.command) : await submitCommand(store, mapped.command),
        { stage: 'result', operation: args.command, client: args.client, version: skillVersion }, { bounded: false });
      const context = result.handle ? buildClaudeCommandContext(result.handle) : `Cuefluent Notes result: ${JSON.stringify(result)}`;
      output({ hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: context } }); return;
    }
    if (args.command === 'mcp') {
      const adapter = args.client === 'codex' ? createCodexNativeAdapter({ version: skillVersion }) : null;
      try {
        const noteTools = () => createDirectNoteTools({ store, client: args.client, skillVersion, launchProcessing: processingLauncher({ client: args.client, skillVersion }) });
        const projectTools = () => createProjectTools({ storeRoot, store, skillVersion });
        const projectToolNames = new Set(PROJECT_TOOLS.map(item => item.name));
        let directNotes = noteTools(), projects = projectTools(), opening = null;
        // A server may start before explicit setup creates the private store.
        // Recheck only that absent state; once opened, keep its pinned identity.
        const refreshStore = async () => {
          if (store) return;
          opening ??= (async () => {
            const opened = await openStoreOrScaffold(storeRoot);
            if (!opened) return;
            await runtime.close();
            store = opened;
            runtime = createSyncRuntime({ store, entry: ENTRY, version: skillVersion });
            execute = commandExecutor(store, runtime, skillVersion);
            directNotes = noteTools(); projects = projectTools();
          })().finally(() => { opening = null; });
          await opening;
        };
        const bridge = createControlBridge({ client: args.client, selection: contract.codex, codexAdapter: adapter,
          directNotes: { tools: [...directNotes.tools, ...projects.tools], async call(name, ...input) {
            // Setup runs against the selected location itself, so it can resume
            // an interrupted initialization that no open can read yet; the
            // store it created or completed is opened for the calls that follow.
            if (name === 'cuefluent_setup') { const result = await projects.call(name, ...input); await refreshStore(); return result; }
            await refreshStore(); return (projectToolNames.has(name) ? projects : directNotes).call(name, ...input);
          } },
          executeInvocation: async invocation => { await refreshStore(); return invocation.action === 'status' ? execute(invocation) : submitCommand(store,
            { ...invocation, clientContract: clientContract(contract, args.client) }); },
          readInvocation: async handle => { await refreshStore(); return readInvocation(store, handle); } });
        let finish;
        const ended = new Promise(resolve => { finish = resolve; });
        const transport = serveControl(bridge, { version: skillVersion, onFailure: error => {
          reportFailure(error, { stage: 'transport', operation: 'mcp', client: args.client, version: skillVersion });
          process.exitCode = 1; process.stdin.destroy(); finish();
        } });
        process.stdin.once('end', finish); process.stdin.once('close', finish);
        await ended; await transport.idle();
      } finally { await adapter?.close(); }
    }
  } finally { await runtime.close(); }
}
