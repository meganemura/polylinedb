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
import { pageScript, speculationRules } from "../src/service/ui.ts";
import { composeLanes, stuckCount } from "../src/service/ui-today.ts";
import type { Issue } from "../src/records/index.ts";
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
    assert.deepEqual(names, ['actor', 'changes', 'claim_acquire', 'claim_handoff', 'claim_list', 'claim_release', 'claim_renew', 'claim_show', 'close', 'comment', 'comment_edit', 'create', 'dependency_add', 'dependency_list', 'dependency_owner_waits', 'dependency_remove', 'dependency_worklist', 'land_order_add', 'land_order_list', 'land_order_remove', 'list', 'memory_context', 'memory_create', 'memory_delete', 'memory_list', 'memory_search', 'memory_show', 'memory_update', 'posts', 'reopen', 'resource_add', 'resource_list', 'resource_live', 'resource_update', 'search', 'server_info', 'show', 'star', 'unstar', 'update', 'wait']);
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
      ['comment_edit', false, true, true, false],
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
      ['posts', true, false, true, false],
      ['reopen', false, true, true, false],
      ['resource_add', false, false, true, false],
      ['resource_list', true, false, true, false],
      ['resource_live', true, false, true, false],
      ['resource_update', false, false, true, false],
      ['search', true, false, true, false],
      ['server_info', true, false, true, false],
      ['show', true, false, true, false],
      ['star', false, false, true, false],
      ['unstar', false, true, true, false],
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
    assert.deepEqual([shown.comments[0].version, shown.comments[0].updated_at, shown.comments[0].updated_by], [1, null, null]);
    const editInput = { id: issue.id, comment_id: shown.comments[0].id, body: 'reproduced', expected: 1 };
    const mcpEdit = await request('/mcp', { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'comment_edit', arguments: editInput } });
    const editedComment = (await mcpEdit.json()).result.structuredContent.comment;
    assert.deepEqual([editedComment.body, editedComment.version, editedComment.updated_by], ['reproduced', 2, 'access:owner']);
    const httpEditConflict = await request('/v1/operations', { op: 'comment_edit', ...editInput, body: 'stale' });
    assert.equal(httpEditConflict.status, 409);
    assert.deepEqual((await httpEditConflict.json()).error.details, { comment: editedComment, expected: 1 });
    const afterEdit = await (await request('/v1/operations', { op: 'show', id: issue.id })).json();
    assert.deepEqual(afterEdit.comments, [{ ...editedComment, stars: 0, starrers: [] }]); assert.deepEqual(afterEdit.issue.versions, shown.issue.versions); assert.equal(afterEdit.issue.updated_at, shown.issue.updated_at);
    assert.deepEqual((await (await request('/v1/operations', { op: 'search', query: 'reproduced' })).json()).issues.map((hit: { id: string }) => hit.id), [issue.id]);
    assert.deepEqual((await (await request('/v1/operations', { op: 'search', query: 'confirmed' })).json()).issues, []);
    const edits = (await (await request('/v1/operations', { op: 'changes', since: 0, kinds: ['comment_edited'] })).json()).changes;
    assert.deepEqual(edits.map((change: { issue_id: string; kind: string; actor: string; fields: string[] }) => [change.issue_id, change.kind, change.actor, change.fields]), [[issue.id, 'comment_edited', 'access:owner', []]]);
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
    // A star changes no issue field, so an agent stars without a claim, while a reader cannot star at all.
    const started = (await operate('viewer', { op: 'show', id: ready.id })).body.comments.find((comment: { body: string }) => comment.body === 'started');
    assert.deepEqual(await operate('viewer', { op: 'star', id: ready.id, comment_id: started.id }),
      { status: 403, body: { error: { code: 'read_only_actor', message: 'This actor can only read', details: { op: 'star' } } } });
    assert.equal((await operate('viewer', { op: 'unstar', id: ready.id, comment_id: started.id })).body.error.code, 'read_only_actor');
    assert.equal((await operate('viewer', { op: 'posts', project: 'parser' })).status, 200);
    assert.equal((await operate('claude', { op: 'star', id: ready.id, comment_id: started.id })).body.outcome, 'added');
    assert.equal((await operate('claude', { op: 'unstar', id: ready.id, comment_id: started.id })).body.outcome, 'removed');
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
    const noted = (await read('show', { id: issue.id })).comments[0];
    await repeat('comment_edit', { id: issue.id, comment_id: noted.id, body: 'reproduced', expected: noted.version });
    await repeat('star', { id: issue.id, comment_id: noted.id, handle: 'tester' });
    await read('posts', { project: 'parser' });
    await repeat('unstar', { id: issue.id, comment_id: noted.id, handle: 'tester' });
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

function viewUi(env: ReturnType<typeof fixture>['env'], headers: Record<string, string> = {}, method = 'GET', path = '/ui') {
  return handleRequest(new Request(`https://issues.example${path}`, { method, headers }), env, authenticate);
}

function viewIssue(env: ReturnType<typeof fixture>['env'], id: string, headers: Record<string, string> = {}, method = 'GET') {
  return handleRequest(new Request(`https://issues.example/ui/i/${id}`, { method, headers }), env, authenticate);
}

/** A same-origin form post, as the browser sends it, optionally asking for the JSON the fixed script reads. */
function postUi(env: ReturnType<typeof fixture>['env'], path: string, token: string, fields: readonly (readonly [string, string | number])[],
  init: { json?: boolean; origin?: string | null; dispatcher?: ReturnType<typeof createDispatcher> } = {}) {
  const headers: Record<string, string> = { 'cf-access-jwt-assertion': token, 'content-type': 'application/x-www-form-urlencoded' };
  if (init.origin !== null) headers.origin = init.origin ?? 'https://issues.example';
  if (init.json === true) headers.accept = 'application/json';
  const body = new URLSearchParams(fields.map(([name, value]) => [name, String(value)])).toString();
  return handleRequest(new Request(`https://issues.example${path}`, { method: 'POST', headers, body }), env, authenticate, init.dispatcher);
}

async function operation(env: ReturnType<typeof fixture>['env'], token: string, body: Record<string, unknown>) {
  const response = await handleRequest(new Request('https://issues.example/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(body),
  }), env, authenticate);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function createIssue(env: ReturnType<typeof fixture>['env'], token: string, fields: Record<string, unknown>): Promise<string> {
  const started = fields.status === 'in_progress' && fields.type !== 'epic';
  const { id } = (await operation(env, token, { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), ...fields, ...(started ? { status: 'open' } : {}) })).issue;
  if (!started) return id;
  const { store_incarnation } = (await operation(env, token, { op: 'claim_show', issue_id: id })).claim;
  const session_id = crypto.randomUUID();
  const { claim_receipt } = await operation(env, token, { op: 'claim_acquire', issue_id: id, incarnation: store_incarnation, session_id, request_id: crypto.randomUUID() });
  const claim_proof = { issue_id: id, incarnation: claim_receipt.incarnation, session_id, generation: claim_receipt.generation };
  await operation(env, token, { op: 'update', id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }], claim_proof });
  return id;
}

/** The text of a page with tags removed, for sentence assertions that do not pin markup. */
function textOf(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([,.:;)])/g, '$1').replace(/\( /g, '(');
}

