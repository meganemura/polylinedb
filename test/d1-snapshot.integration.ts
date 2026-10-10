// Exercises operator restoration against workerd D1, including ambiguous committed writes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { additiveMerge, rawToSnapshot, tables } from '../scripts/d1-additive-merge.ts';
import { snapshotMigration, type Query } from '../scripts/d1-snapshot-store.ts';
import { parseQueryOutput, parseTarget } from '../scripts/d1-snapshot.ts';
import { initializeStore, openStore } from "../src/local-store/index.ts";
import { executeOperation, parseOperation } from "../src/records/operations.ts";
import { d1Executor } from "../src/service/d1.ts";
import { canonicalSnapshot } from "../src/records/snapshot.ts";
import { SCHEMA_STATEMENTS } from "../src/records/schema.ts";
import { d1Relay, d1RelayModule } from "./fixtures/d1-relay.ts";

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: {
  name: 'snapshot-test', compatibilityDate: '2026-09-25',
  manifest: d1RelayModule,
  env: { DB: { type: 'd1', name: 'snapshot-test' }, MERGEDB: { type: 'd1', name: 'claims-merge-test' } },
} }] });
const root = mkdtempSync(join(tmpdir(), 'pd-snapshot-test-'));
const location = { directory: join(root, 'source') };
initializeStore(location);
const source = openStore(location);
try {
  const entry: URL = await runtime.ready;
  const database = d1Relay(entry, 'DB');
  const query: Query = async ({ sql, params }) => {
    const result = await database.prepare(sql).bind(...params).all();
    return result.results;
  };
  const reset = async () => {
    for (const table of ['change_events', 'change_writer', 'claim_requests', 'issue_claims', 'dependency_requests', 'dependencies', 'dependency_revisions', 'memory_requests', 'memory_counters', 'memories', 'project_memory_revisions', 'memory_store_identity', 'comments', 'requests', 'counters', 'issues', 'schema_version', 'polylinedb_snapshot_claim']) await query({ sql: `DROP TABLE IF EXISTS ${table}`, params: [] });
    await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  };
  await reset();
  const run = (operation: unknown) => executeOperation(source.db, parseOperation(operation), 'test:original');
  const request = { op: 'create', prefix: 'pd', request_id: randomUUID(), tool: 'compiler', project: 'p', body: 'original', type: 'epic' };
  const created = await run(request); assert('issue' in created);
  await run({ op: 'update', id: created.issue.id, changes: [{ field: 'body', expected: 1, value: 'é'.repeat(32768) }, { field: 'labels', expected: 1, value: ['quote"', 'slash\\'] }] });
  await run({ op: 'create', prefix: 'pd', parent: created.issue.id, request_id: randomUUID(), tool: 'compiler', project: 'other', body: 'child' });
  await run({ op: 'comment', id: created.issue.id, body: 'Unicode 日本語 quote\' slash\\' });
  const dependencyRequest = { op: 'dependency_add', dependent_id: 'pd-1.1', blocker_id: 'pd-1', expected_revision: 1, request_id: randomUUID() };
  const dependencyReceipt = await run(dependencyRequest);
  await run({ ...dependencyRequest, op: 'dependency_remove', expected_revision: 2, request_id: randomUUID() });
  await run({ ...dependencyRequest, expected_revision: 3, request_id: randomUUID() });
  for (let index = 0; index < 2; index++) await run({ op: 'create', prefix: 'pd', request_id: randomUUID(), tool: 'compiler', project: 'p', body: `Lease history ${index}` });
  const originalScope = await run({ op: 'claim_show', issue_id: 'pd-1' }); assert.ok('claim' in originalScope);
  const claimCommand = { op: 'claim_acquire', issue_id: 'pd-1', incarnation: originalScope.claim.store_incarnation, session_id: randomUUID(), request_id: randomUUID(), agent_label: 'Codex' };
  const claimReceipt = await run(claimCommand); assert.ok('claim_receipt' in claimReceipt);
  const claimProof = { issue_id: 'pd-1', incarnation: claimCommand.incarnation, session_id: claimCommand.session_id, generation: 1 };
  await run({ op: 'claim_renew', claim_proof: claimProof, expected_revision: 1, request_id: randomUUID(), ttl: 3600 });
  await run({ op: 'claim_release', claim_proof: claimProof, expected_revision: 2, request_id: randomUUID() });
  await run({ ...claimCommand, request_id: randomUUID(), session_id: randomUUID() });
  for (const issue_id of ['pd-2', 'pd-3']) {
    const command = { ...claimCommand, issue_id, request_id: randomUUID(), session_id: randomUUID(), agent_label: null };
    await run(command);
    if (issue_id === 'pd-2') await run({ op: 'claim_release', claim_proof: { ...claimProof, issue_id, session_id: command.session_id }, expected_revision: 1, request_id: randomUUID() });
    else await source.db.batch([{ sql: "UPDATE issue_claims SET acquired_at=MIN(acquired_at,unixepoch()-1),expires_at=unixepoch() WHERE issue_id=?", params: [issue_id] }]);
  }
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
  const totalWrites = 3 + snapshot.issues.length + snapshot.comments.length + snapshot.counters.length + snapshot.requests.length + snapshot.memories.length + snapshot.memory_counters.length + snapshot.memory_requests.length + snapshot.dependencies.length + snapshot.dependency_revisions.length + snapshot.dependency_requests.length + snapshot.issue_claims.length + snapshot.claim_requests.length;
  for (let failAt = 1; failAt <= totalWrites; failAt++) {
    await reset();
    let writes = 0;
    const interrupted: Query = async statement => {
      const rows = await query(statement);
      if (/^(INSERT|CREATE|UPDATE)/.test(statement.sql) && ++writes === failAt) throw new Error('response lost after commit');
      return rows;
    };
    await assert.rejects(snapshotMigration(interrupted, snapshot, sha256).restore(), /response lost/);
    await migration.restore();
    assert.equal(canonicalSnapshot((await migration.verify()).snapshot), canonical);
    const restoredIdentity = (await query({ sql: 'SELECT incarnation FROM memory_store_identity WHERE singleton=1', params: [] }))[0]?.incarnation;
    assert.equal((await migration.restore()).result, 'already_present');
    assert.equal((await query({ sql: 'SELECT incarnation FROM memory_store_identity WHERE singleton=1', params: [] }))[0]?.incarnation, restoredIdentity);
  }
  const restored = await migration.verify();
  const provenance = (await query({ sql: 'SELECT original_incarnation,incarnation FROM polylinedb_snapshot_claim WHERE singleton=1', params: [] }))[0]; assert.ok(provenance);
  await query({ sql: 'UPDATE memory_store_identity SET incarnation=? WHERE singleton=1', params: [String(provenance.original_incarnation)] });
  await assert.rejects(migration.verify(), /incarnation/); await assert.rejects(migration.restore(), /incarnation/);
  assert.equal((await query({ sql: 'SELECT incarnation FROM memory_store_identity WHERE singleton=1', params: [] }))[0]?.incarnation, provenance.original_incarnation);
  await query({ sql: 'UPDATE memory_store_identity SET incarnation=? WHERE singleton=1', params: [String(provenance.incarnation)] });
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
  assert.deepEqual(await executeOperation(remote, parseOperation(claimCommand), 'test:original'), claimReceipt);
  const invalidated = await executeOperation(remote, parseOperation({ op: 'claim_show', issue_id: 'pd-1' }), 'test:original'); assert.ok('claim' in invalidated); assert.equal(invalidated.claim.state, 'invalidated');
  await assert.rejects(executeOperation(remote, parseOperation({ op: 'close', id: 'pd-1', expected: 1, claim_proof: claimProof }), 'test:original'), { code: 'claim_required' });
  const freshClaim = { ...claimCommand, incarnation: invalidated.claim.store_incarnation, request_id: randomUUID(), session_id: randomUUID() };
  const newClaim = await executeOperation(remote, parseOperation(freshClaim), 'test:original'); assert.ok('claim_receipt' in newClaim); assert.equal(newClaim.claim_receipt.generation, 3); assert.equal(newClaim.claim_receipt.revision, 5);
  const liveProof = { issue_id: 'pd-1', incarnation: freshClaim.incarnation, session_id: freshClaim.session_id, generation: 3 };
  await assert.rejects(migration.restore(), /differing/);
  await executeOperation(remote, parseOperation({ op: 'close', id: 'pd-1', expected: 1, claim_proof: liveProof }), 'test:original');
  assert.equal((await query({ sql: 'SELECT incarnation FROM memory_store_identity WHERE singleton=1', params: [] }))[0]?.incarnation, freshClaim.incarnation);
  assert.deepEqual(await executeOperation(remote, parseOperation(dependencyRequest), 'test:original'), dependencyReceipt);
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
  const mergedDatabase = d1Relay(entry, 'MERGEDB'); await mergedDatabase.batch(SCHEMA_STATEMENTS.map(sql => mergedDatabase.prepare(sql)));
  const mergedExecutor = d1Executor(mergedDatabase); const mergedRun = (input: unknown) => executeOperation(mergedExecutor, parseOperation(input), 'test:destination');
  await mergedRun({ op: 'create', prefix: 'dest', request_id: randomUUID(), tool: 'compiler', project: 'p', body: 'Destination' });
  await mergedRun({ op: 'memory_create', prefix: 'dest', request_id: randomUUID(), project: 'p', title: 'Destination', body: 'Preserve revision' });
  const destShown = await mergedRun({ op: 'claim_show', issue_id: 'dest-1' }); assert.ok('claim' in destShown);
  const destCommand = { op: 'claim_acquire', issue_id: 'dest-1', incarnation: destShown.claim.store_incarnation, session_id: randomUUID(), request_id: randomUUID() };
  const destOwner = await mergedRun(destCommand); assert.ok('claim_receipt' in destOwner);
  const localRaw = new DatabaseSync(join(location.directory, 'polylinedb.sqlite'), { readOnly: true });
  const sourceRows = Object.fromEntries(tables.map(table => [table, localRaw.prepare(`SELECT * FROM ${table}`).all()])); localRaw.close();
  const remoteRows = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await mergedDatabase.prepare(`SELECT * FROM ${table}`).all()).results])));
  const captured = await remoteRows();
  assert.throws(() => additiveMerge({ source: { ...sourceRows, memory_store_identity: captured.memory_store_identity }, destination: captured }), /incarnations must differ/);
  assert.deepEqual(await remoteRows(), captured);
  for (const change of ['UPDATE memory_store_identity SET incarnation=lower(hex(randomblob(16)))', 'UPDATE project_memory_revisions SET revision=revision+1']) {
    const plan = additiveMerge({ source: sourceRows, destination: await remoteRows() }); await mergedDatabase.prepare(change).run(); const changed = await remoteRows();
    await assert.rejects(mergedDatabase.batch(plan.statements.map(({ sql, params }) => mergedDatabase.prepare(sql).bind(...params))), /CHECK constraint failed/); assert.deepEqual(await remoteRows(), changed);
  }
  await mergedDatabase.prepare('UPDATE memory_store_identity SET incarnation=? WHERE singleton=1').bind(destCommand.incarnation).run();
  const plan = additiveMerge({ source: sourceRows, destination: await remoteRows() }); await mergedDatabase.batch(plan.statements.map(({ sql, params }) => mergedDatabase.prepare(sql).bind(...params)));
  assert.equal(canonicalSnapshot(rawToSnapshot(await remoteRows())), canonicalSnapshot(plan.expectedSnapshot));
  const retained = await mergedRun({ op: 'claim_show', issue_id: 'dest-1' }); assert.ok('claim' in retained); assert.equal(retained.claim.state, 'active');
  const { outcome: _, ...destLease } = destOwner.claim_receipt; assert.deepEqual(retained.claim.lease, destLease);
  await mergedRun({ op: 'close', id: 'dest-1', expected: 1, claim_proof: { issue_id: 'dest-1', incarnation: destCommand.incarnation, session_id: destCommand.session_id, generation: 1 } });
  const importedHistory = await mergedRun({ op: 'claim_show', issue_id: 'pd-1' }); assert.ok('claim' in importedHistory); assert.equal(importedHistory.claim.state, 'invalidated');
  process.stdout.write('PASS: local workerd D1 full-table additive merge, same-incarnation rejection, identity/revision race rollback, imported claim history and destination authority\n');
  process.stdout.write(`PASS: workerd graph snapshot exact roundtrip, ${totalWrites} committed-response-loss resumptions, duplicate/concurrent restore, digest/row/unclaimed conflicts, derived columns, Unicode/audit preservation, immutable graph replay and root/child next IDs\n`);
} finally { source.close(); rmSync(root, { recursive: true, force: true }); await runtime.dispose(); }
