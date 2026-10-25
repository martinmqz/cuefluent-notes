import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '../core/errors.mjs';
import { createChat, requestReconciliation, validateChat, validateChatHistory, validateClientContract, retainChatClientContract } from '../core/chat.mjs';
import { chooseProject } from '../core/settings.mjs';
import { nativeId } from '../transcript/checkpoint.mjs';
import { assertAbsolute, assertRegularFile, lstatOrNull } from '../storage/paths.mjs';
import { writeJSON } from '../storage/files.mjs';
import { chatRelative, iterateProjectChats, readChat } from '../storage/chats.mjs';
import { gateOptions, readSettings, withSelectedProject } from '../storage/store.mjs';
import { probeGate, tryAcquireExistingGate } from '../storage/gates.mjs';

const code = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : 'SYNC_RUNNER_UNAVAILABLE';
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INGRESS_INVALID', 'Native events must be bounded inert metadata.');
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail('INGRESS_INVALID', 'Native event fields do not match the trusted hook contract.');
}

/** Native entrypoints bind these fields from lifecycle envelopes, never model
 * arguments, transcript text, cwd-only discovery or absence of plugin metadata.
 * startSource/newSession require native lifecycle authority. This does not scan
 * or stat a transcript; the supplied source identity is separately verified.
 */
export function validateNativeEvent(input) {
  record(input, ['client', 'sessionId', 'cwd', 'kind', 'source', 'startSource', 'newSession', 'completion', 'history', 'launchMarker', ...(Object.hasOwn(input ?? {}, 'clientContract') ? ['clientContract'] : [])]);
  const clientContract = validateClientContract(Object.hasOwn(input, 'clientContract') ? input.clientContract : null);
  if (!['claude', 'codex'].includes(input.client) || !['start', 'completed', 'interrupted', 'failed', 'end'].includes(input.kind) || typeof input.newSession !== 'boolean') fail('INGRESS_INVALID', 'Unsupported native lifecycle event.');
  nativeId(input.sessionId); assertAbsolute(input.cwd);
  if (input.cwd.length > 32768 || !(input.startSource === null || ['startup', 'resume', 'fork', 'clear', 'compact'].includes(input.startSource)) ||
      (input.kind === 'start' && input.startSource === null) || (input.newSession && (input.kind !== 'start' || !['startup', 'fork', 'clear'].includes(input.startSource)))) fail('INGRESS_INVALID', 'The lifecycle signal does not prove a newly created native chat.');
  if (!(input.launchMarker === null || typeof input.launchMarker === 'string' && /^[A-Za-z0-9_.:-]{16,256}$/.test(input.launchMarker))) fail('INGRESS_INVALID', 'An invocation-only launch marker must be bounded opaque metadata.');
  let history = null;
  if (input.history !== null) {
    history = validateChatHistory(input.history, { client: input.client });
    if (history.mode !== 'automatic' || history.startSource !== input.startSource || !input.newSession) fail('INGRESS_INVALID', 'Initial automatic history must match the verified new-session event.');
  }
  const chat = createChat({ client: input.client, sessionId: input.sessionId, projectId: 'native-binding', source: input.source });
  let completion = null;
  if (input.completion !== null) {
    record(input.completion, ['promptId', 'kind', 'finalTextHash']);
    const candidate = requestReconciliation(validateChat({ ...chat, tracked: true }), input.completion);
    completion = candidate.pending.completion;
    if (['completed', 'interrupted', 'failed'].includes(input.kind) && completion.kind !== input.kind) fail('INGRESS_INVALID', 'Completion expectation differs from the native lifecycle event.');
  } else if (['completed', 'interrupted', 'failed'].includes(input.kind)) fail('INGRESS_INVALID', 'Native completion events require their exact prompt expectation.');
  return frozen({ client: input.client, sessionId: input.sessionId, cwd: input.cwd, kind: input.kind, source: chat.source,
    startSource: input.startSource, newSession: input.newSession, completion, history, launchMarker: input.launchMarker, clientContract });
}

function observedSource(chat, source) {
  if (!source) return chat;
  if (!chat.source) return validateChat({ ...chat, source });
  if (chat.source.path !== source.path || chat.source.identity && source.identity &&
      ['device', 'inode'].some(key => chat.source.identity[key] !== source.identity[key])) return validateChat({ ...chat, sourceCandidate: source });
  return chat;
}

async function registerNativeMetadata(event, register) {
  // SessionStart is one-shot native authority. Retry transient gate contention
  // within the ten-second hook profile, always rechecking current settings and
  // ownership. Failed or ineligible checks publish no enrollment breadcrumb.
  const attempts = event.kind === 'start' && event.newSession ? 3 : 1;
  for (let attempt = 0; ; attempt++) {
    try { return await register(); }
    catch (error) {
      if (error.code !== 'GATE_BUSY' || attempt + 1 >= attempts) throw error;
      await delay(25);
    }
  }
}

