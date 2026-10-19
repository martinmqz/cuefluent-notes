import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { withReviewPreview } from './processing-review.mjs';
import { openProcessingController } from '../processing-controller.mjs';
import { runProcessingMcp } from '../processing-mcp.mjs';
import { confirmReviewPresentation, presentationAttemptCurrent } from '../processing-review-files.mjs';
import { readSelection } from '../intake-store.mjs';
import { canonicalJSON, digest } from '../workflow-values.mjs';
import { inspectProcessing } from '../processing.mjs';

// Shared native MCP harness for the processing front door. Source binding is
// stubbed: h.nativeSkill marks a verified typed action and h.typedControl its
// exact typed text (Codex has no review fields in its call); h.typedSuggestions
// marks a typed skill invocation that is not an exact action, h.typedUnattached
// a Codex mention typed out by hand (its nearest commands), h.typedHelp the
// skill typed with nothing after it, and h.codeMode a Codex code-mode binding
// (its handshake call and first cell; the call itself is the retry).
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
export const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'synthetic', version: '1' } } };
export const body = row => { assert(row.result, JSON.stringify(row.error)); return JSON.parse(row.result.content[0].text); };
export const selectedInput = f => ({ client: f.selection.client, sessionId: f.selection.sessionId, cwd: f.selection.cwd });
export async function harness(t, f, overrides = {}) {
  const h = { opens: 0, closes: 0, creates: 0, resumes: 0, dispatches: 0, responses: [], waiters: new Map(), nativeSkill: false,
    script: async call => call('processing_pending', {}), jobs: [], closing: [], forms: [], formWaiters: [] };
  const input = new PassThrough();
  const output = new Writable({ write(chunk, _encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const row = JSON.parse(line); h.responses.push(row); h.waiters.get(row.id)?.resolve(row); h.waiters.delete(row.id);
      if (row.method === 'elicitation/create') { h.forms.push(row); h.formWaiters.shift()?.resolve(row); }
      if (row.error) h.formWaiters.shift()?.reject(new Error(row.error.data.code));
    }
    done();
  } });
  const openCodex = async options => ({ profileId: digest('synthetic-profile'),
    async create() {
      h.creates++; if (h.createError) throw h.createError;
      const sessionId = randomUUID();
      return { client: 'codex', sessionId, cwd: options.cwd, sourcePath: path.join(f.root, `${sessionId}.jsonl`),
        profileId: digest('synthetic-profile'), transport: 'codex-app-server', desktopVerified: false, toolContractHash: digest(canonicalJSON(options.tools)) };
    },
    async resume(session) { h.resumes++; return session; },
    async startTurn(request) {
      const unitId = randomUUID(); h.dispatches++;
      await request.roleGuard({ ...request.session, unitId: null, phase: 'before-input' });
      await request.roleGuard({ ...request.session, unitId, phase: 'started' });
      await h.script((name, args) => options.onEngineTool({ tool: `cuefluent_${name}`, arguments: args }));
      return { ...request.session, unitId, status: 'completed', model: 'synthetic-model', output: 'PRIVATE SYNTHETIC DRAFT' };
    },
    async interrupt() { h.interrupts = (h.interrupts ?? 0) + 1; await h.onInterrupt?.(); },
    async close() {}
  });
  const dependencies = {
    execution: { async beforeExecution() {}, async guardExecution() {}, async afterExecution() {} },
    // The real check before the reply and confirmation after it; a test may
    // first act as another MCP process.
    async presentationCurrent(capability, args) { await h.beforeCheck?.(); return presentationAttemptCurrent(capability, args); },
    confirmPresentation(capability, args) {
      h.confirming = (async () => { await h.beforeConfirm?.(); h.confirmed = await confirmReviewPresentation(capability, args); return h.confirmed; })();
      return h.confirming;
    },
    async resolveInvocation(capability, context, invocation) {
      const selected = await readSelection(f.store, { client: f.identity.client, sessionId: f.identity.sessionId });
      return Object.freeze({ source: f.source, selection: f.selection, selectionHash: selected.hash,
        nativeSkill: h.nativeSkill, unitId: f.identity.unitId, argsHash: digest(canonicalJSON(invocation.arguments)),
        ...(h.captureActive === undefined ? {} : { captureActive: h.captureActive }),
        ...(h.nativeSkill && h.typedControl !== undefined ? { typedControl: h.typedControl } : {}),
        ...(h.typedSuggestions !== undefined ? { typedSuggestions: Object.freeze([...h.typedSuggestions]) } : {}),
        ...(h.typedHelp === true ? { typedHelp: true } : {}),
        ...(h.typedUnattached !== undefined ? { typedUnattached: Object.freeze([...h.typedUnattached]) } : {}),
        tool: `mcp__cuefluent_control.${invocation.tool}`, callId: h.codeMode ? `exec-handshake-${context.toolCallId}` : context.toolCallId,
        // A code-mode binding names the verified handshake's first cell and result.
        ...(h.codeMode ? { outerItemId: `ctc_handshake_${context.itemId}`, outerRecordHash: digest('synthetic outer cell'),
          handshakeResultHash: digest('synthetic handshake result') } : {}) });
    },
    async openController(context, options) {
      h.opens++;
      const controller = await openProcessingController(context, { ...options, openCodex, profileId: digest('synthetic-profile'), hostId: digest('synthetic-host'), ...overrides.controllerIdentity,
        inspectOperation: operationId => h.inspectOperation ? h.inspectOperation(operationId) : inspectProcessing(f.capability, operationId) });
      let closed = false;
      return { ...controller, async run(args) { const job = controller.run(args); h.jobs.push(job); return job; },
        async stop(args) { await h.beforeStop?.(); return controller.stop(args); },
        async finishReview(args) {
          h.finishReviewCalls = (h.finishReviewCalls ?? 0) + 1;
          await h.beforeFinishReview?.();
          if (h.finishReviewFailure) throw h.finishReviewFailure;
          return controller.finishReview(args);
        },
        async close() {
          await h.beforeClose?.();
          await controller.close();
          if (!closed) { closed = true; h.closes++; h.closing.shift()?.resolve(); }
          if (h.closeFailure) throw h.closeFailure;
        } };
    },
    ...overrides
  };
  h.openController = context => dependencies.openController(context, { env: {} });
  const client = overrides.client ?? 'codex';
  // A disposable Claude profile directory; review never launches a Claude run.
  const claudeProfile = client === 'claude' ? path.join(f.root, 'synthetic-claude-profile') : null;
  if (claudeProfile) await fs.mkdir(claudeProfile, { recursive: true });
  h.server = runProcessingMcp({ client, configPath: f.options.configPath, input, output,
    env: client === 'claude' ? { CLAUDE_CODE_SESSION_ID: f.identity.sessionId, CLAUDE_CONFIG_DIR: claudeProfile } : {} }, dependencies);
  h.server.catch(() => {});
  h.send = row => {
    const ready = deferred(); h.waiters.set(row.id, ready); input.write(JSON.stringify(row) + '\n'); return ready.promise;
  };
  let nextId = 1;
  h.call = async (name, argumentsValue) => {
    const id = nextId++;
    await h.beforeCall?.(name, argumentsValue, id);
    const identity = h.nativeIdentity ?? f.identity;
    // A presentation is confirmed just after its reply is written; a person
    // reads it first, so a test's next call waits for that confirmation.
    const settled = async row => { await new Promise(resolve => setImmediate(resolve)); await h.confirming?.catch(() => {}); h.confirming = null; return row; };
    return h.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: argumentsValue,
      _meta: client === 'claude' ? { 'claudecode/toolUseId': h.callId ?? `toolu_${id}` }
        : { callId: h.callId ?? `call_${id}`, itemId: `item_${id}`, 'x-codex-turn-metadata': {
          session_id: identity.sessionId, thread_id: identity.sessionId, turn_id: identity.unitId } } } }).then(settled);
  };
  h.nextForm = () => {
    const ready = deferred(), timer = setTimeout(() => ready.reject(new Error('Expected native review form was not emitted')), 10000);
    h.formWaiters.push({ resolve: row => { clearTimeout(timer); ready.resolve(row); },
      reject: error => { clearTimeout(timer); ready.reject(error); } });
    return ready.promise;
  };
  h.answer = (form, result) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: form.id, result: withReviewPreview(form, result) })}\n`);
  };
  h.notify = row => input.write(JSON.stringify(row) + '\n');
  h.end = () => input.end();
  h.whenClosed = () => { const ready = deferred(); h.closing.push(ready); return ready.promise; };
  t.after(async () => { h.release?.(); input.end(); await h.server; });
  assert.equal((await h.send(overrides.capabilities === undefined ? initialize
    : { ...initialize, params: { ...initialize.params, capabilities: overrides.capabilities } })).result.serverInfo.name, 'cuefluent_control');
  return h;
}
