import { realpath } from 'node:fs/promises';
import { JsonProcess, requireClient, boundedText } from './protocol.mjs';
import { verifySandbox } from './canary.mjs';

const disabled = ['hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'view_image', 'browser_use', 'computer_use', 'image_generation', 'code_mode', 'memories', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'request_permissions_tool', 'workspace_dependencies', 'shell_snapshot'];
const toml = value => JSON.stringify(value); // The fixed strings here have JSON/TOML-compatible escapes.

export async function codexConfiguration(executable, cwd, effort = 'high') {
  requireClient(['darwin', 'linux', 'win32'].includes(process.platform));
  const roots = [':minimal', cwd, executable, await realpath(process.execPath)];
  if (process.platform === 'win32') roots.push(await realpath(process.env.SystemRoot));
  const read = Object.fromEntries(roots.map(value => [value, 'read']));
  const filesystem = `{${Object.entries(read).map(([key, value]) => `${toml(key)}=${toml(value)}`).join(',')}}`;
  const settings = ['model_provider="openai"', `model_reasoning_effort=${toml(effort)}`, 'approval_policy="never"', 'approvals_reviewer="user"', 'default_permissions="cuefluent_processing"', `permissions.cuefluent_processing.filesystem=${filesystem}`, 'permissions.cuefluent_processing.network.enabled=false', 'web_search="disabled"', 'notify=[]', 'project_doc_max_bytes=0', 'developer_instructions=""', 'tools.update_plan.enabled=false', 'tools.experimental_request_user_input.enabled=false'];
  if (process.platform === 'win32') settings.push('windows.sandbox="mxc"'); // No legacy fallback or administrator setup.
  return ['--strict-config', ...disabled.flatMap(feature => ['--disable', feature]), ...settings.flatMap(value => ['-c', value])];
}

export async function runCodex(options, dependencies) {
  const { executable, cwd, mcp, model, effort, prompt, input, signal, onStarted } = options;
  const configuration = await codexConfiguration(executable, cwd.path, effort);
  // No thread is opened here: user MCP servers are not initialized. This
  // protocol reads managed requirement metadata, never user config or auth.
  const preflight = new JsonProcess(executable, ['app-server', ...configuration], { cwd: cwd.path, signal, ...dependencies });
  preflight.onMessage = value => {
    if (value.method === 'configWarning') { preflight.reject('PROCESSING_ISOLATION_UNSUPPORTED'); return true; }
    if (value.method && value.id !== undefined) { preflight.send({ id: value.id, error: { code: -32601, message: 'No interactive capabilities are available.' } }); return true; }
    return false;
  };
  try {
    const initialized = await preflight.request('initialize', { clientInfo: { name: 'cuefluent_processing', version: options.version }, capabilities: { experimentalApi: true } });
    requireClient(typeof initialized?.userAgent === 'string');
    preflight.send({ method: 'initialized', params: {} });
    const requirements = await preflight.request('configRequirements/read', {});
    requireClient(requirements?.requirements === null); // Unreviewed managed overrides are unsupported.
    await verifySandbox(preflight, cwd.path); await cwd.check();
    const exit = await preflight.finish(); requireClient(exit.code === 0, 'PROCESSING_CLIENT_FAILED');
  } finally { await preflight.dispose(); }
  const server = `mcp_servers.${mcp.name}`, mcpSettings = [
    `${server}.command=${toml(mcp.command)}`, `${server}.args=[${mcp.args.map(toml).join(',')}]`, `${server}.env_vars=[${Object.keys(mcp.env).map(toml).join(',')}]`, `${server}.required=true`, `${server}.enabled_tools=[${mcp.tools.map(toml).join(',')}]`, `${server}.default_tools_approval_mode="approve"`,
  ];
  const transport = new JsonProcess(executable, ['exec', ...configuration, '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--model', model, '--json', '-c', `instructions=${toml(prompt)}`, ...mcpSettings.flatMap(value => ['-c', value]), '-'], { cwd: cwd.path, env: { ...process.env, ...mcp.env }, signal, ...dependencies });
  try {
    // The native configuration is fixed and the OS floor has already passed a
    // source-free canary. exec has no pre-input init protocol.
    transport.child.stdin.end(JSON.stringify({ kind: 'untrusted-conversation', input }));
    let sessionId, completed = false, finalText = '';
    while (!completed) {
      const value = await transport.next();
      if (value.type === 'thread.started') {
        requireClient(!sessionId && typeof value.thread_id === 'string'); sessionId = value.thread_id;
        await onStarted?.({ client: 'codex', sessionId, model, ephemeral: true });
      }
      if (value.type === 'error' || value.type === 'turn.failed') requireClient(false, 'PROCESSING_CLIENT_FAILED');
      if (value.type === 'item.completed' && value.item?.type === 'agent_message') {
        requireClient(boundedText(value.item.text, 256 * 1024), 'PROCESSING_PROTOCOL_LIMIT'); finalText = value.item.text;
      }
      if (value.type === 'item.started' || value.type === 'item.completed') {
        const item = value.item;
        if (item?.type === 'mcp_tool_call') requireClient(item.server === mcp.name && mcp.tools.includes(item.tool));
        // Apply-patch can be listed by this client; the canary proves its
        // write operation cannot escape the read-only permission profile.
        if (['command_execution', 'web_search'].includes(item?.type)) requireClient(false);
      }
      if (value.type === 'turn.completed') { requireClient(sessionId); completed = true; }
    }
    const exit = await transport.finish(); requireClient(exit.code === 0, 'PROCESSING_CLIENT_FAILED');
    return Object.freeze({ client: 'codex', sessionId, model, status: 'completed', finalText });
  } finally { await transport.dispose(); }
}
