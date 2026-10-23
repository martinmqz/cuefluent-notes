import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm, writeFile, mkdir, readdir, link, symlink } from 'node:fs/promises';
import { parseEntryArguments, selectStoreRoot, loadClientContract } from '../src/client/entry-options.mjs';

const handle = Buffer.alloc(64, 17).toString('base64url');
const root = process.platform === 'win32' ? 'C:\\synthetic\\private-v2' : '/synthetic/private-v2';
async function temporary(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cuefluent-entry-')));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function development(directory, overrides = {}) {
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'cuefluent-notes', private: true, type: 'module', ...overrides }));
  await writeFile(path.join(directory, 'SKILL.md'), '# Synthetic skill\n');
}

test('exact CLI grammar returns bounded named options', () => {
  for (const client of ['claude', 'codex']) {
    assert.deepEqual(parseEntryArguments(['hook', client]), { command: 'hook', client });
    assert.deepEqual(parseEntryArguments(['mcp', client]), { command: 'mcp', client });
  }
  assert.deepEqual(parseEntryArguments(['settings']), { command: 'settings' });
  assert.deepEqual(parseEntryArguments(['setup', '--config', root]), { command: 'setup', configPath: root });
  assert.deepEqual(parseEntryArguments(['status', '--project', 'project-1']), { command: 'status', projectId: 'project-1' });
  assert.deepEqual(parseEntryArguments(['sync-steward', root]), { command: 'sync-steward', storeRoot: root });
  assert.deepEqual(parseEntryArguments(['sync-collect', root, 'codex', 'native-thread']), { command: 'sync-collect', storeRoot: root, client: 'codex', sessionId: 'native-thread' });
  assert.deepEqual(parseEntryArguments(['command-worker', root, handle]), { command: 'command-worker', storeRoot: root, handle });
  assert.equal(Object.isFrozen(parseEntryArguments(['settings'])), true);
});

test('CLI refuses unknown, repeated, missing or authority-smuggling options', () => {
  for (const args of [[], ['unknown'], ['hook', 'other'], ['settings', '--store', root], ['mcp', 'codex', '--session', 'fake'], ['setup', root],
    ['setup', '--config', 'relative.json'], ['status', '--project', '../other'], ['sync-collect', root, 'codex', 'thread/other'],
    ['command-worker', root, 'opaque'], ['command-worker', root, 'a'.repeat(86)], ['hook', 'claude\n'], ['settings', '--config', root]]) {
    assert.throws(() => parseEntryArguments(args), { code: 'ENTRY_ARGUMENT_INVALID' });
  }
  assert.deepEqual(parseEntryArguments(['sync-steward', 'C:\\Synthetic\\Private V2'], { platform: 'win32' }), { command: 'sync-steward', storeRoot: 'C:\\Synthetic\\Private V2' });
  for (const value of ['\\\\server\\share\\v2', 'C:\\synthetic\\..\\other', 'C:\\synthetic\\file:stream', 'C:\\synthetic\\NUL']) assert.throws(() => parseEntryArguments(['sync-steward', value], { platform: 'win32' }), { code: 'ENTRY_ARGUMENT_INVALID' });
});

test('fresh private defaults are platform appropriate and ignore former product locations', () => {
  const env = { CUEFLUENT_HOME: '/former', CUEFLUENT_CAPTURE_HOME: '/former-capture' };
  assert.equal(selectStoreRoot({ platform: 'darwin', homedir: '/Users/synthetic', env }), '/Users/synthetic/Library/Application Support/Cuefluent Notes/v2');
  assert.equal(selectStoreRoot({ platform: 'linux', homedir: '/home/synthetic', env }), '/home/synthetic/.local/state/cuefluent-notes/v2');
  assert.equal(selectStoreRoot({ platform: 'linux', homedir: '/home/synthetic', env: { XDG_STATE_HOME: '/private/state' } }), '/private/state/cuefluent-notes/v2');
  assert.equal(selectStoreRoot({ platform: 'win32', homedir: 'C:\\Users\\Synthetic', env: { LOCALAPPDATA: 'D:\\Local Data' } }), 'D:\\Local Data\\Cuefluent Notes\\v2');
  assert.equal(selectStoreRoot({ platform: 'win32', homedir: 'C:\\Users\\Synthetic', env: {} }), 'C:\\Users\\Synthetic\\AppData\\Local\\Cuefluent Notes\\v2');
});

