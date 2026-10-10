// Checks graph snapshots and historical upgrade recovery against canonical SQLite stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { node } from 'solarsql/node';
import { initializeStore, openStore, upgradeStore, exportHistoricalSnapshot } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { SCHEMA_SQL, SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_V6_SQL, canonicalSnapshot, parseSnapshot, convertSnapshotV2, convertSnapshotV3 } from '../src/records/persistence.ts';
import type { SqlExecutor } from '../src/records/persistence.ts';
import { snapshotMigration } from '../scripts/d1-snapshot-store.ts';
import { createHash } from 'node:crypto';
import { withoutChangeWriter } from './fixtures/legacy-schema.ts';

function root(t: test.TestContext) { const directory = mkdtempSync(join(tmpdir(), 'pd-graph-persistence-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
function executor(db: DatabaseSync): SqlExecutor { return { reads: node(db), async batch(statements) { db.exec('BEGIN IMMEDIATE'); try { const rows = statements.map(statement => ({ rows: db.prepare(statement.sql).all(...statement.params) })); db.exec('COMMIT'); return rows; } catch (error) { db.exec('ROLLBACK'); throw error; } } }; }
const create = (prefix: string) => parseOperation({ op: 'create', prefix, request_id: crypto.randomUUID(), tool: 'test', project: 'test', body: 'Historical body' });
test('schema 2/3/4/5/6 upgrades preserve canonical DDL and creation receipt bytes', async t => {
  const base = root(t);
  for (const [version, ddl] of [[2, SCHEMA_V2_SQL], [3, SCHEMA_V3_SQL], [4, SCHEMA_V4_SQL], [5, SCHEMA_V5_SQL], [6, SCHEMA_V6_SQL]] as const) {
    const directory = join(base, `v${version}`); mkdirSync(directory, { mode: 0o700 }); const path = join(directory, 'polylinedb.sqlite');
    const db = new DatabaseSync(path); db.exec(ddl); const request = create('old');
    const first = await executeOperation(withoutChangeWriter(executor(db)), request, 'old:author');
    chmodSync(path, 0o600); const requests = db.prepare('SELECT * FROM requests').all(); const oldSnapshot = exportHistoricalSnapshot({ directory });
    db.close(); chmodSync(path, 0o600);
    assert.equal(upgradeStore({ directory }).version, 7); assert.equal(upgradeStore({ directory }).result, 'already_current');
    const upgraded = new DatabaseSync(path); const reference = new DatabaseSync(':memory:'); reference.exec(SCHEMA_SQL);
    const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
    assert.deepEqual(upgraded.prepare(sql).all(), reference.prepare(sql).all()); assert.deepEqual(upgraded.prepare('SELECT * FROM requests').all(), requests);
    upgraded.close(); reference.close(); const store = openStore({ directory });
    try { assert.deepEqual(await executeOperation(store.db, request, 'old:author'), first); assert.equal(canonicalSnapshot(store.exportSnapshot()), canonicalSnapshot(oldSnapshot)); } finally { store.close(); }
  }
});
test('canonical retired schema 4 rejects upgrade without writes and exports through read-only recovery', async t => {
  const directory = join(root(t), 'retired'); mkdirSync(directory, { mode: 0o700 }); const path = join(directory, 'polylinedb.sqlite');
  const db = new DatabaseSync(path); db.exec(SCHEMA_V4_SQL); await executeOperation(withoutChangeWriter(executor(db)), create('old'), 'old:author');
  const tables = ['issues','comments','counters','requests','memories','memory_counters','memory_requests','memory_store_identity','project_memory_revisions'];
  for (const table of tables) for (const op of ['INSERT','UPDATE','DELETE']) db.exec(`CREATE TRIGGER "polylinedb_retired_${table}_${op.toLowerCase()}" BEFORE ${op} ON "${table}" BEGIN SELECT RAISE(ABORT, 'This local database is retired. Use cloud connection archive.'); END`);
  const before = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(); db.close(); chmodSync(path, 0o600);
  assert.throws(() => upgradeStore({ directory }), { code: 'store_retired' });
  const recovered = exportHistoricalSnapshot({ directory }); assert.equal(recovered.version, 5); assert.equal(recovered.dependency_revisions[0]?.revision, 1);
  const after = new DatabaseSync(path, { readOnly: true }); assert.deepEqual(after.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), before); assert.equal(after.prepare('SELECT version FROM schema_version').get()?.version, 4); after.close();
});
test('graph roundtrip preserves removed-edge receipts, validates graph rows and resumes trigger baselines', async t => {
  const base = root(t); const directory = join(base, 'source'); initializeStore({ directory }); const source = openStore({ directory }); t.after(() => source.close());
  const run = (input: unknown) => executeOperation(source.db, parseOperation(input), 'test');
  for (let i = 0; i < 12; i++) await executeOperation(source.db, create('pd'), 'test');
  const add = { op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-10', expected_revision: 1, request_id: crypto.randomUUID() };
  const original = await run(add); await run({ ...add, op: 'dependency_remove', expected_revision: 2, request_id: crypto.randomUUID() });
  await run({ ...add, blocker_id: 'pd-2', expected_revision: 3, request_id: crypto.randomUUID() });
  await run({ ...add, blocker_id: 'pd-10', expected_revision: 4, request_id: crypto.randomUUID() });
  const snapshot = source.exportSnapshot(); const canonical = canonicalSnapshot(snapshot);
  const destination = join(base, 'destination'); initializeStore({ directory: destination }); const restored = openStore({ directory: destination });
  try { assert.equal(restored.importSnapshot(snapshot).dependency_requests, 4); assert.equal(restored.importSnapshot(snapshot).result, 'already_present'); assert.equal(canonicalSnapshot(restored.exportSnapshot()), canonical); assert.deepEqual(await executeOperation(restored.db, parseOperation(add), 'test'), original); } finally { restored.close(); }
  assert.throws(() => parseSnapshot({ ...snapshot, dependencies: [...snapshot.dependencies, { dependent_id: 'pd-2', blocker_id: 'pd-1' }] }), { code: 'invalid_snapshot' });
  assert.throws(() => parseSnapshot({ ...snapshot, dependency_requests: [...snapshot.dependency_requests, snapshot.dependency_requests[0]] }), { code: 'invalid_snapshot' });
  const { dependencies: _, dependency_revisions: __, dependency_requests: ___, issue_claims: _claims, claim_requests: _claimRequests, ...old3 } = snapshot;
  const converted3 = convertSnapshotV3({ ...old3, version: 3 }); assert.deepEqual(converted3.dependency_revisions.map(row => row.revision), Array(12).fill(1));
  const { memories: ____, memory_counters: _____, memory_requests: ______, ...old2 } = old3;
  assert.equal(convertSnapshotV2({ ...old2, version: 2 }).issues.length, 12);
  const remote = new DatabaseSync(':memory:'); t.after(() => remote.close()); remote.exec(SCHEMA_SQL); let failOnce = true;
  const digest = createHash('sha256').update(canonical).digest('hex');
  const migration = snapshotMigration(async statement => { const rows = remote.prepare(statement.sql).all(...statement.params); if (failOnce && statement.sql.startsWith('INSERT INTO issues')) { failOnce = false; throw new Error('Lost committed response'); } return rows; }, snapshot, digest);
  await assert.rejects(migration.restore(), /Lost committed response/); assert.equal((await migration.inspect()).state, 'resumable');
  assert.equal((await migration.restore()).result, 'restored'); assert.equal(canonicalSnapshot((await migration.verify()).snapshot), canonical);
});
test('export lists the blockers of one dependent in issue number order', async t => {
  const directory = join(root(t), 'store'); initializeStore({ directory }); const store = openStore({ directory }); t.after(() => store.close());
  for (let i = 0; i < 10; i++) await executeOperation(store.db, create('pd'), 'test');
  await executeOperation(store.db, parseOperation({ op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-10', expected_revision: 1, request_id: crypto.randomUUID() }), 'test');
  await executeOperation(store.db, parseOperation({ op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-9', expected_revision: 2, request_id: crypto.randomUUID() }), 'test');
  assert.deepEqual(store.exportSnapshot().dependencies, [{ dependent_id: 'pd-1', blocker_id: 'pd-9' }, { dependent_id: 'pd-1', blocker_id: 'pd-10' }]);
});

test('operator inspection rejects orphan edges instead of hiding them behind tuple joins', async t => {
  const directory = join(root(t), 'empty'); initializeStore({ directory }); const store = openStore({ directory }); const snapshot = store.exportSnapshot(); store.close();
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec(SCHEMA_SQL); db.exec("PRAGMA foreign_keys = OFF; INSERT INTO dependencies VALUES ('pd-1','pd-2')");
  const migration = snapshotMigration(async statement => db.prepare(statement.sql).all(...statement.params), snapshot, createHash('sha256').update(canonicalSnapshot(snapshot)).digest('hex'));
  await assert.rejects(migration.inspect(), /Invalid dependency tuple page/); await assert.rejects(migration.verify(), /Invalid dependency tuple page/);
});