/** Metadata-only hook operation. Durable consent/request precedes scheduling.
 * schedule must only dispatch independent deterministic Node work, never collect
 * inline. Marker verification binds a processing launch to its native identity;
 * a marker string alone cannot suppress capture of an unrelated user chat.
 */
export async function ingestNativeEvent(store, input, { verifyProcessingSession = null, schedule = null } = {}) {
  const event = validateNativeEvent(input);
  if (!store) return { status: 'unconfigured' };
  if (verifyProcessingSession !== null && typeof verifyProcessingSession !== 'function' || schedule !== null && typeof schedule !== 'function') fail('INGRESS_INVALID', 'Native ingress dependencies must be trusted capabilities.');
  if (verifyProcessingSession) {
    const processing = await verifyProcessingSession(event);
    if (typeof processing !== 'boolean') fail('INGRESS_INVALID', 'Processing-session verification must return an exact boolean.');
    if (processing) return { status: 'excluded', reason: 'PROCESSING_SESSION' };
  }
  if (event.launchMarker !== null) return { status: 'pending', reason: 'PROCESSING_IDENTITY_UNVERIFIED' };
  let found, durableResult, releaseWarning, result;
  try { result = await registerNativeMetadata(event, () => withSelectedProject(store, async settings => {
    found = await readChat(store, event.client, event.sessionId);
    return chooseProject(settings, event.cwd, { existingOwnerId: found?.value.projectId })?.id ?? null;
  }, async context => {
    if (found && !found.value.tracked) return durableResult = { state: found.value, status: 'untracked', work: found.value.pending?.reason === 'untrack' };
    let chat;
    if (!found) {
      if (context.project.tracking !== 'auto' || !event.newSession || event.kind !== 'start') return { status: 'ineligible', work: false };
      chat = createChat({ client: event.client, sessionId: event.sessionId, projectId: context.project.id, source: event.source,
        history: event.history ?? { mode: 'automatic', startSource: event.startSource, inheritedBoundary: null } });
      chat = validateChat({ ...chat, tracked: true });
    } else chat = observedSource(found.value, event.source);
    chat = retainChatClientContract(chat, event.clientContract);
    // SessionEnd/resume must not erase a persisted Stop expectation or an exact
    // command boundary. An idle tracked flag remains durable reconciliation work.
    if (event.completion) chat = requestReconciliation(chat, event.completion);
    else if (!chat.pending) chat = requestReconciliation(chat);
    if (!found || JSON.stringify(chat) !== JSON.stringify(found.value)) await writeJSON(store.pin,
      chatRelative(context.project.id, event.client, event.sessionId), chat, { expectedHash: found?.hash ?? null, maxBytes: 64 * 1024 });
    return durableResult = { state: chat, status: found ? 'tracked' : 'enrolled', work: true };
  })); } catch (error) {
    if (error.code !== 'GATE_RELEASE_FAILED' || !durableResult?.work) throw error;
    // The metadata write completed. Gate release trouble remains visible, but
    // cannot erase the independent reconciliation dispatch it just authorized.
    result = durableResult; releaseWarning = error.code;
  }
  if (!result) return { status: 'unconfigured' };
  if (!result.work) return { status: result.status };
  const request = frozen({ storeRoot: store.root, client: event.client, sessionId: event.sessionId,
    generation: result.state.generation, requestId: result.state.pending?.id ?? null });
  if (!schedule) return { status: 'pending', reason: 'SYNC_RUNNER_UNAVAILABLE' };
  try { await schedule(request); return releaseWarning ? { status: 'pending', reason: releaseWarning, scheduled: true } : { status: result.status, scheduled: true }; }
  catch (error) { return { status: 'pending', reason: code(error) }; }
}

/** A probe is only an optimization; concurrent launches still contend on the
 * worker's own store-wide OS gate. No PID/age file establishes worker liveness. */
export async function ensureSyncSteward(store, { launch } = {}) {
  if (!store) return { status: 'unconfigured' };
  if (typeof launch !== 'function') fail('SYNC_RUNNER_UNAVAILABLE', 'Provide the installed deterministic Node steward launcher.');
  if (probeGate(store.syncGate, gateOptions).busy) return { status: 'running' };
  await launch({ storeRoot: store.root }); return { status: 'launched' };
}

function workerArguments(entry, storeRoot, mode, client, sessionId) {
  assertAbsolute(entry); assertAbsolute(storeRoot);
  if (mode === 'sync-collect') { if (!['claude', 'codex'].includes(client)) fail('INGRESS_INVALID', 'Unknown collection client.'); nativeId(sessionId); }
  return [entry, mode, storeRoot, ...(mode === 'sync-collect' ? [client, sessionId] : [])];
}

