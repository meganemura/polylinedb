// Exercises operator restoration against workerd D1, including ambiguous committed writes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotMigration, type Query } from '../scripts/d1-snapshot-store.ts';
import { parseQueryOutput, parseTarget } from '../scripts/d1-snapshot.ts';
import { initializeStore, openStore } from '../src/sqlite.ts';
import { executeOperation, parseOperation } from '../src/operations.ts';
import { d1Executor } from '../src/d1.ts';
import { canonicalSnapshot } from '../src/snapshot.ts';
import { SCHEMA_SQL } from '../src/schema.ts';

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: {
  name: 'snapshot-test', compatibilityDate: '2026-09-25',
  manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ready"); } }' } } },
  env: { DB: { type: 'd1', name: 'snapshot-test' } },
} }] });
const root = mkdtempSync(join(tmpdir(), 'pd-snapshot-test-'));
const location = { directory: join(root, 'source') };
initializeStore(location);
const source = openStore(location);
try {
  const database = await runtime.getD1Database('DB');
  const query: Query = async ({ sql, params }) => {
    const result = await database.prepare(sql).bind(...params).all();
    return result.results;
  };
  const reset = async () => {
    for (const table of ['memory_requests', 'memory_counters', 'memories', 'comments', 'requests', 'counters', 'issues', 'schema_version', 'polylinedb_snapshot_claim']) await query({ sql: `DROP TABLE IF EXISTS ${table}`, params: [] });
    await database.batch(SCHEMA_SQL.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => database.prepare(sql)));
  };
  await reset();
  const run = (operation: unknown) => executeOperation(source.db, parseOperation(operation), 'test:original');
  const request = { op: 'create', prefix: 'pd', request_id: randomUUID(), tool: 'compiler', project: 'p', body: 'original', type: 'epic' };
  const created = await run(request); assert('issue' in created);
  await run({ op: 'update', id: created.issue.id, changes: [{ field: 'body', expected: 1, value: 'é'.repeat(32768) }, { field: 'labels', expected: 1, value: ['quote"', 'slash\\'] }] });
  await run({ op: 'create', prefix: 'pd', parent: created.issue.id, request_id: randomUUID(), tool: 'compiler', project: 'other', body: 'child' });
  await run({ op: 'comment', id: created.issue.id, body: 'Unicode 日本語 quote\' slash\\' });
  await source.db.batch([{ sql: 'UPDATE counters SET last_number = 98 WHERE scope = ?', params: ['pd'] }]);
  const memoryRequest = { op: 'memory_create', project: 'p', prefix: 'pd', request_id: randomUUID(), title: 'Fact', body: '日本語の知識' };
  await run(memoryRequest);
  await run({ op: 'memory_delete', project: 'p', id: 'pd-m1', expected: 1 });
  await run({ ...memoryRequest, request_id: randomUUID() });
  await run({ op: 'memory_update', project: 'p', id: 'pd-m2', title: 'Verified fact', body: 'Preserve attribution', expected: 1 });
  const snapshot = source.exportSnapshot();
  const canonical = canonicalSnapshot(snapshot);
  const sha256 = createHash('sha256').update(canonical).digest('hex');
  const migration = snapshotMigration(query, snapshot, sha256);
  assert.equal((await migration.inspect()).state, 'empty');
  assert.throws(() => snapshotMigration(query, snapshot, '0'.repeat(64)), /digest/);
  for (const failAt of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    await reset();
    let writes = 0;
    const interrupted: Query = async statement => {
      const rows = await query(statement);
      if (/^(INSERT|CREATE)/.test(statement.sql) && ++writes === failAt) throw new Error('response lost after commit');
      return rows;
    };
    await assert.rejects(snapshotMigration(interrupted, snapshot, sha256).restore(), /response lost/);
    await migration.restore();
    assert.equal(canonicalSnapshot((await migration.verify()).snapshot), canonical);
    assert.equal((await migration.restore()).result, 'already_present');
  }
  const restored = await migration.verify();
  const roundtripLocation = { directory: join(root, 'roundtrip') };
  initializeStore(roundtripLocation);
  const roundtrip = openStore(roundtripLocation);
  try { roundtrip.importSnapshot(restored.snapshot); assert.equal(canonicalSnapshot(roundtrip.exportSnapshot()), canonical); }
  finally { roundtrip.close(); }
  await query({ sql: "UPDATE issues SET body = 'different' WHERE id = ?", params: [created.issue.id] });
  await assert.rejects(migration.restore(), /differing/);
  await reset();
  await migration.restore();
  await query({ sql: "UPDATE polylinedb_snapshot_claim SET sha256 = ?", params: ['0'.repeat(64)] });
  await assert.rejects(migration.restore(), /another snapshot/);
  await reset();
  let inserted = 0;
  await assert.rejects(snapshotMigration(async statement => {
    const rows = await query(statement);
    if (statement.sql.startsWith('INSERT INTO issues') && ++inserted === 1) throw new Error('interrupted');
    return rows;
  }, snapshot, sha256).restore(), /interrupted/);
  await query({ sql: 'DROP TABLE polylinedb_snapshot_claim', params: [] });
  await assert.rejects(migration.restore(), /no snapshot claim/);
  await reset();
  await migration.restore();
  await query({ sql: 'UPDATE issues SET sort_key = ? WHERE id = ?', params: ['corrupt', created.issue.id] });
  await assert.rejects(migration.verify(), /differing/);
  await reset();
  await Promise.all([migration.restore(), migration.restore()]);
  const remote = d1Executor(database);
  await assert.rejects(executeOperation(remote, parseOperation(memoryRequest), 'test:original'), { code: 'memory_deleted' });
  const nextMemory = await executeOperation(remote, parseOperation({ ...memoryRequest, request_id: randomUUID() }), 'test:original');
  assert('memory' in nextMemory); assert.equal(nextMemory.memory.id, 'pd-m3');
  const replay = await executeOperation(remote, parseOperation(request), 'test:original');
  assert('issue' in replay); assert.equal(replay.issue.body, 'é'.repeat(32768));
  assert.equal(replay.issue.versions.body, 2);
  const next = await executeOperation(remote, parseOperation({ ...request, request_id: randomUUID() }), 'test:original');
  assert('issue' in next); assert.equal(next.issue.id, 'pd-99');
  const child = await executeOperation(remote, parseOperation({ ...request, parent: created.issue.id, request_id: randomUUID() }), 'test:original');
  assert('issue' in child); assert.equal(child.issue.id, 'pd-1.2');
  assert.throws(() => parseQueryOutput([{ success: false, results: [] }]), /successful/);
  assert.throws(() => parseQueryOutput([{ success: true, results: [null] }]), /Invalid/);
  assert.deepEqual(parseQueryOutput([{ success: true, results: [{ n: 1 }] }]), [{ n: 1 }]);
  assert.throws(() => parseTarget({}), /Invalid/);
  process.stdout.write('PASS: workerd snapshot exact roundtrip, nine committed-response-loss resumptions, duplicate/concurrent restore, digest/row/unclaimed conflicts, derived columns, 64 KiB Unicode body, audit/version preservation, comments/counters/requests, request replay and root/child next IDs\n');
} finally { source.close(); rmSync(root, { recursive: true, force: true }); await runtime.dispose(); }
