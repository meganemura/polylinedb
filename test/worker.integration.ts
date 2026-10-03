// Exercises the built Worker with local workerd and D1; only JWKS delivery is substituted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, Response as MiniflareResponse, type Request as MiniflareRequest } from 'miniflare';
import { SCHEMA_SQL } from '../src/schema.ts';

const bundleUrl = new URL('../.cloudflare/output/v0/workers/default/bundle/index.js', import.meta.url);
const bundle = await readFile(bundleUrl, 'utf8');
const issuer = 'https://polylinedb-integration.cloudflareaccess.com';
const audience = 'polylinedb-local-worker';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
const jwksRequests: string[] = [];

async function assertion(overrides: Record<string, unknown> = {}): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', kid: 'local-test' })}.${encode({
    iss: issuer, aud: [audience], sub: 'owner', iat: now - 1, exp: now + 300, ...overrides,
  })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
}

const runtime = new Miniflare({
  host: '127.0.0.1', cf: false, telemetry: { enabled: false },
  workers: [{
    config: {
      name: 'polylinedb-built-worker', compatibilityDate: '2026-09-25',
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundle } } },
      env: {
        DB: { type: 'd1', name: 'polylinedb-built-worker' },
        ACCESS_TEAM_DOMAIN: { type: 'text', value: 'polylinedb-integration.cloudflareaccess.com' },
        ACCESS_AUD: { type: 'text', value: audience },
        ACCESS_ACTORS: { type: 'text', value: '["access:owner"]' },
        ALLOWED_ORIGINS: { type: 'text', value: '["https://local-client.example"]' },
      },
    },
    dev: {
      unsafeRegisterWorker: false,
      outboundService: {
        type: 'fetcher',
        handler(request: MiniflareRequest) {
          assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`, 'Unexpected Worker egress is forbidden');
          assert.equal(request.method, 'GET');
          jwksRequests.push(request.url);
          return MiniflareResponse.json({ keys: [{ ...publicKey, kid: 'local-test', alg: 'RS256', use: 'sig' }] });
        },
      },
    },
  }],
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

try {
  const database = await runtime.getD1Database('DB');
  await database.batch(SCHEMA_SQL.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => database.prepare(sql)));
  const owner = await assertion();
  const post = (path: string, body: unknown, token: string | null = owner) => runtime.dispatchFetch(`http://polylinedb.test${path}`, {
    method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...(token === null ? {} : { 'cf-access-jwt-assertion': token }),
    }, body: JSON.stringify(body),
  });
  const http = async (operation: unknown, expectedStatus = 200) => {
    const response = await post('/v1/operations', operation);
    const output = record(await response.json());
    assert.equal(response.status, expectedStatus, JSON.stringify(output));
    return output;
  };
  let requestId = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await post('/mcp', { jsonrpc: '2.0', id: ++requestId, method, params });
    assert.equal(response.status, 200);
    const message = record(await response.json());
    assert.equal(message.id, requestId);
    assert.equal(message.jsonrpc, '2.0');
    assert.equal(message.error, undefined);
    return record(message.result);
  };

  assert.equal((await post('/v1/operations', { op: 'actor' }, null)).status, 401);
  const denied = await post('/v1/operations', { op: 'actor' }, await assertion({ sub: 'intruder' }));
  assert.equal(denied.status, 403, await denied.text());
  assert.equal((await post('/v1/operations', { op: 'actor' }, await assertion({ aud: ['wrong-audience'] }))).status, 401);
  const parts = owner.split('.');
  parts[1] = Buffer.from(JSON.stringify({ iss: issuer, aud: [audience], sub: 'owner', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  assert.equal((await post('/v1/operations', { op: 'actor' }, parts.join('.'))).status, 401);
  assert.deepEqual(await http({ op: 'actor' }), { actor: 'access:owner' });

  const created = record((await http({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'Built Worker persistence' })).issue);
  assert.equal(created.created_by, 'access:owner');
  assert.equal(created.body, 'Built Worker persistence');
  const id = created.id;
  assert.equal(typeof id, 'string');
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-integration', version: '1' },
  });
  assert.equal(initialized.protocolVersion, '2025-11-25');
  const notified = await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notified.status, 202);
  assert.equal(await notified.text(), '');
  const listed = await rpc('tools/list');
  assert.ok(Array.isArray(listed.tools));
  assert.ok(listed.tools.map((tool) => record(tool).name).includes('update'));
  const shown = await rpc('tools/call', { name: 'show', arguments: { id } });
  assert.equal(shown.isError, false);
  assert.equal(record(record(shown.structuredContent).issue).body, 'Built Worker persistence');
  const updated = await rpc('tools/call', { name: 'update', arguments: {
    id, changes: [{ field: 'body', expected: 1, value: 'Changed through MCP' }],
  } });
  assert.equal(updated.isError, false);
  assert.equal(record(record(record(updated.structuredContent).issue).versions).body, 2);
  const conflict = await http({ op: 'update', id, changes: [
    { field: 'priority', expected: 1, value: 0 }, { field: 'body', expected: 1, value: 'Stale HTTP edit' },
  ] }, 409);
  assert.equal(record(conflict.error).code, 'conflict');
  const toolConflict = await rpc('tools/call', { name: 'update', arguments: {
    id, changes: [{ field: 'body', expected: 1, value: 'Stale MCP edit' }],
  } });
  assert.equal(toolConflict.isError, true);
  assert.equal(record(record(toolConflict.structuredContent).error).code, 'conflict');
  const final = record((await http({ op: 'show', id })).issue);
  assert.equal(final.body, 'Changed through MCP');
  assert.equal(final.priority, 2);
  assert.equal(record(final.versions).priority, 1);
  const stored = await database.prepare('SELECT body, body_v, priority, priority_v, created_by FROM issues WHERE id = ?').bind(id).first();
  assert.deepEqual(stored, { body: 'Changed through MCP', body_v: 2, priority: 2, priority_v: 1, created_by: 'access:owner' });
  assert.ok(listed.tools.map(tool => record(tool).name).includes('memory_context'));
  const memoryRequest = { project: 'parser', prefix: 'pd', request_id: crypto.randomUUID(), title: 'Build fact', body: 'Verified in workerd' };
  const memoryCreated = await rpc('tools/call', { name: 'memory_create', arguments: memoryRequest });
  assert.equal(memoryCreated.isError, false);
  const memory = record(record(memoryCreated.structuredContent).memory);
  assert.equal(memory.id, 'pd-m1');
  assert.equal(memory.created_by, 'access:owner');
  const memoryUpdated = record((await http({ op: 'memory_update', project: 'parser', id: memory.id, title: 'Build fact', body: 'Shared HTTP and MCP state', expected: 1 })).memory);
  assert.equal(memoryUpdated.version, 2);
  const memoryContext = await rpc('tools/call', { name: 'memory_context', arguments: { project: 'parser' } });
  assert.equal(memoryContext.isError, false);
  const context = record(memoryContext.structuredContent);
  assert.equal(context.project, 'parser');
  assert.deepEqual(context.store, { kind: 'cloud', url: 'http://polylinedb.test' });
  assert.deepEqual(context.memories, [memoryUpdated]);
  const memoryConflict = await rpc('tools/call', { name: 'memory_delete', arguments: { project: 'parser', id: memory.id, expected: 1 } });
  assert.equal(memoryConflict.isError, true);
  assert.equal(record(record(memoryConflict.structuredContent).error).code, 'memory_conflict');
  assert.equal(record((await http({ op: 'memory_show', project: 'other', id: memory.id }, 404)).error).code, 'memory_not_found');
  assert.deepEqual(await database.prepare('SELECT body, version, created_by FROM memories WHERE id = ?').bind(memory.id).first(),
    { body: 'Shared HTTP and MCP state', version: 2, created_by: 'access:owner' });
  await http({ op: 'memory_delete', project: 'parser', id: memory.id, expected: 2 });
  assert.equal(record((await http({ op: 'memory_create', ...memoryRequest }, 409)).error).code, 'memory_deleted');
  assert.deepEqual(jwksRequests, [`${issuer}/cdn-cgi/access/certs`]);
  process.stdout.write(JSON.stringify({ result: 'pass', runtime: 'local workerd', artifact: bundleUrl.pathname,
    sha256: createHash('sha256').update(bundle).digest('hex'), checks: [
      'real JWT verification', 'missing and invalid credentials rejected', 'HTTP create', 'MCP initialize and show',
      'MCP update', 'HTTP and MCP stale conflicts', 'D1 atomicity and persisted audit identity', 'JWKS cache',
      'memory MCP creation and context', 'memory HTTP update', 'memory scope and stale deletion', 'memory deleted-create replay',
    ], productionOAuth: 'not verified' }) + '\n');
} finally { await runtime.dispose(); }
