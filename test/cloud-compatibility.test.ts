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
  // Forwards only the issue-field opt-in from the client, so a test sees what that header changes.
  const transport: typeof fetch = (_url, options) => {
    const issueFields = new Headers(options?.headers).get('polylinedb-issue-fields');
    return handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token, ...(issueFields === null ? {} : { 'polylinedb-issue-fields': issueFields }) }, body: String(options?.body),
    }), env, authenticate);
  };
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
// The closure is a wire field now; the closure test covers it.
function future(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(future);
  if (typeof value !== 'object' || value === null) return value;
  return { ...Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, future(entry)])),
    future_field: { nested: [{ deeper: true }] }, labels_json: '["injected"]', body_v: 99 };
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
    await decodedAlike({ op: 'update', id: 'pd-1', changes: [{ field: 'labels', expected: 1, value: ['owner-action'] }] });
    await decodedAlike({ op: 'dependency_owner_waits', project: 'compat' });
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

test('an older Worker claim_acquire without open_blockers decodes the receipt', async () => {
  const { sqlite, wire } = await worker();
  try {
    await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Blocker' });
    await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Dependent' });
    await wire({ op: 'dependency_add', dependent_id: 'pd-2', blocker_id: 'pd-1', expected_revision: 1, request_id: crypto.randomUUID() });
    const shown = await wire({ op: 'claim_show', issue_id: 'pd-2' });
    const acquire = { op: 'claim_acquire', issue_id: 'pd-2', incarnation: (shown.body.claim as { store_incarnation: string }).store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'Codex' };
    const acquired = (await wire(acquire)).body as { claim_receipt: Record<string, unknown>; open_blockers: unknown; previous_lease: unknown };
    const current = await decode(acquire, answer(acquired));
    assert.deepEqual(current, { claim_receipt: acquired.claim_receipt, open_blockers: ['pd-1'], previous_lease: null });
    const { open_blockers: _, previous_lease: __, ...older } = acquired;
    assert.equal(Object.hasOwn(older, 'open_blockers'), false);
    assert.deepEqual(await decode(acquire, answer(older)), { claim_receipt: acquired.claim_receipt });
    await assert.rejects(decode(acquire, answer({ ...acquired, open_blockers: ['pd-2'] })), { code: 'cloud_invalid_response' });
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

test('an authorization failure during the show claim fallback stays the authorize error', async () => {
  const show = { op: 'show', id: 'pd-1' };
  const reauthorization = new Error('synthetic grant expired');
  let authorizations = 0;
  const sent: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)));
    return Response.json({ issue: { id: 'pd-1' }, comments: [] });
  };
  await assert.rejects(executeCloudOperation({ origin, operation: parseOperation(show), fetch,
    authorize: async () => { authorizations++; if (authorizations > 1) throw reauthorization; return 'synthetic-secret'; } }), error => error === reauthorization);
  assert.deepEqual([authorizations, sent], [2, [JSON.parse(JSON.stringify(parseOperation(show)))]]);
});

