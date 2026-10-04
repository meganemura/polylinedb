/** Exercises the trust boundary with generated RSA keys and real signed assertions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessVerifier, AccessError } from "../src/service/access.ts";
import type { AccessSettings } from "../src/service/access.ts";

const settings: AccessSettings = {
  ACCESS_TEAM_DOMAIN: 'personal.cloudflareaccess.com',
  ACCESS_AUD: 'private-application',
  ACCESS_ACTORS: '["access:owner","service:local-service"]',
};
const issuer = 'https://personal.cloudflareaccess.com';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
const rotatedPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const rotatedKey = await crypto.subtle.exportKey('jwk', rotatedPair.publicKey);

function encode(value: string | ArrayBuffer): string {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return btoa(Array.from(data, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function signed(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: CryptoKey = pair.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode(JSON.stringify({ alg: 'RS256', kid: 'initial', ...header }))}.${encode(JSON.stringify({ iss: issuer, aud: ['private-application'], sub: 'owner', exp: now + 300, iat: now - 1, ...claims }))}`;
  return `${data}.${encode(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data)))}`;
}

function request(token: string): Request {
  return new Request('https://issues.example/mcp', { headers: { 'Cf-Access-Jwt-Assertion': token } });
}

type AccessTestKey = JsonWebKey & { kid: string };
function jwks(...keys: AccessTestKey[]): Response {
  return Response.json({ keys: keys.length ? keys : [{ ...publicKey, kid: 'initial' }] });
}

function verifier() { return createAccessVerifier(async () => jwks()); }

async function rejects(action: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(action, error => error instanceof AccessError && error.status === status && error.code === code);
}

test('valid signed assertion yields only the allowlisted subject', async () => {
  assert.equal(await verifier()(request(await signed()), settings), 'access:owner');
  assert.equal(await verifier()(request(await signed({ aud: 'private-application' })), settings), 'access:owner');
});

test('missing assertion and bearer-only request are unauthorized', async () => {
  const verify = verifier();
  await rejects(verify(new Request('https://issues.example/mcp'), settings), 401, 'invalid_assertion');
  await rejects(verify(new Request('https://issues.example/mcp', { headers: { Authorization: `Bearer ${await signed()}`, 'X-Actor': 'owner' } }), settings), 401, 'invalid_assertion');
});

test('rejects unsupported algorithms, unsigned token, critical header and malformed segments', async () => {
  const verify = verifier();
  for (const alg of ['none', 'HS256', 'RS512']) await rejects(verify(request(await signed({}, { alg })), settings), 401, 'invalid_assertion');
  const valid = await signed();
  await rejects(verify(request(valid.slice(0, valid.lastIndexOf('.') + 1)), settings), 401, 'invalid_assertion');
  await rejects(verify(request(await signed({}, { crit: [] })), settings), 401, 'invalid_assertion');
  for (const token of ['x', 'a.b.c', '%%%%.e30.signature', 'e30.e30.Zg']) await rejects(verify(request(token), settings), 401, 'invalid_assertion');
  await rejects(verify(request(await signed({}, { kid: '' })), settings), 401, 'invalid_assertion');
  await rejects(verify(request(await signed({}, { kid: 'x'.repeat(129) })), settings), 401, 'invalid_assertion');
});

test('signature protects subject and payload', async () => {
  const token = await signed();
  const parts = token.split('.');
  parts[1] = encode(JSON.stringify({ iss: issuer, aud: 'private-application', exp: Math.floor(Date.now() / 1000) + 100, sub: 'attacker' }));
  await rejects(verifier()(request(parts.join('.')), settings), 401, 'invalid_assertion');
  const wrongKey = await signed({}, {}, rotatedPair.privateKey);
  await rejects(verifier()(request(wrongKey), settings), 401, 'invalid_assertion');
});

test('valid signatures still require exact issuer, audience and claim types', async () => {
  const verify = verifier();
  const now = Math.floor(Date.now() / 1000);
  const cases: Record<string, unknown>[] = [
    { iss: 'https://other.cloudflareaccess.com' }, { iss: `${issuer}/` },
    { aud: ['other'] }, { aud: [123, 'private-application'] }, { aud: [] }, { aud: null },
    { exp: now }, { exp: now - 1 }, { exp: String(now + 100) }, { exp: now + 0.5 },
    { exp: Number.MAX_SAFE_INTEGER + 1 }, { nbf: now + 100 }, { nbf: '0' },
    { iat: now + 100 }, { iat: null }, { sub: 123 }, { common_name: 123 },
    { sub: '' }, { sub: ' ' }, { sub: 'owner\n' }, { sub: 'x'.repeat(257) },
  ];
  for (const claims of cases) await rejects(verify(request(await signed(claims)), settings), 401, 'invalid_assertion');
  assert.equal(await verify(request(await signed({ nbf: now - 100 })), settings), 'access:owner');
});

test('user allowlist ignores caller actor arguments and email headers', async () => {
  const untrusted = new Request('https://issues.example/mcp', {
    method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': await signed({ sub: 'intruder', actor: 'access:owner' }), 'Cf-Access-Authenticated-User-Email': 'owner', 'X-Actor': 'access:owner' },
    body: JSON.stringify({ actor: 'access:owner' }),
  });
  await rejects(verifier()(untrusted, settings), 403, 'actor_not_allowed');
  assert.equal(await verifier()(request(await signed({ actor: 'access:intruder' })), settings), 'access:owner');
});

test('service identities require a verified common_name and explicit allowlist', async () => {
  const verify = verifier();
  assert.equal(await verify(request(await signed({ sub: '', common_name: 'local-service' })), settings), 'service:local-service');
  const now = Math.floor(Date.now() / 1000);
  const content = `${encode(JSON.stringify({ alg: 'RS256', kid: 'initial' }))}.${encode(JSON.stringify({ iss: issuer, aud: 'private-application', exp: now + 100, common_name: 'local-service' }))}`;
  const noSubject = `${content}.${encode(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(content)))}`;
  assert.equal(await verify(request(noSubject), settings), 'service:local-service');
  await rejects(verify(request(await signed({ sub: '', common_name: 'unknown' })), settings), 403, 'actor_not_allowed');
  await rejects(verify(request(await signed({ sub: '', common_name: '' })), settings), 401, 'invalid_assertion');
  await rejects(verify(request(await signed({ sub: 'intruder', common_name: 'local-service' })), settings), 403, 'actor_not_allowed');
});

test('invalid configuration fails closed before fetching keys', async () => {
  const verify = createAccessVerifier(async () => { throw new Error('must not fetch'); });
  for (const patch of [
    { ACCESS_TEAM_DOMAIN: '' }, { ACCESS_TEAM_DOMAIN: 'https://personal.cloudflareaccess.com' },
    { ACCESS_TEAM_DOMAIN: 'a.b.cloudflareaccess.com' }, { ACCESS_TEAM_DOMAIN: 'personal.cloudflareaccess.com/evil' },
    { ACCESS_TEAM_DOMAIN: '-personal.cloudflareaccess.com' }, { ACCESS_AUD: '' },
    { ACCESS_ACTORS: '[]' }, { ACCESS_ACTORS: 'null' }, { ACCESS_ACTORS: 'invalid' },
    { ACCESS_ACTORS: '["owner"]' }, { ACCESS_ACTORS: '[123]' }, { ACCESS_ACTORS: '["access:"]' },
  ]) await rejects(verify(request(await signed()), { ...settings, ...patch }), 503, 'invalid_access_configuration');
});

test('cache reuses keys while every request rechecks time and owner policy', async () => {
  let count = 0;
  const verify = createAccessVerifier(async (url, options) => {
    assert.equal(url, 'https://personal.cloudflareaccess.com/cdn-cgi/access/certs');
    assert.equal(options?.redirect, 'manual');
    assert.ok(options?.signal instanceof AbortSignal);
    count += 1;
    return jwks();
  });
  const token = await signed();
  assert.deepEqual(await Promise.all([verify(request(token), settings), verify(request(token), settings)]), ['access:owner', 'access:owner']);
  assert.equal(await verify(request(token), settings), 'access:owner');
  await rejects(verify(request(await signed({ exp: 1 })), settings), 401, 'invalid_assertion');
  await rejects(verify(request(token), { ...settings, ACCESS_ACTORS: '["access:another"]' }), 403, 'actor_not_allowed');
  assert.equal(count, 1);
});

test('unknown kid refresh accepts rotation and throttles nonexistent keys', async () => {
  let count = 0;
  const verify = createAccessVerifier(async () => {
    count += 1;
    return count === 1 ? jwks() : jwks({ ...publicKey, kid: 'initial' }, { ...rotatedKey, kid: 'rotated' });
  });
  assert.equal(await verify(request(await signed()), settings), 'access:owner');
  assert.equal(await verify(request(await signed({}, { kid: 'rotated' }, rotatedPair.privateKey)), settings), 'access:owner');
  for (const kid of ['missing1', 'missing2', 'https://attacker.example']) await rejects(verify(request(await signed({}, { kid })), settings), 401, 'invalid_assertion');
  assert.equal(count, 2);
});

test('cache expiry reloads keys and cached keys do not extend assertion validity', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let count = 0;
  const verify = createAccessVerifier(async () => { count += 1; return jwks(); });
  const token = await signed({ exp: Math.floor(Date.now() / 1000) + 1000 });
  assert.equal(await verify(request(token), settings), 'access:owner');
  const shortToken = await signed({ exp: Math.floor(Date.now() / 1000) + 1 });
  context.mock.timers.tick(2000);
  await rejects(verify(request(shortToken), settings), 401, 'invalid_assertion');
  assert.equal(count, 1);
  context.mock.timers.tick(300000);
  assert.equal(await verify(request(token), settings), 'access:owner');
  assert.equal(count, 2);
});

test('failed unknown-key refresh is rate limited without poisoning known keys', async () => {
  let count = 0;
  const verify = createAccessVerifier(async () => {
    count += 1;
    if (count > 1) return new Response('unavailable', { status: 503 });
    return jwks();
  });
  assert.equal(await verify(request(await signed()), settings), 'access:owner');
  await rejects(verify(request(await signed({}, { kid: 'new' })), settings), 503, 'jwks_unavailable');
  await rejects(verify(request(await signed({}, { kid: 'another' })), settings), 401, 'invalid_assertion');
  assert.equal(await verify(request(await signed()), settings), 'access:owner');
  assert.equal(count, 2);
});

test('JWKS failure is unavailable, leaks no upstream errors, and is not cached as success', async () => {
  let count = 0;
  const verify = createAccessVerifier(async () => {
    count += 1;
    if (count === 1) throw new Error('secret upstream contents');
    return jwks();
  });
  const token = await signed();
  await assert.rejects(verify(request(token), settings), error => error instanceof AccessError
    && error.status === 503 && error.code === 'jwks_unavailable' && error.message === 'Authentication unavailable');
  assert.equal(await verify(request(token), settings), 'access:owner');
  assert.equal(count, 2);
});

test('manual JWKS fetch rejects redirects even when the body contains valid keys', async () => {
  for (const status of [301, 302, 307, 308]) {
    const verify = createAccessVerifier(async (url, options) => {
      assert.equal(url, 'https://personal.cloudflareaccess.com/cdn-cgi/access/certs');
      assert.equal(options?.redirect, 'manual');
      return new Response(JSON.stringify({ keys: [{ ...publicKey, kid: 'initial' }] }), {
        status, headers: { location: 'https://attacker.example/certs' },
      });
    });
    await rejects(verify(request(await signed()), settings), 503, 'jwks_unavailable');
  }
});

test('rejects malformed, oversized, wrong-purpose and duplicate JWKS keys', async () => {
  const responses = [
    () => new Response('down', { status: 503 }),
    () => new Response('not JSON'),
    () => new Response(' '.repeat(128 * 1024 + 1)),
    () => Response.json({ keys: [] }),
    () => jwks({ ...publicKey, kid: 'initial', alg: 'HS256' }),
    () => jwks({ ...publicKey, kid: 'initial', use: 'enc' }),
    () => jwks({ ...publicKey, kid: 'initial' }, { ...publicKey, kid: 'initial' }),
    () => jwks({ kty: 'RSA', kid: 'initial', n: 'broken', e: 'broken' }),
  ];
  for (const respond of responses) await rejects(createAccessVerifier(async () => respond())(request(await signed()), settings), 503, 'jwks_unavailable');
});
