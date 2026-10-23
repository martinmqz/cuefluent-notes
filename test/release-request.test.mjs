import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubRequest, releaseErrorMessage, selectReleaseCandidate } from '../tools/release-candidate.mjs';

test('GitHub request pins the PR representation required for merge ancestry and bounds transport', async () => {
  const mergeSha = 'a'.repeat(40), token = 'synthetic-token';
  const request = createGitHubRequest({ token, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/project/pulls/40');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    // The 2026 representation omits the field, as observed against a merged PR.
    return Response.json(options.headers['X-GitHub-Api-Version'] === '2022-11-28'
      ? { merged: true, merge_commit_sha: mergeSha } : { merged: true });
  } });
  assert.equal((await request('/repos/example/project/pulls/40')).merge_commit_sha, mergeSha);
});

test('HTTP and timeout errors retain their causes with safe useful diagnostics', async () => {
  const token = 'synthetic-private-token', secret = 'synthetic-sensitive-payload';
  const http = createGitHubRequest({ token, fetchImpl: async () => new Response(secret, { status: 404 }) });
  await assert.rejects(http('/repos/example/project/pulls/40'), error => {
    assert.equal(error.code, 'RELEASE_EVIDENCE_INVALID');
    assert.equal(error.releaseStage, 'api');
    assert.equal(error.reason, 'HTTP_404');
    assert.equal(error.cause.reason, 'HTTP_404');
    assert.match(releaseErrorMessage(error), /api.*HTTP_404/);
    assert(!releaseErrorMessage(error).includes(secret));
    assert(!releaseErrorMessage(error).includes(token));
    return true;
  });
  const cause = new DOMException(secret, 'TimeoutError');
  const timeout = createGitHubRequest({ token, fetchImpl: async () => { throw cause; } });
  await assert.rejects(timeout('/repos/example/project/actions/runs/42'), error => {
    assert.equal(error.cause, cause);
    assert.match(releaseErrorMessage(error), /api.*REQUEST_TIMEOUT/);
    assert(!releaseErrorMessage(error).includes(secret));
    return true;
  });
});

test('GitHub response limits reject declared and streamed oversized bodies before JSON decoding', async () => {
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
  for (const response of [new Response('{}', { headers: { 'content-length': String(oversized.length) } }), new Response(oversized)]) {
    const request = createGitHubRequest({ token: 'synthetic', fetchImpl: async () => response });
    await assert.rejects(request('/repos/example/project/actions/runs/42'), { code: 'RELEASE_EVIDENCE_INVALID', reason: 'API_RESPONSE_TOO_LARGE' });
  }
  const invalid = createGitHubRequest({ token: 'synthetic', fetchImpl: async () => new Response('{bad-json}') });
  await assert.rejects(invalid('/repos/example/project/actions/runs/42'), { code: 'RELEASE_EVIDENCE_INVALID', reason: 'INVALID_JSON' });
});

test('argument failures identify the refused contract without echoing the supplied value', async () => {
  await assert.rejects(selectReleaseCandidate({ env: { RELEASE_TAG: 'sensitive-invalid-tag' } }), error => {
    assert.equal(error.reason, 'TAG_INVALID');
    assert.equal(error.cause.reason, 'TAG_INVALID');
    assert.match(releaseErrorMessage(error), /selection.*TAG_INVALID/);
    assert(!releaseErrorMessage(error).includes('sensitive-invalid-tag'));
    return true;
  });
});