test('an older Worker that rejects with_matches answers a search through one plain search request', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Old Worker search' });
    const context = await wire({ op: 'memory_context', project: 'compat', with_revision: true });
    const rejection = (details?: unknown) => Response.json({ error: { code: 'invalid_input', message: 'Unexpected field: with_matches', ...(details === undefined ? {} : { details }) } }, { status: 400 });
    const recorded = (reply: (operation: Record<string, unknown>, options?: RequestInit) => Response | Promise<Response>) => {
      const sent: Record<string, unknown>[] = [];
      const fetch: typeof globalThis.fetch = async (_url, options) => { const operation = JSON.parse(String(options?.body)); sent.push(operation); return reply(operation, options); };
      return { sent, fetch };
    };
    const forwarded = (operation: Record<string, unknown>, options?: RequestInit) => transport('https://issues.example/v1/operations', { ...options, body: JSON.stringify(operation) });
    const sentForm = (value: unknown) => JSON.parse(JSON.stringify(parseOperation(value)));
    for (const plain of [{ op: 'search', query: 'Old Worker' }, { op: 'search', query: 'Old Worker', project: 'compat', limit: 1, observed_memory_revision: context.body.memory_revision }]) {
      const search = { ...plain, with_matches: true };
      const older = recorded((operation, options) => 'with_matches' in operation ? rejection() : forwarded(operation, options));
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

test('a release that asks for expired_noop gets a clear answer from an older Worker that rejects or ignores the field', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    const created = await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Old Worker release' });
    const issue_id = (created.body.issue as { id: string }).id;
    const incarnation = ((await wire({ op: 'claim_show', issue_id })).body.claim as { store_incarnation: string }).store_incarnation;
    const acquire = async () => {
      const session_id = crypto.randomUUID();
      const receipt = (await wire({ op: 'claim_acquire', issue_id, incarnation, session_id, request_id: crypto.randomUUID() })).body.claim_receipt as { generation: number; revision: number };
      return { claim_proof: { issue_id, incarnation, session_id, generation: receipt.generation }, revision: receipt.revision };
    };
    const recorded = (reply: (operation: Record<string, unknown>) => Response | Promise<Response>) => {
      const sent: Record<string, unknown>[] = [];
      const fetch: typeof globalThis.fetch = async (_url, options) => { const operation = JSON.parse(String(options?.body)); sent.push(operation); return reply(operation); };
      return { sent, fetch };
    };
    const forwarded = (operation: Record<string, unknown>) => transport('https://issues.example/v1/operations', { body: JSON.stringify(operation) });
    const withoutField = ({ expired_noop: _, ...plain }: Record<string, unknown>) => plain;
    const rejecting = () => recorded(operation => 'expired_noop' in operation
      ? Response.json({ error: { code: 'invalid_input', message: 'Unexpected field: expired_noop' } }, { status: 400 })
      : forwarded(operation));
    const expired = await acquire();
    sqlite.prepare('UPDATE issue_claims SET acquired_at = 100, changed_at = 100, expires_at = 1000 WHERE issue_id = ?').run(issue_id);
    const release = { op: 'claim_release', claim_proof: expired.claim_proof, expected_revision: expired.revision, request_id: crypto.randomUUID(), expired_noop: true };
    const older = rejecting();
    assert.deepEqual(await outcome(decode(release, older.fetch)), { error: { code: 'claim_conflict', status: 409, details: { current: (await wire({ op: 'claim_show', issue_id })).body.claim } } });
    assert.deepEqual(older.sent, [release, withoutField(release)]);
    const ignoring = recorded(operation => forwarded(withoutField(operation)));
    await assert.rejects(decode(release, ignoring.fetch), { code: 'claim_conflict', status: 409 });
    assert.equal(ignoring.sent.length, 1);
    const current = await decode(release, transport);
    assert.equal('released' in current && current.released, false);
    const plain = await decode(withoutField(release), answer(current));
    assert.equal('released' in plain && plain.released, false);
    assert.equal('current' in plain && plain.current.state, 'expired');
    const active = await acquire();
    const activeRelease = { op: 'claim_release', claim_proof: active.claim_proof, expected_revision: active.revision, request_id: crypto.randomUUID(), expired_noop: true };
    const olderActive = rejecting();
    const released = await decode(activeRelease, olderActive.fetch);
    assert.equal('claim_receipt' in released && released.claim_receipt.outcome, 'released');
    assert.deepEqual(olderActive.sent, [activeRelease, withoutField(activeRelease)]);
  } finally { sqlite.close(); }
});