/** Invocation-only child launch. Native entrypoint implements sync-steward and
 * sync-collect dispatch; no shell, model, OS service or installed setting. */
export async function launchDetachedSyncSteward({ entry, storeRoot }, { spawn = nodeSpawn } = {}) {
  const child = spawn(process.execPath, workerArguments(entry, storeRoot, 'sync-steward'), { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); return { status: 'launched' };
}

/** Supervised collector subprocess. It reports bounded metadata over IPC and
 * closes normally; process death returns pending so the steward retries durable
 * chat state. The parent owns this child object, never a guessed PID. */
export function launchSyncAttempt({ entry, storeRoot, client, sessionId, signal }, { spawn = nodeSpawn } = {}) {
  if (signal?.aborted) return Promise.resolve({ status: 'pending', reason: 'SYNC_ABORTED', parts: 0 });
  return new Promise(resolve => {
    const child = spawn(process.execPath, workerArguments(entry, storeRoot, 'sync-collect', client, sessionId), { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let result = null, settled = false;
    const abort = () => child.kill();
    const finish = value => { if (!settled) { settled = true; signal?.removeEventListener('abort', abort); resolve(value); } };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('message', message => {
      if (result || !message || !['caught-up', 'pending', 'untracked', 'unconfigured'].includes(message.status) ||
          !Number.isSafeInteger(message.parts) || message.parts < 0 || message.parts > 64 ||
          (message.progress !== undefined && typeof message.progress !== 'boolean') ||
          (message.reason !== undefined && (typeof message.reason !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(message.reason))) ||
          Object.keys(message).some(key => !['status', 'parts', 'reason', 'progress'].includes(key))) { child.kill(); return; }
      result = { status: message.status, parts: message.parts, ...(message.reason ? { reason: message.reason } : {}), ...(message.progress === true ? { progress: true } : {}) };
    });
    child.once('error', () => finish({ status: 'pending', reason: 'SYNC_RUNNER_UNAVAILABLE', parts: 0 }));
    child.once('close', exit => finish(!signal?.aborted && exit === 0 && result ? result : { status: 'pending', reason: signal?.aborted ? 'SYNC_ABORTED' : 'SYNC_COLLECTOR_FAILED', parts: 0 }));
  });
}

/** Physical metadata is only an idle-work hint. A Codex source can relocate while
 * its old path remains unchanged, so even unchanged hints expire and trigger an
 * authoritative native resolution. No hint authorizes collection or completion. */
async function appendSourceVersion(chat) {
  if (!chat.source?.path || chat.sourceCandidate) return null;
  const stat = await lstatOrNull(chat.source.path);
  if (!stat) return null;
  assertRegularFile(chat.source.path, stat);
  if (chat.source.identity && (String(stat.dev) !== chat.source.identity.device || String(stat.ino) !== chat.source.identity.inode)) return null;
  return JSON.stringify([chat.source.path, String(stat.dev), String(stat.ino), stat.size, String(stat.mtimeNs), String(stat.ctimeNs)]);
}

/** Retire voluntarily if this process can no longer launch its inspected code.
 * This is not a liveness check and never breaks or replaces another owner's gate. */
export function createSyncLaunchGuard(entry, executable = process.execPath) {
  assertAbsolute(entry); assertAbsolute(executable);
  let expected = null;
  return async () => {
    try {
      const stats = await Promise.all([entry, executable].map(file => lstatOrNull(file)));
      if (stats.some(stat => !stat?.isFile())) return false;
      const version = JSON.stringify(stats.map(stat => [String(stat.dev), String(stat.ino), stat.size, String(stat.mtimeNs), String(stat.ctimeNs)]));
      expected ??= version;
      return version === expected;
    } catch { return false; }
  };
}

/** One detached steward holds the independent OS gate for its whole lifetime.
 * Each attempt belongs in a separate child process (launchSyncAttempt). Tracked
 * sources remain periodically eligible after catch-up for late supplements;
 * only fully untracked/settled work stops the poller. Reboot/loss leaves existing
 * chat flags and pending requests durable for the next supported hook/command.
 */
export async function runSyncSteward(store, { attempt, signal, wait = (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal }),
  observeSource = appendSourceVersion, launchAvailable = async () => true, now = () => performance.now(),
  retryDelayMs = 1000, maxRetryDelayMs = 30_000, idleDelayMs = 30_000, idleRecheckMs = 300_000 } = {}) {
  if (!store) return { status: 'unconfigured' };
  if (typeof attempt !== 'function' || typeof wait !== 'function' || typeof observeSource !== 'function' || typeof launchAvailable !== 'function' || typeof now !== 'function' || ![retryDelayMs, maxRetryDelayMs, idleDelayMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 60_000) || retryDelayMs > maxRetryDelayMs || !Number.isSafeInteger(idleRecheckMs) || idleRecheckMs < 1 || idleRecheckMs > 300_000) fail('INGRESS_INVALID', 'Provide a deterministic bounded retry protocol.');
  const owned = tryAcquireExistingGate(store.syncGate, gateOptions);
  if (owned.busy) return { status: 'running' };
  let backoff = retryDelayMs;
  const versions = new Map();
  try {
    while (!signal?.aborted) {
      let work = false, pending = false, progress = false, checkedLaunch = false;
      const settings = await readSettings(store);
      for (const project of settings.value.projects) {
        if (signal?.aborted) break;
        try {
          for await (const saved of iterateProjectChats(store, project.id)) {
            if (signal?.aborted) break;
            if (!saved.value.tracked && saved.value.pending?.reason !== 'untrack') continue;
            if (!checkedLaunch) {
              if (!await launchAvailable()) return { status: 'retired', reason: 'SYNC_RUNNER_UNAVAILABLE' };
              checkedLaunch = true;
            }
            const key = `${saved.value.client}:${saved.value.sessionId}`;
            let version = null;
            try { version = await observeSource(saved.value); } catch {}
            if (version !== null && (typeof version !== 'string' || version.length > 65536)) fail('INGRESS_INVALID', 'A source version must be bounded metadata or null.');
            const prior = versions.get(key);
            // New durable requests and changed source bytes bypass idle deferral.
            // Expiry also re-resolves native authority when the old path is idle.
            const unchanged = version !== null && prior?.stateHash === saved.hash && prior.version === version;
            if (unchanged && now() < prior.recheckAt) {
              work = true; pending ||= Boolean(saved.value.pending); continue;
            }
            let result;
            try { result = await attempt({ storeRoot: store.root, client: saved.value.client, sessionId: saved.value.sessionId, signal }); }
            catch { result = { status: 'pending' }; }
            if (!result || !['caught-up', 'pending', 'untracked', 'unconfigured'].includes(result.status)) result = { status: 'pending' };
            const launchFailures = ['SYNC_RUNNER_UNAVAILABLE', 'SYNC_COLLECTOR_FAILED'].includes(result.reason) ? (prior?.launchFailures ?? 0) + 1 : 0;
            if (result.reason === 'SYNC_RUNNER_UNAVAILABLE' || launchFailures >= 3) return { status: 'retired', reason: result.reason };
            pending ||= result?.status === 'pending';
            progress ||= result.progress === true || Number.isSafeInteger(result.parts) && result.parts > 0;
            work ||= saved.value.tracked ? !['untracked', 'unconfigured'].includes(result?.status) : result?.status === 'pending';
            // Fulfilling a command boundary can stop before already-persisted later
            // conversation. Require a following unrestricted pass before caching.
            const quietAttempts = result.status === 'pending' && !result.progress && !result.parts ? (unchanged ? prior.quietAttempts : 0) + 1 : 0;
            if (result?.status === 'caught-up' && !saved.value.pending?.beforePromptId || quietAttempts >= 4 || launchFailures) {
              const current = await readChat(store, saved.value.client, saved.value.sessionId);
              if (current && (current.value.tracked || current.value.pending?.reason === 'untrack')) {
                // Cache the pre-attempt version, so an append racing collection
                // cannot be mistaken for bytes the completed attempt inspected.
                if (versions.size >= 1024 && !versions.has(key)) versions.delete(versions.keys().next().value);
                const settled = result.status === 'caught-up' && !current.value.pending && !current.value.checkpoint.boundary && !current.value.checkpoint.cursor && !current.value.sourceCandidate && !current.value.uncommitted;
                versions.set(key, { version, stateHash: current.hash, quietAttempts, launchFailures,
                  recheckAt: settled || quietAttempts >= 4 ? now() + idleRecheckMs : 0 });
              }
            } else if (quietAttempts) {
              if (versions.size >= 1024 && !versions.has(key)) versions.delete(versions.keys().next().value);
              versions.set(key, { version, stateHash: saved.hash, quietAttempts, launchFailures, recheckAt: 0 });
            }
          }
        } catch {
          // A concurrent metadata replacement may invalidate one inventory read.
          // Retry it without terminating idle supervision of other projects.
          work = true; pending = true;
        }
      }
      if (!work) return { status: 'settled' };
      if (progress) backoff = retryDelayMs;
      try { await wait(pending ? backoff : idleDelayMs, signal); }
      catch (error) { if (signal?.aborted) break; throw error; }
      backoff = pending && !progress ? Math.min(maxRetryDelayMs, backoff * 2) : retryDelayMs;
    }
    return { status: 'stopped' };
  } finally { owned.acquired.release(); }
}
