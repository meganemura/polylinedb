/** Exercises HTTP/MCP with real SQLite and signed assertions. Production Access policy remains a live test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { storageOf } from 'solarsql/node';
import { createAccessVerifier } from "../src/service/access.ts";
import { handleRequest } from "../src/service/index.ts";
import { SCHEMA_SQL } from "../src/records/schema.ts";
import { issueSortKey } from "../src/records/issue-id.ts";
import { assertSnapshot } from "./fixtures/snapshot.ts";

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
    assert.deepEqual(names, ['actor', 'claim_acquire', 'claim_list', 'claim_release', 'claim_renew', 'claim_show', 'close', 'comment', 'create', 'dependency_add', 'dependency_list', 'dependency_remove', 'dependency_worklist', 'list', 'memory_context', 'memory_create', 'memory_delete', 'memory_list', 'memory_search', 'memory_show', 'memory_update', 'reopen', 'search', 'show', 'update']);
    const annotationRows = tools.map((tool: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }) =>
      [tool.name, tool.annotations.readOnlyHint, tool.annotations.destructiveHint, tool.annotations.idempotentHint, tool.annotations.openWorldHint]);
    annotationRows.sort((left: (string | boolean)[], right: (string | boolean)[]) => String(left[0]).localeCompare(String(right[0])));
    assert.deepEqual(annotationRows, [
      ['actor', true, false, true, false],
      ['claim_acquire', false, false, true, false],
      ['claim_list', true, false, true, false],
      ['claim_release', false, true, true, false],
      ['claim_renew', false, false, true, false],
      ['claim_show', true, false, true, false],
      ['close', false, true, true, false],
      ['comment', false, false, false, false],
      ['create', false, false, true, false],
      ['dependency_add', false, false, true, false],
      ['dependency_list', true, false, true, false],
      ['dependency_remove', false, true, true, false],
      ['dependency_worklist', true, false, true, false],
      ['list', true, false, true, false],
      ['memory_context', true, false, true, false],
      ['memory_create', false, false, true, false],
      ['memory_delete', false, true, true, false],
      ['memory_list', true, false, true, false],
      ['memory_search', true, false, true, false],
      ['memory_show', true, false, true, false],
      ['memory_update', false, true, true, false],
      ['reopen', false, true, true, false],
      ['search', true, false, true, false],
      ['show', true, false, true, false],
      ['update', false, true, true, false],
    ]);
    const updated = await request('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'update', arguments: { id: issue.id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }] },
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
    const blockedClose = await request('/v1/operations', { op: 'close', id: issue.id, expected: 2 });
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
    await read('dependency_worklist', { state: 'blocked' }); await read('dependency_worklist', { state: 'ready' });
    await repeat('dependency_remove', { dependent_id: issue.id, blocker_id: blocker.id, expected_revision: 2, request_id: crypto.randomUUID() });
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

    const advertised = (await rpc('tools/list')).tools.map((tool: { name: string; annotations: { readOnlyHint: boolean; idempotentHint: boolean } }) =>
      [tool.name, tool.annotations.readOnlyHint, tool.annotations.idempotentHint]).sort();
    const measured = [...readOnly, ...idempotent, ...repeatable].map(name => [name, readOnly.has(name), !repeatable.has(name)]).sort();
    assert.deepEqual(advertised, measured);
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

function projectPath(tool: string, project: string): string {
  return `/ui/p/${encodeURIComponent(tool)}/${project.split('/').map(segment => encodeURIComponent(segment)).join('/')}`;
}

function viewProject(env: ReturnType<typeof fixture>['env'], tool: string, project: string, headers: Record<string, string> = {}, method = 'GET', query = '') {
  return handleRequest(new Request(`https://issues.example${projectPath(tool, project)}${query}`, { method, headers }), env, authenticate);
}

function viewIssue(env: ReturnType<typeof fixture>['env'], id: string, headers: Record<string, string> = {}, method = 'GET') {
  return handleRequest(new Request(`https://issues.example/ui/i/${id}`, { method, headers }), env, authenticate);
}

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
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    const waitingPart = uiSection(html, 'Waiting for main');
    const ids = (part: string) => [...part.matchAll(/<span class="secondary">(pd-\d+) · /g)].map(match => match[1]);
    assert.match(waitingPart, /^Waiting for main<\/h2>/);
    assert.deepEqual(ids(waitingPart), [waiting]);
    assert.equal(html.indexOf('<h2>Recently closed</h2>'), -1);
    assert.ok(!html.includes('Newest close'));
    assert.ok(!/<(form|input|button|script)\b/.test(html));
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
    const project = await (await viewProject(env, 'compiler', 'parser', { 'cf-access-jwt-assertion': token })).text();
    const closedPart = uiSection(project, 'Recently closed');
    assert.match(closedPart, /^Recently closed<\/h2>/);
    assert.deepEqual(ids(closedPart), [newest, hostile, older, closedWaiting]);
    assert.ok(project.includes(`<span class="primary">Newest close</span>\n<span class="secondary">${newest} · Last updated <time datetime="2026-10-03T10:30:00.000Z">2026-10-03 19:30 JST</time></span>\n<span class="secondary">service:agent-7</span>`));
    assert.ok(project.includes('<span class="primary">&lt;img src=x onerror=alert(1)&gt;&amp;</span>'));
    assert.ok(project.includes('<span class="secondary">access:&lt;b&gt;&quot;x&quot;</span>'));
    assert.ok(!project.includes('<img'));
    assert.ok(!/<(form|input|button|script)\b/.test(project));
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
  const response = await handleRequest(new Request('https://issues.example/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token },
    body: JSON.stringify({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), ...fields }),
  }), env, authenticate);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).issue.id;
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
    assert.ok(!/<(form|input|button|script)\b/.test(html));
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
    assert.equal(reader.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.equal(reader.headers.get('cache-control'), 'no-store');
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
    assert.ok(!/<(form|input|button|script)\b/.test(page));
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
    assert.equal(missing.headers.get('cache-control'), 'no-store');

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
    assert.ok(!/<(form|input|button|script)\b/.test(html));
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
    const openPart = uiSection(detail, 'Open blockers');
    const closedPart = uiSection(detail, 'Closed blockers');
    assert.ok(openPart.includes(`href="/ui/i/${deferredBlocker}"`));
    assert.ok(openPart.includes('deferred'));
    assert.ok(!openPart.includes(closedBlocker));
    assert.ok(closedPart.includes(closedBlocker));
    assert.ok(closedPart.includes('closed'));
    assert.ok(!closedPart.includes(deferredBlocker));
    const single = await (await viewIssue(env, one, { 'cf-access-jwt-assertion': token })).text();
    const singleOpen = uiSection(single, 'Open blockers');
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
