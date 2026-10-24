import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail } from './core/errors.mjs';
import { withWindowsAclDeadline } from './storage/windows-acl.mjs';
import { openStore, readSettings } from './storage/store.mjs';
import { pinDirectory } from './storage/paths.mjs';
import { readJSON } from './storage/files.mjs';
import { parseEntryArguments, selectStoreRoot, loadClientContract } from './client/entry-options.mjs';
import { handleNativeHook } from './client/hooks.mjs';
import { isClaudeCommandExpansion } from './client/commands.mjs';
import { buildClaudeCommandContext } from './client/history.mjs';
import { createCodexNativeAdapter } from './client/codex-native.mjs';
import { createControlBridge, serveControl } from './client/control-server.mjs';
import { claimInvocation, runClaimedInvocation, readInvocation, launchInvocationChild, reportInvocationExit } from './control/invocations.mjs';
import { executeControl } from './control/execute.mjs';
import { createDirectNoteTools } from './control/direct-notes.mjs';
import { readProjectStatus } from './control/status.mjs';
import { setupProject } from './control/setup.mjs';
import { createSyncRuntime } from './sync/runtime.mjs';
import { packageIdentity } from './core/version.mjs';
import { processingLauncher } from './processing/worker.mjs';

const ENTRY = fileURLToPath(import.meta.url), PACKAGE = path.dirname(path.dirname(ENTRY));
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'CUEFLUENT_FAILED';
function nodeVersion() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 26 || minor < 12 || minor === 12 && patch < 1) fail('NODE_VERSION_UNSUPPORTED', 'Cuefluent Notes requires Node 26.12.1 or a newer Node 26 patch.');
}
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

export async function main(argv = process.argv.slice(2)) {
  const started = performance.now();
  nodeVersion();
  const args = parseEntryArguments(argv), skillVersion = await version();
  const storeRoot = args.storeRoot ?? selectStoreRoot();
  if (args.command === 'hook') {
    const envelope = await inputJSON(process.stdin, 64 * 1024 * 1024);
    const limit = args.client === 'codex' && ['SessionEnd', 'Interrupt'].includes(envelope?.hook_event_name) ? 3000 : 10000;
    // Include store opening in the ACL budget and leave time for a coded reply
    // before the native hook runner terminates the two-process wrapper.
    return withWindowsAclDeadline(() => runEntry(args, skillVersion, storeRoot, envelope),
      { timeoutMs: Math.max(1, Math.floor(limit - (performance.now() - started) - 500)) });
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
  let store = await openStore(storeRoot);
  if (args.command === 'settings') {
    const settings = await readSettings(store); output({ state: store ? 'configured' : 'unconfigured', storeRoot, settingsHash: settings.hash, settings: settings.value }); return;
  }
  if (args.command === 'status') { output(await readProjectStatus(store, args.projectId)); return; }
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
      const result = mapped.command.action === 'status' ? await execute(mapped.command) : await submitCommand(store, mapped.command);
      const context = result.handle ? buildClaudeCommandContext(result.handle) : `Cuefluent Notes result: ${JSON.stringify(result)}`;
      output({ hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: context } }); return;
    }
    if (args.command === 'mcp') {
      const adapter = args.client === 'codex' ? createCodexNativeAdapter({ version: skillVersion }) : null;
      try {
        let directNotes = createDirectNoteTools({ store, client: args.client, skillVersion }), opening = null;
        // A server may start before explicit setup creates the private store.
        // Recheck only that absent state; once opened, keep its pinned identity.
        const refreshStore = async () => {
          if (store) return;
          opening ??= (async () => {
            const opened = await openStore(storeRoot);
            if (!opened) return;
            await runtime.close();
            store = opened;
            runtime = createSyncRuntime({ store, entry: ENTRY, version: skillVersion });
            execute = commandExecutor(store, runtime, skillVersion);
            directNotes = createDirectNoteTools({ store, client: args.client, skillVersion });
          })().finally(() => { opening = null; });
          await opening;
        };
        const bridge = createControlBridge({ client: args.client, selection: contract.codex, codexAdapter: adapter,
          directNotes: { tools: directNotes.tools, async call(...input) { await refreshStore(); return directNotes.call(...input); } },
          executeInvocation: async invocation => { await refreshStore(); return invocation.action === 'status' ? execute(invocation) : submitCommand(store,
            { ...invocation, clientContract: clientContract(contract, args.client) }); },
          readInvocation: async handle => { await refreshStore(); return readInvocation(store, handle); } });
        let finish;
        const ended = new Promise(resolve => { finish = resolve; });
        const transport = serveControl(bridge, { version: skillVersion, onFailure: () => { process.exitCode = 1; process.stdin.destroy(); finish(); } });
        process.stdin.once('end', finish); process.stdin.once('close', finish);
        await ended; await transport.idle();
      } finally { await adapter?.close(); }
    }
  } finally { await runtime.close(); }
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    const code = codeOf(error);
    if (process.argv[2] === 'hook') output({ systemMessage: `Cuefluent Notes could not finish this hook (${code}). Use its status command to inspect retained work.` });
    else { process.stderr.write(`Cuefluent Notes: ${code}\n`); process.exitCode = 1; }
  }
}