/** The section of a page that a lane panel or card heading opens. */
function panel(html: string, heading: string): string {
  const start = html.indexOf(`>${heading}</h2>`);
  assert.ok(start >= 0, heading);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

function uiPolicy(): string {
  const rules = createHash('sha256').update(speculationRules).digest('base64');
  const script = createHash('sha256').update(pageScript).digest('base64');
  return `default-src 'none'; script-src 'sha256-${rules}' 'sha256-${script}'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

// Every page carries the speculation rules and the one fixed script, and nothing else runs.
function assertPageScripts(html: string): void {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map(script => script[1]), [' type="speculationrules"', '']);
  assert.equal(scripts[0]?.[2], speculationRules);
  assert.equal(scripts[1]?.[2], pageScript);
  assert.deepEqual(JSON.parse(speculationRules), {
    prefetch: [{ source: 'document', where: { or: [{ href_matches: '/ui' }, { href_matches: '/ui/*' }] }, eagerness: 'moderate', referrer_policy: 'no-referrer' }],
  });
  assert.equal(/\sstyle="/.test(html), false, 'no inline style attribute');
  assert.equal(/\son[a-z]+="/.test(html), false, 'no inline event handler');
}

const uiPages = ['/ui', '/ui/agents', '/ui/activity', '/ui/landing', '/ui/stuck', '/ui/projects', '/ui/p/compiler/parser', '/ui/search?q=Lane', '/ui/new'];

test('ui: every page answers under the hashed policy with one fixed script, Server-Timing, and an ETag', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Lane title' });
    for (const path of [...uiPages, `/ui/i/${id}`]) {
      const response = await viewUi(env, auth, 'GET', path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'private, no-cache');
      assert.equal(response.headers.get('referrer-policy'), 'same-origin');
      assert.equal(response.headers.get('content-security-policy'), uiPolicy(), path);
      assert.match(response.headers.get('server-timing') ?? '', /^worker;dur=\d+\.\d$/, path);
      assert.match(response.headers.get('etag') ?? '', /^"[0-9a-f]{32}"$/, path);
      const html = await response.text();
      assertPageScripts(html);
      assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'), path);
    }
    const missing = await viewUi(env, auth, 'GET', '/ui/i/pd-999');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('server-timing') ?? '', /^worker;dur=\d+\.\d$/);
    assertPageScripts(await missing.text());
    const rejected = await viewUi(env, {});
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('server-timing'), null);
  } finally { sqlite.close(); }
});

test('ui: the views of the earlier /ui move permanently, and unknown paths stay JSON 404s', async () => {
  const { sqlite, env } = fixture();
  const reads: string[] = [];
  const watched = { ...env, DB: { ...env.DB, prepare: (sql: string) => { reads.push(sql); return env.DB.prepare(sql); } } };
  try {
    for (const [from, to] of [['/ui/inbox', '/ui'], ['/ui/working', '/ui/agents'], ['/ui/blocked', '/ui/stuck'], ['/ui/recent', '/ui/activity']]) {
      const moved = await viewUi(watched, {}, 'GET', from);
      assert.equal(moved.status, 301, from);
      assert.equal(moved.headers.get('location'), to);
      assert.equal(await moved.text(), '');
    }
    assert.deepEqual(reads, []);
    for (const path of ['/ui/nowhere', '/ui/i/pd-1/unknown', '/ui/i/not-an-id']) {
      const missing = await viewUi(env, { 'cf-access-jwt-assertion': await assertion() }, 'GET', path);
      assert.equal(missing.status, 404, path);
      assert.deepEqual(await missing.json(), { error: { code: 'not_found', message: 'Route not found.' } });
    }
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
    const etag = first.headers.get('etag') ?? '';
    const html = await first.text();
    assert.equal(etag, `"${createHash('sha256').update(html).digest('hex').slice(0, 32)}"`);
    for (const ifNoneMatch of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
      const again = await issueRequest({ ...auth, 'if-none-match': ifNoneMatch });
      assert.equal(again.status, 304, ifNoneMatch);
      assert.equal(await again.text(), '');
      assert.equal(again.headers.get('etag'), etag);
      assert.equal(again.headers.get('content-security-policy'), uiPolicy());
      assert.equal(again.headers.get('content-type'), null);
    }
    // The page names its reader and the reader sees no write control, so the same issue is a different page for each role.
    const reader = await issueRequest({ 'cf-access-jwt-assertion': await assertion({ sub: 'viewer' }), 'if-none-match': etag });
    assert.equal(reader.status, 200);
    assert.equal((await reader.text()).includes('method="post"'), false);
    assert.equal((await issueRequest({ ...auth, 'if-none-match': '"0123456789abcdef0123456789abcdef"' })).status, 200);
    const rejections: Record<string, string>[] = [{}, { 'cf-access-jwt-assertion': `${token.slice(0, -4)}AAAA` }, { 'cf-access-jwt-assertion': await assertion({ sub: 'stranger' }) }];
    for (const headers of rejections) {
      const denied = await issueRequest({ ...headers, 'if-none-match': etag }, watched);
      assert.ok(denied.status === 401 || denied.status === 403);
      assert.equal(denied.headers.get('etag'), null);
      assert.ok(!(await denied.text()).includes('Cached title'));
    }
    assert.deepEqual(reads, []);
    sqlite.prepare("UPDATE issues SET body = 'Changed title', updated_at = '2026-10-10T00:00:00.000Z' WHERE id = ?").run(id);
    const changed = await issueRequest({ ...auth, 'if-none-match': etag });
    assert.equal(changed.status, 200);
    assert.ok((await changed.text()).includes('Changed title'));
  } finally { sqlite.close(); }
});

test('ui: Access gates every page and write before any read, and the roster role decides the controls', async () => {
  const { sqlite, env } = fixture('["access:owner",{"actor":"access:viewer","role":"reader"},{"actor":"service:robot","role":"agent"}]');
  const token = await assertion();
  const reads: string[] = [];
  const watched = { ...env, DB: { ...env.DB, prepare: (sql: string) => { reads.push(sql); return env.DB.prepare(sql); } } };
  try {
    const decide = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Pick the wire format', labels: ['owner-decision'] });
    const ready = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Ready parcel', labels: ['ready'] });
    for (const misconfigured of [{ ACCESS_TEAM_DOMAIN: '' }, { ACCESS_AUD: '' }, { ACCESS_ACTORS: '[]' }]) {
      assert.equal((await viewUi({ ...watched, ...misconfigured }, { 'cf-access-jwt-assertion': token })).status, 503);
    }
    assert.equal((await viewUi(watched)).status, 401);
    assert.equal((await viewUi(watched, { 'cf-access-jwt-assertion': await assertion({ sub: 'stranger' }) })).status, 403);
    assert.equal((await postUi(watched, `/ui/i/${decide}/decide`, await assertion({ sub: 'stranger' }), [['outcome', 'approve']])).status, 403);
    assert.deepEqual(reads, []);

    const configured = withWebhook(env);
    const owner = await (await viewUi(configured, { 'cf-access-jwt-assertion': token })).text();
    assert.ok(owner.includes(`action="/ui/i/${decide}/decide"`));
    assert.ok(owner.includes(`action="/ui/i/${ready}/dispatch"`));
    assert.ok(owner.includes('href="/ui/new"'));
    assert.ok(textOf(owner).includes('One thing waits on you.'));
    assert.ok(textOf(owner).includes(`Start with ${decide}, a decision at P2: Pick the wire format.`));

    const agent = await (await viewUi(configured, { 'cf-access-jwt-assertion': await assertion({ sub: '', common_name: 'robot' }) })).text();
    assert.ok(agent.includes(`action="/ui/i/${decide}/decide"`));
    assert.equal(agent.includes('/dispatch"'), false);
    assert.ok(textOf(agent).includes('One thing waits on the owner.'));
    assert.ok(textOf(agent).includes(`The first is ${decide}`));

    const reader = await (await viewUi(configured, { 'cf-access-jwt-assertion': await assertion({ sub: 'viewer' }) })).text();
    assert.equal(reader.includes('method="post"'), false);
    assert.equal(reader.includes('href="/ui/new"'), false);
    assert.ok(textOf(reader).includes('One thing waits on the owner.'));
    const readerIssue = await (await viewIssue(configured, decide, { 'cf-access-jwt-assertion': await assertion({ sub: 'viewer' }) })).text();
    assert.equal(readerIssue.includes('method="post"'), false);
    assert.ok(textOf(readerIssue).includes('Signed in as a reader. This page has no controls.'));

    const before = JSON.stringify(sqlite.prepare('SELECT * FROM issues ORDER BY id').all());
    const refused = await postUi(env, `/ui/i/${decide}/decide`, await assertion({ sub: 'viewer' }), [['outcome', 'approve'], ['v.labels', 1], ['seen.labels', '["owner-decision"]']], { json: true });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { ok: false, message: 'Signed in as a reader. Writes wait on the owner.' });
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM issues ORDER BY id').all()), before);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const write = await viewUi(env, { 'cf-access-jwt-assertion': token }, method);
      assert.equal(write.status, 405, method);
      assert.equal(write.headers.get('allow'), 'GET');
    }
    assert.equal((await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', `/ui/i/${decide}/decide`)).status, 405);
  } finally { sqlite.close(); }
});

test('ui: a write accepts only its own origin or none, and answers 303 to a /ui return path it validated', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Origin parcel' });
    for (const origin of ['https://client.example', 'null', 'https://evil.example']) {
      const cross = await postUi(env, `/ui/i/${id}/comment`, token, [['body', 'x']], { origin });
      assert.equal(cross.status, 403, origin);
      assert.equal((await cross.json()).error.code, 'forbidden_origin');
    }
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM comments').get()?.count, 0);
    const none = await postUi(env, `/ui/i/${id}/comment`, token, [['body', 'no origin'], ['return', '/ui/stuck']], { origin: null });
    assert.equal(none.status, 303);
    assert.equal(none.headers.get('location'), '/ui/stuck#comments');
    for (const unsafe of ['https://evil.example/ui', '//evil.example/ui', '/ui\\evil', '/uix', '/elsewhere', '/ui//x']) {
      const answer = await postUi(env, `/ui/i/${id}/comment`, token, [['body', 'kept'], ['return', unsafe]]);
      assert.equal(answer.status, 303, unsafe);
      assert.equal(answer.headers.get('location'), `/ui/i/${id}#comments`, unsafe);
    }
    const json = await postUi(env, `/ui/i/${id}/comment`, token, [['body', 'in place']], { json: true });
    assert.equal(json.status, 200);
    assert.deepEqual(await json.json(), { ok: true, message: 'Comment saved.' });
    const empty = await postUi(env, `/ui/i/${id}/comment`, token, [['body', '  ']], { json: true });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { ok: false, message: 'The comment is empty. Nothing changed.' });
    const unreadable = await handleRequest(new Request(`https://issues.example/ui/i/${id}/comment`, { method: 'POST',
      headers: { 'cf-access-jwt-assertion': token, 'content-type': 'text/plain', accept: 'application/json' }, body: 'body=x' }), env, authenticate);
    assert.equal(unreadable.status, 400);
    assert.equal((await unreadable.json()).ok, false);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM comments').get()?.count, 8);
  } finally { sqlite.close(); }
});

