import { randomUUID } from 'node:crypto';
import { processingControlCall } from '../processing-control-proof.mjs';
import { canonicalJSON, digest } from '../workflow-values.mjs';

// One synthetic Codex control turn in the shapes Codex CLI 0.163 records:
// typed input (`menu`: the `$` list's mention plus its selection item; `block`:
// the older skill part; `typed`: the mention typed by hand; `plain`: the
// person's own words with no skill and no mention), the control call
// (`code`: the two cells of the verification handshake, optionally finished by
// `wait` calls; `direct`: one MCP function call), commentary and the final
// reply. Rows have no ordinals or timestamps; fixtures add them. The receipt
// fields are what the control server records for exactly this turn. Typed text
// that is no exact control calls `calledTool`, as a model might.
export const MENU_MENTION = '$cuefluent-notes:cuefluent-notes';
export const HAND_MENTION = '$cuefluent-notes';
export const handshakeResult = retryToken => ({ content: [{ type: 'text', text: canonicalJSON({ interfaceVersion: 1,
  status: 'verification-required', retryToken, instruction: 'Synthetic handshake instruction.' }) }], isError: false });
export const framing = (status = 'Script completed') => `${status}\nWall time 0.1 seconds\nOutput:\n`;
// The error message Codex CLI 0.163 records for a call the server refused with a
// JSON-RPC error: its context line, rmcp's code and message with the error's
// data, and anyhow's four-space indent on every further line.
export const codexToolError = (tool, message, { server = 'cuefluent_control', code = -32600, data = { code: 'PROCESSING_CONTROL_SOURCE_UNVERIFIED' } } = {}) =>
  `tool call error: tool call failed for \`${server}/${tool}\`\n\nCaused by:\n    Mcp error: ${code}: ${message.split('\n').join('\n    ')}${data ? `(${JSON.stringify(data)})` : ''}`;

