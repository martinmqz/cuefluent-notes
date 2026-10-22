import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2), client = process.env.FIXTURE_CLIENT, mode = process.env.FIXTURE_MODE;
const record = value => appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
record({ arguments: args, tokenPresent: process.env.CUEFLUENT_DRAFT_BRIDGE_TOKEN === 'SYNTHETIC_SECRET', nestedFlag: process.env.CLAUDECODE ?? null });
const tools = ['mcp__cuefluent__notes_read', 'mcp__cuefluent__draft_write'];
const sessionId = args[args.indexOf('--session-id') + 1];
let pending = 0;
if (client === 'codex' && args[0] === 'exec') {
  let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { input += value; });
  process.stdin.on('end', () => {
    record({ sourceReceived: input.includes('SOURCE_SENTINEL') }); send({ type: 'thread.started', thread_id: 'synthetic-codex' });
    if (mode === 'slow') { setInterval(() => {}, 10000); return; }
    send({ type: 'item.completed', item: { type: 'agent_message', text: 'COMPLETE' } });
    send({ type: 'turn.completed' });
  });
} else {
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    const value = JSON.parse(line), method = client === 'claude' ? value.request?.subtype : value.method;
    if (value.type === 'user') {
      record({ sourceReceived: value.message.content.includes('SOURCE_SENTINEL') });
      send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5', permissionMode: 'dontAsk', tools, slash_commands: [], skills: [], plugins: [], additional_directories: [] });
      if (mode === 'slow') return;
      send({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false, permission_denials: [], result: 'COMPLETE' }); return;
    }
    if (!method || method === 'initialized') return;
    record({ method }); let result;
    if (method === 'initialize') result = client === 'claude' ? { claude_code_version: '2.1.307', current_permission_mode: 'dontAsk' } : { userAgent: 'Codex/0.163.0' };
    if (method === 'get_settings') result = { effective: { disableAllHooks: mode !== 'hooks', autoMemoryEnabled: false, enabledPlugins: {} }, sources: [{ source: mode === 'managed' ? 'policySettings' : 'flagSettings' }], applied: { model: 'claude-opus-5-5', effort: 'high' } };
    if (method === 'mcp_status') result = { mcpServers: [{ name: 'cuefluent', source: 'dynamic', status: mode === 'pending' && pending++ === 0 ? 'pending' : 'connected', tools: [{ name: 'notes_read' }, { name: 'draft_write' }, ...(mode === 'extra-tool' ? [{ name: 'shell' }] : [])] }] };
    if (method === 'get_context_usage') result = { memoryFiles: mode === 'memory' ? [{ path: 'synthetic-private-instructions' }] : [], mcpTools: tools.map(name => ({ name })), mcpInstructions: [] };
    if (method === 'configRequirements/read') result = { requirements: mode === 'managed' ? {} : null };
    if (method === 'command/exec') {
      if (process.platform !== 'win32') result = { exitCode: 0, stdout: JSON.stringify({ read: mode !== 'canary', write: true, outsideWrite: true, network: true }), stderr: '' };
      else if (value.params.command[0].endsWith('curl.exe')) result = { exitCode: 7, stdout: '', stderr: 'Synthetic network denied.' };
      else if (value.params.env?.CUEFLUENT_CANARY_FILE?.includes('.cuefluent-readable')) result = { exitCode: 0, stdout: 'CUEFLUENT_CANARY_READABLE', stderr: '' };
      else result = mode === 'canary' ? { exitCode: 0, stdout: 'SYNTHETIC CANARY ESCAPED', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'Synthetic access denied.' };
    }
    if (client === 'claude') send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: result } });
    else send({ id: value.id, result });
  });
}
