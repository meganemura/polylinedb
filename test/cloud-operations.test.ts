/** Exercises cloud operations with real SQLite and signed assertions. Production Access policy remains a live test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { storageOf } from 'solarsql/node';
import { createAccessVerifier } from "../src/service/access.ts";
import { handleRequest } from "../src/service/index.ts";
import { SCHEMA_SQL } from "../src/records/schema.ts";
import { createServer } from 'node:http';
import { once } from 'node:events';
import { executeCloudOperation } from '../src/cloud-client/cloud-operations.ts';
import { parseOperation } from "../src/records/index.ts"; import { PolylinedbError } from "../src/records/errors.ts";

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
const issuer = 'https://polylinedb-test.cloudflareaccess.com';
const authenticate = createAccessVerifier(async () => Response.json({ keys: [{ ...publicKey, kid: 'test', alg: 'RS256', use: 'sig' }] }));

async function assertion(): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const encoded = `${encode({ alg: 'RS256', kid: 'test' })}.${encode({ iss: issuer, aud: ['polylinedb-test'],
    sub: 'owner', exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(encoded));
  return `${encoded}.${Buffer.from(signature).toString('base64url')}`;
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA_SQL);
  const storage = storageOf(sqlite);
  const prepare = (sql: string) => {
    const make = (params: (string | number | null)[]) => ({
      sql, params,
      bind: (...values: (string | number | null)[]) => make(values),
      all: async () => ({ success: true, results: storage.sql.exec(sql, ...params).toArray() }),
    });
    return make([]);
  };
  const DB = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(({ sql, params }) => ({ success: true, results: storage.sql.exec(sql, ...params).toArray() }));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const env = { DB, ACCESS_TEAM_DOMAIN: 'polylinedb-test.cloudflareaccess.com', ACCESS_AUD: 'polylinedb-test',
    ACCESS_ACTORS: '["access:owner"]', ALLOWED_ORIGINS: '["https://client.example"]' };
  return { sqlite, env };
}

test('cloud transport runs every operation against signed Worker requests through a real loopback server', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const dispatched: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    dispatched.push(JSON.parse(body));
    assert.equal(request.headers.authorization, 'Bearer synthetic-secret');
    const output = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body,
    }), env, authenticate);
    response.writeHead(output.status, Object.fromEntries(output.headers));
    response.end(await output.text());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const transport: typeof fetch = (url, options) => {
    assert.equal(String(url), 'https://issues.example/v1/operations');
    assert.equal(options?.redirect, 'error');
    return fetch(`http://127.0.0.1:${address.port}/v1/operations`, options);
  };
  const run = (value: unknown) => executeCloudOperation({ origin: 'https://issues.example', operation: parseOperation(value), authorize: async () => 'synthetic-secret', fetch: transport });
  try {
    assert.deepEqual(await run({ op: 'actor' }), { actor: 'access:owner' });
    const create = { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'cloud', body: 'sample' };
    const created = await run(create);
    assert.ok('issue' in created);
    assert.equal(created.issue.created_by, 'access:owner');
    for (const damaged of [
      { issue: { ...created.issue, versions: {} } },
      { issue: { ...created.issue, priority: undefined } },
      { issue: { ...created.issue, labels: ['duplicate', 'duplicate'] } },
      { issue: { ...created.issue, extra: true } },
    ]) {
      await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: parseOperation(create),
        authorize: async () => 'secret', fetch: async () => Response.json(damaged) }), {
        code: 'cloud_invalid_response', details: { request_id: create.request_id },
      });
    }
    assert.deepEqual(await run(create), created);
    const id = created.issue.id;
    await run({ op: 'comment', id, body: 'confirmed' });
    const shown = await run({ op: 'show', id });
    assert.ok('comments' in shown);
    assert.equal(shown.comments.length, 1);
    await run({ op: 'update', id, changes: [{ field: 'body', expected: 1, value: 'edited' }] });
    const beforeConflict = dispatched.length;
    await assert.rejects(run({ op: 'update', id, changes: [{ field: 'body', expected: 1, value: 'stale' }] }), error => {
      assert.ok(error instanceof PolylinedbError);
      assert.equal(error.code, 'conflict');
      assert.ok(typeof error.details === 'object' && error.details !== null && 'fields' in error.details);
      assert.deepEqual(error.details.fields, [{ field: 'body', expected: 1, actual: 2, current: 'edited' }]);
      return true;
    });
    assert.equal(dispatched.length, beforeConflict + 1);
    await run({ op: 'close', id, expected: 1 });
    await run({ op: 'reopen', id, expected: 2 });
    for (const op of ['list', 'search']) {
      const listed = await run({ op, project: 'cloud', ...(op === 'search' ? { query: 'edited' } : {}) });
      assert.ok('issues' in listed);
      assert.equal(listed.issues.length, 1);
      assert.equal(listed.next_cursor, null);
    }
    await assert.rejects(run({ op: 'show', id: 'pd-999' }), { code: 'not_found', details: { id: 'pd-999' } });
    const inspection = await run({ op: 'claim_show', issue_id: id }); assert.ok('claim' in inspection);
    const claimCommand = { op: 'claim_acquire', issue_id: id, incarnation: inspection.claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'Codex' };
    const owner = await run(claimCommand); assert.ok('claim_receipt' in owner);
    const claim_proof = { issue_id: id, incarnation: owner.claim_receipt.incarnation, session_id: owner.claim_receipt.session_id, generation: owner.claim_receipt.generation };
    await assert.rejects(run({ op: 'close', id, expected: 3, force: true, reason: 'Exception' }), { code: 'claim_required' });
    await run({ op: 'close', id, expected: 3, claim_proof });
    await run({ op: 'claim_renew', claim_proof, expected_revision: 1, request_id: crypto.randomUUID(), ttl: 30 });
    assert.deepEqual(await run(claimCommand), owner);
    await assert.rejects(run({ ...claimCommand, session_id: crypto.randomUUID() }), { code: 'claim_request_conflict' });
    await run({ op: 'claim_release', claim_proof, expected_revision: 2, request_id: crypto.randomUUID() });
    const history = await run({ op: 'claim_list', project: 'cloud' }); assert.ok('claims' in history); assert.equal(history.claims[0]?.state, 'released');
  } finally { server.close(); await once(server, 'close'); sqlite.close(); }
});

test('request timeout aborts the single dispatched request', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const pending = executeCloudOperation({ origin: 'https://issues.example', operation: { op: 'comment', id: 'pd-1', body: 'x' },
    authorize: async () => 'secret', fetch: async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('secret')), { once: true }));
    } });
  const rejected = assert.rejects(pending, { code: 'cloud_unavailable' });
  await Promise.resolve();
  context.mock.timers.tick(30_000);
  await rejected;
  assert.equal(calls, 1);
});

test('body timeout rejects complete JSON when the response stream never closes', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  let reading: () => void = () => {};
  const started = new Promise<void>(resolve => { reading = resolve; });
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"actor":"access:owner"}')); },
    pull() { reading(); },
    cancel() { cancelled = true; },
  });
  const pending = executeCloudOperation({ origin: 'https://issues.example', operation: { op: 'actor' }, authorize: async () => 'secret',
    fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  const rejected = assert.rejects(pending, { code: 'cloud_unavailable' });
  await started;
  context.mock.timers.tick(30_000);
  await rejected;
  assert.equal(cancelled, true);
});

test('early response rejection cancels the body without waiting for cancellation completion', async () => {
  const responses: ResponseInit[] = [{ status: 401 }, { status: 403 }, { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } }];
  for (const options of responses) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}); } });
    await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: { op: 'actor' }, authorize: async () => 'secret',
      fetch: async () => new Response(body, options) }));
    assert.equal(cancelled, true);
  }
});

test('real HTTP redirects do not forward authentication to another route', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(302, { location: '/login' });
    response.end('<html>secret</html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: { op: 'actor' }, authorize: async () => 'secret',
      fetch: (_url, options) => fetch(`http://127.0.0.1:${address.port}/v1/operations`, options) }), { code: 'cloud_unavailable' });
    assert.equal(requests, 1);
  } finally { server.close(); await once(server, 'close'); }
});

test('transport never retries and keeps create request IDs available after uncertain failures', async () => {
  for (const value of [{ op: 'comment', id: 'pd-1', body: 'x' }, { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'x', project: 'x', body: 'x' }]) {
    const operation = parseOperation(value);
    let calls = 0;
    await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation, authorize: async () => 'secret', fetch: async () => {
      calls++; throw new Error('secret HTML');
    } }), error => {
      assert.ok(error instanceof PolylinedbError);
      assert.equal(error.code, 'cloud_unavailable');
      assert.ok(!error.message.includes('secret'));
      if (operation.op === 'create') assert.deepEqual(error.details, { request_id: operation.request_id });
      return true;
    });
    assert.equal(calls, 1);
  }
});
test('claim cloud decoding rejects malformed authority, state and receipt variants and retains uncertain UUIDs', async () => {
  const { sqlite, env } = fixture(); const token = await assertion();
  const run = (value: unknown) => executeCloudOperation({ origin: 'https://issues.example', operation: parseOperation(value), authorize: async () => 'synthetic', fetch: async (_url, options) => handleRequest(new Request('https://issues.example/v1/operations', { ...options, headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token } }), env, authenticate) });
  try {
    const created = await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'cloud', body: 'Claim' }); assert.ok('issue' in created);
    const inspection = await run({ op: 'claim_show', issue_id: created.issue.id }); assert.ok('claim' in inspection);
    const acquire = parseOperation({ op: 'claim_acquire', issue_id: created.issue.id, incarnation: inspection.claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'Codex' });
    if (acquire.op !== 'claim_acquire') throw new Error('Invalid acquire');
    const accepted = await run(acquire); assert.ok('claim_receipt' in accepted); const receipt = accepted.claim_receipt;
    for (const change of [{ issue_id: 'pd-999' }, { incarnation: 'f'.repeat(32) }, { session_id: crypto.randomUUID() }, { generation: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { agent_label: 'Other' }, { agent_label: 'あ'.repeat(22) }, { expires_at: receipt.expires_at + 1 }, { acquired_at: receipt.acquired_at + 1 }, { outcome: 'released' }, { released_at: receipt.changed_at }, { actor: '' }, { extra: true }]) {
      await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: acquire, authorize: async () => 'synthetic', fetch: async () => Response.json({ claim_receipt: { ...receipt, ...change } }) }), { code: 'cloud_invalid_response', details: { request_id: acquire.request_id } });
    }
    const shown = await run({ op: 'claim_show', issue_id: created.issue.id }); assert.ok('claim' in shown);
    for (const change of [{ state: 'released' }, { observed_at: -1 }, { lease: { ...shown.claim.lease, issue_id: 'pd-999' } }, { extra: true }]) await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: parseOperation({ op: 'claim_show', issue_id: created.issue.id }), authorize: async () => 'synthetic', fetch: async () => Response.json({ claim: { ...shown.claim, ...change } }) }), { code: 'cloud_invalid_response' });
    await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: parseOperation({ op: 'claim_list', limit: 1 }), authorize: async () => 'synthetic', fetch: async () => Response.json({ claims: [shown.claim], next_cursor: 'pd-999' }) }), { code: 'cloud_invalid_response' });
    const claim_proof = { issue_id: receipt.issue_id, incarnation: receipt.incarnation, session_id: receipt.session_id, generation: receipt.generation };
    for (const command of [acquire, parseOperation({ op: 'claim_renew', claim_proof, expected_revision: 1, request_id: crypto.randomUUID() }), parseOperation({ op: 'claim_release', claim_proof, expected_revision: 1, request_id: crypto.randomUUID() })]) {
      if (!('request_id' in command)) throw new Error('Missing request UUID'); let dispatched = 0;
      await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: command, authorize: async () => 'synthetic', fetch: async () => { dispatched++; throw new Error('Response lost'); } }), { code: 'cloud_unavailable', details: { request_id: command.request_id } }); assert.equal(dispatched, 1);
    }
  } finally { sqlite.close(); }
});

test('response boundary rejects HTML, redirects, missing fields, oversized bodies and unsafe error details', async () => {
  const replies = [new Response('<html>secret</html>'), new Response('', { status: 302, headers: { location: 'https://other.example' } }),
    Response.json({}), Response.json({ actor: 'x', extra: true }), Response.json({ actor: 'x' }, { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }),
    Response.json({ error: { code: 'invalid_input', message: 'secret', details: { token: 'secret' } } }, { status: 400 }),
    new Response('x'.repeat(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })];
  for (const response of replies) await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: { op: 'actor' },
    authorize: async () => 'secret', fetch: async () => response }), { code: 'cloud_invalid_response' });
  for (const [status, code] of [[401, 'auth_required'], [403, 'denied']] satisfies [number, string][]) {
    await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: { op: 'actor' }, authorize: async () => 'secret',
      fetch: async () => new Response('<html>secret</html>', { status }) }), { code });
  }
  await assert.rejects(executeCloudOperation({ origin: 'http://127.0.0.1', operation: { op: 'actor' }, authorize: async () => 'secret' }), { code: 'invalid_configuration' });
});

test('transport reports unavailable signing keys with fixed guidance and retains the create request ID', async () => {
  const requestId = crypto.randomUUID();
  const operation = parseOperation({ op: 'create', prefix: 'pd', request_id: requestId, tool: 'test', project: 'cloud', body: 'sample' });
  let requests = 0;
  let sentOperation: unknown;
  await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation, authorize: async () => 'synthetic-secret',
    fetch: async (_url, init) => {
      requests += 1;
      sentOperation = JSON.parse(String(init?.body));
      return Response.json({ error: { code: 'jwks_unavailable', message: 'Authentication unavailable' } }, { status: 503 });
    } }), error => {
      assert.ok(error instanceof PolylinedbError);
      assert.equal(error.code, 'jwks_unavailable');
      assert.equal(error.message, 'Cloud signing keys are temporarily unavailable. Retry later with the same request ID when one was returned.');
      assert.equal(error.status, 503);
      assert.deepEqual(error.details, { request_id: requestId });
      return true;
    });
  assert.equal(requests, 1);
  assert.deepEqual(sentOperation, operation);
});

test('transport rejects malformed JWKS errors and JWKS codes under other statuses', async () => {
  const exact = { error: { code: 'jwks_unavailable', message: 'Authentication unavailable' } };
  const invalidResponses = [
    { status: 503, body: { ...exact, request_id: 'unexpected' } },
    { status: 503, body: { error: { ...exact.error, details: {} } } },
    { status: 503, body: { error: { ...exact.error, message: 'x'.repeat(4097) } } },
    { status: 503, body: { error: { ...exact.error, message: 42 } } },
    { status: 502, body: exact },
    ...[400, 404, 409].map(status => ({ status, body: exact })),
  ];
  for (const { status, body } of invalidResponses) {
    await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: { op: 'actor' }, authorize: async () => 'secret',
      fetch: async () => Response.json(body, { status }) }), error => {
      assert.ok(error instanceof PolylinedbError);
      assert.equal(error.code, 'cloud_invalid_response', `${status} ${JSON.stringify(body)}`);
      assert.equal(error.status, 502);
      return true;
    });
  }
  for (const [status, code] of [[401, 'auth_required'], [403, 'denied']] satisfies [number, string][]) {
    await assert.rejects(executeCloudOperation({ origin: 'https://issues.example', operation: { op: 'actor' }, authorize: async () => 'secret',
      fetch: async () => Response.json(exact, { status }) }), { code, status });
  }
});
