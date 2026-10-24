import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), client = process.env.FIXTURE_CLIENT, mode = process.env.FIXTURE_MODE;
const record = value => appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
record({ arguments: args, tokenPresent: process.env.CUEFLUENT_DRAFT_BRIDGE_TOKEN === 'SYNTHETIC_SECRET', nestedFlag: process.env.CLAUDECODE ?? null, effortOverride: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null });
const tools = ['mcp__cuefluent__notes_read', 'mcp__cuefluent__draft_write'];
const sessionId = args[args.indexOf('--session-id') + 1];
let pending = 0;
if (client === 'codex') {
  const home = path.join(path.dirname(process.env.FIXTURE_TRACE), 'native-profile');
  const provider = 'synthetic_foundry', configuredModel = 'team-production-deployment';
  const config = { model_provider: provider, model: configuredModel, cli_auth_credentials_store: 'keyring',
    model_providers: { [provider]: { base_url: 'https://synthetic-provider.invalid',
      auth: { command: 'synthetic-native-auth-helper', args: ['SYNTHETIC_PROVIDER_CREDENTIAL'] } } },
    mcp_servers: { existing_toolbox: { command: 'synthetic-toolbox' }, cuefluent: { command: 'synthetic-other-server' } },
    permissions: { cuefluent_processing: { network: { enabled: true } } } };
  const featureNames = ['hooks', 'plugins', 'remote_plugin', 'apps', 'goals', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'view_image',
    'browser_use', 'computer_use', 'image_generation', 'code_mode', 'memories', 'skill_search', 'skill_mcp_dependency_install',
    'tool_suggest', 'request_permissions_tool', 'workspace_dependencies', 'shell_snapshot', 'skip_host_skill_discovery',
    'secret_auth_storage', 'api_key_model_discovery', 'enable_request_compression', 'unbounded_connection_retries',
    'respect_system_proxy', 'system_proxy_fallback', 'unified_exec', 'synthetic_future_tool'];
  const baseline = featureNames.map(name => ({ name, enabled: name !== 'skip_host_skill_discovery' && name !== 'system_proxy_fallback', stage: 'stable' }));
  let started, ownServer, policyReads = 0;
  const setting = name => {
    const option = args.find(value => value.startsWith(`${name}=`));
    return option === undefined ? null : JSON.parse(option.slice(name.length + 1));
  };
  const settings = () => ({ cwd: started.cwd, approvalPolicy: started.approvalPolicy, approvalsReviewer: started.approvalsReviewer,
    model: started.model ?? configuredModel, modelProvider: mode === 'wrong-provider' ? 'openai' : provider,
    reasoningEffort: setting('model_reasoning_effort'), sandbox: { type: 'readOnly', networkAccess: false },
    activePermissionProfile: { id: mode === 'wrong-profile' ? 'cuefluent_processing' : started.permissions, extends: null } });
  const notify = (method, params) => send({ method, params });
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    const value = JSON.parse(line), { method, params = {} } = value;
    if (!method || method === 'initialized') return;
    record({ method, params, clientVersion: params.clientInfo?.version ?? null });
    let result;
    if (method === 'initialize') result = { userAgent: 'Codex/0.164.0', codexHome: home };
    if (method === 'configRequirements/read') result = { requirements: mode === 'managed' ? {} : null };
    if (method === 'config/read') {
      if (mode === 'config-warning') notify('configWarning', { summary: 'Synthetic configuration warning.' });
      result = { config };
    }
    if (method === 'experimentalFeature/list') {
      const data = baseline.map(feature => ({ ...feature }));
      if (params.threadId) {
        policyReads++;
        for (const feature of data) {
          const override = started.config[`features.${feature.name}`];
          if (override !== undefined) feature.enabled = override;
          if (feature.name === 'unified_exec') feature.enabled = true;
          if (mode === 'hooks' && feature.name === 'hooks' || mode === 'future-tool' && feature.name === 'synthetic_future_tool' ||
              mode === 'postflight-feature' && policyReads > 1 && feature.name === 'shell_tool') feature.enabled = true;
        }
      }
      result = { data, nextCursor: null };
    }
    if (method === 'command/exec') {
      if (!['darwin', 'win32'].includes(process.platform)) result = { exitCode: 0, stdout: JSON.stringify({ read: mode !== 'canary', write: true, outsideWrite: true, network: true }), stderr: '' };
      else if (/curl(?:\.exe)?$/.test(params.command[0])) result = { exitCode: 7, stdout: '', stderr: 'Synthetic network denied.' };
      else if (params.env?.CUEFLUENT_CANARY_FILE?.includes('.cuefluent-readable') || (params.command[0] === '/bin/cat' && params.command[1].includes('.cuefluent-readable'))) result = { exitCode: 0, stdout: 'CUEFLUENT_CANARY_READABLE', stderr: '' };
      else result = mode === 'canary' ? { exitCode: 0, stdout: 'SYNTHETIC CANARY ESCAPED', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'Synthetic access denied.' };
    }
    if (method === 'thread/start') {
      started = params; ownServer = Object.keys(params.config.mcp_servers).find(name => !Object.hasOwn(config.mcp_servers, name));
      result = { ...settings(), thread: { id: 'synthetic-codex', sessionId: mode === 'wrong-session' ? 'unrelated-session' : 'synthetic-codex',
        ephemeral: mode !== 'persistent', path: mode === 'persistent' ? path.join(home, 'sessions', 'synthetic.jsonl') : null,
        forkedFromId: null, parentThreadId: null, status: { type: 'idle' } },
        instructionSources: mode === 'global-guidance' ? [path.join(home, 'AGENTS.md'), path.join(home, 'AGENTS.override.md')] :
          mode === 'project-guidance' ? [path.join(params.cwd, 'AGENTS.md')] : [] };
    }
    if (method === 'mcpServerStatus/list') {
      const data = Object.keys(config.mcp_servers).map(name => ({ name,
        runtimeStatus: started.config.mcp_servers[name]?.enabled === false && mode !== 'inherited-active' ? 'disabled' : 'connected',
        tools: {}, resources: [], resourceTemplates: [] }));
      const ownTools = started.config.mcp_servers[ownServer].enabled_tools;
      data.push({ name: ownServer, runtimeStatus: 'connected', pluginId: null, toolsError: null,
        tools: Object.fromEntries([...ownTools, ...(mode === 'extra-tool' ? ['shell'] : [])].map(name => [name, { name }])),
        resources: mode === 'mcp-resource' ? [{ uri: 'synthetic://unexpected' }] : [], resourceTemplates: [] });
      if (mode === 'extra-mcp') data.push({ name: 'unadvertised', runtimeStatus: 'connected', tools: {}, resources: [], resourceTemplates: [] });
      result = { data, nextCursor: null };
    }
    if (method === 'turn/start') result = { turn: { id: 'synthetic-turn', status: 'inProgress' } };
    send({ id: value.id, result });
    if (method !== 'turn/start') return;
    record({ sourceReceived: JSON.stringify(params.input).includes('SOURCE_SENTINEL') });
    const identity = { threadId: mode === 'wrong-thread-event' ? 'unrelated-thread' : 'synthetic-codex', turnId: mode === 'wrong-turn-event' ? 'unrelated-turn' : 'synthetic-turn' };
    notify('turn/started', { ...identity, turn: { id: identity.turnId, status: 'inProgress' } });
    if (mode === 'slow') return;
    if (mode === 'retry' || mode === 'terminal-error') notify('error', { ...identity, willRetry: mode === 'retry', error: { message: 'Synthetic transport failure.' } });
    if (mode === 'interactive-request') send({ id: 'synthetic-approval', method: 'item/commandExecution/requestApproval', params: identity });
    if (mode === 'settings-drift' || mode === 'settings-unchanged') {
      const { sandbox, reasoningEffort, ...rest } = settings();
      notify('thread/settings/updated', { threadId: identity.threadId, threadSettings: { ...rest, sandboxPolicy: sandbox,
        effort: reasoningEffort, ...(mode === 'settings-drift' ? { model: 'unrequested-deployment' } : {}) } });
    }
    if (mode === 'long-turn-lifecycle' || mode === 'oversized-plan') {
      const compaction = { id: 'synthetic-compaction', type: 'contextCompaction' };
      notify('item/started', { ...identity, item: compaction });
      notify('item/completed', { ...identity, item: compaction });
      notify('item/started', { ...identity, item: { id: 'synthetic-plan', type: 'plan', text: '' } });
      notify('item/completed', { ...identity, item: { id: 'synthetic-plan', type: 'plan',
        text: mode === 'oversized-plan' ? 'é'.repeat(128 * 1024 + 1) : 'Continue drafting after native context compaction.' } });
    }
    if (mode === 'unknown-item') notify('item/completed', { ...identity, item: { id: 'synthetic-unknown', type: 'unrecognizedCapability' } });
    notify('item/completed', { ...identity, item: mode === 'shell-event' ? { type: 'commandExecution', command: 'synthetic-command' } :
      { type: 'mcpToolCall', server: mode === 'foreign-tool' ? 'existing_toolbox' : ownServer, tool: 'draft_write' } });
    notify('item/completed', { ...identity, item: { type: 'agentMessage', text: 'COMPLETE' } });
    notify('turn/completed', { ...identity, turn: { id: identity.turnId, status: mode === 'failed-turn' ? 'failed' : 'completed' } });
  });
} else {
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    const value = JSON.parse(line), method = client === 'claude' ? value.request?.subtype : value.method;
    if (value.type === 'user') {
      record({ sourceReceived: value.message.content.includes('SOURCE_SENTINEL') });
      send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5', permissionMode: 'dontAsk', tools, slash_commands: [], skills: [], plugins: mode === 'builtin' ? [{ name: 'cc-plugin-sec-default', path: 'builtin' }] : mode === 'external-plugin' ? [{ name: 'unexpected', path: '/synthetic/plugin' }] : [], ...(mode === 'builtin' ? {} : { additional_directories: [] }) });
      if (mode === 'slow') return;
      send({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false, permission_denials: [], result: 'COMPLETE' }); return;
    }
    if (!method || method === 'initialized') return;
    record({ method, clientVersion: value.params?.clientInfo?.version ?? null }); let result;
    if (method === 'initialize') result = client === 'claude' ? { claude_code_version: mode === 'updated' ? '2.1.308' : mode === 'old-version' ? '2.1.306' : mode === 'new-major' ? '3.0.0' : '2.1.307', current_permission_mode: 'dontAsk' } : { userAgent: 'Codex/0.163.0' };
    if (method === 'get_settings') result = { effective: { disableAllHooks: mode !== 'hooks', autoMemoryEnabled: false, enabledPlugins: {} }, sources: [{ source: mode === 'managed' ? 'policySettings' : 'flagSettings' }], applied: { model: 'claude-opus-5-5', effort: mode === 'effort-cap' ? 'medium' : process.env.CLAUDE_CODE_EFFORT_LEVEL ?? 'high' } };
    if (method === 'mcp_status') result = { mcpServers: [{ name: 'cuefluent', source: 'dynamic', status: mode === 'pending' && pending++ === 0 ? 'pending' : 'connected', tools: [{ name: 'notes_read' }, { name: 'draft_write' }, ...(mode === 'extra-tool' ? [{ name: 'shell' }] : [])] }] };
    if (method === 'get_context_usage') result = { memoryFiles: mode === 'memory' ? [{ path: 'synthetic-private-instructions' }] : [], mcpTools: tools.map(name => ({ name })), mcpInstructions: [], systemTools: mode === 'builtin-tool' ? [{ name: 'Bash' }] : [] };
    if (client === 'claude') send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: result } });
    else send({ id: value.id, result });
  });
}