test('a deployed Worker that rejects expired_noop and returns the no-op on the plain release decodes', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    const created = await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Deployed release' });
    const issue_id = (created.body.issue as { id: string }).id;
    const incarnation = ((await wire({ op: 'claim_show', issue_id })).body.claim as { store_incarnation: string }).store_incarnation;
    const session_id = crypto.randomUUID();
    const receipt = (await wire({ op: 'claim_acquire', issue_id, incarnation, session_id, request_id: crypto.randomUUID() })).body.claim_receipt as { generation: number; revision: number };
    sqlite.prepare('UPDATE issue_claims SET acquired_at = 100, changed_at = 100, expires_at = 1000 WHERE issue_id = ?').run(issue_id);
    const release = { op: 'claim_release', claim_proof: { issue_id, incarnation, session_id, generation: receipt.generation }, expected_revision: receipt.revision, request_id: crypto.randomUUID(), expired_noop: true };
    const noop = await decode(release, transport);
    assert.equal('released' in noop && noop.released, false);
    const sent: Record<string, unknown>[] = [];
    const fetch: typeof globalThis.fetch = async (_url, options) => {
      const operation = JSON.parse(String(options?.body)) as Record<string, unknown>;
      sent.push(operation);
      if ('expired_noop' in operation) return Response.json({ error: { code: 'invalid_input', message: 'Unexpected field: expired_noop' } }, { status: 400 });
      return Response.json(noop);
    };
    const decoded = await decode(release, fetch);
    assert.equal('released' in decoded && decoded.released, false);
    assert.equal('current' in decoded && decoded.current.state, 'expired');
    if (!('current' in decoded) || decoded.current.lease === null) throw new Error('missing lease');
    assert.equal(decoded.current.lease.session_id, session_id);
    assert.equal(decoded.current.lease.revision, receipt.revision);
    assert.equal(decoded.current.lease.released_at, null);
    assert.deepEqual(sent.map(operation => Object.hasOwn(operation, 'expired_noop')), [true, false]);
    assert.equal(sent[1]?.request_id, release.request_id);
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

const issueShape = {
  id: 'string', tool: 'string', project: 'string', body: 'string', status: 'string', type: 'string', priority: 'number', labels: ['string'],
  versions: { tool: 'number', project: 'number', body: 'number', status: 'number', type: 'number', priority: 'number', labels: 'number' },
  created_at: 'string', created_by: 'string', updated_at: 'string', updated_by: 'string',
};
const commentShape = { id: 'string', issue_id: 'string', body: 'string', created_at: 'string', created_by: 'string' };
const claimShape = { issue_id: 'string', incarnation: 'string', session_id: 'string', generation: 'number', actor: 'string', agent_label: 'string|null', revision: 'number', acquired_at: 'number', changed_at: 'number', expires_at: 'number', released_at: 'number|null' };
const inspectionShape = { issue_id: 'string', store_incarnation: 'string', observed_at: 'number', state: 'string', lease: claimShape };
function assertShape(value: unknown, shape: unknown, path = 'response'): void {
  if (shape === null) { assert.equal(value, null, path); return; }
  if (shape === 'string|null') { assert.ok(value === null || typeof value === 'string', path); return; }
  if (shape === 'number|null') { assert.ok(value === null || typeof value === 'number', path); return; }
  if (Array.isArray(shape)) {
    assert.ok(Array.isArray(value), path);
    const item = shape[0];
    if (item !== undefined) for (const [index, entry] of value.entries()) assertShape(entry, item, `${path}[${index}]`);
    return;
  }
  if (shape === 'string' || shape === 'number' || shape === 'boolean') { assert.equal(typeof value, shape, path); return; }
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), path);
  const row = value as Record<string, unknown>;
  const expected = shape as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), Object.keys(expected).sort(), path);
  for (const key of Object.keys(expected)) assertShape(row[key], expected[key], `${path}.${key}`);
}

