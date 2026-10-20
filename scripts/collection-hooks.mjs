import { collectionIngress } from './collection-ingress.mjs';
import { isMain } from './file-io.mjs';

async function input(stream) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('HOOK_INPUT_LIMIT');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export function collectionHookOutput(result, event) {
  if (!['UserPromptSubmit', 'SessionStart'].includes(event) || ['disabled', 'unconfigured', 'excluded', 'manual'].includes(result.status)) return null;
  const identity = result.selection ? { client: result.selection.client, sessionId: result.selection.sessionId, unitId: result.selection.unitId } : null;
  const blocked = result.intakeBlocked === true || result.status === 'intake-blocked';
  const diagnostics = Array.isArray(result.notice?.diagnostics) ? result.notice.diagnostics : [];
  const own = diagnostics.find(item => item?.client === identity?.client && item?.sessionId === identity?.sessionId);
  const collectionReason = result.notice?.pending?.find(code => !diagnostics.some(item => item?.code === code) && code !== 'INTAKE_BLOCKED');
  const candidate = own?.code ?? collectionReason;
  const reason = typeof candidate === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(candidate) ? candidate : null;
  const excluded = result.notice?.boundaryExcluded?.find(item => item?.client === identity?.client && item?.sessionId === identity?.sessionId);
  const boundary = typeof excluded?.unitId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(excluded.unitId) ? excluded.unitId : null;
  const text = `Cuefluent Notes: ${blocked ? 'intake busy or blocked; retry after the current operation finishes. Inspect workflow status if it persists' : `capture status ${result.status}`}.
Use explicit session selection for capture controls; this client transport has no verified current-turn binding. Processing remains independent and must use an explicit command until live prompt delivery is verified.${reason ? ` ${own ? 'Session diagnostic' : 'Diagnostic for all captured sessions'}: ${reason}.` : ''}${boundary ? ` Initial boundary prompt ${boundary} was excluded; full turns after it are captured.` : ''}${identity ? ` Native identity data: ${JSON.stringify(identity)}.` : ''}`;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

export async function main(args = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, ingress = collectionIngress } = {}) {
  try {
    if (args.length !== 1 || !['codex', 'claude'].includes(args[0])) throw new Error();
    const payload = await input(stdin), result = await ingress(args[0], payload);
    const output = collectionHookOutput(result, payload.hook_event_name);
    if (output) stdout.write(JSON.stringify(output) + '\n');
  } catch { stderr.write('Cuefluent Notes: collection unavailable; inspect workflow status.\n'); }
  return 0;
}
if (await isMain(import.meta.url)) main().then(() => { process.exitCode = 0; }, () => { process.exitCode = 0; });
