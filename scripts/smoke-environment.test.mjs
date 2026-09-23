import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { smokeEnvironment } from './smoke-environment.mjs';

test('smoke environment excludes credentials, client overrides and user configuration', () => {
  const secrets = ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS',
    'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'NODE_OPTIONS', 'NODE_PATH',
    'npm_config_registry', 'NPM_CONFIG_USERCONFIG', 'OPENAI_API_KEY'];
  const root = path.join(os.tmpdir(), 'synthetic-smoke');
  const env = smokeEnvironment(root, { PATH: 'selected path', HOME: 'real home',
    ...Object.fromEntries(secrets.map(key => [key, 'synthetic sentinel'])) });
  assert.equal(env.PATH, 'selected path');
  assert.ok(!Object.values(env).includes('synthetic sentinel'));
  assert.ok(!Object.values(env).includes('real home'));
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'npm_config_cache', 'npm_config_userconfig']) {
    assert.ok(env[key].startsWith(root + path.sep), key);
  }
});
