// Exercises public claim commands and protected issue writes against local stores; transport tests own wire validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotMigration } from '../scripts/d1-snapshot-store.ts';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { initializeStore, openStore, upgradeStore, exportHistoricalSnapshot } from '../src/local-store/index.ts';
import { executeOperation, parseOperation, PolylinedbError } from '../src/records/index.ts';
import type { ClaimReceipt } from '../src/records/index.ts';
import { SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_V6_SQL, SCHEMA_SQL } from '../src/records/persistence.ts';
import { parseSnapshot, canonicalSnapshot, convertSnapshotV4 } from '../src/records/persistence.ts';
import { downgradeToSchema6 } from './fixtures/legacy-schema.ts';
const request = () => crypto.randomUUID();
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-claim-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  const { database_path } = initializeStore(location); const store = openStore(location);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (value: unknown, actor = 'test:owner') => executeOperation(store.db, parseOperation(value), actor);
  return { run, db: store.db, store, database_path };
}
async function acquire(run: ReturnType<typeof fixture>['run'], issue_id: string, extra: Record<string, unknown> = {}) {
  const shown = await run({ op: 'claim_show', issue_id }); assert.ok('claim' in shown);
  const command = { op: 'claim_acquire', issue_id, incarnation: shown.claim.store_incarnation, session_id: request(), request_id: request(), ...extra };
  const result = await run(command); assert.ok('claim_receipt' in result);
  return { command, receipt: result.claim_receipt };
}
const proof = (receipt: ClaimReceipt) => ({ issue_id: receipt.issue_id, incarnation: receipt.incarnation, session_id: receipt.session_id, generation: receipt.generation });
async function create(run: ReturnType<typeof fixture>['run'], status = 'open') {
  const result = await run({ op: 'create', prefix: 'pd', request_id: request(), tool: 'pd', project: 'test', body: 'Issue', status });
  assert.ok('issue' in result); return result.issue;
}
test('claim commands preserve history and require ownership on all requested status writes', async t => {
  const { run, db } = fixture(t); const issue = await create(run);
  const before = await run({ op: 'claim_show', issue_id: issue.id }); assert.ok('claim' in before); assert.equal(before.claim.state, 'never_claimed');
  const owner = await acquire(run, issue.id, { agent_label: 'Codex' });
  assert.equal(owner.receipt.revision, 1); assert.equal(owner.receipt.generation, 1);
  await assert.rejects(acquire(run, issue.id, { session_id: owner.command.session_id }), { code: 'claim_conflict' });
  await assert.rejects(run({ op: 'update', id: issue.id, changes: [{ field: 'body', value: 'bad', expected: 1 }, { field: 'status', value: 'open', expected: 1 }] }), { code: 'claim_required' });
  await assert.rejects(run({ op: 'close', id: issue.id, expected: 1, force: true, reason: 'Exception' }), { code: 'claim_required' });
  const unchanged = await run({ op: 'show', id: issue.id }); assert.ok('issue' in unchanged); assert.equal(unchanged.issue.body, 'Issue'); assert.equal(unchanged.issue.versions.body, 1); assert.ok('comments' in unchanged); assert.equal(unchanged.comments.length, 0);
  await run({ op: 'update', id: issue.id, changes: [{ field: 'body', value: 'cooperative', expected: 1 }] });
  await run({ op: 'comment', id: issue.id, body: 'Observation' });
  await run({ op: 'close', id: issue.id, expected: 1, claim_proof: proof(owner.receipt) });
  const release = { op: 'claim_release', claim_proof: proof(owner.receipt), expected_revision: 1, request_id: request() };
  await run(release); await assert.rejects(run({ op: 'reopen', id: issue.id, expected: 2 }), { code: 'claim_required' });
  const shown = await run({ op: 'claim_show', issue_id: issue.id }); assert.ok('claim' in shown); assert.equal(shown.claim.state, 'released'); assert.equal(shown.claim.lease?.agent_label, 'Codex');
  assert.deepEqual(await run(owner.command), { claim_receipt: owner.receipt });
  const next = await acquire(run, issue.id); assert.equal(next.receipt.generation, 2); assert.equal(next.receipt.revision, 3); assert.equal(next.receipt.agent_label, null);
  await run({ op: 'reopen', id: issue.id, expected: 2, claim_proof: proof(next.receipt) });
  await assert.rejects(run({ op: 'update', id: issue.id, changes: [{ field: 'body', value: 'bad', expected: 2 }], claim_proof: proof(owner.receipt) }), { code: 'claim_required' });
  await assert.rejects(db.batch([{ sql: 'UPDATE claim_requests SET actor=? WHERE request_id=?', params: ['other', owner.command.request_id] }]), /claim_receipt_immutable/);
  await assert.rejects(db.batch([{ sql: 'DELETE FROM claim_requests WHERE request_id=?', params: [owner.command.request_id] }]), /claim_receipt_immutable/);
});
test('force overrides prerequisites while the claim guard stays atomic', async t => {
  const { run } = fixture(t); const issue = await create(run); const blocker = await create(run);
  await run({ op: 'dependency_add', dependent_id: issue.id, blocker_id: blocker.id, expected_revision: 1, request_id: request() });
  const owner = await acquire(run, issue.id);
  await assert.rejects(run({ op: 'close', id: issue.id, expected: 1, claim_proof: proof(owner.receipt) }), { code: 'dependency_blocked' });
  await run({ op: 'close', id: issue.id, expected: 1, force: true, reason: 'Accepted prerequisite risk', claim_proof: proof(owner.receipt) });
  const output = await run({ op: 'show', id: issue.id }); assert.ok('comments' in output); assert.equal(output.issue.status, 'closed'); assert.equal(output.comments[0]?.body, 'Accepted prerequisite risk');
});
test('a supplied claim_proof that the store rejects names the observed claim', async t => {
  const { run, db } = fixture(t); const issue = await create(run); const owner = await acquire(run, issue.id);
  const current = proof(owner.receipt);
  const rejected = async (claim_proof: ReturnType<typeof proof>, expected: { state: string; generation: number; expires_at: number }) => {
    await assert.rejects(run({ op: 'update', id: issue.id, changes: [{ field: 'labels', value: ['ready'], expected: 1 }], claim_proof }), (error: unknown) => {
      assert.ok(error instanceof PolylinedbError);
      assert.equal(error.code, 'claim_required');
      assert.equal(error.message, 'A current ownership proof is required for this update');
      const details = error.details as { issue: { id: string; labels: string[]; versions: { labels: number } }; claim: unknown };
      assert.equal(details.issue.id, issue.id);
      assert.deepEqual(details.issue.labels, []);
      assert.equal(details.issue.versions.labels, 1);
      assert.deepEqual(details.claim, expected);
      return true;
    });
  };
  const active = { state: 'active', generation: 1, expires_at: owner.receipt.expires_at };
  await rejected({ ...current, session_id: crypto.randomUUID() }, active);
  await rejected({ ...current, generation: current.generation + 1 }, active);
  await db.batch([{ sql: 'UPDATE issue_claims SET acquired_at = 100, changed_at = 100, expires_at = 1000 WHERE issue_id = ?', params: [issue.id] }]);
  await rejected(current, { state: 'expired', generation: 1, expires_at: 1000 });
  const fresh = await create(run);
  const inspection = await run({ op: 'claim_show', issue_id: fresh.id }); assert.ok('claim' in inspection);
  await assert.rejects(run({ op: 'update', id: fresh.id, changes: [{ field: 'body', value: 'no lease', expected: 1 }], claim_proof: { issue_id: fresh.id, incarnation: inspection.claim.store_incarnation, session_id: crypto.randomUUID(), generation: 1 } }), (error: unknown) => {
    assert.ok(error instanceof PolylinedbError);
    assert.deepEqual((error.details as { claim: unknown }).claim, { state: 'never_claimed' });
    return true;
  });
  await assert.rejects(run({ op: 'update', id: issue.id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }] }), (error: unknown) => {
    assert.ok(error instanceof PolylinedbError);
    assert.equal(error.code, 'claim_required');
    const details = error.details as { issue: { id: string }; claim?: unknown };
    assert.equal(details.issue.id, issue.id);
    assert.equal(details.claim, undefined);
    return true;
  });
  const shown = await run({ op: 'show', id: issue.id }); assert.ok('issue' in shown); assert.deepEqual(shown.issue.labels, []); assert.equal(shown.issue.versions.labels, 1);
});
test('claim parser validates scope, proof target, session, TTL, and label UTF-8 bounds', async t => {
  const { run } = fixture(t); await create(run); const owner = await acquire(run, 'pd-1');
  for (const extra of [{ ttl: 29 }, { ttl: 3601 }, { ttl: 30.5 }, { session_id: 'bad' }, { incarnation: 'A'.repeat(32) }, { agent_label: 'あ'.repeat(22) }, { agent_label: 'bad\nlabel' }, { clock: 1 }]) assert.throws(() => parseOperation({ ...owner.command, ...extra }), { code: 'invalid_input' });
  assert.throws(() => parseOperation({ op: 'close', id: 'pd-2', expected: 1, claim_proof: proof(owner.receipt) }), { code: 'invalid_input' });
  for (const input of [{ ...owner.command, session_id: request() }, { ...owner.command, ttl: 30 }]) await assert.rejects(run(input), { code: 'claim_request_conflict' });
  await assert.rejects(run(owner.command, 'other'), { code: 'claim_request_conflict' });
});
test('claim list includes never-claimed issues in numeric order and preserves filters', async t => {
  const { run } = fixture(t); for (let i = 0; i < 12; i++) await create(run);
  await acquire(run, 'pd-10');
  const page = await run({ op: 'claim_list', tool: 'pd', project: 'test', after: 'pd-8', limit: 3 }); assert.ok('claims' in page);
  assert.deepEqual(page.claims.map(claim => [claim.issue_id, claim.state]), [['pd-9', 'never_claimed'], ['pd-10', 'active'], ['pd-11', 'never_claimed']]); assert.equal(page.next_cursor, 'pd-11');
  const empty = await run({ op: 'claim_list', project: 'other' }); assert.deepEqual(empty, { claims: [], next_cursor: null });
});
test('claim replay recognizes only complete provider duplicate markers', async t => {
  const { run, db } = fixture(t); await create(run); const owner = await acquire(run, 'pd-1');
  const marker = 'UNIQUE constraint failed: claim_requests.request_id';
  for (const message of [marker, `D1_ERROR: ${marker}: SQLITE_CONSTRAINT`, `${marker}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`]) {
    const failing = { ...db, async batch() { throw new Error('outer', { cause: new Error(message) }); } };
    assert.deepEqual(await executeOperation(failing, parseOperation(owner.command), 'test:owner'), { claim_receipt: owner.receipt });
  }
  for (const message of [`prefix ${marker}`, `${marker} trailing`, 'claim_receipt_immutable', 'CHECK constraint failed: version > 0']) {
    const error = new Error(message); const failing = { ...db, async batch() { throw error; } };
    await assert.rejects(executeOperation(failing, parseOperation(owner.command), 'test:owner'), value => value === error);
  }
});
test('canonical schemas 2 through 6 upgrade without rewriting old records or identity', t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-claims-upgrade-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = [SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_V6_SQL];
  for (const [index, ddl] of sources.entries()) {
    const directory = join(root, `v${index + 2}`); mkdirSync(directory, { mode: 0o700 }); const path = join(directory, 'polylinedb.sqlite');
    const legacy = new DatabaseSync(path); legacy.exec(ddl);
    legacy.exec("INSERT INTO issues(id,sort_key,tool,project,body,status,type,priority,labels_json,created_at,created_by,updated_at,updated_by) VALUES ('pd-1','pd-0000000000000001','pd','test','Keep bytes','open','task',2,'[ ]','old','old','old','old'); INSERT INTO counters VALUES ('pd',1)");
    const request_id = request(); const payload = '{ "original" : "bytes" }'; legacy.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(request_id, 'old', payload, 'pd-1');
    const tables = legacy.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'schema_version' ORDER BY name").all();
    const before = tables.map(row => { assert.equal(typeof row.name, 'string'); if (typeof row.name !== 'string') throw new Error('Invalid table'); return [row.name, legacy.prepare(`SELECT * FROM ${row.name}`).all()]; });
    legacy.close(); chmodSync(path, 0o600);
    assert.equal(upgradeStore({ directory, cwd: join(root, 'work') }).version, 7);
    const current = new DatabaseSync(path); const canonical = new DatabaseSync(':memory:'); canonical.exec(SCHEMA_SQL);
    try {
      for (const [table, records] of before) { if (typeof table !== 'string') throw new Error('Invalid table'); assert.deepEqual(current.prepare(`SELECT * FROM ${table}`).all(), records); }
      const schema = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
      assert.deepEqual(current.prepare(schema).all(), canonical.prepare(schema).all());
      assert.equal(current.prepare('SELECT payload FROM requests WHERE request_id=?').get(request_id)?.payload, payload);
      assert.deepEqual(current.prepare('SELECT * FROM issue_claims').all(), []);
    } finally { current.close(); canonical.close(); }
  }
});
test('property: successful claims retain requested TTL and replay after a generated renewal', async () => {
  const ttls = gs.oneOf(gs.sampledFrom([30, 3600]), gs.integers({ minValue: 30, maxValue: 3600 })); const drawn = new Set<number>();
  await hegel.testAsync(async tc => {
    const ttl = tc.draw(ttls); const renewedTTL = tc.draw(ttls); drawn.add(ttl); drawn.add(renewedTTL);
    const root = mkdtempSync(join(tmpdir(), 'pd-claim-property-')); const location = { directory: join(root, 'store'), cwd: join(root, 'work') }; initializeStore(location); const store = openStore(location);
    const run = (value: unknown) => executeOperation(store.db, parseOperation(value), 'test:owner');
    try {
      await create(run); const first = await acquire(run, 'pd-1', { ttl });
      assert.equal(first.receipt.expires_at - first.receipt.changed_at, ttl);
      const renewed = await run({ op: 'claim_renew', claim_proof: proof(first.receipt), expected_revision: 1, request_id: request(), ttl: renewedTTL }); assert.ok('claim_receipt' in renewed);
      assert.equal(renewed.claim_receipt.expires_at - renewed.claim_receipt.changed_at, renewedTTL); assert.equal(renewed.claim_receipt.revision, 2); assert.equal(renewed.claim_receipt.generation, 1);
      assert.deepEqual(await run(first.command), { claim_receipt: first.receipt });
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }, { testCases: 30 });
  assert.ok(drawn.has(30) && drawn.has(3600), 'the generated TTLs include the minimum and the maximum');
});
test('snapshot5 preserves claim history while restore rotates authority only once', async t => {
  const source = fixture(t); const destination = fixture(t); await create(source.run);
  const owner = await acquire(source.run, 'pd-1', { agent_label: 'Codex' });
  await source.run({ op: 'claim_renew', claim_proof: proof(owner.receipt), expected_revision: 1, request_id: request(), ttl: 3600 });
  await source.run({ op: 'claim_release', claim_proof: proof(owner.receipt), expected_revision: 2, request_id: request() });
  const active = await acquire(source.run, 'pd-1');
  const snapshot = source.store.exportSnapshot(); assert.equal(snapshot.version, 5); assert.equal(snapshot.issue_claims.length, 1); assert.equal(snapshot.claim_requests.length, 4);
  const bytes = snapshot.claim_requests.map(row => row.payload);
  destination.store.importSnapshot(snapshot); assert.equal(canonicalSnapshot(destination.store.exportSnapshot()), canonicalSnapshot(snapshot));
  assert.deepEqual(destination.store.exportSnapshot().claim_requests.map(row => row.payload), bytes);
  const imported = await destination.run({ op: 'claim_show', issue_id: 'pd-1' }); assert.ok('claim' in imported); assert.equal(imported.claim.state, 'invalidated'); assert.notEqual(imported.claim.store_incarnation, owner.receipt.incarnation);
  await assert.rejects(destination.run({ op: 'close', id: 'pd-1', expected: 1, claim_proof: proof(active.receipt) }), { code: 'claim_required' });
  assert.deepEqual(await destination.run(owner.command), { claim_receipt: owner.receipt });
  assert.equal(destination.store.importSnapshot(snapshot).result, 'already_present');
  const resumed = await destination.run({ op: 'claim_show', issue_id: 'pd-1' }); assert.ok('claim' in resumed); assert.equal(resumed.claim.store_incarnation, imported.claim.store_incarnation);
  const current = await acquire(destination.run, 'pd-1'); assert.equal(current.receipt.generation, 3); assert.equal(current.receipt.revision, 5);
  assert.throws(() => destination.store.importSnapshot(snapshot), { code: 'destination_not_empty' });
  await destination.run({ op: 'close', id: 'pd-1', expected: 1, claim_proof: proof(current.receipt) });
});
test('snapshot claim closure rejects dangling and future receipts across all incarnations before import', async t => {
  const source = fixture(t); const destination = fixture(t); await create(source.run); await acquire(source.run, 'pd-1');
  const snapshot = source.store.exportSnapshot(); const claim = snapshot.issue_claims[0]; const receipt = snapshot.claim_requests[0]; assert.ok(claim); assert.ok(receipt);
  for (const input of [
    { ...snapshot, issue_claims: [] },
    { ...snapshot, issue_claims: [{ ...claim, issue_id: 'pd-999' }] },
    { ...snapshot, claim_requests: [{ ...receipt, revision: claim.revision + 1, incarnation: 'f'.repeat(32) }] },
    { ...snapshot, claim_requests: [{ ...receipt, generation: claim.generation + 1 }] },
  ]) { assert.throws(() => parseSnapshot(input), { code: 'invalid_snapshot' }); assert.throws(() => destination.store.importSnapshot(input), { code: 'invalid_snapshot' }); }
  assert.equal(destination.store.exportSnapshot().issues.length, 0); assert.equal(destination.store.exportSnapshot().claim_requests.length, 0);
});
test('snapshot4 conversion is explicit and preserves original creation payload bytes', async t => {
  const source = fixture(t); await create(source.run);
  const { issue_claims: _, claim_requests: __, ...old } = source.store.exportSnapshot(); const legacy = { ...old, version: 4 };
  assert.throws(() => parseSnapshot(legacy), { code: 'invalid_snapshot' });
  const converted = convertSnapshotV4(legacy); assert.equal(converted.version, 5); assert.deepEqual(converted.issue_claims, []); assert.deepEqual(converted.claim_requests, []); assert.deepEqual(converted.requests, legacy.requests);
});
test('historical schema5 export retains graph records and canonical retirement guards without writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-history5-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'store'); mkdirSync(directory, { mode: 0o700 }); const path = join(directory, 'polylinedb.sqlite');
  const database = new DatabaseSync(path); database.exec(SCHEMA_V5_SQL);
  for (const id of ['pd-1', 'pd-2']) database.prepare("INSERT INTO issues(id,sort_key,tool,project,body,status,type,priority,labels_json,created_at,created_by,updated_at,updated_by) VALUES (?,?, 'pd','test','History','open','task',2,'[]','2020-01-01T00:00:00Z','old','2020-01-01T00:00:00Z','old')").run(id, `pd-${id.slice(3).padStart(16, '0')}`);
  database.exec("INSERT INTO counters VALUES ('pd',2); INSERT INTO dependencies VALUES ('pd-1','pd-2'); UPDATE dependency_revisions SET revision=2 WHERE dependent_id='pd-1'");
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'schema_version'").all();
  for (const row of tables) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    if (typeof row.name !== 'string') throw new Error('Invalid table');
    database.exec(`CREATE TRIGGER "polylinedb_retired_${row.name}_${operation.toLowerCase()}" BEFORE ${operation} ON "${row.name}" BEGIN SELECT RAISE(ABORT, 'This local database is retired. Use cloud connection archive.'); END`);
  }
  const before = database.prepare('SELECT * FROM memory_store_identity').get(); database.close(); chmodSync(path, 0o600);
  const snapshot = exportHistoricalSnapshot({ directory, cwd: join(root, 'work') }); assert.equal(snapshot.version, 5); assert.deepEqual(snapshot.dependencies, [{ dependent_id: 'pd-1', blocker_id: 'pd-2' }]); assert.deepEqual(snapshot.issue_claims, []);
  const after = new DatabaseSync(path, { readOnly: true }); try { assert.deepEqual(after.prepare('SELECT * FROM memory_store_identity').get(), before); assert.equal(after.prepare('SELECT version FROM schema_version').get()?.version, 5); } finally { after.close(); }
  assert.throws(() => upgradeStore({ directory, cwd: join(root, 'work') }), { code: 'store_retired' });
});
test('historical schema6 export reads claim history from a canonical schema 6 store without writes', async t => {
  const source = fixture(t); const issue = await create(source.run); const owner = await acquire(source.run, issue.id, { agent_label: 'Codex' });
  await source.run({ op: 'claim_release', claim_proof: proof(owner.receipt), expected_revision: 1, request_id: request() });
  const expected = source.store.exportSnapshot();
  const database = new DatabaseSync(source.database_path); downgradeToSchema6(database);
  const reference = new DatabaseSync(':memory:'); reference.exec(SCHEMA_V6_SQL);
  const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  assert.deepEqual(database.prepare(schema).all(), reference.prepare(schema).all()); reference.close();
  const before = database.prepare('SELECT * FROM sqlite_master ORDER BY name').all(); database.close();
  const location = { directory: join(source.database_path, '..'), cwd: join(source.database_path, '..', '..', 'work') };
  const snapshot = exportHistoricalSnapshot(location);
  assert.equal(canonicalSnapshot(snapshot), canonicalSnapshot(expected)); assert.equal(snapshot.claim_requests.length, 2);
  const after = new DatabaseSync(source.database_path, { readOnly: true });
  try { assert.deepEqual(after.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), before); } finally { after.close(); }
  assert.equal(upgradeStore(location).result, 'upgraded'); assert.throws(() => exportHistoricalSnapshot(location), { code: 'unsupported_schema' });
});
test('completed D1 restore requires its recorded target incarnation for verify and replay', async t => {
  const source = fixture(t); await create(source.run); const snapshot = source.store.exportSnapshot();
  const database = new DatabaseSync(':memory:'); database.exec(SCHEMA_SQL); t.after(() => database.close());
  const migration = snapshotMigration(async ({ sql, params }) => database.prepare(sql).all(...params), snapshot, createHash('sha256').update(canonicalSnapshot(snapshot)).digest('hex'));
  await migration.restore();
  const provenance = database.prepare('SELECT original_incarnation,incarnation FROM polylinedb_snapshot_claim').get(); assert.ok(provenance); assert.equal(typeof provenance.original_incarnation, 'string');
  if (typeof provenance.original_incarnation !== 'string') throw new Error('Invalid provenance');
  database.prepare('UPDATE memory_store_identity SET incarnation=? WHERE singleton=1').run(provenance.original_incarnation);
  const rows = database.prepare('SELECT * FROM issues').all();
  await assert.rejects(migration.verify(), /incarnation/);
  await assert.rejects(migration.restore(), /incarnation/);
  assert.deepEqual(database.prepare('SELECT * FROM issues').all(), rows);
  assert.equal(database.prepare('SELECT incarnation FROM memory_store_identity').get()?.incarnation, provenance.original_incarnation);
});
