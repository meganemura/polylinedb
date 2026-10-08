// Checks issue closure records on local SQLite, MCP, and the released /v1/operations shape, and in snapshots and historical recovery. D1 runs the same flow in d1.integration.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { node } from 'solarsql/node';
import { storageOf } from 'solarsql/node';
import { exportHistoricalSnapshot, initializeStore, openStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import type { OperationResult } from '../src/records/index.ts';
import { createAccessVerifier } from '../src/service/access.ts';
import { handleRequest } from '../src/service/index.ts';
import { executeCloudOperation } from '../src/cloud-client/cloud-operations.ts';
import { SCHEMA_SQL } from '../src/records/schema.ts';
import { runClosureFlow } from './fixtures/closure-flow.ts';
import { canonicalSnapshot, canonicalSnapshotV5, convertSnapshotV5, parseSnapshot, SCHEMA_V6_SQL } from '../src/records/persistence.ts';
import type { Snapshot, SqlExecutor } from '../src/records/persistence.ts';

const source = new URL('../src/cli.ts', import.meta.url).pathname;
const base = { tool: 'tool', project: 'project', body: 'body', type: 'task', priority: 2, labels: [],
  versions: { tool: 1, project: 1, body: 1, status: 2, type: 1, priority: 1, labels: 1 },
  created_at: '2026-01-02T03:04:05.000Z', created_by: 'author', updated_at: '2026-01-03T03:04:05.000Z', updated_by: 'editor' };
function snapshot(issues: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { format: 'polylinedb.snapshot', version: 6, issues, comments: [], counters: [{ scope: 'pd', last_number: 3 }], requests: [],
    memories: [], memory_counters: [], memory_requests: [], dependencies: [],
    dependency_revisions: issues.map(issue => ({ dependent_id: issue.id, revision: 1 })), dependency_requests: [], issue_claims: [], claim_requests: [] };
}
const closed = { ...base, id: 'pd-1', status: 'closed', closed_at: '2026-01-03T03:04:05.000Z', closed_by: 'closer' };
const legacyClosed = { ...base, id: 'pd-2', status: 'closed', closed_at: null, closed_by: null };
const open = { ...base, id: 'pd-3', status: 'open', closed_at: null, closed_by: null };
const withoutClosure = ({ closed_at: _at, closed_by: _by, ...issue }: Record<string, unknown>) => issue;
function root(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pd-closure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('snapshot 6 keeps a recorded closure and an empty closure on closed issues', () => {
  const parsed = parseSnapshot(snapshot([closed, legacyClosed, open]));
  assert.deepEqual(parsed.issues.map(issue => [issue.id, issue.closed_at, issue.closed_by]), [
    ['pd-1', '2026-01-03T03:04:05.000Z', 'closer'], ['pd-2', null, null], ['pd-3', null, null]]);
  assert.equal(canonicalSnapshot(parsed), JSON.stringify(parseSnapshot(JSON.parse(canonicalSnapshot(parsed)))));
});

test('snapshot 6 rejects a closure on an unclosed issue, a half closure, missing fields, and an invalid close time', () => {
  for (const issue of [
    { ...open, closed_at: '2026-01-03T03:04:05.000Z', closed_by: 'closer' },
    { ...closed, closed_by: null },
    { ...closed, closed_at: null },
    { ...closed, closed_at: 'yesterday' },
    { ...closed, closed_by: '' },
    withoutClosure(closed),
  ]) assert.throws(() => parseSnapshot(snapshot([issue])), { code: 'invalid_snapshot' }, JSON.stringify(issue));
});

test('snapshot 5 converts with empty closures and keeps its own canonical digest', () => {
  const legacy = { ...snapshot([withoutClosure(legacyClosed)]), version: 5 };
  assert.throws(() => parseSnapshot(legacy), { code: 'invalid_snapshot' });
  const converted: Snapshot = convertSnapshotV5(legacy);
  assert.equal(converted.version, 6);
  assert.deepEqual(converted.issues.map(issue => [issue.id, issue.status, issue.closed_at, issue.closed_by]), [['pd-2', 'closed', null, null]]);
  const canonical = JSON.parse(canonicalSnapshotV5(legacy));
  assert.equal(canonical.version, 5);
  assert.deepEqual(Object.keys(canonical.issues[0]).filter(key => key.startsWith('closed')), []);
});

test('the CLI converts snapshot 5 to snapshot 6 without touching a store', t => {
  const directory = root(t); const cwd = join(directory, 'work'); mkdirSync(cwd);
  const file = join(directory, 'v5.json');
  writeFileSync(file, JSON.stringify({ ...snapshot([withoutClosure(legacyClosed)]), version: 5 }));
  const converted = spawnSync(process.execPath, [source, 'snapshot', 'convert', '--from', '5', '--file', file], { cwd, encoding: 'utf8',
    env: { ...process.env, POLYLINEDB_DATA_DIR: undefined, POLYLINEDB_CONNECTION: undefined, XDG_CONFIG_HOME: join(directory, 'config') } });
  assert.equal(converted.status, 0, converted.stderr);
  const output = JSON.parse(converted.stdout);
  assert.equal(output.version, 6);
  assert.deepEqual(output.issues.map((issue: Record<string, unknown>) => [issue.closed_at, issue.closed_by]), [[null, null]]);
});

test('historical export of a schema 6 store keeps its claims and leaves closures empty', async t => {
  const parent = root(t); const directory = join(parent, 'store'); mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(parent, 'work'));
  const path = join(directory, 'polylinedb.sqlite');
  const database = new DatabaseSync(path); database.exec(SCHEMA_V6_SQL);
  const db: SqlExecutor = { reads: node(database), batch: async statements => {
    database.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(({ sql, params }) => ({ rows: database.prepare(sql).all(...params) })); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  const run = (input: unknown) => executeOperation(db, parseOperation(input), 'old:author');
  await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'tool', project: 'project', body: 'Claimed' });
  const inspection = await run({ op: 'claim_show', issue_id: 'pd-1' }); assert.ok('claim' in inspection);
  await run({ op: 'claim_acquire', issue_id: 'pd-1', incarnation: inspection.claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() });
  database.exec("UPDATE issues SET status = 'closed', status_v = 2 WHERE id = 'pd-1'");
  database.close(); chmodSync(path, 0o600);
  const recovered = exportHistoricalSnapshot({ directory, cwd: join(parent, 'work') });
  assert.equal(recovered.version, 6);
  assert.equal(recovered.issue_claims.length, 1);
  assert.equal(recovered.claim_requests.length, 1);
  assert.deepEqual(recovered.issues.map(issue => [issue.status, issue.closed_at, issue.closed_by]), [['closed', null, null]]);
});

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
const authenticate = createAccessVerifier(async () => Response.json({ keys: [{ ...publicKey, kid: 'test', alg: 'RS256', use: 'sig' }] }));
async function worker(t: test.TestContext) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const encoded = `${encode({ alg: 'RS256', kid: 'test' })}.${encode({ iss: 'https://polylinedb-test.cloudflareaccess.com', aud: ['polylinedb-test'], sub: 'owner', exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const token = `${encoded}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(encoded))).toString('base64url')}`;
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(SCHEMA_SQL); t.after(() => sqlite.close());
  const storage = storageOf(sqlite);
  const prepare = (sql: string) => {
    const make = (params: (string | number | null)[]) => ({ sql, params, bind: (...values: (string | number | null)[]) => make(values),
      all: async () => ({ success: true, results: storage.sql.exec(sql, ...params).toArray() }) });
    return make([]);
  };
  const DB = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(({ sql, params }) => ({ success: true, results: storage.sql.exec(sql, ...params).toArray() })); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const env = { DB, ACCESS_TEAM_DOMAIN: 'polylinedb-test.cloudflareaccess.com', ACCESS_AUD: 'polylinedb-test', ACCESS_ACTORS: '["access:owner"]', ALLOWED_ORIGINS: '["https://client.example"]' };
  const post = async (path: string, body: unknown) => handleRequest(new Request(`https://issues.example${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token } }), env, authenticate);
  const mcp = async ({ op, ...args }: Record<string, unknown>): Promise<OperationResult> => {
    const result = (await (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: args } })).json()).result;
    if (result.isError) throw Object.assign(new Error(result.structuredContent.error.code), { code: result.structuredContent.error.code });
    return result.structuredContent;
  };
  return { post, mcp };
}
// Every object with field versions is an issue; the released CLI rejects any issue key beyond these.
const releasedIssueKeys = ['body', 'created_at', 'created_by', 'id', 'labels', 'priority', 'project', 'status', 'tool', 'type', 'updated_at', 'updated_by', 'versions'];
function releasedIssues(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count: number, entry) => count + releasedIssues(entry), 0);
  if (value === null || typeof value !== 'object') return 0;
  const own = Object.hasOwn(value, 'versions') ? (assert.deepEqual(Object.keys(value).sort(), releasedIssueKeys), 1) : 0;
  return own + Object.values(value).reduce((count: number, entry) => count + releasedIssues(entry), 0);
}