test('ui: Today composes the lanes by rule, and the dedupe rules keep each issue in one work lane', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const make = (body: string, labels: string[], extra: Record<string, unknown> = {}) => createIssue(env, token, { tool: 'compiler', project: 'acme/parser', body, labels, ...extra });
    // An owner item that also carries ready stays on You and never shows as Ready.
    const decide = await make('Choose the error format', ['owner-decision', 'ready'], { priority: 1 });
    const act = await make('Rotate the deploy key', ['owner-action']);
    const parked = await make('Parked decision', ['owner-decision']);
    sqlite.prepare("UPDATE issues SET status = 'deferred' WHERE id = ?").run(parked);
    const ready = await make('Add a fuzz target', ['ready']);
    const claimedReady = await make('Claimed and ready', ['ready']);
    const lock = await make('main-lock: acme/parser', ['main-lock', 'ready'], { type: 'chore' });
    const first = await make('Report the column', ['main-wait']);
    const second = await make('Keep comments', ['main-wait']);
    const waiting = await make('Release notes', []);
    await operation(env, token, { op: 'dependency_add', dependent_id: waiting, blocker_id: act, expected_revision: 1, request_id: crypto.randomUUID() });
    await operation(env, token, { op: 'dependency_add', dependent_id: act, blocker_id: decide, expected_revision: 1, request_id: crypto.randomUUID() });
    await operation(env, token, { op: 'land_order_add', later_id: first, earlier_id: second, expected_revision: 1, request_id: crypto.randomUUID() });
    const { store_incarnation } = (await operation(env, token, { op: 'claim_show', issue_id: lock })).claim;
    for (const id of [lock, claimedReady]) {
      await operation(env, token, { op: 'claim_acquire', issue_id: id, incarnation: store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), ttl: 900, agent_label: 'lane-a' });
    }
    await operation(env, token, { op: 'comment', id: claimedReady, body: 'Halfway through the fixtures.' });

    const html = await (await viewUi(env, auth)).text();
    const text = textOf(html);
    assert.ok(text.includes('Two things wait on you.'), text);
    assert.ok(text.includes('1 to decide, 1 to do; the oldest has waited'));
    assert.ok(text.includes(`Start with ${decide}, a decision at P1: Choose the error format. It has waited under 1 min. ${act} waits for it.`));
    assert.ok(text.includes('lane-a holds the main lock for parser until'));
    assert.ok(text.includes('so a push to main is under way.'));
    assert.ok(text.includes(`2 issues are on queue and not on main. ${second} lands first.`));
    assert.ok(text.includes('Composed by rule from the store at'));
    assert.ok(text.includes('Reload for a new one.'));

    const you = panel(html, 'You');
    assert.ok(you.indexOf(`/ui/i/${decide}"`) < you.indexOf(`/ui/i/${act}"`), 'a decision comes before an action');
    assert.ok(textOf(you).includes(`Starts after ${decide} is done.`), textOf(you));
    assert.equal(you.includes(`/ui/i/${parked}"`), false);
    const agents = panel(html, 'Agents');
    assert.ok(agents.includes(`/ui/i/${ready}"`));
    assert.ok(agents.includes(`/ui/i/${claimedReady}"`));
    assert.ok(textOf(agents).includes('“Halfway through the fixtures.”'), textOf(agents));
    for (const hidden of [decide, lock]) assert.equal(agents.includes(`/ui/i/${hidden}"`), false, hidden);
    assert.equal(html.includes(`class="title" href="/ui/i/${lock}"`), false, 'a lock is never a work row');
    const landing = panel(html, 'Landing');
    assert.ok(landing.indexOf(`/ui/i/${second}"`) < landing.indexOf(`/ui/i/${first}"`), 'land order puts the earlier issue first');
    const stuck = panel(html, 'Stuck');
    assert.ok(stuck.includes(`/ui/i/${waiting}"`));
    assert.ok(stuck.includes(`/ui/i/${act}"`), 'a blocked You item still shows as blocked');
    assert.match(html, /aria-label="Today, 2"/);
    assert.match(html, /aria-label="Stuck, 2"/);
    assert.match(html, /aria-label="Agents"/);
  } finally { sqlite.close(); }
});

