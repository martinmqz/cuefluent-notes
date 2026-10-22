import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { chooseProject } from '../core/settings.mjs';
import { validateClientContract } from '../core/chat.mjs';
import { parseAction } from '../client/commands.mjs';
import { nativeId } from '../transcript/checkpoint.mjs';
import { chatKey, readChat } from '../storage/chats.mjs';
import { gateOptions, withProject, withSelectedProject } from '../storage/store.mjs';
import { createPrivateDirectory, assertDirectory, lstatOrNull } from '../storage/paths.mjs';
import { readJSON, writeJSON } from '../storage/files.mjs';
import { initializeGate, inspectExistingGate, probeGate, tryAcquireExistingGate } from '../storage/gates.mjs';
import { readProjectStatus } from './status.mjs';

const MAX_BYTES = 512 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const unconfigured = () => ({ state: 'unconfigured', message: 'Set up Cuefluent Notes for this project first.' });
const relative = key => `store/invocations/${key}.json`;
function invalid() { fail('INVOCATION_INVALID', 'The current invocation metadata is invalid.'); }
function keys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length || names.some(name => !Object.hasOwn(descriptors, name) || !Object.hasOwn(descriptors[name], 'value'))) invalid();
}
function binding(input) {
  const value = { client: input?.client, sessionId: input?.sessionId, promptId: input?.promptId,
    action: input?.action, cwd: input?.cwd, sourcePath: input?.sourcePath ?? null, commandNonce: input?.commandNonce ?? null,
    clientContract: validateClientContract(input?.clientContract ?? null) };
  if (!['claude', 'codex'].includes(value.client)) invalid();
  nativeId(value.sessionId); nativeId(value.promptId);
  if (parseAction(value.action) !== value.action || value.action === 'status') invalid();
  for (const [field, item] of Object.entries({ cwd: value.cwd, sourcePath: value.sourcePath })) {
    if (field === 'sourcePath' && item === null) continue;
    if (typeof item !== 'string' || item.length > 32768 || /[\u0000-\u001f\u007f]/.test(item) || !path.isAbsolute(item) || path.normalize(item) !== item) invalid();
  }
  if (!(value.commandNonce === null || value.client === 'claude' && (UUID.test(value.commandNonce) || decode(value.commandNonce)))) invalid();
  return Object.freeze(value);
}
function validate(store, key, value) {
  keys(value, ['schemaVersion', 'projectId', 'binding', 'token', 'gate', 'phase', 'result', 'blockedPromptId']);
  if (value.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.projectId) || !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
      !['pending', 'executing', 'finished'].includes(value.phase) || (value.phase === 'finished') !== (value.result !== null)) invalid();
  keys(value.binding, ['client', 'sessionId', 'promptId', 'action', 'cwd', 'sourcePath', 'commandNonce', 'clientContract']);
  const bound = binding(value.binding);
  if (value.blockedPromptId !== null) { nativeId(value.blockedPromptId); if (value.blockedPromptId === bound.promptId) invalid(); }
  if (chatKey(bound.client, bound.sessionId) !== key) invalid();
  const gate = value.gate;
  keys(gate, ['path', 'id', 'device', 'inode']);
  if (gate.path !== path.join(store.root, `store/invocations/${key}.sqlite`) || gate.id !== `command:${key}` || !/^\d+$/.test(gate.device) || !/^[1-9]\d*$/.test(gate.inode)) invalid();
  if (value.result !== null && (!value.result || typeof value.result !== 'object' || Array.isArray(value.result) || typeof value.result.state !== 'string')) invalid();
  return { ...value, binding: bound };
}
function encode(key, token) { return Buffer.concat([Buffer.from(key, 'hex'), Buffer.from(token, 'base64url')]).toString('base64url'); }
function decode(handle) {
  if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(handle)) return null;
  const bytes = Buffer.from(handle, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== handle) return null;
  return { key: bytes.subarray(0, 32).toString('hex'), token: bytes.subarray(32) };
}
async function read(store, key) {
  await assertDirectory(store.pin);
  if (!await lstatOrNull(path.join(store.root, 'store/invocations'))) return null;
  const saved = await readJSON(store.pin, relative(key), { missing: true, maxBytes: MAX_BYTES });
  return saved ? { value: validate(store, key, saved.value), hash: saved.hash } : null;
}
function matches(saved, token) {
  const expected = Buffer.from(saved.value.token, 'base64url');
  return expected.length === token.length && timingSafeEqual(expected, token);
}

/** One replaceable metadata entry per native chat. This is neither command
 * history nor conversation storage. Native transport owns the invocation proof;
 * tools cannot choose its binding. Status bypasses claims and is read-only. */
