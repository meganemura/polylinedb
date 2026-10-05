// Exercises dependency receipts and transition policy against real storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStore, openStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-dependency-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  initializeStore(location);
  const store = openStore(location);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return Object.assign(async (input: unknown, actor = 'tester') => executeOperation(store.db, parseOperation(input), actor), { db: store.db });
}
const request = () => crypto.randomUUID();
async function issues(run: ReturnType<typeof fixture>) {
  for (let i = 0; i < 3; i++) await run({ op: 'create', prefix: 'pd', request_id: request(), tool: 'pd', project: 'test', body: `Issue ${i}` });
}
test('dependency receipts preserve original outcomes after removal', async t => {
  const run = fixture(t); await issues(run);
  const add = { op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 1, request_id: request() };
  const original = await run(add);
  assert.deepEqual(original, { dependency: { dependent_id: 'pd-1', blocker_id: 'pd-2', revision: 2, outcome: 'added' } });
  assert.deepEqual(await run(add), original);
  await run({ ...add, op: 'dependency_remove', expected_revision: 2, request_id: request() });
  assert.deepEqual(await run(add), original);
  assert.deepEqual(await run({ op: 'dependency_list', dependent_id: 'pd-1' }), { dependent_id: 'pd-1', revision: 3, blockers: [], next_cursor: null });
  await assert.rejects(run({ ...add, request_id: request() }), { code: 'dependency_conflict' });
  await assert.rejects(run(add, 'other'), { code: 'dependency_request_conflict' });
});
test('cycle rejection rolls back receipt and aggregate revision', async t => {
  const run = fixture(t); await issues(run);
  await run({ op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 1, request_id: request() });
  await assert.rejects(run({ op: 'dependency_add', dependent_id: 'pd-2', blocker_id: 'pd-1', expected_revision: 1, request_id: request() }), { code: 'dependency_cycle' });
  assert.deepEqual(await run({ op: 'dependency_list', dependent_id: 'pd-2' }), { dependent_id: 'pd-2', revision: 1, blockers: [], next_cursor: null });
});
test('blocked generic update changes no fields; force records reason', async t => {
  const run = fixture(t); await issues(run);
  await run({ op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 1, request_id: request() });
  const changes = [{ field: 'body', value: 'changed', expected: 1 }, { field: 'status', value: 'closed', expected: 1 }];
  await assert.rejects(run({ op: 'update', id: 'pd-1', changes }), { code: 'dependency_blocked' });
  const before = await run({ op: 'show', id: 'pd-1' });
  assert.ok('issue' in before); assert.equal(before.issue.body, 'Issue 0');
  await run({ op: 'update', id: 'pd-1', changes, force: true, reason: 'Accepted prerequisite exception' });
  const after = await run({ op: 'show', id: 'pd-1' });
  assert.ok('comments' in after); assert.equal(after.comments[0]?.body, 'Accepted prerequisite exception');
});

test('fresh no-ops consume one revision, while stale no-ops and changed receipts conflict', async t => {
  const run = fixture(t); await issues(run);
  const input = { op: 'dependency_remove', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 1, request_id: request() };
  assert.deepEqual(await run(input), { dependency: { dependent_id: 'pd-1', blocker_id: 'pd-2', revision: 2, outcome: 'already_absent' } });
  await assert.rejects(run({ ...input, request_id: request() }), error => {
    assert.ok(error instanceof Error && 'details' in error); assert.deepEqual(error.details, { expected_revision: 1, current: { dependent_id: 'pd-1', revision: 2, blockers: [], next_cursor: null } }); return true;
  });
  await assert.rejects(run({ ...input, expected_revision: Number.MAX_SAFE_INTEGER }), { code: 'dependency_request_conflict' });
  await assert.rejects(run({ ...input, blocker_id: 'pd-999' }), { code: 'dependency_request_conflict' });
  const add = { ...input, op: 'dependency_add', expected_revision: 2, request_id: request() };
  await run(add);
  assert.deepEqual(await run({ ...add, expected_revision: 3, request_id: request() }), { dependency: { dependent_id: 'pd-1', blocker_id: 'pd-2', revision: 4, outcome: 'already_present' } });
});
test('readiness covers each stored dependent and blocker status', async t => {
  for (const dependent of ['open', 'in_progress', 'deferred', 'closed']) for (const blocker of ['open', 'in_progress', 'deferred', 'closed']) {
    const run = fixture(t); await issues(run);
    for (const [id, status] of [['pd-1', dependent], ['pd-2', blocker]]) if (status !== 'open') await run({ op: 'update', id, changes: [{ field: 'status', value: status, expected: 1 }] });
    await run({ op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 1, request_id: request() });
    const ready = await run({ op: 'dependency_worklist', state: 'ready' }); const blocked = await run({ op: 'dependency_worklist', state: 'blocked' });
    assert.ok('issues' in ready && 'issues' in blocked);
    assert.equal(ready.issues.some(issue => issue.id === 'pd-1'), dependent === 'open' && blocker === 'closed', `${dependent}/${blocker} ready`);
    assert.equal(blocked.issues.some(issue => issue.id === 'pd-1'), dependent !== 'closed' && blocker !== 'closed', `${dependent}/${blocker} blocked`);
  }
});