test('local SQLite records closure on close, keeps it through edits, and clears it on reopen', async t => {
  const directory = root(t); mkdirSync(join(directory, 'work'));
  const location = { directory: join(directory, 'store'), cwd: join(directory, 'work') };
  initializeStore(location); const store = openStore(location); t.after(() => store.close());
  await runClosureFlow(value => executeOperation(store.db, parseOperation(value), 'local:closer'), 'local:closer');
});

test('MCP reports the same closure semantics as the store', async t => {
  const { mcp } = await worker(t);
  await runClosureFlow(mcp, 'access:owner');
});

test('/v1/operations keeps the released issue shape, which the cloud decoder still reads, while MCP reports the closure', async t => {
  const { post, mcp } = await worker(t);
  const v1 = async (body: Record<string, unknown>) => { const response = await post('/v1/operations', body); return { status: response.status, body: await response.json() }; };
  const created = await v1({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'released', body: 'Released shape' });
  const id = created.body.issue.id;
  const bodies = [created, await v1({ op: 'close', id, expected: 1 }), await v1({ op: 'show', id }), await v1({ op: 'list', status: 'closed' }),
    await v1({ op: 'search', query: 'Released' }), await v1({ op: 'close', id, expected: 1 }),
    await v1({ op: 'dependency_worklist', state: 'blocked' })];
  assert.deepEqual(bodies.map(response => response.status), [200, 200, 200, 200, 200, 409, 200]);
  assert.equal(bodies[5]?.body.error.code, 'conflict');
  assert.equal(bodies.reduce((count, response) => count + releasedIssues(response.body), 0), 6, 'the conflict details carry the sixth issue');
  const shown = await mcp({ op: 'show', id }); assert.ok('issue' in shown);
  assert.equal(shown.issue.closed_by, 'access:owner');
  assert.equal(shown.issue.closed_at, bodies[1]?.body.issue.updated_at);

  const transport: typeof fetch = async (_, options) => post('/v1/operations', JSON.parse(String(options?.body)));
  const cloud = (value: unknown) => executeCloudOperation({ origin: 'https://issues.example', operation: parseOperation(value), authorize: async () => 'synthetic', fetch: transport });
  const decoded = await cloud({ op: 'show', id }); assert.ok('issue' in decoded);
  assert.equal(decoded.issue.status, 'closed');
  assert.equal(Object.hasOwn(decoded.issue, 'closed_at'), false, 'the cloud transport does not report closure');
  const reopened = await cloud({ op: 'reopen', id, expected: 2 }); assert.ok('issue' in reopened);
  await assert.rejects(cloud({ op: 'reopen', id, expected: 2 }), { code: 'conflict' });
});