test('explicit override is canonical and pure, including on a missing path', async t => {
  const directory = await temporary(t), target = path.join(directory, 'missing-v2');
  assert.equal(selectStoreRoot({ env: { CUEFLUENT_V2_HOME: target } }), target); assert.deepEqual(await readdir(directory), []);
  for (const value of ['', '.', '/tmp/../private', '/tmp/trailing/', '/']) assert.throws(() => selectStoreRoot({ env: { CUEFLUENT_V2_HOME: value }, platform: 'linux', homedir: '/home/synthetic' }), { code: 'ENTRY_ARGUMENT_INVALID' });
  let evaluated = false;
  assert.throws(() => selectStoreRoot({ env: Object.defineProperty({}, 'CUEFLUENT_V2_HOME', { get() { evaluated = true; return '/other'; } }) }), { code: 'ENTRY_ARGUMENT_INVALID' });
  assert.equal(evaluated, false);
  assert.throws(() => selectStoreRoot({ platform: 'unsupported' }), { code: 'ENTRY_PLATFORM_UNSUPPORTED' });
});

test('fixed installed skill wins over development and supplies exact native identities', async t => {
  const directory = await temporary(t); await development(directory);
  await mkdir(path.join(directory, 'skills', 'cuefluent-notes'), { recursive: true });
  const skillPath = path.join(directory, 'skills', 'cuefluent-notes', 'SKILL.md'); await writeFile(skillPath, '# Installed synthetic skill\n');
  const value = await loadClientContract(directory);
  assert.deepEqual(value, { packageRoot: directory, layout: 'installed', codex: { name: 'cuefluent-notes', skillPath }, claude: { name: 'cuefluent-notes:cuefluent-notes', source: 'plugin' } });
  assert.equal(Object.isFrozen(value.codex), true);
});

test('root skill fallback requires explicit development marker and never discovers other packages', async t => {
  const directory = await temporary(t); await development(directory);
  const value = await loadClientContract(directory); assert.equal(value.layout, 'development'); assert.equal(value.codex.skillPath, path.join(directory, 'SKILL.md'));
  await development(directory, { private: false }); await assert.rejects(loadClientContract(directory), { code: 'CLIENT_PACKAGE_INVALID' });
  await development(directory, { name: 'other-product' }); await assert.rejects(loadClientContract(directory), { code: 'CLIENT_PACKAGE_INVALID' });
  await writeFile(path.join(directory, 'package.json'), '{malformed'); await assert.rejects(loadClientContract(directory), { code: 'CLIENT_PACKAGE_INVALID' });
});

test('unsafe installed file cannot silently fall back to root skill', async t => {
  const directory = await temporary(t); await development(directory);
  await mkdir(path.join(directory, 'skills', 'cuefluent-notes'), { recursive: true });
  await link(path.join(directory, 'SKILL.md'), path.join(directory, 'skills', 'cuefluent-notes', 'SKILL.md'));
  await assert.rejects(loadClientContract(directory), { code: 'CLIENT_PACKAGE_INVALID' });
});

test('package loader refuses symlink skill and symlink ancestors', { skip: process.platform === 'win32' }, async t => {
  const directory = await temporary(t); await development(directory);
  await mkdir(path.join(directory, 'skills', 'cuefluent-notes'), { recursive: true });
  await symlink(path.join(directory, 'SKILL.md'), path.join(directory, 'skills', 'cuefluent-notes', 'SKILL.md'));
  await assert.rejects(loadClientContract(directory), { code: 'CLIENT_PACKAGE_INVALID' });
  const alias = `${directory}-alias`; await symlink(directory, alias); t.after(() => rm(alias, { force: true }));
  await assert.rejects(loadClientContract(alias), { code: 'PATH_UNSAFE' });
});


test('OS locations normalize separators without relaxing explicit arguments', () => {
  for (const home of ['/home/synthetic/', '/home//synthetic']) assert.equal(selectStoreRoot({ platform: 'linux', homedir: home, env: {} }), '/home/synthetic/.local/state/cuefluent-notes/v2');
  assert.equal(selectStoreRoot({ platform: 'linux', homedir: '/', env: {} }), '/.local/state/cuefluent-notes/v2');
  assert.equal(selectStoreRoot({ platform: 'linux', homedir: '/home/synthetic/', env: { XDG_STATE_HOME: 'relative' } }), '/home/synthetic/.local/state/cuefluent-notes/v2');
  assert.equal(selectStoreRoot({ platform: 'linux', homedir: '/', env: { XDG_STATE_HOME: '/state//' } }), '/state/cuefluent-notes/v2');
  assert.equal(selectStoreRoot({ platform: 'win32', homedir: 'C:/Users/Synthetic/', env: { LOCALAPPDATA: 'D:/Local Data/' } }), 'D:\\Local Data\\Cuefluent Notes\\v2');
  assert.throws(() => selectStoreRoot({ platform: 'linux', homedir: 'relative', env: {} }), { code: 'ENTRY_LOCATION_INVALID' });
  assert.throws(() => selectStoreRoot({ platform: 'win32', homedir: 'C:/Users/Synthetic', env: { LOCALAPPDATA: 'relative' } }), { code: 'ENTRY_LOCATION_INVALID' });
  assert.throws(() => parseEntryArguments(['setup', '--config', '/tmp/config/'], { platform: 'linux' }), { code: 'ENTRY_ARGUMENT_INVALID' });
});
