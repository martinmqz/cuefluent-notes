import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../src/core/settings.mjs';
import { requestReconciliation } from '../src/core/chat.mjs';
import { initializeStore, readSettings, updateSettings } from '../src/storage/store.mjs';
import { readChat, setChatTracking, updateChat, iterateProjectChats, chatRelative } from '../src/storage/chats.mjs';
import { readJSON } from '../src/storage/files.mjs';
import { readProjectStatus } from '../src/control/status.mjs';
import { prepareProcessing } from '../src/processing/prepare.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-v2-chats-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(path.join(projectRoot, 'nested'), { recursive: true });
  const project = createProject({ id: 'outer', root: projectRoot, destination: { kind: 'directory', path: path.join(root, 'notes') } });
  const store = await initializeStore(path.join(root, 'private'), { schemaVersion: 1, projects: [project] });
  const invocation = { client: 'claude', sessionId: 'native-session', promptId: 'command-1', action: 'track', cwd: path.join(projectRoot, 'nested'), sourcePath: null };
  return { root, project, store, invocation };
}

test('read-only and unconfigured commands create no chat metadata', async t => {
  const f = await fixture(t);
  assert.equal(await readChat(null, 'claude', 'native-session'), null);
  assert.equal(await readChat(f.store, 'claude', 'native-session'), null);
  assert.equal(await setChatTracking(null, f.invocation), null);
  assert.equal(await setChatTracking(f.store, { ...f.invocation, cwd: f.root }), null);
  assert.equal(await readChat(f.store, 'claude', 'native-session'), null);
});

test('chat ownership survives a new nested project while new chats choose that project', async t => {
  const f = await fixture(t);
  const first = await setChatTracking(f.store, f.invocation);
  assert.equal(first.value.projectId, 'outer');
  const settings = await readSettings(f.store);
  const nested = createProject({ id: 'nested', root: f.invocation.cwd, destination: f.project.destination });
  await updateSettings(f.store, { schemaVersion: 1, projects: [f.project, nested] }, { expectedHash: settings.hash });
  const stopped = await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'command-2' });
  assert.equal(stopped.value.projectId, 'outer'); assert.equal(stopped.value.optOut, true);
  const next = await setChatTracking(f.store, { ...f.invocation, sessionId: 'new-session' });
  assert.equal(next.value.projectId, 'nested');
  assert.equal((await readChat(f.store, 'claude', 'native-session')).value.projectId, 'outer');
});

test('stale collector metadata cannot overwrite an explicit untrack', async t => {
  const f = await fixture(t);
  const original = await setChatTracking(f.store, f.invocation);
  const stopped = await setChatTracking(f.store, { ...f.invocation, action: 'untrack', promptId: 'command-2' });
  await assert.rejects(updateChat(f.store, 'outer', 'claude', 'native-session', {
    expectedHash: original.hash, change: state => requestReconciliation(state),
  }), { code: 'CHAT_CHANGED' });
  const saved = await readChat(f.store, 'claude', 'native-session');
  assert.equal(saved.hash, stopped.hash); assert.equal(saved.value.tracked, false);
  assert.equal(saved.value.pending.beforePromptId, 'command-2');
});

test('retained publication stages do not block inventory, status or project processing', async t => {
  const f = await fixture(t); await setChatTracking(f.store, f.invocation);
  await setChatTracking(f.store, { ...f.invocation, sessionId: 'second-chat' });
  const relative = chatRelative('outer', 'claude', 'native-session');
  const stage = path.join(f.store.root, path.dirname(relative), `.${path.basename(relative)}.10000000-0000-4000-8000-000000000000.tmp`);
  await fs.writeFile(stage, 'unpublished synthetic metadata', { mode: 0o600 });
  const warnings = [], items = [];
  for await (const item of iterateProjectChats(f.store, 'outer', { onWarning: code => warnings.push(code) })) items.push(item);
  assert.equal(items.length, 2); assert.ok(warnings.includes('CHAT_STAGE_RETAINED'));
  const status = await readProjectStatus(f.store, 'outer'); assert.equal(status.counts.chats, 2); assert.equal(status.counts.incomplete, true); assert.ok(status.warnings.includes('CHAT_STAGE_RETAINED'));
  let caught = 0;
  const prepared = await prepareProcessing(f.store, 'outer', { kind: 'project' }, { reconcileChat: async () => { caught++; return { status: 'caught-up' }; } });
  assert.equal(prepared.state, 'empty'); assert.equal(caught, 2); assert.ok(prepared.warnings.includes('CHAT_STAGE_RETAINED'));
  assert.equal(await fs.readFile(stage, 'utf8'), 'unpublished synthetic metadata');
});

test('inventory retries one concurrently replaced entry and isolates persistent per-chat failures', async t => {
  const f = await fixture(t); await setChatTracking(f.store, f.invocation);
  await setChatTracking(f.store, { ...f.invocation, sessionId: 'second-chat' });
  const relative = chatRelative('outer', 'claude', 'native-session'); let failures = 0;
  const warnings = [], items = [];
  for await (const item of iterateProjectChats(f.store, 'outer', { onWarning: code => warnings.push(code), readSnapshot: async (pin, file, options) => {
    if (file === relative && failures++ === 0) throw Object.assign(new Error('synthetic replacement'), { code: 'FILE_CHANGED' });
    return readJSON(pin, file, options);
  } })) items.push(item);
  assert.equal(items.length, 2); assert.deepEqual(warnings, []); assert.equal(failures, 2);
  const available = [];
  for await (const item of iterateProjectChats(f.store, 'outer', { onWarning: code => warnings.push(code), readSnapshot: async (pin, file, options) => {
    if (file === relative) throw Object.assign(new Error('synthetic replacement'), { code: 'FILE_CHANGED' }); return readJSON(pin, file, options);
  } })) available.push(item);
  assert.equal(available.length, 1); assert.equal(available[0].value.sessionId, 'second-chat'); assert.deepEqual(warnings, ['FILE_CHANGED']);
});
