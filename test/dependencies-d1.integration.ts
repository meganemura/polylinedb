// Exercises the product graph protocol through local workerd D1 and the shared domain executor.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { SCHEMA_STATEMENTS } from '../src/records/persistence.ts';
const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: { name: 'dependencies-test', compatibilityDate: '2026-09-25', manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ready"); } }' } } }, env: { DB: { type: 'd1', name: 'dependencies-test' } } } }] });
try {
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  const db = d1Executor(database); const run = (value: unknown, actor = 'test:d1') => executeOperation(db, parseOperation(value), actor);
  for (let i = 0; i < 6; i++) await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), project: i % 2 ? 'other' : 'test', tool: 'test', body: `Issue ${i}` });
  const add = (dependent_id: string, blocker_id: string, expected_revision = 1) => ({ op: 'dependency_add', dependent_id, blocker_id, expected_revision, request_id: crypto.randomUUID() });
  const opposite = await Promise.allSettled([run(add('pd-1','pd-2')), run(add('pd-2','pd-1'))]);
  assert.equal(opposite.filter(result => result.status === 'fulfilled').length, 1);
  const loser = opposite.find(result => result.status === 'rejected'); assert.ok(loser?.status === 'rejected'); assert.equal(loser.reason.code, 'dependency_cycle');
  const edges = (await database.prepare('SELECT * FROM dependencies').all()).results; assert.equal(edges.length, 1);
  assert.equal((await database.prepare('SELECT * FROM dependency_requests').all()).results.length, 1);
  const revisions = (await database.prepare('SELECT revision FROM dependency_revisions WHERE dependent_id IN (?,?) ORDER BY revision').bind('pd-1','pd-2').all()).results; assert.deepEqual(revisions, [{ revision: 1 }, { revision: 2 }]);
  const repeated = add('pd-3','pd-4'); const receipts = await Promise.all([run(repeated),run(repeated),run(repeated)]); assert.deepEqual(receipts[0], receipts[1]); assert.deepEqual(receipts[1], receipts[2]);
  await run({ ...repeated, op: 'dependency_remove', expected_revision: 2, request_id: crypto.randomUUID() }); assert.deepEqual(await run(repeated), receipts[0]);
  const current = await run({ op: 'dependency_list', dependent_id: 'pd-3' }); assert.ok('blockers' in current); assert.deepEqual(current.blockers, []); assert.equal(current.revision, 3);
  await assert.rejects(run(repeated, 'other'), { code: 'dependency_request_conflict' });
  await assert.rejects(run({ ...repeated, blocker_id: 'pd-999', expected_revision: Number.MAX_SAFE_INTEGER }), { code: 'dependency_request_conflict' });
  await assert.rejects(run({ ...repeated, request_id: crypto.randomUUID() }), { code: 'dependency_conflict' });
  const same = await Promise.allSettled([run(add('pd-5','pd-4')),run(add('pd-5','pd-6'))]); assert.equal(same.filter(result => result.status === 'fulfilled').length, 1);
  const conflict = same.find(result => result.status === 'rejected'); assert.ok(conflict?.status === 'rejected'); assert.equal(conflict.reason.code, 'dependency_conflict');
  await assert.rejects(run({ op: 'update', id: 'pd-5', changes: [{ field: 'status', value: 'closed', expected: 1 }, { field: 'body', value: 'changed', expected: 1 }] }), { code: 'dependency_blocked' });
  const before = await run({ op: 'show', id: 'pd-5' }); assert.ok('issue' in before); assert.equal(before.issue.body, 'Issue 4');
  await run({ op: 'close', id: 'pd-5', expected: 1, force: true, reason: 'Accepted prerequisite exception' });
  await assert.rejects(run({ op: 'close', id: 'pd-5', expected: 1, force: true, reason: 'Stale exception' }), { code: 'conflict' });
  const after = await run({ op: 'show', id: 'pd-5' }); assert.ok('comments' in after); assert.equal(after.comments.length, 1); assert.equal(after.comments[0]?.created_by, 'test:d1');
  await assert.rejects(database.prepare('UPDATE dependencies SET blocker_id = ? WHERE dependent_id = ?').bind('pd-3',edges[0].dependent_id).run(), /dependency_identity_immutable/);
  process.stdout.write('PASS: product workerd D1 graph races, rollback, immutable receipts, stale no-ops, blocker status CAS and force comment attribution\n');
} finally { await runtime.dispose(); }