export async function claimInvocation(store, input) {
  if (!store) return { result: unconfigured(), ticket: null };
  const checked = binding(input), key = chatKey(checked.client, checked.sessionId);
  const claimed = await withSelectedProject(store, async settings => {
    const owner = await readChat(store, checked.client, checked.sessionId);
    return chooseProject(settings, checked.cwd, { existingOwnerId: owner?.value.projectId })?.id ?? null;
  }, async context => {
    const current = await read(store, key);
    if (current) {
      const prior = current.value;
      if (prior.blockedPromptId === checked.promptId) return { refusal: { state: 'not-executed', reason: 'COMMAND_REQUIRES_NEW_PROMPT', message: 'This prompt was not executed. Repeat the typed command in a new prompt to try again.' } };
      if (prior.binding.promptId === checked.promptId) {
        if (prior.projectId !== context.project.id || ['client', 'sessionId', 'action', 'cwd', 'sourcePath'].some(field => prior.binding[field] !== checked[field]) ||
            JSON.stringify(prior.binding.clientContract) !== JSON.stringify(checked.clientContract)) fail('INVOCATION_CHANGED', 'This native prompt already has a different command binding.');
        return prior;
      }
      if (probeGate(prior.gate, gateOptions).busy) {
        await writeJSON(store.pin, relative(key), { ...prior, blockedPromptId: checked.promptId }, { expectedHash: current.hash, maxBytes: MAX_BYTES });
        return { refusal: { state: 'busy', reason: 'COMMAND_IN_PROGRESS', message: 'This command was not executed. Repeat it in a new prompt after the current command finishes.' } };
      }
      if (prior.phase === 'pending') {
        const result = { state: 'not-executed', reason: 'COMMAND_STARTUP_INTERRUPTED', message: 'The previous command did not start. This command was not executed; repeat the typed command to try again.' };
        await writeJSON(store.pin, relative(key), { ...prior, phase: 'finished', result, blockedPromptId: checked.promptId }, { expectedHash: current.hash, maxBytes: MAX_BYTES });
        return { refusal: result };
      }
    }
    await createPrivateDirectory(path.join(store.root, 'store/invocations'));
    const file = path.join(store.root, `store/invocations/${key}.sqlite`);
    let gate = current?.value.gate;
    if (!gate) {
      try { gate = initializeGate(file, `command:${key}`, gateOptions); }
      catch (error) {
        if (error.code !== 'GATE_EXISTS') throw error;
        // This explicit command may finish an interrupted empty registration.
        gate = inspectExistingGate(file, `command:${key}`, gateOptions);
      }
    }
    const token = randomBytes(32).toString('base64url');
    const selected = checked.client === 'claude' && checked.commandNonce === null ? { ...checked, commandNonce: encode(key, token) } : checked;
    const value = validate(store, key, { schemaVersion: 1, projectId: context.project.id, binding: selected,
      token, gate, phase: 'pending', result: null, blockedPromptId: null });
    await writeJSON(store.pin, relative(key), value, { expectedHash: current?.hash ?? null, maxBytes: MAX_BYTES });
    return value;
  });
  if (!claimed) return { result: unconfigured(), ticket: null };
  if (claimed.refusal) return { result: claimed.refusal, ticket: null };
  const handle = encode(key, claimed.token);
  return { ticket: handle, binding: claimed.binding, pending: claimed.phase === 'pending',
    result: claimed.phase === 'finished' ? { ...claimed.result, handle } : { state: claimed.phase === 'pending' ? 'accepted' : 'running', handle } };
}

/** A claimed command is entered at most once. A crash after entering may have
 * launched processing, so retrying the same tool only observes its project.
 * A new typed command can resume the existing processing run normally. */
export async function runClaimedInvocation(store, handle, { execute, channel = null, startupTimeoutMs = 5000 } = {}) {
  const token = decode(handle);
  if (!store || !token || typeof execute !== 'function') fail('INVOCATION_INVALID', 'A trusted current command ticket is required.');
  const first = await read(store, token.key);
  if (!first || !matches(first, token.token)) return { state: 'expired' };
  const acquired = tryAcquireExistingGate(first.value.gate, gateOptions);
  if (acquired.busy) return readInvocation(store, handle);
  try {
    let startup = null;
    if (channel) {
      startup = activation(channel, handle, startupTimeoutMs);
      await startup.ready;
    }
    const entered = await withProject(store, first.value.projectId, async () => {
      const current = await read(store, token.key);
      if (!current || !matches(current, token.token) || current.value.phase !== 'pending') return null;
      const next = { ...current.value, phase: 'executing' };
      await writeJSON(store.pin, relative(token.key), next, { expectedHash: current.hash, maxBytes: MAX_BYTES });
      return next;
    });
    if (!entered) return readInvocation(store, handle);
    if (startup) { await startup.activate(); }
    let result;
    try { result = await execute(entered.binding); }
    catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'COMMAND_FAILED';
      result = { state: 'failed', reason: code };
    }
    await withProject(store, entered.projectId, async () => {
      const current = await read(store, token.key);
      if (!current || !matches(current, token.token) || current.value.phase !== 'executing') fail('INVOCATION_CHANGED', 'The command result no longer belongs to the current invocation.');
      const next = validate(store, token.key, { ...current.value, phase: 'finished', result });
      await writeJSON(store.pin, relative(token.key), next, { expectedHash: current.hash, maxBytes: MAX_BYTES });
    });
    return { ...result, handle };
  } finally { acquired.acquired.release(); }
}

