/** Exercises the OAuth boundary with real loopback requests and a synthetic HTTPS provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudAuth, OAuthError } from '../src/oauth.ts';
import type { CredentialStore } from '../src/oauth.ts';
import { credentialKey } from '../src/credential-session.ts';
const resource = 'https://issues.example';
const issuer = 'https://identity.example';
class MemoryStore implements CredentialStore {
  entries = new Map<string, string>();
  failWrite = false;
  failDelete = false;
  async read(key: string) { return this.entries.get(key) ?? null; }
  async write(key: string, value: string) { if (this.failWrite) throw new Error('store unavailable'); this.entries.set(key, value); }
  async delete(key: string) { if (this.failDelete) throw new Error('store delete unavailable'); this.entries.delete(key); }
}
async function fixture(t: test.TestContext, providerIssuer = issuer) {
  const issuer = providerIssuer;
  const stateDirectory = await mkdtemp(join(tmpdir(), 'pd-oauth-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const store = new MemoryStore();
  let registrations = 0, refreshes = 0, tokenCalls = 0;
  let authUrl = new URL(resource), tokenExpiry = 3600;
  let mode = 'normal';
  let revoke: ((parameters: URLSearchParams, signal: AbortSignal | null | undefined) => Response | Promise<Response>) | undefined;
  const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] };
  const provider: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, 'error');
    if (url === `${resource}/.well-known/oauth-protected-resource`) return Response.json({ resource, authorization_servers: [issuer] });
    if (url === `${issuer}/.well-known/oauth-authorization-server`) return Response.json(metadata);
    if (url === `${issuer}/register`) {
      registrations++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.token_endpoint_auth_method, 'none');
      return Response.json({ client_id: 'public-client', token_endpoint_auth_method: 'none', redirect_uris: request.redirect_uris, ...(mode === 'secret' ? { client_secret: 'unexpected-secret' } : {}) });
    }
    if (url === `${issuer}/token`) {
      tokenCalls++;
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get('resource'), resource); assert.equal(params.get('client_id'), 'public-client');
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++;
        assert.equal(params.get('refresh_token'), 'refresh-secret');
        if (mode === 'network') throw new Error('provider included refresh-secret in its failure');
        if (mode === 'invalid_grant') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        if (mode === 'write-failure') store.failWrite = true;
        await new Promise(resolve => setTimeout(resolve, 40));
        return Response.json({ token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
      }
      assert.equal(params.get('code'), 'authorization-secret');
      assert.equal(params.get('redirect_uri'), authUrl.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url'), authUrl.searchParams.get('code_challenge'));
      return Response.json({ token_type: 'Bearer', access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: tokenExpiry });
    }
    if (url === `${issuer}/revoke`) return revoke ? revoke(new URLSearchParams(String(init?.body)), init?.signal) : mode === 'revoke-failure' ? new Response('unavailable', { status: 503 }) : new Response('');
    throw new Error(`Unexpected request ${url}`);
  };
  const options = { origin: resource, stateDirectory, credentialStore: store, fetch: provider, loginTimeoutMs: 1500, lockTimeoutMs: 1000 };
  const auth = createCloudAuth(options);
  const authorize = async (url: string) => {
    authUrl = new URL(url);
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(authUrl.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('state', authUrl.searchParams.get('state') ?? '');
    callback.searchParams.set('code', 'authorization-secret');
    const response = await fetch(callback); assert.equal(response.status, 200);
  };
  return { auth, setAuthorizationUrl: (url: string) => { authUrl = new URL(url); }, options, store, stateDirectory, metadata, authorize, setRevoke: (handler: NonNullable<typeof revoke>) => { revoke = handler; }, setMode: (value: string) => { mode = value; }, setExpiry: (value: number) => { tokenExpiry = value; }, counts: () => ({ registrations, refreshes, tokenCalls }) }
}

test('login validates PKCE and callback, persists credentials, and reuses its client and port', async t => {
  const f = await fixture(t);
  assert.equal((await f.auth.status()).state, 'logged_out');
  let redirect = '';
  await f.auth.login({ showAuthorizationUrl: async url => { redirect = new URL(url).searchParams.get('redirect_uri') ?? ''; await f.authorize(url); } });
  assert.equal(await f.auth.accessToken(), 'access-secret');
  await f.auth.login({ showAuthorizationUrl: async url => { assert.equal(new URL(url).searchParams.get('redirect_uri'), redirect); await f.authorize(url); } });
  assert.equal(f.counts().registrations, 1);
  assert.equal(JSON.stringify(await f.auth.status()).includes('secret'), false);
  assert.deepEqual(await readdir(f.stateDirectory), []);
});

test('wrong state, unicode state, path, duplicate parameters, and mixed code/error cannot complete login', async t => {
  const f = await fixture(t);
  await f.auth.login({ showAuthorizationUrl: async url => {
    const auth = new URL(url), callback = new URL(auth.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('code', 'authorization-secret'); callback.searchParams.set('state', auth.searchParams.get('state') ?? '');
    const invalid = [new URL(callback), new URL(callback), new URL(callback), new URL(callback), new URL(callback)];
    invalid[0].searchParams.set('state', 'wrong'); invalid[1].searchParams.set('state', 'é'.repeat(43)); invalid[2].pathname = '/wrong'; invalid[3].searchParams.append('code', 'duplicate'); invalid[4].searchParams.set('error', 'access_denied');
    for (const attempt of invalid) assert.equal((await fetch(attempt)).status, 400);
    assert.equal(f.counts().tokenCalls, 0);
    await f.authorize(url);
  } });
});

test('callback pages report receipt without exposing credentials or promising a saved login', async t => {
  const f = await fixture(t);
  let received = '';
  await assert.rejects(f.auth.login({ showAuthorizationUrl: async url => {
    f.setAuthorizationUrl(url);
    const auth = new URL(url), callback = new URL(auth.searchParams.get('redirect_uri') ?? '');
    const state = auth.searchParams.get('state') ?? '';
    callback.searchParams.set('state', state);
    callback.searchParams.set('code', 'authorization-secret');
    const invalid = new URL(callback); invalid.searchParams.set('state', 'wrong-state-secret');
    const invalidResponse = await fetch(invalid);
    assert.equal(invalidResponse.status, 400);
    assert.match(await invalidResponse.text(), /<h1>Invalid authorization callback<\/h1>/);
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    received = await response.text();
    assert.match(received, /<h1>Authorization received<\/h1>/);
    assert.match(received, /Return to your terminal to check the login result\./);
    assert.match(received, /<html lang="en">/);
    assert.match(received, /name="viewport"/);
    const style = received.match(/<style>([^]*?)<\/style>/)?.[1];
    assert.ok(style);
    assert.equal(response.headers.get('content-security-policy'), `default-src 'none'; style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    for (const secret of [state, 'authorization-secret', 'access-secret', 'refresh-secret', 'wrong-state-secret']) assert.equal(received.includes(secret), false);
    assert.equal(/<script|<link|<img|https?:\/\//i.test(received), false);
    assert.equal(/login complete|logged in|success/i.test(received), false);
    assert.equal(f.counts().tokenCalls, 0);
    f.store.failWrite = true;
  } }), /store unavailable/);
  f.store.failWrite = false;
  assert.equal((await f.auth.status()).state, 'reauthorization_required');
});

test('callback denial and timeout preserve registration for a later login', async t => {
  const f = await fixture(t);
  await assert.rejects(f.auth.login({ showAuthorizationUrl: async url => {
    const auth = new URL(url), callback = new URL(auth.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('state', auth.searchParams.get('state') ?? ''); callback.searchParams.set('error', 'secret-provider-message');
    const response = await fetch(callback), page = await response.text();
    assert.equal(response.status, 200);
    assert.match(page, /<h1>Authorization was not completed<\/h1>/);
    assert.equal(page.includes('secret-provider-message'), false);
  } }), error => error instanceof OAuthError && error.code === 'auth_denied' && !error.message.includes('secret'));
  const quick = createCloudAuth({ ...f.options, loginTimeoutMs: 20 });
  await assert.rejects(quick.login({ showAuthorizationUrl: () => {} }), error => error instanceof OAuthError && error.code === 'auth_timeout');
  await f.auth.login({ showAuthorizationUrl: f.authorize });
  assert.equal(f.counts().registrations, 1);
});

test('failed relogin preserves the prior valid grant', async t => {
  const f = await fixture(t);
  await f.auth.login({ showAuthorizationUrl: f.authorize });
  const prior = [...f.store.entries.values()][0];
  const quick = createCloudAuth({ ...f.options, loginTimeoutMs: 20 });
  for (const showAuthorizationUrl of [
    () => { throw new Error('display unavailable'); },
    async (url: string) => {
      const authorization = new URL(url), callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
      callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
      callback.searchParams.set('error', 'access_denied');
      assert.equal((await fetch(callback)).status, 200);
    },
    () => {},
  ]) {
    await assert.rejects(quick.login({ showAuthorizationUrl }));
    assert.equal([...f.store.entries.values()][0], prior);
    assert.equal(await f.auth.accessToken(), 'access-secret');
  }
});

test('timeout releases the listener and lock while URL presentation is pending', async t => {
  const f = await fixture(t);
  const quick = createCloudAuth({ ...f.options, loginTimeoutMs: 20 });
  let callback = '';
  await assert.rejects(quick.login({ showAuthorizationUrl: url => {
    callback = new URL(url).searchParams.get('redirect_uri') ?? '';
    return new Promise<void>(() => {});
  } }), error => error instanceof OAuthError && error.code === 'auth_timeout');
  assert.deepEqual(await readdir(f.stateDirectory), []);
  await assert.rejects(fetch(callback));
  assert.equal((await f.auth.status()).state, 'reauthorization_required');
  await f.auth.login({ showAuthorizationUrl: f.authorize });
  assert.equal(f.counts().registrations, 1);
});

test('a received callback cannot disable the pending presentation timeout', async t => {
  const f = await fixture(t);
  const quick = createCloudAuth({ ...f.options, loginTimeoutMs: 100 });
  await assert.rejects(quick.login({ showAuthorizationUrl: async url => {
    await f.authorize(url);
    await new Promise<void>(() => {});
  } }), error => error instanceof OAuthError && error.code === 'auth_timeout');
  assert.equal(f.counts().tokenCalls, 0);
  assert.deepEqual(await readdir(f.stateDirectory), []);
  assert.equal((await f.auth.status()).state, 'reauthorization_required');
});

test('resource lock serializes concurrent refresh and all callers receive the persisted replacement', async t => {
  const f = await fixture(t); f.setExpiry(1);
  await f.auth.login({ showAuthorizationUrl: f.authorize });
  const other = createCloudAuth(f.options);
  assert.deepEqual(await Promise.all([f.auth.accessToken(), other.accessToken(), f.auth.accessToken()]), ['new-access', 'new-access', 'new-access']);
  assert.equal(f.counts().refreshes, 1);
});

for (const mode of ['network', 'invalid_grant', 'write-failure']) test(`${mode} during refresh leaves a durable reauthorization state`, async t => {
  const f = await fixture(t); f.setExpiry(1);
  await f.auth.login({ showAuthorizationUrl: f.authorize }); f.setMode(mode);
  await assert.rejects(f.auth.accessToken(), error => error instanceof Error && !error.message.includes('refresh-secret'));
  f.store.failWrite = false;
  assert.equal((await f.auth.status()).state, 'reauthorization_required');
  await assert.rejects(f.auth.accessToken());
  assert.equal(f.counts().refreshes, 1);
});

test('logout deletes local credentials when revocation fails', async t => {
  const f = await fixture(t); await f.auth.login({ showAuthorizationUrl: f.authorize }); f.setMode('revoke-failure');
  assert.deepEqual(await f.auth.logout(), { resource, local: 'deleted', revocation: 'failed' });
  assert.equal(f.store.entries.size, 0); assert.equal((await f.auth.status()).state, 'logged_out');
});

for (const failedHint of ['refresh_token', 'access_token']) test(`logout tries both tokens when ${failedHint} revocation fails`, async t => {
  const f = await fixture(t); await f.auth.login({ showAuthorizationUrl: f.authorize });
  const attempts: string[] = [];
  f.setRevoke(parameters => {
    const hint = parameters.get('token_type_hint') ?? ''; attempts.push(hint);
    assert.equal(parameters.get('token'), hint === 'refresh_token' ? 'refresh-secret' : 'access-secret');
    return hint === failedHint ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : new Response('OK');
  });
  assert.deepEqual(await f.auth.logout(), { resource, local: 'deleted', revocation: 'failed' });
  assert.deepEqual(attempts, ['refresh_token', 'access_token']);
  assert.equal(f.store.entries.size, 0);
});

for (const body of ['OK', '<html>revoked</html>', 'x'.repeat(65537)]) test(`logout ignores a successful revocation body of ${body.length} bytes`, async t => {
  const f = await fixture(t); await f.auth.login({ showAuthorizationUrl: f.authorize });
  f.setRevoke(() => new Response(body));
  assert.deepEqual(await f.auth.logout(), { resource, local: 'deleted', revocation: 'revoked' });
});

test('logout cancels an unfinished HTTP 200 body without awaiting cancellation', async t => {
  const f = await fixture(t); await f.auth.login({ showAuthorizationUrl: f.authorize });
  let cancellations = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  f.setRevoke((_parameters, signal) => {
    signals.push(signal);
    return new Response(new ReadableStream({ cancel() { cancellations++; return new Promise<void>(() => {}); } }));
  });
  const auth = createCloudAuth({ ...f.options, requestTimeoutMs: 20 });
  assert.deepEqual(await auth.logout(), { resource, local: 'deleted', revocation: 'revoked' });
  assert.equal(cancellations, 2);
  assert.equal(signals.every(signal => signal?.aborted), true);
});

for (const status of [204, 302, 503]) test(`logout treats HTTP ${status} revocation as failed`, async t => {
  const f = await fixture(t); await f.auth.login({ showAuthorizationUrl: f.authorize });
  let attempts = 0;
  f.setRevoke(() => { attempts++; return new Response(null, { status }); });
  assert.deepEqual(await f.auth.logout(), { resource, local: 'deleted', revocation: 'failed' });
  assert.equal(attempts, 2);
});

test('logout still tries the access token after a refresh revocation timeout', async t => {
  const f = await fixture(t); await f.auth.login({ showAuthorizationUrl: f.authorize });
  const attempts: string[] = [];
  f.setRevoke(parameters => {
    const hint = parameters.get('token_type_hint') ?? ''; attempts.push(hint);
    return hint === 'refresh_token' ? new Promise<Response>(() => {}) : new Response('OK');
  });
  const auth = createCloudAuth({ ...f.options, requestTimeoutMs: 20 });
  assert.deepEqual(await auth.logout(), { resource, local: 'deleted', revocation: 'failed' });
  assert.deepEqual(attempts, ['refresh_token', 'access_token']);
});

test('logout rejects a local deletion failure and retains the credential entry', async t => {
  const f = await fixture(t); await f.auth.login({ showAuthorizationUrl: f.authorize });
  f.store.failDelete = true;
  await assert.rejects(f.auth.logout(), /store delete unavailable/);
  assert.equal(f.store.entries.size, 1);
  assert.deepEqual(await readdir(f.stateDirectory), []);
});

for (const scenario of [
  { name: 'Cloudflare cascade', issuer: 'https://team.cloudflareaccess.com', refresh: true, refreshStatus: 200, accessStatus: 400, error: 'invalid_grant', expected: 'revoked' },
  { name: 'generic issuer', issuer, refresh: true, refreshStatus: 200, accessStatus: 400, error: 'invalid_grant', expected: 'failed' },
  { name: 'fake suffix', issuer: 'https://team.cloudflareaccess.com.attacker.example', refresh: true, refreshStatus: 200, accessStatus: 400, error: 'invalid_grant', expected: 'failed' },
  { name: 'fake prefix', issuer: 'https://fakecloudflareaccess.com', refresh: true, refreshStatus: 200, accessStatus: 400, error: 'invalid_grant', expected: 'failed' },
  { name: 'issuer apex', issuer: 'https://cloudflareaccess.com', refresh: true, refreshStatus: 200, accessStatus: 400, error: 'invalid_grant', expected: 'failed' },
  { name: 'nonstandard port', issuer: 'https://team.cloudflareaccess.com:8443', refresh: true, refreshStatus: 200, accessStatus: 400, error: 'invalid_grant', expected: 'failed' },
  { name: 'refresh failure', issuer: 'https://team.cloudflareaccess.com', refresh: true, refreshStatus: 400, accessStatus: 400, error: 'invalid_grant', expected: 'failed' },
  { name: 'missing refresh', issuer: 'https://team.cloudflareaccess.com', refresh: false, refreshStatus: 200, accessStatus: 400, error: 'invalid_grant', expected: 'failed' },
  { name: 'different access error', issuer: 'https://team.cloudflareaccess.com', refresh: true, refreshStatus: 200, accessStatus: 400, error: 'unsupported_token_type', expected: 'failed' },
  { name: 'different access status', issuer: 'https://team.cloudflareaccess.com', refresh: true, refreshStatus: 200, accessStatus: 503, error: 'invalid_grant', expected: 'failed' },
]) test(`logout limits cascading revocation compatibility for ${scenario.name}`, async t => {
  const f = await fixture(t, scenario.issuer); await f.auth.login({ showAuthorizationUrl: f.authorize });
  if (!scenario.refresh) for (const [key, raw] of f.store.entries) {
    const session = JSON.parse(raw); session.grant.refreshToken = null; f.store.entries.set(key, JSON.stringify(session));
  }
  const attempts: string[] = [];
  f.setRevoke(parameters => {
    const hint = parameters.get('token_type_hint') ?? ''; attempts.push(hint);
    const status = hint === 'refresh_token' ? scenario.refreshStatus : scenario.accessStatus;
    return status === 200 ? new Response('OK') : Response.json({ error: scenario.error }, { status });
  });
  assert.deepEqual(await f.auth.logout(), { resource, local: 'deleted', revocation: scenario.expected });
  assert.deepEqual(attempts, scenario.refresh ? ['refresh_token', 'access_token'] : ['access_token']);
});

for (const failure of ['network', 'oversized', 'unfinished']) test(`Cloudflare access revocation ${failure} remains a failure`, async t => {
  const f = await fixture(t, 'https://team.cloudflareaccess.com'); await f.auth.login({ showAuthorizationUrl: f.authorize });
  f.setRevoke(parameters => {
    if (parameters.get('token_type_hint') === 'refresh_token') return new Response('OK');
    if (failure === 'network') throw new Error('connection unavailable');
    const raw = JSON.stringify({ error: 'invalid_grant' });
    if (failure === 'oversized') return new Response(raw + ' '.repeat(65537), { status: 400 });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(raw)); } }), { status: 400 });
  });
  const auth = createCloudAuth({ ...f.options, requestTimeoutMs: 20 });
  assert.deepEqual(await auth.logout(), { resource, local: 'deleted', revocation: 'failed' });
});

test('discovery rejects endpoint rebinding and public registration rejects client secrets', async t => {
  const f = await fixture(t); f.metadata.token_endpoint = 'https://attacker.example/token';
  await assert.rejects(f.auth.login({ showAuthorizationUrl: f.authorize }), error => error instanceof OAuthError && error.code === 'auth_metadata_invalid');
  assert.equal(f.counts().registrations, 0);
  f.metadata.token_endpoint = `${issuer}/token`; f.setMode('secret');
  await assert.rejects(f.auth.login({ showAuthorizationUrl: f.authorize }), error => error instanceof OAuthError && error.code === 'auth_registration_invalid');
  assert.equal(f.store.entries.size, 0);
});

test('bounded protocol responses and redirects fail before registration', async t => {
  const f = await fixture(t);
  for (const response of [new Response('x'.repeat(65537)), new Response(null, { status: 302, headers: { location: 'https://attacker.example' } })]) {
    const auth = createCloudAuth({ ...f.options, fetch: async () => response });
    await assert.rejects(auth.login({ showAuthorizationUrl: f.authorize }), OAuthError);
  }
  assert.equal(f.counts().registrations, 0);
});

test('protocol rejection cancels response streams without waiting for cancellation', async t => {
  const f = await fixture(t);
  for (const oversized of [false, true]) {
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const response = new Response(new ReadableStream({
      start(controller) { if (oversized) controller.enqueue(new Uint8Array(65537)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { status: oversized ? 200 : 302 });
    const auth = createCloudAuth({ ...f.options, fetch: async (_url, init) => { signal = init?.signal; return response; } });
    await assert.rejects(auth.login({ showAuthorizationUrl: f.authorize }), error => error instanceof OAuthError && error.code === (oversized ? 'auth_response_invalid' : 'auth_redirect_rejected'));
    assert.equal(cancelled, true);
    assert.equal(signal?.aborted, true);
    assert.deepEqual(await readdir(f.stateDirectory), []);
  }
});

function child(directory: string, mode: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [new URL('./fixtures/oauth-client.ts', import.meta.url).pathname, directory, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; process.stdout.on('data', chunk => { output += chunk; });
    process.on('error', reject); process.on('close', code => resolve({ code, output }));
  });
}

test('independent processes share one refresh transaction', async t => {
  const f = await fixture(t); f.setExpiry(1); await f.auth.login({ showAuthorizationUrl: f.authorize });
  const directory = await mkdtemp(join(tmpdir(), 'pd-oauth-child-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'locks'), { mode: 0o700 });
  const key = credentialKey(resource, await realpath(join(directory, 'locks')));
  await writeFile(join(directory, 'test-store.json'), JSON.stringify({ [key]: [...f.store.entries.values()][0] }));
  const results = await Promise.all([child(directory, 'refresh'), child(directory, 'refresh')]);
  assert.deepEqual(results, [{ code: 0, output: 'child-access' }, { code: 0, output: 'child-access' }]);
  assert.equal(await readFile(join(directory, 'refreshes'), 'utf8'), 'refresh\n');
});

test('a crash leaves the lock owned and the spent refresh grant unusable after manual recovery', async t => {
  const f = await fixture(t); f.setExpiry(1); await f.auth.login({ showAuthorizationUrl: f.authorize });
  const directory = await mkdtemp(join(tmpdir(), 'pd-oauth-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const locks = join(directory, 'locks'); await mkdir(locks, { mode: 0o700 });
  const key = credentialKey(resource, await realpath(locks));
  await writeFile(join(directory, 'test-store.json'), JSON.stringify({ [key]: [...f.store.entries.values()][0] }));
  assert.equal((await child(directory, 'crash')).code, 42);
  assert.deepEqual(await child(directory, 'refresh'), { code: 1, output: 'auth_busy' });
  await rm(join(locks, `${key}.lock`), { recursive: true });
  assert.deepEqual(await child(directory, 'refresh'), { code: 1, output: 'auth_reauthorization_required' });
  assert.equal(await readFile(join(directory, 'refreshes'), 'utf8'), 'refresh\n');
});

test('status describes local expiry and isolates different credential namespaces', async t => {
  const f = await fixture(t); f.setExpiry(1); await f.auth.login({ showAuthorizationUrl: f.authorize });
  const status = await f.auth.status();
  assert.equal(status.state, 'stored'); assert.equal(status.needsRefresh, true); assert.equal(status.refreshAvailable, true);
  const directory = await mkdtemp(join(tmpdir(), 'pd-oauth-namespace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const other = createCloudAuth({ ...f.options, stateDirectory: directory });
  assert.equal((await other.status()).state, 'logged_out');
});

test('body timeout rejects a valid JSON prefix and cancels the unfinished stream', async t => {
  const f = await fixture(t); let cancelled = false;
  const auth = createCloudAuth({ ...f.options, requestTimeoutMs: 20, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ resource, authorization_servers: [issuer] }))); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(auth.login({ showAuthorizationUrl: f.authorize }), error => error instanceof OAuthError && error.code === 'auth_request_failed');
  assert.equal(cancelled, true); assert.equal(f.store.entries.size, 0);
});

test('discovery checks the resource and issuer binding', async t => {
  const f = await fixture(t);
  for (const body of [{ resource: 'https://other.example', authorization_servers: [issuer] }, { resource, authorization_servers: [issuer, 'https://other.example'] }]) {
    const auth = createCloudAuth({ ...f.options, fetch: async () => Response.json(body) });
    await assert.rejects(auth.login({ showAuthorizationUrl: f.authorize }), error => error instanceof OAuthError && error.code === 'auth_metadata_invalid');
  }
  f.metadata.issuer = 'https://other.example';
  await assert.rejects(f.auth.login({ showAuthorizationUrl: f.authorize }), error => error instanceof OAuthError && error.code === 'auth_metadata_invalid');
});
