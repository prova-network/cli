// Tests for the api() wrapper's structured-error behaviour and the
// friendly-message mapper.
//
// We don't hit a real network here; we monkeypatch globalThis.fetch
// inside each test so we can craft canned responses and assert on the
// error shape that bubbles up.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { api, ApiError } from '../util/api.mjs';

const FAKE_BASE = 'https://prova-test.invalid';

let originalFetch;
before(() => {
  originalFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = originalFetch;
});

function withFetch(handler) {
  globalThis.fetch = async (url, init) => handler(url, init);
}

function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

test('api: 200 OK returns parsed JSON', async () => {
  withFetch(() => jsonResponse({ ok: true, n: 42 }));
  const r = await api('/api/health', {}, FAKE_BASE);
  assert.deepEqual(r, { ok: true, n: 42 });
});

test('api: 401 with code throws ApiError with friendlyMessage', async () => {
  withFetch(() => jsonResponse({ error: 'auth_token_expired', detail: 'Token has expired.' }, { status: 401 }));
  try {
    await api('/api/files', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ApiError, 'expected ApiError');
    assert.equal(err.status, 401);
    assert.equal(err.code, 'auth_token_expired');
    assert.equal(err.detail, 'Token has expired.');
    assert.match(err.friendlyMessage, /sign in again/i);
  }
});

test('api: 402 quota_exceeded gets the quota friendly message', async () => {
  withFetch(() => jsonResponse({ error: 'quota_exceeded', detail: 'Daily limit reached.' }, { status: 402 }));
  try {
    await api('/api/upload', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, 'quota_exceeded');
    assert.match(err.friendlyMessage, /quota/i);
  }
});

test('api: 429 with no error code falls back to status-based friendly', async () => {
  withFetch(() => jsonResponse({ detail: 'Throttled.' }, { status: 429 }));
  try {
    await api('/api/auth/start', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 429);
    assert.match(err.friendlyMessage, /rate-limited/i);
  }
});

test('api: piece_not_found surfaces retrieval guidance', async () => {
  withFetch(() => jsonResponse({ error: 'piece_not_found' }, { status: 404 }));
  try {
    await api('/p/baga6ea4...', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'piece_not_found');
    assert.match(err.friendlyMessage, /No active deal/i);
  }
});

test('api: unknown error code falls back to status table', async () => {
  withFetch(() => jsonResponse({ error: 'totally_invented_error_code' }, { status: 503 }));
  try {
    await api('/api/something', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'totally_invented_error_code');
    assert.match(err.friendlyMessage, /unavailable/i);
  }
});

test('api: completely unknown status returns a generic synthesized message', async () => {
  withFetch(() => jsonResponse({}, { status: 418 }));
  try {
    await api('/api/teapot', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 418);
    // Fallback line includes the status code itself.
    assert.match(err.friendlyMessage, /418/);
  }
});

test('api: non-JSON error body parses as text and still throws ApiError', async () => {
  withFetch(() => new Response('Internal Server Error', {
    status: 500,
    headers: { 'content-type': 'text/plain' },
  }));
  try {
    await api('/api/stuff', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 500);
    assert.equal(err.body, 'Internal Server Error');
    assert.match(err.friendlyMessage, /Server-side error/i);
  }
});

test('api: network error throws ApiError with code=network_error', async () => {
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' },
    });
  };
  try {
    await api('/api/health', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, 'network_error');
    assert.equal(err.status, 0);
    assert.match(err.friendlyMessage, /Network error|resolve/i);
  }
});

test('api: malformed JSON response body becomes a string sentinel', async () => {
  globalThis.fetch = async () => new Response('not-json{', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
  try {
    await api('/api/whatever', {}, FAKE_BASE);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    // Body is the sentinel string, not undefined.
    assert.equal(err.body, '<malformed JSON response>');
  }
});

test('api: opts.raw bypasses error handling and returns the Response', async () => {
  withFetch(() => new Response('raw bytes', { status: 503 }));
  const r = await api('/api/something', { raw: true }, FAKE_BASE);
  assert.equal(r.status, 503);
  assert.equal(await r.text(), 'raw bytes');
});

test('api: bearer token is set when opts.token is provided', async () => {
  let capturedAuth = null;
  withFetch((_url, init) => {
    capturedAuth = init.headers.get('authorization');
    return jsonResponse({ ok: true });
  });
  await api('/api/whatever', { token: 'pk_live_xxx' }, FAKE_BASE);
  assert.equal(capturedAuth, 'Bearer pk_live_xxx');
});

test('api: opts.json sets content-type and serializes body', async () => {
  let capturedCT = null;
  let capturedBody = null;
  withFetch((_url, init) => {
    capturedCT = init.headers.get('content-type');
    capturedBody = init.body;
    return jsonResponse({ ok: true });
  });
  await api('/api/something', { method: 'POST', json: { a: 1 } }, FAKE_BASE);
  assert.equal(capturedCT, 'application/json');
  assert.equal(capturedBody, '{"a":1}');
});
