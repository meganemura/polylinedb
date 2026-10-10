// Exercises the built Worker with local workerd and D1; only JWKS delivery is substituted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, Response as MiniflareResponse, type Request as MiniflareRequest } from 'miniflare';
import { SCHEMA_STATEMENTS } from "../src/records/schema.ts";

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
        ACCESS_ACTORS: { type: 'text', value: JSON.stringify(['access:owner', { actor: 'access:viewer', role: 'reader' },
          { actor: 'service:codex-token', role: 'agent', label: 'Codex' }, { actor: 'service:claude-token', role: 'agent' }]) },
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
  await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
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
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(record(initialized.serverInfo).version, manifest.version);
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
  assert.equal(context.memory_revision, undefined);
  const observation = await rpc('tools/call', { name: 'memory_context', arguments: { project: 'parser', with_revision: true } });
  const token = record(observation.structuredContent).memory_revision;
  assert.equal(typeof token, 'string');
  assert(Array.isArray(observation.content));
  assert.deepEqual(JSON.parse(String(record(observation.content[0]).text)), observation.structuredContent);
  const current = await http({ op: 'show', id, observed_memory_revision: token });
  assert.deepEqual(current.memory_freshness, { status: 'current', project: 'parser' });
  assert.equal(record(record(record(listed.tools.find(tool => record(tool).name === 'show')).inputSchema).properties).observed_memory_revision !== undefined, true);
  const memoryConflict = await rpc('tools/call', { name: 'memory_delete', arguments: { project: 'parser', id: memory.id, expected: 1 } });
  assert.equal(memoryConflict.isError, true);
  assert.equal(record(record(memoryConflict.structuredContent).error).code, 'memory_conflict');
  assert.equal(record((await http({ op: 'memory_show', project: 'other', id: memory.id }, 404)).error).code, 'memory_not_found');
  assert.deepEqual(await database.prepare('SELECT body, version, created_by FROM memories WHERE id = ?').bind(memory.id).first(),
    { body: 'Shared HTTP and MCP state', version: 2, created_by: 'access:owner' });
  await http({ op: 'memory_delete', project: 'parser', id: memory.id, expected: 2 });
  const stale = await rpc('tools/call', { name: 'show', arguments: { id, observed_memory_revision: token } });
  assert.equal(stale.isError, false);
  assert.deepEqual(record(stale.structuredContent).memory_freshness, { status: 'stale', project: 'parser', reason: 'memory_changed' });
  assert(Array.isArray(stale.content));
  assert.deepEqual(JSON.parse(String(record(stale.content[0]).text)), stale.structuredContent);
  assert.equal(record((await http({ op: 'memory_create', ...memoryRequest }, 409)).error).code, 'memory_deleted');
  const blocker = record((await http({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'other', body: 'Prerequisite' })).issue);
  const graphRequest = { dependent_id: id, blocker_id: blocker.id, expected_revision: 1, request_id: crypto.randomUUID() };
  const graphAdded = await rpc('tools/call', { name: 'dependency_add', arguments: graphRequest });
  assert.equal(graphAdded.isError, false);
  const receipt = record(record(graphAdded.structuredContent).dependency); assert.equal(receipt.outcome, 'added'); assert.equal(receipt.revision, 2);
  const graph = await http({ op: 'dependency_list', dependent_id: id }); assert.equal(graph.revision, 2); assert.deepEqual(graph.blockers, [{ id: blocker.id, project: 'other', status: 'open' }]);
  const blocked = await rpc('tools/call', { name: 'dependency_worklist', arguments: { state: 'blocked', project: 'parser' } });
  assert.ok(Array.isArray(record(blocked.structuredContent).issues));
  assert.equal(record((await http({ op: 'close', id, expected: 1 }, 409)).error).code, 'dependency_blocked');
  await http({ op: 'close', id, expected: 1, force: true, reason: 'Approved prerequisite exception' });
  const shownException = await http({ op: 'show', id }); assert.ok(Array.isArray(shownException.comments));
  assert.equal(record(shownException.comments[0]).created_by, 'access:owner');
  assert.equal(record((await http({ op: 'dependency_remove', ...graphRequest, expected_revision: 2, request_id: crypto.randomUUID() })).dependency).outcome, 'removed');
  assert.deepEqual(record((await http({ op: 'dependency_add', ...graphRequest })).dependency), receipt);
  assert.deepEqual((await http({ op: 'dependency_list', dependent_id: id })).blockers, []);
  const staleGraph = await http({ op: 'dependency_add', ...graphRequest, request_id: crypto.randomUUID() }, 409);
  assert.equal(record(staleGraph.error).code, 'dependency_conflict'); assert.equal(record(record(record(staleGraph.error).details).current).revision, 3);
  const claimTools: Record<string, unknown>[] = listed.tools.map(record);
  for (const name of ['claim_show', 'claim_list', 'claim_acquire', 'claim_renew', 'claim_release']) {
    const tool = claimTools.find(candidate => candidate.name === name); assert.ok(tool); assert.equal(typeof tool.description, 'string');
    assert.equal(record(tool.inputSchema).additionalProperties, false); assert.equal(record(tool.annotations).readOnlyHint, name === 'claim_show' || name === 'claim_list');
    assert.equal(record(tool.annotations).idempotentHint, true);
  }
  const observed = await rpc('tools/call', { name: 'claim_show', arguments: { issue_id: id } }); assert.equal(observed.isError, false);
  const currentClaim = record(record(observed.structuredContent).claim); assert.equal(currentClaim.state, 'never_claimed');
  const claimArgs = { issue_id: id, incarnation: currentClaim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'Codex' };
  const claimOwner = await rpc('tools/call', { name: 'claim_acquire', arguments: claimArgs }); assert.equal(claimOwner.isError, false); const lease = record(record(claimOwner.structuredContent).claim_receipt);
  const claim_proof = { issue_id: id, incarnation: lease.incarnation, session_id: lease.session_id, generation: lease.generation };
  assert.equal(record((await http({ op: 'reopen', id, expected: 2 }, 409)).error).code, 'claim_required');
  const reopened = await rpc('tools/call', { name: 'reopen', arguments: { id, expected: 2, claim_proof } }); assert.equal(reopened.isError, false);
  const renewed = await http({ op: 'claim_renew', claim_proof, expected_revision: 1, request_id: crypto.randomUUID(), ttl: 30 }); assert.equal(record(renewed.claim_receipt).revision, 2);
  const replayed = await rpc('tools/call', { name: 'claim_acquire', arguments: claimArgs }); assert.deepEqual(replayed.structuredContent, claimOwner.structuredContent);
  const released = await rpc('tools/call', { name: 'claim_release', arguments: { claim_proof, expected_revision: 2, request_id: crypto.randomUUID() } }); assert.equal(released.isError, false);
  const listedClaims = await http({ op: 'claim_list', project: 'parser' }); assert.ok(Array.isArray(listedClaims.claims)); assert.equal(record(listedClaims.claims[0]).state, 'released');
  const claimDenied = await rpc('tools/call', { name: 'close', arguments: { id, expected: 3, force: true, reason: 'Exception', claim_proof } }); assert.equal(claimDenied.isError, true); assert.equal(record(record(claimDenied.structuredContent).error).code, 'claim_required');
  const invalidProof = await rpc('tools/call', { name: 'claim_acquire', arguments: { ...claimArgs, clock: 0 } }); assert.equal(invalidProof.isError, true); assert.equal(record(record(invalidProof.structuredContent).error).code, 'invalid_input');
  const as = async (token: string, operation: Record<string, unknown>, expectedStatus = 200) => {
    const response = await post('/v1/operations', operation, token);
    const output = record(await response.json());
    assert.equal(response.status, expectedStatus, JSON.stringify(output));
    return output;
  };
  const viewer = await assertion({ sub: 'viewer' });
  const codex = await assertion({ sub: '', common_name: 'codex-token' });
  const claude = await assertion({ sub: '', common_name: 'claude-token' });
  const readyIssue = record((await http({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'gated', body: 'Ready work', labels: ['ready'] })).issue);
  const draftIssue = record((await http({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'gated', body: 'Draft' })).issue);
  assert.equal(record((await as(viewer, { op: 'show', id: readyIssue.id })).issue).body, 'Ready work');
  assert.equal(record((await as(viewer, { op: 'comment', id: readyIssue.id, body: 'Edit' }, 403)).error).code, 'read_only_actor');
  const gatedObservation = record((await as(codex, { op: 'claim_show', issue_id: readyIssue.id })).claim);
  const agentClaim = (issueId: unknown) => ({ op: 'claim_acquire', issue_id: issueId, incarnation: gatedObservation.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() });
  assert.equal(record((await as(viewer, agentClaim(readyIssue.id), 403)).error).code, 'read_only_actor');
  assert.equal(record((await as(codex, agentClaim(draftIssue.id), 409)).error).code, 'not_ready');
  assert.equal(record((await as(codex, { op: 'comment', id: readyIssue.id, body: 'Early' }, 409)).error).code, 'claim_required');
  assert.equal(record((await as(codex, agentClaim(readyIssue.id))).claim_receipt).actor, 'service:codex-token');
  await as(codex, { op: 'comment', id: readyIssue.id, body: 'Started' });
  assert.equal(record((await as(claude, { op: 'comment', id: readyIssue.id, body: 'Mine' }, 409)).error).code, 'claim_required');
  assert.deepEqual(await database.prepare('SELECT actor FROM issue_claims WHERE issue_id = ?').bind(readyIssue.id).first(), { actor: 'service:codex-token' });
  assert.deepEqual(await database.prepare('SELECT created_by FROM comments WHERE issue_id = ?').bind(readyIssue.id).all().then((result: { results: unknown[] }) => result.results),
    [{ created_by: 'service:codex-token' }]);
  const view = (token: string | null, method = 'GET') => runtime.dispatchFetch('http://polylinedb.test/ui', {
    method, headers: token === null ? {} : { 'cf-access-jwt-assertion': token },
  });
  await database.prepare('UPDATE issues SET status = ?, labels_json = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .bind('closed', '[]', '2026-10-03T10:30:00.000Z', 'service:codex-token', readyIssue.id).run();
  await database.prepare('UPDATE issues SET labels_json = ?, updated_at = ? WHERE id = ?')
    .bind('["main-wait"]', '2026-10-04T00:00:00.000Z', draftIssue.id).run();
  await database.prepare("UPDATE issues SET updated_at = ? WHERE tool = 'compiler' AND project IN ('parser', 'other')").bind('2026-10-02T00:00:00.000Z').run();
  assert.equal((await view(null)).status, 401);
  assert.equal((await view(viewer, 'POST')).status, 405);
  const page = await view(viewer);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(page.headers.get('server-timing') ?? '', /^worker;dur=\d+\.\d$/);
  assert.equal(page.headers.get('cache-control'), 'private, no-cache');
  const etag = page.headers.get('etag');
  assert.match(etag ?? '', /^"[0-9a-f]{32}"$/);
  const html = await page.text();
  const rulesBody = html.match(/<script type="speculationrules">([\s\S]*?)<\/script>/)?.[1];
  assert.equal(html.match(/<script\b/g)?.length, 1);
  assert.equal(typeof rulesBody, 'string');
  assert.deepEqual(JSON.parse(rulesBody ?? ''), {
    prefetch: [{ source: 'document', where: { or: [{ href_matches: '/ui' }, { href_matches: '/ui/*' }] }, eagerness: 'moderate', referrer_policy: 'no-referrer' }],
  });
  const rulesHash = createHash('sha256').update(rulesBody ?? '').digest('base64');
  assert.equal(page.headers.get('content-security-policy'), `default-src 'none'; script-src 'sha256-${rulesHash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  assert.equal(page.headers.get('cache-control')?.includes('public'), false);
  const revalidated = await runtime.dispatchFetch('http://polylinedb.test/ui', { headers: { 'cf-access-jwt-assertion': viewer, 'if-none-match': `W/${etag}` } });
  assert.equal(revalidated.status, 304);
  assert.equal(await revalidated.text(), '');
  assert.equal(revalidated.headers.get('etag'), etag);
  assert.equal(revalidated.headers.get('content-security-policy'), page.headers.get('content-security-policy'));
  const anonymousRevalidation = await runtime.dispatchFetch('http://polylinedb.test/ui', { headers: { 'if-none-match': `${etag}` } });
  assert.equal(anonymousRevalidation.status, 401);
  assert.equal(anonymousRevalidation.headers.get('etag'), null);
  const anonymousBody = await anonymousRevalidation.text();
  assert.equal(anonymousBody.includes(`${draftIssue.id}`), false);
  assert.equal(anonymousBody.includes('speculationrules'), false);
  assert.ok(html.includes(`${draftIssue.id} · Last updated`));
  assert.ok(!html.includes('Recently closed'));
  assert.ok(!html.includes('Ready work'));
  const gatedPage = await runtime.dispatchFetch('http://polylinedb.test/ui/p/compiler/gated', { headers: { 'cf-access-jwt-assertion': viewer } });
  assert.equal(gatedPage.status, 200);
  const gatedHtml = await gatedPage.text();
  assert.ok(gatedHtml.includes('Recently closed'));
  assert.ok(gatedHtml.includes(`<span class="secondary">${readyIssue.id} · Last updated <time datetime="2026-10-03T10:30:00.000Z">2026-10-03 19:30 JST</time></span>\n<span class="secondary">Codex</span>`));
  assert.ok(html.includes('<h2>Projects</h2>'));
  for (const project of ['parser', 'other', 'gated']) assert.ok(html.includes(`href="/ui/p/compiler/${project}"`), project);
  assert.deepEqual([...html.matchAll(/href="(\/ui\/p\/[^"]+)"/g)].map(match => match[1]), ['/ui/p/compiler/gated', '/ui/p/compiler/other', '/ui/p/compiler/parser']);
  assert.ok(html.includes('Updated <time datetime="2026-10-04T00:00:00.000Z">2026-10-04 09:00 JST</time>'));
  const projectPage = await runtime.dispatchFetch('http://polylinedb.test/ui/p/compiler/parser', { headers: { 'cf-access-jwt-assertion': viewer } });
  assert.equal(projectPage.status, 200);
  const projectHtml = await projectPage.text();
  assert.ok(projectHtml.includes(`${id}`));
  assert.ok(!projectHtml.includes(`${draftIssue.id}`));
  assert.deepEqual(jwksRequests, [`${issuer}/cdn-cgi/access/certs`]);
  process.stdout.write(JSON.stringify({ result: 'pass', runtime: 'local workerd', artifact: bundleUrl.pathname,
    sha256: createHash('sha256').update(bundle).digest('hex'), checks: [
      'real JWT verification', 'missing and invalid credentials rejected', 'HTTP create', 'MCP initialize and show',
      'MCP update', 'HTTP and MCP stale conflicts', 'D1 atomicity and persisted audit identity', 'JWKS cache',
      'memory MCP creation and context', 'memory HTTP update', 'memory scope and stale deletion', 'memory deleted-create replay',
      'MCP and HTTP prerequisite mutations and worklists', 'immutable graph retry and same-batch conflict', 'blocked close and attributed force comment',
      'claim tool schemas and metadata', 'claim HTTP/MCP history and replay', 'claim status and force fencing',
      'read-only roster actor', 'per-token agent actors behind the ready and claim gates', 'read-only /ui page',
      'projects by latest update', '/ui Server-Timing', '/ui ETag revalidation behind Access',
      '/ui speculation rules prefetch behind a CSP hash',
    ], productionOAuth: 'not verified' }) + '\n');
} finally { await runtime.dispose(); }
