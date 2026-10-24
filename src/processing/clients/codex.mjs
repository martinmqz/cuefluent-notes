import { realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { JsonProcess, requireClient, boundedText, sameNames } from './protocol.mjs';
import { verifySandbox } from './canary.mjs';

const disabled = ['hooks', 'plugins', 'remote_plugin', 'apps', 'goals', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'view_image', 'browser_use', 'computer_use', 'image_generation', 'code_mode', 'memories', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'request_permissions_tool', 'workspace_dependencies', 'shell_snapshot'];
// These native transport switches provide no model tools. Preserve the user's
// proxy, credential-store, catalog and retry behavior with their provider.
const connectionFeatures = new Set(['secret_auth_storage', 'api_key_model_discovery', 'enable_request_compression', 'unbounded_connection_retries', 'respect_system_proxy', 'system_proxy_fallback']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => boundedText(value, 256) && value.length > 0 && !/\s|\p{Cc}/u.test(value);
const toml = value => JSON.stringify(value); // Fixed strings use JSON/TOML-compatible escapes.
const retired = feature => ['removed', 'deprecated'].includes(feature.stage);

export async function codexConfiguration(executable, cwd, effort = 'high', profile = 'cuefluent_processing') {
  requireClient(['darwin', 'linux', 'win32'].includes(process.platform) && /^[a-z][a-z0-9_]{0,63}$/.test(profile));
  const roots = [':minimal', cwd, executable, await realpath(process.execPath)];
  if (process.platform === 'win32') roots.push(await realpath(process.env.SystemRoot));
  const read = Object.fromEntries(roots.map(value => [value, 'read']));
  const filesystem = `{${Object.entries(read).map(([key, value]) => `${toml(key)}=${toml(value)}`).join(',')}}`;
  const settings = [`model_reasoning_effort=${toml(effort)}`, 'approval_policy="never"', 'approvals_reviewer="user"', `default_permissions=${toml(profile)}`, `permissions.${profile}.filesystem=${filesystem}`, `permissions.${profile}.network.enabled=false`, 'web_search="disabled"', 'notify=[]', 'project_doc_max_bytes=0', 'developer_instructions=""', 'skills.include_instructions=false', 'tools.update_plan.enabled=false', 'tools.experimental_request_user_input.enabled=false'];
  if (process.platform === 'win32') settings.push('windows.sandbox="mxc"');
  return ['--strict-config', ...disabled.flatMap(feature => ['--disable', feature]), ...settings.flatMap(value => ['-c', value])];
}

async function inventory(transport, method, params = {}, maximum = 512) {
  const values = [], cursors = new Set(); let cursor = null;
  do {
    const page = await transport.request(method, { ...params, limit: 100, cursor });
    requireClient(object(page) && Array.isArray(page.data) && values.length + page.data.length <= maximum);
    values.push(...page.data); cursor = page.nextCursor;
    requireClient(cursor === null || boundedText(cursor, 4096) && cursor.length > 0 && !cursors.has(cursor));
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return values;
}

function featureMap(features) {
  const result = new Map();
  for (const feature of features) {
    requireClient(object(feature) && /^[a-z][a-z0-9_.]{0,99}$/.test(feature.name) && !result.has(feature.name) && typeof feature.enabled === 'boolean' && typeof feature.stage === 'string');
    result.set(feature.name, feature);
  }
  for (const name of [...disabled, 'skip_host_skill_discovery']) requireClient(result.has(name) && !retired(result.get(name)));
  return result;
}

function checkSettings(settings, { cwd, profile, model, provider, effort }) {
  requireClient(settings?.cwd === cwd && settings.approvalPolicy === 'never' && settings.approvalsReviewer === 'user' &&
    settings.sandbox?.type === 'readOnly' && settings.sandbox.networkAccess === false &&
    settings.activePermissionProfile?.id === profile && settings.activePermissionProfile.extends == null &&
    token(settings.model) && settings.modelProvider === provider && (!model || settings.model === model) && settings.reasoningEffort === effort);
}

async function checkPolicy(transport, threadId, expectedFeatures, serverName, mcp, inheritedServers) {
  const features = featureMap(await inventory(transport, 'experimentalFeature/list', { threadId }));
  requireClient(sameNames([...features.keys()], [...expectedFeatures.keys()]));
  for (const [name, feature] of features) {
    requireClient(feature.stage === expectedFeatures.get(name).stage);
    if (retired(feature)) continue;
    // Native unified_exec is always enabled. shell_tool remains disabled;
    // a command execution event is still a policy failure.
    const expected = name === 'skip_host_skill_discovery' || name === 'unified_exec' ? true : connectionFeatures.has(name) ? expectedFeatures.get(name).enabled : false;
    requireClient(feature.enabled === expected);
  }
  const servers = await inventory(transport, 'mcpServerStatus/list', { threadId }, 256);
  requireClient(sameNames(servers.map(server => server.name), [...inheritedServers, serverName]));
  for (const server of servers) {
    requireClient(object(server.tools) && Array.isArray(server.resources) && server.resources.length === 0 && Array.isArray(server.resourceTemplates) && server.resourceTemplates.length === 0);
    if (server.name === serverName) {
      requireClient(server.runtimeStatus === 'connected' && server.pluginId == null && server.toolsError == null &&
        sameNames(Object.values(server.tools).map(tool => tool?.name), mcp.tools));
    } else requireClient(server.runtimeStatus === 'disabled' && Object.keys(server.tools).length === 0);
  }
}

/** Native config stays inside the native client: no provider/auth projection,
 * alternate home, credential copy or config write. Session restrictions are
 * ephemeral overrides, verified before conversation input is submitted. */
export async function runCodex(options, dependencies) {
  const { executable, cwd, mcp, model, effort, prompt, input, signal, onStarted } = options;
  // Unique names prevent inherited tables from merging into our permissions or
  // draft server. Native config merges tables rather than replacing them.
  const suffix = randomBytes(10).toString('hex'), profile = `cuefluent_processing_${suffix}`, serverName = `cuefluent_${suffix}`;
  const configuration = await codexConfiguration(executable, cwd.path, effort, profile);
  const transport = new JsonProcess(executable, ['app-server', ...configuration], { cwd: cwd.path, env: { ...process.env, ...mcp.env }, signal, ...dependencies });
  const observed = new Set(['error', 'warning', 'turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/settings/updated', 'mcpServer/startupStatus/updated']);
  transport.onMessage = value => {
    if (value.method === 'configWarning') { transport.reject('PROCESSING_ISOLATION_UNSUPPORTED'); return true; }
    if (value.method && value.id !== undefined) {
      transport.send({ id: value.id, error: { code: -32601, message: 'No interactive capabilities are available.' } });
      transport.reject('PROCESSING_ISOLATION_UNSUPPORTED'); return true;
    }
    return value.method !== undefined && !observed.has(value.method);
  };
  try {
    const initialized = await transport.request('initialize', { clientInfo: { name: 'cuefluent_processing', version: options.version }, capabilities: { experimentalApi: true } });
    requireClient(typeof initialized?.userAgent === 'string' && typeof initialized.codexHome === 'string' && path.isAbsolute(initialized.codexHome));
    transport.send({ method: 'initialized', params: {} });
    requireClient((await transport.request('configRequirements/read', {}))?.requirements === null);
    const { config } = await transport.request('config/read', { cwd: cwd.path, includeLayers: false });
    requireClient(object(config) && (config.mcp_servers == null || object(config.mcp_servers)));
    const inheritedServers = Object.keys(config.mcp_servers ?? {});
    requireClient(inheritedServers.length < 256 && !inheritedServers.includes(serverName));
    const expectedFeatures = featureMap(await inventory(transport, 'experimentalFeature/list'));
    const restrictions = { 'agents.enabled': false, 'apps._default.enabled': false };
    for (const [name, feature] of expectedFeatures) if (!retired(feature) && !connectionFeatures.has(name)) restrictions[`features.${name}`] = name === 'skip_host_skill_discovery';
    restrictions.mcp_servers = Object.fromEntries(inheritedServers.map(name => [name, { enabled: false }]));
    restrictions.mcp_servers[serverName] = { command: mcp.command, args: mcp.args, env_vars: Object.keys(mcp.env),
      enabled: true, required: true, enabled_tools: mcp.tools, default_tools_approval_mode: 'approve' };
    const provider = config.model_provider ?? 'openai', requestedModel = model ?? config.model ?? undefined;
    requireClient(token(provider) && (requestedModel === undefined || token(requestedModel)));
    await verifySandbox(transport, cwd.path, profile); await cwd.check();
    const start = await transport.request('thread/start', { cwd: cwd.path, config: restrictions, ...(model ? { model } : {}),
      approvalPolicy: 'never', approvalsReviewer: 'user', permissions: profile, baseInstructions: prompt, developerInstructions: '',
      ephemeral: true, selectedCapabilityRoots: [], environments: [], runtimeWorkspaceRoots: [] });
    const thread = start?.thread, policy = { cwd: cwd.path, profile, model: requestedModel, provider, effort };
    checkSettings(start, policy);
    requireClient(token(thread?.id) && thread.sessionId === thread.id && thread.ephemeral === true && thread.path == null &&
      thread.forkedFromId == null && thread.parentThreadId == null && thread.status?.type === 'idle');
    // Native global user guidance is allowed; project/model-file instructions
    // are not. Guidance cannot change queue selection or note-save authority.
    const globalGuidance = ['AGENTS.md', 'AGENTS.override.md'].map(name => path.join(initialized.codexHome, name));
    requireClient(Array.isArray(start.instructionSources) && start.instructionSources.length <= 2 && start.instructionSources.every(file => globalGuidance.includes(file)));
    await checkPolicy(transport, thread.id, expectedFeatures, serverName, mcp, inheritedServers); await cwd.check();
    await onStarted?.({ client: 'codex', sessionId: thread.id, model: start.model, ephemeral: true });
    const begun = await transport.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: JSON.stringify({ kind: 'untrusted-conversation', input }), text_elements: [] }] });
    const turnId = begun?.turn?.id; requireClient(token(turnId));
    let completed = false, finalText = '';
    while (!completed) {
      const { method, params } = await transport.next();
      requireClient(object(params));
      if (method === 'warning') { await checkPolicy(transport, thread.id, expectedFeatures, serverName, mcp, inheritedServers); continue; }
      requireClient(params.threadId === thread.id);
      if (method === 'thread/settings/updated') {
        const settings = params.threadSettings;
        checkSettings({ ...settings, sandbox: settings?.sandboxPolicy, reasoningEffort: settings?.effort }, { ...policy, model: start.model }); continue;
      }
      if (method === 'mcpServer/startupStatus/updated') { await checkPolicy(transport, thread.id, expectedFeatures, serverName, mcp, inheritedServers); continue; }
      requireClient((params.turnId ?? params.turn?.id) === turnId);
      if (method === 'error') { requireClient(params.willRetry === true, 'PROCESSING_CLIENT_FAILED'); continue; }
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item; requireClient(object(item));
        requireClient(['userMessage', 'agentMessage', 'reasoning', 'mcpToolCall', 'contextCompaction', 'plan'].includes(item.type));
        if (item.type === 'mcpToolCall') requireClient(item.server === serverName && mcp.tools.includes(item.tool));
        if (method === 'item/completed' && item.type === 'agentMessage') {
          requireClient(boundedText(item.text, 256 * 1024), 'PROCESSING_PROTOCOL_LIMIT'); finalText = item.text;
        }
        if (method === 'item/completed' && item.type === 'plan') requireClient(boundedText(item.text, 256 * 1024), 'PROCESSING_PROTOCOL_LIMIT');
      }
      if (method === 'turn/completed') { requireClient(params.turn.status === 'completed', 'PROCESSING_CLIENT_FAILED'); completed = true; }
    }
    await checkPolicy(transport, thread.id, expectedFeatures, serverName, mcp, inheritedServers); await cwd.check();
    const exit = await transport.finish(); requireClient(exit.code === 0, 'PROCESSING_CLIENT_FAILED');
    return Object.freeze({ client: 'codex', sessionId: thread.id, model: start.model, status: 'completed', finalText });
  } finally { await transport.dispose(); }
}