test('ui: composeLanes drops You items from Ready, Expired, and Stale, and counts what the page cap hides', () => {
  const issue = (id: string, labels: string[], status: Issue['status'] = 'open'): Issue => ({ id, tool: 't', project: 'o/p', body: id, status, type: 'task', priority: 2, labels,
    parent_id: null, created_at: '2026-10-01T00:00:00.000Z', created_by: 'a', updated_at: '2026-10-01T00:00:00.000Z', updated_by: 'a',
    versions: { body: 1, status: 1, type: 1, priority: 1, labels: 1 } } as unknown as Issue);
  const expired = (id: string, labels: string[] = []) => ({ issue: issue(id, labels, 'in_progress'), claim: { state: 'expired' as const, actor: 'a', agentLabel: null, expiresAt: 10, releasedAt: null } });
  const stale = (id: string, labels: string[] = []) => ({ issue: issue(id, labels, 'in_progress'), claim: { state: 'released' as const, actor: 'a', agentLabel: null, expiresAt: 10, releasedAt: 5 } });
  const owner = issue('t-1', ['owner-action']);
  const lanes = composeLanes({
    attention: { issues: [{ issue: owner, labels: owner.labels, waitingSeconds: 60 }, { issue: issue('t-9', ['owner-decision'], 'closed'), labels: ['owner-decision'], waitingSeconds: 1 }] } as never,
    claims: [], blocked: { rows: [], total: 0 }, queue: [], locks: [], since: [],
    started: { rows: [expired('t-1', ['owner-action']), expired('t-2'), stale('t-3'), stale('t-4', ['main-lock']), stale('t-1')], total: 120, expired: 2 },
    ready: [issue('t-1', ['ready', 'owner-action']), issue('t-5', ['ready'])],
  });
  assert.deepEqual(lanes.you.map(item => item.issue.id), ['t-1']);
  assert.deepEqual(lanes.ready.map(row => row.id), ['t-5']);
  assert.deepEqual(lanes.expired.map(row => row.issue.id), ['t-2']);
  assert.deepEqual(lanes.stale.map(row => row.issue.id), ['t-3']);
  // 120 started and 2 expired leave 118; the 2 unexpired rows a rule hides are not counted.
  assert.equal(lanes.staleTotal, 116);
  assert.equal(stuckCount(lanes), 1);
});

test('ui: decide approves, declines, or defers, saves the note after the change, and names the next item', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const make = (body: string) => createIssue(env, token, { tool: 'compiler', project: 'parser', body, labels: ['owner-decision', 'urgent'] });
    const [approve, decline, defer] = [await make('Approve me'), await make('Decline me'), await make('Defer me')];
    const fields = (outcome: string, note: string) => [['return', '/ui'], ['v.labels', 1], ['v.status', 1], ['seen.labels', '["owner-decision","urgent"]'], ['seen.status', 'open'], ['note', note], ['outcome', outcome]] as const;
    const approved = await postUi(env, `/ui/i/${approve}/decide`, token, fields('approve', 'Ship JSON lines.'));
    assert.equal(approved.status, 303);
    assert.equal(approved.headers.get('location'), `/ui?done=approved:${approve}`);
    const shown = await operation(env, token, { op: 'show', id: approve });
    assert.deepEqual(shown.issue.labels, ['ready', 'urgent']);
    assert.equal(shown.issue.status, 'open');
    assert.deepEqual(shown.comments.map((comment: { body: string }) => comment.body), ['Approved. Ship JSON lines.']);

    const flash = textOf(await (await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', `/ui?done=approved:${approve}`)).text());
    assert.ok(flash.includes(`Decision recorded on ${approve}. Approved: owner-decision cleared and ready added. It now shows under Agents as ready.`), flash);
    assert.ok(flash.includes(`Next: ${decline}, Decline me.`));

    const declined = await postUi(env, `/ui/i/${decline}/decide`, token, fields('decline', ''), { json: true });
    assert.equal(declined.status, 200);
    assert.deepEqual(await declined.json(), { ok: true, message: `Decision recorded on ${decline}. Declined and closed.` });
    assert.equal((await operation(env, token, { op: 'show', id: decline })).issue.status, 'closed');
    assert.equal((await operation(env, token, { op: 'show', id: decline })).comments.length, 0);
    const deferred = await postUi(env, `/ui/i/${defer}/decide`, token, fields('defer', 'After the release.'));
    assert.equal(deferred.headers.get('location'), `/ui?done=deferred:${defer}`);
    const parked = await operation(env, token, { op: 'show', id: defer });
    assert.equal(parked.issue.status, 'deferred');
    assert.deepEqual(parked.issue.labels, ['owner-decision', 'urgent']);
    assert.deepEqual(parked.comments.map((comment: { body: string }) => comment.body), ['Deferred. After the release.']);
    const closedFlash = await (await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', `/ui?done=declined:${decline}`)).text();
    assert.ok(closedFlash.includes(`action="/ui/i/${decline}/status"`), 'a closed issue offers Reopen');
    const bogus = textOf(await (await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', '/ui?done=hacked:<b>')).text());
    assert.equal(bogus.includes('hacked'), false);
    const bad = await postUi(env, `/ui/i/${approve}/decide`, token, [['outcome', 'maybe']], { json: true });
    assert.equal(bad.status, 400);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM comments').get()?.count, 2);
  } finally { sqlite.close(); }
});

test('ui: done closes with the note, hands back to agents, and writes status under a 30-second lease of its own', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const finish = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Rotate the key', labels: ['owner-action'] });
    const back = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Hand this back', labels: ['owner-action'] });
    // A claim that ended leaves a claim row, so the store wants a proof for this status write even from a person.
    const { store_incarnation } = (await operation(env, token, { op: 'claim_show', issue_id: finish })).claim;
    const session_id = crypto.randomUUID();
    const { claim_receipt } = await operation(env, token, { op: 'claim_acquire', issue_id: finish, incarnation: store_incarnation, session_id, request_id: crypto.randomUUID() });
    await operation(env, token, { op: 'claim_release', claim_proof: { issue_id: finish, incarnation: claim_receipt.incarnation, session_id, generation: claim_receipt.generation },
      expected_revision: claim_receipt.revision, request_id: crypto.randomUUID() });
    const fields = (outcome: string, note: string) => [['return', '/ui'], ['v.labels', 1], ['v.status', 1], ['seen.labels', '["owner-action"]'], ['seen.status', 'open'], ['note', note], ['outcome', outcome]] as const;
    const done = await postUi(env, `/ui/i/${finish}/done`, token, fields('done', 'Rotated at 09:10.'));
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), `/ui?done=done:${finish}`);
    const closed = await operation(env, token, { op: 'show', id: finish });
    assert.equal(closed.issue.status, 'closed');
    assert.deepEqual(closed.comments.map((comment: { body: string }) => comment.body), ['Rotated at 09:10.']);
    assert.equal(closed.claim.state, 'released');
    assert.equal(closed.claim.lease.agent_label, 'pd ui');
    assert.equal(closed.claim.lease.expires_at - closed.claim.lease.acquired_at, 30);

    const handed = await postUi(env, `/ui/i/${back}/done`, token, fields('handback', ''), { json: true });
    assert.deepEqual(await handed.json(), { ok: true, message: `${back} is back with the agents, labeled ready.` });
    assert.deepEqual((await operation(env, token, { op: 'show', id: back })).issue.labels, ['ready']);

    // A live claim of someone else is a refusal, never something the page takes over.
    const held = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Held', status: 'in_progress' });
    const before = JSON.stringify(sqlite.prepare('SELECT * FROM issues WHERE id = ?').get(held));
    const refused = await postUi(env, `/ui/i/${held}/status`, token, [['v.status', 2], ['seen.status', 'in_progress'], ['status', 'open']], { json: true });
    assert.equal(refused.status, 422);
    assert.match((await refused.json()).message, /holds a claim on pd-\d+ until .* JST\. Change its status after the claim ends, or ask the holder\. Nothing changed\.$/);
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM issues WHERE id = ?').get(held)), before);
    const progress = await postUi(env, `/ui/i/${back}/status`, token, [['v.status', 1], ['status', 'in_progress']], { json: true });
    assert.equal(progress.status, 400);
  } finally { sqlite.close(); }
});

