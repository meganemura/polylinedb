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
  return async (input: unknown, actor = 'tester') => executeOperation(store.db, parseOperation(input), actor);
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
