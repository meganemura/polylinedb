// Exercises public claim commands and protected issue writes against local stores; transport tests own wire validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { initializeStore, openStore, upgradeStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import type { ClaimReceipt } from '../src/records/index.ts';
import { SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_SQL } from '../src/records/persistence.ts';
const request = () => crypto.randomUUID();
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-claim-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  const { database_path } = initializeStore(location); const store = openStore(location);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (value: unknown, actor = 'test:owner') => executeOperation(store.db, parseOperation(value), actor);
  return { run, db: store.db, database_path };
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
test('canonical schemas 2 through 5 upgrade without rewriting old records or identity', t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-claims-upgrade-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = [SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL];
  for (const [index, ddl] of sources.entries()) {
    const directory = join(root, `v${index + 2}`); mkdirSync(directory, { mode: 0o700 }); const path = join(directory, 'polylinedb.sqlite');
    const legacy = new DatabaseSync(path); legacy.exec(ddl);
    legacy.exec("INSERT INTO issues(id,sort_key,tool,project,body,status,type,priority,labels_json,created_at,created_by,updated_at,updated_by) VALUES ('pd-1','pd-0000000000000001','pd','test','Keep bytes','open','task',2,'[ ]','old','old','old','old'); INSERT INTO counters VALUES ('pd',1)");
    const request_id = request(); const payload = '{ "original" : "bytes" }'; legacy.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(request_id, 'old', payload, 'pd-1');
    const tables = legacy.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'schema_version' ORDER BY name").all();
    const before = tables.map(row => { assert.equal(typeof row.name, 'string'); if (typeof row.name !== 'string') throw new Error('Invalid table'); return [row.name, legacy.prepare(`SELECT * FROM ${row.name}`).all()]; });
    legacy.close(); chmodSync(path, 0o600);
    assert.equal(upgradeStore({ directory, cwd: join(root, 'work') }).version, 6);
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
  await hegel.testAsync(async tc => {
    const ttl = tc.draw(gs.integers({ minValue: 30, maxValue: 3600 })); const renewedTTL = tc.draw(gs.integers({ minValue: 30, maxValue: 3600 }));
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
});
