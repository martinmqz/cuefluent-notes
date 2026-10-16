import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveClaudeLaunchSettings, validateClaudeRestrictedSettings, claudeProfileLocator, resolveClaudeProfile } from './processing-claude-settings.mjs';

async function fixture(t, content = '{}') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cuefluent-provider-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  if (content !== null) await fs.writeFile(file, content, { mode: 0o600 });
  return { root, file, env: { CLAUDE_CONFIG_DIR: root, PATH: 'synthetic-native-path' } };
}

for (const platform of ['linux', 'win32']) for (const [account, configured] of [
  ['native account login', {}],
  ['API key', { ANTHROPIC_API_KEY: 'synthetic-selected-key' }],
  ['Foundry', { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'https://selected.example.invalid' }],
  ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'synthetic-selected-profile' }],
  ['Vertex', { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'synthetic-selected-project' }]
]) test(`explicit native-profile authentication isolates ${account} from Desktop routing on ${platform}`, async t => {
  const content = JSON.stringify({ env: configured });
  const f = await fixture(t, content);
  const env = { ...f.env, CUEFLUENT_CLAUDE_AUTHENTICATION: 'native-profile',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'SYNTHETIC_DESKTOP_TOKEN',
    SYNTHETIC_DESKTOP_TOKEN: 'synthetic-host-secret', CLAUDE_CODE_HOST_CREDS_FILE: 'synthetic-host-store',
    ANTHROPIC_BASE_URL: 'https://host.example.invalid', ANTHROPIC_UNIX_SOCKET: 'synthetic-host-socket',
    CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-host-key',
    AWS_PROFILE: 'synthetic-host-profile', AZURE_CLIENT_SECRET: 'synthetic-host-azure-secret',
    GOOGLE_APPLICATION_CREDENTIALS: 'synthetic-host-google-file', ANTHROPIC_MODEL: 'synthetic-host-model',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', HTTPS_PROXY: 'https://proxy.example.invalid', CLAUDECODE: '1' };
  if (platform === 'win32') {
    env.cuefluent_claude_authentication = env.CUEFLUENT_CLAUDE_AUTHENTICATION;
    delete env.CUEFLUENT_CLAUDE_AUTHENTICATION;
    env.synthetic_desktop_token = env.SYNTHETIC_DESKTOP_TOKEN;
    delete env.SYNTHETIC_DESKTOP_TOKEN;
  }
  const before = { ...env };
  const result = await resolveClaudeLaunchSettings(env, { platform, preferHostEnvironment: true });
  assert.deepEqual(result.env, { ...f.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    HTTPS_PROXY: 'https://proxy.example.invalid', ...configured });
  assert.deepEqual(result.settings, { disableAllHooks: true });
  assert.deepEqual(env, before);
  assert.equal(await fs.readFile(f.file, 'utf8'), content);
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
});

test('invalid authentication selection refuses before reading native settings', async t => {
  const f = await fixture(t, '{invalid');
  for (const selection of ['', 'automatic', 'profile', 'NATIVE-PROFILE']) {
    await assert.rejects(resolveClaudeLaunchSettings({ ...f.env, CUEFLUENT_CLAUDE_AUTHENTICATION: selection }),
      { code: 'PROCESSING_CLIENT_AUTHENTICATION_INVALID' });
  }
  await assert.rejects(resolveClaudeLaunchSettings({ ...f.env,
    CUEFLUENT_CLAUDE_AUTHENTICATION: 'inherit', cuefluent_claude_authentication: 'native-profile' },
  { platform: 'win32' }), { code: 'PROCESSING_CLIENT_AUTHENTICATION_INVALID' });
});

for (const content of [null, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'synthetic-profile-token' } })]) {
  test(`missing host auth cannot fall back to ${content === null ? 'native login' : 'profile credentials'}`, async t => {
    const f = await fixture(t, content);
    const env = { ...f.env, CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' };
    for (const credential of [undefined, '', '   ']) {
      if (credential === undefined) delete env.ANTHROPIC_AUTH_TOKEN; else env.ANTHROPIC_AUTH_TOKEN = credential;
      const before = { ...env };
      await assert.rejects(resolveClaudeLaunchSettings(env, { preferHostEnvironment: true }), error =>
        error.code === 'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE' && error.message === error.code && error.cause === undefined);
      assert.deepEqual(env, before);
    }
    if (content === null) assert.deepEqual(await fs.readdir(f.root), []);
    else assert.equal(await fs.readFile(f.file, 'utf8'), content);
  });
}

for (const platform of ['linux', 'win32']) test(`inherited host credential keeps its exact value and spelling on ${platform}`, async t => {
  const f = await fixture(t);
  const name = platform === 'win32' ? 'synthetic_host_token' : 'SYNTHETIC_HOST_TOKEN';
  const marker = platform === 'win32' ? 'claude_code_host_auth_env_var' : 'CLAUDE_CODE_HOST_AUTH_ENV_VAR';
  const env = { ...f.env, [marker]: 'SYNTHETIC_HOST_TOKEN', [name]: 'synthetic-host-token' };
  assert.deepEqual((await resolveClaudeLaunchSettings(env, { platform })).env, env);
  if (platform === 'linux') {
    delete env[name]; env.synthetic_host_token = 'synthetic-wrong-case-token';
    await assert.rejects(resolveClaudeLaunchSettings(env, { platform }), { code: 'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE' });
  }
});

for (const marker of [{ CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN', ANTHROPIC_AUTH_TOKEN: 'synthetic-host-token' },
  { CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN', ANTHROPIC_AUTH_TOKEN: 'synthetic-host-token' }]) {
  test(`host-managed routing never fills missing account fields from user settings: ${Object.keys(marker)[0]}`, async t => {
    const f = await fixture(t, JSON.stringify({ env: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_API_KEY: 'synthetic-profile-key',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-profile-token', ANTHROPIC_BASE_URL: 'https://profile.example.invalid' } }));
    const env = { ...f.env, ...marker, CLAUDE_CODE_USE_FOUNDRY: '', ANTHROPIC_BASE_URL: 'https://host.example.invalid' };
    for (const preferHostEnvironment of [false, true]) {
      assert.deepEqual((await resolveClaudeLaunchSettings(env, { preferHostEnvironment })).env, env);
    }
  });
}

for (const name of ['bad=name', 'x'.repeat(257), 'CLAUDECODE', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CUEFLUENT_ENGINE_TOKEN', 'PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'HTTPS_PROXY', 'ANTHROPIC_BASE_URL']) {
  test(`unusable host credential locator is refused without exposing it: ${name.length > 40 ? 'over limit' : name}`, async t => {
    const f = await fixture(t);
    const env = { ...f.env, [name]: 'synthetic-value', CLAUDE_CODE_HOST_AUTH_ENV_VAR: name };
    await assert.rejects(resolveClaudeLaunchSettings(env), { code: 'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE' });
  });
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
    HTTPS_PROXY: 'https://example.invalid', NODE_EXTRA_CA_CERTS: 'synthetic-certificate-locator', CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'synthetic-passphrase',
    API_TIMEOUT_MS: '600000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096', MAX_THINKING_TOKENS: '1024' }],
  ['POSIX lowercase proxies', { http_proxy: 'https://http.example.invalid', https_proxy: 'https://https.example.invalid',
    all_proxy: 'https://all.example.invalid', no_proxy: 'localhost' }]
]) test(`${name} user env is restored without loading profile hooks or unrelated execution controls`, async t => {
  const f = await fixture(t, JSON.stringify({ env: { ...env, PATH: 'unsafe-profile-path', NODE_OPTIONS: '--require synthetic-unsafe-loader',
    CUEFLUENT_ENGINE_TOKEN: 'unsafe-profile-engine-token', CLAUDE_CONFIG_DIR: 'unsafe-profile', CLAUDECODE: 'unsafe-parent',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'synthetic-unrelated' },
    hooks: { SessionStart: 'synthetic-forbidden-hook' }, enabledPlugins: { 'synthetic@plugin': true },
    permissions: { defaultMode: 'bypassPermissions' } }));
  const bytes = await fs.readFile(f.file), original = { ...f.env };
  const result = await resolveClaudeLaunchSettings(f.env, { platform: name === 'POSIX lowercase proxies' ? 'linux' : process.platform });
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
  ['NUL credential', '{"env":{"ANTHROPIC_API_KEY":"x\\u0000y"}}'],
  ['unpaired surrogate credential', '{"env":{"ANTHROPIC_API_KEY":"\\ud800"}}'],
  ['invalid model', '{"model":false}'], ['null model', '{"model":null}'], ['invalid overrides', '{"modelOverrides":{"synthetic":false}}'],
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

test('known unsupported providers are refused while feature toggles are ignored', async t => {
  const f = await fixture(t);
  for (const input of ['1', 'true', 'YES', ' on ']) {
    for (const provider of ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD']) {
      await fs.writeFile(f.file, JSON.stringify({ env: { [provider]: input } }));
      await assert.rejects(resolveClaudeLaunchSettings(f.env), { code: 'PROCESSING_CLIENT_SETTINGS_UNSUPPORTED' });
    }
  }
  for (const input of ['', '0', 'false', 'False', 'no', 'off', 'OFF', 'disabled']) {
    await fs.writeFile(f.file, JSON.stringify({ env: { CLAUDE_CODE_USE_ANTHROPIC_AWS: input } }));
    assert.deepEqual((await resolveClaudeLaunchSettings(f.env)).env, f.env);
  }
  const bytes = JSON.stringify({ env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', CLAUDE_CODE_USE_SYNTHETIC_FEATURE: 'true',
    BASH_DEFAULT_TIMEOUT_MS: 600000, NODE_OPTIONS: { ignored: true }, PATH: null, ANTHROPIC_API_KEY: 'synthetic-permitted-key' } });
  await fs.writeFile(f.file, bytes);
  const result = await resolveClaudeLaunchSettings(f.env);
  assert.deepEqual(result.env, { ...f.env, ANTHROPIC_API_KEY: 'synthetic-permitted-key' });
  assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
});

test('profile lookup keeps native casing/spelling and emits only a safe unavailable code', async t => {
  const f = await fixture(t);
  assert.equal(claudeProfileLocator({ claude_config_dir: f.root }, 'win32'), f.root);
  assert.equal(await resolveClaudeProfile(f.env), f.root);
  await assert.rejects(resolveClaudeProfile({ CLAUDE_CONFIG_DIR: path.join(f.root, 'missing-private-profile') }), error =>
    error.code === 'PROCESSING_CLIENT_SETTINGS_UNAVAILABLE' && error.message === error.code && error.cause === undefined);
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

test('POSIX proxy aliases cannot replace an exported host proxy in host mode', async t => {
  const f = await fixture(t, JSON.stringify({ env: { https_proxy: 'https://user.example.invalid',
    NO_PROXY: 'user.example.invalid' } }));
  const env = { ...f.env, HTTPS_PROXY: 'https://host.example.invalid', no_proxy: 'host.example.invalid' };
  const host = await resolveClaudeLaunchSettings(env, { platform: 'linux', preferHostEnvironment: true });
  assert.deepEqual(host.env, env);
  const cli = await resolveClaudeLaunchSettings(env, { platform: 'linux' });
  assert.equal(cli.env.https_proxy, 'https://user.example.invalid'); assert.equal(cli.env.NO_PROXY, 'user.example.invalid');
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

for (const flag of ['1', 'true', 'yes', 'on']) test(`managed host ${flag} requires an explicit credential locator`, async t => {
  const f = await fixture(t, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'synthetic-profile' } }));
  for (const locator of [undefined, '']) {
    const env = { ...f.env, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: flag, ANTHROPIC_API_KEY: 'synthetic-inherited' };
    if (locator !== undefined) env.CLAUDE_CODE_HOST_AUTH_ENV_VAR = locator;
    await assert.rejects(resolveClaudeLaunchSettings(env), { code: 'PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE' });
  }
});
for (const flag of ['0', 'false', 'no', 'off', '']) test(`disabled managed host ${flag} preserves profile projection`, async t => {
  const f = await fixture(t, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'synthetic-profile' } }));
  const result = await resolveClaudeLaunchSettings({ ...f.env, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: flag });
  assert.equal(result.env.ANTHROPIC_API_KEY, 'synthetic-profile');
});
for (const platform of ['linux', 'win32']) test(`host-managed connection defaults preserve account and host overrides on ${platform}`, async t => {
  const connection = { HTTPS_PROXY: 'https://proxy.example.invalid', NODE_EXTRA_CA_CERTS: 'synthetic-ca.pem', API_TIMEOUT_MS: '1234',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000', MAX_THINKING_TOKENS: '500' };
  const f = await fixture(t, JSON.stringify({ env: { ...connection, HTTP_PROXY: 'https://unused.example.invalid',
    CLAUDE_CODE_CLIENT_CERT: 'synthetic-other-identity.pem', CLAUDE_CODE_CLIENT_KEY: 'synthetic-other-key.pem',
    CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_AUTH_TOKEN: 'synthetic-profile', ANTHROPIC_BASE_URL: 'https://unused.example.invalid',
    CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }, apiKeyHelper: 'must-not-run', awsAuthRefresh: 'must-not-run',
    awsCredentialExport: 'must-not-run', gcpAuthRefresh: 'must-not-run' }));
  const inheritedProxy = platform === 'win32' ? 'Http_Proxy' : 'http_proxy';
  const env = { ...f.env, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN',
    ANTHROPIC_AUTH_TOKEN: 'synthetic-host', [inheritedProxy]: 'https://host-proxy.example.invalid' };
  const before = { ...env };
  const result = await resolveClaudeLaunchSettings(env, { platform });
  assert.deepEqual(result.env, { ...env, ...connection });
  assert.deepEqual(env, before);
});