/** Polling performs no writes or retries. An opaque ticket reveals no native
 * identities, paths, command body, or transcript content. */
export async function readInvocation(store, handle) {
  const token = decode(handle);
  if (!store || !token) return { state: 'expired' };
  const current = await read(store, token.key);
  if (!current || !matches(current, token.token)) return { state: 'expired' };
  const item = current.value;
  if (item.phase === 'finished' && item.result.state !== 'running') return { ...item.result, handle };
  const state = await readProjectStatus(store, item.projectId, { chat: { client: item.binding.client, sessionId: item.binding.sessionId } });
  if (item.phase === 'finished') {
    if (state.run?.id === item.result.runId) return { ...state, handle };
    if (state.latest?.runId === item.result.runId) return { state: 'completed', result: state.latest, counts: state.counts, handle };
    return { ...item.result, state: 'unavailable', handle };
  }
  const active = probeGate(item.gate, gateOptions).busy;
  if (active) return { state: item.phase === 'pending' ? 'starting' : 'running', handle };
  if (item.phase === 'pending') return { state: 'interrupted', reason: 'COMMAND_STARTUP_INTERRUPTED', handle,
    message: 'The command has no active startup owner. Repeat its typed command to retry safely.' };
  return { ...state, state: 'interrupted', reason: 'COMMAND_DELIVERY_INTERRUPTED', handle,
    message: 'The command stopped before recording its result. Inspect this status and repeat the typed command to resume pending work.' };
}

const STARTUP = 'cuefluent-command:';
function startupError(code = 'COMMAND_STARTUP_FAILED') { return Object.assign(new Error('The command worker did not activate safely.'), { code }); }
function activation(channel, handle, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !channel.connected || typeof channel.send !== 'function') throw startupError();
  const deadline = performance.now() + timeoutMs; let done = false;
  let clean;
  const ready = new Promise((resolve, reject) => {
    const failure = () => { clean(); reject(startupError()); };
    const timer = setTimeout(failure, timeoutMs);
    const message = value => { if (value?.type === `${STARTUP}activate` && value.handle === handle) { clean(); resolve(); } };
    clean = () => { clearTimeout(timer); channel.off('message', message); channel.off('disconnect', failure); };
    channel.on('message', message); channel.once('disconnect', failure);
    channel.send({ type: `${STARTUP}ready`, handle }, error => { if (error) failure(); });
  });
  return { ready, async activate() {
    if (done || !channel.connected || performance.now() >= deadline) throw startupError('COMMAND_STARTUP_TIMEOUT');
    done = true;
    await new Promise((resolve, reject) => channel.send({ type: `${STARTUP}active`, handle }, error => error ? reject(startupError()) : resolve()));
    channel.disconnect();
  } };
}

/** Parent receives activation, not just process spawn. A parent lost before
 * activation leaves no executing command. The deadline bounds startup only. */
export async function launchInvocationChild(child, { handle, startupTimeoutMs = 5000 } = {}) {
  if (!decode(handle) || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000) invalid();
  return new Promise((resolve, reject) => {
    let ready = false, active = false, settled = false;
    const timer = setTimeout(() => finish(startupError('COMMAND_STARTUP_TIMEOUT')), startupTimeoutMs);
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', failure); child.off('error', failure); child.off('disconnect', failure); };
    const finish = (error, result) => { if (settled) return; settled = true; cleanup(); if (error) { if (!active) child.kill(); reject(error); } else { child.unref(); resolve(result); } };
    const failure = () => finish(startupError());
    const message = value => {
      if (value?.handle !== handle) return;
      if (value.type === `${STARTUP}ready`) { if (ready) return failure(); ready = true; child.send({ type: `${STARTUP}activate`, handle }, error => { if (error) failure(); }); }
      else if (value.type === `${STARTUP}active`) { if (!ready) return failure(); active = true; finish(null, { started: true }); }
      else if (value.type === `${STARTUP}result`) finish(null, { started: false, result: value.result });
    };
    child.on('message', message); child.once('exit', failure); child.once('error', failure); child.once('disconnect', failure);
  });
}

export async function reportInvocationExit(channel, handle, result) {
  if (!channel?.connected) return;
  await new Promise((resolve, reject) => channel.send({ type: `${STARTUP}result`, handle, result }, error => error ? reject(startupError()) : resolve())); channel.disconnect();
}
