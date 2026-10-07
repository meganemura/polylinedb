// Exercises the restored-store addition lifecycle against SQLite destinations restored by the current and release 0.1.0 operators.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { rawToSnapshot, tables } from '../scripts/d1-additive-merge.ts';
import { snapshotMigration, type Query, type Statement } from '../scripts/d1-snapshot-store.ts';
import { AdditionRefused, AdditionUnknown, restoredAddition, type Batch } from '../scripts/d1-restored-addition.ts';
import { canonicalSnapshot, canonicalSnapshotV3, convertSnapshotV3 } from '../src/records/snapshot.ts';
import { SCHEMA_V3_SQL, schemaUpgradeStatements } from '../src/records/schema.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { openStore } from '../src/local-store/index.ts';
import { failAt, isAddition, legacyRestore, rowChange, localStore, loseResponse, originalInput, privateDirectory, sqliteBatch } from './fixtures/restored-addition.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";

type Fixture = {
  root: string; original: string; source: string; destinationPath: string; destination: DatabaseSync; batch: Batch;
  restoreWrites: Statement[]; journal(name?: string): string; state(): string; close(): void;
};

function query(database: DatabaseSync): Query {
  return async ({ sql, params }) => database.prepare(sql).all(...params).map(row => ({ ...row }));
}

