import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { JsonProcess, requireClient, sameNames, boundedText } from './protocol.mjs';

// Optional bundled features may be enabled by remote flags. Explicitly disable
// their trusted built-in IDs, then verify capabilities rather than their labels.
const optionalBuiltins = ['cc-plugin-plugin-authoring', 'cc-plugin-mods-guide', 'cc-plugin-tips', 'cc-plugin-mermaid', 'cc-plugin-responsive-mode', 'cc-plugin-diff', 'cc-plugin-you-should-know', 'cc-plugin-easel', 'cc-plugin-claude-test'];
function supportedVersion(value) {
  const parts = typeof value === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  return Boolean(parts && Number(parts[1]) === 2 && (Number(parts[2]) > 1 || Number(parts[2]) === 1 && Number(parts[3]) >= 307));
}
function launchEnvironment(inherited, mcp) {
  // Preserve native authentication, routing and proxy values exactly. Effort is
  // worker-owned; inherited launch overrides must not supersede the chosen flag.
  const env = { ...inherited };
  for (const name of Object.keys(env)) {
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    if (key === 'CLAUDECODE' || key === 'CLAUDE_CODE_EFFORT_LEVEL') delete env[name];
  }
  return { ...env, ...mcp };
}
export async function runClaude(options, dependencies) {
  const { executable, cwd, mcp, model, effort, prompt, input, signal, onStarted } = options;
  const sessionId = randomUUID(), tools = mcp.tools.map(name => `mcp__${mcp.name}__${name}`);
  const config = { mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, env: Object.fromEntries(Object.keys(mcp.env).map(name => [name, `\${${name}}`])) } } };
  const args = ['-p', '--session-id', sessionId, '--model', model, '--effort', effort, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--restricted', '--tools', '', '--allowedTools', ...tools, '--permission-mode', 'dontAsk', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--disable-slash-commands', '--no-chrome', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: Object.fromEntries(optionalBuiltins.map(name => [`${name}@builtin`, false])), autoMemoryEnabled: false }), '--system-prompt', prompt];
  const env = launchEnvironment(process.env, mcp.env);
  const transport = new JsonProcess(executable, args, { cwd: cwd.path, env, signal, ...dependencies });
  transport.onMessage = value => {
    if (value.type === 'control_request') { transport.send({ type: 'control_response', response: { subtype: 'error', request_id: value.request_id, error: 'No interactive capabilities are available.' } }); return true; }
    if (value.type === 'system' && /hook|permission_denied/.test(value.subtype ?? '')) { transport.reject('PROCESSING_ISOLATION_UNSUPPORTED'); return true; }
    return false;
  };
  try {
    const initialize = await transport.request('initialize', {}, true);
    requireClient(supportedVersion(initialize?.claude_code_version), 'PROCESSING_CLIENT_VERSION_UNSUPPORTED');
    requireClient(initialize.current_permission_mode === 'dontAsk');
    const settings = await transport.request('get_settings', {}, true);
    requireClient(settings?.effective?.disableAllHooks === true && settings.effective.autoMemoryEnabled === false && Object.values(settings.effective.enabledPlugins ?? {}).every(enabled => enabled === false));
    requireClient(Array.isArray(settings.sources) && settings.sources.every(source => source.source === 'flagSettings') && !settings.errors?.length);
    requireClient(settings.applied?.model === 'claude-opus-5-5');
    requireClient(settings.applied.effort === effort, 'PROCESSING_EFFORT_UNAVAILABLE');
    let servers;
    do {
      servers = (await transport.request('mcp_status', {}, true))?.mcpServers;
      requireClient(Array.isArray(servers) && servers.length === 1 && servers[0].name === mcp.name);
      if (servers[0].status === 'pending') await pause(100, undefined, { signal });
    } while (servers[0].status === 'pending');
    requireClient(Array.isArray(servers) && servers.length === 1 && servers[0].name === mcp.name && servers[0].status === 'connected' && servers[0].source === 'dynamic' && sameNames(servers[0].tools?.map(tool => tool.name), mcp.tools));
    const context = await transport.request('get_context_usage', { detail: 'summary' }, true);
    requireClient(context?.memoryFiles?.length === 0 && (context.deferredBuiltinTools?.length ?? 0) === 0 && (context.systemTools?.length ?? 0) === 0 && sameNames(context.mcpTools?.map(tool => tool.name), tools) && (context.mcpInstructions?.length ?? 0) === 0);
    await cwd.check(); await onStarted?.({ client: 'claude', sessionId, model: 'claude-opus-5-5', ephemeral: true });
    transport.send({ type: 'user', message: { role: 'user', content: JSON.stringify({ kind: 'untrusted-conversation', input }) } });
    let sawInit = false, result;
    while (!result) {
      const value = await transport.next();
      if (value.type === 'system' && value.subtype === 'init') {
        requireClient(value.session_id === sessionId && value.model === 'claude-opus-5-5' && value.permissionMode === 'dontAsk' && sameNames(value.tools, tools) && value.slash_commands?.length === 0 && value.skills?.length === 0 && (value.additional_directories === undefined || Array.isArray(value.additional_directories) && value.additional_directories.length === 0));
        requireClient(Array.isArray(value.plugins ?? []) && (value.plugins ?? []).every(plugin => plugin.path === 'builtin')); sawInit = true;
      }
      if (value.type === 'assistant') for (const item of value.message?.content ?? []) if (item.type === 'tool_use') requireClient(tools.includes(item.name));
      if (value.type === 'result') result = value;
    }
    requireClient(sawInit && result.session_id === sessionId && result.subtype === 'success' && result.is_error === false && (result.permission_denials?.length ?? 0) === 0, 'PROCESSING_CLIENT_FAILED');
    requireClient(boundedText(result.result, 256 * 1024), 'PROCESSING_PROTOCOL_LIMIT');
    const exit = await transport.finish(); requireClient(exit.code === 0, 'PROCESSING_CLIENT_FAILED');
    return Object.freeze({ client: 'claude', sessionId, model: 'claude-opus-5-5', status: 'completed', finalText: result.result });
  } finally { await transport.dispose(); }
}
