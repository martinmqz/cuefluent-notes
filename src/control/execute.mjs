import { fail } from '../core/errors.mjs';
import { chooseProject } from '../core/settings.mjs';
import { parseAction } from '../client/commands.mjs';
import { readChat, setChatTracking, retainChatContract } from '../storage/chats.mjs';
import { readSettings } from '../storage/store.mjs';
import { inspectAttempt, launchOwnedAttempt } from '../storage/attempts.mjs';
import { prepareProcessing } from '../processing/prepare.mjs';
import { readProjectStatus } from './status.mjs';

/** Trusted invocation only: native binders own chat/action identity. A model tool
 * may trigger native-context resolution, but never supplies these fields. Runs
 * execute in a separate worker; client delivery deadlines cannot launch another. */
export async function executeControl(store, invocation, { reconcileChat, launchProcessing, startupTimeoutMs } = {}) {
  const action = parseAction(invocation?.action);
  if (!store) return { state: 'unconfigured', message: 'Set up Cuefluent Notes for this project first.' };
  if (!['claude', 'codex'].includes(invocation?.client)) fail('NATIVE_CONTEXT_INVALID', 'A native command binding is required.');
  const owned = await readChat(store, invocation.client, invocation.sessionId);
  const settings = await readSettings(store);
  const project = chooseProject(settings.value, invocation.cwd, { existingOwnerId: owned?.value.projectId });
  if (!project) return { state: 'unconfigured', message: 'Set up Cuefluent Notes for this project first.' };
  const chat = { client: invocation.client, sessionId: invocation.sessionId };
  const status = () => readProjectStatus(store, project.id, { chat });
  if (action === 'status') return status();
  if (action === 'track' || action === 'untrack') {
    if (typeof reconcileChat !== 'function') fail('PROCESSING_RECONCILER_REQUIRED', 'A trusted native reconciler is required.');
    const saved = await setChatTracking(store, invocation);
    if (!saved) return { state: 'unconfigured', message: 'Set up Cuefluent Notes for this project first.' };
    let synchronization;
    try { synchronization = await reconcileChat(chat); }
    catch (error) {
      synchronization = { status: 'pending', reason: typeof error.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : 'SOURCE_RECONCILIATION_FAILED' };
    }
    return { state: action === 'track' ? 'tracked' : 'untracked', projectId: saved.value.projectId,
      synchronization, status: await status() };
  }
  if (typeof launchProcessing !== 'function') fail('PROCESSING_LAUNCH_REQUIRED', 'A trusted separate worker launcher is required.');
  await retainChatContract(store, invocation);
  let run;
  if (action === 'process' || action === 'process project') {
    const prepared = await prepareProcessing(store, project.id, action === 'process' ? { kind: 'chat', ...chat } : { kind: 'project' }, { reconcileChat });
    if (prepared.state === 'empty') return prepared;
    if (prepared.state === 'pending' && !prepared.scopeMatches) return status();
    run = prepared.run;
    if (run.phase === 'review' || run.phase === 'saving' && run.settings.saving === 'review') return status();
  } else {
    try { run = (await inspectAttempt(store, project.id)).run; }
    catch (error) { if (error.code === 'RUN_MISSING') return status(); throw error; }
    if (action === 'save' && (run.phase === 'drafting' || run.settings.saving !== 'review')) return status();
  }
  const workerAction = action === 'skip' ? 'skip' : action === 'save' ? 'save' : 'process';
  return launchOwnedAttempt(store, project.id, { runId: run.id, startupTimeoutMs, launch: context => launchProcessing({ ...context, action: workerAction }) });
}