async function fixture(options: { pauseRestoreAt?: number; emptyOriginal?: boolean } = {}): Promise<Fixture & { resumeRestore(): Promise<unknown> }> {
  const root = mkdtempSync(join(tmpdir(), 'pd-restored-addition-'));
  const original = await originalInput(root, options.emptyOriginal ? null : 'dst');
  const source = await localStore(root, 'source', 'src');
  source.store.close();
  const destinationStore = await localStore(root, 'destination');
  destinationStore.store.close();
  const destination = new DatabaseSync(destinationStore.path);
  destination.exec('PRAGMA foreign_keys = ON');
  const restoreWrites: Statement[] = [];
  let writes = 0;
  let paused: (() => void) | undefined;
  const recording: Query = async statement => {
    if (!/^\s*SELECT/i.test(statement.sql)) {
      writes += 1;
      if (writes === options.pauseRestoreAt) await new Promise<void>(resolve => { paused = resolve; });
      restoreWrites.push(statement);
    }
    return query(destination)(statement);
  };
  const restore = snapshotMigration(recording, original.snapshot, digest(canonicalSnapshot(original.snapshot))).restore();
  if (options.pauseRestoreAt === undefined) await restore;
  else while (!paused) await new Promise(resolve => setImmediate(resolve));
  let journals = 0;
  return {
    root, original: original.path, source: source.path, destinationPath: destinationStore.path, destination, batch: sqliteBatch(destination), restoreWrites,
    journal: name => privateDirectory(root, name ?? `journal-${journals += 1}`),
    state: () => JSON.stringify([destination.prepare(schemaSql).all(), ...[...tables, 'polylinedb_snapshot_claim'].map(table => destination.prepare(`SELECT * FROM ${table}`).all())]),
    resumeRestore: async () => { paused?.(); return restore; },
    close: () => { destination.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, error => error instanceof AdditionRefused && pattern.test(error.message));
}

test('restored addition commits once, archives the checkpoint, fences old restore SQL, and retires the source', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  const result = await restoredAddition(f.batch, journal).run({ original: f.original, source: f.source, connection: 'cloud' });
  assert.equal(result.outcome, 'retired');
  assert.deepEqual(readdirSync(journal).sort(), ['committed.json', 'dispatch-1.json', 'operation.json', 'retired.json', 'verified.json']);
  const objects = f.destination.prepare("SELECT type,name FROM sqlite_master WHERE name LIKE 'polylinedb_%' AND type IN ('table','view') ORDER BY name").all().map(row => `${row.type}:${row.name}`);
  assert.deepEqual(objects, ['table:polylinedb_addition_receipt', 'view:polylinedb_snapshot_claim', 'table:polylinedb_snapshot_claim_archive']);
  assert.equal(f.destination.prepare('SELECT COUNT(*) AS n FROM polylinedb_snapshot_claim').get()?.n, 0);
  const archived = f.destination.prepare('SELECT * FROM polylinedb_snapshot_claim_archive').all();
  assert.equal(archived.length, 1);
  assert.equal(f.destination.prepare('SELECT incarnation FROM memory_store_identity').get()?.incarnation, archived[0]?.incarnation);
  const receipt = f.destination.prepare('SELECT * FROM polylinedb_addition_receipt').get();
  assert.equal(receipt?.operation_id, result.operation_id);
  assert.equal(receipt?.checkpoint_layout, 'four-column');
  assert.equal(receipt?.expected_sha256, result.expected_sha256);
  assert.throws(() => f.destination.exec("UPDATE polylinedb_addition_receipt SET operation_id = 'x'"), /immutable/);
  assert.throws(() => f.destination.exec('DELETE FROM polylinedb_addition_receipt'), /immutable/);
  assert.deepEqual(f.destination.prepare("SELECT id FROM issues WHERE id LIKE 'src-%' ORDER BY id").all().map(row => row.id), ['src-1', 'src-1.1']);

  const after = f.state();
  let changes = 0;
  for (const statement of f.restoreWrites) {
    try { changes += Number(f.destination.prepare(statement.sql).run(...statement.params).changes); } catch (error) {
      assert.match(String(error), /cannot modify polylinedb_snapshot_claim because it is a view/);
    }
  }
  assert.equal(changes, 0);
  assert.equal(f.state(), after);

  const retired = new DatabaseSync(f.source);
  context.after(() => retired.close());
  assert.throws(() => retired.exec("UPDATE issues SET body = 'x'"), /retired\. Use cloud connection cloud/);

  assert.deepEqual(await restoredAddition(f.batch, journal).resume(), result);
  rmSync(join(journal, 'retired.json'));
  assert.deepEqual(await restoredAddition(f.batch, journal).resume(), result, 'a crash after the retirement commit resumes');
  assert.ok(readdirSync(journal).includes('retired.json'));
  await refused(restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' }), /already recorded an addition/);
});

test('a statement prepared before the barrier writes nothing after it', async context => {
  const f = await fixture();
  context.after(f.close);
  const insert = f.restoreWrites.find(statement => statement.sql.startsWith('INSERT INTO comments'));
  assert.ok(insert);
  const prepared = f.destination.prepare(insert.sql.replace('DO NOTHING', 'DO UPDATE SET body = body || \'!\''));
  await restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' });
  const before = f.state();
  assert.equal(prepared.run(...insert.params).changes, 0);
  assert.equal(f.state(), before);
});

test('every failing statement rolls back the whole addition batch', async context => {
  const f = await fixture();
  context.after(f.close);
  const before = f.state();
  let count = 0;
  const counting: Batch = async statements => {
    if (!isAddition(statements)) return f.batch(statements);
    count = statements.length;
    throw new Error('not sent');
  };
  await assert.rejects(restoredAddition(counting, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  assert.ok(count > 20);
  for (let index = 0; index < count; index += 1) {
    const journal = f.journal();
    await assert.rejects(restoredAddition(failAt(f.batch, index), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
    assert.equal(f.state(), before, `statement ${index} left a partial addition`);
  }
  const retried = f.journal();
  await assert.rejects(restoredAddition(failAt(f.batch, 0), retried).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  assert.equal((await restoredAddition(f.batch, retried).resume()).outcome, 'retired');
  assert.deepEqual(readdirSync(retried).filter(name => name.startsWith('dispatch')).sort(), ['dispatch-1.json', 'dispatch-2.json']);
});

test('a lost response resumes as committed without a second addition', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  await assert.rejects(restoredAddition(loseResponse(f.batch, isAddition), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  const result = await restoredAddition(f.batch, journal).resume();
  assert.equal(result.outcome, 'retired');
  assert.deepEqual(readdirSync(journal).filter(name => name.startsWith('dispatch')), ['dispatch-1.json']);
  assert.equal(f.destination.prepare("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'").get()?.n, 2);
});

test('a committed receipt stays committed after later edits, which only block retirement', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  await assert.rejects(restoredAddition(loseResponse(f.batch, isAddition), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  f.destination.exec("UPDATE issues SET body = 'edited after commit', body_v = body_v + 1 WHERE id = 'dst-1'");
  await refused(restoredAddition(f.batch, journal).resume(), /committed, but the destination changed afterward/);
  assert.deepEqual(readdirSync(journal).sort(), ['committed.json', 'dispatch-1.json', 'operation.json']);
});

test('a source edit after freezing blocks retirement without changing the committed outcome', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  await assert.rejects(restoredAddition(loseResponse(f.batch, isAddition), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  const source = new DatabaseSync(f.source);
  context.after(() => source.close());
  source.exec("UPDATE comments SET body = 'late edit'");
  await refused(restoredAddition(f.batch, journal).resume(), /source changed after freezing/);
  assert.ok(readdirSync(journal).includes('verified.json'));
  assert.equal(source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'polylinedb_retired_%'").get()?.n, 0);
});

test('unavailable destination evidence leaves the outcome unknown', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  await assert.rejects(restoredAddition(loseResponse(f.batch, isAddition), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  await assert.rejects(restoredAddition(async () => { throw new Error('offline'); }, journal).resume(), AdditionUnknown);
});

test('a changed preimage without a receipt refuses retry of the frozen packet', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  await assert.rejects(restoredAddition(failAt(f.batch, 0), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  f.destination.exec("UPDATE comments SET body = 'changed'");
  await refused(restoredAddition(f.batch, journal).resume(), /changed after freezing, and no addition receipt exists/);
});

test('refuses missing, mismatched, edited, unknown, and legacy restore evidence', async context => {
  const f = await fixture();
  context.after(f.close);
  const run = (overrides: Partial<{ original: string; source: string; connection: string }> = {}) =>
    restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud', ...overrides });
  await refused(run({ original: join(f.root, 'missing.json') }), /original restore input is missing/);
  const other = await originalInput(f.root, 'oth');
  await refused(run({ original: other.path }), /checkpoint digest differs/);
  const legacyInput = join(f.root, 'legacy.json');
  writeFileSync(legacyInput, JSON.stringify({ format: 'polylinedb.snapshot', version: 3, issues: [], comments: [], counters: [], requests: [], memories: [], memory_counters: [], memory_requests: [] }));
  await refused(run({ original: legacyInput }), /requires snapshot format 5/);
  await refused(run({ connection: 'Bad Name' }), /connection name/);
  const self = await localStore(f.root, 'collision', 'dst');
  self.store.close();
  await refused(run({ source: self.path }), /share|would be undone/);

  const before = f.state();
  const checkpointDigest = String(f.destination.prepare('SELECT sha256 FROM polylinedb_snapshot_claim').get()?.sha256);
  const edits: [string, string, RegExp][] = [
    ["UPDATE comments SET body = 'edited'", "UPDATE comments SET body = 'dst comment'", /differ from the original/],
    ['CREATE TABLE extra(x)', 'DROP TABLE extra', /not canonical schema 6/],
    ["UPDATE memory_store_identity SET incarnation = (SELECT original_incarnation FROM polylinedb_snapshot_claim)", "UPDATE memory_store_identity SET incarnation = (SELECT incarnation FROM polylinedb_snapshot_claim)", /identity differs/],
    [`UPDATE polylinedb_snapshot_claim SET sha256 = '${'0'.repeat(64)}'`, `UPDATE polylinedb_snapshot_claim SET sha256 = '${checkpointDigest}'`, /checkpoint digest differs/],
  ];
  for (const [edit, undo, pattern] of edits) {
    f.destination.exec(edit);
    await refused(run(), pattern);
    f.destination.exec(undo);
    assert.equal(f.state(), before, edit);
  }

  const destinationStore = openStore({ directory: join(f.root, 'destination') });
  const scope = await executeOperation(destinationStore.db, parseOperation({ op: 'claim_show', issue_id: 'dst-1.1' }), 'late');
  assert.ok('claim' in scope);
  await executeOperation(destinationStore.db, parseOperation({ op: 'claim_acquire', issue_id: 'dst-1.1', incarnation: scope.claim.store_incarnation, session_id: randomUUID(), request_id: randomUUID(), agent_label: null }), 'late');
  destinationStore.close();
  await refused(run(), /differ from the original/);
});

test('refuses a snapshot 5 input for the release 0.1.0 checkpoint layout', async context => {
  const f = await fixture();
  context.after(f.close);
  const checkpoint = f.destination.prepare('SELECT sha256 FROM polylinedb_snapshot_claim').get();
  f.destination.exec('DROP TABLE polylinedb_snapshot_claim');
  f.destination.exec('CREATE TABLE polylinedb_snapshot_claim (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sha256 TEXT NOT NULL)');
  f.destination.prepare('INSERT INTO polylinedb_snapshot_claim VALUES (1, ?)').run(String(checkpoint?.sha256));
  await refused(restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' }), /two-column checkpoint requires snapshot format 3/);
});

type LegacyFixture = { root: string; original: string; source: string; destination: DatabaseSync; batch: Batch; journal(): string; finishRestore(): void; rows(): Record<string, Record<string, unknown>[]>; state(): string; close(): void };

/** Applies the first `restoredWrites` recorded release 0.1.0 writes to a schema 3 store, then upgrades it to schema 6 unless told not to. */
async function legacyFixture(restoredWrites = legacyRestore.writes.length, options: { upgrade?: boolean } = {}): Promise<LegacyFixture> {
  const root = mkdtempSync(join(tmpdir(), 'pd-restored-addition-legacy-'));
  const original = join(root, 'original-v3.json');
  writeFileSync(original, JSON.stringify(legacyRestore.input));
  const source = await localStore(root, 'source', 'src');
  source.store.close();
  const destination = new DatabaseSync(':memory:');
  destination.exec('PRAGMA foreign_keys = ON');
  destination.exec(SCHEMA_V3_SQL);
  const apply = (writes: readonly Statement[]) => { for (const statement of writes) destination.prepare(statement.sql).run(...statement.params); };
  apply(legacyRestore.writes.slice(0, restoredWrites));
  if (options.upgrade !== false) {
    destination.exec('BEGIN');
    for (const sql of schemaUpgradeStatements(3)) destination.exec(sql);
    destination.exec('COMMIT');
  }
  let journals = 0;
  const rows = () => Object.fromEntries(tables.map(table => [table, destination.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]));
  return {
    root, original, source: source.path, destination, batch: sqliteBatch(destination),
    journal: () => privateDirectory(root, `journal-${journals += 1}`),
    finishRestore: () => apply(legacyRestore.writes.slice(restoredWrites)),
    rows,
    state: () => JSON.stringify([destination.prepare(schemaSql).all(), ...[...tables, 'polylinedb_snapshot_claim'].map(table => destination.prepare(`SELECT * FROM ${table}`).all())]),
    close: () => { destination.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('the release 0.1.0 checkpoint digests the snapshot 3 canonical form, which snapshot 5 canonicalization does not reproduce', async context => {
  assert.equal(legacyRestore.schema_sql, SCHEMA_V3_SQL);
  assert.equal(legacyRestore.sha256, '602922dc9b822f491f5ebc0bbf8c2eaf68154499ee3212d841ce4664cafd67b2');
  assert.equal(digest(canonicalSnapshotV3(legacyRestore.input)), legacyRestore.sha256);
  assert.notEqual(digest(canonicalSnapshot(convertSnapshotV3(legacyRestore.input))), legacyRestore.sha256);
  const f = await legacyFixture();
  context.after(f.close);
  assert.deepEqual(f.destination.prepare('SELECT * FROM polylinedb_snapshot_claim').all().map(row => ({ ...row })), [{ singleton: 1, sha256: legacyRestore.sha256 }]);
});

test('a release 0.1.0 restore upgraded to schema 6 holds the converted snapshot 3 rows', async context => {
  const f = await legacyFixture();
  context.after(f.close);
  assert.equal(canonicalSnapshot(rawToSnapshot(f.rows())), canonicalSnapshot(convertSnapshotV3(legacyRestore.input)));
  assert.deepEqual(f.destination.prepare('SELECT * FROM dependency_revisions ORDER BY dependent_id').all().map(row => ({ ...row })), [
    { dependent_id: 'old-1', revision: 1 }, { dependent_id: 'old-1.1', revision: 1 }, { dependent_id: 'old-2', revision: 1 },
  ]);
  assert.deepEqual(f.destination.prepare('SELECT * FROM project_memory_revisions ORDER BY project').all().map(row => ({ ...row })), [{ project: 'legacy', revision: 1 }, { project: 'other', revision: 1 }]);
  assert.equal(f.destination.prepare('SELECT COUNT(*) AS n FROM issue_claims').get()?.n, 0);
});

test('a release 0.1.0 restore upgraded to schema 6 accepts one addition and fences that release restore SQL', async context => {
  const f = await legacyFixture();
  context.after(f.close);
  const journal = f.journal();
  const result = await restoredAddition(f.batch, journal).run({ original: f.original, source: f.source, connection: 'cloud' });
  assert.equal(result.outcome, 'retired');
  const objects = f.destination.prepare("SELECT type,name FROM sqlite_master WHERE name LIKE 'polylinedb_%' AND type IN ('table','view') ORDER BY name").all().map(row => `${row.type}:${row.name}`);
  assert.deepEqual(objects, ['table:polylinedb_addition_receipt', 'view:polylinedb_snapshot_claim', 'table:polylinedb_snapshot_claim_archive']);
  assert.deepEqual(f.destination.prepare('SELECT * FROM polylinedb_snapshot_claim_archive').all().map(row => ({ ...row })), [{ singleton: 1, sha256: legacyRestore.sha256 }]);
  const receipt = f.destination.prepare('SELECT * FROM polylinedb_addition_receipt').get();
  assert.equal(receipt?.checkpoint_layout, 'two-column');
  assert.equal(receipt?.original_sha256, legacyRestore.sha256);
  assert.equal(receipt?.destination_incarnation, f.destination.prepare('SELECT incarnation FROM memory_store_identity').get()?.incarnation);
  assert.deepEqual(f.destination.prepare("SELECT id FROM issues WHERE id LIKE 'src-%' ORDER BY id").all().map(row => row.id), ['src-1', 'src-1.1']);

  const after = f.state();
  // After DDL, a statement reports the previous changes count, and CREATE TABLE IF NOT EXISTS is a no-op against the view.
  const totalChanges = () => Number(f.destination.prepare('SELECT total_changes() AS n').get()?.n);
  const changed = totalChanges();
  const refusals: string[] = [];
  for (const statement of legacyRestore.writes) {
    try { f.destination.prepare(statement.sql).run(...statement.params); } catch (error) { refusals.push(String(error)); }
  }
  assert.equal(totalChanges(), changed);
  assert.deepEqual(refusals.map(message => /cannot modify polylinedb_snapshot_claim because it is a view/.test(message)), [true]);
  assert.equal(f.state(), after);

  assert.deepEqual(await restoredAddition(f.batch, journal).resume(), result);
  await refused(restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' }), /already recorded an addition/);
});

test('a release 0.1.0 restore paused at every write boundary keeps the addition refused until restoration completes', async () => {
  const total = legacyRestore.writes.length;
  const revisions = new Set<number>();
  for (let pause = 0; pause < total; pause += 1) {
    const f = await legacyFixture(pause);
    try {
      await assert.rejects(restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionRefused, `write ${pause + 1}`);
      f.finishRestore();
      revisions.add(Number(f.destination.prepare("SELECT revision FROM project_memory_revisions WHERE project = 'legacy'").get()?.revision));
      assert.equal((await restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' })).outcome, 'retired', `write ${pause + 1}`);
    } finally { f.close(); }
  }
  assert.deepEqual([...revisions].sort(), [1, 2], 'memory inserts after the upgrade raise project revisions, which the addition guards but does not compare');
});

test('refuses missing, invalid, mismatched, edited, and unupgraded release 0.1.0 evidence', async context => {
  const f = await legacyFixture();
  context.after(f.close);
  const run = (overrides: Partial<{ original: string }> = {}) => restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud', ...overrides });
  await refused(run({ original: join(f.root, 'missing.json') }), /original restore input is missing/);
  const invalid = join(f.root, 'invalid.json');
  writeFileSync(invalid, JSON.stringify({ ...legacyRestore.input as object, issues: 'not a list' }));
  await refused(run({ original: invalid }), /not a valid snapshot/);
  const empty = join(f.root, 'empty.json');
  writeFileSync(empty, JSON.stringify({ format: 'polylinedb.snapshot', version: 3, issues: [], comments: [], counters: [], requests: [], memories: [], memory_counters: [], memory_requests: [] }));
  await refused(run({ original: empty }), /checkpoint digest differs/);

  const before = f.state();
  const edits: [string, string, RegExp][] = [
    ["UPDATE comments SET body = 'edited' WHERE body = 'first comment'", "UPDATE comments SET body = 'first comment' WHERE body = 'edited'", /differ from the original/],
    ["DELETE FROM dependency_revisions WHERE dependent_id = 'old-2'", "INSERT INTO dependency_revisions VALUES ('old-2', 1)", /differ from the original|not a canonical store/],
    [`UPDATE polylinedb_snapshot_claim SET sha256 = '${'0'.repeat(64)}'`, `UPDATE polylinedb_snapshot_claim SET sha256 = '${legacyRestore.sha256}'`, /checkpoint digest differs/],
    ['ALTER TABLE polylinedb_snapshot_claim ADD COLUMN note TEXT', 'ALTER TABLE polylinedb_snapshot_claim DROP COLUMN note', /not canonical schema 6/],
  ];
  for (const [edit, undo, pattern] of edits) {
    f.destination.exec(edit);
    await refused(run(), pattern);
    f.destination.exec(undo);
    assert.equal(f.state(), before, edit);
  }

  const unupgraded = await legacyFixture(legacyRestore.writes.length, { upgrade: false });
  context.after(unupgraded.close);
  await refused(restoredAddition(unupgraded.batch, unupgraded.journal()).run({ original: unupgraded.original, source: unupgraded.source, connection: 'cloud' }), /not canonical schema 6/);
});

test('refuses an atomic packet above the statement limit before journaling it', async context => {
  const f = await fixture();
  context.after(f.close);
  const before = f.state();
  const journal = f.journal();
  await refused(restoredAddition(f.batch, journal).run({ original: f.original, source: f.source, connection: 'cloud', maximumStatements: 20 }), /above the limit of 20/);
  assert.deepEqual(readdirSync(journal), []);
  assert.equal(f.state(), before);
});

test('old restore paused at every write boundary keeps the addition refused until restoration completes', async () => {
  const probe = await fixture();
  const total = probe.restoreWrites.length;
  probe.close();
  assert.ok(total > 10);
  for (let pause = 1; pause <= total; pause += 1) {
    const f = await fixture({ pauseRestoreAt: pause });
    try {
      await assert.rejects(restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionRefused, `write ${pause}`);
      await f.resumeRestore();
      assert.equal((await restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' })).outcome, 'retired', `write ${pause}`);
    } finally { f.close(); }
  }
});

test('a destination change racing the commit rolls back the whole batch for every guarded range', async () => {
  const columns = (database: DatabaseSync, table: string) => database.prepare(`PRAGMA table_info(${table})`).all().map(column => ({ name: String(column.name), type: String(column.type), pk: Number(column.pk) }));
  const races: { name: string; changes(database: DatabaseSync): string[] }[] = [
    ...tables.map(table => ({ name: table, changes: (database: DatabaseSync) => rowChange(table, columns(database, table)) })),
    { name: 'trailing counter range', changes: () => ["INSERT INTO counters(scope, last_number) VALUES ('zzz', 1)"] },
    { name: 'checkpoint row', changes: () => [`UPDATE polylinedb_snapshot_claim SET sha256 = '${'0'.repeat(64)}'`] },
    { name: 'schema', changes: () => ['CREATE TABLE extra(x)'] },
  ];
  for (const race of races) {
    const f = await fixture();
    try {
      let changed = false;
      const racing: Batch = async statements => {
        if (isAddition(statements)) {
          for (const sql of race.changes(f.destination)) {
            try { f.destination.exec(sql); changed = true; break; } catch { /* a trigger or constraint forbids this form; try the next one */ }
          }
          assert.ok(changed, `no change applies to ${race.name}`);
        }
        return f.batch(statements);
      };
      const journal = f.journal();
      await assert.rejects(restoredAddition(racing, journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown, race.name);
      assert.ok(changed, race.name);
      await assert.rejects(restoredAddition(f.batch, journal).resume(), (error: unknown) => error instanceof AdditionRefused && /changed after freezing|not canonical schema 6/.test(error.message), race.name);
      assert.equal(f.destination.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('polylinedb_addition_receipt', 'polylinedb_snapshot_claim_archive')").get()?.n, 0, race.name);
      assert.equal(f.destination.prepare("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'").get()?.n, 0, race.name);
    } finally { f.close(); }
  }
});

test('an empty original input requires the same checks and atomic barrier', async context => {
  const empty = await fixture({ emptyOriginal: true });
  context.after(empty.close);
  assert.deepEqual(empty.restoreWrites, [], 'the current restore treats an empty destination as already identical');
  await refused(restoredAddition(empty.batch, empty.journal()).run({ original: empty.original, source: empty.source, connection: 'cloud' }), /not canonical schema 6 with a recognized restore checkpoint/);

  const writes = (await fixture()).restoreWrites;
  const emptyDigest = digest(canonicalSnapshot(JSON.parse((await import('node:fs')).readFileSync(empty.original, 'utf8'))));
  const checkpointWrites = writes.slice(0, 3).map(statement => ({ sql: statement.sql, params: statement.params.map(() => emptyDigest) }));
  assert.match(checkpointWrites[2]?.sql ?? '', /^UPDATE memory_store_identity/);
  for (const [index, statement] of checkpointWrites.entries()) {
    empty.destination.prepare(statement.sql).run(...statement.params);
    const run = restoredAddition(empty.batch, empty.journal()).run({ original: empty.original, source: empty.source, connection: 'cloud' });
    if (index < 2) await refused(run, /recognized restore checkpoint|exactly one restore checkpoint|identity differs/);
    else assert.equal((await run).outcome, 'retired');
  }
  assert.equal(empty.destination.prepare('SELECT COUNT(*) AS n FROM polylinedb_snapshot_claim').get()?.n, 0);
  assert.equal(empty.destination.prepare('SELECT COUNT(*) AS n FROM polylinedb_snapshot_claim_archive').get()?.n, 1);
});

test('the barrier keeps late restore writes from bringing back rows deleted after the addition', async context => {
  const deletions = ["DELETE FROM dependencies WHERE dependent_id LIKE 'dst-%'", "DELETE FROM comments WHERE body = 'dst comment'"];
  const replay = (f: Fixture) => { for (const statement of f.restoreWrites) try { f.destination.prepare(statement.sql).run(...statement.params); } catch { /* the view refuses checkpoint inserts */ } };
  const control = await fixture();
  context.after(control.close);
  for (const sql of deletions) assert.equal(control.destination.prepare(sql).run().changes, 1, sql);
  replay(control);
  assert.equal(control.destination.prepare("SELECT COUNT(*) AS n FROM comments WHERE body = 'dst comment'").get()?.n, 1, 'without the barrier the replay restores the comment');

  const f = await fixture();
  context.after(f.close);
  await restoredAddition(f.batch, f.journal()).run({ original: f.original, source: f.source, connection: 'cloud' });
  for (const sql of deletions) assert.equal(f.destination.prepare(sql).run().changes, 1, sql);
  const deleted = f.state();
  replay(f);
  assert.equal(f.state(), deleted);
});

test('a schema change after a lost response still finds the committed receipt', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  await assert.rejects(restoredAddition(loseResponse(f.batch, isAddition), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  f.destination.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY)');
  await refused(restoredAddition(f.batch, journal).resume(), /not canonical schema 6/);
  assert.deepEqual(readdirSync(journal).sort(), ['committed.json', 'dispatch-1.json', 'operation.json']);
});

test('a batch that returns without committing is unknown after one dispatch', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  const dropped: Batch = async statements => isAddition(statements) ? [] : f.batch(statements);
  await assert.rejects(restoredAddition(dropped, journal).run({ original: f.original, source: f.source, connection: 'cloud' }), (error: unknown) => error instanceof AdditionUnknown && /shows no receipt/.test(error.message));
  assert.deepEqual(readdirSync(journal).filter(name => name.startsWith('dispatch')), ['dispatch-1.json']);
});

test('a terminal layout without its receipt leaves the outcome unknown', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  await assert.rejects(restoredAddition(loseResponse(f.batch, isAddition), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  f.destination.exec('DROP TRIGGER polylinedb_addition_receipt_immutable_delete');
  f.destination.exec('DELETE FROM polylinedb_addition_receipt');
  f.destination.exec("CREATE TRIGGER polylinedb_addition_receipt_immutable_delete BEFORE DELETE ON polylinedb_addition_receipt BEGIN SELECT RAISE(ABORT, 'The addition receipt is immutable'); END");
  await assert.rejects(restoredAddition(f.batch, journal).resume(), (error: unknown) => error instanceof AdditionUnknown && /no single addition receipt/.test(error.message));
});

test('resume refuses a journal whose frozen packet was edited', async context => {
  const f = await fixture();
  context.after(f.close);
  const journal = f.journal();
  await assert.rejects(restoredAddition(failAt(f.batch, 0), journal).run({ original: f.original, source: f.source, connection: 'cloud' }), AdditionUnknown);
  const path = join(journal, 'operation.json');
  const operation = JSON.parse(readFileSync(path, 'utf8'));
  const insert = operation.statements.findIndex((statement: Statement) => statement.sql.startsWith('INSERT INTO "comments"'));
  assert.ok(insert > 0);
  operation.statements[insert].params[0] = operation.statements[insert].params[0].replace('src comment', 'other comment');
  writeFileSync(path, JSON.stringify(operation));
  await refused(restoredAddition(f.batch, journal).resume(), /differs from its frozen digest/);
  writeFileSync(path, '{');
  await refused(restoredAddition(f.batch, journal).resume(), /malformed/);
  assert.equal(f.destination.prepare("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'").get()?.n, 0);
});

test('a missing source store is refused without creating a file', async context => {
  const f = await fixture();
  context.after(f.close);
  const missing = join(f.root, 'missing.sqlite');
  await refused(restoredAddition(f.batch, f.journal()).run({ original: f.original, source: missing, connection: 'cloud' }), /source store is missing/);
  assert.equal(existsSync(missing), false);
});