export function codexControlTurn({ sessionId, unitId, skillPath, control = 'review', form = 'menu', mode = 'code', waits = 0,
  commentary = [], statusText = 'Cuefluent: Draft t7xb88 is ready. Review folder: /private/review/t7xb88',
  firstTurn = false, server = 'cuefluent_control', calledTool = 'processing_review' } = {}) {
  const evt = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
  const item = value => evt('item_completed', { thread_id: sessionId, turn_id: unitId, item: value });
  const response = (payload, kinds, metadata) => ({ type: 'response_item', payload: { ...payload,
    internal_chat_message_metadata_passthrough: { turn_id: unitId, ...(kinds ? { content_item_kinds: kinds } : {}) } },
    ...(metadata ? { metadata } : {}) });
  const assistant = (id, text, phase) => [item({ type: 'AgentMessage', id, content: [{ type: 'Text', text }], phase }),
    response({ type: 'message', status: 'completed', id, role: 'assistant', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }], phase })];
  // Typed text that is no exact control still makes the model call a tool.
  const call = processingControlCall(control) ?? { tool: calledTool, fields: {} }, tool = call.tool;
  // Codex calls carry no review or status fields; only a process scope.
  const args = tool === 'process_selected_captures' && call.fields.scope ? { scope: call.fields.scope } : {};
  const result = { content: [{ type: 'text', text: canonicalJSON({ interfaceVersion: 1, status: 'awaiting-review', statusText }) }], isError: false };
  const text = form === 'menu' ? `${MENU_MENTION} ${control}` : form === 'typed' ? `${HAND_MENTION} ${control}` : control;
  const content = form === 'block' ? [{ type: 'skill', name: 'cuefluent-notes', path: skillPath }, { type: 'text', text, text_elements: [] }]
    : [{ type: 'text', text, text_elements: form === 'menu' ? [{ byte_range: { start: 0, end: Buffer.byteLength(MENU_MENTION) }, placeholder: MENU_MENTION }] : [] }];
  const rows = [evt('task_started', { turn_id: unitId, root_turn_id: unitId, started_at: 1790000000 }),
    { type: 'turn_context', payload: { turn_id: unitId, root_turn_id: unitId } },
    ...(firstTurn ? [response({ type: 'message', id: 'msg-developer', role: 'developer', content: [{ type: 'input_text', text: 'Synthetic developer instructions.' }] },
      ['generic.developer_instructions']),
    response({ type: 'message', id: 'msg-context', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions (synthetic)' },
      { type: 'input_text', text: '<environment_context>synthetic</environment_context>' }] }, ['agents_md.instructions', 'environments.environment_context']),
    evt('thread_settings_applied', { thread_id: sessionId, thread_settings: { model: 'synthetic' } })] : []),
    response({ type: 'message', id: 'msg-user', role: 'user', content: [{ type: 'input_text', text }] }, ['user.text'],
      { client_authored: false, user_input_order: 0 }),
    item({ type: 'UserMessage', id: 'user-message', client_id: 'synthetic-client', content }),
    response({ type: 'message', id: 'msg-hook', role: 'developer', content: [{ type: 'input_text', text: 'Cuefluent Notes: collection status queued.' }] },
      ['hooks.additional_context']),
    ...(form === 'menu' ? [response({ type: 'message', id: 'msg-selection', role: 'user', content: [{ type: 'input_text',
      text: `<skill>\n<name>cuefluent-notes:cuefluent-notes</name>\n<path>${skillPath}</path>\nSYNTHETIC SKILL INSTRUCTIONS\n</skill>` }] },
    ['skills.selected_skill_instructions'])] : []),
    ...commentary.flatMap((value, index) => assistant(`msg-commentary-${index}`, value, 'commentary'))];
  const receipt = { tool: `mcp__${server}.${tool}`, argsHash: digest(canonicalJSON(args)), resultHash: digest(canonicalJSON(result)), statusText, skillPath };
  const usage = () => ({ type: 'token_usage_record', payload: { thread_id: sessionId, session_id: sessionId, turn_id: unitId, root_turn_id: unitId } });
  if (mode === 'direct') {
    rows.push(response({ type: 'function_call', id: 'fc-control', call_id: 'dispatch-call', namespace: `mcp__${server}`, name: tool, arguments: JSON.stringify(args) }),
      usage(), item({ type: 'McpToolCall', id: 'dispatch-call', server, tool, arguments: args, status: 'completed', result }),
      response({ type: 'function_call_output', id: 'fco-control', call_id: 'dispatch-call', output: [
        { type: 'input_text', text: 'Wall time: 0.003 seconds\nOutput:' }, { type: 'input_text', text: result.content[0].text }] }));
    Object.assign(receipt, { callId: 'dispatch-call' });
  } else {
    const token = randomUUID(), handshake = handshakeResult(token), first = `exec-${randomUUID()}`, second = `exec-${randomUUID()}`;
    const cell = (id, callId, input) => response({ type: 'custom_tool_call', id, status: 'completed', call_id: callId, name: 'exec', input });
    const output = (type, callId, value) => response({ type, id: `out-${callId}`, call_id: callId, output: value }, undefined, { client_authored: false });
    const printed = value => [{ type: 'input_text', text: framing() }, { type: 'input_text', text: JSON.stringify(value) }];
    rows.push(cell('ctc_first', 'call_cell_1', `text(await tools.mcp__${server}__${tool}(${JSON.stringify(args)}));\n`), usage(),
      item({ type: 'McpToolCall', id: first, server, tool, arguments: args, pluginId: 'cuefluent-notes@synthetic', readOnlyHint: false,
        status: 'completed', result: handshake, duration: { secs: 0, nanos: 1000 } }),
      output('custom_tool_call_output', 'call_cell_1', printed(handshake)), evt('token_count', { info: null }),
      cell('ctc_second', 'call_cell_2', `text(await tools.mcp__${server}__${tool}(${JSON.stringify({ ...args, retryToken: token })}));\n`), usage());
    const retry = item({ type: 'McpToolCall', id: second, server, tool, arguments: { ...args, retryToken: token }, pluginId: 'cuefluent-notes@synthetic',
      readOnlyHint: false, status: 'completed', result, duration: { secs: 2, nanos: 0 } });
    if (!waits) rows.push(retry, output('custom_tool_call_output', 'call_cell_2', printed(result)));
    else {
      rows.push(output('custom_tool_call_output', 'call_cell_2', framing('Script running with cell ID 4')));
      for (let index = 0; index < waits; index++) {
        const last = index === waits - 1;
        if (last) rows.push(retry);
        rows.push(response({ type: 'function_call', status: 'completed', id: `fc-wait-${index}`, name: 'wait', call_id: `call_wait_${index}`,
          arguments: JSON.stringify({ cell_id: '4', max_tokens: 3000, yield_time_ms: 1000 }) }, undefined, { client_authored: false }),
        output('function_call_output', `call_wait_${index}`, last ? printed(result) : [{ type: 'input_text', text: framing('Script running with cell ID 4') }]));
      }
    }
    Object.assign(receipt, { callId: first, outerItemId: 'ctc_first', retryItemId: 'ctc_second', retryCallId: second,
      handshakeResultHash: digest(canonicalJSON(handshake)) });
  }
  rows.push(evt('token_count', { info: null }), ...assistant('msg-final', statusText, 'final_answer'), usage(),
    evt('task_complete', { turn_id: unitId, root_turn_id: unitId, last_agent_message: statusText }));
  return { rows, receipt, result, args, tool, text };
}
