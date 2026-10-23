// Synthetic protocol peer for deterministic smoke-harness tests only.
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const [mode] = process.argv.slice(2), trace = process.env.CUEFLUENT_SMOKE_TRACE;
const record = value => fs.appendFileSync(trace, `${JSON.stringify(value)}\n`);
record({ environment: Object.keys(process.env), args: process.argv.slice(2), ...(process.platform === 'win32' ? { windowsProfile: { homePairMatchesDisposableProfile: process.env.HOMEDRIVE + process.env.HOMEPATH === process.env.USERPROFILE, blankIdentity: process.env.USERDOMAIN === '' && process.env.USERNAME === '' && process.env.LOGONSERVER === '' } } : {}) });
if (mode === 'fail') process.exit(7);
else if (mode === 'output') process.stdout.write('x'.repeat(65536));
else if (mode === 'wait') setInterval(() => {}, 1000);
else if (mode === 'command') console.log('Synthetic CLI output.');
else {
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    const value = JSON.parse(line), method = mode === 'claude' ? value.request?.subtype : value.method;
    record({ method, user: value.type === 'user' });
    if (!method || method === 'initialized') return;
    let result;
    if (method === 'initialize') result = mode === 'claude' ? { claude_code_version: '2.1.309', current_permission_mode: 'dontAsk' } : { userAgent: 'Codex/0.163.0' };
    if (method === 'configRequirements/read') result = { requirements: process.env.CUEFLUENT_SMOKE_POLICY === 'bad' ? {} : null };
    if (method === 'get_settings') result = { effective: { disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {} }, sources: [{ source: 'flagSettings' }], applied: { model: 'claude-opus-5-5', effort: 'high' } };
    if (method === 'mcp_status') result = { mcpServers: [{ name: 'cuefluent_smoke', status: 'connected', source: 'dynamic', tools: [{ name: 'notes_read' }, { name: 'draft_write' }] }] };
    if (method === 'get_context_usage') result = { memoryFiles: [], deferredBuiltinTools: [], systemTools: [], mcpInstructions: [], mcpTools: ['notes_read', 'draft_write'].map(name => ({ name: `mcp__cuefluent_smoke__${name}` })) };
    if (mode === 'claude') send({ type: 'control_response', response: { request_id: value.request_id, subtype: 'success', response: result } });
    else send({ id: value.id, result });
  });
}
