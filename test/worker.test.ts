/** Exercises HTTP/MCP with real SQLite and signed assertions. Production Access policy remains a live test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { storageOf } from 'solarsql/node';
import { createAccessVerifier } from "../src/service/access.ts";
import { createDispatcher, dispatchSecretNames } from "../src/service/dispatch.ts";
import * as dispatchModule from "../src/service/dispatch.ts";
import { handleRequest } from "../src/service/index.ts";
import { dispatchResponse, dispatchScript } from "../src/service/ui.ts";
import { SCHEMA_SQL } from "../src/records/schema.ts";
import { statements } from "../src/records/solarsql.generated.ts";
import { issueSortKey } from "../src/records/issue-id.ts";
import { assertSnapshot } from "./fixtures/snapshot.ts";
import manifest from '../package.json' with { type: 'json' };

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
const issuer = 'https://polylinedb-test.cloudflareaccess.com';
const authenticate = createAccessVerifier(async () => Response.json({ keys: [{ ...publicKey, kid: 'test', alg: 'RS256', use: 'sig' }] }));

async function assertion(claims: Record<string, unknown> = {}): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const encoded = `${encode({ alg: 'RS256', kid: 'test' })}.${encode({ iss: issuer, aud: ['polylinedb-test'],
    sub: 'owner', exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(encoded));
  return `${encoded}.${Buffer.from(signature).toString('base64url')}`;
}

function fixture(actors = '["access:owner"]') {
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
    ACCESS_ACTORS: actors, ALLOWED_ORIGINS: '["https://client.example"]' };
  return { sqlite, env };
}

test('server info reads the connected schema for reader and agent without writes', async () => {
  for (const [actors, claims] of [
    [JSON.stringify([{ actor: 'access:owner', role: 'reader' }]), {}],
    [JSON.stringify([{ actor: 'service:robot', role: 'agent' }]), { common_name: 'robot', sub: undefined }],
  ] as const) {
    const { sqlite, env } = fixture(actors);
    sqlite.exec('UPDATE schema_version SET version = 123');
    const token = await assertion(claims);
    const get = (credential?: string, method = 'GET') => handleRequest(new Request('https://issues.example/v1/version', {
      method, headers: credential === undefined ? {} : { 'cf-access-jwt-assertion': credential },
    }), env, authenticate);
    const rpc = async (args: unknown) => (await (await handleRequest(new Request('https://issues.example/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'server_info', arguments: args } }),
    }), env, authenticate)).json()).result;
    try {
      const before = sqlite.prepare('SELECT total_changes() AS changes').get();
      const http = await get(token);
      assert.equal(http.status, 200);
      assert.equal(http.headers.get('cache-control'), 'no-store');
      const expected = { package_version: manifest.version, git_commit: null, schema_version: 123 };
      assert.deepEqual(await http.json(), expected);
      const mcp = await rpc({});
      assert.equal(mcp.isError, false);
      assert.deepEqual(mcp.structuredContent, expected);
      assert.deepEqual(JSON.parse(mcp.content[0].text), expected);
      assert.equal((await rpc({ project: 'unneeded' })).isError, true);
      assert.equal((await rpc({ op: 'create' })).isError, true);
      assert.equal((await get()).status, 401);
      assert.equal((await get('invalid')).status, 401);
      assert.equal((await get(token, 'POST')).status, 405);
      const deniedOrigin = await handleRequest(new Request('https://issues.example/v1/version', {
        headers: { 'cf-access-jwt-assertion': token, origin: 'https://denied.example' },
      }), env, authenticate);
      assert.equal(deniedOrigin.status, 403);
      assert.deepEqual(sqlite.prepare('SELECT total_changes() AS changes').get(), before);
      sqlite.exec('DELETE FROM schema_version');
      const invalidSchema = await get(token);
      assert.equal(invalidSchema.status, 500);
      assert.deepEqual(await invalidSchema.json(), { error: { code: 'internal_error', message: 'The operation could not complete.' } });
    } finally { sqlite.close(); }
  }
});

test('HTTP and MCP share mutations, conflicts, comments, and authenticated actor', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const request = (path: string, body: unknown, extra: Record<string, string> = {}) => handleRequest(new Request(`https://issues.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'cf-access-jwt-assertion': token, ...extra }, body: JSON.stringify(body),
  }), env, authenticate);
  try {
    const create = await request('/v1/operations', { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'empty input' });
    assert.equal(create.status, 200);
    const { issue } = await create.json();
    assert.equal(issue.created_by, 'access:owner');
    const init = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } });
    assert.equal((await init.json()).result.protocolVersion, '2025-11-25');
    const listed = await request('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (await listed.json()).result.tools;
    const names = tools.map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(names, ['actor', 'changes', 'claim_acquire', 'claim_handoff', 'claim_list', 'claim_release', 'claim_renew', 'claim_show', 'close', 'comment', 'create', 'dependency_add', 'dependency_list', 'dependency_owner_waits', 'dependency_remove', 'dependency_worklist', 'land_order_add', 'land_order_list', 'land_order_remove', 'list', 'memory_context', 'memory_create', 'memory_delete', 'memory_list', 'memory_search', 'memory_show', 'memory_update', 'reopen', 'resource_add', 'resource_list', 'resource_live', 'resource_update', 'search', 'server_info', 'show', 'update', 'wait']);
    const annotationRows = tools.map((tool: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }) =>
      [tool.name, tool.annotations.readOnlyHint, tool.annotations.destructiveHint, tool.annotations.idempotentHint, tool.annotations.openWorldHint]);
    annotationRows.sort((left: (string | boolean)[], right: (string | boolean)[]) => String(left[0]).localeCompare(String(right[0])));
    assert.deepEqual(annotationRows, [
      ['actor', true, false, true, false],
      ['changes', true, false, true, false],
      ['claim_acquire', false, false, true, false],
      ['claim_handoff', false, true, true, false],
      ['claim_list', true, false, true, false],
      ['claim_release', false, true, true, false],
      ['claim_renew', false, false, true, false],
      ['claim_show', true, false, true, false],
      ['close', false, true, true, false],
      ['comment', false, false, false, false],
      ['create', false, false, true, false],
      ['dependency_add', false, false, true, false],
      ['dependency_list', true, false, true, false],
      ['dependency_owner_waits', true, false, true, false],
      ['dependency_remove', false, true, true, false],
      ['dependency_worklist', true, false, true, false],
      ['land_order_add', false, false, true, false],
      ['land_order_list', true, false, true, false],
      ['land_order_remove', false, true, true, false],
      ['list', true, false, true, false],
      ['memory_context', true, false, true, false],
      ['memory_create', false, false, true, false],
      ['memory_delete', false, true, true, false],
      ['memory_list', true, false, true, false],
      ['memory_search', true, false, true, false],
      ['memory_show', true, false, true, false],
      ['memory_update', false, true, true, false],
      ['reopen', false, true, true, false],
      ['resource_add', false, false, true, false],
      ['resource_list', true, false, true, false],
      ['resource_live', true, false, true, false],
      ['resource_update', false, false, true, false],
      ['search', true, false, true, false],
      ['server_info', true, false, true, false],
      ['show', true, false, true, false],
      ['update', false, true, true, false],
      ['wait', true, false, true, false],
    ]);
    const claimed = (await (await request('/v1/operations', { op: 'show', id: issue.id })).json()).claim;
    const session_id = crypto.randomUUID();
    const receipt = (await (await request('/v1/operations', { op: 'claim_acquire', issue_id: issue.id, incarnation: claimed.store_incarnation, session_id, request_id: crypto.randomUUID() })).json()).claim_receipt;
    const claim_proof = { issue_id: issue.id, incarnation: receipt.incarnation, session_id, generation: receipt.generation };
    const unproven = await request('/mcp', { jsonrpc: '2.0', id: 31, method: 'tools/call', params: {
      name: 'update', arguments: { id: issue.id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }] },
    } });
    assert.equal((await unproven.json()).result.structuredContent.error.code, 'claim_required');
    const updated = await request('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'update', arguments: { id: issue.id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }], claim_proof },
    } });
    assert.equal((await updated.json()).result.structuredContent.issue.status, 'in_progress');
    const conflict = await request('/v1/operations', { op: 'close', id: issue.id, expected: 1 });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'conflict');
    const toolConflict = await request('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'close', arguments: { id: issue.id, expected: 1 },
    } });
    assert.equal((await toolConflict.json()).result.isError, true);
    const blocker = await request('/v1/operations', { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'another', body: 'blocker' });
    const blockerId = (await blocker.json()).issue.id;
    const graphInput = { dependent_id: issue.id, blocker_id: blockerId, expected_revision: 1, request_id: crypto.randomUUID() };
    const added = await request('/mcp', { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'dependency_add', arguments: graphInput } });
    assert.equal((await added.json()).result.structuredContent.dependency.outcome, 'added');
    const graph = await request('/v1/operations', { op: 'dependency_list', dependent_id: issue.id });
    assert.deepEqual((await graph.json()).blockers, [{ id: blockerId, project: 'another', status: 'open' }]);
    const blockedClose = await request('/v1/operations', { op: 'close', id: issue.id, expected: 2, claim_proof });
    assert.equal((await blockedClose.json()).error.code, 'dependency_blocked');
    const removed = await request('/v1/operations', { op: 'dependency_remove', ...graphInput, expected_revision: 2, request_id: crypto.randomUUID() });
    assert.equal((await removed.json()).dependency.outcome, 'removed');
    await request('/v1/operations', { op: 'comment', id: issue.id, body: 'confirmed' });
    const show = await request('/v1/operations', { op: 'show', id: issue.id });
    const shown = await show.json();
    assert.equal(shown.comments[0].body, 'confirmed');
    const httpSearch = await (await request('/v1/operations', { op: 'search', query: 'confirmed' })).json();
    assert.deepEqual(Object.keys(httpSearch), ['issues', 'next_cursor']);
    const mcpSearch = await request('/mcp', { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'search', arguments: { query: 'confirmed' } } });
    const searched = (await mcpSearch.json()).result.structuredContent;
    assert.deepEqual(searched.issues.map((hit: { id: string }) => hit.id), [issue.id]);
    assert.deepEqual(searched.matches, [{ issue_id: issue.id, location: 'comment', comment_id: shown.comments[0].id, excerpt: 'confirmed' }]);
    const memoryCreate = await request('/v1/operations', { op: 'memory_create', project: 'parser', prefix: 'pd', request_id: crypto.randomUUID(), title: 'Parser constraint', body: 'Keep empty input valid.' });
    assert.equal(memoryCreate.status, 200);
    const savedMemory = (await memoryCreate.json()).memory;
    assert.equal(savedMemory.id, 'pd-m1'); assert.equal(savedMemory.created_by, 'access:owner');
    const recall = await request('/mcp', { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'memory_context', arguments: { project: 'parser' } } });
    const context = (await recall.json()).result.structuredContent;
    assert.equal(context.memories[0].body, 'Keep empty input valid.');
    assert.deepEqual(context.store, { kind: 'cloud', url: 'https://issues.example' });
    const memoryEdit = await request('/v1/operations', { op: 'memory_update', project: 'parser', id: 'pd-m1', title: 'Parser constraint', body: 'Verified.', expected: 1 });
    assert.equal((await memoryEdit.json()).memory.version, 2);
    const memoryConflict = await request('/mcp', { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'memory_delete', arguments: { project: 'parser', id: 'pd-m1', expected: 1 } } });
    const rejected = (await memoryConflict.json()).result;
    assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent.error.code, 'memory_conflict');
    assert.equal(shown.issue.versions.status, 2);
    const spoof = await request('/v1/operations', { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'x', project: 'x', body: 'x', actor: 'admin' });
    assert.equal(spoof.status, 400);
  } finally { sqlite.close(); }
});

test('HTTP rejects missing credentials, origins, malformed input and large bodies', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const headers = { 'content-type': 'application/json', 'cf-access-jwt-assertion': token };
  try {
    const missing = await handleRequest(new Request('https://issues.example/v1/operations', { method: 'POST', body: '{}' }), env, authenticate);
    assert.equal(missing.status, 401);
    const origin = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{"op":"actor"}',
    }), env, authenticate);
    assert.equal(origin.status, 403);
    const invalidOriginConfig = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { ...headers, origin: 'https://client.example' }, body: '{"op":"actor"}',
    }), { ...env, ALLOWED_ORIGINS: '{' }, authenticate);
    assert.equal(invalidOriginConfig.status, 503);
    const malformed = await handleRequest(new Request('https://issues.example/v1/operations', { method: 'POST', headers, body: '{' }), env, authenticate);
    assert.equal(malformed.status, 400);
    const large = await handleRequest(new Request('https://issues.example/v1/operations', { method: 'POST', headers, body: ' '.repeat(128 * 1024 + 1) }), env, authenticate);
    assert.equal(large.status, 413);
    const valid = await handleRequest(new Request('https://issues.example/v1/operations', { method: 'POST', headers, body: '{"op":"actor"}' }), env, authenticate);
    assert.deepEqual(await valid.json(), { actor: 'access:owner' });
  } finally { sqlite.close(); }
});

test('MCP handles transport and JSON-RPC failures without executing tools', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const call = (body: unknown, headers: Record<string, string> = {}) => handleRequest(new Request('https://issues.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'cf-access-jwt-assertion': token, ...headers }, body: JSON.stringify(body),
  }), env, authenticate);
  try {
    assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { accept: 'application/json' })).status, 406);
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': 'bad' })).status, 400);
    assert.equal((await call({ jsonrpc: '2.0', id: null, method: 'ping' })).status, 400);
    assert.equal((await (await call({ jsonrpc: '2.0', id: 1, method: 'absent' })).json()).error.code, -32601);
    assert.deepEqual((await (await call({ jsonrpc: '2.0', id: 2, method: 'ping' })).json()).result, {});
    const get = await handleRequest(new Request('https://issues.example/mcp', { headers: { 'cf-access-jwt-assertion': token } }), env, authenticate);
    assert.equal(get.status, 405);
  } finally { sqlite.close(); }
});

test('HTTP and MCP read the change feed for readers and report cursor errors with the current position', async () => {
  const { sqlite, env } = fixture(JSON.stringify(['access:owner', { actor: 'access:viewer', role: 'reader' }]));
  const tokens = { owner: await assertion(), viewer: await assertion({ sub: 'viewer' }) };
  const operate = async (body: Record<string, unknown>, who: keyof typeof tokens = 'owner') => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': tokens[who] }, body: JSON.stringify(body),
    }), env, authenticate);
    return { status: response.status, text: await response.text() };
  };
  const tool = async (args: Record<string, unknown>, who: keyof typeof tokens = 'viewer') => (await (await handleRequest(new Request('https://issues.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': tokens[who] },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'changes', arguments: args } }),
  }), env, authenticate)).json()).result;
  try {
    for (const body of ['blocker', 'dependent']) assert.equal((await operate({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'feed', project: 'feed', body })).status, 200);
    await operate({ op: 'comment', id: 'pd-2', body: 'waiting' });
    const first = await operate({ op: 'changes', since: 0, limit: 2 }, 'viewer');
    assert.equal(first.status, 200);
    const page = JSON.parse(first.text);
    const incarnation = page.incarnation;
    assert.match(incarnation, /^[a-f0-9]{32}$/);
    const occurred = page.changes.map((change: { occurred_at: number }) => change.occurred_at);
    assert.equal(first.text, JSON.stringify({ incarnation, changes: [
      { seq: 1, incarnation, issue_id: 'pd-1', kind: 'created', fields: [], occurred_at: occurred[0], actor: 'access:owner' },
      { seq: 2, incarnation, issue_id: 'pd-2', kind: 'created', fields: [], occurred_at: occurred[1], actor: 'access:owner' },
    ], next_since: 2 }));
    const second = await tool({ since: 2, incarnation });
    assert.equal(second.isError, false);
    assert.deepEqual(second.structuredContent.changes.map((change: { seq: number; kind: string }) => [change.seq, change.kind]), [[3, 'commented']]);
    assert.equal(second.structuredContent.next_since, 3);
    assert.deepEqual((await tool({ since: 0, kinds: ['commented'], issue_ids: ['pd-2'], project: 'feed' })).structuredContent.changes.map((change: { seq: number }) => change.seq), [3]);

    const other = 'f'.repeat(32);
    const mismatch = await operate({ op: 'changes', since: 2, incarnation: other });
    assert.equal(mismatch.status, 409);
    assert.deepEqual(JSON.parse(mismatch.text).error, { code: 'incarnation_mismatch', message: 'The store incarnation changed. Read the state again, then continue from next_since.', details: { incarnation, next_since: 3 } });
    const toolMismatch = await tool({ since: 2, incarnation: other });
    assert.equal(toolMismatch.isError, true);
    assert.deepEqual(toolMismatch.structuredContent.error.details, { incarnation, next_since: 3 });
    const ahead = await operate({ op: 'changes', since: 4, incarnation });
    assert.equal(ahead.status, 400);
    assert.deepEqual(JSON.parse(ahead.text).error, { code: 'invalid_input', message: 'since must not exceed the newest change seq' });
    assert.equal((await operate({ op: 'changes', since: 1 })).status, 400);

    sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
      INSERT INTO change_events(issue_id, kind, fields_json, occurred_at, actor) SELECT 'pd-1', 'commented', '[]', unixepoch(), 'retention' FROM n`);
    const expired = await operate({ op: 'changes', since: 2, incarnation }, 'viewer');
    assert.equal(expired.status, 409);
    assert.deepEqual(JSON.parse(expired.text).error, { code: 'cursor_expired', message: 'Retention removed changes after since. Read the state again, then continue from next_since.', details: { incarnation, next_since: 10003 } });
    assert.equal((await operate({ op: 'changes', since: 3, incarnation, limit: 1 })).status, 200);
  } finally { sqlite.close(); }
});

test('the roster keeps readers read-only and gates each service-token agent as its own actor', async () => {
  const { sqlite, env } = fixture(JSON.stringify([
    'access:owner',
    { actor: 'access:viewer', role: 'reader' },
    { actor: 'service:codex-token', role: 'agent' },
    { actor: 'service:claude-token', role: 'agent' },
  ]));
  const tokens = {
    owner: await assertion(),
    viewer: await assertion({ sub: 'viewer' }),
    codex: await assertion({ sub: '', common_name: 'codex-token' }),
    claude: await assertion({ sub: '', common_name: 'claude-token' }),
  };
  const operate = async (who: keyof typeof tokens, body: Record<string, unknown>) => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': tokens[who] }, body: JSON.stringify(body),
    }), env, authenticate);
    return { status: response.status, body: await response.json() };
  };
  const tool = async (who: keyof typeof tokens, name: string, args: Record<string, unknown>) => {
    const response = await handleRequest(new Request('https://issues.example/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': tokens[who] },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), env, authenticate);
    return (await response.json()).result;
  };
  const acquire = async (who: keyof typeof tokens, issueId: string) => {
    const { claim } = (await operate(who, { op: 'claim_show', issue_id: issueId })).body;
    return operate(who, { op: 'claim_acquire', issue_id: issueId, incarnation: claim.store_incarnation,
      session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'shared-label' });
  };
  try {
    const ready = (await operate('owner', { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'ready work', labels: ['ready'] })).body.issue;
    const draft = (await operate('owner', { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'draft' })).body.issue;

    assert.equal((await operate('viewer', { op: 'show', id: ready.id })).status, 200);
    assert.deepEqual(await operate('viewer', { op: 'comment', id: ready.id, body: 'edit' }),
      { status: 403, body: { error: { code: 'read_only_actor', message: 'This actor can only read', details: { op: 'comment' } } } });
    assert.equal((await operate('viewer', { op: 'claim_show', issue_id: ready.id })).status, 200);
    assert.equal((await acquire('viewer', ready.id)).body.error.code, 'read_only_actor');
    const readerUpdate = await tool('viewer', 'update', { id: ready.id, changes: [{ field: 'priority', value: 0, expected: 1 }] });
    assert.equal(readerUpdate.isError, true);
    assert.equal(readerUpdate.structuredContent.error.code, 'read_only_actor');

    assert.equal((await acquire('codex', draft.id)).body.error.code, 'not_ready');
    assert.equal((await operate('codex', { op: 'comment', id: ready.id, body: 'early' })).body.error.code, 'claim_required');
    const held = await acquire('codex', ready.id);
    assert.equal(held.body.claim_receipt.actor, 'service:codex-token');
    assert.equal((await operate('codex', { op: 'comment', id: ready.id, body: 'started' })).status, 200);

    assert.equal((await operate('claude', { op: 'comment', id: ready.id, body: 'mine' })).body.error.code, 'claim_required');
    const proof = { issue_id: ready.id, incarnation: held.body.claim_receipt.incarnation, session_id: held.body.claim_receipt.session_id, generation: held.body.claim_receipt.generation };
    const foreignRelease = await operate('claude', { op: 'claim_release', claim_proof: proof, expected_revision: 1, request_id: crypto.randomUUID() });
    assert.equal(foreignRelease.status, 409);
    const lease = (await tool('viewer', 'claim_show', { issue_id: ready.id })).structuredContent.claim.lease;
    assert.equal(lease.actor, 'service:codex-token');
    assert.equal(lease.released_at, null);
    const comments = (await operate('viewer', { op: 'show', id: ready.id })).body.comments;
    assert.deepEqual(comments.map((comment: { created_by: string }) => comment.created_by), ['service:codex-token']);
  } finally { sqlite.close(); }
});

test('each advertised MCP hint matches the store effect of a real tool call', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  let rpcId = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => (await (await handleRequest(new Request('https://issues.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  }), env, authenticate)).json()).result;
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
  const store = () => JSON.stringify(tables.map(table => [table, sqlite.prepare(`SELECT * FROM "${table}"`).all().map(row => JSON.stringify(row)).sort()]));
  const readOnly = new Set<string>(); const idempotent = new Set<string>(); const repeatable = new Set<string>();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent;
  };
  const read = async (name: string, args: Record<string, unknown>) => {
    const before = store(); const content = await call(name, args);
    assert.equal(store(), before, `${name} changed the store`);
    readOnly.add(name); return content;
  };
  const repeat = async (name: string, args: Record<string, unknown>) => {
    const content = await call(name, args); const before = store();
    await rpc('tools/call', { name, arguments: args });
    assert.equal(store(), before, `a repeated ${name} changed the store`);
    idempotent.add(name); return content;
  };
  const append = async (name: string, args: Record<string, unknown>) => {
    await call(name, args); const before = store();
    await call(name, args);
    assert.notEqual(store(), before, `a repeated ${name} left the store unchanged`);
    repeatable.add(name);
  };
  try {
    const issue = (await repeat('create', { prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'empty input' })).issue;
    const blocker = (await call('create', { prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'lexer' })).issue;
    await read('actor', {}); await read('show', { id: issue.id }); await read('list', {}); await read('search', { query: 'empty' });
    await repeat('update', { id: issue.id, changes: [{ field: 'priority', value: 1, expected: 1 }] });
    await repeat('dependency_add', { dependent_id: issue.id, blocker_id: blocker.id, expected_revision: 1, request_id: crypto.randomUUID() });
    await read('dependency_list', { dependent_id: issue.id });
    await read('dependency_owner_waits', {}); await read('dependency_worklist', { state: 'blocked' }); await read('dependency_worklist', { state: 'ready' });
    await repeat('dependency_remove', { dependent_id: issue.id, blocker_id: blocker.id, expected_revision: 2, request_id: crypto.randomUUID() });
    await repeat('land_order_add', { later_id: issue.id, earlier_id: blocker.id, expected_revision: 1, request_id: crypto.randomUUID() });
    await read('land_order_list', { issue_id: issue.id });
    await repeat('land_order_remove', { later_id: issue.id, earlier_id: blocker.id, expected_revision: 2, request_id: crypto.randomUUID() });
    await repeat('resource_add', { issue_id: blocker.id, kind: 'worker', name: 'preview-api', expected_revision: 1, request_id: crypto.randomUUID() });
    await read('resource_list', { issue_id: blocker.id }); await read('resource_live', {});
    await repeat('resource_update', { issue_id: blocker.id, seq: 1, external_id: 'preview-api-1', mark: 'created', expected_revision: 2, request_id: crypto.randomUUID() });
    await repeat('close', { id: issue.id, expected: 1 });
    await repeat('reopen', { id: issue.id, expected: 2 });
    await append('comment', { id: issue.id, body: 'confirmed' });
    const memory = (await repeat('memory_create', { project: 'parser', prefix: 'pd', request_id: crypto.randomUUID(), title: 'Parser constraint', body: 'Keep empty input valid.' })).memory;
    await read('memory_show', { project: 'parser', id: memory.id }); await read('memory_list', { project: 'parser' });
    await read('memory_search', { project: 'parser', query: 'empty' }); await read('memory_context', { project: 'parser' });
    await repeat('memory_update', { project: 'parser', id: memory.id, title: 'Parser constraint', body: 'Verified.', expected: 1 });
    await repeat('memory_delete', { project: 'parser', id: memory.id, expected: 2 });
    const observed = (await read('claim_show', { issue_id: issue.id })).claim;
    await read('claim_list', {});
    const lease = (await repeat('claim_acquire', { issue_id: issue.id, incarnation: observed.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() })).claim_receipt;
    const claim_proof = { issue_id: issue.id, incarnation: lease.incarnation, session_id: lease.session_id, generation: lease.generation };
    await repeat('claim_renew', { claim_proof, expected_revision: 1, request_id: crypto.randomUUID() });
    await repeat('claim_release', { claim_proof, expected_revision: 2, request_id: crypto.randomUUID() });
    const reclaimed = (await call('claim_acquire', { issue_id: issue.id, incarnation: observed.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() })).claim_receipt;
    await repeat('claim_handoff', { claim_proof: { issue_id: issue.id, incarnation: reclaimed.incarnation, session_id: reclaimed.session_id, generation: reclaimed.generation },
      expected_revision: reclaimed.revision, request_id: crypto.randomUUID(), tip: 'abcdef0', summary: 'Enqueued.' });
    await read('changes', { since: 0 });
    await read('server_info', {});
    await read('wait', { since: 0, timeout: 0 });

    const advertised = (await rpc('tools/list')).tools.map((tool: { name: string; annotations: { readOnlyHint: boolean; idempotentHint: boolean } }) =>
      [tool.name, tool.annotations.readOnlyHint, tool.annotations.idempotentHint]).sort();
    const measured = [...readOnly, ...idempotent, ...repeatable].map(name => [name, readOnly.has(name), !repeatable.has(name)]).sort();
    assert.deepEqual(advertised, measured);
  } finally { sqlite.close(); }
});

test('MCP update names the expired claim when the supplied proof no longer holds', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const post = (path: string, body: unknown) => handleRequest(new Request(`https://issues.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token },
    body: JSON.stringify(body),
  }), env, authenticate);
  try {
    const created = await post('/v1/operations', { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'pd', project: 'test', body: 'Issue' });
    const issue = (await created.json()).issue;
    const shown = await post('/v1/operations', { op: 'claim_show', issue_id: issue.id });
    const incarnation = (await shown.json()).claim.store_incarnation;
    const session_id = crypto.randomUUID();
    const acquired = await post('/v1/operations', { op: 'claim_acquire', issue_id: issue.id, incarnation, session_id, request_id: crypto.randomUUID(), ttl: 3600 });
    assert.equal((await acquired.json()).claim_receipt.generation, 1);
    sqlite.prepare('UPDATE issue_claims SET acquired_at = 100, changed_at = 100, expires_at = 1000 WHERE issue_id = ?').run(issue.id);
    const mcp = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update', arguments: {
      id: issue.id, claim_proof: { issue_id: issue.id, incarnation, session_id, generation: 1 },
      changes: [{ field: 'labels', value: ['ready'], expected: 1 }],
    } } });
    const result = (await mcp.json()).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'claim_required');
    assert.equal(result.structuredContent.error.message, 'A current ownership proof is required for this update');
    assert.deepEqual(result.structuredContent.error.details.claim, { state: 'expired', generation: 1, expires_at: 1000 });
    assert.deepEqual(result.structuredContent.error.details.issue.labels, []);
    assert.equal(sqlite.prepare('SELECT labels_json FROM issues WHERE id = ?').get(issue.id)?.labels_json, '[]');
  } finally { sqlite.close(); }
});

test('HTTP and MCP release an expired own lease as a no-op only on request and refuse a newer lease', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const post = async (path: string, body: unknown) => {
    const response = await handleRequest(new Request(`https://issues.example${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token },
      body: JSON.stringify(body),
    }), env, authenticate);
    return { status: response.status, body: await response.json() };
  };
  const mcp = async (name: string, args: Record<string, unknown>) => (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
  try {
    const issue = (await post('/v1/operations', { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'pd', project: 'test', body: 'Issue' })).body.issue;
    const incarnation = (await post('/v1/operations', { op: 'claim_show', issue_id: issue.id })).body.claim.store_incarnation;
    const session_id = crypto.randomUUID();
    const acquired = await post('/v1/operations', { op: 'claim_acquire', issue_id: issue.id, incarnation, session_id, request_id: crypto.randomUUID(), ttl: 3600 });
    assert.equal(acquired.status, 200);
    assert.equal(acquired.body.claim_receipt.revision, 1);
    const own = { issue_id: issue.id, incarnation, session_id, generation: 1 };
    const active = await post('/v1/operations', { op: 'claim_release', claim_proof: own, expected_revision: 1, request_id: crypto.randomUUID(), expired_noop: true });
    assert.equal(active.status, 200);
    assert.equal(active.body.claim_receipt.outcome, 'released');
    assert.equal(active.body.claim_receipt.revision, 2);
    const again = crypto.randomUUID();
    const second = await mcp('claim_acquire', { issue_id: issue.id, incarnation, session_id: again, request_id: crypto.randomUUID(), ttl: 3600 });
    assert.equal(second.isError, false);
    assert.equal(second.structuredContent.claim_receipt.revision, 3);
    assert.equal(second.structuredContent.claim_receipt.generation, 2);
    sqlite.prepare('UPDATE issue_claims SET acquired_at = 100, changed_at = 100, expires_at = 1000 WHERE issue_id = ?').run(issue.id);
    const expiredProof = { issue_id: issue.id, incarnation, session_id: again, generation: 2 };
    const httpDefault = await post('/v1/operations', { op: 'claim_release', claim_proof: expiredProof, expected_revision: 3, request_id: crypto.randomUUID() });
    assert.equal(httpDefault.status, 409);
    assert.equal(httpDefault.body.error.code, 'claim_conflict');
    assert.equal(httpDefault.body.error.details.current.state, 'expired');
    const mcpDefault = await mcp('claim_release', { claim_proof: expiredProof, expected_revision: 3, request_id: crypto.randomUUID() });
    assert.equal(mcpDefault.isError, true);
    assert.equal(mcpDefault.structuredContent.error.code, 'claim_conflict');
    const httpFalse = await post('/v1/operations', { op: 'claim_release', claim_proof: expiredProof, expected_revision: 3, request_id: crypto.randomUUID(), expired_noop: false });
    assert.equal(httpFalse.status, 400);
    assert.equal(httpFalse.body.error.code, 'invalid_input');
    const httpCleanup = await post('/v1/operations', { op: 'claim_release', claim_proof: { issue_id: issue.id, incarnation, session_id: again, generation: 2 }, expected_revision: 3, request_id: crypto.randomUUID(), expired_noop: true });
    assert.equal(httpCleanup.status, 200);
    assert.equal(httpCleanup.body.released, false);
    assert.equal(httpCleanup.body.current.state, 'expired');
    assert.equal(httpCleanup.body.current.lease.revision, 3);
    assert.equal(httpCleanup.body.current.lease.released_at, null);
    const mcpCleanup = await mcp('claim_release', { claim_proof: { issue_id: issue.id, incarnation, session_id: again, generation: 2 }, expected_revision: 99, request_id: crypto.randomUUID(), expired_noop: true });
    assert.equal(mcpCleanup.isError, false);
    assert.equal(mcpCleanup.structuredContent.released, false);
    assert.equal(mcpCleanup.structuredContent.current.state, 'expired');
    assert.equal(mcpCleanup.structuredContent.current.lease.revision, 3);
    assert.equal(sqlite.prepare('SELECT revision, released_at FROM issue_claims WHERE issue_id = ?').get(issue.id)?.revision, 3);
    assert.equal(sqlite.prepare('SELECT released_at FROM issue_claims WHERE issue_id = ?').get(issue.id)?.released_at, null);
    const foreignSession = crypto.randomUUID();
    const foreign = await post('/v1/operations', { op: 'claim_acquire', issue_id: issue.id, incarnation, session_id: foreignSession, request_id: crypto.randomUUID() });
    assert.equal(foreign.body.claim_receipt.revision, 4);
    const oldProof = { issue_id: issue.id, incarnation, session_id: again, generation: 2 };
    const httpConflict = await post('/v1/operations', { op: 'claim_release', claim_proof: oldProof, expected_revision: 4, request_id: crypto.randomUUID(), expired_noop: true });
    assert.equal(httpConflict.status, 409);
    assert.equal(httpConflict.body.error.code, 'claim_conflict');
    const mcpConflict = await mcp('claim_release', { claim_proof: oldProof, expected_revision: 4, request_id: crypto.randomUUID(), expired_noop: true });
    assert.equal(mcpConflict.isError, true);
    assert.equal(mcpConflict.structuredContent.error.code, 'claim_conflict');
    assert.equal((await post('/v1/operations', { op: 'claim_show', issue_id: issue.id })).body.claim.lease.revision, 4);
    sqlite.prepare('UPDATE issue_claims SET acquired_at = 100, changed_at = 100, expires_at = 1000 WHERE issue_id = ?').run(issue.id);
    const expiredConflict = await post('/v1/operations', { op: 'claim_release', claim_proof: oldProof, expected_revision: 4, request_id: crypto.randomUUID(), expired_noop: true });
    assert.equal(expiredConflict.status, 409);
    assert.equal(expiredConflict.body.error.code, 'claim_conflict');
    const expiredMcp = await mcp('claim_release', { claim_proof: oldProof, expected_revision: 4, request_id: crypto.randomUUID(), expired_noop: true });
    assert.equal(expiredMcp.isError, true);
    assert.equal(expiredMcp.structuredContent.error.code, 'claim_conflict');
    assert.equal(sqlite.prepare('SELECT revision FROM issue_claims WHERE issue_id = ?').get(issue.id)?.revision, 4);
    const foreignProof = { issue_id: issue.id, incarnation, session_id: foreignSession, generation: foreign.body.claim_receipt.generation };
    const foreignCleanup = await mcp('claim_release', { claim_proof: foreignProof, expected_revision: 4, request_id: crypto.randomUUID(), expired_noop: true });
    assert.equal(foreignCleanup.isError, false);
    assert.equal(foreignCleanup.structuredContent.released, false);
    assert.equal(foreignCleanup.structuredContent.current.state, 'expired');
    assert.equal(foreignCleanup.structuredContent.current.lease.revision, 4);
    const write = await post('/v1/operations', { op: 'update', id: issue.id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }], claim_proof: foreignProof });
    assert.equal(write.status, 409);
    assert.equal(write.body.error.code, 'claim_required');
  } finally { sqlite.close(); }
});

test('claim_acquire without a session UUID fails with a session_id usage error on HTTP and MCP', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const post = (path: string, body: unknown) => handleRequest(new Request(`https://issues.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token },
    body: JSON.stringify(body),
  }), env, authenticate);
  try {
    const base = { issue_id: 'pd-1', incarnation: 'f'.repeat(32), request_id: crypto.randomUUID() };
    for (const [session, message] of [
      [{}, 'Missing field: session_id'],
      [{ session_id: null }, 'session_id must be a lowercase UUID'],
      [{ session_id: 'NOT-A-UUID' }, 'session_id must be a lowercase UUID'],
    ] as const) {
      const http = await post('/v1/operations', { op: 'claim_acquire', ...base, ...session });
      assert.equal(http.status, 400);
      assert.deepEqual((await http.json()).error, { code: 'invalid_input', message });
      // MCP returns a failed tool call as an isError result in HTTP 200; the error body carries no status.
      const mcp = (await (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'claim_acquire', arguments: { ...base, ...session } } })).json()).result;
      assert.equal(mcp.isError, true);
      assert.deepEqual(mcp.structuredContent.error, { code: 'invalid_input', message });
    }
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM claim_requests').get()?.count, 0);
  } finally { sqlite.close(); }
});

test('claim_acquire returns open blockers on HTTP and MCP and still acquires', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const post = (path: string, body: unknown) => handleRequest(new Request(`https://issues.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token },
    body: JSON.stringify(body),
  }), env, authenticate);
  try {
    const dependent = await seedIssue(env, token, 'dependent');
    const open = await seedIssue(env, token, 'open blocker');
    const closed = await seedIssue(env, token, 'closed blocker');
    const clear = await seedIssue(env, token, 'clear');
    assert.equal((await post('/v1/operations', { op: 'close', id: closed, expected: 1 })).status, 200);
    assert.equal((await post('/v1/operations', { op: 'dependency_add', dependent_id: dependent, blocker_id: open, expected_revision: 1, request_id: crypto.randomUUID() })).status, 200);
    assert.equal((await post('/v1/operations', { op: 'dependency_add', dependent_id: dependent, blocker_id: closed, expected_revision: 2, request_id: crypto.randomUUID() })).status, 200);
    assert.equal((await post('/v1/operations', { op: 'dependency_add', dependent_id: clear, blocker_id: closed, expected_revision: 1, request_id: crypto.randomUUID() })).status, 200);
    const incarnation = (await (await post('/v1/operations', { op: 'claim_show', issue_id: dependent })).json()).claim.store_incarnation;
    const args = { issue_id: dependent, incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() };
    const http = await (await post('/v1/operations', { op: 'claim_acquire', ...args })).json();
    assert.equal(http.claim_receipt.outcome, 'acquired');
    assert.equal(http.claim_receipt.generation, 1);
    assert.deepEqual(http.open_blockers, [open]);
    const mcp = (await (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'claim_acquire', arguments: args } })).json()).result;
    assert.equal(mcp.isError, false);
    assert.deepEqual(mcp.structuredContent, http);
    const clearArgs = { issue_id: clear, incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() };
    const clearHttp = await (await post('/v1/operations', { op: 'claim_acquire', ...clearArgs })).json();
    assert.equal(clearHttp.claim_receipt.outcome, 'acquired');
    assert.deepEqual(clearHttp.open_blockers, []);
    const clearMcp = (await (await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'claim_acquire', arguments: clearArgs } })).json()).result;
    assert.equal(clearMcp.isError, false);
    assert.deepEqual(clearMcp.structuredContent.open_blockers, []);
  } finally { sqlite.close(); }
});

test('tools/list advertises the pinned inputSchema of every MCP tool and requires session_id for claim_acquire', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const response = await handleRequest(new Request('https://issues.example/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), env, authenticate);
    const tools: { name: string; inputSchema: { required: string[] } }[] = (await response.json()).result.tools;
    assert.deepEqual(tools.find(tool => tool.name === 'claim_acquire')?.inputSchema.required, ['issue_id', 'incarnation', 'session_id', 'request_id']);
    const schemas = Object.fromEntries(tools.map(tool => [tool.name, tool.inputSchema]).sort(([left], [right]) => String(left).localeCompare(String(right))));
    assertSnapshot('mcp-input-schemas.json', JSON.stringify(schemas, null, 2) + '\n');
  } finally { sqlite.close(); }
});

async function seedIssue(env: ReturnType<typeof fixture>['env'], token: string, body: string): Promise<string> {
  const response = await handleRequest(new Request('https://issues.example/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token },
    body: JSON.stringify({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body }),
  }), env, authenticate);
  assert.equal(response.status, 200);
  return (await response.json()).issue.id;
}

function viewUi(env: ReturnType<typeof fixture>['env'], headers: Record<string, string> = {}, method = 'GET') {
  return handleRequest(new Request('https://issues.example/ui', { method, headers }), env, authenticate);
}

function uiSection(html: string, heading: string): string {
  const part = html.split('<h2>').find(candidate => candidate.startsWith(`${heading}</h2>`));
  assert.ok(part, heading);
  return part;
}

// A page carries the speculation rules and, on an issue page where Dispatch is ready, the fixed Dispatch script.
function speculationRules(html: string): string {
  const all = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const scripts = all.filter(script => script[1] !== '' || script[2] !== dispatchScript);
  assert.ok(all.length - scripts.length <= 1);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1], ' type="speculationrules"');
  const body = scripts[0][2] ?? '';
  assert.deepEqual(JSON.parse(body), {
    prefetch: [{
      source: 'document',
      where: { or: [{ href_matches: '/ui' }, { href_matches: '/ui/*' }] },
      eagerness: 'moderate',
      referrer_policy: 'no-referrer',
    }],
  });
  return body;
}

const notesField = '<textarea id="dispatch-notes" name="notes" maxlength="4096" rows="4" placeholder="What should the agent do or watch for?"></textarea>';
const notesLabel = '<label for="dispatch-notes">Notes for the agent (optional)</label>';
const freshSummary = '<p class="secondary">not ready · no blockers · not claimed · will not start now</p>';

function assertNoApplicationControls(html: string): void {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]);
  if (forms.length === 0) {
    assert.equal(/<(form|input|button|textarea)\b/.test(html), false);
  } else {
    assert.equal(forms.length, 1);
    const form = forms[0] ?? '';
    assert.match(form, /^<form method="post" action="\/ui\/i\/[a-z][a-z0-9]{0,15}-[1-9][0-9]*(?:\.[1-9][0-9]*){0,7}\/dispatch" class="dispatch">/);
    assert.equal(/<input\b/.test(html), false);
    assert.deepEqual([...html.matchAll(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/g)].map(match => match[0]), [notesField]);
    const button = form.includes('disabled')
      ? '<button type="submit" disabled>Dispatch</button>'
      : '<button type="submit">Dispatch</button>';
    assert.deepEqual([...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]), [button]);
    if (form.includes('disabled')) assert.ok(form.includes('Dispatch is not set up.'));
    else assert.equal(form.includes('Dispatch is not set up.'), false);
  }
  speculationRules(html);
}

function uiPolicy(html: string): string {
  const hash = createHash('sha256').update(speculationRules(html)).digest('base64');
  const dispatch = createHash('sha256').update(dispatchScript).digest('base64');
  return `default-src 'none'; script-src 'sha256-${hash}' 'sha256-${dispatch}'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

function projectPath(tool: string, project: string): string {
  return `/ui/p/${encodeURIComponent(tool)}/${project.split('/').map(segment => encodeURIComponent(segment)).join('/')}`;
}

function viewProject(env: ReturnType<typeof fixture>['env'], tool: string, project: string, headers: Record<string, string> = {}, method = 'GET', query = '') {
  return handleRequest(new Request(`https://issues.example${projectPath(tool, project)}${query}`, { method, headers }), env, authenticate);
}

function viewIssue(env: ReturnType<typeof fixture>['env'], id: string, headers: Record<string, string> = {}, method = 'GET') {
  return handleRequest(new Request(`https://issues.example/ui/i/${id}`, { method, headers }), env, authenticate);
}

// Holds each D1 call until the current wave is released, so a page's sequential database round trips can be counted.
function roundTrips(env: ReturnType<typeof fixture>['env']) {
  type Statement = ReturnType<typeof env.DB.prepare>;
  const waiting: (() => void)[] = [];
  const hold = <T>(work: () => Promise<T>) => new Promise<T>((resolve, reject) => { waiting.push(() => { work().then(resolve, reject); }); });
  const wrap = (statement: Statement): Statement => ({ ...statement, bind: (...values: (string | number | null)[]) => wrap(statement.bind(...values)), all: () => hold(() => statement.all()) });
  const DB = { prepare: (sql: string) => wrap(env.DB.prepare(sql)), batch: (statements: Statement[]) => hold(() => env.DB.batch(statements)) };
  return {
    env: { ...env, DB },
    async count(pending: Promise<Response>): Promise<{ response: Response; rounds: number }> {
      let settled = false;
      pending.then(() => { settled = true; }, () => { settled = true; });
      let rounds = 0;
      for (let turn = 0; !settled; turn += 1) {
        assert.ok(turn < 10_000, 'The page never finished');
        await new Promise(resolve => setImmediate(resolve));
        if (waiting.length === 0) continue;
        rounds += 1;
        for (const release of waiting.splice(0)) release();
      }
      return { response: await pending, rounds };
    },
  };
}

test('ui: the issue page and an ID search start their independent reads together', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const epic = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Parallel epic', type: 'epic' });
    const child = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Parallel child', parent: epic });
    const blocker = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Parallel blocker' });
    await handleRequest(new Request('https://issues.example/v1/operations', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'dependency_add', dependent_id: child, blocker_id: blocker, expected_revision: 1, request_id: crypto.randomUUID() }) }), env, authenticate);
    const counted = roundTrips(env);

    const detail = await counted.count(handleRequest(new Request(`https://issues.example/ui/i/${child}`, { headers: auth }), counted.env, authenticate));
    assert.equal(detail.response.status, 200);
    const html = await detail.response.text();
    assert.ok(html.includes(`Parent <a href="/ui/i/${epic}">Parallel epic</a>`));
    assert.ok(uiSection(html, 'Active blockers').includes(`href="/ui/i/${blocker}"`));
    assert.equal(detail.rounds, 2);

    const missing = await counted.count(handleRequest(new Request('https://issues.example/ui/i/pd-999', { headers: auth }), counted.env, authenticate));
    assert.equal(missing.response.status, 404);
    assert.ok((await missing.response.text()).includes('Issue was not found.'));

    const search = await counted.count(handleRequest(new Request(`https://issues.example/ui/search?q=${child}`, { headers: auth }), counted.env, authenticate));
    assert.equal(search.response.status, 200);
    assert.ok((await search.response.text()).includes(`href="/ui/i/${child}"`));
    assert.equal(search.rounds, 2);
  } finally { sqlite.close(); }
});

test('ui: every page reports the Worker time in Server-Timing, and a rejected caller gets none', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const id = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Timed title' });
    for (const path of ['/ui', '/ui/inbox', '/ui/working', '/ui/blocked', '/ui/recent', '/ui/activity', '/ui/search?q=Timed', '/ui/p/polylinedb/meganemura/polylinedb', `/ui/i/${id}`, '/ui/i/pd-999']) {
      const response = await handleRequest(new Request(`https://issues.example${path}`, { headers: auth }), env, authenticate);
      assert.match(response.headers.get('server-timing') ?? '', /^worker;dur=\d+\.\d$/, path);
    }
    const rejections: Record<string, string>[] = [{}, { 'cf-access-jwt-assertion': await assertion({ sub: 'stranger' }) }];
    for (const headers of rejections) {
      const rejected = await viewUi(env, headers);
      assert.ok(rejected.status === 401 || rejected.status === 403);
      assert.equal(rejected.headers.get('server-timing'), null);
      assert.ok(!(await rejected.text()).includes('Timed title'));
    }
  } finally { sqlite.close(); }
});

test('MCP initialize, tools/list, and tools/call report the Worker time in Server-Timing', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const rpc = (body: Record<string, unknown>, headers: Record<string, string> = { 'cf-access-jwt-assertion': token }) => handleRequest(new Request('https://issues.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body),
  }), env, authenticate);
  try {
    const calls = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'timing', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'actor', arguments: {} } },
    ];
    for (const call of calls) {
      const response = await rpc(call);
      assert.ok(response.status === 200 || response.status === 202, call.method);
      assert.match(response.headers.get('server-timing') ?? '', /^worker;dur=\d+\.\d$/, call.method);
    }
    const rejected = await rpc(calls[0]!, {});
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('server-timing'), null);
  } finally { sqlite.close(); }
});

function favicon(html: string): string {
  const links = [...html.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)].map(match => match[0]);
  assert.equal(links.length, 1);
  const match = /^<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]*)">$/.exec(links[0] ?? '');
  assert.ok(match, links[0]);
  assert.equal(/[\s#<>%"&]/.test((match[1] ?? '').replace(/%[0-9A-F]{2}/g, '')), false);
  return decodeURIComponent(match[1] ?? '');
}

test('ui: every page, including not found and a dispatch result, carries the same inline SVG favicon', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const id = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Icon title' });
    const pages: string[] = [];
    for (const path of ['/ui', '/ui/inbox', '/ui/working', '/ui/blocked', '/ui/recent', '/ui/activity', '/ui/search', '/ui/search?q=Icon', '/ui/p/polylinedb/meganemura/polylinedb', '/ui/p/polylinedb/meganemura/polylinedb?status=open', `/ui/i/${id}`, '/ui/i/pd-999']) {
      const response = await handleRequest(new Request(`https://issues.example${path}`, { headers: auth }), env, authenticate);
      assert.match(response.headers.get('content-security-policy') ?? '', /; img-src data:;/, path);
      pages.push(await response.text());
    }
    pages.push(await dispatchResponse({ kind: 'not_sent' }, id).text());
    const icons = new Set(pages.map(favicon));
    assert.equal(icons.size, 1);
    const [svg] = icons;
    assert.match(svg ?? '', /^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 32 32'>[\s\S]*<\/svg>$/);
    assert.ok(svg?.includes('<path d='));
    assert.ok(svg?.includes('#9a3412') && svg.includes('#f0a07a'));
    assert.ok(svg?.includes('@media (prefers-color-scheme:dark)'));
    assert.equal(/\b(href|src)=|url\(|<script/.test(svg ?? ''), false);
  } finally { sqlite.close(); }
});

test('ui: a page revalidates with its ETag only after Access accepts the caller, and a 304 carries no page data', async () => {
  const { sqlite, env } = fixture('["access:owner","access:peer",{"actor":"access:viewer","role":"reader"}]');
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const reads: string[] = [];
  const watched = { ...env, DB: { ...env.DB, prepare: (sql: string) => { reads.push(sql); return env.DB.prepare(sql); } } };
  try {
    const id = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Cached title' });
    const issueRequest = (headers: Record<string, string>, target = env) => handleRequest(new Request(`https://issues.example/ui/i/${id}`, { headers }), target, authenticate);
    const first = await issueRequest(auth);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    // no-referrer would make the same-origin Dispatch POST carry Origin: null, which dispatch rejects.
    assert.equal(first.headers.get('referrer-policy'), 'same-origin');
    const etag = first.headers.get('etag') ?? '';
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    const html = await first.text();
    assert.equal(etag, `"${createHash('sha256').update(html).digest('hex').slice(0, 32)}"`);

    for (const ifNoneMatch of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
      const again = await issueRequest({ ...auth, 'if-none-match': ifNoneMatch });
      assert.equal(again.status, 304, ifNoneMatch);
      assert.equal(await again.text(), '');
      assert.equal(again.headers.get('etag'), etag);
      assert.equal(again.headers.get('cache-control'), 'private, no-cache');
      assert.equal(again.headers.get('content-security-policy'), first.headers.get('content-security-policy'));
      assert.equal(again.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(again.headers.get('referrer-policy'), 'same-origin');
      assert.equal(again.headers.get('content-type'), null);
    }
    const reader = await issueRequest({ 'cf-access-jwt-assertion': await assertion({ sub: 'viewer' }), 'if-none-match': etag });
    assert.equal(reader.status, 200);
    const readerHtml = await reader.text();
    assert.equal(/<(form|button)\b/.test(readerHtml), false);
    assert.ok(readerHtml.includes('Cached title'));
    const peer = await issueRequest({ 'cf-access-jwt-assertion': await assertion({ sub: 'peer' }), 'if-none-match': etag });
    assert.equal(peer.status, 304);
    const stale = await issueRequest({ ...auth, 'if-none-match': '"0123456789abcdef0123456789abcdef"' });
    assert.equal(stale.status, 200);
    assert.ok((await stale.text()).includes('Cached title'));

    for (const ifNoneMatch of [etag, '*']) {
      const rejections: Record<string, string>[] = [{}, { 'cf-access-jwt-assertion': `${token.slice(0, -4)}AAAA` }, { 'cf-access-jwt-assertion': await assertion({ sub: 'stranger' }) }];
      for (const headers of rejections) {
        const denied = await issueRequest({ ...headers, 'if-none-match': ifNoneMatch }, watched);
        assert.ok(denied.status === 401 || denied.status === 403, `${denied.status}`);
        assert.equal(denied.headers.get('etag'), null);
        assert.equal(denied.headers.get('cache-control'), 'no-store');
        assert.equal(denied.headers.get('content-type'), 'application/json');
        assert.ok(!(await denied.text()).includes('Cached title'));
      }
      const misconfigured = await issueRequest({ ...auth, 'if-none-match': ifNoneMatch }, { ...watched, ACCESS_ACTORS: '[]' });
      assert.equal(misconfigured.status, 503);
      assert.equal(misconfigured.headers.get('etag'), null);
    }
    assert.deepEqual(reads, []);

    sqlite.prepare("UPDATE issues SET body = 'Changed title', updated_at = '2026-10-10T00:00:00.000Z' WHERE id = ?").run(id);
    const changed = await issueRequest({ ...auth, 'if-none-match': etag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.ok((await changed.text()).includes('Changed title'));

    const missing = await handleRequest(new Request('https://issues.example/ui/i/pd-999', { headers: { ...auth, 'if-none-match': '*' } }), env, authenticate);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('etag'), null);
    assert.ok((await missing.text()).includes('Issue was not found.'));
    const home = await viewUi(env, auth);
    const homeTag = home.headers.get('etag') ?? '';
    assert.notEqual(homeTag, etag);
    assert.equal((await viewUi(env, { ...auth, 'if-none-match': homeTag })).status, 304);
  } finally { sqlite.close(); }
});

test('ui: speculation rules prefetch only /ui links under a CSP hash, and a private 304 still hides the page', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const id = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Prefetch title' });
    const first = await viewUi(env, auth);
    assert.equal(first.status, 200);
    const html = await first.text();
    const policy = uiPolicy(html);
    assert.equal(first.headers.get('content-security-policy'), policy);
    assert.match(policy, /script-src 'sha256-[A-Za-z0-9+/]+=' 'sha256-[A-Za-z0-9+/]+=';/);
    assert.equal(/script-src[^;]*unsafe-inline/.test(policy), false);
    assert.equal(policy.includes('inline-speculation-rules'), false);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.equal(first.headers.get('cache-control')?.includes('public'), false);
    assert.equal(html.includes('prerender'), false);
    assert.equal(html.includes(id), false);
    const etag = first.headers.get('etag') ?? '';
    const again = await viewUi(env, { ...auth, 'if-none-match': etag });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    assert.equal(again.headers.get('content-security-policy'), policy);
    assert.equal(again.headers.get('cache-control'), 'private, no-cache');
    assert.equal(again.headers.get('etag'), etag);
    const denied = await viewUi(env, { 'if-none-match': etag });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('etag'), null);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    const deniedBody = await denied.text();
    assert.equal(deniedBody.includes('speculationrules'), false);
    assert.equal(deniedBody.includes('Prefetch title'), false);
  } finally { sqlite.close(); }
});

test('/ui lists main-wait issues and closed issues by last update, with escaped titles and actors', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const older = await seedIssue(env, token, '# Older close\n\ndetails');
    const newest = await seedIssue(env, token, '\n## Newest close');
    const hostile = await seedIssue(env, token, '<img src=x onerror=alert(1)>&');
    const waiting = await seedIssue(env, token, '# Merged locally');
    const plainOpen = await seedIssue(env, token, '# Still open');
    const closedWaiting = await seedIssue(env, token, '# Closed with a stale label');
    const set = sqlite.prepare("UPDATE issues SET status = ?, labels_json = ?, updated_at = ?, updated_by = ? WHERE id = ?");
    set.run('closed', '[]', '2026-10-01T00:00:00.000Z', 'access:alice', older);
    set.run('closed', '[]', '2026-10-03T10:30:00.000Z', 'service:agent-7', newest);
    set.run('closed', '[]', '2026-10-02T00:00:00.000Z', 'access:<b>"x"', hostile);
    set.run('open', '["main-wait"]', '2026-10-04T00:00:00.000Z', 'access:alice', waiting);
    set.run('open', '[]', '2026-10-05T00:00:00.000Z', 'access:alice', plainOpen);
    set.run('closed', '["main-wait"]', '2026-09-30T00:00:00.000Z', 'access:alice', closedWaiting);

    const response = await viewUi(env, { 'cf-access-jwt-assertion': token });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    const html = await response.text();
    const waitingPart = uiSection(html, 'Waiting for main');
    const ids = (part: string) => [...part.matchAll(/<span class="secondary">(pd-\d+) · /g)].map(match => match[1]);
    assert.match(waitingPart, /^Waiting for main<\/h2>/);
    assert.deepEqual(ids(waitingPart), [waiting]);
    assert.equal(html.indexOf('<h2>Recently closed</h2>'), -1);
    assert.ok(!html.includes('Newest close'));
    assertNoApplicationControls(html);
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
    const project = await (await viewProject(env, 'compiler', 'parser', { 'cf-access-jwt-assertion': token })).text();
    const closedPart = uiSection(project, 'Recently closed');
    assert.match(closedPart, /^Recently closed<\/h2>/);
    assert.deepEqual(ids(closedPart), [newest, hostile, older, closedWaiting]);
    assert.ok(project.includes(`<span class="primary">Newest close</span>\n<span class="secondary">${newest} · Last updated <time datetime="2026-10-03T10:30:00.000Z">2026-10-03 19:30 JST</time></span>\n<span class="secondary">service:agent-7</span>`));
    assert.ok(project.includes('<span class="primary">&lt;img src=x onerror=alert(1)&gt;&amp;</span>'));
    assert.ok(project.includes('<span class="secondary">access:&lt;b&gt;&quot;x&quot;</span>'));
    assert.ok(!project.includes('<img'));
    assertNoApplicationControls(project);
  } finally { sqlite.close(); }
});

test('/ui orders recently closed by close time, and a later edit does not move a recorded close', async () => {
  const { sqlite, env } = fixture(JSON.stringify(['access:owner', { actor: 'service:closer', role: 'agent', label: 'Closer' }]));
  const token = await assertion();
  try {
    const legacy = await seedIssue(env, token, '# Legacy close');
    const edited = await seedIssue(env, token, '# Edited after close');
    const tied = await seedIssue(env, token, '# Same close, older edit');
    const latest = await seedIssue(env, token, '# Latest close');
    const stamp = sqlite.prepare('UPDATE issues SET status = ?, updated_at = ?, updated_by = ?, closed_at = ?, closed_by = ? WHERE id = ?');
    stamp.run('closed', '2026-10-08T00:00:00.000Z', 'access:owner', null, null, legacy);
    stamp.run('closed', '2026-10-09T00:00:00.000Z', 'access:owner', '2026-10-01T00:00:00.000Z', 'service:closer', edited);
    stamp.run('closed', '2026-10-03T00:00:00.000Z', 'access:owner', '2026-10-01T00:00:00.000Z', 'access:owner', tied);
    stamp.run('closed', '2026-10-02T00:00:00.000Z', 'access:owner', '2026-10-05T00:00:00.000Z', 'service:closer', latest);

    const project = await (await viewProject(env, 'compiler', 'parser', { 'cf-access-jwt-assertion': token })).text();
    const closedPart = uiSection(project, 'Recently closed');
    const ids = [...closedPart.matchAll(/<span class="secondary">(pd-\d+) · /g)].map(match => match[1]);
    assert.deepEqual(ids, [latest, edited, tied, legacy]);
    assert.match(closedPart, /^Recently closed<\/h2><p class="section-note">Ordered by close time\. A row without a close record shows its last update, which is not the close time\.<\/p>/);
    assert.ok(closedPart.includes(`<span class="primary">Latest close</span>\n<span class="secondary">${latest} · Closed <time datetime="2026-10-05T00:00:00.000Z">2026-10-05 09:00 JST</time></span>\n<span class="secondary">Closer</span>`));
    assert.ok(closedPart.includes(`<span class="primary">Edited after close</span>\n<span class="secondary">${edited} · Closed <time datetime="2026-10-01T00:00:00.000Z">2026-10-01 09:00 JST</time></span>\n<span class="secondary">Closer</span>`));
    assert.ok(closedPart.includes(`<span class="primary">Legacy close</span>\n<span class="secondary">${legacy} · Last updated <time datetime="2026-10-08T00:00:00.000Z">2026-10-08 09:00 JST</time></span>\n<span class="secondary">access:owner</span>`));
    assert.equal(closedPart.includes(`${legacy} · Closed`), false);
    const globalIds = sqlite.prepare(statements.recentlyClosed).all({ limit: 10 }).map(row => String(row.id));
    assert.deepEqual(globalIds, [latest, edited, tied, legacy]);
  } finally { sqlite.close(); }
});

test('/ui names the last updater by its roster label, and by the raw actor ID without one', async () => {
  const { sqlite, env } = fixture(JSON.stringify(['access:owner', { actor: 'service:claude-token', role: 'agent', label: 'Claude' },
    { actor: 'service:hostile-token', role: 'agent', label: `<b>"Codex"&'` }, { actor: 'service:cursor-token', role: 'agent' }]));
  const token = await assertion();
  try {
    const updaters = ['service:claude-token', 'service:hostile-token', 'service:cursor-token', 'access:departed'];
    const ids: string[] = [];
    for (const updater of updaters) ids.push(await seedIssue(env, token, `# Closed by ${updater}`));
    const set = sqlite.prepare("UPDATE issues SET status = 'closed', updated_at = ?, updated_by = ? WHERE id = ?");
    updaters.forEach((updater, index) => set.run(`2026-10-0${4 - index}T00:00:00.000Z`, updater, ids[index]));
    const before = JSON.stringify(sqlite.prepare('SELECT * FROM issues ORDER BY id').all());

    const html = await (await viewProject(env, 'compiler', 'parser', { 'cf-access-jwt-assertion': token })).text();
    const updatedBy = [...html.matchAll(/<\/time><\/span>\n<span class="secondary">([^<]*)<\/span>/g)].map(match => match[1]);
    assert.deepEqual(updatedBy, ['Claude', '&lt;b&gt;&quot;Codex&quot;&amp;&#39;', 'service:cursor-token', 'access:departed']);
    assert.ok(!html.includes('<b>'));
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM issues ORDER BY id').all()), before);
  } finally { sqlite.close(); }
});

test('/ui shows quiet notes when nothing waits for main and nothing has closed', async () => {
  const { sqlite, env } = fixture();
  try {
    const html = await (await viewUi(env, { 'cf-access-jwt-assertion': await assertion() })).text();
    assert.ok(html.includes('<p class="quiet-note">Nothing is waiting for main.</p>'));
    assert.ok(html.includes('<p class="quiet-note">Nothing is waiting on you.</p>'));
    const project = await (await viewProject(env, 'compiler', 'parser', { 'cf-access-jwt-assertion': await assertion() })).text();
    assert.ok(project.includes('<p class="quiet-note">Nothing has closed yet.</p>'));
  } finally { sqlite.close(); }
});

test('/ui requires the Access assertion and the roster, lets owner, agent, and reader view it, and accepts no writes', async () => {
  const { sqlite, env } = fixture('["access:owner",{"actor":"access:viewer","role":"reader"},{"actor":"service:robot","role":"agent"}]');
  const token = await assertion();
  try {
    const id = await seedIssue(env, token, '# Secret title');
    sqlite.prepare("UPDATE issues SET status = 'closed' WHERE id = ?").run(id);
    const before = JSON.stringify(sqlite.prepare('SELECT * FROM issues ORDER BY id').all());

    const anonymous = await viewUi(env);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Secret title'));
    const forged = await viewUi(env, { 'cf-access-jwt-assertion': `${token.slice(0, -4)}AAAA` });
    assert.equal(forged.status, 401);
    assert.ok(!(await forged.text()).includes('Secret title'));
    const stranger = await viewUi(env, { 'cf-access-jwt-assertion': await assertion({ sub: 'stranger' }) });
    assert.equal(stranger.status, 403);
    assert.ok(!(await stranger.text()).includes('Secret title'));

    const roles = { owner: token, reader: await assertion({ sub: 'viewer' }), agent: await assertion({ sub: '', common_name: 'robot' }) };
    for (const [role, roleToken] of Object.entries(roles)) {
      const view = await viewUi(env, { 'cf-access-jwt-assertion': roleToken });
      assert.equal(view.status, 200, role);
      const project = await viewProject(env, 'compiler', 'parser', { 'cf-access-jwt-assertion': roleToken });
      assert.equal(project.status, 200, role);
      assert.ok((await project.text()).includes('<span class="primary">Secret title</span>'), role);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const write = await handleRequest(new Request('https://issues.example/ui', { method,
          headers: { 'cf-access-jwt-assertion': roleToken, 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'reopen', id, expected: 1 }) }), env, authenticate);
        assert.equal(write.status, 405, `${role} ${method}`);
        assert.equal(write.headers.get('allow'), 'GET');
      }
    }
    for (const operation of [{ op: 'reopen', id, expected: 1 }, { op: 'comment', id, body: 'From a reader' },
      { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'From a reader' }]) {
      const write = await handleRequest(new Request('https://issues.example/v1/operations', { method: 'POST',
        headers: { 'cf-access-jwt-assertion': roles.reader, 'content-type': 'application/json' },
        body: JSON.stringify(operation) }), env, authenticate);
      assert.equal(write.status, 403, operation.op);
      assert.equal((await write.json()).error.code, 'read_only_actor');
    }
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM comments').get()?.count, 0);
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM issues ORDER BY id').all()), before);
    assert.equal((await viewUi(env, {})).headers.get('content-type'), 'application/json');
  } finally { sqlite.close(); }
});

test('/ui reads no issue before Access accepts the caller, and a misconfigured Access returns 503', async () => {
  const { sqlite, env } = fixture();
  const reads: string[] = [];
  const watched = { ...env, DB: { ...env.DB, prepare: (sql: string) => { reads.push(sql); return env.DB.prepare(sql); } } };
  try {
    const token = await assertion();
    const misconfigured = [{ ACCESS_TEAM_DOMAIN: '' }, { ACCESS_AUD: '' }, { ACCESS_ACTORS: '[]' }];
    for (const override of misconfigured) {
      const response = await handleRequest(new Request('https://issues.example/ui', { headers: { 'cf-access-jwt-assertion': token } }),
        { ...watched, ...override }, authenticate);
      assert.equal(response.status, 503, JSON.stringify(override));
      assert.deepEqual(await response.json(), { error: { code: 'invalid_access_configuration', message: 'Authentication unavailable' } });
    }
    assert.equal((await viewUi(watched)).status, 401);
    assert.equal((await viewUi(watched, { 'cf-access-jwt-assertion': await assertion({ sub: 'stranger' }) })).status, 403);
    assert.deepEqual(reads, []);
    assert.equal((await viewUi(watched, { 'cf-access-jwt-assertion': token })).status, 200);
    assert.equal(reads.length, 2);
  } finally { sqlite.close(); }
});

async function createIssue(env: ReturnType<typeof fixture>['env'], token: string, fields: Record<string, unknown>): Promise<string> {
  const operate = async (body: Record<string, unknown>) => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(body),
    }), env, authenticate);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const started = fields.status === 'in_progress' && fields.type !== 'epic';
  const { id } = (await operate({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), ...fields, ...(started ? { status: 'open' } : {}) })).issue;
  if (!started) return id;
  const { store_incarnation } = (await operate({ op: 'claim_show', issue_id: id })).claim;
  const session_id = crypto.randomUUID();
  const { claim_receipt } = await operate({ op: 'claim_acquire', issue_id: id, incarnation: store_incarnation, session_id, request_id: crypto.randomUUID() });
  const claim_proof = { issue_id: id, incarnation: claim_receipt.incarnation, session_id, generation: claim_receipt.generation };
  await operate({ op: 'update', id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }], claim_proof });
  return id;
}

test('pd-134: /ui lists projects and a project view shows unfinished issues in that project', async () => {
  const { sqlite, env } = fixture('["access:owner",{"actor":"access:viewer","role":"reader"}]');
  const token = await assertion();
  try {
    const hold = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Hold', status: 'deferred', priority: 0 });
    const started = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Started', status: 'in_progress', priority: 0, type: 'bug', labels: ['dogfooding', 'ready'] });
    const later = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Later', status: 'open', priority: 2, type: 'feature' });
    const hostile = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: '<img src=x onerror=alert(1)>&', status: 'in_progress', priority: 1 });
    const closed = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Done nukadoko', status: 'closed' });
    const polyline = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Polyline work', labels: ['main-wait'] });
    const slashed = await createIssue(env, token, { tool: 'a/b', project: 'c', body: 'Slashed tool' });
    const marked = await createIssue(env, token, { tool: 'poly', project: 'q<b>&', body: 'Marked project' });

    const home = await viewUi(env, { 'cf-access-jwt-assertion': token });
    assert.equal(home.status, 200);
    const html = await home.text();
    const projectsAt = html.indexOf('<h2>Projects</h2>');
    const waitingAt = html.indexOf('<h2>Waiting for main</h2>');
    assert.ok(projectsAt !== -1 && projectsAt < waitingAt);
    assert.equal(html.indexOf('<h2>Recently closed</h2>'), -1);
    assert.ok(!html.includes('Done nukadoko'));
    assert.ok(html.includes('href="/ui/p/nukadoko/meganemura/nukadoko"'));
    assert.ok(html.includes('href="/ui/p/polylinedb/meganemura/polylinedb"'));
    assert.ok(html.includes('nukadoko'));
    assert.ok(html.includes('meganemura/polylinedb'));
    const nukadokoRow = html.split('<li class="quiet-row">').find(part => part.includes('meganemura/nukadoko'));
    assert.ok(nukadokoRow);
    assert.ok(nukadokoRow.includes('open 1'));
    assert.ok(nukadokoRow.includes('in_progress 2'));
    assert.ok(nukadokoRow.includes('deferred 1'));
    assert.ok(nukadokoRow.includes('closed 1'));
    const slashedRow = html.split('<li class="quiet-row">').find(part => part.includes('Slashed') || part.includes('href="/ui/p/a%2Fb/c"'));
    assert.ok(slashedRow);
    assert.ok(slashedRow.includes('href="/ui/p/a%2Fb/c"'));
    assert.ok(slashedRow.includes('in_progress 0'));
    assert.ok(html.includes('href="/ui/p/poly/q%3Cb%3E%26"'));
    assert.ok(html.includes('q&lt;b&gt;&amp;'));
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
    assertNoApplicationControls(html);
    const waitingPart = uiSection(html, 'Waiting for main');
    assert.match(waitingPart, /^Waiting for main<\/h2>/);
    assert.ok(waitingPart.includes(polyline));

    const anonymous = await viewProject(env, 'nukadoko', 'meganemura/nukadoko');
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Started'));
    const missing = await handleRequest(new Request('https://issues.example/ui/'), env, authenticate);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { code: 'not_found', message: 'Route not found.' } });
    const bareProject = await handleRequest(new Request('https://issues.example/ui/p'), env, authenticate);
    assert.equal(bareProject.status, 404);
    assert.equal(bareProject.headers.get('content-type'), 'application/json');

    const reader = await viewProject(env, 'nukadoko', 'meganemura/nukadoko', { 'cf-access-jwt-assertion': await assertion({ sub: 'viewer' }) });
    assert.equal(reader.status, 200);
    const page = await reader.text();
    assert.equal(reader.headers.get('content-security-policy'), uiPolicy(page));
    assert.equal(reader.headers.get('cache-control'), 'private, no-cache');
    assert.equal(reader.headers.get('cache-control')?.includes('public'), false);
    assert.ok(page.indexOf('Started') < page.indexOf('Hold'));
    assert.ok(page.indexOf('Hold') < page.indexOf('&lt;img src=x onerror=alert(1)&gt;&amp;'));
    assert.ok(page.indexOf('&lt;img src=x onerror=alert(1)&gt;&amp;') < page.indexOf('Later'));
    assert.ok(page.includes('<span class="secondary">in_progress</span>'));
    assert.ok(page.includes('<span class="secondary">deferred</span>'));
    assert.ok(page.includes('ready'));
    assert.ok(!page.includes('dogfooding'));
    assert.ok(!page.includes('<img'));
    const openList = page.split('<h2>Recently closed</h2>')[0] ?? '';
    assert.ok(!openList.includes(closed));
    assert.ok(!openList.includes('Done nukadoko'));
    const closedPart = uiSection(page, 'Recently closed');
    assert.ok(closedPart.includes(closed));
    assert.ok(closedPart.includes('Done nukadoko'));
    assert.ok(!page.includes(polyline));
    assert.ok(!page.includes(slashed));
    assert.ok(!page.includes(marked));
    assert.ok(page.includes(started));
    assert.ok(page.includes(hold));
    assert.ok(page.includes(later));
    assert.ok(page.includes(hostile));
    assert.ok(page.includes('<span class="secondary">priority 0</span>'));
    assert.ok(page.includes('<span class="secondary">bug</span>'));
    assertNoApplicationControls(page);
    const encoded = await handleRequest(new Request('https://issues.example/ui/p/polylinedb/meganemura%2Fpolylinedb', { headers: { 'cf-access-jwt-assertion': token } }), env, authenticate);
    assert.equal(encoded.status, 200);
    assert.ok((await encoded.text()).includes(polyline));
    const empty = await viewProject(env, 'nukadoko', 'nobody/home', { 'cf-access-jwt-assertion': token });
    assert.equal(empty.status, 200);
    const emptyHtml = await empty.text();
    assert.ok(emptyHtml.includes('Nothing is open.'));
    assert.ok(!emptyHtml.includes('Started'));
    const write = await viewProject(env, 'nukadoko', 'meganemura/nukadoko', { 'cf-access-jwt-assertion': token }, 'POST');
    assert.equal(write.status, 405);
    assert.equal(write.headers.get('allow'), 'GET');
  } finally { sqlite.close(); }
});

test('pd-134: project and issue lists say when the cap hides further rows', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const insert = sqlite.prepare(`INSERT INTO issues(id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 'open', 'task', 0, '[]', '2026-10-01T00:00:00.000Z', 'access:owner', '2026-10-01T00:00:00.000Z', 'access:owner')`);
    for (let number = 1; number <= 101; number += 1) {
      const id = `pd-${number}`;
      insert.run(id, issueSortKey(id), 'cap', 'issues', `Issue ${number}`);
    }
    for (let number = 0; number <= 200; number += 1) {
      const id = `zz-${number + 1}`;
      insert.run(id, `zz-${String(number).padStart(16, '0')}`, 'cap', `p${String(number).padStart(3, '0')}`, `Project ${number}`);
    }
    const home = await (await viewUi(env, { 'cf-access-jwt-assertion': token })).text();
    assert.ok(home.includes('More projects are not shown.'));
    assert.ok(home.includes('p000'));
    assert.ok(!home.includes('p200'));
    const page = await (await viewProject(env, 'cap', 'issues', { 'cf-access-jwt-assertion': token })).text();
    assert.ok(page.includes('More issues are not shown.'));
    assert.ok(page.includes('pd-1'));
    assert.ok(page.includes('pd-100'));
    assert.ok(!page.includes('pd-101'));
  } finally { sqlite.close(); }
});

test('pd-135: project rows link to an issue detail page that escapes body and comments', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const post = (body: unknown) => handleRequest(new Request('https://issues.example/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(body),
  }), env, authenticate);
  try {
    const epic = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Parent epic', type: 'epic' });
    const child = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Child line\n\nFollow <b>up</b>\nhttps://example.com', parent: epic, type: 'task', priority: 1, labels: ['dogfooding', 'ready', '<x>'] });
    const sibling = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Secret sibling' });
    const commented = await post({ op: 'comment', id: child, body: 'See <img src=x onerror=alert(1)>' });
    assert.equal(commented.status, 200);
    const inspection = await post({ op: 'claim_show', issue_id: child });
    assert.equal(inspection.status, 200);
    const incarnation = (await inspection.json()).claim.store_incarnation;
    const session = crypto.randomUUID();
    const acquired = await post({ op: 'claim_acquire', issue_id: child, incarnation, session_id: session, request_id: crypto.randomUUID(), agent_label: 'Codex' });
    assert.equal(acquired.status, 200);
    sqlite.prepare(`INSERT INTO issues(id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, 'polylinedb', 'meganemura/polylinedb', 'Dotted child', 'open', 'task', 2, '[]', '2026-10-01T00:00:00.000Z', 'access:owner', '2026-10-01T00:00:00.000Z', 'access:owner')`)
      .run('pd-51.6', issueSortKey('pd-51.6'));

    const list = await (await viewProject(env, 'polylinedb', 'meganemura/polylinedb', { 'cf-access-jwt-assertion': token })).text();
    assert.ok(list.includes(`href="/ui/i/${child}"`));
    assert.ok(list.includes('href="/ui/i/pd-51.6"'));
    assert.ok(!list.includes('dogfooding'));

    const anonymous = await viewIssue(env, child);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Child line'));
    const grammar = await handleRequest(new Request('https://issues.example/ui/i/not-an-id'), env, authenticate);
    assert.equal(grammar.status, 404);
    assert.equal(grammar.headers.get('content-type'), 'application/json');
    assert.deepEqual(await grammar.json(), { error: { code: 'not_found', message: 'Route not found.' } });
    const nested = await handleRequest(new Request('https://issues.example/ui/i/pd-1/extra', { headers: { 'cf-access-jwt-assertion': token } }), env, authenticate);
    assert.equal(nested.status, 404);
    assert.equal(nested.headers.get('content-type'), 'application/json');

    const missing = await viewIssue(env, 'pd-999', { 'cf-access-jwt-assertion': token });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('content-type'), 'text/html; charset=utf-8');
    const missingHtml = await missing.text();
    assert.ok(!missingHtml.includes('Secret sibling'));
    assert.ok(!missingHtml.includes('Child line'));
    assert.equal(missing.headers.get('cache-control'), 'private, no-cache');

    const detail = await viewIssue(env, child, { 'cf-access-jwt-assertion': token });
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.ok(html.includes('href="/ui/p/polylinedb/meganemura/polylinedb"'));
    assert.ok(html.includes('Child line'));
    assert.ok(html.includes(child));
    assert.ok(html.includes('<span class="secondary">open</span>'));
    assert.ok(html.includes('<span class="secondary">task</span>'));
    assert.ok(html.includes('<span class="secondary">priority 1</span>'));
    assert.ok(html.includes('polylinedb'));
    assert.ok(html.includes('meganemura/polylinedb'));
    assert.ok(html.includes('dogfooding'));
    assert.ok(html.includes('ready'));
    assert.ok(html.includes('&lt;x&gt;'));
    assert.ok(html.includes('Follow &lt;b&gt;up&lt;/b&gt;'));
    assert.ok(html.includes('https://example.com'));
    assert.ok(!html.includes('href="https://example.com"'));
    assert.ok(html.includes('See &lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<b>'));
    assert.ok(!html.includes(session));
    assert.ok(!html.includes(incarnation));
    assert.ok(html.includes('white-space: pre-wrap'));
    assertNoApplicationControls(html);
    const dotted = await viewIssue(env, 'pd-51.6', { 'cf-access-jwt-assertion': token });
    assert.equal(dotted.status, 200);
    const dottedHtml = await dotted.text();
    assert.ok(dottedHtml.includes('Dotted child'));
    assert.ok(dottedHtml.includes('href="/ui/p/polylinedb/meganemura/polylinedb"'));
    assert.ok(!dottedHtml.includes('Secret sibling'));
  } finally { sqlite.close(); }
});

test('pd-136: project rows show active claims and open blocker counts, and detail splits blockers', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const post = async (body: unknown) => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(body),
    }), env, authenticate);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const claim = async (issueId: string, agentLabel: string) => {
    const shown = await post({ op: 'claim_show', issue_id: issueId });
    const session = crypto.randomUUID();
    const receipt = (await post({ op: 'claim_acquire', issue_id: issueId, incarnation: shown.claim.store_incarnation, session_id: session, request_id: crypto.randomUUID(), agent_label: agentLabel })).claim_receipt;
    return { session, incarnation: shown.claim.store_incarnation, receipt };
  };
  try {
    const active = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Active work' });
    const released = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Released work' });
    const expired = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Expired work' });
    const one = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'One block' });
    const mixed = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Mixed blocks' });
    const clear = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Only closed' });
    const openBlocker = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Open prerequisite' });
    const deferredBlocker = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Deferred prerequisite' });
    const closedBlocker = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Closed prerequisite' });
    const otherClosed = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/claims', body: 'Finished prerequisite' });
    await post({ op: 'update', id: deferredBlocker, changes: [{ field: 'status', value: 'deferred', expected: 1 }] });
    await post({ op: 'close', id: closedBlocker, expected: 1 });
    await post({ op: 'close', id: otherClosed, expected: 1 });
    await post({ op: 'dependency_add', dependent_id: one, blocker_id: openBlocker, expected_revision: 1, request_id: crypto.randomUUID() });
    await post({ op: 'dependency_add', dependent_id: mixed, blocker_id: deferredBlocker, expected_revision: 1, request_id: crypto.randomUUID() });
    await post({ op: 'dependency_add', dependent_id: mixed, blocker_id: closedBlocker, expected_revision: 2, request_id: crypto.randomUUID() });
    await post({ op: 'dependency_add', dependent_id: clear, blocker_id: otherClosed, expected_revision: 1, request_id: crypto.randomUUID() });
    const activeClaim = await claim(active, 'Lane agent');
    const releasedClaim = await claim(released, 'Gone agent');
    const expiredClaim = await claim(expired, 'Stale agent');
    await post({ op: 'claim_release', claim_proof: { issue_id: released, incarnation: releasedClaim.receipt.incarnation, session_id: releasedClaim.receipt.session_id, generation: releasedClaim.receipt.generation }, expected_revision: releasedClaim.receipt.revision, request_id: crypto.randomUUID() });
    const activeUntil = Math.floor(Date.parse('2027-01-01T00:00:00.000Z') / 1000);
    sqlite.prepare('UPDATE issue_claims SET expires_at = ? WHERE issue_id = ?').run(activeUntil, active);
    sqlite.prepare('UPDATE issue_claims SET acquired_at = ?, changed_at = ?, expires_at = ? WHERE issue_id = ?').run(1_000, 1_000, 1_001, expired);

    const anonymous = await viewProject(env, 'polylinedb', 'meganemura/claims');
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Active work'));
    const list = await (await viewProject(env, 'polylinedb', 'meganemura/claims', { 'cf-access-jwt-assertion': token })).text();
    const row = (title: string) => {
      const found = list.split('<li class="quiet-row">').find(part => part.includes(title));
      assert.ok(found, title);
      return found;
    };
    const activeRow = row('Active work');
    assert.ok(activeRow.includes('Lane agent'));
    assert.ok(activeRow.includes('2027-01-01 09:00 JST'));
    assert.ok(!list.includes(activeClaim.session));
    assert.ok(!list.includes(activeClaim.incarnation));
    assert.ok(!list.includes(releasedClaim.session));
    assert.ok(!list.includes(expiredClaim.session));
    assert.ok(!row('Released work').includes('Gone agent'));
    assert.ok(!row('Expired work').includes('Stale agent'));
    assert.ok(row('One block').includes('blocked 1'));
    assert.ok(!row('Only closed').includes('blocked'));

    const detail = await (await viewIssue(env, mixed, { 'cf-access-jwt-assertion': token })).text();
    const openPart = uiSection(detail, 'Active blockers');
    const closedPart = uiSection(detail, 'Closed blockers');
    assert.ok(openPart.includes(`href="/ui/i/${deferredBlocker}"`));
    assert.ok(openPart.includes('deferred'));
    assert.ok(!openPart.includes(closedBlocker));
    assert.ok(closedPart.includes(closedBlocker));
    assert.ok(closedPart.includes('closed'));
    assert.ok(!closedPart.includes(deferredBlocker));
    const single = await (await viewIssue(env, one, { 'cf-access-jwt-assertion': token })).text();
    const singleOpen = uiSection(single, 'Active blockers');
    assert.ok(singleOpen.includes(`href="/ui/i/${openBlocker}"`));
    assert.ok(singleOpen.includes('open'));
    assert.ok(!single.includes(activeClaim.session));
    assert.ok(!single.includes(activeClaim.incarnation));
  } finally { sqlite.close(); }
});

test('pd-137: project filters and a project-scoped closed section replace the store-wide list', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const first = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/filters', body: 'First priority', priority: 0, labels: ['ready'] });
    const second = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/filters', body: 'Second priority', priority: 2, status: 'open' });
    const plain = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/filters', body: 'Plain open' });
    const older = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/filters', body: 'Older close' });
    const newest = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/filters', body: 'Newest close' });
    const foreign = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/other', body: 'Foreign close' });
    const waiting = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/filters', body: 'Waiting for main', labels: ['main-wait'] });
    const stamp = sqlite.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?');
    stamp.run('closed', '2026-10-01T00:00:00.000Z', older);
    stamp.run('closed', '2026-10-03T08:00:00.000Z', newest);
    stamp.run('closed', '2026-10-04T00:00:00.000Z', foreign);

    const home = await (await viewUi(env, auth)).text();
    assert.ok(home.includes('<h1>Projects</h1>'));
    assert.ok(uiSection(home, 'Waiting for main').includes(waiting));
    assert.ok(!home.includes('Foreign close'));
    assert.ok(!home.includes('Newest close'));

    const openPage = await (await viewProject(env, 'polylinedb', 'meganemura/filters', auth)).text();
    const openList = openPage.split('<h2>Recently closed</h2>')[0] ?? '';
    const closedPart = uiSection(openPage, 'Recently closed');
    assert.ok(openList.includes(first));
    assert.ok(openList.includes('Second priority'));
    assert.ok(openList.indexOf('First priority') < openList.indexOf('Second priority'));
    assert.ok(!openList.includes(older));
    assert.ok(!openList.includes('Newest close'));
    assert.ok(closedPart.includes(newest));
    assert.ok(closedPart.includes(older));
    assert.ok(closedPart.indexOf('Newest close') < closedPart.indexOf('Older close'));
    assert.ok(closedPart.includes('Last updated'));
    assert.ok(!closedPart.includes('Foreign close'));
    assert.ok(!openPage.includes('Foreign close'));

    const closedFilter = await (await viewProject(env, 'polylinedb', 'meganemura/filters', auth, 'GET', '?status=closed')).text();
    const closedMain = closedFilter.split('<h2>Recently closed</h2>')[0] ?? '';
    assert.ok(closedMain.includes('Newest close'));
    assert.ok(closedMain.includes('Older close'));
    assert.ok(closedMain.indexOf('Newest close') < closedMain.indexOf('Older close'));
    assert.ok(!closedMain.includes('Plain open'));
    assert.ok(!closedMain.includes(plain));

    const ready = await (await viewProject(env, 'polylinedb', 'meganemura/filters', auth, 'GET', '?label=ready')).text();
    const readyMain = ready.split('<h2>Recently closed</h2>')[0] ?? '';
    assert.ok(readyMain.includes('First priority'));
    assert.ok(!readyMain.includes('Plain open'));
    assert.ok(!readyMain.includes('Second priority'));

    const invalid = await viewProject(env, 'polylinedb', 'meganemura/filters', auth, 'GET', '?status=nope');
    assert.equal(invalid.status, 404);
    assert.ok(!(await invalid.text()).includes('First priority'));
    const anonymous = await viewProject(env, 'polylinedb', 'meganemura/filters', {}, 'GET', '?status=nope');
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('First priority'));
  } finally { sqlite.close(); }
});

test('ui: owner inbox lists owner-decision, owner-action, and main-wait across projects', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const openInbox = () => handleRequest(new Request('https://issues.example/ui/inbox', { headers: auth }), env, authenticate);
  try {
    const decision = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Needs a decision', labels: ['owner-decision'] });
    const action = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Needs an action', status: 'deferred', labels: ['owner-action'] });
    const waiting = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/filters', body: '<img inbox>', labels: ['main-wait', 'ready'] });
    const readyOnly = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Ready only', labels: ['ready'] });
    const closed = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Closed decision', labels: ['owner-decision'] });
    await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ op: 'close', id: closed, expected: 1 }),
    }), env, authenticate);

    const anonymous = await handleRequest(new Request('https://issues.example/ui/inbox'), env, authenticate);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Needs a decision'));
    const home = await (await viewUi(env, auth)).text();
    assert.ok(home.includes('href="/ui/inbox"'));
    const page = await openInbox();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'private, no-cache');
    const html = await page.text();
    assert.ok(html.includes('Needs a decision'));
    assert.ok(html.includes('Needs an action'));
    assert.ok(html.includes('&lt;img inbox&gt;'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes(`href="/ui/i/${decision}"`));
    assert.ok(html.includes(`href="/ui/i/${action}"`));
    assert.ok(html.includes(waiting));
    assert.ok(html.includes('owner-decision'));
    assert.ok(html.includes('owner-action'));
    assert.ok(html.includes('main-wait'));
    assert.ok(html.includes('meganemura/nukadoko'));
    assert.ok(!html.includes('Ready only'));
    assert.ok(!html.includes(readyOnly));
    assert.ok(!html.includes('Closed decision'));
    assertNoApplicationControls(html);
  } finally { sqlite.close(); }
});

test('ui: an owner issue whose first line is only a marker shows its next line as the title', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const action = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: '要対応（owner-action）\nChoose which hosts connect\nDetails follow', labels: ['owner-action'] });
    const decision = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: '# 判断待ち(owner-decision)\n\nPick a cache policy', labels: ['owner-decision'] });
    const part = uiSection(await (await viewUi(env, auth)).text(), 'Waiting on you');
    assert.ok(part.includes(`<a href="/ui/i/${action}">\n<span class="primary">Choose which hosts connect</span>`));
    assert.ok(part.includes(`<a href="/ui/i/${decision}">\n<span class="primary">Pick a cache policy</span>`));
    assert.equal(part.includes('<span class="primary">要対応（owner-action）</span>'), false);
    const page = await (await viewIssue(env, action, auth)).text();
    assert.ok(page.includes('<h1>Choose which hosts connect</h1>'));
    assert.ok(page.includes('<title>Choose which hosts connect'));
    assert.ok(page.includes('要対応（owner-action）\nDetails follow'));
  } finally { sqlite.close(); }
});

test('ui: home lists what waits on the owner above the projects', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const decision = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: '判断待ちの件', labels: ['owner-decision'], priority: 2 });
    const hours = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Needs an action', labels: ['owner-action'], priority: 1 });
    const fresh = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: '<img src=x onerror=alert(1)>', labels: ['owner-action'], priority: 2 });
    const deferred = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Deferred owner work', status: 'deferred', labels: ['owner-decision'] });
    const closed = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Closed owner work', labels: ['owner-decision'] });
    const ready = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Ready only work', labels: ['ready'] });
    const main = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Only waiting for main', labels: ['main-wait'] });
    const now = Date.now();
    const decisionAt = new Date(now - 3.5 * 86400_000).toISOString();
    const hoursAt = new Date(now - 5.5 * 3600_000).toISOString();
    const freshAt = new Date(now).toISOString();
    const stamp = sqlite.prepare('UPDATE issues SET created_at = ?, status = ? WHERE id = ?');
    stamp.run(decisionAt, 'open', decision);
    stamp.run(hoursAt, 'open', hours);
    stamp.run(freshAt, 'open', fresh);
    sqlite.prepare("UPDATE issues SET status = 'closed' WHERE id = ?").run(closed);

    const html = await (await viewUi(env, auth)).text();
    const heading = html.indexOf('<h1>Projects</h1>');
    const waitingOnYou = html.indexOf('<h2>Waiting on you</h2>');
    const projects = html.indexOf('<h2>Projects</h2>');
    const waitingForMain = html.indexOf('<h2>Waiting for main</h2>');
    assert.ok(heading !== -1 && heading < waitingOnYou && waitingOnYou < projects && projects < waitingForMain);
    const part = uiSection(html, 'Waiting on you');
    assert.ok(part.includes('<span class="count">3</span> issues · 1 to decide · 2 to do'));
    assert.equal(part.includes('<span class="count">3+</span>'), false);
    assert.equal(part.includes('More issues are not shown.'), false);
    assert.ok(part.indexOf('<h3>To decide</h3>') < part.indexOf('<h3>To do</h3>'));
    assert.deepEqual([...part.matchAll(/href="\/ui\/i\/(pd-\d+)"/g)].map(match => match[1]), [decision, hours, fresh]);
    assert.ok(part.includes(`<a href="/ui/i/${decision}">\n<span class="primary">判断待ちの件</span>\n<span class="secondary">${decision} · meganemura/polylinedb · <time datetime="${decisionAt}">waiting 3 days</time></span>\n</a>`));
    assert.ok(part.includes('waiting 5 hours'));
    assert.ok(part.includes('waiting under an hour'));
    assert.ok(part.includes('<span class="primary">&lt;img src=x onerror=alert(1)&gt;</span>'));
    assert.equal(part.includes('<img'), false);
    assert.equal(part.includes(deferred), false);
    assert.equal(part.includes('Deferred owner work'), false);
    assert.equal(part.includes(closed), false);
    assert.equal(part.includes('Closed owner work'), false);
    assert.equal(part.includes(ready), false);
    assert.equal(part.includes('Ready only work'), false);
    assert.equal(part.includes(main), false);
    assert.equal(part.includes('Only waiting for main'), false);
    assert.ok(part.includes('<a href="/ui/inbox">Inbox</a> also lists 1 more that is deferred or in progress.'));
    speculationRules(html);
    assertNoApplicationControls(html);
  } finally { sqlite.close(); }
});

test('ui: home marks the owner tally as a lower bound when Attention is capped', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const insert = sqlite.prepare(`INSERT INTO issues(id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, 'polylinedb', 'meganemura/polylinedb', ?, 'open', 'task', ?, '["owner-action"]', ?, 'access:owner', ?, 'access:owner')`);
    insert.run('pd-1', issueSortKey('pd-1'), 'Oldest priority zero', 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    for (let number = 2; number <= 101; number += 1) {
      const id = `pd-${number}`;
      insert.run(id, issueSortKey(id), `Shown ${number}`, 2, '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
    }
    const html = await (await viewUi(env, { 'cf-access-jwt-assertion': token })).text();
    const part = uiSection(html, 'Waiting on you');
    assert.ok(part.includes('<span class="count">100+</span> issues · 0 to decide · 100 to do'));
    assert.ok(part.includes('More issues are not shown.'));
    assert.equal(part.includes('Oldest priority zero'), false);
    assert.equal(part.includes('href="/ui/i/pd-1"'), false);
  } finally { sqlite.close(); }
});

test('ui: search finds an issue by id or by words in the text', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const search = (query: string, headers: Record<string, string> = auth) => handleRequest(new Request(`https://issues.example/ui/search?q=${encodeURIComponent(query)}`, { headers }), env, authenticate);
  try {
    const lantern = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Unique lantern phrase' });
    const other = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Other project work' });
    sqlite.prepare(`INSERT INTO issues(id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, 'polylinedb', 'meganemura/polylinedb', 'Dotted search child', 'open', 'task', 2, '[]', '2026-10-01T00:00:00.000Z', 'access:owner', '2026-10-01T00:00:00.000Z', 'access:owner')`)
      .run('pd-51.6', issueSortKey('pd-51.6'));

    const anonymous = await search('lantern', {});
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Unique lantern phrase'));
    const home = await (await viewUi(env, auth)).text();
    assert.ok(home.includes('href="/ui/search"'));
    const blank = await (await handleRequest(new Request('https://issues.example/ui/search', { headers: auth }), env, authenticate)).text();
    assert.ok(blank.includes('Type an issue id or words from the text.'));
    assert.ok(blank.includes('<form method="get" action="/ui/search">'));
    assert.ok(!blank.includes('method="post"'));
    speculationRules(blank);

    const byWords = await (await search('lantern')).text();
    assert.ok(byWords.includes('Unique lantern phrase'));
    assert.ok(byWords.includes(`href="/ui/i/${lantern}"`));
    assert.ok(!byWords.includes('Other project work'));
    assert.ok(!byWords.includes(other));
    const byId = await (await search('pd-51.6')).text();
    assert.ok(byId.includes('Dotted search child'));
    assert.ok(byId.includes('href="/ui/i/pd-51.6"'));
    const hostile = await (await search('<img src=x>')).text();
    assert.ok(hostile.includes('&lt;img src=x&gt;'));
    assert.ok(!hostile.includes('<img'));
    const missing = await (await search('pd-999')).text();
    assert.ok(missing.includes('Nothing matches.'));
    assert.ok(!missing.includes('Unique lantern phrase'));
  } finally { sqlite.close(); }
});

test('ui: working now lists active claims and hides released ones', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const post = async (body: unknown) => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
    }), env, authenticate);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    const active = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Lane is here' });
    const released = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Gone from the list' });
    const claim = async (issueId: string, agentLabel: string) => {
      const shown = await post({ op: 'claim_show', issue_id: issueId });
      const session = crypto.randomUUID();
      const receipt = (await post({ op: 'claim_acquire', issue_id: issueId, incarnation: shown.claim.store_incarnation, session_id: session, request_id: crypto.randomUUID(), agent_label: agentLabel })).claim_receipt;
      return { session, incarnation: shown.claim.store_incarnation, receipt };
    };
    const activeClaim = await claim(active, 'Lane agent');
    const releasedClaim = await claim(released, 'Gone agent');
    await post({ op: 'claim_release', claim_proof: { issue_id: released, incarnation: releasedClaim.receipt.incarnation, session_id: releasedClaim.receipt.session_id, generation: releasedClaim.receipt.generation }, expected_revision: releasedClaim.receipt.revision, request_id: crypto.randomUUID() });
    const until = Math.floor(Date.parse('2027-01-01T00:00:00.000Z') / 1000);
    sqlite.prepare('UPDATE issue_claims SET expires_at = ? WHERE issue_id = ?').run(until, active);

    const anonymous = await handleRequest(new Request('https://issues.example/ui/working'), env, authenticate);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Lane is here'));
    const home = await (await viewUi(env, auth)).text();
    assert.ok(home.includes('href="/ui/working"'));
    const html = await (await handleRequest(new Request('https://issues.example/ui/working', { headers: auth }), env, authenticate)).text();
    assert.ok(html.includes('Lane is here'));
    assert.ok(html.includes('Lane agent'));
    assert.ok(html.includes('2027-01-01 09:00 JST'));
    assert.ok(html.includes(`href="/ui/i/${active}"`));
    assert.ok(!html.includes('Gone agent'));
    assert.ok(!html.includes('Gone from the list'));
    assert.ok(!html.includes(activeClaim.session));
    assert.ok(!html.includes(activeClaim.incarnation));
    assert.ok(!html.includes(releasedClaim.session));
    assertNoApplicationControls(html);
  } finally { sqlite.close(); }
});

test('ui: working now lists started non-epic issues without an active claim in their own section', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const post = async (body: unknown) => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
    }), env, authenticate);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const working = async () => (await handleRequest(new Request('https://issues.example/ui/working', { headers: auth }), env, authenticate)).text();
  try {
    assert.ok(uiSection(await working(), 'Started without an active claim').includes('<p class="quiet-note">Every started issue has an active claim.</p>'));
    const start = async (body: string) => {
      const id = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body });
      const shown = await post({ op: 'claim_show', issue_id: id });
      const session_id = crypto.randomUUID();
      const receipt = (await post({ op: 'claim_acquire', issue_id: id, incarnation: shown.claim.store_incarnation, session_id, request_id: crypto.randomUUID() })).claim_receipt;
      const claim_proof = { issue_id: id, incarnation: receipt.incarnation, session_id, generation: receipt.generation };
      await post({ op: 'update', id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }], claim_proof });
      return { id, claim_proof };
    };
    const held = await start('Still held');
    const released = await start('Released lane');
    await post({ op: 'claim_release', claim_proof: released.claim_proof, expected_revision: 1, request_id: crypto.randomUUID() });
    const expired = await start('Expired lane');
    sqlite.prepare('UPDATE issue_claims SET acquired_at = acquired_at - 1000, changed_at = changed_at - 1000, expires_at = acquired_at - 999 WHERE issue_id = ?').run(expired.id);
    const epic = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Epic in progress', type: 'epic', status: 'in_progress' });
    const open = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Never started' });

    const html = await working();
    const stale = uiSection(html, 'Started without an active claim');
    assert.ok(stale.startsWith('Started without an active claim</h2>\n<p class="section-note">Issues in progress, other than epics, whose claim was released, expired, or never acquired.</p>'));
    assert.deepEqual([...stale.matchAll(/href="\/ui\/i\/([^"]+)"/g)].map(match => match[1]), [released.id, expired.id]);
    assert.ok(stale.includes(`<span class="primary">Released lane</span>\n<span class="secondary">${released.id}</span>\n<span class="secondary">in_progress</span>\n<span class="secondary">meganemura/polylinedb</span>`));
    for (const absent of [held.id, epic, open]) assert.ok(!stale.includes(`href="/ui/i/${absent}"`), absent);
    assert.ok(html.split('<h2>')[0]?.includes(`href="/ui/i/${held.id}"`));
    assertNoApplicationControls(html);
  } finally { sqlite.close(); }
});

test('ui: blocked lists unfinished issues that still have an open blocker', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const post = async (body: unknown) => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
    }), env, authenticate);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    const stuck = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Stuck on two' });
    const deferredOnly = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Stuck on a deferral' });
    const clear = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Only a closed blocker' });
    const openA = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Open blocker A' });
    const openB = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Open blocker B' });
    const deferred = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Deferred blocker' });
    const closed = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Finished blocker' });
    await post({ op: 'update', id: deferred, changes: [{ field: 'status', value: 'deferred', expected: 1 }] });
    await post({ op: 'close', id: closed, expected: 1 });
    await post({ op: 'dependency_add', dependent_id: stuck, blocker_id: openA, expected_revision: 1, request_id: crypto.randomUUID() });
    await post({ op: 'dependency_add', dependent_id: stuck, blocker_id: openB, expected_revision: 2, request_id: crypto.randomUUID() });
    await post({ op: 'dependency_add', dependent_id: deferredOnly, blocker_id: deferred, expected_revision: 1, request_id: crypto.randomUUID() });
    await post({ op: 'dependency_add', dependent_id: clear, blocker_id: closed, expected_revision: 1, request_id: crypto.randomUUID() });

    const anonymous = await handleRequest(new Request('https://issues.example/ui/blocked'), env, authenticate);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Stuck on two'));
    const home = await (await viewUi(env, auth)).text();
    assert.ok(home.includes('href="/ui/blocked"'));
    const html = await (await handleRequest(new Request('https://issues.example/ui/blocked', { headers: auth }), env, authenticate)).text();
    assert.ok(html.includes('Stuck on two'));
    assert.ok(html.includes('blocked 2'));
    assert.ok(html.includes('Stuck on a deferral'));
    assert.ok(html.includes('blocked 1'));
    assert.ok(html.includes(`href="/ui/i/${stuck}"`));
    assert.ok(!html.includes('Only a closed blocker'));
    assert.ok(html.indexOf('Stuck on two') < html.indexOf('Stuck on a deferral'));
    assertNoApplicationControls(html);
  } finally { sqlite.close(); }
});

test('ui: recent updates lists the newest changes, open and closed', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const older = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Older update' });
    const newest = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/nukadoko', body: 'Newest update' });
    const closed = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/other', body: 'Closed update' });
    const stamp = sqlite.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?');
    stamp.run('open', '2026-10-01T00:00:00.000Z', older);
    stamp.run('closed', '2026-10-02T00:00:00.000Z', closed);
    stamp.run('open', '2026-10-03T01:00:00.000Z', newest);
    const anonymous = await handleRequest(new Request('https://issues.example/ui/recent'), env, authenticate);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Newest update'));
    const home = await (await viewUi(env, auth)).text();
    assert.ok(home.includes('href="/ui/recent"'));
    const html = await (await handleRequest(new Request('https://issues.example/ui/recent', { headers: auth }), env, authenticate)).text();
    assert.ok(html.includes('Newest update'));
    assert.ok(html.includes('Closed update'));
    assert.ok(html.includes('Older update'));
    assert.ok(html.indexOf('Newest update') < html.indexOf('Closed update'));
    assert.ok(html.indexOf('Closed update') < html.indexOf('Older update'));
    assert.ok(html.includes('2026-10-03 10:00 JST'));
    assert.ok(html.includes('<span class="secondary">closed</span>'));
    assert.ok(html.includes('meganemura/nukadoko'));
    assertNoApplicationControls(html);
  } finally { sqlite.close(); }
});

test('ui: activity lists comments, claims, and status changes newest first, and an after link lists only later events', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const operate = async (body: Record<string, unknown>) => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
    }), env, authenticate);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const page = async (path: string) => {
    const response = await handleRequest(new Request(`https://issues.example${path}`, { headers: auth }), env, authenticate);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    return response.text();
  };
  const rows = (html: string) => [...html.matchAll(/<li class="quiet-row"><a href="\/ui\/i\/([^"]+)">\n<span class="primary">[^<]*<\/span>\n<span class="secondary">([^<]*) · /g)].map(match => `${match[2]} ${match[1]}`);
  try {
    const commented = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Commented work' });
    const claimed = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/other', body: 'Claimed work' });
    const changed = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Changed work' });
    const anonymous = await handleRequest(new Request('https://issues.example/ui/activity'), env, authenticate);
    assert.equal(anonymous.status, 401);
    const first = await page('/ui/activity');
    const resume = first.match(/href="(\/ui\/activity\?after=\d+&amp;incarnation=[a-f0-9]{32})"/)?.[1]?.replace('&amp;', '&');
    assert.ok(resume, first);
    const before = sqlite.prepare('SELECT updated_at FROM issues WHERE id = ?').get(commented);
    await operate({ op: 'comment', id: commented, body: 'tip: 1234567\nrest of the note' });
    assert.deepEqual(sqlite.prepare('SELECT updated_at FROM issues WHERE id = ?').get(commented), before);
    const incarnation = (await operate({ op: 'claim_show', issue_id: claimed })).claim.store_incarnation;
    const proof = { issue_id: claimed, incarnation, session_id: crypto.randomUUID(), generation: 1 };
    await operate({ op: 'claim_acquire', issue_id: claimed, incarnation, session_id: proof.session_id, request_id: crypto.randomUUID(), agent_label: 'lane-a', ttl: 600 });
    await operate({ op: 'claim_release', claim_proof: proof, expected_revision: 1, request_id: crypto.randomUUID() });
    await operate({ op: 'update', id: changed, changes: [{ field: 'status', value: 'deferred', expected: 1 }] });

    const html = await page('/ui/activity');
    assert.ok((await viewUi(env, auth).then(response => response.text())).includes('href="/ui/activity"'));
    assert.deepEqual(rows(html).slice(0, 7), [
      `Status changed ${changed}`, `Released ${claimed}`, `Claimed ${claimed}`, `Commented ${commented}`,
      `Created ${changed}`, `Created ${claimed}`, `Created ${commented}`,
    ]);
    assert.ok(html.includes(`<span class="primary">Commented work</span>\n<span class="secondary">Commented · ${commented}</span>\n<span class="secondary">meganemura/polylinedb</span>`));
    assert.match(html, /<span class="secondary"><time datetime="[^"]+">\d{4}-\d{2}-\d{2} \d{2}:\d{2} JST<\/time><\/span>/);
    assert.ok(html.includes('<span class="secondary">access:owner</span>'));
    assertNoApplicationControls(html);

    const later = await page(resume);
    assert.deepEqual(rows(later), [`Commented ${commented}`, `Claimed ${claimed}`, `Released ${claimed}`, `Status changed ${changed}`]);
    assertNoApplicationControls(later);

    const foreign = await page(resume.replace(/incarnation=[a-f0-9]{32}/, `incarnation=${'0'.repeat(32)}`));
    assert.ok(foreign.includes('<p class="quiet-note">This activity link is from another store. Start again from the latest activity.</p>'));
    assert.ok(foreign.includes('<a href="/ui/activity">Latest activity</a>'));
    sqlite.prepare('DELETE FROM change_events WHERE seq <= ?').run(Number(resume.match(/after=(\d+)/)?.[1]) + 1);
    const stale = await page(resume);
    assert.ok(stale.includes('<p class="quiet-note">Some events after this link were removed. Start again from the latest activity.</p>'));
    const trimmed = await page('/ui/activity');
    assert.deepEqual(rows(trimmed).slice(0, 2), [`Status changed ${changed}`, `Released ${claimed}`]);
    for (const path of ['/ui/activity?after=x', '/ui/activity?after=1', '/ui/activity?after=999999&incarnation=' + incarnation]) {
      const invalid = await page(path);
      assert.ok(invalid.includes('<p class="quiet-note">This activity link is not valid. Start again from the latest activity.</p>'), path);
    }
  } finally { sqlite.close(); }
});

test('ui: projects are ordered by their latest issue update, newest first, with ties by project name', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const stale = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/alpha', body: 'Alpha stale' });
    const fresh = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/alpha', body: 'Alpha fresh' });
    const closed = await createIssue(env, token, { tool: 'nukadoko', project: 'meganemura/beta', body: 'Beta closed' });
    const gamma = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/gamma', body: 'Gamma' });
    const tieByTool = await createIssue(env, token, { tool: 'alpha', project: 'meganemura/tie-b', body: 'Tie by tool' });
    const tieByProject = await createIssue(env, token, { tool: 'zeta', project: 'meganemura/tie-a', body: 'Tie by project' });
    const stamp = sqlite.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?');
    stamp.run('open', '2026-10-01T00:00:00.000Z', stale);
    stamp.run('open', '2026-10-05T06:40:00.000Z', fresh);
    stamp.run('closed', '2026-10-08T00:00:00.000Z', closed);
    stamp.run('open', '2026-10-03T00:00:00.000Z', gamma);
    stamp.run('open', '2026-10-02T00:00:00.000Z', tieByTool);
    stamp.run('open', '2026-10-02T00:00:00.000Z', tieByProject);

    const anonymous = await viewUi(env);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('meganemura/alpha'));
    const projects = uiSection(await (await viewUi(env, auth)).text(), 'Projects');
    assert.deepEqual([...projects.matchAll(/href="([^"]+)"/g)].map(match => match[1]), [
      projectPath('nukadoko', 'meganemura/beta'),
      projectPath('polylinedb', 'meganemura/alpha'),
      projectPath('polylinedb', 'meganemura/gamma'),
      projectPath('zeta', 'meganemura/tie-a'),
      projectPath('alpha', 'meganemura/tie-b'),
    ]);
    const alphaRow = projects.split('<li class="quiet-row">').find(part => part.includes('meganemura/alpha'));
    assert.ok(alphaRow);
    assert.ok(alphaRow.includes('<span class="secondary">Updated <time datetime="2026-10-05T06:40:00.000Z">2026-10-05 15:40 JST</time></span>'));
    assert.ok(projects.includes('Updated <time datetime="2026-10-08T00:00:00.000Z">2026-10-08 09:00 JST</time>'));
    assert.ok(!/<(form|input|button|script)\b/.test(projects));
  } finally { sqlite.close(); }
});

test('ui: project filter chips link to a status or a label', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Chip ready', labels: ['ready'], status: 'open' });
    await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Chip started', status: 'in_progress' });
    const path = projectPath('polylinedb', 'meganemura/polylinedb');
    const open = await (await viewProject(env, 'polylinedb', 'meganemura/polylinedb', auth)).text();
    assert.ok(open.includes('class="filter-rail filter-state"'));
    assert.ok(open.includes('class="filter-rail filter-mark"'));
    assert.ok(open.includes('One status at a time'));
    assert.ok(open.includes('A label, not a status'));
    assert.ok(open.includes('aria-label="State"'));
    assert.ok(open.includes('aria-label="Mark"'));
    assert.ok(open.includes('<nav class="segment"'));
    assert.ok(open.includes('<nav class="stamps"'));
    assert.ok(open.includes(`href="${path}?status=open"`));
    assert.ok(open.includes(`href="${path}?label=ready"`));
    assert.ok(open.includes(`href="${path}" aria-current="page"`));
    const started = await (await viewProject(env, 'polylinedb', 'meganemura/polylinedb', auth, 'GET', '?status=in_progress')).text();
    assert.ok(started.includes(`href="${path}?status=in_progress" aria-current="page"`));
    assert.ok(started.includes('Chip started'));
    assert.ok(!started.split('<h2>Recently closed</h2>')[0]?.includes('Chip ready'));
    const ready = await (await viewProject(env, 'polylinedb', 'meganemura/polylinedb', auth, 'GET', '?label=ready')).text();
    assert.ok(ready.includes(`href="${path}?label=ready" aria-current="page"`));
    assert.ok(ready.includes('Chip ready'));
    assert.ok(!ready.split('<h2>Recently closed</h2>')[0]?.includes('Chip started'));
    assertNoApplicationControls(ready);
  } finally { sqlite.close(); }
});

test('ui: a cross-document view transition is css and stays off when motion is reduced', async () => {
  const { sqlite, env } = fixture();
  try {
    const html = await (await viewUi(env, { 'cf-access-jwt-assertion': await assertion() })).text();
    assert.match(html, /@media \(prefers-reduced-motion: no-preference\) \{\s*@view-transition \{ navigation: auto; \}/);
    assert.ok(html.includes('::view-transition-group(root)'));
    assert.ok(html.includes('::view-transition-image-pair(root)'));
    assert.ok(html.includes('animation-duration: 80ms'));
    assert.equal(html.includes('pointer-events'), false);
    assertNoApplicationControls(html);
  } finally { sqlite.close(); }
});

test('ui: night theme follows the phone color scheme and the page widens on a desktop', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Night title', status: 'open' });
    const anonymous = await handleRequest(new Request('https://issues.example/ui'), env, authenticate);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Night title'));
    const html = await (await viewUi(env, auth)).text();
    assert.ok(html.includes('@media (prefers-color-scheme: dark)'));
    assert.ok(html.includes('color-scheme: dark'));
    assert.ok(html.includes('--ink: #f3ece3'));
    assert.ok(html.includes('--paper: #1c1916'));
    assert.ok(html.includes('min(100%, 720px)'));
    assert.ok(html.includes('@media (max-width: 420px)'));
    assert.ok(html.includes('content="#1c1916" media="(prefers-color-scheme: dark)"'));
    assert.ok(html.includes('<h1>Projects</h1>'));
    assertNoApplicationControls(html);
    const project = await (await viewProject(env, 'polylinedb', 'meganemura/polylinedb', auth)).text();
    assert.ok(project.includes('Night title'));
    assert.ok(project.includes('<span class="secondary">open</span>'));
    assert.ok(project.includes('@media (prefers-color-scheme: dark)'));
  } finally { sqlite.close(); }
});

test('ui: an epic lists its children and a child links back to the parent', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const epic = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Tree epic', type: 'epic' });
    const first = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'First child', parent: epic, type: 'task' });
    const hostile = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: '<img src=x onerror=alert(1)>', parent: epic, type: 'task' });
    const leaf = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Unrelated leaf' });
    sqlite.prepare('UPDATE issues SET status = ? WHERE id = ?').run('closed', first);
    const fat = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Fat epic', type: 'epic' });
    const insert = sqlite.prepare(`INSERT INTO issues(id, parent_id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, 'polylinedb', 'meganemura/polylinedb', ?, 'open', 'task', 0, '[]', '2026-10-01T00:00:00.000Z', 'access:owner', '2026-10-01T00:00:00.000Z', 'access:owner')`);
    for (let number = 1; number <= 101; number += 1) {
      const id = `${fat}.${number}`;
      insert.run(id, fat, issueSortKey(id), `Packed child ${number}`);
    }

    const anonymous = await viewIssue(env, epic);
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes('Tree epic'));

    const epicHtml = await (await viewIssue(env, epic, auth)).text();
    const children = uiSection(epicHtml, 'Children');
    assert.ok(children.includes('First child'));
    assert.ok(children.includes(`href="/ui/i/${first}"`));
    assert.ok(children.includes('<span class="secondary">closed</span>'));
    assert.ok(children.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(children.includes(`href="/ui/i/${hostile}"`));
    assert.ok(!children.includes('<img'));
    assert.ok(children.indexOf('First child') < children.indexOf('&lt;img'));
    assert.ok(!epicHtml.includes('>Parent <'));
    assert.ok(!epicHtml.includes('Unrelated leaf'));
    assertNoApplicationControls(epicHtml);

    const childHtml = await (await viewIssue(env, first, auth)).text();
    assert.ok(childHtml.includes(`Parent <a href="/ui/i/${epic}">Tree epic</a>`));
    assert.ok(uiSection(childHtml, 'Children').includes('No children.'));
    const leafHtml = await (await viewIssue(env, leaf, auth)).text();
    assert.ok(!leafHtml.includes('>Parent <'));
    assert.ok(uiSection(leafHtml, 'Children').includes('No children.'));

    const fatHtml = await (await viewIssue(env, fat, auth)).text();
    const packed = uiSection(fatHtml, 'Children');
    assert.ok(packed.includes('More issues are not shown.'));
    assert.ok(packed.includes('Packed child 1'));
    assert.ok(packed.includes('Packed child 100'));
    assert.ok(!packed.includes('Packed child 101'));
    assert.ok(packed.indexOf('Packed child 1') < packed.indexOf('Packed child 2'));
    assert.ok(packed.indexOf('Packed child 2') < packed.indexOf('Packed child 10'));
  } finally { sqlite.close(); }
});

test('pd-144: /ui orders projects by their latest issue update', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const insert = sqlite.prepare(`INSERT INTO issues(id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 'open', 'task', 0, '[]', '2026-09-01T00:00:00.000Z', 'access:owner', ?, 'access:owner')`);
    insert.run('pd-1', issueSortKey('pd-1'), 'order', 'alpha', 'pd-1', '2026-10-09T03:00:00.000Z');
    insert.run('pd-2', issueSortKey('pd-2'), 'order', 'alpha', 'pd-2', '2026-10-08T00:00:00.000Z');
    insert.run('pd-3', issueSortKey('pd-3'), 'order', 'bravo', 'pd-3', '2026-10-10T06:40:00.000Z');
    insert.run('pd-4', issueSortKey('pd-4'), 'order', 'charlie', 'pd-4', '2026-10-07T00:00:00.000Z');
    insert.run('pd-6', issueSortKey('pd-6'), 'aa-tool', 'echo', 'pd-6', '2026-10-01T00:00:00.000Z');
    insert.run('pd-5', issueSortKey('pd-5'), 'zz-tool', 'delta', 'pd-5', '2026-10-01T00:00:00.000Z');
    insert.run('pd-7', issueSortKey('pd-7'), 'b-tool', 'shared', 'pd-7', '2026-09-30T00:00:00.000Z');
    insert.run('pd-8', issueSortKey('pd-8'), 'a-tool', 'shared', 'pd-8', '2026-09-30T00:00:00.000Z');
    const home = await viewUi(env, { 'cf-access-jwt-assertion': token });
    assert.equal(home.status, 200);
    const html = await home.text();
    const projects = uiSection(html, 'Projects');
    assert.deepEqual([...projects.matchAll(/href="\/ui\/p\/([^"]+)"/g)].map(match => match[1]), [
      'order/bravo', 'order/alpha', 'order/charlie', 'zz-tool/delta', 'aa-tool/echo', 'a-tool/shared', 'b-tool/shared',
    ]);
    const bravo = projects.split('<li class="quiet-row">').find(part => part.includes('href="/ui/p/order/bravo"'));
    assert.ok(bravo);
    assert.ok(bravo.includes('Updated <time datetime="2026-10-10T06:40:00.000Z">2026-10-10 15:40 JST</time>'));
    assert.ok(bravo.replace(/<[^>]+>/g, '').includes('Updated 2026-10-10 15:40 JST'));
    const alpha = projects.split('<li class="quiet-row">').find(part => part.includes('href="/ui/p/order/alpha"'));
    assert.ok(alpha);
    assert.ok(alpha.includes('2026-10-09 12:00 JST'));
    assert.ok(!alpha.includes('2026-10-08 09:00 JST'));
    assertNoApplicationControls(html);
  } finally { sqlite.close(); }
});

test('pd-144: the project cap keeps the most recently updated projects', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const insert = sqlite.prepare(`INSERT INTO issues(id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 'open', 'task', 0, '[]', '2026-10-01T00:00:00.000Z', 'access:owner', ?, 'access:owner')`);
    for (let number = 0; number <= 200; number += 1) {
      const id = `pd-${number + 1}`;
      insert.run(id, issueSortKey(id), 'cap', `p${String(number).padStart(3, '0')}`, `Project ${number}`, '2026-10-01T00:00:00.000Z');
    }
    insert.run('pd-202', issueSortKey('pd-202'), 'cap', 'zzz', 'Newest', '2026-10-02T00:00:00.000Z');
    const home = await (await viewUi(env, { 'cf-access-jwt-assertion': token })).text();
    const projects = uiSection(home, 'Projects');
    assert.ok(projects.includes('More projects are not shown.'));
    assert.equal([...projects.matchAll(/href="\/ui\/p\/([^"]+)"/g)][0]?.[1], 'cap/zzz');
    assert.ok(home.includes('p000'));
    assert.ok(!home.includes('p199'));
    assert.ok(!home.includes('p200'));
  } finally { sqlite.close(); }
});

test('pd-144: a project update time is escaped', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const updatedAt = '"><img';
    sqlite.prepare(`INSERT INTO issues(id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 'open', 'task', 0, '[]', '2026-10-01T00:00:00.000Z', 'access:owner', ?, 'access:owner')`)
      .run('pd-1', issueSortKey('pd-1'), 'wire', 'marked', 'Marked time', updatedAt);
    const projects = uiSection(await (await viewUi(env, { 'cf-access-jwt-assertion': token })).text(), 'Projects');
    assert.ok(projects.includes('datetime="&quot;&gt;&lt;img"'));
    assert.ok(!projects.includes('<img'));
  } finally { sqlite.close(); }
});

const webhookUrl = 'https://fixture.invalid/dispatch';
const webhookKey = 'test-sender-key';
const dispatchOpenedAt = 1_791_700_000_000;
const dispatchActors = JSON.stringify(['access:owner', { actor: 'access:viewer', role: 'reader' }, { actor: 'service:robot', role: 'agent' }, 'service:bot']);

function withWebhook(env: ReturnType<typeof fixture>['env'], secrets: {
  POLYLINEDB_DISPATCH_WEBHOOK_URL?: string;
  POLYLINEDB_DISPATCH_WEBHOOK_KEY?: string;
} = { POLYLINEDB_DISPATCH_WEBHOOK_URL: webhookUrl, POLYLINEDB_DISPATCH_WEBHOOK_KEY: webhookKey }, origins = '[]') {
  return { ...env, ALLOWED_ORIGINS: origins, ...secrets };
}

type ReceivedPost = { url: string; authorization: string | null; contentType: string | null; redirect: RequestRedirect | undefined; body: string };

function fixtureReceiver(replies: readonly (number | 'throw')[] = []) {
  const posts: ReceivedPost[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    posts.push({
      url,
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      redirect: init?.redirect,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const reply = replies[index] ?? 204;
    index += 1;
    if (reply === 'throw') throw new Error('fixture network failure');
    return new Response(null, { status: reply });
  };
  return { fetch: fetchImpl, posts };
}

function pressDispatch(env: ReturnType<typeof fixture>['env'], id: string, token: string | null, dispatcher: ReturnType<typeof createDispatcher>, init: {
  origin?: string; body?: string; contentType?: string; method?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (token !== null) headers['cf-access-jwt-assertion'] = token;
  if (init.origin !== undefined) headers.origin = init.origin;
  if (init.contentType !== undefined) headers['content-type'] = init.contentType;
  return handleRequest(new Request(`https://issues.example/ui/i/${encodeURIComponent(id)}/dispatch`, {
    method: init.method ?? 'POST',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  }), env, authenticate, dispatcher);
}

function browserPress() {
  return { origin: 'https://issues.example', body: '', contentType: 'application/x-www-form-urlencoded' };
}

function storedIssue(sqlite: DatabaseSync, id: string) {
  return sqlite.prepare('SELECT * FROM issues WHERE id = ?').get(id);
}

async function assertOutcome(response: Response, status: number, sentence: string, id: string): Promise<string> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'private, no-cache');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('server-timing'), null);
  const html = await response.text();
  assert.ok(html.includes(`<p>${sentence}</p>`), html);
  assert.ok(html.includes(`<a href="/ui/i/${id}">${id}</a>`));
  assert.equal(html.includes('<button'), false);
  assert.equal(/<input\b/.test(html), false);
  assertNoApplicationControls(html);
  return html;
}

function assertWebhook(post: ReceivedPost, id: string, now: number, notes?: string): void {
  assert.equal(post.url, webhookUrl);
  assert.equal(post.authorization, `Bearer ${webhookKey}`);
  assert.equal(post.contentType, 'application/json');
  assert.equal(post.redirect, 'manual');
  const body = JSON.parse(post.body) as Record<string, unknown>;
  assert.equal(Object.hasOwn(body, 'notes'), notes !== undefined);
  assert.deepEqual(body, {
    intent: 'dispatch', project: 'compiler/parser', issue_id: id, event_id: body.event_id,
    idempotency_key: `${id}:dispatch`, occurred_at: Math.floor(now / 1000),
    ...(notes === undefined ? {} : { notes }),
  });
  assert.match(String(body.event_id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(Number.isInteger(body.occurred_at), true);
}

test('ui: Waiting for main links, Working shows ids, and Dispatch has notes and a start summary', async () => {
  const { env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const configured = withWebhook(env);
  const operate = async (body: Record<string, unknown>) => {
    const response = await handleRequest(new Request('https://issues.example/v1/operations', {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
    }), env, authenticate);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const make = (body: string, labels: string[]) => createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body, labels });
  const waiting = await make('Landing soon', ['main-wait']);
  const ready = await make('Ready work', ['ready']);
  const blocker = await make('Blocker', []);
  const blocked = await make('Blocked work', ['ready']);
  const claimed = await make('Claimed work', ['ready']);
  const owner = await make('Owner decision', ['owner-decision']);
  await operate({ op: 'dependency_add', dependent_id: blocked, blocker_id: blocker, expected_revision: 1, request_id: crypto.randomUUID() });
  const incarnation = (await operate({ op: 'claim_show', issue_id: claimed })).claim.store_incarnation;
  await operate({ op: 'claim_acquire', issue_id: claimed, incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'lane-a', ttl: 3600 });

  const home = uiSection(await (await viewUi(env, auth)).text(), 'Waiting for main');
  assert.ok(home.includes(`<li class="quiet-row"><a href="/ui/i/${waiting}">\n<span class="primary">Landing soon</span>`));
  const working = await (await handleRequest(new Request('https://issues.example/ui/working', { headers: auth }), env, authenticate)).text();
  assert.ok(working.includes(`<span class="secondary">${claimed} · meganemura/polylinedb</span>`));

  const summary = async (id: string) => {
    const page = await (await viewIssue(configured, id, auth)).text();
    const form = page.match(/<form method="post"[\s\S]*?<\/form>/)?.[0] ?? '';
    assert.ok(form.includes('<label for="dispatch-notes">Notes for the agent (optional)</label>'), id);
    assert.ok(form.includes(notesField), id);
    return form.match(/<p class="secondary">([^<]*)<\/p>/)?.[1];
  };
  assert.equal(await summary(ready), 'ready · no blockers · not claimed · can start now');
  assert.equal(await summary(blocked), 'ready · blocked 1 · not claimed · will not start now');
  assert.match(await summary(claimed) ?? '', /^ready · no blockers · claimed by lane-a until \d{4}-\d{2}-\d{2} \d{2}:\d{2} JST · will not start now$/);
  assert.equal(await summary(owner), 'owner wait, not agent work · not ready · no blockers · not claimed · will not start now');
  // iOS zooms into a focused field under 16px, and Apple's touch target guidance is at least 44pt.
  const styles = (await (await viewIssue(configured, ready, auth)).text()).match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert.match(styles, /\.dispatch textarea \{[^}]*\bfont-size: 16px;/);
  assert.match(styles, /\.dispatch button \{[^}]*\bmin-height: 48px;/);
  const hidden = await (await viewIssue(env, ready, { 'cf-access-jwt-assertion': await assertion({ sub: 'viewer' }) })).text();
  assert.equal(hidden.includes('name="notes"'), false);
});

test('ui: a ready Dispatch form carries the in-place script and a result area; unset, reader, and other pages do not', async () => {
  const { sqlite, env } = fixture('["access:owner",{"actor":"access:viewer","role":"reader"}]');
  const token = await assertion();
  try {
    const id = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'In place' });
    const ready = await viewIssue(withWebhook(env), id, { 'cf-access-jwt-assertion': token });
    const html = await ready.text();
    assert.ok(html.includes(`<output class="dispatch-result" role="status" aria-live="polite"></output></form>\n<script>${dispatchScript}</script>`));
    const hash = createHash('sha256').update(dispatchScript).digest('base64');
    assert.ok((ready.headers.get('content-security-policy') ?? '').includes(`'sha256-${hash}'; connect-src 'self';`));
    assert.equal(ready.headers.get('content-security-policy'), uiPolicy(html));
    for (const page of [
      await (await viewIssue(env, id, { 'cf-access-jwt-assertion': token })).text(),
      await (await viewIssue(withWebhook(env), id, { 'cf-access-jwt-assertion': await assertion({ sub: 'viewer' }) })).text(),
      await (await viewUi(withWebhook(env), { 'cf-access-jwt-assertion': token })).text(),
    ]) {
      assert.equal(page.includes(dispatchScript), false);
      assert.equal(page.includes('<output'), false);
    }
  } finally { sqlite.close(); }
});

test('dispatch module exports only the factory and the secret names', () => {
  assert.deepEqual(Object.keys(dispatchModule).sort(), ['createDispatcher', 'dispatchSecretNames']);
  assert.deepEqual(dispatchSecretNames, ['POLYLINEDB_DISPATCH_WEBHOOK_URL', 'POLYLINEDB_DISPATCH_WEBHOOK_KEY']);
});

test('dispatch: no JWT, and actors who cannot press, get no webhook', async () => {
  const { sqlite, env } = fixture(dispatchActors);
  const owner = await assertion();
  const configured = withWebhook(env);
  const receiver = fixtureReceiver();
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => dispatchOpenedAt });
  try {
    const id = await createIssue(env, owner, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const anonymous = await pressDispatch(configured, id, null, dispatcher, browserPress());
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('content-type'), 'application/json');
    assert.deepEqual(await anonymous.json(), { error: { code: 'invalid_assertion', message: 'Authentication required' } });
    const denied = [
      ['reader', await assertion({ sub: 'viewer' })],
      ['agent', await assertion({ sub: '', common_name: 'robot' })],
      ['service human', await assertion({ sub: '', common_name: 'bot' })],
    ] as const;
    for (const [role, token] of denied) {
      const page = await viewIssue(configured, id, { 'cf-access-jwt-assertion': token });
      assert.equal(page.status, 200, role);
      const html = await page.text();
      assert.equal(html.includes('<form'), false, role);
      assert.equal(html.includes('<button'), false, role);
      assert.equal(html.includes('Dispatch'), false, role);
      const response = await pressDispatch(configured, id, token, dispatcher, browserPress());
      await assertOutcome(response, 403, 'Dispatch is not available for this actor.', id);
    }
    assert.equal(receiver.posts.length, 0);
    assert.deepEqual(storedIssue(sqlite, id), before);
  } finally { sqlite.close(); }
});

test('dispatch: unset or invalid secrets show a disabled button and do not fetch', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const receiver = fixtureReceiver();
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => dispatchOpenedAt });
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const secrets = [
      {},
      { POLYLINEDB_DISPATCH_WEBHOOK_URL: '', POLYLINEDB_DISPATCH_WEBHOOK_KEY: webhookKey },
      { POLYLINEDB_DISPATCH_WEBHOOK_URL: '   ', POLYLINEDB_DISPATCH_WEBHOOK_KEY: webhookKey },
      { POLYLINEDB_DISPATCH_WEBHOOK_URL: webhookUrl, POLYLINEDB_DISPATCH_WEBHOOK_KEY: '' },
      { POLYLINEDB_DISPATCH_WEBHOOK_URL: webhookUrl, POLYLINEDB_DISPATCH_WEBHOOK_KEY: '   ' },
      { POLYLINEDB_DISPATCH_WEBHOOK_URL: webhookUrl, POLYLINEDB_DISPATCH_WEBHOOK_KEY: 'has space' },
      { POLYLINEDB_DISPATCH_WEBHOOK_URL: 'http://fixture.invalid/dispatch', POLYLINEDB_DISPATCH_WEBHOOK_KEY: webhookKey },
      { POLYLINEDB_DISPATCH_WEBHOOK_URL: 'https://user:pass@fixture.invalid/dispatch', POLYLINEDB_DISPATCH_WEBHOOK_KEY: webhookKey },
    ];
    for (const secret of secrets) {
      const target = withWebhook(env, secret);
      const page = await viewIssue(target, id, { 'cf-access-jwt-assertion': token });
      const html = await page.text();
      assert.ok(html.includes(`<form method="post" action="/ui/i/${id}/dispatch" class="dispatch">\n${notesLabel}\n${notesField}\n<div class="dispatch-action"><button type="submit" disabled>Dispatch</button><p class="quiet-note">Dispatch is not set up.</p>${freshSummary}</div></form>`));
      assert.equal(html.includes('<input'), false);
      const response = await pressDispatch(target, id, token, dispatcher, browserPress());
      await assertOutcome(response, 503, 'Dispatch is not set up.', id);
      assert.deepEqual(storedIssue(sqlite, id), before);
    }
    assert.equal(receiver.posts.length, 0);
  } finally { sqlite.close(); }
});

test('dispatch: a press sends one envelope, and the next press inside the window does not', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const configured = withWebhook(env);
  const receiver = fixtureReceiver();
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => dispatchOpenedAt });
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const page = await (await viewIssue(configured, id, { 'cf-access-jwt-assertion': token })).text();
    assert.ok(page.includes(`<form method="post" action="/ui/i/${id}/dispatch" class="dispatch">\n${notesLabel}\n${notesField}\n<div class="dispatch-action"><button type="submit">Dispatch</button>${freshSummary}</div>\n<output class="dispatch-result" role="status" aria-live="polite"></output></form>`));
    assert.equal(page.includes('<input'), false);
    const sent = await pressDispatch(configured, id, token, dispatcher, browserPress());
    const sentHtml = await assertOutcome(sent, 200, 'Sent.', id);
    assert.equal(sentHtml.includes('<p>Already sent.</p>'), false);
    assert.equal(receiver.posts.length, 1);
    const post = receiver.posts[0];
    assert.ok(post);
    assertWebhook(post, id, dispatchOpenedAt);
    assert.deepEqual(storedIssue(sqlite, id), before);
    const again = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(again, 200, 'Already sent.', id);
    assert.equal(receiver.posts.length, 1);
    assert.deepEqual(storedIssue(sqlite, id), before);
  } finally { sqlite.close(); }
});

test('dispatch: an overlapping press is already sending and does not fetch again', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const configured = withWebhook(env);
  const posts: ReceivedPost[] = [];
  let release: (response: Response) => void = () => {};
  let markStarted: () => void = () => {};
  const gate = new Promise<Response>(resolve => { release = resolve; });
  const fetchStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const dispatcher = createDispatcher({
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      posts.push({
        url, authorization: headers.get('authorization'), contentType: headers.get('content-type'),
        redirect: init?.redirect, body: typeof init?.body === 'string' ? init.body : '',
      });
      markStarted();
      return gate;
    },
    now: () => dispatchOpenedAt,
  });
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const first = pressDispatch(configured, id, token, dispatcher, browserPress());
    const observed = await Promise.race([
      fetchStarted.then(() => 'fetch' as const),
      first.then(() => 'response' as const),
    ]);
    assert.equal(observed, 'fetch');
    assert.equal(posts.length, 1);
    const second = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(second, 200, 'Already sending.', id);
    assert.equal(posts.length, 1);
    assert.deepEqual(storedIssue(sqlite, id), before);
    release(new Response(null, { status: 204 }));
    const sent = await first;
    await assertOutcome(sent, 200, 'Sent.', id);
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.ok(post);
    assertWebhook(post, id, dispatchOpenedAt);
    assert.deepEqual(storedIssue(sqlite, id), before);
  } finally {
    release(new Response(null, { status: 500 }));
    sqlite.close();
  }
});

test('dispatch: a failed press retries the same bytes, and a thrown fetch does too', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const configured = withWebhook(env);
  const receiver = fixtureReceiver([500, 204]);
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => dispatchOpenedAt });
  const thrown = fixtureReceiver(['throw', 204]);
  const retryDispatcher = createDispatcher({ fetch: thrown.fetch, now: () => dispatchOpenedAt });
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const failed = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(failed, 502, 'Not sent. Press Dispatch again to retry.', id);
    assert.equal(receiver.posts.length, 1);
    assert.deepEqual(storedIssue(sqlite, id), before);
    const retried = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(retried, 200, 'Sent on retry.', id);
    assert.equal(receiver.posts.length, 2);
    assert.equal(receiver.posts[0]?.body, receiver.posts[1]?.body);
    const first = receiver.posts[0];
    assert.ok(first);
    assertWebhook(first, id, dispatchOpenedAt);
    assert.deepEqual(storedIssue(sqlite, id), before);

    const other = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Second parcel' });
    const otherBefore = storedIssue(sqlite, other);
    const network = await pressDispatch(configured, other, token, retryDispatcher, browserPress());
    await assertOutcome(network, 502, 'Not sent. Press Dispatch again to retry.', other);
    const networkRetry = await pressDispatch(configured, other, token, retryDispatcher, browserPress());
    await assertOutcome(networkRetry, 200, 'Sent on retry.', other);
    assert.equal(thrown.posts.length, 2);
    assert.equal(thrown.posts[0]?.body, thrown.posts[1]?.body);
    assert.deepEqual(storedIssue(sqlite, other), otherBefore);
  } finally { sqlite.close(); }
});

test('dispatch: changed notes conflict, and the same notes do not send again', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const configured = withWebhook(env);
  const receiver = fixtureReceiver();
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => dispatchOpenedAt });
  const form = { origin: 'https://issues.example', contentType: 'application/x-www-form-urlencoded; charset=UTF-8' };
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const sent = await pressDispatch(configured, id, token, dispatcher, { ...form, body: 'notes=%20hello%0D%0Aworld%20' });
    await assertOutcome(sent, 200, 'Sent.', id);
    assert.equal(receiver.posts.length, 1);
    const post = receiver.posts[0];
    assert.ok(post);
    assertWebhook(post, id, dispatchOpenedAt, 'hello\nworld');
    assert.deepEqual(storedIssue(sqlite, id), before);
    const conflict = await pressDispatch(configured, id, token, dispatcher, { ...form, body: 'notes=other' });
    await assertOutcome(conflict, 409, 'This dispatch conflicts with the send already open for this issue.', id);
    assert.equal(receiver.posts.length, 1);
    assert.deepEqual(storedIssue(sqlite, id), before);
    const same = await pressDispatch(configured, id, token, dispatcher, { ...form, body: 'notes=hello%0Aworld' });
    await assertOutcome(same, 200, 'Already sent.', id);
    assert.equal(receiver.posts.length, 1);
    assert.deepEqual(storedIssue(sqlite, id), before);
  } finally { sqlite.close(); }
});

test('dispatch: a press at 60 seconds uses a new event id and the same idempotency key', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const configured = withWebhook(env);
  let now = dispatchOpenedAt;
  const receiver = fixtureReceiver();
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => now });
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const sent = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(sent, 200, 'Sent.', id);
    now = dispatchOpenedAt + 59_999;
    const inside = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(inside, 200, 'Already sent.', id);
    assert.equal(receiver.posts.length, 1);
    assert.deepEqual(storedIssue(sqlite, id), before);
    now = dispatchOpenedAt + 60_000;
    const after = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(after, 200, 'Sent.', id);
    assert.equal(receiver.posts.length, 2);
    const first = JSON.parse(receiver.posts[0]?.body ?? '') as { event_id: string; idempotency_key: string; occurred_at: number };
    const second = JSON.parse(receiver.posts[1]?.body ?? '') as { event_id: string; idempotency_key: string; occurred_at: number };
    assert.notEqual(first.event_id, second.event_id);
    assert.equal(first.idempotency_key, `${id}:dispatch`);
    assert.equal(second.idempotency_key, first.idempotency_key);
    assert.equal(second.occurred_at, first.occurred_at + 60);
    assert.deepEqual(storedIssue(sqlite, id), before);
  } finally { sqlite.close(); }
});

test('dispatch: cross-origin is forbidden even when listed, and a missing Origin is allowed', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const receiver = fixtureReceiver();
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => dispatchOpenedAt });
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const listed = withWebhook(env, { POLYLINEDB_DISPATCH_WEBHOOK_URL: webhookUrl, POLYLINEDB_DISPATCH_WEBHOOK_KEY: webhookKey }, '["https://client.example"]');
    const cross = await pressDispatch(listed, id, token, dispatcher, { ...browserPress(), origin: 'https://client.example' });
    assert.equal(cross.status, 403);
    assert.equal(cross.headers.get('content-type'), 'application/json');
    assert.deepEqual(await cross.json(), { error: { code: 'forbidden_origin', message: 'Origin is not allowed.' } });
    assert.equal(receiver.posts.length, 0);
    assert.deepEqual(storedIssue(sqlite, id), before);

    // An opaque origin stays forbidden, even when ALLOWED_ORIGINS lists the string "null".
    const opaque = await pressDispatch(withWebhook(env, { POLYLINEDB_DISPATCH_WEBHOOK_URL: webhookUrl, POLYLINEDB_DISPATCH_WEBHOOK_KEY: webhookKey }, '["null"]'), id, token, dispatcher, { ...browserPress(), origin: 'null' });
    assert.equal(opaque.status, 403);
    assert.deepEqual(await opaque.json(), { error: { code: 'forbidden_origin', message: 'Origin is not allowed.' } });
    assert.equal(receiver.posts.length, 0);
    assert.deepEqual(storedIssue(sqlite, id), before);

    const broken = fixtureReceiver();
    const brokenDispatcher = createDispatcher({ fetch: broken.fetch, now: () => dispatchOpenedAt });
    const same = await pressDispatch(withWebhook(env, { POLYLINEDB_DISPATCH_WEBHOOK_URL: webhookUrl, POLYLINEDB_DISPATCH_WEBHOOK_KEY: webhookKey }, '{'), id, token, brokenDispatcher, browserPress());
    await assertOutcome(same, 200, 'Sent.', id);
    assert.equal(broken.posts.length, 1);
    const post = broken.posts[0];
    assert.ok(post);
    assertWebhook(post, id, dispatchOpenedAt);
    assert.deepEqual(storedIssue(sqlite, id), before);

    const missing = fixtureReceiver();
    const missingDispatcher = createDispatcher({ fetch: missing.fetch, now: () => dispatchOpenedAt });
    const open = await pressDispatch(withWebhook(env), id, token, missingDispatcher, { body: '' });
    await assertOutcome(open, 200, 'Sent.', id);
    assert.equal(missing.posts.length, 1);
    const openPost = missing.posts[0];
    assert.ok(openPost);
    assertWebhook(openPost, id, dispatchOpenedAt);
    assert.deepEqual(storedIssue(sqlite, id), before);
  } finally { sqlite.close(); }
});

test('dispatch: issue POST stays GET-only, and dispatch GET is POST-only after auth', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const receiver = fixtureReceiver();
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => dispatchOpenedAt });
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const postIssue = await handleRequest(new Request(`https://issues.example/ui/i/${id}`, {
      method: 'POST', headers: { 'cf-access-jwt-assertion': token },
    }), env, authenticate, dispatcher);
    assert.equal(postIssue.status, 405);
    assert.equal(postIssue.headers.get('allow'), 'GET');
    assert.equal(postIssue.headers.get('content-type'), 'application/json');
    const getDispatch = await pressDispatch(env, id, token, dispatcher, { method: 'GET' });
    assert.equal(getDispatch.status, 405);
    assert.equal(getDispatch.headers.get('allow'), 'POST');
    assert.equal(getDispatch.headers.get('content-type'), 'application/json');
    assert.deepEqual(await getDispatch.json(), { error: { code: 'method_not_allowed', message: 'Use POST.' } });
    const anonymous = await pressDispatch(env, id, null, dispatcher, { method: 'GET' });
    assert.equal(anonymous.status, 401);
    const bad = await handleRequest(new Request('https://issues.example/ui/i/not-an-id/dispatch', { method: 'POST' }), env, authenticate, dispatcher);
    assert.equal(bad.status, 404);
    assert.equal(bad.headers.get('content-type'), 'application/json');
    assert.deepEqual(await bad.json(), { error: { code: 'not_found', message: 'Route not found.' } });
    assert.equal(receiver.posts.length, 0);
  } finally { sqlite.close(); }
});

test('dispatch: a bad form and a missing issue do not send, and a missing issue does not stick', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const configured = withWebhook(env);
  const receiver = fixtureReceiver();
  const dispatcher = createDispatcher({ fetch: receiver.fetch, now: () => dispatchOpenedAt });
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parcel title' });
    const before = storedIssue(sqlite, id);
    const form = { origin: 'https://issues.example', contentType: 'application/x-www-form-urlencoded' };
    const rejected = [
      { ...form, body: 'actor=access%3Aowner' },
      { ...form, body: 'notes=a&notes=b' },
      { ...form, body: 'notes=a%01b' },
      { ...form, body: `notes=${'a'.repeat(4097)}` },
      { ...form, body: 'x'.repeat(16 * 1024 + 1) },
      { origin: 'https://issues.example', contentType: 'text/plain', body: 'notes=hello' },
    ];
    for (const init of rejected) {
      const response = await pressDispatch(configured, id, token, dispatcher, init);
      await assertOutcome(response, 400, 'Dispatch could not read that form.', id);
      assert.deepEqual(storedIssue(sqlite, id), before);
    }
    assert.equal(receiver.posts.length, 0);
    const accepted = await pressDispatch(configured, id, token, dispatcher, { ...form, body: `notes=${'a'.repeat(4096)}` });
    await assertOutcome(accepted, 200, 'Sent.', id);
    assert.equal(receiver.posts.length, 1);
    const post = receiver.posts[0];
    assert.ok(post);
    assert.equal(JSON.parse(post.body).notes, 'a'.repeat(4096));
    assert.deepEqual(storedIssue(sqlite, id), before);

    const missing = await pressDispatch(configured, 'pd-999', token, dispatcher, browserPress());
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('content-type'), 'text/html; charset=utf-8');
    const missingHtml = await missing.text();
    assert.ok(missingHtml.includes('Issue was not found.'));
    assertNoApplicationControls(missingHtml);
    assert.equal(receiver.posts.length, 1);

    let reads = 0;
    const probeReceiver = fixtureReceiver();
    const probe = createDispatcher({
      fetch: probeReceiver.fetch,
      now: () => dispatchOpenedAt,
      readScope: async () => {
        reads += 1;
        return reads === 1 ? null : { tool: 'compiler', project: 'parser' };
      },
    });
    const hidden = await pressDispatch(configured, id, token, probe, browserPress());
    assert.equal(hidden.status, 404);
    assert.equal(probeReceiver.posts.length, 0);
    const followed = await pressDispatch(configured, id, token, probe, browserPress());
    await assertOutcome(followed, 200, 'Sent.', id);
    assert.equal(probeReceiver.posts.length, 1);
    assert.deepEqual(storedIssue(sqlite, id), before);
  } finally { sqlite.close(); }
});
