// Exercises the restored-store addition lifecycle against workerd D1 restored by the current and release 0.1.0 operators.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotMigration, type Query, type Statement } from '../scripts/d1-snapshot-store.ts';
import { AdditionRefused, AdditionUnknown, restoredAddition, type Batch } from '../scripts/d1-restored-addition.ts';
import { tables } from '../scripts/d1-additive-merge.ts';
import { canonicalSnapshot } from '../src/records/snapshot.ts';
import { SCHEMA_STATEMENTS, SCHEMA_V3_SQL, schemaUpgradeStatements } from '../src/records/schema.ts';
import { d1Relay, d1RelayModule } from './fixtures/d1-relay.ts';
import { failAt, isAddition, legacyRestore, localStore, loseResponse, originalInput, privateDirectory, routingEnvironment } from './fixtures/restored-addition.ts';

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: {
  name: 'restored-addition-test', compatibilityDate: '2026-09-25', manifest: d1RelayModule,
  env: { DB: { type: 'd1', name: 'restored-addition-test' } },
} }] });
const root = mkdtempSync(join(tmpdir(), 'pd-restored-addition-d1-'));
const objects = "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA','_cf_KV') AND type IN ('table','view')";
try {
  const entry: URL = await runtime.ready;
  const database = d1Relay(entry, 'DB');
  const query: Query = async ({ sql, params }) => (await database.prepare(sql).bind(...params).all()).results;
  const batch: Batch = async statements => (await database.batch(statements.map(({ sql, params }) => database.prepare(sql).bind(...params)))).map(reply => reply.results);
  const changes = async (statement: Statement) => {
    const { meta } = await database.prepare(statement.sql).bind(...statement.params).run();
    assert.ok(meta !== null && typeof meta === 'object' && 'changes' in meta && typeof meta.changes === 'number');
    return meta.changes;
  };
  const state = async () => JSON.stringify(await batch([{ sql: `${objects} ORDER BY name`, params: [] }, ...tables.map(table => ({ sql: `SELECT * FROM ${table} ORDER BY rowid`, params: [] }))]));
  const count = async (sql: string) => Number((await query({ sql, params: [] }))[0]?.n);

  const original = await originalInput(root);
  const sha256 = createHash('sha256').update(canonicalSnapshot(original.snapshot)).digest('hex');
  let sources = 0;
  const environments = new Map<string, NodeJS.ProcessEnv>();
  /** Each run retires its own source, so each gets a fresh source and the routing settings that select it. */
  const source = async (directory: string) => {
    const made = await localStore(root, `source-${sources += 1}`, 'src');
    made.store.close();
    environments.set(directory, routingEnvironment(root, made.path));
    return made.path;
  };
  const owner = (port: Batch, directory: string) => {
    const environment = environments.get(directory);
    assert.ok(environment, 'every journal gets its private connection settings from run');
    return restoredAddition(port, directory, environment);
  };
  let journals = 0;
  const journal = () => privateDirectory(root, `journal-${journals += 1}`);

  const reset = async (statements: readonly string[] = SCHEMA_STATEMENTS) => {
    const existing = await query({ sql: objects, params: [] });
    for (const { type, name } of existing.filter(object => object.type === 'view')) await query({ sql: `DROP VIEW "${String(name)}"`, params: [] });
    for (const table of ['polylinedb_addition_receipt', 'polylinedb_snapshot_claim_archive', 'polylinedb_snapshot_claim', 'extra', 'claim_requests', 'issue_claims', 'dependency_requests', 'dependencies', 'dependency_revisions', 'memory_requests', 'memory_counters', 'memories', 'project_memory_revisions', 'memory_store_identity', 'comments', 'requests', 'counters', 'issues', 'schema_version']) {
      if (existing.some(object => object.type === 'table' && object.name === table)) await query({ sql: `DROP TABLE ${table}`, params: [] });
    }
    await database.batch(statements.map(sql => database.prepare(sql)));
  };
  const restore = async (pauseAt?: number) => {
    const writes: Statement[] = [];
    let release: (() => void) | undefined;
    const recording: Query = async statement => {
      if (!/^\s*SELECT/i.test(statement.sql)) {
        if (writes.length + 1 === pauseAt) await new Promise<void>(resolve => { release = resolve; });
        writes.push(statement);
      }
      return query(statement);
    };
    await reset();
    const done = snapshotMigration(recording, original.snapshot, sha256).restore();
    if (pauseAt === undefined) await done;
    else while (!release) await new Promise(resolve => setImmediate(resolve));
    return { writes, resume: async () => { release?.(); await done; } };
  };
  const run = async (port: Batch = batch, directory = journal(), maximumStatements?: number) => {
    const path = await source(directory);
    return owner(port, directory).run({ original: original.path, source: path, connection: 'cloud', ...(maximumStatements === undefined ? {} : { maximumStatements }) });
  };

  const { writes } = await restore();
  const first = journal();
  const result = await run(batch, first);
  assert.equal(result.outcome, 'routed');
  assert.deepEqual(await query({ sql: `${objects} AND name LIKE 'polylinedb_%' ORDER BY name`, params: [] }), [
    { type: 'table', name: 'polylinedb_addition_receipt' }, { type: 'view', name: 'polylinedb_snapshot_claim' }, { type: 'table', name: 'polylinedb_snapshot_claim_archive' },
  ]);
  assert.equal(await count('SELECT COUNT(*) AS n FROM polylinedb_snapshot_claim'), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM polylinedb_snapshot_claim_archive'), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'"), 2);
  assert.equal((await query({ sql: 'SELECT operation_id FROM polylinedb_addition_receipt', params: [] }))[0]?.operation_id, result.operation_id);
  await assert.rejects(query({ sql: 'DELETE FROM polylinedb_addition_receipt', params: [] }), /immutable/);
  assert.deepEqual(await owner(batch, first).resume(), result);
  const barrierState = await state();
  let replayed = 0;
  for (const statement of writes) {
    try { replayed += await changes(statement); } catch (error) { assert.match(String(error), /cannot modify polylinedb_snapshot_claim because it is a view/); }
  }
  assert.equal(replayed, 0);
  assert.equal(await state(), barrierState);
  await assert.rejects(run(), (error: unknown) => error instanceof AdditionRefused && /already recorded/.test(error.message));

  await restore();
  const before = await state();
  let packet = 0;
  await assert.rejects(run(async statements => { if (!isAddition(statements)) return batch(statements); packet = statements.length; throw new Error('not sent'); }), AdditionUnknown);
  for (let index = 0; index < packet; index += 1) {
    await assert.rejects(run(failAt(batch, index)), AdditionUnknown);
    assert.equal(await state(), before, `statement ${index} left a partial addition`);
  }
  await assert.rejects(run(batch, journal(), 20), (error: unknown) => error instanceof AdditionRefused && /above the limit of 20/.test(error.message));
  assert.equal(await state(), before);

  const races = [
    `UPDATE polylinedb_snapshot_claim SET sha256 = '${'0'.repeat(64)}'`,
    'UPDATE memory_store_identity SET incarnation = lower(hex(randomblob(16)))',
    'UPDATE project_memory_revisions SET revision = revision + 1',
    "UPDATE issues SET body = body || 'x' WHERE id = 'dst-1'",
    "INSERT INTO counters(scope, last_number) VALUES ('zzz', 1)",
    'CREATE TABLE extra(x)',
  ];
  for (const race of races) {
    await restore();
    const directory = journal();
    await assert.rejects(run(async statements => { if (isAddition(statements)) await query({ sql: race, params: [] }); return batch(statements); }, directory), AdditionUnknown, race);
    await assert.rejects(owner(batch, directory).resume(), (error: unknown) => error instanceof AdditionRefused, race);
    assert.equal(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('polylinedb_addition_receipt','polylinedb_snapshot_claim_archive')"), 0, race);
    assert.equal((await owner(batch, directory).releaseSource()).outcome, 'released', race);
  }

  await restore();
  const lost = journal();
  await assert.rejects(run(loseResponse(batch, isAddition), lost), AdditionUnknown);
  assert.equal((await owner(batch, lost).resume()).outcome, 'routed');
  assert.deepEqual(readdirSync(lost).filter(name => name.startsWith('dispatch')), ['dispatch-1.json']);
  assert.equal(await count("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'"), 2);

  await restore();
  const edited = journal();
  await assert.rejects(run(loseResponse(batch, isAddition), edited), AdditionUnknown);
  await query({ sql: "UPDATE comments SET body = 'edited after commit'", params: [] });
  await assert.rejects(owner(batch, edited).resume(), (error: unknown) => error instanceof AdditionRefused && /committed, but the destination changed afterward/.test(error.message));
  assert.deepEqual(readdirSync(edited).sort(), ['committed.json', 'dispatch-1.json', 'operation.json', 'retired.json']);
  assert.equal((await owner(batch, edited).resume({ acceptDestinationEdits: true })).outcome, 'routed');
  assert.ok(readdirSync(edited).includes('routed.json'));

  await restore();
  await Promise.all([run(), ...writes.map(statement => query(statement).catch(() => []))]).then(([outcome]) => assert.equal(outcome.outcome, 'routed'));
  assert.equal(await count("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'"), 2);

  for (let pause = 1; pause <= writes.length; pause += 1) {
    const paused = await restore(pause);
    await assert.rejects(run(), AdditionRefused, `write ${pause}`);
    await paused.resume();
    assert.equal((await run()).outcome, 'routed', `write ${pause}`);
  }

  await restore();
  const checkpoint = (await query({ sql: 'SELECT sha256 FROM polylinedb_snapshot_claim', params: [] }))[0]?.sha256;
  await query({ sql: 'DROP TABLE polylinedb_snapshot_claim', params: [] });
  await query({ sql: 'CREATE TABLE polylinedb_snapshot_claim (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sha256 TEXT NOT NULL)', params: [] });
  await query({ sql: 'INSERT INTO polylinedb_snapshot_claim VALUES (1, ?)', params: [String(checkpoint)] });
  await assert.rejects(run(), (error: unknown) => error instanceof AdditionRefused && /two-column checkpoint requires snapshot format 3/.test(error.message));

  const legacyOriginal = join(root, 'original-v3.json');
  writeFileSync(legacyOriginal, JSON.stringify(legacyRestore.input));
  const legacy = async (restoredWrites = legacyRestore.writes.length) => {
    await reset(SCHEMA_V3_SQL.split(';').map(sql => sql.trim()).filter(Boolean));
    for (const statement of legacyRestore.writes.slice(0, restoredWrites)) await query(statement);
    await batch(schemaUpgradeStatements(3).map(sql => ({ sql, params: [] })));
    return { finishRestore: async () => { for (const statement of legacyRestore.writes.slice(restoredWrites)) await query(statement); } };
  };
  const runLegacy = async (port: Batch = batch, directory = journal()) => {
    const path = await source(directory);
    return owner(port, directory).run({ original: legacyOriginal, source: path, connection: 'cloud' });
  };

  await legacy();
  const legacyResult = await runLegacy();
  assert.equal(legacyResult.outcome, 'routed');
  assert.deepEqual(await query({ sql: `${objects} AND name LIKE 'polylinedb_%' ORDER BY name`, params: [] }), [
    { type: 'table', name: 'polylinedb_addition_receipt' }, { type: 'view', name: 'polylinedb_snapshot_claim' }, { type: 'table', name: 'polylinedb_snapshot_claim_archive' },
  ]);
  assert.deepEqual(await query({ sql: 'SELECT * FROM polylinedb_snapshot_claim_archive', params: [] }), [{ singleton: 1, sha256: legacyRestore.sha256 }]);
  assert.equal((await query({ sql: 'SELECT checkpoint_layout FROM polylinedb_addition_receipt', params: [] }))[0]?.checkpoint_layout, 'two-column');
  const legacyBarrierState = await state();
  for (const statement of legacyRestore.writes) {
    try { await changes(statement); } catch (error) { assert.match(String(error), /cannot modify polylinedb_snapshot_claim because it is a view/); }
  }
  assert.equal(await state(), legacyBarrierState);

  await legacy();
  const legacyBefore = await state();
  let legacyPacket = 0;
  await assert.rejects(runLegacy(async statements => { if (!isAddition(statements)) return batch(statements); legacyPacket = statements.length; throw new Error('not sent'); }), AdditionUnknown);
  for (let index = 0; index < legacyPacket; index += 1) {
    await assert.rejects(runLegacy(failAt(batch, index)), AdditionUnknown);
    assert.equal(await state(), legacyBefore, `release 0.1.0 statement ${index} left a partial addition`);
  }

  await legacy();
  const legacyRace = journal();
  await assert.rejects(runLegacy(async statements => { if (isAddition(statements)) await query({ sql: `UPDATE polylinedb_snapshot_claim SET sha256 = '${'0'.repeat(64)}'`, params: [] }); return batch(statements); }, legacyRace), AdditionUnknown);
  await assert.rejects(owner(batch, legacyRace).resume(), (error: unknown) => error instanceof AdditionRefused && /changed after freezing/.test(error.message));
  assert.equal(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('polylinedb_addition_receipt','polylinedb_snapshot_claim_archive')"), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'"), 0);

  await legacy();
  await Promise.all([runLegacy(), ...legacyRestore.writes.map(statement => query(statement).catch(() => []))]).then(([outcome]) => assert.equal(outcome.outcome, 'routed'));
  assert.equal(await count("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'"), 2);

  for (let pause = 0; pause < legacyRestore.writes.length; pause += 1) {
    const paused = await legacy(pause);
    await assert.rejects(runLegacy(), AdditionRefused, `release 0.1.0 write ${pause + 1}`);
    await paused.finishRestore();
    assert.equal((await runLegacy()).outcome, 'routed', `release 0.1.0 write ${pause + 1}`);
  }

const deletions = ["DELETE FROM dependencies WHERE dependent_id LIKE 'dst-%'", "DELETE FROM comments WHERE body = 'dst comment'"];
const replayAll = async () => { for (const statement of writes) await query(statement).catch(() => []); };
await restore();
for (const sql of deletions) await query({ sql, params: [] });
await replayAll();
assert.equal(await count("SELECT COUNT(*) AS n FROM comments WHERE body = 'dst comment'"), 1, 'without the barrier the replay restores the comment');
await restore();
assert.equal((await run()).outcome, 'routed');
for (const sql of deletions) await query({ sql, params: [] });
const deleted = await state();
await replayAll();
assert.equal(await state(), deleted);

await restore();
const migrated = journal();
await assert.rejects(run(loseResponse(batch, isAddition), migrated), AdditionUnknown);
await query({ sql: 'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY)', params: [] });
await assert.rejects(owner(batch, migrated).resume(), (error: unknown) => error instanceof AdditionRefused && /not canonical schema 7/.test(error.message));
assert.deepEqual(readdirSync(migrated).sort(), ['committed.json', 'dispatch-1.json', 'operation.json', 'retired.json']);
await query({ sql: 'DROP TABLE d1_migrations', params: [] });

  process.stdout.write(`PASS: workerd D1 restored addition, archive and empty-view barrier, ${writes.length} replayed restore writes, ${packet} rolled-back statement failures, ${races.length} commit races each followed by a source release, deleted rows kept deleted after replay, a receipt found after a schema change, response loss, committed receipt after edits that an operator accepts, queued restore SQL, ${writes.length} paused restore boundaries, a snapshot 5 input refused for the release 0.1.0 layout, and the release 0.1.0 route with ${legacyRestore.writes.length} fenced writes, ${legacyPacket} rolled-back statement failures, a checkpoint race, queued release 0.1.0 SQL and ${legacyRestore.writes.length} paused restore boundaries\n`);
} finally { rmSync(root, { recursive: true, force: true }); await runtime.dispose(); }
