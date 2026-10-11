import { choice, CLIENTS } from './workflow-values.mjs';

export function collectionHookBootstrap(client) {
  choice(client, CLIENTS);
  const variable = client === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
  // Only fixed code enters Codex's shell. Paths are read as environment data
  // after shell parsing. All plugin-controlled failures normalize to exit zero.
  return `const fail=()=>{console.error('Cuefluent Notes: collection unavailable; inspect workflow status.');process.exit(0)};process.on('uncaughtException',fail);process.on('unhandledRejection',fail);const timer=setTimeout(fail,2500);Promise.resolve().then(()=>{if(Number(process.versions.node.split('.')[0])<22)throw Error();const p=require('node:path'),r=process.env.${variable};if(!r||!p.isAbsolute(r)||p.resolve(r)!==p.join(r,'.'))throw Error();return import(require('node:url').pathToFileURL(p.join(r,'skills/cuefluent-notes/scripts/collection-hooks.mjs')).href)}).then(m=>m.main(['${client}'])).then(()=>{clearTimeout(timer);process.exit(0)}).catch(fail)`;
}
export function collectionHookConfiguration(client) {
  const bootstrap = collectionHookBootstrap(client);
  const handler = client === 'claude' ? { type: 'command', command: 'node', args: ['-e', bootstrap], timeout: 3 }
    : { type: 'command', command: `node -e "${bootstrap}"`, timeout: 3 };
  return { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', client === 'codex' ? 'Interrupt' : 'StopFailure']
    .map(event => [event, [{ hooks: [handler] }]])) };
}