test('ui: a stale version answers 409 with the four-row diff and the note kept; a disjoint label change merges', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Contested decision', labels: ['owner-decision'] });
    const fields = [['return', '/ui'], ['v.labels', 1], ['v.status', 1], ['seen.labels', '["owner-decision"]'], ['seen.status', 'open'], ['note', 'My <reason>'], ['outcome', 'approve']] as const;
    // Someone else adds a label the decision does not touch: the approval still applies to the current list.
    await operation(env, token, { op: 'update', id, changes: [{ field: 'labels', value: ['owner-decision', 'docs'], expected: 1 }] });
    const merged = await postUi(env, `/ui/i/${id}/decide`, token, fields);
    assert.equal(merged.status, 303);
    assert.deepEqual((await operation(env, token, { op: 'show', id })).issue.labels, ['docs', 'ready']);

    const other = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Second contest', labels: ['owner-decision'] });
    await operation(env, token, { op: 'update', id: other, changes: [{ field: 'labels', value: ['owner-action'], expected: 1 }] });
    const before = JSON.stringify(sqlite.prepare('SELECT * FROM issues WHERE id = ?').get(other));
    const stale = await postUi(env, `/ui/i/${other}/decide`, token, fields);
    assert.equal(stale.status, 409);
    assert.equal(stale.headers.get('content-security-policy'), uiPolicy());
    const html = await stale.text();
    assertPageScripts(html);
    const conflict = html.slice(html.indexOf('<section class="conflict"'), html.indexOf('</section>', html.indexOf('<section class="conflict"')));
    assert.ok(textOf(conflict).includes('Someone changed this after you opened it'));
    assert.ok(textOf(conflict).includes('Nothing was saved. The last change was by access:owner at'));
    assert.ok(conflict.includes('<span class="lbl">You saw</span>owner-decision</div>'));
    assert.ok(conflict.includes('<span class="lbl">Now</span>owner-action</div>'));
    assert.ok(conflict.includes('<span class="lbl">Your change</span>add ready and remove owner-decision</div>'));
    assert.ok(conflict.includes('<span class="lbl">Result if applied now</span>owner-action, ready.</div>'));
    assert.ok(conflict.includes('<textarea id="cf-note" name="note" rows="3">My &lt;reason&gt;</textarea>'));
    assert.ok(conflict.includes('<input type="hidden" name="v.labels" value="2">'));
    assert.ok(conflict.includes('<input type="hidden" name="seen.labels" value="[&quot;owner-action&quot;]">'));
    assert.ok(conflict.includes('<button class="btn">Approve on the current version</button>'));
    assert.ok(conflict.includes('<a class="btn ghost" href="/ui">Discard my change</a>'));
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM issues WHERE id = ?').get(other)), before);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM comments WHERE issue_id = ?').get(other)?.count, 0);
    const json = await postUi(env, `/ui/i/${other}/decide`, token, fields, { json: true });
    assert.equal(json.status, 409);
    assert.deepEqual(await json.json(), { ok: false, message: 'Someone changed this after you opened it. Nothing was saved.' });

    const priority = await postUi(env, `/ui/i/${other}/priority`, token, [['v.priority', 1], ['seen.priority', 2], ['priority', 0]]);
    assert.equal(priority.status, 303);
    const stalePriority = await postUi(env, `/ui/i/${other}/priority`, token, [['v.priority', 1], ['seen.priority', 2], ['priority', 4]]);
    assert.equal(stalePriority.status, 409);
    const priorityConflict = await stalePriority.text();
    assert.ok(priorityConflict.includes('<span class="lbl">You saw</span>P2</div>'));
    assert.ok(priorityConflict.includes('<span class="lbl">Now</span>P0</div>'));
    assert.ok(priorityConflict.includes('<span class="lbl">Result if applied now</span>P4.</div>'));
    assert.ok(priorityConflict.includes('<input type="hidden" name="priority" value="4">'));
  } finally { sqlite.close(); }
});

test('ui: Mark landed removes main-wait and comments per ticked issue, and the landing page says what happened', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const make = (body: string, labels: string[]) => createIssue(env, token, { tool: 'compiler', project: 'parser', body, labels });
    const first = await make('First to land', ['main-wait', 'docs']);
    const second = await make('Second to land', ['main-wait']);
    const gone = await make('Already landed', []);
    const page = await (await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', '/ui/landing')).text();
    assert.ok(page.includes('git fetch origin queue &amp;&amp; git push origin origin/queue:refs/heads/main'));
    assert.ok(page.includes(`name="landed" value="${first}"`));
    const answer = await postUi(env, '/ui/landing/landed', token, [['return', '/ui/landing'], ['landed', first], ['v.labels.' + first, 1], ['landed', second], ['landed', gone]]);
    assert.equal(answer.status, 303);
    assert.equal(answer.headers.get('location'), `/ui/landing?landed=${first},${second}&gone=${gone}`);
    for (const id of [first, second]) {
      const shown = await operation(env, token, { op: 'show', id });
      assert.equal(shown.issue.labels.includes('main-wait'), false);
      assert.deepEqual(shown.comments.map((comment: { body: string }) => comment.body), ['Landed on main.']);
    }
    assert.deepEqual((await operation(env, token, { op: 'show', id: first })).issue.labels, ['docs']);
    assert.equal((await operation(env, token, { op: 'show', id: gone })).comments.length, 0);
    const result = textOf(await (await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', answer.headers.get('location') ?? '')).text());
    assert.ok(result.includes(`Marked landed: ${first}, ${second}. Each lost main-wait and got the comment “Landed on main.” Already off the queue: ${gone}.`), result);
    const none = await postUi(env, '/ui/landing/landed', token, [['return', '/ui/landing']], { json: true });
    assert.equal(none.status, 400);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM comments').get()?.count, 2);
  } finally { sqlite.close(); }
});

test('ui: the issue page edits fields, blockers, land order, and text through version-carrying forms', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Edit me\n\nBody' });
    const blocker = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Blocker' });
    const html = await (await viewIssue(env, id, { 'cf-access-jwt-assertion': token })).text();
    for (const action of ['status', 'priority', 'type', 'labels', 'body', 'comment', 'blockers/add']) assert.ok(html.includes(`action="/ui/i/${id}/${action}"`), action);
    assert.equal(html.includes('value="in_progress"'), false, 'agents set in progress');
    const steps: [string, (readonly [string, string | number])[], string][] = [
      ['type', [['v.type', 1], ['seen.type', 'task'], ['type', 'bug']], `${id} is now a bug.`],
      ['labels', [['v.labels', 1], ['seen.labels', '[]'], ['labels', 'ready'], ['labels.new', 'docs  infra']], `Labels of ${id}: ready, docs, infra.`],
      ['body', [['v.body', 1], ['body', 'Edited title\n\nNew body']], `The text of ${id} is saved.`],
      ['blockers/add', [['v.blockers', 1], ['blocker', blocker]], `${id} now waits on ${blocker}.`],
      ['blockers/remove', [['v.blockers', 2], ['blocker', blocker]], `${blocker} no longer blocks ${id}.`],
      ['land-order', [['v.land', 1], ['op', 'set'], ['after', blocker]], `${id} now lands after ${blocker}.`],
      ['land-order', [['v.land', 2], ['op', 'clear'], ['after', blocker]], `${id} no longer waits for ${blocker} to land.`],
      ['status', [['v.status', 1], ['seen.status', 'open'], ['status', 'deferred']], `${id} is deferred. It leaves You until it is reopened.`],
    ];
    for (const [action, fields, message] of steps) {
      const answer = await postUi(env, `/ui/i/${id}/${action}`, token, fields, { json: true });
      assert.deepEqual(await answer.json(), { ok: true, message }, action);
    }
    const shown = await operation(env, token, { op: 'show', id });
    assert.equal(shown.issue.type, 'bug');
    assert.equal(shown.issue.status, 'deferred');
    assert.equal(shown.issue.body, 'Edited title\n\nNew body');
    assert.deepEqual(shown.issue.labels, ['docs', 'infra', 'ready']);
    const cycle = await postUi(env, `/ui/i/${blocker}/blockers/add`, token, [['v.blockers', 1], ['blocker', blocker]], { json: true });
    assert.equal(cycle.status, 422);
    const notId = await postUi(env, `/ui/i/${id}/blockers/add`, token, [['v.blockers', 3], ['blocker', 'next week']], { json: true });
    assert.deepEqual(await notId.json(), { ok: false, message: 'The blocker “next week” is not an issue id, such as pd-65.' });
    const staleBlocker = await postUi(env, `/ui/i/${id}/blockers/add`, token, [['v.blockers', 1], ['blocker', blocker]]);
    assert.equal(staleBlocker.status, 409);
    assert.ok((await staleBlocker.text()).includes('<span class="lbl">Result if applied now</span>Blocked by pd-2.</div>'));
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM dependencies').get()?.count, 0);
  } finally { sqlite.close(); }
});

