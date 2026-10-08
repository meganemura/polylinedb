/** Decodes real Worker responses in older shapes through the cloud client. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { storageOf } from 'solarsql/node';
import { createAccessVerifier } from '../src/service/access.ts';
import { handleRequest } from '../src/service/index.ts';
import { SCHEMA_SQL } from '../src/records/schema.ts';
import { executeCloudOperation } from '../src/cloud-client/cloud-operations.ts';
import { parseOperation } from '../src/records/index.ts';

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
