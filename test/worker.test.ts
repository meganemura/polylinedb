/** Exercises HTTP/MCP with real SQLite and signed assertions. Production Access policy remains a live test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { storageOf } from 'solarsql/node';
import { createAccessVerifier } from "../src/service/access.ts";
import { handleRequest } from "../src/service/index.ts";
import { SCHEMA_SQL } from "../src/records/schema.ts";
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
    const [, waitingPart, closedPart] = html.split(/<h2>/);
    const ids = (part: string) => [...part.matchAll(/<span class="secondary">(pd-\d+) · /g)].map(match => match[1]);
    assert.match(waitingPart, /^main 待ち<\/h2>/);
    assert.deepEqual(ids(waitingPart), [waiting]);
    assert.match(closedPart, /^Recently closed<\/h2>/);
    assert.deepEqual(ids(closedPart), [newest, hostile, older, closedWaiting]);
    assert.ok(html.includes(`<span class="primary">Newest close</span>\n<span class="secondary">${newest} · 最終更新 <time datetime="2026-10-03T10:30:00.000Z">2026-10-03 19:30 JST</time></span>\n<span class="secondary">service:agent-7</span>`));
    assert.ok(html.includes('<span class="primary">&lt;img src=x onerror=alert(1)&gt;&amp;</span>'));
    assert.ok(html.includes('<span class="secondary">access:&lt;b&gt;&quot;x&quot;</span>'));
    assert.ok(!html.includes('<img'));
    assert.ok(!/<(form|input|button|script)\b/.test(html));
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
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

    const html = await (await viewUi(env, { 'cf-access-jwt-assertion': token })).text();
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
    assert.ok(html.includes('<p class="quiet-note">Nothing waits for main.</p>'));
    assert.ok(html.includes('<p class="quiet-note">Nothing has closed yet.</p>'));
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
      assert.ok((await view.text()).includes('<span class="primary">Secret title</span>'), role);
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