test('ui: New issue creates with the project prefix and opens it, and a refusal keeps the typed text', async () => {
  const { sqlite, env } = fixture('["access:owner",{"actor":"access:viewer","role":"reader"}]');
  const token = await assertion();
  try {
    await createIssue(env, token, { tool: 'compiler', project: 'acme/parser', body: 'Seed', prefix: 'ps' });
    const form = await (await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', `/ui/new?project=${encodeURIComponent('compiler\nacme/parser')}`)).text();
    assert.ok(form.includes('<option value="compiler&#10;acme/parser" selected>') || form.includes('<option value="compiler\nacme/parser" selected>'), form.match(/<select[\s\S]*?<\/select>/)?.[0]);
    const created = await postUi(env, '/ui/new', token, [['project', 'compiler\nacme/parser'], ['body', 'Made in the page\n\nWith a body'], ['type', 'bug'], ['priority', '1'], ['labels', 'ready']]);
    assert.equal(created.status, 303);
    assert.equal(created.headers.get('location'), '/ui/i/ps-2?done=created:ps-2');
    const shown = await operation(env, token, { op: 'show', id: 'ps-2' });
    assert.deepEqual([shown.issue.type, shown.issue.priority, shown.issue.labels], ['bug', 1, ['ready']]);
    const opened = textOf(await (await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', '/ui/i/ps-2?done=created:ps-2')).text());
    assert.ok(opened.includes('ps-2 is created.'));
    const refused = await postUi(env, '/ui/new', token, [['project', 'compiler\nacme/parser'], ['body', 'Keep <this> text'], ['labels', 'main-wait']]);
    assert.equal(refused.status, 400);
    assert.ok((await refused.text()).includes('>Keep &lt;this&gt; text</textarea>'));
    const unknown = await postUi(env, '/ui/new', token, [['project', 'compiler\nnowhere'], ['body', 'Lost project']], { json: true });
    assert.equal(unknown.status, 404);
    const reader = await (await viewUi(env, { 'cf-access-jwt-assertion': await assertion({ sub: 'viewer' }) }, 'GET', '/ui/new')).text();
    assert.equal(reader.includes('method="post"'), false);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM issues').get()?.count, 2);
  } finally { sqlite.close(); }
});

test('ui: the issue page and an ID search start their independent reads together', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const epic = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Parallel epic', type: 'epic' });
    const child = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Parallel child', parent: epic });
    const blocker = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Parallel blocker' });
    await operation(env, token, { op: 'dependency_add', dependent_id: child, blocker_id: blocker, expected_revision: 1, request_id: crypto.randomUUID() });
    const counted = roundTrips(env);
    const detail = await counted.count(handleRequest(new Request(`https://issues.example/ui/i/${child}`, { headers: auth }), counted.env, authenticate));
    assert.equal(detail.response.status, 200);
    const html = await detail.response.text();
    assert.ok(html.includes(`href="/ui/i/${epic}"`));
    assert.ok(panel(html, 'Blockers').includes(`href="/ui/i/${blocker}"`));
    assert.ok(detail.rounds <= 3, `${detail.rounds} rounds`);
    const search = await counted.count(handleRequest(new Request(`https://issues.example/ui/search?q=${child}`, { headers: auth }), counted.env, authenticate));
    assert.ok((await search.response.text()).includes(`href="/ui/i/${child}"`));
    assert.ok(search.rounds <= 3, `${search.rounds} rounds`);
  } finally { sqlite.close(); }
});

test('ui: taps are at least 44 px, fields are 16 px, and night colors follow the phone', async () => {
  const { sqlite, env } = fixture();
  try {
    const html = await (await viewUi(env, { 'cf-access-jwt-assertion': await assertion() })).text();
    const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    assert.match(styles, /@media \(prefers-color-scheme:\s*dark\)/);
    assert.match(styles, /@view-transition\{navigation:auto\}/);
    assert.match(styles, /prefers-reduced-motion:no-preference/);
    assert.match(styles, /min-height:44px/);
    assert.match(styles, /font-size:16px/);
  } finally { sqlite.close(); }
});

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

// The fixed page script asks for JSON; a press without it gets a 303 back to the page, or a page that says why not.
function pressDispatch(env: ReturnType<typeof fixture>['env'], id: string, token: string | null, dispatcher: ReturnType<typeof createDispatcher>, init: {
  origin?: string; body?: string; contentType?: string; method?: string; json?: boolean;
} = {}) {
  const headers: Record<string, string> = {};
  if (init.json !== false) headers.accept = 'application/json';
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

async function assertOutcome(response: Response, status: number, sentence: string, id: string): Promise<void> {
  assert.equal(response.status, status, id);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  assert.deepEqual(await response.json(), { ok: status === 200, message: sentence });
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
      assert.equal(html.includes('/dispatch"'), false, role);
      assert.equal(html.includes('name="notes"'), false, role);
      assert.equal(html.includes('method="post"'), role !== 'reader', role);
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
      assert.ok(html.includes('<button class="btn" type="button" disabled>'));
      assert.ok(html.includes('<p class="hint">Dispatch is not set up.</p>'));
      assert.equal(html.includes(`action="/ui/i/${id}/dispatch"`), false);
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
    const form = page.match(new RegExp(`<form method="post" action="/ui/i/${id}/dispatch" data-live>[\\s\\S]*?</form>`))?.[0] ?? '';
    assert.ok(form.includes('<textarea id="dp-pd-1-main" name="notes" rows="3" maxlength="4096"'), form);
    assert.ok(form.includes('<p class="live" role="status"></p>'));
    assert.ok(page.includes('not ready · no blockers · not claimed · will not start now'));
    const sent = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(sent, 200, 'Sent.', id);
    assert.equal(receiver.posts.length, 1);
    const post = receiver.posts[0];
    assert.ok(post);
    assertWebhook(post, id, dispatchOpenedAt);
    assert.deepEqual(storedIssue(sqlite, id), before);
    const again = await pressDispatch(configured, id, token, dispatcher, browserPress());
    await assertOutcome(again, 200, 'Already sent.', id);
    assert.equal(receiver.posts.length, 1);
    const native = await pressDispatch(configured, id, token, dispatcher, { ...browserPress(), json: false, body: 'return=%2Fui%2Fagents' });
    assert.equal(native.status, 303);
    assert.equal(native.headers.get('location'), `/ui/agents?done=dispatched:${id}`);
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
    await assertOutcome(conflict, 422, 'This dispatch conflicts with the send already open for this issue.', id);
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
    assert.deepEqual(await missing.json(), { ok: false, message: 'That issue does not exist. Nothing was sent.' });
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

test('ui: the issue page marks an edited comment with its edit time and offers an edit form only on your own comments', async () => {
  const { sqlite, env } = fixture('["access:owner",{"actor":"service:robot","role":"agent"}]');
  const token = await assertion();
  const operate = async (body: Record<string, unknown>) => (await handleRequest(new Request('https://issues.example/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(body),
  }), env, authenticate)).json();
  try {
    const id = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Edited comments' });
    const kept = (await operate({ op: 'comment', id, body: 'unchanged note' })).comment;
    const changed = (await operate({ op: 'comment', id, body: 'retracted words' })).comment;
    const edited = (await operate({ op: 'comment_edit', id, comment_id: changed.id, body: 'corrected words', expected: 1 })).comment;
    const html = await (await viewIssue(env, id, { 'cf-access-jwt-assertion': token })).text();
    assert.ok(html.includes(`edited <time datetime="${edited.updated_at.slice(0, 19)}.000Z">`));
    assert.equal(html.split('>edited <time').length - 1, 1, `only the edited comment is marked: ${kept.id}`);
    assert.ok(html.includes('corrected words')); assert.equal(html.includes('retracted words'), false);
    assert.equal(html.includes('comment_edit'), false);
    assert.equal(html.split(`action="/ui/i/${id}/comment-edit"`).length - 1, 2, 'both comments are the owner\'s own');
    const agentView = await (await viewIssue(env, id, { 'cf-access-jwt-assertion': await assertion({ sub: '', common_name: 'robot' }) })).text();
    assert.equal(agentView.includes('/comment-edit"'), false);
    const edit = await postUi(env, `/ui/i/${id}/comment-edit`, token, [['comment', kept.id], ['v.comment', 1], ['body', 'kept, then edited']], { json: true });
    assert.deepEqual(await edit.json(), { ok: true, message: 'Comment saved.' });
    const stale = await postUi(env, `/ui/i/${id}/comment-edit`, token, [['comment', kept.id], ['v.comment', 1], ['body', 'late edit']]);
    assert.equal(stale.status, 409);
    assert.ok((await stale.text()).includes('<span class="lbl">Now</span>“kept, then edited”</div>'));
  } finally { sqlite.close(); }
});

test('ui: the issue page shows the persona of a post and the star count of each starred comment', async () => {
  const { sqlite, env } = fixture('["access:owner"]');
  const token = await assertion();
  const operate = async (body: Record<string, unknown>) => (await handleRequest(new Request('https://issues.example/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(body),
  }), env, authenticate)).json();
  try {
    const id = await createIssue(env, token, { tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Posts on the page' });
    const post = (await operate({ op: 'comment', id, body: 'builder notes', handle: 'builder', via: 'claude-code cloud' })).comment;
    const plain = (await operate({ op: 'comment', id, body: 'plain note' })).comment;
    for (const handle of ['tester', 'scout']) assert.equal((await operate({ op: 'star', id, comment_id: post.id, handle })).outcome, 'added');
    assert.equal((await operate({ op: 'star', id, comment_id: plain.id })).outcome, 'added');
    const html = await (await viewIssue(env, id, { 'cf-access-jwt-assertion': token })).text();
    const item = (body: string) => html.slice(html.lastIndexOf('<li', html.indexOf(body)), html.indexOf(body));
    assert.ok(item('builder notes').includes('<span>as builder</span><span>2 stars</span>'), item('builder notes'));
    assert.ok(item('plain note').includes('<span>1 star</span>'), item('plain note'));
    assert.equal(item('plain note').includes('<span>as '), false);
  } finally { sqlite.close(); }
});

test('ui: Projects orders by the latest issue update, caps at 200 with a sentence, and shows the last path segment', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const insert = sqlite.prepare(`INSERT INTO issues(id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 'open', 'task', 0, '[]', '2026-09-01T00:00:00.000Z', 'access:owner', ?, 'access:owner')`);
    insert.run('pd-1', issueSortKey('pd-1'), 'order', 'owner/alpha', 'pd-1', '2026-10-09T03:00:00.000Z');
    insert.run('pd-2', issueSortKey('pd-2'), 'order', 'owner/alpha', 'pd-2', '2026-10-08T00:00:00.000Z');
    insert.run('pd-3', issueSortKey('pd-3'), 'order', 'bravo', 'pd-3', '2026-10-10T06:40:00.000Z');
    insert.run('pd-4', issueSortKey('pd-4'), 'b-tool', 'shared', 'pd-4', '2026-09-30T00:00:00.000Z');
    insert.run('pd-5', issueSortKey('pd-5'), 'a-tool', 'shared', 'pd-5', '2026-09-30T00:00:00.000Z');
    insert.run('pd-6', issueSortKey('pd-6'), 'wire', 'marked', 'pd-6', '"><img');
    const response = await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', '/ui/projects');
    const html = await response.text();
    assert.equal(response.status, 200, html.slice(0, 300));
    assert.deepEqual([...html.matchAll(/href="\/ui\/p\/([^"]+)"/g)].map(match => match[1]), ['order/bravo', 'order/owner/alpha', 'a-tool/shared', 'b-tool/shared', 'wire/marked']);
    assert.ok(html.includes('<a class="title" href="/ui/p/order/owner/alpha">alpha</a>'));
    assert.equal(textOf(html).includes('owner/alpha'), false, 'the owner segment stays out of the row');
    assert.ok(html.includes('Updated <time datetime="2026-10-10T06:40:00.000Z">2026-10-10 15:40 JST</time>'));
    assert.ok(html.includes('2026-10-09 12:00 JST') && !html.includes('2026-10-08 09:00 JST'));
    assert.ok(html.includes('Updated <time>an unknown time</time>') && !html.includes('<img'), 'a stored time that does not parse is never markup');
    assert.ok(textOf(html).includes('All 5 projects are shown, newest update first.'));
    for (let number = 0; number <= 200; number += 1) insert.run(`cap-${number + 1}`, issueSortKey(`cap-${number + 1}`), 'cap', `p${String(number).padStart(3, '0')}`, 'x', '2026-08-01T00:00:00.000Z');
    const capped = textOf(await (await viewUi(env, { 'cf-access-jwt-assertion': token }, 'GET', '/ui/projects')).text());
    assert.ok(capped.includes('The 200 most recently updated projects are shown. More projects are not shown.'));
  } finally { sqlite.close(); }
});

test('ui: a project page filters by state and label, lists recent closes, and refuses an unknown filter', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const open = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Open parcel', labels: ['ready'] });
    const deferred = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Deferred parcel', status: 'deferred' });
    const closed = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Closed parcel' });
    await operation(env, token, { op: 'close', id: closed, expected: 1 });
    await createIssue(env, token, { tool: 'compiler', project: 'other', body: 'Elsewhere' });
    const page = async (query: string) => (await viewUi(env, auth, 'GET', `/ui/p/compiler/parser${query}`)).text();
    const all = await page('');
    assert.ok(panel(all, 'Unfinished').includes(`/ui/i/${open}"`) && panel(all, 'Unfinished').includes(`/ui/i/${deferred}"`));
    assert.equal(panel(all, 'Unfinished').includes(`/ui/i/${closed}"`), false);
    assert.ok(panel(all, 'Recently closed').includes(`/ui/i/${closed}"`));
    assert.equal(all.includes('Elsewhere'), false);
    assert.ok(all.includes('href="/ui/p/compiler/parser?status=deferred"'));
    assert.ok(all.includes('href="/ui/p/compiler/parser?label=ready"'));
    const filtered = await page('?status=deferred');
    assert.ok(filtered.includes('href="/ui/p/compiler/parser?status=deferred" aria-current="page"'));
    assert.ok(panel(filtered, 'Deferred').includes(`/ui/i/${deferred}"`) && !panel(filtered, 'Deferred').includes(`/ui/i/${open}"`));
    const labelled = await page('?label=ready');
    assert.ok(labelled.includes(`/ui/i/${open}"`) && !panel(labelled, 'Unfinished').includes(`/ui/i/${deferred}"`));
    for (const query of ['?status=bogus', `?label=${encodeURIComponent('a\u0001b')}`]) assert.equal((await viewUi(env, auth, 'GET', `/ui/p/compiler/parser${query}`)).status, 404, query);
  } finally { sqlite.close(); }
});

