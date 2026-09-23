import { CLIENTS } from './capture-policy.mjs';

export function hookCommand(client) {
  if (!CLIENTS.has(client)) throw new Error('Choose a supported hook client.');
  // Shell-independent bootstrap: only fixed code enters the shell. Node reads
  // the exported path after parsing, so neither host preprocessing nor shell
  // expansion can interpret characters in a Windows or POSIX plugin path.
  const variable = client === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
  return `node -e "Promise.resolve().then(()=>{if(Number(process.versions.node.split('.')[0])<22)throw Object.assign(Error(),{code:'NODE_22_REQUIRED'});const p=require('node:path'),r=process.env.${variable};if(r&&p.isAbsolute(r)&&p.resolve(r)===p.join(r,'.')){return import(require('node:url').pathToFileURL(p.join(r,'skills/cuefluent-notes/scripts/hooks.mjs')).href)}throw Object.assign(Error(),{code:'INVALID_PLUGIN_ROOT'})}).then(m=>m.main(['${client}'])).then(code=>{process.exitCode=code}).catch(e=>{const c=['NODE_22_REQUIRED','INVALID_PLUGIN_ROOT','ERR_MODULE_NOT_FOUND','ENOENT','EACCES','EPERM'].includes(e.code)?e.code:e.name==='SyntaxError'?'INVALID_PLUGIN_JAVASCRIPT':'STARTUP_FAILURE';console.error('Cuefluent Notes hook could not start: '+c+'. Check Node 22+ and repair the plugin installation.');process.exitCode=1})"`;
}

export function validHookHandler(handler, client) {
  return handler?.type === 'command' && handler.command === hookCommand(client) &&
    handler.timeout === 10 && (handler.async === undefined || handler.async === false) &&
    Object.keys(handler).every(key => ['type', 'command', 'timeout', 'async'].includes(key));
}

export function hookConfiguration(client) {
  const handler = { type: 'command', command: hookCommand(client), timeout: 10 };
  return { hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [handler] }],
    UserPromptSubmit: [{ hooks: [handler] }],
    Stop: [{ hooks: [handler] }],
  } };
}
