import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveClaudeLaunchSettings, validateClaudeRestrictedSettings } from './processing-claude-settings.mjs';

async function fixture(t, content = '{}') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-provider-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  if (content !== null) await fs.writeFile(file, content, { mode: 0o600 });
  return { root, file, env: { CLAUDE_CONFIG_DIR: root, PATH: 'synthetic-native-path' } };
}

test('missing native user settings preserve a copied host environment without writes', async t => {
  const f = await fixture(t, null);
  f.env['ProgramFiles(x86)'] = 'synthetic Windows host field';
  f.env.LARGE_HOST_FIELD = 'x'.repeat(32769);
  const result = await resolveClaudeLaunchSettings(f.env);
  assert.deepEqual(result.env, f.env); assert.notEqual(result.env, f.env);
  assert.deepEqual(result.settings, { disableAllHooks: true });
  assert.deepEqual(await fs.readdir(f.root), []);
});

for (const [name, env] of [
  ['Foundry', { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'synthetic-resource',
    ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-foundry-key', CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1', AZURE_CLIENT_ID: 'synthetic-client', AZURE_TENANT_ID: 'synthetic-tenant' }],
  ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'synthetic-profile', AWS_REGION: 'synthetic-region',
    AWS_BEARER_TOKEN_BEDROCK: 'synthetic-bedrock-token', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', ANTHROPIC_BEDROCK_REGION_PREFIX: 'synthetic-prefix' }],
  ['Bedrock Mantle', { CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_SKIP_MANTLE_AUTH: '1',
    ANTHROPIC_BEDROCK_MANTLE_BASE_URL: 'https://example.invalid', AWS_REGION: 'synthetic-region' }],
  ['Vertex', { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'synthetic-region', ANTHROPIC_VERTEX_PROJECT_ID: 'synthetic-project',
    GOOGLE_APPLICATION_CREDENTIALS: 'synthetic-credential-locator', CLAUDE_CODE_SKIP_VERTEX_AUTH: '1', VERTEX_REGION_CLAUDE_FUTURE_MODEL: 'synthetic-region' }],
  ['first-party and gateway', { ANTHROPIC_API_KEY: 'synthetic-api-key', ANTHROPIC_AUTH_TOKEN: 'synthetic-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth', ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_CUSTOM_HEADERS: 'Synthetic: header' }],
  ['deployment and network', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'synthetic-opus-deployment', ANTHROPIC_DEFAULT_SONNET_MODEL: 'synthetic-sonnet-deployment',
    HTTPS_PROXY: 'https://example.invalid', NODE_EXTRA_CA_CERTS: 'synthetic-certificate-locator', CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'synthetic-passphrase' }]
]) test(`${name} user env is restored without loading profile hooks or unrelated execution controls`, async t => {
  const f = await fixture(t, JSON.stringify({ env: { ...env, PATH: 'unsafe-profile-path', NODE_OPTIONS: '--require synthetic-unsafe-loader',
    CUEFLUENT_ENGINE_TOKEN: 'unsafe-profile-engine-token', CLAUDE_CONFIG_DIR: 'unsafe-profile', CLAUDECODE: 'unsafe-parent',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'synthetic-unrelated' },
    hooks: { SessionStart: 'synthetic-forbidden-hook' }, enabledPlugins: { 'synthetic@plugin': true },
    permissions: { defaultMode: 'bypassPermissions' } }));
  const bytes = await fs.readFile(f.file), original = { ...f.env };
  const result = await resolveClaudeLaunchSettings(f.env);
  assert.deepEqual(result.env, { ...f.env, ...env });
  assert.deepEqual(result.settings, { disableAllHooks: true });
  assert.deepEqual(f.env, original); assert((await fs.readFile(f.file)).equals(bytes));
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
});

