/** Decodes real Worker responses in older and newer shapes through the cloud client, and rejects missing or retyped fields. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { storageOf } from 'solarsql/node';
import { createAccessVerifier } from '../src/service/access.ts';
import { handleRequest } from '../src/service/index.ts';
import { SCHEMA_SQL } from '../src/records/schema.ts';
import { executeCloudOperation } from '../src/cloud-client/cloud-operations.ts';
import { parseOperation } from '../src/records/index.ts';
import { PolylinedbError } from '../src/records/errors.ts';

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
const authenticate = createAccessVerifier(async () => Response.json({ keys: [{ ...publicKey, kid: 'test', alg: 'RS256', use: 'sig' }] }));
async function assertion(): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const encoded = `${encode({ alg: 'RS256', kid: 'test' })}.${encode({ iss: 'https://polylinedb-test.cloudflareaccess.com', aud: ['polylinedb-test'],
    sub: 'owner', exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(encoded));
  return `${encoded}.${Buffer.from(signature).toString('base64url')}`;
}
async function worker() {
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
  const token = await assertion();
  const transport: typeof fetch = (_url, options) => handleRequest(new Request('https://issues.example/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: String(options?.body),
  }), env, authenticate);
  const wire = async (value: Record<string, unknown>) => {
    const response = await transport('https://issues.example/v1/operations', { body: JSON.stringify(value) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { sqlite, transport, wire };
}

const origin = 'https://issues.example';
const decode = (value: unknown, fetch: typeof globalThis.fetch) => executeCloudOperation({ origin, operation: parseOperation(value), authorize: async () => 'synthetic-secret', fetch });
const answer = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });
async function outcome(pending: Promise<unknown>): Promise<unknown> {
  try { return { result: await pending }; }
  catch (error) { assert.ok(error instanceof PolylinedbError); return { error: { code: error.code, status: error.status, details: error.details } }; }
}
// The names include fields that the issue row decoder reads from storage rows, so a response cannot override them.
function future(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(future);
  if (typeof value !== 'object' || value === null) return value;
  return { ...Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, future(entry)])),
    future_field: { nested: [{ deeper: true }] }, closed_at: null, labels_json: '["injected"]', body_v: 99 };
}

test('a newer Worker response with unknown top-level and nested fields decodes to the same result as the current shape', async () => {
  const { sqlite, wire } = await worker();
  const decodedAlike = async (value: Record<string, unknown>, extend = (body: Record<string, unknown>) => future(body)) => {
    const { status, body } = await wire(value);
    const current = await outcome(decode(value, answer(body, status)));
    assert.equal(JSON.stringify(current).includes('cloud_invalid_response'), false, `${value.op} ${JSON.stringify(body)}`);
    assert.deepEqual(await outcome(decode(value, answer(extend(body), status))), current, String(value.op));
    return current;
  };
  try {
    await decodedAlike({ op: 'actor' });
    const blocker = { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Blocker' };
    await decodedAlike(blocker);
    const dependent = { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Dependent', labels: ['ready'] };
    await decodedAlike(dependent);
    await decodedAlike({ op: 'comment', id: 'pd-2', body: 'Noted' });
    await decodedAlike({ op: 'update', id: 'pd-2', changes: [{ field: 'body', expected: 1, value: 'Edited' }] });
    await decodedAlike({ op: 'update', id: 'pd-2', changes: [{ field: 'body', expected: 1, value: 'Stale' }] });
    await decodedAlike({ op: 'show', id: 'pd-2' });
    await decodedAlike({ op: 'show', id: 'pd-9' });
    for (const op of ['list', 'search']) await decodedAlike({ op, project: 'compat', ...(op === 'search' ? { query: 'Edited' } : {}) });
    await decodedAlike({ op: 'dependency_add', dependent_id: 'pd-2', blocker_id: 'pd-1', expected_revision: 1, request_id: crypto.randomUUID() });
    await decodedAlike({ op: 'dependency_add', dependent_id: 'pd-2', blocker_id: 'pd-1', expected_revision: 1, request_id: crypto.randomUUID() });
    await decodedAlike({ op: 'dependency_list', dependent_id: 'pd-2' });
    await decodedAlike({ op: 'dependency_worklist', state: 'blocked' });
    const shown = await wire({ op: 'claim_show', issue_id: 'pd-2' });
    await decodedAlike({ op: 'claim_show', issue_id: 'pd-2' });
    const claim = shown.body.claim as { store_incarnation: string };
    const acquire = { op: 'claim_acquire', issue_id: 'pd-2', incarnation: claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'Codex' };
    const acquired = await decodedAlike(acquire, body => ({ ...future(body) as object, open_blockers: ['pd-1'] }));
    await decodedAlike({ ...acquire, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() });
    assert.ok(typeof acquired === 'object' && acquired !== null && 'result' in acquired);
    const claim_proof = { issue_id: 'pd-2', incarnation: claim.store_incarnation, session_id: acquire.session_id, generation: 1 };
    await decodedAlike({ op: 'claim_renew', claim_proof, expected_revision: 1, request_id: crypto.randomUUID() }, body => ({ ...future(body) as object, open_blockers: 'ignored outside acquisition' }));
    await decodedAlike({ op: 'claim_list', project: 'compat' });
    await decodedAlike({ op: 'close', id: 'pd-2', expected: 1, claim_proof });
    await decodedAlike({ op: 'claim_release', claim_proof, expected_revision: 2, request_id: crypto.randomUUID() });
    await decodedAlike({ op: 'reopen', id: 'pd-2', expected: 2 });
    const memory = { op: 'memory_create', project: 'compat', prefix: 'pd', request_id: crypto.randomUUID(), title: 'Fact', body: 'Confirmed' };
    await decodedAlike(memory);
    const created = await wire(memory); const id = (created.body.memory as { id: string }).id;
    await decodedAlike({ op: 'memory_show', project: 'compat', id });
    await decodedAlike({ op: 'memory_update', project: 'compat', id, title: 'Fact', body: 'Revised', expected: 1 });
    await decodedAlike({ op: 'memory_update', project: 'compat', id, title: 'Fact', body: 'Stale', expected: 1 });
    await decodedAlike({ op: 'memory_list', project: 'compat' });
    await decodedAlike({ op: 'memory_search', project: 'compat', query: 'Revised' });
    const context = await wire({ op: 'memory_context', project: 'compat', with_revision: true });
    await decodedAlike({ op: 'memory_context', project: 'compat', with_revision: true });
    await decodedAlike({ op: 'show', id: 'pd-2', observed_memory_revision: context.body.memory_revision });
    await decodedAlike({ op: 'memory_delete', project: 'compat', id, expected: 2 });
    await decodedAlike({ op: 'memory_show', project: 'compat', id });
  } finally { sqlite.close(); }
});

test('an older Worker show without claim completes through one claim_show request', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Old Worker' });
    const context = await wire({ op: 'memory_context', project: 'compat', with_revision: true });
    for (const show of [{ op: 'show', id: 'pd-1' }, { op: 'show', id: 'pd-1', observed_memory_revision: context.body.memory_revision }]) {
      const current = await decode(show, transport);
      const sent: Record<string, unknown>[] = [];
      const older: typeof fetch = async (url, options) => {
        const operation = JSON.parse(String(options?.body)); sent.push(operation);
        const response = await transport(url, options);
        if (operation.op !== 'show') return response;
        const { claim: _, ...withoutClaim } = await response.json();
        return Response.json(withoutClaim);
      };
      const completed = await decode(show, older);
      assert.ok('claim' in completed && 'claim' in current);
      assert.deepEqual({ ...completed, claim: { ...completed.claim, observed_at: 0 } }, { ...current, claim: { ...current.claim, observed_at: 0 } });
      assert.deepEqual(sent, [show, { op: 'claim_show', issue_id: 'pd-1' }]);
    }
    const { claim: _, ...withoutClaim } = (await wire({ op: 'show', id: 'pd-1' })).body;
    await assert.rejects(decode({ op: 'show', id: 'pd-1' }, async (_url, options) => JSON.parse(String(options?.body)).op === 'show'
      ? Response.json(withoutClaim) : Response.json({ error: { code: 'not_found', message: 'Missing', details: { id: 'pd-1' } } }, { status: 404 })), { code: 'not_found' });
    await assert.rejects(decode({ op: 'show', id: 'pd-1' }, answer(withoutClaim)), { code: 'cloud_invalid_response' });
  } finally { sqlite.close(); }
});

test('an older Worker that rejects with_matches answers a search through one plain search request', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Old Worker search' });
    const context = await wire({ op: 'memory_context', project: 'compat', with_revision: true });
    const rejection = (details?: unknown) => Response.json({ error: { code: 'invalid_input', message: 'Unexpected field: with_matches', ...(details === undefined ? {} : { details }) } }, { status: 400 });
    const recorded = (reply: (operation: Record<string, unknown>) => Response | Promise<Response>) => {
      const sent: Record<string, unknown>[] = [];
      const fetch: typeof globalThis.fetch = async (_url, options) => { const operation = JSON.parse(String(options?.body)); sent.push(operation); return reply(operation); };
      return { sent, fetch };
    };
    const forwarded = (operation: Record<string, unknown>) => transport('https://issues.example/v1/operations', { body: JSON.stringify(operation) });
    const sentForm = (value: unknown) => JSON.parse(JSON.stringify(parseOperation(value)));
    for (const plain of [{ op: 'search', query: 'Old Worker' }, { op: 'search', query: 'Old Worker', project: 'compat', limit: 1, observed_memory_revision: context.body.memory_revision }]) {
      const search = { ...plain, with_matches: true };
      const older = recorded(operation => 'with_matches' in operation ? rejection() : forwarded(operation));
      const answered = await decode(search, older.fetch);
      assert.equal('matches' in answered, false);
      assert.deepEqual(answered, await decode(plain, transport));
      assert.deepEqual(older.sent, [search, plain].map(sentForm));
    }
    const search = { op: 'search', query: 'Old Worker', with_matches: true };
    const rejectsEvery = recorded(() => rejection());
    await assert.rejects(decode(search, rejectsEvery.fetch), { code: 'invalid_input', status: 400 });
    assert.deepEqual(rejectsEvery.sent, [search, { op: 'search', query: 'Old Worker' }].map(sentForm));
    const retryUnavailable = recorded(operation => 'with_matches' in operation ? rejection() : Response.json({ error: { code: 'jwks_unavailable', message: 'Unavailable' } }, { status: 503 }));
    await assert.rejects(decode(search, retryUnavailable.fetch), { code: 'jwks_unavailable', status: 503 });
    assert.equal(retryUnavailable.sent.length, 2);
    const reauthorization = new Error('synthetic grant expired');
    let authorizations = 0;
    const expiring = recorded(() => rejection());
    await assert.rejects(executeCloudOperation({ origin, operation: parseOperation(search), fetch: expiring.fetch,
      authorize: async () => { authorizations++; if (authorizations > 1) throw reauthorization; return 'synthetic-secret'; } }), error => error === reauthorization);
    assert.deepEqual([authorizations, expiring.sent.length], [2, 1]);
    const otherField = recorded(() => Response.json({ error: { code: 'invalid_input', message: 'Unexpected field: future_filter' } }, { status: 400 }));
    await assert.rejects(decode(search, otherField.fetch), { code: 'invalid_input', status: 400 });
    assert.equal(otherField.sent.length, 1);
    const unrequested = recorded(() => rejection());
    await assert.rejects(decode({ op: 'search', query: 'Old Worker' }, unrequested.fetch), { code: 'invalid_input', status: 400 });
    assert.equal(unrequested.sent.length, 1);
    const detailed = recorded(() => rejection({ field: 'with_matches' }));
    await assert.rejects(decode(search, detailed.fetch), { code: 'cloud_invalid_response' });
    assert.equal(detailed.sent.length, 1);
  } finally { sqlite.close(); }
});

test('missing required fields and retyped fields stay cloud_invalid_response at every level', async () => {
  const { sqlite, wire } = await worker();
  try {
    await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Blocker' });
    await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Dependent' });
    await wire({ op: 'comment', id: 'pd-2', body: 'Noted' });
    const shown = (await wire({ op: 'show', id: 'pd-2' })).body as { issue: Record<string, unknown> & { versions: Record<string, unknown> }; comments: Record<string, unknown>[]; claim: Record<string, unknown> };
    const { body: _, ...issueWithoutBody } = shown.issue;
    const { labels: __, ...versionsWithoutLabels } = shown.issue.versions;
    const { created_by: ___, ...commentWithoutAuthor } = shown.comments[0] ?? {};
    const { lease: ____, ...claimWithoutLease } = shown.claim;
    const { comments: _____, ...showWithoutComments } = shown;
    const show = { op: 'show', id: 'pd-2' };
    for (const damaged of [showWithoutComments, { ...shown, comments: {} }, { ...shown, claim: null }, { ...shown, claim: claimWithoutLease }, { ...shown, claim: { ...shown.claim, observed_at: '1' } },
      { ...shown, issue: issueWithoutBody }, { ...shown, issue: { ...shown.issue, priority: '2' } }, { ...shown, issue: { ...shown.issue, versions: versionsWithoutLabels } },
      { ...shown, issue: { ...shown.issue, versions: { ...shown.issue.versions, body: '1' } } }, { ...shown, comments: [commentWithoutAuthor] }]) {
      let requests = 0;
      await assert.rejects(decode(show, async () => { requests++; return Response.json(damaged); }), { code: 'cloud_invalid_response' }, JSON.stringify(damaged));
      assert.equal(requests, 1);
    }
    const listed = (await wire({ op: 'list', project: 'compat' })).body;
    for (const damaged of [{ issues: listed.issues }, { ...listed, issues: {} }, { ...listed, next_cursor: 5 }]) await assert.rejects(decode({ op: 'list', project: 'compat' }, answer(damaged)), { code: 'cloud_invalid_response' });
    await wire({ op: 'dependency_add', dependent_id: 'pd-2', blocker_id: 'pd-1', expected_revision: 1, request_id: crypto.randomUUID() });
    const acquire = { op: 'claim_acquire', issue_id: 'pd-2', incarnation: shown.claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() };
    const acquired = (await wire(acquire)).body as { claim_receipt: Record<string, unknown> };
    const { generation: ______, ...receiptWithoutGeneration } = acquired.claim_receipt;
    for (const damaged of [{}, { claim_receipt: receiptWithoutGeneration }, { claim_receipt: { ...acquired.claim_receipt, outcome: 'renewed' } },
      { ...acquired, open_blockers: 'pd-1' }, { ...acquired, open_blockers: ['pd-2'] }, { ...acquired, open_blockers: [5] }, { ...acquired, open_blockers: ['pd-3', 'pd-1'] }]) {
      await assert.rejects(decode(acquire, answer(damaged)), { code: 'cloud_invalid_response', details: { request_id: acquire.request_id } }, JSON.stringify(damaged));
    }
    const conflict = await wire({ op: 'update', id: 'pd-2', changes: [{ field: 'body', expected: 9, value: 'Stale' }] });
    const error = conflict.body.error as Record<string, unknown> & { details: Record<string, unknown> };
    const { message: _______, ...errorWithoutMessage } = error;
    for (const damaged of [{ error: errorWithoutMessage }, { error: { ...error, code: 5 } }, { error: { ...error, details: { issue: error.details.issue } } }]) {
      await assert.rejects(decode({ op: 'update', id: 'pd-2', changes: [{ field: 'body', expected: 9, value: 'Stale' }] }, answer(damaged, conflict.status)), { code: 'cloud_invalid_response' });
    }
  } finally { sqlite.close(); }
});

test('error envelopes accept unknown fields but keep their fixed messages and decoded details', async () => {
  const actor = { op: 'actor' };
  await assert.rejects(decode(actor, answer({ error: { code: 'jwks_unavailable', message: 'Unavailable', details: { trace: 'synthetic-private-token' } }, request_id: 'x' }, 503)), error => {
    assert.ok(error instanceof PolylinedbError);
    assert.equal(error.code, 'jwks_unavailable');
    assert.equal(error.message.includes('synthetic-private-token'), false);
    assert.equal(error.details, undefined);
    return true;
  });
  const comment = { op: 'comment', id: 'pd-1', body: 'note' };
  await assert.rejects(decode(comment, answer({ error: { code: 'read_only_actor', message: 'Read only', details: { op: 'comment', role: 'reader' }, hint: 'x' } }, 403)),
    { code: 'read_only_actor', status: 403, details: { op: 'comment' } });
  await assert.rejects(decode(comment, answer({ error: { code: 'not_found', message: 'Missing', details: { id: 'pd-1', hint: 'x' }, trace: 'x' }, extra: true }, 404)),
    error => { assert.ok(error instanceof PolylinedbError); assert.deepEqual([error.code, error.details], ['not_found', { id: 'pd-1' }]); return true; });
  await assert.rejects(decode(comment, answer({ error: { code: 'invalid_input', message: 'Bad', details: { token: 'synthetic-private-token' } } }, 400)), { code: 'cloud_invalid_response' });
});
