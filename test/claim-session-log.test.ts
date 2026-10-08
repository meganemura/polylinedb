/** Pins the Workers Logs line for claim acquisitions that lack a usable session UUID. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessVerifier } from "../src/service/access.ts";
import { handleRequest } from "../src/service/index.ts";

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
const teamDomain = 'marker-team-domain.cloudflareaccess.com';
const authenticate = createAccessVerifier(async () => Response.json({ keys: [{ ...publicKey, kid: 'test', alg: 'RS256', use: 'sig' }] }));
const env = { DB: { prepare: () => assert.fail('a rejected request must not reach D1'), batch: async () => assert.fail('a rejected request must not reach D1') },
  ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: 'marker-audience', ACCESS_ACTORS: '["access:owner"]' };

async function assertion(): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const encoded = `${encode({ alg: 'RS256', kid: 'test' })}.${encode({ iss: `https://${teamDomain}`, aud: ['marker-audience'],
    sub: 'owner', exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(encoded));
  return `${encoded}.${Buffer.from(signature).toString('base64url')}`;
}

function captureConsole(t: TestContext): unknown[][] {
  const calls: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { calls.push(args); });
  }
  return calls;
}

const base = { issue_id: 'pd-1', incarnation: 'a'.repeat(32), request_id: '00000000-0000-4000-8000-000000000001', agent_label: 'marker-request-body' };
const sessions = { missing: {}, malformed: { session_id: 'MARKER-NOT-A-UUID' } };
const shapes = { 'and nothing else is wrong': {}, 'beside an unknown field': { unexpected: 'marker-extra-field' } };

async function send(path: '/v1/operations' | '/mcp', operation: Record<string, unknown>) {
  const token = await assertion();
  const { op, ...args } = operation;
  const body = path === '/mcp' ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: args } } : operation;
  const response = await handleRequest(new Request(`https://issues.example${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'cf-access-jwt-assertion': token, authorization: `Bearer ${token}` },
  }), env, authenticate);
  const json = await response.json() as { error?: { code: string }; result?: { isError: boolean; structuredContent: { error: { code: string } } } };
  return { token, status: response.status, code: path === '/mcp' ? json.result?.structuredContent.error.code : json.error?.code, isError: json.result?.isError };
}

for (const [route, status] of [['/v1/operations', 400], ['/mcp', 200]] as const) {
  for (const [kind, session] of Object.entries(sessions)) for (const [shape, extra] of Object.entries(shapes)) {
    test(`${route} logs one claim_session_id_missing line when session_id is ${kind} ${shape}`, async (t) => {
      const calls = captureConsole(t);
      const sent = await send(route, { op: 'claim_acquire', ...base, ...session, ...extra });

      assert.equal(sent.status, status);
      assert.equal(sent.code, 'invalid_input');
      if (route === '/mcp') assert.equal(sent.isError, true);
      assert.deepEqual(calls, [[{ event: 'claim_session_id_missing', route, tool: 'claim_acquire', actor: 'access:owner' }]]);
      const logged = JSON.stringify(calls);
      for (const secret of [sent.token, ...sent.token.split('.'), teamDomain, 'marker-team-domain', 'marker-audience',
        'Bearer', 'marker-request-body', 'marker-extra-field', 'MARKER-NOT-A-UUID', base.request_id]) {
        assert.equal(logged.includes(secret), false, `log line leaks ${secret}`);
      }
    });
  }

  test(`${route} logs nothing when claim_acquire fails for another field`, async (t) => {
    const calls = captureConsole(t);
    const sent = await send(route, { op: 'claim_acquire', ...base, incarnation: 'not-hex', session_id: '00000000-0000-4000-8000-000000000002' });
    assert.equal(sent.code, 'invalid_input');
    assert.deepEqual(calls, []);
  });

  test(`${route} logs nothing when a claim proof lacks a session UUID`, async (t) => {
    const calls = captureConsole(t);
    const sent = await send(route, { op: 'claim_renew', claim_proof: { issue_id: 'pd-1', incarnation: 'a'.repeat(32), generation: 1 },
      expected_revision: 1, request_id: base.request_id });
    assert.equal(sent.code, 'invalid_input');
    assert.deepEqual(calls, []);
  });
}