test('dependency error markers require exact known provider messages through a bounded cause chain', async t => {
  const run = fixture(t);
  const operation = parseOperation({ op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 1, request_id: request() });
  for (const message of ['D1_ERROR: dependency_cycle_extra', 'unrelated: dependency_cycle', 'dependency_cycle: private SQL']) {
    const failure = new Error(message); const db = { ...run.db, batch: async () => { throw failure; } };
    await assert.rejects(executeOperation(db, operation, 'test'), error => error === failure);
  }
  const db = { ...run.db, batch: async () => { throw new Error('outer', { cause: new Error('dependency_cycle: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)') }); } };
  await assert.rejects(executeOperation(db, operation, 'test'), { code: 'dependency_cycle' });
});

test('force reason insertion failure rolls back every updated field and version', async t => {
  const run = fixture(t); await issues(run);
  await run.db.batch([{ sql: "CREATE TRIGGER reject_exception BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT,'exception_rejected'); END", params: [] }]);
  const input = { op: 'update', id: 'pd-1', changes: [{ field: 'body', value: 'changed', expected: 1 }, { field: 'status', value: 'closed', expected: 1 }], force: true, reason: 'Explicit exception' };
  const before = await run({ op: 'show', id: 'pd-1' }); await assert.rejects(run(input), /exception_rejected/); assert.deepEqual(await run({ op: 'show', id: 'pd-1' }), before);
  for (const override of [{ force: true }, { reason: 'alone' }, { force: false, reason: 'not forced' }]) assert.throws(() => parseOperation({ op: 'close', id: 'pd-1', expected: 1, ...override }), { code: 'invalid_input' });
  assert.throws(() => parseOperation({ ...input, changes: [{ field: 'body', value: 'changed', expected: 1 }] }), { code: 'invalid_input' });
  assert.throws(() => parseOperation({ ...input, reason: 'é'.repeat(32769) }), { code: 'invalid_input' });
  assert.doesNotThrow(() => parseOperation({ ...input, reason: 'é'.repeat(32768) }));
});

test('dependency pages use numeric ID order with independent epic containment', async t => {
  const run = fixture(t); await issues(run);
  await run.db.batch([{ sql: "UPDATE counters SET last_number = 98 WHERE scope = 'pd'", params: [] }]);
  for (const extra of [{ type: 'epic' }, { parent: 'pd-99' }, {}]) await run({ op: 'create', prefix: 'pd', request_id: request(), tool: 'test', project: 'other', body: 'Blocker', ...extra });
  let expected_revision = 1;
  for (const blocker_id of ['pd-100', 'pd-99.1', 'pd-99']) await run({ op: 'dependency_add', dependent_id: 'pd-1', blocker_id, expected_revision: expected_revision++, request_id: request() });
  const first = await run({ op: 'dependency_list', dependent_id: 'pd-1', limit: 1 }); assert.ok('blockers' in first); assert.deepEqual(first.blockers.map(row => row.id), ['pd-99']); assert.equal(first.next_cursor, 'pd-99');
  const second = await run({ op: 'dependency_list', dependent_id: 'pd-1', after: first.next_cursor, limit: 1 }); assert.ok('blockers' in second); assert.deepEqual(second.blockers.map(row => row.id), ['pd-99.1']);
  const third = await run({ op: 'dependency_list', dependent_id: 'pd-1', after: second.next_cursor, limit: 1 }); assert.ok('blockers' in third); assert.deepEqual(third.blockers.map(row => row.id), ['pd-100']); assert.equal(third.next_cursor, null);
});
test('stale mutation conflict retains the bounded graph observed in its skipped batch', async t => {
  const run = fixture(t); await issues(run);
  await run({ op: 'dependency_add', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 1, request_id: request() });
  const operation = parseOperation({ op: 'dependency_remove', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 1, request_id: request() });
  const db = { ...run.db, async batch(statements: Parameters<typeof run.db.batch>[0]) {
    const observed = await run.db.batch(statements);
    await run({ op: 'dependency_remove', dependent_id: 'pd-1', blocker_id: 'pd-2', expected_revision: 2, request_id: request() });
    return observed;
  } };
  await assert.rejects(executeOperation(db, operation, 'tester'), error => {
    assert.ok(error instanceof Error && 'details' in error);
    assert.deepEqual(error.details, { expected_revision: 1, current: { dependent_id: 'pd-1', revision: 2, blockers: [{ id: 'pd-2', project: 'test', status: 'open' }], next_cursor: null } }); return true;
  });
  const current = await run({ op: 'dependency_list', dependent_id: 'pd-1' }); assert.ok('revision' in current); assert.equal(current.revision, 3);
});
