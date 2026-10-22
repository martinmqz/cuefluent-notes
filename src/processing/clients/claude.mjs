import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { JsonProcess, requireClient, sameNames, boundedText } from './protocol.mjs';

const builtinPlugins = ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-plugin-authoring'];
export async function runClaude(options, dependencies) {
  const { executable, cwd, mcp, model, effort, prompt, input, signal, onStarted } = options;
  const sessionId = randomUUID(), tools = mcp.tools.map(name => `mcp__${mcp.name}__${name}`);
  const config = { mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, env: Object.fromEntries(Object.keys(mcp.env).map(name => [name, `\${${name}}`])) } } };
  const args = ['-p', '--session-id', sessionId, '--model', model, '--effort', effort, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--restricted', '--tools', '', '--allowedTools', ...tools, '--permission-mode', 'dontAsk', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--disable-slash-commands', '--no-chrome', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, enabledPlugins: {}, autoMemoryEnabled: false }), '--system-prompt', prompt];
  const env = { ...process.env, ...mcp.env }; delete env.CLAUDECODE;
  const transport = new JsonProcess(executable, args, { cwd: cwd.path, env, signal, ...dependencies });
  transport.onMessage = value => {
    if (value.type === 'control_request') { transport.send({ type: 'control_response', response: { subtype: 'error', request_id: value.request_id, error: 'No interactive capabilities are available.' } }); return true; }
    if (value.type === 'system' && /hook|permission_denied/.test(value.subtype ?? '')) { transport.reject('PROCESSING_ISOLATION_UNSUPPORTED'); return true; }
    return false;
  };
  try {
    const initialize = await transport.request('initialize', {}, true);
    requireClient(initialize?.claude_code_version === '2.1.307' && initialize.current_permission_mode === 'dontAsk');
    const settings = await transport.request('get_settings', {}, true);
    requireClient(settings?.effective?.disableAllHooks === true && settings.effective.autoMemoryEnabled === false && Object.values(settings.effective.enabledPlugins ?? {}).every(enabled => enabled === false));
    requireClient(Array.isArray(settings.sources) && settings.sources.every(source => source.source === 'flagSettings') && !settings.errors?.length);
    requireClient(settings.applied?.model === 'claude-opus-5-5' && settings.applied.effort === effort);
    let servers;
    do {
      servers = (await transport.request('mcp_status', {}, true))?.mcpServers;
      requireClient(Array.isArray(servers) && servers.length === 1 && servers[0].name === mcp.name);
      if (servers[0].status === 'pending') await pause(100, undefined, { signal });
    } while (servers[0].status === 'pending');
    requireClient(Array.isArray(servers) && servers.length === 1 && servers[0].name === mcp.name && servers[0].status === 'connected' && servers[0].source === 'dynamic' && sameNames(servers[0].tools?.map(tool => tool.name), mcp.tools));
    const context = await transport.request('get_context_usage', { detail: 'summary' }, true);
    requireClient(context?.memoryFiles?.length === 0 && (context.deferredBuiltinTools?.length ?? 0) === 0 && sameNames(context.mcpTools?.map(tool => tool.name), tools) && (context.mcpInstructions?.length ?? 0) === 0);
    await cwd.check(); await onStarted?.({ client: 'claude', sessionId, model: 'claude-opus-5-5', ephemeral: true });
    transport.send({ type: 'user', message: { role: 'user', content: JSON.stringify({ kind: 'untrusted-conversation', input }) } });
    let sawInit = false, result;
    while (!result) {
      const value = await transport.next();
      if (value.type === 'system' && value.subtype === 'init') {
        requireClient(value.session_id === sessionId && value.model === 'claude-opus-5-5' && value.permissionMode === 'dontAsk' && sameNames(value.tools, tools) && value.slash_commands?.length === 0 && value.skills?.length === 0 && value.additional_directories?.length === 0);
        requireClient((value.plugins ?? []).every(plugin => plugin.path === 'builtin' && builtinPlugins.includes(plugin.name))); sawInit = true;
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