test('existing operation responses keep the keys a released client decodes', async () => {
  const { sqlite, wire } = await worker();
  try {
    const created = await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Released shape' });
    assertShape(created.body, { issue: issueShape });
    const id = (created.body.issue as { id: string }).id;
    assertShape((await wire({ op: 'comment', id, body: 'Noted' })).body, { comment: commentShape });
    assertShape((await wire({ op: 'update', id, changes: [{ field: 'body', expected: 1, value: 'Edited' }] })).body, { issue: issueShape });
    const conflict = await wire({ op: 'update', id, changes: [{ field: 'body', expected: 1, value: 'Stale' }] });
    assertShape(conflict.body, { error: { code: 'string', message: 'string', details: { issue: issueShape, fields: [{ field: 'string', expected: 'number', actual: 'number', current: 'string' }] } } });
    const shown = await wire({ op: 'show', id });
    assertShape(shown.body, { issue: issueShape, comments: [commentShape], claim: { ...inspectionShape, lease: null } });
    assertShape((await wire({ op: 'list', project: 'compat' })).body, { issues: [issueShape], next_cursor: 'string|null' });
    assertShape((await wire({ op: 'search', query: 'Edited' })).body, { issues: [issueShape], next_cursor: 'string|null' });
    const matched = await wire({ op: 'search', query: 'Edited', with_matches: true });
    assertShape(matched.body, { issues: [issueShape], next_cursor: 'string|null', matches: [{ issue_id: 'string', location: 'string', excerpt: 'string' }] });
    assertShape((await wire({ op: 'dependency_add', dependent_id: id, blocker_id: id, expected_revision: 1, request_id: crypto.randomUUID() })).body, { error: { code: 'string', message: 'string' } });
    const blocker = (await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Blocker' })).body.issue as { id: string };
    assertShape((await wire({ op: 'dependency_add', dependent_id: id, blocker_id: blocker.id, expected_revision: 1, request_id: crypto.randomUUID() })).body, { dependency: { dependent_id: 'string', blocker_id: 'string', revision: 'number', outcome: 'string' } });
    assertShape((await wire({ op: 'dependency_list', dependent_id: id })).body, { dependent_id: 'string', revision: 'number', blockers: [{ id: 'string', project: 'string', status: 'string' }], next_cursor: 'string|null' });
    assertShape((await wire({ op: 'dependency_worklist', state: 'blocked' })).body, { issues: [issueShape], next_cursor: 'string|null' });
    assertShape((await wire({ op: 'dependency_owner_waits' })).body, { waits: [], next_cursor: 'string|null' });
    const inspection = await wire({ op: 'claim_show', issue_id: id });
    assertShape(inspection.body, { claim: { ...inspectionShape, lease: null } });
    const acquire = { op: 'claim_acquire', issue_id: id, incarnation: (inspection.body.claim as { store_incarnation: string }).store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'Codex' };
    const acquiredBody = (await wire(acquire)).body;
    assertShape(acquiredBody, { claim_receipt: { ...claimShape, outcome: 'string' }, open_blockers: ['string'], previous_lease: null });
    assert.deepEqual(acquiredBody.open_blockers, [blocker.id]);
    assert.deepEqual((await wire(acquire)).body.open_blockers, [blocker.id]);
    const replay = await wire({ ...acquire, agent_label: 'Other' });
    assertShape(replay.body, { error: { code: 'string', message: 'string' } });
    assert.equal((replay.body.error as { code: string }).code, 'claim_request_conflict');
    const active = await wire({ op: 'show', id });
    assertShape(active.body, { issue: issueShape, comments: [commentShape], claim: inspectionShape });
    assertShape((await wire({ op: 'actor' })).body, { actor: 'string' });
    const memoryRequest = { op: 'memory_create', project: 'compat', prefix: 'pd', request_id: crypto.randomUUID(), title: 'Fact', body: 'Confirmed' };
    assertShape((await wire(memoryRequest)).body, { memory: { id: 'string', project: 'string', title: 'string', body: 'string', version: 'number', created_at: 'string', created_by: 'string', updated_at: 'string', updated_by: 'string' } });
    const feed = await wire({ op: 'changes', since: 0, limit: 1 });
    assertShape(feed.body, { incarnation: 'string', changes: [{ seq: 'number', incarnation: 'string', issue_id: 'string', kind: 'string', fields: ['string'], occurred_at: 'number', actor: 'string' }], next_since: 'number' });
    const waited = await wire({ op: 'wait', since: 0, timeout: 0 });
    assertShape(waited.body, { incarnation: 'string', changes: [{ seq: 'number', incarnation: 'string', issue_id: 'string', kind: 'string', fields: ['string'], occurred_at: 'number', actor: 'string' }], next_since: 'number' });
  } finally { sqlite.close(); }
});

test('a client that asks for the closure decodes closed_at and closed_by, and the default body still omits them', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    const sent: (string | null)[] = [];
    const spy: typeof fetch = (url, options) => { sent.push(new Headers(options?.headers).get('polylinedb-issue-fields')); return transport(url, options); };
    const created = await decode({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Closing' }, spy);
    assert.ok('issue' in created);
    assert.deepEqual([created.issue.closed_at, created.issue.closed_by], [null, null]);
    const id = created.issue.id;
    const closed = await decode({ op: 'update', id, changes: [{ field: 'status', expected: 1, value: 'closed' }] }, spy);
    assert.ok('issue' in closed);
    assert.equal(closed.issue.closed_by, 'access:owner');
    assert.equal(closed.issue.closed_at, closed.issue.updated_at);
    const shown = await decode({ op: 'show', id }, spy);
    assert.ok('issue' in shown);
    assert.deepEqual([shown.issue.closed_at, shown.issue.closed_by], [closed.issue.closed_at, 'access:owner']);
    assert.deepEqual(sent, ['closure', 'closure', 'closure']);

    const conflict = await transport('https://issues.example/v1/operations', { headers: { 'polylinedb-issue-fields': 'closure' },
      body: JSON.stringify({ op: 'update', id, changes: [{ field: 'body', expected: 9, value: 'Stale' }] }) });
    const details = (await conflict.json() as { error: { details: { issue: Record<string, unknown> } } }).error.details.issue;
    assert.equal(details.closed_by, 'access:owner');
    for (const plain of [(await wire({ op: 'show', id })).body.issue, (await wire({ op: 'list', project: 'compat', status: 'closed' })).body.issues]) {
      assert.equal(JSON.stringify(plain).includes('closed_'), false);
    }

    const body = (await wire({ op: 'show', id })).body;
    const olderWorker = await decode({ op: 'show', id }, answer(body));
    assert.ok('issue' in olderWorker);
    assert.equal(Object.hasOwn(olderWorker.issue, 'closed_at'), false);
    const issue = body.issue as Record<string, unknown>;
    const broken = [
      { ...issue, closed_at: closed.issue.closed_at },
      { ...issue, closed_by: 'access:owner' },
      { ...issue, status: 'open', closed_at: closed.issue.closed_at, closed_by: 'access:owner' },
      { ...issue, closed_at: 7, closed_by: 'access:owner' },
    ];
    for (const value of broken) {
      assert.deepEqual(await outcome(decode({ op: 'show', id }, answer({ ...body, issue: value }))),
        { error: { code: 'cloud_invalid_response', status: 502, details: undefined } }, JSON.stringify(value));
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

test('claim_acquire after an expired lease decodes the previous lease and rejects one that cannot precede the receipt', async () => {
  const { sqlite, wire } = await worker();
  try {
    await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Issue' });
    const incarnation = ((await wire({ op: 'claim_show', issue_id: 'pd-1' })).body.claim as { store_incarnation: string }).store_incarnation;
    const first = (await wire({ op: 'claim_acquire', issue_id: 'pd-1', incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'lane-a' })).body;
    sqlite.exec("UPDATE issue_claims SET acquired_at = 100, changed_at = 100, expires_at = 1000 WHERE issue_id = 'pd-1'");
    const acquire = { op: 'claim_acquire', issue_id: 'pd-1', incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'lane-b' };
    const body = (await wire(acquire)).body as { claim_receipt: Record<string, unknown>; previous_lease: Record<string, unknown> };
    assert.equal(body.previous_lease.session_id, (first.claim_receipt as { session_id: string }).session_id);
    const decoded = await decode(acquire, answer(body));
    assert.deepEqual(decoded, { claim_receipt: body.claim_receipt, open_blockers: [], previous_lease: body.previous_lease });
    for (const broken of [{ ...body.previous_lease, released_at: body.previous_lease.changed_at }, { ...body.previous_lease, generation: 2 }, { ...body.previous_lease, issue_id: 'pd-2' }]) {
      await assert.rejects(decode(acquire, answer({ ...body, previous_lease: broken })), { code: 'cloud_invalid_response' });
    }
  } finally { sqlite.close(); }
});

test('a released cloud client decodes claim_required when a start has no held claim', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    const created = await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Never claimed' });
    const id = (created.body.issue as { id: string }).id;
    const start = { op: 'update', id, changes: [{ field: 'status', expected: 1, value: 'in_progress' }] };
    const refused = await wire(start);
    assert.equal(refused.status, 409);
    assertShape(refused.body, { error: { code: 'string', message: 'string', details: { issue: issueShape } } });
    const released = await outcome(decode(start, answer(refused.body, refused.status)));
    assert.deepEqual(released, { error: { code: 'claim_required', status: 409, details: { issue: (refused.body.error as { details: { issue: unknown } }).details.issue } } });
    assert.deepEqual(await outcome(decode(start, transport)), { error: { code: 'claim_required', status: 409, details: { issue: { ...(refused.body.error as { details: { issue: object } }).details.issue, closed_at: null, closed_by: null } } } });
    assert.equal(((await wire({ op: 'show', id })).body.issue as { status: string }).status, 'open');
  } finally { sqlite.close(); }
});

test('an older Worker that rejects claimed fails the list instead of answering without the filter', async () => {
  const { sqlite, transport } = await worker();
  try {
    const sent: unknown[] = [];
    const older: typeof fetch = async (_url, options) => {
      const operation = JSON.parse(String(options?.body)); sent.push(operation);
      return 'claimed' in operation ? Response.json({ error: { code: 'invalid_input', message: 'Unexpected field: claimed' } }, { status: 400 }) : transport(_url, options);
    };
    assert.deepEqual(await outcome(decode({ op: 'list', claimed: false }, older)), { error: { code: 'invalid_input', status: 400, details: undefined } });
    await assert.rejects(decode({ op: 'list', claimed: true }, older), { message: 'The cloud Worker does not support the claimed filter. Deploy a newer Worker to use it.' });
    assert.deepEqual(sent, [{ op: 'list', limit: 50, claimed: false }, { op: 'list', limit: 50, claimed: true }]);
    assert.deepEqual(await decode({ op: 'list', claimed: false }, transport), { issues: [], next_cursor: null });
  } finally { sqlite.close(); }
});

test('land order: receipts, reads, and conflict details decode, and default show and list bodies keep their released keys', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    const create = async (body: string) => ((await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body })).body.issue as { id: string }).id;
    const later = await create('Later'); const earlier = await create('Earlier');
    const add = { op: 'land_order_add', later_id: later, earlier_id: earlier, expected_revision: 1, request_id: crypto.randomUUID() };
    assert.deepEqual(await decode(add, transport), { land_order_receipt: { later_id: later, earlier_id: earlier, revision: 2, outcome: 'added' } });
    assert.deepEqual(await decode({ op: 'land_order_list', issue_id: earlier }, transport), { issue_id: earlier, revision: 1, after: [], before: [{ id: later, project: 'compat', status: 'open' }] });
    assert.deepEqual(await outcome(decode({ ...add, request_id: crypto.randomUUID() }, transport)), { error: { code: 'land_order_conflict', status: 409,
      details: { expected_revision: 1, current: { issue_id: later, revision: 2, after: [{ id: earlier, project: 'compat', status: 'open' }], before: [] } } } });
    assert.deepEqual(await outcome(decode({ op: 'land_order_add', later_id: earlier, earlier_id: later, expected_revision: 1, request_id: crypto.randomUUID() }, transport)),
      { error: { code: 'dependency_cycle', status: 409, details: undefined } });
    assert.deepEqual(Object.keys((await wire({ op: 'show', id: later })).body).sort(), ['claim', 'comments', 'issue']);
    assert.deepEqual(Object.keys((await wire({ op: 'list', project: 'compat' })).body).sort(), ['issues', 'next_cursor']);
    const shown = await decode({ op: 'show', id: later, with_land_order: true }, transport);
    assert.deepEqual('land_order' in shown ? shown.land_order : undefined, { issue_id: later, revision: 2, after: [{ id: earlier, project: 'compat', status: 'open' }], before: [] });
    const listed = await decode({ op: 'list', project: 'compat', with_land_order: true }, transport);
    assert.deepEqual('land_order' in listed && Array.isArray(listed.land_order) ? listed.land_order.map(order => order.issue_id) : undefined, [later, earlier]);
    const misaligned = await wire({ op: 'list', project: 'compat', with_land_order: true });
    await assert.rejects(decode({ op: 'list', project: 'compat', with_land_order: true }, answer({ ...misaligned.body, land_order: (misaligned.body.land_order as unknown[]).slice(1) })), { code: 'cloud_invalid_response' });
  } finally { sqlite.close(); }
});

