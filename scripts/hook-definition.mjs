import { CLIENTS } from './capture-policy.mjs';

export function hookCommand(client) {
  if (!CLIENTS.has(client)) throw new Error('Choose a supported hook client.');
  // Let the shell expand the quoted environment value. Codex substitutes the
  // braced spelling before shell parsing, which would turn path characters
  // such as '$' and backticks into shell syntax.
  const variable = client === 'codex' ? '$PLUGIN_ROOT' : '$CLAUDE_PLUGIN_ROOT';
  return `node "${variable}/skills/cuefluent-notes/scripts/hooks.mjs" ${client}`;
}

export function hookConfiguration(client) {
  const handler = { type: 'command', command: hookCommand(client), timeout: 10 };
  return { hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [handler] }],
    UserPromptSubmit: [{ hooks: [handler] }],
  } };
}
