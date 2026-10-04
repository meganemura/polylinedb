// Runs schema upgrades and memory observations against local workerd D1.
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { d1Executor } from "../src/service/d1.ts";
import { executeOperation, parseOperation } from "../src/records/operations.ts";
import { SCHEMA_V2_SQL, SCHEMA_V3_SQL, schemaUpgradeStatements, ROTATE_MEMORY_IDENTITY_SQL } from "../src/records/schema.ts";

const runtime = new Miniflare({ host: '127.0.0.1', cf: false, telemetry: { enabled: false }, workers: [{ config: {
  name: 'freshness-test', compatibilityDate: '2026-09-25',
  manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ready"); } }' } } },
  env: { DB2: { type: 'd1', name: 'freshness-v2' }, DB3: { type: 'd1', name: 'freshness-v3' } },
} }] });
try {
  for (const version of [2, 3] as const) {
    const database = await runtime.getD1Database(`DB${version}`);
    const legacy = version === 2 ? SCHEMA_V2_SQL : SCHEMA_V3_SQL;
    await database.batch(legacy.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => database.prepare(sql)));
    const db = d1Executor(database);
    const identity = { kind: 'cloud' as const, url: 'https://freshness-test.example' };
    const run = (input: unknown) => executeOperation(db, parseOperation(input), 'test:d1', identity);
    const request = { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), project: 'demo', tool: 'test', body: 'Before upgrade' };
    const issue = await run(request); assert('issue' in issue);
    let memoryRequest = { op: 'memory_create', prefix: 'pd', request_id: crypto.randomUUID(), project: 'demo', title: 'Fact', body: 'Before upgrade' };
    if (version === 3) await run(memoryRequest);
    await assert.rejects(database.batch([...schemaUpgradeStatements(version), 'INSERT INTO missing_table VALUES (1)'].map(sql => database.prepare(sql))));
    assert.equal((await database.prepare('SELECT version FROM schema_version').first())?.version, version);
    assert.equal((await database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'memory_store_identity'").first())?.n, 0);
    await database.batch(schemaUpgradeStatements(version).map(sql => database.prepare(sql)));
    assert.equal((await database.prepare('SELECT version FROM schema_version').first())?.version, 4);
    assert.deepEqual(await run(request), issue);
    const revision = async () => {
      const context = await run({ op: 'memory_context', project: 'demo', with_revision: true });
      assert('memory_revision' in context && context.memory_revision); return context.memory_revision;
    };
    const check = async (token: string) => {
      const output = await run({ op: 'show', id: issue.issue.id, observed_memory_revision: token });
      assert('memory_freshness' in output && output.memory_freshness); return output.memory_freshness;
    };
    if (version === 2) await run(memoryRequest);
    const token = await revision(); assert.deepEqual(await check(token), { status: 'current', project: 'demo' });
    await run(memoryRequest); assert.equal(await revision(), token);
    const writers = await Promise.allSettled([
      run({ op: 'memory_update', project: 'demo', id: 'pd-m1', title: 'Fact', body: 'Changed', expected: 1 }),
      run({ op: 'memory_update', project: 'demo', id: 'pd-m1', title: 'Fact', body: 'Other', expected: 1 }),
    ]);
    assert.equal(writers.filter(result => result.status === 'fulfilled').length, 1);
    assert.deepEqual(await check(token), { status: 'stale', project: 'demo', reason: 'memory_changed' });
    const changed = await revision();
    await assert.rejects(run({ op: 'memory_update', project: 'demo', id: 'pd-m1', title: 'Fact', body: 'Stale', expected: 1 }), { code: 'memory_conflict' });
    assert.equal(await revision(), changed);
    await run({ op: 'memory_delete', project: 'demo', id: 'pd-m1', expected: 2 }); assert.notEqual(await revision(), changed);
    await assert.rejects(run(memoryRequest), { code: 'memory_deleted' });
    const deleted = await revision();
    await database.prepare(ROTATE_MEMORY_IDENTITY_SQL).run();
    assert.deepEqual(await check(deleted), { status: 'stale', project: 'demo', reason: 'store_changed' });
    await database.prepare(`UPDATE project_memory_revisions SET revision = ${Number.MAX_SAFE_INTEGER} WHERE project = 'demo'`).run();
    memoryRequest = { ...memoryRequest, request_id: crypto.randomUUID() };
    await assert.rejects(run(memoryRequest), { code: 'memory_revision_exhausted' });
    assert.equal((await database.prepare('SELECT last_number FROM memory_counters WHERE prefix = ?').bind('pd').first())?.last_number, 1);
    const plan = await database.prepare('EXPLAIN QUERY PLAN SELECT incarnation, CAST(COALESCE(revision,0) AS INTEGER) AS revision FROM memory_store_identity LEFT JOIN project_memory_revisions ON project_memory_revisions.project = ? WHERE singleton = 1').bind('demo').all();
    assert(plan.results.some((row: unknown) => row !== null && typeof row === 'object' && 'detail' in row && typeof row.detail === 'string' && /SEARCH project_memory_revisions USING INDEX/.test(row.detail)));
  }
  process.stdout.write('PASS: local workerd D1 schema 2/3 upgrades, rollback, indexed observations, concurrent CAS, deletion, replay, rotation and exhaustion\n');
} finally { await runtime.dispose(); }
