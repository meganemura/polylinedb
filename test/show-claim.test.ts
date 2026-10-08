/** Exercises the claim inspection in show on local SQLite, the CLI, Worker HTTP and MCP, and the cloud client. D1 runs the same flow in d1.integration.ts. */
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { storageOf } from 'solarsql/node';
import { createAccessVerifier } from '../src/service/access.ts';
import { handleRequest } from '../src/service/index.ts';
import { SCHEMA_SQL } from '../src/records/schema.ts';
import { initializeStore, openStore } from '../src/local-store/index.ts';
import { executeCloudOperation } from '../src/cloud-client/cloud-operations.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import type { OperationResult } from '../src/records/index.ts';
import { runShowClaimFlow } from './fixtures/show-claim-flow.ts';

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
  const post = (path: string, body: unknown) => handleRequest(new Request(`https://issues.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token },
    body: JSON.stringify(body),
  }), env, authenticate);
  return { sqlite, post };
}
const rejection = (error: { code: string }) => Object.assign(new Error(error.code), { code: error.code });

test('local show returns the claim inspection that claim_acquire needs', async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'pd-show-claim-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  initializeStore(location); const store = openStore(location);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  await runShowClaimFlow(value => executeOperation(store.db, parseOperation(value), 'test:owner'));
});

test('Worker HTTP show returns the claim inspection that claim_acquire needs', async () => {
  const { sqlite, post } = await worker();
  try {
    await runShowClaimFlow(async value => {
      const response = await post('/v1/operations', value); const body = await response.json();
      if (!response.ok) throw rejection(body.error);
      return body as OperationResult;
    });
  } finally { sqlite.close(); }
});

test('MCP show returns the claim inspection that claim_acquire needs', async () => {
  const { sqlite, post } = await worker();
  try {
    await runShowClaimFlow(async ({ op, ...args }) => {
      const result = (await (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: args } })).json()).result;
      if (result.isError) throw rejection(result.structuredContent.error);
      return result.structuredContent as OperationResult;
    });
  } finally { sqlite.close(); }
});

test('cloud client accepts the claim in show and rejects a foreign or inconsistent claim', async () => {
  const { sqlite, post } = await worker();
  const transport: typeof fetch = (_, options) => post('/v1/operations', JSON.parse(String(options?.body)));
  const cloud = (value: unknown, fetch = transport) => executeCloudOperation({ origin: 'https://issues.example', operation: parseOperation(value), authorize: async () => 'synthetic-secret', fetch });
  try {
    await runShowClaimFlow(value => cloud(value));
    const shown = await (await post('/v1/operations', { op: 'show', id: 'pd-1' })).json();
    for (const damaged of [{ ...shown, claim: { ...shown.claim, issue_id: 'pd-2' } }, { ...shown, claim: { ...shown.claim, state: 'released' } }]) {
      await assert.rejects(cloud({ op: 'show', id: 'pd-1' }, async () => Response.json(damaged)), { code: 'cloud_invalid_response' });
    }
  } finally { sqlite.close(); }
});

test('CLI show supplies the incarnation for claim acquire and prints the claim line', (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'pd-show-claim-cli-'));
  const cwd = join(root, 'work'); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config-home') };
  for (const name of ['POLYLINEDB_ACTOR', 'POLYLINEDB_ACTOR_KIND', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_CONNECTION', 'POLYLINEDB_SESSION_ID']) delete env[name];
  const pd = (args: string[]) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--data-dir', join(root, 'store'), '--actor', 'local:test', ...args], { cwd, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  pd(['init']); pd(['create', '--tool', 'test', '--project', 'test', '--body', 'Claim']);
  const shown = JSON.parse(pd(['show', '1']));
  assert.equal(shown.claim.state, 'never_claimed');
  const receipt = JSON.parse(pd(['claim', 'acquire', '1', '--incarnation', shown.claim.store_incarnation, '--session-id', crypto.randomUUID()])).claim_receipt;
  assert.equal(receipt.incarnation, shown.claim.store_incarnation);
  const after = JSON.parse(pd(['show', '1'])).claim;
  assert.equal(after.state, 'active'); assert.equal(after.lease.session_id, receipt.session_id);
  assert.ok(pd(['show', '1', '--human']).split('\n').includes(`Claim active · store incarnation ${shown.claim.store_incarnation}`));
});