test('ui: issue and owner text is escaped everywhere, and an owner marker line gives way to the next line as the title', async () => {
  const { sqlite, env } = fixture('[{"actor":"access:owner","role":"human","label":"<b>Owner</b>"}]');
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const id = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: '要対応（owner-action）\n<script>alert(1)</script> & "quotes"\n\nBody <img src=x>', labels: ['owner-action'] });
    await operation(env, token, { op: 'comment', id, body: '<iframe>note</iframe>' });
    for (const path of ['/ui', `/ui/i/${id}`, '/ui/p/compiler/parser', `/ui/search?q=${encodeURIComponent('<script>')}`, '/ui/activity']) {
      const html = await (await viewUi(env, auth, 'GET', path)).text();
      assert.equal(html.includes('<script>alert'), false, path);
      assert.equal(html.includes('<img src=x>'), false, path);
      assert.equal(html.includes('<iframe>'), false, path);
      assert.equal(html.includes('<b>Owner</b>'), false, path);
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'), path);
    }
    const issue = await (await viewIssue(env, id, auth)).text();
    assert.ok(issue.includes('<h1 class="issue-title">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</h1>'));
    assert.ok(issue.includes('<div class="prose" lang="ja">要対応（owner-action）'));
    assert.ok(issue.includes('&lt;b&gt;Owner&lt;/b&gt;'));
  } finally { sqlite.close(); }
});