test('user env precedence matches native settings and only explicit model preferences are retained', async t => {
  const f = await fixture(t, JSON.stringify({ model: 'synthetic-profile-model', effortLevel: 'xhigh',
    modelOverrides: { 'synthetic-model': 'synthetic-deployment' }, availableModels: ['synthetic-model'],
    env: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-profile-key' } }));
  f.env.CLAUDE_CODE_USE_FOUNDRY = '0'; f.env.ANTHROPIC_FOUNDRY_API_KEY = 'synthetic-shell-key';
  let result = await resolveClaudeLaunchSettings(f.env);
  assert.equal(result.env.CLAUDE_CODE_USE_FOUNDRY, '1');
  assert.equal(result.env.ANTHROPIC_FOUNDRY_API_KEY, 'synthetic-profile-key');
  assert.equal(Object.hasOwn(result.env, 'ANTHROPIC_MODEL'), false);
  assert.deepEqual(result.settings, { disableAllHooks: true, model: 'synthetic-profile-model', modelOverrides: { 'synthetic-model': 'synthetic-deployment' }, availableModels: ['synthetic-model'] });
  f.env.ANTHROPIC_MODEL = 'synthetic-explicit-model';
  result = await resolveClaudeLaunchSettings(f.env);
  assert.equal(result.env.ANTHROPIC_MODEL, 'synthetic-explicit-model');
  await fs.writeFile(f.file, '{}');
  result = await resolveClaudeLaunchSettings(f.env);
  assert.equal(result.env.CLAUDE_CODE_USE_FOUNDRY, '0');
  assert.equal(result.env.ANTHROPIC_FOUNDRY_API_KEY, 'synthetic-shell-key');
  assert.equal(result.env.ANTHROPIC_MODEL, 'synthetic-explicit-model');
});

for (const helper of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh']) {
  test(`configured ${helper} is refused without executing or leaking the command`, async t => {
    const f = await fixture(t, JSON.stringify({ [helper]: 'synthetic-private-command', env: { ANTHROPIC_API_KEY: 'synthetic-private-key' } }));
    await assert.rejects(resolveClaudeLaunchSettings(f.env), error => error.code === 'PROCESSING_CLIENT_SETTINGS_UNSUPPORTED' &&
      !error.message.includes('synthetic-private') && error.cause === undefined);
    assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
  });
}

test('disabled credential helpers do not block ordinary inherited authentication', async t => {
  const f = await fixture(t, JSON.stringify({ apiKeyHelper: '', awsAuthRefresh: null }));
  assert.deepEqual((await resolveClaudeLaunchSettings(f.env)).env, f.env);
});

for (const [label, text] of [
  ['malformed JSON', '{"env":{"ANTHROPIC_API_KEY":"synthetic-private-key"'],
  ['duplicate env names', '{"env":{"CLAUDE_CODE_USE_FOUNDRY":"1","CLAUDE_CODE_USE_FOUNDRY":"0"}}'],
  ['duplicate root env', '{"env":{},"env":{"ANTHROPIC_API_KEY":"synthetic-private-key"}}'],
  ['non-object settings', '[]'], ['non-object env', '{"env":[]}'], ['non-string env value', '{"env":{"ANTHROPIC_API_KEY":123}}'],
  ['invalid ignored env value', '{"env":{"NODE_OPTIONS":123}}'], ['NUL credential', '{"env":{"ANTHROPIC_API_KEY":"x\\u0000y"}}'],
  ['unpaired surrogate credential', '{"env":{"ANTHROPIC_API_KEY":"\\ud800"}}'],
  ['invalid model', '{"model":false}'], ['invalid overrides', '{"modelOverrides":{"synthetic":false}}'],
  ['invalid model allowlist', '{"availableModels":[false]}'],
]) test(`${label} fails with a safe diagnostic and unchanged settings`, async t => {
  const f = await fixture(t, text), bytes = await fs.readFile(f.file);
  await assert.rejects(resolveClaudeLaunchSettings(f.env), error => error.code === 'PROCESSING_CLIENT_SETTINGS_INVALID' &&
    error.message === error.code && error.cause === undefined);
  assert((await fs.readFile(f.file)).equals(bytes));
});

test('invalid UTF-8, oversized files and excessive structure are bounded', async t => {
  const f = await fixture(t, Buffer.from([0xff]));
  await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_INVALID' });
  await fs.writeFile(f.file, 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_LIMIT' });
  let deep = {}; for (let i = 0; i < 35; i++) deep = { nested: deep };
  await fs.writeFile(f.file, JSON.stringify(deep));
  await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_LIMIT' });
  await fs.writeFile(f.file, JSON.stringify({ unrelated: Array.from({ length: 8192 }, () => 0) }));
  await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_LIMIT' });
});

test('directories and unavailable profiles cannot silently fall back to another provider', async t => {
  const f = await fixture(t, null); await fs.mkdir(f.file);
  await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' });
  await assert.rejects(resolveClaudeLaunchSettings({ CLAUDE_CONFIG_DIR: 'relative-profile' }), { code: 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' });
  await assert.rejects(resolveClaudeLaunchSettings({ CLAUDE_CONFIG_DIR: path.join(f.root, 'missing') }), { code: 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' });
});

test('restricted settings accept only model controls and disabled hooks', () => {
  for (const settings of [null, { disableAllHooks: false }, { disableAllHooks: true, env: {} },
    { disableAllHooks: true, hooks: {} }, { disableAllHooks: true, enabledPlugins: {} },
    { disableAllHooks: true, apiKeyHelper: 'synthetic-command' }, { disableAllHooks: true, effortLevel: 'xhigh' },
    { disableAllHooks: true, modelSettings: { synthetic: { effortLevel: 'low' } } }]) {
    assert.throws(() => validateClaudeRestrictedSettings(settings), { code: 'PROCESSING_CLIENT_SETTINGS_INVALID' });
  }
  assert.throws(() => validateClaudeRestrictedSettings({ disableAllHooks: true,
    modelOverrides: { synthetic: 'x'.repeat(16 * 1024) } }), { code: 'PROCESSING_CLIENT_SETTINGS_LIMIT' });
});

test('stored effort preferences are not promoted into global launch overrides and explicit native env remains supported', async t => {
  const f = await fixture(t, JSON.stringify({ model: 'claude-opus-5-5', effortLevel: 'xhigh',
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } }));
  const bytes = await fs.readFile(f.file);
  let result = await resolveClaudeLaunchSettings(f.env);
  assert.deepEqual(result.settings, { disableAllHooks: true, model: 'claude-opus-5-5' });
  assert.equal(Object.hasOwn(result.env, 'CLAUDE_CODE_EFFORT_LEVEL'), false);
  assert((await fs.readFile(f.file)).equals(bytes));
  await fs.writeFile(f.file, JSON.stringify({ effortLevel: 'xhigh', modelSettings: { synthetic: { effortLevel: 'low' } },
    env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' } }));
  result = await resolveClaudeLaunchSettings(f.env);
  assert.deepEqual(result.settings, { disableAllHooks: true });
  assert.equal(result.env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
});

test('unknown enabled provider switches are refused instead of silently selecting first-party', async t => {
  const f = await fixture(t);
  for (const input of ['1', 'true', 'YES', ' on ']) {
    await fs.writeFile(f.file, JSON.stringify({ env: { CLAUDE_CODE_USE_SYNTHETIC_FUTURE_PROVIDER: input } }));
    await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_UNSUPPORTED' });
  }
  for (const input of ['', '0', 'false', 'False', 'no', 'off', 'OFF', 'disabled']) {
    await fs.writeFile(f.file, JSON.stringify({ env: { CLAUDE_CODE_USE_SYNTHETIC_FUTURE_PROVIDER: input } }));
    assert.deepEqual((await resolveClaudeLaunchSettings(f.env)).env, f.env);
  }
});

test('Windows profile env casing replaces inherited aliases and refuses ambiguous settings aliases', async t => {
  const f = await fixture(t, '{"env":{"claude_code_use_foundry":"1","anthropic_api_key":"synthetic-profile-key"}}');
  f.env.anthropic_api_key = 'synthetic-inherited-key';
  f.env.ANTHROPIC_API_KEY = 'synthetic-inherited-uppercase-key';
  f.env['ProgramFiles(x86)'] = 'synthetic-os-field';
  const windows = await resolveClaudeLaunchSettings(f.env, { platform: 'win32' });
  assert.equal(windows.env.CLAUDE_CODE_USE_FOUNDRY, '1');
  assert.equal(windows.env.ANTHROPIC_API_KEY, 'synthetic-profile-key');
  assert.equal(Object.hasOwn(windows.env, 'anthropic_api_key'), false);
  assert.equal(windows.env['ProgramFiles(x86)'], 'synthetic-os-field');
  const posix = await resolveClaudeLaunchSettings(f.env, { platform: 'linux' });
  assert.deepEqual(posix.env, f.env);
  await fs.writeFile(f.file, '{"model":"synthetic-profile-model"}');
  f.env.anthropic_model = 'synthetic-explicit-lowercase-model';
  const model = await resolveClaudeLaunchSettings(f.env, { platform: 'win32' });
  assert.equal(model.env.anthropic_model, 'synthetic-explicit-lowercase-model');
  assert.equal(Object.hasOwn(model.env, 'ANTHROPIC_MODEL'), false);
  delete f.env.anthropic_model; f.env.undefined = 'synthetic-unrelated-variable';
  const preference = await resolveClaudeLaunchSettings(f.env, { platform: 'win32' });
  assert.equal(preference.settings.model, 'synthetic-profile-model');
  assert.equal(Object.hasOwn(preference.env, 'ANTHROPIC_MODEL'), false);
  await fs.writeFile(f.file, '{"env":{"ANTHROPIC_API_KEY":"synthetic-one","anthropic_api_key":"synthetic-two"}}');
  await assert.rejects(resolveClaudeLaunchSettings(f.env, { platform: 'win32' }), { code: 'PROCESSING_CLIENT_SETTINGS_INVALID' });
});

test('native profile locator spelling is preserved and a changed bound profile is refused', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, '{"env":{"CLAUDE_CODE_USE_FOUNDRY":"1"}}'), alias = path.join(f.root, 'alias');
  await fs.symlink(f.root, alias, 'dir');
  const env = { ...f.env, CLAUDE_CONFIG_DIR: alias };
  assert.equal((await resolveClaudeLaunchSettings(env, { expectedProfile: f.root })).env.CLAUDE_CONFIG_DIR, alias);
  assert.equal(env.CLAUDE_CONFIG_DIR, alias);
  await assert.rejects(resolveClaudeLaunchSettings(env, { expectedProfile: path.join(f.root, 'other-profile') }),
    { code: 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' });
});

test('an unset native profile locator stays unset without consulting a real profile', async t => {
  const f = await fixture(t), profile = path.join(f.root, '.claude'); await fs.mkdir(profile);
  await fs.rename(f.file, path.join(profile, 'settings.json'));
  t.mock.method(os, 'homedir', () => f.root);
  const env = { PATH: 'synthetic-native-path' };
  const result = await resolveClaudeLaunchSettings(env, { expectedProfile: profile });
  assert.deepEqual(result.env, env); assert.equal(Object.hasOwn(result.env, 'CLAUDE_CONFIG_DIR'), false);
});

test('verified source-host env overrides profile defaults while bare CLI keeps native user precedence', async t => {
  const f = await fixture(t, JSON.stringify({ env: { AWS_PROFILE: 'synthetic-user-profile',
    ANTHROPIC_BASE_URL: 'https://user.example.invalid', ANTHROPIC_MODEL: 'synthetic-user-model',
    ANTHROPIC_FOUNDRY_RESOURCE: 'synthetic-fallback-resource' } }));
  const env = { ...f.env, AWS_PROFILE: 'synthetic-source-profile', ANTHROPIC_BASE_URL: 'https://source.example.invalid',
    ANTHROPIC_MODEL: 'synthetic-source-model' };
  const native = await resolveClaudeLaunchSettings(env, { preferHostEnvironment: true });
  assert.equal(native.env.AWS_PROFILE, env.AWS_PROFILE); assert.equal(native.env.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
  assert.equal(native.env.ANTHROPIC_MODEL, env.ANTHROPIC_MODEL); assert.equal(native.env.ANTHROPIC_FOUNDRY_RESOURCE, 'synthetic-fallback-resource');
  const cli = await resolveClaudeLaunchSettings(env);
  assert.equal(cli.env.AWS_PROFILE, 'synthetic-user-profile'); assert.equal(cli.env.ANTHROPIC_MODEL, 'synthetic-user-model');
  const windows = await resolveClaudeLaunchSettings({ ...f.env, aws_profile: 'synthetic-lowercase-source' },
    { platform: 'win32', preferHostEnvironment: true });
  assert.equal(windows.env.aws_profile, 'synthetic-lowercase-source'); assert.equal(Object.hasOwn(windows.env, 'AWS_PROFILE'), false);
});

test('settings file replacement at its existing canonical path is refused', async t => {
  const f = await fixture(t, '{"env":{"CLAUDE_CODE_USE_FOUNDRY":"1"}}');
  const replacement = path.join(f.root, 'replacement.json'); await fs.writeFile(replacement, '{}');
  const realpath = fs.realpath; let reads = 0;
  t.mock.method(fs, 'realpath', async (...args) => {
    if (args[0] === f.file && ++reads === 2) await fs.rename(replacement, f.file);
    return realpath(...args);
  });
  await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' });
});

test('a newly appearing settings file cannot turn missing-file fallback into a different provider', async t => {
  const f = await fixture(t, null), lstat = fs.lstat; let reads = 0;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (args[0] === f.file && ++reads === 2) await fs.writeFile(f.file, '{"env":{"CLAUDE_CODE_USE_FOUNDRY":"1"}}');
    return lstat(...args);
  });
  await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' });
});

test('settings alias replacement during reading is refused', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, null), first = path.join(f.root, 'first.json'), second = path.join(f.root, 'second.json');
  await fs.writeFile(first, JSON.stringify({ env: { CLAUDE_CODE_USE_FOUNDRY: '1' } }));
  await fs.writeFile(second, '{}'); await fs.symlink(first, f.file);
  assert.equal((await resolveClaudeLaunchSettings(f.env)).env.CLAUDE_CODE_USE_FOUNDRY, '1');
  const realpath = fs.realpath;
  let reads = 0;
  t.mock.method(fs, 'realpath', async (...args) => {
    if (args[0] === f.file && ++reads === 2) { await fs.unlink(f.file); await fs.symlink(second, f.file); }
    return realpath(...args);
  });
  await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' });
});