test('an older Worker that rejects with_land_order answers show and list through one plain request', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    const id = ((await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body: 'Old Worker read' })).body.issue as { id: string }).id;
    for (const plain of [{ op: 'show', id }, { op: 'list', project: 'compat' }]) {
      const sent: unknown[] = [];
      const older: typeof fetch = async (_url, options) => {
        const operation = JSON.parse(String(options?.body)); sent.push(operation);
        return 'with_land_order' in operation ? Response.json({ error: { code: 'invalid_input', message: 'Unexpected field: with_land_order' } }, { status: 400 }) : transport(_url, options);
      };
      const answered = await decode({ ...plain, with_land_order: true }, older);
      assert.equal('land_order' in answered, false);
      assert.deepEqual(answered, await decode(plain, transport));
      assert.deepEqual(sent, [{ ...JSON.parse(JSON.stringify(parseOperation(plain))), with_land_order: true }, JSON.parse(JSON.stringify(parseOperation(plain)))]);
    }
  } finally { sqlite.close(); }
});

test('claim_handoff decodes land_order_warnings from a newer Worker and decodes an older Worker body without them', async () => {
  const { sqlite, transport, wire } = await worker();
  try {
    const create = async (body: string) => ((await wire({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'compat', body })).body.issue as { id: string }).id;
    const later = await create('Later'); const earlier = await create('Earlier');
    await wire({ op: 'land_order_add', later_id: later, earlier_id: earlier, expected_revision: 1, request_id: crypto.randomUUID() });
    const inspection = await wire({ op: 'claim_show', issue_id: later });
    const acquired = (await wire({ op: 'claim_acquire', issue_id: later, incarnation: (inspection.body.claim as { store_incarnation: string }).store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() })).body.claim_receipt as { incarnation: string; session_id: string; generation: number; revision: number };
    const handoff = { op: 'claim_handoff', claim_proof: { issue_id: later, incarnation: acquired.incarnation, session_id: acquired.session_id, generation: acquired.generation }, expected_revision: acquired.revision, request_id: crypto.randomUUID(), tip: 'abcdef0' };
    const body = (await wire(handoff)).body;
    assertShape(body, { claim_receipt: { ...claimShape, outcome: 'string', released_at: 'number' }, handoff: { issue: issueShape, comments: [commentShape] }, land_order_warnings: [{ id: 'string', status: 'string' }] });
    const decoded = await decode(handoff, answer(body));
    assert.deepEqual('land_order_warnings' in decoded ? decoded.land_order_warnings : undefined, [{ id: earlier, status: 'open' }]);
    const { land_order_warnings: _, ...older } = body;
    assert.equal('land_order_warnings' in await decode(handoff, answer(older)), false);
    await assert.rejects(decode(handoff, answer({ ...body, land_order_warnings: [{ id: earlier, status: 'closed' }] })), { code: 'cloud_invalid_response' });
    const replayed = await decode(handoff, transport);
    assert.deepEqual('land_order_warnings' in replayed ? replayed.land_order_warnings : undefined, [{ id: earlier, status: 'open' }]);
  } finally { sqlite.close(); }
});