test('ui: an epic lists its children and a child links back to its parent', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  try {
    const epic = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Parser epic', type: 'epic' });
    const child = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Child task', parent: epic });
    const parent = await (await viewIssue(env, epic, { 'cf-access-jwt-assertion': token })).text();
    assert.ok(panel(parent, 'Family').includes(`href="/ui/i/${child}"`));
    const kid = await (await viewIssue(env, child, { 'cf-access-jwt-assertion': token })).text();
    assert.ok(kid.includes(`<a href="/ui/i/${epic}">`));
    assert.ok(panel(kid, 'Family').includes(`href="/ui/i/${epic}"`));
  } finally { sqlite.close(); }
});

test('ui: search finds an issue by id or by words, and says when a search is empty, too long, or capped', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  try {
    const lease = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Lease worker timing' });
    const other = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Unrelated' });
    const search = async (query: string) => textOf(await (await viewUi(env, auth, 'GET', `/ui/search?q=${encodeURIComponent(query)}`)).text());
    assert.ok((await search('')).includes('Type an issue id or words from the text.'));
    const words = await search('worker');
    assert.ok(words.includes(`${lease}`) && !words.includes('Unrelated'));
    assert.ok(words.includes('1 match.'));
    const byId = await (await viewUi(env, auth, 'GET', `/ui/search?q=${other}`)).text();
    assert.ok(byId.includes(`href="/ui/i/${other}"`));
    assert.ok((await search('nothing like this')).includes('No matches. Try a shorter word.'));
    assert.ok((await search(`a${'b'.repeat(70000)}`)).includes('That search is too long or contains a null character.'));
    for (let number = 0; number < 51; number += 1) await createIssue(env, token, { tool: 'compiler', project: 'parser', body: `Bulk lease ${number}` });
    assert.ok((await search('lease')).includes('Showing 50 matches. More exist; add a word to narrow them.'));
  } finally { sqlite.close(); }
});

test('ui: the agent feed lists events newest first, a kept link lists only later events, and a bad link says why', async () => {
  const { sqlite, env } = fixture();
  const token = await assertion();
  const auth = { 'cf-access-jwt-assertion': token };
  const page = async (path: string) => {
    const response = await viewUi(env, auth, 'GET', path);
    assert.equal(response.status, 200, path);
    return response.text();
  };
  const rows = (html: string) => [...html.matchAll(/<span class="chip[^"]*"><svg[^>]*><use href="#i-[a-z]+"\/><\/svg>([^<]+)<\/span><span class="mono">([^<]+)<\/span>/g)].map(match => `${match[1]} ${match[2]}`);
  try {
    const commented = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Commented work' });
    const changed = await createIssue(env, token, { tool: 'compiler', project: 'parser', body: 'Changed work' });
    const first = await page('/ui/activity');
    const resume = first.match(/href="(\/ui\/activity\?after=\d+&amp;incarnation=[a-f0-9]{32})"/)?.[1]?.replace('&amp;', '&');
    assert.ok(resume, first);
    await operation(env, token, { op: 'comment', id: commented, body: 'A note' });
    await operation(env, token, { op: 'update', id: changed, changes: [{ field: 'status', value: 'deferred', expected: 1 }] });
    assert.deepEqual(rows(await page('/ui/activity')), [`Status changed ${changed}`, `Commented ${commented}`, `Created ${changed}`, `Created ${commented}`]);
    assert.deepEqual(rows(await page(resume)), [`Commented ${commented}`, `Status changed ${changed}`]);
    const foreign = textOf(await page(resume.replace(/incarnation=[a-f0-9]{32}/, `incarnation=${'0'.repeat(32)}`)));
    assert.ok(foreign.includes('This activity link is from another store. Start again from the latest activity.'));
    for (const path of ['/ui/activity?after=x', '/ui/activity?after=1']) assert.ok(textOf(await page(path)).includes('This activity link is not valid.'), path);
    assert.equal((await page('/ui/activity')).includes('method="post"'), false);
  } finally { sqlite.close(); }
});
